import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatamoovSandbox, plain } from './helpers/datamoov-sandbox.mjs';

const SAVED_KEY = 'sk-ant-saved-private-key-0001';
const TYPED_KEY = 'sk-typed-private-key-0002';
const HOSTS = {
  anthropic: 'api.anthropic.com',
  openai: 'api.openai.com',
  gemini: 'generativelanguage.googleapis.com',
};

function fixture() {
  const f = createDatamoovSandbox();
  f.api.dmvSaveAiSettings({ provider: 'anthropic', apiKey: SAVED_KEY });
  return f;
}
const savedProperties = (f) => JSON.stringify(plain(f.state.user.getProperties()));
const okReply = { content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' };

// Every request goes to the chosen provider's host, with the key in a header and never in the URL.
function assertProviderOnly(f, provider, key) {
  assert.ok(f.state.http.length > 0);
  for (const call of f.state.http) {
    assert.equal(new URL(call.url).host, HOSTS[provider], call.url);
    assert.ok(!call.url.includes(key), 'the key is not in the URL');
    assert.ok(JSON.stringify(call.options.headers).includes(key), 'the key travels in a header');
  }
}

test('Test checks the typed model exists, proves it answers and saves nothing', () => {
  const f = fixture();
  const before = savedProperties(f);
  f.state.responses.push(
    { body: { type: 'model', id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' } },
    { body: okReply }
  );
  const result = plain(f.api.dmvTestAi({ provider: 'anthropic', apiKey: '', model: 'claude-sonnet-5' }));
  assert.deepEqual(result, {
    ok: true,
    exists: true,
    model: 'claude-sonnet-5',
    displayName: 'Claude Sonnet 5',
    message: 'Anthropic (Claude) · claude-sonnet-5 is available and replied: OK',
  });
  const [info, completion] = f.state.http;
  assert.equal(info.url, 'https://api.anthropic.com/v1/models/claude-sonnet-5');
  assert.equal(info.options.method, 'get');
  assert.equal(info.options.payload, undefined);
  // A blank key field reuses the saved key, because the provider is the saved one.
  assert.deepEqual(plain(info.options.headers), {
    'x-api-key': SAVED_KEY,
    'anthropic-version': '2023-06-01',
  });
  assert.equal(completion.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(JSON.parse(completion.options.payload).model, 'claude-sonnet-5');
  assert.equal(JSON.parse(completion.options.payload).max_tokens, 64);
  assertProviderOnly(f, 'anthropic', SAVED_KEY);
  assert.equal(savedProperties(f), before);
  assert.equal(f.api.dmvAiSettings().model, 'claude-opus-5');
});

test('an unsaved provider, model and key are tested on that provider only, and a blank model means its default', () => {
  const f = fixture();
  const before = savedProperties(f);
  f.state.responses.push(
    { body: { name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash' } },
    { body: { candidates: [{ content: { parts: [{ text: 'OK' }] }, finishReason: 'STOP' }] } }
  );
  const result = f.api.dmvTestAi({ provider: 'gemini', apiKey: ` ${TYPED_KEY} `, model: '' });
  assert.equal(result.ok, true);
  assert.equal(result.model, 'gemini-3.8-flash');
  assert.equal(result.displayName, 'Gemini 3.8 Flash');
  assert.equal(
    f.state.http[0].url,
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash'
  );
  assert.equal(f.state.http[0].options.headers['x-goog-api-key'], TYPED_KEY);
  assert.match(f.state.http[1].url, /models\/gemini-3\.8-flash:generateContent$/);
  assertProviderOnly(f, 'gemini', TYPED_KEY);
  assert.ok(!JSON.stringify(plain(f.state.http)).includes(SAVED_KEY));
  assert.equal(savedProperties(f), before);
  assert.equal(f.api.dmvAiSettings().provider, 'anthropic');
});

test('a blank key never borrows the saved key of another provider, and the model rule matches Save', () => {
  const f = fixture();
  assert.throws(
    () => f.api.dmvTestAi({ provider: 'openai', apiKey: '', model: 'gpt-5.5' }),
    /Paste the API key for OpenAI \(ChatGPT\)\./
  );
  assert.throws(
    () => f.api.dmvTestAi({ provider: 'openai', apiKey: TYPED_KEY, model: 'bad model!' }),
    /model name/
  );
  assert.throws(
    () => f.api.dmvTestAi({ provider: 'openai', apiKey: TYPED_KEY, model: 'x'.repeat(81) }),
    /Model is too long/
  );
  assert.throws(() => f.api.dmvTestAi({ provider: 'mystery', apiKey: TYPED_KEY }), /supported AI provider/);
  assert.throws(() => f.api.dmvTestAi({ provider: 'openai', apiKey: 'has space' }), /unsupported characters/);
  assert.equal(f.state.http.length, 0);
  const empty = createDatamoovSandbox();
  assert.throws(() => empty.api.dmvTestAi(), /Save an AI provider and API key first/);
  assert.throws(
    () => empty.api.dmvTestAi({ provider: 'anthropic', apiKey: '' }),
    /Paste the API key for Anthropic/
  );
});

test('an unknown model returns ranked, limited suggestions from the provider list instead of throwing', () => {
  const f = fixture();
  const before = savedProperties(f);
  const listed = [
    'o3',
    'gpt-4o-mini',
    'gpt-5.5-nano',
    'gpt-4.1',
    'text-embedding-3-small',
    'gpt-5.5',
    'chatgpt-4o-latest',
    'gpt-image-1',
    'gpt-5.5-mini',
    'whisper-1',
    'gpt-4o',
    'gpt-5.5-pro',
    'bad model!',
  ];
  f.state.responses.push(
    {
      code: 404,
      body: {
        error: {
          message: "The model 'gpt-5.5-turbo' does not exist or you do not have access to it.",
          code: 'model_not_found',
        },
      },
    },
    { body: { object: 'list', data: listed.map((id) => ({ id, object: 'model' })) } }
  );
  const result = plain(f.api.dmvTestAi({ provider: 'openai', apiKey: TYPED_KEY, model: 'gpt-5.5-turbo' }));
  assert.equal(result.ok, false);
  assert.equal(result.exists, false);
  assert.equal(result.model, 'gpt-5.5-turbo');
  // The same family first, then other GPT models; embedding and image models are not offered.
  assert.deepEqual(result.suggestions, [
    'gpt-5.5-pro',
    'gpt-5.5-mini',
    'gpt-5.5-nano',
    'gpt-5.5',
    'gpt-4o',
    'gpt-4.1',
  ]);
  assert.equal(
    result.message,
    'Model "gpt-5.5-turbo" was not found for OpenAI (ChatGPT). Similar models: ' +
      result.suggestions.join(', ') +
      '.'
  );
  assert.deepEqual(
    f.state.http.map((call) => call.url),
    ['https://api.openai.com/v1/models/gpt-5.5-turbo', 'https://api.openai.com/v1/models']
  );
  assert.equal(f.state.http[0].options.headers.Authorization, 'Bearer ' + TYPED_KEY);
  assertProviderOnly(f, 'openai', TYPED_KEY);
  assert.ok(!JSON.stringify(result).includes(TYPED_KEY));
  assert.equal(savedProperties(f), before);
});

test('Gemini suggestions come from generateContent models, and the default is offered when nothing is similar', () => {
  const f = fixture();
  const models = {
    models: [
      { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent', 'countTokens'] },
      { name: 'models/gemini-3.8-pro', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
    ],
  };
  const missing = { code: 404, body: { error: { code: 404, message: 'models/x is not found', status: 'NOT_FOUND' } } };
  f.state.responses.push(missing, { body: models });
  const similar = f.api.dmvTestAi({ provider: 'gemini', apiKey: TYPED_KEY, model: 'gemini-9-ultra' });
  assert.deepEqual(plain(similar.suggestions), ['gemini-3.8-pro', 'gemini-3.8-flash']);
  assert.equal(
    f.state.http[1].url,
    'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000'
  );
  f.state.responses.push(missing, { body: models });
  const unrelated = f.api.dmvTestAi({ provider: 'gemini', apiKey: TYPED_KEY, model: 'xyz' });
  assert.deepEqual(plain(unrelated.suggestions), ['gemini-3.8-flash']);
  assertProviderOnly(f, 'gemini', TYPED_KEY);
});

test('a missing model is still reported when the list fails or the 404 body is not JSON', () => {
  const f = fixture();
  f.state.responses.push(
    { code: 404, body: '<html>Not found</html>' },
    { code: 403, body: { error: { message: 'Listing is not allowed for this key.' } } }
  );
  const result = plain(f.api.dmvTestAi({ provider: 'anthropic', apiKey: '', model: 'claude-mystery' }));
  assert.deepEqual(result, {
    ok: false,
    exists: false,
    model: 'claude-mystery',
    suggestions: [],
    message: 'Model "claude-mystery" was not found for Anthropic (Claude).',
  });
  assert.equal(f.state.http[1].url, 'https://api.anthropic.com/v1/models?limit=100');
  assert.equal(f.state.http.length, 2);
});

test('a rejected key and a failing test request throw redacted messages', () => {
  const f = fixture();
  const rejected = {
    code: 401,
    body: { error: { message: 'Incorrect API key provided: ' + TYPED_KEY, code: 'invalid_api_key' } },
  };
  f.state.responses.push(rejected, rejected);
  assert.throws(
    () => f.api.dmvTestAi({ provider: 'openai', apiKey: TYPED_KEY, model: 'gpt-5.5' }),
    (error) =>
      /^OpenAI \(ChatGPT\) rejected the API key \(HTTP 401\): Incorrect API key provided: \[redacted\]$/.test(
        error.message
      ) && !error.message.includes(TYPED_KEY)
  );
  assert.equal(f.state.http.length, 2, 'the test request confirms a key the model lookup refused');
  f.state.responses.push({ code: 403, body: '' }, { code: 403, body: '' });
  assert.throws(
    () => f.api.dmvTestAi({ provider: 'anthropic', apiKey: '', model: 'claude-opus-5' }),
    /Anthropic \(Claude\) rejected the API key \(HTTP 403\)\. Check the key and its permissions\.$/
  );
  f.state.responses.push(
    { body: { type: 'model', id: 'claude-opus-5' } },
    {
      code: 400,
      body: { error: { type: 'invalid_request_error', message: 'Credit balance too low for ' + SAVED_KEY } },
    }
  );
  assert.throws(
    () => f.api.dmvTestAi(),
    (error) =>
      error.message.startsWith(
        'Anthropic (Claude) · claude-opus-5 exists, but the test request failed: Anthropic rejected the request (HTTP 400): Credit balance too low'
      ) && !error.message.includes(SAVED_KEY)
  );
  f.state.responses.push({ code: 400, body: { error: { message: 'API key not valid. Please pass a valid API key.' } } });
  assert.throws(
    () => f.api.dmvTestAi({ provider: 'gemini', apiKey: TYPED_KEY }),
    /Gemini rejected the request \(HTTP 400\): API key not valid/
  );
});

test('a key that may run chat but not read model details passes the test', () => {
  const f = fixture();
  // An OpenAI key restricted to model capabilities: the models endpoint refuses it, chat does not.
  f.state.responses.push(
    {
      code: 401,
      body: { error: { message: 'You have insufficient permissions for this operation. Missing scopes: api.model.read.' } },
    },
    { body: { choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] } }
  );
  const result = plain(f.api.dmvTestAi({ provider: 'openai', apiKey: TYPED_KEY, model: 'gpt-5.5' }));
  assert.deepEqual(result, {
    ok: true,
    exists: true,
    model: 'gpt-5.5',
    message: 'OpenAI (ChatGPT) · gpt-5.5 is available and replied: OK',
  });
  assert.deepEqual(f.state.http.map((call) => new URL(call.url).pathname), ['/v1/models/gpt-5.5', '/v1/chat/completions']);
  assertProviderOnly(f, 'openai', TYPED_KEY);
  // A test request that fails for another reason does not claim the model exists.
  f.state.responses.push(
    { code: 403, body: { error: { message: 'Missing scopes: api.model.read.' } } },
    { code: 400, body: { error: { message: 'Unsupported parameter.' } } }
  );
  assert.throws(
    () => f.api.dmvTestAi({ provider: 'openai', apiKey: TYPED_KEY, model: 'gpt-5.5' }),
    (error) =>
      /^OpenAI \(ChatGPT\) · gpt-5\.5: the test request failed: .*HTTP 400.*Unsupported parameter/.test(
        error.message
      )
  );
});

test('model names are URL-encoded on the provider path', () => {
  const f = fixture();
  f.state.responses.push({ body: { id: 'ft:gpt-5.5:acme::abc123' } }, {
    body: { choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] },
  });
  const result = f.api.dmvTestAi({ provider: 'openai', apiKey: TYPED_KEY, model: 'ft:gpt-5.5:acme::abc123' });
  assert.equal(result.ok, true);
  assert.equal(result.displayName, undefined);
  assert.equal(f.state.http[0].url, 'https://api.openai.com/v1/models/ft%3Agpt-5.5%3Aacme%3A%3Aabc123');
  assert.equal(JSON.parse(f.state.http[1].options.payload).model, 'ft:gpt-5.5:acme::abc123');
  assertProviderOnly(f, 'openai', TYPED_KEY);
});
