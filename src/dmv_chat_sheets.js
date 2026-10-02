/* Bounded existing-sheet edits. No arbitrary batch requests or executable source are accepted. */
// Refuses anything but an object with only the given keys; with listFields set, the refusal
// names the keys it does not take and the ones it does.
function dmvChatSheetObject_(value, keys, listFields) {
  if (!value || Object.prototype.toString.call(value) !== '[object Object]')
    throw new Error('Use only the documented fields for this sheet action.');
  var extra = Object.keys(value).filter(function (key) {
    return keys.indexOf(key) < 0;
  });
  if (extra.length)
    throw new Error(
      'Use only the documented fields for this sheet action.' +
        (listFields
          ? ' Not allowed here: ' +
            extra
              .slice(0, 5)
              .map(function (key) {
                return key.slice(0, 40);
              })
              .join(', ') +
            '. Allowed: ' +
            keys.join(', ') +
            '.'
          : '')
    );
  return value;
}

function dmvChatSheetInteger_(value, minimum, maximum, label) {
  if (typeof value !== 'number' || !Number.isInteger(value))
    throw new Error(label + ' must be an integer number.');
  return dmvInteger_(value, minimum, maximum, label);
}

function dmvChatSheetDeadline_(session) {
  if (session.deadline && Date.now() > session.deadline - 10000)
    throw new Error('The sheet action reached its time limit. Ask again to continue.');
}

// Call after any tool that can create a tab, so the rest of the turn can find it.
function dmvChatSeeNewTabs_(session) {
  session.spreadsheet = dmvReopen_(session.spreadsheet);
  try {
    session.sheetNames = dmvChatTabNames_(session.spreadsheet);
  } catch (ignored) {
    /* A metadata refresh cannot hide an already successful write. */
  }
  return session.spreadsheet;
}

function dmvChatSheetTarget_(session, name) {
  var sheetName = dmvSheetName_(name);
  var sheet = session.spreadsheet.getSheetByName(sheetName);
  // A tab an earlier tool created through the Sheets API is not on the cached object yet.
  if (!sheet) sheet = dmvChatSeeNewTabs_(session).getSheetByName(sheetName);
  if (!sheet)
    throw new Error(
      'No tab named "' +
        name +
        '". Tabs: ' +
        (session.sheetNames || []).join(', ') +
        '. Use list_sheets first.'
    );
  return sheet;
}

// An A1 address without a leading name of sheet itself (Sales!A1:B5 or 'Sales'!A1:B5), as
// models write it; other text is returned as it is, for the caller to refuse.
function dmvChatOwnTabA1_(sheet, address) {
  var at = typeof address === 'string' ? address.lastIndexOf('!') : -1;
  if (at < 0) return address;
  var tab = address
    .slice(0, at)
    .replace(/^'(.*)'$/, '$1')
    .replace(/''/g, "'");
  return tab === sheet.getName() ? address.slice(at + 1) : address;
}

function dmvChatSheetArea_(sheet, address) {
  address = dmvChatOwnTabA1_(sheet, address);
  if (
    typeof address !== 'string' ||
    !/^[A-Za-z]{1,3}[1-9][0-9]{0,6}(?::[A-Za-z]{1,3}[1-9][0-9]{0,6})?$/.test(address)
  )
    throw new Error('Use an explicit same-tab A1 range, such as B2 or A1:F20.');
  var parts = address.toUpperCase().split(':'),
    start = dmvCell_(parts[0]),
    end = dmvCell_(parts[1] || parts[0]);
  var rows = end.row - start.row + 1,
    columns = end.column - start.column + 1;
  if (rows < 1 || columns < 1 || rows > 200 || columns > 30 || rows * columns > 1000)
    throw new Error('Inspect or edit at most 1,000 cells, 200 rows and 30 columns at a time.');
  if (end.row > sheet.getMaxRows() || end.column > sheet.getMaxColumns())
    throw new Error('The requested range is outside the existing sheet grid.');
  return {
    a1: start.a1 + (start.a1 === end.a1 ? '' : ':' + end.a1),
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

function dmvChatSheetRead_(session, sheet, area) {
  dmvChatSheetDeadline_(session);
  var result = Sheets.Spreadsheets.get(session.spreadsheetId, {
    ranges: [dmvChatActionTab_(sheet.getName()) + area.a1],
    includeGridData: true,
    fields:
      'sheets(properties,basicFilter,data(startRow,startColumn,rowData(values(' +
      DMV_SHEET_UNDO.readFields +
      '))))',
  });
  var read = (result.sheets || []).filter(function (entry) {
    return entry.properties.sheetId === sheet.getSheetId();
  })[0];
  if (!read) throw new Error('The requested tab could not be inspected.');
  var cells = Array.from({ length: area.rows }, function () {
    return Array.from({ length: area.columns }, function () {
      return {};
    });
  });
  (read.data || []).forEach(function (block) {
    (block.rowData || []).forEach(function (row, r) {
      (row.values || []).forEach(function (cell, c) {
        var rowIndex = (block.startRow || 0) + r - area.grid.startRowIndex;
        var columnIndex = (block.startColumn || 0) + c - area.grid.startColumnIndex;
        if (rowIndex >= 0 && rowIndex < area.rows && columnIndex >= 0 && columnIndex < area.columns)
          cells[rowIndex][columnIndex] = cell;
      });
    });
  });
  return { properties: read.properties, basicFilter: read.basicFilter || null, cells: cells };
}

function dmvChatSheetFingerprint_(snapshot) {
  return dmvOutputDigest_(dmvCanonical_(snapshot));
}

// A private, single-use editToken for five minutes, bound to the range's cells and sheet settings
// as snapshot read them (dmvChatSheetInspected_ checks it).
function dmvChatSheetToken_(session, sheet, area, snapshot) {
  var token = dmvChatNewId_('e', 32);
  var saved = {
    spreadsheetId: session.spreadsheetId,
    sheetId: sheet.getSheetId(),
    sheetName: sheet.getName(),
    range: area.a1,
    fingerprint: dmvChatSheetFingerprint_(snapshot),
    createdAt: Date.now(),
  };
  CacheService.getUserCache().put('dmv:sheet-edit:' + token, JSON.stringify(saved), 300);
  return token;
}

// After an edit within an inspected range: a fresh token for that whole range as the edit left it
// (snapshot when already read back, else read here), as an inspection would give, so the next
// edit within it needs none. Null when it cannot be read.
function dmvChatSheetRetoken_(session, sheet, area, snapshot) {
  try {
    return dmvChatSheetToken_(
      session,
      sheet,
      area,
      snapshot || dmvChatSheetRead_(session, sheet, area)
    );
  } catch (ignored) {
    return null;
  }
}

function dmvChatListSheets_(session, input) {
  dmvChatSheetObject_(input || {}, []);
  dmvChatSheetDeadline_(session);
  var result = {
    sheets: session.spreadsheet.getSheets().map(function (sheet) {
      return {
        sheetName: sheet.getName(),
        sheetId: sheet.getSheetId(),
        rows: sheet.getMaxRows(),
        columns: sheet.getMaxColumns(),
      };
    }),
  };
  session.events.push({ kind: 'summary', text: 'Listed available spreadsheet tabs' });
  return result;
}

function dmvChatInspectSheet_(session, input) {
  dmvChatSheetObject_(input, ['sheetName', 'range']);
  var sheet = dmvChatSheetTarget_(session, input.sheetName),
    area = dmvChatSheetArea_(sheet, input.range);
  var snapshot = dmvChatSheetRead_(session, sheet, area);
  var token = dmvChatSheetToken_(session, sheet, area, snapshot);
  var nonempty = 0,
    formulas = 0;
  snapshot.cells.forEach(function (row) {
    row.forEach(function (cell) {
      if (cell.userEnteredValue && Object.keys(cell.userEnteredValue).length) nonempty++;
      if (cell.userEnteredValue && cell.userEnteredValue.formulaValue) formulas++;
    });
  });
  session.events.push({ kind: 'summary', text: 'Inspected ' + sheet.getName() + '!' + area.a1 });
  return {
    sheetName: sheet.getName(),
    sheetId: sheet.getSheetId(),
    range: area.a1,
    rows: area.rows,
    columns: area.columns,
    nonEmptyCells: nonempty,
    formulaCells: formulas,
    editToken: token,
    expiresInSeconds: 300,
    sample_rows: snapshot.cells.slice(0, 3).map(function (row) {
      return row.slice(0, 8).map(function (cell) {
        var value = cell.effectiveValue || cell.userEnteredValue || {};
        return dmvChatCell_(
          value.stringValue !== undefined
            ? value.stringValue
            : value.numberValue !== undefined
              ? value.numberValue
              : value.boolValue !== undefined
                ? value.boolValue
                : null
        );
      });
    }),
  };
}

// The cells of set_values or set_formulas. With formulas, text beginning with = is a formula,
// checked by dmvChatSheetFormulaPolicy_, and other cells are literal values, as in set_values.
function dmvChatSheetMatrix_(matrix, area, formulas) {
  if (
    !Array.isArray(matrix) ||
    matrix.length !== area.rows ||
    matrix.some(function (row) {
      return !Array.isArray(row) || row.length !== area.columns;
    })
  )
    throw new Error(
      'The cell matrix must match the inspected range exactly: ' +
        area.a1 +
        ' is ' +
        area.rows +
        ' rows × ' +
        area.columns +
        ' columns.'
    );
  return matrix.map(function (row) {
    return {
      values: row.map(function (value) {
        if (formulas && typeof value === 'string' && value.charAt(0) === '=')
          return { userEnteredValue: { formulaValue: value } };
        if (value === null || value === '') return {};
        if (typeof value === 'number' && Number.isFinite(value))
          return { userEnteredValue: { numberValue: value } };
        if (typeof value === 'boolean') return { userEnteredValue: { boolValue: value } };
        if (typeof value !== 'string' || value.length > 5000)
          throw new Error('Cell values must be literal text, finite numbers, booleans or null.');
        return { userEnteredValue: { stringValue: value } };
      }),
    };
  });
}

// A #RRGGBB colour as a Sheets Color; label names the field in the message.
function dmvChatSheetColor_(value, label) {
  if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value))
    throw new Error(label ? label + ' must be in #RRGGBB form.' : 'Use colors in #RRGGBB form.');
  return {
    red: parseInt(value.slice(1, 3), 16) / 255,
    green: parseInt(value.slice(3, 5), 16) / 255,
    blue: parseInt(value.slice(5, 7), 16) / 255,
  };
}

// The setBasicFilter request of a filter action over area, keeping an existing filter of the
// same range (basicFilter, whose range the API gives without its zero indexes) with its criteria.
function dmvChatSheetFilter_(filter, area, basicFilter) {
  filter = filter || {};
  dmvChatSheetObject_(filter, ['column', 'condition', 'value']);
  var basic = basicFilter || { range: area.grid };
  if (dmvChatGridA1_(basic.range) !== area.a1)
    throw new Error(
      'An existing filter covers a different range. Choose its range or adjust it manually.'
    );
  basic = JSON.parse(JSON.stringify(basic));
  if (Object.keys(filter).length) {
    if (
      ['TEXT_CONTAINS', 'TEXT_EQ', 'NUMBER_GREATER', 'NUMBER_LESS', 'NOT_BLANK'].indexOf(
        filter.condition
      ) < 0
    )
      throw new Error('Choose a supported text, number or nonblank filter.');
    var column =
      area.grid.startColumnIndex +
      dmvChatSheetInteger_(filter.column, 1, area.columns, 'Filter column') -
      1;
    var condition = { type: filter.condition };
    if (filter.condition !== 'NOT_BLANK') {
      if (typeof filter.value !== 'string' && typeof filter.value !== 'number')
        throw new Error('Provide a literal filter value.');
      if (
        String(filter.value).length > 200 ||
        (filter.condition.indexOf('NUMBER_') === 0 && !Number.isFinite(Number(filter.value)))
      )
        throw new Error('Provide a bounded valid filter value.');
      var numeric = filter.condition.indexOf('NUMBER_') === 0;
      if (!numeric && /^[=+@-]/.test(String(filter.value).trim()))
        throw new Error('Filter criteria must be literal text, not formulas.');
      if (numeric && String(filter.value).trim() === '')
        throw new Error('Provide a finite numeric filter value.');
      condition.values = [
        {
          userEnteredValue: numeric
            ? dmvChatSheetNumberValue_(Number(filter.value))
            : String(filter.value),
        },
      ];
    }
    basic.criteria = basic.criteria || {};
    basic.criteria[column] = { condition: condition };
  }
  return { setBasicFilter: { filter: basic } };
}

function dmvChatSheetFormat_(input) {
  dmvChatSheetObject_(input, [
    'numberFormat',
    'currencyCode',
    'bold',
    'textColor',
    'backgroundColor',
    'horizontalAlignment',
    'wrap',
  ]);
  if (!Object.keys(input).length) throw new Error('Choose at least one formatting change.');
  // 'number' is Sheets' own Number format. '#,##0.###' printed whole numbers as "2,494.", and the
  // range's values can change after this edit, so the decimals are fixed rather than guessed.
  // currency shows only a code it is given: the locale's default symbol could show $ on amounts
  // in AED or EUR, so without a code it is a plain amount, as the report writer leaves money.
  var format = {},
    fields = [],
    formats = {
      number: { type: 'NUMBER', pattern: '#,##0.00' },
      currency: { type: 'NUMBER', pattern: '#,##0.00' },
      percent: { type: 'PERCENT', pattern: '0.00%' },
      date: { type: 'DATE', pattern: 'yyyy-mm-dd' },
      text: { type: 'TEXT', pattern: '@' },
    };
  if (input.numberFormat !== undefined) {
    if (!Object.prototype.hasOwnProperty.call(formats, input.numberFormat))
      throw new Error('Choose number, currency, percent, date or text formatting.');
    format.numberFormat = formats[input.numberFormat];
    fields.push('numberFormat');
  }
  if (input.currencyCode !== undefined) {
    if (input.numberFormat !== 'currency')
      throw new Error('currencyCode is for numberFormat currency only.');
    if (typeof input.currencyCode !== 'string' || !/^[A-Z]{3}$/.test(input.currencyCode))
      throw new Error('currencyCode is a three-letter code in capitals, such as EUR.');
    format.numberFormat = { type: 'CURRENCY', pattern: '#,##0.00" ' + input.currencyCode + '"' };
  }
  if (input.bold !== undefined) {
    if (typeof input.bold !== 'boolean') throw new Error('bold must be true or false.');
    format.textFormat = { bold: input.bold };
    fields.push('textFormat.bold');
  }
  if (input.textColor !== undefined) {
    format.textFormat = Object.assign({}, format.textFormat, {
      foregroundColorStyle: { rgbColor: dmvChatSheetColor_(input.textColor) },
    });
    fields.push('textFormat.foregroundColorStyle');
  }
  if (input.backgroundColor !== undefined) {
    format.backgroundColorStyle = { rgbColor: dmvChatSheetColor_(input.backgroundColor) };
    fields.push('backgroundColorStyle');
  }
  if (input.horizontalAlignment !== undefined) {
    if (['LEFT', 'CENTER', 'RIGHT'].indexOf(input.horizontalAlignment) < 0)
      throw new Error('Choose LEFT, CENTER or RIGHT alignment.');
    format.horizontalAlignment = input.horizontalAlignment;
    fields.push('horizontalAlignment');
  }
  if (input.wrap !== undefined) {
    if (typeof input.wrap !== 'boolean') throw new Error('wrap must be true or false.');
    format.wrapStrategy = input.wrap ? 'WRAP' : 'CLIP';
    fields.push('wrapStrategy');
  }
  return {
    cell: { userEnteredFormat: format },
    fields: fields
      .map(function (field) {
        return 'userEnteredFormat.' + field;
      })
      .join(','),
  };
}

// The tab, range and current cells of an edit, after checking its inspection token: same user,
// spreadsheet and tab, the inspected range or a part of it, not expired, and the cells of the
// whole inspected range and the sheet settings unchanged. whole is the inspected range's area.
function dmvChatSheetInspected_(session, input) {
  if (typeof input.editToken !== 'string' || !/^e[a-f0-9]{32}$/.test(input.editToken))
    throw new Error('Inspect the target range before editing it.');
  var tokenKey = 'dmv:sheet-edit:' + input.editToken;
  var saved;
  try {
    saved = JSON.parse(CacheService.getUserCache().get(tokenKey) || 'null');
  } catch (ignored) {
    saved = null;
  }
  var sheet = dmvChatSheetTarget_(session, input.sheetName);
  var area = dmvChatSheetArea_(sheet, input.range),
    whole = null;
  if (
    saved &&
    Date.now() - saved.createdAt <= 300000 &&
    saved.spreadsheetId === session.spreadsheetId &&
    saved.sheetId === sheet.getSheetId() &&
    saved.sheetName === sheet.getName()
  ) {
    try {
      whole = dmvChatSheetArea_(sheet, saved.range);
    } catch (ignored) {
      /* Rows or columns were deleted since: the inspection no longer fits the tab. */
    }
  }
  var top = whole ? area.grid.startRowIndex - whole.grid.startRowIndex : -1,
    left = whole ? area.grid.startColumnIndex - whole.grid.startColumnIndex : -1;
  if (top < 0 || left < 0 || top + area.rows > whole.rows || left + area.columns > whole.columns)
    throw new Error(
      'The inspection expired or belongs to another range. Inspect this range again.'
    );
  var snapshot = dmvChatSheetRead_(session, sheet, whole);
  if (saved.fingerprint !== dmvChatSheetFingerprint_(snapshot))
    throw new Error(
      'The inspected cells or sheet settings changed. Inspect the range again before editing.'
    );
  // A refusal from here on spends no token (dmvChatEditSheetTool_).
  session.inspection = { token: input.editToken, range: sheet.getName() + '!' + whole.a1 };
  // The edit acts on its own part of the inspected cells.
  snapshot.cells = snapshot.cells.slice(top, top + area.rows).map(function (row) {
    return row.slice(left, left + area.columns);
  });
  return { sheet: sheet, area: area, snapshot: snapshot, tokenKey: tokenKey, whole: whole };
}

// edit_sheet for chat. A call refused after its inspection passed changed nothing, and only a
// batch spends the editToken, so the refusal says the token still holds: a model otherwise
// inspects again before every retry.
function dmvChatEditSheetTool_(session, input) {
  session.inspection = null;
  try {
    return dmvChatEditSheet_(session, input);
  } catch (error) {
    var kept = session.inspection;
    try {
      if (kept && CacheService.getUserCache().get('dmv:sheet-edit:' + kept.token))
        error.next =
          'Nothing changed, and the editToken still holds for ' +
          kept.range +
          ': correct the call and repeat it with that token.';
    } catch (ignored) {
      /* Without the cache the refusal stands as it is. */
    }
    throw error;
  }
}

// Every edit_sheet action runs through dmvChatSheetRunAction_. Built-in names win over the
// analyst ones, and only own names count, so "constructor" and the like stay unsupported.
function dmvChatEditSheet_(session, input) {
  var actions = Object.assign(dmvChatSheetActions_(), dmvChatSheetEditActions_()),
    action = input && input.action;
  if (typeof action !== 'string' || !Object.prototype.hasOwnProperty.call(actions, action))
    throw new Error('Choose a supported sheet action.');
  return dmvChatSheetRunAction_(session, input, actions[action]);
}

// The built-in edit_sheet actions, as specs of dmv_chat_sheet_actions.js. Their results name the
// tab as the call gave it. Cell-changing ones keep what they replace for undo_sheet_edit; a new
// or renamed tab is never undone and asks nothing: undo says how to reverse it.
function dmvChatSheetEditActions_() {
  return {
    set_values: { builtIn: true, fields: ['values'], plan: dmvChatSheetSetPlan_ },
    set_formulas: { builtIn: true, fields: ['formulas'], plan: dmvChatSheetSetPlan_ },
    format: { builtIn: true, fields: ['format'], plan: dmvChatSheetFormatPlan_ },
    sort: { builtIn: true, fields: ['sortBy', 'headerRows'], plan: dmvChatSheetSortPlan_ },
    // Without a range, a filter covers the tab's data and needs no inspection.
    filter: {
      builtIn: true,
      target: function (input) {
        return input.range === undefined ? 'sheet' : 'range';
      },
      fields: ['filter'],
      plan: dmvChatSheetFilterPlan_,
    },
    freeze: {
      builtIn: true,
      target: 'sheet',
      fields: ['frozenRows', 'frozenColumns'],
      plan: dmvChatSheetFreezePlan_,
    },
    rename_sheet: { builtIn: true, fields: ['newName'], plan: dmvChatSheetRenamePlan_ },
    create_sheet: {
      builtIn: true,
      target: 'none',
      fields: ['newName', 'count'],
      plan: dmvChatSheetCreatePlan_,
    },
  };
}

// set_values and set_formulas. Replacing more than 200 non-empty cells (with the earlier edits of
// the request) asks first; the next refresh rewrites report or dashboard output, so the guard of
// the touched cells refuses it there.
function dmvChatSheetSetPlan_(context) {
  var session = context.session,
    sheet = context.sheet,
    area = context.area,
    formulas = context.input.action === 'set_formulas',
    matrix = formulas ? context.input.formulas : context.input.values,
    touches = [area.grid],
    requests = [],
    policy = null;
  // A matrix of the wrong shape is left to the usual refusal below.
  if (
    formulas &&
    Array.isArray(matrix) &&
    matrix.length === area.rows &&
    matrix.every(function (row) {
      return Array.isArray(row) && row.length === area.columns;
    })
  ) {
    policy = dmvChatSheetFormulaPolicy_(session, sheet, area, matrix);
    touches = touches.concat(policy.touches || []);
    requests = requests.concat(policy.append || []);
  }
  requests.push({
    updateCells: {
      range: area.grid,
      rows: dmvChatSheetMatrix_(matrix, area, formulas),
      fields: 'userEnteredValue',
    },
  });
  return {
    requests: requests,
    touches: touches,
    overwrite: sheet.getName() + '!' + area.a1,
    // The count when the edit is too large for undo to count it.
    replaced: dmvChatSheetNonEmpty_(context.snapshot.cells),
    readBack: true,
    sheetName: context.input.sheetName,
    // Formulas are read back for their results.
    after:
      policy &&
      function () {
        return (
          context.written &&
          dmvChatSheetFormulaReadBack_(session, {
            sheet: sheet,
            area: area,
            formulas: matrix,
            policy: policy,
            after: dmvChatGridsRead_(session, touches, [
              { grid: area.grid, cells: context.written.cells },
            ]),
          })
        );
      },
  };
}

// A refresh keeps formatting, so report and dashboard output may take it: nothing is guarded.
function dmvChatSheetFormatPlan_(context) {
  return {
    requests: [
      {
        repeatCell: Object.assign(
          { range: context.area.grid },
          dmvChatSheetFormat_(context.input.format)
        ),
      },
    ],
    touches: [],
    undo: { snapshot: [context.area.grid] },
    readBack: true,
    sheetName: context.input.sheetName,
  };
}

function dmvChatSheetSortPlan_(context) {
  var input = context.input,
    area = context.area;
  if (!Array.isArray(input.sortBy) || !input.sortBy.length || input.sortBy.length > 5)
    throw new Error('Choose between one and five sort columns.');
  var sortRange = Object.assign({}, area.grid),
    headers = dmvChatSheetInteger_(
      input.headerRows === undefined ? 1 : input.headerRows,
      0,
      1,
      'Header rows'
    );
  if (headers >= area.rows) throw new Error('The sort range must include a data row.');
  sortRange.startRowIndex += headers;
  return {
    requests: [
      {
        sortRange: {
          range: sortRange,
          sortSpecs: input.sortBy.map(function (spec) {
            dmvChatSheetObject_(spec, ['column', 'ascending']);
            if (typeof spec.ascending !== 'boolean')
              throw new Error('Choose an ascending or descending sort.');
            return {
              dimensionIndex:
                area.grid.startColumnIndex +
                dmvChatSheetInteger_(spec.column, 1, area.columns, 'Sort column') -
                1,
              sortOrder: spec.ascending ? 'ASCENDING' : 'DESCENDING',
            };
          }),
        },
      },
    ],
    readBack: true,
    sheetName: input.sheetName,
  };
}

// A filter changes no cell, so it keeps no undo and is allowed over report output.
function dmvChatSheetFilterPlan_(context) {
  var sheet = context.sheet,
    area = context.area,
    current;
  if (area) current = context.snapshot.basicFilter;
  else {
    // Without a range: the tab's data, however large.
    if (!sheet.getLastRow()) throw new Error('The tab has no data to filter.');
    var data = dmvChatActionUsed_(sheet);
    area = {
      a1: dmvChatGridA1_(data),
      rows: data.endRowIndex,
      columns: data.endColumnIndex,
      grid: data,
    };
    current = dmvChatSheetRead_(context.session, sheet, dmvChatSheetArea_(sheet, 'A1')).basicFilter;
  }
  return {
    requests: [dmvChatSheetFilter_(context.input.filter, area, current)],
    touches: [],
    range: area.a1,
    sheetName: context.input.sheetName,
  };
}

function dmvChatSheetFreezePlan_(context) {
  var input = context.input,
    sheet = context.sheet,
    grid = {},
    fields = [];
  if (input.frozenRows !== undefined) {
    grid.frozenRowCount = dmvChatSheetInteger_(
      input.frozenRows,
      0,
      sheet.getMaxRows() - 1,
      'Frozen rows'
    );
    fields.push('gridProperties.frozenRowCount');
  }
  if (input.frozenColumns !== undefined) {
    grid.frozenColumnCount = dmvChatSheetInteger_(
      input.frozenColumns,
      0,
      sheet.getMaxColumns() - 1,
      'Frozen columns'
    );
    fields.push('gridProperties.frozenColumnCount');
  }
  if (!fields.length) throw new Error('Choose frozenRows or frozenColumns.');
  return {
    requests: [
      {
        updateSheetProperties: {
          properties: { sheetId: sheet.getSheetId(), gridProperties: grid },
          fields: fields.join(','),
        },
      },
    ],
    sheetName: input.sheetName,
  };
}

// rename_sheet takes an inspected range of the tab, and no fresh token follows.
function dmvChatSheetRenamePlan_(context) {
  var session = context.session,
    input = context.input,
    sheet = context.sheet,
    oldName = sheet.getName();
  // A refresh finds its tab by name, so a tab report or dashboard output uses keeps it.
  var user = dmvChatTabUser_(session, sheet);
  if (user && user.collaborator)
    throw new Error(
      'This tab holds the output of ' +
        dmvChatOwnerText_(user) +
        '. Ask them to update its destination before renaming the tab.'
    );
  if (user)
    throw new Error(
      'This tab is used by a saved ' + user.kind + '. Update its destination before renaming it.'
    );
  var newName = dmvSheetName_(input.newName);
  // Sheets keeps tab names unique without regard to case, so the tab itself may take other
  // capitals.
  if (
    session.spreadsheet.getSheets().some(function (other) {
      return (
        other.getSheetId() !== sheet.getSheetId() &&
        other.getName().toLowerCase() === newName.toLowerCase()
      );
    })
  )
    throw new Error('A tab with that name already exists.');
  return {
    requests: [
      {
        updateSheetProperties: {
          properties: { sheetId: sheet.getSheetId(), title: newName },
          fields: 'title',
        },
      },
    ],
    touches: [],
    sheetName: input.newName,
    text: 'Updated ' + input.sheetName + '!' + context.area.a1,
    retoken: false,
    after: function () {
      dmvChatUndoNone_(
        session,
        {
          action: input.action,
          sheetId: sheet.getSheetId(),
          sheetName: input.newName,
          text: 'Renamed tab ' + oldName + ' to ' + newName,
        },
        'Rename it back to "' + oldName + '" to reverse it.'
      );
    },
  };
}

function dmvChatSheetCreatePlan_(context) {
  var session = context.session,
    input = context.input,
    name = dmvSheetName_(input.newName);
  if (session.spreadsheet.getSheetByName(name))
    throw new Error('A tab with that name already exists. Choose another name.');
  // A helper tab of formulas over a large source needs rows for its whole result.
  var rowCount =
    input.count === undefined ? 1000 : dmvChatSheetInteger_(input.count, 1, 200000, 'count');
  return {
    requests: [
      {
        addSheet: {
          properties: { title: name, gridProperties: { rowCount: rowCount, columnCount: 26 } },
        },
      },
    ],
    sheetName: input.newName,
    text: 'Created tab ' + input.newName,
    // The new tab is the one the output links to.
    after: function () {
      var tab = (context.sheet = dmvChatSheetTarget_(session, name));
      dmvChatUndoNone_(
        session,
        {
          action: input.action,
          sheetId: tab.getSheetId(),
          sheetName: input.newName,
          text: 'Created tab ' + name,
        },
        dmvChatUndoNewTab_(name)
      );
      // A new tab is empty, so a token for its first block spares an inspection before the
      // edits that fill it.
      var block = dmvChatSheetArea_(tab, 'A1:Z' + Math.min(38, rowCount));
      return { editToken: dmvChatSheetRetoken_(session, tab, block), range: block.a1 };
    },
  };
}

function dmvChatSheetTools_() {
  var target = {
    sheetName: { type: 'string', description: 'An exact tab name returned by list_sheets.' },
    range: {
      type: 'string',
      description: 'Explicit A1 cell or range, at most 1,000 cells, 200 rows and 30 columns.',
    },
  };
  var tools = [
    {
      name: 'list_sheets',
      description: 'List the spreadsheet tabs and their grid sizes.',
      input_schema: { type: 'object', properties: {} },
      run: dmvChatListSheets_,
    },
    {
      name: 'inspect_sheet',
      description:
        'Inspect a bounded existing range before editing. Returns a small sample, counts and a private editToken valid for five minutes. Reinspect after a stale-token error.',
      input_schema: { type: 'object', properties: target, required: ['sheetName', 'range'] },
      run: dmvChatInspectSheet_,
    },
    {
      name: 'edit_sheet',
      description:
        'Perform a specifically requested sheet edit with one atomic batch. Existing edits take the inspected sheetName/editToken and its range or a part, and return a fresh editToken for that whole range; tab and row/column actions (freeze, filter without a range, insert/delete/group/ungroup rows or columns, duplicate/delete/hide/show_sheet) take sheetName only, no inspection. Supports the built-in and the analyst actions listed in action. Formula examples: =SUM(A2:A10), =XLOOKUP(A2,Data!A:A,Data!C:C), =QUERY(Data!A:F,"select B, sum(F) group by B"). The result lists the formula errors to fix. On report and dashboard output only format, filter and freeze are allowed (conditional_format too), since a refresh keeps them; change the report for anything else. A needsConfirmation answer means nothing changed: ask the user with ask_user (Yes/No) and on yes repeat the call with its confirmToken. undo_sheet_edit reverts cell edits.',
      input_schema: {
        type: 'object',
        properties: Object.assign({}, target, {
          action: {
            type: 'string',
            enum: [
              'set_values',
              'set_formulas',
              'format',
              'sort',
              'filter',
              'freeze',
              'create_sheet',
              'rename_sheet',
            ],
          },
          editToken: { type: 'string' },
          newName: {
            type: 'string',
            description:
              'Required for rename_sheet and create_sheet (which takes only newName and count).',
          },
          values: {
            type: 'array',
            items: {
              type: 'array',
              items: { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] },
            },
            description:
              'Exact rectangular literal cell matrix for set_values. Text beginning with = remains text; an empty string clears that selected cell.',
          },
          formulas: {
            type: 'array',
            items: { type: 'array', items: { type: 'string' } },
            description:
              "Exact matrix for set_formulas: formulas up to 8,000 characters each; other cells are values (labels, numbers). Any Google Sheets built-in (LET, LAMBDA, MAP, QUERY, FILTER, XLOOKUP, ARRAYFORMULA, REGEX…), other tabs ('Tab name'!A:C), whole or open ranges (A:A, A2:A), named ranges and {1,2;3,4}. An array result needs empty cells to fill. Not IMPORT*, IMAGE, GOOGLEFINANCE, GOOGLETRANSLATE, DETECTLANGUAGE, INDIRECT, AI or custom/named functions; HYPERLINK takes a literal https URL. Never call a LET name: hand a named LAMBDA to MAP, BYROW or REDUCE instead.",
          },
          format: {
            type: 'object',
            properties: {
              numberFormat: {
                type: 'string',
                enum: ['number', 'currency', 'percent', 'date', 'text'],
                description:
                  'Two decimals for number and currency; currency without currencyCode shows no symbol.',
              },
              currencyCode: {
                type: 'string',
                description:
                  "With currency: the values' three-letter code, such as EUR, shown after them.",
              },
              bold: { type: 'boolean' },
              textColor: { type: 'string', description: '#RRGGBB' },
              backgroundColor: { type: 'string', description: '#RRGGBB' },
              horizontalAlignment: { type: 'string', enum: ['LEFT', 'CENTER', 'RIGHT'] },
              wrap: { type: 'boolean' },
            },
          },
          sortBy: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                column: {
                  type: 'integer',
                  minimum: 1,
                  description: 'One-based column within the inspected range.',
                },
                ascending: { type: 'boolean' },
              },
              required: ['column', 'ascending'],
            },
          },
          headerRows: {
            type: 'integer',
            minimum: 0,
            maximum: 1,
            description: 'Rows to exclude from sorting; default1.',
          },
          filter: {
            type: 'object',
            properties: {
              column: { type: 'integer', minimum: 1 },
              condition: {
                type: 'string',
                enum: ['TEXT_CONTAINS', 'TEXT_EQ', 'NUMBER_GREATER', 'NUMBER_LESS', 'NOT_BLANK'],
              },
              value: { type: 'string' },
            },
            description:
              "One-based range column and literal criterion; omit or use empty object to enable filter controls. Without range: the tab's data.",
          },
          frozenRows: { type: 'integer', minimum: 0 },
          frozenColumns: { type: 'integer', minimum: 0 },
          confirmToken: {
            type: 'string',
            description:
              'Only after a needsConfirmation answer and the user saying yes: repeat the exact call with this token.',
          },
        }),
        required: ['action'],
      },
      run: dmvChatEditSheetTool_,
    },
    {
      name: 'undo_sheet_edit',
      description:
        'List or undo recent chat edits of this spreadsheet (the last 10, for 6 hours). undo restores the most recent edit, or the one named by id from list, unless its cells changed since.',
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'undo'] },
          id: { type: 'string', description: 'An id from list; omit to undo the latest edit.' },
        },
        required: ['action'],
      },
      run: dmvChatUndoSheetEdit_,
    },
  ];
  // The analyst actions add names and properties to edit_sheet; other analyst tools follow.
  var extra = dmvChatSheetActionSchema_(),
    edit = tools[2].input_schema.properties;
  extra.actions.forEach(function (name) {
    if (edit.action.enum.indexOf(name) < 0) edit.action.enum.push(name);
  });
  Object.keys(extra.properties).forEach(function (key) {
    if (!Object.prototype.hasOwnProperty.call(edit, key)) edit[key] = extra.properties[key];
  });
  var names = tools.map(function (tool) {
    return tool.name;
  });
  return tools.concat(
    dmvChatSheetExtraTools_().filter(function (tool) {
      if (names.indexOf(tool.name) >= 0) return false;
      names.push(tool.name);
      return true;
    })
  );
}
