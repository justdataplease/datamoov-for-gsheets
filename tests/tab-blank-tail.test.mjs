import test from 'node:test';
import assert from 'node:assert/strict';
import { plain } from './helpers/datamoov-sandbox.mjs';
import { chatSheetFixture } from './helpers/chat-sheet-fixture.mjs';
import { exemptDashboardPages } from './helpers/dashboard-goldens.mjs';

exemptDashboardPages(
  'Tabs whose array formulas show "" below their last row did not reach a dashboard before; each test checks its numbers against the rows it wrote.'
);

// A guarded array formula, =ARRAYFORMULA(IF(A2:A="","",…)), shows "" in every row below the last
// key, and Sheets counts a shown "" as content: getLastRow() is then the bottom of the tab. Tabs
// are read to their last row with a value, so those rows add no blank group, no rows to a count
// and no rows to the ranges a dashboard's formulas read; a refresh still finds new keys.

const SEGMENT = '=ARRAYFORMULA(IF(A2:A="","",IF(B2:B>1,"Repeat","Once")))';
const FLAG = '=ARRAYFORMULA(IF(A2:A="","",IF(B2:B>1,1,0)))';
const KEYS = [
  ['K-1', 3, 120],
  ['K-2', 1, 40],
  ['K-3', 2, 75],
  ['K-4', 1, 10],
  ['K-5', 5, 300],
  ['K-6', 1, 25],
];

// The tab's key rows, typed, and its two guarded columns, whose results run to the tab's last row.
function fixture(rows = 300) {
  const f = chatSheetFixture({
    setup(f) {
      const sheet = f.book.insertSheet('Entities');
      sheet.maxRows = rows;
      ['Key', 'Count', 'Amount', 'Segment', 'Repeat'].forEach((header, index) =>
        f.setCell(sheet, 1, index + 1, header)
      );
      f.entities = sheet;
    },
    // Each guarded column, computed from columns A and B as they are, to the last row.
    formulaResult(formula, at) {
      if (formula !== SEGMENT && formula !== FLAG) return undefined;
      return Array.from({ length: rows - at.row + 1 }, (_, index) => {
        const key = f.value(f.entities, at.row + index, 1);
        const count = f.value(f.entities, at.row + index, 2);
        if (key === '') return [''];
        return [formula === SEGMENT ? (count > 1 ? 'Repeat' : 'Once') : count > 1 ? 1 : 0];
      });
    },
  });
  f.keys = (lines) => {
    lines.forEach((line, index) => line.forEach((value, column) => f.setCell(f.entities, index + 2, column + 1, value)));
    for (const [formula, cell] of [[SEGMENT, 'D2'], [FLAG, 'E2']]) {
      const written = f.edit('set_formulas', { formulas: [[formula]] }, f.inspect(cell, 'Entities'));
      assert.equal(written.ok, true, JSON.stringify(written));
    }
  };
  f.keys(KEYS);
  return f;
}

test('the sandbox counts the "" a guarded array formula shows as content, as Sheets does', () => {
  const f = fixture();
  assert.equal(f.entities.getLastRow(), 300);
  assert.equal(f.entities.getDataRange().getNumRows(), 300);
  assert.equal(f.value(f.entities, 8, 4), '');
});

test('read_sheet reads a tab to its last row with a value, not to the bottom of its guarded columns', () => {
  const f = fixture();
  const read = plain(f.api.dmvChatReadSheet_(f.session, { sheetName: 'Entities' }));
  const stored = plain(f.api.dmvChatResult_(f.session, read.resultId));
  assert.equal(stored.rows.length, KEYS.length);
  assert.deepEqual(
    stored.rows.map((row) => row.segment),
    KEYS.map((line) => (line[1] > 1 ? 'Repeat' : 'Once'))
  );
  assert.equal(stored.metadata.partial, undefined);
  // A range given past the keys is read to the last row with a value too.
  const ranged = plain(f.api.dmvChatReadSheet_(f.session, { sheetName: 'Entities', range: 'A1:E250' }));
  assert.equal(plain(f.api.dmvChatResult_(f.session, ranged.resultId)).rows.length, KEYS.length);
});

test('a dashboard over a tab with guarded columns groups only its keys, and a refresh finds new keys', () => {
  const f = fixture();
  const input = {
    name: 'Entities overview',
    target: { sheetName: 'Entities Dashboard' },
    datasets: [{ id: 'entities', label: 'Entities', sourceSheet: 'Entities' }],
    tiles: [
      {
        title: 'Totals',
        type: 'kpi',
        metrics: [{ field: 'Amount', agg: 'sum' }],
        ratios: [{ key: 'repeat_share', label: 'Repeat share', numerator: 'Repeat', denominator: 'Key__count', percent: true }],
      },
      { title: 'Amount by segment', type: 'bar', groupBy: ['Segment'], metrics: [{ field: 'Amount', agg: 'sum' }] },
      { title: 'Keys by segment', type: 'table', groupBy: ['Segment'], metrics: [{ field: 'Key', agg: 'count' }] },
    ],
  };
  const saved = plain(f.api.dmvSaveDashboard(input));
  const result = plain(f.api.dmvRunDashboard(saved.id));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.datasets[0].rowCount, KEYS.length);
  const groups = (title) =>
    result.tiles
      .find((tile) => tile.title === title)
      .preview.slice(1)
      .map((row) => row[0])
      .sort();
  assert.deepEqual(groups('Amount by segment'), ['Once', 'Repeat']);
  assert.deepEqual(groups('Keys by segment'), ['Once', 'Repeat']);
  const share = result.scorecards.find((card) => card.label === 'Repeat share');
  assert.ok(Math.abs(share.value - 3 / KEYS.length) < 1e-9, JSON.stringify(share));
  // The page's formulas end at the last key, not at the bottom of the tab.
  const page = f.tab('Entities Dashboard');
  const formulas = [...page.cells.values()].map((entry) => entry.formula).filter(Boolean).join('\n');
  assert.match(formulas, /Entities'?!\$C\$2:\$C\$7\b/);
  assert.doesNotMatch(formulas, /\$300\b/);
  // Two more keys: the guarded columns follow them, and a refresh covers them.
  f.keys(KEYS.concat([['K-7', 4, 60], ['K-8', 1, 5]]));
  const again = plain(f.api.dmvRunDashboard(saved.id));
  assert.equal(again.datasets[0].rowCount, KEYS.length + 2);
  const refreshed = [...f.tab('Entities Dashboard').cells.values()].map((entry) => entry.formula).filter(Boolean).join('\n');
  assert.match(refreshed, /Entities'?!\$C\$2:\$C\$9\b/);
});

test('finding the last row with a value reads upward in bounded reads, within a budget', () => {
  const f = fixture(100000);
  f.state.cellsRead = 0;
  f.state.largestRead = 0;
  assert.equal(f.api.dmvSheetLastFilledRow_(f.entities, 2, 100000, 1, 5), KEYS.length + 1);
  const chunk = f.api.DMV_TAB_SCAN.chunkCells;
  assert.ok(f.state.largestRead <= chunk, 'largest read ' + f.state.largestRead);
  assert.ok(f.state.cellsRead <= 100000 * 5, 'cells read ' + f.state.cellsRead);
  // Past its budget the scan stops and keeps the rows it did not reach.
  const kept = f.api.dmvSheetLastFilledRow_(f.entities, 2, 100000, 1, 5, 1000);
  assert.ok(kept > 99000 && kept <= 100000, String(kept));
  // read_sheet cut at its cell budget scans below the cut for a value before calling it partial.
  f.state.largestRead = 0;
  const read = plain(f.api.dmvChatReadSheet_(f.session, { sheetName: 'Entities' }));
  assert.equal(read.rowCount, KEYS.length);
  assert.equal(read.metadata?.partial, undefined);
  assert.ok(f.state.largestRead <= f.api.DMV_CHAT_RESULTS.readMaxCells, 'largest read ' + f.state.largestRead);
  // A tab whose last row has a value is read one row.
  f.state.cellsRead = 0;
  assert.equal(f.api.dmvSheetLastFilledRow_(f.entities, 2, KEYS.length + 1, 1, 5), KEYS.length + 1);
  assert.equal(f.state.cellsRead, 5);
});

// Readers that size a tab by its used range (getDataRange) use its last row with a value too, so
// a tab with guarded columns is described, searched and acted on as the rows it holds.
test('the active tab line names a tab to its last row with a value, in bounded reads', () => {
  const f = fixture();
  f.book.setActiveSheet(f.entities);
  f.state.cellsRead = 0;
  const [line] = f.api.dmvChatActiveTabText_(f.session);
  assert.match(line, /data A1:E7 \(7 rows, 5 columns\)\. Header row 1 /);
  assert.ok(line.endsWith(JSON.stringify(['Key', 'Count', 'Amount', 'Segment', 'Repeat'])), line);
  assert.ok(f.state.cellsRead <= 2 * 300 * 5, 'cells read ' + f.state.cellsRead);
  // A tail past the line's scan budget is kept, as before: the line never reads a whole tab.
  const big = fixture(100000);
  big.book.setActiveSheet(big.entities);
  big.state.cellsRead = 0;
  big.state.largestRead = 0;
  assert.match(big.api.dmvChatActiveTabText_(big.session)[0], /data A1:E\d+ \(\d+ rows, 5 columns\)/);
  assert.ok(big.state.cellsRead <= big.api.DMV_CHAT.activeScanCells + 5, 'cells read ' + big.state.cellsRead);
  assert.ok(big.state.largestRead <= big.api.DMV_TAB_SCAN.chunkCells, 'largest read ' + big.state.largestRead);
});

test('search_sheets scans a tab to its last row with a value, so a long blank tail does not stop it', () => {
  const f = fixture();
  const found = plain(f.api.dmvChatSearchSheets_(f.session, { query: 'K-', sheetName: 'Entities' }));
  assert.equal(found.total, KEYS.length);
  assert.equal(found.scannedCells, 7 * 5);
  // An open range ends there too; a range with an end row is read as given.
  const search = (range) =>
    plain(f.api.dmvChatSearchSheets_(f.session, { query: 'K-', sheetName: 'Entities', range }));
  assert.equal(search('A:E').scannedCells, 7 * 5);
  assert.equal(search('A1:E300').scannedCells, 300 * 5);
  // 100,000 rows of guarded columns pass the search's cell cap; the rows with values do not.
  const big = fixture(100000);
  big.state.largestRead = 0;
  const all = plain(big.api.dmvChatSearchSheets_(big.session, { query: 'K-' }));
  assert.equal(all.total, KEYS.length);
  assert.equal(all.skippedTabs, undefined);
  assert.equal(all.byTab.Entities, KEYS.length);
  assert.ok(big.state.largestRead <= big.api.DMV_TAB_SCAN.chunkCells, 'largest read ' + big.state.largestRead);
});

test('whole-tab sheet actions cover a tab to its last row with a value', () => {
  const f = fixture(100000);
  const asked = f.edit(
    'find_replace',
    { find: 'K-', replacement: 'Q-', wholeSheet: true },
    f.inspect('A1:A2', 'Entities')
  );
  assert.equal(
    asked.summary,
    'Replace 6 matches of "K-" with "Q-" in 6 cells of Entities!A1:E7 (the whole tab).'
  );
  const deleting = f.tabAction('delete_sheet', { sheetName: 'Entities' });
  assert.match(deleting.summary, /^Delete the tab "Entities" \(data in A1:E7\)\?/);
});
