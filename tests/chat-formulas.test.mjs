import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatamoovSandbox, plain } from './helpers/datamoov-sandbox.mjs';

// "Profit by week across Google Ads and Meta minus Shopify costs", answered the way the prompt
// asks: fetch each source, combine them under shared keys, then let summarize formulas do the
// maths per week. Shopify data sits in a warehouse, so its query selects the shared columns
// itself (combine appends rows and never joins columns of differing names).
const REQUEST = 'Profit by week across Google Ads and Meta minus Shopify costs, last two weeks.';
const DATES = { preset: 'custom', startDate: '2026-08-31', endDate: '2026-09-13' };
const SHOP_SQL =
  'SELECT day AS date, cogs + fees AS costs, NULL AS revenue FROM shopify.daily_costs';

const days = () =>
  Array.from({ length: 14 }, (_, i) =>
    new Date(Date.parse('2026-08-31T12:00:00Z') + i * 86400000).toISOString().slice(0, 10)
  );

// Every ad day spends and returns the same; Shopify costs rise in the second week.
function fixture({ metaCurrency = 'USD' } = {}) {
  const f = createDatamoovSandbox();
  f.queries = [];
  const ads = (id, label, spend, value, currency) => ({
    id,
    label,
    category: 'Test',
    allowedHosts: [],
    authFields: [{ key: 'token', label: 'Token', type: 'password', required: true }],
    reports: [
      {
        id: 'daily',
        label: 'Daily performance',
        dateRange: true,
        configFields: [],
        fields: [
          { key: 'date', label: 'Date', type: 'date', role: 'dimension' },
          { key: 'spend', label: 'Spend', type: 'currency', role: 'metric' },
          { key: 'conversion_value', label: 'Conversion value', type: 'currency', role: 'metric' },
        ],
        fetch(ctx) {
          const rows = days()
            .filter((date) => date >= ctx.startDate && date <= ctx.endDate)
            .map((date) => ({ date, spend, conversion_value: value }));
          return { columns: this.fields, rows, metadata: { complete: true, currency } };
        },
      },
    ],
  });
  f.api.dmvRegisterConnector_(ads('gads', 'Google Ads', 120, 400, 'USD'));
  f.api.dmvRegisterConnector_(ads('meta', 'Meta Ads', 50, 150, metaCurrency));
  f.api.dmvRegisterConnector_({
    id: 'warehouse',
    label: 'Warehouse',
    category: 'Test',
    allowedHosts: [],
    authFields: [{ key: 'token', label: 'Token', type: 'password', required: true }],
    reports: [
      {
        id: 'sql',
        label: 'SQL query',
        dateRange: false,
        configFields: [{ key: 'query', label: 'SQL', type: 'text', required: true }],
        fields: [
          { key: 'date', label: 'date', type: 'date', role: 'dimension' },
          { key: 'costs', label: 'costs', type: 'currency', role: 'metric' },
          { key: 'revenue', label: 'revenue', type: 'currency', role: 'metric' },
        ],
        fetch(ctx) {
          f.queries.push(ctx.config.query);
          const rows = days().map((date, i) => ({ date, costs: i < 7 ? 70 : 90, revenue: null }));
          return { columns: this.fields, rows, metadata: { complete: true, currency: 'USD' } };
        },
      },
    ],
  });
  const save = (connectorId, label) =>
    f.api.dmvSaveConnection({ connectorId, label, credentials: { token: 'source-token' } }).id;
  f.ids = {
    google: save('gads', 'Google Ads main'),
    meta: save('meta', 'Meta main'),
    shop: save('warehouse', 'Shopify warehouse'),
  };
  f.api.dmvSaveAiSettings({ provider: 'anthropic', apiKey: 'offline-formula-ai-key', maxRows: 5000 });
  return f;
}

const tool = (id, name, input) => ({ type: 'tool_use', id, name, input });

// The Anthropic adapter carries each round; every stage sees the tool results so far.
function scriptedTurn(f, stages, text = REQUEST) {
  const fetch = f.api.UrlFetchApp.fetch;
  const results = new Map();
  let index = 0;
  f.api.UrlFetchApp.fetch = (url, options) => {
    const request = JSON.parse(options.payload);
    for (const message of request.messages)
      for (const block of Array.isArray(message.content) ? message.content : [])
        if (block.type === 'tool_result')
          results.set(block.tool_use_id, { ...block, value: JSON.parse(block.content) });
    assert.ok(index < stages.length, 'the chat must finish within the scripted plan');
    const content = stages[index++](results, request);
    f.state.responses.push({
      body: {
        content,
        stop_reason: content.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn',
      },
    });
    return fetch(url, options);
  };
  try {
    const reply = plain(f.api.dmvChat({ text, transcript: [] }));
    assert.equal(index, stages.length);
    return { reply, results };
  } finally {
    f.api.UrlFetchApp.fetch = fetch;
  }
}

const fetchAll = (f) => [
  tool('google', 'run_report', { connectionId: f.ids.google, reportType: 'daily', fields: ['date', 'spend', 'conversion_value'], dateRange: DATES }),
  tool('meta', 'run_report', { connectionId: f.ids.meta, reportType: 'daily', fields: ['date', 'spend', 'conversion_value'], dateRange: DATES }),
  tool('shop', 'run_report', { connectionId: f.ids.shop, reportType: 'sql', fields: ['date', 'costs', 'revenue'], config: { query: SHOP_SQL } }),
];

// One shared shape for every source: date, cost (ad spend or Shopify costs) and revenue (the
// ad platforms' conversion value; Shopify's query leaves it blank).
const combineAll = (results) =>
  tool('combined', 'combine_results', {
    sources: [
      { resultId: results.get('google').value.resultId, label: 'Google Ads', columns: [{ from: 'date', to: 'date' }, { from: 'spend', to: 'cost' }, { from: 'conversion_value', to: 'revenue' }] },
      { resultId: results.get('meta').value.resultId, label: 'Meta', columns: [{ from: 'date', to: 'date' }, { from: 'spend', to: 'cost' }, { from: 'conversion_value', to: 'revenue' }] },
      { resultId: results.get('shop').value.resultId, label: 'Shopify', columns: [{ from: 'date', to: 'date' }, { from: 'costs', to: 'cost' }, { from: 'revenue', to: 'revenue' }] },
    ],
  });

const PROFIT = [
  { key: 'profit', label: 'Profit', expression: 'revenue - cost' },
  { key: 'margin', label: 'Margin', expression: 'profit / revenue', percent: true },
];

const systemText = (request) =>
  [].concat(request.system).map((block) => (typeof block === 'string' ? block : block.text)).join('\n');

test('profit by week across Google Ads and Meta minus Shopify costs: combine, then summarize formulas', () => {
  const f = fixture();
  const { reply, results } = scriptedTurn(f, [
    (_results, request) => {
      assert.match(
        systemText(request),
        /For maths over totals \(profit = revenue - spend, net ROAS = revenue \/ 1\.05 \/ spend, margin = \(revenue - cost\) \/ revenue\) use summarize formulas; they reference summable columns \(summed per group\), ratio keys and earlier formula keys; never compute numbers yourself\./
      );
      // Dashboard tiles get the same rule in their own words.
      assert.match(systemText(request), /Maths over totals \(profit = conversion_value - spend, net ROAS = conversion_value \/ 1\.05 \/ spend\) is tile formulas over summable columns, ratio keys and earlier formula keys; never compute numbers yourself\./);
      const summarize = request.tools.find((item) => item.name === 'summarize');
      assert.deepEqual(summarize.input_schema.properties.formulas.items.required, ['key', 'expression']);
      return fetchAll(f);
    },
    (results) => {
      for (const id of ['google', 'meta', 'shop'])
        assert.notEqual(results.get(id).is_error, true, JSON.stringify(results.get(id).value));
      return [combineAll(results)];
    },
    (results) => {
      assert.notEqual(results.get('combined').is_error, true, JSON.stringify(results.get('combined').value));
      assert.equal(results.get('combined').value.rowCount, 42);
      return [
        tool('weekly', 'summarize', {
          resultId: results.get('combined').value.resultId,
          groupBy: ['date', 'currency'],
          dateBucket: 'week',
          metrics: [
            { field: 'revenue', agg: 'sum' },
            { field: 'cost', agg: 'sum' },
          ],
          formulas: PROFIT,
          orderBy: { field: 'date', direction: 'asc' },
        }),
      ];
    },
    (results) => {
      assert.notEqual(results.get('weekly').is_error, true, JSON.stringify(results.get('weekly').value));
      return [{ type: 'text', text: 'Profit was USD 2,170 in the week of 31 August and USD 2,030 the week after.' }];
    },
  ]);
  assert.equal(reply.failed, false);
  assert.deepEqual(f.queries, [SHOP_SQL]);
  // Week 1: revenue 7 × (400 + 150) = 3,850; cost 7 × (120 + 50 + 70) = 1,680.
  // Week 2: the same revenue; cost 7 × (120 + 50 + 90) = 1,820.
  const weekly = results.get('weekly').value;
  assert.deepEqual(weekly.rows, [
    { date: '2026-08-31', currency: 'USD', revenue__sum: 3850, cost__sum: 1680, profit: 2170, margin: 0.5636 },
    { date: '2026-09-07', currency: 'USD', revenue__sum: 3850, cost__sum: 1820, profit: 2030, margin: 0.5273 },
  ]);
  const types = Object.fromEntries(weekly.columns.map((column) => [column.key, column.type]));
  assert.deepEqual([types.profit, types.margin], ['currency', 'percent']);
  // The completed actions read in order: three fetches, the combination, the weekly summary.
  assert.deepEqual(
    reply.events.filter((event) => event.kind !== 'error').map((event) => event.kind),
    ['report', 'report', 'report', 'summary', 'summary']
  );
  const summary = reply.events.filter((event) => event.kind === 'summary')[1];
  const formulas = (summary.details || []).find((detail) => detail.label === 'Formulas');
  assert.ok(formulas, JSON.stringify(summary.details));
  assert.match(formulas.value, /profit = revenue - cost/);
});

test('three sources with Meta in another currency: the combined formula is refused, then split by currency', () => {
  const f = fixture({ metaCurrency: 'EUR' });
  const { reply, results } = scriptedTurn(f, [
    () => fetchAll(f),
    (results) => [combineAll(results)],
    (results) => [
      tool('mixed', 'summarize', {
        resultId: results.get('combined').value.resultId,
        groupBy: ['date'],
        dateBucket: 'week',
        formulas: PROFIT,
      }),
    ],
    (results) => {
      assert.equal(results.get('mixed').is_error, true);
      assert.match(results.get('mixed').value.error, /different currencies\. Include currency in groupBy/);
      return [
        tool('split', 'summarize', {
          resultId: results.get('combined').value.resultId,
          groupBy: ['date', 'currency'],
          dateBucket: 'week',
          formulas: PROFIT,
          orderBy: { field: 'date', direction: 'asc' },
        }),
      ];
    },
    (results) => {
      assert.notEqual(results.get('split').is_error, true, JSON.stringify(results.get('split').value));
      return [{ type: 'text', text: 'Profit is shown per currency; no exchange rate was applied.' }];
    },
  ]);
  assert.equal(reply.failed, false);
  // USD: Google Ads revenue 2,800 a week less its spend and the Shopify costs (840 + 490, then
  // 840 + 630); EUR: Meta alone, 1,050 - 350. Nothing is converted.
  const rows = plain(results.get('split').value.rows).sort((a, b) =>
    (a.date + a.currency).localeCompare(b.date + b.currency)
  );
  assert.deepEqual(rows, [
    { date: '2026-08-31', currency: 'EUR', profit: 700, margin: 0.6667 },
    { date: '2026-08-31', currency: 'USD', profit: 1470, margin: 0.525 },
    { date: '2026-09-07', currency: 'EUR', profit: 700, margin: 0.6667 },
    { date: '2026-09-07', currency: 'USD', profit: 1330, margin: 0.475 },
  ]);
  // The failed call is marked recovered once the split call succeeds.
  const failed = reply.events.filter((event) => event.kind === 'error');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].recovered, true);
});

test('two sources: a profit formula over Google Ads and Meta in different currencies is split or refused', () => {
  const f = fixture({ metaCurrency: 'EUR' });
  const session = f.api.dmvChatSession_(f.book);
  const tools = f.api.dmvChatTools_(session);
  const call = (name, input) => {
    const reply = f.api.dmvChatRunTool_(session, tools, { name, input });
    return { isError: reply.isError, value: JSON.parse(reply.content) };
  };
  const [google, meta] = fetchAll(f).slice(0, 2).map((item) => call(item.name, item.input).value.resultId);
  const map = [{ from: 'date', to: 'date' }, { from: 'spend', to: 'spend' }, { from: 'conversion_value', to: 'revenue' }];
  const combined = call('combine_results', {
    sources: [
      { resultId: google, label: 'Google Ads', columns: map },
      { resultId: meta, label: 'Meta', columns: map },
    ],
  });
  assert.equal(combined.isError, false, JSON.stringify(combined.value));
  const formulas = [
    { key: 'profit', expression: 'revenue - spend' },
    { key: 'net_roas', expression: 'revenue / 1.05 / spend' },
  ];
  // A total across both currencies is refused, even for the unitless net ROAS.
  for (const groupBy of [[], ['date']]) {
    const refused = call('summarize', { resultId: combined.value.resultId, groupBy, formulas });
    assert.equal(refused.isError, true, JSON.stringify(groupBy));
    assert.match(refused.value.error, /different currencies/);
  }
  // Grouped by currency (or filtered to one) each total stays in its own money.
  const split = call('summarize', {
    resultId: combined.value.resultId,
    groupBy: ['currency'],
    formulas,
    orderBy: { field: 'currency', direction: 'asc' },
  });
  assert.equal(split.isError, false, JSON.stringify(split.value));
  // EUR: 14 × (150 - 50) = 1,400 and 2,100 / 1.05 / 700 = 2.857142...; USD: 14 × (400 - 120).
  assert.deepEqual(split.value.rows, [
    { currency: 'EUR', profit: 1400, net_roas: 2.8571 },
    { currency: 'USD', profit: 3920, net_roas: 3.1746 },
  ]);
  const filtered = call('summarize', {
    resultId: combined.value.resultId,
    filters: [{ field: 'currency', op: 'eq', value: 'USD' }],
    formulas,
  });
  assert.equal(filtered.isError, false, JSON.stringify(filtered.value));
  assert.deepEqual(filtered.value.rows, [{ profit: 3920, net_roas: 3.1746 }]);
  // Two sources in the same currency combine into one profit, no split needed.
  const same = fixture();
  const sameSession = same.api.dmvChatSession_(same.book);
  const sameTools = same.api.dmvChatTools_(sameSession);
  const sameCall = (name, input) => JSON.parse(same.api.dmvChatRunTool_(sameSession, sameTools, { name, input }).content);
  const ids = fetchAll(same).slice(0, 2).map((item) => sameCall(item.name, item.input).resultId);
  const both = sameCall('combine_results', {
    sources: [
      { resultId: ids[0], label: 'Google Ads', columns: map },
      { resultId: ids[1], label: 'Meta', columns: map },
    ],
  });
  assert.deepEqual(sameCall('summarize', { resultId: both.resultId, formulas }).rows, [
    { profit: 5320, net_roas: 3.0812 },
  ]);
});

// "A dashboard of profit and net ROAS across Google Ads and Meta": the plan names tile formulas,
// a save refuses a typo naming the tile and the columns it can use, and the corrected plan saves
// and runs.
test('a dashboard plan with formulas saves and runs in one chat turn', () => {
  const f = fixture();
  const mapping = [
    { field: 'date', key: 'date' },
    { field: 'spend', key: 'spend' },
    { field: 'conversion_value', key: 'conversion_value' },
  ];
  const dataset = (id, label, connectionId) => ({ id, label, sheetName: label + ' Data', connectionId, reportType: 'daily', dateRange: DATES, fields: ['date', 'spend', 'conversion_value'], mapping });
  const profit = { key: 'profit', label: 'Profit', expression: 'conversion_value - spend' };
  const netRoas = { key: 'net_roas', label: 'Net ROAS', expression: 'conversion_value / 1.05 / spend' };
  const plan = {
    name: 'Profit overview',
    target: { sheetName: 'Profit Dashboard' },
    datasets: [dataset('google', 'Google Ads', f.ids.google), dataset('meta', 'Meta', f.ids.meta)],
    tiles: [
      { title: 'Headline', type: 'kpi', metrics: [{ field: 'spend', agg: 'sum' }], formulas: [profit, netRoas] },
      { title: 'Weekly profit', type: 'column', groupBy: ['date'], dateBucket: 'week', formulas: [profit] },
      { title: 'By platform', type: 'table', groupBy: ['source'], metrics: [{ field: 'spend', agg: 'sum' }], formulas: [profit, netRoas], orderBy: { field: 'profit', direction: 'desc' } },
    ],
    neutral: ['spend'],
  };
  const typo = JSON.parse(JSON.stringify(plan));
  typo.tiles[0].formulas[1].expression = 'conversion_value / 1.05 / spnd';
  const { reply, results } = scriptedTurn(
    f,
    [
      (_results, request) => {
        const save = request.tools.find((item) => item.name === 'save_dashboard');
        const summarize = request.tools.find((item) => item.name === 'summarize');
        // Tiles take the same formulas as summarize.
        assert.deepEqual(save.input_schema.properties.tiles.items.properties.formulas.items, summarize.input_schema.properties.formulas.items);
        return [tool('typo', 'save_dashboard', typo)];
      },
      (results) => {
        assert.equal(results.get('typo').is_error, true);
        assert.match(results.get('typo').value.error, /"Headline": unknown column "spnd"\. Mapped columns: date, spend, conversion_value, source, currency/);
        return [tool('save', 'save_dashboard', plan)];
      },
      (results) => {
        assert.notEqual(results.get('save').is_error, true, JSON.stringify(results.get('save').value));
        return [tool('run', 'run_dashboard', { id: results.get('save').value.id })];
      },
      (results) => {
        assert.notEqual(results.get('run').is_error, true, JSON.stringify(results.get('run').value));
        return [{ type: 'text', text: 'The dashboard is ready.' }];
      },
    ],
    'Build a dashboard of profit and net ROAS across Google Ads and Meta.'
  );
  assert.equal(reply.failed, false);
  const run = results.get('run').value;
  const precise = (value) => Number(value.toPrecision(12));
  // Google Ads: 14 × (400 - 120) = 3,920 profit; Meta: 14 × (150 - 50) = 1,400. Net ROAS is
  // 7,700 / 1.05 / 2,380 over the overall sums.
  assert.deepEqual(run.scorecards, [
    { label: 'Spend (USD)', value: 2380 },
    { label: 'Profit (USD)', value: 5320 },
    { label: 'Net ROAS', value: precise(7700 / 1.05 / 2380) },
  ]);
  assert.deepEqual(run.tiles.map((tile) => [tile.title, tile.preview]), [
    ['Weekly profit', [['Date', 'Profit'], ['2026-08-31', 2660], ['2026-09-07', 2660]]],
    ['By platform', [['Source', 'Spend', 'Profit', 'Net ROAS'], ['Google Ads', 1680, 3920, precise(5600 / 1.05 / 1680)], ['Meta', 700, 1400, precise(2100 / 1.05 / 700)]]],
  ]);
  // The table's total row is the true total, never the 6.03 its rows' net ROAS would add up to.
  const sheet = f.tab('Profit Dashboard');
  const lines = [];
  for (let r = 1; r <= sheet.getLastRow(); r++) {
    const line = [];
    for (let c = 1; c <= sheet.maxColumns; c++) if (f.shown(sheet, r, c) !== '') line.push(f.shown(sheet, r, c));
    lines.push(line);
  }
  assert.deepEqual(lines.find((line) => line[0] === 'Total'), ['Total', 2380, 5320, 7700 / 1.05 / 2380]);
  // The refused save is marked recovered by the saved one, and the plan keeps its formulas.
  assert.deepEqual(reply.events.map((event) => event.kind), ['error', 'dashboard', 'report', 'report', 'dashboard']);
  assert.equal(reply.events[0].recovered, true);
  const saved = plain(f.api.dmvUnpack_(f.api.dmvDashboardHere_(results.get('save').value.id).plan));
  assert.deepEqual(saved.tiles[0].formulas, [profit, netRoas]);
  assert.deepEqual(saved.tiles[2].formulas, [profit, netRoas]);
});
