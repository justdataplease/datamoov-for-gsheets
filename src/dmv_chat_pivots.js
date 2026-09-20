/* Native Sheets pivot tables. Existing source cells are only read; output is a new tab.
   API contract: https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/pivot-tables */
function dmvChatPivotArea_(sheet, address) {
  if (
    typeof address !== 'string' ||
    !/^[A-Za-z]{1,3}[1-9][0-9]{0,6}:[A-Za-z]{1,3}[1-9][0-9]{0,6}$/.test(address)
  )
    throw new Error('Use an explicit source range with its header row, such as A1:G500.');
  var parts = address.toUpperCase().split(':');
  var start = dmvCell_(parts[0]),
    end = dmvCell_(parts[1]);
  var rows = end.row - start.row + 1,
    columns = end.column - start.column + 1;
  if (rows < 2 || rows > 20001 || columns < 1 || columns > 80)
    throw new Error(
      'A pivot source needs one header row and 1 to 20,000 data rows, with at most 80 columns.'
    );
  if (end.row > sheet.getMaxRows() || end.column > sheet.getMaxColumns())
    throw new Error('The pivot source range must fit inside the existing sheet grid.');
  if (sheet.getLastRow() <= start.row)
    throw new Error('The pivot source needs data below its header row.');
  return {
    a1: start.a1 + ':' + end.a1,
    row: start.row,
    column: start.column,
    rows: rows,
    columns: columns,
    grid: {
      sheetId: sheet.getSheetId(),
      startRowIndex: start.row - 1,
      endRowIndex: end.row,
      startColumnIndex: start.column - 1,
      endColumnIndex: end.column,
    },
  };
}

function dmvChatPivotColumn_(column, width) {
  if (!Number.isInteger(column) || column < 1 || column > width)
    throw new Error('Pivot columns are one-based offsets inside the selected source range.');
  return column - 1;
}

function dmvChatPivotGroups_(groups, width, used, required) {
  if (!Array.isArray(groups) || groups.length > 6 || (required && !groups.length))
    throw new Error('Choose 1 to 6 row groups and at most 6 column groups.');
  return groups.map(function (group) {
    dmvChatSheetObject_(group, ['column', 'dateBucket']);
    var offset = dmvChatPivotColumn_(group.column, width);
    if (used[offset])
      throw new Error('Use each source column in only one pivot row or column group.');
    used[offset] = true;
    var output = {
      sourceColumnOffset: offset,
      showTotals: false,
      sortOrder: 'ASCENDING',
    };
    if (required) output.repeatHeadings = true;
    if (group.dateBucket !== undefined) {
      var rules = { day: 'YEAR_MONTH_DAY', month: 'YEAR_MONTH', year: 'YEAR' };
      if (!Object.prototype.hasOwnProperty.call(rules, group.dateBucket))
        throw new Error('Date buckets must be day, month or year.');
      output.groupRule = { dateTimeRule: { type: rules[group.dateBucket] } };
    }
    return output;
  });
}

function dmvChatCreatePivot_(session, input) {
  dmvChatSheetObject_(input, [
    'sourceSheet',
    'sourceRange',
    'targetSheet',
    'rows',
    'columns',
    'values',
  ]);
  if (JSON.stringify(input).length > 12000) throw new Error('The pivot definition is too large.');
  dmvChatSheetDeadline_(session);
  return dmvWorkbookLocked_(function () {
    dmvChatSheetDeadline_(session);
    var source = dmvChatSheetTarget_(session, input.sourceSheet);
    var target = dmvSheetName_(input.targetSheet);
    if (
      session.spreadsheet.getSheets().some(function (sheet) {
        return sheet.getName().toLowerCase() === target.toLowerCase();
      })
    )
      throw new Error('The pivot output tab already exists. Choose a new tab name.');
    var area = dmvChatPivotArea_(source, input.sourceRange);
    var headers = source.getRange(area.row, area.column, 1, area.columns).getValues()[0];
    var headerNames = Object.create(null);
    headers.forEach(function (header) {
      if (
        typeof header !== 'string' ||
        !header.trim() ||
        header.length > 200 ||
        headerNames[header.trim().toLowerCase()]
      )
        throw new Error(
          'Each source column needs a distinct, nonempty text header of at most 200 characters.'
        );
      headerNames[header.trim().toLowerCase()] = true;
    });
    var grouped = Object.create(null);
    var rows = dmvChatPivotGroups_(input.rows, area.columns, grouped, true);
    var columns = dmvChatPivotGroups_(
      input.columns === undefined ? [] : input.columns,
      area.columns,
      grouped,
      false
    );
    if (!Array.isArray(input.values) || !input.values.length || input.values.length > 8)
      throw new Error('Choose between 1 and 8 pivot values.');
    var selectedValues = Object.create(null);
    var values = input.values.map(function (value) {
      dmvChatSheetObject_(value, ['column', 'summarize']);
      var offset = dmvChatPivotColumn_(value.column, area.columns);
      if (['SUM', 'COUNT', 'COUNTA', 'AVERAGE', 'MIN', 'MAX'].indexOf(value.summarize) < 0)
        throw new Error('Choose SUM, COUNT, COUNTA, AVERAGE, MIN or MAX for pivot values.');
      var key = offset + ':' + value.summarize;
      if (selectedValues[key])
        throw new Error('Do not repeat the same pivot value and aggregation.');
      selectedValues[key] = true;
      return { sourceColumnOffset: offset, summarizeFunction: value.summarize };
    });
    // Read only the bounded columns needed to validate types and currencies, never send their
    // rows to the model. Empty future rows remain part of the native source range.
    var readColumns = Object.create(null);
    function data(offset) {
      if (!Object.prototype.hasOwnProperty.call(readColumns, offset)) {
        dmvChatSheetDeadline_(session);
        readColumns[offset] = source
          .getRange(area.row + 1, area.column + offset, area.rows - 1, 1)
          .getValues()
          .map(function (row) {
            return row[0];
          });
      }
      return readColumns[offset];
    }
    function nonempty(value) {
      return value !== '' && value !== null && value !== undefined;
    }
    var numeric = values.filter(function (value) {
      return ['SUM', 'AVERAGE', 'MIN', 'MAX'].indexOf(value.summarizeFunction) >= 0;
    });
    numeric.forEach(function (value) {
      var seen = false;
      data(value.sourceColumnOffset).forEach(function (entry) {
        if (!nonempty(entry)) return;
        if (typeof entry !== 'number' || !Number.isFinite(entry))
          throw new Error(
            'Numeric pivot values must contain only numbers or empty cells. Numeric text is not silently ignored.'
          );
        seen = true;
      });
      if (!seen) throw new Error('The selected pivot value contains no numeric data.');
    });
    rows.concat(columns).forEach(function (group) {
      if (!group.groupRule) return;
      var seen = false;
      data(group.sourceColumnOffset).forEach(function (entry) {
        if (!nonempty(entry)) return;
        if (
          Object.prototype.toString.call(entry) !== '[object Date]' ||
          !Number.isFinite(entry.getTime())
        )
          throw new Error(
            'Native date buckets require real date cells. ISO date text can be grouped directly, or use an existing month column.'
          );
        seen = true;
      });
      if (!seen) throw new Error('The date grouping column contains no dates.');
    });
    var currencyColumns = [];
    headers.forEach(function (header, offset) {
      if (/currency/i.test(header)) currencyColumns.push(offset);
    });
    var money = numeric.some(function (value) {
      return /spend|cost|revenue|sales|amount|budget|price|profit|expense/i.test(
        headers[value.sourceColumnOffset]
      );
    });
    if (money && !currencyColumns.length)
      throw new Error('Include an explicit currency-code column before creating a money pivot.');
    currencyColumns.forEach(function (offset) {
      if (!numeric.length) return;
      var codes = Object.create(null);
      data(offset).forEach(function (entry, index) {
        var hasValue = numeric.some(function (value) {
          return nonempty(data(value.sourceColumnOffset)[index]);
        });
        if (!hasValue) return;
        if (typeof entry !== 'string' || !/^[A-Z]{3}$/.test(entry))
          throw new Error('Every numeric row needs an explicit three-letter currency code.');
        codes[entry] = true;
      });
      if ((money || Object.keys(codes).length > 1) && !grouped[offset])
        throw new Error(
          'Group money and mixed-currency values by the currency column. Pivot totals never combine currencies.'
        );
    });
    var columnKeys = Object.create(null),
      dateKeys = Object.create(null),
      columnCount = 1;
    if (columns.length) {
      for (var r = 0; r < area.rows - 1; r++) {
        var key = JSON.stringify(
          columns.map(function (group) {
            var value = data(group.sourceColumnOffset)[r];
            if (Object.prototype.toString.call(value) !== '[object Date]') return value;
            var rule = group.groupRule && group.groupRule.dateTimeRule.type;
            var dateKey = value.getTime() + ':' + rule;
            if (Object.prototype.hasOwnProperty.call(dateKeys, dateKey)) return dateKeys[dateKey];
            var iso = Utilities.formatDate(
              value,
              session.spreadsheet.getSpreadsheetTimeZone(),
              'yyyy-MM-dd'
            );
            return (dateKeys[dateKey] =
              rule === 'YEAR'
                ? iso.slice(0, 4)
                : rule === 'YEAR_MONTH'
                  ? iso.slice(0, 7)
                  : rule === 'YEAR_MONTH_DAY'
                    ? iso
                    : value.toISOString());
          })
        );
        columnKeys[key] = true;
      }
      columnCount = Object.keys(columnKeys).length;
    }
    var outputRows = Math.max(100, area.rows + columns.length + 2);
    var outputColumns = Math.max(26, rows.length + columnCount * values.length + values.length);
    if (outputColumns > 512 || outputRows * outputColumns > 1000000)
      throw new Error(
        'This pivot could exceed 512 columns or 1,000,000 output cells. Use fewer column groups or a smaller source range.'
      );
    var ids = session.spreadsheet.getSheets().map(function (sheet) {
      return sheet.getSheetId();
    });
    var sheetId;
    for (var attempt = 0; attempt < 5; attempt++) {
      sheetId = (parseInt(dmvOutputDigest_(Utilities.getUuid()).slice(0, 8), 16) % 2147483646) + 1;
      if (ids.indexOf(sheetId) < 0) break;
      sheetId = null;
    }
    if (sheetId === null) throw new Error('Could not allocate a new pivot tab. Try again.');
    var pivot = {
      source: area.grid,
      rows: rows,
      columns: columns,
      values: values,
      valueLayout: 'HORIZONTAL',
    };
    var requests = [
      {
        addSheet: {
          properties: {
            sheetId: sheetId,
            title: target,
            gridProperties: { rowCount: outputRows, columnCount: outputColumns },
          },
        },
      },
      {
        updateCells: {
          start: { sheetId: sheetId, rowIndex: 0, columnIndex: 0 },
          rows: [{ values: [{ pivotTable: pivot }] }],
          fields: 'pivotTable',
        },
      },
    ];
    dmvChatSheetDeadline_(session);
    Sheets.Spreadsheets.batchUpdate({ requests: requests }, session.spreadsheetId);
    if (session.sheetNames && session.sheetNames.indexOf(target) < 0)
      session.sheetNames.push(target);
    session.events.push({
      kind: 'write',
      text:
        'Created a native pivot table on ' + target + ' from ' + source.getName() + '!' + area.a1,
    });
    return {
      ok: true,
      sheetName: target,
      anchorCell: 'A1',
      nativePivot: true,
      sourceSheet: source.getName(),
      sourceRange: area.a1,
      rowGroups: rows.length,
      columnGroups: columns.length,
      valueColumns: values.length,
      note: 'The native pivot stays linked to this bounded source range. No source cells were changed; currency-mixing totals are disabled.',
    };
  });
}

function dmvChatPivotTools_() {
  var group = {
    type: 'object',
    properties: {
      column: {
        type: 'integer',
        minimum: 1,
        maximum: 80,
        description: 'One-based column offset inside sourceRange, not the sheet column number.',
      },
      dateBucket: {
        type: 'string',
        enum: ['day', 'month', 'year'],
        description:
          'Optional native grouping for real date cells only. ISO text can be grouped without a bucket.',
      },
    },
    required: ['column'],
    additionalProperties: false,
  };
  return [
    {
      name: 'create_pivot',
      description:
        'Create a real native Google Sheets pivot in a NEW tab, linked to an explicit source range including its header. At most 20,000 data rows and 80 source columns. Source cells are not changed. Choose 1 to 6 row groups, 0 to 6 column groups and 1 to 8 value aggregations; no formulas or filters. For money include and group by a currency-code column; totals are disabled to avoid mixing currencies. Native date buckets need actual date cells. Empty future rows within the existing source grid may be included.',
      input_schema: {
        type: 'object',
        properties: {
          sourceSheet: { type: 'string', description: 'Existing ordinary source tab.' },
          sourceRange: {
            type: 'string',
            description: 'Explicit bounded A1 range with one header row, for example B3:H1000.',
          },
          targetSheet: {
            type: 'string',
            description: 'A new output tab name; existing tabs are never overwritten.',
          },
          rows: { type: 'array', minItems: 1, maxItems: 6, items: group },
          columns: { type: 'array', maxItems: 6, items: group },
          values: {
            type: 'array',
            minItems: 1,
            maxItems: 8,
            items: {
              type: 'object',
              properties: {
                column: { type: 'integer', minimum: 1, maximum: 80 },
                summarize: {
                  type: 'string',
                  enum: ['SUM', 'COUNT', 'COUNTA', 'AVERAGE', 'MIN', 'MAX'],
                },
              },
              required: ['column', 'summarize'],
              additionalProperties: false,
            },
          },
        },
        required: ['sourceSheet', 'sourceRange', 'targetSheet', 'rows', 'values'],
        additionalProperties: false,
      },
      run: dmvChatCreatePivot_,
    },
  ];
}
