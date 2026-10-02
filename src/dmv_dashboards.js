/* Dashboards: several datasets, each refreshed into its own tab, plus one dashboard tab with
   scorecards, native charts and their supporting tables. Plans stay private to their owner and
   workbook. A refresh rebuilds every tab and chart from the saved plan, without an AI call. */
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

// One light look for every dashboard tab. Series colours keep a fixed order and are never
// cycled; the last four are lighter last resorts.
var DMV_DASHBOARD_STYLE = {
  page: '#f4f6fa',
  card: '#ffffff',
  band: '#0d366b',
  bandText: '#ffffff',
  bandMuted: '#b7d3f6',
  ink: '#1f2328',
  // A cool grey that keeps 4.5:1 on white for 9pt labels and notes.
  muted: '#6b7280',
  headerBackground: '#eef4fd',
  headerText: '#3d4b5c',
  separator: '#e8ebf0',
  totalBackground: '#f7f9fc',
  link: '#2a78d6',
  good: '#006300',
  bad: '#c62828',
  neutral: '#6b7280',
  tints: { red: '#fde4e4', green: '#e3f4e3', amber: '#fdf0d2' },
  bar: '#86b6ef',
  previous: '#9aa4b2',
  heat: ['#ffffff', '#e6f0fc', '#cde2fb', '#b7d3f6', '#9ec5f4'],
  series: [
    '#2a78d6',
    '#eb6834',
    '#1baf7a',
    '#eda100',
    '#e87ba4',
    '#008300',
    '#4a3aa7',
    '#e34948',
    '#86b6ef',
    '#f4a37f',
    '#7fd3b4',
    '#b0aead',
  ],
};
var DMV_DASHBOARD_MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
// Changes print as "▲ 12.4%", "▼ 3.0%" or "▶ 0.0%": an icon beside the colour, never colour alone.
var DMV_DASHBOARD_DELTA = '"▲ "0.0%;"▼ "0.0%;"▶ "0.0%';

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
  var found = dmvDashboardDeclared_(dataset).filter(function (item) {
    return item.key === field;
  })[0];
  return found ? found.type || 'text' : null;
}

// The fields a dataset's report declares; a report that discovers its fields declares none.
function dmvDashboardDeclared_(dataset) {
  var fields = dmvDefinition_(dmvConnector_(dataset.connectorId), dataset.reportType).fields;
  return (Array.isArray(fields) ? fields : []).filter(function (item) {
    return !!item && typeof item.key === 'string';
  });
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
        : dmvDashboardNames_(tile.datasets, DMV_DASHBOARD.maxDatasets, 'tile datasets');
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
        var keys = metrics
          .map(function (metric) {
            return metric.field;
          })
          .concat(
            ratios.concat(formulas).map(function (item) {
              return item.key;
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
            '": compare belongs on a kpi or table tile, or on a line, area or column chart over one date groupBy column, not stacked.'
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
        metrics.some(function (metric) {
          return metric.agg === 'count_distinct';
        })
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
      var names = metrics
        .map(function (metric) {
          return metric.field;
        })
        .concat(
          ratios.concat(formulas).map(function (item) {
            return item.key;
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
        if (names.indexOf(rule.field) < 0 && groupBy.indexOf(rule.field) >= 0) {
          if (rule.ofTotal !== undefined)
            throw new Error(
              '"' +
                title +
                '": ofTotal is a multiple of an overall number, so it applies to metric fields, ratio keys and formula keys; "' +
                rule.field +
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
                rule.field +
                '" is a groupBy column, so its highlight needs op (eq, ne, contains or in), a text value (comma-separated for in) and color (red, green or amber).'
            );
          return { field: rule.field, op: rule.op, value: rule.value, color: rule.color };
        }
        if (names.indexOf(rule.field) < 0)
          throw new Error(
            '"' +
              title +
              '": highlight field "' +
              String(rule.field).slice(0, 80) +
              '" is not a metric field, ratio key, formula key or groupBy column of this tile.'
          );
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
          return item.field === rule.field;
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
              rule.field +
              ' is its total over every row, so ofTotal on it is a share below 1, such as 0.1 for the rows holding at least a tenth of it (top converters: {field: "' +
              rule.field +
              '", op: "gte", ofTotal: 0.1, color: "green"}).'
          );
        var entry = { field: rule.field, op: rule.op, color: rule.color };
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
  var known = Object.create(null);
  tiles.forEach(function (tile) {
    tile.metrics.forEach(function (metric) {
      known[metric.field] = true;
    });
    (tile.ratios || []).concat(tile.formulas || []).forEach(function (item) {
      known[item.key] = true;
    });
  });
  var polarity = {};
  ['lowerIsBetter', 'neutral'].forEach(function (name) {
    if (input[name] === undefined) return;
    polarity[name] = dmvDashboardNames_(input[name], DMV_DASHBOARD.maxPolarity, name + ' names');
  });
  if (
    (polarity.lowerIsBetter || []).some(function (key) {
      return (polarity.neutral || []).indexOf(key) >= 0;
    })
  )
    throw new Error('A value is either lowerIsBetter or neutral, not both.');
  Object.keys(polarity).forEach(function (name) {
    polarity[name] = polarity[name].filter(function (key) {
      return known[key];
    });
  });
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
    var field = dmvDashboardDeclared_(dataset).filter(function (item) {
      return item.key === name;
    })[0];
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
        return dmvChatColumn_(base, field, 'ratio column');
      });
      var money = sides.filter(function (column) {
        return column.type === 'currency';
      }).length;
      return {
        key: ratio.key,
        type: money === 1 ? 'currency' : ratio.percent ? 'percent' : 'number',
        numerator: sides[0].key,
        denominator: sides[1].key,
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
        // A spreadsheet must keep one visible tab; hidden ones, such as chat's undo copies of
        // deleted tabs, do not count.
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

// A connector that keeps only the top rows of a ranked list (a report's "Keep the top rows", a
// query's own LIMIT) says so with metadata.topRows beside its note. It counts only when the
// result holds exactly that many rows: a shorter list is the whole list.
function dmvDashboardTopOf_(result) {
  var metadata = result.metadata || {},
    count = metadata.topRows;
  if (
    typeof count !== 'number' ||
    count !== Math.floor(count) ||
    count < 1 ||
    result.rows.length !== count
  )
    return null;
  // "Top 100 by Cost" reads "top 100 by Cost" beside a title; advice after a ";" stays on the
  // data tab and in the data sources.
  var note =
    typeof metadata.note === 'string' && metadata.note.split(';')[0].trim()
      ? metadata.note.split(';')[0].trim()
      : 'Top ' + count.toLocaleString() + ' rows';
  // The note's first word says which end of the list was kept when it precedes the count:
  // "Lowest 100 by CTR" is the lowest 100, "First 100 rows (query LIMIT)" the first. Any other
  // note reads as the top.
  var lead = /^([a-z]+)\s+([\d.,\s]+)/i.exec(note);
  return {
    rows: count,
    note: note.charAt(0).toLowerCase() + note.slice(1),
    word: lead && Number(lead[2].replace(/\D/g, '')) === count ? lead[1].toLowerCase() : 'top',
  };
}

// How a tile names the cut datasets it reads: label for its total row and scorecards ("top 100",
// "lowest 100", "top 100 each", or "top rows" when the counts differ or a whole dataset is read
// too, "kept rows" when the lists were cut at different ends) and note for its card ("top 100
// by Cost", or each dataset's own). Null when it reads none.
function dmvDashboardTileTop_(context, tile) {
  var ids = tile.datasets.filter(function (id) {
    return context.tops[id];
  });
  if (!ids.length) return null;
  var every = ids.length === tile.datasets.length;
  var distinct = function (key) {
    return ids
      .map(function (id) {
        return context.tops[id][key];
      })
      .filter(function (value, index, list) {
        return list.indexOf(value) === index;
      });
  };
  var counts = distinct('rows'),
    notes = distinct('note'),
    words = distinct('word'),
    each = ids.length > 1 ? ' each' : '';
  return {
    label:
      words.length > 1
        ? 'kept rows'
        : words[0] +
          (every && counts.length === 1 ? ' ' + counts[0].toLocaleString() + each : ' rows'),
    note:
      every && notes.length === 1
        ? notes[0] + each
        : ids
            .map(function (id) {
              return context.labels[id] + ': ' + context.tops[id].note;
            })
            .join(', '),
  };
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
// Money ranked against money of another currency would compare unlike units, so a split table
// ordered by an amount ranks within each currency.
function dmvDashboardSummarize_(session, resultId, spec) {
  function run(input) {
    var described = dmvChatSummarize_(session, Object.assign({ resultId: resultId }, input));
    return dmvChatResult_(session, described.resultId);
  }
  var effective = spec,
    summary;
  try {
    summary = run(spec);
  } catch (error) {
    var column = (dmvChatResult_(session, resultId).metadata || {}).currencyColumn;
    if (!column || !/different currencies|Include currency/.test(error.message)) throw error;
    effective = Object.assign({}, spec, { groupBy: (spec.groupBy || []).concat([column]) });
    if (spec.rankWithin) effective.rankWithin = spec.rankWithin.concat([column]);
    summary = run(effective);
    var order =
      !spec.rankWithin &&
      spec.orderBy &&
      dmvChatColumn_({ columns: summary.columns }, spec.orderBy.field, 'orderBy column');
    if (order && order.type === 'currency') {
      var limit = spec.limit === undefined ? 50 : spec.limit;
      effective = Object.assign({}, effective, {
        rankWithin: [column],
        limitPerGroup: limit,
        limit: DMV_CHAT_RESULTS.maxSummaryRows,
      });
      summary = run(effective);
      // Each currency's rows together, each in its own ranking, and the cut said per currency.
      var currencies = [];
      summary.rows.forEach(function (row) {
        if (currencies.indexOf(row[column]) < 0) currencies.push(row[column]);
      });
      var ranking = summary.metadata.ranking;
      summary = Object.assign({}, summary, {
        rows: summary.rows.slice().sort(function (a, b) {
          return currencies.indexOf(a[column]) - currencies.indexOf(b[column]);
        }),
        metadata: Object.assign({}, summary.metadata, {
          perCurrency:
            ranking.selectedGroups < ranking.totalGroups
              ? { limit: limit, groups: ranking.totalGroups }
              : null,
        }),
      });
    }
  }
  return dmvDashboardPrecise_(session, resultId, effective, summary);
}

// Summaries round ratios and formulas to four decimals, which leaves a small rate such as a
// 1.46% CTR with two significant digits; changes and thresholds need more. Each ratio is divided
// again from its summed parts, grouped the same way, and each formula evaluated again over those
// sums, the precise ratios and the formulas before it.
function dmvDashboardPrecise_(session, resultId, spec, summary) {
  var ratios = spec.ratios || [],
    formulas = spec.formulas || [];
  if ((!ratios.length && !formulas.length) || !summary.rows.length) return summary;
  var base = dmvChatResult_(session, resultId),
    compiled = dmvDashboardCompile_(base, ratios, formulas),
    parts = [];
  var part = function (key) {
    if (parts.indexOf(key) < 0) parts.push(key);
    return key;
  };
  var sides = ratios.map(function (ratio) {
    return [ratio.numerator, ratio.denominator].map(function (field) {
      return part(dmvChatColumn_(base, field, 'ratio column').key);
    });
  });
  compiled.forEach(function (formula) {
    formula.sums.forEach(part);
  });
  var described = dmvChatSummarize_(session, {
    resultId: resultId,
    groupBy: spec.groupBy || [],
    dateBucket: spec.dateBucket,
    metrics: parts.map(function (field) {
      return { field: field, agg: 'sum' };
    }),
    filters: spec.filters,
    limit: DMV_CHAT_RESULTS.maxSummaryRows,
  });
  var whole = dmvChatResult_(session, described.resultId);
  var dims = whole.columns.filter(function (column) {
    return column.role === 'dimension';
  });
  var key = function (row) {
    return JSON.stringify(
      dims.map(function (column) {
        return row[column.key] === undefined ? null : row[column.key];
      })
    );
  };
  var lookup = Object.create(null);
  whole.rows.forEach(function (row) {
    lookup[key(row)] = row;
  });
  var sumOf = function (row, field) {
    var value = row[field + '__sum'];
    return dmvDashboardBlank_(value) || !isFinite(Number(value)) ? null : Number(value);
  };
  return Object.assign({}, summary, {
    rows: summary.rows.map(function (row) {
      var found = lookup[key(row)];
      if (!found) return row;
      var copy = Object.assign({}, row),
        sums = Object.create(null),
        values = Object.create(null);
      parts.forEach(function (field) {
        sums[field] = values[field] = sumOf(found, field);
      });
      ratios.forEach(function (ratio, index) {
        var above = sums[sides[index][0]],
          below = sums[sides[index][1]];
        values[ratio.key] = above !== null && below ? above / below : null;
        if (!dmvDashboardBlank_(row[ratio.key]) && values[ratio.key] !== null)
          copy[ratio.key] = Number(values[ratio.key].toPrecision(12));
      });
      var computed = dmvFormulaEvaluateAll_(compiled, values);
      compiled.forEach(function (formula) {
        if (!dmvDashboardBlank_(row[formula.key]) && computed[formula.key] !== null)
          copy[formula.key] = Number(computed[formula.key].toPrecision(12));
      });
      return copy;
    }),
  });
}

// Mapped columns are named by their keys ("campaign_name"); headers read better capitalized.
function dmvDashboardLabel_(value) {
  var text = String(value === null || value === undefined ? '' : value);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// One side of a comparison: the tile's rows from some of its datasets, kept in memory for this
// refresh. renamed gives the previous side the current side's source labels by position, so
// rows grouped by source meet their own account.
function dmvDashboardSide_(context, resultId, labels, renamed) {
  var key = 'side:' + resultId + JSON.stringify([labels, renamed || null]);
  if (context.memo[key]) return context.memo[key];
  var base = dmvChatResult_(context.session, resultId);
  var rows = base.rows
    .filter(function (row) {
      return labels.indexOf(row.source) >= 0;
    })
    .map(function (row) {
      return renamed
        ? Object.assign({}, row, { source: renamed[labels.indexOf(row.source)] })
        : row;
    });
  return (context.memo[key] = dmvChatStoreResult_(context.session, {
    columns: base.columns,
    rows: rows,
    metadata: base.metadata,
    source: base.source,
  }));
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
    return dataset.connectionId + '|' + dataset.reportType;
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
  var dated = plan.datasets.filter(function (dataset) {
    return !!dmvDefinition_(dmvConnector_(dataset.connectorId), dataset.reportType).dateRange;
  });
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

function dmvDashboardSideLabels_(context, tile, side) {
  return dmvDashboardIds_(tile.compare[side]).map(function (id) {
    return context.labels[id];
  });
}

// The labels the previous side's rows take: each previous dataset the label of the current one
// it stands for, so a tile filter or rule on source and rows grouped by source meet their own
// account in both periods. null keeps their own labels when the sides cannot be paired.
function dmvDashboardRenamed_(context, tile) {
  var pairs = dmvDashboardPairs_(context.datasets, tile);
  return (
    pairs &&
    pairs.map(function (pair) {
      return pair.current.label;
    })
  );
}

// The relative change, or null when there is nothing to compare against.
function dmvDashboardDelta_(current, previous) {
  if ([current, previous].some(dmvDashboardBlank_)) return null;
  var now = Number(current),
    before = Number(previous);
  if (!isFinite(now) || !isFinite(before) || !before) return null;
  // Rounded once, when it is printed: a delta rounded here too could land a tenth of a point
  // away from the cell that shows it.
  return Math.round(((now - before) / Math.abs(before)) * 1e8) / 1e8;
}

function dmvDashboardBlank_(value) {
  return value === null || value === undefined || value === '';
}

// A rise is good unless the value is lower-is-better (a cost); neutral values are only grey, and
// so is every change of a plan saved before changes were coloured.
function dmvDashboardTone_(plan, key, delta) {
  if (
    !delta ||
    !(plan.toned || plan.lowerIsBetter || plan.neutral) ||
    (plan.neutral || []).indexOf(key) >= 0
  )
    return 'neutral';
  return delta > 0 !== (plan.lowerIsBetter || []).indexOf(key) >= 0 ? 'good' : 'bad';
}

// Numbers in highlight and change text, as the page cells show them: money and counts of a
// thousand or more as whole numbers, smaller ones with two decimals (four below 1, so a rate of
// 0.006 does not read 0.01), rates as percentages.
function dmvDashboardNumber_(value, type) {
  var number = Number(value);
  if (dmvDashboardBlank_(value) || !isFinite(number)) return '';
  if (type === 'percent') return (number * 100).toFixed(2) + '%';
  var whole = Math.abs(number) >= 1000 || (type !== 'currency' && number % 1 === 0);
  var parts = Math.abs(number)
    .toFixed(whole ? 0 : type !== 'currency' && Math.abs(number) < 1 ? 4 : 2)
    .split('.');
  return (
    (number < 0 && /[1-9]/.test(parts.join('')) ? '-' : '') +
    parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',') +
    (parts[1] ? '.' + parts[1] : '')
  );
}

// The cell pattern that prints a scorecard value like dmvDashboardNumber_.
function dmvDashboardPattern_(value, type) {
  if (type === 'percent') return { type: 'PERCENT', pattern: '0.00%' };
  var number = Math.abs(Number(value)) || 0;
  var whole = number >= 1000 || (type !== 'currency' && number % 1 === 0);
  return {
    type: 'NUMBER',
    pattern: whole ? '#,##0' : type !== 'currency' && number < 1 ? '0.0000' : '#,##0.00',
  };
}

// One decimal, half up, as a 0.0% cell shows the same fraction.
function dmvDashboardPercent_(fraction) {
  return (Math.round(Math.abs(fraction) * 1000 + 1e-9) / 10).toFixed(1) + '%';
}

// The change line of a scorecard, shared by the card, the highlights and the chat result.
function dmvDashboardChangeText_(card) {
  if (dmvDashboardBlank_(card.value) && !dmvDashboardBlank_(card.previous))
    return { text: 'no current value', delta: null };
  if (card.previous === null || card.previous === undefined)
    return { text: 'no previous value', delta: null };
  if (card.delta === null || card.delta === undefined)
    return {
      text: Number(card.previous) === 0 ? 'previous 0' : 'no previous value',
      delta: null,
    };
  return {
    text:
      (card.delta > 0 ? '▲ ' : card.delta < 0 ? '▼ ' : '▶ ') +
      dmvDashboardPercent_(card.delta) +
      ' vs ' +
      dmvDashboardNumber_(card.previous, card.type),
    delta: card.delta,
  };
}

// One scorecard per metric, ratio or formula, split by currency when the money is mixed. A
// formula's card is computed over the overall sums, a true total. A compared tile
// summarizes each side over all of its datasets; the previous side's value with the same
// currency supplies the change.
function dmvDashboardCards_(context, resultId, tile) {
  var session = context.session,
    top = dmvDashboardTileTop_(context, tile),
    cards = [];
  var inputs = tile.compare
    ? {
        current: dmvDashboardSide_(
          context,
          resultId,
          dmvDashboardSideLabels_(context, tile, 'current')
        ),
        previous: dmvDashboardSide_(
          context,
          resultId,
          dmvDashboardSideLabels_(context, tile, 'previous'),
          dmvDashboardRenamed_(context, tile)
        ),
      }
    : { current: resultId };
  function values(input, spec) {
    var summary = dmvDashboardSummarize_(
      session,
      input,
      Object.assign({ filters: tile.filters, limit: 50, groupBy: [] }, spec)
    );
    // The value is the last column; a formula's ratios and earlier formulas come before it.
    var value = summary.columns[summary.columns.length - 1];
    var splits = summary.columns.filter(function (column) {
      return column.role === 'dimension';
    });
    // Money always names its currency, so neither a reader nor the chat has to guess it.
    var single = value.type === 'currency' ? (summary.metadata || {}).currency || '' : '';
    // A filter that leaves no rows still shows its cards: a count or sum of nothing is 0, a
    // rate of nothing is blank.
    if (!summary.rows.length) {
      var metric = (spec.metrics || [])[0];
      return [
        {
          column: value,
          split: single,
          value: metric && ['sum', 'count', 'count_distinct'].indexOf(metric.agg) >= 0 ? 0 : '',
          empty: true,
        },
      ];
    }
    return summary.rows.map(function (row) {
      return {
        column: value,
        split: splits.length
          ? splits
              .map(function (column) {
                return row[column.key];
              })
              .join(' · ')
          : single,
        value: row[value.key],
      };
    });
  }
  tile.metrics
    .map(function (metric) {
      return { key: metric.field, spec: { metrics: [metric] } };
    })
    .concat(
      (tile.ratios || []).map(function (ratio) {
        return { key: ratio.key, spec: { metrics: [], ratios: [ratio] } };
      }),
      (tile.formulas || []).map(function (formula) {
        var needs = dmvDashboardNeeds_(tile, formula.key);
        return {
          key: formula.key,
          spec: { metrics: [], ratios: needs.ratios, formulas: needs.formulas },
        };
      })
    )
    .forEach(function (item) {
      var previous = Object.create(null),
        now = values(inputs.current, item.spec),
        before = inputs.previous ? values(inputs.previous, item.spec) : [];
      // A side without rows knows no currency: it takes the other side's when that has one.
      [
        [now, before],
        [before, now],
      ].forEach(function (sides) {
        if (sides[0].length === 1 && sides[0][0].empty && sides[1].length === 1)
          sides[0][0].split = sides[1][0].split;
      });
      before.forEach(function (entry) {
        previous[entry.split] = entry.value;
      });
      now.forEach(function (entry) {
        // A total over a dataset cut to its top rows says so: "Spend (AED, top 100)".
        var aside = [entry.split, top ? top.label : ''].filter(Boolean).join(', ');
        var card = {
          key: item.key,
          label: dmvDashboardLabel_(entry.column.label) + (aside ? ' (' + aside + ')' : ''),
          value: dmvDashboardBlank_(entry.value) ? '' : entry.value,
          type: entry.column.type,
        };
        if (inputs.previous)
          card.previous = dmvDashboardBlank_(previous[entry.split]) ? null : previous[entry.split];
        cards.push(card);
      });
    });
  return cards;
}

// The chat reads the change as the card prints it, with a sign instead of the arrow.
function dmvDashboardChange_(card) {
  var change = dmvDashboardChangeText_(card);
  if (change.delta === null) return change.text;
  return (
    (change.delta > 0 ? '+' : change.delta < 0 ? '-' : '') + change.text.replace(/^[▲▼▶] /, '')
  );
}

// A metric column is "<field>__<agg>"; a ratio column is its own key.
function dmvDashboardValueName_(column) {
  return column.key.replace(/__(sum|avg|min|max|count|count_distinct)$/, '');
}

// Styles every series of a chart table by position: current series take the categorical colours
// in order; a previous-period twin takes its series' hue (grey beside a single series) and is
// dashed where Sheets can dash it, lighter where it cannot.
function dmvDashboardSeriesColors_(series) {
  var current = series.filter(function (item) {
    return !item.previous;
  });
  series.forEach(function (item) {
    var index = current.indexOf(item.previous ? item.of : item);
    item.color = DMV_DASHBOARD_STYLE.series[index % DMV_DASHBOARD_STYLE.series.length];
    if (item.previous && current.length === 1) item.color = DMV_DASHBOARD_STYLE.previous;
  });
  return series;
}

// Values far apart in size flatten each other on one axis: anything at least 20 times smaller
// than the largest moves to the right axis, unless the plan placed its values itself.
function dmvDashboardAutoAxis_(tile, block) {
  if (
    tile.secondaryAxis ||
    tile.stacked ||
    ['line', 'column', 'area'].indexOf(tile.type) < 0 ||
    tile.groupBy.length > 1
  )
    return;
  var current = block.series.filter(function (item) {
    return !item.previous;
  });
  if (current.length < 2) return;
  var peaks = current.map(function (item) {
    var column = block.series.indexOf(item) + 1;
    return block.matrix.slice(1).reduce(function (peak, line) {
      var value = Math.abs(Number(line[column]));
      return line[column] !== '' && isFinite(value) ? Math.max(peak, value) : peak;
    }, 0);
  });
  var top = Math.max.apply(null, peaks);
  if (!(top > 0)) return;
  current.forEach(function (item, index) {
    item.right = peaks[index] * 20 <= top;
  });
  block.series.forEach(function (item) {
    if (item.previous) item.right = item.of.right;
  });
}

// A chart reads a wide table: the axis column, then one column per series.
function dmvDashboardChartTable_(context, resultId, tile) {
  if (tile.compare) return dmvDashboardCompareChart_(context, resultId, tile);
  var session = context.session;
  var base = dmvChatResult_(session, resultId);
  var axis = dmvChatColumn_(base, tile.groupBy[0], 'groupBy column');
  var summary = dmvDashboardSummarize_(session, resultId, {
    groupBy: tile.groupBy,
    dateBucket: tile.dateBucket,
    metrics: tile.metrics,
    ratios: tile.ratios,
    formulas: tile.formulas,
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
  var currency = (summary.metadata || {}).currencyColumn;
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
          label: label,
          split: split,
          type: column.type,
          total: 0,
          currency: currency && !dmvDashboardBlank_(row[currency]) ? String(row[currency]) : '',
          right: (tile.secondaryAxis || []).indexOf(dmvDashboardValueName_(column)) >= 0,
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
  // A filter that leaves no rows still draws its card: an empty chart, not a failed refresh.
  var empty = !points.length;
  if (empty) {
    points.push({ x: '', values: Object.create(null), total: 0 });
    values.forEach(function (column) {
      var label = String(column.label || column.key);
      series.push({ name: label, label: label, split: '', type: column.type, total: 0 });
    });
  }
  var note = '';
  // Amounts in different currencies are never ranked against each other: series and categories
  // rank within their currency, and the best rank in any currency decides.
  var byCurrency =
    !!currency &&
    splits.some(function (column) {
      return column.key === currency;
    });
  if (series.length > DMV_DASHBOARD.maxSeries) {
    note = 'top ' + DMV_DASHBOARD.maxSeries + ' of ' + series.length + ' series';
    series = dmvDashboardRanked_(
      series,
      function (item) {
        return byCurrency ? item.currency : '';
      },
      function (item) {
        return item.total;
      }
    ).slice(0, DMV_DASHBOARD.maxSeries);
  }
  var dated = axis.type === 'date';
  // The largest category's share of the whole, before any category is cut, for a highlight.
  var concentration = null;
  if (
    ['bar', 'column', 'pie'].indexOf(tile.type) >= 0 &&
    !dated &&
    !splits.length &&
    values.length === 1 &&
    /__sum$/.test(values[0].key) &&
    points.length >= 2
  ) {
    var name = series[0].name,
      total = 0,
      top = null,
      negative = false;
    points.forEach(function (point) {
      var value = Number(point.values[name]);
      if (dmvDashboardBlank_(point.values[name]) || !isFinite(value)) return;
      if (value < 0) negative = true;
      total += value;
      if (!top || value > Number(top.values[name])) top = point;
    });
    if (!negative && total > 0 && top && Number(top.values[name]) / total >= 0.3)
      concentration = {
        x: top.x,
        share: Number(top.values[name]) / total,
        label: dmvDashboardLabel_(name),
      };
  }
  var ascending = tile.orderBy && tile.orderBy.direction === 'asc' ? 1 : -1;
  if (dated)
    points.sort(function (a, b) {
      return a.x < b.x ? -1 : a.x > b.x ? 1 : 0;
    });
  else if (byCurrency) {
    var best = Object.create(null);
    series.forEach(function (item) {
      points
        .filter(function (point) {
          var value = point.values[item.name];
          return !dmvDashboardBlank_(value) && isFinite(Number(value));
        })
        .sort(function (a, b) {
          return (
            (Math.abs(Number(a.values[item.name])) - Math.abs(Number(b.values[item.name]))) *
            ascending
          );
        })
        .forEach(function (point, rank) {
          var key = JSON.stringify(point.x);
          best[key] = Math.min(best[key] === undefined ? Infinity : best[key], rank);
        });
    });
    var rankOf = function (point) {
      var rank = best[JSON.stringify(point.x)];
      return rank === undefined ? Infinity : rank;
    };
    points.sort(function (a, b) {
      return rankOf(a) - rankOf(b) || (a.total - b.total) * ascending;
    });
  } else
    points.sort(function (a, b) {
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
  // The chart data tab shows provider codes as words, dates as short days or months and the
  // days of a first or last bucket the period only partly covers; the chat reads the raw keys.
  var words = dmvDashboardWords_(
    points.map(function (point) {
      return point.x;
    })
  );
  var splitWords = dmvDashboardWords_(
    series.map(function (item) {
      return item.split;
    })
  );
  var ranges = tile.datasets
    .map(function (id) {
      return context.ranges[id];
    })
    .filter(Boolean);
  var block = {
    columns: columns,
    matrix: matrix,
    labels: points.map(function (point) {
      return dated
        ? dmvDashboardAxisLabel_(point.x, matrix, tile.dateBucket, ranges)
        : words(point.x);
    }),
    names: series.map(function (item) {
      if (!item.split) return dmvDashboardLabel_(item.name);
      var split = splitWords(item.split);
      return dmvDashboardLabel_(values.length > 1 ? item.label + ' · ' + split : split);
    }),
    note: empty ? 'no rows in this period' : note,
    unit: dmvDashboardUnit_(series, summary),
    series: dmvDashboardSeriesColors_(
      series.map(function (item) {
        return { name: item.name, type: item.type, right: item.right, previous: false };
      })
    ),
    stacked: !!tile.stacked,
    full: tile.width === 'full',
    dated: dated,
    concentration: concentration && {
      name: String(words(concentration.x)),
      share: concentration.share,
      label: concentration.label,
    },
  };
  dmvDashboardAutoAxis_(tile, block);
  return block;
}

// Items ranked by score, highest first, within their group: the best of every group, then the
// second of every group, and so on.
function dmvDashboardRanked_(items, groupOf, score) {
  var ranks = [],
    counts = Object.create(null);
  items
    .map(function (item, index) {
      return { item: item, index: index };
    })
    .sort(function (a, b) {
      return score(b.item) - score(a.item) || a.index - b.index;
    })
    .forEach(function (entry) {
      var group = groupOf(entry.item);
      counts[group] = (counts[group] || 0) + 1;
      ranks[entry.index] = counts[group];
    });
  return items
    .map(function (item, index) {
      return { item: item, rank: ranks[index], index: index };
    })
    .sort(function (a, b) {
      return a.rank - b.rank || a.index - b.index;
    })
    .map(function (entry) {
      return entry.item;
    });
}

// The currency of a chart's money, for its card, when every series is money in one currency.
function dmvDashboardUnit_(series, summary) {
  var money =
    series.length &&
    series.every(function (item) {
      return item.type === 'currency';
    });
  return money ? (summary.metadata || {}).currency || '' : '';
}

// Provider codes such as PERFORMANCE_MAX or HEADLINE read as words on the page. A list is read
// that way only when every value looks like a code and one is longer than a currency or country
// code; a value of many parts is a name, not a code.
function dmvDashboardWords_(list) {
  var texts = list.filter(function (value) {
    return !dmvDashboardBlank_(value);
  });
  var codes =
    !!texts.length &&
    texts.every(function (value) {
      return (
        typeof value === 'string' &&
        /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/.test(value) &&
        value.split('_').length <= 3
      );
    }) &&
    texts.some(function (value) {
      return value.length >= 4;
    });
  return function (value) {
    return codes && typeof value === 'string' && value ? dmvDashboardWord_(value) : value;
  };
}

function dmvDashboardWord_(code) {
  var text = String(code).replace(/_/g, ' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// A date bucket as a short label: "1 Sep" (with its year when the chart spans two years) or
// "Sep 2026" for a month, plus the days a partly covered week or month holds.
function dmvDashboardAxisLabel_(value, matrix, bucket, ranges) {
  var text = String(value);
  var years = Object.create(null);
  matrix.slice(1).forEach(function (line) {
    years[String(line[0]).slice(0, 4)] = true;
  });
  var label = text;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text))
    label =
      Number(text.slice(8, 10)) +
      ' ' +
      DMV_DASHBOARD_MONTHS[Number(text.slice(5, 7)) - 1] +
      (Object.keys(years).length > 1 ? ' ' + text.slice(0, 4) : '');
  else if (/^\d{4}-\d{2}$/.test(text))
    label = DMV_DASHBOARD_MONTHS[Number(text.slice(5, 7)) - 1] + ' ' + text.slice(0, 4);
  var first = bucket === 'week' ? text : text.slice(0, 7) + '-01';
  if (!ranges.length || ['week', 'month'].indexOf(bucket) < 0 || !/^\d{4}-\d{2}-\d{2}$/.test(first))
    return label;
  var time = function (date) {
    return Date.parse(date + 'T12:00:00Z');
  };
  var start = ranges
    .map(function (range) {
      return range.startDate;
    })
    .sort()[0];
  var end = ranges
    .map(function (range) {
      return range.endDate;
    })
    .sort()
    .slice(-1)[0];
  var last =
    bucket === 'week'
      ? new Date(time(first) + 6 * 86400000).toISOString().slice(0, 10)
      : new Date(Date.UTC(Number(first.slice(0, 4)), Number(first.slice(5, 7)), 0, 12))
          .toISOString()
          .slice(0, 10);
  var from = first < start ? start : first,
    to = last > end ? end : last;
  var days = Math.round((time(to) - time(from)) / 86400000) + 1,
    whole = Math.round((time(last) - time(first)) / 86400000) + 1;
  return days > 0 && days < whole ? label + ' (' + days + (days === 1 ? ' day)' : ' days)') : label;
}

// Whole days, weeks, months or years from the first day of a period to a date within it.
function dmvDashboardBucket_(date, start, bucket) {
  var days = Math.round(
    (Date.parse(date + 'T12:00:00Z') - Date.parse(start + 'T12:00:00Z')) / 86400000
  );
  if (bucket === 'day') return days;
  if (bucket === 'week') return Math.floor(days / 7);
  var part = function (text, from, to) {
    return Number(text.slice(from, to));
  };
  var months =
    (part(date, 0, 4) - part(start, 0, 4)) * 12 +
    part(date, 5, 7) -
    part(start, 5, 7) -
    (part(date, 8, 10) < part(start, 8, 10) ? 1 : 0);
  return bucket === 'month' ? months : Math.floor(months / 12);
}

// The first day of a bucket, counted from the first day of the current period. A month or year
// bucket that starts on the first of a month reads as that month or year.
function dmvDashboardBucketLabel_(start, index, bucket) {
  if (bucket === 'day' || bucket === 'week')
    return new Date(
      Date.parse(start + 'T12:00:00Z') + index * (bucket === 'week' ? 7 : 1) * 86400000
    )
      .toISOString()
      .slice(0, 10);
  var day = Number(start.slice(8, 10));
  var month = new Date(
    Date.UTC(
      Number(start.slice(0, 4)),
      Number(start.slice(5, 7)) - 1 + index * (bucket === 'year' ? 12 : 1),
      1,
      12
    )
  );
  var text = month.toISOString().slice(0, 7);
  if (day === 1) return bucket === 'year' && text.slice(5) === '01' ? text.slice(0, 4) : text;
  var last = new Date(
    Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0, 12)
  ).getUTCDate();
  return text + '-' + ('0' + Math.min(day, last)).slice(-2);
}

// A chart over dates against the previous period. Each side's days count from the first day of
// their own dataset's period and are bucketed by that offset, so the first week of this period
// sits above the first week of the last one even when their calendar weeks differ. Sums add up
// per bucket, averages are weighted by their counts, ratios divide their summed parts and
// formulas are evaluated over them.
function dmvDashboardCompareChart_(context, resultId, tile) {
  var session = context.session,
    bucket = tile.dateBucket,
    name = '"' + tile.title + '"';
  var base = dmvChatResult_(session, resultId);
  var axis = dmvChatColumn_(base, tile.groupBy[0], 'groupBy column');
  if (axis.type !== 'date')
    throw new Error(
      name + ': a compared chart needs a date column on its axis, and ' + axis.key + ' is not one.'
    );
  var parts = [],
    partKeys = [];
  function part(field, agg) {
    var column = dmvChatColumn_(base, field, 'metric').key,
      key = column + '__' + agg;
    if (partKeys.indexOf(key) < 0) {
      partKeys.push(key);
      parts.push({ field: field, agg: agg, column: column });
    }
    return key;
  }
  var prefixes = { avg: 'Avg ', min: 'Min ', max: 'Max ', count: 'Count of ' };
  var specs = tile.metrics
    .map(function (metric) {
      var column = dmvChatColumn_(base, metric.field, 'metric');
      var label = column.label || column.key;
      return {
        name: metric.field,
        agg: metric.agg,
        label: metric.agg === 'sum' ? label : prefixes[metric.agg] + label,
        type: metric.agg === 'count' ? 'number' : column.type,
        value: part(metric.field, metric.agg),
        count: metric.agg === 'avg' ? part(metric.field, 'count') : null,
      };
    })
    .concat(
      (tile.ratios || []).map(function (ratio) {
        var money = [ratio.numerator, ratio.denominator].filter(function (field) {
          return dmvChatColumn_(base, field, 'ratio column').type === 'currency';
        }).length;
        return {
          name: ratio.key,
          agg: 'ratio',
          label: ratio.label || ratio.key,
          type: money === 1 ? 'currency' : ratio.percent ? 'percent' : 'number',
          numerator: part(ratio.numerator, 'sum'),
          denominator: part(ratio.denominator, 'sum'),
        };
      })
    );
  // Formulas evaluate per bucket over its sums, its ratios and the formulas before them.
  var compiled = dmvDashboardCompile_(base, tile.ratios, tile.formulas);
  compiled.forEach(function (formula) {
    formula.sums.forEach(function (key) {
      part(key, 'sum');
    });
    specs.push({
      name: formula.key,
      agg: 'formula',
      label: formula.label,
      type: formula.type,
      formula: formula,
    });
  });
  // The previous side's rows carry the labels of the current datasets they stand for; each row
  // still counts its days from its own dataset's first day.
  var renamed = dmvDashboardRenamed_(context, tile);
  var labelOf = function (side, id, index) {
    return side === 'previous' && renamed ? renamed[index] : context.labels[id];
  };
  var sides = ['current', 'previous'].map(function (side) {
    var labels = dmvDashboardSideLabels_(context, tile, side),
      starts = Object.create(null),
      ranges = [];
    dmvDashboardIds_(tile.compare[side]).forEach(function (id, index) {
      var range = context.ranges[id];
      if (!range)
        throw new Error(
          name +
            ': a compared chart needs the period of every compared dataset, and ' +
            context.labels[id] +
            ' has no date range.'
        );
      starts[labelOf(side, id, index)] = range.startDate;
      ranges.push(range);
    });
    return {
      starts: starts,
      ranges: ranges,
      input: dmvDashboardSide_(context, resultId, labels, side === 'previous' ? renamed : null),
      cells: Object.create(null),
    };
  });
  // Each previous dataset keeps as many days as the current one it is paired with, so a 31-day
  // month does not add a day to the line, nor a third day to a two-day last week.
  var time = function (date) {
    return Date.parse(date + 'T12:00:00Z');
  };
  var length = function (range) {
    return Math.round((time(range.endDate) - time(range.startDate)) / 86400000) + 1;
  };
  var longest = Math.max.apply(null, sides[0].ranges.map(length));
  var keep = Object.create(null);
  dmvDashboardIds_(tile.compare.previous).forEach(function (id, index) {
    keep[labelOf('previous', id, index)] = longest;
  });
  (dmvDashboardPairs_(context.datasets, tile) || []).forEach(function (pair) {
    keep[pair.current.label] = length(context.ranges[pair.current.id]);
  });
  var trimmed = false,
    sameDays = ['day', 'week'].indexOf(bucket) >= 0;
  var splits = [];
  sides.forEach(function (side, index) {
    var summary = dmvDashboardSummarize_(session, side.input, {
      groupBy: [axis.key, 'source'],
      dateBucket: 'day',
      metrics: parts.map(function (item) {
        return { field: item.field, agg: item.agg };
      }),
      filters: tile.filters,
      limit: DMV_CHAT_RESULTS.maxSummaryRows,
    });
    // Money in several currencies comes back split by currency: one series per currency.
    var extra = summary.columns
      .filter(function (column) {
        return column.role === 'dimension';
      })
      .slice(2);
    summary.rows.forEach(function (row) {
      var day = String(row[axis.key] || ''),
        start = side.starts[row.source];
      if (!start || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
      var at = dmvDashboardBucket_(day, start, bucket);
      if (at < 0) return;
      if (index && sameDays && dmvDashboardBucket_(day, start, 'day') >= keep[row.source]) {
        trimmed = true;
        return;
      }
      var split = extra
        .map(function (column) {
          return dmvDashboardBlank_(row[column.key]) ? '' : String(row[column.key]);
        })
        .join(' · ');
      if (splits.indexOf(split) < 0) splits.push(split);
      var cell =
        side.cells[at + '|' + split] || (side.cells[at + '|' + split] = Object.create(null));
      partKeys.forEach(function (key) {
        if (dmvDashboardBlank_(row[key]) || !isFinite(Number(row[key]))) return;
        var value = Number(row[key]);
        var slot = cell[key] || (cell[key] = { sum: 0, n: 0, min: null, max: null, weighted: 0 });
        slot.sum += value;
        slot.n++;
        if (slot.min === null || value < slot.min) slot.min = value;
        if (slot.max === null || value > slot.max) slot.max = value;
      });
      specs.forEach(function (spec) {
        if (spec.agg === 'avg' && cell[spec.value] && !dmvDashboardBlank_(row[spec.value]))
          cell[spec.value].weighted += Number(row[spec.value]) * (Number(row[spec.count]) || 0);
      });
    });
  });
  // A filter that leaves no rows still draws its card: an empty chart, not a failed refresh.
  var empty = !splits.length;
  if (empty) splits.push('');
  function valueAt(cell, spec) {
    var get = function (key) {
      return (cell && cell[key]) || null;
    };
    var out = null;
    if (spec.agg === 'formula') {
      var values = Object.create(null);
      partKeys.forEach(function (key, index) {
        if (parts[index].agg === 'sum')
          values[parts[index].column] = get(key) && get(key).n ? get(key).sum : null;
      });
      specs.forEach(function (other) {
        if (other.agg !== 'ratio') return;
        var top = get(other.numerator),
          bottom = get(other.denominator);
        values[other.name] = top && top.n && bottom && bottom.sum ? top.sum / bottom.sum : null;
      });
      out = dmvFormulaEvaluateAll_(compiled, values)[spec.name];
    } else if (spec.agg === 'ratio') {
      var above = get(spec.numerator),
        below = get(spec.denominator);
      out = above && above.n && below && below.sum ? above.sum / below.sum : null;
    } else if (spec.agg === 'avg') {
      var count = get(spec.count);
      out = get(spec.value) && count && count.sum ? get(spec.value).weighted / count.sum : null;
    } else if (spec.agg === 'min' || spec.agg === 'max')
      out = get(spec.value) ? get(spec.value)[spec.agg] : null;
    else out = get(spec.value) ? get(spec.value).sum : null;
    return out === null ? '' : Math.round(out * 10000) / 10000;
  }
  // The axis is the current period's buckets, labelled by their first days.
  var origin = sides[0].ranges
    .map(function (range) {
      return range.startDate;
    })
    .sort()[0];
  var count = Math.max.apply(
    null,
    sides[0].ranges.map(function (range) {
      return dmvDashboardBucket_(range.endDate, range.startDate, bucket) + 1;
    })
  );
  var words = dmvDashboardWords_(splits);
  var series = [];
  specs.forEach(function (spec) {
    splits.forEach(function (split) {
      series.push({
        name: !split ? spec.label : specs.length > 1 ? spec.label + ' · ' + split : split,
        spec: spec,
        split: split,
        type: spec.type,
        right: (tile.secondaryAxis || []).indexOf(spec.name) >= 0,
        previous: false,
      });
    });
  });
  var note = '';
  var room = DMV_DASHBOARD.maxSeries / 2;
  if (series.length > room) {
    note = 'first ' + room + ' of ' + series.length + ' series';
    series = series.slice(0, room);
  }
  var ordered = [];
  series.forEach(function (item) {
    ordered.push(item);
    ordered.push({
      name: item.name + ' (previous period)',
      spec: item.spec,
      split: item.split,
      type: item.type,
      right: item.right,
      previous: true,
      of: item,
    });
  });
  var first = Math.max(0, count - DMV_DASHBOARD.datePoints);
  if (first) note = (note ? note + ', ' : '') + 'latest ' + (count - first) + ' of ' + count;
  var compared = dmvDashboardIds_(tile.compare.previous).map(function (id, index) {
    var range = context.ranges[id],
      days = keep[labelOf('previous', id, index)];
    if (!trimmed || length(range) <= days) return range;
    return {
      startDate: range.startDate,
      endDate: new Date(time(range.startDate) + (days - 1) * 86400000).toISOString().slice(0, 10),
    };
  });
  var matrix = [
    [dmvDashboardLabel_(axis.label || axis.key)].concat(
      ordered.map(function (item) {
        return dmvDashboardLabel_(item.name);
      })
    ),
  ];
  for (var i = first; i < count; i++)
    matrix.push(
      [dmvDashboardBucketLabel_(origin, i, bucket)].concat(
        ordered.map(function (item) {
          return valueAt(sides[item.previous ? 1 : 0].cells[i + '|' + item.split], item.spec);
        })
      )
    );
  var block = {
    columns: [
      { key: 'x', label: axis.label || axis.key, type: bucket === 'day' ? 'date' : 'text' },
    ].concat(
      ordered.map(function (item) {
        return { key: item.name, label: item.name, type: item.type };
      })
    ),
    matrix: matrix,
    labels: matrix.slice(1).map(function (line, index) {
      var label = dmvDashboardAxisLabel_(line[0], matrix, 'day', []);
      // The last week of a period may be short; both periods keep the same days of it.
      var days = longest - (first + index) * 7;
      return bucket === 'week' && first + index === count - 1 && days < 7
        ? label + ' (' + days + (days === 1 ? ' day)' : ' days)')
        : label;
    }),
    names: ordered.map(function (item) {
      var split = words(item.split);
      return dmvDashboardLabel_(
        (!split ? item.spec.label : specs.length > 1 ? item.spec.label + ' · ' + split : split) +
          (item.previous ? ' (previous period)' : '')
      );
    }),
    note: empty
      ? 'no rows in this period'
      : note || 'vs ' + dmvDashboardPeriod_(compared) + (trimmed ? ' (same days)' : ''),
    unit:
      !empty &&
      splits.length === 1 &&
      !splits[0] &&
      specs.every(function (spec) {
        return spec.type === 'currency';
      })
        ? (dmvChatResult_(session, sides[0].input).metadata || {}).currency || ''
        : '',
    series: dmvDashboardSeriesColors_(ordered),
    stacked: false,
    full: tile.width === 'full',
    dated: true,
  };
  dmvDashboardAutoAxis_(tile, block);
  return block;
}

// What the chat reads of a tile to state findings: its whole header and first rows (the
// latest points of a trend), within a size that lets every tile of a dashboard fit one tool
// result. Rows beyond the budget are dropped, least relevant first.
function dmvDashboardPreview_(block) {
  var width = DMV_DASHBOARD.previewColumns;
  var cell = function (value) {
    return typeof value === 'string' && value.length > DMV_DASHBOARD.previewChars
      ? value.slice(0, DMV_DASHBOARD.previewChars) + '…'
      : value;
  };
  var rows = block.matrix.slice(1);
  rows = block.dated
    ? rows.slice(-DMV_DASHBOARD.previewRows)
    : rows.slice(0, DMV_DASHBOARD.previewRows);
  var preview = [block.matrix[0].slice(0, width)].concat(
    rows.map(function (row) {
      return row.slice(0, width).map(cell);
    })
  );
  while (preview.length > 2 && JSON.stringify(preview).length > DMV_DASHBOARD.previewTileChars)
    preview.splice(block.dated ? 1 : preview.length - 1, 1);
  return preview;
}

// A table tile: its rows, an overall total (one summarize without groupBy, so ratios and
// formulas are true overall values and money stays split by currency), the change of every value against the
// previous period when compared, the rows its highlight rules flag and an in-cell bar.
function dmvDashboardTable_(context, resultId, tile) {
  var session = context.session;
  var base = dmvChatResult_(session, resultId);
  var current = resultId,
    previous = null,
    caveat = '';
  if (tile.compare) {
    var now = dmvDashboardSideLabels_(context, tile, 'current'),
      before = dmvDashboardSideLabels_(context, tile, 'previous');
    current = dmvDashboardSide_(context, resultId, now);
    if (
      tile.groupBy.some(function (name) {
        return dmvChatColumn_(base, name, 'groupBy column').type === 'date';
      })
    )
      // Dates of two periods never match; a plan saved before this was refused shows its rows.
      caveat = 'no change: rows are dates';
    else
      previous = dmvDashboardSide_(context, resultId, before, dmvDashboardRenamed_(context, tile));
  }
  var spec = {
    groupBy: tile.groupBy,
    dateBucket: tile.dateBucket,
    metrics: tile.metrics,
    limit: tile.limit || DMV_DASHBOARD.tableRows,
  };
  ['orderBy', 'rankWithin', 'limitPerGroup', 'ratios', 'formulas', 'filters'].forEach(
    function (key) {
      if (tile[key] !== undefined) spec[key] = tile[key];
    }
  );
  var summary = dmvDashboardSummarize_(session, current, spec);
  var normalized = dmvNormalizeResult_(summary, DMV_DASHBOARD.maxTableRows);
  var metadata = summary.metadata || {};
  normalized.matrix[0] = normalized.matrix[0].map(dmvDashboardLabel_);
  var currency = metadata.currencyColumn;
  var dims = [],
    values = [];
  summary.columns.forEach(function (column) {
    var item = {
      key: column.key,
      label: dmvDashboardLabel_(column.label || column.key),
      type: column.type,
    };
    if (column.role === 'dimension') {
      var origin = base.columns.filter(function (other) {
        return other.key === column.key;
      })[0];
      item.short = !!currency && column.key === currency;
      item.date = !!origin && origin.type === 'date';
      item.numeric = dmvChatNumeric_(column);
      dims.push(item);
    } else {
      // A value is named like the plan names it: a metric by its field, a ratio or formula by
      // its key.
      var formula = (tile.formulas || []).some(function (entry) {
        return entry.key === column.key;
      });
      var metric =
        formula ||
        (tile.ratios || []).some(function (ratio) {
          return ratio.key === column.key;
        })
          ? null
          : tile.metrics.filter(function (entry) {
              return (
                dmvChatColumn_(base, entry.field, 'metric').key + '__' + entry.agg === column.key
              );
            })[0];
      item.name = metric ? metric.field : column.key;
      item.agg = metric ? metric.agg : formula ? 'formula' : 'ratio';
      // Rates, averages and formulas are shaded by rank; amounts get the bar instead.
      item.heat = item.agg === 'ratio' || item.agg === 'avg' || item.agg === 'formula';
      values.push(item);
    }
  });
  var currencyOf = function (row) {
    return currency && !dmvDashboardBlank_(row[currency]) ? String(row[currency]) : '';
  };
  var entries = summary.rows.map(function (row) {
    return { values: row, deltas: {}, tint: null, bar: '' };
  });
  // A row is named by its leading names, as many of them as tell the rows apart; provider codes
  // read as words. The source (the dataset label) comes last, so a name leads with the keyword
  // or asset and names the account only where two rows differ by it alone.
  var naming = dims
    .filter(function (dim) {
      return !dim.short && dim.key !== 'source';
    })
    .concat(
      dims.filter(function (dim) {
        return !dim.short && dim.key === 'source';
      })
    );
  dims.forEach(function (dim) {
    dim.words = dim.short
      ? function (value) {
          return value;
        }
      : dmvDashboardWords_(
          entries.map(function (entry) {
            return entry.values[dim.key];
          })
        );
  });
  var nameOf = function (row, depth, skip) {
    return naming
      .slice(0, depth)
      .filter(function (dim) {
        return dim !== skip;
      })
      .map(function (dim) {
        return dmvDashboardBlank_(row[dim.key]) ? '' : String(dim.words(row[dim.key]));
      })
      .join(' · ');
  };
  var depth = 1;
  while (
    depth < naming.length &&
    entries.some(function (entry, index) {
      return entries.some(function (other, before) {
        return before < index && nameOf(other.values, depth) === nameOf(entry.values, depth);
      });
    })
  )
    depth++;
  // A cut table says so, and its total says it covers every group, not only the rows shown.
  var note = metadata.perCurrency
    ? 'top ' + metadata.perCurrency.limit + ' per currency of ' + metadata.perCurrency.groups
    : metadata.rankedGroups > summary.rows.length ||
        (!metadata.ranking && metadata.totalGroups > summary.rows.length)
      ? 'top ' + summary.rows.length + ' of ' + (metadata.rankedGroups || metadata.totalGroups)
      : '';
  var groups = metadata.totalGroups > summary.rows.length ? metadata.totalGroups : 0;
  // Totals and the previous period's values, by currency (or '' when the money is not split).
  // Without a name column the rows are the totals already.
  function overall(input) {
    if (!values.length) return [];
    var whole = dmvDashboardSummarize_(session, input, {
      groupBy: [],
      metrics: tile.metrics,
      ratios: tile.ratios,
      formulas: tile.formulas,
      filters: tile.filters,
      limit: 50,
    });
    var split = (whole.metadata || {}).currencyColumn;
    return whole.rows.map(function (row) {
      return { values: row, currency: split ? String(row[split]) : '', deltas: {} };
    });
  }
  function totalOf(list, row) {
    return (
      list.filter(function (total) {
        return !total.currency || total.currency === currencyOf(row);
      })[0] || null
    );
  }
  var totals = naming.length ? overall(current) : [];
  if (previous) {
    var past = dmvDashboardSummarize_(
      session,
      previous,
      Object.assign({}, spec, {
        orderBy: undefined,
        rankWithin: undefined,
        limitPerGroup: undefined,
        limit: DMV_CHAT_RESULTS.maxSummaryRows,
      })
    );
    // A previous period in one currency names it in metadata rather than in a column.
    var pastCurrency = (past.metadata || {}).currency;
    var key = function (row, fill) {
      return JSON.stringify(
        dims.map(function (dim) {
          var value = row[dim.key];
          return value === undefined && dim.short
            ? fill || null
            : value === undefined
              ? null
              : value;
        })
      );
    };
    var lookup = Object.create(null);
    past.rows.forEach(function (row) {
      lookup[key(row, pastCurrency)] = row;
    });
    entries.forEach(function (entry) {
      var earlier = lookup[key(entry.values)] || {};
      values.forEach(function (value) {
        entry.deltas[value.key] = dmvDashboardDelta_(entry.values[value.key], earlier[value.key]);
      });
    });
    var pastTotals = overall(previous);
    totals.forEach(function (total) {
      var earlier = pastTotals.filter(function (item) {
        return !item.currency || !total.currency || item.currency === total.currency;
      })[0] || { values: {} };
      values.forEach(function (value) {
        total.deltas[value.key] = dmvDashboardDelta_(
          total.values[value.key],
          earlier.values[value.key]
        );
      });
    });
  }
  // Highlight rules: the first rule a row meets tints it. They are counted over every row of
  // the tile, also those a cut leaves off the page, and the worst rows are named first. A rule
  // with a text value reads a name column, like a filter, and names its rows in table order.
  var matches = (tile.highlight || []).map(function (rule) {
    if (typeof rule.value === 'string') {
      var key = dmvChatColumn_(base, rule.field, 'highlight column').key;
      return {
        rule: rule,
        text: true,
        column: dims.filter(function (dim) {
          return dim.key === key;
        })[0],
        names: [],
        shown: 0,
        all: 0,
        threshold: null,
        overall: null,
      };
    }
    var column = values.filter(function (value) {
      return value.name === rule.field;
    })[0];
    var total = totals.length === 1 ? Number(totals[0].values[column.key]) : NaN;
    return {
      rule: rule,
      column: column,
      names: [],
      shown: 0,
      all: 0,
      threshold:
        rule.ofTotal === undefined ? rule.value : isFinite(total) ? total * rule.ofTotal : null,
      overall: isFinite(total) ? total : null,
    };
  });
  function rule(row) {
    var found = null;
    matches.some(function (match) {
      var value = row[match.column.key],
        threshold = match.rule.value;
      if (match.text) {
        if (!dmvChatCompare_(value, match.rule.op, threshold, false)) return false;
        found = match;
        return true;
      }
      if (dmvDashboardBlank_(value) || !isFinite(Number(value))) return false;
      if (threshold === undefined) {
        var total = totalOf(totals, row);
        var whole = total && total.values[match.column.key];
        if (dmvDashboardBlank_(whole) || !isFinite(Number(whole))) return false;
        threshold = Number(whole) * match.rule.ofTotal;
      }
      if (!dmvChatCompare_(Number(value), match.rule.op, threshold, true)) return false;
      found = match;
      return true;
    });
    return found;
  }
  entries.forEach(function (entry) {
    var match = rule(entry.values);
    if (!match) return;
    entry.tint = match.rule.color;
    match.shown++;
  });
  if (matches.length) {
    var every = groups
      ? dmvDashboardSummarize_(session, current, {
          groupBy: tile.groupBy,
          dateBucket: tile.dateBucket,
          metrics: tile.metrics,
          ratios: tile.ratios,
          formulas: tile.formulas,
          filters: tile.filters,
          limit: DMV_CHAT_RESULTS.maxSummaryRows,
        }).rows
      : summary.rows;
    var flagged = matches.map(function () {
      return [];
    });
    every.forEach(function (row) {
      var match = rule(row);
      if (!match) return;
      match.all++;
      flagged[matches.indexOf(match)].push(row);
    });
    // Rows on the page keep their places; a cut table's other rows follow them.
    var identity = function (row) {
      return JSON.stringify(
        dims.map(function (dim) {
          return row[dim.key] === undefined ? null : row[dim.key];
        })
      );
    };
    var place = Object.create(null);
    entries.forEach(function (entry, index) {
      place[identity(entry.values)] = index;
    });
    var placeOf = function (row) {
      var index = place[identity(row)];
      return index === undefined ? Infinity : index;
    };
    matches.forEach(function (match, index) {
      var down = ['lt', 'lte'].indexOf(match.rule.op) >= 0 ? 1 : -1;
      // Rows picked by the very names that name them need no list: the rule says them.
      if (
        match.text &&
        ['eq', 'in'].indexOf(match.rule.op) >= 0 &&
        depth === 1 &&
        naming[0] === match.column
      )
        return;
      match.names = flagged[index]
        .sort(function (a, b) {
          if (match.text) return placeOf(a) - placeOf(b) || 0;
          return match.rule.op === 'eq'
            ? 0
            : (Number(a[match.column.key]) - Number(b[match.column.key])) * down;
        })
        .map(function (row) {
          // A text rule with eq states the value its rows share, so their names leave it out.
          return naming.length
            ? nameOf(row, depth, match.text && match.rule.op === 'eq' ? match.column : null)
            : tile.title;
        });
    });
  }
  // The bar column follows the measure the table is ranked by, or its first summed amount.
  var ordered = null;
  if (tile.orderBy)
    try {
      ordered = dmvChatColumn_({ columns: summary.columns }, tile.orderBy.field, 'orderBy column');
    } catch (ignored) {
      ordered = null;
    }
  var primary =
    (ordered &&
      tile.orderBy.direction === 'desc' &&
      values.filter(function (value) {
        return value.key === ordered.key;
      })[0]) ||
    values.filter(function (value) {
      return value.agg === 'sum';
    })[0] ||
    null;
  if (primary && dims.length) {
    var peaks = Object.create(null);
    entries.forEach(function (entry) {
      var value = Number(entry.values[primary.key]),
        group = currencyOf(entry.values);
      if (value > 0) peaks[group] = Math.max(peaks[group] || 0, value);
    });
    entries.forEach(function (entry) {
      entry.bar = dmvDashboardBar_(
        Number(entry.values[primary.key]),
        peaks[currencyOf(entry.values)]
      );
    });
  }
  // A table ranked by an amount names its leader and that leader's share of the total.
  var lead = null;
  if (
    primary &&
    ordered &&
    primary.key === ordered.key &&
    primary.agg === 'sum' &&
    naming.length &&
    entries.length >= 2 &&
    totals.length === 1
  ) {
    var top = Number(entries[0].values[primary.key]),
      all = Number(totals[0].values[primary.key]);
    if (top > 0 && all > 0)
      lead = {
        name: nameOf(entries[0].values, depth),
        value: top,
        share: top / all,
        column: primary,
      };
  }
  return {
    columns: normalized.columns,
    matrix: normalized.matrix,
    note: [note, caveat]
      .filter(function (part) {
        return !!part;
      })
      .join(', '),
    groups: groups,
    // Money of one currency names it in its headers, as the scorecards do.
    currency: currency ? '' : metadata.currency || '',
    dims: dims,
    values: values,
    entries: entries,
    totals: totals,
    compare: !!previous,
    bar: primary && dims.length ? primary.key : null,
    matches: matches,
    lead: lead,
  };
}

// An in-cell bar of whole blocks, fifteen at most. Sheets draws the partial-block characters
// (▏ to ▉) from a fallback font of another height, which leaves a notch at the bar's end, so
// only the full block is used; set small, it still steps finely.
function dmvDashboardBar_(value, peak) {
  if (!(value > 0) || !(peak > 0)) return '';
  var blocks = Math.max(1, Math.round((Math.min(value, peak) / peak) * DMV_DASHBOARD.barBlocks));
  var bar = '';
  for (var i = 0; i < blocks; i++) bar += '█';
  return bar;
}

// The tab that holds the numbers behind the charts. It is created hidden: a refresh can then
// return any number of rows without moving anything on the dashboard itself.
function dmvDashboardChartTab_(target) {
  return target.sheetName.slice(0, 86) + ' (chart data)';
}

// "1 Sep – 30 Sep 2026" for the distinct ranges of some datasets, or "Several periods".
function dmvDashboardPeriod_(ranges) {
  var seen = Object.create(null),
    list = [];
  ranges.forEach(function (range) {
    if (!range || seen[range.startDate + '|' + range.endDate]) return;
    seen[range.startDate + '|' + range.endDate] = true;
    list.push(range);
  });
  if (list.length !== 1) return list.length ? 'Several periods' : '';
  var day = function (text, year) {
    return (
      Number(text.slice(8, 10)) +
      ' ' +
      DMV_DASHBOARD_MONTHS[Number(text.slice(5, 7)) - 1] +
      (year ? ' ' + text.slice(0, 4) : '')
    );
  };
  var start = list[0].startDate,
    end = list[0].endDate;
  if (start === end) return day(end, true);
  return day(start, start.slice(0, 4) !== end.slice(0, 4)) + ' – ' + day(end, true);
}

// Findings stated on the page and returned to the chat. They are computed from the numbers on
// the page by fixed rules, in this order: the scorecards that changed most (one when rule
// findings follow, since the cards above show every change), the rows a highlight rule flags, a
// category holding a large share of a chart, and the leader of a ranked table.
function dmvDashboardHighlights_(cards, blocks) {
  var out = [];
  // Every table's first flagging rule comes before any table's second one.
  var flagged = [];
  blocks.forEach(function (block) {
    (block.matches || []).forEach(function (match) {
      if (match.all) flagged.push({ block: block, match: match });
    });
  });
  flagged.forEach(function (item, index) {
    item.rank = item.block.matches.indexOf(item.match) * 1000 + index;
  });
  flagged.sort(function (a, b) {
    return a.rank - b.rank;
  });
  cards
    .filter(function (card) {
      return card.delta;
    })
    .sort(function (a, b) {
      return Math.abs(b.delta) - Math.abs(a.delta);
    })
    .slice(0, flagged.length ? 1 : 2)
    .forEach(function (card) {
      out.push({
        text:
          card.label +
          (card.delta > 0 ? ' rose ' : ' fell ') +
          dmvDashboardPercent_(card.delta) +
          ' to ' +
          dmvDashboardNumber_(card.value, card.type) +
          ' (previous ' +
          dmvDashboardNumber_(card.previous, card.type) +
          ').',
        tone: card.tone,
      });
    });
  // A sentence fits one line of the page: fewer names before it is cut.
  var room =
    dmvDashboardSpan_(DMV_DASHBOARD.gridColumns) -
    2 * DMV_DASHBOARD.inset -
    2 * DMV_DASHBOARD.gapWidth;
  // Rows counted over a dataset cut to its top rows are counted "in the top 100", not in all.
  flagged.forEach(function (item) {
    var block = item.block,
      match = item.match,
      within = block.top ? 'the ' + block.top.label : '';
    var lead =
      dmvDashboardTitle_(block.title) +
      ': ' +
      match.shown +
      ' of ' +
      block.entries.length +
      ' rows' +
      (block.groups
        ? ' (' + match.all + ' of ' + block.groups + ' in ' + (within || 'all') + ')'
        : within
          ? ' (in ' + within + ')'
          : '') +
      ((block.groups ? match.shown : match.all) === 1 ? ' has ' : ' have ') +
      dmvDashboardRuleText_(block, match, false) +
      ' (' +
      match.rule.color +
      ' rows)';
    var text = lead + '.';
    for (var count = Math.min(3, match.names.length); count > 0; count--) {
      var names = match.names.slice(0, count).map(function (name) {
        return name.length > 30 ? name.slice(0, 29) + '…' : name;
      });
      text =
        lead +
        ' — ' +
        names.join(', ') +
        (match.names.length > count ? ' and ' + (match.names.length - count) + ' more' : '') +
        '.';
      if (dmvDashboardTextWidth_(text) <= room) break;
    }
    out.push({ text: text });
  });
  // "Spend by channel type: Search holds 65.6% of the total." A title that names the measure
  // says what the total is; otherwise the sentence names it.
  var words = function (text) {
    return (
      ' ' +
      String(text)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim() +
      ' '
    );
  };
  // A share over a dataset cut to its top rows is a share of those rows, and says so: "of the
  // top 100", "of spend in the top 100".
  blocks.forEach(function (block) {
    var share = block.concentration;
    if (!share) return;
    var title = dmvDashboardTitle_(block.title),
      named = words(title).indexOf(words(share.label)) >= 0;
    out.push({
      text:
        title +
        ': ' +
        share.name +
        ' holds ' +
        dmvDashboardPercent_(share.share) +
        ' of ' +
        (block.top
          ? (named ? '' : share.label + ' in ') + 'the ' + block.top.label
          : named
            ? 'the total'
            : share.label) +
        '.',
    });
  });
  blocks.forEach(function (block) {
    if (!block.lead) return;
    out.push({
      text:
        block.lead.name +
        ' leads ' +
        dmvDashboardTitle_(block.title) +
        ' with ' +
        dmvDashboardMoney_(block, block.lead.column, block.lead.value) +
        ' ' +
        block.lead.column.label.toLowerCase() +
        ' (' +
        dmvDashboardPercent_(block.lead.share) +
        ' of the ' +
        (block.top ? block.top.label : 'total') +
        ').',
    });
  });
  return out.slice(0, DMV_DASHBOARD.highlights);
}

// A title inside a sentence: the part before a colon ("Keyword waste: spend without
// conversions" reads "Keyword waste").
function dmvDashboardTitle_(title) {
  var short = String(title).split(':')[0].trim();
  return short || String(title);
}

// A table value as its cell shows it, with the currency of money in one currency.
function dmvDashboardMoney_(block, column, value) {
  return (
    (column.type === 'currency' && block.currency ? block.currency + ' ' : '') +
    dmvDashboardNumber_(value, column.type)
  );
}

// A highlight rule in words: the legend form "CPA > 1.5× overall (AED 1,734)", or the sentence
// form "CPA above 1.5× the overall AED 1,156".
function dmvDashboardRuleText_(block, match, legend) {
  var rule = match.rule,
    column = match.column;
  if (match.text) return dmvDashboardTextRule_(block, match, legend);
  if (legend)
    return (
      column.label +
      ' ' +
      { gt: '>', gte: '≥', lt: '<', lte: '≤', eq: '=' }[rule.op] +
      ' ' +
      (rule.ofTotal === undefined
        ? dmvDashboardMoney_(block, column, rule.value)
        : rule.ofTotal +
          '× overall' +
          (match.threshold === null
            ? ''
            : ' (' + dmvDashboardMoney_(block, column, match.threshold) + ')'))
    );
  return (
    column.label +
    ' ' +
    { gt: 'above', gte: 'at or above', lt: 'below', lte: 'at or below', eq: 'equal to' }[rule.op] +
    ' ' +
    (rule.ofTotal === undefined
      ? dmvDashboardMoney_(block, column, rule.value)
      : rule.ofTotal +
        '× the overall ' +
        (match.overall === null
          ? 'of their currency'
          : dmvDashboardMoney_(block, column, match.overall)))
  );
}

// A text rule names values as the table's cells show them ("LOW" reads "Low" where the column's
// codes read as words): the legend form "Performance label = Low or Learning", the sentence form
// "Performance label Low or Learning"; a part of a name stays quoted, "kitchen" in Asset.
function dmvDashboardTextRule_(block, match, legend) {
  var rule = match.rule,
    column = match.column;
  if (rule.op === 'contains')
    return legend
      ? column.label + ' contains "' + rule.value + '"'
      : '"' + rule.value + '" in ' + column.label;
  var shown = (rule.op === 'in' ? rule.value.split(',') : [rule.value])
    .map(function (option) {
      return option.trim();
    })
    .filter(function (option) {
      return !!option;
    })
    .map(function (option) {
      var held = null;
      block.entries.some(function (entry) {
        var value = entry.values[column.key];
        if (dmvDashboardBlank_(value) || String(value).toLowerCase() !== option.toLowerCase())
          return false;
        held = value;
        return true;
      });
      return String(column.words(held === null ? option : held));
    });
  var list =
    shown.length > 1 ? shown.slice(0, -1).join(', ') + ' or ' + shown[shown.length - 1] : shown[0];
  if (legend) return column.label + (rule.op === 'ne' ? ' ≠ ' : ' = ') + list;
  return column.label + (rule.op === 'ne' ? ' other than ' : ' ') + list;
}

// Rough advance widths of 10pt Arial in pixels: enough to give a name the columns it needs.
function dmvDashboardTextWidth_(text) {
  var width = 0;
  for (var i = 0; i < text.length; i++) {
    var ch = text.charAt(i);
    width += /[ilIjft.,:;'|!()[\] ]/.test(ch)
      ? 3.9
      : /[mwMW@%]/.test(ch)
        ? 11.2
        : /[A-Z_]/.test(ch)
          ? 8.9
          : /[0-9]/.test(ch)
            ? 7.4
            : 7;
  }
  return width;
}

// The pixel width of a run of content columns, the gap columns between them included.
function dmvDashboardSpan_(columns) {
  return columns * DMV_DASHBOARD.columnWidth + (columns - 1) * DMV_DASHBOARD.gapWidth;
}

// The room a name has in a table column: the first one is inset like the card's text, the
// others keep the cell's own few pixels.
function dmvDashboardRoom_(span, first) {
  return dmvDashboardSpan_(span) - (first ? DMV_DASHBOARD.inset + 6 : 8);
}

// Grid columns of a table: names get room for their text, values one column each, and the
// in-cell bar sits after the value it draws; spare columns go to the names short of room. A table
// wider than the page first narrows its secondary names (the shortest first), then drops its bar
// column; only then does it widen the page.
function dmvDashboardFit_(block, width) {
  var columns = [];
  block.dims.forEach(function (dim, index) {
    // A header may wrap onto two lines; values stay on one.
    var longest = dmvDashboardTextWidth_(dim.label) / 2;
    block.entries.forEach(function (entry) {
      var value = entry.values[dim.key];
      if (!dmvDashboardBlank_(value))
        longest = Math.max(
          longest,
          dmvDashboardTextWidth_(String(dim.words ? dim.words(value) : value))
        );
    });
    var narrow = dim.date || dim.short || dim.numeric;
    var need = 1;
    while (!narrow && need < 5 && dmvDashboardRoom_(need, !index) < longest) need++;
    columns.push({
      kind: 'dim',
      column: dim,
      need: need,
      span: Math.min(narrow ? 1 : index ? 2 : 3, need),
      first: !index,
    });
  });
  block.values.forEach(function (value) {
    columns.push({ kind: 'value', column: value, span: 1 });
    if (value.key === block.bar) columns.push({ kind: 'bar', column: value, span: 1 });
    if (block.compare) columns.push({ kind: 'delta', column: value, span: 1 });
  });
  var total = function () {
    return columns.reduce(function (sum, column) {
      return sum + column.span;
    }, 0);
  };
  var pick = function (test, score) {
    return columns.filter(test).sort(function (a, b) {
      return score(a) - score(b);
    })[0];
  };
  while (total() < width) {
    var grow = pick(
      function (column) {
        return column.kind === 'dim' && column.span < column.need;
      },
      function (column) {
        return column.span - column.need;
      }
    );
    if (!grow) break;
    grow.span++;
  }
  // Columns left over widen the first one, so a table fills its card.
  if (total() < width && columns.length) columns[0].span += width - total();
  while (total() > width) {
    var shrink = pick(
      function (column) {
        return column.kind === 'dim' && !column.first && column.span > 1;
      },
      function (column) {
        return column.need;
      }
    );
    if (shrink) shrink.span--;
    else if (
      columns.some(function (column) {
        return column.kind === 'bar';
      })
    )
      columns = columns.filter(function (column) {
        return column.kind !== 'bar';
      });
    else break;
  }
  return { columns: columns, width: total() };
}

// The dashboard tab is one owned page on a fixed grid: a margin, twelve content columns with a
// gap column between each two, and a margin. A navy title band, a bar of section links, then
// white cards on a light page: scorecards, highlights, chart cards, table cards and the data
// sources. Gap columns and gap rows stay page colour, so every card has the same space around
// it. Cells hold literal values only; formats, merges and sizes come from the layout, so the
// page digest guards it like any output. Cards are placed by content column (1-based); the
// table behind each chart goes to the chart data tab.
function dmvDashboardPage_(dashboard, view) {
  var style = DMV_DASHBOARD_STYLE,
    inset = DMV_DASHBOARD.inset;
  var charts = view.blocks.filter(function (block) {
    return block.chart;
  });
  var tables = view.blocks.filter(function (block) {
    return !block.chart;
  });
  var width = DMV_DASHBOARD.gridColumns;
  tables.forEach(function (block) {
    width = Math.max(width, dmvDashboardFit_(block, DMV_DASHBOARD.gridColumns).width);
  });
  tables.forEach(function (block) {
    block.fit = dmvDashboardFit_(block, width);
  });
  var span = 2 * width + 1,
    matrix = [],
    heights = [],
    formats = [],
    paints = [],
    merges = [],
    borders = [],
    grids = [];
  // Content column c is sheet column 2c - 1 of the area (0-based, after the margin); s content
  // columns take their gap columns with them.
  function place(c) {
    return 2 * c - 1;
  }
  function cover(s) {
    return 2 * s - 1;
  }
  function row(height) {
    var cells = [];
    for (var i = 0; i < span; i++) cells.push('');
    matrix.push(cells);
    heights.push(height);
    return matrix.length - 1;
  }
  function put(at, column, value) {
    matrix[at][column] = dmvSheetValue_(value);
  }
  function format(at, column, rows, columns, look) {
    formats.push({ row: at, column: column, rows: rows, columns: columns, format: look });
  }
  function merge(at, column, rows, columns, byRow) {
    if (columns < 2 && (byRow || rows < 2)) return;
    var entry = { row: at, column: column, rows: rows, columns: columns };
    if (byRow) entry.type = 'ROWS';
    merges.push(entry);
  }
  // Text over sheet columns: one merged cell holding its value in the first.
  function text(at, column, columns, value, look) {
    put(at, column, value);
    merge(at, column, 1, columns);
    format(at, column, 1, columns, look);
  }
  function card(at, c, rows, s) {
    format(at, place(c), rows, cover(s), { background: style.card });
  }
  // Every side is set, so a later inset never resets a side an earlier format chose.
  function pad(left, right) {
    return {
      top: 2,
      right: right === undefined ? 3 : right,
      bottom: 2,
      left: left === undefined ? 3 : left,
    };
  }
  var toneColor = { good: style.good, bad: style.bad, neutral: style.neutral };
  var heading = {
    color: style.ink,
    fontSize: 12,
    bold: true,
    valign: 'MIDDLE',
    wrap: 'CLIP',
    padding: pad(inset),
  };
  var aside = {
    color: style.muted,
    fontSize: 9,
    align: 'RIGHT',
    valign: 'MIDDLE',
    wrap: 'CLIP',
    padding: pad(3, inset),
  };
  // A card title, and a note right-aligned in the card's last two or more content columns.
  function title(at, c, s, value, note) {
    var room = 2;
    while (
      room < s - 3 &&
      dmvDashboardSpan_(room) < dmvDashboardTextWidth_(note || '') * 0.9 + inset + 6
    )
      room++;
    text(at, place(c), place(c + s - room) - place(c), value, heading);
    text(at, place(c + s - room), cover(room), note || '', aside);
  }

  // 1. The brand band: name and period, refresh time and the compared period.
  var band = row(10),
    named = row(42),
    stamped = row(22);
  row(10);
  format(band, 0, 4, span, { background: style.band });
  text(named, place(1), place(width - 3) - place(1), dashboard.name, {
    color: style.bandText,
    fontSize: 22,
    bold: true,
    valign: 'MIDDLE',
    wrap: 'CLIP',
    padding: pad(inset),
  });
  text(named, place(width - 3), cover(4), view.period, {
    color: style.bandText,
    fontSize: 11,
    align: 'RIGHT',
    valign: 'MIDDLE',
    wrap: 'CLIP',
    padding: pad(3, inset),
  });
  var muted = {
    color: style.bandMuted,
    fontSize: 9,
    valign: 'MIDDLE',
    wrap: 'CLIP',
    padding: pad(inset),
  };
  text(stamped, place(1), place(width - 3) - place(1), 'Refreshed ' + view.stamp, muted);
  text(
    stamped,
    place(width - 3),
    cover(4),
    view.previousPeriod ? 'vs ' + view.previousPeriod : '',
    Object.assign({}, muted, { align: 'RIGHT', padding: pad(3, inset) })
  );

  // 2. Section links on a white bar, like tabs: each link is centred in its share of the width
  // and gets its internal link once the sections have their rows.
  var sections = [];
  if (view.cards.length) sections.push({ label: 'Overview', key: 'cards' });
  if (view.highlights.length) sections.push({ label: 'Highlights', key: 'highlights' });
  if (charts.length) sections.push({ label: 'Charts', key: 'charts' });
  tables.forEach(function (block) {
    var label = dmvDashboardTitle_(block.title);
    if (label.length > 18) {
      var cut = label.slice(0, 18).replace(/\s+\S*$/, '');
      label = (cut.length >= 8 ? cut : label.slice(0, 17)) + '…';
    }
    sections.push({ label: label, key: block });
  });
  sections.push({ label: 'Data sources', key: 'sources' });
  if (sections.length > width) sections = sections.slice(0, width - 1).concat(sections.slice(-1));
  var steps = sections.map(function (section) {
    var need = 1;
    while (dmvDashboardSpan_(need) < dmvDashboardTextWidth_(section.label) * 1.05 + 12) need++;
    return need;
  });
  var sum = function () {
    return steps.reduce(function (total, step) {
      return total + step;
    }, 0);
  };
  // Too many links narrow the widest ones first; spare columns go to the links in turn.
  while (sum() > width && Math.max.apply(null, steps) > 1)
    steps[steps.lastIndexOf(Math.max.apply(null, steps))]--;
  for (var spare = 0; sum() < width; spare = (spare + 1) % steps.length) steps[spare]++;
  var nav = row(30),
    next = 1;
  card(nav, 1, 1, width);
  sections.forEach(function (section, index) {
    var last = index === sections.length - 1;
    section.column = place(next);
    // A link takes the gap after it, so the bar has no seams but its separators.
    section.columns = cover(steps[index]) + (last ? 0 : 1);
    next += steps[index];
    put(nav, section.column, section.label);
    merge(nav, section.column, 1, section.columns);
    if (!last)
      borders.push({
        row: nav,
        column: section.column,
        columns: section.columns,
        right: { style: 'SOLID', color: style.separator },
      });
  });
  row(16);
  function mark(key, at) {
    sections.forEach(function (section) {
      if (section.key === key && section.row === undefined) section.row = at;
    });
  }

  // 3. Scorecards in balanced rows of at most four (six fit one row), each row filling the
  // width: 5 cards are 3 + 2, 7 are 4 + 3.
  var count = view.cards.length;
  var perRow = count === 6 ? 6 : Math.ceil(count / Math.ceil(count / 4));
  for (var first = 0; first < count; first += perRow) {
    var label = row(30),
      value = row(44),
      changed = row(24);
    row(10);
    mark('cards', label);
    var group = view.cards.slice(first, first + perRow);
    var base = Math.floor(width / group.length),
      extra = width % group.length,
      column = 1;
    group.forEach(function (item, index) {
      var columns = base + (index < extra ? 1 : 0);
      card(label, column, 4, columns);
      text(label, place(column), cover(columns), item.label, {
        color: style.muted,
        fontSize: 9,
        bold: true,
        valign: 'BOTTOM',
        wrap: 'CLIP',
        padding: pad(inset),
      });
      text(value, place(column), cover(columns), item.value, {
        color: style.ink,
        fontSize: 22,
        bold: false,
        align: 'LEFT',
        valign: 'MIDDLE',
        wrap: 'CLIP',
        padding: pad(inset),
        numberFormat: dmvDashboardPattern_(item.value, item.type),
      });
      var line = '',
        color = style.muted,
        change = null;
      if (item.previous !== undefined) {
        change = dmvDashboardChangeText_(item);
        line = change.text;
        if (change.delta !== null) color = toneColor[item.tone];
      }
      text(changed, place(column), cover(columns), line, {
        color: color,
        fontSize: 9,
        bold: !!(change && change.delta),
        valign: 'TOP',
        wrap: 'CLIP',
        padding: pad(inset),
      });
      column += columns;
    });
    row(16);
  }

  // 4. Highlights: findings computed from the numbers on this page.
  if (view.highlights.length) {
    var head = row(34);
    mark('highlights', head);
    text(head, place(1), cover(width), 'Highlights', heading);
    view.highlights.forEach(function (item) {
      text(row(24), place(1), cover(width), '•  ' + item.text, {
        color: style.ink,
        fontSize: 10,
        valign: 'MIDDLE',
        wrap: 'CLIP',
        padding: pad(inset),
      });
    });
    row(10);
    card(head, 1, matrix.length - head, width);
    row(16);
  }

  // 5. Chart cards, two per row or one across the page. The native chart is an overlay inside
  // its card; its title lives in the card's first row. A note that repeats the band's compared
  // period gives way to the chart's currency.
  var half = Math.floor(width / 2),
    placed = [];
  for (var at = 0; at < charts.length;) {
    var pair =
      !charts[at].full && charts[at + 1] && !charts[at + 1].full
        ? [charts[at], charts[at + 1]]
        : [charts[at]];
    at += pair.length;
    var top = row(34),
      body = row(DMV_DASHBOARD.chartHeight + 16);
    row(8);
    mark('charts', top);
    pair.forEach(function (block, index) {
      var c = 1 + (index ? half : 0),
        s = block.full || pair.length === 1 ? width : index ? width - half : half;
      card(top, c, 3, s);
      var note =
        block.note && block.note !== 'vs ' + view.previousPeriod ? block.note : block.unit || '';
      title(top, c, s, block.title, note);
      block.anchor = { row: body, column: place(c), width: dmvDashboardSpan_(s) - 16 };
      placed.push(block);
    });
    row(16);
  }

  // 6. and 7. Table cards, then the data sources, in one table style: a header, rows parted by
  // hairlines, totals on a tinted row, numbers right-aligned, a legend of the highlight rules.
  // Each table column keeps the gap column after it blank, which spaces the columns apart.
  function table(entry) {
    var head = row(34);
    title(head, 1, width, entry.title, entry.note);
    var wraps = entry.columns.some(function (item) {
      return (
        dmvDashboardTextWidth_(String(item.header)) * 0.95 >
        dmvDashboardRoom_(item.span, item.first)
      );
    });
    var header = row(wraps ? 36 : 30),
      firstRow = matrix.length;
    entry.rows.forEach(function () {
      row(24);
    });
    entry.totals.forEach(function () {
      row(24);
    });
    var last = matrix.length - 1;
    var legend = -1;
    if ((entry.legend || []).length) {
      row(6);
      legend = row(24);
    }
    row(10);
    card(head, 1, matrix.length - head, width);
    var used = 0;
    entry.columns.forEach(function (item) {
      used = Math.max(used, item.start + item.span - 1);
    });
    var types = [];
    entry.columns.forEach(function (item, index) {
      types.push(item.type);
      for (var extra = 1; extra < cover(item.span); extra++) types.push({ type: 'text' });
      if (index < entry.columns.length - 1) types.push({ type: 'text' });
    });
    grids.push({ row: header, column: place(1), rows: last - header + 1, columns: types });
    format(header, place(1), 1, cover(used), {
      background: style.headerBackground,
      color: style.headerText,
      fontSize: 9,
      bold: true,
      valign: 'MIDDLE',
      wrap: 'WRAP',
    });
    if (last >= firstRow)
      format(firstRow, place(1), last - firstRow + 1, cover(used), {
        color: style.ink,
        fontSize: 10,
        valign: 'MIDDLE',
        wrap: 'CLIP',
      });
    entry.columns.forEach(function (item, index) {
      var column = place(item.start),
        columns = cover(item.span);
      put(header, column, item.header);
      merge(header, column, last - header + 1, columns, true);
      if (item.right)
        format(header, column, last - header + 1, columns, {
          align: 'RIGHT',
          padding: pad(3, index === entry.columns.length - 1 ? inset : 3),
        });
      entry.rows.concat(entry.totals).forEach(function (line, offset) {
        put(firstRow + offset, column, line.cells[index]);
      });
    });
    format(header, place(1), last - header + 1, 1, { padding: pad(inset) });
    // A look repeated on consecutive rows (a run of tinted rows) is one format over all of them.
    var runs = [],
      open = Object.create(null);
    entry.rows.forEach(function (line, index) {
      (line.looks || []).forEach(function (look) {
        var key = JSON.stringify([look.column, look.columns || 1, look.format]),
          run = open[key];
        if (run && run.last === index - 1) run.last = index;
        else runs.push((open[key] = { look: look, first: index, last: index }));
      });
    });
    runs.forEach(function (run) {
      format(
        firstRow + run.first,
        place(run.look.column),
        run.last - run.first + 1,
        cover(run.look.columns || 1),
        run.look.format
      );
    });
    (entry.bands || []).forEach(function (band) {
      format(firstRow, place(band.column), entry.rows.length, cover(band.columns), band.format);
    });
    (entry.paints || []).forEach(function (paint) {
      paints.push(Object.assign({}, paint, { row: firstRow, column: place(paint.column) }));
    });
    if (entry.totals.length)
      format(last - entry.totals.length + 1, place(1), entry.totals.length, cover(used), {
        bold: true,
        background: style.totalBackground,
      });
    entry.totals.forEach(function (line, index) {
      (line.looks || []).forEach(function (look) {
        format(
          last - entry.totals.length + 1 + index,
          place(look.column),
          1,
          cover(look.columns || 1),
          look.format
        );
      });
    });
    borders.push({
      row: header,
      column: place(1),
      rows: last - header + 1,
      columns: cover(used),
      innerHorizontal: { style: 'SOLID', color: style.separator },
      bottom: { style: 'SOLID', color: style.separator },
    });
    // The legend: one tinted chip per rule, saying the threshold it applied on this refresh.
    var c = 2;
    if (legend >= 0)
      text(legend, place(1), cover(1), 'Row tints', {
        color: style.muted,
        fontSize: 9,
        valign: 'MIDDLE',
        wrap: 'CLIP',
        padding: pad(inset),
      });
    (entry.legend || []).forEach(function (item) {
      var s = 1;
      while (dmvDashboardSpan_(s) < dmvDashboardTextWidth_(item.text) * 0.9 + 2 * inset) s++;
      if (c + s - 1 > width) return;
      text(legend, place(c), cover(s), item.text, {
        background: style.tints[item.color],
        color: style.ink,
        fontSize: 9,
        align: 'CENTER',
        valign: 'MIDDLE',
        wrap: 'CLIP',
      });
      c += s;
    });
    row(16);
    return head;
  }
  tables.forEach(function (block) {
    mark(block, table(dmvDashboardTableView_(block, view.plan)));
  });
  // The data sources take the columns their text needs, like a table's names. The source
  // column goes when every connection label already starts with its source's name, and the
  // connection column when every dataset label starts with its connection's. The note column
  // (a connector's own note, such as "Top 100 by Cost") is there when a dataset has one.
  var startsWith = function (index, prefix) {
    return view.sources.every(function (source) {
      return String(source[index]).indexOf(String(source[prefix])) === 0;
    });
  };
  var noted = view.sources.some(function (source) {
    return !!source[7];
  });
  var kept = [0, 1, 2, 3, 4, 5, 6, 7].filter(function (index) {
    return (
      !(index === 1 && startsWith(2, 1)) &&
      !(index === 2 && startsWith(0, 2)) &&
      !(index === 7 && !noted)
    );
  });
  var headers = kept.map(function (index) {
    return ['Dataset', 'Source', 'Connection', 'Report', 'Date range', 'Rows', 'Tab', 'Note'][
      index
    ];
  });
  var listed = view.sources.map(function (source) {
    return kept.map(function (index) {
      return source[index];
    });
  });
  var spans = dmvDashboardFit_(
    {
      dims: headers.map(function (header, index) {
        return { key: String(index), label: header, numeric: header === 'Rows' };
      }),
      values: [],
      entries: listed.map(function (source) {
        return { values: source };
      }),
    },
    width
  ).columns;
  var start = 1;
  mark(
    'sources',
    table({
      title: 'Data sources',
      note: '',
      columns: headers.map(function (header, index) {
        var item = {
          header: header,
          start: start,
          span: spans[index].span,
          first: !index,
          right: header === 'Rows',
          type: { type: header === 'Rows' ? 'number' : 'text' },
        };
        start += item.span;
        return item;
      }),
      rows: listed.map(function (source) {
        return { cells: source };
      }),
      totals: [],
    })
  );

  // 8. Footer.
  text(
    row(28),
    place(1),
    cover(width),
    'To refresh: Extensions › DataMoov › Open › Reports › Dashboards › Refresh dashboard (no AI needed). Layout changes on this tab are reset on refresh.',
    { color: style.muted, fontSize: 9, valign: 'MIDDLE', wrap: 'CLIP', padding: pad(inset) }
  );
  row(16);

  // Each link carries its look and its target in one format, so Sheets keeps the bar's colour
  // instead of its default link colour.
  sections.forEach(function (section) {
    var look = {
      color: style.link,
      fontSize: 10,
      bold: true,
      align: 'CENTER',
      valign: 'MIDDLE',
      wrap: 'CLIP',
    };
    if (section.row !== undefined) look.link = { row: section.row };
    format(nav, section.column, 1, section.columns, look);
  });
  // The page colour goes under everything else.
  formats.unshift({
    row: 0,
    column: 0,
    rows: matrix.length,
    columns: span,
    format: { background: style.page, color: style.ink, fontSize: 10, valign: 'MIDDLE' },
  });
  var rowHeights = [];
  heights.forEach(function (height, index) {
    var last = rowHeights[rowHeights.length - 1];
    if (height === 21) return;
    if (last && last.height === height && last.row + last.rows === index) last.rows++;
    else rowHeights.push({ row: index, rows: 1, height: height });
  });
  var columnWidths = [DMV_DASHBOARD.gutterWidth];
  for (var c = 1; c <= width; c++) {
    columnWidths.push(DMV_DASHBOARD.columnWidth);
    if (c < width) columnWidths.push(DMV_DASHBOARD.gapWidth);
  }
  columnWidths.push(DMV_DASHBOARD.gutterWidth);

  // The chart data tab: one small table per chart, in the order of the charts, with the labels
  // the axis shows.
  var data = { matrix: [], tables: [], styles: [] };
  data.width = Math.max.apply(
    null,
    charts
      .map(function (block) {
        return block.columns.length;
      })
      .concat([1])
  );
  var chartsOut = placed.map(function (block) {
    if (data.matrix.length) data.matrix.push(dmvDashboardPad_([], data.width));
    data.styles.push({ row: data.matrix.length, style: 'section' });
    data.matrix.push(
      dmvDashboardPad_([block.title + (block.note ? ' (' + block.note + ')' : '')], data.width)
    );
    var top = data.matrix.length;
    block.matrix.forEach(function (line, index) {
      var shown = !index
        ? [line[0]].concat(block.names || line.slice(1))
        : [block.labels ? block.labels[index - 1] : line[0]].concat(line.slice(1));
      data.matrix.push(dmvDashboardPad_(shown, data.width));
    });
    data.tables.push({
      row: top,
      rows: block.matrix.length,
      columns: block.columns.map(function (column, index) {
        return !index && block.labels
          ? { type: 'text' }
          : dmvDashboardDataColumn_(column, block.matrix, index);
      }),
    });
    return {
      type: block.type,
      title: block.title,
      row: top,
      rows: block.matrix.length,
      columns: block.columns.length,
      series: block.series,
      stacked: block.stacked,
      points: block.matrix.length - 1,
      anchorRow: block.anchor.row,
      anchorColumn: block.anchor.column,
      width: block.anchor.width,
    };
  });
  return {
    matrix: matrix,
    layout: {
      columnWidths: columnWidths,
      rowHeights: rowHeights,
      tables: grids,
      formats: formats,
      paints: paints,
      borders: borders,
      merges: merges,
    },
    data: { matrix: data.matrix, layout: { tables: data.tables, styles: data.styles } },
    charts: chartsOut,
    width: span,
    // The band and the section links stay in view while the page scrolls.
    frozen: nav + 1,
  };
}

// Axis labels follow the source cells: money reads as whole amounts unless it is small, rates
// with one decimal.
function dmvDashboardDataColumn_(column, matrix, index) {
  if (column.type === 'percent') return { type: 'percent', pattern: '0.0%' };
  if (column.type !== 'currency') return { type: column.type };
  var peak = matrix.slice(1).reduce(function (most, line) {
    var value = Math.abs(Number(line[index]));
    return isFinite(value) ? Math.max(most, value) : most;
  }, 0);
  return { type: 'currency', pattern: peak >= 100 ? '#,##0' : '#,##0.00' };
}

// The grid view of a table tile: its columns with spans (in content columns) and number
// formats, each row's cells, the looks that carry meaning (heatmap steps, highlight tints,
// coloured changes) and a legend of its highlight rules.
function dmvDashboardTableView_(block, plan) {
  var style = DMV_DASHBOARD_STYLE;
  var rows = block.entries.concat(block.totals);
  // Money reads as whole amounts from a thousand up, like the scorecards; an average of whole
  // numbers (a quality score) keeps one decimal.
  function pattern(column) {
    if (column.type === 'currency') {
      var peak = rows.reduce(function (most, entry) {
        var value = Math.abs(Number(entry.values[column.key]));
        return isFinite(value) ? Math.max(most, value) : most;
      }, 0);
      return peak >= 1000 ? '#,##0' : '#,##0.00';
    }
    return column.type === 'number' && column.agg === 'avg' ? '#,##0.0' : undefined;
  }
  var columns = block.fit.columns.map(function (item) {
    var column = item.column;
    if (item.kind === 'dim')
      return Object.assign({}, item, { header: column.label, type: { type: 'text' } });
    if (item.kind === 'bar') return Object.assign({}, item, { header: '', type: { type: 'text' } });
    if (item.kind === 'delta')
      return Object.assign({}, item, {
        header: 'Δ %',
        right: true,
        type: { type: 'percent', pattern: DMV_DASHBOARD_DELTA },
      });
    var type = { type: column.type },
      fixed = pattern(column);
    if (fixed) type.pattern = fixed;
    return Object.assign({}, item, {
      header:
        column.label +
        (column.type === 'currency' && block.currency ? ' (' + block.currency + ')' : ''),
      right: true,
      type: type,
    });
  });
  var start = 1;
  columns.forEach(function (item) {
    item.start = start;
    start += item.span;
  });
  var used = start - 1;
  // Rates and averages shade from white to blue by their rank within their currency: darker is
  // better, so a cost per result is ranked the other way round.
  var currencyKey = block.dims.filter(function (dim) {
    return dim.short;
  })[0];
  var groupOf = function (entry) {
    return currencyKey ? String(entry.values[currencyKey.key]) : '';
  };
  var heat = Object.create(null);
  columns.forEach(function (item) {
    if (item.kind !== 'value' || !item.column.heat) return;
    var groups = Object.create(null);
    block.entries.forEach(function (entry) {
      var value = entry.values[item.column.key];
      if (dmvDashboardBlank_(value) || !isFinite(Number(value))) return;
      (groups[groupOf(entry)] = groups[groupOf(entry)] || []).push(Number(value));
    });
    var lower = (plan.lowerIsBetter || []).indexOf(item.column.name) >= 0;
    Object.keys(groups).forEach(function (group) {
      groups[group].sort(function (a, b) {
        return lower ? b - a : a - b;
      });
    });
    heat[item.column.key] = groups;
  });
  // A name wider than its cell is cut at a word, with an ellipsis; the dataset tab keeps it whole.
  function fitted(text, item) {
    var room = dmvDashboardRoom_(item.span, item.first);
    if (dmvDashboardTextWidth_(text) <= room) return text;
    var cut = text;
    while (cut.length > 1 && dmvDashboardTextWidth_(cut + '…') > room) cut = cut.slice(0, -1);
    var word = cut.search(/[\s_\-.,/]+[^\s_\-.,/]*$/);
    if (word > cut.length / 2) cut = cut.slice(0, word);
    return cut.replace(/[\s_\-.,/:;]+$/, '') + '…';
  }
  // The total covers every group of the tile, and of a top-N dataset only its top rows:
  // "Total (all 20)", "Total (top 100)", "Total (all 20 of top 100)".
  var top = block.top ? block.top.label : '';
  var scope = block.groups
    ? ' (all ' + block.groups + (top ? ' of ' + top : '') + ')'
    : top
      ? ' (' + top + ')'
      : '';
  function cells(entry, total) {
    return columns.map(function (item) {
      var key = item.column.key;
      if (item.kind === 'dim') {
        if (total)
          return item.first
            ? 'Total' + scope + (item.column.short ? ' (' + entry.values[key] + ')' : '')
            : item.column.short
              ? entry.values[key]
              : '';
        var value = entry.values[key];
        return typeof value === 'string' && value
          ? fitted(String(item.column.words(value)), item)
          : value;
      }
      if (item.kind === 'bar') return total ? '' : entry.bar;
      if (item.kind === 'delta')
        return dmvDashboardBlank_(entry.deltas[key]) ? '' : entry.deltas[key];
      return entry.values[key];
    });
  }
  function toneOf(item, delta) {
    var tone = dmvDashboardTone_(plan, item.column.name, delta);
    return tone === 'good' ? style.good : tone === 'bad' ? style.bad : style.neutral;
  }
  function deltaLooks(entry) {
    var looks = [];
    columns.forEach(function (item) {
      var delta = entry.deltas[item.column.key];
      if (item.kind !== 'delta' || dmvDashboardBlank_(delta)) return;
      looks.push({
        column: item.start,
        columns: item.span,
        format: { color: toneOf(item, delta) },
      });
    });
    return looks;
  }
  // A highlight tint covers the whole row and wins over the heatmap.
  var lines = block.entries.map(function (entry) {
    return {
      cells: cells(entry, false),
      looks: entry.tint
        ? [{ column: 1, columns: used, format: { background: style.tints[entry.tint] } }]
        : [],
    };
  });
  // Looks that change from row to row (heat steps, coloured changes) are one paint per column,
  // a colour per row, and the bar's look one format over every row: a page's size then grows
  // with its cells, not with a request per cell. A tinted row keeps its tint in a heat column.
  var paints = [],
    bands = [];
  if (block.entries.length)
    columns.forEach(function (item) {
      if (item.kind === 'bar')
        bands.push({
          column: item.start,
          columns: item.span,
          format: { color: style.bar, fontSize: 7, align: 'LEFT', wrap: 'CLIP' },
        });
      else if (item.kind === 'delta') {
        var tones = block.entries.map(function (entry) {
          var delta = entry.deltas[item.column.key];
          return dmvDashboardBlank_(delta) ? style.ink : toneOf(item, delta);
        });
        if (
          tones.some(function (color) {
            return color !== style.ink;
          })
        )
          paints.push({ column: item.start, color: tones });
      } else if (item.kind === 'value' && heat[item.column.key]) {
        var shaded = false;
        var steps = block.entries.map(function (entry) {
          if (entry.tint) return style.tints[entry.tint];
          var numbers = heat[item.column.key][groupOf(entry)],
            value = entry.values[item.column.key];
          if (
            !numbers ||
            numbers.length < 3 ||
            dmvDashboardBlank_(value) ||
            !isFinite(Number(value))
          )
            return style.card;
          var step = Math.round((numbers.indexOf(Number(value)) / (numbers.length - 1)) * 4);
          if (step) shaded = true;
          return step ? style.heat[step] : style.card;
        });
        if (shaded) paints.push({ column: item.start, background: steps });
      }
    });
  // A filter that leaves no rows says so in the table instead of showing a bare header.
  if (!lines.length)
    lines.push({
      cells: columns.map(function (item, index) {
        return index ? '' : 'No rows in this period';
      }),
      looks: [{ column: 1, columns: used, format: { color: style.muted, italic: true } }],
    });
  return {
    title: block.title,
    note: block.note,
    columns: columns,
    rows: lines,
    paints: paints,
    bands: bands,
    totals: block.totals.map(function (entry) {
      return { cells: cells(entry, true), looks: deltaLooks(entry) };
    }),
    legend: (block.matches || []).map(function (match) {
      return { text: dmvDashboardRuleText_(block, match, true), color: match.rule.color };
    }),
  };
}

function dmvDashboardColor_(hex) {
  return { rgbColor: dmvLayoutColor_(hex) };
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
  var style = DMV_DASHBOARD_STYLE;
  // The title lives in the card's first row; altText keeps the chart's name for screen readers.
  // Arial is the font of the cells around the chart.
  var spec = {
    title: '',
    altText: chart.title,
    fontName: 'Arial',
    backgroundColorStyle: dmvDashboardColor_(style.card),
  };
  // A share is drawn as bars in the page's own colour, largest first: a pie can only take the
  // workbook theme's colours, whose second slice is the red that means a bad change here.
  var type = chart.type === 'pie' ? 'bar' : chart.type;
  // Sheets draws a bar chart sideways and rejects bar series on any axis but the bottom one.
  var axis = type === 'bar' ? 'BOTTOM_AXIS' : 'LEFT_AXIS';
  var series = chart.series || [];
  var combo =
    type === 'column' &&
    series.some(function (item) {
      return item.right;
    });
  // One measure against its previous period: the current period as a soft area, the previous
  // one as a dashed line over it.
  var shaded =
    type === 'line' &&
    series.length === 2 &&
    !series[0].previous &&
    series[1].previous &&
    !series[0].right &&
    !series[1].right;
  // Sheets offers no outside-end label on stacked bars, so only plain ones are labelled.
  var labelled =
    series.length === 1 &&
    ['bar', 'column'].indexOf(type) >= 0 &&
    !chart.stacked &&
    chart.points <= DMV_DASHBOARD.labelPoints;
  var axisText = { fontSize: 9, foregroundColorStyle: dmvDashboardColor_(style.muted) };
  spec.basicChart = {
    chartType: combo || shaded ? 'COMBO' : DMV_CHART_TYPES[type],
    legendPosition: series.length > 1 ? 'TOP_LEGEND' : 'NO_LEGEND',
    headerCount: 1,
    axis: [{ position: axis, format: axisText }].concat(
      series.some(function (item) {
        return item.right;
      })
        ? [{ position: 'RIGHT_AXIS', format: axisText }]
        : []
    ),
    domains: [{ domain: column(0, false) }],
    series: series.map(function (item, index) {
      var kind = combo
        ? item.right
          ? 'LINE'
          : 'COLUMN'
        : shaded
          ? item.previous
            ? 'LINE'
            : 'AREA'
          : DMV_CHART_TYPES[type];
      var entry = {
        series: column(index + 1, false),
        targetAxis: item.right ? 'RIGHT_AXIS' : axis,
        colorStyle: dmvDashboardColor_(
          item.previous && item.color !== style.previous
            ? dmvDashboardLighter_(item.color, kind === 'LINE' || kind === 'AREA' ? 0.35 : 0.55)
            : item.color
        ),
      };
      // On a column chart, values on the right axis are lines: Sheets' way to show two scales.
      if (combo || shaded) entry.type = kind;
      if (kind === 'LINE' || kind === 'AREA')
        entry.lineStyle = { width: 2, type: item.previous ? 'MEDIUM_DASHED' : 'SOLID' };
      if (labelled)
        entry.dataLabel = {
          type: 'DATA',
          placement: 'OUTSIDE_END',
          textFormat: { fontSize: 9, foregroundColorStyle: dmvDashboardColor_(style.muted) },
        };
      return entry;
    }),
  };
  if (['line', 'area', 'column'].indexOf(type) >= 0) spec.basicChart.compareMode = 'CATEGORY';
  // Sheets smooths line charts only.
  if (type === 'line' && !shaded) spec.basicChart.lineSmoothing = true;
  if (chart.stacked) spec.basicChart.stackedType = 'STACKED';
  return spec;
}

// A previous-period twin takes its series' hue mixed with white: a dashed line a little, a
// column (which cannot be dashed) more.
function dmvDashboardLighter_(hex, amount) {
  return (
    '#' +
    [1, 3, 5]
      .map(function (offset) {
        var channel = parseInt(hex.slice(offset, offset + 2), 16);
        return ('0' + Math.round(channel + (255 - channel) * amount).toString(16)).slice(-2);
      })
      .join('')
  );
}

// Charts the dashboard created earlier are updated in place and moved to their card, since the
// layout owns their positions; missing ones are added and surplus ones removed, all in the write
// batch. The runtime chooses the ids of new charts itself (outcome.chartIds) so the caller can
// record them before the batch is sent: a retry after an interrupted refresh then finds its
// charts instead of stacking a second set on top. datasets are the areas of the data tabs and
// frozen the rows that stay in view.
function dmvDashboardChartRequests_(
  spreadsheetId,
  charts,
  area,
  source,
  datasets,
  frozen,
  savedIds,
  outcome
) {
  var response = Sheets.Spreadsheets.get(spreadsheetId, {
    fields: 'sheets(properties(sheetId,index),charts.chartId)',
  });
  var sourceExists = false,
    pageExists = false,
    existing = Object.create(null),
    taken = Object.create(null),
    sheets = (response && response.sheets) || [],
    index = sheets.length;
  sheets.forEach(function (item) {
    var id = item.properties && item.properties.sheetId;
    var here = id === area.sheetId;
    if (here) pageExists = true;
    if (id === source.sheetId) sourceExists = true;
    if (
      datasets.some(function (dataset) {
        return dataset.sheetId === id;
      })
    )
      index = Math.min(index, item.properties.index || 0);
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
  // The page hides its gridlines, wears the band colour on its tab and keeps its band and
  // section links in view, on every refresh.
  add({
    updateSheetProperties: {
      properties: {
        sheetId: area.sheetId,
        gridProperties: { hideGridlines: true, frozenRowCount: frozen },
        tabColorStyle: dmvDashboardColor_(DMV_DASHBOARD_STYLE.band),
      },
      fields: 'gridProperties.hideGridlines,gridProperties.frozenRowCount,tabColorStyle',
    },
  });
  // A new dashboard tab comes before its data tabs, where it is found first. Tabs the user
  // arranged later stay where they are.
  if (!pageExists)
    add({
      updateSheetProperties: {
        properties: { sheetId: area.sheetId, index: index },
        fields: 'index',
      },
    });
  // Hidden only when first created, so a tab the user chose to show stays shown.
  if (!sourceExists)
    add({
      updateSheetProperties: {
        properties: { sheetId: source.sheetId, hidden: true },
        fields: 'hidden',
      },
    });
  var border = { colorStyle: dmvDashboardColor_(DMV_DASHBOARD_STYLE.card) };
  charts.forEach(function (chart, index) {
    var spec = dmvDashboardChartSpec_(chart, source);
    var position = {
      overlayPosition: {
        anchorCell: {
          sheetId: area.sheetId,
          rowIndex: area.row - 1 + chart.anchorRow,
          columnIndex: area.column - 1 + chart.anchorColumn,
        },
        offsetXPixels: 8,
        offsetYPixels: 4,
        widthPixels: chart.width,
        heightPixels: DMV_DASHBOARD.chartHeight,
      },
    };
    var saved = savedIds[index];
    if (saved !== undefined && saved !== null && existing[saved]) {
      outcome.chartIds[index] = saved;
      add({ updateChartSpec: { chartId: saved, spec: spec } });
      add({
        updateEmbeddedObjectPosition: {
          objectId: saved,
          newPosition: position,
          fields: 'anchorCell,offsetXPixels,offsetYPixels,widthPixels,heightPixels',
        },
      });
      add({
        updateEmbeddedObjectBorder: { objectId: saved, border: border, fields: 'colorStyle' },
      });
      return;
    }
    var chartId;
    do chartId = parseInt(dmvOutputDigest_(Utilities.getUuid()).slice(0, 7), 16);
    while (taken[chartId]);
    taken[chartId] = true;
    outcome.chartIds[index] = chartId;
    add({
      addChart: {
        chart: { chartId: chartId, spec: spec, position: position, border: border },
      },
    });
  });
  savedIds.slice(charts.length).forEach(function (saved) {
    if (saved !== undefined && saved !== null && existing[saved])
      add({ deleteEmbeddedObject: { objectId: saved } });
  });
  return requests;
}

// A dashboard shows the rows worth acting on, not a full dump: what narrows a dataset that is
// too large, in words that fit every source. A query's own LIMIT is left to the sources whose
// description offers it, as only those label the rows it keeps; elsewhere it would cut a list
// without a word.
function dmvDashboardNarrow_(subject) {
  return (
    'Keep only the rows worth acting on' +
    (subject ? ' in ' + subject : '') +
    ": a ranked report's Keep the top rows, conditions or aggregation in the query, or fewer dimensions."
  );
}

// Errors reach the user through dmvSafeError_, which keeps their first 400 characters: a list
// names as many items as fit beside the advice after it ("and 2 more"), and an optional last
// sentence comes only whole.
function dmvDashboardMessage_(lead, items, close, advice, optional) {
  var text = function (count) {
    return (
      lead +
      items.slice(0, count).join(', ') +
      (count < items.length ? ' and ' + (items.length - count) + ' more' : '') +
      close +
      advice
    );
  };
  var count = items.length;
  while (count > 1 && text(count).length > 400) count--;
  var message = text(count);
  return optional && (message + optional).length <= 400 ? message + optional : message;
}

// A refresh past one Sheets write names its largest parts, rows by columns, from the writer's
// per-output sizes (those at least a tenth of the largest), and what shrinks the largest: a
// dataset keeps fewer rows, the page shorter tables.
function dmvDashboardTooLarge_(sizes, parts) {
  var known = sizes
    .filter(function (size) {
      return parts[size.id];
    })
    .sort(function (a, b) {
      return b.size - a.size;
    });
  var largest = known
    .filter(function (size, index) {
      return index < 3 && size.size * 10 >= known[0].size;
    })
    .map(function (size) {
      return parts[size.id];
    });
  var count = function (number, noun) {
    return number.toLocaleString() + ' ' + noun + (number === 1 ? '' : 's');
  };
  var lead = 'This dashboard is too large for one Sheets write.';
  return dmvDashboardMessage_(
    lead + (largest.length ? ' Largest parts: ' : ' '),
    largest.map(function (part) {
      return (
        part.label + ' (' + count(part.rows, 'row') + ' x ' + count(part.columns, 'column') + ')'
      );
    }),
    largest.length ? '. ' : '',
    largest.length && largest[0].dataset
      ? dmvDashboardNarrow_('those datasets')
      : 'Lower the row limit of its longest table tiles, give them fewer metrics and ratios, or narrow its datasets.',
    largest.length && largest[0].dataset
      ? ' Then shorten the longest table tiles if the page is still too large.'
      : ''
  );
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
        lowerIsBetter: saved.lowerIsBetter,
        neutral: saved.neutral,
      },
      spreadsheet,
      true
    );
    plan.toned = saved.toned === true;
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
    var resolved = Object.create(null);
    plan.datasets.forEach(function (dataset, index) {
      resolved[dataset.id] = dates[index];
    });
    // Saving checks the periods; a plan saved before that check (without toned) refreshed with
    // its pairing before and keeps refreshing, so no scheduled dashboard starts failing.
    if (plan.toned) dmvDashboardCheckPeriods_(plan, resolved);
    var session = dmvChatSession_(spreadsheet);
    session.deadline = deadline;
    // Refresh inputs are not follow-up material for a chat turn, so they skip the result cache.
    session.transient = true;
    var now = new Date(),
      clock = Utilities.formatDate(now, timezone, 'yyyy-MM-dd HH:mm');
    var stamp = clock + ' (' + timezone + ')';
    // The band reads like the period beside it: "1 Oct 2026, 03:29 PDT".
    var refreshed =
      dmvDashboardPeriod_([{ startDate: clock.slice(0, 10), endDate: clock.slice(0, 10) }]) +
      ', ' +
      clock.slice(11) +
      ' ' +
      Utilities.formatDate(now, timezone, 'z');
    var fetched = {},
      fetchedRows = 0,
      outputs = [],
      sources = [],
      counts = {},
      // The period each dataset holds (null without one), and its label, by dataset id.
      ranges = {},
      labels = {},
      // Datasets a connector cut to their top rows, and each dataset's own note, by id.
      tops = {},
      notes = {},
      // What each output holds, by output id, to name the largest parts of a write too large.
      parts = {};
    plan.datasets.forEach(function (dataset, index) {
      phase(
        'Fetching dataset ' + (index + 1) + ' of ' + plan.datasets.length + ': ' + dataset.label
      );
      var result;
      try {
        result = dmvFetchReport_(queries[index], spreadsheet, deadline);
      } catch (error) {
        var reason = dmvSafeError_(error, {});
        // A dashboard needs the rows worth acting on, not every row: narrowing comes first,
        // the row limit setting only after it. A dataset's period is the page's, so a source's
        // advice to shorten the date range is left out: it would mix periods on one page.
        if (!/exceeds the row limit|too many rows|more than .*rows/i.test(reason))
          throw new Error(dataset.label + ': ' + reason);
        reason = reason.replace(/\s*[^.]*\bdate range\b[^.]*\./gi, '') || reason;
        throw new Error(
          dmvDashboardMessage_(
            dataset.label +
              ': ' +
              reason +
              ' This dataset allows ' +
              queries[index].maxRows.toLocaleString() +
              ' rows. ',
            [],
            '',
            dmvDashboardNarrow_(''),
            ' Only then raise Maximum rows per chat report (Settings > AI provider, up to ' +
              DMV_LIMITS.maxRows.toLocaleString() +
              ').'
          )
        );
      }
      dmvDashboardDeadline_(deadline);
      fetchedRows += result.rows.length;
      counts[dataset.id] = result.rows.length;
      labels[dataset.id] = dataset.label;
      if (fetchedRows > DMV_LIMITS.maxRows)
        throw new Error(
          dmvDashboardMessage_(
            'The dashboard datasets exceed ' +
              DMV_LIMITS.maxRows.toLocaleString() +
              ' rows together (',
            plan.datasets
              .slice(0, index + 1)
              .sort(function (a, b) {
                return counts[b.id] - counts[a.id];
              })
              .map(function (item) {
                return item.label + ' ' + counts[item.id].toLocaleString();
              }),
            '). ',
            dmvDashboardNarrow_('the largest datasets')
          )
        );
      var resultId = dmvChatResultId_();
      session.results[resultId] = result;
      fetched[dataset.id] = resultId;
      var metadata = result.metadata || {};
      tops[dataset.id] = dmvDashboardTopOf_(result);
      notes[dataset.id] =
        typeof metadata.note === 'string' && metadata.note.trim()
          ? metadata.note.trim()
          : tops[dataset.id]
            ? 'Top ' + tops[dataset.id].rows.toLocaleString() + ' rows'
            : '';
      // A custom query without metrics (negative keywords, settings) reports no period.
      ranges[dataset.id] = dates[index] && metadata.dateFiltered !== false ? dates[index] : null;
      var connector = dmvConnector_(dataset.connectorId);
      var provenance = [
        dataset.label,
        connector.label,
        dmvReadConnection_(dataset.connectionId).label,
        dmvDefinition_(connector, dataset.reportType).label,
        ranges[dataset.id]
          ? ranges[dataset.id].startDate + ' to ' + ranges[dataset.id].endDate
          : 'No date range',
        result.rows.length,
        dataset.sheetName,
      ];
      // The page names the period as the band does; the data tab keeps the dates as stored.
      sources.push(
        provenance
          .slice(0, 4)
          .concat([
            ranges[dataset.id] ? dmvDashboardPeriod_([ranges[dataset.id]]) : 'No date range',
          ])
          .concat(provenance.slice(5))
          .concat([notes[dataset.id]])
      );
      var width = result.columns.length;
      var outputId = dmvDashboardOutputId_(dashboard, dataset);
      parts[outputId] = {
        label: dataset.label,
        rows: result.rows.length,
        columns: width,
        dataset: true,
      };
      outputs.push({
        report: {
          id: outputId,
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
                  ' rows' +
                  (notes[dataset.id] ? ' · ' + notes[dataset.id] : '') +
                  ' · Refreshed ' +
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
    var context = {
        session: session,
        memo: {},
        ranges: ranges,
        labels: labels,
        tops: tops,
        datasets: {},
      },
      cards = [],
      blocks = [],
      previousIds = Object.create(null);
    plan.datasets.forEach(function (dataset) {
      context.datasets[dataset.id] = dataset;
    });
    plan.tiles.forEach(function (tile) {
      var input = dmvDashboardInput_(session, plan.datasets, tile, fetched, context.memo);
      if (tile.compare)
        dmvDashboardIds_(tile.compare.previous).forEach(function (id) {
          previousIds[id] = true;
        });
      // A formula over a column only discovered now is checked now; its error names the formula,
      // and the tile is added so the owner can find it.
      var named = function (build) {
        try {
          return build(context, input, tile);
        } catch (error) {
          if (/^Formula (key )?"/.test(error.message))
            throw new Error('"' + tile.title + '": ' + error.message);
          throw error;
        }
      };
      if (tile.type === 'kpi') {
        cards = cards.concat(named(dmvDashboardCards_));
        return;
      }
      var chart = dmvDashboardIsChart_(tile);
      var block = named(chart ? dmvDashboardChartTable_ : dmvDashboardTable_);
      block.title = tile.title;
      block.type = tile.type;
      block.chart = chart;
      // A tile over datasets cut to their top rows says so first: "top 100 by Cost · top 15
      // of 40" is the top 15 rows of the tile, drawn from the top 100 of the dataset.
      block.top = dmvDashboardTileTop_(context, tile);
      if (block.top) block.note = [block.top.note, block.note].filter(Boolean).join(' · ');
      blocks.push(block);
      dmvDashboardDeadline_(deadline);
    });
    // Every card is kept: money split by currency may give more cards than kpi values, and the
    // page lays out as many rows of them as it takes.
    cards.forEach(function (card) {
      if (card.previous === undefined) return;
      card.delta = dmvDashboardDelta_(card.value, card.previous);
      card.tone = dmvDashboardTone_(plan, card.key, card.delta);
    });
    var highlights = dmvDashboardHighlights_(cards, blocks);
    var periods = plan.datasets.map(function (dataset) {
      return ranges[dataset.id];
    });
    var page = dmvDashboardPage_(dashboard, {
      plan: plan,
      stamp: refreshed,
      // The band names the period of the current datasets and, beside it, the compared one.
      period: dmvDashboardPeriod_(
        periods.filter(function (range, index) {
          return !previousIds[plan.datasets[index].id];
        })
      ),
      previousPeriod: dmvDashboardPeriod_(
        periods.filter(function (range, index) {
          return previousIds[plan.datasets[index].id];
        })
      ).replace(/^Several/, 'several'),
      cards: cards,
      highlights: highlights,
      blocks: blocks,
      sources: sources,
    });
    if (JSON.stringify(page.matrix).length > DMV_LIMITS.maxBytes)
      throw new Error('The dashboard tab is too large. Use fewer or smaller tiles.');
    parts[dashboard.id + '-charts'] = {
      label: 'the hidden chart data tab',
      rows: page.data.matrix.length,
      columns: page.data.matrix.length ? page.data.matrix[0].length : 0,
    };
    parts[dashboard.id + '-report'] = {
      label: 'the dashboard page',
      rows: page.matrix.length,
      columns: page.width,
    };
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
      try {
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
              areas.slice(0, -2),
              page.frozen,
              current.chartIds || [],
              outcome
            );
          }
        );
      } catch (error) {
        // What grows with a plan is its datasets and its long tables: name them, not the report.
        if (error.tooLarge) throw new Error(dmvDashboardTooLarge_(error.parts || [], parts));
        throw error;
      }
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
      current.nextRunAt = dmvNextRun_(current.schedule, current.at, timezone);
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
            // The connector's own note, such as "Top 100 by Cost" for a ranked list.
            note: notes[output.id] || undefined,
            url: dmvSheetLink_(spreadsheet, { sheetName: output.sheetName, startCell: 'A1' }),
          };
        }),
        rowCount: fetchedRows,
        chartCount: page.charts.length,
        scorecards: cards.map(function (card) {
          var item = { label: card.label, value: card.value };
          if (card.previous !== undefined) {
            item.previous = card.previous;
            item.change = dmvDashboardChange_(card);
            // good, bad or neutral: the colour of the change, after the plan's polarity.
            item.tone = card.tone;
          }
          return item;
        }),
        highlights: highlights.map(function (item) {
          return item.text;
        }),
        tiles: blocks.map(function (block) {
          return {
            title: block.title,
            type: block.type,
            rows: block.matrix.length - 1,
            note: block.note || undefined,
            preview: dmvDashboardPreview_(block),
            hiddenColumns:
              Math.max(0, block.matrix[0].length - DMV_DASHBOARD.previewColumns) || undefined,
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
          current.nextRunAt = dmvNextRun_(current.schedule, current.at, timezone);
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
