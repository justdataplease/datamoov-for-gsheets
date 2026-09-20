import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatamoovSandbox, plain } from './helpers/datamoov-sandbox.mjs';

const REQUEST = '83c174c2-5c4c-43e2-aee1-df7db3b33b22';
const OTHER = '404e0bfe-42a1-469a-a8e4-f033aaefb657';
const SECRET = 'private-progress-fixture-secret';
function fixture() {
  const f = createDatamoovSandbox();
  f.api.dmvAiRead_ = () => ({ provider: 'test', apiKey: SECRET, maxRows: 1234 });
  f.api.dmvChatTools_ = () => [];
  f.api.dmvAiComplete_ = () => reply('Finished');
  f.progress = (requestId = REQUEST) => plain(f.api.dmvChatProgress({ requestId }));
  return f;
}
function reply(text = '', calls = [], stop = 'end') {
  return { text, toolCalls: calls, stop };
}
function call(name, id = name) {
  return { name, id, input: { query: SECRET, account: SECRET } };
}
function chat(f, requestId = REQUEST) {
  return f.api.dmvChat({ text: SECRET, requestId });
}

test('progress follows actual AI and tool boundaries and caches only fixed metadata', () => {
  const f = fixture(),
    observed = [],
    cached = [];
  const originalPut = f.state.cache.put;
  f.state.cache.put = (key, value, ttl) => {
    cached.push({ key, value, ttl });
    originalPut(key, value, ttl);
  };
  let rounds = 0;
  f.api.dmvAiComplete_ = () => {
    observed.push(f.progress());
    return ++rounds === 1 ? reply(SECRET, [call('run_report'), call('summarize')]) : reply(SECRET);
  };
  f.api.dmvChatTools_ = () =>
    ['run_report', 'summarize'].map((name) => ({
      name,
      run(session) {
        observed.push(f.progress());
        session.events.push({ kind: 'summary', text: SECRET });
        return { rows: [{ private: SECRET }], query: SECRET };
      },
    }));
  const result = chat(f);
  assert.equal(result.text, SECRET);
  assert.deepEqual(
    observed.map((snapshot) => snapshot.steps.at(-1).text),
    ['Working on your request', 'Fetching report data', 'Summarizing data', 'Reviewing results']
  );
  assert.ok(
    observed.every(
      (snapshot) => snapshot.status === 'running' && snapshot.steps.at(-1).state === 'running'
    )
  );
  assert.ok(
    observed.every((snapshot) =>
      snapshot.steps.slice(0, -1).every((step) => step.state === 'complete')
    )
  );
  const done = f.progress();
  assert.equal(done.status, 'complete');
  assert.deepEqual(
    done.steps.map((step) => step.id),
    [1, 2, 3, 4, 5]
  );
  assert.ok(done.steps.every((step) => step.state === 'complete'));
  assert.ok(cached.length >= 10);
  assert.ok(cached.every((entry) => entry.ttl === 300 && !entry.value.includes(SECRET)));
  assert.ok(
    cached.every(
      (entry) =>
        Object.keys(JSON.parse(entry.value)).sort().join(',') === 'requestId,status,steps,updatedAt'
    )
  );
  assert.equal(f.state.lockAcquires, 0, 'polling must not contend on the user lock');
});

test('progress is isolated by executing user, active spreadsheet and request ID, and expires', () => {
  const f = fixture();
  chat(f);
  assert.equal(f.progress().status, 'complete');
  assert.equal(f.progress(OTHER).status, 'unavailable');
  const otherBook = f.addSpreadsheet('spreadsheet-two', ['Output']);
  f.setActive(otherBook);
  assert.equal(f.progress().status, 'unavailable');
  f.setActive(f.book);
  assert.equal(f.progress().status, 'complete');
  const anotherUser = fixture();
  assert.equal(anotherUser.progress().status, 'unavailable');
  f.advance(300001);
  assert.equal(f.progress().status, 'unavailable');
});

test('invalid request IDs fail before AI or cache access while legacy callers create no progress', () => {
  const f = fixture();
  let aiCalls = 0,
    puts = 0;
  f.api.dmvAiComplete_ = () => {
    aiCalls++;
    return reply('Done');
  };
  f.state.cache.put = () => {
    puts++;
  };
  for (const requestId of ['short', '/'.repeat(32), '-'.repeat(32), 'x'.repeat(81), {}, 1, null]) {
    assert.throws(() => chat(f, requestId), /request ID/);
    assert.throws(() => f.api.dmvChatProgress({ requestId }), /request ID/);
  }
  assert.equal(aiCalls, 0);
  assert.equal(puts, 0);
  const legacy = f.api.dmvChat({ text: 'Hello' });
  assert.equal(legacy.text, 'Done');
  assert.equal(puts, 0);
});

test('initial validation and AI failures finalize progress before throwing', () => {
  const missingSettings = fixture();
  missingSettings.api.dmvAiRead_ = () => null;
  assert.throws(() => chat(missingSettings), /AI provider/);
  assert.equal(missingSettings.progress().status, 'failed');
  assert.equal(missingSettings.progress().steps.at(-1).state, 'error');
  const providerFailure = fixture();
  providerFailure.api.dmvAiComplete_ = () => {
    throw new Error('Failure with ' + SECRET);
  };
  assert.throws(() => chat(providerFailure));
  const status = providerFailure.progress();
  assert.equal(status.status, 'failed');
  assert.equal(status.steps.at(-1).text, 'Working on your request');
  assert.equal(status.steps.at(-1).state, 'error');
  assert.ok(!JSON.stringify(status).includes(SECRET));
});

test('tool errors stay errors even when the AI returns a final answer', () => {
  const f = fixture();
  let rounds = 0;
  f.api.dmvAiComplete_ = () =>
    ++rounds === 1 ? reply('', [call('run_report')]) : reply('Cannot fetch');
  f.api.dmvChatTools_ = () => [
    {
      name: 'run_report',
      run() {
        throw new Error(SECRET);
      },
    },
  ];
  const result = chat(f);
  assert.equal(result.text, 'Cannot fetch');
  const progress = f.progress();
  assert.equal(progress.status, 'failed');
  assert.equal(progress.steps.find((step) => step.text === 'Fetching report data').state, 'error');
  assert.ok(!JSON.stringify(progress).includes(SECRET));
});

test('an AI failure after completed actions preserves completed progress and records the failed call', () => {
  const f = fixture();
  let rounds = 0;
  f.api.dmvAiComplete_ = () => {
    if (++rounds === 1) return reply('', [call('write_to_sheet')]);
    throw new Error(SECRET);
  };
  f.api.dmvChatTools_ = () => [
    {
      name: 'write_to_sheet',
      run(session) {
        session.events.push({ kind: 'write', text: SECRET });
        return { ok: true };
      },
    },
  ];
  const result = chat(f);
  assert.equal(result.failed, true);
  const progress = f.progress();
  assert.equal(progress.status, 'failed');
  assert.equal(progress.steps.find((step) => step.text === 'Writing to Sheets').state, 'complete');
  assert.equal(progress.steps.at(-1).state, 'error');
});

test('actions skipped for a question are never marked as successful executions', () => {
  const f = fixture();
  let writes = 0;
  f.api.dmvAiComplete_ = () => reply('', [call('ask_user'), call('write_to_sheet')]);
  f.api.dmvChatTools_ = () => [
    {
      name: 'ask_user',
      run(session) {
        session.question = { question: SECRET, options: [] };
        return {};
      },
    },
    {
      name: 'write_to_sheet',
      run() {
        writes++;
        return {};
      },
    },
  ];
  chat(f);
  const progress = f.progress();
  assert.equal(writes, 0);
  assert.ok(!progress.steps.some((step) => step.text === 'Writing to Sheets'));
  assert.equal(progress.steps.at(-1).text, 'Action skipped while waiting for your answer');
  assert.equal(progress.steps.at(-1).state, 'error');
});

test('deadline skips and the final-answer fallback have accurate progress', () => {
  const f = fixture();
  let aiCalls = 0,
    writes = 0;
  f.api.dmvAiComplete_ = () => {
    if (++aiCalls === 1) return reply('', [call('run_report'), call('write_to_sheet')]);
    assert.equal(f.progress().steps.at(-1).text, 'Preparing the final answer');
    assert.equal(f.progress().steps.at(-1).state, 'running');
    throw new Error(SECRET);
  };
  f.api.dmvChatTools_ = () => [
    {
      name: 'run_report',
      run() {
        f.advance(201000);
        return {};
      },
    },
    {
      name: 'write_to_sheet',
      run() {
        writes++;
        return {};
      },
    },
  ];
  const result = chat(f);
  assert.match(result.text, /ran out of time/);
  assert.equal(aiCalls, 2);
  assert.equal(writes, 0);
  const progress = f.progress();
  assert.equal(progress.status, 'failed');
  assert.equal(progress.steps.at(-2).text, 'Action skipped because the time limit was reached');
  assert.equal(progress.steps.at(-1).text, 'Preparing the final answer');
  assert.equal(progress.steps.at(-1).state, 'error');
});

test('progress cache failures never fail chat and malformed cached data is not returned', () => {
  const f = fixture();
  f.state.cache.put = () => {
    throw new Error('Cache unavailable');
  };
  f.state.cache.get = () => {
    throw new Error('Cache unavailable');
  };
  assert.equal(chat(f).text, 'Finished');
  assert.equal(f.progress().status, 'unavailable');
  const poisoned = fixture();
  const key = poisoned.api.dmvChatProgressKey_(poisoned.book.getId(), REQUEST);
  poisoned.state.cache.put(
    key,
    JSON.stringify({
      requestId: REQUEST,
      status: 'running',
      updatedAt: poisoned.api.Date.now(),
      steps: [{ id: 1, state: 'running', text: SECRET }],
    })
  );
  assert.equal(poisoned.progress().status, 'unavailable');
});

test('progress retains at most sixty recent steps with increasing IDs', () => {
  const f = fixture();
  let rounds = 0;
  f.api.dmvAiComplete_ = () =>
    ++rounds === 1
      ? reply(
          '',
          Array.from({ length: 70 }, (_, index) => call('summarize', String(index)))
        )
      : reply('Done');
  f.api.dmvChatTools_ = () => [
    {
      name: 'summarize',
      run() {
        return {};
      },
    },
  ];
  chat(f);
  const progress = f.progress();
  assert.equal(progress.status, 'complete');
  assert.equal(progress.steps.length, 60);
  assert.ok(
    progress.steps.every((step, index) => index === 0 || step.id > progress.steps[index - 1].id)
  );
  assert.ok(progress.steps[0].id > 1);
});

test('connected source instructions enter the prompt once and never enter progress snapshots', () => {
  const f = fixture();
  f.api.dmvRegisterConnector_({ id: 'orchard', label: 'Orchard', authFields: [], reports: [] });
  f.api.dmvSaveConnection({ connectorId: 'orchard', label: 'First account', credentials: {} });
  f.api.dmvSaveConnection({ connectorId: 'orchard', label: 'Second account', credentials: {} });
  const globalInstructions = 'PRIVATE_GLOBAL_INSTRUCTIONS';
  const sourceInstructions = 'PRIVATE_ORCHARD_INSTRUCTIONS';
  f.api.dmvAiRead_ = () => ({
    provider: 'test',
    apiKey: SECRET,
    maxRows: 1234,
    instructions: globalInstructions,
    sourceInstructions: {
      orchard: sourceInstructions,
      unavailable: 'PRIVATE_UNCONNECTED_INSTRUCTIONS',
    },
  });
  f.api.dmvAiComplete_ = (_settings, request) => {
    assert.ok(request.system.includes(globalInstructions));
    assert.equal(request.system.split(sourceInstructions).length - 1, 1);
    assert.ok(!request.system.includes('PRIVATE_UNCONNECTED_INSTRUCTIONS'));
    assert.match(request.system, /configured maximum of 1234 rows/);
    return reply('Done');
  };
  chat(f);
  const progress = JSON.stringify(f.progress());
  assert.ok(!progress.includes(globalInstructions));
  assert.ok(!progress.includes(sourceInstructions));
  assert.equal(f.progress().status, 'complete');
});
