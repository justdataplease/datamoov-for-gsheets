import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatamoovSandbox } from './helpers/datamoov-sandbox.mjs';

// Property and fuzz tests for calculated metrics. Expressions are generated as text and read by a
// reference parser written here from the spec (its own tokenizer, recursive descent, units and
// blank rules), then compared with the runtime. FORMULA_FUZZ_SEED replays one run; every failure
// names the seed and the case.
const { api } = createDatamoovSandbox();
const SEED = Number(process.env.FORMULA_FUZZ_SEED) || 20261001;

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fuzz(name, offset, body) {
  test(name + ' (seed ' + (SEED + offset) + ')', () => {
    const random = mulberry32(SEED + offset);
    const tools = {
      random,
      int: (low, high) => low + Math.floor(random() * (high - low + 1)),
      pick: (list) => list[Math.floor(random() * list.length)],
      chance: (p) => random() < p,
    };
    let current = '(setup)';
    try {
      body(tools, (label) => (current = label));
    } catch (error) {
      const prefix = 'FORMULA_FUZZ_SEED=' + SEED + ' (stream ' + (SEED + offset) + '), case ' + current + ': ';
      error.message = prefix + error.message;
      if (typeof error.stack === 'string') error.stack = prefix + '\n' + error.stack;
      throw error;
    }
  });
}

// ---- Reference implementation -------------------------------------------------------------------

class Refusal extends Error {}
const LIMITS = { chars: 300, tokens: 60, depth: 12 };
const ARITY = { abs: [1, 1], min: [2, Infinity], max: [2, Infinity], round: [1, 2] };
const isDigit = (c) => c >= '0' && c <= '9';
const isLetter = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
const isWord = (c) => isLetter(c) || isDigit(c);

function referenceTokens(text) {
  const tokens = [];
  let i = 0;
  const digits = () => {
    const start = i;
    while (i < text.length && isDigit(text[i])) i++;
    return i - start;
  };
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const start = i;
    if (isDigit(c) || (c === '.' && isDigit(text[i + 1] || ''))) {
      digits();
      if (text[i] === '.' && isDigit(text[i + 1] || '')) {
        i++;
        digits();
      }
      if ((text[i] === 'e' || text[i] === 'E') && (isDigit(text[i + 1] || '') || ('+-'.includes(text[i + 1] || '#') && isDigit(text[i + 2] || '')))) {
        i += isDigit(text[i + 1]) ? 1 : 2;
        digits();
      }
      if (i < text.length && (isWord(text[i]) || text[i] === '.')) throw new Refusal('malformed number');
      const value = Number(text.slice(start, i));
      if (!Number.isFinite(value)) throw new Refusal('number too large');
      tokens.push({ kind: 'number', value });
    } else if (isLetter(c)) {
      while (i < text.length && isWord(text[i])) i++;
      while (text[i] === '.') {
        if (!isWord(text[i + 1] || '')) throw new Refusal('malformed name');
        i++;
        while (i < text.length && isWord(text[i])) i++;
      }
      tokens.push({ kind: 'name', text: text.slice(start, i) });
    } else if ('+-*/(),'.includes(c)) {
      tokens.push({ kind: c });
      i++;
    } else throw new Refusal('unexpected character');
    if (tokens.length > LIMITS.tokens) throw new Refusal('too many tokens');
  }
  return tokens;
}

// expr := term (('+' | '-') term)*; term := factor (('*' | '/') factor)*;
// factor := '-' factor | number | name | name '(' expr (',' expr)* ')' | '(' expr ')'
function referenceParse(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Refusal('empty');
  if (text.length > LIMITS.chars) throw new Refusal('too long');
  const tokens = referenceTokens(text);
  let at = 0,
    depth = 0;
  const kind = () => (at < tokens.length ? tokens[at].kind : 'end');
  const open = () => {
    if (++depth > LIMITS.depth) throw new Refusal('too deep');
  };
  const expect = (wanted) => {
    if (kind() !== wanted) throw new Refusal('expected ' + wanted);
    at++;
  };
  function factor() {
    const token = tokens[at];
    if (kind() === '-') {
      at++;
      return { op: 'neg', arg: factor() };
    }
    if (kind() === 'number') {
      at++;
      return { op: 'num', value: token.value };
    }
    if (kind() === '(') {
      at++;
      open();
      const inner = expr();
      expect(')');
      depth--;
      return inner;
    }
    if (kind() === 'name') {
      at++;
      if (kind() !== '(') return { op: 'ref', name: token.text };
      const fn = token.text.toLowerCase();
      if (!Object.hasOwn(ARITY, fn)) throw new Refusal('unknown function');
      at++;
      open();
      const args = [expr()];
      while (kind() === ',') {
        at++;
        args.push(expr());
      }
      expect(')');
      depth--;
      if (args.length < ARITY[fn][0] || args.length > ARITY[fn][1]) throw new Refusal('arity');
      if (fn === 'round' && args.length === 2) {
        const d = args[1];
        if (d.op !== 'num' || !Number.isInteger(d.value) || d.value < 0 || d.value > 6) throw new Refusal('round digits');
      }
      return { op: fn, args };
    }
    throw new Refusal('expected an operand');
  }
  function term() {
    let left = factor();
    while (kind() === '*' || kind() === '/') {
      const op = tokens[at++].kind;
      left = { op, left, right: factor() };
    }
    return left;
  }
  function expr() {
    let left = term();
    while (kind() === '+' || kind() === '-') {
      const op = tokens[at++].kind;
      left = { op, left, right: term() };
    }
    return left;
  }
  const tree = expr();
  if (kind() !== 'end') throw new Refusal('trailing tokens');
  return tree;
}

const refsOf = (node) =>
  node.op === 'ref' ? [node.name] : node.op === 'num' ? [] : node.op === 'neg' ? refsOf(node.arg) : node.args ? node.args.flatMap(refsOf) : [...refsOf(node.left), ...refsOf(node.right)];

// Half away from zero on the value's 15 significant digits, done on the decimal digit string.
function referenceRound(value, digits) {
  const scale = 10 ** digits;
  const magnitude = Math.abs(value) * scale;
  if (magnitude >= 2 ** 53) return value;
  if (magnitude >= 1e15) return (Math.sign(value) * Math.round(magnitude)) / scale;
  if (value === 0) return value;
  const [mantissa, exponent] = Math.abs(value).toExponential(14).split('e');
  const significant = mantissa.replace('.', '');
  const keep = Number(exponent) + 1 + digits;
  if (keep < 0) return 0 * Math.sign(value);
  let whole = keep === 0 ? 0 : Number(significant.slice(0, keep));
  if (keep < significant.length && significant[keep] >= '5') whole++;
  return (Math.sign(value) * whole) / scale;
}

// scope maps a lower-case name to a value; blanks are anything but an own finite number.
function referenceEvaluate(node, scope) {
  const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  switch (node.op) {
    case 'num':
      return node.value;
    case 'ref':
      return Object.hasOwn(scope, node.name.toLowerCase()) ? finite(scope[node.name.toLowerCase()]) : null;
    case 'neg': {
      const v = referenceEvaluate(node.arg, scope);
      return v === null ? null : -v;
    }
    case 'abs':
    case 'min':
    case 'max':
    case 'round': {
      const args = [];
      for (const arg of node.args) {
        const v = referenceEvaluate(arg, scope);
        if (v === null) return null;
        args.push(v);
      }
      if (node.op === 'abs') return Math.abs(args[0]);
      if (node.op === 'round') return referenceRound(args[0], args[1] ?? 0);
      return args.reduce((a, b) => (node.op === 'min' ? (b < a ? b : a) : b > a ? b : a));
    }
    default: {
      const a = referenceEvaluate(node.left, scope);
      if (a === null) return null;
      const b = referenceEvaluate(node.right, scope);
      if (b === null) return null;
      if (node.op === '/' && b === 0) return null;
      return finite(node.op === '+' ? a + b : node.op === '-' ? a - b : node.op === '*' ? a * b : a / b);
    }
  }
}

// Units from the spec: 'money', 'plain' or 'literal'; a refusal carries the spec's wording.
function referenceUnit(node, unitOf) {
  if (node.op === 'num') return 'literal';
  if (node.op === 'ref') return unitOf(node.name.toLowerCase());
  if (node.op === 'neg') return referenceUnit(node.arg, unitOf);
  if (node.args) {
    const units = node.args.map((arg) => referenceUnit(arg, unitOf));
    if (node.op === 'abs' || node.op === 'round') return units[0];
    let unit = 'literal';
    for (const next of units) {
      if (next === 'literal' || next === unit) continue;
      if (unit === 'literal') unit = next;
      else throw new Refusal(node.op + ' compares money with a non-money column');
    }
    return unit;
  }
  const a = referenceUnit(node.left, unitOf);
  const b = referenceUnit(node.right, unitOf);
  if (node.op === '+' || node.op === '-') {
    if (a === 'literal') return b;
    if (b === 'literal' || a === b) return a;
    throw new Refusal('"' + node.op + '" adds money to a non-money column');
  }
  if (node.op === '*') {
    if (a === 'money' && b === 'money') throw new Refusal('"*" multiplies two amounts of money');
    if (a === 'money' || b === 'money') return 'money';
    return a === 'literal' ? b : a;
  }
  if (b === 'money') return 'plain';
  if (a === 'money') return 'money';
  return a === 'literal' ? b : a;
}

// ---- Generators ---------------------------------------------------------------------------------

const space = (t) => t.pick(['', '', '', ' ', ' ', '  ', '\t', '\n']);
const casing = (t, text) => (t.chance(0.75) ? text : t.chance(0.5) ? text.toUpperCase() : text[0].toUpperCase() + text.slice(1));

function numberText(t) {
  const roll = t.random();
  if (roll < 0.15) return t.pick(['0', '0.0', '1', '2', '10', '100']);
  if (roll < 0.45) return String(t.int(0, 1000));
  if (roll < 0.7) return t.int(0, 999) + '.' + String(t.int(0, 9999)).padStart(t.int(1, 4), '0');
  if (roll < 0.8) return '.' + t.int(0, 999);
  const mantissa = t.pick(['1', '2.5', '.5', '3', '1.05', '7']);
  return mantissa + t.pick(['e', 'E']) + t.pick(['', '+', '-']) + t.int(0, 6);
}

// Valid text by construction: any concatenation of valid parts with an operator is valid.
function expressionText(t, depth, names) {
  if (depth <= 0 || t.chance(0.28)) return t.chance(0.65) ? casing(t, t.pick(names)) : numberText(t);
  const roll = t.random();
  if (roll < 0.12) return '-'.repeat(t.int(1, 3)) + space(t) + expressionText(t, depth - 1, names);
  if (roll < 0.24) return '(' + space(t) + expressionText(t, depth - 1, names) + space(t) + ')';
  if (roll < 0.42) {
    const fn = t.pick(['abs', 'min', 'max', 'round']);
    const count = fn === 'abs' ? 1 : fn === 'round' ? 1 : t.int(2, 4);
    const args = Array.from({ length: count }, () => expressionText(t, depth - 1, names));
    if (fn === 'round' && t.chance(0.7)) args.push(t.pick(['0', '1', '2', '3', '4', '5', '6', '2.0', '(3)', ' 4 ', '1e0']));
    return casing(t, fn) + space(t) + '(' + space(t) + args.join(',' + space(t)) + space(t) + ')';
  }
  const op = t.pick(['+', '-', '*', '/']);
  return expressionText(t, depth - 1, names) + space(t) + op + space(t) + expressionText(t, depth - 1, names);
}

function sumValue(t) {
  const roll = t.random();
  if (roll < 0.12) return 0;
  if (roll < 0.18) return null;
  if (roll < 0.21) return undefined;
  if (roll < 0.24) return t.pick([NaN, Infinity, -Infinity, '7', true, {}]);
  if (roll < 0.27) return t.pick([1e150, -3e200, 1e300]);
  if (roll < 0.3) return t.pick([1e-200, 5e-324]);
  if (roll < 0.42) return -t.int(0, 500000) / 100;
  if (roll < 0.52) return t.int(0, 1000);
  return t.int(0, 10000000) / 1000;
}

const sameNumber = (actual, expected) => actual === expected || Object.is(actual, expected) || (actual === 0 && expected === 0);

// ---- Valid expressions against the reference ------------------------------------------------------

const PLAIN_COLUMNS = [
  { key: 'a', type: 'number' },
  { key: 'b', type: 'number' },
  { key: 'clicks', type: 'number' },
  { key: 'conversions', type: 'number' },
  { key: 'metrics.impressions', type: 'number' },
  { key: 'campaign', type: 'text', summable: false },
];
const RATIOS = [{ key: 'cvr', type: 'number', numerator: 'conversions', denominator: 'clicks' }];
const BASE = { key: 'base', expression: 'a - b * 2' };

fuzz('2,500 random valid expressions match the reference evaluator, blanks and zero divisions included', 1, (t, label) => {
  const names = ['a', 'b', 'clicks', 'conversions', 'metrics.impressions', 'cvr', 'base'];
  const baseTree = referenceParse(BASE.expression);
  let checked = 0,
    attempts = 0,
    blanks = 0,
    zeroDivisions = 0,
    rounds = 0,
    overflows = 0;
  const seen = { neg: 0, call: 0, exp: 0, dotted: 0, upper: 0 };
  while (checked < 2500) {
    assert.ok(++attempts < 20000, 'the generator keeps producing expressions over the limits');
    const text = expressionText(t, t.int(1, 6), names);
    label(attempts + ' ' + JSON.stringify(text));
    let tree;
    try {
      tree = referenceParse(text);
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      // Only the size limits can refuse generated text; the runtime must refuse it too.
      assert.match(error.message, /too long|too many tokens|too deep/);
      assert.throws(() => api.dmvFormulaCompile_([BASE, { key: 'f', expression: text }], PLAIN_COLUMNS, RATIOS), /^Error: Formula "f": .+ at position \d+/);
      continue;
    }
    if (!refsOf(tree).length) continue;

    const sums = {};
    for (const key of ['a', 'b', 'clicks', 'conversions', 'metrics.impressions', 'cvr']) {
      const value = sumValue(t);
      if (value !== undefined) sums[key] = value;
    }
    const scope = Object.create(null);
    for (const [key, value] of Object.entries(sums)) scope[key] = value;
    scope.base = referenceEvaluate(baseTree, scope);
    const expected = referenceEvaluate(tree, scope);

    const compiled = api.dmvFormulaCompile_([BASE, { key: 'f', expression: text }], PLAIN_COLUMNS, RATIOS);
    assert.equal(compiled[1].type, 'number');
    const out = api.dmvFormulaEvaluateAll_(compiled, sums);
    const actual = out.f;
    assert.ok(actual === null || Number.isFinite(actual), 'never a non-finite value: ' + actual);
    assert.ok(sameNumber(actual, expected), `${text} with ${JSON.stringify(sums)}: runtime ${actual}, reference ${expected}`);
    assert.ok(sameNumber(api.dmvFormulaEvaluate_(compiled[1], { ...sums, base: out.base }), expected), 'single evaluation agrees');

    if (expected === null) blanks++;
    if (text.includes('/') && Object.values(sums).includes(0)) zeroDivisions++;
    if (/round/i.test(text)) rounds++;
    if (Object.values(sums).some((v) => Math.abs(v) >= 1e150)) overflows++;
    if (/-\s*-/.test(text)) seen.neg++;
    if (/\(/.test(text)) seen.call++;
    if (/\de/i.test(text)) seen.exp++;
    if (/metrics\.impressions/i.test(text)) seen.dotted++;
    if (/[A-Z]/.test(text)) seen.upper++;
    checked++;
  }
  assert.ok(blanks > 250 && blanks < 2250, 'blanks and values both occur: ' + blanks);
  assert.ok(zeroDivisions > 150, 'zero divisors occur: ' + zeroDivisions);
  assert.ok(rounds > 300 && overflows > 100, 'round and huge sums occur: ' + rounds + ', ' + overflows);
  for (const [what, count] of Object.entries(seen)) assert.ok(count > 50, what + ' occurs: ' + count);
});

fuzz('round agrees with the reference on awkward magnitudes and halves', 2, (t, label) => {
  const columns = [{ key: 'a', type: 'number' }];
  const entries = [0, 1, 2, 3, 4, 5, 6].map((d) => api.dmvFormulaCompile_([{ key: 'f', expression: `round(a, ${d})` }], columns, [])[0]);
  for (let i = 0; i < 3000; i++) {
    const digits = t.int(0, 6);
    const magnitude = 10 ** t.int(-9, 20);
    const roll = t.random();
    let value =
      roll < 0.3
        ? Number((t.int(0, 10 ** 6) / 10 ** t.int(0, 7) + 5 * 10 ** -(digits + 1)).toPrecision(15))
        : roll < 0.4
          ? t.pick([1e305, -1.7e308, 2 ** 53 + 2, 9007199254740991, 1e15 + 0.5, 4503599627370495.5])
          : t.random() * magnitude;
    if (t.chance(0.4)) value = -value;
    label(`round(${value}, ${digits})`);
    const actual = api.dmvFormulaEvaluate_(entries[digits], { a: value });
    assert.ok(Number.isFinite(actual), 'a finite value rounds to a finite value: ' + actual);
    const expected = referenceRound(value, digits);
    // A value with more than 15 significant digits is past what the 15-digit correction reads, so
    // a half near its 16th digit may go either way: one unit at the rounding place. Values of 15
    // digits or fewer (every sum of short decimals) must match exactly.
    const significant = Math.abs(value).toExponential().split('e')[0].replace('.', '').length;
    if (significant > 15) assert.ok(Math.abs(actual - expected) <= 1 / 10 ** digits + Math.abs(value) * 4 * Number.EPSILON, `runtime ${actual}, reference ${expected}`);
    else assert.ok(sameNumber(actual, expected), `runtime ${actual}, reference ${expected}`);
  }
  assert.equal(api.dmvFormulaEvaluate_(api.dmvFormulaCompile_([{ key: 'f', expression: 'min(round(a, 6), 5)' }], columns, [])[0], { a: 1e305 }), 5);
  assert.equal(api.dmvFormulaEvaluate_(api.dmvFormulaCompile_([{ key: 'f', expression: 'max(round(a, 6), 5)' }], columns, [])[0], { a: 1e305 }), 1e305);
});

// ---- Units against the reference ----------------------------------------------------------------

const UNIT_COLUMNS = [
  { key: 'spend', type: 'currency' },
  { key: 'revenue', type: 'currency' },
  { key: 'clicks', type: 'number' },
  { key: 'orders', type: 'number' },
];

fuzz('2,000 random money and plain expressions get the reference unit or its exact refusal', 3, (t, label) => {
  const money = new Set(['spend', 'revenue']);
  const unitOf = (name) => (money.has(name) ? 'money' : 'plain');
  const counts = { currency: 0, number: 0, percent: 0, refused: 0 };
  let checked = 0;
  while (checked < 2000) {
    const text = expressionText(t, t.int(1, 4), ['spend', 'revenue', 'clicks', 'orders']);
    const percent = t.chance(0.25);
    label(JSON.stringify(text) + (percent ? ' as a percent' : ''));
    let tree;
    try {
      tree = referenceParse(text);
    } catch {
      continue;
    }
    if (!refsOf(tree).length) continue;
    let expected;
    try {
      const unit = referenceUnit(tree, unitOf);
      if (unit === 'money' && percent) throw new Refusal('the result is an amount of money, so it cannot be a percent');
      expected = unit === 'money' ? 'currency' : percent ? 'percent' : 'number';
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      expected = error;
    }
    const compile = () => api.dmvFormulaCompile_([{ key: 'f', expression: text, percent }], UNIT_COLUMNS, []);
    if (expected instanceof Refusal) {
      const escaped = expected.message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      assert.throws(compile, new RegExp('^Error: Formula "f": ' + escaped));
      counts.refused++;
    } else {
      const [entry] = compile();
      assert.equal(entry.type, expected);
      assert.equal(entry.money, refsOf(tree).some((name) => money.has(name.toLowerCase())));
      counts[expected]++;
    }
    checked++;
  }
  for (const [kind, count] of Object.entries(counts)) assert.ok(count > 100, kind + ' occurs: ' + count);
});

// ---- Invalid input ------------------------------------------------------------------------------

// A refusal is a plain Error naming the formula and a position inside the text (or one past it);
// anything else (a TypeError, a RangeError from recursion, a silent value) is a crash.
function assertCleanRefusal(text, columns = PLAIN_COLUMNS) {
  let error;
  try {
    api.dmvFormulaCompile_([{ key: 'f', expression: text }], columns, RATIOS);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, 'refused: ' + JSON.stringify(text));
  assert.equal(error.name, 'Error', 'a plain Error, not ' + error.name + ': ' + error.message);
  const match = /^Formula "f": (.+?) at position (\d+)(?:; .+)?\.$/s.exec(error.message);
  assert.ok(match || /^Formula "f": (the expression is empty|it references no column)/.test(error.message), 'message shape: ' + error.message);
  if (match) {
    const position = Number(match[2]);
    assert.ok(position >= 1 && position <= Math.min(text.length, 300) + 1, 'position ' + position + ' within ' + text.length);
  }
  return error;
}

const SOUP = [
  'a', 'b', 'clicks', 'CLICKS', 'metrics.impressions', 'cvr', 'campaign', 'unknown', 'x.y', 'a.', '.a',
  '1', '0', '.5', '1.', '1..2', '1e', '1e+', '1e400', '2.5e-3', '0x1F', '1_000', '1,5',
  '+', '-', '*', '/', '(', ')', ',', '(', ')', ' ', '  ',
  'abs', 'min', 'max', 'round', 'ROUND', 'sqrt', 'pow', 'log', 'eval', 'Function', 'constructor', '__proto__', 'toString', 'prototype',
  ';', '=', '==', '!', '^', '%', '&&', '||', '?', ':', '[', ']', '{', '}', '"', "'", '`', '$', '#', '@', '\\', '~', '<', '>',
  '=>', 'this', 'globalThis', 'process', 'new', 'é', ' ', '​', '😀', '\u0000', '−', '＋',
];

fuzz('random token soup is either valid and finite or a clean refusal, never a crash', 4, (t, label) => {
  let refused = 0,
    accepted = 0;
  for (let i = 0; i < 3000; i++) {
    const length = t.chance(0.4) ? t.int(1, 4) : t.int(0, 25);
    const text = Array.from({ length }, () => (t.chance(0.3) ? t.pick(['a', 'b', 'cvr', '+', '*', '2']) : t.pick(SOUP))).join(t.chance(0.5) ? ' ' : '');
    label(i + ' ' + JSON.stringify(text));
    let referenceOk = true;
    try {
      const tree = referenceParse(text);
      if (!refsOf(tree).length) referenceOk = false;
      const known = new Set(['a', 'b', 'clicks', 'conversions', 'metrics.impressions', 'cvr']);
      if (refsOf(tree).some((name) => !known.has(name.toLowerCase()))) referenceOk = false;
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      referenceOk = false;
    }
    let compiled;
    try {
      compiled = api.dmvFormulaCompile_([{ key: 'f', expression: text }], PLAIN_COLUMNS, RATIOS);
    } catch {
      assertCleanRefusal(text);
      assert.equal(referenceOk, false, 'the reference accepts what the runtime refused');
      refused++;
      continue;
    }
    assert.equal(referenceOk, true, 'the reference refuses what the runtime accepted');
    const value = api.dmvFormulaEvaluate_(compiled[0], { a: 3, b: 0, clicks: 1e300, conversions: -2, 'metrics.impressions': 7, cvr: 0.5 });
    assert.ok(value === null || Number.isFinite(value), 'finite or blank: ' + value);
    accepted++;
  }
  assert.ok(refused > 1500 && accepted > 50, 'both outcomes occur: ' + refused + ' refused, ' + accepted + ' accepted');
});

fuzz('unbalanced, overlong and deeply nested expressions are refused cleanly', 5, (t, label) => {
  const names = ['a', 'b', 'clicks', 'conversions'];
  let unbalanced = 0;
  for (let i = 0; i < 1500; i++) {
    const text = expressionText(t, t.int(2, 5), names);
    const parens = [...text].flatMap((c, index) => ('()'.includes(c) ? [index] : []));
    if (!parens.length) continue;
    const drop = t.pick(parens);
    const broken = t.chance(0.5) ? text.slice(0, drop) + text.slice(drop + 1) : text.slice(0, drop) + text[drop] + text[drop] + text.slice(drop + 1);
    label('unbalanced ' + JSON.stringify(broken));
    assertCleanRefusal(broken);
    unbalanced++;
  }
  assert.ok(unbalanced > 500, 'unbalanced cases: ' + unbalanced);

  for (let i = 0; i < 300; i++) {
    const length = t.int(301, 5000);
    let text = expressionText(t, 3, names);
    while (text.length < length) text += ' + ' + expressionText(t, 3, names);
    text = text.slice(0, length);
    label('overlong ' + length);
    assert.match(assertCleanRefusal(text).message, /longer than 300 characters at position 301\.$/);
  }
  assert.match(assertCleanRefusal('a' + ' '.repeat(1e6)).message, /longer than 300 characters/);

  for (let i = 0; i < 400; i++) {
    const levels = t.int(13, 40);
    const shape = t.pick(['parens', 'calls', 'mixed', 'unary']);
    let text = 'a';
    for (let level = 0; level < levels; level++) {
      const call = shape === 'calls' || (shape === 'mixed' && t.chance(0.5));
      text = shape === 'unary' ? '-(' + text + ')' : call ? t.pick(['abs(', 'round(', 'min(1,', 'max(b,']) + text + ')' : '(' + text + ')';
    }
    label('deep ' + shape + ' ' + levels);
    const error = assertCleanRefusal(text);
    assert.match(error.message, text.length > 300 ? /longer than 300|too many parts|nesting deeper/ : /too many parts|nesting deeper than 12 levels/);
  }
  // A long unary chain stays within the token limit or is refused for it, never by recursion.
  for (const count of [59, 60, 61, 500, 299]) {
    const text = '-'.repeat(count) + 'a';
    label('unary chain ' + count);
    if (count < 60) assert.equal(api.dmvFormulaEvaluate_(api.dmvFormulaCompile_([{ key: 'f', expression: text }], PLAIN_COLUMNS, [])[0], { a: 2 }), count % 2 ? -2 : 2);
    else assert.match(assertCleanRefusal(text).message, /too many parts|longer than 300/);
  }
});

fuzz('requests that are not well-formed formula lists are refused with plain errors', 6, (t, label) => {
  const junk = [null, undefined, 0, 1, '', 'a', [], {}, true, NaN, [1], { expression: 'a' }, Object.create(null)];
  for (let i = 0; i < 500; i++) {
    const formula = t.chance(0.5)
      ? t.pick(junk)
      : { key: t.pick(['f', '', '1f', 'f-1', 'a', 'source', 'Currency', 'cvr', 'x'.repeat(81), '__proto__', 'constructor', null, 7]), expression: t.pick(junk.concat(['a + 1', '1 +', ''])) };
    label(i + ' ' + String(JSON.stringify(formula)));
    let error = null;
    try {
      const out = api.dmvFormulaCompile_(t.chance(0.2) ? formula : [formula], PLAIN_COLUMNS, RATIOS);
      assert.ok(Array.isArray(out), 'a list comes back when nothing is refused');
    } catch (caught) {
      error = caught;
    }
    if (error) assert.equal(error.name, 'Error', error.name + ': ' + error.message);
  }
});
