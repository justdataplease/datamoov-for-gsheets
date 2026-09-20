import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatamoovSandbox, plain } from './helpers/datamoov-sandbox.mjs';

const REQUEST = '1749b593-4bf4-41bd-88b9-024aa743f9df';
const reply = (text = '', toolCalls = [], stop = 'end') => ({ text, toolCalls, stop });
const call = (name, input, id = name) => ({ name, input, id });

function fixture() {
  const f = createDatamoovSandbox();
  f.fetched = 0;
  const fields = [
    { key: 'campaign', label: 'Campaign', type: 'text', default: true },
    { key: 'spend', label: 'Spend', type: 'currency', default: true },
  ];
  f.api.dmvRegisterConnector_({
    id: 'answer_fixture',
    label: 'Answer fixture',
    authFields: [],
    reports: [
      {
        id: 'daily',
        label: 'Daily performance',
        fields,
        dateRange: true,
        fetch() {
          f.fetched++;
          if (f.fetchError) throw new Error('Source unavailable for this period');
          return {
            columns: fields,
            rows: [{ campaign: 'Brand', spend: 125.5 }],
            metadata: { complete: true, currency: 'EUR' },
          };
        },
      },
    ],
  });
  f.connection = f.api.dmvSaveConnection({
    connectorId: 'answer_fixture',
    label: 'First account',
    credentials: {},
  });
  f.api.dmvAiRead_ = () => ({
    provider: 'gemini',
    model: 'gemini-3.8-flash',
    apiKey: 'offline-answer-key',
    maxRows: 1000,
  });
  f.replies = [];
  f.requests = [];
  f.api.dmvAiComplete_ = (_settings, request, deadline) => {
    f.requests.push(plain(request));
    const next = f.replies.shift();
    assert.ok(next, 'unexpected extra model request');
    return typeof next === 'function' ? next(request, deadline) : next;
  };
  f.runReport = () =>
    call('run_report', {
      connectionId: f.connection.id,
      reportType: 'daily',
      dateRange: { preset: 'lastWeek' },
    });
  f.chat = () =>
    f.api.dmvChat({
      text: 'Create the performance report and explain the numbers.',
      requestId: REQUEST,
    });
  f.progress = () => plain(f.api.dmvChatProgress({ requestId: REQUEST }));
  return f;
}

function lastResult(request) {
  const block = request.messages.at(-1).content.find((item) => item.type === 'tool_result');
  assert.ok(block);
  return JSON.parse(block.content);
}

test('a truncated answer gets one tool-free recovery without replaying a real fetch or sheet write', () => {
  const f = fixture();
  f.replies.push(
    reply('', [f.runReport()]),
    (request) =>
      reply('', [
        call('write_to_sheet', {
          resultId: lastResult(request).resultId,
          sheetName: 'Performance report',
        }),
      ]),
    reply('Spend was 125.', [], 'length'),
    reply('The report is ready. Spend was EUR 125.50.')
  );
  const result = f.chat();
  assert.equal(result.text, 'The report is ready. Spend was EUR 125.50.');
  assert.equal(result.failed, false);
  assert.equal(f.requests.length, 4);
  assert.equal(f.fetched, 1);
  assert.equal(f.state.batches.length, 1);
  assert.equal(f.tab('Performance report').getRange(2, 2).getValues()[0][0], 125.5);
  assert.equal(result.events.filter((event) => event.kind === 'write').length, 1);
  assert.ok(f.requests.slice(0, 3).every((request) => request.tools.length > 0));
  assert.deepEqual(f.requests[3].tools, []);
  assert.match(JSON.stringify(f.requests[3].messages), /write_to_sheet/);
  assert.ok(!JSON.stringify(f.requests[3].messages).includes('Spend was 125.'));
  assert.equal(f.progress().status, 'complete');
  assert.ok(f.progress().steps.every((step) => step.state === 'complete'));
});

test('the round-budget final answer uses the same single bounded recovery', () => {
  const f = fixture();
  f.api.DMV_CHAT.maxRounds = 1;
  f.replies.push(
    reply('', [f.runReport()]),
    reply('Final spend 12', [], 'length'),
    reply('Spend was EUR 125.50.')
  );
  const result = f.chat();
  assert.equal(result.text, 'Spend was EUR 125.50.');
  assert.equal(result.failed, false);
  assert.equal(f.requests.length, 3);
  assert.equal(f.fetched, 1);
  assert.deepEqual(f.requests[1].tools, []);
  assert.deepEqual(f.requests[2].tools, []);
  assert.equal(f.state.batches.length, 0);
  assert.equal(f.progress().status, 'complete');
});

test('a second output cutoff returns a clear failure without displaying cut-off numbers', () => {
  const f = fixture();
  f.replies.push(reply('Spend 999,', [], 'length'), reply('Clicks 888,', [], 'length'));
  const result = f.chat();
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests[1].tools, []);
  assert.equal(result.failed, true);
  assert.match(result.text, /output limit/);
  assert.doesNotMatch(JSON.stringify(result), /999,|888,/);
  assert.equal(f.progress().status, 'failed');
  assert.equal(f.fetched, 0);
  assert.equal(f.state.batches.length, 0);
});

test('less than twenty seconds remaining skips the extra AI request', () => {
  const f = fixture();
  f.replies.push(() => {
    f.advance(f.api.DMV_CHAT.deadlineMs - 19999);
    return reply('Spend 777,', [], 'length');
  });
  const result = f.chat();
  assert.equal(f.requests.length, 1);
  assert.equal(result.failed, true);
  assert.match(result.text, /output limit/);
  assert.doesNotMatch(result.text, /777,/);
  assert.equal(f.progress().status, 'failed');
});

test('tool calls from a cutoff reply are never executed', () => {
  const f = fixture();
  f.replies.push(
    reply('Starting', [f.runReport()], 'length'),
    reply('I could not complete the request.')
  );
  const result = f.chat();
  assert.equal(result.failed, false);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests[1].tools, []);
  assert.equal(f.fetched, 0);
  assert.equal(f.state.batches.length, 0);
  assert.equal(result.events.length, 0);
  assert.ok(!JSON.stringify(f.requests[1].messages).includes('tool_use'));
});

test('unexpected tool calls in the tool-free recovery are rejected without execution', () => {
  const f = fixture();
  f.replies.push(reply('Truncated', [], 'length'), reply('Will fetch', [f.runReport()], 'tool'));
  const result = f.chat();
  assert.equal(result.failed, true);
  assert.match(result.text, /output limit/);
  assert.equal(f.requests.length, 2);
  assert.equal(f.fetched, 0);
  assert.equal(f.state.batches.length, 0);
});

test('successful answer recovery preserves an actual failed source in events and progress', () => {
  const f = fixture();
  f.fetchError = true;
  f.replies.push(
    reply('', [f.runReport()]),
    reply('Unavailable 555,', [], 'length'),
    reply('The source was unavailable. No sheet was written.')
  );
  const result = f.chat();
  assert.equal(result.failed, false, 'the final answer recovered successfully');
  assert.equal(f.fetched, 1);
  assert.equal(f.state.batches.length, 0);
  assert.ok(
    result.events.some((event) => event.kind === 'error' && /Source unavailable/.test(event.text))
  );
  assert.equal(f.progress().status, 'failed', 'source failure remains visible');
  const failed = f.progress().steps.filter((step) => step.state === 'error');
  assert.deepEqual(
    failed.map((step) => step.text),
    ['Fetching report data']
  );
  assert.equal(f.progress().steps.at(-1).state, 'complete');
  assert.equal(f.requests.length, 3);
});

test('a provider failure during recovery preserves completed output without another attempt', () => {
  const f = fixture();
  f.replies.push(
    reply('', [f.runReport()]),
    (request) =>
      reply('', [
        call('write_to_sheet', {
          resultId: lastResult(request).resultId,
          sheetName: 'Retained report',
        }),
      ]),
    reply('Spend 333,', [], 'length'),
    () => {
      throw new Error('Recovery provider failed');
    }
  );
  const result = f.chat();
  assert.equal(result.failed, true);
  assert.equal(f.requests.length, 4);
  assert.equal(f.fetched, 1);
  assert.equal(f.state.batches.length, 1);
  assert.equal(result.events.filter((event) => event.kind === 'write').length, 1);
  assert.match(result.text, /output limit/);
  assert.doesNotMatch(result.text, /333,/);
  assert.equal(f.progress().status, 'failed');
});
