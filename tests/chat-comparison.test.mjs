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
  assert.match(
    request.system,
    /create or build a performance report or dashboard across multiple sources\/accounts asks for a saved spreadsheet artifact/
  );
  assert.match(request.system, /Preserve that intent after source-selection replies/);
  assert.match(request.system, /dateRange \{preset: "lastWeek"\}/);
  assert.match(request.system, /\{preset: "previousWeek"\}/);
  assert.match(request.system, /Three accounts therefore need six saved source queries/);
  assert.match(
    request.system,
    /do not also run_report those queries before or after run_dashboard/
  );
  assert.match(request.system, /clickable links returned by run_dashboard for both output tabs/);
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
  f.input = {
    name: 'Weekly performance comparison',
    sources: connections.flatMap((connection, index) =>
      ['lastWeek', 'previousWeek'].map((preset) => ({
        id: 'account' + index + '-' + preset,
        label:
          connection.label + ' - ' + (preset === 'lastWeek' ? 'current week' : 'previous week'),
        connectionId: connection.id,
        reportType: 'performance',
        fields: columns.map((column) => column.key),
        config: {},
        dateRange: { preset },
        maxRows: 1000,
        mapping: columns.map((column) => ({ field: column.key, key: column.key })),
      }))
    ),
    summary: {
      groupBy: ['date', 'source', 'currency'],
      dateBucket: 'week',
      metrics: ['spend', 'clicks', 'impressions'].map((field) => ({ field, agg: 'sum' })),
      limit: 20000,
    },
    dataTarget: { sheetName: 'Weekly source data', startCell: 'A1' },
    target: { sheetName: 'Weekly comparison', startCell: 'A1' },
  };
  return f;
}

test('a saved three-account comparison fetches six relative queries and advances both weeks on refresh', () => {
  const f = dashboardFixture();
  const saved = f.api.dmvSaveDashboard(f.input);
  assert.equal(saved.sourceCount, 6);
  const record = f.api.dmvRead_('dashboard', saved.id);
  assert.deepEqual(
    plain(record.sources.map((source) => source.dateRange)),
    Array.from({ length: 3 }, () => [{ preset: 'lastWeek' }, { preset: 'previousWeek' }]).flat()
  );
  const reportQuery = f.api.dmvValidateReport_(
    {
      ...f.input.sources[1],
      name: 'Prior week',
      target: { sheetName: 'Separate prior week', startCell: 'A1' },
    },
    f.book
  );
  assert.equal(reportQuery.dateRange.preset, 'previousWeek');
  const first = f.api.dmvRunDashboard(saved.id);
  assert.equal(first.rowCount, 6);
  assert.equal(f.fetched.length, 6, 'one fetch per account and period');
  assert.equal(f.state.batches.length, 1, 'both output tabs commit together');
  assert.deepEqual(
    f.fetched.map(({ startDate, endDate }) => [startDate, endDate]),
    Array.from({ length: 3 }, () => [
      ['2026-09-07', '2026-09-13'],
      ['2026-08-31', '2026-09-06'],
    ]).flat()
  );
  const sheetIds = [
    f.book.getSheetByName('Weekly source data').id,
    f.book.getSheetByName('Weekly comparison').id,
  ];
  f.advance(3 * DAY);
  const second = f.api.dmvRunDashboard(saved.id);
  assert.equal(second.rowCount, 6);
  assert.equal(f.fetched.length, 12);
  assert.equal(f.state.batches.length, 2);
  assert.deepEqual(
    f.fetched.slice(6).map(({ startDate, endDate }) => [startDate, endDate]),
    Array.from({ length: 3 }, () => [
      ['2026-09-14', '2026-09-20'],
      ['2026-09-07', '2026-09-13'],
    ]).flat()
  );
  assert.deepEqual(
    [f.book.getSheetByName('Weekly source data').id, f.book.getSheetByName('Weekly comparison').id],
    sheetIds
  );
});
