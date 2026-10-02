// Calculated metrics: ask for the numbers you actually track (profit, net ROAS after fees) and
// the dashboard computes them from its own totals, on every refresh, without AI.
//
//   node videos/kit/record.mjs videos/calculated-metrics --format all
//
// Fictional shop (videos/kit/demo-fixture.mjs). The reply quotes the dashboard that fixture
// draws: profit 685,538 - 201,435 = 484,103 (up 33.5%), net ROAS 3.40 / 1.05 = 3.24.

export const formats = ['square', 'portrait', 'landscape'];
export const dashboardFixture = '../kit/demo-fixture.mjs';

const ASK =
  'Build my Google Ads dashboard for last month and add profit (conversion value minus spend) ' +
  'and net ROAS after our 5% payment fee.';

const REPLY = {
  text:
    '**Dashboard created with 2 calculated metrics** (Demo Store US and EU, September vs August).\n\n' +
    '- **Profit** = conversion value − spend: **USD 484,103**, ▲ 33.5%\n' +
    '- **Net ROAS** = conversion value ÷ 1.05 ÷ spend: **3.24** overall, per campaign in Top campaigns\n\n' +
    'Both are recalculated from the totals on every refresh. No AI needed.',
  events: [
    { kind: 'report', text: 'Fetched Demo Store US · Daily campaign performance · Sep and Aug' },
    { kind: 'report', text: 'Fetched Demo Store EU · Daily campaign performance · Sep and Aug' },
    {
      kind: 'dashboard',
      action: 'refreshed',
      record: { id: 'dashboard-video', draft: true },
      text: 'Built "Google Ads Performance Dashboard" with formulas profit and net_roas',
    },
  ],
};

export default async function (d) {
  await d.card({
    kicker: 'New in DataMoov for Google Sheets',
    title: 'Your own metrics, calculated live.',
    hold: 2600,
  });

  /* ---- The ask ---- */
  await d.look('app', 0);
  await d.click('#tab-chat');
  await d.say('Ask for the numbers you actually track');
  await d.look('chat', 1200);
  await d.chatScript(
    [
      {
        steps: [
          'Fetching campaigns · Demo Store US and EU · Sep vs Aug',
          'Adding formulas · profit, net ROAS',
          'Building the dashboard',
        ],
        reply: REPLY,
      },
    ],
    900
  );
  await d.type('#chat-input', ASK, { cps: 42 });
  await d.wait(500);
  await d.click('#chat-send');
  await d.hidePointer();
  await d.say('The AI writes the formula. DataMoov does the maths.');
  await d.waitAnswers(1);
  await d.wait(2200);

  /* ---- The dashboard ---- */
  await d.say('');
  await d.dashboard();
  for (const name of ['Performance Dashboard', 'Google Ads 1 Data', 'Google Ads 2 Data'])
    await d.tab(name, name === 'Performance Dashboard');
  await d.look('app', 1100);
  await d.reveal(1100);
  await d.dock(false, 900);

  await d.section('Google Ads Performance Dashboard', {
    height: 330,
    w: 1330,
    hold: 2000,
    say: 'A Profit scorecard beside your usual metrics',
  });
  await d.section('Google Ads Performance Dashboard', {
    x: 960,
    w: 520,
    height: 330,
    hold: 2600,
    say: 'Profit = conversion value − spend, with change vs last month',
  });
  await d.section('Highlights', {
    height: 210,
    w: 1330,
    hold: 2400,
    say: 'Highlights pick it up: profit rose 33.5%',
  });
  await d.section('Top campaigns', {
    x: 560,
    w: 780,
    height: 470,
    hold: 3000,
    say: 'Net ROAS after the 5% fee, per campaign and as a true total',
  });
  await d.say('');

  /* ---- Close ---- */
  await d.card({
    kicker: 'Profit, margin, blended CPA, net ROAS',
    title: 'Recalculated on every refresh. No AI needed.',
    hold: 2700,
  });
  await d.card({
    title: 'DataMoov for Google Sheets',
    text: 'Chat with Google Ads, GA4, Meta, BigQuery and more, right in your sheet.',
    note: 'justdataplease.com · demo data',
    hold: 3200,
    stay: true,
  });
}
