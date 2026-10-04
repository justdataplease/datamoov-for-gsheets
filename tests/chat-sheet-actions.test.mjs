import test from 'node:test';
import assert from 'node:assert/strict';
import { plain } from './helpers/datamoov-sandbox.mjs';
import { assertPortable, chatSheetFixture } from './helpers/chat-sheet-fixture.mjs';

// The analyst edit_sheet actions of src/dmv_chat_sheet_actions.js: copy and move, rows and
// columns, cleanup, validation, notes and links, named ranges and tab operations. Each runs
// through the shared pipeline, so every one is checked for its request, its caps, the inspection
// token, protected report output, confirmation and undo. The sandbox answers spreadsheets.get
// like the Sheets API (gridData), so inspections, undo snapshots and read-backs see real cells.

const BOLD = { textFormat: { bold: true } };
const LIST = {
  condition: { type: 'ONE_OF_LIST', values: [{ userEnteredValue: 'a' }] },
  showCustomUi: true,
};
const ACTIONS = [
  'copy_range',
  'move_range',
  'insert_rows',
  'insert_columns',
  'delete_rows',
  'delete_columns',
  'group_rows',
  'group_columns',
  'ungroup_rows',
  'ungroup_columns',
  'find_replace',
  'remove_duplicates',
  'highlight_duplicates',
  'trim_whitespace',
  'split_columns',
  'data_validation',
  'set_notes',
  'set_links',
  'named_range',
  'duplicate_sheet',
  'delete_sheet',
  'hide_sheet',
  'show_sheet',
];

function fixture() {
  const f = chatSheetFixture({
    orchard: {
      rows: [
        { date: '2026-08-01', campaign: 'Brand', spend: 10.5, clicks: 100 },
        { date: '2026-08-02', campaign: 'Generic', spend: 5, clicks: 20 },
      ],
      token: 'actions-private-token',
    },
  });
  f.report = () => f.saveReport().report;
  return f;
}

// Row, column, move and tab edits keep no undo: they ask first, and undo answers with this.
const NO_UNDO = 'Chat cannot undo this; File > Version history can restore it.';
const noUndo = (text) =>
  new RegExp(
    '^Error: Chat cannot undo "' + text + '"\\. File > Version history can restore it\\.$'
  );

// A row, column or tab action, asked first and done on the user's yes.
const confirmed = (f, action, input) =>
  f.confirm((session, extra) => f.tabAction(action, { ...input, ...extra }, session)).done;

const gridOf = (sheet, startRowIndex, endRowIndex, startColumnIndex, endColumnIndex) => ({
  sheetId: sheet.id,
  startRowIndex,
  endRowIndex,
  startColumnIndex,
  endColumnIndex,
});

test('edit_sheet lists every analyst action after the built-in ones, with portable fields', () => {
  const f = fixture();
  const tools = f.api.dmvChatTools_(f.session);
  const edit = plain(tools.find((tool) => tool.name === 'edit_sheet').input_schema);
  assert.deepEqual(edit.properties.action.enum.slice(0, 8), [
    'set_values',
    'set_formulas',
    'format',
    'sort',
    'filter',
    'freeze',
    'create_sheet',
    'rename_sheet',
  ]);
  for (const action of ACTIONS) assert.ok(edit.properties.action.enum.includes(action), action);
  assert.deepEqual(plain(f.api.dmvChatSheetActionSchema_().actions), ACTIONS);
  assert.deepEqual(edit.required, ['action']);
  assert.ok(!edit.properties.requests, 'no raw request passthrough');
  assertPortable(edit, 'edit_sheet');
  // Built-in fields keep their meaning; every field an action takes is in the schema.
  assert.equal(edit.properties.values.type, 'array');
  assert.equal(edit.properties.headerRows.maximum, 1);
  const actions = f.api.dmvChatSheetActions_();
  for (const [name, spec] of Object.entries(actions))
    for (const field of spec.fields || [])
      assert.ok(Object.hasOwn(edit.properties, field), name + ' takes ' + field);
  // Unknown or inherited names are still refused.
  for (const action of ['delete_spreadsheet', 'toString', 'hasOwnProperty'])
    assert.throws(
      () => f.api.dmvChatEditSheet_(f.session, { action }),
      /^Error: Choose a supported sheet action\.$/
    );
  // No request leaves for anywhere but the Sheets service.
  assert.equal(f.state.http.length, 0);
});

test('copy_range copies values, formats and notes to another tab, and undo clears them again', () => {
  const f = fixture();
  const summary = f.book.insertSheet('Summary tab');
  f.setCell(f.sheet, 1, 1, 'Name');
  f.sheet.formats.set('1:1', BOLD);
  f.setCell(f.sheet, 2, 1, 'Ann');
  f.setMeta(f.sheet, 2, 1, { note: 'first' });
  f.setCell(f.sheet, 2, 2, 5);
  const before = f.cellState(summary, 3, 3, 2, 2);
  const result = f.edit('copy_range', { destination: "'Summary tab'!C3" });
  assert.equal(result.ok, true);
  assert.equal(result.sheetName, 'Summary tab');
  assert.equal(result.range, 'C3:D4');
  assert.equal(result.from, 'Output!A1:B2');
  assert.match(result.url, new RegExp('#gid=' + summary.id + '&range=C3%3AD4$'));
  assert.match(result.undoId, /^u[a-f0-9]{12}$/);
  assert.deepEqual(f.requests(), [
    {
      copyPaste: {
        source: gridOf(f.sheet, 0, 2, 0, 2),
        destination: gridOf(summary, 2, 4, 2, 4),
        pasteType: 'PASTE_NORMAL',
        pasteOrientation: 'NORMAL',
      },
    },
  ]);
  assert.equal(f.value(summary, 3, 3), 'Name');
  assert.deepEqual(f.format(summary, 3, 3), BOLD);
  assert.equal(f.meta(summary, 4, 3).note, 'first');
  assert.equal(f.value(summary, 4, 4), 5);
  assert.equal(f.session.events.at(-1).text, 'Copied Output!A1:B2 to Summary tab!C3:D4');
  f.undo();
  assert.deepEqual(f.cellState(summary, 3, 3, 2, 2), before);
  // Values only, on the same tab; a destination range of the same size is accepted too.
  const values = f.edit('copy_range', { destination: 'E1:F2', pasteType: 'values' });
  assert.equal(values.range, 'E1:F2');
  assert.equal(f.requests()[0].copyPaste.pasteType, 'PASTE_VALUES');
  assert.equal(f.value(f.sheet, 1, 5), 'Name');
  assert.deepEqual(f.format(f.sheet, 1, 5), {});
  assert.equal(values.note, undefined);
});

test('copy_range values onto the source itself keeps the date format its formulas showed', () => {
  const f = fixture();
  // Sheets shows a formula's date result as a date without a format on the cell, and pasting
  // values keeps only the number, so a frozen date would read as its serial number (46043).
  f.setCell(f.sheet, 1, 1, 'Day');
  f.setCell(f.sheet, 1, 2, 'Units');
  f.setCell(f.sheet, 2, 1, new Date('2026-01-21T12:00:00Z'), '=DATE(2026,1,21)');
  f.setCell(f.sheet, 2, 2, 4, '=2+2');
  f.setCell(f.sheet, 3, 1, new Date('2026-01-28T12:00:00Z'), '=DATE(2026,1,28)');
  f.setCell(f.sheet, 3, 2, 5, '=2+3');
  const frozen = f.edit('copy_range', { destination: 'A1', pasteType: 'values' }, f.inspect('A1:B3'));
  assert.equal(frozen.ok, true, JSON.stringify(frozen));
  assert.deepEqual(f.requests(), [
    {
      copyPaste: {
        source: gridOf(f.sheet, 0, 3, 0, 2),
        destination: gridOf(f.sheet, 0, 3, 0, 2),
        pasteType: 'PASTE_VALUES',
        pasteOrientation: 'NORMAL',
      },
    },
    {
      repeatCell: {
        range: gridOf(f.sheet, 0, 3, 0, 1),
        cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'yyyy-mm-dd' } } },
        fields: 'userEnteredFormat.numberFormat',
      },
    },
  ]);
  assert.equal(f.formula(f.sheet, 2, 1), '');
  assert.deepEqual(f.format(f.sheet, 2, 1).numberFormat, { type: 'DATE', pattern: 'yyyy-mm-dd' });
  assert.equal(f.format(f.sheet, 2, 2).numberFormat, undefined);
  assert.equal(frozen.note, undefined);
});

test('copy_range refuses bad destinations, needs its inspection and asks before replacing many cells', () => {
  const f = fixture();
  f.book.insertSheet('Summary');
  f.setCell(f.sheet, 1, 1, 'x');
  for (const [extra, message] of [
    [{}, /Give the destination's top-left cell/],
    [{ destination: 'C3', pasteType: 'everything' }, /Choose pasteType all, values, formats/],
    [{ destination: 'Missing!A1' }, /No tab named "Missing"/],
    [{ destination: 'Z1' }, /runs past the grid of tab "Output"\. Insert rows or columns/],
    [{ destination: 'C3:C9' }, /top-left cell, or as a range the same size/],
    [{ destination: 'A1' }, /The destination is the source itself/],
    [{ destination: 'C3:B2' }, /from its top-left to its bottom-right/],
    [{ destination: '=A1' }, /must be an A1 cell or range/],
  ])
    assert.throws(() => f.edit('copy_range', extra), message, JSON.stringify(extra));
  assert.throws(
    () =>
      f.api.dmvChatEditSheet_(f.session, {
        action: 'copy_range',
        sheetName: 'Output',
        range: 'A1:B2',
        destination: 'C3',
      }),
    /^Error: Inspect the target range before editing it\.$/
  );
  const inspected = f.inspect();
  f.setCell(f.sheet, 2, 2, 'changed');
  assert.throws(
    () => f.edit('copy_range', { destination: 'C3' }, inspected),
    /inspected cells or sheet settings changed/
  );
  assert.throws(() => f.edit('copy_range', { destination: 'C3', extra: 1 }), /documented fields/);
  assert.equal(f.state.batches.length, 0);
  // Replacing more than 200 non-empty cells waits for the user's yes.
  const summary = f.tab('Summary');
  for (let row = 1; row <= 21; row++)
    for (let column = 1; column <= 10; column++) {
      f.setCell(f.sheet, row, column, 'new');
      f.setCell(summary, row, column, 'old');
    }
  const inspectedWide = f.inspect('A1:J21');
  const call = (session, extra) =>
    f.edit('copy_range', { destination: 'Summary!A1', ...extra }, inspectedWide, session);
  const { asked, done } = f.confirm(call);
  assert.equal(asked.summary, 'This replaces 210 non-empty cells.');
  assert.equal(done.ok, true);
  assert.equal(f.value(summary, 21, 10), 'new');
  f.undo();
  assert.equal(f.value(summary, 21, 10), 'old');
});

test('move_range moves cells with the formulas that point at them', () => {
  const f = fixture();
  const other = f.book.insertSheet('Other');
  f.column(f.sheet, 1, ['a', 'b']);
  f.sheet.formats.set('1:1', BOLD);
  f.setCell(f.sheet, 1, 3, 'kept');
  f.setCell(other, 1, 1, 'a', '=Output!A1');
  const move = (destination, range) => (session, extra) =>
    f.edit('move_range', { destination, ...extra }, f.inspect(range, 'Output', session), session);
  const result = f.confirm(move('D1', 'A1:A2')).done;
  assert.equal(result.ok, true);
  assert.equal(result.range, 'D1:D2');
  assert.deepEqual(f.requests(), [
    {
      cutPaste: {
        source: gridOf(f.sheet, 0, 2, 0, 1),
        destination: { sheetId: f.sheet.id, rowIndex: 0, columnIndex: 3 },
        pasteType: 'PASTE_NORMAL',
      },
    },
  ]);
  assert.equal(f.value(f.sheet, 1, 1), '');
  assert.equal(f.value(f.sheet, 2, 4), 'b');
  assert.deepEqual(f.format(f.sheet, 1, 4), BOLD);
  assert.equal(f.formula(other, 1, 1), '=Output!D1', 'references follow the moved cells');
  // The question names many filled cells moved over; the source's own cells do not count.
  for (let row = 1; row <= 21; row++)
    for (let column = 1; column <= 21; column++) f.setCell(f.sheet, row, column, row);
  const many = /replaces \d+ non-empty cells/;
  assert.match(f.confirm(move('L1', 'A1:J21')).asked.summary, many);
  const over = f.confirm(move('B1', 'A1:J21'));
  assert.doesNotMatch(over.asked.summary, many, 'only the 21 cells of column K are outside');
  assert.equal(over.done.ok, true);
  const near = f.confirm(move('A2', 'A1:J1'));
  assert.doesNotMatch(near.asked.summary, many, 'ten cells over its own row are not many');
});

test('insert_rows and insert_columns add space and stay clear of report output', () => {
  const f = fixture();
  f.column(f.sheet, 1, ['h', 'a', 'b']);
  const { done: rows, session } = f.confirm((yes, extra) =>
    f.tabAction('insert_rows', { sheetName: 'Output', start: 2, count: 2, ...extra }, yes)
  );
  assert.equal(rows.ok, true);
  assert.equal(rows.inserted, 2);
  assert.equal(rows.at, 'rows 2-3');
  assert.deepEqual(f.requests(), [
    {
      insertDimension: {
        range: { sheetId: f.sheet.id, dimension: 'ROWS', startIndex: 1, endIndex: 3 },
        inheritFromBefore: false,
      },
    },
  ]);
  assert.equal(f.sheet.maxRows, 102);
  assert.equal(f.value(f.sheet, 4, 1), 'a');
  assert.equal(session.events.at(-1).text, 'Inserted 2 rows before row 2 in Output');
  // Columns, appended at the end: they take the format of the last column.
  const columns = confirmed(f, 'insert_columns', { sheetName: 'Output', start: 27, count: 3 });
  assert.equal(columns.at, 'columns AA-AC');
  assert.equal(f.requests()[0].insertDimension.inheritFromBefore, true);
  assert.equal(f.sheet.maxColumns, 29);
  for (const [extra, message] of [
    [{ start: 2, count: 501 }, /count must be between 1 and 500/],
    [{ start: 0 }, /start must be between 1 and 103/],
    [{ start: 104 }, /start must be between 1 and 103/],
    [{ start: 2.5 }, /start must be an integer number/],
    [{ count: 2 }, /Give start/],
  ])
    assert.throws(
      () => f.tabAction('insert_rows', { sheetName: 'Output', ...extra }),
      message,
      JSON.stringify(extra)
    );
  assert.throws(
    () => f.tabAction('insert_rows', { sheetName: 'Output', start: 2, rows: 1 }),
    /documented fields/
  );
});

test('tab and row or column actions ignore an inspected range and editToken, and name fields they do not take', () => {
  const f = fixture();
  f.book.insertSheet('Notes');
  f.book.insertSheet('Old Q2');
  const inspected = f.inspect('A1:B5');
  // What the prompt says to pass for an existing sheet: the inspected sheetName, range and token.
  const asInspected = (action, extra, sheetName = 'Output') =>
    f.tabAction(action, {
      sheetName,
      range: inspected.range,
      editToken: inspected.editToken,
      ...extra,
    });
  assert.equal(asInspected('insert_rows', { start: 2, count: 1 }).needsConfirmation, true);
  assert.equal(asInspected('group_rows', { start: 2, count: 1 }).needsConfirmation, true);
  assert.equal(asInspected('delete_rows', { start: 2, count: 1 }).needsConfirmation, true);
  assert.equal(asInspected('hide_sheet', {}, 'Notes').ok, true);
  assert.equal(
    asInspected('duplicate_sheet', { newName: 'Notes copy' }, 'Notes').needsConfirmation,
    true
  );
  assert.equal(asInspected('delete_sheet', {}, 'Old Q2').needsConfirmation, true);
  // A yes to the delete covers the call with or without the ignored fields.
  const yes = f.answer('Yes');
  assert.equal(
    plain(f.api.dmvChatEditSheet_(yes, { action: 'delete_sheet', sheetName: 'Old Q2' })).ok,
    true
  );
  // A field no action takes is named, with the ones this action does take.
  assert.throws(
    () => asInspected('insert_rows', { start: 2, rows: 1 }),
    /Not allowed here: rows\. Allowed: action, sheetName, confirmToken, start, count\./
  );
});

test('insert and delete never move or remove saved report output', () => {
  const f = fixture();
  const report = f.report();
  const before = f.state.batches.length;
  const refusal = /would touch the output of the saved report "Daily" on tab "Output"/;
  // The report fills A1:D3: inserting at row 3 or column D would move it.
  for (const [action, start] of [
    ['insert_rows', 3],
    ['insert_columns', 4],
    ['delete_rows', 1],
    ['delete_columns', 4],
  ])
    assert.throws(
      () => f.tabAction(action, { sheetName: 'Output', start, count: 1 }),
      refusal,
      action
    );
  assert.equal(f.state.batches.length, before);
  assert.equal(confirmed(f, 'insert_rows', { sheetName: 'Output', start: 4 }).ok, true);
  assert.equal(confirmed(f, 'insert_columns', { sheetName: 'Output', start: 5 }).ok, true);
  assert.equal(f.api.dmvRunReport(report.id).ok, true, 'the report still refreshes');
});

test('delete_rows and delete_columns ask first', () => {
  const f = fixture();
  f.column(f.sheet, 1, ['h', 'a', 'b', 'c', 'd']);
  const call = (session, extra) =>
    f.tabAction('delete_rows', { sheetName: 'Output', start: 2, count: 2, ...extra }, session);
  const { asked, done } = f.confirm(call);
  assert.equal(
    asked.summary,
    'Delete rows 2-3 of tab "Output", with everything in them? Formulas elsewhere that point at them will show #REF!. ' +
      NO_UNDO
  );
  assert.equal(done.ok, true);
  assert.equal(done.at, 'rows 2-3');
  assert.deepEqual(f.requests(), [
    {
      deleteDimension: {
        range: { sheetId: f.sheet.id, dimension: 'ROWS', startIndex: 1, endIndex: 3 },
      },
    },
  ]);
  assert.equal(f.sheet.maxRows, 98);
  assert.equal(f.value(f.sheet, 2, 1), 'c');
  const columns = (session, extra) =>
    f.tabAction('delete_columns', { sheetName: 'Output', start: 2, ...extra }, session);
  const deleted = f.confirm(columns).done;
  assert.equal(deleted.at, 'column B');
  assert.equal(f.sheet.maxColumns, 25);
  // Caps: at most 500, inside the grid, never every row.
  for (const [extra, message] of [
    [{ start: 1, count: 501 }, /count must be between 1 and 500/],
    [{ start: 97, count: 5 }, /has 98 rows; choose a smaller count/],
    [{ start: 99 }, /start must be between 1 and 98/],
  ])
    assert.throws(() => f.tabAction('delete_rows', { sheetName: 'Output', ...extra }), message);
  const tiny = f.book.insertSheet('Tiny');
  tiny.maxRows = 3;
  assert.throws(
    () => f.tabAction('delete_rows', { sheetName: 'Tiny', start: 1, count: 3 }),
    /must keep at least one row/
  );
});

test('group and ungroup rows or columns', () => {
  const f = fixture();
  const grouped = confirmed(f, 'group_rows', { sheetName: 'Output', start: 2, count: 3 });
  assert.equal(grouped.grouped, 'rows 2-4');
  assert.deepEqual(f.requests(), [
    {
      addDimensionGroup: {
        range: { sheetId: f.sheet.id, dimension: 'ROWS', startIndex: 1, endIndex: 4 },
      },
    },
  ]);
  assert.deepEqual(f.groups(f.sheet), [
    { range: { sheetId: f.sheet.id, dimension: 'ROWS', startIndex: 1, endIndex: 4 }, depth: 1 },
  ]);
  assert.throws(
    () => f.tabAction('ungroup_rows', { sheetName: 'Output', start: 6, count: 3 }),
    /Not all of rows 6-8 are grouped/
  );
  confirmed(f, 'group_columns', { sheetName: 'Output', start: 1, count: 2 });
  const ungrouped = confirmed(f, 'ungroup_columns', { sheetName: 'Output', start: 1, count: 2 });
  assert.equal(ungrouped.ungrouped, 'columns A-B');
  assert.deepEqual(f.groups(f.sheet, 'COLUMNS'), []);
  // Groups are not limited to 500, only to the grid; they nest at most eight deep.
  assert.equal(confirmed(f, 'group_rows', { sheetName: 'Output', start: 1, count: 100 }).ok, true);
  for (let level = 3; level <= 8; level++)
    confirmed(f, 'group_rows', { sheetName: 'Output', start: 3, count: 2 });
  assert.throws(
    () => f.tabAction('group_rows', { sheetName: 'Output', start: 3, count: 1 }),
    /nest at most 8 levels/
  );
});

test('find_replace changes matching text in the inspected range and never makes a formula', () => {
  const f = fixture();
  f.column(f.sheet, 1, ['Brand x', 'brand y', 'Other', 'Brand']);
  f.setCell(f.sheet, 1, 2, 5);
  const before = f.cellState(f.sheet, 1, 1, 4, 2);
  const result = f.edit(
    'find_replace',
    { find: 'brand', replacement: 'Label' },
    f.inspect('A1:B4')
  );
  assert.equal(result.ok, true);
  assert.equal(result.cellsChanged, 3);
  assert.equal(result.occurrencesChanged, 3);
  assert.deepEqual(f.requests(), [
    {
      findReplace: {
        find: 'brand',
        replacement: 'Label',
        matchCase: false,
        matchEntireCell: false,
        searchByRegex: false,
        includeFormulas: false,
        range: gridOf(f.sheet, 0, 4, 0, 2),
      },
    },
  ]);
  assert.equal(f.value(f.sheet, 2, 1), 'Label y');
  f.undo();
  assert.deepEqual(f.cellState(f.sheet, 1, 1, 4, 2), before);
  const exact = f.edit(
    'find_replace',
    { find: 'Brand', replacement: 'B', matchCase: true, matchEntireCell: true },
    f.inspect('A1:B4')
  );
  assert.equal(exact.cellsChanged, 1);
  assert.equal(f.value(f.sheet, 1, 1), 'Brand x');
  assert.equal(f.value(f.sheet, 4, 1), 'B');
  const regex = f.edit(
    'find_replace',
    { find: '^(\\w+) y$', replacement: '$1-why', useRegex: true },
    f.inspect('A1:B4')
  );
  assert.equal(regex.cellsChanged, 1);
  assert.equal(f.value(f.sheet, 2, 1), 'brand-why');
  for (const [extra, message] of [
    [{ find: '' }, /find must be text of 1 to 500/],
    [{ find: 'x', replacement: 5 }, /replacement must be text/],
    [{ find: 'x', matchCase: 'yes' }, /matchCase must be true or false/],
    [{ find: 'zzz' }, /Nothing in Output!A1:B4 matches "zzz"/],
    [{ find: '(a+)+', useRegex: true }, /without a repeated group that repeats/],
    [{ find: '(?<=a)b', useRegex: true }, /no back-references or lookarounds/],
    [{ find: '(a)\\1', useRegex: true }, /no back-references or lookarounds/],
    [{ find: '[', useRegex: true }, /not valid/],
    [{ find: 'a*', useRegex: true }, /must not match an empty cell/],
  ])
    assert.throws(
      () => f.edit('find_replace', extra, f.inspect('A1:B4')),
      message,
      JSON.stringify(extra)
    );
  // Text that Sheets would read as a formula is refused, before anything is written.
  const batches = f.state.batches.length;
  f.setCell(f.sheet, 5, 1, 'xIMPORTXML("https://elsewhere.example","//a")');
  f.setCell(f.sheet, 6, 1, '=1+1');
  for (const [find, replacement, cell] of [
    ['x', '=', 'A5'],
    ['x', '+', 'A5'],
    ['1', '2', 'A6'],
  ])
    assert.throws(
      () => f.edit('find_replace', { find, replacement }, f.inspect(cell)),
      new RegExp('turn Output!' + cell + ' into text starting with')
    );
  assert.equal(f.state.batches.length, batches);
  f.setCell(f.sheet, 7, 1, '5x');
  assert.equal(
    f.edit('find_replace', { find: 'x', replacement: '' }, f.inspect('A7')).ok,
    true,
    'a number is fine'
  );
});

test('find_replace over a whole tab, or over many cells, asks first', () => {
  const f = fixture();
  for (let row = 1; row <= 300; row++) f.setCell(f.sheet, row, 1, row % 2 ? 'old' : 'keep');
  f.sheet.maxRows = 300;
  const anchor = f.inspect('A1:A2');
  const call = (session, extra) =>
    f.edit(
      'find_replace',
      { find: 'old', replacement: 'new', wholeSheet: true, ...extra },
      anchor,
      session
    );
  const { asked, done } = f.confirm(call);
  assert.equal(
    asked.summary,
    'Replace 150 matches of "old" with "new" in 150 cells of Output!A1:A300 (the whole tab).'
  );
  assert.equal(done.cellsChanged, 150);
  assert.equal(done.range, 'A1:A300');
  assert.deepEqual(f.requests()[0].findReplace.range, gridOf(f.sheet, 0, 300, 0, 1));
  assert.equal(f.value(f.sheet, 299, 1), 'new');
  f.undo();
  assert.equal(f.value(f.sheet, 299, 1), 'old');
  // More than 200 changed cells in an inspected range asks too.
  for (let row = 1; row <= 21; row++)
    for (let column = 1; column <= 10; column++) f.setCell(f.sheet, row, column, 'old');
  assert.equal(
    f.edit('find_replace', { find: 'old', replacement: 'new' }, f.inspect('A1:J21'))
      .needsConfirmation,
    true
  );
  // A tab whose data passes 50,000 cells is refused whole.
  f.setCell(f.sheet, 300, 200, 'far');
  f.sheet.maxColumns = 200;
  assert.throws(
    () => f.edit('find_replace', { find: 'old', wholeSheet: true }, f.inspect('A1')),
    /spans more than 50,000 cells/
  );
});

test('remove_duplicates keeps the first or the last of each key, asks first and undoes', () => {
  const f = fixture();
  const rows = [
    ['Email', 'Name'],
    ['a@x.com', 'Ann'],
    ['b@x.com', 'Bob'],
    ['a@x.com', 'Ann again'],
    ['c@x.com', 'Cy'],
    ['b@x.com', 'Bob again'],
  ];
  rows.forEach((row, r) => row.forEach((value, c) => f.setCell(f.sheet, r + 1, c + 1, value)));
  f.sheet.formats.set('6:2', BOLD);
  const before = f.cellState(f.sheet, 1, 1, 6, 2);
  const inspected = f.inspect('A1:B6');
  const call = (session, extra) =>
    f.edit('remove_duplicates', { keyColumns: [1], ...extra }, inspected, session);
  const { asked, done } = f.confirm(call);
  assert.equal(
    asked.summary,
    'Remove 2 duplicate rows from Output!A2:B6, compared on column A, keeping the first of each? Rows below move up inside the range.'
  );
  assert.equal(done.removed, 2);
  assert.equal(done.kept, 3);
  assert.deepEqual(f.requests(), [
    {
      deleteDuplicates: {
        range: gridOf(f.sheet, 1, 6, 0, 2),
        comparisonColumns: [
          { sheetId: f.sheet.id, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 },
        ],
      },
    },
  ]);
  assert.deepEqual(
    [2, 3, 4, 5].map((row) => f.value(f.sheet, row, 2)),
    ['Ann', 'Bob', 'Cy', '']
  );
  f.undo();
  assert.deepEqual(f.cellState(f.sheet, 1, 1, 6, 2), before);
  // Keeping the last: the kept rows move up with their formats; the rest is cleared.
  const last = (session, extra) =>
    f.edit(
      'remove_duplicates',
      { keyColumns: [1], keep: 'last', ...extra },
      f.inspect('A1:B6', 'Output', session),
      session
    );
  const kept = f.confirm(last).done;
  assert.equal(kept.removed, 2);
  assert.deepEqual(
    [2, 3, 4, 5, 6].map((row) => f.value(f.sheet, row, 2)),
    ['Ann again', 'Cy', 'Bob again', '', '']
  );
  assert.deepEqual(f.format(f.sheet, 4, 2), BOLD);
  assert.deepEqual(f.format(f.sheet, 6, 2), {});
  assert.equal(
    f.requests()[0].updateCells.fields,
    'userEnteredValue,userEnteredFormat,note,dataValidation,textFormatRuns,chipRuns'
  );
  f.undo();
  assert.deepEqual(f.cellState(f.sheet, 1, 1, 6, 2), before);
  for (const [extra, message] of [
    [{ keep: 'middle' }, /Choose keep first or last/],
    [{ keyColumns: [3] }, /Key column must be between 1 and 2/],
    [{ keyColumns: [] }, /keyColumns lists one-based columns/],
    [{ keyColumns: [2] }, /No duplicate rows in Output!A2:B6 compared on B/],
    [{ headerRows: 2 }, /Header rows must be between 0 and 1/],
  ])
    assert.throws(
      () => f.edit('remove_duplicates', extra, f.inspect('A1:B6')),
      message,
      JSON.stringify(extra)
    );
  f.setCell(f.sheet, 7, 1, 'x', '=A2');
  assert.throws(
    () => f.edit('remove_duplicates', { keep: 'last', keyColumns: [1] }, f.inspect('A1:B7')),
    /keep last works on ranges without formulas/
  );
});

test('highlight_duplicates adds one live rule, allowed over report output, and undo removes it', () => {
  const f = fixture();
  f.column(f.sheet, 3, ['Email', 'a', 'b', 'a', '*', '>5']);
  const result = f.edit('highlight_duplicates', {}, f.inspect('C1:C6'));
  assert.equal(result.ok, true);
  assert.equal(result.range, 'C2:C6');
  const rule = {
    ranges: [gridOf(f.sheet, 1, 6, 2, 3)],
    booleanRule: {
      condition: {
        type: 'CUSTOM_FORMULA',
        values: [
          {
            userEnteredValue:
              '=AND(IFERROR(LEN($C2)>0,FALSE),SUMPRODUCT(IFERROR(($C$2:$C$6=$C2)*1,0))>1)',
          },
        ],
      },
      format: {
        backgroundColorStyle: {
          rgbColor: { red: 0xf4 / 255, green: 0xcc / 255, blue: 0xcc / 255 },
        },
      },
    },
  };
  assert.deepEqual(f.requests(), [{ addConditionalFormatRule: { rule, index: 0 } }]);
  assert.deepEqual(f.conditionalFormats(f.sheet), [rule]);
  f.undo();
  assert.deepEqual(f.conditionalFormats(f.sheet), []);
  const pair = f.edit(
    'highlight_duplicates',
    { keyColumns: [1, 2], headerRows: 0, color: '#FF0000' },
    f.inspect('A1:B4')
  );
  assert.equal(
    pair.rule,
    '=AND(IFERROR(LEN($A1&$B1)>0,FALSE),SUMPRODUCT(IFERROR(($A$1:$A$4=$A1)*1,0)*IFERROR(($B$1:$B$4=$B1)*1,0))>1)'
  );
  assert.throws(
    () => f.edit('highlight_duplicates', { color: 'red' }, f.inspect('C1:C6')),
    /#RRGGBB/
  );
  // A rule changes no cells, like formatting, so report output can be highlighted.
  const g = fixture();
  g.report();
  assert.equal(g.edit('highlight_duplicates', { keyColumns: [2] }, g.inspect('A1:D3')).ok, true);
});

test('remove_ and highlight_duplicates take a whole table larger than one inspection', () => {
  const f = fixture();
  // 300 rows of 10 columns, more than one inspection holds; each email repeats every 120 rows,
  // so most repeats lie further apart than an inspected range reaches.
  f.sheet.maxRows = 400;
  for (let column = 1; column <= 10; column++) f.setCell(f.sheet, 1, column, 'H' + column);
  for (let row = 2; row <= 301; row++) {
    f.setCell(f.sheet, row, 1, 'u' + ((row - 2) % 120) + '@x.com');
    for (let column = 2; column <= 10; column++)
      f.setCell(f.sheet, row, column, `v${row}_${column}`);
  }
  assert.throws(() => f.inspect('A1:J301'), /at most 1,000 cells/);
  const before = f.cellState(f.sheet, 1, 1, 301, 10);
  const anchor = f.inspect('A1:J5');
  const reads = f.state.gets.length;
  const call = (session, extra) =>
    f.edit('remove_duplicates', { keyColumns: [1], wholeSheet: true, ...extra }, anchor, session);
  const { asked, done } = f.confirm(call);
  assert.equal(
    asked.summary,
    'Remove 180 duplicate rows from Output!A2:J301 (the whole tab), compared on column A, keeping the first of each? Rows below move up inside the range.'
  );
  // The duplicate scan reads the key column only; undo keeps the whole table.
  const scan = f.state.gets
    .slice(reads)
    .find((get) => JSON.stringify(get.options.ranges) === `["'Output'!A2:A301"]`);
  assert.match(scan.options.fields, /values\(userEnteredValue,effectiveValue\)/);
  assert.deepEqual(f.requests(), [
    {
      deleteDuplicates: {
        range: gridOf(f.sheet, 1, 301, 0, 10),
        comparisonColumns: [
          { sheetId: f.sheet.id, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 },
        ],
      },
    },
  ]);
  assert.equal(done.removed, 180);
  assert.equal(done.kept, 120);
  assert.equal(done.range, 'A2:J301');
  // The kept rows close up for the whole table: no blank rows are left between them.
  assert.deepEqual(
    [2, 121, 122, 301].map((row) => [f.value(f.sheet, row, 1), f.value(f.sheet, row, 2)]),
    [
      ['u0@x.com', 'v2_2'],
      ['u119@x.com', 'v121_2'],
      ['', ''],
      ['', ''],
    ]
  );
  f.undo();
  assert.deepEqual(f.cellState(f.sheet, 1, 1, 301, 10), before);
  // Keeping the last rewrites the table with the last row of each key moved up.
  const last = (session, extra) =>
    f.edit(
      'remove_duplicates',
      { keyColumns: [1], keep: 'last', wholeSheet: true, ...extra },
      f.inspect('A1:J5', 'Output', session),
      session
    );
  assert.equal(f.confirm(last).done.removed, 180);
  assert.deepEqual(
    [2, 61, 62, 121, 122].map((row) => [f.value(f.sheet, row, 1), f.value(f.sheet, row, 2)]),
    [
      ['u60@x.com', 'v182_2'],
      ['u119@x.com', 'v241_2'],
      ['u0@x.com', 'v242_2'],
      ['u59@x.com', 'v301_2'],
      ['', ''],
    ]
  );
  f.undo();
  assert.deepEqual(f.cellState(f.sheet, 1, 1, 301, 10), before);
  // The highlight rule covers every data row, comparing each key with the whole column.
  const reads2 = f.state.gets.length;
  const marked = f.edit('highlight_duplicates', { keyColumns: [1], wholeSheet: true });
  assert.equal(marked.range, 'A2:J301');
  assert.equal(
    marked.rule,
    '=AND(IFERROR(LEN($A2)>0,FALSE),SUMPRODUCT(IFERROR(($A$2:$A$301=$A2)*1,0))>1)'
  );
  assert.deepEqual(f.requests()[0].addConditionalFormatRule.rule.ranges, [
    gridOf(f.sheet, 1, 301, 0, 10),
  ]);
  assert.ok(
    f.state.gets
      .slice(reads2)
      .every((get) => !(get.options.ranges || []).includes("'Output'!A2:J301")),
    'a highlight reads no table cells'
  );
  f.undo();
  for (const [action, extra, message] of [
    ['remove_duplicates', { keyColumns: [11] }, /Key column must be between 1 and 10/],
    ['highlight_duplicates', { wholeSheet: 'yes' }, /wholeSheet must be true or false/],
    [
      'remove_duplicates',
      { keyColumns: [2] },
      /No duplicate rows in Output!A2:J301 \(the whole tab\)/,
    ],
  ])
    assert.throws(
      () => f.edit(action, { wholeSheet: extra.wholeSheet ?? true, ...extra }, f.inspect('A1:B2')),
      message,
      JSON.stringify(extra)
    );
  // A table larger than undo keeps (50,000 cells) is refused whole rather than changed for good.
  f.sheet.maxColumns = 200;
  f.setCell(f.sheet, 301, 200, 'far');
  for (const action of ['remove_duplicates', 'highlight_duplicates'])
    assert.throws(
      () => f.edit(action, { keyColumns: [1], wholeSheet: true }, f.inspect('A1:B2')),
      /The data of tab "Output" spans more than 50,000 cells/
    );
  // A tab holding only its header has no rows to compare.
  const g = fixture();
  g.column(g.sheet, 1, ['Email']);
  assert.throws(
    () => g.edit('remove_duplicates', { wholeSheet: true }, g.inspect('A1')),
    /The data of tab "Output" must include a data row below its header/
  );
});

test('trim_whitespace trims text only where needed and undo restores it', () => {
  const f = fixture();
  f.column(f.sheet, 1, ['  Ann  Lee ', 'ok', 5]);
  const before = f.cellState(f.sheet, 1, 1, 3, 1);
  const result = f.edit('trim_whitespace', {}, f.inspect('A1:A3'));
  assert.equal(result.cellsChanged, 1);
  assert.deepEqual(f.requests(), [{ trimWhitespace: { range: gridOf(f.sheet, 0, 3, 0, 1) } }]);
  assert.equal(f.value(f.sheet, 1, 1), 'Ann Lee');
  f.undo();
  assert.deepEqual(f.cellState(f.sheet, 1, 1, 3, 1), before);
  f.setCell(f.sheet, 1, 1, 'clean');
  assert.throws(
    () => f.edit('trim_whitespace', {}, f.inspect('A1:A3')),
    /No text in Output!A1:A3 has extra spaces/
  );
});

test('split_columns splits one column to the right, asks before writing over cells and undoes', () => {
  const f = fixture();
  f.column(f.sheet, 1, ['Ann,Lee', 'Bob,Ray,Jr', 'Cy']);
  const before = f.cellState(f.sheet, 1, 1, 3, 4);
  const result = f.edit('split_columns', { delimiter: 'comma' }, f.inspect('A1:A3'));
  assert.equal(result.ok, true);
  assert.equal(result.range, 'A1:C3');
  assert.deepEqual(f.requests(), [
    { textToColumns: { source: gridOf(f.sheet, 0, 3, 0, 1), delimiterType: 'COMMA' } },
  ]);
  assert.deepEqual(
    [f.value(f.sheet, 2, 1), f.value(f.sheet, 2, 2), f.value(f.sheet, 2, 3)],
    ['Bob', 'Ray', 'Jr']
  );
  f.undo();
  assert.deepEqual(f.cellState(f.sheet, 1, 1, 3, 4), before);
  // A custom separator, and a filled column in the way: the user is asked first.
  f.column(f.sheet, 4, ['Ann - Lee', 'Bob - Ray']);
  f.setCell(f.sheet, 1, 5, 'keep me');
  const inspected = f.inspect('D1:D2');
  const call = (session, extra) =>
    f.edit('split_columns', { delimiter: ' - ', ...extra }, inspected, session);
  const { asked, done } = f.confirm(call);
  assert.equal(
    asked.summary,
    'Splitting Output!D1:D2 writes over 1 non-empty cell in Output!E1:E2.'
  );
  assert.deepEqual(f.requests()[0].textToColumns, {
    source: gridOf(f.sheet, 0, 2, 3, 4),
    delimiterType: 'CUSTOM',
    delimiter: ' - ',
  });
  assert.equal(done.ok, true);
  assert.equal(f.value(f.sheet, 1, 5), 'Lee');
  f.undo();
  assert.equal(f.value(f.sheet, 1, 5), 'keep me');
  for (const [range, extra, message] of [
    ['A1:B3', {}, /splits one column; inspect it alone/],
    ['A3', { delimiter: 'comma' }, /No text in Output!A3 contains that separator/],
    ['A1', { delimiter: '' }, /delimiter is comma, semicolon/],
  ])
    assert.throws(() => f.edit('split_columns', extra, f.inspect(range)), message);
  f.setCell(f.sheet, 1, 26, 'a,b');
  assert.throws(
    () => f.edit('split_columns', {}, f.inspect('Z1')),
    /needs 1 more columns to the right/
  );
  f.setCell(f.sheet, 1, 7, 'a,b', '=A1');
  assert.throws(
    () => f.edit('split_columns', {}, f.inspect('G1')),
    /splits typed text, not formulas/
  );
});

test('data_validation sets dropdowns, checkboxes and number or date rules, clears them and undoes', () => {
  const f = fixture();
  f.book.insertSheet('Lists');
  f.setMeta(f.sheet, 1, 1, { note: 'kept', dataValidation: LIST });
  const before = f.cellState(f.sheet, 1, 1, 2, 2);
  const set = (validation, range = 'A1:B2') =>
    f.edit('data_validation', { validation }, f.inspect(range));
  const cases = [
    [
      { type: 'list', values: ['Open', 'Done'] },
      {
        condition: {
          type: 'ONE_OF_LIST',
          values: [{ userEnteredValue: 'Open' }, { userEnteredValue: 'Done' }],
        },
        strict: true,
        showCustomUi: true,
      },
    ],
    [
      { type: 'range', source: "'Lists'!A1:A3", strict: false },
      {
        condition: { type: 'ONE_OF_RANGE', values: [{ userEnteredValue: "='Lists'!A1:A3" }] },
        strict: false,
        showCustomUi: true,
      },
    ],
    [{ type: 'checkbox' }, { condition: { type: 'BOOLEAN' }, strict: true }],
    [
      { type: 'number', condition: 'between', value: '1', value2: '10.5' },
      {
        condition: {
          type: 'NUMBER_BETWEEN',
          values: [{ userEnteredValue: '1' }, { userEnteredValue: '=10.5' }],
        },
        strict: true,
      },
    ],
    [
      { type: 'date', condition: 'on_or_after', value: '2026-01-31' },
      {
        // A DATE formula reads the same in every spreadsheet locale; text dates do not.
        condition: {
          type: 'DATE_ON_OR_AFTER',
          values: [{ userEnteredValue: '=DATE(2026,1,31)' }],
        },
        strict: true,
      },
    ],
  ];
  for (const [validation, rule] of cases) {
    const result = set(validation);
    assert.equal(result.ok, true, JSON.stringify(validation));
    assert.deepEqual(f.requests(), [
      {
        setDataValidation: { range: gridOf(f.sheet, 0, 2, 0, 2), rule, filteredRowsIncluded: true },
      },
    ]);
    assert.deepEqual(f.meta(f.sheet, 2, 2).dataValidation, rule);
  }
  assert.equal(f.meta(f.sheet, 1, 1).note, 'kept');
  set({ type: 'clear' });
  assert.deepEqual(f.requests(), [
    { setDataValidation: { range: gridOf(f.sheet, 0, 2, 0, 2), filteredRowsIncluded: true } },
  ]);
  assert.deepEqual(f.meta(f.sheet, 1, 1), { note: 'kept' });
  for (let step = 0; step <= cases.length; step++) f.undo();
  assert.deepEqual(f.cellState(f.sheet, 1, 1, 2, 2), before);
  for (const [validation, message] of [
    [
      { type: 'list', values: ['=IMPORTXML("https://elsewhere.example","//a")'] },
      /must be literal/,
    ],
    [{ type: 'list', values: [] }, /A list needs 1 to 500 values/],
    [{ type: 'range', source: 'Missing!A1:A3' }, /No tab named "Missing"/],
    [{ type: 'number', condition: 'gt', value: 'many' }, /finite numbers/],
    [{ type: 'number', condition: 'before', value: '1' }, /Choose a condition: gt, gte/],
    [{ type: 'number', condition: 'gt', value: '1', value2: '2' }, /value2 is only for between/],
    [{ type: 'date', condition: 'after', value: '2026-02-30' }, /dates as YYYY-MM-DD/],
    [{ type: 'checkbox', values: ['x'] }, /values does not apply to a checkbox/],
    [{ type: 'clear', strict: true }, /strict does not apply to clear/],
    [{ type: 'list', values: ['a'], strict: 'yes' }, /strict must be true or false/],
    [{ type: 'colour' }, /Choose validation type list, range, checkbox/],
    [{ type: 'list', values: ['a'], extra: 1 }, /documented fields/],
  ])
    assert.throws(() => set(validation), message, JSON.stringify(validation));
});

test('data_validation sends decimal bounds as formulas, which read the same in every locale', () => {
  // ConditionValue.userEnteredValue is parsed as typed: in a de_DE sheet '1.5' is no number.
  const f = fixture();
  const result = f.edit(
    'data_validation',
    { validation: { type: 'number', condition: 'between', value: 0.5, value2: '1.5' } },
    f.inspect('A1:B2')
  );
  assert.deepEqual(f.requests()[0].setDataValidation.rule.condition, {
    type: 'NUMBER_BETWEEN',
    values: [{ userEnteredValue: '=0.5' }, { userEnteredValue: '=1.5' }],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(plain(f.session.events.at(-1)).details.at(-1), {
    label: 'Validation',
    value: 'number between 0.5 and 1.5',
  });
  f.edit(
    'data_validation',
    { validation: { type: 'number', condition: 'gte', value: '-2' } },
    f.inspect('A1:B2')
  );
  assert.deepEqual(f.requests()[0].setDataValidation.rule.condition.values, [
    { userEnteredValue: '-2' },
  ]);
});

test('data_validation and named_range take whole or open columns, which grow with the data', () => {
  const f = fixture();
  const lists = f.book.insertSheet('Lists');
  for (const [source, reference] of [
    ["'Lists'!A:A", "='Lists'!A:A"],
    ['Lists!A2:A', "='Lists'!A2:A"],
    ["'Lists'!a2:b", "='Lists'!A2:B"],
  ]) {
    f.edit('data_validation', { validation: { type: 'range', source } }, f.inspect('A1:B2'));
    assert.deepEqual(
      f.requests()[0].setDataValidation.rule.condition,
      { type: 'ONE_OF_RANGE', values: [{ userEnteredValue: reference }] },
      source
    );
  }
  const added = f.tabAction('named_range', {
    namedRange: { operation: 'add', name: 'Spend', range: "'Output'!C2:C" },
  });
  assert.equal(added.refersTo, "'Output'!C2:C");
  const id = f.requests()[0].addNamedRange.namedRange.namedRangeId;
  assert.deepEqual(f.requests()[0].addNamedRange.namedRange.range, {
    sheetId: f.sheet.id,
    startRowIndex: 1,
    startColumnIndex: 2,
    endColumnIndex: 3,
  });
  const moved = f.tabAction('named_range', {
    namedRange: { operation: 'update', name: 'Spend', range: 'Lists!B:B' },
  });
  assert.equal(moved.refersTo, "'Lists'!B:B");
  assert.deepEqual(f.requests()[0].updateNamedRange.namedRange.range, {
    sheetId: lists.id,
    startColumnIndex: 1,
    endColumnIndex: 2,
  });
  const renamed = f.tabAction('named_range', {
    namedRange: { operation: 'update', name: 'Spend', newName: 'Cost' },
  });
  assert.equal(renamed.refersTo, "'Lists'!B:B");
  f.undo();
  f.undo();
  assert.equal(f.namedRanges()[0].namedRangeId, id);
  assert.equal(f.namedRanges()[0].range.endRowIndex, undefined, 'still open after undo');
  // Open ranges still start inside the grid, and a destination stays one bounded place.
  for (const [call, message] of [
    [
      () =>
        f.edit(
          'data_validation',
          { validation: { type: 'range', source: "'Lists'!A:" } },
          f.inspect('A1:B2')
        ),
      /source must be an A1 cell or range such as B2, 'Tab name'!A1:C9 or 'Tab name'!A:A/,
    ],
    [
      () =>
        f.edit(
          'data_validation',
          { validation: { type: 'range', source: "'Lists'!B:A" } },
          f.inspect('A1:B2')
        ),
      /must run forward and fit inside the existing sheet grid/,
    ],
    [
      () =>
        f.tabAction('named_range', {
          namedRange: { operation: 'add', name: 'Far', range: "'Lists'!A99999:A" },
        }),
      /must run forward and fit inside the existing sheet grid/,
    ],
    [
      () => f.edit('copy_range', { destination: 'Lists!A:A' }, f.inspect('A1:B2')),
      /destination must be an A1 cell or range such as B2 or 'Tab name'!A1:C9/,
    ],
  ])
    assert.throws(call, message);
});

test('set_notes and set_links write notes and https links only, and undo restores the cells', () => {
  const f = fixture();
  f.setCell(f.sheet, 2, 1, 'keep text');
  f.setMeta(f.sheet, 1, 1, { note: 'old note' });
  const before = f.cellState(f.sheet, 1, 1, 2, 1);
  const notes = f.edit('set_notes', { notes: [['new note'], ['']] }, f.inspect('A1:A2'));
  assert.equal(notes.ok, true);
  assert.deepEqual(f.requests(), [
    {
      updateCells: {
        range: gridOf(f.sheet, 0, 2, 0, 1),
        rows: [{ values: [{ note: 'new note' }] }, { values: [{}] }],
        fields: 'note',
      },
    },
  ]);
  assert.equal(f.meta(f.sheet, 1, 1).note, 'new note');
  f.undo();
  assert.deepEqual(f.cellState(f.sheet, 1, 1, 2, 1), before);
  assert.throws(
    () => f.edit('set_notes', { notes: [['x']] }, f.inspect('A1:A2')),
    /notes matrix must match/
  );
  const links = f.edit(
    'set_links',
    {
      links: [
        [{ url: 'https://example.com/a?b=1', text: 'Site' }],
        [{ url: 'https://example.com/b' }],
      ],
    },
    f.inspect('A1:A2')
  );
  assert.equal(links.ok, true);
  assert.deepEqual(f.requests()[0].updateCells.rows, [
    {
      values: [
        {
          userEnteredFormat: { textFormat: { link: { uri: 'https://example.com/a?b=1' } } },
          userEnteredValue: { stringValue: 'Site' },
        },
      ],
    },
    {
      values: [
        {
          userEnteredFormat: { textFormat: { link: { uri: 'https://example.com/b' } } },
          userEnteredValue: { stringValue: 'keep text' },
        },
      ],
    },
  ]);
  assert.equal(
    f.requests()[0].updateCells.fields,
    'userEnteredValue,userEnteredFormat.textFormat.link,textFormatRuns'
  );
  assert.equal(f.value(f.sheet, 1, 1), 'Site');
  assert.deepEqual(f.format(f.sheet, 2, 1), {
    textFormat: { link: { uri: 'https://example.com/b' } },
  });
  // An empty url removes the link and keeps the text.
  f.edit('set_links', { links: [[{ url: '' }]] }, f.inspect('A2'));
  assert.deepEqual(f.format(f.sheet, 2, 1), {});
  assert.equal(f.value(f.sheet, 2, 1), 'keep text');
  f.undo();
  f.undo();
  assert.deepEqual(f.cellState(f.sheet, 1, 1, 2, 1), before);
  for (const url of [
    'http://example.com',
    'javascript:alert(1)',
    'https://example.com/"onmouseover',
    'https:///nohost',
    'HTTPS://example.com',
  ])
    assert.throws(
      () => f.edit('set_links', { links: [[{ url }]] }, f.inspect('A1')),
      /Links must be https:\/\/ addresses/,
      url
    );
  assert.throws(
    () => f.edit('set_links', { links: [[{ href: 'https://a.b' }]] }, f.inspect('A1')),
    /documented fields/
  );
});

test('named_range adds, renames, moves and deletes names, each undone', () => {
  const f = fixture();
  const other = f.book.insertSheet('Other');
  const added = f.tabAction('named_range', {
    namedRange: { operation: 'add', name: 'Spend', range: 'Output!B2:B9' },
  });
  assert.equal(added.ok, true);
  assert.equal(added.refersTo, "'Output'!B2:B9");
  const id = f.requests()[0].addNamedRange.namedRange.namedRangeId;
  assert.match(id, /^dmv[a-f0-9]{16}$/);
  assert.deepEqual(f.namedRanges(), [
    { namedRangeId: id, name: 'Spend', range: gridOf(f.sheet, 1, 9, 1, 2) },
  ]);
  const renamed = f.tabAction('named_range', {
    sheetName: 'Other',
    namedRange: { operation: 'update', name: 'spend', newName: 'Cost', range: 'C1:C5' },
  });
  assert.equal(renamed.refersTo, "'Other'!C1:C5");
  assert.deepEqual(f.namedRanges(), [
    { namedRangeId: id, name: 'Cost', range: gridOf(other, 0, 5, 2, 3) },
  ]);
  f.undo();
  assert.deepEqual(f.namedRanges(), [
    { namedRangeId: id, name: 'Spend', range: gridOf(f.sheet, 1, 9, 1, 2) },
  ]);
  const deleted = f.tabAction('named_range', {
    namedRange: { operation: 'delete', name: 'Spend' },
  });
  assert.match(deleted.note, /#NAME\?/);
  assert.deepEqual(f.namedRanges(), []);
  f.undo();
  assert.equal(f.namedRanges()[0].namedRangeId, id, 'back with the same id');
  f.undo();
  assert.deepEqual(f.namedRanges(), []);
  for (const [spec, message] of [
    [{ operation: 'add', name: 'A1', range: 'Output!A1' }, /not look like a cell/],
    [{ operation: 'add', name: 'two words', range: 'Output!A1' }, /only letters, digits and _/],
    [{ operation: 'add', name: 'Fine', range: 'A1' }, /must name its tab/],
    [{ operation: 'add', name: 'Fine' }, /Give the range to name/],
    [{ operation: 'update', name: 'Nope', newName: 'X' }, /No named range is called "Nope"/],
    [{ operation: 'rename', name: 'Nope' }, /Choose namedRange operation add, update or delete/],
  ])
    assert.throws(
      () => f.tabAction('named_range', { namedRange: spec }),
      message,
      JSON.stringify(spec)
    );
  f.tabAction('named_range', {
    namedRange: { operation: 'add', name: 'Taken', range: 'Output!A1' },
  });
  assert.throws(
    () =>
      f.tabAction('named_range', {
        namedRange: { operation: 'add', name: 'TAKEN', range: 'Output!A2' },
      }),
    /already exists/
  );
  assert.throws(
    () => f.tabAction('named_range', { namedRange: { operation: 'update', name: 'Taken' } }),
    /update needs newName, range or both/
  );
});

test('duplicate_sheet copies a tab next to it', () => {
  const f = fixture();
  f.book.insertSheet('Last');
  f.column(f.sheet, 1, ['a', 'b']);
  const result = confirmed(f, 'duplicate_sheet', { sheetName: 'Output' });
  assert.equal(result.ok, true);
  assert.equal(result.sheetName, 'Copy of Output');
  const copy = f.tab('Copy of Output');
  assert.equal(f.book.sheets.indexOf(copy), 1);
  assert.equal(f.value(copy, 2, 1), 'b');
  assert.match(result.url, new RegExp('#gid=' + copy.id + '&range=A1$'));
  const request = f.requests()[0].duplicateSheet;
  assert.deepEqual(request, {
    sourceSheetId: f.sheet.id,
    insertSheetIndex: 1,
    newSheetId: copy.id,
    newSheetName: 'Copy of Output',
  });
  assert.equal(
    confirmed(f, 'duplicate_sheet', { sheetName: 'Output' }).sheetName,
    'Copy of Output 2'
  );
  assert.throws(
    () => f.tabAction('duplicate_sheet', { sheetName: 'Output', newName: 'last' }),
    /already exists/
  );
  const named = confirmed(f, 'duplicate_sheet', { sheetName: 'Output', newName: 'Backup' });
  assert.equal(named.sheetName, 'Backup');
});

test('delete_sheet refuses report tabs and the last visible tab', () => {
  const f = fixture();
  f.report();
  assert.throws(
    () => f.tabAction('delete_sheet', { sheetName: 'Output' }),
    /used by a saved report\. Change or remove the report instead/
  );
  const g = fixture();
  const hidden = g.book.insertSheet('Hidden');
  hidden.hidden = true;
  assert.throws(
    () => g.tabAction('delete_sheet', { sheetName: 'Output' }),
    /at least one visible tab/
  );
  assert.equal(g.state.batches.length, 0);
});

test('delete_sheet asks first, keeps no hidden copy, and undo points to version history', () => {
  const f = fixture();
  const notes = f.book.insertSheet('Notes');
  f.setCell(notes, 1, 1, 'keep me');
  const edited = f.edit('set_values', { values: [['x']] }, f.inspect('A1'));
  const call = (session, extra) =>
    f.tabAction('delete_sheet', { sheetName: 'Notes', ...extra }, session);
  const { asked, done } = f.confirm(call);
  assert.equal(
    asked.summary,
    'Delete the tab "Notes" (data in A1)? Formulas on other tabs that point at it will show #REF!. ' +
      NO_UNDO
  );
  assert.equal(done.ok, true);
  assert.equal(done.url, null);
  assert.equal(done.undoId, null);
  assert.equal(done.note, undefined);
  assert.deepEqual(f.requests(), [{ deleteSheet: { sheetId: notes.id } }]);
  assert.deepEqual(
    f.book.sheets.map((sheet) => sheet.name),
    ['Output']
  );
  // Undo answers with version history rather than undo an older edit instead.
  const batches = f.state.batches.length;
  assert.throws(() => f.undo(), noUndo('Deleted tab Notes'));
  assert.equal(f.state.batches.length, batches);
  assert.equal(f.value(f.sheet, 1, 1), 'x');
  assert.deepEqual(
    f.undo({ action: 'list' }).entries.map((entry) => [entry.text, entry.undoable]),
    [
      ['Deleted tab Notes', false],
      ['set_values Output!A1', undefined],
    ]
  );
  assert.equal(f.undo({ action: 'undo', id: edited.undoId }).ok, true);
  assert.equal(f.value(f.sheet, 1, 1), '');
});

test('row, column, move and duplicate edits ask first, and undo points to version history', () => {
  const f = fixture();
  f.column(f.sheet, 1, ['a', 'b']);
  for (const [action, input, question, text] of [
    [
      'insert_rows',
      { start: 2, count: 2 },
      'Insert 2 rows before row 2 in tab "Output"?',
      'Inserted 2 rows before row 2 in Output',
    ],
    [
      'insert_columns',
      { start: 27 },
      'Insert 1 column at the end in tab "Output"?',
      'Inserted 1 column at the end in Output',
    ],
    [
      'group_rows',
      { start: 2, count: 3 },
      'Group rows 2-4 of tab "Output"?',
      'Grouped rows 2-4 of Output',
    ],
    [
      'ungroup_rows',
      { start: 2, count: 3 },
      'Ungroup rows 2-4 of tab "Output"?',
      'Ungrouped rows 2-4 of Output',
    ],
    [
      'duplicate_sheet',
      {},
      'Duplicate the tab "Output" as "Copy of Output"?',
      'Duplicated Output as Copy of Output',
    ],
  ]) {
    const { asked, done } = f.confirm((session, extra) =>
      f.tabAction(action, { sheetName: 'Output', ...input, ...extra }, session)
    );
    assert.equal(asked.summary, question + ' ' + NO_UNDO, action);
    assert.equal(done.ok, true, action);
    assert.equal(done.undoId, null, action);
    assert.throws(() => f.undo(), noUndo(text), action);
  }
  const move = (session, extra) =>
    f.edit(
      'move_range',
      { destination: 'D1', ...extra },
      f.inspect('A1:A2', 'Output', session),
      session
    );
  const { asked, done } = f.confirm(move);
  assert.equal(asked.summary, 'Move Output!A1:A2 to Output!D1:D2? ' + NO_UNDO);
  assert.equal(done.ok, true);
  assert.equal(done.undoId, null);
  assert.equal(f.value(f.sheet, 1, 4), 'a');
  assert.throws(() => f.undo(), noUndo('Moved Output!A1:A2 to Output!D1:D2'));
  assert.ok(!f.book.sheets.some((sheet) => /undo/i.test(sheet.name)), 'no hidden copies');
});

test('hide_sheet and show_sheet toggle a tab and undo the toggle', () => {
  const f = fixture();
  const notes = f.book.insertSheet('Notes');
  const hidden = f.tabAction('hide_sheet', { sheetName: 'Notes' });
  assert.equal(hidden.ok, true);
  assert.deepEqual(f.requests(), [
    {
      updateSheetProperties: { properties: { sheetId: notes.id, hidden: true }, fields: 'hidden' },
    },
  ]);
  assert.equal(notes.hidden, true);
  assert.throws(() => f.tabAction('hide_sheet', { sheetName: 'Notes' }), /is already hidden/);
  f.undo();
  assert.equal(notes.hidden, false);
  assert.throws(() => f.tabAction('show_sheet', { sheetName: 'Notes' }), /is already shown/);
  f.tabAction('hide_sheet', { sheetName: 'Notes' });
  assert.throws(
    () => f.tabAction('hide_sheet', { sheetName: 'Output' }),
    /at least one visible tab/
  );
  assert.equal(f.tabAction('show_sheet', { sheetName: 'Notes' }).ok, true);
  assert.equal(notes.hidden, false);
});

test('every cell-changing range action refuses report output and needs a fresh inspection', () => {
  const f = fixture();
  // Duplicate rows with extra spaces, so each action gets as far as the guard.
  f.rows = [0, 1].map(() => ({ date: '2026-08-01', campaign: ' Brand  x', spend: 1, clicks: 2 }));
  f.report();
  f.book.insertSheet('Lists');
  const before = f.state.batches.length;
  const actions = {
    copy_range: { destination: 'B2', range: 'F1:F2' },
    move_range: { destination: 'F1' },
    find_replace: { find: 'Brand', replacement: 'X' },
    remove_duplicates: {},
    trim_whitespace: {},
    split_columns: { range: 'B1:B3', delimiter: 'a' },
    data_validation: { validation: { type: 'checkbox' } },
    set_notes: { notes: [['n'], ['n'], ['n']], range: 'B1:B3' },
    set_links: { links: [[{ url: 'https://a.example' }]], range: 'B2' },
  };
  for (const [action, extra] of Object.entries(actions)) {
    const range = extra.range || 'A1:D3';
    const input = { ...extra };
    delete input.range;
    if (action === 'copy_range') f.column(f.sheet, 6, ['x', 'y']);
    assert.throws(
      () => f.edit(action, input, f.inspect(range)),
      /would touch the output of the saved report "Daily" on tab "Output"/,
      action
    );
    assert.throws(
      () => f.api.dmvChatEditSheet_(f.session, { action, sheetName: 'Output', range, ...input }),
      /^Error: Inspect the target range before editing it\.$/,
      action
    );
    const inspected = f.inspect(range);
    const [, letters, row] = /^([A-Z]+)(\d+)/.exec(range);
    f.setCell(f.sheet, Number(row), letters.charCodeAt(0) - 64, 'changed ' + action);
    assert.throws(
      () => f.edit(action, input, inspected),
      /The inspected cells or sheet settings changed/,
      action
    );
  }
  assert.equal(f.state.batches.length, before, 'nothing written');
});

test('a scripted chat cleans an export across two turns and undoes the dropdown', () => {
  const f = fixture();
  f.api.dmvSaveAiSettings({ provider: 'anthropic', apiKey: 'sk-ant-offline-actions-0001' });
  const rows = [
    ['Email', 'Name', '', 'Status'],
    [' ann@x.com ', 'Ann Lee', '', ''],
    ['bob@x.com', 'Bob Ray', '', ''],
    ['ann@x.com', 'Ann Lee', '', ''],
    ['cy@x.com', 'Cy Fox', '', ''],
  ];
  rows.forEach((row, r) =>
    row.forEach((value, c) => value !== '' && f.setCell(f.sheet, r + 1, c + 1, value))
  );
  const anthropic = (blocks, stop = 'tool_use') => ({
    body: { content: blocks, stop_reason: stop },
  });
  const call = (id, name, input) => ({ type: 'tool_use', id, name, input });
  const seen = {};
  const fetch = f.api.UrlFetchApp.fetch;
  f.api.UrlFetchApp.fetch = (url, options) => {
    const body = JSON.parse(options.payload);
    for (const message of body.messages)
      for (const block of Array.isArray(message.content) ? message.content : [])
        if (block.type === 'tool_result') Object.assign(seen, JSON.parse(block.content));
    for (const block of f.state.responses[0]?.body?.content || [])
      if (block.type === 'tool_use') {
        if (block.input.editToken === 'EDIT') block.input.editToken = seen.editToken;
        if (block.input.confirmToken === 'CONFIRM') block.input.confirmToken = seen.confirmToken;
      }
    return fetch(url, options);
  };
  const inspect = (range) => call('i', 'inspect_sheet', { sheetName: 'Output', range });
  const edit = (action, range, extra) =>
    call('e', 'edit_sheet', { action, sheetName: 'Output', range, editToken: 'EDIT', ...extra });
  const dedupe = (extra) => edit('remove_duplicates', 'A1:D5', { keyColumns: [1], ...extra });
  f.state.responses.push(
    anthropic([inspect('A1:D5')]),
    anthropic([edit('trim_whitespace', 'A1:D5')]),
    anthropic([inspect('A1:D5')]),
    anthropic([dedupe()]),
    anthropic([
      call('q', 'ask_user', { question: 'Remove 1 duplicate row?', options: ['Yes', 'No'] }),
    ])
  );
  const first = plain(f.api.dmvChat({ text: 'Clean this export', transcript: [] }));
  assert.equal(first.text, 'Remove 1 duplicate row?');
  assert.equal(f.state.batches.length, 1, 'only the trim so far');
  assert.equal(f.value(f.sheet, 2, 1), 'ann@x.com');
  f.state.responses.push(
    anthropic([inspect('A1:D5')]),
    anthropic([dedupe({ confirmToken: 'CONFIRM' })]),
    anthropic([inspect('B1:B4')]),
    anthropic([edit('split_columns', 'B1:B4', { delimiter: 'space' })]),
    anthropic([inspect('D2:D4')]),
    anthropic([
      edit('data_validation', 'D2:D4', { validation: { type: 'list', values: ['New', 'Done'] } }),
    ]),
    anthropic([call('u', 'undo_sheet_edit', { action: 'undo' })]),
    anthropic([{ type: 'text', text: 'Cleaned, and the dropdown is undone.' }], 'end_turn')
  );
  const second = plain(f.api.dmvChat({ text: 'Yes', transcript: first.transcriptAppend }));
  assert.equal(second.text, 'Cleaned, and the dropdown is undone.');
  assert.deepEqual(
    second.events.filter((event) => event.kind === 'write').map((event) => event.text),
    [
      'Removed duplicate rows from Output!A2:D5',
      'Split Output!B1:B4 into columns',
      'Set validation on Output!D2:D4',
      'Undid: Set validation on Output!D2:D4',
    ]
  );
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((row) => [
      f.value(f.sheet, row, 1),
      f.value(f.sheet, row, 2),
      f.value(f.sheet, row, 3),
    ]),
    [
      ['Email', 'Name', ''],
      ['ann@x.com', 'Ann', 'Lee'],
      ['bob@x.com', 'Bob', 'Ray'],
      ['cy@x.com', 'Cy', 'Fox'],
      ['', '', ''],
    ]
  );
  assert.deepEqual(f.meta(f.sheet, 2, 4), {}, 'the dropdown is gone');
  assert.equal(f.state.batches.length, 5);
});

test("remove_duplicates reports Sheets' own count when it differs from the estimate it asked with", () => {
  const f = fixture();
  // The estimate ignores case like Sheets does; this sandbox compares exactly, so it removes one.
  f.column(f.sheet, 1, ['Email', 'a@x.com', 'A@X.com', 'b@x.com', 'b@x.com']);
  const inspected = f.inspect('A1:A5');
  const call = (session, extra) => f.edit('remove_duplicates', extra, inspected, session);
  const { asked, done } = f.confirm(call);
  assert.match(asked.summary, /^Remove 2 duplicate rows from Output!A2:A5/);
  assert.equal(done.removed, 1);
  assert.equal(done.kept, 3);
});
