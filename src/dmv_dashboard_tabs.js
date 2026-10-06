/* Dashboard datasets over a tab of this spreadsheet: { id, label, sourceSheet } reads the tab in
   place, its headers in row 1, instead of fetching a source query. A refresh never writes,
   rewrites or protects that tab; the page's formulas read it directly, sized to its rows on every
   refresh. dateColumn and dateRange keep one period of the tab, so two datasets of one tab can be
   compared like two periods of a source. */

function dmvDashboardIsTab_(dataset) {
  return !!dataset && dataset.sourceSheet !== undefined;
}

// Whether a dataset holds one period: a tab with a dateRange, or a source report that has dates.
function dmvDashboardPeriodic_(dataset) {
  if (dmvDashboardIsTab_(dataset)) return !!dataset.dateRange;
  return !!dmvDefinition_(dmvConnector_(dataset.connectorId), dataset.reportType).dateRange;
}

// Column keys from a header row, as read_sheet names them: the header in lower case with
// underscores, a blank header by its position, each key once.
function dmvTabColumns_(headers) {
  var seen = Object.create(null);
  return headers.map(function (header, index) {
    var label = String(header === '' || header === null ? 'Column ' + (index + 1) : header)
      .trim()
      .slice(0, 100);
    var key =
      label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'column_' + (index + 1);
    while (seen[key]) key += '_';
    seen[key] = true;
    return { key: key, label: label, index: index };
  });
}

function dmvDashboardIsDate_(value) {
  return Object.prototype.toString.call(value) === '[object Date]';
}

// A column's type from its filled cells: number, date (date cells, or text that starts with a
// yyyy-mm-dd day, such as a timestamp) or text. cells says the dates are date cells.
function dmvDashboardTabType_(values) {
  var counts = { number: 0, cells: 0, days: 0, other: 0 };
  values.forEach(function (value) {
    if (value === '' || value === null || value === undefined) return;
    if (typeof value === 'number') counts.number++;
    else if (dmvDashboardIsDate_(value)) counts.cells++;
    else if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:[ T]|$)/.test(value)) counts.days++;
    else counts.other++;
  });
  var kinds = Object.keys(counts).filter(function (kind) {
    return counts[kind];
  });
  var types = {
    number: { type: 'number' },
    cells: { type: 'date', cells: true },
    days: { type: 'date' },
  };
  return (kinds.length === 1 && types[kinds[0]]) || { type: 'text' };
}

// The tab a dataset reads, with its size, or an error that says what to do.
function dmvDashboardTabSheet_(spreadsheet, sheetName) {
  var sheet = spreadsheet.getSheetByName(sheetName);
  // A tab made earlier in this execution is seen by a spreadsheet opened again.
  if (!sheet) {
    spreadsheet = dmvReopen_(spreadsheet);
    sheet = spreadsheet.getSheetByName(sheetName);
  }
  if (!sheet) {
    var names = spreadsheet.getSheets().map(function (item) {
      return item.getName();
    });
    throw new Error(
      'The tab "' +
        sheetName +
        '" does not exist in this spreadsheet. Tabs: ' +
        names.slice(0, 15).join(', ') +
        (names.length > 15 ? ' and ' + (names.length - 15) + ' more' : '') +
        '.'
    );
  }
  var rows = sheet.getLastRow(),
    columns = rows ? sheet.getDataRange().getNumColumns() : 0;
  var header = rows ? sheet.getRange(1, 1, 1, columns).getValues()[0] : [];
  // Rows below the last one with a value (the "" of guarded array formulas) are not data: the
  // ranges of the dashboard's formulas end at the last of them, and a refresh sizes them again.
  if (rows > 1 && columns <= DMV_LIMITS.maxColumns)
    rows = Math.max(1, dmvSheetLastFilledRow_(sheet, 2, rows, 1, columns));
  if (
    rows < 2 ||
    !header.some(function (value) {
      return value !== '' && value !== null;
    })
  )
    throw new Error('The tab "' + sheetName + '" needs its headers in row 1 and data below them.');
  if (columns > DMV_LIMITS.maxColumns)
    throw new Error(
      '"' +
        sheetName +
        '" has ' +
        columns +
        ' columns; a dashboard reads at most ' +
        DMV_LIMITS.maxColumns +
        ' columns of a tab. Point the dataset at a tab with only the columns it needs.'
    );
  return { sheet: sheet, rows: rows - 1, columns: columns, header: header };
}

// A column of a tab by its header or key, as tiles name columns and a refresh finds them
// (dmvNameMatches_), or undefined.
function dmvDashboardTabField_(fields, name) {
  var found = dmvNameMatches_(name, fields, function (field) {
    return [field.key, field.label];
  });
  return found.length === 1 ? found[0] : undefined;
}

// The settings of a dataset that reads a tab, or null for a source query. A dataset without a
// query whose sheetName names a tab with data reads that tab: it could only mean that, unless the
// tab is a data tab the saved dashboard dashboardId writes, whose first rows are provenance. fields,
// the tab's columns with their types from its first rows, rides along unsaved (tabFields).
function dmvDashboardTabDataset_(dataset, spreadsheet, dashboardId) {
  var query = ['connectorId', 'connectionId', 'reportType', 'fields', 'config'].filter(
    function (key) {
      return dataset[key] !== undefined;
    }
  );
  var sourceSheet = dataset.sourceSheet;
  if (sourceSheet === undefined) {
    if (query.length || typeof dataset.sheetName !== 'string') return null;
    var named =
      spreadsheet.getSheetByName(dataset.sheetName.trim()) ||
      dmvReopen_(spreadsheet).getSheetByName(dataset.sheetName.trim());
    if (!named || named.getLastRow() < 1) return null;
    var written = dmvDashboardDataTabs_(spreadsheet, dashboardId)[named.getName().toLowerCase()];
    if (written)
      throw new Error(
        '"' +
          named.getName() +
          '" is the data tab this dashboard writes for "' +
          written +
          '": give dataset "' +
          (dataset.label || dataset.id) +
          '" its connectionId, reportType and fields again, or sourceSheet to read another tab in place.'
      );
    sourceSheet = dataset.sheetName;
  }
  var name = dmvSheetName_(sourceSheet);
  if (query.length)
    throw new Error(
      'Dataset "' +
        (dataset.label || dataset.id) +
        '" reads either a source query (connectionId, reportType, fields) or a tab (sourceSheet), not both.'
    );
  // The tab is read in place and nothing writes a tab for it, so a sheetName given beside
  // sourceSheet (the "<label> Data" tab of a query dataset) is left out of the plan.
  var tab = dmvDashboardTabSheet_(spreadsheet, name);
  var sample = tab.sheet.getRange(2, 1, Math.min(tab.rows, 200), tab.columns).getValues();
  var fields = dmvTabColumns_(tab.header).map(function (column) {
    return {
      key: column.key,
      label: column.label,
      type: dmvDashboardTabType_(
        sample.map(function (row) {
          return row[column.index];
        })
      ).type,
    };
  });
  var dated = fields.filter(function (field) {
    return field.type === 'date';
  });
  var validated = { sourceSheet: name };
  if (dataset.dateColumn !== undefined || dataset.dateRange !== undefined) {
    if (dataset.dateRange === undefined)
      throw new Error(
        'dateColumn keeps the rows of a dateRange; give "' +
          name +
          '" both, or neither to read every row.'
      );
    var column;
    if (dataset.dateColumn !== undefined) {
      column = dmvDashboardTabField_(fields, dataset.dateColumn);
      if (!column || column.type !== 'date')
        throw new Error(
          'dateColumn "' +
            String(dataset.dateColumn).slice(0, 80) +
            '" of ' +
            name +
            ' holds no dates. ' +
            (dated.length
              ? 'Date columns: ' + dated.map(dmvDashboardFieldLabel_).join(', ') + '.'
              : 'It has no date column, so it has no periods: leave dateRange out.')
        );
    } else if (dated.length === 1) column = dated[0];
    else
      throw new Error(
        dated.length
          ? 'Name the dateColumn of ' +
              name +
              ' that dateRange keeps: ' +
              dated.map(dmvDashboardFieldLabel_).join(', ') +
              '.'
          : name + ' has no date column, so it has no periods: leave dateRange out.'
      );
    dmvDashboardObject_(dataset.dateRange, ['preset', 'startDate', 'endDate']);
    var range = { preset: String(dataset.dateRange.preset || '') };
    if (range.preset === 'custom') {
      range.startDate = dataset.dateRange.startDate;
      range.endDate = dataset.dateRange.endDate;
    }
    dmvDateRange_(
      range,
      Utilities.formatDate(new Date(), spreadsheet.getSpreadsheetTimeZone(), 'yyyy-MM-dd')
    );
    validated.dateColumn = column.label;
    validated.dateRange = range;
  }
  Object.defineProperty(validated, 'tabFields', { value: fields, enumerable: false });
  return validated;
}

function dmvDashboardFieldLabel_(field) {
  return field.label;
}

// The data tabs the saved dashboard id writes for its source queries, by name in lower case, each
// with its dataset's label.
function dmvDashboardDataTabs_(spreadsheet, id) {
  var tabs = Object.create(null);
  if (!id) return tabs;
  dmvList_('dashboard').forEach(function (dashboard) {
    if (dashboard.id !== id || dashboard.spreadsheetId !== spreadsheet.getId()) return;
    (dashboard.outputs || []).forEach(function (output) {
      if (!output.tab && output.sheetName)
        tabs[String(output.sheetName).toLowerCase()] = output.label || output.id;
    });
  });
  return tabs;
}

// The tabs of other dashboards in this spreadsheet, by name in lower case: a tab dataset cannot
// read a page, a chart data tab or a data tab a refresh rewrites. Tabs datasets read are users'.
function dmvDashboardOutputTabs_(spreadsheet, id) {
  var owned = Object.create(null);
  dmvList_('dashboard').forEach(function (dashboard) {
    if (dashboard.spreadsheetId !== spreadsheet.getId() || dashboard.id === id || !dashboard.target)
      return;
    [dashboard.target.sheetName, dmvDashboardChartTab_(dashboard.target)]
      .concat(
        (dashboard.outputs || [])
          .filter(function (output) {
            return !output.tab;
          })
          .map(function (output) {
            return output.sheetName;
          })
      )
      .forEach(function (name) {
        if (name) owned[String(name).toLowerCase()] = dashboard.name;
      });
  });
  return owned;
}

// One refresh's read of a tab dataset: the rows as a result (dates as yyyy-mm-dd, the period's
// rows only) and the tab as formulas read it, every data row from row 2. cache keeps each tab's
// values for this refresh, so two periods of one tab read it once.
function dmvDashboardReadTab_(spreadsheet, dataset, period, timezone, cache) {
  var name = dataset.sourceSheet,
    read = cache[name];
  if (!read) {
    var tab = dmvDashboardTabSheet_(spreadsheet, name);
    if (tab.rows > DMV_LIMITS.maxRows)
      throw new Error(
        '"' +
          name +
          '" has ' +
          tab.rows.toLocaleString() +
          ' data rows; a dashboard reads at most ' +
          DMV_LIMITS.maxRows.toLocaleString() +
          ' rows of a tab. Point the dataset at a smaller tab, such as a summary of formulas over it.'
      );
    if (tab.rows * tab.columns > DMV_LIMITS.maxCells)
      throw new Error(
        '"' +
          name +
          '" has ' +
          (tab.rows * tab.columns).toLocaleString() +
          ' cells; a dashboard reads at most ' +
          DMV_LIMITS.maxCells.toLocaleString() +
          '. Point the dataset at a tab with fewer columns.'
      );
    var values = tab.sheet.getRange(2, 1, tab.rows, tab.columns).getValues();
    var columns = dmvTabColumns_(tab.header).map(function (column) {
      var kind = dmvDashboardTabType_(
        values.map(function (row) {
          return row[column.index];
        })
      );
      return {
        key: column.key,
        label: column.label,
        type: kind.type,
        role: kind.type === 'number' ? 'metric' : 'dimension',
        cells: !!kind.cells,
      };
    });
    var rows = values.map(function (line) {
      var row = {};
      columns.forEach(function (column, index) {
        var value = line[index];
        row[column.key] =
          value === '' || value === null || value === undefined
            ? null
            : dmvDashboardIsDate_(value)
              ? Utilities.formatDate(value, timezone, 'yyyy-MM-dd')
              : typeof value === 'number' || typeof value === 'boolean'
                ? value
                : String(value);
      });
      return row;
    });
    read = cache[name] = { rows: rows, columns: columns, count: tab.rows };
  }
  var dates = Object.create(null);
  read.columns.forEach(function (column, index) {
    if (column.cells) dates[index] = true;
  });
  var plain = read.columns.map(function (column) {
    return { key: column.key, label: column.label, type: column.type, role: column.role };
  });
  var shape = {
    sheet: name,
    firstRow: 2,
    rows: read.count,
    columns: plain,
    metadata: {},
    dates: dates,
  };
  var rows = read.rows;
  if (period) {
    var at = plain.indexOf(dmvChatColumn_({ columns: plain }, dataset.dateColumn, 'dateColumn'));
    var key = plain[at].key,
      after = new Date(Date.parse(period.endDate + 'T12:00:00Z') + 86400000)
        .toISOString()
        .slice(0, 10);
    rows = rows.filter(function (row) {
      var day = typeof row[key] === 'string' ? row[key].slice(0, 10) : null;
      return !!day && day >= period.startDate && day <= period.endDate;
    });
    // The formulas keep the same rows of the whole tab: from the first day to the day after.
    var column = dmvDashboardTabColumn_(shape, at);
    shape.period = [
      { column: column, op: 'gte', value: period.startDate },
      { column: column, op: 'lt', value: after },
    ];
  }
  return {
    result: { columns: plain, rows: rows, metadata: {}, source: 'Tab ' + name },
    tab: shape,
  };
}
