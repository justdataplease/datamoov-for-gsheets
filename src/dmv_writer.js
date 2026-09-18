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

function dmvWriteReport_(spreadsheet, report, result) {
  var sheet = spreadsheet.getSheetByName(report.target.sheetName);
  var anchor = dmvCell_(report.target.startCell);
  var properties = dmvStore_();
  var key = dmvOutputKey_(report.spreadsheetId, report.id);
  var old = JSON.parse(properties.getProperty(key) || 'null');
  if (!sheet) sheet = spreadsheet.insertSheet(report.target.sheetName);
  // Read the grid size once; each SpreadsheetApp getter is a round trip.
  var maxRows = sheet.getMaxRows(),
    maxColumns = sheet.getMaxColumns();
  var area = {
    sheetId: sheet.getSheetId(),
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
  var all = properties.getProperties();
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
  var lastRow = area.row + area.rows - 1;
  var lastColumn = area.column + area.columns - 1;
  var totalCells = spreadsheet.getSheets().reduce(function (sum, item) {
    return sum + item.getMaxRows() * item.getMaxColumns();
  }, 0);
  var neededCells =
    Math.max(lastRow, maxRows) * Math.max(lastColumn, maxColumns) - maxRows * maxColumns;
  if (totalCells + neededCells > 10000000)
    throw new Error(
      'The report would exceed this spreadsheet cell capacity. Choose a smaller report.'
    );
  var readRows = Math.min(area.rows, Math.max(0, maxRows - area.row + 1));
  var readColumns = Math.min(area.columns, Math.max(0, maxColumns - area.column + 1));
  if (readRows && readColumns) {
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
  if (JSON.stringify(requests).length > DMV_LIMITS.maxBytes)
    throw new Error('This report is too large for one Sheets write. Select fewer fields or rows.');
  // Google validates and applies the write, old-tail clearing and formatting together.
  // Explicit stringValue retains text IDs and never interprets API text as formulas.
  Sheets.Spreadsheets.batchUpdate({ requests: requests }, spreadsheet.getId());
  properties.setProperty(key, JSON.stringify(area));
  return '';
}
