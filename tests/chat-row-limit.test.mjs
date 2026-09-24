import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatamoovSandbox } from './helpers/datamoov-sandbox.mjs';

const AI_KEY = 'offline-chat-row-limit-key';
const key = 'dmv:v1:ai:settings';
const anthropic = (content, stop = 'end_turn') => ({ body: { content, stop_reason: stop } });

function fixture({ maxRows = 3, rowCount = 1, sql = false } = {}) {
  const f = createDatamoovSandbox();
  const fetched = [];
  f.api.dmvRegisterConnector_({
    id: 'rowlimit', label: 'Row limit fixture', category: 'Test', allowedHosts: [],
    authFields: [],
    reports: [{
      id: sql ? 'sql' : 'daily', label: sql ? 'SQL fixture' : 'Daily fixture', dateRange: false,
      fields: [{ key: 'value', label: 'Value', type: 'number', default: true }],
      configFields: sql ? [{ key: 'query', label: 'Query', type: 'textarea', required: true }] : [],
      fetch(ctx) {
        if (sql) f.api.dmvReadOnlySql_(ctx.config.query);
        fetched.push({ maxRows: ctx.maxRows, query: ctx.config.query });
        return { columns: [{ key: 'value', label: 'Value', type: 'number' }],
          rows: Array.from({ length: rowCount }, (_, index) => ({ value: index + 1 })),
          metadata: { complete: true } };
      },
    }],
  });
  const connection = f.api.dmvSaveConnection({ connectorId: 'rowlimit', label: 'Fixture', credentials: {} });
  f.api.dmvSaveAiSettings({ provider: 'anthropic', apiKey: AI_KEY, maxRows });
  return { ...f, connection, fetched, sql };
}

function turn(f, fields = {}) {
  f.state.responses.push(
    anthropic([{ type: 'tool_use', id: 'run-fixture', name: 'run_report', input: {
      connectionId: f.connection.id, reportType: f.sql ? 'sql' : 'daily',
      ...(f.sql ? { config: { query: 'SELECT 1 AS value' } } : {}), ...fields,
    } }], 'tool_use'),
    anthropic([{ type: 'text', text: 'Finished.' }]),
  );
  const reply = f.api.dmvChat({ text: 'Run the fixture report.' });
  const second = JSON.parse(f.state.http[1].options.payload);
  const block = second.messages.flatMap((message) => Array.isArray(message.content) ? message.content : [])
    .find((item) => item.type === 'tool_result');
  return { reply, block, result: JSON.parse(block.content), first: JSON.parse(f.state.http[0].options.payload) };
}

test('chat maxRows defaults to 10000 and remains private and retained on omitted edits', () => {
  const f = createDatamoovSandbox();
  assert.equal(f.api.dmvAiSettings().maxRows, 10000);
  const initial = f.api.dmvSaveAiSettings({ provider: 'anthropic', apiKey: AI_KEY });
  assert.equal(initial.maxRows, 10000);
  const edited = f.api.dmvSaveAiSettings({ provider: 'anthropic', maxRows: 2500 });
  assert.equal(edited.maxRows, 2500);
  const retained = f.api.dmvSaveAiSettings({ provider: 'anthropic', model: 'claude-sonnet-5' });
  assert.equal(retained.maxRows, 2500);
  assert.equal(JSON.parse(f.state.user.getProperty(key)).maxRows, 2500);
  assert.equal(JSON.parse(f.state.user.getProperty(key)).apiKey, AI_KEY);
  assert.equal(f.api.dmvBootstrap().ai.maxRows, 2500);
  assert.equal(JSON.stringify(f.api.dmvBootstrap()).includes(AI_KEY), false);
  assert.deepEqual(f.state.script.getProperties(), {});
  assert.deepEqual(f.state.document.getProperties(), {});
  assert.equal(createDatamoovSandbox().api.dmvAiSettings().maxRows, 10000);
});

test('chat maxRows accepts integer boundaries and rejects malformed values without changing settings', () => {
  const f = fixture();
  for (const maxRows of [1, 30000])
    assert.equal(f.api.dmvSaveAiSettings({ provider: 'anthropic', maxRows }).maxRows, maxRows);
  const before = f.state.user.getProperty(key);
  for (const maxRows of [0, -1, 30001, 1.5, '1000', '', null, true, {}, [], Infinity, NaN]) {
    assert.throws(() => f.api.dmvSaveAiSettings({ provider: 'anthropic', maxRows }), /whole number/);
    assert.equal(f.state.user.getProperty(key), before);
  }
  const legacy = JSON.parse(before);
  delete legacy.maxRows;
  f.state.user.setProperty(key, JSON.stringify(legacy));
  assert.equal(f.api.dmvAiSettings().maxRows, 10000);
});

test('actual chat rejects a model-supplied limit above the saved cap before fetching', () => {
  const f = fixture({ maxRows: 3 });
  const output = turn(f, { maxRows: 4 });
  assert.equal(output.block.is_error, true);
  assert.match(output.result.error, /between 1 and 3/);
  assert.equal(f.fetched.length, 0);
  assert.equal(f.state.batches.length, 0);
});

test('actual chat uses the saved cap when the model omits maxRows and preserves complete results', () => {
  const f = fixture({ maxRows: 3, rowCount: 3 });
  const output = turn(f);
  assert.notEqual(output.block.is_error, true);
  assert.equal(output.result.rowCount, 3);
  assert.equal(f.fetched[0].maxRows, 3);
  const tool = output.first.tools.find((item) => item.name === 'run_report');
  assert.equal(tool.input_schema.properties.maxRows.maximum, 3);
  assert.equal(output.result.rows.length, 3);
});

test('ordinary and SQL chat reports reject oversized complete fetches instead of truncating', () => {
  for (const sql of [false, true]) {
    const f = fixture({ maxRows: 3, rowCount: 4, sql });
    const output = turn(f);
    assert.equal(f.fetched[0].maxRows, 3);
    assert.equal(output.block.is_error, true);
    assert.match(output.result.error, /row limit/);
    assert.match(output.result.error, /partial data was not used/);
    assert.equal(output.reply.events.some((event) => event.kind === 'report'), false);
    assert.equal(f.state.batches.length, 0);
  }
});

test('a smaller model-requested cap remains enforceable within the saved maximum', () => {
  const f = fixture({ maxRows: 10, rowCount: 2 });
  const output = turn(f, { maxRows: 2 });
  assert.notEqual(output.block.is_error, true);
  assert.equal(f.fetched[0].maxRows, 2);
  assert.equal(output.result.rowCount, 2);
});