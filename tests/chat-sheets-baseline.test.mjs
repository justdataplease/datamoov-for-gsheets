import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createDatamoovSandbox, plain } from './helpers/datamoov-sandbox.mjs';

// Baseline for the chat's sheet tools as they work before the analyst sheet tools: every
// existing edit_sheet action, list/inspect/read, write_to_sheet, create_chart, run_report into a
// tab, refreshes over tabs chat edited, ownership receipts and the exact Sheets request bodies.
// Later work keeps this file unchanged; the one test that pins the narrow formula policy the
// analyst spec lifts says so in its name.

const sha256 = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex');
const BOOK = 'spreadsheet-one';
const url = (sheetId, range) =>
  `https://docs.google.com/spreadsheets/d/${BOOK}/edit#gid=${sheetId}` +
  (range ? '&range=' + encodeURIComponent(range) : '');
const COLUMNS = [
  { key: 'date', label: 'Date', type: 'date', role: 'dimension', default: true },
  { key: 'campaign', label: 'Campaign', type: 'text', role: 'dimension', default: true },
  { key: 'spend', label: 'Spend', type: 'currency', role: 'metric', default: true },
  { key: 'clicks', label: 'Clicks', type: 'number', role: 'metric', default: true },
];
// A chat output's receipt key: the digest of the JSON text of "<tab>!<cell>".
const chatReceipt = (place) =>
  `dmv:v1:output:${BOOK}:chat-` + sha256(JSON.stringify(place)).slice(0, 16);
const SCALAR_REFUSAL =
  /^Error: Use supported scalar built-in formulas with same-tab A1 references\./;

function a1(text) {
  const match = /^([A-Z]+)(\d+)$/.exec(text);
  const column = match[1].split('').reduce((sum, ch) => sum * 26 + ch.charCodeAt(0) - 64, 0);
  return { row: Number(match[2]), column };
}

// The Advanced Sheets service as the chat's sheet tools use it: grid reads of one range (values,
// formats, validation, notes, filter, frozen panes), sortRange and setBasicFilter, title and
// frozen-column changes. Everything else goes through the shared sandbox batch.
function fixture() {
  const f = createDatamoovSandbox();
  f.sheet = f.book.sheets[0];
  const sheets = f.api.Sheets.Spreadsheets,
    get = sheets.get,
    batch = sheets.batchUpdate;
  sheets.get = (id, options) => {
    if (!options?.includeGridData) return get(id, options);
    f.state.gets.push({ spreadsheetId: id, options: plain(options) });
    const match = /^'((?:[^']|'')*)'!([A-Z]+\d+)(?::([A-Z]+\d+))?$/.exec(options.ranges[0]);
    const sheet = f.tab(match[1].replace(/''/g, "'"), f.state.books.get(id));
    const start = a1(match[2]),
      end = a1(match[3] || match[2]);
    return {
      sheets: [
        {
          properties: {
            sheetId: sheet.id,
            title: sheet.name,
            gridProperties: {
              rowCount: sheet.maxRows,
              columnCount: sheet.maxColumns,
              frozenRowCount: sheet.frozenRows,
              frozenColumnCount: sheet.frozenColumns || 0,
            },
          },
          basicFilter: sheet.filter || null,
          data: [
            {
              startRow: start.row - 1,
              startColumn: start.column - 1,
              rowData: Array.from({ length: end.row - start.row + 1 }, (_, r) => ({
                values: Array.from({ length: end.column - start.column + 1 }, (_, c) => {
                  const key = `${start.row + r}:${start.column + c}`;
                  const entry = sheet.cells.get(key),
                    format = sheet.formats.get(key),
                    metadata = sheet.metadata?.get(key) || {};
                  const out = { ...(format ? { userEnteredFormat: format } : {}), ...metadata };
                  if (!entry) return out;
                  const value = entry.value;
                  const effectiveValue =
                    typeof value === 'number'
                      ? { numberValue: value }
                      : typeof value === 'boolean'
                        ? { boolValue: value }
                        : { stringValue: value };
                  return {
                    userEnteredValue: entry.formula
                      ? { formulaValue: entry.formula }
                      : effectiveValue,
                    effectiveValue,
                    ...out,
                  };
                }),
              })),
            },
          ],
        },
      ],
    };
  };
  sheets.batchUpdate = (body, id) => {
    const req = plain(body.requests[0]);
    if (req.sortRange || req.setBasicFilter) {
      f.state.batches.push({ body: plain(body), spreadsheetId: id });
      if (f.state.failBatch) throw new Error('Simulated atomic batch failure');
      const grid = req.sortRange?.range || req.setBasicFilter.filter.range;
      const sheet = f.state.books.get(id).sheets.find((s) => s.id === grid.sheetId);
      if (req.setBasicFilter) sheet.filter = req.setBasicFilter.filter;
      else {
        const rows = [];
        for (let r = grid.startRowIndex; r < grid.endRowIndex; r++)
          rows.push(
            Array.from({ length: grid.endColumnIndex - grid.startColumnIndex }, (_, c) =>
              sheet.cells.get(`${r + 1}:${c + grid.startColumnIndex + 1}`)
            )
          );
        rows.sort((a, b) => {
          for (const spec of req.sortRange.sortSpecs) {
            const column = spec.dimensionIndex - grid.startColumnIndex;
            const av = a[column]?.value,
              bv = b[column]?.value;
            if (av !== bv) return (av < bv ? -1 : 1) * (spec.sortOrder === 'ASCENDING' ? 1 : -1);
          }
          return 0;
        });
        rows.forEach((row, r) =>
          row.forEach((value, c) => {
            const key = `${r + grid.startRowIndex + 1}:${c + grid.startColumnIndex + 1}`;
            if (value) sheet.cells.set(key, value);
            else sheet.cells.delete(key);
          })
        );
      }
      return { replies: [{}] };
    }
    const result = batch(body, id);
    for (const request of body.requests) {
      if (!request.updateSheetProperties) continue;
      const props = request.updateSheetProperties.properties;
      const sheet = f.state.books.get(id).sheets.find((s) => s.id === props.sheetId);
      if (props.title) sheet.name = props.title;
      if (props.gridProperties?.frozenColumnCount !== undefined)
        sheet.frozenColumns = props.gridProperties.frozenColumnCount;
    }
    return result;
  };
  // A report source for run_report, saved reports and dashboards.
  f.rows = [
    { date: '2026-08-01', campaign: 'Brand', spend: 10.5, clicks: 100 },
    { date: '2026-08-02', campaign: 'Generic', spend: 5, clicks: 20 },
  ];
  f.fetched = 0;
  f.api.dmvRegisterConnector_({
    id: 'orchard',
    label: 'Orchard Ads',
    description: 'Arbitrary test source',
    category: 'Test',
    allowedHosts: ['orchard.example'],
    authFields: [
      { key: 'account', label: 'Account', type: 'text', required: true },
      { key: 'token', label: 'Token', type: 'password', required: true },
    ],
    reports: [
      {
        id: 'daily',
        label: 'Daily campaigns',
        fields: COLUMNS,
        dateRange: true,
        configFields: [],
        fetch() {
          f.fetched++;
          return { columns: COLUMNS, rows: f.rows, metadata: { complete: true, currency: 'EUR' } };
        },
      },
    ],
  });
  f.connection = f.api.dmvSaveConnection({
    connectorId: 'orchard',
    label: 'Orchard main',
    credentials: { account: 'acct-1', token: 'baseline-private-token' },
  });
  f.session = f.api.dmvChatSession_(f.book);
  f.inspect = (range = 'A1:B3', sheetName = 'Output', session = f.session) =>
    plain(f.api.dmvChatInspectSheet_(session, { sheetName, range }));
  f.edit = (action, extra, inspected = f.inspect()) =>
    plain(
      f.api.dmvChatEditSheet_(f.session, {
        action,
        sheetName: inspected.sheetName,
        range: inspected.range,
        editToken: inspected.editToken,
        ...extra,
      })
    );
  f.lastBody = () => f.state.batches.at(-1).body;
  f.fill = (sheet, rows, top = 1, left = 1) =>
    rows.forEach((line, r) =>
      line.forEach((value, c) => {
        if (value !== '') f.setCell(sheet, top + r, left + c, value);
      })
    );
  // The cells of a receipt's area as entered: the value of each cell (a date as its serial), but
  // the text given for each formula cell by its A1 address, as the receipt keeps it (each
  // reference as #).
  f.areaValues = (sheet, area, formulas = {}) => {
    const values = Array.from({ length: area.rows }, (_, r) =>
      Array.from({ length: area.columns }, (_, c) => f.value(sheet, area.row + r, area.column + c))
    );
    for (const [cell, text] of Object.entries(formulas)) {
      const { row, column } = a1(cell);
      values[row - area.row][column - area.column] = text;
    }
    return values;
  };
  f.receiptKeys = () =>
    [...f.state.user.data.keys()].filter((key) => key.startsWith('dmv:v1:output:'));
  return f;
}

function dashboardInput(f) {
  return {
    name: 'Overview',
    target: { sheetName: 'Dash' },
    datasets: [
      {
        id: 'main',
        label: 'Main',
        sheetName: 'Main data',
        connectionId: f.connection.id,
        reportType: 'daily',
        fields: ['date', 'campaign', 'spend', 'clicks'],
        config: {},
        dateRange: { preset: 'lastMonth' },
        maxRows: 100,
      },
    ],
    tiles: [
      { title: 'Totals', type: 'kpi', metrics: [{ field: 'spend', agg: 'sum' }] },
      {
        title: 'Spend by campaign',
        type: 'column',
        groupBy: ['campaign'],
        metrics: [{ field: 'spend', agg: 'sum' }],
      },
    ],
  };
}

// Every expected key holds the expected value; results may gain fields, never lose or change one.
function assertIncludes(actual, expected, message) {
  for (const [key, value] of Object.entries(expected))
    assert.deepEqual(actual[key], value, (message ? message + ': ' : '') + key);
}

const grid = (sheetId, startRowIndex, endRowIndex, startColumnIndex, endColumnIndex) => ({
  sheetId,
  startRowIndex,
  endRowIndex,
  startColumnIndex,
  endColumnIndex,
});

test('baseline: list_sheets lists every tab with its grid size and records one summary event', () => {
  const f = fixture();
  const notes = f.book.insertSheet('Notes');
  const listed = plain(f.api.dmvChatListSheets_(f.session, {}));
  assert.deepEqual(Object.keys(listed), ['sheets']);
  assert.equal(listed.sheets.length, 2);
  assertIncludes(listed.sheets[0], {
    sheetName: 'Output',
    sheetId: f.sheet.id,
    rows: 100,
    columns: 26,
  });
  assertIncludes(listed.sheets[1], {
    sheetName: 'Notes',
    sheetId: notes.id,
    rows: 100,
    columns: 26,
  });
  assert.deepEqual(plain(f.session.events), [
    { kind: 'summary', text: 'Listed available spreadsheet tabs' },
  ]);
  assert.equal(plain(f.api.dmvChatListSheets_(f.session)).sheets.length, 2, 'input may be omitted');
  assert.throws(
    () => f.api.dmvChatListSheets_(f.session, { hidden: true }),
    /^Error: Use only the documented fields for this sheet action\.$/
  );
  assert.equal(f.state.batches.length, 0);
});

test('baseline: inspect_sheet returns counts, a three-row sample and a private five-minute token', () => {
  const f = fixture();
  f.fill(f.sheet, [
    ['Campaign', 'Spend', 'Note', '', '', '', '', '', 'Ninth'],
    ['Brand', 10.5, true],
    ['Generic', 5],
    ['Hidden fourth row', 1],
  ]);
  f.setCell(f.sheet, 3, 3, '=B2+B3', '=B2+B3');
  const result = f.inspect('A1:I4');
  assertIncludes(result, {
    sheetName: 'Output',
    sheetId: f.sheet.id,
    range: 'A1:I4',
    rows: 4,
    columns: 9,
    nonEmptyCells: 12,
    formulaCells: 1,
    expiresInSeconds: 300,
    sample_rows: [
      ['Campaign', 'Spend', 'Note', null, null, null, null, null],
      ['Brand', 10.5, true, null, null, null, null, null],
      ['Generic', 5, '=B2+B3', null, null, null, null, null],
    ],
  });
  assert.match(result.editToken, /^e[a-f0-9]{32}$/);
  // The token is stored privately with metadata only, never the cells.
  const saved = JSON.parse(f.state.cache.get('dmv:sheet-edit:' + result.editToken));
  assert.deepEqual(Object.keys(saved).sort(), [
    'createdAt',
    'fingerprint',
    'range',
    'sheetId',
    'sheetName',
    'spreadsheetId',
  ]);
  assertIncludes(saved, {
    spreadsheetId: BOOK,
    sheetId: f.sheet.id,
    sheetName: 'Output',
    range: 'A1:I4',
    createdAt: f.api.Date.now(),
  });
  assert.match(saved.fingerprint, /^[a-f0-9]{64}$/);
  assert.ok(![...f.state.cache.data.values()].some((value) => value.includes('Hidden fourth row')));
  // One grid read of exactly the inspected range, covering what the fingerprint protects.
  const read = f.state.gets.at(-1);
  assert.equal(read.spreadsheetId, BOOK);
  assert.deepEqual(read.options.ranges, ["'Output'!A1:I4"]);
  assert.equal(read.options.includeGridData, true);
  for (const part of [
    'properties',
    'basicFilter',
    'userEnteredValue',
    'effectiveValue',
    'userEnteredFormat',
    'dataValidation',
    'note',
  ])
    assert.match(read.options.fields, new RegExp('\\b' + part + '\\b'), part);
  assert.deepEqual(plain(f.session.events), [{ kind: 'summary', text: 'Inspected Output!A1:I4' }]);
  // The same unchanged cells give the same fingerprint; lower-case input is normalized.
  const again = f.inspect('a1:i4');
  assert.equal(again.range, 'A1:I4');
  assert.notEqual(again.editToken, result.editToken);
  assert.equal(
    JSON.parse(f.state.cache.get('dmv:sheet-edit:' + again.editToken)).fingerprint,
    saved.fingerprint
  );
  // Quoted tab names with apostrophes are escaped in the read.
  f.book.insertSheet("Bob's tab");
  f.inspect('B2', "Bob's tab");
  assert.deepEqual(f.state.gets.at(-1).options.ranges, ["'Bob''s tab'!B2"]);
  assert.equal(f.state.batches.length, 0, 'inspection never writes');
});

test('baseline: inspect_sheet ranges are explicit, same-tab and at most 1,000 cells, 200 rows and 30 columns', () => {
  const f = fixture();
  const shape = /^Error: Use an explicit same-tab A1 range, such as B2 or A1:F20\.$/;
  const caps = /^Error: Inspect or edit at most 1,000 cells, 200 rows and 30 columns at a time\.$/;
  for (const range of ['Other!A1', 'A:A', 'A1:B', '1:2', 'A0', '', 'A1:B2:C3', 'NamedRange'])
    assert.throws(() => f.inspect(range), shape, range);
  for (const range of ['A1:AE1', 'A1:A201', 'A1:Z39', 'B2:A1', 'A2:A1'])
    assert.throws(() => f.inspect(range), caps, range);
  assert.throws(
    () => f.inspect('A101'),
    /^Error: The requested range is outside the existing sheet grid\.$/
  );
  assert.throws(() => f.inspect('AA1'), /outside the existing sheet grid/);
  assert.throws(
    () => f.inspect('A1', 'Missing'),
    /^Error: No tab named "Missing"\. Tabs: Output \(closest first\)\. Never search for it: for a new tab, make it first with edit_sheet create_sheet; otherwise tell the user it does not exist\.$/
  );
  assert.throws(
    () => f.api.dmvChatInspectSheet_(f.session, { sheetName: 'Output', range: 'A1', extra: 1 }),
    /documented fields/
  );
  // The largest allowed shapes still inspect.
  const tall = f.addSpreadsheet('tall', ['Big']);
  tall.sheets[0].maxRows = 300;
  const session = f.api.dmvChatSession_(tall);
  assert.equal(f.inspect('A1:E200', 'Big', session).rows, 200);
  assert.equal(f.inspect('A1:Z38').columns, 26);
  assert.equal(f.inspect('A1:Z1').columns, 26);
  assert.equal(f.inspect('A1:A1').range, 'A1', 'a one-cell range is named by its cell');
  assert.equal(f.state.batches.length, 0);
});

test('baseline: set_values sends one exact updateCells request, keeps text literal and leaves neighbours alone', () => {
  const f = fixture();
  f.setCell(f.sheet, 1, 3, 'keep');
  f.setCell(f.sheet, 3, 1, 'below');
  const inspected = f.inspect('A1:B2');
  const result = f.edit(
    'set_values',
    {
      values: [
        ['=IMPORTDATA("https://example.com")', 12.5],
        [true, null],
      ],
    },
    inspected
  );
  assert.deepEqual(f.lastBody(), {
    requests: [
      {
        updateCells: {
          range: grid(f.sheet.id, 0, 2, 0, 2),
          rows: [
            {
              values: [
                { userEnteredValue: { stringValue: '=IMPORTDATA("https://example.com")' } },
                { userEnteredValue: { numberValue: 12.5 } },
              ],
            },
            { values: [{ userEnteredValue: { boolValue: true } }, {}] },
          ],
          fields: 'userEnteredValue',
        },
      },
    ],
  });
  assert.equal(f.state.batches.length, 1);
  assert.equal(f.state.batches[0].spreadsheetId, BOOK);
  assertIncludes(result, {
    ok: true,
    action: 'set_values',
    sheetName: 'Output',
    url: url(f.sheet.id, 'A1:B2'),
    range: 'A1:B2',
  });
  assert.equal(f.value(f.sheet, 1, 1), '=IMPORTDATA("https://example.com")');
  assert.equal(f.formula(f.sheet, 1, 1), '', 'text starting with = stays text');
  assert.equal(f.value(f.sheet, 2, 1), true);
  assert.equal(f.value(f.sheet, 1, 3), 'keep');
  assert.equal(f.value(f.sheet, 3, 1), 'below');
  const event = plain(f.session.events.at(-1));
  assertIncludes(event, {
    kind: 'write',
    links: [{ label: 'Output', url: url(f.sheet.id, 'A1:B2') }],
    text: 'Updated Output!A1:B2',
  });
  assert.deepEqual(event.details.slice(0, 2), [
    { label: 'Action', value: 'set_values' },
    { label: 'Range', value: 'A1:B2' },
  ]);
  assert.equal(f.state.scriptLockAcquires, f.state.scriptLockReleases);
  assert.equal(f.state.legacyWrites.length, 0, 'edits go through the Sheets API batch only');
  // Empty strings clear a cell like null.
  f.edit('set_values', { values: [['', 'x']] }, f.inspect('A1:B1'));
  assert.deepEqual(f.lastBody().requests[0].updateCells.rows, [
    { values: [{}, { userEnteredValue: { stringValue: 'x' } }] },
  ]);
  assert.equal(f.value(f.sheet, 1, 1), '');
  // A single cell keeps its one-cell A1 range.
  f.edit('set_values', { values: [[-0.25]] }, f.inspect('D4'));
  assert.deepEqual(f.lastBody().requests[0].updateCells.range, grid(f.sheet.id, 3, 4, 3, 4));
  assert.equal(f.edit('set_values', { values: [[1]] }, f.inspect('D4')).range, 'D4');
});

test('baseline: set_values refuses wrong shapes, non-literals and oversized edits before any write', () => {
  const f = fixture();
  const inspected = f.inspect('A1:B2');
  const shape =
    /^Error: The cell matrix must match the inspected range exactly: A1:B2 is 2 rows × 2 columns\.$/;
  for (const values of [
    [[1, 2]],
    [[1], [2]],
    [[1, 2], [3]],
    [
      [1, 2],
      [3, 4],
      [5, 6],
    ],
    'text',
    null,
    [1, 2],
  ])
    assert.throws(() => f.edit('set_values', { values }, inspected), shape, JSON.stringify(values));
  const literal = /^Error: Cell values must be literal text, finite numbers, booleans or null\.$/;
  for (const bad of [{ formula: '=1' }, ['nested'], 'x'.repeat(5001)])
    assert.throws(
      () =>
        f.edit(
          'set_values',
          {
            values: [
              [bad, 1],
              [1, 1],
            ],
          },
          inspected
        ),
      literal
    );
  // Non-finite numbers cannot be written either (JSON turns them into null on the way in).
  assert.throws(
    () =>
      f.api.dmvChatEditSheet_(f.session, {
        action: 'set_values',
        sheetName: 'Output',
        range: 'A1:B2',
        editToken: inspected.editToken,
        values: [
          [Infinity, 1],
          [1, NaN],
        ],
      }),
    literal
  );
  assert.throws(
    () =>
      f.edit(
        'set_values',
        {
          values: [
            [1, 1],
            [1, 1],
          ],
          requests: [],
        },
        inspected
      ),
    /^Error: Use only the documented fields for this sheet action\.$/
  );
  assert.throws(
    () =>
      f.edit(
        'set_values',
        {
          values: [
            [1, 1],
            [1, 1],
          ],
          formulas: [],
        },
        inspected
      ),
    /documented fields/
  );
  const big = f.inspect('A1:C20');
  assert.throws(
    () =>
      f.edit(
        'set_values',
        {
          values: Array.from({ length: 20 }, () => [
            'x'.repeat(4999),
            'x'.repeat(4999),
            'x'.repeat(4999),
          ]),
        },
        big
      ),
    /^Error: The sheet edit is too large\. Use a smaller range\.$/
  );
  assert.equal(f.state.batches.length, 0);
  // A refused edit keeps its token: the same inspection still allows a valid edit.
  f.edit(
    'set_values',
    {
      values: [
        ['a', 'b'],
        ['c', 'd'],
      ],
    },
    inspected
  );
  assert.equal(f.value(f.sheet, 2, 2), 'd');
});

test('baseline: every edit needs a matching, fresh, unchanged inspection and the token is single use', () => {
  const f = fixture();
  const notes = f.book.insertSheet('Notes');
  const missing = /^Error: Inspect the target range before editing it\.$/;
  const expired =
    /^Error: The inspection expired or belongs to another range\. Inspect this range again\.$/;
  const changed =
    /^Error: The inspected cells or sheet settings changed\. Inspect the range again before editing\.$/;
  for (const action of [
    'set_values',
    'set_formulas',
    'format',
    'sort',
    'filter',
    'rename_sheet',
  ]) {
    // freeze is a tab action (chat-sheet-dashboard-flow), like create_sheet; format, sort and
    // filter without an editToken need no inspection (chat-sheet-sweep-edits).
    if (!['format', 'sort', 'filter'].includes(action))
      assert.throws(
        () => f.api.dmvChatEditSheet_(f.session, { action, sheetName: 'Output', range: 'A1' }),
        missing,
        action
      );
    assert.throws(
      () =>
        f.api.dmvChatEditSheet_(f.session, {
          action,
          sheetName: 'Output',
          range: 'A1',
          editToken: 'not-a-token',
        }),
      missing,
      action
    );
  }
  assert.throws(
    () =>
      f.edit(
        'set_values',
        { values: [[1]], editToken: 'e' + '0'.repeat(32) },
        { sheetName: 'Output', range: 'A1' }
      ),
    expired
  );
  const inspected = f.inspect('A1');
  assert.throws(
    () => f.edit('set_values', { values: [[1]], range: 'A2' }, inspected),
    expired,
    'another range'
  );
  assert.throws(
    () => f.edit('set_values', { values: [[1]], sheetName: 'Notes' }, inspected),
    expired,
    'another tab'
  );
  const other = f.addSpreadsheet('other', ['Output']);
  assert.throws(
    () =>
      f.api.dmvChatEditSheet_(f.api.dmvChatSession_(other), {
        action: 'set_values',
        sheetName: 'Output',
        range: 'A1',
        editToken: inspected.editToken,
        values: [[1]],
      }),
    expired,
    'another workbook'
  );
  // Another user's cache never holds the token.
  assert.throws(
    () => fixture().edit('set_values', { values: [[1]] }, inspected),
    expired,
    'another user'
  );
  // Each covered change refuses the stale token.
  const changes = {
    value: (g) => g.setCell(g.sheet, 1, 1, 'changed'),
    formula: (g) => g.setCell(g.sheet, 1, 1, '=1+1', '=1+1'),
    format: (g) => g.sheet.formats.set('1:1', { textFormat: { bold: true } }),
    validation: (g) =>
      (g.sheet.metadata = new Map([
        ['1:1', { dataValidation: { condition: { type: 'BOOLEAN' } } }],
      ])),
    note: (g) => (g.sheet.metadata = new Map([['1:1', { note: 'hello' }]])),
    filter: (g) => (g.sheet.filter = { range: grid(g.sheet.id, 0, 3, 0, 2) }),
    frozen: (g) => (g.sheet.frozenRows = 1),
    renamed: (g) => (g.sheet.name = 'Renamed elsewhere'),
  };
  for (const [name, change] of Object.entries(changes)) {
    const g = fixture();
    const token = g.inspect('A1');
    change(g);
    const sheetName = name === 'renamed' ? 'Renamed elsewhere' : 'Output';
    assert.throws(
      () => g.edit('set_values', { values: [[42]], sheetName }, token),
      name === 'renamed' ? expired : changed,
      name
    );
    assert.equal(g.state.batches.length, 0, name);
  }
  // Expiry after five minutes, checked once the turn's own deadline allows the action at all.
  const late = f.inspect('B1');
  f.advance(300001);
  assert.throws(
    () => f.edit('set_values', { values: [[1]] }, late),
    /^Error: The sheet action reached its time limit\. Ask again to continue\.$/
  );
  f.session.deadline = f.api.Date.now() + 60000;
  assert.throws(() => f.edit('set_values', { values: [[1]] }, late), expired);
  // A used token is removed, so a replay asks for a new inspection.
  const fresh = f.inspect('C1');
  f.edit('set_values', { values: [[1]] }, fresh);
  assert.equal(f.state.cache.get('dmv:sheet-edit:' + fresh.editToken), null);
  assert.throws(() => f.edit('set_values', { values: [[1]] }, fresh), expired);
  assert.equal(f.state.batches.length, 1);
  assert.equal(notes.cells.size, 0);
});

test('baseline: a busy workbook lock or a failed batch writes nothing and keeps the token', () => {
  const f = fixture();
  const inspected = f.inspect('A1');
  f.state.scriptLockAvailable = false;
  assert.throws(
    () => f.edit('set_values', { values: [[7]] }, inspected),
    /^Error: Another user is updating report output\. Try again shortly\.$/
  );
  f.state.scriptLockAvailable = true;
  f.state.failBatch = true;
  assert.throws(
    () => f.edit('set_values', { values: [[7]] }, inspected),
    /Simulated atomic batch failure/
  );
  assert.equal(f.value(f.sheet, 1, 1), '');
  assert.ok(f.state.cache.get('dmv:sheet-edit:' + inspected.editToken));
  assert.ok(!f.session.events.some((event) => event.kind === 'write'));
  f.state.failBatch = false;
  f.edit('set_values', { values: [[7]] }, inspected);
  assert.equal(f.value(f.sheet, 1, 1), 7);
  assert.equal(
    f.state.scriptLockAcquires,
    f.state.scriptLockReleases + 1,
    'the refused lock was never held'
  );
});

test('baseline: set_formulas writes accepted formulas as formulaValue in one exact request', () => {
  const f = fixture();
  f.fill(f.sheet, [[2], [4]], 2, 1);
  const accepted = [
    '=SUM(A2:A3)',
    '=IF(A2>0,A2,0)',
    '=ROUND(AVERAGE(A2:A3),2)',
    '=COUNTIFS(A2:A3,">0")',
    '=SUMIFS(A2:A3,A2:A3,">1")',
    '=SUMIF(A2:A3,">1")',
    '=TEXT(TODAY(),"yyyy-mm-dd")',
    '="IMPORTRANGE is only text here"',
    '=$A$2*2+A$3-$A3',
    '=A2%',
    '=IFERROR(A2/A3,0)',
    '=CONCATENATE(UPPER("a"),LEN("bc"))',
    '=TRUE',
    '=-A2^2&"x"',
    '=SUMPRODUCT(A2:A3,A2:A3)',
    '=IF(AND(A2>=1,A3<>0),"ok","no")',
  ];
  const inspected = f.inspect('B1:B16');
  const result = f.edit(
    'set_formulas',
    { formulas: accepted.map((formula) => [formula]) },
    inspected
  );
  assert.deepEqual(f.lastBody(), {
    requests: [
      {
        updateCells: {
          range: grid(f.sheet.id, 0, 16, 1, 2),
          rows: accepted.map((formula) => ({
            values: [{ userEnteredValue: { formulaValue: formula } }],
          })),
          fields: 'userEnteredValue',
        },
      },
    ],
  });
  assertIncludes(result, {
    ok: true,
    action: 'set_formulas',
    sheetName: 'Output',
    range: 'B1:B16',
  });
  accepted.forEach((formula, index) => assert.equal(f.formula(f.sheet, index + 1, 2), formula));
  assert.deepEqual(plain(f.session.events.at(-1).details.slice(0, 2)), [
    { label: 'Action', value: 'set_formulas' },
    { label: 'Range', value: 'B1:B16' },
  ]);
});

test('baseline: set_formulas refuses external, custom and indirect functions and non-formulas, writing nothing', () => {
  const f = fixture();
  for (const formula of [
    '=IMPORTRANGE("abc","A1")',
    '=IMPORTDATA("https://example.com")',
    '=importdata("https://example.com")',
    '=IMPORTDATA ("https://example.com")',
    '=IMPORTHTML("https://example.com","table",1)',
    '=IMPORTXML("https://example.com","//a")',
    '=IMPORTFEED("https://example.com")',
    '=IMAGE("https://example.com/a.png")',
    '=GOOGLEFINANCE("GOOG")',
    '=GOOGLETRANSLATE("hola")',
    '=DETECTLANGUAGE("hola")',
    '=INDIRECT("A1")',
    '=SUM(INDIRECT("A1:A2"))',
    '=IF(TRUE,IMPORTDATA("https://example.com"),0)',
    '=MYCUSTOMFUNCTION(A1)',
    ' =SUM(A1:A2)',
  ]) {
    assert.throws(
      () => f.edit('set_formulas', { formulas: [[formula]] }, f.inspect('D1')),
      (error) => typeof error.message === 'string',
      String(formula)
    );
  }
  assert.equal(f.state.batches.length, 0);
  assert.equal(f.sheet.cells.size, 0);
  assert.throws(
    () => f.edit('set_formulas', { formulas: [['=1', '=2']] }, f.inspect('D1')),
    /^Error: The cell matrix must match the inspected range exactly: D1 is 1 rows × 1 columns\.$/
  );
  // Lifted for KPI blocks: cells without = are literal labels, numbers and blanks.
  f.edit('set_formulas', { formulas: [['SUM(A1:A2)', '', 42, null]] }, f.inspect('D1:G1'));
  assert.deepEqual(
    [4, 5, 6, 7].map((column) => [f.value(f.sheet, 1, column), f.formula(f.sheet, 1, column)]),
    [
      ['SUM(A1:A2)', ''],
      ['', ''],
      [42, ''],
      ['', ''],
    ]
  );
});

test('baseline (narrow policy the analyst spec lifts): set_formulas now accepts cross-tab, named, array, lookup and spilling formulas', () => {
  // Lifted by the analyst sheet tools (dmv_chat_sheet_formulas.js), as this test said it would
  // be: each formula below was refused before. A missing tab or named range is still refused,
  // and the formulas of referenced cells are no longer walked (whole columns and other tabs
  // make that impossible; reading a result fetches nothing new).
  const f = fixture();
  f.book.insertSheet('Other');
  for (const [formula, refusal] of [
    ["='DataMoovReports'!A1", /No tab named "DataMoovReports"/],
    ['=NamedRange', /unknown name NAMEDRANGE/],
    ['=SUM(NamedRange)', /unknown name NAMEDRANGE/],
  ]) {
    assert.throws(
      () => f.edit('set_formulas', { formulas: [[formula]] }, f.inspect('D1')),
      refusal,
      formula
    );
  }
  assert.equal(f.state.batches.length, 0);
  // Existing unsafe formulas a reference reaches no longer refuse it.
  f.setCell(f.sheet, 1, 1, '=B1', '=B1');
  f.setCell(f.sheet, 1, 2, '=INDIRECT("Other!A1")', '=INDIRECT("Other!A1")');
  const accepted = [
    '=Other!A1',
    "='Other'!A1",
    '=A1:A3',
    '=IF(TRUE,A1:A3,0)',
    '={1,2}',
    '=IF(TRUE,{1,2},0)',
    '=SUM(A:A)',
    '=SUM(A2:A)',
    '=FILTER(A1:A3,A1:A3>0)',
    '=UNIQUE(A1:A3)',
    '=SORT(A1:A3)',
    '=QUERY(A1:B3,"select A")',
    '=ARRAYFORMULA(A1:A3*2)',
    '=VLOOKUP(1,A1:B3,2,FALSE)',
    '=XLOOKUP(1,A1:A3,B1:B3)',
    '=INDEX(A1:A3,MATCH(1,A1:A3,0))',
    '=LET(x,1,x+1)',
    '=REGEXEXTRACT("a1","\\d")',
    '=HYPERLINK("https://example.com","x")',
    '=SUMIF(A1:A3,B1:B3,C1:C3)',
    '=COUNTIFS(A1:A3,B1:B3)',
    '=SUMIFS(A1:A3,B1:B3,C1:C3)',
    '=' + '1+'.repeat(1000) + '1',
    '=A1',
    '=SUM(E1:N100)+SUM(O1:X100)',
  ];
  accepted.forEach((formula, index) => {
    const row = 1 + index * 4;
    f.edit('set_formulas', { formulas: [[formula]] }, f.inspect('D' + row));
    assert.equal(f.formula(f.sheet, row, 4), formula, formula.slice(0, 60));
  });
  assert.equal(f.state.batches.length, accepted.length);
});

test('baseline: format sends one repeatCell with colour styles and a field mask of exactly the requested parts', () => {
  const f = fixture();
  f.sheet.formats.set('1:1', { verticalAlignment: 'TOP' });
  const inspected = f.inspect('A1:B3');
  const result = f.edit(
    'format',
    {
      format: {
        numberFormat: 'percent',
        bold: true,
        textColor: '#336699',
        backgroundColor: '#FF0000',
        horizontalAlignment: 'RIGHT',
        wrap: true,
      },
    },
    inspected
  );
  const blue = { red: 0x33 / 255, green: 0x66 / 255, blue: 0x99 / 255 };
  assert.deepEqual(f.lastBody(), {
    requests: [
      {
        repeatCell: {
          range: grid(f.sheet.id, 0, 3, 0, 2),
          cell: {
            userEnteredFormat: {
              numberFormat: { type: 'PERCENT', pattern: '0.00%' },
              textFormat: { bold: true, foregroundColorStyle: { rgbColor: blue } },
              backgroundColorStyle: { rgbColor: { red: 1, green: 0, blue: 0 } },
              horizontalAlignment: 'RIGHT',
              wrapStrategy: 'WRAP',
            },
          },
          fields:
            'userEnteredFormat.numberFormat,userEnteredFormat.textFormat.bold,userEnteredFormat.textFormat.foregroundColorStyle,userEnteredFormat.backgroundColorStyle,userEnteredFormat.horizontalAlignment,userEnteredFormat.wrapStrategy',
        },
      },
    ],
  });
  assertIncludes(result, { ok: true, action: 'format', sheetName: 'Output', range: 'A1:B3' });
  assert.equal(
    f.format(f.sheet, 1, 1).verticalAlignment,
    'TOP',
    'formatting outside the mask stays'
  );
  assert.equal(f.format(f.sheet, 3, 2).horizontalAlignment, 'RIGHT');
  // Each number format and each single option maps to a fixed format and mask.
  const formats = {
    number: { type: 'NUMBER', pattern: '#,##0.00' },
    currency: { type: 'NUMBER', pattern: '#,##0.00' },
    percent: { type: 'PERCENT', pattern: '0.00%' },
    date: { type: 'DATE', pattern: 'yyyy-mm-dd' },
    text: { type: 'TEXT', pattern: '@' },
  };
  for (const [name, numberFormat] of Object.entries(formats)) {
    f.edit('format', { format: { numberFormat: name } }, f.inspect('C1'));
    assert.deepEqual(
      f.lastBody().requests[0].repeatCell,
      {
        range: grid(f.sheet.id, 0, 1, 2, 3),
        cell: { userEnteredFormat: { numberFormat } },
        fields: 'userEnteredFormat.numberFormat',
      },
      name
    );
  }
  f.edit('format', { format: { bold: false } }, f.inspect('C1'));
  assert.deepEqual(f.lastBody().requests[0].repeatCell.cell, {
    userEnteredFormat: { textFormat: { bold: false } },
  });
  assert.equal(f.lastBody().requests[0].repeatCell.fields, 'userEnteredFormat.textFormat.bold');
  f.edit('format', { format: { wrap: false, horizontalAlignment: 'LEFT' } }, f.inspect('C1'));
  assert.deepEqual(f.lastBody().requests[0].repeatCell.cell, {
    userEnteredFormat: { horizontalAlignment: 'LEFT', wrapStrategy: 'CLIP' },
  });
  assert.equal(
    f.lastBody().requests[0].repeatCell.fields,
    'userEnteredFormat.horizontalAlignment,userEnteredFormat.wrapStrategy'
  );
  f.edit('format', { format: { textColor: '#000000' } }, f.inspect('C1'));
  assert.deepEqual(f.lastBody().requests[0].repeatCell.cell, {
    userEnteredFormat: {
      textFormat: { foregroundColorStyle: { rgbColor: { red: 0, green: 0, blue: 0 } } },
    },
  });
});

test('baseline: format refuses unknown, empty and malformed options', () => {
  const f = fixture();
  const inspected = f.inspect('A1');
  for (const [format, message] of [
    [{}, /^Error: Choose at least one formatting change\.$/],
    [{ italic: true }, /^Error: Use only the documented fields for this sheet action\.$/],
    [
      { numberFormat: 'scientific' },
      /^Error: Choose number, currency, percent, date or text formatting\.$/,
    ],
    [
      { numberFormat: 'toString' },
      /^Error: Choose number, currency, percent, date or text formatting\.$/,
    ],
    [{ bold: 'yes' }, /^Error: bold must be true or false\.$/],
    [{ wrap: 1 }, /^Error: wrap must be true or false\.$/],
    [{ textColor: 'red' }, /^Error: Use colors in #RRGGBB form\.$/],
    [{ backgroundColor: '#FFF' }, /^Error: Use colors in #RRGGBB form\.$/],
    [{ horizontalAlignment: 'JUSTIFY' }, /^Error: Choose LEFT, CENTER or RIGHT alignment\.$/],
    [null, /documented fields/],
    [[], /documented fields/],
  ])
    assert.throws(() => f.edit('format', { format }, inspected), message, JSON.stringify(format));
  assert.equal(f.state.batches.length, 0);
});

test('baseline: sort sends one exact sortRange below the header and keeps rows outside the range', () => {
  const f = fixture();
  f.fill(f.sheet, [
    ['Campaign', 'Spend'],
    ['Low', 1],
    ['High', 3],
    ['Outside', 99],
  ]);
  const result = f.edit('sort', { sortBy: [{ column: 2, ascending: false }] });
  assert.deepEqual(f.lastBody(), {
    requests: [
      {
        sortRange: {
          range: grid(f.sheet.id, 1, 3, 0, 2),
          sortSpecs: [{ dimensionIndex: 1, sortOrder: 'DESCENDING' }],
        },
      },
    ],
  });
  assertIncludes(result, { ok: true, action: 'sort', sheetName: 'Output', range: 'A1:B3' });
  assert.deepEqual(
    [1, 2, 3, 4].map((row) => f.value(f.sheet, row, 1)),
    ['Campaign', 'High', 'Low', 'Outside']
  );
  // headerRows 0 sorts every row; columns count from the range's first column.
  f.edit(
    'sort',
    {
      sortBy: [
        { column: 2, ascending: true },
        { column: 1, ascending: false },
      ],
      headerRows: 0,
    },
    f.inspect('C2:D5')
  );
  assert.deepEqual(f.lastBody(), {
    requests: [
      {
        sortRange: {
          range: grid(f.sheet.id, 1, 5, 2, 4),
          sortSpecs: [
            { dimensionIndex: 3, sortOrder: 'ASCENDING' },
            { dimensionIndex: 2, sortOrder: 'DESCENDING' },
          ],
        },
      },
    ],
  });
  const inspected = f.inspect('A1:B3');
  for (const [extra, message] of [
    [{ sortBy: [] }, /^Error: Choose between one and five sort columns\.$/],
    [
      { sortBy: Array.from({ length: 6 }, () => ({ column: 1, ascending: true })) },
      /^Error: Choose between one and five sort columns\.$/,
    ],
    [{}, /^Error: Choose between one and five sort columns\.$/],
    [{ sortBy: [{ column: 1 }] }, /^Error: Choose an ascending or descending sort\.$/],
    [
      { sortBy: [{ column: 3, ascending: true }] },
      /^Error: Sort column must be between 1 and 2\.$/,
    ],
    [
      { sortBy: [{ column: 1.5, ascending: true }] },
      /^Error: Sort column must be an integer number\.$/,
    ],
    [{ sortBy: [{ column: 1, ascending: true, by: 'value' }] }, /documented fields/],
    [
      { sortBy: [{ column: 1, ascending: true }], headerRows: 2 },
      /^Error: Header rows must be between 0 and 1\.$/,
    ],
    [
      { sortBy: [{ column: 1, ascending: true }], headerRows: null },
      /^Error: Header rows must be an integer number\.$/,
    ],
  ])
    assert.throws(() => f.edit('sort', extra, inspected), message, JSON.stringify(extra));
  assert.throws(
    () => f.edit('sort', { sortBy: [{ column: 1, ascending: true }] }, f.inspect('A1:B1')),
    /^Error: The sort range must include a data row\.$/
  );
  assert.equal(f.state.batches.length, 2);
});

test('baseline: filter sends one exact setBasicFilter, keeps other criteria and refuses formula criteria', () => {
  const f = fixture();
  f.edit('filter', { filter: {} });
  assert.deepEqual(f.lastBody(), {
    requests: [{ setBasicFilter: { filter: { range: grid(f.sheet.id, 0, 3, 0, 2) } } }],
  });
  f.edit('filter', {});
  assert.deepEqual(
    f.lastBody(),
    { requests: [{ setBasicFilter: { filter: { range: grid(f.sheet.id, 0, 3, 0, 2) } } }] },
    'filter may be omitted'
  );
  const result = f.edit('filter', {
    filter: { column: 2, condition: 'NUMBER_GREATER', value: ' +001.50 ' },
  });
  assertIncludes(result, { ok: true, action: 'filter', sheetName: 'Output', range: 'A1:B3' });
  assert.deepEqual(f.lastBody(), {
    requests: [
      {
        setBasicFilter: {
          filter: {
            range: grid(f.sheet.id, 0, 3, 0, 2),
            criteria: {
              1: { condition: { type: 'NUMBER_GREATER', values: [{ userEnteredValue: '=1.5' }] } },
            },
          },
        },
      },
    ],
  });
  f.edit('filter', { filter: { column: 1, condition: 'TEXT_CONTAINS', value: 'Brand' } });
  assert.deepEqual(f.lastBody().requests[0].setBasicFilter.filter.criteria, {
    0: { condition: { type: 'TEXT_CONTAINS', values: [{ userEnteredValue: 'Brand' }] } },
    1: { condition: { type: 'NUMBER_GREATER', values: [{ userEnteredValue: '=1.5' }] } },
  });
  f.edit('filter', { filter: { column: 1, condition: 'NOT_BLANK' } });
  assert.deepEqual(f.lastBody().requests[0].setBasicFilter.filter.criteria[0], {
    condition: { type: 'NOT_BLANK' },
  });
  f.edit('filter', { filter: { column: 1, condition: 'TEXT_EQ', value: 7 } });
  assert.deepEqual(f.lastBody().requests[0].setBasicFilter.filter.criteria[0], {
    condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: '7' }] },
  });
  f.edit('filter', { filter: { column: 2, condition: 'NUMBER_LESS', value: 3 } });
  assert.deepEqual(f.lastBody().requests[0].setBasicFilter.filter.criteria[1], {
    condition: { type: 'NUMBER_LESS', values: [{ userEnteredValue: '3' }] },
  });
  const count = f.state.batches.length;
  const inspected = f.inspect('A1:B3');
  for (const [filter, message] of [
    [
      { column: 1, condition: 'TEXT_EQ', value: '=IMPORTDATA("https://example.com")' },
      /^Error: Filter criteria must be literal text, not formulas\.$/,
    ],
    [
      { column: 1, condition: 'TEXT_CONTAINS', value: '  +IMPORTXML("x","//a")' },
      /literal text, not formulas/,
    ],
    [{ column: 1, condition: 'TEXT_EQ', value: '@x' }, /literal text, not formulas/],
    [{ column: 1, condition: 'TEXT_EQ', value: '-x' }, /literal text, not formulas/],
    [
      { column: 1, condition: 'CUSTOM_FORMULA', value: '=A1' },
      /^Error: Choose a supported text, number or nonblank filter\.$/,
    ],
    [{ column: 1, condition: 'TEXT_EQ' }, /^Error: Provide a literal filter value\.$/],
    [
      { column: 1, condition: 'TEXT_EQ', value: 'x'.repeat(201) },
      /^Error: Provide a bounded valid filter value\.$/,
    ],
    [
      { column: 2, condition: 'NUMBER_GREATER', value: 'ten' },
      /^Error: Provide a bounded valid filter value\.$/,
    ],
    [
      { column: 2, condition: 'NUMBER_GREATER', value: '  ' },
      /^Error: Provide a finite numeric filter value\.$/,
    ],
    [{ column: 3, condition: 'NOT_BLANK' }, /^Error: Filter column must be between 1 and 2\.$/],
    [{ column: 1, condition: 'NOT_BLANK', extra: 1 }, /documented fields/],
  ])
    assert.throws(() => f.edit('filter', { filter }, inspected), message, JSON.stringify(filter));
  assert.equal(f.state.batches.length, count);
  // A filter over another range would drop the tab's criteria, which no undo puts back, so it
  // asks first and changes nothing.
  assert.equal(f.edit('filter', { filter: {} }, f.inspect('A1:A3')).needsConfirmation, true);
  assert.equal(f.state.batches.length, count);
  assert.deepEqual(f.sheet.filter.range, grid(f.sheet.id, 0, 3, 0, 2));
});

test('baseline: freeze sends one exact updateSheetProperties within the grid', () => {
  const f = fixture();
  const result = f.edit('freeze', { frozenRows: 1, frozenColumns: 2 });
  assert.deepEqual(f.lastBody(), {
    requests: [
      {
        updateSheetProperties: {
          properties: {
            sheetId: f.sheet.id,
            gridProperties: { frozenRowCount: 1, frozenColumnCount: 2 },
          },
          fields: 'gridProperties.frozenRowCount,gridProperties.frozenColumnCount',
        },
      },
    ],
  });
  // A tab action: the inspection's range is left out.
  assertIncludes(result, { ok: true, action: 'freeze', sheetName: 'Output', range: null });
  assert.equal(f.sheet.frozenRows, 1);
  assert.equal(f.sheet.frozenColumns, 2);
  f.edit('freeze', { frozenRows: 0 });
  assert.deepEqual(f.lastBody().requests[0].updateSheetProperties, {
    properties: { sheetId: f.sheet.id, gridProperties: { frozenRowCount: 0 } },
    fields: 'gridProperties.frozenRowCount',
  });
  f.edit('freeze', { frozenColumns: 25 });
  assert.equal(
    f.lastBody().requests[0].updateSheetProperties.fields,
    'gridProperties.frozenColumnCount'
  );
  const inspected = f.inspect();
  assert.throws(
    () => f.edit('freeze', {}, inspected),
    /^Error: Choose frozenRows or frozenColumns\.$/
  );
  assert.throws(
    () => f.edit('freeze', { frozenRows: 100 }, inspected),
    /^Error: Frozen rows must be between 0 and 99\.$/
  );
  assert.throws(
    () => f.edit('freeze', { frozenColumns: 26 }, inspected),
    /^Error: Frozen columns must be between 0 and 25\.$/
  );
  assert.throws(
    () => f.edit('freeze', { frozenRows: '1' }, inspected),
    /^Error: Frozen rows must be an integer number\.$/
  );
  assert.equal(f.state.batches.length, 3);
});

test('baseline: create_sheet sends one exact addSheet, needs no inspection and makes the tab usable this turn', () => {
  const f = fixture();
  const result = plain(
    f.api.dmvChatEditSheet_(f.session, { action: 'create_sheet', newName: '  Analysis  ' })
  );
  assert.deepEqual(f.lastBody(), {
    requests: [
      {
        addSheet: {
          properties: { title: 'Analysis', gridProperties: { rowCount: 1000, columnCount: 26 } },
        },
      },
    ],
  });
  const tab = f.tab('Analysis');
  assert.ok(tab);
  assertIncludes(result, {
    ok: true,
    action: 'create_sheet',
    sheetName: '  Analysis  ',
    url: url(tab.id, 'A1'),
    range: 'A1:Z38',
  });
  const event = plain(f.session.events.at(-1));
  assertIncludes(event, {
    kind: 'write',
    links: [{ label: '  Analysis  ', url: url(tab.id, 'A1') }],
    text: 'Created tab   Analysis  ',
  });
  assert.deepEqual(event.details.slice(0, 1), [{ label: 'Action', value: 'create_sheet' }]);
  assert.ok(f.session.sheetNames.includes('Analysis'));
  assert.ok(
    plain(f.api.dmvChatListSheets_(f.session, {})).sheets.some(
      (sheet) => sheet.sheetName === 'Analysis'
    )
  );
  // The new tab can be inspected and edited in the same turn.
  f.edit('set_values', { values: [['ready']] }, f.inspect('A1', 'Analysis'));
  assert.equal(f.value(tab, 1, 1), 'ready');
  for (const [input, message] of [
    [
      { newName: 'Analysis' },
      /^Error: A tab with that name already exists\. Choose another name\.$/,
    ],
    [{ newName: 'Output' }, /already exists/],
    [{ newName: 'a/b' }, /^Error: The output tab name contains unsupported characters\.$/],
    [{ newName: '' }, /^Error: Output tab is required\.$/],
    [{ newName: 'x'.repeat(101) }, /^Error: Output tab is too long\.$/],
    // sheetName, range and editToken are left out (chat-sheet-dashboard-flow); others refused.
    [
      { newName: 'Fine', values: [['x']] },
      /^Error: Use only the documented fields for this sheet action\.$/,
    ],
  ])
    assert.throws(
      () => f.api.dmvChatEditSheet_(f.session, { action: 'create_sheet', ...input }),
      message,
      JSON.stringify(input)
    );
  assert.throws(
    () => f.api.dmvChatEditSheet_(f.session, { action: 'delete_spreadsheet' }),
    /^Error: Choose a supported sheet action\.$/
  );
  assert.throws(
    () => f.api.dmvChatEditSheet_(f.session, null),
    /^Error: Choose a supported sheet action\.$/
  );
  assert.throws(
    () => f.api.dmvChatEditSheet_(f.session, { action: 'toString' }),
    /^Error: Choose a supported sheet action\.$/
  );
  assert.equal(f.state.batches.length, 2);
});

test('baseline: rename_sheet sends one exact title update and refuses tabs saved reports and dashboards use', () => {
  const f = fixture();
  // rename_sheet still asks dmvReadDefinitions_ for workbook report definitions, which no file in
  // src defines any more; like tests/chat-sheets.test.mjs, stand in for it with none.
  f.api.dmvReadDefinitions_ = () => ({ definitions: [] });
  f.book.insertSheet('Taken');
  const result = f.edit('rename_sheet', { newName: 'Renamed' });
  assert.deepEqual(f.lastBody(), {
    requests: [
      {
        updateSheetProperties: {
          properties: { sheetId: f.sheet.id, title: 'Renamed' },
          fields: 'title',
        },
      },
    ],
  });
  assertIncludes(result, {
    ok: true,
    action: 'rename_sheet',
    sheetName: 'Renamed',
    url: url(f.sheet.id, 'A1:B3'),
    range: 'A1:B3',
  });
  assertIncludes(plain(f.session.events.at(-1)), {
    kind: 'write',
    text: 'Updated Output!A1:B3',
    links: [{ label: 'Renamed', url: url(f.sheet.id, 'A1:B3') }],
  });
  assert.equal(f.sheet.name, 'Renamed');
  assert.throws(
    () => f.edit('rename_sheet', { newName: 'Taken' }, f.inspect('A1', 'Renamed')),
    /^Error: A tab with that name already exists\.$/
  );
  assert.throws(
    () => f.edit('rename_sheet', { newName: 'bad?' }, f.inspect('A1', 'Renamed')),
    /unsupported characters/
  );
  // A saved report's destination tab.
  f.api.dmvSaveReport({
    connectionId: f.connection.id,
    name: 'Daily',
    reportType: 'daily',
    fields: ['date', 'campaign', 'spend', 'clicks'],
    config: {},
    maxRows: 100,
    dateRange: { preset: 'lastMonth' },
    target: { sheetName: 'Taken', startCell: 'A1' },
    schedule: 'manual',
  });
  const saved =
    /^Error: This tab is used by a saved report\. Update its destination before renaming it\.$/;
  assert.throws(
    () => f.edit('rename_sheet', { newName: 'Moved' }, f.inspect('A1', 'Taken')),
    saved
  );
  // A refreshed dashboard's page, data and chart data tabs.
  const dashboard = plain(f.api.dmvSaveDashboard(dashboardInput(f)));
  f.api.dmvRunDashboard(dashboard.id);
  const used =
    /^Error: This tab is used by a saved dashboard\. Update its destination before renaming it\.$/;
  for (const name of ['Dash', 'Main data', 'Dash (chart data)'])
    assert.throws(
      () => f.edit('rename_sheet', { newName: 'Moved' }, f.inspect('Z1', name)),
      used,
      name
    );
  assert.ok(f.tab('Dash') && f.tab('Main data') && f.tab('Dash (chart data)'));
});

test('baseline: read_sheet types columns, keeps whole cells, samples long tabs and never writes', () => {
  const f = fixture();
  f.fill(f.sheet, [
    ['Month', 'Orders', '', 'Orders', 'Day', 'Mixed'],
    ['2026-08', 12, 'x', 1, new f.api.Date('2026-08-01T00:00:00Z'), 1],
    ['2026-09', 30, '', 2, new f.api.Date('2026-09-01T00:00:00Z'), 'two'],
  ]);
  const read = plain(f.api.dmvChatReadSheet_(f.session, { sheetName: 'Output' }));
  assert.match(read.resultId, /^r[a-f0-9]{8}$/);
  assertIncludes(read, {
    rowCount: 2,
    columns: [
      { key: 'month', label: 'Month', type: 'text' },
      { key: 'orders', label: 'Orders', type: 'number' },
      { key: 'column_3', label: 'Column 3', type: 'text' },
      { key: 'orders_', label: 'Orders', type: 'number' },
      { key: 'day', label: 'Day', type: 'date' },
      { key: 'mixed', label: 'Mixed', type: 'text' },
    ],
    rows: [
      { month: '2026-08', orders: 12, column_3: 'x', orders_: 1, day: '2026-08-01', mixed: 1 },
      { month: '2026-09', orders: 30, column_3: null, orders_: 2, day: '2026-09-01', mixed: 'two' },
    ],
  });
  assert.equal(read.stats.orders.sum, 42);
  assert.equal(read.sample_rows, undefined);
  const event = plain(f.session.events.at(-1));
  assertIncludes(event, { kind: 'read', text: 'Read 2 rows from Output', ref: read.resultId });
  assert.deepEqual(event.details, [
    { label: 'Columns', value: 'Month, Orders, Column 3, Orders, Day, Mixed' },
  ]);
  // A range reads exactly those cells.
  const ranged = plain(f.api.dmvChatReadSheet_(f.session, { sheetName: 'Output', range: 'a1:b2' }));
  assert.deepEqual(ranged.rows, [{ month: '2026-08', orders: 12 }]);
  assert.deepEqual(plain(f.session.events.at(-1).details[0]), { label: 'Range', value: 'a1:b2' });
  // More than 20 rows: the first five and last three only, with a note; the stored result is whole.
  const notes = f.book.insertSheet('Long');
  notes.maxRows = 600;
  notes.maxColumns = 40;
  f.fill(
    notes,
    [['n', 'text']].concat(Array.from({ length: 25 }, (_, i) => [i + 1, 'y'.repeat(100)]))
  );
  const long = plain(f.api.dmvChatReadSheet_(f.session, { sheetName: 'Long' }));
  assert.equal(long.rowCount, 25);
  assert.equal(long.rows, undefined);
  assert.deepEqual(
    long.sample_rows.map((row) => row.n),
    [1, 2, 3, 4, 5, 23, 24, 25]
  );
  assert.equal(long.sample_rows[0].text, 'y'.repeat(80) + '…');
  assert.equal(
    long.note,
    'sample_rows are the FIRST 5 and LAST 3 rows, not the minimum and maximum. Use summarize for totals, rankings and comparisons.'
  );
  assert.equal(f.api.dmvChatResult_(f.session, long.resultId).rows[0].text.length, 100);
  // Caps: 30 columns and a cell budget, not a row count (the budget: chat-sheet-sweep.test.mjs),
  // and no rows past the tab's last one.
  assert.equal(
    plain(f.api.dmvChatReadSheet_(f.session, { sheetName: 'Long', range: 'A1:B502' })).rowCount,
    25
  );
  assert.throws(
    () => f.api.dmvChatReadSheet_(f.session, { sheetName: 'Long', range: 'A1:AE2' }),
    /has 2 rows × 31 columns/
  );
  notes.maxRows = 600;
  f.setCell(notes, 520, 1, 'far');
  assert.equal(
    plain(f.api.dmvChatReadSheet_(f.session, { sheetName: 'Long', range: 'A1:B502' })).rowCount,
    501
  );
  assert.equal(plain(f.api.dmvChatReadSheet_(f.session, { sheetName: 'Long' })).rowCount, 519);
  assert.throws(
    () => f.api.dmvChatReadSheet_(f.session, { sheetName: 'Output', range: 'A1:F1' }),
    /^Error: The range needs a header row and at least one data row\.$/
  );
  assert.throws(
    () => f.api.dmvChatReadSheet_(f.session, { sheetName: 'Output', range: 'A1' }),
    /^Error: range must look like A1:F200\.$/
  );
  assert.throws(
    () => f.api.dmvChatReadSheet_(f.session, { sheetName: 'Output', range: 'B2:A1' }),
    /^Error: range must end after it starts\.$/
  );
  assert.throws(
    () => f.api.dmvChatReadSheet_(f.session, { sheetName: 'Nope' }),
    /^Error: No tab named "Nope"\./
  );
  assert.equal(f.state.batches.length, 0, 'reading never writes');
});

test('baseline: run_report fetches without touching the sheet, and write_to_sheet sends one exact writer batch with a receipt', () => {
  const f = fixture();
  const ran = plain(
    f.api.dmvChatRunReport_(f.session, {
      connectionId: f.connection.id,
      reportType: 'daily',
      dateRange: { preset: 'last7' },
    })
  );
  assert.equal(f.state.batches.length, 0, 'run_report does not write');
  assert.equal(f.fetched, 1);
  assertIncludes(ran, {
    rowCount: 2,
    columns: [
      { key: 'date', label: 'Date', type: 'date' },
      { key: 'campaign', label: 'Campaign', type: 'text' },
      { key: 'spend', label: 'Spend', type: 'currency' },
      { key: 'clicks', label: 'Clicks', type: 'number' },
    ],
    rows: f.rows,
    metadata: { currency: 'EUR' },
  });
  const written = plain(
    f.api.dmvChatWriteSheet_(f.session, { resultId: ran.resultId, sheetName: 'Spend' })
  );
  const tab = f.tab('Spend');
  const id = tab.id;
  assert.deepEqual(written, {
    ok: true,
    range: 'Spend!A1:D3',
    url: url(id, 'A1'),
    rows: 2,
    columns: ['Date', 'Campaign', 'Spend', 'Clicks'],
  });
  const text = (value) => ({ userEnteredValue: { stringValue: value } });
  const number = (value) => ({ userEnteredValue: { numberValue: value } });
  const numberFormat = (column, format) => ({
    repeatCell: {
      range: grid(id, 1, 3, column, column + 1),
      cell: { userEnteredFormat: { numberFormat: format } },
      fields: 'userEnteredFormat.numberFormat',
    },
  });
  assert.deepEqual(f.lastBody(), {
    requests: [
      {
        addSheet: {
          properties: {
            sheetId: id,
            title: 'Spend',
            gridProperties: { rowCount: 1000, columnCount: 26 },
          },
        },
      },
      {
        updateCells: {
          range: grid(id, 0, 3, 0, 4),
          rows: [
            { values: [text('Date'), text('Campaign'), text('Spend'), text('Clicks')] },
            { values: [number(46235), text('Brand'), number(10.5), number(100)] },
            { values: [number(46236), text('Generic'), number(5), number(20)] },
          ],
          fields: 'userEnteredValue',
        },
      },
      {
        repeatCell: {
          range: grid(id, 0, 1, 0, 4),
          cell: {
            userEnteredFormat: {
              textFormat: { bold: true },
              backgroundColor: { red: 0.93, green: 0.95, blue: 1 },
            },
          },
          fields: 'userEnteredFormat.textFormat,userEnteredFormat.backgroundColor',
        },
      },
      {
        repeatCell: {
          range: grid(id, 1, 3, 0, 1),
          cell: {
            userEnteredFormat: {
              numberFormat: { type: 'DATE', pattern: 'yyyy-mm-dd' },
              horizontalAlignment: 'LEFT',
            },
          },
          fields: 'userEnteredFormat.numberFormat,userEnteredFormat.horizontalAlignment',
        },
      },
      numberFormat(1, { type: 'TEXT', pattern: '@' }),
      numberFormat(2, { type: 'NUMBER', pattern: '#,##0.00' }),
      numberFormat(3, { type: 'NUMBER', pattern: '#,##0' }),
    ],
  });
  assert.equal(f.state.batches.length, 1);
  // The writer reads only grid metadata before its single batch.
  assert.deepEqual(
    f.state.gets.map((get) => get.options),
    [{ fields: 'sheets(properties(sheetId,gridProperties(rowCount,columnCount)),merges)' }]
  );
  // The receipt: a private, digest-protected area under a key derived from the tab and cell.
  const matrix = [
    ['Date', 'Campaign', 'Spend', 'Clicks'],
    [46235, 'Brand', 10.5, 100],
    [46236, 'Generic', 5, 20],
  ];
  const key = chatReceipt('Spend!A1');
  assert.deepEqual(f.receiptKeys(), [key]);
  assert.deepEqual(JSON.parse(f.state.user.getProperty(key)), {
    sheetId: id,
    row: 1,
    column: 1,
    rows: 3,
    columns: 4,
    shape: sha256(
      JSON.stringify([
        matrix[0],
        [['date', 'yyyy-mm-dd'], ['text', null], ['currency', null], ['number', '#,##0']],
      ])
    ),
    digest: sha256(JSON.stringify(matrix)),
    writtenAt: f.api.Date.now(),
  });
  assert.deepEqual(f.areaValues(tab, { row: 1, column: 1, rows: 3, columns: 4 }), matrix);
  assert.equal(
    f.state.user.getProperty('dmv:v1:write-journal:' + BOOK),
    null,
    'the write journal is cleared'
  );
  const event = plain(f.session.events.at(-1));
  assert.deepEqual(event, {
    kind: 'write',
    links: [{ label: 'Spend', url: url(id, 'A1') }],
    text: 'Wrote 2 rows to Spend!A1:D3',
    ref: ran.resultId + ' at Spend!A1:D3',
    details: [
      { label: 'Source', value: 'Orchard Ads (Orchard main) · Daily campaigns' },
      { label: 'Range', value: 'Spend!A1:D3' },
      { label: 'Columns', value: 'Date, Campaign, Spend, Clicks' },
    ],
  });
  assert.ok(f.session.sheetNames.includes('Spend'));
  assert.equal(f.state.lockAcquires, f.state.lockReleases);
  assert.equal(f.state.scriptLockAcquires, f.state.scriptLockReleases);
});

test('baseline: write_to_sheet on an existing tab writes beside user cells, rewrites its own area and refuses occupied or owned cells', () => {
  const f = fixture();
  f.fill(f.sheet, [['Mine'], ['keep']]);
  const ran = plain(
    f.api.dmvChatRunReport_(f.session, { connectionId: f.connection.id, reportType: 'daily' })
  );
  const occupied =
    /^Error: The tab "Output" contains existing data where this output goes\. Choose an empty area or a new tab name\.$/;
  assert.throws(
    () => f.api.dmvChatWriteSheet_(f.session, { resultId: ran.resultId, sheetName: 'Output' }),
    occupied
  );
  assert.throws(
    () =>
      f.api.dmvChatWriteSheet_(f.session, {
        resultId: ran.resultId,
        sheetName: 'Output',
        startCell: 'A2',
      }),
    occupied
  );
  assert.equal(f.state.batches.length, 0);
  const written = plain(
    f.api.dmvChatWriteSheet_(f.session, {
      resultId: ran.resultId,
      sheetName: 'Output',
      startCell: 'c2',
    })
  );
  assertIncludes(written, { range: 'Output!C2:F4', url: url(f.sheet.id, 'C2'), rows: 2 });
  const requests = f.lastBody().requests;
  assert.equal(
    requests.filter((request) => request.addSheet).length,
    0,
    'an existing tab is reused'
  );
  assert.deepEqual(requests[0].updateCells.range, grid(f.sheet.id, 1, 4, 2, 6));
  assert.deepEqual(
    requests.map((request) => Object.keys(request)[0]),
    ['updateCells', 'repeatCell', 'repeatCell', 'repeatCell', 'repeatCell', 'repeatCell']
  );
  assert.equal(f.value(f.sheet, 1, 1), 'Mine');
  assert.equal(f.value(f.sheet, 2, 1), 'keep');
  assert.equal(f.value(f.sheet, 2, 3), 'Date');
  // Writing the same place again replaces the chat's own output under the same receipt.
  f.rows = [{ date: '2026-08-03', campaign: 'Only', spend: 1, clicks: 1 }];
  // A new turn, because a turn reuses its own complete result for the same query.
  const session = f.api.dmvChatSession_(f.book);
  const fresh = plain(
    f.api.dmvChatRunReport_(session, { connectionId: f.connection.id, reportType: 'daily' })
  );
  f.api.dmvChatWriteSheet_(session, {
    resultId: fresh.resultId,
    sheetName: 'Output',
    startCell: 'C2',
  });
  const shrink = f.lastBody().requests;
  assert.deepEqual(
    shrink.find((request) => request.updateCells && !request.updateCells.rows.length),
    {
      updateCells: { range: grid(f.sheet.id, 3, 4, 2, 6), rows: [], fields: 'userEnteredValue' },
    },
    'the owned trailing row is cleared in the same batch'
  );
  assert.equal(f.value(f.sheet, 3, 4), 'Only');
  assert.equal(f.value(f.sheet, 4, 3), '');
  assert.equal(f.receiptKeys().length, 1);
  // Another chat output may not overlap it.
  assert.throws(
    () =>
      f.api.dmvChatWriteSheet_(f.session, {
        resultId: ran.resultId,
        sheetName: 'Output',
        startCell: 'E3',
      }),
    /^Error: The output on tab "Output" overlaps another DataMoov report or dashboard\. Choose another tab name or starting cell\.$/
  );
  // Edited output is never overwritten.
  f.setCell(f.sheet, 3, 3, 'edited by hand');
  assert.throws(
    () =>
      f.api.dmvChatWriteSheet_(f.session, {
        resultId: ran.resultId,
        sheetName: 'Output',
        startCell: 'C2',
      }),
    /^Error: The previous report output was edited or moved\. Choose a new empty output area before refreshing\.$/
  );
  assert.equal(f.value(f.sheet, 3, 3), 'edited by hand');
  assert.throws(
    () => f.api.dmvChatWriteSheet_(f.session, { resultId: 'r00000000', sheetName: 'X' }),
    /^Error: Result r00000000 has expired\. Run the report again\.$/
  );
  assert.throws(
    () => f.api.dmvChatWriteSheet_(f.session, { resultId: 'bad', sheetName: 'X' }),
    /^Error: Unknown resultId\./
  );
});

test('baseline: chat keeps its twenty most recent output receipts per workbook', () => {
  const f = fixture();
  const ran = plain(
    f.api.dmvChatRunReport_(f.session, { connectionId: f.connection.id, reportType: 'daily' })
  );
  for (let i = 1; i <= 21; i++) {
    f.api.dmvChatWriteSheet_(f.session, { resultId: ran.resultId, sheetName: 'T' + i });
    f.advance(1);
  }
  const keys = f.receiptKeys();
  assert.equal(keys.length, 20);
  assert.ok(!keys.includes(chatReceipt('T1!A1')), 'the oldest receipt goes');
  assert.ok(keys.includes(chatReceipt('T21!A1')));
});

test('baseline: create_chart sends one exact addChart beside the table, below earlier charts', () => {
  const f = fixture();
  const ran = plain(
    f.api.dmvChatRunReport_(f.session, { connectionId: f.connection.id, reportType: 'daily' })
  );
  f.api.dmvChatWriteSheet_(f.session, { resultId: ran.resultId, sheetName: 'Spend' });
  const id = f.tab('Spend').id;
  const before = f.state.gets.length;
  const chart = plain(
    f.api.dmvChatCreateChart_(f.session, {
      resultId: ran.resultId,
      chartType: 'Column',
      xColumn: 'campaign',
      seriesColumns: ['spend', 'Clicks'],
    })
  );
  assert.deepEqual(chart, {
    ok: true,
    chartId: 1,
    url: url(id, 'F1'),
    sheetName: 'Spend',
    anchorCell: 'F1',
    title: 'Spend, Clicks by Campaign',
  });
  const source = (column) => ({
    sourceRange: {
      sources: [
        {
          sheetId: id,
          startRowIndex: 0,
          startColumnIndex: column,
          endColumnIndex: column + 1,
          endRowIndex: 3,
        },
      ],
    },
  });
  assert.deepEqual(f.lastBody(), {
    requests: [
      {
        addChart: {
          chart: {
            spec: {
              title: 'Spend, Clicks by Campaign',
              basicChart: {
                chartType: 'COLUMN',
                legendPosition: 'BOTTOM_LEGEND',
                headerCount: 1,
                axis: [
                  { position: 'BOTTOM_AXIS', title: 'Campaign' },
                  { position: 'LEFT_AXIS', title: '' },
                ],
                domains: [{ domain: source(1) }],
                series: [
                  { series: source(2), targetAxis: 'LEFT_AXIS' },
                  { series: source(3), targetAxis: 'LEFT_AXIS' },
                ],
              },
            },
            position: {
              overlayPosition: {
                anchorCell: { sheetId: id, rowIndex: 0, columnIndex: 5 },
                widthPixels: 600,
                heightPixels: 360,
              },
            },
          },
        },
      },
    ],
  });
  assert.deepEqual(
    f.state.gets.slice(before).map((get) => get.options),
    [{ fields: 'sheets(properties.sheetId,charts(chartId,position))' }]
  );
  assert.deepEqual(plain(f.session.events.at(-1)), {
    kind: 'chart',
    links: [{ label: 'Spend', url: url(id, 'F1') }],
    text: 'Added a column chart "Spend, Clicks by Campaign" on Spend',
    details: [
      { label: 'X axis', value: 'Campaign' },
      { label: 'Series', value: 'Spend, Clicks' },
      { label: 'Anchor', value: 'F1' },
    ],
  });
  // The next chart without an anchor goes below the first one.
  assert.equal(
    plain(
      f.api.dmvChatCreateChart_(f.session, {
        resultId: ran.resultId,
        chartType: 'line',
        xColumn: 'Date',
        seriesColumns: ['Spend'],
      })
    ).anchorCell,
    'F20'
  );
  assert.equal(f.state.charts.length, 2);
});

test('baseline: create_chart over a sheet range draws bars sideways, pies without headers and future rows open-ended', () => {
  const f = fixture();
  f.fill(
    f.sheet,
    [
      ['Campaign', 'Spend', 'Clicks'],
      ['Brand', 10, 1],
      ['Generic', 5, 2],
    ],
    2,
    2
  );
  const before = f.state.gets.length;
  const bar = plain(
    f.api.dmvChatCreateChart_(f.session, {
      sheetName: 'Output',
      range: 'b2:d4',
      chartType: 'bar',
      xColumn: 'Campaign',
      seriesColumns: ['Spend'],
      title: 'Spend',
      includeFutureRows: true,
      anchorCell: 'H2',
    })
  );
  assertIncludes(bar, {
    ok: true,
    anchorCell: 'H2',
    title: 'Spend',
    sheetName: 'Output',
    url: url(f.sheet.id, 'H2'),
  });
  assert.equal(f.state.gets.length, before, 'an explicit anchor reads no chart positions');
  const open = (column) => ({
    sourceRange: {
      sources: [
        {
          sheetId: f.sheet.id,
          startRowIndex: 1,
          startColumnIndex: column,
          endColumnIndex: column + 1,
        },
      ],
    },
  });
  assert.deepEqual(f.lastBody().requests[0].addChart.chart, {
    spec: {
      title: 'Spend',
      basicChart: {
        chartType: 'BAR',
        legendPosition: 'BOTTOM_LEGEND',
        headerCount: 1,
        axis: [
          { position: 'LEFT_AXIS', title: 'Campaign' },
          { position: 'BOTTOM_AXIS', title: 'Spend' },
        ],
        domains: [{ domain: open(1) }],
        series: [{ series: open(2), targetAxis: 'BOTTOM_AXIS' }],
      },
    },
    position: {
      overlayPosition: {
        anchorCell: { sheetId: f.sheet.id, rowIndex: 1, columnIndex: 7 },
        widthPixels: 600,
        heightPixels: 360,
      },
    },
  });
  f.api.dmvChatCreateChart_(f.session, {
    sheetName: 'Output',
    range: 'B2:D4',
    chartType: 'pie',
    xColumn: 'Campaign',
    seriesColumns: ['Clicks'],
    anchorCell: 'H30',
  });
  const closed = (column) => ({
    sourceRange: {
      sources: [
        {
          sheetId: f.sheet.id,
          startRowIndex: 2,
          startColumnIndex: column,
          endColumnIndex: column + 1,
          endRowIndex: 4,
        },
      ],
    },
  });
  assert.deepEqual(f.lastBody().requests[0].addChart.chart.spec, {
    title: 'Clicks by Campaign',
    pieChart: { legendPosition: 'RIGHT_LEGEND', domain: closed(1), series: closed(3) },
  });
  for (const [input, message] of [
    [
      { chartType: 'radar' },
      /^Error: chartType must be one of: line, column, bar, area, scatter, pie$/,
    ],
    [{ seriesColumns: [] }, /^Error: Pass between 1 and 10 seriesColumns\.$/],
    [{ seriesColumns: Array(11).fill('Spend') }, /^Error: Pass between 1 and 10 seriesColumns\.$/],
    [{ seriesColumns: ['Campaign'] }, /^Error: A series column cannot be the xColumn\.$/],
    [
      { seriesColumns: ['Missing'] },
      /^Error: Unknown series column "Missing"\. Result columns are: Campaign, Spend, Clicks$/,
    ],
    [
      { chartType: 'pie', seriesColumns: ['Spend', 'Clicks'] },
      /^Error: A pie chart takes exactly one series column\.$/,
    ],
    [{ range: 'B2:D2' }, /^Error: range must cover a header row and at least one data row\.$/],
    [
      { range: 'B2' },
      /^Error: Pass the resultId of a table written by write_to_sheet, or sheetName plus range/,
    ],
    [{ includeFutureRows: 'yes' }, /^Error: includeFutureRows must be true or false\.$/],
    [
      { resultId: 'r12345678' },
      /^Error: resultId r12345678 is not a table written by write_to_sheet in this chat\. Call write_to_sheet first, or pass sheetName plus range\.$/,
    ],
  ])
    assert.throws(
      () =>
        f.api.dmvChatCreateChart_(f.session, {
          sheetName: 'Output',
          range: 'B2:D4',
          chartType: 'line',
          xColumn: 'Campaign',
          seriesColumns: ['Spend'],
          anchorCell: 'H50',
          ...input,
        }),
      message,
      JSON.stringify(input)
    );
  assert.equal(f.state.batches.length, 2);
});

test('baseline: a saved report refresh over a tab chat edited keeps the chat edits and a stable ownership digest', () => {
  const f = fixture();
  const report = f.api.dmvSaveReport({
    connectionId: f.connection.id,
    name: 'Daily',
    reportType: 'daily',
    fields: ['date', 'campaign', 'spend', 'clicks'],
    config: {},
    maxRows: 100,
    dateRange: { preset: 'lastMonth' },
    target: { sheetName: 'Output', startCell: 'A1' },
    schedule: 'manual',
  });
  f.api.dmvRunReport(report.id);
  const first = f.readOutput(report.id);
  const matrix = [
    ['Date', 'Campaign', 'Spend', 'Clicks'],
    [46235, 'Brand', 10.5, 100],
    [46236, 'Generic', 5, 20],
  ];
  assertIncludes(first, {
    sheetId: f.sheet.id,
    row: 1,
    column: 1,
    rows: 3,
    columns: 4,
    digest: sha256(JSON.stringify(matrix)),
  });
  assert.deepEqual(f.areaValues(f.sheet, first), matrix);
  // Chat edits beside the report: values, formulas, formatting, a sort and a filter of its own range, and freeze panes.
  f.edit('set_values', { values: [['Notes'], ['b'], ['a']] }, f.inspect('F1:F3'));
  f.edit('set_formulas', { formulas: [['=SUM(C2:C3)']] }, f.inspect('F4'));
  f.edit('format', { format: { bold: true, backgroundColor: '#FFFF00' } }, f.inspect('F1:G3'));
  f.edit('sort', { sortBy: [{ column: 1, ascending: true }], headerRows: 1 }, f.inspect('F1:F3'));
  f.edit('filter', { filter: { column: 1, condition: 'NOT_BLANK' } }, f.inspect('F1:F3'));
  f.edit('freeze', { frozenRows: 1 }, f.inspect('F1'));
  const created = plain(
    f.api.dmvChatEditSheet_(f.session, { action: 'create_sheet', newName: 'Scratch' })
  );
  assert.equal(created.ok, true);
  const before = f.state.batches.length;
  const rerun = f.api.dmvRunReport(report.id);
  assert.equal(rerun.ok, true);
  assert.equal(f.state.batches.length, before + 1);
  const second = f.readOutput(report.id);
  assert.equal(second.digest, first.digest, 'the same data keeps the same digest');
  assert.deepEqual(f.areaValues(f.sheet, second), matrix);
  assert.deepEqual(
    [1, 2, 3, 4].map((row) => f.value(f.sheet, row, 6)),
    ['Notes', 'a', 'b', '=SUM(C2:C3)']
  );
  assert.equal(f.formula(f.sheet, 4, 6), '=SUM(C2:C3)');
  assert.equal(f.format(f.sheet, 1, 6).textFormat.bold, true);
  assert.equal(f.sheet.frozenRows, 1);
  // Changed data changes the digest, which always matches the written values.
  f.rows = [{ date: '2026-08-05', campaign: 'New', spend: 2, clicks: 3 }];
  f.api.dmvRunReport(report.id);
  const third = f.readOutput(report.id);
  assert.notEqual(third.digest, first.digest);
  assert.equal(third.digest, sha256(JSON.stringify(f.areaValues(f.sheet, third))));
  assert.equal(f.value(f.sheet, 1, 6), 'Notes');
});

test('baseline: a dashboard refresh over tabs chat edited keeps the chat edits, the page and chart receipt digests match their tabs and the data tab is rewritten', () => {
  const f = fixture();
  const saved = plain(f.api.dmvSaveDashboard(dashboardInput(f)));
  f.api.dmvRunDashboard(saved.id);
  const suffixes = ['-d-main', '-charts', '-report'];
  const tabs = { '-d-main': 'Main data', '-charts': 'Dash (chart data)', '-report': 'Dash' };
  const receipts = () =>
    Object.fromEntries(suffixes.map((suffix) => [suffix, f.readOutput(saved.id + suffix)]));
  // The formulas the page and the chart data show, as their receipts keep them.
  const formulas = {
    '-charts': { B3: '=SUMIFS(#,#,"=Brand")', B4: '=SUMIFS(#,#,"=Generic")' },
    '-report': { B8: '=SUM(#)' },
  };
  const first = receipts();
  for (const suffix of suffixes) {
    const tab = f.tab(tabs[suffix]);
    assertIncludes(first[suffix], { sheetId: tab.id, row: 1, column: 1 }, suffix);
    // A data tab is rewritten without being read back: its receipt keeps no digest.
    if (suffix === '-d-main') assert.equal(first[suffix].rewrite, true, suffix);
    else
      assert.equal(
        first[suffix].digest,
        sha256(JSON.stringify(f.areaValues(tab, first[suffix], formulas[suffix]))),
        suffix
      );
  }
  // Chat writes beside the data table and on a tab of the user's own, formats them and freezes a row.
  const data = f.tab('Main data');
  const right = 'F1:G2';
  f.edit(
    'set_values',
    {
      values: [
        ['Target', 12],
        ['Notes', 'ok'],
      ],
    },
    f.inspect(right, 'Main data')
  );
  f.edit('format', { format: { numberFormat: 'currency' } }, f.inspect('G1', 'Main data'));
  f.edit('set_values', { values: [['mine']] }, f.inspect('A1'));
  assert.deepEqual(
    plain(f.api.dmvChatReadSheet_(f.session, { sheetName: 'Main data', range: 'F1:G2' })).rows,
    [{ target: 'Notes', 12: 'ok' }]
  );
  const before = f.state.batches.length;
  const refreshed = plain(f.api.dmvRunDashboard(saved.id));
  assert.equal(refreshed.ok, true);
  assert.equal(f.state.batches.length, before + 1, 'one atomic batch');
  const second = receipts();
  for (const suffix of suffixes) {
    assert.equal(
      second[suffix].digest,
      first[suffix].digest,
      suffix + ' keeps its digest for the same data at the same time'
    );
    if (suffix === '-d-main') assert.equal(second[suffix].rewrite, true, suffix);
    else
      assert.equal(
        second[suffix].digest,
        sha256(
          JSON.stringify(f.areaValues(f.tab(tabs[suffix]), second[suffix], formulas[suffix]))
        ),
        suffix
      );
  }
  assert.deepEqual(
    [f.value(data, 1, 6), f.value(data, 1, 7), f.value(data, 2, 6), f.value(data, 2, 7)],
    ['Target', 12, 'Notes', 'ok']
  );
  assert.deepEqual(f.format(data, 1, 7).numberFormat, { type: 'NUMBER', pattern: '#,##0.00' });
  assert.equal(f.value(f.sheet, 1, 1), 'mine');
  // write_to_sheet may not land on the dashboard's owned output.
  const ran = plain(
    f.api.dmvChatRunReport_(f.session, { connectionId: f.connection.id, reportType: 'daily' })
  );
  assert.throws(
    () =>
      f.api.dmvChatWriteSheet_(f.session, {
        resultId: ran.resultId,
        sheetName: 'Main data',
        startCell: 'A1',
      }),
    /^Error: The output on tab "Main data" overlaps another DataMoov report or dashboard\. Choose another tab name or starting cell\.$/
  );
  assert.equal(f.state.batches.length, before + 1);
});

test('baseline: owned report or dashboard output edited through chat is never silently overwritten by the next refresh', () => {
  // Today edit_sheet may change owned cells and the next refresh then stops; the analyst tools
  // refuse such an edit up front. Either way the user's edit survives and nothing is overwritten.
  const f = fixture();
  const saved = plain(f.api.dmvSaveDashboard(dashboardInput(f)));
  f.api.dmvRunDashboard(saved.id);
  const data = f.tab('Main data');
  const owned = f.readOutput(saved.id + '-d-main');
  const cell = `B${owned.row + owned.rows - 1}`;
  const inspected = f.inspect(cell, 'Main data');
  const count = f.state.batches.length;
  let edited = true;
  try {
    f.edit('set_values', { values: [['hand edit']] }, inspected);
  } catch (error) {
    edited = false;
    assert.equal(f.state.batches.length, count, 'a refused edit writes nothing');
  }
  if (edited) {
    assert.throws(() => f.api.dmvRunDashboard(saved.id), /edited or moved/);
    assert.equal(f.value(data, owned.row + owned.rows - 1, 2), 'hand edit');
    assert.deepEqual(f.readOutput(saved.id + '-d-main'), owned);
  } else assert.equal(f.api.dmvRunDashboard(saved.id).ok, true);
  assert.equal(f.state.batches.length, count + 1, 'exactly one batch: the edit or the refresh');

  const g = fixture();
  const report = g.api.dmvSaveReport({
    connectionId: g.connection.id,
    name: 'Daily',
    reportType: 'daily',
    fields: ['date', 'campaign', 'spend', 'clicks'],
    config: {},
    maxRows: 100,
    dateRange: { preset: 'lastMonth' },
    target: { sheetName: 'Output', startCell: 'A1' },
    schedule: 'manual',
  });
  g.api.dmvRunReport(report.id);
  const footprint = g.readOutput(report.id);
  edited = true;
  try {
    g.edit('set_values', { values: [['hand edit']] }, g.inspect('B2'));
  } catch (error) {
    edited = false;
  }
  if (edited) {
    assert.throws(() => g.api.dmvRunReport(report.id), /edited or moved/);
    assert.equal(g.value(g.sheet, 2, 2), 'hand edit');
    assert.deepEqual(g.readOutput(report.id), footprint);
  } else assert.equal(g.api.dmvRunReport(report.id).ok, true);
});

test('baseline: the sheet tools run through the chat tool runner with JSON results, error events and existing schemas', () => {
  const f = fixture();
  const tools = f.api.dmvChatTools_(f.session);
  const names = tools.map((tool) => tool.name);
  for (const name of [
    'write_to_sheet',
    'read_sheet',
    'create_chart',
    'list_sheets',
    'inspect_sheet',
    'edit_sheet',
    'create_pivot',
    'run_report',
  ])
    assert.ok(names.includes(name), name);
  const schema = (name) => plain(tools.find((tool) => tool.name === name).input_schema);
  // Field names, types and required lists the model already uses stay; new ones may be added.
  const edit = schema('edit_sheet');
  assert.deepEqual(edit.required, ['action']);
  for (const action of [
    'set_values',
    'set_formulas',
    'format',
    'sort',
    'filter',
    'freeze',
    'create_sheet',
    'rename_sheet',
  ])
    assert.ok(edit.properties.action.enum.includes(action), action);
  for (const [key, type] of Object.entries({
    sheetName: 'string',
    range: 'string',
    action: 'string',
    editToken: 'string',
    newName: 'string',
    values: 'array',
    formulas: 'array',
    format: 'object',
    sortBy: 'array',
    headerRows: 'integer',
    filter: 'object',
    frozenRows: 'integer',
    frozenColumns: 'integer',
  }))
    assert.equal(edit.properties[key].type, type, key);
  assert.ok(!edit.properties.requests, 'no raw request passthrough');
  for (const key of [
    'numberFormat',
    'bold',
    'textColor',
    'backgroundColor',
    'horizontalAlignment',
    'wrap',
  ])
    assert.ok(edit.properties.format.properties[key], key);
  for (const value of ['number', 'currency', 'percent', 'date', 'text'])
    assert.ok(edit.properties.format.properties.numberFormat.enum.includes(value));
  for (const value of ['TEXT_CONTAINS', 'TEXT_EQ', 'NUMBER_GREATER', 'NUMBER_LESS', 'NOT_BLANK'])
    assert.ok(edit.properties.filter.properties.condition.enum.includes(value));
  assert.deepEqual(edit.properties.sortBy.items.required, ['column', 'ascending']);
  assert.deepEqual(schema('inspect_sheet').required, ['sheetName', 'range']);
  assert.equal(schema('list_sheets').type, 'object');
  assert.deepEqual(schema('read_sheet').required, ['sheetName']);
  assert.ok(schema('read_sheet').properties.range);
  assert.deepEqual(schema('write_to_sheet').required, ['resultId', 'sheetName']);
  for (const key of ['resultId', 'sheetName', 'startCell'])
    assert.equal(schema('write_to_sheet').properties[key].type, 'string', key);
  const chart = schema('create_chart');
  assert.deepEqual(chart.required, ['chartType', 'xColumn', 'seriesColumns']);
  for (const type of ['line', 'column', 'bar', 'area', 'scatter', 'pie'])
    assert.ok(chart.properties.chartType.enum.includes(type));
  for (const key of ['resultId', 'sheetName', 'range', 'includeFutureRows', 'title', 'anchorCell'])
    assert.ok(chart.properties[key], key);
  assertIncludes(plain(f.api.DMV_CHAT_PROGRESS_LABELS), {
    write_to_sheet: 'Writing to Sheets',
    read_sheet: 'Reading sheet data',
    list_sheets: 'Checking spreadsheet tabs',
    inspect_sheet: 'Inspecting selected cells',
    edit_sheet: 'Updating the spreadsheet',
    create_chart: 'Creating a chart',
  });
  // A list, inspect and edit round through the runner as the model would call them.
  const listed = f.api.dmvChatRunTool_(f.session, tools, {
    name: 'list_sheets',
    id: 'l1',
    input: {},
  });
  assert.equal(listed.isError, false);
  assert.equal(JSON.parse(listed.content).sheets[0].sheetName, 'Output');
  const inspected = f.api.dmvChatRunTool_(f.session, tools, {
    name: 'inspect_sheet',
    id: 'i1',
    input: { sheetName: 'Output', range: 'A1' },
  });
  const token = JSON.parse(inspected.content).editToken;
  const failed = f.api.dmvChatRunTool_(f.session, tools, {
    name: 'edit_sheet',
    id: 'e1',
    input: {
      action: 'set_values',
      sheetName: 'Output',
      range: 'A1',
      editToken: token,
      values: [[1, 2]],
    },
  });
  assert.equal(failed.isError, true);
  assert.deepEqual(JSON.parse(failed.content), {
    error: 'The cell matrix must match the inspected range exactly: A1 is 1 rows × 1 columns.',
    next: 'Nothing changed, and the editToken still holds for Output!A1: correct the call and repeat it with that token.',
  });
  assert.deepEqual(plain(f.session.events.at(-1)), {
    kind: 'error',
    tool: 'edit_sheet',
    text: 'edit_sheet: The cell matrix must match the inspected range exactly: A1 is 1 rows × 1 columns.',
  });
  const done = f.api.dmvChatRunTool_(f.session, tools, {
    name: 'edit_sheet',
    id: 'e2',
    input: {
      action: 'set_values',
      sheetName: 'Output',
      range: 'A1',
      editToken: token,
      values: [[5]],
    },
  });
  assert.equal(done.isError, false);
  assertIncludes(JSON.parse(done.content), {
    ok: true,
    action: 'set_values',
    sheetName: 'Output',
    range: 'A1',
  });
  assert.equal(f.session.events.find((event) => event.kind === 'error').recovered, true);
  assert.deepEqual(plain(f.session.events.map((event) => event.kind)), [
    'summary',
    'summary',
    'error',
    'write',
  ]);
  assert.equal(f.value(f.sheet, 1, 1), 5);
});
