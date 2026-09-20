/* Workbook-owned report recipes. Authentication, approvals and execution stay per user. */
var DMV_REPORT_SHEET = 'DataMoovReports';
var DMV_REPORT_SHEET_MARKER = 'DataMoov report definitions v1';
var DMV_REPORT_HEADERS = [
  'Report ID',
  'Name',
  'Source',
  'Report type',
  'Date preset',
  'Start date',
  'End date',
  'Fields (JSON)',
  'Options (JSON)',
  'Output tab',
  'Start cell',
  'Row limit',
  'Schema version',
];

function dmvReportSheetName_(name) {
  return String(name || '').toLowerCase() === DMV_REPORT_SHEET.toLowerCase();
}

// Sorted object keys make approval independent of JSON formatting and property order.
function dmvCanonical_(value) {
  if (Array.isArray(value)) return value.map(dmvCanonical_);
  if (value && typeof value === 'object') {
    var result = {};
    Object.keys(value)
      .sort()
      .forEach(function (key) {
        result[key] = dmvCanonical_(value[key]);
      });
    return result;
  }
  return value;
}

function dmvReportDefinition_(input, spreadsheet) {
  var id = input.definitionId || input.id;
  dmvKey_('definition', id);
  var query = dmvQuerySettings_(input, dmvConnector_(input.connectorId), spreadsheet);
  return {
    definitionId: id,
    name: dmvText_(input.name, 'Report name', 80, true),
    connectorId: query.connectorId,
    reportType: query.reportType,
    fields: query.fields,
    config: query.config,
    dateRange: query.dateRange,
    target: {
      sheetName: dmvSheetName_((input.target || {}).sheetName),
      startCell: dmvCell_((input.target || {}).startCell || 'A1').a1,
    },
    maxRows: query.maxRows,
  };
}

function dmvDefinitionFingerprint_(definition) {
  return dmvOutputDigest_(dmvCanonical_(definition));
}

function dmvDefinitionRow_(definition) {
  return [
    definition.definitionId,
    definition.name,
    definition.connectorId,
    definition.reportType,
    definition.dateRange.preset,
    definition.dateRange.startDate || '',
    definition.dateRange.endDate || '',
    JSON.stringify(definition.fields),
    JSON.stringify(definition.config),
    definition.target.sheetName,
    definition.target.startCell,
    definition.maxRows,
    1,
  ];
}

function dmvReadDefinitions_(spreadsheet) {
  var sheet = spreadsheet.getSheets().filter(function (item) {
    return dmvReportSheetName_(item.getName());
  })[0];
  if (!sheet) return { sheet: null, definitions: [] };
  var lastRow = sheet.getLastRow();
  if (
    lastRow < 2 ||
    lastRow > DMV_LIMITS.maxReports + 2 ||
    sheet.getMaxColumns() < DMV_REPORT_HEADERS.length
  )
    throw new Error(
      'DataMoovReports has an invalid layout. Restore its report-definition layout before continuing.'
    );
  var range = sheet.getRange(1, 1, lastRow, DMV_REPORT_HEADERS.length);
  var values = range.getValues();
  if (
    values[0][0] !== DMV_REPORT_SHEET_MARKER ||
    JSON.stringify(values[1]) !== JSON.stringify(DMV_REPORT_HEADERS)
  )
    throw new Error(
      'The DataMoovReports tab is not a supported report-definition sheet. Rename unrelated tabs; do not overwrite them.'
    );
  if (
    range.getFormulas().some(function (row) {
      return row.some(function (value) {
        return value !== '';
      });
    })
  )
    throw new Error(
      'DataMoovReports must contain literal settings, not formulas. Edit the report in the sidebar.'
    );
  var seen = Object.create(null);
  var definitions = [];
  values.slice(2).forEach(function (row, index) {
    if (
      row.every(function (value) {
        return value === '';
      })
    )
      return;
    try {
      if (Number(row[12]) !== 1) throw new Error('Unsupported schema version.');
      var fields = JSON.parse(row[7]);
      var config = JSON.parse(row[8]);
      if (!Array.isArray(fields) || !config || typeof config !== 'object' || Array.isArray(config))
        throw new Error('Fields must be a JSON array and options a JSON object.');
      var dates = { preset: String(row[4]) };
      if (dates.preset === 'custom') {
        dates.startDate = row[5];
        dates.endDate = row[6];
      }
      var definition = dmvReportDefinition_(
        {
          definitionId: row[0],
          name: row[1],
          connectorId: row[2],
          reportType: row[3],
          dateRange: dates,
          fields: fields,
          config: config,
          target: { sheetName: row[9], startCell: row[10] },
          maxRows: row[11],
        },
        spreadsheet
      );
      if (seen[definition.definitionId]) throw new Error('Duplicate report ID.');
      seen[definition.definitionId] = true;
      definitions.push(definition);
    } catch (error) {
      throw new Error(
        'DataMoovReports row ' +
          (index + 3) +
          ' is invalid. Check its source, report, dates, fields, options and destination.'
      );
    }
  });
  return { sheet: sheet, definitions: definitions };
}

// Called under the shared lock. Explicit stringValue also protects SQL/text starting with '='.
function dmvWriteDefinitions_(spreadsheet, stored, definitions) {
  if (definitions.length > DMV_LIMITS.maxReports)
    throw new Error(
      'Keep at most ' + DMV_LIMITS.maxReports + ' report definitions in this spreadsheet.'
    );
  var sheet = stored.sheet;
  var sheetId = sheet ? sheet.getSheetId() : Math.floor(Math.random() * 1000000000);
  if (!sheet) {
    var used = spreadsheet.getSheets().map(function (item) {
      return item.getSheetId();
    });
    while (used.indexOf(sheetId) >= 0) sheetId = Math.floor(Math.random() * 1000000000);
  }
  var matrix = [[DMV_REPORT_SHEET_MARKER]].concat(
    [DMV_REPORT_HEADERS],
    definitions.map(dmvDefinitionRow_)
  );
  var requests = [];
  if (!sheet)
    requests.push({
      addSheet: {
        properties: {
          sheetId: sheetId,
          title: DMV_REPORT_SHEET,
          hidden: true,
          gridProperties: {
            rowCount: DMV_LIMITS.maxReports + 2,
            columnCount: DMV_REPORT_HEADERS.length,
            frozenRowCount: 2,
          },
        },
      },
    });
  else if (sheet.getMaxRows() < matrix.length)
    requests.push({
      appendDimension: {
        sheetId: sheetId,
        dimension: 'ROWS',
        length: matrix.length - sheet.getMaxRows(),
      },
    });
  requests.push({
    updateCells: {
      range: {
        sheetId: sheetId,
        startRowIndex: 0,
        endRowIndex: Math.max(matrix.length, sheet ? sheet.getLastRow() : 0),
        startColumnIndex: 0,
        endColumnIndex: DMV_REPORT_HEADERS.length,
      },
      rows: matrix.map(function (row) {
        return {
          values: row.map(function (value) {
            return {
              userEnteredValue:
                typeof value === 'number' ? { numberValue: value } : { stringValue: String(value) },
            };
          }),
        };
      }),
      fields: 'userEnteredValue',
    },
  });
  requests.push({
    repeatCell: {
      range: { sheetId: sheetId, startRowIndex: 0, endRowIndex: 2 },
      cell: { userEnteredFormat: { textFormat: { bold: true } } },
      fields: 'userEnteredFormat.textFormat.bold',
    },
  });
  Sheets.Spreadsheets.batchUpdate({ requests: requests }, spreadsheet.getId());
  SpreadsheetApp.flush();
}

function dmvFindDefinition_(stored, id) {
  return (
    stored.definitions.filter(function (definition) {
      return definition.definitionId === id;
    })[0] || null
  );
}

function dmvDefinitionApprovalError_() {
  var error = new Error(
    'Report settings changed or were removed. Open the report in the sidebar, review its settings and save before refreshing.'
  );
  error.dmvApprovalRequired = true;
  return error;
}

function dmvCheckReportDefinition_(report, spreadsheet) {
  if (!report.definitionId) return; // An already-running legacy report may finish before migration.
  var definition;
  try {
    definition = dmvFindDefinition_(dmvReadDefinitions_(spreadsheet), report.definitionId);
  } catch (error) {
    throw new Error(
      'Report definitions could not be read. Open Manage report definitions and repair the settings sheet before refreshing.'
    );
  }
  if (!definition || dmvDefinitionFingerprint_(definition) !== report.definitionFingerprint)
    throw dmvDefinitionApprovalError_();
  // Validate the shared recipe against this user's explicitly chosen connection every execution.
  dmvValidateReport_(
    Object.assign({}, definition, {
      id: report.id,
      connectionId: report.connectionId,
      schedule: report.schedule,
    }),
    spreadsheet
  );
}

// Existing private IDs are retained, including receipt/checkpoint identity. An interrupted migration
// can adopt an identical row on retry; shared changes are never overwritten by migration.
function dmvMigrateReports_(spreadsheet) {
  return dmvLocked_(function () {
    var legacy = dmvList_('report').filter(function (report) {
      return (
        report.spreadsheetId === spreadsheet.getId() &&
        !report.definitionId &&
        !dmvPendingReport_(report) &&
        !(report.runToken && Date.now() - report.startedAt < 300000)
      );
    });
    if (!legacy.length) return;
    return dmvWorkbookLocked_(function () {
      var stored = dmvReadDefinitions_(spreadsheet);
      var next = stored.definitions.slice();
      var records = legacy.map(function (report) {
        var definition = dmvReportDefinition_(report, spreadsheet);
        var fingerprint = dmvDefinitionFingerprint_(definition);
        var existing = dmvFindDefinition_({ definitions: next }, definition.definitionId);
        if (existing && dmvDefinitionFingerprint_(existing) !== fingerprint)
          throw new Error(
            'An existing workbook report differs from its private version. Resolve the report definition before migration.'
          );
        if (!existing) next.push(definition);
        var migrated = Object.assign({}, report, {
          definitionId: definition.definitionId,
          definitionFingerprint: fingerprint,
        });
        dmvCheckRecordSize_(migrated);
        return migrated;
      });
      if (next.length !== stored.definitions.length)
        dmvWriteDefinitions_(spreadsheet, stored, next);
      records.forEach(function (report) {
        dmvSave_('report', report);
      });
    });
  });
}

function dmvReportSummary_(definition, binding, spreadsheet) {
  var fingerprint = dmvDefinitionFingerprint_(definition);
  var connection =
    binding &&
    dmvList_('connection').some(function (item) {
      return item.id === binding.connectionId && item.connectorId === definition.connectorId;
    });
  var approvalRequired =
    !!binding && (binding.definitionFingerprint !== fingerprint || !!binding.approvalRequired);
  var summary = Object.assign({}, definition, {
    id: binding ? binding.id : null,
    spreadsheetId: spreadsheet.getId(),
    definitionFingerprint: fingerprint,
    connectionId: connection ? binding.connectionId : '',
    schedule: connection && !approvalRequired ? binding.schedule : 'manual',
    connectionRequired: !connection,
    approvalRequired: approvalRequired,
    status: !connection ? 'needs_connection' : approvalRequired ? 'needs_review' : binding.status,
  });
  if (binding)
    ['lastRun', 'lastRowCount', 'lastError', 'fetchedRowCount', 'continuationRequested'].forEach(
      function (key) {
        if (binding[key] !== undefined) summary[key] = binding[key];
      }
    );
  return summary;
}

function dmvWorkbookReports_(spreadsheet) {
  dmvMigrateReports_(spreadsheet);
  var stored = dmvReadDefinitions_(spreadsheet);
  var bindings = dmvList_('report').filter(function (report) {
    return report.spreadsheetId === spreadsheet.getId();
  });
  return stored.definitions
    .map(function (definition) {
      var binding = bindings.filter(function (report) {
        return report.definitionId === definition.definitionId;
      })[0];
      return dmvReportSummary_(definition, binding, spreadsheet);
    })
    .concat(
      bindings.filter(function (report) {
        return !report.definitionId;
      })
    )
    .concat(
      bindings
        .filter(function (report) {
          return report.definitionId && !dmvFindDefinition_(stored, report.definitionId);
        })
        .map(function (report) {
          return Object.assign({}, report, {
            definitionMissing: true,
            approvalRequired: true,
            connectionRequired: false,
            status: 'needs_review',
            schedule: 'manual',
          });
        })
    );
}

function dmvManageReportDefinitions() {
  var spreadsheet = dmvSpreadsheet_();
  var existing = spreadsheet.getSheets().filter(function (item) {
    return dmvReportSheetName_(item.getName());
  })[0];
  if (existing) {
    existing.showSheet();
    spreadsheet.setActiveSheet(existing);
    return;
  }
  dmvMigrateReports_(spreadsheet);
  dmvWorkbookLocked_(function () {
    var stored = dmvReadDefinitions_(spreadsheet);
    if (!stored.sheet) dmvWriteDefinitions_(spreadsheet, stored, []);
  });
  var sheet = dmvReadDefinitions_(spreadsheet).sheet;
  sheet.showSheet();
  spreadsheet.setActiveSheet(sheet);
}
