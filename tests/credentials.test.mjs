import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createDatamoovSandbox, plain } from './helpers/datamoov-sandbox.mjs';

function fixture(connectors = ['google_ads', 'ga4', 'bigquery', 'search_console', 'hubspot']) {
  const f = createDatamoovSandbox();
  for (const name of connectors) {
    new vm.Script(readFileSync(new URL(`../src/connectors/${name}.js`, import.meta.url), 'utf8'), { filename: name })
      .runInContext(f.api, { timeout: 1000 });
  }
  return f;
}
const KEY = JSON.stringify({ type: 'service_account', client_email: 'robot@example.iam.gserviceaccount.com', private_key: 'offline-key' });

test('credential types come from the connectors: one shared Google type, one per other source', () => {
  const f = fixture();
  const families = f.api.dmvFamilyCatalog_();
  assert.deepEqual(plain(families.map((item) => item.id)), ['google', 'hubspot']);
  const google = families[0];
  assert.equal(google.label, 'Google Cloud');
  assert.deepEqual(plain(google.connectors), ['bigquery', 'ga4', 'google_ads', 'search_console']);
  assert.deepEqual(plain(google.fields.map((field) => field.key)), ['authMode', 'serviceAccountJson', 'clientId', 'clientSecret', 'refreshToken', 'accessToken', 'developerToken']);
  assert.ok(google.guide.modes.service_account.steps.length);
  assert.deepEqual(plain(f.api.dmvCredentialFamilies_().google.scopes).sort(), [
    'https://www.googleapis.com/auth/adwords', 'https://www.googleapis.com/auth/analytics.readonly',
    'https://www.googleapis.com/auth/bigquery.readonly', 'https://www.googleapis.com/auth/webmasters.readonly']);
  for (const id of ['google_ads', 'ga4', 'bigquery', 'search_console'])
    assert.equal(f.api.dmvCatalog_().find((item) => item.id === id).credentialFamily, 'google');
  assert.deepEqual(plain(f.api.dmvConnectionFields_(f.api.DMV_CONNECTORS.google_ads).map((field) => field.key)), ['customerId', 'loginCustomerId']);
});

test('saving a Google credential checks it by minting one token, keeps secrets private and blank edits keep them', () => {
  const f = fixture();
  assert.throws(() => f.api.dmvSaveCredential({ family: 'google', label: 'Agency', values: {} }), /Service account JSON is required/);
  assert.throws(() => f.api.dmvSaveCredential({ family: 'mystery', label: 'x', values: {} }), /supported credential type/);
  f.state.responses.push({ body: { access_token: 'oauth-fresh', expires_in: 3600 } });
  const saved = f.api.dmvSaveCredential({ family: 'google', label: 'Agency client', values: { authMode: 'oauth', clientId: 'client-one', clientSecret: 'private-secret', refreshToken: 'private-refresh' } });
  assert.equal(saved.verified, true);
  assert.equal(f.state.http[0].url, 'https://oauth2.googleapis.com/token');
  assert.match(f.state.http[0].options.payload, /refresh_token=private-refresh/);
  assert.deepEqual(plain(saved.values), { authMode: 'oauth', clientId: 'client-one' });
  assert.deepEqual(plain(saved.configuredFields), ['authMode', 'clientId', 'clientSecret', 'refreshToken']);
  assert.equal(saved.usedBy, 0);
  assert.equal(saved.familyLabel, 'Google Cloud');
  const bootstrap = f.api.dmvBootstrap();
  assert.equal(bootstrap.credentials.length, 1);
  assert.ok(bootstrap.credentialFamilies.some((item) => item.id === 'google'));
  assert.ok(!JSON.stringify(bootstrap).includes('private-secret'));
  // A rename keeps the secrets and skips the check; a token-mode credential is stored unchecked.
  const renamed = f.api.dmvSaveCredential({ id: saved.id, family: 'google', label: 'Agency client (renamed)', values: { authMode: 'oauth', clientId: 'client-one', clientSecret: '', refreshToken: '' } });
  assert.equal(renamed.verified, false);
  assert.equal(f.state.http.length, 1);
  assert.equal(f.api.dmvRead_('credential', saved.id).values.refreshToken, 'private-refresh');
  assert.throws(() => f.api.dmvSaveCredential({ id: saved.id, family: 'hubspot', label: 'x', values: { accessToken: 't' } }), /keeps its type/);
  const token = f.api.dmvSaveCredential({ family: 'google', label: 'Pasted token', values: { authMode: 'token', accessToken: 'g-token' } });
  assert.equal(token.verified, false);
  assert.equal(f.state.http.length, 1);
});

test('a connection points at a saved credential and only keeps its own values; runs merge the two', () => {
  const f = fixture();
  const credential = f.api.dmvSaveCredential({ family: 'google', label: 'Service account', values: { authMode: 'token', accessToken: 'g-token' } });
  f.state.responses.push({ body: { results: [{ customer: { id: '1234567890' } }] } });
  const connection = f.api.dmvSaveConnection({ connectorId: 'google_ads', label: 'Main account', credentialId: credential.id, credentials: { customerId: '1234567890' } });
  assert.equal(connection.verified, true);
  assert.equal(f.state.http[0].options.headers.Authorization, 'Bearer g-token');
  assert.equal(connection.credentialId, credential.id);
  assert.deepEqual(plain(f.api.dmvRead_('connection', connection.id).credentials), { customerId: '1234567890' });
  assert.equal(f.api.dmvRead_('connection', connection.id).credentials.accessToken, undefined, 'the token lives on the credential only');
  assert.deepEqual(plain(f.api.dmvReadConnection_(connection.id).credentials), { authMode: 'token', accessToken: 'g-token', customerId: '1234567890' });
  assert.equal(f.api.dmvBootstrap().credentials[0].usedBy, 1);
  assert.throws(() => f.api.dmvSaveConnection({ connectorId: 'hubspot', label: 'CRM', credentialId: credential.id, credentials: {} }), /another type of source/);
  assert.throws(() => f.api.dmvDeleteCredential(credential.id), /used by Main account/);
  // Report runs read the merged credentials.
  f.state.responses.push({ body: { results: [{ customer: { id: '1234567890' } }] } });
  assert.equal(f.api.dmvTestConnection(connection.id).ok, true);
  assert.equal(f.state.http[1].options.headers.Authorization, 'Bearer g-token');
  // A missing credential fails clearly instead of running with half a credential set.
  f.state.user.deleteProperty('dmv:v1:credential:' + credential.id);
  assert.throws(() => f.api.dmvTestConnection(connection.id), /credential no longer exists/);
  assert.equal(f.api.dmvBootstrap().connections[0].credentialMissing, true);
  f.api.dmvDeleteConnection(connection.id);
});

test('rotated secrets land on the credential record and stale rotations are ignored', () => {
  const f = createDatamoovSandbox();
  let rotateTo = 'rotated-on-check';
  f.api.dmvRegisterConnector_({
    id: 'rotating', label: 'Rotating', reports: [{ id: 'r', label: 'R', fields: [{ key: 'n', label: 'N', type: 'number' }], dateRange: false,
      fetch(ctx) { ctx.rotateCredentials({ refreshToken: rotateTo }); return { columns: this.fields, rows: [{ n: 1 }], metadata: { complete: true } }; } }],
    allowedHosts: [],
    authFields: [{ key: 'account', label: 'Account', type: 'text', required: true, perConnection: true },
      { key: 'refreshToken', label: 'Refresh token', type: 'password', secret: true, required: true }],
    test(ctx) { ctx.rotateCredentials({ refreshToken: rotateTo }); },
  });
  const credential = f.api.dmvSaveCredential({ family: 'rotating', label: 'App', values: { refreshToken: 'initial' } });
  const connection = f.api.dmvSaveConnection({ connectorId: 'rotating', label: 'One', credentialId: credential.id, credentials: { account: 'one' } });
  assert.equal(f.api.dmvRead_('credential', credential.id).values.refreshToken, 'rotated-on-check', 'the save check rotated the shared secret');
  assert.equal(f.api.dmvRead_('credential', credential.id).revision, 1);
  const report = f.api.dmvSaveReport({ connectionId: connection.id, name: 'Rotate', reportType: 'r', fields: ['n'], config: {}, maxRows: 10, target: { sheetName: 'Output', startCell: 'A1' }, schedule: 'manual' });
  rotateTo = 'rotated-on-run';
  assert.equal(f.api.dmvRunReport(report.id).ok, true);
  assert.equal(f.api.dmvRead_('credential', credential.id).values.refreshToken, 'rotated-on-run');
  assert.equal(f.api.dmvRead_('credential', credential.id).revision, 1, 'a rotation is not an edit');
  assert.equal(f.api.dmvRead_('connection', connection.id).credentials.refreshToken, undefined);
  f.api.dmvRotateCredentials_({ credentialId: credential.id, credentialRevision: 0, credentials: {} }, { refreshToken: 'stale' });
  assert.equal(f.api.dmvRead_('credential', credential.id).values.refreshToken, 'rotated-on-run');
  assert.equal(f.api.dmvSaveCredential({ id: credential.id, family: 'rotating', label: 'App', values: { refreshToken: 'manual' } }).usedBy, 1);
  assert.equal(f.api.dmvRead_('credential', credential.id).revision, 2);
});

test('older connections with embedded secrets keep working and discovery accepts either form', () => {
  const f = fixture(['ga4']);
  f.state.responses.push({ body: { dimensions: [{ apiName: 'date' }], metrics: [{ apiName: 'sessions', type: 'TYPE_INTEGER' }] } });
  const embedded = f.api.dmvSaveConnection({ connectorId: 'ga4', label: 'Legacy', credentials: { propertyId: '123', authMode: 'token', accessToken: 'embedded-token' } });
  assert.equal(embedded.credentialId, null);
  assert.deepEqual(plain(f.api.dmvReadConnection_(embedded.id).credentials), { propertyId: '123', authMode: 'token', accessToken: 'embedded-token' });
  const credential = f.api.dmvSaveCredential({ family: 'google', label: 'Shared', values: { authMode: 'token', accessToken: 'shared-token' } });
  f.state.responses.push({ body: { accountSummaries: [{ propertySummaries: [{ property: 'properties/456', displayName: 'Second' }] }] } });
  const found = f.api.dmvDiscoverAccounts({ connectorId: 'ga4', credentialId: credential.id, credentials: {} });
  assert.deepEqual(plain(found.accounts.map((item) => item.credentials)), [{ propertyId: '456' }]);
  assert.equal(f.state.http[1].options.headers.Authorization, 'Bearer shared-token');
  f.state.responses.push({ body: { accountSummaries: [] } });
  assert.deepEqual(plain(f.api.dmvDiscoverAccounts({ id: embedded.id, connectorId: 'ga4', credentials: {} }).accounts), []);
  assert.equal(f.state.http[2].options.headers.Authorization, 'Bearer embedded-token', 'an edited legacy connection reuses its stored secrets');
});
