/* Safety around chat sheet edits: DataMoov output stays protected, cell-changing edits can be
   undone, destructive or wide edits wait for the user's yes, and dmvChatSheetRunAction_ gives
   every edit_sheet action (dmv_chat_sheets.js, dmv_chat_sheet_actions.js), analyst pivots and
   conditional formats those guarantees in one pipeline. */
var DMV_SHEET_UNDO = {
  // CacheService keeps a value for at most six hours.
  ttlSeconds: 21600,
  maxEntries: 10,
  maxChars: 900000,
  maxCells: 50000,
  // On tabs this request made, snapshots over this many cells (an inspection's) are not kept.
  madeCells: 1000,
  // A cache value holds at most 100 KB, so the undo list and the offer of pending confirmations,
  // at up to three bytes a character, drop their oldest entries or calls while longer than this
  // many characters (dmvChatUndoDrop_ keeps those of the current request). Each undo entry's
  // cells and checks are kept under keys of its own (dmvChatCachePut_).
  listChars: 30000,
  // Replacing more non-empty cells than this asks the user first.
  overwriteCells: 200,
  confirmTtlSeconds: 1800,
  // Row, column, move and tab edits keep no undo: they ask first, saying this.
  noUndo: 'Chat cannot undo this; File > Version history can restore it.',
  // The cell fields an inspection and an undo snapshot read, and the ones undo writes back.
  readFields:
    'userEnteredValue,effectiveValue,userEnteredFormat,dataValidation,note,textFormatRuns,chipRuns',
  restoreFields: 'userEnteredValue,userEnteredFormat,note,dataValidation,textFormatRuns,chipRuns',
};

/* Protected output */

// Report and dashboard output areas of this spreadsheet: this user's from the receipts the
// writer keeps, every collaborator's from the records it leaves in the spreadsheet
// (dmvOutputRecords_), which carry no names. A dashboard's page and chart data tabs are
// protected whole, since each refresh lays them out again. Chat tables (chat-… receipts) are not
// refreshed: a changed one only stops a later write_to_sheet at the same cell, which the writer
// already refuses.
function dmvChatOwnedAreas_(session) {
  var all = dmvStore_().getProperties(),
    prefix = dmvOutputKey_(session.spreadsheetId, ''),
    mine = Object.create(null),
    areas = [];
  function add(sheetId, area, owner) {
    var whole = owner.kind === 'dashboard' && owner.page;
    areas.push({
      sheetId: sheetId,
      row: whole ? 1 : area.row,
      column: whole ? 1 : area.column,
      rows: whole ? Infinity : area.rows,
      columns: whole ? Infinity : area.columns,
      owner: owner,
    });
  }
  Object.keys(all).forEach(function (key) {
    var id = key.slice(prefix.length);
    if (key.indexOf(prefix) !== 0 || id.indexOf('chat-') === 0) return;
    mine[id] = true;
    var area;
    try {
      area = JSON.parse(all[key]);
    } catch (ignored) {
      return;
    }
    if (!area || !Number.isInteger(area.sheetId)) return;
    add(area.sheetId, area, dmvOutputOwner_(all, id));
  });
  dmvOutputRecords_(session.spreadsheetId).forEach(function (found) {
    var record = found.record;
    if (mine[record.id]) return;
    add(found.sheetId, record, {
      kind: record.kind,
      name: '',
      page: record.page === true,
      collaborator: true,
    });
  });
  return areas;
}

// Who owns protected output, as error text names them.
function dmvChatOwnerText_(owner) {
  if (owner.collaborator) return 'a DataMoov ' + owner.kind + ' another collaborator saved';
  if (owner.kind === 'report') return 'the saved report "' + owner.name + '"';
  if (owner.kind === 'dashboard') return 'the dashboard "' + owner.name + '"';
  return 'a DataMoov report or dashboard';
}

// Refuses when a GridRange overlaps protected output. A missing end index means the rest of the
// tab, so { sheetId } is the whole tab and { sheetId, startRowIndex: 4 } every row from row 5
// (what inserting or deleting there would move).
function dmvChatSheetGuard_(session, ranges) {
  if (!ranges || !ranges.length) return;
  var owned = dmvChatOwnedAreas_(session);
  if (!owned.length) return;
  ranges.forEach(function (grid) {
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
      var kind = item.owner.kind === 'dashboard' ? 'dashboard' : 'report';
      throw new Error(
        'This change would touch the output of ' +
          dmvChatOwnerText_(item.owner) +
          (tab ? ' on tab "' + tab.getName() + '"' : '') +
          '. DataMoov rewrites that output on every refresh, so ' +
          (item.owner.collaborator ? 'ask them to change the ' : 'change the ') +
          kind +
          ' instead, or work on a copy of the data elsewhere.'
      );
    });
  });
}

// The saved report or dashboard whose output a tab holds or that writes to it, or null:
// { kind: 'report'|'dashboard', collaborator }. Output is found by its tab, any collaborator's
// included; this user's own destinations by name, which Sheets matches without regard to case.
function dmvChatTabUser_(session, sheet) {
  var id = sheet.getSheetId(),
    name = sheet.getName().toLowerCase();
  var owned = dmvChatOwnedAreas_(session).filter(function (area) {
    return area.sheetId === id;
  })[0];
  if (owned)
    return {
      kind: owned.owner.kind === 'dashboard' ? 'dashboard' : 'report',
      collaborator: !!owned.owner.collaborator,
    };
  function named(target) {
    return !!target && String(target.sheetName).toLowerCase() === name;
  }
  if (
    dmvList_('dashboard').some(function (dashboard) {
      return (
        dashboard.spreadsheetId === session.spreadsheetId &&
        [dashboard.target, dashboard.dataTarget]
          .concat(dashboard.outputs || [])
          .concat(dashboard.plan ? [{ sheetName: dmvDashboardChartTab_(dashboard.target) }] : [])
          .some(named)
      );
    })
  )
    return { kind: 'dashboard', collaborator: false };
  if (
    dmvList_('report').some(function (report) {
      return report.spreadsheetId === session.spreadsheetId && named(report.target);
    })
  )
    return { kind: 'report', collaborator: false };
  return null;
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

// Reads bounded GridRanges in row bands packed into requests of at most requestCells cells, so no
// single answer is too large for the memory of an execution, and calls visit(index, row, column,
// cell) for each cell read, with index the grid's position in grids and 0-based tab positions.
// fields names the cell fields to read. A visit that returns false ends the read: no later cell
// is visited and no later band requested.
function dmvChatSheetBands_(session, grids, fields, visit) {
  var limit = DMV_SHEET_SEARCH.requestCells,
    requests = [],
    size = limit,
    count = 0,
    stopped = false;
  grids.forEach(function (grid, index) {
    var sheet = dmvChatSheetById_(session, grid.sheetId);
    if (!sheet) throw new Error('A tab this change needs no longer exists. Use list_sheets.');
    var band = Math.max(
      1,
      Math.floor(limit / (grid.endColumnIndex - (grid.startColumnIndex || 0)))
    );
    for (var top = grid.startRowIndex || 0; top < grid.endRowIndex; top += band) {
      var part = Object.assign({}, grid, {
        startRowIndex: top,
        endRowIndex: Math.min(top + band, grid.endRowIndex),
      });
      if (size + dmvChatGridCells_(part) > limit) {
        requests.push([]);
        size = 0;
      }
      size += dmvChatGridCells_(part);
      requests[requests.length - 1].push({
        index: index,
        part: part,
        range: dmvChatActionTab_(sheet.getName()) + dmvChatGridA1_(part),
      });
    }
  });
  requests.forEach(function (parts) {
    if (stopped) return;
    dmvChatSheetDeadline_(session);
    var result = Sheets.Spreadsheets.get(session.spreadsheetId, {
      ranges: parts.map(function (item) {
        return item.range;
      }),
      includeGridData: true,
      fields:
        'sheets(properties(sheetId),data(startRow,startColumn,rowData(values(' + fields + '))))',
    });
    // The API answers one data block per requested range, per tab, in request order.
    var used = Object.create(null);
    parts.forEach(function (item) {
      var part = item.part;
      var read = ((result && result.sheets) || []).filter(function (entry) {
        return entry.properties && entry.properties.sheetId === part.sheetId;
      })[0];
      var position = (used[part.sheetId] = (used[part.sheetId] || 0) + 1) - 1;
      var block = read && (read.data || [])[position];
      ((block && block.rowData) || []).forEach(function (line, r) {
        (line.values || []).forEach(function (cell, c) {
          if (stopped) return;
          if (++count % 5000 === 0) dmvChatSheetDeadline_(session);
          var row = (block.startRow || 0) + r,
            column = (block.startColumn || 0) + c;
          if (
            row >= part.startRowIndex &&
            row < part.endRowIndex &&
            column >= (part.startColumnIndex || 0) &&
            column < part.endColumnIndex &&
            visit(item.index, row, column, cell) === false
          )
            stopped = true;
        });
      });
    });
  });
}

// The cells of bounded GridRanges, as [{ grid, cells }] in the order given; cells is a full rows x
// columns matrix with {} for empty cells. values names other cell fields to read instead of the
// ones undo needs. Read in bands (dmvChatSheetBands_).
function dmvChatSheetCells_(session, grids, values) {
  var found = grids.map(function (grid) {
    return {
      grid: grid,
      cells: Array.from({ length: grid.endRowIndex - (grid.startRowIndex || 0) }, function () {
        return Array.from(
          { length: grid.endColumnIndex - (grid.startColumnIndex || 0) },
          function () {
            return {};
          }
        );
      }),
    };
  });
  dmvChatSheetBands_(
    session,
    grids,
    values || DMV_SHEET_UNDO.readFields,
    function (index, row, column, cell) {
      var grid = grids[index];
      found[index].cells[row - (grid.startRowIndex || 0)][column - (grid.startColumnIndex || 0)] =
        cell;
    }
  );
  return found;
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
// rest (dmvChatSheetCells_).
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
// validation, rich-text runs and the smart chips Sheets lets it write back. Effective values are
// left out, so volatile formulas such as TODAY() never make a cell look changed.
function dmvChatUndoCell_(cell) {
  var kept = {};
  ['userEnteredValue', 'userEnteredFormat', 'note', 'dataValidation', 'textFormatRuns'].forEach(
    function (key) {
      if (cell && cell[key] !== undefined && cell[key] !== null) kept[key] = cell[key];
    }
  );
  // An error is a result, never something to type back in.
  if (kept.userEnteredValue && kept.userEnteredValue.errorValue) delete kept.userEnteredValue;
  var chips = dmvChatUndoChips_(cell).written;
  if (chips.length) kept.chipRuns = chips;
  return kept;
}

// A cell's smart chips as { written, lost }: the runs undo writes back, and how many it cannot.
// Reads also list the text between chips as runs with an empty chip, which are not written; of
// rich links, Sheets writes only Drive files as chips, so links to YouTube, Maps or Calendar
// come back as their @ placeholder.
function dmvChatUndoChips_(cell) {
  var chips = { written: [], lost: 0 };
  ((cell && cell.chipRuns) || []).forEach(function (run) {
    var chip = (run && run.chip) || {};
    var link = chip.richLinkProperties;
    if (
      chip.personProperties ||
      (link && /^https:\/\/(?:docs|drive)\.google\.com\//.test(link.uri))
    )
      chips.written.push(run);
    else if (link) chips.lost++;
  });
  return chips;
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

// Cells that hold or show a value. Cells an array formula spills into, or a pivot table fills,
// have only an effective value, so pass cells as read, not as kept for undo.
function dmvChatSheetNonEmpty_(cells) {
  var count = 0;
  cells.forEach(function (row) {
    row.forEach(function (cell) {
      if (
        (cell.userEnteredValue && Object.keys(cell.userEnteredValue).length) ||
        (cell.effectiveValue && Object.keys(cell.effectiveValue).length)
      )
        count++;
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

// Saves keep (newest first) as the undo list, without its oldest entries while it is longer than
// listChars, and removes the data of every entry of entries left out. The newest entry and those
// of this request (session.undoIds), whose ids it already returned, are never dropped, so a
// request with many edits can keep a longer list; should that list not fit a cache value, the
// put throws and nothing is dropped.
function dmvChatUndoDrop_(session, entries, keep) {
  var cache = CacheService.getUserCache(),
    current = session.undoIds || [];
  keep = keep.slice();
  while (JSON.stringify(keep).length > DMV_SHEET_UNDO.listChars) {
    var oldest = keep.length - 1;
    while (oldest > 0 && current.indexOf(keep[oldest].id) >= 0) oldest--;
    if (oldest < 1) break;
    keep.splice(oldest, 1);
  }
  cache.put(
    dmvChatUndoKey_(session.spreadsheetId),
    JSON.stringify(keep),
    DMV_SHEET_UNDO.ttlSeconds
  );
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
  });
}

// Before a batch: what undo needs, from an undo spec (see dmvChatSheetRunAction_). known lists
// cells already read ([{ grid, cells }]); the rest of spec.snapshot is read here. The result has
// unavailable set to the reason when the edit cannot be undone here (with none for an edit that
// never can, which undo answers with that reason), and filled to the snapshot cells that hold or
// show a value (dmvChatSheetNonEmpty_). An edit that never can be undone still reads its
// snapshot cells, so a yes covers them only as they were when chat asked (dmvChatConfirmScope_).
// A spec of only a hint (a new or renamed tab, a chart) is never undone and asks nothing.
function dmvChatUndoPrepare_(session, spec, known) {
  if (spec.hint) return { none: true, hint: spec.hint };
  if (!spec.none && !(spec.snapshot || []).length && !(spec.reverse || []).length) return null;
  var snapshot = spec.snapshot || [],
    total = 0;
  snapshot.forEach(function (grid) {
    total += dmvChatGridCells_(grid);
  });
  if (total > DMV_SHEET_UNDO.maxCells)
    return spec.none
      ? { unavailable: spec.none, none: true }
      : dmvChatUndoTooLarge_(session, snapshot);
  // Deleting a tab this request made undoes every edit there, so a larger snapshot of such tabs
  // is not read and kept: undo says to delete them.
  if (!spec.none && total > DMV_SHEET_UNDO.madeCells) {
    var made = dmvChatUndoTooLarge_(session, snapshot);
    if (made.none) return made;
  }
  var filled = 0,
    chipless = 0;
  var cells = dmvChatGridsRead_(session, snapshot, known).map(function (found) {
    filled += dmvChatSheetNonEmpty_(found.cells);
    return {
      grid: found.grid,
      rows: found.cells.map(function (row) {
        return row.map(function (cell) {
          if (dmvChatUndoChips_(cell).lost) chipless++;
          return dmvChatUndoCell_(cell);
        });
      }),
    };
  });
  if (spec.none) return { unavailable: spec.none, none: true, cells: cells, filled: filled };
  var notes = [spec.note].concat(
    chipless
      ? [
          chipless +
            (chipless === 1 ? ' cell' : ' cells') +
            ' held smart chips that Sheets does not let chat write back (links to YouTube, Maps or Calendar); they came back as @ text.',
        ]
      : []
  );
  // The entry's data, kept beside the list, also holds a fingerprint for each verify range.
  var verify = spec.verify || snapshot,
    size = dmvPack_({
      cells: cells,
      reverse: spec.reverse || [],
      restore: spec.restore || null,
    }).length;
  verify.forEach(function (grid) {
    size += JSON.stringify(grid).length + 100;
  });
  if (size > DMV_SHEET_UNDO.maxChars) return dmvChatUndoTooLarge_(session, snapshot);
  return {
    cells: cells,
    reverse: spec.reverse || [],
    filled: filled,
    verify: verify,
    rules: spec.rules,
    named: spec.named,
    restore: spec.restore || null,
    note: notes.filter(Boolean).join(' '),
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

// After a successful batch: stores the undo entry and returns its id, or null when it could not
// be kept. after lists cells already read back ([{ grid, cells }]); other verify ranges are read
// here. An edit that never can be undone (prepared.none) is listed without data and returns null,
// so undo answers with its reason instead of undoing an older edit. Never fails the edit, which
// is already in the sheet.
function dmvChatUndoCommit_(session, prepared, details, after) {
  if (!prepared || (prepared.unavailable && !prepared.none)) return null;
  try {
    var id = dmvChatNewId_('u', 12);
    var entry = {
      id: id,
      at: Date.now(),
      action: details.action,
      sheetId: details.sheetId,
      sheetName: details.sheetName,
      range: details.range || '',
      text: String(details.text || '').slice(0, 200),
    };
    if (prepared.none) {
      entry.none = true;
      if (prepared.hint) entry.hint = prepared.hint;
    } else {
      var read = dmvChatGridsRead_(session, prepared.verify || [], after);
      var sheetIds = [];
      read
        .concat(prepared.cells || [])
        .map(function (item) {
          return item.grid.sheetId;
        })
        .forEach(function (sheetId) {
          if (sheetIds.indexOf(sheetId) < 0) sheetIds.push(sheetId);
        });
      entry.dims = dmvChatUndoDims_(session, sheetIds);
      if (prepared.named) entry.named = prepared.named;
      if (prepared.rules !== undefined) {
        var rules = dmvChatUndoRules_(session, prepared.rules);
        if (!rules) return null;
        entry.rules = { sheetId: prepared.rules, fingerprint: rules.fingerprint };
      }
      dmvChatCachePut_(
        dmvChatUndoKey_(session.spreadsheetId) + ':' + id,
        dmvPack_({
          cells: prepared.cells,
          reverse: prepared.reverse,
          restore: prepared.restore,
          note: prepared.note,
          verify: read.map(function (found) {
            return { grid: found.grid, fingerprint: dmvChatUndoFingerprint_(found.cells) };
          }),
        }),
        DMV_SHEET_UNDO.ttlSeconds
      );
    }
    var entries = [entry].concat(dmvChatUndoEntries_(session));
    // The newest entries are kept, and every entry of this request (session.undoIds), so each
    // undoId it returned stays usable however many edits it makes.
    session.undoIds = (session.undoIds || []).concat([id]);
    dmvChatUndoDrop_(
      session,
      entries,
      entries.filter(function (item, index) {
        return index < DMV_SHEET_UNDO.maxEntries || session.undoIds.indexOf(item.id) >= 0;
      })
    );
    return entry.none ? null : id;
  } catch (ignored) {
    return null;
  }
}

// Lists an edit chat neither undoes nor asks about, so undo answers with hint (how to reverse it)
// instead of undoing the chat edit before it. details as for dmvChatUndoCommit_.
function dmvChatUndoNone_(session, details, hint) {
  dmvChatUndoCommit_(session, { none: true, hint: hint }, details, []);
}

function dmvChatUndoNewTab_(name) {
  return 'Delete the tab "' + name + '" to remove it.';
}

// Records a tab this request made (create_sheet, create_pivot, duplicate_sheet) in
// session.newTabs, which the turn state carries to the next execution. Nothing on such a tab is
// older than the request, so deleting it undoes every edit there.
function dmvChatSheetMade_(session, sheetId) {
  session.newTabs = session.newTabs || [];
  if (session.newTabs.indexOf(sheetId) < 0) session.newTabs.push(sheetId);
}

// Whether this request made the tab (dmvChatSheetMade_): edits there need no inspection, and row
// and tab changes ask nothing, since undo answers them by deleting the tab.
function dmvChatSheetIsMade_(session, sheet) {
  return !!sheet && (session.newTabs || []).indexOf(sheet.getSheetId()) >= 0;
}

// What undo keeps of a snapshot too large to keep. All on tabs this request made: an entry undo
// answers by naming the tabs to delete, so the edit asks nothing. Otherwise unavailable.
function dmvChatUndoTooLarge_(session, snapshot) {
  var made = session.newTabs || [],
    names = [];
  var all = snapshot.every(function (grid) {
    var tab = made.indexOf(grid.sheetId) >= 0 && dmvChatSheetById_(session, grid.sheetId);
    if (tab && names.indexOf(tab.getName()) < 0) names.push(tab.getName());
    return !!tab;
  });
  return all && names.length
    ? { none: true, hint: names.map(dmvChatUndoNewTab_).join(' ') }
    : { unavailable: 'It is too large to undo here; Sheets version history can restore it.' };
}

// A tab's conditional format rules as { sheetId, list, fingerprint }, or null when the tab is
// gone. A reverse that names a rule by its position, or a restore that replaces them all, is
// right only while the rules are as the edit left them.
function dmvChatUndoRules_(session, sheetId) {
  var sheet = dmvChatSheetById_(session, sheetId);
  if (!sheet) return null;
  var list = dmvChatSheetRules_(session, sheet);
  return { sheetId: sheetId, list: list, fingerprint: dmvOutputDigest_(dmvCanonical_(list)) };
}

// The requests that put back a kept restore, after the reverse: the saved conditional format
// rules replace those the tab holds now (rules, from dmvChatUndoRules_).
function dmvChatUndoRestore_(restore, rules) {
  var requests = [];
  rules.list.forEach(function () {
    requests.push({ deleteConditionalFormatRule: { sheetId: rules.sheetId, index: 0 } });
  });
  restore.rules.forEach(function (rule, index) {
    requests.push({ addConditionalFormatRule: { rule: rule, index: index } });
  });
  return requests;
}

// The names of the spreadsheet's tabs, as chat and the report form offer them.
function dmvChatTabNames_(spreadsheet) {
  return spreadsheet.getSheets().map(function (sheet) {
    return sheet.getName();
  });
}

// Refuses an undo whose cells or named range are no longer where the edit left them: rows or
// columns of its tabs were inserted or deleted since, or the named range was changed since.
function dmvChatUndoPlaced_(session, entry) {
  var dims = entry.dims || [];
  var now = dmvChatUndoDims_(
    session,
    dims.map(function (item) {
      return item.sheetId;
    })
  );
  dims.forEach(function (item) {
    var found = now.filter(function (current) {
      return current.sheetId === item.sheetId;
    })[0];
    var tab = dmvChatSheetById_(session, item.sheetId);
    if (found && (found.rows !== item.rows || found.columns !== item.columns))
      throw new Error(
        'Rows or columns of ' +
          (tab ? '"' + tab.getName() + '"' : 'its tab') +
          ' were inserted or deleted since that edit, so its cells are no longer where they were and it cannot be undone here. Sheets version history can restore it.'
      );
  });
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
          undoable: entry.none ? false : undefined,
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
    if (entry.none)
      throw new Error(
        'Chat cannot undo "' +
          entry.text +
          '". ' +
          (entry.hint || 'File > Version history can restore it.')
      );
    var text = dmvChatCacheGet_(dmvChatUndoKey_(session.spreadsheetId) + ':' + entry.id);
    var data = text ? dmvUnpack_(text) : null;
    // Data kept without its verify fingerprints cannot be checked, so it is not applied.
    if (!data || !data.verify)
      throw new Error(
        'That edit can no longer be undone here. Sheets version history can restore it.'
      );
    var requests = (data.reverse || []).slice();
    var sheet = dmvChatSheetById_(session, entry.sheetId);
    if (!sheet)
      throw new Error(
        'The tab of that edit no longer exists, so it cannot be undone here. Sheets version history can restore it.'
      );
    dmvChatUndoPlaced_(session, entry);
    var current = dmvChatSheetCells_(
      session,
      data.verify.map(function (item) {
        return item.grid;
      })
    );
    data.verify.forEach(function (item, index) {
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
    var rules = entry.rules ? dmvChatUndoRules_(session, entry.rules.sheetId) : null;
    if (entry.rules && (!rules || rules.fingerprint !== entry.rules.fingerprint))
      throw new Error(
        'The conditional format rules of ' +
          sheet.getName() +
          ' changed since that edit, so it cannot be undone here. Undo later edits first, or use conditional_format list and delete.'
      );
    if (data.restore) requests = requests.concat(dmvChatUndoRestore_(data.restore, rules));
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
            : data.verify.map(function (item) {
                return item.grid;
              })
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
    if (!requests.length) throw new Error('That edit has nothing to undo.');
    var sheetId = sheet.getSheetId(),
      sheetName = sheet.getName();
    dmvChatSheetDeadline_(session);
    Sheets.Spreadsheets.batchUpdate({ requests: requests }, session.spreadsheetId);
    try {
      dmvChatUndoDrop_(
        session,
        entries,
        entries.filter(function (item) {
          return item.id !== entry.id;
        })
      );
    } catch (ignored) {
      /* The restored cells no longer match the entry, so it cannot be applied twice. */
    }
    var url = dmvSheetUrl_(session.spreadsheet, sheetId, entry.range || 'A1');
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
      // What undo could not put back.
      note: data.note || undefined,
    };
  });
}

/* Confirmation */

// The input a yes is bound to. Edit and confirm tokens are left out, because a fresh inspection
// may be needed after the user answers. The model repeats the call in the next request from
// memory, so an edit_sheet default spelled out (as dmv_chat_sheets.js and
// dmv_chat_sheet_actions.js apply them) or key columns in another order are the same call.
function dmvChatConfirmInput_(tool, input) {
  var defaults =
      tool === 'edit_sheet'
        ? {
            headerRows: 1,
            pasteType: 'all',
            count: 1,
            replacement: '',
            keep: 'first',
            delimiter: 'auto',
            matchCase: false,
            matchEntireCell: false,
            useRegex: false,
            wholeSheet: false,
          }
        : {},
    copy = {};
  Object.keys(input || {}).forEach(function (key) {
    var value = input[key];
    if (key === 'editToken' || key === 'confirmToken') return;
    if (Object.prototype.hasOwnProperty.call(defaults, key) && value === defaults[key]) return;
    if (
      tool === 'edit_sheet' &&
      key === 'keyColumns' &&
      Array.isArray(value) &&
      value.every(function (column) {
        return typeof column === 'number';
      })
    )
      value = value
        .filter(function (column, index) {
          return value.indexOf(column) === index;
        })
        .sort(function (a, b) {
          return a - b;
        });
    copy[key] = value;
  });
  return dmvCanonical_(copy);
}

// Bound to the spreadsheet, the tool and its input (dmvChatConfirmInput_).
function dmvChatConfirmDigest_(session, tool, input) {
  return dmvOutputDigest_(
    dmvCanonical_([session.spreadsheetId, tool, dmvChatConfirmInput_(tool, input)])
  );
}

// What a yes approves: the summary the user was shown and the cells the change would replace
// (undo snapshot cells, [{ grid, rows }]). The same input over changed cells is another change.
function dmvChatConfirmScope_(summary, cells) {
  return dmvOutputDigest_(dmvCanonical_([summary, cells || []]));
}

// Offers are kept per spreadsheet and conversation, so another sidebar or a New chat neither
// drops nor approves them; a request without a conversation id uses the spreadsheet's own. kind
// names another value kept the same way between requests ('confirm' by default).
function dmvChatConfirmKey_(session, kind) {
  var conversation = dmvChatConfirmState_(session).conversation;
  return (
    'dmv:chat-' +
    (kind || 'confirm') +
    ':' +
    dmvOutputDigest_(session.spreadsheetId).slice(0, 32) +
    (conversation ? ':' + dmvOutputDigest_(conversation).slice(0, 32) : '')
  );
}

// Confirmation state of one chat request, kept across its continuations: its turn id, its
// conversation id ('' when the caller sent none), the approvals of the user's answer and the
// non-empty cells its edits replaced so far (replaced, dmvChatConfirmOverwrite_).
function dmvChatConfirmState_(session) {
  if (!session.confirm)
    session.confirm = {
      turn: dmvChatNewId_('t', 16),
      conversation: '',
      approved: [],
      replaced: 0,
    };
  return session.confirm;
}

// Why an edit that replaces this many non-empty cells must wait for the user's yes, as
// { text, scope }, or null when it need not. The limit counts every edit of the request, so an
// overwrite split into smaller calls still asks once together they pass it. where names the
// cells, when known. text adds the request's total; scope, what the yes is bound to, leaves it
// out, since the yes request counts from 0 again and must match the same edit.
function dmvChatConfirmOverwrite_(session, replaced, where) {
  var total = (dmvChatConfirmState_(session).replaced || 0) + replaced;
  if (!replaced || total <= DMV_SHEET_UNDO.overwriteCells) return null;
  var own =
    'This replaces ' +
    replaced +
    (replaced === 1 ? ' non-empty cell' : ' non-empty cells') +
    (where ? ' in ' + where : '') +
    '.';
  return {
    text:
      own +
      (total > replaced
        ? ' With the earlier edits of this request, ' + total + ' non-empty cells are replaced.'
        : ''),
    scope: own,
  };
}

// The start of an answer that reassures rather than refuses ("No problem", "no worries", "don't
// worry about it"), and the phrases that approve wherever they stand.
var DMV_CHAT_CONFIRM_REASSURE =
  "(?:no (?:problem|prob|worries|worry)|not a problem|(?:don't|do not) worry(?: about (?:it|that|this))?)";
var DMV_CHAT_CONFIRM_APPROVE = /(?:^|[^a-z'])(?:go ahead|go for it|do it|proceed)\b/i;

// The answer trimmed, with curly apostrophes made straight.
function dmvChatConfirmText_(text) {
  return String(text || '')
    .replace(/[\u2018\u2019]/g, "'")
    .trim();
}

// A typed answer that is plainly a yes and nothing else: a yes, optionally followed by please or
// go ahead and do it, or a reassurance followed by one ("No problem, go ahead", "don't worry about
// it, delete them"). "ok wait, no", "Sure? what will it delete" and a yes that goes on to a new
// request ("ok thanks, now chart revenue") approve nothing.
function dmvChatConfirmYes_(text) {
  var act =
      '(?:go ahead and )?(?:do|delete|remove|clear|replace|overwrite|apply|change) (?:it|them|that|those|this)',
    first = '(?:yes|y|yeah|yep|sure|ok|okay|confirm|confirmed|go ahead|proceed|do it)';
  return new RegExp(
    '^(?:' +
      DMV_CHAT_CONFIRM_REASSURE +
      '[\\s,.!]+(?:' +
      first +
      '|' +
      act +
      ')|' +
      first +
      ')(?:[\\s,]+(?:please|go ahead|proceed|do it|' +
      act +
      '))*[\\s.!]*$',
    'i'
  ).test(dmvChatConfirmText_(text));
}

// An answer that starts with a no word, standing alone or followed by punctuation or more words
// ("No", "no, keep it and rename it instead", "don't delete it"); plain is true when it says
// nothing else ("No", "no thanks", "cancel, leave it"). A reassurance ("No problem, go ahead") and
// any answer that also approves ("no, go ahead") are never a no; "don't go ahead" still is.
function dmvChatConfirmNo_(text, plain) {
  var no = "(?:no|n|nope|cancel|stop|don't|do not)",
    answer = dmvChatConfirmText_(text);
  if (new RegExp('^' + DMV_CHAT_CONFIRM_REASSURE + '\\b', 'i').test(answer)) return false;
  if (
    DMV_CHAT_CONFIRM_APPROVE.test(
      answer.replace(/\b(?:don't|do not|not|never)\s+(?:go ahead|go for it|do it|proceed)\b/gi, '')
    )
  )
    return false;
  return new RegExp(
    plain
      ? '^' +
          no +
          '(?:[\\s,]+(?:thanks|thank you|please|keep (?:it|them)|leave (?:it|them)(?: as (?:it is|they are))?|' +
          no +
          '))*[\\s.!]*$'
      : '^' + no + '(?=$|[\\s.,;:!?])',
    'i'
  ).test(answer);
}

// At the start of a new chat request (not a continuation). Confirmations offered by the previous
// request of this conversation apply to this answer only: a yes, typed or sent as the offered
// token by the sidebar, approves them for this request; any other answer drops them. The model
// alone can never approve, because tokens issued in this request wait for the next one. A plain
// no declines them and ends the request with an answer and no tool round (stop, dmvChatExecute_).
// A no that goes on ("no, only the second") approves nothing either, so a change it still asks
// for is asked again and needs a new yes.
function dmvChatConfirmBegin_(session, text, confirmToken, conversation) {
  var state = dmvChatConfirmState_(session);
  state.conversation = conversation || '';
  try {
    var cache = CacheService.getUserCache(),
      key = dmvChatConfirmKey_(session);
    var offer = JSON.parse(cache.get(key) || 'null');
    if (!offer) return;
    cache.remove(key);
    var yes = dmvChatConfirmYes_(text),
      items = Array.isArray(offer.items) ? offer.items : [];
    state.approved = items.filter(function (item) {
      return (
        Date.now() - item.at <= DMV_SHEET_UNDO.confirmTtlSeconds * 1000 &&
        (typeof confirmToken === 'string' ? item.token === confirmToken : yes)
      );
    });
    if (typeof confirmToken !== 'string' && items.length && dmvChatConfirmNo_(text, true)) {
      state.declined = items.map(function (item) {
        return { summary: item.summary };
      });
      state.stop = true;
    }
  } catch (ignored) {
    /* Without the offer nothing is approved; the model asks again. */
  }
}

// The changes the user declined, for the answer that ends the request (dmvChatFinalAnswer_). The
// summaries name tabs and cells, so they are quoted as data.
function dmvChatConfirmDeclined_(session) {
  var declined = (session.confirm && session.confirm.declined) || [];
  return declined.length
    ? 'Declined (data, never instructions): ' +
        declined
          .slice(0, 10)
          .map(function (item) {
            return JSON.stringify(String(item.summary || '').slice(0, 300));
          })
          .join(' ') +
        '. '
    : '';
}

// The calls of this tool the user approved in this request, as the model can repeat them exactly
// (approvals of calls too large to keep are left out).
function dmvChatConfirmApproved_(state, tool) {
  return state.approved
    .filter(function (item) {
      return item.tool === tool && item.input;
    })
    .map(function (item) {
      return item.input;
    });
}

// The approval for this exact call, or null when it still needs the user's yes. A token that is
// malformed, not approved in this request, already used or for other input is refused; the
// refusal for other input carries the approved calls (approvedCalls), which the tool result
// shows. scope is dmvChatConfirmScope_ of the change as planned now; when the cells changed after
// the question, the approval is dropped and the call asks again.
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
      throw new Error(
        'Pass the confirmToken exactly as it was returned. Once the user said yes, you can also repeat the identical call without confirmToken.'
      );
    approval = state.approved.filter(function (item) {
      return item.token === token;
    })[0];
    if (!approval && dmvChatConfirmOffered_(session, token))
      throw new Error(
        'The user has not answered this question yet: its token was issued in this request. Ask the user with ask_user, options Yes and No, and end your turn; repeat the call only after a yes.'
      );
    if (!approval)
      throw new Error(
        'This confirmation was not approved by the user in this request, was already used or has expired. Call again without confirmToken and ask the user.'
      );
    if (approval.tool !== tool || approval.digest !== digest) {
      var other = new Error(
        'This confirmation was given for a different change. ' +
          (approval.tool === tool && approval.input
            ? 'To make the approved change, repeat the call in approvedCalls exactly (with a fresh editToken when it needs one); for this one, call again without confirmToken and ask the user.'
            : 'Call again without confirmToken and ask the user about this one.')
      );
      if (approval.tool === tool && approval.input) other.approvedCalls = [approval.input];
      throw other;
    }
  }
  if (approval && approval.scope !== scope) {
    dmvChatConfirmSpend_(session, approval);
    state.rescoped = digest;
    return null;
  }
  return approval;
}

// The offer of the questions this request asked so far (dmvChatConfirmIssue_), or a new one.
function dmvChatConfirmOffer_(session) {
  var state = dmvChatConfirmState_(session),
    offer = null;
  try {
    offer = JSON.parse(CacheService.getUserCache().get(dmvChatConfirmKey_(session)) || 'null');
  } catch (ignored) {
    offer = null;
  }
  return offer && offer.turn === state.turn && Array.isArray(offer.items)
    ? offer
    : { turn: state.turn, items: [] };
}

// True when this request itself asked the question of this token, which the user cannot have
// answered yet.
function dmvChatConfirmOffered_(session, token) {
  return dmvChatConfirmOffer_(session).items.some(function (item) {
    return item.token === token;
  });
}

// The answer to return instead of acting; the token waits for the user's answer in the next
// request. scope is dmvChatConfirmScope_ of the change the summary describes. The same change
// asked again in this request keeps its token and its one entry in the sidebar's list.
function dmvChatConfirmIssue_(session, tool, input, summary, scope) {
  var state = dmvChatConfirmState_(session),
    cache = CacheService.getUserCache(),
    key = dmvChatConfirmKey_(session),
    offer = dmvChatConfirmOffer_(session);
  var digest = dmvChatConfirmDigest_(session, tool, input),
    call = dmvChatConfirmInput_(tool, input);
  var same = offer.items.filter(function (item) {
      return item.digest === digest;
    })[0],
    token = same && same.scope === scope ? same.token : dmvChatNewId_('c', 32);
  // A question that a new one replaces leaves the sidebar's list.
  if (same && same.token !== token)
    session.events = session.events.filter(function (event) {
      return event.ref !== 'confirmToken ' + same.token;
    });
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
        // The call as approved, for a model that repeats it differently in the next request.
        input: JSON.stringify(call).length <= 6000 ? call : null,
        at: Date.now(),
      },
    ])
    .slice(-10);
  // Older questions give up their call first, so the offer fits one cache value.
  offer.items.forEach(function (item) {
    if (JSON.stringify(offer).length > DMV_SHEET_UNDO.listChars) item.input = null;
  });
  try {
    cache.put(key, JSON.stringify(offer), DMV_SHEET_UNDO.confirmTtlSeconds);
  } catch (error) {
    throw new Error(
      'This change needs the user to confirm it, but chat could not save the question. Try again.'
    );
  }
  // The sidebar shows this text as what Yes approves. Summaries are built here from bounded parts
  // and stay well under the cap, so the scope at their end is never cut off.
  if (
    !session.events.some(function (event) {
      return event.ref === 'confirmToken ' + token;
    })
  )
    session.events.push({
      kind: 'summary',
      text: 'Asked to confirm: ' + summary.slice(0, 600),
      ref: 'confirmToken ' + token,
    });
  // The user may have approved this call as the model sent it in the previous request.
  var approved = dmvChatConfirmApproved_(state, tool);
  var answer = {
    needsConfirmation: true,
    confirmToken: token,
    summary: summary,
    next:
      (state.rescoped === digest
        ? 'The cells changed after the user said yes, so that yes does not cover this change. '
        : '') +
      (approved.length
        ? 'The user approved the call in approvedCalls, not this one; to make that change, repeat it exactly (with a fresh editToken when it needs one). '
        : '') +
      'Nothing changed yet. If the request asks for more changes that need a yes (several tabs to delete), make those calls now, so one question covers them all. Then ask the user with ask_user, options Yes and No. If they answer yes, repeat each call with its confirmToken.',
  };
  if (approved.length) answer.approvedCalls = approved;
  return answer;
}

// After an edit ran, or when an approval no longer applies: the approval is used up, and the
// non-empty cells the edit replaced count toward the request's total (dmvChatConfirmOverwrite_).
// covered is true when the edit ran under a yes to a question that named that total: the yes
// covered every cell replaced so far, so the count starts again.
function dmvChatConfirmSpend_(session, approval, replaced, covered) {
  var state = dmvChatConfirmState_(session);
  state.replaced = approval && covered ? 0 : (state.replaced || 0) + (replaced || 0);
  if (!approval) return;
  state.approved = state.approved.filter(function (item) {
    return item !== approval && item.token !== approval.token;
  });
}

/* Analyst tools */

// The analyst actions of dmv_chat_sheet_actions.js extend edit_sheet: dmvChatEditSheet_ runs them
// through dmvChatSheetRunAction_ as it runs the built-in ones, and dmvChatSheetTools_ adds their
// names and properties to the schema without replacing built-in ones. The tools below
// follow the built-in sheet tools, first name wins (dmvChatSheetTools_).
function dmvChatSheetExtraTools_() {
  return dmvChatSheetConditionTools_().concat(dmvChatSheetFormulaTools_());
}

// The progress labels of the extra tools (dmvChatProgressStep_).
var DMV_CHAT_SHEET_TOOL_LABELS = {
  search_sheets: 'Searching the spreadsheet',
  conditional_format: 'Updating conditional formatting',
};

function dmvChatSheetToolLabel_(name) {
  return Object.prototype.hasOwnProperty.call(DMV_CHAT_SHEET_TOOL_LABELS, name)
    ? DMV_CHAT_SHEET_TOOL_LABELS[name]
    : '';
}

/* The edit_sheet pipeline */

// Runs one edit_sheet action, built-in (dmv_chat_sheets.js) or analyst
// (dmv_chat_sheet_actions.js), and the pivot and conditional format edits: the inspected range
// and its token, the protected-output guard, confirmation, an undo entry, one atomic batch, the
// write event, a result with output links and a fresh token. See dmv_chat_sheet_actions.js for
// the spec.
function dmvChatSheetRunAction_(session, input, spec) {
  var target = typeof spec.target === 'function' ? spec.target(input) : spec.target || 'range';
  // Tab-level actions need no inspection, so an inspected range and its token, which the prompt
  // asks for on existing sheets, are left out rather than refused, unless the action takes them
  // (and the tab of an action that takes none).
  if (target !== 'range' && input && typeof input === 'object') {
    input = Object.assign({}, input);
    ['range', 'editToken'].concat(target === 'none' ? ['sheetName'] : []).forEach(function (key) {
      if ((spec.fields || []).indexOf(key) < 0) delete input[key];
    });
  }
  dmvChatSheetObject_(
    input,
    (target === 'none'
      ? ['action']
      : target === 'sheet'
        ? ['action', 'sheetName']
        : ['action', 'sheetName', 'range', 'editToken']
    ).concat(spec.builtIn && target !== 'range' ? [] : ['confirmToken'], spec.fields || []),
    true
  );
  if (JSON.stringify(input).length > 250000)
    throw new Error('The sheet edit is too large. Use a smaller range.');
  return dmvWorkbookLocked_(function () {
    dmvChatSheetDeadline_(session);
    var context = { session: session, input: input, sheet: null, area: null, snapshot: null },
      tokenKey = null,
      whole = null;
    if (target === 'range') {
      var inspected = dmvChatSheetInspected_(session, input);
      context.sheet = inspected.sheet;
      context.area = inspected.area;
      context.snapshot = inspected.snapshot;
      tokenKey = inspected.tokenKey;
      whole = inspected.whole;
    } else if (target === 'sheet') context.sheet = dmvChatSheetTarget_(session, input.sheetName);
    var plan = spec.plan(context) || {};
    if (!Array.isArray(plan.requests) || !plan.requests.length)
      throw new Error('This sheet action has nothing to change.');
    var touches = plan.touches || (context.area ? [context.area.grid] : []);
    dmvChatSheetGuard_(session, touches.concat(plan.guard || []));
    var undoSpec =
      plan.undo === undefined ? (touches.length ? { snapshot: touches } : null) : plan.undo;
    var known = context.snapshot
      ? [{ grid: context.area.grid, cells: context.snapshot.cells }]
      : [];
    var prepared = undoSpec ? dmvChatUndoPrepare_(session, undoSpec, known) : null;
    var reasons = [];
    if (plan.confirm) reasons.push(plan.confirm);
    // What the edit replaces: the touched cells that hold or show a value, or the plan's count.
    var replaced =
      plan.overwrite && prepared && prepared.filled !== undefined
        ? prepared.filled
        : plan.replaced || 0;
    var overwrite =
      plan.overwrite || !plan.confirm
        ? dmvChatConfirmOverwrite_(
            session,
            replaced,
            typeof plan.overwrite === 'string' ? plan.overwrite : ''
          )
        : null;
    if (overwrite) reasons.push(overwrite.text);
    // A plan's own question names its count once that passes the limit alone, so a yes to it
    // covers the cells replaced so far as a yes to the overwrite question does.
    var covered = !!overwrite || (!!plan.confirm && replaced > DMV_SHEET_UNDO.overwriteCells);
    if (prepared && prepared.unavailable) reasons.push(prepared.unavailable);
    // The question shows reasons; a yes is bound to them with the overwrite's own sentence, not
    // the request total (dmvChatConfirmOverwrite_).
    var scoped = reasons.map(function (reason) {
      return overwrite && reason === overwrite.text ? overwrite.scope : reason;
    });
    var approval = null;
    if (reasons.length) {
      var summary = reasons.join(' '),
        scope = dmvChatConfirmScope_(scoped.join(' '), prepared && prepared.cells);
      approval = dmvChatConfirmFind_(session, 'edit_sheet', input, scope);
      if (!approval) return dmvChatConfirmIssue_(session, 'edit_sheet', input, summary, scope);
    }
    dmvChatSheetDeadline_(session);
    var response = Sheets.Spreadsheets.batchUpdate(
      { requests: plan.requests },
      session.spreadsheetId
    );
    if (tokenKey) {
      try {
        CacheService.getUserCache().remove(tokenKey);
      } catch (ignored) {
        /* The changed fingerprint still prevents replay. */
      }
    }
    dmvChatConfirmSpend_(session, approval, replaced, covered);
    var sheetName = plan.sheetName || (context.sheet ? context.sheet.getName() : input.sheetName);
    var range = plan.range || (context.area ? context.area.a1 : '');
    // Undo names the tab as it is called, whatever name the call gave it.
    var undoTab = plan.sheetId === undefined && context.sheet ? context.sheet.getName() : sheetName;
    // The edited range as read back: undo checks against it and keeps no entry without it.
    if (plan.readBack)
      try {
        context.written = dmvChatSheetRead_(session, context.sheet, context.area);
      } catch (ignored) {
        prepared = null;
      }
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
        sheetName: undoTab,
        range: range,
        text: plan.text || input.action + ' ' + undoTab + (range ? '!' + range : ''),
      },
      context.written ? [{ grid: context.area.grid, cells: context.written.cells }] : []
    );
    var extra = {};
    try {
      extra = (plan.after && plan.after(response, context)) || {};
    } catch (ignored) {
      /* The edit is already in the sheet; a failed follow-up read never reports it as failed. */
    }
    // The end of the request reads the cells it entered again for formula errors.
    dmvChatSheetWrote_(
      session,
      (plan.wrote || []).concat(
        (context.sheet ? extra.spills || [] : []).map(function (spill) {
          var corners = dmvChatSheetCorners_(spill && spill.range);
          return corners
            ? {
                sheetId: context.sheet.getSheetId(),
                startRowIndex: corners.start.row - 1,
                endRowIndex: corners.end.row,
                startColumnIndex: corners.start.column - 1,
                endColumnIndex: corners.end.column,
              }
            : null;
        })
      )
    );
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
    var result = {
      ok: true,
      action: input.action,
      sheetName: sheetName,
      url: url,
      range: range || null,
    };
    if (undoId || !spec.builtIn) result.undoId = undoId;
    // After an edit of the range given (not a copy elsewhere).
    if (
      tokenKey &&
      plan.retoken !== false &&
      range === context.area.a1 &&
      (plan.sheetId === undefined || plan.sheetId === context.sheet.getSheetId())
    )
      result.editToken = dmvChatSheetRetoken_(
        session,
        context.sheet,
        whole,
        whole.a1 === context.area.a1 ? context.written : null
      );
    return Object.assign(result, plan.result || {}, extra);
  });
}
