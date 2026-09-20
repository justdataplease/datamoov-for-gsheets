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

// A small expression parser distinguishes ranges from scalar results to prevent array spills.
function dmvChatSheetFormula_(formula, sheet) {
  var failure =
    'Use supported scalar built-in formulas with same-tab A1 references. External data, custom functions, named ranges, cross-tab references and array spills are not supported.';
  if (typeof formula !== 'string' || formula.length > 2000 || formula.charAt(0) !== '=')
    throw new Error(failure);
  var scalar = (
    'ABS AND OR NOT IF IFS IFERROR IFNA ROUND ROUNDUP ROUNDDOWN INT MOD POWER SQRT CEILING FLOOR SIGN ' +
    'LEN LOWER UPPER PROPER TRIM CLEAN LEFT RIGHT MID CONCAT CONCATENATE TEXTJOIN SUBSTITUTE REPLACE FIND SEARCH EXACT VALUE TEXT ' +
    'DATE YEAR MONTH DAY WEEKDAY EOMONTH EDATE TODAY NOW ISBLANK ISNUMBER ISTEXT ISERROR ISNA ISEVEN ISODD TRUE FALSE'
  ).split(' ');
  var aggregate =
    'SUM AVERAGE MIN MAX COUNT COUNTA COUNTBLANK COUNTIF COUNTIFS SUMIF SUMIFS AVERAGEIF AVERAGEIFS PRODUCT MEDIAN SUMPRODUCT STDEV STDEVP VAR VARP'.split(
      ' '
    );
  var tokens = [],
    position = 1,
    match,
    references = [];
  while (position < formula.length) {
    var tail = formula.slice(position);
    if (/^\s/.test(tail)) {
      position++;
      continue;
    }
    match =
      /^(?:"(?:[^"]|"")*"|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|\$?[A-Za-z]{1,3}\$?[1-9][0-9]{0,6}|[A-Za-z_][A-Za-z0-9_.]*|<>|<=|>=|[()+\-*/^&=<>%,:])/.exec(
        tail
      );
    if (!match) throw new Error(failure);
    tokens.push(match[0]);
    position += match[0].length;
  }
  var index = 0;
  function reference(token) {
    var start = dmvCell_(token.replace(/\$/g, '').toUpperCase()),
      end = start,
      type = 'scalar';
    if (tokens[index] === ':') {
      index++;
      var next = tokens[index++];
      if (!next || !/^\$?[A-Za-z]{1,3}\$?[1-9][0-9]{0,6}$/.test(next)) throw new Error(failure);
      end = dmvCell_(next.replace(/\$/g, '').toUpperCase());
      type = 'range';
    }
    if (
      end.row < start.row ||
      end.column < start.column ||
      end.row > sheet.getMaxRows() ||
      end.column > sheet.getMaxColumns() ||
      (end.row - start.row + 1) * (end.column - start.column + 1) > 1000
    )
      throw new Error(failure);
    references.push({
      row: start.row,
      column: start.column,
      rows: end.row - start.row + 1,
      columns: end.column - start.column + 1,
    });
    return type;
  }
  function atom() {
    var token = tokens[index++];
    if (!token) throw new Error(failure);
    if (token === '+' || token === '-') return atom();
    if (token === '(') {
      var grouped = expression();
      if (tokens[index++] !== ')') throw new Error(failure);
      return grouped;
    }
    if (token.charAt(0) === '"' || /^(?:\d|\.)/.test(token)) return 'scalar';
    if (/^\$?[A-Za-z]{1,3}\$?[1-9][0-9]{0,6}$/.test(token)) return reference(token);
    var name = token.toUpperCase();
    if ((name === 'TRUE' || name === 'FALSE') && tokens[index] !== '(') return 'scalar';
    if (tokens[index++] !== '(' || (scalar.indexOf(name) < 0 && aggregate.indexOf(name) < 0))
      throw new Error(failure);
    var args = [];
    if (tokens[index] !== ')') {
      do {
        args.push(expression());
        if (tokens[index] !== ',') break;
        index++;
      } while (true);
    }
    if (tokens[index++] !== ')') throw new Error(failure);
    if (aggregate.indexOf(name) < 0 && args.indexOf('range') >= 0) throw new Error(failure);
    if (['SUMIF', 'COUNTIF', 'AVERAGEIF'].indexOf(name) >= 0 && args[1] === 'range')
      throw new Error(failure);
    if (
      ['SUMIFS', 'AVERAGEIFS', 'COUNTIFS'].indexOf(name) >= 0 &&
      args.some(function (type, i) {
        return type === 'range' && (name === 'COUNTIFS' ? i % 2 === 1 : i >= 2 && i % 2 === 0);
      })
    )
      throw new Error(failure);
    return 'scalar';
  }
  function expression() {
    var type = atom();
    while (index < tokens.length && tokens[index] !== ')' && tokens[index] !== ',') {
      var operator = tokens[index++];
      if (operator === '%') continue;
      if (['+', '-', '*', '/', '^', '&', '=', '<>', '<', '>', '<=', '>='].indexOf(operator) < 0)
        throw new Error(failure);
      if (atom() === 'range') type = 'range';
    }
    return type;
  }
  if (expression() !== 'scalar' || index !== tokens.length) throw new Error(failure);
  return references;
}

function dmvChatSheetFormulaDependencies_(formulas, sheet, session) {
  var visited = Object.create(null),
    visitedRanges = Object.create(null),
    pending = formulas.slice(),
    count = 0;
  while (pending.length) {
    if (session) dmvChatSheetDeadline_(session);
    var formula = pending.pop();
    dmvChatSheetFormula_(formula, sheet).forEach(function (range) {
      if (session) dmvChatSheetDeadline_(session);
      var rangeKey = [range.row, range.column, range.rows, range.columns].join(':');
      if (visitedRanges[rangeKey]) return;
      visitedRanges[rangeKey] = true;
      var existing = sheet
        .getRange(range.row, range.column, range.rows, range.columns)
        .getFormulas();
      existing.forEach(function (row, r) {
        row.forEach(function (value, c) {
          var key = range.row + r + ':' + (range.column + c);
          if (visited[key]) return;
          visited[key] = true;
          if (++count > 1000)
            throw new Error('The formula references too many cells. Use a smaller range.');
          if (value) pending.push(value);
        });
      });
    });
  }
}

function dmvChatSheetMatrix_(matrix, area, formulas, sheet, session) {
  if (
    !Array.isArray(matrix) ||
    matrix.length !== area.rows ||
    matrix.some(function (row) {
      return !Array.isArray(row) || row.length !== area.columns;
    })
  )
    throw new Error('The cell matrix must match the inspected range exactly.');
  var formulaList = [];
  var rows = matrix.map(function (row) {
    return {
      values: row.map(function (value) {
        if (formulas) {
          dmvChatSheetFormula_(value, sheet);
          formulaList.push(value);
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
  if (formulas) dmvChatSheetFormulaDependencies_(formulaList, sheet, session);
  return rows;
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
  var format = {},
    fields = [],
    formats = {
      number: { type: 'NUMBER', pattern: '#,##0.###' },
      currency: { type: 'NUMBER', pattern: '#,##0.00' },
      percent: { type: 'PERCENT', pattern: '0.00%' },
      date: { type: 'DATE', pattern: 'yyyy-mm-dd' },
      text: { type: 'TEXT', pattern: '@' },
    };
  function color(value) {
    if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value))
      throw new Error('Use colors in #RRGGBB form.');
    return {
      red: parseInt(value.slice(1, 3), 16) / 255,
      green: parseInt(value.slice(3, 5), 16) / 255,
      blue: parseInt(value.slice(5, 7), 16) / 255,
    };
  }
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
      foregroundColorStyle: { rgbColor: color(input.textColor) },
    });
    fields.push('textFormat.foregroundColorStyle');
  }
  if (input.backgroundColor !== undefined) {
    format.backgroundColorStyle = { rgbColor: color(input.backgroundColor) };
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
  if (!input || !Object.prototype.hasOwnProperty.call(actions, input.action))
    throw new Error('Choose a supported sheet action.');
  dmvChatSheetObject_(
    input,
    input.action === 'create_sheet'
      ? ['action', 'newName']
      : ['action', 'sheetName', 'range', 'editToken'].concat(actions[input.action])
  );
  if (JSON.stringify(input).length > 250000)
    throw new Error('The sheet edit is too large. Use a smaller range.');
  return dmvWorkbookLocked_(function () {
    dmvChatSheetDeadline_(session);
    var requests = [],
      sheet,
      area,
      snapshot,
      tokenKey;
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
      if (typeof input.editToken !== 'string' || !/^e[a-f0-9]{32}$/.test(input.editToken))
        throw new Error('Inspect the target range before editing it.');
      tokenKey = 'dmv:sheet-edit:' + input.editToken;
      var saved;
      try {
        saved = JSON.parse(CacheService.getUserCache().get(tokenKey) || 'null');
      } catch (ignored) {
        saved = null;
      }
      sheet = dmvChatSheetTarget_(session, input.sheetName);
      area = dmvChatSheetArea_(sheet, input.range);
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
      snapshot = dmvChatSheetRead_(session, sheet, area);
      if (saved.fingerprint !== dmvChatSheetFingerprint_(snapshot))
        throw new Error(
          'The inspected cells or sheet settings changed. Inspect the range again before editing.'
        );
      if (input.action === 'set_values' || input.action === 'set_formulas') {
        requests.push({
          updateCells: {
            range: area.grid,
            rows: dmvChatSheetMatrix_(
              input.action === 'set_values' ? input.values : input.formulas,
              area,
              input.action === 'set_formulas',
              sheet,
              session
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
              [dashboard.target, dashboard.dataTarget].some(function (target) {
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
          dmvReadDefinitions_(session.spreadsheet).definitions.some(function (definition) {
            return definition.target.sheetName === sheet.getName();
          }) ||
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
    dmvChatSheetDeadline_(session);
    var response = Sheets.Spreadsheets.batchUpdate({ requests: requests }, session.spreadsheetId);
    if (tokenKey) {
      try {
        CacheService.getUserCache().remove(tokenKey);
      } catch (ignored) {
        /* The changed fingerprint still prevents replay. */
      }
    }
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
    });
    dmvChatSeeNewTabs_(session);
    return {
      ok: true,
      action: input.action,
      sheetName: outputName,
      url: url,
      range: area ? area.a1 : null,
    };
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
  return [
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
        'Perform a specifically requested sheet edit with one atomic batch. Existing edits require the exact inspected sheetName/range/editToken. Supports literal values, safe scalar formulas, formatting, sorting, basic filters, freeze panes and tab creation/rename. No arbitrary API requests, deletion, external/custom formulas, cross-tab references or array spills. Formula examples: =SUM(A2:A10), =IF(B2>0,B2,0).',
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
              'Exact matrix for set_formulas. Common scalar built-ins and same-tab references only; ranges must be reduced by aggregates. No named ranges, INDIRECT, IMPORT functions or custom functions.',
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
        }),
        required: ['action'],
      },
      run: dmvChatEditSheet_,
    },
  ];
}
