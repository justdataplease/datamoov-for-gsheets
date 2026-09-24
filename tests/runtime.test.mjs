import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatamoovSandbox, plain } from './helpers/datamoov-sandbox.mjs';

function fixture() {
  const sandbox = createDatamoovSandbox();
  let output = {
    columns: [{ key: 'count', label: 'Count', type: 'number', default: true },
      { key: 'enabled', label: 'Enabled', type: 'text', default: true },
      { key: 'label', label: 'Label', type: 'text', default: true }],
    rows: [{ count: 0, enabled: false, label: '=SUM(1,2)' }], metadata: { complete: true },
  };
  const fetched = [];
  sandbox.api.dmvRegisterConnector_({
    id: 'orchard', label: 'Orchard', description: 'An arbitrary test connector', category: 'Test',
    allowedHosts: ['orchard.example'],
    authFields: [{ key: 'account', label: 'Account', type: 'text', required: true },
      { key: 'token', label: 'Token', type: 'password', required: true },
      { key: 'privateJson', label: 'Private JSON', type: 'textarea', secret: true }],
    reports: [{ id: 'harvest', label: 'Harvest', fields: output.columns,
      dateRange: true, configFields: [{ key: 'region', label: 'Region', type: 'text', required: true }],
      fetch(ctx) { fetched.push(ctx); if (output instanceof Error) throw output; return output; },
      discoverFields() { return output.columns; },
    }],
  });
  const connection = sandbox.api.dmvSaveConnection({ connectorId: 'orchard', label: 'Example account',
    credentials: { account: 'orchard-one', token: 'fake-private-token', privateJson: '{"private":"hidden"}' } });
  const input = {
    connectionId: connection.id, name: 'Harvest report', reportType: 'harvest',
    fields: ['count', 'enabled', 'label'], config: { region: 'north' }, maxRows: 100,
    dateRange: { preset: 'custom', startDate: '2026-09-01', endDate: '2026-09-02' },
    target: { sheetName: 'Output', startCell: 'A1' }, schedule: 'manual',
  };
  return { ...sandbox, connection, input, fetched, setOutput: (next) => { output = next; },
    save: (overrides = {}) => sandbox.api.dmvSaveReport({ ...input, ...overrides }) };
}

test('generic connector flows through saved connection, report, execution and typed atomic output', () => {
  const f = fixture(), report = f.save();
  const result = f.api.dmvRunReport(report.id);
  assert.equal(result.ok, true);
  assert.equal(result.rowCount, 1);
  assert.equal(f.fetched.length, 1);
  assert.equal(f.fetched[0].credentials.token, 'fake-private-token');
  assert.equal(f.fetched[0].config.region, 'north');
  assert.equal(f.fetched[0].startDate, '2026-09-01');
  assert.equal(f.fetched[0].endDate, '2026-09-02');
  assert.equal(f.value(f.book.sheets[0], 2, 1), 0);
  assert.equal(f.value(f.book.sheets[0], 2, 2), false);
  assert.equal(f.value(f.book.sheets[0], 2, 3), '=SUM(1,2)');
  assert.equal(f.formula(f.book.sheets[0], 2, 3), '');
  assert.equal(f.state.legacyWrites.length, 0, 'write through the atomic typed Sheets API');
  assert.equal(f.state.batches.length, 1);
  assert.equal(f.readReport(report.id).status, 'success');
  assert.deepEqual([...new Set(f.state.opened)], ['spreadsheet-one']);
  assert.equal(f.state.lockAcquires, f.state.lockReleases);
});

test('bootstrap and saved connection summaries never reveal credential secrets', () => {
  const f = fixture();
  f.save();
  const visible = JSON.stringify(f.api.dmvBootstrap());
  assert.ok(visible.includes('orchard-one'));
  assert.ok(!visible.includes('fake-private-token'));
  assert.ok(!visible.includes('{\\"private\\":\\"hidden\\"}'));
  assert.ok(!JSON.stringify(f.connection).includes('fake-private-token'));
  assert.deepEqual(plain(f.connection.configuredFields), ['account', 'token', 'privateJson']);
  assert.equal(f.state.script.data.size, 0);
  assert.equal(f.state.document.data.size, 0);
});

test('editing a connection retains blank saved secrets and replaces explicitly supplied credentials', () => {
  const f = fixture();
  f.api.dmvSaveConnection({ id: f.connection.id, connectorId: 'orchard', label: 'Renamed', credentials: { account: 'second', token: '' } });
  let stored = JSON.parse(f.state.user.getProperty(`dmv:v1:connection:${f.connection.id}`));
  assert.equal(stored.credentials.token, 'fake-private-token');
  assert.equal(stored.credentials.privateJson, '{"private":"hidden"}');
  assert.equal(stored.credentials.account, 'second');
  f.api.dmvSaveConnection({ id: f.connection.id, connectorId: 'orchard', label: 'Renamed', credentials: { account: 'second', token: 'new-token' } });
  stored = JSON.parse(f.state.user.getProperty(`dmv:v1:connection:${f.connection.id}`));
  assert.equal(stored.credentials.token, 'new-token');
});

test('validation rejects invalid config, duplicate fields, dates and limits before provider execution', () => {
  const f = fixture();
  for (const overrides of [
    { config: {} }, { fields: ['count', 'count'] }, { maxRows: 0 }, { maxRows: 30001 },
    { target: { sheetName: 'Bad/name', startCell: 'A1' } },
    { dateRange: { preset: 'custom', startDate: '2026-02-30', endDate: '2026-03-01' } },
    { dateRange: { preset: 'custom', startDate: '2026-09-03', endDate: '2026-09-01' } },
    { schedule: 'every-second' },
  ]) assert.throws(() => f.save(overrides));
  assert.equal(f.fetched.length, 0);
  assert.equal(f.state.batches.length, 0);
  assert.equal(f.api.dmvBootstrap().reports.length, 0);
});

test('relative report dates are resolved again for each scheduled execution', () => {
  const f = fixture(), report = f.save({ dateRange: { preset: 'last7' }, schedule: 'daily' });
  f.api.dmvRunReport(report.id);
  assert.equal(f.fetched[0].startDate, '2026-09-11');
  assert.equal(f.fetched[0].endDate, '2026-09-17');
  f.advance(86400000);
  f.setActive(null);
  f.api.dmvRefreshScheduled();
  assert.equal(f.fetched[1].startDate, '2026-09-12');
  assert.equal(f.fetched[1].endDate, '2026-09-18');
});

test('provider failure preserves previous output and footprint and redacts the saved error', () => {
  const f = fixture(), report = f.save();
  f.api.dmvRunReport(report.id);
  const before = plain(f.readOutput(report.id)), cells = [...f.book.sheets[0].cells];
  f.setOutput(new Error('Provider refused fake-private-token'));
  assert.throws(() => f.api.dmvRunReport(report.id), /Provider refused \[redacted\]/);
  assert.deepEqual([...f.book.sheets[0].cells], cells);
  assert.deepEqual(f.readOutput(report.id), before);
  assert.equal(f.state.batches.length, 1);
  const stored = f.readReport(report.id);
  assert.equal(stored.status, 'error');
  assert.equal(stored.lastRowCount, 1);
  assert.equal(stored.runToken, null);
  assert.ok(!stored.lastError.includes('fake-private-token'));
});

test('failed atomic write leaves both old cells and old footprint intact', () => {
  const f = fixture(), report = f.save();
  f.api.dmvRunReport(report.id);
  const footprint = f.readOutput(report.id), cells = [...f.book.sheets[0].cells];
  f.setOutput({ columns: [{ key: 'count', label: 'Count', type: 'number' }], rows: [{ count: 7 }, { count: 8 }] });
  f.state.failBatch = true;
  assert.throws(() => f.api.dmvRunReport(report.id), /atomic batch failure/);
  assert.deepEqual([...f.book.sheets[0].cells], cells);
  assert.deepEqual(f.readOutput(report.id), footprint);
  assert.equal(f.readReport(report.id).status, 'error');
});

test('refresh shrinks rows and columns atomically and preserves adjacent user cells', () => {
  const f = fixture();
  f.setOutput({ columns: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }, { key: 'c', label: 'C' }],
    rows: [{ a: 1, b: 2, c: 3 }, { a: 4, b: 5, c: 6 }, { a: 7, b: 8, c: 9 }] });
  const report = f.save();
  f.api.dmvRunReport(report.id);
  const sheet = f.book.sheets[0];
  f.setCell(sheet, 5, 4, 'user note');
  f.setOutput({ columns: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }], rows: [{ a: 0, b: false }] });
  f.api.dmvRunReport(report.id);
  assert.equal(f.value(sheet, 2, 1), 0);
  assert.equal(f.value(sheet, 2, 2), false);
  for (const [row, column] of [[1, 3], [2, 3], [3, 1], [3, 2], [3, 3], [4, 1], [4, 2], [4, 3]]) assert.equal(f.value(sheet, row, column), '');
  assert.equal(f.value(sheet, 5, 4), 'user note');
  assert.equal(f.state.batches.length, 2);
  assert.equal(f.state.clears.length, 0, 'stale clearing belongs in the atomic batch');
  assert.equal(f.readOutput(report.id).rows, 2);
  assert.equal(f.readOutput(report.id).columns, 2);
});

test('another report cannot overlap owned output', () => {
  const f = fixture(), first = f.save();
  f.api.dmvRunReport(first.id);
  const second = f.save({ name: 'Second report', target: { sheetName: 'Output', startCell: 'B2' } });
  assert.throws(() => f.api.dmvRunReport(second.id), /overlaps another/);
  assert.equal(f.state.batches.length, 1);
  assert.equal(f.readOutput(second.id), null);
});

test('unmanaged values and blank-displaying formulas block new output', () => {
  for (const formula of ['', '=IF(TRUE,"","")']) {
    const f = fixture(), report = f.save();
    f.setCell(f.book.sheets[0], 1, 1, formula ? '' : 'user note', formula);
    assert.throws(() => f.api.dmvRunReport(report.id), /existing data/);
    assert.equal(f.state.batches.length, 0);
    assert.equal(f.readOutput(report.id), null);
  }
});

test('expanding a report into unmanaged cells preserves its previous result', () => {
  const f = fixture();
  f.setOutput({ columns: [{ key: 'n', label: 'N' }], rows: [{ n: 1 }] });
  const report = f.save();
  f.api.dmvRunReport(report.id);
  f.setCell(f.book.sheets[0], 3, 2, 'keep me');
  const footprint = f.readOutput(report.id);
  f.setOutput({ columns: [{ key: 'n', label: 'N' }, { key: 'm', label: 'M' }], rows: [{ n: 1, m: 2 }, { n: 3, m: 4 }] });
  assert.throws(() => f.api.dmvRunReport(report.id), /existing data/);
  assert.equal(f.value(f.book.sheets[0], 3, 2), 'keep me');
  assert.equal(f.state.batches.length, 1);
  assert.deepEqual(f.readOutput(report.id), footprint);
});

test('oversized and explicitly truncated results never write partial data', () => {
  for (const result of [
    { columns: [{ key: 'n' }], rows: [{ n: 1 }, { n: 2 }] },
    { columns: [{ key: 'n' }], rows: [{ n: 1 }], truncated: true },
    { columns: [{ key: 'n' }], rows: [{ n: 1 }], metadata: { truncated: true } },
  ]) {
    const f = fixture(), report = f.save({ maxRows: 1 });
    f.setOutput(result);
    assert.throws(() => f.api.dmvRunReport(report.id), /row limit/);
    assert.equal(f.state.batches.length, 0);
  }
});

test('preview uses the same complete-result validation and never writes sheets', () => {
  const f = fixture();
  const preview = f.api.dmvPreviewReport(f.input);
  assert.equal(preview.totalRows, 1);
  assert.equal(preview.rows[0].enabled, false);
  assert.equal(f.state.batches.length, 0);
  assert.equal(f.state.script.data.size, 0);
  assert.equal(f.api.dmvBootstrap().reports.length, 0);
});

test('scheduled execution only refreshes reports saved in the spreadsheet that owns the trigger', () => {
  const f = fixture(), report = f.save({ schedule: 'hourly' });
  const other = f.addSpreadsheet('spreadsheet-two');
  f.setActive(other);
  f.api.dmvRefreshScheduled();
  assert.deepEqual(f.state.opened, [], 'an add-on trigger in another spreadsheet leaves this report alone');
  assert.equal(f.readReport(report.id).status, 'ready');
  f.setActive(f.book);
  f.api.dmvRefreshScheduled();
  assert.deepEqual([...new Set(f.state.opened)], ['spreadsheet-one']);
  assert.equal(f.value(f.book.sheets[0], 2, 1), 0);
  assert.equal(other.sheets[0].cells.size, 0);
  assert.equal(f.readReport(report.id).status, 'success');
  f.setActive(other);
  assert.throws(() => f.api.dmvRunReport(report.id), /different spreadsheet/);
});

test('scheduler creates one owner trigger and only removes its own duplicate handlers', () => {
  const f = fixture();
  const foreign = f.addTrigger('legacyGithubResume');
  const report = f.save({ schedule: 'daily' });
  assert.equal(f.state.createdTriggers.length, 1);
  f.addTrigger('dmvRefreshScheduled');
  f.api.dmvSaveReport({ ...report, schedule: 'weekly' });
  assert.equal(f.state.triggers.filter((trigger) => trigger.getHandlerFunction() === 'dmvRefreshScheduled').length, 1);
  assert.ok(f.state.triggers.includes(foreign));
  f.api.dmvSaveReport({ ...report, schedule: 'manual' });
  assert.deepEqual(f.state.triggers, [foreign]);
  assert.ok(f.state.deletedTriggers.every((trigger) => trigger.getHandlerFunction() === 'dmvRefreshScheduled'));
});

test('schedule creation failure rolls back the report save', () => {
  const f = fixture();
  f.state.failTrigger = true;
  assert.throws(() => f.save({ schedule: 'daily' }), /schedule could not be created/);
  assert.equal(f.api.dmvBootstrap().reports.length, 0);
  assert.equal(f.state.lockAcquires, f.state.lockReleases);
});

test('active refresh locks prevent editing or starting the same report twice', () => {
  const f = fixture(), report = f.save();
  const running = { ...f.readReport(report.id), runToken: 'in-flight', startedAt: f.api.Date.now() };
  f.state.user.setProperty(`dmv:v1:report:${report.id}`, JSON.stringify(running));
  assert.throws(() => f.api.dmvRunReport(report.id), /already refreshing/);
  assert.throws(() => f.api.dmvSaveReport({ ...report, name: 'Changed' }), /current refresh/);
  assert.throws(() => f.api.dmvDeleteReport(report.id), /current refresh/);
  assert.equal(f.fetched.length, 0);
});

test('HTTP transport restricts hosts, refuses redirects, and retries only declared read-safe calls', () => {
  const f = fixture(), deadline = f.api.Date.now() + 60000;
  assert.throws(() => f.api.dmvHttp_({ url: 'https://evil.example/query' }, ['orchard.example'], deadline), /outside its provider/);
  assert.equal(f.state.http.length, 0);
  f.state.responses.push({ code: 302, headers: { Location: 'https://evil.example' } });
  assert.throws(() => f.api.dmvHttp_({ url: 'https://orchard.example/query' }, ['orchard.example'], deadline), /redirected/);
  f.state.responses.push({ code: 429, headers: { 'Retry-After': '1' } }, { code: 200, body: { rows: [] } });
  assert.deepEqual(plain(f.api.dmvHttp_({ url: 'https://orchard.example/query', method: 'post', retrySafe: true, body: { query: 'read' } }, ['orchard.example'], deadline)), { rows: [] });
  assert.deepEqual(f.state.sleeps, [1000]);
  assert.equal(f.state.http[1].options.followRedirects, false);
  f.state.responses.push({ code: 503 });
  const before = f.state.http.length;
  assert.throws(() => f.api.dmvHttp_({ url: 'https://orchard.example/query', method: 'post', body: {} }, ['orchard.example'], deadline), /HTTP 503/);
  assert.equal(f.state.http.length, before + 1);
});

test('deleting sheet rows or columns stops refresh and preserves remaining output', () => {
  const f = fixture();
  f.setOutput({ columns: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }, { key: 'c', label: 'C' }],
    rows: [{ a: 1, b: 2, c: 3 }, { a: 4, b: 5, c: 6 }, { a: 7, b: 8, c: 9 }] });
  const report = f.save();
  f.api.dmvRunReport(report.id);
  const sheet = f.book.sheets[0];
  sheet.maxRows = 3; sheet.maxColumns = 2;
  for (const key of sheet.cells.keys()) {
    const [row, column] = key.split(':').map(Number);
    if (row > 3 || column > 2) sheet.cells.delete(key);
  }
  const before = [...sheet.cells], receipt = f.readOutput(report.id);
  f.setOutput({ columns: [{ key: 'a', label: 'A' }], rows: [{ a: 0 }] });
  assert.throws(() => f.api.dmvRunReport(report.id), /edited or moved.*new empty/);
  assert.deepEqual([...sheet.cells], before);
  assert.deepEqual(f.readOutput(report.id), receipt);
  assert.equal(f.state.batches.length, 1);
});
test('grid expansion is in the same atomic batch and failed expansion leaves old dimensions', () => {
  const f = fixture(), sheet = f.book.sheets[0];
  sheet.maxRows = 2; sheet.maxColumns = 2;
  const report = f.save({ target: { sheetName: 'Output', startCell: 'C3' } });
  f.state.failBatch = true;
  assert.throws(() => f.api.dmvRunReport(report.id), /atomic batch failure/);
  assert.equal(sheet.maxRows, 2);
  assert.equal(sheet.maxColumns, 2);
  f.state.failBatch = false;
  f.api.dmvRunReport(report.id);
  assert.equal(sheet.maxRows, 4);
  assert.equal(sheet.maxColumns, 5);
  assert.equal(f.value(sheet, 4, 3), 0);
  assert.equal(f.value(sheet, 4, 4), false);
  assert.equal(f.value(sheet, 4, 5), '=SUM(1,2)');
  assert.ok(f.state.batches[1].body.requests.some((request) => request.updateSheetProperties));
});

test('explicitly incomplete connector output is rejected without replacing the last good report', () => {
  const f = fixture(), report = f.save();
  f.api.dmvRunReport(report.id);
  f.setOutput({ columns: [{ key: 'count' }], rows: [{ count: 99 }], metadata: { complete: false } });
  assert.throws(() => f.api.dmvRunReport(report.id), /limit|incomplete|complete/);
  assert.equal(f.state.batches.length, 1);
  assert.equal(f.value(f.book.sheets[0], 2, 1), 0);
});
test('bootstrap suggests the selected cell only when it is empty, including formula checks', () => {
  const f = fixture(), sheet = f.book.sheets[0];
  f.book.activeRange = sheet.getRange(4, 5, 2, 2);
  assert.deepEqual(plain(f.api.dmvBootstrap().defaultTarget), { sheetName: 'Output', startCell: 'E4' });
  f.setCell(sheet, 4, 5, 'existing');
  assert.equal(f.api.dmvBootstrap().defaultTarget.startCell, 'A1');
  assert.notEqual(f.api.dmvBootstrap().defaultTarget.sheetName, 'Output');
  f.setCell(sheet, 4, 5, '', '=IF(TRUE,"","")');
  assert.notEqual(f.api.dmvBootstrap().defaultTarget.sheetName, 'Output');
});

test('relative date windows follow the spreadsheet calendar across timezone day boundaries', () => {
  const f = fixture();
  f.book.timezone = 'Pacific/Kiritimati';
  const report = f.save({ dateRange: { preset: 'last7' } });
  f.api.dmvRunReport(report.id);
  assert.equal(f.fetched[0].startDate, '2026-09-12');
  assert.equal(f.fetched[0].endDate, '2026-09-18');
  assert.equal(f.api.dmvBootstrap().dateTimezone, 'Pacific/Kiritimati');
});

test('connections, reports and receipts stay user-private; other users still cannot overwrite written cells', () => {
  const first = fixture(), report = first.save();
  first.api.dmvRunReport(report.id);
  const second = createDatamoovSandbox();
  second.setActive(first.book);
  second.state.books.set(first.book.id, first.book.server);
  let serial = 0;
  second.api.Utilities.getUuid = () => `other-user-${++serial}`;
  second.api.dmvRegisterConnector_({ id: 'different', label: 'Another connector', authFields: [],
    reports: [{ id: 'records', fields: [{ key: 'n', label: 'N', default: true }], configFields: [], dateRange: false,
      fetch() { return { columns: [{ key: 'n', label: 'N' }], rows: [{ n: 7 }], metadata: { complete: true } }; } }] });
  assert.equal(second.api.dmvBootstrap().connections.length, 0);
  assert.equal(second.api.dmvBootstrap().reports.length, 0);
  assert.throws(() => second.api.dmvRunReport(report.id), /no longer exists/);
  const connection = second.api.dmvSaveConnection({ connectorId: 'different', label: 'Second user', credentials: {} });
  const otherReport = second.api.dmvSaveReport({ connectionId: connection.id, reportType: 'records', name: 'Other report',
    target: { sheetName: 'Output', startCell: 'A1' }, maxRows: 10 });
  assert.throws(() => second.api.dmvRunReport(otherReport.id), /existing data/);
  assert.equal(first.value(first.book.sheets[0], 2, 1), 0);
  assert.equal(second.state.batches.length, 0);
  assert.equal(first.api.dmvBootstrap().connections.length, 1);
  assert.equal(first.api.dmvBootstrap().reports.length, 1);
});
test('bootstrap finds an unused report tab name when the selected cell is populated', () => {
  const f = fixture(), sheet = f.book.sheets[0];
  f.book.insertSheet('DataMoov report');
  f.book.insertSheet('DataMoov report 2');
  f.book.activeRange = sheet.getRange(1, 1);
  f.setCell(sheet, 1, 1, 'user data');
  assert.deepEqual(plain(f.api.dmvBootstrap().defaultTarget), { sheetName: 'DataMoov report 3', startCell: 'A1' });
  f.book.activeRange = null;
  assert.equal(f.api.dmvBootstrap().defaultTarget.sheetName, 'DataMoov report 3');
});

test('typed output receipts allow ordinary refreshes including blanks, booleans and formula-like text', () => {
  const f = fixture();
  f.setOutput({ columns: [{ key: 'a', label: '=header' }, { key: 'b', label: 'B' }, { key: 'c', label: 'C' }],
    rows: [{ a: '=SUM(1,2)', b: false, c: 0 }, { a: null, b: undefined, c: { nested: 'text' } }] });
  const report = f.save();
  f.api.dmvRunReport(report.id);
  const receipt = f.readOutput(report.id);
  assert.match(receipt.digest, /^[a-f0-9]{64}$/);
  f.api.dmvRunReport(report.id);
  assert.deepEqual(f.readOutput(report.id), receipt);
  assert.equal(f.value(f.book.sheets[0], 1, 1), '=header');
  assert.equal(f.formula(f.book.sheets[0], 1, 1), '');
  assert.equal(f.value(f.book.sheets[0], 3, 3), '{"nested":"text"}');
  assert.equal(f.state.batches.length, 2);
});

test('edited headers and report values stop refresh without discarding user changes', () => {
  for (const [row, column, value] of [[1, 1, 'My custom heading'], [2, 1, 99], [2, 2, 'false']]) {
    const f = fixture(), report = f.save();
    f.api.dmvRunReport(report.id);
    const sheet = f.book.sheets[0], receipt = f.readOutput(report.id);
    f.setCell(sheet, row, column, value);
    const before = [...sheet.cells];
    assert.throws(() => f.api.dmvRunReport(report.id), /edited or moved.*new empty/);
    assert.deepEqual([...sheet.cells], before);
    assert.deepEqual(f.readOutput(report.id), receipt);
    assert.equal(f.state.batches.length, 1);
  }
});

test('a formula replacing an owned value blocks refresh even if its current result is unchanged', () => {
  const f = fixture(), report = f.save();
  f.api.dmvRunReport(report.id);
  const sheet = f.book.sheets[0], receipt = f.readOutput(report.id);
  f.setCell(sheet, 2, 1, 0, '=0');
  const before = [...sheet.cells];
  assert.throws(() => f.api.dmvRunReport(report.id), /edited or moved.*new empty/);
  assert.deepEqual([...sheet.cells], before);
  assert.deepEqual(f.readOutput(report.id), receipt);
  assert.equal(f.state.batches.length, 1);
});

test('output shifted by inserted rows or columns is left untouched until a new area is chosen', () => {
  for (const [shiftRow, shiftColumn] of [[1, 0], [0, 1]]) {
    const f = fixture(), report = f.save();
    f.api.dmvRunReport(report.id);
    const sheet = f.book.sheets[0], receipt = f.readOutput(report.id);
    sheet.cells = new Map([...sheet.cells].map(([key, value]) => {
      const [row, column] = key.split(':').map(Number);
      return [`${row + shiftRow}:${column + shiftColumn}`, value];
    }));
    f.setCell(sheet, 1, 1, 'Inserted user note');
    const before = [...sheet.cells];
    assert.throws(() => f.api.dmvRunReport(report.id), /edited or moved.*new empty/);
    assert.deepEqual([...sheet.cells], before);
    assert.deepEqual(f.readOutput(report.id), receipt);
    assert.equal(f.state.batches.length, 1);
    f.api.dmvSaveReport({ ...f.readReport(report.id), target: { sheetName: 'Output', startCell: 'J10' } });
    f.api.dmvRunReport(report.id);
    for (const [key, value] of before) assert.deepEqual(sheet.cells.get(key), value);
    assert.equal(f.value(sheet, 11, 10), 0);
    assert.equal(f.readOutput(report.id).column, 10);
  }
});

test('old receipts without a digest cannot authorize overwriting existing cells', () => {
  const f = fixture(), report = f.save();
  f.api.dmvRunReport(report.id);
  const receipt = f.readOutput(report.id);
  delete receipt.digest;
  f.state.user.setProperty(`dmv:v1:output:${f.book.id}:${report.id}`, JSON.stringify(receipt));
  const before = [...f.book.sheets[0].cells];
  assert.throws(() => f.api.dmvRunReport(report.id), /edited or moved.*new empty/);
  assert.deepEqual([...f.book.sheets[0].cells], before);
  assert.deepEqual(f.readOutput(report.id), receipt);
  assert.equal(f.state.batches.length, 1);
});
test('normalization rejects invalid or oversized values before replacing a saved report', () => {
  for (const invalid of [NaN, Infinity, -Infinity, 'x'.repeat(49001)]) {
    const f = fixture(), report = f.save();
    f.api.dmvRunReport(report.id);
    const cells = [...f.book.sheets[0].cells], receipt = f.readOutput(report.id);
    f.setOutput({ columns: [{ key: 'value', label: 'Value' }], rows: [{ value: invalid }] });
    assert.throws(() => f.api.dmvPreviewReport(f.input), /invalid numeric|too large/);
    assert.throws(() => f.api.dmvRunReport(report.id), /invalid numeric|too large/);
    assert.deepEqual([...f.book.sheets[0].cells], cells);
    assert.deepEqual(f.readOutput(report.id), receipt);
    assert.equal(f.state.batches.length, 1);
  }
});

test('normalization keeps text IDs, raw text prefixes and object values stable across refreshes', () => {
  const f = fixture();
  const textValues = ['00123', '9007199254740993', '=SUM(1,2)', '+note', '-note', '@note', "'literal"];
  f.setOutput({ columns: [{ key: 'text', label: '-Header' }, { key: 'json', label: 'Object' }],
    rows: textValues.map((text) => ({ text, json: { enabled: false, count: 0, nullable: null } })) });
  const report = f.save();
  f.api.dmvRunReport(report.id);
  const sheet = f.book.sheets[0], receipt = f.readOutput(report.id);
  f.api.dmvRunReport(report.id);
  for (let index = 0; index < textValues.length; index++) {
    assert.equal(f.value(sheet, index + 2, 1), textValues[index]);
    assert.equal(f.formula(sheet, index + 2, 1), '');
    assert.equal(f.value(sheet, index + 2, 2), '{"enabled":false,"count":0,"nullable":null}');
  }
  assert.equal(f.value(sheet, 1, 1), '-Header');
  assert.deepEqual(f.readOutput(report.id), receipt);
});

test('the shared output size budget rejects oversized previews and refreshes before any sheet change', () => {
  const f = fixture(), report = f.save();
  f.api.dmvRunReport(report.id);
  const cells = [...f.book.sheets[0].cells], receipt = f.readOutput(report.id);
  f.api.DMV_LIMITS.maxBytes = 100;
  f.setOutput({ columns: [{ key: 'text', label: 'Text' }], rows: [{ text: 'x'.repeat(100) }] });
  assert.throws(() => f.api.dmvPreviewReport(f.input), /too large for one refresh/);
  assert.throws(() => f.api.dmvRunReport(report.id), /too large for one refresh/);
  assert.deepEqual([...f.book.sheets[0].cells], cells);
  assert.deepEqual(f.readOutput(report.id), receipt);
  assert.equal(f.state.batches.length, 1);
});