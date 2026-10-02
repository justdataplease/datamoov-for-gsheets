/* Analyst edit_sheet actions: copy and move, rows and columns, cleanup, validation, notes and
   links, named ranges and tab operations. Each action is registered here and runs through
   dmvChatSheetRunAction_ (dmv_chat_sheet_safety.js), which owns the inspection token, the
   protected-output guard, confirmation, undo, the single batch and the write event.

   An action spec, keyed by its edit_sheet action name:
     target  'range' (default): needs the inspected sheetName, range and editToken; the cells are
             checked against the inspection before plan runs.
             'sheet': needs only sheetName (tab-level actions such as delete_sheet).
             'none': needs neither (actions that create something new).
     fields  input keys the action takes besides action, sheetName, range, editToken and
             confirmToken; any other key is refused.
     plan(context)  validates the input and returns what to do. context holds session, input,
             sheet (the target tab or null), area (dmvChatSheetArea_ of the range or null) and
             snapshot (the inspected cells, from dmvChatSheetRead_, or null). It returns:
       requests   validated Sheets requests, sent in one batch (required)
       touches    bounded GridRanges whose cells change; guarded and, by default, snapshotted for
                  undo and checked unchanged before an undo (default: the inspected range)
       guard      more GridRanges to guard; a missing end index means the rest of the tab, so
                  { sheetId } guards a whole tab and { sheetId, startRowIndex: 9 } every row
                  from row 10 (what an insert or delete there moves)
       overwrite  true when touches are replaced: more than 200 non-empty cells asks first
       confirm    a summary that makes the user confirm first (delete, dedupe, whole-tab
                  find/replace)
       undo       omit for a cell snapshot of touches; null when there is nothing to restore
                  (hide, freeze); { none: 'reason' } when it cannot be undone (asks first); or
                  { snapshot: [GridRange], reverse: [requests], verify: [GridRange], rules,
                  sheet } where undo sends reverse first, then restores the snapshot cells,
                  after checking that verify (in after-edit coordinates) is unchanged; rules
                  (a sheetId) also checks that tab's conditional format rules, for a reverse
                  that names a rule by its position; extent (a sheetId) also checks that the
                  tab's data reaches as far as after the edit; named ({ id, name, after })
                  checks a named range (dmvChatActionNamedUnchanged_); dims (sheetIds) adds
                  tabs to the row and column check below for a reverse with no cells; delete_sheet
                  puts dmvChatUndoSheetCopy_(session, sheet).requests before its deleteSheet
                  and uses its undo. Undo also refuses once rows or columns of the tabs of
                  snapshot and verify were inserted or deleted, or a later chat edit moved
                  cells there
       text, details, sheetName, sheetId, range   the write event and result links
       result     extra result fields; after(response, context) may return more once written
   Built-in action names win over these. Helpers: dmvChatSheetGuard_, dmvChatSheetCells_,
   dmvChatSheetNonEmpty_, dmvChatGridA1_, dmvChatUndoSheetCopy_ and, for tools of their own,
   dmvChatConfirmFind_, dmvChatConfirmIssue_ and dmvChatConfirmSpend_.

   Range actions work on the inspected range (at most 1,000 cells, 200 rows and 30 columns), so
   the model has read what it changes; find_replace can widen to the tab's data (at most 50,000
   cells, always asked first). Row and column actions take start and count on a tab: at most 500
   inserted or deleted per call, deletions always asked first. */
var DMV_SHEET_ACTIONS = {
  dimensionCount: 500,
  findCells: 50000,
  regexText: 5000,
  listValues: 500,
  paste: {
    all: 'PASTE_NORMAL',
    values: 'PASTE_VALUES',
    formats: 'PASTE_FORMAT',
    formulas: 'PASTE_FORMULA',
  },
  delimiters: {
    comma: ['COMMA', ','],
    semicolon: ['SEMICOLON', ';'],
    period: ['PERIOD', '.'],
    space: ['SPACE', ' '],
  },
  numberConditions: {
    gt: 'NUMBER_GREATER',
    gte: 'NUMBER_GREATER_THAN_EQ',
    lt: 'NUMBER_LESS',
    lte: 'NUMBER_LESS_THAN_EQ',
    eq: 'NUMBER_EQ',
    ne: 'NUMBER_NOT_EQ',
    between: 'NUMBER_BETWEEN',
    not_between: 'NUMBER_NOT_BETWEEN',
  },
  dateConditions: {
    before: 'DATE_BEFORE',
    after: 'DATE_AFTER',
    on_or_before: 'DATE_ON_OR_BEFORE',
    on_or_after: 'DATE_ON_OR_AFTER',
    eq: 'DATE_EQ',
    between: 'DATE_BETWEEN',
    not_between: 'DATE_NOT_BETWEEN',
  },
};

function dmvChatSheetActions_() {
  function dimension(kind, name) {
    return function (context) {
      return kind(context, name);
    };
  }
  var span = ['start', 'count'];
  return {
    copy_range: {
      fields: ['destination', 'pasteType'],
      plan: function (context) {
        return dmvChatActionPaste_(context, false);
      },
    },
    move_range: {
      fields: ['destination', 'pasteType'],
      plan: function (context) {
        return dmvChatActionPaste_(context, true);
      },
    },
    insert_rows: { target: 'sheet', fields: span, plan: dimension(dmvChatActionInsert_, 'ROWS') },
    insert_columns: {
      target: 'sheet',
      fields: span,
      plan: dimension(dmvChatActionInsert_, 'COLUMNS'),
    },
    delete_rows: { target: 'sheet', fields: span, plan: dimension(dmvChatActionDelete_, 'ROWS') },
    delete_columns: {
      target: 'sheet',
      fields: span,
      plan: dimension(dmvChatActionDelete_, 'COLUMNS'),
    },
    group_rows: { target: 'sheet', fields: span, plan: dimension(dmvChatActionGroup_, 'ROWS') },
    group_columns: {
      target: 'sheet',
      fields: span,
      plan: dimension(dmvChatActionGroup_, 'COLUMNS'),
    },
    ungroup_rows: {
      target: 'sheet',
      fields: span,
      plan: dimension(dmvChatActionUngroup_, 'ROWS'),
    },
    ungroup_columns: {
      target: 'sheet',
      fields: span,
      plan: dimension(dmvChatActionUngroup_, 'COLUMNS'),
    },
    find_replace: {
      fields: ['find', 'replacement', 'matchCase', 'matchEntireCell', 'useRegex', 'wholeSheet'],
      plan: dmvChatActionFindReplace_,
    },
    remove_duplicates: {
      fields: ['keyColumns', 'keep', 'headerRows'],
      plan: dmvChatActionRemoveDuplicates_,
    },
    highlight_duplicates: {
      fields: ['keyColumns', 'headerRows', 'color'],
      plan: dmvChatActionHighlightDuplicates_,
    },
    trim_whitespace: { plan: dmvChatActionTrim_ },
    split_columns: { fields: ['delimiter'], plan: dmvChatActionSplit_ },
    data_validation: { fields: ['validation'], plan: dmvChatActionValidation_ },
    set_notes: { fields: ['notes'], plan: dmvChatActionNotes_ },
    set_links: { fields: ['links'], plan: dmvChatActionLinks_ },
    named_range: { target: 'none', fields: ['sheetName', 'namedRange'], plan: dmvChatActionNamed_ },
    duplicate_sheet: { target: 'sheet', fields: ['newName'], plan: dmvChatActionDuplicateSheet_ },
    delete_sheet: { target: 'sheet', plan: dmvChatActionDeleteSheet_ },
    hide_sheet: {
      target: 'sheet',
      plan: function (context) {
        return dmvChatActionHide_(context, true);
      },
    },
    show_sheet: {
      target: 'sheet',
      plan: function (context) {
        return dmvChatActionHide_(context, false);
      },
    },
  };
}

// Action names for the edit_sheet enum and input properties these actions add to its schema.
function dmvChatSheetActionSchema_() {
  function text() {
    return { type: 'string' };
  }
  return {
    actions: Object.keys(dmvChatSheetActions_()),
    properties: {
      destination: {
        type: 'string',
        description:
          "copy_range/move_range (range = inspected source): top-left cell of the destination, on this tab or another ('Tab name'!B2).",
      },
      pasteType: {
        type: 'string',
        enum: ['all', 'values', 'formats', 'formulas'],
        description: 'copy_range; move_range takes only all.',
      },
      start: {
        type: 'integer',
        minimum: 1,
        description:
          'insert_/delete_/group_/ungroup_ rows or columns (sheetName only): first row or column number (A=1); inserts go before it.',
      },
      count: {
        type: 'integer',
        minimum: 1,
        description: 'How many rows or columns; at most 500 inserted or deleted.',
      },
      find: { type: 'string', description: 'find_replace: text (or regex) to find.' },
      replacement: text(),
      matchCase: { type: 'boolean' },
      matchEntireCell: { type: 'boolean' },
      useRegex: { type: 'boolean' },
      wholeSheet: {
        type: 'boolean',
        description: "find_replace: search the whole tab's data, not just the inspected range.",
      },
      keyColumns: {
        type: 'array',
        items: { type: 'integer', minimum: 1 },
        description:
          'remove_/highlight_duplicates: one-based columns within the range that must match; default all.',
      },
      keep: { type: 'string', enum: ['first', 'last'] },
      color: { type: 'string', description: 'highlight_duplicates background, #RRGGBB.' },
      delimiter: {
        type: 'string',
        description:
          'split_columns: comma, semicolon, period, space, auto (default) or the exact separator text.',
      },
      validation: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['list', 'range', 'checkbox', 'number', 'date', 'clear'],
          },
          values: { type: 'array', items: text(), description: 'list: the dropdown values.' },
          source: { type: 'string', description: "range: the dropdown cells, 'Tab'!A2:A20." },
          condition: {
            type: 'string',
            enum: [
              'gt',
              'gte',
              'lt',
              'lte',
              'eq',
              'ne',
              'between',
              'not_between',
              'before',
              'after',
              'on_or_before',
              'on_or_after',
            ],
          },
          value: { type: 'string', description: 'A number, or a date as YYYY-MM-DD.' },
          value2: { type: 'string', description: 'The upper bound for between.' },
          strict: { type: 'boolean', description: 'Reject other input (default true).' },
        },
        required: ['type'],
      },
      notes: {
        type: 'array',
        items: { type: 'array', items: text() },
        description: 'set_notes: matrix matching the range; an empty string removes a note.',
      },
      links: {
        type: 'array',
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              url: { type: 'string', description: 'https only; empty removes the link.' },
              text: { type: 'string', description: 'Shown text; default keeps the cell text.' },
            },
            required: ['url'],
          },
        },
        description: 'set_links: matrix matching the range.',
      },
      namedRange: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['add', 'update', 'delete'] },
          name: text(),
          newName: text(),
          range: { type: 'string', description: "'Tab'!A1:B9 (add, or update to move it)." },
        },
        required: ['operation', 'name'],
      },
    },
  };
}

/* Small shared pieces */

function dmvChatActionFlag_(input, key) {
  if (input[key] === undefined) return false;
  if (typeof input[key] !== 'boolean') throw new Error(key + ' must be true or false.');
  return input[key];
}

function dmvChatActionTab_(name) {
  return "'" + String(name).replace(/'/g, "''") + "'!";
}

function dmvChatActionColumn_(column) {
  return dmvChatA1_(1, column).slice(0, -1);
}

function dmvChatActionNoun_(dimension, count) {
  return (dimension === 'ROWS' ? 'row' : 'column') + (count === 1 ? '' : 's');
}

// "B2", "Tab!B2:C9" or "'Tab name'!B2:C9" as { sheet, grid, a1, rows, columns }: a bounded range
// inside the tab's grid. Without a tab name the range is on defaultSheet, when one is given.
function dmvChatActionA1_(session, text, defaultSheet, label) {
  var usage = label + " must be an A1 cell or range such as B2 or 'Tab name'!A1:C9.";
  if (typeof text !== 'string' || text.length > 200) throw new Error(usage);
  var match =
    /^(?:'((?:[^']|'')+)'!|([^'!]+)!)?([A-Za-z]{1,3}[1-9][0-9]{0,6}(?::[A-Za-z]{1,3}[1-9][0-9]{0,6})?)$/.exec(
      text.trim()
    );
  if (!match) throw new Error(usage);
  var name = match[1] !== undefined ? match[1].replace(/''/g, "'") : match[2];
  var sheet = name !== undefined ? dmvChatSheetTarget_(session, name) : defaultSheet;
  if (!sheet) throw new Error(label + " must name its tab, such as 'Tab name'!A1:C9.");
  var parts = match[3].toUpperCase().split(':'),
    start = dmvCell_(parts[0]),
    end = dmvCell_(parts[1] || parts[0]);
  if (end.row < start.row || end.column < start.column)
    throw new Error(label + ' must run from its top-left to its bottom-right cell.');
  if (end.row > sheet.getMaxRows() || end.column > sheet.getMaxColumns())
    throw new Error(label + ' is outside the grid of tab "' + sheet.getName() + '".');
  var grid = {
    sheetId: sheet.getSheetId(),
    startRowIndex: start.row - 1,
    endRowIndex: end.row,
    startColumnIndex: start.column - 1,
    endColumnIndex: end.column,
  };
  return {
    sheet: sheet,
    grid: grid,
    a1: dmvChatGridA1_(grid),
    rows: end.row - start.row + 1,
    columns: end.column - start.column + 1,
  };
}

// The cells of one tab's data (from A1 to the last row and column with values) as a GridRange.
function dmvChatActionUsed_(sheet) {
  var used = sheet.getDataRange();
  return {
    sheetId: sheet.getSheetId(),
    startRowIndex: 0,
    endRowIndex: Math.max(1, used.getNumRows()),
    startColumnIndex: 0,
    endColumnIndex: Math.max(1, used.getNumColumns()),
  };
}

// The inspected range without its header rows (0 or 1, default 1, as for sort).
function dmvChatActionBody_(context) {
  var input = context.input,
    area = context.area;
  var headers = dmvChatSheetInteger_(
    input.headerRows === undefined ? 1 : input.headerRows,
    0,
    1,
    'Header rows'
  );
  if (headers >= area.rows) throw new Error('The range must include a data row below its header.');
  var grid = Object.assign({}, area.grid);
  grid.startRowIndex += headers;
  return { grid: grid, headers: headers, cells: context.snapshot.cells.slice(headers) };
}

// One-based columns within the range, sorted and unique; all of them when none are given.
function dmvChatActionKeyColumns_(input, columns) {
  if (input.keyColumns === undefined)
    return Array.from({ length: columns }, function (_, index) {
      return index + 1;
    });
  if (!Array.isArray(input.keyColumns) || !input.keyColumns.length || input.keyColumns.length > 30)
    throw new Error('keyColumns lists one-based columns within the range, such as [2].');
  var keys = [];
  input.keyColumns.forEach(function (column) {
    column = dmvChatSheetInteger_(column, 1, columns, 'Key column');
    if (keys.indexOf(column) < 0) keys.push(column);
  });
  return keys.sort(function (a, b) {
    return a - b;
  });
}

// What a cell compares as for duplicates: its value, text without regard to case.
function dmvChatActionKey_(cell) {
  var value = cell.effectiveValue || cell.userEnteredValue || {};
  if (value.stringValue !== undefined) return 's' + String(value.stringValue).toLowerCase();
  if (value.numberValue !== undefined) return 'n' + value.numberValue;
  if (value.boolValue !== undefined) return 'b' + value.boolValue;
  if (value.errorValue) return 'e' + value.errorValue.type;
  return '';
}

function dmvChatActionHasFormula_(cells) {
  return cells.some(function (row) {
    return row.some(function (cell) {
      return !!(cell.userEnteredValue && cell.userEnteredValue.formulaValue !== undefined);
    });
  });
}

// A saved report or dashboard that writes to this tab, by kind, or ''.
function dmvChatActionTabUser_(session, sheet) {
  var name = sheet.getName();
  if (
    dmvList_('dashboard').some(function (dashboard) {
      return (
        dashboard.spreadsheetId === session.spreadsheetId &&
        [dashboard.target, dashboard.dataTarget]
          .concat(dashboard.outputs || [])
          .concat(dashboard.plan ? [{ sheetName: dmvDashboardChartTab_(dashboard.target) }] : [])
          .some(function (target) {
            return target && target.sheetName === name;
          })
      );
    })
  )
    return 'dashboard';
  if (
    dmvList_('report').some(function (report) {
      return (
        report.spreadsheetId === session.spreadsheetId &&
        report.target &&
        report.target.sheetName === name
      );
    })
  )
    return 'report';
  return '';
}

/* Copy and move */

function dmvChatActionPaste_(context, move) {
  var input = context.input,
    area = context.area,
    sheet = context.sheet;
  var type = input.pasteType === undefined ? 'all' : input.pasteType;
  if (
    typeof type !== 'string' ||
    !Object.prototype.hasOwnProperty.call(DMV_SHEET_ACTIONS.paste, type)
  )
    throw new Error('Choose pasteType all, values, formats or formulas.');
  // Sheets cuts all of the source whatever a move pastes, so the rest would be lost.
  if (move && type !== 'all')
    throw new Error(
      'move_range always moves everything (pasteType all), because Sheets empties the whole source. To take only ' +
        type +
        ', use copy_range with that pasteType, then clear the source if the user wants it gone.'
    );
  if (input.destination === undefined)
    throw new Error("Give the destination's top-left cell, such as 'Tab name'!B2.");
  var target = dmvChatActionA1_(context.session, input.destination, sheet, 'destination');
  if (
    !(target.rows === 1 && target.columns === 1) &&
    (target.rows !== area.rows || target.columns !== area.columns)
  )
    throw new Error(
      'Give the destination as its top-left cell, or as a range the same size as the source.'
    );
  var top = target.grid.startRowIndex,
    left = target.grid.startColumnIndex;
  if (
    top + area.rows > target.sheet.getMaxRows() ||
    left + area.columns > target.sheet.getMaxColumns()
  )
    throw new Error(
      'The destination runs past the grid of tab "' +
        target.sheet.getName() +
        '". Insert rows or columns there first.'
    );
  var destination = {
    sheetId: target.sheet.getSheetId(),
    startRowIndex: top,
    endRowIndex: top + area.rows,
    startColumnIndex: left,
    endColumnIndex: left + area.columns,
  };
  if (dmvChatGridKey_(destination) === dmvChatGridKey_(area.grid))
    throw new Error('The destination is the source itself. Choose another place.');
  var from = sheet.getName() + '!' + area.a1,
    to = target.sheet.getName() + '!' + dmvChatGridA1_(destination);
  var plan = {
    sheetName: target.sheet.getName(),
    sheetId: target.sheet.getSheetId(),
    range: dmvChatGridA1_(destination),
    text:
      (move ? 'Moved ' : 'Copied ') +
      from +
      ' to ' +
      to +
      (type === 'all' ? '' : ' (' + type + ')'),
    details: [
      ['From', from],
      ['Paste', type],
    ],
    result: { from: from, to: to, pasteType: type },
  };
  if (!move) {
    plan.requests = [
      {
        copyPaste: {
          source: area.grid,
          destination: destination,
          pasteType: DMV_SHEET_ACTIONS.paste[type],
          pasteOrientation: 'NORMAL',
        },
      },
    ];
    plan.touches = [destination];
    plan.overwrite = true;
    return plan;
  }
  // A move empties the source, so only destination cells outside it count as replaced.
  var replaced = 0;
  dmvChatSheetCells_(context.session, [destination])[0].cells.forEach(function (row, r) {
    row.forEach(function (cell, c) {
      var inside =
        destination.sheetId === area.grid.sheetId &&
        top + r >= area.grid.startRowIndex &&
        top + r < area.grid.endRowIndex &&
        left + c >= area.grid.startColumnIndex &&
        left + c < area.grid.endColumnIndex;
      if (!inside && cell.userEnteredValue && Object.keys(cell.userEnteredValue).length) replaced++;
    });
  });
  plan.requests = [
    {
      cutPaste: {
        source: area.grid,
        destination: { sheetId: destination.sheetId, rowIndex: top, columnIndex: left },
        pasteType: DMV_SHEET_ACTIONS.paste[type],
      },
    },
  ];
  plan.touches = [area.grid, destination];
  if (replaced > DMV_SHEET_UNDO.overwriteCells)
    plan.confirm = 'Moving ' + from + ' replaces ' + replaced + ' non-empty cells in ' + to + '.';
  // Undo moves the block back, so formulas that followed it follow it home, then restores both
  // areas as they were.
  plan.undo = {
    snapshot: [area.grid, destination],
    reverse: [
      {
        cutPaste: {
          source: destination,
          destination: {
            sheetId: area.grid.sheetId,
            rowIndex: area.grid.startRowIndex,
            columnIndex: area.grid.startColumnIndex,
          },
          pasteType: 'PASTE_NORMAL',
        },
      },
    ],
    verify: [area.grid, destination],
  };
  return plan;
}

/* Rows and columns */

// start (one-based) and count as a DimensionRange. An insert may start one past the last row or
// column, to append.
function dmvChatActionSpan_(sheet, input, dimension, insert, maximum) {
  var limit = dimension === 'ROWS' ? sheet.getMaxRows() : sheet.getMaxColumns();
  if (input.start === undefined)
    throw new Error('Give start, the first row or column number (A=1), and count.');
  var start = dmvChatSheetInteger_(input.start, 1, limit + (insert ? 1 : 0), 'start');
  var count = dmvChatSheetInteger_(
    input.count === undefined ? 1 : input.count,
    1,
    maximum,
    'count'
  );
  if (!insert && start + count - 1 > limit)
    throw new Error(
      'The tab "' +
        sheet.getName() +
        '" has ' +
        limit +
        ' ' +
        dmvChatActionNoun_(dimension, limit) +
        '; choose a smaller count.'
    );
  return {
    sheetId: sheet.getSheetId(),
    dimension: dimension,
    startIndex: start - 1,
    endIndex: start - 1 + count,
  };
}

function dmvChatActionSpanText_(span) {
  var first = span.startIndex + 1,
    last = span.endIndex;
  if (span.dimension === 'COLUMNS') {
    first = dmvChatActionColumn_(first);
    last = dmvChatActionColumn_(last);
  }
  return (
    dmvChatActionNoun_(span.dimension, span.endIndex - span.startIndex) +
    ' ' +
    first +
    (first === last ? '' : '-' + last)
  );
}

// The cells of a span across the whole tab, as a GridRange.
function dmvChatActionSpanGrid_(sheet, dimension, startIndex, endIndex) {
  return dimension === 'ROWS'
    ? {
        sheetId: sheet.getSheetId(),
        startRowIndex: startIndex,
        endRowIndex: endIndex,
        startColumnIndex: 0,
        endColumnIndex: sheet.getMaxColumns(),
      }
    : {
        sheetId: sheet.getSheetId(),
        startRowIndex: 0,
        endRowIndex: sheet.getMaxRows(),
        startColumnIndex: startIndex,
        endColumnIndex: endIndex,
      };
}

// Everything from the span on moves, so DataMoov output there or after it is refused.
function dmvChatActionSpanGuard_(span) {
  var guard = { sheetId: span.sheetId };
  guard[span.dimension === 'ROWS' ? 'startRowIndex' : 'startColumnIndex'] = span.startIndex;
  return guard;
}

function dmvChatActionInsert_(context, dimension) {
  var sheet = context.sheet,
    span = dmvChatActionSpan_(
      sheet,
      context.input,
      dimension,
      true,
      DMV_SHEET_ACTIONS.dimensionCount
    );
  var limit = dimension === 'ROWS' ? sheet.getMaxRows() : sheet.getMaxColumns(),
    count = span.endIndex - span.startIndex;
  var noun = dmvChatActionNoun_(dimension, count);
  var where =
    span.startIndex === limit
      ? 'at the end'
      : 'before ' +
        (dimension === 'ROWS'
          ? 'row ' + (span.startIndex + 1)
          : 'column ' + dmvChatActionColumn_(span.startIndex + 1));
  // New rows take the format of the row below them, like Insert above; appended ones the row above.
  var plan = {
    requests: [
      {
        insertDimension: {
          range: span,
          inheritFromBefore: span.startIndex === limit && limit > 0,
        },
      },
    ],
    guard: [dmvChatActionSpanGuard_(span)],
    text: 'Inserted ' + count + ' ' + noun + ' ' + where + ' in ' + sheet.getName(),
    details: [['Inserted', dmvChatActionSpanText_(span)]],
    result: { inserted: count, at: dmvChatActionSpanText_(span) },
  };
  var added = dmvChatActionSpanGrid_(sheet, dimension, span.startIndex, span.endIndex);
  // Undo deletes the new rows again while they are still as inserted.
  plan.undo =
    dmvChatGridCells_(added) > DMV_SHEET_UNDO.maxCells
      ? null
      : { reverse: [{ deleteDimension: { range: span } }], verify: [added] };
  if (!plan.undo) plan.result.note = 'The tab is too wide to undo this here; delete them by hand.';
  return plan;
}

function dmvChatActionDelete_(context, dimension) {
  var sheet = context.sheet,
    span = dmvChatActionSpan_(
      sheet,
      context.input,
      dimension,
      false,
      DMV_SHEET_ACTIONS.dimensionCount
    );
  var limit = dimension === 'ROWS' ? sheet.getMaxRows() : sheet.getMaxColumns(),
    count = span.endIndex - span.startIndex,
    label = dmvChatActionSpanText_(span);
  if (count >= limit)
    throw new Error(
      'A tab must keep at least one ' + dmvChatActionNoun_(dimension, 1) + '. Delete fewer.'
    );
  // Sheets also refuses to delete every row or column that is not frozen.
  var frozen = dmvChatActionFrozen_(context.session, sheet, dimension),
    keptFrozen = frozen - Math.max(0, Math.min(span.endIndex, frozen) - span.startIndex);
  if (frozen && limit - count <= keptFrozen)
    throw new Error(
      'Sheets keeps at least one ' +
        dmvChatActionNoun_(dimension, 1) +
        ' that is not frozen. Delete fewer, or unfreeze ' +
        dmvChatActionNoun_(dimension, 2) +
        ' first.'
    );
  var removed = dmvChatActionSpanGrid_(sheet, dimension, span.startIndex, span.endIndex);
  // After the deletion: the row or column on each side of the gap. Undo puts the cells back only
  // while those are still where they were.
  var seam = dmvChatActionSpanGrid_(
    sheet,
    dimension,
    Math.max(0, span.startIndex - 1),
    Math.min(span.startIndex + 1, limit - count)
  );
  return {
    requests: [{ deleteDimension: { range: span } }],
    touches: [],
    guard: [dmvChatActionSpanGuard_(span)],
    confirm:
      'Delete ' +
      label +
      ' of tab "' +
      sheet.getName() +
      '", with everything in them? Formulas elsewhere that point at them will show #REF!.',
    undo: {
      snapshot: [removed],
      // Sheets refuses inheritFromBefore false when the rows go back at the end of the tab.
      reverse: [
        {
          insertDimension: {
            range: span,
            inheritFromBefore: span.startIndex === limit - count,
          },
        },
      ],
      verify: [seam],
    },
    text: 'Deleted ' + label + ' of ' + sheet.getName(),
    details: [['Deleted', label]],
    result: { deleted: count, at: label },
  };
}

// How many rows or columns of the tab are frozen.
function dmvChatActionFrozen_(session, sheet, dimension) {
  dmvChatSheetDeadline_(session);
  var result = Sheets.Spreadsheets.get(session.spreadsheetId, {
    fields: 'sheets(properties(sheetId,gridProperties(frozenRowCount,frozenColumnCount)))',
  });
  var entry =
    ((result && result.sheets) || []).filter(function (item) {
      return ((item.properties && item.properties.sheetId) || 0) === sheet.getSheetId();
    })[0] || {};
  var grid = (entry.properties && entry.properties.gridProperties) || {};
  return (dimension === 'ROWS' ? grid.frozenRowCount : grid.frozenColumnCount) || 0;
}

// The group depth of each index of a dimension, from the tab's row or column groups.
function dmvChatActionDepths_(session, sheet, dimension) {
  dmvChatSheetDeadline_(session);
  var result = Sheets.Spreadsheets.get(session.spreadsheetId, {
    fields: 'sheets(properties.sheetId,rowGroups,columnGroups)',
  });
  var entry =
    ((result && result.sheets) || []).filter(function (item) {
      return ((item.properties && item.properties.sheetId) || 0) === sheet.getSheetId();
    })[0] || {};
  var groups = (dimension === 'ROWS' ? entry.rowGroups : entry.columnGroups) || [];
  return function (index) {
    var depth = 0;
    groups.forEach(function (group) {
      var range = group.range || {};
      if ((range.startIndex || 0) <= index && index < range.endIndex)
        depth = Math.max(depth, group.depth || 0);
    });
    return depth;
  };
}

function dmvChatActionGroup_(context, dimension) {
  var sheet = context.sheet,
    limit = dimension === 'ROWS' ? sheet.getMaxRows() : sheet.getMaxColumns(),
    span = dmvChatActionSpan_(sheet, context.input, dimension, false, limit);
  var depth = dmvChatActionDepths_(context.session, sheet, dimension);
  for (var index = span.startIndex; index < span.endIndex; index++)
    if (depth(index) >= 8) throw new Error('Groups nest at most 8 levels deep.');
  var label = dmvChatActionSpanText_(span);
  return {
    requests: [{ addDimensionGroup: { range: span } }],
    touches: [],
    undo: {
      reverse: [{ deleteDimensionGroup: { range: span } }],
      verify: [],
      dims: [sheet.getSheetId()],
    },
    text: 'Grouped ' + label + ' of ' + sheet.getName(),
    details: [['Grouped', label]],
    result: { grouped: label },
  };
}

function dmvChatActionUngroup_(context, dimension) {
  var sheet = context.sheet,
    limit = dimension === 'ROWS' ? sheet.getMaxRows() : sheet.getMaxColumns(),
    span = dmvChatActionSpan_(sheet, context.input, dimension, false, limit);
  var depth = dmvChatActionDepths_(context.session, sheet, dimension);
  // Ungrouping lowers each one by a level, so undo can raise exactly the same ones again.
  for (var index = span.startIndex; index < span.endIndex; index++)
    if (!depth(index))
      throw new Error(
        'Not all of ' +
          dmvChatActionSpanText_(span) +
          ' are grouped. Ungroup exactly the grouped ' +
          dmvChatActionNoun_(dimension, 2) +
          '.'
      );
  var label = dmvChatActionSpanText_(span);
  return {
    requests: [{ deleteDimensionGroup: { range: span } }],
    touches: [],
    undo: {
      reverse: [{ addDimensionGroup: { range: span } }],
      verify: [],
      dims: [sheet.getSheetId()],
    },
    text: 'Ungrouped ' + label + ' of ' + sheet.getName(),
    details: [['Ungrouped', label]],
    result: { ungrouped: label },
  };
}

/* Cleanup */

// The entered text a find/replace looks at: literal values, never formulas or errors.
function dmvChatActionText_(cell) {
  var value = cell.userEnteredValue;
  if (!value || value.formulaValue !== undefined || value.errorValue) return null;
  if (value.stringValue !== undefined) return String(value.stringValue);
  if (value.numberValue !== undefined) return String(value.numberValue);
  if (value.boolValue !== undefined) return value.boolValue ? 'TRUE' : 'FALSE';
  return null;
}

// What the number and date cells of a grid show (3/15/2023, $1,200.00), as a matrix of text
// beside cells, or null when the grid holds no typed numbers. Sheets finds and splits such cells
// by that text, not by the number behind it.
function dmvChatActionShown_(session, grid, cells) {
  var numbers = cells.some(function (row) {
    return row.some(function (cell) {
      var value = cell.userEnteredValue;
      return !!value && value.numberValue !== undefined;
    });
  });
  if (!numbers) return null;
  return dmvChatSheetCells_(session, [grid], 'formattedValue')[0].cells.map(function (row) {
    return row.map(function (cell) {
      return typeof cell.formattedValue === 'string' ? cell.formattedValue : null;
    });
  });
}

// The texts a find/replace may match in a cell: its entered text and, for a number or date, also
// what it shows, since which one Sheets matches depends on the cell. Counting both keeps the
// question and the formula check on the side of caution.
function dmvChatActionTexts_(cell, shown) {
  var text = dmvChatActionText_(cell);
  if (text === null) return [];
  return cell.userEnteredValue.numberValue !== undefined && shown !== null && shown !== text
    ? [text, shown]
    : [text];
}

// A JavaScript pattern that matches like the Sheets request, to count matches and check results
// before anything is written. Regular expressions that can take very long are refused.
function dmvChatActionPattern_(find, regex, matchCase, entire) {
  var source = find;
  if (regex) {
    if (find.length > 200) throw new Error('Keep the regular expression under 200 characters.');
    if (/\\[1-9]|\(\?<?[=!]/.test(find))
      throw new Error('Sheets regular expressions have no back-references or lookarounds.');
    if (dmvChatRegexNested_(find))
      throw new Error(
        'Use a simpler regular expression, without a repeated group that repeats or has alternatives.'
      );
  } else source = find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  var pattern;
  try {
    pattern = new RegExp(entire ? '^(?:' + source + ')$' : source, matchCase ? 'g' : 'gi');
  } catch (error) {
    throw new Error('That regular expression is not valid.');
  }
  pattern.lastIndex = 0;
  if (pattern.test('')) throw new Error('The text to find must not match an empty cell.');
  pattern.lastIndex = 0;
  return pattern;
}

// Sheets applies a regular-expression replacement by Java's rules, where \x is a literal x and
// $0 the whole match, while the check below runs JavaScript's, where both stay as typed and $&,
// $` and $' mean more. Only $1 to $9 for groups the pattern has mean the same in both, so the
// text checked is the text Sheets writes.
function dmvChatActionReplacement_(replacement, pattern) {
  if (/\\/.test(replacement) || /\$(?![1-9])/.test(replacement))
    throw new Error(
      'In a regular-expression replacement use $1 to $9 for groups; backslashes and other $ signs are not supported. Replace literal text with useRegex false.'
    );
  var groups = new RegExp(pattern.source + '|').exec('').length - 1;
  (replacement.match(/\$[1-9]/g) || []).forEach(function (reference) {
    if (Number(reference.charAt(1)) > groups)
      throw new Error(
        'The replacement uses ' +
          reference +
          ', but the expression has ' +
          groups +
          (groups === 1 ? ' group.' : ' groups.')
      );
  });
}

function dmvChatActionFindReplace_(context) {
  var input = context.input,
    session = context.session,
    sheet = context.sheet;
  if (typeof input.find !== 'string' || !input.find || input.find.length > 500)
    throw new Error('find must be text of 1 to 500 characters.');
  var replacement = input.replacement === undefined ? '' : input.replacement;
  if (typeof replacement !== 'string' || replacement.length > 1000)
    throw new Error('replacement must be text of at most 1,000 characters.');
  var matchCase = dmvChatActionFlag_(input, 'matchCase'),
    entire = dmvChatActionFlag_(input, 'matchEntireCell'),
    regex = dmvChatActionFlag_(input, 'useRegex'),
    whole = dmvChatActionFlag_(input, 'wholeSheet');
  var pattern = dmvChatActionPattern_(input.find, regex, matchCase, entire);
  if (regex) dmvChatActionReplacement_(replacement, pattern);
  var grid = context.area.grid,
    cells = context.snapshot.cells,
    where = sheet.getName() + '!' + context.area.a1;
  if (whole) {
    grid = dmvChatActionUsed_(sheet);
    if (dmvChatGridCells_(grid) > DMV_SHEET_ACTIONS.findCells)
      throw new Error(
        'The data of tab "' +
          sheet.getName() +
          '" spans more than 50,000 cells. Replace within inspected ranges instead.'
      );
    cells = dmvChatSheetCells_(session, [grid])[0].cells;
    where = sheet.getName() + '!' + dmvChatGridA1_(grid) + ' (the whole tab)';
  }
  var changed = 0,
    occurrences = 0,
    shown = dmvChatActionShown_(session, grid, cells);
  cells.forEach(function (row, r) {
    row.forEach(function (cell, c) {
      var most = 0;
      dmvChatActionTexts_(cell, shown && shown[r][c]).forEach(function (text) {
        if (regex && text.length > DMV_SHEET_ACTIONS.regexText)
          throw new Error(
            'A cell holds more than 5,000 characters; find it without useRegex instead.'
          );
        pattern.lastIndex = 0;
        var found = text.match(pattern);
        if (!found) return;
        pattern.lastIndex = 0;
        var next = regex
          ? text.replace(pattern, replacement)
          : text.replace(pattern, function () {
              return replacement;
            });
        // Sheets enters the result again; text that would read as a formula is never produced.
        if (/^[=+-]/.test(next) && !(next.trim() !== '' && Number.isFinite(Number(next))))
          throw new Error(
            'The replacement would turn ' +
              sheet.getName() +
              '!' +
              dmvChatA1_(grid.startRowIndex + r + 1, grid.startColumnIndex + c + 1) +
              ' into text starting with ' +
              next.charAt(0) +
              ', which Sheets reads as a formula. Choose another replacement.'
          );
        most = Math.max(most, found.length);
      });
      if (!most) return;
      changed++;
      occurrences += most;
    });
  });
  if (!changed) throw new Error('Nothing in ' + where + ' matches "' + input.find + '".');
  // The model's text is quoted and cut short, so the scope after it is always shown in full and
  // cannot be imitated by a quote inside it.
  function quoted(text) {
    var shown = JSON.stringify(text);
    return shown.length > 62 ? shown.slice(0, 60) + '…"' : shown;
  }
  var summary =
    'Replace ' +
    occurrences +
    ' match' +
    (occurrences === 1 ? '' : 'es') +
    ' of ' +
    quoted(input.find) +
    ' with ' +
    quoted(replacement) +
    ' in ' +
    changed +
    ' cell' +
    (changed === 1 ? '' : 's') +
    ' of ' +
    where +
    '.';
  return {
    requests: [
      {
        findReplace: {
          find: input.find,
          replacement: replacement,
          matchCase: matchCase,
          matchEntireCell: entire,
          searchByRegex: regex,
          includeFormulas: false,
          range: grid,
        },
      },
    ],
    touches: [grid],
    confirm: whole || changed > DMV_SHEET_UNDO.overwriteCells ? summary : '',
    range: dmvChatGridA1_(grid),
    text: 'Replaced "' + input.find + '" in ' + where,
    details: [
      ['Find', input.find],
      ['Replace with', replacement || '(nothing)'],
    ],
    after: function (response) {
      var reply = (((response && response.replies) || [])[0] || {}).findReplace || {};
      return {
        cellsChanged: (reply.valuesChanged || 0) + (reply.formulasChanged || 0),
        occurrencesChanged: reply.occurrencesChanged || 0,
      };
    },
  };
}

function dmvChatActionRemoveDuplicates_(context) {
  var input = context.input,
    sheet = context.sheet,
    body = dmvChatActionBody_(context);
  var keep = input.keep === undefined ? 'first' : input.keep;
  if (keep !== 'first' && keep !== 'last') throw new Error('Choose keep first or last.');
  var keys = dmvChatActionKeyColumns_(input, context.area.columns);
  var rows = body.cells.map(function (row) {
    return JSON.stringify(
      keys.map(function (column) {
        return dmvChatActionKey_(row[column - 1]);
      })
    );
  });
  // Rows to keep: the first (or last) of each key, in their original order.
  var kept = rows
    .map(function (key, index) {
      return (keep === 'first' ? rows.indexOf(key) : rows.lastIndexOf(key)) === index ? index : -1;
    })
    .filter(function (index) {
      return index >= 0;
    });
  var removed = rows.length - kept.length,
    where = sheet.getName() + '!' + dmvChatGridA1_(body.grid),
    on = keys
      .map(function (column) {
        return dmvChatActionColumn_(context.area.grid.startColumnIndex + column);
      })
      .join(', ');
  if (!removed) throw new Error('No duplicate rows in ' + where + ' compared on ' + on + '.');
  var plan = {
    touches: [body.grid],
    confirm:
      'Remove ' +
      removed +
      ' duplicate row' +
      (removed === 1 ? '' : 's') +
      ' from ' +
      where +
      ', compared on column' +
      (keys.length === 1 ? ' ' : 's ') +
      on +
      ', keeping the ' +
      keep +
      ' of each? Rows below move up inside the range.',
    text: 'Removed duplicate rows from ' + where,
    details: [
      ['Compared on', on],
      ['Kept', keep],
    ],
    result: { removed: removed, kept: kept.length },
  };
  if (keep === 'first') {
    plan.requests = [
      {
        deleteDuplicates: {
          range: body.grid,
          comparisonColumns: keys.map(function (column) {
            var index = context.area.grid.startColumnIndex + column - 1;
            return {
              sheetId: body.grid.sheetId,
              dimension: 'COLUMNS',
              startIndex: index,
              endIndex: index + 1,
            };
          }),
        },
      },
    ];
    // Sheets' own count wins over the estimate above, which the question used.
    plan.after = function (response) {
      var reply = (((response && response.replies) || [])[0] || {}).deleteDuplicates || {};
      var count = reply.duplicatesRemovedCount || 0;
      return { removed: count, kept: rows.length - count };
    };
    return plan;
  }
  // Sheets keeps the first row of each; keeping the last rewrites the range with the kept rows
  // moved up. Formulas would not follow such a rewrite, so ranges with formulas are refused.
  if (dmvChatActionHasFormula_(body.cells))
    throw new Error('keep last works on ranges without formulas. Use keep first instead.');
  plan.requests = [
    {
      updateCells: {
        range: body.grid,
        rows: body.cells.map(function (row, index) {
          var source = index < kept.length ? body.cells[kept[index]] : null;
          return {
            values: row.map(function (cell, column) {
              return source ? dmvChatUndoCell_(source[column]) : {};
            }),
          };
        }),
        fields: DMV_SHEET_UNDO.restoreFields,
      },
    },
  ];
  return plan;
}

function dmvChatActionHighlightDuplicates_(context) {
  var input = context.input,
    sheet = context.sheet,
    body = dmvChatActionBody_(context);
  var keys = dmvChatActionKeyColumns_(input, context.area.columns);
  var color = dmvChatSheetColor_(input.color === undefined ? '#F4CCCC' : input.color);
  var first = body.grid.startRowIndex + 1,
    last = body.grid.endRowIndex;
  var letters = keys.map(function (column) {
    return dmvChatActionColumn_(context.area.grid.startColumnIndex + column);
  });
  // Rows count as equal when every key cell is equal (= ignores case), and blank keys never match.
  // SUMPRODUCT rather than COUNTIF, so text such as * or >5 is not read as a pattern. Each
  // comparison counts an error cell (#N/A from a lookup) as no match; otherwise one error in a key
  // column would make the rule an error, and so false, on every row.
  var formula =
    '=AND(IFERROR(LEN(' +
    letters
      .map(function (letter) {
        return '$' + letter + first;
      })
      .join('&') +
    ')>0,FALSE),SUMPRODUCT(' +
    letters
      .map(function (letter) {
        return (
          'IFERROR(($' +
          letter +
          '$' +
          first +
          ':$' +
          letter +
          '$' +
          last +
          '=$' +
          letter +
          first +
          ')*1,0)'
        );
      })
      .join('*') +
    ')>1)';
  var where = sheet.getName() + '!' + dmvChatGridA1_(body.grid);
  return {
    requests: [
      {
        addConditionalFormatRule: {
          rule: {
            ranges: [body.grid],
            booleanRule: {
              condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: formula }] },
              format: { backgroundColorStyle: { rgbColor: color } },
            },
          },
          index: 0,
        },
      },
    ],
    // A conditional format changes no cells, so it is allowed over report output like formatting.
    touches: [],
    undo: {
      reverse: [{ deleteConditionalFormatRule: { sheetId: sheet.getSheetId(), index: 0 } }],
      verify: [],
      rules: sheet.getSheetId(),
    },
    range: dmvChatGridA1_(body.grid),
    text: 'Highlighted duplicate rows in ' + where,
    details: [['Compared on', letters.join(', ')]],
    result: { rule: formula },
  };
}

function dmvChatActionTrim_(context) {
  var changing = 0;
  context.snapshot.cells.forEach(function (row) {
    row.forEach(function (cell) {
      var value = cell.userEnteredValue;
      if (!value || value.stringValue === undefined) return;
      var text = String(value.stringValue);
      if (text.replace(/^\s+|\s+$/g, '').replace(/\s+/g, ' ') !== text) changing++;
    });
  });
  var where = context.sheet.getName() + '!' + context.area.a1;
  if (!changing) throw new Error('No text in ' + where + ' has extra spaces to trim.');
  return {
    requests: [{ trimWhitespace: { range: context.area.grid } }],
    text: 'Trimmed extra spaces in ' + where,
    after: function (response) {
      var reply = (((response && response.replies) || [])[0] || {}).trimWhitespace || {};
      return { cellsChanged: reply.cellsChangedCount || 0 };
    },
  };
}

function dmvChatActionSplit_(context) {
  var input = context.input,
    area = context.area,
    sheet = context.sheet;
  if (area.columns !== 1)
    throw new Error('split_columns splits one column; inspect it alone, such as B1:B200.');
  var delimiter = input.delimiter === undefined ? 'auto' : input.delimiter;
  if (typeof delimiter !== 'string' || !delimiter || delimiter.length > 20)
    throw new Error('delimiter is comma, semicolon, period, space, auto or up to 20 characters.');
  var known = DMV_SHEET_ACTIONS.delimiters[delimiter.toLowerCase()],
    request = { source: area.grid };
  if (delimiter.toLowerCase() === 'auto') request.delimiterType = 'AUTODETECT';
  else if (known) request.delimiterType = known[0];
  else {
    request.delimiterType = 'CUSTOM';
    request.delimiter = delimiter;
  }
  if (dmvChatActionHasFormula_(context.snapshot.cells))
    throw new Error('split_columns splits typed text, not formulas.');
  // The widest split decides how many columns to the right are written; with auto, the widest
  // any likely separator would give.
  var separators =
    request.delimiterType === 'AUTODETECT'
      ? [',', ';', '.', ' ', '|', '\t']
      : [known ? known[1] : delimiter];
  var widest = 1;
  var where = sheet.getName() + '!' + area.a1;
  // Number and date cells split by the text they show, so 1/5/2024 split on / gives 3 pieces.
  var shown = dmvChatActionShown_(context.session, area.grid, context.snapshot.cells);
  context.snapshot.cells.forEach(function (row, r) {
    var value = row[0].userEnteredValue,
      text = null;
    if (value && value.stringValue !== undefined) text = String(value.stringValue);
    else if (value && value.numberValue !== undefined)
      text = shown && shown[r][0] !== null ? shown[r][0] : String(value.numberValue);
    if (text === null) return;
    separators.forEach(function (separator) {
      var pieces = text.split(separator);
      widest = Math.max(widest, pieces.length);
      // Sheets enters each piece as if typed, so a piece that reads as a formula is refused,
      // as find_replace refuses such a result. A lone - and negative numbers stay text or numbers.
      pieces.forEach(function (piece) {
        var text = piece.trim();
        if (/^(?:[=+]|-[^\d.$€£])/.test(text))
          throw new Error(
            'Splitting ' +
              sheet.getName() +
              '!' +
              dmvChatA1_(area.grid.startRowIndex + r + 1, area.grid.startColumnIndex + 1) +
              ' would give a piece starting with ' +
              text.charAt(0) +
              ', which Sheets reads as a formula. Change that cell first or choose another delimiter.'
          );
      });
    });
  });
  if (widest < 2) throw new Error('No text in ' + where + ' contains that separator.');
  if (area.grid.startColumnIndex + widest > sheet.getMaxColumns())
    throw new Error(
      'The split needs ' +
        (widest - 1) +
        ' more columns to the right of ' +
        where +
        '. Insert columns first.'
    );
  var right = {
    sheetId: area.grid.sheetId,
    startRowIndex: area.grid.startRowIndex,
    endRowIndex: area.grid.endRowIndex,
    startColumnIndex: area.grid.endColumnIndex,
    endColumnIndex: area.grid.endColumnIndex + widest - 1,
  };
  var filled = dmvChatSheetNonEmpty_(dmvChatSheetCells_(context.session, [right])[0].cells);
  return {
    requests: [{ textToColumns: request }],
    touches: [area.grid, right],
    confirm: filled
      ? 'Splitting ' +
        where +
        ' writes over ' +
        filled +
        ' non-empty cell' +
        (filled === 1 ? '' : 's') +
        ' in ' +
        sheet.getName() +
        '!' +
        dmvChatGridA1_(right) +
        '.'
      : '',
    range: dmvChatGridA1_({
      startRowIndex: area.grid.startRowIndex,
      endRowIndex: right.endRowIndex,
      startColumnIndex: area.grid.startColumnIndex,
      endColumnIndex: right.endColumnIndex,
    }),
    text: 'Split ' + where + ' into columns',
    details: [['Separator', delimiter]],
  };
}

/* Validation, notes and links */

function dmvChatActionValidation_(context) {
  var session = context.session,
    sheet = context.sheet,
    rule = context.input.validation;
  dmvChatSheetObject_(rule, ['type', 'values', 'source', 'condition', 'value', 'value2', 'strict']);
  var where = sheet.getName() + '!' + context.area.a1,
    request = { range: context.area.grid },
    condition = null,
    label = rule.type;
  function literal(value, what) {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value !== 'string' || !value.trim() || value.length > 255)
      throw new Error(what + ' must be text of 1 to 255 characters.');
    if (/^[=+]/.test(value.trim())) throw new Error(what + ' must be literal, not a formula.');
    return value;
  }
  function number(value) {
    var text = typeof value === 'string' ? value.trim() : value;
    if (
      (typeof text !== 'number' && typeof text !== 'string') ||
      text === '' ||
      !Number.isFinite(Number(text))
    )
      throw new Error('Number conditions need finite numbers.');
    return String(Number(text));
  }
  function date(value) {
    var match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    var parsed = match && new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
    if (!parsed || parsed.getUTCMonth() !== +match[2] - 1 || parsed.getUTCDate() !== +match[3])
      throw new Error('Date conditions need dates as YYYY-MM-DD.');
    return match[0];
  }
  function bounds(names, read) {
    var type = names[rule.condition];
    if (!type) throw new Error('Choose a condition: ' + Object.keys(names).join(', ') + '.');
    var values = [{ userEnteredValue: read(rule.value) }];
    if (/BETWEEN$/.test(type)) values.push({ userEnteredValue: read(rule.value2) });
    else if (rule.value2 !== undefined) throw new Error('value2 is only for between.');
    label =
      rule.type +
      ' ' +
      rule.condition +
      ' ' +
      values
        .map(function (item) {
          return item.userEnteredValue;
        })
        .join(' and ');
    return { type: type, values: values };
  }
  if (rule.type === 'list') {
    if (
      !Array.isArray(rule.values) ||
      !rule.values.length ||
      rule.values.length > DMV_SHEET_ACTIONS.listValues
    )
      throw new Error('A list needs 1 to 500 values.');
    condition = {
      type: 'ONE_OF_LIST',
      values: rule.values.map(function (value) {
        return { userEnteredValue: literal(value, 'Each list value') };
      }),
    };
    label = 'list of ' + rule.values.length;
  } else if (rule.type === 'range') {
    var source = dmvChatActionA1_(session, rule.source, sheet, 'source');
    var reference = dmvChatActionTab_(source.sheet.getName()) + source.a1;
    condition = { type: 'ONE_OF_RANGE', values: [{ userEnteredValue: '=' + reference }] };
    label = 'list from ' + reference;
  } else if (rule.type === 'checkbox') condition = { type: 'BOOLEAN' };
  else if (rule.type === 'number') condition = bounds(DMV_SHEET_ACTIONS.numberConditions, number);
  else if (rule.type === 'date') condition = bounds(DMV_SHEET_ACTIONS.dateConditions, date);
  else if (rule.type !== 'clear')
    throw new Error('Choose validation type list, range, checkbox, number, date or clear.');
  ['values', 'source', 'condition', 'value', 'value2'].forEach(function (key) {
    var used =
      (key === 'values' && rule.type === 'list') ||
      (key === 'source' && rule.type === 'range') ||
      ((rule.type === 'number' || rule.type === 'date') && key !== 'values' && key !== 'source');
    if (rule[key] !== undefined && !used)
      throw new Error(key + ' does not apply to a ' + rule.type + ' validation.');
  });
  if (condition) {
    request.rule = { condition: condition, strict: rule.strict === undefined ? true : rule.strict };
    if (typeof request.rule.strict !== 'boolean') throw new Error('strict must be true or false.');
    if (rule.type === 'list' || rule.type === 'range') request.rule.showCustomUi = true;
  } else if (rule.strict !== undefined) throw new Error('strict does not apply to clear.');
  // Without filteredRowsIncluded, Sheets leaves rows hidden by a filter out of both a set and a
  // clear.
  request.filteredRowsIncluded = true;
  return {
    requests: [{ setDataValidation: request }],
    text: (condition ? 'Set validation on ' : 'Cleared validation on ') + where,
    details: [['Validation', label]],
  };
}

// A matrix input of exactly the inspected shape.
function dmvChatActionMatrix_(matrix, area, label) {
  if (
    !Array.isArray(matrix) ||
    matrix.length !== area.rows ||
    matrix.some(function (row) {
      return !Array.isArray(row) || row.length !== area.columns;
    })
  )
    throw new Error('The ' + label + ' matrix must match the inspected range exactly.');
  return matrix;
}

function dmvChatActionNotes_(context) {
  var area = context.area,
    replaced = 0;
  var rows = dmvChatActionMatrix_(context.input.notes, area, 'notes').map(function (row, r) {
    return {
      values: row.map(function (note, c) {
        if (typeof note !== 'string' || note.length > 5000)
          throw new Error('Each note is text of at most 5,000 characters.');
        var before = context.snapshot.cells[r][c].note || '';
        if (before && before !== note) replaced++;
        return note ? { note: note } : {};
      }),
    };
  });
  var where = context.sheet.getName() + '!' + area.a1;
  return {
    requests: [{ updateCells: { range: area.grid, rows: rows, fields: 'note' } }],
    confirm:
      replaced > DMV_SHEET_UNDO.overwriteCells
        ? 'This replaces or removes ' + replaced + ' existing notes in ' + where + '.'
        : '',
    text: 'Updated notes in ' + where,
  };
}

function dmvChatActionLinks_(context) {
  var area = context.area,
    linked = 0;
  var rows = dmvChatActionMatrix_(context.input.links, area, 'links').map(function (row, r) {
    return {
      values: row.map(function (link, c) {
        dmvChatSheetObject_(link, ['url', 'text']);
        var url = link.url;
        if (
          typeof url !== 'string' ||
          url.length > 2000 ||
          (url && !/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?(?:[/?#][^\s"'<>\\]*)?$/.test(url))
        )
          throw new Error('Links must be https:// addresses (or empty to remove a link).');
        if (link.text !== undefined && (typeof link.text !== 'string' || link.text.length > 5000))
          throw new Error('Link text is text of at most 5,000 characters.');
        var current = context.snapshot.cells[r][c].userEnteredValue;
        var value =
          link.text !== undefined && link.text !== ''
            ? { stringValue: link.text }
            : current && Object.keys(current).length && !current.errorValue
              ? current
              : url
                ? { stringValue: url }
                : undefined;
        if (url) linked++;
        var cell = url ? { userEnteredFormat: { textFormat: { link: { uri: url } } } } : {};
        if (value) cell.userEnteredValue = value;
        return cell;
      }),
    };
  });
  var where = context.sheet.getName() + '!' + area.a1;
  return {
    requests: [
      {
        updateCells: {
          range: area.grid,
          rows: rows,
          fields: 'userEnteredValue,userEnteredFormat.textFormat.link,textFormatRuns',
        },
      },
    ],
    overwrite: true,
    text: 'Set links in ' + where,
    details: [['Links', linked]],
  };
}

/* Named ranges */

function dmvChatActionNamedRanges_(session) {
  dmvChatSheetDeadline_(session);
  var result = Sheets.Spreadsheets.get(session.spreadsheetId, {
    fields: 'namedRanges(namedRangeId,name,range)',
  });
  return ((result && result.namedRanges) || []).map(function (named) {
    var range = named.range || {};
    return {
      namedRangeId: named.namedRangeId,
      name: named.name,
      range: {
        sheetId: range.sheetId || 0,
        startRowIndex: range.startRowIndex || 0,
        endRowIndex: range.endRowIndex,
        startColumnIndex: range.startColumnIndex || 0,
        endColumnIndex: range.endColumnIndex,
      },
    };
  });
}

function dmvChatActionRangeName_(value, label) {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z_][A-Za-z0-9_]{0,249}$/.test(value) ||
    /^[A-Za-z]{1,3}[0-9]+$/.test(value) ||
    /^R[0-9]*C[0-9]*$/i.test(value) ||
    /^(?:true|false)$/i.test(value)
  )
    throw new Error(
      label +
        ' must start with a letter or _, use only letters, digits and _, and not look like a cell such as A1.'
    );
  return value;
}

function dmvChatActionNamedKey_(named) {
  var range = named.range || {};
  return JSON.stringify([
    named.name,
    range.sheetId || 0,
    range.startRowIndex || 0,
    range.endRowIndex === undefined ? null : range.endRowIndex,
    range.startColumnIndex || 0,
    range.endColumnIndex === undefined ? null : range.endColumnIndex,
  ]);
}

// Before undoing a named_range edit: the name is still as the edit left it (after), or, for a
// deletion (after null), nothing has taken its name or id since. Otherwise undo would overwrite
// or delete a later change, and the formulas that use the name would read other cells.
function dmvChatActionNamedUnchanged_(session, named) {
  var all = dmvChatActionNamedRanges_(session);
  if (named.after === null) {
    if (
      all.some(function (item) {
        return (
          item.namedRangeId === named.id ||
          String(item.name).toLowerCase() === String(named.name).toLowerCase()
        );
      })
    )
      throw new Error(
        'A named range called "' +
          named.name +
          '" exists again, so the deleted one cannot be restored here.'
      );
    return;
  }
  var current = all.filter(function (item) {
    return item.namedRangeId === named.id;
  })[0];
  if (!current || dmvChatActionNamedKey_(current) !== dmvChatActionNamedKey_(named.after))
    throw new Error(
      'The named range "' +
        named.after.name +
        '" changed since that edit, so it cannot be undone here. Use named_range update to set it as needed.'
    );
}

function dmvChatActionNamed_(context) {
  var session = context.session,
    input = context.input,
    spec = input.namedRange;
  dmvChatSheetObject_(spec, ['operation', 'name', 'newName', 'range']);
  var operation = spec.operation;
  if (['add', 'update', 'delete'].indexOf(operation) < 0)
    throw new Error('Choose namedRange operation add, update or delete.');
  var name = dmvChatActionRangeName_(spec.name, 'The name');
  var defaultSheet =
    input.sheetName === undefined ? null : dmvChatSheetTarget_(session, input.sheetName);
  var all = dmvChatActionNamedRanges_(session);
  function find(text) {
    return all.filter(function (named) {
      return String(named.name).toLowerCase() === text.toLowerCase();
    })[0];
  }
  var existing = find(name),
    target =
      spec.range === undefined
        ? null
        : dmvChatActionA1_(session, spec.range, defaultSheet, 'range');
  var plan = { touches: [], details: [['Name', name]] };
  function described(named) {
    var tab = dmvChatSheetById_(session, named.range.sheetId);
    return (tab ? dmvChatActionTab_(tab.getName()) : '') + dmvChatGridA1_(named.range);
  }
  if (operation === 'add') {
    if (existing)
      throw new Error('A named range "' + existing.name + '" already exists. Use update.');
    if (!target) throw new Error("Give the range to name, such as 'Tab name'!A1:C9.");
    if (spec.newName !== undefined) throw new Error('newName is only for update.');
    var id = 'dmv' + dmvOutputDigest_(Utilities.getUuid() + ':' + Date.now()).slice(0, 16);
    var added = { namedRangeId: id, name: name, range: target.grid };
    plan.requests = [{ addNamedRange: { namedRange: added } }];
    plan.undo = {
      reverse: [{ deleteNamedRange: { namedRangeId: id } }],
      verify: [],
      named: { id: id, name: name, after: added },
    };
    plan.sheetId = target.grid.sheetId;
    plan.sheetName = target.sheet.getName();
    plan.range = target.a1;
    plan.text = 'Named ' + dmvChatActionTab_(target.sheet.getName()) + target.a1 + ' as ' + name;
    plan.result = { name: name, refersTo: dmvChatActionTab_(target.sheet.getName()) + target.a1 };
    return plan;
  }
  if (!existing) throw new Error('No named range is called "' + name + '".');
  var tab = dmvChatSheetById_(session, existing.range.sheetId);
  plan.sheetId = existing.range.sheetId;
  plan.sheetName = tab ? tab.getName() : '';
  if (operation === 'delete') {
    if (target || spec.newName !== undefined) throw new Error('delete takes only the name.');
    plan.requests = [{ deleteNamedRange: { namedRangeId: existing.namedRangeId } }];
    plan.undo = {
      reverse: [{ addNamedRange: { namedRange: existing } }],
      verify: [],
      named: { id: existing.namedRangeId, name: existing.name, after: null },
    };
    plan.text = 'Deleted the named range ' + existing.name;
    plan.result = {
      name: existing.name,
      note: 'Formulas that use this name show #NAME? until it exists again.',
    };
    return plan;
  }
  var fields = [],
    updated = { namedRangeId: existing.namedRangeId };
  if (spec.newName !== undefined) {
    updated.name = dmvChatActionRangeName_(spec.newName, 'newName');
    var clash = find(updated.name);
    if (clash && clash.namedRangeId !== existing.namedRangeId)
      throw new Error('A named range "' + clash.name + '" already exists.');
    fields.push('name');
  }
  if (target) {
    updated.range = target.grid;
    fields.push('range');
    plan.sheetId = target.grid.sheetId;
    plan.sheetName = target.sheet.getName();
    plan.range = target.a1;
  }
  if (!fields.length) throw new Error('update needs newName, range or both.');
  plan.requests = [{ updateNamedRange: { namedRange: updated, fields: fields.join(',') } }];
  plan.undo = {
    reverse: [{ updateNamedRange: { namedRange: existing, fields: 'name,range' } }],
    verify: [],
    named: {
      id: existing.namedRangeId,
      name: existing.name,
      after: { name: updated.name || existing.name, range: updated.range || existing.range },
    },
  };
  plan.text = 'Updated the named range ' + existing.name;
  plan.result = {
    name: updated.name || existing.name,
    refersTo: target ? dmvChatActionTab_(target.sheet.getName()) + target.a1 : described(existing),
  };
  return plan;
}

/* Tabs */

function dmvChatActionNewId_(sheets) {
  var ids = sheets.map(function (item) {
    return item.getSheetId();
  });
  var id = parseInt(dmvOutputDigest_(Utilities.getUuid()).slice(0, 7), 16);
  while (ids.indexOf(id) >= 0) id++;
  return id;
}

function dmvChatActionDuplicateSheet_(context) {
  var session = context.session,
    sheet = context.sheet;
  var sheets = dmvChatSeeNewTabs_(session).getSheets();
  var taken = sheets.map(function (item) {
    return item.getName().toLowerCase();
  });
  var name;
  if (context.input.newName !== undefined) {
    name = dmvSheetName_(context.input.newName);
    if (taken.indexOf(name.toLowerCase()) >= 0)
      throw new Error('A tab with that name already exists. Choose another name.');
  } else {
    var base = ('Copy of ' + sheet.getName()).slice(0, 94),
      suffix = 2;
    name = base;
    while (taken.indexOf(name.toLowerCase()) >= 0) name = base + ' ' + suffix++;
  }
  var position = sheets
    .map(function (item) {
      return item.getSheetId();
    })
    .indexOf(sheet.getSheetId());
  var id = dmvChatActionNewId_(sheets),
    used = dmvChatActionUsed_(sheet);
  var copy = Object.assign({}, used, { sheetId: id });
  return {
    requests: [
      {
        duplicateSheet: {
          sourceSheetId: sheet.getSheetId(),
          insertSheetIndex: position + 1,
          newSheetId: id,
          newSheetName: name,
        },
      },
    ],
    touches: [],
    // Undo deletes the copy, but only while its data is as copied and reaches no further.
    undo:
      dmvChatGridCells_(copy) > DMV_SHEET_UNDO.maxCells
        ? null
        : { reverse: [{ deleteSheet: { sheetId: id } }], verify: [copy], extent: id },
    sheetName: name,
    sheetId: id,
    text: 'Duplicated ' + sheet.getName() + ' as ' + name,
    details: [['From', sheet.getName()]],
    result: { from: sheet.getName() },
  };
}

function dmvChatActionDeleteSheet_(context) {
  var session = context.session,
    sheet = context.sheet;
  var user = dmvChatActionTabUser_(session, sheet);
  if (user)
    throw new Error(
      'This tab is used by a saved ' +
        user +
        '. Change or remove the ' +
        user +
        ' instead of deleting its tab.'
    );
  var sheets = dmvChatSeeNewTabs_(session).getSheets();
  var visible = sheets.filter(function (item) {
    return !item.isSheetHidden() && item.getSheetId() !== sheet.getSheetId();
  });
  if (!visible.length) throw new Error('A spreadsheet must keep at least one visible tab.');
  var used = dmvChatActionUsed_(sheet);
  var plan = {
    requests: [{ deleteSheet: { sheetId: sheet.getSheetId() } }],
    touches: [],
    guard: [{ sheetId: sheet.getSheetId() }],
    confirm:
      'Delete the tab "' +
      sheet.getName() +
      '" (data in ' +
      dmvChatGridA1_(used) +
      ')? Formulas on other tabs that point at it will show #REF!.',
    text: 'Deleted tab ' + sheet.getName(),
    result: { deleted: sheet.getName() },
  };
  // The undo copy duplicates the whole grid, and Sheets refuses a request that takes the
  // spreadsheet over 10 million cells, so a tab too large to copy is deleted without one.
  var cells = 0;
  sheets.forEach(function (item) {
    cells += item.getMaxRows() * item.getMaxColumns();
  });
  if (cells + sheet.getMaxRows() * sheet.getMaxColumns() > 10000000) {
    plan.undo = {
      none: 'The tab is too large to keep a copy for undo, so this cannot be undone here; Sheets version history can restore it.',
    };
    return plan;
  }
  var copy = dmvChatUndoSheetCopy_(session, sheet);
  plan.requests = copy.requests.concat(plan.requests);
  plan.undo = copy.undo;
  plan.result.note =
    'For undo, a hidden copy "' +
    copy.undo.sheet.copyName +
    '" stays in the spreadsheet for 6 hours and is deleted by the first chat request after that. Editors can show hidden tabs, so tell the user to delete that copy by hand before sharing the file if the data is private.';
  return plan;
}

function dmvChatActionHide_(context, hide) {
  var session = context.session,
    sheet = context.sheet;
  if (!!sheet.isSheetHidden() === hide)
    throw new Error(
      'The tab "' + sheet.getName() + '" is already ' + (hide ? 'hidden.' : 'shown.')
    );
  if (
    hide &&
    !dmvChatSeeNewTabs_(session)
      .getSheets()
      .some(function (item) {
        return !item.isSheetHidden() && item.getSheetId() !== sheet.getSheetId();
      })
  )
    throw new Error('A spreadsheet must keep at least one visible tab.');
  function request(hidden) {
    return {
      updateSheetProperties: {
        properties: { sheetId: sheet.getSheetId(), hidden: hidden },
        fields: 'hidden',
      },
    };
  }
  return {
    requests: [request(hide)],
    touches: [],
    undo: { reverse: [request(!hide)], verify: [] },
    text: (hide ? 'Hid tab ' : 'Showed tab ') + sheet.getName(),
  };
}
