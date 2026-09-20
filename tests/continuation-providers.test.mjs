import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createDatamoovSandbox, plain } from './helpers/datamoov-sandbox.mjs';

function fixture(connectorId, credentials, input) {
  const f = createDatamoovSandbox();
  for (const name of ['github', 'ga4']) {
    const filename = `connectors/${name}.js`;
    new vm.Script(readFileSync(new URL(`../src/${filename}`, import.meta.url), 'utf8'), { filename })
      .runInContext(f.api, { timeout: 1000 });
  }
  f.api.DMV_CONTINUATION.chunksPerExecution = 1;
  // Saving a connection checks it with the provider; these tests script only the report pages.
  delete f.api.DMV_CONNECTORS[connectorId].test;
  const connection = f.api.dmvSaveConnection({ connectorId, label: 'Provider account', credentials });
  const report = f.api.dmvSaveReport({ connectionId: connection.id, name: 'Provider report',
    maxRows: 10, target: { sheetName: 'Output', startCell: 'A1' }, ...input });
  return { ...f, connection, report };
}

test('real GitHub search resumes through private checkpoints and writes both pages once', () => {
  const secret = 'github-private-offline-token';
  const f = fixture('github', { token: secret }, {
    reportType: 'repository_overview', config: { query: 'topic:analytics' },
    fields: ['full_name', 'stargazers_count', 'archived', 'description'],
  });
  const repository = (id, name, description) => ({ id, full_name: name,
    stargazers_count: 0, archived: false, description });
  f.state.responses.push(
    { body: { total_count: 2, items: [repository('9007199254740993', 'private-owner/first', '9007199254740993')] } },
    { body: { total_count: 2, items: [repository('9007199254740994', 'private-owner/second', '=literal-text')] } },
  );
  const pending = f.api.dmvRunReport(f.report.id);
  assert.equal(pending.pending, true);
  assert.equal(pending.rowCount, 1);
  assert.equal(f.state.http.length, 1);
  assert.equal(f.state.batches.length, 0);
  assert.equal(f.book.sheets[0].cells.size, 0);
  const saved = f.readReport(f.report.id);
  const snapshot = f.api.dmvReadContinuation_(saved);
  assert.equal(snapshot.result.state.page, 2);
  assert.deepEqual(plain(snapshot.result.state.ids), ['9007199254740993']);
  assert.ok(!JSON.stringify(snapshot).includes(secret));
  const visible = JSON.stringify(f.api.dmvBootstrap());
  for (const privateValue of [secret, 'private-owner/first', '9007199254740993', '"nextState"', '"ids"'])
    assert.ok(!visible.includes(privateValue), `Bootstrap must not expose ${privateValue}`);

  // A second Google user shares the spreadsheet and project, but not UserProperties.
  const other = createDatamoovSandbox();
  other.state.books.set(f.book.id, f.book.server);
  other.setActive(f.book);
  other.api.PropertiesService.getScriptProperties = () => f.state.script;
  other.api.PropertiesService.getDocumentProperties = () => f.state.document;
  assert.deepEqual(plain(other.api.dmvBootstrap().reports), []);
  assert.deepEqual(plain(other.api.dmvBootstrap().connections), []);
  assert.throws(() => other.api.dmvRead_('connection', f.connection.id), /no longer exists/);
  assert.throws(() => other.api.dmvRead_('report', f.report.id), /no longer exists/);
  assert.throws(() => other.api.dmvReadContinuation_(saved), /missing or damaged/);
  assert.throws(() => other.api.dmvRunReport(f.report.id), /no longer exists/);
  assert.equal(other.state.http.length, 0);
  assert.equal(other.state.batches.length, 0);

  assert.equal(f.api.dmvRunReport(f.report.id).rowCount, 2);
  assert.deepEqual(f.state.http.map((call) => new URL(call.url).searchParams.get('page')), ['1', '2']);
  assert.ok(f.state.http.every((call) => call.options.headers.Authorization === 'Bearer ' + secret));
  assert.equal(f.state.responses.length, 0);
  assert.equal(f.state.batches.length, 1);
  assert.equal(f.state.legacyWrites.length, 0);
  assert.equal(f.value(f.book.sheets[0], 2, 1), 'private-owner/first');
  assert.equal(f.value(f.book.sheets[0], 2, 2), 0);
  assert.equal(f.value(f.book.sheets[0], 2, 3), false);
  assert.equal(f.value(f.book.sheets[0], 2, 4), '9007199254740993');
  assert.equal(f.value(f.book.sheets[0], 3, 1), 'private-owner/second');
  assert.equal(f.value(f.book.sheets[0], 3, 4), '=literal-text');
  assert.equal(f.formula(f.book.sheets[0], 3, 4), '');
  assert.equal(f.readReport(f.report.id).status, 'success');
  assert.ok(![...f.state.user.data.keys()].some((key) => key.startsWith('dmv:v1:chunk:')));
});

test('real GA4 resumes at its offset without repeating discovery and preserves typed output', () => {
  const secret = 'ga4-private-offline-token';
  const dimension = 'customUser:customer_id';
  const f = fixture('ga4', { propertyId: '123456', authMode: 'token', accessToken: secret }, {
    reportType: 'acquisition_daily', fields: ['date', dimension, 'sessions'],
    dateRange: { preset: 'custom', startDate: '2026-09-01', endDate: '2026-09-02' },
  });
  const dimensions = [{ apiName: 'date', uiName: 'Date' },
    { apiName: dimension, uiName: 'Customer ID', customDefinition: true }];
  const metrics = [{ apiName: 'sessions', uiName: 'Sessions', type: 'TYPE_INTEGER' }];
  const page = (date, customer, sessions) => ({ rowCount: 2,
    dimensionHeaders: [{ name: 'date' }, { name: dimension }], metricHeaders: [{ name: 'sessions' }],
    rows: [{ dimensionValues: [{ value: date }, { value: customer }], metricValues: [{ value: sessions }] }],
    metadata: { currencyCode: 'EUR', timeZone: 'Europe/Athens' } });
  f.state.responses.push(
    { body: { dimensions, metrics } },
    { body: {
      dimensionCompatibilities: dimensions.map((dimensionMetadata) => ({ compatibility: 'COMPATIBLE', dimensionMetadata })),
      metricCompatibilities: metrics.map((metricMetadata) => ({ compatibility: 'COMPATIBLE', metricMetadata })),
    } },
    { body: page('20260901', '9007199254740993', '0') },
    { body: page('20260902', '9007199254740994', '2') },
  );
  assert.equal(f.api.dmvRunReport(f.report.id).pending, true);
  assert.equal(f.state.http.length, 3);
  assert.equal(f.state.batches.length, 0);
  assert.equal(f.book.sheets[0].cells.size, 0);
  const snapshot = f.api.dmvReadContinuation_(f.readReport(f.report.id));
  assert.equal(snapshot.result.state.offset, 1);
  assert.ok(!JSON.stringify(snapshot).includes(secret));
  const visible = JSON.stringify(f.api.dmvBootstrap());
  for (const privateValue of [secret, '9007199254740993', '"offset"', '"nextState"'])
    assert.ok(!visible.includes(privateValue), `Bootstrap must not expose ${privateValue}`);
  assert.equal(f.api.dmvRunReport(f.report.id).rowCount, 2);
  assert.deepEqual(f.state.http.map((call) => call.url.replace('https://analyticsdata.googleapis.com/v1beta/properties/123456', '')),
    ['/metadata', ':checkCompatibility', ':runReport', ':runReport']);
  const runRequests = f.state.http.filter((call) => call.url.endsWith(':runReport'))
    .map((call) => JSON.parse(call.options.payload));
  assert.deepEqual(runRequests.map((request) => request.offset), ['0', '1']);
  assert.deepEqual(runRequests[0].dateRanges, runRequests[1].dateRanges);
  assert.ok(f.state.http.every((call) => call.options.headers.Authorization === 'Bearer ' + secret));
  assert.equal(f.state.responses.length, 0);
  assert.equal(f.state.batches.length, 1);
  assert.equal(f.state.legacyWrites.length, 0);
  assert.equal(f.value(f.book.sheets[0], 2, 1), '2026-09-01');
  assert.equal(f.value(f.book.sheets[0], 2, 2), '9007199254740993');
  assert.equal(f.value(f.book.sheets[0], 2, 3), 0);
  assert.equal(f.value(f.book.sheets[0], 3, 1), '2026-09-02');
  assert.equal(f.value(f.book.sheets[0], 3, 2), '9007199254740994');
  assert.equal(f.value(f.book.sheets[0], 3, 3), 2);
  assert.equal(f.readReport(f.report.id).status, 'success');
  assert.ok(![...f.state.user.data.keys()].some((key) => key.startsWith('dmv:v1:chunk:')));
});
