import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatamoovSandbox, plain } from './helpers/datamoov-sandbox.mjs';

// Chat saves reports and dashboards as drafts through the same private records the form uses.
// Only a schedule the user asked for saves outright; Save on the card keeps a draft.
const AI_KEY = 'offline-report-chat-ai-key';
const SOURCE_KEY = 'offline-report-source-secret';

const COLUMNS = [
  { key: 'segments.date', label: 'Date', type: 'date', role: 'dimension' },
  { key: 'campaign.name', label: 'Campaign', type: 'text', role: 'dimension' },
  { key: 'metrics.cost', label: 'Cost', type: 'currency', role: 'metric' },
];
const ROWS = [
  { 'segments.date': '2026-09-01', 'campaign.name': 'Brand', 'metrics.cost': 100 },
  { 'segments.date': '2026-09-02', 'campaign.name': 'Generic', 'metrics.cost': 25.5 },
];

function fixture() {
  const f = createDatamoovSandbox();
  f.fetched = [];
  f.api.dmvRegisterConnector_({
    id: 'gads',
    label: 'Google Ads fixture',
    category: 'Test',
    allowedHosts: [],
    authFields: [{ key: 'token', label: 'Token', type: 'password', required: true }],
    reports: [
      {
        id: 'campaign_daily',
        label: 'Campaign daily',
        fields: COLUMNS,
        dateRange: true,
        configFields: [],
        fetch(ctx) {
          f.fetched.push({ maxRows: ctx.maxRows, startDate: ctx.startDate });
          return {
            columns: COLUMNS.filter((column) => ctx.fields.includes(column.key)),
            rows: ROWS,
            metadata: { complete: true, currency: 'EUR' },
          };
        },
      },
    ],
  });
  f.connection = f.api.dmvSaveConnection({ connectorId: 'gads', label: 'Main account', credentials: { token: SOURCE_KEY } });
  f.api.dmvSaveAiSettings({ provider: 'anthropic', apiKey: AI_KEY, maxRows: 100 });
  f.query = {
    connectionId: f.connection.id,
    reportType: 'campaign_daily',
    fields: ['segments.date', 'campaign.name', 'metrics.cost'],
    dateRange: { preset: 'last30' },
  };
  return f;
}

const tool = (id, name, input) => ({ type: 'tool_use', id, name, input });
const answer = (text = 'Done.') => ({ type: 'text', text });

function scriptedTurn(f, stages, text) {
  const fetch = f.api.UrlFetchApp.fetch;
  const results = new Map();
  const requests = [];
  let index = 0;
  f.api.UrlFetchApp.fetch = (url, options) => {
    const request = JSON.parse(options.payload);
    requests.push(request);
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
    return { reply, results, requests };
  } finally {
    f.api.UrlFetchApp.fetch = fetch;
  }
}

function saveReportInChat(f, extra = {}) {
  return scriptedTurn(
    f,
    [
      () => [tool('list', 'list_reports', {})],
      (results) => {
        assert.deepEqual(results.get('list').value, { reports: [] });
        return [tool('save', 'save_report', { ...f.query, name: 'Daily campaign cost', target: { sheetName: 'Campaign cost' }, ...extra })];
      },
      (results) => {
        assert.notEqual(results.get('save').is_error, true, JSON.stringify(results.get('save').value));
        return [answer('Saved as a draft.')];
      },
    ],
    'Create a report of daily campaign cost for the last 30 days.'
  );
}

test('save_report saves a draft through the report runtime, runs it once and tells the sidebar where it is', () => {
  const f = fixture();
  const { reply, results, requests } = saveReportInChat(f);
  const saved = results.get('save').value;
  assert.equal(saved.draft, true);
  assert.equal(saved.schedule, 'manual');
  assert.equal(saved.rowCount, 2);
  assert.match(saved.note, /Reports > Drafts/);
  assert.equal(f.fetched.length, 1, 'the first refresh runs inside the same call');

  const record = f.readReport(saved.id);
  assert.equal(record.draft, true);
  assert.equal(record.origin, 'chat');
  assert.equal(record.status, 'success');
  assert.equal(record.lastRowCount, 2);
  assert.deepEqual(record.target, { sheetName: 'Campaign cost', startCell: 'A1' });
  assert.ok(!JSON.stringify(record).includes(SOURCE_KEY), 'the record carries no credentials');
  const sheet = f.tab('Campaign cost');
  assert.equal(f.value(sheet, 1, 1), 'Date');
  assert.equal(f.value(sheet, 2, 2), 'Brand');

  const event = reply.events.find((item) => item.kind === 'saved_report');
  assert.deepEqual(event.record, { id: saved.id, draft: true });
  assert.match(event.text, /^Saved report draft "Daily campaign cost" and wrote 2 rows to Campaign cost\.$/);
  assert.equal(event.links[0].label, 'Campaign cost');
  assert.match(reply.transcriptAppend[1].actions[0], /Saved report draft/);
  // The list tool shows the draft with its revision for later edits.
  assert.deepEqual(
    plain(f.api.dmvListReports()).map((item) => [item.name, item.draft, item.revision]),
    [['Daily campaign cost', true, 1]]
  );
  // Prompt guidance: the capability block names the user's own connection and the draft rule.
  const system = requests[0].system.map((block) => block.text).join(' ');
  assert.match(system, /CAPABILITIES/);
  assert.match(system, /Selected sources now: Main account \(Google Ads fixture\)/);
  assert.match(system, /sidebar:drafts/);
  assert.ok(!system.includes(SOURCE_KEY) && !system.includes(AI_KEY));
});

test('a draft cannot be scheduled until it is kept; Save on the card keeps it and the form saves outright', () => {
  const f = fixture();
  const saved = saveReportInChat(f).results.get('save').value;
  const record = f.readReport(saved.id);
  assert.throws(
    () => f.api.dmvSaveReport({ ...record, schedule: 'daily', draft: true }),
    /Save this draft before scheduling refreshes/
  );
  // Editing a draft in the form (no draft flag) keeps it.
  const kept = plain(f.api.dmvKeepReport(saved.id));
  assert.equal(kept.draft, false);
  assert.equal(f.readReport(saved.id).origin, 'chat', 'origin stays for the card subtitle');
  const scheduled = plain(f.api.dmvSaveReport({ ...f.readReport(saved.id), schedule: 'daily', at: { hour: 8 } }));
  assert.equal(scheduled.draft, false);
  assert.equal(scheduled.schedule, 'daily');
  assert.ok(scheduled.nextRunAt > 0);
  // A chat edit of a kept report never demotes it.
  const again = plain(f.api.dmvSaveReport({ ...f.readReport(saved.id), id: saved.id, draft: true, origin: 'chat' }));
  assert.equal(again.draft, false);
  // A report built in the form is saved outright, without an origin from chat.
  const form = plain(f.api.dmvSaveReport({ ...f.query, name: 'Form report', target: { sheetName: 'Form tab' } }));
  assert.equal(form.draft, false);
  assert.equal(form.origin, 'sidebar');
});

test('a schedule the user asked for in chat saves the report outright', () => {
  const f = fixture();
  const { results, reply } = saveReportInChat(f, { schedule: 'weekly', at: { hour: 7, weekday: 2 } });
  const saved = results.get('save').value;
  assert.equal(saved.draft, false);
  assert.equal(saved.schedule, 'weekly');
  const record = f.readReport(saved.id);
  assert.deepEqual(record.at, { hour: 7, weekday: 2 });
  assert.ok(Number.isInteger(record.nextRunAt), 'a scheduled report has its next run');
  assert.equal(reply.events.find((item) => item.kind === 'saved_report').record.draft, false);
  assert.equal(f.state.createdTriggers.length, 1, 'the hourly trigger is armed for the schedule');
});

test('save_report rejects a stale revision and a row limit above the chat cap before touching the sheet', () => {
  const f = fixture();
  const saved = saveReportInChat(f).results.get('save').value;
  const stale = scriptedTurn(
    f,
    [
      () => [tool('save', 'save_report', { ...f.query, id: saved.id, revision: 99, name: 'Renamed', target: { sheetName: 'Campaign cost' } })],
      (results) => {
        assert.equal(results.get('save').is_error, true);
        assert.match(results.get('save').content, /List reports first/);
        return [tool('big', 'save_report', { ...f.query, maxRows: 1000, name: 'Too big', target: { sheetName: 'Other' } })];
      },
      (results) => {
        assert.equal(results.get('big').is_error, true);
        assert.match(results.get('big').content, /at most 100 rows/);
        return [answer()];
      },
    ],
    'Rename it.'
  );
  assert.equal(stale.reply.events.filter((item) => item.kind === 'saved_report').length, 0);
  assert.equal(f.fetched.length, 1);
});

// A saved report is written in one Sheets request, so it keeps fewer rows than chat may fetch
// for a dashboard dataset.
test('a chat report keeps at most the row limit of a saved report when the chat cap is higher', () => {
  const f = fixture();
  f.api.dmvSaveAiSettings({ provider: 'anthropic', maxRows: 100000 });
  const saved = saveReportInChat(f).results.get('save').value;
  assert.equal(f.readReport(saved.id).maxRows, 30000);
  assert.equal(f.fetched[0].maxRows, 30000);
});

test('chat dashboards are drafts too: no schedule until kept, kept when the user asked for a schedule', () => {
  const f = fixture();
  const plan = {
    name: 'Cost dashboard',
    target: { sheetName: 'Cost Dashboard' },
    datasets: [{ id: 'gads', label: 'Google Ads campaigns', sheetName: 'Google Ads Data', ...f.query }],
    tiles: [
      { title: 'Cost by campaign', type: 'column', datasets: ['gads'], groupBy: ['campaign.name'], metrics: [{ field: 'metrics.cost', agg: 'sum' }] },
    ],
  };
  const { reply, results } = scriptedTurn(
    f,
    [
      () => [tool('save', 'save_dashboard', plan)],
      (results) => {
        assert.notEqual(results.get('save').is_error, true, JSON.stringify(results.get('save').value));
        return [tool('run', 'run_dashboard', { id: results.get('save').value.id })];
      },
      (results) => {
        assert.notEqual(results.get('run').is_error, true, JSON.stringify(results.get('run').value));
        return [answer('Dashboard draft ready.')];
      },
    ],
    'Create a cost dashboard.'
  );
  const saved = results.get('save').value;
  assert.equal(saved.draft, true);
  assert.equal(saved.origin, 'chat');
  const events = reply.events.filter((item) => item.kind === 'dashboard');
  assert.deepEqual(events.map((item) => [item.action, item.record]), [
    ['saved', { id: saved.id, draft: true }],
    ['refreshed', { id: saved.id, draft: true }],
  ]);
  assert.match(events[0].text, /^Saved dashboard draft "Cost dashboard" .* Listed under Reports > Drafts\.$/);
  assert.throws(() => f.api.dmvScheduleDashboard(saved.id, 'daily', { hour: 6 }), /Save this draft before scheduling/);
  assert.equal(plain(f.api.dmvListDashboards())[0].draft, true);

  const kept = plain(f.api.dmvKeepDashboard(saved.id));
  assert.equal(kept.draft, false);
  assert.equal(plain(f.api.dmvScheduleDashboard(saved.id, 'daily', { hour: 6 })).schedule, 'daily');
  // A later chat update of the kept dashboard does not demote it.
  const updated = plain(f.api.dmvSaveDashboard({ ...plan, id: saved.id, revision: kept.revision, draft: true, origin: 'chat' }));
  assert.equal(updated.draft, false);

  // Asking for a schedule saves outright.
  const scheduled = scriptedTurn(
    f,
    [() => [tool('save', 'save_dashboard', { ...plan, name: 'Scheduled', target: { sheetName: 'Scheduled Dashboard' }, datasets: [{ ...plan.datasets[0], sheetName: 'Scheduled Data' }], schedule: 'daily', at: { hour: 8 } })], () => [answer()]],
    'Create it and refresh it daily at 8.'
  ).results.get('save').value;
  assert.equal(scheduled.draft, false);
  assert.equal(scheduled.schedule, 'daily');
});
