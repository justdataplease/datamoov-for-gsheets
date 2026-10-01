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
// The row ceiling that Keep the top rows writes out as its literal max.
const ceiling = (() => {
  const scope = vm.createContext({});
  vm.runInContext(fs.readFileSync(new URL('../src/dmv_core.js', import.meta.url), 'utf8'), scope, { filename: 'dmv_core.js' });
  return scope.DMV_LIMITS.maxRows;
})();

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

test('Keep the top rows asks Meta for its ranking, stops paging once the top is in and says when the list was cut', () => {
  const connector = load();
  const report = connector.reports.find((item) => item.id === 'insights');
  assert.deepEqual(plain(report.configFields).map((field) => field.key), ['purchaseActionType', 'top']);
  const top = plain(report.configFields).find((field) => field.key === 'top');
  assert.deepEqual([top.label, top.type, top.required, top.min, top.max], ['Keep the top rows', 'number', false, 1, ceiling]);
  assert.equal(top.help, 'Ranks rows by spend (impressions without spend) and keeps this many. Blank keeps every row up to the row limit.');
  assert.match(report.description, /none gives totals ranked by spend, and Keep the top rows keeps only the top of them/);
  // The original campaign report is always daily: nothing to keep the top of.
  assert.deepEqual(plain(connector.reports.find((item) => item.id === 'campaign_daily').configFields).map((field) => field.key), ['purchaseActionType']);

  const campaigns = (from, count) => Array.from({ length: count }, (_, index) => ({ campaign_name: `C${from + index}`, spend: String(5000 - from - index), impressions: String(from + index) }));
  const next = (after) => ({ cursors: { after }, next: `https://graph.facebook.com/v26.0/act_123/insights?after=${after}` });
  const cursors = (calls) => calls.filter((call) => /\/insights\?/.test(call.url)).map((call) => new URL(call.url).searchParams.get('after'));

  // One page holds the top: Meta ranks, the page asks for no more and the next cursor is not followed.
  const cut = run(['campaign_name', 'spend'], [{ data: campaigns(0, 2), paging: next('p2') }], { config: { top: 2 } });
  assert.deepEqual(['sort', 'limit', 'level', 'time_increment'].map((key) => cut.params.get(key)), ['spend_descending', '2', 'campaign', 'all_days']);
  assert.deepEqual(cursors(cut.calls), [null]);
  assert.deepEqual(cut.output.rows, [{ campaign_name: 'C0', spend: 5000 }, { campaign_name: 'C1', spend: 4999 }]);
  assert.deepEqual([cut.output.metadata.topRows, cut.output.metadata.note], [2, 'Top 2 by spend']);
  assert.equal(cut.output.metadata.grain, 'Whole-period campaign');

  // A top over several pages keeps full pages, takes what it still needs from the last one and stops.
  const paged = run(['campaign_name', 'spend'], [{ data: campaigns(0, 500), paging: next('p2') }, { data: campaigns(500, 500), paging: next('p3') }], { config: { top: '700' }, maxRows: 1000 });
  assert.equal(paged.params.get('limit'), '500');
  assert.deepEqual(cursors(paged.calls), [null, 'p2'], 'the third page is never asked for');
  assert.equal(paged.output.rows.length, 700);
  assert.deepEqual(paged.output.rows[699], { campaign_name: 'C699', spend: 4301 });
  assert.deepEqual([paged.output.metadata.topRows, paged.output.metadata.note], [700, 'Top 700 by spend']);

  // Without spend a top ranks by impressions, across breakdowns too.
  const reach = run(['ad_name', 'country', 'impressions'], [{ data: [{ ad_name: 'A', country: 'GR', impressions: '900' }, { ad_name: 'B', country: 'DE', impressions: '40' }] }], { config: { top: 2 } });
  assert.deepEqual(['sort', 'level', 'breakdowns'].map((key) => reach.params.get(key)), ['impressions_descending', 'ad', 'country']);
  assert.deepEqual([reach.output.metadata.topRows, reach.output.metadata.note], [2, 'Top 2 by impressions']);

  // Fewer rows than asked for are the whole list: never labelled.
  const whole = run(['campaign_name', 'spend', 'impressions'], [{ data: campaigns(0, 3) }], { config: { top: 5 } });
  assert.deepEqual(['sort', 'limit'].map((key) => whole.params.get(key)), ['spend_descending', '5']);
  assert.equal(whole.output.rows.length, 3);
  assert.deepEqual([whole.output.metadata.topRows, whole.output.metadata.note], [undefined, undefined]);

  // Blank keeps every row as before: ranked by spend when selected, failing over the row limit.
  const blank = run(['campaign_name', 'spend'], [{ data: campaigns(0, 3) }], { config: { top: '' } });
  assert.deepEqual(['sort', 'limit'].map((key) => blank.params.get(key)), ['spend_descending', '101']);
  assert.deepEqual([blank.output.rows.length, blank.output.metadata.topRows, blank.output.metadata.note], [3, undefined, undefined]);
  assert.equal(run(['campaign_name', 'impressions'], [{ data: [] }]).params.get('sort'), null);
  assert.throws(() => run(['campaign_name', 'spend'], [{ data: campaigns(0, 101) }]), /exceeds the row limit/);

  // Refusals come before any request: a malformed top, a period column (a trend needs every row),
  // nothing to rank by, then a top above the row limit, naming both settings.
  let requests = 0;
  const refuse = (fields, value, pattern) =>
    assert.throws(() => run(fields, [], { config: { top: value }, http() { requests++; return account; } }), pattern, `${fields} ${value}`);
  for (const value of [0, 1.5, 'many', 30001]) refuse(['campaign_name', 'spend'], value, /^Error: Keep the top rows must be a whole number from 1 to 30,000, or blank for every row\.$/);
  for (const [key, label] of [['date_start', 'Date'], ['week', 'Week'], ['month', 'Month'], ['hourly_stats_aggregated_by_advertiser_time_zone', 'Hour of day']])
    refuse(['campaign_name', key, 'spend'], 5, new RegExp(`^Error: Keep the top rows ranks totals for the date range, so it cannot be combined with ${label}\\. Remove ${label} or clear Keep the top rows\\.$`));
  refuse(['campaign_name', 'clicks'], 5, /^Error: Keep the top rows ranks by spend or impressions\. Select one of them\.$/);
  refuse(['campaign_name', 'spend'], 101, /^Error: Keep the top rows \(101\) is above this report's row limit \(100\)\. Lower it or raise the row limit\.$/);
  assert.equal(requests, 0, 'nothing was requested');
  // The hour of day without a top still ranks by spend, as before.
  assert.equal(run(['hourly_stats_aggregated_by_advertiser_time_zone', 'spend'], [{ data: [] }]).params.get('sort'), 'spend_descending');
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
