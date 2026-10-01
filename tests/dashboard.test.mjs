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
          // Rows may depend on the period asked for, so one account can hold two periods.
          const rows = typeof outputs[name] === 'function' ? outputs[name](ctx) : outputs[name];
          if (rows instanceof Error) throw rows;
          return {
            columns,
            rows,
            metadata: { complete: true, currency: f.currency?.[name] || 'EUR', ...f.metadata?.[name] },
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

// Every non-empty row of a data tab, trimmed of trailing blanks, for readable layout assertions.
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

// The dashboard tab as it reads: each row's non-empty cells in column order. A merged cell holds
// its text in its first cell only, so a row reads like the page.
function pageOf(f, name = 'Dashboard report') {
  const sheet = f.tab(name);
  const out = [];
  for (let r = 1; r <= sheet.getLastRow(); r++) {
    const row = [];
    for (let c = 1; c <= sheet.maxColumns; c++) if (f.value(sheet, r, c) !== '') row.push(f.value(sheet, r, c));
    out.push(row);
  }
  return out;
}

// A card on the page: the rows under its title row (header, rows, totals) up to the card's end.
function cardOf(page, title) {
  const at = find(page, title);
  assert.ok(at >= 0, title + ' is on the page');
  const rows = [];
  for (let r = at + 1; r < page.length && page[r].length; r++) rows.push(page[r]);
  return rows;
}

const isBar = (value) => typeof value === 'string' && /^[█▏▎▍▌▋▊▉]+$/.test(value);
// Table rows without their in-cell bars, which tests check apart.
const noBars = (rows) => rows.map((row) => row.filter((value) => !isBar(value)));
const rgb = (hex) => ({ red: parseInt(hex.slice(1, 3), 16) / 255, green: parseInt(hex.slice(3, 5), 16) / 255, blue: parseInt(hex.slice(5, 7), 16) / 255 });
const NAVY = rgb('#0d366b'), WHITE = rgb('#ffffff'), GOOD = rgb('#006300'), BAD = rgb('#c62828'), GREY = rgb('#6b7280');
const columnNumber = (letters) => letters.split('').reduce((sum, ch) => sum * 26 + ch.charCodeAt(0) - 64, 0);
// The 1-based [row, column] of the first cell (in row order) holding value.
function cellOf(sheet, value) {
  const found = [...sheet.cells].filter(([, cell]) => cell.value === value).map(([key]) => key.split(':').map(Number));
  return found.sort((a, b) => a[0] - b[0] || a[1] - b[1])[0] || null;
}
// A chart sits inside its card: in the row under the card's title, within the card's columns,
// which run from its title merge through the note merge beside it.
function assertInCard(f, sheet, chart, title) {
  const position = chart.position.overlayPosition,
    anchor = position.anchorCell;
  assert.equal(anchor.sheetId, sheet.getSheetId());
  assert.equal(f.value(sheet, anchor.rowIndex, anchor.columnIndex + 1), title, 'the card title is right above the chart');
  const spans = f.merges(sheet)
    .map((merge) => /^([A-Z]+)(\d+):([A-Z]+)\d+$/.exec(merge))
    .filter((match) => Number(match[2]) === anchor.rowIndex)
    .map((match) => [columnNumber(match[1]), columnNumber(match[3])]);
  const first = anchor.columnIndex + 1;
  const heading = spans.find(([start]) => start === first);
  const note = spans.find(([start]) => start === heading[1] + 1);
  let width = 0;
  for (let c = first; c <= note[1]; c++) width += f.pixelSize(sheet, 'COLUMNS', c);
  assert.ok(position.offsetXPixels >= 8 && position.offsetXPixels + position.widthPixels <= width - 8, 'the chart stays inside its card');
  assert.ok(position.offsetYPixels + position.heightPixels <= f.pixelSize(sheet, 'ROWS', anchor.rowIndex + 1), 'the chart row holds the chart');
  assert.deepEqual(f.format(sheet, anchor.rowIndex + 1, first).backgroundColor, WHITE, 'cards are white');
}

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
  // Each tile carries a short preview so the chat can state findings, not only what was built.
  assert.deepEqual(result.tiles, [
    { title: 'Monthly spend', type: 'column', rows: 1, preview: [['Date', 'Spend'], ['2026-08', 10]] },
    {
      title: 'Campaigns',
      type: 'table',
      rows: 2,
      preview: [
        ['Source', 'Campaign', 'Spend', 'Clicks'],
        ['Source 2', 'Second', 7, 4],
        ['Source 1', '=literal', 3, 2],
      ],
    },
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

  // Dashboard tab: a navy band with the name and period, a link per section, scorecards, the
  // chart card, the table card with its total, then the data sources and a footer.
  const report = f.tab('Dashboard report');
  const page = pageOf(f);
  assert.deepEqual(page[1], ['Marketing overview', '1 Aug – 31 Aug 2026']);
  assert.match(page[2][0], /^Refreshed 18 Sep 2026, \d\d:\d\d \S+$/);
  assert.deepEqual(f.format(report, 2, 2).backgroundColor, NAVY);
  assert.deepEqual(f.format(report, 2, 2).textFormat.foregroundColor, WHITE);
  // Twelve content columns with a gap column between each two, between two margins; the tab
  // hides its gridlines and keeps the band and the section links in view.
  assert.deepEqual(Array.from({ length: 26 }, (_, i) => f.pixelSize(report, 'COLUMNS', i + 1)), [20, ...Array(11).fill([88, 16]).flat(), 88, 20, 100]);
  assert.equal(report.hiddenGridlines, true);
  assert.equal(report.frozenRows, 5);
  assert.deepEqual(report.tabColor, { rgbColor: NAVY });
  const nav = page.findIndex((row) => row.includes('Data sources'));
  assert.deepEqual(page[nav], ['Overview', 'Highlights', 'Charts', 'Campaigns', 'Data sources']);
  // Highlights are stated from the numbers on the page, without AI, and returned to the chat.
  assert.deepEqual(result.highlights, ['Second leads Campaigns with EUR 7.00 spend (70.0% of the total).']);
  assert.deepEqual(cardOf(page, 'Highlights'), [['•  Second leads Campaigns with EUR 7.00 spend (70.0% of the total).']]);
  const labels = find(page, 'Spend (EUR)');
  assert.deepEqual(page.slice(labels, labels + 2), [['Spend (EUR)', 'Clicks'], [10, 6]], 'value cells hold the values');
  const spend = cellOf(report, 10);
  assert.deepEqual(f.format(report, ...spend).numberFormat, { type: 'NUMBER', pattern: '#,##0.00' });
  assert.equal(f.format(report, ...spend).textFormat.fontSize, 22);
  const campaigns = cardOf(page, 'Campaigns');
  assert.deepEqual(noBars(campaigns), [
    ['Source', 'Campaign', 'Spend (EUR)', 'Clicks'],
    ['Source 2', 'Second', 7, 4],
    ['Source 1', '=literal', 3, 2],
    ['Total', 10, 6],
  ]);
  assert.ok(isBar(campaigns[1][3]) && isBar(campaigns[2][3]) && campaigns[1][3].length > campaigns[2][3].length, 'the bar follows the ranked spend');
  assert.equal(campaigns[1][3], '█'.repeat(15), 'the largest value fills the bar column');
  // Only the full block: Sheets draws partial blocks from a fallback font of another height.
  assert.equal(campaigns[2][3], '█'.repeat(6), '3 of 7 rounds to 6 of 15 whole blocks');
  const [literalRow, literalColumn] = cellOf(report, '=literal');
  assert.equal(f.formula(report, literalRow, literalColumn), '', 'formula-like text stays text');
  assert.deepEqual(cardOf(page, 'Data sources'), [
    ['Dataset', 'Source', 'Connection', 'Report', 'Date range', 'Rows', 'Tab'],
    ['Source 1', 'Fixture source', 'one', 'Daily', '1 Aug – 31 Aug 2026', 1, 'Source 1 data'],
    ['Source 2', 'Fixture source', 'two', 'Daily', '1 Aug – 31 Aug 2026', 1, 'Source 2 data'],
  ]);
  assert.ok(find(page, 'Monthly spend') > labels && find(page, 'Campaigns') > find(page, 'Monthly spend'), 'scorecards, then charts, then tables');
  assert.ok(find(page, 'Data sources') > find(page, 'Campaigns'));
  assert.match(page.at(-1)[0], /^To refresh: .*Refresh dashboard \(no AI needed\)/);
  // Each link jumps to its section's first row. Its look and its target are one format, so
  // Sheets keeps the bar's colour rather than its default link colour.
  for (const [label, target] of [['Overview', 'Spend (EUR)'], ['Highlights', 'Highlights'], ['Charts', 'Monthly spend'], ['Campaigns', 'Campaigns'], ['Data sources', 'Data sources']]) {
    const column = Array.from({ length: 25 }, (_, i) => i + 1).find((c) => f.value(report, nav + 1, c) === label);
    const look = f.format(report, nav + 1, column);
    assert.equal(look.textFormat.link.uri, '#gid=' + report.getSheetId() + '&range=A' + (find(page, target) + 1));
    assert.deepEqual(look.textFormat.foregroundColor, rgb('#2a78d6'));
  }
  const linkFormats = requests.filter((request) => request.repeatCell && /textFormat\.link/.test(request.repeatCell.fields));
  assert.ok(linkFormats.length && linkFormats.every((request) => /textFormat\.foregroundColor/.test(request.repeatCell.fields)));
  // The numbers behind a chart live on the hidden chart data tab, not under the chart.
  const chartData = rowsOf(f, 'Dashboard report (chart data)');
  assert.equal(f.tab('Dashboard report (chart data)').hidden, true);
  const monthly = find(chartData, 'Monthly spend');
  assert.deepEqual(chartData.slice(monthly + 1, monthly + 3), [['Date', 'Spend'], ['Aug 2026', 10]], 'a month bucket reads as its month');

  // The chart sits in its card on the dashboard, with its title in the card, and reads the
  // chart data tab.
  assert.equal(f.state.charts.length, 1);
  const chart = f.state.charts[0];
  assertInCard(f, report, chart, 'Monthly spend');
  assert.equal(chart.spec.title, '');
  assert.equal(chart.spec.altText, 'Monthly spend');
  assert.deepEqual(chart.border, { colorStyle: { rgbColor: WHITE } });
  assert.equal(chart.spec.basicChart.chartType, 'COLUMN');
  assert.deepEqual(chart.spec.basicChart.series[0].colorStyle, { rgbColor: rgb('#2a78d6') });
  assert.deepEqual(chart.spec.basicChart.series[0].dataLabel.type, 'DATA', 'a single short column series is labelled');
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

  // One ownership receipt per tab; the combined data tab of the earlier design is gone. The
  // dashboard's covers the whole page, gutters included.
  assert.deepEqual(f.receipts(saved.id).slice(0, 3).map((receipt) => [receipt.sheetId, receipt.rows]), [
    [one.getSheetId(), 5],
    [f.tab('Source 2 data').getSheetId(), 5],
    [f.tab('Dashboard report (chart data)').getSheetId(), chartData.length],
  ]);
  const area = f.receipts(saved.id)[3];
  assert.deepEqual([area.sheetId, area.row, area.column, area.columns], [report.getSheetId(), 1, 1, 25]);
  // A new dashboard tab comes before its data tabs, where it is found first.
  assert.deepEqual(f.book.sheets.map((sheet) => sheet.name).slice(-4), ['Dashboard report', 'Source 1 data', 'Source 2 data', 'Dashboard report (chart data)']);
  assert.ok(area.rows >= page.length);
  assert.equal(f.readOutput(saved.id + '-data'), null);
  assert.ok(!JSON.stringify(result).includes('private-dashboard-token'));
});

test('refresh fetches fresh datasets again, preserves stable tabs and charts, and clears owned trailing rows', () => {
  const f = fixture(),
    saved = f.save();
  f.run(saved.id);
  const ids = f.tabs.map((name) => f.tab(name).id),
    chartId = f.state.charts[0].chartId,
    before = pageOf(f).length;
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
  const page = pageOf(f);
  assert.deepEqual(page[find(page, 'Spend (EUR)') + 1], [5, 1]);
  assert.ok(page.length < before, 'the page shrinks with its data');
  assert.equal(cellOf(f.tab('Dashboard report'), 'Second'), null, 'the campaign row of the emptied dataset is cleared');
  assert.deepEqual(noBars(cardOf(page, 'Campaigns')).slice(1), [['Source 1', 'Changed', 5, 1], ['Total', 5, 1]]);
  assert.equal(find(page, 'Highlights'), -1, 'a single row leads nothing, so the highlights card goes');
  assert.equal(f.state.batches.length, 2);
  const requests = f.state.batches[1].body.requests;
  assert.equal(requests.filter((request) => request.addSheet || request.addChart).length, 0);
  assert.deepEqual(requests.filter((request) => request.updateChartSpec).map((request) => request.updateChartSpec.chartId), [chartId]);
  assert.deepEqual(f.state.charts.map((chart) => chart.chartId), [chartId], 'the chart is updated in place, not duplicated');
  assertInCard(f, f.tab('Dashboard report'), f.state.charts[0], 'Monthly spend');
  assert.deepEqual(f.receipts(saved.id).slice(0, 3).map((receipt) => receipt.rows), [5, 4, rowsOf(f, 'Dashboard report (chart data)').length]);
  assert.ok(f.receipts(saved.id)[3].rows >= page.length);
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

  // A period without rows is not an error: every card stays, saying so, and the refresh goes on.
  f.setRows('two', []);
  const empty = f.run(saved.id);
  assert.equal(f.state.batches.length, 2);
  assert.deepEqual(empty.scorecards.map((card) => [card.label, card.value]), [['Spend', 0], ['Clicks', 0]]);
  const page = pageOf(f);
  assert.deepEqual(page[find(page, 'Spend') + 1], [0, 0], 'sums of nothing are 0');
  assert.deepEqual(page[find(page, 'Monthly spend')], ['Monthly spend', 'no rows in this period']);
  assert.deepEqual(cardOf(page, 'Campaigns'), [['Source', 'Campaign', 'Spend', 'Clicks'], ['No rows in this period']]);
  assert.equal(f.state.charts.length, 1, 'the chart stays, drawn empty');
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

  // An edit inside the dashboard tab protects the data tabs too, and the other way round. A merged
  // title cell and a blank gutter cell of the page count as much as a table value.
  let before = f.snapshot();
  f.setCell(report, 2, 2, 'Manual edit');
  assert.throws(() => f.run(saved.id), /edited or moved/);
  f.setCell(report, 2, 2, 'Marketing overview');
  assert.deepEqual(f.snapshot(), before);
  f.setCell(report, 4, 1, 'Note');
  assert.throws(() => f.run(saved.id), /edited or moved/);
  report.cells.delete('4:1');
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
      /between one and eight dashboard datasets/,
    ],
    [
      (input) => {
        input.datasets = Array.from({ length: 9 }, (_, index) => ({
          ...input.datasets[index % 2],
          id: 'many' + index,
          label: 'Many ' + index,
          sheetName: 'Many ' + index,
          dateRange: { preset: 'custom', startDate: '2026-08-01', endDate: '2026-08-0' + (index + 1) },
        }));
      },
      /between one and eight dashboard datasets/,
    ],
    // Compare sides are datasets of the tile, a side may list several, and no dataset is on both.
    [
      (input) => {
        input.tiles[0].compare = { current: ['source0'], previous: ['source0', 'source1'] };
      },
      /"Totals": compare names current and previous, each a dataset id of this tile or a list of them, with no dataset on both sides/,
    ],
    [
      (input) => {
        input.tiles[0].compare = { current: 'source1', previous: [] };
      },
      /"Totals": compare names current and previous/,
    ],
    [
      (input) => {
        input.tiles[2].compare = { current: ['source1'], previous: ['source1'] };
      },
      /"Campaigns": compare names current and previous/,
    ],
    [
      (input) => {
        input.tiles.push({ title: 'By campaign', type: 'bar', groupBy: ['campaign'], metrics: [{ field: 'spend', agg: 'sum' }], compare: { current: 'source1', previous: 'source0' } });
      },
      /"By campaign": compare belongs on a kpi or table tile, or on a line, area or column chart over one date groupBy column, not stacked/,
    ],
    [
      (input) => {
        Object.assign(input.tiles[1], { stacked: true, compare: { current: 'source1', previous: 'source0' } });
      },
      /"Monthly spend": compare belongs on a kpi or table tile/,
    ],
    [
      (input) => {
        input.tiles[1].metrics = [{ field: 'campaign', agg: 'count_distinct' }];
        input.tiles[1].compare = { current: 'source1', previous: 'source0' };
      },
      /"Monthly spend": a compared chart adds days up into buckets/,
    ],
    // Highlight rules: table tiles only, a value of the tile, one threshold kind, a known colour.
    [
      (input) => {
        input.tiles[1].highlight = [{ field: 'spend', op: 'gt', value: 1, color: 'red' }];
      },
      /"Monthly spend": highlight rules belong on a table tile/,
    ],
    ...[
      { field: 'spend', op: 'between', value: 1, color: 'red' },
      { field: 'spend', op: 'contains', value: 'x', color: 'red' },
      { field: 'spend', op: 'gt', value: '1', color: 'red' },
      { field: 'spend', op: 'gt', value: 1, ofTotal: 2, color: 'red' },
      { field: 'spend', op: 'gt', color: 'red' },
      { field: 'spend', op: 'gt', ofTotal: 0, color: 'red' },
      { field: 'spend', op: 'gt', value: 1, color: 'purple' },
    ].map((rule) => [
      (input) => {
        input.tiles[2].highlight = [rule];
      },
      /"Campaigns": each highlight on a metric field or ratio key needs op \(gt, gte, lt, lte or eq\), exactly one of value \(a number\) or ofTotal/,
    ]),
    // A groupBy column is matched by text: a text op and value, never a multiple of a total.
    ...[
      { field: 'campaign', op: 'gt', value: 1, color: 'red' },
      { field: 'campaign', op: 'lte', value: 'B', color: 'red' },
      { field: 'campaign', op: 'eq', value: 1, color: 'red' },
      { field: 'campaign', op: 'in', value: '  ', color: 'red' },
      { field: 'campaign', op: 'eq', color: 'red' },
      { field: 'campaign', op: 'eq', value: 'A', color: 'blue' },
    ].map((rule) => [
      (input) => {
        input.tiles[2].highlight = [rule];
      },
      /"Campaigns": "campaign" is a groupBy column, so its highlight needs op \(eq, ne, contains or in\), a text value \(comma-separated for in\) and color/,
    ]),
    [
      (input) => {
        input.tiles[2].highlight = [{ field: 'campaign', op: 'eq', ofTotal: 2, color: 'red' }];
      },
      /"Campaigns": ofTotal is a multiple of an overall number, so it applies to metric fields and ratio keys; "campaign" is a groupBy column, matched by a text value/,
    ],
    // A column of the dataset that this tile neither groups by nor measures.
    [
      (input) => {
        input.tiles[2].highlight = [{ field: 'date', op: 'eq', value: '2026-08-01', color: 'red' }];
      },
      /"Campaigns": highlight field "date" is not a metric field, ratio key or groupBy column of this tile/,
    ],
    [
      (input) => {
        input.tiles[2].highlight = Array.from({ length: 5 }, () => ({ field: 'spend', op: 'gt', value: 1, color: 'red' }));
      },
      /"Campaigns": use one to four highlight rules/,
    ],
    // Polarity names a value in one list only.
    [
      (input) => {
        input.lowerIsBetter = ['spend'];
        input.neutral = ['spend'];
      },
      /either lowerIsBetter or neutral, not both/,
    ],
    [
      (input) => {
        input.neutral = ['clicks', 'clicks'];
      },
      /Choose distinct neutral names/,
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
  f.setRows('one', [
    { date: '2026-08-01', campaign: '=literal', spend: 3, clicks: 2 },
    { date: '2026-08-05', campaign: 'Third', spend: 1, clicks: 1 },
  ]);
  f.input.tiles[2].limit = 1;
  const saved = f.save();
  const result = f.run(saved.id);
  // Money in two currencies is never added together; clicks are.
  assert.deepEqual(result.scorecards, [
    { label: 'Spend (EUR)', value: 7 },
    { label: 'Spend (USD)', value: 4 },
    { label: 'Clicks', value: 7 },
  ]);
  const page = pageOf(f);
  const labels = find(page, 'Spend (EUR)');
  assert.deepEqual(page.slice(labels, labels + 2), [['Spend (EUR)', 'Spend (USD)', 'Clicks'], [7, 4, 7]]);
  const chartData = rowsOf(f, 'Dashboard report (chart data)'),
    monthly = find(chartData, 'Monthly spend');
  assert.deepEqual(chartData.slice(monthly + 1, monthly + 3), [['Date', 'EUR', 'USD'], ['Aug 2026', 7, 4]]);
  assert.equal(f.state.charts[0].spec.basicChart.series.length, 2, 'one chart series per currency');
  // Amounts in two currencies are never ranked against each other: the limit applies within
  // each currency, says so, and the totals cover every group, one row per currency.
  assert.deepEqual(page[find(page, 'Campaigns')], ['Campaigns', 'top 1 per currency of 3']);
  assert.deepEqual(noBars(cardOf(page, 'Campaigns')), [
    ['Source', 'Campaign', 'Currency', 'Spend', 'Clicks'],
    ['Source 2', 'Second', 'EUR', 7, 4],
    ['Source 1', '=literal', 'USD', 3, 2],
    ['Total (all 3)', 'EUR', 7, 4],
    ['Total (all 3)', 'USD', 4, 3],
  ]);
  assert.deepEqual(result.tiles[1], {
    title: 'Campaigns',
    type: 'table',
    rows: 2,
    note: 'top 1 per currency of 3',
    preview: [
      ['Source', 'Campaign', 'Currency', 'Spend', 'Clicks'],
      ['Source 2', 'Second', 'EUR', 7, 4],
      ['Source 1', '=literal', 'USD', 3, 2],
    ],
  });
  assert.equal(f.state.batches.length, 1);
});

test('a mixed-currency chart ranks its categories within each currency, and a table of currencies alone has no total row', () => {
  const f = fixture();
  f.currency = { one: 'JPY', two: 'EUR' };
  // Yen amounts are large numbers, never larger amounts: ranked together they would take every
  // place of the chart.
  f.setRows('one', ['J1', 'J2', 'J3'].map((campaign, i) => ({ date: '2026-08-01', campaign, spend: 9000 - i * 1000, clicks: 1 })));
  f.setRows('two', ['E1', 'E2', 'E3'].map((campaign, i) => ({ date: '2026-08-01', campaign, spend: 30 - i * 10, clicks: 1 })));
  f.input.tiles[1] = { title: 'Spend by campaign', type: 'bar', groupBy: ['campaign'], metrics: [{ field: 'spend', agg: 'sum' }], limit: 4 };
  f.input.tiles[2] = { title: 'By currency', type: 'table', groupBy: ['currency'], metrics: [{ field: 'spend', agg: 'sum' }] };
  const saved = f.save();
  f.run(saved.id);
  const chartData = rowsOf(f, 'Dashboard report (chart data)');
  const at = find(chartData, 'Spend by campaign (top 4 of 6)');
  assert.deepEqual(chartData.slice(at + 2, at + 6).map((line) => line[0]), ['J1', 'E1', 'J2', 'E2'], 'the best of each currency first');
  assert.deepEqual(noBars(cardOf(pageOf(f), 'By currency')), [['Currency', 'Spend'], ['JPY', 24000], ['EUR', 60]], 'each row is a currency total already');
});

test('a tile preview keeps whole headers and the first rows, or the latest points of a trend, within a size budget', () => {
  const f = fixture();
  const header = ['Month', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  const rows = Array.from({ length: 8 }, (_, i) => ['2026-0' + (i + 1), 1, 2, 3, 4, 5, 6, 7, 8]);
  const trend = plain(f.api.dmvDashboardPreview_({ matrix: [header, ...rows], dated: true }));
  assert.deepEqual(trend.map((row) => row[0]), ['Month', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08']);
  assert.ok(trend.every((row) => row.length === 8), 'at most eight columns');
  // Headers name the series (a dataset label and its currency), so they are never cut.
  const label = 'Google Ads account with a long descriptive name · EUR';
  const long = 'x'.repeat(60);
  const ranked = plain(f.api.dmvDashboardPreview_({ matrix: [['Name', label], [long, 9], ...rows], dated: false }));
  assert.equal(ranked.length, 6, 'header plus five rows');
  assert.equal(ranked[0][1], label);
  assert.equal(ranked[1][0], 'x'.repeat(40) + '…');
  // Wide text rows are dropped until the tile fits its budget; a trend drops its oldest rows.
  const wide = Array.from({ length: 5 }, (_, i) => [String(i), ...Array(7).fill('y'.repeat(40))]);
  const tight = plain(f.api.dmvDashboardPreview_({ matrix: [header.slice(0, 8), ...wide], dated: true }));
  assert.ok(JSON.stringify(tight).length <= 1200);
  assert.ok(tight.length >= 2 && tight.length < 6);
  assert.equal(tight.at(-1)[0], '4', 'the latest point is kept');
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
    { label: 'CPC (EUR)', value: 1.66666666667 },
  ]);
  const chartData = rowsOf(f, 'Dashboard report (chart data)'),
    second = find(chartData, 'Second only');
  assert.deepEqual(chartData.slice(second + 1, second + 3), [['Campaign', 'Clicks'], ['Second', 4]]);
  // The total is the overall ratio of the summed counts (10 / 6), not an average of the rows.
  assert.deepEqual(cardOf(pageOf(f), 'Efficiency'), [['Campaign', 'CPC (EUR)'], ['=literal', 1.5], ['Second', 1.75], ['Total', 1.66666666667]]);
  f.input.tiles[0].ratios[0].denominator = 'impressions';
  assert.throws(() => f.save(), /"Totals": unknown column "impressions"/);
  f.input.tiles[0].ratios[0].denominator = 'clicks';
  f.input.tiles[1].filters = [{ field: 'source', op: 'like', value: 'x' }];
  assert.throws(() => f.save(), /"Second only": each filter needs field, op/);
});

test('a compare scorecard shows the current dataset with its change against the previous one', () => {
  const f = fixture();
  f.input.datasets[0].dateRange = { preset: 'previousMonth' };
  f.input.tiles[0].compare = { current: 'source1', previous: 'source0' };
  const result = f.run(f.save().id);
  // The chat reads each change as the card prints it.
  assert.deepEqual(result.scorecards, [
    { label: 'Spend (EUR)', value: 7, previous: 3, change: '+133.3% vs 3.00', tone: 'good' },
    { label: 'Clicks', value: 4, previous: 2, change: '+100.0% vs 2', tone: 'good' },
  ]);
  const page = pageOf(f),
    labels = find(page, 'Spend (EUR)');
  assert.deepEqual(page.slice(labels, labels + 3), [
    ['Spend (EUR)', 'Clicks'],
    [7, 4],
    ['▲ 133.3% vs 3.00', '▲ 100.0% vs 2'],
  ]);
  assert.deepEqual(f.format(f.tab('Dashboard report'), ...cellOf(f.tab('Dashboard report'), '▲ 133.3% vs 3.00')).textFormat.foregroundColor, GOOD);
  // The two largest changes lead the highlights, in words.
  assert.deepEqual(result.highlights.slice(0, 2), [
    'Spend (EUR) rose 133.3% to 7.00 (previous 3.00).',
    'Clicks rose 100.0% to 4 (previous 2).',
  ]);
  f.input.tiles[0].compare = { current: 'source1', previous: 'missing' };
  assert.throws(() => f.save(), /"Totals": compare names current and previous/);
});

// Four datasets: two accounts in two months. Rows depend on the period each dataset asks for.
function periodsFixture(rows) {
  const f = fixture();
  for (const account of ['one', 'two']) f.setRows(account, (ctx) => rows[account][ctx.startDate.slice(0, 7)] || []);
  const [one, two] = f.input.datasets;
  f.input.datasets = [
    one,
    two,
    { ...one, id: 'prev0', label: 'Source 1 previous', sheetName: 'Source 1 previous data', dateRange: { preset: 'previousMonth' } },
    { ...two, id: 'prev1', label: 'Source 2 previous', sheetName: 'Source 2 previous data', dateRange: { preset: 'previousMonth' } },
  ];
  f.compare = { current: ['source0', 'source1'], previous: ['prev0', 'prev1'] };
  return f;
}

test('compare lists add up every account of a period, so scorecard ratios are true ratios across accounts', () => {
  const f = periodsFixture({
    one: { '2026-08': [{ date: '2026-08-03', campaign: 'A', spend: 30, clicks: 10 }], '2026-07': [{ date: '2026-07-01', campaign: 'A', spend: 20, clicks: 4 }] },
    two: { '2026-08': [{ date: '2026-08-04', campaign: 'B', spend: 10, clicks: 30 }], '2026-07': [{ date: '2026-07-02', campaign: 'B', spend: 4, clicks: 4 }] },
  });
  f.input.tiles[0] = {
    title: 'Totals',
    type: 'kpi',
    metrics: [{ field: 'spend', agg: 'sum' }],
    ratios: [{ key: 'cpc', label: 'CPC', numerator: 'spend', denominator: 'clicks' }],
    compare: f.compare,
  };
  // The prompt's generic lists name costs this dashboard lacks; those names are dropped.
  f.input.lowerIsBetter = ['cpa', 'cpc', 'cpm', 'cost_per_conversion'];
  f.input.neutral = ['spend', 'cost', 'budget'];
  const saved = f.save();
  assert.deepEqual(plain(f.plan(saved.id)).lowerIsBetter, ['cpc'], 'polarity is kept in the packed plan');
  assert.deepEqual(plain(f.plan(saved.id)).neutral, ['spend']);
  const result = f.run(saved.id);
  // CPC is 40 / 40 against 24 / 8, not an average of each account's CPC (1.67 against 3).
  assert.deepEqual(result.scorecards, [
    { label: 'Spend (EUR)', value: 40, previous: 24, change: '+66.7% vs 24.00', tone: 'neutral' },
    { label: 'CPC (EUR)', value: 1, previous: 3, change: '-66.7% vs 3.00', tone: 'good' },
  ]);
  const report = f.tab('Dashboard report');
  const page = pageOf(f),
    labels = find(page, 'Spend (EUR)');
  assert.deepEqual(page[labels + 2], ['▲ 66.7% vs 24.00', '▼ 66.7% vs 3.00']);
  assert.deepEqual(f.format(report, ...cellOf(report, '▲ 66.7% vs 24.00')).textFormat.foregroundColor, GREY, 'neutral spend is grey');
  assert.deepEqual(f.format(report, ...cellOf(report, '▼ 66.7% vs 3.00')).textFormat.foregroundColor, GOOD, 'a falling cost is good');
  // The band names the current period and the one it is compared with.
  assert.deepEqual(page[1].slice(1), ['1 Aug – 31 Aug 2026']);
  assert.equal(page[2][1], 'vs 1 Jul – 31 Jul 2026');
  assert.deepEqual(result.highlights.slice(0, 2), [
    'Spend (EUR) rose 66.7% to 40.00 (previous 24.00).',
    'CPC (EUR) fell 66.7% to 1.00 (previous 3.00).',
  ]);
});

test('a compared table adds a change column after each value, matched by its groupBy values', () => {
  const f = periodsFixture({
    one: {
      '2026-08': [{ date: '2026-08-03', campaign: 'A', spend: 30, clicks: 10 }, { date: '2026-08-03', campaign: 'New', spend: 5, clicks: 5 }],
      '2026-07': [{ date: '2026-07-01', campaign: 'A', spend: 20, clicks: 4 }, { date: '2026-07-01', campaign: 'Paused', spend: 9, clicks: 9 }],
    },
    two: { '2026-08': [{ date: '2026-08-04', campaign: 'B', spend: 10, clicks: 30 }], '2026-07': [{ date: '2026-07-02', campaign: 'B', spend: 8, clicks: 40 }] },
  });
  f.input.tiles[2] = {
    title: 'Campaigns',
    type: 'table',
    groupBy: ['source', 'campaign'],
    metrics: [{ field: 'spend', agg: 'sum' }],
    ratios: [{ key: 'cpc', label: 'CPC', numerator: 'spend', denominator: 'clicks' }],
    orderBy: { field: 'spend__sum', direction: 'desc' },
    compare: f.compare,
  };
  f.input.lowerIsBetter = ['cpc'];
  const saved = f.save();
  f.run(saved.id);
  const report = f.tab('Dashboard report');
  // Previous rows meet their own account: each previous dataset takes the label of the current
  // one of the same connection. A row without a previous value has a blank change. Totals
  // compare the overall values; changes are rounded only where they are printed.
  assert.deepEqual(noBars(cardOf(pageOf(f), 'Campaigns')), [
    ['Source', 'Campaign', 'Spend (EUR)', 'Δ %', 'CPC (EUR)', 'Δ %'],
    ['Source 1', 'A', 30, 0.5, 3, -0.4],
    ['Source 2', 'B', 10, 0.25, 0.333333333333, 0.66666667],
    ['Source 1', 'New', 5, 1],
    ['Total', 45, 0.21621622, 1, 0.43243243],
  ]);
  const change = cellOf(report, 0.5);
  assert.deepEqual(f.format(report, ...change).numberFormat, { type: 'PERCENT', pattern: '"▲ "0.0%;"▼ "0.0%;"▶ "0.0%' });
  assert.deepEqual(f.format(report, ...change).textFormat.foregroundColor, GOOD);
  assert.deepEqual(f.format(report, ...cellOf(report, -0.4)).textFormat.foregroundColor, GOOD, 'a falling CPC is good');
  assert.deepEqual(f.format(report, ...cellOf(report, 0.66666667)).textFormat.foregroundColor, BAD, 'a rising CPC is bad');
  // Darker shading is better: the lowest cost per click is the darkest.
  assert.deepEqual(f.format(report, ...cellOf(report, 0.333333333333)).backgroundColor, rgb('#9ec5f4'));

  // Previous datasets listed in the other order still meet their own account.
  f.compare.previous = ['prev1', 'prev0'];
  f.input.tiles[2].compare = f.compare;
  f.run(f.save({ ...f.input, id: saved.id, revision: saved.revision }).id);
  assert.deepEqual(noBars(cardOf(pageOf(f), 'Campaigns')).slice(1, 3), [
    ['Source 1', 'A', 30, 0.5, 3, -0.4],
    ['Source 2', 'B', 10, 0.25, 0.333333333333, 0.66666667],
  ]);
});

test('a compared chart over dates lines up the periods by their own days, not by calendar weeks', () => {
  // 1 August 2026 is a Saturday and 1 July a Wednesday: calendar weeks would split them apart.
  const f = periodsFixture({
    one: {
      '2026-08': [
        { date: '2026-08-01', campaign: 'A', spend: 1, clicks: 1 },
        { date: '2026-08-07', campaign: 'A', spend: 2, clicks: 3 },
        { date: '2026-08-08', campaign: 'A', spend: 4, clicks: 4 },
      ],
      '2026-07': [
        { date: '2026-07-01', campaign: 'A', spend: 10, clicks: 5 },
        { date: '2026-07-07', campaign: 'A', spend: 20, clicks: 5 },
      ],
    },
    two: { '2026-08': [{ date: '2026-08-02', campaign: 'B', spend: 3, clicks: 4 }], '2026-07': [{ date: '2026-07-08', campaign: 'B', spend: 40, clicks: 10 }] },
  });
  f.input.tiles[1] = {
    title: 'Weekly spend',
    type: 'line',
    groupBy: ['date'],
    dateBucket: 'week',
    metrics: [{ field: 'spend', agg: 'sum' }],
    ratios: [{ key: 'cpc', label: 'CPC', numerator: 'spend', denominator: 'clicks' }],
    secondaryAxis: ['cpc'],
    compare: f.compare,
  };
  const saved = f.save();
  const result = f.run(saved.id);
  const chartData = rowsOf(f, 'Dashboard report (chart data)'),
    weekly = find(chartData, 'Weekly spend (vs 1 Jul – 31 Jul 2026)');
  // Buckets start on the current period's days; each side counts days from its own start, and
  // the CPC of a bucket divides its summed spend by its summed clicks.
  assert.deepEqual(chartData.slice(weekly + 1, weekly + 7), [
    ['Date', 'Spend', 'Spend (previous period)', 'CPC', 'CPC (previous period)'],
    ['1 Aug', 6, 30, 0.75, 3],
    ['8 Aug', 4, 40, 1, 4],
    ['15 Aug'],
    ['22 Aug'],
    ['29 Aug (3 days)'],
  ]);
  // The chat reads the buckets by their dates.
  assert.deepEqual(result.tiles[0].preview.map((line) => line[0]), ['Date', '2026-08-01', '2026-08-08', '2026-08-15', '2026-08-22', '2026-08-29']);
  const spec = f.state.charts[0].spec.basicChart;
  // Each previous-period twin is dashed, lighter, and on its series' axis.
  assert.deepEqual(spec.series.map((series) => [series.targetAxis, series.lineStyle.type]), [
    ['LEFT_AXIS', 'SOLID'],
    ['LEFT_AXIS', 'MEDIUM_DASHED'],
    ['RIGHT_AXIS', 'SOLID'],
    ['RIGHT_AXIS', 'MEDIUM_DASHED'],
  ]);
  assert.deepEqual(spec.series[0].colorStyle, { rgbColor: rgb('#2a78d6') });
  assert.notDeepEqual(spec.series[1].colorStyle, spec.series[0].colorStyle);
  assert.equal(spec.legendPosition, 'TOP_LEGEND');
  assert.equal(spec.lineSmoothing, true);
  assert.equal(spec.compareMode, 'CATEGORY');
  assertInCard(f, f.tab('Dashboard report'), f.state.charts[0], 'Weekly spend');

  // A dataset without a period cannot be lined up, so the refresh refuses before any write.
  const before = f.snapshot();
  f.metadata = { two: { dateFiltered: false } };
  assert.throws(() => f.run(saved.id), /"Weekly spend": a compared chart needs the period of every compared dataset, and Source 2 has no date range/);
  assert.deepEqual(f.snapshot(), before);
});

test('chart tiles can stack, draw a ratio on the right axis as a line, and take the whole row', () => {
  const f = fixture();
  f.input.tiles = [
    f.input.tiles[0],
    {
      title: 'Spend and CPC',
      type: 'column',
      groupBy: ['date'],
      dateBucket: 'month',
      metrics: [{ field: 'spend', agg: 'sum' }],
      ratios: [{ key: 'cpc', numerator: 'spend', denominator: 'clicks' }],
      secondaryAxis: ['cpc'],
      width: 'full',
    },
    {
      title: 'Clicks by source',
      type: 'column',
      groupBy: ['date', 'source'],
      dateBucket: 'month',
      metrics: [{ field: 'clicks', agg: 'sum' }],
      stacked: true,
    },
    { title: 'Spend share', type: 'pie', groupBy: ['source'], metrics: [{ field: 'spend', agg: 'sum' }] },
  ];
  f.run(f.save().id);
  const report = f.tab('Dashboard report');
  const [combo, stacked, pie] = f.state.charts;
  assert.equal(combo.spec.basicChart.chartType, 'COMBO');
  assert.deepEqual(combo.spec.basicChart.series.map((series) => [series.type, series.targetAxis]), [['COLUMN', 'LEFT_AXIS'], ['LINE', 'RIGHT_AXIS']]);
  assert.equal(stacked.spec.basicChart.stackedType, 'STACKED');
  assert.equal(stacked.spec.basicChart.legendPosition, 'TOP_LEGEND');
  assert.deepEqual(stacked.spec.basicChart.series.map((series) => series.colorStyle.rgbColor), [rgb('#2a78d6'), rgb('#eb6834')], 'series colours keep a fixed order');
  // A share is drawn as bars in the page's colour, largest first and labelled, never with the
  // theme's slice colours, whose second is the red of a bad change.
  assert.equal(pie.spec.pieChart, undefined);
  assert.equal(pie.spec.basicChart.chartType, 'BAR');
  assert.deepEqual(pie.spec.basicChart.series.map((series) => [series.targetAxis, series.colorStyle.rgbColor, series.dataLabel.placement]), [['BOTTOM_AXIS', rgb('#2a78d6'), 'OUTSIDE_END']]);
  assert.equal(pie.spec.basicChart.legendPosition, 'NO_LEGEND');
  // Sheets has no outside-end label for stacked bars, so a stacked chart of one series has none.
  assert.ok(stacked.spec.basicChart.series.every((series) => !series.dataLabel));
  // The full-width chart takes a card row alone; the next two share the row below, side by side.
  assertInCard(f, report, combo, 'Spend and CPC');
  assertInCard(f, report, stacked, 'Clicks by source');
  assertInCard(f, report, pie, 'Spend share');
  const [wide, left, right] = f.state.charts.map((chart) => chart.position.overlayPosition);
  assert.ok(wide.widthPixels > 2 * left.widthPixels, 'a full chart spans both halves');
  assert.equal(left.anchorCell.rowIndex, right.anchorCell.rowIndex);
  assert.ok(left.anchorCell.rowIndex > wide.anchorCell.rowIndex);
  assert.ok(right.anchorCell.columnIndex > left.anchorCell.columnIndex);
  // Neighbouring cards are parted by a gap column in the page colour.
  const gap = right.anchorCell.columnIndex;
  assert.equal(f.pixelSize(report, 'COLUMNS', gap), 16);
  assert.deepEqual(f.format(report, left.anchorCell.rowIndex + 1, gap).backgroundColor, rgb('#f4f6fa'));
  const chartData = rowsOf(f, 'Dashboard report (chart data)'),
    combined = find(chartData, 'Spend and CPC');
  assert.deepEqual(chartData.slice(combined + 1, combined + 3), [['Date', 'Spend', 'Cpc'], ['Aug 2026', 10, 1.66666666667]]);
  const page = pageOf(f);
  assert.ok(find(page, 'Data sources') > find(page, 'Clicks by source'), 'the data sources follow the charts');
  f.input.tiles[1].secondaryAxis = ['spend', 'cpc'];
  assert.throws(() => f.save(), /"Spend and CPC": secondaryAxis/);
  f.input.tiles[1].secondaryAxis = ['cpc'];
  f.input.tiles[3].stacked = true;
  assert.throws(() => f.save(), /"Spend share": stacked/);
});

test('a scheduled dashboard refreshes from the hourly trigger, one per tick, and advances its next run', () => {
  const f = fixture();
  const local = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Athens', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
  // The clock reads Friday 2026-09-18 15:00 in Athens.
  const saved = f.save({ ...f.input, schedule: 'daily', at: { hour: 8 } });
  assert.equal(saved.schedule, 'daily');
  assert.deepEqual(saved.at, { hour: 8 });
  assert.equal(f.state.createdTriggers.length, 1, 'the hourly trigger exists for the dashboard alone');
  assert.equal(local(saved.nextRunAt), 'Sat 08:00', 'saving waits for the chosen hour');
  f.api.dmvRefreshScheduled();
  assert.equal(f.fetched.length, 0);
  f.advance(saved.nextRunAt + 600000 - f.api.Date.now());
  f.api.dmvRefreshScheduled();
  assert.equal(f.fetched.length, 2, 'the tick after 08:00 refreshes it');
  assert.equal(f.record(saved.id).status, 'success');
  assert.equal(local(f.record(saved.id).nextRunAt), 'Sun 08:00');
  f.api.dmvRefreshScheduled();
  assert.equal(f.fetched.length, 2, 'not due again until tomorrow morning');
  f.advance(86400000);
  f.api.dmvRefreshScheduled();
  assert.equal(f.fetched.length, 4);
  // A refresh that fails still waits for the next chosen hour before the next attempt.
  f.setRows('two', new Error('Provider down'));
  f.advance(86400000);
  f.api.dmvRefreshScheduled();
  assert.equal(f.record(saved.id).status, 'error');
  assert.equal(local(f.record(saved.id).nextRunAt), 'Tue 08:00');
  const weekly = plain(f.api.dmvScheduleDashboard(saved.id, 'weekly', { hour: 7, weekday: 3 }));
  assert.deepEqual(weekly.at, { hour: 7, weekday: 3 });
  assert.equal(local(weekly.nextRunAt), 'Wed 07:00');
  const manual = plain(f.api.dmvScheduleDashboard(saved.id, 'manual'));
  assert.equal(manual.schedule, 'manual');
  assert.equal(manual.at, null);
  assert.equal(f.record(saved.id).nextRunAt, null);
  assert.equal(f.record(saved.id).revision, saved.revision, 'a schedule change is not a plan change');
  assert.equal(f.state.triggers.length, 0, 'the trigger goes when nothing is scheduled');
  assert.throws(() => f.api.dmvScheduleDashboard(saved.id, 'often'), /supported refresh schedule/);
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
  // The overflow names the dataset and asks for the rows worth acting on first, in words that
  // fit every source; the row limit setting comes last, for a dataset that still needs it.
  let message = '';
  assert.throws(
    () => f.run(saved.id),
    (error) => {
      message = error.message;
      return true;
    }
  );
  // The runtime's own advice to narrow the date range is left out: a dataset's period is the
  // page's, and a shorter one would mix periods on one dashboard.
  assert.match(message, /^Source 1: The report exceeds the row limit\. This dataset allows 2 rows\. Keep only the rows worth acting on: /);
  assert.doesNotMatch(message, /date range/);
  // No LIMIT advice: only some sources label the rows a query's LIMIT keeps (a SQL LIMIT would
  // cut a list without a word), so that stays in the descriptions of the sources that do.
  assert.match(message, /a ranked report's Keep the top rows, conditions or aggregation in the query, or fewer dimensions\./);
  assert.doesNotMatch(message, /LIMIT|top rows by a metric/);
  assert.match(message, / Only then raise Maximum rows per chat report \(Settings > AI provider, up to 30,000\)\.$/);
  assert.ok(message.indexOf('Keep the top rows') < message.indexOf('Maximum rows per chat report'), 'narrowing comes before the setting');
  assert.doesNotMatch(message, /Google|GAQL|fixture/i, 'the advice names no provider');
  // A long label leaves out the last sentence whole rather than have it cut mid-word.
  const long = f.api.dmvDashboardMessage_('L'.repeat(240) + ': ', [], '', f.api.dmvDashboardNarrow_(''), ' Only then raise the limit.');
  assert.ok(long.length <= 400 && long.endsWith('fewer dimensions.'));
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
  // The datasets fetched so far are named, the largest first, with what narrows them.
  assert.throws(
    () => f.run(f.save().id),
    /^Error: The dashboard datasets exceed 30,000 rows together \(Source 1 15,001, Source 2 15,001\)\. Keep only the rows worth acting on in the largest datasets: /
  );
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
  assert.deepEqual(cardOf(pageOf(f), 'Data sources').slice(1).map((row) => row[4]), ['7 Sep – 13 Sep 2026', '31 Aug – 6 Sep 2026']);
  assert.equal(pageOf(f)[1][1], 'Several periods', 'the band does not pretend one period');
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
  assert.equal(f.state.charts[0].spec.basicChart.chartType, 'BAR', 'a share is drawn as bars');
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
  const [first, second] = f.state.charts.map((chart) => chart.position.overlayPosition.anchorCell);
  assert.equal(first.rowIndex, second.rowIndex, 'two half charts share a card row');
  assert.deepEqual([first.columnIndex, second.columnIndex], [1, 13], 'each in its half of the twelve content columns');
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
  assert.equal(find(pageOf(f), 'Clicks by source'), -1, 'the card of the removed tile is cleared');
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

test('highlight rules tint the rows they flag, first rule first, against a fixed value or the overall value', () => {
  const f = fixture();
  const row = (campaign, spend, clicks) => ({ date: '2026-08-03', campaign, spend, clicks });
  f.setRows('one', [row('A', 30, 10), row('B', 10, 2), row('C', 5, 5), row('D', 2, 1)]);
  f.setRows('two', [row('E', 20, 40)]);
  const cpc = { key: 'cpc', label: 'CPC', numerator: 'spend', denominator: 'clicks' };
  f.input.tiles[2] = {
    title: 'Campaigns',
    type: 'table',
    groupBy: ['campaign'],
    metrics: [{ field: 'spend', agg: 'sum' }],
    ratios: [cpc],
    orderBy: { field: 'spend__sum', direction: 'desc' },
    // The overall CPC is 67 / 58 = 1.1552.
    highlight: [
      { field: 'cpc', op: 'gt', ofTotal: 2, color: 'red' },
      { field: 'spend', op: 'gte', value: 20, color: 'green' },
      { field: 'cpc', op: 'lt', ofTotal: 0.9, color: 'amber' },
    ],
  };
  const saved = f.save();
  assert.deepEqual(plain(f.plan(saved.id).tiles[2].highlight[0]), { field: 'cpc', op: 'gt', color: 'red', ofTotal: 2 });
  const result = f.run(saved.id);
  const report = f.tab('Dashboard report');
  assert.deepEqual(noBars(cardOf(pageOf(f), 'Campaigns')), [
    ['Campaign', 'Spend (EUR)', 'CPC (EUR)'],
    ['A', 30, 3],
    ['E', 20, 0.5],
    ['B', 10, 5],
    ['C', 5, 1],
    ['D', 2, 2],
    ['Total', 67, 1.15517241379],
  ]);
  // A legend under the table names each rule with the threshold it applied on this refresh.
  const page = pageOf(f);
  const legend = page.find((line) => line[0] === 'Row tints');
  assert.deepEqual(legend, ['Row tints', 'CPC > 2× overall (EUR 2.31)', 'Spend ≥ EUR 20.00', 'CPC < 0.9× overall (EUR 1.04)']);
  assert.ok(page.indexOf(legend) > find(page, 'Campaigns') && page.indexOf(legend) < find(page, 'Data sources'), 'the legend is in the table card');
  assert.deepEqual(f.format(report, ...cellOf(report, legend[1])).backgroundColor, rgb('#fde4e4'));
  assert.deepEqual(f.format(report, ...cellOf(report, legend[3])).backgroundColor, rgb('#fdf0d2'));
  const tint = (name) => f.format(report, cellOf(report, name)[0], cellOf(report, name)[1] + 3).backgroundColor;
  // A meets the red rule and the green one: the first rule wins. E is green before amber.
  assert.deepEqual(['A', 'E', 'B', 'C'].map(tint), [rgb('#fde4e4'), rgb('#e3f4e3'), rgb('#fde4e4'), rgb('#fdf0d2')]);
  // An unflagged row keeps its heatmap: the CPC of D ranks third of five, the middle blue.
  const [dRow] = cellOf(report, 'D');
  // D spent 2 and its CPC is 2: the CPC column is the later one.
  const cpcColumn = Array.from({ length: 25 }, (_, i) => i + 1).findLast((c) => f.value(report, dRow, c) === 2);
  assert.deepEqual(f.format(report, dRow, cpcColumn).backgroundColor, rgb('#cde2fb'));
  // Each rule in words, with its threshold and unit, the worst rows first.
  assert.deepEqual(result.highlights, [
    'Campaigns: 2 of 5 rows have CPC above 2× the overall EUR 1.16 (red rows) — B, A.',
    'Campaigns: 1 of 5 rows has Spend at or above EUR 20.00 (green rows) — E.',
    'Campaigns: 1 of 5 rows has CPC below 0.9× the overall EUR 1.16 (amber rows) — C.',
    'A leads Campaigns with EUR 30.00 spend (44.8% of the total).',
  ]);
  assert.deepEqual(cardOf(pageOf(f), 'Highlights').map((line) => line[0]), result.highlights.map((text) => '•  ' + text));
});

test('a highlight rule on a groupBy column matches its text like a filter and reads like the page', () => {
  const f = fixture();
  const row = (campaign, spend, clicks) => ({ date: '2026-08-03', campaign, spend, clicks });
  // Provider codes, which the page shows as words.
  f.setRows('one', [row('BRAND_SEARCH', 40, 20), row('GENERIC_SEARCH', 30, 10), row('PERFORMANCE_MAX', 20, 5), row('DISPLAY', 6, 3)]);
  f.setRows('two', [row('VIDEO', 4, 2)]);
  const spend = [{ field: 'spend', agg: 'sum' }];
  const rules = [
    // Any case matches, as filters match.
    { field: 'campaign', op: 'eq', value: 'display', color: 'red' },
    { field: 'campaign', op: 'in', value: 'video, PERFORMANCE_MAX', color: 'amber' },
    { field: 'campaign', op: 'contains', value: 'search', color: 'green' },
  ];
  f.input.tiles = [
    f.input.tiles[0],
    // A title that does not name its measure: the finding names it.
    { title: 'Campaign mix', type: 'bar', groupBy: ['campaign'], metrics: spend },
    { title: 'Campaigns', type: 'table', groupBy: ['campaign'], metrics: spend, orderBy: { field: 'spend__sum', direction: 'desc' }, highlight: rules },
    { title: 'Other campaigns', type: 'table', groupBy: ['campaign'], metrics: spend, highlight: [{ field: 'campaign', op: 'ne', value: 'BRAND_SEARCH', color: 'amber' }] },
  ];
  const saved = f.save();
  assert.deepEqual(plain(f.plan(saved.id).tiles[2].highlight), rules);
  const result = f.run(saved.id);
  const report = f.tab('Dashboard report');
  const page = pageOf(f);
  // The legend names each value as the cells show it.
  const legends = page.filter((line) => line[0] === 'Row tints');
  assert.deepEqual(legends, [
    ['Row tints', 'Campaign = Display', 'Campaign = Video or Performance max', 'Campaign contains "search"'],
    ['Row tints', 'Campaign ≠ Brand search'],
  ]);
  // The first rule a row meets tints it.
  const tint = (name) => f.format(report, cellOf(report, name)[0], cellOf(report, name)[1] + 3).backgroundColor;
  assert.deepEqual(['Brand search', 'Generic search', 'Performance max', 'Display', 'Video'].map(tint), [
    rgb('#e3f4e3'),
    rgb('#e3f4e3'),
    rgb('#fdf0d2'),
    rgb('#fde4e4'),
    rgb('#fdf0d2'),
  ]);
  // Rows picked by their own names are not listed again; other rows are named in table order.
  assert.deepEqual(result.highlights, [
    'Campaigns: 1 of 5 rows has Campaign Display (red rows).',
    'Other campaigns: 4 of 5 rows have Campaign other than Brand search (amber rows) — Generic search, Performance max, Display and 1 more.',
    'Campaigns: 2 of 5 rows have Campaign Video or Performance max (amber rows).',
    'Campaigns: 2 of 5 rows have "search" in Campaign (green rows) — Brand search, Generic search.',
    'Campaign mix: Brand search holds 40.0% of Spend.',
    'Brand search leads Campaigns with EUR 40.00 spend (40.0% of the total).',
  ]);
  assert.deepEqual(cardOf(page, 'Highlights').map((line) => line[0]), result.highlights.map((text) => '•  ' + text));
  // A rule names a row by its leading name when the rule reads another column.
  f.input.tiles[2] = { ...f.input.tiles[2], groupBy: ['campaign', 'source'], highlight: [{ field: 'source', op: 'eq', value: 'source 2', color: 'red' }] };
  const edited = f.save({ ...f.input, id: saved.id, revision: saved.revision });
  const again = f.run(edited.id);
  assert.equal(again.highlights[0], 'Campaigns: 1 of 5 rows has Source Source 2 (red rows) — Video.');
});

test('values far apart in size move to the right axis unless the plan places them', () => {
  const f = fixture();
  const cpc = { key: 'cpc', label: 'CPC', numerator: 'spend', denominator: 'clicks' };
  f.setRows('one', [{ date: '2026-08-03', campaign: 'A', spend: 3000, clicks: 2000 }]);
  f.input.tiles = [
    f.input.tiles[0],
    // Spend runs to thousands, CPC to about one: CPC would lie flat at zero on one axis.
    { title: 'Spend and CPC', type: 'line', groupBy: ['date'], dateBucket: 'month', metrics: [{ field: 'spend', agg: 'sum' }], ratios: [cpc] },
    // Spend and clicks are of one scale and stay together.
    { title: 'Spend and clicks', type: 'column', groupBy: ['date'], dateBucket: 'month', metrics: [{ field: 'spend', agg: 'sum' }, { field: 'clicks', agg: 'sum' }] },
    // An explicit right axis wins.
    { title: 'Placed', type: 'line', groupBy: ['date'], dateBucket: 'month', metrics: [{ field: 'spend', agg: 'sum' }, { field: 'clicks', agg: 'sum' }], ratios: [cpc], secondaryAxis: ['clicks'] },
  ];
  f.run(f.save().id);
  const axes = (index) => f.state.charts[index].spec.basicChart.series.map((series) => series.targetAxis);
  assert.deepEqual(axes(0), ['LEFT_AXIS', 'RIGHT_AXIS']);
  assert.deepEqual(f.state.charts[0].spec.basicChart.axis.map((axis) => axis.position), ['LEFT_AXIS', 'RIGHT_AXIS']);
  assert.deepEqual(axes(1), ['LEFT_AXIS', 'LEFT_AXIS']);
  assert.equal(f.state.charts[1].spec.basicChart.chartType, 'COLUMN');
  assert.deepEqual(axes(2), ['LEFT_AXIS', 'RIGHT_AXIS', 'LEFT_AXIS']);
});

test('a refresh puts every chart back into its card, also after the page moved, and keeps one chart per tile', () => {
  const f = fixture(),
    saved = f.save();
  f.run(saved.id);
  const report = f.tab('Dashboard report'),
    chartId = f.state.charts[0].chartId;
  // The user dragged the chart away and resized it.
  Object.assign(f.state.charts[0].position.overlayPosition, { anchorCell: { sheetId: report.getSheetId(), rowIndex: 60, columnIndex: 9 }, widthPixels: 300 });
  f.run(saved.id);
  let requests = f.state.batches.at(-1).body.requests;
  assert.deepEqual(requests.filter((request) => request.updateEmbeddedObjectPosition).map((request) => request.updateEmbeddedObjectPosition.objectId), [chartId]);
  assert.deepEqual(requests.filter((request) => request.updateEmbeddedObjectBorder).map((request) => request.updateEmbeddedObjectBorder.objectId), [chartId]);
  assert.equal(requests.filter((request) => request.addChart).length, 0);
  assert.deepEqual(f.state.charts.map((chart) => chart.chartId), [chartId]);
  assertInCard(f, report, f.state.charts[0], 'Monthly spend');
  // Seven scorecards take a second row of cards and push the chart card down: the chart moves
  // with it.
  const before = f.state.charts[0].position.overlayPosition.anchorCell.rowIndex;
  const more = ['max', 'min'].flatMap((agg) => [{ field: 'spend', agg }, { field: 'clicks', agg }]).concat([{ field: 'spend', agg: 'avg' }]);
  const edited = f.save({
    ...f.input,
    id: saved.id,
    revision: saved.revision,
    tiles: [f.input.tiles[0], { title: 'More', type: 'kpi', metrics: more }, ...f.input.tiles.slice(1)],
  });
  f.setActive(f.reopen());
  f.run(edited.id);
  requests = f.state.batches.at(-1).body.requests;
  assert.equal(requests.filter((request) => request.addChart).length, 0);
  assert.deepEqual(f.state.charts.map((chart) => chart.chartId), [chartId], 'still exactly one chart for the one chart tile');
  assert.ok(f.state.charts[0].position.overlayPosition.anchorCell.rowIndex > before);
  assertInCard(f, f.tab('Dashboard report'), f.state.charts[0], 'Monthly spend');
});

test('a plan saved before dashboard v2 still refreshes: one-dataset compares, no polarity, no highlight rules', () => {
  const f = fixture();
  f.input.datasets[0].dateRange = { preset: 'previousMonth' };
  f.input.tiles[0].compare = { current: 'source1', previous: 'source0' };
  const saved = f.save();
  assert.equal(f.plan(saved.id).toned, true, 'plans saved now colour their changes');
  // The packed plan exactly as earlier versions stored it.
  const record = f.record(saved.id);
  const { datasets, tiles } = f.plan(saved.id);
  record.plan = f.api.dmvPack_(plain({ datasets, tiles }));
  f.api.dmvSave_('dashboard', record);
  const result = f.run(saved.id);
  assert.equal(result.ok, true);
  // Its changes stay uncoloured, as they were: without polarity a rising cost is not good news.
  assert.deepEqual(result.scorecards.map((card) => [card.label, card.change, card.tone]), [
    ['Spend (EUR)', '+133.3% vs 3.00', 'neutral'],
    ['Clicks', '+100.0% vs 2', 'neutral'],
  ]);
  const report = f.tab('Dashboard report');
  assert.deepEqual(f.format(report, ...cellOf(report, '▲ 133.3% vs 3.00')).textFormat.foregroundColor, GREY);
  assertInCard(f, f.tab('Dashboard report'), f.state.charts[0], 'Monthly spend');
  assert.equal(f.record(saved.id).status, 'success');
});

test('a plan saved before dashboard v2 keeps refreshing with a comparison a save now refuses', () => {
  const f = fixture();
  f.input.datasets[0].dateRange = { preset: 'previousMonth' };
  f.input.tiles[0].compare = { current: 'source1', previous: 'source0' };
  const saved = f.save();
  // Earlier versions compared any two datasets: here the last 30 days against last month.
  const record = f.record(saved.id);
  const { datasets, tiles } = f.plan(saved.id);
  datasets[0].dateRange = { preset: 'last30' };
  const unfair = /"Totals": Source 1 \(2026-08-19 to 2026-09-17\) must be the period just before Source 2 \(2026-08-01 to 2026-08-31\), with as many days/;
  assert.throws(() => f.save({ ...f.input, datasets: f.input.datasets.map((dataset, index) => (index ? dataset : { ...dataset, dateRange: { preset: 'last30' } })), id: saved.id, revision: saved.revision }), unfair);
  record.plan = f.api.dmvPack_(plain({ datasets, tiles }));
  f.api.dmvSave_('dashboard', record);
  const result = f.run(saved.id);
  assert.equal(result.ok, true, 'a scheduled refresh that ran before does not start failing');
  assert.deepEqual(result.scorecards.map((card) => [card.label, card.change]), [
    ['Spend (EUR)', '+133.3% vs 3.00'],
    ['Clicks', '+100.0% vs 2'],
  ]);
  assert.equal(f.record(saved.id).status, 'success');
  // A plan saved since then passed the check at save; a pairing that no longer holds stops it.
  const current = f.record(saved.id);
  current.plan = f.api.dmvPack_(plain({ datasets, tiles, toned: true }));
  f.api.dmvSave_('dashboard', current);
  assert.throws(() => f.run(saved.id), unfair);
  assert.equal(f.record(saved.id).status, 'error');
});

test('a table wider than twelve columns first drops its bar, then widens the whole page', () => {
  const f = periodsFixture({
    one: { '2026-08': [{ date: '2026-08-03', campaign: 'A', spend: 30, clicks: 10 }], '2026-07': [{ date: '2026-07-01', campaign: 'A', spend: 20, clicks: 4 }] },
    two: { '2026-08': [{ date: '2026-08-04', campaign: 'B', spend: 10, clicks: 30 }], '2026-07': [{ date: '2026-07-02', campaign: 'B', spend: 8, clicks: 40 }] },
  });
  // One name, eight values and a change after each: seventeen columns without the bar.
  const ratios = Array.from({ length: 6 }, (_, index) => ({ key: 'r' + index, label: 'R' + index, numerator: 'spend', denominator: 'clicks' }));
  f.input.tiles[2] = {
    title: 'Campaigns',
    type: 'table',
    groupBy: ['campaign'],
    metrics: [{ field: 'spend', agg: 'sum' }, { field: 'clicks', agg: 'sum' }],
    ratios,
    orderBy: { field: 'spend__sum', direction: 'desc' },
    compare: f.compare,
  };
  f.run(f.save().id);
  const report = f.tab('Dashboard report');
  const widths = Array.from({ length: 36 }, (_, i) => f.pixelSize(report, 'COLUMNS', i + 1));
  assert.deepEqual(widths, [20, ...Array(16).fill([88, 16]).flat(), 88, 20, 100]);
  const table = cardOf(pageOf(f), 'Campaigns');
  assert.equal(table[0].length, 17, 'every header is on the page');
  assert.ok(!table.flat().some(isBar), 'the bar column went before the page grew');
  // The band and the cards span the wider page.
  assert.deepEqual(f.format(report, 2, 35).backgroundColor, NAVY);
  assertInCard(f, report, f.state.charts[0], 'Monthly spend');
});

test('changes and small rates are computed unrounded and printed once, so the card, the cell and the chat agree', () => {
  const f = periodsFixture({
    // 906,230 against 746,140 is a 21.4547% rise; clicks per unit of spend fall 20.97%, which
    // ratios rounded to four decimals (0.0162 against 0.0204) would print as 20.6%.
    one: { '2026-08': [{ date: '2026-08-03', campaign: 'A', spend: 906230, clicks: 14638 }], '2026-07': [{ date: '2026-07-01', campaign: 'A', spend: 746140, clicks: 15250 }] },
    // No clicks this period: the cost per click has no current value, but it had one before.
    two: { '2026-08': [{ date: '2026-08-04', campaign: 'B', spend: 5, clicks: 0 }], '2026-07': [{ date: '2026-07-02', campaign: 'B', spend: 6, clicks: 2 }] },
  });
  f.input.tiles = [
    {
      title: 'Account one',
      type: 'kpi',
      datasets: ['source0', 'prev0'],
      metrics: [{ field: 'spend', agg: 'sum' }],
      ratios: [{ key: 'rate', label: 'Click rate', numerator: 'clicks', denominator: 'spend', percent: true }],
      compare: { current: 'source0', previous: 'prev0' },
    },
    {
      title: 'Account two',
      type: 'kpi',
      datasets: ['source1', 'prev1'],
      ratios: [{ key: 'cpc', label: 'CPC', numerator: 'spend', denominator: 'clicks' }],
      compare: { current: 'source1', previous: 'prev1' },
    },
    f.input.tiles[1],
    f.input.tiles[2],
  ];
  f.input.lowerIsBetter = ['cpc'];
  const result = f.run(f.save().id);
  assert.deepEqual(result.scorecards.map((card) => [card.label, card.change]), [
    ['Spend (EUR)', '+21.5% vs 746,140'],
    ['Click rate (EUR)', '-21.0% vs 0.02'],
    ['CPC (EUR)', 'no current value'],
  ]);
  const report = f.tab('Dashboard report');
  const page = pageOf(f);
  assert.deepEqual(page[find(page, 'Spend (EUR)') + 2], ['▲ 21.5% vs 746,140', '▼ 21.0% vs 0.02', 'no current value']);
  // The cell keeps the unrounded rate; its pattern prints what the card says.
  assert.equal(result.scorecards[1].value, Number((14638 / 906230).toPrecision(12)));
  // Money columns of a thousand and more read as whole amounts and name their currency.
  const table = noBars(cardOf(page, 'Campaigns'));
  assert.deepEqual(table[0], ['Source', 'Campaign', 'Spend (EUR)', 'Clicks']);
  const [aRow] = cellOf(report, 'A');
  const spendColumn = Array.from({ length: 25 }, (_, i) => i + 1).find((c) => f.value(report, aRow, c) === 906230);
  assert.deepEqual(f.format(report, aRow, spendColumn).numberFormat, { type: 'NUMBER', pattern: '#,##0' });
  // Tiles without a compare read the current period only, never both periods added up.
  assert.equal(table.at(-1)[1], 906235);
});

test('a comparison needs the period just before, and previous datasets stay out of the other tiles', () => {
  const f = periodsFixture({ one: {}, two: {} });
  f.input.tiles[0].datasets = ['source0', 'source1', 'prev0', 'prev1'];
  f.input.tiles[0].compare = f.compare;
  const saved = f.save();
  // A tile without a compare and without a datasets list reads every current dataset.
  assert.deepEqual(plain(f.plan(saved.id).tiles.map((tile) => tile.datasets)), [
    ['source0', 'source1', 'prev0', 'prev1'],
    ['source0', 'source1'],
    ['source0', 'source1'],
  ]);
  const save = (change) => {
    const input = structuredClone(f.input);
    change(input);
    return () => f.save(input);
  };
  assert.throws(save((input) => { input.tiles[2].datasets = ['source0', 'prev0']; }), /"Campaigns": prev0 hold the previous period of a comparison/);
  assert.throws(save((input) => { input.datasets[2].dateRange = { preset: 'last30' }; }), /"Totals": Source 1 previous \(2026-08-19 to 2026-09-17\) must be the period just before Source 1 \(2026-08-01 to 2026-08-31\), with as many days/);
  assert.throws(
    save((input) => { input.tiles[2] = { ...input.tiles[2], groupBy: ['date', 'campaign'], datasets: f.input.tiles[0].datasets, compare: f.compare }; }),
    /"Campaigns": a compared table matches rows by their groupBy values, and dates of two periods never match/
  );
  // A plan an earlier version saved with both periods in one tile refreshes with the current one.
  f.setRows('one', (ctx) => [{ date: ctx.startDate, campaign: 'A', spend: ctx.startDate < '2026-08-01' ? 100 : 1, clicks: 1 }]);
  const record = f.record(saved.id);
  const plan = f.plan(saved.id);
  plan.tiles[1].datasets = ['source0', 'source1', 'prev0', 'prev1'];
  record.plan = f.api.dmvPack_(plan);
  f.api.dmvSave_('dashboard', record);
  f.run(saved.id);
  const chartData = rowsOf(f, 'Dashboard report (chart data)');
  assert.deepEqual(chartData.slice(find(chartData, 'Monthly spend') + 2), [['Aug 2026', 1]]);
});

test('a compared trend keeps the same days of both periods and shades the current one', () => {
  const f = periodsFixture({
    one: {
      '2026-09': [{ date: '2026-09-01', campaign: 'A', spend: 10, clicks: 1 }, { date: '2026-09-30', campaign: 'A', spend: 20, clicks: 1 }],
      '2026-08': [
        { date: '2026-08-01', campaign: 'A', spend: 1, clicks: 1 },
        { date: '2026-08-30', campaign: 'A', spend: 2, clicks: 1 },
        { date: '2026-08-31', campaign: 'A', spend: 99, clicks: 1 },
      ],
    },
    two: {},
  });
  // In October the last month has 30 days and the one before 31.
  f.advance(Date.parse('2026-10-05T12:00:00Z') - f.api.Date.now());
  f.input.tiles[1] = { title: 'Daily spend', type: 'line', groupBy: ['date'], metrics: [{ field: 'spend', agg: 'sum' }], compare: f.compare, width: 'full' };
  f.input.tiles[1].datasets = ['source0', 'source1', 'prev0', 'prev1'];
  f.run(f.save().id);
  const chartData = rowsOf(f, 'Dashboard report (chart data)');
  const at = find(chartData, 'Daily spend (vs 1 Aug – 30 Aug 2026 (same days))');
  assert.ok(at >= 0, 'the card says which days it compares');
  const rows = chartData.slice(at + 2, at + 32);
  assert.equal(rows.length, 30);
  assert.deepEqual([rows[0], rows[29]], [['1 Sep', 10, 1], ['30 Sep', 20, 2]], 'the 31st of August has no day to meet');
  // One measure against its previous period: a shaded area under a dashed previous line.
  const spec = f.state.charts[0].spec.basicChart;
  assert.equal(spec.chartType, 'COMBO');
  assert.deepEqual(spec.series.map((series) => [series.type, series.lineStyle.type]), [['AREA', 'SOLID'], ['LINE', 'MEDIUM_DASHED']]);
  assert.equal(f.state.charts[0].spec.fontName, 'Arial', 'charts use the font of the cells around them');
});

test('the page reads like a report: codes in words, partly covered weeks with their days, long names cut at a word, flags counted over every row', () => {
  const f = fixture();
  const long = Array.from({ length: 30 }, (_, i) => 'segment' + i).join(' ');
  f.setRows('one', [
    { date: '2026-08-01', campaign: 'PERFORMANCE_MAX', spend: 30, clicks: 1 },
    { date: '2026-08-31', campaign: 'SEARCH', spend: 20, clicks: 1 },
  ]);
  f.setRows('two', [
    { date: '2026-08-02', campaign: long, spend: 50, clicks: 1 },
    { date: '2026-08-10', campaign: 'B', spend: 5, clicks: 1 },
    { date: '2026-08-12', campaign: 'C', spend: 15, clicks: 1 },
  ]);
  f.input.tiles = [
    f.input.tiles[0],
    { title: 'Weekly spend', type: 'column', groupBy: ['date'], dateBucket: 'week', metrics: [{ field: 'spend', agg: 'sum' }] },
    { title: 'Spend by type', type: 'bar', datasets: ['source0'], groupBy: ['campaign'], metrics: [{ field: 'spend', agg: 'sum' }] },
    {
      title: 'Keyword waste: spend without conversions',
      type: 'table',
      groupBy: ['campaign'],
      metrics: [{ field: 'spend', agg: 'sum' }],
      orderBy: { field: 'spend__sum', direction: 'desc' },
      limit: 2,
      highlight: [{ field: 'spend', op: 'gte', value: 10, color: 'red' }],
    },
  ];
  const result = f.run(f.save().id);
  const chartData = rowsOf(f, 'Dashboard report (chart data)');
  const weekly = find(chartData, 'Weekly spend');
  assert.deepEqual(chartData.slice(weekly + 2, weekly + 5).map((line) => line[0]), ['27 Jul (2 days)', '10 Aug', '31 Aug (1 day)']);
  const types = find(chartData, 'Spend by type');
  assert.deepEqual(chartData.slice(types + 2, types + 4), [['Performance max', 30], ['Search', 20]]);
  assert.deepEqual(result.tiles[1].preview.slice(1).map((line) => line[0]), ['PERFORMANCE_MAX', 'SEARCH'], 'the chat reads the codes');
  // A name wider than its column is cut at a word; the data tab keeps it whole.
  const page = pageOf(f);
  const shown = noBars(cardOf(page, 'Keyword waste: spend without conversions'))[1][0];
  assert.match(shown, /^segment0 segment1 .* segment\d+…$/);
  assert.ok(long.startsWith(shown.slice(0, -1)) && shown.length < long.length);
  assert.ok(rowsOf(f, 'Source 2 data').some((line) => line[1] === long));
  // A rule counts its rows over the whole tile, also those the limit leaves off the page, and
  // names the worst first; the sentence names the table without its subtitle.
  const flagged = result.highlights.find((text) => text.startsWith('Keyword waste:'));
  assert.match(flagged, /^Keyword waste: 2 of 2 rows \(4 of 5 in all\) have Spend at or above EUR 10\.00 \(red rows\) — segment0 /);
  assert.match(flagged, /PERFORMANCE_MAX, SEARCH and 1 more\.$/);
  assert.ok(result.highlights.includes('Spend by type: Performance max holds 60.0% of the total.'), 'a title that names the measure is not repeated');
  assert.deepEqual(page[find(page, 'Keyword waste: spend without conversions')], ['Keyword waste: spend without conversions', 'top 2 of 5']);
  assert.deepEqual(noBars(cardOf(page, 'Keyword waste: spend without conversions')).at(-1), ['Total (all 5)', 120]);
  // The section link is the title before its colon.
  assert.ok(page.find((line) => line.includes('Data sources')).includes('Keyword waste'));
});

test('a dataset cut to its top rows says so in the data sources, on its tiles and in their totals; whole datasets read as before', () => {
  const f = fixture();
  const row = (date, campaign, spend) => ({ date, campaign, spend, clicks: 1 });
  f.setRows('one', [row('2026-08-01', 'Alpha', 30), row('2026-08-02', 'Beta', 20), row('2026-08-03', 'Gamma', 10)]);
  f.setRows('two', [row('2026-08-02', 'Second', 7)]);
  // The connector kept the top 3 by spend and says so (metadata.topRows beside its note); the
  // runtime reads only these fields, never the source's name. Source 2 is a whole dataset.
  f.metadata = { one: { topRows: 3, note: 'Top 3 by Spend; raise the top for more.' } };
  const spend = [{ field: 'spend', agg: 'sum' }];
  const ranked = { orderBy: { field: 'spend__sum', direction: 'desc' } };
  f.input.tiles = [
    { title: 'Top spend', type: 'kpi', datasets: ['source0'], metrics: spend },
    { title: 'Account spend', type: 'kpi', datasets: ['source1'], metrics: spend },
    { title: 'Monthly spend', type: 'column', groupBy: ['date'], dateBucket: 'month', metrics: spend },
    {
      title: 'Top campaigns',
      type: 'table',
      datasets: ['source0'],
      groupBy: ['campaign'],
      metrics: spend,
      ...ranked,
      limit: 2,
      highlight: [{ field: 'spend', op: 'gte', value: 15, color: 'red' }],
    },
    { title: 'Ranked campaigns', type: 'table', datasets: ['source0'], groupBy: ['campaign'], metrics: spend, ...ranked },
    { title: 'Second account', type: 'table', datasets: ['source1'], groupBy: ['campaign'], metrics: spend, ...ranked },
    { title: 'Spend by campaign', type: 'bar', datasets: ['source0'], groupBy: ['campaign'], metrics: spend },
    { title: 'Campaign mix', type: 'bar', datasets: ['source0'], groupBy: ['campaign'], metrics: spend },
  ];
  const saved = f.save();
  const result = f.run(saved.id);
  const page = pageOf(f);
  // Data sources: a note column, the connector's note in full beside its dataset.
  assert.deepEqual(cardOf(page, 'Data sources'), [
    ['Dataset', 'Source', 'Connection', 'Report', 'Date range', 'Rows', 'Tab', 'Note'],
    ['Source 1', 'Fixture source', 'one', 'Daily', '1 Aug – 31 Aug 2026', 3, 'Source 1 data', 'Top 3 by Spend; raise the top for more.'],
    ['Source 2', 'Fixture source', 'two', 'Daily', '1 Aug – 31 Aug 2026', 1, 'Source 2 data'],
  ]);
  assert.match(rowsOf(f, 'Source 1 data')[1][0], /^2026-08-01 to 2026-08-31 · 3 rows · Top 3 by Spend; raise the top for more\. · Refreshed /);
  assert.match(rowsOf(f, 'Source 2 data')[1][0], /^2026-08-01 to 2026-08-31 · 1 rows · Refreshed /);
  assert.deepEqual(
    result.datasets.map((dataset) => [dataset.id, dataset.note]),
    [['source0', 'Top 3 by Spend; raise the top for more.'], ['source1', undefined]]
  );
  // Tiles reading only the cut dataset say so beside their title, before their own cut, and
  // their totals cover the top rows; scorecards name it beside the currency.
  assert.deepEqual(page[find(page, 'Top campaigns')], ['Top campaigns', 'top 3 by Spend · top 2 of 3']);
  assert.deepEqual(noBars(cardOf(page, 'Top campaigns')).slice(1), [['Alpha', 30], ['Beta', 20], ['Total (all 3 of top 3)', 60]]);
  assert.deepEqual(page[find(page, 'Ranked campaigns')], ['Ranked campaigns', 'top 3 by Spend']);
  assert.deepEqual(noBars(cardOf(page, 'Ranked campaigns')).at(-1), ['Total (top 3)', 60]);
  const labels = find(page, 'Spend (EUR, top 3)');
  assert.deepEqual(page.slice(labels, labels + 2), [['Spend (EUR, top 3)', 'Spend (EUR)'], [60, 7]]);
  assert.deepEqual(result.scorecards.map((card) => card.label), ['Spend (EUR, top 3)', 'Spend (EUR)']);
  // A tile over a cut and a whole dataset names the cut one.
  const note = (title) => result.tiles.find((tile) => tile.title === title).note;
  assert.equal(note('Monthly spend'), 'Source 1: top 3 by Spend');
  assert.equal(find(rowsOf(f, 'Dashboard report (chart data)'), 'Monthly spend (Source 1: top 3 by Spend)'), 0);
  // Rows a rule flags are counted in the top rows, not "in all", and a share or a leader is a
  // share of the top rows, not of the account's total: these sentences stand apart from the
  // cards' notes, and Chat quotes them word for word.
  assert.deepEqual(result.highlights, [
    'Top campaigns: 2 of 2 rows (2 of 3 in the top 3) have Spend at or above EUR 15.00 (red rows) — Alpha, Beta.',
    'Spend by campaign: Alpha holds 50.0% of the top 3.',
    'Campaign mix: Alpha holds 50.0% of Spend in the top 3.',
    'Alpha leads Top campaigns with EUR 30.00 spend (50.0% of the top 3).',
    'Alpha leads Ranked campaigns with EUR 30.00 spend (50.0% of the top 3).',
  ]);
  assert.ok(result.highlights.every((text) => !/total/.test(text)), 'no share over a cut list is called a share of the total');
  // A whole dataset reads as before: no note, a plain total.
  assert.deepEqual(page[find(page, 'Second account')], ['Second account']);
  assert.deepEqual(noBars(cardOf(page, 'Second account')).at(-1), ['Total', 7]);
  assert.equal(note('Second account'), undefined);

  // A list shorter than its top is the whole list: no top labels, and without a note no note
  // column.
  f.setRows('one', [row('2026-08-01', 'Alpha', 30), row('2026-08-02', 'Beta', 20)]);
  f.metadata = { one: { topRows: 3 } };
  const whole = f.run(saved.id);
  const again = pageOf(f);
  assert.deepEqual(cardOf(again, 'Data sources')[0], ['Dataset', 'Source', 'Connection', 'Report', 'Date range', 'Rows', 'Tab']);
  assert.deepEqual(again[find(again, 'Ranked campaigns')], ['Ranked campaigns']);
  assert.deepEqual(noBars(cardOf(again, 'Ranked campaigns')).at(-1), ['Total', 50]);
  assert.deepEqual(whole.scorecards.map((card) => card.label), ['Spend (EUR)', 'Spend (EUR)']);
  assert.equal(whole.tiles.find((tile) => tile.title === 'Monthly spend').note, undefined);
  assert.ok(whole.highlights.every((text) => !/top/.test(text)), JSON.stringify(whole.highlights));
  assert.ok(whole.highlights.includes('Spend by campaign: Alpha holds 60.0% of the total.'), JSON.stringify(whole.highlights));

  // A list cut at its other end, or in no order, is named for what it holds, never "top": the
  // connector's note says which ("Lowest 3 by CTR" after an ascending ORDER BY, "First 3 rows"
  // after a LIMIT without one), and its first word carries to the totals, cards and highlights.
  f.setRows('one', [row('2026-08-01', 'Alpha', 30), row('2026-08-02', 'Beta', 20), row('2026-08-03', 'Gamma', 10)]);
  for (const [text, kept] of [['Lowest 3 by CTR', 'lowest 3'], ['First 3 rows (query LIMIT)', 'first 3']]) {
    f.metadata = { one: { topRows: 3, note: text } };
    const cut = f.run(saved.id);
    const shown = pageOf(f);
    assert.deepEqual(shown[find(shown, 'Ranked campaigns')], ['Ranked campaigns', text.charAt(0).toLowerCase() + text.slice(1)]);
    assert.deepEqual(noBars(cardOf(shown, 'Ranked campaigns')).at(-1), [`Total (${kept})`, 60]);
    assert.deepEqual(noBars(cardOf(shown, 'Top campaigns')).at(-1), [`Total (all 3 of ${kept})`, 60]);
    assert.deepEqual(cut.scorecards.map((card) => card.label), [`Spend (EUR, ${kept})`, 'Spend (EUR)']);
    assert.ok(cut.highlights.includes(`Spend by campaign: Alpha holds 50.0% of the ${kept}.`), JSON.stringify(cut.highlights));
    assert.ok(cut.highlights.includes(`Top campaigns: 2 of 2 rows (2 of 3 in the ${kept}) have Spend at or above EUR 15.00 (red rows) — Alpha, Beta.`), JSON.stringify(cut.highlights));
    assert.ok(cut.highlights.every((line) => !/\btop 3\b/.test(line)), JSON.stringify(cut.highlights));
  }
  // The word comes from the note only when it stands before the cut's own count; any other note,
  // or none, reads as the top. Lists cut at different ends read together are "kept rows".
  const topOf = (count, note) => plain(f.api.dmvDashboardTopOf_({ rows: Array(count).fill({}), metadata: { topRows: count, note } }));
  assert.deepEqual(topOf(10000, 'Top 10,000 rows by spend; raise the row limit for more.'), { rows: 10000, note: 'top 10,000 rows by spend', word: 'top' });
  assert.deepEqual(topOf(3, 'Lowest 3 by CTR').word, 'lowest');
  assert.deepEqual(topOf(3, 'Bottom 5 by CTR').word, 'top', 'a count that is not the cut is not read');
  assert.deepEqual(topOf(3, 'Ranked by spend').word, 'top');
  assert.deepEqual(topOf(3, undefined), { rows: 3, note: 'top 3 rows', word: 'top' });
  const tops = { a: { rows: 3, note: 'top 3 by spend', word: 'top' }, b: { rows: 3, note: 'lowest 3 by CTR', word: 'lowest' }, c: { rows: 3, note: 'lowest 3 by CPC', word: 'lowest' } };
  const tileTop = (datasets) => plain(f.api.dmvDashboardTileTop_({ tops, labels: { a: 'A', b: 'B', c: 'C', d: 'D' } }, { datasets }));
  assert.deepEqual(tileTop(['a', 'b']), { label: 'kept rows', note: 'A: top 3 by spend, B: lowest 3 by CTR' });
  assert.equal(tileTop(['b', 'c']).label, 'lowest 3 each');
  assert.equal(tileTop(['b', 'd']).label, 'lowest rows', 'with a whole dataset beside it');
});

test('every scorecard is kept, in balanced rows that fill the page', () => {
  const f = fixture();
  f.currency = { one: 'USD', two: 'EUR' };
  f.input.tiles[0] = {
    title: 'Totals',
    type: 'kpi',
    metrics: ['sum', 'avg', 'max', 'min'].map((agg) => ({ field: 'spend', agg })).concat([{ field: 'clicks', agg: 'sum' }, { field: 'clicks', agg: 'max' }]),
    ratios: [
      { key: 'cpc', label: 'CPC', numerator: 'spend', denominator: 'clicks' },
      { key: 'cps', label: 'Clicks per spend', numerator: 'clicks', denominator: 'spend' },
    ],
  };
  const result = f.run(f.save().id);
  // Eight values, six of them money in two currencies: fourteen cards, none dropped.
  assert.equal(result.scorecards.length, 14);
  const report = f.tab('Dashboard report');
  for (const card of result.scorecards) assert.ok(cellOf(report, card.label), card.label + ' is on the page');
  // Rows of four, four, four and two; the last two cards take half the width each.
  const last = cellOf(report, result.scorecards[13].label)[0];
  const row = new RegExp('^[A-Z]+' + last + ':');
  assert.deepEqual(f.merges(report).filter((merge) => row.test(merge)), ['B' + last + ':L' + last, 'N' + last + ':X' + last]);
});

test('a saved comparison holds on every refresh day of the coming year, and only whole months stand for months', () => {
  const f = periodsFixture({ one: {}, two: {} });
  f.input.tiles[0].compare = f.compare;
  // Each saved pair writes tabs of its own.
  const pair = (current, previous, tabs = '') => () => {
    const input = structuredClone(f.input);
    input.datasets.forEach((dataset, index) => {
      dataset.dateRange = index < 2 ? current : previous;
      dataset.sheetName += tabs;
    });
    input.target.sheetName += tabs;
    return f.save(input);
  };
  // Monday 21 Sep: last week and the seven days before last7 are the same days today only.
  f.advance(3 * 86400000);
  assert.throws(
    pair({ preset: 'lastWeek' }, { preset: 'previous7' }),
    /"Totals": on a refresh on 2026-09-22, Source 1 previous \(2026-09-08 to 2026-09-14\) must be the period just before Source 1 \(2026-09-14 to 2026-09-20\), with as many days/
  );
  assert.throws(pair({ preset: 'last7' }, { preset: 'previousWeek' }), /on a refresh on 2026-09-22/);
  // 1 Oct: September and the 30 days before last30 line up after a 30-day month only.
  f.advance(10 * 86400000);
  assert.throws(pair({ preset: 'lastMonth' }, { preset: 'previous30' }), /on a refresh on 2026-10-02, Source 1 previous \(2026-08-03 to 2026-09-01\)/);
  // A month to date is not a whole month: three days of October against all of September.
  f.advance(2 * 86400000);
  assert.throws(
    pair({ preset: 'thisMonth' }, { preset: 'lastMonth' }),
    /"Totals": Source 1 previous \(2026-09-01 to 2026-09-30\) must be the period just before Source 1 \(2026-10-01 to 2026-10-03\), with as many days\. .*thisMonth, thisYear and lastYear have no previous preset/
  );
  // A relative period against a fixed one fails the next day.
  assert.throws(
    pair({ preset: 'yesterday' }, { preset: 'custom', startDate: '2026-10-01', endDate: '2026-10-01' }),
    /on a refresh on 2026-10-04/
  );
  // Whole months compare month for month, so a quarter stands against the quarter before it,
  // but not a month against a quarter.
  assert.ok(pair({ preset: 'custom', startDate: '2026-07-01', endDate: '2026-09-30' }, { preset: 'custom', startDate: '2026-04-01', endDate: '2026-06-30' })().id);
  assert.throws(
    pair({ preset: 'custom', startDate: '2026-07-01', endDate: '2026-07-31' }, { preset: 'custom', startDate: '2026-04-01', endDate: '2026-06-30' }),
    /must be the period just before Source 1 \(2026-07-01 to 2026-07-31\), with as many whole months/
  );
  // Matching presets hold every day; a saved pair keeps refreshing.
  for (const [current, previous] of [['last30', 'previous30'], ['lastWeek', 'previousWeek'], ['lastMonth', 'previousMonth']]) {
    const saved = pair({ preset: current }, { preset: previous }, ' ' + current)();
    for (let day = 0; day < 3; day++) {
      f.advance(9 * 86400000);
      assert.equal(f.run(saved.id).ok, true, current);
    }
  }
});

test('compared tiles read their compare lists, a source filter keeps both periods and an empty period keeps its currency', () => {
  const f = periodsFixture({
    one: { '2026-08': [{ date: '2026-08-03', campaign: 'A', spend: 30, clicks: 10 }], '2026-07': [{ date: '2026-07-01', campaign: 'A', spend: 20, clicks: 4 }] },
    two: { '2026-07': [{ date: '2026-07-02', campaign: 'B', spend: 4, clicks: 2 }] },
  });
  const second = [{ field: 'source', op: 'eq', value: 'Source 2' }];
  f.input.tiles[0] = { title: 'Totals', type: 'kpi', metrics: [{ field: 'spend', agg: 'sum' }], compare: f.compare };
  f.input.tiles.push(
    {
      title: 'Second account',
      type: 'kpi',
      metrics: [{ field: 'spend', agg: 'sum' }, { field: 'clicks', agg: 'sum' }],
      ratios: [{ key: 'cpc', label: 'CPC', numerator: 'spend', denominator: 'clicks' }],
      filters: second,
      compare: f.compare,
    },
    { title: 'Second account clicks', type: 'column', groupBy: ['date'], dateBucket: 'month', metrics: [{ field: 'clicks', agg: 'sum' }], filters: second, compare: f.compare }
  );
  const saved = f.save();
  // Without datasets, a compared tile reads its compare lists and the others the current period.
  assert.deepEqual(plain(f.plan(saved.id).tiles.map((tile) => tile.datasets)), [
    ['source0', 'source1', 'prev0', 'prev1'],
    ['source0', 'source1'],
    ['source0', 'source1'],
    ['source0', 'source1', 'prev0', 'prev1'],
    ['source0', 'source1', 'prev0', 'prev1'],
  ]);
  const result = f.run(saved.id);
  // The second account spent nothing in August: its money still names its currency, beside the
  // July values that a filter on its name finds in the previous period too.
  assert.deepEqual(result.scorecards.map((card) => [card.label, card.value, card.previous, card.change]), [
    ['Spend (EUR)', 30, 24, '+25.0% vs 24.00'],
    ['Spend (EUR)', 0, 4, '-100.0% vs 4.00'],
    ['Clicks', 0, 2, '-100.0% vs 2'],
    ['CPC (EUR)', '', 2, 'no current value'],
  ]);
  const trend = result.tiles.find((tile) => tile.title === 'Second account clicks');
  assert.deepEqual(trend.preview, [['Date', 'Clicks', 'Clicks (previous period)'], ['2026-08', '', 2]]);
});

test('a save refuses what every refresh would fail or misread', () => {
  const f = periodsFixture({ one: {}, two: {} });
  const save = (change) => () => {
    const input = structuredClone(f.input);
    change(input);
    return f.save(input);
  };
  // Datasets with a previous preset are a previous period even when no tile compares them.
  assert.throws(
    save((input) => {
      input.tiles[0].datasets = ['source0', 'source1', 'prev0', 'prev1'];
    }),
    /"Totals": prev0, prev1 hold the previous period of a comparison, and reading them with current datasets would add both periods together/
  );
  // A compared chart needs dates on its axis.
  assert.throws(
    save((input) => {
      input.tiles.push({ title: 'By campaign', type: 'column', groupBy: ['campaign'], metrics: [{ field: 'spend', agg: 'sum' }], compare: f.compare });
    }),
    /"By campaign": a compared chart needs a date column on its axis, and campaign is not one\./
  );
  // The overall value of a sum is the table total, which no row of several reaches.
  const rule = (ofTotal) => (input) => {
    input.tiles[2].highlight = [{ field: 'spend', op: 'gte', ofTotal, color: 'green' }];
  };
  assert.throws(save(rule(1.5)), /"Campaigns": the overall value of spend is its total over every row, so ofTotal on it is a share below 1/);
  assert.ok(save(rule(0.2))().id);
});

test('small rates keep four decimals in cards, cells and sentences', () => {
  const f = fixture();
  assert.equal(f.api.dmvDashboardNumber_(0.006, 'number'), '0.0060');
  assert.equal(f.api.dmvDashboardNumber_(-0.0123, 'number'), '-0.0123');
  assert.equal(f.api.dmvDashboardNumber_(0.45, 'currency'), '0.45', 'money keeps cents');
  assert.equal(f.api.dmvDashboardNumber_(2.5, 'number'), '2.50');
  assert.deepEqual(plain(f.api.dmvDashboardPattern_(0.009, 'number')), { type: 'NUMBER', pattern: '0.0000' });
  assert.deepEqual(plain(f.api.dmvDashboardPattern_(0.45, 'currency')), { type: 'NUMBER', pattern: '#,##0.00' });
  assert.equal(
    f.api.dmvDashboardChangeText_({ value: 0.009, previous: 0.006, delta: 0.5, type: 'number' }).text,
    '▲ 50.0% vs 0.0060'
  );
});

test('long tables shade and colour a column per request, so they refresh again and again within one write', () => {
  const f = fixture();
  f.setRows('one', () =>
    Array.from({ length: 1000 }, (_, i) => ({ date: '2026-08-01', campaign: 'Campaign number ' + i, spend: 1000 + ((i * 7919) % 5000), clicks: 10 + ((i * 31) % 97) }))
  );
  f.input.datasets[0].maxRows = 5000;
  const table = (title) => ({
    title,
    type: 'table',
    datasets: ['source0'],
    groupBy: ['campaign'],
    metrics: [{ field: 'spend', agg: 'sum' }, { field: 'clicks', agg: 'sum' }, { field: 'spend', agg: 'avg' }],
    ratios: [
      { key: 'cpc', label: 'CPC', numerator: 'spend', denominator: 'clicks' },
      { key: 'cps', label: 'Clicks per spend', numerator: 'clicks', denominator: 'spend' },
    ],
    orderBy: { field: 'spend__sum', direction: 'desc' },
    limit: 1000,
    // The rows it flags lead the table, so their tint is one format over all of them.
    highlight: [{ field: 'spend', op: 'gte', value: 5000, color: 'green' }],
  });
  f.input.tiles = [f.input.tiles[1], table('First'), table('Second'), table('Third')];
  const saved = f.save();
  for (const refresh of [1, 2]) {
    assert.equal(f.run(saved.id).ok, true, 'refresh ' + refresh);
    const requests = f.state.batches.at(-1).body.requests;
    assert.ok(JSON.stringify(requests).length < f.api.DMV_LIMITS.maxBytes / 2, 'refresh ' + refresh + ' stays well inside one write');
    // Three tables of a thousand rows with three shaded values and a bar each: a format per
    // cell would be over twelve thousand requests.
    assert.ok(requests.filter((request) => request.repeatCell).length < 300);
    const paints = requests.filter((request) => request.updateCells?.fields === 'userEnteredFormat.backgroundColor');
    assert.equal(paints.length, 9);
    assert.ok(paints.every((request) => request.updateCells.rows.length === 1000));
    // The row merges of the earlier page go in one request.
    assert.equal(requests.filter((request) => request.unmergeCells).length, refresh === 1 ? 0 : 1);
  }
  // A shaded cell and a tinted one: the tint covers the whole row, its shaded cells included.
  const report = f.tab('Dashboard report');
  const header = cellOf(report, 'CPC (EUR)');
  let tinted = 0,
    shaded = 0;
  for (let row = header[0] + 1; row <= header[0] + 1000; row++) {
    const background = f.format(report, row, header[1]).backgroundColor;
    if (JSON.stringify(background) === JSON.stringify(rgb('#e3f4e3'))) {
      tinted++;
      assert.deepEqual(f.format(report, row, 2).backgroundColor, rgb('#e3f4e3'));
    } else if (JSON.stringify(background) !== JSON.stringify(WHITE)) shaded++;
  }
  assert.ok(tinted > 100 && shaded > 500, tinted + ' tinted, ' + shaded + ' shaded');
  // A page past one write names its largest parts and, the page being the largest, its tables
  // as what to shorten. Parts under a tenth of the largest (both data tabs here) go unnamed.
  const limit = f.api.DMV_LIMITS.maxBytes;
  f.api.DMV_LIMITS.maxBytes = 2000000;
  const before = f.snapshot(),
    batches = f.state.batches.length;
  try {
    assert.throws(
      () => f.run(saved.id),
      /^Error: This dashboard is too large for one Sheets write\. Largest parts: the dashboard page \(\d[\d,]* rows x 25 columns\)\. Lower the row limit of its longest table tiles, give them fewer metrics and ratios, or narrow its datasets\.$/
    );
  } finally {
    f.api.DMV_LIMITS.maxBytes = limit;
  }
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.state.batches.length, batches);
});

test('a refresh past one Sheets write names its largest datasets, rows by columns, and writes nothing', () => {
  const f = fixture();
  // Two wide raw lists, as a dump of every keyword and asset would be, behind small tiles.
  const wide = Array.from({ length: 8 }, (_, i) => ({ key: 'extra' + i, type: 'text' }));
  f.api.dmvRegisterConnector_({
    id: 'dump_source',
    label: 'Dump source',
    category: 'Test',
    allowedHosts: ['dump.example'],
    authFields: [{ key: 'token', label: 'Token', type: 'password', required: true }],
    reports: [
      {
        id: 'items',
        label: 'Items',
        fields: [{ key: 'name', type: 'text' }, { key: 'spend', type: 'currency' }, ...wide],
        dateRange: false,
        configFields: [{ key: 'count', label: 'Count', type: 'number' }],
        fetch(ctx) {
          const columns = [{ key: 'name', type: 'text' }, { key: 'spend', type: 'currency' }, ...wide];
          const rows = Array.from({ length: ctx.config.count }, (_, i) => {
            const row = { name: 'Item number ' + i, spend: (i % 97) + 1 };
            wide.forEach((column, c) => (row[column.key] = 'Detail ' + c + ' of item ' + i));
            return row;
          });
          return { columns, rows, metadata: { complete: true, currency: 'EUR' } };
        },
      },
    ],
  });
  const connection = plain(f.api.dmvSaveConnection({ connectorId: 'dump_source', label: 'Dump', credentials: { token: 'private-dump-token' } }));
  const list = (id, label, count) => ({
    id,
    label,
    sheetName: label + ' Data',
    connectionId: connection.id,
    reportType: 'items',
    fields: ['name', 'spend', ...wide.map((column) => column.key)],
    config: { count },
    maxRows: 10000,
  });
  f.input.datasets = [list('assets', 'Assets', 4000), list('keywords', 'Keywords', 1500), list('terms', 'Search terms', 20)];
  f.input.tiles = [
    { title: 'Spend', type: 'kpi', datasets: ['terms'], metrics: [{ field: 'spend', agg: 'sum' }] },
    { title: 'Top terms', type: 'bar', datasets: ['terms'], groupBy: ['name'], metrics: [{ field: 'spend', agg: 'sum' }] },
  ];
  const saved = f.save();
  const limit = f.api.DMV_LIMITS.maxBytes;
  f.api.DMV_LIMITS.maxBytes = 1500000;
  let message = '';
  try {
    assert.throws(
      () => f.run(saved.id),
      (error) => {
        message = error.message;
        return true;
      }
    );
  } finally {
    f.api.DMV_LIMITS.maxBytes = limit;
  }
  // The datasets are named as the plan names them, the largest first, so Chat narrows the right
  // one; the small dataset and the page are no part worth naming.
  assert.match(message, /^This dashboard is too large for one Sheets write\. Largest parts: Assets \(4,000 rows x 10 columns\), Keywords \(1,500 rows x 10 columns\)\. /);
  assert.doesNotMatch(message, /Search terms|dashboard page/);
  assert.match(message, /\. Keep only the rows worth acting on in those datasets: a ranked report's Keep the top rows, .* Then shorten the longest table tiles if the page is still too large\.$/);
  assert.equal(f.state.batches.length, 0, 'nothing is written');
  for (const name of ['Assets Data', 'Keywords Data', 'Search terms Data', 'Dashboard report']) assert.equal(f.tab(name), null);
  assert.equal(f.readOutput(saved.id + '-d-assets'), null);
  assert.equal(f.record(saved.id).status, 'error');
  assert.match(f.record(saved.id).lastError, /Largest parts: Assets \(4,000 rows x 10 columns\)/);
});
