import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatamoovSandbox, plain } from './helpers/datamoov-sandbox.mjs';
import { chatSheetFixture } from './helpers/chat-sheet-fixture.mjs';

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
  const checked = f.api.DMV_CHAT_PIVOT.checkRows;
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

// A generated table of 30,000 rows × 9 columns, larger than undo keeps (50,000 cells). Its last
// column is "" on every row, as a formula's IF(…, "") gives.
const GENERATED_ROWS = 30000;
const GENERATED_HEADER = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7', 'h8', 'h9'];
const GENERATOR =
  '={' +
  GENERATED_HEADER.map((label) => '"' + label + '"').join(',') +
  ';MAKEARRAY(' +
  GENERATED_ROWS +
  ',9,LAMBDA(r,c,IF(c=9,"",r)))}';

function generatedFixture() {
  const table = [GENERATED_HEADER].concat(
    Array.from({ length: GENERATED_ROWS }, (_, r) =>
      GENERATED_HEADER.map((_, c) => (c === 8 ? '' : r + 1))
    )
  );
  return chatSheetFixture({
    setup: (g) => {
      g.sheet.maxRows = 1000;
      g.sheet.maxColumns = 26;
    },
    formulaResult: (text) => (text === GENERATOR ? table : undefined),
  });
}

test('an exact result larger than undo keeps still grows the tab, so Sheets shows it instead of #REF!', () => {
  const f = generatedFixture();
  const written = f.edit('set_formulas', { formulas: [[GENERATOR]] }, f.inspect('A1'));
  assert.equal(written.ok, true, JSON.stringify(written));
  assert.deepEqual(f.requests()[0], {
    appendDimension: { sheetId: f.sheet.id, dimension: 'ROWS', length: GENERATED_ROWS + 1 - 1000 },
  });
  assert.equal(f.sheet.maxRows, GENERATED_ROWS + 1);
  assert.equal(written.formulaErrors, undefined);
  assert.equal(written.spills[0].range, 'A1:I30001');
  assert.equal(f.value(f.sheet, GENERATED_ROWS + 1, 1), GENERATED_ROWS);
  // A size bound to a LET name is known too.
  assert.equal(
    f.edit('set_formulas', { formulas: [['=LET(n,40000,SEQUENCE(n))']] }, f.inspect('K1')).ok,
    true
  );
  assert.equal(f.sheet.maxRows, 40000);
  // Past the 200,000 rows create_sheet allows, the tab is left as it is.
  assert.equal(f.edit('set_formulas', { formulas: [['=SEQUENCE(300000)']] }, f.inspect('M1')).ok, true);
  assert.equal(
    f.requests().some((request) => request.appendDimension),
    false
  );
  assert.equal(f.sheet.maxRows, 40000);
  // On a tab that existed before this request, a freeze too large to undo still asks.
  const batches = f.state.batches.length;
  const asked = f.edit('copy_range', { destination: 'A1', pasteType: 'values' }, f.inspect('A1'));
  assert.equal(asked.needsConfirmation, true, JSON.stringify(asked));
  assert.match(asked.summary, /too large to undo/);
  assert.equal(f.state.batches.length, batches);
});

test('a tab this request made is frozen and formatted whole without asking, and undo says to delete it', () => {
  const f = generatedFixture();
  const created = f.tabAction('create_sheet', { newName: 'Generated', count: GENERATED_ROWS + 1 });
  assert.equal(created.ok, true);
  const tab = f.tab('Generated');
  const written = f.edit('set_formulas', { range: 'A1', formulas: [[GENERATOR]] }, created);
  assert.equal(written.ok, true, JSON.stringify(written));
  assert.equal(
    f.requests().some((request) => request.appendDimension),
    false,
    'the tab already has the rows'
  );
  const frozen = f.edit(
    'copy_range',
    { destination: 'A1', pasteType: 'values' },
    f.inspect('A1', 'Generated')
  );
  assert.equal(frozen.ok, true, JSON.stringify(frozen));
  assert.equal(frozen.needsConfirmation, undefined);
  assert.equal(frozen.range, 'A1:I30001');
  assert.equal(f.formula(tab, 1, 1), '');
  assert.equal(f.value(tab, GENERATED_ROWS + 1, 8), GENERATED_ROWS);
  // The "" of the last column stays blank, not stored as empty text, and the result says so.
  assert.equal(tab.cells.has('2:9'), false);
  assert.equal(tab.cells.has(GENERATED_ROWS + 1 + ':9'), false);
  assert.equal(f.value(tab, 1, 9), 'h9');
  assert.deepEqual(frozen.blankColumns, ['I2:I30001']);
  const formatted = f.tabAction('format', {
    sheetName: 'Generated',
    range: 'B2:C',
    format: { bold: true },
  });
  assert.equal(formatted.ok, true, JSON.stringify(formatted));
  assert.throws(() => f.undo(), /Delete the tab "Generated" to remove it\./);
});

// The cells of an A1 range such as 'Tab'!A2:I30001, as the sandbox recorded it.
function rangeCells(range) {
  const corners = /([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(range);
  const column = (letters) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
  const end = [corners[3] || corners[1], corners[4] || corners[2]];
  return (
    (Number(end[1]) - Number(corners[2]) + 1) * (column(end[0]) - column(corners[1]) + 1)
  );
}

test('a freeze too large to check its blanks keeps them as empty text and reads no effective values of the whole result', () => {
  const f = generatedFixture();
  const created = f.tabAction('create_sheet', { newName: 'Generated', count: GENERATED_ROWS + 1 });
  f.edit('set_formulas', { range: 'A1', formulas: [[GENERATOR]] }, created);
  const tab = f.tab('Generated');
  // The bound sits below this result's 270,009 cells, as 100,000 rows of 10 columns would.
  f.api.DMV_SHEET_ACTIONS.blankCells = 100000;
  const inspected = f.inspect('A1', 'Generated');
  const gets = f.state.gets.length;
  const frozen = f.edit('copy_range', { destination: 'A1', pasteType: 'values' }, inspected);
  assert.equal(frozen.ok, true, JSON.stringify(frozen));
  assert.equal(frozen.range, 'A1:I30001');
  assert.equal(f.value(tab, GENERATED_ROWS + 1, 8), GENERATED_ROWS);
  // Nothing is cleared: the "" of the last column stays as Sheets pasted it, and the result
  // says so instead of naming blank columns it did not check.
  assert.equal(tab.cells.has('2:9'), true);
  assert.equal(frozen.blankColumns, undefined);
  assert.match(frozen.note, /blank cells of the result were pasted as empty text/i);
  assert.equal(
    f.requests().some((request) => request.updateCells),
    false,
    JSON.stringify(f.requests().map((request) => Object.keys(request)[0]))
  );
  // Effective values are read for the formula's own lines (to size its result), never for the
  // whole 270,009 cells.
  let effective = 0;
  for (const get of f.state.gets.slice(gets))
    if (/\beffectiveValue\b/.test(get.options.fields || ''))
      for (const range of get.options.ranges || []) effective += rangeCells(range);
  assert.ok(effective < 2 * (GENERATED_ROWS + 1), effective + ' cells read with effective values');
});

test('a formula result larger than an inspection is frozen by its range, from the formulas of its first row', () => {
  const f = generatedFixture();
  const created = f.tabAction('create_sheet', { newName: 'Generated', count: GENERATED_ROWS + 1 });
  f.edit('set_formulas', { range: 'A1', formulas: [[GENERATOR]] }, created);
  const tab = f.tab('Generated');
  // No inspection takes 270,009 cells: a freeze of the formula's own result needs none.
  const frozen = f.tabAction('copy_range', {
    sheetName: 'Generated',
    range: 'A1:I30001',
    destination: 'A1:I30001',
    pasteType: 'values',
    editToken: created.editToken,
  });
  assert.equal(frozen.ok, true, JSON.stringify(frozen));
  assert.equal(frozen.range, 'A1:I30001');
  assert.equal(f.formula(tab, 1, 1), '');
  assert.equal(f.value(tab, GENERATED_ROWS + 1, 1), GENERATED_ROWS);
});
