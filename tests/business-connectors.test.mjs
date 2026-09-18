import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const connectors = {};
const runtime = vm.createContext({
  dmvRegisterConnector_: (connector) => { connectors[connector.id] = connector; },
  Utilities: { base64Encode: (value) => Buffer.from(value).toString('base64'), getUuid: () => 'offline-dry-run-id' },
}, { codeGeneration: { strings: false, wasm: false } });
for (const file of ['dmv_core.js', 'dmv_sql.js', 'dmv_connector_helpers.js']) {
  new vm.Script(readFileSync(new URL('../src/' + file, import.meta.url), 'utf8')).runInContext(runtime);
}
runtime.dmvRegisterConnector_ = (connector) => { connectors[connector.id] = connector; };
for (const name of ['hubspot', 'zendesk', 'bigquery']) {
  new vm.Script(readFileSync(new URL(`../src/connectors/${name}.js`, import.meta.url), 'utf8'), { filename: name })
    .runInContext(runtime, { timeout: 1000 });
}
const plain = (value) => JSON.parse(JSON.stringify(value));
const report = (connector, id) => connectors[connector].reports.find((item) => item.id === id);
function context(replies, overrides = {}) {
  const calls = [];
  const ctx = { credentials: {}, config: {}, fields: [], startDate: '2026-09-01', endDate: '2026-09-02',
    maxRows: 1000, accessToken: () => 'fake-token', checkDeadline() {}, ...overrides,
    http(request) {
      calls.push(plain(request));
      assert.ok(replies.length, 'unexpected network request');
      const reply = replies.shift();
      return typeof reply === 'function' ? reply(request) : reply;
    } };
  return { ctx, calls };
}
const deal = (id, properties = {}) => ({ id, properties });
const hubspot = { credentials: { accessToken: 'fake-private-app-token' } };
const zendesk = { credentials: { subdomain: 'example', email: 'agent@example.test', apiToken: 'fake-token' } };

test('business connectors expose only their expected provider hosts', () => {
  assert.deepEqual(plain(connectors.hubspot.allowedHosts), ['api.hubapi.com']);
  assert.deepEqual(plain(connectors.bigquery.allowedHosts), ['bigquery.googleapis.com']);
  assert.deepEqual(plain(connectors.zendesk.allowedHosts(zendesk.credentials)), ['example.zendesk.com']);
  assert.throws(() => connectors.zendesk.allowedHosts({ subdomain: 'example.zendesk.com@evil.test' }), /subdomain/);
});

test('HubSpot pages deals, preserves zero/false, and applies an inclusive UTC date range', () => {
  const { ctx, calls } = context([
    { total: 2, results: [deal('1', { amount: '0', dealname: false })], paging: { next: { after: 'cursor/one' } } },
    { total: 2, results: [deal('2', { amount: '42.5', dealname: '' })] },
  ], { ...hubspot, fields: ['id', 'amount', 'dealname'], config: { dateField: 'createdate' } });
  const result = report('hubspot', 'deals').fetch(ctx);
  assert.deepEqual(plain(result.rows), [{ id: '1', amount: 0, dealname: false }, { id: '2', amount: 42.5, dealname: '' }]);
  assert.equal(calls[1].body.after, 'cursor/one');
  assert.deepEqual(calls[0].body.filterGroups[0].filters, [
    { propertyName: 'createdate', operator: 'GTE', value: String(Date.parse('2026-09-01T00:00:00Z')) },
    { propertyName: 'createdate', operator: 'LT', value: String(Date.parse('2026-09-03T00:00:00Z')) },
  ]);
  assert.equal(result.metadata.complete, true);
});

test('HubSpot rejects oversized and incomplete result sets rather than returning partial reports', () => {
  let setup = context([{ total: 3, results: [deal('1')] }], { ...hubspot, maxRows: 2 });
  assert.throws(() => report('hubspot', 'deals').fetch(setup.ctx), /row limit/);
  setup = context([{ total: 2, results: [deal('1')] }], hubspot);
  assert.throws(() => report('hubspot', 'deals').fetch(setup.ctx), /changed during pagination/);
});

test('HubSpot rejects repeated pages and never follows provider paging URLs', () => {
  const { ctx, calls } = context([
    { total: 3, results: [deal('1')], paging: { next: { after: 'same', link: 'https://evil.test' } } },
    { total: 3, results: [deal('2')], paging: { next: { after: 'same' } } },
  ], hubspot);
  assert.throws(() => report('hubspot', 'deals').fetch(ctx), /repeated pagination/);
  assert.ok(calls.every((call) => call.url === 'https://api.hubapi.com/crm/v3/objects/deals/search'));
});

test('HubSpot discovers account properties and fetches chosen custom values', () => {
  const { ctx, calls } = context([
    { results: [{ name: 'custom_revenue', label: 'Custom revenue', type: 'number' },
      { name: 'old_field', label: 'Archived', archived: true, type: 'string' }] },
    { total: 1, results: [deal('1', { custom_revenue: '0' })] },
  ], { ...hubspot, fields: ['id', 'custom_revenue'] });
  const result = report('hubspot', 'deals').fetch(ctx);
  assert.equal(result.rows[0].custom_revenue, 0);
  assert.equal(result.columns[1].label, 'Custom revenue');
  assert.equal(calls[0].url, 'https://api.hubapi.com/crm/v3/properties/deals');
});

test('HubSpot refuses duplicate deal IDs and invalid date filter fields', () => {
  let setup = context([{ total: 2, results: [deal('1'), deal('1')] }], hubspot);
  assert.throws(() => report('hubspot', 'deals').fetch(setup.ctx), /duplicate deals/);
  setup = context([], { ...hubspot, config: { dateField: 'injected' } });
  assert.throws(() => report('hubspot', 'deals').fetch(setup.ctx), /date filter/);
  assert.equal(setup.calls.length, 0);
});

test('Zendesk exports all cursor pages with a ticket-only inclusive date filter', () => {
  const endpoint = 'https://example.zendesk.com/api/v2/search/export';
  const { ctx, calls } = context([
    { results: [{ id: 1, status: 'new', priority: null }], meta: { has_more: true }, links: { next: endpoint + '?page%5Bafter%5D=abc' } },
    { results: [{ id: 2, status: 'solved', priority: 'high' }], meta: { has_more: false } },
  ], { ...zendesk, fields: ['id', 'status', 'priority'], config: { dateField: 'updated' } });
  const result = report('zendesk', 'tickets').fetch(ctx);
  assert.deepEqual(plain(result.rows), [{ id: '1', status: 'new', priority: '' }, { id: '2', status: 'solved', priority: 'high' }]);
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get('filter[type]'), 'ticket');
  assert.equal(url.searchParams.get('query'), 'updated>=2026-09-01 updated<2026-09-03');
  assert.equal(calls[0].headers.Authorization, 'Basic ' + Buffer.from('agent@example.test/token:fake-token').toString('base64'));
});

test('Zendesk rejects an external next link before forwarding credentials', () => {
  const { ctx, calls } = context([{ results: [], meta: { has_more: true }, links: { next: 'https://evil.test/api/v2/search/export?page=2' } }], zendesk);
  assert.throws(() => report('zendesk', 'tickets').fetch(ctx), /unexpected pagination URL/);
  assert.equal(calls.length, 1);
});

test('Zendesk can construct a next page from an opaque cursor and rejects oversized reports', () => {
  let setup = context([
    { results: [{ id: 1 }], meta: { has_more: true, after_cursor: 'opaque&cursor' } },
    { results: [{ id: 2 }], meta: { has_more: false } },
  ], { ...zendesk, fields: ['id'] });
  assert.equal(report('zendesk', 'tickets').fetch(setup.ctx).rows.length, 2);
  assert.equal(new URL(setup.calls[1].url).searchParams.get('page[after]'), 'opaque&cursor');
  setup = context([{ results: [{ id: 1 }], meta: { has_more: true, after_cursor: 'more' } }], { ...zendesk, maxRows: 1 });
  assert.throws(() => report('zendesk', 'tickets').fetch(setup.ctx), /row limit/);
});

test('Zendesk discovers custom fields and preserves false custom values', () => {
  const { ctx } = context([
    { ticket_fields: [{ id: 50, type: 'checkbox', title: 'Paid', active: true }, { id: 1, type: 'subject', title: 'Subject' }], meta: { has_more: false } },
    { results: [{ id: 1, custom_fields: [{ id: 50, value: false }] }], meta: { has_more: false } },
  ], { ...zendesk, fields: ['id', 'custom_50'] });
  const result = report('zendesk', 'tickets').fetch(ctx);
  assert.equal(result.rows[0].custom_50, false);
  assert.equal(result.columns[1].label, 'Paid');
});

test('Zendesk ticket metrics use one bulk endpoint, preserve zeros, and declare archive limitations', () => {
  const { ctx, calls } = context([{ ticket_metrics: [{ ticket_id: 1, replies: 0, reopens: 0,
    reply_time_in_minutes: { calendar: 0 }, full_resolution_time_in_minutes: { calendar: null } }], meta: { has_more: false } }], zendesk);
  const result = report('zendesk', 'ticket_metrics').fetch(ctx);
  assert.equal(result.rows[0].replies, 0);
  assert.equal(result.rows[0].reply_time_calendar_minutes, 0);
  assert.equal(result.rows[0].full_resolution_time_calendar_minutes, '');
  assert.match(result.metadata.note, /excludes archived/);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/ticket_metrics\?/);
  assert.equal(report('zendesk', 'ticket_metrics').dateRange, false);
});

const bqConfig = { projectId: 'test-project', sql: 'SELECT 1 AS n', location: 'EU' };
const bqFields = [{ name: 'n', type: 'INTEGER' }];
const dryRun = (fields = bqFields, extra = {}) => ({ totalBytesProcessed: '10', schema: { fields }, ...extra });
const jobReference = { projectId: 'test-project', jobId: 'job-one', location: 'EU' };
const bqPage = (values, extra = {}) => ({ jobComplete: true, jobReference, schema: { fields: bqFields },
  rows: values.map((value) => ({ f: [{ v: value }] })), ...extra });

test('BigQuery dry-runs and executes the identical single SELECT wrapper with read-only scope', () => {
  const { ctx, calls } = context([dryRun(), bqPage(['1'], { totalRows: '1' })], { config: bqConfig });
  report('bigquery', 'query').fetch(ctx);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/queries$/);
  assert.equal(calls[0].body.dryRun, true);
  assert.equal(calls[0].body.query, calls[1].body.query);
  assert.equal(calls[0].body.query, 'SELECT * FROM (\nSELECT 1 AS n\n) AS datamoov_report LIMIT 1001');
  assert.deepEqual(plain(connectors.bigquery.googleScopes), ['https://www.googleapis.com/auth/bigquery.readonly']);
});

test('BigQuery rejects a script or query-wrapper escape before any request', () => {
  for (const sql of ['SELECT 1; DELETE FROM t', 'SELECT 1); DELETE FROM t; SELECT (1', 'WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x']) {
    const { ctx, calls } = context([], { config: { ...bqConfig, sql } });
    assert.throws(() => report('bigquery', 'query').fetch(ctx), /statement|parentheses/);
    assert.equal(calls.length, 0);
  }
});
test('BigQuery rejects obvious write SQL without making a request', () => {
  const { ctx, calls } = context([], { config: { ...bqConfig, sql: 'DELETE FROM x WHERE true' } });
  assert.throws(() => report('bigquery', 'query').fetch(ctx), /SELECT or WITH/);
  assert.equal(calls.length, 0);
});

test('BigQuery field discovery is a dry run and rejects scans over budget', () => {
  let setup = context([dryRun()], { config: bqConfig });
  assert.deepEqual(plain(report('bigquery', 'query').discoverFields(setup.ctx)), [{ key: 'n', label: 'n', type: 'number', default: true }]);
  assert.equal(setup.calls.length, 1);
  setup = context([dryRun(bqFields, { totalBytesProcessed: '1073741825' })], { config: bqConfig });
  assert.throws(() => report('bigquery', 'query').fetch(setup.ctx), /exceeds maximum bytes/);
  assert.equal(setup.calls.length, 1);
});

test('BigQuery polls its job then fetches every page, retaining job location and zero', () => {
  const { ctx, calls } = context([
    dryRun(), { jobComplete: false, jobReference },
    bqPage(['0'], { totalRows: '2', pageToken: 'cursor+one' }),
    bqPage(['2'], { totalRows: '2' }),
  ], { config: bqConfig, maxRows: 2 });
  const result = report('bigquery', 'query').fetch(ctx);
  assert.deepEqual(plain(result.rows), [{ n: 0 }, { n: 2 }]);
  assert.equal(calls[1].body.maximumBytesBilled, '1073741824');
  assert.equal(calls[1].body.jobTimeoutMs, '45000');
  assert.equal(new URL(calls[2].url).searchParams.get('location'), 'EU');
  assert.equal(new URL(calls[3].url).searchParams.get('pageToken'), 'cursor+one');
});

test('BigQuery refuses row overflow, repeated result cursors, and incomplete totals', () => {
  let setup = context([dryRun(), bqPage(['1'], { totalRows: '2' })], { config: bqConfig, maxRows: 1 });
  assert.throws(() => report('bigquery', 'query').fetch(setup.ctx), /row limit/);
  setup = context([dryRun(), bqPage(['1'], { pageToken: 'same' }), bqPage(['2'], { pageToken: 'same' })], { config: bqConfig });
  assert.throws(() => report('bigquery', 'query').fetch(setup.ctx), /repeated result page/);
  setup = context([dryRun(), bqPage(['1'], { totalRows: '2' })], { config: bqConfig });
  assert.throws(() => report('bigquery', 'query').fetch(setup.ctx), /incomplete result/);
});

test('BigQuery bounds asynchronous polling instead of looping indefinitely', () => {
  const { ctx, calls } = context([dryRun(), ...Array.from({ length: 6 }, () => ({ jobComplete: false, jobReference }))], { config: bqConfig });
  assert.throws(() => report('bigquery', 'query').fetch(ctx), /still running/);
  assert.equal(calls.length, 7);
});

test('BigQuery preserves large integers, exact decimal text, booleans, repeated and nested values', () => {
  const fields = [
    { name: 'id', type: 'INTEGER' }, { name: 'amount', type: 'NUMERIC' }, { name: 'active', type: 'BOOLEAN' },
    { name: 'tags', type: 'STRING', mode: 'REPEATED' },
    { name: 'nested', type: 'RECORD', fields: [{ name: 'count', type: 'INTEGER' }] },
  ];
  const { ctx } = context([dryRun(fields), { jobComplete: true, jobReference, totalRows: '1', schema: { fields },
    rows: [{ f: [{ v: '9007199254740993' }, { v: '0.123456789123456789' }, { v: 'false' },
      { v: [{ v: 'one' }, { v: 'two' }] }, { v: { f: [{ v: '0' }] } }] }] }], { config: bqConfig });
  assert.deepEqual(plain(report('bigquery', 'query').fetch(ctx).rows), [{ id: '9007199254740993', amount: '0.123456789123456789',
    active: false, tags: '["one","two"]', nested: '{"count":0}' }]);
});

test('BigQuery rejects a changed schema and exposes only selected columns', () => {
  let setup = context([dryRun(), bqPage(['1'], { schema: { fields: [{ name: 'different', type: 'INTEGER' }] } })], { config: bqConfig });
  assert.throws(() => report('bigquery', 'query').fetch(setup.ctx), /schema changed/);
  const fields = [...bqFields, { name: 'hidden', type: 'STRING' }];
  setup = context([dryRun(fields), { jobComplete: true, jobReference, schema: { fields }, totalRows: '1',
    rows: [{ f: [{ v: '0' }, { v: 'secret-data-not-selected' }] }] }], { config: bqConfig, fields: ['n'] });
  assert.deepEqual(plain(report('bigquery', 'query').fetch(setup.ctx).rows), [{ n: 0 }]);
});

test('business connector pagination checks the shared execution deadline', () => {
  for (const [connector, id, options] of [['hubspot', 'deals', hubspot], ['zendesk', 'tickets', zendesk], ['bigquery', 'query', { config: bqConfig }]]) {
    const { ctx, calls } = context([], { ...options, checkDeadline() { throw new Error('deadline reached'); } });
    assert.throws(() => report(connector, id).fetch(ctx), /deadline reached/);
    assert.equal(calls.length, 0);
  }
});

test('Zendesk requires an explicit pagination end and refuses duplicate tickets', () => {
  let setup = context([{ results: [{ id: 1 }] }], zendesk);
  assert.throws(() => report('zendesk', 'tickets').fetch(setup.ctx), /confirm whether/);
  setup = context([{ results: [{ id: 1 }, { id: 1 }], meta: { has_more: false } }], zendesk);
  assert.throws(() => report('zendesk', 'tickets').fetch(setup.ctx), /duplicate tickets/);
});

test('BigQuery accepts harmless schema descriptions and default nullable mode', () => {
  const { ctx } = context([dryRun(), bqPage(['0'], { totalRows: '1', schema: { fields: [{ name: 'n', type: 'INTEGER', mode: 'NULLABLE', description: 'Count' }] } })], { config: bqConfig });
  assert.equal(report('bigquery', 'query').fetch(ctx).rows[0].n, 0);
});