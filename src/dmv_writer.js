/* Sheets output: ownership receipt, output record, overlap checks and one atomic batchUpdate,
   with the rows of rewritten outputs past its size limit in the batches after it. */
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

// The UTF-8 bytes of a text, as the Sheets API counts a request: a character beyond ASCII takes
// two or three, a pair of surrogates four.
function dmvUtf8Bytes_(text) {
  if (!/[^\x00-\x7f]/.test(text)) return text.length;
  var bytes = text.length;
  for (var at = 0; at < text.length; at++) {
    var code = text.charCodeAt(at);
    if (code > 0x7f) bytes += code > 0x7ff && (code < 0xd800 || code > 0xdfff) ? 2 : 1;
  }
  return bytes;
}

// A cell the writer enters as a formula. Only the app makes one: values from a source are text,
// numbers or booleans by then (dmvSheetValue_), so text that looks like a formula stays text.
function DmvFormula_(text) {
  if (typeof text !== 'string' || text.charAt(0) !== '=')
    throw new Error('A formula starts with =.');
  this.formula = text;
}

// A matrix row as Sheets cells: a formula, a number, a boolean, text, or nothing for ''.
function dmvOutputRow_(row) {
  return {
    values: row.map(function (value) {
      if (value === '') return {};
      if (value instanceof DmvFormula_)
        return { userEnteredValue: { formulaValue: value.formula } };
      if (typeof value === 'number') return { userEnteredValue: { numberValue: value } };
      if (typeof value === 'boolean') return { userEnteredValue: { boolValue: value } };
      return { userEnteredValue: { stringValue: value } };
    }),
  };
}

// An area's cells as entered: a formula's text, otherwise the value, from the written matrix or
// from a tab's values and formulas. A formula's references, outside its text, read as #: Sheets
// rewrites them when the tabs they read change (#REF! for a deleted tab, the new name of a renamed
// one, other cells when rows or columns move there) and drops quotes a simple tab name does not
// need. None of that edits the formula, and the next write puts its own references back. Nor
// does the spelling Sheets may store outside the text (names in capitals, a number in another
// notation, spaces), so case, spaces and number notation do not count there either. A tab returns
// a date cell as a date, read back as the serial it holds in the spreadsheet's timezone.
function dmvOutputEntered_(values, formulas, timezone) {
  return values.map(function (row, r) {
    return row.map(function (value, c) {
      var formula = formulas ? formulas[r][c] : value instanceof DmvFormula_ ? value.formula : '';
      if (!formula)
        return Object.prototype.toString.call(value) === '[object Date]'
          ? dmvDaySerial_(Utilities.formatDate(value, timezone, 'yyyy-MM-dd HH:mm'))
          : value;
      return String(formula)
        .split(/("(?:[^"]|"")*")/)
        .map(function (part, index) {
          return index % 2
            ? part
            : part
                .toUpperCase()
                .replace(
                  /(?:'(?:[^']|'')*'!|[^\s'!(),"&=<>+\-*/:;{}^%#]+!)?(?:\$?[A-Z]+\$?\d+(?::\$?[A-Z]+\$?\d+)?(?![\w(])|#REF!)/g,
                  '#'
                )
                .replace(/\s+/g, '')
                .replace(
                  /(^|[^\w.])(\d+\.?\d*|\.\d+)(E[+-]?\d+)?/g,
                  function (all, before, digits, power) {
                    return before + Number(digits + (power || ''));
                  }
                );
        })
        .join('');
    });
  });
}

// The pattern a number column takes from its written numbers: whole numbers, numbers below 1
// with four decimals, others with two. '#,##0.###' showed whole numbers as "2,494.".
function dmvNumberPattern_(written) {
  var numbers = written.filter(function (value) {
    return typeof value === 'number';
  });
  var whole = numbers.every(function (value) {
    return value % 1 === 0;
  });
  var small = numbers.every(function (value) {
    return Math.abs(value) < 1;
  });
  return whole ? '#,##0' : small ? '0.0000' : '#,##0.00';
}

// A result's matrix and table columns with every date column whose values are all plain days
// written as date serials shown yyyy-mm-dd, so sorting, filters and formulas read them as dates;
// the table aligns them left like the text they were. Other values, timestamps included, are
// written as fetched. dates names the columns written as serials.
function dmvDayColumns_(result) {
  var matrix = result.matrix,
    dates = Object.create(null),
    any = false;
  result.columns.forEach(function (column, index) {
    if (column.type !== 'date' || matrix.length < 2) return;
    for (var at = 1; at < matrix.length; at++) {
      if (matrix[at][index] === '') continue;
      try {
        dmvDate_(matrix[at][index]);
      } catch (ignored) {
        // A date-shaped value with an invalid calendar day stays literal, like other text.
        return;
      }
    }
    dates[index] = any = true;
  });
  return {
    dates: dates,
    // Copied only when a column changes: a data tab may hold 100,000 rows.
    matrix: !any
      ? matrix
      : matrix.map(function (row, at) {
          return !at
            ? row
            : row.map(function (value, index) {
                return dates[index] && value !== '' ? dmvDaySerial_(value) : value;
              });
        }),
    columns: result.columns.map(function (column, index) {
      return dates[index] ? { type: 'date', pattern: 'yyyy-mm-dd' } : column;
    }),
  };
}

// A yyyy-mm-dd day, or a yyyy-MM-dd HH:mm time, as a Sheets date serial: days since 30 Dec 1899.
function dmvDaySerial_(day) {
  var date = new Date(day.slice(0, 10) + 'T00:00:00Z');
  date.setUTCHours(Number(day.slice(11, 13)) || 0, Number(day.slice(14, 16)) || 0);
  return (date.getTime() - Date.UTC(1899, 11, 30)) / 86400000;
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
// the output order and carry the sheet ids planned for new tabs. The rows of outputs owned for
// rewriting (a dashboard's data tabs) end that batch, and those past its size limit follow in as
// many further batches as they take.
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
    // The areas and matrices of outputs owned for rewriting, written after every other request.
    rewrites: [],
  };
  // Where each output's requests start, so a batch past the size limit can say what grew.
  var starts = outputs.map(function (output) {
    dmvSheetName_(output.report.target.sheetName);
    var start = plan.requests.length;
    dmvPrepareReportWrite_(spreadsheet, output.report, output.result, plan);
    return start;
  });
  starts.push(plan.requests.length);
  if (extra) plan.requests = plan.requests.concat(extra(plan.areas) || []);
  plan.requests = plan.requests.concat(
    dmvOutputRecordRequests_(spreadsheet.getId(), outputs, plan.areas, plan.all)
  );
  var size = dmvUtf8Bytes_(JSON.stringify(plan.requests));
  if (size > DMV_LIMITS.maxBytes) {
    // Marked, with each output's area and share of the batch in output order, so a caller that
    // knows what its outputs hold (a dashboard's datasets and page) can name what to narrow.
    var large = new Error(
      'These reports are too large for one Sheets write. Select fewer fields or rows.'
    );
    large.tooLarge = true;
    large.parts = outputs.map(function (output, index) {
      return {
        id: output.report.id,
        rows: plan.areas[index].rows,
        columns: plan.areas[index].columns,
        size: dmvUtf8Bytes_(JSON.stringify(plan.requests.slice(starts[index], starts[index + 1]))),
      };
    });
    throw large;
  }
  if (beforeCommit) beforeCommit();
  var journalKey = 'dmv:v1:write-journal:' + spreadsheet.getId();
  properties.setProperty(journalKey, dmvCheckRecordSize_({ receipts: plan.receipts }));
  var batch = plan.requests,
    sent = false;
  var send = function () {
    Sheets.Spreadsheets.batchUpdate({ requests: batch }, spreadsheet.getId());
    sent = true;
    batch = [];
    size = 0;
  };
  try {
    plan.rewrites.forEach(function (item) {
      var request = null;
      item.matrix.forEach(function (line, index) {
        var row = dmvOutputRow_(line),
          bytes = dmvUtf8Bytes_(JSON.stringify(row)) + 1;
        // 300 bytes hold a request's range and the batch around it.
        if (size + bytes + 300 > DMV_LIMITS.maxBytes) {
          send();
          request = null;
        }
        if (!request) {
          var at = item.area.row - 1 + index;
          request = {
            updateCells: {
              range: {
                sheetId: item.area.sheetId,
                startRowIndex: at,
                endRowIndex: at,
                startColumnIndex: item.area.column - 1,
                endColumnIndex: item.area.column - 1 + item.area.columns,
              },
              rows: [],
              fields: 'userEnteredValue',
            },
          };
          batch.push(request);
          size += 300;
        }
        request.updateCells.rows.push(row);
        request.updateCells.range.endRowIndex++;
        size += bytes;
      });
    });
    send();
  } catch (error) {
    if (!sent) throw error;
    // The journal stays, so the next write takes these outputs back and writes them whole.
    var partial = new Error(
      'The output tabs were updated, but not all of their rows. Refresh again to write them.'
    );
    partial.sheetUpdated = true;
    throw partial;
  }
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
  var layout = result.layout;
  if (!layout) result = dmvDayColumns_(result);
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
  // A rewritten output (a dashboard's data tab) owns its area outright: it is replaced without
  // being read back, so a refresh of many rows stays fast. Only cells it grows into are read.
  var rewrite = report.rewrite === true;
  var area = {
    sheetId: sheetId,
    row: anchor.row,
    column: anchor.column,
    rows: result.matrix.length,
    columns: result.matrix[0].length,
  };
  // A plain table records its header and column types, so a rerun over the same columns keeps
  // the formats chat or the user gave its cells (fills, text colours, number formats). A number
  // column records the pattern its values take, so whole numbers turning fractional reformat it.
  if (!layout)
    area.shape = dmvOutputDigest_([
      result.matrix[0],
      result.columns.map(function (column, index) {
        return [
          column.type,
          column.type === 'number' && column.pattern === undefined
            ? dmvNumberPattern_(
                result.matrix.slice(1).map(function (row) {
                  return row[index];
                })
              )
            : column.pattern,
        ];
      }),
    ]);
  if (old && (old.sheetId !== area.sheetId || old.row !== area.row || old.column !== area.column))
    old = null;
  if (old) {
    var ownershipError =
      'The previous report output was edited or moved. Choose a new empty output area before refreshing.';
    if (
      (!old.digest && !rewrite) ||
      old.row + old.rows - 1 > maxRows ||
      old.column + old.columns - 1 > maxColumns
    )
      throw new Error(ownershipError);
    if (!rewrite) {
      var previousRange = sheet.getRange(old.row, old.column, old.rows, old.columns);
      if (
        dmvOutputDigest_(
          dmvOutputEntered_(
            previousRange.getValues(),
            previousRange.getFormulas(),
            spreadsheet.getSpreadsheetTimeZone()
          )
        ) !== old.digest
      )
        throw new Error(ownershipError);
    }
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
  // Cells the output does not own yet must be empty: the whole area, or the rows and columns it
  // grows into, as far as the tab has them.
  var physical = plan.physicalGrids[sheetId] || { rows: 0, columns: 0 },
    ownedRows = old ? old.rows : 0,
    ownedColumns = old ? old.columns : 0;
  [
    [ownedRows, 0, area.rows - ownedRows, area.columns],
    [0, ownedColumns, Math.min(ownedRows, area.rows), area.columns - ownedColumns],
  ].forEach(function (part) {
    var rows = Math.min(part[2], physical.rows - area.row - part[0] + 1),
      columns = Math.min(part[3], physical.columns - area.column - part[1] + 1);
    if (!sheet || rows < 1 || columns < 1) return;
    var range = sheet.getRange(area.row + part[0], area.column + part[1], rows, columns);
    var formulas = range.getFormulas();
    if (
      range.getValues().some(function (line, r) {
        return line.some(function (value, c) {
          return value !== '' || formulas[r][c] !== '';
        });
      })
    )
      throw new Error(
        'The tab "' +
          report.target.sheetName +
          '" contains existing data where this output goes. Choose an empty area or a new tab name.'
      );
  });
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
  //                (a date pattern also aligns its column left)
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
  var keep = !layout && !!old && old.shape === area.shape && old.rows > 1;
  var merges = grids[sheetId].merges || [],
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
  var span = {
    sheetId: area.sheetId,
    row: area.row,
    column: area.column,
    rows: Math.max(area.rows, old ? old.rows : 0),
    columns: Math.max(area.columns, old ? old.columns : 0),
  };
  // The formats of the previous output (borders and links included) go before it is formatted
  // again: a layout's blocks move between refreshes, and a plain table whose columns changed is
  // formatted afresh as a whole, never leaving pieces of the old style (white text on its fill).
  var clearFormats = function () {
    requests.push({
      repeatCell: {
        range: range(span.row, span.column, span.rows, span.columns),
        cell: {},
        fields: 'userEnteredFormat',
      },
    });
  };
  if (layout) {
    Object.keys(layout).forEach(function (name) {
      if (DMV_LAYOUT_MEMBERS.indexOf(name) < 0 || !Array.isArray(layout[name]))
        throw new Error('Invalid layout member "' + name + '".');
    });
    // A layout owns the formats, merges and row heights of its previous and its new area.
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
    clearFormats();
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
  } else if (old && !keep) clearFormats();
  if (rewrite) {
    area.rewrite = true;
    plan.rewrites.push({ area: area, matrix: result.matrix });
  } else {
    area.digest = dmvOutputDigest_(dmvOutputEntered_(result.matrix));
    requests.push({
      updateCells: {
        range: range(area.row, area.column, area.rows, area.columns),
        rows: result.matrix.map(dmvOutputRow_),
        fields: 'userEnteredValue',
      },
    });
  }
  area.writtenAt = Date.now();
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
  // Number patterns follow the written values; an explicit pattern wins.
  var numberFormat = function (type, written, pattern) {
    if (pattern !== undefined)
      return {
        type: type === 'percent' ? 'PERCENT' : type === 'date' ? 'DATE' : 'NUMBER',
        pattern: dmvLayoutPattern_(pattern),
      };
    if (type === 'number') return { type: 'NUMBER', pattern: dmvNumberPattern_(written) };
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
        fields: 'userEnteredFormat.textFormat,userEnteredFormat.backgroundColor',
      },
    });
    if (tableRows > 1)
      columns.forEach(function (item, index) {
        var written = values(row + 1, column + index, tableRows - 1, 1);
        var format = { numberFormat: numberFormat(item.type, written, item.pattern) };
        // Dates read left, like the text they were before Sheets knew them as dates.
        if (format.numberFormat.type === 'DATE') format.horizontalAlignment = 'LEFT';
        requests.push({
          repeatCell: {
            range: range(area.row + row + 1, area.column + column + index, tableRows - 1, 1),
            cell: { userEnteredFormat: format },
            fields:
              'userEnteredFormat.numberFormat' +
              (format.horizontalAlignment ? ',userEnteredFormat.horizontalAlignment' : ''),
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
  } else if (!keep) table(0, 0, area.rows, result.columns);
  else if (area.rows > old.rows)
    // Rows a rerun adds take the formats of the last row it had.
    requests.push({
      copyPaste: {
        source: range(area.row + old.rows - 1, area.column, 1, area.columns),
        destination: range(area.row + old.rows, area.column, area.rows - old.rows, area.columns),
        pasteType: 'PASTE_FORMAT',
      },
    });
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

/* Output records: what every collaborator's chat knows of report and dashboard output. */

// Receipts are private to the user whose report or dashboard wrote the output. So that chat
// leaves that output alone for every collaborator, each write also records the output's area as
// developer metadata on its tab: project visibility keeps it to DataMoov, it goes with the tab,
// and it holds no names, only ids, the kind of owner and the area. The spreadsheet id lets a
// copy of the spreadsheet tell a copied record from its own.
var DMV_OUTPUT_RECORD = 'dmv:v1:output';

// The report or dashboard that owns an output id, from the owner's private records:
// { kind: 'report'|'dashboard'|'output', name, page? }. 'output' is any other output, such as
// a chat table, which is never refreshed.
function dmvOutputOwner_(all, id) {
  function name(text) {
    try {
      return String(JSON.parse(text).name || '');
    } catch (ignored) {
      return '';
    }
  }
  if (all['dmv:v1:report:' + id]) return { kind: 'report', name: name(all['dmv:v1:report:' + id]) };
  var prefix = 'dmv:v1:dashboard:';
  var keys = Object.keys(all).filter(function (candidate) {
    return (
      candidate.indexOf(prefix) === 0 && id.indexOf(candidate.slice(prefix.length) + '-') === 0
    );
  });
  // page marks the dashboard tab (<id>-report) and its chart data tab (<id>-charts); a dataset
  // receipt (<id>-d-<dataset>) is not one, whatever its dataset id ends with.
  var page = keys.filter(function (candidate) {
    var rest = id.slice(candidate.length - prefix.length);
    return rest === '-report' || rest === '-charts';
  })[0];
  var key = page || keys[0];
  if (key) return { kind: 'dashboard', name: name(all[key]), page: !!page };
  return { kind: 'output', name: '' };
}

// The output records of this spreadsheet, each with its metadata id and the tab it lies on.
function dmvOutputRecords_(spreadsheetId) {
  var response = Sheets.Spreadsheets.get(spreadsheetId, {
    fields: 'sheets(properties.sheetId,developerMetadata(metadataId,metadataKey,metadataValue))',
  });
  var records = [];
  ((response && response.sheets) || []).forEach(function (item) {
    (item.developerMetadata || []).forEach(function (metadata) {
      if (metadata.metadataKey !== DMV_OUTPUT_RECORD) return;
      var record;
      try {
        record = JSON.parse(metadata.metadataValue);
      } catch (ignored) {
        return;
      }
      if (
        !record ||
        record.spreadsheetId !== spreadsheetId ||
        typeof record.id !== 'string' ||
        ['report', 'dashboard'].indexOf(record.kind) < 0 ||
        ![record.row, record.column, record.rows, record.columns].every(function (value) {
          return Number.isInteger(value) && value > 0;
        })
      )
        return;
      records.push({
        metadataId: metadata.metadataId,
        // The API leaves out a sheet id of 0.
        sheetId: (item.properties && item.properties.sheetId) || 0,
        value: metadata.metadataValue,
        record: record,
      });
    });
  });
  return records;
}

function dmvOutputRecordDelete_(found) {
  return {
    deleteDeveloperMetadata: {
      dataFilter: { developerMetadataLookup: { metadataId: found.metadataId } },
    },
  };
}

// Requests that leave one record per report or dashboard output of this write, on the tab it
// now lies on. A record that already says the same is kept, so a refresh of the same area sends
// none. When the records cannot be read, the write goes ahead without them: they protect the
// output, and a later refresh brings them up to date.
function dmvOutputRecordRequests_(spreadsheetId, outputs, areas, all) {
  var owners = outputs.map(function (output) {
    return dmvOutputOwner_(all, output.report.id);
  });
  if (
    !owners.some(function (owner) {
      return owner.kind !== 'output';
    })
  )
    return [];
  var existing;
  try {
    existing = dmvOutputRecords_(spreadsheetId);
  } catch (ignored) {
    return [];
  }
  var requests = [];
  outputs.forEach(function (output, index) {
    var owner = owners[index],
      area = areas[index];
    if (owner.kind === 'output') return;
    var record = {
      spreadsheetId: spreadsheetId,
      id: output.report.id,
      kind: owner.kind,
      row: area.row,
      column: area.column,
      rows: area.rows,
      columns: area.columns,
    };
    if (owner.page) record.page = true;
    var value = JSON.stringify(record),
      kept = false;
    existing.forEach(function (found) {
      if (found.record.id !== record.id) return;
      if (!kept && found.sheetId === area.sheetId && found.value === value) kept = true;
      else requests.push(dmvOutputRecordDelete_(found));
    });
    if (!kept)
      requests.push({
        createDeveloperMetadata: {
          developerMetadata: {
            metadataKey: DMV_OUTPUT_RECORD,
            metadataValue: value,
            location: { sheetId: area.sheetId },
            visibility: 'PROJECT',
          },
        },
      });
  });
  return requests;
}

// Removes the records of outputs no longer refreshed, when their report or dashboard (or a
// dashboard dataset) is removed, so collaborators may edit what was left behind.
function dmvForgetOutputs_(spreadsheetId, ids) {
  dmvWorkbookLocked_(function () {
    var properties = dmvStore_();
    if (properties.getProperty('dmv:v1:write-journal:' + spreadsheetId))
      dmvRecoverOutputJournal_(dmvReopen_(SpreadsheetApp.openById(spreadsheetId)), properties, ids);
    var requests = dmvOutputRecords_(spreadsheetId)
      .filter(function (found) {
        return ids.indexOf(found.record.id) >= 0;
      })
      .map(dmvOutputRecordDelete_);
    if (requests.length) Sheets.Spreadsheets.batchUpdate({ requests: requests }, spreadsheetId);
    dmvPruneOutputJournal_(spreadsheetId, ids);
  });
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
function dmvRecoverOutputJournal_(spreadsheet, properties, ids) {
  var journalKey = 'dmv:v1:write-journal:' + spreadsheet.getId();
  var text = properties.getProperty(journalKey);
  if (!text) return;
  var journal = JSON.parse(text),
    sheets = spreadsheet.getSheets();
  if (!journal || !Array.isArray(journal.receipts) || journal.receipts.length > 10)
    throw new Error('The output ownership journal is invalid. Choose a new output area.');
  var selected =
    ids &&
    ids.map(function (id) {
      return dmvOutputKey_(spreadsheet.getId(), id);
    });
  journal.receipts.forEach(function (receipt) {
    var area = receipt.area;
    if (
      !area ||
      typeof receipt.key !== 'string' ||
      receipt.key.indexOf(dmvOutputKey_(spreadsheet.getId(), '')) !== 0
    )
      throw new Error('The output ownership journal is invalid.');
    if (selected && selected.indexOf(receipt.key) < 0) return;
    var sheet = sheets.filter(function (item) {
      return item.getSheetId() === area.sheetId;
    })[0];
    if (
      !sheet ||
      area.row + area.rows - 1 > sheet.getMaxRows() ||
      area.column + area.columns - 1 > sheet.getMaxColumns()
    )
      return;
    // A rewritten area is never compared: it is its own again while its tab still holds it.
    var range = sheet.getRange(area.row, area.column, area.rows, area.columns);
    if (
      area.rewrite ||
      dmvOutputDigest_(
        dmvOutputEntered_(
          range.getValues(),
          range.getFormulas(),
          spreadsheet.getSpreadsheetTimeZone()
        )
      ) === area.digest
    )
      properties.setProperty(receipt.key, JSON.stringify(area));
  });
  if (ids) {
    dmvPruneOutputJournal_(spreadsheet.getId(), ids);
    return;
  }
  try {
    properties.deleteProperty(journalKey);
  } catch (ignored) {
    /* All matching receipts were committed. */
  }
}

// Removing an owner must not let a later write restore its abandoned receipt. Keep other
// outputs in a multi-output journal untouched so they can still recover their own receipts.
function dmvPruneOutputJournal_(spreadsheetId, ids) {
  var properties = dmvStore_(),
    key = 'dmv:v1:write-journal:' + spreadsheetId,
    text = properties.getProperty(key);
  if (!text) return;
  var journal = JSON.parse(text);
  if (!journal || !Array.isArray(journal.receipts) || journal.receipts.length > 10)
    throw new Error('The output ownership journal is invalid.');
  var removed = ids.map(function (id) {
    return dmvOutputKey_(spreadsheetId, id);
  });
  var kept = journal.receipts.filter(function (receipt) {
    return removed.indexOf(receipt.key) < 0;
  });
  if (kept.length === journal.receipts.length) return;
  if (!kept.length) properties.deleteProperty(key);
  else properties.setProperty(key, dmvCheckRecordSize_({ receipts: kept }));
}
