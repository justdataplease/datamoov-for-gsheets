import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatamoovSandbox, plain } from './helpers/datamoov-sandbox.mjs';

const AI_KEY = 'offline-dashboard-chat-ai-key';
const SOURCE_KEY = 'offline-dashboard-source-secret';

function fixture({ maxRows = 10 } = {}) {
  const f = createDatamoovSandbox();
  const columns = [
    { key: 'campaign', label: 'Campaign', type: 'text', role: 'dimension' },
    { key: 'spend', label: 'Spend', type: 'currency', role: 'metric' },
  ];
  f.rows = {
    canopy: [{ campaign: 'First', spend: 3 }],
    meadow: [{ campaign: 'Second', spend: 7 }],
  };
  f.fetched = [];
  f.connections = ['canopy', 'meadow'].map((id) => {
    f.api.dmvRegisterConnector_({
      id,
      label: id + ' fixture',
      category: 'Test',
      allowedHosts: [],
      authFields: [{ key: 'token', label: 'Token', type: 'password', required: true }],
      reports: [
        {
          id: 'daily',
          label: 'Daily',
          fields: columns,
          dateRange: true,
          configFields: [],
          fetch(ctx) {
            f.fetched.push({
              source: id,
              maxRows: ctx.maxRows,
              startDate: ctx.startDate,
              endDate: ctx.endDate,
            });
            if (f.rows[id] instanceof Error) throw f.rows[id];
            return { columns, rows: f.rows[id], metadata: { complete: true, currency: 'EUR' } };
          },
        },
      ],
    });
    return f.api.dmvSaveConnection({
      connectorId: id,
      label: id + ' account',
      credentials: { token: SOURCE_KEY },
    });
  });
  f.api.dmvSaveAiSettings({ provider: 'anthropic', apiKey: AI_KEY, maxRows });
  f.plan = {
    name: 'Campaign dashboard',
    sources: f.connections.map((connection, index) => ({
      label: 'Account ' + (index + 1),
      connectionId: connection.id,
      reportType: 'daily',
      dateRange: { preset: 'lastMonth' },
      fields: columns.map((column) => column.key),
      mapping: columns.map((column) => ({ field: column.key, key: column.key })),
    })),
    summary: {
      groupBy: ['campaign', 'currency'],
      metrics: [{ field: 'spend', agg: 'sum' }],
      orderBy: { field: 'spend__sum', direction: 'desc' },
    },
    dataTarget: { sheetName: 'Campaign data', startCell: 'A1' },
    target: { sheetName: 'Campaign dashboard', startCell: 'B3' },
  };
  return f;
}

const tool = (id, name, input) => ({ type: 'tool_use', id, name, input });
const answer = (text = 'The dashboard is ready. Refresh it from Reports > Dashboards.') => ({
  type: 'text',
  text,
});
const payload = (request) => JSON.parse(request.options.payload);

function scriptedTurn(f, stages) {
  const fetch = f.api.UrlFetchApp.fetch;
  const results = new Map();
  let index = 0;
  f.api.UrlFetchApp.fetch = (url, options) => {
    const request = JSON.parse(options.payload);
    for (const message of request.messages) {
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block.type === 'tool_result')
          results.set(block.tool_use_id, { ...block, value: JSON.parse(block.content) });
      }
    }
    assert.ok(index < stages.length, 'the chat must finish within the scripted plan');
    const content = stages[index++](results, request);
    f.state.responses.push({
      body: {
        content,
        stop_reason: content.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn',
      },
    });
    return fetch(url, options);
  };
  try {
    const reply = plain(
      f.api.dmvChat({
        text: 'Create a reusable campaign dashboard from both accounts, with a chart.',
        transcript: [],
      })
    );
    assert.equal(index, stages.length);
    return { reply, results };
  } finally {
    f.api.UrlFetchApp.fetch = fetch;
  }
}

function buildDashboard(f) {
  return scriptedTurn(f, [
    () => [tool('save', 'save_dashboard', f.plan)],
    (results) => {
      assert.notEqual(results.get('save').is_error, true);
      return [tool('run', 'run_dashboard', { id: results.get('save').value.id })];
    },
    (results) => {
      const run = results.get('run');
      assert.notEqual(run.is_error, true);
      return [
        tool('chart', 'create_chart', {
          sheetName: run.value.target.sheetName,
          range: run.value.reportRange,
          chartType: 'column',
          xColumn: run.value.columns[0].label,
          seriesColumns: [run.value.columns[2].label],
          title: 'Campaign spend',
          includeFutureRows: true,
        }),
      ];
    },
    (results) => {
      assert.notEqual(results.get('chart').is_error, true);
      return [answer()];
    },
  ]);
}

function assertPrivate(f, reply) {
  for (const call of f.state.http) {
    assert.equal(call.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(call.options.headers['x-api-key'], AI_KEY);
    assert.ok(!call.options.payload.includes(AI_KEY));
    assert.ok(!call.options.payload.includes(SOURCE_KEY));
  }
  assert.ok(!JSON.stringify(reply).includes(AI_KEY));
  assert.ok(!JSON.stringify(reply).includes(SOURCE_KEY));
  assert.ok(!JSON.stringify(plain(f.api.dmvListDashboards())).includes(SOURCE_KEY));
}

test('actual chat saves, runs and charts a multi-provider dashboard with one data batch and private messages', () => {
  const f = fixture();
  const { reply, results } = buildDashboard(f);
  const saved = results.get('save').value,
    run = results.get('run').value;
  assert.deepEqual(
    reply.events.map((event) => event.kind),
    ['dashboard', 'dashboard', 'write', 'chart']
  );
  assert.match(reply.text, /Reports > Dashboards/);
  assert.equal(run.dataRowCount, 2);
  assert.equal(run.rowCount, 2);
  assert.equal(run.reportRange, 'B3:D5');
  assert.equal(run.dataRange, 'A1:D3');
  assert.equal(saved.dataUrl, null, 'saving a definition alone creates no output link');
  assert.equal(saved.reportUrl, null);
  const outputUrl = (name, start) =>
    'https://docs.google.com/spreadsheets/d/' +
    f.book.getId() +
    '/edit#gid=' +
    f.book.getSheetByName(name).getSheetId() +
    '&range=' +
    start;
  assert.equal(run.dataUrl, outputUrl('Campaign data', 'A1'));
  assert.equal(run.reportUrl, outputUrl('Campaign dashboard', 'B3'));
  assert.equal(reply.events[0].action, 'saved');
  assert.equal(reply.events[1].action, 'refreshed');
  assert.deepEqual(
    reply.events[1].links.map((link) => link.url),
    [run.reportUrl, run.dataUrl]
  );
  assert.match(
    results.get('chart').value.url,
    new RegExp('#gid=' + f.book.getSheetByName('Campaign dashboard').getSheetId() + '&range=')
  );
  assert.equal(plain(f.api.dmvListDashboards())[0].reportUrl, run.reportUrl);
  assert.deepEqual(
    run.columns.map((column) => column.key),
    ['campaign', 'currency', 'spend__sum']
  );
  assert.deepEqual(
    f.fetched.map((entry) => entry.source),
    ['canopy', 'meadow']
  );
  assert.ok(f.fetched.every((entry) => entry.maxRows === 10));
  assert.ok(
    f.fetched.every((entry) => entry.startDate === '2026-08-01' && entry.endDate === '2026-08-31')
  );
  const writes = f.state.batches.filter((entry) =>
    entry.body.requests.some((request) => request.updateCells)
  );
  assert.equal(writes.length, 1, 'both tables are committed together once');
  assert.equal(writes[0].body.requests.filter((request) => request.addSheet).length, 2);
  assert.equal(f.state.batches.length, 2, 'the chart is a separate completed action');
  const report = f.book.getSheetByName('Campaign dashboard');
  assert.equal(f.value(report, 4, 2), 'Second');
  assert.equal(f.value(report, 4, 4), 7);
  assert.equal(f.readOutput(saved.id + '-report').sheetId, report.id);
  const first = payload(f.state.http[0]);
  const saveSchema = first.tools.find((item) => item.name === 'save_dashboard').input_schema;
  assert.equal(saveSchema.properties.summary.properties.filters, undefined);
  assert.equal(saveSchema.properties.summary.properties.resultId, undefined);
  assert.equal(saveSchema.properties.sources.items.properties.maxRows.maximum, 10);
  assert.equal(
    first.tools.find((item) => item.name === 'create_chart').input_schema.properties
      .includeFutureRows.type,
    'boolean'
  );
  assertPrivate(f, reply);
});

test('future-row chart ranges survive a fresh sidebar refresh with no AI settings or cached results', () => {
  const f = fixture();
  const { results } = buildDashboard(f);
  const id = results.get('save').value.id;
  const chart = plain(f.state.charts[0]);
  const domain = chart.spec.basicChart.domains[0].domain.sourceRange.sources[0];
  const series = chart.spec.basicChart.series[0].series.sourceRange.sources[0];
  assert.deepEqual(domain, {
    sheetId: f.book.getSheetByName('Campaign dashboard').id,
    startRowIndex: 2,
    startColumnIndex: 1,
    endColumnIndex: 2,
  });
  assert.equal(Object.hasOwn(series, 'endRowIndex'), false);
  const httpCount = f.state.http.length;
  f.api.dmvDeleteAiSettings();
  f.state.cache.data.clear();
  f.api.dmvAiRequest_ = () => {
    throw new Error('AI requests are not needed for refresh');
  };
  f.rows.canopy.push({ campaign: 'New after chat', spend: 20 });
  const freshSidebar = plain(f.api.dmvBootstrap());
  assert.equal(freshSidebar.ai.configured, false);
  assert.equal(freshSidebar.dashboards[0].id, id);
  const refreshed = plain(f.api.dmvRunDashboard(id));
  assert.equal(refreshed.rowCount, 3);
  assert.equal(refreshed.reportRange, 'B3:D6');
  assert.equal(f.fetched.length, 4, 'both sources were fetched again');
  assert.equal(f.state.http.length, httpCount);
  assert.equal(f.state.charts.length, 1);
  assert.deepEqual(plain(f.state.charts[0]), chart);
  assert.equal(f.value(f.book.getSheetByName('Campaign dashboard'), 4, 2), 'New after chat');
});

test('chat rejects over-limit dashboard saves and unsupported filters before source fetches or writes', () => {
  for (const invalid of ['row limit', 'filters']) {
    const f = fixture({ maxRows: 2 });
    const plan = plain(f.plan);
    if (invalid === 'row limit') plan.sources[0].maxRows = 3;
    else plan.summary.filters = [{ field: 'spend', op: 'gt', value: 1 }];
    const { results, reply } = scriptedTurn(f, [
      () => [tool('save', 'save_dashboard', plan)],
      (results) => {
        assert.equal(results.get('save').is_error, true);
        assert.match(
          results.get('save').value.error,
          invalid === 'row limit' ? /at most 2 rows/ : /documented dashboard settings/
        );
        return [answer('The dashboard could not be saved with those settings.')];
      },
    ]);
    assert.equal(results.get('save').value.id, undefined);
    assert.deepEqual(plain(f.api.dmvListDashboards()), []);
    assert.equal(f.fetched.length, 0);
    assert.equal(f.state.batches.length, 0);
    assert.deepEqual(
      reply.events.map((event) => event.kind),
      ['error']
    );
    assertPrivate(f, reply);
  }
});

test('refresh honors a row limit raised in Settings after the dashboard was saved, and names the source that fails', () => {
  const f = fixture({ maxRows: 2 });
  const saved = plain(
    f.api.dmvSaveDashboard({
      ...f.plan,
      sources: f.plan.sources.map((source) => ({ ...source, maxRows: 2 })),
    })
  );
  f.rows.meadow = [1, 2, 3].map((spend) => ({ campaign: 'Campaign ' + spend, spend }));
  assert.throws(
    () => f.api.dmvRunDashboard(saved.id),
    /^Error: Account 2: .*row limit.*This source allows 2 rows.*Maximum rows per chat report/
  );
  assert.equal(f.state.batches.length, 0);
  assert.match(plain(f.api.dmvListDashboards())[0].lastError, /^Account 2: /);

  f.api.dmvSaveAiSettings({ provider: 'anthropic', maxRows: 5 });
  f.fetched.length = 0;
  const { reply } = scriptedTurn(f, [
    () => [tool('run', 'run_dashboard', { id: saved.id })],
    (results) => {
      assert.equal(results.get('run').is_error, undefined);
      return [answer()];
    },
  ]);
  assert.ok(f.fetched.every((entry) => entry.maxRows === 5));
  assert.ok(reply.events.some((event) => event.action === 'refreshed'));
});

test('a failed source reaches the model as a redacted tool error with no sheet write action', () => {
  const f = fixture();
  f.rows.meadow = new Error('Source rejected ' + SOURCE_KEY);
  const { reply } = scriptedTurn(f, [
    () => [tool('save', 'save_dashboard', f.plan)],
    (results) => [tool('run', 'run_dashboard', { id: results.get('save').value.id })],
    (results) => {
      assert.equal(results.get('run').is_error, true);
      assert.match(results.get('run').value.error, /Source rejected \[redacted\]/);
      return [answer('The second source failed; no output tabs were created.')];
    },
  ]);
  assert.equal(f.fetched.length, 2);
  assert.equal(f.state.batches.length, 0);
  assert.equal(f.book.getSheetByName('Campaign data'), null);
  assert.equal(f.book.getSheetByName('Campaign dashboard'), null);
  assert.deepEqual(
    reply.events.map((event) => event.kind),
    ['dashboard', 'error']
  );
  assertPrivate(f, reply);
});

test('post-commit receipt failure remains visible as a sheet write and recoverable tool error', () => {
  const f = fixture();
  const set = f.state.user.setProperty;
  f.state.user.setProperty = function (key, value) {
    if (key.startsWith('dmv:v1:output:') && key.endsWith('-report'))
      throw new Error('Receipt storage outage');
    return set.call(this, key, value);
  };
  let output;
  try {
    output = scriptedTurn(f, [
      () => [tool('save', 'save_dashboard', f.plan)],
      (results) => [tool('run', 'run_dashboard', { id: results.get('save').value.id })],
      (results) => {
        assert.equal(results.get('run').is_error, true);
        assert.match(results.get('run').value.error, /tabs were updated/);
        return [
          answer(
            'Both tabs were updated, but recording ownership failed. Refresh again to recover safely.'
          ),
        ];
      },
    ]);
  } finally {
    f.state.user.setProperty = set;
  }
  assert.deepEqual(
    output.reply.events.map((event) => event.kind),
    ['dashboard', 'write', 'error']
  );
  assert.match(output.reply.events.find((event) => event.kind === 'write').text, /Updated.*tabs/);
  assert.equal(f.state.batches.length, 1);
  assert.equal(output.reply.events.find((event) => event.kind === 'write').links.length, 2);
  assert.ok(f.book.getSheetByName('Campaign dashboard'));
  const id = output.results.get('save').value.id;
  assert.equal(f.readOutput(id + '-report'), null);
  f.api.dmvRunDashboard(id);
  assert.ok(f.readOutput(id + '-report'));
  assert.equal(f.state.batches.length, 2);
  assertPrivate(f, output.reply);
});

test('ordinary write_to_sheet reports completed cells when its ownership receipt fails', () => {
  const f = fixture();
  const set = f.state.user.setProperty;
  f.state.user.setProperty = function (key, value) {
    if (key.startsWith('dmv:v1:output:') && key.includes(':chat-'))
      throw new Error('Receipt storage outage');
    return set.call(this, key, value);
  };
  let output;
  try {
    output = scriptedTurn(f, [
      () => [
        tool('fetch', 'run_report', { connectionId: f.connections[0].id, reportType: 'daily' }),
      ],
      (results) => {
        assert.notEqual(results.get('fetch').is_error, true);
        return [
          tool('write', 'write_to_sheet', {
            resultId: results.get('fetch').value.resultId,
            sheetName: 'Single report',
          }),
        ];
      },
      (results) => {
        assert.equal(results.get('write').is_error, true);
        assert.match(results.get('write').value.error, /tabs were updated/);
        return [answer('The report cells were written, but ownership storage needs recovery.')];
      },
    ]);
  } finally {
    f.state.user.setProperty = set;
  }
  assert.equal(
    output.reply.events.find((event) => event.kind === 'write').links[0].label,
    'Single report'
  );
  assert.deepEqual(
    output.reply.events.map((event) => event.kind),
    ['report', 'write', 'error']
  );
  assert.equal(output.reply.events.filter((event) => event.kind === 'write').length, 1);
  assert.match(
    output.reply.events.find((event) => event.kind === 'write').text,
    /tabs were updated/
  );
  assert.equal(f.state.batches.length, 1);
  assert.equal(f.value(f.book.getSheetByName('Single report'), 2, 1), 'First');
  assert.equal(f.value(f.book.getSheetByName('Single report'), 2, 2), 3);
  assert.equal(
    [...f.state.user.data.keys()].filter((key) => key.startsWith('dmv:v1:output:')).length,
    0
  );
  assertPrivate(f, output.reply);
});
