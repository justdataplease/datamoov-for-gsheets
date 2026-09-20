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
  maxInstructionsLength: 100000,
  instructionPartBytes: 7500,
  maxInstructionEncodedBytes: 400000,
  maxPrivateBytes: 450000,
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
  var all = dmvStore_().getProperties();
  var raw = all[dmvKey_('ai', 'settings')];
  if (!raw) return null;
  var settings = JSON.parse(raw);
  if (!DMV_AI_PROVIDERS[settings.provider] || !settings.apiKey) return null;
  if (settings.instructionRef) {
    var savedInstructions = dmvAiReadInstructions_(settings.instructionRef, all);
    settings.instructions = savedInstructions.instructions;
    settings.sourceInstructions = savedInstructions.sourceInstructions;
    settings.connectionInstructions = savedInstructions.connectionInstructions;
  }
  settings.sourceInstructions = settings.sourceInstructions || {};
  // Deleted connections no longer use instructions. Ignore their pieces when reading;
  // the next successful settings save removes them from the private instruction document.
  var overrides = settings.connectionInstructions || {};
  settings.connectionInstructions = Object.create(null);
  Object.keys(overrides).forEach(function (id) {
    if (all[dmvKey_('connection', id)]) settings.connectionInstructions[id] = overrides[id];
  });
  return settings;
}

function dmvAiInstructionInput_(instructions, sourceInstructions, connectionInstructions) {
  if (typeof instructions !== 'string') throw new Error('Chat instructions must be text.');
  if (
    !sourceInstructions ||
    Object.prototype.toString.call(sourceInstructions) !== '[object Object]'
  )
    throw new Error('Source instructions must be an object.');
  var catalog = dmvCatalog_();
  var total = instructions.length;
  var sources = {};
  Object.keys(sourceInstructions).forEach(function (id) {
    if (
      !catalog.some(function (connector) {
        return connector.id === id;
      })
    )
      throw new Error('Choose an available source for its chat instructions.');
    var text = sourceInstructions[id];
    if (typeof text !== 'string') throw new Error('Source instructions must be text.');
    total += text.length;
    text = text.trim().replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
    if (text) sources[id] = text;
  });
  connectionInstructions = connectionInstructions === undefined ? {} : connectionInstructions;
  if (
    !connectionInstructions ||
    Object.prototype.toString.call(connectionInstructions) !== '[object Object]'
  )
    throw new Error('Connection instructions must be an object.');
  var connections = Object.create(null);
  Object.keys(connectionInstructions).forEach(function (id) {
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(id))
      throw new Error('Choose a valid connection for its chat instructions.');
    var text = connectionInstructions[id];
    if (typeof text !== 'string') throw new Error('Connection instructions must be text.');
    total += text.length;
    // An empty override intentionally suppresses a legacy source default.
    connections[id] = text.trim().replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  });
  if (total > DMV_AI.maxInstructionsLength)
    throw new Error(
      'Chat instructions are too long. General, source and connection instructions together may contain at most 100,000 characters.'
    );
  return {
    instructions: instructions
      .trim()
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ''),
    sourceInstructions: sources,
    connectionInstructions: connections,
  };
}

function dmvAiInstructionCharacters_(settings) {
  if (!settings) return 0;
  return [settings.sourceInstructions || {}, settings.connectionInstructions || {}].reduce(
    function (total, instructions) {
      return Object.keys(instructions).reduce(function (count, id) {
        return count + instructions[id].length;
      }, total);
    },
    (settings.instructions || '').length
  );
}

// Overrides apply to one private connection; legacy source instructions remain defaults.
function dmvAiConnectionInstructions_(settings, connection) {
  var overrides = (settings && settings.connectionInstructions) || {};
  if (Object.prototype.hasOwnProperty.call(overrides, connection.id))
    return overrides[connection.id];
  return ((settings && settings.sourceInstructions) || {})[connection.connectorId] || '';
}

function dmvAiInstructionPrefix_(generation) {
  return 'dmv:v1:ai-instructions:' + (generation ? generation + ':' : '');
}

function dmvAiReadInstructions_(ref, all) {
  try {
    if (
      !ref ||
      !/^[a-zA-Z0-9-]{1,80}$/.test(ref.generation) ||
      !Number.isInteger(ref.parts) ||
      ref.parts < 1 ||
      ref.parts > Math.ceil(DMV_AI.maxInstructionEncodedBytes / DMV_AI.instructionPartBytes)
    )
      throw new Error('Invalid reference');
    var encoded = '';
    for (var i = 0; i < ref.parts; i++) {
      var part = all[dmvAiInstructionPrefix_(ref.generation) + i];
      if (typeof part !== 'string') throw new Error('Missing part');
      encoded += part;
    }
    if (
      encoded.length > DMV_AI.maxInstructionEncodedBytes ||
      dmvOutputDigest_(encoded) !== ref.digest
    )
      throw new Error('Invalid instructions');
    var payload = JSON.parse(
      Utilities.ungzip(
        Utilities.newBlob(
          Utilities.base64Decode(encoded),
          'application/x-gzip',
          'chat-instructions.json.gz'
        )
      ).getDataAsString('UTF-8')
    );
    return dmvAiInstructionInput_(
      payload.instructions,
      payload.sourceInstructions,
      payload.connectionInstructions
    );
  } catch (ignored) {
    throw new Error(
      'Saved chat instructions are missing or damaged. Restore the private settings before using chat.'
    );
  }
}

function dmvAiClearInstructionParts_(keep) {
  var store = dmvStore_(),
    prefix = dmvAiInstructionPrefix_();
  var kept = keep ? dmvAiInstructionPrefix_(keep) : null;
  Object.keys(store.getProperties()).forEach(function (key) {
    if (key.indexOf(prefix) === 0 && (!kept || key.indexOf(kept) !== 0)) store.deleteProperty(key);
  });
}

// Publish the settings pointer only after all private pieces exist. A failed save keeps the old settings.
function dmvAiWriteSettings_(settings) {
  var store = dmvStore_();
  var oldRaw = store.getProperty(dmvKey_('ai', 'settings'));
  var old = oldRaw ? JSON.parse(oldRaw) : null;
  dmvAiClearInstructionParts_(old && old.instructionRef && old.instructionRef.generation);
  var encoded = Utilities.base64Encode(
    Utilities.gzip(
      Utilities.newBlob(
        JSON.stringify({
          instructions: settings.instructions,
          sourceInstructions: settings.sourceInstructions,
          connectionInstructions: settings.connectionInstructions || {},
        })
      )
    ).getBytes()
  );
  if (encoded.length > DMV_AI.maxInstructionEncodedBytes)
    throw new Error(
      'Chat instructions are too large for private storage. Shorten them and save again.'
    );
  var generation = dmvId_(),
    prefix = dmvAiInstructionPrefix_(generation);
  var parts = Math.ceil(encoded.length / DMV_AI.instructionPartBytes);
  var stored = Object.assign({}, settings, {
    instructionRef: { generation: generation, parts: parts, digest: dmvOutputDigest_(encoded) },
  });
  delete stored.instructions;
  delete stored.sourceInstructions;
  delete stored.connectionInstructions;
  if (old && old.instructionRef && old.instructionRef.digest === stored.instructionRef.digest) {
    stored.instructionRef = old.instructionRef;
    dmvSave_('ai', stored);
    return;
  }
  var raw = dmvCheckRecordSize_(stored),
    all = store.getProperties();
  var used = Object.keys(all).reduce(function (bytes, key) {
    return bytes + Utilities.newBlob(key + all[key]).getBytes().length;
  }, 0);
  if (
    used + encoded.length + parts * (prefix.length + 4) + Utilities.newBlob(raw).getBytes().length >
    DMV_AI.maxPrivateBytes
  )
    throw new Error(
      'Private settings storage is full. Shorten chat instructions or finish paused reports, then save again. Your previous settings are unchanged.'
    );
  try {
    for (var i = 0; i < parts; i++)
      store.setProperty(
        prefix + i,
        encoded.slice(i * DMV_AI.instructionPartBytes, (i + 1) * DMV_AI.instructionPartBytes)
      );
    // Verify the persisted pieces through the actual reader before making them active.
    // A storage or decompression failure leaves the previous settings pointer intact.
    dmvAiReadInstructions_(stored.instructionRef, store.getProperties());
    store.setProperty(dmvKey_('ai', 'settings'), raw);
  } catch (error) {
    // An interrupted save may leave unreferenced pieces; the next save removes them.
    throw new Error(
      'Could not save chat settings. Reopen Settings to check the saved version and try again.'
    );
  }
  try {
    dmvAiClearInstructionParts_(generation);
  } catch (ignored) {
    /* Cleanup cannot undo a committed save. */
  }
}

function dmvAiMaxRows_(settings) {
  return settings &&
    Number.isInteger(settings.maxRows) &&
    settings.maxRows >= 1 &&
    settings.maxRows <= DMV_LIMITS.maxRows
    ? settings.maxRows
    : DMV_LIMITS.defaultRows;
}

function dmvAiSummary_(settings) {
  if (!settings)
    return {
      configured: false,
      debug: true,
      instructionCharacters: 0,
      maxInstructionCharacters: DMV_AI.maxInstructionsLength,
      maxRows: DMV_LIMITS.defaultRows,
      providers: dmvAiCatalog_(),
    };
  return {
    configured: true,
    provider: settings.provider,
    providerLabel: DMV_AI_PROVIDERS[settings.provider].label,
    model: settings.model,
    instructions: settings.instructions || '',
    sourceInstructions: settings.sourceInstructions || {},
    connectionInstructions: settings.connectionInstructions || {},
    instructionCharacters: dmvAiInstructionCharacters_(settings),
    maxInstructionCharacters: DMV_AI.maxInstructionsLength,
    maxRows: dmvAiMaxRows_(settings),
    debug: settings.debug !== false,
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
    var instructionInput = dmvAiInstructionInput_(
      input.instructions === undefined
        ? (previous && previous.instructions) || ''
        : input.instructions,
      input.sourceInstructions === undefined
        ? (previous && previous.sourceInstructions) || {}
        : input.sourceInstructions,
      (previous && previous.connectionInstructions) || {}
    );
    var maxRows = input.maxRows === undefined ? dmvAiMaxRows_(previous) : input.maxRows;
    if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > DMV_LIMITS.maxRows)
      throw new Error(
        'Maximum rows per chat report must be a whole number between 1 and ' +
          DMV_LIMITS.maxRows.toLocaleString() +
          '.'
      );
    var debug = input.debug === undefined ? !previous || previous.debug !== false : input.debug;
    if (typeof debug !== 'boolean') throw new Error('Show actions must be true or false.');
    var settings = {
      debug: debug,
      id: 'settings',
      provider: input.provider,
      model: model,
      apiKey: apiKey,
      instructions: instructionInput.instructions,
      sourceInstructions: instructionInput.sourceInstructions,
      connectionInstructions: instructionInput.connectionInstructions,
      maxRows: maxRows,
      revision: previous ? (previous.revision || 0) + 1 : 1,
    };
    dmvAiWriteSettings_(settings);
    return dmvAiSummary_(settings);
  });
}

function dmvAiConnectionDefaultReleasable_(connection, settings) {
  if (!settings || !settings.sourceInstructions[connection.connectorId]) return false;
  var overrides = settings.connectionInstructions || {};
  return !dmvList_('connection').some(function (other) {
    return (
      other.id !== connection.id &&
      other.connectorId === connection.connectorId &&
      !Object.prototype.hasOwnProperty.call(overrides, other.id)
    );
  });
}

function dmvConnectionChatInstructionsSummary_(connection, settings) {
  var overrides = (settings && settings.connectionInstructions) || {};
  var inherited = !Object.prototype.hasOwnProperty.call(overrides, connection.id);
  var instructions = inherited ? '' : overrides[connection.id];
  return {
    connectionId: connection.id,
    connectorId: connection.connectorId,
    label: connection.label,
    configured: !!settings,
    instructions: instructions,
    effectiveInstructions: dmvAiConnectionInstructions_(settings, connection),
    inherited: inherited,
    totalCharacters: dmvAiInstructionCharacters_(settings),
    replacedCharacters:
      instructions.length +
      (dmvAiConnectionDefaultReleasable_(connection, settings)
        ? settings.sourceInstructions[connection.connectorId].length
        : 0),
    maxCharacters: DMV_AI.maxInstructionsLength,
    revision: settings ? settings.revision || 0 : 0,
  };
}

function dmvConnectionChatInstructions(connectionId) {
  return dmvConnectionChatInstructionsSummary_(dmvRead_('connection', connectionId), dmvAiRead_());
}

function dmvSaveConnectionChatInstructions(input) {
  return dmvLocked_(function () {
    input = input || {};
    var connection = dmvRead_('connection', input.connectionId);
    var previous = dmvAiRead_();
    if (!previous) throw new Error('Add an AI provider and API key under Settings first.');
    if (!Number.isInteger(input.revision) || input.revision !== (previous.revision || 0))
      throw new Error('Chat settings changed. Reopen the connection instructions and try again.');
    var overrides = Object.assign(Object.create(null), previous.connectionInstructions);
    overrides[connection.id] = input.instructions;
    var defaults = Object.assign({}, previous.sourceInstructions);
    // Once the last account has its own rule, remove the migrated source default.
    // This also permits replacing a full-size inherited rule without double-counting it.
    if (dmvAiConnectionDefaultReleasable_(connection, previous))
      delete defaults[connection.connectorId];
    var instructions = dmvAiInstructionInput_(previous.instructions || '', defaults, overrides);
    var settings = Object.assign({}, previous, instructions, {
      revision: (previous.revision || 0) + 1,
    });
    dmvAiWriteSettings_(settings);
    return dmvConnectionChatInstructionsSummary_(connection, settings);
  });
}

function dmvDeleteAiSettings() {
  return dmvLocked_(function () {
    dmvStore_().deleteProperty(dmvKey_('ai', 'settings'));
    try {
      dmvAiClearInstructionParts_();
    } catch (ignored) {
      /* Remove orphans on the next save. */
    }
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
    // Gemini's output limit includes thinking. Keep room for the answer and reduce
    // reasoning effort on the verified default model; other models keep their own defaults.
    var flash38 = settings.model === 'gemini-3.8-flash';
    var generationConfig = {
      maxOutputTokens: request.maxTokens || (flash38 ? 16384 : DMV_AI.maxOutputTokens),
    };
    if (flash38) generationConfig.thinkingConfig = { thinkingLevel: 'LOW' };
    var body = {
      systemInstruction: { parts: [{ text: request.system }] },
      contents: contents,
      generationConfig: generationConfig,
    };
    if (request.tools && request.tools.length)
      body.tools = [
        {
          functionDeclarations: request.tools.map(function (tool) {
            return {
              name: tool.name,
              description: tool.description,
              // JSON Schema keywords such as additionalProperties are not proto Schema fields.
              parametersJsonSchema: tool.input_schema,
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
    // A cut-off response may contain a function call; the chat must recover its
    // answer without executing actions from that incomplete response.
    var stop =
      candidate.finishReason === 'MAX_TOKENS'
        ? 'length'
        : toolCalls.length
          ? 'tool'
          : { STOP: 'end', SAFETY: 'refusal', RECITATION: 'refusal' }[candidate.finishReason];
    // Parts are replayed as-is so thought signatures on function calls survive the tool round.
    return { text: text.join('\n'), toolCalls: toolCalls, stop: stop || 'end', raw: parts };
  },
  errorMessage: dmvAiProviderError_('Gemini'),
};
