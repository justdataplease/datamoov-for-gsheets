// The tabs of the retail-dashboard video, drawn with the dashboard preview's Sheets renderer.
//
// The data is what the generating formula below writes: 1,000 fictional orders of a made-up
// shop (5 stores, 5 departments, 15 products, USD), drawn here with a seeded random number
// generator standing in for RANDBETWEEN. The Dashboard tab holds what chat's tools ask Sheets
// for: KPI formulas over whole Sheet1 columns, two native pivots at A7 and D7 and a column chart
// over each pivot's summary. Formula results and pivot cells are computed by Sheets itself, so
// this module computes the same numbers from the rows and writes each state as Sheets batch
// requests that tools/dashboard-preview.mjs replays and renders.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { replay, renderSheet } from '../../tools/dashboard-preview.mjs';

const HEADER = [
  'Order ID',
  'Date',
  'Store',
  'Department',
  'Product',
  'Customer',
  'Payment',
  'Units',
  'Revenue',
];
const STORES = ['Northgate', 'Lakeside', 'Old Town', 'Riverside', 'Maple Street'];
const DEPARTMENTS = ['Apparel', 'Electronics', 'Home', 'Beauty', 'Sports'];
const PRODUCTS = [
  'T-shirt',
  'Jeans',
  'Jacket',
  'Headphones',
  'Speaker',
  'Charger',
  'Lamp',
  'Throw pillow',
  'Mug set',
  'Shampoo',
  'Lipstick',
  'Face cream',
  'Yoga mat',
  'Water bottle',
  'Running socks',
];
const CUSTOMERS = ['New', 'Returning', 'Member'];
const PAYMENTS = ['Card', 'Cash', 'Mobile pay', 'Gift card'];
const PRICES = [40, 120, 45, 25, 35];

const list = (items) => '{' + items.map((item) => JSON.stringify(item)).join(',') + '}';

// The one formula chat writes to Sheet1!A1: the header and 1,000 rows in one array. Units are
// drawn once and bound with LET, so each order's revenue is its units times the department's
// price, give or take 15%.
export const GENERATOR =
  '=LET(units,MAKEARRAY(1000,1,LAMBDA(r,c,RANDBETWEEN(1,4))),' +
  list(HEADER).slice(0, -1) +
  ';MAKEARRAY(1000,7,LAMBDA(r,c,CHOOSE(c,' +
  [
    '"ORD-"&(10000+r)',
    'DATE(2026,4,1)+RANDBETWEEN(0,152)',
    `INDEX(${list(STORES)},RANDBETWEEN(1,5))`,
    `INDEX(${list(DEPARTMENTS)},MOD(r,5)+1)`,
    `INDEX(${list(PRODUCTS)},MOD(r,5)*3+RANDBETWEEN(1,3))`,
    `INDEX(${list(CUSTOMERS)},RANDBETWEEN(1,3))`,
    `INDEX(${list(PAYMENTS)},RANDBETWEEN(1,4))`,
  ].join(',') +
  '))),units,MAKEARRAY(1000,1,LAMBDA(r,c,' +
  `ROUND(INDEX(units,r)*INDEX(${list(PRICES)},MOD(r,5)+1)*RANDBETWEEN(85,115)/100,2)` +
  '))})';

// The KPI formulas chat writes to Dashboard!A4:D4, over whole Sheet1 columns.
export const KPIS = [
  { label: 'Revenue', formula: '=SUM(Sheet1!I2:I)' },
  { label: 'Avg order', formula: '=AVERAGE(Sheet1!I2:I)' },
  { label: 'Orders', formula: '=COUNTA(Sheet1!A2:A)' },
  { label: 'Units sold', formula: '=SUM(Sheet1!H2:H)' },
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

export function orders() {
  const next = random(2026);
  const between = (low, high) => low + Math.floor(next() * (high - low + 1));
  const rows = [];
  for (let r = 1; r <= 1000; r++) {
    const day = new Date(Date.UTC(2026, 3, 1 + between(0, 152)));
    const units = between(1, 4);
    rows.push([
      'ORD-' + (10000 + r),
      day.toISOString().slice(0, 10),
      STORES[between(1, 5) - 1],
      DEPARTMENTS[r % 5],
      PRODUCTS[(r % 5) * 3 + between(1, 3) - 1],
      CUSTOMERS[between(1, 3) - 1],
      PAYMENTS[between(1, 4) - 1],
      units,
      Math.round(PRICES[r % 5] * units * between(85, 115)) / 100,
    ]);
  }
  return rows;
}

const cents = (value) => Math.round(value * 100) / 100;

export function summary(rows = orders()) {
  const revenue = cents(rows.reduce((total, row) => total + row[8], 0));
  const pivot = (column) =>
    [...new Set(rows.map((row) => row[column]))]
      .sort()
      .map((key) => [
        key,
        cents(rows.filter((row) => row[column] === key).reduce((t, row) => t + row[8], 0)),
      ]);
  return {
    revenue,
    average: revenue / rows.length,
    orders: rows.length,
    units: rows.reduce((total, row) => total + row[7], 0),
    departments: pivot(3),
    stores: pivot(2),
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
// What chat's format action writes (dmvChatSheetFormat_): bold, a fill, and amounts as currency
// without a code, #,##0.00. Counts keep Sheets' own display (1000). A native pivot shows its sums
// in the source column's format, so the amounts of Sheet1's Revenue column carry over.
const BOLD = { textFormat: { bold: true } };
const FILL = { backgroundColorStyle: rgb('#e8eaf6') };
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
          const format = formatAt(r, c, v);
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

// `frozen`: after the paste, with the header frozen and formatted, dates as yyyy-mm-dd and Revenue
// as amounts. Before it the dates are the formula's results, which Sheets shows in its own date
// format (8/20/2026); pasted as values they keep only the serial number, so chat formats the
// column (numberFormat date, yyyy-mm-dd) as the paste's result tells it to. `end`
// hides every row but the header and the last 18, as Sheets shows a tab with a frozen header
// scrolled to its end, and leaves the hidden rows' cells out of the page, so no text off screen
// reaches it. Only part of the 1,000 rows is drawn: the row numbers of all of them,
// run together, read as one long digit string to the recorder's privacy check.
const shownDate = (row) => {
  const [year, month, day] = row[1].split('-').map(Number);
  return [row[0], `${month}/${day}/${year}`, ...row.slice(2)];
};

function sheet1(rows, { frozen, end }) {
  const shown = (frozen ? rows : rows.map(shownDate)).map((row, i) => (end && i < 982 ? [] : row));
  // Dates are date cells in Sheets, shown right-aligned; the renderer draws them as text.
  const DATE = { horizontalAlignment: 'RIGHT' };
  return [
    addSheet(1, 'Sheet1', { rowCount: 1001, ...(frozen ? { frozenRowCount: 1 } : {}) }),
    cells(1, 0, 0, [HEADER].concat(shown), (r, c) => {
      if (r === 0) return frozen ? { ...BOLD, ...FILL } : null;
      return c === 1 ? DATE : c === 8 && frozen ? AMOUNT : null;
    }),
    ...[90, 80, 96, 96, 110, 84, 84, 60, 72].map((pixelSize, c) => ({
      updateDimensionProperties: {
        range: { sheetId: 1, dimension: 'COLUMNS', startIndex: c, endIndex: c + 1 },
        properties: { pixelSize },
        fields: 'pixelSize',
      },
    })),
    ...(end
      ? [
          {
            updateDimensionProperties: {
              range: { sheetId: 1, dimension: 'ROWS', startIndex: 1, endIndex: 983 },
              properties: { hiddenByUser: true },
              fields: 'hiddenByUser',
            },
          },
        ]
      : []),
  ];
}

function chart(chartId, title, column, rows, anchorColumn) {
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
              { position: 'BOTTOM_AXIS', title: column === 0 ? 'Department' : 'Store' },
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
            widthPixels: 600,
            heightPixels: 360,
          },
        },
      },
    },
  };
}

function dashboard(stats) {
  const pivot = (title, groups) =>
    [[title, 'SUM of Revenue']]
      .concat(groups)
      .concat([['Grand Total', cents(groups.reduce((t, [, v]) => t + v, 0))]]);
  const departments = pivot('Department', stats.departments);
  const stores = pivot('Store', stats.stores);
  const pivotFormat = (table) => (r, c) => ({
    ...(r === 0 || r === table.length - 1 ? PIVOT_HEAD : {}),
    // Chat's format call wraps the header row (A7:E7), so SUM of Revenue fits its column.
    ...(r === 0 ? WRAP : {}),
    ...(r > 0 && c === 1 ? AMOUNT : {}),
  });
  return [
    addSheet(2, 'Dashboard', { rowCount: 1000 }),
    cells(2, 0, 0, [['Retail performance'], []]),
    cells(
      2,
      2,
      0,
      [KPIS.map((kpi) => kpi.label), [stats.revenue, stats.average, stats.orders, stats.units]],
      (r, c) => (r === 0 ? { ...BOLD, ...FILL } : { ...BOLD, ...FILL, ...(c < 2 ? AMOUNT : {}) })
    ),
    cells(2, 6, 0, departments, pivotFormat(departments)),
    cells(2, 6, 3, stores, pivotFormat(stores)),
    chart(1, 'Revenue by department', 0, stats.departments.length, 0),
    chart(2, 'Revenue by store', 3, stats.stores.length, 6),
  ];
}

function render(requests, title, options = {}) {
  const model = replay([{ body: { requests } }], []);
  const sheet = [...model.sheets.values()].find((item) => item.props.title === title);
  return renderSheet(sheet, model, options);
}

export async function buildSheets(dir) {
  const rows = orders();
  const stats = summary(rows);
  const both = (frozen) => sheet1(rows, { frozen }).concat(dashboard(stats));
  const pages = {
    'data-formula': render(sheet1(rows, { frozen: false }), 'Sheet1', { maxRows: 40 }),
    // The tab ends at row 1001, so the stage draws no empty rows past it.
    'data-end':
      '<meta name="rows" content="1001">' +
      render(sheet1(rows, { frozen: true, end: true }), 'Sheet1'),
    dashboard: render(both(true), 'Dashboard'),
  };
  for (const [name, html] of Object.entries(pages))
    await writeFile(path.join(dir, name + '.html'), html);
  return stats;
}
