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
  assert.equal(result.metadata.topRows, undefined, 'one row under LIMIT 50 is the whole list');
  assert.equal(result.metadata.note, undefined);
});

test('a custom query that reaches its own LIMIT says it holds the top rows, by its ORDER BY', () => {
  const report = load();
  const rows = (count) => ({ results: Array.from({ length: count }, (_, index) => ({ campaign: { name: 'C' + index }, metrics: { costMicros: '1000000', ctr: 0.01 } })) });
  const run = (gaql, count, overrides) => {
    const ctx = context(gaql, [rows(count), { results: [{ customer: { currencyCode: 'EUR' } }] }], overrides);
    return { ctx, metadata: plain(report.fetch(ctx).metadata) };
  };
  const spend = 'SELECT campaign.name, metrics.cost_micros FROM campaign ORDER BY metrics.cost_micros DESC LIMIT 3';
  const top = run(spend, 3).metadata;
  assert.deepEqual([top.topRows, top.note], [3, 'Top 3 by spend']);
  const whole = run(spend, 2).metadata;
  assert.deepEqual([whole.topRows, whole.note], [undefined, undefined], 'fewer rows than the LIMIT are the whole list');

  // A column label the caller gave is the one named; ascending orders say which end they keep.
  assert.equal(run(spend, 3, { labels: { 'metrics.cost_micros': 'Cost' } }).metadata.note, 'Top 3 by cost');
  assert.equal(run('SELECT campaign.name, metrics.ctr FROM campaign ORDER BY metrics.ctr ASC LIMIT 3', 3).metadata.note, 'Lowest 3 by CTR');
  assert.equal(run('SELECT campaign.name, metrics.cost_micros FROM campaign ORDER BY campaign.name, metrics.cost_micros DESC LIMIT 3', 3).metadata.note, 'First 3 by campaign');
  const first = run('SELECT campaign.name, metrics.cost_micros FROM campaign LIMIT 3', 3).metadata;
  assert.deepEqual([first.topRows, first.note], [3, 'First 3 rows (query LIMIT)']);

  // A LIMIT above the row limit is cut to one row past it, so a full page is still the whole list.
  const large = run('SELECT campaign.name, metrics.cost_micros FROM campaign ORDER BY metrics.cost_micros DESC LIMIT 500', 100);
  assert.match(large.ctx.calls[0].body.query, / LIMIT 101$/);
  assert.equal(large.metadata.topRows, undefined);
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

test('asset performance and keyword quality pass the guard with readable labels, enums as text and scores never summed', () => {
  const report = load();
  // The description names the resources and how a list keeps its top rows, so chat builds these
  // sections instead of describing them; the keyword and ad asset reports list their fields.
  for (const name of ['ad_group_ad_asset_view', 'keyword_view', 'search_term_view', 'group_placement_view', 'ORDER BY metrics.cost_micros DESC LIMIT n'])
    assert.ok(report.description.includes(name), name);
  for (const [id, names] of [
    ['ad_asset', ['ad_group_ad_asset_view.performance_label', 'ad_group_ad_asset_view.field_type', 'asset.text_asset.text']],
    ['keyword', ['ad_group_criterion.quality_info.quality_score', 'ad_group_criterion.keyword.match_type']],
  ]) {
    load.report = id;
    const typed = load();
    load.report = null;
    assert.equal(typed.chat, true, id);
    for (const name of names) assert.ok(typed.fields.some((field) => field.key === name), name);
  }

  const assets = context(
    'SELECT campaign.name, ad_group_ad_asset_view.field_type, ad_group_ad_asset_view.performance_label, asset.text_asset.text, asset.name, metrics.impressions, metrics.conversions, metrics.cost_micros FROM ad_group_ad_asset_view',
    [
      { results: [{ campaign: { name: 'Brand' }, adGroupAdAssetView: { fieldType: 'HEADLINE', performanceLabel: 'BEST' }, asset: { textAsset: { text: 'Stay a month' } }, metrics: { impressions: '900', conversions: 4.5, costMicros: '20000000' } }] },
      { results: [{ customer: { currencyCode: 'USD' } }] },
    ]
  );
  const asset = plain(report.fetch(assets));
  assert.equal(
    assets.calls[0].body.query,
    "SELECT campaign.name, ad_group_ad_asset_view.field_type, ad_group_ad_asset_view.performance_label, asset.text_asset.text, asset.name, metrics.impressions, metrics.conversions, metrics.cost_micros FROM ad_group_ad_asset_view WHERE segments.date BETWEEN '2026-06-22' AND '2026-09-19' LIMIT 101"
  );
  assert.deepEqual(asset.columns.slice(1, 5).map((column) => [column.label, column.type, column.role]), [
    ['Asset field', 'text', 'dimension'],
    ['Performance label', 'text', 'dimension'],
    ['Asset text', 'text', 'dimension'],
    ['Asset name', 'text', 'dimension'],
  ]);
  assert.deepEqual(asset.rows, [{ 'campaign.name': 'Brand', 'ad_group_ad_asset_view.field_type': 'HEADLINE', 'ad_group_ad_asset_view.performance_label': 'BEST', 'asset.text_asset.text': 'Stay a month', 'asset.name': null, 'metrics.impressions': 900, 'metrics.conversions': 4.5, 'metrics.cost_micros': 20 }]);
  assert.equal(asset.metadata.currency, 'USD');

  const keywords = context(
    'SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.quality_info.quality_score, metrics.clicks FROM keyword_view WHERE metrics.impressions > 0',
    [{ results: [{ adGroupCriterion: { keyword: { text: 'monthly rentals', matchType: 'PHRASE' }, qualityInfo: { qualityScore: 7 } }, metrics: { clicks: '12' } }, { adGroupCriterion: { keyword: { text: 'new keyword', matchType: 'EXACT' } }, metrics: { clicks: '1' } }] }]
  );
  const keyword = plain(report.fetch(keywords));
  assert.equal(keywords.calls.length, 1, 'no money column, so no currency lookup');
  const quality = keyword.columns[2];
  assert.deepEqual([keyword.columns[0].label, keyword.columns[1].label, quality.label, quality.type, quality.additive], ['Keyword', 'Match type', 'Quality score', 'number', false]);
  assert.deepEqual(keyword.rows.map((row) => row['ad_group_criterion.quality_info.quality_score']), [7, null], 'a keyword without a score stays blank, never 0');
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

test('an ad asset view also lists its asset: the common fields and its text, image or video, not every asset type', () => {
  const report = load();
  const like = (name) => "SELECT name, selectable, is_repeated WHERE name LIKE '" + name + ".%'";
  const fields = context('FROM ad_group_ad_asset_view', [
    { results: [{ name: 'ad_group_ad_asset_view', selectableWith: ['metrics.impressions', 'metrics.cost_micros', 'segments.date', 'asset', 'campaign'], attributeResources: ['ad_group_ad', 'asset', 'ad_group', 'campaign', 'customer'] }] },
    { results: [{ name: 'ad_group_ad_asset_view.field_type', selectable: true }, { name: 'ad_group_ad_asset_view.performance_label', selectable: true }] },
    {
      results: [
        'asset.id',
        'asset.name',
        'asset.type',
        'asset.text_asset.text',
        'asset.image_asset.full_size.url',
        'asset.image_asset.data',
        'asset.youtube_video_asset.youtube_video_title',
        'asset.sitelink_asset.link_text',
        'asset.lead_form_asset.headline',
        'asset.dynamic_custom_asset.item_title',
      ]
        .map((name) => ({ name, selectable: true }))
        .concat([{ name: 'asset.policy_summary', selectable: false }]),
    },
    { results: [{ name: 'ad_group.name', selectable: true }] },
    { results: [{ name: 'campaign.name', selectable: true }] },
    { results: [{ name: 'customer.descriptive_name', selectable: true }] },
  ]);
  assert.deepEqual(plain(report.discoverFields(fields)).map((field) => [field.key, field.label]), [
    ['ad_group_ad_asset_view.field_type', 'Asset field'],
    ['ad_group_ad_asset_view.performance_label', 'Performance label'],
    ['asset.id', 'Asset id'],
    ['asset.name', 'Asset name'],
    ['asset.type', 'Asset type'],
    ['asset.text_asset.text', 'Asset text'],
    ['asset.image_asset.full_size.url', 'Image URL'],
    ['asset.youtube_video_asset.youtube_video_title', 'Video title'],
    ['ad_group.name', 'Ad group name'],
    ['campaign.name', 'Campaign'],
    ['customer.descriptive_name', 'Account'],
    ['metrics.impressions', 'Impressions'],
    ['metrics.cost_micros', 'Spend'],
    ['segments.date', 'Date'],
  ]);
  assert.deepEqual(
    fields.calls.slice(1).map((call) => call.body.query),
    ['ad_group_ad_asset_view', 'asset', 'ad_group', 'campaign', 'customer'].map(like),
    'ad_group_ad, like ad_group_criterion, is not a parent worth listing'
  );

  // Other views that hold an asset keep to the account hierarchy.
  const linked = context('FROM campaign_asset', [
    { results: [{ name: 'campaign_asset', selectableWith: [], attributeResources: ['asset', 'campaign', 'customer'] }] },
    { results: [{ name: 'campaign_asset.status', selectable: true }] },
    { results: [{ name: 'campaign.name', selectable: true }] },
    { results: [] },
  ]);
  assert.deepEqual(plain(report.discoverFields(linked)).map((field) => field.key), ['campaign_asset.status', 'campaign.name']);
  assert.deepEqual(linked.calls.slice(1).map((call) => call.body.query), ['campaign_asset', 'campaign', 'customer'].map(like));
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
  assert.equal(keyword.chat, true, 'chat ranks keyword, search term and asset lists with their own reports');
  assert.deepEqual(['ad', 'campaign', 'placement'].map((id) => level(id).chat), [false, false, false], 'chat reaches the other levels through the custom query');
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

test('a ranked level keeps the top rows asked for, and says so only when the list was cut', () => {
  const keyword = level('keyword');
  const [top] = plain(keyword.configFields);
  assert.deepEqual([top.key, top.label, top.type, top.required, top.min, top.max], ['top', 'Keep the top rows', 'number', false, 1, 30000]);
  const fields = ['campaign.name', 'ad_group_criterion.keyword.text', 'metrics.clicks', 'metrics.cost_micros'];
  const rows = (count) => ({ results: Array.from({ length: count }, (_, index) => ({ campaign: { name: 'Brand' }, adGroupCriterion: { keyword: { text: 'k' + index } }, metrics: { clicks: '1', costMicros: String((count - index) * 1000000) } })) });
  const run = (config, count, more = {}) => {
    const ctx = context(undefined, [rows(count), { results: [{ customer: { currencyCode: 'EUR' } }] }], { fields, config, ...more });
    const result = plain(keyword.fetch(ctx));
    return { query: ctx.calls[0].body.query, metadata: result.metadata };
  };
  const base = "SELECT campaign.name, ad_group_criterion.keyword.text, metrics.clicks, metrics.cost_micros FROM keyword_view WHERE metrics.impressions > 0 AND segments.date BETWEEN '2026-06-22' AND '2026-09-19' ORDER BY metrics.cost_micros DESC LIMIT ";
  const cut = run({ top: 25 }, 25);
  assert.equal(cut.query, base + '25');
  assert.deepEqual([cut.metadata.topRows, cut.metadata.note], [25, 'Top 25 by spend']);
  const short = run({ top: 25 }, 7);
  assert.deepEqual([short.metadata.topRows, short.metadata.note], [undefined, undefined], 'a shorter list is the whole list');

  // Blank keeps every row up to the row limit, as before; a full page says how to get more.
  const all = run({ top: '' }, 100);
  assert.equal(all.query, base + '100');
  assert.deepEqual([all.metadata.topRows, all.metadata.note], [100, 'Top 100 rows by spend; raise the row limit for more.']);
  assert.equal(run({}, 99).metadata.note, undefined);
  // Values arrive as the form or the chat sent them.
  assert.equal(run({ top: '40' }, 3).query, base + '40');
  assert.equal(run({ top: ' ' }, 3).query, base + '100');

  // Without spend the ranking is by impressions, but only when a top was asked for.
  const reach = run({ top: 10 }, 10, { fields: ['ad_group_criterion.keyword.text', 'metrics.impressions'] });
  assert.match(reach.query, /ORDER BY metrics\.impressions DESC LIMIT 10$/);
  assert.deepEqual([reach.metadata.topRows, reach.metadata.note], [10, 'Top 10 by impressions']);
  // A blank top without spend is not a ranking: the report fails over the row limit, as before.
  const impressions = ['campaign.name', 'metrics.impressions'];
  const unranked = context(undefined, [{ results: [] }], { fields: impressions, config: {} });
  keyword.fetch(unranked);
  assert.equal(unranked.calls[0].body.query, "SELECT campaign.name, metrics.impressions FROM keyword_view WHERE metrics.impressions > 0 AND segments.date BETWEEN '2026-06-22' AND '2026-09-19' LIMIT 101");
  const over = { results: Array.from({ length: 101 }, (_, index) => ({ campaign: { name: 'c' + index }, metrics: { impressions: '5' } })) };
  assert.throws(() => keyword.fetch(context(undefined, [over], { fields: impressions, config: {} })), /exceeds the row limit/);
});

test('Keep the top rows is a whole number within the row ceiling, for ranked totals only', () => {
  const keyword = level('keyword');
  const ctx = (config, fields = ['ad_group_criterion.keyword.text', 'metrics.cost_micros'], responses = []) => context(undefined, responses, { fields, config });
  for (const top of [0, -5, 30001, 1.5, 'abc', '12abc'])
    assert.throws(() => keyword.fetch(ctx({ top })), /Keep the top rows must be a whole number from 1 to 30,000/, String(top));
  // A top above the row limit is refused before any request, naming both settings, never cut to
  // fit and never sent to fail on the limit's own advice (dates, dimensions).
  for (const top of [101, 30000]) {
    const ceiling = ctx({ top });
    assert.throws(
      () => keyword.fetch(ceiling),
      new RegExp(`^Error: Keep the top rows \\(${top.toLocaleString('en-US')}\\) is above this report's row limit \\(100\\)\\. Lower it or raise the row limit\\.$`)
    );
    assert.equal(ceiling.calls.length, 0);
  }
  const exact = ctx({ top: 100 }, undefined, [{ results: [] }, { results: [] }]);
  keyword.fetch(exact);
  assert.match(exact.calls[0].body.query, / LIMIT 100$/);
  // Any period column makes a trend, whose periods each need every row: the top is refused,
  // naming the column, and without a top the trend is ordered by its period and fails over the
  // row limit instead of keeping the top rows of all periods together.
  for (const [period, label] of [['segments.date', 'Date'], ['segments.week', 'Week'], ['segments.month', 'Month'], ['segments.quarter', 'Quarter'], ['segments.year', 'Year']]) {
    assert.throws(
      () => keyword.fetch(ctx({ top: 50 }, [period, 'ad_group_criterion.keyword.text', 'metrics.cost_micros'])),
      new RegExp(`cannot be combined with ${label}\\. Remove ${label} or clear Keep the top rows\\.`),
      period
    );
    const trend = ctx({}, [period, 'ad_group_criterion.keyword.text', 'metrics.cost_micros'], [{ results: [] }, { results: [] }]);
    keyword.fetch(trend);
    assert.match(trend.calls[0].body.query, new RegExp(`ORDER BY ${period.replace('.', '\\.')} LIMIT 101$`), period);
  }
  assert.throws(() => keyword.fetch(ctx({ top: 50 }, ['ad_group_criterion.keyword.text', 'metrics.clicks'])), /ranks by spend or impressions/);

  // Every level that ranks by spend offers it; totals per account, lists without metrics and
  // conversions by action (no spend beside the split) do not.
  for (const id of ['campaign', 'ad_group', 'ad', 'ad_asset', 'search_term', 'geographic', 'age', 'gender', 'audience', 'landing_page', 'placement', 'asset_group', 'shopping'])
    assert.deepEqual(plain(level(id).configFields).map((field) => field.key), ['top'], id);
  for (const id of ['account', 'negative_keyword', 'negative_keyword_ad_group', 'conversion_action'])
    assert.deepEqual(plain(level(id).configFields), [], id);
});

test('ad assets list the enabled assets of enabled ads with short labels, ranked by spend or impressions', () => {
  const assets = level('ad_asset');
  assert.deepEqual([assets.label, assets.chat, assets.dateRange], ['Ad assets', true, true]);
  // Google no longer fills the performance label for Search and Display assets, so the report
  // does not promise it: assets are judged by their own metrics.
  assert.match(assets.description, /no longer fills the performance label for Search and Display assets, so judge assets by their metrics/);
  assert.doesNotMatch(assets.description, /LOW, GOOD, BEST/);
  assert.deepEqual(plain(assets.fields).filter((field) => !field.key.startsWith('segments.')).map((field) => [field.key, field.label, field.type, field.default]), [
    ['campaign.name', 'Campaign', 'text', true],
    ['ad_group.name', 'Ad group', 'text', true],
    ['ad_group_ad_asset_view.field_type', 'Asset type', 'text', true],
    ['ad_group_ad_asset_view.performance_label', 'Performance label', 'text', false],
    ['asset.text_asset.text', 'Asset text', 'text', true],
    ['asset.name', 'Asset name', 'text', true],
    ['asset.type', 'Asset format', 'text', false],
    ['metrics.impressions', 'Impressions', 'number', true],
    ['metrics.clicks', 'Clicks', 'number', true],
    ['metrics.ctr', 'CTR', 'percent', false],
    ['metrics.conversions', 'Conversions', 'number', true],
    ['metrics.cost_micros', 'Spend', 'currency', true],
  ]);

  const enabled = "ad_group_ad_asset_view.enabled = TRUE AND ad_group_ad.status = 'ENABLED' AND ad_group.status = 'ENABLED' AND campaign.status = 'ENABLED'";
  const ctx = context(undefined, [
    { results: [{ campaign: { name: 'Brand' }, adGroup: { name: 'Stays' }, adGroupAdAssetView: { fieldType: 'HEADLINE', performanceLabel: 'LOW' }, asset: { textAsset: { text: 'Book a month' } }, metrics: { impressions: '1200', clicks: '30', conversions: 0, costMicros: '45000000' } }] },
    { results: [{ customer: { currencyCode: 'EUR' } }] },
  ], { fields: [], config: { top: 50 } });
  const result = plain(assets.fetch(ctx));
  assert.equal(
    ctx.calls[0].body.query,
    'SELECT campaign.name, ad_group.name, ad_group_ad_asset_view.field_type, asset.text_asset.text, asset.name, metrics.impressions, metrics.clicks, metrics.conversions, metrics.cost_micros FROM ad_group_ad_asset_view WHERE ' +
      enabled +
      " AND metrics.impressions > 0 AND segments.date BETWEEN '2026-06-22' AND '2026-09-19' ORDER BY metrics.cost_micros DESC LIMIT 50"
  );
  assert.deepEqual(result.columns.map((column) => column.label), ['Campaign', 'Ad group', 'Asset type', 'Asset text', 'Asset name', 'Impressions', 'Clicks', 'Conversions', 'Spend']);
  assert.deepEqual(result.rows, [{ 'campaign.name': 'Brand', 'ad_group.name': 'Stays', 'ad_group_ad_asset_view.field_type': 'HEADLINE', 'asset.text_asset.text': 'Book a month', 'asset.name': null, 'metrics.impressions': 1200, 'metrics.clicks': 30, 'metrics.conversions': 0, 'metrics.cost_micros': 45 }]);
  assert.deepEqual([result.metadata.grain, result.metadata.currency, result.metadata.topRows], ['Ad assets', 'EUR', undefined]);

  // Without spend, impressions rank the assets; without metrics only the enabled links are listed.
  const reach = context(undefined, [{ results: [] }], { fields: ['ad_group_ad_asset_view.field_type', 'asset.text_asset.text', 'metrics.impressions'], config: { top: 20 } });
  assets.fetch(reach);
  assert.match(reach.calls[0].body.query, /AND metrics\.impressions > 0 AND segments\.date BETWEEN '2026-06-22' AND '2026-09-19' ORDER BY metrics\.impressions DESC LIMIT 20$/);
  const links = context(undefined, [{ results: [] }], { fields: ['campaign.name', 'asset.text_asset.text'], config: {} });
  assets.fetch(links);
  assert.equal(links.calls[0].body.query, 'SELECT campaign.name, asset.text_asset.text FROM ad_group_ad_asset_view WHERE ' + enabled + ' LIMIT 101');
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
