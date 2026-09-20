/* Report definitions, previews and execution. Called from the sidebar and the scheduler. */
function dmvBootstrap() {
  var spreadsheet = dmvSpreadsheet_();
  var active = spreadsheet.getActiveRange();
  var targetIsEmpty =
    active &&
    active.getCell(1, 1).getValues()[0][0] === '' &&
    active.getCell(1, 1).getFormulas()[0][0] === '';
  var fallbackName = 'DataMoov report',
    suffix = 2;
  while (spreadsheet.getSheetByName(fallbackName)) fallbackName = 'DataMoov report ' + suffix++;
  return {
    branding: { name: 'DataMoov', version: '1.0 beta' },
    catalog: dmvCatalog_(),
    connections: dmvList_('connection').map(dmvConnectionSummary_),
    reports: dmvList_('report').filter(function (report) {
      return report.spreadsheetId === spreadsheet.getId();
    }),
    sheetNames: spreadsheet.getSheets().map(function (sheet) {
      return sheet.getName();
    }),
    limits: DMV_LIMITS,
    ai: dmvAiSummary_(dmvAiRead_()),
    defaultTarget: {
      sheetName: targetIsEmpty ? active.getSheet().getName() : fallbackName,
      startCell: targetIsEmpty ? active.getCell(1, 1).getA1Notation() : 'A1',
    },
    dateTimezone: spreadsheet.getSpreadsheetTimeZone(),
  };
}

// The data half of a report: connection, report type, fields, configuration, dates and row limit.
// Saved reports and chat queries validate through this same function.
function dmvValidateQuery_(input, spreadsheet) {
  input = input || {};
  var connection = dmvRead_('connection', input.connectionId);
  var connector = dmvConnector_(connection.connectorId);
  if (input.connectorId && input.connectorId !== connector.id)
    throw new Error('The connection does not match this source.');
  var definition = dmvDefinition_(connector, input.reportType);
  var config = dmvFieldsInput_(definition.configFields || [], input.config || {});
  var fields = input.fields || dmvDefaultFields_(definition.fields || []);
  if (
    !Array.isArray(fields) ||
    fields.length > DMV_LIMITS.maxColumns ||
    fields.some(function (key) {
      return typeof key !== 'string' || key.length > 150;
    }) ||
    new Set(fields).size !== fields.length
  )
    throw new Error('Choose valid, distinct report fields.');
  if (!fields.length && (definition.fields || []).length)
    throw new Error('Select at least one report field.');
  var dateRange = input.dateRange || { preset: 'last30' };
  if (definition.dateRange)
    dmvDateRange_(
      dateRange,
      Utilities.formatDate(new Date(), spreadsheet.getSpreadsheetTimeZone(), 'yyyy-MM-dd')
    );
  return {
    connectorId: connector.id,
    connectionId: connection.id,
    reportType: definition.id,
    fields: fields,
    config: config,
    dateRange: dateRange,
    maxRows: dmvInteger_(
      input.maxRows === undefined ? DMV_LIMITS.defaultRows : input.maxRows,
      1,
      DMV_LIMITS.maxRows,
      'Row limit'
    ),
  };
}

function dmvSheetName_(value) {
  var sheetName = dmvText_(value, 'Output tab', 100, true);
  if (/[\[\]*?:\\/]/.test(sheetName))
    throw new Error('The output tab name contains unsupported characters.');
  return sheetName;
}

function dmvValidateReport_(input, spreadsheet) {
  input = input || {};
  var query = dmvValidateQuery_(input, spreadsheet);
  var sheetName = dmvSheetName_((input.target || {}).sheetName);
  var cell = dmvCell_((input.target || {}).startCell || 'A1');
  var schedule = input.schedule || 'manual';
  if (['manual', 'hourly', 'daily', 'weekly'].indexOf(schedule) < 0)
    throw new Error('Choose a supported refresh schedule.');
  return {
    id: input.id || dmvId_(),
    spreadsheetId: spreadsheet.getId(),
    name: dmvText_(input.name, 'Report name', 80, true),
    connectorId: query.connectorId,
    connectionId: query.connectionId,
    reportType: query.reportType,
    fields: query.fields,
    config: query.config,
    dateRange: query.dateRange,
    target: { sheetName: sheetName, startCell: cell.a1 },
    maxRows: query.maxRows,
    schedule: schedule,
  };
}

function dmvSaveReport(input) {
  return dmvLocked_(function () {
    var spreadsheet = dmvSpreadsheet_();
    var previous = input && input.id ? dmvReportHere_(input.id) : null;
    if (previous && previous.runToken && Date.now() - previous.startedAt < 300000)
      throw new Error('Wait for the current refresh to finish before editing this report.');
    if (!previous && dmvList_('report').length >= DMV_LIMITS.maxReports)
      throw new Error('Keep at most ' + DMV_LIMITS.maxReports + ' reports in this app.');
    var report = dmvValidateReport_(input, spreadsheet);
    report.revision = previous ? previous.revision + 1 : 1;
    report.status = previous && !dmvPendingReport_(previous) ? previous.status : 'ready';
    ['lastRun', 'lastRowCount', 'lastError'].forEach(function (key) {
      if (previous && previous[key] !== undefined) report[key] = previous[key];
    });
    report.nextRunAt = report.schedule === 'manual' ? null : Date.now();
    dmvSave_('report', report);
    try {
      dmvEnsureSchedule_();
    } catch (error) {
      if (previous) dmvSave_('report', previous);
      else dmvStore_().deleteProperty(dmvKey_('report', report.id));
      throw new Error(
        'The refresh schedule could not be created. Check Google authorization and try again.'
      );
    }
    dmvClearContinuation_(report.id);
    return report;
  });
}

function dmvDeleteReport(id) {
  return dmvLocked_(function () {
    var report = dmvReportHere_(id);
    if (report.runToken && Date.now() - report.startedAt < 300000)
      throw new Error('Wait for the current refresh to finish.');
    dmvStore_().deleteProperty(dmvKey_('report', id));
    dmvStore_().deleteProperty(dmvOutputKey_(report.spreadsheetId, id));
    dmvClearContinuation_(id);
    dmvEnsureSchedule_();
    return { ok: true };
  });
}

function dmvDiscoverFields(input) {
  var connection = dmvRead_('connection', input.connectionId);
  var connector = dmvConnector_(connection.connectorId);
  var definition = dmvDefinition_(connector, input.reportType);
  if (!definition.discoverFields) return definition.fields || [];
  try {
    return definition.discoverFields(
      dmvContext_(
        connector,
        connection,
        { config: dmvFieldsInput_(definition.configFields, input.config), fields: [], maxRows: 20 },
        {}
      )
    );
  } catch (error) {
    throw new Error(dmvSafeError_(error, connection.credentials));
  }
}

function dmvReportDates_(definition, report, spreadsheet) {
  return definition.dateRange
    ? dmvDateRange_(
        report.dateRange,
        Utilities.formatDate(new Date(), spreadsheet.getSpreadsheetTimeZone(), 'yyyy-MM-dd')
      )
    : {};
}

function dmvFetchReport_(report, spreadsheet, deadline) {
  var connection = dmvRead_('connection', report.connectionId);
  var connector = dmvConnector_(connection.connectorId);
  var definition = dmvDefinition_(connector, report.reportType);
  var dates = dmvReportDates_(definition, report, spreadsheet);
  try {
    return dmvNormalizeResult_(
      definition.fetch(dmvContext_(connector, connection, report, dates, deadline)),
      report.maxRows
    );
  } catch (error) {
    throw new Error(dmvSafeError_(error, connection.credentials));
  }
}

function dmvPreviewReport(input) {
  var spreadsheet = dmvSpreadsheet_();
  var report = dmvValidateReport_(input, spreadsheet);
  var result = dmvFetchReport_(report, spreadsheet);
  return {
    columns: result.columns,
    rows: result.rows.slice(0, 20),
    totalRows: result.rows.length,
    metadata: result.metadata,
  };
}

function dmvRunReport(id) {
  return dmvExecuteReport_(dmvReportHere_(id));
}

function dmvExecuteReport_(requested) {
  var token = dmvId_(),
    connectionRevision;
  var report = dmvLocked_(function () {
    var current = dmvRead_('report', requested.id);
    if (current.runToken && Date.now() - current.startedAt < 300000)
      throw new Error('This report is already refreshing.');
    connectionRevision = dmvRead_('connection', current.connectionId).revision || 0;
    current.status = 'running';
    current.runToken = token;
    current.startedAt = Date.now();
    current.lastError = '';
    current.continuationRequested =
      typeof dmvDefinition_(dmvConnector_(current.connectorId), current.reportType).fetchChunk ===
      'function';
    if (current.continuationRequested) current.nextRunAt = Date.now();
    return dmvSave_('report', current);
  });
  try {
    var spreadsheet = SpreadsheetApp.openById(report.spreadsheetId);
    // Arm recovery before the first chunk, including for manual reports and abrupt termination.
    if (dmvPendingReport_(report)) dmvLocked_(dmvEnsureSchedule_);
    var result = dmvPendingReport_(report)
      ? dmvFetchContinued_(report, spreadsheet, token, connectionRevision)
      : dmvFetchReport_(report, spreadsheet);
    return dmvLocked_(function () {
      var current = dmvRead_('report', report.id);
      if (current.runToken !== token || current.revision !== report.revision)
        throw new Error('The report changed during the refresh. Run it again.');
      if ((dmvRead_('connection', current.connectionId).revision || 0) !== connectionRevision)
        throw new Error('The connection changed during the refresh. Run it again.');
      if (result.pending) {
        current.status = 'paused';
        current.runToken = null;
        current.nextRunAt = Date.now();
        dmvSave_('report', current);
        return {
          ok: true,
          pending: true,
          rowCount: result.rowCount,
          message:
            'Rows fetched so far. Existing output is unchanged. Resume now or wait for the hourly scheduler.',
        };
      }
      var warning = dmvWriteReport_(spreadsheet, current, result);
      current.status = 'success';
      current.lastRun = new Date().toISOString();
      current.lastRowCount = result.rows.length;
      current.lastError = '';
      current.runToken = null;
      delete current.continuation;
      delete current.continuationRequested;
      delete current.fetchedRowCount;
      current.nextRunAt = dmvNextRun_(current.schedule);
      dmvSave_('report', current);
      dmvFinishContinuation_(current.id);
      return {
        ok: true,
        rowCount: result.rows.length,
        updatedAt: current.lastRun,
        warning: warning,
        metadata: result.metadata,
      };
    });
  } catch (error) {
    var message = dmvSafeError_(error, {});
    dmvLocked_(function () {
      var current = dmvRead_('report', report.id);
      if (current.runToken === token) {
        current.status = 'error';
        current.lastError = message;
        current.runToken = null;
        delete current.continuation;
        delete current.continuationRequested;
        delete current.fetchedRowCount;
        current.nextRunAt = dmvNextRun_(current.schedule);
        dmvSave_('report', current);
        dmvFinishContinuation_(current.id);
      }
    });
    throw new Error(message);
  }
}

function dmvRefreshAll() {
  var spreadsheet = dmvSpreadsheet_();
  var reports = dmvList_('report').filter(function (report) {
    return report.spreadsheetId === spreadsheet.getId();
  });
  var result = [];
  var started = Date.now();
  for (var i = 0; i < reports.length; i++) {
    if (Date.now() - started > 45000) {
      result.push({
        id: reports[i].id,
        ok: false,
        message: 'Refresh individually to finish the remaining reports.',
      });
      break;
    }
    try {
      result.push({ id: reports[i].id, result: dmvExecuteReport_(reports[i]), ok: true });
    } catch (error) {
      result.push({ id: reports[i].id, ok: false, message: error.message });
    }
  }
  return result;
}
