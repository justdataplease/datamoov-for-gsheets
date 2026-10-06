import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatamoovSandbox } from './helpers/datamoov-sandbox.mjs';

// What chat is told for analysis per distinct key and for generated data, in general terms: a
// live tab of one row per key (a QUERY grouped by the key, then days since the last date, a
// repeat flag and a stated segment rule) before any dashboard (a QUERY result that starts a
// group with no key, from the data tab's empty rows, is pointed out by the set_formulas read-back,
// and readers end a tab at its last row with a value), ratios over counts for amounts per entity and shares of entities, and columns that
// depend on others (product, sum, difference, ratio, a category tied to another) computed from
// them, never drawn apart. The words stay neutral: no business, entity or column of one domain.
const DOMAIN_WORDS =
  /\b(customers?|clients?|accounts?|sellers?|shoppers?|buyers?|users?|students?|agents?|patients?|retail|retention|churn\w*|rfm|clothing|orders?|purchases?|invoices?|shipments?|tickets?|revenue|sales|prices?|quantity|quantities)\b/i;

function fixture() {
  const f = createDatamoovSandbox();
  f.session = f.api.dmvChatSession_(f.book);
  f.tools = Object.fromEntries(f.api.dmvChatTools_(f.session).map((tool) => [tool.name, tool]));
  f.prompt = f.api.dmvChatSystemPrompt_(f.session);
  return f;
}
// The sentence of text that starts with start: up to the first full stop after its last ')'.
const sentence = (text, start) => {
  const at = text.indexOf(start);
  assert.ok(at >= 0, 'missing: ' + start);
  return text.slice(at, text.indexOf('.', text.indexOf(')', at + start.length)) + 1);
};

test('analysis per distinct key first builds a live tab of one row per key, before any dashboard', () => {
  const { prompt } = fixture();
  const rule = sentence(prompt, 'Analysis per distinct key');
  assert.equal(
    rule,
    'Analysis per distinct key (segments, tiers, cohorts, activity, who returns, lapses or is at risk, top and bottom performers) first, before any dashboard, builds a live tab, one row per key: A1 a QUERY grouping the data by key (count, sums, first and last date); from row 2, under row-1 headers, ARRAYFORMULA columns: days since the last date (latest data date minus it), a 0/1 repeat flag (count > 1), a segment by an IFS rule you state (never an existing column).'
  );
  assert.doesNotMatch(rule, DOMAIN_WORDS);
});

test('generated columns that depend on others are computed from them after freezing, never drawn apart', () => {
  const { prompt } = fixture();
  const rule = sentence(prompt, 'MAKEARRAY draws each cell apart');
  assert.equal(
    rule,
    'MAKEARRAY draws each cell apart: add columns that depend on others (a product, sum, difference or ratio, a category tied to another) after freezing, as one ARRAYFORMULA, frozen too.'
  );
  assert.doesNotMatch(rule, DOMAIN_WORDS);
});

test('ratios may divide by a count or a distinct count, in summarize and on dashboard tiles', () => {
  const { tools } = fixture();
  const ratios = (schema) => schema.properties.ratios;
  const tile = tools.save_dashboard.input_schema.properties.tiles.items;
  for (const schema of [tools.summarize.input_schema, tile]) {
    const item = ratios(schema).items.properties;
    assert.match(item.numerator.description, /or column__count\./);
    assert.match(
      item.denominator.description,
      /or column__count_distinct to divide by its distinct values \(amount per entity\), column__count by its filled rows\./
    );
    assert.match(ratios(schema).description, /amount per entity = amount \/ key__count_distinct/);
    for (const text of [item.numerator.description, item.denominator.description])
      assert.doesNotMatch(text, DOMAIN_WORDS);
  }
  const rule = sentence(tools.save_dashboard.description, 'A tab of one row per entity');
  assert.match(
    rule,
    /scorecards over it are ratios over counts \(amount \/ key__count; repeat share = repeat flag \/ key__count, percent\) and its charts group by its segment\./
  );
  assert.doesNotMatch(rule, DOMAIN_WORDS);
});

// When copy_range freezes a generated table whose generator draws at random in each cell, the
// result says so: a column computed from the others inside it does not match them, and the
// moment to add such columns from the frozen ones is now. A table drawn without randomness gets
// no such note.
test('freezing a table drawn cell by cell says to compute dependent columns from the frozen ones', async () => {
  const { chatSheetFixture } = await import('./helpers/chat-sheet-fixture.mjs');
  const DRAWN = '={"ID","A","B";MAKEARRAY(20,3,LAMBDA(r,c,CHOOSE(c,r,RANDBETWEEN(1,9),RAND())))}';
  const PLAIN = '={"ID","A","B";MAKEARRAY(20,3,LAMBDA(r,c,r*c))}';
  const table = [['ID', 'A', 'B']].concat(Array.from({ length: 20 }, (_, r) => [r + 1, 2, 0.5]));
  const f = chatSheetFixture({
    formulaResult: (text) => (text === DRAWN || text === PLAIN ? table : undefined),
  });
  const freeze = (formula, cell) => {
    assert.equal(f.edit('set_formulas', { formulas: [[formula]] }, f.inspect(cell)).ok, true);
    const frozen = f.edit('copy_range', { destination: cell, pasteType: 'values' }, f.inspect(cell));
    assert.equal(frozen.ok, true, JSON.stringify(frozen));
    return frozen;
  };
  assert.equal(
    freeze(DRAWN, 'A1').next,
    'MAKEARRAY drew each cell on its own: a column that depends on others (a product, sum, difference or ratio, a category tied to another) does not match them. Add each such column now as one ARRAYFORMULA over the frozen columns, then freeze it too.'
  );
  assert.equal(freeze(PLAIN, 'E1').next, undefined);
});
