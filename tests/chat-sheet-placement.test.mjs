import test from 'node:test';
import assert from 'node:assert/strict';
import { plain } from './helpers/datamoov-sandbox.mjs';
import { chatSheetFixture } from './helpers/chat-sheet-fixture.mjs';

// Where follow-up charts and tables land. A live check charted a summary at D1, then, for a
// second chart, wrote its helper table to D1:E4 (hidden under the first chart) and anchored the
// new chart at G1, over the right half of the first one. A chart is 600 by 360 pixels: six
// default columns and eighteen default rows from its anchor.

function fixture() {
  const f = chatSheetFixture();
  f.summary = f.book.insertSheet('Summary');
  [
    ['Group', 'Total'],
    ['A', 50],
    ['B', 32],
    ['C', 29],
    ['D', 12],
    ['E', 11],
  ].forEach((row, r) => row.forEach((value, c) => f.setCell(f.summary, r + 1, c + 1, value)));
  f.chart = (extra = {}) =>
    plain(
      f.api.dmvChatCreateChart_(f.session, {
        sheetName: 'Summary',
        range: 'A1:B6',
        chartType: 'column',
        xColumn: 'Group',
        seriesColumns: ['Total'],
        ...extra,
      })
    );
  f.anchors = () =>
    f.state.charts.map((chart) => {
      const cell = chart.position.overlayPosition.anchorCell;
      return [cell.rowIndex + 1, cell.columnIndex + 1];
    });
  return f;
}

test('a chart anchored over an existing chart moves below it, and says where it went', () => {
  const f = fixture();
  assert.equal(f.chart().anchorCell, 'D1');
  const second = f.chart({ anchorCell: 'G1', title: 'Top 3' });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.anchorCell, 'G20');
  assert.match(second.note, /G1 lay over the chart at D1:I18, so the chart went to G20\./);
  assert.deepEqual(f.anchors(), [
    [1, 4],
    [20, 7],
  ]);
  // A free anchor is kept as given, and so is one far from any chart.
  const free = f.chart({ anchorCell: 'K1' });
  assert.equal(free.anchorCell, 'K1');
  assert.equal(free.note, undefined);
});

test('a table is not written into empty cells a chart covers; cells that hold data stay editable', () => {
  const f = fixture();
  f.chart();
  const batches = f.state.batches.length;
  const hidden = /^Error: The chart at D1:I18 of "Summary" covers D1:E4, so the table would sit hidden under it\. Put it at D20 or another free cell instead\.$/;
  // set_values into the empty cells under the chart.
  const under = f.inspect('D1:E4', 'Summary');
  assert.throws(
    () => f.edit('set_values', { values: [['Group', 'Total'], ['A', 1], ['B', 2], ['C', 3]] }, under),
    hidden
  );
  // write_to_sheet of a result there.
  const read = plain(f.api.dmvChatReadSheet_(f.session, { sheetName: 'Summary', range: 'A1:B4' }));
  assert.throws(
    () =>
      f.api.dmvChatWriteSheet_(f.session, {
        resultId: read.resultId,
        sheetName: 'Summary',
        startCell: 'D1',
      }),
    hidden
  );
  assert.equal(f.state.batches.length, batches);
  // Elsewhere both write.
  const beside = f.inspect('D20:E21', 'Summary');
  assert.equal(f.edit('set_values', { values: [['x', 1], ['y', 2]] }, beside).ok, true);
  assert.equal(
    plain(
      f.api.dmvChatWriteSheet_(f.session, {
        resultId: read.resultId,
        sheetName: 'Summary',
        startCell: 'D30',
      })
    ).ok,
    true
  );
  // A cell under the chart that already holds data is the user's to edit.
  f.setCell(f.summary, 3, 5, 'old');
  const held = f.inspect('E3', 'Summary');
  assert.equal(f.edit('set_values', { values: [['new']] }, held).ok, true);
  assert.equal(f.value(f.summary, 3, 5), 'new');
});
