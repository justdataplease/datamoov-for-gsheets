// Manual reports and scheduling: build a Google Ads keyword report in the sidebar the familiar
// way (source, report, top rows, dates, tab), preview it, schedule it daily at 07:00 and watch
// the rows land. No chat, no AI.
//
//   node videos/kit/record.mjs videos/manual-reports --format all
//
// Fictional shop (videos/kit/demo-fixture.mjs). The tab is what a real report run writes for that
// fixture (tools/dashboard-preview.mjs --report keyword); the builder's preview shows its first
// rows, read off that render.

export const formats = ['square', 'portrait', 'landscape'];
export const report = { type: 'keyword', tab: 'Keywords' };

const row = (keyword, match, campaign, group, clicks, impressions, ctr, cost, conversions, qs) => ({
  Keyword: keyword,
  'Match type': match,
  Campaign: 'Search · ' + campaign,
  'Ad group': group,
  Clicks: clicks,
  Impressions: impressions,
  CTR: ctr,
  Spend: cost,
  Cost: cost,
  Conversions: conversions,
  'Quality score': qs,
  'Keyword status': 'ENABLED',
});
const PREVIEW_ROWS = [
  row(
    'waterproof rain jacket',
    'PHRASE',
    'Rain jackets',
    'rain jacket',
    1542,
    14826,
    0.104,
    12158.93,
    10.71,
    5
  ),
  row(
    'lightweight hiking boots',
    'BROAD',
    'Hiking boots',
    'hiking boots',
    1179,
    13175,
    0.0895,
    10102.23,
    10.39,
    6
  ),
  row(
    'best rain jacket',
    'PHRASE',
    'Rain jackets',
    'rain jacket',
    1554,
    15936,
    0.0975,
    9957.13,
    4.67,
    8
  ),
  row(
    'mens hiking boots',
    'PHRASE',
    'Hiking boots',
    'hiking boots',
    939,
    10924,
    0.086,
    8253.79,
    6.25,
    4
  ),
  row(
    'best sleeping bag',
    'BROAD',
    'Sleeping bags',
    'sleeping bag',
    637,
    9070,
    0.0702,
    7813.32,
    3.33,
    6
  ),
  row(
    'waterproof hiking boots',
    'PHRASE',
    'Hiking boots',
    'hiking boots',
    511,
    8268,
    0.0618,
    6790.55,
    6.92,
    8
  ),
  row(
    'lightweight rain jacket',
    'PHRASE',
    'Rain jackets',
    'rain jacket',
    700,
    6426,
    0.1089,
    6206.88,
    5.89,
    9
  ),
  row(
    'mens hiking backpack',
    'EXACT',
    'Backpacks',
    'hiking backpack',
    577,
    5274,
    0.1094,
    5685.69,
    3.45,
    4
  ),
];

export default async function (d) {
  await d.card({
    kicker: 'DataMoov for Google Sheets',
    title: 'Build a report once. It refreshes itself.',
    hold: 2600,
  });

  /* ---- The builder ---- */
  await d.look('app', 0);
  await d.click('#tab-reports');
  await d.sidebarSet('DATAMOOV_PREVIEW_REPORT_ROWS', PREVIEW_ROWS);
  await d.sidebarSet('DATAMOOV_PREVIEW_REPORT_META', {
    currency: 'USD',
    timezone: 'America/Los_Angeles',
    warnings: [],
  });
  await d.say('No code, no AI: pick a source and a report');
  await d.look('sidebar', 1200);
  await d.click('#new-report');
  await d.wait(500);
  await d.lookAt('#report-provider', { h: 460 });
  await d.select('#report-provider', 'google_ads');
  await d.wait(500);
  await d.select('#report-connection', 'demo-store-us');
  await d.wait(400);
  await d.select('#report-type', 'keyword');
  await d.wait(700);

  await d.say('Keep the top 300 rows by cost, the ones worth acting on');
  await d.scrollTo('#config-top');
  await d.lookAt('#config-top', { h: 420 });
  await d.fill('#config-top', '300', 8);
  await d.wait(1300);

  await d.say('Choose the dates and the tab it writes to');
  await d.scrollTo('#date-preset');
  await d.lookAt('#date-preset', { h: 420 });
  await d.select('#date-preset', 'lastMonth');
  await d.wait(600);
  await d.scrollTo('#report-name');
  await d.lookAt('#report-name', { h: 460 });
  await d.fill('#report-name', 'Top keywords by cost', 26);
  await d.fill('#target-sheet', 'Keywords', 20);
  await d.wait(700);

  /* ---- Schedule ---- */
  await d.say('Schedule it: every day at 07:00 (or hourly, or weekly)');
  await d.scrollTo('#report-schedule');
  await d.lookAt('#report-schedule', { h: 440 });
  await d.select('#report-schedule', 'daily');
  await d.wait(500);
  await d.select('#refresh-hour', '7');
  await d.wait(1500);

  /* ---- Preview, then save ---- */
  await d.say('Preview the rows before a single cell is touched');
  await d.scrollTo('#preview-report');
  await d.click('#preview-report');
  await d.side.locator('#data-preview').waitFor({ state: 'visible' });
  await d.scrollTo('#data-preview');
  await d.lookAt('#data-preview', { h: 520 });
  await d.wait(2400);

  await d.say('Save it');
  await d.scrollTo('#save-report');
  await d.click('#save-report');
  await d.sidebarSet('DATAMOOV_PREVIEW_RUN_ROWS', 300);
  await d.say('Run it now, and the rows land in the tab you named');
  await d.lookAt('.report-card', { h: 360, ms: 1000 });
  await d.click('.report-card button:has-text("Run")');
  await d.wait(900);
  await d.hidePointer();
  await d.dashboard('report');
  await d.tab('Keywords', true);
  await d.look('app', 1100);
  await d.reveal(1100);
  await d.wait(900);
  const sheet = await d.stage('rect', 'sheet');
  await d.say('300 keywords, ranked by cost, in your own sheet');
  await d.look({ x: sheet.x, y: sheet.y, w: 1000, h: 560 }, 1300);
  await d.wait(2600);

  /* ---- The saved report ---- */
  await d.say('Your report, its schedule and the next run, in one place');
  await d.lookAt('.report-card', { h: 360, ms: 1200 });
  await d.wait(2800);
  await d.say('');

  await d.card({
    kicker: 'Every morning at 07:00',
    title: 'Fresh data waiting. Nothing to copy.',
    hold: 2600,
  });
  await d.card({
    title: 'DataMoov for Google Sheets',
    text: 'Google Ads, GA4, Meta, LinkedIn, BigQuery and more, right in your sheet.',
    note: 'justdataplease.com · demo data',
    hold: 3200,
    stay: true,
  });
}
