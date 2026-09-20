import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatamoovSandbox, plain } from './helpers/datamoov-sandbox.mjs';

const AI_KEY = 'offline-dashboard-chat-ai-key';
const SOURCE_KEY = 'offline-dashboard-source-secret';

// Two ad platforms with their own column names and currencies, plus a second subject (ad
// groups) of the first platform: the shape of "a performance dashboard for Google Ads and
// Facebook Ads".
const SOURCES = {
  gads: {
    currency: 'AED',
    reports: {
      campaign_daily: {
        columns: [
          { key: 'segments.date', label: 'Date', type: 'date', role: 'dimension' },
          { key: 'campaign.name', label: 'Campaign', type: 'text', role: 'dimension' },
          { key: 'metrics.cost', label: 'Cost', type: 'currency', role: 'metric' },
          { key: 'metrics.clicks', label: 'Clicks', type: 'number', role: 'metric' },
        ],
        rows: [
          { 'segments.date': '2026-08-31', 'campaign.name': 'Brand', 'metrics.cost': 100, 'metrics.clicks': 10 },
          { 'segments.date': '2026-09-01', 'campaign.name': 'Brand', 'metrics.cost': 50, 'metrics.clicks': 5 },
          { 'segments.date': '2026-09-08', 'campaign.name': 'Generic', 'metrics.cost': 25.5, 'metrics.clicks': 4 },
        ],
      },
      ad_groups: {
        dateRange: false,
        columns: [
          { key: 'ad_group.name', label: 'Ad group', type: 'text', role: 'dimension' },
          { key: 'metrics.clicks', label: 'Clicks', type: 'number', role: 'metric' },
        ],
        rows: [
          { 'ad_group.name': 'Shoes', 'metrics.clicks': 12 },
          { 'ad_group.name': 'Hats', 'metrics.clicks': 7 },
        ],
      },
    },
  },
  meta: {
    currency: 'USD',
    reports: {
      insights: {
        columns: [
          { key: 'date_start', label: 'Day', type: 'date', role: 'dimension' },
          { key: 'campaign_name', label: 'Campaign name', type: 'text', role: 'dimension' },
          { key: 'spend', label: 'Amount spent', type: 'currency', role: 'metric' },
          { key: 'clicks', label: 'Link clicks', type: 'number', role: 'metric' },
        ],
        rows: [
          { date_start: '2026-09-01', campaign_name: 'Prospecting', spend: 40, clicks: 8 },
          { date_start: '2026-09-09', campaign_name: 'Retargeting', spend: 60, clicks: 9 },
        ],
      },
    },
  },
};

function fixture({ maxRows = 100 } = {}) {
  const f = createDatamoovSandbox();
  f.fetched = [];
  f.rows = {};
  f.connections = {};
  for (const [id, source] of Object.entries(SOURCES)) {
    f.api.dmvRegisterConnector_({
      id,
      label: id + ' fixture',
      category: 'Test',
      allowedHosts: [],
      authFields: [{ key: 'token', label: 'Token', type: 'password', required: true }],
      reports: Object.entries(source.reports).map(([reportId, report]) => ({
        id: reportId,
        label: reportId + ' report',
        fields: report.columns,
        dateRange: report.dateRange !== false,
        configFields: [],
        fetch(ctx) {
          f.fetched.push({ source: id, report: reportId, maxRows: ctx.maxRows, startDate: ctx.startDate, endDate: ctx.endDate });
          const rows = f.rows[id + '.' + reportId] || report.rows;
          if (rows instanceof Error) throw rows;
          const columns = report.columns.filter((column) => ctx.fields.includes(column.key));
          return { columns, rows, metadata: { complete: true, currency: source.currency } };
        },
      })),
    });
    f.connections[id] = f.api.dmvSaveConnection({
      connectorId: id,
      label: id + ' account',
      credentials: { token: SOURCE_KEY },
    });
  }
  f.api.dmvSaveAiSettings({ provider: 'anthropic', apiKey: AI_KEY, maxRows });
  f.plan = {
    name: 'Paid media performance',
    target: { sheetName: 'Paid media Dashboard' },
    datasets: [
      {
        id: 'gads',
        label: 'Google Ads campaigns',
        sheetName: 'Google Ads Data',
        connectionId: f.connections.gads.id,
        reportType: 'campaign_daily',
        dateRange: { preset: 'last90' },
        fields: ['segments.date', 'campaign.name', 'metrics.cost', 'metrics.clicks'],
        mapping: [
          { field: 'segments.date', key: 'date' },
          { field: 'campaign.name', key: 'campaign_name' },
          { field: 'metrics.cost', key: 'spend' },
          { field: 'metrics.clicks', key: 'clicks' },
        ],
      },
      {
        id: 'meta',
        label: 'Facebook Ads campaigns',
        sheetName: 'Facebook Ads Data',
        connectionId: f.connections.meta.id,
        reportType: 'insights',
        dateRange: { preset: 'last90' },
        fields: ['date_start', 'campaign_name', 'spend', 'clicks'],
        mapping: [
          { field: 'date_start', key: 'date' },
          { field: 'campaign_name', key: 'campaign_name' },
          { field: 'spend', key: 'spend' },
          { field: 'clicks', key: 'clicks' },
        ],
      },
      {
        id: 'adgroups',
        label: 'Google Ads ad groups',
        sheetName: 'Ad groups Data',
        connectionId: f.connections.gads.id,
        reportType: 'ad_groups',
        fields: ['ad_group.name', 'metrics.clicks'],
      },
    ],
    tiles: [
      { title: 'Headline', type: 'kpi', datasets: ['gads', 'meta'], metrics: [{ field: 'spend', agg: 'sum' }, { field: 'clicks', agg: 'sum' }] },
      { title: 'Weekly clicks by platform', type: 'line', datasets: ['gads', 'meta'], groupBy: ['date', 'source'], dateBucket: 'week', metrics: [{ field: 'clicks', agg: 'sum' }] },
      { title: 'Weekly spend', type: 'column', datasets: ['gads', 'meta'], groupBy: ['date'], dateBucket: 'week', metrics: [{ field: 'spend', agg: 'sum' }] },
      { title: 'Clicks by ad group', type: 'bar', datasets: ['adgroups'], groupBy: ['ad_group.name'], metrics: [{ field: 'metrics.clicks', agg: 'sum' }] },
      { title: 'Campaigns', type: 'table', datasets: ['gads', 'meta'], groupBy: ['source', 'campaign_name'], metrics: [{ field: 'spend', agg: 'sum' }, { field: 'clicks', agg: 'sum' }], orderBy: { field: 'clicks__sum', direction: 'desc' } },
    ],
  };
  return f;
}

const tool = (id, name, input) => ({ type: 'tool_use', id, name, input });
const answer = (text = 'The dashboard is ready. Refresh it from Reports > Dashboards.') => ({ type: 'text', text });

function scriptedTurn(f, stages, text = 'Create a performance dashboard for Google Ads and Facebook Ads.') {
  const fetch = f.api.UrlFetchApp.fetch;
  const results = new Map();
  let index = 0;
  f.api.UrlFetchApp.fetch = (url, options) => {
    const request = JSON.parse(options.payload);
    for (const message of request.messages)
      for (const block of Array.isArray(message.content) ? message.content : [])
        if (block.type === 'tool_result') results.set(block.tool_use_id, { ...block, value: JSON.parse(block.content) });
    assert.ok(index < stages.length, 'the chat must finish within the scripted plan');
    const content = stages[index++](results, request);
    f.state.responses.push({ body: { content, stop_reason: content.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn' } });
    return fetch(url, options);
  };
  try {
    const reply = plain(f.api.dmvChat({ text, transcript: [] }));
    assert.equal(index, stages.length);
    return { reply, results };
  } finally {
    f.api.UrlFetchApp.fetch = fetch;
  }
}

function buildDashboard(f) {
  return scriptedTurn(f, [
    () => [tool('list', 'list_dashboards', {})],
    () => [tool('save', 'save_dashboard', f.plan)],
    (results) => {
      assert.notEqual(results.get('save').is_error, true, JSON.stringify(results.get('save').value));
      return [tool('run', 'run_dashboard', { id: results.get('save').value.id })];
    },
    (results) => {
      assert.notEqual(results.get('run').is_error, true, JSON.stringify(results.get('run').value));
      return [answer()];
    },
  ]);
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

test('one chat turn builds every data tab, the scorecards, the charts and their tables in one atomic write', () => {
  const f = fixture();
  const { reply, results } = buildDashboard(f);
  const saved = results.get('save').value,
    run = results.get('run').value;

  assert.equal(saved.datasets.length, 3);
  assert.equal(saved.chartCount, 3);
  assert.equal(saved.reportUrl, null, 'saving a plan alone creates no output');
  assert.deepEqual(f.fetched.map((entry) => entry.source + '.' + entry.report), ['gads.campaign_daily', 'meta.insights', 'gads.ad_groups'], 'each dataset is fetched exactly once');
  assert.ok(f.fetched.slice(0, 2).every((entry) => entry.startDate === '2026-06-22' || /^\d{4}-\d{2}-\d{2}$/.test(entry.startDate)));

  const writes = f.state.batches.filter((entry) => entry.body.requests.some((request) => request.updateCells));
  assert.equal(writes.length, 1, 'all tabs and charts are committed together');
  assert.equal(f.state.batches.length, 1, 'no separate chart call is needed');
  assert.deepEqual(writes[0].body.requests.filter((request) => request.addSheet).map((request) => request.addSheet.properties.title), ['Google Ads Data', 'Facebook Ads Data', 'Ad groups Data', 'Paid media Dashboard']);

  // Data tabs: provenance block, then the dataset as fetched.
  const gads = rowsOf(f, 'Google Ads Data');
  assert.match(gads[0][0], /^Google Ads campaigns · gads fixture · gads account · campaign_daily report$/);
  assert.match(gads[1][0], /^\d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2} · 3 rows · Refreshed .* · Dashboard: Paid media performance$/);
  assert.deepEqual(gads[2], []);
  assert.deepEqual(gads[3], ['Date', 'Campaign', 'Cost', 'Clicks']);
  assert.deepEqual(gads[4], ['2026-08-31', 'Brand', 100, 10]);
  assert.match(rowsOf(f, 'Ad groups Data')[1][0], /^No date range · 2 rows/);

  // Dashboard tab.
  const page = rowsOf(f, 'Paid media Dashboard');
  assert.equal(page[0][0], 'Paid media performance');
  assert.match(page[1][0], /^Refreshed .*Refresh dashboard/);
  // Money in two currencies is never added together; clicks are.
  assert.deepEqual(page[3], ['Spend (AED)', 'Spend (USD)', 'Clicks']);
  assert.deepEqual(page[4], [175.5, 100, 36]);
  const sources = find(page, 'Data sources');
  assert.equal(sources, 6 + 2 * 17, 'three charts reserve two bands of rows');
  assert.deepEqual(page[sources + 1], ['Dataset', 'Source', 'Connection', 'Report', 'Date range', 'Rows', 'Tab']);
  assert.deepEqual(page[sources + 2].slice(0, 4).concat(page[sources + 2].slice(5)), ['Google Ads campaigns', 'gads fixture', 'gads account', 'campaign_daily report', 3, 'Google Ads Data']);
  assert.equal(page[sources + 4][4], 'No date range');

  const clicks = find(page, 'Weekly clicks by platform');
  assert.deepEqual(page[clicks + 1], ['Date', 'Google Ads campaigns', 'Facebook Ads campaigns']);
  assert.deepEqual(page[clicks + 2], ['2026-08-31', 15, 8]);
  assert.deepEqual(page[clicks + 3], ['2026-09-07', 4, 9]);
  const spend = find(page, 'Weekly spend');
  assert.deepEqual(page[spend + 1], ['Date', 'AED', 'USD'], 'a money chart over two currencies splits into one series per currency');
  assert.deepEqual(page[spend + 2], ['2026-08-31', 150, 40]);
  const groups = find(page, 'Clicks by ad group');
  assert.deepEqual(page.slice(groups + 1, groups + 4), [['Ad group', 'Clicks'], ['Shoes', 12], ['Hats', 7]]);
  const table = find(page, 'Campaigns');
  assert.deepEqual(page[table + 1], ['Source', 'Campaign name', 'Currency', 'Spend', 'Clicks']);
  assert.deepEqual(page[table + 2], ['Google Ads campaigns', 'Brand', 'AED', 150, 15]);

  // Native charts sit in the reserved band and read the tables on the same tab.
  const dashboardId = f.tab('Paid media Dashboard').getSheetId();
  assert.equal(f.state.charts.length, 3);
  assert.deepEqual(f.state.charts.map((chart) => chart.spec.title), ['Weekly clicks by platform', 'Weekly spend', 'Clicks by ad group']);
  assert.deepEqual(f.state.charts.map((chart) => [chart.position.overlayPosition.anchorCell.rowIndex, chart.position.overlayPosition.anchorCell.columnIndex]), [[6, 0], [6, 5], [23, 0]]);
  const line = f.state.charts[0].spec.basicChart;
  assert.equal(line.chartType, 'LINE');
  assert.equal(line.series.length, 2);
  assert.deepEqual(line.domains[0].domain.sourceRange.sources[0], { sheetId: dashboardId, startRowIndex: clicks + 1, endRowIndex: clicks + 4, startColumnIndex: 0, endColumnIndex: 1 });
  assert.deepEqual(line.series[1].series.sourceRange.sources[0], { sheetId: dashboardId, startRowIndex: clicks + 1, endRowIndex: clicks + 4, startColumnIndex: 2, endColumnIndex: 3 });

  // What the user sees: each fetch, then the dashboard with links to every tab.
  assert.deepEqual(reply.events.map((event) => event.kind), ['dashboard', 'report', 'report', 'report', 'dashboard']);
  assert.match(reply.events[1].text, /^Fetched Google Ads campaigns · 3 rows into Google Ads Data$/);
  assert.match(reply.events[4].text, /3 charts, 3 scorecards/);
  assert.deepEqual(reply.events[4].links.map((link) => link.label), ['Dashboard: Paid media Dashboard', 'Data: Google Ads Data', 'Data: Facebook Ads Data', 'Data: Ad groups Data']);
  assert.ok(reply.events[4].links.every((link) => /#gid=\d+&range=A1$/.test(link.url)));
  assert.deepEqual(run.scorecards, [{ label: 'Spend (AED)', value: 175.5 }, { label: 'Spend (USD)', value: 100 }, { label: 'Clicks', value: 36 }]);

  for (const call of f.state.http) {
    assert.ok(!call.options.payload.includes(AI_KEY));
    assert.ok(!call.options.payload.includes(SOURCE_KEY));
  }
  assert.ok(!JSON.stringify(reply).includes(SOURCE_KEY));
  assert.ok(!JSON.stringify(plain(f.api.dmvListDashboards())).includes(SOURCE_KEY));
});

test('Refresh dashboard rebuilds everything without AI, updates its charts in place and restores a deleted one', () => {
  const f = fixture();
  const { results } = buildDashboard(f);
  const id = results.get('save').value.id;
  f.api.dmvDeleteAiSettings();
  f.setActive(f.reopen());
  const http = f.state.http.length;
  f.rows['meta.insights'] = [{ date_start: '2026-09-09', campaign_name: 'Retargeting', spend: 75, clicks: 11 }];
  f.fetched.length = 0;

  const first = plain(f.api.dmvRunDashboard(id));
  assert.equal(f.state.http.length, http, 'a refresh makes no AI call');
  assert.equal(f.fetched.length, 3);
  assert.equal(first.chartCount, 3);
  assert.equal(f.state.charts.length, 3, 'existing charts are updated, not duplicated');
  const refresh = f.state.batches[f.state.batches.length - 1].body.requests;
  assert.equal(refresh.filter((request) => request.updateChartSpec).length, 3);
  assert.equal(refresh.filter((request) => request.addChart || request.addSheet).length, 0);
  const page = rowsOf(f, 'Paid media Dashboard');
  assert.deepEqual(page[4], [175.5, 75, 30]);
  assert.deepEqual(rowsOf(f, 'Facebook Ads Data').slice(3), [['Day', 'Campaign name', 'Amount spent', 'Link clicks'], ['2026-09-09', 'Retargeting', 75, 11]], 'rows of the previous refresh are cleared');

  // The user deletes one chart by hand: the next refresh adds it back and keeps the others.
  f.state.charts.splice(1, 1);
  plain(f.api.dmvRunDashboard(id));
  assert.deepEqual(f.state.charts.map((chart) => chart.spec.title).sort(), ['Clicks by ad group', 'Weekly clicks by platform', 'Weekly spend']);
  const again = f.state.batches[f.state.batches.length - 1].body.requests;
  assert.equal(again.filter((request) => request.updateChartSpec).length, 2);
  assert.equal(again.filter((request) => request.addChart).length, 1);

  const card = plain(f.api.dmvListDashboards())[0];
  assert.equal(card.status, 'success');
  assert.equal(card.statusMessage, 'Updated 3 data tabs and 3 charts');
  assert.deepEqual(card.datasets.map((dataset) => [dataset.sheetName, dataset.rowCount]), [['Google Ads Data', 3], ['Facebook Ads Data', 1], ['Ad groups Data', 2]]);
  assert.ok(card.datasets.every((dataset) => /#gid=\d+/.test(dataset.url)));
});

test('a failing dataset names itself, reaches the model as a tool error and leaves no tab behind', () => {
  const f = fixture();
  f.rows['meta.insights'] = new Error('Provider rejected token ' + SOURCE_KEY);
  const { reply, results } = scriptedTurn(f, [
    () => [tool('save', 'save_dashboard', f.plan)],
    (results) => [tool('run', 'run_dashboard', { id: results.get('save').value.id })],
    (results) => {
      assert.equal(results.get('run').is_error, true);
      return [answer('The Facebook dataset failed, so nothing was written.')];
    },
  ]);
  assert.match(results.get('run').value.error, /^Facebook Ads campaigns: /);
  assert.ok(!JSON.stringify(results.get('run').value).includes(SOURCE_KEY));
  assert.equal(f.tab('Google Ads Data'), null);
  assert.equal(f.tab('Paid media Dashboard'), null);
  assert.equal(f.state.charts.length, 0);
  assert.ok(!reply.events.some((event) => event.kind === 'write'));
  const card = plain(f.api.dmvListDashboards())[0];
  assert.equal(card.status, 'error');
  assert.match(card.lastError, /^Facebook Ads campaigns: /);
});

test('plans teach the model: charts are required, several datasets need mappings, unknown columns list the real ones', () => {
  const f = fixture();
  const save = (change) => {
    const plan = JSON.parse(JSON.stringify(f.plan));
    change(plan);
    return () => f.api.dmvSaveDashboard(plan);
  };
  assert.throws(save((plan) => { plan.tiles = plan.tiles.filter((tile) => ['kpi', 'table'].includes(tile.type)); }), /at least one chart tile/);
  assert.throws(save((plan) => { delete plan.datasets[1].mapping; }), /reads several datasets, so each of them needs a mapping/);
  assert.throws(save((plan) => { plan.tiles[1].groupBy = ['week', 'source']; }), /unknown column "week"\. Mapped columns: date, campaign_name, spend, clicks, source, currency/);
  assert.throws(save((plan) => { plan.datasets[2].sheetName = 'paid media dashboard'; }), /its own tab/);
  assert.throws(save((plan) => { plan.tiles[1].metrics.push({ field: 'spend', agg: 'sum' }); }), /exactly one metric/);
  assert.throws(save((plan) => { plan.summary = {}; }), /documented dashboard settings: id, revision, name, datasets, tiles, target/);
  assert.equal(f.api.dmvListDashboards().length, 0);
  assert.equal(f.fetched.length, 0);
});

test('a six-dataset plan with wide field lists still fits one private record', () => {
  const f = createDatamoovSandbox();
  const columns = Array.from({ length: 24 }, (_, index) => ({ key: 'metrics.some_long_provider_field_name_' + index, label: 'Field ' + index, type: index ? 'number' : 'text', role: index ? 'metric' : 'dimension' }));
  f.api.dmvRegisterConnector_({ id: 'wide', label: 'Wide', category: 'Test', allowedHosts: [], authFields: [{ key: 'token', label: 'Token', type: 'password', required: true }],
    reports: Array.from({ length: 6 }, (_, index) => ({ id: 'report' + index, label: 'Report ' + index, fields: columns, dateRange: true, configFields: [], fetch: () => ({ columns, rows: [], metadata: { complete: true } }) })) });
  const connection = f.api.dmvSaveConnection({ connectorId: 'wide', label: 'Wide account', credentials: { token: SOURCE_KEY } });
  const plan = {
    name: 'Wide dashboard',
    target: { sheetName: 'Wide Dashboard' },
    datasets: Array.from({ length: 6 }, (_, index) => ({ id: 'd' + index, label: 'Dataset ' + index, sheetName: 'Data ' + index, connectionId: connection.id, reportType: 'report' + index, fields: columns.map((column) => column.key) })),
    tiles: Array.from({ length: 12 }, (_, index) => ({ title: 'Tile ' + index, type: 'column', datasets: ['d' + (index % 6)], groupBy: [columns[0].key], metrics: [{ field: columns[1 + index].key, agg: 'sum' }] })),
  };
  assert.ok(JSON.stringify(plan).length > 8000, 'the plain plan alone would not fit a record');
  const saved = plain(f.api.dmvSaveDashboard(plan));
  assert.equal(saved.datasets.length, 6);
  const record = f.state.user.getProperty('dmv:v1:dashboard:' + saved.id);
  assert.ok(Buffer.byteLength(record) < 8000);
  assert.ok(!record.includes(SOURCE_KEY));
});

test('a dashboard saved by the earlier single-table version asks to be recreated instead of failing obscurely', () => {
  const f = fixture();
  f.state.user.setProperty('dmv:v1:dashboard:legacy-1', JSON.stringify({ id: 'legacy-1', spreadsheetId: f.book.getId(), revision: 2, name: 'Old dashboard', sources: [{ label: 'A', connectionId: f.connections.gads.id }, { label: 'B', connectionId: f.connections.meta.id }], summary: {}, dataTarget: { sheetName: 'Old data', startCell: 'A1' }, target: { sheetName: 'Old report', startCell: 'A1' }, status: 'success' }));
  const card = plain(f.api.dmvListDashboards())[0];
  assert.equal(card.legacy, true);
  assert.equal(card.status, 'error');
  assert.match(card.lastError, /earlier version.*create it again/);
  assert.throws(() => f.api.dmvRunDashboard('legacy-1'), /earlier version/);
  assert.throws(() => f.api.dmvDeleteConnection(f.connections.gads.id), /reports and dashboards using this connection/);
  f.api.dmvDeleteDashboard('legacy-1');
  assert.equal(f.api.dmvListDashboards().length, 0);
});
