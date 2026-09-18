import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatamoovSandbox, plain } from './helpers/datamoov-sandbox.mjs';

const credentials = () => ({
  account: '1234567890',
  authMode: 'oauth',
  clientId: 'offline-client.apps.googleusercontent.com',
  clientSecret: 'offline-client-secret',
  refreshToken: 'offline-refresh-token',
});

function fixture(withTest = true) {
  const sandbox = createDatamoovSandbox();
  const checked = [];
  const connector = {
    id: 'orchard',
    label: 'Orchard',
    reports: [],
    allowedHosts: ['orchard.example'],
    googleScopes: ['offline-scope'],
    authFields: [
      { key: 'account', label: 'Account', type: 'text', required: true },
      ...sandbox.api.dmvGoogleAuthFields_(),
    ],
    accountDiscovery: {
      label: 'Account',
      credentialKeys: ['account'],
      showWhen: { key: 'authMode', value: 'native' },
    },
  };
  if (withTest) connector.test = (context) => checked.push(plain(context.credentials));
  sandbox.api.dmvRegisterConnector_(connector);
  return {
    ...sandbox,
    connector,
    checked,
    input: () => ({ connectorId: 'orchard', label: 'Own OAuth', credentials: credentials() }),
  };
}

test('manual OAuth validates required fields and tests access before persisting a connection', () => {
  const f = fixture();
  for (const key of ['clientId', 'clientSecret', 'refreshToken']) {
    for (const value of ['', '  ', null, {}]) {
      const input = f.input();
      input.credentials[key] = value;
      assert.throws(() => f.api.dmvSaveConnection(input), /required/);
    }
  }
  assert.equal(f.checked.length, 0);
  assert.equal(f.state.user.data.size, 0);
  const saved = f.api.dmvSaveConnection(f.input());
  assert.equal(f.checked.length, 1);
  assert.equal(saved.values.authMode, 'oauth');
  assert.equal(saved.values.clientId, credentials().clientId);
  assert.equal(saved.values.clientSecret, undefined);
  assert.equal(saved.values.refreshToken, undefined);
  assert.ok(saved.configuredFields.includes('clientSecret'));
  assert.ok(saved.configuredFields.includes('refreshToken'));
  assert.doesNotMatch(
    JSON.stringify(f.api.dmvBootstrap()),
    /offline-client-secret|offline-refresh-token/
  );
});

test('saved OAuth secrets are retained on blank edits, while actual credential changes are rechecked', () => {
  const f = fixture();
  const saved = f.api.dmvSaveConnection(f.input());
  const edit = {
    ...f.input(),
    id: saved.id,
    label: 'Renamed',
    credentials: { ...credentials(), clientSecret: '', refreshToken: '' },
  };
  f.api.dmvSaveConnection(edit);
  assert.equal(f.checked.length, 1);
  assert.equal(
    f.api.dmvRead_('connection', saved.id).credentials.refreshToken,
    credentials().refreshToken
  );
  f.api.dmvSaveConnection({
    ...edit,
    credentials: { ...edit.credentials, refreshToken: 'rotated-offline-refresh' },
  });
  assert.equal(f.checked.length, 2);
  assert.equal(f.checked[1].refreshToken, 'rotated-offline-refresh');
  const before = JSON.stringify(f.api.dmvRead_('connection', saved.id));
  f.connector.test = (context) => {
    throw new Error(
      'Rejected ' + context.credentials.clientSecret + ' ' + context.credentials.refreshToken
    );
  };
  assert.throws(
    () =>
      f.api.dmvSaveConnection({
        ...edit,
        credentials: { ...edit.credentials, clientSecret: 'rejected-offline-secret' },
      }),
    (error) => {
      assert.doesNotMatch(error.message, /rejected-offline-secret|rotated-offline-refresh/);
      return /redacted/.test(error.message);
    }
  );
  assert.equal(JSON.stringify(f.api.dmvRead_('connection', saved.id)), before);
  assert.throws(() => fixture().api.dmvSaveConnection(edit), /no longer exists/);
});

test('OAuth provider rejection never saves a new connection and native mode is not a fallback', () => {
  const f = fixture();
  f.connector.test = () => {
    throw new Error('Provider denied account');
  };
  f.api.ScriptApp.getOAuthToken = () => {
    throw new Error('Native fallback must not be used');
  };
  assert.throws(() => f.api.dmvSaveConnection(f.input()), /Provider denied account/);
  assert.equal(f.state.user.data.size, 0);
});

test('OAuth-only connectors validate a token without inventing report configuration or dataset access', () => {
  const f = fixture(false);
  let exchanges = 0;
  f.api.dmvGoogleToken_ = (input, scopes) => {
    assert.equal(input.authMode, 'oauth');
    assert.deepEqual(plain(scopes), ['offline-scope']);
    exchanges++;
    return 'offline-access-token';
  };
  const saved = f.api.dmvSaveConnection(f.input());
  assert.equal(exchanges, 1);
  f.api.dmvSaveConnection({ ...f.input(), id: saved.id, label: 'Rename only' });
  assert.equal(exchanges, 1);
});

test('manual OAuth keeps referenced account identity and active-run locks intact', () => {
  const f = fixture();
  const saved = f.api.dmvSaveConnection(f.input());
  f.api.dmvSave_('report', { id: 'report-one', connectionId: saved.id });
  assert.throws(
    () =>
      f.api.dmvSaveConnection({
        ...f.input(),
        id: saved.id,
        credentials: { ...credentials(), account: '9999999999' },
      }),
    /new connection/
  );
  assert.equal(f.checked.length, 1);
  f.api.dmvSave_('report', {
    id: 'report-one',
    connectionId: saved.id,
    runToken: 'active',
    startedAt: f.api.Date.now(),
  });
  assert.throws(
    () =>
      f.api.dmvSaveConnection({
        ...f.input(),
        id: saved.id,
        credentials: { ...credentials(), refreshToken: 'rotated-token' },
      }),
    /current refresh/
  );
  assert.equal(f.checked.length, 1);
  assert.equal(f.state.batches.length, 0);
});

test('existing native mode remains the default and can switch to OAuth only after an access check', () => {
  const f = fixture();
  const saved = f.api.dmvSaveConnection({
    connectorId: 'orchard',
    label: 'Native',
    credentials: { account: '1234567890' },
  });
  assert.equal(saved.values.authMode, 'native');
  assert.equal(f.checked.length, 1);
  const own = f.api.dmvSaveConnection({ ...f.input(), id: saved.id });
  assert.equal(own.values.authMode, 'oauth');
  assert.equal(f.checked.length, 2);
  assert.equal(f.checked[1].account, saved.values.account);
});
