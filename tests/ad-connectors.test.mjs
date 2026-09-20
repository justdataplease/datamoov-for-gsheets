import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { deflateRawSync } from 'node:zlib';
import { createDatamoovSandbox, plain } from './helpers/datamoov-sandbox.mjs';

function load(names) {
  const f = createDatamoovSandbox();
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
    metrics: { costMicros: '12500000', impressions: '1000', videoViews: '400', videoViewRate: 0.4, averageCpv: '31250', clicks: '12', conversions: 2.5, conversionsValue: 99.5, videoQuartileP100Rate: 0.25 },
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

test('TikTok pages the integrated report, reads the advertiser currency, scales rates and rejects API errors', () => {
  const f = load(['tiktok_ads']);
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
  const f = load(['tiktok_ads', 'linkedin_ads', 'microsoft_ads', 'search_console']);
  for (const id of ['tiktok_ads', 'linkedin_ads', 'microsoft_ads', 'search_console']) {
    const connector = f.api.DMV_CONNECTORS[id];
    assert.ok(Array.isArray(connector.allowedHosts) && connector.allowedHosts.length, id + ' hosts');
    assert.ok(connector.authFields.some((field) => field.type === 'password' || field.secret), id + ' secrets');
    assert.equal(connector.reports.length, 1);
    assert.equal(connector.reports[0].dateRange, true);
    assert.ok(connector.reports[0].fields.filter((field) => field.default).length <= 12);
  }
  assert.throws(() => f.report('tiktok_ads').fetch(f.context('tiktok_ads', { advertiserId: 'abc', accessToken: 'x' }, {})), /numeric TikTok advertiser ID/);
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
