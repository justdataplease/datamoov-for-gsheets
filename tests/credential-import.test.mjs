import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createDatamoovSandbox, plain } from './helpers/datamoov-sandbox.mjs';

function fixture(onCheck) {
  const f = createDatamoovSandbox();
  f.checks = [];
  f.api.dmvRegisterConnector_({
    id: 'import_source',
    label: 'Import source',
    allowedHosts: [],
    authFields: [
      {
        key: 'authMode',
        label: 'Mode',
        type: 'select',
        default: 'token',
        options: ['token', 'other'],
      },
      {
        key: 'token',
        label: 'Token',
        type: 'password',
        required: true,
        showWhen: { key: 'authMode', value: 'token' },
      },
      {
        key: 'otherSecret',
        label: 'Other secret',
        type: 'password',
        required: true,
        showWhen: { key: 'authMode', value: 'other' },
      },
      { key: 'account', label: 'Account', type: 'text', required: true, perConnection: true },
    ],
    test(ctx) {
      f.checks.push({ account: ctx.credentials.account, deadline: ctx.deadline });
      if (ctx.credentials.account === 'blocked')
        throw new Error('Provider denied private-token-one and RAW_PROVIDER_PAYLOAD');
      if (onCheck) onCheck(f, ctx);
    },
    reports: [{ id: 'rows', label: 'Rows', fields: [{ key: 'n', type: 'number' }], fetch() {} }],
  });
  return f;
}

function bundle(accounts = ['one', 'two']) {
  return {
    version: 1,
    credentials: [
      {
        ref: 'main',
        label: 'Imported token',
        family: 'import_source',
        values: { token: 'private-token-one' },
      },
    ],
    connections: accounts.map((account, index) => ({
      ref: 'connection-' + index,
      label: 'Account ' + account,
      connectorId: 'import_source',
      credentialRef: 'main',
      credentials: { account },
    })),
  };
}

test('the downloadable sample is a valid bundle the importer accepts end to end', () => {
  const f = fixture();
  const sample = f.api.dmvCredentialSample();
  const bundle = JSON.parse(sample.json);
  // The sample is generated from the registry, so it must satisfy the importer's own schema.
  assert.doesNotThrow(() => f.api.dmvImportPlan_(bundle));
  assert.deepEqual(
    bundle.connections.map((connection) => connection.connectorId),
    ['import_source']
  );
  const credential = bundle.credentials[0];
  assert.equal(credential.family, 'import_source');
  // Hidden alternatives are included so a user can switch mode by editing the file alone.
  assert.deepEqual(Object.keys(credential.values).sort(), ['authMode', 'otherSecret', 'token']);
  assert.equal(credential.values.authMode, 'token');
  assert.match(credential.values.token, /^REPLACE_/);
  assert.deepEqual(Object.keys(bundle.connections[0].credentials), ['account']);
  const result = plain(f.api.dmvImportCredentials(bundle));
  assert.equal(result.credentials[0].status, 'saved');
  assert.equal(result.connections[0].status, 'saved');
  assert.equal(f.checks.length, 1, 'the sample connection is checked like any other import');
});

test('import shares private credentials, checks each new account, and is idempotent during active runs', () => {
  const f = fixture();
  const first = f.api.dmvImportCredentials(bundle());
  assert.deepEqual(plain(first.summary), {
    credentials: { saved: 1, existing: 0, failed: 0 },
    connections: { saved: 2, existing: 0, failed: 0 },
  });
  const credential = first.credentials[0];
  assert.equal(credential.verified, false);
  assert.equal(f.checks.length, 2);
  const storedConnections = f.api.dmvList_('connection');
  assert.ok(storedConnections.every((connection) => connection.credentialId === credential.id));
  assert.ok(
    storedConnections.every((connection) => !Object.hasOwn(connection.credentials, 'token'))
  );
  f.api.dmvSave_('report', {
    id: 'running',
    connectionId: first.connections[0].id,
    runToken: 'active',
    startedAt: f.api.Date.now(),
  });
  const before = f.state.user.getProperties();
  const second = f.api.dmvImportCredentials(bundle());
  assert.deepEqual(plain(second.summary), {
    credentials: { saved: 0, existing: 1, failed: 0 },
    connections: { saved: 0, existing: 2, failed: 0 },
  });
  assert.deepEqual(f.state.user.getProperties(), before);
  assert.equal(f.checks.length, 2);
  assert.equal(second.credentials[0].id, credential.id);
  assert.deepEqual(
    plain(second.connections.map((item) => item.id)),
    plain(first.connections.map((item) => item.id))
  );
  assert.ok(!JSON.stringify(first).includes('private-token-one'));
  assert.deepEqual(f.state.script.getProperties(), {});
  assert.deepEqual(f.state.document.getProperties(), {});
});

test('every structural error is rejected before any provider action or settings write', () => {
  const invalid = [
    (b) => {
      b.connections[1].credentials.unknown = 'do not echo this';
    },
    (b) => {
      b.credentials[0].values.token = { nested: 'secret' };
    },
    (b) => {
      b.connections[1].credentialRef = 'missing';
    },
    (b) => {
      b.credentials.push({ ...b.credentials[0] });
    },
    (b) => {
      b.credentials[0].ref = 'constructor';
    },
    (b) => {
      b.connections[1].ref = b.connections[0].ref;
    },
    (b) => {
      b.credentials[0].values = JSON.parse('{"token":"x","__proto__":{"polluted":true}}');
    },
    (b) => {
      b.connections[1].credentials = { account: 'two', token: 'not-per-connection' };
    },
    (b) => {
      b.connections[1].credentials.account = '';
    },
    (b) => {
      b.version = 2;
    },
    (b) => {
      b.credentials = Array.from({ length: 21 }, (_, i) => ({
        ...b.credentials[0],
        ref: 'ref-' + i,
      }));
    },
  ];
  for (const alter of invalid) {
    const f = fixture(),
      input = bundle();
    alter(input);
    assert.throws(() => f.api.dmvImportCredentials(input));
    assert.deepEqual(f.state.user.getProperties(), {});
    assert.equal(f.checks.length, 0);
    assert.equal(f.state.http.length, 0);
  }
});

test('UTF-8 byte size is enforced before saves', () => {
  const f = fixture();
  const input = bundle([]);
  input.credentials = Array.from({ length: 20 }, (_, i) => ({
    ref: 'ref-' + i,
    label: 'Token',
    family: 'import_source',
    values: { token: String.fromCodePoint(0x6f22).repeat(5000) },
  }));
  assert.ok(JSON.stringify(input).length < 250000);
  assert.throws(() => f.api.dmvImportCredentials(input), /250,000 bytes/);
  assert.deepEqual(f.state.user.getProperties(), {});
});

test('one provider rejection preserves successful items and never returns a secret or provider payload', () => {
  const f = fixture();
  const result = f.api.dmvImportCredentials(bundle(['one', 'blocked', 'three']));
  assert.deepEqual(plain(result.connections.map((item) => item.status)), [
    'saved',
    'failed',
    'saved',
  ]);
  assert.equal(result.connections[1].code, 'verification_failed');
  assert.equal(f.api.dmvList_('credential').length, 1);
  assert.equal(f.api.dmvList_('connection').length, 2);
  assert.equal(f.checks.length, 3);
  assert.ok(!JSON.stringify(result).includes('private-token-one'));
  assert.ok(!JSON.stringify(result).includes('RAW_PROVIDER_PAYLOAD'));
  assert.match(result.connections[1].message, /access policy/);
});

test('a matching label with different credentials creates isolated records without changing report bindings', () => {
  const f = fixture();
  const first = f.api.dmvImportCredentials(bundle(['one']));
  const oldCredential = plain(f.api.dmvRead_('credential', first.credentials[0].id));
  const oldConnection = plain(f.api.dmvRead_('connection', first.connections[0].id));
  f.api.dmvSave_('report', { id: 'bound', connectionId: oldConnection.id });
  const input = bundle(['one']);
  input.credentials[0].values.token = 'different-private-token';
  const second = f.api.dmvImportCredentials(input);
  assert.notEqual(second.credentials[0].id, oldCredential.id);
  assert.notEqual(second.connections[0].id, oldConnection.id);
  assert.notEqual(second.credentials[0].label, oldCredential.label);
  assert.deepEqual(plain(f.api.dmvRead_('credential', oldCredential.id)), oldCredential);
  assert.deepEqual(plain(f.api.dmvRead_('connection', oldConnection.id)), oldConnection);
  assert.equal(f.api.dmvRead_('report', 'bound').connectionId, oldConnection.id);
});

test('inactive secrets are neither saved nor used for duplicate matching', () => {
  const f = fixture();
  const input = bundle(['one']);
  input.credentials[0].values.otherSecret = 'unused-private-secret';
  const first = f.api.dmvImportCredentials(input);
  const saved = f.api.dmvRead_('credential', first.credentials[0].id);
  assert.equal(saved.values.authMode, 'token');
  assert.equal(saved.values.otherSecret, undefined);
  input.credentials[0].values.otherSecret = 'a-different-unused-value';
  const repeated = f.api.dmvImportCredentials(input);
  assert.equal(repeated.credentials[0].status, 'existing');
  assert.equal(repeated.connections[0].status, 'existing');
  assert.equal(f.checks.length, 1);
});

test('shared deadline reaches normal connection contexts and unstarted items remain resumable', () => {
  const f = fixture((runtime) => runtime.advance(191000));
  const started = f.api.Date.now();
  const result = f.api.dmvImportCredentials(bundle(['one', 'two', 'three']));
  assert.equal(f.checks[0].deadline, started + 200000);
  assert.deepEqual(plain(result.connections.map((item) => item.status)), [
    'saved',
    'failed',
    'failed',
  ]);
  assert.equal(result.connections[1].code, 'time_limit');
  assert.equal(f.checks.length, 1);
  assert.equal(f.api.dmvList_('connection').length, 1);
});

test('concurrent credential edits cannot silently change the grant for later imported connections', () => {
  const f = fixture((runtime) => {
    const credential = runtime.api.dmvList_('credential')[0];
    credential.revision++;
    credential.values.token = 'changed-outside-import';
    runtime.api.dmvSave_('credential', credential);
  });
  const result = f.api.dmvImportCredentials(bundle(['one', 'two']));
  assert.equal(result.connections[0].status, 'saved');
  assert.equal(result.connections[1].code, 'credential_changed');
  assert.equal(f.checks.length, 1);
});

test('separate executing users cannot reuse the settings of another user', () => {
  const first = fixture(),
    second = fixture();
  first.api.dmvImportCredentials(bundle());
  assert.deepEqual(second.state.user.getProperties(), {});
  const result = second.api.dmvImportCredentials(bundle());
  assert.equal(result.summary.credentials.saved, 1);
  assert.equal(result.summary.connections.saved, 2);
  assert.equal(second.checks.length, 2);
});

test('a failed OAuth exchange blocks only its dependent connections and returns no provider text', () => {
  const f = fixture();
  new vm.Script(
    readFileSync(new URL('../src/connectors/google_ads.js', import.meta.url), 'utf8')
  ).runInContext(f.api);
  const input = bundle(['one']);
  input.credentials.unshift({
    ref: 'google-grant',
    label: 'Ads OAuth',
    family: 'google',
    values: {
      authMode: 'oauth',
      clientId: 'offline-client',
      clientSecret: 'offline-client-secret',
      refreshToken: 'offline-refresh-secret',
    },
  });
  input.connections.unshift({
    ref: 'ads-account',
    label: 'Ads account',
    connectorId: 'google_ads',
    credentialRef: 'google-grant',
    credentials: { customerId: '1234567890' },
  });
  f.state.responses.push({
    code: 400,
    body: { error: 'invalid_grant', error_description: 'RAW_OAUTH_PAYLOAD offline-refresh-secret' },
  });
  const result = f.api.dmvImportCredentials(input);
  assert.deepEqual(plain(result.credentials.map((item) => item.status)), ['failed', 'saved']);
  assert.equal(result.connections[0].code, 'credential_unavailable');
  assert.equal(result.connections[1].status, 'saved');
  assert.equal(f.state.http.length, 1);
  assert.equal(f.api.dmvList_('credential').length, 1);
  assert.ok(!JSON.stringify(result).includes('RAW_OAUTH_PAYLOAD'));
  assert.ok(!JSON.stringify(result).includes('offline-refresh-secret'));
});

test('busy lock waits stop at the shared import deadline before acquiring another lock', () => {
  const f = fixture();
  let attempts = 0;
  f.api.LockService.getUserLock = () => ({
    tryLock(milliseconds) {
      assert.equal(milliseconds, 10000);
      attempts++;
      f.advance(10000);
      return false;
    },
    releaseLock() {
      throw new Error('A failed lock must not be released');
    },
  });
  const input = bundle([]);
  input.credentials = Array.from({ length: 20 }, (_, index) => ({
    ref: 'credential-' + index,
    label: 'Credential ' + index,
    family: 'import_source',
    values: { token: 'private-token-' + index },
  }));
  input.connections = Array.from({ length: 20 }, (_, index) => ({
    ref: 'connection-' + index,
    label: 'Connection ' + index,
    connectorId: 'import_source',
    credentialRef: 'credential-' + index,
    credentials: { account: 'account-' + index },
  }));
  const started = f.api.Date.now();
  const result = f.api.dmvImportCredentials(input);
  assert.equal(attempts, 20);
  assert.equal(f.api.Date.now() - started, 200000);
  assert.ok(result.credentials.every((item) => item.status === 'failed' && item.code === 'busy'));
  assert.ok(
    result.connections.every((item) => item.status === 'failed' && item.code === 'time_limit')
  );
  assert.deepEqual(f.state.user.getProperties(), {});
  assert.equal(f.checks.length, 0);
});
