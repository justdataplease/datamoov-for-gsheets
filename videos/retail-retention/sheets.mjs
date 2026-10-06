// The tabs of the retail-retention video, drawn with the dashboard preview's Sheets renderer.
//
// Clothing Sales holds what the generating formula below writes: 10,000 orders of a made-up
// clothing shop, drawn here with a seeded random number generator standing in for RAND(). Every
// row is one the formula can write (each value inside its lists and ranges); two choices keep the
// rows readable where the real formula draws again per cell: Item is one of the formula's items
// that fits the row's Category, and Total Sales is Quantity × Unit Price.
//
// The dashboard is the real dashboard engine's: the saved plan of the live run (run 3's
// save_dashboard input, word for word) is saved and refreshed in the offline sandbox over this
// tab, and the Sheets batch it writes is replayed and rendered by tools/dashboard-preview.mjs, so
// the Retention Dashboard tab and its hidden chart-data tab show the engine's own formulas, with
// results worked out from these rows.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createDatamoovSandbox, plain } from '../../tests/helpers/datamoov-sandbox.mjs';
import { replay, renderSheet } from '../../tools/dashboard-preview.mjs';

export const DATA_TAB = 'Clothing Sales';
export const DASHBOARD_TAB = 'Retention Dashboard';
export const CHART_DATA_TAB = 'Retention Dashboard (chart data)';

const HEADER = [
  'Order ID',
  'Order Date',
  'Customer ID',
  'Gender',
  'Category',
  'Item',
  'Size',
  'Color',
  'Quantity',
  'Unit Price',
  'Total Sales',
];
const GENDERS = ['Female', 'Male', 'Unisex'];
const CATEGORIES = ['Tops', 'Bottoms', 'Outerwear', 'Dresses', 'Activewear'];
const ITEMS = ['T-Shirt', 'Jeans', 'Hoodie', 'Dress', 'Jacket', 'Sweater', 'Shorts', 'Skirt'];
const SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
const COLORS = ['Black', 'White', 'Navy', 'Grey', 'Beige', 'Red', 'Blue'];
// The formula's items that fit each category.
const FITS = {
  Tops: ['T-Shirt', 'Sweater', 'Hoodie'],
  Bottoms: ['Jeans', 'Shorts', 'Skirt'],
  Outerwear: ['Jacket', 'Hoodie'],
  Dresses: ['Dress', 'Skirt'],
  Activewear: ['T-Shirt', 'Shorts', 'Hoodie'],
};

// The formula chat wrote to Clothing Sales!A1 in the live run (its second try; the first missed a
// closing bracket), character for character.
export const GENERATOR =
  '=LET(n,10000,{"Order ID","Order Date","Customer ID","Gender","Category","Item","Size","Color","Quantity","Unit Price","Total Sales";' +
  'MAKEARRAY(n,11,LAMBDA(r,c,CHOOSE(c,"ORD-"&TEXT(100000+r,"000000"),DATE(2025,1,1)+INT(RAND()*640),' +
  '"CUST-"&TEXT(1000+INT(2500*RAND()^1.5),"0000"),INDEX({"Female","Male","Unisex"},1+INT(3*RAND()^1.2)),' +
  'INDEX({"Tops","Bottoms","Outerwear","Dresses","Activewear"},1+INT(5*RAND())),' +
  'INDEX({"T-Shirt","Jeans","Hoodie","Dress","Jacket","Sweater","Shorts","Skirt"},1+INT(8*RAND())),' +
  'INDEX({"XS","S","M","L","XL","XXL"},1+INT(6*RAND())),' +
  'INDEX({"Black","White","Navy","Grey","Beige","Red","Blue"},1+INT(7*RAND())),1+INT(4*RAND()^2),' +
  'ROUND(15+120*RAND()^1.4,2),ROUND((1+INT(4*RAND()^2))*(15+120*RAND()^1.4),2))))})';

// The save_dashboard input of the live run, as the model sent it.
export const PLAN = {
  name: 'Customer Retention and Segmentation',
  datasets: [{ sourceSheet: DATA_TAB, id: 'sales_data', label: 'Clothing Sales Data' }],
  neutral: ['Total Sales', 'Quantity'],
  target: { sheetName: DASHBOARD_TAB },
  tiles: [
    {
      title: 'Store Performance & Customer Reach',
      metrics: [
        { field: 'Customer ID', agg: 'count_distinct' },
        { field: 'Order ID', agg: 'count_distinct' },
        { field: 'Total Sales', agg: 'sum' },
        { agg: 'sum', field: 'Quantity' },
      ],
      datasets: ['sales_data'],
      type: 'kpi',
      ratios: [
        {
          key: 'avg_item_price',
          label: 'Avg Price / Unit',
          numerator: 'Total Sales',
          denominator: 'Quantity',
        },
      ],
    },
    {
      datasets: ['sales_data'],
      title: 'Revenue by Product Category',
      groupBy: ['Category'],
      metrics: [{ field: 'Total Sales', agg: 'sum' }],
      type: 'bar',
      orderBy: { field: 'Total Sales__sum', direction: 'desc' },
    },
    {
      type: 'bar',
      groupBy: ['Gender'],
      orderBy: { field: 'Total Sales__sum', direction: 'desc' },
      title: 'Revenue by Customer Segment (Gender)',
      datasets: ['sales_data'],
      metrics: [{ field: 'Total Sales', agg: 'sum' }],
    },
    {
      type: 'line',
      datasets: ['sales_data'],
      width: 'full',
      groupBy: ['Order Date'],
      dateBucket: 'month',
      metrics: [{ agg: 'sum', field: 'Total Sales' }],
      title: 'Monthly Sales Trend',
      orderBy: { direction: 'asc', field: 'Order Date' },
    },
    {
      limit: 15,
      orderBy: { field: 'Total Sales__sum', direction: 'desc' },
      metrics: [
        { agg: 'count_distinct', field: 'Order ID' },
        { field: 'Total Sales', agg: 'sum' },
        { agg: 'sum', field: 'Quantity' },
      ],
      title: 'Top Customers by Total Spend',
      groupBy: ['Customer ID'],
      highlight: [{ color: 'green', op: 'gte', ofTotal: 0.002, field: 'Total Sales__sum' }],
      type: 'table',
      datasets: ['sales_data'],
    },
    {
      datasets: ['sales_data'],
      metrics: [
        { field: 'Order ID', agg: 'count_distinct' },
        { field: 'Total Sales', agg: 'sum' },
      ],
      type: 'table',
      orderBy: { direction: 'desc', field: 'Order ID__count_distinct' },
      title: 'Most Frequent Customers (Repeat Purchases)',
      groupBy: ['Customer ID'],
      limit: 15,
    },
  ],
};

// mulberry32: the same fictional rows on every render.
function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The seed: its last rows, on screen, keep clear of the recorder's private-value check.
const SEED = 77;
const JAN_1_2025 = 45658; // DATE(2025,1,1) as a serial number
const cents = (value) => Math.round(value * 100) / 100;
const pad = (n, width) => String(n).padStart(width, '0');

// The 10,000 rows, dates as serial numbers, as the formula draws them.
export function orders() {
  const rand = random(SEED);
  const pick = (list, u) => list[Math.floor(list.length * u)];
  const rows = [];
  for (let r = 1; r <= 10000; r++) {
    const category = pick(CATEGORIES, rand());
    const quantity = 1 + Math.floor(4 * rand() ** 2);
    const price = cents(15 + 120 * rand() ** 1.4);
    rows.push([
      'ORD-' + pad(100000 + r, 6),
      JAN_1_2025 + Math.floor(rand() * 640),
      'CUST-' + pad(1000 + Math.floor(2500 * rand() ** 1.5), 4),
      GENDERS[Math.floor(3 * rand() ** 1.2)],
      category,
      pick(FITS[category], rand()),
      pick(SIZES, rand()),
      pick(COLORS, rand()),
      quantity,
      price,
      cents(quantity * price),
    ]);
  }
  for (const row of rows)
    if (!ITEMS.includes(row[5])) throw new Error('Not an item of the formula');
  return rows;
}

// A serial number as yyyy-mm-dd and as Sheets shows a date result (M/D/YYYY).
const dayOf = (serial) => new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
const isoDate = (serial) => dayOf(serial).toISOString().slice(0, 10);
const usDate = (serial) => {
  const d = dayOf(serial);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
};

// ---- Sheets requests for the data tab --------------------------------------------------------
const value = (v) =>
  v === null || v === undefined
    ? {}
    : typeof v === 'number'
      ? { userEnteredValue: { numberValue: v } }
      : { userEnteredValue: { stringValue: String(v) } };

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

const WIDTHS = [100, 92, 92, 64, 86, 70, 44, 56, 70, 96, 106];
const RIGHT = { horizontalAlignment: 'RIGHT' };
// What chat's format calls write: the header bold, B2:B as yyyy-mm-dd, J2:K as USD amounts.
const BOLD = { textFormat: { bold: true } };
const DATE = { numberFormat: { type: 'DATE', pattern: 'yyyy-mm-dd' } };
const USD = { numberFormat: { type: 'CURRENCY', pattern: '#,##0.00" USD"' } };

// `values`: after the paste and the format calls, header frozen. Before it, the formula's
// results: dates in Sheets' own date format, numbers as computed. `from`: the first data row
// drawn; the rows above it are hidden, as Sheets shows a tab with a frozen header scrolled to
// its end, and their cells stay out of the page so no text off screen reaches it.
function dataTab(sheetId, rows, { values, from = 0, to = rows.length }) {
  const shown = rows
    .slice(from, to)
    .map((row) => (values ? row : [row[0], usDate(row[1]), ...row.slice(2)]));
  return [
    {
      addSheet: {
        properties: {
          sheetId,
          title: DATA_TAB,
          gridProperties: {
            rowCount: 10001,
            columnCount: 11,
            ...(values ? { frozenRowCount: 1 } : {}),
          },
        },
      },
    },
    cells(sheetId, 0, 0, [HEADER], () => (values ? BOLD : null)),
    cells(sheetId, from + 1, 0, shown, (r, c) =>
      c === 1 ? (values ? DATE : RIGHT) : values && c >= 9 ? USD : null
    ),
    ...WIDTHS.map((pixelSize, c) => ({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: c, endIndex: c + 1 },
        properties: { pixelSize },
        fields: 'pixelSize',
      },
    })),
    ...(from
      ? [
          {
            updateDimensionProperties: {
              range: { sheetId, dimension: 'ROWS', startIndex: 1, endIndex: from + 1 },
              properties: { hiddenByUser: true },
              fields: 'hiddenByUser',
            },
          },
        ]
      : []),
  ];
}

const pageOf = (requests, title, options = {}) => {
  const model = replay([{ body: { requests } }], []);
  const sheet = [...model.sheets.values()].find((item) => item.props.title === title);
  return renderSheet(sheet, model, options);
};

// ---- The dashboard engine over the tab --------------------------------------------------------
function runDashboard(rows) {
  const f = createDatamoovSandbox();
  // Refreshed 1 Oct 2026, 03:29 in Los Angeles: the recorder's fictional morning.
  f.book.timezone = 'America/Los_Angeles';
  f.advance(Date.parse('2026-10-01T10:29:00Z') - f.api.Date.now());
  f.book.sheets[0].name = 'Sheet1';
  const sheet = f.book.insertSheet(DATA_TAB);
  sheet.maxRows = 10001;
  sheet.maxColumns = 11;
  HEADER.forEach((header, c) => f.setCell(sheet, 1, c + 1, header));
  rows.forEach((row, r) => {
    row.forEach((v, c) => f.setCell(sheet, r + 2, c + 1, v));
    sheet.formats.set(r + 2 + ':2', DATE);
  });
  const before = f.book.sheets.map((item) => ({
    id: item.id,
    title: item.name,
    rows: item.maxRows,
    columns: item.maxColumns,
  }));
  const saved = plain(f.api.dmvSaveDashboard(PLAN));
  const result = plain(f.api.dmvRunDashboard(saved.id));
  // The tab's cells go first, so the engine's formulas over it have something to read.
  const data = {
    body: {
      requests: [
        cells(sheet.id, 0, 0, [HEADER].concat(rows), (r, c) => (r > 0 && c === 1 ? DATE : null)),
      ],
    },
  };
  const model = replay([data, ...f.state.batches], before);
  const tab = (title) => [...model.sheets.values()].find((item) => item.props.title === title);
  return { result, model, dashboard: tab(DASHBOARD_TAB), chartData: tab(CHART_DATA_TAB) };
}

// "B8" for a 0-based "7:1".
const a1 = (key) => {
  const [r, c] = key.split(':').map(Number);
  let name = '';
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26))
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name + (r + 1);
};

// Every cell of a rendered tab by A1: { formula, result, text }.
function cellMap(sheet) {
  const out = {};
  for (const [key, cell] of sheet.cells) {
    const v = cell.userEnteredValue;
    if (!v) continue;
    out[a1(key)] = v.formulaValue
      ? { formula: v.formulaValue, result: cell.result }
      : { text: v.stringValue ?? v.numberValue };
  }
  return out;
}

// What the storyboard reads after prepare(): formulas and numbers from the same rows.
export const built = {};

export async function buildSheets(dir) {
  const rows = orders();
  const run = runDashboard(rows);
  const pages = {
    // The formula's results, as the tab shows them right after set_formulas.
    'data-formula': pageOf(dataTab(12, rows, { values: false, to: 40 }), DATA_TAB, {
      maxRows: 41,
    }),
    // Pasted as values, formatted and frozen, scrolled to the end: row 10001, the tab's last row,
    // at the bottom of the window, so no empty sheet shows below the data.
    'data-end':
      '<meta name="rows" content="10001">' +
      pageOf(dataTab(12, rows, { values: true, from: 9963 }), DATA_TAB),
    dashboard: renderSheet(run.dashboard, run.model),
    'chart-data': renderSheet(run.chartData, run.model),
  };
  for (const [name, html] of Object.entries(pages))
    await writeFile(path.join(dir, name + '.html'), html);

  Object.assign(built, {
    rows,
    last: rows.at(-1),
    isoDate,
    result: run.result,
    dashboard: cellMap(run.dashboard),
    chartData: cellMap(run.chartData),
    formulaCount: {
      dashboard: Object.values(cellMap(run.dashboard)).filter((cell) => cell.formula).length,
      chartData: Object.values(cellMap(run.chartData)).filter((cell) => cell.formula).length,
    },
  });
  return built;
}
