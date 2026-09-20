/* Sheets output: ownership receipt, overlap checks and one atomic batchUpdate. */
function dmvOutputDigest_(matrix) {
  var bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    JSON.stringify(matrix),
    Utilities.Charset.UTF_8
  );
  return bytes
    .map(function (byte) {
      return ('0' + ((byte + 256) % 256).toString(16)).slice(-2);
    })
    .join('');
}

// Grid sizes of every tab, keyed by sheet id, from one metadata-only Sheets API request.
function dmvGridSizes_(spreadsheetId) {
  var response = Sheets.Spreadsheets.get(spreadsheetId, {
    fields: 'sheets.properties(sheetId,gridProperties(rowCount,columnCount))',
  });
  var grids = {};
  ((response && response.sheets) || []).forEach(function (item) {
    var properties = item.properties || {},
      grid = properties.gridProperties || {};
    if (properties.sheetId === undefined) return;
    grids[properties.sheetId] = {
      rows: Number(grid.rowCount) || 0,
      columns: Number(grid.columnCount) || 0,
    };
  });
  return grids;
}

function dmvWriteReport_(spreadsheet, report, result) {
  return dmvWriteReports_(spreadsheet, [{ report: report, result: result }]);
}

// Every destination is verified before any tab creation, cell change or receipt update.
function dmvWriteReports_(spreadsheet, outputs, beforeCommit) {
  return dmvWorkbookLocked_(function () {
    return dmvWriteReportsUnlocked_(spreadsheet, outputs, beforeCommit);
  });
}

function dmvWriteReportsUnlocked_(spreadsheet, outputs, beforeCommit) {
  if (!Array.isArray(outputs) || !outputs.length || outputs.length > 8)
    throw new Error('Choose between one and eight report outputs.');
  var properties = dmvStore_();
  dmvRecoverOutputJournal_(spreadsheet, properties);
  var physicalGrids = dmvGridSizes_(spreadsheet.getId());
  var plan = {
    grids: JSON.parse(JSON.stringify(physicalGrids)),
    physicalGrids: physicalGrids,
    all: properties.getProperties(),
    newSheets: Object.create(null),
    areas: [],
    receipts: [],
    requests: [],
  };
  outputs.forEach(function (output) {
    dmvSheetName_(output.report.target.sheetName);
    dmvPrepareReportWrite_(spreadsheet, output.report, output.result, plan);
  });
  if (JSON.stringify(plan.requests).length > DMV_LIMITS.maxBytes)
    throw new Error(
      'These reports are too large for one Sheets write. Select fewer fields or rows.'
    );
  if (beforeCommit) beforeCommit();
  var journalKey = 'dmv:v1:write-journal:' + spreadsheet.getId();
  properties.setProperty(journalKey, dmvCheckRecordSize_({ receipts: plan.receipts }));
  Sheets.Spreadsheets.batchUpdate({ requests: plan.requests }, spreadsheet.getId());
  try {
    plan.receipts.forEach(function (receipt) {
      properties.setProperty(receipt.key, JSON.stringify(receipt.area));
    });
  } catch (error) {
    var failure = new Error(
      'The output tabs were updated, but their ownership receipts could not be saved. Refresh again to recover the receipts and retry safely.'
    );
    failure.sheetUpdated = true;
    throw failure;
  }
  try {
    properties.deleteProperty(journalKey);
  } catch (ignored) {
    /* Completed receipts can be recovered again harmlessly. */
  }
  return '';
}

function dmvPrepareReportWrite_(spreadsheet, report, result, plan) {
  var sheet = spreadsheet.getSheetByName(report.target.sheetName);
  var anchor = dmvCell_(report.target.startCell);
  var key = dmvOutputKey_(report.spreadsheetId, report.id);
  var old = JSON.parse(plan.all[key] || 'null');
  var grids = plan.grids,
    sheetId,
    maxRows,
    maxColumns;
  if (sheet) {
    sheetId = sheet.getSheetId();
    if (!grids[sheetId]) throw new Error('The output tab could not be read. Try again.');
    maxRows = grids[sheetId].rows;
    maxColumns = grids[sheetId].columns;
  } else {
    var planned = plan.newSheets[report.target.sheetName];
    if (!planned) {
      sheetId = parseInt(dmvOutputDigest_(Utilities.getUuid()).slice(0, 7), 16);
      while (grids[sheetId]) sheetId++;
      maxRows = Math.max(1000, anchor.row + result.matrix.length - 1);
      maxColumns = Math.max(26, anchor.column + result.columns.length - 1);
      planned = { id: sheetId, rows: maxRows, columns: maxColumns };
      plan.newSheets[report.target.sheetName] = planned;
      grids[sheetId] = { rows: maxRows, columns: maxColumns };
      plan.requests.push({
        addSheet: {
          properties: {
            sheetId: sheetId,
            title: report.target.sheetName,
            gridProperties: { rowCount: maxRows, columnCount: maxColumns },
          },
        },
      });
    }
    sheetId = planned.id;
    maxRows = planned.rows;
    maxColumns = planned.columns;
    old = null;
  }
  var area = {
    sheetId: sheetId,
    row: anchor.row,
    column: anchor.column,
    rows: result.matrix.length,
    columns: result.columns.length,
  };
  if (old && (old.sheetId !== area.sheetId || old.row !== area.row || old.column !== area.column))
    old = null;
  if (old) {
    var ownershipError =
      'The previous report output was edited or moved. Choose a new empty output area before refreshing.';
    if (
      !old.digest ||
      old.row + old.rows - 1 > maxRows ||
      old.column + old.columns - 1 > maxColumns
    )
      throw new Error(ownershipError);
    var previousRange = sheet.getRange(old.row, old.column, old.rows, old.columns);
    var previousValues = previousRange.getValues(),
      previousFormulas = previousRange.getFormulas();
    if (
      previousFormulas.some(function (row) {
        return row.some(function (formula) {
          return formula !== '';
        });
      }) ||
      dmvOutputDigest_(previousValues) !== old.digest
    )
      throw new Error(ownershipError);
  }
  var all = plan.all;
  Object.keys(all)
    .filter(function (other) {
      return other.indexOf(dmvOutputKey_(report.spreadsheetId, '')) === 0 && other !== key;
    })
    .forEach(function (other) {
      if (dmvRectanglesOverlap_(area, JSON.parse(all[other])))
        throw new Error(
          'This output overlaps another DataMoov report. Choose another starting cell.'
        );
    });
  plan.areas.forEach(function (other) {
    if (dmvRectanglesOverlap_(area, other))
      throw new Error('Dashboard outputs overlap. Choose distinct output tabs or ranges.');
  });
  var lastRow = area.row + area.rows - 1;
  var lastColumn = area.column + area.columns - 1;
  var totalCells = Object.keys(grids).reduce(function (sum, id) {
    return sum + grids[id].rows * grids[id].columns;
  }, 0);
  var neededCells =
    Math.max(lastRow, maxRows) * Math.max(lastColumn, maxColumns) - maxRows * maxColumns;
  if (totalCells + neededCells > 10000000)
    throw new Error(
      'The report would exceed this spreadsheet cell capacity. Choose a smaller report.'
    );
  var physical = plan.physicalGrids[sheetId] || { rows: 0, columns: 0 };
  var readRows = Math.min(area.rows, Math.max(0, physical.rows - area.row + 1));
  var readColumns = Math.min(area.columns, Math.max(0, physical.columns - area.column + 1));
  if (sheet && readRows && readColumns) {
    var existingRange = sheet.getRange(area.row, area.column, readRows, readColumns);
    var existing = existingRange.getValues(),
      formulas = existingRange.getFormulas();
    for (var r = 0; r < readRows; r++)
      for (var c = 0; c < readColumns; c++) {
        var owned = old && r < old.rows && c < old.columns;
        if (!owned && (existing[r][c] !== '' || formulas[r][c] !== ''))
          throw new Error('The output contains existing data. Choose an empty area or a new tab.');
      }
  }
  var range = function (row, column, rows, columns) {
    return {
      sheetId: area.sheetId,
      startRowIndex: row - 1,
      endRowIndex: row - 1 + rows,
      startColumnIndex: column - 1,
      endColumnIndex: column - 1 + columns,
    };
  };
  var requests = [];
  if (lastRow > maxRows || lastColumn > maxColumns) {
    requests.push({
      updateSheetProperties: {
        properties: {
          sheetId: area.sheetId,
          gridProperties: {
            rowCount: Math.max(lastRow, maxRows),
            columnCount: Math.max(lastColumn, maxColumns),
          },
        },
        fields: 'gridProperties.rowCount,gridProperties.columnCount',
      },
    });
  }
  // Normalize once: validation, output hashing and cell writes use the same typed values.
  var rows = result.matrix.map(function (row) {
    return {
      values: row.map(function (value) {
        if (value === '') return {};
        if (typeof value === 'number') return { userEnteredValue: { numberValue: value } };
        if (typeof value === 'boolean') return { userEnteredValue: { boolValue: value } };
        return { userEnteredValue: { stringValue: value } };
      }),
    };
  });
  area.digest = dmvOutputDigest_(result.matrix);
  area.writtenAt = Date.now();
  requests.push({
    updateCells: {
      range: range(area.row, area.column, area.rows, area.columns),
      rows: rows,
      fields: 'userEnteredValue',
    },
  });
  if (old && old.rows > area.rows)
    requests.push({
      updateCells: {
        range: range(area.row + area.rows, area.column, old.rows - area.rows, old.columns),
        rows: [],
        fields: 'userEnteredValue',
      },
    });
  if (old && old.columns > area.columns)
    requests.push({
      updateCells: {
        range: range(
          area.row,
          area.column + area.columns,
          Math.min(old.rows, area.rows),
          old.columns - area.columns
        ),
        rows: [],
        fields: 'userEnteredValue',
      },
    });
  requests.push({
    repeatCell: {
      range: range(area.row, area.column, 1, area.columns),
      cell: {
        userEnteredFormat: {
          textFormat: { bold: true },
          backgroundColor: { red: 0.93, green: 0.95, blue: 1 },
        },
      },
      fields: 'userEnteredFormat.textFormat.bold,userEnteredFormat.backgroundColor',
    },
  });
  if (area.rows > 1)
    result.columns.forEach(function (column, index) {
      var format =
        column.type === 'number'
          ? { type: 'NUMBER', pattern: '#,##0.###' }
          : column.type === 'currency'
            ? { type: 'NUMBER', pattern: '#,##0.00' }
            : column.type === 'percent'
              ? { type: 'PERCENT', pattern: '0.00%' }
              : { type: 'TEXT', pattern: '@' };
      requests.push({
        repeatCell: {
          range: range(area.row + 1, area.column + index, area.rows - 1, 1),
          cell: { userEnteredFormat: { numberFormat: format } },
          fields: 'userEnteredFormat.numberFormat',
        },
      });
    });
  plan.requests = plan.requests.concat(requests);
  plan.areas.push(area);
  plan.receipts.push({ key: key, area: area });
  grids[sheetId] = { rows: Math.max(lastRow, maxRows), columns: Math.max(lastColumn, maxColumns) };
}

// A Sheets commit and private-property writes are separate services. A metadata-only journal
// lets a later refresh recover interrupted receipts only when the actual cells still match.
function dmvRecoverOutputJournal_(spreadsheet, properties) {
  var journalKey = 'dmv:v1:write-journal:' + spreadsheet.getId();
  var text = properties.getProperty(journalKey);
  if (!text) return;
  var journal = JSON.parse(text),
    sheets = spreadsheet.getSheets();
  if (!journal || !Array.isArray(journal.receipts) || journal.receipts.length > 8)
    throw new Error('The output ownership journal is invalid. Choose a new output area.');
  journal.receipts.forEach(function (receipt) {
    var area = receipt.area;
    if (
      !area ||
      typeof receipt.key !== 'string' ||
      receipt.key.indexOf(dmvOutputKey_(spreadsheet.getId(), '')) !== 0
    )
      throw new Error('The output ownership journal is invalid.');
    var sheet = sheets.filter(function (item) {
      return item.getSheetId() === area.sheetId;
    })[0];
    if (
      !sheet ||
      area.row + area.rows - 1 > sheet.getMaxRows() ||
      area.column + area.columns - 1 > sheet.getMaxColumns()
    )
      return;
    var range = sheet.getRange(area.row, area.column, area.rows, area.columns);
    if (
      range.getFormulas().some(function (row) {
        return row.some(function (value) {
          return value !== '';
        });
      })
    )
      return;
    if (dmvOutputDigest_(range.getValues()) === area.digest)
      properties.setProperty(receipt.key, JSON.stringify(area));
  });
  try {
    properties.deleteProperty(journalKey);
  } catch (ignored) {
    /* All matching receipts were committed. */
  }
}
