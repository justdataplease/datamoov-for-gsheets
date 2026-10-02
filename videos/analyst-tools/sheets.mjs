// The tabs of the analyst-tools video, drawn with the dashboard preview's Sheets renderer.
//
// Pivot results, live colour rules and dropdown chips are computed by Google Sheets itself, so no
// offline run can produce them as cells. This module applies the same steps the tools ask Sheets
// for (trim, remove duplicates by email, split names, a Status dropdown, a pivot of spend by
// campaign and month, CPA > 50 in red, then undo of the colour) to a fictional export, and writes
// each state as Sheets batch requests that tools/dashboard-preview.mjs replays and renders.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { replay, renderSheet } from '../../tools/dashboard-preview.mjs';

// A fictional ad-leads export: stray spaces, three duplicate rows, "First Last" names.
const RAW = [
  [' maya.chen@example.com ', 'Maya Chen', 'Brand', '2026-08-04', 140, 4],
  ['leo.park@example.com', 'Leo Park', 'Generic', '2026-08-06', 410, 5],
  ['ines.roy@example.com', 'Ines Roy', 'Remarketing', '2026-08-11', 95, 3],
  ['maya.chen@example.com', 'Maya Chen', 'Brand', '2026-08-04', 140, 4],
  ['omar.diaz@example.com  ', 'Omar Diaz', 'Generic', '2026-08-19', 520, 6],
  ['tess.ng@example.com', ' Tess Ng', 'Brand', '2026-08-23', 180, 6],
  ['leo.park@example.com', 'Leo Park', 'Generic', '2026-08-06', 410, 5],
  ['ana.silva@example.com', 'Ana Silva', 'Remarketing', '2026-09-02', 160, 2],
  ['ben.cole@example.com', 'Ben Cole', 'Generic', '2026-09-08', 380, 9],
  ['  kai.berg@example.com', 'Kai Berg', 'Brand', '2026-09-12', 120, 4],
  ['ruth.ade@example.com', 'Ruth Ade', 'Generic', '2026-09-17', 610, 7],
  ['ana.silva@example.com', 'Ana Silva', 'Remarketing', '2026-09-02', 160, 2],
  ['joe.kim@example.com', 'Joe Kim', 'Brand', '2026-09-24', 210, 5],
  ['lina.voss@example.com', 'Lina Voss', 'Remarketing', '2026-09-28', 75, 1],
];
const MONTHS = { '08': 'Aug 2026', '09': 'Sep 2026' };

const cpa = (spend, conversions) => (conversions ? spend / conversions : null);
// Shown as Sheets shows a date cell formatted d mmm yyyy; the ISO form stays internal.
const shown = (iso) => Number(iso.slice(8)) + ' ' + MONTHS[iso.slice(5, 7)];

function clean() {
  const seen = new Set();
  return RAW.map((row) => row.map((value) => (typeof value === 'string' ? value.trim() : value)))
    .filter(([email]) => !seen.has(email) && seen.add(email))
    .map(([email, name, campaign, date, spend, conversions]) => {
      const [first, ...last] = name.split(' ');
      return { email, first, last: last.join(' '), campaign, date, spend, conversions };
    });
}

// ---- Sheets requests ---------------------------------------------------------------------
const value = (v) =>
  v === null || v === undefined
    ? {}
    : typeof v === 'number'
      ? { userEnteredValue: { numberValue: v } }
      : { userEnteredValue: { stringValue: String(v) } };
const MONEY = { numberFormat: { type: 'NUMBER', pattern: '#,##0.00' } };
const HEAD = { textFormat: { bold: true }, backgroundColor: { red: 0.93, green: 0.95, blue: 1 } };
const RED = { backgroundColor: { red: 0.957, green: 0.78, blue: 0.765 } };

function tab(sheetId, title, table, { widths = [], money = [], red = [], bold = [] } = {}) {
  const rows = table.map((row, r) => ({
    values: row.map((v, c) => {
      const cell = value(v);
      const format = {
        ...(r === 0 ? HEAD : {}),
        ...(r > 0 && money.includes(c) && typeof v === 'number' ? MONEY : {}),
        ...(red.some(([rr, cc]) => rr === r && cc === c) ? RED : {}),
        ...(bold.includes(r) ? { textFormat: { bold: true } } : {}),
      };
      if (Object.keys(format).length) cell.userEnteredFormat = format;
      return cell;
    }),
  }));
  return [
    {
      addSheet: {
        properties: { sheetId, title, gridProperties: { rowCount: 60, columnCount: 12 } },
      },
    },
    {
      updateCells: {
        start: { sheetId, rowIndex: 0, columnIndex: 0 },
        rows,
        fields: 'userEnteredValue,userEnteredFormat',
      },
    },
    ...widths.map((pixelSize, c) => ({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: c, endIndex: c + 1 },
        properties: { pixelSize },
        fields: 'pixelSize',
      },
    })),
  ];
}

function render(requests, title) {
  const model = replay([{ body: { requests } }], []);
  const sheet = [...model.sheets.values()].find((item) => item.props.title === title);
  return renderSheet(sheet, model, {});
}

export async function buildSheets(dir) {
  const before = [['Email', 'Name', 'Campaign', 'Date', 'Spend', 'Conversions', 'CPA']].concat(
    RAW.map(([email, name, campaign, date, spend, conversions]) => [
      email,
      name,
      campaign,
      shown(date),
      spend,
      conversions,
      cpa(spend, conversions),
    ])
  );
  const rows = clean();
  const header = [
    'Email',
    'First name',
    'Last name',
    'Campaign',
    'Date',
    'Spend',
    'Conversions',
    'CPA',
    'Status',
  ];
  const tidy = [header].concat(
    rows.map((r) => [
      r.email,
      r.first,
      r.last,
      r.campaign,
      shown(r.date),
      r.spend,
      r.conversions,
      cpa(r.spend, r.conversions),
      'New  ▾',
    ])
  );
  const widths = [190, 90, 90, 110, 96, 80, 96, 70, 80];
  const red = tidy.flatMap((row, r) => (r > 0 && row[7] > 50 ? [[r, 7]] : []));

  // Spend by campaign and month, with totals, as the pivot shows it.
  const campaigns = [...new Set(rows.map((r) => r.campaign))].sort();
  const months = Object.values(MONTHS);
  const sum = (filter) => rows.filter(filter).reduce((total, r) => total + r.spend, 0);
  const pivot = [['SUM of Spend', ...months, 'Grand Total']]
    .concat(
      campaigns.map((campaign) => [
        campaign,
        ...months.map((month) =>
          sum((r) => r.campaign === campaign && MONTHS[r.date.slice(5, 7)] === month)
        ),
        sum((r) => r.campaign === campaign),
      ])
    )
    .concat([
      [
        'Grand Total',
        ...months.map((month) => sum((r) => MONTHS[r.date.slice(5, 7)] === month)),
        sum(() => true),
      ],
    ]);

  const pages = {
    'export-before': render(
      tab(1, 'Leads export', before, { widths: [200, 100, 110, 96, 80, 96, 70], money: [4, 6] }),
      'Leads export'
    ),
    'export-clean': render(tab(1, 'Leads export', tidy, { widths, money: [5, 7] }), 'Leads export'),
    'export-red': render(
      tab(1, 'Leads export', tidy, { widths, money: [5, 7], red }),
      'Leads export'
    ),
    pivot: render(
      tab(2, 'Spend by campaign', pivot, {
        widths: [130, 100, 100, 110],
        money: [1, 2, 3],
        bold: [pivot.length - 1],
      }),
      'Spend by campaign'
    ),
  };
  for (const [name, html] of Object.entries(pages))
    await writeFile(path.join(dir, name + '.html'), html);
  return {
    rows: RAW.length,
    kept: rows.length,
    removed: RAW.length - rows.length,
    red: red.length,
    total: sum(() => true),
  };
}
