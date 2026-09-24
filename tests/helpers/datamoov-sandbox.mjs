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
    scriptLockAcquires: 0, scriptLockReleases: 0, scriptLockAvailable: true, scriptLockWaits: [],
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
    for (const method of ['setFontWeight', 'setBackground', 'setFontColor', 'setNumberFormat', 'setWrap', 'setVerticalAlignment', 'setFontSize']) result[method] = () => result;
    return result;
  }
  function makeSheet(name, maxRows = 100, maxColumns = 26, id = ++sheetSerial) {
    const sheet = {
      id, name, maxRows, maxColumns, hidden: false, frozenRows: 0, cells: new Map(),
      columnWidths: new Map(), hiddenGridlines: false, tabColor: null,
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
        for (const key of sheet.cells.keys()) {
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
      getSheetByName: (name) => visible().find((sheet) => sheet.name === name) || null,
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
    const staged = new Map(book.sheets.map((sheet) => [sheet.id, { ...sheet, cells: new Map(sheet.cells) }]));
    const stagedCharts = [];
    const updatedCharts = new Map(), removedCharts = new Set(), deletedSheets = new Set();
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
    for (const request of body.requests || []) {
      let reply = {};
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
        nextSheetId = Math.max(nextSheetId, id);
        reply = { addSheet: { properties: { ...plain(props), sheetId: id } } };
      } else if (request.updateCells) {
        const update = request.updateCells;
        const grid = update.range || { sheetId: update.start.sheetId, startRowIndex: update.start.rowIndex || 0, startColumnIndex: update.start.columnIndex || 0,
          endRowIndex: (update.start.rowIndex || 0) + (update.rows || []).length,
          endColumnIndex: (update.start.columnIndex || 0) + Math.max(0, ...(update.rows || []).map((row) => (row.values || []).length)) };
        const target = readGrid(grid);
        if (String(update.fields).includes('userEnteredValue') || update.fields === '*') {
          for (let r = target.startRow; r < target.endRow; r++) for (let c = target.startColumn; c < target.endColumn; c++)
            put(target.cells, r, c, update.rows?.[r - target.startRow]?.values?.[c - target.startColumn]);
        }
      } else if (request.repeatCell) {
        const repeat = request.repeatCell;
        const target = readGrid(repeat.range);
        if (String(repeat.fields).includes('userEnteredValue') || repeat.fields === '*')
          for (let r = target.startRow; r < target.endRow; r++) for (let c = target.startColumn; c < target.endColumn; c++) put(target.cells, r, c, repeat.cell);
      } else if (request.appendDimension) {
        const append = request.appendDimension, sheet = findSheet(append.sheetId);
        if (!Number.isInteger(append.length) || append.length < 1) throw new Error('Invalid appended dimension length');
        if (append.dimension === 'ROWS') sheet.maxRows += append.length;
        else if (append.dimension === 'COLUMNS') sheet.maxColumns += append.length;
        else throw new Error('Invalid appended dimension');
      } else if (request.updateSheetProperties) {
        const props = request.updateSheetProperties.properties, sheet = findSheet(props.sheetId);
        if (props.gridProperties?.rowCount !== undefined) sheet.maxRows = props.gridProperties.rowCount;
        if (props.gridProperties?.columnCount !== undefined) sheet.maxColumns = props.gridProperties.columnCount;
        if (props.gridProperties?.frozenRowCount !== undefined) sheet.frozenRows = props.gridProperties.frozenRowCount;
        if (props.hidden !== undefined) sheet.hidden = Boolean(props.hidden);
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
        staged.delete(request.deleteSheet.sheetId);
        deletedSheets.add(request.deleteSheet.sheetId);
      } else if (request.updateDimensionProperties) {
        findSheet(request.updateDimensionProperties.range.sheetId);
      } else throw new Error(`Unsupported batch request: ${Object.keys(request)}`);
      replies.push(reply);
    }
    for (const sheet of staged.values()) {
      const existing = originals.get(sheet.id);
      if (existing) Object.assign(existing, sheet);
      else book.sheets.push(sheet);
    }
    if (!staged.size) throw new Error('A spreadsheet must keep at least one sheet');
    book.sheets = book.sheets.filter((sheet) => !deletedSheets.has(sheet.id));
    state.charts = state.charts.filter((chart) => chart.spreadsheetId !== spreadsheetId || !deletedSheets.has(chart.position.overlayPosition.anchorCell.sheetId));
    sheetSerial = nextSheetId;
    for (const chart of state.charts) if (updatedCharts.has(chart.chartId) && chart.spreadsheetId === spreadsheetId) chart.spec = updatedCharts.get(chart.chartId);
    state.chartSerial = Math.max(state.chartSerial || 0, ...state.charts.map((chart) => chart.chartId), ...stagedCharts.map((chart) => chart.chartId), 0);
    state.charts = state.charts.filter((chart) => chart.spreadsheetId !== spreadsheetId || !removedCharts.has(chart.chartId));
    state.charts.push(...stagedCharts);
    return { spreadsheetId, replies };
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
      formatDate: (date, timezone) => new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date),
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
        return { sheets: book.sheets.map((sheet) => ({ properties: { sheetId: sheet.id, title: sheet.name, hidden: sheet.hidden, gridProperties: { rowCount: sheet.maxRows, columnCount: sheet.maxColumns, frozenRowCount: sheet.frozenRows } },
          charts: state.charts.filter((chart) => chart.spreadsheetId === spreadsheetId && chart.position.overlayPosition.anchorCell.sheetId === sheet.id).map((chart) => ({ chartId: chart.chartId, position: chart.position })) })) };
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
  for (const filename of ['dmv_core.js', 'dmv_sql.js', 'dmv_http.js', 'dmv_connector_helpers.js', 'dmv_store.js', 'dmv_welcome.js', 'dmv_credentials.js', 'dmv_connections.js', 'dmv_credential_import.js', 'dmv_reports.js', 'dmv_writer.js', 'dmv_schedule.js', 'dmv_continuation.js', 'dmv_ai.js', 'dmv_chat_tools.js', 'dmv_chat_sheets.js', 'dmv_chat_pivots.js', 'dmv_dashboards.js', 'dmv_chat_dashboards.js', 'dmv_chat.js']) {
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
    readReport: (id) => JSON.parse(user.getProperty(`dmv:v1:report:${id}`)),
    readOutput: (id, spreadsheetId = book.id) => JSON.parse(user.getProperty(`dmv:v1:output:${spreadsheetId}:${id}`) || 'null'),
  };
}
