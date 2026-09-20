import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatamoovSandbox, plain } from './helpers/datamoov-sandbox.mjs';

function fixture() {
  const f = createDatamoovSandbox();
  const columns = [
    { key: 'date', type: 'date' },
    { key: 'campaign', type: 'text' },
    { key: 'spend', type: 'currency' },
    { key: 'clicks', type: 'number' },
  ];
  const outputs = {
    one: [{ date: '2026-08-01', campaign: '=literal', spend: 3, clicks: 2 }],
    two: [{ date: '2026-08-02', campaign: 'Second', spend: 7, clicks: 4 }],
  };
  f.fetched = [];
  f.api.dmvRegisterConnector_({
    id: 'fixture_source',
    label: 'Fixture source',
    category: 'Test',
    allowedHosts: ['fixture.example'],
    authFields: [
      { key: 'account', label: 'Account', type: 'text', required: true },
      { key: 'token', label: 'Token', type: 'password', required: true },
    ],
    reports: [
      {
        id: 'daily',
        label: 'Daily',
        fields: columns,
        dateRange: true,
        configFields: [],
        fetch(ctx) {
          const name = ctx.credentials.account;
          f.fetched.push({
            account: name,
            deadline: ctx.deadline,
            status: plain(f.api.dmvListDashboards())[0],
          });
          if (f.onFetch) f.onFetch(name, ctx);
          const rows = outputs[name];
          if (rows instanceof Error) throw rows;
          return {
            columns,
            rows,
            metadata: { complete: true, currency: f.currency?.[name] || 'EUR' },
          };
        },
      },
    ],
  });
  f.connections = ['one', 'two'].map((account) =>
    f.api.dmvSaveConnection({
      connectorId: 'fixture_source',
      label: account,
      credentials: { account, token: 'private-dashboard-token' },
    })
  );
  f.input = {
    name: 'Marketing overview',
    sources: f.connections.map((connection, i) => ({
      id: 'source' + i,
      label: 'Source ' + (i + 1),
      connectionId: connection.id,
      reportType: 'daily',
      fields: columns.map((column) => column.key),
      config: {},
      dateRange: { preset: 'lastMonth' },
      maxRows: 100,
      mapping: columns.map((column) => ({ field: column.key, key: column.key })),
    })),
    summary: {
      groupBy: ['date', 'currency'],
      dateBucket: 'month',
      metrics: [
        { field: 'spend', agg: 'sum' },
        { field: 'clicks', agg: 'sum' },
      ],
      orderBy: { field: 'spend__sum', direction: 'desc' },
      limit: 20000,
    },
    dataTarget: { sheetName: 'Dashboard data', startCell: 'A1' },
    target: { sheetName: 'Dashboard report', startCell: 'A1' },
  };
  f.setRows = (account, rows) => {
    outputs[account] = rows;
  };
  f.save = (input = f.input) => plain(f.api.dmvSaveDashboard(input));
  f.run = (id, deadline) => plain(f.api.dmvRunDashboard(id, deadline));
  f.record = (id) => f.api.dmvRead_('dashboard', id);
  return f;
}

test('private dashboard saves two different source queries and refreshes both tabs in one atomic batch', () => {
  const f = fixture(),
    saved = f.save();
  assert.equal(saved.sourceCount, 2);
  assert.deepEqual(saved.sourceLabels, ['Source 1', 'Source 2']);
  assert.equal(f.state.batches.length, 0);
  assert.equal(f.state.script.data.size, 0);
  assert.ok(!JSON.stringify(f.record(saved.id)).includes('private-dashboard-token'));
  const result = f.run(saved.id);
  assert.equal(result.dataRowCount, 2);
  assert.equal(result.rowCount, 1);
  assert.equal(f.fetched.length, 2);
  assert.equal(f.state.batches.length, 1);
  assert.equal(f.state.batches[0].body.requests.filter((request) => request.addSheet).length, 2);
  const raw = f.book.getSheetByName('Dashboard data'),
    report = f.book.getSheetByName('Dashboard report');
  assert.equal(f.value(raw, 2, 3), '=literal');
  assert.equal(f.formula(raw, 2, 3), '');
  assert.equal(f.value(report, 2, 3), 10);
  assert.equal(f.value(report, 2, 4), 6);
  assert.ok(f.fetched.every((entry) => entry.status.status === 'running'));
  assert.match(f.fetched[0].status.statusMessage, /Fetching source 1 of 2/);
  assert.match(f.fetched[1].status.statusMessage, /Fetching source 2 of 2/);
  assert.equal(f.record(saved.id).status, 'success');
  assert.equal(f.readOutput(saved.id + '-data').rows, 3);
  assert.equal(f.readOutput(saved.id + '-report').rows, 2);
});

test('refresh fetches fresh sources again, preserves stable tabs, and clears owned trailing rows', () => {
  const f = fixture(),
    saved = f.save();
  f.run(saved.id);
  const raw = f.book.getSheetByName('Dashboard data'),
    report = f.book.getSheetByName('Dashboard report');
  f.setRows('one', [{ date: '2026-08-03', campaign: 'Changed', spend: 5, clicks: 1 }]);
  f.setRows('two', []);
  const refreshed = f.run(saved.id);
  assert.equal(f.fetched.length, 4);
  assert.equal(refreshed.dataRowCount, 1);
  assert.equal(f.book.getSheetByName('Dashboard data').id, raw.id);
  assert.equal(f.book.getSheetByName('Dashboard report').id, report.id);
  assert.equal(f.value(raw, 3, 1), '');
  assert.equal(f.value(report, 2, 3), 5);
  assert.equal(f.state.batches.length, 2);
});

test('a failed later source preserves both previous outputs and stores only sanitized errors', () => {
  const f = fixture(),
    saved = f.save();
  f.run(saved.id);
  const raw = f.book.getSheetByName('Dashboard data'),
    report = f.book.getSheetByName('Dashboard report');
  const before = [plain([...raw.cells]), plain([...report.cells])];
  f.setRows('one', []);
  f.setRows('two', new Error('Source rejected private-dashboard-token'));
  assert.throws(() => f.run(saved.id), /Source rejected \[redacted\]/);
  assert.deepEqual([plain([...raw.cells]), plain([...report.cells])], before);
  assert.equal(f.state.batches.length, 1);
  assert.equal(f.record(saved.id).runToken, null);
  assert.equal(f.record(saved.id).status, 'error');
  assert.ok(!f.record(saved.id).lastError.includes('private-dashboard-token'));
});

test('second destination occupancy or edited ownership blocks all writes and new tab creation', () => {
  const f = fixture();
  const report = f.book.insertSheet('Dashboard report');
  f.setCell(report, 1, 1, 'Keep');
  const saved = f.save();
  assert.throws(() => f.run(saved.id), /existing data/);
  assert.equal(f.book.getSheetByName('Dashboard data'), null);
  assert.equal(f.state.batches.length, 0);
  f.setCell(report, 1, 1, '');
  f.run(saved.id);
  const raw = f.book.getSheetByName('Dashboard data');
  f.setCell(report, 2, 1, 'Manual edit');
  const before = plain([...raw.cells]);
  assert.throws(() => f.run(saved.id), /edited or moved/);
  assert.deepEqual(plain([...raw.cells]), before);
  assert.equal(f.state.batches.length, 1);
});

test('atomic batch failure creates neither output tab nor ownership receipts', () => {
  const f = fixture(),
    saved = f.save();
  f.state.failBatch = true;
  assert.throws(() => f.run(saved.id), /atomic batch failure/);
  assert.equal(f.book.getSheetByName('Dashboard data'), null);
  assert.equal(f.book.getSheetByName('Dashboard report'), null);
  assert.equal(f.readOutput(saved.id + '-data'), null);
  assert.equal(f.readOutput(saved.id + '-report'), null);
});

test('source connection and plan changes during fetch abort before any destination write', () => {
  for (const what of ['connection', 'plan']) {
    const f = fixture(),
      saved = f.save();
    f.onFetch = (account) => {
      if (account !== 'one') return;
      if (what === 'connection') {
        const connection = f.api.dmvRead_('connection', f.connections[1].id);
        connection.revision++;
        f.api.dmvSave_('connection', connection);
      } else {
        const dashboard = f.record(saved.id);
        dashboard.name = 'Changed concurrently';
        f.api.dmvSave_('dashboard', dashboard);
      }
    };
    assert.throws(() => f.run(saved.id), /changed/);
    assert.equal(f.state.batches.length, 0);
  }
});

test('active leases prevent simultaneous refresh, edit, delete, and source identity changes', () => {
  const f = fixture(),
    saved = f.save();
  let checked = false;
  f.onFetch = () => {
    if (checked) return;
    checked = true;
    assert.throws(() => f.run(saved.id), /already refreshing/);
    assert.throws(() => f.save({ ...f.input, id: saved.id, revision: saved.revision }), /finish/);
    assert.throws(() => f.api.dmvDeleteDashboard(saved.id), /finish/);
  };
  f.run(saved.id);
  assert.equal(checked, true);
});

test('the shared deadline bounds all source fetches and an expired lease becomes retryable', () => {
  const f = fixture(),
    saved = f.save();
  f.onFetch = () => f.advance(15000);
  assert.throws(() => f.run(saved.id, f.api.Date.now() + 20000), /time limit/);
  assert.equal(f.fetched.length, 1);
  assert.equal(f.state.batches.length, 0);
  const record = f.record(saved.id);
  record.status = 'running';
  record.runToken = 'abandoned';
  record.startedAt = f.api.Date.now() - 300001;
  f.api.dmvSave_('dashboard', record);
  assert.equal(plain(f.api.dmvListDashboards())[0].status, 'error');
  f.onFetch = null;
  assert.equal(f.run(saved.id).ok, true);
});

test('dashboard plans and deletion stay isolated to the owning user and workbook', () => {
  const f = fixture(),
    saved = f.save();
  f.run(saved.id);
  const other = f.addSpreadsheet('copied', ['Output']);
  f.setActive(other);
  assert.deepEqual(plain(f.api.dmvListDashboards()), []);
  assert.throws(() => f.run(saved.id), /another spreadsheet/);
  assert.throws(() => f.api.dmvDeleteDashboard(saved.id), /another spreadsheet/);
  assert.deepEqual(plain(fixture().api.dmvListDashboards()), []);
  f.setActive(f.book);
  const before = f.book.sheets.length;
  f.api.dmvDeleteDashboard(saved.id);
  assert.equal(f.book.sheets.length, before);
  assert.deepEqual(plain(f.api.dmvListDashboards()), []);
});

test('invalid, duplicate, oversized and stale plans fail without provider or sheet actions', () => {
  const f = fixture();
  for (const mutate of [
    (input) => {
      input.sources[1] = { ...input.sources[0], id: 'other', label: 'Other' };
    },
    (input) => {
      input.target.sheetName = input.dataTarget.sheetName;
    },
    (input) => {
      input.sources[0].credentials = { token: 'untrusted' };
    },
    (input) => {
      input.sources[0].mapping[0].key = '__proto__';
    },
    (input) => {
      input.sources[0].maxRows = true;
    },
    (input) => {
      input.summary.metrics[0].agg = 'execute';
    },
    (input) => {
      input.summary.rankWithin = ['date'];
    },
  ]) {
    const input = plain(f.input);
    mutate(input);
    assert.throws(() => f.save(input));
  }
  assert.equal(f.fetched.length, 0);
  assert.equal(f.state.batches.length, 0);
  const saved = f.save();
  assert.throws(() => f.save({ ...f.input, id: saved.id, revision: 0 }), /changed/);
});

test('money remains grouped by currency and global summary truncation never writes partial groups', () => {
  const f = fixture();
  f.currency = { one: 'EUR', two: 'USD' };
  let saved = f.save();
  assert.equal(f.run(saved.id).rowCount, 2);
  saved = f.save({
    ...f.input,
    id: saved.id,
    revision: saved.revision,
    summary: { ...f.input.summary, groupBy: ['date'] },
  });
  assert.throws(() => f.run(saved.id), /currencies/);
  saved = f.save({
    ...f.input,
    id: saved.id,
    revision: saved.revision,
    summary: { ...f.input.summary, limit: 1 },
  });
  assert.throws(() => f.run(saved.id), /omitted groups/);
  assert.equal(f.state.batches.length, 1);
});

test('row limits do not make duplicate source queries distinct', () => {
  const f = fixture();
  f.input.sources[1] = { ...f.input.sources[0], id: 'duplicate', label: 'Duplicate', maxRows: 101 };
  assert.throws(() => f.save(), /same source query twice/);
  assert.equal(f.fetched.length, 0);
});

test('ownership journals recover both committed tabs after a receipt-storage failure', () => {
  const f = fixture(),
    saved = f.save();
  const set = f.state.user.setProperty;
  let fail = true;
  f.state.user.setProperty = function (key, value) {
    if (fail && key === 'dmv:v1:output:' + f.book.id + ':' + saved.id + '-report')
      throw new Error('Simulated receipt outage');
    return set.call(this, key, value);
  };
  assert.throws(() => f.run(saved.id), /tabs were updated.*receipts/);
  assert.ok(f.book.getSheetByName('Dashboard data'));
  assert.ok(f.book.getSheetByName('Dashboard report'));
  const journalKey = 'dmv:v1:write-journal:' + f.book.id;
  assert.ok(f.state.user.getProperty(journalKey));
  assert.ok(!f.state.user.getProperty(journalKey).includes('private-dashboard-token'));
  assert.ok(!f.state.user.getProperty(journalKey).includes('=literal'));
  fail = false;
  const result = f.run(saved.id);
  assert.equal(result.ok, true);
  assert.equal(f.state.batches.length, 2);
  assert.equal(f.state.user.getProperty(journalKey), null);
  assert.ok(f.readOutput(saved.id + '-data'));
  assert.ok(f.readOutput(saved.id + '-report'));
  assert.equal(result.dataRange, 'A1:F3');
  assert.equal(result.reportRange, 'A1:D2');
  assert.equal(result.columns[2].key, 'spend__sum');
});

test('journal recovery never adopts manually edited cells as dashboard-owned output', () => {
  const f = fixture(),
    saved = f.save();
  const set = f.state.user.setProperty;
  let fail = true;
  f.state.user.setProperty = function (key, value) {
    if (fail && key.endsWith(saved.id + '-report')) throw new Error('Receipt outage');
    return set.call(this, key, value);
  };
  assert.throws(() => f.run(saved.id), /tabs were updated/);
  const report = f.book.getSheetByName('Dashboard report');
  f.setCell(report, 2, 3, 'Manual');
  fail = false;
  assert.throws(() => f.run(saved.id), /existing data/);
  assert.equal(f.value(report, 2, 3), 'Manual');
  assert.equal(f.state.batches.length, 1);
});

test('combined row and cumulative workbook capacity limits stop both outputs', () => {
  const f = fixture();
  f.input.sources.forEach((source) => {
    source.maxRows = 20000;
  });
  f.setRows(
    'one',
    Array.from({ length: 10001 }, () => ({
      date: '2026-08-01',
      campaign: 'One',
      spend: 1,
      clicks: 1,
    }))
  );
  f.setRows(
    'two',
    Array.from({ length: 10001 }, () => ({
      date: '2026-08-02',
      campaign: 'Two',
      spend: 2,
      clicks: 2,
    }))
  );
  assert.throws(() => f.run(f.save().id), /exceeds 20,000/);
  assert.equal(f.state.batches.length, 0);
  const g = fixture();
  g.book.sheets[0].maxRows = 383462;
  assert.throws(() => g.run(g.save().id), /cell capacity/);
  assert.equal(g.state.batches.length, 0);
  assert.equal(g.book.getSheetByName('Dashboard data'), null);
});

test('the shared writer handles two nonoverlapping ranges beyond one existing grid', () => {
  const f = fixture(),
    result = f.api.dmvNormalizeResult_(
      { columns: [{ key: 'value', type: 'number' }], rows: [{ value: 2 }] },
      10
    );
  f.api.dmvWriteReports_(
    f.book,
    ['A120', 'B120'].map((startCell, i) => ({
      report: {
        id: 'output' + i,
        spreadsheetId: f.book.id,
        target: { sheetName: 'Output', startCell },
      },
      result,
    }))
  );
  assert.equal(f.state.batches.length, 1);
  assert.equal(f.value(f.book.sheets[0], 121, 1), 2);
  assert.equal(f.value(f.book.sheets[0], 121, 2), 2);
});

test('post-commit dashboard state failures disclose updated tabs with safe metadata', () => {
  const f = fixture(),
    saved = f.save(),
    set = f.state.user.setProperty;
  f.state.user.setProperty = function (key, value) {
    if (key === 'dmv:v1:dashboard:' + saved.id && JSON.parse(value).status === 'success')
      throw new Error('Private state outage');
    return set.call(this, key, value);
  };
  assert.throws(
    () => f.run(saved.id),
    (error) => {
      assert.equal(error.sheetUpdated, true);
      assert.equal(error.id, saved.id);
      assert.equal(error.target.sheetName, 'Dashboard report');
      assert.equal(error.dataTarget.sheetName, 'Dashboard data');
      assert.match(error.message, /tabs were updated/);
      return true;
    }
  );
  assert.equal(f.state.batches.length, 1);
  assert.ok(f.readOutput(saved.id + '-report'));
});

test('dashboard refresh freezes all relative periods at one local date across a week boundary', () => {
  const f = fixture();
  f.book.timezone = 'Europe/Athens';
  f.advance(Date.parse('2026-09-20T20:59:59.900Z') - Date.parse('2026-09-18T12:00:00Z'));
  f.input.sources[0].dateRange = { preset: 'lastWeek' };
  f.input.sources[1].dateRange = { preset: 'previousWeek' };
  const saved = f.save();
  const observed = [];
  f.onFetch = (account, ctx) => {
    observed.push({ account, start: ctx.startDate, end: ctx.endDate });
    if (observed.length === 1) f.advance(200);
  };
  f.run(saved.id);
  assert.deepEqual(observed, [
    { account: 'one', start: '2026-09-07', end: '2026-09-13' },
    { account: 'two', start: '2026-08-31', end: '2026-09-06' },
  ]);
  assert.deepEqual(plain(f.record(saved.id).sources.map((source) => source.dateRange)), [
    { preset: 'lastWeek' },
    { preset: 'previousWeek' },
  ]);
  f.run(saved.id);
  assert.deepEqual(observed.slice(2), [
    { account: 'one', start: '2026-09-14', end: '2026-09-20' },
    { account: 'two', start: '2026-09-07', end: '2026-09-13' },
  ]);
  assert.equal(f.state.batches.length, 2);
});
