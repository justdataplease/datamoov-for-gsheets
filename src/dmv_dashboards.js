/* Dashboards: several datasets, each refreshed into its own tab, plus one dashboard tab with
   scorecards, native charts and their supporting tables. Plans stay private to their owner and
   workbook. A refresh rebuilds every tab and chart from the saved plan, without an AI call. */
var DMV_DASHBOARD = {
  maxDatasets: 6,
  maxTiles: 12,
  maxKpis: 8,
  maxSeries: 12,
  chartTypes: ['line', 'column', 'bar', 'area', 'pie', 'scatter'],
  chartsPerRow: 2,
  chartBandRows: 17,
  chartColumnSpan: 5,
  chartWidth: 630,
  chartHeight: 340,
  columnWidth: 130,
  tableRows: 50,
  maxTableRows: 1000,
  datePoints: 400,
  categoryPoints: 15,
};

function dmvDashboardObject_(value, keys) {
  if (
    !value ||
    Object.prototype.toString.call(value) !== '[object Object]' ||
    Object.keys(value).some(function (key) {
      return keys.indexOf(key) < 0;
    })
  )
    throw new Error('Use only the documented dashboard settings: ' + keys.join(', ') + '.');
  return value;
}

function dmvDashboardInteger_(value, minimum, maximum, label) {
  if (typeof value !== 'number' || !Number.isInteger(value))
    throw new Error(label + ' must be a whole number.');
  return dmvInteger_(value, minimum, maximum, label);
}

function dmvDashboardNames_(values, maximum, label) {
  if (
    !Array.isArray(values) ||
    values.length > maximum ||
    values.some(function (key, index) {
      return typeof key !== 'string' || !key || key.length > 150 || values.indexOf(key) !== index;
    })
  )
    throw new Error('Choose distinct ' + label + '.');
  return values.slice();
}

function dmvDashboardIsChart_(tile) {
  return DMV_DASHBOARD.chartTypes.indexOf(tile.type) >= 0;
}

function dmvValidateDashboard_(input, spreadsheet) {
  dmvDashboardObject_(input, ['id', 'revision', 'name', 'datasets', 'tiles', 'target']);
  if (
    !Array.isArray(input.datasets) ||
    !input.datasets.length ||
    input.datasets.length > DMV_DASHBOARD.maxDatasets
  )
    throw new Error('Choose between one and six dashboard datasets.');
  dmvDashboardObject_(input.target, ['sheetName']);
  var target = { sheetName: dmvSheetName_(input.target.sheetName), startCell: 'A1' };
  var ids = Object.create(null),
    labels = Object.create(null),
    tabs = Object.create(null),
    queries = Object.create(null);
  tabs[target.sheetName.toLowerCase()] = true;
  tabs[dmvDashboardChartTab_(target).toLowerCase()] = true;
  var datasets = input.datasets.map(function (dataset, index) {
    dmvDashboardObject_(dataset, [
      'id',
      'label',
      'sheetName',
      'connectorId',
      'connectionId',
      'reportType',
      'fields',
      'config',
      'dateRange',
      'maxRows',
      'mapping',
    ]);
    var query = dmvValidateQuery_(dataset, spreadsheet);
    query.maxRows = dmvDashboardInteger_(
      dataset.maxRows === undefined ? DMV_LIMITS.defaultRows : dataset.maxRows,
      1,
      DMV_LIMITS.maxRows,
      'Dataset row limit'
    );
    var id = dataset.id === undefined ? 'dataset' + (index + 1) : dataset.id;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(id) || ids[id])
      throw new Error(
        'Use distinct dataset IDs of 1 to 40 letters, digits, underscores or dashes.'
      );
    ids[id] = true;
    var label = dmvText_(dataset.label, 'Dataset label', 80, true);
    if (labels[label]) throw new Error('Use distinct dataset labels.');
    labels[label] = true;
    var sheetName = dmvSheetName_(dataset.sheetName);
    if (tabs[sheetName.toLowerCase()])
      throw new Error('Give every dataset and the dashboard its own tab: ' + sheetName + '.');
    tabs[sheetName.toLowerCase()] = true;
    var identityQuery = Object.assign({}, query, { fields: query.fields.slice().sort() });
    delete identityQuery.maxRows;
    var identity = JSON.stringify(dmvCanonical_(identityQuery));
    if (queries[identity])
      throw new Error('Do not include the same dataset query twice in a dashboard.');
    queries[identity] = true;
    var validated = Object.assign({}, query, { id: id, label: label, sheetName: sheetName });
    if (dataset.mapping !== undefined) {
      if (!Array.isArray(dataset.mapping) || !dataset.mapping.length || dataset.mapping.length > 78)
        throw new Error('Map between one and 78 dataset columns.');
      var keys = Object.create(null);
      validated.mapping = dataset.mapping.map(function (entry) {
        dmvDashboardObject_(entry, ['field', 'key']);
        if (
          typeof entry.field !== 'string' ||
          !entry.field ||
          entry.field.length > 150 ||
          (query.fields.length && query.fields.indexOf(entry.field) < 0)
        )
          throw new Error('Map selected dataset fields only.');
        if (
          typeof entry.key !== 'string' ||
          !/^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(entry.key) ||
          ['source', 'constructor', 'prototype', '__proto__'].indexOf(entry.key) >= 0 ||
          keys[entry.key]
        )
          throw new Error('Use distinct ordinary mapped column names; source is reserved.');
        keys[entry.key] = true;
        return { field: entry.field, key: entry.key };
      });
    }
    return validated;
  });
  if (
    !Array.isArray(input.tiles) ||
    !input.tiles.length ||
    input.tiles.length > DMV_DASHBOARD.maxTiles
  )
    throw new Error('Choose between one and twelve dashboard tiles.');
  var kpis = 0;
  var tiles = input.tiles.map(function (tile) {
    dmvDashboardObject_(tile, [
      'title',
      'type',
      'datasets',
      'groupBy',
      'dateBucket',
      'metrics',
      'orderBy',
      'limit',
      'rankWithin',
      'limitPerGroup',
      'filters',
      'ratios',
      'compare',
      'stacked',
      'secondaryAxis',
      'width',
    ]);
    var title = dmvText_(tile.title, 'Tile title', 120, true);
    var type = String(tile.type || '');
    if (['kpi', 'table'].concat(DMV_DASHBOARD.chartTypes).indexOf(type) < 0)
      throw new Error('Tile type must be kpi, table, ' + DMV_DASHBOARD.chartTypes.join(', ') + '.');
    var from =
      tile.datasets === undefined
        ? Object.keys(ids)
        : dmvDashboardNames_(tile.datasets, DMV_DASHBOARD.maxDatasets, 'tile datasets');
    if (
      !from.length ||
      from.some(function (id) {
        return !ids[id];
      })
    )
      throw new Error('"' + title + '": datasets must name dataset IDs of this dashboard.');
    var members = datasets.filter(function (dataset) {
      return from.indexOf(dataset.id) >= 0;
    });
    var mapped = members.every(function (dataset) {
      return !!dataset.mapping;
    });
    if (members.length > 1 && !mapped)
      throw new Error(
        '"' +
          title +
          '" reads several datasets, so each of them needs a mapping that gives their columns shared names.'
      );
    // Mapped columns are known now; columns of an unmapped dataset are checked at refresh.
    var allowed = mapped
      ? members[0].mapping
          .map(function (entry) {
            return entry.key;
          })
          .filter(function (key) {
            return members.every(function (dataset) {
              return dataset.mapping.some(function (entry) {
                return entry.key === key;
              });
            });
          })
          .concat(['source', 'currency'])
      : null;
    function known(name) {
      if (allowed && allowed.indexOf(name) < 0)
        throw new Error(
          '"' + title + '": unknown column "' + name + '". Mapped columns: ' + allowed.join(', ')
        );
      return name;
    }
    var groupBy = dmvDashboardNames_(tile.groupBy || [], 6, 'groupBy columns').map(known);
    if (
      !Array.isArray(tile.metrics === undefined ? [] : tile.metrics) ||
      (tile.metrics || []).length > 8
    )
      throw new Error('"' + title + '": choose at most eight metrics.');
    var metricKeys = Object.create(null);
    var metrics = (tile.metrics || []).map(function (metric) {
      dmvDashboardObject_(metric, ['field', 'agg']);
      var agg = metric.agg === undefined ? 'sum' : metric.agg;
      if (
        typeof metric.field !== 'string' ||
        !metric.field ||
        metric.field.length > 150 ||
        ['sum', 'avg', 'min', 'max', 'count', 'count_distinct'].indexOf(agg) < 0 ||
        metricKeys[metric.field + '__' + agg]
      )
        throw new Error('"' + title + '": choose distinct metrics with a supported agg.');
      metricKeys[metric.field + '__' + agg] = true;
      return { field: known(metric.field), agg: agg };
    });
    // Ratios and filters are summarize settings; their columns are checked like metrics.
    if (!Array.isArray(tile.ratios || []) || (tile.ratios || []).length > 8)
      throw new Error('"' + title + '": choose at most eight ratios.');
    var ratios = (tile.ratios || []).map(function (ratio) {
      dmvDashboardObject_(ratio, ['key', 'label', 'numerator', 'denominator', 'percent']);
      if (
        typeof ratio.key !== 'string' ||
        !/^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(ratio.key) ||
        metricKeys[ratio.key] ||
        (ratio.percent !== undefined && typeof ratio.percent !== 'boolean') ||
        ['numerator', 'denominator'].some(function (side) {
          return typeof ratio[side] !== 'string' || !ratio[side] || ratio[side].length > 150;
        })
      )
        throw new Error(
          '"' + title + '": each ratio needs a distinct key, a numerator and a denominator column.'
        );
      metricKeys[ratio.key] = true;
      var entry = {
        key: ratio.key,
        numerator: known(ratio.numerator),
        denominator: known(ratio.denominator),
      };
      if (typeof ratio.label === 'string' && ratio.label) entry.label = ratio.label.slice(0, 80);
      if (ratio.percent === true) entry.percent = true;
      return entry;
    });
    if (!Array.isArray(tile.filters || []) || (tile.filters || []).length > 8)
      throw new Error('"' + title + '": choose at most eight filters.');
    var filters = (tile.filters || []).map(function (filter) {
      dmvDashboardObject_(filter, ['field', 'op', 'value']);
      if (
        typeof filter.field !== 'string' ||
        !filter.field ||
        filter.field.length > 150 ||
        ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'in'].indexOf(filter.op) < 0 ||
        !(typeof filter.value === 'string'
          ? filter.value.length <= 200
          : typeof filter.value === 'number' && isFinite(filter.value))
      )
        throw new Error(
          '"' +
            title +
            '": each filter needs field, op (eq, ne, gt, gte, lt, lte, contains, in) and a text or number value.'
        );
      return { field: known(filter.field), op: filter.op, value: filter.value };
    });
    var values = metrics.length + ratios.length;
    var bucket = tile.dateBucket || 'day';
    if (['day', 'week', 'month', 'year'].indexOf(bucket) < 0)
      throw new Error('Choose day, week, month or year date grouping.');
    var validated = {
      title: title,
      type: type,
      datasets: from,
      groupBy: groupBy,
      dateBucket: bucket,
      metrics: metrics,
    };
    if (ratios.length) validated.ratios = ratios;
    if (filters.length) validated.filters = filters;
    if (type === 'kpi') {
      if (groupBy.length || !values)
        throw new Error('"' + title + '": a kpi tile takes metrics or ratios and no groupBy.');
      kpis += values;
    } else if (type === 'table') {
      if (!groupBy.length && !values)
        throw new Error('"' + title + '": a table needs groupBy columns, metrics or ratios.');
    } else {
      if (!groupBy.length || groupBy.length > 2 || !values)
        throw new Error(
          '"' +
            title +
            '": a chart needs metrics or ratios and one groupBy column for its axis; a second groupBy column splits it into series.'
        );
      if ((groupBy.length === 2 || type === 'pie') && values !== 1)
        throw new Error('"' + title + '": a pie or split chart takes exactly one metric or ratio.');
      if (tile.stacked !== undefined) {
        if (tile.stacked !== true || ['column', 'bar', 'area'].indexOf(type) < 0)
          throw new Error('"' + title + '": stacked applies to column, bar and area charts.');
        validated.stacked = true;
      }
      // Values on the right axis are usually rates beside counts; on a column chart they are
      // drawn as lines, which is what Sheets offers for two scales.
      if (tile.secondaryAxis !== undefined) {
        var keys = metrics
          .map(function (metric) {
            return metric.field;
          })
          .concat(
            ratios.map(function (ratio) {
              return ratio.key;
            })
          );
        var right = dmvDashboardNames_(tile.secondaryAxis, 8, 'secondaryAxis columns');
        if (
          ['line', 'column', 'area', 'scatter'].indexOf(type) < 0 ||
          groupBy.length > 1 ||
          !right.length ||
          right.length >= keys.length ||
          right.some(function (key) {
            return keys.indexOf(key) < 0;
          })
        )
          throw new Error(
            '"' +
              title +
              '": secondaryAxis names metric fields or ratio keys of a line, column, area or scatter chart without a split, and leaves at least one on the left axis.'
          );
        validated.secondaryAxis = right;
      }
      if (tile.width !== undefined) {
        if (tile.width !== 'full')
          throw new Error(
            '"' + title + '": width can only be "full", for a chart that takes the whole row.'
          );
        validated.width = 'full';
      }
      if (type === 'pie' && groupBy.length !== 1)
        throw new Error('"' + title + '": a pie chart takes one groupBy column.');
    }
    // A scorecard compares one dataset (the current period) with another (the previous one).
    if (tile.compare !== undefined) {
      dmvDashboardObject_(tile.compare, ['current', 'previous']);
      if (
        type !== 'kpi' ||
        tile.compare.current === tile.compare.previous ||
        ['current', 'previous'].some(function (side) {
          return typeof tile.compare[side] !== 'string' || from.indexOf(tile.compare[side]) < 0;
        })
      )
        throw new Error(
          '"' +
            title +
            '": compare belongs on a kpi tile and names two different dataset ids of that tile as current and previous.'
        );
      validated.compare = { current: tile.compare.current, previous: tile.compare.previous };
    }
    if (tile.orderBy !== undefined) {
      dmvDashboardObject_(tile.orderBy, ['field', 'direction']);
      if (
        typeof tile.orderBy.field !== 'string' ||
        !tile.orderBy.field ||
        tile.orderBy.field.length > 160 ||
        ['asc', 'desc'].indexOf(tile.orderBy.direction) < 0
      )
        throw new Error('"' + title + '": orderBy needs a field and asc or desc.');
      validated.orderBy = { field: tile.orderBy.field, direction: tile.orderBy.direction };
    }
    if (tile.limit !== undefined)
      validated.limit = dmvDashboardInteger_(
        tile.limit,
        1,
        DMV_DASHBOARD.maxTableRows,
        'Tile row limit'
      );
    if (tile.rankWithin !== undefined || tile.limitPerGroup !== undefined) {
      if (type !== 'table' || !validated.orderBy)
        throw new Error(
          '"' + title + '": per-group rankings need a table tile with an explicit orderBy metric.'
        );
      validated.rankWithin = dmvDashboardNames_(tile.rankWithin, 6, 'ranking columns');
      if (
        !validated.rankWithin.length ||
        validated.rankWithin.some(function (key) {
          return groupBy.indexOf(key) < 0;
        })
      )
        throw new Error('"' + title + '": every rankWithin column must also be in groupBy.');
      validated.limitPerGroup = dmvDashboardInteger_(
        tile.limitPerGroup,
        1,
        DMV_DASHBOARD.maxTableRows,
        'Per-group row limit'
      );
    }
    return validated;
  });
  if (!tiles.some(dmvDashboardIsChart_))
    throw new Error(
      'A dashboard needs at least one chart tile (' +
        DMV_DASHBOARD.chartTypes.join(', ') +
        '). Numbers alone are a report.'
    );
  if (kpis > DMV_DASHBOARD.maxKpis) throw new Error('Choose at most eight kpi metrics.');
  return {
    name: dmvText_(input.name, 'Dashboard name', 80, true),
    datasets: datasets,
    tiles: tiles,
    target: target,
  };
}

// Dashboards saved before datasets and tiles existed combined every source into one table.
function dmvDashboardLegacy_(dashboard) {
  return !dashboard.plan;
}

var DMV_DASHBOARD_LEGACY =
  'This dashboard was saved by an earlier version. Remove it and ask Chat to create it again.';

function dmvDashboardPlan_(dashboard) {
  if (dmvDashboardLegacy_(dashboard)) throw new Error(DMV_DASHBOARD_LEGACY);
  try {
    return dmvUnpack_(dashboard.plan);
  } catch (ignored) {
    throw new Error('This saved dashboard is damaged. Remove it and create it again.');
  }
}

function dmvDashboardOutputId_(dashboard, dataset) {
  return dashboard.id + '-d-' + dataset.id;
}

function dmvDashboardLinks_(spreadsheet, dashboard) {
  return [
    {
      label: 'Dashboard: ' + dashboard.target.sheetName,
      url: dmvSheetLink_(spreadsheet, dashboard.target),
    },
  ]
    .concat(
      (dashboard.outputs || []).map(function (output) {
        return {
          label: 'Data: ' + output.sheetName,
          url: dmvSheetLink_(spreadsheet, { sheetName: output.sheetName, startCell: 'A1' }),
        };
      })
    )
    .filter(function (link) {
      return !!link.url;
    });
}

function dmvDashboardSummary_(dashboard, spreadsheet) {
  var legacy = dmvDashboardLegacy_(dashboard);
  var expired = dashboard.status === 'running' && Date.now() - dashboard.startedAt >= 300000;
  return {
    id: dashboard.id,
    revision: dashboard.revision,
    name: dashboard.name,
    legacy: legacy,
    datasets: legacy
      ? []
      : dashboard.outputs.map(function (output) {
          return {
            id: output.id,
            label: output.label,
            sheetName: output.sheetName,
            rowCount: output.rows === undefined ? null : output.rows,
            url: dmvSheetLink_(spreadsheet, { sheetName: output.sheetName, startCell: 'A1' }),
          };
        }),
    chartCount: dashboard.chartCount || 0,
    target: dashboard.target,
    reportUrl: dmvSheetLink_(spreadsheet, dashboard.target),
    status: legacy || expired ? 'error' : dashboard.status,
    statusMessage: legacy
      ? 'Saved by an earlier version'
      : expired
        ? 'The previous refresh was interrupted. Refresh again to retry all datasets.'
        : dashboard.statusMessage || '',
    lastRun: dashboard.lastRun || null,
    lastRowCount: dashboard.lastRowCount === undefined ? null : dashboard.lastRowCount,
    lastError: legacy ? DMV_DASHBOARD_LEGACY : dashboard.lastError || '',
    private: true,
  };
}

function dmvDashboardHere_(id) {
  var dashboard = dmvRead_('dashboard', id);
  if (dashboard.spreadsheetId !== dmvSpreadsheet_().getId())
    throw new Error('This dashboard belongs to another spreadsheet.');
  return dashboard;
}

function dmvListDashboards() {
  var spreadsheet = dmvSpreadsheet_();
  return dmvList_('dashboard')
    .filter(function (dashboard) {
      return dashboard.spreadsheetId === spreadsheet.getId();
    })
    .map(function (dashboard) {
      return dmvDashboardSummary_(dashboard, spreadsheet);
    });
}

function dmvSaveDashboard(input) {
  return dmvLocked_(function () {
    var spreadsheet = dmvSpreadsheet_(),
      previous = input && input.id ? dmvDashboardHere_(input.id) : null;
    if (previous && previous.runToken && Date.now() - previous.startedAt < 300000)
      throw new Error('Wait for this dashboard refresh to finish before changing it.');
    if (previous && input.revision !== previous.revision)
      throw new Error('This dashboard changed. Refresh the sidebar before saving.');
    if (!previous && dmvList_('dashboard').length >= DMV_LIMITS.maxReports)
      throw new Error('Keep at most 30 private dashboards.');
    var plan = dmvValidateDashboard_(input, spreadsheet);
    var id = previous ? previous.id : dmvId_();
    // A tab someone else filled would only fail after every dataset was fetched; say so now,
    // with its name. Tabs this dashboard wrote earlier are its own.
    var fresh = dmvReopen_(spreadsheet),
      store = dmvStore_();
    plan.datasets
      .map(function (dataset) {
        return { sheetName: dataset.sheetName, output: id + '-d-' + dataset.id };
      })
      .concat([
        { sheetName: plan.target.sheetName, output: id + '-report' },
        { sheetName: dmvDashboardChartTab_(plan.target), output: id + '-charts' },
      ])
      .forEach(function (tab) {
        var sheet = fresh.getSheetByName(tab.sheetName);
        if (
          sheet &&
          sheet.getLastRow() > 0 &&
          !store.getProperty(dmvOutputKey_(fresh.getId(), tab.output))
        )
          throw new Error(
            'The tab "' +
              tab.sheetName +
              '" already exists and has content. Give this dashboard tab names that are not in the spreadsheet yet, for example "' +
              tab.sheetName +
              ' 2".'
          );
      });
    var dashboard = {
      id: id,
      spreadsheetId: spreadsheet.getId(),
      revision: previous ? previous.revision + 1 : 1,
      name: plan.name,
      target: plan.target,
      outputs: plan.datasets.map(function (dataset) {
        return { id: dataset.id, label: dataset.label, sheetName: dataset.sheetName };
      }),
      chartCount: plan.tiles.filter(dmvDashboardIsChart_).length,
      // Listed outside the packed plan so connection guards need not unpack every dashboard.
      connectionIds: plan.datasets
        .map(function (dataset) {
          return dataset.connectionId;
        })
        .filter(function (connectionId, index, all) {
          return all.indexOf(connectionId) === index;
        }),
      plan: dmvPack_({ datasets: plan.datasets, tiles: plan.tiles }),
      chartIds: (previous && previous.chartIds) || [],
      status: 'ready',
      statusMessage: 'Ready to refresh all datasets',
      lastError: '',
      runToken: null,
    };
    ['lastRun', 'lastRowCount'].forEach(function (key) {
      if (previous && previous[key] !== undefined) dashboard[key] = previous[key];
    });
    // Reserve record room for execution metadata so a valid plan can always record its outcome.
    try {
      dmvCheckRecordSize_(
        Object.assign({}, dashboard, {
          statusMessage: 'x'.repeat(200),
          lastError: 'x'.repeat(900),
          runToken: 'x'.repeat(80),
          startedAt: Date.now(),
          lastRun: new Date().toISOString(),
          lastRowCount: DMV_LIMITS.maxRows,
          chartIds: plan.tiles.map(function () {
            return 2000000000;
          }),
          outputs: dashboard.outputs.map(function (output) {
            return Object.assign({ rows: DMV_LIMITS.maxRows }, output);
          }),
        })
      );
    } catch (ignored) {
      throw new Error('This dashboard is too large to save. Use fewer datasets, fields or tiles.');
    }
    dmvSave_('dashboard', dashboard);
    // A dataset dropped from the plan no longer owns its tab.
    ((previous && previous.outputs) || []).forEach(function (output) {
      if (
        !dashboard.outputs.some(function (kept) {
          return kept.id === output.id;
        })
      )
        dmvStore_().deleteProperty(
          dmvOutputKey_(dashboard.spreadsheetId, dmvDashboardOutputId_(dashboard, output))
        );
    });
    return dmvDashboardSummary_(dashboard, spreadsheet);
  });
}

// Removing a dashboard cleans up after it: the tabs it wrote (data tabs, the hidden chart data
// tab, the dashboard tab with its charts) are deleted with the plan. Ownership is the receipt,
// which records the sheet id, so a tab that merely shares a name is never touched. Pass
// keepTabs to remove only the plan.
function dmvDeleteDashboard(id, keepTabs) {
  return dmvLocked_(function () {
    var dashboard = dmvDashboardHere_(id);
    if (dashboard.runToken && Date.now() - dashboard.startedAt < 300000)
      throw new Error('Wait for this dashboard refresh to finish.');
    var store = dmvStore_();
    // -data is the combined tab of dashboards saved before datasets existed.
    var keys = ['-report', '-charts', '-data']
      .concat(
        (dashboard.outputs || []).map(function (output) {
          return '-d-' + output.id;
        })
      )
      .map(function (suffix) {
        return dmvOutputKey_(dashboard.spreadsheetId, dashboard.id + suffix);
      });
    var deleted = 0;
    if (keepTabs !== true)
      deleted = dmvWorkbookLocked_(function () {
        var owned = Object.create(null);
        keys.forEach(function (key) {
          var receipt = JSON.parse(store.getProperty(key) || 'null');
          if (receipt && Number.isInteger(receipt.sheetId)) owned[receipt.sheetId] = true;
        });
        var live = (
          Sheets.Spreadsheets.get(dashboard.spreadsheetId, {
            fields: 'sheets.properties.sheetId',
          }).sheets || []
        ).map(function (item) {
          return item.properties.sheetId;
        });
        var requests = live
          .filter(function (sheetId) {
            return owned[sheetId];
          })
          .map(function (sheetId) {
            return { deleteSheet: { sheetId: sheetId } };
          });
        if (!requests.length) return 0;
        // A spreadsheet must keep one tab.
        if (requests.length === live.length) requests.unshift({ addSheet: { properties: {} } });
        Sheets.Spreadsheets.batchUpdate({ requests: requests }, dashboard.spreadsheetId);
        return requests.filter(function (request) {
          return request.deleteSheet;
        }).length;
      });
    store.deleteProperty(dmvKey_('dashboard', dashboard.id));
    keys.forEach(function (key) {
      store.deleteProperty(key);
    });
    return { ok: true, deletedTabs: deleted };
  });
}

function dmvDashboardDeadline_(deadline) {
  if (Date.now() > deadline - 10000)
    throw new Error(
      'This dashboard reached its refresh time limit. Narrow its datasets and try again.'
    );
}

function dmvDashboardPad_(row, width) {
  row = row.map(dmvSheetValue_);
  while (row.length < width) row.push('');
  return row;
}

// The rows a tile reads: one dataset as fetched, or datasets appended under their shared mapped
// names with a source column. Tiles over the same datasets share one input.
function dmvDashboardInput_(session, datasets, tile, fetched, memo) {
  var key = tile.datasets.join('|');
  if (memo[key]) return memo[key];
  var members = datasets.filter(function (dataset) {
    return tile.datasets.indexOf(dataset.id) >= 0;
  });
  if (members.length === 1 && !members[0].mapping) return (memo[key] = fetched[members[0].id]);
  var shared = members[0].mapping.filter(function (entry) {
    return members.every(function (dataset) {
      return dataset.mapping.some(function (other) {
        return other.key === entry.key;
      });
    });
  });
  if (!shared.length)
    throw new Error('"' + tile.title + '": its datasets share no mapped column names.');
  var combined = dmvChatCombine_(
    session,
    {
      sources: members.map(function (dataset) {
        return {
          resultId: fetched[dataset.id],
          label: dataset.label,
          columns: dataset.mapping
            .filter(function (entry) {
              return shared.some(function (other) {
                return other.key === entry.key;
              });
            })
            .map(function (entry) {
              return { from: entry.field, to: entry.key };
            }),
        };
      }),
    },
    1
  );
  return (memo[key] = combined.resultId);
}

// Money in several currencies is never added together: the tile splits by currency instead of
// failing, because a refresh has no model to repair the plan.
function dmvDashboardSummarize_(session, resultId, spec) {
  function run(input) {
    var described = dmvChatSummarize_(session, Object.assign({ resultId: resultId }, input));
    return dmvChatResult_(session, described.resultId);
  }
  try {
    return run(spec);
  } catch (error) {
    var column = (dmvChatResult_(session, resultId).metadata || {}).currencyColumn;
    if (!column || !/different currencies|Include currency/.test(error.message)) throw error;
    var retry = Object.assign({}, spec, { groupBy: (spec.groupBy || []).concat([column]) });
    if (spec.rankWithin) retry.rankWithin = spec.rankWithin.concat([column]);
    return run(retry);
  }
}

// Mapped columns are named by their keys ("campaign_name"); headers read better capitalized.
function dmvDashboardLabel_(value) {
  var text = String(value === null || value === undefined ? '' : value);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// One scorecard per metric or ratio, split by currency when the money is mixed. A compare tile
// groups by source: the current dataset's rows become the cards, the previous dataset's rows
// with the same currency supply the change.
function dmvDashboardCards_(session, resultId, tile, datasets) {
  var cards = [];
  var compare = null;
  if (tile.compare)
    compare = ['current', 'previous'].reduce(function (labels, side) {
      labels[side] = datasets.filter(function (dataset) {
        return dataset.id === tile.compare[side];
      })[0].label;
      return labels;
    }, {});
  tile.metrics
    .map(function (metric) {
      return { metrics: [metric] };
    })
    .concat(
      (tile.ratios || []).map(function (ratio) {
        return { metrics: [], ratios: [ratio] };
      })
    )
    .forEach(function (spec) {
      var summary = dmvDashboardSummarize_(
        session,
        resultId,
        Object.assign(
          { filters: tile.filters, limit: 50, groupBy: compare ? ['source'] : [] },
          spec
        )
      );
      var value = summary.columns[summary.columns.length - 1];
      var splits = summary.columns.slice(compare ? 1 : 0, -1);
      var splitOf = function (row) {
        return splits
          .map(function (column) {
            return row[column.key];
          })
          .join(' · ');
      };
      // Money always names its currency, so neither a reader nor the chat has to guess it.
      var single = value.type === 'currency' ? (summary.metadata || {}).currency : '';
      var previous = Object.create(null);
      summary.rows.forEach(function (row) {
        if (compare && row.source === compare.previous) previous[splitOf(row)] = row[value.key];
      });
      summary.rows.forEach(function (row) {
        if (compare && row.source !== compare.current) return;
        var split = splits.length ? ' (' + splitOf(row) + ')' : single ? ' (' + single + ')' : '';
        var card = {
          label: dmvDashboardLabel_(value.label) + split,
          value: row[value.key] === null || row[value.key] === undefined ? '' : row[value.key],
          type: value.type,
        };
        if (compare)
          card.previous = previous[splitOf(row)] === undefined ? null : previous[splitOf(row)];
        cards.push(card);
      });
    });
  return cards;
}

function dmvDashboardChange_(card) {
  var current = Number(card.value),
    previous = Number(card.previous);
  if (card.previous === null || card.value === '' || !isFinite(current) || !isFinite(previous))
    return 'no previous value';
  if (!previous) return 'previous 0';
  var percent = Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
  return (percent > 0 ? '+' : '') + percent + '% vs ' + previous.toLocaleString();
}

// A chart reads a wide table: the axis column, then one column per series.
function dmvDashboardChartTable_(session, resultId, tile) {
  var base = dmvChatResult_(session, resultId);
  var axis = dmvChatColumn_(base, tile.groupBy[0], 'groupBy column');
  var summary = dmvDashboardSummarize_(session, resultId, {
    groupBy: tile.groupBy,
    dateBucket: tile.dateBucket,
    metrics: tile.metrics,
    ratios: tile.ratios,
    filters: tile.filters,
    limit: DMV_LIMITS.maxRows,
  });
  var dimensions = summary.columns.filter(function (column) {
    return column.role === 'dimension';
  });
  var values = summary.columns.filter(function (column) {
    return column.role !== 'dimension';
  });
  var splits = dimensions.slice(1);
  var series = [],
    seriesByName = Object.create(null),
    points = [],
    pointByKey = Object.create(null);
  summary.rows.forEach(function (row) {
    var x = row[dimensions[0].key];
    x = x === null || x === undefined ? '' : x;
    var point = pointByKey[JSON.stringify(x)];
    if (!point) {
      point = pointByKey[JSON.stringify(x)] = { x: x, values: Object.create(null), total: 0 };
      points.push(point);
    }
    var split = splits
      .map(function (column) {
        return String(row[column.key] === null ? '' : row[column.key]);
      })
      .join(' · ');
    values.forEach(function (column) {
      var label = String(column.label || column.key);
      var name = !split ? label : values.length > 1 ? label + ' · ' + split : split;
      if (!seriesByName[name]) {
        seriesByName[name] = {
          name: name,
          type: column.type,
          total: 0,
          right: (tile.secondaryAxis || []).indexOf(column.key.split('__')[0]) >= 0,
        };
        series.push(seriesByName[name]);
      }
      var number = Number(row[column.key]);
      point.values[name] = row[column.key];
      if (isFinite(number)) {
        seriesByName[name].total += Math.abs(number);
        point.total += Math.abs(number);
      }
    });
  });
  var note = '';
  if (series.length > DMV_DASHBOARD.maxSeries) {
    note = 'top ' + DMV_DASHBOARD.maxSeries + ' of ' + series.length + ' series';
    series = series
      .slice()
      .sort(function (a, b) {
        return b.total - a.total;
      })
      .slice(0, DMV_DASHBOARD.maxSeries);
  }
  var dated = axis.type === 'date';
  var ascending = tile.orderBy && tile.orderBy.direction === 'asc' ? 1 : -1;
  points.sort(function (a, b) {
    if (dated) return a.x < b.x ? -1 : a.x > b.x ? 1 : 0;
    return (a.total - b.total) * ascending;
  });
  var limit = tile.limit || (dated ? DMV_DASHBOARD.datePoints : DMV_DASHBOARD.categoryPoints);
  if (points.length > limit) {
    note =
      (note ? note + ', ' : '') + (dated ? 'latest ' : 'top ') + limit + ' of ' + points.length;
    points = dated ? points.slice(points.length - limit) : points.slice(0, limit);
  }
  var columns = [
    { key: 'x', label: dimensions[0].label, type: dimensions[0].type === 'date' ? 'date' : 'text' },
  ].concat(
    series.map(function (item) {
      return { key: item.name, label: item.name, type: item.type };
    })
  );
  var matrix = [
    columns.map(function (column) {
      return dmvDashboardLabel_(column.label);
    }),
  ].concat(
    points.map(function (point) {
      return [point.x].concat(
        series.map(function (item) {
          var value = point.values[item.name];
          return value === null || value === undefined ? '' : value;
        })
      );
    })
  );
  if (matrix.length < 2) throw new Error('"' + tile.title + '" has no rows to chart.');
  return {
    columns: columns,
    matrix: matrix,
    note: note,
    right: series.map(function (item) {
      return item.right;
    }),
    stacked: !!tile.stacked,
    full: tile.width === 'full',
  };
}

function dmvDashboardTable_(session, resultId, tile) {
  var spec = {
    groupBy: tile.groupBy,
    dateBucket: tile.dateBucket,
    metrics: tile.metrics,
    limit: tile.limit || DMV_DASHBOARD.tableRows,
  };
  ['orderBy', 'rankWithin', 'limitPerGroup', 'ratios', 'filters'].forEach(function (key) {
    if (tile[key] !== undefined) spec[key] = tile[key];
  });
  var summary = dmvDashboardSummarize_(session, resultId, spec);
  var normalized = dmvNormalizeResult_(summary, DMV_DASHBOARD.maxTableRows);
  var metadata = summary.metadata || {};
  normalized.matrix[0] = normalized.matrix[0].map(dmvDashboardLabel_);
  return {
    columns: normalized.columns,
    matrix: normalized.matrix,
    note:
      metadata.rankedGroups > summary.rows.length ||
      (!metadata.ranking && metadata.totalGroups > summary.rows.length)
        ? 'top ' + summary.rows.length + ' of ' + (metadata.rankedGroups || metadata.totalGroups)
        : '',
  };
}

// The tab that holds the numbers behind the charts. It is created hidden: a refresh can then
// return any number of rows without moving anything on the dashboard itself.
function dmvDashboardChartTab_(target) {
  return target.sheetName.slice(0, 86) + ' (chart data)';
}

// The dashboard tab is one owned page: title, scorecards, a band reserved for the charts, the
// data sources, then the table tiles. The table behind each chart goes to the chart data tab.
function dmvDashboardPage_(dashboard, stamp, cards, blocks, sources) {
  cards = cards.slice(0, DMV_DASHBOARD.maxKpis);
  var width = Math.max(
    7,
    cards.length,
    Math.max.apply(
      null,
      blocks
        .filter(function (block) {
          return !block.chart;
        })
        .map(function (block) {
          return block.columns.length;
        })
        .concat([0])
    )
  );
  var data = { matrix: [], tables: [], styles: [] };
  data.width = Math.max.apply(
    null,
    blocks
      .filter(function (block) {
        return block.chart;
      })
      .map(function (block) {
        return block.columns.length;
      })
  );
  var matrix = [],
    tables = [],
    styles = [],
    charts = [];
  function push(row) {
    matrix.push(dmvDashboardPad_(row, width));
    return matrix.length - 1;
  }
  styles.push({ row: push([dashboard.name]), style: 'title' });
  styles.push({
    row: push([
      'Refreshed ' +
        stamp +
        ' · DataMoov > Reports > Dashboards > Refresh dashboard updates every tab and chart',
    ]),
    style: 'muted',
  });
  push([]);
  if (cards.length) {
    styles.push({
      row: push(
        cards.map(function (card) {
          return card.label;
        })
      ),
      columns: cards.length,
      style: 'kpiLabel',
    });
    var valueRow = push(
      cards.map(function (card) {
        return card.value;
      })
    );
    cards.forEach(function (card, index) {
      styles.push({ row: valueRow, column: index, style: 'kpiValue', type: card.type });
    });
    if (
      cards.some(function (card) {
        return card.previous !== undefined;
      })
    )
      styles.push({
        row: push(
          cards.map(function (card) {
            return card.previous === undefined ? '' : dmvDashboardChange_(card);
          })
        ),
        columns: cards.length,
        style: 'muted',
      });
    push([]);
  }
  // Charts sit two per band row; a full-width chart takes a band row of its own.
  var chartTop = matrix.length,
    slot = 0,
    band = 0;
  var places = blocks
    .filter(function (block) {
      return block.chart;
    })
    .map(function (block) {
      var span = block.full ? DMV_DASHBOARD.chartsPerRow : 1;
      if (slot + span > DMV_DASHBOARD.chartsPerRow) {
        band++;
        slot = 0;
      }
      var place = {
        row: chartTop + band * DMV_DASHBOARD.chartBandRows,
        column: slot * DMV_DASHBOARD.chartColumnSpan,
        width:
          DMV_DASHBOARD.chartWidth +
          (span - 1) * DMV_DASHBOARD.chartColumnSpan * DMV_DASHBOARD.columnWidth,
      };
      slot += span;
      if (slot >= DMV_DASHBOARD.chartsPerRow) {
        band++;
        slot = 0;
      }
      return place;
    });
  var bandRows = (band + (slot ? 1 : 0)) * DMV_DASHBOARD.chartBandRows;
  for (var i = 0; i < bandRows; i++) push([]);
  styles.push({ row: push(['Data sources']), style: 'section' });
  tables.push({
    row: push(['Dataset', 'Source', 'Connection', 'Report', 'Date range', 'Rows', 'Tab']),
    rows: sources.length + 1,
    columns: ['text', 'text', 'text', 'text', 'text', 'number', 'text'].map(function (type) {
      return { type: type };
    }),
  });
  sources.forEach(push);
  blocks.forEach(function (block) {
    var title = block.title + (block.note ? ' (' + block.note + ')' : '');
    if (!block.chart) {
      push([]);
      styles.push({ row: push([title]), style: 'section' });
      tables.push({ row: matrix.length, rows: block.matrix.length, columns: block.columns });
      block.matrix.forEach(push);
      return;
    }
    if (data.matrix.length) data.matrix.push(dmvDashboardPad_([], data.width));
    data.styles.push({ row: data.matrix.length, style: 'section' });
    data.matrix.push(dmvDashboardPad_([title], data.width));
    var top = data.matrix.length;
    block.matrix.forEach(function (row) {
      data.matrix.push(dmvDashboardPad_(row, data.width));
    });
    data.tables.push({ row: top, rows: block.matrix.length, columns: block.columns });
    var place = places[charts.length];
    charts.push({
      type: block.type,
      title: block.title,
      row: top,
      rows: block.matrix.length,
      columns: block.columns.length,
      right: block.right,
      stacked: block.stacked,
      anchorRow: place.row,
      anchorColumn: place.column,
      width: place.width,
    });
  });
  return {
    matrix: matrix,
    layout: { tables: tables, styles: styles },
    data: { matrix: data.matrix, layout: { tables: data.tables, styles: data.styles } },
    charts: charts,
    width: width,
  };
}

function dmvDashboardChartSpec_(chart, source) {
  function column(offset, skipHeader) {
    return {
      sourceRange: {
        sources: [
          {
            sheetId: source.sheetId,
            startRowIndex: source.row - 1 + chart.row + (skipHeader ? 1 : 0),
            endRowIndex: source.row - 1 + chart.row + chart.rows,
            startColumnIndex: source.column - 1 + offset,
            endColumnIndex: source.column + offset,
          },
        ],
      },
    };
  }
  var spec = { title: chart.title };
  if (chart.type === 'pie')
    spec.pieChart = {
      legendPosition: 'RIGHT_LEGEND',
      domain: column(0, true),
      series: column(1, true),
    };
  else {
    var series = [];
    // Sheets draws a bar chart sideways and rejects bar series on any axis but the bottom one.
    var axis = chart.type === 'bar' ? 'BOTTOM_AXIS' : 'LEFT_AXIS';
    var combo = chart.type === 'column' && (chart.right || []).some(Boolean);
    for (var offset = 1; offset < chart.columns; offset++) {
      var right = !!(chart.right && chart.right[offset - 1]);
      var item = { series: column(offset, false), targetAxis: right ? 'RIGHT_AXIS' : axis };
      if (combo) item.type = right ? 'LINE' : 'COLUMN';
      series.push(item);
    }
    spec.basicChart = {
      chartType: combo ? 'COMBO' : DMV_CHART_TYPES[chart.type],
      legendPosition: series.length > 1 ? 'BOTTOM_LEGEND' : 'NO_LEGEND',
      headerCount: 1,
      domains: [{ domain: column(0, false) }],
      series: series,
    };
    if (chart.stacked) spec.basicChart.stackedType = 'STACKED';
  }
  return spec;
}

// Charts the dashboard created earlier are updated in place, which keeps a position or size
// the user adjusted; missing ones are added and surplus ones removed, all in the write batch.
// The runtime chooses the ids of new charts itself (outcome.chartIds) so the caller can record
// them before the batch is sent: a retry after an interrupted refresh then finds its charts
// instead of stacking a second set on top.
function dmvDashboardChartRequests_(spreadsheetId, charts, area, source, width, savedIds, outcome) {
  var response = Sheets.Spreadsheets.get(spreadsheetId, {
    fields: 'sheets(properties.sheetId,charts.chartId)',
  });
  var sheet = null,
    sourceExists = false,
    existing = Object.create(null),
    taken = Object.create(null);
  ((response && response.sheets) || []).forEach(function (item) {
    var here = item.properties && item.properties.sheetId === area.sheetId;
    if (here) sheet = item;
    if (item.properties && item.properties.sheetId === source.sheetId) sourceExists = true;
    (item.charts || []).forEach(function (chart) {
      taken[chart.chartId] = true;
      if (here) existing[chart.chartId] = true;
    });
  });
  var requests = [];
  outcome.chartIds = [];
  function add(request) {
    requests.push(request);
  }
  if (!sheet) {
    add({
      updateDimensionProperties: {
        range: {
          sheetId: area.sheetId,
          dimension: 'COLUMNS',
          startIndex: area.column - 1,
          endIndex: area.column - 1 + width,
        },
        properties: { pixelSize: DMV_DASHBOARD.columnWidth },
        fields: 'pixelSize',
      },
    });
    add({
      updateSheetProperties: {
        properties: { sheetId: area.sheetId, gridProperties: { hideGridlines: true } },
        fields: 'gridProperties.hideGridlines',
      },
    });
  }
  // Hidden only when first created, so a tab the user chose to show stays shown.
  if (!sourceExists)
    add({
      updateSheetProperties: {
        properties: { sheetId: source.sheetId, hidden: true },
        fields: 'hidden',
      },
    });
  charts.forEach(function (chart, index) {
    var spec = dmvDashboardChartSpec_(chart, source);
    var saved = savedIds[index];
    if (saved !== undefined && saved !== null && existing[saved]) {
      outcome.chartIds[index] = saved;
      add({ updateChartSpec: { chartId: saved, spec: spec } });
      return;
    }
    var chartId;
    do chartId = parseInt(dmvOutputDigest_(Utilities.getUuid()).slice(0, 7), 16);
    while (taken[chartId]);
    taken[chartId] = true;
    outcome.chartIds[index] = chartId;
    add({
      addChart: {
        chart: {
          chartId: chartId,
          spec: spec,
          position: {
            overlayPosition: {
              anchorCell: {
                sheetId: area.sheetId,
                rowIndex: area.row - 1 + chart.anchorRow,
                columnIndex: area.column - 1 + chart.anchorColumn,
              },
              widthPixels: chart.width,
              heightPixels: DMV_DASHBOARD.chartHeight,
            },
          },
        },
      },
    });
  });
  savedIds.slice(charts.length).forEach(function (saved) {
    if (saved !== undefined && saved !== null && existing[saved])
      add({ deleteEmbeddedObject: { objectId: saved } });
  });
  return requests;
}

function dmvRunDashboard(id, requestedDeadline) {
  if (
    requestedDeadline !== undefined &&
    (typeof requestedDeadline !== 'number' || !Number.isFinite(requestedDeadline))
  )
    throw new Error('Use a valid dashboard deadline.');
  var spreadsheet = dmvSpreadsheet_(),
    deadline = Math.min(
      Date.now() + 200000,
      requestedDeadline === undefined ? Infinity : requestedDeadline
    ),
    token = dmvId_(),
    rowCap = dmvAiRowCap_(),
    revisions = {},
    queries = [],
    dates = [],
    plan,
    timezone = spreadsheet.getSpreadsheetTimeZone(),
    today = Utilities.formatDate(new Date(), timezone, 'yyyy-MM-dd');
  dmvDashboardDeadline_(deadline);
  var dashboard = dmvLocked_(function () {
    var current = dmvDashboardHere_(id);
    if (current.runToken && Date.now() - current.startedAt < 300000)
      throw new Error('This dashboard is already refreshing.');
    var saved = dmvDashboardPlan_(current);
    plan = dmvValidateDashboard_(
      {
        name: current.name,
        datasets: saved.datasets,
        tiles: saved.tiles,
        target: { sheetName: current.target.sheetName },
      },
      spreadsheet
    );
    queries = plan.datasets.map(function (dataset, index) {
      revisions[dataset.connectionId] = dmvConnectionRevision_(
        dmvReadConnection_(dataset.connectionId)
      );
      var query = dmvValidateQuery_(dataset, spreadsheet);
      // Reports fail instead of truncating, so a limit raised in Settings after this plan
      // was saved must apply here; the combined DMV_LIMITS.maxRows ceiling still holds.
      query.maxRows = Math.max(dataset.maxRows, rowCap);
      var definition = dmvDefinition_(dmvConnector_(query.connectorId), query.reportType);
      // One refresh has one date anchor, even if sequential fetches cross midnight.
      // Only these execution queries become fixed; the saved relative presets remain reusable.
      dates[index] = definition.dateRange ? dmvDateRange_(query.dateRange, today) : null;
      if (dates[index]) query.dateRange = Object.assign({ preset: 'custom' }, dates[index]);
      return query;
    });
    current.status = 'running';
    current.statusMessage = 'Preparing datasets';
    current.runToken = token;
    current.startedAt = Date.now();
    current.lastError = '';
    return dmvSave_('dashboard', current);
  });
  var fingerprint = dmvDashboardFingerprint_(dashboard);
  function currentRun() {
    dmvDashboardDeadline_(deadline);
    var current = dmvDashboardHere_(id);
    if (
      current.runToken !== token ||
      current.revision !== dashboard.revision ||
      dmvDashboardFingerprint_(current) !== fingerprint
    )
      throw new Error('The dashboard changed during this refresh. Run it again.');
    return current;
  }
  function phase(message) {
    dmvLocked_(function () {
      var current = currentRun();
      current.statusMessage = message;
      dmvSave_('dashboard', current);
    });
  }
  var sheetUpdated = false;
  try {
    var session = dmvChatSession_(spreadsheet);
    session.deadline = deadline;
    // Refresh inputs are not follow-up material for a chat turn, so they skip the result cache.
    session.transient = true;
    var stamp =
      Utilities.formatDate(new Date(), timezone, 'yyyy-MM-dd HH:mm') + ' (' + timezone + ')';
    var fetched = {},
      fetchedRows = 0,
      outputs = [],
      sources = [],
      counts = {};
    plan.datasets.forEach(function (dataset, index) {
      phase(
        'Fetching dataset ' + (index + 1) + ' of ' + plan.datasets.length + ': ' + dataset.label
      );
      var result;
      try {
        result = dmvFetchReport_(queries[index], spreadsheet, deadline);
      } catch (error) {
        var reason = dmvSafeError_(error, {});
        if (/row limit|too many rows|more than .*rows/i.test(reason))
          reason +=
            ' This dataset allows ' +
            queries[index].maxRows.toLocaleString() +
            ' rows. Increase Maximum rows per chat report under Settings > AI provider (up to ' +
            DMV_LIMITS.maxRows.toLocaleString() +
            '), or ask Chat to narrow this dataset.';
        throw new Error(dataset.label + ': ' + reason);
      }
      dmvDashboardDeadline_(deadline);
      fetchedRows += result.rows.length;
      if (fetchedRows > DMV_LIMITS.maxRows)
        throw new Error(
          'The dashboard datasets exceed ' +
            DMV_LIMITS.maxRows.toLocaleString() +
            ' rows together. Narrow them.'
        );
      var resultId = dmvChatResultId_();
      session.results[resultId] = result;
      fetched[dataset.id] = resultId;
      counts[dataset.id] = result.rows.length;
      var connector = dmvConnector_(dataset.connectorId);
      var provenance = [
        dataset.label,
        connector.label,
        dmvReadConnection_(dataset.connectionId).label,
        dmvDefinition_(connector, dataset.reportType).label,
        // A custom query without metrics (negative keywords, settings) reports no period.
        dates[index] && (result.metadata || {}).dateFiltered !== false
          ? dates[index].startDate + ' to ' + dates[index].endDate
          : 'No date range',
        result.rows.length,
        dataset.sheetName,
      ];
      sources.push(provenance);
      var width = result.columns.length;
      outputs.push({
        report: {
          id: dmvDashboardOutputId_(dashboard, dataset),
          spreadsheetId: spreadsheet.getId(),
          target: { sheetName: dataset.sheetName, startCell: 'A1' },
        },
        result: {
          columns: result.columns,
          matrix: [
            dmvDashboardPad_([provenance.slice(0, 4).join(' · ')], width),
            dmvDashboardPad_(
              [
                provenance[4] +
                  ' · ' +
                  result.rows.length.toLocaleString() +
                  ' rows · Refreshed ' +
                  stamp +
                  ' · Dashboard: ' +
                  dashboard.name,
              ],
              width
            ),
            dmvDashboardPad_([], width),
          ].concat(result.matrix),
          layout: {
            tables: [{ row: 3, rows: result.matrix.length, columns: result.columns }],
            styles: [
              { row: 0, style: 'section' },
              { row: 1, style: 'muted' },
            ],
          },
        },
      });
    });
    phase('Building scorecards, charts and tables');
    var memo = {},
      cards = [],
      blocks = [];
    plan.tiles.forEach(function (tile) {
      var input = dmvDashboardInput_(session, plan.datasets, tile, fetched, memo);
      if (tile.type === 'kpi') {
        cards = cards.concat(dmvDashboardCards_(session, input, tile, plan.datasets));
        return;
      }
      var chart = dmvDashboardIsChart_(tile);
      var block = chart
        ? dmvDashboardChartTable_(session, input, tile)
        : dmvDashboardTable_(session, input, tile);
      block.title = tile.title;
      block.type = tile.type;
      block.chart = chart;
      blocks.push(block);
      dmvDashboardDeadline_(deadline);
    });
    var page = dmvDashboardPage_(dashboard, stamp, cards, blocks, sources);
    if (JSON.stringify(page.matrix).length > DMV_LIMITS.maxBytes)
      throw new Error('The dashboard tab is too large. Use fewer or smaller tiles.');
    outputs.push({
      report: {
        id: dashboard.id + '-charts',
        spreadsheetId: spreadsheet.getId(),
        target: { sheetName: dmvDashboardChartTab_(dashboard.target), startCell: 'A1' },
      },
      result: { columns: [], matrix: page.data.matrix, layout: page.data.layout },
    });
    outputs.push({
      report: {
        id: dashboard.id + '-report',
        spreadsheetId: spreadsheet.getId(),
        target: dashboard.target,
      },
      result: { columns: [], matrix: page.matrix, layout: page.layout },
    });
    phase('Updating ' + (outputs.length - 1) + ' tabs and ' + page.charts.length + ' charts');
    return dmvLocked_(function () {
      var current = currentRun();
      function check() {
        currentRun();
        Object.keys(revisions).forEach(function (connectionId) {
          if (dmvConnectionRevision_(dmvReadConnection_(connectionId)) !== revisions[connectionId])
            throw new Error(
              'A source connection changed during the dashboard refresh. Run it again.'
            );
        });
      }
      check();
      var outcome = {};
      dmvWriteReports_(
        spreadsheet,
        outputs,
        function () {
          check();
          // Recorded before the batch is sent, so an interrupted refresh still knows its charts.
          current.chartIds = outcome.chartIds;
          dmvSave_('dashboard', current);
        },
        function (areas) {
          return dmvDashboardChartRequests_(
            spreadsheet.getId(),
            page.charts,
            areas[areas.length - 1],
            areas[areas.length - 2],
            page.width,
            current.chartIds || [],
            outcome
          );
        }
      );
      sheetUpdated = true;
      // Every destination may be a new tab; links need a spreadsheet that can see them.
      spreadsheet = dmvReopen_(spreadsheet);
      current.status = 'success';
      current.statusMessage =
        'Updated ' + plan.datasets.length + ' data tabs and ' + page.charts.length + ' charts';
      current.lastRun = new Date().toISOString();
      current.lastRowCount = fetchedRows;
      current.outputs.forEach(function (output) {
        output.rows = counts[output.id];
      });
      current.lastError = '';
      current.runToken = null;
      dmvSave_('dashboard', current);
      return {
        ok: true,
        id: id,
        name: current.name,
        updatedAt: current.lastRun,
        target: current.target,
        reportUrl: dmvSheetLink_(spreadsheet, current.target),
        datasets: current.outputs.map(function (output) {
          return {
            id: output.id,
            label: output.label,
            sheetName: output.sheetName,
            rowCount: output.rows,
            url: dmvSheetLink_(spreadsheet, { sheetName: output.sheetName, startCell: 'A1' }),
          };
        }),
        rowCount: fetchedRows,
        chartCount: page.charts.length,
        scorecards: cards.slice(0, DMV_DASHBOARD.maxKpis).map(function (card) {
          var item = { label: card.label, value: card.value };
          if (card.previous !== undefined) {
            item.previous = card.previous;
            item.change = dmvDashboardChange_(card);
          }
          return item;
        }),
        tiles: blocks.map(function (block) {
          return {
            title: block.title,
            type: block.type,
            rows: block.matrix.length - 1,
            note: block.note || undefined,
          };
        }),
        links: dmvDashboardLinks_(spreadsheet, current),
      };
    });
  } catch (error) {
    sheetUpdated = sheetUpdated || !!error.sheetUpdated;
    var message = sheetUpdated
      ? error.sheetUpdated
        ? dmvSafeError_(error, {})
        : 'The dashboard tabs were updated, but dashboard completion could not be saved. Refresh again to retry safely.'
      : dmvSafeError_(error, {});
    try {
      dmvLocked_(function () {
        var current = dmvRead_('dashboard', id);
        if (current.runToken === token) {
          current.status = 'error';
          current.statusMessage = sheetUpdated
            ? 'Tabs updated; completion needs recovery'
            : 'Refresh stopped';
          current.lastError = message;
          current.runToken = null;
          dmvSave_('dashboard', current);
        }
      });
    } catch (ignored) {
      /* Preserve the actual outcome if private state is temporarily unavailable. */
    }
    var failure = new Error(message);
    if (sheetUpdated) {
      // The commit happened; its tabs may be new, so links need a spreadsheet that sees them.
      failure.sheetUpdated = true;
      failure.id = dashboard.id;
      failure.links = dmvDashboardLinks_(dmvReopen_(spreadsheet), dashboard);
    }
    throw failure;
  }
}

function dmvDashboardFingerprint_(dashboard) {
  return dmvOutputDigest_(
    dmvCanonical_({
      name: dashboard.name,
      spreadsheetId: dashboard.spreadsheetId,
      plan: dashboard.plan,
      target: dashboard.target,
    })
  );
}
