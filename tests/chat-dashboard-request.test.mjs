import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatamoovSandbox, plain } from './helpers/datamoov-sandbox.mjs';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// A whole dashboard request as a model builds it when it follows the prompt and the tool schema
// word for word: two accounts, the previous period, a campaign matrix with flags, keyword waste
// and weak assets as top-100 action lists from the source's ranked reports, and the prompt's
// own polarity lists. The prompt's guidance only helps if a plan that follows it saves, runs and
// states its findings.
const REQUEST =
  'Build a Google Ads dashboard for both accounts, last 30 days: scorecards against the previous period, a campaign matrix flagging CPA above 1.5x in red and the top converters in green, keyword waste, assets with a weak CTR flagged and insights.';

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
// Shared names of the ranked report columns; the others keep their last part (clicks, field_type).
const KEYS = {
  'ad_group_criterion.keyword.text': 'keyword',
  'campaign.name': 'campaign_name',
  'metrics.cost': 'spend',
  'asset.text_asset.text': 'asset_text',
};
const ASSETS = [
  field('ad_group_ad_asset_view.field_type', 'Asset type', 'text'),
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

// Account A bids on many more keywords than an action list keeps, all of them converting; the
// one wasting spend ranks high enough to stay in its top 300.
const keywordRows = (account) => [
  { 'ad_group_criterion.keyword.text': 'cheap flats', 'ad_group_criterion.keyword.match_type': 'BROAD', 'campaign.name': 'Generic', 'metrics.cost': account === 'A' ? 500 : 0, 'metrics.clicks': 50, 'metrics.conversions': 0 },
  { 'ad_group_criterion.keyword.text': 'furnished apartments', 'ad_group_criterion.keyword.match_type': 'EXACT', 'campaign.name': 'Generic', 'metrics.cost': 900, 'metrics.clicks': 80, 'metrics.conversions': 6 },
  ...Array.from({ length: account === 'A' ? 348 : 0 }, (_, i) => ({ 'ad_group_criterion.keyword.text': 'flat ' + (i + 1), 'ad_group_criterion.keyword.match_type': 'PHRASE', 'campaign.name': 'Generic', 'metrics.cost': 400 - i, 'metrics.clicks': 5, 'metrics.conversions': 1 })),
];
const assetRows = () => [
  { 'ad_group_ad_asset_view.field_type': 'HEADLINE', 'asset.text_asset.text': 'Kitchens', 'metrics.impressions': 100, 'metrics.clicks': 2, 'metrics.conversions': 0 },
  { 'ad_group_ad_asset_view.field_type': 'HEADLINE', 'asset.text_asset.text': 'Stay a month', 'metrics.impressions': 900, 'metrics.clicks': 40, 'metrics.conversions': 3 },
];

// A ranked report as a connector declares it: its rows by spend (by impressions without a spend
// column) down to the top the query keeps, and labelled only when that cut the list.
function rankedReport(f, id, label, columns, rowsOf) {
  return {
    id,
    label,
    fields: columns,
    dateRange: true,
    configFields: [{ key: 'top', label: 'Keep the top rows', type: 'number' }],
    fetch(ctx) {
      f.tops.push(ctx.config.top);
      const rank = columns.find((column) => column.key === 'metrics.cost' && ctx.fields.includes(column.key)) || columns.find((column) => column.key === 'metrics.impressions');
      const rows = rowsOf(ctx.credentials.account)
        .sort((a, b) => b[rank.key] - a[rank.key])
        .slice(0, ctx.config.top || ctx.maxRows);
      const metadata = { complete: true, currency: 'AED' };
      if (ctx.config.top && rows.length === ctx.config.top) Object.assign(metadata, { topRows: ctx.config.top, note: 'Top ' + ctx.config.top + ' by ' + rank.label.toLowerCase() });
      return { columns, rows, metadata };
    },
  };
}

function fixture() {
  const f = createDatamoovSandbox();
  f.tops = [];
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
      rankedReport(f, 'keyword', 'Keyword performance', KEYWORDS, keywordRows),
      rankedReport(f, 'ad_asset', 'Ad assets', ASSETS, assetRows),
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
  // Item lists are action lists: the source's report for the subject, its top 300, no date field.
  const ranked = (id, label, connectionId, reportType, columns) => ({
    id, label, sheetName: label + ' Data', connectionId, reportType, dateRange: { preset: 'last30' },
    fields: columns.map((column) => column.key),
    config: { top: 300 },
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
      ranked('k1', 'Google Ads A keywords', a, 'keyword', KEYWORDS),
      ranked('k2', 'Google Ads B keywords', b, 'keyword', KEYWORDS),
      ranked('a1', 'Google Ads A assets', a, 'ad_asset', ASSETS),
      ranked('a2', 'Google Ads B assets', b, 'ad_asset', ASSETS),
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
        groupBy: ['source', 'field_type', 'asset_text'],
        metrics: sum('impressions', 'clicks'),
        // Google no longer rates Search and Display assets, so a weak one is read from its CTR.
        ratios: [{ key: 'ctr', label: 'CTR', numerator: 'clicks', denominator: 'impressions', percent: true }],
        orderBy: { field: 'impressions__sum', direction: 'desc' },
        limit: 25,
        highlight: [{ field: 'ctr', op: 'lt', ofTotal: 0.5, color: 'red' }],
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
      assert.match(system, /the source's report for the subject with config top \(300 unless asked, at most 1,000\)/);
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
  // A tool that failed answers with its error; name it rather than a missing field further down.
  for (const id of ['save', 'run']) assert.equal(results.get(id).value.error, undefined, id + ': ' + results.get(id).value.error);
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
  // weak asset, each followed by its account only where that tells rows apart.
  const said = (start) => run.highlights.find((text) => text.startsWith(start)) || '';
  assert.equal(
    said('Campaign matrix: 5 of 6 rows have Conversions'),
    'Campaign matrix: 5 of 6 rows have Conversions at or above 0.1× the overall 258 (green rows) — Brand, Lon Search, Generic and 2 more.'
  );
  assert.equal(said('Campaign matrix: 1 of 6 rows has CPA'), 'Campaign matrix: 1 of 6 rows has CPA above 1.5× the overall AED 102.33 (red rows) — Display.');
  assert.match(said('Assets:'), /^Assets: 2 of 4 rows have CTR below 0\.5× the overall 4\.20% \(red rows\) — Headline · Kitchens · /);
  // The waste table reads account A's top 300 beside account B's whole list: its leader's share
  // is a share of those rows, not of every keyword.
  assert.equal(said('cheap flats'), 'cheap flats · Broad · Google Ads A keywords leads Keyword waste with AED 500.00 spend (100.0% of the top rows).');
  // Every item list asked its report for the top 300. Account A's 350 keywords stop at 300 and
  // the tile reading them says so; lists shorter than their top are whole and carry no label.
  assert.deepEqual(f.tops, [300, 300, 300, 300]);
  const rows = Object.fromEntries(run.datasets.map((dataset) => [dataset.id, dataset.rowCount]));
  assert.deepEqual([rows.k1, rows.k2, rows.a1, rows.a2], [300, 2, 2, 2]);
  const tileNote = (title) => run.tiles.find((tile) => tile.title === title).note || '';
  assert.match(tileNote('Keyword waste: spend without conversions'), /top 300 by spend/);
  assert.doesNotMatch(tileNote('Assets'), /top/i);
});

// A setting put on a report that does not declare it would be dropped by the report runtime, so
// the same query would run again and fail again (a top on a custom query, after a row-limit
// error). Every chat path that takes a query refuses it instead, naming the report's own keys.
test('a config key the chosen report does not declare is refused on every chat query path, before anything runs', () => {
  const f = fixture();
  const session = f.api.dmvChatSession_(f.book);
  const tools = f.api.dmvChatTools_(session);
  const call = (name, input) => {
    const reply = f.api.dmvChatRunTool_(session, tools, { name, input });
    return { isError: reply.isError, value: JSON.parse(reply.content) };
  };
  const [a] = f.connections.map((connection) => connection.id);
  const refused = /^Daily campaign performance has no config top; it takes no config\. Use a report that declares the setting, or do it in the query where its description says how\.$/;
  const query = { connectionId: a, reportType: 'campaign_daily', fields: ['campaign.name', 'metrics.cost'], config: { top: 100 }, dateRange: { preset: 'last30' } };
  for (const name of ['run_report', 'discover_fields']) {
    const reply = call(name, query);
    assert.equal(reply.isError, true, name);
    assert.match(reply.value.error, refused, name);
  }
  const report = call('save_report', { ...query, name: 'Campaigns', target: { sheetName: 'Campaigns' } });
  assert.match(report.value.error, refused);
  const plan = promptPlan(f);
  plan.datasets[0].config = { top: 100 };
  const dashboard = call('save_dashboard', plan);
  assert.match(dashboard.value.error, refused);
  assert.equal(f.api.dmvListDashboards().length, 0, 'nothing was saved');
  assert.equal(f.api.dmvListReports().length, 0, 'nothing was saved');
  assert.deepEqual(f.tops, [], 'nothing was fetched');
  // The report's own keys are named; a blank value, as a form sends it, is no setting at all.
  const keyword = call('run_report', { connectionId: a, reportType: 'keyword', config: { top: 5, region: 'EU' } });
  assert.match(keyword.value.error, /^Keyword performance has no config region; its config keys are top\. /);
  const blank = call('run_report', { ...query, config: { top: '' } });
  assert.equal(blank.isError, false, JSON.stringify(blank.value));
  assert.equal(call('run_report', { connectionId: a, reportType: 'keyword', config: { top: 5 } }).isError, false);
  assert.deepEqual(f.tops, [5]);
});

// The tool schemas and the catalog are sent on every round of the tool loop: a setting many
// reports share is described once, only for reports the chat can run on the selected sources,
// and a second account of a source points at the first instead of listing every field again.
test('config keys and the catalog cover only the selected sources and say each thing once', () => {
  const f = fixture();
  const field = (key, label, type, role) => ({ key, label, type, role, default: true });
  f.api.dmvRegisterConnector_({
    id: 'shop',
    label: 'Shop',
    category: 'Test',
    allowedHosts: [],
    authFields: [{ key: 'account', label: 'Store', type: 'text', required: true }],
    reports: [
      { id: 'orders', label: 'Orders', chat: false, dateRange: true, fields: [field('order', 'Order', 'text', 'dimension')], configFields: [{ key: 'hidden', label: 'Hidden', type: 'text' }], fetch() {} },
      { id: 'lines', label: 'Order lines', dateRange: true, fields: [field('sku', 'SKU', 'text', 'dimension')], configFields: [{ key: 'top', label: 'Keep the top rows', type: 'number' }], fetch() {} },
    ],
  });
  f.api.dmvRegisterConnector_({
    id: 'unused',
    label: 'Unused',
    category: 'Test',
    allowedHosts: [],
    authFields: [],
    reports: [{ id: 'all', label: 'All', dateRange: false, fields: [], configFields: [{ key: 'region', label: 'Region', type: 'text', help: 'x'.repeat(400) }], fetch() {} }],
  });
  const shop = f.api.dmvSaveConnection({ connectorId: 'shop', label: 'Shop main', credentials: { account: 'one' } });
  const [a, b] = f.connections.map((connection) => connection.id);
  const config = (ids) => plain(f.api.dmvChatTools_(f.api.dmvChatSession_(f.book, ids))[0].input_schema.properties.config.properties);
  assert.deepEqual(config([a, b, shop.id]), {
    top: { type: 'number', description: 'Google Ads · Keyword performance, Ad assets; Shop · Order lines: Keep the top rows' },
  });
  assert.deepEqual(config([shop.id]), { top: { type: 'number', description: 'Shop · Order lines: Keep the top rows' } });
  assert.deepEqual(config([]), {});
  // A second account adds its own line, not another copy of its source's reports and fields;
  // the tools do not grow at all.
  const sizes = (ids) => {
    const session = f.api.dmvChatSession_(f.book, ids);
    return { catalog: f.api.dmvChatCatalogText_(session), tools: JSON.stringify(plain(f.api.dmvChatTools_(session).map((item) => item.input_schema))).length };
  };
  const one = sizes([a]), two = sizes([a, b]);
  assert.equal(two.tools, one.tools);
  assert.ok(two.catalog.length - one.catalog.length < 200, two.catalog);
  assert.ok(
    two.catalog.endsWith(`\n- connectionId "${b}": Google Ads B (Google Ads; account=B)\n  - The same reportTypes, config and fields as connectionId "${a}".`),
    two.catalog
  );
  assert.equal(two.catalog.match(/reportType "keyword"/g).length, 1);
  assert.doesNotMatch(sizes([a, shop.id]).catalog, /reportType "orders"/);
});

// The real ranked sources share Keep the top rows' wording: with every one selected, each
// wording is described once and names the sources and reports that offer it.
test('Keep the top rows is described once per wording across the real ranked sources', () => {
  const f = createDatamoovSandbox();
  const ids = ['google_ads', 'microsoft_ads', 'facebook_ads', 'linkedin_ads', 'bigquery', 'postgres', 'snowflake'];
  // Connectors register into the sandbox from their own context, with the shared files they use.
  const context = vm.createContext({});
  for (const file of ['dmv_core.js', 'dmv_connector_helpers.js', 'dmv_sql.js', ...ids.map((id) => 'connectors/' + id + '.js')]) {
    if (file.startsWith('connectors/')) context.dmvRegisterConnector_ = (definition) => f.api.dmvRegisterConnector_(definition);
    new vm.Script(readFileSync(new URL('../src/' + file, import.meta.url), 'utf8'), { filename: file }).runInContext(context);
  }
  const catalog = {};
  f.api.dmvCatalog_().forEach((connector) => (catalog[connector.id] = connector));
  const config = plain(f.api.dmvChatConfigSchema_({ connections: ids.map((connectorId) => ({ connectorId })), catalog })).properties;
  const segments = config.top.description.split(' | ');
  assert.equal(segments.length, 2, config.top.description);
  assert.match(segments[0], /^Google Ads · [^;]+; Microsoft Ads \(Bing\) · [^;]+; Facebook Ads · [^;]+; LinkedIn Ads · [^;]+: Keep the top rows\. Ranks rows by spend /);
  assert.match(segments[1], /^BigQuery · SQL query; PostgreSQL · SQL report; Snowflake · SQL report: Keep the top rows\. Ranks rows by Rank by column/);
  assert.equal(config.top.description.match(/Blank keeps every row up to the row limit/g).length, 2);
  assert.equal(config.rankBy.description, "BigQuery · SQL query; PostgreSQL · SQL report; Snowflake · SQL report: Rank by column. A column of the query's result; the top rows have its highest values.");
});
