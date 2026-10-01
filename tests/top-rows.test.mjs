import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatamoovSandbox, plain } from './helpers/datamoov-sandbox.mjs';

const { api } = createDatamoovSandbox();
const top = (config, maxRows = 100, refusal) => api.dmvTopRows_({ config, maxRows }, refusal);

test('Keep the top rows reads blank as every row and the form or chat values as numbers', () => {
  for (const config of [undefined, {}, { top: undefined }, { top: null }, { top: '' }, { top: '  ' }])
    assert.equal(top(config), 0, JSON.stringify(config));
  assert.equal(top({ top: 25 }), 25);
  assert.equal(top({ top: '40' }), 40, 'the chat may send text');
  assert.equal(top({ top: 100 }), 100, 'the row limit itself fits');
  assert.equal(top({ top: 30000 }, 30000), 30000);
});

test('Keep the top rows is a whole number within the row ceiling and this report’s row limit', () => {
  for (const value of [0, -5, 1.5, 'abc', '12abc', 30001])
    assert.throws(() => top({ top: value }), /^Error: Keep the top rows must be a whole number from 1 to 30,000, or blank for every row\.$/, String(value));
  assert.equal(api.DMV_LIMITS.maxRows, 30000);
  // Above the report's own limit it names both settings instead of failing on the limit later.
  assert.throws(() => top({ top: 101 }), /^Error: Keep the top rows \(101\) is above this report's row limit \(100\)\. Lower it or raise the row limit\.$/);
  assert.throws(() => top({ top: 30000 }, 10000), /\(30,000\) is above this report's row limit \(10,000\)/);
});

test('a refusal is thrown only when a top is set, after its format and before the row limit', () => {
  const refusal = 'Keep the top rows cannot be combined with Date.';
  assert.equal(top({}, 100, refusal), 0, 'a blank top is not refused');
  assert.equal(top({ top: '' }, 100, refusal), 0);
  assert.throws(() => top({ top: 5 }, 100, refusal), (error) => error.message === refusal);
  assert.throws(() => top({ top: 500 }, 100, refusal), (error) => error.message === refusal, 'the setting to change first');
  assert.throws(() => top({ top: 'x' }, 100, refusal), /whole number/, 'a malformed value is named before');
  assert.equal(top({ top: 5 }, 100, ''), 5);
});

test('the top rows are ranked highest first, blanks last, ties in their order, and labelled only when exactly the top remain', () => {
  const rows = [
    { name: 'a', spend: 5 }, { name: 'b', spend: null }, { name: 'c', spend: '12.5' }, { name: 'd', spend: 5 },
    { name: 'e', spend: 0 }, { name: 'f', spend: '' }, { name: 'g', spend: -1 }, { name: 'h' },
  ];
  const names = (kept) => kept.rows.map((row) => row.name).join('');
  const cut = api.dmvKeepTopRows_(rows, 3, 'spend', 'spend');
  assert.equal(names(cut), 'cad');
  assert.deepEqual([cut.topRows, cut.note], [3, 'Top 3 by spend']);
  assert.equal(cut.rows[0], rows[2], 'rows are kept as they are');
  assert.equal(rows.map((row) => row.name).join(''), 'abcdefgh', 'the input keeps its order');

  // Exactly as many rows as asked for may be the cut of a longer list: still labelled.
  const exact = api.dmvKeepTopRows_(rows, 8, 'spend', 'spend');
  assert.equal(names(exact), 'cadegbfh');
  assert.deepEqual([exact.topRows, exact.note], [8, 'Top 8 by spend']);
  // A shorter list is the whole list: ranked, never labelled.
  const whole = api.dmvKeepTopRows_(rows, 9, 'spend', 'spend');
  assert.equal(names(whole), 'cadegbfh');
  assert.deepEqual(plain(Object.keys(whole)), ['rows']);
  // A top of 0 only ranks.
  const ranked = api.dmvKeepTopRows_(rows, 0, 'spend', 'spend');
  assert.equal(names(ranked), 'cadegbfh');
  assert.equal(ranked.topRows, undefined);

  const many = Array.from({ length: 1200 }, (_, index) => ({ impressions: index }));
  const thousand = api.dmvKeepTopRows_(many, 1000, 'impressions', 'impressions');
  assert.equal(thousand.note, 'Top 1,000 by impressions');
  assert.equal(thousand.rows[0].impressions, 1199);
  assert.deepEqual(plain(api.dmvKeepTopRows_([], 300, 'spend', 'spend')), { rows: [] });
});

test('ranking by a column that holds text refuses instead of ranking it as blank', () => {
  for (const value of ['shoes', true, {}, '1,200'])
    assert.throws(() => api.dmvKeepTopRows_([{ spend: 1 }, { spend: value }], 1, 'spend', 'revenue'), /^Error: Keep the top rows ranks by revenue, which must hold numbers\.$/, String(value));
});
