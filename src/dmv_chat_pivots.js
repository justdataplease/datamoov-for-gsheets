/* The create_pivot tool: native Sheets pivot tables. Existing source cells are only read. The
   original options (row and column groups, SUM to MAX, day/month/year buckets) write a new tab
   directly. A call that uses an analyst option (filters, totals, per-group sort, percentages,
   MEDIAN, quarters or targetCell on an existing tab) runs through dmvChatSheetRunAction_, which
   adds the output guard and undo for a pivot placed on an existing tab.
   API contract: https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/pivot-tables */
var DMV_CHAT_PIVOT = {
  functions: ['SUM', 'COUNT', 'COUNTA', 'AVERAGE', 'MIN', 'MAX', 'MEDIAN'],
  numeric: ['SUM', 'AVERAGE', 'MIN', 'MAX', 'MEDIAN'],
  showAs: {
    percent_of_row_total: 'PERCENT_OF_ROW_TOTAL',
    percent_of_column_total: 'PERCENT_OF_COLUMN_TOTAL',
    percent_of_grand_total: 'PERCENT_OF_GRAND_TOTAL',
  },
  buckets: { day: 'YEAR_MONTH_DAY', month: 'YEAR_MONTH', quarter: 'YEAR_QUARTER', year: 'YEAR' },
  maxFilters: 6,
  maxFilterValues: 100,
};

/* Shared by both paths */

function dmvChatPivotArea_(sheet, address) {
  address = dmvChatOwnTabA1_(sheet, address);
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
  if (rows < 2 || columns < 1 || columns > 80)
    throw new Error(
      'A pivot source needs one header row and at least one data row, with at most 80 columns.'
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
    // The data rows the checks read: every row of any report output, the first rows of a larger
    // tab, which the native pivot still covers whole.
    checked: Math.min(rows - 1, DMV_LIMITS.maxRows),
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

// The source headers as text: a number as it is written, a date as YYYY-MM-DD in the spreadsheet's
// time zone. Columns the pivot does not use may have any header, even none.
function dmvChatPivotHeaders_(session, source, area) {
  var timezone = null;
  return source
    .getRange(area.row, area.column, 1, area.columns)
    .getValues()[0]
    .map(function (header) {
      if (Object.prototype.toString.call(header) !== '[object Date]') return String(header);
      if (!timezone) timezone = session.spreadsheet.getSpreadsheetTimeZone();
      return Utilities.formatDate(header, timezone, 'yyyy-MM-dd');
    });
}

// Each column a group, value or filter uses (objects with sourceColumnOffset or
// columnOffsetIndex) needs a distinct, nonempty header, so the pivot and its result name it.
function dmvChatPivotNamed_(headers, used) {
  var names = Object.create(null);
  used.forEach(function (item) {
    var offset =
        item.sourceColumnOffset !== undefined ? item.sourceColumnOffset : item.columnOffsetIndex,
      header = headers[offset],
      key = header.trim().toLowerCase();
    var problem = !key
      ? 'has no header'
      : header.length > 200
        ? 'has a header longer than 200 characters'
        : key in names && names[key] !== offset
          ? 'has the same header as column ' + (names[key] + 1)
          : '';
    if (problem)
      throw new Error(
        'Each source column the pivot uses needs a distinct, nonempty header of at most 200 characters; column ' +
          (offset + 1) +
          ' of the source range ' +
          problem +
          '.'
      );
    names[key] = offset;
  });
}

// Row or column groups. extended allows the analyst options: order, sortByValue and quarters.
function dmvChatPivotGroups_(groups, width, used, rows, extended) {
  if (!Array.isArray(groups) || groups.length > 6 || (rows && !groups.length))
    throw new Error('Choose 1 to 6 row groups and at most 6 column groups.');
  return groups.map(function (group) {
    dmvChatSheetObject_(
      group,
      extended ? ['column', 'dateBucket', 'order', 'sortByValue'] : ['column', 'dateBucket']
    );
    var offset = dmvChatPivotColumn_(group.column, width);
    if (used[offset])
      throw new Error('Use each source column in only one pivot row or column group.');
    used[offset] = true;
    if (group.order !== undefined && group.order !== 'asc' && group.order !== 'desc')
      throw new Error('A group order is asc or desc.');
    var output = {
      sourceColumnOffset: offset,
      showTotals: false,
      sortOrder: group.order === 'desc' ? 'DESCENDING' : 'ASCENDING',
    };
    if (rows) output.repeatHeadings = true;
    if (group.dateBucket !== undefined) {
      if (
        !Object.prototype.hasOwnProperty.call(DMV_CHAT_PIVOT.buckets, group.dateBucket) ||
        (!extended && group.dateBucket === 'quarter')
      )
        throw new Error(
          extended
            ? 'Date buckets must be day, month, quarter or year.'
            : 'Date buckets must be day, month or year.'
        );
      output.groupRule = { dateTimeRule: { type: DMV_CHAT_PIVOT.buckets[group.dateBucket] } };
    }
    if (group.sortByValue !== undefined) output.valueBucket = { valuesIndex: group.sortByValue };
    return output;
  });
}

// Reads area.checked rows of one source column below its header on first use. Only the columns
// needed for checks and layout are read, and their rows never reach the model.
function dmvChatPivotReader_(session, source, area) {
  var read = Object.create(null);
  return function (offset) {
    if (!Object.prototype.hasOwnProperty.call(read, offset)) {
      dmvChatSheetDeadline_(session);
      read[offset] = source
        .getRange(area.row + 1, area.column + offset, area.checked, 1)
        .getValues()
        .map(function (row) {
          return row[0];
        });
    }
    return read[offset];
  };
}

// A reader of every data row, for what must hold on all of them (currencies, the groups of
// chartRange); it is data itself when the checks already read every row.
function dmvChatPivotEveryRow_(session, source, area, data) {
  return area.checked < area.rows - 1
    ? dmvChatPivotReader_(session, source, Object.assign({}, area, { checked: area.rows - 1 }))
    : data;
}

function dmvChatPivotFilled_(value) {
  return value !== '' && value !== null && value !== undefined;
}

// Numbers only under numeric summaries, and real dates under date buckets.
function dmvChatPivotCheckTypes_(data, numeric, groups) {
  numeric.forEach(function (value) {
    var seen = false;
    data(value.sourceColumnOffset).forEach(function (entry) {
      if (!dmvChatPivotFilled_(entry)) return;
      if (typeof entry !== 'number' || !Number.isFinite(entry))
        throw new Error(
          'Numeric pivot values must contain only numbers or empty cells. Numeric text is not silently ignored.'
        );
      seen = true;
    });
    if (!seen) throw new Error('The selected pivot value contains no numeric data.');
  });
  groups.forEach(function (group) {
    if (!group.groupRule) return;
    var seen = false;
    data(group.sourceColumnOffset).forEach(function (entry) {
      if (!dmvChatPivotFilled_(entry)) return;
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
}

// A source without a currency column holds one currency, as its tab formats it. With one (report
// output of several accounts), every numeric row needs an explicit code, and money or mixed
// currencies must be grouped by it. Checked on every row (all, dmvChatPivotEveryRow_). Returns
// the currency columns with several codes.
function dmvChatPivotCurrencies_(headers, numeric, used, all) {
  var currencyColumns = [];
  headers.forEach(function (header, offset) {
    if (/currency/i.test(header)) currencyColumns.push(offset);
  });
  var money = numeric.some(function (value) {
    return /spend|cost|revenue|sales|amount|budget|price|profit|expense/i.test(
      headers[value.sourceColumnOffset]
    );
  });
  var mixed = [];
  currencyColumns.forEach(function (offset) {
    if (!numeric.length) return;
    var codes = Object.create(null);
    all(offset).forEach(function (entry, index) {
      var hasValue = numeric.some(function (value) {
        return dmvChatPivotFilled_(all(value.sourceColumnOffset)[index]);
      });
      if (!hasValue) return;
      if (typeof entry !== 'string' || !/^[A-Z]{3}$/.test(entry))
        throw new Error('Every numeric row needs an explicit three-letter currency code.');
      codes[entry] = true;
    });
    if ((money || Object.keys(codes).length > 1) && !used[offset])
      throw new Error(
        'Group money and mixed-currency values by the currency column. Pivot totals never combine currencies.'
      );
    if (Object.keys(codes).length > 1) mixed.push(offset);
  });
  return mixed;
}

// The label a group shows for one source cell: a date as its bucket in the spreadsheet's time
// zone, any other value as it is. cache keeps labels and the time zone across calls.
function dmvChatPivotLabel_(session, cache, group, value) {
  if (Object.prototype.toString.call(value) !== '[object Date]') return value;
  var rule = group.groupRule && group.groupRule.dateTimeRule.type;
  var key = value.getTime() + ':' + rule;
  if (Object.prototype.hasOwnProperty.call(cache, key)) return cache[key];
  if (!cache.timezone) cache.timezone = session.spreadsheet.getSpreadsheetTimeZone();
  var iso = Utilities.formatDate(value, cache.timezone, 'yyyy-MM-dd');
  return (cache[key] =
    rule === 'YEAR'
      ? iso.slice(0, 4)
      : rule === 'YEAR_QUARTER'
        ? iso.slice(0, 4) + '-Q' + Math.ceil(Number(iso.slice(5, 7)) / 3)
        : rule === 'YEAR_MONTH'
          ? iso.slice(0, 7)
          : rule === 'YEAR_MONTH_DAY'
            ? iso
            : value.toISOString());
}

// A sheet id none of these tabs uses.
function dmvChatPivotSheetId_(sheets) {
  var ids = sheets.map(function (sheet) {
    return sheet.getSheetId();
  });
  for (var attempt = 0; attempt < 5; attempt++) {
    var sheetId =
      (parseInt(dmvOutputDigest_(Utilities.getUuid()).slice(0, 8), 16) % 2147483646) + 1;
    if (ids.indexOf(sheetId) < 0) return sheetId;
  }
  throw new Error('Could not allocate a new pivot tab. Try again.');
}

/* The original options */

function dmvChatCreatePivot_(session, input) {
  if (dmvChatPivotExtended_(input)) return dmvChatPivotAnalyst_(session, input);
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
    var headers = dmvChatPivotHeaders_(session, source, area);
    var grouped = Object.create(null);
    var rows = dmvChatPivotGroups_(input.rows, area.columns, grouped, true, false);
    var columns = dmvChatPivotGroups_(
      input.columns === undefined ? [] : input.columns,
      area.columns,
      grouped,
      false,
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
    dmvChatPivotNamed_(headers, rows.concat(columns, values));
    // Empty future rows remain part of the native source range.
    var data = dmvChatPivotReader_(session, source, area),
      all = dmvChatPivotEveryRow_(session, source, area, data);
    var numeric = values.filter(function (value) {
      return DMV_CHAT_PIVOT.numeric.indexOf(value.summarizeFunction) >= 0;
    });
    dmvChatPivotCheckTypes_(data, numeric, rows.concat(columns));
    dmvChatPivotCurrencies_(headers, numeric, grouped, all);
    var columnKeys = Object.create(null),
      labels = Object.create(null),
      columnCount = 1;
    if (columns.length) {
      for (var r = 0; r < area.checked; r++)
        columnKeys[
          JSON.stringify(
            columns.map(function (group) {
              return dmvChatPivotLabel_(session, labels, group, data(group.sourceColumnOffset)[r]);
            })
          )
        ] = true;
      columnCount = Object.keys(columnKeys).length;
    }
    var outputRows = Math.max(100, area.checked + 1 + columns.length + 2);
    var outputColumns = Math.max(26, rows.length + columnCount * values.length + values.length);
    if (outputColumns > 512 || outputRows * outputColumns > 1000000)
      throw new Error(
        'This pivot could exceed 512 columns or 1,000,000 output cells. Use fewer column groups or a smaller source range.'
      );
    // Include tabs created earlier in this turn, so a new pivot cannot reuse their ids.
    var sheetId = dmvChatPivotSheetId_(dmvChatSeeNewTabs_(session).getSheets());
    var pivot = {
      source: area.grid,
      rows: rows,
      columns: columns,
      values: values,
      valueLayout: 'HORIZONTAL',
    };
    var chartRange = dmvChatPivotChartRange_(session, all, area, pivot, {
      row: 1,
      column: 1,
    });
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
    dmvChatSeeNewTabs_(session);
    var url = dmvSheetUrl_(session.spreadsheet, sheetId, 'A1');
    var text =
      'Created a native pivot table on ' + target + ' from ' + source.getName() + '!' + area.a1;
    session.events.push({ kind: 'write', links: [{ label: target, url: url }], text: text });
    dmvChatUndoNone_(
      session,
      { action: 'create_pivot', sheetId: sheetId, sheetName: target, range: 'A1', text: text },
      dmvChatUndoNewTab_(target)
    );
    var result = {
      ok: true,
      sheetName: target,
      anchorCell: 'A1',
      nativePivot: true,
      url: url,
      sourceSheet: source.getName(),
      sourceRange: area.a1,
      rowGroups: rows.length,
      columnGroups: columns.length,
      valueColumns: values.length,
      note: 'The native pivot stays linked to this bounded source range. No source cells were changed; currency-mixing totals are disabled.',
    };
    if (chartRange) result.chartRange = chartRange;
    return result;
  });
}

/* The analyst options */

// True when a create_pivot call uses an option the original tool did not have.
function dmvChatPivotExtended_(input) {
  if (!input || Object.prototype.toString.call(input) !== '[object Object]') return false;
  if (
    ['targetCell', 'filters', 'totals'].some(function (key) {
      return input[key] !== undefined;
    })
  )
    return true;
  function list(value) {
    return Array.isArray(value) ? value : [];
  }
  return (
    list(input.rows)
      .concat(list(input.columns))
      .some(function (group) {
        return (
          !!group &&
          (group.order !== undefined ||
            group.sortByValue !== undefined ||
            group.dateBucket === 'quarter')
        );
      }) ||
    list(input.values).some(function (value) {
      return !!value && (value.showAs !== undefined || value.summarize === 'MEDIAN');
    })
  );
}

function dmvChatPivotAnalyst_(session, input) {
  dmvChatSheetObject_(input, [
    'sourceSheet',
    'sourceRange',
    'targetSheet',
    'targetCell',
    'rows',
    'columns',
    'values',
    'filters',
    'totals',
  ]);
  if (JSON.stringify(input).length > 12000) throw new Error('The pivot definition is too large.');
  dmvChatSheetDeadline_(session);
  // The pipeline adds the lock, the protected-output guard, undo for a pivot placed on an
  // existing tab, the single batch, the write event and the output link.
  return dmvChatSheetRunAction_(
    session,
    { action: 'create_pivot', pivot: input },
    {
      target: 'none',
      fields: ['pivot'],
      plan: function (context) {
        return dmvChatPivotPlan_(context.session, context.input.pivot);
      },
    }
  );
}

function dmvChatPivotValues_(input, width) {
  if (!Array.isArray(input) || !input.length || input.length > 8)
    throw new Error('Choose between 1 and 8 pivot values.');
  var chosen = Object.create(null);
  return input.map(function (value) {
    dmvChatSheetObject_(value, ['column', 'summarize', 'showAs']);
    var offset = dmvChatPivotColumn_(value.column, width);
    if (DMV_CHAT_PIVOT.functions.indexOf(value.summarize) < 0)
      throw new Error('Choose SUM, COUNT, COUNTA, AVERAGE, MIN, MAX or MEDIAN for pivot values.');
    if (
      value.showAs !== undefined &&
      !Object.prototype.hasOwnProperty.call(DMV_CHAT_PIVOT.showAs, value.showAs)
    )
      throw new Error(
        'showAs is percent_of_row_total, percent_of_column_total or percent_of_grand_total.'
      );
    var key = [offset, value.summarize, value.showAs || ''].join(':');
    if (chosen[key]) throw new Error('Do not repeat the same pivot value and aggregation.');
    chosen[key] = true;
    var output = { sourceColumnOffset: offset, summarizeFunction: value.summarize };
    if (value.showAs !== undefined)
      output.calculatedDisplayType = DMV_CHAT_PIVOT.showAs[value.showAs];
    return output;
  });
}

// With several currencies a total may only add up groups nested inside the currency group, and
// a percentage may only divide by a total along an axis that keeps one currency. Sets showTotals
// where totals are safe and returns the headers of groups whose totals were left out.
function dmvChatPivotTotals_(input, rows, columns, values, mixed, headers) {
  function position(list, offset) {
    for (var i = 0; i < list.length; i++) if (list[i].sourceColumnOffset === offset) return i;
    return -1;
  }
  var mixedRows = mixed.some(function (offset) {
      return position(rows, offset) >= 0;
    }),
    mixedColumns = mixed.some(function (offset) {
      return position(columns, offset) >= 0;
    });
  values.forEach(function (value) {
    var shown = value.calculatedDisplayType;
    if (
      (shown === 'PERCENT_OF_GRAND_TOTAL' && mixed.length) ||
      (shown === 'PERCENT_OF_ROW_TOTAL' && mixedColumns) ||
      (shown === 'PERCENT_OF_COLUMN_TOTAL' && mixedRows)
    )
      throw new Error(
        'This percentage would divide by a total of different currencies. Filter the pivot to one currency, or use a percentage along the axis the currency column groups.'
      );
  });
  if (input.totals !== undefined && typeof input.totals !== 'boolean')
    throw new Error('totals must be true or false.');
  var withheld = [];
  if (input.totals)
    [rows, columns].forEach(function (list) {
      list.forEach(function (group, index) {
        var safe = mixed.every(function (offset) {
          var at = position(list, offset);
          return at < 0 || index > at;
        });
        if (safe) group.showTotals = true;
        else withheld.push(headers[group.sourceColumnOffset]);
      });
    });
  return withheld;
}

// filterSpecs from { column, values } or { column, condition }. A value no text cell holds would
// quietly empty the pivot, so it is refused: a pivot lists number and date cells as it displays
// them ('8/1/2026', '1,000'), which only a condition filter matches reliably. A condition shows
// every value meeting it only with visibleByDefault; otherwise a value must also be listed in
// visibleValues, and none is.
function dmvChatPivotFilters_(filters, area, headers, data) {
  if (filters === undefined) filters = [];
  if (!Array.isArray(filters) || filters.length > DMV_CHAT_PIVOT.maxFilters)
    throw new Error('Use at most ' + DMV_CHAT_PIVOT.maxFilters + ' pivot filters.');
  var filtered = Object.create(null);
  return filters.map(function (filter) {
    dmvChatSheetObject_(filter, ['column', 'values', 'condition']);
    var offset = dmvChatPivotColumn_(filter.column, area.columns);
    if (filtered[offset]) throw new Error('Use one pivot filter per source column.');
    filtered[offset] = true;
    if ((filter.values === undefined) === (filter.condition === undefined))
      throw new Error('A pivot filter takes either values or a condition.');
    if (filter.condition !== undefined)
      return {
        columnOffsetIndex: offset,
        filterCriteria: {
          condition: dmvChatSheetCondition_(filter.condition, { formatting: false }),
          visibleByDefault: true,
        },
      };
    if (
      !Array.isArray(filter.values) ||
      !filter.values.length ||
      filter.values.length > DMV_CHAT_PIVOT.maxFilterValues
    )
      throw new Error('A pivot filter lists 1 to ' + DMV_CHAT_PIVOT.maxFilterValues + ' values.');
    var shown = filter.values.map(function (value) {
      if (typeof value === 'number' && Number.isFinite(value)) value = String(value);
      if (typeof value !== 'string' || !value.length || value.length > 500)
        throw new Error(
          'Pivot filter values are texts of 1 to 500 characters, as the cells show them.'
        );
      return value;
    });
    var present = Object.create(null),
      other = false;
    data(offset).forEach(function (entry) {
      if (typeof entry === 'string') present[entry] = true;
      else if (dmvChatPivotFilled_(entry)) other = true;
    });
    shown.forEach(function (value) {
      if (present[value]) return;
      throw new Error(
        other
          ? 'No text cell under "' +
              headers[offset] +
              '" is exactly "' +
              value.slice(0, 100) +
              '", and "' +
              headers[offset] +
              '" holds numbers or dates, which a pivot lists as it displays them. Use a condition filter such as number_eq, number_between, date_eq, date_after or date_before.'
          : 'No cell under "' +
              headers[offset] +
              '" is exactly "' +
              value.slice(0, 100) +
              '". Filter values match the cells exactly, including case.'
      );
    });
    return { columnOffsetIndex: offset, filterCriteria: { visibleValues: shown } };
  });
}

// An upper bound of the lines a list of groups takes: one per distinct value of the last group
// (leaves) and one per distinct value of each group above it (for subtotals).
function dmvChatPivotLines_(session, labels, data, rowCount, list) {
  if (!list.length) return { leaves: 1, above: 0 };
  var levels = list.map(function () {
    return Object.create(null);
  });
  for (var r = 0; r < rowCount; r++) {
    var key = '';
    for (var level = 0; level < list.length; level++) {
      var group = list[level];
      key +=
        JSON.stringify(
          dmvChatPivotLabel_(session, labels, group, data(group.sourceColumnOffset)[r])
        ) + '\u0001';
      levels[level][key] = true;
    }
  }
  var sizes = levels.map(function (level) {
    return Object.keys(level).length;
  });
  return {
    leaves: sizes[sizes.length - 1],
    above: sizes.slice(0, -1).reduce(function (sum, size) {
      return sum + size;
    }, 0),
  };
}

// The summary create_chart reads from a pivot anchored at { row, column }: its header row and a
// row per group, above any grand total. Given for one row group with no column groups or filters,
// whose rows are then its groups, counted over every source row (all, dmvChatPivotEveryRow_), so
// a group further down is never left out.
function dmvChatPivotChartRange_(session, all, area, pivot, anchor) {
  if (pivot.rows.length !== 1 || pivot.columns.length || pivot.filterSpecs) return null;
  var groups = dmvChatPivotLines_(session, Object.create(null), all, area.rows - 1, pivot.rows);
  return (
    dmvChatA1_(anchor.row, anchor.column) +
    ':' +
    dmvChatA1_(anchor.row + groups.leaves, anchor.column + pivot.values.length)
  );
}

// The create_pivot plan for dmvChatSheetRunAction_. Source checks match the original options;
// totals and percentages that would add up different currencies are left out or refused.
function dmvChatPivotPlan_(session, input) {
  var source = dmvChatSheetTarget_(session, input.sourceSheet);
  var placed = input.targetCell !== undefined,
    target = placed ? dmvChatSheetTarget_(session, input.targetSheet) : null,
    targetName = placed ? target.getName() : dmvSheetName_(input.targetSheet),
    // Tabs earlier tools of this turn created are included, so a new tab reuses no name or id.
    tabs = placed ? [] : dmvChatSeeNewTabs_(session).getSheets(),
    cell = null;
  if (placed) {
    if (
      typeof input.targetCell !== 'string' ||
      !/^[A-Za-z]{1,3}[1-9][0-9]{0,6}$/.test(input.targetCell)
    )
      throw new Error('targetCell is one cell of targetSheet, such as H2.');
    cell = dmvCell_(input.targetCell.toUpperCase());
  } else if (
    tabs.some(function (sheet) {
      return sheet.getName().toLowerCase() === targetName.toLowerCase();
    })
  )
    throw new Error(
      'The pivot output tab already exists. Choose a new tab name, or give targetCell to place the pivot on that tab.'
    );
  var area = dmvChatPivotArea_(source, input.sourceRange);
  var headers = dmvChatPivotHeaders_(session, source, area);
  var used = Object.create(null);
  var rows = dmvChatPivotGroups_(input.rows, area.columns, used, true, true);
  var columns = dmvChatPivotGroups_(
    input.columns === undefined ? [] : input.columns,
    area.columns,
    used,
    false,
    true
  );
  var values = dmvChatPivotValues_(input.values, area.columns);
  rows.concat(columns).forEach(function (group) {
    if (!group.valueBucket) return;
    var index = group.valueBucket.valuesIndex;
    if (!Number.isInteger(index) || index < 1 || index > values.length)
      throw new Error('sortByValue is the 1-based position of one of the pivot values.');
    // With no buckets, Sheets sorts by the value's grand total across the other axis.
    group.valueBucket = { valuesIndex: index - 1 };
  });
  var data = dmvChatPivotReader_(session, source, area),
    all = dmvChatPivotEveryRow_(session, source, area, data);
  var filterSpecs = dmvChatPivotFilters_(input.filters, area, headers, data);
  dmvChatPivotNamed_(headers, rows.concat(columns, values, filterSpecs));
  var numeric = values.filter(function (value) {
    return DMV_CHAT_PIVOT.numeric.indexOf(value.summarizeFunction) >= 0;
  });
  dmvChatPivotCheckTypes_(data, numeric, rows.concat(columns));
  var mixed = dmvChatPivotCurrencies_(headers, numeric, used, all);
  var withheld = dmvChatPivotTotals_(input, rows, columns, values, mixed, headers);
  // Row groups are only read when a placed pivot or subtotals need their size.
  var labels = Object.create(null);
  var down =
      placed || input.totals ? dmvChatPivotLines_(session, labels, data, area.checked, rows) : null,
    across = dmvChatPivotLines_(session, labels, data, area.checked, columns);
  var outputColumns =
    rows.length + values.length * (columns.length ? across.leaves + across.above + 1 : 1);
  var pivot = {
    source: area.grid,
    rows: rows,
    columns: columns,
    values: values,
    valueLayout: 'HORIZONTAL',
  };
  if (filterSpecs.length) pivot.filterSpecs = filterSpecs;
  function groupNames(list) {
    return list.map(function (group) {
      return headers[group.sourceColumnOffset];
    });
  }
  var valueNames = values.map(function (value) {
    return (
      value.summarizeFunction +
      ' of ' +
      headers[value.sourceColumnOffset] +
      (value.calculatedDisplayType
        ? ' as ' + value.calculatedDisplayType.toLowerCase().replace(/_/g, ' ')
        : '')
    );
  });
  var notes = [
    'The native pivot stays linked to this bounded source range. No source cells were changed.',
  ];
  if (withheld.length)
    notes.push(
      'Totals were left out for ' +
        withheld.join(', ') +
        ', because they would add up different currencies.'
    );
  var result = {
    nativePivot: true,
    sourceSheet: source.getName(),
    sourceRange: area.a1,
    rowGroups: rows.length,
    columnGroups: columns.length,
    valueColumns: values.length,
    rowsBy: groupNames(rows),
    columnsBy: groupNames(columns),
    valuesShown: valueNames,
    filters: filterSpecs.length,
    totals: !!input.totals,
    note: notes.join(' '),
  };
  var chartRange = dmvChatPivotChartRange_(
    session,
    all,
    area,
    pivot,
    cell || { row: 1, column: 1 }
  );
  if (chartRange) result.chartRange = chartRange;
  var layout = {
    source: source,
    area: area,
    pivot: pivot,
    targetName: targetName,
    outputColumns: outputColumns,
    columnGroups: columns.length,
    down: down,
    totals: !!input.totals,
    result: result,
    details: [
      ['Source', source.getName() + '!' + area.a1],
      ['Rows', result.rowsBy],
      ['Columns', result.columnsBy],
      ['Values', valueNames],
      ['Filters', filterSpecs.length || ''],
    ],
  };
  return placed
    ? dmvChatPivotPlaced_(session, layout, target, cell)
    : dmvChatPivotNewTab_(layout, tabs);
}

// On an existing tab the cells the pivot could fill must be empty, inside the grid and away
// from its source and from DataMoov output; undo removes the pivot and restores them.
function dmvChatPivotPlaced_(session, layout, target, cell) {
  var area = layout.area,
    targetName = layout.targetName,
    outputColumns = layout.outputColumns;
  var outputRows = layout.columnGroups + 2 + layout.down.leaves + layout.down.above + 1;
  if (outputRows * outputColumns > DMV_SHEET_UNDO.maxCells)
    throw new Error(
      'This pivot could need ' +
        outputRows +
        ' rows and ' +
        outputColumns +
        ' columns, too many to place on an existing tab. Leave out targetCell to create it on a new tab.'
    );
  var place = {
    sheetId: target.getSheetId(),
    startRowIndex: cell.row - 1,
    endRowIndex: cell.row - 1 + outputRows,
    startColumnIndex: cell.column - 1,
    endColumnIndex: cell.column - 1 + outputColumns,
  };
  if (place.endRowIndex > target.getMaxRows() || place.endColumnIndex > target.getMaxColumns())
    throw new Error(
      'This pivot could need ' +
        outputRows +
        ' rows and ' +
        outputColumns +
        ' columns from ' +
        cell.a1 +
        ', beyond the grid of "' +
        targetName +
        '". Choose another cell, or leave out targetCell to create it on a new tab.'
    );
  if (
    dmvRectanglesOverlap_(
      {
        sheetId: place.sheetId,
        row: cell.row,
        column: cell.column,
        rows: outputRows,
        columns: outputColumns,
      },
      {
        sheetId: area.grid.sheetId,
        row: area.row,
        column: area.column,
        rows: area.rows,
        columns: area.columns,
      }
    )
  )
    throw new Error('The pivot would cover its own source range. Choose a cell outside it.');
  // Checked here too, so DataMoov output is refused by its owner's name before its cells count.
  dmvChatSheetGuard_(session, [place]);
  var filled = 0;
  dmvChatSheetCells_(session, [place])[0].cells.forEach(function (row) {
    row.forEach(function (entry) {
      if (
        (entry.userEnteredValue && Object.keys(entry.userEnteredValue).length) ||
        (entry.effectiveValue && Object.keys(entry.effectiveValue).length)
      )
        filled++;
    });
  });
  if (filled)
    throw new Error(
      'The cells this pivot could fill (' +
        targetName +
        '!' +
        dmvChatGridA1_(place) +
        ') hold ' +
        filled +
        (filled === 1 ? ' non-empty cell' : ' non-empty cells') +
        '. Choose an empty area, or leave out targetCell to create it on a new tab.'
    );
  layout.result.anchorCell = cell.a1;
  return {
    requests: [
      {
        updateCells: {
          start: {
            sheetId: place.sheetId,
            rowIndex: place.startRowIndex,
            columnIndex: place.startColumnIndex,
          },
          rows: [{ values: [{ pivotTable: layout.pivot }] }],
          fields: 'pivotTable',
        },
      },
    ],
    touches: [place],
    undo: {
      snapshot: [place],
      reverse: [
        {
          updateCells: {
            range: {
              sheetId: place.sheetId,
              startRowIndex: place.startRowIndex,
              endRowIndex: place.startRowIndex + 1,
              startColumnIndex: place.startColumnIndex,
              endColumnIndex: place.startColumnIndex + 1,
            },
            fields: 'pivotTable',
          },
        },
      ],
    },
    sheetName: targetName,
    sheetId: place.sheetId,
    range: cell.a1,
    text:
      'Created a native pivot table at ' +
      targetName +
      '!' +
      cell.a1 +
      ' from ' +
      layout.source.getName() +
      '!' +
      area.a1,
    details: layout.details,
    result: layout.result,
  };
}

// A new tab, sized like the original options' with room for subtotals. Undo answers that the user
// can delete it, as with the original options.
function dmvChatPivotNewTab_(layout, tabs) {
  var area = layout.area;
  var gridRows = Math.max(
    100,
    area.checked + 1 + layout.columnGroups + 2 + (layout.totals ? layout.down.above : 0)
  );
  var gridColumns = Math.max(26, layout.outputColumns);
  if (gridColumns > 512 || gridRows * gridColumns > 1000000)
    throw new Error(
      'This pivot could exceed 512 columns or 1,000,000 output cells. Use fewer column groups or a smaller source range.'
    );
  var sheetId = dmvChatPivotSheetId_(tabs);
  layout.result.anchorCell = 'A1';
  return {
    requests: [
      {
        addSheet: {
          properties: {
            sheetId: sheetId,
            title: layout.targetName,
            gridProperties: { rowCount: gridRows, columnCount: gridColumns },
          },
        },
      },
      {
        updateCells: {
          start: { sheetId: sheetId, rowIndex: 0, columnIndex: 0 },
          rows: [{ values: [{ pivotTable: layout.pivot }] }],
          fields: 'pivotTable',
        },
      },
    ],
    touches: [],
    undo: { hint: dmvChatUndoNewTab_(layout.targetName) },
    sheetName: layout.targetName,
    sheetId: sheetId,
    range: 'A1',
    text:
      'Created a native pivot table on ' +
      layout.targetName +
      ' from ' +
      layout.source.getName() +
      '!' +
      area.a1,
    details: layout.details,
    result: layout.result,
  };
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
        enum: ['day', 'month', 'quarter', 'year'],
        description:
          'Optional native grouping for real date cells only. ISO text can be grouped without a bucket.',
      },
      order: { type: 'string', enum: ['asc', 'desc'], description: 'Default asc.' },
      sortByValue: {
        type: 'integer',
        minimum: 1,
        maximum: 8,
        description: 'Sort by the total of this value (1-based position in values), not by label.',
      },
    },
    required: ['column'],
    additionalProperties: false,
  };
  return [
    {
      name: 'create_pivot',
      description:
        'Create a real native Google Sheets pivot in a NEW tab (or at targetCell of an existing tab, over empty cells), linked to an explicit source range including its header (a whole tab or a formula result). At most 80 source columns. Source cells are not changed. Choose 1 to 6 row groups, 0 to 6 column groups and 1 to 8 value aggregations, optionally shown as a percent of a total; optional filters, per-group sort and totals; no formulas. Money beside a currency-code column is grouped by it; totals and percentages that would add up different currencies are left out or refused. Native date buckets need actual date cells. Empty future rows within the existing source grid may be included. With one row group, its result gives chartRange, the summary for create_chart: no inspection needed.',
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
            description:
              'A new output tab name; existing tabs are never overwritten. With targetCell, an existing tab.',
          },
          targetCell: {
            type: 'string',
            description:
              'Optional cell of an existing targetSheet, such as H2; the cells the pivot needs must be empty.',
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
                  enum: ['SUM', 'COUNT', 'COUNTA', 'AVERAGE', 'MIN', 'MAX', 'MEDIAN'],
                },
                showAs: {
                  type: 'string',
                  enum: [
                    'percent_of_row_total',
                    'percent_of_column_total',
                    'percent_of_grand_total',
                  ],
                },
              },
              required: ['column', 'summarize'],
              additionalProperties: false,
            },
          },
          filters: {
            type: 'array',
            maxItems: 6,
            items: {
              type: 'object',
              properties: {
                column: { type: 'integer', minimum: 1, maximum: 80 },
                values: {
                  type: 'array',
                  maxItems: 100,
                  items: { type: 'string' },
                  description:
                    'Show only rows whose text cell is exactly one of these. Filter numbers and dates with a condition.',
                },
                condition: dmvChatSheetConditionSchema_(false),
              },
              required: ['column'],
              additionalProperties: false,
            },
          },
          totals: {
            type: 'boolean',
            description: 'Show subtotals and grand totals; default false.',
          },
        },
        required: ['sourceSheet', 'sourceRange', 'targetSheet', 'rows', 'values'],
        additionalProperties: false,
      },
      run: dmvChatCreatePivot_,
    },
  ];
}
