import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function load() {
  const connectors = {};
  const scope = vm.createContext({});
  vm.runInContext(fs.readFileSync(new URL('../src/dmv_core.js', import.meta.url), 'utf8'), scope, {filename:'dmv_core.js'});
  scope.dmvRegisterConnector_ = c => { connectors[c.id] = c; };
  for (const name of ['dmv_connector_helpers.js','connectors/google_ads.js','connectors/facebook_ads.js','connectors/ga4.js']) {
    vm.runInContext(fs.readFileSync(new URL('../src/' + name, import.meta.url), 'utf8'), scope, {filename:name});
  }
  return {connectors,scope};
}

function context(overrides = {}) {
  return {credentials:{accessToken:'offline-token',developerToken:'offline-developer',customerId:'123-456-7890',adAccountId:'act_123',propertyId:'123'},
    fields:[],config:{},startDate:'2026-09-01',endDate:'2026-09-02',maxRows:100,checkDeadline(){},
    http(){throw new Error('Unexpected network request');},...overrides};
}

function queue(responses) {
  const calls = [];
  const http = request => {
    calls.push(request);
    assert.ok(responses.length, 'No unplanned HTTP calls');
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return {calls,http};
}

const plain = value => JSON.parse(JSON.stringify(value));

test('marketing declarations expose small reports and Google authorization choices', () => {
  const {connectors} = load();
  assert.deepEqual(Object.keys(connectors).sort(), ['facebook_ads','ga4','google_ads']);
  for (const id of Object.keys(connectors)) {
    assert.equal(connectors[id].reports.length, id === 'google_ads' ? 20 : id === 'facebook_ads' ? 2 : 1);
    assert.ok(connectors[id].allowedHosts.length);
    for (const report of connectors[id].reports) assert.ok(report.fields.filter(f=>f.default).length <= 13);
  }
  for(const id of ['google_ads','ga4']) {
    assert.equal(connectors[id].authFields.find(f=>f.key==='authMode').default,'service_account');
    assert.ok(!connectors[id].authFields.find(f=>f.key==='authMode').options.some(o=>o.value==='native'));
    assert.ok(connectors[id].guide.modes.service_account.steps.length >= 3);
    assert.ok(connectors[id].googleScopes.length);
  }
});

for (const [id,responses,fields] of [['google_ads',[],[]],['facebook_ads',[{currency:'EUR',timezone_name:'UTC'}],[]],
  ['ga4',[metadata(),compatibility(['date'],['sessions'])],['date','sessions']]]) {
  test(`${id} stops at the shared execution deadline before paging`, () => {
    const report=load().connectors[id].reports[0];
    const {http}=queue(responses);
    assert.throws(()=>report.fetch(context({http,fields,checkDeadline(){throw new Error('time limit reached');}})),/time limit/);
  });
}

for(const id of ['google_ads','facebook_ads']) {
  test(`${id} rejects unknown fields before any request`, () => {
    const report=load().connectors[id].reports[0];
    assert.throws(()=>report.fetch(context({fields:['not_a_metric']})),/Unknown/);
  });
}

test('Google Ads pages completely, uses camelCase response fields and preserves zero, false and long IDs', () => {
  const {http,calls}=queue([
    {results:[{segments:{date:'2026-09-01'},customer:{id:'1234567890',currencyCode:'EUR',timeZone:'Europe/Athens'},
      campaign:{id:'999999999999999999',name:'One',networkSettings:{targetGoogleSearch:false}},metrics:{costMicros:'1250000',clicks:'0',conversions:'0.5'}}],nextPageToken:'two'},
    {results:[{segments:{date:'2026-09-02'},customer:{currencyCode:'EUR',timeZone:'Europe/Athens'},campaign:{id:'2'},metrics:{costMicros:'0',clicks:'2',conversions:'0'}}]}
  ]);
  const fields=['segments.date','campaign.id','metrics.cost_micros','metrics.clicks','metrics.conversions','campaign.network_settings.target_google_search'];
  const output=load().connectors.google_ads.reports[0].fetch(context({http,fields,accessToken:()=> 'native-fake'}));
  assert.equal(output.rows.length,2);
  assert.equal(output.rows[0]['campaign.id'],'999999999999999999');
  assert.equal(output.rows[0]['metrics.cost_micros'],1.25);
  assert.equal(output.rows[0]['metrics.clicks'],0);
  assert.equal(output.rows[0]['metrics.conversions'],0.5);
  assert.equal(output.rows[0]['campaign.network_settings.target_google_search'],false);
  assert.equal(output.rows[1]['metrics.cost_micros'],0);
  assert.equal(output.rows[1]['campaign.network_settings.target_google_search'],null);
  assert.equal(calls[1].body.pageToken,'two');
  assert.equal(calls[0].headers.Authorization,'Bearer native-fake');
  assert.match(calls[0].url,/v25\/customers\/1234567890\/googleAds:search$/);
  assert.match(calls[0].body.query,/segments.date BETWEEN '2026-09-01' AND '2026-09-02'/);
  assert.equal(output.metadata.currency,'EUR');
});

test('Google Ads rejects overflow, repeated tokens and provider failures without partial success', () => {
  const report=load().connectors.google_ads.reports[0];
  assert.throws(()=>report.fetch(context({http:queue([{results:[{},{}]}]).http,maxRows:1})),/row limit/);
  assert.throws(()=>report.fetch(context({http:queue([{results:[{}],nextPageToken:'same'},{results:[{}],nextPageToken:'same'}]).http})),/repeated/);
  assert.throws(()=>report.fetch(context({http:queue([new Error('Denied')]).http})),/Denied/);
  assert.equal(report.fetch(context({http:queue([{}]).http})).rows.length,0);
});

test('Google Ads field discovery filters unavailable and repeated fields and pages metadata', () => {
  const {http,calls}=queue([{results:[{name:'metrics.clicks',selectable:true},{name:'campaign.name',selectable:false}],nextPageToken:'last'},
    {results:[{name:'metrics.impressions',selectable:true,isRepeated:true},{name:'segments.device',selectable:true}]}]);
  const output=load().connectors.google_ads.reports[0].discoverFields(context({http}));
  assert.deepEqual(plain(output.map(f=>f.key)),['segments.device','metrics.clicks'].sort((a,b)=>a==='metrics.clicks'?-1:1));
  assert.match(calls[0].url,/googleAdsFields:search$/);
  assert.equal(calls[1].body.pageToken,'last');
});

test('Facebook Ads paginates by cursor without copying a credential-bearing URL', () => {
  const {http,calls}=queue([{currency:'EUR',timezone_name:'Europe/Athens'},
    {data:[{campaign_id:'999999999999999999',spend:'12.5',clicks:'0',ctr:'2.5',actions:[{action_type:'omni_purchase',value:'0'},{action_type:'purchase',value:'100'}],
      action_values:[{action_type:'omni_purchase',value:'25'}]}],paging:{cursors:{after:'second'},next:'https://graph.facebook.com/v26.0/act_123/insights?access_token=do-not-copy'}},
    {data:[{campaign_id:'2',spend:'0',clicks:'2',ctr:'0'}]}]);
  const output=load().connectors.facebook_ads.reports[0].fetch(context({http,fields:['campaign_id','spend','clicks','ctr','purchases','purchase_value','purchase_roas']}));
  assert.equal(output.rows.length,2);
  assert.equal(output.rows[0].spend,12.5);
  assert.equal(output.rows[0].clicks,0);
  assert.equal(output.rows[0].ctr,0.025);
  assert.equal(output.rows[0].purchases,0);
  assert.equal(output.rows[0].purchase_value,25);
  assert.equal(output.rows[0].purchase_roas,2);
  assert.equal(output.rows[1].purchase_roas,null);
  assert.equal(output.rows[1].purchases,0);
  assert.match(calls[2].url,/after=second/);
  assert.doesNotMatch(calls[2].url,/access_token/);
  assert.equal(new URL(calls[1].url).searchParams.get('use_unified_attribution_setting'),'true');
  assert.equal(output.metadata.currency,'EUR');
});

test('Facebook Ads handles empty data and rejects overflow, unsafe next links and malformed actions', () => {
  const report=load().connectors.facebook_ads.reports[0];
  assert.equal(report.fetch(context({http:queue([{}, {data:[]}]).http})).rows.length,0);
  assert.throws(()=>report.fetch(context({maxRows:1,http:queue([{}, {data:[{},{}]}]).http})),/row limit/);
  assert.throws(()=>report.fetch(context({http:queue([{}, {data:[{}],paging:{next:'https://evil.invalid/',cursors:{after:'x'}}}]).http})),/unsafe/);
  assert.throws(()=>report.fetch(context({http:queue([{}, {data:[{actions:{}}]}]).http})),/invalid action/);
  assert.throws(()=>report.fetch(context({http:queue([{}, {data:[{}],paging:{next:'https://graph.facebook.com/x'}}]).http})),/cursor/);
});

function metadata() {
  return {dimensions:[{apiName:'date',uiName:'Date'},{apiName:'sessionSource',uiName:'Session source'},{apiName:'customEvent:segment',uiName:'Custom segment',customDefinition:true}],
    metrics:[{apiName:'sessions',uiName:'Sessions',type:'TYPE_INTEGER'},{apiName:'totalRevenue',uiName:'Total revenue',type:'TYPE_CURRENCY'},
      {apiName:'blockedRevenue',type:'TYPE_CURRENCY',blockedReasons:['NO_REVENUE_METRICS']}]};
}
function compatibility(dimensions=['date'],metrics=['sessions']) {
  return {dimensionCompatibilities:dimensions.map(apiName=>({compatibility:'COMPATIBLE',dimensionMetadata:{apiName}})),
    metricCompatibilities:metrics.map(apiName=>({compatibility:'COMPATIBLE',metricMetadata:{apiName}}))};
}
function gaPage(values,count=2) {
  return {rowCount:count,dimensionHeaders:[{name:'date'}],metricHeaders:[{name:'sessions'},{name:'totalRevenue'}],
    rows:values.map(([date,sessions,revenue])=>({dimensionValues:[{value:date}],metricValues:[{value:sessions},{value:revenue}]})),
    metadata:{currencyCode:'EUR',timeZone:'Europe/Athens'}};
}

test('GA4 discovers custom property fields and excludes blocked metrics', () => {
  const output=load().connectors.ga4.reports[0].discoverFields(context({http:queue([metadata()]).http}));
  assert.equal(output.find(f=>f.key==='customEvent:segment').custom,true);
  assert.equal(output.find(f=>f.key==='totalRevenue').type,'currency');
  assert.equal(output.find(f=>f.key==='blockedRevenue'),undefined);
});

test('GA4 groups dimensions and metrics, checks compatibility, and reads every offset page', () => {
  const pages=[gaPage([['20260901','0','12.25']]),gaPage([['20260902','2','0']])];
  for(const page of pages) { page.metricHeaders.reverse(); page.rows.forEach(row=>row.metricValues.reverse()); }
  const {http,calls}=queue([metadata(),compatibility(['date'],['sessions','totalRevenue']),...pages]);
  const output=load().connectors.ga4.reports[0].fetch(context({http,fields:['totalRevenue','date','sessions']}));
  assert.deepEqual(plain(output.columns.map(f=>f.key)),['totalRevenue','date','sessions']);
  assert.equal(output.rows[0].date,'2026-09-01');
  assert.equal(output.rows[0].sessions,0);
  // The API returns metric columns in the requested order, not a fixed preset order.
  assert.equal(calls[2].body.metrics[0].name,'totalRevenue');
  assert.equal(calls[3].body.offset,'1');
  assert.equal(output.rows[0].totalRevenue,12.25);
  assert.equal(output.rows[1].totalRevenue,0);
  assert.equal(output.metadata.currency,'EUR');
});

test('GA4 numeric fields and custom dimensions follow metadata rather than name guessing', () => {
  const {http,calls}=queue([metadata(),compatibility(['customEvent:segment'],['sessions']),{rowCount:1,
    dimensionHeaders:[{name:'customEvent:segment'}],metricHeaders:[{name:'sessions'}],
    rows:[{dimensionValues:[{value:'0'}],metricValues:[{value:'0'}]}],metadata:{timeZone:'UTC'}}]);
  const output=load().connectors.ga4.reports[0].fetch(context({http,fields:['customEvent:segment','sessions']}));
  assert.equal(output.rows[0]['customEvent:segment'],'0');
  assert.equal(output.rows[0].sessions,0);
  assert.equal(calls.length,3);
});

test('GA4 fails before report calls for invalid, unknown, blocked, or incompatible fields', () => {
  const report=load().connectors.ga4.reports[0];
  assert.throws(()=>report.fetch(context({fields:['sessions; DROP']})),/valid GA4/);
  for(const key of ['notReal','blockedRevenue']) {
    const {http,calls}=queue([metadata()]);
    assert.throws(()=>report.fetch(context({http,fields:[key]})),/Unknown/);
    assert.equal(calls.length,1);
  }
  const {http,calls}=queue([metadata(),compatibility([],[])]);
  assert.throws(()=>report.fetch(context({http,fields:['date','sessions']})),/cannot be combined/);
  assert.equal(calls.length,2);
});

test('GA4 handles zero rows and rejects overflow, incomplete pages, changed counts and quality loss', () => {
  const report=load().connectors.ga4.reports[0], fields=['date','sessions','totalRevenue'];
  const prefix=()=>[metadata(),compatibility(['date'],['sessions','totalRevenue'])];
  assert.equal(report.fetch(context({fields,http:queue([...prefix(),gaPage([],0)]).http})).rows.length,0);
  assert.throws(()=>report.fetch(context({fields,maxRows:1,http:queue([...prefix(),gaPage([['20260901','1','1']],2)]).http})),/row limit/);
  assert.throws(()=>report.fetch(context({fields,http:queue([...prefix(),gaPage([],2)]).http})),/incomplete/);
  assert.throws(()=>report.fetch(context({fields,http:queue([...prefix(),gaPage([['20260901','1','1']],2),gaPage([],3)]).http})),/changed/);
  const lossy=gaPage([['20260901','1','1']],1);lossy.metadata.dataLossFromOtherRow=true;
  assert.throws(()=>report.fetch(context({fields,http:queue([...prefix(),lossy]).http})),/other row/);
});


test('bounded connection probes verify account access without fetching report data', () => {
  const {connectors}=load();
  const ads=queue([{results:[{customer:{id:'1234567890'}}]}]);
  connectors.google_ads.test(context({http:ads.http}));
  assert.match(ads.calls[0].body.query,/FROM customer LIMIT 1$/);
  assert.equal(ads.calls[0].retrySafe,true);
  const meta=queue([{account_id:'123'}]);
  connectors.facebook_ads.test(context({http:meta.http}));
  assert.match(meta.calls[0].url,/fields=account_id$/);
  const analytics=queue([metadata()]);
  connectors.ga4.test(context({http:analytics.http}));
  assert.match(analytics.calls[0].url,/\/metadata$/);
  assert.throws(()=>connectors.facebook_ads.test(context({http:queue([{account_id:'wrong'}]).http})),/requested account/);
});

test('GA4 accepts an omitted zero row count but rejects malformed metric values', () => {
  const report=load().connectors.ga4.reports[0];
  const fields=['date','sessions'];
  const empty=queue([metadata(),compatibility(),{metadata:{timeZone:'UTC'}}]);
  assert.equal(report.fetch(context({http:empty.http,fields})).rows.length,0);
  const invalid=queue([metadata(),compatibility(),{rowCount:1,dimensionHeaders:[{name:'date'}],metricHeaders:[{name:'sessions'}],rows:[{dimensionValues:[{value:'20260901'}],metricValues:[{value:'unknown'}]}]}]);
  assert.throws(()=>report.fetch(context({http:invalid.http,fields})),/numeric/);
});

test('GA4 continuation serializes one page and resumes with fresh authorization without repeating discovery', () => {
  const fields=['date','sessions','totalRevenue'];
  const firstCalls=queue([metadata(),compatibility(['date'],['sessions','totalRevenue']),gaPage([['20260901','0','12.25']])]);
  const first=load().connectors.ga4.reports[0].fetchChunk(context({fields,http:firstCalls.http,accessToken:()=> 'first-secret-token'}),null);
  assert.equal(firstCalls.calls.length,3);
  assert.equal(first.rows.length,1);
  assert.equal(first.metadata.complete,false);
  assert.equal(first.nextState.offset,1);
  assert.equal(first.nextState.expected,2);
  assert.equal(first.nextState.pages,1);
  const serialized=JSON.stringify(first.nextState);
  assert.doesNotMatch(serialized,/first-secret-token|Authorization|accessToken|credentials/);
  const resumedCalls=queue([gaPage([['20260902','2','0']])]);
  const saved=JSON.parse(serialized);
  const last=load().connectors.ga4.reports[0].fetchChunk(context({fields,http:resumedCalls.http,accessToken:()=> 'new-secret-token'}),saved);
  assert.equal(resumedCalls.calls.length,1);
  assert.match(resumedCalls.calls[0].url,/:runReport$/);
  assert.equal(resumedCalls.calls[0].headers.Authorization,'Bearer new-secret-token');
  assert.equal(resumedCalls.calls[0].body.offset,'1');
  assert.deepEqual(plain(resumedCalls.calls[0].body),{...plain(firstCalls.calls[2].body),offset:'1'});
  assert.equal(last.rows.length,1);
  assert.equal(last.rows[0].totalRevenue,0);
  assert.equal(last.metadata.complete,true);
  assert.equal(last.nextState,null);
  assert.deepEqual(plain(last.columns),plain(first.columns));
  assert.equal(JSON.stringify(saved),serialized);
});

test('GA4 continuation rejects changing totals, metadata, report settings, and lossy later pages', () => {
  const fields=['date','sessions','totalRevenue'];
  const report=load().connectors.ga4.reports[0];
  const initial=report.fetchChunk(context({fields,http:queue([metadata(),compatibility(['date'],['sessions','totalRevenue']),gaPage([['20260901','1','1']])]).http}),null);
  const state=plain(initial.nextState);
  const changedCount=gaPage([['20260902','2','0']],3);
  const changedCurrency=gaPage([['20260902','2','0']]); changedCurrency.metadata.currencyCode='USD';
  const changedZone=gaPage([['20260902','2','0']]); changedZone.metadata.timeZone='UTC';
  const sampled=gaPage([['20260902','2','0']]); sampled.metadata.samplingMetadatas=[{samplesReadCount:'1',samplingSpaceSize:'2'}];
  for (const [page,error] of [[changedCount,/changed/],[changedCurrency,/metadata changed/],[changedZone,/metadata changed/],[sampled,/sampled/],[gaPage([],2),/incomplete/]]) {
    assert.throws(()=>report.fetchChunk(context({fields,http:queue([page]).http}),state),error);
  }
  for (const changes of [{startDate:'2026-08-01'},{maxRows:200},{fields:['sessions','date','totalRevenue']},{credentials:{accessToken:'offline-token',propertyId:'456'}}]) {
    assert.throws(()=>report.fetchChunk(context({fields,...changes}),state),/continuation no longer matches/);
  }
  assert.throws(()=>report.fetchChunk(context({fields}),{...state,pages:100}),/too many pages/);
});
