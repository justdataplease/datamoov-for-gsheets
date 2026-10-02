// The whole product in about ninety seconds: connect a source, build a report by hand and
// schedule it, then skip the builder and ask chat, first for an answer, then for a dashboard.
//
//   node videos/kit/record.mjs videos/product-tour --format all
//
// Fictional shop (videos/kit/demo-fixture.mjs). The keyword tab is a real report run for that
// fixture and the dashboard its real render; chat answers quote both.

export const formats = ['landscape', 'square', 'portrait'];
export const dashboardFixture = '../kit/demo-fixture.mjs';
export const report = { type: 'keyword', tab: 'Keywords' };

const row = (keyword, match, campaign, group) => ({
  Keyword: keyword,
  'Match type': match,
  Campaign: 'Search · ' + campaign,
  'Ad group': group,
});
const PREVIEW_ROWS = [
  row('waterproof rain jacket', 'PHRASE', 'Rain jackets', 'rain jacket'),
  row('lightweight hiking boots', 'BROAD', 'Hiking boots', 'hiking boots'),
  row('best rain jacket', 'PHRASE', 'Rain jackets', 'rain jacket'),
  row('mens hiking boots', 'PHRASE', 'Hiking boots', 'hiking boots'),
  row('best sleeping bag', 'BROAD', 'Sleeping bags', 'sleeping bag'),
  row('waterproof hiking boots', 'PHRASE', 'Hiking boots', 'hiking boots'),
];

const QUESTION = 'Which campaigns spent the most last month?';
const ANSWER = {
  text:
    '**Search · Hiking boots** spent the most in September: **USD 23,881**, then PMax · All ' +
    'products (USD 20,395) and Search · Rain jackets (USD 18,457). The full ranking is in the ' +
    '**Spend by campaign** tab. (Google Ads, Demo Store US and EU)',
  events: [
    { kind: 'report', text: 'Ran Demo Store US and EU · Daily campaign performance · September' },
    { kind: 'summary', text: 'Summarized 600 rows into 20 campaigns' },
    { kind: 'write', text: 'Wrote 20 rows to Spend by campaign' },
  ],
};

const ASK_DASHBOARD =
  'Build a Google Ads dashboard: scorecards vs last month, profit, top campaigns and keyword waste.';
const DASHBOARD = {
  text:
    '**Dashboard created: Google Ads Performance Dashboard** (September vs August).\n\n' +
    '- Spend **USD 201,435** (▲ 5.4%), profit **USD 484,103** (▲ 33.5%), CPA **USD 39.62** (▼ 15.2%)\n' +
    '- 5 campaigns run CPA above 1.5× the account: red rows\n' +
    '- Keyword waste: top 300 keywords by cost, the ones with no conversion flagged\n\n' +
    'Refresh it from **Reports › Dashboards**, or schedule it. No AI needed.',
  events: [
    { kind: 'report', text: 'Fetched Demo Store US and EU · campaigns · Sep and Aug' },
    { kind: 'report', text: 'Fetched Demo Store US · Keywords · top 300 by cost' },
    {
      kind: 'dashboard',
      action: 'refreshed',
      record: { id: 'dashboard-video', draft: true },
      text: 'Built "Google Ads Performance Dashboard": 8 scorecards, 3 charts, 3 tables',
    },
  ],
};

export default async function (d) {
  /* ---- Pitch ---- */
  await d.card({
    kicker: 'DataMoov for Google Sheets',
    title: "Don't leave your beloved spreadsheet to get an answer.",
    text: 'Ask the question where you already work.',
    note: 'Marketing · CRM · Databases',
    hold: 3600,
  });

  /* ---- 1. Sources ---- */
  await d.look('app', 0);
  await d.say('Connect a source once: ads, analytics, CRM or a database');
  await d.click('#tab-connections');
  await d.look('sidebar', 1200);
  await d.wait(1200);
  await d.click('#new-connection');
  await d.wait(400);
  await d.select('#connection-provider', 'google_ads');
  await d.wait(600);
  await d.say('It tells you exactly where each credential comes from');
  await d.click('#setup-guide summary');
  await d.lookAt('#setup-guide', { h: 520 });
  await d.wait(2600);
  await d.click('#cancel-connection');

  /* ---- 2. A report, by hand ---- */
  await d.say('Build a report the familiar way: source, report, dates, tab');
  await d.click('#tab-reports');
  await d.sidebarSet('DATAMOOV_PREVIEW_REPORT_ROWS', PREVIEW_ROWS);
  await d.sidebarSet('DATAMOOV_PREVIEW_REPORT_META', {
    currency: 'USD',
    timezone: 'America/Los_Angeles',
    warnings: [],
  });
  await d.look('sidebar', 900);
  await d.click('#new-report');
  await d.wait(400);
  await d.lookAt('#report-provider', { h: 460 });
  await d.select('#report-connection', 'demo-store-us');
  await d.select('#report-type', 'keyword');
  await d.wait(500);
  await d.scrollTo('#config-top');
  await d.lookAt('#config-top', { h: 420 });
  await d.say('Keep the top 300 keywords by cost');
  await d.fill('#config-top', '300', 8);
  await d.scrollTo('#date-preset');
  await d.select('#date-preset', 'lastMonth');
  await d.scrollTo('#report-name');
  await d.lookAt('#report-name', { h: 460 });
  await d.fill('#report-name', 'Top keywords by cost', 30);
  await d.fill('#target-sheet', 'Keywords', 24);

  await d.say('Schedule it: every day at 07:00');
  await d.scrollTo('#report-schedule');
  await d.lookAt('#report-schedule', { h: 440 });
  await d.select('#report-schedule', 'daily');
  await d.select('#refresh-hour', '7');
  await d.wait(1300);
  await d.scrollTo('#save-report');
  await d.click('#save-report');
  await d.sidebarSet('DATAMOOV_PREVIEW_RUN_ROWS', 300);
  await d.say('Run it, and the rows land in your sheet');
  await d.lookAt('.report-card', { h: 360, ms: 1000 });
  await d.click('.report-card button:has-text("Run")');
  await d.wait(900);
  await d.hidePointer();
  await d.dashboard('report');
  await d.tab('Keywords', true);
  await d.look('app', 1000);
  await d.reveal(1000);
  const sheet = await d.stage('rect', 'sheet');
  await d.look({ x: sheet.x, y: sheet.y, w: 1000, h: 560 }, 1200);
  await d.wait(2000);
  await d.say('');

  /* ---- 3. Chat ---- */
  await d.card({ title: 'Or skip the builder. Just ask.', logo: false, hold: 2000 });
  await d.chatScript(
    [
      { steps: ['Fetching campaigns · Demo Store US and EU', 'Summarizing'], reply: ANSWER },
      {
        steps: [
          'Fetching campaigns · Sep vs Aug',
          'Fetching keywords · top 300 by cost',
          'Building the dashboard',
        ],
        reply: DASHBOARD,
      },
    ],
    800
  );
  await d.click('#tab-chat');
  await d.look('chat', 0);
  await d.say('Ask in plain words');
  await d.type('#chat-input', QUESTION, { cps: 40 });
  await d.click('#chat-send');
  await d.hidePointer();
  await d.waitAnswers(1);
  await d.say('The answer, with every step it took');
  await d.wait(2600);

  await d.say('Or ask for a whole dashboard');
  await d.type('#chat-input', ASK_DASHBOARD, { cps: 48 });
  await d.click('#chat-send');
  await d.hidePointer();
  await d.waitAnswers(2);
  await d.wait(1200);
  await d.dashboard();
  await d.tab('Performance Dashboard', true);
  await d.say('Scorecards, charts and flagged rows, written into your sheet');
  await d.look('app', 1000);
  await d.reveal(1000);
  await d.dock(false, 800);
  await d.section('Google Ads Performance Dashboard', { height: 520, w: 1330, hold: 2600 });
  await d.section('Top campaigns', {
    height: 560,
    w: 1330,
    hold: 2600,
    say: 'Red: CPA over 1.5× the account. Green: the top ROAS.',
  });

  /* ---- 4. Schedules ---- */
  await d.dock(true, 800);
  await d.click('#tab-reports');
  await d.say('Reports and dashboards refresh on schedule. No AI needed.');
  await d.look('sidebar', 1100);
  await d.lookAt('.report-card', { h: 380, ms: 1000 });
  await d.wait(2800);
  await d.say('');

  await d.card({
    kicker: 'Marketing · CRM · Databases',
    title: 'Your data, in your sheet, every morning.',
    hold: 2600,
  });
  await d.card({
    title: 'DataMoov for Google Sheets',
    text: 'Google Ads, GA4, Meta, LinkedIn, HubSpot, BigQuery and more.',
    note: 'justdataplease.com · demo data',
    hold: 3400,
    stay: true,
  });
}
