import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createDatamoovSandbox, plain } from './helpers/datamoov-sandbox.mjs';

function fixture() {
  const f = createDatamoovSandbox();
  const columns = [{ key: 'n', label: 'Number', type: 'number', default: true },
    { key: 'flag', label: 'Flag', default: true }, { key: 'text', label: 'Text', default: true }];
  let total = 3, hook = null;
  const calls = [];
  const fetchChunk = (ctx, state) => {
    const offset = state ? state.offset : 0;
    calls.push({ offset, startDate: ctx.startDate, endDate: ctx.endDate });
    const chunk = { columns, rows: [{ n: offset, flag: false, text: '=private-row-' + offset }],
      nextState: offset + 1 < total ? { offset: offset + 1 } : null,
      metadata: { complete: offset + 1 >= total } };
    if (hook) hook(ctx, state, chunk);
    return chunk;
  };
  f.api.dmvRegisterConnector_({ id: 'arbitrary', label: 'Arbitrary', allowedHosts: ['example.test'],
    authFields: [{ key: 'token', label: 'Token', type: 'password', required: true }],
    reports: [{ id: 'rows', label: 'Rows', fields: columns, dateRange: true, configFields: [],
      fetchChunk, fetch: (ctx) => f.api.dmvFetchChunks_(ctx, fetchChunk) }] });
  const connection = f.api.dmvSaveConnection({ connectorId: 'arbitrary', label: 'Private account',
    credentials: { token: 'sensitive-test-token' } });
  const input = { connectionId: connection.id, name: 'Rows', reportType: 'rows', maxRows: 100,
    dateRange: { preset: 'last7' }, target: { sheetName: 'Output', startCell: 'A1' } };
  f.api.DMV_CONTINUATION.chunksPerExecution = 1;
  return { ...f, connection, input, calls, save: (extra = {}) => f.api.dmvSaveReport({ ...input, ...extra }),
    setTotal: (n) => { total = n; }, setHook: (fn) => { hook = fn; },
    chunks: () => [...f.state.user.data.keys()].filter((key) => key.startsWith('dmv:v1:chunk:')) };
}

test('saved runs pause privately and resume without replay, writing literal values once at completion', () => {
  const f = fixture(), report = f.save();
  const foreign = f.addTrigger('someoneElsesJob');
  for (let count = 1; count < 3; count++) {
    const pending = f.api.dmvRunReport(report.id);
    assert.equal(pending.pending, true);
    assert.equal(pending.rowCount, count);
    assert.equal(f.readReport(report.id).status, 'paused');
    assert.equal(f.readReport(report.id).runToken, null);
    assert.equal(f.state.batches.length, 0);
    assert.equal(f.state.user.getProperty('dmv:v1:output:' + f.book.id + ':' + report.id), null);
    assert.ok(f.chunks().length);
    const visible = JSON.stringify(f.api.dmvBootstrap());
    assert.ok(!visible.includes('private-row'));
    assert.ok(!visible.includes('sensitive-test-token'));
    const snapshot = f.api.dmvReadContinuation_(f.readReport(report.id));
    assert.ok(!JSON.stringify(snapshot).includes('sensitive-test-token'));
    assert.equal(f.state.script.data.size, 0);
    assert.equal(f.state.document.data.size, 0);
  }
  assert.equal(f.api.dmvRunReport(report.id).rowCount, 3);
  assert.deepEqual(f.calls.map((call) => call.offset), [0, 1, 2]);
  assert.equal(f.state.batches.length, 1);
  assert.equal(f.value(f.book.sheets[0], 2, 1), 0);
  assert.equal(f.value(f.book.sheets[0], 2, 2), false);
  assert.equal(f.value(f.book.sheets[0], 2, 3), '=private-row-0');
  assert.equal(f.formula(f.book.sheets[0], 2, 3), '');
  assert.deepEqual(f.chunks(), []);
  assert.deepEqual(f.state.triggers, [foreign]);
  assert.equal(f.readReport(report.id).status, 'success');
  assert.equal(f.readReport(report.id).fetchedRowCount, undefined);
});

test('continuation freezes relative dates across midnight and next full run resolves a new window', () => {
  const f = fixture(), report = f.save();
  f.api.dmvRunReport(report.id);
  f.advance(12 * 3600000);
  f.api.dmvRunReport(report.id);
  f.api.dmvRunReport(report.id);
  assert.deepEqual(f.calls.map((call) => call.endDate), ['2026-09-17', '2026-09-17', '2026-09-17']);
  f.api.dmvRunReport(report.id);
  assert.equal(f.calls[3].endDate, '2026-09-18');
});

test('manual pending reports resume on the owning hourly scheduler and leave foreign reports alone', () => {
  const f = fixture(), report = f.save();
  f.api.dmvRunReport(report.id);
  const other = f.addSpreadsheet('other');
  f.setActive(other);
  f.api.dmvRefreshScheduled();
  assert.equal(f.calls.length, 1);
  f.setActive(f.book);
  f.advance(3600000);
  f.api.dmvRefreshScheduled();
  f.advance(3600000);
  f.api.dmvRefreshScheduled();
  assert.equal(f.calls.length, 3);
  assert.equal(f.readReport(report.id).status, 'success');
  assert.equal(f.state.triggers.length, 0);
});

test('stale running leases recover the last committed checkpoint instead of starting over', () => {
  const f = fixture(), report = f.save({ schedule: 'weekly' });
  f.api.dmvRunReport(report.id);
  const current = f.readReport(report.id);
  current.status = 'running'; current.runToken = 'terminated'; current.startedAt = f.api.Date.now();
  f.api.dmvSave_('report', current);
  assert.throws(() => f.api.dmvRunReport(report.id), /already refreshing/);
  f.advance(3600000);
  f.api.dmvRefreshScheduled();
  assert.deepEqual(f.calls.map((call) => call.offset), [0, 1]);
});

test('manual execution of a weekly report arms immediate recovery before fetching', () => {
  const f = fixture(); f.setTotal(1);
  const report = f.save({ schedule: 'weekly' });
  f.api.dmvRunReport(report.id);
  assert.ok(f.readReport(report.id).nextRunAt > f.api.Date.now());
  f.setTotal(3);
  f.setHook(() => {
    const running = f.readReport(report.id);
    assert.equal(running.continuationRequested, true);
    assert.ok(running.nextRunAt <= f.api.Date.now());
  });
  f.api.dmvRunReport(report.id);
});

test('provider failure on resume preserves previous cells and receipt, sanitizes error, and permits a fresh run', () => {
  const f = fixture(); f.setTotal(1);
  const report = f.save(); f.api.dmvRunReport(report.id);
  const cells = [...f.book.sheets[0].cells], receipt = f.readOutput(report.id), lastRun = f.readReport(report.id).lastRun;
  f.setTotal(3); f.api.dmvRunReport(report.id);
  assert.equal(f.readReport(report.id).lastRowCount, 1);
  assert.equal(f.readReport(report.id).lastRun, lastRun);
  f.setHook(() => { throw new Error('Refused sensitive-test-token'); });
  assert.throws(() => f.api.dmvRunReport(report.id), /Refused \[redacted\]/);
  assert.deepEqual([...f.book.sheets[0].cells], cells);
  assert.deepEqual(f.readOutput(report.id), receipt);
  assert.equal(f.state.batches.length, 1);
  assert.deepEqual(f.chunks(), []);
  assert.equal(f.readReport(report.id).status, 'error');
  f.setHook(null); f.api.dmvRunReport(report.id);
  assert.equal(f.calls.at(-1).offset, 0);
});

test('editing or deleting a paused report discards its checkpoints and only its recovery trigger', () => {
  for (const action of ['edit', 'delete']) {
    const f = fixture(), report = f.save();
    const foreign = f.addTrigger('foreign');
    f.api.dmvRunReport(report.id);
    if (action === 'edit') {
      const saved = f.api.dmvSaveReport({ ...report, name: 'Updated' });
      assert.equal(saved.status, 'ready');
      assert.equal(saved.continuation, undefined);
    } else f.api.dmvDeleteReport(report.id);
    assert.deepEqual(f.chunks(), []);
    assert.deepEqual(f.state.triggers, [foreign]);
    assert.equal(f.state.batches.length, 0);
  }
});

test('changed credentials invalidate continuation before any more provider calls', () => {
  const f = fixture(), report = f.save();
  f.api.dmvRunReport(report.id);
  f.api.dmvSaveConnection({ id: f.connection.id, connectorId: 'arbitrary', label: 'Updated', credentials: { token: 'new-secret' } });
  assert.throws(() => f.api.dmvRunReport(report.id), /connection changed/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.state.batches.length, 0);
  assert.deepEqual(f.chunks(), []);
});

test('active chunk execution locks report and connection edits and rejects a concurrent resume', () => {
  const f = fixture(), report = f.save();
  f.setHook(() => {
    assert.throws(() => f.api.dmvRunReport(report.id), /already refreshing/);
    assert.throws(() => f.api.dmvSaveReport(report), /current refresh/);
    assert.throws(() => f.api.dmvDeleteReport(report.id), /current refresh/);
    assert.throws(() => f.api.dmvSaveConnection({ id: f.connection.id, connectorId: 'arbitrary', label: 'Changed', credentials: {} }), /current refresh/);
  });
  f.api.dmvRunReport(report.id);
  assert.equal(f.state.lockAcquires, f.state.lockReleases);
});

test('a connection changed after a slow request outlives its lease cannot commit a chunk or output', () => {
  for (const total of [1, 3]) {
    const f = fixture(), report = f.save();
    f.setTotal(total);
    f.setHook(() => {
      f.advance(300001);
      f.api.dmvSaveConnection({ id: f.connection.id, connectorId: 'arbitrary', label: 'Other account',
        credentials: { token: 'replacement-token' } });
    });
    assert.throws(() => f.api.dmvRunReport(report.id), /connection changed/);
    assert.equal(f.state.batches.length, 0);
    assert.deepEqual(f.chunks(), []);
  }
});

test('missing, damaged and expired snapshots fail closed without writing or refetching', () => {
  for (const damage of ['missing', 'changed', 'expired']) {
    const f = fixture(), report = f.save();
    f.api.dmvRunReport(report.id);
    if (damage === 'missing') f.state.user.deleteProperty(f.chunks()[0]);
    if (damage === 'changed') f.state.user.setProperty(f.chunks()[0], 'invalid');
    if (damage === 'expired') f.advance(86400001);
    assert.throws(() => f.api.dmvRunReport(report.id), /missing or damaged|expired/);
    assert.equal(f.calls.length, 1);
    assert.equal(f.state.batches.length, 0);
    assert.deepEqual(f.chunks(), []);
    f.api.dmvRunReport(report.id);
    assert.equal(f.calls.at(-1).offset, 0);
  }
});

test('checkpoint pointer stays on the prior generation if new snapshot commit is interrupted', () => {
  const f = fixture(), report = f.save(); f.api.dmvRunReport(report.id);
  const saved = f.readReport(report.id), snapshot = plain(f.api.dmvReadContinuation_(saved));
  snapshot.result.rows.push({ n: 1, flag: false, text: 'new row' });
  snapshot.result.state = { offset: 2 };
  const originalSet = f.state.user.setProperty;
  f.state.user.setProperty = (key, value) => {
    if (key === 'dmv:v1:report:' + report.id) throw new Error('Interrupted before pointer commit');
    return originalSet(key, value);
  };
  assert.throws(() => f.api.dmvSaveContinuation_(saved, snapshot), /Interrupted/);
  f.state.user.setProperty = originalSet;
  assert.equal(f.api.dmvReadContinuation_(f.readReport(report.id)).result.state.offset, 1);
  f.api.dmvRunReport(report.id);
  assert.deepEqual(f.calls.map((call) => call.offset), [0, 1]);
  const ref = f.readReport(report.id).continuation;
  assert.ok(f.chunks().every((key) => key.includes(':' + ref.generation + ':')));
});

test('multipart compressed snapshots round-trip Unicode within per-property limits', () => {
  const f = fixture(), report = f.save();
  const value = Array.from({ length: 700 }, (_, i) => createHash('sha256').update(String(i)).digest('hex')).join('') + '\u03b1\u03b2\u03b3';
  f.setHook((_ctx, _state, chunk) => { chunk.rows[0].text = value; });
  f.api.dmvRunReport(report.id);
  assert.ok(f.chunks().length > 1);
  for (const key of f.chunks()) assert.ok(Buffer.byteLength(f.state.user.getProperty(key)) <= 7500);
  assert.equal(f.api.dmvReadContinuation_(f.readReport(report.id)).result.rows[0].text, value);
  f.api.dmvRunReport(report.id);
  f.api.dmvRunReport(report.id);
  assert.equal(f.value(f.book.sheets[0], 2, 3), value);
  assert.equal(f.state.batches.length, 1);
  assert.deepEqual(f.chunks(), []);
});

test('an old worker cannot replace the newer worker checkpoint or clear its lease', () => {
  const f = fixture(), report = f.save();
  f.api.dmvRunReport(report.id);
  const before = f.readReport(report.id).continuation;
  f.setHook(() => {
    const current = f.readReport(report.id);
    current.runToken = 'new-worker';
    f.api.dmvSave_('report', current);
  });
  assert.throws(() => f.api.dmvRunReport(report.id), /report changed/);
  assert.equal(f.readReport(report.id).runToken, 'new-worker');
  assert.deepEqual(f.readReport(report.id).continuation, before);
  assert.equal(f.state.batches.length, 0);
});

test('storage caps and trigger failure fail before writing any partial output', () => {
  for (const limit of ['snapshot', 'properties', 'trigger']) {
    const f = fixture(), report = f.save();
    if (limit === 'snapshot') f.api.DMV_CONTINUATION.maxEncodedBytes = 1;
    if (limit === 'properties') f.api.DMV_CONTINUATION.maxPropertyBytes = 1;
    if (limit === 'trigger') f.state.failTrigger = true;
    assert.throws(() => f.api.dmvRunReport(report.id), /storage|Trigger/);
    assert.equal(f.state.batches.length, 0);
    assert.equal(f.readReport(report.id).status, 'error');
    assert.equal(f.readReport(report.id).runToken, null);
    assert.deepEqual(f.chunks(), []);
    if (limit === 'trigger') assert.equal(f.calls.length, 0);
  }
});

test('aggregate row limits, schema drift, invalid values and incomplete contracts cannot reach the writer', () => {
  for (const fault of ['limit', 'schema', 'numeric', 'contract']) {
    const f = fixture(), report = f.save({ maxRows: fault === 'limit' ? 1 : 100 });
    f.api.dmvRunReport(report.id);
    f.setHook((_ctx, _state, chunk) => {
      if (fault === 'schema') chunk.columns = [{ key: 'different' }];
      if (fault === 'numeric') chunk.rows[0].n = NaN;
      if (fault === 'contract') chunk.metadata.complete = true;
    });
    assert.throws(() => f.api.dmvRunReport(report.id), /row limit|columns changed|numeric|invalid continuation/);
    assert.equal(f.state.batches.length, 0);
    assert.deepEqual(f.chunks(), []);
  }
});

test('destination edits while paused are checked at completion and preserved', () => {
  const f = fixture(); f.setTotal(1);
  const report = f.save(); f.api.dmvRunReport(report.id);
  f.setTotal(3); f.api.dmvRunReport(report.id);
  f.setCell(f.book.sheets[0], 2, 1, 'my edit');
  f.api.dmvRunReport(report.id);
  assert.throws(() => f.api.dmvRunReport(report.id), /edited or moved/);
  assert.equal(f.value(f.book.sheets[0], 2, 1), 'my edit');
  assert.equal(f.state.batches.length, 1);
});

test('preview exhausts chunks without checkpoint state, triggers or sheet writes', () => {
  const f = fixture();
  const before = plain(f.state.user.getProperties());
  assert.equal(f.api.dmvPreviewReport(f.input).totalRows, 3);
  assert.deepEqual(plain(f.state.user.getProperties()), before);
  assert.equal(f.state.triggers.length, 0);
  assert.equal(f.state.batches.length, 0);
});

test('time slice pauses after a complete provider page and total page count stays bounded across resumes', () => {
  const f = fixture(), report = f.save();
  f.api.DMV_CONTINUATION.chunksPerExecution = 10;
  f.setHook(() => f.advance(45001));
  assert.equal(f.api.dmvRunReport(report.id).pending, true);
  assert.equal(f.calls.length, 1);
  const current = f.readReport(report.id), snapshot = f.api.dmvReadContinuation_(current);
  snapshot.result.pages = 100;
  f.api.dmvSaveContinuation_(current, snapshot);
  assert.throws(() => f.api.dmvRunReport(report.id), /too many chunks/);
  assert.equal(f.state.batches.length, 0);
});
