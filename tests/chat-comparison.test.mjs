import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatamoovSandbox, plain } from './helpers/datamoov-sandbox.mjs';

const DAY = 86400000;

test('comparison presets produce adjacent complete weeks on Sunday, Monday and calendar boundaries', () => {
  const f = createDatamoovSandbox();
  for (const [today, currentStart, currentEnd, previousStart, previousEnd] of [
    ['2026-09-20', '2026-09-07', '2026-09-13', '2026-08-31', '2026-09-06'],
    ['2026-09-21', '2026-09-14', '2026-09-20', '2026-09-07', '2026-09-13'],
    ['2026-09-07', '2026-08-31', '2026-09-06', '2026-08-24', '2026-08-30'],
    ['2027-01-04', '2026-12-28', '2027-01-03', '2026-12-21', '2026-12-27'],
    ['2024-03-04', '2024-02-26', '2024-03-03', '2024-02-19', '2024-02-25'],
  ]) {
    assert.deepEqual(
      plain(f.api.dmvChatWeekComparison_(today)),
      {
        current: { startDate: currentStart, endDate: currentEnd },
        previous: { startDate: previousStart, endDate: previousEnd },
      },
      today
    );
  }
  for (let day = 0; day < 90; day++) {
    const today = new Date(Date.parse('2026-09-01') + day * DAY).toISOString().slice(0, 10);
    const { current, previous } = f.api.dmvChatWeekComparison_(today);
    for (const range of [current, previous]) {
      assert.equal(new Date(range.startDate).getUTCDay(), 1);
      assert.equal(new Date(range.endDate).getUTCDay(), 0);
      assert.equal(Date.parse(range.endDate) - Date.parse(range.startDate), 6 * DAY);
    }
    assert.equal(Date.parse(current.startDate) - Date.parse(previous.endDate), DAY);
    assert.ok(current.endDate < today);
  }
});

test('model comparison dates use the spreadsheet timezone at a week boundary', () => {
  const f = createDatamoovSandbox();
  f.advance(Date.parse('2026-09-20T22:30:00Z') - Date.parse('2026-09-18T12:00:00Z'));
  f.book.timezone = 'Europe/Athens';
  let session = f.api.dmvChatSession_(f.book);
  assert.equal(session.today, '2026-09-21');
  assert.match(
    f.api.dmvChatSystemPrompt_(session),
    /current 2026-09-14 to 2026-09-20; previous 2026-09-07 to 2026-09-13/
  );
  f.book.timezone = 'America/Los_Angeles';
  session = f.api.dmvChatSession_(f.book);
  assert.equal(session.today, '2026-09-20');
  assert.match(
    f.api.dmvChatSystemPrompt_(session),
    /current 2026-09-07 to 2026-09-13; previous 2026-08-31 to 2026-09-06/
  );
});

test('the real chat request carries artifact intent, reusable periods and bounded one-off comparison guidance', () => {
  const f = createDatamoovSandbox();
  f.api.dmvAiRead_ = () => ({ provider: 'test', apiKey: 'offline-key', maxRows: 1000 });
  let request;
  f.api.dmvAiComplete_ = (_settings, value) => {
    request = value;
    return { text: 'Offline response', toolCalls: [], stop: 'end' };
  };
  f.api.dmvChat({
    text: 'Use all advertising accounts.',
    transcript: [
      { role: 'user', text: 'Create a marketing performance week vs previous period report.' },
      { role: 'assistant', text: 'Which sources should I include?' },
    ],
  });
  assert.match(
    JSON.stringify(request.messages),
    /Create a marketing performance week vs previous period report/
  );
  // Artifact intent: the request is a saved dashboard, stays one after the user only names the
  // sources, and never ends as numbers in chat.
  assert.match(
    request.system,
    /- DASHBOARDS\. A request to create or build a dashboard or a performance report or overview \("create a marketing performance week vs previous period"[^)]*\) asks for a saved spreadsheet artifact/
  );
  assert.match(
    request.system,
    /keep that intent after a source-selection reply such as "Use all ad platforms"/
  );
  assert.match(request.system, /never finish such a request with chat numbers alone/);
  assert.match(request.system, /A question such as "how much did we spend" is analysis/);
  // Reusable periods: relative presets, two datasets per account only for week versus previous
  // week, and one query per account for a trend.
  assert.match(
    request.system,
    /- Dashboard datasets: one query per requested account or subject/
  );
  assert.match(
    request.system,
    /Only an explicit week-versus-previous-week request uses two datasets per account, with dateRange presets lastWeek and previousWeek and labels naming account and period/
  );
  assert.match(
    request.system,
    /Cover a trend with ONE query per account over the whole period \(last 3 months is \{preset: "last90"\}\) and let tiles bucket it with dateBucket week or month; never split a trend into several date ranges/
  );
  // No duplicate fetching: the dashboard runtime is the only fetch of a dashboard request.
  assert.match(
    request.system,
    /Build a dashboard with exactly these calls: list_dashboards \(reuse or update a matching one\), save_dashboard, run_dashboard/
  );
  assert.match(
    request.system,
    /Do not call run_report, combine_results, summarize, write_to_sheet or create_chart for it: run_dashboard fetches every dataset once/
  );
  // An honest finish: what exists, where, how to refresh it, and no claim after a failure.
  assert.match(request.system, /- Dashboard tiles: design for decisions/);
  assert.match(request.system, /Then one action table: the items or segments that need attention/);
  assert.match(request.system, /never averages of per-row rates/);
  // Findings first, read from what run_dashboard returned, then what exists and how to refresh it.
  assert.match(
    request.system,
    /After run_dashboard succeeds, lead with 3 to 5 findings read from its scorecards and tile previews, each with its number and the action it suggests; state no finding the returned values do not show\. The first and last week or month of a trend can be partial, so do not read a rise or drop into them\. Then say what was created, which tab holds what, and that Reports > Dashboards > Refresh dashboard rebuilds all of it without AI/
  );
  // Tile filters act on rows, so the prompt never asks for a condition on totals through them.
  assert.match(request.system, /Tile filters select dataset rows before aggregation/);
  assert.match(request.system, /at most 8 scorecard values across all kpi tiles/);
  // SQL datasets cover the whole population: aggregate, never LIMIT to fit the cap.
  assert.match(request.system, /never add a LIMIT to fit the row cap/);
  assert.match(request.system, /Never cap a dataset with LIMIT; aggregate instead/);
  assert.match(request.system, /The tab links are shown to the user automatically/);
  assert.match(
    request.system,
    /If saving or running failed, say which step failed and do not claim the dashboard exists/
  );
  // The earlier single-table flow (sources plus summary, then create_chart) must not linger
  // beside the rules above.
  assert.doesNotMatch(
    request.system,
    /six saved source queries|eight-query dashboard limit|reportRange|includeFutureRows/
  );
  assert.match(
    request.system,
    /Explicit user dates, rolling last 7 days and week-to-date requests take precedence/
  );
  assert.match(request.system, /Fetch once per requested connection per period/);
  assert.match(request.system, /do not fetch a wider range spanning both periods/);
  assert.match(
    request.system,
    /select date only for a requested trend and campaign ID\/name only for a requested campaign breakdown/
  );
  assert.match(request.system, /same accounts, metrics and currencies in both periods/);
  assert.match(request.system, /if previous is zero, label percentage change unavailable/);
  assert.doesNotMatch(
    request.system,
    /For one-off all-platform comparisons.*include date, campaign/
  );
  const reportTool = request.tools.find((tool) => tool.name === 'run_report');
  assert.ok(
    reportTool.input_schema.properties.dateRange.properties.preset.enum.includes('previousWeek')
  );
  // The saved plan itself can hold both relative weeks of three accounts.
  const datasets = request.tools.find((tool) => tool.name === 'save_dashboard').input_schema
    .properties.datasets;
  for (const preset of ['lastWeek', 'previousWeek'])
    assert.ok(datasets.items.properties.dateRange.properties.preset.enum.includes(preset), preset);
  assert.ok(datasets.maxItems >= 6, 'three accounts in two periods must fit one dashboard');
  assert.match(
    request.tools.find((tool) => tool.name === 'run_dashboard').description,
    /do not also call run_report, write_to_sheet or create_chart for the same data/
  );
});

function dashboardFixture() {
  const f = createDatamoovSandbox();
  const columns = [
    { key: 'date', type: 'date' },
    { key: 'spend', type: 'currency' },
    { key: 'clicks', type: 'number' },
    { key: 'impressions', type: 'number' },
  ];
  f.fetched = [];
  f.api.dmvRegisterConnector_({
    id: 'comparison_fixture',
    label: 'Comparison source',
    category: 'Test',
    allowedHosts: ['fixture.example'],
    authFields: [{ key: 'account', label: 'Account', required: true }],
    reports: [
      {
        id: 'performance',
        label: 'Performance',
        dateRange: true,
        fields: columns,
        configFields: [],
        fetch(ctx) {
          f.fetched.push({
            account: ctx.credentials.account,
            startDate: ctx.startDate,
            endDate: ctx.endDate,
          });
          return {
            columns,
            rows: [{ date: ctx.startDate, spend: 10, clicks: 2, impressions: 20 }],
            metadata: { complete: true, currency: 'AED' },
          };
        },
      },
    ],
  });
  const connections = ['Account A', 'Account B', 'Account C'].map((account) =>
    f.api.dmvSaveConnection({
      connectorId: 'comparison_fixture',
      label: account,
      credentials: { account },
    })
  );
  const metrics = ['spend', 'clicks', 'impressions'].map((field) => ({ field, agg: 'sum' }));
  f.input = {
    name: 'Weekly performance comparison',
    target: { sheetName: 'Weekly comparison Dashboard' },
    // Three accounts in two periods are six datasets, the most one dashboard holds. Tiles read
    // them together, so every dataset maps its columns to the shared names.
    datasets: connections.flatMap((connection, index) =>
      ['lastWeek', 'previousWeek'].map((preset) => {
        const period = preset === 'lastWeek' ? 'current week' : 'previous week';
        return {
          id: 'account' + index + '_' + preset,
          label: connection.label + ' - ' + period,
          sheetName: connection.label + ' ' + period + ' Data',
          connectionId: connection.id,
          reportType: 'performance',
          fields: columns.map((column) => column.key),
          config: {},
          dateRange: { preset },
          maxRows: 1000,
          mapping: columns.map((column) => ({ field: column.key, key: column.key })),
        };
      })
    ),
    tiles: [
      { title: 'Totals', type: 'kpi', metrics },
      {
        title: 'Spend by account and period',
        type: 'column',
        groupBy: ['source'],
        metrics: [{ field: 'spend', agg: 'sum' }],
      },
      {
        title: 'Weekly totals',
        type: 'table',
        groupBy: ['date', 'source'],
        dateBucket: 'week',
        metrics,
      },
    ],
  };
  return f;
}

// The rows of a tab under the row whose first cell is `heading`, up to the next blank row.
function rowsUnder(f, sheetName, heading, width) {
  const sheet = f.tab(sheetName);
  let row = 1;
  while (row <= sheet.getLastRow() && f.value(sheet, row, 1) !== heading) row++;
  assert.ok(row <= sheet.getLastRow(), heading + ' is on ' + sheetName);
  const rows = [];
  for (row++; row <= sheet.getLastRow() && f.value(sheet, row, 1) !== ''; row++)
    rows.push(Array.from({ length: width }, (_, column) => f.value(sheet, row, column + 1)));
  return rows;
}

test('a saved three-account comparison fetches six relative queries and advances both weeks on refresh', () => {
  const f = dashboardFixture();
  const tabs = f.input.datasets.map((dataset) => dataset.sheetName).concat(f.input.target.sheetName);
  const saved = plain(f.api.dmvSaveDashboard(f.input));
  assert.equal(saved.datasets.length, 6);
  assert.equal(f.fetched.length, 0, 'saving does not fetch');
  // The saved plan keeps the relative presets, not the dates they mean today.
  const record = f.api.dmvRead_('dashboard', saved.id);
  assert.deepEqual(
    plain(f.api.dmvUnpack_(record.plan).datasets.map((dataset) => dataset.dateRange)),
    Array.from({ length: 3 }, () => [{ preset: 'lastWeek' }, { preset: 'previousWeek' }]).flat()
  );
  const { id: _id, label: _label, sheetName: _sheetName, mapping: _mapping, ...query } =
    f.input.datasets[1];
  const reportQuery = f.api.dmvValidateReport_(
    {
      ...query,
      name: 'Prior week',
      target: { sheetName: 'Separate prior week', startCell: 'A1' },
    },
    f.book
  );
  assert.equal(reportQuery.dateRange.preset, 'previousWeek');

  const weeks = (current, previous) => Array.from({ length: 3 }, () => [current, previous]).flat();
  const first = plain(f.api.dmvRunDashboard(saved.id));
  assert.equal(first.rowCount, 6);
  assert.deepEqual(
    first.datasets.map((dataset) => [dataset.id, dataset.rowCount]),
    f.input.datasets.map((dataset) => [dataset.id, 1])
  );
  assert.equal(f.fetched.length, 6, 'one fetch per account and period');
  assert.deepEqual(
    f.fetched.map(({ account }) => account),
    ['Account A', 'Account A', 'Account B', 'Account B', 'Account C', 'Account C']
  );
  assert.equal(f.state.batches.length, 1, 'six data tabs, the dashboard tab and its chart commit together');
  assert.deepEqual(
    f.fetched.map(({ startDate, endDate }) => [startDate, endDate]),
    weeks(['2026-09-07', '2026-09-13'], ['2026-08-31', '2026-09-06'])
  );
  // Each period stays its own series, and the dashboard names the dates each dataset covered.
  assert.deepEqual(
    rowsUnder(f, 'Weekly comparison Dashboard', 'Weekly totals', 5).slice(1),
    f.input.datasets.map((dataset, index) => [
      index % 2 ? '2026-08-31' : '2026-09-07',
      dataset.label,
      10,
      2,
      20,
    ])
  );
  assert.deepEqual(
    rowsUnder(f, 'Weekly comparison Dashboard', 'Data sources', 7)
      .slice(1)
      .map((row) => row[4]),
    weeks('2026-09-07 to 2026-09-13', '2026-08-31 to 2026-09-06')
  );
  assert.equal(f.state.charts.length, 1);
  const sheetIds = tabs.map((name) => f.tab(name).id);

  f.advance(3 * DAY);
  const second = plain(f.api.dmvRunDashboard(saved.id));
  assert.equal(second.rowCount, 6);
  assert.equal(f.fetched.length, 12);
  assert.equal(f.state.batches.length, 2);
  assert.deepEqual(
    f.fetched.slice(6).map(({ startDate, endDate }) => [startDate, endDate]),
    weeks(['2026-09-14', '2026-09-20'], ['2026-09-07', '2026-09-13'])
  );
  assert.deepEqual(
    rowsUnder(f, 'Weekly comparison Dashboard', 'Weekly totals', 5)
      .slice(1)
      .map((row) => row[0]),
    weeks('2026-09-14', '2026-09-07')
  );
  assert.deepEqual(
    rowsUnder(f, 'Weekly comparison Dashboard', 'Data sources', 7)
      .slice(1)
      .map((row) => row[4]),
    weeks('2026-09-14 to 2026-09-20', '2026-09-07 to 2026-09-13')
  );
  assert.match(
    f.value(f.tab('Account A previous week Data'), 2, 1),
    /^2026-09-07 to 2026-09-13 · 1 rows · /
  );
  assert.deepEqual(
    tabs.map((name) => f.tab(name).id),
    sheetIds,
    'a refresh reuses all seven tabs'
  );
  assert.equal(f.state.charts.length, 1, 'and updates the chart in place');
});
