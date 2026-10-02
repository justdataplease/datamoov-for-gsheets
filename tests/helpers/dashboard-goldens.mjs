// Dashboard tabs as they read, checked against goldens recorded before dashboards wrote live
// formulas: every page, chart data tab and data tab any test leaves behind must show exactly the
// text it showed then. The sandbox module watches every test file (watchDashboardPages), whose
// goldens are tests/goldens/<file name without .test.mjs>.json. Run with DMV_WRITE_GOLDENS=1 to
// record instead (only ever from source that writes no formulas yet).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { after, afterEach } from 'node:test';
import { shownText } from './sheet-formulas.mjs';

const folder = new URL('../goldens/', import.meta.url);

// Each dashboard output of a sandbox, as "<kind>: <tab>", and its cells' text row by row as
// "column:text" cells. Outputs are found by the current user's receipts and by the output records
// on the tabs, so another user's dashboard, or one whose receipt was never written, counts too.
export function dashboardText(f) {
  const areas = new Map();
  for (const [key, value] of f.state.user.data) {
    const match = /^dmv:v1:output:([^:]+):(.+-(?:report|charts|d-.+))$/.exec(key);
    if (match) areas.set(match[1] + ':' + match[2], { book: match[1], id: match[2], ...JSON.parse(value) });
  }
  for (const [id, book] of f.state.books)
    for (const sheet of book.sheets)
      for (const item of sheet.developerMetadata) {
        if (item.metadataKey !== 'dmv:v1:output') continue;
        const record = JSON.parse(item.metadataValue);
        if (record.kind !== 'dashboard' || record.spreadsheetId !== id || areas.has(id + ':' + record.id)) continue;
        areas.set(id + ':' + record.id, { book: id, ...record, sheetId: sheet.id });
      }
  const out = {};
  for (const area of areas.values()) {
    const sheet = f.state.books.get(area.book)?.sheets.find((item) => item.id === area.sheetId);
    if (!sheet) continue;
    const rows = [];
    for (let r = area.row; r < area.row + area.rows; r++) {
      const cells = [];
      for (let c = area.column; c < area.column + area.columns; c++) {
        const text = shownText(f.shown(sheet, r, c), f.format(sheet, r, c).numberFormat);
        if (text !== '') cells.push(c + ':' + text);
      }
      rows.push(cells.join(' ¦ '));
    }
    const kind = /-(report|charts)$/.exec(area.id)?.[1];
    out[({ report: 'page', charts: 'charts' }[kind] || 'data') + ': ' + sheet.name] = rows;
  }
  return out;
}

const digest = (rows) => createHash('sha256').update(rows.join('\n')).digest('hex').slice(0, 16);

let exemption = null;

// A test file whose dashboards no source without formulas could write (more rows than it took)
// checks them another way, and says how here; its dashboards are then not compared.
export function exemptDashboardPages(reason) {
  assert.ok(reason, 'an exemption says why');
  exemption = reason;
}

// Checks, after each test of this file, the dashboards of the sandboxes made since the last one,
// and after the file that every golden was visited, so a renamed test or one that no longer
// leaves a dashboard is not left unchecked.
export function watchDashboardPages(sandboxes) {
  const name = basename(process.argv[1]).replace(/\.test\.mjs$/, ''),
    file = new URL(name + '.json', folder),
    write = process.env.DMV_WRITE_GOLDENS === '1',
    // A run of some tests only visits some goldens.
    filtered = process.execArgv.some((arg) => /^--test-(name-pattern|skip-pattern|only)/.test(arg));
  const golden = !write && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null,
    recorded = {},
    visited = new Set();
  afterEach((t) => {
    const made = sandboxes.splice(0);
    if (exemption) return;
    const texts = made.map(dashboardText).filter((tabs) => Object.keys(tabs).length);
    if (!texts.length) return;
    const digests = texts.map((tabs) => Object.fromEntries(Object.entries(tabs).map(([tab, rows]) => [tab, digest(rows)])));
    visited.add(t.name);
    if (write) return void (recorded[t.name] = digests);
    // A test that leaves dashboard tabs needs its goldens.
    if (!golden?.[t.name]) assert.fail('No dashboard goldens for "' + t.name + '" in ' + name + '.json. Record them with DMV_WRITE_GOLDENS=1.');
    // A tab that reads differently is shown whole, so the failure says what it reads now.
    const changed = texts.flatMap((tabs, index) =>
      Object.entries(tabs)
        .filter(([tab, rows]) => golden[t.name][index]?.[tab] !== digest(rows))
        .map(([tab, rows]) => tab + '\n' + rows.join('\n'))
    );
    assert.deepEqual(digests, golden[t.name], 'the dashboard reads as it did before live formulas:\n' + changed.join('\n\n'));
  });
  after(() => {
    if (write && visited.size) {
      mkdirSync(folder, { recursive: true });
      writeFileSync(file, JSON.stringify(recorded, null, 1) + '\n');
    }
    if (write || filtered || !golden) return;
    assert.deepEqual(
      Object.keys(golden).filter((key) => !visited.has(key)),
      [],
      'every golden in ' + name + '.json belongs to a test that leaves a dashboard'
    );
  });
}
