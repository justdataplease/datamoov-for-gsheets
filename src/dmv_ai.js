/* AI provider settings and adapters. The key stays in the user's private properties and is
   only ever sent to the provider the user chose, over the same guarded transport as reports. */
var DMV_AI_PROVIDERS = {
  anthropic: {
    label: 'Anthropic (Claude)',
    host: 'api.anthropic.com',
    defaultModel: 'claude-opus-5',
    keyHelp: 'An Anthropic API key from console.anthropic.com.',
    keyUrl: 'https://console.anthropic.com/settings/keys',
  },
  openai: {
    label: 'OpenAI (ChatGPT)',
    host: 'api.openai.com',
    defaultModel: 'gpt-5.5',
    keyHelp: 'An OpenAI API key from platform.openai.com.',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  gemini: {
    label: 'Google Gemini',
    host: 'generativelanguage.googleapis.com',
    defaultModel: 'gemini-3.8-flash',
    keyHelp: 'A Gemini API key from aistudio.google.com.',
    keyUrl: 'https://aistudio.google.com/apikey',
  },
};
var DMV_AI = {
  maxOutputTokens: 4000,
  maxKeyLength: 400,
  maxModelLength: 80,
  maxInstructionsLength: 4000,
};

function dmvAiCatalog_() {
  return Object.keys(DMV_AI_PROVIDERS).map(function (id) {
    var provider = DMV_AI_PROVIDERS[id];
    return {
      id: id,
      label: provider.label,
      defaultModel: provider.defaultModel,
      keyHelp: provider.keyHelp,
      keyUrl: provider.keyUrl,
    };
  });
}

function dmvAiRead_() {
  var raw = dmvStore_().getProperty(dmvKey_('ai', 'settings'));
  if (!raw) return null;
  var settings = JSON.parse(raw);
  if (!DMV_AI_PROVIDERS[settings.provider] || !settings.apiKey) return null;
  return settings;
}

function dmvAiSummary_(settings) {
  if (!settings) return { configured: false, providers: dmvAiCatalog_() };
  return {
    configured: true,
    provider: settings.provider,
    providerLabel: DMV_AI_PROVIDERS[settings.provider].label,
    model: settings.model,
    instructions: settings.instructions || '',
    providers: dmvAiCatalog_(),
  };
}

function dmvAiSettings() {
  return dmvAiSummary_(dmvAiRead_());
}

function dmvSaveAiSettings(input) {
  return dmvLocked_(function () {
    input = input || {};
    var provider = DMV_AI_PROVIDERS[input.provider];
    if (!provider) throw new Error('Choose a supported AI provider.');
    var previous = dmvAiRead_();
    var model = dmvText_(
      input.model || provider.defaultModel,
      'Model',
      DMV_AI.maxModelLength,
      true
    );
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(model))
      throw new Error('Enter a model name using letters, digits, dots, dashes or colons.');
    var apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
    if (!apiKey && previous && previous.provider === input.provider) apiKey = previous.apiKey;
    if (!apiKey) throw new Error('Paste the API key for ' + provider.label + '.');
    if (apiKey.length > DMV_AI.maxKeyLength || /[\s\u0000-\u001f\u007f]/.test(apiKey))
      throw new Error('The API key contains unsupported characters.');
    var instructions = dmvText_(
      input.instructions,
      'Instructions',
      DMV_AI.maxInstructionsLength
    ).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
    var settings = {
      id: 'settings',
      provider: input.provider,
      model: model,
      apiKey: apiKey,
      instructions: instructions,
      revision: previous ? (previous.revision || 0) + 1 : 1,
    };
    dmvSave_('ai', settings);
    return dmvAiSummary_(settings);
  });
}

function dmvDeleteAiSettings() {
  return dmvLocked_(function () {
    dmvStore_().deleteProperty(dmvKey_('ai', 'settings'));
    return dmvAiSummary_(null);
  });
}

function dmvTestAi() {
  var settings = dmvAiRead_();
  if (!settings) throw new Error('Save an AI provider and API key first.');
  try {
    var reply = dmvAiComplete_(
      settings,
      {
        system: 'You are a connectivity check. Reply with the single word OK.',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with OK.' }] }],
        tools: [],
        maxTokens: 64,
      },
      Date.now() + 60000
    );
    return {
      ok: true,
      message:
        DMV_AI_PROVIDERS[settings.provider].label +
        ' · ' +
        settings.model +
        ' replied: ' +
        String(reply.text || '(no text)').slice(0, 80),
    };
  } catch (error) {
    throw new Error(dmvSafeError_(error, { apiKey: settings.apiKey }));
  }
}

// One request to the configured provider. `request` is provider-neutral:
// { system, messages: [{ role, content: [text | tool_use | tool_result], raw? }], tools, maxTokens }
// The reply is { text, toolCalls: [{ id, name, input }], stop, raw } where `raw` is the provider's
// own assistant content, replayed unchanged when the same turn continues after tool results.
function dmvAiComplete_(settings, request, deadline) {
  var provider = DMV_AI_PROVIDERS[settings.provider];
  if (!provider) throw new Error('Choose a supported AI provider.');
  var adapter = { anthropic: dmvAiAnthropic_, openai: dmvAiOpenAi_, gemini: dmvAiGemini_ }[
    settings.provider
  ];
  var built = adapter.build(settings, request);
  var response = dmvHttp_(
    {
      url: built.url,
      method: 'post',
      headers: built.headers,
      body: built.body,
      retrySafe: true,
    },
    [provider.host],
    deadline,
    adapter.errorMessage
  );
  return adapter.parse(response);
}

function dmvAiToolCall_(id, name, input) {
  if (typeof name !== 'string' || !/^[a-z_]{1,40}$/.test(name))
    throw new Error('The AI provider returned an invalid tool call.');
  return {
    id: String(id || Utilities.getUuid()),
    name: name,
    input: input && typeof input === 'object' && !Array.isArray(input) ? input : {},
  };
}

function dmvAiProviderError_(label) {
  return function (code, body) {
    var message =
      body && body.error && typeof body.error.message === 'string'
        ? body.error.message
        : body && typeof body.message === 'string'
          ? body.message
          : '';
    if (!message) return '';
    return label + ' rejected the request (HTTP ' + code + '): ' + message.slice(0, 300);
  };
}

var dmvAiAnthropic_ = {
  build: function (settings, request) {
    var messages = request.messages.map(function (message) {
      if (message.role === 'assistant' && message.raw)
        return { role: 'assistant', content: message.raw };
      return {
        role: message.role,
        content: message.content.map(function (block) {
          if (block.type === 'text') return { type: 'text', text: block.text };
          if (block.type === 'tool_use')
            return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
          var result = { type: 'tool_result', tool_use_id: block.id, content: block.content };
          if (block.isError) result.is_error = true;
          return result;
        }),
      };
    });
    var body = {
      model: settings.model,
      max_tokens: request.maxTokens || DMV_AI.maxOutputTokens,
      system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
      messages: messages,
    };
    if (request.tools && request.tools.length)
      body.tools = request.tools.map(function (tool) {
        return { name: tool.name, description: tool.description, input_schema: tool.input_schema };
      });
    return {
      url: 'https://api.anthropic.com/v1/messages',
      headers: { 'x-api-key': settings.apiKey, 'anthropic-version': '2023-06-01' },
      body: body,
    };
  },
  parse: function (response) {
    if (!response || !Array.isArray(response.content))
      throw new Error('Anthropic returned an unreadable reply.');
    var text = [],
      toolCalls = [];
    response.content.forEach(function (block) {
      if (block.type === 'text' && typeof block.text === 'string') text.push(block.text);
      if (block.type === 'tool_use')
        toolCalls.push(dmvAiToolCall_(block.id, block.name, block.input));
    });
    var stop = { end_turn: 'end', tool_use: 'tool', max_tokens: 'length', refusal: 'refusal' }[
      response.stop_reason
    ];
    return {
      text: text.join('\n'),
      toolCalls: toolCalls,
      stop: stop || 'end',
      raw: response.content,
    };
  },
  errorMessage: dmvAiProviderError_('Anthropic'),
};

var dmvAiOpenAi_ = {
  build: function (settings, request) {
    var messages = [{ role: 'system', content: request.system }];
    request.messages.forEach(function (message) {
      if (message.role === 'assistant') {
        if (message.raw) {
          messages.push(message.raw);
          return;
        }
        var texts = [],
          calls = [];
        message.content.forEach(function (block) {
          if (block.type === 'text') texts.push(block.text);
          if (block.type === 'tool_use')
            calls.push({
              id: block.id,
              type: 'function',
              function: { name: block.name, arguments: JSON.stringify(block.input) },
            });
        });
        var assistant = { role: 'assistant', content: texts.join('\n') || null };
        if (calls.length) assistant.tool_calls = calls;
        messages.push(assistant);
        return;
      }
      var userText = [];
      message.content.forEach(function (block) {
        if (block.type === 'text') userText.push(block.text);
        if (block.type === 'tool_result')
          messages.push({ role: 'tool', tool_call_id: block.id, content: block.content });
      });
      if (userText.length) messages.push({ role: 'user', content: userText.join('\n') });
    });
    var body = {
      model: settings.model,
      max_completion_tokens: request.maxTokens || DMV_AI.maxOutputTokens,
      messages: messages,
    };
    if (request.tools && request.tools.length)
      body.tools = request.tools.map(function (tool) {
        return {
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.input_schema,
          },
        };
      });
    return {
      url: 'https://api.openai.com/v1/chat/completions',
      headers: { Authorization: 'Bearer ' + settings.apiKey },
      body: body,
    };
  },
  parse: function (response) {
    var choice = response && Array.isArray(response.choices) ? response.choices[0] : null;
    if (!choice || !choice.message) throw new Error('OpenAI returned an unreadable reply.');
    var toolCalls = (choice.message.tool_calls || []).map(function (call) {
      var input;
      try {
        input = JSON.parse((call.function && call.function.arguments) || '{}');
      } catch (error) {
        throw new Error('OpenAI returned tool arguments that are not valid JSON.');
      }
      return dmvAiToolCall_(call.id, call.function && call.function.name, input);
    });
    var stop = { stop: 'end', tool_calls: 'tool', length: 'length', content_filter: 'refusal' }[
      choice.finish_reason
    ];
    return {
      text: typeof choice.message.content === 'string' ? choice.message.content : '',
      toolCalls: toolCalls,
      stop: stop || 'end',
      raw: choice.message,
    };
  },
  errorMessage: dmvAiProviderError_('OpenAI'),
};

var dmvAiGemini_ = {
  build: function (settings, request) {
    var contents = request.messages.map(function (message) {
      if (message.role === 'assistant' && message.raw) return { role: 'model', parts: message.raw };
      return {
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: message.content.map(function (block) {
          if (block.type === 'text') return { text: block.text };
          if (block.type === 'tool_use')
            return { functionCall: { name: block.name, args: block.input } };
          return { functionResponse: { name: block.name, response: { result: block.content } } };
        }),
      };
    });
    var body = {
      systemInstruction: { parts: [{ text: request.system }] },
      contents: contents,
      generationConfig: { maxOutputTokens: request.maxTokens || DMV_AI.maxOutputTokens },
    };
    if (request.tools && request.tools.length)
      body.tools = [
        {
          functionDeclarations: request.tools.map(function (tool) {
            return {
              name: tool.name,
              description: tool.description,
              parameters: tool.input_schema,
            };
          }),
        },
      ];
    return {
      url:
        'https://generativelanguage.googleapis.com/v1beta/models/' +
        encodeURIComponent(settings.model) +
        ':generateContent',
      headers: { 'x-goog-api-key': settings.apiKey },
      body: body,
    };
  },
  parse: function (response) {
    var candidate = response && Array.isArray(response.candidates) ? response.candidates[0] : null;
    if (!candidate) {
      if (response && response.promptFeedback && response.promptFeedback.blockReason)
        return { text: '', toolCalls: [], stop: 'refusal', raw: [] };
      throw new Error('Gemini returned an unreadable reply.');
    }
    var parts = (candidate.content && candidate.content.parts) || [];
    var text = [],
      toolCalls = [];
    parts.forEach(function (part, index) {
      if (typeof part.text === 'string' && !part.thought) text.push(part.text);
      if (part.functionCall)
        toolCalls.push(
          dmvAiToolCall_(
            'gemini-' + index + '-' + Utilities.getUuid().slice(0, 8),
            part.functionCall.name,
            part.functionCall.args
          )
        );
    });
    var stop = toolCalls.length
      ? 'tool'
      : { STOP: 'end', MAX_TOKENS: 'length', SAFETY: 'refusal', RECITATION: 'refusal' }[
          candidate.finishReason
        ];
    // Parts are replayed as-is so thought signatures on function calls survive the tool round.
    return { text: text.join('\n'), toolCalls: toolCalls, stop: stop || 'end', raw: parts };
  },
  errorMessage: dmvAiProviderError_('Gemini'),
};
