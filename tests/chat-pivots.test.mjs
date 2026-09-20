import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createDatamoovSandbox, plain } from './helpers/datamoov-sandbox.mjs';

function fixture() {
  const f = createDatamoovSandbox();
  if (!f.api.dmvChatCreatePivot_)
    new vm.Script(readFileSync(new URL('../src/dmv_chat_pivots.js', import.meta.url), 'utf8'), {
      filename: 'dmv_chat_pivots.js',
    }).runInContext(f.api);
  const source = f.book.getSheets()[0];
  source.name = 'Source';
  const matrix = [
    ['Date', 'Campaign', 'Currency', 'Spend', 'Clicks'],
    [new Date('2026-08-01T12:00:00Z'), 'Brand', 'EUR', 10.5, 100],
    [new Date('2026-08-02T12:00:00Z'), 'Brand', 'EUR', 20, 150],
    [new Date('2026-09-01T12:00:00Z'), 'Generic', 'USD', 5, 20],
  ];
  matrix.forEach((row, r) => row.forEach((value, c) => f.setCell(source, r + 3, c + 2, value)));
  const session = {
    spreadsheet: f.book,
    spreadsheetId: f.book.id,
    sheetNames: ['Source'],
    events: [],
    deadline: f.api.Date.now() + 60000,
  };
  const input = {
    sourceSheet: 'Source',
    sourceRange: 'B3:F8',
    targetSheet: 'Campaign pivot',
    rows: [{ column: 3 }, { column: 2 }],
    values: [
      { column: 4, summarize: 'SUM' },
      { column: 5, summarize: 'SUM' },
    ],
  };
  return { ...f, source, session, input };
}

test('native pivot is one atomic new-tab batch with exact source offsets and no source writes', () => {
  const f = fixture(),
    before = plain([...f.source.cells]);
  const result = f.api.dmvChatCreatePivot_(f.session, f.input);
  assert.equal(result.nativePivot, true);
  assert.equal(result.sheetName, 'Campaign pivot');
  assert.equal(result.sourceRange, 'B3:F8');
  assert.equal(f.state.batches.length, 1);
  const requests = f.state.batches[0].body.requests;
  assert.equal(requests.length, 2);
  const created = requests[0].addSheet.properties;
  assert.equal(created.title, 'Campaign pivot');
  assert.ok(Number.isInteger(created.sheetId) && created.sheetId > 0);
  assert.notEqual(created.sheetId, f.source.id);
  assert.deepEqual(requests[1].updateCells.start, {
    sheetId: created.sheetId,
    rowIndex: 0,
    columnIndex: 0,
  });
  assert.equal(requests[1].updateCells.fields, 'pivotTable');
  const pivot = requests[1].updateCells.rows[0].values[0].pivotTable;
  assert.deepEqual(pivot.source, {
    sheetId: f.source.id,
    startRowIndex: 2,
    endRowIndex: 8,
    startColumnIndex: 1,
    endColumnIndex: 6,
  });
  assert.deepEqual(
    pivot.rows.map((group) => group.sourceColumnOffset),
    [2, 1]
  );
  assert.ok(pivot.rows.every((group) => group.showTotals === false));
  assert.deepEqual(pivot.values, [
    { sourceColumnOffset: 3, summarizeFunction: 'SUM' },
    { sourceColumnOffset: 4, summarizeFunction: 'SUM' },
  ]);
  assert.equal(pivot.valueLayout, 'HORIZONTAL');
  assert.deepEqual(plain([...f.source.cells]), before);
  assert.equal(f.state.legacyWrites.length, 0);
  assert.equal(f.state.scriptLockAcquires, 1);
  assert.equal(f.state.scriptLockReleases, 1);
  assert.equal(f.session.events[0].kind, 'write');
  assert.ok(f.book.getSheetByName('Campaign pivot'));
  assert.equal(JSON.stringify(result).includes('Brand'), false);
});

test('API failure leaves no new tab, source mutation, success event or session tab entry', () => {
  const f = fixture(),
    before = plain([...f.source.cells]);
  f.state.failBatch = true;
  assert.throws(() => f.api.dmvChatCreatePivot_(f.session, f.input), /atomic batch failure/);
  assert.equal(f.book.getSheetByName('Campaign pivot'), null);
  assert.deepEqual(plain([...f.source.cells]), before);
  assert.deepEqual(f.session.events, []);
  assert.deepEqual(f.session.sheetNames, ['Source']);
  assert.equal(f.state.scriptLockReleases, 1);
});

test('existing target names are rejected case-insensitively without any write', () => {
  for (const name of ['Source', 'source']) {
    const f = fixture();
    assert.throws(
      () => f.api.dmvChatCreatePivot_(f.session, { ...f.input, targetSheet: name }),
      /already exists/
    );
    assert.equal(f.state.batches.length, 0);
    assert.equal(f.book.getSheets().length, 1);
  }
});

test('protected report settings cannot be pivot sources or target names', () => {
  for (const rename of [false, true]) {
    const f = fixture();
    const sheet = f.book.insertSheet(rename ? 'Renamed settings' : 'DataMoovReports');
    f.setCell(sheet, 1, 1, f.api.DMV_REPORT_SHEET_MARKER);
    assert.throws(
      () => f.api.dmvChatCreatePivot_(f.session, { ...f.input, sourceSheet: sheet.name }),
      /report settings|reserved/
    );
    assert.equal(f.state.batches.length, 0);
  }
  const f = fixture();
  assert.throws(
    () => f.api.dmvChatCreatePivot_(f.session, { ...f.input, targetSheet: 'DataMoovReports' }),
    /reserved/
  );
  assert.equal(f.state.batches.length, 0);
});

test('source ranges must be explicit, bounded and inside the existing grid', () => {
  for (const range of [
    'B3',
    'B:F',
    'Source!B3:F8',
    'B3:F3',
    'F8:B3',
    'B3:F101',
    'A1:CC10',
    'A1:F20002',
  ]) {
    const f = fixture();
    assert.throws(
      () => f.api.dmvChatCreatePivot_(f.session, { ...f.input, sourceRange: range }),
      /explicit source range|header row|existing sheet grid/
    );
    assert.equal(f.state.batches.length, 0);
  }
  const f = fixture();
  const result = f.api.dmvChatCreatePivot_(f.session, { ...f.input, sourceRange: 'B3:F100' });
  assert.equal(
    result.sourceRange,
    'B3:F100',
    'future blank rows are preserved, not cut at getLastRow'
  );
});

test('all source headers and selected one-based offsets are validated before batching', () => {
  for (const patch of [
    { rows: [{ column: 0 }] },
    { rows: [{ column: 6 }] },
    { rows: [{ column: '2' }] },
    { rows: [] },
    { rows: [{ column: 3 }], columns: [{ column: 3 }] },
    { values: [{ column: 4, summarize: 'CUSTOM' }] },
    { values: [{ column: 4, summarize: 'SUM', formula: '=IMPORTDATA("https://example.com")' }] },
  ]) {
    const f = fixture();
    assert.throws(
      () => f.api.dmvChatCreatePivot_(f.session, { ...f.input, ...patch }),
      /one-based|row groups|only one|Choose SUM|documented fields/
    );
    assert.equal(f.state.batches.length, 0);
  }
  for (const header of ['', 'Campaign', 123]) {
    const f = fixture();
    f.setCell(f.source, 3, 2, header);
    assert.throws(
      () => f.api.dmvChatCreatePivot_(f.session, f.input),
      /distinct, nonempty text header/
    );
    assert.equal(f.state.batches.length, 0);
  }
});

test('numeric text is not silently dropped from SUM, AVERAGE, MIN or MAX', () => {
  for (const summarize of ['SUM', 'AVERAGE', 'MIN', 'MAX']) {
    const f = fixture();
    f.setCell(f.source, 4, 5, '10.5');
    assert.throws(
      () =>
        f.api.dmvChatCreatePivot_(f.session, { ...f.input, values: [{ column: 4, summarize }] }),
      /Numeric text is not silently ignored/
    );
    assert.equal(f.state.batches.length, 0);
  }
  const f = fixture();
  const result = f.api.dmvChatCreatePivot_(f.session, {
    ...f.input,
    values: [{ column: 2, summarize: 'COUNTA' }],
  });
  assert.equal(result.ok, true, 'COUNTA explicitly supports text values');
});

test('money pivots require explicit currency grouping and disable mixed-currency totals', () => {
  const f = fixture();
  assert.throws(
    () => f.api.dmvChatCreatePivot_(f.session, { ...f.input, rows: [{ column: 2 }] }),
    /currency column/
  );
  assert.equal(f.state.batches.length, 0);
  f.setCell(f.source, 3, 4, 'Region');
  assert.throws(() => f.api.dmvChatCreatePivot_(f.session, f.input), /currency-code column/);
  f.setCell(f.source, 3, 4, 'Currency');
  f.setCell(f.source, 4, 4, '');
  assert.throws(() => f.api.dmvChatCreatePivot_(f.session, f.input), /three-letter currency code/);
  assert.equal(f.state.batches.length, 0);
});

test('native month grouping uses YEAR_MONTH and never freezes ISO text into manual date buckets', () => {
  const f = fixture();
  f.api.dmvChatCreatePivot_(f.session, {
    ...f.input,
    columns: [{ column: 1, dateBucket: 'month' }],
  });
  const pivot = f.state.batches[0].body.requests[1].updateCells.rows[0].values[0].pivotTable;
  assert.deepEqual(pivot.columns[0].groupRule, { dateTimeRule: { type: 'YEAR_MONTH' } });
  assert.equal(pivot.columns[0].sourceColumnOffset, 0);
  assert.equal(pivot.columns[0].showTotals, false);
  assert.equal(JSON.stringify(pivot).includes('manualRule'), false);
  const text = fixture();
  text.setCell(text.source, 4, 2, '2026-08-01');
  assert.throws(
    () =>
      text.api.dmvChatCreatePivot_(text.session, {
        ...text.input,
        rows: [{ column: 1, dateBucket: 'month' }, { column: 3 }],
      }),
    /real date cells/
  );
  assert.equal(text.state.batches.length, 0);
});

test('oversized pivot layouts and expired deadlines fail without changes', () => {
  const f = fixture();
  f.source.maxRows = 1000;
  for (let r = 4; r <= 703; r++) {
    f.setCell(f.source, r, 2, new Date('2026-08-01T12:00:00Z'));
    f.setCell(f.source, r, 3, 'Campaign ' + r);
    f.setCell(f.source, r, 4, 'EUR');
    f.setCell(f.source, r, 5, 1);
    f.setCell(f.source, r, 6, 1);
  }
  assert.throws(
    () =>
      f.api.dmvChatCreatePivot_(f.session, {
        ...f.input,
        sourceRange: 'B3:F703',
        rows: [{ column: 3 }],
        columns: [{ column: 2 }],
      }),
    /512 columns/
  );
  assert.equal(f.state.batches.length, 0);
  f.session.deadline = f.api.Date.now() + 1;
  assert.throws(() => f.api.dmvChatCreatePivot_(f.session, f.input), /time limit/);
  assert.equal(f.state.batches.length, 0);
});

test('pivot tool exposes bounded native schema and rejects arbitrary request extensions', () => {
  const f = fixture(),
    tool = f.api.dmvChatPivotTools_()[0];
  assert.equal(tool.name, 'create_pivot');
  assert.equal(tool.run, f.api.dmvChatCreatePivot_);
  assert.equal(tool.input_schema.additionalProperties, false);
  assert.deepEqual(plain(tool.input_schema.properties.values.items.properties.summarize.enum), [
    'SUM',
    'COUNT',
    'COUNTA',
    'AVERAGE',
    'MIN',
    'MAX',
  ]);
  assert.throws(
    () => f.api.dmvChatCreatePivot_(f.session, { ...f.input, requests: [] }),
    /documented fields/
  );
  assert.equal(f.state.http.length, 0);
  assert.equal(f.state.batches.length, 0);
});
