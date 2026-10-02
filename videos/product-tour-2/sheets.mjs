// The Orders tab of the product-tour-2 video and the formula dashboard chat builds over it, drawn
// with the dashboard preview's Sheets renderer.
//
// 1,000 fictional orders of the Demo Store, the outdoor-gear shop of videos/kit/demo-fixture.mjs
// (5 categories, 15 products, 4 channels, USD), from a seeded random number generator. The
// Dashboard tab holds what chat's tools ask Sheets for (the live replays of commit
// 671ad74): KPI formulas over whole Orders columns, two native pivots at A7 and D7 and a column
// chart over each pivot's summary. Sheets computes formula results and pivot cells itself, so
// this module computes the same numbers from the rows and writes each tab as Sheets batch
// requests that tools/dashboard-preview.mjs replays and renders.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { replay, renderSheet } from '../../tools/dashboard-preview.mjs';

const HEADER = ['Order ID', 'Date', 'Channel', 'Category', 'Product', 'Units', 'Revenue'];
const CHANNELS = ['Google Ads', 'Meta Ads', 'Organic', 'Email'];
const CATEGORIES = ['Footwear', 'Jackets', 'Tents', 'Backpacks', 'Sleeping bags'];
const PRODUCTS = [
  ['Hiking boots', 'Trail runners', 'Camp sandals'],
  ['Rain jacket', 'Down jacket', 'Fleece'],
  ['2-person tent', 'Family tent', 'Tarp'],
  ['Daypack', 'Trekking pack', 'Hip pack'],
  ['Summer bag', 'Winter bag', 'Sleeping pad'],
];
const PRICES = [130, 150, 240, 90, 110];

// The KPI formulas chat writes to the dashboard's A4:D4, over whole Orders columns.
export const KPIS = [
  { label: 'Revenue', formula: '=SUM(Orders!G2:G)' },
  { label: 'Avg order', formula: '=AVERAGE(Orders!G2:G)' },
  { label: 'Orders', formula: '=COUNTA(Orders!A2:A)' },
  { label: 'Units sold', formula: '=SUM(Orders!F2:F)' },
];

// mulberry32: the same fictional rows on every render.
function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cents = (value) => Math.round(value * 100) / 100;

export function orders() {
  const next = random(907);
  const between = (low, high) => low + Math.floor(next() * (high - low + 1));
  const rows = [];
  for (let r = 1; r <= 1000; r++) {
    const day = new Date(Date.UTC(2026, 0, 1 + between(0, 272)));
    const category = r % 5;
    const units = between(1, 3);
    rows.push([
      'DS-' + (20000 + r),
      `${day.getUTCMonth() + 1}/${day.getUTCDate()}/${day.getUTCFullYear()}`,
      CHANNELS[between(1, 4) - 1],
      CATEGORIES[category],
      PRODUCTS[category][between(1, 3) - 1],
      units,
      cents((PRICES[category] * units * between(70, 130)) / 100),
    ]);
  }
  return rows;
}

export function summary(rows = orders()) {
  const revenue = cents(rows.reduce((total, row) => total + row[6], 0));
  const pivot = (column) =>
    [...new Set(rows.map((row) => row[column]))]
      .sort()
      .map((key) => [
        key,
        cents(rows.filter((row) => row[column] === key).reduce((t, row) => t + row[6], 0)),
      ]);
  return {
    revenue,
    orders: rows.length,
    average: revenue / rows.length,
    units: rows.reduce((total, row) => total + row[5], 0),
    categories: pivot(3),
    channels: pivot(2),
  };
}

// ---- Sheets requests ---------------------------------------------------------------------
const value = (v) =>
  v === null || v === undefined
    ? {}
    : typeof v === 'number'
      ? { userEnteredValue: { numberValue: v } }
      : { userEnteredValue: { stringValue: String(v) } };
const rgb = (hex) => ({
  rgbColor: {
    red: parseInt(hex.slice(1, 3), 16) / 255,
    green: parseInt(hex.slice(3, 5), 16) / 255,
    blue: parseInt(hex.slice(5, 7), 16) / 255,
  },
});
// The Orders tab's dollar format is the user's own. Chat's format action (dmvChatSheetFormat_)
// writes bold, a fill and, on the KPI amounts, currency without a code: #,##0.00. Counts keep
// Sheets' own display (1000).
const BOLD = { textFormat: { bold: true } };
const FILL = { backgroundColorStyle: rgb('#e8eaf6') };
const DOLLARS = { numberFormat: { type: 'CURRENCY', pattern: '"$"#,##0.00' } };
const AMOUNT = { numberFormat: { type: 'NUMBER', pattern: '#,##0.00' } };
// A native pivot's header and Grand Total rows, as Sheets draws them.
const PIVOT_HEAD = { backgroundColorStyle: rgb('#f1f3f4'), textFormat: { bold: true } };
const WRAP = { wrapStrategy: 'WRAP' };

function cells(sheetId, row, column, table, formatAt = () => null) {
  return {
    updateCells: {
      start: { sheetId, rowIndex: row, columnIndex: column },
      rows: table.map((line, r) => ({
        values: line.map((v, c) => {
          const cell = value(v);
          const format = formatAt(r, c);
          if (format) cell.userEnteredFormat = format;
          return cell;
        }),
      })),
      fields: 'userEnteredValue,userEnteredFormat',
    },
  };
}

const addSheet = (sheetId, title, grid) => ({
  addSheet: { properties: { sheetId, title, gridProperties: { columnCount: 14, ...grid } } },
});

function ordersTab(rows) {
  const DATE = { horizontalAlignment: 'RIGHT' };
  return [
    addSheet(1, 'Orders', { rowCount: 1001, frozenRowCount: 1 }),
    cells(1, 0, 0, [HEADER].concat(rows), (r, c) =>
      r === 0 ? { ...BOLD, ...FILL } : c === 1 ? DATE : c === 6 ? DOLLARS : null
    ),
    ...[84, 84, 96, 110, 120, 60, 110].map((pixelSize, c) => ({
      updateDimensionProperties: {
        range: { sheetId: 1, dimension: 'COLUMNS', startIndex: c, endIndex: c + 1 },
        properties: { pixelSize },
        fields: 'pixelSize',
      },
    })),
  ];
}

function chart(chartId, title, axis, column, rows, anchorColumn) {
  const range = (c) => ({
    sheetId: 2,
    startRowIndex: 6,
    endRowIndex: 7 + rows,
    startColumnIndex: c,
    endColumnIndex: c + 1,
  });
  return {
    addChart: {
      chart: {
        chartId,
        spec: {
          title,
          basicChart: {
            chartType: 'COLUMN',
            legendPosition: 'BOTTOM_LEGEND',
            headerCount: 1,
            axis: [
              { position: 'BOTTOM_AXIS', title: axis },
              { position: 'LEFT_AXIS', title: 'SUM of Revenue' },
            ],
            domains: [{ domain: { sourceRange: { sources: [range(column)] } } }],
            series: [
              {
                series: { sourceRange: { sources: [range(column + 1)] } },
                targetAxis: 'LEFT_AXIS',
              },
            ],
          },
        },
        position: {
          overlayPosition: {
            anchorCell: { sheetId: 2, rowIndex: 14, columnIndex: anchorColumn },
            widthPixels: 560,
            heightPixels: 340,
          },
        },
      },
    },
  };
}

function dashboardTab(stats) {
  const pivot = (title, groups) =>
    [[title, 'SUM of Revenue']]
      .concat(groups)
      .concat([['Grand Total', cents(groups.reduce((t, [, v]) => t + v, 0))]]);
  const categories = pivot('Category', stats.categories);
  const channels = pivot('Channel', stats.channels);
  // Sheets shows a pivot's sums in the source column's format, here the Orders dollar format.
  const pivotFormat = (table) => (r, c) => ({
    ...(r === 0 || r === table.length - 1 ? PIVOT_HEAD : {}),
    // Chat's format call wraps the header row (A7:E7), so SUM of Revenue fits its column.
    ...(r === 0 ? WRAP : {}),
    ...(r > 0 && c === 1 ? DOLLARS : {}),
  });
  return [
    addSheet(2, 'Dashboard', { rowCount: 1000 }),
    cells(2, 0, 0, [['Demo Store orders'], []]),
    cells(
      2,
      2,
      0,
      [KPIS.map((kpi) => kpi.label), [stats.revenue, stats.average, stats.orders, stats.units]],
      (r, c) => (r === 0 ? { ...BOLD, ...FILL } : { ...BOLD, ...FILL, ...(c < 2 ? AMOUNT : {}) })
    ),
    cells(2, 6, 0, categories, pivotFormat(categories)),
    cells(2, 6, 3, channels, pivotFormat(channels)),
    chart(1, 'Revenue by category', 'Category', 0, stats.categories.length, 0),
    chart(2, 'Revenue by channel', 'Channel', 3, stats.channels.length, 6),
  ];
}

function render(requests, title, options = {}) {
  const model = replay([{ body: { requests } }], []);
  const sheet = [...model.sheets.values()].find((item) => item.props.title === title);
  return renderSheet(sheet, model, options);
}

// Writes orders.html and formula-dashboard.html (dashboard.html is the saved Google Ads
// dashboard the recorder draws from the fixture).
export async function buildSheets(dir) {
  const rows = orders();
  const stats = summary(rows);
  const pages = {
    // Only the top of the tab: the row numbers of all 1,000 rows, run together, read as one long
    // digit string to the recorder's privacy check.
    orders: render(ordersTab(rows), 'Orders', { maxRows: 40 }),
    'formula-dashboard': render(ordersTab(rows).concat(dashboardTab(stats)), 'Dashboard'),
  };
  for (const [name, html] of Object.entries(pages))
    await writeFile(path.join(dir, name + '.html'), html);
  return stats;
}
