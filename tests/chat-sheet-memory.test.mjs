import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatamoovSandbox, plain } from './helpers/datamoov-sandbox.mjs';

// A live request ran out of memory on Apps Script: "Create a new tab named Live check with 100000
// rows of generated sales ... Then freeze it to values." Apps Script holds far less than node, so
// no step may read cells in proportion to the tab: each step and the whole request stay within a
// fixed number of cells, counted by the sandbox, and no single read holds more than one band.

const ROWS = 100000;
const HEADER = ['Order ID', 'Order Date', 'Category', 'Region', 'Quantity', 'Unit Price', 'Amount'];
const KINDS = ['North', 'South', 'East', 'West'];
// The most cells one step may read, and the whole request.
const STEP_CELLS = 250000;
const REQUEST_CELLS = 100000;

const row = (r) => {
  const quantity = 1 + (r % 5),
    price = 10 + (r % 90);
  return ['ORD-' + String(r).padStart(6, '0'), 45658 + ((r * 7) % 365), KINDS[r % 4], KINDS[(r + 1) % 4], quantity, price, quantity * price];
};
// One generator for the whole table, header included: its size is in the formula.
const GENERATOR =
  '={"' +
  HEADER.join('","') +
  '";MAKEARRAY(100000,7,LAMBDA(r,c,CHOOSE(c,"ORD-"&TEXT(r,"000000"),DATE(2025,1,1)+MOD(r*7,365),INDEX({"North","South","East","West"},MOD(r,4)+1),INDEX({"North","South","East","West"},MOD(r+1,4)+1),MOD(r,5)+1,10+MOD(r,90),(MOD(r,5)+1)*(10+MOD(r,90)))))}';
// One formula per column below a header; the size of most is not in the formula (MOD, CHOOSE).
const COLUMNS = [
  '=ARRAYFORMULA("ORD-"&TEXT(SEQUENCE(100000),"000000"))',
  '=ARRAYFORMULA(DATE(2025,1,1)+MOD(SEQUENCE(100000)*7,365))',
  '=ARRAYFORMULA(CHOOSE(MOD(SEQUENCE(100000),4)+1,"North","South","East","West"))',
  '=ARRAYFORMULA(CHOOSE(MOD(SEQUENCE(100000)+1,4)+1,"North","South","East","West"))',
  '=ARRAYFORMULA(MOD(SEQUENCE(100000),5)+1)',
  '=ARRAYFORMULA(10+MOD(SEQUENCE(100000),90))',
  '=ARRAYFORMULA(E2:E100001*F2:F100001)',
];

// SEQUENCE(n,1,start) of other tests is computed too.
function fixture() {
  const f = createDatamoovSandbox({
    gridData: true,
    formulaResult: (formula) => {
      if (formula === GENERATOR) return [HEADER].concat(Array.from({ length: ROWS }, (_, r) => row(r + 1)));
      const column = COLUMNS.indexOf(formula);
      if (column >= 0) return Array.from({ length: ROWS }, (_, r) => [row(r + 1)[column]]);
      const sequence = /^=SEQUENCE\((\d+),1,(\d+)\)$/.exec(formula);
      return sequence ? Array.from({ length: Number(sequence[1]) }, (_, r) => [r + Number(sequence[2])]) : undefined;
    },
  });
  f.api.dmvSaveAiSettings({ provider: 'anthropic', apiKey: 'offline-memory-key', maxRows: 5000 });
  return f;
}

const tool = (id, input) => ({ type: 'tool_use', id, name: 'edit_sheet', input: { sheetName: 'Live check', ...input } });

// Runs the request with the model's calls in order and measures the cells each step read: the
// tools of one round, then the end of the request.
function request(f, calls) {
  const fetch = f.api.UrlFetchApp.fetch;
  const steps = [];
  const stages = calls.map((call, index) => [tool('t' + index, call)]).concat([[{ type: 'text', text: 'Done.' }]]);
  let index = 0,
    before = 0;
  const measure = (name) => {
    steps.push({ name, cells: f.state.cellsRead - before, largest: f.state.largestRead });
    before = f.state.cellsRead;
    f.state.largestRead = 0;
  };
  f.api.UrlFetchApp.fetch = (url, options) => {
    if (index) measure(calls[index - 1].action);
    else before = f.state.cellsRead;
    const content = stages[index++];
    f.state.responses.push({ body: { content, stop_reason: index < stages.length ? 'tool_use' : 'end_turn' } });
    return fetch(url, options);
  };
  try {
    const reply = plain(f.api.dmvChat({ text: 'Create a new tab named Live check with 100000 rows of generated data, then freeze it to values.', transcript: [] }));
    measure('end of the request');
    assert.equal(index, stages.length);
    return { reply, steps };
  } finally {
    f.api.UrlFetchApp.fetch = fetch;
  }
}

function assertBounded(f, steps) {
  const band = f.api.DMV_SHEET_SEARCH.requestCells;
  for (const step of steps) {
    assert.ok(step.cells <= STEP_CELLS, `${step.name} read ${step.cells} cells, more than ${STEP_CELLS}`);
    assert.ok(step.largest <= band, `${step.name} read ${step.largest} cells at once, more than ${band}`);
  }
  const total = steps.reduce((sum, step) => sum + step.cells, 0);
  assert.ok(total <= REQUEST_CELLS, `the request read ${total} cells, more than ${REQUEST_CELLS}`);
}

function assertFrozenTable(f, reply, top) {
  assert.equal(reply.failed, false, reply.text);
  const tab = f.tab('Live check');
  assert.equal(tab.maxRows, ROWS + 1);
  for (let column = 1; column <= 7; column++) {
    assert.equal(f.formula(tab, 1, column), '', 'no formula left in row 1');
    assert.equal(f.formula(tab, top, column), '', 'no formula left in row ' + top);
  }
  assert.equal(f.value(tab, 1, 2), 'Order Date');
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map((column) => f.value(tab, ROWS + 1, column)), row(ROWS));
  // The dates show as dates, not serial numbers.
  assert.equal(f.format(tab, 2, 2).numberFormat.type, 'DATE');
  assert.equal(f.format(tab, ROWS + 1, 2).numberFormat.type, 'DATE');
  for (const event of reply.events) assert.notEqual(event.kind, 'error', event.text);
}

test('100,000 generated rows from one formula are frozen and formatted within a fixed number of cells per step', () => {
  const f = fixture();
  const { reply, steps } = request(f, [
    { action: 'create_sheet', newName: 'Live check', count: ROWS + 1 },
    { action: 'set_formulas', range: 'A1', formulas: [[GENERATOR]] },
    { action: 'copy_range', range: 'A1:G100001', destination: 'A1', pasteType: 'values' },
    { action: 'format', range: 'B2:B100001', format: { numberFormat: 'date' } },
    { action: 'format', range: 'A1:G1', format: { bold: true, autoFit: true } },
    { action: 'freeze', frozenRows: 1 },
  ]);
  assertFrozenTable(f, reply, 2);
  assertBounded(f, steps);
});

test('100,000 rows from one formula per column, sizes the formulas do not tell, are frozen within the same bounds', () => {
  const f = fixture();
  const { reply, steps } = request(f, [
    { action: 'create_sheet', newName: 'Live check', count: ROWS + 1 },
    { action: 'set_values', range: 'A1:G1', values: [HEADER] },
    { action: 'set_formulas', range: 'A2:G2', formulas: [COLUMNS] },
    { action: 'copy_range', range: 'A2:G100001', destination: 'A2', pasteType: 'values' },
    { action: 'format', range: 'B2:B', format: { numberFormat: 'date' } },
    { action: 'freeze', frozenRows: 1 },
  ]);
  assertFrozenTable(f, reply, 2);
  assertBounded(f, steps);
});

test('a freeze given only the row of formulas whose sizes are unknown names the whole range instead of reading every cell', () => {
  const f = fixture();
  const session = f.api.dmvChatSession_(f.book);
  const edit = (input) => plain(f.api.dmvChatEditSheet_(session, { sheetName: 'Live check', ...input }));
  edit({ action: 'create_sheet', newName: 'Live check', count: ROWS + 1 });
  edit({ action: 'set_formulas', range: 'A2:G2', formulas: [COLUMNS] });
  const before = f.state.cellsRead,
    batches = f.state.batches.length;
  assert.throws(
    () => edit({ action: 'copy_range', range: 'A2:G2', destination: 'A2', pasteType: 'values' }),
    /Give the whole range of the results, A2:G100001: on a tab this request made it is frozen as given\./
  );
  assert.equal(f.state.batches.length, batches);
  assert.ok(f.state.cellsRead - before <= STEP_CELLS, String(f.state.cellsRead - before));
  const frozen = edit({ action: 'copy_range', range: 'A2:G100001', destination: 'A2', pasteType: 'values' });
  assert.equal(frozen.ok, true, JSON.stringify(frozen));
  assert.equal(f.formula(f.tab('Live check'), 2, 3), '');
});

test('on a tab the request found, a freeze too large to size from the sheet is refused before it reads the cells', () => {
  const f = fixture();
  const sheet = f.book.sheets[0];
  sheet.maxRows = ROWS + 1;
  sheet.maxColumns = 10;
  f.setCell(sheet, 1, 1, 'Order ID');
  const session = f.api.dmvChatSession_(f.book);
  const inspected = plain(f.api.dmvChatInspectSheet_(session, { sheetName: sheet.name, range: 'A2:G2' }));
  plain(f.api.dmvChatEditSheet_(session, { action: 'set_formulas', sheetName: sheet.name, range: 'A2:G2', editToken: inspected.editToken, formulas: [COLUMNS] }));
  const before = f.state.cellsRead,
    batches = f.state.batches.length;
  assert.throws(
    () =>
      f.api.dmvChatEditSheet_(session, { action: 'copy_range', sheetName: sheet.name, range: 'A2:G100001', destination: 'A2', pasteType: 'values' }),
    /would read more than 400000 cells, more than one edit reads\. Freeze fewer formulas at a time, or write them with an exact size/
  );
  assert.equal(f.state.batches.length, batches);
  assert.ok(f.state.cellsRead - before <= STEP_CELLS, String(f.state.cellsRead - before));
  // Two columns at a time fit, the first of exact size; there, too large to undo, it asks first.
  const asked = plain(
    f.api.dmvChatEditSheet_(session, { action: 'copy_range', sheetName: sheet.name, range: 'A2:B100001', destination: 'A2', pasteType: 'values' })
  );
  assert.equal(asked.needsConfirmation, true, JSON.stringify(asked));
  assert.match(asked.summary, /too large to undo/);
});

test('array results read before writing stay within one bound together, however many formulas the edit writes', () => {
  const f = fixture();
  const sheet = f.book.sheets[0];
  sheet.maxRows = 40000;
  const session = f.api.dmvChatSession_(f.book);
  const formulas = Array.from({ length: 7 }, (_, c) => '=SEQUENCE(40000,1,' + (c + 1) + ')');
  const inspected = plain(f.api.dmvChatInspectSheet_(session, { sheetName: sheet.name, range: 'A1:G1' }));
  const before = f.state.cellsRead;
  f.state.largestRead = 0;
  const written = plain(
    f.api.dmvChatEditSheet_(session, { action: 'set_formulas', sheetName: sheet.name, range: 'A1:G1', editToken: inspected.editToken, formulas: [formulas] })
  );
  assert.equal(written.ok, true, JSON.stringify(written).slice(0, 400));
  const read = f.state.cellsRead - before;
  assert.ok(read <= 4 * f.api.DMV_FORMULA.maxSpillCells, read + ' cells read');
  assert.ok(f.state.largestRead <= f.api.DMV_SHEET_SEARCH.requestCells, String(f.state.largestRead));
  // The results past the bound are left to Sheets and read back near their formulas, as said.
  assert.equal(written.spills.length, 5);
  assert.equal(written.spills[0].note, undefined);
  assert.match(written.spills[1].note, /only the cells near its formula were checked/);
});

test('an edit larger than an inspection on a tab the request made keeps no snapshot: undo says to delete the tab', () => {
  const f = fixture();
  const session = f.api.dmvChatSession_(f.book);
  const edit = (input) => plain(f.api.dmvChatEditSheet_(session, { sheetName: 'Live check', ...input }));
  edit({ action: 'create_sheet', newName: 'Live check', count: 5000 });
  edit({ action: 'set_values', range: 'A1:G1', values: [HEADER] });
  const before = f.state.cellsRead;
  const formatted = edit({ action: 'format', range: 'A1:G5000', format: { bold: true } });
  assert.equal(formatted.ok, true, JSON.stringify(formatted));
  assert.equal(f.state.cellsRead - before, 0);
  assert.throws(() => f.api.dmvChatUndoSheetEdit_(session, { action: 'undo' }), /Delete the tab "Live check" to remove it\./);
  // An edit within an inspection's size there keeps its undo.
  const small = edit({ action: 'set_values', range: 'A2:B2', values: [['x', 1]] });
  assert.match(small.undoId, /^u[a-f0-9]{12}$/);
});

test('a small array result after a large one in the same edit is still checked against the cells the edit writes', () => {
  const f = fixture();
  const sheet = f.book.sheets[0];
  sheet.maxRows = 50000;
  const session = f.api.dmvChatSession_(f.book);
  const inspected = plain(f.api.dmvChatInspectSheet_(session, { sheetName: sheet.name, range: 'A1:B2' }));
  const batches = f.state.batches.length;
  assert.throws(
    () =>
      f.api.dmvChatEditSheet_(session, {
        action: 'set_formulas',
        sheetName: sheet.name,
        range: 'A1:B2',
        editToken: inspected.editToken,
        formulas: [
          ['=SEQUENCE(49995,1,1)', '=SEQUENCE(10,1,1)'],
          ['', 'x'],
        ],
      }),
    /B1: the result fills B1:B10, which overlaps other cells this edit writes\. Sheets would show #REF!/
  );
  assert.equal(f.state.batches.length, batches);
});

test('one formula whose result size the sheet alone tells is frozen in place on a tab taller than one freeze reads', () => {
  const ROWS_TALL = 450000;
  const QUERY = '=QUERY(B1:B9,"select B where B > 0")';
  const f = createDatamoovSandbox({
    gridData: true,
    formulaResult: (formula) => (formula === QUERY ? [[1], [2], [3], [4], [5]] : undefined),
  });
  f.api.dmvSaveAiSettings({ provider: 'anthropic', apiKey: 'offline-memory-key', maxRows: 5000 });
  const sheet = f.book.sheets[0];
  sheet.maxRows = ROWS_TALL;
  sheet.maxColumns = 2;
  const session = f.api.dmvChatSession_(f.book);
  const first = plain(f.api.dmvChatInspectSheet_(session, { sheetName: sheet.name, range: 'A1' }));
  plain(f.api.dmvChatEditSheet_(session, { action: 'set_formulas', sheetName: sheet.name, range: 'A1', editToken: first.editToken, formulas: [[QUERY]] }));
  assert.equal(f.value(sheet, 5, 1), 5);
  const inspected = plain(f.api.dmvChatInspectSheet_(session, { sheetName: sheet.name, range: 'A1' }));
  f.state.largestRead = 0;
  const frozen = plain(
    f.api.dmvChatEditSheet_(session, { action: 'copy_range', sheetName: sheet.name, range: 'A1', destination: 'A1', pasteType: 'values', editToken: inspected.editToken })
  );
  assert.equal(frozen.ok, true, JSON.stringify(frozen));
  assert.equal(frozen.range, 'A1:A5');
  assert.equal(f.formula(sheet, 1, 1), '');
  assert.deepEqual([1, 2, 3, 4, 5].map((r) => f.value(sheet, r, 1)), [1, 2, 3, 4, 5]);
  assert.ok(f.state.largestRead <= f.api.DMV_SHEET_SEARCH.requestCells, String(f.state.largestRead));
});
