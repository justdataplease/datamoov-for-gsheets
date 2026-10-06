// The chat benchmark's measures of one turn. Every number comes from the in-memory book and the
// run (tool trace, stop reason, clock), never from what the model says; the model's words are
// only compared against the book (claims.mjs). Cell reading is in cells.mjs; totals and the
// markdown table in report.mjs.
import { tabStats, signature, shownNumbers, chartHasData } from './cells.mjs';
import { checkClaims } from './claims.mjs';

const SIGNATURE_CAP = 300000; // cells per tab compared one by one; larger tabs compare by extent

function liveCharts(rt) {
  return rt.state.charts.filter((chart) => chart.spreadsheetId === rt.f.book.id);
}
const chartTab = (chart) => chart.position?.overlayPosition?.anchorCell?.sheetId ?? 0;
function pivotKeys(book) {
  const keys = [];
  for (const sheet of book.sheets)
    for (const [anchor, meta] of sheet.meta)
      if (meta && meta.pivotTable) keys.push(sheet.id + ':' + anchor);
  return keys;
}
// A pivot that drew at least one row below its header.
function pivotHasRows(book, key) {
  const split = key.indexOf(':');
  const sheet = book.sheets.find((s) => s.id === Number(key.slice(0, split)));
  const anchor = key.slice(split + 1);
  const top = Number(anchor.split(':')[0]);
  for (const [cell, entry] of sheet ? sheet.cells : [])
    if (entry.spilledFrom === 'pivot:' + anchor && Number(cell.split(':')[0]) > top) return true;
  return false;
}

// What the book looks like at the start of a turn: per tab its extent, errors and (except for
// the data tab and very large tabs, compared by extent) each cell's content.
export function snapshot(rt, dataSheetId = null) {
  const sheets = new Map();
  for (const sheet of rt.f.book.sheets) {
    const stats = tabStats(rt, sheet);
    let signatures = null;
    if (sheet.id !== dataSheetId && sheet.cells.size <= SIGNATURE_CAP) {
      signatures = new Map();
      for (const [key, entry] of sheet.cells) signatures.set(key, signature(entry));
    }
    sheets.set(sheet.id, {
      name: sheet.name,
      nonEmpty: stats.nonEmpty,
      lastRow: stats.lastRow,
      lastColumn: stats.lastColumn,
      shape: `${sheet.name}|${sheet.maxRows}|${sheet.maxColumns}`,
      signatures,
      errorKeys: stats.errorKeys,
    });
  }
  return {
    sheets,
    charts: new Set(liveCharts(rt).map((c) => c.chartId)),
    pivots: new Set(pivotKeys(rt.f.book)),
  };
}

// The generated data tab after turn 1: the tab holding the most data rows.
export function findDataSheet(rt) {
  let best = null,
    rows = 0;
  for (const sheet of rt.f.book.sheets) {
    const { dataRows } = tabStats(rt, sheet);
    if (dataRows > rows) {
      best = sheet;
      rows = dataRows;
    }
  }
  return best;
}

// The cells a turn wrote on a tab: all of a new tab; on an earlier tab the cells whose content
// changed, or (data tab, very large tabs) the cells beyond its extent at the start of the turn.
function turnScope(before, sheet) {
  const was = before.sheets.get(sheet.id);
  if (!was) return null;
  if (was.signatures) return (key, entry) => was.signatures.get(key) !== signature(entry);
  return (key) => {
    const [r, c] = key.split(':').map(Number);
    return r > was.lastRow || c > was.lastColumn;
  };
}

// Every measure of one turn.
export function measureTurn(rt, { before, result, turn, kind, rowsRequested, dataSheetId, nouns }) {
  const book = rt.f.book;
  const dataSheet = book.sheets.find((s) => s.id === dataSheetId) || null;
  const charts = liveCharts(rt);
  const all = book.sheets.map((sheet) => {
    // The generated dataset is values by design; its turn is judged by its rows.
    const scope = sheet === dataSheet && turn === 1 ? () => false : turnScope(before, sheet);
    const stats = tabStats(rt, sheet, scope);
    const chartCount = charts.filter((c) => chartTab(c) === sheet.id).length;
    return { sheet, stats, empty: stats.nonEmpty === 0 && chartCount === 0 };
  });
  const dataStats = dataSheet ? all.find((x) => x.sheet === dataSheet).stats : null;
  const rowsWritten = dataStats ? dataStats.dataRows : 0;
  // Tabs this turn made: new ones, and ones that were empty when it started, now holding something.
  const derived = all.filter(({ sheet, empty, stats }) => {
    if (sheet === dataSheet || empty || stats.sourceTab) return false;
    const was = before.sheets.get(sheet.id);
    return !was || was.nonEmpty === 0;
  });
  const emptyNewTabs = all.filter(({ sheet, empty }) => empty && !before.sheets.has(sheet.id));
  const newCharts = charts.filter((c) => !before.charts.has(c.chartId));
  const chartsWithData = newCharts.filter((c) => chartHasData(book, c)).length;
  const newPivots = pivotKeys(book).filter((k) => !before.pivots.has(k));
  const pivotsWithRows = newPivots.filter((k) => pivotHasRows(book, k)).length;
  const sum = (list, key) => list.reduce((a, x) => a + x.stats[key], 0);
  // Tabs holding fetched rows (saved report tabs, a saved dashboard's dataset tabs) are measured
  // apart: fetched values are what they are for. Every other tab, a dashboard page included,
  // makes the formula share.
  const own = all.filter(({ stats }) => !stats.sourceTab);
  const source = all.filter(({ stats }) => stats.sourceTab);
  const liveCells = sum(own, 'liveCells');
  const numericValues = sum(own, 'numericValueCells');
  const sourceLive = sum(source, 'liveCells');
  const sourceNumbers =
    sourceLive + sum(source, 'numericValueCells') + sum(source, 'fetchedNumericCells');
  const turnCells = sum(all, 'turnCells');
  const errorCellsNew = all.reduce((a, { sheet, stats }) => {
    const was = before.sheets.get(sheet.id);
    return a + [...stats.errorKeys].filter((key) => !was || !was.errorKeys.has(key)).length;
  }, 0);
  const unevaluated = sum(all, 'unevaluated');
  const tools = result.tools;
  const savedDashboard = tools.some(
    (t) => /^(save_dashboard|run_dashboard)$/.test(t.name) && !t.error
  );
  // A dashboard tab is one with content that this turn made or added to, named as a dashboard,
  // or a tab this turn made that holds a new chart with data (whatever its name: "Ops overview").
  const chartWithDataOn = (sheet) =>
    newCharts.some((c) => chartTab(c) === sheet.id && chartHasData(book, c));
  const dashboardTab =
    savedDashboard ||
    all.some(
      ({ sheet, stats, empty }) =>
        !empty &&
        ((/dashboard/i.test(sheet.name) &&
          (!before.sheets.has(sheet.id) ||
            stats.turnCells > 0 ||
            newCharts.some((c) => chartTab(c) === sheet.id))) ||
          (!before.sheets.has(sheet.id) && !stats.sourceTab && chartWithDataOn(sheet)))
    );
  const shapeChanged =
    book.sheets.length !== before.sheets.size ||
    book.sheets.some(
      (s) => before.sheets.get(s.id)?.shape !== `${s.name}|${s.maxRows}|${s.maxColumns}`
    );
  // Numbers other than 0 this turn put in the book (its own tabs and a saved dashboard's page):
  // a summary of headings only, or a page of zeros over an empty fetch, delivers nothing.
  const nonZero = sum(own, 'nonZeroNumbers');
  // Done means the app answered and the turn left what its kind asks for in the book: the rows
  // asked for (within the rows pass, 0.99), numbers in a summary, a chart or pivot with data or
  // numbers on a dashboard, a saved report (with rows: conversation.mjs).
  const delivered =
    kind === 'generate'
      ? rowsRequested
        ? rowsWritten >= 0.99 * rowsRequested
        : turnCells > 0 || shapeChanged || newCharts.length > 0
      : kind === 'summarize'
        ? nonZero > 0 || pivotsWithRows > 0
        : kind === 'analysis'
          ? String(result.text || '').trim().length > 0
          : kind === 'save_report'
            ? tools.some((t) => t.name === 'save_report' && !t.error)
            : kind === 'edit'
              ? turnCells > 0 || newCharts.length > 0 || savedDashboard
              : chartsWithData > 0 || pivotsWithRows > 0 || nonZero > 0;
  const claims = checkClaims(result.text, {
    nouns,
    tabs: all,
    dataRows: rowsWritten,
    evidence: shownNumbers(book.sheets, dataSheet, dataStats),
  });
  const ratio = (a, b) => (b ? Math.round((a / b) * 10000) / 10000 : null);
  return {
    turn,
    kind,
    stop: result.stop,
    delivered,
    completed: result.stop === 'answer' && delivered,
    rows_requested: rowsRequested,
    rows_written: rowsWritten,
    rows_ratio: rowsRequested ? ratio(rowsWritten, rowsRequested) : null,
    rows_approx: Boolean(dataStats && dataStats.unevaluated > 0),
    data_tab: dataSheet ? dataSheet.name : null,
    data_header_row: dataStats ? dataStats.headerRow : null,
    data_summary_rows: dataStats ? dataStats.summaryRows : 0,
    data_volatile: Boolean(dataStats && dataStats.volatileFormulas > 0),
    derived_tabs: derived.map(({ sheet }) => sheet.name),
    empty_new_tabs: emptyNewTabs.length,
    turn_cells: turnCells,
    formula_cells: sum(all, 'formulaCells'),
    live_cells: liveCells,
    value_cells: numericValues,
    constant_formulas: sum(all, 'constantFormulas'),
    label_cells: sum(all, 'labelCells'),
    fetched_cells: sum(all, 'fetchedCells'),
    // Of the numbers this turn put in the book, the share that is live (fetched-data tabs apart).
    formula_share: ratio(liveCells, liveCells + numericValues),
    nonzero_numbers: nonZero,
    live_zero_cells: sum(own, 'liveZeroCells'),
    source_tabs: source.filter(({ stats }) => stats.turnCells > 0).map(({ sheet }) => sheet.name),
    source_formula_share: ratio(sourceLive, sourceNumbers),
    error_cells: sum(all, 'errorCells'),
    error_cells_new: errorCellsNew,
    error_cells_derived: sum(derived, 'errorCells'),
    errors_approx: unevaluated > 0,
    unevaluated_formulas: unevaluated,
    fallback_evaluated: sum(all, 'fallbackEvaluated'),
    tool_reported_errors: tools.reduce((a, t) => a + (t.reportedErrors || 0), 0),
    charts: chartsWithData,
    charts_empty: newCharts.length - chartsWithData,
    pivots: pivotsWithRows,
    pivots_empty: newPivots.length - pivotsWithRows,
    dashboard_tab: dashboardTab,
    saved_dashboard: savedDashboard,
    failed_steps: tools.filter((t) => t.error).length,
    malformed_calls: result.malformedCalls || 0,
    rounds: result.rounds,
    seconds: result.seconds,
    wall_seconds: result.wallSeconds,
    calc_seconds: result.calcSeconds,
    needs_confirmation: tools.filter((t) => t.needsConfirmation).length,
    confirms_sent: result.confirmsSent,
    claims_mismatch: claims.mismatch,
    claims_evidence: claims.evidence,
    // Diagnostics (not measures).
    error_sample: all
      .flatMap(({ sheet, stats }) => stats.errors.map((e) => sheet.name + '!' + e))
      .slice(0, 8),
    unevaluated_sample: all
      .flatMap(({ sheet, stats }) => stats.unevaluatedSample.map((e) => sheet.name + '!' + e))
      .slice(0, 6),
    failed_step_sample: tools
      .filter((t) => t.error)
      .slice(0, 6)
      .map((t) => `${t.name}${t.action ? '/' + t.action : ''}: ${t.error}`),
    // Per tab: extent, header row, data rows, and this turn's formulas / live / typed numbers.
    tabs: all.map(
      ({ sheet, stats }) =>
        `${sheet.name}[${stats.lastRow}x${stats.lastColumn} hdr=${stats.headerRow} rows=${stats.dataRows} turn: f=${stats.formulaCells} live=${stats.liveCells} v=${stats.numericValueCells} err=${stats.errorCells} uneval=${stats.unevaluated}]`
    ),
    reply: String(result.text || '').slice(0, 1500),
  };
}

// Chart titles by id (an edit asking for a chart is checked against the titles before it).
export function chartTitles(rt) {
  return new Map(liveCharts(rt).map((c) => [c.chartId, String(c.spec?.title || '')]));
}

// Saved dashboard plans of the book, unpacked (empty when there are none).
export function savedPlans(rt) {
  try {
    return rt.api.dmvListDashboards().map((d) => {
      const record = rt.api.dmvDashboardHere_(d.id);
      return typeof rt.api.dmvUnpack_ === 'function' && typeof record.plan === 'string'
        ? JSON.parse(JSON.stringify(rt.api.dmvUnpack_(record.plan)))
        : record.plan || record;
    });
  } catch {
    return [];
  }
}

// Whether an edit turn did what it asked, read from the book and the saved plans:
// weekly_chart: a chart titled by week that was not there, or a saved tile bucketed by week;
// range_90: a saved dataset on the last 90 days, or a tab changed this turn whose dates span 80+
// days.
// Only what the turn added counts: a weekly tile or 90-day dataset already saved before it does
// not.
export function editApplied(rt, { before, titlesBefore, plansBefore = [], edit }) {
  const plans = savedPlans(rt);
  const weeklyTiles = (list) =>
    new Set(
      list.flatMap((plan) =>
        (plan.tiles || [])
          .filter(
            (t) =>
              t.type !== 'kpi' &&
              t.type !== 'table' &&
              (t.dateBucket === 'week' || /week/i.test(t.title || ''))
          )
          .map((t) => `${plan.name}|${t.title}|${t.dateBucket || ''}`)
      )
    );
  const longDatasets = (list) =>
    new Set(
      list.flatMap((plan) =>
        (plan.datasets || [])
          .filter((d) => d.dateRange && d.dateRange.preset === 'last90')
          .map((d) => `${plan.name}|${d.id}`)
      )
    );
  const added = (now, was) => [...now].some((key) => !was.has(key));
  if (edit === 'weekly_chart') {
    const known = new Set(titlesBefore.values());
    for (const title of chartTitles(rt).values())
      if (/week/i.test(title) && !known.has(title)) return true;
    return added(weeklyTiles(plans), weeklyTiles(plansBefore));
  }
  if (edit === 'range_90') {
    if (added(longDatasets(plans), longDatasets(plansBefore))) return true;
    for (const sheet of rt.f.book.sheets) {
      const was = before.sheets.get(sheet.id);
      let lo = Infinity,
        hi = -Infinity,
        changed = !was;
      for (const [key, entry] of sheet.cells) {
        if (was && was.signatures && !changed && was.signatures.get(key) !== signature(entry))
          changed = true;
        const v = entry.value;
        const day =
          v instanceof Date
            ? v.getTime() / 86400000 + 25569
            : typeof v === 'number' && sheet.formats.get(key)?.numberFormat?.type === 'DATE'
              ? v
              : null;
        if (day === null) continue;
        lo = Math.min(lo, day);
        hi = Math.max(hi, day);
      }
      if (changed && hi - lo >= 80) return true;
    }
    return false;
  }
  return null;
}
