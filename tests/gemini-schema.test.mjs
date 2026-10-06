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

// A tab as it reads: each row's non-empty cells in column order. Dashboard cards sit on a grid
// behind a margin column, and a merged cell holds its text in its first cell only.
function pageOf(f, name) {
  const sheet = f.tab(name);
  const out = [];
  for (let r = 1; r <= sheet.getLastRow(); r++) {
    const row = [];
    for (let c = 1; c <= sheet.maxColumns; c++) if (f.shown(sheet, r, c) !== '') row.push(f.shown(sheet, r, c));
    out.push(row);
  }
  return out;
}

// The rows under a title row (a card's header, rows and total, or a chart table) up to the next
// blank row, without the in-cell bars of a table.
function cardOf(page, title) {
  const at = page.findIndex((row) => row[0] === title);
  assert.ok(at >= 0, title + ' is on the page');
  const rows = [];
  for (let r = at + 1; r < page.length && page[r].length; r++)
    rows.push(page[r].filter((value) => !(typeof value === 'string' && /^[█▏▎▍▌▋▊▉]+$/.test(value))));
  return rows;
}

// Gemini reads parametersJsonSchema as a subset of JSON Schema: every value has one type, or an
// anyOf of typed alternatives (a threshold that is a number or a text). Type lists, oneOf, allOf,
// not and $ref stay out of every tool.
function assertGeminiSubset(schema, path) {
  assert.equal(typeof schema, 'object', path);
  for (const key of ['oneOf', 'allOf', 'not', '$ref'])
    assert.equal(Object.hasOwn(schema, key), false, path + ' uses ' + key);
  if (schema.anyOf) {
    assert.equal(Object.hasOwn(schema, 'type'), false, path + ' has a type beside anyOf');
    schema.anyOf.forEach((branch, index) => assertGeminiSubset(branch, path + '.anyOf[' + index + ']'));
    return;
  }
  assert.equal(typeof schema.type, 'string', path + ' has one type');
  for (const [name, value] of Object.entries(schema.properties || {}))
    assertGeminiSubset(value, path + '.' + name);
  if (schema.items) assertGeminiSubset(schema.items, path + '[]');
  for (const name of schema.required || [])
    assert.ok(Object.hasOwn(schema.properties || {}, name), path + ' requires an unknown ' + name);
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
  for (const [name, schema] of Object.entries(schemas)) assertGeminiSubset(schema, name);
  // Calculated metrics are plain typed objects: an expression string, never a union.
  const { formulas } = schemas.summarize.properties;
  assert.equal(formulas.type, 'array');
  assert.equal(formulas.items.type, 'object');
  assert.deepEqual(formulas.items.required, ['key', 'expression']);
  assert.deepEqual(
    Object.fromEntries(Object.entries(formulas.items.properties).map(([key, value]) => [key, value.type])),
    { key: 'string', label: 'string', expression: 'string', percent: 'boolean' }
  );
  assert.match(schemas.summarize.properties.orderBy.properties.field.description, /formula key/);
  // save_dashboard nests arrays of objects three deep (datasets > mapping, tiles > metrics);
  // their bounds, enums, patterns and required lists must reach Gemini untouched.
  const dashboard = schemas.save_dashboard;
  assert.deepEqual(Object.keys(dashboard.properties).sort(), [
    'at',
    'datasets',
    'id',
    'lowerIsBetter',
    'name',
    'neutral',
    'revision',
    'schedule',
    'target',
    'tiles',
  ]);
  // Polarity lists name metric fields or ratio keys of the tiles.
  for (const name of ['lowerIsBetter', 'neutral']) {
    const { description: _description, ...list } = dashboard.properties[name];
    assert.deepEqual(list, { type: 'array', items: { type: 'string' }, maxItems: 20 }, name);
  }
  assert.equal(dashboard.properties.at.properties.weekday.maximum, 7);
  assert.deepEqual(dashboard.properties.schedule.enum, ['manual', 'hourly', 'daily', 'weekly']);
  assert.deepEqual(dashboard.required, ['name', 'datasets', 'tiles', 'target']);
  assert.equal(dashboard.properties.revision.type, 'integer');
  const { datasets, tiles, target } = dashboard.properties;
  assert.equal(datasets.type, 'array');
  assert.equal(datasets.minItems, 1);
  assert.equal(datasets.maxItems, 8);
  const dataset = datasets.items;
  assert.equal(dataset.type, 'object');
  // A dataset is a source query (connectionId, reportType, sheetName) or a tab read in place
  // (sourceSheet), so only what both share is required; validation names what each kind needs.
  assert.deepEqual(dataset.required, ['id', 'label']);
  assert.equal(dataset.properties.sourceSheet.type, 'string');
  assert.equal(dataset.properties.maxRows.maximum, 1256);
  assert.equal(dataset.properties.maxRows.default, 1256);
  assert.equal(dataset.properties.maxRows.minimum, 1);
  assert.deepEqual(dataset.properties.fields, schemas.run_report.properties.fields);
  assert.deepEqual(dataset.properties.dateRange, schemas.run_report.properties.dateRange);
  assert.deepEqual(dataset.properties.dateRange.required, ['preset']);
  for (const preset of ['last90', 'previous7', 'previous14', 'previous30', 'previous90', 'lastWeek', 'previousWeek', 'previousMonth', 'custom'])
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
  assert.deepEqual(tile.required, ['title', 'type']);
  assert.deepEqual(tile.properties.ratios.items.required, ['key', 'numerator', 'denominator']);
  // Tile formulas are summarize's, with a note on where a formula key may be named.
  const { description: formulaNote, ...tileFormulas } = tile.properties.formulas;
  const { description: _formulaNote, ...summaryFormulas } = schemas.summarize.properties.formulas;
  assert.deepEqual(tileFormulas, summaryFormulas);
  assert.match(formulaNote, /secondaryAxis, highlight rules and lowerIsBetter\/neutral/);
  assert.match(tile.properties.secondaryAxis.description, /formula keys/);
  assert.match(tile.properties.highlight.items.properties.field.description, /formula key/);
  for (const name of ['lowerIsBetter', 'neutral']) assert.match(dashboard.properties[name].description, /formula keys/, name);
  // Tile filters are summarize's, with a note on when they apply.
  const { description: _filterNote, ...filters } = tile.properties.filters;
  const { description: _summaryNote, ...summaryFilters } = schemas.summarize.properties.filters;
  assert.deepEqual(filters, summaryFilters);
  // A compare lists every account of each period.
  const { compare, highlight } = tile.properties;
  assert.equal(compare.type, 'object');
  assert.deepEqual(compare.required, ['current', 'previous']);
  for (const side of ['current', 'previous']) {
    const { description: _description, ...ids } = compare.properties[side];
    assert.deepEqual(ids, { type: 'array', items: { type: 'string' }, minItems: 1 }, side);
  }
  // Up to four rules per table: a number or a multiple of the total for a metric or ratio, a text
  // for a groupBy column. Value is an anyOf of the two scalar types, which Gemini accepts.
  assert.equal(highlight.type, 'array');
  assert.equal(highlight.maxItems, 4);
  const rule = highlight.items;
  assert.equal(rule.type, 'object');
  assert.deepEqual(rule.required, ['field', 'op', 'color']);
  assert.deepEqual(Object.keys(rule.properties), ['field', 'op', 'value', 'ofTotal', 'color']);
  assert.deepEqual(rule.properties.op.enum, ['gt', 'gte', 'lt', 'lte', 'eq', 'ne', 'contains', 'in']);
  assert.deepEqual(rule.properties.value.anyOf, [{ type: 'number' }, { type: 'string' }]);
  assert.equal(rule.properties.ofTotal.type, 'number');
  assert.deepEqual(rule.properties.color.enum, ['red', 'green', 'amber']);
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
  const summarize = (tools) => tools.find((tool) => (tool.function || tool).name === 'summarize');
  assert.deepEqual(summarize(anthropic.body.tools).input_schema.properties.formulas.items.required, ['key', 'expression']);
  assert.deepEqual(summarize(openai.body.tools).function.parameters.properties.formulas.items.required, ['key', 'expression']);
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
  // The table card reads both datasets, ranked, with its total.
  assert.deepEqual(cardOf(pageOf(f, 'Gemini Dashboard'), 'Campaigns'), [
    ['Source', 'Campaign', 'Spend (EUR)'],
    ['Account 2', 'meadow', 7],
    ['Account 1', 'canopy', 3],
    ['Total', 10],
  ]);
  // The numbers behind the chart live on the hidden chart data tab.
  assert.deepEqual(cardOf(pageOf(f, 'Gemini Dashboard (chart data)'), 'Spend by campaign'), [
    ['Campaign', 'Spend'],
    ['meadow', 7],
    ['canopy', 3],
  ]);
  assert.deepEqual(
    // The card above the chart carries its title; the chart keeps it as alt text.
    f.state.charts.map((chart) => [chart.spec.altText, chart.spec.basicChart.chartType]),
    [['Spend by campaign', 'BAR']]
  );
  assert.equal(f.shown(f.tab('Account 2 Data'), 5, 1), 'meadow');
  assert.equal(JSON.stringify(reply).includes(SOURCE_KEY), false);
  assert.equal(JSON.stringify(reply).includes(AI_KEY), false);
});
