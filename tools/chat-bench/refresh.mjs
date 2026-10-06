// Reports-to-dashboard: does a dashboard built over saved report tabs still cover every row
// after the reports refresh with more rows? Measured from the book: before the refresh, the
// ranges (formulas, chart sources, pivot sources) that cover a report tab's whole table and the
// cells that show a report column's total; the fake then serves more rows, every saved report
// and saved dashboard runs again as Refresh would (no AI), the book recalculates, and each range
// must still reach the tab's last row and each total cell must show the new total.
import { tabStats, numberFromText, OUTPUT_RECORD } from './cells.mjs';

const REF =
  /(?:'((?:[^']|'')+)'|([A-Za-z0-9_.]+))!\$?([A-Z]{1,3})\$?(\d+)?(?::\$?([A-Z]{1,3})\$?(\d+)?)?/g;

// The saved reports of the book and their tabs.
export function reportTabs(rt) {
  let reports = [];
  try {
    reports = rt.api.dmvListReports();
  } catch {
    return [];
  }
  return reports
    .map((report) => ({
      id: report.id,
      name: report.name,
      reportType: report.reportType,
      sheet:
        rt.f.book.sheets.find((s) => s.name === (report.target && report.target.sheetName)) || null,
    }))
    .filter((r) => r.sheet);
}

// Ranges on other tabs that read a report tab: { where, tabId, endRow (null = open-ended) }.
function references(rt, reportIds) {
  const book = rt.f.book;
  const byName = new Map(book.sheets.map((s) => [s.name.toLowerCase(), s.id]));
  const refs = [];
  for (const sheet of book.sheets) {
    if (reportIds.has(sheet.id)) continue;
    for (const [key, entry] of sheet.cells) {
      if (!entry.formula) continue;
      for (const m of entry.formula.matchAll(REF)) {
        const name = (m[1] ? m[1].replace(/''/g, "'") : m[2]).toLowerCase();
        const id = byName.get(name);
        if (id === undefined || !reportIds.has(id)) continue;
        if (!m[5]) continue; // one cell, not a range
        refs.push({
          kind: 'formula',
          where: `${sheet.name}!${key}`,
          tabId: id,
          endRow: m[6] ? Number(m[6]) : null,
        });
      }
    }
  }
  for (const chart of rt.state.charts.filter((c) => c.spreadsheetId === book.id)) {
    const walk = (node) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node.sources))
        for (const s of node.sources)
          if (reportIds.has(s.sheetId ?? 0))
            refs.push({
              kind: 'chart',
              where: `chart ${chart.chartId}`,
              tabId: s.sheetId ?? 0,
              endRow: s.endRowIndex ?? null,
            });
      Object.values(node).forEach(walk);
    };
    walk(chart.spec);
  }
  for (const sheet of book.sheets)
    for (const [anchor, meta] of sheet.meta) {
      const source = meta && meta.pivotTable && meta.pivotTable.source;
      if (source && reportIds.has(source.sheetId ?? 0))
        refs.push({
          kind: 'pivot',
          where: `${sheet.name}!${anchor} pivot`,
          tabId: source.sheetId ?? 0,
          endRow: source.endRowIndex ?? null,
        });
    }
  return refs;
}

// Per numeric column of a report tab, the total of its data rows.
function columnTotals(rt, sheet) {
  const stats = tabStats(rt, sheet);
  const sums = new Map();
  for (const [key, entry] of sheet.cells) {
    const [r, c] = key.split(':').map(Number);
    if (r <= stats.headerRow || typeof entry.value !== 'number') continue;
    sums.set(c, (sums.get(c) || 0) + entry.value);
  }
  return { lastRow: stats.lastRow, dataRows: stats.dataRows, sums };
}
// A number, or numeric text a typed value shows ("55406.53", "$1,200").
const numberOf = (v) =>
  typeof v === 'number' && Number.isFinite(v)
    ? v
    : typeof v === 'string' && !/%/.test(v)
      ? numberFromText(v)
      : null;
const same = (a, b) => Math.abs(a - b) <= Math.max(1e-6, 1e-6 * Math.abs(b));

// What the dashboard reads of the report tabs, before the refresh.
export function captureBeforeRefresh(rt) {
  const reports = reportTabs(rt);
  const ids = new Set(reports.map((r) => r.sheet.id));
  const tabs = new Map(reports.map((r) => [r.sheet.id, columnTotals(rt, r.sheet)]));
  // Cells elsewhere showing a report column's whole total (a KPI).
  const kpis = [];
  for (const sheet of rt.f.book.sheets) {
    if (ids.has(sheet.id)) continue;
    for (const [key, entry] of sheet.cells) {
      const value = numberOf(entry.value);
      if (value === null || !value) continue;
      for (const [tabId, t] of tabs)
        for (const [column, total] of t.sums)
          if (Math.abs(total) >= 10 && same(value, total))
            kpis.push({
              sheetId: sheet.id,
              sheetName: sheet.name,
              key,
              tabId,
              column,
              before: total,
              live: Boolean(entry.formula || entry.spilledFrom),
            });
    }
  }
  // Typed numbers (not labels) on the tabs the model built: a refresh cannot reach them, so a
  // dashboard of pasted figures cannot follow one even when none of them is a whole-column total
  // (a pasted per-campaign table). Tabs a saved dashboard's run writes are rebuilt by Refresh.
  const frozen = [];
  for (const sheet of rt.f.book.sheets) {
    if (ids.has(sheet.id)) continue;
    if ((sheet.developerMetadata || []).some((m) => m && m.metadataKey === OUTPUT_RECORD)) continue;
    const n = tabStats(rt, sheet).numericValueCells;
    if (n) frozen.push({ name: sheet.name, n });
  }
  return { reports, ids, tabs, kpis, frozen };
}

// Refreshes every saved report and saved dashboard against a grown fake, then measures.
export function refreshAndMeasure(rt, before, { growth = 1.2 } = {}) {
  const errors = [];
  rt.ads.grow(growth);
  for (const report of before.reports) {
    try {
      const out = rt.api.dmvRunReport(report.id);
      if (!out || out.ok === false)
        errors.push(`${report.name}: ${JSON.stringify(out).slice(0, 200)}`);
    } catch (error) {
      errors.push(`${report.name}: ${String(error && error.message).slice(0, 200)}`);
    }
  }
  let dashboards = [];
  try {
    dashboards = rt.api.dmvListDashboards();
  } catch {
    /* none */
  }
  for (const dashboard of dashboards) {
    try {
      rt.api.dmvRunDashboard(dashboard.id);
    } catch (error) {
      errors.push(`dashboard ${dashboard.name}: ${String(error && error.message).slice(0, 200)}`);
    }
  }
  rt.recalc();
  const book = rt.f.book;
  const after = new Map();
  for (const report of before.reports) after.set(report.sheet.id, columnTotals(rt, report.sheet));
  // A range that covered the whole table before the refresh must reach its new last row. The
  // ranges are read as they stand after the refresh: a saved dashboard's run rewrites its page and
  // sizes every range again, so a range captured before it says nothing about the refreshed page.
  // A formula, chart or pivot counts once, stale when any of its whole-table ranges is.
  const covers = (ref) => ref.endRow === null || ref.endRow >= before.tabs.get(ref.tabId).lastRow;
  const stale = (ref) => ref.endRow !== null && ref.endRow < after.get(ref.tabId).lastRow;
  const objects = new Map();
  for (const ref of references(rt, before.ids)) {
    if (!objects.has(ref.where)) objects.set(ref.where, []);
    objects.get(ref.where).push(ref);
  }
  const wholeRanges = [],
    staleRefs = [];
  let partial = 0;
  for (const refs of objects.values()) {
    const whole = refs.filter(covers);
    if (!whole.length) {
      partial++;
      continue;
    }
    wholeRanges.push(whole[0]);
    const bad = whole.find(stale);
    if (bad) staleRefs.push(bad);
  }
  const tracked = before.kpis.filter(
    (k) => !same(after.get(k.tabId).sums.get(k.column) ?? 0, k.before)
  );
  // A tab that showed a column's total in n cells must show the new total in n cells. They are
  // counted on the tab rather than looked up where they were: a refreshed page may move them (a
  // table that gains rows moves its total row down). The cells that no longer show it are named.
  const staleKpis = [];
  const groups = new Map();
  for (const k of tracked) {
    const group = `${k.sheetId}:${k.tabId}:${k.column}`;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(k);
  }
  for (const group of groups.values()) {
    const { sheetId, sheetName, tabId, column } = group[0];
    const sheet =
      book.sheets.find((s) => s.id === sheetId) || book.sheets.find((s) => s.name === sheetName);
    const total = after.get(tabId).sums.get(column);
    const shows = (entry) => {
      const value = numberOf(entry && entry.value);
      return value !== null && same(value, total);
    };
    const fresh = sheet ? [...sheet.cells.values()].filter(shows).length : 0;
    const missing = Math.max(0, group.length - fresh);
    staleKpis.push(
      ...group.filter((k) => !(sheet && shows(sheet.cells.get(k.key)))).slice(0, missing)
    );
  }
  const name = (id) => book.sheets.find((s) => s.id === id)?.name;
  const frozen = before.frozen.reduce((a, x) => a + x.n, 0);
  const checked = wholeRanges.length + tracked.length + frozen;
  return {
    refresh_errors: errors,
    report_rows_before: before.reports.map(
      (r) => `${r.sheet.name}:${before.tabs.get(r.sheet.id).dataRows}`
    ),
    report_rows_after: before.reports.map(
      (r) => `${r.sheet.name}:${after.get(r.sheet.id).dataRows}`
    ),
    ranges_checked: wholeRanges.length,
    ranges_partial: partial,
    stale_ranges: staleRefs.length,
    kpis_checked: tracked.length,
    stale_kpis: staleKpis.length,
    frozen_numbers: frozen,
    stale_after_refresh: checked ? staleRefs.length + staleKpis.length + frozen > 0 : null,
    stale_sample: staleRefs
      .slice(0, 4)
      .map(
        (r) =>
          `${r.kind} ${r.where} ends at row ${r.endRow}; ${name(r.tabId)} now ends at ${after.get(r.tabId).lastRow}`
      )
      .concat(
        before.frozen
          .slice(0, 2)
          .map((x) => `${x.name} holds ${x.n} typed number(s) a refresh cannot update`)
      )
      .concat(
        staleKpis
          .slice(0, 4)
          .map(
            (k) =>
              `${name(k.sheetId)}!${k.key} still shows ${k.before} (${k.live ? 'formula' : 'typed value'}); ${name(k.tabId)} column ${k.column} now totals ${Math.round(after.get(k.tabId).sums.get(k.column) * 100) / 100}`
          )
      ),
  };
}

// The report tabs a turn changed (cells whose content differs from the snapshot at its start).
export function reportTabsEdited(rt, before, signature) {
  const edited = [];
  for (const report of reportTabs(rt)) {
    const was = before.sheets.get(report.sheet.id);
    if (!was) continue;
    let changed = false;
    if (was.signatures) {
      if (was.signatures.size !== report.sheet.cells.size) changed = true;
      else
        for (const [key, entry] of report.sheet.cells)
          if (was.signatures.get(key) !== signature(entry)) {
            changed = true;
            break;
          }
    } else {
      const stats = tabStats(rt, report.sheet);
      changed = stats.lastRow !== was.lastRow || stats.lastColumn !== was.lastColumn;
    }
    if (changed) edited.push(report.sheet.name);
  }
  return edited;
}

// Which way a dashboard turn went: the saved-dashboard engine over the source, formulas, charts
// or pivots over the report tabs, or something else.
export function dashboardPath(rt, result) {
  const saved =
    result.tools.some((t) => t.name === 'save_dashboard' && !t.error) ||
    result.tools.some((t) => t.name === 'run_dashboard' && !t.error);
  const reports = reportTabs(rt);
  const reads = references(rt, new Set(reports.map((r) => r.sheet.id))).length > 0;
  return {
    path: saved ? 'save_dashboard' : reads ? 'hand_built' : 'other',
    reads_report_tabs: reads,
  };
}
