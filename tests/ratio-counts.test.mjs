import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatamoovSandbox, plain } from './helpers/datamoov-sandbox.mjs';
import { exemptDashboardPages } from './helpers/dashboard-goldens.mjs';

exemptDashboardPages(
  'Ratios over counts did not exist before, so no golden can show them; each test checks its numbers against totals worked out from the rows it wrote.'
);

// A ratio may divide by a count: <column>__count (filled values) or <column>__count_distinct
// (distinct values), so an amount per entity (revenue per customer, orders per account, cost per
// shipment) and a share of entities (repeat rate) are ratios like any other, in summarize, on a
// dashboard's scorecards and charts, and as live formulas on its page.

const HEADER = ['Order ID', 'Region', 'Customer', 'Total'];
const ROWS = Array.from({ length: 40 }, (_, i) => ({
  id: 'O-' + (i + 1),
  region: i % 3 ? 'North' : 'South',
  customer: 'C-' + ((i * i) % 11),
  total: 10 + i,
}));

function fixture() {
  const f = createDatamoovSandbox();
  const sheet = f.book.insertSheet('Orders');
  sheet.maxRows = 100;
  HEADER.forEach((header, index) => f.setCell(sheet, 1, index + 1, header));
  ROWS.forEach((row, index) => {
    [row.id, row.region, row.customer, row.total].forEach((value, column) =>
      f.setCell(sheet, index + 2, column + 1, value)
    );
  });
  f.orders = sheet;
  return f;
}

const distinct = (rows) => new Set(rows.map((row) => row.customer)).size;
const total = (rows) => rows.reduce((sum, row) => sum + row.total, 0);
const close = (actual, expected, label) =>
  assert.ok(
    typeof actual === 'number' && Math.abs(actual - expected) <= 1e-4 * Math.max(1, Math.abs(expected)),
    `${label}: ${actual} is not ${expected}`
  );

test('summarize divides by a count or a distinct count of a column, and says how when a text column is named', () => {
  const f = fixture();
  const session = f.api.dmvChatSession_(f.book);
  const read = f.api.dmvChatReadSheet_(session, { sheetName: 'Orders' });
  const ratios = [
    { key: 'per_customer', numerator: 'Total', denominator: 'Customer__count_distinct' },
    { key: 'orders_per_customer', numerator: 'order_id__count', denominator: 'customer__count_distinct' },
  ];
  const overall = plain(f.api.dmvChatSummarize_(session, { resultId: read.resultId, ratios }));
  close(overall.rows[0].per_customer, total(ROWS) / distinct(ROWS), 'revenue per customer');
  close(overall.rows[0].orders_per_customer, ROWS.length / distinct(ROWS), 'orders per customer');
  // The counts a ratio needs stay hidden, as its sums do.
  assert.deepEqual(overall.columns.map((column) => column.key), ['per_customer', 'orders_per_customer']);
  assert.equal(overall.columns[0].type, 'number');
  const byRegion = plain(
    f.api.dmvChatSummarize_(session, { resultId: read.resultId, groupBy: ['Region'], ratios })
  );
  for (const row of byRegion.rows) {
    const rows = ROWS.filter((item) => item.region === row.region);
    close(row.per_customer, total(rows) / distinct(rows), 'per customer in ' + row.region);
  }
  // A text column named alone is still refused, and the error says how to divide by its count.
  assert.throws(
    () =>
      f.api.dmvChatSummarize_(session, {
        resultId: read.resultId,
        ratios: [{ key: 'bad', numerator: 'Total', denominator: 'Customer' }],
      }),
    /denominator "customer" must be a summable column; to divide by its number of distinct values, name it customer__count_distinct \(customer__count counts its filled rows\)/
  );
  // A column that is itself named like a count is that column, summed.
  const counted = plain(
    f.api.dmvChatSummarize_(session, {
      resultId: read.resultId,
      groupBy: ['Region'],
      metrics: [
        { field: 'Total', agg: 'sum' },
        { field: 'Order ID', agg: 'count' },
      ],
    })
  );
  const again = plain(
    f.api.dmvChatSummarize_(session, {
      resultId: counted.resultId,
      ratios: [{ key: 'avg_order', numerator: 'total__sum', denominator: 'order_id__count' }],
    })
  );
  close(again.rows[0].avg_order, total(ROWS) / ROWS.length, 'average order over a summary');
});

test('a dashboard over a tab shows amounts per entity and shares of entities as live ratios over counts', () => {
  const f = fixture();
  const saved = plain(
    f.api.dmvSaveDashboard({
      name: 'Customers',
      target: { sheetName: 'Customer Dashboard' },
      datasets: [{ id: 'orders', label: 'Orders', sourceSheet: 'Orders' }],
      tiles: [
        {
          title: 'Totals',
          type: 'kpi',
          metrics: [{ field: 'Total', agg: 'sum' }],
          ratios: [
            { key: 'per_customer', label: 'Revenue per customer', numerator: 'Total', denominator: 'Customer__count_distinct' },
            { key: 'orders_each', label: 'Orders per customer', numerator: 'Order ID__count', denominator: 'Customer__count_distinct' },
          ],
        },
        {
          title: 'Revenue per customer by region',
          type: 'bar',
          groupBy: ['Region'],
          ratios: [{ key: 'per_customer', numerator: 'Total', denominator: 'Customer__count_distinct' }],
        },
      ],
    })
  );
  const result = plain(f.api.dmvRunDashboard(saved.id));
  assert.equal(result.ok, true, JSON.stringify(result));
  const cards = Object.fromEntries(result.scorecards.map((card) => [card.label, card.value]));
  close(cards['Revenue per customer'], total(ROWS) / distinct(ROWS), 'scorecard');
  close(cards['Orders per customer'], ROWS.length / distinct(ROWS), 'orders scorecard');
  // The page cell is a formula over the tab that counts distinct customers, and follows the tab.
  const page = f.tab('Customer Dashboard');
  const cell = [...page.cells.keys()]
    .map((key) => key.split(':').map(Number))
    .find(([row, column]) => f.shown(page, row, column) === 'Revenue per customer');
  assert.ok(cell, 'the scorecard label is on the page');
  const [row, column] = cell;
  assert.match(f.formula(page, row + 1, column), /COUNTUNIQUE/);
  close(f.shown(page, row + 1, column), total(ROWS) / distinct(ROWS), 'live scorecard');
  f.setCell(f.orders, 2, 3, 'C-new');
  const changed = ROWS.map((item, index) => (index === 0 ? { ...item, customer: 'C-new' } : item));
  close(f.shown(page, row + 1, column), total(changed) / distinct(changed), 'live after an edit');
});

test('a compared chart over dates divides by a count of each day, and refuses a distinct count as it refuses the metric', () => {
  const f = createDatamoovSandbox();
  const sheet = f.book.insertSheet('Orders');
  ['Order Date', 'Customer', 'Total'].forEach((header, index) => f.setCell(sheet, 1, index + 1, header));
  for (let i = 0; i < 20; i++) {
    f.setCell(sheet, i + 2, 1, new Date(Date.UTC(2026, 8, 1 + i)));
    f.setCell(sheet, i + 2, 2, 'C-' + (i % 4));
    f.setCell(sheet, i + 2, 3, 5 + i);
  }
  const plan = (denominator) => ({
    name: 'Compared',
    target: { sheetName: 'Compared Dashboard' },
    datasets: [
      { id: 'now', label: 'This period', sourceSheet: 'Orders', dateColumn: 'Order Date', dateRange: { preset: 'custom', startDate: '2026-09-11', endDate: '2026-09-20' } },
      { id: 'before', label: 'Before', sourceSheet: 'Orders', dateColumn: 'Order Date', dateRange: { preset: 'custom', startDate: '2026-09-01', endDate: '2026-09-10' } },
    ],
    tiles: [
      {
        title: 'Per customer by day',
        type: 'line',
        groupBy: ['Order Date'],
        dateBucket: 'day',
        ratios: [{ key: 'per_customer', numerator: 'Total', denominator }],
        compare: { current: ['now'], previous: ['before'] },
      },
    ],
  });
  assert.throws(
    () => f.api.dmvSaveDashboard(plan('Customer__count_distinct')),
    /a compared chart adds days up into buckets, so its metrics use sum, avg, min, max or count/
  );
  // A count adds up over days: the compared chart divides each day's total by its orders.
  const saved = plain(f.api.dmvSaveDashboard(plan('Customer__count')));
  const result = plain(f.api.dmvRunDashboard(saved.id));
  assert.equal(result.ok, true, JSON.stringify(result));
  const line = result.tiles.find((tile) => tile.title === 'Per customer by day');
  // One order a day: each day's ratio is that day's total.
  const values = line.preview.slice(1).map((row) => row[row.length - 1]);
  assert.ok(values.length > 0, JSON.stringify(line));
  assert.ok(
    values.every((value) => typeof value === 'number' && value >= 5 && value <= 24),
    JSON.stringify(line.preview)
  );
});

test('a compared chart over two periods of one report, unmapped, refuses a distinct count side at save as it refuses the metric', () => {
  const f = createDatamoovSandbox();
  const columns = [
    { key: 'date', type: 'date' },
    { key: 'campaign', type: 'text' },
    { key: 'spend', type: 'currency' },
  ];
  f.api.dmvRegisterConnector_({
    id: 'ratio_source',
    label: 'Ratio source',
    category: 'Test',
    allowedHosts: ['ratio.example'],
    authFields: [{ key: 'token', label: 'Token', type: 'password', required: true }],
    reports: [
      {
        id: 'daily',
        label: 'Daily',
        fields: columns,
        dateRange: true,
        configFields: [],
        fetch(ctx) {
          const month = ctx.startDate.slice(0, 7);
          return {
            columns,
            rows: [1, 2, 3].map((day) => ({ date: month + '-0' + day, campaign: 'K-' + (day % 2), spend: day * 10 })),
            metadata: { complete: true, currency: 'EUR' },
          };
        },
      },
    ],
  });
  const connection = f.api.dmvSaveConnection({ connectorId: 'ratio_source', label: 'Ads', credentials: { token: 'private-ratio-token' } });
  // The usual previous-period setup: one report read for two periods, with no mapping.
  const period = (id, preset) => ({
    id,
    label: id,
    sheetName: id + ' data',
    connectionId: connection.id,
    reportType: 'daily',
    fields: columns.map((column) => column.key),
    config: {},
    dateRange: { preset },
    maxRows: 100,
  });
  const plan = (tile) => ({
    name: 'Periods',
    target: { sheetName: 'Periods report' },
    datasets: [period('now', 'lastMonth'), period('before', 'previousMonth')],
    tiles: [{ title: 'Spend per campaign', type: 'column', groupBy: ['date'], compare: { current: ['now'], previous: ['before'] }, ...tile }],
  });
  const distinctSide = plan({ ratios: [{ key: 'per_campaign', numerator: 'spend', denominator: 'campaign__count_distinct' }] });
  const distinctMetric = plan({ metrics: [{ field: 'campaign', agg: 'count_distinct' }] });
  for (const input of [distinctMetric, distinctSide])
    assert.throws(
      () => f.api.dmvSaveDashboard(input),
      /"Spend per campaign": a compared chart adds days up into buckets, so its metrics use sum, avg, min, max or count/
    );
  // A count adds up over days, so it saves and refreshes.
  const saved = plain(f.api.dmvSaveDashboard(plan({ ratios: [{ key: 'per_row', numerator: 'spend', denominator: 'campaign__count' }] })));
  const result = plain(f.api.dmvRunDashboard(saved.id));
  assert.equal(result.ok, true, JSON.stringify(result));
});
