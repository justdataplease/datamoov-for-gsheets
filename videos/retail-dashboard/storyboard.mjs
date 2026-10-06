// From an empty sheet to a formula dashboard: chat generates 1,000 rows of retail orders with one
// formula and pastes them as values, then builds a Dashboard tab of KPI formulas over whole
// Sheet1 columns, two native pivots and a chart over each.
//
//   node videos/kit/record.mjs videos/retail-dashboard --format all
//
// The tool sequence is the real one (live replays of commit 671ad74): one set_formulas
// generating formula, copy_range values (whose result says pasted values keep no date format),
// the Date column as numberFormat date (yyyy-mm-dd), freeze, format calls (the header, and
// Revenue as currency without a code, #,##0.00); then list_sheets, inspect_sheet, create_sheet, set_formulas
// KPIs, create_pivot twice, create_chart over each chartRange and format calls. The shop is
// fictional (./sheets.mjs); the replies quote the rendered Dashboard as Sheets shows it: revenue
// 134,543.45, 1000 orders, 2520 units, average order 134.54, Electronics 61,659.60 in its pivot.
import { buildSheets, GENERATOR, KPIS, orders } from './sheets.mjs';

export const formats = ['square', 'portrait', 'landscape'];
export const prepare = buildSheets;

const DATA_ASK = 'Generate 1000 rows of realistic retail store data in Sheet1';
const DASHBOARD_ASK = 'Create a performance dashboard';

const DATA_DONE = {
  text:
    '**Done.** 1000 rows of retail orders in **Sheet1!A1:I1001**, written by one formula, ' +
    'then pasted as values so the random numbers stay put.\n\n' +
    '- Order ID, Date, Store, Department, Product, Customer, Payment, Units, Revenue\n' +
    '- 5 stores, 5 departments, 15 products, April to August 2026\n' +
    "- Revenue is units times the department's price, give or take 15%\n" +
    '- Dates as yyyy-mm-dd, header row formatted and frozen, Revenue with two decimals',
  events: [
    { kind: 'summary', text: 'Inspected Sheet1!A1:I1' },
    { kind: 'write', text: 'Updated Sheet1!A1' },
    { kind: 'write', text: 'Copied Sheet1!A1:I1001 to Sheet1!A1:I1001 (values)' },
    { kind: 'write', text: 'Updated Sheet1!B2:B1001' },
    { kind: 'write', text: 'Updated Sheet1' },
    { kind: 'write', text: 'Updated Sheet1!A1:I1' },
    { kind: 'write', text: 'Updated Sheet1!I2:I1001' },
  ],
};

const DASHBOARD_DONE = {
  text:
    '**Dashboard created** on a new **Dashboard** tab, live formulas and native pivots over Sheet1:\n\n' +
    '- Revenue **134,543.45** from **1000** orders, **2520** units, average order **134.54**\n' +
    '- Pivots of revenue by department and by store: **Electronics** leads with **61,659.60**\n' +
    '- A column chart over each pivot\n\n' +
    'The KPIs read whole columns, so they follow Sheet1 as it changes.',
  events: [
    { kind: 'summary', text: 'Listed available spreadsheet tabs' },
    { kind: 'summary', text: 'Inspected Sheet1!A1:I5' },
    { kind: 'write', text: 'Created tab Dashboard' },
    { kind: 'write', text: 'Updated Dashboard!A1:D4' },
    { kind: 'write', text: 'Created a native pivot table at Dashboard!A7 from Sheet1!A1:I1001' },
    { kind: 'write', text: 'Created a native pivot table at Dashboard!D7 from Sheet1!A1:I1001' },
    { kind: 'chart', text: 'Added a column chart "Revenue by department" on Dashboard' },
    { kind: 'chart', text: 'Added a column chart "Revenue by store" on Dashboard' },
    { kind: 'write', text: 'Updated Dashboard!A3:D3' },
    { kind: 'write', text: 'Updated Dashboard!A4:D4' },
    { kind: 'write', text: 'Updated Dashboard!A4:B4' },
    { kind: 'write', text: 'Updated Dashboard!A7:E7' },
  ],
};

const EDIT = 'Updating the spreadsheet';

export default async function (d) {
  await d.stage('title', 'Retail store sales');
  await d.card({
    kicker: 'New in DataMoov for Google Sheets',
    title: 'Ask for a dashboard. Never leave the sheet.',
    hold: 2500,
  });

  // Wipes the tab off and loads the next one, so no frame shows a page half loaded.
  const swap = async (name) => {
    await d.reveal(300, false);
    await d.dashboard(name);
  };

  // Room under the shot for the caption, in landscape too, where the camera otherwise fills the
  // frame.
  const roomy = { reserve: Math.max(d.format.reserve, 0.16) };

  /* ---- Ask for data ---- */
  await d.chatScript(
    [
      {
        steps: ['Inspecting selected cells', EDIT, EDIT, EDIT, EDIT, EDIT, EDIT],
        reply: DATA_DONE,
      },
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
        reply: DASHBOARD_DONE,
      },
    ],
    360
  );
  await d.say('Start from an empty sheet. Ask for data.');
  await d.look('app', 0);
  await d.wait(700);
  await d.click('#tab-chat');
  await d.look('chat', 1000);
  await d.type('#chat-input', DATA_ASK, { cps: 55 });
  await d.click('#chat-send');
  await d.hidePointer();
  await d.say('');
  await d.waitAnswers(1);
  await d.wait(1300);

  /* ---- One formula, then values ---- */
  await d.dashboard('data-formula');
  await Promise.all([d.look('app', 1000), d.reveal(1000)]);
  await d.cell('A1', GENERATOR);
  await d.hidePointer();
  const bar = await d.stage('rect', 'fbar');
  const sheet = await d.stage('rect', 'sheet');
  await d.say('One formula writes all 1000 rows');
  await d.look({ x: bar.x, y: bar.y - 8, w: bar.w, h: bar.h + 220 }, 1000);
  await d.wait(1100);
  await d.look({ x: bar.x, y: bar.y - 8, w: 620, h: bar.h + 70 }, 1100);
  await d.wait(2300);

  // The formula view wipes off as the camera pulls back, and the pasted values wipe in scrolled
  // to the end, header frozen: row 1001 holds a plain value, no formula. No caption over the
  // empty sheet between them: it fades out before the wipe starts.
  await d.say('', 400);
  await Promise.all([
    d.look({ x: sheet.x, y: bar.y - 8, w: 920, h: 520 }, 1100, roomy),
    swap('data-end').then(async () => {
      await d.stage('formula', 'A1', 'Order ID');
      await d.reveal(700);
    }),
  ]);
  await d.say('Then pasted as values, so the random numbers stay put');
  await d.cell('I1001', String(orders()[999][8]));
  await d.wait(2200);
  await d.hidePointer();

  /* ---- Ask for a dashboard ---- */
  await d.say('Now ask for a dashboard');
  await d.look('chat', 1000);
  await d.type('#chat-input', DASHBOARD_ASK, { cps: 36 });
  await d.click('#chat-send');
  await d.hidePointer();
  await d.say('');
  await d.waitAnswers(2);
  await d.wait(1600);

  /* ---- The dashboard ---- */
  await d.tab('Dashboard', true);
  await Promise.all([d.look('app', 1000), swap('dashboard')]);
  await d.stage('formula', 'A1', 'Retail performance');
  await d.reveal(1000);
  await d.dock(false, 900);
  const all = await d.stage('cellBox', 'A1:L33');
  await d.say('A new Dashboard tab: KPIs, two pivots, two charts');
  await d.look({ x: all.x - 46, y: bar.y - 8, w: all.w + 60, h: all.y + all.h - bar.y }, 1100, {
    band: true,
  });
  await d.wait(2000);

  // The push-in to the KPIs; its caption lands once the camera is there. Landscape closes on the
  // four, Units sold whole at the right edge, and ends at the pivots (row 7), so the caption lies
  // on the blank rows between; square and portrait frame columns A to E with a row header's width
  // to spare either side, so it lies on row 14, between the pivot tables and the charts.
  const roomBelow = d.format.reserve > 0;
  const close = await d.stage('cellBox', roomBelow ? 'A1:E5' : 'A1:D5');
  const pivotHead = await d.stage('cellBox', 'A7');
  await d.say('');
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
  await d.say('Every KPI is a live formula over Sheet1');
  await d.cell('A4', KPIS[0].formula);
  await d.wait(2300);
  await d.cell('B4', KPIS[1].formula);
  await d.say('Whole columns, so they keep up as the data grows');
  await d.wait(2200);
  await d.hidePointer();

  // The caption names the pivots once the camera is on them.
  const pivot = await d.stage('cellBox', 'A6:L32');
  await d.say('');
  await d.look({ x: pivot.x - 46, y: pivot.y - 10, w: pivot.w + 60, h: pivot.h + 20 }, 1200, {
    band: true,
  });
  await d.say('Native pivots by department and store, a chart over each');
  await d.wait(2600);
  await d.say('');

  /* ---- Close: the end card follows on black ---- */
  await d.card({
    kicker: 'Live formulas · native pivots · charts',
    title: 'Same dashboard at 100,000 rows.',
    hold: 2400,
    stay: true,
  });
  await d.card({
    title: 'DataMoov for Google Sheets',
    text: 'Chat with your data and your spreadsheet, right where you work.',
    note: 'justdataplease.com · demo data',
    hold: 2800,
    stay: true,
  });
}
