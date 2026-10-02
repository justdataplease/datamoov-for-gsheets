/* Analyst edit_sheet actions: copy and move, rows and columns, cleanup, validation, notes and
   links, named ranges and tab operations. Each action is registered here and runs through
   dmvChatSheetRunAction_ (dmv_chat_sheet_safety.js), which owns the inspection token, the
   protected-output guard, confirmation, undo, the single batch and the write event.

   An action spec, keyed by its edit_sheet action name:
     target  'range' (default): needs the inspected sheetName, range and editToken; the cells are
             checked against the inspection before plan runs.
             'sheet': needs only sheetName (tab-level actions such as delete_sheet).
             'none': needs neither (actions that create something new).
             Or a function of the input that returns one of these.
     fields  input keys the action takes besides action, sheetName, range, editToken and
             confirmToken; any other key is refused.
     builtIn  true for the built-in actions (dmv_chat_sheets.js): a refusal of other keys names
             none, a tab-level one takes no confirmToken and a result without undo has no undoId.
     plan(context)  validates the input and returns what to do. context holds session, input,
             sheet (the target tab or null), area (dmvChatSheetArea_ of the range or null) and
             snapshot (the inspected cells, from dmvChatSheetRead_, or null). It returns:
       requests   validated Sheets requests, sent in one batch (required)
       touches    bounded GridRanges whose cells change; guarded and, by default, snapshotted for
                  undo and checked unchanged before an undo (default: the inspected range)
       guard      more GridRanges to guard; a missing end index means the rest of the tab, so
                  { sheetId } guards a whole tab and { sheetId, startRowIndex: 9 } every row
                  from row 10 (what an insert or delete there moves)
       overwrite  true when touches are replaced: more than 200 non-empty cells asks first,
                  counting the earlier edits of the request; or the name of the cells (Tab!A1:B2),
                  which the question then gives
       replaced   for an action that counts what it replaces itself: that count, which joins
                  the request's total the same way (without confirm, passing 200 asks; with
                  confirm, the summary names the count once it passes 200 alone, and the yes
                  covers it); with overwrite, the count when undo cannot count touches
       confirm    a summary that makes the user confirm first (delete, dedupe, whole-tab
                  find/replace)
       undo       omit for a cell snapshot of touches; null when there is nothing to restore;
                  { none: DMV_SHEET_UNDO.noUndo } for row, column, move and tab edits, which
                  chat never undoes (asks first, and undo answers with version history), with
                  snapshot for the cells it removes or replaces, so a yes covers them only as
                  they were when chat asked; { hint } for an edit chat never undoes and does
                  not ask about (a pivot on a new tab), which undo answers with hint; or
                  { snapshot: [GridRange], reverse: [requests], verify: [GridRange], rules }
                  where undo sends reverse first, then restores the snapshot cells, after
                  checking that verify (in after-edit coordinates) is unchanged; rules (a
                  sheetId) also checks that tab's conditional format rules, for a reverse that
                  names a rule by its position; named ({ id, name, after }) checks a named range
                  (dmvChatActionNamedUnchanged_); restore ({ rules }) puts back, after the
                  reverse, the conditional format rules of the rules tab (replacing those it
                  holds then) as they were before the edit; note is what the undo result says
                  undo could not put back. Undo also refuses once rows or columns of the tabs of
                  snapshot and verify were inserted or deleted
       readBack   true to read the inspected range back once written, as context.written: undo
                  checks against it, keeping no entry without it, and the fresh token reuses it
       retoken    false when no fresh editToken follows an edit of the inspected range
       text, details, sheetName, sheetId, range   the write event and result links
       result     extra result fields; after(response, context) may return more once written,
                  and set context.sheet to a tab the batch created, for the output link
   Built-in action names win over these. Helpers: dmvChatSheetGuard_, dmvChatSheetCells_,
   dmvChatSheetNonEmpty_, dmvChatGridA1_ and, for tools of their own,
   dmvChatConfirmFind_, dmvChatConfirmIssue_ and dmvChatConfirmSpend_.

   Range actions work on the inspected range (at most 1,000 cells, 200 rows and 30 columns), so
   the model has read what it changes; find_replace, remove_duplicates and highlight_duplicates
   can widen to the tab's data (at most 50,000 cells, what undo keeps; a replace or removal there
   is always asked first). Row and column actions take start and count on a tab: at most 500
   inserted or deleted per call. */
var DMV_SHEET_ACTIONS = {
  dimensionCount: 500,
  findCells: 50000,
  regexText: 5000,
  // Characters on which find_replace's ., $, \s and \b mean different things in JavaScript, Java
  // and RE2: line ends (Java's . also stops at U+0085, and its $ matches before a last line end),
  // spaces only some count in \s, and letters and digits beyond A to Z, which Java's \b counts
  // as word characters.
  regexUnsure: {
    dot: '[\\r\\u0085\\u2028\\u2029]',
    end: '[\\n\\r\\u0085\\u2028\\u2029]',
    space: '[\\v\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]',
    word: '(?![\\x00-\\x7f])[\\p{L}\\p{Nd}\\p{Mn}]',
  },
  // The separators split_columns auto looks for, in order; the first any cell holds is used.
  autoDelimiters: [',', ';', '\t', '|', ' '],
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
      fields: ['keyColumns', 'keep', 'headerRows', 'wholeSheet'],
      plan: dmvChatActionRemoveDuplicates_,
    },
    highlight_duplicates: {
      fields: ['keyColumns', 'headerRows', 'color', 'wholeSheet'],
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
        description:
          'copy_range; move_range takes only all. values onto itself freezes formulas, array results whole.',
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
        description:
          'How many rows or columns; at most 500 inserted or deleted. create_sheet: its rows (default 1000).',
      },
      find: { type: 'string', description: 'find_replace: text (or regex) to find.' },
      replacement: text(),
      matchCase: { type: 'boolean' },
      matchEntireCell: { type: 'boolean' },
      useRegex: { type: 'boolean' },
      wholeSheet: {
        type: 'boolean',
        description:
          "find_replace, remove_/highlight_duplicates: the whole tab's data (from row 1, at most 50,000 cells), not just the inspected range; never dedupe a larger table range by range.",
      },
      keyColumns: {
        type: 'array',
        items: { type: 'integer', minimum: 1 },
        description:
          'remove_/highlight_duplicates: one-based columns within the range (with wholeSheet, of the tab: A=1) that must match; default all.',
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
          source: {
            type: 'string',
            description: "range: the dropdown cells, 'Tab'!A2:A20, or 'Tab'!A2:A to the last row.",
          },
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
          range: {
            type: 'string',
            description: "'Tab'!A1:B9 or 'Tab'!A2:A to the last row (add, or update to move it).",
          },
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
// inside the tab's grid. Without a tab name the range is on defaultSheet, when one is given. open
// also takes columns to the last row (A2:A) or whole columns (A:A), as { sheet, grid, a1 }, for
// the inputs that should grow with the data: dropdown sources and named ranges.
function dmvChatActionA1_(session, text, defaultSheet, label, open) {
  var usage =
    label +
    (open
      ? " must be an A1 cell or range such as B2, 'Tab name'!A1:C9 or 'Tab name'!A:A."
      : " must be an A1 cell or range such as B2 or 'Tab name'!A1:C9.");
  if (typeof text !== 'string' || text.length > 200) throw new Error(usage);
  var match =
    /^(?:'((?:[^']|'')+)'!|([^'!]+)!)?([A-Za-z]{1,3}[0-9]{0,7}(?::[A-Za-z]{1,3}[0-9]{0,7})?)$/.exec(
      text.trim()
    );
  var bounded =
    match && /^[A-Za-z]{1,3}[1-9][0-9]{0,6}(?::[A-Za-z]{1,3}[1-9][0-9]{0,6})?$/.test(match[3]);
  if (!match || (!bounded && !open)) throw new Error(usage);
  var name = match[1] !== undefined ? match[1].replace(/''/g, "'") : match[2];
  var sheet = name !== undefined ? dmvChatSheetTarget_(session, name) : defaultSheet;
  if (!sheet) throw new Error(label + " must name its tab, such as 'Tab name'!A1:C9.");
  if (!bounded) {
    var range = dmvChatSheetOpenRange_(sheet, match[3]);
    if (!range) throw new Error(usage);
    return { sheet: sheet, grid: range.grid, a1: range.a1 };
  }
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

// The rows remove_ and highlight_duplicates compare: the inspected range or, with wholeSheet, the
// tab's data (at most the 50,000 cells undo keeps), without its header rows (0 or 1, default 1,
// as for sort). keys are the one-based key columns within it and letters their column letters;
// cells holds the inspected rows, or null for the whole tab, whose cells are not read here.
function dmvChatActionBody_(context) {
  var input = context.input,
    sheet = context.sheet,
    whole = dmvChatActionFlag_(input, 'wholeSheet'),
    area = whole ? dmvChatActionUsed_(sheet) : context.area.grid;
  var headers = dmvChatSheetInteger_(
    input.headerRows === undefined ? 1 : input.headerRows,
    0,
    1,
    'Header rows'
  );
  if (whole && dmvChatGridCells_(area) > DMV_SHEET_UNDO.maxCells)
    throw new Error(
      'The data of tab "' +
        sheet.getName() +
        '" spans more than 50,000 cells, more than chat can compare and undo in one edit; Sheets\' Data > Data cleanup can remove duplicates by hand.'
    );
  if (headers >= area.endRowIndex - area.startRowIndex)
    throw new Error(
      whole
        ? 'The data of tab "' + sheet.getName() + '" must include a data row below its header.'
        : 'The range must include a data row below its header.'
    );
  var grid = Object.assign({}, area);
  grid.startRowIndex += headers;
  var keys = dmvChatActionKeyColumns_(input, area.endColumnIndex - area.startColumnIndex);
  return {
    grid: grid,
    headers: headers,
    whole: whole,
    keys: keys,
    letters: keys.map(function (column) {
      return dmvChatActionColumn_(area.startColumnIndex + column);
    }),
    cells: whole ? null : context.snapshot.cells.slice(headers),
    where: sheet.getName() + '!' + dmvChatGridA1_(grid) + (whole ? ' (the whole tab)' : ''),
  };
}

// The key cells of each compared row, in key order. For the whole tab only the key columns are
// read, each by its value, unless the rows were read in full already.
function dmvChatActionKeyRows_(session, body) {
  if (body.cells)
    return body.cells.map(function (row) {
      return body.keys.map(function (column) {
        return row[column - 1];
      });
    });
  var columns = dmvChatSheetCells_(
    session,
    body.keys.map(function (column) {
      var index = body.grid.startColumnIndex + column - 1;
      return Object.assign({}, body.grid, { startColumnIndex: index, endColumnIndex: index + 1 });
    }),
    'userEnteredValue,effectiveValue'
  );
  return Array.from({ length: body.grid.endRowIndex - body.grid.startRowIndex }, function (_, r) {
    return columns.map(function (read) {
      return read.cells[r][0];
    });
  });
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

// The first three items as one phrase, such as 'A1, B2 and 4 more', or '' for none. total counts
// them all when items holds only the first ones.
function dmvChatActionListed_(items, total) {
  var shown = items.slice(0, 3),
    more = (total === undefined ? items.length : total) - shown.length;
  if (more > 0) shown.push(more + ' more');
  return shown.length > 1
    ? shown.slice(0, -1).join(', ') + ' and ' + shown[shown.length - 1]
    : shown.join('');
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
  // Values onto the source itself turn its formulas into the values they show, so the cells look
  // the same and nothing is asked.
  var source = area.grid,
    frozen = dmvChatGridKey_(destination) === dmvChatGridKey_(source);
  if (frozen && (move || type !== 'values'))
    throw new Error('The destination is the source itself. Choose another place.');
  if (frozen) source = destination = dmvChatActionFreezeArea_(context);
  var from = sheet.getName() + '!' + dmvChatGridA1_(source),
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
          source: source,
          destination: destination,
          pasteType: DMV_SHEET_ACTIONS.paste[type],
          pasteOrientation: 'NORMAL',
        },
      },
    ];
    plan.touches = [destination];
    plan.overwrite = !frozen;
    // Pasted values keep no format a formula's result only showed, so a date reads as a number.
    if (frozen)
      plan.result.note =
        'Dates and other formats the formula showed are not kept: format those columns, e.g. numberFormat date.';
    if (type === 'all' || type === 'formats')
      plan.undo = dmvChatActionCopyUndo_(context.session, area.grid, destination, type === 'all');
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
      if (!inside && dmvChatSheetNonEmpty_([[cell]])) replaced++;
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
  plan.replaced = replaced;
  var reasons = ['Move ' + from + ' to ' + to + '?'];
  if (replaced > DMV_SHEET_UNDO.overwriteCells)
    reasons.push('Moving ' + from + ' replaces ' + replaced + ' non-empty cells in ' + to + '.');
  // Sheets turns references to the cells a move pastes over into #REF!, so the question names
  // them, or says chat could not fully check.
  var referrers = dmvChatActionReferrers_(context.session, destination, area.grid);
  if (referrers.count) {
    reasons.push(
      'Formulas at ' +
        dmvChatActionListed_(referrers.cells, referrers.count) +
        ' refer to cells in ' +
        to +
        ' that this move pastes over; Sheets turns those references into #REF!.'
    );
  } else if (referrers.unchecked)
    reasons.push(
      'Chat could not check every formula of this spreadsheet for references to cells in ' +
        to +
        ' that this move pastes over (too many cells, or formulas it cannot read); any that refer to them will show #REF!.'
    );
  plan.confirm = reasons.join(' ');
  plan.undo = { none: DMV_SHEET_UNDO.noUndo, snapshot: plan.touches };
  return plan;
}

// The range copy_range values freezes onto itself: the inspected range, grown to the whole array
// result of a formula in its first cell, which can be larger than an inspection, so no result is
// frozen in part. The result's size is read from the sheet, which shows it even when the formula
// alone does not tell (QUERY, a computed MAKEARRAY): the cells right of and below the formula
// that show a value nobody entered, up to the first entered cell, so an empty value inside the
// result is kept too. Any other entry in the grown area outside the inspection is refused.
function dmvChatActionFreezeArea_(context) {
  var grid = context.area.grid,
    entry = context.snapshot.cells[0][0].userEnteredValue;
  if (!entry || !entry.formulaValue) return grid;
  var row = grid.startRowIndex,
    column = grid.startColumnIndex;
  var right = {
      sheetId: grid.sheetId,
      startRowIndex: row,
      endRowIndex: row + 1,
      startColumnIndex: column + 1,
      endColumnIndex: context.sheet.getMaxColumns(),
    },
    below = {
      sheetId: grid.sheetId,
      startRowIndex: row + 1,
      endRowIndex: context.sheet.getMaxRows(),
      startColumnIndex: column,
      endColumnIndex: column + 1,
    };
  var strips = [right, below].filter(function (strip) {
    return dmvChatGridCells_(strip) > 0;
  });
  var extent = { right: 0, below: 0 };
  dmvChatSheetCells_(context.session, strips, 'userEnteredValue,effectiveValue').forEach(
    function (read) {
      var across = read.grid === right,
        line = across
          ? read.cells[0]
          : read.cells.map(function (cells) {
              return cells[0];
            });
      for (var i = 0; i < line.length; i++) {
        if (line[i].userEnteredValue && Object.keys(line[i].userEnteredValue).length) break;
        if (line[i].effectiveValue) extent[across ? 'right' : 'below'] = i + 1;
      }
    }
  );
  var grown = Object.assign({}, grid, {
    endRowIndex: Math.max(grid.endRowIndex, row + 1 + extent.below),
    endColumnIndex: Math.max(grid.endColumnIndex, column + 1 + extent.right),
  });
  if (dmvChatGridKey_(grown) === dmvChatGridKey_(grid)) return grid;
  // Past an empty value the cells may belong to something else: an entry there, which the freeze
  // would turn into a value, means the result's end is not known. (Undo restores any other
  // formula's array result this still reaches.)
  var taken = [];
  dmvChatSheetCells_(context.session, [grown], 'userEnteredValue')[0].cells.forEach(
    function (line, r) {
      line.forEach(function (cell, c) {
        var inspected = row + r < grid.endRowIndex && column + c < grid.endColumnIndex;
        if (!inspected && cell.userEnteredValue && Object.keys(cell.userEnteredValue).length)
          taken.push(dmvChatA1_(row + r + 1, column + c + 1));
      });
    }
  );
  if (taken.length)
    throw new Error(
      dmvChatA1_(row + 1, column + 1) +
        ': the result seems to fill ' +
        dmvChatGridA1_(grown) +
        ', but ' +
        dmvChatActionListed_(taken) +
        (taken.length === 1
          ? ' there holds an entry of its own'
          : ' there hold entries of their own') +
        ', so where it ends is not clear. Copy its values to another place instead.'
    );
  return grown;
}

// The undo of a copy of everything or of formats: besides the destination's cells, the copy
// brings the source's conditional formats to the destination tab, and a copy of everything
// (merges) its merges, replacing those it pastes over. When it does, undo puts the destination
// tab's rules back as they are now (refusing once they changed since), and unmerges the
// destination and merges again what was merged wholly inside it.
function dmvChatActionCopyUndo_(session, source, destination, merges) {
  dmvChatSheetDeadline_(session);
  var result = Sheets.Spreadsheets.get(session.spreadsheetId, {
    fields: 'sheets(properties(sheetId),conditionalFormats,merges)',
  });
  function tab(sheetId) {
    return (
      ((result && result.sheets) || []).filter(function (entry) {
        return ((entry.properties && entry.properties.sheetId) || 0) === sheetId;
      })[0] || {}
    );
  }
  function overlapping(list, grid) {
    return (list || []).filter(function (range) {
      return dmvChatSheetRuleOverlap_(range, grid);
    });
  }
  var from = tab(source.sheetId),
    to = tab(destination.sheetId),
    undo = { snapshot: [destination] };
  if (
    (from.conditionalFormats || []).some(function (rule) {
      return overlapping(rule.ranges, source).length;
    })
  ) {
    undo.rules = destination.sheetId;
    undo.restore = { rules: to.conditionalFormats || [] };
  }
  var replaced = overlapping(to.merges, destination);
  if (merges && (overlapping(from.merges, source).length || replaced.length))
    undo.reverse = [{ unmergeCells: { range: destination } }].concat(
      replaced
        .filter(function (merge) {
          return (
            (merge.startRowIndex || 0) >= destination.startRowIndex &&
            merge.endRowIndex <= destination.endRowIndex &&
            (merge.startColumnIndex || 0) >= destination.startColumnIndex &&
            merge.endColumnIndex <= destination.endColumnIndex
          );
        })
        .map(function (merge) {
          return { mergeCells: { range: merge, mergeType: 'MERGE_ALL' } };
        })
    );
  return undo;
}

// The formulas that refer to cells of a move's destination outside its source (references to the
// source follow the block), read from every tab up to the search_sheets cell cap, as { count,
// cells (the first three, as 'Tab!B2'), unchecked }. unchecked is true when tabs were left out
// for the cap, a formula that may name the destination's tab could not be read, or one uses a
// table reference. Cells the move pastes over are left out, since their
// formulas are replaced. References through named ranges are not followed.
function dmvChatActionReferrers_(session, destination, source) {
  var target = dmvChatSheetById_(session, destination.sheetId).getName().toLowerCase(),
    found = { count: 0, cells: [], unchecked: false };
  function within(grid, rows, columns) {
    return (
      grid.sheetId === destination.sheetId &&
      rows[0] >= grid.startRowIndex &&
      rows[1] <= grid.endRowIndex &&
      columns[0] >= grid.startColumnIndex &&
      columns[1] <= grid.endColumnIndex
    );
  }
  // The part of the destination a reference covers, as 0-based end-exclusive [rows, columns], or
  // null; an open side (A:A, 2:5, A2:A) runs to the end of the tab.
  function covered(text) {
    var ends = text
      .replace(/\$/g, '')
      .toUpperCase()
      .split(':')
      .map(function (part) {
        var match = /^([A-Z]*)([0-9]*)$/.exec(part);
        return {
          row: match[2] ? Number(match[2]) : null,
          column: match[1] ? dmvCell_(match[1] + '1').column : null,
        };
      });
    var last = ends[ends.length - 1];
    function side(low, high, start, end) {
      var known = [low, high].filter(function (value) {
        return value !== null;
      });
      var from = known.length ? Math.min.apply(null, known) - 1 : 0,
        to = known.length === 2 ? Math.max(low, high) : Infinity;
      return [Math.max(from, start), Math.min(to, end)];
    }
    var rows = side(ends[0].row, last.row, destination.startRowIndex, destination.endRowIndex),
      columns = side(
        ends[0].column,
        last.column,
        destination.startColumnIndex,
        destination.endColumnIndex
      );
    return rows[0] < rows[1] && columns[0] < columns[1] ? [rows, columns] : null;
  }
  var planned;
  try {
    planned = dmvChatSearchPlan_(session.spreadsheet.getSheets(), {});
  } catch (tooLarge) {
    found.unchecked = true;
    return found;
  }
  found.unchecked = planned.skipped.length > 0;
  dmvChatSearchRead_(
    session,
    planned.plan,
    function (number, row, column, cell) {
      var formula = cell.userEnteredValue && cell.userEnteredValue.formulaValue,
        tab = planned.plan[number].sheet;
      if (typeof formula !== 'string') return;
      var at = tab.getSheetId() === destination.sheetId ? [row, row + 1] : null;
      if (
        at &&
        within(destination, at, [column, column + 1]) &&
        !within(source, at, [column, column + 1])
      )
        return;
      var tokens;
      try {
        tokens = dmvChatFormulaTokens_(formula, function () {
          throw new Error('unreadable');
        });
      } catch (unreadable) {
        if (at || formula.toLowerCase().indexOf(target) >= 0) found.unchecked = true;
        return;
      }
      var refers = tokens.some(function (token) {
        if (token.type !== 'ref') return false;
        // A table reference names no cells chat can place.
        if (token.table) {
          found.unchecked = true;
          return false;
        }
        if ((token.sheet === null ? tab.getName() : token.sheet).toLowerCase() !== target)
          return false;
        var part = covered(token.text.slice(token.text.lastIndexOf('!') + 1));
        return !!part && !within(source, part[0], part[1]);
      });
      if (!refers) return;
      if (found.cells.length < 3)
        found.cells.push(tab.getName().slice(0, 40) + '!' + dmvChatA1_(row + 1, column + 1));
      found.count++;
    },
    'userEnteredValue'
  );
  return found;
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
  return {
    requests: [
      {
        insertDimension: {
          range: span,
          inheritFromBefore: span.startIndex === limit && limit > 0,
        },
      },
    ],
    guard: [dmvChatActionSpanGuard_(span)],
    confirm: 'Insert ' + count + ' ' + noun + ' ' + where + ' in tab "' + sheet.getName() + '"?',
    undo: { none: DMV_SHEET_UNDO.noUndo },
    text: 'Inserted ' + count + ' ' + noun + ' ' + where + ' in ' + sheet.getName(),
    details: [['Inserted', dmvChatActionSpanText_(span)]],
    result: { inserted: count, at: dmvChatActionSpanText_(span) },
  };
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
  var pivots = dmvChatActionSpanPivots_(context.session, removed);
  return {
    requests: [{ deleteDimension: { range: span } }],
    touches: [],
    guard: [dmvChatActionSpanGuard_(span)],
    confirm:
      'Delete ' +
      label +
      ' of tab "' +
      sheet.getName() +
      '", with everything in them' +
      (pivots.length
        ? ', including the pivot table' +
          (pivots.length > 1 ? 's' : '') +
          ' at ' +
          dmvChatActionListed_(pivots)
        : '') +
      '? Formulas elsewhere that point at them will show #REF!.',
    undo: { none: DMV_SHEET_UNDO.noUndo, snapshot: [removed] },
    text: 'Deleted ' + label + ' of ' + sheet.getName(),
    details: [['Deleted', label]],
    result: { deleted: count, at: label },
  };
}

// The pivot tables anchored in a span about to be deleted, which Sheets drops with it, in A1
// notation. A span of more than DMV_SHEET_UNDO.maxCells cells is not read.
function dmvChatActionSpanPivots_(session, removed) {
  if (dmvChatGridCells_(removed) > DMV_SHEET_UNDO.maxCells) return [];
  var pivots = [];
  dmvChatSheetCells_(session, [removed], 'pivotTable')[0].cells.forEach(function (row, r) {
    row.forEach(function (cell, c) {
      if (cell.pivotTable)
        pivots.push(dmvChatA1_(removed.startRowIndex + r + 1, removed.startColumnIndex + c + 1));
    });
  });
  return pivots;
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
    confirm: 'Group ' + label + ' of tab "' + sheet.getName() + '"?',
    undo: { none: DMV_SHEET_UNDO.noUndo },
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
    confirm: 'Ungroup ' + label + ' of tab "' + sheet.getName() + '"?',
    undo: { none: DMV_SHEET_UNDO.noUndo },
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

// True when text that Sheets enters as typed (a find_replace result, a split piece) would read
// as a formula: it starts with =, or with a + or - that starts an expression. A lone + or - and
// plain signed numbers and amounts (-5, -1.5%, -$3, -1,234) stay text or numbers.
function dmvChatActionFormulaLike_(text) {
  var typed = text.trim();
  return (
    /^[=+-]/.test(typed) &&
    !/^[+-]$/.test(typed) &&
    !/^[+-][$€£]?(?:\d[\d,]*(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?%?$/i.test(typed)
  );
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
// before anything is written, with the characters around which it cannot predict Sheets (see
// dmvChatActionRegexSyntax_). Regular expressions that can take very long are refused.
function dmvChatActionPattern_(find, regex, matchCase, entire) {
  var source = find,
    unsure = null;
  if (regex) {
    if (find.length > 200) throw new Error('Keep the regular expression under 200 characters.');
    unsure = dmvChatActionRegexSyntax_(find, matchCase);
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
  return { pattern: pattern, unsure: unsure };
}

// Sheets runs a find_replace expression by Java's rules (RE2's are close), while the count and
// the formula check here run JavaScript's. Only syntax that means the same in all three is taken,
// so the cells checked are the cells Sheets changes: \A, \Q..\E or \p{L} read as plain letters
// here would let a cell Sheets changes go unchecked. ., $, \s and \b still differ around line
// breaks, unusual spaces and letters beyond A to Z; the result finds the characters the
// expression differs on, for cells holding them to be refused, or is null.
function dmvChatActionRegexSyntax_(find, matchCase) {
  var unsure = Object.create(null);
  function refuse(message) {
    throw new Error(message);
  }
  // The escape whose letter is at find[at]; true when it is a class such as \d.
  function escape(at, inClass) {
    var letter = find.charAt(at);
    if (/[1-9]/.test(letter))
      refuse('Sheets regular expressions have no back-references or lookarounds.');
    if (/[sS]/.test(letter)) unsure.space = true;
    else if (!inClass && /[bB]/.test(letter)) unsure.word = true;
    else if (!/[dDwWtnrf!-\/:-@[-`{-~]/.test(letter))
      refuse(
        'In a regular expression use only \\d, \\w, \\s, their capitals, \\b and \\B outside [ ], \\t, \\n, \\r, \\f or a backslash before punctuation: Sheets reads \\' +
          letter +
          ' differently.'
      );
    return /[dDwWsS]/.test(letter);
  }
  // The character class opening at find[at]; returns where it closes.
  function klass(at) {
    var i = at + 1,
      set = false;
    if (find.charAt(i) === '^') i++;
    var first = i;
    for (; i < find.length; i++) {
      var ch = find.charAt(i);
      if (ch === ']' && i > first) return i;
      if (ch === ']' || ch === '[' || (ch === '&' && find.charAt(i + 1) === '&'))
        refuse(
          'Inside [ ] write [, ] and && as \\[, \\] and \\&\\&: Sheets reads them differently, as nested classes and intersections.'
        );
      if (
        ch === '-' &&
        i > first &&
        find.charAt(i + 1) !== ']' &&
        (set || /^\\[dDwWsS]/.test(find.slice(i + 1)))
      )
        refuse(
          'Put a - first or last inside [ ], or write \\-: Sheets reads it differently next to \\d, \\w or \\s.'
        );
      set = ch === '\\' && escape(++i, true);
    }
    refuse('That regular expression is not valid.');
  }
  for (var i = 0; i < find.length; i++) {
    var ch = find.charAt(i),
      repeat = /[*+?]/.test(ch);
    if (ch === '\\') escape(++i, false);
    else if (ch === '[') i = klass(i);
    else if (ch === '(' && find.charAt(i + 1) === '?') {
      if (/^\?<?[=!]/.test(find.slice(i + 1)))
        refuse('Sheets regular expressions have no back-references or lookarounds.');
      if (find.charAt(i + 2) !== ':')
        refuse(
          'Use ( ) or (?: ) for groups: Sheets reads named groups, inline flags and other (? forms differently.'
        );
      i += 2;
    } else if (ch === '.') unsure.dot = true;
    else if (ch === '$') unsure.end = true;
    else if (ch === '{') {
      var count = /^\{\d+(?:,\d*)?\}/.exec(find.slice(i));
      if (!count)
        refuse(
          'Write a literal { as \\{: Sheets reads it differently outside a repeat like {2,5}.'
        );
      i += count[0].length - 1;
      repeat = true;
    }
    if (repeat && find.charAt(i + 1) === '+')
      refuse(
        'Leave out the + after a repeat: Sheets reads it differently, as a possessive repeat.'
      );
  }
  if (
    !matchCase &&
    find.split('').some(function (ch) {
      return ch > '\x7f' && ch.toLowerCase() !== ch.toUpperCase();
    })
  )
    throw new Error(
      'A regular expression with letters beyond A to Z needs matchCase: set matchCase true, as Sheets may compare their case differently.'
    );
  var parts = Object.keys(unsure).map(function (key) {
    return DMV_SHEET_ACTIONS.regexUnsure[key];
  });
  return parts.length ? new RegExp(parts.join('|'), 'u') : null;
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
  var matcher = dmvChatActionPattern_(input.find, regex, matchCase, entire),
    pattern = matcher.pattern;
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
  function cellName(r, c) {
    return (
      sheet.getName() + '!' + dmvChatA1_(grid.startRowIndex + r + 1, grid.startColumnIndex + c + 1)
    );
  }
  cells.forEach(function (row, r) {
    row.forEach(function (cell, c) {
      var most = 0;
      dmvChatActionTexts_(cell, shown && shown[r][c]).forEach(function (text) {
        if (regex && text.length > DMV_SHEET_ACTIONS.regexText)
          throw new Error(
            'A cell holds more than 5,000 characters; find it without useRegex instead.'
          );
        // Checked in every cell, matched here or not: Sheets may match where this check does not.
        if (matcher.unsure && matcher.unsure.test(text))
          throw new Error(
            cellName(r, c) +
              ' holds a line break, an unusual space or a letter beyond A to Z, around which Sheets reads ., $, \\s and \\b differently. Leave those out of the expression or find without useRegex.'
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
        if (dmvChatActionFormulaLike_(next))
          throw new Error(
            'The replacement would turn ' +
              cellName(r, c) +
              ' into text starting with ' +
              next.trim().charAt(0) +
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
    replaced: changed,
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
    body = dmvChatActionBody_(context);
  var keep = input.keep === undefined ? 'first' : input.keep;
  if (keep !== 'first' && keep !== 'last') throw new Error('Choose keep first or last.');
  var keys = body.keys;
  // Keeping the last rewrites every column, so the whole tab's rows are then read in full.
  if (keep === 'last' && !body.cells)
    body.cells = dmvChatSheetCells_(context.session, [body.grid])[0].cells;
  var rows = dmvChatActionKeyRows_(context.session, body).map(function (row) {
    return JSON.stringify(row.map(dmvChatActionKey_));
  });
  // Rows to keep: the first (or last) of each key, in their original order.
  var chosen = Object.create(null);
  rows.forEach(function (key, index) {
    if (keep === 'last' || !(key in chosen)) chosen[key] = index;
  });
  var kept = rows
    .map(function (key, index) {
      return chosen[key] === index ? index : -1;
    })
    .filter(function (index) {
      return index >= 0;
    });
  var removed = rows.length - kept.length,
    where = body.where,
    on = body.letters.join(', ');
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
  if (body.whole) plan.range = dmvChatGridA1_(body.grid);
  if (keep === 'first') {
    plan.requests = [
      {
        deleteDuplicates: {
          range: body.grid,
          comparisonColumns: keys.map(function (column) {
            var index = body.grid.startColumnIndex + column - 1;
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
  var color = dmvChatSheetColor_(input.color === undefined ? '#F4CCCC' : input.color);
  var first = body.grid.startRowIndex + 1,
    last = body.grid.endRowIndex,
    letters = body.letters;
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
    text: 'Highlighted duplicate rows in ' + body.where,
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
  var auto = delimiter.toLowerCase() === 'auto',
    known = DMV_SHEET_ACTIONS.delimiters[delimiter.toLowerCase()];
  if (dmvChatActionHasFormula_(context.snapshot.cells))
    throw new Error('split_columns splits typed text, not formulas.');
  var where = sheet.getName() + '!' + area.a1;
  // Number and date cells split by the text they show, so 1/5/2024 split on / gives 3 pieces.
  var shown = dmvChatActionShown_(context.session, area.grid, context.snapshot.cells);
  var texts = context.snapshot.cells.map(function (row, r) {
    var value = row[0].userEnteredValue;
    if (value && value.stringValue !== undefined) return String(value.stringValue);
    if (value && value.numberValue !== undefined)
      return shown && shown[r][0] !== null ? shown[r][0] : String(value.numberValue);
    return null;
  });
  // How Sheets' own detection picks a separator is not documented, so auto is settled here on
  // the first usual one any cell holds and sent as that one: the split checked is the split made.
  var separator = known ? known[1] : delimiter;
  if (auto) {
    separator = DMV_SHEET_ACTIONS.autoDelimiters.filter(function (candidate) {
      return texts.some(function (text) {
        return text !== null && text.indexOf(candidate) >= 0;
      });
    })[0];
    if (separator === undefined)
      throw new Error('No text in ' + where + ' contains that separator.');
    Object.keys(DMV_SHEET_ACTIONS.delimiters).forEach(function (name) {
      if (DMV_SHEET_ACTIONS.delimiters[name][1] === separator)
        known = DMV_SHEET_ACTIONS.delimiters[name];
    });
  }
  var request = known
    ? { source: area.grid, delimiterType: known[0] }
    : { source: area.grid, delimiterType: 'CUSTOM', delimiter: separator };
  // The widest split decides how many columns to the right are written.
  var widest = 1;
  texts.forEach(function (text, r) {
    if (text === null) return;
    var pieces = text.split(separator);
    widest = Math.max(widest, pieces.length);
    // Sheets enters each piece as if typed, so a piece that reads as a formula is refused, by
    // the rule find_replace refuses such a result with.
    pieces.forEach(function (piece) {
      if (dmvChatActionFormulaLike_(piece))
        throw new Error(
          'Splitting ' +
            sheet.getName() +
            '!' +
            dmvChatA1_(area.grid.startRowIndex + r + 1, area.grid.startColumnIndex + 1) +
            ' would give a piece starting with ' +
            piece.trim().charAt(0) +
            ', which Sheets reads as a formula. Change that cell first or choose another delimiter.'
        );
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
    details: [['Separator', auto ? 'auto: ' + JSON.stringify(separator) : delimiter]],
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
    return Number(text);
  }
  function date(value) {
    var text = typeof value === 'string' ? value.trim() : '';
    if (!dmvChatSheetDateFormula_(text))
      throw new Error('Date conditions need dates as YYYY-MM-DD.');
    return text;
  }
  // Numbers go as dmvChatSheetNumberValue_ makes them and dates as DATE formulas, which read the
  // same in every spreadsheet locale; the label keeps the values as given.
  function bounds(names, read) {
    var type = names[rule.condition];
    if (!type) throw new Error('Choose a condition: ' + Object.keys(names).join(', ') + '.');
    var shown = [read(rule.value)];
    if (/BETWEEN$/.test(type)) shown.push(read(rule.value2));
    else if (rule.value2 !== undefined) throw new Error('value2 is only for between.');
    label = rule.type + ' ' + rule.condition + ' ' + shown.join(' and ');
    return {
      type: type,
      values: shown.map(function (value) {
        return {
          userEnteredValue:
            typeof value === 'number'
              ? dmvChatSheetNumberValue_(value)
              : '=' + dmvChatSheetDateFormula_(value),
        };
      }),
    };
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
    var source = dmvChatActionA1_(session, rule.source, sheet, 'source', true);
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
        : dmvChatActionA1_(session, spec.range, defaultSheet, 'range', true);
  var plan = { touches: [], details: [['Name', name]] };
  function described(named) {
    var tab = dmvChatSheetById_(session, named.range.sheetId);
    return (tab ? dmvChatActionTab_(tab.getName()) : '') + dmvChatSheetRuleA1_(named.range);
  }
  if (operation === 'add') {
    if (existing)
      throw new Error('A named range "' + existing.name + '" already exists. Use update.');
    if (!target) throw new Error("Give the range to name, such as 'Tab name'!A1:C9.");
    if (spec.newName !== undefined) throw new Error('newName is only for update.');
    var id = dmvChatNewId_('dmv', 16);
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
  var id = dmvChatActionNewId_(sheets);
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
    confirm: 'Duplicate the tab "' + sheet.getName() + '" as "' + name + '"?',
    undo: { none: DMV_SHEET_UNDO.noUndo },
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
  var user = dmvChatTabUser_(session, sheet);
  if (user && user.collaborator)
    throw new Error(
      'This tab holds the output of ' +
        dmvChatOwnerText_(user) +
        '. Ask them to remove the ' +
        user.kind +
        ' before deleting its tab.'
    );
  if (user)
    throw new Error(
      'This tab is used by a saved ' +
        user.kind +
        '. Change or remove the ' +
        user.kind +
        ' instead of deleting its tab.'
    );
  var sheets = dmvChatSeeNewTabs_(session).getSheets();
  var visible = sheets.filter(function (item) {
    return !item.isSheetHidden() && item.getSheetId() !== sheet.getSheetId();
  });
  if (!visible.length) throw new Error('A spreadsheet must keep at least one visible tab.');
  return {
    requests: [{ deleteSheet: { sheetId: sheet.getSheetId() } }],
    touches: [],
    guard: [{ sheetId: sheet.getSheetId() }],
    confirm:
      'Delete the tab "' +
      sheet.getName() +
      '" (data in ' +
      dmvChatGridA1_(dmvChatActionUsed_(sheet)) +
      ')? Formulas on other tabs that point at it will show #REF!.',
    undo: { none: DMV_SHEET_UNDO.noUndo },
    text: 'Deleted tab ' + sheet.getName(),
    result: { deleted: sheet.getName() },
  };
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
