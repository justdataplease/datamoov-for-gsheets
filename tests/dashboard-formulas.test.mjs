import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatamoovSandbox, plain } from './helpers/datamoov-sandbox.mjs';

// Calculated metrics on dashboard tiles: every tile kind evaluates its formulas over the sums of
// its rows, buckets or totals, again on every refresh and without AI.
const COLUMNS = [
  { key: 'date', type: 'date' },
  { key: 'campaign', type: 'text' },
  { key: 'spend', type: 'currency' },
  { key: 'revenue', type: 'currency' },
  { key: 'fees', type: 'currency' },
  { key: 'clicks', type: 'number' },
  { key: 'conversions', type: 'number' },
  { key: 'ctr', type: 'percent' },
];

const row = (date, campaign, spend, revenue, fees, clicks, conversions) => ({ date, campaign, spend, revenue, fees, clicks, conversions, ctr: 0.05 });

function fixture(columns = COLUMNS) {
  const f = createDatamoovSandbox();
  const outputs = {
    one: [row('2026-08-03', 'A', 30, 90, 3, 10, 3), row('2026-08-12', 'B', 10, 12, 1, 30, 1)],
    two: [row('2026-08-04', 'C', 20, 25, 2, 40, 4)],
  };
  f.api.dmvRegisterConnector_({
    id: 'fixture_source',
    label: 'Fixture source',
    category: 'Test',
    allowedHosts: ['fixture.example'],
    authFields: [
      { key: 'account', label: 'Account', type: 'text', required: true },
      { key: 'token', label: 'Token', type: 'password', required: true },
    ],
    reports: [
      {
        id: 'daily',
        label: 'Daily',
        fields: columns,
        dateRange: true,
        configFields: [],
        fetch(ctx) {
          const name = ctx.credentials.account;
          const rows = typeof outputs[name] === 'function' ? outputs[name](ctx) : outputs[name];
          return { columns, rows, metadata: { complete: true, currency: f.currency?.[name] || 'EUR' } };
        },
      },
    ],
  });
  f.connections = ['one', 'two'].map((account) =>
    f.api.dmvSaveConnection({ connectorId: 'fixture_source', label: account, credentials: { account, token: 'private-token' } })
  );
  const dataset = (connection, i, extra = {}) => ({
    id: 'source' + i,
    label: 'Source ' + (i + 1),
    sheetName: 'Source ' + (i + 1) + ' data',
    connectionId: connection.id,
    reportType: 'daily',
    fields: columns.map((column) => column.key),
    config: {},
    dateRange: { preset: 'lastMonth' },
    maxRows: 100,
    mapping: columns.map((column) => ({ field: column.key, key: column.key })),
    ...extra,
  });
  f.dataset = dataset;
  f.input = {
    name: 'Profit overview',
    target: { sheetName: 'Profit Dashboard' },
    datasets: f.connections.map((connection, i) => dataset(connection, i)),
    tiles: [{ title: 'Monthly spend', type: 'column', groupBy: ['date'], dateBucket: 'month', metrics: [{ field: 'spend', agg: 'sum' }] }],
  };
  f.setRows = (account, rows) => {
    outputs[account] = rows;
  };
  f.save = (input = f.input) => plain(f.api.dmvSaveDashboard(input));
  f.run = (id) => plain(f.api.dmvRunDashboard(id));
  f.plan = (id) => plain(f.api.dmvUnpack_(f.api.dmvRead_('dashboard', id).plan));
  return f;
}

// The dashboard tab as it reads: each row's non-empty cells in column order.
function pageOf(f, name = 'Profit Dashboard') {
  const sheet = f.tab(name);
  const out = [];
  for (let r = 1; r <= sheet.getLastRow(); r++) {
    const line = [];
    for (let c = 1; c <= sheet.maxColumns; c++) if (f.shown(sheet, r, c) !== '') line.push(f.shown(sheet, r, c));
    out.push(line);
  }
  return out;
}

function rowsOf(f, name) {
  const sheet = f.tab(name);
  const out = [];
  for (let r = 1; r <= sheet.getLastRow(); r++) {
    const line = [];
    for (let c = 1; c <= 14; c++) line.push(f.shown(sheet, r, c));
    while (line.length && line[line.length - 1] === '') line.pop();
    out.push(line);
  }
  return out;
}

const find = (rows, first) => rows.findIndex((line) => line[0] === first);

function cardOf(page, title) {
  const at = find(page, title);
  assert.ok(at >= 0, title + ' is on the page');
  const rows = [];
  for (let r = at + 1; r < page.length && page[r].length; r++) rows.push(page[r]);
  return rows;
}

const isBar = (value) => typeof value === 'string' && /^[█]+$/.test(value);
const noBars = (rows) => rows.map((line) => line.filter((value) => !isBar(value)));

const rgb = (hex) => ({ red: parseInt(hex.slice(1, 3), 16) / 255, green: parseInt(hex.slice(3, 5), 16) / 255, blue: parseInt(hex.slice(5, 7), 16) / 255 });
const GOOD = rgb('#006300'), BAD = rgb('#c62828'), GREY = rgb('#6b7280');
function cellOf(f, sheet, value) {
  const found = [...sheet.cells.keys()].map((key) => key.split(':').map(Number)).filter(([row, column]) => f.shown(sheet, row, column) === value);
  return found.sort((a, b) => a[0] - b[0] || a[1] - b[1])[0] || null;
}

const PROFIT = { key: 'profit', label: 'Profit', expression: 'revenue - spend - fees' };
const NET_ROAS = { key: 'net_roas', label: 'Net ROAS', expression: 'revenue / 1.05 / spend' };

// Two accounts in two months; rows depend on the period each dataset asks for.
function periodsFixture(rows) {
  const f = fixture();
  for (const account of ['one', 'two']) f.setRows(account, (ctx) => rows[account][ctx.startDate.slice(0, 7)] || []);
  const [one, two] = f.input.datasets;
  f.input.datasets = [
    one,
    two,
    { ...one, id: 'prev0', label: 'Source 1 previous', sheetName: 'Source 1 previous data', dateRange: { preset: 'previousMonth' } },
    { ...two, id: 'prev1', label: 'Source 2 previous', sheetName: 'Source 2 previous data', dateRange: { preset: 'previousMonth' } },
  ];
  f.compare = { current: ['source0', 'source1'], previous: ['prev0', 'prev1'] };
  return f;
}

// August: spend 50, revenue 115, fees 5. July: spend 40, revenue 80, fees 8.
const PERIODS = {
  one: { '2026-08': [row('2026-08-03', 'A', 30, 90, 3, 10, 3)], '2026-07': [row('2026-07-02', 'A', 20, 50, 4, 8, 2)] },
  two: { '2026-08': [row('2026-08-04', 'C', 20, 25, 2, 40, 4)], '2026-07': [row('2026-07-03', 'C', 20, 30, 4, 20, 1)] },
};

test('scorecards evaluate formulas over the overall sums, compare them and colour their change by polarity', () => {
  const f = periodsFixture(PERIODS);
  const share = { key: 'fee_share', label: 'Fee share', expression: 'fees / spend', percent: true };
  f.input.tiles.push({
    title: 'Totals',
    type: 'kpi',
    metrics: [{ field: 'spend', agg: 'sum' }],
    formulas: [PROFIT, NET_ROAS, share],
    compare: f.compare,
  });
  f.input.lowerIsBetter = ['fee_share'];
  f.input.neutral = ['spend', 'unused'];
  const saved = f.save();
  assert.deepEqual(f.plan(saved.id).tiles[1].formulas, [PROFIT, NET_ROAS, share]);
  assert.deepEqual(f.plan(saved.id).lowerIsBetter, ['fee_share'], 'a formula key is a polarity name');
  assert.deepEqual(f.plan(saved.id).neutral, ['spend']);
  const result = f.run(saved.id);
  // Net ROAS is 115 / 1.05 / 50 against 80 / 1.05 / 40 at twelve digits, not an average of the
  // accounts' values; the fee share falls, which is good for a lower-is-better value.
  assert.deepEqual(result.scorecards, [
    { label: 'Spend (EUR)', value: 50, previous: 40, change: '+25.0% vs 40.00', tone: 'neutral' },
    { label: 'Profit (EUR)', value: 60, previous: 32, change: '+87.5% vs 32.00', tone: 'good' },
    { label: 'Net ROAS', value: 2.19047619048, previous: 1.90476190476, change: '+15.0% vs 1.90', tone: 'good' },
    { label: 'Fee share', value: 0.1, previous: 0.2, change: '-50.0% vs 20.00%', tone: 'good' },
  ]);
  const report = f.tab('Profit Dashboard');
  assert.deepEqual(f.format(report, ...cellOf(f, report, '▲ 87.5% vs 32.00')).textFormat.foregroundColor, GOOD);
  assert.deepEqual(f.format(report, ...cellOf(f, report, '▼ 50.0% vs 20.00%')).textFormat.foregroundColor, GOOD);
  assert.deepEqual(f.format(report, ...cellOf(f, report, '▲ 25.0% vs 40.00')).textFormat.foregroundColor, GREY);
  assert.deepEqual(result.highlights.slice(0, 2), [
    'Profit (EUR) rose 87.5% to 60.00 (previous 32.00).',
    'Fee share fell 50.0% to 10.00% (previous 20.00%).',
  ]);
  // Without polarity lists a falling fee share is a fall like any other.
  delete f.input.lowerIsBetter;
  delete f.input.neutral;
  const again = f.run(f.save({ ...f.input, id: saved.id, revision: saved.revision }).id);
  assert.equal(again.scorecards[3].tone, 'bad');
});

test('a formula scorecard reads only what it needs, so an unrelated amount does not split it by currency', () => {
  const f = fixture();
  f.currency = { two: 'USD' };
  f.input.tiles.push({
    title: 'Totals',
    type: 'kpi',
    ratios: [{ key: 'cpc', label: 'CPC', numerator: 'spend', denominator: 'clicks' }],
    formulas: [
      { key: 'conv_rate', label: 'Conversion rate', expression: 'conversions / clicks', percent: true },
      PROFIT,
      { key: 'cpc_net', label: 'CPC after fees', expression: 'cpc + fees / clicks' },
    ],
  });
  const result = f.run(f.save().id);
  assert.deepEqual(result.scorecards, [
    { label: 'CPC (EUR)', value: 1 },
    { label: 'CPC (USD)', value: 0.5 },
    // 8 conversions of 80 clicks over both accounts: no money, no split.
    { label: 'Conversion rate', value: 0.1 },
    { label: 'Profit (EUR)', value: 58 },
    { label: 'Profit (USD)', value: 3 },
    // A formula over a money ratio keeps currencies apart too: 1 + 4 / 40 and 0.5 + 2 / 40.
    { label: 'CPC after fees (EUR)', value: 1.1 },
    { label: 'CPC after fees (USD)', value: 0.55 },
  ]);
});

test('a table shows formula columns with true totals, changes, highlight rules on values and totals, and heat shading', () => {
  const f = periodsFixture({
    one: {
      '2026-08': [row('2026-08-03', 'A', 30, 90, 3, 10, 3), row('2026-08-12', 'B', 10, 12, 1, 30, 1)],
      '2026-07': [row('2026-07-02', 'A', 20, 50, 4, 8, 2), row('2026-07-02', 'B', 10, 10, 1, 8, 2)],
    },
    two: { '2026-08': [row('2026-08-04', 'C', 20, 25, 2, 40, 4)], '2026-07': [row('2026-07-03', 'C', 20, 30, 4, 20, 1)] },
  });
  f.input.tiles.push({
    title: 'Campaigns',
    type: 'table',
    groupBy: ['campaign'],
    metrics: [{ field: 'spend', agg: 'sum' }],
    ratios: [{ key: 'cpa', label: 'CPA', numerator: 'spend', denominator: 'conversions' }],
    formulas: [PROFIT, NET_ROAS],
    orderBy: { field: 'profit', direction: 'desc' },
    // The overall net ROAS is 127 / 1.05 / 60 = 2.0159; 0.58 of it is 1.1692.
    highlight: [
      { field: 'profit', op: 'gte', value: 50, color: 'green' },
      { field: 'net_roas', op: 'lt', ofTotal: 0.58, color: 'red' },
    ],
    compare: f.compare,
  });
  f.input.neutral = ['spend'];
  const saved = f.save();
  const result = f.run(saved.id);
  const report = f.tab('Profit Dashboard');
  // Rows by profit, highest first. The total divides the overall sums (127 / 1.05 / 60), never
  // adds or averages the rows' values; each change is against the same row a month earlier, so
  // B's profit of 1 after -1 is a rise of 200%.
  assert.deepEqual(noBars(cardOf(pageOf(f), 'Campaigns')), [
    ['Campaign', 'Spend (EUR)', 'Δ %', 'CPA (EUR)', 'Δ %', 'Profit (EUR)', 'Δ %', 'Net ROAS', 'Δ %'],
    ['A', 30, 0.5, 10, 0, 57, 1.1923076923076923, 2.8571428571428568, 0.19999999999999984],
    ['C', 20, 0, 5, -0.75, 3, -0.5, 1.1904761904761905, -0.16666666666666657],
    ['B', 10, 0, 10, 1, 1, 2, 1.1428571428571428, 0.2],
    ['Total', 60, 0.2, 7.5, -0.25, 61, 0.967741935483871, 2.015873015873016, 0.17592592592592596],
  ]);
  const legend = pageOf(f).find((line) => line[0] === 'Row tints');
  assert.deepEqual(legend, ['Row tints', 'Profit ≥ EUR 50.00', 'Net ROAS < 0.58× overall (1.17)']);
  const tint = (name) => f.format(report, cellOf(f, report, name)[0], cellOf(f, report, name)[1] + 3).backgroundColor;
  assert.deepEqual(tint('A'), rgb('#e3f4e3'));
  assert.deepEqual(tint('B'), rgb('#fde4e4'));
  // C is not flagged, so its net ROAS keeps the heat shading of a rate: the middle of three.
  assert.deepEqual(f.format(report, ...cellOf(f, report, 1.1904761904761905)).backgroundColor, rgb('#cde2fb'));
  // A rising profit is good, a falling one bad.
  assert.deepEqual(f.format(report, ...cellOf(f, report, 1.1923076923076923)).textFormat.foregroundColor, GOOD);
  assert.deepEqual(f.format(report, ...cellOf(f, report, -0.5)).textFormat.foregroundColor, BAD);
  assert.deepEqual(result.highlights.slice(-2), [
    'Campaigns: 1 of 3 rows has Profit at or above EUR 50.00 (green rows) — A.',
    'Campaigns: 1 of 3 rows has Net ROAS below 0.58× the overall 2.02 (red rows) — B.',
  ]);
});

test('a table cut by a formula ranking keeps its total over every row', () => {
  const f = fixture();
  f.input.tiles.push({
    title: 'Top margin',
    type: 'table',
    groupBy: ['campaign'],
    formulas: [PROFIT, { key: 'margin', label: 'Margin', expression: 'profit / revenue', percent: true }],
    orderBy: { field: 'margin', direction: 'desc' },
    limit: 2,
  });
  const result = f.run(f.save().id);
  // Margins: A 57 / 90, C 3 / 25, B 1 / 12; the total is 61 / 127 over all three.
  const card = noBars(cardOf(pageOf(f), 'Top margin'));
  assert.deepEqual(card.slice(-4), [
    ['Campaign', 'Profit (EUR)', 'Margin'],
    ['A', 57, 57 / 90],
    ['C', 3, 0.12],
    ['Total (all 3)', 61, 61 / 127],
  ]);
  assert.deepEqual(result.tiles[1].preview.slice(0, 3), [
    ['Campaign', 'Profit', 'Margin'],
    ['A', 57, 0.633333333333],
    ['C', 3, 0.12],
  ]);
});

test('chart series take formulas, on the right axis when far smaller or when the plan says so', () => {
  const f = fixture();
  f.input.tiles = [
    // Weekly spend runs to 50 and net ROAS to about 2: net ROAS moves to the right axis.
    { title: 'Spend and net ROAS', type: 'line', groupBy: ['date'], dateBucket: 'week', metrics: [{ field: 'spend', agg: 'sum' }], formulas: [NET_ROAS] },
    {
      title: 'Spend, clicks and profit',
      type: 'column',
      groupBy: ['date'],
      dateBucket: 'week',
      metrics: [{ field: 'spend', agg: 'sum' }, { field: 'clicks', agg: 'sum' }],
      formulas: [PROFIT],
      secondaryAxis: ['profit'],
    },
    { title: 'Profit by campaign', type: 'bar', groupBy: ['campaign'], formulas: [PROFIT] },
  ];
  f.run(f.save().id);
  const axes = (index) => f.state.charts[index].spec.basicChart.series.map((series) => series.targetAxis);
  assert.deepEqual(axes(0), ['LEFT_AXIS', 'RIGHT_AXIS']);
  assert.deepEqual(axes(1), ['LEFT_AXIS', 'LEFT_AXIS', 'RIGHT_AXIS']);
  const data = rowsOf(f, 'Profit Dashboard (chart data)');
  const trend = find(data, 'Spend and net ROAS');
  // Each week's net ROAS divides that week's sums.
  assert.deepEqual(data.slice(trend + 1, trend + 4), [
    ['Date', 'Spend', 'Net ROAS'],
    ['3 Aug', 50, 115 / 50 / 1.05],
    ['10 Aug', 10, 8 / 7],
  ]);
  const bars = find(data, 'Profit by campaign');
  assert.deepEqual(data.slice(bars + 1, bars + 5), [['Campaign', 'Profit'], ['A', 57], ['C', 3], ['B', 1]]);
});

test('a compared chart evaluates its formulas bucket by bucket in both periods', () => {
  const f = periodsFixture(PERIODS);
  f.input.tiles = [
    {
      title: 'Weekly profit',
      type: 'line',
      groupBy: ['date'],
      dateBucket: 'week',
      metrics: [{ field: 'spend', agg: 'sum' }],
      ratios: [{ key: 'roas', label: 'ROAS', numerator: 'revenue', denominator: 'spend' }],
      formulas: [PROFIT, { key: 'net', label: 'Net ROAS', expression: 'roas / 1.05' }],
      compare: f.compare,
    },
  ];
  f.run(f.save().id);
  const data = rowsOf(f, 'Profit Dashboard (chart data)');
  const at = data.findIndex((line) => String(line[0]).startsWith('Weekly profit'));
  assert.deepEqual(data.slice(at + 1, at + 3), [
    ['Date', 'Spend', 'Spend (previous period)', 'ROAS', 'ROAS (previous period)', 'Profit', 'Profit (previous period)', 'Net ROAS', 'Net ROAS (previous period)'],
    ['1 Aug', 50, 40, 2.3, 2, 60, 32, 115 / 50 / 1.05, 2 / 1.05],
  ]);
  // Spend and profit share the left axis; the rates sit on the right, each twin with its series.
  assert.deepEqual(
    f.state.charts[0].spec.basicChart.series.map((series) => series.targetAxis),
    ['LEFT_AXIS', 'LEFT_AXIS', 'RIGHT_AXIS', 'RIGHT_AXIS', 'LEFT_AXIS', 'LEFT_AXIS', 'RIGHT_AXIS', 'RIGHT_AXIS']
  );
});

test('a save refuses formulas that a refresh could not evaluate, naming the tile and the position', () => {
  const f = fixture();
  const tile = (formulas, extra = {}) => ({ title: 'Totals', type: 'kpi', metrics: [{ field: 'spend', agg: 'sum' }], formulas, ...extra });
  const refused = (formulas, pattern, extra) => {
    f.input.tiles[1] = tile(formulas, extra);
    assert.throws(() => f.save(), pattern);
  };
  refused([{ key: 'profit', expression: 'revenue - (spend' }], /"Totals": Formula "profit": unbalanced parenthesis: "\(" at position 11 is never closed at position 17\./);
  refused([{ key: 'profit', expression: 'revenue - spnd' }], /"Totals": unknown column "spnd"\. Mapped columns: date, campaign, spend/);
  refused([{ key: 'rate', expression: 'ctr * 2' }], /"Totals": Formula "rate": column "ctr" is not summable \(a rate, average or text column\)/);
  refused([{ key: 'squared', expression: 'spend * revenue' }], /"Totals": Formula "squared": "\*" multiplies two amounts of money at position 7\./);
  refused([{ key: 'mixed', expression: 'spend + clicks' }], /"Totals": Formula "mixed": "\+" adds money to a non-money column at position 7\./);
  refused([{ key: 'share', expression: 'revenue - spend', percent: true }], /"Totals": Formula "share": the result is an amount of money, so it cannot be a percent\./);
  refused([{ key: 'margin', expression: 'profit / revenue' }, PROFIT], /"Totals": Formula "margin": refers to formula "profit", which comes later; list it before this one at position 1\./);
  refused([{ key: 'loop', expression: 'loop + 1' }], /"Totals": Formula "loop": refers to itself at position 1\./);
  refused([{ key: 'fixed', expression: '1 + 2' }], /"Totals": Formula "fixed": it references no column/);
  refused([{ key: 'name', expression: 'campaign' }], /"Totals": Formula "name": column "campaign" is not summable/);
  refused([{ key: 'odd', expression: 'sqrt(spend)' }], /"Totals": Formula "odd": unknown function "sqrt" at position 1; use abs, min, max or round\./);
  refused(Array.from({ length: 11 }, (_, i) => ({ key: 'f' + i, expression: 'spend * ' + i })), /"Totals": choose at most 10 formulas\./);
  // Keys stay apart from the tile's metrics, ratios, columns and each other.
  for (const key of ['spend', 'Revenue', 'spend__sum', 'source', 'currency', 'cpc', '1st', 'has space'])
    refused([{ key, expression: 'revenue - spend' }], /"Totals": each formula needs a distinct key/, { ratios: [{ key: 'cpc', numerator: 'spend', denominator: 'clicks' }] });
  refused([PROFIT, { ...PROFIT, key: 'PROFIT' }], /"Totals": each formula needs a distinct key/);
  refused([{ ...PROFIT, extra: true }], /Use only the documented dashboard settings: key, label, expression, percent\./);
  refused([{ key: 'profit', expression: 42 }], /"Totals": each formula needs a distinct key/);
  // Highlights and the right axis name formula keys like ratio keys.
  f.input.tiles[1] = { title: 'Campaigns', type: 'table', groupBy: ['campaign'], formulas: [PROFIT], highlight: [{ field: 'profits', op: 'gt', value: 1, color: 'red' }] };
  assert.throws(() => f.save(), /highlight field "profits" is not a metric field, ratio key, formula key or groupBy column/);
  f.input.tiles[1].highlight = [{ field: 'profit', op: 'gt', color: 'red' }];
  assert.throws(() => f.save(), /"Campaigns": each highlight on a metric field, ratio key or formula key needs op \(gt, gte, lt, lte or eq\), exactly one of value/);
  f.input.tiles[1].highlight = [{ field: 'campaign', op: 'eq', ofTotal: 2, color: 'red' }];
  assert.throws(() => f.save(), /"Campaigns": ofTotal is a multiple of an overall number, so it applies to metric fields, ratio keys and formula keys; "campaign" is a groupBy column/);
  f.input.tiles[1] = { title: 'Trend', type: 'line', groupBy: ['date'], formulas: [PROFIT], secondaryAxis: ['profit'] };
  assert.throws(() => f.save(), /"Trend": secondaryAxis names metric fields, ratio keys or formula keys/);
  // A pie takes one value, which may be a formula.
  f.input.tiles[1] = { title: 'Share', type: 'pie', groupBy: ['campaign'], formulas: [PROFIT] };
  assert.equal(f.save().name, 'Profit overview');
  f.input.tiles[1] = { title: 'Share', type: 'pie', groupBy: ['campaign'], metrics: [{ field: 'spend', agg: 'sum' }], formulas: [PROFIT] };
  assert.throws(() => f.save(), /"Share": a pie or split chart takes exactly one metric, ratio or formula\./);
});

test('an unmapped dataset checks declared columns at save and discovered ones at refresh', () => {
  const f = fixture();
  const [one] = f.input.datasets;
  delete one.mapping;
  f.input.datasets = [one];
  f.input.tiles = [{ title: 'Profit', type: 'column', groupBy: ['campaign'], formulas: [PROFIT] }];
  // Names match without regard to case, as summarize matches them.
  f.input.tiles[0].formulas = [{ key: 'profit', label: 'Profit', expression: 'Revenue - SPEND - fees' }];
  const result = f.run(f.save().id);
  assert.deepEqual(result.tiles[0].preview, [['Campaign', 'Profit'], ['A', 57], ['B', 1]]);
  f.input.tiles[0].formulas = [{ key: 'clicks', expression: 'revenue - spend' }];
  assert.throws(() => f.save(), /"Profit": each formula needs a distinct key/, 'a declared column name is taken');
  f.input.tiles[0].formulas = [{ key: 'gross', expression: 'spend * revenue' }];
  assert.throws(() => f.save(), /"Profit": Formula "gross": "\*" multiplies two amounts of money/);
});

const unmapped = (f) => {
  const [one] = f.input.datasets;
  delete one.mapping;
  f.input.datasets = [one];
  return f;
};

test('a save refuses what every refresh would: a ratio key named like a column, a key repeating a column in another case', () => {
  for (const make of [fixture, () => unmapped(fixture())]) {
    const f = make();
    // ctr is a column of the rows; a ratio of that name is ambiguous in a formula.
    f.input.tiles[1] = { title: 'Rates', type: 'kpi', ratios: [{ key: 'ctr', numerator: 'clicks', denominator: 'conversions' }], formulas: [{ key: 'ctr2', expression: 'CTR * 2' }] };
    assert.throws(() => f.save(), /"Rates": Formula "ctr2": "CTR" is both a column and a ratio key; rename the ratio at position 1\./);
    // A ratio named apart from every column composes, and the plan saves and refreshes.
    f.input.tiles[1] = { title: 'Rates', type: 'kpi', ratios: [{ key: 'cvr', label: 'Clicks per conversion', numerator: 'clicks', denominator: 'conversions' }], formulas: [{ key: 'cvr2', label: 'Twice that', expression: 'cvr * 2' }] };
    assert.deepEqual(f.run(f.save().id).scorecards, [
      { label: 'Clicks per conversion', value: 10 },
      { label: 'Twice that', value: 20 },
    ]);
  }
  // A key that repeats an unused column of an unmapped dataset in another case is taken too.
  const f = unmapped(fixture());
  for (const key of ['Spend', 'CTR', 'Campaign', 'DATE']) {
    f.input.tiles[1] = { title: 'Totals', type: 'kpi', metrics: [{ field: 'clicks', agg: 'sum' }], formulas: [{ key, expression: 'revenue - fees' }] };
    assert.throws(() => f.save(), /"Totals": each formula needs a distinct key/, key);
  }
});

test('a save refuses a column that cannot be summed: one a connector marks as not additive, or labelled as a rate', () => {
  const WIDE = COLUMNS.concat([
    { key: 'reach', type: 'number', additive: false },
    { key: 'freq', label: 'Frequency', type: 'number' },
  ]);
  const tile = (expression) => ({ title: 'Reach', type: 'column', groupBy: ['campaign'], metrics: [{ field: 'spend', agg: 'sum' }], formulas: [{ key: 'cost_per', label: 'Cost per reach', expression }] });
  for (const make of [() => fixture(WIDE), () => unmapped(fixture(WIDE))]) {
    const f = make();
    f.input.tiles = [tile('spend / reach * 1000')];
    assert.throws(() => f.save(), /"Reach": Formula "cost_per": column "reach" is not summable \(a rate, average or text column\); use the counts or amounts it comes from at position 9\./);
    f.input.tiles = [tile('spend / FREQ')];
    assert.throws(() => f.save(), /"Reach": Formula "cost_per": column "freq" is not summable/);
    f.input.tiles = [tile('spend / clicks')];
    assert.equal(f.save().name, 'Profit overview');
  }
  // A mapped column cannot be summed when the field of any dataset behind it cannot.
  const f = fixture(WIDE);
  f.input.datasets[1].mapping = f.input.datasets[1].mapping.map((entry) => (entry.field === 'reach' ? { field: 'clicks', key: 'reach' } : entry));
  f.input.datasets[1].mapping = f.input.datasets[1].mapping.filter((entry) => entry.field !== 'clicks' || entry.key === 'reach');
  f.input.tiles = [tile('spend / reach')];
  assert.throws(() => f.save(), /"Reach": Formula "cost_per": column "reach" is not summable/);
  // The check agrees with summarize at refresh: that dataset alone sums its clicks as reach.
  f.input.datasets = [f.input.datasets[1]];
  f.input.tiles = [tile('spend / reach')];
  const result = f.run(f.save().id);
  assert.deepEqual(result.tiles[0].preview, [['Campaign', 'Spend', 'Cost per reach'], ['C', 20, 0.5]]);
});

test('a refresh names the tile when a formula meets a column only discovered then', () => {
  const f = fixture();
  // A query report declares no fields; its columns are known only once it runs.
  f.api.dmvRegisterConnector_({
    id: 'query_source',
    label: 'Query source',
    category: 'Test',
    allowedHosts: [],
    authFields: [{ key: 'token', label: 'Token', type: 'password', required: true }],
    reports: [
      {
        id: 'query',
        label: 'Query',
        dateRange: false,
        configFields: [],
        fetch: () => ({ columns: COLUMNS, rows: [row('2026-08-03', 'A', 30, 90, 3, 10, 3)], metadata: { complete: true, currency: 'EUR' } }),
      },
    ],
  });
  const connection = f.api.dmvSaveConnection({ connectorId: 'query_source', label: 'Warehouse', credentials: { token: 'private-token' } });
  f.input.datasets = [{ id: 'warehouse', label: 'Warehouse', sheetName: 'Warehouse data', connectionId: connection.id, reportType: 'query', fields: [], config: {}, maxRows: 100 }];
  f.input.tiles[1] = { title: 'Rates', type: 'kpi', ratios: [{ key: 'ctr', numerator: 'clicks', denominator: 'conversions' }], formulas: [{ key: 'ctr2', expression: 'ctr * 2' }] };
  assert.throws(() => f.run(f.save().id), /^Error: "Rates": Formula "ctr2": "ctr" is both a column and a ratio key; rename the ratio at position 1\.$/);
  f.input.tiles[1] = { title: 'Totals', type: 'kpi', metrics: [{ field: 'clicks', agg: 'sum' }], formulas: [{ key: 'Spend', expression: 'revenue - fees' }] };
  assert.throws(() => f.run(f.save().id), /^Error: "Totals": Formula key "Spend" is already a column, ratio or formula name; choose a different key\.$/);
});

test('plans without formulas keep their exact shape and numbers', () => {
  const f = fixture();
  f.input.tiles.push({
    title: 'Totals',
    type: 'kpi',
    metrics: [{ field: 'spend', agg: 'sum' }],
    ratios: [{ key: 'cpc', label: 'CPC', numerator: 'spend', denominator: 'clicks' }],
  });
  const saved = f.save();
  assert.ok(f.plan(saved.id).tiles.every((tile) => !('formulas' in tile)));
  assert.deepEqual(f.run(saved.id).scorecards, [
    { label: 'Spend (EUR)', value: 60 },
    { label: 'CPC (EUR)', value: 0.75 },
  ]);
});

test('a dashboard with formulas refreshes again and again over its own output', () => {
  const f = fixture();
  f.input.tiles.push(
    { title: 'Totals', type: 'kpi', formulas: [PROFIT, NET_ROAS] },
    { title: 'Campaigns', type: 'table', groupBy: ['campaign'], formulas: [PROFIT, NET_ROAS], orderBy: { field: 'profit', direction: 'desc' } }
  );
  const saved = f.save();
  const ids = ['-d-source0', '-d-source1', '-charts', '-report'].map((suffix) => saved.id + suffix);
  const digests = () => ids.map((id) => f.readOutput(id).digest);
  const first = f.run(saved.id);
  const once = digests();
  const page = pageOf(f);
  const second = f.run(saved.id);
  // The same numbers write the same cells, so every receipt's digest is unchanged and the next
  // refresh owns its tabs again.
  assert.deepEqual(digests(), once);
  assert.deepEqual(pageOf(f), page);
  assert.deepEqual(second.scorecards, first.scorecards);
  assert.deepEqual(second.tiles, first.tiles);
  assert.equal(f.state.charts.length, 1, 'one chart, updated in place');
  f.setRows('two', [row('2026-08-04', 'C', 20, 45, 2, 40, 4)]);
  const third = f.run(saved.id);
  assert.deepEqual(third.scorecards, [
    { label: 'Profit (EUR)', value: 81 },
    { label: 'Net ROAS', value: 2.33333333333 },
  ]);
  assert.notDeepEqual(digests()[3], once[3]);
});

test('twelve tiles of ten formulas each fit the saved record and refresh', () => {
  const f = fixture();
  const formulas = (tile) =>
    [
      'revenue - spend - fees',
      'revenue / 1.05 / spend',
      'f0_' + tile + ' / revenue',
      '(revenue - spend) / (spend + fees)',
      'max(revenue - spend, 0)',
      'round(spend / clicks, 2)',
      'abs(f0_' + tile + ') / conversions',
      'min(spend, revenue) / clicks',
      'conversions / clicks',
      '(f0_' + tile + ' + fees) / spend * 100',
    ].map((expression, i) => {
      const formula = { key: 'f' + i + '_' + tile, label: 'Formula ' + i + ' of tile ' + tile, expression };
      if (i === 8) formula.percent = true;
      return formula;
    });
  f.input.tiles = Array.from({ length: 12 }, (_, i) =>
    i === 0
      ? { title: 'Tile ' + i, type: 'line', groupBy: ['date'], formulas: formulas(i) }
      : { title: 'Tile ' + i, type: 'table', groupBy: ['campaign'], formulas: formulas(i), orderBy: { field: 'f0_' + i, direction: 'desc' } }
  );
  const saved = f.save();
  assert.equal(f.plan(saved.id).tiles.length, 12);
  assert.deepEqual(f.plan(saved.id).tiles[11].formulas, formulas(11));
  const result = f.run(saved.id);
  assert.equal(result.tiles.length, 12);
  assert.deepEqual(result.tiles[11].preview[1].slice(0, 4), ['A', 57, 2.85714285714, 0.633333333333]);
});

test('settings export carries tile formulas and an import saves them through the validator', () => {
  const source = fixture();
  source.input.tiles.push({ title: 'Totals', type: 'kpi', formulas: [PROFIT, NET_ROAS] });
  source.input.lowerIsBetter = ['net_roas'];
  source.save();
  const bundle = JSON.parse(source.api.dmvExportSettings().json);
  assert.deepEqual(bundle.dashboards[0].tiles[1].formulas, [PROFIT, NET_ROAS]);
  assert.deepEqual(bundle.dashboards[0].lowerIsBetter, ['net_roas']);
  const target = fixture();
  const imported = plain(target.api.dmvImportCredentials(bundle));
  assert.deepEqual(imported.summary.dashboards, { saved: 1, existing: 0, failed: 0 });
  const id = target.api.dmvListDashboards()[0].id;
  assert.deepEqual(target.plan(id).tiles[1].formulas, [PROFIT, NET_ROAS]);
  assert.deepEqual(target.plan(id).lowerIsBetter, ['net_roas']);
  assert.deepEqual(target.run(id).scorecards, [
    { label: 'Profit (EUR)', value: 61 },
    { label: 'Net ROAS', value: 2.01587301587 },
  ]);
  // A file whose formula a save refuses fails that dashboard alone, with the reason.
  bundle.dashboards[0].tiles[1].formulas = [{ key: 'bad', expression: 'spend *' }];
  const broken = plain(fixture().api.dmvImportCredentials(bundle));
  assert.equal(broken.summary.dashboards.failed, 1);
  assert.match(JSON.stringify(broken), /Formula \\"bad\\": the expression ends early/);
});
