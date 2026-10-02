import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatamoovSandbox, plain } from './helpers/datamoov-sandbox.mjs';

// How each provider's reply ending maps to the chat loop's stop, and the provider's own reason
// kept for an ending the loop has no stop for.

const gemini = (f, candidate) => f.api.dmvAiGemini_.parse({ candidates: [candidate] });

test('Gemini tool-call failures stop as tool_error with the reason code alone', () => {
  const f = createDatamoovSandbox();
  const message = 'Malformed function call: print(default_api.edit_sheet(' + 'x'.repeat(5000);
  const parsed = gemini(f, {
    content: { role: 'model', parts: [] },
    finishReason: 'MALFORMED_FUNCTION_CALL',
    finishMessage: message,
  });
  assert.equal(parsed.stop, 'tool_error');
  assert.equal(parsed.text, '');
  assert.deepEqual(plain(parsed.toolCalls), []);
  // The message echoes the call, which can hold sheet content, and the reason goes back to the model.
  assert.equal(parsed.reason, 'MALFORMED_FUNCTION_CALL');
  for (const finishReason of ['UNEXPECTED_TOOL_CALL', 'TOO_MANY_TOOL_CALLS'])
    assert.equal(gemini(f, { content: { parts: [] }, finishReason }).stop, 'tool_error');
  // Without content at all, as Gemini sends a malformed call, and never running a call it holds.
  assert.equal(gemini(f, { finishReason: 'MALFORMED_FUNCTION_CALL' }).reason, 'MALFORMED_FUNCTION_CALL');
  const partial = gemini(f, {
    content: { parts: [{ functionCall: { name: 'run_report', args: {} } }] },
    finishReason: 'MALFORMED_FUNCTION_CALL',
  });
  assert.equal(partial.stop, 'tool_error');
  // A partial call is dropped, so the step shows as failed like a reply with no parts.
  assert.deepEqual(plain(partial.toolCalls), []);
});

test('Gemini endings without a stop of their own keep the reason; the usual ones keep none', () => {
  const f = createDatamoovSandbox();
  const other = gemini(f, { content: { parts: [] }, finishReason: 'OTHER' });
  assert.equal(other.stop, 'end');
  assert.equal(other.reason, 'OTHER');
  const long = gemini(f, { content: { parts: [] }, finishReason: 'OTHER', finishMessage: 'Stopped: ' + 'x'.repeat(5000) });
  // The provider's message stays out: the reason reaches the user's answer and later transcripts.
  assert.equal(long.reason, 'OTHER');
  const thought = gemini(f, {
    content: { parts: [{ text: 'thinking', thought: true }] },
    finishReason: 'STOP',
  });
  assert.equal(thought.stop, 'end');
  assert.equal(thought.text, '');
  assert.equal(thought.reason, '');
  for (const finishReason of ['PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII'])
    assert.equal(gemini(f, { content: { parts: [] }, finishReason }).stop, 'refusal');
});

test('Anthropic and OpenAI keep an unmapped stop reason the same way', () => {
  const f = createDatamoovSandbox();
  const anthropic = f.api.dmvAiAnthropic_.parse({ content: [], stop_reason: 'pause_turn' });
  assert.equal(anthropic.stop, 'end');
  assert.equal(anthropic.reason, 'pause_turn');
  assert.equal(
    f.api.dmvAiAnthropic_.parse({ content: [{ type: 'text', text: 'Hi' }], stop_reason: 'end_turn' }).reason,
    ''
  );
  const openai = f.api.dmvAiOpenAi_.parse({
    choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'function_call' }],
  });
  assert.equal(openai.stop, 'end');
  assert.equal(openai.reason, 'function_call');
  assert.equal(
    f.api.dmvAiOpenAi_.parse({ choices: [{ message: { content: 'Hi' }, finish_reason: 'stop' }] }).reason,
    ''
  );
});

test('a Gemini prompt block is a refusal with an empty reason, as every reply carries', () => {
  const f = createDatamoovSandbox();
  const parsed = f.api.dmvAiGemini_.parse({ promptFeedback: { blockReason: 'SAFETY' } });
  assert.equal(parsed.stop, 'refusal');
  assert.equal(parsed.reason, '');
});

test('Anthropic caches the system prompt up to its last paragraph, which changes per execution', () => {
  const f = createDatamoovSandbox();
  const settings = { model: 'claude-opus-5', apiKey: 'k' };
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }];
  const system = 'RULES\n- one\n\nCATALOG\nx\n\nSPREADSHEET\nTabs: Sales.\nActive tab: "Sales", empty.';
  const body = plain(f.api.dmvAiAnthropic_.build(settings, { system, messages }).body);
  assert.deepEqual(body.system, [
    { type: 'text', text: 'RULES\n- one\n\nCATALOG\nx\n\n', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: 'SPREADSHEET\nTabs: Sales.\nActive tab: "Sales", empty.' },
  ]);
  const single = plain(f.api.dmvAiAnthropic_.build(settings, { system: 'One paragraph.', messages }).body);
  assert.deepEqual(single.system, [{ type: 'text', text: 'One paragraph.', cache_control: { type: 'ephemeral' } }]);
});
