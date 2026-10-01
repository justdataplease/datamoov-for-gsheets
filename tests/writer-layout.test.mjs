import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatamoovSandbox } from './helpers/datamoov-sandbox.mjs';

const rgb = (hex) => ({ red: parseInt(hex.slice(1, 3), 16) / 255, green: parseInt(hex.slice(3, 5), 16) / 255, blue: parseInt(hex.slice(5, 7), 16) / 255 });
const grid = (rows, columns, fill = (r, c) => (c ? '' : `r${r}`)) => Array.from({ length: rows }, (_, r) => Array.from({ length: columns }, (_, c) => fill(r, c)));

function fixture() {
  const f = createDatamoovSandbox();
  f.output = (id, matrix, layout, sheetName = 'Page', startCell = 'A1') => ({
    report: { id, spreadsheetId: f.book.id, target: { sheetName, startCell } },
    result: { columns: [], matrix, layout },
  });
  f.write = (...outputs) => f.api.dmvWriteReports_(f.book, outputs);
  f.requests = (batch = f.state.batches.length - 1) => f.state.batches[batch].body.requests;
  f.merge = (sheet, startRowIndex, endRowIndex, startColumnIndex, endColumnIndex) =>
    f.api.Sheets.Spreadsheets.batchUpdate({ requests: [{ mergeCells: { range: { sheetId: sheet.id, startRowIndex, endRowIndex, startColumnIndex, endColumnIndex }, mergeType: 'MERGE_ALL' } }] }, f.book.id);
  return f;
}

test('number columns take whole, small or two-decimal patterns from the written values', () => {
  const f = fixture();
  const result = f.api.dmvNormalizeResult_({
    columns: ['whole', 'small', 'mixed', 'empty', 'money', 'share', 'name'].map((key) => ({ key, type: { money: 'currency', share: 'percent', name: 'text' }[key] || 'number' })),
    rows: [
      { whole: 2494, small: 0.1234, mixed: 1.5, money: 3, share: 0.5, name: 'A' },
      { whole: -18, small: -0.5, mixed: 2000, money: 4.25, share: 0.25, name: 'B' },
    ],
  }, 10);
  f.api.dmvWriteReport_(f.book, { id: 'plain', spreadsheetId: f.book.id, target: { sheetName: 'Output', startCell: 'A1' } }, result);
  const sheet = f.tab('Output');
  const patterns = [1, 2, 3, 4, 5, 6, 7].map((column) => f.format(sheet, 3, column).numberFormat);
  assert.deepEqual(patterns, [
    { type: 'NUMBER', pattern: '#,##0' },
    { type: 'NUMBER', pattern: '0.0000' },
    { type: 'NUMBER', pattern: '#,##0.00' },
    { type: 'NUMBER', pattern: '#,##0' },
    { type: 'NUMBER', pattern: '#,##0.00' },
    { type: 'PERCENT', pattern: '0.00%' },
    { type: 'TEXT', pattern: '@' },
  ]);
  assert.deepEqual(f.format(sheet, 1, 1), { textFormat: { bold: true }, backgroundColor: { red: 0.93, green: 0.95, blue: 1 } });
  assert.ok(!JSON.stringify(f.requests()).includes('#,##0.###'));
  assert.ok(!f.requests().some((request) => request.unmergeCells || request.updateDimensionProperties), 'plain reports leave merges and sizes alone');
});

test('explicit patterns win over table column and style types', () => {
  const f = fixture();
  const delta = '"▲ "0.0%;"▼ "0.0%;"▶ "0.0%';
  f.write(f.output('page', [['Count', 'Change', 'Cost', 'Rate'], [12, 0.1, 3, 0.25], [7, -0.2, 4, 0.5], [1234.5, '', '', '']], {
    tables: [{ row: 0, rows: 3, columns: [{ type: 'number', pattern: '0.0' }, { type: 'percent', pattern: delta }, { type: 'currency' }, { type: 'number' }] }],
    styles: [{ row: 3, style: 'kpiValue', type: 'currency', pattern: '#,##0' }],
  }));
  const sheet = f.tab('Page');
  assert.deepEqual([1, 2, 3, 4].map((column) => f.format(sheet, 2, column).numberFormat), [
    { type: 'NUMBER', pattern: '0.0' },
    { type: 'PERCENT', pattern: delta },
    { type: 'NUMBER', pattern: '#,##0.00' },
    { type: 'NUMBER', pattern: '0.0000' },
  ]);
  assert.deepEqual(f.format(sheet, 4, 1), { textFormat: { bold: true, fontSize: 18 }, numberFormat: { type: 'NUMBER', pattern: '#,##0' } });
});

test('column widths apply on every write and row heights reset over the previous area first', () => {
  const f = fixture();
  f.write(f.output('page', grid(5, 4), { columnWidths: [20, 104, 104, 20], rowHeights: [{ row: 0, height: 40 }, { row: 2, rows: 2, height: 30 }] }));
  const sheet = f.tab('Page');
  assert.deepEqual([1, 2, 3, 4, 5].map((column) => f.pixelSize(sheet, 'COLUMNS', column)), [20, 104, 104, 20, 100]);
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((row) => f.pixelSize(sheet, 'ROWS', row)), [40, 21, 30, 30, 21, 21]);
  assert.equal(f.requests().filter((request) => request.updateDimensionProperties?.range.dimension === 'COLUMNS').length, 3, 'equal neighbours share a request');
  f.write(f.output('page', grid(3, 4), { columnWidths: [30], rowHeights: [{ row: 1, height: 50 }] }));
  assert.deepEqual([1, 2, 3, 4].map((column) => f.pixelSize(sheet, 'COLUMNS', column)), [30, 104, 104, 20]);
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((row) => f.pixelSize(sheet, 'ROWS', row)), [21, 50, 21, 21, 21, 21], 'rows the smaller page left lose their heights');
  f.write(f.output('page', grid(3, 4), { columnWidths: [30] }));
  assert.equal(f.pixelSize(sheet, 'ROWS', 2), 50, 'a layout without rowHeights leaves row heights alone');
});

test('merges are re-made after the layout moves and owned merged output passes the ownership digest', () => {
  const f = fixture();
  const title = (rows) => grid(rows, 4, (r, c) => (c === 0 || (c === 2 && r) ? `r${r}c${c}` : ''));
  f.write(f.output('page', title(4), { merges: [{ row: 0, column: 0, rows: 1, columns: 4 }, { row: 1, column: 0, rows: 3, columns: 2, type: 'ROWS' }] }));
  const sheet = f.tab('Page');
  assert.deepEqual(f.merges(sheet), ['A1:D1', 'A2:B2', 'A3:B3', 'A4:B4']);
  assert.equal(f.value(sheet, 1, 1), 'r0c0');
  // The new title merge cuts through the old one, so the old merges go first, in one request over
  // the box that holds them all.
  f.write(f.output('page', grid(4, 4, (r, c) => ((c === 1 && r === 0) || (c === 0 && r && r !== 2) ? `r${r}c${c}` : '')), {
    merges: [{ row: 0, column: 1, rows: 1, columns: 3 }, { row: 1, column: 0, rows: 2, columns: 2 }],
  }));
  assert.deepEqual(f.merges(sheet), ['B1:D1', 'A2:B3']);
  const requests = f.requests();
  const unmerged = requests.filter((request) => request.unmergeCells).map((request) => request.unmergeCells.range);
  assert.deepEqual(unmerged.map((range) => [range.startRowIndex, range.endRowIndex, range.startColumnIndex, range.endColumnIndex]), [[0, 4, 0, 4]]);
  assert.ok(requests.findIndex((request) => request.unmergeCells) < requests.findIndex((request) => request.updateCells));
  assert.equal(requests.findLastIndex((request) => request.mergeCells), requests.length - 1, 'merges come last');
  // A third refresh reads the merged cells back and still recognizes its own output.
  f.write(f.output('page', grid(2, 4), {}));
  assert.deepEqual(f.merges(sheet), []);
  assert.equal(f.value(sheet, 4, 1), '', 'the shrunken page cleared its old rows');
  assert.ok(f.state.gets.every((get) => /merges/.test(get.options.fields)));
  assert.equal(f.state.gets.length, 3, 'one metadata request per write');
});

test('existing merges that straddle the area edge are removed by their exact ranges', () => {
  const f = fixture(),
    sheet = f.tab('Output');
  f.merge(sheet, 2, 5, 3, 6); // D3:F5 reaches into the A1:E4 area
  f.merge(sheet, 10, 12, 0, 2); // A11:B12 stays outside
  f.write(f.output('page', grid(4, 5), { merges: [{ row: 0, column: 0, rows: 1, columns: 5 }] }, 'Output'));
  assert.deepEqual(f.merges(sheet), ['A1:E1', 'A11:B12']);
  const range = f.requests().find((request) => request.unmergeCells).unmergeCells.range;
  assert.deepEqual([range.startRowIndex, range.endRowIndex, range.startColumnIndex, range.endColumnIndex], [2, 5, 3, 6]);
});

test('merges go by their exact ranges when their box would reach another merge', () => {
  const f = fixture(),
    sheet = f.tab('Output');
  f.merge(sheet, 0, 1, 0, 2); // A1:B1 inside the A1:E4 area
  f.merge(sheet, 2, 5, 3, 6); // D3:F5 reaches into it
  f.merge(sheet, 4, 5, 1, 3); // B5:C5 lies outside the area but inside the box of the two
  f.write(f.output('page', grid(4, 5), {}, 'Output'));
  const unmerged = f.requests().filter((request) => request.unmergeCells).map((request) => request.unmergeCells.range);
  assert.deepEqual(unmerged.map((range) => [range.startRowIndex, range.endRowIndex, range.startColumnIndex, range.endColumnIndex]), [[0, 1, 0, 2], [2, 5, 3, 6]]);
  assert.deepEqual(f.merges(sheet), ['B5:C5']);
});

test('a page of row merges unmerges them in one request on every refresh', () => {
  const f = fixture();
  const page = (rows) => f.output('page', grid(rows, 3), { merges: [{ row: 0, column: 0, rows, columns: 2, type: 'ROWS' }] });
  f.write(page(500));
  assert.equal(f.merges(f.tab('Page')).length, 500);
  for (const rows of [500, 400]) {
    f.write(page(rows));
    assert.equal(f.requests().filter((request) => request.unmergeCells).length, 1);
    assert.equal(f.merges(f.tab('Page')).length, rows);
  }
});

test('two outputs on one tab unmerge a shared merge once and each its own', () => {
  const f = fixture(),
    sheet = f.tab('Output');
  f.merge(sheet, 0, 4, 0, 2); // A1:B4 spans both output areas
  f.merge(sheet, 5, 7, 1, 3); // B6:C7 reaches only the second
  f.write(
    f.output('top', grid(3, 2), { merges: [{ row: 0, column: 0, rows: 1, columns: 2 }] }, 'Output', 'A1'),
    f.output('bottom', grid(3, 2), { merges: [{ row: 1, column: 0, rows: 1, columns: 2 }] }, 'Output', 'A4')
  );
  assert.equal(f.requests().filter((request) => request.unmergeCells).length, 2);
  assert.deepEqual(f.merges(sheet), ['A1:B1', 'A5:B5'], 'the second output keeps the merge the first one made');
});

test('formats apply in order and links point at rows of the real tab', () => {
  const f = fixture();
  f.write(f.output('page', grid(5, 3), {
    tables: [{ row: 3, rows: 2, columns: [{ type: 'text' }, { type: 'number' }, { type: 'number' }] }],
    formats: [
      { row: 0, column: 0, columns: 3, format: { background: '#0d366b', color: '#FFFFFF', bold: true, fontSize: 20 } },
      { row: 0, column: 2, format: { background: '#f4f6fa' } },
      { row: 1, column: 0, format: { link: { row: 3 }, color: '#2a78d6' } },
      { row: 2, column: 1, format: { align: 'RIGHT', valign: 'MIDDLE', wrap: 'CLIP', italic: true, padding: { top: 4, left: 8 }, numberFormat: { type: 'NUMBER', pattern: '#,##0' } } },
      { row: 3, column: 0, columns: 3, format: { background: '#eef4fd' } },
    ],
  }, 'Page', 'B3'));
  const sheet = f.tab('Page');
  assert.deepEqual(f.format(sheet, 3, 2), { backgroundColor: rgb('#0d366b'), textFormat: { foregroundColor: rgb('#ffffff'), bold: true, fontSize: 20 } });
  assert.deepEqual(f.format(sheet, 3, 4), { backgroundColor: rgb('#f4f6fa'), textFormat: { foregroundColor: rgb('#ffffff'), bold: true, fontSize: 20 } }, 'a later format overrides only what it names');
  assert.deepEqual(f.format(sheet, 4, 2).textFormat, { link: { uri: `#gid=${sheet.id}&range=A6` }, foregroundColor: rgb('#2a78d6') });
  assert.deepEqual(f.format(sheet, 5, 3), { horizontalAlignment: 'RIGHT', verticalAlignment: 'MIDDLE', wrapStrategy: 'CLIP', textFormat: { italic: true }, padding: { top: 4, left: 8 }, numberFormat: { type: 'NUMBER', pattern: '#,##0' } });
  assert.deepEqual(f.format(sheet, 6, 3), { textFormat: { bold: true }, backgroundColor: rgb('#eef4fd') }, 'formats come after the table header');
  f.write(f.output('page', grid(5, 3), {}, 'Page', 'B3'));
  assert.deepEqual(f.format(sheet, 3, 2), {}, 'a refresh clears the previous layout formats');
  assert.deepEqual(f.format(sheet, 4, 2), {});
});

test('a paint gives each cell of a column its own colour in one request after the formats', () => {
  const f = fixture();
  f.write(f.output('page', grid(4, 2), {
    formats: [{ row: 0, column: 0, rows: 4, columns: 2, format: { background: '#ffffff', color: '#1f2328', bold: true } }],
    paints: [
      { row: 1, column: 1, background: ['#e6f0fc', '#ffffff', '#9ec5f4'] },
      { row: 0, column: 0, color: ['#006300', '#c62828'] },
    ],
  }));
  const sheet = f.tab('Page');
  const painted = f.requests().filter((request) => request.updateCells && request.updateCells.fields !== 'userEnteredValue');
  assert.deepEqual(painted.map((request) => request.updateCells.fields), ['userEnteredFormat.backgroundColor', 'userEnteredFormat.textFormat.foregroundColor']);
  assert.deepEqual([2, 3, 4].map((row) => f.format(sheet, row, 2).backgroundColor), [rgb('#e6f0fc'), rgb('#ffffff'), rgb('#9ec5f4')]);
  assert.deepEqual(f.format(sheet, 1, 2).backgroundColor, rgb('#ffffff'), 'rows above the paint keep their format');
  assert.deepEqual(f.format(sheet, 2, 1).textFormat, { foregroundColor: rgb('#c62828'), bold: true }, 'a paint changes only its colour');
  assert.deepEqual(f.format(sheet, 3, 1).textFormat, { foregroundColor: rgb('#1f2328'), bold: true });
});

test('borders draw outer sides and inner lines and a refresh removes them', () => {
  const f = fixture();
  const solid = (color, style = 'SOLID') => ({ style, color });
  f.write(f.output('page', grid(3, 2), {
    borders: [{ row: 0, column: 0, rows: 3, columns: 2, bottom: solid('#e1e5ec'), innerHorizontal: solid('#e8ebf0'), left: solid('#f4f6fa', 'SOLID_THICK'), top: { style: 'NONE' } }],
  }));
  const sheet = f.tab('Page');
  const request = f.requests().find((item) => item.updateBorders).updateBorders;
  assert.deepEqual(request.top, { style: 'NONE' });
  assert.deepEqual(f.format(sheet, 1, 1).borders, { bottom: { style: 'SOLID', color: rgb('#e8ebf0') }, left: { style: 'SOLID_THICK', color: rgb('#f4f6fa') } });
  assert.deepEqual(f.format(sheet, 2, 2).borders, { top: { style: 'SOLID', color: rgb('#e8ebf0') }, bottom: { style: 'SOLID', color: rgb('#e8ebf0') } });
  assert.deepEqual(f.format(sheet, 3, 2).borders, { top: { style: 'SOLID', color: rgb('#e8ebf0') }, bottom: { style: 'SOLID', color: rgb('#e1e5ec') } });
  f.write(f.output('page', grid(3, 2), {}));
  assert.equal(f.format(sheet, 3, 2).borders, undefined);
});

test('malformed layouts throw before any batch, journal or tab', () => {
  const bad = [
    [{ formats: [{ row: 0, column: 0, format: { background: 'navy' } }] }, /#rrggbb/],
    [{ formats: [{ row: 0, column: 0, format: { link: { url: 'https://example.com' } } }] }, /Invalid layout format/],
    [{ formats: [{ row: 0, column: 0, format: { link: { row: 9 } } }] }, /Invalid layout format/],
    [{ formats: [{ row: 0, column: 0, format: {} }] }, /Invalid layout format/],
    [{ formats: [{ row: 0, column: 0, format: { shadow: true } }] }, /Unknown layout format key "shadow"/],
    [{ formats: [{ row: 0, column: 0, format: { align: 'JUSTIFY' } }] }, /Invalid layout format/],
    [{ formats: [{ row: 3, column: 0, format: { bold: true } }] }, /outside the output area/],
    [{ merges: [{ row: 0, column: 0, rows: 1, columns: 9 }] }, /outside the output area/],
    [{ merges: [{ row: 1, column: 0, rows: 1, columns: 1 }] }, /Invalid layout merge/],
    [{ merges: [{ row: 1, column: 0, rows: 2, columns: 2, type: 'COLUMNS' }] }, /Invalid layout merge/],
    [{ merges: [{ row: 0, column: 0, rows: 2, columns: 2 }] }, /content only in their first cell/],
    [{ merges: [{ row: 1, column: 0, rows: 2, columns: 2 }, { row: 2, column: 1, rows: 1, columns: 2 }] }, /overlap/],
    [{ paints: [{ row: 0, column: 0, background: [] }] }, /Invalid layout paint/],
    [{ paints: [{ row: 0, column: 0, background: ['#ffffff'], color: ['#000000'] }] }, /Invalid layout paint/],
    [{ paints: [{ row: 1, column: 0, color: ['#ffffff', '#ffffff', '#ffffff'] }] }, /outside the output area/],
    [{ paints: [{ row: 0, column: 0, color: ['red'] }] }, /#rrggbb/],
    [{ paints: [{ row: 0, column: 0, rows: 1, color: ['#ffffff'] }] }, /Unknown layout paint key "rows"/],
    [{ borders: [{ row: 0, column: 0, top: { style: 'WAVY', color: '#000000' } }] }, /Invalid layout border/],
    [{ borders: [{ row: 0, column: 0, top: { style: 'SOLID' } }] }, /#rrggbb/],
    [{ columnWidths: [1] }, /2 to 2000 pixels/],
    [{ columnWidths: [100, 100, 100, 100] }, /exceed the output/],
    [{ rowHeights: [{ row: 0, height: 30, color: '#ffffff' }] }, /Unknown layout row height key "color"/],
    [{ rowHeights: [{ row: 0, height: 2.5 }] }, /2 to 2000 pixels/],
    [{ charts: [] }, /Invalid layout member "charts"/],
    [{ styles: [{ row: 0, style: 'huge' }] }, /Unknown layout style "huge"/],
    [{ tables: [{ row: 0, rows: 2, columns: [{ type: 'number', pattern: '' }] }] }, /Invalid layout number pattern/],
  ];
  for (const [layout, error] of bad) {
    const f = fixture();
    const matrix = [['Title', 'x', ''], ['', '', ''], ['', '', '']];
    assert.throws(() => f.write(f.output('fine', grid(2, 2), {}, 'Fine'), f.output('page', matrix, layout)), error, JSON.stringify(layout));
    assert.equal(f.state.batches.length, 0);
    assert.equal(f.tab('Fine'), null);
    assert.equal(f.tab('Page'), null);
    assert.deepEqual(Object.keys(f.state.user.getProperties()), []);
  }
});

test('one write takes up to ten outputs and journal recovery accepts ten receipts', () => {
  const f = fixture();
  const outputs = (count) => Array.from({ length: count }, (_, i) => {
    const output = f.output('out' + i, [['Value'], [i]], undefined, 'Output', String.fromCharCode(65 + i) + '1');
    output.result.columns = [{ key: 'value', type: 'number' }];
    return output;
  });
  assert.throws(() => f.write(...outputs(11)), /between one and ten report outputs/);
  assert.equal(f.state.batches.length, 0);
  const set = f.state.user.setProperty;
  let fail = true;
  f.state.user.setProperty = function (key, value) {
    if (fail && key.includes(':output:')) throw new Error('Receipt outage');
    return set.call(this, key, value);
  };
  assert.throws(() => f.write(...outputs(10)), /receipts could not be saved/);
  assert.equal(JSON.parse(f.state.user.getProperty('dmv:v1:write-journal:' + f.book.id)).receipts.length, 10);
  fail = false;
  f.write(...outputs(10));
  assert.equal(f.state.user.getProperty('dmv:v1:write-journal:' + f.book.id), null);
  for (let i = 0; i < 10; i++) assert.ok(f.readOutput('out' + i), 'out' + i);
});

test('the Sheets sandbox publishes merges, formats and sizes only when the whole batch succeeds', () => {
  const f = fixture(),
    sheet = f.tab('Output');
  const range = (startRowIndex, endRowIndex, startColumnIndex, endColumnIndex) => ({ sheetId: sheet.id, startRowIndex, endRowIndex, startColumnIndex, endColumnIndex });
  f.setCell(sheet, 1, 2, 'hidden by the merge');
  assert.throws(() => f.api.Sheets.Spreadsheets.batchUpdate({ requests: [
    { mergeCells: { range: range(0, 2, 0, 3), mergeType: 'MERGE_ALL' } },
    { repeatCell: { range: range(0, 1, 0, 1), cell: { userEnteredFormat: { backgroundColor: rgb('#0d366b') } }, fields: 'userEnteredFormat.backgroundColor' } },
    { updateDimensionProperties: { range: { sheetId: sheet.id, dimension: 'ROWS', startIndex: 0, endIndex: 2 }, properties: { pixelSize: 40 }, fields: 'pixelSize' } },
    { unmergeCells: { range: range(0, 1, 0, 3) } },
  ] }, f.book.id), /You must select all cells in a merged range to merge or unmerge them/);
  assert.deepEqual(f.merges(sheet), []);
  assert.deepEqual(f.format(sheet, 1, 1), {});
  assert.equal(f.pixelSize(sheet, 'ROWS', 1), 21);
  assert.equal(f.value(sheet, 1, 2), 'hidden by the merge');
  f.api.Sheets.Spreadsheets.batchUpdate({ requests: [
    { mergeCells: { range: range(0, 2, 0, 3), mergeType: 'MERGE_COLUMNS' } },
    { unmergeCells: { range: range(5, 9, 5, 9) } },
  ] }, f.book.id);
  assert.deepEqual(f.merges(sheet), ['A1:A2', 'B1:B2', 'C1:C2']);
  assert.equal(f.value(sheet, 1, 2), 'hidden by the merge', 'the first cell of each merge keeps its value');
  const listed = f.api.Sheets.Spreadsheets.get(f.book.id, { fields: 'sheets(properties.sheetId,merges)' }).sheets.find((item) => item.properties.sheetId === sheet.id).merges;
  assert.deepEqual(listed[0], { sheetId: sheet.id, endRowIndex: 2, endColumnIndex: 1 }, 'zero indexes are omitted like the API does');
  assert.equal(f.api.Sheets.Spreadsheets.get(f.book.id, { fields: 'sheets.properties' }).sheets[0].merges, undefined);
});

test('the Sheets sandbox moves and borders existing charts and refuses unknown ones', () => {
  const f = fixture(),
    sheet = f.tab('Output');
  const anchor = (rowIndex) => ({ overlayPosition: { anchorCell: { sheetId: sheet.id, rowIndex, columnIndex: 1 }, widthPixels: 600, heightPixels: 300 } });
  f.api.Sheets.Spreadsheets.batchUpdate({ requests: [{ addChart: { chart: { chartId: 7, spec: { title: '' }, position: anchor(2) } } }] }, f.book.id);
  const white = { color: rgb('#ffffff') };
  f.api.Sheets.Spreadsheets.batchUpdate({ requests: [
    { updateEmbeddedObjectPosition: { objectId: 7, newPosition: { overlayPosition: { anchorCell: { sheetId: sheet.id, rowIndex: 9, columnIndex: 1 }, offsetXPixels: 8 } }, fields: 'anchorCell,offsetXPixels' } },
    { updateEmbeddedObjectBorder: { objectId: 7, border: white, fields: 'color' } },
  ] }, f.book.id);
  const chart = f.state.charts.find((item) => item.chartId === 7);
  assert.deepEqual(chart.position.overlayPosition, { anchorCell: { sheetId: sheet.id, rowIndex: 9, columnIndex: 1 }, widthPixels: 600, heightPixels: 300, offsetXPixels: 8 });
  assert.deepEqual(chart.border, white);
  assert.throws(() => f.api.Sheets.Spreadsheets.batchUpdate({ requests: [
    { updateEmbeddedObjectBorder: { objectId: 7, border: { color: rgb('#000000') }, fields: 'color' } },
    { updateEmbeddedObjectPosition: { objectId: 8, newPosition: anchor(1), fields: '*' } },
  ] }, f.book.id), /No embedded object with id 8/);
  assert.deepEqual(chart.border, white, 'a failed batch changes no chart');
});
