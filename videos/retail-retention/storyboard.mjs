// Two prompts on an empty spreadsheet: chat generates 10,000 orders of a clothing shop with one
// formula and freezes them as values, then saves and refreshes a customer retention and
// segmentation dashboard over that tab. Every step on screen, the middle tab included.
//
//   node videos/kit/record.mjs videos/retail-retention --format all
//
// The story is run 3 of a live replay of both prompts through the real chat code (gemini-3.8-flash,
// production 6a9c148): its tool steps, its event texts, its generating formula and its
// save_dashboard plan, word for word. Turn 1: list_sheets, create_sheet, set_formulas (failed on a
// missing bracket, then retried), copy_range as values, format ×3, freeze. Turn 2: list_dashboards,
// inspect_sheet ×2, save_dashboard, run_dashboard. The dashboard engine wrote two tabs: Retention
// Dashboard (85 formulas) and a hidden "(chart data)" tab of SUMIFS feeding the charts; chat made
// no tab of its own in between. The data is fictional (./sheets.mjs) and the dashboard is the real
// engine's refresh over it, so the replies quote numbers read off these tabs, not the live run's.
import {
  buildSheets,
  built,
  CHART_DATA_TAB,
  DASHBOARD_TAB,
  DATA_TAB,
  GENERATOR,
} from './sheets.mjs';

export const formats = ['square', 'portrait', 'landscape'];
export const prepare = buildSheets;

const DATA_ASK = 'Generate a dataset of 10000 rows for a retail store selling clothes';
const DASHBOARD_ASK = 'Now create a customer retention and segmentation dashboard';

const EDIT = 'Updating the spreadsheet';
const BOOK = 'https://docs.google.com/spreadsheets/d/spreadsheet-one/edit';
const DATA_GID = 12;
const DASHBOARD_GID = 3197015;
const link = (label, gid, range = 'A1') => ({
  label,
  url: `${BOOK}#gid=${gid}&range=${range.replace(':', '%3A')}`,
});

const money = (n) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const count = (n) => n.toLocaleString('en-US');

// Turn 1: the reply of run 3, its column list on one line.
const DATA_DONE = {
  text:
    'A dataset of 10,000 retail clothing transactions has been generated and frozen as static values.\n\n' +
    '### Data Details\n' +
    '* **Tab:** `Clothing Sales`\n' +
    '* **Range:** `A1:K10001` (1 header row + 10,000 transaction records)\n' +
    '* **Columns:** Order ID (`ORD-100001` to `ORD-110000`), Order Date (2025–2026), Customer ID ' +
    '(power-law distributed repeat customer IDs), Gender, Category, Item, Size, Color, ' +
    'Quantity (1–4), Unit Price and Total Sales (USD)\n\n' +
    'The header row is frozen and bolded for navigation.',
  events: [
    { kind: 'summary', text: 'Listed available spreadsheet tabs' },
    {
      kind: 'write',
      text: 'Created tab Clothing Sales',
      links: [link('Clothing Sales', DATA_GID)],
      details: [{ label: 'Action', value: 'create_sheet' }],
    },
    {
      kind: 'error',
      tool: 'edit_sheet',
      text:
        'edit_sheet: A1: MAKEARRAY( from character 133 is still open at this "}": a ")" is ' +
        'missing (at character 728, near "})").',
      recovered: true,
    },
    {
      kind: 'write',
      text: 'Updated Clothing Sales!A1',
      links: [link('Clothing Sales', DATA_GID)],
      details: [
        { label: 'Action', value: 'set_formulas' },
        { label: 'Range', value: 'A1' },
      ],
    },
    {
      kind: 'write',
      text: 'Copied Clothing Sales!A1:K10001 to Clothing Sales!A1:K10001 (values)',
      links: [link('Clothing Sales', DATA_GID, 'A1:K10001')],
      details: [
        { label: 'Action', value: 'copy_range' },
        { label: 'Range', value: 'A1:K10001' },
        { label: 'Paste', value: 'values' },
      ],
    },
    ...['A1:K1', 'B2:B10001', 'J2:K10001'].map((range) => ({
      kind: 'write',
      text: 'Updated Clothing Sales!' + range,
      links: [link('Clothing Sales', DATA_GID, range)],
      details: [
        { label: 'Action', value: 'format' },
        { label: 'Range', value: range },
      ],
    })),
    {
      kind: 'write',
      text: 'Updated Clothing Sales',
      links: [link('Clothing Sales', DATA_GID)],
      details: [{ label: 'Action', value: 'freeze' }],
    },
  ],
};

// What the rendered tabs hold, read after prepare() built them.
function facts() {
  const { result, dashboard, chartData } = built;
  const score = Object.fromEntries(result.scorecards.map((card) => [card.label, card.value]));
  const tile = (title) => result.tiles.find((item) => item.title === title).preview.slice(1);
  const at = (cells, test) => Object.keys(cells).find((ref) => test(cells[ref]));
  const row = (ref) => Number(ref.replace(/^[A-Z]+/, ''));
  const column = (ref) => ref.replace(/\d+$/, '');
  // The repeat-purchase table is the second one listing the top customer.
  const top = tile('Most Frequent Customers (Repeat Purchases)')[0];
  const listed = Object.keys(dashboard)
    .filter((ref) => dashboard[ref].text === top[0])
    .sort((a, b) => row(a) - row(b));
  const frequentRow = row(listed.at(-1));
  const frequentCell = Object.keys(dashboard).find(
    (ref) => row(ref) === frequentRow && /^=COUNTUNIQUEIFS/.test(dashboard[ref].formula || '')
  );
  // Monthly rows of the chart data: [label, total], the last month only begun.
  const months = Object.keys(chartData)
    .filter((ref) => (chartData[ref].formula || '').includes('">='))
    .sort((a, b) => row(a) - row(b))
    .map((ref) => [chartData['A' + row(ref)].text, chartData[ref].result, ref]);
  const whole = months.slice(0, -1);
  const low = whole.reduce((a, b) => (b[1] < a[1] ? b : a));
  const high = whole.reduce((a, b) => (b[1] > a[1] ? b : a));
  const categories = tile('Revenue by Product Category');
  const genders = tile('Revenue by Customer Segment (Gender)');
  const spend = tile('Top Customers by Total Spend')[0];
  const total = score['Total Sales'];
  return {
    score,
    total,
    top,
    spend,
    categories,
    genders,
    femaleShare: (genders.find(([g]) => g === 'Female')[1] / total) * 100,
    low,
    high,
    months,
    refs: {
      customers: at(dashboard, (c) => /^=COUNTUNIQUE\('Clothing Sales'!\$C/.test(c.formula || '')),
      ratio: at(dashboard, (c) => /^=IFERROR\(/.test(c.formula || '')),
      frequent: frequentCell,
      frequentTitleRow: frequentRow - 2,
      category: at(chartData, (c) => /\$E\$2:\$E\$10001,"=/.test(c.formula || '')),
      month: months[0][2],
      monthColumn: column(months[0][2]),
    },
  };
}

function dashboardDone(f) {
  const result = built.result;
  const [bestCategory, bestCategorySales] = f.categories[0];
  return {
    text:
      'The **Customer Retention and Segmentation Dashboard** has been saved as a draft and ' +
      'generated in your spreadsheet.\n\n' +
      '### Highlights\n' +
      `* **Most Frequent Customer:** \`${f.top[0]}\` placed **${f.top[1]} orders** worth ` +
      `**$${money(f.top[2])}**${f.spend[0] === f.top[0] ? ', also the top spender' : ''}.\n` +
      `* **Revenue by Customer Segment (Gender):** Female accounts for ` +
      `**${f.femaleShare.toFixed(1)}%** of Total Sales.\n\n` +
      '### Dashboard Key Findings\n' +
      `1. **Total Sales** reached **$${money(f.total)}** across **${count(f.score['Distinct Order ID'])} orders** ` +
      `from **${count(f.score['Distinct Customer ID'])} customers** and **${count(f.score.Quantity)} units**, ` +
      `**$${money(f.score['Avg Price / Unit'])} per unit**.\n` +
      `2. **${bestCategory}** is the leading category at **$${money(bestCategorySales)}**.\n` +
      `3. Full months range from **$${money(f.low[1])}** (${f.low[0]}) to ` +
      `**$${money(f.high[1])}** (${f.high[0]}).\n\n` +
      '### Structure & Layout\n' +
      '* **Dashboard Tab:** `Retention Dashboard`: 5 scorecards, two bar charts, a monthly ' +
      'line chart, and the top 15 customers by spend and by orders\n' +
      '* **Data Source Tab:** `Clothing Sales`\n\n' +
      'Refresh it any time without AI via **Reports > Dashboards > Refresh dashboard**.',
    events: [
      { kind: 'summary', text: 'Inspected Clothing Sales!A1:K5' },
      { kind: 'summary', text: 'Inspected Clothing Sales!I1:K5' },
      {
        kind: 'dashboard',
        action: 'saved',
        record: { id: 'dashboard-video', draft: true },
        text:
          'Saved dashboard draft "Customer Retention and Segmentation" with 1 dataset and 3 ' +
          'charts. Listed under Reports > Drafts.',
        details: [
          { label: 'Dashboard tab', value: DASHBOARD_TAB },
          { label: 'Datasets', value: 'Clothing Sales Data → Clothing Sales' },
        ],
      },
      { kind: 'read', text: 'Read Clothing Sales Data · 10,000 rows from Clothing Sales' },
      {
        kind: 'dashboard',
        action: 'refreshed',
        record: { id: 'dashboard-video', draft: true },
        links: [
          link('Dashboard: Retention Dashboard', DASHBOARD_GID),
          link('Data: Clothing Sales', DATA_GID),
        ],
        text: `Built "Customer Retention and Segmentation" on Retention Dashboard: ${result.chartCount} charts, ${result.scorecards.length} scorecards.`,
        details: [
          ...result.highlights.map((value) => ({ label: 'Highlight', value })),
          ...result.scorecards.map((card) => ({
            label: card.label,
            value: String(Math.round(card.value * 1e10) / 1e10),
          })),
        ],
      },
    ],
  };
}

// Runs `first` and, `ms` into it, `then`: the camera sets off before the thing it goes to see.
const lead = (first, ms, then) =>
  Promise.all([first, new Promise((r) => setTimeout(r, ms)).then(then)]);

export default async function (d) {
  const f = facts();
  const dash = built.dashboard;
  const helper = built.chartData;

  /* ---- Open ---- */
  await d.stage('card', {
    kicker: 'New in DataMoov for Google Sheets',
    title: 'From an empty sheet to a customer dashboard.',
  });
  const opened = Date.now();
  await d.stage('title', 'Fernhollow Apparel');
  await d.chatScript(
    [
      {
        steps: ['Checking spreadsheet tabs', EDIT, EDIT, EDIT, EDIT, EDIT, EDIT, EDIT, EDIT],
        reply: DATA_DONE,
      },
      {
        steps: [
          'Checking saved dashboards',
          'Inspecting selected cells',
          'Inspecting selected cells',
          'Saving the dashboard plan',
          'Refreshing dashboard sources',
        ],
        reply: dashboardDone(f),
      },
    ],
    420
  );
  await d.look({ x: -120, y: -80, w: 1840, h: 1160 }, 0);
  await d.wait(Math.max(0, 2600 - (Date.now() - opened)));
  await d.stage('card', { show: false });
  await d.look('app', 1500, { ease: 'out', band: true });
  await d.say('Start from an empty spreadsheet', 1300);

  // Wipes the tab off and loads the next one, so no frame shows a page half loaded.
  const swap = async (name) => {
    await d.reveal(300, false);
    await d.dashboard(name);
  };
  const bar = await d.stage('rect', 'fbar');
  // Room under the shot for the caption, in landscape too, where the camera otherwise fills the
  // frame: the caption lies on the rows below what the shot is about, never on it.
  const roomy = { reserve: Math.max(d.format.reserve, 0.16) };
  // A close-up from the app's top-left corner (title, menus, formula bar) down to world y
  // `bottom`, `w` world pixels wide.
  const close = (w, bottom, ms = 1100) => d.look({ x: bar.x, y: 0, w, h: bottom }, ms, roomy);

  /* ---- Ask 1 ---- */
  await d.say('Ask chat for 10,000 rows of clothing sales');
  await lead(d.look('chat', 1100), 300, () => d.click('#tab-chat'));
  await d.type('#chat-input', DATA_ASK, { cps: 48 });
  await d.click('#chat-send');
  await d.hidePointer();
  await d.say('Each step shows as it runs');
  await d.waitAnswers(1);
  await d.say('');
  await d.drift(1200, 1.03);

  /* ---- The data tab: one formula ---- */
  await d.tab(DATA_TAB, true);
  await Promise.all([d.look('app', 1100, { band: true }), d.dashboard('data-formula')]);
  await d.reveal(900);
  await d.stage('wrapFormula', 600);
  await d.cell('A1', GENERATOR);
  await d.hidePointer();
  const tall = await d.stage('rect', 'fbar');
  await close(760, tall.y + tall.h + 150, 1200);
  await d.say('One formula writes the header and all 10,000 rows');
  await d.drift(3200, 1.03);

  // The formula view wipes off as the camera pulls back, and the pasted values wipe in scrolled
  // to the end, header frozen: row 10001 holds plain values. No caption over the empty sheet.
  await d.say('', 300);
  await Promise.all([
    d.look({ x: bar.x, y: 0, w: 1000, h: bar.y + 480 }, 1100, roomy),
    swap('data-end').then(async () => {
      await d.stage('wrapFormula', null);
      await d.stage('formula', 'A1', 'Order ID');
      await d.reveal(700);
    }),
  ]);
  await d.cell('K10001', money(built.last[10]));
  await d.hidePointer();
  await d.say('Then frozen as values: 10,000 rows, down to row 10,001');
  await d.drift(2400, 1.03);

  /* ---- Ask 2 ---- */
  await d.say('Now ask for a retention and segmentation dashboard');
  await d.look('chat', 1000);
  await d.type('#chat-input', DASHBOARD_ASK, { cps: 48 });
  await d.click('#chat-send');
  await d.hidePointer();
  await d.say('It saves a dashboard plan, then refreshes it');
  await d.waitAnswers(2);
  await d.say('');
  await d.drift(1400, 1.03);

  /* ---- The dashboard: wide ---- */
  await d.tab(DASHBOARD_TAB, true);
  await Promise.all([d.look('app', 1100, { band: true }), swap('dashboard')]);
  await d.stage('formula', 'B2', 'Customer Retention and Segmentation');
  await Promise.all([d.reveal(1000), d.dock(false, 900)]);
  await d.say(`A new dashboard tab: ${built.formulaCount.dashboard} live formulas over the data`);
  await d.drift(2600, 1.03);

  /* ---- KPI formulas ---- */
  await d.say('');
  const kpis = await d.stage('cellBox', 'B7:L14');
  await d.stage('wrapFormula', 560);
  await close(740, kpis.y + kpis.h + 16);
  await d.cell(f.refs.customers, dash[f.refs.customers].formula);
  await d.hidePointer();
  await d.say('Customers: a COUNTUNIQUE over the Customer ID column');
  await d.drift(2400, 1.03);
  const ratioBox = await d.stage('cellBox', f.refs.ratio);
  await d.say('');
  await close(ratioBox.x + 300 - bar.x, kpis.y + kpis.h + 16, 900);
  await d.cell(f.refs.ratio, dash[f.refs.ratio].formula);
  await d.hidePointer();
  await d.say('Avg price per unit: total sales over units, live');
  await d.drift(2400, 1.03);

  /* ---- Charts ---- */
  await d.say('');
  await d.stage('wrapFormula', null);
  await d.stage('formula', 'B23', 'Revenue by Product Category');
  await d.section('Revenue by Product Category', {
    height: 760,
    w: 1330,
    ms: 1300,
    say: 'Sales by category, by gender and by month',
  });
  await d.drift(2600, 1.03);

  /* ---- Repeat customers ---- */
  await d.say('');
  // The tab ends below this table, so it scrolls only part of the way: the camera frames the
  // table where it lands, the formula bar above it.
  await Promise.all([
    d.stage('scrollDashboard', 'Most Frequent Customers (Repeat Purchases)', 12, 1200),
    d.drift(1200, 0.97),
  ]);
  const table = await d.stage(
    'cellBox',
    `B${f.refs.frequentTitleRow}:Y${f.refs.frequentTitleRow + 17}`
  );
  await d.look(
    {
      x: bar.x,
      y: bar.y - 8,
      w: table.x + table.w + 30 - bar.x,
      h: table.y + table.h + 10 - bar.y,
    },
    1200,
    roomy
  );
  await d.cell(f.refs.frequent, dash[f.refs.frequent].formula);
  await d.hidePointer();
  await d.say('Repeat buyers: top 15 customers by orders');
  await d.drift(1800, 1.02);
  await d.say('');
  await d.stage('wrapFormula', 560);
  const tableTop = await d.stage('cellBox', 'B' + (f.refs.frequentTitleRow + 3));
  await close(740, tableTop.y + 20, 1000);
  await d.say('Each count is a COUNTUNIQUEIFS on the data tab');
  await d.drift(2600, 1.03);

  /* ---- The hidden helper tab ---- */
  await d.say('');
  await d.stage('wrapFormula', null);
  await d.tab(CHART_DATA_TAB, true);
  await Promise.all([d.look('app', 1100, { band: true }), swap('chart-data')]);
  await d.stage('formula', 'A1', 'Revenue by Product Category');
  await d.reveal(800);
  await d.say('Behind the charts, a hidden helper tab the dashboard wrote');
  await d.drift(2000, 1.03);
  await d.say('');
  await d.stage('wrapFormula', 560);
  const firstMonth = await d.stage('cellBox', f.refs.month);
  await close(740, firstMonth.y + firstMonth.h + 20);
  await d.cell(f.refs.category, helper[f.refs.category].formula);
  await d.hidePointer();
  await d.say('One SUMIFS per bar of the chart');
  await d.drift(2200, 1.03);
  await d.cell(f.refs.month, helper[f.refs.month].formula);
  await d.hidePointer();
  await d.say('One per month, between two dates');
  await d.drift(2400, 1.03);
  await d.say('');

  /* ---- Close: pull out under the cards ---- */
  await lead(d.look({ x: -200, y: -130, w: 2000, h: 1260 }, 1800, { ease: 'in' }), 900, () =>
    d.card({
      kicker: 'Live formulas · charts · refresh without AI',
      title: "Don't leave your beloved spreadsheet to get an answer.",
      hold: 2600,
      stay: true,
    })
  );
  await d.card({
    title: 'DataMoov for Google Sheets',
    text: 'Generate data, build dashboards and ask about your sources, right where you work.',
    note: 'justdataplease.com · demo data',
    hold: 3000,
    stay: true,
  });
}
