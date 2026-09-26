import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatamoovSandbox, plain } from './helpers/datamoov-sandbox.mjs';

function fixture() {
  const f = createDatamoovSandbox();
  const fields = [
    { key: 'date', label: 'Date', type: 'date', default: true },
    { key: 'spend', label: 'Spend', type: 'currency', default: true },
    { key: 'clicks', label: 'Clicks', type: 'number', default: true },
  ];
  f.fetched = [];
  f.rowCount = 3;
  f.complete = true;
  f.api.dmvRegisterConnector_({
    id: 'reuse_fixture',
    label: 'Arbitrary report provider',
    category: 'Test',
    allowedHosts: [],
    authFields: [
      { key: 'token', label: 'Token', type: 'password', required: true },
      { key: 'account', label: 'Account', required: true, perConnection: true },
    ],
    reports: [
      {
        id: 'daily',
        label: 'Daily results',
        fields,
        dateRange: true,
        configFields: [{ key: 'segment', label: 'Segment', type: 'text' }],
        fetch(ctx) {
          f.fetched.push({
            account: ctx.credentials.account,
            token: ctx.credentials.token,
            startDate: ctx.startDate,
            endDate: ctx.endDate,
            maxRows: ctx.maxRows,
          });
          if (f.onFetch) f.onFetch(ctx);
          if (f.fail) throw new Error('Temporary fixture failure');
          return {
            columns: ctx.fields.map((key) => fields.find((field) => field.key === key)),
            rows: Array.from({ length: f.rowCount }, (_, index) => ({
              date: ctx.startDate,
              spend: index + 1,
              clicks: index,
            })),
            metadata: { currency: 'EUR', complete: f.complete },
          };
        },
      },
    ],
  });
  f.credential = f.api.dmvSaveCredential({
    family: 'reuse_fixture',
    label: 'Private fixture key',
    values: { token: 'secret-original' },
  });
  f.connections = ['One', 'Two'].map((account) =>
    f.api.dmvSaveConnection({
      connectorId: 'reuse_fixture',
      label: account,
      credentialId: f.credential.id,
      credentials: { account },
    })
  );
  f.session = f.api.dmvChatSession_(f.book);
  f.session.maxRows = 10;
  f.input = {
    connectionId: f.connections[0].id,
    reportType: 'daily',
    dateRange: { preset: 'lastWeek' },
  };
  f.run = (patch = {}, session = f.session) =>
    plain(f.api.dmvChatRunReport_(session, { ...f.input, ...patch }));
  f.rotate = () =>
    f.api.dmvSaveCredential({
      id: f.credential.id,
      family: 'reuse_fixture',
      label: 'Private fixture key',
      values: { token: 'secret-replacement' },
    });
  return f;
}

test('equivalent validated queries reuse a complete result for field-order and date-preset aliases', () => {
  const f = fixture();
  const first = f.run();
  const repeated = f.run({
    fields: ['clicks', 'spend', 'date'],
    config: {},
    dateRange: { preset: 'custom', startDate: '2026-09-07', endDate: '2026-09-13' },
  });
  assert.equal(f.fetched.length, 1);
  assert.equal(repeated.resultId, first.resultId);
  assert.equal(repeated.reused, true);
  assert.deepEqual(repeated.rows, first.rows);
  const event = f.session.events.at(-1);
  assert.equal(event.kind, 'report');
  assert.equal(event.ref, first.resultId);
  assert.match(event.text, /^Reused Arbitrary report provider \(One\)/);
  assert.match(event.text, /2026-09-07 to 2026-09-13/);
  assert.equal(JSON.stringify(f.session.reportResults).includes('secret-original'), false);
  assert.deepEqual(plain(f.session.events.map((event) => event.kind)), ['report', 'report']);
});

test('a request continued in another execution reuses its complete results from the private cache', () => {
  const f = fixture();
  const first = f.run();
  // The next execution starts with nothing in memory, only the saved reuse map.
  const next = () => {
    const session = f.api.dmvChatSession_(f.book);
    session.maxRows = 10;
    session.reportResults = JSON.parse(JSON.stringify(f.session.reportResults));
    return session;
  };
  const repeated = f.run({}, next());
  assert.equal(f.fetched.length, 1);
  assert.equal(repeated.resultId, first.resultId);
  assert.equal(repeated.reused, true);
  // An expired cache entry is fetched again instead of failing the call.
  f.state.cache.data.clear();
  const again = f.run({}, next());
  assert.equal(f.fetched.length, 2);
  assert.equal(again.reused, undefined);
});

test('reuse still enforces the current configured cap and a smaller requested row limit', () => {
  const f = fixture();
  const first = f.run();
  assert.throws(() => f.run({ maxRows: 11 }), /between 1 and 10/);
  assert.throws(
    () => f.run({ maxRows: 2 }),
    /row limit.*fetch allows 2 rows.*partial data was not used/
  );
  assert.equal(f.run({ maxRows: 3 }).resultId, first.resultId);
  f.session.maxRows = 2;
  assert.throws(() => f.run(), /row limit.*fetch allows 2 rows/);
  assert.equal(
    f.fetched.length,
    1,
    'lowering a limit neither truncates nor refetches the known complete result'
  );
  assert.equal(f.session.events.filter((event) => /^Reused/.test(event.text)).length, 1);
});

test('dates, selected fields, query configuration and connection identity remain separate fetches', () => {
  const f = fixture();
  const ids = [
    f.run().resultId,
    f.run({ dateRange: { preset: 'previousWeek' } }).resultId,
    f.run({ fields: ['spend', 'clicks'] }).resultId,
    f.run({ config: { segment: 'Different segment' } }).resultId,
    f.run({ connectionId: f.connections[1].id }).resultId,
  ];
  assert.equal(new Set(ids).size, 5);
  assert.equal(f.fetched.length, 5);
});

test('connection and saved-credential revisions invalidate otherwise identical queries', () => {
  const f = fixture();
  const first = f.run();
  f.api.dmvSaveConnection({
    id: f.connections[0].id,
    connectorId: 'reuse_fixture',
    label: 'Renamed connection',
    credentialId: f.credential.id,
    credentials: { account: 'One' },
  });
  const afterConnectionEdit = f.run();
  assert.notEqual(afterConnectionEdit.resultId, first.resultId);
  f.rotate();
  const afterCredentialEdit = f.run();
  assert.notEqual(afterCredentialEdit.resultId, afterConnectionEdit.resultId);
  assert.equal(f.run().resultId, afterCredentialEdit.resultId);
  assert.equal(f.fetched.length, 3);
  assert.equal(f.fetched[2].token, 'secret-replacement');
});

test('a credential change during fetch does not seed an entry with an obsolete revision', () => {
  const f = fixture();
  f.onFetch = () => {
    f.onFetch = null;
    f.rotate();
  };
  const first = f.run();
  assert.equal(Object.keys(f.session.reportResults || {}).length, 0);
  const second = f.run();
  assert.notEqual(second.resultId, first.resultId);
  assert.equal(f.run().resultId, second.resultId);
  assert.equal(f.fetched.length, 2);
});

test('failed and incomplete fetches are not reused; cross-turn result availability does not bypass a new fetch', () => {
  const f = fixture();
  f.fail = true;
  assert.throws(() => f.run(), /Temporary fixture failure/);
  f.fail = false;
  f.complete = false;
  assert.throws(() => f.run(), /row limit/);
  assert.equal(Object.keys(f.session.reportResults || {}).length, 0);
  f.complete = true;
  const success = f.run();
  assert.equal(f.run().resultId, success.resultId);
  const nextTurn = f.api.dmvChatSession_(f.book);
  nextTurn.maxRows = 10;
  assert.notEqual(f.run({}, nextTurn).resultId, success.resultId);
  assert.equal(f.fetched.length, 4);
});

test('relative query reuse expires across a resolved date change even within the same session', () => {
  const f = fixture();
  const first = f.run();
  f.advance(3 * 86400000);
  const second = f.run();
  assert.notEqual(second.resultId, first.resultId);
  assert.equal(f.fetched.length, 2);
  assert.equal(f.fetched[1].startDate, '2026-09-14');
});
