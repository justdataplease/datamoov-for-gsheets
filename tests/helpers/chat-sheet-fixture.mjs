import assert from 'node:assert/strict';
import { createDatamoovSandbox, plain } from './datamoov-sandbox.mjs';

// Shared scaffolding for the chat sheet tool tests: a sandbox that answers spreadsheets.get like
// the Sheets API (gridData), a chat session on its first tab, the offline "Orchard Ads" source
// whose saved reports write protected output, and short calls for inspect, edit and undo.

// The columns of the Orchard report; tests that do not need clicks use the first three.
export const ORCHARD_COLUMNS = [
  { key: 'date', label: 'Date', type: 'date', role: 'dimension', default: true },
  { key: 'campaign', label: 'Campaign', type: 'text', role: 'dimension', default: true },
  { key: 'spend', label: 'Spend', type: 'currency', role: 'metric', default: true },
  { key: 'clicks', label: 'Clicks', type: 'number', role: 'metric', default: true },
];

// options.orchard registers the source and a connection before the session starts:
//   { columns, rows (f.rows, read on every fetch), label, metadata, token }
// options.tabTitles and options.sortRange add stand-ins the shared sandbox leaves to each test.
// options.setup(f) prepares tabs before the session starts, since a session keeps the tab names.
export function chatSheetFixture(options = {}) {
  const f = createDatamoovSandbox({ gridData: true });
  f.sheet = f.book.sheets[0];
  if (options.setup) options.setup(f);
  if (options.tabTitles) renameTabsOnTitleUpdate(f);
  if (options.sortRange) sortRanges(f);
  if (options.orchard) connectOrchard(f, options.orchard);
  f.session = f.api.dmvChatSession_(f.book);
  // A later chat request: a new session that starts with the user's answer.
  f.answer = (text, token) => {
    const session = f.api.dmvChatSession_(f.book);
    f.api.dmvChatConfirmBegin_(session, text, token);
    return session;
  };
  f.inspect = (range = 'A1:B2', sheetName = f.sheet.name, session = f.session) =>
    plain(f.api.dmvChatInspectSheet_(session, { sheetName, range }));
  // A range action on an inspection (made here unless given), or a tab action.
  f.edit = (action, extra, inspected = f.inspect(), session = f.session) =>
    plain(
      f.api.dmvChatEditSheet_(session, {
        action,
        sheetName: inspected.sheetName,
        range: inspected.range,
        editToken: inspected.editToken,
        ...extra,
      })
    );
  f.tabAction = (action, extra, session = f.session) =>
    plain(f.api.dmvChatEditSheet_(session, { action, ...extra }));
  // Asks, then the user's yes in the next request lets the same call act once.
  f.confirm = (call) => {
    const before = f.state.batches.length;
    const asked = call(f.session, {});
    assert.equal(asked.needsConfirmation, true, JSON.stringify(asked));
    assert.equal(f.state.batches.length, before, 'nothing changed before the yes');
    const yes = f.answer('Yes');
    const done = call(yes, { confirmToken: asked.confirmToken });
    return { asked, done, session: yes };
  };
  f.undo = (input = { action: 'undo' }, session = f.session) =>
    plain(f.api.dmvChatUndoSheetEdit_(session, input));
  f.requests = () => f.state.batches.at(-1).body.requests;
  // A change the user makes by hand, straight through the Sheets API.
  f.byHand = (...requests) =>
    f.api.Sheets.Spreadsheets.batchUpdate({ requests }, f.session.spreadsheetId);
  f.column = (sheet, column, values, top = 1) =>
    values.forEach((value, index) => f.setCell(sheet, top + index, column, value));
  // Everything undo restores, for a block of cells: value, formula, format and other cell fields.
  f.cellState = (sheet, top, left, rows, columns) =>
    Array.from({ length: rows }, (_, r) =>
      Array.from({ length: columns }, (_, c) => ({
        // The sandbox does not evaluate formulas, so a formula cell is compared by its formula.
        value: f.formula(sheet, top + r, left + c) ? null : f.value(sheet, top + r, left + c),
        formula: f.formula(sheet, top + r, left + c),
        format: f.format(sheet, top + r, left + c),
        meta: f.meta(sheet, top + r, left + c),
      }))
    );
  // Saves and runs an Orchard report, so its output is protected.
  f.saveReport = ({
    name = 'Daily',
    fields = ['date', 'campaign', 'spend', 'clicks'],
    sheetName = 'Output',
    startCell = 'A1',
  } = {}) => {
    const report = f.api.dmvSaveReport({
      connectionId: f.connection.id,
      name,
      reportType: 'daily',
      fields,
      config: {},
      maxRows: 100,
      dateRange: { preset: 'lastMonth' },
      target: { sheetName, startCell },
      schedule: 'manual',
    });
    return { report, run: f.api.dmvRunReport(report.id) };
  };
  return f;
}

// The JSON Schema subset all three adapters accept (tests/gemini-schema.test.mjs has the same
// rule): one type per value or an anyOf of typed alternatives, no oneOf, allOf, not, $ref or
// const, string enums, and required names that exist.
export function assertPortable(schema, path) {
  assert.equal(typeof schema, 'object', path);
  for (const key of ['oneOf', 'allOf', 'not', '$ref', 'const'])
    assert.equal(Object.hasOwn(schema, key), false, path + ' uses ' + key);
  if (schema.anyOf) {
    assert.equal(Object.hasOwn(schema, 'type'), false, path + ' has a type beside anyOf');
    schema.anyOf.forEach((branch, index) => assertPortable(branch, path + '.anyOf[' + index + ']'));
    return;
  }
  assert.ok(
    ['object', 'array', 'string', 'number', 'integer', 'boolean'].includes(schema.type),
    path + ' has one known type'
  );
  if (schema.enum) {
    assert.ok(schema.enum.length > 0, path + ' enum is empty');
    for (const value of schema.enum) assert.equal(typeof value, 'string', path + ' enum ' + value);
    assert.equal(new Set(schema.enum).size, schema.enum.length, path + ' repeats an enum value');
  }
  if (schema.type === 'array') assert.ok(schema.items, path + ' is an array without items');
  for (const [name, value] of Object.entries(schema.properties || {}))
    assertPortable(value, path + '.' + name);
  if (schema.items) assertPortable(schema.items, path + '[]');
  for (const name of schema.required || [])
    assert.ok(Object.hasOwn(schema.properties || {}, name), path + ' requires an unknown ' + name);
}

function connectOrchard(
  f,
  { columns = ORCHARD_COLUMNS, rows = [], label = 'Daily campaigns', metadata = {}, token }
) {
  f.rows = rows;
  f.api.dmvRegisterConnector_({
    id: 'orchard',
    label: 'Orchard Ads',
    description: 'Arbitrary test source',
    category: 'Test',
    allowedHosts: ['orchard.example'],
    authFields: [{ key: 'token', label: 'Token', type: 'password', required: true }],
    reports: [
      {
        id: 'daily',
        label,
        fields: columns,
        dateRange: true,
        configFields: [],
        fetch: () => ({ columns, rows: f.rows, metadata: { complete: true, ...metadata } }),
      },
    ],
  });
  f.connection = f.api.dmvSaveConnection({
    connectorId: 'orchard',
    label: 'Orchard main',
    credentials: { token },
  });
}

// The shared sandbox keeps a tab's title on updateSheetProperties; here a title update renames
// the tab, as undoing delete_sheet needs when it renames the hidden copy back.
function renameTabsOnTitleUpdate(f) {
  const sheets = f.api.Sheets.Spreadsheets,
    batch = sheets.batchUpdate;
  sheets.batchUpdate = (body, id) => {
    const result = batch(body, id);
    for (const request of plain(body.requests)) {
      const update = request.updateSheetProperties;
      if (!update || !String(update.fields).split(',').includes('title')) continue;
      f.state.books.get(id).sheets.find((s) => s.id === update.properties.sheetId).name =
        update.properties.title;
    }
    return result;
  };
}

// A batch of one sortRange moves whole cells within its range, as Sheets does.
function sortRanges(f) {
  const sheets = f.api.Sheets.Spreadsheets,
    batch = sheets.batchUpdate;
  sheets.batchUpdate = (body, id) => {
    const requests = plain(body.requests);
    const sort = requests.length === 1 && requests[0].sortRange;
    if (!sort) return batch(body, id);
    f.state.batches.push({ body: requests, spreadsheetId: id });
    const grid = sort.range;
    const sheet = f.state.books.get(id).sheets.find((s) => s.id === grid.sheetId);
    const rows = [];
    for (let r = grid.startRowIndex; r < grid.endRowIndex; r++)
      rows.push(
        Array.from({ length: grid.endColumnIndex - grid.startColumnIndex }, (_, c) => {
          const key = `${r + 1}:${c + grid.startColumnIndex + 1}`;
          return { cell: sheet.cells.get(key), format: sheet.formats.get(key) };
        })
      );
    rows.sort((a, b) => {
      for (const spec of sort.sortSpecs) {
        const column = spec.dimensionIndex - grid.startColumnIndex;
        const av = a[column].cell?.value,
          bv = b[column].cell?.value;
        if (av !== bv) return (av < bv ? -1 : 1) * (spec.sortOrder === 'ASCENDING' ? 1 : -1);
      }
      return 0;
    });
    rows.forEach((row, r) =>
      row.forEach((entry, c) => {
        const key = `${r + grid.startRowIndex + 1}:${c + grid.startColumnIndex + 1}`;
        if (entry.cell) sheet.cells.set(key, entry.cell);
        else sheet.cells.delete(key);
        if (entry.format) sheet.formats.set(key, entry.format);
        else sheet.formats.delete(key);
      })
    );
    return { spreadsheetId: id, replies: [{}] };
  };
}
