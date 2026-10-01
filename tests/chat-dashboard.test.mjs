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
          const given = f.rows[id + '.' + reportId] || report.rows;
          // Rows may depend on the period asked for, so one report can hold two periods.
          const rows = typeof given === 'function' ? given(ctx) : given;
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

// The dashboard tab as it reads: each row's non-empty cells in column order.
function pageOf(f, name) {
  const sheet = f.tab(name);
  const out = [];
  for (let r = 1; r <= sheet.getLastRow(); r++) {
    const row = [];
    for (let c = 1; c <= sheet.maxColumns; c++) if (f.value(sheet, r, c) !== '') row.push(f.value(sheet, r, c));
    out.push(row);
  }
  return out;
}

// The rows of the card titled `title`, up to the card's end.
function cardOf(page, title) {
  const at = find(page, title);
  assert.ok(at >= 0, title + ' is on the page');
  const rows = [];
  for (let r = at + 1; r < page.length && page[r].length; r++) rows.push(page[r]);
  return rows;
}

const noBars = (rows) => rows.map((row) => row.filter((value) => !(typeof value === 'string' && /^[█▏▎▍▌▋▊▉]+$/.test(value))));

// A chart sits in the row under its card's title, inside the card's columns.
function assertInCard(f, sheet, chart) {
  const position = chart.position.overlayPosition,
    anchor = position.anchorCell;
  assert.equal(anchor.sheetId, sheet.getSheetId());
  assert.equal(f.value(sheet, anchor.rowIndex, anchor.columnIndex + 1), chart.spec.altText, 'the card title is right above its chart');
  assert.ok(position.offsetXPixels >= 8 && position.offsetYPixels >= 0);
  assert.ok(position.offsetYPixels + position.heightPixels <= f.pixelSize(sheet, 'ROWS', anchor.rowIndex + 1));
}

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
  assert.deepEqual(writes[0].body.requests.filter((request) => request.addSheet).map((request) => request.addSheet.properties.title), ['Google Ads Data', 'Facebook Ads Data', 'Ad groups Data', 'Paid media Dashboard (chart data)', 'Paid media Dashboard']);
  assert.equal(f.tab('Paid media Dashboard (chart data)').hidden, true, 'the numbers behind the charts stay out of the way');
  assert.equal(f.tab('Paid media Dashboard').hidden, false);

  // Data tabs: provenance block, then the dataset as fetched.
  const gads = rowsOf(f, 'Google Ads Data');
  assert.match(gads[0][0], /^Google Ads campaigns · gads fixture · gads account · campaign_daily report$/);
  assert.match(gads[1][0], /^\d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2} · 3 rows · Refreshed .* · Dashboard: Paid media performance$/);
  assert.deepEqual(gads[2], []);
  assert.deepEqual(gads[3], ['Date', 'Campaign', 'Cost', 'Clicks']);
  assert.deepEqual(gads[4], ['2026-08-31', 'Brand', 100, 10]);
  assert.match(rowsOf(f, 'Ad groups Data')[1][0], /^No date range · 2 rows/);

  // Dashboard tab: the band, scorecards, highlights, three chart cards, the table card, the
  // data sources and the footer.
  const report = f.tab('Paid media Dashboard');
  const page = pageOf(f, 'Paid media Dashboard');
  assert.equal(page[1][0], 'Paid media performance');
  assert.match(page[2][0], /^Refreshed \d+ [A-Z][a-z]{2} \d{4}, \d\d:\d\d \S+$/);
  assert.match(page.at(-1)[0], /Refresh dashboard \(no AI needed\)/);
  // Money in two currencies is never added together; clicks are.
  const labels = find(page, 'Spend (AED)');
  assert.deepEqual(page.slice(labels, labels + 2), [['Spend (AED)', 'Spend (USD)', 'Clicks'], [175.5, 100, 36]]);
  const sources = cardOf(page, 'Data sources');
  assert.deepEqual(sources[0], ['Dataset', 'Source', 'Connection', 'Report', 'Date range', 'Rows', 'Tab']);
  assert.deepEqual(sources[1].slice(0, 4).concat(sources[1].slice(5)), ['Google Ads campaigns', 'gads fixture', 'gads account', 'campaign_daily report', 3, 'Google Ads Data']);
  assert.equal(sources[3][4], 'No date range');
  // The largest share of a category chart is stated on the page and returned to the chat.
  assert.deepEqual(run.highlights, ['Clicks by ad group: Shoes holds 63.2% of the total.']);
  assert.deepEqual(cardOf(page, 'Highlights'), [['•  Clicks by ad group: Shoes holds 63.2% of the total.']]);

  // The dashboard shows charts in cards; the numbers behind them live on the hidden tab.
  const data = rowsOf(f, 'Paid media Dashboard (chart data)');
  const clicks = find(data, 'Weekly clicks by platform');
  assert.equal(clicks, 0);
  assert.deepEqual(data[clicks + 1], ['Date', 'Google Ads campaigns', 'Facebook Ads campaigns']);
  // Weeks read as their first days on the axis; the chat reads the dates themselves.
  assert.deepEqual(data[clicks + 2], ['31 Aug', 15, 8]);
  assert.deepEqual(data[clicks + 3], ['7 Sep', 4, 9]);
  assert.equal(run.tiles[0].preview[1][0], '2026-08-31');
  const spend = find(data, 'Weekly spend');
  assert.deepEqual(data[spend + 1], ['Date', 'AED', 'USD'], 'a money chart over two currencies splits into one series per currency');
  assert.deepEqual(data[spend + 2], ['31 Aug', 150, 40]);
  const groups = find(data, 'Clicks by ad group');
  assert.deepEqual(data.slice(groups + 1, groups + 4), [['Ad group', 'Clicks'], ['Shoes', 12], ['Hats', 7]]);
  const table = noBars(cardOf(page, 'Campaigns'));
  assert.deepEqual(table[0], ['Source', 'Campaign name', 'Currency', 'Spend', 'Clicks']);
  assert.deepEqual(table[1], ['Google Ads campaigns', 'Brand', 'AED', 150, 15]);
  assert.deepEqual(table.slice(-2), [['Total', 'AED', 175.5, 19], ['Total', 'USD', 100, 17]], 'one total per currency');

  // Native charts sit in their cards on the dashboard and read the hidden chart data tab.
  const dataId = f.tab('Paid media Dashboard (chart data)').getSheetId();
  f.state.charts.forEach((chart) => assertInCard(f, report, chart));
  assert.equal(f.state.charts[2].spec.basicChart.chartType, 'BAR');
  assert.ok(f.state.charts[2].spec.basicChart.series.every((series) => series.targetAxis === 'BOTTOM_AXIS'), 'Sheets rejects bar series on any other axis');
  assert.equal(f.state.charts.length, 3);
  assert.deepEqual(f.state.charts.map((chart) => chart.spec.altText), ['Weekly clicks by platform', 'Weekly spend', 'Clicks by ad group']);
  const [first, second, third] = f.state.charts.map((chart) => chart.position.overlayPosition.anchorCell);
  assert.equal(first.rowIndex, second.rowIndex, 'two charts share a card row');
  assert.ok(second.columnIndex > first.columnIndex && third.rowIndex > first.rowIndex, 'the third starts the next row');
  const line = f.state.charts[0].spec.basicChart;
  assert.equal(line.chartType, 'LINE');
  assert.equal(line.series.length, 2);
  assert.deepEqual(line.domains[0].domain.sourceRange.sources[0], { sheetId: dataId, startRowIndex: clicks + 1, endRowIndex: clicks + 4, startColumnIndex: 0, endColumnIndex: 1 });
  assert.deepEqual(line.series[1].series.sourceRange.sources[0], { sheetId: dataId, startRowIndex: clicks + 1, endRowIndex: clicks + 4, startColumnIndex: 2, endColumnIndex: 3 });

  // What the user sees: each fetch, then the dashboard with links to every tab.
  assert.deepEqual(reply.events.map((event) => event.kind), ['dashboard', 'report', 'report', 'report', 'dashboard']);
  assert.match(reply.events[1].text, /^Fetched Google Ads campaigns · 3 rows into Google Ads Data$/);
  assert.match(reply.events[4].text, /3 charts, 3 scorecards/);
  // The step's details lead with the highlights, then the scorecards.
  assert.deepEqual(reply.events[4].details.slice(0, 2), [
    { label: 'Highlight', value: 'Clicks by ad group: Shoes holds 63.2% of the total.' },
    { label: 'Spend (AED)', value: '175.5' },
  ]);
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
  const page = pageOf(f, 'Paid media Dashboard');
  assert.deepEqual(page[find(page, 'Spend (AED)') + 1], [175.5, 75, 30]);
  const anchors = () => Object.fromEntries(f.state.charts.map((chart) => [chart.spec.altText, chart.position.overlayPosition.anchorCell]));
  const placed = anchors();
  assert.deepEqual(rowsOf(f, 'Facebook Ads Data').slice(3), [['Day', 'Campaign name', 'Amount spent', 'Link clicks'], ['2026-09-09', 'Retargeting', 75, 11]], 'rows of the previous refresh are cleared');

  // The user deletes one chart by hand: the next refresh adds it back and keeps the others.
  f.state.charts.splice(1, 1);
  plain(f.api.dmvRunDashboard(id));
  assert.deepEqual(f.state.charts.map((chart) => chart.spec.altText).sort(), ['Clicks by ad group', 'Weekly clicks by platform', 'Weekly spend']);
  f.state.charts.forEach((chart) => assertInCard(f, f.tab('Paid media Dashboard'), chart));
  const again = f.state.batches[f.state.batches.length - 1].body.requests;
  assert.equal(again.filter((request) => request.updateChartSpec).length, 2);
  assert.equal(again.filter((request) => request.addChart).length, 1);

  // A later refresh returns more weeks (the range now runs to today): every chart follows.
  const rangeEnd = () => f.state.charts.find((chart) => chart.spec.altText === 'Weekly clicks by platform').spec.basicChart.domains[0].domain.sourceRange.sources[0].endRowIndex;
  const before = rangeEnd();
  f.rows['gads.campaign_daily'] = SOURCES.gads.reports.campaign_daily.rows.concat([
    { 'segments.date': '2026-09-15', 'campaign.name': 'Brand', 'metrics.cost': 10, 'metrics.clicks': 1 },
    { 'segments.date': '2026-09-22', 'campaign.name': 'Brand', 'metrics.cost': 12, 'metrics.clicks': 2 },
  ]);
  plain(f.api.dmvRunDashboard(id));
  assert.equal(rangeEnd(), before + 2, 'two more weekly points, two more rows in the chart range');
  assert.equal(f.state.charts.length, 3);
  assert.deepEqual(anchors(), placed, 'the dashboard page itself does not move: more points stay on the chart data tab');

  const card = plain(f.api.dmvListDashboards())[0];
  assert.equal(card.status, 'success');
  assert.equal(card.statusMessage, 'Updated 3 data tabs and 3 charts');
  assert.deepEqual(card.datasets.map((dataset) => [dataset.sheetName, dataset.rowCount]), [['Google Ads Data', 5], ['Facebook Ads Data', 1], ['Ad groups Data', 2]]);
  assert.ok(card.datasets.every((dataset) => /#gid=\d+/.test(dataset.url)));
  assert.deepEqual(card.datasets.map((dataset) => [dataset.sheetName, dataset.rowCount])[0], ['Google Ads Data', 5]);

  // Removing the dashboard cleans up everything it created, the hidden tab included, and
  // nothing else: a tab the user made stays.
  const mine = f.reopen().insertSheet('My notes');
  f.setCell(mine, 1, 1, 'keep me');
  assert.deepEqual(plain(f.api.dmvDeleteDashboard(id)), { ok: true, deletedTabs: 5 });
  assert.deepEqual(f.book.sheets.map((sheet) => sheet.name), ['Output', 'My notes']);
  assert.equal(f.state.charts.length, 0);
  assert.equal(f.api.dmvListDashboards().length, 0);
  assert.ok(!Object.keys(f.state.user.getProperties()).some((key) => key.includes(':output:')), 'no ownership receipt is left behind');
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

test('save_dashboard offers compare lists, highlight rules and polarity, and run_dashboard returns highlights', () => {
  const f = fixture();
  const current = SOURCES.gads.reports.campaign_daily.rows;
  // The previous 90 days spent less and had one more click.
  f.rows['gads.campaign_daily'] = (ctx) =>
    ctx.startDate < '2026-06-01' ? [{ 'segments.date': '2026-04-01', 'campaign.name': 'Brand', 'metrics.cost': 80, 'metrics.clicks': 20 }] : current;
  const plan = JSON.parse(JSON.stringify(f.plan));
  plan.datasets.push({ ...plan.datasets[0], id: 'gads_prev', label: 'Google Ads campaigns previous', sheetName: 'Google Ads Previous Data', dateRange: { preset: 'previous90' } });
  plan.tiles[0] = {
    title: 'Headline',
    type: 'kpi',
    datasets: ['gads', 'gads_prev'],
    metrics: [{ field: 'spend', agg: 'sum' }, { field: 'clicks', agg: 'sum' }],
    ratios: [{ key: 'cpc', label: 'CPC', numerator: 'spend', denominator: 'clicks' }],
    compare: { current: ['gads'], previous: ['gads_prev'] },
  };
  // A threshold on a metric, then a text rule on a name column.
  const rules = [
    { field: 'clicks', op: 'gte', ofTotal: 0.3, color: 'green' },
    { field: 'campaign_name', op: 'contains', value: 'gen', color: 'red' },
  ];
  plan.tiles[4] = { ...plan.tiles[4], highlight: rules };
  plan.lowerIsBetter = ['cpc'];
  plan.neutral = ['spend'];
  const { reply, results } = scriptedTurn(f, [
    (_results, request) => {
      const save = request.tools.find((item) => item.name === 'save_dashboard');
      const schema = save.input_schema.properties;
      assert.match(save.description, /1 to 8 datasets/);
      assert.equal(schema.datasets.maxItems, 8);
      assert.equal(schema.tiles.items.properties.compare.properties.current.type, 'array');
      assert.equal(schema.tiles.items.properties.compare.properties.previous.type, 'array');
      assert.match(schema.tiles.items.properties.compare.description, /table grouped by names \(not dates\): a Δ % column after each metric and ratio/);
      assert.match(schema.tiles.items.properties.compare.description, /must end the day before the current one starts/);
      assert.match(schema.tiles.items.properties.type.description, /share or a breakdown by category .* use bar/);
      const rule = schema.tiles.items.properties.highlight.items.properties;
      assert.deepEqual(rule.op.enum, ['gt', 'gte', 'lt', 'lte', 'eq', 'ne', 'contains', 'in']);
      // A threshold is a number; a groupBy column is matched by text.
      assert.deepEqual(rule.value.anyOf, [{ type: 'number' }, { type: 'string' }]);
      assert.match(rule.field.description, /or one of its groupBy columns/);
      assert.match(rule.op.description, /eq, ne, contains or in for a groupBy column/);
      assert.match(rule.ofTotal.description, /^Metrics and ratios only/);
      assert.match(schema.tiles.items.properties.highlight.description, /A groupBy column takes a text value, for example \{field: "performance_label", op: "eq", value: "LOW", color: "red"\}/);
      assert.deepEqual(rule.color.enum, ['red', 'green', 'amber']);
      assert.equal(schema.tiles.items.properties.highlight.maxItems, 4);
      assert.equal(schema.lowerIsBetter.type, 'array');
      assert.equal(schema.neutral.type, 'array');
      assert.match(request.tools.find((item) => item.name === 'run_dashboard').description, /highlights/);
      return [tool('save', 'save_dashboard', plan)];
    },
    (results) => {
      assert.notEqual(results.get('save').is_error, true, JSON.stringify(results.get('save').value));
      return [tool('run', 'run_dashboard', { id: results.get('save').value.id })];
    },
    (results) => {
      assert.notEqual(results.get('run').is_error, true, JSON.stringify(results.get('run').value));
      return [answer()];
    },
  ]);
  const run = results.get('run').value;
  // A falling click count is bad, a rising cost per click is bad, spend only changes.
  assert.deepEqual(run.scorecards.map((card) => [card.label, card.tone]), [
    ['Spend (AED)', 'neutral'],
    ['Clicks', 'bad'],
    ['CPC (AED)', 'bad'],
  ]);
  // The cards show every change; with rule findings to state, the highlights keep only the
  // largest change. The rule says its threshold, per currency here, since the table's money is
  // split, and names the campaigns first: their source follows only where it tells rows apart.
  assert.deepEqual(run.highlights.slice(0, 1), ['CPC (AED) rose 130.9% to 9.24 (previous 4.00).']);
  assert.equal(run.highlights[1], 'Campaigns: 3 of 4 rows have Clicks at or above 0.3× the overall of their currency (green rows) — Brand, Retargeting, Prospecting.');
  const refreshed = reply.events.find((event) => event.action === 'refreshed');
  assert.deepEqual(refreshed.details.slice(0, 2).map((detail) => detail.label), ['Highlight', 'Highlight']);
  assert.equal(refreshed.details[0].value, run.highlights[0]);
  const saved = plain(f.api.dmvUnpack_(f.api.dmvDashboardHere_(results.get('save').value.id).plan));
  assert.deepEqual([saved.lowerIsBetter, saved.neutral], [['cpc'], ['spend']]);
  assert.deepEqual(saved.tiles[4].highlight, rules);
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

test('an eight-dataset plan with wide field lists fits one private record and refreshes in one batch', () => {
  const f = createDatamoovSandbox();
  const columns = Array.from({ length: 24 }, (_, index) => ({ key: 'metrics.some_long_provider_field_name_' + index, label: 'Field ' + index, type: index ? 'number' : 'text', role: index ? 'metric' : 'dimension' }));
  const row = Object.fromEntries(columns.map((column, index) => [column.key, index ? index : 'Item']));
  f.api.dmvRegisterConnector_({ id: 'wide', label: 'Wide', category: 'Test', allowedHosts: [], authFields: [{ key: 'token', label: 'Token', type: 'password', required: true }],
    reports: Array.from({ length: 8 }, (_, index) => ({ id: 'report' + index, label: 'Report ' + index, fields: columns, dateRange: true, configFields: [], fetch: () => ({ columns, rows: [row], metadata: { complete: true } }) })) });
  const connection = f.api.dmvSaveConnection({ connectorId: 'wide', label: 'Wide account', credentials: { token: SOURCE_KEY } });
  const plan = {
    name: 'Wide dashboard',
    target: { sheetName: 'Wide Dashboard' },
    datasets: Array.from({ length: 8 }, (_, index) => ({ id: 'd' + index, label: 'Dataset ' + index, sheetName: 'Data ' + index, connectionId: connection.id, reportType: 'report' + index, fields: columns.map((column) => column.key) })),
    tiles: Array.from({ length: 12 }, (_, index) => ({ title: 'Tile ' + index, type: 'column', datasets: ['d' + (index % 8)], groupBy: [columns[0].key], metrics: [{ field: columns[1 + index].key, agg: 'sum' }] })),
    lowerIsBetter: [columns[1].key],
    neutral: [columns[2].key],
  };
  assert.ok(JSON.stringify(plan).length > 8000, 'the plain plan alone would not fit a record');
  const saved = plain(f.api.dmvSaveDashboard(plan));
  assert.equal(saved.datasets.length, 8);
  const record = f.state.user.getProperty('dmv:v1:dashboard:' + saved.id);
  assert.ok(Buffer.byteLength(record) < 8000);
  assert.ok(!record.includes(SOURCE_KEY));
  // Eight data tabs, the chart data tab and the dashboard tab are written together.
  const result = plain(f.api.dmvRunDashboard(saved.id));
  assert.equal(result.chartCount, 12);
  assert.equal(f.state.batches.length, 1);
  assert.equal(f.state.batches[0].body.requests.filter((request) => request.addSheet).length, 10);
  assert.equal(f.state.charts.length, 12);
});

test('a dashboard saved by the earlier single-table version asks to be recreated instead of failing obscurely', () => {
  const f = fixture();
  f.state.user.setProperty('dmv:v1:dashboard:legacy-1', JSON.stringify({ id: 'legacy-1', spreadsheetId: f.book.getId(), revision: 2, name: 'Old dashboard', sources: [{ label: 'A', connectionId: f.connections.gads.id }, { label: 'B', connectionId: f.connections.meta.id }], summary: {}, dataTarget: { sheetName: 'Old data', startCell: 'A1' }, target: { sheetName: 'Old report', startCell: 'A1' }, status: 'success' }));
  const card = plain(f.api.dmvListDashboards())[0];
  assert.equal(card.legacy, true);
  assert.equal(card.status, 'error');
  assert.match(card.lastError, /earlier version.*create it again/);
  assert.throws(() => f.api.dmvRunDashboard('legacy-1'), /earlier version/);
  assert.throws(() => f.api.dmvDeleteConnection(f.connections.gads.id), /reports and dashboards using this source/);
  f.api.dmvDeleteDashboard('legacy-1');
  assert.equal(f.api.dmvListDashboards().length, 0);
});
