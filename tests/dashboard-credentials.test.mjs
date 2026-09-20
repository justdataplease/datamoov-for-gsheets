import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatamoovSandbox, plain } from './helpers/datamoov-sandbox.mjs';

function fixture(saveDashboard = true) {
  const f = createDatamoovSandbox();
  f.verifications = [];
  const columns = [{ key: 'value', type: 'number', role: 'metric' }];
  f.api.dmvRegisterConnector_({
    id: 'guarded_source',
    label: 'Guarded source',
    category: 'Test',
    allowedHosts: [],
    authFields: [
      { key: 'account', label: 'Account', type: 'text', required: true, perConnection: true },
      { key: 'token', label: 'Token', type: 'password', required: true },
    ],
    connectionKeys: ['account'],
    test(ctx) {
      f.verifications.push({ ...ctx.credentials });
      if (f.rejectAccount === ctx.credentials.account)
        throw new Error('Account rejected credential ' + ctx.credentials.token);
    },
    reports: [
      {
        id: 'rows',
        label: 'Rows',
        fields: columns,
        dateRange: false,
        fetch(ctx) {
          if (f.onFetch) f.onFetch(ctx);
          return { columns, rows: [{ value: 1 }], metadata: { complete: true } };
        },
      },
    ],
  });
  f.credential = f.api.dmvSaveCredential({
    family: 'guarded_source',
    label: 'Shared token',
    values: { token: 'initial-private-token' },
  });
  f.connections = ['one', 'two'].map((account) =>
    f.api.dmvSaveConnection({
      connectorId: 'guarded_source',
      label: account,
      credentialId: f.credential.id,
      credentials: { account },
    })
  );
  f.input = {
    name: 'Guarded dashboard',
    sources: f.connections.map((connection, index) => ({
      connectionId: connection.id,
      label: 'Source ' + index,
      reportType: 'rows',
      fields: ['value'],
      config: {},
      maxRows: 10,
      mapping: [{ field: 'value', key: 'value' }],
    })),
    summary: { groupBy: ['source'], metrics: [{ field: 'value', agg: 'sum' }], limit: 10 },
    dataTarget: { sheetName: 'Raw', startCell: 'A1' },
    target: { sheetName: 'Summary', startCell: 'A1' },
  };
  f.dashboard = saveDashboard ? f.api.dmvSaveDashboard(f.input) : null;
  f.verifications.length = 0;
  f.connectionInput = (index, patch = {}) => ({
    id: f.connections[index].id,
    connectorId: 'guarded_source',
    label: f.connections[index].label,
    credentialId: f.credential.id,
    credentials: { account: ['one', 'two'][index] },
    ...patch,
  });
  f.credentialInput = (token = 'new-private-token') => ({
    id: f.credential.id,
    family: 'guarded_source',
    label: 'Shared token',
    values: { token },
  });
  return f;
}

test('dormant dashboards block source retargeting and deletion across the same user account workbooks', () => {
  const f = fixture();
  const before = plain(f.api.dmvRead_('connection', f.connections[0].id));
  const otherBook = f.addSpreadsheet('other-book', ['Sheet']);
  f.setActive(otherBook);
  assert.throws(
    () => f.api.dmvSaveConnection(f.connectionInput(0, { credentials: { account: 'redirected' } })),
    /saved reports or dashboards/
  );
  assert.throws(() => f.api.dmvDeleteConnection(f.connections[0].id), /reports and dashboards/);
  assert.throws(() => f.api.dmvDeleteCredential(f.credential.id), /used by/);
  assert.deepEqual(plain(f.api.dmvRead_('connection', f.connections[0].id)), before);
  assert.equal(f.verifications.length, 0, 'blocked edits never contact the provider');
  assert.equal(f.state.batches.length, 0);
});

test('an active dashboard blocks changed source credentials but permits a credential label-only edit', () => {
  const f = fixture();
  const beforeConnection = plain(f.api.dmvRead_('connection', f.connections[0].id));
  const beforeCredential = plain(f.api.dmvRead_('credential', f.credential.id));
  let checked = false;
  f.onFetch = () => {
    if (checked) return;
    checked = true;
    assert.throws(
      () => f.api.dmvSaveConnection(f.connectionInput(0, { label: 'Renamed connection' })),
      /current refresh/
    );
    assert.throws(() => f.api.dmvSaveCredential(f.credentialInput()), /current refresh/);
    assert.throws(() => f.api.dmvDeleteConnection(f.connections[0].id), /reports and dashboards/);
    const renamed = f.api.dmvSaveCredential({
      ...f.credentialInput(''),
      label: 'Readable credential label',
    });
    assert.equal(renamed.verified, false);
    const current = f.api.dmvRead_('credential', f.credential.id);
    assert.equal(current.revision, beforeCredential.revision);
    assert.equal(current.values.token, beforeCredential.values.token);
  };
  assert.equal(f.api.dmvRunDashboard(f.dashboard.id).ok, true);
  assert.equal(checked, true);
  assert.deepEqual(plain(f.api.dmvRead_('connection', f.connections[0].id)), beforeConnection);
  assert.equal(f.verifications.length, 0);
  assert.equal(f.state.batches.length, 1);
});

test('credential replacements verify every dashboard source and keep the old secret if an account rejects it', () => {
  const f = fixture();
  const before = plain(f.api.dmvRead_('credential', f.credential.id));
  f.rejectAccount = 'two';
  assert.throws(
    () => f.api.dmvSaveCredential(f.credentialInput()),
    (error) => {
      assert.match(error.message, /Could not verify connection/);
      assert.equal(error.message.includes('new-private-token'), false);
      return true;
    }
  );
  assert.deepEqual(
    f.verifications.map((item) => item.account),
    ['one', 'two']
  );
  assert.deepEqual(plain(f.api.dmvRead_('credential', f.credential.id)), before);
  f.rejectAccount = null;
  f.verifications.length = 0;
  const saved = f.api.dmvSaveCredential(f.credentialInput());
  assert.equal(saved.verified, true);
  assert.deepEqual(
    f.verifications.map((item) => item.account),
    ['one', 'two']
  );
  assert.equal(f.api.dmvRead_('credential', f.credential.id).revision, before.revision + 1);
  assert.equal(
    f.api.dmvReadConnection_(f.connections[0].id).credentials.token,
    'new-private-token'
  );
  assert.equal(f.state.batches.length, 0);
});

test('expired dashboard leases allow credential replacement but still protect saved source identity', () => {
  const f = fixture();
  const record = f.api.dmvRead_('dashboard', f.dashboard.id);
  Object.assign(record, {
    status: 'running',
    runToken: 'expired',
    startedAt: f.api.Date.now() - 300001,
  });
  f.api.dmvSave_('dashboard', record);
  assert.equal(f.api.dmvSaveCredential(f.credentialInput()).verified, true);
  assert.throws(
    () => f.api.dmvSaveConnection(f.connectionInput(0, { credentials: { account: 'different' } })),
    /saved reports or dashboards/
  );
  assert.throws(() => f.api.dmvDeleteConnection(f.connections[0].id), /reports and dashboards/);
});

test('dashboard usage is private to one user and deleting its definition releases source guards', () => {
  const owner = fixture(),
    other = fixture(false);
  assert.equal(
    owner.connections[0].id,
    other.connections[0].id,
    'colliding fixture IDs still belong to separate users'
  );
  other.api.dmvDeleteConnection(other.connections[0].id);
  assert.throws(
    () => owner.api.dmvDeleteConnection(owner.connections[0].id),
    /reports and dashboards/
  );
  owner.api.dmvDeleteDashboard(owner.dashboard.id);
  const changed = owner.api.dmvSaveConnection(
    owner.connectionInput(0, { credentials: { account: 'different' } })
  );
  assert.equal(changed.values.account, 'different');
  owner.api.dmvDeleteConnection(owner.connections[0].id);
  owner.api.dmvDeleteConnection(owner.connections[1].id);
  assert.equal(owner.api.dmvDeleteCredential(owner.credential.id).ok, true);
  assert.equal(owner.state.batches.length, 0);
});
