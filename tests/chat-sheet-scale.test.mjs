import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatamoovSandbox, plain } from './helpers/datamoov-sandbox.mjs';

// A dashboard over a tab of 100,000 rows × 9 columns, built the way a spreadsheet user would:
// KPI formulas over whole columns, a QUERY summary, a helper tab of formulas for a Month column,
// pivots over the source and over that helper, a chart over the summary and a conditional format.
// No call reads every source cell: each stays within the cells it needs, counted by the sandbox.

const ROWS = 100000;
const HEADER = [
  'Transaction ID',
  'Date',
  'Store Location',
  'Department',
  'Product Name',
  'Quantity',
  'Unit Price',
  'Total Amount',
  'Payment Method',
];
const DEPARTMENTS = ['Electronics', 'Grocery', 'Apparel', 'Home & Garden', 'Health & Beauty'];
const STORES = ['Downtown', 'Riverside Mall', 'Northgate', 'Harbor Plaza'];
const PAYMENTS = ['Credit Card', 'Debit Card', 'Cash', 'Mobile Pay'];

const SUMMARY_FORMULA =
  "=QUERY(Sales!A:I,\"select D, count(A), sum(H) where A is not null group by D label count(A) 'Orders', sum(H) 'Revenue'\",1)";
const MONTH_FORMULA =
  '={"Month","Department","Total Amount";ARRAYFORMULA(TEXT(Sales!B2:B,"yyyy-mm")),Sales!D2:D,Sales!H2:H}';

function fixture() {
  const amount = (r) => Math.round((5 + (r % 97) * 3.25) * 100) / 100;
  const month = (r) => '2026-' + String(1 + (r % 12)).padStart(2, '0');
  // What Sheets computes for the formulas of this flow, as the sandbox does not calculate.
  const results = (formula) => {
    if (formula === SUMMARY_FORMULA)
      return [['Department', 'Orders', 'Revenue']].concat(
        DEPARTMENTS.map((name, index) => [name, ROWS / 5, 1000 + index])
      );
    if (formula === MONTH_FORMULA)
      return [['Month', 'Department', 'Total Amount']].concat(
        Array.from({ length: ROWS }, (_, r) => [month(r), DEPARTMENTS[r % 5], amount(r)])
      );
    if (/^=(SUMIFS|COUNTA|AVERAGEIFS|COUNTUNIQUE)\(/.test(formula)) return 5;
    return undefined;
  };
  const f = createDatamoovSandbox({ gridData: true, formulaResult: results });
  const sales = f.book.sheets[0];
  sales.name = 'Sales';
  sales.maxRows = ROWS + 1;
  sales.maxColumns = HEADER.length;
  HEADER.forEach((label, c) => f.setCell(sales, 1, c + 1, label));
  for (let r = 0; r < ROWS; r++) {
    const quantity = 1 + (r % 5);
    [
      'TXN-' + (100001 + r),
      new Date(Date.UTC(2026, r % 12, 1 + (r % 28), 10)),
      STORES[r % 4],
      DEPARTMENTS[r % 5],
      'Product ' + (r % 40),
      quantity,
      amount(r) / quantity,
      amount(r),
      PAYMENTS[r % 4],
    ].forEach((value, c) => f.setCell(sales, r + 2, c + 1, value));
  }
  f.book.setActiveSheet(sales);
  f.sales = sales;
  f.session = f.api.dmvChatSession_(f.book);
  // Runs one tool call and returns its result with the cells it read.
  f.measure = (call) => {
    const before = f.state.cellsRead;
    const result = plain(call());
    return { result, read: f.state.cellsRead - before };
  };
  f.inspect = (sheetName, range) =>
    f.measure(() => f.api.dmvChatInspectSheet_(f.session, { sheetName, range }));
  f.edit = (input) => f.measure(() => f.api.dmvChatEditSheet_(f.session, input));
  return f;
}

test('a dashboard over 100,000 rows reads only the cells each call needs', () => {
  const f = fixture();
  const all = (ROWS + 1) * HEADER.length;
  // The checks of a pivot read at most this many rows of a column they need.
  const checked = f.api.DMV_LIMITS.maxRows;
  const within = (step, read, most) => {
    assert.ok(read <= most, step + ' read ' + read + ' cells, more than ' + most);
    assert.ok(read < all, step + ' read every source cell');
  };

  // The active tab line of the system prompt: its size and header, not its rows.
  const active = f.measure(() => f.api.dmvChatActiveTabText_(f.session));
  assert.match(active.result[0], /data A1:I100001 \(100001 rows, 9 columns\)/);
  within('active tab', active.read, 10 * HEADER.length);

  within('inspect', f.inspect('Sales', 'A1:I5').read, 45);
  f.edit({ action: 'create_sheet', newName: 'Dashboard' });

  // KPI labels beside formulas over whole columns, then a QUERY summary of unknown size.
  const kpiRange = f.inspect('Dashboard', 'A1:B4');
  const kpis = f.edit({
    action: 'set_formulas',
    sheetName: 'Dashboard',
    range: 'A1:B4',
    editToken: kpiRange.result.editToken,
    formulas: [
      ['Revenue', '=SUMIFS(Sales!H:H,Sales!D:D,"<>")'],
      ['Orders', '=COUNTA(Sales!A2:A)'],
      ['Average order', '=AVERAGEIFS(Sales!H:H,Sales!F:F,">0")'],
      ['Departments', '=COUNTUNIQUE(Sales!D2:D)'],
    ],
  });
  assert.equal(kpis.result.ok, true);
  assert.equal(kpis.result.formulaErrors, undefined);
  within('KPI formulas', kpis.read, 3 * 8);
  const formatted = f.edit({
    action: 'format',
    sheetName: 'Dashboard',
    range: 'A1:B4',
    editToken: kpis.result.editToken,
    format: { bold: true },
  });
  within('format with the fresh token', formatted.read, 3 * 8);

  const summaryCell = f.inspect('Dashboard', 'D1');
  const summary = f.edit({
    action: 'set_formulas',
    sheetName: 'Dashboard',
    range: 'D1',
    editToken: summaryCell.result.editToken,
    formulas: [[SUMMARY_FORMULA]],
  });
  assert.deepEqual(
    summary.result.spills.map((spill) => spill.range),
    ['D1:F6']
  );
  // The read-back looks at a bounded window below and right of the formula.
  within('QUERY summary', summary.read, 3 * 21 * 9);

  // A chart over the summary, named by the headers it shows.
  const chart = f.measure(() =>
    f.api.dmvChatCreateChart_(f.session, {
      sheetName: 'Dashboard',
      range: 'D1:F6',
      chartType: 'bar',
      xColumn: 'Department',
      seriesColumns: ['Revenue'],
      anchorCell: 'H20',
    })
  );
  assert.equal(chart.result.ok, true);
  within('create_chart', chart.read, 3);

  // A money pivot over the whole source, on a new tab and placed on the dashboard.
  const pivot = {
    sourceSheet: 'Sales',
    sourceRange: 'A1:I100001',
    rows: [{ column: 4 }],
    values: [{ column: 8, summarize: 'SUM' }],
  };
  const newTab = f.measure(() =>
    f.api.dmvChatCreatePivot_(f.session, { ...pivot, targetSheet: 'Revenue by department' })
  );
  assert.equal(newTab.result.ok, true);
  // Its chartRange counts the departments on every row, reading that one column whole.
  assert.equal(newTab.result.chartRange, 'A1:B6');
  within('create_pivot on a new tab', newTab.read, HEADER.length + checked + ROWS);
  const placed = f.measure(() =>
    f.api.dmvChatCreatePivot_(f.session, {
      ...pivot,
      targetSheet: 'Dashboard',
      targetCell: 'H1',
      totals: true,
    })
  );
  assert.equal(placed.result.ok, true, JSON.stringify(placed.result));
  assert.equal(placed.result.chartRange, 'H1:I6');
  within('create_pivot on the dashboard', placed.read, HEADER.length + 2 * checked + 100 + ROWS);

  // A helper tab of formulas over the source adds a Month column; nothing is pasted as values.
  const helper = f.edit({ action: 'create_sheet', newName: 'Monthly', count: ROWS + 1 });
  assert.equal(helper.result.ok, true);
  assert.equal(f.tab('Monthly').maxRows, ROWS + 1);
  const helperCell = f.inspect('Monthly', 'A1');
  const months = f.edit({
    action: 'set_formulas',
    sheetName: 'Monthly',
    range: 'A1',
    editToken: helperCell.result.editToken,
    formulas: [[MONTH_FORMULA]],
  });
  assert.equal(months.result.ok, true);
  assert.equal(months.result.formulaErrors, undefined);
  assert.equal(f.formula(f.tab('Monthly'), 2, 1), '', 'the Month column is spilled, not pasted');
  within('helper tab formula', months.read, 3 * 21 * 9);
  const monthly = f.measure(() =>
    f.api.dmvChatCreatePivot_(f.session, {
      sourceSheet: 'Monthly',
      sourceRange: 'A1:C100001',
      targetSheet: 'Revenue by month',
      rows: [{ column: 1 }],
      columns: [{ column: 2 }],
      values: [{ column: 3, summarize: 'SUM' }],
    })
  );
  assert.equal(monthly.result.ok, true, JSON.stringify(monthly.result));
  within('create_pivot over the helper spill', monthly.read, 3 + 2 * checked);

  // A colour scale over the whole amount column reads no cells.
  const scale = f.measure(() =>
    f.api.dmvChatConditionalFormat_(f.session, {
      action: 'add',
      sheetName: 'Sales',
      range: 'H2:H100001',
      scale: { min: { type: 'min', color: '#FFFFFF' }, max: { type: 'max', color: '#1A73E8' } },
    })
  );
  assert.equal(scale.result.ok, true);
  within('conditional_format', scale.read, 0);

  // search_sheets refuses the whole tab before reading it, and a column stays within its cap.
  const before = f.state.cellsRead;
  assert.throws(
    () => f.api.dmvChatSearchSheets_(f.session, { query: 'TXN-100', sheetName: 'Sales' }),
    /one search reads at most 200000/
  );
  within('search_sheets over the tab', f.state.cellsRead - before, 0);
  const column = f.measure(() =>
    f.api.dmvChatSearchSheets_(f.session, {
      query: 'TXN-100001',
      sheetName: 'Sales',
      range: 'A1:A100001',
      wholeCell: true,
    })
  );
  assert.equal(column.result.total, 1);
  within('search_sheets over a column', column.read, ROWS + 1);
});
