import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatamoovSandbox, plain } from './helpers/datamoov-sandbox.mjs';

// A whole dashboard request as a model builds it when it follows the prompt and the tool schema
// word for word: two accounts, the previous period, a campaign matrix with flags, keyword waste
// and low-rated assets from the custom query report, and the prompt's own polarity lists. The
// prompt's guidance only helps if a plan that follows it saves, runs and states its findings.
const REQUEST =
  'Build a Google Ads dashboard for both accounts, last 30 days: scorecards against the previous period, a campaign matrix flagging CPA above 1.5x in red and the top converters in green, keyword waste, assets flagged LOW and insights.';

const field = (key, label, type) => ({ key, label, type, role: key.startsWith('metrics.') ? 'metric' : 'dimension' });
const CAMPAIGN = [
  field('segments.date', 'Date', 'date'),
  field('campaign.name', 'Campaign', 'text'),
  field('metrics.cost', 'Spend', 'currency'),
  field('metrics.clicks', 'Clicks', 'number'),
  field('metrics.impressions', 'Impressions', 'number'),
  field('metrics.conversions', 'Conversions', 'number'),
  field('metrics.conversions_value', 'Conversion value', 'currency'),
];
const KEYWORDS = [
  field('ad_group_criterion.keyword.text', 'Keyword', 'text'),
  field('ad_group_criterion.keyword.match_type', 'Match type', 'text'),
  field('campaign.name', 'Campaign', 'text'),
  field('metrics.cost', 'Spend', 'currency'),
  field('metrics.clicks', 'Clicks', 'number'),
  field('metrics.conversions', 'Conversions', 'number'),
];
// Shared names of the custom query columns; the others keep their last part (clicks, field_type).
const KEYS = {
  'ad_group_criterion.keyword.text': 'keyword',
  'campaign.name': 'campaign_name',
  'metrics.cost': 'spend',
  'asset.text_asset.text': 'asset_text',
};
const ASSETS = [
  field('ad_group_ad_asset_view.field_type', 'Asset field', 'text'),
  field('ad_group_ad_asset_view.performance_label', 'Performance label', 'text'),
  field('asset.text_asset.text', 'Asset text', 'text'),
  field('metrics.impressions', 'Impressions', 'number'),
  field('metrics.clicks', 'Clicks', 'number'),
  field('metrics.conversions', 'Conversions', 'number'),
];

// Every campaign spends the same each day; the previous period spent a little less.
function campaignRows(account, start, end) {
  const rows = [];
  const names = account === 'A' ? ['Brand', 'Generic', 'PMax', 'Display'] : ['Lon Search', 'Par Search'];
  for (let t = Date.parse(start + 'T12:00:00Z'); t <= Date.parse(end + 'T12:00:00Z'); t += 86400000)
    names.forEach((name, i) =>
      rows.push({
        'segments.date': new Date(t).toISOString().slice(0, 10),
        'campaign.name': name,
        'metrics.cost': 100 + i * 40 - (start < '2026-08-15' ? 10 : 0),
        'metrics.clicks': 10 + i,
        'metrics.impressions': 300 + i * 10,
        'metrics.conversions': i === 3 ? 0.2 : 2 - i * 0.4,
        'metrics.conversions_value': 400,
      })
    );
  return rows;
}

function fixture() {
  const f = createDatamoovSandbox();
  f.api.dmvRegisterConnector_({
    id: 'gads',
    label: 'Google Ads',
    category: 'Test',
    allowedHosts: [],
    authFields: [
      { key: 'account', label: 'Customer ID', type: 'text', required: true },
      { key: 'token', label: 'Token', type: 'password', required: true },
    ],
    reports: [
      {
        id: 'campaign_daily',
        label: 'Daily campaign performance',
        fields: CAMPAIGN,
        dateRange: true,
        configFields: [],
        fetch(ctx) {
          const columns = CAMPAIGN.filter((column) => ctx.fields.includes(column.key));
          let rows = campaignRows(ctx.credentials.account, ctx.startDate, ctx.endDate);
          // The lean previous-period dataset asks for totals only.
          if (!ctx.fields.includes('segments.date')) {
            const total = {};
            for (const row of rows) for (const column of columns) total[column.key] = (total[column.key] || 0) + row[column.key];
            rows = [total];
          }
          return { columns, rows, metadata: { complete: true, currency: 'AED' } };
        },
      },
      {
        id: 'custom_query',
        label: 'Custom query (GAQL)',
        fields: [],
        dateRange: true,
        configFields: [{ key: 'gaql', label: 'GAQL query', type: 'textarea', required: true }],
        fetch(ctx) {
          const keywords = /FROM keyword_view/.test(ctx.config.gaql);
          const rows = keywords
            ? [
                { 'ad_group_criterion.keyword.text': 'cheap flats', 'ad_group_criterion.keyword.match_type': 'BROAD', 'campaign.name': 'Generic', 'metrics.cost': ctx.credentials.account === 'A' ? 500 : 0, 'metrics.clicks': 50, 'metrics.conversions': 0 },
                { 'ad_group_criterion.keyword.text': 'furnished apartments', 'ad_group_criterion.keyword.match_type': 'EXACT', 'campaign.name': 'Generic', 'metrics.cost': 900, 'metrics.clicks': 80, 'metrics.conversions': 6 },
              ]
            : [
                { 'ad_group_ad_asset_view.field_type': 'HEADLINE', 'ad_group_ad_asset_view.performance_label': 'LOW', 'asset.text_asset.text': 'Kitchens', 'metrics.impressions': 100, 'metrics.clicks': 2, 'metrics.conversions': 0 },
                { 'ad_group_ad_asset_view.field_type': 'HEADLINE', 'ad_group_ad_asset_view.performance_label': 'BEST', 'asset.text_asset.text': 'Stay a month', 'metrics.impressions': 900, 'metrics.clicks': 40, 'metrics.conversions': 3 },
              ];
          return { columns: keywords ? KEYWORDS : ASSETS, rows, metadata: { complete: true, currency: 'AED' } };
        },
      },
    ],
  });
  f.connections = ['A', 'B'].map((account) =>
    f.api.dmvSaveConnection({ connectorId: 'gads', label: 'Google Ads ' + account, credentials: { account, token: 'source-token' } })
  );
  f.api.dmvSaveAiSettings({ provider: 'anthropic', apiKey: 'offline-request-ai-key', maxRows: 5000 });
  return f;
}

// The plan, built from the prompt's sentences: one lean previous-period dataset per account,
// one kpi tile comparing every current and previous dataset (without a datasets list), the
// flag examples, the source first in groupBy, and the polarity lists as the prompt writes them.
function promptPlan(f) {
  const [a, b] = f.connections.map((connection) => connection.id);
  const map = (pairs) => pairs.map(([from, key]) => ({ field: from, key }));
  const totals = [['metrics.cost', 'spend'], ['metrics.clicks', 'clicks'], ['metrics.impressions', 'impressions'], ['metrics.conversions', 'conversions'], ['metrics.conversions_value', 'conversion_value']];
  const campaigns = (id, label, connectionId) => ({ id, label, sheetName: label + ' Data', connectionId, reportType: 'campaign_daily', fields: CAMPAIGN.map((column) => column.key), dateRange: { preset: 'last30' }, mapping: map([['segments.date', 'date'], ['campaign.name', 'campaign_name'], ...totals]) });
  const previous = (id, label, connectionId) => ({ id, label, sheetName: label + ' Data', connectionId, reportType: 'campaign_daily', fields: totals.map(([from]) => from), dateRange: { preset: 'previous30' }, mapping: map(totals) });
  const query = (id, label, connectionId, columns, from) => ({
    id, label, sheetName: label + ' Data', connectionId, reportType: 'custom_query', dateRange: { preset: 'last30' },
    config: { gaql: 'SELECT ' + columns.map((column) => column.key).join(', ') + ' FROM ' + from },
    mapping: columns.map((column) => ({ field: column.key, key: KEYS[column.key] || column.key.split('.').pop() })),
  });
  const sum = (...names) => names.map((name) => ({ field: name, agg: 'sum' }));
  const cpa = { key: 'cpa', label: 'CPA', numerator: 'spend', denominator: 'conversions' };
  return {
    name: 'Google Ads Performance',
    target: { sheetName: 'Google Ads Dashboard' },
    datasets: [
      campaigns('g1', 'Google Ads A campaigns', a),
      campaigns('g2', 'Google Ads B campaigns', b),
      previous('g1_prev', 'Google Ads A previous 30 days', a),
      previous('g2_prev', 'Google Ads B previous 30 days', b),
      query('k1', 'Google Ads A keywords', a, KEYWORDS, 'keyword_view'),
      query('k2', 'Google Ads B keywords', b, KEYWORDS, 'keyword_view'),
      query('a1', 'Google Ads A assets', a, ASSETS, 'ad_group_ad_asset_view'),
      query('a2', 'Google Ads B assets', b, ASSETS, 'ad_group_ad_asset_view'),
    ],
    tiles: [
      {
        title: 'Headline',
        type: 'kpi',
        metrics: sum('spend', 'conversions'),
        ratios: [cpa, { key: 'ctr', label: 'CTR', numerator: 'clicks', denominator: 'impressions', percent: true }],
        compare: { current: ['g1', 'g2'], previous: ['g1_prev', 'g2_prev'] },
      },
      { title: 'Daily spend by account', type: 'line', datasets: ['g1', 'g2'], groupBy: ['date', 'source'], metrics: sum('spend') },
      {
        title: 'Campaign matrix',
        type: 'table',
        datasets: ['g1', 'g2'],
        groupBy: ['source', 'campaign_name'],
        metrics: sum('spend', 'conversions'),
        ratios: [cpa],
        orderBy: { field: 'spend__sum', direction: 'desc' },
        limit: 25,
        highlight: [
          { field: 'cpa', op: 'gt', ofTotal: 1.5, color: 'red' },
          { field: 'conversions', op: 'gte', ofTotal: 0.1, color: 'green' },
        ],
      },
      {
        title: 'Keyword waste: spend without conversions',
        type: 'table',
        datasets: ['k1', 'k2'],
        groupBy: ['source', 'keyword', 'match_type'],
        metrics: sum('spend', 'clicks'),
        filters: [{ field: 'conversions', op: 'eq', value: 0 }],
        orderBy: { field: 'spend__sum', direction: 'desc' },
        limit: 25,
      },
      {
        title: 'Assets',
        type: 'table',
        datasets: ['a1', 'a2'],
        groupBy: ['source', 'field_type', 'performance_label', 'asset_text'],
        metrics: sum('impressions', 'clicks'),
        orderBy: { field: 'impressions__sum', direction: 'desc' },
        limit: 25,
        highlight: [{ field: 'performance_label', op: 'eq', value: 'LOW', color: 'red' }],
      },
    ],
    lowerIsBetter: ['cpa', 'cpc', 'cpm', 'cost per conversion'],
    neutral: ['spend', 'cost', 'budget'],
  };
}

const tool = (id, name, input) => ({ type: 'tool_use', id, name, input });

function scriptedTurn(f, stages) {
  const fetch = f.api.UrlFetchApp.fetch;
  const results = new Map();
  let index = 0;
  f.api.UrlFetchApp.fetch = (url, options) => {
    const request = JSON.parse(options.payload);
    for (const message of request.messages)
      for (const block of Array.isArray(message.content) ? message.content : [])
        if (block.type === 'tool_result') results.set(block.tool_use_id, { ...block, value: JSON.parse(block.content) });
    assert.ok(index < stages.length, 'the chat must finish within the scripted plan');
    const content = stages[index++](results, request);
    f.state.responses.push({ body: { content, stop_reason: content.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn' } });
    return fetch(url, options);
  };
  try {
    plain(f.api.dmvChat({ text: REQUEST, transcript: [] }));
    assert.equal(index, stages.length);
    return results;
  } finally {
    f.api.UrlFetchApp.fetch = fetch;
  }
}

test('a dashboard planned word for word from the prompt saves, runs and names keywords, assets and top converters', () => {
  const f = fixture();
  const plan = promptPlan(f);
  const results = scriptedTurn(f, [
    (_results, request) => {
      // The few sentences this plan follows, as anchors.
      const system = [].concat(request.system).map((block) => (typeof block === 'string' ? block : block.text)).join('\n');
      assert.match(system, /top converters are \{field: "conversions", op: "gte", ofTotal: 0\.1, color: "green"\}/);
      assert.match(system, /Set lowerIsBetter to the cost-per and cost-rate keys the tiles use \(cpa, cpc, cpm, cost per conversion\) and neutral to their spend, cost and budget/);
      assert.match(system, /a compared tile without datasets reads its compare lists/);
      return [tool('save', 'save_dashboard', plan)];
    },
    (results) => {
      assert.notEqual(results.get('save').is_error, true, JSON.stringify(results.get('save').value));
      return [tool('run', 'run_dashboard', { id: results.get('save').value.id })];
    },
    (results) => {
      assert.notEqual(results.get('run').is_error, true, JSON.stringify(results.get('run').value));
      return [{ type: 'text', text: 'Done.' }];
    },
  ]);
  const saved = plain(f.api.dmvUnpack_(f.api.dmvDashboardHere_(results.get('save').value.id).plan));
  // The kpi tile reads its compare lists; the generic polarity names this plan lacks are dropped.
  assert.deepEqual(saved.tiles[0].datasets, ['g1', 'g2', 'g1_prev', 'g2_prev']);
  assert.deepEqual([saved.lowerIsBetter, saved.neutral], [['cpa'], ['spend']]);
  const run = results.get('run').value;
  // One period beside the other, never both added up.
  assert.deepEqual(run.scorecards.slice(0, 2).map((card) => [card.label, card.value, card.previous]), [
    ['Spend (AED)', 26400, 24600],
    ['Conversions', 258, 258],
  ]);
  // Findings name the items, not the accounts: the top converters, the wasted keyword and the
  // low-rated asset, each followed by its account only where that tells rows apart.
  const said = (start) => run.highlights.find((text) => text.startsWith(start)) || '';
  assert.equal(
    said('Campaign matrix: 5 of 6 rows have Conversions'),
    'Campaign matrix: 5 of 6 rows have Conversions at or above 0.1× the overall 258 (green rows) — Brand, Lon Search, Generic and 2 more.'
  );
  assert.equal(said('Campaign matrix: 1 of 6 rows has CPA'), 'Campaign matrix: 1 of 6 rows has CPA above 1.5× the overall AED 102.33 (red rows) — Display.');
  assert.match(said('Assets:'), /^Assets: 2 of 4 rows have Performance label Low \(red rows\) — Headline · Kitchens · /);
  assert.equal(said('cheap flats'), 'cheap flats · Broad · Google Ads A keywords leads Keyword waste with AED 500.00 spend (100.0% of the total).');
});
