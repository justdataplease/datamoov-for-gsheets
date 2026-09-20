import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatamoovSandbox, plain } from './helpers/datamoov-sandbox.mjs';

const AI_KEY = 'offline-gemini-schema-key';
const SOURCE_KEY = 'offline-gemini-schema-source-secret';

function fixture() {
  const f = createDatamoovSandbox();
  const columns = [
    { key: 'campaign', label: 'Campaign', type: 'text', role: 'dimension' },
    { key: 'spend', label: 'Spend', type: 'currency', role: 'metric' },
  ];
  f.fetched = [];
  f.connections = ['canopy', 'meadow'].map((id, index) => {
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
            f.fetched.push({ id, maxRows: ctx.maxRows });
            return {
              columns,
              rows: [{ campaign: id, spend: index ? 7 : 3 }],
              metadata: { complete: true, currency: 'EUR' },
            };
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
  f.api.dmvSaveAiSettings({ provider: 'gemini', apiKey: AI_KEY, maxRows: 1256 });
  f.session = f.api.dmvChatSession_(f.book);
  f.session.maxRows = 1256;
  f.tools = f.api.dmvChatTools_(f.session);
  f.request = {
    system: 'Offline schema regression.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Create a dashboard.' }] }],
    tools: f.tools,
  };
  f.settings = { apiKey: AI_KEY, model: 'gemini-3.8-flash' };
  f.plan = {
    name: 'Campaign dashboard',
    sources: f.connections.map((connection, index) => ({
      id: ['google_ads', 'facebook_ads'][index],
      label: 'Account ' + (index + 1),
      connectionId: connection.id,
      reportType: 'daily',
      dateRange: { preset: 'lastMonth' },
      fields: ['campaign', 'spend'],
      mapping: columns.map((column) => ({ field: column.key, key: column.key })),
    })),
    summary: {
      groupBy: ['campaign', 'currency'],
      metrics: [{ field: 'spend', agg: 'sum' }],
      orderBy: { field: 'spend__sum', direction: 'desc' },
    },
    dataTarget: { sheetName: 'Gemini campaign data', startCell: 'A1' },
    target: { sheetName: 'Gemini dashboard', startCell: 'B3' },
  };
  return f;
}

function declarations(body) {
  return body.tools[0].functionDeclarations;
}

function assertJsonSchemaTools(body, tools) {
  const declared = declarations(body);
  assert.deepEqual(
    declared.map((tool) => tool.name),
    plain(tools.map((tool) => tool.name))
  );
  for (const [index, tool] of declared.entries()) {
    assert.equal(
      Object.hasOwn(tool, 'parameters'),
      false,
      tool.name + ' must not send JSON Schema as Gemini protobuf Schema'
    );
    assert.deepEqual(tool.parametersJsonSchema, plain(tools[index].input_schema));
  }
  return Object.fromEntries(declared.map((tool) => [tool.name, tool.parametersJsonSchema]));
}

test('the complete Gemini toolset uses JSON Schema and retains nested constraints and scalar unions', () => {
  const f = fixture();
  const built = plain(f.api.dmvAiGemini_.build(f.settings, f.request));
  const schemas = assertJsonSchemaTools(built.body, f.tools);
  assert.equal(built.headers['x-goog-api-key'], AI_KEY);
  assert.equal(JSON.stringify(built.body).includes(AI_KEY), false);
  assert.equal(schemas.create_pivot.additionalProperties, false);
  assert.equal(schemas.create_pivot.properties.rows.items.additionalProperties, false);
  assert.equal(schemas.create_pivot.properties.columns.items.additionalProperties, false);
  assert.equal(schemas.create_pivot.properties.values.items.additionalProperties, false);
  assert.deepEqual(schemas.edit_sheet.properties.values.items.items.anyOf, [
    { type: 'string' },
    { type: 'number' },
    { type: 'boolean' },
  ]);
  assert.equal(schemas.run_report.properties.maxRows.maximum, 1256);
  assert.equal(schemas.run_report.properties.maxRows.default, 1256);
  assert.equal(schemas.save_dashboard.properties.sources.items.properties.maxRows.maximum, 1256);
  assert.equal(schemas.save_dashboard.properties.sources.minItems, 2);
  assert.equal(schemas.save_dashboard.properties.sources.maxItems, 8);
  const sourceId = schemas.save_dashboard.properties.sources.items.properties.id;
  assert.equal(sourceId.maxLength, 80);
  assert.ok(new RegExp(sourceId.pattern).test('google_ads'));
  assert.ok(new RegExp(sourceId.pattern).test('facebook_ads'));
  assert.equal(new RegExp(sourceId.pattern).test('invalid/source'), false);
  assert.deepEqual(schemas.list_sheets, { type: 'object', properties: {} });
  assert.deepEqual(schemas.list_dashboards, { type: 'object', properties: {} });
});

test('Gemini adaptation leaves shared schemas and Anthropic/OpenAI declarations unchanged', () => {
  const f = fixture();
  const original = plain(
    f.tools.map(({ name, description, input_schema }) => ({ name, description, input_schema }))
  );
  f.api.dmvAiGemini_.build(f.settings, f.request);
  const anthropic = plain(f.api.dmvAiAnthropic_.build(f.settings, f.request));
  const openai = plain(f.api.dmvAiOpenAi_.build(f.settings, f.request));
  assert.deepEqual(anthropic.body.tools, original);
  assert.deepEqual(
    openai.body.tools,
    original.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }))
  );
  assert.deepEqual(
    plain(
      f.tools.map(({ name, description, input_schema }) => ({ name, description, input_schema }))
    ),
    original
  );
});

test('a Gemini tool round saves and runs a two-source dashboard with underscore IDs and signatures intact', () => {
  const f = fixture();
  const fetch = f.api.UrlFetchApp.fetch;
  const responses = new Map();
  const priorModelParts = [];
  let round = 0;
  f.api.UrlFetchApp.fetch = (url, options) => {
    const request = JSON.parse(options.payload);
    assertJsonSchemaTools(request, f.tools);
    assert.equal(
      url,
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent'
    );
    assert.equal(options.headers['x-goog-api-key'], AI_KEY);
    assert.equal(options.payload.includes(AI_KEY), false);
    assert.equal(options.payload.includes(SOURCE_KEY), false);
    assert.deepEqual(
      request.contents
        .filter((message) => message.role === 'model')
        .map((message) => message.parts),
      priorModelParts,
      'all model parts, including thought signatures, must be replayed unmodified'
    );
    for (const message of request.contents)
      for (const part of message.parts) {
        if (part.functionResponse)
          responses.set(
            part.functionResponse.name,
            JSON.parse(part.functionResponse.response.result)
          );
      }
    let parts;
    if (round === 0) {
      parts = [
        {
          functionCall: { name: 'list_dashboards', args: {} },
          thoughtSignature: 'bGlzdC1zaWduYXR1cmU=',
        },
      ];
    } else if (round === 1) {
      assert.deepEqual(responses.get('list_dashboards'), { dashboards: [] });
      parts = [
        {
          functionCall: { name: 'save_dashboard', args: f.plan },
          thoughtSignature: 'c2F2ZS1zaWduYXR1cmU=',
        },
      ];
    } else if (round === 2) {
      assert.equal(responses.get('save_dashboard').sourceCount, 2);
      parts = [
        {
          functionCall: {
            name: 'run_dashboard',
            args: {
              id: responses.get('save_dashboard').id,
            },
          },
          thoughtSignature: 'cnVuLXNpZ25hdHVyZQ==',
        },
      ];
    } else {
      assert.equal(round, 3, 'chat must finish after its completed dashboard');
      assert.equal(responses.get('run_dashboard').ok, true);
      parts = [{ text: 'Your dashboard is ready. Refresh it from Reports > Dashboards.' }];
    }
    priorModelParts.push(plain(parts));
    round++;
    f.state.responses.push({
      body: { candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }] },
    });
    return fetch(url, options);
  };
  const reply = plain(
    f.api.dmvChat({ text: 'Create a performance dashboard from both accounts.', transcript: [] })
  );
  assert.equal(round, 4);
  assert.equal(reply.failed, false);
  assert.match(reply.text, /Refresh it from Reports > Dashboards/);
  assert.deepEqual(
    reply.events.map((event) => event.kind),
    ['dashboard', 'dashboard', 'write']
  );
  assert.deepEqual(f.fetched, [
    { id: 'canopy', maxRows: 1256 },
    { id: 'meadow', maxRows: 1256 },
  ]);
  assert.deepEqual(
    plain(f.api.dmvDashboardHere_(responses.get('save_dashboard').id).sources).map(
      (source) => source.id
    ),
    ['google_ads', 'facebook_ads']
  );
  assert.equal(responses.get('run_dashboard').rowCount, 2);
  assert.equal(responses.get('run_dashboard').dataRowCount, 2);
  assert.equal(f.state.batches.length, 1, 'both dashboard tabs are committed in one atomic batch');
  assert.equal(f.value(f.tab('Gemini dashboard'), 4, 2), 'meadow');
  assert.equal(f.value(f.tab('Gemini dashboard'), 4, 4), 7);
  assert.equal(JSON.stringify(reply).includes(SOURCE_KEY), false);
  assert.equal(JSON.stringify(reply).includes(AI_KEY), false);
});
