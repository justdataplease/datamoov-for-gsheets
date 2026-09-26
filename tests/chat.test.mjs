import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatamoovSandbox, plain } from './helpers/datamoov-sandbox.mjs';

const AI_KEY = 'sk-ant-offline-private-key-0001';
const PROVIDER_TOKEN = 'orchard-private-provider-token';

function fixture(options = {}) {
  const f = createDatamoovSandbox();
  const rows = options.rows || [
    { date: '2026-09-01', campaign: 'Brand', spend: 10.5, clicks: 100, ctr: 0.1, reach: 12 },
    { date: '2026-09-02', campaign: 'Brand', spend: 20, clicks: 150, ctr: 0.2, reach: 15 },
    { date: '2026-09-01', campaign: 'Generic', spend: 5, clicks: 20, ctr: 0.05, reach: 7 },
  ];
  const fetched = [];
  f.api.dmvRegisterConnector_({
    id: 'orchard', label: 'Orchard Ads', description: 'Arbitrary test source', category: 'Test',
    allowedHosts: ['orchard.example'],
    authFields: [{ key: 'account', label: 'Account', type: 'text', required: true },
      { key: 'token', label: 'Token', type: 'password', required: true }],
    reports: [{ id: 'daily', label: 'Daily campaigns', description: 'Spend and clicks per campaign per day.',
      fields: [
        { key: 'date', label: 'Date', type: 'date', role: 'dimension', default: true },
        { key: 'campaign', label: 'Campaign', type: 'text', role: 'dimension', default: true },
        { key: 'spend', label: 'Spend', type: 'currency', role: 'metric', default: true },
        { key: 'clicks', label: 'Clicks', type: 'number', role: 'metric', default: true },
        { key: 'ctr', label: 'CTR', type: 'percent', role: 'metric', default: false },
        { key: 'reach', label: 'Reach', type: 'number', role: 'metric', default: false, additive: false },
      ],
      dateRange: true, configFields: [{ key: 'region', label: 'Region', type: 'text' }],
      fetch(ctx) {
        fetched.push(plain({ fields: ctx.fields, config: ctx.config, startDate: ctx.startDate, endDate: ctx.endDate, maxRows: ctx.maxRows, deadline: ctx.deadline }));
        if (options.fetchMs) f.advance(options.fetchMs);
        const selected = ctx.fields.length ? ctx.fields : ['date', 'campaign', 'spend', 'clicks'];
        return { columns: selected.map((key) => this.fields.find((field) => field.key === key)),
          rows: rows.map((row) => Object.fromEntries(selected.map((key) => [key, row[key]]))), metadata: { complete: true, currency: 'EUR' } };
      },
      discoverFields() { return this.fields.concat([{ key: 'custom_1', label: 'Custom field', type: 'text', custom: true }]); },
    }],
  });
  const connection = f.api.dmvSaveConnection({ connectorId: 'orchard', label: 'Orchard main', credentials: { account: 'acct-1', token: PROVIDER_TOKEN } });
  f.api.dmvSaveAiSettings({ provider: options.provider || 'anthropic', apiKey: AI_KEY, model: options.model });
  return { ...f, connection, fetched };
}

const anthropic = (blocks, stop = 'end_turn') => ({ body: { content: blocks, stop_reason: stop } });
const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
const payload = (call) => JSON.parse(call.options.payload);

test('AI settings keep the key private, retain it on blank edits and validate provider and model', () => {
  const f = fixture();
  const summary = f.api.dmvAiSettings();
  assert.equal(summary.configured, true);
  assert.equal(summary.provider, 'anthropic');
  assert.equal(summary.model, 'claude-opus-5');
  assert.ok(!JSON.stringify(summary).includes(AI_KEY));
  assert.ok(!JSON.stringify(f.api.dmvBootstrap()).includes(AI_KEY));
  assert.equal(f.api.dmvBootstrap().ai.configured, true);
  const renamed = f.api.dmvSaveAiSettings({ provider: 'anthropic', model: 'claude-sonnet-5', apiKey: '' });
  assert.equal(renamed.model, 'claude-sonnet-5');
  assert.equal(JSON.parse(f.state.user.getProperty('dmv:v1:ai:settings')).apiKey, AI_KEY);
  assert.throws(() => f.api.dmvSaveAiSettings({ provider: 'openai', apiKey: '' }), /Paste the API key/);
  assert.throws(() => f.api.dmvSaveAiSettings({ provider: 'mystery', apiKey: 'x' }), /supported AI provider/);
  assert.throws(() => f.api.dmvSaveAiSettings({ provider: 'gemini', apiKey: 'key', model: 'bad model!' }), /model name/);
  assert.throws(() => f.api.dmvSaveAiSettings({ provider: 'gemini', apiKey: 'has space' }), /unsupported characters/);
  // The request time limit defaults to 600 seconds and is kept when an edit leaves it out.
  assert.equal(summary.timeLimit, 600);
  assert.equal(f.api.dmvSaveAiSettings({ provider: 'anthropic', apiKey: '', timeLimit: 1200 }).timeLimit, 1200);
  assert.equal(f.api.dmvSaveAiSettings({ provider: 'anthropic', apiKey: '' }).timeLimit, 1200);
  for (const timeLimit of [59, 1801, 90.5, '600'])
    assert.throws(() => f.api.dmvSaveAiSettings({ provider: 'anthropic', apiKey: '', timeLimit }), /between 60 and 1,800/);
  assert.equal(f.api.dmvDeleteAiSettings().configured, false);
  assert.throws(() => f.api.dmvChat({ text: 'hi' }), /Add an AI provider/);
});

test('connectivity test sends a minimal request and redacts the key from provider errors', () => {
  const f = fixture();
  f.state.responses.push(anthropic([{ type: 'text', text: 'OK' }]));
  const result = f.api.dmvTestAi();
  assert.match(result.message, /Anthropic .* claude-opus-5 replied: OK/);
  const call = f.state.http[0];
  assert.equal(call.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(call.options.headers['x-api-key'], AI_KEY);
  assert.equal(payload(call).max_tokens, 64);
  assert.equal(payload(call).tools, undefined);
  f.state.responses.push({ code: 401, body: { error: { type: 'authentication_error', message: 'invalid x-api-key ' + AI_KEY } } });
  assert.throws(() => f.api.dmvTestAi(), (error) => /Anthropic rejected the request \(HTTP 401\)/.test(error.message) && !error.message.includes(AI_KEY));
});

test('a full Anthropic turn runs a report, summarizes, writes the table, charts it and never leaks secrets', () => {
  const f = fixture();
  f.state.responses.push(
    anthropic([{ type: 'text', text: 'Pulling the data.' },
      toolUse('t1', 'run_report', { connectionId: f.connection.id, reportType: 'daily', dateRange: { preset: 'last7' } })], 'tool_use'),
    anthropic([toolUse('t2', 'summarize', { resultId: 'PLACEHOLDER', groupBy: ['campaign'], metrics: [{ field: 'spend', agg: 'sum' }, { field: 'clicks', agg: 'sum' }] })], 'tool_use'),
    anthropic([toolUse('t3', 'write_to_sheet', { resultId: 'PLACEHOLDER2', sheetName: 'Spend by campaign' })], 'tool_use'),
    anthropic([toolUse('t4', 'create_chart', { resultId: 'PLACEHOLDER2', chartType: 'column', xColumn: 'campaign', seriesColumns: ['Spend'], title: 'Spend by campaign' })], 'tool_use'),
    anthropic([{ type: 'text', text: 'Brand spent EUR 30.50 and Generic EUR 5.00. (Orchard Ads, last 7 days)' }])
  );
  // The scripted replies need the real result ids, so patch them as the loop produces them.
  const originalFetch = f.api.UrlFetchApp.fetch;
  const ids = [];
  f.api.UrlFetchApp.fetch = (url, options) => {
    const body = JSON.parse(options.payload);
    const last = body.messages[body.messages.length - 1];
    if (Array.isArray(last.content)) for (const block of last.content) {
      if (block.type === 'tool_result') {
        const parsed = JSON.parse(block.content);
        if (parsed.resultId && !ids.includes(parsed.resultId)) ids.push(parsed.resultId);
      }
    }
    const next = f.state.responses[0];
    if (next?.body?.content) for (const block of next.body.content) {
      if (block.type === 'tool_use' && block.input.resultId === 'PLACEHOLDER') block.input.resultId = ids[0];
      if (block.type === 'tool_use' && block.input.resultId === 'PLACEHOLDER2') block.input.resultId = ids[1];
    }
    return originalFetch(url, options);
  };
  const reply = f.api.dmvChat({ text: 'Spend by campaign for the last 7 days, in a new tab with a chart', transcript: [] });
  assert.match(reply.text, /Brand spent EUR 30.50/);
  assert.deepEqual(plain(reply.events).map((event) => event.kind), ['report', 'summary', 'write', 'chart']);
  assert.match(reply.events[0].text, /Ran Orchard Ads \(Orchard main\) · Daily campaigns · 3 rows/);
  assert.match(reply.events[2].text, /Wrote 2 rows to Spend by campaign!A1:C3/);
  assert.equal(reply.options, null);
  assert.equal(reply.transcriptAppend[1].actions.length, 4);
  // Every step carries short facts for the sidebar; they stay out of the replayed transcript.
  const facts = plain(reply.events).map((event) => Object.fromEntries(event.details.map((fact) => [fact.label, fact.value])));
  assert.deepEqual(facts[0], { Connection: 'Orchard main', Report: 'Daily campaigns', Fields: 'date, campaign, spend, clicks', Dates: '2026-09-11 to 2026-09-17', Rows: '3' });
  assert.deepEqual(facts[1], { 'Group by': 'campaign', Metrics: 'sum spend, sum clicks', Groups: '2' });
  assert.deepEqual(facts[2], { Source: 'Summary of Orchard Ads (Orchard main) · Daily campaigns', Range: 'Spend by campaign!A1:C3', Columns: 'Campaign, Spend, Clicks' });
  assert.deepEqual(facts[3], { 'X axis': 'Campaign', Series: 'Spend', Anchor: 'E1' });
  assert.ok(reply.transcriptAppend[1].actions.every((action) => !/Connection:|Orchard main,/.test(action)));
  assert.ok(!JSON.stringify(reply.events).includes(PROVIDER_TOKEN));
  assert.deepEqual(plain(f.fetched[0]), { fields: ['date', 'campaign', 'spend', 'clicks'], config: {}, startDate: '2026-09-11', endDate: '2026-09-17', maxRows: 10000, deadline: f.api.Date.now() + 200000 });

  const calls = f.state.http;
  assert.equal(calls.length, 5);
  for (const call of calls) {
    assert.equal(call.url, 'https://api.anthropic.com/v1/messages');
    assert.ok(!call.options.payload.includes(PROVIDER_TOKEN), 'provider secrets never reach the model');
    assert.ok(!call.options.payload.includes(AI_KEY), 'the AI key travels only in the header');
  }
  const first = payload(calls[0]);
  assert.equal(first.model, 'claude-opus-5');
  assert.equal(first.system[0].cache_control.type, 'ephemeral');
  assert.match(first.system[0].text, /connectionId "id-\d+": Orchard main \(Orchard Ads; account=acct-1\)/);
  assert.match(first.system[0].text, /reportType "daily"/);
  assert.match(first.system[0].text, /spend "Spend" \[currency, metric, default\]/);
  assert.deepEqual(first.tools.map((tool) => tool.name), ['run_report', 'discover_fields', 'describe_database', 'combine_results', 'summarize', 'write_to_sheet', 'read_sheet', 'create_chart', 'ask_user', 'list_sheets', 'inspect_sheet', 'edit_sheet', 'create_pivot', 'list_dashboards', 'save_dashboard', 'run_dashboard']);
  assert.equal(first.tools[0].input_schema.properties.config.properties.region.type, 'string');
  const second = payload(calls[1]);
  assert.deepEqual(second.messages[1].content, [{ type: 'text', text: 'Pulling the data.' }, toolUse('t1', 'run_report', { connectionId: f.connection.id, reportType: 'daily', dateRange: { preset: 'last7' } })]);
  const firstResult = JSON.parse(second.messages[2].content[0].content);
  assert.equal(second.messages[2].content[0].tool_use_id, 't1');
  assert.equal(firstResult.rowCount, 3);
  assert.deepEqual(firstResult.columns.map((column) => column.key), ['date', 'campaign', 'spend', 'clicks']);
  assert.equal(firstResult.stats.spend.sum, 35.5);
  assert.equal(firstResult.stats.campaign.distinct, 2);
  assert.equal(firstResult.rows.length, 3, 'small results are returned whole');
  assert.equal(firstResult.metadata.currency, 'EUR');
  const summary = JSON.parse(payload(calls[2]).messages[4].content[0].content);
  assert.deepEqual(summary.rows, [{ campaign: 'Brand', spend__sum: 30.5, clicks__sum: 250 }, { campaign: 'Generic', spend__sum: 5, clicks__sum: 20 }]);
  assert.deepEqual(summary.columns.map((column) => column.label), ['Campaign', 'Spend', 'Clicks']);

  const sheet = f.tab('Spend by campaign');
  assert.equal(f.value(sheet, 1, 1), 'Campaign');
  assert.equal(f.value(sheet, 2, 1), 'Brand');
  assert.equal(f.value(sheet, 2, 2), 30.5);
  assert.equal(f.value(sheet, 3, 3), 20);
  assert.equal(f.state.charts.length, 1);
  const chart = f.state.charts[0];
  assert.equal(chart.spec.title, 'Spend by campaign');
  assert.equal(chart.spec.basicChart.chartType, 'COLUMN');
  assert.equal(chart.spec.basicChart.headerCount, 1);
  assert.deepEqual(chart.spec.basicChart.domains[0].domain.sourceRange.sources[0], { sheetId: sheet.id, startRowIndex: 0, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 1 });
  assert.deepEqual(chart.spec.basicChart.series[0].series.sourceRange.sources[0], { sheetId: sheet.id, startRowIndex: 0, endRowIndex: 3, startColumnIndex: 1, endColumnIndex: 2 });
  assert.deepEqual(chart.position.overlayPosition.anchorCell, { sheetId: sheet.id, rowIndex: 0, columnIndex: 4 });
  const receipts = [...f.state.user.data.keys()].filter((key) => key.includes(':output:') && key.includes(':chat-'));
  assert.equal(receipts.length, 1, 'chat writes keep a protected receipt');
  assert.equal(f.state.lockAcquires, f.state.lockReleases);
});

test('ask_user ends the turn, skips the other calls in that round and returns the options', () => {
  const f = fixture();
  f.state.responses.push(anthropic([
    toolUse('q1', 'ask_user', { question: 'Which metric do you mean by cost?', options: ['Spend', 'Clicks'] }),
    toolUse('q2', 'run_report', { connectionId: f.connection.id, reportType: 'daily' }),
  ], 'tool_use'));
  const reply = f.api.dmvChat({ text: 'What was the cost?' });
  assert.equal(reply.text, 'Which metric do you mean by cost?');
  assert.deepEqual(plain(reply.options), ['Spend', 'Clicks']);
  assert.equal(f.fetched.length, 0, 'the skipped report never ran');
  assert.equal(f.state.http.length, 1);
  assert.deepEqual(plain(reply.events), []);
});

test('the round budget ends with a tools-disabled final answer and tool errors teach the model', () => {
  const f = fixture();
  f.api.DMV_CHAT.maxRounds = 2;
  f.state.responses.push(
    anthropic([toolUse('a', 'summarize', { resultId: 'r00000000', metrics: [{ field: 'spend', agg: 'sum' }] })], 'tool_use'),
    anthropic([toolUse('b', 'run_report', { connectionId: 'missing', reportType: 'daily' })], 'tool_use'),
    anthropic([{ type: 'text', text: 'I could not finish: the connection id was wrong.' }])
  );
  const reply = f.api.dmvChat({ text: 'Total spend' });
  assert.match(reply.text, /could not finish/);
  assert.equal(f.state.http.length, 3);
  const second = payload(f.state.http[1]);
  const expired = second.messages[2].content[0];
  assert.equal(expired.is_error, true);
  assert.match(JSON.parse(expired.content).error, /has expired\. Run the report again/);
  const third = payload(f.state.http[2]);
  assert.equal(third.tools, undefined, 'the final answer call disables tools');
  assert.match(third.messages[third.messages.length - 1].content[0].text, /Answer now/);
  const bad = JSON.parse(third.messages[4].content[0].content).error;
  assert.match(bad, /no longer exists/);
  assert.match(bad, new RegExp('Available connectionIds: ' + f.connection.id));
  assert.deepEqual(plain(reply.events).map((event) => event.kind), ['error', 'error']);
});

test('summarize refuses to sum rates, lists columns on typos, filters, buckets dates and sorts', () => {
  const f = fixture();
  const session = f.api.dmvChatSession_(f.book);
  const described = f.api.dmvChatRunReport_(session, { connectionId: f.connection.id, reportType: 'daily', fields: ['date', 'campaign', 'spend', 'clicks', 'ctr'] });
  assert.equal(described.stats.ctr.sum, undefined, 'percent columns have no sum');
  assert.throws(() => f.api.dmvChatSummarize_(session, { resultId: described.resultId, metrics: [{ field: 'ctr', agg: 'sum' }] }), /cannot be summed/);
  assert.throws(() => f.api.dmvChatSummarize_(session, { resultId: described.resultId, groupBy: ['campagn'] }), /Unknown groupBy column "campagn"\. Result columns are: date, campaign, spend, clicks, ctr/);
  const monthly = f.api.dmvChatSummarize_(session, { resultId: described.resultId, groupBy: ['date'], dateBucket: 'month', metrics: [{ field: 'clicks', agg: 'sum' }, { field: 'ctr', agg: 'avg' }, { field: 'campaign', agg: 'count_distinct' }] });
  assert.deepEqual(plain(monthly.rows), [{ date: '2026-09', clicks__sum: 270, ctr__avg: 0.1167, campaign__count_distinct: 2 }]);
  // A ratio divides two per-group sums; the sums it needs stay hidden unless asked for.
  const rates = f.api.dmvChatSummarize_(session, { resultId: described.resultId, groupBy: ['campaign'], ratios: [{ key: 'cpc', numerator: 'spend', denominator: 'clicks' }, { key: 'share', label: 'Click share', numerator: 'clicks', denominator: 'clicks', percent: true }], orderBy: { field: 'cpc', direction: 'desc' } });
  assert.deepEqual(plain(rates.columns).map((column) => [column.key, column.label, column.type, column.additive]), [['campaign', 'Campaign', 'text', undefined], ['cpc', 'cpc', 'currency', false], ['share', 'Click share', 'percent', false]]);
  assert.deepEqual(plain(rates.rows), [{ campaign: 'Generic', cpc: 0.25, share: 1 }, { campaign: 'Brand', cpc: 0.122, share: 1 }]);
  assert.throws(() => f.api.dmvChatSummarize_(session, { resultId: described.resultId, ratios: [{ key: 'bad', numerator: 'ctr', denominator: 'clicks' }] }), /numerator "ctr" must be a summable column/);
  assert.throws(() => f.api.dmvChatSummarize_(session, { resultId: described.resultId, metrics: [{ field: 'spend', agg: 'sum' }], ratios: [{ key: 'spend__sum', numerator: 'spend', denominator: 'clicks' }] }), /already a column/);
  const filtered = f.api.dmvChatSummarize_(session, { resultId: described.resultId, groupBy: ['campaign'], metrics: [{ field: 'spend', agg: 'max' }], filters: [{ field: 'clicks', op: 'gte', value: '100' }], orderBy: { field: 'spend__max', direction: 'asc' } });
  assert.deepEqual(plain(filtered.rows), [{ campaign: 'Brand', spend__max: 20 }]);
  assert.equal(filtered.inputRows, 2);
  const totals = f.api.dmvChatSummarize_(session, { resultId: described.resultId, metrics: [{ field: 'spend', agg: 'sum' }, { field: 'clicks', agg: 'count' }] });
  assert.deepEqual(plain(totals.rows), [{ spend__sum: 35.5, clicks__count: 3 }]);
  // A fresh session reads the spilled result from the private cache.
  const later = f.api.dmvChatSession_(f.book);
  assert.equal(f.api.dmvChatSummarize_(later, { resultId: described.resultId, metrics: [{ field: 'spend', agg: 'sum' }] }).rows[0].spend__sum, 35.5);
  f.state.cache.data.clear();
  assert.throws(() => f.api.dmvChatSummarize_(f.api.dmvChatSession_(f.book), { resultId: described.resultId, metrics: [] }), /has expired/);
});

test('read_sheet types columns from the user tab, discover_fields filters by search and write refuses occupied cells', () => {
  const f = fixture();
  const sheet = f.book.sheets[0];
  [['Month', 'Orders', 'Note'], ['2026-08', 12, 'ok'], ['2026-09', 30, '']].forEach((line, r) => line.forEach((value, c) => { if (value !== '') f.setCell(sheet, r + 1, c + 1, value); }));
  const session = f.api.dmvChatSession_(f.book);
  const read = f.api.dmvChatReadSheet_(session, { sheetName: 'Output' });
  assert.deepEqual(plain(read.columns), [{ key: 'month', label: 'Month', type: 'text' }, { key: 'orders', label: 'Orders', type: 'number' }, { key: 'note', label: 'Note', type: 'text' }]);
  assert.equal(read.stats.orders.sum, 42);
  assert.throws(() => f.api.dmvChatReadSheet_(session, { sheetName: 'Nope' }), /No tab named "Nope"\. Tabs: Output/);
  assert.throws(() => f.api.dmvChatReadSheet_(session, { sheetName: 'Output', range: 'bad' }), /A1:F200/);
  const discovered = f.api.dmvChatDiscoverFields_(session, { connectionId: f.connection.id, reportType: 'daily', search: 'custom' });
  assert.deepEqual(plain(discovered), { total: 7, matched: 1, fields: [{ key: 'custom_1', label: 'Custom field', type: 'text', custom: true }] });
  assert.throws(() => f.api.dmvChatWriteSheet_(session, { resultId: read.resultId, sheetName: 'Output', startCell: 'A1' }), /existing data/);
  const written = f.api.dmvChatWriteSheet_(session, { resultId: read.resultId, sheetName: 'Output', startCell: 'E1' });
  assert.equal(written.range, 'Output!E1:G3');
  assert.equal(f.value(sheet, 2, 6), 12);
  const pie = f.api.dmvChatCreateChart_(session, { resultId: read.resultId, chartType: 'pie', xColumn: 'Month', seriesColumns: ['orders'] });
  assert.equal(pie.anchorCell, 'I1');
  assert.deepEqual(f.state.charts[0].spec.pieChart.domain.sourceRange.sources[0], { sheetId: sheet.id, startRowIndex: 1, endRowIndex: 3, startColumnIndex: 4, endColumnIndex: 5 });
  assert.throws(() => f.api.dmvChatCreateChart_(session, { sheetName: 'Output', range: 'E1:G3', chartType: 'line', xColumn: 'Month', seriesColumns: ['Missing'] }), /Unknown series column "Missing"\. Result columns are: Month, Orders, Note/);
  assert.throws(() => f.api.dmvChatCreateChart_(session, { resultId: read.resultId, chartType: 'pie', xColumn: 'Month', seriesColumns: ['orders', 'note'] }), /exactly one series/);
  assert.throws(() => f.api.dmvChatCreateChart_(session, { resultId: 'r_unknown', chartType: 'bar', xColumn: 'Month', seriesColumns: ['orders'] }), new RegExp('resultId r_unknown is not a table written by write_to_sheet in this chat\. Written resultIds: ' + read.resultId + '\.'));
  assert.throws(() => f.api.dmvChatCreateChart_(f.api.dmvChatSession_(f.book), { resultId: 'r_unknown', chartType: 'bar', xColumn: 'Month', seriesColumns: ['orders'] }), /Call write_to_sheet first/);
  const tools = f.api.dmvChatTools_(session);
  const failedChart = f.api.dmvChatRunTool_(session, tools, { name: 'create_chart', id: 'c1', input: { resultId: 'r_unknown', chartType: 'bar', xColumn: 'Month', seriesColumns: ['orders'] } });
  assert.equal(failedChart.isError, true);
  const errorEvent = session.events.find((event) => event.kind === 'error');
  assert.equal(errorEvent.tool, 'create_chart');
  assert.equal(errorEvent.recovered, undefined);
  f.api.dmvChatRunTool_(session, tools, { name: 'read_sheet', id: 'r2', input: { sheetName: 'Output' } });
  assert.equal(errorEvent.recovered, undefined, 'a different tool succeeding does not clear the failure');
  const retried = f.api.dmvChatRunTool_(session, tools, { name: 'create_chart', id: 'c2', input: { resultId: read.resultId, chartType: 'bar', xColumn: 'Month', seriesColumns: ['orders'], anchorCell: 'I20' } });
  assert.equal(retried.isError, false);
  assert.equal(errorEvent.recovered, true, 'a successful retry of the same tool marks the failure recovered');
  const count = f.state.charts.length;
  const another = f.api.dmvChatCreateChart_(session, { resultId: read.resultId, chartType: 'line', xColumn: 'Month', seriesColumns: ['orders'], title: 'Orders trend' });
  assert.equal(another.anchorCell, 'I39', 'a new chart goes below the charts at I1 and I20 instead of on top of them');
  assert.equal(f.state.charts.length, count + 1, 'earlier charts stay');
  assert.equal(f.api.dmvChatCreateChart_(session, { resultId: read.resultId, chartType: 'line', xColumn: 'Month', seriesColumns: ['orders'], anchorCell: 'I1' }).anchorCell, 'I1', 'an explicit anchor is honored');
});

test('OpenAI and Gemini adapters translate tools, tool calls and tool results into their own shapes', () => {
  const openai = fixture({ provider: 'openai' });
  openai.state.responses.push(
    { body: { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'run_report', arguments: JSON.stringify({ connectionId: openai.connection.id, reportType: 'daily' }) } }] } }] } },
    { body: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Three rows fetched.' } }] } }
  );
  const reply = openai.api.dmvChat({ text: 'Fetch the daily report', transcript: [{ role: 'user', text: 'Hello' }, { role: 'assistant', text: 'Hi', actions: ['Ran X'] }] });
  assert.equal(reply.text, 'Three rows fetched.');
  const first = payload(openai.state.http[0]);
  assert.equal(openai.state.http[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(openai.state.http[0].options.headers.Authorization, 'Bearer ' + AI_KEY);
  assert.equal(first.model, 'gpt-5.5');
  assert.equal(first.messages[0].role, 'system');
  assert.deepEqual(first.messages.slice(1, 3), [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Hi\n[Actions taken: Ran X]' }]);
  assert.equal(first.tools[0].type, 'function');
  assert.equal(first.tools[0].function.name, 'run_report');
  const second = payload(openai.state.http[1]);
  assert.equal(second.messages[4].tool_calls[0].id, 'call_1');
  assert.equal(second.messages[5].role, 'tool');
  assert.equal(second.messages[5].tool_call_id, 'call_1');
  assert.equal(JSON.parse(second.messages[5].content).rowCount, 3);

  const gemini = fixture({ provider: 'gemini' });
  gemini.state.responses.push(
    { body: { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ functionCall: { name: 'run_report', args: { connectionId: gemini.connection.id, reportType: 'daily' } }, thoughtSignature: 'sig-1' }] } }] } },
    { body: { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: 'Done.' }] } }] } }
  );
  assert.equal(gemini.api.dmvChat({ text: 'Fetch it' }).text, 'Done.');
  assert.equal(gemini.state.http[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
  assert.equal(gemini.state.http[0].options.headers['x-goog-api-key'], AI_KEY);
  const firstGemini = payload(gemini.state.http[0]);
  assert.equal(firstGemini.systemInstruction.parts[0].text.includes('DataMoov'), true);
  assert.equal(firstGemini.tools[0].functionDeclarations[0].name, 'run_report');
  const secondGemini = payload(gemini.state.http[1]);
  assert.equal(secondGemini.contents[1].role, 'model');
  assert.equal(secondGemini.contents[1].parts[0].thoughtSignature, 'sig-1', 'model parts are replayed unchanged');
  assert.equal(secondGemini.contents[2].parts[0].functionResponse.name, 'run_report');
  assert.equal(JSON.parse(secondGemini.contents[2].parts[0].functionResponse.response.result).rowCount, 3);
});

test('transcript replay merges consecutive turns, drops leading assistant text and bounds length', () => {
  const f = fixture();
  const turns = f.api.dmvChatTranscript_([
    { role: 'assistant', text: 'orphan' },
    { role: 'user', text: 'a' }, { role: 'user', text: 'b' },
    { role: 'assistant', text: 'x'.repeat(10000), actions: ['one', 'two'] },
    { role: 'tool', text: 'ignored' },
  ]);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].content[0].text, 'a\nb');
  assert.ok(turns[1].content[0].text.length < 6300);
  assert.ok(turns[1].content[0].text.endsWith('[Actions taken: one; two]'));
});

test('describe_database lists the scoped tables, standing instructions reach the prompt, and other sources decline', () => {
  const f = fixture();
  f.api.dmvRegisterConnector_({
    id: 'warehouse', label: 'Warehouse', description: 'Arbitrary SQL source', category: 'Database', allowedHosts: [],
    authFields: [{ key: 'chatSchemas', label: 'Schemas for chat', type: 'text', default: 'public' }],
    describeTables(ctx, options) {
      assert.equal(ctx.credentials.chatSchemas, 'public, sales');
      assert.equal(ctx.deadline, f.api.Date.now() + 200000, 'tools share the turn deadline');
      assert.equal(options.search, 'orders');
      return { scope: 'schemas public, sales', truncated: true, tables: [
        { name: 'public.orders', columns: [{ name: 'id', type: 'integer' }, { name: 'total', type: 'numeric' }] },
        { name: 'sales.leads', columns: [{ name: 'id', type: 'integer' }] },
      ] };
    },
    reports: [{ id: 'sql', label: 'SQL', fields: [], dateRange: false, configFields: [{ key: 'query', label: 'SQL', type: 'textarea', required: true }], fetch() { return { columns: [], rows: [] }; } }],
  });
  const warehouse = f.api.dmvSaveConnection({ connectorId: 'warehouse', label: 'Warehouse main', credentials: { chatSchemas: 'public, sales' } });
  const saved = f.api.dmvSaveAiSettings({ provider: 'anthropic', apiKey: '', instructions: '  Spend is in EUR.\nBrand campaigns start with BR_.  ' });
  assert.equal(saved.instructions, 'Spend is in EUR.\nBrand campaigns start with BR_.');
  assert.throws(() => f.api.dmvSaveAiSettings({ provider: 'anthropic', apiKey: '', instructions: 'x'.repeat(100001) }), /too long/);
  f.state.responses.push(
    anthropic([toolUse('d1', 'describe_database', { connectionId: warehouse.id, search: 'orders' })], 'tool_use'),
    anthropic([toolUse('d2', 'describe_database', { connectionId: f.connection.id })], 'tool_use'),
    anthropic([{ type: 'text', text: 'The orders table has id and total.' }])
  );
  const reply = f.api.dmvChat({ text: 'What tables do I have?', transcript: [] });
  assert.match(reply.text, /orders table/);
  const system = payload(f.state.http[0]).system[0].text;
  assert.match(system, /USER INSTRUCTIONS\n[^\n]*\nSpend is in EUR\.\nBrand campaigns start with BR_\./);
  assert.match(system, /Warehouse main \(Warehouse; chatSchemas=public, sales\) — call describe_database first/);
  assert.match(system, /call describe_database for the connection first/);
  const described = JSON.parse(payload(f.state.http[1]).messages[2].content[0].content);
  assert.deepEqual(described, { scope: 'schemas public, sales', totalTables: 1, tables: [{ name: 'public.orders', columns: ['id integer', 'total numeric'] }],
    note: 'The listing stopped at the column cap, so some tables are missing. Pass search to narrow the listing.' });
  const declined = JSON.parse(payload(f.state.http[2]).messages[4].content[0].content);
  assert.match(declined.error, /Orchard Ads has no database to describe/);
  assert.deepEqual(plain(reply.events).map((event) => event.text), ['Listed 1 tables · schemas public, sales · search "orders"', 'describe_database: Orchard Ads has no database to describe. Use discover_fields for its report fields.']);
  assert.ok(!payload(f.state.http[0]).tools.find((tool) => tool.name === 'describe_database').input_schema.properties.config, 'no report config is needed to describe a database');
});

test('every tool shares the turn deadline, and a batch that exhausts it ends with the tools-disabled answer', () => {
  const f = fixture({ fetchMs: 210000 });
  const started = f.api.Date.now();
  f.state.responses.push(
    anthropic([
      toolUse('t1', 'run_report', { connectionId: f.connection.id, reportType: 'daily' }),
      toolUse('t2', 'run_report', { connectionId: f.connection.id, reportType: 'daily' }),
    ], 'tool_use'),
    anthropic([{ type: 'text', text: 'One report finished; the second did not run.' }])
  );
  const reply = f.api.dmvChat({ text: 'Two reports please' });
  assert.match(reply.text, /second did not run/);
  assert.equal(f.fetched.length, 1, 'the second report never started');
  assert.equal(f.fetched[0].deadline, started + 200000, 'reports get the turn deadline, not a fresh 240 s');
  const second = payload(f.state.http[1]);
  const results = second.messages[2].content;
  assert.ok(!results[0].is_error);
  assert.equal(results[1].is_error, true);
  assert.match(JSON.parse(results[1].content).error, /time budget for this turn is exhausted/);
  assert.equal(second.tools, undefined, 'the budget path disables tools');
  assert.deepEqual(plain(reply.events).map((event) => event.kind), ['report']);
});

test('non-additive metrics keep their flag through results, stats, summaries and the model description', () => {
  const f = fixture();
  f.state.responses.push(
    anthropic([toolUse('r1', 'run_report', { connectionId: f.connection.id, reportType: 'daily', fields: ['date', 'campaign', 'reach', 'clicks'] })], 'tool_use'),
    anthropic([toolUse('s1', 'summarize', { resultId: 'PLACEHOLDER', groupBy: ['campaign'], metrics: [{ field: 'reach', agg: 'sum' }] })], 'tool_use'),
    anthropic([toolUse('s2', 'summarize', { resultId: 'PLACEHOLDER', groupBy: ['campaign'], metrics: [{ field: 'reach', agg: 'avg' }, { field: 'clicks', agg: 'sum' }] })], 'tool_use'),
    anthropic([toolUse('s3', 'summarize', { resultId: 'PLACEHOLDER2', metrics: [{ field: 'reach__avg', agg: 'sum' }] })], 'tool_use'),
    anthropic([{ type: 'text', text: 'Reach cannot be totalled; average reach per campaign is listed.' }])
  );
  const originalFetch = f.api.UrlFetchApp.fetch;
  const ids = [];
  f.api.UrlFetchApp.fetch = (url, options) => {
    const body = JSON.parse(options.payload);
    const last = body.messages[body.messages.length - 1];
    if (Array.isArray(last.content)) for (const block of last.content) {
      if (block.type === 'tool_result') {
        const parsed = JSON.parse(block.content);
        if (parsed.resultId && !ids.includes(parsed.resultId)) ids.push(parsed.resultId);
      }
    }
    const next = f.state.responses[0];
    if (next?.body?.content) for (const block of next.body.content) {
      if (block.type === 'tool_use' && block.input.resultId === 'PLACEHOLDER') block.input.resultId = ids[0];
      if (block.type === 'tool_use' && block.input.resultId === 'PLACEHOLDER2') block.input.resultId = ids[1];
    }
    return originalFetch(url, options);
  };
  const reply = f.api.dmvChat({ text: 'Total reach by campaign' });
  assert.match(reply.text, /cannot be totalled/);
  const first = JSON.parse(payload(f.state.http[1]).messages[2].content[0].content);
  assert.equal(first.columns.find((column) => column.key === 'reach').additive, false);
  assert.equal(first.columns.find((column) => column.key === 'clicks').additive, undefined);
  assert.equal(first.stats.reach.sum, undefined, 'no total is offered for a non-additive metric');
  assert.equal(first.stats.reach.max, 15);
  assert.equal(first.stats.clicks.sum, 270);
  assert.match(JSON.parse(payload(f.state.http[2]).messages[4].content[0].content).error, /cannot be summed/);
  const averaged = JSON.parse(payload(f.state.http[3]).messages[6].content[0].content);
  assert.deepEqual(averaged.rows, [{ campaign: 'Brand', reach__avg: 13.5, clicks__sum: 250 }, { campaign: 'Generic', reach__avg: 7, clicks__sum: 20 }]);
  assert.equal(averaged.columns.find((column) => column.key === 'reach__avg').additive, false);
  assert.match(JSON.parse(payload(f.state.http[4]).messages[8].content[0].content).error, /cannot be summed/, 'an average of a summary is not summable either');
  assert.match(payload(f.state.http[0]).system[0].text, /additive:false/);
});

test('a provider failure after a tool ran reports the completed steps, and result ids replay into the next turn', () => {
  const f = fixture();
  f.state.responses.push(
    anthropic([toolUse('t1', 'run_report', { connectionId: f.connection.id, reportType: 'daily' })], 'tool_use'),
    { code: 401, body: { error: { type: 'authentication_error', message: 'invalid x-api-key ' + AI_KEY } } }
  );
  const reply = f.api.dmvChat({ text: 'Spend by campaign' });
  assert.equal(reply.failed, true);
  assert.match(reply.text, /failed after the steps listed below/);
  assert.match(reply.text, /HTTP 401/);
  assert.ok(!reply.text.includes(AI_KEY));
  assert.deepEqual(plain(reply.events).map((event) => event.kind), ['report']);
  assert.match(reply.events[0].ref, /^r[a-f0-9]{8}$/);
  assert.match(reply.transcriptAppend[1].actions[0], /Ran Orchard Ads \(Orchard main\) · Daily campaigns · 3 rows \[r[a-f0-9]{8}\]$/);
  // The next turn sees the id in the replayed actions and can reuse the cached result.
  const resultId = reply.events[0].ref;
  f.state.responses.push(
    anthropic([toolUse('s1', 'summarize', { resultId, metrics: [{ field: 'spend', agg: 'sum' }] })], 'tool_use'),
    anthropic([{ type: 'text', text: 'Total spend EUR 35.50.' }])
  );
  const next = f.api.dmvChat({ text: 'So what was the total?', transcript: reply.transcriptAppend });
  assert.match(next.text, /35\.50/);
  const replayed = payload(f.state.http[2]).messages[1].content[0].text;
  assert.match(replayed, new RegExp('\\[Actions taken: Ran [^\\]]*\\[' + resultId + '\\]\\]'));
  assert.deepEqual(JSON.parse(payload(f.state.http[3]).messages[4].content[0].content).rows, [{ spend__sum: 35.5 }]);
  assert.equal(f.fetched.length, 1, 'the report was not run again');
  // Without any completed step the failure is still a plain error.
  f.state.responses.push({ code: 401, body: { error: { message: 'down' } } });
  assert.throws(() => f.api.dmvChat({ text: 'Again' }), /HTTP 401/);
});

test('read_sheet keeps long cell text whole for later writes and shortens only what the model sees', () => {
  const f = fixture();
  const long = 'x'.repeat(1300);
  const sheet = f.book.sheets[0];
  f.setCell(sheet, 1, 1, 'Note');
  f.setCell(sheet, 2, 1, long);
  f.state.responses.push(
    anthropic([toolUse('rd', 'read_sheet', { sheetName: sheet.name })], 'tool_use'),
    anthropic([toolUse('wr', 'write_to_sheet', { resultId: 'PLACEHOLDER', sheetName: 'Copy' })], 'tool_use'),
    anthropic([{ type: 'text', text: 'Copied.' }])
  );
  const originalFetch = f.api.UrlFetchApp.fetch;
  let id = null;
  f.api.UrlFetchApp.fetch = (url, options) => {
    const body = JSON.parse(options.payload);
    const last = body.messages[body.messages.length - 1];
    if (Array.isArray(last.content)) for (const block of last.content) {
      if (block.type === 'tool_result' && JSON.parse(block.content).resultId) id = JSON.parse(block.content).resultId;
    }
    const next = f.state.responses[0];
    if (next?.body?.content) for (const block of next.body.content) if (block.type === 'tool_use' && block.input.resultId === 'PLACEHOLDER') block.input.resultId = id;
    return originalFetch(url, options);
  };
  const reply = f.api.dmvChat({ text: 'Copy the first tab into a tab called Copy' });
  assert.match(reply.text, /Copied/);
  const seen = JSON.parse(payload(f.state.http[1]).messages[2].content[0].content);
  assert.equal(seen.rows[0].note.length, 81, 'the model sees a shortened sample');
  assert.equal(f.value(f.tab('Copy'), 2, 1), long, 'the written cell is complete');
});
