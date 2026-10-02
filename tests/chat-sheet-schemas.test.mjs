import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatamoovSandbox, plain } from './helpers/datamoov-sandbox.mjs';
import { assertPortable } from './helpers/chat-sheet-fixture.mjs';

// The analyst sheet tools as the three providers receive them. Old transcripts and plans name the
// sheet tools' original fields, so each keeps its type, enum values and required list; new
// actions and options are additive. Sizes are measured so the tool list and the system prompt
// stay reasonable: at aefc300 the tools were 31,440 characters and the prompt 19,965; with the
// analyst tools 42,358 and 20,526.

const AI_KEY = 'offline-sheet-schema-key';

// Every path of the sheet tools at aefc300, before the analyst tools: type, enum and required.
const ORIGINAL = {
  write_to_sheet: 'object req:resultId|sheetName',
  'write_to_sheet.resultId': 'string',
  'write_to_sheet.sheetName': 'string',
  'write_to_sheet.startCell': 'string',
  read_sheet: 'object req:sheetName',
  'read_sheet.sheetName': 'string',
  'read_sheet.range': 'string',
  create_chart: 'object req:chartType|xColumn|seriesColumns',
  'create_chart.resultId': 'string',
  'create_chart.sheetName': 'string',
  'create_chart.range': 'string',
  'create_chart.includeFutureRows': 'boolean',
  'create_chart.chartType': 'string:line|column|bar|area|scatter|pie',
  'create_chart.title': 'string',
  'create_chart.xColumn': 'string',
  'create_chart.seriesColumns': 'array',
  'create_chart.seriesColumns[]': 'string',
  'create_chart.anchorCell': 'string',
  ask_user: 'object req:question',
  'ask_user.question': 'string',
  'ask_user.options': 'array',
  'ask_user.options[]': 'string',
  list_sheets: 'object',
  inspect_sheet: 'object req:sheetName|range',
  'inspect_sheet.sheetName': 'string',
  'inspect_sheet.range': 'string',
  edit_sheet: 'object req:action',
  'edit_sheet.sheetName': 'string',
  'edit_sheet.range': 'string',
  'edit_sheet.action':
    'string:set_values|set_formulas|format|sort|filter|freeze|create_sheet|rename_sheet',
  'edit_sheet.editToken': 'string',
  'edit_sheet.newName': 'string',
  'edit_sheet.values': 'array',
  'edit_sheet.values[]': 'array',
  'edit_sheet.values[][]': 'anyOf:string|number|boolean',
  'edit_sheet.formulas': 'array',
  'edit_sheet.formulas[]': 'array',
  'edit_sheet.formulas[][]': 'string',
  'edit_sheet.format': 'object',
  'edit_sheet.format.numberFormat': 'string:number|currency|percent|date|text',
  'edit_sheet.format.bold': 'boolean',
  'edit_sheet.format.textColor': 'string',
  'edit_sheet.format.backgroundColor': 'string',
  'edit_sheet.format.horizontalAlignment': 'string:LEFT|CENTER|RIGHT',
  'edit_sheet.format.wrap': 'boolean',
  'edit_sheet.sortBy': 'array',
  'edit_sheet.sortBy[]': 'object req:column|ascending',
  'edit_sheet.sortBy[].column': 'integer',
  'edit_sheet.sortBy[].ascending': 'boolean',
  'edit_sheet.headerRows': 'integer',
  'edit_sheet.filter': 'object',
  'edit_sheet.filter.column': 'integer',
  'edit_sheet.filter.condition':
    'string:TEXT_CONTAINS|TEXT_EQ|NUMBER_GREATER|NUMBER_LESS|NOT_BLANK',
  'edit_sheet.filter.value': 'string',
  'edit_sheet.frozenRows': 'integer',
  'edit_sheet.frozenColumns': 'integer',
  create_pivot: 'object req:sourceSheet|sourceRange|targetSheet|rows|values',
  'create_pivot.sourceSheet': 'string',
  'create_pivot.sourceRange': 'string',
  'create_pivot.targetSheet': 'string',
  'create_pivot.rows': 'array',
  'create_pivot.rows[]': 'object req:column',
  'create_pivot.rows[].column': 'integer',
  'create_pivot.rows[].dateBucket': 'string:day|month|year',
  'create_pivot.columns': 'array',
  'create_pivot.columns[]': 'object req:column',
  'create_pivot.columns[].column': 'integer',
  'create_pivot.columns[].dateBucket': 'string:day|month|year',
  'create_pivot.values': 'array',
  'create_pivot.values[]': 'object req:column|summarize',
  'create_pivot.values[].column': 'integer',
  'create_pivot.values[].summarize': 'string:SUM|COUNT|COUNTA|AVERAGE|MIN|MAX',
};

function fixture() {
  const f = createDatamoovSandbox();
  f.session = f.api.dmvChatSession_(f.book);
  f.session.maxRows = 1000;
  f.tools = f.api.dmvChatTools_(f.session);
  f.request = {
    system: 'Offline sheet schema check.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Clean this export.' }] }],
    tools: f.tools,
  };
  return f;
}

// Each path of a schema as { type, enum, required }.
function paths(schema, prefix, out = {}) {
  if (schema.anyOf) {
    out[prefix] = { type: 'anyOf:' + schema.anyOf.map((branch) => branch.type).join('|') };
    return out;
  }
  out[prefix] = { type: schema.type, enum: schema.enum, required: schema.required };
  for (const [name, value] of Object.entries(schema.properties || {}))
    paths(value, prefix + '.' + name, out);
  if (schema.items) paths(schema.items, prefix + '[]', out);
  return out;
}

test('the sheet tools keep every original field, type and required list; new values are additive', () => {
  const f = fixture();
  const now = {};
  for (const tool of plain(f.tools)) paths(tool.input_schema, tool.name, now);
  for (const [path, before] of Object.entries(ORIGINAL)) {
    const [shape, required] = before.split(' req:');
    const [type, values] = shape.startsWith('anyOf:') ? [shape] : shape.split(':');
    assert.ok(now[path], path + ' is still there');
    assert.equal(now[path].type, type, path);
    // Old calls never fail a requirement they did not have, and still name existing values.
    assert.deepEqual(now[path].required || [], required ? required.split('|') : [], path);
    if (values)
      for (const value of values.split('|'))
        assert.ok(now[path].enum.includes(value), path + ' ' + value);
    else assert.equal(now[path].enum, undefined, path);
  }
  // The built-in edit actions come first, in their original order, ahead of the analyst ones.
  assert.deepEqual(
    now['edit_sheet.action'].enum.slice(0, 8),
    ORIGINAL['edit_sheet.action'].slice('string:'.length).split('|')
  );
});

test('every tool schema is valid for Gemini, OpenAI and Anthropic, the analyst tools included', () => {
  const f = fixture();
  const original = plain(
    f.tools.map(({ name, description, input_schema }) => ({ name, description, input_schema }))
  );
  const names = original.map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length, 'tool names are unique');
  for (const name of ['undo_sheet_edit', 'search_sheets', 'conditional_format'])
    assert.ok(names.includes(name), name);
  for (const tool of original) {
    // The name rule all three providers share.
    assert.match(tool.name, /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/);
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 0 && tool.description.length <= 1500, tool.name);
    assert.equal(tool.input_schema.type, 'object', tool.name);
    assertPortable(tool.input_schema, tool.name);
  }
  const settings = { apiKey: AI_KEY, model: 'offline-model' };
  const gemini = plain(f.api.dmvAiGemini_.build(settings, f.request));
  const anthropic = plain(f.api.dmvAiAnthropic_.build(settings, f.request));
  const openai = plain(f.api.dmvAiOpenAi_.build(settings, f.request));
  assert.deepEqual(
    gemini.body.tools[0].functionDeclarations.map((tool) => [tool.name, tool.parametersJsonSchema]),
    original.map((tool) => [tool.name, tool.input_schema])
  );
  for (const tool of gemini.body.tools[0].functionDeclarations)
    assert.equal(Object.hasOwn(tool, 'parameters'), false, tool.name);
  assert.deepEqual(anthropic.body.tools, original);
  assert.deepEqual(
    openai.body.tools,
    original.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.input_schema },
    }))
  );
  for (const built of [gemini, anthropic, openai])
    assert.equal(JSON.stringify(built.body).includes(AI_KEY), false);
});

test('the tool list and the system prompt stay within their measured size', () => {
  const f = fixture();
  const size = (tools) =>
    JSON.stringify(
      plain(
        tools.map(({ name, description, input_schema }) => ({ name, description, input_schema }))
      )
    ).length;
  const total = size(f.tools);
  const of = (name) => size(f.tools.filter((tool) => tool.name === name));
  assert.ok(total <= 45000, 'all tools: ' + total);
  assert.ok(of('edit_sheet') <= 7500, 'edit_sheet: ' + of('edit_sheet'));
  assert.ok(of('create_pivot') <= 4500, 'create_pivot: ' + of('create_pivot'));
  for (const name of ['undo_sheet_edit', 'search_sheets', 'conditional_format'])
    assert.ok(of(name) <= 3200, name + ': ' + of(name));
  const prompt = f.api.dmvChatSystemPrompt_(f.session);
  assert.ok(prompt.length <= 21000, 'system prompt: ' + prompt.length);
  // The guidance names the analyst work in one place and no longer limits formulas to one tab.
  assert.match(
    prompt,
    /Work like an analyst: lookups across tabs, pivots, conditional_format and cleanup actions, preferring formulas over pasted numbers when the user wants a live sheet/
  );
  assert.match(
    prompt,
    /a needsConfirmation result changed nothing, so ask and repeat the call only after a yes/
  );
  assert.doesNotMatch(prompt, /Formula support is limited to common scalar built-ins/);
  const edit = f.tools.find((tool) => tool.name === 'edit_sheet').description;
  assert.match(edit, /the analyst actions listed in action/);
  assert.doesNotMatch(edit, /deletion/);
});
