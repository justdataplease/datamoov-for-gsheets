import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatamoovSandbox, plain } from './helpers/datamoov-sandbox.mjs';

const AI_KEY = 'offline-gemini-schema-key';
const SOURCE_KEY = 'offline-gemini-schema-source-secret';
const DATASET_IDS = ['google_ads', 'facebook_ads'];

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
  const spend = [{ field: 'spend', agg: 'sum' }];
  f.plan = {
    name: 'Campaign dashboard',
    target: { sheetName: 'Gemini Dashboard' },
    datasets: f.connections.map((connection, index) => ({
      id: DATASET_IDS[index],
      label: 'Account ' + (index + 1),
      sheetName: 'Account ' + (index + 1) + ' Data',
      connectionId: connection.id,
      reportType: 'daily',
      dateRange: { preset: 'lastMonth' },
      fields: ['campaign', 'spend'],
      mapping: columns.map((column) => ({ field: column.key, key: column.key })),
    })),
    // Every tile names the datasets by their underscore IDs, so a mangled ID fails the save.
    tiles: [
      { title: 'Total spend', type: 'kpi', datasets: DATASET_IDS, metrics: spend },
      {
        title: 'Spend by campaign',
        type: 'bar',
        datasets: DATASET_IDS,
        groupBy: ['campaign'],
        metrics: spend,
      },
      {
        title: 'Campaigns',
        type: 'table',
        datasets: DATASET_IDS,
        groupBy: ['source', 'campaign'],
        metrics: spend,
        orderBy: { field: 'spend__sum', direction: 'desc' },
      },
    ],
  };
  return f;
}

// The rows of a tab under the row whose first cell is `heading`, up to the next blank row.
function rowsUnder(f, sheetName, heading, width) {
  const sheet = f.tab(sheetName);
  let row = 1;
  while (row <= sheet.getLastRow() && f.value(sheet, row, 1) !== heading) row++;
  assert.ok(row <= sheet.getLastRow(), heading + ' is on ' + sheetName);
  const rows = [];
  for (row++; row <= sheet.getLastRow() && f.value(sheet, row, 1) !== ''; row++)
    rows.push(Array.from({ length: width }, (_, column) => f.value(sheet, row, column + 1)));
  return rows;
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
  // save_dashboard nests arrays of objects three deep (datasets > mapping, tiles > metrics);
  // their bounds, enums, patterns and required lists must reach Gemini untouched.
  const dashboard = schemas.save_dashboard;
  assert.deepEqual(Object.keys(dashboard.properties).sort(), [
    'datasets',
    'id',
    'name',
    'revision',
    'target',
    'tiles',
  ]);
  assert.deepEqual(dashboard.required, ['name', 'datasets', 'tiles', 'target']);
  assert.equal(dashboard.properties.revision.type, 'integer');
  const { datasets, tiles, target } = dashboard.properties;
  assert.equal(datasets.type, 'array');
  assert.equal(datasets.minItems, 1);
  assert.equal(datasets.maxItems, 6);
  const dataset = datasets.items;
  assert.equal(dataset.type, 'object');
  assert.deepEqual(dataset.required, ['connectionId', 'reportType', 'id', 'label', 'sheetName']);
  assert.equal(dataset.properties.maxRows.maximum, 1256);
  assert.equal(dataset.properties.maxRows.default, 1256);
  assert.equal(dataset.properties.maxRows.minimum, 1);
  assert.deepEqual(dataset.properties.fields, schemas.run_report.properties.fields);
  assert.deepEqual(dataset.properties.dateRange, schemas.run_report.properties.dateRange);
  assert.deepEqual(dataset.properties.dateRange.required, ['preset']);
  for (const preset of ['last90', 'lastWeek', 'previousWeek', 'custom'])
    assert.ok(dataset.properties.dateRange.properties.preset.enum.includes(preset), preset);
  const datasetId = dataset.properties.id;
  assert.equal(datasetId.maxLength, 40);
  for (const id of DATASET_IDS) assert.ok(new RegExp(datasetId.pattern).test(id), id);
  assert.equal(new RegExp(datasetId.pattern).test('invalid/source'), false);
  assert.equal(new RegExp(datasetId.pattern).test('x'.repeat(41)), false);
  assert.equal(dataset.properties.mapping.type, 'array');
  assert.deepEqual(dataset.properties.mapping.items.required, ['field', 'key']);
  assert.deepEqual(Object.keys(dataset.properties.mapping.items.properties), ['field', 'key']);
  assert.equal(tiles.type, 'array');
  assert.equal(tiles.minItems, 1);
  assert.equal(tiles.maxItems, 12);
  const tile = tiles.items;
  assert.deepEqual(tile.required, ['title', 'type', 'metrics']);
  assert.deepEqual(tile.properties.type.enum, [
    'kpi',
    'table',
    'line',
    'column',
    'bar',
    'area',
    'pie',
    'scatter',
  ]);
  assert.deepEqual(tile.properties.datasets, {
    type: 'array',
    items: { type: 'string' },
    description: tile.properties.datasets.description,
  });
  assert.deepEqual(tile.properties.dateBucket.enum, ['day', 'week', 'month', 'year']);
  assert.deepEqual(tile.properties.metrics, schemas.summarize.properties.metrics);
  assert.deepEqual(tile.properties.metrics.items.required, ['field', 'agg']);
  assert.deepEqual(tile.properties.metrics.items.properties.agg.enum, [
    'sum',
    'avg',
    'min',
    'max',
    'count',
    'count_distinct',
  ]);
  assert.deepEqual(tile.properties.orderBy.properties.direction.enum, ['asc', 'desc']);
  assert.equal(tile.properties.limit.type, 'integer');
  assert.equal(tile.properties.limitPerGroup.minimum, 1);
  assert.deepEqual(target.required, ['sheetName']);
  assert.deepEqual(Object.keys(target.properties), ['sheetName']);
  assert.deepEqual(schemas.run_dashboard.required, ['id']);
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

test('a Gemini tool round saves and runs a two-dataset dashboard with underscore IDs and signatures intact', () => {
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
      assert.deepEqual(
        responses.get('save_dashboard').datasets.map((dataset) => dataset.id),
        DATASET_IDS
      );
      assert.equal(responses.get('save_dashboard').chartCount, 1);
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
  // One save, one fetch per dataset, then the built dashboard: no separate write or chart call.
  assert.deepEqual(
    reply.events.map((event) => event.kind + (event.action ? ':' + event.action : '')),
    ['dashboard:saved', 'report', 'report', 'dashboard:refreshed']
  );
  assert.equal(reply.events[1].text, 'Fetched Account 1 · 1 rows into Account 1 Data');
  assert.deepEqual(
    reply.events[3].links.map((link) => link.label),
    ['Dashboard: Gemini Dashboard', 'Data: Account 1 Data', 'Data: Account 2 Data']
  );
  assert.deepEqual(f.fetched, [
    { id: 'canopy', maxRows: 1256 },
    { id: 'meadow', maxRows: 1256 },
  ]);
  const saved = f.api.dmvDashboardHere_(responses.get('save_dashboard').id);
  const plan = plain(f.api.dmvUnpack_(saved.plan));
  assert.deepEqual(
    plan.datasets.map((dataset) => dataset.id),
    DATASET_IDS
  );
  assert.deepEqual(
    plan.tiles.map((tile) => tile.datasets),
    [DATASET_IDS, DATASET_IDS, DATASET_IDS]
  );
  const run = responses.get('run_dashboard');
  assert.deepEqual(
    run.datasets.map((dataset) => [dataset.id, dataset.sheetName, dataset.rowCount]),
    [
      ['google_ads', 'Account 1 Data', 1],
      ['facebook_ads', 'Account 2 Data', 1],
    ]
  );
  assert.equal(run.rowCount, 2);
  assert.equal(run.chartCount, 1);
  assert.deepEqual(run.scorecards, [{ label: 'Spend (EUR)', value: 10 }]);
  assert.equal(
    f.state.batches.length,
    1,
    'both data tabs, the dashboard tab and its chart are committed in one atomic batch'
  );
  assert.deepEqual(rowsUnder(f, 'Gemini Dashboard', 'Campaigns', 3), [
    ['Source', 'Campaign', 'Spend'],
    ['Account 2', 'meadow', 7],
    ['Account 1', 'canopy', 3],
  ]);
  assert.deepEqual(rowsUnder(f, 'Gemini Dashboard', 'Spend by campaign', 2), [
    ['Campaign', 'Spend'],
    ['meadow', 7],
    ['canopy', 3],
  ]);
  assert.deepEqual(
    f.state.charts.map((chart) => [chart.spec.title, chart.spec.basicChart.chartType]),
    [['Spend by campaign', 'BAR']]
  );
  assert.equal(f.value(f.tab('Account 2 Data'), 5, 1), 'meadow');
  assert.equal(JSON.stringify(reply).includes(SOURCE_KEY), false);
  assert.equal(JSON.stringify(reply).includes(AI_KEY), false);
});
