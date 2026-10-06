import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatamoovSandbox, plain } from './helpers/datamoov-sandbox.mjs';
import { exemptDashboardPages } from './helpers/dashboard-goldens.mjs';

exemptDashboardPages(
  'Dashboards over tabs of the spreadsheet did not exist before live formulas, so no golden can show them; each test checks its numbers against totals worked out from the rows it wrote.'
);

// Dashboards over data already in a tab: a dataset names the tab (sourceSheet) instead of a
// source query. The refresh reads the tab in place, writes no data tab of its own, and every
// number on the page is a formula over the user's tab, sized again on each refresh.

const REGIONS = ['North', 'South', 'East', 'West'];
const PRODUCTS = ['Alpha', 'Beta', 'Gamma'];
const HEADER = ['Order Date', 'Region', 'Product', 'Units', 'Revenue'];

const serial = (day) => (Date.parse(day + 'T00:00:00Z') - Date.UTC(1899, 11, 30)) / 86400000;
const dayOf = (start, offset) => new Date(Date.parse(start + 'T00:00:00Z') + offset * 86400000).toISOString().slice(0, 10);

// Row i: a day from start, a region, a product, units and revenue from its position.
function orderRows(count, start = '2026-08-01', days = 31) {
  return Array.from({ length: count }, (_, i) => ({
    date: dayOf(start, i % days),
    region: REGIONS[(i * 7) % 4],
    product: PRODUCTS[(i * 5) % 3],
    units: 1 + (i % 9),
    revenue: 10 + ((i * 37) % 200) + (i % 4) / 4,
  }));
}

// A tab of the user's: headers in row 1, dates as date cells, the rest as typed.
function writeOrders(f, sheet, rows, from = 0) {
  if (!from) HEADER.forEach((header, index) => f.setCell(sheet, 1, index + 1, header));
  rows.forEach((row, index) => {
    const r = from + index + 2;
    f.setCell(sheet, r, 1, serial(row.date));
    sheet.formats.set(r + ':1', { numberFormat: { type: 'DATE', pattern: 'yyyy-mm-dd' } });
    f.setCell(sheet, r, 2, row.region);
    f.setCell(sheet, r, 3, row.product);
    f.setCell(sheet, r, 4, row.units);
    f.setCell(sheet, r, 5, row.revenue);
  });
}

function fixture(rows = orderRows(30), name = 'Orders') {
  const f = createDatamoovSandbox();
  const sheet = f.book.insertSheet(name);
  sheet.maxRows = Math.max(sheet.maxRows, rows.length + 50);
  writeOrders(f, sheet, rows);
  f.orders = sheet;
  f.rows = rows;
  f.input = {
    name: 'Orders overview',
    target: { sheetName: 'Orders Dashboard' },
    datasets: [{ id: 'orders', label: 'Orders', sourceSheet: name }],
    tiles: [
      { title: 'Totals', type: 'kpi', metrics: [{ field: 'Revenue', agg: 'sum' }, { field: 'Units', agg: 'sum' }] },
      { title: 'Revenue by region', type: 'bar', groupBy: ['Region'], metrics: [{ field: 'Revenue', agg: 'sum' }] },
      { title: 'Weekly revenue', type: 'line', groupBy: ['Order Date'], dateBucket: 'week', metrics: [{ field: 'Revenue', agg: 'sum' }] },
      {
        title: 'Products',
        type: 'table',
        groupBy: ['Product'],
        metrics: [{ field: 'Revenue', agg: 'sum' }, { field: 'Units', agg: 'sum' }],
        orderBy: { field: 'revenue__sum', direction: 'desc' },
      },
    ],
  };
  f.save = (input = f.input) => plain(f.api.dmvSaveDashboard(input));
  f.run = (id) => plain(f.api.dmvRunDashboard(id));
  return f;
}

// Every cell of a tab as "row:column" -> value and formula, to tell a tab was left alone.
const snapshot = (sheet) => JSON.stringify([...sheet.cells.entries()].sort(), (key, value) => (value instanceof Map ? [...value] : value));

// The cell of a tab that shows text, as [row, column].
function where(f, sheet, text) {
  const found = [...sheet.cells.keys()]
    .map((key) => key.split(':').map(Number))
    .filter(([row, column]) => f.shown(sheet, row, column) === text)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])[0];
  assert.ok(found, 'nothing shows ' + text);
  return found;
}

const sum = (rows, field) => rows.reduce((total, row) => total + row[field], 0);
const close = (actual, expected, label) =>
  assert.ok(typeof actual === 'number' && Math.abs(actual - expected) <= 1e-6 * Math.max(1, Math.abs(expected)), `${label}: ${actual} is not ${expected}`);

// The scorecard value under a label (its first occurrence on the page).
function card(f, label) {
  const page = f.tab('Orders Dashboard');
  const [row, column] = where(f, page, label);
  return { value: f.shown(page, row + 1, column), formula: f.formula(page, row + 1, column), change: f.shown(page, row + 2, column) };
}

test('a dashboard over a 30-row tab reads the tab in place: formulas point at it, no data tab, the tab untouched', () => {
  const f = fixture();
  const before = snapshot(f.orders);
  const tabs = f.book.sheets.length;
  const saved = f.save();
  const result = f.run(saved.id);
  assert.equal(result.ok, true);
  assert.deepEqual(result.datasets.map((dataset) => [dataset.label, dataset.sheetName, dataset.rowCount]), [['Orders', 'Orders', 30]]);
  // The page and its hidden chart data are the only tabs it adds; none is a data tab.
  const added = f.state.books.get(f.book.id).sheets.map((sheet) => sheet.name).slice(tabs);
  assert.deepEqual(added.sort(), ['Orders Dashboard', 'Orders Dashboard (chart data)']);
  // The user's tab is exactly as it was: no rows written, no provenance, no receipt, no protection.
  assert.equal(snapshot(f.orders), before);
  assert.equal(f.readOutput(saved.id + '-d-orders'), null);
  assert.equal(f.orders.developerMetadata.length, 0);
  // Every number reads the user's tab directly, from row 2 to its last row.
  const revenue = card(f, 'Revenue');
  assert.match(revenue.formula, /'?Orders'?!\$E\$2:\$E\$31\b/);
  assert.doesNotMatch(revenue.formula, /\$E\$5:/);
  close(revenue.value, sum(f.rows, 'revenue'), 'revenue');
  close(card(f, 'Units').value, sum(f.rows, 'units'), 'units');
  // Live: a change in the user's tab moves the card.
  f.setCell(f.orders, 2, 5, f.rows[0].revenue + 100);
  close(card(f, 'Revenue').value, sum(f.rows, 'revenue') + 100, 'revenue after an edit');
  // Charts and highlights come from the same engine.
  assert.equal(result.chartCount, 2);
  assert.ok(result.highlights.length > 0, 'highlights');
  // Removing the dashboard removes its own tabs and never the user's.
  f.api.dmvDeleteDashboard(saved.id);
  assert.ok(f.tab('Orders'), 'the user tab stays');
  assert.equal(f.tab('Orders Dashboard'), null);
});

test('a refresh after the tab grows sizes every range again and covers the new rows', () => {
  const f = fixture();
  const saved = f.save();
  f.run(saved.id);
  const more = orderRows(12, '2026-08-05', 20);
  writeOrders(f, f.orders, more, 30);
  // Before the refresh the formulas still cover the 30 rows they were sized for.
  close(card(f, 'Revenue').value, sum(f.rows, 'revenue'), 'before refresh');
  const result = f.run(saved.id);
  assert.equal(result.datasets[0].rowCount, 42);
  const revenue = card(f, 'Revenue');
  assert.match(revenue.formula, /!\$E\$2:\$E\$43\b/);
  close(revenue.value, sum(f.rows.concat(more), 'revenue'), 'after refresh');
});

test('a tab dataset with a date column compares two periods of the same tab', () => {
  // July and August rows in one tab; each dataset keeps its own period.
  const rows = orderRows(62, '2026-07-01', 62);
  const f = fixture(rows);
  f.input.datasets = [
    { id: 'now', label: 'Orders August', sourceSheet: 'Orders', dateColumn: 'Order Date', dateRange: { preset: 'lastMonth' } },
    { id: 'before', label: 'Orders July', sourceSheet: 'Orders', dateColumn: 'Order Date', dateRange: { preset: 'previousMonth' } },
  ];
  f.input.tiles[0].compare = { current: 'now', previous: 'before' };
  f.input.tiles.slice(1).forEach((tile) => (tile.datasets = ['now']));
  const saved = f.save();
  const result = f.run(saved.id);
  const august = rows.filter((row) => row.date >= '2026-08-01'),
    july = rows.filter((row) => row.date < '2026-08-01');
  assert.deepEqual(result.datasets.map((dataset) => dataset.rowCount), [august.length, july.length]);
  const revenue = card(f, 'Revenue');
  close(revenue.value, sum(august, 'revenue'), 'August revenue');
  const delta = (sum(august, 'revenue') - sum(july, 'revenue')) / sum(july, 'revenue');
  assert.match(revenue.change, new RegExp('^[▲▼] ' + (Math.abs(delta) * 100).toFixed(1) + '% vs '));
  const scorecard = result.scorecards.find((item) => item.label === 'Revenue');
  close(scorecard.previous, sum(july, 'revenue'), 'July revenue');
  // The period is a condition of the formula over the whole tab.
  assert.match(revenue.formula, /\$A\$2:\$A\$63/);
});

test('a dashboard over a 100,000-row tab stays within limits, and a larger tab is refused with what to do', () => {
  const started = Date.now();
  const f = fixture(orderRows(100000));
  const saved = f.save({ ...f.input, tiles: f.input.tiles.slice(0, 2) });
  const result = f.run(saved.id);
  assert.equal(result.datasets[0].rowCount, 100000);
  for (const batch of f.state.batches) assert.ok(Buffer.byteLength(JSON.stringify(batch.body)) <= f.api.DMV_LIMITS.maxBytes);
  const revenue = card(f, 'Revenue');
  assert.match(revenue.formula, /!\$E\$2:\$E\$100001\b/);
  f.reading(() => close(card(f, 'Revenue').value, sum(f.rows, 'revenue'), 'revenue'));
  // One row more than a dataset may hold: refused, naming the tab and the limit, the page kept.
  const page = snapshot(f.tab('Orders Dashboard'));
  writeOrders(f, f.orders, orderRows(1), 100000);
  assert.throws(() => f.run(saved.id), /"Orders" has 100,001 data rows; a dashboard reads at most 100,000 rows of a tab\./);
  assert.equal(snapshot(f.tab('Orders Dashboard')), page);
  assert.ok(Date.now() - started < 60000, 'seconds, not minutes: ' + (Date.now() - started));
});

test('saving a tab dataset checks the tab, its headers and the columns the tiles name', () => {
  const f = fixture();
  const save = (patch, tiles) => () => f.save({ ...f.input, datasets: [{ ...f.input.datasets[0], ...patch }], ...(tiles ? { tiles } : {}) });
  assert.throws(save({ sourceSheet: 'Missing' }), /The tab "Missing" does not exist in this spreadsheet\. Tabs: .*Orders/);
  assert.throws(save({ sourceSheet: 'Orders Dashboard' }), /"Orders Dashboard" is written by this dashboard/);
  f.book.insertSheet('Empty');
  assert.throws(save({ sourceSheet: 'Empty' }), /The tab "Empty" needs its headers in row 1 and data below them\./);
  assert.throws(save({ connectionId: 'abc' }), /reads either a source query .* or a tab \(sourceSheet\), not both/);
  assert.throws(
    save({}, [{ title: 'By city', type: 'bar', groupBy: ['City'], metrics: [{ field: 'Revenue', agg: 'sum' }] }]),
    /"By city": unknown column "City"\. Columns of Orders: Order Date, Region, Product, Units, Revenue/
  );
  assert.throws(save({ dateRange: { preset: 'last30' }, dateColumn: 'Region' }), /dateColumn "Region" of Orders holds no dates/);
  // An unambiguous date column is taken without dateColumn.
  const saved = f.save({ ...f.input, datasets: [{ ...f.input.datasets[0], dateRange: { preset: 'lastMonth' } }] });
  const plan = plain(f.api.dmvUnpack_(f.api.dmvRead_('dashboard', saved.id).plan));
  assert.deepEqual(plan.datasets[0], { id: 'orders', label: 'Orders', sourceSheet: 'Orders', dateColumn: 'Order Date', dateRange: { preset: 'lastMonth' } });
  // A dataset without a query whose sheetName names a tab with data reads that tab.
  const named = f.save({ ...f.input, target: { sheetName: 'Second Dashboard' }, datasets: [{ id: 'orders', label: 'Orders', sheetName: 'Orders' }] });
  assert.equal(plain(f.api.dmvUnpack_(f.api.dmvRead_('dashboard', named.id).plan)).datasets[0].sourceSheet, 'Orders');
});

test('an update that leaves out a query dataset\'s query never reads that dataset\'s own data tab', () => {
  const f = fixture();
  const columns = [
    { key: 'date', label: 'Date', type: 'date' },
    { key: 'campaign', label: 'Campaign', type: 'text' },
    { key: 'spend', label: 'Spend', type: 'currency' },
  ];
  f.api.dmvRegisterConnector_({
    id: 'own_tab_fixture',
    label: 'Own tab fixture',
    category: 'Test',
    allowedHosts: [],
    authFields: [{ key: 'account', label: 'Account', type: 'text', required: true }],
    reports: [
      {
        id: 'daily',
        label: 'Daily',
        fields: columns,
        dateRange: true,
        configFields: [],
        fetch: () => ({
          columns,
          rows: Array.from({ length: 12 }, (_, i) => ({ date: dayOf('2026-08-20', i), campaign: 'C' + (i % 3), spend: 10 + i })),
          metadata: { complete: true, currency: 'EUR' },
        }),
      },
    ],
  });
  const connection = f.api.dmvSaveConnection({ connectorId: 'own_tab_fixture', label: 'Shop', credentials: { account: 'shop' } });
  const tiles = [
    { title: 'Totals', type: 'kpi', metrics: [{ field: 'spend', agg: 'sum' }] },
    { title: 'Spend by campaign', type: 'bar', groupBy: ['campaign'], metrics: [{ field: 'spend', agg: 'sum' }] },
  ];
  const input = {
    name: 'Spend overview',
    target: { sheetName: 'Spend Dashboard' },
    datasets: [
      {
        id: 'spend',
        label: 'Spend',
        connectionId: connection.id,
        reportType: 'daily',
        fields: ['date', 'campaign', 'spend'],
        dateRange: { preset: 'last30' },
        sheetName: 'Spend Data',
      },
    ],
    tiles,
  };
  const saved = f.save(input);
  f.run(saved.id);
  assert.ok(f.tab('Spend Data').getLastRow() > 1, 'the data tab was written');
  // The model sends the dataset back without its query: its sheetName is this dashboard's own
  // data tab, whose first rows are provenance, so it is not read as the user's data.
  assert.throws(
    () =>
      f.save({
        ...input,
        id: saved.id,
        revision: f.api.dmvRead_('dashboard', saved.id).revision,
        datasets: [{ id: 'spend', label: 'Spend', sheetName: 'Spend Data' }],
      }),
    /"Spend Data" is the data tab this dashboard writes for "Spend".*connectionId, reportType and fields/
  );
  const plan = plain(f.api.dmvUnpack_(f.api.dmvRead_('dashboard', saved.id).plan));
  assert.equal(plan.datasets[0].connectionId, connection.id, 'the saved plan is unchanged');
});

test('a tab dataset given the sheetName of a query dataset reads its tab and writes no tab of that name', () => {
  const f = fixture();
  // Only a query dataset gets a "<label> Data" tab of its own; a tab dataset reads its tab.
  const prompt = f.api.dmvChatSystemPrompt_(f.api.dmvChatSession_(f.book));
  const rule = prompt.split('\n').find((line) => line.startsWith('- Dashboard datasets'));
  assert.match(rule, /each query dataset with its own id, label and tab named "<label> Data"/);
  const saved = f.save({ ...f.input, datasets: [{ ...f.input.datasets[0], sheetName: 'Orders Data' }] });
  const plan = plain(f.api.dmvUnpack_(f.api.dmvRead_('dashboard', saved.id).plan));
  assert.deepEqual(plan.datasets[0], { id: 'orders', label: 'Orders', sourceSheet: 'Orders' });
  const run = f.run(saved.id);
  assert.deepEqual(run.datasets.map((dataset) => dataset.sheetName), ['Orders']);
  assert.equal(f.book.getSheetByName('Orders Data'), null);
});

test('another dashboard\'s output is not a tab dataset, but a saved report\'s tab is', () => {
  const f = fixture();
  const first = f.save();
  f.run(first.id);
  assert.throws(
    () => f.save({ ...f.input, target: { sheetName: 'Other Dashboard' }, datasets: [{ id: 'page', label: 'Page', sourceSheet: 'Orders Dashboard' }] }),
    /"Orders Dashboard" is output of the dashboard "Orders overview"/
  );
  // A saved report writes its header in row 1 and its rows below: a tab dataset reads it, and a
  // later run of the report (more rows) is covered by the next dashboard refresh.
  const columns = [
    { key: 'date', label: 'Date', type: 'date' },
    { key: 'campaign', label: 'Campaign', type: 'text' },
    { key: 'spend', label: 'Spend', type: 'currency' },
  ];
  let count = 20;
  f.api.dmvRegisterConnector_({
    id: 'report_fixture',
    label: 'Report fixture',
    category: 'Test',
    allowedHosts: [],
    authFields: [{ key: 'account', label: 'Account', type: 'text', required: true }],
    reports: [
      {
        id: 'daily',
        label: 'Daily',
        fields: columns,
        dateRange: true,
        configFields: [],
        fetch: () => ({
          columns,
          rows: Array.from({ length: count }, (_, i) => ({ date: dayOf('2026-08-20', i % 25), campaign: 'C' + (i % 3), spend: 10 + i })),
          metadata: { complete: true, currency: 'EUR' },
        }),
      },
    ],
  });
  const connection = f.api.dmvSaveConnection({ connectorId: 'report_fixture', label: 'Shop', credentials: { account: 'shop' } });
  const report = plain(
    f.api.dmvSaveReport({ name: 'Daily spend', connectionId: connection.id, reportType: 'daily', fields: ['date', 'campaign', 'spend'], dateRange: { preset: 'last30' }, target: { sheetName: 'Daily spend' } })
  );
  f.api.dmvRunReport(report.id);
  const input = {
    name: 'Spend overview',
    target: { sheetName: 'Spend Dashboard' },
    datasets: [{ id: 'spend', label: 'Daily spend', sourceSheet: 'Daily spend' }],
    tiles: [
      { title: 'Totals', type: 'kpi', metrics: [{ field: 'Spend', agg: 'sum' }] },
      { title: 'Spend by campaign', type: 'bar', groupBy: ['Campaign'], metrics: [{ field: 'Spend', agg: 'sum' }] },
    ],
  };
  const dashboard = f.save(input);
  const total = (n) => Array.from({ length: n }, (_, i) => 10 + i).reduce((a, b) => a + b, 0);
  assert.equal(f.run(dashboard.id).scorecards[0].value, total(20));
  count = 26;
  f.api.dmvRunReport(report.id);
  const again = f.run(dashboard.id);
  assert.equal(again.datasets[0].rowCount, 26);
  const page = f.tab('Spend Dashboard');
  const [row, column] = where(f, page, 'Spend');
  assert.equal(f.shown(page, row + 1, column), total(26));
});

test('a saved report re-run with more rows and new groups: the dashboard refresh sizes every range to the new last row and moves the table total', () => {
  // The order a scheduled refresh takes: the report runs again, then the dashboard over its tab.
  const f = fixture();
  const columns = [
    { key: 'date', label: 'Date', type: 'date' },
    { key: 'campaign', label: 'Campaign', type: 'text' },
    { key: 'spend', label: 'Spend', type: 'currency' },
    { key: 'clicks', label: 'Clicks', type: 'number' },
  ];
  // groups names: more rows bring groups the first run did not have, so the table grows.
  let count = 40,
    groups = 4;
  const rows = () => Array.from({ length: count }, (_, i) => ({ date: dayOf('2026-08-20', i % 25), campaign: 'G' + (i % groups), spend: 10 + i, clicks: 1 + (i % 7) }));
  f.api.dmvRegisterConnector_({
    id: 'growing_fixture',
    label: 'Growing fixture',
    category: 'Test',
    allowedHosts: [],
    authFields: [{ key: 'account', label: 'Account', type: 'text', required: true }],
    reports: [{ id: 'daily', label: 'Daily', fields: columns, dateRange: true, configFields: [], fetch: () => ({ columns, rows: rows(), metadata: { complete: true, currency: 'EUR' } }) }],
  });
  const connection = f.api.dmvSaveConnection({ connectorId: 'growing_fixture', label: 'Shop', credentials: { account: 'shop' } });
  const report = plain(
    f.api.dmvSaveReport({ name: 'Daily groups', connectionId: connection.id, reportType: 'daily', fields: ['date', 'campaign', 'spend', 'clicks'], dateRange: { preset: 'last30' }, target: { sheetName: 'Daily groups' } })
  );
  f.api.dmvRunReport(report.id);
  const sums = [{ field: 'Spend', agg: 'sum' }, { field: 'Clicks', agg: 'sum' }];
  const dashboard = f.save({
    name: 'Groups overview',
    target: { sheetName: 'Groups Dashboard' },
    datasets: [{ id: 'daily', label: 'Daily groups', sourceSheet: 'Daily groups' }],
    tiles: [
      { title: 'Totals', type: 'kpi', metrics: sums },
      { title: 'Weekly spend', type: 'line', groupBy: ['Date'], dateBucket: 'week', metrics: sums.slice(0, 1) },
      { title: 'Groups', type: 'table', groupBy: ['Campaign'], metrics: sums, orderBy: { field: 'spend__sum', direction: 'desc' } },
    ],
  });
  // The last row each range over the report tab ends at, on every tab the dashboard writes.
  const ends = () => {
    const found = new Set();
    for (const name of ['Groups Dashboard', 'Groups Dashboard (chart data)'])
      for (const entry of f.tab(name).cells.values())
        for (const match of String(entry.formula || '').matchAll(/'Daily groups'!\$?[A-Z]+\$?\d+:\$?[A-Z]+\$?(\d+)/g)) found.add(Number(match[1]));
    return [...found];
  };
  const totalRow = () => where(f, f.tab('Groups Dashboard'), 'Total')[0];
  const spend = (n) => Array.from({ length: n }, (_, i) => 10 + i).reduce((a, b) => a + b, 0);
  f.run(dashboard.id);
  assert.deepEqual(ends(), [41]);
  const before = totalRow();
  count = 60;
  groups = 7;
  f.api.dmvRunReport(report.id);
  assert.equal(f.tab('Daily groups').getLastRow(), 61);
  const again = f.run(dashboard.id);
  assert.equal(again.datasets[0].rowCount, 60);
  // No formula is left at the report's old last row: each one reads the tab to row 61.
  assert.deepEqual(ends(), [61]);
  // The table gained three groups, so its total row moved down and shows the new total.
  const page = f.tab('Groups Dashboard');
  const after = totalRow();
  assert.equal(after, before + 3);
  // The table's Spend header is the last "Spend" above its total row; the scorecard's the first.
  const labels = [...page.cells.keys()]
    .map((key) => key.split(':').map(Number))
    .filter(([row, column]) => row < after && f.shown(page, row, column) === 'Spend')
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const [cardRow, cardColumn] = labels[0],
    tableColumn = labels[labels.length - 1][1];
  close(f.shown(page, after, tableColumn), spend(60), 'the table total after the refresh');
  close(f.shown(page, cardRow + 1, cardColumn), spend(60), 'the scorecard after the refresh');
});

test('a compare naming a dataset the tile leaves out reads it, and plans that cannot work say how to fix them', () => {
  const f = fixture(orderRows(62, '2026-07-01', 62));
  const other = f.book.insertSheet('Returns');
  writeOrders(f, other, orderRows(5));
  const now = { id: 'now', label: 'Orders August', sourceSheet: 'Orders', dateRange: { preset: 'lastMonth' } };
  const before = { id: 'before', label: 'Orders July', sourceSheet: 'Orders', dateRange: { preset: 'previousMonth' } };
  const chart = { title: 'Revenue by region', type: 'bar', datasets: ['now'], groupBy: ['Region'], metrics: [{ field: 'Revenue', agg: 'sum' }] };
  const kpi = { title: 'Totals', type: 'kpi', datasets: ['now'], metrics: [{ field: 'Revenue', agg: 'sum' }], compare: { current: 'now', previous: 'before' } };
  const saved = f.save({ ...f.input, datasets: [now, before], tiles: [kpi, chart] });
  const plan = plain(f.api.dmvUnpack_(f.api.dmvRead_('dashboard', saved.id).plan));
  assert.deepEqual(plan.tiles[0].datasets, ['now', 'before']);
  close(f.run(saved.id).scorecards[0].previous, sum(f.rows.filter((row) => row.date < '2026-08-01'), 'revenue'), 'July revenue');
  // Two different tabs read together need a mapping; the error names the datasets and an example.
  assert.throws(
    () =>
      f.save({
        ...f.input,
        target: { sheetName: 'Two Dashboard' },
        datasets: [now, { id: 'returns', label: 'Returns', sourceSheet: 'Returns' }],
        tiles: [{ ...kpi, datasets: ['now', 'returns'], compare: undefined }, chart],
      }),
    /"Totals" reads several datasets, so each of them needs a mapping that gives their columns shared names; now, returns have none\. Add mapping to each of now, returns, for example \[\{field: "order_date", key: "order_date"\}/
  );
  // A compare on a chart says what to change on that chart.
  const compared = (tile) => () => f.save({ ...f.input, target: { sheetName: 'Three Dashboard' }, datasets: [now, before], tiles: [tile] });
  assert.throws(compared({ ...chart, compare: kpi.compare }), /not stacked\. Make it a table grouped by Region, or leave compare out\./);
  assert.throws(
    compared({ title: 'Trend', type: 'column', groupBy: ['Order Date'], stacked: true, metrics: [{ field: 'Revenue', agg: 'sum' }], compare: kpi.compare }),
    /not stacked\. Leave stacked out\./
  );
});

// A chat turn as the model would take it: no source selected, the data in a tab.
function scriptedTurn(f, stages, text) {
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
    return { reply: plain(f.api.dmvChat({ text, transcript: [] })), results };
  } finally {
    f.api.UrlFetchApp.fetch = fetch;
  }
}

test('chat builds a dashboard over a tab with list_dashboards, save_dashboard and run_dashboard, no source selected', () => {
  const f = fixture();
  f.api.dmvSaveAiSettings({ provider: 'anthropic', apiKey: 'offline-tab-dashboard-key', maxRows: 100 });
  const before = snapshot(f.orders);
  const tool = (id, name, input) => ({ type: 'tool_use', id, name, input });
  const { reply, results } = scriptedTurn(
    f,
    [
      (results, request) => {
        // The prompt routes a dashboard over tab data to the dashboard tools, with tab datasets.
        const rule = request.system.split('\n').find((line) => line.startsWith('- DASHBOARDS.'));
        assert.match(rule, /sourceSheet/);
        const save = request.tools.find((item) => item.name === 'save_dashboard');
        assert.deepEqual(save.input_schema.properties.datasets.items.required, ['id', 'label']);
        assert.ok(save.input_schema.properties.datasets.items.properties.sourceSheet);
        return [tool('list', 'list_dashboards', {})];
      },
      () => [tool('save', 'save_dashboard', f.input)],
      (results) => {
        assert.notEqual(results.get('save').is_error, true, JSON.stringify(results.get('save').value));
        return [tool('run', 'run_dashboard', { id: results.get('save').value.id })];
      },
      (results) => {
        assert.notEqual(results.get('run').is_error, true, JSON.stringify(results.get('run').value));
        return [{ type: 'text', text: 'The Orders Dashboard is ready.' }];
      },
    ],
    'Build a dashboard over the Orders tab.'
  );
  assert.ok(results.get('run'), JSON.stringify(reply).slice(0, 1500));
  assert.equal(results.get('run').value.datasets[0].rowCount, 30);
  assert.equal(snapshot(f.orders), before);
  assert.ok(f.tab('Orders Dashboard'));
  assert.ok(reply.events.some((event) => /^Read Orders · 30 rows from Orders$/.test(event.text)), JSON.stringify(reply.events));
});

test('chat reads a dataset with no query whose sheetName names a tab as that tab, and says how to name one', () => {
  const f = fixture();
  f.api.dmvSaveAiSettings({ provider: 'anthropic', apiKey: 'offline-tab-dashboard-key', maxRows: 100 });
  const tool = (id, name, input) => ({ type: 'tool_use', id, name, input });
  const dataset = (sheetName) => ({ id: 'orders', label: 'Orders', sheetName });
  const { results } = scriptedTurn(
    f,
    [
      () => [tool('missing', 'save_dashboard', { ...f.input, datasets: [dataset('Missing')] })],
      () => [tool('named', 'save_dashboard', { ...f.input, datasets: [dataset('Orders')] })],
      () => [{ type: 'text', text: 'Saved.' }],
    ],
    'Build a dashboard over the Orders tab.'
  );
  // Neither a source nor a tab: the refusal names sourceSheet, not the sources selected in Chat.
  const missing = results.get('missing').value.error;
  assert.match(missing, /sourceSheet/);
  assert.doesNotMatch(missing, /sources selected in Chat|no longer exists/);
  const named = results.get('named');
  assert.notEqual(named.is_error, true, JSON.stringify(named.value));
  const plan = plain(f.api.dmvUnpack_(f.api.dmvRead_('dashboard', named.value.id).plan));
  assert.equal(plan.datasets[0].sourceSheet, 'Orders');
});
