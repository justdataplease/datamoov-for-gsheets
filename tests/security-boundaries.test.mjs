import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatamoovSandbox, plain } from './helpers/datamoov-sandbox.mjs';

function tokenFixture() {
  const f = createDatamoovSandbox();
  f.api.Utilities.computeRsaSha256Signature = () => [1, 2, 3];
  const credentials = {
    authMode: 'service_account',
    serviceAccountJson: JSON.stringify({ type: 'service_account', client_email: 'fixture@example.test', private_key: 'offline-key' }),
  };
  return { ...f, token: () => f.api.dmvGoogleToken_(credentials, ['scope'], f.api.Date.now() + 240000) };
}

test('service-account exchanges reject malformed and already-expired access tokens', () => {
  for (const body of [{ access_token: {} }, { access_token: 'bad token' }, { access_token: 'valid', expires_in: 0 }, { access_token: 'valid', expires_in: -1 }]) {
    const f = tokenFixture();
    f.state.responses.push({ body });
    assert.throws(f.token, /valid access token|expired access token/);
    assert.equal(f.state.cache.data.size, 0);
  }
  const slow = tokenFixture();
  const fetch = slow.api.UrlFetchApp.fetch;
  slow.api.UrlFetchApp.fetch = (...args) => { slow.advance(2000); return fetch(...args); };
  slow.state.responses.push({ body: { access_token: 'valid', expires_in: 1 } });
  assert.throws(slow.token, /expired access token/);
  assert.equal(slow.state.cache.data.size, 0);
});

test('service-account cache failures are optional and only known lifetimes are cached', () => {
  const f = tokenFixture();
  f.state.cache.get = () => { throw new Error('Cache unavailable'); };
  f.state.cache.put = () => { throw new Error('Cache unavailable'); };
  f.state.responses.push({ body: { access_token: 'usable', expires_in: 3600 } });
  assert.equal(f.token(), 'usable');
  for (const expires_in of [undefined, '3600', 'unknown']) {
    const unknown = tokenFixture();
    unknown.state.responses.push({ body: { access_token: 'usable', expires_in } });
    assert.equal(unknown.token(), 'usable');
    assert.equal(unknown.state.cache.data.size, 0);
  }
  const timed = tokenFixture();
  let ttl;
  timed.state.cache.put = (key, value, seconds) => { ttl = seconds; };
  const fetch = timed.api.UrlFetchApp.fetch;
  timed.api.UrlFetchApp.fetch = (...args) => { timed.advance(2000); return fetch(...args); };
  timed.state.responses.push({ body: { access_token: 'usable', expires_in: 600 } });
  assert.equal(timed.token(), 'usable');
  assert.equal(ttl, 478);
});

test('OAuth access tokens remain cached after the provider rotates the refresh token', () => {
  const f = createDatamoovSandbox();
  const values = { clientId: 'client', clientSecret: 'secret', refreshToken: 'initial' };
  const provider = { label: 'Fixture', endpoint: 'https://provider.example/token' };
  f.state.responses.push({ body: { access_token: 'usable', expires_in: 3600, refresh_token: 'replacement' } });
  const token = () => f.api.dmvOAuthRefreshToken_(provider, values, f.api.Date.now() + 240000, (patch) => Object.assign(values, patch));
  assert.equal(token(), 'usable');
  assert.equal(values.refreshToken, 'replacement');
  assert.equal(token(), 'usable');
  assert.equal(f.state.http.length, 1);
});

function rotatingFixture(shared = false) {
  const f = createDatamoovSandbox();
  const connector = {
    id: 'rotation_fixture', label: 'Rotation fixture', reports: [], allowedHosts: [],
    authFields: [
      { key: 'account', label: 'Account', type: 'text', perConnection: true, required: true },
      { key: 'refreshToken', label: 'Refresh token', type: 'password', required: true },
      { key: 'clientSecret', label: 'Client secret', type: 'password', required: true },
    ],
    accountDiscovery: { label: 'Account', credentialKeys: ['account'] },
    discoverAccounts(ctx) {
      ctx.rotateCredentials({ refreshToken: 'discovery-replacement' });
      return [{ id: 'one', label: 'One', credentials: { account: 'one' } }];
    },
  };
  f.api.dmvRegisterConnector_(connector);
  const secrets = { refreshToken: 'initial-token', clientSecret: 'initial-secret' };
  const credential = shared ? f.api.dmvSaveCredential({ family: connector.id, label: 'Shared', values: secrets }) : null;
  const saved = f.api.dmvSaveConnection({ connectorId: connector.id, label: 'One', credentialId: credential?.id, credentials: { account: 'one', ...(!shared ? secrets : {}) } });
  const stored = () => f.api.dmvReadConnection_(saved.id);
  const context = () => f.api.dmvContext_(connector, stored(), {}, {});
  return { ...f, connector, saved, stored, context };
}

for (const shared of [false, true]) {
  test(`discovery persists reused ${shared ? 'shared' : 'embedded'} credential rotation but isolates unsaved edits`, () => {
    const f = rotatingFixture(shared);
    f.api.dmvDiscoverAccounts({ id: f.saved.id, connectorId: f.connector.id, credentials: {} });
    assert.equal(f.stored().credentials.refreshToken, 'discovery-replacement');
    f.connector.discoverAccounts = (ctx) => { ctx.rotateCredentials({ refreshToken: 'unsaved-replacement' }); return []; };
    f.api.dmvDiscoverAccounts({ id: f.saved.id, connectorId: f.connector.id, credentials: { refreshToken: 'unsaved-edit' } });
    assert.equal(f.stored().credentials.refreshToken, 'discovery-replacement');
  });

  test(`concurrent ${shared ? 'shared' : 'embedded'} rotations cannot overwrite or mix newer saved secrets`, () => {
    const f = rotatingFixture(shared);
    const first = f.context(), stale = f.context();
    first.rotateCredentials({ refreshToken: 'new-token', account: 'must-not-change' });
    stale.rotateCredentials({ clientSecret: 'stale-secret', refreshToken: 'stale-token' });
    assert.equal(f.stored().credentials.refreshToken, 'new-token');
    assert.equal(f.stored().credentials.clientSecret, 'initial-secret');
    assert.equal(f.stored().credentials.account, 'one');
    assert.equal(stale.credentials.refreshToken, 'stale-token', 'the running execution can use its own replacement');
    const older = f.context(), newer = f.context();
    newer.rotateCredentials({ clientSecret: 'new-secret' });
    older.rotateCredentials({ refreshToken: 'mixed-token' });
    assert.equal(f.stored().credentials.refreshToken, 'new-token');
    assert.equal(f.stored().credentials.clientSecret, 'new-secret');
    assert.equal(f.stored().revision, 1);
    if (shared) assert.equal(f.stored().credentialRevision, 1);
    assert.deepEqual(plain(f.api.dmvRead_('connection', f.saved.id).credentials), shared ? { account: 'one' } : { account: 'one', refreshToken: 'new-token', clientSecret: 'new-secret' });
  });
}

test('connection failures redact declared short secrets without obscuring nonsecret account names', () => {
  const f = rotatingFixture();
  f.connector.test = (ctx) => { throw new Error('Account one rejected secret ' + ctx.credentials.refreshToken); };
  assert.throws(() => f.api.dmvSaveConnection({ connectorId: f.connector.id, label: 'Bad', credentials: { account: 'one', refreshToken: 'abcde', clientSecret: 'xyz' } }), (error) => {
    assert.match(error.message, /Account one rejected secret \[redacted\]/);
    assert.doesNotMatch(error.message, /abcde/);
    return true;
  });
});
