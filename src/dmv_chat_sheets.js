/* Bounded existing-sheet edits. No arbitrary batch requests or executable source are accepted. */
function dmvChatSheetObject_(value, keys) {
  if (
    !value ||
    Object.prototype.toString.call(value) !== '[object Object]' ||
    Object.keys(value).some(function (key) {
      return keys.indexOf(key) < 0;
    })
  )
    throw new Error('Use only the documented fields for this sheet action.');
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
    session.sheetNames = session.spreadsheet.getSheets().map(function (sheet) {
      return sheet.getName();
    });
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

function dmvChatSheetArea_(sheet, address) {
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
    ranges: ["'" + sheet.getName().replace(/'/g, "''") + "'!" + area.a1],
    includeGridData: true,
    fields:
      'sheets(properties,basicFilter,data(startRow,startColumn,rowData(values(userEnteredValue,effectiveValue,userEnteredFormat,dataValidation,note,textFormatRuns))))',
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
  var token = 'e' + dmvOutputDigest_(Utilities.getUuid() + ':' + Date.now()).slice(0, 32);
  var saved = {
    spreadsheetId: session.spreadsheetId,
    sheetId: sheet.getSheetId(),
    sheetName: sheet.getName(),
    range: area.a1,
    fingerprint: dmvChatSheetFingerprint_(snapshot),
    createdAt: Date.now(),
  };
  CacheService.getUserCache().put('dmv:sheet-edit:' + token, JSON.stringify(saved), 300);
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

// The cells of set_values or set_formulas. Formulas were checked by dmvChatSheetFormulaPolicy_.
function dmvChatSheetMatrix_(matrix, area, formulas) {
  if (
    !Array.isArray(matrix) ||
    matrix.length !== area.rows ||
    matrix.some(function (row) {
      return !Array.isArray(row) || row.length !== area.columns;
    })
  )
    throw new Error('The cell matrix must match the inspected range exactly.');
  return matrix.map(function (row) {
    return {
      values: row.map(function (value) {
        if (formulas) {
          if (typeof value !== 'string')
            throw new Error('Each formula must be text beginning with =.');
          return { userEnteredValue: { formulaValue: value } };
        }
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

function dmvChatSheetFormat_(input) {
  dmvChatSheetObject_(input, [
    'numberFormat',
    'bold',
    'textColor',
    'backgroundColor',
    'horizontalAlignment',
    'wrap',
  ]);
  if (!Object.keys(input).length) throw new Error('Choose at least one formatting change.');
  // 'number' is Sheets' own Number format. '#,##0.###' printed whole numbers as "2,494.", and the
  // range's values can change after this edit, so the decimals are fixed rather than guessed.
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
// spreadsheet, tab and range, not expired, and the cells and sheet settings unchanged.
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
  var area = dmvChatSheetArea_(sheet, input.range);
  if (
    !saved ||
    Date.now() - saved.createdAt > 300000 ||
    saved.spreadsheetId !== session.spreadsheetId ||
    saved.sheetId !== sheet.getSheetId() ||
    saved.sheetName !== sheet.getName() ||
    saved.range !== area.a1
  )
    throw new Error(
      'The inspection expired or belongs to another range. Inspect this range again.'
    );
  var snapshot = dmvChatSheetRead_(session, sheet, area);
  if (saved.fingerprint !== dmvChatSheetFingerprint_(snapshot))
    throw new Error(
      'The inspected cells or sheet settings changed. Inspect the range again before editing.'
    );
  return { sheet: sheet, area: area, snapshot: snapshot, tokenKey: tokenKey };
}

// Cell-changing built-in edits keep what they replace for undo_sheet_edit. Replacing more than
// 200 non-empty cells, or an edit too large to keep, waits for the user's yes. edit holds
// { sheet, area, snapshot, touches, replaces }; returns { prepared, approval }, or { ask } with
// the needsConfirmation answer when nothing may change yet.
function dmvChatSheetEditPrepare_(session, input, edit) {
  var prepared = dmvChatUndoPrepare_(session, { snapshot: edit.touches }, [
    { grid: edit.area.grid, cells: edit.snapshot.cells },
  ]);
  var reasons = [];
  if (edit.replaces) {
    var replaced = 0;
    (prepared.cells || [{ rows: edit.snapshot.cells }]).forEach(function (item) {
      replaced += dmvChatSheetNonEmpty_(item.rows);
    });
    if (replaced > DMV_SHEET_UNDO.overwriteCells)
      reasons.push(
        'This replaces ' +
          replaced +
          ' non-empty cells in ' +
          edit.sheet.getName() +
          '!' +
          edit.area.a1 +
          '.'
      );
  }
  if (prepared.unavailable) reasons.push(prepared.unavailable);
  var approval = null;
  if (reasons.length) {
    var summary = reasons.join(' '),
      scope = dmvChatConfirmScope_(summary, prepared.cells);
    approval = dmvChatConfirmFind_(session, 'edit_sheet', input, scope);
    if (!approval)
      return { ask: dmvChatConfirmIssue_(session, 'edit_sheet', input, summary, scope) };
  }
  return { prepared: prepared, approval: approval };
}

// After a built-in edit: records its undo entry and reads formulas back for their results, even
// when the edit cannot be undone here. edit holds { sheet, area, touches, prepared, policy };
// returns { undoId, readBack }, each null when not available.
function dmvChatSheetEditRecord_(session, input, edit) {
  var sheet = edit.sheet,
    area = edit.area,
    prepared = edit.prepared,
    undoId = null,
    readBack = null;
  if ((!prepared || prepared.unavailable) && !edit.policy)
    return { undoId: undoId, readBack: readBack };
  // The edited cells as they are now: undo refuses once they change again.
  var after = null;
  try {
    after = [{ grid: area.grid, cells: dmvChatSheetRead_(session, sheet, area).cells }];
  } catch (ignored) {
    /* Without the read-back the edit stands but cannot be undone here. */
  }
  if (after && prepared && !prepared.unavailable)
    undoId = dmvChatUndoCommit_(
      session,
      prepared,
      {
        action: input.action,
        sheetId: sheet.getSheetId(),
        sheetName: sheet.getName(),
        range: area.a1,
        text: input.action + ' ' + sheet.getName() + '!' + area.a1,
      },
      after
    );
  if (edit.policy && after) {
    try {
      readBack = dmvChatSheetFormulaReadBack_(session, {
        sheet: sheet,
        area: area,
        formulas: input.formulas,
        policy: edit.policy,
        after: dmvChatGridsRead_(session, edit.touches, after),
      });
    } catch (ignored) {
      readBack = null;
    }
  }
  return { undoId: undoId, readBack: readBack };
}

function dmvChatEditSheet_(session, input) {
  var actions = {
    set_values: ['values'],
    set_formulas: ['formulas'],
    format: ['format'],
    sort: ['sortBy', 'headerRows'],
    filter: ['filter'],
    freeze: ['frozenRows', 'frozenColumns'],
    rename_sheet: ['newName'],
    create_sheet: ['newName'],
  };
  if (!input || !Object.prototype.hasOwnProperty.call(actions, input.action)) {
    var extra = input && typeof input.action === 'string' && dmvChatSheetActions_();
    // Own names only, so "constructor" and the like stay unsupported.
    if (extra && Object.prototype.hasOwnProperty.call(extra, input.action))
      return dmvChatSheetRunAction_(session, input, extra[input.action]);
    throw new Error('Choose a supported sheet action.');
  }
  dmvChatSheetObject_(
    input,
    input.action === 'create_sheet'
      ? ['action', 'newName']
      : ['action', 'sheetName', 'range', 'editToken', 'confirmToken'].concat(actions[input.action])
  );
  if (JSON.stringify(input).length > 250000)
    throw new Error('The sheet edit is too large. Use a smaller range.');
  return dmvWorkbookLocked_(function () {
    dmvChatSheetDeadline_(session);
    var requests = [],
      sheet,
      area,
      snapshot,
      tokenKey,
      touches = [],
      replaces = false,
      policy = null,
      prepared = null,
      approval = null;
    if (input.action === 'create_sheet') {
      var name = dmvSheetName_(input.newName);
      if (session.spreadsheet.getSheetByName(name))
        throw new Error('A tab with that name already exists. Choose another name.');
      requests.push({
        addSheet: {
          properties: { title: name, gridProperties: { rowCount: 1000, columnCount: 26 } },
        },
      });
    } else {
      var inspected = dmvChatSheetInspected_(session, input);
      sheet = inspected.sheet;
      area = inspected.area;
      snapshot = inspected.snapshot;
      tokenKey = inspected.tokenKey;
      touches = [area.grid];
      replaces = input.action === 'set_values' || input.action === 'set_formulas';
      // A matrix of the wrong shape is left to the usual refusal below.
      if (
        input.action === 'set_formulas' &&
        Array.isArray(input.formulas) &&
        input.formulas.length === area.rows &&
        input.formulas.every(function (row) {
          return Array.isArray(row) && row.length === area.columns;
        })
      ) {
        policy = dmvChatSheetFormulaPolicy_(session, sheet, area, input.formulas);
        if (policy && policy.touches) touches = touches.concat(policy.touches);
      }
      // The next refresh rewrites report or dashboard output, so its values and order are
      // refused here; formatting, filters and frozen panes stay allowed, as before.
      if (replaces || input.action === 'sort') dmvChatSheetGuard_(session, touches);
      if (replaces) {
        requests.push({
          updateCells: {
            range: area.grid,
            rows: dmvChatSheetMatrix_(
              input.action === 'set_values' ? input.values : input.formulas,
              area,
              input.action === 'set_formulas'
            ),
            fields: 'userEnteredValue',
          },
        });
      } else if (input.action === 'format') {
        requests.push({
          repeatCell: Object.assign({ range: area.grid }, dmvChatSheetFormat_(input.format)),
        });
      } else if (input.action === 'sort') {
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
        requests.push({
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
        });
      } else if (input.action === 'filter') {
        var filter = input.filter || {};
        dmvChatSheetObject_(filter, ['column', 'condition', 'value']);
        var basic = snapshot.basicFilter || { range: area.grid };
        if (dmvChatSheetFingerprint_(basic.range) !== dmvChatSheetFingerprint_(area.grid))
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
              { userEnteredValue: numeric ? String(Number(filter.value)) : String(filter.value) },
            ];
          }
          basic.criteria = basic.criteria || {};
          basic.criteria[column] = { condition: condition };
        }
        requests.push({ setBasicFilter: { filter: basic } });
      } else if (input.action === 'freeze') {
        var grid = {},
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
        requests.push({
          updateSheetProperties: {
            properties: { sheetId: sheet.getSheetId(), gridProperties: grid },
            fields: fields.join(','),
          },
        });
      } else if (input.action === 'rename_sheet') {
        if (
          dmvList_('dashboard').some(function (dashboard) {
            return (
              dashboard.spreadsheetId === session.spreadsheetId &&
              [dashboard.target, dashboard.dataTarget]
                .concat(dashboard.outputs || [])
                .concat(
                  dashboard.plan ? [{ sheetName: dmvDashboardChartTab_(dashboard.target) }] : []
                )
                .some(function (target) {
                  return target && target.sheetName === sheet.getName();
                })
            );
          })
        )
          throw new Error(
            'This tab is used by a saved dashboard. Update its destination before renaming it.'
          );
        var newName = dmvSheetName_(input.newName);
        if (session.spreadsheet.getSheetByName(newName))
          throw new Error('A tab with that name already exists.');
        if (
          dmvList_('report').some(function (report) {
            return (
              report.spreadsheetId === session.spreadsheetId &&
              report.target &&
              report.target.sheetName === sheet.getName()
            );
          })
        )
          throw new Error(
            'This tab is used by a saved report. Update its destination before renaming it.'
          );
        requests.push({
          updateSheetProperties: {
            properties: { sheetId: sheet.getSheetId(), title: newName },
            fields: 'title',
          },
        });
      }
    }
    if (['set_values', 'set_formulas', 'format', 'sort'].indexOf(input.action) >= 0) {
      var prepare = dmvChatSheetEditPrepare_(session, input, {
        sheet: sheet,
        area: area,
        snapshot: snapshot,
        touches: touches,
        replaces: replaces,
      });
      if (prepare.ask) return prepare.ask;
      prepared = prepare.prepared;
      approval = prepare.approval;
    }
    dmvChatSheetDeadline_(session);
    var response = Sheets.Spreadsheets.batchUpdate({ requests: requests }, session.spreadsheetId);
    if (tokenKey) {
      try {
        CacheService.getUserCache().remove(tokenKey);
      } catch (ignored) {
        /* The changed fingerprint still prevents replay. */
      }
    }
    dmvChatConfirmSpend_(session, approval);
    var recorded = dmvChatSheetEditRecord_(session, input, {
      sheet: sheet,
      area: area,
      touches: touches,
      prepared: prepared,
      policy: policy,
    });
    var outputName = input.newName || input.sheetName;
    var created =
      response && response.replies && response.replies[0] && response.replies[0].addSheet;
    var outputId = sheet
      ? sheet.getSheetId()
      : created && created.properties && created.properties.sheetId;
    var url = Number.isInteger(outputId)
      ? dmvSheetUrl_(session.spreadsheet, outputId, area ? area.a1 : 'A1')
      : dmvSheetLink_(session.spreadsheet, { sheetName: outputName }, area ? area.a1 : 'A1');
    session.events.push({
      kind: 'write',
      links: url ? [{ label: outputName, url: url }] : [],
      text:
        input.action === 'create_sheet'
          ? 'Created tab ' + input.newName
          : 'Updated ' + input.sheetName + '!' + area.a1,
      details: dmvChatDetails_([
        ['Action', input.action],
        ['Range', area ? area.a1 : ''],
      ]),
    });
    dmvChatSeeNewTabs_(session);
    var result = {
      ok: true,
      action: input.action,
      sheetName: outputName,
      url: url,
      range: area ? area.a1 : null,
    };
    if (recorded.undoId) result.undoId = recorded.undoId;
    return Object.assign(result, recorded.readBack || {});
  });
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
        'Inspect a bounded existing range before editing. Returns a small sample, counts and a private editToken valid for five minutes. Reinspect after any edit or stale-token error.',
      input_schema: { type: 'object', properties: target, required: ['sheetName', 'range'] },
      run: dmvChatInspectSheet_,
    },
    {
      name: 'edit_sheet',
      description:
        'Perform a specifically requested sheet edit with one atomic batch. Existing edits require the exact inspected sheetName/range/editToken. Supports literal values, formulas, formatting, sorting, basic filters, freeze panes, tab creation/rename and the analyst actions listed in action. No arbitrary API requests, external, custom or INDIRECT formulas. Formula examples: =SUM(A2:A10), =XLOOKUP(A2,Data!A:A,Data!C:C), =QUERY(Data!A:F,"select B, sum(F) group by B"). The result lists formula errors (cell, error, message) to fix. On report and dashboard output only format, filter and freeze are allowed (conditional_format too), since a refresh keeps them; change the report for anything else. A needsConfirmation answer means nothing changed: ask the user with ask_user (Yes/No) and on yes repeat the call with its confirmToken. undo_sheet_edit reverts cell edits.',
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
              'Required for create_sheet or rename_sheet. create_sheet needs only action and newName.',
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
              "Exact matrix for set_formulas, up to 8,000 characters each. Any Google Sheets built-in (LET, LAMBDA, MAP, QUERY, FILTER, XLOOKUP, ARRAYFORMULA, REGEX…), other tabs ('Tab name'!A:C), whole or open ranges (A:A, A2:A), named ranges and {1,2;3,4}. An array result needs empty cells to fill. Not IMPORT*, IMAGE, GOOGLEFINANCE, GOOGLETRANSLATE, DETECTLANGUAGE, INDIRECT, AI or custom/named functions; HYPERLINK takes a literal https URL.",
          },
          format: {
            type: 'object',
            properties: {
              numberFormat: {
                type: 'string',
                enum: ['number', 'currency', 'percent', 'date', 'text'],
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
              'One-based range column and literal criterion; omit or use empty object to enable filter controls.',
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
      run: dmvChatEditSheet_,
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
      return names.indexOf(tool.name) < 0;
    })
  );
}
