import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Keep the top rows on the SQL sources: the database ranks the query's result by Rank by column
// and keeps that many rows, labelled only when exactly that many came back.
function load(globals = {}) {
  const connectors = {};
  const scope = vm.createContext({ dmvId_: () => 'offline-request-id', ...globals }, { codeGeneration: { strings: false, wasm: false } });
  for (const file of ['dmv_core.js', 'dmv_sql.js', 'dmv_connector_helpers.js', 'connectors/bigquery.js', 'connectors/postgres.js', 'connectors/snowflake.js']) {
    if (file.startsWith('connectors/')) scope.dmvRegisterConnector_ = (definition) => { connectors[definition.id] = definition; };
    new vm.Script(readFileSync(new URL('../src/' + file, import.meta.url), 'utf8'), { filename: file }).runInContext(scope, { timeout: 1000 });
  }
  return { scope, connectors };
}
const plain = (value) => JSON.parse(JSON.stringify(value));
const { scope, connectors } = load();
const doubleQuoted = (name) => '"' + name.replace(/"/g, '""') + '"';
const top = (config, maxRows = 100) => scope.dmvSqlTop_({ config, maxRows }, doubleQuoted);
const OVER_LIMIT = /exceeds the row limit\. Aggregate or filter it, or rank a list with Keep the top rows \(not a LIMIT\)\.$/;
const PERIOD = (name) => new RegExp('^Error: Keep the top rows ranks one row per item, so it cannot be combined with the period column ' + name + '\\. Remove ' + name + ' from the query or clear Keep the top rows; if it describes each item, not a period, give it an alias such as last_seen\\.$');

test('each SQL report offers Keep the top rows and Rank by column, the top within the row ceiling', () => {
  for (const [id, report] of [['bigquery', 'query'], ['postgres', 'sql_report'], ['snowflake', 'sql_report']]) {
    const fields = plain(connectors[id].reports.find((item) => item.id === report).configFields);
    const [topField, rankField] = fields.slice(-2);
    assert.deepEqual([topField.key, topField.label, topField.type, topField.required, topField.min, topField.max], ['top', 'Keep the top rows', 'number', false, 1, 30000], id);
    // Written out because a connector may register before dmv_core.js has run.
    assert.equal(topField.max, scope.DMV_LIMITS.maxRows, id);
    assert.match(topField.help, /Rank by column.*Blank keeps every row up to the row limit\.$/, id);
    assert.deepEqual([rankField.key, rankField.label, rankField.type, rankField.required], ['rankBy', 'Rank by column', 'text', false], id);
    assert.match(rankField.help, /^A column of the query's result; the top rows have its highest values\./, id);
    assert.match(connectors[id].reports[0].description, /Keep the top rows and Rank by column/, id);
  }
});

test('a SQL top needs a rank column and the reverse; both blank keeps every row', () => {
  for (const config of [{}, { top: '', rankBy: '' }, { top: null, rankBy: '  ' }, { top: undefined }]) assert.equal(top(config), null, JSON.stringify(config));
  assert.deepEqual(plain(top({ top: '25', rankBy: ' spend ' })), { top: 25, name: 'spend', order: ' ORDER BY "spend" DESC NULLS LAST LIMIT 25' });
  assert.throws(() => top({ top: 25 }), /^Error: Keep the top rows needs a Rank by column: the result column whose highest values come first, such as spend\.$/);
  assert.throws(() => top({ rankBy: 'spend' }), /^Error: Rank by column orders the rows Keep the top rows keeps\. Set Keep the top rows or clear Rank by column\.$/);
  assert.throws(() => top({ top: '', rankBy: 'spend' }), /Set Keep the top rows or clear Rank by column/);
  // The shared checks of the top itself: a whole number, then within this report's row limit.
  assert.throws(() => top({ top: 1.5, rankBy: 'spend' }), /whole number from 1 to 30,000/);
  assert.throws(() => top({ top: 101, rankBy: 'spend' }), /Keep the top rows \(101\) is above this report's row limit \(100\)/);
  // Quoting is the dialect's; a name that is not one column name is refused before it.
  for (const name of ['spend\nDESC', 'a\u0000b', 'x'.repeat(256)])
    assert.throws(() => top({ top: 5, rankBy: name }), /^Error: Rank by column must name one column of the query's result\.$/);
  assert.equal(top({ top: 5, rankBy: 'x'.repeat(255) }).name.length, 255);
});

test('a ranked result refuses a period column, a missing rank column and one without numbers', () => {
  const rank = top({ top: 5, rankBy: 'spend' });
  const column = (key, extra = {}) => ({ key, numeric: false, dated: false, ...extra });
  const spend = column('spend', { numeric: true });
  assert.equal(scope.dmvSqlTopColumn_(rank, [column('keyword'), spend]), 'spend');
  // A column named for a period whatever its type, or a date type named with a period word,
  // makes the rows a trend; another date is an attribute of each item, such as last_ordered.
  for (const name of ['date', 'Week', 'MONTH', 'quarter', 'year', 'day'])
    assert.throws(() => scope.dmvSqlTopColumn_(rank, [column(name), spend]), PERIOD(name), name);
  for (const name of ['order_date', 'week_start', 'ORDER_MONTH', 'signupDate', 'reporting period'])
    assert.throws(() => scope.dmvSqlTopColumn_(rank, [column(name, { dated: true }), spend]), PERIOD(name), name);
  assert.equal(scope.dmvSqlTopColumn_(rank, [column('weekday'), column('month_name'), spend]), 'spend', 'only a period itself');
  assert.equal(scope.dmvSqlTopColumn_(rank, [column('last_ordered', { dated: true }), column('created', { dated: true }), column('UPDATED_AT', { dated: true }), spend]), 'spend',
    'a date that describes each item stays');
  // Matched exactly, or without case where the dialect ignores it; never two columns at once.
  assert.equal(scope.dmvSqlTopColumn_(top({ top: 5, rankBy: 'SPEND' }), [column('keyword'), spend]), 'spend');
  assert.equal(scope.dmvSqlTopColumn_(top({ top: 5, rankBy: 'Spend' }), [column('spend'), column('Spend', { numeric: true })]), 'Spend');
  assert.throws(() => scope.dmvSqlTopColumn_(top({ top: 5, rankBy: 'SPEND' }), [column('spend', { numeric: true }), column('Spend', { numeric: true })]), /is not a column/);
  assert.throws(() => scope.dmvSqlTopColumn_(top({ top: 5, rankBy: 'cost' }), [column('keyword'), spend]),
    /^Error: Rank by column \(cost\) is not a column of the query's result\. Enter it as the result names it: keyword, spend\.$/);
  const many = Array.from({ length: 9 }, (_, index) => column('c' + index));
  assert.throws(() => scope.dmvSqlTopColumn_(rank, many), /names it: c0, c1, c2, c3, c4, c5, c6, c7…$/);
  assert.throws(() => scope.dmvSqlTopColumn_(top({ top: 5, rankBy: 'keyword' }), [column('keyword'), spend]),
    /^Error: Rank by column \(keyword\) must be a numeric column: the top rows have its highest values\.$/);
});

test('a ranked result is labelled only when exactly the top rows came back, before the connector note', () => {
  const rank = top({ top: 2, rankBy: 'spend' });
  const metadata = { complete: true, note: 'Exact decimals are exported as text.' };
  const rows = scope.dmvSqlTopRows_(rank, 'spend', [{ k: 'a', spend: '9.5' }, { k: 'b', spend: 3 }], metadata);
  assert.deepEqual(plain(rows), [{ k: 'a', spend: '9.5' }, { k: 'b', spend: 3 }]);
  assert.deepEqual(plain(metadata), { complete: true, note: 'Top 2 by spend; exact decimals are exported as text.', topRows: 2 });
  const whole = { complete: true };
  scope.dmvSqlTopRows_(rank, 'spend', [{ spend: 1 }], whole);
  assert.deepEqual(plain(whole), { complete: true }, 'a shorter list is the whole list');
  const bare = {};
  scope.dmvSqlTopRows_(rank, 'spend', [{ k: 'a' }, { k: 'b' }], bare);
  assert.deepEqual(plain(bare), { topRows: 2, note: 'Top 2 by spend' }, 'the rank column may be left out of the written columns');
  assert.throws(() => scope.dmvSqlTopRows_(rank, 'spend', [{ spend: 'NaN' }, { spend: 1 }], {}), /ranks by spend, which must hold numbers/);
});

// PostgreSQL through Apps Script JDBC.
function jdbcFixture({ columns = [['keyword', 'text'], ['spend', 'numeric']], rows = [], failure = null } = {}) {
  const events = [];
  let index = -1, wasNull = false;
  const metadata = { getColumnCount: () => columns.length, getColumnLabel: (i) => columns[i - 1][0], getColumnTypeName: (i) => columns[i - 1][1] };
  const result = { getMetaData: () => metadata, next: () => ++index < rows.length,
    getString(i) { const value = rows[index][i - 1]; wasNull = value === null; return value; }, wasNull: () => wasNull, close() { events.push(['result.close']); } };
  const statement = { setQueryTimeout: (value) => events.push(['statement.timeout', value]), setMaxRows: (value) => events.push(['statement.maxRows', value]),
    executeQuery() { events.push(['query.execute']); if (failure) throw new Error(failure); return result; }, close() { events.push(['statement.close']); } };
  const setup = { setQueryTimeout: (value) => events.push(['setup.timeout', value]), execute: (sql) => events.push(['setup.execute', sql]), close: () => events.push(['setup.close']) };
  const connection = { setReadOnly: (value) => events.push(['readOnly', value]), setAutoCommit: (value) => events.push(['autoCommit', value]), createStatement: () => setup,
    prepareStatement(sql) { events.push(['prepare', sql]); return statement; }, rollback: () => events.push(['rollback']), close: () => events.push(['connection.close']) };
  return { Jdbc: { getConnection() { events.push(['connect']); return connection; } }, events, prepared: () => events.filter((event) => event[0] === 'prepare').pop()[1],
    statements: () => events.filter((event) => event[0] === 'prepare').map((event) => event[1]) };
}
const pgContext = (config, overrides = {}) => ({ credentials: { host: 'db.example.com', database: 'analytics', username: 'reader', password: 'offline-pass' },
  config: { query: 'SELECT keyword, SUM(cost) AS spend FROM ads GROUP BY keyword', ...config }, fields: [], maxRows: 10, checkDeadline() {}, ...overrides });
const postgres = (fixture) => load({ Jdbc: fixture.Jdbc }).connectors.postgres.reports[0];

test('PostgreSQL without a top runs the same bounded query and fails over the row limit', () => {
  const fixture = jdbcFixture({ rows: [['a', '1'], ['b', '2']] });
  const result = postgres(fixture).fetch(pgContext({ top: '', rankBy: '' }));
  assert.deepEqual(fixture.statements(), ['SELECT * FROM (SELECT keyword, SUM(cost) AS spend FROM ads GROUP BY keyword) AS datamoov_report LIMIT 11']);
  assert.deepEqual([result.metadata.topRows, result.metadata.note], [undefined, 'Exact decimal and 64-bit integer columns are exported as text.']);
  const over = jdbcFixture({ rows: [['a', '1'], ['b', '2']] });
  assert.throws(() => postgres(over).fetch(pgContext({}, { maxRows: 1 })), (error) => /^The SQL result /.test(error.message) && OVER_LIMIT.test(error.message));
});

test('PostgreSQL reads the columns, ranks in the database and labels exactly the top rows', () => {
  let fixture = jdbcFixture({ rows: [['shoes', '9.50'], ['socks', '3']] });
  let result = postgres(fixture).fetch(pgContext({ top: 2, rankBy: 'spend' }));
  // The plain query's columns first, on the same read-only connection, then the ranked query.
  assert.deepEqual(fixture.statements(), [
    'SELECT * FROM (SELECT keyword, SUM(cost) AS spend FROM ads GROUP BY keyword) AS datamoov_report LIMIT 0',
    'SELECT * FROM (SELECT keyword, SUM(cost) AS spend FROM ads GROUP BY keyword) AS datamoov_report ORDER BY "spend" DESC NULLS LAST LIMIT 2',
  ]);
  assert.equal(fixture.events.filter((event) => event[0] === 'connect').length, 1);
  assert.deepEqual(fixture.events.find((event) => event[0] === 'setup.execute'), ['setup.execute', 'SET TRANSACTION READ ONLY']);
  assert.deepEqual(fixture.events.find((event) => event[0] === 'statement.timeout'), ['statement.timeout', 30]);
  assert.deepEqual(plain(result.rows), [{ keyword: 'shoes', spend: '9.50' }, { keyword: 'socks', spend: '3' }]);
  assert.deepEqual([result.metadata.topRows, result.metadata.note], [2, 'Top 2 by spend; exact decimal and 64-bit integer columns are exported as text.']);
  fixture = jdbcFixture({ rows: [['shoes', '9.50']] });
  result = postgres(fixture).fetch(pgContext({ top: 2, rankBy: 'spend' }));
  assert.equal(result.metadata.topRows, undefined, 'fewer rows are the whole list');
  assert.equal(result.metadata.note, 'Exact decimal and 64-bit integer columns are exported as text.');
  // The rank column need not be written; the database still ranked by it.
  fixture = jdbcFixture({ rows: [['shoes', '9.50'], ['socks', '3']] });
  result = postgres(fixture).fetch(pgContext({ top: 2, rankBy: 'spend' }, { fields: ['keyword'] }));
  assert.deepEqual([plain(result.rows), result.metadata.topRows], [[{ keyword: 'shoes' }, { keyword: 'socks' }], 2]);
});

test('PostgreSQL quotes the rank column with embedded quotes doubled, exactly as the result names it', () => {
  const name = 'Spend "net"; DROP TABLE ads; --';
  const fixture = jdbcFixture({ columns: [['keyword', 'text'], [name, 'float8']], rows: [['a', '2']] });
  const result = postgres(fixture).fetch(pgContext({ query: 'SELECT keyword, cost AS "Spend ""net""; DROP TABLE ads; --" FROM ads', top: 1, rankBy: name }));
  assert.match(fixture.prepared(), /\) AS datamoov_report ORDER BY "Spend ""net""; DROP TABLE ads; --" DESC NULLS LAST LIMIT 1$/);
  assert.equal(result.metadata.note.split(';')[0], 'Top 1 by Spend "net"');
});

test('PostgreSQL refuses a top setting before connecting, and a period or text rank column after the query', () => {
  const closed = load({ Jdbc: { getConnection() { throw new Error('Unexpected database access'); } } }).connectors.postgres.reports[0];
  assert.throws(() => closed.fetch(pgContext({ top: 5 })), /needs a Rank by column/);
  assert.throws(() => closed.fetch(pgContext({ rankBy: 'spend' })), /clear Rank by column/);
  assert.throws(() => closed.fetch(pgContext({ top: 11, rankBy: 'spend' })), /above this report's row limit \(10\)/);
  // The read-only guard still applies to the user's SQL first.
  assert.throws(() => closed.fetch(pgContext({ query: 'DELETE FROM ads', top: 5, rankBy: 'spend' })), /read-only/);
  assert.throws(() => closed.fetch(pgContext({ query: 'SELECT 1); DELETE FROM ads; SELECT (1', top: 5, rankBy: 'spend' })), /statement|parentheses/);
  const dated = jdbcFixture({ columns: [['day', 'date'], ['keyword', 'text'], ['spend', 'numeric']], rows: [['2026-09-01', 'a', '1']] });
  assert.throws(() => postgres(dated).fetch(pgContext({ top: 5, rankBy: 'spend' })), PERIOD('day'));
  assert.deepEqual(dated.events.slice(-4).map((event) => event[0]), ['result.close', 'statement.close', 'rollback', 'connection.close']);
  const stamped = jdbcFixture({ columns: [['keyword', 'text'], ['seen_date', 'timestamptz'], ['spend', 'int8']] });
  assert.throws(() => postgres(stamped).fetch(pgContext({ top: 5, rankBy: 'spend' })), PERIOD('seen_date'));
  // A date that describes each item, such as when it last sold, stays in a ranked list.
  const attribute = jdbcFixture({ columns: [['sku', 'text'], ['last_ordered', 'date'], ['revenue', 'numeric']], rows: [['a', '2026-09-01', '5']] });
  const kept = postgres(attribute).fetch(pgContext({ top: 1, rankBy: 'revenue' }));
  assert.deepEqual([plain(kept.rows), kept.metadata.topRows], [[{ sku: 'a', last_ordered: '2026-09-01', revenue: '5' }], 1]);
  const text = jdbcFixture({ rows: [['a', '1']] });
  assert.throws(() => postgres(text).fetch(pgContext({ top: 5, rankBy: 'keyword' })), /Rank by column \(keyword\) must be a numeric column/);
});

test('PostgreSQL matches Rank by column to the result name, lists the columns when it lacks one, and discovery ignores the ranking', () => {
  // Typed in another case, the name still finds the result's column, quoted as the result names it.
  const cased = jdbcFixture({ rows: [['shoes', '9.50']] });
  postgres(cased).fetch(pgContext({ top: 5, rankBy: 'Spend' }));
  assert.match(cased.prepared(), /\) AS datamoov_report ORDER BY "spend" DESC NULLS LAST LIMIT 5$/);
  const missing = jdbcFixture();
  assert.throws(() => postgres(missing).fetch(pgContext({ top: 5, rankBy: 'revenue' })),
    /^Error: Rank by column \(revenue\) is not a column of the query's result\. Enter it as the result names it: keyword, spend\.$/);
  assert.equal(missing.statements().length, 1, 'refused before the ranked query runs');
  const failed = jdbcFixture({ failure: 'ERROR: private detail' });
  assert.throws(() => postgres(failed).fetch(pgContext({ top: 5, rankBy: 'spend' })),
    /^Error: PostgreSQL query failed\. Check SELECT syntax, column access, and the 30-second query limit\.$/);
  const plainFailure = jdbcFixture({ failure: 'private detail' });
  assert.throws(() => postgres(plainFailure).fetch(pgContext({})), /^Error: PostgreSQL query failed\. Check SELECT syntax, column access, and the 30-second query limit\.$/);
  const discovery = jdbcFixture();
  postgres(discovery).discoverFields(pgContext({ rankBy: 'spend' }, { maxRows: 20 }));
  assert.match(discovery.prepared(), /\) AS datamoov_report LIMIT 0$/);
});

// BigQuery: dry-run, then the identical query executes.
function bqContext(replies, config = {}, overrides = {}) {
  const calls = [];
  const ctx = { credentials: {}, fields: [], maxRows: 1000, accessToken: () => 'fake-token', checkDeadline() {}, ...overrides,
    config: { projectId: 'test-project', sql: 'SELECT keyword, SUM(cost) AS spend FROM ads GROUP BY keyword', ...config },
    http(request) {
      calls.push(plain(request));
      assert.ok(replies.length, 'unexpected network request');
      return replies.shift();
    } };
  return { ctx, calls };
}
const bqFields = [{ name: 'keyword', type: 'STRING' }, { name: 'spend', type: 'NUMERIC' }];
const bqDry = (fields = bqFields) => ({ totalBytesProcessed: '10', schema: { fields } });
const bqJob = { projectId: 'test-project', jobId: 'job-one' };
const bqRows = (rows, fields = bqFields) => ({ jobComplete: true, jobReference: bqJob, schema: { fields }, totalRows: String(rows.length),
  rows: rows.map((values) => ({ f: values.map((v) => ({ v })) })) });
const bigquery = () => connectors.bigquery.reports[0];
const BQ_SQL = 'SELECT * FROM (\nSELECT keyword, SUM(cost) AS spend FROM ads GROUP BY keyword\n) AS datamoov_report';

test('BigQuery without a top runs the same dry-run-validated query and fails over the row limit', () => {
  const { ctx, calls } = bqContext([bqDry(), bqRows([['a', '1']])], { top: '', rankBy: '' });
  const result = bigquery().fetch(ctx);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.query, BQ_SQL + ' LIMIT 1001');
  assert.equal(calls[1].body.query, calls[0].body.query);
  assert.equal(result.metadata.topRows, undefined);
  const over = bqContext([bqDry(), bqRows([['a', '1'], ['b', '2']])], {}, { maxRows: 1 });
  assert.throws(() => bigquery().fetch(over.ctx), (error) => /^BigQuery result /.test(error.message) && OVER_LIMIT.test(error.message));
});

test('BigQuery checks the rank column on the plain dry run, then dry-runs and executes the ranked query', () => {
  let { ctx, calls } = bqContext([bqDry(), bqDry(), bqRows([['shoes', '9.5'], ['socks', '3']])], { top: 2, rankBy: 'Spend' });
  let result = bigquery().fetch(ctx);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].body.query, BQ_SQL + ' LIMIT 1001');
  assert.equal(calls[1].body.query, BQ_SQL + ' ORDER BY `Spend` DESC NULLS LAST LIMIT 2');
  assert.deepEqual([calls[0].body.dryRun, calls[1].body.dryRun, calls[2].body.dryRun], [true, true, undefined]);
  assert.equal(calls[2].body.query, calls[1].body.query, 'the executed query is the one validated');
  assert.equal(calls[2].body.maximumBytesBilled, '1073741824');
  // BigQuery names ignore case; the note uses the result's own name.
  assert.deepEqual(plain(result.rows), [{ keyword: 'shoes', spend: '9.5' }, { keyword: 'socks', spend: '3' }]);
  assert.deepEqual([result.metadata.topRows, result.metadata.note], [2, 'Top 2 by spend']);
  ({ ctx, calls } = bqContext([bqDry(), bqDry(), bqRows([['shoes', '9.5']])], { top: 2, rankBy: 'spend' }));
  result = bigquery().fetch(ctx);
  assert.deepEqual([result.metadata.topRows, result.metadata.note], [undefined, undefined], 'fewer rows are the whole list');
});

test('BigQuery refuses an unquotable, missing, text or period rank column before executing', () => {
  for (const name of ['spend`; DROP', 'sp\\end']) {
    const { ctx, calls } = bqContext([], { top: 2, rankBy: name });
    assert.throws(() => bigquery().fetch(ctx), /^Error: Rank by column cannot hold a backtick or backslash\./);
    assert.equal(calls.length, 0);
  }
  let setup = bqContext([], { sql: 'DELETE FROM ads', top: 2, rankBy: 'spend' });
  assert.throws(() => bigquery().fetch(setup.ctx), /SELECT or WITH/);
  assert.equal(setup.calls.length, 0, 'the read-only guard still runs first');
  setup = bqContext([bqDry()], { top: 2, rankBy: 'cost' });
  assert.throws(() => bigquery().fetch(setup.ctx), /^Error: Rank by column \(cost\) is not a column of the query's result\. Enter it as the result names it: keyword, spend\.$/);
  assert.equal(setup.calls.length, 1);
  setup = bqContext([bqDry()], { top: 2, rankBy: 'keyword' });
  assert.throws(() => bigquery().fetch(setup.ctx), /must be a numeric column/);
  for (const fields of [[{ name: 'day', type: 'DATE' }, ...bqFields], [{ name: 'week', type: 'STRING' }, ...bqFields], [{ name: 'order_date', type: 'TIMESTAMP' }, ...bqFields]]) {
    setup = bqContext([bqDry(fields)], { top: 2, rankBy: 'spend' });
    assert.throws(() => bigquery().fetch(setup.ctx), PERIOD(fields[0].name));
    assert.equal(setup.calls.length, 1);
  }
  // A date that describes each item stays.
  const lastSeen = [{ name: 'last_seen', type: 'DATE' }, ...bqFields];
  setup = bqContext([bqDry(lastSeen), bqDry(lastSeen), bqRows([['2026-09-01', 'a', '1']], lastSeen)], { top: 1, rankBy: 'spend' });
  assert.equal(bigquery().fetch(setup.ctx).metadata.topRows, 1);
  // A repeated date is a list on each row, not its period.
  const listed = [{ name: 'days', type: 'DATE', mode: 'REPEATED' }, ...bqFields];
  setup = bqContext([bqDry(listed), bqDry(listed), bqRows([[[{ v: '2026-09-01' }], 'a', '1']], listed)], { top: 1, rankBy: 'spend' });
  assert.equal(bigquery().fetch(setup.ctx).metadata.topRows, 1);
  assert.equal(setup.calls.length, 3);
});

test('BigQuery field discovery dry-runs the plain query whatever the ranking settings', () => {
  const { ctx, calls } = bqContext([bqDry()], { rankBy: 'spend' }, { maxRows: 20 });
  assert.deepEqual(plain(bigquery().discoverFields(ctx)).map((field) => field.key), ['keyword', 'spend']);
  assert.equal(calls[0].body.query, BQ_SQL + ' LIMIT 21');
});

// Snowflake SQL API: one complete partition per fixture.
function sfContext(replies, config = {}, overrides = {}) {
  const calls = [];
  const ctx = { credentials: { account: 'myorg-myaccount', token: 'offline-token', role: 'READER' }, fields: [], maxRows: 10,
    deadline: Date.now() + 60000, checkDeadline() {}, ...overrides,
    config: { query: 'SELECT keyword, SUM(cost) AS spend FROM ads GROUP BY keyword', ...config },
    http(request) {
      calls.push(plain(request));
      assert.ok(replies.length, 'unexpected network request');
      return replies.shift();
    } };
  return { ctx, calls };
}
const sfTypes = [{ name: 'KEYWORD', type: 'text' }, { name: 'SPEND', type: 'fixed', precision: 38, scale: 2 }];
const sfResult = (data, rowType = sfTypes) => ({ statementHandle: '01234567-89ab-cdef-0123-456789abcdef', code: '090001', sqlState: '00000',
  resultSetMetaData: { format: 'jsonv2', numRows: data.length, rowType, partitionInfo: data.length ? [{ rowCount: data.length, uncompressedSize: 100 }] : [] }, data });
const snowflake = () => connectors.snowflake.reports[0];
const SF_SQL = 'SELECT * FROM (\nSELECT keyword, SUM(cost) AS spend FROM ads GROUP BY keyword\n) AS datamoov_report';

test('Snowflake without a top submits the same bounded statement and fails over the row limit', () => {
  const { ctx, calls } = sfContext([sfResult([['a', '1.00']])], { top: '', rankBy: '' });
  const result = snowflake().fetch(ctx);
  assert.equal(calls[0].body.statement, SF_SQL + ' LIMIT 11');
  assert.equal(calls[0].body.timeout, 45);
  assert.equal(result.metadata.topRows, undefined);
  const over = sfContext([sfResult([['a', '1'], ['b', '2']])], {}, { maxRows: 1 });
  assert.throws(() => snowflake().fetch(over.ctx), (error) => /^The SQL result /.test(error.message) && OVER_LIMIT.test(error.message));
});

test('Snowflake reads the columns, then ranks by the quoted column as the result names it and labels exactly the top rows', () => {
  // Entered in lowercase, the name finds the uppercase alias Snowflake gave the result.
  let { ctx, calls } = sfContext([sfResult([]), sfResult([['shoes', '9.50'], ['socks', '3.00']])], { top: 2, rankBy: 'spend' });
  let result = snowflake().fetch(ctx);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.statement, SF_SQL + ' LIMIT 0');
  assert.equal(calls[1].body.statement, SF_SQL + ' ORDER BY "SPEND" DESC NULLS LAST LIMIT 2');
  assert.equal(calls[1].body.parameters.multi_statement_count, '1');
  assert.deepEqual(plain(result.rows), [{ KEYWORD: 'shoes', SPEND: '9.50' }, { KEYWORD: 'socks', SPEND: '3.00' }]);
  assert.equal(result.metadata.topRows, 2);
  assert.match(result.metadata.note, /^Top 2 by SPEND; exact decimals and integer columns wider than 15 digits/);
  ({ ctx } = sfContext([sfResult([]), sfResult([['shoes', '9.50']])], { top: 2, rankBy: 'SPEND' }));
  result = snowflake().fetch(ctx);
  assert.equal(result.metadata.topRows, undefined, 'fewer rows are the whole list');
  assert.match(result.metadata.note, /^Exact decimals/);
  const quoted = [{ name: 'KEYWORD', type: 'text' }, { name: 'net "spend"', type: 'real' }];
  ({ ctx, calls } = sfContext([sfResult([], quoted), sfResult([['a', '1']], quoted)], { top: 1, rankBy: 'net "spend"' }));
  assert.equal(snowflake().fetch(ctx).metadata.note.split(';')[0], 'Top 1 by net "spend"');
  assert.match(calls[1].body.statement, /ORDER BY "net ""spend""" DESC NULLS LAST LIMIT 1$/);
});

test('Snowflake refuses settings before submitting and a period or text rank column before reading rows', () => {
  for (const config of [{ top: 2 }, { rankBy: 'SPEND' }, { top: 11, rankBy: 'SPEND' }, { query: 'DELETE FROM ads', top: 2, rankBy: 'SPEND' }]) {
    const { ctx, calls } = sfContext([], config);
    assert.throws(() => snowflake().fetch(ctx), /Rank by column|row limit|SELECT or WITH/, JSON.stringify(config));
    assert.equal(calls.length, 0, JSON.stringify(config));
  }
  // Each refusal comes from the plain query's columns, before the ranked statement is submitted.
  for (const rowType of [[{ name: 'DAY', type: 'date' }, ...sfTypes], [{ name: 'ORDER_DATE', type: 'timestamp_ntz' }, ...sfTypes], [{ name: 'MONTH', type: 'text' }, ...sfTypes]]) {
    const { ctx, calls } = sfContext([sfResult([], rowType)], { top: 2, rankBy: 'SPEND' });
    assert.throws(() => snowflake().fetch(ctx), PERIOD(rowType[0].name));
    assert.equal(calls.length, 1);
  }
  let { ctx } = sfContext([sfResult([])], { top: 2, rankBy: 'KEYWORD' });
  assert.throws(() => snowflake().fetch(ctx), /Rank by column \(KEYWORD\) must be a numeric column/);
  ({ ctx } = sfContext([sfResult([])], { top: 2, rankBy: 'revenue' }));
  assert.throws(() => snowflake().fetch(ctx), /^Error: Rank by column \(revenue\) is not a column of the query's result\. Enter it as the result names it: KEYWORD, SPEND\.$/);
});

test('Snowflake explains an invalid identifier, and discovery ignores the ranking', () => {
  assert.match(connectors.snowflake.errorMessage(422, { code: '000904', message: "SQL compilation error: invalid identifier '\"spend\"'" }),
    /^Snowflake does not know a name in the query \(code 000904\)\. Check its column names: Snowflake names unquoted aliases in uppercase\.$/);
  assert.match(connectors.snowflake.errorMessage(422, { code: '001003' }), /^Snowflake could not execute the query \(code 001003\)/);
  const { ctx, calls } = sfContext([sfResult([])], { rankBy: 'SPEND' }, { maxRows: 20 });
  assert.deepEqual(plain(snowflake().discoverFields(ctx)).map((field) => field.key), ['KEYWORD', 'SPEND']);
  assert.equal(calls[0].body.statement, SF_SQL + ' LIMIT 0');
});
