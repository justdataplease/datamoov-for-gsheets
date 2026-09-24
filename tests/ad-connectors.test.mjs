import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { deflateRawSync } from 'node:zlib';
import { createDatamoovSandbox, plain } from './helpers/datamoov-sandbox.mjs';

function load(names, hidden) {
  const f = createDatamoovSandbox();
  // A hidden source is kept in the code without being offered; its tests register it directly.
  if (hidden) f.api.dmvRegisterConnector_ = (definition) => { (f.api.DMV_CONNECTORS = f.api.DMV_CONNECTORS || {})[definition.id] = definition; };
  for (const name of names) {
    const filename = `connectors/${name}.js`;
    new vm.Script(readFileSync(new URL(`../src/${filename}`, import.meta.url), 'utf8'), { filename })
      .runInContext(f.api, { timeout: 1000 });
  }
  f.report = (id, index = 0) => f.api.DMV_CONNECTORS[id].reports[index];
  f.context = (id, credentials, report) => f.api.dmvContext_(f.api.DMV_CONNECTORS[id], { credentials },
    { config: report.config || {}, fields: report.fields || [], maxRows: report.maxRows || 1000 },
    { startDate: report.startDate || '2026-09-01', endDate: report.endDate || '2026-09-02' });
  return f;
}

const request = (f, index) => ({ url: f.state.http[index].url, headers: f.state.http[index].options.headers,
  body: /^[\[{]/.test(f.state.http[index].options.payload || '') ? JSON.parse(f.state.http[index].options.payload) : null });

// A one-entry ZIP archive (deflated), as Microsoft serves report downloads.
function zip(name, text) {
  const data = Buffer.from(text, 'utf8'), packed = deflateRawSync(data), nameBytes = Buffer.from(name);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0, 6); header.writeUInt16LE(8, 8);
  header.writeUInt32LE(0, 10); header.writeUInt32LE(0, 14); header.writeUInt32LE(packed.length, 18); header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(nameBytes.length, 26); header.writeUInt16LE(0, 28);
  return [...Buffer.concat([header, nameBytes, packed])];
}

test('YouTube report filters Google Ads video campaigns and converts micros, rates and quartiles', () => {
  const f = load(['google_ads']);
  const report = f.report('google_ads', 1);
  assert.equal(report.id, 'youtube_campaign_daily');
  f.state.responses.push({ body: { results: [{
    segments: { date: '2026-09-01' }, customer: { id: '1234567890', currencyCode: 'EUR', timeZone: 'Europe/Athens' },
    campaign: { id: '77', name: 'Launch video' },
    metrics: { costMicros: '12500000', impressions: '1000', videoTrueviewViews: '400', videoTrueviewViewRate: 0.4, trueviewAverageCpv: '31250', clicks: '12', conversions: 2.5, conversionsValue: 99.5, videoQuartileP100Rate: 0.25 },
  }] } });
  const output = report.fetch(f.context('google_ads', { customerId: '123-456-7890', authMode: 'token', accessToken: 'offline-token' },
    { fields: ['segments.date', 'campaign.name', 'metrics.cost_micros', 'metrics.video_views', 'metrics.video_view_rate', 'metrics.average_cpv', 'metrics.video_quartile_p100_rate'] }));
  const query = request(f, 0).body.query;
  assert.match(query, /FROM campaign WHERE segments.date BETWEEN '2026-09-01' AND '2026-09-02' AND campaign.advertising_channel_type = 'VIDEO' ORDER BY/);
  assert.match(query, /metrics.video_quartile_p100_rate/);
  assert.deepEqual(plain(output.rows), [{ 'segments.date': '2026-09-01', 'campaign.name': 'Launch video', 'metrics.cost_micros': 12.5,
    'metrics.video_views': 400, 'metrics.video_view_rate': 0.4, 'metrics.average_cpv': 0.03125, 'metrics.video_quartile_p100_rate': 0.25 }]);
  assert.equal(output.metadata.grain, 'Daily video campaign');
  assert.equal(output.metadata.currency, 'EUR');
  assert.equal(f.report('google_ads', 0).fetch.name, 'dmvGoogleAdsFetch_');
});

test('TikTok is kept in the code but not offered anywhere', () => {
  const f = load(['tiktok_ads']);
  assert.equal(f.api.DMV_CONNECTORS.tiktok_ads, undefined);
  assert.ok(!plain(f.api.dmvCatalog_()).some((source) => source.id === 'tiktok_ads'));
  assert.ok(!Object.keys(plain(f.api.dmvCredentialFamilies_())).includes('tiktok_ads'));
  // A connection saved while it was offered stays stored but is no longer listed.
  f.state.user.setProperty('dmv:v1:connection:old', JSON.stringify({ id: 'old', label: 'Old TikTok', connectorId: 'tiktok_ads', credentials: {} }));
  assert.deepEqual(plain(f.api.dmvConnections_()), []);
});

test('TikTok pages the integrated report, reads the advertiser currency, scales rates and rejects API errors', () => {
  const f = load(['tiktok_ads'], true);
  const item = (campaign, date, spend) => ({ dimensions: { campaign_id: campaign, stat_time_day: date + ' 00:00:00' },
    metrics: { campaign_name: 'Campaign ' + campaign, spend: String(spend), impressions: '100', clicks: '5', ctr: '5.0', conversion: '1' } });
  f.state.responses.push(
    { body: { code: 0, message: 'OK', data: { list: [{ advertiser_id: '900', name: 'Shop', currency: 'USD', timezone: 'America/New_York' }] } } },
    { body: { code: 0, data: { list: [item('1', '2026-09-01', 10.5)], page_info: { page: 1, page_size: 1, total_number: 2, total_page: 2 } } } },
    { body: { code: 0, data: { list: [item('1', '2026-09-02', 4)], page_info: { page: 2, page_size: 1, total_number: 2, total_page: 2 } } } }
  );
  const output = f.report('tiktok_ads').fetch(f.context('tiktok_ads', { advertiserId: '900', accessToken: 'tt-private' },
    { fields: ['stat_time_day', 'campaign_id', 'campaign_name', 'spend', 'ctr', 'conversion'] }));
  assert.equal(f.state.http.length, 3);
  assert.equal(request(f, 0).headers['Access-Token'], 'tt-private');
  assert.match(request(f, 0).url, /advertiser\/info\/\?advertiser_ids=%5B%22900%22%5D/);
  const url = new URL(request(f, 1).url);
  assert.equal(url.searchParams.get('data_level'), 'AUCTION_CAMPAIGN');
  assert.equal(url.searchParams.get('dimensions'), '["campaign_id","stat_time_day"]');
  assert.deepEqual(JSON.parse(url.searchParams.get('metrics')), ['campaign_name', 'spend', 'ctr', 'conversion']);
  assert.equal(url.searchParams.get('start_date'), '2026-09-01');
  assert.equal(new URL(request(f, 2).url).searchParams.get('page'), '2');
  assert.deepEqual(plain(output.rows), [
    { stat_time_day: '2026-09-01', campaign_id: '1', campaign_name: 'Campaign 1', spend: 10.5, ctr: 0.05, conversion: 1 },
    { stat_time_day: '2026-09-02', campaign_id: '1', campaign_name: 'Campaign 1', spend: 4, ctr: 0.05, conversion: 1 },
  ]);
  assert.equal(output.metadata.currency, 'USD');
  f.state.responses.push({ body: { code: 40105, message: 'Access token is incorrect or has been revoked.' } });
  assert.throws(() => f.report('tiktok_ads').fetch(f.context('tiktok_ads', { advertiserId: '900', accessToken: 'x' }, {})), /TikTok rejected the request: Access token is incorrect/);
  f.state.responses.push(
    { body: { code: 0, data: { list: [{ advertiser_id: '900', currency: 'USD' }] } } },
    { body: { code: 0, data: { list: [item('1', '2026-09-01', 1)], page_info: { page: 1, page_size: 1000, total_number: 5000, total_page: 5 } } } }
  );
  assert.throws(() => f.report('tiktok_ads').fetch(f.context('tiktok_ads', { advertiserId: '900', accessToken: 'x' }, { maxRows: 100 })), /exceeds the row limit/);
});

test('LinkedIn requests versioned daily campaign analytics, resolves names and account currency', () => {
  const f = load(['linkedin_ads']);
  f.state.responses.push(
    { body: { id: 506, currency: 'EUR', name: 'Acme' } },
    { body: { elements: [
      { dateRange: { start: { year: 2026, month: 9, day: 1 }, end: { year: 2026, month: 9, day: 1 } }, pivotValues: ['urn:li:sponsoredCampaign:11'], impressions: 120, clicks: 3, costInLocalCurrency: '19.91833', externalWebsiteConversions: 0 },
      { dateRange: { start: { year: 2026, month: 9, day: 2 }, end: { year: 2026, month: 9, day: 2 } }, pivotValues: ['urn:li:sponsoredCampaign:11'], impressions: 80, clicks: 1, costInLocalCurrency: '4.5', externalWebsiteConversions: 2 },
    ] } },
    { body: { elements: [{ id: 11, name: 'Thought leadership' }], metadata: { nextPageToken: 'p2' } } },
    { body: { elements: [{ id: 12, name: 'Other' }], metadata: {} } }
  );
  const output = f.report('linkedin_ads').fetch(f.context('linkedin_ads', { accountId: '506', authMode: 'token', accessToken: 'li-private' },
    { fields: ['date', 'campaign_id', 'campaign_name', 'impressions', 'costInLocalCurrency', 'externalWebsiteConversions'] }));
  assert.equal(f.state.http.length, 4);
  const analytics = request(f, 1);
  assert.equal(analytics.headers['Linkedin-Version'], '202606');
  assert.equal(analytics.headers['X-Restli-Protocol-Version'], '2.0.0');
  assert.equal(analytics.headers.Authorization, 'Bearer li-private');
  assert.equal(analytics.url, 'https://api.linkedin.com/rest/adAnalytics?q=analytics&pivot=CAMPAIGN&timeGranularity=DAILY&dateRange=(start:(year:2026,month:9,day:1),end:(year:2026,month:9,day:2))&accounts=List(urn%3Ali%3AsponsoredAccount%3A506)&fields=dateRange,pivotValues,impressions,costInLocalCurrency,externalWebsiteConversions');
  assert.match(request(f, 2).url, /adAccounts\/506\/adCampaigns\?q=search&pageSize=1000$/);
  assert.match(request(f, 3).url, /pageToken=p2$/);
  assert.deepEqual(plain(output.rows), [
    { date: '2026-09-01', campaign_id: '11', campaign_name: 'Thought leadership', impressions: 120, costInLocalCurrency: 19.91833, externalWebsiteConversions: 0 },
    { date: '2026-09-02', campaign_id: '11', campaign_name: 'Thought leadership', impressions: 80, costInLocalCurrency: 4.5, externalWebsiteConversions: 2 },
  ]);
  assert.equal(output.metadata.currency, 'EUR');
  // OAuth mode exchanges the refresh token at LinkedIn's fixed endpoint before any API call.
  f.state.responses.push({ body: { access_token: 'li-fresh', expires_in: 5184000 } }, { body: { id: 506, currency: 'USD' } });
  f.api.DMV_CONNECTORS.linkedin_ads.test(f.context('linkedin_ads', { accountId: '506', authMode: 'oauth', clientId: 'c', clientSecret: 's', refreshToken: 'r' }, {}));
  assert.equal(f.state.http[4].url, 'https://www.linkedin.com/oauth/v2/accessToken');
  assert.match(f.state.http[4].options.payload, /grant_type=refresh_token/);
  assert.equal(f.state.http[5].options.headers.Authorization, 'Bearer li-fresh');
});

test('Microsoft Ads submits, polls, downloads the zipped CSV and parses typed cells', () => {
  const f = load(['microsoft_ads']);
  const csv = 'TimePeriod,AccountId,CurrencyCode,CampaignId,CampaignName,Spend,Impressions,Clicks,Ctr,Conversions\n' +
    '2026-09-01,111,USD,55,"Brand, search","1,234.50",10000,250,2.50%,12\n' +
    '9/2/2026,111,USD,55,"Brand, search",0.00,0,0,--,0\n';
  f.state.responses.push(
    { body: { access_token: 'ms-fresh', expires_in: 3600 } },
    { body: { ReportRequestId: 'req-1', TrackingId: 't' } },
    { body: { ReportRequestStatus: { ReportRequestId: 'req-1', Status: 'Pending' } } },
    { body: { ReportRequestStatus: { ReportRequestId: 'req-1', Status: 'Success', ReportDownloadUrl: 'https://download.api.bingads.microsoft.com/ReportDownload/Download.aspx?q=abc' } } },
    { bytes: zip('report.csv', csv) }
  );
  const output = f.report('microsoft_ads').fetch(f.context('microsoft_ads',
    { accountId: '111', customerId: '222', developerToken: 'dev-private', authMode: 'oauth', clientId: 'app', clientSecret: 'secret', refreshToken: 'refresh' },
    { fields: ['TimePeriod', 'CampaignName', 'Spend', 'Impressions', 'Ctr', 'Conversions'] }));
  assert.equal(f.state.http.length, 5);
  assert.equal(request(f, 0).url, 'https://login.microsoftonline.com/common/oauth2/v2.0/token');
  assert.match(f.state.http[0].options.payload, /scope=https%3A%2F%2Fads.microsoft.com%2Fmsads.manage%20offline_access/);
  const submit = request(f, 1);
  assert.equal(submit.url, 'https://reporting.api.bingads.microsoft.com/Reporting/v13/GenerateReport/Submit');
  assert.deepEqual(submit.headers, { Authorization: 'Bearer ms-fresh', DeveloperToken: 'dev-private', CustomerId: '222', CustomerAccountId: '111' });
  assert.equal(submit.body.ReportRequest.Type, 'CampaignPerformanceReportRequest');
  assert.equal(submit.body.ReportRequest.Aggregation, 'Daily');
  assert.deepEqual(submit.body.ReportRequest.Scope, { AccountIds: [111] });
  assert.deepEqual(submit.body.ReportRequest.Time, { CustomDateRangeStart: { Day: 1, Month: 9, Year: 2026 }, CustomDateRangeEnd: { Day: 2, Month: 9, Year: 2026 } });
  assert.deepEqual(submit.body.ReportRequest.Columns, ['TimePeriod', 'CampaignName', 'Spend', 'Impressions', 'Ctr', 'Conversions', 'CampaignId', 'AccountId', 'CurrencyCode']);
  assert.equal(request(f, 2).url, 'https://reporting.api.bingads.microsoft.com/Reporting/v13/GenerateReport/Poll');
  assert.deepEqual(request(f, 2).body, { ReportRequestId: 'req-1' });
  assert.deepEqual(plain(f.state.sleeps), [3000]);
  assert.equal(f.state.http[4].options.method, 'get');
  assert.deepEqual(plain(output.rows), [
    { TimePeriod: '2026-09-01', CampaignName: 'Brand, search', Spend: 1234.5, Impressions: 10000, Ctr: 0.025, Conversions: 12 },
    { TimePeriod: '2026-09-02', CampaignName: 'Brand, search', Spend: 0, Impressions: 0, Ctr: null, Conversions: 0 },
  ]);
  assert.equal(output.metadata.currency, 'USD');
  // A download offered from an unknown host is refused before any credential could be sent.
  f.state.responses.push(
    { body: { ReportRequestId: 'req-2' } },
    { body: { ReportRequestStatus: { Status: 'Success', ReportDownloadUrl: 'https://evil.example/report.zip' } } }
  );
  assert.throws(() => f.report('microsoft_ads').fetch(f.context('microsoft_ads', { accountId: '111', customerId: '222', developerToken: 'd', authMode: 'token', accessToken: 'tok' }, {})), /unexpected host \(evil\.example\)/);
  assert.equal(f.state.http.length, 7);
  f.state.responses.push({ body: { ReportRequestId: 'req-3' } }, { body: { ReportRequestStatus: { Status: 'Error' } } });
  assert.throws(() => f.report('microsoft_ads').fetch(f.context('microsoft_ads', { accountId: '111', customerId: '222', developerToken: 'd', authMode: 'token', accessToken: 'tok' }, {})), /could not generate the report \(Error\)/);
  f.state.responses.push({ body: { ReportRequestId: 'req-4' } }, { body: { ReportRequestStatus: { Status: 'Success' } } });
  assert.deepEqual(plain(f.report('microsoft_ads').fetch(f.context('microsoft_ads', { accountId: '111', customerId: '222', developerToken: 'd', authMode: 'token', accessToken: 'tok' }, {})).rows), [], 'success without a URL is an empty report');
});

test('Search Console pages past its 25,000-row request cap and still detects overflow', () => {
  const f = load(['search_console']);
  const credentials = { siteUrl: 'sc-domain:example.com', authMode: 'token', accessToken: 'g-token' };
  const page = (count, offset) => Array.from({ length: count }, (_, index) => ({ keys: ['q' + (offset + index)], clicks: 1 }));
  f.state.responses.push({ body: { rows: page(25000, 0) } }, { body: { rows: page(10, 25000) } });
  const output = f.report('search_console').fetch(f.context('search_console', credentials, { fields: ['query', 'clicks'], maxRows: 30000 }));
  assert.equal(output.rows.length, 25010);
  assert.deepEqual([request(f, 0).body.startRow, request(f, 0).body.rowLimit], [0, 25000]);
  assert.deepEqual([request(f, 1).body.startRow, request(f, 1).body.rowLimit], [25000, 5001]);
  assert.equal(f.state.http.length, 2, 'a short page ends paging');
  f.state.responses.push({ body: { rows: page(25000, 0) } }, { body: { rows: page(5001, 25000) } });
  assert.throws(() => f.report('search_console').fetch(f.context('search_console', credentials, { fields: ['query', 'clicks'], maxRows: 30000 })), /exceeds the row limit/);
});

test('Search Console pages search analytics, discovers properties and asks no scope of the add-on itself', () => {
  const f = load(['search_console']);
  const connector = f.api.DMV_CONNECTORS.search_console;
  assert.deepEqual(plain(connector.googleScopes), ['https://www.googleapis.com/auth/webmasters.readonly']);
  const manifest = JSON.parse(readFileSync(new URL('../src/appsscript.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.oauthScopes, ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/script.external_request',
    'https://www.googleapis.com/auth/script.scriptapp', 'https://www.googleapis.com/auth/script.container.ui'], 'only the Sheets essentials');
  const rows = [{ keys: ['2026-09-01', 'datamoov'], clicks: 5, impressions: 100, ctr: 0.05, position: 3.2 }, { keys: ['2026-09-01', 'sheets'], clicks: 1, impressions: 40, ctr: 0.025, position: 8 },
    { keys: ['2026-09-02', 'datamoov'], clicks: 2, impressions: 50, ctr: 0.04, position: 3 }];
  f.state.responses.push({ body: { rows } });
  const credentials = { siteUrl: 'sc-domain:example.com', authMode: 'token', accessToken: 'g-token' };
  const output = f.report('search_console').fetch(f.context('search_console', credentials, { fields: ['date', 'query', 'clicks', 'impressions', 'ctr', 'position'], maxRows: 50 }));
  assert.equal(request(f, 0).url, 'https://searchconsole.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query');
  assert.deepEqual(request(f, 0).body, { startDate: '2026-09-01', endDate: '2026-09-02', dimensions: ['date', 'query'], rowLimit: 51, startRow: 0, type: 'web' });
  assert.equal(output.rows.length, 3);
  assert.deepEqual(plain(output.rows[2]), { date: '2026-09-02', query: 'datamoov', clicks: 2, impressions: 50, ctr: 0.04, position: 3 });
  assert.equal(output.metadata.grain, 'By date, query');
  f.state.responses.push({ body: { rows } });
  assert.throws(() => f.report('search_console').fetch(f.context('search_console', credentials, { fields: ['clicks'], maxRows: 2 })), /exceeds the row limit/);
  assert.equal(request(f, 1).body.rowLimit, 3);
  assert.deepEqual(request(f, 1).body.dimensions, []);
  f.state.responses.push({ body: { siteEntry: [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }, { siteUrl: 'https://old.example/', permissionLevel: 'siteUnverifiedUser' }] } });
  const accounts = connector.discoverAccounts(f.context('search_console', { authMode: 'token', accessToken: 'g-token' }, {}));
  assert.deepEqual(plain(accounts), [{ id: 'sc-domain:example.com', label: 'sc-domain:example.com (siteOwner)', credentials: { siteUrl: 'sc-domain:example.com' } }]);
  assert.equal(request(f, 2).url, 'https://www.googleapis.com/webmasters/v3/sites');
});

test('new sources register with the shared contract: hosts, secret fields, complete metadata', () => {
  const f = load(['linkedin_ads', 'microsoft_ads', 'search_console']);
  for (const id of ['linkedin_ads', 'microsoft_ads', 'search_console']) {
    const connector = f.api.DMV_CONNECTORS[id];
    assert.ok(Array.isArray(connector.allowedHosts) && connector.allowedHosts.length, id + ' hosts');
    assert.ok(connector.authFields.some((field) => field.type === 'password' || field.secret), id + ' secrets');
    for (const report of connector.reports) {
      assert.equal(report.dateRange, true);
      assert.ok(report.fields.filter((field) => field.default).length <= 12, id + ' ' + report.id + ' starts small');
      assert.equal(new Set(report.fields.map((field) => field.key)).size, report.fields.length, id + ' ' + report.id + ' has distinct columns');
    }
  }
  assert.throws(() => f.report('linkedin_ads').fetch(f.context('linkedin_ads', { accountId: '506', authMode: 'token' }, {})), /LinkedIn access token/);
  assert.throws(() => f.report('microsoft_ads').fetch(f.context('microsoft_ads', { accountId: '1', customerId: '2', authMode: 'token', accessToken: 't' }, {})), /developer token/);
  assert.throws(() => f.report('search_console').fetch(f.context('search_console', { siteUrl: 'example.com', authMode: 'token', accessToken: 't' }, {})), /sc-domain:example.com/);
  assert.equal(f.state.http.length, 0);
});

test('the Microsoft connection test submits a one-day probe report and fails when it is not accepted', () => {
  const f = load(['microsoft_ads']);
  const credentials = { accountId: '111', customerId: '222', developerToken: 'dev-private', authMode: 'token', accessToken: 'tok' };
  f.state.responses.push({ body: { ReportRequestId: 'probe-1' } });
  f.api.DMV_CONNECTORS.microsoft_ads.test(f.context('microsoft_ads', credentials, {}));
  const probe = request(f, 0);
  assert.match(probe.url, /GenerateReport\/Submit$/);
  assert.deepEqual(probe.headers, { Authorization: 'Bearer tok', DeveloperToken: 'dev-private', CustomerId: '222', CustomerAccountId: '111' });
  assert.deepEqual(probe.body.ReportRequest.Columns, ['TimePeriod', 'Impressions']);
  assert.deepEqual(probe.body.ReportRequest.Time, { CustomDateRangeStart: { Day: 17, Month: 9, Year: 2026 }, CustomDateRangeEnd: { Day: 17, Month: 9, Year: 2026 } });
  assert.equal(f.state.http.length, 1, 'the probe report is never polled or downloaded');
  f.state.responses.push({ body: {} });
  assert.throws(() => f.api.DMV_CONNECTORS.microsoft_ads.test(f.context('microsoft_ads', credentials, {})), /did not accept the report request/);
  assert.throws(() => f.api.DMV_CONNECTORS.microsoft_ads.test(f.context('microsoft_ads', { ...credentials, developerToken: '' }, {})), /developer token/);
  assert.equal(f.state.http.length, 2);
});

test('Microsoft Ads report levels take the period and the ranking from the selected columns', () => {
  const f = load(['microsoft_ads']);
  const credentials = { accountId: '111', customerId: '222', developerToken: 'd', authMode: 'token', accessToken: 'tok' };
  const level = (id) => f.api.DMV_CONNECTORS.microsoft_ads.reports.find((report) => report.id === id);
  const run = (id, fields, csv, extra = {}) => {
    const before = f.state.http.length;
    f.state.responses.push({ body: { ReportRequestId: 'r' } },
      { body: { ReportRequestStatus: { Status: 'Success', ReportDownloadUrl: 'https://bingadsappsstorageprod.blob.core.windows.net/report.zip?sig=x' } } },
      { bytes: zip('report.csv', csv) });
    const output = level(id).fetch(f.context('microsoft_ads', credentials, { fields, ...extra }));
    return { output, request: request(f, before).body.ReportRequest };
  };
  assert.deepEqual(plain(f.api.DMV_CONNECTORS.microsoft_ads.reports.map((report) => report.id)), ['campaign_daily', 'account', 'campaign', 'ad_group', 'ad', 'keyword',
    'search_term', 'geographic', 'user_location', 'age_gender', 'professional', 'audience', 'landing_page', 'product', 'asset_group', 'conversion', 'goal', 'share_of_voice', 'publisher']);

  // No period column: totals for the range, the biggest spenders first, cut to the row limit.
  const ranked = run('search_term', ['SearchQuery', 'Spend', 'Ctr'], 'SearchQuery,Spend,Ctr\nshoes,1.50,2.00%\nboots,"1,200.00",5.00%\nhats,30.00,--\n', { maxRows: 2 });
  assert.equal(ranked.request.Type, 'SearchQueryPerformanceReportRequest');
  assert.equal(ranked.request.Aggregation, 'Summary');
  assert.deepEqual(ranked.request.Columns, ['SearchQuery', 'Spend', 'Ctr'], 'search terms carry no currency column');
  assert.deepEqual(plain(ranked.output.rows), [{ SearchQuery: 'boots', Spend: 1200, Ctr: 0.05 }, { SearchQuery: 'hats', Spend: 30, Ctr: null }]);
  assert.equal(ranked.output.metadata.note, 'Top 2 rows by spend; raise the row limit for more.');
  assert.equal(ranked.output.metadata.grain, 'Search terms, whole period');

  // Week is Microsoft's TimePeriod at the Monday-week aggregation; money brings the currency along.
  const weekly = run('campaign', ['Week', 'CampaignName', 'Spend'], 'TimePeriod,CampaignName,Spend,CurrencyCode\n2026-08-31,Brand,10.00,EUR\n');
  assert.equal(weekly.request.Aggregation, 'WeeklyStartingMonday');
  assert.deepEqual(weekly.request.Columns, ['TimePeriod', 'CampaignName', 'Spend', 'CurrencyCode']);
  assert.deepEqual(plain(weekly.output.rows), [{ Week: '2026-08-31', CampaignName: 'Brand', Spend: 10 }]);
  assert.equal(weekly.output.metadata.currency, 'EUR');
  assert.match(weekly.output.metadata.note, /whole weeks/);
  assert.equal(weekly.output.columns[0].type, 'date');

  // Dimensions alone still need one performance column; any schema column can be asked for by name.
  const plainRows = run('keyword', ['Keyword', 'FinalUrlSuffix'], 'Keyword,FinalUrlSuffix,Impressions\nshoes,utm=1,5\n');
  assert.deepEqual(plainRows.request.Columns, ['Keyword', 'FinalUrlSuffix', 'Impressions']);
  assert.deepEqual(plain(plainRows.output.rows), [{ Keyword: 'shoes', FinalUrlSuffix: 'utm=1' }]);
  assert.deepEqual(plain(plainRows.output.columns.map((column) => [column.label, column.type])), [['Keyword', 'text'], ['Final URL suffix', 'text']]);
  // A column Microsoft refuses to go without joins the request and the output.
  const audience = run('audience', ['AudienceName', 'Clicks'], 'AudienceName,Clicks,AudienceId\nBuyers,4,900\n');
  assert.deepEqual(audience.request.Columns, ['AudienceName', 'Clicks', 'AudienceId']);
  assert.deepEqual(plain(audience.output.rows), [{ AudienceName: 'Buyers', Clicks: 4, AudienceId: '900' }]);
  assert.throws(() => level('campaign').fetch(f.context('microsoft_ads', credentials, { fields: ['Week', 'Month', 'Spend'] })), /one of Date, Week, Month/);
  assert.throws(() => level('campaign').fetch(f.context('microsoft_ads', credentials, { fields: ['not a column'] })), /Unknown or unavailable report field/);
});

test('Microsoft Ads types any column by its name, loads columns from the service schema, finds accounts and honours a tenant', () => {
  const f = load(['microsoft_ads']);
  const connector = f.api.DMV_CONNECTORS.microsoft_ads;
  const typed = (name) => { const column = plain(f.api.dmvMicrosoftAdsColumn_(name, false)); return [column.label, column.type, column.role, column.additive]; };
  assert.deepEqual(typed('AverageCpc'), ['Average CPC', 'currency', 'metric', false]);
  assert.deepEqual(typed('Spend'), ['Spend', 'currency', 'metric', undefined]);
  assert.deepEqual(typed('VideoViewsAt25Percent'), ['Video views at 25 percent', 'number', 'metric', undefined]);
  assert.deepEqual(typed('TopImpressionRatePercent'), ['Top impression rate percent', 'percent', 'metric', false]);
  assert.deepEqual(typed('QualityScore'), ['Quality score', 'number', 'metric', false]);
  assert.deepEqual(typed('DeviceOS'), ['Device OS', 'text', 'dimension', undefined]);

  const credentials = { developerToken: 'dev', authMode: 'oauth', clientId: 'app', clientSecret: 'secret', refreshToken: 'refresh', tenantId: '11111111-2222-4333-8444-555555555555' };
  f.state.responses.push({ body: { access_token: 'ms-fresh', expires_in: 3600 } }, { body: { User: { Id: '9001' } } },
    { body: { Accounts: [{ Id: '111', Name: 'Shop', Number: 'F100', ParentCustomerId: '222', AccountLifeCycleStatus: 'Active' }, { Id: '112', Name: 'Closed', Number: 'F101', ParentCustomerId: '222', AccountLifeCycleStatus: 'Inactive' }] } });
  const accounts = connector.discoverAccounts(f.context('microsoft_ads', credentials, {}));
  assert.equal(request(f, 0).url, 'https://login.microsoftonline.com/11111111-2222-4333-8444-555555555555/oauth2/v2.0/token', 'a single-tenant app signs in at its own tenant');
  assert.equal(request(f, 1).url, 'https://clientcenter.api.bingads.microsoft.com/CustomerManagement/v13/User/Query');
  assert.deepEqual(request(f, 2).body.Predicates, [{ Field: 'UserId', Operator: 'Equals', Value: '9001' }]);
  assert.deepEqual(plain(accounts), [{ id: '111', label: 'Shop (F100)', credentials: { accountId: '111', customerId: '222' } }]);
  assert.throws(() => connector.discoverAccounts(f.context('microsoft_ads', { ...credentials, tenantId: 'bad tenant/../x' }, {})), /tenant ID/);

  const wsdl = '<xs:simpleType name="KeywordPerformanceReportColumn"><xs:restriction base="xs:string"><xs:enumeration value="Keyword" /><xs:enumeration value="FinalUrlSuffix" /><xs:enumeration value="Mainline1Bid" /></xs:restriction></xs:simpleType>' +
    '<xs:simpleType name="AdPerformanceReportColumn"><xs:restriction base="xs:string"><xs:enumeration value="AdTitle" /></xs:restriction></xs:simpleType>';
  f.state.responses.push({ bytes: [...Buffer.from(wsdl)] });
  const keyword = connector.reports.find((report) => report.id === 'keyword');
  const fields = plain(keyword.discoverFields(f.context('microsoft_ads', credentials, {})));
  assert.match(f.state.http[f.state.http.length - 1].url, /ReportingService\.svc\?singleWsdl$/);
  assert.deepEqual(fields.slice(0, keyword.fields.length), plain(keyword.fields));
  assert.deepEqual(fields.slice(keyword.fields.length).map((field) => [field.key, field.type, field.default]), [['FinalUrlSuffix', 'text', false], ['Mainline1Bid', 'currency', false]]);

  const explain = connector.errorMessage;
  assert.match(explain(400, { OperationErrors: [{ Code: 2034, Message: 'Restricted column combinations selected.' }] }), /Impression share and top impression rate columns cannot be reported with match type/);
  assert.equal(explain(400, { OperationErrors: [{ Code: 2010, Message: 'The column Foo is not valid for this report' }] }), 'Microsoft Advertising rejected the report. The column Foo is not valid for this report. Remove the column named, or Load columns to see what fits this report.');
  assert.match(explain(401, { Errors: [{ Code: 105, Message: 'token detail' }] }), /^Microsoft Advertising rejected the sign-in/);
  assert.match(explain(400, { OperationErrors: [{ Code: 100, ErrorCode: 'NullRequest', Message: 'The request message is null.' }] }), /a column does not exist in this report type/);
  assert.match(explain(400, { OperationErrors: [{ Code: 2015, ErrorCode: 'RequiredColumnsNotSelected', Message: 'long text' }] }), /needs more columns for this report type/);
  assert.equal(explain(500, { OperationErrors: [{ Code: 0, Message: 'internal detail' }] }), '');
});

test('LinkedIn analytics takes pivots and period from the columns, resolves audience names and ranks totals', () => {
  const f = load(['linkedin_ads']);
  const credentials = { accountId: '506', authMode: 'token', accessToken: 'li-private' };
  const report = f.api.DMV_CONNECTORS.linkedin_ads.reports.find((item) => item.id === 'analytics');
  const range = { start: { year: 2026, month: 9, day: 1 }, end: { year: 2026, month: 9, day: 2 } };
  f.state.responses.push({ body: { id: 506, currency: 'EUR' } },
    { body: { elements: [
      { dateRange: range, pivotValues: ['urn:li:sponsoredCampaign:11', 'urn:li:seniority:4'], impressions: 1000, clicks: 10, costInLocalCurrency: '20' },
      { dateRange: range, pivotValues: ['urn:li:sponsoredCampaign:11', 'urn:li:seniority:9'], impressions: 500, clicks: 0, costInLocalCurrency: '50' },
    ] } },
    { body: { elements: [{ id: 11, name: 'Thought leadership' }], metadata: {} } },
    { body: { elements: [{ urn: 'urn:li:seniority:4', name: 'Senior' }] } });
  const output = report.fetch(f.context('linkedin_ads', credentials, { fields: ['campaign_name', 'seniority', 'impressions', 'costInLocalCurrency', 'ctr', 'cpc', 'cpm'] }));
  assert.equal(request(f, 1).url, 'https://api.linkedin.com/rest/adAnalytics?q=statistics&pivots=List(CAMPAIGN,MEMBER_SENIORITY)&timeGranularity=ALL&dateRange=(start:(year:2026,month:9,day:1),end:(year:2026,month:9,day:2))&accounts=List(urn%3Ali%3AsponsoredAccount%3A506)&fields=dateRange,pivotValues,impressions,costInLocalCurrency,clicks');
  assert.equal(request(f, 3).url, 'https://api.linkedin.com/rest/adTargetingEntities?q=urns&urns=List(urn%3Ali%3Aseniority%3A4,urn%3Ali%3Aseniority%3A9)');
  assert.deepEqual(plain(output.rows), [
    { campaign_name: 'Thought leadership', seniority: '9', impressions: 500, costInLocalCurrency: 50, ctr: 0, cpc: null, cpm: 100 },
    { campaign_name: 'Thought leadership', seniority: 'Senior', impressions: 1000, costInLocalCurrency: 20, ctr: 0.01, cpc: 2, cpm: 20 },
  ], 'totals are ranked by spend; a value LinkedIn does not name keeps its id');
  assert.equal(output.metadata.grain, 'Whole period by campaign, seniority');
  assert.match(output.metadata.note, /approximate/);

  // One pivot keeps the analytics finder; Month asks LinkedIn for monthly rows.
  f.state.responses.push({ body: { id: 506, currency: 'EUR' } }, { body: { elements: [{ dateRange: range, pivotValues: ['urn:li:sponsoredCreative:77'], impressions: 5 }] } });
  const monthly = report.fetch(f.context('linkedin_ads', credentials, { fields: ['month', 'creative_id', 'impressions'] }));
  assert.match(request(f, 5).url, /q=analytics&pivot=CREATIVE&timeGranularity=MONTHLY/);
  assert.deepEqual(plain(monthly.rows), [{ month: '2026-09-01', creative_id: '77', impressions: 5 }]);
  f.state.responses.push({ body: { id: 506 } }, { body: { elements: [] } });
  report.fetch(f.context('linkedin_ads', credentials, { fields: ['impressions'] }));
  assert.match(request(f, 7).url, /q=analytics&pivot=ACCOUNT&timeGranularity=ALL/);

  const refuse = (fields, pattern) => { f.state.responses.push({ body: { id: 506 } }); assert.throws(() => report.fetch(f.context('linkedin_ads', credentials, { fields })), pattern); };
  refuse(['date', 'month', 'impressions'], /Date or Month/);
  refuse(['campaign_name', 'creative_id', 'industry', 'country', 'impressions'], /at most three/);
  refuse(['industry', 'conversionValueInLocalCurrency'], /does not report conversionValueInLocalCurrency by company, industry/);
});
