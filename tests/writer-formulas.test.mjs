import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatamoovSandbox } from './helpers/datamoov-sandbox.mjs';

function fixture() {
  const f = createDatamoovSandbox();
  f.output = (id, matrix, options = {}) => ({
    report: Object.assign({ id, spreadsheetId: f.book.id, target: { sheetName: options.sheetName || 'Page', startCell: 'A1' } }, options.report),
    result: { columns: [], matrix, layout: options.layout },
  });
  f.write = (...outputs) => f.api.dmvWriteReports_(f.book, outputs);
  f.live = (text) => new f.api.DmvFormula_(text);
  f.cells = () => f.state.batches.at(-1).body.requests.filter((request) => request.updateCells?.rows?.length).flatMap((request) => request.updateCells.rows.flatMap((row) => row.values));
  // Every range the writer reads back from a tab, as [row, column, rows, columns].
  f.reads = [];
  f.spy = (sheet) => {
    const getRange = sheet.getRange;
    sheet.getRange = (...args) => {
      const range = getRange(...args);
      for (const method of ['getValues', 'getFormulas'])
        if (range[method]) {
          const read = range[method];
          range[method] = () => {
            f.reads.push([method, ...args]);
            return read();
          };
        }
      return range;
    };
  };
  return f;
}

test('formula cells are entered as formulas while formula-like text stays text', () => {
  const f = fixture();
  f.write(f.output('page', [['Total', f.live('=SUM(B2:B3)')], ['=literal', 2], ['', 3]]));
  const sheet = f.tab('Page');
  assert.equal(f.formula(sheet, 1, 2), '=SUM(B2:B3)');
  assert.equal(f.api.dmvSheetValue_({ formula: '=1' }), '{"formula":"=1"}', 'an object from a source is text');
  assert.equal(f.formula(sheet, 2, 1), '', 'formula-like text stays text');
  assert.deepEqual(f.cells().slice(0, 3), [
    { userEnteredValue: { stringValue: 'Total' } },
    { userEnteredValue: { formulaValue: '=SUM(B2:B3)' } },
    { userEnteredValue: { stringValue: '=literal' } },
  ]);
  assert.throws(() => new f.api.DmvFormula_('SUM(1)'), /formula starts with =/);
});

test('a refresh over its own formulas succeeds, as Sheets stores them, and an edited formula is refused', () => {
  const f = fixture();
  const page = () => f.output('page', [['Spend', f.live("='Ads data'!$C$5+'Ads'!$C$5")], ['Rows', 2]]);
  f.write(f.output('ads', [['x']], { sheetName: 'Ads' }), f.output('ads-data', [['y']], { sheetName: 'Ads data' }), page());
  const sheet = f.tab('Page');
  // Sheets drops the quotes a simple tab name does not need.
  f.setCell(sheet, 1, 2, "='Ads data'!$C$5+Ads!$C$5", "='Ads data'!$C$5+Ads!$C$5");
  f.write(page());
  assert.equal(f.formula(sheet, 1, 2), "='Ads data'!$C$5+'Ads'!$C$5");
  // Sheets rewrites references when the tabs they read change: a deleted tab reads #REF!, a
  // renamed one its new name, and rows or columns inserted there shift the cells.
  for (const moved of ["=#REF!+'Ads'!$C$5", "='Ads data'!$C$6+Renamed!$D$5"]) {
    f.setCell(sheet, 1, 2, moved, moved);
    f.write(page());
    assert.equal(f.formula(sheet, 1, 2), "='Ads data'!$C$5+'Ads'!$C$5", moved);
  }
  f.setCell(sheet, 1, 2, "='Ads data'!$C$5*'Ads'!$C$5", "='Ads data'!$C$5*'Ads'!$C$5");
  assert.throws(() => f.write(page()), /edited or moved/);
  f.setCell(sheet, 1, 2, 12);
  assert.throws(() => f.write(page()), /edited or moved/, 'a value typed over a formula is an edit too');
});

// Sheets may store a formula in its own spelling: names in capitals, a number in another notation,
// spaces between the parts. None of that changes what it computes.
test('a refresh accepts its formulas in the spelling Sheets stores, and still refuses a changed text or number', () => {
  const f = fixture();
  const written = "=LET(previous,SUM('Ads'!$C$5:$C$9),IF(previous=0,\"no previous value\",MAX(-9E+307,previous*1e-7,2)))";
  const page = () => f.output('page', [['Spend', f.live(written)]]);
  f.write(f.output('ads', [['x']], { sheetName: 'Ads' }), page());
  const sheet = f.tab('Page');
  const stored = '=LET(PREVIOUS, SUM(Ads!$C$5:$C$9), IF(PREVIOUS = 0, "no previous value", MAX(-9E+307, PREVIOUS * 1E-07, 2.0)))';
  f.setCell(sheet, 1, 2, stored, stored);
  f.write(page());
  assert.equal(f.formula(sheet, 1, 2), written);
  for (const edited of [stored.replace('no previous', 'No previous'), stored.replace('2.0', '3'), stored.replace('PREVIOUS * ', 'PREVIOUS / ')]) {
    f.setCell(sheet, 1, 2, edited, edited);
    assert.throws(() => f.write(page()), /edited or moved/, edited);
  }
  // A formula pointed at other cells reads like its own, since Sheets moves references itself:
  // the refresh puts its own references back.
  const pointed = written.replace('$C$5:$C$9', '$D$5:$D$9');
  f.setCell(sheet, 1, 2, pointed, pointed);
  f.write(page());
  assert.equal(f.formula(sheet, 1, 2), written);
});

test('an output owned for rewriting is replaced without reading it back, and foreign cells past it still stop the write', () => {
  const f = fixture();
  const rows = (count) => [['date', 'spend']].concat(Array.from({ length: count }, (_, i) => ['2026-08-0' + (i + 1), i]));
  const data = (count) => f.output('data', rows(count), { report: { rewrite: true } });
  f.write(data(3));
  const sheet = f.tab('Page');
  f.spy(sheet);
  f.setCell(sheet, 2, 2, 'edited');
  f.write(data(3));
  assert.deepEqual(f.reads, [], 'its own area is not read back');
  assert.equal(f.value(sheet, 2, 2), 0, 'the area is written again');
  f.write(data(5));
  assert.deepEqual(f.reads.map((read) => read.slice(1)), [[5, 1, 2, 2], [5, 1, 2, 2]], 'only the rows it grows into are read');
  f.reads.length = 0;
  f.setCell(sheet, 8, 1, 'someone else');
  assert.throws(() => f.write(data(7)), /contains existing data/);
  assert.equal(f.readOutput('data').rewrite, true);
  assert.equal(f.readOutput('data').digest, undefined, 'there is nothing to compare, so no digest');
  // An ordinary output keeps its edit check.
  f.write(f.output('report', [['a'], ['b']], { sheetName: 'Other' }));
  f.setCell(f.tab('Other'), 2, 1, 'edited');
  assert.throws(() => f.write(f.output('report', [['a'], ['b']], { sheetName: 'Other' })), /edited or moved/);
});

test('a date column of a table takes a date pattern, so date serials read as dates', () => {
  const f = fixture();
  f.write(
    f.output('page', [['Day'], [46235]], {
      layout: { tables: [{ row: 0, rows: 2, columns: [{ type: 'date', pattern: 'yyyy-mm-dd' }] }] },
    })
  );
  const sheet = f.tab('Page');
  assert.deepEqual(f.format(sheet, 2, 1).numberFormat, { type: 'DATE', pattern: 'yyyy-mm-dd' });
  assert.equal(f.shown(sheet, 2, 1), '2026-08-01');
});

test('the rows of an output owned for rewriting fill as many writes as the size limit takes, after everything else', () => {
  const f = fixture();
  const rows = (count) => [['day', 'name', 'spend']].concat(Array.from({ length: count }, (_, i) => [i, '=name ' + i, i / 4]));
  const data = (count) => f.output('data', rows(count), { report: { rewrite: true } });
  const page = f.output('page', [['Total', f.live("=SUM('Page'!C2:C3001)")]], { sheetName: 'Summary' });
  // Small enough, everything is one write.
  f.write(data(10), page);
  assert.equal(f.state.batches.length, 1);
  const limit = f.api.DMV_LIMITS.maxBytes;
  f.api.DMV_LIMITS.maxBytes = 50000;
  try {
    f.write(data(3000), page);
  } finally {
    f.api.DMV_LIMITS.maxBytes = limit;
  }
  const writes = f.state.batches.slice(1);
  assert.ok(writes.length > 3, writes.length + ' writes');
  for (const batch of writes) assert.ok(Buffer.byteLength(JSON.stringify(batch.body)) <= 50000);
  // The first write carries the page and as many rows as fit; the rest carry only rows.
  assert.ok(writes[0].body.requests.some((request) => request.updateCells?.rows?.[0]?.values?.[1]?.userEnteredValue?.formulaValue));
  for (const batch of writes.slice(1)) assert.ok(batch.body.requests.every((request) => request.updateCells?.fields === 'userEnteredValue'));
  const sheet = f.tab('Page');
  assert.deepEqual([f.value(sheet, 1, 2), f.value(sheet, 2, 2), f.formula(sheet, 2, 2), f.value(sheet, 3001, 3), f.value(sheet, 3002, 1)], ['name', '=name 0', '', 2999 / 4, '']);
  assert.equal(f.shown(f.tab('Summary'), 1, 2), (2999 * 3000) / 8);
  // An ordinary output is still one write or none.
  f.api.DMV_LIMITS.maxBytes = 50000;
  try {
    assert.throws(() => f.write(f.output('report', rows(3000), { sheetName: 'Other' })), /too large for one Sheets write/);
  } finally {
    f.api.DMV_LIMITS.maxBytes = limit;
  }
});

// The Sheets API limits a request by its UTF-8 bytes: "€" is one character and three bytes.
test('batches of rows are sized by their UTF-8 bytes, so text beyond ASCII stays within the limit', () => {
  const f = fixture();
  const rows = [['name', 'amount']].concat(Array.from({ length: 2000 }, (_, i) => ['€ ' + '€'.repeat(20) + ' ' + i, i]));
  const data = () => f.output('data', rows, { report: { rewrite: true } });
  const limit = f.api.DMV_LIMITS.maxBytes;
  f.api.DMV_LIMITS.maxBytes = 50000;
  try {
    f.write(data());
    // A page in characters fits where its bytes do not.
    const page = [['name'], ['€'.repeat(20000)]];
    assert.throws(() => f.write(f.output('page', page, { sheetName: 'Other' })), /too large for one Sheets write/);
  } finally {
    f.api.DMV_LIMITS.maxBytes = limit;
  }
  assert.ok(f.state.batches.length > 3, f.state.batches.length + ' writes');
  for (const batch of f.state.batches) assert.ok(Buffer.byteLength(JSON.stringify(batch.body)) <= 50000, Buffer.byteLength(JSON.stringify(batch.body)) + ' bytes');
  assert.equal(f.value(f.tab('Page'), 2001, 1), '€ ' + '€'.repeat(20) + ' 1999');
});

test('a write of rows that stops after the first write says the tabs were updated, and the next write recovers', () => {
  const f = fixture();
  const rows = [['day', 'spend']].concat(Array.from({ length: 2000 }, (_, i) => [i, i]));
  const data = () => f.output('data', rows, { report: { rewrite: true } });
  const send = f.api.Sheets.Spreadsheets.batchUpdate;
  let calls = 0;
  f.api.Sheets.Spreadsheets.batchUpdate = (...args) => {
    if (++calls === 2) throw new Error('Service unavailable');
    return send(...args);
  };
  const limit = f.api.DMV_LIMITS.maxBytes;
  f.api.DMV_LIMITS.maxBytes = 20000;
  try {
    assert.throws(
      () => f.write(data()),
      (error) => error.sheetUpdated === true && /^The output tabs were updated, but not all of their rows\. Refresh again to write them\.$/.test(error.message)
    );
    assert.equal(f.readOutput('data'), null, 'no receipt yet');
    f.write(data());
  } finally {
    f.api.DMV_LIMITS.maxBytes = limit;
    f.api.Sheets.Spreadsheets.batchUpdate = send;
  }
  assert.equal(f.readOutput('data').rewrite, true);
  assert.equal(f.value(f.tab('Page'), 2001, 2), 1999);
});
