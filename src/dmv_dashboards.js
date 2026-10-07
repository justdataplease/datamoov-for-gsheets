/* Dashboards: several datasets, each refreshed into its own tab, plus one dashboard tab with
   scorecards, native charts and their supporting tables. Plans stay private to their owner and
   workbook. This file validates plans (calculated metrics and period pairs included) and saves,
   lists, deletes, schedules and keeps them; dmv_dashboard_run.js refreshes them. */
var DMV_DASHBOARD = {
  maxDatasets: 8,
  maxTiles: 12,
  maxKpis: 8,
  maxSeries: 12,
  maxRules: 4,
  maxPolarity: 20,
  chartTypes: ['line', 'column', 'bar', 'area', 'pie', 'scatter'],
  // The page grid: a margin, twelve content columns with a gap column between each two, and a
  // margin; only a wide table adds more. Gaps between cards stay page colour.
  gridColumns: 12,
  columnWidth: 88,
  gapWidth: 16,
  gutterWidth: 20,
  // One inset for text inside cards and the band.
  inset: 14,
  chartHeight: 300,
  labelPoints: 15,
  tableRows: 50,
  maxTableRows: 1000,
  datePoints: 400,
  categoryPoints: 15,
  highlights: 6,
  barBlocks: 15,
  previewRows: 5,
  previewColumns: 8,
  previewChars: 40,
  previewTileChars: 1200,
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

// The values of a tile as its rules name them: each by the name it is saved under (a metric's
// field, a ratio or formula key), which a metric's key (field__agg) also names.
function dmvDashboardValueNames_(metrics, ratios, formulas) {
  return metrics
    .map(function (metric) {
      return { name: metric.field, names: [metric.field, metric.field + '__' + metric.agg] };
    })
    .concat(
      ratios.concat(formulas).map(function (item) {
        return { name: item.key, names: [item.key] };
      })
    );
}

// The entry ({ name, names }) a name means (dmvNameMatches_); entries saved under one name
// count once. Without a subject, null when it means none or several; with one, an error that
// says which and names the valid entries.
function dmvDashboardPick_(name, entries, subject, unknown) {
  var distinct = [];
  var found = dmvNameMatches_(name, entries, function (entry) {
    return entry.names;
  }).filter(function (entry) {
    if (distinct.indexOf(entry.name) >= 0) return false;
    distinct.push(entry.name);
    return true;
  });
  if (found.length === 1) return found[0];
  if (subject === undefined) return null;
  var valid = [];
  entries.forEach(function (entry) {
    if (valid.indexOf(entry.name) < 0) valid.push(entry.name);
  });
  throw new Error(
    subject +
      (found.length ? ' could be any of ' + distinct.join(', ') + '.' : unknown) +
      ' Name one of: ' +
      valid.join(', ') +
      '.'
  );
}

// What a name that is no column of a tile most likely meant, after the columns an error lists,
// or ''. A metric's key (column__agg) names its column and agg apart; a bare count counts rows.
function dmvDashboardKeyHint_(name, columns) {
  var text = String(name),
    shown = function (column) {
      return column.label || column.key;
    };
  var parts = /^(.+?)__(sum|avg|min|max|count_distinct|count)$/i.exec(text);
  var stem =
    parts &&
    dmvNameMatches_(parts[1], columns, function (column) {
      return [column.key, column.label];
    });
  if (stem && stem.length === 1) {
    var agg = parts[2].toLowerCase();
    // A ratio may divide by a count (dmvChatRatioSide_); a formula sums its columns.
    return (
      '. "' +
      text.slice(0, 80) +
      '" is ' +
      shown(stem[0]) +
      ' with agg ' +
      agg +
      (agg === 'count' || agg === 'count_distinct'
        ? ': a metric names the column and its agg apart, a formula sums its columns itself, and a ratio may divide by ' +
          text.slice(0, 80) +
          '.'
        : ': a metric names the column and its agg apart, and ratios and formulas sum their columns themselves.')
    );
  }
  if (dmvLooseName_(text) === 'count' && columns.length)
    return (
      '. No column is named count: count rows with a metric such as {field: "' +
      shown(columns[0]) +
      '", agg: "count"}.'
    );
  return '';
}

// The type of a tile column by the report's declared fields, or null for a field that is only
// discovered at refresh, where compared tables and charts check again. source and currency,
// the columns a mapping adds, are text.
function dmvDashboardFieldType_(dataset, name) {
  var field = name;
  if (dataset.mapping) {
    var entry = dataset.mapping.filter(function (item) {
      return item.key === name;
    })[0];
    if (!entry) return name === 'source' || name === 'currency' ? 'text' : null;
    field = entry.field;
  }
  var found = dmvDashboardDeclaredField_(dataset, field);
  return found ? found.type || 'text' : null;
}

// The fields a dataset's report declares; a report that discovers its fields declares none.
function dmvDashboardDeclared_(dataset) {
  if (dmvDashboardIsTab_(dataset)) return dataset.tabFields || [];
  var fields = dmvDefinition_(dmvConnector_(dataset.connectorId), dataset.reportType).fields;
  return (Array.isArray(fields) ? fields : []).filter(function (item) {
    return !!item && typeof item.key === 'string';
  });
}

// A declared field by key; a tab's columns also by header, without regard to case.
function dmvDashboardDeclaredField_(dataset, name) {
  if (dmvDashboardIsTab_(dataset))
    return dmvDashboardTabField_(dmvDashboardDeclared_(dataset), name);
  return dmvDashboardDeclared_(dataset).filter(function (item) {
    return item.key === name;
  })[0];
}

function dmvDashboardDated_(dataset, name) {
  return dmvDashboardFieldType_(dataset, name) === 'date';
}

// Presets that name the period before another one: their datasets hold a previous period.
var DMV_DASHBOARD_PREVIOUS = [
  'previous7',
  'previous14',
  'previous30',
  'previous90',
  'previousWeek',
  'previousMonth',
];

function dmvDashboardIsChart_(tile) {
  return DMV_DASHBOARD.chartTypes.indexOf(tile.type) >= 0;
}

// A compare side names one dataset id or a list of them (every account of that period).
function dmvDashboardIds_(side) {
  return typeof side === 'string' ? [side] : side.slice();
}

// stored is set when a refresh validates a plan saved earlier: what a save now refuses but an
// older version accepted is repaired instead, so a scheduled refresh keeps running.
function dmvValidateDashboard_(input, spreadsheet, stored) {
  dmvDashboardObject_(input, [
    'id',
    'revision',
    'name',
    'datasets',
    'tiles',
    'target',
    'schedule',
    'at',
    'draft',
    'origin',
    'lowerIsBetter',
    'neutral',
  ]);
  if (
    !Array.isArray(input.datasets) ||
    !input.datasets.length ||
    input.datasets.length > DMV_DASHBOARD.maxDatasets
  )
    throw new Error('Choose between one and eight dashboard datasets.');
  dmvDashboardObject_(input.target, ['sheetName']);
  var target = { sheetName: dmvSheetName_(input.target.sheetName), startCell: 'A1' };
  var ids = Object.create(null),
    labels = Object.create(null),
    tabs = Object.create(null),
    queries = Object.create(null),
    // The tab datasets, checked against the tabs dashboards write once those are known.
    read = [];
  var others = null;
  // A tab dataset reads a tab the user keeps: never one this dashboard or another one writes.
  function readable(sheetName) {
    var shown = String(sheetName).trim(),
      name = shown.toLowerCase();
    if (tabs[name])
      throw new Error(
        '"' +
          shown +
          '" is written by this dashboard, so a dataset cannot read it. Name the tab that holds the data.'
      );
    if (stored) return;
    others = others || dmvDashboardOutputTabs_(spreadsheet, input.id);
    if (others[name])
      throw new Error(
        '"' +
          shown +
          '" is output of the dashboard "' +
          others[name] +
          '". Read the tab or source its data comes from instead.'
      );
  }
  tabs[target.sheetName.toLowerCase()] = true;
  tabs[dmvDashboardChartTab_(target).toLowerCase()] = true;
  var datasets = input.datasets.map(function (dataset, index) {
    dmvDashboardObject_(dataset, [
      'id',
      'label',
      'sheetName',
      'sourceSheet',
      'dateColumn',
      'connectorId',
      'connectionId',
      'reportType',
      'fields',
      'config',
      'dateRange',
      'maxRows',
      'mapping',
    ]);
    if (typeof dataset.sourceSheet === 'string') readable(dataset.sourceSheet);
    // A tab of this spreadsheet, read in place (dmv_dashboard_tabs.js), or a source query.
    var tabbed = dmvDashboardTabDataset_(dataset, spreadsheet, input.id);
    if (!tabbed && dataset.dateColumn !== undefined)
      throw new Error('dateColumn belongs to a dataset that reads a tab (sourceSheet).');
    if (!tabbed && dataset.connectionId === undefined)
      throw new Error(
        'Give each dataset a source query (connectionId) or a tab of this spreadsheet with data (sourceSheet).'
      );
    var query = tabbed || dmvValidateQuery_(dataset, spreadsheet);
    if (!tabbed)
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
    var validated;
    if (tabbed) {
      validated = Object.assign({ id: id, label: label }, tabbed);
      Object.defineProperty(validated, 'tabFields', { value: tabbed.tabFields, enumerable: false });
      read.push(validated);
    } else {
      var sheetName = dmvSheetName_(dataset.sheetName);
      if (tabs[sheetName.toLowerCase()])
        throw new Error('Give every dataset and the dashboard its own tab: ' + sheetName + '.');
      tabs[sheetName.toLowerCase()] = true;
      validated = Object.assign({}, query, { id: id, label: label, sheetName: sheetName });
    }
    var identityQuery = Object.assign({}, query, {
      fields: tabbed ? [] : query.fields.slice().sort(),
    });
    delete identityQuery.maxRows;
    var identity = JSON.stringify(dmvCanonical_(identityQuery));
    if (queries[identity])
      throw new Error('Do not include the same dataset query twice in a dashboard.');
    queries[identity] = true;
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
          (tabbed
            ? !dmvDashboardTabField_(tabbed.tabFields, entry.field)
            : query.fields.length && query.fields.indexOf(entry.field) < 0)
        )
          throw new Error(
            tabbed
              ? 'Map columns of ' +
                  tabbed.sourceSheet +
                  ' only: ' +
                  tabbed.tabFields.map(dmvDashboardFieldLabel_).join(', ') +
                  '.'
              : 'Map selected dataset fields only.'
          );
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
  // Checked again once every data tab of this dashboard is known.
  read.forEach(function (dataset) {
    readable(dataset.sourceSheet);
  });
  if (
    !Array.isArray(input.tiles) ||
    !input.tiles.length ||
    input.tiles.length > DMV_DASHBOARD.maxTiles
  )
    throw new Error('Choose between one and twelve dashboard tiles.');
  // Datasets of a previous period feed comparisons only: a tile that read them beside the
  // current period would add both periods up. They are the previous side of a compare, and
  // every dataset with a previous preset.
  var previousIds = Object.create(null);
  datasets.forEach(function (dataset) {
    if (dataset.dateRange && DMV_DASHBOARD_PREVIOUS.indexOf(dataset.dateRange.preset) >= 0)
      previousIds[dataset.id] = true;
  });
  input.tiles.forEach(function (tile) {
    var side = tile && tile.compare && tile.compare.previous;
    (typeof side === 'string' ? [side] : Array.isArray(side) ? side : []).forEach(function (id) {
      if (typeof id === 'string') previousIds[id] = true;
    });
  });
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
      'formulas',
      'compare',
      'highlight',
      'stacked',
      'secondaryAxis',
      'width',
    ]);
    var title = dmvText_(tile.title, 'Tile title', 120, true);
    var type = String(tile.type || '');
    if (['kpi', 'table'].concat(DMV_DASHBOARD.chartTypes).indexOf(type) < 0)
      throw new Error('Tile type must be kpi, table, ' + DMV_DASHBOARD.chartTypes.join(', ') + '.');
    var compared = tile.compare !== undefined;
    // Left out, a compared tile reads its compare lists and any other tile every dataset of the
    // current period.
    var named = [];
    if (compared && tile.compare && typeof tile.compare === 'object')
      ['current', 'previous'].forEach(function (side) {
        var value = tile.compare[side];
        (typeof value === 'string' ? [value] : Array.isArray(value) ? value : []).forEach(
          function (id) {
            if (typeof id === 'string' && ids[id] && named.indexOf(id) < 0) named.push(id);
          }
        );
      });
    var from =
      tile.datasets === undefined
        ? named.length
          ? named
          : Object.keys(ids).filter(function (id) {
              return compared || !previousIds[id];
            })
        : // A compare that names a dataset the list leaves out reads it too: it can mean nothing else.
          dmvDashboardNames_(tile.datasets, DMV_DASHBOARD.maxDatasets, 'tile datasets').concat(
            named.filter(function (id) {
              return tile.datasets.indexOf(id) < 0;
            })
          );
    if (
      !from.length ||
      from.some(function (id) {
        return !ids[id];
      })
    )
      throw new Error('"' + title + '": datasets must name dataset IDs of this dashboard.');
    var earlier = from.filter(function (id) {
      return previousIds[id];
    });
    if (!compared && earlier.length && earlier.length < from.length) {
      if (!stored)
        throw new Error(
          '"' +
            title +
            '": ' +
            earlier.join(', ') +
            ' hold the previous period of a comparison, and reading them with current datasets would add both periods together. Leave them out of this tile or give it a compare.'
        );
      from = from.filter(function (id) {
        return !previousIds[id];
      });
    }
    var members = datasets.filter(function (dataset) {
      return from.indexOf(dataset.id) >= 0;
    });
    var mapped = members.every(function (dataset) {
      return !!dataset.mapping;
    });
    // Two periods of one report or one tab, compared one against the other, share their columns
    // already: such a tile needs no mapping.
    var paired = !mapped && dmvDashboardPaired_(tile.compare, members);
    if (members.length > 1 && !mapped && !paired) {
      var unmapped = members.filter(function (dataset) {
        return !dataset.mapping;
      });
      var example = dmvDashboardDeclared_(unmapped[0])
        .slice(0, 3)
        .map(function (field) {
          return (
            '{field: "' +
            field.key +
            '", key: "' +
            (field.key
              .split('.')
              .pop()
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '_') || 'value') +
            '"}'
          );
        });
      throw new Error(
        '"' +
          title +
          '" reads several datasets, so each of them needs a mapping that gives their columns shared names; ' +
          unmapped
            .map(function (dataset) {
              return dataset.id;
            })
            .join(', ') +
          (unmapped.length === 1 ? ' has none' : ' have none') +
          '. Add mapping to each of ' +
          members
            .map(function (dataset) {
              return dataset.id;
            })
            .join(', ') +
          (example.length ? ', for example [' + example.join(', ') + ']' : '') +
          ', and name the mapped keys in the tiles; or let this tile read one dataset.'
      );
    }
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
    // A tile over one tab names its columns by header or key, as a refresh finds them.
    var tab =
      !allowed && (members.length === 1 || paired) && dmvDashboardIsTab_(members[0]) && members[0];
    // A mapped name is saved as its mapped key.
    function known(name) {
      if (allowed) {
        var mapped = dmvNameMatches_(name, allowed, function (key) {
          return [key];
        });
        if (mapped.length !== 1)
          throw new Error(
            '"' +
              title +
              '": unknown column "' +
              name +
              '". Mapped columns: ' +
              allowed.join(', ') +
              dmvDashboardKeyHint_(
                name,
                allowed.map(function (key) {
                  return { key: key, label: key };
                })
              )
          );
        return mapped[0];
      }
      if (tab && !dmvDashboardTabField_(tab.tabFields, name))
        throw new Error(
          '"' +
            title +
            '": unknown column "' +
            String(name).slice(0, 80) +
            '". Columns of ' +
            tab.sourceSheet +
            ': ' +
            tab.tabFields.map(dmvDashboardFieldLabel_).join(', ') +
            dmvDashboardKeyHint_(name, tab.tabFields)
        );
      return name;
    }
    // A ratio side: a column, or <column>__count or <column>__count_distinct (dmvChatRatioSide_),
    // saved as the known column and its count. distinctSides counts the distinct counts: a name
    // known as a column of its own is that column, summed; columns of an unmapped dataset are
    // only checked at refresh, so there a distinct-count name counts as the distinct count it
    // will read as when the column is missing.
    var distinctSides = 0;
    function side(name) {
      var parts = /^(.+?)__(count_distinct|count)$/i.exec(name);
      if (!parts) return known(name);
      var agg = parts[2].toLowerCase();
      var saved, counted;
      try {
        saved = known(name);
        counted = !allowed && !tab;
      } catch (ignored) {
        saved = known(parts[1]) + '__' + agg;
        counted = true;
      }
      if (counted && agg === 'count_distinct') distinctSides++;
      return saved;
    }
    // Checked again once mapped: two spellings of one column are the same column.
    var groupBy = dmvDashboardNames_(
      dmvDashboardNames_(tile.groupBy || [], 6, 'groupBy columns').map(known),
      6,
      'groupBy columns'
    );
    if (
      !Array.isArray(tile.metrics === undefined ? [] : tile.metrics) ||
      (tile.metrics || []).length > 8
    )
      throw new Error('"' + title + '": choose at most eight metrics.');
    var metricKeys = Object.create(null);
    var metrics = (tile.metrics || []).map(function (metric) {
      dmvDashboardObject_(metric, ['field', 'agg']);
      var agg = metric.agg === undefined ? 'sum' : metric.agg;
      var valid =
        typeof metric.field === 'string' &&
        metric.field &&
        metric.field.length <= 150 &&
        ['sum', 'avg', 'min', 'max', 'count', 'count_distinct'].indexOf(agg) >= 0;
      // Keyed by the mapped name: two spellings of one column are the same metric.
      var field = valid ? known(metric.field) : '';
      if (!valid || metricKeys[field + '__' + agg])
        throw new Error('"' + title + '": choose distinct metrics with a supported agg.');
      metricKeys[field + '__' + agg] = true;
      return { field: field, agg: agg };
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
        numerator: side(ratio.numerator),
        denominator: side(ratio.denominator),
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
    var formulas = dmvDashboardFormulas_(tile.formulas, {
      title: title,
      members: members,
      allowed: allowed,
      known: known,
      groupBy: groupBy,
      metrics: metrics,
      ratios: ratios,
    });
    var values = metrics.length + ratios.length + formulas.length;
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
    if (formulas.length) validated.formulas = formulas;
    if (filters.length) validated.filters = filters;
    if (type === 'kpi') {
      if (groupBy.length || !values)
        throw new Error(
          '"' + title + '": a kpi tile takes metrics, ratios or formulas and no groupBy.'
        );
      kpis += values;
    } else if (type === 'table') {
      if (!groupBy.length && !values)
        throw new Error(
          '"' + title + '": a table needs groupBy columns, metrics, ratios or formulas.'
        );
    } else {
      if (!groupBy.length || groupBy.length > 2 || !values)
        throw new Error(
          '"' +
            title +
            '": a chart needs metrics, ratios or formulas and one groupBy column for its axis; a second groupBy column splits it into series.'
        );
      if ((groupBy.length === 2 || type === 'pie') && values !== 1)
        throw new Error(
          '"' + title + '": a pie or split chart takes exactly one metric, ratio or formula.'
        );
      if (tile.stacked !== undefined) {
        if (tile.stacked !== true || ['column', 'bar', 'area'].indexOf(type) < 0)
          throw new Error('"' + title + '": stacked applies to column, bar and area charts.');
        validated.stacked = true;
      }
      // Values on the right axis are usually rates beside counts; on a column chart they are
      // drawn as lines, which is what Sheets offers for two scales.
      if (tile.secondaryAxis !== undefined) {
        var axisNames = dmvDashboardValueNames_(metrics, ratios, formulas);
        var keys = axisNames.map(function (entry) {
          return entry.name;
        });
        var right = dmvDashboardNames_(tile.secondaryAxis, 8, 'secondaryAxis columns').map(
          function (name) {
            var picked = dmvDashboardPick_(name, axisNames);
            return picked ? picked.name : name;
          }
        );
        if (
          ['line', 'column', 'area', 'scatter'].indexOf(type) < 0 ||
          groupBy.length > 1 ||
          !right.length ||
          right.length >= keys.length ||
          right.some(function (key, index) {
            return keys.indexOf(key) < 0 || right.indexOf(key) !== index;
          })
        )
          throw new Error(
            '"' +
              title +
              '": secondaryAxis names metric fields, ratio keys or formula keys of a line, column, area or scatter chart without a split, and leaves at least one on the left axis.'
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
    // compare sets the current period against the previous one. Each side is a dataset id or a
    // list of them, and a side's value is one aggregate over all of its datasets, so ratios stay
    // true ratios across accounts. A chart compares over a date axis, bucket by bucket.
    if (tile.compare !== undefined) {
      dmvDashboardObject_(tile.compare, ['current', 'previous']);
      var dated =
        ['line', 'area', 'column'].indexOf(type) >= 0 && groupBy.length === 1 && !validated.stacked;
      if (type !== 'kpi' && type !== 'table' && !dated)
        throw new Error(
          '"' +
            title +
            '": compare belongs on a kpi or table tile, or on a line, area or column chart over one date groupBy column, not stacked. ' +
            (['line', 'area', 'column'].indexOf(type) < 0
              ? 'Make it a table grouped by ' +
                (groupBy[0] || 'its columns') +
                ', or leave compare out.'
              : validated.stacked
                ? 'Leave stacked out.'
                : 'Group it by its date column alone, or leave compare out.')
        );
      var sides = ['current', 'previous'].map(function (side) {
        var value = tile.compare[side];
        var list = typeof value === 'string' ? [value] : value;
        return Array.isArray(list) &&
          list.length &&
          list.length <= DMV_DASHBOARD.maxDatasets &&
          list.every(function (id, index) {
            return typeof id === 'string' && from.indexOf(id) >= 0 && list.indexOf(id) === index;
          })
          ? list
          : null;
      });
      if (
        !sides[0] ||
        !sides[1] ||
        sides[0].some(function (id) {
          return sides[1].indexOf(id) >= 0;
        })
      )
        throw new Error(
          '"' +
            title +
            '": compare names current and previous, each a dataset id of this tile or a list of them, with no dataset on both sides.'
        );
      // Calendar buckets of two periods overlap only at their edge, so a compared table matches
      // rows by names; a trend over dates compares on a chart, bucket by bucket.
      if (
        type === 'table' &&
        !stored &&
        groupBy.some(function (name) {
          return members.some(function (dataset) {
            return dmvDashboardDated_(dataset, name);
          });
        })
      )
        throw new Error(
          '"' +
            title +
            '": a compared table matches rows by their groupBy values, and dates of two periods never match. Group it by names, or compare a trend on a line or column chart.'
        );
      // A compared chart buckets dates; a column a report declares as something else cannot be
      // its axis. A discovered column is known only at refresh, which checks again.
      if (
        dated &&
        !stored &&
        members.every(function (dataset) {
          var type = dmvDashboardFieldType_(dataset, groupBy[0]);
          return type !== null && type !== 'date';
        })
      )
        throw new Error(
          '"' +
            title +
            '": a compared chart needs a date column on its axis, and ' +
            groupBy[0] +
            ' is not one.'
        );
      if (
        dated &&
        (distinctSides ||
          metrics.some(function (metric) {
            return metric.agg === 'count_distinct';
          }))
      )
        throw new Error(
          '"' +
            title +
            '": a compared chart adds days up into buckets, so its metrics use sum, avg, min, max or count.'
        );
      validated.compare = {};
      ['current', 'previous'].forEach(function (side) {
        var value = tile.compare[side];
        validated.compare[side] = typeof value === 'string' ? value : value.slice();
      });
    }
    // Highlight rules tint the rows of a table whose value meets a condition, either a fixed
    // value or a multiple of the tile's overall value, so a rule stays meaningful as numbers move.
    // A rule on a groupBy column matches its text instead, the way a filter does.
    if (tile.highlight !== undefined) {
      if (type !== 'table')
        throw new Error('"' + title + '": highlight rules belong on a table tile.');
      var named = dmvDashboardValueNames_(metrics, ratios, formulas).concat(
        groupBy.map(function (name) {
          return { name: name, names: [name], group: true };
        })
      );
      if (
        !Array.isArray(tile.highlight) ||
        !tile.highlight.length ||
        tile.highlight.length > DMV_DASHBOARD.maxRules
      )
        throw new Error('"' + title + '": use one to four highlight rules.');
      validated.highlight = tile.highlight.map(function (rule) {
        dmvDashboardObject_(rule, ['field', 'op', 'value', 'ofTotal', 'color']);
        var number = function (value) {
          return typeof value === 'number' && isFinite(value);
        };
        var picked = dmvDashboardPick_(
          rule.field,
          named,
          '"' + title + '": highlight field "' + String(rule.field).slice(0, 80) + '"',
          ' is not a metric field, ratio key, formula key or groupBy column of this tile.'
        );
        var field = picked.name;
        if (picked.group) {
          if (rule.ofTotal !== undefined)
            throw new Error(
              '"' +
                title +
                '": ofTotal is a multiple of an overall number, so it applies to metric fields, ratio keys and formula keys; "' +
                field +
                '" is a groupBy column, matched by a text value.'
            );
          if (
            ['eq', 'ne', 'contains', 'in'].indexOf(rule.op) < 0 ||
            typeof rule.value !== 'string' ||
            !rule.value.trim() ||
            rule.value.length > 200 ||
            ['red', 'green', 'amber'].indexOf(rule.color) < 0
          )
            throw new Error(
              '"' +
                title +
                '": "' +
                field +
                '" is a groupBy column, so its highlight needs op (eq, ne, contains or in), a text value (comma-separated for in) and color (red, green or amber).'
            );
          return { field: field, op: rule.op, value: rule.value, color: rule.color };
        }
        if (
          ['gt', 'gte', 'lt', 'lte', 'eq'].indexOf(rule.op) < 0 ||
          (rule.value === undefined) === (rule.ofTotal === undefined) ||
          (rule.value !== undefined && !number(rule.value)) ||
          (rule.ofTotal !== undefined &&
            !(number(rule.ofTotal) && rule.ofTotal > 0 && rule.ofTotal <= 1000)) ||
          ['red', 'green', 'amber'].indexOf(rule.color) < 0
        )
          throw new Error(
            '"' +
              title +
              '": each highlight on a metric field, ratio key or formula key needs op (gt, gte, lt, lte or eq), exactly one of value (a number) or ofTotal (a multiple of the overall value, such as 1.5) and color (red, green or amber).'
          );
        // The overall value of a sum or count is the total of every row, which no single row of
        // several can exceed: ofTotal is then a share of it.
        var metric = metrics.filter(function (item) {
          return item.field === field;
        })[0];
        if (
          !stored &&
          rule.ofTotal >= 1 &&
          metric &&
          ['sum', 'count', 'count_distinct'].indexOf(metric.agg) >= 0
        )
          throw new Error(
            '"' +
              title +
              '": the overall value of ' +
              field +
              ' is its total over every row, so ofTotal on it is a share below 1, such as 0.1 for the rows holding at least a tenth of it (top converters: {field: "' +
              field +
              '", op: "gte", ofTotal: 0.1, color: "green"}).'
          );
        var entry = { field: field, op: rule.op, color: rule.color };
        if (rule.value !== undefined) entry.value = rule.value;
        else entry.ofTotal = rule.ofTotal;
        return entry;
      });
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
  // Polarity colours changes: a rise is good unless the value is lower-is-better (a cost) or
  // neutral (spend, budget). Names are metric fields, ratio or formula keys; a name no tile uses (a
  // generic cpm on a dashboard without one) is dropped.
  var valued = [];
  tiles.forEach(function (tile) {
    valued = valued.concat(
      dmvDashboardValueNames_(tile.metrics, tile.ratios || [], tile.formulas || [])
    );
  });
  var polarity = {};
  ['lowerIsBetter', 'neutral'].forEach(function (name) {
    if (input[name] === undefined) return;
    polarity[name] = [];
    dmvDashboardNames_(input[name], DMV_DASHBOARD.maxPolarity, name + ' names').forEach(
      function (key) {
        var picked = dmvDashboardPick_(key, valued);
        if (picked && polarity[name].indexOf(picked.name) < 0) polarity[name].push(picked.name);
      }
    );
  });
  if (
    (polarity.lowerIsBetter || []).some(function (key) {
      return (polarity.neutral || []).indexOf(key) >= 0;
    })
  )
    throw new Error('A value is either lowerIsBetter or neutral, not both.');
  var schedule = dmvSchedule_(input.schedule);
  var plan = {
    name: dmvText_(input.name, 'Dashboard name', 80, true),
    datasets: datasets,
    tiles: tiles,
    target: target,
    schedule: schedule,
    at: dmvScheduleAt_(schedule, input.at),
  };
  if (polarity.lowerIsBetter && polarity.lowerIsBetter.length)
    plan.lowerIsBetter = polarity.lowerIsBetter;
  if (polarity.neutral && polarity.neutral.length) plan.neutral = polarity.neutral;
  return plan;
}

// The formulas of a tile, checked as summarize checks them: keys apart from the tile's other
// names, expressions parsed, and references and units checked against the columns known at
// save. A column a report only discovers at refresh counts as a summable number here; the
// refresh checks it again with its real type.
function dmvDashboardFormulas_(list, tile) {
  var title = tile.title;
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length > DMV_FORMULAS.maxFormulas)
    throw new Error('"' + title + '": choose at most ' + DMV_FORMULAS.maxFormulas + ' formulas.');
  // Summarize matches names without regard to case, and refuses a formula key that repeats a
  // column in any case; so does this check, with each dataset's mapped names or declared fields.
  var taken = Object.create(null);
  ['source', 'currency'].concat(tile.groupBy, tile.allowed || []).forEach(function (name) {
    taken[name.toLowerCase()] = true;
  });
  tile.members.forEach(function (dataset) {
    (dataset.mapping || dmvDashboardDeclared_(dataset)).forEach(function (item) {
      taken[item.key.toLowerCase()] = true;
    });
  });
  tile.metrics.forEach(function (metric) {
    taken[metric.field.toLowerCase()] = true;
    taken[(metric.field + '__' + metric.agg).toLowerCase()] = true;
  });
  tile.ratios.forEach(function (ratio) {
    taken[ratio.key.toLowerCase()] = true;
  });
  var formulas = list.map(function (formula) {
    dmvDashboardObject_(formula, ['key', 'label', 'expression', 'percent']);
    if (
      typeof formula.key !== 'string' ||
      !/^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(formula.key) ||
      taken[formula.key.toLowerCase()] ||
      typeof formula.expression !== 'string' ||
      (formula.label !== undefined && typeof formula.label !== 'string') ||
      (formula.percent !== undefined && typeof formula.percent !== 'boolean')
    )
      throw new Error(
        '"' +
          title +
          '": each formula needs a distinct key (a letter, then letters, digits or underscores) that names no metric, ratio or column of this tile, and an expression.'
      );
    taken[formula.key.toLowerCase()] = true;
    var entry = { key: formula.key, expression: formula.expression };
    if (formula.label) entry.label = formula.label.slice(0, 80);
    if (formula.percent === true) entry.percent = true;
    return entry;
  });
  var ratioKeys = Object.create(null),
    formulaKeys = Object.create(null),
    seen = Object.create(null),
    columns = [];
  tile.ratios.forEach(function (ratio) {
    ratioKeys[ratio.key.toLowerCase()] = true;
  });
  formulas.forEach(function (formula) {
    formulaKeys[formula.key.toLowerCase()] = true;
  });
  // Every dataset of the tile must agree on a type for it to count.
  var typeOf = function (name) {
    var types = tile.members.map(function (dataset) {
      return dmvDashboardFieldType_(dataset, name);
    });
    return types.indexOf(null) >= 0 ? null : types[0];
  };
  var fields = tile.allowed
    ? tile.allowed
    : dmvDashboardDeclared_(tile.members[0]).map(function (field) {
        return field.key;
      });
  formulas.forEach(function (formula) {
    var tree;
    try {
      tree = dmvFormulaParse_(formula.expression);
    } catch (error) {
      throw new Error('"' + title + '": Formula "' + formula.key + '": ' + error.message + '.');
    }
    dmvDashboardRefs_(tree).forEach(function (name) {
      var lower = name.toLowerCase();
      if (formulaKeys[lower] || seen[lower]) return;
      var match = fields.filter(function (key) {
        return key.toLowerCase() === lower;
      })[0];
      // A ratio key reads the ratio. When a column has the same name, a refresh refuses the
      // formula as ambiguous, so the column goes in too and the check below refuses it now.
      if (ratioKeys[lower] && !match) return;
      var key = tile.known(match || name);
      seen[lower] = true;
      columns.push(dmvDashboardFormulaColumn_(tile.members, key));
    });
  });
  try {
    dmvFormulaCompile_(
      formulas,
      columns,
      tile.ratios.map(function (ratio) {
        var money = [ratio.numerator, ratio.denominator].filter(function (field) {
          return typeOf(field) === 'currency';
        }).length;
        return {
          key: ratio.key,
          type: money === 1 ? 'currency' : ratio.percent ? 'percent' : 'number',
        };
      })
    );
  } catch (error) {
    throw new Error('"' + title + '": ' + error.message);
  }
  return formulas;
}

// The column a refresh reads for a name a formula uses, as the reports declare it, so a field a
// connector marks as not additive (reach, users) or whose label names a rate is refused at save
// as summarize refuses it. A mapped column is combined: its label is its name, and it cannot be
// summed when any dataset's field cannot. A column some dataset only discovers at refresh counts
// as a summable number; the refresh checks it again.
function dmvDashboardFormulaColumn_(members, key) {
  var column = { key: key, label: key.replace(/_/g, ' '), type: null };
  for (var index = 0; index < members.length; index++) {
    var dataset = members[index],
      name = key;
    if (dataset.mapping) {
      var entry = dataset.mapping.filter(function (item) {
        return item.key === key;
      })[0];
      if (!entry)
        return key === 'source' || key === 'currency'
          ? { key: key, type: 'text' }
          : { key: key, type: 'number', summable: true };
      name = entry.field;
    }
    var field = dmvDashboardDeclaredField_(dataset, name);
    if (!field) return { key: key, type: 'number', summable: true };
    if (!dataset.mapping) column.label = field.label || field.key;
    if (column.type === null) column.type = field.type || 'text';
    if (!dmvChatAdditive_(field)) column.additive = false;
  }
  return column;
}

// The names an expression refers to, in the order they appear.
function dmvDashboardRefs_(node, out) {
  out = out || [];
  if (node.type === 'ref') out.push(node.name);
  else if (node.type === 'neg') dmvDashboardRefs_(node.arg, out);
  else if (node.type === 'bin') {
    dmvDashboardRefs_(node.left, out);
    dmvDashboardRefs_(node.right, out);
  } else if (node.type === 'call')
    node.args.forEach(function (arg) {
      dmvDashboardRefs_(arg, out);
    });
  return out;
}

// What one formula of a tile reads: the ratios and earlier formulas it names, directly or
// through those formulas, with the formula itself last. A scorecard of one formula is computed
// from these alone, so an amount of money it does not use cannot split it by currency.
function dmvDashboardNeeds_(tile, key) {
  var formulas = tile.formulas || [],
    wanted = Object.create(null);
  wanted[key.toLowerCase()] = true;
  for (var index = formulas.length - 1; index >= 0; index--)
    if (wanted[formulas[index].key.toLowerCase()])
      dmvDashboardRefs_(dmvFormulaParse_(formulas[index].expression)).forEach(function (name) {
        wanted[name.toLowerCase()] = true;
      });
  var pick = function (list) {
    return list.filter(function (item) {
      return wanted[item.key.toLowerCase()];
    });
  };
  return { ratios: pick(tile.ratios || []), formulas: pick(formulas) };
}

// A tile's formulas compiled against the columns of the rows it reads, with its ratios typed
// and their parts named as those columns are (see dmv_formulas.js).
function dmvDashboardCompile_(base, ratios, formulas) {
  return dmvFormulaCompile_(
    formulas || [],
    base.columns,
    (ratios || []).map(function (ratio) {
      var sides = [ratio.numerator, ratio.denominator].map(function (field) {
        return dmvChatRatioSide_(base, field, 'ratio column');
      });
      var money = sides.filter(function (side) {
        return side.agg === 'sum' && side.column.type === 'currency';
      }).length;
      return {
        key: ratio.key,
        type: money === 1 ? 'currency' : ratio.percent ? 'percent' : 'number',
        numerator: dmvChatRatioSideName_(sides[0]),
        denominator: dmvChatRatioSideName_(sides[1]),
      };
    })
  );
}

// The packed part of a record: what a refresh needs beside the record's own fields.
// toned marks a plan saved since changes carry colour: plans saved before showed every change
// uncoloured and had no polarity lists, so their rises are not called good.
function dmvDashboardPacked_(plan, toned) {
  var packed = { datasets: plan.datasets, tiles: plan.tiles };
  if (toned) packed.toned = true;
  if (plan.lowerIsBetter) packed.lowerIsBetter = plan.lowerIsBetter;
  if (plan.neutral) packed.neutral = plan.neutral;
  return packed;
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
    schedule: dashboard.schedule || 'manual',
    at: dashboard.at || null,
    nextRunAt: dashboard.nextRunAt || null,
    lastError: legacy ? DMV_DASHBOARD_LEGACY : dashboard.lastError || '',
    draft: dashboard.draft === true,
    origin: dashboard.origin || 'chat',
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
  return dmvDashboardSave_(input, false);
}

// legacy saves a plan written before changes carried colour (a settings file without toned) the
// way a refresh reads it: repaired rather than refused, uncoloured and with its periods unchecked,
// so a dashboard that refreshes where it was exported also imports.
function dmvDashboardSave_(input, legacy) {
  return dmvLocked_(function () {
    var spreadsheet = dmvSpreadsheet_(),
      previous = input && input.id ? dmvDashboardHere_(input.id) : null;
    if (previous && previous.runToken && Date.now() - previous.startedAt < 300000)
      throw new Error('Wait for this dashboard refresh to finish before changing it.');
    if (previous && input.revision !== previous.revision)
      throw new Error('This dashboard changed. Refresh the sidebar before saving.');
    if (!previous && dmvList_('dashboard').length >= DMV_LIMITS.maxReports)
      throw new Error('Keep at most 30 private dashboards.');
    var plan = dmvValidateDashboard_(input, spreadsheet, legacy);
    if (!legacy)
      dmvDashboardCheckPeriodsAhead_(
        plan,
        Utilities.formatDate(new Date(), spreadsheet.getSpreadsheetTimeZone(), 'yyyy-MM-dd')
      );
    var id = previous ? previous.id : dmvId_();
    // A tab someone else filled would only fail after every dataset was fetched; say so now,
    // with its name. Tabs this dashboard wrote earlier are its own.
    var fresh = dmvReopen_(spreadsheet),
      store = dmvStore_();
    plan.datasets
      .filter(function (dataset) {
        return !dmvDashboardIsTab_(dataset);
      })
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
              ' 2"; a dataset reads a tab in place with sourceSheet.'
          );
      });
    var dashboard = {
      id: id,
      spreadsheetId: spreadsheet.getId(),
      revision: previous ? previous.revision + 1 : 1,
      name: plan.name,
      target: plan.target,
      // A tab dataset's output is the user's tab it reads (tab), which nothing writes.
      outputs: plan.datasets.map(function (dataset) {
        return dmvDashboardIsTab_(dataset)
          ? { id: dataset.id, label: dataset.label, sheetName: dataset.sourceSheet, tab: true }
          : { id: dataset.id, label: dataset.label, sheetName: dataset.sheetName };
      }),
      chartCount: plan.tiles.filter(dmvDashboardIsChart_).length,
      // Listed outside the packed plan so connection guards need not unpack every dashboard.
      connectionIds: plan.datasets
        .map(function (dataset) {
          return dataset.connectionId;
        })
        .filter(function (connectionId, index, all) {
          return !!connectionId && all.indexOf(connectionId) === index;
        }),
      plan: dmvPack_(dmvDashboardPacked_(plan, !legacy)),
      chartIds: (previous && previous.chartIds) || [],
      status: 'ready',
      statusMessage: 'Ready to refresh all datasets',
      lastError: '',
      runToken: null,
      schedule: plan.schedule,
      at: plan.at,
      nextRunAt: dmvFirstRun_(plan.schedule, plan.at, spreadsheet.getSpreadsheetTimeZone()),
    };
    dmvDraftState_(dashboard, input, previous);
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
          schedule: 'weekly',
          at: { hour: 23, weekday: 7 },
          nextRunAt: Date.now(),
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
    // A dataset dropped from the plan no longer owns its tab. Its record in the spreadsheet goes
    // first, so a failure leaves the plan as it was.
    var dropped = ((previous && previous.outputs) || [])
      .filter(function (output) {
        return !dashboard.outputs.some(function (kept) {
          return kept.id === output.id;
        });
      })
      .map(function (output) {
        return dmvDashboardOutputId_(dashboard, output);
      });
    if (dropped.length) dmvForgetOutputs_(dashboard.spreadsheetId, dropped);
    dmvSave_('dashboard', dashboard);
    try {
      dmvEnsureSchedule_();
    } catch (error) {
      if (previous) dmvSave_('dashboard', previous);
      else dmvStore_().deleteProperty(dmvKey_('dashboard', id));
      throw new Error(
        'The refresh schedule could not be created. Check Google authorization and try again.'
      );
    }
    dropped.forEach(function (outputId) {
      dmvStore_().deleteProperty(dmvOutputKey_(dashboard.spreadsheetId, outputId));
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
    var ids = ['-report', '-charts', '-data']
      .concat(
        (dashboard.outputs || []).map(function (output) {
          return '-d-' + output.id;
        })
      )
      .map(function (suffix) {
        return dashboard.id + suffix;
      });
    var keys = ids.map(function (outputId) {
      return dmvOutputKey_(dashboard.spreadsheetId, outputId);
    });
    var deleted = 0;
    if (keepTabs !== true)
      deleted = dmvWorkbookLocked_(function () {
        if (store.getProperty('dmv:v1:write-journal:' + dashboard.spreadsheetId))
          dmvRecoverOutputJournal_(
            dmvReopen_(SpreadsheetApp.openById(dashboard.spreadsheetId)),
            store,
            ids
          );
        var owned = Object.create(null);
        keys.forEach(function (key) {
          var receipt = JSON.parse(store.getProperty(key) || 'null');
          if (receipt && Number.isInteger(receipt.sheetId)) owned[receipt.sheetId] = true;
        });
        var live = (
          Sheets.Spreadsheets.get(dashboard.spreadsheetId, {
            fields: 'sheets.properties(sheetId,hidden)',
          }).sheets || []
        ).map(function (item) {
          return item.properties;
        });
        var requests = live
          .filter(function (properties) {
            return owned[properties.sheetId];
          })
          .map(function (properties) {
            return { deleteSheet: { sheetId: properties.sheetId } };
          });
        if (!requests.length) return 0;
        // A spreadsheet must keep one visible tab; hidden ones do not count.
        if (
          !live.some(function (properties) {
            return !owned[properties.sheetId] && !properties.hidden;
          })
        )
          requests.unshift({ addSheet: { properties: {} } });
        Sheets.Spreadsheets.batchUpdate({ requests: requests }, dashboard.spreadsheetId);
        return requests.filter(function (request) {
          return request.deleteSheet;
        }).length;
      });
    // Records on deleted tabs went with them; those on kept tabs go now.
    dmvForgetOutputs_(dashboard.spreadsheetId, ids);
    store.deleteProperty(dmvKey_('dashboard', dashboard.id));
    keys.forEach(function (key) {
      store.deleteProperty(key);
    });
    dmvEnsureSchedule_();
    return { ok: true, deletedTabs: deleted };
  });
}

// The schedule is refresh state beside the plan: changing it neither bumps the revision nor
// touches a refresh in progress.
function dmvScheduleDashboard(id, schedule, at) {
  return dmvLocked_(function () {
    var dashboard = dmvDashboardHere_(id);
    if (dmvDashboardLegacy_(dashboard)) throw new Error(DMV_DASHBOARD_LEGACY);
    if (dashboard.draft && dmvSchedule_(schedule) !== 'manual')
      throw new Error('Save this draft before scheduling refreshes.');
    dashboard.schedule = dmvSchedule_(schedule);
    dashboard.at = dmvScheduleAt_(dashboard.schedule, at);
    var spreadsheet = dmvSpreadsheet_();
    dashboard.nextRunAt = dmvFirstRun_(
      dashboard.schedule,
      dashboard.at,
      spreadsheet.getSpreadsheetTimeZone()
    );
    dmvSave_('dashboard', dashboard);
    dmvEnsureSchedule_();
    return dmvDashboardSummary_(dashboard, spreadsheet);
  });
}

// Keeping a draft moves it under Saved; nothing else about it changes.
function dmvKeepDashboard(id) {
  return dmvLocked_(function () {
    var dashboard = dmvDashboardHere_(id);
    if (dmvDashboardLegacy_(dashboard)) throw new Error(DMV_DASHBOARD_LEGACY);
    dashboard.draft = false;
    dmvSave_('dashboard', dashboard);
    return dmvDashboardSummary_(dashboard, dmvSpreadsheet_());
  });
}

// Whether a compare sets one unmapped dataset against another of the same report or the same
// tab, the tile's only datasets: their columns are the same, so the tile reads each side as it is.
function dmvDashboardPaired_(compare, members) {
  if (!compare || typeof compare !== 'object' || members.length !== 2) return false;
  var sides = ['current', 'previous'].map(function (side) {
    var list = typeof compare[side] === 'string' ? [compare[side]] : compare[side];
    return Array.isArray(list) && list.length === 1 ? list[0] : null;
  });
  var same = function (dataset) {
    return dmvDashboardIsTab_(dataset)
      ? 'tab|' + dataset.sourceSheet
      : dataset.connectorId + '|' + dataset.reportType;
  };
  return (
    !!sides[0] &&
    !!sides[1] &&
    sides[0] !== sides[1] &&
    members.every(function (dataset) {
      return !dataset.mapping && sides.indexOf(dataset.id) >= 0;
    }) &&
    same(members[0]) === same(members[1])
  );
}

// Each previous dataset of a compare beside the current one it stands for: the one of the same
// connection and report, or by list position when one account holds several datasets. null
// when the two sides cannot be paired.
function dmvDashboardPairs_(byId, tile) {
  var now = dmvDashboardIds_(tile.compare.current).map(function (id) {
      return byId[id];
    }),
    before = dmvDashboardIds_(tile.compare.previous).map(function (id) {
      return byId[id];
    });
  if (now.length !== before.length) return null;
  var key = function (dataset) {
    return dmvDashboardIsTab_(dataset)
      ? 'tab|' + dataset.sourceSheet
      : dataset.connectionId + '|' + dataset.reportType;
  };
  var unique = function (list) {
    return list.every(function (dataset) {
      return (
        list.filter(function (other) {
          return key(other) === key(dataset);
        }).length === 1
      );
    });
  };
  if (!unique(now) || !unique(before))
    return before.map(function (dataset, index) {
      return { current: now[index], previous: dataset };
    });
  var pairs = before.map(function (dataset) {
    var match = now.filter(function (other) {
      return key(other) === key(dataset);
    })[0];
    return match ? { current: match, previous: dataset } : null;
  });
  return pairs.indexOf(null) >= 0 ? null : pairs;
}

// A comparison is fair only against the period just before, with as many days, or as many whole
// calendar months when both periods are whole months (a month to date is not one). Checked with
// the resolved dates, before anything is fetched; day names the later refresh day they are of.
function dmvDashboardCheckPeriods_(plan, ranges, day) {
  var byId = Object.create(null);
  plan.datasets.forEach(function (dataset) {
    byId[dataset.id] = dataset;
  });
  var time = function (date) {
    return Date.parse(date + 'T12:00:00Z');
  };
  var length = function (range) {
    return Math.round((time(range.endDate) - time(range.startDate)) / 86400000) + 1;
  };
  // The calendar months a range covers from a 1st to a month's last day, or 0.
  var months = function (range) {
    var after = new Date(time(range.endDate) + 86400000).toISOString();
    if (range.startDate.slice(8) !== '01' || after.slice(8, 10) !== '01') return 0;
    return (
      (Number(range.endDate.slice(0, 4)) - Number(range.startDate.slice(0, 4))) * 12 +
      Number(range.endDate.slice(5, 7)) -
      Number(range.startDate.slice(5, 7)) +
      1
    );
  };
  plan.tiles.forEach(function (tile) {
    if (!tile.compare) return;
    var now = dmvDashboardIds_(tile.compare.current).map(function (id) {
      return byId[id];
    });
    // Unpaired sides are checked by position, or against the first current dataset.
    var pairs =
      dmvDashboardPairs_(byId, tile) ||
      dmvDashboardIds_(tile.compare.previous).map(function (id, index) {
        return { current: now[index] || now[0], previous: byId[id] };
      });
    pairs.forEach(function (pair) {
      var now = ranges[pair.current.id],
        before = ranges[pair.previous.id];
      if (!now || !before) return;
      var whole = months(now) > 0 && months(before) > 0;
      if (
        Math.round((time(now.startDate) - time(before.endDate)) / 86400000) === 1 &&
        (whole ? months(now) === months(before) : length(now) === length(before))
      )
        return;
      throw new Error(
        '"' +
          tile.title +
          '": ' +
          (day ? 'on a refresh on ' + day + ', ' : '') +
          pair.previous.label +
          ' (' +
          before.startDate +
          ' to ' +
          before.endDate +
          ') must be the period just before ' +
          pair.current.label +
          ' (' +
          now.startDate +
          ' to ' +
          now.endDate +
          '), with as many ' +
          (whole ? 'whole months' : 'days') +
          '. Use the previous preset that matches the current one: previous7, previous14, previous30 or previous90 for last7 to last90, previousWeek for lastWeek, previousMonth for lastMonth, and for a custom range the custom range just before it. yesterday, thisMonth, thisYear and lastYear have no previous preset, so leave them uncompared.'
      );
    });
  });
}

// Relative presets move with the refresh day, and every refresh checks its periods again: a pair
// that lines up only today (last7 against previousWeek on a Monday, lastMonth against previous30
// after a 30-day month, a relative period against a fixed custom one) would fail later. So every
// refresh day of the coming year is checked now.
function dmvDashboardCheckPeriodsAhead_(plan, today) {
  if (
    !plan.tiles.some(function (tile) {
      return !!tile.compare;
    })
  )
    return;
  var dated = plan.datasets.filter(dmvDashboardPeriodic_);
  var relative = dated.some(function (dataset) {
    return (dataset.dateRange || {}).preset !== 'custom';
  });
  for (var offset = 0; offset <= (relative ? 366 : 0); offset++) {
    var day = new Date(Date.parse(today + 'T12:00:00Z') + offset * 86400000)
      .toISOString()
      .slice(0, 10);
    var ranges = Object.create(null);
    dated.forEach(function (dataset) {
      ranges[dataset.id] = dmvDateRange_(dataset.dateRange, day);
    });
    dmvDashboardCheckPeriods_(plan, ranges, offset ? day : '');
  }
}

// The tab that holds the numbers behind the charts. It is created hidden: a refresh can then
// return any number of rows without moving anything on the dashboard itself.
function dmvDashboardChartTab_(target) {
  return target.sheetName.slice(0, 86) + ' (chart data)';
}
