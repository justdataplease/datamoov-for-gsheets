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

// Grid sizes and merged ranges of every tab, keyed by sheet id, from one metadata-only Sheets
// API request.
function dmvGridSizes_(spreadsheetId) {
  var response = Sheets.Spreadsheets.get(spreadsheetId, {
    fields: 'sheets(properties(sheetId,gridProperties(rowCount,columnCount)),merges)',
  });
  var grids = {};
  ((response && response.sheets) || []).forEach(function (item) {
    var properties = item.properties || {},
      grid = properties.gridProperties || {};
    if (properties.sheetId === undefined) return;
    grids[properties.sheetId] = {
      rows: Number(grid.rowCount) || 0,
      columns: Number(grid.columnCount) || 0,
      // As output areas: 1-based, sized. The API omits start indexes that are zero.
      merges: (item.merges || []).map(function (merge) {
        var row = merge.startRowIndex || 0,
          column = merge.startColumnIndex || 0;
        return {
          sheetId: properties.sheetId,
          row: row + 1,
          column: column + 1,
          rows: merge.endRowIndex - row,
          columns: merge.endColumnIndex - column,
        };
      }),
    };
  });
  return grids;
}

function dmvWriteReport_(spreadsheet, report, result) {
  return dmvWriteReports_(spreadsheet, [{ report: report, result: result }]);
}

// Every destination is verified before any tab creation, cell change or receipt update.
// extra(areas) may add requests (a dashboard's charts) to the same atomic batch; areas follow
// the output order and carry the sheet ids planned for new tabs.
function dmvWriteReports_(spreadsheet, outputs, beforeCommit, extra) {
  return dmvWorkbookLocked_(function () {
    return dmvWriteReportsUnlocked_(spreadsheet, outputs, beforeCommit, extra);
  });
}

function dmvWriteReportsUnlocked_(spreadsheet, outputs, beforeCommit, extra) {
  if (!Array.isArray(outputs) || !outputs.length || outputs.length > 10)
    throw new Error('Choose between one and ten report outputs.');
  // Two outputs sharing an id would share one ownership receipt and orphan the first area.
  if (
    outputs.some(function (output, index) {
      return outputs.some(function (other, otherIndex) {
        return otherIndex < index && other.report.id === output.report.id;
      });
    })
  )
    throw new Error('Every report output needs its own id.');
  var properties = dmvStore_();
  // An earlier write in this execution may have created tabs the caller's Spreadsheet object
  // has never seen; planning against it would try to create them a second time.
  spreadsheet = dmvReopen_(spreadsheet);
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
  if (extra) plan.requests = plan.requests.concat(extra(plan.areas) || []);
  if (JSON.stringify(plan.requests).length > DMV_LIMITS.maxBytes) {
    // Marked, so a caller that knows what grew (a dashboard page) can say so instead.
    var large = new Error(
      'These reports are too large for one Sheets write. Select fewer fields or rows.'
    );
    large.tooLarge = true;
    throw large;
  }
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
      maxColumns = Math.max(26, anchor.column + result.matrix[0].length - 1);
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
    // A later output on the same new tab must see the grid an earlier output already grew.
    sheetId = planned.id;
    maxRows = grids[sheetId].rows;
    maxColumns = grids[sheetId].columns;
    old = null;
  }
  var area = {
    sheetId: sheetId,
    row: anchor.row,
    column: anchor.column,
    rows: result.matrix.length,
    columns: result.matrix[0].length,
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
          'The output on tab "' +
            report.target.sheetName +
            '" overlaps another DataMoov report or dashboard. Choose another tab name or starting cell.'
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
          throw new Error(
            'The tab "' +
              report.target.sheetName +
              '" contains existing data where this output goes. Choose an empty area or a new tab name.'
          );
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
  // result.layout places a page in the output area. Rows and columns are 0-based, relative to
  // the area's first cell, and every range lies inside the area; all members are optional.
  //   tables       [{row, column?, rows, columns: [{type, pattern?}]}] a header row, typed columns
  //   styles       [{row, column?, rows?, columns?, style, type?, pattern?}] DMV_LAYOUT_STYLES
  //   columnWidths [px, ...] the area's columns from its first, set on every write
  //   rowHeights   [{row, rows?, height}] present (even empty): every row of the previous and the
  //                new area returns to 21px first, so rows that moved lose their old heights
  //   formats      [{row, column, rows?, columns?, format}] after tables and styles, in order;
  //                format: background and color (#rrggbb), bold, italic, fontSize, align
  //                (LEFT|CENTER|RIGHT), valign (TOP|MIDDLE|BOTTOM), wrap (CLIP|WRAP|
  //                OVERFLOW_CELL), numberFormat {type, pattern?}, padding {top?, right?, bottom?,
  //                left?} and link {row}, an internal link to that area row (never a URL)
  //   paints       [{row, column, background | color: [#rrggbb, ...]}] after the formats: one
  //                column's cells from row down, each given its own background or text colour,
  //                in one request instead of a format per cell
  //   borders      [{row, column, rows?, columns?, top?, bottom?, left?, right?, innerHorizontal?,
  //                innerVertical?}] each side {style: SOLID|SOLID_MEDIUM|SOLID_THICK|DOTTED|NONE,
  //                color}
  //   merges       [{row, column, rows, columns, type?: ALL|ROWS}] last; ROWS merges each row
  //                apart. Content only in the first cell (of each row for ROWS).
  // A pattern overrides the type's number format. Merges reaching into the previous or the new
  // area, and its formats (borders included), are removed first. Sizes apply to whole sheet rows
  // and columns.
  var layout = result.layout,
    merges = grids[sheetId].merges || [],
    // The merges this output makes, on the sheet's own 1-based grid.
    created = [];
  var list = function (name) {
    return layout[name] || [];
  };
  var size = function (dimension, start, count, pixels) {
    requests.push({
      updateDimensionProperties: {
        range: {
          sheetId: area.sheetId,
          dimension: dimension,
          startIndex: start - 1,
          endIndex: start - 1 + count,
        },
        properties: { pixelSize: pixels },
        fields: 'pixelSize',
      },
    });
  };
  if (layout) {
    Object.keys(layout).forEach(function (name) {
      if (DMV_LAYOUT_MEMBERS.indexOf(name) < 0 || !Array.isArray(layout[name]))
        throw new Error('Invalid layout member "' + name + '".');
    });
    // A layout owns the formats, merges and row heights of its previous and its new area.
    var span = {
      sheetId: area.sheetId,
      row: area.row,
      column: area.column,
      rows: Math.max(area.rows, old ? old.rows : 0),
      columns: Math.max(area.columns, old ? old.columns : 0),
    };
    // Sheets refuses a range that cuts through a merge. The merges reaching into the span go in
    // one request over the box that holds them all (a page merges every table row apart), or by
    // their exact ranges when that box would touch another merge, such as one an earlier output
    // of this batch just made. Each is removed once per batch.
    var gone = [];
    merges = merges.filter(function (merge) {
      if (!dmvRectanglesOverlap_(span, merge)) return true;
      gone.push(merge);
      return false;
    });
    if (gone.length) {
      var box = gone.reduce(function (around, merge) {
        var row = Math.min(around.row, merge.row),
          column = Math.min(around.column, merge.column);
        return {
          sheetId: area.sheetId,
          row: row,
          column: column,
          rows: Math.max(around.row + around.rows, merge.row + merge.rows) - row,
          columns: Math.max(around.column + around.columns, merge.column + merge.columns) - column,
        };
      });
      var single = !merges.concat(grids[sheetId].made || []).some(function (merge) {
        return dmvRectanglesOverlap_(box, merge);
      });
      (single ? [box] : gone).forEach(function (merge) {
        requests.push({
          unmergeCells: { range: range(merge.row, merge.column, merge.rows, merge.columns) },
        });
      });
    }
    // Blocks move between refreshes, so formats of the previous layout (borders and links
    // included) are cleared first.
    requests.push({
      repeatCell: {
        range: range(span.row, span.column, span.rows, span.columns),
        cell: {},
        fields: 'userEnteredFormat',
      },
    });
    var widths = list('columnWidths');
    if (widths.length > area.columns) throw new Error('Layout column widths exceed the output.');
    widths.forEach(function (width, index) {
      // Neighbouring columns of one width share a request.
      if (index && widths[index - 1] === width) return;
      var count = 1;
      while (widths[index + count] === width) count++;
      size('COLUMNS', area.column + index, count, dmvLayoutPixels_(width));
    });
    if (layout.rowHeights) {
      size('ROWS', area.row, span.rows, 21);
      layout.rowHeights.forEach(function (item) {
        var entry = dmvLayoutEntry_('row height', item, ['row', 'rows', 'height'], area);
        size('ROWS', area.row + entry.row, entry.rows, dmvLayoutPixels_(item.height));
      });
    }
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
  // The written values of an area-relative block.
  var values = function (row, column, rows, columns) {
    var found = [];
    result.matrix.slice(row, row + rows).forEach(function (line) {
      found.push.apply(found, line.slice(column, column + columns));
    });
    return found;
  };
  // Number patterns follow the written values: '#,##0.###' showed whole numbers as "2,494.".
  // An explicit pattern wins.
  var numberFormat = function (type, written, pattern) {
    if (pattern !== undefined)
      return {
        type: type === 'percent' ? 'PERCENT' : 'NUMBER',
        pattern: dmvLayoutPattern_(pattern),
      };
    if (type === 'number') {
      var numbers = written.filter(function (value) {
        return typeof value === 'number';
      });
      var whole = numbers.every(function (value) {
        return value % 1 === 0;
      });
      var small = numbers.every(function (value) {
        return Math.abs(value) < 1;
      });
      return { type: 'NUMBER', pattern: whole ? '#,##0' : small ? '0.0000' : '#,##0.00' };
    }
    return type === 'currency'
      ? { type: 'NUMBER', pattern: '#,##0.00' }
      : type === 'percent'
        ? { type: 'PERCENT', pattern: '0.00%' }
        : { type: 'TEXT', pattern: '@' };
  };
  // A table is a header row plus typed columns. An ordinary report is one table covering its
  // whole area; a laid-out page (result.layout) places several, plus styled text cells.
  var table = function (row, column, tableRows, columns) {
    requests.push({
      repeatCell: {
        range: range(area.row + row, area.column + column, 1, columns.length),
        cell: {
          userEnteredFormat: {
            textFormat: { bold: true },
            backgroundColor: { red: 0.93, green: 0.95, blue: 1 },
          },
        },
        fields: 'userEnteredFormat.textFormat.bold,userEnteredFormat.backgroundColor',
      },
    });
    if (tableRows > 1)
      columns.forEach(function (item, index) {
        var written = values(row + 1, column + index, tableRows - 1, 1);
        requests.push({
          repeatCell: {
            range: range(area.row + row + 1, area.column + column + index, tableRows - 1, 1),
            cell: {
              userEnteredFormat: { numberFormat: numberFormat(item.type, written, item.pattern) },
            },
            fields: 'userEnteredFormat.numberFormat',
          },
        });
      });
  };
  var block = function (entry) {
    return range(area.row + entry.row, area.column + entry.column, entry.rows, entry.columns);
  };
  if (layout) {
    list('tables').forEach(function (item) {
      var entry = dmvLayoutEntry_('table', item, ['row', 'column', 'rows', 'columns'], area);
      if (!Array.isArray(item.columns) || !item.columns.length || item.rows === undefined)
        throw new Error('Invalid layout table.');
      table(entry.row, entry.column, entry.rows, item.columns);
    });
    list('styles').forEach(function (item) {
      var entry = dmvLayoutEntry_(
        'style',
        item,
        ['row', 'column', 'rows', 'columns', 'style', 'type', 'pattern'],
        area
      );
      if (!Object.prototype.hasOwnProperty.call(DMV_LAYOUT_STYLES, item.style))
        throw new Error('Unknown layout style "' + item.style + '".');
      var format = { textFormat: DMV_LAYOUT_STYLES[item.style] };
      var fields = 'userEnteredFormat.textFormat';
      if (item.type || item.pattern !== undefined) {
        format.numberFormat = numberFormat(
          item.type,
          values(entry.row, entry.column, entry.rows, entry.columns),
          item.pattern
        );
        fields += ',userEnteredFormat.numberFormat';
      }
      requests.push({
        repeatCell: { range: block(entry), cell: { userEnteredFormat: format }, fields: fields },
      });
    });
    list('formats').forEach(function (item) {
      var entry = dmvLayoutEntry_(
        'format',
        item,
        ['row', 'column', 'rows', 'columns', 'format'],
        area
      );
      var format = dmvLayoutFormat_(item.format, area);
      requests.push({
        repeatCell: {
          range: block(entry),
          cell: { userEnteredFormat: format.cell },
          fields: format.fields,
        },
      });
    });
    list('paints').forEach(function (item) {
      var side = item && item.background !== undefined ? 'background' : 'color';
      var colors = item && item[side];
      if (
        !Array.isArray(colors) ||
        !colors.length ||
        (side === 'background' && item.color !== undefined)
      )
        throw new Error('Invalid layout paint.');
      var entry = dmvLayoutEntry_(
        'paint',
        { row: item.row, column: item.column, rows: colors.length },
        ['row', 'column', 'rows'],
        area
      );
      Object.keys(item).forEach(function (key) {
        if (['row', 'column', 'background', 'color'].indexOf(key) < 0)
          throw new Error('Unknown layout paint key "' + key + '".');
      });
      requests.push({
        updateCells: {
          range: block(entry),
          rows: colors.map(function (hex) {
            var color = dmvLayoutColor_(hex);
            return {
              values: [
                {
                  userEnteredFormat:
                    side === 'background'
                      ? { backgroundColor: color }
                      : { textFormat: { foregroundColor: color } },
                },
              ],
            };
          }),
          fields:
            side === 'background'
              ? 'userEnteredFormat.backgroundColor'
              : 'userEnteredFormat.textFormat.foregroundColor',
        },
      });
    });
    list('borders').forEach(function (item) {
      var entry = dmvLayoutEntry_(
        'border',
        item,
        ['row', 'column', 'rows', 'columns'].concat(DMV_LAYOUT_BORDER_SIDES),
        area
      );
      var borders = { range: block(entry) };
      DMV_LAYOUT_BORDER_SIDES.forEach(function (side) {
        if (item[side] !== undefined) borders[side] = dmvLayoutBorder_(item[side]);
      });
      requests.push({ updateBorders: borders });
    });
    var made = [];
    list('merges').forEach(function (item) {
      var entry = dmvLayoutEntry_(
        'merge',
        item,
        ['row', 'column', 'rows', 'columns', 'type'],
        area
      );
      var byRow = item.type === 'ROWS';
      if (
        (item.type !== undefined && item.type !== 'ALL' && !byRow) ||
        (entry.columns < 2 && (byRow || entry.rows < 2))
      )
        throw new Error('Invalid layout merge.');
      // Sheets keeps only the first cell of a merge (of each row for ROWS); content anywhere
      // else would vanish and break the next refresh's output digest.
      for (var r = 0; r < entry.rows; r++)
        for (var c = 0; c < entry.columns; c++)
          if ((c || (r && !byRow)) && result.matrix[entry.row + r][entry.column + c] !== '')
            throw new Error('Layout merges may hold content only in their first cell.');
      entry.sheetId = area.sheetId;
      if (
        made.some(function (other) {
          return dmvRectanglesOverlap_(entry, other);
        })
      )
        throw new Error('Layout merges overlap.');
      made.push(entry);
      created.push({
        sheetId: area.sheetId,
        row: area.row + entry.row,
        column: area.column + entry.column,
        rows: entry.rows,
        columns: entry.columns,
      });
      requests.push({
        mergeCells: { range: block(entry), mergeType: byRow ? 'MERGE_ROWS' : 'MERGE_ALL' },
      });
    });
  } else table(0, 0, area.rows, result.columns);
  plan.requests = plan.requests.concat(requests);
  plan.areas.push(area);
  plan.receipts.push({ key: key, area: area });
  grids[sheetId] = {
    rows: Math.max(lastRow, maxRows),
    columns: Math.max(lastColumn, maxColumns),
    merges: merges,
    made: (grids[sheetId].made || []).concat(created),
  };
}

var DMV_LAYOUT_STYLES = {
  title: { bold: true, fontSize: 16 },
  section: { bold: true, fontSize: 11 },
  muted: { foregroundColor: { red: 0.4, green: 0.4, blue: 0.4 }, fontSize: 9 },
  kpiLabel: { foregroundColor: { red: 0.4, green: 0.4, blue: 0.4 }, fontSize: 9 },
  kpiValue: { bold: true, fontSize: 18 },
};
var DMV_LAYOUT_MEMBERS = [
  'tables',
  'styles',
  'columnWidths',
  'rowHeights',
  'merges',
  'formats',
  'paints',
  'borders',
];
var DMV_LAYOUT_BORDER_SIDES = [
  'top',
  'bottom',
  'left',
  'right',
  'innerHorizontal',
  'innerVertical',
];
var DMV_LAYOUT_ALIGNMENTS = {
  align: ['horizontalAlignment', ['LEFT', 'CENTER', 'RIGHT']],
  valign: ['verticalAlignment', ['TOP', 'MIDDLE', 'BOTTOM']],
  wrap: ['wrapStrategy', ['CLIP', 'WRAP', 'OVERFLOW_CELL']],
};

// Layouts come from the runtime itself, so a malformed entry is a programming error. The
// checks stay cheap: known keys, whole numbers and a range inside the output area.
function dmvLayoutEntry_(name, item, keys, area) {
  if (!item || typeof item !== 'object' || Array.isArray(item))
    throw new Error('Invalid layout ' + name + '.');
  Object.keys(item).forEach(function (key) {
    if (keys.indexOf(key) < 0) throw new Error('Unknown layout ' + name + ' key "' + key + '".');
  });
  var entry = {
    row: item.row,
    column: item.column === undefined ? 0 : item.column,
    rows: item.rows === undefined ? 1 : item.rows,
    columns: Array.isArray(item.columns)
      ? item.columns.length
      : item.columns === undefined
        ? 1
        : item.columns,
  };
  if (
    !Number.isInteger(entry.row) ||
    !Number.isInteger(entry.column) ||
    !Number.isInteger(entry.rows) ||
    !Number.isInteger(entry.columns) ||
    entry.row < 0 ||
    entry.column < 0 ||
    entry.rows < 1 ||
    entry.columns < 1 ||
    entry.row + entry.rows > area.rows ||
    entry.column + entry.columns > area.columns
  )
    throw new Error('A layout ' + name + ' lies outside the output area.');
  return entry;
}

function dmvLayoutPixels_(value) {
  if (!Number.isInteger(value) || value < 2 || value > 2000)
    throw new Error('Use layout sizes of 2 to 2000 pixels.');
  return value;
}

function dmvLayoutPattern_(pattern) {
  if (typeof pattern !== 'string' || !pattern || pattern.length > 200)
    throw new Error('Invalid layout number pattern.');
  return pattern;
}

function dmvLayoutColor_(hex) {
  if (typeof hex !== 'string' || !/^#[0-9a-f]{6}$/i.test(hex))
    throw new Error('Use layout colors in #rrggbb form.');
  return {
    red: parseInt(hex.slice(1, 3), 16) / 255,
    green: parseInt(hex.slice(3, 5), 16) / 255,
    blue: parseInt(hex.slice(5, 7), 16) / 255,
  };
}

function dmvLayoutBorder_(side) {
  if (
    !side ||
    typeof side !== 'object' ||
    Object.keys(side).some(function (key) {
      return key !== 'style' && key !== 'color';
    }) ||
    ['SOLID', 'SOLID_MEDIUM', 'SOLID_THICK', 'DOTTED', 'NONE'].indexOf(side.style) < 0
  )
    throw new Error('Invalid layout border.');
  var border = { style: side.style };
  if (side.style !== 'NONE' || side.color !== undefined) border.color = dmvLayoutColor_(side.color);
  return border;
}

// One layout format as a CellFormat plus a field mask naming exactly what it sets, so formats
// applied in order only override what they mention.
function dmvLayoutFormat_(format, area) {
  if (!format || typeof format !== 'object' || !Object.keys(format).length)
    throw new Error('Invalid layout format.');
  var cell = {},
    fields = [];
  function set(path, value) {
    var parts = path.split('.'),
      node = cell;
    parts.slice(0, -1).forEach(function (part) {
      node = node[part] = node[part] || {};
    });
    node[parts[parts.length - 1]] = value;
    fields.push('userEnteredFormat.' + path);
  }
  function check(valid) {
    if (!valid) throw new Error('Invalid layout format.');
  }
  Object.keys(format).forEach(function (key) {
    var value = format[key],
      alignment = DMV_LAYOUT_ALIGNMENTS[key];
    if (key === 'background') set('backgroundColor', dmvLayoutColor_(value));
    else if (key === 'color') set('textFormat.foregroundColor', dmvLayoutColor_(value));
    else if (key === 'bold' || key === 'italic') {
      check(typeof value === 'boolean');
      set('textFormat.' + key, value);
    } else if (key === 'fontSize') {
      check(Number.isInteger(value) && value >= 1 && value <= 100);
      set('textFormat.fontSize', value);
    } else if (Object.prototype.hasOwnProperty.call(DMV_LAYOUT_ALIGNMENTS, key)) {
      check(alignment[1].indexOf(value) >= 0);
      set(alignment[0], value);
    } else if (key === 'numberFormat') {
      check(
        value &&
          [
            'NUMBER',
            'PERCENT',
            'CURRENCY',
            'DATE',
            'TIME',
            'DATE_TIME',
            'SCIENTIFIC',
            'TEXT',
          ].indexOf(value.type) >= 0 &&
          Object.keys(value).every(function (part) {
            return part === 'type' || part === 'pattern';
          })
      );
      set(
        'numberFormat',
        value.pattern === undefined
          ? { type: value.type }
          : { type: value.type, pattern: dmvLayoutPattern_(value.pattern) }
      );
    } else if (key === 'padding') {
      check(
        value &&
          typeof value === 'object' &&
          Object.keys(value).every(function (side) {
            return (
              ['top', 'right', 'bottom', 'left'].indexOf(side) >= 0 &&
              Number.isInteger(value[side]) &&
              value[side] >= 0 &&
              value[side] <= 200
            );
          })
      );
      set('padding', value);
    } else if (key === 'link') {
      // Only a link to a row of this page: layouts never carry external addresses.
      check(
        value &&
          Object.keys(value).join() === 'row' &&
          Number.isInteger(value.row) &&
          value.row >= 0 &&
          value.row < area.rows
      );
      set('textFormat.link', {
        uri: '#gid=' + area.sheetId + '&range=A' + (area.row + value.row),
      });
    } else throw new Error('Unknown layout format key "' + key + '".');
  });
  return { cell: cell, fields: fields.join(',') };
}

// A Sheets commit and private-property writes are separate services. A metadata-only journal
// lets a later refresh recover interrupted receipts only when the actual cells still match.
function dmvRecoverOutputJournal_(spreadsheet, properties) {
  var journalKey = 'dmv:v1:write-journal:' + spreadsheet.getId();
  var text = properties.getProperty(journalKey);
  if (!text) return;
  var journal = JSON.parse(text),
    sheets = spreadsheet.getSheets();
  if (!journal || !Array.isArray(journal.receipts) || journal.receipts.length > 10)
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
