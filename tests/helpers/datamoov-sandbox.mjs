import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync, inflateRawSync } from 'node:zlib';

export const plain = (value) => JSON.parse(JSON.stringify(value));

// RFC 4180 CSV as Utilities.parseCsv returns it: an array of rows of strings.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += char;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Minimal ZIP reader (stored or deflated entries) standing in for Utilities.unzip.
function unzip(buffer) {
  const blobs = [];
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8), compressed = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26), extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.toString('utf8', offset + 30, offset + 30 + nameLength);
    const start = offset + 30 + nameLength + extraLength;
    const data = buffer.subarray(start, start + compressed);
    const bytes = method === 8 ? inflateRawSync(data) : data;
    blobs.push({ getName: () => name, getDataAsString: () => bytes.toString('utf8'), getBytes: () => [...bytes] });
    offset = start + compressed;
  }
  return blobs;
}

function properties(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getProperty: (key) => data.has(key) ? data.get(key) : null,
    setProperty(key, value) { data.set(key, String(value)); return this; },
    deleteProperty(key) { data.delete(key); return this; },
    getProperties: () => Object.fromEntries(data),
  };
}

// The Sheets API answers in proto3 JSON: zero, false, empty and unset fields are left out, while a
// value inside a oneof (a cell's numberValue 0 or boolValue false) stays.
const ONEOF_VALUES = new Set(['numberValue', 'boolValue', 'stringValue', 'formulaValue']);
function apiJson(value) {
  if (Array.isArray(value)) return value.map(apiJson);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || item === null) continue;
    if (!ONEOF_VALUES.has(key) && (item === 0 || item === false || item === '' || (Array.isArray(item) && !item.length))) continue;
    out[key] = apiJson(item);
  }
  return out;
}

// Field masks such as 'sheets(properties.sheetId,data.rowData.values(note))' as a tree of selected keys.
function parseFieldMask(text) {
  let i = 0;
  const name = () => {
    const start = i;
    while (i < text.length && !',.()'.includes(text[i])) i++;
    const value = text.slice(start, i).trim();
    if (!value) throw new Error(`Invalid field mask: ${text}`);
    return value;
  };
  const insert = (tree, path, leaf) => {
    let node = tree;
    for (const key of path.slice(0, -1)) {
      if (node[key] === true) return;
      node = node[key] ||= {};
    }
    const last = path[path.length - 1];
    if (leaf === true || node[last] === true) node[last] = true;
    else node[last] = Object.assign(node[last] || {}, leaf);
  };
  const list = () => {
    const tree = {};
    do {
      const path = [name()];
      while (text[i] === '.') { i++; path.push(name()); }
      let leaf = true;
      if (text[i] === '(') {
        i++;
        leaf = list();
        if (text[i] !== ')') throw new Error(`Invalid field mask: ${text}`);
        i++;
      }
      insert(tree, path, leaf);
    } while (text[i] === ',' && ++i);
    return tree;
  };
  const tree = list();
  if (i !== text.length) throw new Error(`Invalid field mask: ${text}`);
  return tree;
}
function projectFields(value, tree) {
  if (tree === true || tree['*'] === true || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => projectFields(item, tree));
  const out = {};
  for (const [key, sub] of Object.entries(tree)) if (value[key] !== undefined) out[key] = projectFields(value[key], sub);
  return out;
}
const maskSelects = (tree, path) => {
  let node = tree;
  for (const key of path) {
    if (node === true || node['*'] === true) return true;
    if (!node[key]) return false;
    node = node[key];
  }
  return true;
};

const lettersOf = (column) => {
  let label = '';
  while (column) { column--; label = String.fromCharCode(65 + column % 26) + label; column = Math.floor(column / 26); }
  return label;
};
const columnOf = (letters) => [...letters.toUpperCase()].reduce((total, char) => total * 26 + char.charCodeAt(0) - 64, 0);
const quoteSheet = (name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !/^[A-Za-z]{1,3}[0-9]+$/.test(name) && !/^R[0-9]*C[0-9]*$/i.test(name)
  ? `${name}!` : `'${name.replace(/'/g, "''")}'!`;

// A1 references inside a formula, outside its string literals: an optional sheet prefix, then a
// cell, a cell range, an open range (A2:A), whole columns (A:C) or whole rows (2:5).
const CELL_REFERENCE = String.raw`\$?[A-Za-z]{1,3}\$?[0-9]+`;
const REFERENCE = new RegExp(String.raw`(?:'((?:[^']|'')+)'!|([A-Za-z_][A-Za-z0-9_.]*)!)?` +
  String.raw`(${CELL_REFERENCE}(?::(?:${CELL_REFERENCE}|\$?[A-Za-z]{1,3}(?![0-9$])|\$?[0-9]+))?|\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3}|\$?[0-9]+:\$?[0-9]+)` +
  String.raw`(?![A-Za-z0-9_.(!])`, 'y');
const endpointOf = (text) => {
  const [, colAbs, letters, rowAbs, digits] = /^(\$?)([A-Za-z]*)(\$?)([0-9]*)$/.exec(text);
  return { col: letters ? columnOf(letters) : null, colAbs: Boolean(colAbs), row: digits ? Number(digits) : null, rowAbs: Boolean(rowAbs) };
};
const endpointText = (point) => (point.col !== null ? (point.colAbs ? '$' : '') + lettersOf(point.col) : '') +
  (point.row !== null ? (point.rowAbs ? '$' : '') + point.row : '');

// Rewrites each reference through map(ref), where ref is { sheet, prefixed, a, b } with 1-based
// endpoints; map returns the new reference, or null for #REF!. A formula moved to another tab
// (newHome) gains a prefix for references it still makes to its old tab.
function rewriteFormula(formula, home, map, newHome = home) {
  let out = '', i = 0;
  while (i < formula.length) {
    const char = formula[i];
    if (char === '"') {
      let j = i + 1;
      while (j < formula.length && !(formula[j] === '"' && formula[j + 1] !== '"')) j += formula[j] === '"' ? 2 : 1;
      out += formula.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (!/[A-Za-z0-9_.$'!:]/.test(formula[i - 1] || ' ')) {
      REFERENCE.lastIndex = i;
      const match = REFERENCE.exec(formula);
      if (match) {
        const [text, quoted, bare, body] = match;
        const sheet = quoted !== undefined ? quoted.replace(/''/g, "'") : bare ?? home;
        const [first, second] = body.split(':');
        const ref = { sheet, prefixed: Boolean(quoted || bare), a: endpointOf(first), b: second === undefined ? null : endpointOf(second) };
        const result = map(ref);
        if (!result) out += '#REF!';
        else if (result === ref && (ref.prefixed || sheet === newHome)) out += text;
        else {
          const prefix = result.sheet === newHome && !ref.prefixed ? ''
            : ref.prefixed && result.sheet === sheet ? text.slice(0, text.length - body.length) : quoteSheet(result.sheet);
          out += prefix + endpointText(result.a) + (result.b ? ':' + endpointText(result.b) : '');
        }
        i = REFERENCE.lastIndex;
        continue;
      }
    }
    out += char;
    i++;
  }
  return out;
}
const withEndpoints = (ref, key, low, high) => ({ ...ref, a: { ...ref.a, [key]: low }, b: ref.b ? { ...ref.b, [key]: high } : null });
// After rows (key 'row') or columns ('col') are inserted or deleted at a 0-based start.
function shiftReference(ref, key, kind, start, count) {
  const low = ref.a[key], high = (ref.b || ref.a)[key];
  if (low === null && high === null) return ref;
  if (kind === 'insert') {
    const move = (value) => value === null || value - 1 < start ? value : value + count;
    return move(low) === low && move(high) === high ? ref : withEndpoints(ref, key, move(low), move(high));
  }
  const end = start + count;
  if (!ref.b) return low - 1 < start ? ref : low - 1 < end ? null : withEndpoints(ref, key, low - count, null);
  const nextLow = low === null || low - 1 < start ? low : low - 1 < end ? start + 1 : low - count;
  const nextHigh = high === null || high - 1 < start ? high : high - 1 < end ? start : high - count;
  if (nextLow !== null && nextHigh !== null && nextHigh < nextLow) return null;
  return nextLow === low && nextHigh === high ? ref : withEndpoints(ref, key, nextLow, nextHigh);
}
// Copying a formula moves its relative parts by the paste offset; a part pushed off the grid is #REF!.
function offsetReference(ref, rows, columns) {
  const move = (point) => ({ ...point,
    row: point.row === null || point.rowAbs ? point.row : point.row + rows,
    col: point.col === null || point.colAbs ? point.col : point.col + columns });
  const next = { ...ref, a: move(ref.a), b: ref.b ? move(ref.b) : null };
  return [next.a, next.b].some((point) => point && ((point.row !== null && point.row < 1) || (point.col !== null && (point.col < 1 || point.col > 18278)))) ? null : next;
}
// A reference as a 0-based, end-exclusive rectangle; null where a side is open (A:A has no rows).
const referenceBox = (ref) => {
  const b = ref.b || ref.a;
  const side = (low, high) => low === null || high === null ? null : [Math.min(low, high) - 1, Math.max(low, high)];
  return { rows: side(ref.a.row, b.row), columns: side(ref.a.col, b.col) };
};

// An A1 range ('Tab'!A1:B9, Tab!A:A, 2:5, a tab name or a named range) as a 0-based,
// end-exclusive area of one tab; null when it does not parse, `outside` when it leaves the grid.
function resolveRange(text, sheets, namedRanges = []) {
  const split = /^(?:'((?:[^']|'')+)'|([^'!]+))!(.+)$/.exec(text);
  let sheet = null, a1 = text;
  if (split) {
    const title = split[1] !== undefined ? split[1].replace(/''/g, "'") : split[2];
    sheet = sheets.find((item) => item.name === title);
    if (!sheet) return null;
    a1 = split[3];
  } else {
    const quoted = /^'((?:[^']|'')+)'$/.exec(text);
    const tab = sheets.find((item) => item.name === (quoted ? quoted[1].replace(/''/g, "'") : text));
    if (tab) return { sheet: tab, startRow: 0, endRow: tab.maxRows, startColumn: 0, endColumn: tab.maxColumns };
    const named = namedRanges.find((item) => item.name.toLowerCase() === text.toLowerCase());
    if (named) {
      const target = sheets.find((item) => item.id === (named.range.sheetId ?? 0));
      return target && { sheet: target, startRow: named.range.startRowIndex ?? 0, endRow: named.range.endRowIndex ?? target.maxRows,
        startColumn: named.range.startColumnIndex ?? 0, endColumn: named.range.endColumnIndex ?? target.maxColumns };
    }
    sheet = sheets[0];
  }
  const match = /^\$?([A-Za-z]{0,3})\$?([0-9]*)(?::\$?([A-Za-z]{0,3})\$?([0-9]*))?$/.exec(a1);
  if (!sheet || !match) return null;
  const [, c1, r1, c2 = c1, r2 = r1] = match;
  // A cell, a cell range, an open range (A2:B), whole columns (A:B) or whole rows (2:5).
  const valid = c1 && c2 ? Boolean(r1) || !r2 : !c1 && !c2 && r1 && r2;
  if (!valid || (r1 === '0' || r2 === '0')) return null;
  const rows = [r1 ? Number(r1) : 1, r2 ? Number(r2) : sheet.maxRows], columns = [c1 ? columnOf(c1) : 1, c2 ? columnOf(c2) : sheet.maxColumns];
  const area = { sheet, startRow: Math.min(...rows) - 1, endRow: Math.max(...rows), startColumn: Math.min(...columns) - 1, endColumn: Math.max(...columns) };
  if (area.endRow > sheet.maxRows || area.endColumn > sheet.maxColumns) area.outside = true;
  return area;
}
// A tab's groups for one dimension: each run of rows or columns at least as deep as each level.
function groupsOf(sheet, dimension) {
  const depths = sheet.groupDepths[dimension], groups = [];
  const deepest = depths.reduce((max, depth) => Math.max(max, depth || 0), 0);
  for (let depth = 1; depth <= deepest; depth++) {
    for (let index = 0; index < depths.length;) {
      if ((depths[index] || 0) < depth) { index++; continue; }
      let end = index;
      while (end < depths.length && (depths[end] || 0) >= depth) end++;
      groups.push({ range: { sheetId: sheet.id, dimension, startIndex: index, endIndex: end }, depth });
      index = end;
    }
  }
  return groups;
}
function sheetProperties(sheet, index) {
  return {
    sheetId: sheet.id, title: sheet.name, index, sheetType: 'GRID',
    gridProperties: { rowCount: sheet.maxRows, columnCount: sheet.maxColumns, frozenRowCount: sheet.frozenRows,
      frozenColumnCount: sheet.frozenColumns || 0, hideGridlines: sheet.hiddenGridlines },
    hidden: sheet.hidden,
    ...(sheet.tabColor && typeof sheet.tabColor === 'object' ? { tabColorStyle: sheet.tabColor } : {}),
  };
}

const MORE_REQUESTS = ['copyPaste', 'cutPaste', 'insertDimension', 'deleteDimension', 'addDimensionGroup', 'deleteDimensionGroup',
  'findReplace', 'deleteDuplicates', 'trimWhitespace', 'textToColumns', 'setDataValidation', 'addNamedRange', 'updateNamedRange',
  'deleteNamedRange', 'duplicateSheet', 'addConditionalFormatRule', 'updateConditionalFormatRule', 'deleteConditionalFormatRule',
  'createDeveloperMetadata', 'deleteDeveloperMetadata'];

const ERROR_TEXT = { ERROR: '#ERROR!', NULL_VALUE: '#NULL!', DIVIDE_BY_ZERO: '#DIV/0!', VALUE: '#VALUE!', REF: '#REF!', NAME: '#NAME?', NUM: '#NUM!', N_A: '#N/A', LOADING: 'Loading...' };

export function createDatamoovSandbox(settings = {}) {
  let now = Date.parse('2026-09-18T12:00:00Z');
  let serial = 0, sheetSerial = 10;
  let activeSpreadsheet = null;
  const user = properties(), script = properties(), document = properties();
  const cacheData = new Map();
  // Like CacheService, a value over 100 KB is refused and nothing of the call is stored.
  const cacheFits = (value) => {
    if (Buffer.byteLength(String(value), 'utf8') > 100 * 1024) throw new Error('Argument too large: value');
  };
  const cache = {
    data: cacheData,
    get: (key) => cacheData.has(key) ? cacheData.get(key) : null,
    put(key, value) { cacheFits(value); cacheData.set(key, String(value)); },
    putAll(values) {
      Object.values(values).forEach(cacheFits);
      for (const [key, value] of Object.entries(values)) cacheData.set(key, String(value));
    },
    getAll(keys) { return Object.fromEntries(keys.filter((key) => cacheData.has(key)).map((key) => [key, cacheData.get(key)])); },
    remove(key) { cacheData.delete(key); },
    removeAll(keys) { for (const key of keys) cacheData.delete(key); },
  };
  const state = {
    user, script, document, cache, books: new Map(), opened: [], batches: [], legacyWrites: [], clears: [],
    flushes: 0, lockAcquires: 0, lockReleases: 0, lockAvailable: true, triggers: [],
    scriptLockAcquires: 0, scriptLockReleases: 0, scriptLockAvailable: true, scriptLockWaits: [],
    createdTriggers: [], deletedTriggers: [], http: [], responses: [], sleeps: [], charts: [], gets: [],
    failBatch: false, failTrigger: false, failProperty: null,
  };
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const address = (row, column) => `${row}:${column}`;
  const columnLabel = (column) => {
    let label = '';
    while (column) { column--; label = String.fromCharCode(65 + column % 26) + label; column = Math.floor(column / 26); }
    return label;
  };
  function cell(sheet, row, column) {
    return sheet.cells.get(address(row, column)) || { value: '', formula: '' };
  }
  function range(sheet, row, column, rows = 1, columns = 1) {
    if (row < 1 || column < 1 || rows < 1 || columns < 1 || row + rows - 1 > sheet.maxRows || column + columns - 1 > sheet.maxColumns) throw new Error('Range exceeds sheet grid');
    const result = {
      getValues: () => Array.from({ length: rows }, (_, r) => Array.from({ length: columns }, (_, c) => cell(sheet, row + r, column + c).value)),
      getFormulas: () => Array.from({ length: rows }, (_, r) => Array.from({ length: columns }, (_, c) => cell(sheet, row + r, column + c).formula)),
      getSheet: () => sheet,
      getNumRows: () => rows,
      getNumColumns: () => columns,
      getCell: (r, c) => range(sheet, row + r - 1, column + c - 1),
      getA1Notation: () => `${columnLabel(column)}${row}`,
      setValues(values) {
        state.legacyWrites.push({ sheetId: sheet.id, row, column, values: plain(values) });
        values.forEach((line, r) => line.forEach((value, c) => sheet.cells.set(address(row + r, column + c),
          { value, formula: typeof value === 'string' && value.startsWith('=') ? value : '' })));
        return result;
      },
      clearContent() {
        state.clears.push({ sheetId: sheet.id, row, column, rows, columns });
        for (let r = 0; r < rows; r++) for (let c = 0; c < columns; c++) sheet.cells.delete(address(row + r, column + c));
        return result;
      },
    };
    for (const method of ['setFontWeight', 'setBackground', 'setFontColor', 'setNumberFormat', 'setWrap', 'setVerticalAlignment', 'setFontSize']) result[method] = () => result;
    return result;
  }
  function makeSheet(name, maxRows = 100, maxColumns = 26, id = ++sheetSerial) {
    const sheet = {
      id, name, maxRows, maxColumns, hidden: false, frozenRows: 0, cells: new Map(),
      columnWidths: new Map(), hiddenGridlines: false, tabColor: null,
      // Advanced Sheets state: userEnteredFormat per cell, merged GridRanges and 0-based pixel sizes.
      formats: new Map(), merges: [], pixelSizes: { ROWS: new Map(), COLUMNS: new Map() },
      // Other cell fields (note, dataValidation, pivotTable, textFormatRuns, chipRuns), the tab's conditional
      // format rules in order, and the group depth of each 0-based row and column.
      meta: new Map(), conditionalFormats: [], groupDepths: { ROWS: [], COLUMNS: [] },
      // Developer metadata located on the tab itself; it goes when the tab is deleted.
      developerMetadata: [],
      getName: () => sheet.name, getSheetId: () => sheet.id,
      isSheetHidden: () => sheet.hidden,
      showSheet() { sheet.hidden = false; return sheet; },
      getLastRow() {
        let lastRow = 0;
        for (const [key, entry] of sheet.cells) {
          if (entry.formula || (entry.value !== '' && entry.value !== null && entry.value !== undefined))
            lastRow = Math.max(lastRow, Number(key.split(':')[0]));
        }
        return lastRow;
      },
      getMaxRows: () => sheet.maxRows, getMaxColumns: () => sheet.maxColumns,
      getRange: (...args) => range(sheet, ...args),
      getDataRange() {
        let lastRow = 0, lastColumn = 0;
        // A pivot table shows its output from its anchor cell on, so the data range takes it in.
        const anchors = [...sheet.meta].filter(([, meta]) => meta?.pivotTable).map(([key]) => key);
        for (const key of [...sheet.cells.keys(), ...anchors]) {
          const [r, c] = key.split(':').map(Number);
          lastRow = Math.max(lastRow, r); lastColumn = Math.max(lastColumn, c);
        }
        return range(sheet, 1, 1, Math.max(1, lastRow), Math.max(1, lastColumn));
      },
      insertRowsAfter(_after, count) { sheet.maxRows += count; },
      insertColumnsAfter(_after, count) { sheet.maxColumns += count; },
      setFrozenRows(count) { sheet.frozenRows = count; return sheet; },
      setColumnWidth(column, width) { sheet.columnWidths.set(column, width); return sheet; },
      setHiddenGridlines(hidden) { sheet.hiddenGridlines = hidden; return sheet; },
      setTabColor(color) { sheet.tabColor = color; return sheet; },
    };
    return sheet;
  }
  // Apps Script materializes one Spreadsheet object per execution. Tabs the Advanced Sheets
  // service creates afterwards stay invisible to it; only opening the spreadsheet again, which
  // returns a separate object, reveals them. Server state lives in `server`; each handle keeps
  // its own `known` set of the tabs it has seen.
  function makeHandle(server) {
    const known = new Set(server.sheets.map((sheet) => sheet.id));
    const visible = () => server.sheets.filter((sheet) => known.has(sheet.id));
    return {
      server,
      get sheets() { return server.sheets; },
      get id() { return server.id; },
      get timezone() { return server.timezone; },
      set timezone(value) { server.timezone = value; },
      get activeRange() { return server.activeRange; },
      set activeRange(value) { server.activeRange = value; },
      get activeSheet() { return server.activeSheet; },
      getId: () => server.id, getSpreadsheetTimeZone: () => server.timezone,
      getSheets: visible,
      // Apps Script finds a tab by name without regard to case, as Sheets keeps tab names unique that way.
      getSheetByName: (name) => visible().find((sheet) => sheet.name.toLowerCase() === String(name).toLowerCase()) || null,
      insertSheet(name) { const sheet = makeSheet(name); server.sheets.push(sheet); known.add(sheet.id); return sheet; },
      getActiveRange: () => server.activeRange,
      getActiveSheet: () => server.activeSheet || visible()[0] || null,
      setActiveSheet(sheet) {
        if (!server.sheets.includes(sheet)) throw new Error('Sheet belongs to another spreadsheet');
        server.activeSheet = sheet;
        server.activeRange = range(sheet, 1, 1);
        return sheet;
      },
    };
  }
  function addSpreadsheet(id = 'spreadsheet-one', names = ['Output']) {
    const server = { id, sheets: names.map((name) => makeSheet(name)), timezone: 'Europe/Athens', activeRange: null, activeSheet: null };
    state.books.set(id, server);
    const handle = makeHandle(server);
    if (!activeSpreadsheet) activeSpreadsheet = handle;
    return handle;
  }
  // Server state, regardless of which tabs a given Spreadsheet handle has seen.
  function findTab(name, book) {
    return (book || activeSpreadsheet).sheets.find((sheet) => sheet.name === name) || null;
  }
  function reopen(book) {
    return makeHandle((book || activeSpreadsheet).server);
  }
  function addTrigger(handler) {
    const trigger = { id: `trigger-${++serial}`, getHandlerFunction: () => handler };
    state.triggers.push(trigger);
    return trigger;
  }
  function applyBatch(body, spreadsheetId) {
    state.batches.push({ body: plain(body), spreadsheetId });
    if (state.failBatch) throw new Error('Simulated atomic batch failure');
    const book = state.books.get(spreadsheetId);
    if (!book) throw new Error('Unknown spreadsheet');
    // Sheet additions, cells, metadata and charts are published together only after every request succeeds.
    const originals = new Map(book.sheets.map((sheet) => [sheet.id, sheet]));
    const staged = new Map(book.sheets.map((sheet) => [sheet.id, { ...sheet, cells: new Map(sheet.cells), formats: new Map(sheet.formats), merges: sheet.merges.slice(),
      pixelSizes: { ROWS: new Map(sheet.pixelSizes.ROWS), COLUMNS: new Map(sheet.pixelSizes.COLUMNS) } }]));
    for (const sheet of staged.values()) {
      sheet.meta = new Map(sheet.meta);
      sheet.conditionalFormats = plain(sheet.conditionalFormats);
      sheet.groupDepths = { ROWS: sheet.groupDepths.ROWS.slice(), COLUMNS: sheet.groupDepths.COLUMNS.slice() };
      sheet.developerMetadata = sheet.developerMetadata.slice();
    }
    let namedRanges = plain(book.namedRanges || []), requestIndex = -1;
    const order = book.sheets.map((sheet) => sheet.id);
    const stagedCharts = [];
    const updatedCharts = new Map(), removedCharts = new Set(), deletedSheets = new Set(), chartEdits = [];
    // Position and border edits reach a chart added earlier in this batch at once, a published one on commit.
    const editChart = (chartId, edit) => {
      const added = stagedCharts.find((chart) => chart.chartId === chartId);
      if (added) edit(added);
      else if (state.charts.some((chart) => chart.spreadsheetId === spreadsheetId && chart.chartId === chartId && !removedCharts.has(chartId))) chartEdits.push([chartId, edit]);
      else throw new Error(`No embedded object with id ${chartId}`);
    };
    // Formats follow the field mask: 'userEnteredFormat' replaces the whole format, a deeper path
    // such as 'userEnteredFormat.backgroundColor' sets or clears that key alone. Copies along the
    // path keep published formats untouched until commit; inputs are plain copies of the request.
    const formatPaths = (fields) => (fields === '*' ? ['userEnteredFormat'] : String(fields || '').split(',').map((field) => field.trim())
      .filter((field) => field === 'userEnteredFormat' || field.startsWith('userEnteredFormat.'))).map((field) => field.split('.'));
    const setPath = (object, [head, ...rest], value) => {
      const copy = { ...object };
      const next = rest.length ? setPath(copy[head], rest, value) : value;
      if (next === undefined) delete copy[head]; else copy[head] = next;
      return Object.keys(copy).length ? copy : undefined;
    };
    const setFormat = (sheet, row, column, paths, input) => {
      const key = address(row + 1, column + 1);
      let format = sheet.formats.get(key);
      for (const path of paths) {
        const value = path.reduce((node, part) => node?.[part], input);
        if (value === undefined && !format) continue;
        format = path.length > 1 ? setPath(format, path.slice(1), value) : value;
      }
      if (format && Object.keys(format).length) sheet.formats.set(key, format);
      else sheet.formats.delete(key);
    };
    const MERGE_ERROR = 'You must select all cells in a merged range to merge or unmerge them.';
    const gridOf = (target) => ({ startRowIndex: target.startRow, endRowIndex: target.endRow, startColumnIndex: target.startColumn, endColumnIndex: target.endColumn });
    const intersects = (a, b) => a.startRowIndex < b.endRowIndex && b.startRowIndex < a.endRowIndex && a.startColumnIndex < b.endColumnIndex && b.startColumnIndex < a.endColumnIndex;
    const contains = (outer, inner) => outer.startRowIndex <= inner.startRowIndex && inner.endRowIndex <= outer.endRowIndex &&
      outer.startColumnIndex <= inner.startColumnIndex && inner.endColumnIndex <= outer.endColumnIndex;
    // Sheets refuses a merge or unmerge range that cuts through an existing merge; merges it covers
    // completely are replaced or removed.
    const releaseMerges = (sheet, grid) => {
      if (sheet.merges.some((merge) => intersects(grid, merge) && !contains(grid, merge))) throw new Error(MERGE_ERROR);
      sheet.merges = sheet.merges.filter((merge) => !intersects(grid, merge));
    };
    const BORDER_STYLES = ['DOTTED', 'DASHED', 'SOLID', 'SOLID_MEDIUM', 'SOLID_THICK', 'NONE', 'DOUBLE'];
    const checkChartSpec = (spec) => {
      const basic = spec?.basicChart;
      if (basic?.chartType === 'BAR' && (basic.series || []).some((series) => series.targetAxis !== 'BOTTOM_AXIS'))
        throw new Error('Bar charts series may only target the BOTTOM_AXIS.');
      if (basic && basic.chartType !== 'BAR' && (basic.series || []).some((series) => series.targetAxis === 'BOTTOM_AXIS'))
        throw new Error('Only bar chart series may target the BOTTOM_AXIS.');
    };
    const replies = [];
    let nextSheetId = sheetSerial;
    const findSheet = (id) => {
      const sheet = staged.get(id);
      if (!sheet) throw new Error(`Unknown sheet ${id}`);
      return sheet;
    };
    const readGrid = (grid) => {
      const sheet = findSheet(grid.sheetId);
      const startRow = grid.startRowIndex ?? 0, startColumn = grid.startColumnIndex ?? 0;
      const endRow = grid.endRowIndex ?? sheet.maxRows, endColumn = grid.endColumnIndex ?? sheet.maxColumns;
      if (![startRow, startColumn, endRow, endColumn].every(Number.isInteger) ||
          startRow < 0 || startColumn < 0 || endRow < startRow || endColumn < startColumn ||
          endRow > sheet.maxRows || endColumn > sheet.maxColumns)
        throw new Error('Batch range exceeds sheet grid');
      return { sheet, cells: sheet.cells, startRow, startColumn, endRow, endColumn };
    };
    const put = (cells, row, column, input) => {
      const entry = input?.userEnteredValue;
      if (!entry || !Object.keys(entry).length) { cells.delete(address(row + 1, column + 1)); return; }
      if (Object.hasOwn(entry, 'formulaValue')) cells.set(address(row + 1, column + 1), { value: entry.formulaValue, formula: entry.formulaValue });
      else cells.set(address(row + 1, column + 1), { value: entry.stringValue ?? entry.numberValue ?? entry.boolValue ?? '', formula: '' });
    };

    // Requests of the analyst sheet tools. A failure names the request the way the API does
    // ("Invalid requests[2].deleteDimension: ...") and, like any other, applies nothing.
    const fail = (message) => {
      throw new Error(`Invalid requests[${requestIndex}].${Object.keys(body.requests[requestIndex] || {})[0]}: ${message}`);
    };
    const sheetFor = (id) => {
      if (!staged.has(id)) fail(`No grid with id: ${id}`);
      return staged.get(id);
    };
    const whole = (sheet) => ({ sheet, cells: sheet.cells, startRow: 0, startColumn: 0, endRow: sheet.maxRows, endColumn: sheet.maxColumns });
    const gridFor = (range, what = 'range') => {
      if (!range || typeof range !== 'object') fail(`A ${what} is required.`);
      sheetFor(range.sheetId ?? 0);
      let target;
      try { target = readGrid({ ...range, sheetId: range.sheetId ?? 0 }); } catch { fail(`The ${what} exceeds the grid limits.`); }
      if (target.endRow <= target.startRow || target.endColumn <= target.startColumn) fail(`The ${what} is empty.`);
      return target;
    };
    const inArea = (area, key) => {
      const [row, column] = key.split(':').map((part) => Number(part) - 1);
      return row >= area.startRow && row < area.endRow && column >= area.startColumn && column < area.endColumn;
    };
    const keyed = (map, key, value) => value === undefined ? map.delete(key) : map.set(key, value);
    const cellAt = (sheet, row, column) => {
      const key = address(row + 1, column + 1);
      return { entry: sheet.cells.get(key), format: sheet.formats.get(key), meta: sheet.meta.get(key) };
    };
    const clearCell = (sheet, row, column) => {
      const key = address(row + 1, column + 1);
      sheet.cells.delete(key); sheet.formats.delete(key); sheet.meta.delete(key);
    };
    const placeCell = (sheet, row, column, data) => {
      const key = address(row + 1, column + 1);
      keyed(sheet.cells, key, data.entry); keyed(sheet.formats, key, data.format); keyed(sheet.meta, key, data.meta);
    };
    // A rewritten formula that lost a reference shows #REF!, as Sheets does.
    const formulaEntry = (entry, formula) => formula === entry.formula ? entry
      : !entry.formula.includes('#REF!') && formula.includes('#REF!') ? { value: '#REF!', formula, error: { type: 'REF', message: 'Reference does not exist.' } }
        : { ...entry, value: entry.value === entry.formula ? formula : entry.value, formula };
    const rewriteCondition = (condition, home, map) => !condition?.values ? condition : { ...condition,
      values: condition.values.map((value) => typeof value.userEnteredValue === 'string' && value.userEnteredValue.startsWith('=')
        ? { ...value, userEnteredValue: rewriteFormula(value.userEnteredValue, home, map) } : value) };
    // Every formula of the spreadsheet: cells, conditional format rules and validation rules.
    const rewriteAll = (map) => {
      for (const sheet of staged.values()) {
        for (const [key, entry] of sheet.cells) if (entry.formula) sheet.cells.set(key, formulaEntry(entry, rewriteFormula(entry.formula, sheet.name, map)));
        sheet.conditionalFormats = sheet.conditionalFormats.map((rule) => !rule.booleanRule ? rule
          : { ...rule, booleanRule: { ...rule.booleanRule, condition: rewriteCondition(rule.booleanRule.condition, sheet.name, map) } });
        for (const [key, meta] of sheet.meta) if (meta.dataValidation?.condition)
          sheet.meta.set(key, { ...meta, dataValidation: { ...meta.dataValidation, condition: rewriteCondition(meta.dataValidation.condition, sheet.name, map) } });
      }
    };
    const checkCellLimit = () => {
      if ([...staged.values()].reduce((total, sheet) => total + sheet.maxRows * sheet.maxColumns, 0) > 10000000)
        fail('This action would increase the number of cells in the workbook above the limit of 10000000 cells.');
    };

    // Condition types: [fewest values, most values, data validation, conditional formatting].
    const CONDITIONS = {
      NUMBER_GREATER: [1, 1, true, true], NUMBER_GREATER_THAN_EQ: [1, 1, true, true], NUMBER_LESS: [1, 1, true, true],
      NUMBER_LESS_THAN_EQ: [1, 1, true, true], NUMBER_EQ: [1, 1, true, true], NUMBER_NOT_EQ: [1, 1, true, true],
      NUMBER_BETWEEN: [2, 2, true, true], NUMBER_NOT_BETWEEN: [2, 2, true, true],
      TEXT_CONTAINS: [1, 1, true, true], TEXT_NOT_CONTAINS: [1, 1, true, true], TEXT_STARTS_WITH: [1, 1, false, true],
      TEXT_ENDS_WITH: [1, 1, false, true], TEXT_EQ: [1, 1, true, true], TEXT_IS_EMAIL: [0, 0, true, false], TEXT_IS_URL: [0, 0, true, false],
      DATE_EQ: [1, 1, true, true], DATE_BEFORE: [1, 1, true, true], DATE_AFTER: [1, 1, true, true], DATE_ON_OR_BEFORE: [1, 1, true, false],
      DATE_ON_OR_AFTER: [1, 1, true, false], DATE_BETWEEN: [2, 2, true, false], DATE_NOT_BETWEEN: [2, 2, true, false], DATE_IS_VALID: [0, 0, true, false],
      ONE_OF_RANGE: [1, 1, true, false], ONE_OF_LIST: [1, Infinity, true, false], BLANK: [0, 0, false, true], NOT_BLANK: [0, 0, false, true],
      CUSTOM_FORMULA: [1, 1, true, true], BOOLEAN: [0, 2, true, false],
    };
    const checkCondition = (condition, use) => {
      const rule = CONDITIONS[condition?.type], validation = use === 'validation';
      if (!rule || !rule[validation ? 2 : 3])
        fail(`Condition type ${condition?.type} is not supported for ${validation ? 'data validation' : 'conditional formatting'}.`);
      const values = condition.values || [];
      if (values.length < rule[0] || values.length > rule[1]) fail(`Condition type ${condition.type} has the wrong number of values.`);
      for (const value of values) {
        const kinds = ['relativeDate', 'userEnteredValue'].filter((key) => value?.[key] !== undefined);
        if (kinds.length !== 1) fail('Each condition value needs exactly one of relativeDate or userEnteredValue.');
        if (value.relativeDate !== undefined) {
          if (validation) fail('Relative dates are not supported in data validation.');
          if (!['DATE_EQ', 'DATE_BEFORE', 'DATE_AFTER'].includes(condition.type) ||
              !['PAST_YEAR', 'PAST_MONTH', 'PAST_WEEK', 'YESTERDAY', 'TODAY', 'TOMORROW'].includes(value.relativeDate))
            fail(`Invalid relative date ${value.relativeDate} for ${condition.type}.`);
        } else if (typeof value.userEnteredValue !== 'string') fail('Condition values are strings.');
        else if (condition.type.startsWith('NUMBER_') && !value.userEnteredValue.startsWith('=') &&
            (!value.userEnteredValue.trim() || !Number.isFinite(Number(value.userEnteredValue))))
          fail(`Invalid number ${value.userEnteredValue} for ${condition.type}.`);
      }
      if (condition.type === 'CUSTOM_FORMULA' && !values[0].userEnteredValue?.startsWith('=')) fail('A custom formula must start with =.');
      if (condition.type === 'ONE_OF_RANGE') {
        const area = resolveRange(values[0].userEnteredValue.replace(/^=/, ''), order.map((id) => staged.get(id)), namedRanges);
        if (!area || area.outside) fail(`Invalid range ${values[0].userEnteredValue} for ONE_OF_RANGE.`);
      }
    };
    const checkColor = (holder, key) => {
      const color = holder[key], style = holder[key + 'Style'];
      if (color !== undefined && ['red', 'green', 'blue', 'alpha'].some((part) => color[part] !== undefined && !(color[part] >= 0 && color[part] <= 1)))
        fail('Color components are numbers from 0 to 1.');
      if (style !== undefined && ['rgbColor', 'themeColor'].filter((part) => style[part] !== undefined).length !== 1)
        fail('A color style needs exactly one of rgbColor or themeColor.');
    };
    const checkRule = (rule) => {
      if (!rule || !Array.isArray(rule.ranges) || !rule.ranges.length) fail('A conditional format rule needs at least one range.');
      const sheets = new Set(rule.ranges.map((range) => gridFor(range).sheet));
      if (sheets.size !== 1) fail('All ranges of a conditional format rule must be on the same sheet.');
      if (['booleanRule', 'gradientRule'].filter((kind) => rule[kind] !== undefined).length !== 1)
        fail('A conditional format rule needs exactly one of booleanRule or gradientRule.');
      if (rule.booleanRule) {
        checkCondition(rule.booleanRule.condition, 'format');
        const format = rule.booleanRule.format || {};
        // Conditional formats can only change bold, italic, strikethrough, underline and colors.
        if (Object.keys(format).some((key) => !['backgroundColor', 'backgroundColorStyle', 'textFormat'].includes(key)) ||
            Object.keys(format.textFormat || {}).some((key) => !['bold', 'italic', 'strikethrough', 'underline', 'foregroundColor', 'foregroundColorStyle'].includes(key)))
          fail('Conditional formatting can only set bold, italic, strikethrough, underline, text color and background color.');
        checkColor(format, 'backgroundColor');
        checkColor(format.textFormat || {}, 'foregroundColor');
      } else {
        const gradient = rule.gradientRule;
        const point = (value, name, types) => {
          if (!value) fail(`A gradient rule needs a ${name}.`);
          if (!types.includes(value.type)) fail(`Invalid ${name} type ${value.type}.`);
          if (value.color === undefined && value.colorStyle === undefined) fail(`The ${name} needs a color.`);
          checkColor(value, 'color');
          if (value.type === 'MIN' || value.type === 'MAX') return;
          if (typeof value.value !== 'string' || !value.value.trim()) fail(`The ${name} needs a value.`);
          if (value.value.startsWith('=')) return;
          const number = Number(value.value);
          if (!Number.isFinite(number) || (value.type !== 'NUMBER' && (number < 0 || number > 100))) fail(`Invalid ${name} value ${value.value}.`);
        };
        point(gradient.minpoint, 'minpoint', ['MIN', 'NUMBER', 'PERCENT', 'PERCENTILE']);
        if (gradient.midpoint !== undefined) point(gradient.midpoint, 'midpoint', ['NUMBER', 'PERCENT', 'PERCENTILE']);
        point(gradient.maxpoint, 'maxpoint', ['MAX', 'NUMBER', 'PERCENT', 'PERCENTILE']);
      }
      return [...sheets][0];
    };
    const PIVOT_FUNCTIONS = ['SUM', 'COUNTA', 'COUNT', 'COUNTUNIQUE', 'AVERAGE', 'MAX', 'MIN', 'MEDIAN', 'PRODUCT', 'STDEV', 'STDEVP', 'VAR', 'VARP', 'CUSTOM'];
    const DATE_TIME_RULES = ['SECOND', 'MINUTE', 'HOUR', 'HOUR_MINUTE', 'HOUR_MINUTE_AMPM', 'DAY_OF_WEEK', 'DAY_OF_YEAR', 'DAY_OF_MONTH',
      'DAY_MONTH', 'MONTH', 'QUARTER', 'YEAR', 'YEAR_MONTH', 'YEAR_QUARTER', 'YEAR_MONTH_DAY'];
    const checkPivot = (pivot) => {
      const source = gridFor(pivot.source, 'pivot source range');
      const width = source.endColumn - source.startColumn;
      // proto3 leaves out a zero offset, so a missing one is the first column.
      const offset = (value, what) => {
        if (!Number.isInteger(value ?? 0) || (value ?? 0) < 0 || (value ?? 0) >= width) fail(`${what} is outside the pivot source range.`);
      };
      for (const group of [...(pivot.rows || []), ...(pivot.columns || [])]) {
        offset(group.sourceColumnOffset, 'A pivot group column');
        if (group.sortOrder !== undefined && !['ASCENDING', 'DESCENDING'].includes(group.sortOrder)) fail(`Invalid sort order ${group.sortOrder}.`);
        const rule = group.groupRule;
        if (rule === undefined) continue;
        if (['dateTimeRule', 'manualRule', 'histogramRule'].filter((kind) => rule[kind] !== undefined).length !== 1)
          fail('A pivot group rule needs exactly one of dateTimeRule, manualRule or histogramRule.');
        if (rule.dateTimeRule && !DATE_TIME_RULES.includes(rule.dateTimeRule.type)) fail(`Invalid date-time rule ${rule.dateTimeRule.type}.`);
        if (rule.histogramRule && !(rule.histogramRule.interval > 0)) fail('A histogram rule needs a positive interval.');
      }
      for (const value of pivot.values || []) {
        if (!PIVOT_FUNCTIONS.includes(value.summarizeFunction)) fail(`Invalid summarize function ${value.summarizeFunction}.`);
        if (value.formula !== undefined) {
          if (value.sourceColumnOffset !== undefined) fail('A pivot value takes a sourceColumnOffset or a formula, not both.');
          if (typeof value.formula !== 'string' || !value.formula.startsWith('=')) fail('A pivot value formula must start with =.');
        } else if (value.summarizeFunction === 'CUSTOM') fail('CUSTOM is only valid with a pivot value formula.');
        else offset(value.sourceColumnOffset, 'A pivot value column');
        if (value.calculatedDisplayType !== undefined &&
            !['PERCENT_OF_ROW_TOTAL', 'PERCENT_OF_COLUMN_TOTAL', 'PERCENT_OF_GRAND_TOTAL'].includes(value.calculatedDisplayType))
          fail(`Invalid calculated display type ${value.calculatedDisplayType}.`);
      }
      for (const spec of pivot.filterSpecs || []) offset(spec.columnOffsetIndex, 'A pivot filter column');
      if (pivot.valueLayout !== undefined && !['HORIZONTAL', 'VERTICAL'].includes(pivot.valueLayout)) fail(`Invalid value layout ${pivot.valueLayout}.`);
    };
    // Cell fields beyond the value and the format follow the field mask like userEnteredFormat does.
    const META_FIELDS = ['note', 'dataValidation', 'pivotTable', 'textFormatRuns', 'chipRuns'];
    const metaFields = (fields) => {
      const list = String(fields || '').split(',').map((field) => field.trim());
      return META_FIELDS.filter((name) => fields === '*' || list.some((field) => field === name || field.startsWith(name + '.')));
    };
    // Smart chips (CellData.chipRuns): written runs each carry a person or a rich link chip on an
    // @ placeholder of the cell's text, and only Drive files can be written as rich link chips.
    const checkChips = (sheet, key, runs) => {
      const text = String(sheet.cells.get(key)?.value ?? '');
      for (const run of runs) {
        const chip = run?.chip || {};
        if (['personProperties', 'richLinkProperties'].filter((kind) => chip[kind] !== undefined).length !== 1)
          fail('A chip run needs a person or a rich link chip.');
        if (text.charAt(run.startIndex ?? 0) !== '@') fail('A chip run must start at an @ placeholder.');
        if (chip.personProperties && typeof chip.personProperties.email !== 'string') fail('A person chip needs an email.');
        if (chip.richLinkProperties && !/^https:\/\/(?:docs|drive)\.google\.com\//.test(String(chip.richLinkProperties.uri)))
          fail('Only Drive files can be written as chips.');
      }
    };
    // Writing a new userEnteredValue erases the cell's chip runs.
    const eraseChips = (sheet, row, column) => {
      const key = address(row + 1, column + 1), meta = sheet.meta.get(key);
      if (!meta?.chipRuns) return;
      const { chipRuns: _, ...rest } = meta;
      keyed(sheet.meta, key, Object.keys(rest).length ? rest : undefined);
    };
    const setMeta = (sheet, row, column, names, input, checked = false) => {
      const key = address(row + 1, column + 1), meta = { ...sheet.meta.get(key) };
      for (const name of names) {
        const value = input?.[name];
        if (value === undefined || value === '' || (Array.isArray(value) && !value.length)) { delete meta[name]; continue; }
        if (!checked && name === 'dataValidation') checkCondition(value.condition, 'validation');
        if (!checked && name === 'pivotTable') checkPivot(value);
        if (!checked && name === 'chipRuns') checkChips(sheet, key, value);
        meta[name] = plain(value);
      }
      keyed(sheet.meta, key, Object.keys(meta).length ? meta : undefined);
    };

    // Inserting or deleting rows or columns moves everything after them: cells, merges, sizes,
    // frozen panes, groups, conditional formats, named ranges, pivot sources, charts and every
    // formula that refers to the tab.
    const GRID_KEYS = { ROWS: ['startRowIndex', 'endRowIndex'], COLUMNS: ['startColumnIndex', 'endColumnIndex'] };
    const adjustGrid = (grid, dimension, kind, start, count) => {
      const [lowKey, highKey] = GRID_KEYS[dimension], end = start + count;
      let low = grid[lowKey], high = grid[highKey];
      if (kind === 'insert') {
        if (low !== undefined && low >= start) low += count;
        if (high !== undefined && high > start) high += count;
      } else {
        if (low !== undefined) low = low < start ? low : low < end ? start : low - count;
        if (high !== undefined) high = high <= start ? high : high <= end ? start : high - count;
        if ((high ?? Infinity) <= (low ?? 0)) return null;
      }
      const next = { ...grid, [lowKey]: low, [highKey]: high };
      if (low === undefined) delete next[lowKey];
      if (high === undefined) delete next[highKey];
      return next;
    };
    const eachChart = (edit) => {
      for (const chart of stagedCharts) edit(chart);
      for (const chart of state.charts) if (chart.spreadsheetId === spreadsheetId && !removedCharts.has(chart.chartId)) chartEdits.push([chart.chartId, edit]);
    };
    const restructure = (sheet, dimension, kind, start, count, inheritFromBefore = false) => {
      const rows = dimension === 'ROWS', end = start + count, id = sheet.id;
      const moveIndex = (index) => kind === 'insert' ? (index >= start ? index + count : index) : index < start ? index : index < end ? null : index - count;
      const move = (map) => {
        const next = new Map();
        for (const [key, value] of map) {
          const [row, column] = key.split(':').map((part) => Number(part) - 1);
          const moved = moveIndex(rows ? row : column);
          if (moved !== null) next.set(rows ? address(moved + 1, column + 1) : address(row + 1, moved + 1), value);
        }
        return next;
      };
      sheet.cells = move(sheet.cells); sheet.formats = move(sheet.formats); sheet.meta = move(sheet.meta);
      const sizes = new Map();
      for (const [index, size] of sheet.pixelSizes[dimension]) if (moveIndex(index) !== null) sizes.set(moveIndex(index), size);
      sheet.pixelSizes[dimension] = sizes;
      sheet.merges = sheet.merges.map((merge) => adjustGrid(merge, dimension, kind, start, count))
        .filter((merge) => merge && (merge.endRowIndex - merge.startRowIndex > 1 || merge.endColumnIndex - merge.startColumnIndex > 1));
      const depths = sheet.groupDepths[dimension];
      if (kind === 'delete') depths.splice(start, count);
      else if (start < depths.length) depths.splice(start, 0, ...Array(count).fill(Math.min(depths[start - 1] || 0, depths[start] || 0)));
      const frozenKey = rows ? 'frozenRows' : 'frozenColumns', frozen = sheet[frozenKey] || 0;
      if (frozen) sheet[frozenKey] = kind === 'insert' ? (start < frozen ? frozen + count : frozen) : frozen - Math.max(0, Math.min(end, frozen) - start);
      if (rows) sheet.maxRows += kind === 'insert' ? count : -count;
      else sheet.maxColumns += kind === 'insert' ? count : -count;
      if (kind === 'insert') {
        // New rows or columns take the format of the one before them, or after them.
        const from = inheritFromBefore ? start - 1 : end;
        for (const [key, format] of [...sheet.formats]) {
          const [row, column] = key.split(':').map((part) => Number(part) - 1);
          if ((rows ? row : column) !== from) continue;
          for (let index = start; index < end; index++) sheet.formats.set(rows ? address(index + 1, column + 1) : address(row + 1, index + 1), format);
        }
      }
      const onSheet = (grid) => (grid?.sheetId ?? 0) === id;
      const adjust = (grid) => onSheet(grid) ? adjustGrid(grid, dimension, kind, start, count) : grid;
      sheet.conditionalFormats = sheet.conditionalFormats.map((rule) => ({ ...rule, ranges: rule.ranges.map(adjust).filter(Boolean) }))
        .filter((rule) => rule.ranges.length);
      namedRanges = namedRanges.flatMap((named) => {
        const range = adjust(named.range);
        return range ? [{ ...named, range }] : [];
      });
      for (const other of staged.values()) for (const [key, meta] of other.meta)
        if (meta.pivotTable && onSheet(meta.pivotTable.source)) other.meta.set(key, { ...meta, pivotTable: { ...meta.pivotTable, source: adjust(meta.pivotTable.source) || meta.pivotTable.source } });
      const walk = (node) => Array.isArray(node) ? node.map(walk)
        : !node || typeof node !== 'object' ? node
          : 'sheetId' in node && Object.keys(node).some((key) => key.endsWith('Index')) ? (onSheet(node) ? adjust(node) || node : node)
            : Object.fromEntries(Object.entries(node).map(([key, value]) => [key, walk(value)]));
      const limit = rows ? sheet.maxRows : sheet.maxColumns;
      eachChart((chart) => {
        const anchor = chart.position?.overlayPosition?.anchorCell, key = rows ? 'rowIndex' : 'columnIndex';
        if (anchor && onSheet(anchor)) {
          const index = moveIndex(anchor[key] || 0);
          anchor[key] = Math.min(index === null ? start : index, limit - 1);
        }
        if (chart.spec) chart.spec = walk(chart.spec);
      });
      rewriteAll((ref) => ref.sheet === sheet.name ? shiftReference(ref, rows ? 'row' : 'col', kind, start, count) : ref);
    };
    const dimensionFor = (range) => {
      if (!range || !['ROWS', 'COLUMNS'].includes(range.dimension)) fail('A dimension range needs dimension ROWS or COLUMNS.');
      const sheet = sheetFor(range.sheetId ?? 0), limit = range.dimension === 'ROWS' ? sheet.maxRows : sheet.maxColumns;
      const start = range.startIndex ?? 0, end = range.endIndex ?? limit;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > limit)
        fail(`The dimension range exceeds the grid limits (${range.dimension === 'ROWS' ? 'rows' : 'columns'}: ${limit}).`);
      return { sheet, dimension: range.dimension, start, end, limit };
    };

    // Pasting one source cell: what each paste type carries over, keeping the rest of the target.
    const PASTE_TYPES = ['PASTE_NORMAL', 'PASTE_VALUES', 'PASTE_FORMAT', 'PASTE_NO_BORDERS', 'PASTE_FORMULA', 'PASTE_DATA_VALIDATION', 'PASTE_CONDITIONAL_FORMATTING'];
    const pasteCell = (sheet, row, column, data, type, formulaFor) => {
      const key = address(row + 1, column + 1), all = type === 'PASTE_NORMAL' || type === 'PASTE_NO_BORDERS';
      if (all || type === 'PASTE_FORMULA')
        keyed(sheet.cells, key, data.entry?.formula ? formulaEntry(data.entry, formulaFor(data.entry.formula)) : data.entry);
      if (type === 'PASTE_VALUES') keyed(sheet.cells, key, data.entry && data.entry.value !== '' ? { value: data.entry.value, formula: '' } : undefined);
      if (type === 'PASTE_VALUES' || type === 'PASTE_FORMULA') eraseChips(sheet, row, column);
      if (all || type === 'PASTE_FORMAT')
        keyed(sheet.formats, key, type === 'PASTE_NO_BORDERS' ? setPath(data.format || {}, ['borders'], sheet.formats.get(key)?.borders) : data.format);
      const meta = { ...sheet.meta.get(key) }, from = data.meta || {};
      const names = all ? META_FIELDS : type === 'PASTE_FORMAT' || type === 'PASTE_DATA_VALIDATION' ? ['dataValidation'] : [];
      for (const name of names) if (from[name] === undefined) delete meta[name]; else meta[name] = from[name];
      keyed(sheet.meta, key, Object.keys(meta).length ? meta : undefined);
    };
    const bounded = (grid, sheet) => ({ startRowIndex: grid.startRowIndex ?? 0, endRowIndex: grid.endRowIndex ?? sheet.maxRows,
      startColumnIndex: grid.startColumnIndex ?? 0, endColumnIndex: grid.endColumnIndex ?? sheet.maxColumns });
    const overlap = (a, b) => {
      const grid = { startRowIndex: Math.max(a.startRowIndex, b.startRowIndex), endRowIndex: Math.min(a.endRowIndex, b.endRowIndex),
        startColumnIndex: Math.max(a.startColumnIndex, b.startColumnIndex), endColumnIndex: Math.min(a.endColumnIndex, b.endColumnIndex) };
      return grid.startRowIndex < grid.endRowIndex && grid.startColumnIndex < grid.endColumnIndex ? grid : null;
    };
    // A source rectangle placed at a tile's corner, optionally transposed.
    const place = (grid, origin, top, left, transpose) => {
      const rows = [grid.startRowIndex - origin.startRowIndex, grid.endRowIndex - origin.startRowIndex];
      const columns = [grid.startColumnIndex - origin.startColumnIndex, grid.endColumnIndex - origin.startColumnIndex];
      const [down, across] = transpose ? [columns, rows] : [rows, columns];
      return { startRowIndex: top + down[0], endRowIndex: top + down[1], startColumnIndex: left + across[0], endColumnIndex: left + across[1] };
    };
    const translate = (ref, rows, columns, sheet) => {
      const move = (point) => ({ ...point, row: point.row === null ? null : point.row + rows, col: point.col === null ? null : point.col + columns });
      return { ...ref, sheet, a: move(ref.a), b: ref.b ? move(ref.b) : null };
    };
    const within = (ref, grid) => {
      const box = referenceBox(ref);
      return box.rows && box.columns && box.rows[0] >= grid.startRowIndex && box.rows[1] <= grid.endRowIndex &&
        box.columns[0] >= grid.startColumnIndex && box.columns[1] <= grid.endColumnIndex;
    };

    const more = (request) => {
      if (request.copyPaste || request.cutPaste) {
        const cut = Boolean(request.cutPaste), spec = request.copyPaste || request.cutPaste;
        const type = spec.pasteType ?? 'PASTE_NORMAL', orientation = cut ? 'NORMAL' : spec.pasteOrientation ?? 'NORMAL';
        if (!PASTE_TYPES.includes(type)) fail(`Invalid paste type ${type}.`);
        if (!['NORMAL', 'TRANSPOSE'].includes(orientation)) fail(`Invalid paste orientation ${orientation}.`);
        const from = gridFor(spec.source, 'source range'), origin = gridOf(from), transpose = orientation === 'TRANSPOSE';
        const height = from.endRow - from.startRow, width = from.endColumn - from.startColumn;
        const [pasteRows, pasteColumns] = transpose ? [width, height] : [height, width];
        let to, tilesDown = 1, tilesAcross = 1;
        if (cut) {
          if (!spec.destination) fail('A destination is required.');
          const sheet = sheetFor(spec.destination.sheetId ?? 0);
          const top = spec.destination.rowIndex ?? 0, left = spec.destination.columnIndex ?? 0;
          if (!Number.isInteger(top) || !Number.isInteger(left) || top < 0 || left < 0) fail('Invalid destination.');
          to = { sheet, startRow: top, startColumn: left };
        } else {
          to = gridFor(spec.destination, 'destination range');
          // A destination that is a whole multiple of the source repeats it; a smaller one still takes all of it.
          const spanRows = to.endRow - to.startRow, spanColumns = to.endColumn - to.startColumn;
          if (spanRows > pasteRows && spanRows % pasteRows === 0) tilesDown = spanRows / pasteRows;
          if (spanColumns > pasteColumns && spanColumns % pasteColumns === 0) tilesAcross = spanColumns / pasteColumns;
        }
        if (to.startRow + pasteRows * tilesDown > to.sheet.maxRows || to.startColumn + pasteColumns * tilesAcross > to.sheet.maxColumns)
          fail('The paste would exceed the grid limits.');
        const cells = [];
        for (let r = from.startRow; r < from.endRow; r++) for (let c = from.startColumn; c < from.endColumn; c++) cells.push({ row: r, column: c, data: cellAt(from.sheet, r, c) });
        const merges = from.sheet.merges.filter((merge) => contains(origin, merge)).map(plain);
        const rules = plain(from.sheet.conditionalFormats);
        const all = type === 'PASTE_NORMAL' || type === 'PASTE_NO_BORDERS';
        let formulaFor;
        if (cut) {
          // Moving cells keeps every reference to them: formulas anywhere follow the moved block,
          // and references to cells the block lands on become #REF!.
          const target = { startRowIndex: to.startRow, endRowIndex: to.startRow + pasteRows, startColumnIndex: to.startColumn, endColumnIndex: to.startColumn + pasteColumns };
          const rows = to.startRow - from.startRow, columns = to.startColumn - from.startColumn;
          const map = (ref) => ref.sheet === from.sheet.name && within(ref, origin) ? translate(ref, rows, columns, to.sheet.name)
            : ref.sheet === to.sheet.name && within(ref, target) ? null : ref;
          releaseMerges(from.sheet, origin);
          for (const { row, column } of cells) clearCell(from.sheet, row, column);
          rewriteAll(map);
          namedRanges = namedRanges.map((named) => (named.range?.sheetId ?? 0) === from.sheet.id && contains(origin, bounded(named.range, from.sheet))
            ? { ...named, range: { sheetId: to.sheet.id, ...place(bounded(named.range, from.sheet), origin, to.startRow, to.startColumn, false) } } : named);
          formulaFor = () => (formula) => rewriteFormula(formula, from.sheet.name, map, to.sheet.name);
        } else {
          // A copied formula moves its relative references by the paste offset; references without
          // a tab name now mean the destination tab.
          formulaFor = (rows, columns) => (formula) => rewriteFormula(formula, from.sheet.name, (ref) => {
            const moved = offsetReference(ref, rows, columns);
            return moved && !ref.prefixed ? { ...moved, sheet: to.sheet.name } : moved;
          }, to.sheet.name);
        }
        for (let down = 0; down < tilesDown; down++) for (let across = 0; across < tilesAcross; across++) {
          const top = to.startRow + down * pasteRows, left = to.startColumn + across * pasteColumns;
          if (all) releaseMerges(to.sheet, { startRowIndex: top, endRowIndex: top + pasteRows, startColumnIndex: left, endColumnIndex: left + pasteColumns });
          for (const { row, column, data } of cells) {
            const [r, c] = transpose ? [top + column - from.startColumn, left + row - from.startRow] : [top + row - from.startRow, left + column - from.startColumn];
            pasteCell(to.sheet, r, c, data, type, formulaFor(r - row, c - column));
          }
          if (all) for (const merge of merges) to.sheet.merges.push(place(merge, origin, top, left, transpose));
          if (!cut && (all || type === 'PASTE_FORMAT' || type === 'PASTE_CONDITIONAL_FORMATTING'))
            for (const rule of rules) {
              const ranges = rule.ranges.map((range) => (range.sheetId ?? 0) === from.sheet.id ? overlap(bounded(range, from.sheet), origin) : null)
                .filter(Boolean).map((part) => ({ sheetId: to.sheet.id, ...place(part, origin, top, left, transpose) }));
              if (ranges.length) to.sheet.conditionalFormats.push({ ...rule, ranges });
            }
        }
        return {};
      }
      if (request.insertDimension) {
        const { range, inheritFromBefore } = request.insertDimension;
        if (!range || !['ROWS', 'COLUMNS'].includes(range.dimension)) fail('A dimension range needs dimension ROWS or COLUMNS.');
        const sheet = sheetFor(range.sheetId ?? 0), limit = range.dimension === 'ROWS' ? sheet.maxRows : sheet.maxColumns;
        const start = range.startIndex ?? 0, end = range.endIndex ?? 0;
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || start > limit)
          fail(`Invalid dimension range to insert (${range.dimension === 'ROWS' ? 'rows' : 'columns'}: ${limit}).`);
        if (inheritFromBefore && start === 0) fail('Cannot inherit properties from before the first row or column.');
        // Appending has nothing after it to inherit from.
        if (!inheritFromBefore && start === limit) fail(`range.startIndex must be less than the grid size (${limit}) if inheritFromBefore is false.`);
        restructure(sheet, range.dimension, 'insert', start, end - start, Boolean(inheritFromBefore));
        if (sheet.maxColumns > 18278) fail('A sheet can have at most 18278 columns.');
        checkCellLimit();
        return {};
      }
      if (request.deleteDimension) {
        const { sheet, dimension, start, end, limit } = dimensionFor(request.deleteDimension.range);
        const noun = dimension === 'ROWS' ? 'rows' : 'columns', frozen = (dimension === 'ROWS' ? sheet.frozenRows : sheet.frozenColumns) || 0;
        if (end - start === limit) fail(`You can't delete all the ${noun} on the sheet.`);
        if (frozen && limit - (end - start) <= frozen - Math.max(0, Math.min(end, frozen) - start)) fail(`You can't delete all non-frozen ${noun}.`);
        restructure(sheet, dimension, 'delete', start, end - start);
        return {};
      }
      if (request.addDimensionGroup || request.deleteDimensionGroup) {
        // Groups are depths per row or column, as the API describes: adding a group over a range
        // deepens it by one, deleting one makes it one shallower.
        const kind = request.addDimensionGroup ? 'addDimensionGroup' : 'deleteDimensionGroup';
        const { sheet, dimension, start, end } = dimensionFor(request[kind].range);
        const depths = sheet.groupDepths[dimension];
        if (kind === 'deleteDimensionGroup' && !depths.slice(start, end).some(Boolean)) fail('No group exists over the specified range.');
        for (let index = start; index < end; index++) depths[index] = Math.max(0, (depths[index] || 0) + (kind === 'addDimensionGroup' ? 1 : -1));
        if (depths.some((depth) => depth > 8)) fail('Groups can be nested at most 8 levels deep.');
        return { [kind]: apiJson({ dimensionGroups: groupsOf(sheet, dimension) }) };
      }
      if (request.findReplace) {
        const spec = request.findReplace;
        if (typeof spec.find !== 'string' || !spec.find) fail('The find string must not be empty.');
        const scopes = ['range', 'sheetId', 'allSheets'].filter((key) => spec[key] !== undefined);
        if (scopes.length !== 1 || spec.allSheets === false) fail('Set exactly one of range, sheetId or allSheets.');
        const areas = spec.range ? [gridFor(spec.range)] : spec.sheetId !== undefined ? [whole(sheetFor(spec.sheetId))] : order.map((id) => whole(staged.get(id)));
        const source = spec.searchByRegex ? spec.find : spec.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        let pattern;
        try { pattern = new RegExp(spec.matchEntireCell ? `^(?:${source})$` : source, spec.matchCase ? 'g' : 'gi'); } catch { fail(`Invalid regular expression: ${spec.find}`); }
        const replacement = spec.replacement ?? '';
        const totals = { valuesChanged: 0, formulasChanged: 0, rowsChanged: 0, sheetsChanged: 0, occurrencesChanged: 0 };
        for (const area of areas) {
          const rows = new Set();
          for (const [key, entry] of [...area.sheet.cells]) {
            if (!inArea(area, key) || (entry.formula && !spec.includeFormulas) || (entry.error && !entry.formula)) continue;
            const value = entry.value;
            const text = entry.formula || (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : null);
            if (text === null) continue;
            const count = (text.match(pattern) || []).length;
            if (!count) continue;
            const next = spec.searchByRegex ? text.replace(pattern, replacement) : text.replace(pattern, () => replacement);
            totals.occurrencesChanged += count;
            totals[entry.formula ? 'formulasChanged' : 'valuesChanged']++;
            rows.add(key.split(':')[0]);
            // The result is entered again: a formula stays a formula, a number or boolean stays one when it still reads as one.
            const typed = entry.formula && next.startsWith('=') ? { value: next, formula: next }
              : typeof value === 'number' && next.trim() !== '' && Number.isFinite(Number(next)) ? { value: Number(next), formula: '' }
                : typeof value === 'boolean' && /^(true|false)$/i.test(next) ? { value: /^true$/i.test(next), formula: '' }
                  : next === '' ? undefined : { value: next, formula: '' };
            keyed(area.sheet.cells, key, typed);
          }
          totals.rowsChanged += rows.size;
          if (rows.size) totals.sheetsChanged++;
        }
        return { findReplace: apiJson(totals) };
      }
      if (request.deleteDuplicates) {
        const { range, comparisonColumns = [] } = request.deleteDuplicates;
        const area = gridFor(range), columns = new Set();
        for (const dimension of comparisonColumns) {
          if (dimension?.dimension !== 'COLUMNS' || (dimension.sheetId ?? 0) !== area.sheet.id) fail('Comparison columns must be columns of the range\'s sheet.');
          const start = dimension.startIndex ?? 0, end = dimension.endIndex ?? area.sheet.maxColumns;
          if (!Number.isInteger(start) || !Number.isInteger(end) || start < area.startColumn || end > area.endColumn || end <= start)
            fail('Comparison columns must be within the range.');
          for (let column = start; column < end; column++) columns.add(column);
        }
        const compare = columns.size ? [...columns].sort((a, b) => a - b) : Array.from({ length: area.endColumn - area.startColumn }, (_, i) => area.startColumn + i);
        const keyOf = (row) => JSON.stringify(compare.map((column) => {
          const value = cell(area.sheet, row + 1, column + 1).value;
          return Object.prototype.toString.call(value) === '[object Date]' ? ['date', value.getTime()] : [typeof value, value];
        }));
        // The first row of each key stays; later ones are removed and the rows below move up inside the range.
        const seen = new Set(), kept = [];
        for (let row = area.startRow; row < area.endRow; row++) {
          const key = keyOf(row);
          if (!seen.has(key)) { seen.add(key); kept.push(row); }
        }
        const removed = area.endRow - area.startRow - kept.length;
        if (removed) {
          const rows = kept.map((row) => Array.from({ length: area.endColumn - area.startColumn }, (_, i) => cellAt(area.sheet, row, area.startColumn + i)));
          for (let row = area.startRow; row < area.endRow; row++) for (let column = area.startColumn; column < area.endColumn; column++) clearCell(area.sheet, row, column);
          rows.forEach((line, offset) => line.forEach((data, i) => placeCell(area.sheet, area.startRow + offset, area.startColumn + i, data)));
        }
        return { deleteDuplicates: apiJson({ duplicatesRemovedCount: removed }) };
      }
      if (request.trimWhitespace) {
        const area = gridFor(request.trimWhitespace.range);
        let changed = 0;
        for (const [key, entry] of [...area.sheet.cells]) {
          if (!inArea(area, key) || entry.formula || typeof entry.value !== 'string') continue;
          const next = entry.value.replace(/^\s+|\s+$/g, '').replace(/\s+/g, ' ');
          if (next === entry.value) continue;
          changed++;
          keyed(area.sheet.cells, key, next ? { value: next, formula: '' } : undefined);
        }
        return { trimWhitespace: apiJson({ cellsChangedCount: changed }) };
      }
      if (request.textToColumns) {
        const { source, delimiter, delimiterType } = request.textToColumns;
        const area = gridFor(source, 'source range');
        if (area.endColumn - area.startColumn !== 1) fail('The source range must span exactly one column.');
        const DELIMITERS = { COMMA: ',', SEMICOLON: ';', PERIOD: '.', SPACE: ' ' };
        const texts = [];
        for (let row = area.startRow; row < area.endRow; row++) {
          const entry = area.cells.get(address(row + 1, area.startColumn + 1));
          if (entry && !entry.formula && typeof entry.value === 'string') texts.push([row, entry.value]);
        }
        let split = DELIMITERS[delimiterType];
        if (delimiterType === 'CUSTOM') {
          if (typeof delimiter !== 'string' || !delimiter) fail('A custom delimiter must not be empty.');
          split = delimiter;
        } else if (delimiterType === 'AUTODETECT') {
          const counts = [',', ';', '|', '\t', ' '].map((candidate) => [candidate, texts.filter(([, text]) => text.includes(candidate)).length]);
          split = counts.reduce((best, item) => item[1] > best[1] ? item : best, [null, 0])[0];
        } else if (!split) fail(`Invalid delimiter type ${delimiterType}.`);
        if (split) for (const [row, text] of texts) {
          if (!text.includes(split)) continue;
          const parts = text.split(split);
          if (area.startColumn + parts.length > area.sheet.maxColumns) fail('The split values would exceed the grid limits.');
          parts.forEach((part, i) => keyed(area.cells, address(row + 1, area.startColumn + i + 1),
            part === '' ? undefined : { value: /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(part) ? Number(part) : part, formula: '' }));
        }
        return {};
      }
      if (request.setDataValidation) {
        const { range, rule, filteredRowsIncluded } = request.setDataValidation;
        const area = gridFor(range);
        if (rule !== undefined) checkCondition(rule?.condition, 'validation');
        if (filteredRowsIncluded !== undefined && typeof filteredRowsIncluded !== 'boolean') fail('filteredRowsIncluded must be a boolean.');
        // Like Sheets, rows a filter hides (sheet.filteredRows, 0-based) are left out unless filteredRowsIncluded is true.
        for (let row = area.startRow; row < area.endRow; row++) {
          if (!filteredRowsIncluded && area.sheet.filteredRows?.has(row)) continue;
          for (let column = area.startColumn; column < area.endColumn; column++)
            setMeta(area.sheet, row, column, ['dataValidation'], { dataValidation: rule }, true);
        }
        return {};
      }
      if (request.addNamedRange || request.updateNamedRange) {
        const adding = Boolean(request.addNamedRange), input = (request.addNamedRange || request.updateNamedRange).namedRange;
        if (!input || typeof input !== 'object') fail('A named range is required.');
        let named;
        if (adding) {
          const id = input.namedRangeId ?? String(1000000000 + (state.namedRangeSerial = (state.namedRangeSerial || 0) + 1));
          if (typeof id !== 'string' || !id || namedRanges.some((item) => item.namedRangeId === id)) fail(`Invalid or duplicate named range ID ${id}.`);
          named = { namedRangeId: id, name: input.name, range: input.range };
        } else {
          const current = namedRanges.find((item) => item.namedRangeId === input.namedRangeId);
          if (!current) fail(`No named range with id ${input.namedRangeId}.`);
          const fields = request.updateNamedRange.fields;
          if (!fields) fail('fields is required.');
          const list = String(fields).split(',').map((field) => field.trim());
          named = { ...current };
          for (const key of ['name', 'range']) if (fields === '*' || list.includes(key)) named[key] = input[key];
        }
        if (typeof named.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,249}$/.test(named.name) || /^[A-Za-z]{1,3}[0-9]+$/.test(named.name) ||
            /^R[0-9]*C[0-9]*$/i.test(named.name) || /^(true|false)$/i.test(named.name))
          fail(`Invalid named range name: ${named.name}`);
        if (namedRanges.some((item) => item.namedRangeId !== named.namedRangeId && item.name.toLowerCase() === named.name.toLowerCase()))
          fail(`A named range with the name ${named.name} already exists.`);
        gridFor(named.range);
        named = plain(named);
        namedRanges = adding ? [...namedRanges, named] : namedRanges.map((item) => item.namedRangeId === named.namedRangeId ? named : item);
        return adding ? { addNamedRange: { namedRange: apiJson(named) } } : {};
      }
      if (request.deleteNamedRange) {
        const id = request.deleteNamedRange.namedRangeId;
        if (!namedRanges.some((item) => item.namedRangeId === id)) fail(`No named range with id ${id}.`);
        namedRanges = namedRanges.filter((item) => item.namedRangeId !== id);
        return {};
      }
      // Developer metadata located on a tab (the subset the app uses): the key and a visibility are
      // required, the API assigns a positive id unless one is given, and each tab holds at most
      // 30,000 characters of keys and values. A delete takes a lookup and removes every entry it
      // matches; the API does not document a lookup that matches nothing, so neither does this.
      if (request.createDeveloperMetadata) {
        const input = request.createDeveloperMetadata.developerMetadata || {};
        if (typeof input.metadataKey !== 'string' || !input.metadataKey) fail('metadataKey is required.');
        if (!['DOCUMENT', 'PROJECT'].includes(input.visibility)) fail(`Invalid visibility ${input.visibility}.`);
        const location = input.location || {};
        if (Object.keys(location).join() !== 'sheetId') fail('This sandbox locates developer metadata on a sheet only.');
        const sheet = sheetFor(location.sheetId), all = [...staged.values()].flatMap((item) => item.developerMetadata);
        const id = input.metadataId ?? (state.metadataSerial = Math.max(state.metadataSerial || 0, ...all.map((item) => item.metadataId)) + 1);
        if (!Number.isInteger(id) || id < 1 || all.some((item) => item.metadataId === id)) fail(`Invalid or duplicate metadata ID ${id}.`);
        const entry = { metadataId: id, metadataKey: input.metadataKey, metadataValue: input.metadataValue ?? '',
          location: { locationType: 'SHEET', sheetId: sheet.id }, visibility: input.visibility };
        const size = [...sheet.developerMetadata, entry].reduce((sum, item) => sum + item.metadataKey.length + item.metadataValue.length, 0);
        if (size > 30000) fail('The developer metadata of a sheet may hold at most 30,000 characters.');
        sheet.developerMetadata.push(entry);
        return { createDeveloperMetadata: { developerMetadata: apiJson(entry) } };
      }
      if (request.deleteDeveloperMetadata) {
        const lookup = request.deleteDeveloperMetadata.dataFilter?.developerMetadataLookup;
        if (!lookup || !Object.keys(lookup).length) fail('A developerMetadataLookup data filter is required.');
        const matches = (item) => (lookup.metadataId === undefined || item.metadataId === lookup.metadataId) &&
          (lookup.metadataKey === undefined || item.metadataKey === lookup.metadataKey) &&
          (lookup.metadataValue === undefined || item.metadataValue === lookup.metadataValue);
        const deleted = [];
        for (const sheet of staged.values()) {
          deleted.push(...sheet.developerMetadata.filter(matches));
          sheet.developerMetadata = sheet.developerMetadata.filter((item) => !matches(item));
        }
        return { deleteDeveloperMetadata: apiJson({ deletedDeveloperMetadata: deleted }) };
      }
      if (request.duplicateSheet) {
        const spec = request.duplicateSheet, source = sheetFor(spec.sourceSheetId ?? 0);
        const id = spec.newSheetId ?? nextSheetId + 1, index = spec.insertSheetIndex ?? 0;
        if (!Number.isInteger(id) || id < 0 || staged.has(id)) fail(`Invalid or duplicate sheet ID ${id}.`);
        const taken = (name) => [...staged.values()].some((sheet) => sheet.name === name);
        let title = spec.newSheetName;
        if (title === undefined) {
          title = `Copy of ${source.name}`;
          for (let n = 2; taken(title); n++) title = `Copy of ${source.name} ${n}`;
        }
        if (typeof title !== 'string' || !title || taken(title)) fail(`A sheet with the name "${title}" already exists. Please enter another name.`);
        if (!Number.isInteger(index) || index < 0 || index > order.length) fail(`Invalid sheet index ${index}.`);
        // The copy keeps cells, formats, cell fields, merges, sizes, groups and rules; references to
        // the source tab inside its rules, pivots and charts now point at the copy.
        const toCopy = (value) => JSON.parse(JSON.stringify(value), (key, item) => key === 'sheetId' && item === source.id ? id : item);
        const copy = makeSheet(title, source.maxRows, source.maxColumns, id);
        Object.assign(copy, {
          hidden: source.hidden, frozenRows: source.frozenRows, hiddenGridlines: source.hiddenGridlines, tabColor: plain(source.tabColor),
          cells: new Map(source.cells), formats: new Map(source.formats), merges: plain(source.merges), columnWidths: new Map(source.columnWidths),
          meta: new Map([...source.meta].map(([key, meta]) => [key, toCopy(meta)])), conditionalFormats: toCopy(source.conditionalFormats),
          pixelSizes: { ROWS: new Map(source.pixelSizes.ROWS), COLUMNS: new Map(source.pixelSizes.COLUMNS) },
          groupDepths: { ROWS: source.groupDepths.ROWS.slice(), COLUMNS: source.groupDepths.COLUMNS.slice() },
        });
        if (source.frozenColumns !== undefined) copy.frozenColumns = source.frozenColumns;
        staged.set(id, copy);
        order.splice(index, 0, id);
        nextSheetId = Math.max(nextSheetId, id);
        const live = [...state.charts.filter((chart) => chart.spreadsheetId === spreadsheetId && !removedCharts.has(chart.chartId)), ...stagedCharts];
        for (const chart of live.filter((item) => (item.position?.overlayPosition?.anchorCell?.sheetId ?? 0) === source.id)) {
          const chartId = Math.max(state.chartSerial || 0, ...state.charts.map((item) => item.chartId), ...stagedCharts.map((item) => item.chartId), 0) + 1;
          stagedCharts.push({ ...toCopy(chart), chartId });
        }
        checkCellLimit();
        return { duplicateSheet: { properties: apiJson(sheetProperties(copy, order.indexOf(id))) } };
      }
      if (request.addConditionalFormatRule) {
        const { rule, index = 0 } = request.addConditionalFormatRule;
        const sheet = checkRule(rule);
        if (!Number.isInteger(index) || index < 0 || index > sheet.conditionalFormats.length) fail(`Invalid conditional format index ${index}.`);
        sheet.conditionalFormats.splice(index, 0, plain(rule));
        return {};
      }
      if (request.updateConditionalFormatRule) {
        const { index = 0, sheetId = 0, rule, newIndex } = request.updateConditionalFormatRule;
        if ((rule === undefined) === (newIndex === undefined)) fail('Set exactly one of rule or newIndex.');
        // A replacement rule names its sheet through its ranges; a move names it with sheetId.
        const sheet = rule !== undefined ? checkRule(rule) : sheetFor(sheetId), rules = sheet.conditionalFormats;
        if (!Number.isInteger(index) || index < 0 || index >= rules.length) fail(`No conditional format on sheet ${sheet.id} at index ${index}.`);
        if (rule !== undefined) {
          const oldRule = rules[index];
          rules[index] = plain(rule);
          return { updateConditionalFormatRule: apiJson({ newRule: rules[index], oldRule, newIndex: index }) };
        }
        if (!Number.isInteger(newIndex) || newIndex < 0 || newIndex >= rules.length) fail(`Invalid new index ${newIndex}.`);
        const [moved] = rules.splice(index, 1);
        rules.splice(newIndex, 0, moved);
        return { updateConditionalFormatRule: apiJson({ newRule: moved, oldIndex: index, newIndex }) };
      }
      if (request.deleteConditionalFormatRule) {
        const { index = 0, sheetId = 0 } = request.deleteConditionalFormatRule;
        const rules = sheetFor(sheetId).conditionalFormats;
        if (!Number.isInteger(index) || index < 0 || index >= rules.length) fail(`No conditional format on sheet ${sheetId} at index ${index}.`);
        const [rule] = rules.splice(index, 1);
        return { deleteConditionalFormatRule: apiJson({ rule }) };
      }
    };
    for (const request of body.requests || []) {
      let reply = {};
      requestIndex++;
      if (request.addSheet) {
        const props = request.addSheet.properties || {};
        const id = props.sheetId ?? ++nextSheetId;
        const rows = props.gridProperties?.rowCount ?? 1000;
        const columns = props.gridProperties?.columnCount ?? 26;
        const frozenRows = props.gridProperties?.frozenRowCount ?? 0;
        if (!Number.isInteger(id) || id < 0 || staged.has(id)) throw new Error('Invalid or duplicate sheet ID');
        if (props.title === undefined) props.title = 'Sheet' + id;
        if (typeof props.title !== 'string' || !props.title || [...staged.values()].some((sheet) => sheet.name === props.title))
          throw new Error('Invalid or duplicate sheet title');
        if (!Number.isInteger(rows) || rows < 1 || !Number.isInteger(columns) || columns < 1 ||
            !Number.isInteger(frozenRows) || frozenRows < 0 || frozenRows > rows)
          throw new Error('Invalid sheet grid properties');
        const sheet = makeSheet(props.title, rows, columns, id);
        sheet.hidden = Boolean(props.hidden);
        sheet.frozenRows = frozenRows;
        staged.set(id, sheet);
        order.push(id);
        nextSheetId = Math.max(nextSheetId, id);
        reply = { addSheet: { properties: { ...plain(props), sheetId: id } } };
      } else if (request.updateCells) {
        const update = request.updateCells;
        const grid = update.range || { sheetId: update.start.sheetId, startRowIndex: update.start.rowIndex || 0, startColumnIndex: update.start.columnIndex || 0,
          endRowIndex: (update.start.rowIndex || 0) + (update.rows || []).length,
          endColumnIndex: (update.start.columnIndex || 0) + Math.max(0, ...(update.rows || []).map((row) => (row.values || []).length)) };
        const target = readGrid(grid);
        if (String(update.fields).includes('userEnteredValue') || update.fields === '*') {
          for (let r = target.startRow; r < target.endRow; r++) for (let c = target.startColumn; c < target.endColumn; c++) {
            put(target.cells, r, c, update.rows?.[r - target.startRow]?.values?.[c - target.startColumn]);
            eraseChips(target.sheet, r, c);
          }
        }
        const paths = formatPaths(update.fields), rows = paths.length ? plain(update.rows || []) : [];
        if (paths.length)
          for (let r = target.startRow; r < target.endRow; r++) for (let c = target.startColumn; c < target.endColumn; c++)
            setFormat(target.sheet, r, c, paths, rows[r - target.startRow]?.values?.[c - target.startColumn]);
        const names = metaFields(update.fields);
        if (names.length)
          for (let r = target.startRow; r < target.endRow; r++) for (let c = target.startColumn; c < target.endColumn; c++)
            setMeta(target.sheet, r, c, names, update.rows?.[r - target.startRow]?.values?.[c - target.startColumn]);
      } else if (request.repeatCell) {
        const repeat = request.repeatCell;
        const target = readGrid(repeat.range);
        if (String(repeat.fields).includes('userEnteredValue') || repeat.fields === '*')
          for (let r = target.startRow; r < target.endRow; r++) for (let c = target.startColumn; c < target.endColumn; c++) { put(target.cells, r, c, repeat.cell); eraseChips(target.sheet, r, c); }
        const paths = formatPaths(repeat.fields), input = plain(repeat.cell || {});
        if (paths.length)
          for (let r = target.startRow; r < target.endRow; r++) for (let c = target.startColumn; c < target.endColumn; c++) setFormat(target.sheet, r, c, paths, input);
        const names = metaFields(repeat.fields);
        if (names.length)
          for (let r = target.startRow; r < target.endRow; r++) for (let c = target.startColumn; c < target.endColumn; c++) setMeta(target.sheet, r, c, names, repeat.cell);
      } else if (request.mergeCells) {
        const { mergeType } = request.mergeCells, target = readGrid(request.mergeCells.range), grid = gridOf(target);
        if (!['MERGE_ALL', 'MERGE_ROWS', 'MERGE_COLUMNS'].includes(mergeType)) throw new Error(`Invalid merge type ${mergeType}`);
        const pieces = mergeType === 'MERGE_ROWS'
          ? Array.from({ length: grid.endRowIndex - grid.startRowIndex }, (_, r) => ({ ...grid, startRowIndex: grid.startRowIndex + r, endRowIndex: grid.startRowIndex + r + 1 }))
          : mergeType === 'MERGE_COLUMNS'
            ? Array.from({ length: grid.endColumnIndex - grid.startColumnIndex }, (_, c) => ({ ...grid, startColumnIndex: grid.startColumnIndex + c, endColumnIndex: grid.startColumnIndex + c + 1 }))
            : [grid];
        for (const piece of pieces) {
          if (piece.endRowIndex - piece.startRowIndex < 2 && piece.endColumnIndex - piece.startColumnIndex < 2) continue;
          if (piece.startRowIndex < target.sheet.frozenRows && piece.endRowIndex > target.sheet.frozenRows)
            throw new Error("You can't merge frozen and non-frozen rows.");
          releaseMerges(target.sheet, piece);
          target.sheet.merges.push(piece);
          // Only the top-left value of a merge survives.
          for (let r = piece.startRowIndex; r < piece.endRowIndex; r++) for (let c = piece.startColumnIndex; c < piece.endColumnIndex; c++)
            if (r !== piece.startRowIndex || c !== piece.startColumnIndex) target.cells.delete(address(r + 1, c + 1));
        }
      } else if (request.unmergeCells) {
        const target = readGrid(request.unmergeCells.range);
        releaseMerges(target.sheet, gridOf(target));
      } else if (request.updateBorders) {
        const borders = request.updateBorders, target = readGrid(borders.range);
        const sides = ['top', 'bottom', 'left', 'right', 'innerHorizontal', 'innerVertical'].filter((side) => borders[side] !== undefined);
        for (const side of sides) if (!BORDER_STYLES.includes(borders[side].style)) throw new Error(`Invalid border style ${borders[side].style}`);
        const border = (side) => borders[side].style === 'NONE' ? undefined : plain(borders[side]);
        // Each cell keeps the sides it shows: outer edges from top/bottom/left/right, the rest from the inner borders.
        for (let r = target.startRow; r < target.endRow; r++) for (let c = target.startColumn; c < target.endColumn; c++) {
          const edges = {
            top: r === target.startRow ? 'top' : 'innerHorizontal', bottom: r === target.endRow - 1 ? 'bottom' : 'innerHorizontal',
            left: c === target.startColumn ? 'left' : 'innerVertical', right: c === target.endColumn - 1 ? 'right' : 'innerVertical',
          };
          for (const [edge, side] of Object.entries(edges)) if (sides.includes(side))
            setFormat(target.sheet, r, c, [['userEnteredFormat', 'borders', edge]], { userEnteredFormat: { borders: { [edge]: border(side) } } });
        }
      } else if (request.updateEmbeddedObjectPosition) {
        const { objectId, newPosition, fields } = request.updateEmbeddedObjectPosition;
        const overlay = newPosition?.overlayPosition;
        if (!overlay) throw new Error('Only overlay positions are supported');
        if (!fields) throw new Error('updateEmbeddedObjectPosition needs fields');
        if (overlay.anchorCell) findSheet(overlay.anchorCell.sheetId);
        const keys = fields === '*' ? null : String(fields).split(',').map((field) => field.trim());
        editChart(objectId, (chart) => {
          const position = keys ? { ...chart.position.overlayPosition } : {};
          for (const key of keys || Object.keys(overlay)) if (overlay[key] === undefined) delete position[key]; else position[key] = plain(overlay[key]);
          chart.position = { overlayPosition: position };
        });
      } else if (request.updateEmbeddedObjectBorder) {
        const { objectId, border, fields } = request.updateEmbeddedObjectBorder;
        if (!border || !fields) throw new Error('updateEmbeddedObjectBorder needs a border and fields');
        editChart(objectId, (chart) => { chart.border = plain(border); });
      } else if (request.appendDimension) {
        const append = request.appendDimension, sheet = findSheet(append.sheetId);
        if (!Number.isInteger(append.length) || append.length < 1) throw new Error('Invalid appended dimension length');
        if (append.dimension === 'ROWS') sheet.maxRows += append.length;
        else if (append.dimension === 'COLUMNS') sheet.maxColumns += append.length;
        else throw new Error('Invalid appended dimension');
      } else if (request.updateSheetProperties) {
        const props = request.updateSheetProperties.properties, sheet = findSheet(props.sheetId);
        if (props.title !== undefined) {
          const from = sheet.name;
          if (typeof props.title !== 'string' || !props.title ||
              [...staged.values()].some((other) => other.id !== sheet.id && other.name.toLowerCase() === props.title.toLowerCase()))
            throw new Error(`A sheet with the name "${props.title}" already exists. Please enter another name.`);
          // Renaming a tab updates the formulas, rules and validation that name it, as Sheets does.
          sheet.name = props.title;
          rewriteAll((ref) => ref.sheet === from ? { ...ref, sheet: props.title } : ref);
        }
        if (props.gridProperties?.rowCount !== undefined) sheet.maxRows = props.gridProperties.rowCount;
        if (props.gridProperties?.columnCount !== undefined) sheet.maxColumns = props.gridProperties.columnCount;
        if (props.gridProperties?.frozenRowCount !== undefined) sheet.frozenRows = props.gridProperties.frozenRowCount;
        if (props.hidden !== undefined) sheet.hidden = Boolean(props.hidden);
        if (props.gridProperties?.hideGridlines !== undefined) sheet.hiddenGridlines = Boolean(props.gridProperties.hideGridlines);
        if (props.tabColorStyle !== undefined) sheet.tabColor = plain(props.tabColorStyle);
        if (props.index !== undefined) {
          // Like the API, an index counts positions before the move: moving right lands one place left of it.
          if (!Number.isInteger(props.index) || props.index < 0 || props.index > order.length) throw new Error('Invalid sheet index');
          const from = order.indexOf(sheet.id);
          order.splice(from, 1);
          order.splice(props.index > from ? props.index - 1 : props.index, 0, sheet.id);
        }
        if (!Number.isInteger(sheet.maxRows) || sheet.maxRows < 1 || !Number.isInteger(sheet.maxColumns) ||
            sheet.maxColumns < 1 || !Number.isInteger(sheet.frozenRows) || sheet.frozenRows < 0 || sheet.frozenRows > sheet.maxRows)
          throw new Error('Invalid sheet grid properties');
      } else if (request.addChart) {
        const chart = request.addChart.chart;
        checkChartSpec(chart.spec);
        findSheet(chart.position.overlayPosition.anchorCell.sheetId);
        for (const source of JSON.stringify(chart.spec).matchAll(/"sheetId":(\d+)/g)) findSheet(Number(source[1]));
        const chartId = chart.chartId ?? Math.max(state.chartSerial || 0, ...state.charts.map((item) => item.chartId), 0) + stagedCharts.length + 1;
        if (!Number.isInteger(chartId) || chartId < 0 || [...state.charts.filter((item) => item.spreadsheetId === spreadsheetId && !removedCharts.has(item.chartId)), ...stagedCharts].some((item) => item.chartId === chartId))
          throw new Error(`Invalid or duplicate chart id ${chartId}`);
        stagedCharts.push({ spreadsheetId, ...plain(chart), chartId });
        reply = { addChart: { chart: { chartId } } };
      } else if (request.updateChartSpec) {
        const { chartId, spec } = request.updateChartSpec;
        checkChartSpec(spec);
        if (!state.charts.some((chart) => chart.spreadsheetId === spreadsheetId && chart.chartId === chartId && !removedCharts.has(chartId)))
          throw new Error(`No chart with id ${chartId}`);
        for (const source of JSON.stringify(spec).matchAll(/"sheetId":(\d+)/g)) findSheet(Number(source[1]));
        updatedCharts.set(chartId, plain(spec));
      } else if (request.deleteEmbeddedObject) {
        const chartId = request.deleteEmbeddedObject.objectId;
        if (!state.charts.some((chart) => chart.spreadsheetId === spreadsheetId && chart.chartId === chartId && !removedCharts.has(chartId)))
          throw new Error(`No embedded object with id ${chartId}`);
        removedCharts.add(chartId);
      } else if (request.deleteSheet) {
        findSheet(request.deleteSheet.sheetId);
        const removedName = findSheet(request.deleteSheet.sheetId).name;
        staged.delete(request.deleteSheet.sheetId);
        order.splice(order.indexOf(request.deleteSheet.sheetId), 1);
        deletedSheets.add(request.deleteSheet.sheetId);
        // References to the removed tab become #REF!; its named ranges go with it.
        namedRanges = namedRanges.filter((named) => (named.range?.sheetId ?? 0) !== request.deleteSheet.sheetId);
        rewriteAll((ref) => ref.sheet === removedName ? null : ref);
      } else if (request.updateDimensionProperties) {
        const { range: dimension, properties: props, fields } = request.updateDimensionProperties, sheet = findSheet(dimension.sheetId);
        const limit = { ROWS: sheet.maxRows, COLUMNS: sheet.maxColumns }[dimension.dimension];
        const start = dimension.startIndex ?? 0, end = dimension.endIndex ?? limit;
        if (limit === undefined || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > limit)
          throw new Error('Dimension range exceeds sheet grid');
        if (String(fields).split(',').includes('pixelSize')) {
          if (!Number.isInteger(props?.pixelSize) || props.pixelSize < 0) throw new Error('Invalid pixel size');
          for (let index = start; index < end; index++) sheet.pixelSizes[dimension.dimension].set(index, props.pixelSize);
        }
      } else if (MORE_REQUESTS.some((kind) => request[kind])) reply = more(request);
      else throw new Error(`Unsupported batch request: ${Object.keys(request)}`);
      replies.push(reply);
    }
    if (staged.size && [...staged.values()].every((sheet) => sheet.hidden)) throw new Error("You can't hide or remove all the visible sheets in a document.");
    for (const sheet of staged.values()) {
      const existing = originals.get(sheet.id);
      if (existing) Object.assign(existing, sheet);
      else book.sheets.push(sheet);
    }
    if (!staged.size) throw new Error('A spreadsheet must keep at least one sheet');
    book.sheets = order.filter((id) => !deletedSheets.has(id)).map((id) => book.sheets.find((sheet) => sheet.id === id));
    for (const [chartId, edit] of chartEdits) edit(state.charts.find((chart) => chart.spreadsheetId === spreadsheetId && chart.chartId === chartId));
    state.charts = state.charts.filter((chart) => chart.spreadsheetId !== spreadsheetId || !deletedSheets.has(chart.position.overlayPosition.anchorCell.sheetId));
    sheetSerial = nextSheetId;
    for (const chart of state.charts) if (updatedCharts.has(chart.chartId) && chart.spreadsheetId === spreadsheetId) chart.spec = updatedCharts.get(chart.chartId);
    state.chartSerial = Math.max(state.chartSerial || 0, ...state.charts.map((chart) => chart.chartId), ...stagedCharts.map((chart) => chart.chartId), 0);
    state.charts = state.charts.filter((chart) => chart.spreadsheetId !== spreadsheetId || !removedCharts.has(chart.chartId));
    state.charts.push(...stagedCharts);
    book.namedRanges = namedRanges;
    return { spreadsheetId, replies };
  }
  // With createDatamoovSandbox({ gridData: true }), spreadsheets.get answers like the API: the
  // field mask selects what comes back, `ranges` limits the tabs and their grid data, and cells
  // carry userEnteredValue, effectiveValue (errors included), formattedValue, userEnteredFormat,
  // note, dataValidation and pivotTable. Formulas are not evaluated: a formula cell's effective
  // value is whatever setCell or setError gave it.
  const isDate = (value) => Object.prototype.toString.call(value) === '[object Date]';
  const dateParts = (date, timezone) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date).map((part) => [part.type, Number(part.value)]));
  const typedValue = (value, timezone) => {
    if (typeof value === 'number') return { numberValue: value };
    if (typeof value === 'boolean') return { boolValue: value };
    if (!isDate(value)) return { stringValue: String(value) };
    // Dates are serial numbers: days since 1899-12-30 in the spreadsheet's timezone.
    const parts = dateParts(value, timezone);
    return { numberValue: (Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - Date.UTC(1899, 11, 30)) / 86400000 };
  };
  const dateText = (value, timezone) => {
    const parts = dateParts(value, timezone), pad = (number) => String(number).padStart(2, '0');
    return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
  };
  function cellData(sheet, row, column, timezone) {
    const key = address(row + 1, column + 1), entry = sheet.cells.get(key), format = sheet.formats.get(key), data = {};
    if (entry && (entry.formula || entry.error || (entry.value !== '' && entry.value !== null && entry.value !== undefined))) {
      const error = entry.error ? { errorValue: { type: entry.error.type, message: entry.error.message } } : null;
      data.userEnteredValue = entry.formula ? { formulaValue: entry.formula } : error || typedValue(entry.value, timezone);
      if (error || entry.value !== '') {
        data.effectiveValue = error || typedValue(entry.value, timezone);
        data.formattedValue = error ? ERROR_TEXT[entry.error.type] : typeof entry.value === 'boolean' ? (entry.value ? 'TRUE' : 'FALSE')
          : isDate(entry.value) ? dateText(entry.value, timezone) : String(entry.value);
      }
    }
    if (format) data.userEnteredFormat = format;
    const meta = sheet.meta.get(key);
    Object.assign(data, meta);
    if (meta?.chipRuns) data.chipRuns = chipRunsRead(String(entry?.value ?? ''), meta.chipRuns);
    return data;
  }
  // Reads include the runs between chips too, each with an empty chip.
  function chipRunsRead(text, runs) {
    const out = [];
    let at = 0;
    for (const run of [...runs].sort((a, b) => (a.startIndex ?? 0) - (b.startIndex ?? 0))) {
      if ((run.startIndex ?? 0) > at) out.push({ startIndex: at, chip: {} });
      out.push(run);
      at = (run.startIndex ?? 0) + 1;
    }
    if (at < text.length) out.push({ startIndex: at, chip: {} });
    return out;
  }
  function apiGet(book, options) {
    const fields = options.fields ? parseFieldMask(String(options.fields)) : null;
    const wantsData = fields ? maskSelects(fields, ['sheets', 'data']) : Boolean(options.includeGridData);
    const areas = [].concat(options.ranges ?? []).map((text) => {
      const area = resolveRange(String(text), book.sheets, book.namedRanges || []);
      if (!area) throw new Error(`Unable to parse range: ${text}`);
      if (area.outside) throw new Error(`Range (${text}) exceeds grid limits. Max rows: ${area.sheet.maxRows}, max columns: ${area.sheet.maxColumns}`);
      return area;
    });
    // Ranges limit the answer to their tabs, each with one data block per range.
    const sheets = book.sheets.filter((sheet) => !areas.length || areas.some((area) => area.sheet === sheet)).map((sheet) => {
      const entry = {
        properties: sheetProperties(sheet, book.sheets.indexOf(sheet)),
        merges: sheet.merges.map((merge) => ({ sheetId: sheet.id, ...merge })),
        conditionalFormats: sheet.conditionalFormats,
        basicFilter: sheet.filter,
        rowGroups: groupsOf(sheet, 'ROWS'), columnGroups: groupsOf(sheet, 'COLUMNS'),
        developerMetadata: sheet.developerMetadata,
        charts: state.charts.filter((chart) => chart.spreadsheetId === book.id && (chart.position?.overlayPosition?.anchorCell?.sheetId ?? 0) === sheet.id)
          .map(({ spreadsheetId: _, ...chart }) => chart),
      };
      if (wantsData) entry.data = (areas.length ? areas.filter((area) => area.sheet === sheet) : [{ sheet, startRow: 0, endRow: sheet.maxRows, startColumn: 0, endColumn: sheet.maxColumns }])
        .map((area) => ({
          startRow: area.startRow, startColumn: area.startColumn,
          rowData: Array.from({ length: area.endRow - area.startRow }, (_, r) => ({
            values: Array.from({ length: area.endColumn - area.startColumn }, (_, c) => cellData(sheet, area.startRow + r, area.startColumn + c, book.timezone)) })),
          rowMetadata: Array.from({ length: area.endRow - area.startRow }, (_, r) => ({ pixelSize: sheet.pixelSizes.ROWS.get(area.startRow + r) ?? 21 })),
          columnMetadata: Array.from({ length: area.endColumn - area.startColumn }, (_, c) => ({ pixelSize: sheet.pixelSizes.COLUMNS.get(area.startColumn + c) ?? 100 })),
        }));
      return entry;
    });
    const result = projectFields(apiJson({
      spreadsheetId: book.id, properties: { title: book.title || 'Untitled spreadsheet', locale: 'en_US', timeZone: book.timezone },
      sheets, namedRanges: book.namedRanges || [],
    }), fields || true);
    // Like the API, trailing empty cells and rows are left out of the grid data.
    for (const sheet of result.sheets || []) for (const block of sheet.data || []) {
      const rows = block.rowData || [];
      for (const row of rows) {
        while (row.values?.length && !Object.keys(row.values[row.values.length - 1]).length) row.values.pop();
        if (row.values && !row.values.length) delete row.values;
      }
      while (rows.length && !Object.keys(rows[rows.length - 1]).length) rows.pop();
      if (block.rowData && !rows.length) delete block.rowData;
    }
    return result;
  }
  const fakeServices = {
    Date: ClockDate,
    PropertiesService: { getUserProperties: () => user, getScriptProperties: () => script, getDocumentProperties: () => document },
    LockService: { getUserLock: () => ({ tryLock() { state.lockAcquires++; return state.lockAvailable; }, releaseLock() { state.lockReleases++; } }),
      getScriptLock: () => ({ tryLock(milliseconds) { state.scriptLockAcquires++; state.scriptLockWaits.push(milliseconds); return state.scriptLockAvailable; }, releaseLock() { state.scriptLockReleases++; } }) },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF_8' },
      computeDigest: (_algorithm, value) => [...createHash('sha256').update(String(value), 'utf8').digest()],
      getUuid: () => `id-${++serial}`,
      newBlob: (value, contentType = null, name = null) => ({ getContentType: () => contentType, getName: () => name, getBytes: () => [...Buffer.from(Array.isArray(value) ? value : String(value))],
        getDataAsString: () => Buffer.from(Array.isArray(value) ? value : String(value)).toString('utf8') }),
      gzip: (blob) => ({ getContentType: () => 'application/x-gzip', getBytes: () => [...gzipSync(Buffer.from(blob.getBytes()))] }),
      ungzip: (blob) => {
        if (blob.getContentType?.() !== 'application/x-gzip') throw new Error('Invalid argument: expected a gzip blob');
        return { getDataAsString: () => gunzipSync(Buffer.from(blob.getBytes())).toString('utf8') };
      },
      base64Decode: (value) => [...Buffer.from(value, 'base64')],
      // The Java pattern tokens the app uses: yyyy, MM, dd, HH, H and mm, in the given timezone.
      formatDate(date, timezone, pattern = 'yyyy-MM-dd') {
        const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date).map((part) => [part.type, part.value]));
        // z is the zone's short name, as Java's SimpleDateFormat prints it (PDT, or GMT+3 where Intl has no abbreviation).
        const zone = () => new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'short' }).formatToParts(date).find((part) => part.type === 'timeZoneName').value;
        return pattern.replace(/yyyy|MM|dd|HH|H|mm|z/g, (token) => token === 'z' ? zone() : ({ yyyy: parts.year, MM: parts.month, dd: parts.day, HH: parts.hour, H: String(Number(parts.hour)), mm: parts.minute })[token]);
      },
      parseCsv: (text) => parseCsv(text),
      unzip: (blob) => unzip(Buffer.from(blob.getBytes())),
      base64Encode: (value) => Buffer.from(value).toString('base64'),
      base64EncodeWebSafe: (value) => Buffer.from(value).toString('base64url'),
      sleep: (milliseconds) => { state.sleeps.push(milliseconds); now += milliseconds; },
    },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => activeSpreadsheet,
      // A separate object with a fresh view, exactly as Apps Script returns.
      openById(id) { state.opened.push(id); const server = state.books.get(id); if (!server) throw new Error('Spreadsheet not found'); return makeHandle(server); },
      flush() { state.flushes++; },
    },
    Sheets: { Spreadsheets: {
      batchUpdate: applyBatch,
      get(spreadsheetId, options) {
        state.gets.push({ spreadsheetId, options: plain(options || {}) });
        const book = state.books.get(spreadsheetId);
        if (!book) throw new Error('Unknown spreadsheet');
        if (settings.gridData) return apiGet(book, options || {});
        // Merges only when the field mask asks for them, and like the API without zero-valued indexes.
        const merges = !options?.fields || /\bmerges\b/.test(options.fields);
        const result = { sheets: book.sheets.map((sheet, index) => ({ properties: { sheetId: sheet.id, title: sheet.name, index, hidden: sheet.hidden, gridProperties: { rowCount: sheet.maxRows, columnCount: sheet.maxColumns, frozenRowCount: sheet.frozenRows } },
          charts: state.charts.filter((chart) => chart.spreadsheetId === spreadsheetId && chart.position.overlayPosition.anchorCell.sheetId === sheet.id).map((chart) => ({ chartId: chart.chartId, position: chart.position })),
          ...(merges && sheet.merges.length ? { merges: sheet.merges.map((merge) => Object.fromEntries(Object.entries({ sheetId: sheet.id, ...merge }).filter(([, value]) => value !== 0))) } : {}) })) };
        // Conditional formats, groups and named ranges appear once a request has made some, when the mask asks.
        const wants = (name) => !options?.fields || new RegExp(`\\b${name}\\b`).test(options.fields);
        result.sheets.forEach((entry, index) => {
          const sheet = book.sheets[index];
          if (wants('conditionalFormats') && sheet.conditionalFormats.length) entry.conditionalFormats = apiJson(sheet.conditionalFormats);
          for (const [key, dimension] of [['rowGroups', 'ROWS'], ['columnGroups', 'COLUMNS']])
            if (wants(key) && groupsOf(sheet, dimension).length) entry[key] = apiJson(groupsOf(sheet, dimension));
          if (wants('developerMetadata') && sheet.developerMetadata.length) entry.developerMetadata = apiJson(sheet.developerMetadata);
        });
        if (wants('namedRanges') && book.namedRanges?.length) result.namedRanges = apiJson(book.namedRanges);
        return result;
      },
    } },
    ScriptApp: {
      getOAuthToken: () => 'fake-native-google-token',
      getProjectTriggers: () => state.triggers.slice(),
      deleteTrigger(trigger) { state.deletedTriggers.push(trigger); state.triggers = state.triggers.filter((candidate) => candidate !== trigger); },
      newTrigger(handler) {
        const builder = { timeBased: () => builder, everyHours: () => builder, create() {
          if (state.failTrigger) throw new Error('Trigger creation denied');
          const trigger = addTrigger(handler); state.createdTriggers.push(trigger); return trigger;
        } };
        return builder;
      },
    },
    CacheService: { getUserCache: () => cache },
    UrlFetchApp: { fetch(url, options) {
      state.http.push({ url, options: plain(options) });
      if (!state.responses.length) throw new Error('Network access is unavailable in offline tests');
      const reply = state.responses.shift();
      if (reply instanceof Error) throw reply;
      return { getResponseCode: () => reply.code ?? 200, getContentText: () => typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {}),
        getAllHeaders: () => reply.headers || {},
        getBlob: () => {
          const bytes = Buffer.from(reply.bytes || (typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {})));
          return { getBytes: () => [...bytes], getDataAsString: () => bytes.toString('utf8') };
        } };
    } },
  };
  const context = vm.createContext(fakeServices, { codeGeneration: { strings: false, wasm: false } });
  for (const filename of ['dmv_core.js', 'dmv_sql.js', 'dmv_http.js', 'dmv_connector_helpers.js', 'dmv_store.js', 'dmv_welcome.js', 'dmv_credentials.js', 'dmv_connections.js', 'dmv_credential_import.js', 'dmv_reports.js', 'dmv_writer.js', 'dmv_schedule.js', 'dmv_continuation.js', 'dmv_ai.js', 'dmv_formulas.js', 'dmv_chat_tools.js', 'dmv_chat_sheets.js', 'dmv_chat_pivots.js', 'dmv_chat_sheet_actions.js', 'dmv_chat_sheet_conditions.js', 'dmv_chat_sheet_formulas.js', 'dmv_chat_sheet_safety.js', 'dmv_dashboards.js', 'dmv_chat_dashboards.js', 'dmv_chat_reports.js', 'dmv_chat.js']) {
    new vm.Script(readFileSync(new URL(`../../src/${filename}`, import.meta.url), 'utf8'), { filename }).runInContext(context, { timeout: 1000 });
  }
  const book = addSpreadsheet();
  return {
    api: context, state, book, addSpreadsheet, addTrigger, tab: findTab, reopen,
    setActive: (spreadsheet) => { activeSpreadsheet = spreadsheet; },
    advance: (milliseconds) => { now += milliseconds; },
    setCell(sheet, row, column, value, formula = '') { sheet.cells.set(address(row, column), { value, formula }); },
    value: (sheet, row, column) => cell(sheet, row, column).value,
    formula: (sheet, row, column) => cell(sheet, row, column).formula,
    // Rows and columns are 1-based, like value(): the cell's userEnteredFormat ({} when unset),
    // the tab's merges in A1 notation, and a row height or column width (Sheets defaults when unset).
    format: (sheet, row, column) => plain(sheet.formats.get(address(row, column)) || {}),
    merges: (sheet) => sheet.merges
      .slice().sort((a, b) => a.startRowIndex - b.startRowIndex || a.startColumnIndex - b.startColumnIndex)
      .map((merge) => `${columnLabel(merge.startColumnIndex + 1)}${merge.startRowIndex + 1}:${columnLabel(merge.endColumnIndex)}${merge.endRowIndex}`),
    pixelSize: (sheet, dimension, index) => sheet.pixelSizes[dimension].get(index - 1) ?? (dimension === 'ROWS' ? 21 : 100),
    // A formula result Sheets reports as an error, such as { type: 'REF', message: 'Reference does
    // not exist.' }; getValues() returns its text (#REF!), as in Apps Script.
    setError(sheet, row, column, error, formula = '') {
      if (!ERROR_TEXT[error?.type]) throw new Error(`Unknown error type ${error?.type}`);
      sheet.cells.set(address(row, column), { value: ERROR_TEXT[error.type], formula, error: { type: error.type, message: error.message ?? '' } });
    },
    // The cell's note, dataValidation, pivotTable, textFormatRuns and chipRuns ({} when unset); setMeta replaces them.
    meta: (sheet, row, column) => plain(sheet.meta.get(address(row, column)) || {}),
    setMeta(sheet, row, column, fields) {
      if (fields && Object.keys(fields).length) sheet.meta.set(address(row, column), plain(fields));
      else sheet.meta.delete(address(row, column));
    },
    conditionalFormats: (sheet) => plain(sheet.conditionalFormats),
    groups: (sheet, dimension = 'ROWS') => plain(groupsOf(sheet, dimension)),
    namedRanges: (spreadsheet = book) => plain(spreadsheet.server.namedRanges || []),
    readReport: (id) => JSON.parse(user.getProperty(`dmv:v1:report:${id}`)),
    readOutput: (id, spreadsheetId = book.id) => JSON.parse(user.getProperty(`dmv:v1:output:${spreadsheetId}:${id}`) || 'null'),
  };
}
