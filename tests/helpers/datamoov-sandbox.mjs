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

export function createDatamoovSandbox() {
  let now = Date.parse('2026-09-18T12:00:00Z');
  let serial = 0, sheetSerial = 10;
  let activeSpreadsheet = null;
  const user = properties(), script = properties(), document = properties();
  const cacheData = new Map();
  const cache = {
    data: cacheData,
    get: (key) => cacheData.has(key) ? cacheData.get(key) : null,
    put(key, value) { cacheData.set(key, String(value)); },
    putAll(values) { for (const [key, value] of Object.entries(values)) cacheData.set(key, String(value)); },
    getAll(keys) { return Object.fromEntries(keys.filter((key) => cacheData.has(key)).map((key) => [key, cacheData.get(key)])); },
    remove(key) { cacheData.delete(key); },
  };
  const state = {
    user, script, document, cache, books: new Map(), opened: [], batches: [], legacyWrites: [], clears: [],
    flushes: 0, lockAcquires: 0, lockReleases: 0, lockAvailable: true, triggers: [],
    createdTriggers: [], deletedTriggers: [], http: [], responses: [], sleeps: [], charts: [], gets: [],
    failBatch: false, failTrigger: false, failProperty: null,
  };
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const address = (row, column) => `${row}:${column}`;
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
      getA1Notation() {
        let number = column, label = '';
        while (number) { number--; label = String.fromCharCode(65 + number % 26) + label; number = Math.floor(number / 26); }
        return `${label}${row}`;
      },
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
    for (const method of ['setFontWeight', 'setBackground', 'setFontColor', 'setNumberFormat', 'setWrap', 'setVerticalAlignment']) result[method] = () => result;
    return result;
  }
  function makeSheet(name, maxRows = 100, maxColumns = 26) {
    const sheet = {
      id: ++sheetSerial, name, maxRows, maxColumns, cells: new Map(),
      getName: () => name, getSheetId: () => sheet.id,
      getMaxRows: () => sheet.maxRows, getMaxColumns: () => sheet.maxColumns,
      getRange: (...args) => range(sheet, ...args),
      getDataRange() {
        let lastRow = 0, lastColumn = 0;
        for (const key of sheet.cells.keys()) {
          const [r, c] = key.split(':').map(Number);
          lastRow = Math.max(lastRow, r); lastColumn = Math.max(lastColumn, c);
        }
        return range(sheet, 1, 1, Math.max(1, lastRow), Math.max(1, lastColumn));
      },
      insertRowsAfter(_after, count) { sheet.maxRows += count; },
      insertColumnsAfter(_after, count) { sheet.maxColumns += count; },
      setFrozenRows() {},
    };
    return sheet;
  }
  function addSpreadsheet(id = 'spreadsheet-one', names = ['Output']) {
    const book = {
      id, sheets: names.map((name) => makeSheet(name)), timezone: 'Europe/Athens', activeRange: null,
      getId: () => id, getSpreadsheetTimeZone: () => book.timezone,
      getSheets: () => book.sheets,
      getSheetByName: (name) => book.sheets.find((sheet) => sheet.name === name) || null,
      insertSheet(name) { const sheet = makeSheet(name); book.sheets.push(sheet); return sheet; },
      getActiveRange: () => book.activeRange,
    };
    state.books.set(id, book);
    if (!activeSpreadsheet) activeSpreadsheet = book;
    return book;
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
    const staged = new Map(book.sheets.map((sheet) => [sheet.id, new Map(sheet.cells)]));
    const findSheet = (id) => {
      const sheet = book.sheets.find((candidate) => candidate.id === id);
      if (!sheet) throw new Error(`Unknown sheet ${id}`);
      return sheet;
    };
    const readGrid = (grid) => {
      const sheet = findSheet(grid.sheetId);
      if ((grid.endRowIndex ?? sheet.maxRows) > sheet.maxRows || (grid.endColumnIndex ?? sheet.maxColumns) > sheet.maxColumns) throw new Error('Batch range exceeds sheet grid');
      return { sheet, cells: staged.get(sheet.id), startRow: grid.startRowIndex || 0, startColumn: grid.startColumnIndex || 0,
        endRow: grid.endRowIndex ?? sheet.maxRows, endColumn: grid.endColumnIndex ?? sheet.maxColumns };
    };
    const put = (cells, row, column, input) => {
      const entry = input?.userEnteredValue;
      if (!entry || !Object.keys(entry).length) { cells.delete(address(row + 1, column + 1)); return; }
      if (Object.hasOwn(entry, 'formulaValue')) cells.set(address(row + 1, column + 1), { value: entry.formulaValue, formula: entry.formulaValue });
      else cells.set(address(row + 1, column + 1), { value: entry.stringValue ?? entry.numberValue ?? entry.boolValue ?? '', formula: '' });
    };
    for (const request of body.requests || []) {
      if (request.updateCells) {
        const update = request.updateCells;
        if (!String(update.fields).includes('userEnteredValue') && update.fields !== '*') continue;
        const grid = update.range || { sheetId: update.start.sheetId, startRowIndex: update.start.rowIndex || 0, startColumnIndex: update.start.columnIndex || 0,
          endRowIndex: (update.start.rowIndex || 0) + (update.rows || []).length,
          endColumnIndex: (update.start.columnIndex || 0) + Math.max(0, ...(update.rows || []).map((row) => (row.values || []).length)) };
        const target = readGrid(grid);
        for (let r = target.startRow; r < target.endRow; r++) for (let c = target.startColumn; c < target.endColumn; c++) {
          put(target.cells, r, c, update.rows?.[r - target.startRow]?.values?.[c - target.startColumn]);
        }
      } else if (request.repeatCell) {
        const repeat = request.repeatCell;
        if (!String(repeat.fields).includes('userEnteredValue') && repeat.fields !== '*') continue;
        const target = readGrid(repeat.range);
        for (let r = target.startRow; r < target.endRow; r++) for (let c = target.startColumn; c < target.endColumn; c++) put(target.cells, r, c, repeat.cell);
      } else if (request.appendDimension) {
        const append = request.appendDimension, sheet = findSheet(append.sheetId);
        if (append.dimension === 'ROWS') sheet.maxRows += append.length;
        else sheet.maxColumns += append.length;
      } else if (request.updateSheetProperties) {
        const props = request.updateSheetProperties.properties, sheet = findSheet(props.sheetId);
        if (props.gridProperties?.rowCount) sheet.maxRows = props.gridProperties.rowCount;
        if (props.gridProperties?.columnCount) sheet.maxColumns = props.gridProperties.columnCount;
      } else if (request.addChart) {
        const chart = request.addChart.chart;
        findSheet(chart.position.overlayPosition.anchorCell.sheetId);
        for (const source of JSON.stringify(chart.spec).matchAll(/"sheetId":(\d+)/g)) findSheet(Number(source[1]));
        state.charts.push({ spreadsheetId, chartId: state.charts.length + 1, ...plain(chart) });
      } else throw new Error(`Unsupported batch request: ${Object.keys(request)}`);
    }
    book.sheets.forEach((sheet) => { sheet.cells = staged.get(sheet.id); });
    return { spreadsheetId, replies: (body.requests || []).map((request) => request.addChart ? { addChart: { chart: { chartId: state.charts.length } } } : ({})) };
  }
  const fakeServices = {
    Date: ClockDate,
    PropertiesService: { getUserProperties: () => user, getScriptProperties: () => script, getDocumentProperties: () => document },
    LockService: { getUserLock: () => ({ tryLock() { state.lockAcquires++; return state.lockAvailable; }, releaseLock() { state.lockReleases++; } }),
      getScriptLock: () => { throw new Error('Use the per-user lock; a Marketplace add-on shares one script across all users'); } },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF_8' },
      computeDigest: (_algorithm, value) => [...createHash('sha256').update(String(value), 'utf8').digest()],
      getUuid: () => `id-${++serial}`,
      newBlob: (value) => ({ getBytes: () => [...Buffer.from(Array.isArray(value) ? value : String(value))],
        getDataAsString: () => Buffer.from(Array.isArray(value) ? value : String(value)).toString('utf8') }),
      gzip: (blob) => ({ getBytes: () => [...gzipSync(Buffer.from(blob.getBytes()))] }),
      ungzip: (blob) => ({ getDataAsString: () => gunzipSync(Buffer.from(blob.getBytes())).toString('utf8') }),
      base64Decode: (value) => [...Buffer.from(value, 'base64')],
      formatDate: (date, timezone) => new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date),
      parseCsv: (text) => parseCsv(text),
      unzip: (blob) => unzip(Buffer.from(blob.getBytes())),
      base64Encode: (value) => Buffer.from(value).toString('base64'),
      base64EncodeWebSafe: (value) => Buffer.from(value).toString('base64url'),
      sleep: (milliseconds) => { state.sleeps.push(milliseconds); now += milliseconds; },
    },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => activeSpreadsheet,
      openById(id) { state.opened.push(id); const book = state.books.get(id); if (!book) throw new Error('Spreadsheet not found'); return book; },
      flush() { state.flushes++; },
    },
    Sheets: { Spreadsheets: {
      batchUpdate: applyBatch,
      get(spreadsheetId, options) {
        state.gets.push({ spreadsheetId, options: plain(options || {}) });
        const book = state.books.get(spreadsheetId);
        if (!book) throw new Error('Unknown spreadsheet');
        return { sheets: book.sheets.map((sheet) => ({ properties: { sheetId: sheet.id, gridProperties: { rowCount: sheet.maxRows, columnCount: sheet.maxColumns } } })) };
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
        getBlob: () => ({ getBytes: () => [...(reply.bytes || Buffer.from(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {})))] }) };
    } },
  };
  const context = vm.createContext(fakeServices, { codeGeneration: { strings: false, wasm: false } });
  for (const filename of ['dmv_core.js', 'dmv_sql.js', 'dmv_http.js', 'dmv_connector_helpers.js', 'dmv_store.js', 'dmv_credentials.js', 'dmv_connections.js', 'dmv_reports.js', 'dmv_writer.js', 'dmv_schedule.js', 'dmv_continuation.js', 'dmv_ai.js', 'dmv_chat_tools.js', 'dmv_chat.js']) {
    new vm.Script(readFileSync(new URL(`../../src/${filename}`, import.meta.url), 'utf8'), { filename }).runInContext(context, { timeout: 1000 });
  }
  const book = addSpreadsheet();
  return {
    api: context, state, book, addSpreadsheet, addTrigger,
    setActive: (spreadsheet) => { activeSpreadsheet = spreadsheet; },
    advance: (milliseconds) => { now += milliseconds; },
    setCell(sheet, row, column, value, formula = '') { sheet.cells.set(address(row, column), { value, formula }); },
    value: (sheet, row, column) => cell(sheet, row, column).value,
    formula: (sheet, row, column) => cell(sheet, row, column).formula,
    readReport: (id) => JSON.parse(user.getProperty(`dmv:v1:report:${id}`)),
    readOutput: (id, spreadsheetId = book.id) => JSON.parse(user.getProperty(`dmv:v1:output:${spreadsheetId}:${id}`) || 'null'),
  };
}
