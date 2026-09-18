import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createDatamoovSandbox, plain } from './helpers/datamoov-sandbox.mjs';

function provider(name) {
  const sandbox = createDatamoovSandbox();
  vm.runInContext(readFileSync(new URL('../src/connectors/' + name + '.js', import.meta.url), 'utf8'), sandbox.api);
  return sandbox;
}

function arbitrary() {
  const sandbox = createDatamoovSandbox();
  let checks = 0;
  const connector = {
    id: 'orchard', label: 'Orchard', reports: [], allowedHosts: ['orchard.example'],
    authFields: [{ key: 'account', label: 'Account', type: 'text', required: true },
      { key: 'token', label: 'Token', type: 'password', required: true },
      { key: 'mode', label: 'Mode', type: 'select', default: 'native', options: ['native', 'other'] }],
    accountDiscovery: { label: 'Orchard account', credentialKeys: ['account'], showWhen: { key: 'mode', value: 'native' } },
    discoverAccounts(ctx) {
      assert.equal(ctx.credentials.token, 'private-fixture-token');
      return [{ id: 'one', label: 'One', credentials: { account: 'one', token: 'private-fixture-token', extra: 'drop' } }];
    },
    test() { checks++; },
  };
  sandbox.api.dmvRegisterConnector_(connector);
  return { ...sandbox, connector, checks: () => checks };
}

test('generic discovery omits selection requirements and exposes only declared non-secret selection fields', () => {
  const f = arbitrary();
  const result = f.api.dmvDiscoverAccounts({ connectorId: 'orchard', credentials: { token: 'private-fixture-token' } });
  assert.deepEqual(plain(result), { complete: true, accounts: [{ id: 'one', label: 'One', credentials: { account: 'one' } }] });
  assert.equal(f.state.user.data.size, 0);
  const catalog = f.api.dmvCatalog_()[0];
  assert.equal(catalog.supportsAccountDiscovery, true);
  assert.deepEqual(plain(catalog.accountDiscovery.credentialKeys), ['account']);
  assert.throws(() => f.api.dmvDiscoverAccounts({ connectorId: 'orchard', credentials: { token: 'private-fixture-token', mode: 'other' } }), /authorization/);
});

test('saved secret reuse is current-user scoped and discovery errors redact credentials', () => {
  const f = arbitrary();
  const saved = f.api.dmvSaveConnection({ connectorId: 'orchard', label: 'One', credentials: { account: 'one', token: 'private-fixture-token' } });
  assert.equal(f.checks(), 1);
  assert.equal(f.api.dmvDiscoverAccounts({ id: saved.id, connectorId: 'orchard', credentials: { token: '' } }).accounts.length, 1);
  f.connector.discoverAccounts = () => { throw new Error('private-fixture-token failed'); };
  assert.throws(() => f.api.dmvDiscoverAccounts({ id: saved.id, connectorId: 'orchard', credentials: {} }), /redacted/);
  assert.throws(() => arbitrary().api.dmvDiscoverAccounts({ id: saved.id, connectorId: 'orchard', credentials: {} }), /no longer exists/);
});

test('new selections verify before saving, failed checks do not persist, and label-only changes skip checks', () => {
  const f = arbitrary();
  const input = { connectorId: 'orchard', label: 'One', credentials: { account: 'one', token: 'private-fixture-token' } };
  f.connector.test = () => { throw new Error('Provider denied account'); };
  assert.throws(() => f.api.dmvSaveConnection(input), /denied/);
  assert.equal(f.state.user.data.size, 0);
  let checks = 0;
  f.connector.test = () => { checks++; };
  const saved = f.api.dmvSaveConnection(input);
  f.api.dmvSaveConnection({ ...input, id: saved.id, label: 'Renamed' });
  assert.equal(checks, 1);
  f.api.dmvSaveConnection({ ...input, id: saved.id, credentials: { ...input.credentials, account: 'two' } });
  assert.equal(checks, 2);
});

test('referenced account identity and active-run locks are preserved', () => {
  const f = arbitrary();
  const input = { connectorId: 'orchard', label: 'One', credentials: { account: 'one', token: 'private-fixture-token' } };
  const saved = f.api.dmvSaveConnection(input);
  f.api.dmvSave_('report', { id: 'report-one', connectionId: saved.id });
  assert.throws(() => f.api.dmvSaveConnection({ ...input, id: saved.id, credentials: { ...input.credentials, account: 'two' } }), /new connection/);
  f.api.dmvSave_('report', { id: 'report-one', connectionId: saved.id, runToken: 'running', startedAt: f.api.Date.now() });
  assert.throws(() => f.api.dmvSaveConnection({ ...input, id: saved.id, label: 'Rename' }), /current refresh/);
  assert.equal(f.api.dmvRead_('connection', saved.id).credentials.account, 'one');
});

test('GA4 discovers all Admin pages with read-only native credentials and rejects repeated cursors', () => {
  const f = provider('ga4');
  f.state.responses.push({ body: { accountSummaries: [{ displayName: 'Account', propertySummaries: [{ property: 'properties/123', displayName: 'First' }] }], nextPageToken: 'next' } },
    { body: { accountSummaries: [{ propertySummaries: [{ property: 'properties/456', displayName: 'Second' }] }] } });
  const result = f.api.dmvDiscoverAccounts({ connectorId: 'ga4', credentials: { authMode: 'native' } });
  assert.equal(result.complete, true);
  assert.deepEqual(plain(result.accounts.map(a => a.credentials)), [{ propertyId: '123' }, { propertyId: '456' }]);
  assert.match(f.state.http[1].url, /analyticsadmin\.googleapis\.com.*pageToken=next/);
  assert.equal(f.state.http[0].options.headers.Authorization, 'Bearer fake-native-google-token');
  f.state.responses.push({ body: { nextPageToken: 'same' } }, { body: { nextPageToken: 'same' } });
  assert.throws(() => f.api.dmvDiscoverAccounts({ connectorId: 'ga4', credentials: {} }), /repeated/);
});

test('Ads enumerates manager clients with pagination, drops inherited login, and prefers direct access', () => {
  const f = provider('google_ads');
  const manager = '1111111111', client = '2222222222', second = '3333333333';
  const row = (id, name) => ({ customerClient: { id, descriptiveName: name, manager: false, status: 'ENABLED' } });
  f.state.responses.push({ body: { resourceNames: ['customers/' + manager, 'customers/' + client] } },
    { body: { results: [row(client, 'Client')], nextPageToken: 'page-two' } },
    { body: { results: [row(second, 'Second')] } }, { body: { results: [row(client, 'Direct')] } });
  const result = f.api.dmvDiscoverAccounts({ connectorId: 'google_ads', credentials: { authMode: 'native', developerToken: 'private-fixture-token', loginCustomerId: '9999999999' } });
  assert.equal(f.state.http[0].options.headers['login-customer-id'], undefined);
  assert.equal(f.state.http[1].options.headers['login-customer-id'], manager);
  assert.equal(JSON.parse(f.state.http[2].options.payload).pageToken, 'page-two');
  assert.deepEqual(plain(result.accounts.map(a => a.credentials)), [{ customerId: client, loginCustomerId: '' }, { customerId: second, loginCustomerId: manager }]);
  assert.ok(!JSON.stringify(result).includes('private-fixture-token'));
});

test('discovery fails atomically on provider errors, malformed resources and account limits', () => {
  const ga4 = provider('ga4');
  ga4.state.responses.push({ code: 403, body: { error: { message: 'secret' } } });
  assert.throws(() => ga4.api.dmvDiscoverAccounts({ connectorId: 'ga4', credentials: {} }), /HTTP 403/);
  const ads = provider('google_ads');
  ads.state.responses.push({ body: { resourceNames: ['https://foreign.example/accounts/1'] } });
  assert.throws(() => ads.api.dmvDiscoverAccounts({ connectorId: 'google_ads', credentials: { developerToken: 'private-fixture-token' } }), /invalid accessible/);
  assert.equal(ads.state.http.length, 1);
  const f = arbitrary();
  f.connector.discoverAccounts = () => Array.from({ length: 1001 }, () => ({}));
  assert.throws(() => f.api.dmvDiscoverAccounts({ connectorId: 'orchard', credentials: { token: 'private-fixture-token' } }), /too large/);
  f.connector.accountDiscovery.credentialKeys = ['token'];
  assert.throws(() => f.api.dmvDiscoverAccounts({ connectorId: 'orchard', credentials: {} }), /non-secret/);
});
