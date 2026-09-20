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
    accountDiscovery: { label: 'Account', credentialKeys: ['account'] },
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

test('service account is the default mode, a missing key fails before any check, and switching modes rechecks', () => {
  const f = fixture();
  assert.throws(
    () => f.api.dmvSaveConnection({ connectorId: 'orchard', label: 'Key', credentials: { account: '1234567890' } }),
    /Service account JSON is required/
  );
  assert.equal(f.checked.length, 0);
  const key = JSON.stringify({ type: 'service_account', client_email: 'robot@example.iam.gserviceaccount.com', private_key: 'offline-key' });
  const saved = f.api.dmvSaveConnection({
    connectorId: 'orchard',
    label: 'Key',
    credentials: { account: '1234567890', serviceAccountJson: key },
  });
  assert.equal(saved.values.authMode, 'service_account');
  assert.equal(saved.values.serviceAccountJson, undefined);
  assert.ok(saved.configuredFields.includes('serviceAccountJson'));
  assert.equal(saved.verified, true);
  assert.equal(f.checked.length, 1);
  const own = f.api.dmvSaveConnection({ ...f.input(), id: saved.id });
  assert.equal(own.values.authMode, 'oauth');
  assert.equal(f.checked.length, 2);
  assert.equal(f.checked[1].account, saved.values.account);
  assert.equal(f.api.dmvSaveConnection({ ...f.input(), id: saved.id, label: 'Renamed' }).verified, false);
});

test('a connector can rotate a saved secret during a run; the revision stays and stale rotations are dropped', () => {
  const f = createDatamoovSandbox();
  let rotateTo = 'rotated-during-check';
  f.api.dmvRegisterConnector_({
    id: 'rotating', label: 'Rotating', reports: [{ id: 'r', label: 'R', fields: [{ key: 'n', label: 'N', type: 'number' }], dateRange: false,
      fetch(ctx) { ctx.rotateCredentials({ refreshToken: rotateTo, account: 'must-not-change', bogus: 'ignored' }); return { columns: this.fields, rows: [{ n: 1 }], metadata: { complete: true } }; } }],
    allowedHosts: [],
    authFields: [{ key: 'account', label: 'Account', type: 'text', required: true },
      { key: 'refreshToken', label: 'Refresh token', type: 'password', secret: true, required: true }],
    test(ctx) { ctx.rotateCredentials({ refreshToken: rotateTo }); },
  });
  const saved = f.api.dmvSaveConnection({ connectorId: 'rotating', label: 'Rotating account', credentials: { account: 'one', refreshToken: 'initial' } });
  assert.equal(f.api.dmvRead_('connection', saved.id).credentials.refreshToken, 'rotated-during-check', 'the check rotated the token before it was stored');
  assert.equal(f.api.dmvRead_('connection', saved.id).revision, 1);
  const report = f.api.dmvSaveReport({ connectionId: saved.id, name: 'Rotate', reportType: 'r', fields: ['n'], config: {}, maxRows: 10,
    target: { sheetName: 'Output', startCell: 'A1' }, schedule: 'manual' });
  rotateTo = 'rotated-during-run';
  assert.equal(f.api.dmvRunReport(report.id).ok, true);
  const stored = f.api.dmvRead_('connection', saved.id);
  assert.equal(stored.credentials.refreshToken, 'rotated-during-run');
  assert.equal(stored.credentials.account, 'one', 'only secret fields rotate');
  assert.equal(stored.credentials.bogus, undefined);
  assert.equal(stored.revision, 1, 'a rotation is not an edit');
  // A rotation from a stale in-memory connection (edited meanwhile) is ignored.
  const stale = { id: saved.id, revision: 0, credentials: { account: 'one', refreshToken: 'x' } };
  f.api.dmvRotateCredentials_(stale, { refreshToken: 'from-stale-run' });
  assert.equal(f.api.dmvRead_('connection', saved.id).credentials.refreshToken, 'rotated-during-run');
  assert.ok(!JSON.stringify(f.api.dmvBootstrap()).includes('rotated-during-run'));
});
