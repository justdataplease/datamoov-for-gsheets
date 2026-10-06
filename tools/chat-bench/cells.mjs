// How the benchmark reads one tab: which cells are live (a formula, its spilled result, a native
// pivot), which are typed numbers (pasted values, constant formulas such as =1610 or ={1;2}),
// which are labels or values a report fetched, which show an error, and where the table's header
// and data rows are.
import { ERROR_RE } from './formulas.mjs';

// A number typed as text: "$1,234.50", "12.5%", also with a unit after it ("3,345 USD", "12.3k",
// "1,200 €"), which a sheet shows as a number all the same.
const UNIT = String.raw`(?:\s*(?:[$€£¥]|USD|EUR|GBP|[kKmM]\b|bn\b))?`;
export const NUMERIC_TEXT = new RegExp(
  String.raw`^\s*[-+]?[$€£¥]?\s?\d{1,3}(?:,\d{3})*(?:\.\d+)?\s*%?${UNIT}\s*$|^\s*[-+]?[$€£¥]?\s?\d+(?:\.\d+)?\s*%?${UNIT}\s*$`
);
// The number a numeric text shows, its k/M/bn scale applied ("12.3k" is 12,300); null otherwise.
export function numberFromText(text) {
  if (typeof text !== 'string' || !NUMERIC_TEXT.test(text)) return null;
  const scale = /\d\s*k\s*$/i.test(text)
    ? 1e3
    : /\d\s*m\s*$/i.test(text)
      ? 1e6
      : /bn\s*$/i.test(text)
        ? 1e9
        : 1;
  const n = Number(text.replace(/(?:USD|EUR|GBP|bn)/gi, '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n * scale : null;
}
const FALLBACK_CAP = 3000; // formulas per tab the strict fallback evaluator tries
// A formula typed as text (set_values keeps text beginning with = as text): the sheet shows it.
const TEXT_FORMULA =
  /^=\s*(?:[A-Za-z][A-Za-z0-9.]*\s*\(|\$?[A-Za-z]{1,3}\$?\d+\b|'[^']+'!|[A-Za-z0-9_]+!)/;
// Functions whose result depends on where or when they run, or on data outside the formula.
const NOT_CONSTANT =
  /^(RAND|RANDBETWEEN|RANDARRAY|SEQUENCE|MAKEARRAY|TODAY|NOW|INDIRECT|OFFSET|ROW|COLUMN|ROWS|COLUMNS|CELL|SHEET|SHEETS|INFO|IMPORT[A-Z]*|GOOGLEFINANCE|GOOGLETRANSLATE|DETECTLANGUAGE)$/i;
const VOLATILE = /\b(RAND|RANDBETWEEN|RANDARRAY|TODAY|NOW)\s*\(/i;
export const OUTPUT_RECORD = 'dmv:v1:output';

const present = (v) => v !== '' && v !== null && v !== undefined;
const filled = (entry) => Boolean(entry && (entry.formula || present(entry.value)));
const numeric = (v) =>
  (typeof v === 'number' && Number.isFinite(v)) ||
  v instanceof Date ||
  (typeof v === 'string' && NUMERIC_TEXT.test(v));
const columnLabel = (n) => {
  let s = '';
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};
export const a1 = (r, c) => columnLabel(c) + r;

// A formula that reads no cell, range, name or outside data: a typed value in disguise.
const constants = new Map();
export function isConstantFormula(formula) {
  if (constants.has(formula)) return constants.get(formula);
  const body = String(formula)
    .replace(/^=/, '')
    .replace(/"(?:[^"]|"")*"/g, '""');
  let constant =
    !/!/.test(body) &&
    !/(?<![A-Za-z0-9_.])\$?[A-Za-z]{1,3}\$?\d+(?![A-Za-z0-9_]|\s*\()/.test(body) &&
    !/(?<![A-Za-z0-9_.])\$?[A-Za-z]{1,3}\s*:\s*\$?[A-Za-z]{1,3}(?![A-Za-z0-9_(])|(?<![\w.])\d+\s*:\s*\d+(?![\w.])/.test(
      body
    );
  if (constant)
    for (const m of body.matchAll(/(?<![A-Za-z0-9_.])[A-Za-z_][A-Za-z0-9_.]*/g)) {
      const call = /^\s*\(/.test(body.slice(m.index + m[0].length));
      if (call ? NOT_CONSTANT.test(m[0]) : !/^(TRUE|FALSE)$/i.test(m[0])) {
        constant = false; // outside data, or a named range / LET name
        break;
      }
    }
  constants.set(formula, constant);
  return constant;
}

export function signature(entry) {
  if (entry.spilledFrom) return 's' + entry.spilledFrom;
  if (entry.formula) return 'f' + entry.formula;
  return entry.value instanceof Date
    ? 'd' + entry.value.getTime()
    : 'v' + typeof entry.value + ':' + String(entry.value);
}

// Tabs a formula names (string literals left out): 'My tab'!A1, Data!B:B.
const TAB_REF = /(?:'((?:[^']|'')+)'|([A-Za-z0-9_.]+))!/g;
export function namedTabs(formula) {
  const body = String(formula).replace(/"(?:[^"]|"")*"/g, '""');
  return [...body.matchAll(TAB_REF)].map((m) => (m[1] ? m[1].replace(/''/g, "'") : m[2]));
}
// A formula that names a tab the book does not have shows #REF! in Sheets, and an IFERROR
// around it only hides the break (it shows the fallback): either way a broken formula.
function missingTab(entry, tabNames) {
  if (!entry.formula) return null;
  for (const name of namedTabs(entry.formula)) if (!tabNames.has(name.toLowerCase())) return name;
  return null;
}

// A formula whose result is text whatever it reads: a label joined from pieces ("Total: "&...)
// or a text function on the outside. Left unevaluated by the calculator, it is still no number.
const TEXT_RESULT =
  /^=\s*(?:"(?:[^"]|"")*"\s*&|(?:CONCATENATE|CONCAT|TEXTJOIN|JOIN|UPPER|LOWER|PROPER|SUBSTITUTE|TRIM|HYPERLINK|IMAGE|SPARKLINE)\s*\()/i;

// A row that totals the rows above it (a SUM or AVERAGE over a column range, or a first cell
// that reads Total), not a data row.
const AGGREGATE =
  /^=\s*(?:SUM|SUBTOTAL|AVERAGE|COUNTA?|MIN|MAX|MEDIAN|AGGREGATE)\s*\(\s*\$?[A-Za-z]{1,3}\$?\d+\s*:\s*\$?[A-Za-z]{1,3}\$?\d*\s*[,)]/i;
const TOTAL_LABEL = /^\s*(?:grand\s+)?(?:totals?|sum|subtotal|average|avg)\b\s*:?\s*$/i;

function cellError(entry) {
  if (entry.error)
    return typeof entry.value === 'string' && ERROR_RE.test(entry.value)
      ? entry.value
      : 'error:' + entry.error.type;
  if (typeof entry.value === 'string' && ERROR_RE.test(entry.value)) return entry.value;
  if (
    !entry.formula &&
    !entry.spilledFrom &&
    typeof entry.value === 'string' &&
    TEXT_FORMULA.test(entry.value)
  )
    return 'formula shown as text';
  return null;
}

// Areas a report or dashboard run wrote with fetched data (its output records), page areas
// excluded: a dashboard page is measured like any tab.
function fetchedAreas(sheet) {
  const areas = [];
  for (const item of sheet.developerMetadata || []) {
    if (!item || item.metadataKey !== OUTPUT_RECORD) continue;
    let record = null;
    try {
      record = JSON.parse(item.metadataValue);
    } catch {
      continue;
    }
    // A dashboard's page (<id>-report) and chart data tab (<id>-charts) are what it computed;
    // its dataset tabs (<id>-d-<dataset>) and report tabs hold what it fetched.
    const page = record && (record.page || /-(report|charts)$/.test(String(record.id || '')));
    if (
      record &&
      !page &&
      [record.row, record.column, record.rows, record.columns].every(Number.isInteger)
    )
      areas.push(record);
  }
  return areas;
}

// One tab. scope(key, entry) picks the cells this turn wrote; counts of formulas, live cells and
// typed values cover those only, while errors, rows and extent describe the whole tab.
export function tabStats(rt, sheet, scope = null) {
  const out = {
    name: sheet.name,
    nonEmpty: 0,
    turnCells: 0, // non-empty, error-free cells in scope
    formulaCells: 0,
    liveCells: 0,
    numericValueCells: 0,
    constantFormulas: 0,
    labelCells: 0,
    fetchedCells: 0,
    fetchedNumericCells: 0,
    sourceTab: false, // holds fetched report or dataset rows
    textValueCells: 0,
    spilledCells: 0,
    pivotCells: 0,
    volatileFormulas: 0,
    nonZeroNumbers: 0, // live or typed numbers in scope that are not 0
    liveZeroCells: 0, // live numbers in scope that show 0 (a filter that matched nothing, an empty fetch)
    summaryRows: 0, // rows under the header that total the rows above them
    errorCells: 0,
    errors: [],
    errorKeys: new Set(),
    unevaluated: 0,
    unevaluatedSample: [],
    fallbackEvaluated: 0,
    lastRow: 0,
    lastColumn: 0,
    headerRow: 0,
    dataRows: 0,
  };
  const cells = sheet.cells;
  const at = (r, c) => cells.get(`${r}:${c}`);
  const areas = fetchedAreas(sheet);
  const tabNames = new Set(rt.f.book.sheets.map((s) => s.name.toLowerCase()));
  const fetched = (r, c) =>
    areas.some(
      (a) => r >= a.row && r < a.row + a.rows && c >= a.column && c < a.column + a.columns
    );
  const live = (entry) => {
    if (!filled(entry)) return false;
    if (entry.formula) return !isConstantFormula(entry.formula);
    if (!entry.spilledFrom) return false;
    if (String(entry.spilledFrom).startsWith('pivot:')) return true;
    const anchor = cells.get(entry.spilledFrom);
    return Boolean(anchor && anchor.formula && !isConstantFormula(anchor.formula));
  };
  const textRows = new Map();
  const rowHasText = (r) => {
    if (!textRows.has(r)) {
      let found = false;
      for (let c = 1; c <= Math.min(sheet.maxColumns, 200) && !found; c++) {
        const e = at(r, c);
        found = Boolean(
          e &&
          !e.formula &&
          !e.spilledFrom &&
          typeof e.value === 'string' &&
          e.value.trim() &&
          !NUMERIC_TEXT.test(e.value) &&
          !ERROR_RE.test(e.value)
        );
      }
      textRows.set(r, found);
    }
    return textRows.get(r);
  };
  // A typed number that names a column (a year heading a column of live results, in a row of
  // headings) or a row (a date beside live results) is a label, not a pasted measure.
  const label = (r, c, value) => {
    if (live(at(r + 1, c))) {
      const above = at(r - 1, c);
      const top =
        !filled(above) ||
        (!above.formula &&
          !above.spilledFrom &&
          typeof above.value === 'string' &&
          !NUMERIC_TEXT.test(above.value));
      if (top && rowHasText(r)) return true;
    }
    return value instanceof Date && live(at(r, c + 1));
  };
  out.sourceTab = areas.length > 0;
  const countNumber = (value, isLive) => {
    const n = value instanceof Date ? 1 : typeof value === 'number' ? value : numberFromText(value);
    if (n === null || !Number.isFinite(n)) return;
    if (n !== 0) out.nonZeroNumbers++;
    else if (isLive) out.liveZeroCells++;
  };
  const perRow = new Map();
  let tried = 0;
  rt.f.reading(() => {
    for (const [key, entry] of cells) {
      if (!filled(entry)) continue;
      const [r, c] = key.split(':').map(Number);
      out.nonEmpty++;
      out.lastRow = Math.max(out.lastRow, r);
      out.lastColumn = Math.max(out.lastColumn, c);
      perRow.set(r, (perRow.get(r) || 0) + 1);
      let errorText = cellError(entry);
      if (!errorText) {
        const missing = missingTab(entry, tabNames);
        if (missing) errorText = `#REF! (names a tab "${missing}" the book does not have)`;
      }
      const unknown = Boolean(entry.formula && !errorText && entry.value === entry.formula);
      if (entry.formula && !errorText && entry.value === entry.formula) {
        // The calculator left it; the strict evaluator of tests/helpers tries a bounded number.
        let verdict = 'unevaluated';
        if (tried++ < FALLBACK_CAP) {
          try {
            const value = rt.f.shown(sheet, r, c);
            if (value && typeof value === 'object' && typeof value.error === 'string') {
              verdict = 'error';
              errorText = value.error + ' (fallback)';
            } else verdict = 'evaluated';
          } catch {
            /* a function the strict evaluator does not model */
          }
        }
        if (verdict === 'unevaluated') {
          out.unevaluated++;
          if (out.unevaluatedSample.length < 4)
            out.unevaluatedSample.push(`${a1(r, c)} ${entry.formula.slice(0, 600)}`);
        } else out.fallbackEvaluated++;
      }
      if (errorText) {
        out.errorCells++;
        out.errorKeys.add(key);
        if (out.errors.length < 8)
          out.errors.push(
            `${a1(r, c)} ${errorText}${entry.formula ? ' ' + entry.formula.slice(0, 600) : entry.spilledFrom ? ' (spilled)' : ''}`
          );
      }
      if (entry.formula && VOLATILE.test(entry.formula)) out.volatileFormulas++;
      if (scope && !scope(key, entry)) continue;
      // Written this turn; a cell that only shows an error is no delivered work.
      if (!errorText) out.turnCells++;
      const value = entry.value;
      if (entry.formula) {
        if (isConstantFormula(entry.formula)) {
          out.constantFormulas++;
          if (!errorText && numeric(value)) {
            if (label(r, c, value)) out.labelCells++;
            else {
              out.numericValueCells++;
              countNumber(value, false);
            }
          }
        } else {
          out.formulaCells++;
          // A live number: a formula showing a number (or one the calculator could not evaluate);
          // a label built by a formula or a formula showing an error is no number delivered.
          if (!errorText && ((unknown && !TEXT_RESULT.test(entry.formula)) || numeric(value))) {
            out.liveCells++;
            if (!unknown) countNumber(value, true);
          }
        }
      } else if (entry.spilledFrom) {
        if (String(entry.spilledFrom).startsWith('pivot:')) out.pivotCells++;
        else out.spilledCells++;
        if (live(entry)) {
          if (!errorText && numeric(value)) {
            out.liveCells++;
            countNumber(value, true);
          }
        } else if (!errorText && numeric(value)) {
          out.numericValueCells++;
          countNumber(value, false);
        }
      } else if (fetched(r, c)) {
        out.fetchedCells++;
        if (!errorText && numeric(value)) out.fetchedNumericCells++;
      } else if (!errorText && numeric(value)) {
        if (label(r, c, value)) out.labelCells++;
        else {
          out.numericValueCells++;
          countNumber(value, false);
        }
      } else if (!errorText) out.textValueCells++;
    }
  });
  // The header: the first row with two or more cells (a title row above it has one); the table
  // spans its contiguous run of cells; a data row fills at least half of that span.
  // The header: the first row with two or more cells and at least half the cells of the tab's
  // usual row (the most common count), so a title row of two cells above a wide table is not it.
  const rows = [...perRow.keys()].sort((a, b) => a - b);
  const widths = new Map();
  for (const n of perRow.values()) widths.set(n, (widths.get(n) || 0) + 1);
  let usual = 0,
    seen = 0;
  for (const [n, count] of widths)
    if (count > seen || (count === seen && n > usual)) [usual, seen] = [n, count];
  const least = Math.max(2, Math.ceil(usual / 2));
  out.headerRow =
    rows.find((r) => perRow.get(r) >= least) ??
    rows.find((r) => perRow.get(r) >= 2) ??
    rows[0] ??
    0;
  if (out.headerRow) {
    let first = 1;
    while (first <= out.lastColumn && !filled(at(out.headerRow, first))) first++;
    let width = 0;
    while (filled(at(out.headerRow, first + width))) width++;
    const need = Math.max(1, Math.ceil(width / 2));
    const inSpan = new Map();
    const summary = new Set();
    for (const [key, entry] of cells) {
      if (!filled(entry)) continue;
      const [r, c] = key.split(':').map(Number);
      if (r > out.headerRow && c >= first && c < first + width) {
        inSpan.set(r, (inSpan.get(r) || 0) + 1);
        if (
          (entry.formula && AGGREGATE.test(entry.formula)) ||
          (c === first &&
            !entry.formula &&
            typeof entry.value === 'string' &&
            TOTAL_LABEL.test(entry.value))
        )
          summary.add(r);
      }
    }
    for (const [r, n] of inSpan)
      if (n >= need) {
        if (summary.has(r)) out.summaryRows++;
        else out.dataRows++;
      }
  }
  return out;
}

// Numbers the book shows, for the claims check: every number on the given tabs, and on the data
// tab how often each value of each column occurs and how many distinct values it has.
export function shownNumbers(tabs, dataSheet, dataStats) {
  const shown = new Set();
  for (const sheet of tabs) {
    if (sheet === dataSheet) continue;
    for (const entry of sheet.cells.values()) {
      const v =
        typeof entry.value === 'number' ? entry.value : (numberFromText(entry.value) ?? NaN);
      if (Number.isFinite(v)) {
        shown.add(v);
        shown.add(Math.round(v));
      }
    }
  }
  if (dataSheet && dataStats) {
    const columns = new Map();
    for (const [key, entry] of dataSheet.cells) {
      if (!filled(entry)) continue;
      const [r, c] = key.split(':').map(Number);
      if (r <= dataStats.headerRow) continue;
      if (!columns.has(c)) columns.set(c, new Map());
      const counts = columns.get(c);
      const k =
        entry.value instanceof Date ? entry.value.getTime() : String(entry.value).toLowerCase();
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    for (const counts of columns.values()) {
      shown.add(counts.size);
      for (const n of counts.values()) shown.add(n);
    }
  }
  return shown;
}

// Whether a chart plots any number: its series ranges (all its ranges when it names no series)
// hold at least one number other than 0 (or, with no series named, a date).
export function chartHasData(book, chart) {
  const series = [],
    all = [];
  const walk = (node, inSeries) => {
    if (Array.isArray(node)) return node.forEach((n) => walk(n, inSeries));
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.sources))
      for (const source of node.sources) (inSeries ? series : all).push(source);
    for (const [key, value] of Object.entries(node)) walk(value, inSeries || key === 'series');
  };
  walk(chart.spec, false);
  for (const source of series.length ? series : all) {
    const sheet = book.sheets.find((s) => s.id === (source.sheetId ?? 0));
    if (!sheet) continue;
    const rowEnd = Math.min(source.endRowIndex ?? sheet.maxRows, sheet.maxRows),
      columnEnd = Math.min(source.endColumnIndex ?? sheet.maxColumns, sheet.maxColumns);
    for (let r = source.startRowIndex ?? 0; r < rowEnd; r++)
      for (let c = source.startColumnIndex ?? 0; c < columnEnd; c++) {
        // A series of zeros (an empty fetch, a filter that matched nothing) plots nothing.
        const v = sheet.cells.get(`${r + 1}:${c + 1}`)?.value;
        if (typeof v === 'number' && Number.isFinite(v) && v !== 0) return true;
        if (v instanceof Date && !series.length) return true;
      }
  }
  return false;
}
