import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatamoovSandbox, plain } from './helpers/datamoov-sandbox.mjs';

// The offline Sheets API answers the analyst sheet requests with the API's request shapes, replies
// and validation, so the sheet tools can be tested against it. An invalid request fails its batch.
function fixture(settings = { gridData: true }) {
  const f = createDatamoovSandbox(settings);
  f.sheet = f.book.sheets[0];
  f.batch = (requests) => plain(f.api.Sheets.Spreadsheets.batchUpdate({ requests }, f.book.id));
  f.get = (options) => plain(f.api.Sheets.Spreadsheets.get(f.book.id, options));
  f.grid = (sheet, startRowIndex, endRowIndex, startColumnIndex, endColumnIndex) => ({ sheetId: sheet.id, startRowIndex, endRowIndex, startColumnIndex, endColumnIndex });
  f.addTab = (title, rows = 100, columns = 26) => {
    f.batch([{ addSheet: { properties: { title, gridProperties: { rowCount: rows, columnCount: columns } } } }]);
    return f.tab(title);
  };
  f.column = (sheet, column, rows) => Array.from({ length: rows }, (_, r) => f.value(sheet, r + 1, column));
  return f;
}
const bold = { userEnteredFormat: { textFormat: { bold: true } } };
const red = { red: 1 };

test('without gridData the existing spreadsheets.get answer is unchanged and new fields appear only once made', () => {
  const f = fixture({});
  f.setCell(f.sheet, 1, 1, 'kept out');
  const before = { sheets: [{ properties: { sheetId: f.sheet.id, title: 'Output', index: 0, hidden: false, gridProperties: { rowCount: 100, columnCount: 26, frozenRowCount: 0 } }, charts: [] }] };
  assert.deepEqual(f.get({ ranges: ["'Output'!A1:B2"], includeGridData: true, fields: 'sheets(properties,data)' }), before);
  assert.deepEqual(f.get(), before);
  f.batch([
    { addNamedRange: { namedRange: { namedRangeId: 'n1', name: 'Totals', range: f.grid(f.sheet, 0, 2, 0, 1) } } },
    { addConditionalFormatRule: { rule: { ranges: [f.grid(f.sheet, 0, 2, 0, 1)], booleanRule: { condition: { type: 'NOT_BLANK' }, format: { backgroundColor: red } } } } },
    { addDimensionGroup: { range: { sheetId: f.sheet.id, dimension: 'ROWS', startIndex: 1, endIndex: 3 } } },
  ]);
  const after = f.get();
  assert.deepEqual(after.namedRanges, [{ namedRangeId: 'n1', name: 'Totals', range: { sheetId: f.sheet.id, endRowIndex: 2, endColumnIndex: 1 } }]);
  assert.deepEqual(after.sheets[0].conditionalFormats, [{ ranges: [{ sheetId: f.sheet.id, endRowIndex: 2, endColumnIndex: 1 }], booleanRule: { condition: { type: 'NOT_BLANK' }, format: { backgroundColor: red } } }]);
  assert.deepEqual(after.sheets[0].rowGroups, [{ range: { sheetId: f.sheet.id, dimension: 'ROWS', startIndex: 1, endIndex: 3 }, depth: 1 }]);
  assert.deepEqual(f.get({ fields: 'sheets.properties' }), before, 'a mask without them leaves them out');
});

test('copyPaste PASTE_NORMAL carries values, formulas with moved relative references, formats, cell fields and merges', () => {
  const f = fixture(), sheet = f.sheet;
  f.setCell(sheet, 1, 1, 10);
  f.setCell(sheet, 2, 1, 20);
  f.setCell(sheet, 1, 2, 20, '=A1*2');
  f.setCell(sheet, 2, 2, '=$A$1+A2', '=$A$1+A2');
  f.setCell(sheet, 1, 3, 'merged');
  f.batch([
    { repeatCell: { range: f.grid(sheet, 0, 1, 0, 1), cell: bold, fields: 'userEnteredFormat.textFormat.bold' } },
    { updateCells: { range: f.grid(sheet, 0, 1, 0, 1), rows: [{ values: [{ note: 'source note' }] }], fields: 'note' } },
    { mergeCells: { range: f.grid(sheet, 0, 1, 2, 4), mergeType: 'MERGE_ALL' } },
  ]);
  const replies = f.batch([
    { copyPaste: { source: f.grid(sheet, 0, 2, 0, 2), destination: f.grid(sheet, 4, 5, 3, 4), pasteType: 'PASTE_NORMAL' } },
    { copyPaste: { source: f.grid(sheet, 0, 1, 2, 4), destination: f.grid(sheet, 9, 10, 2, 4) } },
  ]).replies;
  assert.deepEqual(replies, [{}, {}]);
  assert.deepEqual([f.value(sheet, 5, 4), f.value(sheet, 6, 4)], [10, 20], 'a smaller destination still takes the whole source');
  assert.equal(f.formula(sheet, 5, 5), '=D5*2');
  assert.equal(f.formula(sheet, 6, 5), '=$A$1+D6', 'absolute parts stay');
  assert.equal(f.value(sheet, 6, 5), '=$A$1+D6', 'an unevaluated formula keeps its text as its value');
  assert.deepEqual(f.format(sheet, 5, 4), { textFormat: { bold: true } });
  assert.deepEqual(f.meta(sheet, 5, 4), { note: 'source note' });
  assert.deepEqual(f.merges(sheet), ['C1:D1', 'C10:D10']);
  assert.equal(f.value(sheet, 10, 3), 'merged');

  // A destination that is a multiple of the source repeats it; TRANSPOSE swaps rows and columns.
  f.batch([
    { copyPaste: { source: f.grid(sheet, 0, 1, 0, 1), destination: f.grid(sheet, 0, 3, 5, 6), pasteType: 'PASTE_VALUES' } },
    { copyPaste: { source: f.grid(sheet, 0, 2, 0, 1), destination: f.grid(sheet, 0, 1, 7, 8), pasteType: 'PASTE_VALUES', pasteOrientation: 'TRANSPOSE' } },
  ]);
  assert.deepEqual(f.column(sheet, 6, 3), [10, 10, 10]);
  assert.deepEqual([f.value(sheet, 1, 8), f.value(sheet, 1, 9), f.value(sheet, 2, 8)], [10, 20, '']);

  // A reference pushed off the grid becomes #REF!, the way Sheets shows it.
  f.batch([{ copyPaste: { source: f.grid(sheet, 0, 1, 1, 2), destination: f.grid(sheet, 19, 20, 0, 1) } }]);
  assert.equal(f.formula(sheet, 20, 1), '=#REF!*2');
  assert.deepEqual(f.get({ ranges: ['Output!A20'], fields: 'sheets.data.rowData.values.effectiveValue' }).sheets[0].data[0].rowData[0].values[0],
    { effectiveValue: { errorValue: { type: 'REF', message: 'Reference does not exist.' } } });
});

test('copyPaste to another tab keeps references without a tab name local and moves prefixed ones', () => {
  const f = fixture(), sheet = f.sheet, copy = f.addTab('Copy tab');
  f.setCell(sheet, 1, 2, '=A1*2', '=A1*2');
  f.setCell(sheet, 1, 3, "=Output!A1+A1+'Copy tab'!$B$1", "=Output!A1+A1+'Copy tab'!$B$1");
  f.batch([
    { copyPaste: { source: f.grid(sheet, 0, 1, 1, 2), destination: f.grid(copy, 0, 1, 1, 2) } },
    { copyPaste: { source: f.grid(sheet, 0, 1, 2, 3), destination: f.grid(copy, 1, 2, 2, 3), pasteType: 'PASTE_FORMULA' } },
  ]);
  assert.equal(f.formula(copy, 1, 2), '=A1*2');
  assert.equal(f.formula(copy, 2, 3), "=Output!A2+A2+'Copy tab'!$B$1");
});

test('each paste type carries only its own part of the cell', () => {
  const f = fixture(), sheet = f.sheet;
  const border = { style: 'SOLID', color: { blue: 1 } };
  f.setCell(sheet, 1, 1, 7);
  f.setCell(sheet, 1, 2, 14, '=A1*2');
  f.setCell(sheet, 1, 7, 'old');
  f.batch([
    { repeatCell: { range: f.grid(sheet, 0, 1, 0, 2), cell: bold, fields: 'userEnteredFormat.textFormat.bold' } },
    { repeatCell: { range: f.grid(sheet, 0, 1, 6, 7), cell: { userEnteredFormat: { textFormat: { italic: true } } }, fields: 'userEnteredFormat.textFormat.italic' } },
    { updateBorders: { range: f.grid(sheet, 5, 6, 6, 7), top: border } },
    { setDataValidation: { range: f.grid(sheet, 0, 1, 0, 1), rule: { condition: { type: 'NUMBER_GREATER', values: [{ userEnteredValue: '0' }] }, strict: true } } },
    { addConditionalFormatRule: { rule: { ranges: [f.grid(sheet, 0, 2, 0, 1)], booleanRule: { condition: { type: 'NUMBER_GREATER', values: [{ userEnteredValue: '5' }] }, format: { backgroundColor: red } } } } },
  ]);
  const paste = (from, row, column, pasteType) => ({ copyPaste: { source: from, destination: f.grid(sheet, row, row + 1, column, column + 1), pasteType } });
  f.batch([
    paste(f.grid(sheet, 0, 1, 1, 2), 0, 6, 'PASTE_VALUES'),
    paste(f.grid(sheet, 0, 1, 0, 1), 1, 6, 'PASTE_FORMAT'),
    paste(f.grid(sheet, 0, 1, 1, 2), 2, 6, 'PASTE_FORMULA'),
    paste(f.grid(sheet, 0, 1, 0, 1), 3, 6, 'PASTE_DATA_VALIDATION'),
    paste(f.grid(sheet, 0, 2, 0, 1), 4, 7, 'PASTE_CONDITIONAL_FORMATTING'),
    paste(f.grid(sheet, 0, 1, 0, 1), 5, 6, 'PASTE_NO_BORDERS'),
  ]);
  assert.deepEqual([f.value(sheet, 1, 7), f.formula(sheet, 1, 7), f.format(sheet, 1, 7)], [14, '', { textFormat: { italic: true } }], 'values only');
  assert.deepEqual([f.value(sheet, 2, 7), f.format(sheet, 2, 7), f.meta(sheet, 2, 7).dataValidation.condition.type], ['', { textFormat: { bold: true } }, 'NUMBER_GREATER'], 'format and validation');
  assert.deepEqual([f.formula(sheet, 3, 7), f.format(sheet, 3, 7)], ['=F3*2', {}], 'formulas only');
  assert.deepEqual([f.value(sheet, 4, 7), f.format(sheet, 4, 7), Object.keys(f.meta(sheet, 4, 7))], ['', {}, ['dataValidation']], 'validation only');
  // Format pastes carry the conditional formats of the copied cells too.
  assert.deepEqual(f.conditionalFormats(sheet).map((rule) => rule.ranges),
    [[f.grid(sheet, 0, 2, 0, 1)], [f.grid(sheet, 1, 2, 6, 7)], [f.grid(sheet, 4, 6, 7, 8)], [f.grid(sheet, 5, 6, 6, 7)]]);
  assert.deepEqual(f.format(sheet, 6, 7), { textFormat: { bold: true }, borders: { top: border } }, 'the destination keeps its borders');
  assert.throws(() => f.batch([paste(f.grid(sheet, 0, 1, 0, 1), 0, 0, 'PASTE_EVERYTHING')]), /^Error: Invalid requests\[0\]\.copyPaste: Invalid paste type PASTE_EVERYTHING\.$/);
  assert.throws(() => f.batch([paste(f.grid(sheet, 0, 3, 0, 1), 98, 0, 'PASTE_NORMAL')]), /The paste would exceed the grid limits/);
});

test('cutPaste moves cells, references follow them and references to cells it lands on become #REF!', () => {
  const f = fixture(), sheet = f.sheet, other = f.addTab('Other');
  f.setCell(sheet, 1, 1, 1);
  f.setCell(sheet, 2, 1, 2);
  f.setCell(sheet, 1, 3, '=SUM(A1:A2)', '=SUM(A1:A2)');
  f.setCell(sheet, 1, 4, '=A1', '=A1');
  f.setCell(sheet, 1, 5, '=G1', '=G1');
  f.setCell(sheet, 1, 7, 'overwritten');
  f.setCell(sheet, 1, 8, '=C1+A1', '=C1+A1');
  f.batch([{ repeatCell: { range: f.grid(sheet, 0, 1, 0, 1), cell: bold, fields: 'userEnteredFormat.textFormat.bold' } }]);
  f.batch([{ cutPaste: { source: f.grid(sheet, 0, 2, 0, 1), destination: { sheetId: sheet.id, rowIndex: 0, columnIndex: 6 }, pasteType: 'PASTE_NORMAL' } }]);
  assert.deepEqual([f.value(sheet, 1, 1), f.format(sheet, 1, 1), f.value(sheet, 1, 7), f.value(sheet, 2, 7)], ['', {}, 1, 2]);
  assert.deepEqual(f.format(sheet, 1, 7), { textFormat: { bold: true } });
  assert.equal(f.formula(sheet, 1, 3), '=SUM(G1:G2)');
  assert.equal(f.formula(sheet, 1, 4), '=G1');
  assert.equal(f.formula(sheet, 1, 5), '=#REF!');
  assert.equal(f.value(sheet, 1, 5), '#REF!');
  // Across tabs, a moved formula names the tab it still refers to, and others name the new one.
  f.batch([{ cutPaste: { source: f.grid(sheet, 0, 1, 7, 8), destination: { sheetId: other.id, rowIndex: 4, columnIndex: 0 } } }]);
  assert.equal(f.formula(other, 5, 1), '=Output!C1+Output!G1');
  f.batch([{ cutPaste: { source: f.grid(sheet, 0, 2, 6, 7), destination: { sheetId: other.id, rowIndex: 1, columnIndex: 1 } } }]);
  assert.equal(f.formula(sheet, 1, 3), '=SUM(Other!B2:B3)');
  assert.equal(f.formula(other, 5, 1), '=Output!C1+Other!B2', 'a reference written with a tab name keeps one');
  assert.throws(() => f.batch([{ cutPaste: { source: f.grid(sheet, 0, 1, 0, 1), destination: { sheetId: 999, rowIndex: 0, columnIndex: 0 } } }]),
    /^Error: Invalid requests\[0\]\.cutPaste: No grid with id: 999$/);
});

test('insertDimension shifts cells, formulas, formats, merges, rules, named ranges, frozen rows and charts', () => {
  const f = fixture(), sheet = f.sheet;
  ['head', 1, 2, 3].forEach((value, r) => f.setCell(sheet, r + 1, 1, value));
  f.setCell(sheet, 5, 2, '=SUM(A2:A4)', '=SUM(A2:A4)');
  f.setCell(sheet, 6, 2, '=A3+A$3', '=A3+A$3');
  f.setCell(sheet, 7, 2, '=COUNTIF(A2:A4,"A3")', '=COUNTIF(A2:A4,"A3")');
  f.batch([
    { updateSheetProperties: { properties: { sheetId: sheet.id, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
    { repeatCell: { range: f.grid(sheet, 1, 2, 0, 1), cell: { userEnteredFormat: { textFormat: { italic: true } } }, fields: 'userEnteredFormat.textFormat.italic' } },
    { mergeCells: { range: f.grid(sheet, 1, 4, 3, 4), mergeType: 'MERGE_ALL' } },
    { addConditionalFormatRule: { rule: { ranges: [f.grid(sheet, 1, 4, 0, 1)], booleanRule: { condition: { type: 'NOT_BLANK' }, format: { backgroundColor: red } } } } },
    { addNamedRange: { namedRange: { namedRangeId: 'v', name: 'Values', range: f.grid(sheet, 1, 4, 0, 1) } } },
    { addChart: { chart: { chartId: 3, spec: { basicChart: { chartType: 'COLUMN', domains: [{ domain: { sourceRange: { sources: [f.grid(sheet, 1, 4, 0, 1)] } } }] } },
      position: { overlayPosition: { anchorCell: { sheetId: sheet.id, rowIndex: 5, columnIndex: 4 } } } } } },
  ]);
  f.batch([{ insertDimension: { range: { sheetId: sheet.id, dimension: 'ROWS', startIndex: 2, endIndex: 4 }, inheritFromBefore: true } }]);
  assert.equal(sheet.maxRows, 102);
  assert.deepEqual(f.column(sheet, 1, 6), ['head', 1, '', '', 2, 3]);
  assert.equal(f.formula(sheet, 7, 2), '=SUM(A2:A6)');
  assert.equal(f.formula(sheet, 8, 2), '=A5+A$5');
  assert.equal(f.formula(sheet, 9, 2), '=COUNTIF(A2:A6,"A3")', 'text inside quotes is not a reference');
  assert.deepEqual([f.format(sheet, 3, 1), f.format(sheet, 4, 1)], [{ textFormat: { italic: true } }, { textFormat: { italic: true } }], 'new rows inherit the row before');
  assert.deepEqual(f.merges(sheet), ['D2:D6']);
  assert.deepEqual(f.conditionalFormats(sheet)[0].ranges, [f.grid(sheet, 1, 6, 0, 1)]);
  assert.deepEqual(f.namedRanges()[0].range, f.grid(sheet, 1, 6, 0, 1));
  assert.equal(sheet.frozenRows, 1);
  const chart = f.state.charts.find((item) => item.chartId === 3);
  assert.equal(chart.position.overlayPosition.anchorCell.rowIndex, 7);
  assert.deepEqual(chart.spec.basicChart.domains[0].domain.sourceRange.sources[0], f.grid(sheet, 1, 6, 0, 1));

  f.batch([{ insertDimension: { range: { sheetId: sheet.id, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 } } }]);
  assert.equal(f.formula(sheet, 8, 3), '=B5+B$5');
  assert.equal(sheet.maxColumns, 27);
  assert.throws(() => f.batch([{ insertDimension: { range: { sheetId: sheet.id, dimension: 'ROWS', startIndex: 0, endIndex: 1 }, inheritFromBefore: true } }]),
    /Invalid requests\[0\]\.insertDimension: Cannot inherit/);
  assert.throws(() => f.batch([{ insertDimension: { range: { sheetId: sheet.id, dimension: 'ROWS', startIndex: 5, endIndex: 5 } } }]), /insertDimension: Invalid dimension range/);
  assert.throws(() => f.batch([{ insertDimension: { range: { sheetId: sheet.id, dimension: 'ROWS', startIndex: 0, endIndex: 400000 } } }]), /above the limit of 10000000 cells/);
});

test('deleteDimension removes cells, shrinks ranges, turns lost references into #REF! and refuses to empty a sheet', () => {
  const f = fixture(), sheet = f.sheet;
  ['head', 1, 2, 3].forEach((value, r) => f.setCell(sheet, r + 1, 1, value));
  f.setCell(sheet, 1, 2, '=A3', '=A3');
  f.setCell(sheet, 2, 2, '=SUM(A2:A4)', '=SUM(A2:A4)');
  f.setCell(sheet, 10, 3, '=A4+A2+A:A', '=A4+A2+A:A');
  f.batch([
    { addConditionalFormatRule: { rule: { ranges: [f.grid(sheet, 2, 3, 0, 1), f.grid(sheet, 1, 4, 1, 2)], booleanRule: { condition: { type: 'BLANK' }, format: { backgroundColor: red } } } } },
    { addNamedRange: { namedRange: { namedRangeId: 'gone', name: 'Gone', range: f.grid(sheet, 2, 3, 0, 1) } } },
    { addDimensionGroup: { range: { sheetId: sheet.id, dimension: 'ROWS', startIndex: 1, endIndex: 4 } } },
  ]);
  f.batch([{ deleteDimension: { range: { sheetId: sheet.id, dimension: 'ROWS', startIndex: 2, endIndex: 3 } } }]);
  assert.equal(sheet.maxRows, 99);
  assert.deepEqual(f.column(sheet, 1, 4), ['head', 1, 3, '']);
  assert.equal(f.formula(sheet, 1, 2), '=#REF!');
  assert.equal(f.formula(sheet, 2, 2), '=SUM(A2:A3)');
  assert.equal(f.formula(sheet, 9, 3), '=A3+A2+A:A');
  assert.deepEqual(f.conditionalFormats(sheet)[0].ranges, [f.grid(sheet, 1, 3, 1, 2)], 'a range wholly deleted leaves the rule');
  assert.deepEqual(f.namedRanges(), []);
  assert.deepEqual(f.groups(sheet), [{ range: { sheetId: sheet.id, dimension: 'ROWS', startIndex: 1, endIndex: 3 }, depth: 1 }]);
  f.batch([{ deleteDimension: { range: { sheetId: sheet.id, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 } } }]);
  assert.equal(f.formula(sheet, 9, 2), '=#REF!+#REF!+#REF!');

  assert.throws(() => f.batch([{ deleteDimension: { range: { sheetId: sheet.id, dimension: 'ROWS', startIndex: 0, endIndex: 99 } } }]),
    /^Error: Invalid requests\[0\]\.deleteDimension: You can't delete all the rows on the sheet\.$/);
  assert.throws(() => f.batch([{ deleteDimension: { range: { sheetId: sheet.id, dimension: 'ROWS', startIndex: 90, endIndex: 120 } } }]), /exceeds the grid limits \(rows: 99\)/);
  f.batch([{ updateSheetProperties: { properties: { sheetId: sheet.id, gridProperties: { frozenRowCount: 2 } }, fields: 'gridProperties.frozenRowCount' } }]);
  assert.throws(() => f.batch([{ deleteDimension: { range: { sheetId: sheet.id, dimension: 'ROWS', startIndex: 2, endIndex: 99 } } }]), /You can't delete all non-frozen rows/);
});

test('dimension groups deepen and flatten by range exactly as the API documents', () => {
  const f = fixture(), sheet = f.sheet;
  const columns = (startIndex, endIndex) => ({ range: { sheetId: sheet.id, dimension: 'COLUMNS', startIndex, endIndex } });
  const group = (startIndex, endIndex, depth) => ({ range: { sheetId: sheet.id, dimension: 'COLUMNS', startIndex, endIndex }, depth });
  // [C:D] + [B:E] gives [B:E depth 1] and [C:D depth 2].
  const added = f.batch([{ addDimensionGroup: columns(2, 4) }, { addDimensionGroup: columns(1, 5) }]).replies;
  assert.deepEqual(added[0], { addDimensionGroup: { dimensionGroups: [group(2, 4, 1)] } });
  assert.deepEqual(added[1], { addDimensionGroup: { dimensionGroups: [group(1, 5, 1), group(2, 4, 2)] } });
  // Deleting [D:E] leaves [B:D depth 1] and [C:C depth 2].
  assert.deepEqual(f.batch([{ deleteDimensionGroup: columns(3, 5) }]).replies[0], { deleteDimensionGroup: { dimensionGroups: [group(1, 4, 1), group(2, 3, 2)] } });
  assert.deepEqual(f.get({ fields: 'sheets.columnGroups' }).sheets[0].columnGroups, [group(1, 4, 1), group(2, 3, 2)]);
  assert.throws(() => f.batch([{ deleteDimensionGroup: columns(10, 12) }]), /deleteDimensionGroup: No group exists over the specified range/);
  // [B:D] + [C:E] gives [B:E depth 1] and [C:D depth 2], even when the first group is at index 0.
  const g = fixture(), rows = (startIndex, endIndex) => ({ range: { sheetId: g.sheet.id, dimension: 'ROWS', startIndex, endIndex } });
  const reply = g.batch([{ addDimensionGroup: rows(0, 3) }, { addDimensionGroup: rows(1, 4) }]).replies[1];
  assert.deepEqual(reply, { addDimensionGroup: { dimensionGroups: [
    { range: { sheetId: g.sheet.id, dimension: 'ROWS', endIndex: 4 }, depth: 1 },
    { range: { sheetId: g.sheet.id, dimension: 'ROWS', startIndex: 1, endIndex: 3 }, depth: 2 }] } }, 'zero indexes are omitted');
});

test('findReplace honours its scope and options and reports what it changed', () => {
  const f = fixture(), sheet = f.sheet, other = f.addTab('Other');
  ['Cat', 'cat food', 'dog', 42].forEach((value, r) => f.setCell(sheet, r + 1, 1, value));
  f.setCell(sheet, 1, 2, '=A1&"cat"', '=A1&"cat"');
  f.setCell(other, 3, 1, 'cat');
  assert.deepEqual(f.batch([{ findReplace: { find: 'cat', replacement: 'dog', sheetId: sheet.id } }]).replies,
    [{ findReplace: { valuesChanged: 2, rowsChanged: 2, sheetsChanged: 1, occurrencesChanged: 2 } }]);
  assert.deepEqual(f.column(sheet, 1, 2), ['dog', 'dog food']);
  assert.equal(f.formula(sheet, 1, 2), '=A1&"cat"', 'formulas only with includeFormulas');
  assert.deepEqual(f.batch([{ findReplace: { find: 'cat', replacement: 'cow', allSheets: true, includeFormulas: true, matchCase: true } }]).replies,
    [{ findReplace: { valuesChanged: 1, formulasChanged: 1, rowsChanged: 2, sheetsChanged: 2, occurrencesChanged: 2 } }]);
  assert.deepEqual([f.formula(sheet, 1, 2), f.value(other, 3, 1)], ['=A1&"cow"', 'cow']);
  f.batch([
    { findReplace: { find: '^d(o)g$', replacement: 'D$1G', searchByRegex: true, range: f.grid(sheet, 0, 3, 0, 1) } },
    { findReplace: { find: 'dog', replacement: 'x', matchEntireCell: true, matchCase: true, sheetId: sheet.id } },
    { findReplace: { find: '4', replacement: '5', sheetId: sheet.id } },
  ]);
  assert.deepEqual(f.column(sheet, 1, 4), ['DoG', 'dog food', 'DoG', 52], 'a whole-cell match leaves partial matches alone and numbers stay numbers');
  assert.deepEqual(f.batch([{ findReplace: { find: 'absent', replacement: 'x', allSheets: true } }]).replies, [{ findReplace: {} }], 'zero counts are omitted');
  for (const [spec, message] of [
    [{ find: '', allSheets: true }, /The find string must not be empty/],
    [{ find: 'a', allSheets: true, sheetId: sheet.id }, /Set exactly one of range, sheetId or allSheets/],
    [{ find: 'a' }, /Set exactly one of range, sheetId or allSheets/],
    [{ find: '(', searchByRegex: true, allSheets: true }, /Invalid regular expression/],
    [{ find: 'a', range: f.grid(sheet, 0, 200, 0, 1) }, /The range exceeds the grid limits/],
  ]) assert.throws(() => f.batch([{ findReplace: spec }]), message);
});

test('deleteDuplicates keeps the first row of each key and moves the rest up inside the range', () => {
  const f = fixture(), sheet = f.sheet;
  [['a', 1, 'x'], ['b', 2, 'y'], ['a', 1, 'z'], ['c', 3, 'x'], ['b', 2, 'w'], ['a', 9, 'x'], ['below', '', '']]
    .forEach((row, r) => row.forEach((value, c) => value !== '' && f.setCell(sheet, r + 1, c + 1, value)));
  const reply = f.batch([{ deleteDuplicates: { range: f.grid(sheet, 0, 6, 0, 3), comparisonColumns: [{ sheetId: sheet.id, dimension: 'COLUMNS', startIndex: 0, endIndex: 2 }] } }]).replies[0];
  assert.deepEqual(reply, { deleteDuplicates: { duplicatesRemovedCount: 2 } });
  assert.deepEqual(Array.from({ length: 7 }, (_, r) => [1, 2, 3].map((c) => f.value(sheet, r + 1, c))),
    [['a', 1, 'x'], ['b', 2, 'y'], ['c', 3, 'x'], ['a', 9, 'x'], ['', '', ''], ['', '', ''], ['below', '', '']]);
  assert.deepEqual(f.batch([{ deleteDuplicates: { range: f.grid(sheet, 0, 4, 0, 3) } }]).replies[0], { deleteDuplicates: {} });
  assert.throws(() => f.batch([{ deleteDuplicates: { range: f.grid(sheet, 0, 4, 0, 2), comparisonColumns: [{ sheetId: sheet.id, dimension: 'COLUMNS', startIndex: 2, endIndex: 3 }] } }]),
    /deleteDuplicates: Comparison columns must be within the range/);
});

test('trimWhitespace and textToColumns clean text cells and leave formulas alone', () => {
  const f = fixture(), sheet = f.sheet;
  ['  a   b ', '\tx\n', 'ok', '   ', 7].forEach((value, r) => f.setCell(sheet, r + 1, 1, value));
  f.setCell(sheet, 6, 1, '=" padded "', '=" padded "');
  assert.deepEqual(f.batch([{ trimWhitespace: { range: f.grid(sheet, 0, 6, 0, 1) } }]).replies, [{ trimWhitespace: { cellsChangedCount: 3 } }]);
  assert.deepEqual(f.column(sheet, 1, 6), ['a b', 'x', 'ok', '', 7, '=" padded "']);

  const g = fixture(), tab = g.sheet;
  ['a,b,3', 'c', 'd,,e', 'p|q'].forEach((value, r) => g.setCell(tab, r + 1, 1, value));
  g.setCell(tab, 2, 2, 'kept');
  g.batch([{ textToColumns: { source: g.grid(tab, 0, 3, 0, 1), delimiterType: 'COMMA' } }]);
  assert.deepEqual(Array.from({ length: 3 }, (_, r) => [1, 2, 3].map((c) => g.value(tab, r + 1, c))), [['a', 'b', 3], ['c', 'kept', ''], ['d', '', 'e']]);
  g.batch([{ textToColumns: { source: g.grid(tab, 3, 4, 0, 1), delimiterType: 'CUSTOM', delimiter: '|' } }]);
  assert.deepEqual([g.value(tab, 4, 1), g.value(tab, 4, 2)], ['p', 'q']);
  assert.throws(() => g.batch([{ textToColumns: { source: g.grid(tab, 0, 3, 0, 2), delimiterType: 'COMMA' } }]), /must span exactly one column/);
  assert.throws(() => g.batch([{ textToColumns: { source: g.grid(tab, 0, 3, 0, 1) } }]), /Invalid delimiter type undefined/);
  assert.throws(() => g.batch([{ textToColumns: { source: g.grid(tab, 0, 3, 0, 1), delimiterType: 'CUSTOM' } }]), /A custom delimiter must not be empty/);
  g.setCell(tab, 5, 26, 'x;y');
  assert.throws(() => g.batch([{ textToColumns: { source: g.grid(tab, 4, 5, 25, 26), delimiterType: 'SEMICOLON' } }]), /would exceed the grid limits/);
});

test('setDataValidation accepts validation conditions only and clears without a rule', () => {
  const f = fixture(), sheet = f.sheet, lists = f.addTab('Lists');
  const rule = (type, values = [], extra = {}) => ({ condition: { type, ...(values.length ? { values: values.map((value) => typeof value === 'string' ? { userEnteredValue: value } : value) } : {}) }, ...extra });
  f.batch([
    { setDataValidation: { range: f.grid(sheet, 0, 2, 0, 1), rule: rule('ONE_OF_LIST', ['Open', 'Done'], { strict: true, showCustomUi: true }) } },
    { setDataValidation: { range: f.grid(sheet, 0, 1, 1, 2), rule: rule('BOOLEAN') } },
    { setDataValidation: { range: f.grid(sheet, 0, 1, 2, 3), rule: rule('ONE_OF_RANGE', ["='Lists'!A1:A5"]) } },
    { setDataValidation: { range: f.grid(sheet, 0, 1, 3, 4), rule: rule('DATE_BETWEEN', ['2026-01-01', '2026-12-31']) } },
  ]);
  const cells = f.get({ ranges: ['Output!A1:D2'], fields: 'sheets.data.rowData.values.dataValidation' }).sheets[0].data[0].rowData;
  assert.deepEqual(cells[0].values[0].dataValidation, rule('ONE_OF_LIST', ['Open', 'Done'], { strict: true, showCustomUi: true }));
  assert.deepEqual(cells[0].values[1].dataValidation, { condition: { type: 'BOOLEAN' } });
  assert.deepEqual(cells[1].values, [{ dataValidation: rule('ONE_OF_LIST', ['Open', 'Done'], { strict: true, showCustomUi: true }) }], 'trailing empty cells are left out');
  f.batch([{ setDataValidation: { range: f.grid(sheet, 1, 2, 0, 1) } }]);
  assert.deepEqual(f.meta(sheet, 2, 1), {});
  assert.equal(lists.name, 'Lists');
  for (const [bad, message] of [
    [rule('TEXT_STARTS_WITH', ['a']), /Condition type TEXT_STARTS_WITH is not supported for data validation/],
    [rule('DATE_BEFORE', [{ relativeDate: 'TODAY' }]), /Relative dates are not supported in data validation/],
    [rule('NUMBER_BETWEEN', ['1']), /wrong number of values/],
    [rule('NUMBER_GREATER', ['ten']), /Invalid number ten/],
    [rule('ONE_OF_RANGE', ['=Missing!A1:A5']), /Invalid range =Missing!A1:A5/],
    [rule('CUSTOM_FORMULA', ['A1>0']), /A custom formula must start with =/],
    [{}, /Condition type undefined/],
  ]) assert.throws(() => f.batch([{ setDataValidation: { range: f.grid(sheet, 0, 1, 0, 1), rule: bad } }]), message);
  assert.throws(() => f.batch([{ updateCells: { range: f.grid(sheet, 0, 1, 0, 1), rows: [{ values: [{ dataValidation: rule('BLANK') }] }], fields: 'dataValidation' } }]),
    /Invalid requests\[0\]\.updateCells: Condition type BLANK is not supported for data validation/);
  assert.equal(f.meta(sheet, 1, 1).dataValidation.condition.type, 'ONE_OF_LIST', 'a refused batch leaves the old rule');
});

test('named ranges are added, updated and deleted with the API name rules', () => {
  const f = fixture(), sheet = f.sheet;
  const reply = f.batch([{ addNamedRange: { namedRange: { name: 'Spend_2026', range: f.grid(sheet, 1, 10, 2, 3) } } }]).replies[0];
  const id = reply.addNamedRange.namedRange.namedRangeId;
  assert.equal(typeof id, 'string');
  assert.deepEqual(reply, { addNamedRange: { namedRange: { namedRangeId: id, name: 'Spend_2026', range: f.grid(sheet, 1, 10, 2, 3) } } });
  f.batch([{ updateNamedRange: { namedRange: { namedRangeId: id, name: 'Spend', range: f.grid(sheet, 0, 1, 0, 1) }, fields: 'name' } }]);
  assert.deepEqual(f.get({ fields: 'namedRanges' }), { namedRanges: [{ namedRangeId: id, name: 'Spend', range: { sheetId: sheet.id, startRowIndex: 1, endRowIndex: 10, startColumnIndex: 2, endColumnIndex: 3 } }] });
  for (const name of ['A1', 'R1C1', 'true', '2026', 'has space', 'spend']) {
    assert.throws(() => f.batch([{ addNamedRange: { namedRange: { name, range: f.grid(sheet, 0, 1, 0, 1) } } }]), /addNamedRange: (Invalid named range name|A named range with the name)/, name);
  }
  assert.throws(() => f.batch([{ updateNamedRange: { namedRange: { namedRangeId: id, name: 'X' } } }]), /fields is required/);
  assert.throws(() => f.batch([{ addNamedRange: { namedRange: { name: 'Wide', range: f.grid(sheet, 0, 1, 0, 40) } } }]), /The range exceeds the grid limits/);
  f.batch([{ deleteNamedRange: { namedRangeId: id } }]);
  assert.deepEqual(f.namedRanges(), []);
  assert.throws(() => f.batch([{ deleteNamedRange: { namedRangeId: id } }]), /deleteNamedRange: No named range with id/);
});

test('duplicateSheet copies a tab and deleteSheet turns references to it into #REF!', () => {
  const f = fixture(), sheet = f.sheet, summary = f.addTab('Summary');
  f.setCell(sheet, 1, 1, 5);
  f.setCell(sheet, 1, 2, '=A1*2', '=A1*2');
  f.setCell(summary, 1, 1, '=Output!A1+1', '=Output!A1+1');
  f.batch([
    { mergeCells: { range: f.grid(sheet, 2, 3, 0, 2), mergeType: 'MERGE_ALL' } },
    { updateCells: { range: f.grid(sheet, 0, 1, 0, 1), rows: [{ values: [{ note: 'n', userEnteredFormat: { textFormat: { bold: true } } }] }], fields: 'note,userEnteredFormat' } },
    { addConditionalFormatRule: { rule: { ranges: [f.grid(sheet, 0, 5, 0, 1)], gradientRule: { minpoint: { type: 'MIN', color: { red: 1 } }, maxpoint: { type: 'MAX', color: { green: 1 } } } } } },
  ]);
  const reply = f.batch([{ duplicateSheet: { sourceSheetId: sheet.id, insertSheetIndex: 1, newSheetId: 500 } }]).replies[0];
  assert.deepEqual(reply, { duplicateSheet: { properties: { sheetId: 500, title: 'Copy of Output', index: 1, sheetType: 'GRID', gridProperties: { rowCount: 100, columnCount: 26 } } } });
  const copy = f.tab('Copy of Output');
  assert.deepEqual(f.state.books.get(f.book.id).sheets.map((tab) => tab.name), ['Output', 'Copy of Output', 'Summary']);
  assert.deepEqual([f.value(copy, 1, 1), f.formula(copy, 1, 2), f.meta(copy, 1, 1), f.format(copy, 1, 1), f.merges(copy)],
    [5, '=A1*2', { note: 'n' }, { textFormat: { bold: true } }, ['A3:B3']]);
  assert.deepEqual(f.conditionalFormats(copy)[0].ranges, [f.grid(copy, 0, 5, 0, 1)]);
  assert.equal(f.batch([{ duplicateSheet: { sourceSheetId: sheet.id } }]).replies[0].duplicateSheet.properties.title, 'Copy of Output 2');
  assert.throws(() => f.batch([{ duplicateSheet: { sourceSheetId: sheet.id, newSheetName: 'Summary' } }]), /already exists/);

  f.batch([{ deleteSheet: { sheetId: sheet.id } }]);
  assert.equal(f.formula(summary, 1, 1), '=#REF!+1');
  assert.equal(f.value(summary, 1, 1), '#REF!');
  const tabs = f.state.books.get(f.book.id).sheets;
  assert.throws(() => f.batch(tabs.map((tab) => ({ updateSheetProperties: { properties: { sheetId: tab.id, hidden: true }, fields: 'hidden' } }))),
    /You can't hide or remove all the visible sheets/);
  f.batch(tabs.slice(1).map((tab) => ({ updateSheetProperties: { properties: { sheetId: tab.id, hidden: true }, fields: 'hidden' } })));
  assert.throws(() => f.batch([{ deleteSheet: { sheetId: tabs[0].id } }]), /You can't hide or remove all the visible sheets/);
  // Without insertSheetIndex the copy goes first, as the API's default index 0 says.
  assert.deepEqual(f.get({ fields: 'sheets.properties(title,hidden)' }).sheets,
    [{ properties: { title: 'Copy of Output 2' } }, { properties: { title: 'Copy of Output', hidden: true } }, { properties: { title: 'Summary', hidden: true } }]);
});

test('conditional format rules are added, replaced, moved and deleted with the API replies', () => {
  const f = fixture(), sheet = f.sheet;
  const ranges = [f.grid(sheet, 1, 50, 3, 4)];
  const cpa = { ranges, booleanRule: { condition: { type: 'NUMBER_GREATER', values: [{ userEnteredValue: '50' }] }, format: { backgroundColor: { red: 0.96, green: 0.8, blue: 0.8 }, textFormat: { bold: true, foregroundColor: { red: 0.6 } } } } };
  const scale = { ranges, gradientRule: { minpoint: { type: 'MIN', color: { green: 0.7 } }, midpoint: { type: 'PERCENTILE', value: '50', color: { red: 1, green: 1 } }, maxpoint: { type: 'MAX', color: { red: 0.9 } } } };
  const recent = { ranges, booleanRule: { condition: { type: 'DATE_AFTER', values: [{ relativeDate: 'PAST_WEEK' }] }, format: { textFormat: { italic: true } } } };
  assert.deepEqual(f.batch([{ addConditionalFormatRule: { rule: cpa, index: 0 } }, { addConditionalFormatRule: { rule: scale, index: 1 } }, { addConditionalFormatRule: { rule: recent } }]).replies, [{}, {}, {}]);
  assert.deepEqual(f.get({ fields: 'sheets(properties.sheetId,conditionalFormats)' }).sheets[0].conditionalFormats, [recent, cpa, scale].map(plain));
  const moved = f.batch([{ updateConditionalFormatRule: { sheetId: sheet.id, index: 0, newIndex: 2 } }]).replies[0];
  assert.deepEqual(moved, { updateConditionalFormatRule: { newRule: recent, newIndex: 2 } }, 'oldIndex 0 is omitted like any zero');
  const replaced = f.batch([{ updateConditionalFormatRule: { index: 1, rule: { ...cpa, booleanRule: { ...cpa.booleanRule, condition: { type: 'TEXT_CONTAINS', values: [{ userEnteredValue: 'x' }] } } } } }]).replies[0];
  assert.deepEqual(replaced.updateConditionalFormatRule.oldRule, scale);
  assert.equal(replaced.updateConditionalFormatRule.newIndex, 1);
  assert.deepEqual(f.batch([{ deleteConditionalFormatRule: { sheetId: sheet.id, index: 2 } }]).replies[0], { deleteConditionalFormatRule: { rule: recent } });
  assert.equal(f.conditionalFormats(sheet).length, 2);
  for (const [rule, message] of [
    [{ ...cpa, booleanRule: { ...cpa.booleanRule, format: { numberFormat: { type: 'NUMBER' } } } }, /can only set bold, italic/],
    [{ ...cpa, booleanRule: { ...cpa.booleanRule, format: { textFormat: { fontSize: 14 } } } }, /can only set bold, italic/],
    [{ ...cpa, booleanRule: { condition: { type: 'ONE_OF_LIST', values: [{ userEnteredValue: 'a' }] } } }, /ONE_OF_LIST is not supported for conditional formatting/],
    [{ ...cpa, booleanRule: { condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: '=$D2>50' }] }, format: { backgroundColor: { red: 2 } } } }, /Color components are numbers from 0 to 1/],
    [{ ranges, gradientRule: { minpoint: { type: 'MAX', color: red }, maxpoint: { type: 'MAX', color: red } } }, /Invalid minpoint type MAX/],
    [{ ranges, gradientRule: { minpoint: { type: 'PERCENT', value: '150', color: red }, maxpoint: { type: 'MAX', color: red } } }, /Invalid minpoint value 150/],
    [{ ranges, gradientRule: { minpoint: { type: 'NUMBER', color: red }, maxpoint: { type: 'MAX', color: red } } }, /The minpoint needs a value/],
    [{ ...cpa, gradientRule: scale.gradientRule }, /exactly one of booleanRule or gradientRule/],
    [{ ...cpa, ranges: [] }, /needs at least one range/],
    [{ ...cpa, ranges: [...ranges, f.grid(f.addTab('Elsewhere'), 0, 1, 0, 1)] }, /must be on the same sheet/],
  ]) assert.throws(() => f.batch([{ addConditionalFormatRule: { rule } }]), message);
  assert.throws(() => f.batch([{ addConditionalFormatRule: { rule: cpa, index: 9 } }]), /Invalid conditional format index 9/);
  assert.throws(() => f.batch([{ deleteConditionalFormatRule: { sheetId: sheet.id, index: 5 } }]), /No conditional format on sheet/);
  assert.throws(() => f.batch([{ updateConditionalFormatRule: { sheetId: sheet.id, index: 0 } }]), /Set exactly one of rule or newIndex/);
});

test('a pivot table written through updateCells is checked, kept and read back like the API', () => {
  const f = fixture(), sheet = f.sheet, pivots = f.addTab('Pivot');
  const pivot = {
    source: f.grid(sheet, 0, 20, 0, 4),
    rows: [{ sourceColumnOffset: 0, showTotals: true, sortOrder: 'ASCENDING' }],
    columns: [{ sourceColumnOffset: 1, sortOrder: 'DESCENDING', groupRule: { dateTimeRule: { type: 'YEAR_MONTH' } } }],
    values: [{ sourceColumnOffset: 3, summarizeFunction: 'SUM', calculatedDisplayType: 'PERCENT_OF_GRAND_TOTAL' }, { formula: '=SUM(Spend)/SUM(Clicks)', summarizeFunction: 'CUSTOM' }],
    filterSpecs: [{ columnOffsetIndex: 2, filterCriteria: { visibleValues: ['Search'] } }],
    valueLayout: 'HORIZONTAL',
  };
  const write = (value) => f.batch([{ updateCells: { start: { sheetId: pivots.id, rowIndex: 0, columnIndex: 0 }, rows: [{ values: [{ pivotTable: value }] }], fields: 'pivotTable' } }]);
  write(pivot);
  const read = f.get({ ranges: ['Pivot!A1'], fields: 'sheets(properties.title,data.rowData.values.pivotTable)' }).sheets;
  assert.equal(read.length, 1, 'ranges limit the answer to their tabs');
  const back = read[0].data[0].rowData[0].values[0].pivotTable;
  assert.deepEqual(back.rows, [{ showTotals: true, sortOrder: 'ASCENDING' }], 'a zero sourceColumnOffset is omitted on read');
  assert.deepEqual(back.source, { sheetId: sheet.id, endRowIndex: 20, endColumnIndex: 4 });
  assert.deepEqual(back.values, pivot.values);
  for (const [change, message] of [
    [{ values: [{ sourceColumnOffset: 4, summarizeFunction: 'SUM' }] }, /A pivot value column is outside the pivot source range/],
    [{ values: [{ sourceColumnOffset: 3, summarizeFunction: 'TOTAL' }] }, /Invalid summarize function TOTAL/],
    [{ values: [{ summarizeFunction: 'CUSTOM' }] }, /CUSTOM is only valid with a pivot value formula/],
    [{ rows: [{ sourceColumnOffset: 0, sortOrder: 'UP' }] }, /Invalid sort order UP/],
    [{ columns: [{ sourceColumnOffset: 1, groupRule: { dateTimeRule: { type: 'WEEK' } } }] }, /Invalid date-time rule WEEK/],
    [{ source: f.grid(sheet, 0, 200, 0, 4) }, /The pivot source range exceeds the grid limits/],
    [{ valueLayout: 'DIAGONAL' }, /Invalid value layout DIAGONAL/],
  ]) assert.throws(() => write({ ...pivot, ...change }), message);
  f.batch([{ updateCells: { range: f.grid(pivots, 0, 1, 0, 1), fields: 'pivotTable' } }]);
  assert.deepEqual(f.meta(pivots, 1, 1), {}, 'an update without a pivot removes it');
});

test('smart chips read back with their plain runs, write only as chips and go when a value is written', () => {
  const f = fixture(), sheet = f.sheet;
  const person = { personProperties: { email: 'ana@example.com' } };
  const write = (value, fields = 'userEnteredValue,chipRuns') =>
    f.batch([{ updateCells: { range: f.grid(sheet, 0, 1, 0, 1), rows: [{ values: [value] }], fields } }]);
  write({ userEnteredValue: { stringValue: 'Owner @ today' }, chipRuns: [{ startIndex: 6, chip: person }] });
  const read = () => f.get({ ranges: ['Output!A1'], fields: 'sheets.data.rowData.values(userEnteredValue,chipRuns)' })
    .sheets[0].data[0].rowData[0].values[0];
  // Reads include the runs without a chip, with an empty chip.
  assert.deepEqual(read().chipRuns, [{ chip: {} }, { startIndex: 6, chip: person }, { startIndex: 7, chip: {} }]);
  for (const [runs, message] of [
    [[{ startIndex: 0, chip: {} }], /A chip run needs a person or a rich link chip/],
    [[{ startIndex: 0, chip: person }], /A chip run must start at an @ placeholder/],
    [[{ startIndex: 6, chip: { richLinkProperties: { uri: 'https://www.youtube.com/watch?v=x' } } }], /Only Drive files can be written as chips/],
  ]) assert.throws(() => write({ userEnteredValue: { stringValue: 'Owner @ today' }, chipRuns: runs }), message);
  write({ userEnteredValue: { stringValue: 'Owner @ today' }, chipRuns: [{ startIndex: 6, chip: { richLinkProperties: { uri: 'https://docs.google.com/document/d/abc/edit' } } }] });
  assert.equal(read().chipRuns.length, 3, 'a Drive file is written as a chip');
  // Writing a new userEnteredValue erases the runs.
  write({ userEnteredValue: { stringValue: 'Owner @ today' } }, 'userEnteredValue');
  assert.equal(read().chipRuns, undefined);
});

test('formula errors read back with their type and Sheets message; values and formats read back typed', () => {
  const f = fixture(), sheet = f.sheet;
  f.setError(sheet, 1, 1, { type: 'REF', message: 'Reference does not exist.' }, "=VLOOKUP(A2,'Old'!A:B,2,FALSE)");
  f.setError(sheet, 1, 2, { type: 'DIVIDE_BY_ZERO', message: 'Function DIVIDE parameter 2 cannot be zero.' }, '=B2/0');
  f.setError(sheet, 1, 3, { type: 'N_A', message: 'Did not find value \'x\' in VLOOKUP evaluation.' }, '=VLOOKUP("x",A:A,1,0)');
  f.setCell(sheet, 2, 1, 0);
  f.setCell(sheet, 2, 2, false);
  f.setCell(sheet, 2, 3, 12.5, '=B2+12.5');
  f.setCell(sheet, 2, 4, new Date('2026-03-01T00:00:00+02:00'));
  assert.deepEqual(f.api.SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Output').getRange(1, 1, 1, 3).getValues(), [['#REF!', '#DIV/0!', '#N/A']]);
  const rows = f.get({ ranges: ["'Output'!A1:D3"], fields: 'sheets.data(startRow,rowData.values(userEnteredValue,effectiveValue,formattedValue))' }).sheets[0].data[0].rowData;
  assert.deepEqual(rows[0].values[0], {
    userEnteredValue: { formulaValue: "=VLOOKUP(A2,'Old'!A:B,2,FALSE)" },
    effectiveValue: { errorValue: { type: 'REF', message: 'Reference does not exist.' } },
    formattedValue: '#REF!',
  });
  assert.equal(rows[0].values[1].effectiveValue.errorValue.type, 'DIVIDE_BY_ZERO');
  assert.deepEqual(rows[1].values, [
    { userEnteredValue: { numberValue: 0 }, effectiveValue: { numberValue: 0 }, formattedValue: '0' },
    { userEnteredValue: { boolValue: false }, effectiveValue: { boolValue: false }, formattedValue: 'FALSE' },
    { userEnteredValue: { formulaValue: '=B2+12.5' }, effectiveValue: { numberValue: 12.5 }, formattedValue: '12.5' },
    { userEnteredValue: { numberValue: 46082 }, effectiveValue: { numberValue: 46082 }, formattedValue: '2026-03-01' },
  ]);
  assert.equal(rows.length, 2, 'trailing empty rows are left out');
  assert.throws(() => f.setError(sheet, 1, 1, { type: 'OOPS' }), /Unknown error type OOPS/);
});

test('spreadsheets.get with gridData follows field masks, ranges and named ranges', () => {
  const f = fixture(), sheet = f.sheet, other = f.addTab("Bob's data", 10, 5);
  f.setCell(other, 2, 2, 'x');
  f.batch([
    { updateDimensionProperties: { range: { sheetId: other.id, dimension: 'COLUMNS', startIndex: 1, endIndex: 2 }, properties: { pixelSize: 140 }, fields: 'pixelSize' } },
    { addNamedRange: { namedRange: { namedRangeId: 'b', name: 'Block', range: f.grid(other, 1, 3, 1, 3) } } },
  ]);
  assert.deepEqual(f.get({ fields: 'sheets.properties.title' }), { sheets: [{ properties: { title: 'Output' } }, { properties: { title: "Bob's data" } }] });
  const all = f.get();
  assert.equal(all.sheets[0].data, undefined, 'no grid data unless asked for');
  assert.deepEqual(all.sheets[1].properties, { sheetId: other.id, title: "Bob's data", index: 1, sheetType: 'GRID', gridProperties: { rowCount: 10, columnCount: 5 } });
  assert.equal(all.properties.timeZone, 'Europe/Athens');
  const block = f.get({ ranges: ["'Bob''s data'!B2:C3"], includeGridData: true }).sheets[0].data[0];
  assert.deepEqual([block.startRow, block.startColumn, block.rowData, block.columnMetadata],
    [1, 1, [{ values: [{ userEnteredValue: { stringValue: 'x' }, effectiveValue: { stringValue: 'x' }, formattedValue: 'x' }] }], [{ pixelSize: 140 }, { pixelSize: 100 }]]);
  assert.deepEqual(f.get({ ranges: ['Block'], fields: 'sheets.data.rowData.values.formattedValue' }).sheets[0].data[0].rowData, [{ values: [{ formattedValue: 'x' }] }]);
  assert.deepEqual(f.get({ ranges: ['A1:B2'], fields: 'sheets.properties.title' }).sheets, [{ properties: { title: 'Output' } }]);
  assert.deepEqual(f.get({ ranges: ["'Bob''s data'!C:C", 'Output!2:3'], fields: 'sheets(properties.title,data(startRow,startColumn))' }).sheets,
    [{ properties: { title: 'Output' }, data: [{ startRow: 1 }] }, { properties: { title: "Bob's data" }, data: [{ startColumn: 2 }] }]);
  assert.throws(() => f.get({ ranges: ["'Bob''s data'!A1:A20"] }), /exceeds grid limits\. Max rows: 10, max columns: 5/);
  assert.throws(() => f.get({ ranges: ['Nowhere!A1'] }), /Unable to parse range: Nowhere!A1/);
  assert.equal(sheet.name, 'Output');
});

test('one invalid request fails the whole batch and nothing earlier in it is applied', () => {
  const f = fixture(), sheet = f.sheet;
  f.setCell(sheet, 1, 1, ' keep ');
  f.setCell(sheet, 1, 2, '=A1', '=A1');
  const before = f.get({ includeGridData: true });
  assert.throws(() => f.batch([
    { trimWhitespace: { range: f.grid(sheet, 0, 1, 0, 1) } },
    { insertDimension: { range: { sheetId: sheet.id, dimension: 'ROWS', startIndex: 0, endIndex: 3 } } },
    { addNamedRange: { namedRange: { name: 'Kept', range: f.grid(sheet, 0, 1, 0, 1) } } },
    { addConditionalFormatRule: { rule: { ranges: [f.grid(sheet, 0, 1, 0, 1)], booleanRule: { condition: { type: 'BLANK' } } } } },
    { addDimensionGroup: { range: { sheetId: sheet.id, dimension: 'ROWS', startIndex: 0, endIndex: 2 } } },
    { duplicateSheet: { sourceSheetId: sheet.id } },
    { findReplace: { find: 'keep', replacement: 'x' } },
  ]), /^Error: Invalid requests\[6\]\.findReplace: Set exactly one of range, sheetId or allSheets\.$/);
  assert.deepEqual(f.get({ includeGridData: true }), before);
  assert.deepEqual([f.value(sheet, 1, 1), f.formula(sheet, 1, 2), sheet.maxRows, f.namedRanges(), f.conditionalFormats(sheet), f.groups(sheet)],
    [' keep ', '=A1', 100, [], [], []]);
});

test('developer metadata on a tab is created, read back by field mask, deleted by lookup and goes with its tab', () => {
  for (const settings of [{ gridData: true }, {}]) {
    const f = fixture(settings), sheet = f.sheet;
    const other = f.book.insertSheet('Other');
    const create = (sheetId, metadataValue, extra = {}) =>
      ({ createDeveloperMetadata: { developerMetadata: { metadataKey: 'k', metadataValue, location: { sheetId }, visibility: 'PROJECT', ...extra } } });
    assert.deepEqual(f.batch([create(sheet.id, 'one'), create(other.id, 'two')]).replies.map((reply) => reply.createDeveloperMetadata.developerMetadata),
      [{ metadataId: 1, metadataKey: 'k', metadataValue: 'one', location: { locationType: 'SHEET', sheetId: sheet.id }, visibility: 'PROJECT' },
        { metadataId: 2, metadataKey: 'k', metadataValue: 'two', location: { locationType: 'SHEET', sheetId: other.id }, visibility: 'PROJECT' }]);
    const read = () => f.get({ fields: 'sheets(properties.sheetId,developerMetadata(metadataId,metadataValue))' }).sheets
      .map((item) => (item.developerMetadata || []).map((metadata) => metadata.metadataValue));
    assert.deepEqual(read(), [['one'], ['two']]);
    assert.equal(f.get({ fields: 'sheets.properties' }).sheets[0].developerMetadata, undefined, 'only when the mask asks');
    assert.throws(() => f.batch([create(sheet.id, 'x', { visibility: undefined })]), /requests\[0\]\.createDeveloperMetadata: Invalid visibility/);
    assert.throws(() => f.batch([create(sheet.id, 'x', { metadataId: 1 })]), /duplicate metadata ID 1/);
    assert.throws(() => f.batch([create(sheet.id, 'x'.repeat(30000))]), /at most 30,000 characters/);
    const deleted = f.batch([{ deleteDeveloperMetadata: { dataFilter: { developerMetadataLookup: { metadataId: 1 } } } }]);
    assert.deepEqual(deleted.replies[0].deleteDeveloperMetadata.deletedDeveloperMetadata.map((item) => item.metadataId), [1]);
    assert.deepEqual(read(), [[], ['two']]);
    f.batch([{ deleteSheet: { sheetId: other.id } }]);
    assert.deepEqual(read(), [[]], 'metadata on a tab is deleted with it');
  }
});

test('getSheetByName finds a tab without regard to case, as Apps Script does', () => {
  const f = fixture();
  assert.equal(f.book.getSheetByName('output'), f.sheet);
  assert.equal(f.book.getSheetByName('OUTPUT'), f.sheet);
  assert.equal(f.book.getSheetByName('Outputs'), null);
});
