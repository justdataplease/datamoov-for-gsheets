import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDatamoovSandbox, plain } from './helpers/datamoov-sandbox.mjs';

const { api } = createDatamoovSandbox();

// Plain numeric columns, money columns and columns a formula may not sum.
const COLUMNS = [
  { key: 'campaign', type: 'text' },
  { key: 'a', type: 'number' },
  { key: 'b', type: 'number' },
  { key: 'c', type: 'number' },
  { key: 'clicks', type: 'number' },
  { key: 'conversions', type: 'number' },
  { key: 'spend', type: 'currency' },
  { key: 'revenue', type: 'currency' },
  { key: 'metrics.cost', type: 'currency' },
  { key: 'ctr', type: 'percent' },
  { key: 'avg_cpc', type: 'currency' },
  { key: 'reach', type: 'number', additive: false },
];

const compile = (formulas, ratios = [], columns = COLUMNS) =>
  api.dmvFormulaCompile_(formulas, columns, ratios);
const one = (expression, extra = {}) => compile([{ key: 'f', expression, ...extra }])[0];
const run = (expression, values) => api.dmvFormulaEvaluate_(one(expression), values);
const errorOf = (fn) => {
  try {
    fn();
  } catch (error) {
    return error.message;
  }
  assert.fail('expected an error');
};

test('precedence, left associativity, unary minus and parentheses', () => {
  const values = { a: 10, b: 4, c: 2, 'metrics.cost': 3 };
  const cases = [
    ['a + b * c', 18],
    ['a - b - c', 4],
    ['a / b / c', 1.25],
    ['a - b + c', 8],
    ['a * b / c', 20],
    ['(a + b) * c', 28],
    ['a - (b - c)', 8],
    ['-a', -10],
    ['--a', 10],
    ['---a', -10],
    ['- - a', 10],
    ['-a * b', -40],
    ['a * -b', -40],
    ['a - -b', 14],
    ['-(a + b)', -14],
    ['((a))', 10],
    ['2 * (a + (b - (c * 3)))', 16],
    ['a / b * c', 5],
    ['metrics.cost * 2', 6],
    ['a+b*c-b/c', 16],
  ];
  for (const [expression, expected] of cases) assert.equal(run(expression, values), expected, expression);
});

test('numbers: integers, decimals, a leading dot and plain exponents', () => {
  const values = { a: 10 };
  assert.equal(run('a * 1.05', values), 10.5);
  assert.equal(run('a * .5', values), 5);
  assert.equal(run('a + 100', values), 110);
  assert.equal(run('a * 1e3', values), 10000);
  assert.equal(run('a * 2.5E-1', values), 2.5);
  assert.equal(run('a / 0.25', values), 40);
});

test('whitespace of any kind is ignored between tokens', () => {
  assert.equal(run(' \t a \n+\r\n b\t', { a: 1, b: 2 }), 3);
  assert.equal(run('abs ( a )', { a: -1 }), 1);
});

test('every function with each accepted arity', () => {
  const values = { a: -2.345, b: 7, c: 3 };
  assert.equal(run('abs(a)', values), 2.345);
  assert.equal(run('min(a, b)', values), -2.345);
  assert.equal(run('min(b, c, a)', values), -2.345);
  assert.equal(run('max(a, b)', values), 7);
  assert.equal(run('max(a, b, c, 100)', values), 100);
  assert.equal(run('round(a)', values), -2);
  assert.equal(run('round(a, 2)', values), -2.35);
  assert.equal(run('round(b / c, 0)', values), 2);
  assert.equal(run('round(b / c, 6)', values), 2.333333);
  assert.equal(run('round(1.005 * b / b, 2)', values), 1.01);
  assert.equal(run('round(-2.5 * b / b)', values), -3);
  assert.equal(run('ROUND(b / c, 1)', values), 2.3);
  assert.equal(run('Max(a, c)', values), 3);
  assert.equal(run('abs(min(a, -b))', values), 7);
});

test('dotted identifiers and case-insensitive column keys resolve to the actual key', () => {
  const compiled = one('Metrics.Cost + Spend');
  assert.deepEqual(plain(compiled.columns), ['metrics.cost', 'spend']);
  assert.equal(api.dmvFormulaEvaluate_(compiled, { 'metrics.cost': 2, spend: 3 }), 5);
});

test('blank operands, division by zero and non-finite results give null', () => {
  assert.equal(run('a / b', { a: 1, b: 0 }), null);
  assert.equal(run('a / (b - b)', { a: 1, b: 5 }), null);
  assert.equal(run('0 * (a / b)', { a: 1, b: 0 }), null);
  assert.equal(run('a + b', { a: 1, b: null }), null);
  assert.equal(run('a + b', { a: 1 }), null);
  assert.equal(run('abs(b)', { b: null }), null);
  assert.equal(run('min(a, b)', { a: 1, b: null }), null);
  assert.equal(run('-b', { b: null }), null);
  assert.equal(run('a * b', { a: 1e308, b: 10 }), null);
  assert.equal(run('a + b', { a: 1, b: NaN }), null);
  assert.equal(run('a + b', { a: 1, b: Infinity }), null);
  assert.equal(run('a + b', { a: 1, b: '2' }), null);
  assert.equal(run('a / b', { a: 0, b: 5 }), 0);
});

test('every parse error names the problem and its position', () => {
  const cases = [
    ['', /the expression is empty at position 1\.$/],
    ['   ', /the expression is empty at position 1\./],
    ['a +', /ends early; expected a number, a column or "\(" at position 4\./],
    ['a *', /ends early.* at position 4\./],
    ['-', /ends early.* at position 2\./],
    ['(a + b', /unbalanced parenthesis: "\(" at position 1 is never closed at position 7\./],
    ['((a + b)', /"\(" at position 1 is never closed at position 9\./],
    ['a + b)', /unbalanced parenthesis: "\)" has no opening "\(" at position 6\./],
    ['(a))', /"\)" has no opening "\(" at position 4\./],
    ['abs(a', /"\(" at position 4 is never closed at position 6\./],
    ['(a b)', /expected "\)" but found "b" at position 4\./],
    ['a b', /unexpected "b" after the end of the expression at position 3\./],
    ['a 2', /unexpected "2" after the end of the expression at position 3\./],
    ['a, b', /unexpected "," after the end of the expression at position 2\./],
    ['foo(a)', /unknown function "foo" at position 1; use abs, min, max or round\./],
    ['a + sqrt(a)', /unknown function "sqrt" at position 5; use abs/],
    ['abs(a, b)', /abs takes 1 argument, not 2 at position 1\./],
    ['min(a)', /min takes at least 2 arguments, not 1 at position 1\./],
    ['b + max(a)', /max takes at least 2 arguments, not 1 at position 5\./],
    ['round(a, 1, 2)', /round takes 1 or 2 arguments, not 3 at position 1\./],
    ['round(a, 7)', /round digits must be a whole number from 0 to 6 at position 10\./],
    ['round(a, 1.5)', /round digits must be a whole number from 0 to 6 at position 10\./],
    ['round(a, -1)', /round digits must be a whole number from 0 to 6 at position 10\./],
    ['round(a, b)', /round digits must be a whole number from 0 to 6 at position 10\./],
    ['abs()', /expected a number, a column or "\(" before "\)" at position 5\./],
    ['()', /before "\)" at position 2\./],
    ['min(a,)', /before "\)" at position 7\./],
    ['+a', /expected a number, a column or "\(" but found "\+" at position 1\./],
    ['a * * b', /but found "\*" at position 5\./],
    ['a $ b', /unexpected character "\$" at position 3\./],
    ['a; b', /unexpected character ";" at position 2\./],
    ['a ^ 2', /unexpected character "\^" at position 3\./],
    ['"a"', /unexpected character """ at position 1\./],
    ['a[0]', /unexpected character "\[" at position 2\./],
    ['2a', /malformed number at position 1\./],
    ['1.2.3', /malformed number at position 1\./],
    ['a + 1e', /malformed number at position 5\./],
    ['a.', /malformed name "a\." at position 1\./],
    ['b + metrics..cost', /malformed name "metrics\." at position 5\./],
  ];
  for (const [expression, pattern] of cases) {
    const message = errorOf(() => one(expression));
    assert.match(message, /^Formula "f": /, expression);
    assert.match(message, pattern, expression);
  }
});

test('reference errors: unknown and non-summable columns, self and forward references', () => {
  const unknown = errorOf(() => one('a + revenu'));
  assert.match(unknown, /unknown column "revenu" at position 5; summable columns are a, b, c, clicks, conversions, spend, revenue, metrics\.cost\.$/);
  assert.doesNotMatch(unknown, /campaign|ctr|avg_cpc|reach/);
  assert.match(
    errorOf(() => compile([{ key: 'f', expression: 'x' }], [], [{ key: 'campaign', type: 'text' }])),
    /unknown column "x" at position 1; this result has no summable columns\./
  );
  for (const [expression, key] of [['ctr * 2', 'ctr'], ['a + avg_cpc', 'avg_cpc'], ['campaign', 'campaign'], ['reach', 'reach']])
    assert.match(errorOf(() => one(expression)), new RegExp('column "' + key + '" is not summable \\(a rate, average or text column\\)'), expression);
  assert.match(errorOf(() => compile([{ key: 'profit', expression: 'revenue - profit' }])), /Formula "profit": refers to itself at position 11\./);
  assert.match(
    errorOf(() => compile([{ key: 'margin', expression: 'profit / revenue' }, { key: 'profit', expression: 'revenue - spend' }])),
    /Formula "margin": refers to formula "profit", which comes later; list it before this one at position 1\./
  );
  assert.match(errorOf(() => one('1 + 2')), /Formula "f": it references no column/);
  assert.match(
    errorOf(() => compile([{ key: 'f', expression: 'spend' }], [{ key: 'spend', type: 'number' }])),
    /Formula key "f"|is both a column and a ratio key/
  );
});

test('formula keys, labels and the request shape are validated', () => {
  assert.deepEqual(plain(compile(undefined)), []);
  assert.match(errorOf(() => compile('a + b')), /formulas must be a list/);
  for (const bad of [null, 'x', { key: '1x', expression: 'a' }, { key: '', expression: 'a' }, { key: 'a-b', expression: 'a' }, { key: 'x'.repeat(81), expression: 'a' }, { key: '__proto__', expression: 'a' }])
    assert.match(errorOf(() => compile([bad])), /Each formula needs a short key/);
  for (const key of ['spend', 'SPEND', 'source', 'currency', 'cpa'])
    assert.match(errorOf(() => compile([{ key, expression: 'a' }], [{ key: 'cpa', type: 'currency' }])), /is already a column, ratio or formula name/, key);
  assert.match(errorOf(() => compile([{ key: 'p', expression: 'a' }, { key: 'P', expression: 'b' }])), /Formula key "P" is already/);
  assert.match(errorOf(() => compile([{ key: 'p', expression: 42 }])), /Formula "p": the expression is empty/);
  const [entry] = compile([{ key: 'p', label: 'L'.repeat(90), expression: 'a' }]);
  assert.equal(entry.label.length, 80);
  assert.equal(compile([{ key: 'p', expression: 'a' }])[0].label, 'p');
});

test('limits: 300 characters, 60 tokens, depth 12 and 10 formulas', () => {
  const padded = 'a' + ' '.repeat(299);
  assert.equal(padded.length, 300);
  assert.equal(run(padded, { a: 1 }), 1);
  assert.match(errorOf(() => one(padded + ' ')), /longer than 300 characters at position 301\./);

  const sixty = '-a' + ' + a'.repeat(29);
  assert.equal(run(sixty, { a: 1 }), 28);
  assert.match(errorOf(() => one(sixty + ' + a')), /too many parts \(at most 60 numbers, names and symbols\) at position 120\./);
  assert.match(errorOf(() => one('a' + '+a'.repeat(40))), /too many parts/);

  const deep = (n) => '('.repeat(n) + 'a' + ')'.repeat(n);
  assert.equal(run(deep(12), { a: 4 }), 4);
  assert.match(errorOf(() => one(deep(13))), /nesting deeper than 12 levels of parentheses or functions at position 13\./);
  const calls = (n) => 'abs('.repeat(n) + 'a' + ')'.repeat(n);
  assert.equal(run(calls(12), { a: -4 }), 4);
  assert.match(errorOf(() => one(calls(13))), /nesting deeper than 12 levels of parentheses or functions at position 52\./);
  // Siblings do not add up: depth is nesting, not the number of groups.
  assert.equal(run(Array.from({ length: 12 }, () => '(a)').join(' + '), { a: 1 }), 12);

  const ten = Array.from({ length: 10 }, (_, index) => ({ key: 'f' + index, expression: 'a + ' + index }));
  assert.equal(compile(ten).length, 10);
  assert.match(errorOf(() => compile(ten.concat({ key: 'f10', expression: 'a' }))), /Choose at most 10 formulas\./);
});

test('prototype names are never treated as columns, functions or values', () => {
  for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'prototype', '__defineGetter__'])
    assert.match(errorOf(() => one('a + ' + name)), new RegExp('unknown column "' + name + '"'), name);
  for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'apply', 'call'])
    assert.match(errorOf(() => one(name + '(a)')), new RegExp('unknown function "' + name + '"'), name);
  // A genuine column or formula with such a name works as an ordinary own key.
  const columns = [{ key: 'constructor', type: 'number' }, { key: 'toString', type: 'number' }];
  const compiled = compile([{ key: 'valueOf', expression: 'constructor + toString' }, { key: 'hasOwnProperty', expression: 'valueOf * 2' }], [], columns);
  const out = api.dmvFormulaEvaluateAll_(compiled, { constructor: 2, toString: 3 });
  assert.equal(out.valueOf, 5);
  assert.equal(out.hasOwnProperty, 10);
  // Values only count when they are own numbers: inherited members read as blank.
  assert.equal(api.dmvFormulaEvaluate_(compile([{ key: 'x', expression: 'constructor' }], [], columns)[0], {}), null);
  assert.equal(api.dmvFormulaEvaluate_(compile([{ key: 'x', expression: 'constructor' }], [], columns)[0], Object.create({ constructor: 5 })), null);
});

test('expressions never reach a code execution path', () => {
  const source = readFileSync(new URL('../src/dmv_formulas.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\beval\b|new Function|Function\(|setTimeout|setInterval|\bwith\s*\(|import\(|require\(/);
  for (const expression of ['a; process.exit(1)', 'this.constructor', 'a=1', 'a => a', '`a`', "a['x']", 'a || b', 'a ? b : c', 'globalThis'])
    assert.throws(() => one(expression), /Formula "f": /, expression);
});

// An independent reference: random trees are printed to text and evaluated here directly, then
// compared with the runtime's parse of that text.
function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function referenceRound(value, digits) {
  const scale = 10 ** digits;
  const scaled = Number((Math.abs(value) * scale).toPrecision(15));
  return ((value < 0 ? -1 : 1) * Math.round(scaled)) / scale;
}

function reference(node, sums) {
  const finite = (value) => (value === null || !Number.isFinite(value) ? null : value);
  switch (node.type) {
    case 'num':
      return node.value;
    case 'ref':
      return finite(sums[node.name] ?? null);
    case 'neg': {
      const value = reference(node.arg, sums);
      return value === null ? null : -value;
    }
    case 'call': {
      const args = node.args.map((arg) => reference(arg, sums));
      if (args.includes(null)) return null;
      if (node.name === 'abs') return Math.abs(args[0]);
      if (node.name === 'min') return finite(Math.min(...args));
      if (node.name === 'max') return finite(Math.max(...args));
      return finite(referenceRound(args[0], node.digits ?? 0));
    }
    default: {
      const left = reference(node.left, sums);
      const right = reference(node.right, sums);
      if (left === null || right === null) return null;
      if (node.op === '/' && right === 0) return null;
      const value = { '+': left + right, '-': left - right, '*': left * right, '/': left / right }[node.op];
      return finite(value);
    }
  }
}

const PRECEDENCE = { '+': 1, '-': 1, '*': 2, '/': 2 };
function print(node) {
  if (node.type === 'num') return node.text;
  if (node.type === 'ref') return node.name;
  if (node.type === 'neg') return '-' + (node.arg.type === 'bin' ? '(' + print(node.arg) + ')' : print(node.arg));
  if (node.type === 'call')
    return node.name + '(' + node.args.map(print).join(', ') + (node.digits !== undefined ? ', ' + node.digits : '') + ')';
  const wrap = (child, right) =>
    child.type === 'bin' && (PRECEDENCE[child.op] < PRECEDENCE[node.op] || (right && PRECEDENCE[child.op] === PRECEDENCE[node.op]))
      ? '(' + print(child) + ')'
      : print(child);
  return wrap(node.left, false) + ' ' + node.op + ' ' + wrap(node.right, true);
}

function generate(random, depth) {
  const pick = (list) => list[Math.floor(random() * list.length)];
  if (depth <= 0 || random() < 0.25) {
    if (random() < 0.6) return { type: 'ref', name: pick(['a', 'b', 'c', 'clicks', 'conversions']) };
    const text = pick(['0', '1', '2', '1.05', '.5', '100', '0.001', '3.75', '1e2']);
    return { type: 'num', text, value: Number(text) };
  }
  const roll = random();
  if (roll < 0.1) return { type: 'neg', arg: generate(random, depth - 1) };
  if (roll < 0.25) {
    const name = pick(['abs', 'min', 'max', 'round']);
    if (name === 'abs') return { type: 'call', name, args: [generate(random, depth - 1)] };
    if (name === 'round') {
      const node = { type: 'call', name, args: [generate(random, depth - 1)] };
      if (random() < 0.7) node.digits = Math.floor(random() * 7);
      return node;
    }
    const count = 2 + Math.floor(random() * 2);
    return { type: 'call', name, args: Array.from({ length: count }, () => generate(random, depth - 1)) };
  }
  return { type: 'bin', op: pick(['+', '-', '*', '/']), left: generate(random, depth - 1), right: generate(random, depth - 1) };
}

test('2,500 seeded random expressions match an independent reference evaluator', () => {
  const random = mulberry32(20261001);
  const pickSum = () => {
    const roll = random();
    if (roll < 0.12) return 0;
    if (roll < 0.2) return null;
    if (roll < 0.3) return -Math.round(random() * 500) / 10;
    return Math.round(random() * 100000) / 100;
  };
  let checked = 0,
    blanks = 0,
    zeroDivisions = 0;
  while (checked < 2500) {
    const tree = generate(random, 4);
    const text = print(tree);
    if (text.length > 300 || (text.match(/[A-Za-z_][\w.]*|\d*\.?\d+(e\d+)?|[-+*/(),]/g) || []).length > 60) continue;
    if (!/[a-z]/.test(text.replace(/abs|min|max|round|e2/g, ''))) continue;
    const sums = { a: pickSum(), b: pickSum(), c: pickSum(), clicks: pickSum(), conversions: pickSum() };
    const expected = reference(tree, sums);
    const actual = api.dmvFormulaEvaluate_(one(text), sums);
    assert.ok(Object.is(actual, expected) || (actual === 0 && expected === 0), `${text} with ${JSON.stringify(sums)}: ${actual} != ${expected}`);
    if (expected === null) blanks++;
    if (/\//.test(text) && Object.values(sums).includes(0)) zeroDivisions++;
    checked++;
  }
  assert.ok(blanks > 200 && blanks < 2300, 'the sample covers blanks and values: ' + blanks);
  assert.ok(zeroDivisions > 100);
});

test('types: money, plain numbers and literals combine by the unit rules', () => {
  const typeOf = (expression, extra) => one(expression, extra).type;
  const accepted = [
    ['spend + revenue', 'currency'],
    ['revenue - spend - metrics.cost', 'currency'],
    ['spend + 5', 'currency'],
    ['5 - spend', 'currency'],
    ['spend * 2', 'currency'],
    ['2 * spend', 'currency'],
    ['spend * clicks', 'currency'],
    ['clicks * spend', 'currency'],
    ['spend / 2', 'currency'],
    ['spend / clicks', 'currency'],
    ['revenue / spend', 'number'],
    ['revenue / 1.05 / spend', 'number'],
    ['clicks / spend', 'number'],
    ['1 / spend', 'number'],
    ['clicks + conversions', 'number'],
    ['clicks * 2 + 1', 'number'],
    ['-spend', 'currency'],
    ['abs(revenue - spend)', 'currency'],
    ['round(revenue / spend, 2)', 'number'],
    ['round(spend, 2)', 'currency'],
    ['min(spend, 10)', 'currency'],
    ['max(spend, revenue)', 'currency'],
    ['max(clicks, conversions, 1)', 'number'],
    ['(revenue - spend) / revenue', 'number'],
    ['spend / (spend + metrics.cost)', 'number'],
  ];
  for (const [expression, type] of accepted) assert.equal(typeOf(expression), type, expression);
  assert.equal(typeOf('conversions / clicks', { percent: true }), 'percent');
  assert.equal(typeOf('(revenue - spend) / revenue', { percent: true }), 'percent');

  const refused = [
    ['spend * revenue', /"\*" multiplies two amounts of money at position 7\./],
    ['(spend + 1) * (revenue - 2)', /"\*" multiplies two amounts of money at position 13\./],
    ['spend + clicks', /"\+" adds money to a non-money column at position 7\./],
    ['clicks - spend', /"-" adds money to a non-money column at position 8\./],
    ['revenue / spend + spend', /"\+" adds money to a non-money column/],
    ['min(spend, clicks)', /min compares money with a non-money column at position 1\./],
    ['max(1, clicks, spend)', /max compares money with a non-money column/],
  ];
  for (const [expression, pattern] of refused) assert.match(errorOf(() => one(expression)), pattern, expression);
  assert.match(errorOf(() => one('revenue - spend', { percent: true })), /Formula "f": the result is an amount of money, so it cannot be a percent\./);
});

test('ratios and earlier formulas compose with their units, sums and money flags', () => {
  const ratios = [
    { key: 'cpa', type: 'currency', numerator: 'spend', denominator: 'conversions' },
    { key: 'roas', type: 'number', numerator: 'revenue', denominator: 'spend' },
    { key: 'ctr_r', type: 'percent', numerator: 'clicks', denominator: 'a' },
  ];
  const compiled = compile(
    [
      { key: 'profit', expression: 'revenue - spend' },
      { key: 'margin', expression: 'profit / revenue', percent: true },
      { key: 'cpa2', expression: 'cpa * 2' },
      { key: 'roas_net', expression: 'roas / 1.05' },
      { key: 'clicks2', expression: 'ctr_r * clicks' },
      { key: 'mix', expression: 'profit + cpa' },
    ],
    ratios
  );
  assert.deepEqual(plain(compiled.map((entry) => entry.type)), ['currency', 'percent', 'currency', 'number', 'number', 'currency']);
  assert.deepEqual(plain(compiled[1].formulas), ['profit']);
  assert.deepEqual(plain(compiled[1].sums), ['revenue', 'spend']);
  assert.deepEqual(plain(compiled[1].columns), ['revenue']);
  assert.deepEqual(plain(compiled[3].ratios), ['roas']);
  assert.deepEqual(plain(compiled[3].sums), ['revenue', 'spend']);
  assert.equal(compiled[3].money, true);
  assert.equal(compiled[4].money, false);
  assert.match(errorOf(() => compile([{ key: 'p', expression: 'cpa * spend' }], ratios)), /multiplies two amounts of money/);
  assert.match(errorOf(() => compile([{ key: 'p', expression: 'cpa + clicks' }], ratios)), /adds money to a non-money column/);
  const out = api.dmvFormulaEvaluateAll_(compiled, { revenue: 200, spend: 50, cpa: 5, roas: 4, ctr_r: 0.1, clicks: 30 });
  assert.deepEqual({ ...out }, { profit: 150, margin: 0.75, cpa2: 10, roas_net: 4 / 1.05, clicks2: 3, mix: 155 });
});

// Summarize integration over a stored result, the way the chat tool sees it.
function summarizeFixture({ mixed = false } = {}) {
  const f = createDatamoovSandbox();
  const session = f.api.dmvChatSession_(f.book);
  const rows = [
    { date: '2026-08-03', campaign: 'Brand', spend: 100, revenue: 400, clicks: 50, conversions: 10, ctr: 0.05, currency: 'USD' },
    { date: '2026-08-04', campaign: 'Brand', spend: 50, revenue: 100, clicks: 25, conversions: 5, ctr: 0.04, currency: 'USD' },
    { date: '2026-08-05', campaign: 'Generic', spend: 300, revenue: 330, clicks: 90, conversions: 3, ctr: 0.02, currency: 'USD' },
    { date: '2026-08-10', campaign: 'Generic', spend: 200, revenue: 170, clicks: 60, conversions: 0, ctr: 0.01, currency: 'USD' },
    { date: '2026-08-11', campaign: 'Display', spend: 0, revenue: null, clicks: 0, conversions: 0, ctr: null, currency: 'USD' },
    { date: '2026-08-12', campaign: 'Video', spend: null, revenue: 80, clicks: 4, conversions: 1, ctr: 0.03, currency: 'USD' },
  ];
  if (mixed)
    rows.push(
      { date: '2026-08-03', campaign: 'Brand', spend: 1000, revenue: 3000, clicks: 10, conversions: 2, ctr: 0.05, currency: 'EUR' },
      { date: '2026-08-10', campaign: 'Generic', spend: 500, revenue: 400, clicks: 5, conversions: 1, ctr: 0.05, currency: 'EUR' }
    );
  const resultId = f.api.dmvChatStoreResult_(session, {
    columns: [
      { key: 'date', type: 'date' },
      { key: 'campaign', type: 'text' },
      { key: 'spend', type: 'currency' },
      { key: 'revenue', type: 'currency' },
      { key: 'clicks', type: 'number' },
      { key: 'conversions', type: 'number' },
      { key: 'ctr', type: 'percent' },
      { key: 'currency', type: 'text' },
    ],
    rows,
    metadata: { currencyColumn: 'currency' },
    source: 'Offline campaigns',
  });
  const summarize = (input) => f.api.dmvChatSummarize_(session, { resultId, ...input });
  return { ...f, session, resultId, summarize };
}

const FORMULAS = [
  { key: 'profit', label: 'Profit', expression: 'revenue - spend' },
  { key: 'margin', expression: 'profit / revenue', percent: true },
  { key: 'net_roas', expression: 'revenue / 1.05 / spend' },
];

test('summarize: grouped formulas from sums, composed with ratios and earlier formulas', () => {
  const f = summarizeFixture();
  const result = f.summarize({
    groupBy: ['campaign'],
    metrics: [{ field: 'spend', agg: 'sum' }],
    ratios: [{ key: 'cpa', numerator: 'spend', denominator: 'conversions' }],
    formulas: FORMULAS.concat({ key: 'cpa_gap', expression: 'cpa - 10' }),
    orderBy: { field: 'campaign', direction: 'asc' },
  });
  assert.deepEqual(
    plain(result.columns).map((column) => [column.key, column.type]),
    [['campaign', 'text'], ['spend__sum', 'currency'], ['cpa', 'currency'], ['profit', 'currency'], ['margin', 'percent'], ['net_roas', 'number'], ['cpa_gap', 'currency']]
  );
  assert.equal(plain(result.columns).find((column) => column.key === 'profit').label, 'Profit');
  assert.equal(plain(result.columns).find((column) => column.key === 'margin').additive, false);
  const byCampaign = Object.fromEntries(plain(result.rows).map((row) => [row.campaign, row]));
  assert.deepEqual(byCampaign.Brand, { campaign: 'Brand', spend__sum: 150, cpa: 10, profit: 350, margin: 0.7, net_roas: 3.1746, cpa_gap: 0 });
  // Generic: 500 spent, 500 revenue, 3 conversions.
  assert.deepEqual(byCampaign.Generic, { campaign: 'Generic', spend__sum: 500, cpa: 166.6667, profit: 0, margin: 0, net_roas: 0.9524, cpa_gap: 156.6667 });
  // Display has no revenue and zero spend: every formula over them is blank.
  assert.deepEqual(byCampaign.Display, { campaign: 'Display', spend__sum: 0, cpa: null, profit: null, margin: null, net_roas: null, cpa_gap: null });
  // Video has no spend at all.
  assert.deepEqual(byCampaign.Video, { campaign: 'Video', spend__sum: null, cpa: null, profit: null, margin: null, net_roas: null, cpa_gap: null });
  assert.deepEqual(result.stats.profit.sum, undefined, 'a formula column is never summed in stats');
  const event = f.session.events.at(-1);
  assert.ok(plain(event.details).some((item) => item.label === 'Formulas' && item.value.includes('profit = revenue - spend')));
});

test('summarize: grand totals are true totals, never sums of per-group results', () => {
  const f = summarizeFixture();
  const total = f.summarize({ formulas: FORMULAS });
  assert.deepEqual(plain(total.rows), [{ profit: 430, margin: 430 / 1080, net_roas: Math.round((1080 / 1.05 / 650) * 10000) / 10000 }].map((row) => ({ ...row, margin: Math.round(row.margin * 10000) / 10000 })));
  assert.deepEqual(plain(total.columns).map((column) => column.key), ['profit', 'margin', 'net_roas']);
  assert.equal(total.metadata.currency, 'USD');
});

test('summarize: filters and date buckets apply before the formulas', () => {
  const f = summarizeFixture();
  const weekly = f.summarize({
    groupBy: ['date'],
    dateBucket: 'week',
    formulas: [{ key: 'profit', expression: 'revenue - spend' }],
    filters: [{ field: 'campaign', op: 'ne', value: 'Display' }],
    orderBy: { field: 'date', direction: 'asc' },
  });
  assert.deepEqual(plain(weekly.rows), [
    { date: '2026-08-03', profit: 380 },
    { date: '2026-08-10', profit: 50 },
  ]);
  const filtered = f.summarize({ formulas: [{ key: 'profit', expression: 'revenue - spend' }], filters: [{ field: 'campaign', op: 'eq', value: 'Generic' }] });
  assert.deepEqual(plain(filtered.rows), [{ profit: 0 }]);
});

test('summarize: orderBy, rankWithin and limit work on a formula key', () => {
  const f = summarizeFixture();
  const ordered = f.summarize({ groupBy: ['campaign'], formulas: [{ key: 'profit', expression: 'revenue - spend' }], orderBy: { field: 'profit', direction: 'desc' } });
  assert.deepEqual(plain(ordered.rows).map((row) => row.campaign), ['Brand', 'Generic', 'Display', 'Video']);
  const ascending = f.summarize({ groupBy: ['campaign'], formulas: [{ key: 'profit', expression: 'revenue - spend' }], orderBy: { field: 'profit', direction: 'asc' }, limit: 1 });
  assert.deepEqual(plain(ascending.rows), [{ campaign: 'Generic', profit: 0 }]);
  assert.equal(ascending.metadata.limited, true);
  const ranked = f.summarize({
    groupBy: ['date', 'campaign'],
    dateBucket: 'week',
    formulas: [{ key: 'profit', expression: 'revenue - spend' }],
    orderBy: { field: 'profit', direction: 'desc' },
    rankWithin: ['date'],
    limitPerGroup: 1,
  });
  assert.deepEqual(plain(ranked.rows), [
    { date: '2026-08-03', campaign: 'Brand', profit: 350 },
    { date: '2026-08-10', campaign: 'Generic', profit: -30 },
  ]);
});

test('summarize: orderBy names a formula or ratio key before an earlier column labelled the same', () => {
  const f = createDatamoovSandbox();
  const session = f.api.dmvChatSession_(f.book);
  const resultId = f.api.dmvChatStoreResult_(session, {
    columns: [
      { key: 'campaign', type: 'text' },
      { key: 'metrics.cost', label: 'Cost', type: 'currency' },
      { key: 'revenue', label: 'Revenue', type: 'currency' },
      { key: 'clicks', label: 'Clicks', type: 'number' },
    ],
    rows: [
      { campaign: 'A', 'metrics.cost': 100, revenue: 400, clicks: 50 },
      { campaign: 'B', 'metrics.cost': 300, revenue: 100, clicks: 10 },
      { campaign: 'C', 'metrics.cost': 10, revenue: 1000, clicks: 1 },
    ],
    metadata: { currency: 'USD' },
    source: 'Offline campaigns',
  });
  const summarize = (input) => plain(f.api.dmvChatSummarize_(session, { resultId, groupBy: ['campaign'], metrics: [{ field: 'metrics.cost', agg: 'sum' }], ...input }));
  // metrics.cost__sum is labelled Cost; "cost" still names the formula: B -200, A 300, C 990.
  const formulas = [{ key: 'cost', expression: 'revenue - metrics.cost' }];
  const ordered = summarize({ formulas, orderBy: { field: 'cost', direction: 'asc' } });
  assert.deepEqual(ordered.rows.map((row) => [row.campaign, row.cost]), [['B', -200], ['A', 300], ['C', 990]]);
  const cut = summarize({ formulas, orderBy: { field: 'cost', direction: 'asc' }, limit: 1 });
  assert.deepEqual(cut.rows, [{ campaign: 'B', 'metrics.cost__sum': 300, cost: -200 }]);
  // A ratio key is found the same way: cost per click is A 2, C 10, B 30.
  const ratio = summarize({ ratios: [{ key: 'cost', numerator: 'metrics.cost', denominator: 'clicks' }], orderBy: { field: 'cost', direction: 'asc' } });
  assert.deepEqual(ratio.rows.map((row) => row.campaign), ['A', 'C', 'B']);
  // The label still names its column when no key does.
  assert.deepEqual(summarize({ orderBy: { field: 'COST', direction: 'asc' } }).rows.map((row) => row.campaign), ['C', 'A', 'B']);
});

test('summarize: preview rows carry formulas and output key clashes are refused', () => {
  const f = summarizeFixture();
  const preview = f.summarize({ groupBy: ['campaign'], formulas: [{ key: 'profit', expression: 'revenue - spend' }] });
  assert.equal(preview.rowCount, 4);
  assert.ok(plain(preview.rows).every((row) => 'profit' in row));
  assert.match(errorOf(() => f.summarize({ metrics: [{ field: 'spend', agg: 'sum' }], formulas: [{ key: 'spend__sum', expression: 'revenue' }] })), /Formula key "spend__sum" is already a column of this summary/);
  assert.match(errorOf(() => f.summarize({ formulas: [{ key: 'spend', expression: 'revenue' }] })), /already a column, ratio or formula name/);
  assert.match(errorOf(() => f.summarize({ ratios: [{ key: 'cpa', numerator: 'spend', denominator: 'conversions' }], formulas: [{ key: 'cpa', expression: 'spend' }] })), /already a column, ratio or formula name/);
  assert.match(errorOf(() => f.summarize({ formulas: [{ key: 'x', expression: 'ctr * 2' }] })), /column "ctr" is not summable/);
  assert.match(errorOf(() => f.summarize({ formulas: [{ key: 'x', expression: 'spend * revenue' }] })), /multiplies two amounts of money/);
});

test('summarize: mixed currencies are refused unless split by currency, like money metrics', () => {
  const f = summarizeFixture({ mixed: true });
  assert.match(errorOf(() => f.summarize({ formulas: [{ key: 'profit', expression: 'revenue - spend' }] })), /different currencies/);
  // Even a unitless result built from money (ROAS) keeps the currencies apart.
  assert.match(errorOf(() => f.summarize({ groupBy: ['campaign'], formulas: [{ key: 'roas', expression: 'revenue / spend' }] })), /different currencies/);
  const split = f.summarize({ groupBy: ['currency'], formulas: [{ key: 'profit', expression: 'revenue - spend' }], orderBy: { field: 'currency', direction: 'asc' } });
  assert.deepEqual(plain(split.rows), [
    { currency: 'EUR', profit: 1900 },
    { currency: 'USD', profit: 430 },
  ]);
  const filtered = f.summarize({ formulas: [{ key: 'profit', expression: 'revenue - spend' }], filters: [{ field: 'currency', op: 'eq', value: 'EUR' }] });
  assert.deepEqual(plain(filtered.rows), [{ profit: 1900 }]);
  // Formulas over plain counts need no split.
  const counts = f.summarize({ formulas: [{ key: 'cvr', expression: 'conversions / clicks', percent: true }] });
  assert.equal(plain(counts.rows)[0].cvr, Math.round((22 / 244) * 10000) / 10000);
});

// Two ad accounts and a shop, appended under shared keys, then profit and blended CPA by date.
function combineFixture(shopCurrency = 'USD') {
  const f = createDatamoovSandbox();
  const session = f.api.dmvChatSession_(f.book);
  const store = (rows, currency, source) =>
    f.api.dmvChatStoreResult_(session, {
      columns: [
        { key: 'date', type: 'date' },
        { key: 'cost', type: 'currency' },
        { key: 'sales', type: 'currency' },
        { key: 'orders', type: 'number' },
      ],
      rows,
      metadata: { complete: true, currency },
      source,
    });
  const google = store(
    [
      { date: '2026-09-01', cost: 120, sales: null, orders: 4 },
      { date: '2026-09-02', cost: 80, sales: null, orders: 2 },
    ],
    'USD',
    'Google Ads'
  );
  const meta = store(
    [
      { date: '2026-09-01', cost: 60, sales: null, orders: 2 },
      { date: '2026-09-02', cost: 40, sales: null, orders: 0 },
    ],
    'USD',
    'Meta'
  );
  const shop = store(
    [
      { date: '2026-09-01', cost: 15, sales: 700, orders: null },
      { date: '2026-09-02', cost: 5, sales: 90, orders: null },
    ],
    shopCurrency,
    'Shop'
  );
  const map = (resultId, label) => ({
    resultId,
    label,
    columns: ['date', 'cost', 'sales', 'orders'].map((key) => ({ from: key, to: key })),
  });
  const combined = f.api.dmvChatCombine_(session, { sources: [map(google, 'Google Ads'), map(meta, 'Meta'), map(shop, 'Shop')] });
  return { ...f, session, combined };
}

test('combine_results across three sources, then profit and blended CPA by date', () => {
  const f = combineFixture();
  const result = f.api.dmvChatSummarize_(f.session, {
    resultId: f.combined.resultId,
    groupBy: ['date'],
    ratios: [{ key: 'blended_cpa', numerator: 'cost', denominator: 'orders' }],
    formulas: [
      { key: 'profit', expression: 'sales - cost' },
      { key: 'cpa_with_fees', expression: 'cost / max(orders, 1)' },
    ],
    orderBy: { field: 'date', direction: 'asc' },
  });
  assert.deepEqual(plain(result.rows), [
    { date: '2026-09-01', blended_cpa: 32.5, profit: 505, cpa_with_fees: 32.5 },
    { date: '2026-09-02', blended_cpa: 62.5, profit: -35, cpa_with_fees: 62.5 },
  ]);
  const bySource = f.api.dmvChatSummarize_(f.session, {
    resultId: f.combined.resultId,
    groupBy: ['source'],
    formulas: [{ key: 'profit', expression: 'sales - cost' }],
    orderBy: { field: 'source', direction: 'asc' },
  });
  // Ad rows carry no sales, so their profit is blank rather than a misleading negative.
  assert.deepEqual(plain(bySource.rows), [
    { source: 'Google Ads', profit: null },
    { source: 'Meta', profit: null },
    { source: 'Shop', profit: 770 },
  ]);
});

test('combine_results holds as many rows as fit the cell budget, its source and currency columns included', () => {
  const f = combineFixture();
  const again = () =>
    f.api.dmvChatCombine_(
      f.session,
      { sources: [{ resultId: f.combined.resultId, label: 'All', columns: ['date', 'cost', 'sales', 'orders'].map((key) => ({ from: key, to: key })) }] },
      1
    );
  // Six rows of source, date, cost, sales, orders and currency.
  f.api.DMV_LIMITS.maxCells = 36;
  assert.equal(f.api.dmvChatResult_(f.session, again().resultId).rows.length, 6);
  f.api.DMV_LIMITS.maxCells = 35;
  assert.throws(again, /^Error: Combined results exceed 35 cells\. Narrow each report first\.$/);
});

test('combine_results with a shop in another currency refuses a combined formula until split', () => {
  const f = combineFixture('EUR');
  assert.match(
    errorOf(() => f.api.dmvChatSummarize_(f.session, { resultId: f.combined.resultId, groupBy: ['date'], formulas: [{ key: 'profit', expression: 'sales - cost' }] })),
    /different currencies/
  );
  const split = f.api.dmvChatSummarize_(f.session, {
    resultId: f.combined.resultId,
    groupBy: ['currency'],
    formulas: [{ key: 'profit', expression: 'sales - cost' }],
    orderBy: { field: 'currency', direction: 'asc' },
  });
  assert.deepEqual(plain(split.rows), [
    { currency: 'EUR', profit: 770 },
    { currency: 'USD', profit: null },
  ]);
});

test('the summarize schema offers formulas without oneOf or anyOf', () => {
  const f = createDatamoovSandbox();
  const session = f.api.dmvChatSession_(f.book);
  const tool = plain(f.api.dmvChatTools_(session)).find((item) => item.name === 'summarize');
  const formulas = tool.input_schema.properties.formulas;
  assert.equal(formulas.type, 'array');
  assert.deepEqual(formulas.items.required, ['key', 'expression']);
  assert.deepEqual(Object.keys(formulas.items.properties).sort(), ['expression', 'key', 'label', 'percent']);
  assert.doesNotMatch(JSON.stringify(tool.input_schema), /oneOf|anyOf|allOf/);
});
