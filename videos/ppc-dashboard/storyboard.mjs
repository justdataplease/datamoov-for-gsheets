// One prompt, a whole PPC dashboard: the brief a user pasted into chat, the question chat asks
// back, the reports it runs and the designed dashboard it writes.
//
//   node videos/kit/record.mjs videos/ppc-dashboard --format all
//
// Fictional shop, fictional numbers (videos/kit/demo-fixture.mjs). The reply below quotes the
// dashboard that fixture draws, so the chat and the sheet agree on screen.

export const formats = ['square', 'portrait', 'landscape'];
export const dashboardFixture = '../kit/demo-fixture.mjs';

const BRIEF_START = 'Act as an expert PPC analyst. Build a performance dashboard with 4 sections:';
const BRIEF_REST = `

1. Account health scorecards: Spend, Conversions, CPA, ROAS, each with % change vs the previous period.
2. Campaign matrix: type, spend, conversions, CPA. Highlight CPA above 150% of target in light red and top converters in light green.
3. Keyword waste finder: keyword, match type, campaign, clicks, CTR, cost, conversions, quality score. Show high-spend keywords with zero conversions.
4. Asset effectiveness: asset type, text, impressions, conversions. Flag weak assets to replace.

Finish with an insights summary that calls out the biggest bottleneck.`;

const DASHBOARD_REPLY = {
  text:
    '**Dashboard created: Google Ads Performance Dashboard** (Demo Store US and EU, September vs August).\n\n' +
    '- Spend **USD 201,435** (▲ 5.4%), conversions **5,084** (▲ 24.4%), CPA **USD 39.62** (▼ 15.2%), ROAS **3.40**\n' +
    '- 5 campaigns run CPA above 1.5× the account, all Display and Demand Gen: red rows\n' +
    '- Keyword waste: **USD 44,538** on 163 keywords with no conversion, top 300 by cost\n' +
    '- 5 text ads click below 0.75× the average CTR: flagged to replace\n\n' +
    'Refresh it from **Reports › Dashboards**. No AI needed.',
  events: [
    {
      kind: 'report',
      text: 'Fetched Demo Store US · Daily campaign performance · Sep and Aug',
    },
    {
      kind: 'report',
      text: 'Fetched Demo Store EU · Daily campaign performance · Sep and Aug',
    },
    { kind: 'report', text: 'Fetched Demo Store US · Keywords · top 300 by cost' },
    { kind: 'report', text: 'Fetched Demo Store US · Ad assets · top 300 by impressions' },
    {
      kind: 'dashboard',
      action: 'refreshed',
      record: { id: 'dashboard-video', draft: true },
      text: 'Built "Google Ads Performance Dashboard": 7 scorecards, 3 charts, 3 tables',
    },
  ],
};

export default async function (d) {
  /* ---- Open ---- */
  await d.card({
    kicker: 'New in DataMoov for Google Sheets',
    title: 'One prompt. A complete PPC dashboard.',
    hold: 2600,
  });

  /* ---- The brief ---- */
  await d.look('app', 0);
  await d.side.locator('#tab-chat').click();
  await d.say('Paste a brief into DataMoov chat');
  await d.look('chat', 1200);
  await d.chatScript(
    [
      {
        steps: ['Reading your brief'],
        reply: {
          text: 'Which Google Ads account should this dashboard cover?',
          options: ['Demo Store US', 'Demo Store EU', 'Both accounts'],
        },
      },
      {
        steps: [
          'Fetching campaigns · Demo Store US and EU · Sep vs Aug',
          'Fetching keywords · top 300 by cost',
          'Fetching ad assets · top 300 by impressions',
          'Building the dashboard',
        ],
        reply: DASHBOARD_REPLY,
      },
    ],
    800
  );
  await d.type('#chat-input', BRIEF_START, { cps: 45, paste: BRIEF_REST });
  await d.say('Scorecards, a campaign matrix, a keyword waste finder and asset flags', 1900);
  await d.click('#chat-send');

  /* ---- It asks, then works ---- */
  await d.waitAnswers(1);
  await d.say('It asks instead of guessing', 1200);
  await d.click('.chip:has-text("Both accounts")');
  await d.hidePointer();
  await d.say('Then runs real Google Ads reports, keeping the top 300 rows that matter');
  await d.waitAnswers(2);
  await d.wait(1100);

  /* ---- The dashboard ---- */
  await d.say('And writes a finished dashboard into your sheet');
  await d.dashboard();
  for (const name of [
    'Performance Dashboard',
    'Google Ads 1 Data',
    'Google Ads 2 Data',
    'Keywords Data',
    'Assets Data',
  ])
    await d.tab(name, name === 'Performance Dashboard');
  await d.look('app', 1100);
  await d.reveal(1100);
  await d.dock(false, 900);
  await d.say('');

  const w = 1330;
  await d.section('Google Ads Performance Dashboard', {
    height: 330,
    w,
    hold: 2300,
    say: 'Scorecards with change against the previous period',
  });
  await d.section('Highlights', {
    height: 210,
    w,
    hold: 2600,
    say: 'Highlights written by rules, not AI. They update on every refresh.',
  });
  await d.section('Daily spend vs previous month', {
    height: 700,
    w,
    hold: 2000,
    say: 'Native Sheets charts, this month against last',
  });
  await d.section('Top campaigns', {
    height: 560,
    w,
    hold: 2700,
    say: 'Red: CPA over 1.5× the account. Green: the top ROAS.',
  });
  await d.section('Keyword waste: spend without conversions', {
    height: 450,
    w,
    hold: 2700,
    say: 'Keyword waste: spend with zero conversions',
  });
  await d.section('Asset performance', {
    height: 470,
    w,
    hold: 2300,
    say: 'Weak ads flagged for a refresh',
  });
  await d.say('');

  /* ---- Close ---- */
  await d.card({
    kicker: 'Refresh it any morning',
    title: 'No AI. No copy-paste. Same layout every time.',
    hold: 2500,
  });
  await d.card({
    title: 'DataMoov for Google Sheets',
    text: 'Chat with Google Ads, GA4, Meta, BigQuery and more, right in your sheet.',
    note: 'justdataplease.com · demo data',
    hold: 3200,
    stay: true,
  });
}
