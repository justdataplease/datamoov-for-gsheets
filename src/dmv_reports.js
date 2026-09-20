/* Report definitions, previews and execution. Called from the sidebar and the scheduler. */
function dmvBootstrap() {
  var spreadsheet = dmvSpreadsheet_();
  var active = spreadsheet.getActiveRange();
  var targetIsEmpty =
    active &&
    !dmvReportSheetName_(active.getSheet().getName()) &&
    active.getCell(1, 1).getValues()[0][0] === '' &&
    active.getCell(1, 1).getFormulas()[0][0] === '';
  var fallbackName = 'DataMoov report',
    suffix = 2;
  while (spreadsheet.getSheetByName(fallbackName)) fallbackName = 'DataMoov report ' + suffix++;
  return {
    branding: { name: 'DataMoov', version: '1.0 beta' },
    catalog: dmvCatalog_(),
    connections: dmvList_('connection').map(dmvConnectionSummary_),
    credentials: dmvCredentialSummaries_(),
    credentialFamilies: dmvFamilyCatalog_(),
    reports: dmvWorkbookReports_(spreadsheet),
    dashboards: dmvListDashboards(),
    sheetNames: spreadsheet
      .getSheets()
      .filter(function (sheet) {
        return !dmvReportSheetName_(sheet.getName());
      })
      .map(function (sheet) {
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
  var query = dmvQuerySettings_(input, connector, spreadsheet);
  query.connectionId = connection.id;
  return query;
}

function dmvQuerySettings_(input, connector, spreadsheet) {
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
  var requestedDates = input.dateRange || { preset: 'last30' };
  var dateRange = { preset: requestedDates.preset || 'last30' };
  if (dateRange.preset === 'custom') {
    dateRange.startDate = requestedDates.startDate;
    dateRange.endDate = requestedDates.endDate;
  }
  if (definition.dateRange)
    dmvDateRange_(
      dateRange,
      Utilities.formatDate(new Date(), spreadsheet.getSpreadsheetTimeZone(), 'yyyy-MM-dd')
    );
  return {
    connectorId: connector.id,
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
  if (dmvReportSheetName_(sheetName))
    throw new Error('DataMoovReports is reserved for report settings. Choose another output tab.');
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
  input = input || {};
  return dmvLocked_(function () {
    var spreadsheet = dmvSpreadsheet_();
    dmvMigrateReports_(spreadsheet);
    var previous = input.id ? dmvReportHere_(input.id) : null;
    if (!previous && input.definitionId)
      previous =
        dmvList_('report').filter(function (report) {
          return (
            report.spreadsheetId === spreadsheet.getId() &&
            report.definitionId === input.definitionId
          );
        })[0] || null;
    if (
      previous &&
      input.definitionId &&
      previous.definitionId &&
      input.definitionId !== previous.definitionId
    )
      throw new Error('This report does not match the selected workbook definition.');
    if (previous && previous.runToken && Date.now() - previous.startedAt < 300000)
      throw new Error('Wait for the current refresh to finish before editing this report.');
    if (!previous && dmvList_('report').length >= DMV_LIMITS.maxReports)
      throw new Error('Keep at most ' + DMV_LIMITS.maxReports + ' connected reports in this app.');
    var report = dmvValidateReport_(
      Object.assign({}, input, { id: previous ? previous.id : undefined }),
      spreadsheet
    );
    report.definitionId = (previous && previous.definitionId) || input.definitionId || report.id;
    var definition = dmvReportDefinition_(report, spreadsheet);
    report.definitionFingerprint = dmvDefinitionFingerprint_(definition);
    report.revision = previous ? (previous.revision || 0) + 1 : 1;
    report.status = 'ready';
    ['lastRun', 'lastRowCount'].forEach(function (key) {
      if (previous && previous[key] !== undefined) report[key] = previous[key];
    });
    report.lastError = '';
    report.nextRunAt = report.schedule === 'manual' ? null : Date.now();
    dmvCheckRecordSize_(report);
    return dmvWorkbookLocked_(function () {
      var stored = dmvReadDefinitions_(spreadsheet);
      var existing = dmvFindDefinition_(stored, report.definitionId);
      if (existing && input.definitionFingerprint !== dmvDefinitionFingerprint_(existing))
        throw new Error(
          'Report settings changed since you opened the editor. Reopen the report before saving.'
        );
      if (!existing && input.definitionId)
        throw new Error('This workbook report no longer exists. Refresh the sidebar.');
      var next = stored.definitions.filter(function (item) {
        return item.definitionId !== report.definitionId;
      });
      next.push(definition);
      dmvWriteDefinitions_(spreadsheet, stored, next);
      try {
        dmvSave_('report', report);
        dmvEnsureSchedule_();
      } catch (error) {
        if (previous) dmvSave_('report', previous);
        else dmvStore_().deleteProperty(dmvKey_('report', report.id));
        dmvWriteDefinitions_(spreadsheet, dmvReadDefinitions_(spreadsheet), stored.definitions);
        throw new Error(
          'The report could not be saved with its refresh schedule. Check Google authorization and try again.'
        );
      }
      dmvClearContinuation_(report.id);
      return dmvReportSummary_(definition, report, spreadsheet);
    });
  });
}

function dmvDeleteReport(input) {
  return dmvLocked_(function () {
    var spreadsheet = dmvSpreadsheet_();
    var legacyRequest = typeof input === 'string';
    input = legacyRequest ? { id: input } : input || {};
    var report = input.id ? dmvReportHere_(input.id) : null;
    if (report && report.runToken && Date.now() - report.startedAt < 300000)
      throw new Error('Wait for the current refresh to finish.');
    var definitionId = input.definitionId || (report && report.definitionId);
    if (report && report.definitionId && report.definitionId !== definitionId)
      throw new Error('This report does not match the selected workbook definition.');
    if (definitionId)
      dmvWorkbookLocked_(function () {
        var stored = dmvReadDefinitions_(spreadsheet);
        var existing = dmvFindDefinition_(stored, definitionId);
        if (!existing && report) return; // Remove this user's orphaned binding without changing output.
        if (!existing)
          throw new Error('This workbook report no longer exists. Refresh the sidebar.');
        var expected =
          legacyRequest && report ? report.definitionFingerprint : input.definitionFingerprint;
        if (expected !== dmvDefinitionFingerprint_(existing))
          throw new Error(
            'Report settings changed. Refresh the sidebar before removing the report.'
          );
        dmvWriteDefinitions_(
          spreadsheet,
          stored,
          stored.definitions.filter(function (item) {
            return item.definitionId !== definitionId;
          })
        );
      });
    if (report) {
      dmvStore_().deleteProperty(dmvKey_('report', report.id));
      dmvStore_().deleteProperty(dmvOutputKey_(report.spreadsheetId, report.id));
      dmvClearContinuation_(report.id);
    }
    dmvEnsureSchedule_();
    return { ok: true };
  });
}

function dmvDiscoverFields(input) {
  var connection = dmvReadConnection_(input.connectionId);
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
  var connection = dmvReadConnection_(report.connectionId);
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
    var workbook = SpreadsheetApp.openById(current.spreadsheetId);
    dmvValidateReport_(current, workbook);
    try {
      dmvCheckReportDefinition_(current, workbook);
    } catch (error) {
      if (error.dmvApprovalRequired) {
        current.approvalRequired = true;
        current.status = 'needs_review';
        current.lastError = error.message;
        current.nextRunAt = null;
        delete current.continuation;
        delete current.continuationRequested;
        delete current.fetchedRowCount;
        dmvSave_('report', current);
        dmvClearContinuation_(current.id);
      }
      throw error;
    }
    connectionRevision = dmvConnectionRevision_(dmvReadConnection_(current.connectionId));
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
      dmvCheckReportDefinition_(current, spreadsheet);
      if (dmvConnectionRevision_(dmvReadConnection_(current.connectionId)) !== connectionRevision)
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
        current.status = error.dmvApprovalRequired ? 'needs_review' : 'error';
        current.approvalRequired = !!error.dmvApprovalRequired;
        current.lastError = message;
        current.runToken = null;
        delete current.continuation;
        delete current.continuationRequested;
        delete current.fetchedRowCount;
        current.nextRunAt = current.approvalRequired ? null : dmvNextRun_(current.schedule);
        dmvSave_('report', current);
        dmvFinishContinuation_(current.id);
      }
    });
    throw new Error(message);
  }
}

function dmvRefreshAll() {
  var spreadsheet = dmvSpreadsheet_();
  var reports = dmvWorkbookReports_(spreadsheet).filter(function (report) {
    return report.id && !report.connectionRequired && !report.approvalRequired;
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
