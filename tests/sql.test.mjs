import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const runtime = vm.createContext({});
new vm.Script(readFileSync(new URL('../src/dmv_sql.js', import.meta.url), 'utf8')).runInContext(runtime);
const sql = runtime.dmvReadOnlySql_;

test('read-only SQL accepts SELECT/CTEs and removes terminal comments and delimiter', () => {
  assert.equal(sql(' /* read */ SELECT 1; -- trailing'), 'SELECT 1');
  assert.equal(sql('WITH x AS (SELECT 1 AS n) SELECT n FROM x'), 'WITH x AS (SELECT 1 AS n) SELECT n FROM x');
  assert.equal(sql("SELECT 'DELETE; (inside)' AS label"), "SELECT 'DELETE; (inside)' AS label");
  assert.equal(sql("SELECT 'it''s text' AS label"), "SELECT 'it''s text' AS label");
});

test('read-only SQL rejects DML, CTE writes, scripts and wrapper breakouts', () => {
  for (const query of [
    'DELETE FROM t', 'WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x',
    'SELECT 1; DELETE FROM t', 'SELECT 1); DELETE FROM t; SELECT (1',
    'SELECT * INTO copied FROM t', 'EXPORT DATA OPTIONS() AS SELECT 1',
    'SELECT 1; /* comment */ SELECT 2', 'SELECT (1; SELECT 2)',
  ]) assert.throws(() => sql(query), /SELECT|Write statements|statement|parentheses/);
});

test('read-only SQL refuses ambiguous quoting or incomplete constructs before a provider call', () => {
  for (const query of ["SELECT 'unclosed", 'SELECT (1', 'SELECT 1 /* unclosed',
    'SELECT /* one /* nested */ 1', "SELECT r'raw'", "SELECT '''triple'''", "SELECT 'back\\slash'", 'SELECT $$dollar$$']) {
    assert.throws(() => sql(query), /quotes|comments|literals|parentheses/);
  }
});

test('hash comments are an explicit neutral dialect capability; PostgreSQL XOR is preserved', () => {
  assert.equal(sql('SELECT 8 # 3'), 'SELECT 8 # 3');
  assert.equal(sql('SELECT 1 # comment', { hashComments: true }), 'SELECT 1');
  assert.throws(() => sql('SELECT 1 # comment; DELETE FROM t'), /statement|Write statements/);
});