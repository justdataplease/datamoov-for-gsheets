// The product end to end in one take: connect a source, build and run a report, ask chat, get
// a saved Google Ads dashboard, then have chat build a dashboard of live formulas over a tab. One
// camera carries every beat into the next (no cuts, no cards in between): it pushes in as the
// opening card lifts, glides from the sidebar to the sheet as rows land, drifts through the
// holds, and pulls out under the end card.
//
//   node videos/kit/record.mjs videos/product-tour-2 --format all
//
// Fictional shop (videos/kit/demo-fixture.mjs, and ./sheets.mjs for its Orders tab). The Keywords
// tab is a real report run for that fixture and the Google Ads dashboard its real render. Every
// chat turn shows the real tool steps and event texts of commit 671ad74: the question runs the
// campaign report of each account (450 and 150 September rows), combines and summarizes them; the
// Google Ads dashboard is save_dashboard then run_dashboard over the plan's six datasets (row
// counts as tools/dashboard-preview.mjs fetches them); the formula dashboard follows the live
// replays (list_sheets, inspect_sheet, create_sheet, KPI set_formulas, create_pivot twice,
// create_chart over each, format calls). Chat answers quote what is rendered: Search · Hiking
// boots USD 23,881 in Top campaigns; the dashboard's scorecards; on the formula dashboard, as
// Sheets shows it, revenue 281,682.20 (chat formats KPI amounts #,##0.00), 1000 orders, average
// 281.68, and Tents $91,269.60 in its pivot (a pivot keeps the user's dollar format of Orders).
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { buildSheets, KPIS } from './sheets.mjs';

export const formats = ['square', 'portrait', 'landscape'];
export const dashboardFixture = '../kit/demo-fixture.mjs';
export const report = { type: 'keyword', tab: 'Keywords' };

// The dashboard render also writes the fixture's data tabs (data-*.html), which this video never
// shows; they go, so only pages on screen are in the render folder.
export async function prepare(dir) {
  for (const name of await readdir(dir))
    if (name.startsWith('data-')) await rm(path.join(dir, name));
  return buildSheets(dir);
}

const QUESTION = 'Which campaigns spent the most last month?';
const ANSWER = {
  text:
    '**Search · Hiking boots** spent the most in September: **USD 23,881**, then PMax · All ' +
    'products (USD 20,395) and Search · Rain jackets (USD 18,457). (Google Ads, Demo Store US ' +
    'and EU)',
  events: [
    {
      kind: 'report',
      text: 'Ran Google Ads (Demo Store US) · Daily campaign performance · 450 rows',
    },
    {
      kind: 'report',
      text: 'Ran Google Ads (Demo Store EU) · Daily campaign performance · 150 rows',
    },
    { kind: 'summary', text: 'Combined 2 results into 600 rows' },
    { kind: 'summary', text: 'Summarized 600 rows into 20' },
  ],
};

const ADS_ASK = 'Build a Google Ads dashboard vs last month';
// Chat saves a dashboard as a draft unless the user asked for a schedule.
const DRAFT = { id: 'dashboard-video', draft: true };
const ADS_DONE = {
  text:
    '**Dashboard created: Google Ads Performance Dashboard** (September vs August).\n\n' +
    '- Spend **USD 201,435** (▲ 5.4%), CPA **USD 39.62** (▼ 15.2%)\n' +
    '- 5 campaigns run CPA above 1.5× the account: red rows\n' +
    '- Keyword waste: the top 300 keywords by cost, no-conversion ones flagged\n\n' +
    'It is a draft under **Reports › Dashboards**: save it, then refresh or schedule it. ' +
    'No AI needed.',
  events: [
    {
      kind: 'dashboard',
      action: 'saved',
      record: DRAFT,
      text:
        'Saved dashboard draft "Google Ads Performance Dashboard" with 6 datasets and 3 charts. ' +
        'Listed under Reports > Drafts.',
    },
    ...[
      ['Demo Store US', 450, 'Google Ads 1 Data'],
      ['Demo Store EU', 150, 'Google Ads 2 Data'],
      ['Demo Store US previous month', 465, 'Google Ads 1 Previous'],
      ['Demo Store EU previous month', 155, 'Google Ads 2 Previous'],
      ['Demo Store US keywords', 300, 'Keywords Data'],
      ['Demo Store US assets', 140, 'Assets Data'],
    ].map(([label, rows, tab]) => ({
      kind: 'report',
      text: `Fetched ${label} · ${rows} rows into ${tab}`,
    })),
    {
      kind: 'dashboard',
      action: 'refreshed',
      record: DRAFT,
      text: 'Built "Google Ads Performance Dashboard" on Performance Dashboard: 3 charts, 8 scorecards.',
    },
  ],
};

const FORMULA_ASK = 'Create a performance dashboard from Orders';
const FORMULA_DONE = {
  text:
    '**Dashboard created** on a new **Dashboard** tab, live formulas and native pivots over Orders:\n\n' +
    '- Revenue **281,682.20** from **1000** orders, average order **281.68**\n' +
    '- Pivots of revenue by category and by channel: **Tents** lead with **$91,269.60**\n' +
    '- A column chart over each pivot\n\n' +
    'The KPIs read whole columns, so they follow Orders as it grows.',
  events: [
    { kind: 'summary', text: 'Listed available spreadsheet tabs' },
    { kind: 'summary', text: 'Inspected Orders!A1:G5' },
    { kind: 'write', text: 'Created tab Dashboard' },
    { kind: 'write', text: 'Updated Dashboard!A1:D4' },
    { kind: 'write', text: 'Created a native pivot table at Dashboard!A7 from Orders!A1:G1001' },
    { kind: 'write', text: 'Created a native pivot table at Dashboard!D7 from Orders!A1:G1001' },
    { kind: 'chart', text: 'Added a column chart "Revenue by category" on Dashboard' },
    { kind: 'chart', text: 'Added a column chart "Revenue by channel" on Dashboard' },
    { kind: 'write', text: 'Updated Dashboard!A3:D3' },
    { kind: 'write', text: 'Updated Dashboard!A4:D4' },
    { kind: 'write', text: 'Updated Dashboard!A4:B4' },
    { kind: 'write', text: 'Updated Dashboard!A7:E7' },
  ],
};

const EDIT = 'Updating the spreadsheet';

// Runs `first` and, `ms` into it, `then`: the camera sets off before the thing it goes to see.
const lead = (first, ms, then) =>
  Promise.all([first, new Promise((r) => setTimeout(r, ms)).then(then)]);

export default async function (d) {
  /* ---- Open: the card first; the sheet is set up under it ---- */
  await d.stage('card', {
    kicker: 'A tour of DataMoov for Google Sheets',
    title: "Don't leave your beloved spreadsheet to get an answer.",
  });
  const opened = Date.now();
  await d.stage('title', 'Demo Store');
  await d.stage('setTabs', ['Orders'], 'Orders');
  await d.dashboard('orders');
  await d.reveal(1);
  await d.chatScript(
    [
      {
        steps: [
          'Fetching report data',
          'Fetching report data',
          'Combining report results',
          'Summarizing data',
        ],
        reply: ANSWER,
      },
      { steps: ['Saving the dashboard plan', 'Refreshing dashboard sources'], reply: ADS_DONE },
      {
        steps: [
          'Checking spreadsheet tabs',
          'Inspecting selected cells',
          EDIT,
          EDIT,
          'Creating a pivot table',
          'Creating a pivot table',
          'Creating a chart',
          'Creating a chart',
          EDIT,
          EDIT,
          EDIT,
          EDIT,
        ],
        reply: FORMULA_DONE,
      },
    ],
    240
  );
  const sheet = await d.stage('rect', 'sheet');
  const tabView = { x: sheet.x, y: sheet.y - 40, w: 940, h: 540 };
  // Wipes the tab off and loads the next one, while the camera is already on its way.
  const swap = async (name) => {
    await d.reveal(300, false);
    await d.dashboard(name);
  };
  await d.look({ x: -120, y: -80, w: 1840, h: 1160 }, 0);
  await d.wait(Math.max(0, 2500 - (Date.now() - opened)));

  // The card lifts off the whole app, the camera already moving.
  await d.stage('card', { show: false });
  await d.say('Your spreadsheet, with DataMoov docked beside it');
  await d.look('app', 1800, { ease: 'out' });

  /* ---- 1. A source: quick beats in the sidebar ---- */
  await d.click('#tab-connections');
  await d.say('Connect a source once: ads, analytics, CRM or a database');
  await d.look('sidebar', 800);
  await d.click('#new-connection');
  await d.lookAt('#connection-provider', { h: 520, ms: 700 });
  await d.drift(1000, 1.04);

  /* ---- 2. A report, run into a new tab ---- */
  await d.click('#tab-reports');
  await d.say('Build a report: source, report, tab');
  await d.look('sidebar', 700);
  await d.click('#new-report');
  await d.lookAt('#report-type', { h: 460, ms: 700 });
  await d.select('#report-type', 'keyword');
  await d.scrollTo('#target-sheet');
  await d.lookAt('#target-sheet', { h: 460, ms: 600 });
  await d.fill('#target-sheet', 'Keywords', 40);
  await d.scrollTo('#save-report');
  await d.click('#save-report');
  await d.sidebarSet('DATAMOOV_PREVIEW_RUN_ROWS', 300);
  await d.lookAt('.report-card', { h: 360, ms: 600 });
  await d.click('.report-card button:has-text("Run")');
  await d.hidePointer();
  // The camera sets off for the sheet as the run starts; the new tab fills on the way, and the
  // caption waits for its rows: over the empty sheet of the switch it would name nothing.
  await d.tab('Keywords', true);
  await d.say('');
  await Promise.all([d.look(tabView, 1400), swap('report').then(() => d.reveal(1000))]);
  await d.say('Run it, and the rows land in a new tab');
  await d.drift(2000, 1.05);

  /* ---- 3. Ask ---- */
  await d.say('Or skip the builder and just ask');
  await lead(d.look('chat', 1100), 300, () => d.click('#tab-chat'));
  await d.type('#chat-input', QUESTION, { cps: 60 });
  await d.click('#chat-send');
  await d.hidePointer();
  await d.waitAnswers(1);
  await d.say('An answer, with every step it took');
  await d.drift(2000, 1.05);

  /* ---- 4. A saved Google Ads dashboard ---- */
  await d.say('Or ask for a whole dashboard');
  await d.look('chat', 600);
  await d.type('#chat-input', ADS_ASK, { cps: 60 });
  await d.click('#chat-send');
  await d.hidePointer();
  await d.waitAnswers(2);
  // The caption waits for the dashboard, and is gone before the push-in, so it never lies on the
  // sheet: over the whole app it sits on the black below it.
  await d.tab('Performance Dashboard', true);
  await d.say('');
  await Promise.all([d.look('app', 1200, { band: true }), swap('dashboard')]);
  await Promise.all([d.reveal(1000), d.dock(false, 900)]);
  await d.say('A saved Google Ads dashboard, written into your sheet');
  await d.wait(1800);
  await d.say('');
  await d.section('Google Ads Performance Dashboard', { height: 520, w: 1330, ms: 1000 });
  await d.drift(1300, 1.04);
  await d.section('Top campaigns', {
    height: 560,
    w: 1330,
    ms: 1300,
    say: 'Refresh or schedule it from Reports. No AI needed.',
  });
  await d.drift(1500, 1.04);

  /* ---- 5. A formula dashboard over a tab ---- */
  // The caption waits for the tab: over the empty sheet of the switch it would name nothing.
  await d.activate('Orders');
  await d.say('');
  await Promise.all([d.dock(true, 900), d.look(tabView, 1200), swap('orders')]);
  await d.reveal(700);
  await d.say('Data already in a tab? Here, 1000 orders.');
  await d.drift(1600, 1.03);
  await d.say('Ask for a dashboard over it');
  await d.look('chat', 1000);
  await d.type('#chat-input', FORMULA_ASK, { cps: 60 });
  await d.click('#chat-send');
  await d.hidePointer();
  await d.waitAnswers(3);
  await d.say('KPI formulas, two pivots, two charts');
  await d.drift(1300, 1.04);

  await d.tab('Dashboard', true);
  await d.say('');
  await Promise.all([d.look('app', 1100), swap('formula-dashboard')]);
  await d.stage('formula', 'A1', 'Demo Store orders');
  await Promise.all([d.reveal(900), d.dock(false, 900)]);
  await d.say('A new tab of live formulas and native pivots');
  await d.drift(1500, 1.03);
  // The push-in to the KPIs. Landscape closes on the four, Units sold whole at the right edge, and
  // ends at the pivots (row 7), so the caption lies on the blank rows between; square and portrait
  // frame columns A to E with a row header's width to spare either side, so it lies on row 14,
  // between the pivot tables and the charts.
  const bar = await d.stage('rect', 'fbar');
  const roomBelow = d.format.reserve > 0;
  const close = await d.stage('cellBox', roomBelow ? 'A1:E5' : 'A1:D5');
  const pivotHead = await d.stage('cellBox', 'A7');
  await d.look(
    {
      x: bar.x,
      y: bar.y - 8,
      w: close.x + close.w + (roomBelow ? 46 : 16) - bar.x,
      h: close.y + close.h - bar.y + 8,
    },
    1100,
    { floor: pivotHead.y }
  );
  await d.cell('A4', KPIS[0].formula);
  await d.hidePointer();
  await d.say('Every KPI is a formula you can read');
  await d.drift(1600, 1.04);

  // Pulls back over the whole tab, and on out under the end card.
  const all = await d.stage('cellBox', 'A1:L33');
  await d.say('Whole columns and native pivots: the same at 100,000 rows');
  await d.look({ x: all.x - 46, y: bar.y - 8, w: all.w + 60, h: all.y + all.h - bar.y }, 1300, {
    band: true,
  });
  await d.drift(2000, 0.97);
  await d.say('');
  await lead(d.look({ x: -200, y: -130, w: 2000, h: 1260 }, 1800, { ease: 'in' }), 900, () =>
    d.card({
      title: 'DataMoov for Google Sheets',
      text: 'Connect, report, ask and build dashboards, right where you work.',
      note: 'justdataplease.com · demo data',
      hold: 3000,
      stay: true,
    })
  );
}
