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
  // Reusable periods: relative presets, a lean previous-period twin per account by default (week
  // versus previous week included), and one query per account for a trend.
  assert.match(
    request.system,
    /- Dashboard datasets \(at most 8\): one query per requested account or subject/
  );
  assert.doesNotMatch(request.system, /Only an explicit week-versus-previous-week request/);
  assert.match(
    request.system,
    /Performance dashboards compare with the previous period by default, and always when asked: per account add one lean totals dataset for the previous period \(previous7\/14\/30\/90 for last7\/14\/30\/90, previousWeek for lastWeek, previousMonth for lastMonth; for a custom range the equal range just before it; yesterday, thisMonth, thisYear and lastYear have none, so those dashboards are not compared\) with only the kpi fields, mapped to the same keys as its current dataset and labeled with account and period/
  );
  assert.match(
    request.system,
    /ONE kpi tile of headline totals and rates[^.]*; with previous-period datasets it reads every current and previous dataset with compare: \{current: \[current ids\], previous: \[previous ids\]\}/
  );
  assert.match(request.system, /Trends and tables may compare too when the previous datasets hold their date or group fields/);
  assert.match(request.system, /a mapped dataset offers tiles only its mapped keys/);
  // Every requested section is built, from the source's report for the subject or else its
  // custom query report, and an honest note replaces controls a Sheets dashboard cannot have.
  assert.match(
    request.system,
    /Build every section the user asks for as tiles over real datasets, never as a description of how it could be built; each subject \(keywords, assets, audiences, geography\) comes from the source's report for it, else from its custom query report\. If the dataset limit forces a section out, say which\./
  );
  assert.doesNotMatch(request.system, /subjects the standard reports lack/);
  // Item lists are the rows someone acts on, ranked and labelled by the source, never a whole
  // account's dump, and never the base of a total. Every source whose report declares top uses
  // it, not only the first one that did.
  assert.match(
    request.system,
    /Item lists \(keywords, search terms, ads, assets, placements, landing pages, products\) are action lists, never dumps, on every source: the source's report for the subject with config top \(300 unless asked, at most 1,000\) wherever the catalog lists top for it, else a custom query keeping its top rows only where its description says how \(its result is then labelled\), no date field, and the condition in the query or a tile filter \(spend with zero conversions, low CTR with impressions\)\. A top-N dataset never feeds kpi totals or shares\./
  );
  assert.match(request.system, /Requested insights are the Highlights block the runtime writes on every refresh/);
  assert.match(
    request.system,
    /Sheets dashboards have no interactive controls: the period is the dataset preset \(changed by asking chat\) and a dropdown filter becomes tiles or tile filters; say so in one sentence/
  );
  // Readable charts and decision cues the runtime renders on every refresh.
  assert.match(
    request.system,
    /One measure per chart, or a volume with a rate on secondaryAxis \(spend with cpa\); never three measures of different scale on one chart/
  );
  assert.match(
    request.system,
    /Flag, highlight, alert or red\/green requests are table highlight rules, with ofTotal for relative thresholds \(CPA above 1\.5x overall: \{field: "cpa", op: "gt", ofTotal: 1\.5, color: "red"\}; on a summed metric ofTotal is a share of the table total, so top converters are \{field: "conversions", op: "gte", ofTotal: 0\.1, color: "green"\}\) or a text value on a groupBy column \(broad match: \{field: "match_type", op: "eq", value: "BROAD", color: "red"\}\); percent thresholds are fractions \(CTR below 2% is value 0\.02\)/
  );
  // A share is a bar chart, since the runtime draws pies as bars.
  assert.match(request.system, /bar to rank segments and for a share by category, as pies are drawn as bars\)/);
  assert.doesNotMatch(request.system, /pie for share/);
  assert.match(
    request.system,
    /Set lowerIsBetter to the cost-per and cost-rate keys the tiles use \(cpa, cpc, cpm, cost per conversion\) and neutral to their spend, cost and budget/
  );
  assert.match(request.system, /1 to 8 datasets, each on its own tab/);
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
  assert.match(request.system, /Then the action tables: the items or segments that need attention/);
  assert.match(request.system, /never averages of per-row rates/);
  // The runtime's highlights first, then findings read from what run_dashboard returned, then
  // what exists and how to refresh it.
  assert.match(
    request.system,
    /After run_dashboard succeeds, quote the highlights it returns, then add 3 to 5 findings read from its scorecards and tile previews, each with its number and the action it suggests; state no finding the returned values do not show\. The first and last week or month of a trend can be partial, so do not read a rise or drop into them\. Then say what was created, which tab holds what, and that Reports > Dashboards > Refresh dashboard rebuilds all of it without AI/
  );
  // Tile filters act on rows, so the prompt never asks for a condition on totals through them.
  assert.match(request.system, /Tile filters select dataset rows before aggregation/);
  assert.match(request.system, /at most 8 scorecard values across all kpi tiles/);
  // SQL datasets cover the whole population: aggregate, never LIMIT to fit the cap.
  assert.match(request.system, /never add a LIMIT to fit the row cap/);
  // Only sources that label the rows a LIMIT keeps may cut a list with one; a SQL LIMIT would
  // cut it without a word, so a SQL list keeps its top rows through the report's own top and
  // rankBy, which label the cut, and a SQL dataset behind totals aggregates without either.
  assert.match(
    request.system,
    /never LIMIT a SQL dataset, as nothing would label the rows it drops: an item list sets config top and rankBy \(the result column to rank by, highest first\), and a dataset feeding totals has neither\./
  );
  assert.doesNotMatch(request.system, /custom query ordered by a metric DESC with LIMIT/);
  assert.doesNotMatch(request.system, /performance_label/, 'Google no longer fills the asset performance label for Search and Display');
  assert.match(request.system, /The tab links are shown to the user automatically/);
  assert.match(
    request.system,
    /If saving or running failed, say which step failed and do not claim the dashboard exists/
  );
  // A dataset over the row limit or the one Sheets write is narrowed first; the higher limit is
  // the last resort, not the first answer.
  assert.match(
    request.system,
    /A row-limit or too-large error names a dataset: narrow it \(config top where its report has it, a condition in the query, fewer fields, no date field\) and retry; suggest a higher row limit only if it still needs one\./
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
  assert.match(request.system, /Fetch once per requested source per period/);
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
  // Every previous-period preset the dashboard rule names is a real preset the model can pass.
  for (const preset of ['previous7', 'previous14', 'previous30', 'previous90', 'previousWeek', 'previousMonth']) {
    assert.ok(reportTool.input_schema.properties.dateRange.properties.preset.enum.includes(preset), preset);
    assert.match(request.system, new RegExp('dateRange presets: [^\\n]*\\b' + preset + '\\b'));
  }
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
  const ids = (preset) => connections.map((_, index) => 'account' + index + '_' + preset);
  const weeks = { current: ids('lastWeek'), previous: ids('previousWeek') };
  f.input = {
    name: 'Weekly performance comparison',
    target: { sheetName: 'Weekly comparison Dashboard' },
    // Three accounts in two periods are six datasets. Tiles read them together, so every
    // dataset maps its columns to the shared names.
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
    // The previous weeks feed only the tiles that compare; the others read the current weeks.
    tiles: [
      { title: 'Totals', type: 'kpi', metrics, compare: weeks },
      {
        title: 'Spend by account',
        type: 'column',
        groupBy: ['source'],
        metrics: [{ field: 'spend', agg: 'sum' }],
      },
      { title: 'Weekly totals', type: 'table', groupBy: ['source'], metrics, compare: weeks },
    ],
  };
  return f;
}

// The dashboard tab as it reads: each row's non-empty cells in column order. Cards sit on a grid
// behind a margin column, and a merged cell holds its text in its first cell only.
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

// A card on the page: the rows under its title row (header, rows, total) up to the card's end,
// without the in-cell bars of a table.
function cardOf(page, title) {
  const at = page.findIndex((row) => row[0] === title);
  assert.ok(at >= 0, title + ' is on the page');
  const rows = [];
  for (let r = at + 1; r < page.length && page[r].length; r++)
    rows.push(page[r].filter((value) => !(typeof value === 'string' && /^[█▏▎▍▌▋▊▉]+$/.test(value))));
  return rows;
}

// One column of a card, by its header, without the header.
const columnOf = (card, header) => card.slice(1).map((row) => row[card[0].indexOf(header)]);

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
  // The two weeks are compared, never added together: each total is one week of three
  // accounts beside the week before, and each account's row meets its own previous week.
  assert.deepEqual(
    first.scorecards.map((card) => [card.label, card.value, card.previous, card.change]),
    [
      ['Spend (AED)', 30, 30, '0.0% vs 30.00'],
      ['Clicks', 6, 6, '0.0% vs 6'],
      ['Impressions', 60, 60, '0.0% vs 60'],
    ]
  );
  let page = pageOf(f, 'Weekly comparison Dashboard');
  const totals = cardOf(page, 'Weekly totals');
  assert.deepEqual(totals[0], ['Source', 'Spend (AED)', 'Δ %', 'Clicks', 'Δ %', 'Impressions', 'Δ %']);
  assert.deepEqual(
    totals.slice(1, -1),
    ['A', 'B', 'C'].map((account) => ['Account ' + account + ' - current week', 10, 0, 2, 0, 20, 0])
  );
  assert.deepEqual(totals.at(-1), ['Total', 30, 0, 6, 0, 60, 0]);
  assert.equal(first.tiles[0].rows, 3, 'the chart reads the current weeks');
  assert.deepEqual(
    columnOf(cardOf(page, 'Data sources'), 'Date range'),
    weeks('7 Sep – 13 Sep 2026', '31 Aug – 6 Sep 2026')
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
  page = pageOf(f, 'Weekly comparison Dashboard');
  assert.ok(page[2].includes('vs 7 Sep – 13 Sep 2026'), 'the band names the compared week');
  assert.deepEqual(
    columnOf(cardOf(page, 'Data sources'), 'Date range'),
    weeks('14 Sep – 20 Sep 2026', '7 Sep – 13 Sep 2026')
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
