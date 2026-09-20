import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function load() {
  const connectors = {};
  const scope = vm.createContext({});
  vm.runInContext(fs.readFileSync(new URL('../src/dmv_core.js', import.meta.url), 'utf8'), scope, { filename: 'dmv_core.js' });
  scope.dmvRegisterConnector_ = (connector) => { connectors[connector.id] = connector; };
  for (const name of ['dmv_connector_helpers.js', 'connectors/facebook_ads.js'])
    vm.runInContext(fs.readFileSync(new URL('../src/' + name, import.meta.url), 'utf8'), scope, { filename: name });
  return connectors.facebook_ads;
}

const plain = (value) => JSON.parse(JSON.stringify(value));
const account = { currency: 'EUR', timezone_name: 'Europe/Athens' };

function run(fields, responses, overrides = {}) {
  const calls = [];
  const queue = [account, ...responses];
  const ctx = {
    credentials: { accessToken: 'offline-token', adAccountId: 'act_123' },
    fields, config: {}, startDate: '2026-09-01', endDate: '2026-09-16', maxRows: 100,
    checkDeadline() {},
    http(request) {
      calls.push(request);
      assert.ok(queue.length, 'No unplanned HTTP calls');
      return queue.shift();
    },
    ...overrides,
  };
  const report = load().reports.find((item) => item.id === 'insights');
  const output = plain(report.fetch(ctx));
  const insights = calls.filter((call) => /\/insights\?/.test(call.url)).map((call) => new URL(call.url).searchParams);
  return { output, calls, params: insights[0] };
}

test('the deepest entity column sets the level, Date sets daily rows and breakdown columns are sent as breakdowns', () => {
  const { output, params } = run(
    ['date_start', 'campaign_name', 'adset_name', 'age', 'gender', 'spend', 'reach', 'ctr'],
    [{ data: [{ date_start: '2026-09-01', date_stop: '2026-09-01', campaign_name: 'Brand', adset_name: 'Women 25+', age: '25-34', gender: 'female', spend: '12.5', reach: '400', ctr: '2.5' }] }]
  );
  assert.equal(params.get('level'), 'adset');
  assert.equal(params.get('time_increment'), '1');
  assert.equal(params.get('breakdowns'), 'age,gender');
  assert.equal(params.get('fields'), 'date_start,date_stop,account_currency,campaign_name,adset_name,spend,reach,ctr', 'breakdown columns are not fields');
  assert.deepEqual(JSON.parse(params.get('time_range')), { since: '2026-09-01', until: '2026-09-16' });
  assert.deepEqual(output.rows, [{ date_start: '2026-09-01', campaign_name: 'Brand', adset_name: 'Women 25+', age: '25-34', gender: 'female', spend: 12.5, reach: 400, ctr: 0.025 }]);
  assert.equal(output.metadata.grain, 'Daily ad set by age, gender');
  assert.equal(output.columns.find((column) => column.key === 'reach').additive, false);
});

test('no date column gives account totals for the period, and an ad column reaches the ad level', () => {
  const totals = run(['spend', 'impressions'], [{ data: [{ spend: '40', impressions: '1000' }] }]);
  assert.equal(totals.params.get('level'), 'account');
  assert.equal(totals.params.get('time_increment'), 'all_days');
  assert.equal(totals.params.get('breakdowns'), null);
  assert.equal(totals.params.get('sort'), 'spend_descending', 'rows without a period are ranked by spend');
  assert.equal(totals.output.metadata.grain, 'Whole-period account');
  const ads = run(['month', 'ad_name', 'campaign_name', 'spend'], [{ data: [{ date_start: '2026-09-01', ad_name: 'Video A', campaign_name: 'Brand', spend: '3' }] }]);
  assert.equal(ads.params.get('level'), 'ad');
  assert.equal(ads.params.get('time_increment'), 'monthly');
  assert.equal(ads.params.get('sort'), null);
  assert.deepEqual(ads.output.rows, [{ month: '2026-09-01', ad_name: 'Video A', campaign_name: 'Brand', spend: 3 }]);
});

test('Week asks for calendar weeks from Monday, cut to the requested dates, and labels each row with its Monday', () => {
  // 2026-09-01 is a Tuesday and 2026-09-16 a Wednesday.
  const { output, params } = run(['week', 'spend'], [{ data: [
    { date_start: '2026-09-01', date_stop: '2026-09-06', spend: '1' },
    { date_start: '2026-09-07', date_stop: '2026-09-13', spend: '2' },
    { date_start: '2026-09-14', date_stop: '2026-09-16', spend: '3' },
  ] }]);
  assert.deepEqual(JSON.parse(params.get('time_ranges')), [
    { since: '2026-09-01', until: '2026-09-06' },
    { since: '2026-09-07', until: '2026-09-13' },
    { since: '2026-09-14', until: '2026-09-16' },
  ]);
  assert.equal(params.get('time_increment'), null);
  assert.equal(params.get('time_range'), null);
  assert.deepEqual(output.rows.map((row) => row.week), ['2026-08-31', '2026-09-07', '2026-09-14']);
  assert.throws(() => run(['week', 'date_start', 'spend'], []), /one of Date, Week or Month/);
  assert.throws(() => run(['week', 'spend'], [], { startDate: '2025-01-01', endDate: '2026-09-16' }), /at most 60 weeks/);
});

test('any action type is a column: counts, values and cost per action, with list metrics read as numbers', () => {
  const { output, params } = run(
    ['campaign_name', 'actions:lead', 'cost_per_action_type:lead', 'actions:offsite_conversion.fb_pixel_custom', 'action_values:offsite_conversion.fb_pixel_custom', 'cost_per_action_type:link_click', 'outbound_clicks', 'video_p25_watched_actions'],
    [{ data: [{
      campaign_name: 'Leads',
      actions: [{ action_type: 'lead', value: '4' }, { action_type: 'offsite_conversion.fb_pixel_custom', value: '2' }],
      action_values: [{ action_type: 'offsite_conversion.fb_pixel_custom', value: '80.5' }],
      cost_per_action_type: [{ action_type: 'lead', value: '3.25' }],
      outbound_clicks: [{ action_type: 'outbound_click', value: '9' }],
    }] }]
  );
  assert.equal(params.get('fields'), 'date_start,date_stop,account_currency,campaign_name,actions,cost_per_action_type,action_values,outbound_clicks,video_p25_watched_actions');
  assert.deepEqual(output.rows, [{
    campaign_name: 'Leads', 'actions:lead': 4, 'cost_per_action_type:lead': 3.25,
    'actions:offsite_conversion.fb_pixel_custom': 2, 'action_values:offsite_conversion.fb_pixel_custom': 80.5,
    'cost_per_action_type:link_click': null, outbound_clicks: 9, video_p25_watched_actions: 0,
  }]);
  assert.deepEqual(output.columns.map((column) => [column.label, column.type]), [
    ['Campaign', 'text'], ['Leads', 'number'], ['Cost per lead', 'currency'],
    ['Offsite conversion fb pixel custom', 'number'], ['Offsite conversion fb pixel custom value', 'currency'],
    ['Cost per link click', 'currency'], ['Outbound clicks', 'number'], ['Video plays at 25%', 'number'],
  ]);
  assert.throws(() => run(['actions:bad type'], []), /Unknown or unavailable report field/);
  assert.throws(() => run(['campaign_name', 'outbound_clicks'], [{ data: [{ outbound_clicks: '9' }] }]), /invalid action metric/);
});

test('a custom conversion column is headed by its name, looked up only when one is selected', () => {
  const calls = [];
  const queue = [{ data: [{ id: '777', name: 'Demo booked' }] }, account, { data: [{ actions: [{ action_type: 'offsite_conversion.custom.777', value: '5' }] }] }];
  const report = load().reports.find((item) => item.id === 'insights');
  const output = plain(report.fetch({
    credentials: { accessToken: 'offline-token', adAccountId: '123' }, fields: ['actions:offsite_conversion.custom.777'], config: {},
    startDate: '2026-09-01', endDate: '2026-09-02', maxRows: 100, checkDeadline() {},
    http(request) { calls.push(request.url); return queue.shift(); },
  }));
  assert.match(calls[0], /\/act_123\/customconversions\?fields=id,name/);
  assert.deepEqual(output.columns.map((column) => column.label), ['Demo booked']);
  assert.deepEqual(output.rows, [{ 'actions:offsite_conversion.custom.777': 5 }]);
  assert.equal(run(['spend'], [{ data: [] }]).calls.length, 2, 'no lookup without a custom conversion');
});

test('Load columns keeps the curated list first and adds every action type the account reported', () => {
  const calls = [];
  const queue = [
    { data: [{ actions: [{ action_type: 'lead', value: '1' }, { action_type: 'offsite_conversion.custom.777', value: '2' }, { action_type: 'bad type', value: '1' }], action_values: [{ action_type: 'offsite_conversion.custom.777', value: '10' }] }] },
    { data: [{ id: '777', name: 'Demo booked' }] },
  ];
  const report = load().reports.find((item) => item.id === 'insights');
  const fields = plain(report.discoverFields({ credentials: { accessToken: 'offline-token', adAccountId: '123' }, config: {}, http(request) { calls.push(request.url); return queue.shift(); } }));
  const curated = plain(report.fields);
  assert.deepEqual(fields.slice(0, curated.length), curated);
  assert.deepEqual(fields.slice(curated.length).map((field) => [field.key, field.label, field.type, field.default]), [
    ['actions:offsite_conversion.custom.777', 'Demo booked', 'number', false],
    ['action_values:offsite_conversion.custom.777', 'Demo booked value', 'currency', false],
    ['cost_per_action_type:offsite_conversion.custom.777', 'Cost per Demo booked', 'currency', false],
  ], 'Leads and its cost are curated already; lead has no value, so none is offered');
  const params = new URL(calls[0]).searchParams;
  assert.deepEqual([params.get('level'), params.get('date_preset'), params.get('fields')], ['account', 'last_90d', 'actions,action_values']);
  assert.ok(curated.filter((field) => field.default).length <= 13);
});

test('a refused request is explained in the words Meta used; token and access problems get fixed guidance', () => {
  const explain = load().errorMessage;
  const refused = explain(400, { error: { code: 100, message: '(#100) Current combination of data breakdown columns (age, country) is invalid' } });
  assert.equal(refused, 'Facebook Ads rejected the request. (#100) Current combination of data breakdown columns (age, country) is invalid. Breakdown columns combine only in the sets Meta supports.');
  assert.ok(refused.length <= 400);
  assert.ok(explain(400, { error: { code: 100, message: 'x'.repeat(2000) } }).length <= 400);
  assert.match(explain(400, { error: { code: 190, message: 'Error validating access token: secret-looking text' } }), /^Facebook Ads rejected the access token\. Generate/);
  assert.doesNotMatch(explain(400, { error: { code: 190, message: 'secret-looking text' } }), /secret-looking/);
  assert.match(explain(403, { error: { code: 200 } }), /ads_read/);
  assert.match(explain(400, { error: { code: 17 } }), /rate limiting/);
  assert.match(explain(500, { error: { code: 1 } }), /shorter date range/);
  assert.equal(explain(500, { error: { code: 12345, message: 'anything else' } }), '');
  assert.equal(explain(500, null), '');
});
