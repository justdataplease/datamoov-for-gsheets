import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatamoovSandbox, plain } from './helpers/datamoov-sandbox.mjs';

const request = () => ({
  system: 'Answer from the available report results.',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Compare the two weeks.' }] }],
  tools: [],
});
const settings = (model = 'gemini-3.8-flash') => ({
  provider: 'gemini',
  model,
  apiKey: 'private-gemini-fixture-key',
});

test('the verified Gemini default leaves room for thinking and the visible answer', () => {
  const f = createDatamoovSandbox();
  const built = f.api.dmvAiGemini_.build(settings(), request());
  assert.deepEqual(plain(built.body.generationConfig), {
    maxOutputTokens: 16384,
    thinkingConfig: { thinkingLevel: 'LOW' },
  });
  assert.equal(built.headers['x-goog-api-key'], settings().apiKey);
  assert.ok(!JSON.stringify(built.body).includes(settings().apiKey));
  assert.equal(f.api.DMV_AI.maxOutputTokens, 4000);
  for (const adapter of [f.api.dmvAiAnthropic_, f.api.dmvAiOpenAi_]) {
    const body = adapter.build(settings(), request()).body;
    assert.equal(body.max_tokens || body.max_completion_tokens, 4000);
  }
});

test('custom and older Gemini models keep compatible generation defaults', () => {
  const f = createDatamoovSandbox();
  for (const model of [
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-3.1-pro',
    'gemini-3.8-flash-preview',
    'gemini-3.8-flash-custom',
    'custom-model',
  ]) {
    const built = f.api.dmvAiGemini_.build(settings(model), request());
    assert.deepEqual(plain(built.body.generationConfig), { maxOutputTokens: 4000 }, model);
    const explicit = f.api.dmvAiGemini_.build(settings(model), { ...request(), maxTokens: 64 });
    assert.deepEqual(plain(explicit.body.generationConfig), { maxOutputTokens: 64 }, model);
  }
});

test('explicit Gemini limits, including the small connectivity check, remain authoritative', () => {
  const f = createDatamoovSandbox();
  for (const maxTokens of [64, 8000, 24000]) {
    const built = f.api.dmvAiGemini_.build(settings(), { ...request(), maxTokens });
    assert.equal(built.body.generationConfig.maxOutputTokens, maxTokens);
    assert.deepEqual(plain(built.body.generationConfig.thinkingConfig), { thinkingLevel: 'LOW' });
  }
  f.api.dmvSaveAiSettings(settings());
  f.state.responses.push({
    body: { candidates: [{ content: { parts: [{ text: 'OK' }] }, finishReason: 'STOP' }] },
  });
  assert.match(f.api.dmvTestAi().message, /gemini-3.8-flash replied: OK/);
  const body = JSON.parse(f.state.http[0].options.payload);
  assert.equal(body.generationConfig.maxOutputTokens, 64);
  assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, 'LOW');
  assert.equal(body.tools, undefined);
});

test('the budget adjustment preserves complete JSON tool schemas', () => {
  const f = createDatamoovSandbox();
  const schema = {
    type: 'object',
    properties: {
      sources: {
        type: 'array',
        items: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
          additionalProperties: false,
        },
      },
    },
    required: ['sources'],
    additionalProperties: false,
  };
  const built = f.api.dmvAiGemini_.build(settings(), {
    ...request(),
    tools: [{ name: 'save_dashboard', description: 'Save the dashboard.', input_schema: schema }],
  });
  const declaration = built.body.tools[0].functionDeclarations[0];
  assert.deepEqual(plain(declaration.parametersJsonSchema), schema);
  assert.equal(declaration.parameters, undefined);
  assert.equal(declaration.name, 'save_dashboard');
});

test('Gemini cutoff status takes precedence over function calls in an incomplete response', () => {
  const f = createDatamoovSandbox();
  const parts = [{ functionCall: { name: 'run_report', args: { connectionId: 'fixture' } } }];
  const cutoff = f.api.dmvAiGemini_.parse({
    candidates: [{ content: { parts }, finishReason: 'MAX_TOKENS' }],
  });
  assert.equal(cutoff.stop, 'length');
  assert.equal(cutoff.toolCalls.length, 1);
  assert.deepEqual(plain(cutoff.raw), parts);
  const complete = f.api.dmvAiGemini_.parse({
    candidates: [{ content: { parts }, finishReason: 'STOP' }],
  });
  assert.equal(complete.stop, 'tool');
});
