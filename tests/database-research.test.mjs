import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function load(globals={}) {
  const connectors={};
  const scope=vm.createContext({...globals});
  for(const file of ['dmv_core.js','dmv_sql.js','dmv_connector_helpers.js','connectors/postgres.js','connectors/github.js']) {
    if(file.startsWith('connectors/'))scope.dmvRegisterConnector_=definition=>{connectors[definition.id]=definition;};
    vm.runInContext(fs.readFileSync(new URL('../src/'+file,import.meta.url),'utf8'),scope,{filename:file});
  }
  return {scope,connectors};
}
function context(overrides={}) {
  return {credentials:{},config:{},fields:[],maxRows:10,checkDeadline(){},http(){throw new Error('Unexpected network');},...overrides};
}
function transport(...pages) {
  const calls=[];
  return {calls,http(request) {
    calls.push(request);assert.ok(pages.length,'Only planned provider requests');
    const page=pages.shift();if(page instanceof Error)throw page;return page;
  }};
}
function repository(id,name='owner/repo'+id) {
  return {id,full_name:name,html_url:'https://github.com/'+name,stargazers_count:0,forks_count:0,archived:false,license:null};
}

test('GitHub reads all stable search pages and preserves zero and false',()=> {
  const {http,calls}=transport({total_count:2,items:[repository(1)]},{total_count:2,items:[repository(2)]});
  const output=load().connectors.github.reports[0].fetch(context({config:{query:'topic:analytics stars:>50'},fields:['full_name','stargazers_count','archived'],http}));
  assert.equal(output.rows.length,2);
  assert.equal(output.rows[0].stargazers_count,0);
  assert.equal(output.rows[0].archived,false);
  assert.equal(new URL(calls[1].url).searchParams.get('page'),'2');
  assert.equal(new URL(calls[0].url).searchParams.get('q'),'topic:analytics stars:>50');
  assert.equal(output.metadata.complete,true);
});

test('GitHub rejects changing totals, duplicate IDs/names and excess or identity-free rows',()=> {
  const report=load().connectors.github.reports[0];
  const run=(...pages)=>report.fetch(context({config:{query:'topic:analytics'},http:transport(...pages).http}));
  assert.throws(()=>run({total_count:2,items:[repository(1)]},{total_count:3,items:[repository(2)]}),/changed/);
  assert.throws(()=>run({total_count:2,items:[repository(1)]},{total_count:2,items:[repository(1,'owner/renamed')]}),/duplicate/);
  assert.throws(()=>run({total_count:2,items:[repository(1)]},{total_count:2,items:[repository(2,'OWNER/REPO1')]}),/duplicate/);
  assert.throws(()=>run({total_count:1,items:[repository(1),repository(2)]}),/more repositories/);
  assert.throws(()=>run({total_count:1,items:[{}]}),/stable identity/);
});

test('GitHub does not accept incomplete search pages or results exceeding caps',()=> {
  const report=load().connectors.github.reports[0];
  const run=(page,options={})=>report.fetch(context({config:{query:'stars:>0'},http:transport(page).http,...options}));
  assert.equal(run({total_count:0,items:[]}).rows.length,0);
  assert.throws(()=>run({total_count:1,items:[],incomplete_results:true}),/incomplete/);
  assert.throws(()=>run({total_count:1,items:[]}),/before all results/);
  assert.throws(()=>run({total_count:11,items:[]}),/row limit/);
  assert.throws(()=>run({total_count:1001,items:[]},{maxRows:5000}),/1,000-result cap/);
  assert.throws(()=>run(new Error('Provider denied access')),/denied/);
});

test('GitHub normalizes repository URLs, deduplicates input, and uses list precedence',()=> {
  const {http,calls}=transport(repository(1,'owner/repo'));
  const output=load().connectors.github.reports[0].fetch(context({config:{query:'ignored',repositories:'https://github.com/owner/repo.git\nOWNER/repo'},credentials:{token:'fake-token'},http}));
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,'https://api.github.com/repos/owner/repo');
  assert.equal(calls[0].headers.Authorization,'Bearer fake-token');
  assert.equal(output.rows.length,1);
  assert.throws(()=>load().connectors.github.reports[0].fetch(context({config:{repositories:'https://github.com.evil.invalid/owner/repo'}})),/repository URLs/);
});

test('PostgreSQL validates a single SELECT without rejecting quoted values or comments',()=> {
  const {scope}=load();
  assert.equal(scope.dmvPostgresSql_("SELECT 'UPDATE; DROP' AS note;"),"SELECT 'UPDATE; DROP' AS note");
  assert.equal(scope.dmvPostgresSql_('WITH sample AS (SELECT 1 AS id) SELECT id FROM sample'),'WITH sample AS (SELECT 1 AS id) SELECT id FROM sample');
  assert.match(scope.dmvPostgresSql_('SELECT 1 /* DELETE FROM sales */'),/^SELECT 1/);
  for(const sql of ['DELETE FROM sales','SELECT 1; SELECT 2','WITH erased AS (DELETE FROM sales RETURNING *) SELECT * FROM erased','SELECT * INTO snapshot FROM sales','CALL unsafe()']) {
    assert.throws(()=>scope.dmvPostgresSql_(sql),/read-only|not supported|one SQL statement/);
  }
});

function jdbcFixture({rows=[['9007199254740993','0','f','1.234567890123456789',null]],failure=null}={}) {
  const events=[];
  const columns=[['id','int8'],['count','int4'],['enabled','bool'],['amount','numeric'],['missing','text']];
  let index=-1,wasNull=false;
  const metadata={getColumnCount:()=>columns.length,getColumnLabel:i=>columns[i-1][0],getColumnTypeName:i=>columns[i-1][1]};
  const result={getMetaData:()=>metadata,next:()=>++index<rows.length,
    getString(i){const value=rows[index][i-1];wasNull=value===null;return value;},wasNull:()=>wasNull,close(){events.push(['result.close']);}};
  const statement={setQueryTimeout:value=>events.push(['statement.timeout',value]),setMaxRows:value=>events.push(['statement.maxRows',value]),
    executeQuery(){events.push(['query.execute']);if(failure)throw new Error(failure);return result;},close(){events.push(['statement.close']);}};
  const setup={setQueryTimeout:value=>events.push(['setup.timeout',value]),execute:sql=>events.push(['setup.execute',sql]),close:()=>events.push(['setup.close'])};
  const connection={setReadOnly:value=>events.push(['readOnly',value]),setAutoCommit:value=>events.push(['autoCommit',value]),createStatement:()=>setup,
    prepareStatement(sql){events.push(['prepare',sql]);return statement;},rollback:()=>events.push(['rollback']),close:()=>events.push(['connection.close'])};
  const Jdbc={getConnection(url,user,password){events.push(['connect',url,user,password]);return connection;}};
  return {Jdbc,events};
}
function pgContext(overrides={}) {
  return context({credentials:{host:'db.example.com',database:'analytics',username:'reader',password:'offline-pass'},config:{query:'SELECT * FROM report'},...overrides});
}

test('PostgreSQL uses a read-only transaction, bounded SELECT, exact text decimals and cleanup',()=> {
  const {Jdbc,events}=jdbcFixture();
  const output=load({Jdbc}).connectors.postgres.reports[0].fetch(pgContext());
  assert.deepEqual(JSON.parse(JSON.stringify(output.rows[0])),{id:'9007199254740993',count:0,enabled:false,amount:'1.234567890123456789',missing:null});
  assert.match(events.find(e=>e[0]==='connect')[1],/^jdbc:postgresql:\/\/db\.example\.com:5432\/analytics\?sslmode=verify-full/);
  assert.deepEqual(events.find(e=>e[0]==='readOnly'),['readOnly',true]);
  assert.deepEqual(events.find(e=>e[0]==='autoCommit'),['autoCommit',false]);
  assert.deepEqual(events.find(e=>e[0]==='setup.execute'),['setup.execute','SET TRANSACTION READ ONLY']);
  assert.match(events.find(e=>e[0]==='prepare')[1],/LIMIT 11$/);
  assert.deepEqual(events.slice(-4).map(e=>e[0]),['result.close','statement.close','rollback','connection.close']);
});

test('PostgreSQL field discovery requests zero data rows and closes the read-only connection',()=> {
  const {Jdbc,events}=jdbcFixture();
  const fields=load({Jdbc}).connectors.postgres.reports[0].discoverFields(pgContext());
  assert.equal(fields.find(f=>f.key==='id').type,'text');
  assert.equal(fields.find(f=>f.key==='count').type,'number');
  assert.match(events.find(e=>e[0]==='prepare')[1],/LIMIT 0$/);
  assert.equal(events.at(-1)[0],'connection.close');
});

test('PostgreSQL overflow and server errors close all resources without partial reports',()=> {
  const overflow=jdbcFixture({rows:[['1','1','t','1',null],['2','2','f','2',null]]});
  assert.throws(()=>load({Jdbc:overflow.Jdbc}).connectors.postgres.reports[0].fetch(pgContext({maxRows:1})),/exceeds the row limit/);
  assert.deepEqual(overflow.events.slice(-4).map(e=>e[0]),['result.close','statement.close','rollback','connection.close']);
  const failed=jdbcFixture({failure:'internal database error with private information'});
  assert.throws(()=>load({Jdbc:failed.Jdbc}).connectors.postgres.reports[0].fetch(pgContext()),/PostgreSQL query failed/);
  assert.deepEqual(failed.events.slice(-3).map(e=>e[0]),['statement.close','rollback','connection.close']);
});

test('PostgreSQL rejects bad host, port and SQL before opening a database',()=> {
  const {connectors}=load({Jdbc:{getConnection(){throw new Error('Unexpected database access');}}});
  const report=connectors.postgres.reports[0];
  assert.throws(()=>report.fetch(pgContext({config:{query:'DROP TABLE report'}})),/read-only/);
  assert.throws(()=>report.fetch(pgContext({credentials:{host:'db.example.com/path',port:5432}})),/PostgreSQL query failed/);
  assert.throws(()=>report.fetch(pgContext({credentials:{host:'db.example.com',port:1024}})),/PostgreSQL query failed/);
});


test('PostgreSQL shared SQL guard preserves hash operators and rejects concealed second statements',()=> {
  const {scope}=load();
  for(const sql of [
    'SELECT 8 # 3 AS xor_value',
    "SELECT payload #> '{customer,address}' AS address FROM events",
    "SELECT payload #>> '{customer,name}' AS name FROM events"
  ]) assert.equal(scope.dmvPostgresSql_(sql),sql);
  assert.equal(scope.dmvPostgresSql_('SELECT 1; -- harmless trailing comment'),'SELECT 1');
  for(const sql of [
    'SELECT 1; /* comment */ DELETE FROM sales',
    'WITH erased AS (/* disguise */ DELETE FROM sales RETURNING *) SELECT * FROM erased',
    'SELECT 1; -- comment\n SELECT 2',
    'SELECT 1 /* unterminated',
    "SELECT 'unterminated",
    'SELECT (1'
  ]) assert.throws(()=>scope.dmvPostgresSql_(sql),/one SQL statement|not supported|Close SQL/);
  assert.throws(()=>scope.dmvPostgresSql_('SELECT '+ 'x'.repeat(6000)),/6,000/);
});
