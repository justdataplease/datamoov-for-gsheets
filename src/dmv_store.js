/* Private per-user storage, locks and the active spreadsheet. */
function dmvStore_() {
  return PropertiesService.getUserProperties();
}

function dmvId_() {
  return Utilities.getUuid();
}

function dmvKey_(kind, id) {
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(String(id || ''))) throw new Error('Invalid saved item.');
  return 'dmv:v1:' + kind + ':' + id;
}

function dmvRead_(kind, id) {
  var raw = dmvStore_().getProperty(dmvKey_(kind, id));
  if (!raw) throw new Error('This ' + kind + ' no longer exists. Refresh the sidebar.');
  return JSON.parse(raw);
}

function dmvSave_(kind, value) {
  var text = dmvCheckRecordSize_(value);
  dmvStore_().setProperty(dmvKey_(kind, value.id), text);
  return value;
}

function dmvList_(kind) {
  var values = dmvStore_().getProperties();
  var prefix = 'dmv:v1:' + kind + ':';
  return Object.keys(values)
    .filter(function (key) {
      return key.indexOf(prefix) === 0;
    })
    .map(function (key) {
      return JSON.parse(values[key]);
    });
}

// Private records use a per-user lock. Depth is execution-local so credential rotations can
// reuse an already-held lock without releasing the outer operation.
var DMV_USER_LOCK_DEPTH = 0;
var DMV_WORKBOOK_LOCK_DEPTH = 0;
function dmvLocked_(callback) {
  if (DMV_USER_LOCK_DEPTH) return callback();
  var lock = LockService.getUserLock();
  if (!lock.tryLock(10000))
    throw new Error('Another refresh is updating this report. Try again shortly.');
  DMV_USER_LOCK_DEPTH++;
  try {
    return callback();
  } finally {
    DMV_USER_LOCK_DEPTH--;
    lock.releaseLock();
  }
}

function dmvSpreadsheet_() {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throw new Error('Open DataMoov from a Google spreadsheet.');
  return spreadsheet;
}

// The Advanced Sheets service creates tabs on the server, but a Spreadsheet object Apps Script
// already materialized never learns about them. Opening the spreadsheet again does.
function dmvReopen_(spreadsheet) {
  try {
    SpreadsheetApp.flush();
    return SpreadsheetApp.openById(spreadsheet.getId());
  } catch (ignored) {
    // A refresh failure must never undo an already committed write.
    return spreadsheet;
  }
}

// Output receipts are private to the user who wrote the report; other people's cells stay
// protected by the existing-data check in the writer.
function dmvOutputKey_(spreadsheetId, reportId) {
  return 'dmv:v1:output:' + spreadsheetId + ':' + reportId;
}

function dmvReportHere_(id) {
  var report = dmvRead_('report', id);
  if (report.spreadsheetId !== dmvSpreadsheet_().getId())
    throw new Error('This report belongs to a different spreadsheet.');
  return report;
}

function dmvCheckRecordSize_(value) {
  var text = JSON.stringify(value);
  if (Utilities.newBlob(text).getBytes().length > 8000)
    throw new Error('This configuration is too large. Shorten the query or select fewer fields.');
  return text;
}

// Shared sheet mutations and output verification/write use the same short lock in sidebar and
// time-driven executions, including when no active document exists. Never hold it for a fetch.
function dmvWorkbookLocked_(callback) {
  if (DMV_WORKBOOK_LOCK_DEPTH) return callback();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000))
    throw new Error('Another user is updating report output. Try again shortly.');
  DMV_WORKBOOK_LOCK_DEPTH++;
  try {
    return callback();
  } finally {
    DMV_WORKBOOK_LOCK_DEPTH--;
    lock.releaseLock();
  }
}

// Links are derived only from the active workbook and a verified destination tab.
function dmvSheetUrl_(spreadsheet, sheetId, range) {
  var id = String(spreadsheet.getId());
  if (!/^[A-Za-z0-9_-]+$/.test(id) || !Number.isInteger(sheetId) || sheetId < 0) return null;
  var url = 'https://docs.google.com/spreadsheets/d/' + id + '/edit#gid=' + sheetId;
  if (typeof range === 'string' && /^[A-Z]+[1-9][0-9]*(?::[A-Z]+[1-9][0-9]*)?$/.test(range))
    url += '&range=' + encodeURIComponent(range);
  return url;
}

function dmvSheetLink_(spreadsheet, target, range) {
  try {
    var sheet = target && spreadsheet.getSheetByName(target.sheetName);
    return sheet ? dmvSheetUrl_(spreadsheet, sheet.getSheetId(), range || target.startCell) : null;
  } catch (ignored) {
    // A missing link must not change the outcome of an already committed write.
    return null;
  }
}
