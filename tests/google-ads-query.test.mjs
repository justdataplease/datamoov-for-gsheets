import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function load() {
  const connectors = {};
  const scope = vm.createContext({});
  vm.runInContext(fs.readFileSync(new URL('../src/dmv_core.js', import.meta.url), 'utf8'), scope, { filename: 'dmv_core.js' });
  scope.dmvRegisterConnector_ = (connector) => { connectors[connector.id] = connector; };
  for (const name of ['dmv_connector_helpers.js', 'connectors/google_ads.js'])
    vm.runInContext(fs.readFileSync(new URL('../src/' + name, import.meta.url), 'utf8'), scope, { filename: name });
  return connectors.google_ads.reports.find((report) => report.id === (load.report || 'custom_query'));
}

function context(gaql, responses, overrides = {}) {
  const calls = [];
  return {
    calls,
    credentials: { accessToken: 'offline-token', customerId: '123-456-7890' },
    fields: [],
    config: { gaql },
    startDate: '2026-06-22',
    endDate: '2026-09-19',
    maxRows: 100,
    checkDeadline() {},
    http(request) {
      calls.push(request);
      assert.ok(responses.length, 'No unplanned HTTP calls');
      return responses.shift();
    },
    ...overrides,
  };
}

const plain = (value) => JSON.parse(JSON.stringify(value));

test('a custom query reaches ad groups, applies the report dates and types money, rates and counts', () => {
  const report = load();
  assert.equal(report.dateRange, true);
  assert.equal(report.fields.length, 0);
  const ctx = context(
    `SELECT ad_group.name, campaign.name, metrics.cost_micros, metrics.clicks, metrics.ctr, metrics.average_cpc
       FROM ad_group WHERE campaign.status = 'ENABLED' ORDER BY metrics.cost_micros DESC LIMIT 50`,
    [
      { results: [{ adGroup: { name: 'Shoes' }, campaign: { name: 'Brand' }, metrics: { costMicros: '12500000', clicks: '40', ctr: 0.05, averageCpc: 312500 } }] },
      { results: [{ customer: { currencyCode: 'AED', timeZone: 'Asia/Dubai' } }] },
    ]
  );
  const result = plain(report.fetch(ctx));
  assert.equal(ctx.calls[0].url, 'https://googleads.googleapis.com/v25/customers/1234567890/googleAds:search');
  assert.equal(
    ctx.calls[0].body.query,
    "SELECT ad_group.name, campaign.name, metrics.cost_micros, metrics.clicks, metrics.ctr, metrics.average_cpc FROM ad_group WHERE campaign.status = 'ENABLED' AND segments.date BETWEEN '2026-06-22' AND '2026-09-19' ORDER BY metrics.cost_micros DESC LIMIT 50"
  );
  assert.deepEqual(result.columns.map((column) => [column.key, column.label, column.type]), [
    ['ad_group.name', 'Ad group name', 'text'],
    ['campaign.name', 'Campaign', 'text'],
    ['metrics.cost_micros', 'Spend', 'currency'],
    ['metrics.clicks', 'Clicks', 'number'],
    ['metrics.ctr', 'CTR', 'percent'],
    ['metrics.average_cpc', 'Average CPC', 'currency'],
  ]);
  assert.deepEqual(result.rows, [{ 'ad_group.name': 'Shoes', 'campaign.name': 'Brand', 'metrics.cost_micros': 12.5, 'metrics.clicks': 40, 'metrics.ctr': 0.05, 'metrics.average_cpc': 0.3125 }]);
  assert.equal(result.metadata.currency, 'AED');
  assert.equal(result.metadata.complete, true);
});

test('negative keywords have no period: no date filter and no currency lookup are added', () => {
  const ctx = context(
    'SELECT campaign.name, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type FROM campaign_criterion WHERE campaign_criterion.negative = TRUE',
    [{ results: [{ campaign: { name: 'Brand' }, campaignCriterion: { keyword: { text: 'free', matchType: 'BROAD' } } }] }]
  );
  const result = plain(load().fetch(ctx));
  assert.equal(ctx.calls.length, 1);
  assert.ok(!ctx.calls[0].body.query.includes('segments.date'));
  assert.deepEqual(result.rows, [{ 'campaign.name': 'Brand', 'campaign_criterion.keyword.text': 'free', 'campaign_criterion.keyword.match_type': 'BROAD' }]);
  assert.equal(result.columns[1].label, 'Campaign criterion keyword text');
});

test('a query that filters dates itself keeps them, unknown metrics get honest types, and lists stay readable', () => {
  const ctx = context(
    "SELECT segments.month, metrics.search_impression_share, metrics.cost_per_conversion, ad_group_ad.ad.final_urls FROM ad_group_ad WHERE segments.date DURING LAST_MONTH",
    [
      { results: [{ segments: { month: '2026-08-01' }, metrics: { searchImpressionShare: 0.42, costPerConversion: 2500000 }, adGroupAd: { ad: { finalUrls: ['https://example.com/a'] } } }] },
      { results: [{ customer: { currencyCode: 'EUR' } }] },
    ]
  );
  const result = plain(load().fetch(ctx));
  assert.match(ctx.calls[0].body.query, /WHERE segments\.date DURING LAST_MONTH LIMIT 101$/, 'one row past the limit is enough to notice an oversized report');
  const [month, share, cost, urls] = result.columns;
  assert.deepEqual([month.type, share.type, share.additive, cost.type, cost.additive, urls.type], ['date', 'percent', false, 'currency', false, 'text']);
  assert.deepEqual(result.rows[0], { 'segments.month': '2026-08-01', 'metrics.search_impression_share': 0.42, 'metrics.cost_per_conversion': 2.5, 'ad_group_ad.ad.final_urls': '["https://example.com/a"]' });
});

test('only a single well-formed SELECT is sent, and oversize results fail instead of truncating', () => {
  const report = load();
  for (const gaql of ['', 'DELETE FROM campaign', 'SELECT campaign.name FROM campaign; SELECT 1', 'SELECT * FROM campaign', 'SELECT campaign.name, campaign.name FROM campaign', 'SELECT name FROM campaign', 'SELECT campaign.name'])
    assert.throws(() => report.fetch(context(gaql, [])), /GAQL/);
  const many = { results: Array.from({ length: 101 }, (_, index) => ({ campaign: { name: 'C' + index } })) };
  assert.throws(() => report.fetch(context('SELECT campaign.name FROM campaign', [many])), /row limit/);
});

test('discovery lists resources, then the attributes, metrics and segments one resource supports', () => {
  const report = load();
  const resources = context('resources', [{ results: [{ name: 'ad_group' }, { name: 'keyword_view' }] }]);
  assert.deepEqual(plain(report.discoverFields(resources)).map((field) => field.key), ['ad_group', 'keyword_view']);
  assert.equal(resources.calls[0].url, 'https://googleads.googleapis.com/v25/googleAdsFields:search');
  assert.equal(resources.calls[0].body.query, "SELECT name WHERE category = 'RESOURCE'");

  const fields = context('FROM keyword_view', [
    { results: [{ name: 'keyword_view', selectableWith: ['metrics.clicks', 'metrics.cost_micros', 'segments.date', 'ad_group', 'campaign'], attributeResources: ['ad_group', 'ad_group_criterion'] }] },
    { results: [{ name: 'keyword_view.resource_name', selectable: true }, { name: 'keyword_view.internal', selectable: false }] },
    { results: [{ name: 'ad_group.name', selectable: true }] },
  ]);
  assert.deepEqual(plain(report.discoverFields(fields)).map((field) => [field.key, field.type]), [
    ['keyword_view.resource_name', 'text'],
    ['ad_group.name', 'text'],
    ['metrics.clicks', 'number'],
    ['metrics.cost_micros', 'currency'],
    ['segments.date', 'date'],
  ]);
  assert.deepEqual(fields.calls.map((call) => call.body.query), [
    "SELECT name, selectable_with, attribute_resources WHERE name = 'keyword_view'",
    "SELECT name, selectable, is_repeated WHERE name LIKE 'keyword_view.%'",
    "SELECT name, selectable, is_repeated WHERE name LIKE 'ad_group.%'",
  ], 'parent attributes come only from the parents worth listing');
  assert.throws(() => report.discoverFields(context('FROM nothing_here', [{ results: [] }])), /no resource named nothing_here/);

  // The report form's Load columns lists the columns of a complete query, without a request.
  const own = context('SELECT campaign.name, metrics.clicks FROM campaign', []);
  assert.deepEqual(plain(report.discoverFields(own)).map((field) => [field.key, field.default]), [['campaign.name', true], ['metrics.clicks', true]]);
});

const level = (id) => {
  load.report = id;
  try {
    return load();
  } finally {
    load.report = null;
  }
};

test('every report level is a plain dimension-and-metric picker over one Google Ads resource', () => {
  const keyword = level('keyword');
  assert.equal(keyword.label, 'Keyword performance');
  assert.equal(keyword.chat, false, 'chat reaches every level through the custom query instead');
  const fields = plain(keyword.fields);
  assert.deepEqual(fields.filter((field) => field.default).map((field) => field.label), ['Campaign', 'Ad group', 'Keyword', 'Match type', 'Impressions', 'Clicks', 'Spend', 'Conversions']);
  assert.ok(['segments.date', 'segments.week', 'segments.month', 'segments.device'].every((key) => fields.some((field) => field.key === key && !field.default)));
  const quality = fields.find((field) => field.key === 'ad_group_criterion.quality_info.quality_score');
  assert.deepEqual([quality.label, quality.type, quality.additive], ['Quality score', 'number', false]);

  const ctx = context(undefined, [
    { results: [{ campaign: { name: 'Brand' }, adGroupCriterion: { keyword: { text: 'shoes', matchType: 'EXACT' } }, metrics: { clicks: '7', costMicros: '3500000' } }] },
    { results: [{ customer: { currencyCode: 'EUR' } }] },
  ], { fields: ['campaign.name', 'ad_group_criterion.keyword.text', 'ad_group_criterion.keyword.match_type', 'metrics.clicks', 'metrics.cost_micros'], config: {} });
  const result = plain(keyword.fetch(ctx));
  assert.equal(ctx.calls[0].body.query, "SELECT campaign.name, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, metrics.clicks, metrics.cost_micros FROM keyword_view WHERE metrics.impressions > 0 AND segments.date BETWEEN '2026-06-22' AND '2026-09-19' ORDER BY metrics.cost_micros DESC LIMIT 100", 'a ranking keeps its top rows by spend');
  assert.deepEqual(result.columns.map((column) => column.label), ['Campaign', 'Keyword', 'Match type', 'Clicks', 'Spend']);
  assert.deepEqual(result.rows, [{ 'campaign.name': 'Brand', 'ad_group_criterion.keyword.text': 'shoes', 'ad_group_criterion.keyword.match_type': 'EXACT', 'metrics.clicks': 7, 'metrics.cost_micros': 3.5 }]);
  assert.equal(result.metadata.grain, 'Keyword performance');
});

test('dated levels order by date, lists have no period, and conversions by action avoid the metrics Google forbids', () => {
  const daily = context(undefined, [{ results: [] }, { results: [{ customer: { currencyCode: 'EUR' } }] }], { fields: [], config: {} });
  level('account').fetch(daily);
  assert.equal(daily.calls[0].body.query, "SELECT segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM customer WHERE metrics.impressions > 0 AND segments.date BETWEEN '2026-06-22' AND '2026-09-19' ORDER BY segments.date LIMIT 101", 'a trend needs every row, so it fails over the limit instead');

  const negatives = level('negative_keyword');
  assert.equal(negatives.dateRange, false);
  assert.ok(!plain(negatives.fields).some((field) => /^(metrics|segments)\./.test(field.key)));
  const list = context(undefined, [{ results: [] }], { fields: [], config: {} });
  negatives.fetch(list);
  assert.equal(list.calls[0].body.query, "SELECT campaign.name, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type FROM campaign_criterion WHERE campaign_criterion.negative = TRUE AND campaign_criterion.type = 'KEYWORD' LIMIT 101");

  const actions = level('conversion_action');
  // Conversion value is money, so the account currency is looked up as well.
  const split = context(undefined, [{ results: [] }, { results: [{ customer: { currencyCode: 'EUR' } }] }], { fields: [], config: {} });
  actions.fetch(split);
  assert.equal(split.calls[0].body.query, "SELECT campaign.name, segments.conversion_action_name, metrics.conversions, metrics.conversions_value FROM campaign WHERE segments.date BETWEEN '2026-06-22' AND '2026-09-19' LIMIT 101");
  assert.ok(!plain(actions.fields).some((field) => ['metrics.clicks', 'metrics.impressions', 'metrics.cost_micros'].includes(field.key)));
});

test('Load columns on a level keeps the starting set first and adds everything else Google offers, unselected', () => {
  const adGroup = level('ad_group');
  const ctx = context(undefined, [
    { results: [{ name: 'ad_group', selectableWith: ['metrics.clicks', 'metrics.search_impression_share', 'segments.hour'], attributeResources: ['campaign', 'customer'] }] },
    { results: [{ name: 'ad_group.name', selectable: true }, { name: 'ad_group.cpc_bid_micros', selectable: true }] },
    { results: [{ name: 'campaign.name', selectable: true }, { name: 'campaign.start_date', selectable: true }] },
    { results: [{ name: 'customer.descriptive_name', selectable: true }] },
  ], { fields: [], config: {} });
  const fields = plain(adGroup.discoverFields(ctx));
  const curated = plain(adGroup.fields).length;
  assert.deepEqual(fields.slice(0, curated).map((field) => field.key), plain(adGroup.fields).map((field) => field.key));
  assert.deepEqual(fields.slice(curated).map((field) => [field.key, field.type, field.default]), [
    ['ad_group.cpc_bid_micros', 'currency', false],
    ['campaign.start_date', 'text', false],
    ['customer.descriptive_name', 'text', false],
    ['metrics.search_impression_share', 'percent', false],
    ['segments.hour', 'text', false],
  ]);
});

test('metrics Google rejects at a level are offered neither in its starting set nor by Load columns', () => {
  const shopping = level('shopping');
  const skipped = ['metrics.average_cpm', 'metrics.interactions', 'metrics.view_through_conversions'];
  assert.ok(!plain(shopping.fields).some((field) => skipped.includes(field.key)));
  const ctx = context(undefined, [
    { results: [{ name: 'shopping_performance_view', selectableWith: ['metrics.average_cpm', 'metrics.interactions', 'metrics.search_impression_share'], attributeResources: [] }] },
    { results: [] },
  ], { fields: [], config: {} });
  const added = plain(shopping.discoverFields(ctx)).slice(plain(shopping.fields).length).map((field) => field.key);
  assert.deepEqual(added, ['metrics.search_impression_share']);
});
