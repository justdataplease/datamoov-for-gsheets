import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createDatamoovSandbox, plain } from './helpers/datamoov-sandbox.mjs';

function fixture() {
  const f = createDatamoovSandbox();
  const columns = [
    { key: 'date', type: 'date' },
    { key: 'campaign', type: 'text' },
    { key: 'spend', type: 'currency' },
    { key: 'clicks', type: 'number' },
  ];
  // A second subject with its own columns: datasets of one dashboard need not look alike.
  const channelColumns = [
    { key: 'channel', label: 'Channel', type: 'text' },
    { key: 'sessions', label: 'Sessions', type: 'number' },
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
            maxRows: ctx.maxRows,
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
      {
        id: 'channels',
        label: 'Channels',
        fields: channelColumns,
        dateRange: false,
        configFields: [],
        fetch(ctx) {
          f.fetched.push({ account: ctx.credentials.account, report: 'channels' });
          return {
            columns: channelColumns,
            rows: [
              { channel: 'Organic', sessions: 30 },
              { channel: 'Paid', sessions: 12 },
            ],
            metadata: { complete: true },
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
    target: { sheetName: 'Dashboard report' },
    datasets: f.connections.map((connection, i) => ({
      id: 'source' + i,
      label: 'Source ' + (i + 1),
      sheetName: 'Source ' + (i + 1) + ' data',
      connectionId: connection.id,
      reportType: 'daily',
      fields: columns.map((column) => column.key),
      config: {},
      dateRange: { preset: 'lastMonth' },
      maxRows: 100,
      mapping: columns.map((column) => ({ field: column.key, key: column.key })),
    })),
    tiles: [
      {
        title: 'Totals',
        type: 'kpi',
        metrics: [
          { field: 'spend', agg: 'sum' },
          { field: 'clicks', agg: 'sum' },
        ],
      },
      {
        title: 'Monthly spend',
        type: 'column',
        groupBy: ['date'],
        dateBucket: 'month',
        metrics: [{ field: 'spend', agg: 'sum' }],
      },
      {
        title: 'Campaigns',
        type: 'table',
        groupBy: ['source', 'campaign'],
        metrics: [
          { field: 'spend', agg: 'sum' },
          { field: 'clicks', agg: 'sum' },
        ],
        orderBy: { field: 'spend__sum', direction: 'desc' },
      },
    ],
  };
  f.tabs = ['Source 1 data', 'Source 2 data', 'Dashboard report (chart data)', 'Dashboard report'];
  f.receipts = (id) => ['-d-source0', '-d-source1', '-charts', '-report'].map((suffix) => f.readOutput(id + suffix));
  f.setRows = (account, rows) => {
    outputs[account] = rows;
  };
  f.save = (input = f.input) => plain(f.api.dmvSaveDashboard(input));
  f.run = (id, deadline) => plain(f.api.dmvRunDashboard(id, deadline));
  f.record = (id) => f.api.dmvRead_('dashboard', id);
  f.plan = (id) => plain(f.api.dmvUnpack_(f.record(id).plan));
  // Everything a refresh may touch: every tab's cells, the native charts and the receipts.
  f.snapshot = () =>
    plain({
      tabs: f.book.sheets.map((sheet) => [sheet.name, sheet.id, [...sheet.cells]]),
      charts: f.state.charts,
      receipts: [...f.state.user.data].filter(([key]) => key.startsWith('dmv:v1:output:')),
    });
  return f;
}

// Every non-empty row of a tab, trimmed of trailing blanks, for readable layout assertions.
function rowsOf(f, name) {
  const sheet = f.tab(name);
  const out = [];
  for (let r = 1; r <= sheet.getLastRow(); r++) {
    const row = [];
    for (let c = 1; c <= 12; c++) row.push(f.value(sheet, r, c));
    while (row.length && row[row.length - 1] === '') row.pop();
    out.push(row);
  }
  return out;
}

const find = (rows, first) => rows.findIndex((row) => row[0] === first);

test('private dashboard saves two dataset queries and refreshes every data tab, the dashboard tab and its chart in one atomic batch', () => {
  const f = fixture(),
    saved = f.save();
  assert.deepEqual(
    saved.datasets.map((dataset) => [dataset.id, dataset.label, dataset.sheetName, dataset.rowCount, dataset.url]),
    [
      ['source0', 'Source 1', 'Source 1 data', null, null],
      ['source1', 'Source 2', 'Source 2 data', null, null],
    ]
  );
  assert.equal(saved.chartCount, 1);
  assert.equal(saved.status, 'ready');
  assert.equal(saved.statusMessage, 'Ready to refresh all datasets');
  assert.equal(saved.reportUrl, null, 'saving a plan alone creates no output');
  assert.deepEqual(saved.target, { sheetName: 'Dashboard report', startCell: 'A1' });
  assert.equal(saved.private, true);
  assert.equal(f.state.batches.length, 0);
  assert.equal(f.state.script.data.size, 0);
  assert.equal(f.state.document.data.size, 0);
  assert.ok(!JSON.stringify(f.record(saved.id)).includes('private-dashboard-token'));
  assert.deepEqual(plain(f.record(saved.id).connectionIds), f.connections.map((connection) => connection.id));

  const result = f.run(saved.id);
  assert.equal(result.rowCount, 2);
  assert.deepEqual(result.datasets.map((dataset) => [dataset.sheetName, dataset.rowCount]), [
    ['Source 1 data', 1],
    ['Source 2 data', 1],
  ]);
  assert.ok(result.datasets.every((dataset) => /#gid=\d+&range=A1$/.test(dataset.url)));
  assert.match(result.reportUrl, /#gid=\d+&range=A1$/);
  assert.equal(result.chartCount, 1);
  assert.deepEqual(result.scorecards, [
    { label: 'Spend (EUR)', value: 10 },
    { label: 'Clicks', value: 6 },
  ]);
  assert.deepEqual(result.tiles, [
    { title: 'Monthly spend', type: 'column', rows: 1 },
    { title: 'Campaigns', type: 'table', rows: 2 },
  ]);
  assert.deepEqual(result.links.map((link) => link.label), [
    'Dashboard: Dashboard report',
    'Data: Source 1 data',
    'Data: Source 2 data',
  ]);
  assert.equal(f.fetched.length, 2, 'each dataset is fetched exactly once');

  // One commit carries the three new tabs, their cells and the native chart.
  assert.equal(f.state.batches.length, 1);
  const requests = f.state.batches[0].body.requests;
  assert.deepEqual(
    requests.filter((request) => request.addSheet).map((request) => request.addSheet.properties.title),
    f.tabs
  );
  assert.equal(requests.filter((request) => request.addChart).length, 1);

  // Data tabs: three provenance rows, then the dataset as fetched. Formula-like text stays text.
  const one = f.tab('Source 1 data');
  const raw = rowsOf(f, 'Source 1 data');
  assert.equal(raw[0][0], 'Source 1 · Fixture source · one · Daily');
  assert.match(raw[1][0], /^2026-08-01 to 2026-08-31 · 1 rows · Refreshed .* · Dashboard: Marketing overview$/);
  assert.deepEqual(raw.slice(2), [[], ['date', 'campaign', 'spend', 'clicks'], ['2026-08-01', '=literal', 3, 2]]);
  assert.equal(f.value(one, 5, 2), '=literal');
  assert.equal(f.formula(one, 5, 2), '');
  assert.deepEqual(rowsOf(f, 'Source 2 data')[4], ['2026-08-02', 'Second', 7, 4]);

  // Dashboard tab: title, scorecards, the reserved chart band, data sources, then the tables.
  const report = f.tab('Dashboard report');
  const page = rowsOf(f, 'Dashboard report');
  assert.equal(page[0][0], 'Marketing overview');
  assert.deepEqual(page[3], ['Spend (EUR)', 'Clicks']);
  assert.deepEqual(page[4], [10, 6]);
  const sources = find(page, 'Data sources');
  assert.equal(sources, 6 + 17, 'one chart reserves one band of rows');
  assert.deepEqual(page.slice(sources + 1, sources + 4), [
    ['Dataset', 'Source', 'Connection', 'Report', 'Date range', 'Rows', 'Tab'],
    ['Source 1', 'Fixture source', 'one', 'Daily', '2026-08-01 to 2026-08-31', 1, 'Source 1 data'],
    ['Source 2', 'Fixture source', 'two', 'Daily', '2026-08-01 to 2026-08-31', 1, 'Source 2 data'],
  ]);
  // The numbers behind a chart live on the hidden chart data tab, not under the chart.
  assert.equal(find(page, 'Monthly spend'), -1);
  const chartData = rowsOf(f, 'Dashboard report (chart data)');
  assert.equal(f.tab('Dashboard report (chart data)').hidden, true);
  const monthly = find(chartData, 'Monthly spend');
  assert.deepEqual(chartData.slice(monthly + 1, monthly + 3), [['Date', 'Spend'], ['2026-08', 10]]);
  const campaigns = find(page, 'Campaigns');
  assert.deepEqual(page.slice(campaigns + 1), [
    ['Source', 'Campaign', 'Spend', 'Clicks'],
    ['Source 2', 'Second', 7, 4],
    ['Source 1', '=literal', 3, 2],
  ]);
  assert.equal(f.formula(report, campaigns + 4, 2), '');

  // The chart sits in the reserved band of the dashboard and reads the chart data tab.
  assert.equal(f.state.charts.length, 1);
  const chart = f.state.charts[0];
  assert.equal(chart.spec.title, 'Monthly spend');
  assert.deepEqual(chart.position.overlayPosition.anchorCell, { sheetId: report.getSheetId(), rowIndex: 6, columnIndex: 0 });
  assert.equal(chart.spec.basicChart.chartType, 'COLUMN');
  assert.deepEqual(chart.spec.basicChart.series[0].series.sourceRange.sources[0], {
    sheetId: f.tab('Dashboard report (chart data)').getSheetId(),
    startRowIndex: monthly + 1,
    endRowIndex: monthly + 3,
    startColumnIndex: 1,
    endColumnIndex: 2,
  });

  assert.ok(f.fetched.every((entry) => entry.status.status === 'running'));
  assert.match(f.fetched[0].status.statusMessage, /Fetching dataset 1 of 2: Source 1/);
  assert.match(f.fetched[1].status.statusMessage, /Fetching dataset 2 of 2: Source 2/);
  const record = f.record(saved.id);
  assert.equal(record.status, 'success');
  assert.equal(record.statusMessage, 'Updated 2 data tabs and 1 charts');
  assert.equal(record.runToken, null);
  assert.equal(record.lastRowCount, 2);
  assert.deepEqual(plain(record.chartIds), [chart.chartId]);
  assert.deepEqual(plain(record.outputs), [
    { id: 'source0', label: 'Source 1', sheetName: 'Source 1 data', rows: 1 },
    { id: 'source1', label: 'Source 2', sheetName: 'Source 2 data', rows: 1 },
  ]);

  // One ownership receipt per tab; the combined data tab of the earlier design is gone.
  assert.deepEqual(f.receipts(saved.id).map((receipt) => [receipt.sheetId, receipt.rows]), [
    [one.getSheetId(), 5],
    [f.tab('Source 2 data').getSheetId(), 5],
    [f.tab('Dashboard report (chart data)').getSheetId(), chartData.length],
    [report.getSheetId(), page.length],
  ]);
  assert.equal(f.readOutput(saved.id + '-data'), null);
  assert.ok(!JSON.stringify(result).includes('private-dashboard-token'));
});

test('refresh fetches fresh datasets again, preserves stable tabs and charts, and clears owned trailing rows', () => {
  const f = fixture(),
    saved = f.save();
  f.run(saved.id);
  const ids = f.tabs.map((name) => f.tab(name).id),
    chartId = f.state.charts[0].chartId,
    before = rowsOf(f, 'Dashboard report').length;
  f.setRows('one', [{ date: '2026-08-03', campaign: 'Changed', spend: 5, clicks: 1 }]);
  f.setRows('two', []);
  const refreshed = f.run(saved.id);
  assert.equal(f.fetched.length, 4);
  assert.equal(refreshed.rowCount, 1);
  assert.deepEqual(refreshed.datasets.map((dataset) => dataset.rowCount), [1, 0]);
  assert.deepEqual(f.tabs.map((name) => f.tab(name).id), ids);
  assert.deepEqual(rowsOf(f, 'Source 1 data')[4], ['2026-08-03', 'Changed', 5, 1]);
  const emptied = rowsOf(f, 'Source 2 data');
  assert.match(emptied[1][0], / · 0 rows · /);
  assert.deepEqual(emptied.slice(3), [['date', 'campaign', 'spend', 'clicks']], 'the row of the previous refresh is cleared');
  assert.equal(f.value(f.tab('Source 2 data'), 5, 1), '');
  const page = rowsOf(f, 'Dashboard report');
  assert.deepEqual(page[4], [5, 1]);
  assert.equal(page.length, before - 1, 'the campaign row of the emptied dataset is cleared');
  assert.deepEqual(page[page.length - 1], ['Source 1', 'Changed', 5, 1]);
  assert.equal(f.state.batches.length, 2);
  const requests = f.state.batches[1].body.requests;
  assert.equal(requests.filter((request) => request.addSheet || request.addChart).length, 0);
  assert.deepEqual(requests.filter((request) => request.updateChartSpec).map((request) => request.updateChartSpec.chartId), [chartId]);
  assert.deepEqual(f.state.charts.map((chart) => chart.chartId), [chartId], 'the chart is updated in place, not duplicated');
  assert.deepEqual(f.receipts(saved.id).map((receipt) => receipt.rows), [5, 4, rowsOf(f, 'Dashboard report (chart data)').length, page.length]);
});

test('a failed later dataset names itself, preserves every previous output and stores only sanitized errors', () => {
  const f = fixture(),
    saved = f.save();
  f.run(saved.id);
  const before = f.snapshot();
  f.setRows('one', []);
  f.setRows('two', new Error('Source rejected private-dashboard-token'));
  assert.throws(() => f.run(saved.id), /^Error: Source 2: Source rejected \[redacted\]$/);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.state.batches.length, 1);
  assert.equal(f.record(saved.id).runToken, null);
  assert.equal(f.record(saved.id).status, 'error');
  assert.equal(f.record(saved.id).statusMessage, 'Refresh stopped');
  assert.match(f.record(saved.id).lastError, /^Source 2: /);
  assert.ok(!f.record(saved.id).lastError.includes('private-dashboard-token'));
  assert.ok(!JSON.stringify(plain(f.api.dmvListDashboards())).includes('private-dashboard-token'));

  // A tile that cannot be built fails the same way: nothing is half-written.
  f.setRows('two', []);
  assert.throws(() => f.run(saved.id), /"Monthly spend" has no rows to chart/);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.state.batches.length, 1);
});

test('destination occupancy or edited ownership on any tab blocks all writes and new tab creation', () => {
  const f = fixture();
  const report = f.book.insertSheet('Dashboard report');
  f.setCell(report, 1, 1, 'Keep');
  // A taken tab is refused by name before anything is fetched...
  assert.throws(() => f.save(), /The tab "Dashboard report" already exists and has content.*"Dashboard report 2"/);
  assert.equal(f.fetched.length, 0);
  f.setCell(report, 1, 1, '');
  const saved = f.save();
  // ...and one that fills up after the plan was saved still blocks the whole refresh.
  f.setCell(report, 1, 1, 'Keep');
  assert.throws(() => f.run(saved.id), /The tab "Dashboard report" contains existing data/);
  assert.equal(f.tab('Source 1 data'), null);
  assert.equal(f.tab('Source 2 data'), null);
  assert.equal(f.state.batches.length, 0);
  assert.equal(f.state.charts.length, 0);
  assert.deepEqual(f.receipts(saved.id), [null, null, null, null]);
  f.setCell(report, 1, 1, '');
  f.run(saved.id);
  assert.equal(f.tab('Dashboard report').id, report.id, 'an empty existing tab is reused');

  // An edit inside the dashboard tab protects the data tabs too, and the other way round.
  let before = f.snapshot();
  f.setCell(report, 2, 1, 'Manual edit');
  assert.throws(() => f.run(saved.id), /edited or moved/);
  f.setCell(report, 2, 1, before.tabs.find(([name]) => name === 'Dashboard report')[2].find(([key]) => key === '2:1')[1].value);
  assert.deepEqual(f.snapshot(), before);
  const data = f.tab('Source 2 data');
  f.setCell(data, 5, 2, 'Manual edit');
  before = f.snapshot();
  assert.throws(() => f.run(saved.id), /edited or moved/);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.value(data, 5, 2), 'Manual edit');
  assert.equal(f.state.batches.length, 1);
  assert.equal(f.record(saved.id).status, 'error');
});

test('atomic batch failure creates no output tab, chart or ownership receipt and stays retryable', () => {
  const f = fixture(),
    saved = f.save();
  f.state.failBatch = true;
  assert.throws(() => f.run(saved.id), /atomic batch failure/);
  for (const name of f.tabs) assert.equal(f.tab(name), null);
  assert.deepEqual(f.receipts(saved.id), [null, null, null, null]);
  assert.equal(f.state.charts.length, 0);
  assert.equal(f.record(saved.id).status, 'error');
  assert.equal(f.record(saved.id).statusMessage, 'Refresh stopped');
  assert.equal(f.record(saved.id).runToken, null);
  f.state.failBatch = false;
  assert.equal(f.run(saved.id).ok, true);
  assert.equal(f.state.charts.length, 1);
  assert.ok(f.receipts(saved.id).every(Boolean));
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
    for (const name of f.tabs) assert.equal(f.tab(name), null);
    assert.deepEqual(f.receipts(saved.id), [null, null, null, null]);
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

test('the shared deadline bounds all dataset fetches and an expired lease becomes retryable', () => {
  const f = fixture(),
    saved = f.save();
  f.onFetch = () => f.advance(15000);
  assert.throws(() => f.run(saved.id, f.api.Date.now() + 20000), /time limit/);
  assert.equal(f.fetched.length, 1);
  assert.equal(f.state.batches.length, 0);
  assert.throws(() => f.run(saved.id, 'soon'), /valid dashboard deadline/);
  const record = f.record(saved.id);
  record.status = 'running';
  record.runToken = 'abandoned';
  record.startedAt = f.api.Date.now() - 300001;
  f.api.dmvSave_('dashboard', record);
  const card = plain(f.api.dmvListDashboards())[0];
  assert.equal(card.status, 'error');
  assert.match(card.statusMessage, /interrupted\. Refresh again to retry all datasets/);
  f.onFetch = null;
  assert.equal(f.run(saved.id).ok, true);
});

test('dashboard plans and deletion stay isolated to the owning user and workbook, and deletion releases every receipt', () => {
  const f = fixture(),
    saved = f.save();
  f.run(saved.id);
  const other = f.addSpreadsheet('copied', ['Output']);
  f.setActive(other);
  assert.deepEqual(plain(f.api.dmvListDashboards()), []);
  assert.throws(() => f.run(saved.id), /another spreadsheet/);
  assert.throws(() => f.save({ ...f.input, id: saved.id, revision: saved.revision }), /another spreadsheet/);
  assert.throws(() => f.api.dmvDeleteDashboard(saved.id), /another spreadsheet/);
  assert.deepEqual(plain(fixture().api.dmvListDashboards()), []);
  f.setActive(f.book);
  assert.ok(f.receipts(saved.id).every(Boolean));
  assert.deepEqual(plain(f.api.dmvDeleteDashboard(saved.id)), { ok: true, deletedTabs: 4 });
  assert.deepEqual(f.book.sheets.map((sheet) => sheet.name), ['Output'], 'removing a dashboard removes the tabs it created and nothing else');
  assert.deepEqual(f.snapshot().charts, []);
  assert.deepEqual(f.receipts(saved.id), [null, null, null, null]);
  assert.deepEqual(plain(f.api.dmvListDashboards()), []);
});

test('invalid, duplicate, oversized and stale plans fail without provider or sheet actions', () => {
  const f = fixture();
  const chart = (index) => ({ ...f.input.tiles[1], title: 'Chart ' + index });
  for (const [mutate, expected] of [
    [
      (input) => {
        input.datasets[1] = { ...input.datasets[0], id: 'other', label: 'Other', sheetName: 'Other data' };
      },
      /same dataset query twice/,
    ],
    [
      (input) => {
        input.target.sheetName = input.datasets[0].sheetName;
      },
      /its own tab/,
    ],
    [
      (input) => {
        input.datasets[1].sheetName = 'SOURCE 1 DATA';
      },
      /its own tab: SOURCE 1 DATA/,
    ],
    [
      (input) => {
        input.datasets[1].id = 'source0';
      },
      /distinct dataset IDs/,
    ],
    [
      (input) => {
        input.datasets[1].label = 'Source 1';
      },
      /distinct dataset labels/,
    ],
    [
      (input) => {
        input.datasets[0].credentials = { token: 'untrusted' };
      },
      /documented dashboard settings/,
    ],
    [
      (input) => {
        input.datasets[0].mapping[0].key = '__proto__';
      },
      /ordinary mapped column names/,
    ],
    [
      (input) => {
        input.datasets[0].mapping[0].field = 'impressions';
      },
      /Map selected dataset fields only/,
    ],
    [
      (input) => {
        input.datasets[0].maxRows = true;
      },
      /whole number/,
    ],
    [
      (input) => {
        input.tiles[0].metrics[0].agg = 'execute';
      },
      /supported agg/,
    ],
    [
      (input) => {
        input.tiles[1].rankWithin = ['date'];
      },
      /per-group rankings need a table tile/,
    ],
    [
      (input) => {
        input.tiles[2].rankWithin = ['clicks'];
        input.tiles[2].limitPerGroup = 1;
      },
      /rankWithin column must also be in groupBy/,
    ],
    [
      (input) => {
        input.tiles[1].groupBy = ['week'];
      },
      /unknown column "week"\. Mapped columns: date, campaign, spend, clicks, source, currency/,
    ],
    [
      (input) => {
        input.tiles[1].datasets = ['source0', 'missing'];
      },
      /must name dataset IDs of this dashboard/,
    ],
    [
      (input) => {
        delete input.datasets[1].mapping;
      },
      /reads several datasets, so each of them needs a mapping/,
    ],
    [
      (input) => {
        input.tiles.splice(1, 1);
      },
      /at least one chart tile/,
    ],
    // Settings of the earlier single-table design are no longer accepted.
    [
      (input) => {
        input.target.startCell = 'C3';
      },
      /documented dashboard settings: sheetName/,
    ],
    [
      (input) => {
        input.dataTarget = { sheetName: 'Dashboard data', startCell: 'A1' };
      },
      /documented dashboard settings: id, revision, name, datasets, tiles, target/,
    ],
    [
      (input) => {
        input.summary = { groupBy: ['date'], metrics: [{ field: 'spend', agg: 'sum' }] };
      },
      /documented dashboard settings/,
    ],
    [
      (input) => {
        input.datasets = [];
      },
      /between one and six dashboard datasets/,
    ],
    [
      (input) => {
        input.datasets = Array.from({ length: 7 }, (_, index) => ({
          ...input.datasets[index % 2],
          id: 'many' + index,
          label: 'Many ' + index,
          sheetName: 'Many ' + index,
          dateRange: { preset: 'custom', startDate: '2026-08-01', endDate: '2026-08-0' + (index + 1) },
        }));
      },
      /between one and six dashboard datasets/,
    ],
    [
      (input) => {
        input.tiles = Array.from({ length: 13 }, (_, index) => chart(index));
      },
      /between one and twelve dashboard tiles/,
    ],
    [
      (input) => {
        input.tiles[0].metrics = Array.from({ length: 5 }, (_, index) => ({ field: 'spend', agg: ['sum', 'avg', 'min', 'max', 'count'][index] }));
        input.tiles.push({ title: 'More totals', type: 'kpi', metrics: input.tiles[0].metrics.slice(0, 4).map((metric) => ({ ...metric, field: 'clicks' })) });
      },
      /at most eight kpi metrics/,
    ],
    [
      // Incompressible field lists: even a packed plan must fit one private record.
      (input) => {
        input.datasets.forEach((dataset, d) => {
          dataset.fields = Array.from({ length: 80 }, (_, index) =>
            [0, 1, 2].map((part) => createHash('sha256').update([d, index, part].join(':')).digest('hex')).join('').slice(0, 150)
          );
          delete dataset.mapping;
        });
        input.tiles = input.datasets.map((dataset, d) => ({ ...chart(d), datasets: [dataset.id] }));
      },
      /too large to save/,
    ],
  ]) {
    const input = plain(f.input);
    mutate(input);
    assert.throws(() => f.save(input), expected);
  }
  assert.equal(f.fetched.length, 0);
  assert.equal(f.state.batches.length, 0);
  assert.deepEqual(plain(f.api.dmvListDashboards()), []);
  const saved = f.save();
  assert.throws(() => f.save({ ...f.input, id: saved.id, revision: 0 }), /changed/);
  assert.equal(f.save({ ...f.input, id: saved.id, revision: saved.revision }).revision, saved.revision + 1);
});

test('money stays split by currency on scorecards, charts and tables, and a limited table says what it omitted', () => {
  const f = fixture();
  f.currency = { one: 'USD', two: 'EUR' };
  f.input.tiles[2].limit = 1;
  const saved = f.save();
  const result = f.run(saved.id);
  // Money in two currencies is never added together; clicks are.
  assert.deepEqual(result.scorecards, [
    { label: 'Spend (EUR)', value: 7 },
    { label: 'Spend (USD)', value: 3 },
    { label: 'Clicks', value: 6 },
  ]);
  const page = rowsOf(f, 'Dashboard report');
  assert.deepEqual(page.slice(3, 5), [['Spend (EUR)', 'Spend (USD)', 'Clicks'], [7, 3, 6]]);
  const chartData = rowsOf(f, 'Dashboard report (chart data)'),
    monthly = find(chartData, 'Monthly spend');
  assert.deepEqual(chartData.slice(monthly + 1, monthly + 3), [['Date', 'EUR', 'USD'], ['2026-08', 7, 3]]);
  assert.equal(f.state.charts[0].spec.basicChart.series.length, 2, 'one chart series per currency');
  // The table keeps its limit and names it instead of silently dropping groups.
  const campaigns = find(page, 'Campaigns (top 1 of 2)');
  assert.deepEqual(page.slice(campaigns + 1), [
    ['Source', 'Campaign', 'Currency', 'Spend', 'Clicks'],
    ['Source 2', 'Second', 'EUR', 7, 4],
  ]);
  assert.deepEqual(result.tiles[1], { title: 'Campaigns', type: 'table', rows: 1, note: 'top 1 of 2' });
  assert.equal(f.state.batches.length, 1);
});

test('tiles filter their rows and compute ratios from summed counts', () => {
  const f = fixture();
  f.input.tiles = [
    {
      title: 'Totals',
      type: 'kpi',
      metrics: [{ field: 'spend', agg: 'sum' }],
      ratios: [{ key: 'cpc', label: 'CPC', numerator: 'spend', denominator: 'clicks' }],
    },
    {
      title: 'Second only',
      type: 'column',
      groupBy: ['campaign'],
      metrics: [{ field: 'clicks', agg: 'sum' }],
      filters: [{ field: 'source', op: 'eq', value: 'Source 2' }],
    },
    {
      title: 'Efficiency',
      type: 'table',
      groupBy: ['campaign'],
      ratios: [{ key: 'cpc', label: 'CPC', numerator: 'spend', denominator: 'clicks' }],
      orderBy: { field: 'cpc', direction: 'asc' },
    },
  ];
  const saved = f.save();
  assert.deepEqual(plain(f.plan(saved.id).tiles[1].filters), [{ field: 'source', op: 'eq', value: 'Source 2' }]);
  const result = f.run(saved.id);
  assert.deepEqual(result.scorecards, [
    { label: 'Spend (EUR)', value: 10 },
    { label: 'CPC (EUR)', value: 1.6667 },
  ]);
  const chartData = rowsOf(f, 'Dashboard report (chart data)'),
    second = find(chartData, 'Second only');
  assert.deepEqual(chartData.slice(second + 1, second + 3), [['Campaign', 'Clicks'], ['Second', 4]]);
  const page = rowsOf(f, 'Dashboard report'),
    efficiency = find(page, 'Efficiency');
  assert.deepEqual(page.slice(efficiency + 1), [['Campaign', 'CPC'], ['=literal', 1.5], ['Second', 1.75]]);
  f.input.tiles[0].ratios[0].denominator = 'impressions';
  assert.throws(() => f.save(), /"Totals": unknown column "impressions"/);
  f.input.tiles[0].ratios[0].denominator = 'clicks';
  f.input.tiles[1].filters = [{ field: 'source', op: 'like', value: 'x' }];
  assert.throws(() => f.save(), /"Second only": each filter needs field, op/);
});

test('a compare scorecard shows the current dataset with its change against the previous one', () => {
  const f = fixture();
  f.input.tiles[0].compare = { current: 'source1', previous: 'source0' };
  const result = f.run(f.save().id);
  assert.deepEqual(result.scorecards, [
    { label: 'Spend (EUR)', value: 7, previous: 3, change: '+133.3% vs 3' },
    { label: 'Clicks', value: 4, previous: 2, change: '+100% vs 2' },
  ]);
  assert.deepEqual(rowsOf(f, 'Dashboard report').slice(3, 6), [
    ['Spend (EUR)', 'Clicks'],
    [7, 4],
    ['+133.3% vs 3', '+100% vs 2'],
  ]);
  f.input.tiles[0].compare = { current: 'source1', previous: 'missing' };
  assert.throws(() => f.save(), /"Totals": compare belongs on a kpi tile/);
  f.input.tiles[0].compare = undefined;
  f.input.tiles[1].compare = { current: 'source1', previous: 'source0' };
  assert.throws(() => f.save(), /"Monthly spend": compare belongs on a kpi tile/);
});

test('row limits do not make duplicate dataset queries distinct', () => {
  const f = fixture();
  f.input.datasets[1] = {
    ...f.input.datasets[0],
    id: 'duplicate',
    label: 'Duplicate',
    sheetName: 'Duplicate data',
    maxRows: 101,
  };
  assert.throws(() => f.save(), /same dataset query twice/);
  assert.equal(f.fetched.length, 0);
});

test('each dataset allows the larger of its saved row limit and the Settings row cap, and an overflow names the dataset', () => {
  const f = fixture();
  f.api.dmvSaveAiSettings({ provider: 'anthropic', apiKey: 'offline-dashboard-ai-key', maxRows: 2 });
  f.input.datasets[0].maxRows = 1;
  f.input.datasets[1].maxRows = 3;
  const saved = f.save();
  const row = (campaign) => ({ date: '2026-08-01', campaign, spend: 1, clicks: 1 });
  // A cap raised in Settings after the plan was saved applies; a larger saved limit is kept.
  f.setRows('one', [row('A'), row('B')]);
  f.setRows('two', [row('C'), row('D'), row('E')]);
  assert.equal(f.run(saved.id).rowCount, 5);
  assert.deepEqual(f.fetched.map((entry) => entry.maxRows), [2, 3]);
  assert.deepEqual(f.plan(saved.id).datasets.map((dataset) => dataset.maxRows), [1, 3], 'the saved plan keeps its own limits');

  const before = f.snapshot();
  f.setRows('one', [row('A'), row('B'), row('C')]);
  assert.throws(
    () => f.run(saved.id),
    /^Error: Source 1: The report exceeds the row limit\..* This dataset allows 2 rows\. Increase Maximum rows per chat report under Settings > AI provider/
  );
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.state.batches.length, 1);
  assert.match(plain(f.api.dmvListDashboards())[0].lastError, /^Source 1: .*allows 2 rows/);
});

test('ownership journals recover every committed tab after a receipt-storage failure', () => {
  const f = fixture(),
    saved = f.save();
  const set = f.state.user.setProperty;
  let fail = true;
  f.state.user.setProperty = function (key, value) {
    if (fail && key === 'dmv:v1:output:' + f.book.id + ':' + saved.id + '-report')
      throw new Error('Simulated receipt outage');
    return set.call(this, key, value);
  };
  assert.throws(
    () => f.run(saved.id),
    (error) => {
      assert.match(error.message, /tabs were updated.*receipts/);
      assert.equal(error.sheetUpdated, true);
      return true;
    }
  );
  for (const name of f.tabs) assert.ok(f.tab(name));
  assert.equal(f.readOutput(saved.id + '-report'), null);
  assert.equal(f.record(saved.id).status, 'error');
  assert.equal(f.record(saved.id).statusMessage, 'Tabs updated; completion needs recovery');
  const journalKey = 'dmv:v1:write-journal:' + f.book.id;
  assert.ok(f.state.user.getProperty(journalKey));
  assert.equal(JSON.parse(f.state.user.getProperty(journalKey)).receipts.length, 4);
  assert.ok(!f.state.user.getProperty(journalKey).includes('private-dashboard-token'));
  assert.ok(!f.state.user.getProperty(journalKey).includes('=literal'));
  fail = false;
  const ids = f.tabs.map((name) => f.tab(name).id);
  const result = f.run(saved.id);
  assert.equal(result.ok, true);
  assert.equal(f.state.batches.length, 2);
  assert.equal(f.state.batches[1].body.requests.filter((request) => request.addSheet).length, 0);
  assert.deepEqual(f.tabs.map((name) => f.tab(name).id), ids, 'the recovered tabs are refreshed in place');
  assert.equal(f.state.user.getProperty(journalKey), null);
  assert.ok(f.receipts(saved.id).every(Boolean));
  assert.deepEqual(result.datasets.map((dataset) => [dataset.sheetName, dataset.rowCount]), [
    ['Source 1 data', 1],
    ['Source 2 data', 1],
  ]);
  assert.deepEqual(result.tiles.map((tile) => tile.title), ['Monthly spend', 'Campaigns']);
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
  const report = f.tab('Dashboard report');
  f.setCell(report, 2, 3, 'Manual');
  fail = false;
  const before = f.snapshot();
  assert.throws(() => f.run(saved.id), /existing data/);
  assert.equal(f.value(report, 2, 3), 'Manual');
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.readOutput(saved.id + '-report'), null);
  assert.equal(f.state.batches.length, 1);
});

test('combined row and cumulative workbook capacity limits stop every output', () => {
  const f = fixture();
  f.input.datasets.forEach((dataset) => {
    dataset.maxRows = 30000;
  });
  f.setRows(
    'one',
    Array.from({ length: 15001 }, () => ({
      date: '2026-08-01',
      campaign: 'One',
      spend: 1,
      clicks: 1,
    }))
  );
  f.setRows(
    'two',
    Array.from({ length: 15001 }, () => ({
      date: '2026-08-02',
      campaign: 'Two',
      spend: 2,
      clicks: 2,
    }))
  );
  assert.throws(() => f.run(f.save().id), /datasets exceed 30,000 rows together/);
  assert.equal(f.state.batches.length, 0);
  for (const name of f.tabs) assert.equal(f.tab(name), null);
  const g = fixture();
  // Three new tabs of 1,000 x 26 cells each no longer fit beside this one.
  g.book.sheets[0].maxRows = Math.floor((10000000 - 3 * 26000) / 26) + 1;
  assert.throws(() => g.run(g.save().id), /cell capacity/);
  assert.equal(g.state.batches.length, 0);
  for (const name of g.tabs) assert.equal(g.tab(name), null);
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

test('the shared writer commits extra requests in the same batch and refuses outputs that share a receipt', () => {
  const f = fixture(),
    result = f.api.dmvNormalizeResult_(
      { columns: [{ key: 'value', type: 'number' }], rows: [{ value: 2 }] },
      10
    );
  const output = (id, sheetName) => ({
    report: { id, spreadsheetId: f.book.id, target: { sheetName, startCell: 'A1' } },
    result,
  });
  assert.throws(
    () => f.api.dmvWriteReports_(f.book, [output('same', 'First'), output('same', 'Second')]),
    /needs its own id/
  );
  assert.equal(f.state.batches.length, 0);
  let planned;
  f.api.dmvWriteReports_(f.book, [output('first', 'First'), output('second', 'Second')], null, (areas) => {
    planned = plain(areas);
    return [
      {
        updateSheetProperties: {
          properties: { sheetId: areas[1].sheetId, gridProperties: { frozenRowCount: 1 } },
          fields: 'gridProperties.frozenRowCount',
        },
      },
    ];
  });
  assert.equal(f.state.batches.length, 1);
  assert.deepEqual(planned.map((area) => area.sheetId), [f.tab('First').id, f.tab('Second').id], 'new tabs get their planned ids');
  assert.equal(f.tab('Second').frozenRows, 1);
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
      assert.deepEqual(plain(error.links).map((link) => link.label), [
        'Dashboard: Dashboard report',
        'Data: Source 1 data',
        'Data: Source 2 data',
      ]);
      assert.ok(plain(error.links).every((link) => /#gid=\d+&range=A1$/.test(link.url)));
      assert.match(error.message, /tabs were updated/);
      assert.ok(!error.message.includes('Private state outage'));
      return true;
    }
  );
  assert.equal(f.state.batches.length, 1);
  assert.ok(f.receipts(saved.id).every(Boolean));
  assert.equal(f.record(saved.id).status, 'error');
  assert.equal(f.record(saved.id).statusMessage, 'Tabs updated; completion needs recovery');
  assert.equal(f.record(saved.id).runToken, null);
});

test('dashboard refresh freezes all relative periods at one local date across a week boundary', () => {
  const f = fixture();
  f.book.timezone = 'Europe/Athens';
  f.advance(Date.parse('2026-09-20T20:59:59.900Z') - Date.parse('2026-09-18T12:00:00Z'));
  f.input.datasets[0].dateRange = { preset: 'lastWeek' };
  f.input.datasets[1].dateRange = { preset: 'previousWeek' };
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
  // Every tab states the period it actually holds.
  assert.match(rowsOf(f, 'Source 1 data')[1][0], /^2026-09-07 to 2026-09-13 · /);
  assert.match(rowsOf(f, 'Source 2 data')[1][0], /^2026-08-31 to 2026-09-06 · /);
  const page = rowsOf(f, 'Dashboard report'),
    sources = find(page, 'Data sources');
  assert.deepEqual([page[sources + 2][4], page[sources + 3][4]], ['2026-09-07 to 2026-09-13', '2026-08-31 to 2026-09-06']);
  assert.deepEqual(f.plan(saved.id).datasets.map((dataset) => dataset.dateRange), [
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

test('datasets with different columns each get their own tab, and a tile reads one of them under its own column names', () => {
  const f = fixture();
  f.input.datasets = [
    { ...f.input.datasets[0], mapping: undefined },
    {
      id: 'channels',
      label: 'Channels',
      sheetName: 'Channel data',
      connectionId: f.connections[1].id,
      reportType: 'channels',
      fields: ['channel', 'sessions'],
    },
  ];
  delete f.input.datasets[0].mapping;
  f.input.tiles = [
    { title: 'Spend', type: 'kpi', datasets: ['source0'], metrics: [{ field: 'spend', agg: 'sum' }] },
    { title: 'Sessions by channel', type: 'pie', datasets: ['channels'], groupBy: ['channel'], metrics: [{ field: 'sessions', agg: 'sum' }] },
  ];
  const saved = f.save();
  const result = f.run(saved.id);
  assert.equal(f.state.batches.length, 1);
  assert.deepEqual(rowsOf(f, 'Source 1 data').slice(3), [['date', 'campaign', 'spend', 'clicks'], ['2026-08-01', '=literal', 3, 2]]);
  const channels = rowsOf(f, 'Channel data');
  assert.equal(channels[0][0], 'Channels · Fixture source · two · Channels');
  assert.match(channels[1][0], /^No date range · 2 rows · /);
  assert.deepEqual(channels.slice(3), [['Channel', 'Sessions'], ['Organic', 30], ['Paid', 12]]);
  assert.deepEqual(result.datasets.map((dataset) => [dataset.id, dataset.rowCount]), [['source0', 1], ['channels', 2]]);
  assert.equal(result.rowCount, 3);
  assert.deepEqual(result.scorecards, [{ label: 'Spend (EUR)', value: 3 }]);
  const chartData = rowsOf(f, 'Dashboard report (chart data)'),
    pie = find(chartData, 'Sessions by channel');
  assert.deepEqual(chartData.slice(pie + 1), [['Channel', 'Sessions'], ['Organic', 30], ['Paid', 12]]);
  assert.ok(f.state.charts[0].spec.pieChart);
  assert.ok(f.readOutput(saved.id + '-d-channels'));

  // Columns of an unmapped dataset are only known at refresh: a wrong name fails before any write.
  const before = f.snapshot();
  const edited = f.save({
    ...f.input,
    id: saved.id,
    revision: saved.revision,
    tiles: [f.input.tiles[0], { ...f.input.tiles[1], groupBy: ['medium'] }],
  });
  assert.throws(() => f.run(edited.id), /Unknown groupBy column "medium"\. Result columns are: channel, sessions/);
  assert.deepEqual(f.snapshot(), before);
});

test('a dataset dropped from the plan releases its receipt, keeps its tab, and the rest refreshes in place', () => {
  const f = fixture(),
    saved = f.save();
  f.run(saved.id);
  const dropped = plain([...f.tab('Source 2 data').cells]),
    chartId = f.state.charts[0].chartId;
  const edited = f.save({ ...f.input, id: saved.id, revision: saved.revision, datasets: [f.input.datasets[0]] });
  assert.deepEqual(edited.datasets.map((dataset) => dataset.id), ['source0']);
  assert.equal(f.state.batches.length, 1, 'saving a plan writes nothing');
  assert.deepEqual(f.receipts(saved.id).map(Boolean), [true, false, true, true]);
  assert.deepEqual(plain(f.record(saved.id).connectionIds), [f.connections[0].id]);
  assert.deepEqual(plain([...f.tab('Source 2 data').cells]), dropped);

  f.setActive(f.reopen());
  const result = f.run(saved.id);
  assert.deepEqual(result.datasets.map((dataset) => dataset.sheetName), ['Source 1 data']);
  assert.deepEqual(result.scorecards, [{ label: 'Spend (EUR)', value: 3 }, { label: 'Clicks', value: 2 }]);
  assert.deepEqual(plain([...f.tab('Source 2 data').cells]), dropped, 'a tab the dashboard no longer owns is left alone');
  assert.equal(f.readOutput(saved.id + '-d-source1'), null);
  assert.deepEqual(f.state.charts.map((chart) => chart.chartId), [chartId]);
  assert.equal(plain(f.api.dmvListDashboards())[0].statusMessage, 'Updated 1 data tabs and 1 charts');
});

test('a second dashboard cannot take over tabs another dashboard owns', () => {
  const f = fixture(),
    first = f.save();
  f.run(first.id);
  // Tabs another dashboard filled are refused by name as soon as the plan is saved.
  const before = f.snapshot();
  assert.throws(() => f.save({ ...f.input, name: 'Copy of the overview' }), /The tab "Source 1 data" already exists and has content/);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.api.dmvListDashboards().length, 1);
  // Its own tabs are fine.
  const moved = f.save({
    ...f.input,
    name: 'Copy of the overview',
    target: { sheetName: 'Copy report' },
    datasets: f.input.datasets.map((dataset) => ({ ...dataset, sheetName: 'Copy of ' + dataset.sheetName })),
  });
  assert.equal(f.run(moved.id).ok, true);
  assert.equal(f.state.charts.length, 2);
  // Removing the first dashboard removes its tabs and charts, which frees their names; the
  // copy is untouched.
  assert.equal(f.api.dmvDeleteDashboard(first.id).deletedTabs, 4);
  assert.equal(f.state.charts.length, 1);
  assert.ok(f.tab('Copy report'));
  const third = f.save({ ...f.input, name: 'Third' });
  assert.equal(f.run(third.id).ok, true);
  // Keeping the tabs is still possible, and then their names stay taken.
  f.api.dmvDeleteDashboard(third.id, true);
  assert.ok(f.tab('Dashboard report'));
  assert.throws(() => f.save({ ...f.input, name: 'Fourth' }), /already exists and has content/);
});

test('a plan edited to fewer chart tiles removes its surplus chart in the same batch and keeps the others', () => {
  const f = fixture();
  f.input.tiles.push({
    title: 'Clicks by source',
    type: 'bar',
    groupBy: ['source'],
    metrics: [{ field: 'clicks', agg: 'sum' }],
  });
  const saved = f.save();
  assert.equal(saved.chartCount, 2);
  f.run(saved.id);
  const [kept, surplus] = f.state.charts.map((chart) => chart.chartId);
  assert.deepEqual(f.state.charts.map((chart) => [chart.position.overlayPosition.anchorCell.rowIndex, chart.position.overlayPosition.anchorCell.columnIndex]), [[6, 0], [6, 5]]);
  // A chart the user drew on the dashboard tab is not the dashboard's to remove.
  const own = { spreadsheetId: f.book.id, chartId: 900, spec: { title: 'Mine' }, position: { overlayPosition: { anchorCell: { sheetId: f.tab('Dashboard report').id, rowIndex: 60, columnIndex: 0 } } } };
  f.state.charts.push(own);
  const edited = f.save({ ...f.input, id: saved.id, revision: saved.revision, tiles: f.input.tiles.slice(0, 3) });
  assert.equal(edited.chartCount, 1);
  f.setActive(f.reopen());
  assert.equal(f.run(saved.id).chartCount, 1);
  const requests = f.state.batches[1].body.requests;
  assert.deepEqual(requests.filter((request) => request.deleteEmbeddedObject).map((request) => request.deleteEmbeddedObject.objectId), [surplus]);
  assert.ok(requests.some((request) => request.updateCells), 'the chart removal rides in the write batch');
  assert.equal(f.state.batches.length, 2);
  assert.deepEqual(f.state.charts.map((chart) => chart.chartId).sort(), [kept, 900].sort());
  assert.deepEqual(plain(f.record(saved.id).chartIds), [kept]);
  assert.equal(find(rowsOf(f, 'Dashboard report'), 'Clicks by source'), -1, 'the table of the removed tile is cleared');
});

test('a retry after a post-commit failure keeps exactly one native chart per chart tile', () => {
  for (const outage of ['receipt', 'state']) {
    const f = fixture(),
      saved = f.save(),
      set = f.state.user.setProperty;
    let fail = true;
    f.state.user.setProperty = function (key, value) {
      if (fail && outage === 'receipt' && key.endsWith(saved.id + '-report')) throw new Error('Receipt outage');
      if (fail && outage === 'state' && key === 'dmv:v1:dashboard:' + saved.id && JSON.parse(value).status === 'success')
        throw new Error('Private state outage');
      return set.call(this, key, value);
    };
    assert.throws(() => f.run(saved.id), /tabs were updated/);
    assert.equal(f.state.charts.length, 1, 'the committed batch created the chart');
    fail = false;
    assert.equal(f.run(saved.id).ok, true);
    // The message promised a safe retry: it must not stack a second chart on the first.
    assert.equal(f.state.charts.length, 1, outage + ' outage: the retry duplicated the chart');
    assert.deepEqual(plain(f.record(saved.id).chartIds), f.state.charts.map((chart) => chart.chartId));
  }
});
