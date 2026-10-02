/* Safety around chat sheet edits: DataMoov output stays protected, cell-changing edits can be
   undone, destructive or wide edits wait for the user's yes, and dmvChatSheetRunAction_ gives
   the analyst actions (dmv_chat_sheet_actions.js), analyst pivots and conditional formats the
   same guarantees as the built-in edits. */
var DMV_SHEET_UNDO = {
  // CacheService keeps a value for at most six hours.
  ttlSeconds: 21600,
  maxEntries: 10,
  maxChars: 900000,
  maxCells: 50000,
  // Replacing more non-empty cells than this asks the user first.
  overwriteCells: 200,
  confirmTtlSeconds: 1800,
  tabPrefix: 'DataMoov undo · ',
  restoreFields: 'userEnteredValue,userEnteredFormat,note,dataValidation,textFormatRuns',
};

/* Protected output */

// Report and dashboard output areas of this spreadsheet, from the receipts the writer keeps.
// A dashboard's page and chart data tabs are protected whole, since each refresh lays them out
// again. Chat tables (chat-… receipts) are not refreshed: a changed one only stops a later
// write_to_sheet at the same cell, which the writer already refuses.
function dmvChatOwnedAreas_(session) {
  var all = dmvStore_().getProperties(),
    prefix = dmvOutputKey_(session.spreadsheetId, ''),
    areas = [];
  Object.keys(all).forEach(function (key) {
    var id = key.slice(prefix.length);
    if (key.indexOf(prefix) !== 0 || id.indexOf('chat-') === 0) return;
    var area;
    try {
      area = JSON.parse(all[key]);
    } catch (ignored) {
      return;
    }
    if (!area || !Number.isInteger(area.sheetId)) return;
    var owner = dmvChatOutputOwner_(all, id);
    var whole = owner.kind === 'dashboard' && owner.page;
    areas.push({
      sheetId: area.sheetId,
      row: whole ? 1 : area.row,
      column: whole ? 1 : area.column,
      rows: whole ? Infinity : area.rows,
      columns: whole ? Infinity : area.columns,
      owner: owner,
    });
  });
  return areas;
}

function dmvChatOutputOwner_(all, id) {
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

// Refuses when a GridRange overlaps protected output. A missing end index means the rest of the
// tab, so { sheetId } is the whole tab and { sheetId, startRowIndex: 4 } every row from row 5
// (what inserting or deleting there would move).
function dmvChatSheetGuard_(session, ranges) {
  var owned = dmvChatOwnedAreas_(session);
  if (!owned.length) return;
  (ranges || []).forEach(function (grid) {
    var row = grid.startRowIndex || 0,
      column = grid.startColumnIndex || 0;
    var area = {
      sheetId: grid.sheetId,
      row: row + 1,
      column: column + 1,
      rows: grid.endRowIndex === undefined ? Infinity : grid.endRowIndex - row,
      columns: grid.endColumnIndex === undefined ? Infinity : grid.endColumnIndex - column,
    };
    owned.forEach(function (item) {
      if (!dmvRectanglesOverlap_(area, item)) return;
      var tab = dmvChatSheetById_(session, item.sheetId);
      var owner =
        item.owner.kind === 'report'
          ? 'the saved report "' + item.owner.name + '"'
          : item.owner.kind === 'dashboard'
            ? 'the dashboard "' + item.owner.name + '"'
            : 'a DataMoov report or dashboard';
      throw new Error(
        'This change would touch the output of ' +
          owner +
          (tab ? ' on tab "' + tab.getName() + '"' : '') +
          '. DataMoov rewrites that output on every refresh, so change the ' +
          (item.owner.kind === 'dashboard' ? 'dashboard' : 'report') +
          ' instead, or work on a copy of the data elsewhere.'
      );
    });
  });
}

function dmvChatSheetById_(session, sheetId) {
  function find(spreadsheet) {
    return spreadsheet.getSheets().filter(function (sheet) {
      return sheet.getSheetId() === sheetId;
    })[0];
  }
  try {
    return find(session.spreadsheet) || find(dmvChatSeeNewTabs_(session)) || null;
  } catch (ignored) {
    return null;
  }
}

/* Regular expressions */

// True when a repeated group holds a quantifier or an alternative at any depth, such as (a+)+,
// (a|a)+ or ((a+))*: JavaScript can take exponential time on them and cannot be interrupted, so
// search_sheets and find_replace refuse them. A group repeated a fixed number of times, {3},
// is not a repeat here.
function dmvChatRegexNested_(source) {
  var groups = [];
  function repeats(at) {
    var next = source.charAt(at);
    return next === '+' || next === '*' || (next === '{' && !/^\{\d+\}/.test(source.slice(at)));
  }
  for (var i = 0; i < source.length; i++) {
    var ch = source.charAt(i);
    if (ch === '\\') i++;
    else if (ch === '[') {
      // A character class: its brackets and quantifier signs are literal.
      i++;
      if (source.charAt(i) === '^') i++;
      if (source.charAt(i) === ']') i++;
      while (i < source.length && source.charAt(i) !== ']') {
        if (source.charAt(i) === '\\') i++;
        i++;
      }
    } else if (ch === '(') {
      groups.push(false);
      var kind = /^\?(?::|=|!|<=|<!|<[A-Za-z_$][\w$]*>)/.exec(source.slice(i + 1));
      if (kind) i += kind[0].length;
    } else if (ch === ')') {
      var inner = groups.pop();
      if (inner && repeats(i + 1)) return true;
      if (inner && groups.length) groups[groups.length - 1] = true;
    } else if (groups.length && (ch === '|' || ch === '?' || repeats(i)))
      groups[groups.length - 1] = true;
  }
  return false;
}

/* Cells */

function dmvChatGridA1_(grid) {
  var start = dmvChatA1_((grid.startRowIndex || 0) + 1, (grid.startColumnIndex || 0) + 1),
    end = dmvChatA1_(grid.endRowIndex, grid.endColumnIndex);
  return start === end ? start : start + ':' + end;
}

function dmvChatGridCells_(grid) {
  return (
    (grid.endRowIndex - (grid.startRowIndex || 0)) *
    (grid.endColumnIndex - (grid.startColumnIndex || 0))
  );
}

// The cells of bounded GridRanges in one Sheets request, as [{ grid, cells }] in the order given;
// cells is a full rows x columns matrix with {} for empty cells. values names other cell fields
// to read instead of the ones undo needs.
function dmvChatSheetCells_(session, grids, values) {
  if (!grids.length) return [];
  dmvChatSheetDeadline_(session);
  var ranges = grids.map(function (grid) {
    var sheet = dmvChatSheetById_(session, grid.sheetId);
    if (!sheet) throw new Error('A tab this change needs no longer exists. Use list_sheets.');
    return "'" + sheet.getName().replace(/'/g, "''") + "'!" + dmvChatGridA1_(grid);
  });
  var result = Sheets.Spreadsheets.get(session.spreadsheetId, {
    ranges: ranges,
    includeGridData: true,
    fields:
      'sheets(properties(sheetId),data(startRow,startColumn,rowData(values(' +
      (values ||
        'userEnteredValue,effectiveValue,userEnteredFormat,dataValidation,note,textFormatRuns') +
      '))))',
  });
  // The API answers one data block per requested range, per tab, in request order.
  var used = Object.create(null);
  return grids.map(function (grid) {
    var read = ((result && result.sheets) || []).filter(function (entry) {
      return entry.properties && entry.properties.sheetId === grid.sheetId;
    })[0];
    var index = (used[grid.sheetId] = (used[grid.sheetId] || 0) + 1) - 1;
    var block = read && (read.data || [])[index];
    var rows = grid.endRowIndex - (grid.startRowIndex || 0),
      columns = grid.endColumnIndex - (grid.startColumnIndex || 0);
    var cells = Array.from({ length: rows }, function () {
      return Array.from({ length: columns }, function () {
        return {};
      });
    });
    ((block && block.rowData) || []).forEach(function (row, r) {
      (row.values || []).forEach(function (cell, c) {
        var rowIndex = (block.startRow || 0) + r - (grid.startRowIndex || 0),
          columnIndex = (block.startColumn || 0) + c - (grid.startColumnIndex || 0);
        if (rowIndex >= 0 && rowIndex < rows && columnIndex >= 0 && columnIndex < columns)
          cells[rowIndex][columnIndex] = cell;
      });
    });
    return { grid: grid, cells: cells };
  });
}

function dmvChatGridKey_(grid) {
  return [
    grid.sheetId,
    grid.startRowIndex || 0,
    grid.endRowIndex,
    grid.startColumnIndex || 0,
    grid.endColumnIndex,
  ].join(':');
}

// The cells of each bounded grid, reusing those already read ([{ grid, cells }]) and reading the
// rest in one request.
function dmvChatGridsRead_(session, grids, known) {
  function find(list, grid) {
    return list.filter(function (item) {
      return dmvChatGridKey_(item.grid) === dmvChatGridKey_(grid);
    })[0];
  }
  grids.forEach(function (grid) {
    if (
      !Number.isInteger(grid.sheetId) ||
      !Number.isInteger(grid.endRowIndex) ||
      !Number.isInteger(grid.endColumnIndex)
    )
      throw new Error('Undo needs bounded ranges.');
  });
  known = known || [];
  var read = dmvChatSheetCells_(
    session,
    grids.filter(function (grid) {
      return !find(known, grid);
    })
  );
  return grids.map(function (grid) {
    return { grid: grid, cells: find(known.concat(read), grid).cells };
  });
}

// What undo restores of a cell: the entered value (formulas as formulas), format, note,
// validation and rich-text runs. Effective values are left out, so volatile formulas such as
// TODAY() never make a cell look changed.
function dmvChatUndoCell_(cell) {
  var kept = {};
  ['userEnteredValue', 'userEnteredFormat', 'note', 'dataValidation', 'textFormatRuns'].forEach(
    function (key) {
      if (cell && cell[key] !== undefined && cell[key] !== null) kept[key] = cell[key];
    }
  );
  // An error is a result, never something to type back in.
  if (kept.userEnteredValue && kept.userEnteredValue.errorValue) delete kept.userEnteredValue;
  return kept;
}

function dmvChatUndoFingerprint_(cells) {
  return dmvOutputDigest_(
    dmvCanonical_(
      cells.map(function (row) {
        return row.map(dmvChatUndoCell_);
      })
    )
  );
}

function dmvChatSheetNonEmpty_(cells) {
  var count = 0;
  cells.forEach(function (row) {
    row.forEach(function (cell) {
      if (cell.userEnteredValue && Object.keys(cell.userEnteredValue).length) count++;
    });
  });
  return count;
}

/* Undo */

function dmvChatUndoKey_(spreadsheetId) {
  return 'dmv:sheet-undo:' + dmvOutputDigest_(spreadsheetId).slice(0, 32);
}

// The undo list of this spreadsheet for this user, newest first, without expired entries.
function dmvChatUndoEntries_(session) {
  var entries;
  try {
    entries = JSON.parse(
      CacheService.getUserCache().get(dmvChatUndoKey_(session.spreadsheetId)) || '[]'
    );
  } catch (ignored) {
    entries = [];
  }
  return (Array.isArray(entries) ? entries : []).filter(function (entry) {
    return entry && Date.now() - entry.at < DMV_SHEET_UNDO.ttlSeconds * 1000;
  });
}

function dmvChatUndoDrop_(session, entries, keep) {
  var cache = CacheService.getUserCache();
  entries.forEach(function (entry) {
    if (keep.indexOf(entry) >= 0) return;
    try {
      var key = dmvChatUndoKey_(session.spreadsheetId) + ':' + entry.id,
        parts = Number(cache.get(key) || 0),
        keys = [key];
      for (var i = 0; i < parts; i++) keys.push(key + ':' + i);
      cache.removeAll(keys);
    } catch (ignored) {
      /* The cache drops it after six hours anyway. */
    }
    if (entry.copyId !== undefined) dmvChatUndoTabs_(session, entry.copyId, 0);
  });
  cache.put(
    dmvChatUndoKey_(session.spreadsheetId),
    JSON.stringify(keep),
    DMV_SHEET_UNDO.ttlSeconds
  );
}

// Before a batch: what undo needs, from an undo spec (see dmvChatSheetRunAction_). known lists
// cells already read ([{ grid, cells }]); the rest of spec.snapshot is read here. The result has
// unavailable set to the reason when the edit cannot be undone here.
function dmvChatUndoPrepare_(session, spec, known) {
  if (spec.none) return { unavailable: spec.none };
  if (!(spec.snapshot || []).length && !(spec.reverse || []).length && !spec.sheet) return null;
  var snapshot = spec.snapshot || [],
    total = 0;
  snapshot.forEach(function (grid) {
    total += dmvChatGridCells_(grid);
  });
  if (total > DMV_SHEET_UNDO.maxCells)
    return { unavailable: 'It is too large to undo here; Sheets version history can restore it.' };
  var cells = dmvChatGridsRead_(session, snapshot, known).map(function (found) {
    return {
      grid: found.grid,
      rows: found.cells.map(function (row) {
        return row.map(dmvChatUndoCell_);
      }),
    };
  });
  var packed = dmvPack_({ cells: cells, reverse: spec.reverse || [] });
  if (packed.length > DMV_SHEET_UNDO.maxChars)
    return { unavailable: 'It is too large to undo here; Sheets version history can restore it.' };
  // Tabs whose cells this edit moved (rows or columns inserted or deleted, a block moved): an
  // older edit there is found by position, so it waits until this one is undone.
  var moves = [];
  (spec.reverse || []).forEach(function (request) {
    var dimension = request.insertDimension || request.deleteDimension,
      cut = request.cutPaste;
    (dimension
      ? [dimension.range.sheetId]
      : cut
        ? [cut.source.sheetId, cut.destination.sheetId]
        : []
    )
      .filter(function (sheetId) {
        return moves.indexOf(sheetId) < 0;
      })
      .forEach(function (sheetId) {
        moves.push(sheetId);
      });
  });
  return {
    packed: packed,
    cells: cells,
    verify: spec.verify || snapshot,
    rules: spec.rules,
    sheet: spec.sheet || null,
    moves: moves,
    extent: spec.extent,
    named: spec.named,
    dims: spec.dims || [],
  };
}

// The row and column counts of the given tabs, as [{ sheetId, rows, columns }], from one Sheets
// request. Undo finds cells by position, so once rows or columns were inserted or deleted there,
// other cells sit where the edit was.
function dmvChatUndoDims_(session, sheetIds) {
  if (!sheetIds.length) return [];
  dmvChatSheetDeadline_(session);
  var result = Sheets.Spreadsheets.get(session.spreadsheetId, {
    fields: 'sheets(properties(sheetId,gridProperties(rowCount,columnCount)))',
  });
  return ((result && result.sheets) || [])
    .map(function (entry) {
      var properties = entry.properties || {},
        grid = properties.gridProperties || {};
      return {
        sheetId: properties.sheetId || 0,
        rows: grid.rowCount || 0,
        columns: grid.columnCount || 0,
      };
    })
    .filter(function (dims) {
      return sheetIds.indexOf(dims.sheetId) >= 0;
    });
}

// How far a tab's data reaches, as { sheetId, rows, columns }, or null when the tab is gone.
function dmvChatUndoExtent_(session, sheetId) {
  var sheet = dmvChatSheetById_(session, sheetId);
  if (!sheet) return null;
  var used = sheet.getDataRange();
  return { sheetId: sheetId, rows: used.getNumRows(), columns: used.getNumColumns() };
}

// After a successful batch: stores the undo entry and returns its id, or null when it could not
// be kept. after lists cells already read back ([{ grid, cells }]); other verify ranges are read
// here. Never fails the edit, which is already in the sheet.
function dmvChatUndoCommit_(session, prepared, details, after) {
  if (!prepared || prepared.unavailable) return null;
  try {
    var verify = prepared.verify || [];
    var read = dmvChatGridsRead_(session, verify, after);
    var id = 'u' + dmvOutputDigest_(Utilities.getUuid() + ':' + Date.now()).slice(0, 12);
    var entry = {
      id: id,
      at: Date.now(),
      action: details.action,
      sheetId: details.sheetId,
      sheetName: details.sheetName,
      range: details.range || '',
      text: String(details.text || '').slice(0, 200),
      verify: read.map(function (found) {
        return { grid: found.grid, fingerprint: dmvChatUndoFingerprint_(found.cells) };
      }),
    };
    var sheetIds = [];
    read
      .concat(prepared.cells || [])
      .map(function (item) {
        return item.grid.sheetId;
      })
      .concat(prepared.dims || [])
      .forEach(function (sheetId) {
        if (sheetIds.indexOf(sheetId) < 0) sheetIds.push(sheetId);
      });
    entry.dims = dmvChatUndoDims_(session, sheetIds);
    if ((prepared.moves || []).length) entry.moves = prepared.moves;
    if (prepared.extent !== undefined) {
      entry.extent = dmvChatUndoExtent_(session, prepared.extent);
      if (!entry.extent) return null;
    }
    if (prepared.named) entry.named = prepared.named;
    if (prepared.sheet) {
      entry.sheet = prepared.sheet;
      entry.copyId = prepared.sheet.copyId;
    }
    if (prepared.rules !== undefined) {
      entry.rules = {
        sheetId: prepared.rules,
        fingerprint: dmvChatUndoRules_(session, prepared.rules),
      };
      if (!entry.rules.fingerprint) return null;
    }
    dmvChatCachePut_(
      dmvChatUndoKey_(session.spreadsheetId) + ':' + id,
      prepared.packed,
      DMV_SHEET_UNDO.ttlSeconds
    );
    var entries = [entry].concat(dmvChatUndoEntries_(session));
    if (entry.copyId !== undefined)
      dmvChatUndoTabs_(session, entry.copyId, entry.at + DMV_SHEET_UNDO.ttlSeconds * 1000);
    dmvChatUndoDrop_(session, entries, entries.slice(0, DMV_SHEET_UNDO.maxEntries));
    return id;
  } catch (ignored) {
    return null;
  }
}

// A tab's conditional format rules as one fingerprint, or null when the tab is gone. A reverse
// that names a rule by its position is right only while the rules are as the edit left them.
function dmvChatUndoRules_(session, sheetId) {
  var sheet = dmvChatSheetById_(session, sheetId);
  return sheet ? dmvOutputDigest_(dmvCanonical_(dmvChatSheetRules_(session, sheet))) : null;
}

// Hidden undo copies of deleted tabs, by sheet id, with the time their undo window ends. Kept in
// the user's properties so a copy is removed even after its cache entry is gone. Expiry 0 marks
// a copy whose entry was dropped; null forgets it.
function dmvChatUndoTabs_(session, copyId, expiresAt) {
  var key = 'dmv:v1:undo-tabs:' + session.spreadsheetId,
    store = dmvStore_(),
    tabs;
  try {
    tabs = JSON.parse(store.getProperty(key) || '{}') || {};
  } catch (ignored) {
    tabs = {};
  }
  if (copyId === undefined) return tabs;
  if (expiresAt === null) delete tabs[copyId];
  else tabs[copyId] = expiresAt;
  if (Object.keys(tabs).length) store.setProperty(key, JSON.stringify(tabs));
  else store.deleteProperty(key);
  return tabs;
}

// Before delete_sheet: requests that keep a hidden copy of the tab, named "DataMoov undo · <tab>",
// in the same batch (put them before the deleteSheet), and the undo spec that brings it back.
// The copy is deleted by the first chat request or edit after its undo window ends
// (dmvChatUndoSweep_, dmvChatUndoCleanup_).
function dmvChatUndoSheetCopy_(session, sheet) {
  var sheets = dmvChatSeeNewTabs_(session).getSheets();
  var ids = sheets.map(function (item) {
      return item.getSheetId();
    }),
    names = sheets.map(function (item) {
      return item.getName();
    });
  var copyId = parseInt(dmvOutputDigest_(Utilities.getUuid()).slice(0, 7), 16);
  while (ids.indexOf(copyId) >= 0) copyId++;
  // Sheets refuses a tab name that differs from another only in case.
  var taken = names.map(function (item) {
    return item.toLowerCase();
  });
  var base = (DMV_SHEET_UNDO.tabPrefix + sheet.getName()).slice(0, 90),
    name = base,
    suffix = 2;
  while (taken.indexOf(name.toLowerCase()) >= 0) name = base + ' (' + suffix++ + ')';
  return {
    requests: [
      {
        duplicateSheet: {
          sourceSheetId: sheet.getSheetId(),
          insertSheetIndex: sheets.length,
          newSheetId: copyId,
          newSheetName: name,
        },
      },
      {
        updateSheetProperties: {
          properties: { sheetId: copyId, hidden: true },
          fields: 'hidden',
        },
      },
    ],
    undo: {
      sheet: {
        copyId: copyId,
        copyName: name,
        title: sheet.getName(),
        index: names.indexOf(sheet.getName()),
        hidden: !!sheet.isSheetHidden(),
      },
    },
  };
}

// deleteSheet requests for hidden undo copies whose window ended, while they are still hidden
// under their undo name; a copy the user renamed or showed again is theirs and is forgotten.
function dmvChatUndoCleanup_(session) {
  var tabs = dmvChatUndoTabs_(session),
    requests = [];
  Object.keys(tabs).forEach(function (id) {
    if (tabs[id] > Date.now()) return;
    var sheet = dmvChatSheetById_(session, Number(id));
    if (sheet && sheet.isSheetHidden() && sheet.getName().indexOf(DMV_SHEET_UNDO.tabPrefix) === 0)
      requests.push({ deleteSheet: { sheetId: Number(id) } });
    else dmvChatUndoTabs_(session, Number(id), null);
  });
  return requests;
}

function dmvChatUndoCleaned_(session, requests) {
  requests.forEach(function (request) {
    if (request.deleteSheet) dmvChatUndoTabs_(session, request.deleteSheet.sheetId, null);
  });
}

// At the start of each chat request: deletes the hidden copies whose undo window ended, so a
// deleted tab does not wait for the next analyst edit. Never fails the request.
function dmvChatUndoSweep_(session) {
  try {
    var tabs = dmvChatUndoTabs_(session);
    var due = Object.keys(tabs).some(function (id) {
      return tabs[id] <= Date.now();
    });
    if (!due) return;
    dmvWorkbookLocked_(function () {
      var cleanup = dmvChatUndoCleanup_(session);
      if (!cleanup.length) return;
      Sheets.Spreadsheets.batchUpdate({ requests: cleanup }, session.spreadsheetId);
      dmvChatUndoCleaned_(session, cleanup);
    });
  } catch (ignored) {
    /* A later request or edit tries again. */
  }
}

// Refuses an undo whose cells, data or named range are no longer where the edit left them: a
// later chat edit or the user inserted, deleted or moved rows and columns on its tabs, data was
// added to a copied tab outside what was copied, or the named range was changed since.
function dmvChatUndoPlaced_(session, entries, entry) {
  var dims = entry.dims || [];
  var tabs = dims.map(function (item) {
    return item.sheetId;
  });
  function tabName(sheetId) {
    var tab = dmvChatSheetById_(session, sheetId);
    return tab ? '"' + tab.getName() + '"' : 'its tab';
  }
  entries.slice(0, entries.indexOf(entry)).forEach(function (later) {
    var moved = (later.moves || []).filter(function (sheetId) {
      return tabs.indexOf(sheetId) >= 0;
    })[0];
    if (moved !== undefined)
      throw new Error(
        'A later chat edit (' +
          later.text +
          ') moved cells on ' +
          tabName(moved) +
          ', so the cells of this edit are no longer where they were. Undo the later edit first.'
      );
  });
  var now = dmvChatUndoDims_(session, tabs);
  dims.forEach(function (item) {
    var found = now.filter(function (current) {
      return current.sheetId === item.sheetId;
    })[0];
    if (found && (found.rows !== item.rows || found.columns !== item.columns))
      throw new Error(
        'Rows or columns of ' +
          tabName(item.sheetId) +
          ' were inserted or deleted since that edit, so its cells are no longer where they were and it cannot be undone here. Sheets version history can restore it.'
      );
  });
  if (entry.extent) {
    var extent = dmvChatUndoExtent_(session, entry.extent.sheetId);
    if (extent && (extent.rows !== entry.extent.rows || extent.columns !== entry.extent.columns))
      throw new Error(
        'The data of ' +
          tabName(entry.extent.sheetId) +
          ' grew or shrank since that edit, and undoing it deletes the tab with those changes. Delete the tab by hand if that is intended.'
      );
  }
  if (entry.named) dmvChatActionNamedUnchanged_(session, entry.named);
}

function dmvChatUndoSheetEdit_(session, input) {
  dmvChatSheetObject_(input || {}, ['action', 'id']);
  input = input || {};
  var action = input.action === undefined ? 'list' : input.action;
  if (action !== 'list' && action !== 'undo') throw new Error('Choose list or undo.');
  if (input.id !== undefined && (typeof input.id !== 'string' || !/^u[a-f0-9]{12}$/.test(input.id)))
    throw new Error('Use an undo id exactly as list returns it.');
  if (action === 'list') {
    var listed = dmvChatUndoEntries_(session);
    session.events.push({ kind: 'summary', text: 'Listed recent sheet edits that can be undone' });
    return {
      entries: listed.map(function (entry) {
        return {
          id: entry.id,
          action: entry.action,
          sheetName: entry.sheetName,
          range: entry.range,
          text: entry.text,
          minutesAgo: Math.floor((Date.now() - entry.at) / 60000),
        };
      }),
      note:
        'Newest first. Undo keeps the last ' +
        DMV_SHEET_UNDO.maxEntries +
        ' chat edits for 6 hours.',
    };
  }
  return dmvWorkbookLocked_(function () {
    dmvChatSheetDeadline_(session);
    var entries = dmvChatUndoEntries_(session);
    var entry =
      input.id === undefined
        ? entries[0]
        : entries.filter(function (item) {
            return item.id === input.id;
          })[0];
    if (!entry)
      throw new Error(
        entries.length
          ? 'No recent edit has that id. Use action list to see what can be undone.'
          : 'There is no recent chat edit to undo in this spreadsheet. Undo keeps the last ' +
              DMV_SHEET_UNDO.maxEntries +
              ' chat edits for 6 hours; Sheets version history keeps the rest.'
      );
    var text = dmvChatCacheGet_(dmvChatUndoKey_(session.spreadsheetId) + ':' + entry.id);
    if (!text)
      throw new Error(
        'That edit can no longer be undone here. Sheets version history can restore it.'
      );
    var data = dmvUnpack_(text);
    var requests = (data.reverse || []).slice();
    var sheet = dmvChatSheetById_(session, entry.sheet ? entry.sheet.copyId : entry.sheetId);
    if (!sheet)
      throw new Error(
        'The tab of that edit no longer exists, so it cannot be undone here. Sheets version history can restore it.'
      );
    if (entry.sheet) {
      if (dmvChatSeeNewTabs_(session).getSheetByName(entry.sheet.title))
        throw new Error(
          'A tab named "' +
            entry.sheet.title +
            '" exists again. Rename it first, then undo the deletion.'
        );
      requests.push({
        updateSheetProperties: {
          properties: {
            sheetId: entry.sheet.copyId,
            title: entry.sheet.title,
            hidden: entry.sheet.hidden,
            index: entry.sheet.index,
          },
          fields: 'title,hidden,index',
        },
      });
    }
    dmvChatUndoPlaced_(session, entries, entry);
    var current = dmvChatSheetCells_(
      session,
      (entry.verify || []).map(function (item) {
        return item.grid;
      })
    );
    (entry.verify || []).forEach(function (item, index) {
      if (dmvChatUndoFingerprint_(current[index].cells) !== item.fingerprint) {
        var tab = dmvChatSheetById_(session, item.grid.sheetId);
        throw new Error(
          'The cells in ' +
            (tab ? tab.getName() + '!' : '') +
            dmvChatGridA1_(item.grid) +
            ' changed since that edit, so it cannot be undone here. Sheets version history can restore it.'
        );
      }
    });
    if (entry.rules && dmvChatUndoRules_(session, entry.rules.sheetId) !== entry.rules.fingerprint)
      throw new Error(
        'The conditional format rules of ' +
          sheet.getName() +
          ' changed since that edit, so it cannot be undone here. Undo later edits first, or use conditional_format list and delete.'
      );
    // Reversing an insert or a delete moves everything from its span on, as the edit itself
    // did, so output written there since is refused the same way.
    var moved = (data.reverse || [])
      .map(function (request) {
        var dimension = request.insertDimension || request.deleteDimension;
        return dimension && dimension.range ? dmvChatActionSpanGuard_(dimension.range) : null;
      })
      .filter(Boolean);
    // format is allowed over report and dashboard output, so its undo is too: verify showed the
    // cells, values included, are as the edit left them, so the restore writes the same values
    // back and changes only the formatting.
    var formatOnly = entry.action === 'format';
    dmvChatSheetGuard_(
      session,
      (formatOnly ? [] : data.cells || [])
        .map(function (item) {
          return item.grid;
        })
        .concat(
          formatOnly
            ? []
            : (entry.verify || []).map(function (item) {
                return item.grid;
              }),
          moved
        )
    );
    (data.cells || []).forEach(function (item) {
      requests.push({
        updateCells: {
          range: item.grid,
          rows: item.rows.map(function (row) {
            return { values: row };
          }),
          fields: DMV_SHEET_UNDO.restoreFields,
        },
      });
    });
    var cleanup = dmvChatUndoCleanup_(session).filter(function (request) {
      return !entry.sheet || request.deleteSheet.sheetId !== entry.sheet.copyId;
    });
    if (!requests.length) throw new Error('That edit has nothing to undo.');
    var sheetId = sheet.getSheetId(),
      sheetName = entry.sheet ? entry.sheet.title : sheet.getName();
    dmvChatSheetDeadline_(session);
    Sheets.Spreadsheets.batchUpdate({ requests: requests.concat(cleanup) }, session.spreadsheetId);
    dmvChatUndoCleaned_(session, cleanup);
    try {
      dmvChatUndoDrop_(
        session,
        entries,
        entries.filter(function (item) {
          return item.id !== entry.id;
        })
      );
      if (entry.sheet) dmvChatUndoTabs_(session, entry.sheet.copyId, null);
    } catch (ignored) {
      /* The restored cells no longer match the entry, so it cannot be applied twice. */
    }
    dmvChatSeeNewTabs_(session);
    // Undoing duplicate_sheet deletes the tab, so there is nothing to link to.
    var url = dmvChatSheetById_(session, sheetId)
      ? dmvSheetUrl_(session.spreadsheet, sheetId, entry.range || 'A1')
      : null;
    session.events.push({
      kind: 'write',
      links: url ? [{ label: sheetName, url: url }] : [],
      text: 'Undid: ' + entry.text,
      details: dmvChatDetails_([
        ['Action', 'undo ' + entry.action],
        ['Range', entry.range],
      ]),
    });
    return {
      ok: true,
      undone: entry.id,
      action: entry.action,
      sheetName: sheetName,
      range: entry.range || null,
      url: url,
      note: entry.sheet
        ? 'The tab is back. Formulas elsewhere that pointed at it still show #REF! and need fixing by hand.'
        : undefined,
    };
  });
}

/* Confirmation */

// Bound to the spreadsheet, the tool and its exact input; edit and confirm tokens are left out,
// because a fresh inspection may be needed after the user answers.
function dmvChatConfirmDigest_(session, tool, input) {
  var copy = {};
  Object.keys(input || {}).forEach(function (key) {
    if (key !== 'editToken' && key !== 'confirmToken') copy[key] = input[key];
  });
  return dmvOutputDigest_(dmvCanonical_([session.spreadsheetId, tool, copy]));
}

// What a yes approves: the summary the user was shown and the cells the change would replace
// (undo snapshot cells, [{ grid, rows }]). The same input over changed cells is another change.
function dmvChatConfirmScope_(summary, cells) {
  return dmvOutputDigest_(dmvCanonical_([summary, cells || []]));
}

function dmvChatConfirmKey_(spreadsheetId) {
  return 'dmv:chat-confirm:' + dmvOutputDigest_(spreadsheetId).slice(0, 32);
}

function dmvChatConfirmState_(session) {
  if (!session.confirm)
    session.confirm = {
      turn: 't' + dmvOutputDigest_(Utilities.getUuid() + ':' + Date.now()).slice(0, 16),
      approved: [],
    };
  return session.confirm;
}

// A typed answer that is plainly a yes: it starts with one and has no question mark and no word
// of doubt, so "ok wait, no", "Sure? what will it delete" and "yes but don't" approve nothing.
function dmvChatConfirmYes_(text) {
  var answer = String(text || '').trim();
  return (
    answer.length <= 80 &&
    /^(?:yes|y|yeah|yep|sure|ok|okay|confirm|confirmed|go ahead|proceed|do it)\b/i.test(answer) &&
    answer.indexOf('?') < 0 &&
    !/\b(?:no|nope|not|never|wait|hold|stop|cancel|but|instead|undo|dont|cant|wont)\b|n['\u2019]t\b/i.test(
      answer
    )
  );
}

// At the start of a new chat request (not a continuation). Confirmations offered by the previous
// request apply to this answer only: a yes, typed or sent as the offered token by the sidebar,
// approves them for this request; any other answer drops them. The model alone can never
// approve, because tokens issued in this request wait for the next one.
function dmvChatConfirmBegin_(session, text, confirmToken) {
  var state = dmvChatConfirmState_(session);
  try {
    var cache = CacheService.getUserCache(),
      key = dmvChatConfirmKey_(session.spreadsheetId);
    var offer = JSON.parse(cache.get(key) || 'null');
    if (!offer) return;
    cache.remove(key);
    var yes = dmvChatConfirmYes_(text);
    state.approved = (Array.isArray(offer.items) ? offer.items : []).filter(function (item) {
      return (
        Date.now() - item.at <= DMV_SHEET_UNDO.confirmTtlSeconds * 1000 &&
        (typeof confirmToken === 'string' ? item.token === confirmToken : yes)
      );
    });
  } catch (ignored) {
    /* Without the offer nothing is approved; the model asks again. */
  }
}

// The approval for this exact call, or null when it still needs the user's yes. A token that is
// malformed, not approved in this request, already used or for other input is refused. scope is
// dmvChatConfirmScope_ of the change as planned now; when the cells changed after the question,
// the approval is dropped and the call asks again.
function dmvChatConfirmFind_(session, tool, input, scope) {
  var state = dmvChatConfirmState_(session),
    digest = dmvChatConfirmDigest_(session, tool, input),
    token = input && input.confirmToken,
    approval;
  if (token === undefined)
    approval =
      state.approved.filter(function (item) {
        return item.tool === tool && item.digest === digest;
      })[0] || null;
  else {
    if (typeof token !== 'string' || !/^c[a-f0-9]{32}$/.test(token))
      throw new Error('Pass the confirmToken exactly as it was returned.');
    approval = state.approved.filter(function (item) {
      return item.token === token;
    })[0];
    if (!approval)
      throw new Error(
        'This confirmation was not approved by the user in this request, was already used or has expired. Call again without confirmToken and ask the user.'
      );
    if (approval.tool !== tool || approval.digest !== digest)
      throw new Error(
        'This confirmation was given for a different change. Call again without confirmToken and ask the user about this one.'
      );
  }
  if (approval && approval.scope !== scope) {
    dmvChatConfirmSpend_(session, approval);
    state.rescoped = digest;
    return null;
  }
  return approval;
}

// The answer to return instead of acting; the token waits for the user's answer in the next
// request. scope is dmvChatConfirmScope_ of the change the summary describes.
function dmvChatConfirmIssue_(session, tool, input, summary, scope) {
  var state = dmvChatConfirmState_(session),
    token = 'c' + dmvOutputDigest_(Utilities.getUuid() + ':' + Date.now()).slice(0, 32),
    cache = CacheService.getUserCache(),
    key = dmvChatConfirmKey_(session.spreadsheetId),
    offer = null;
  try {
    offer = JSON.parse(cache.get(key) || 'null');
  } catch (ignored) {
    offer = null;
  }
  if (!offer || offer.turn !== state.turn || !Array.isArray(offer.items))
    offer = { turn: state.turn, items: [] };
  var digest = dmvChatConfirmDigest_(session, tool, input);
  offer.items = offer.items
    .filter(function (item) {
      return item.digest !== digest;
    })
    .concat([
      {
        token: token,
        tool: tool,
        digest: digest,
        scope: scope,
        summary: summary.slice(0, 600),
        at: Date.now(),
      },
    ])
    .slice(-10);
  try {
    cache.put(key, JSON.stringify(offer), DMV_SHEET_UNDO.confirmTtlSeconds);
  } catch (error) {
    throw new Error(
      'This change needs the user to confirm it, but chat could not save the question. Try again.'
    );
  }
  // The sidebar shows this text as what Yes approves. Summaries are built here from bounded parts
  // and stay well under the cap, so the scope at their end is never cut off.
  session.events.push({
    kind: 'summary',
    text: 'Asked to confirm: ' + summary.slice(0, 600),
    ref: 'confirmToken ' + token,
  });
  return {
    needsConfirmation: true,
    confirmToken: token,
    summary: summary,
    next:
      (state.rescoped === digest
        ? 'The cells changed after the user said yes, so that yes does not cover this change. '
        : '') +
      'Nothing changed yet. Ask the user with ask_user, options Yes and No. If they answer yes, repeat this exact call with this confirmToken.',
  };
}

function dmvChatConfirmSpend_(session, approval) {
  if (!approval) return;
  var state = dmvChatConfirmState_(session);
  state.approved = state.approved.filter(function (item) {
    return item !== approval && item.token !== approval.token;
  });
}

/* Analyst tools */

// The analyst actions of dmv_chat_sheet_actions.js extend edit_sheet: dmvChatEditSheet_ runs one
// through dmvChatSheetRunAction_ when it is not a built-in action, and dmvChatSheetTools_ adds
// their names and properties to the schema without replacing built-in ones. The tools below
// follow the built-in sheet tools, first name wins.
function dmvChatSheetExtraTools_() {
  var seen = Object.create(null);
  return []
    .concat(dmvChatSheetConditionTools_(), dmvChatSheetFormulaTools_())
    .filter(function (tool) {
      if (!tool || !tool.name || seen[tool.name]) return false;
      seen[tool.name] = true;
      return true;
    });
}

// The progress label an extra tool declares, or '' when it has none.
function dmvChatSheetToolLabel_(name) {
  try {
    var tool = dmvChatSheetExtraTools_().filter(function (item) {
      return item.name === name;
    })[0];
    return (tool && tool.label) || '';
  } catch (ignored) {
    return '';
  }
}

/* The pipeline for extra edit_sheet actions */

// Runs one registered action with the same guarantees as the built-in ones: the inspected range
// and its token, the protected-output guard, confirmation, an undo entry, one atomic batch, the
// write event and a result with output links. See dmv_chat_sheet_actions.js for the spec.
function dmvChatSheetRunAction_(session, input, spec) {
  var target = spec.target || 'range';
  dmvChatSheetObject_(
    input,
    (target === 'none'
      ? ['action']
      : target === 'sheet'
        ? ['action', 'sheetName']
        : ['action', 'sheetName', 'range', 'editToken']
    ).concat(['confirmToken'], spec.fields || [])
  );
  if (JSON.stringify(input).length > 250000)
    throw new Error('The sheet edit is too large. Use a smaller range.');
  return dmvWorkbookLocked_(function () {
    dmvChatSheetDeadline_(session);
    var context = { session: session, input: input, sheet: null, area: null, snapshot: null },
      tokenKey = null;
    if (target === 'range') {
      var inspected = dmvChatSheetInspected_(session, input);
      context.sheet = inspected.sheet;
      context.area = inspected.area;
      context.snapshot = inspected.snapshot;
      tokenKey = inspected.tokenKey;
    } else if (target === 'sheet') context.sheet = dmvChatSheetTarget_(session, input.sheetName);
    var plan = spec.plan(context) || {};
    if (!Array.isArray(plan.requests) || !plan.requests.length)
      throw new Error('This sheet action has nothing to change.');
    var touches = plan.touches || (context.area ? [context.area.grid] : []);
    dmvChatSheetGuard_(session, touches.concat(plan.guard || []));
    var undoSpec =
      plan.undo === undefined ? (touches.length ? { snapshot: touches } : null) : plan.undo;
    var known = context.area ? [{ grid: context.area.grid, cells: context.snapshot.cells }] : [];
    var prepared = undoSpec ? dmvChatUndoPrepare_(session, undoSpec, known) : null;
    var reasons = [];
    if (plan.confirm) reasons.push(plan.confirm);
    if (plan.overwrite && prepared && prepared.cells) {
      var replaced = 0;
      prepared.cells.forEach(function (item) {
        replaced += dmvChatSheetNonEmpty_(item.rows);
      });
      if (replaced > DMV_SHEET_UNDO.overwriteCells)
        reasons.push('This replaces ' + replaced + ' non-empty cells.');
    }
    if (prepared && prepared.unavailable) reasons.push(prepared.unavailable);
    var approval = null;
    if (reasons.length) {
      var summary = reasons.join(' '),
        scope = dmvChatConfirmScope_(summary, prepared && prepared.cells);
      approval = dmvChatConfirmFind_(session, 'edit_sheet', input, scope);
      if (!approval) return dmvChatConfirmIssue_(session, 'edit_sheet', input, summary, scope);
    }
    var cleanup = dmvChatUndoCleanup_(session);
    // A hidden copy is registered before it exists, so it is removed in time even when its undo
    // entry cannot be saved; a copy the batch never made is simply forgotten.
    if (prepared && prepared.sheet)
      dmvChatUndoTabs_(
        session,
        prepared.sheet.copyId,
        Date.now() + DMV_SHEET_UNDO.ttlSeconds * 1000
      );
    dmvChatSheetDeadline_(session);
    var response = Sheets.Spreadsheets.batchUpdate(
      { requests: plan.requests.concat(cleanup) },
      session.spreadsheetId
    );
    if (tokenKey) {
      try {
        CacheService.getUserCache().remove(tokenKey);
      } catch (ignored) {
        /* The changed fingerprint still prevents replay. */
      }
    }
    dmvChatConfirmSpend_(session, approval);
    try {
      dmvChatUndoCleaned_(session, cleanup);
    } catch (ignored) {
      /* A copy left in the registry is cleaned up by a later edit. */
    }
    var sheetName = plan.sheetName || (context.sheet ? context.sheet.getName() : input.sheetName);
    var range = plan.range || (context.area ? context.area.a1 : '');
    var undoId = dmvChatUndoCommit_(
      session,
      prepared,
      {
        action: input.action,
        sheetId:
          plan.sheetId !== undefined
            ? plan.sheetId
            : context.sheet
              ? context.sheet.getSheetId()
              : undefined,
        sheetName: sheetName,
        range: range,
        text: plan.text || input.action + ' ' + sheetName + (range ? '!' + range : ''),
      },
      []
    );
    var extra = {};
    try {
      extra = (plan.after && plan.after(response, context)) || {};
    } catch (ignored) {
      /* The edit is already in the sheet; a failed follow-up read never reports it as failed. */
    }
    dmvChatSeeNewTabs_(session);
    var linkId =
      plan.sheetId !== undefined ? plan.sheetId : context.sheet && context.sheet.getSheetId();
    // No link to a tab the action deleted.
    var url =
      Number.isInteger(linkId) && dmvChatSheetById_(session, linkId)
        ? dmvSheetUrl_(session.spreadsheet, linkId, range || 'A1')
        : dmvSheetLink_(session.spreadsheet, { sheetName: sheetName }, range || 'A1');
    session.events.push({
      kind: 'write',
      links: url ? [{ label: sheetName, url: url }] : [],
      text: plan.text || 'Updated ' + sheetName + (range ? '!' + range : ''),
      details: dmvChatDetails_(
        [
          ['Action', input.action],
          ['Range', range],
        ].concat(plan.details || [])
      ),
    });
    return Object.assign(
      {
        ok: true,
        action: input.action,
        sheetName: sheetName,
        url: url,
        range: range || null,
        undoId: undoId,
      },
      plan.result || {},
      extra
    );
  });
}
