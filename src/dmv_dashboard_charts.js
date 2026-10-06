/* Dashboard charts: the table behind each chart tile, period comparisons over date buckets,
   and the requests that add, update, move or remove the native charts in the write batch. */
var DMV_DASHBOARD_MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');

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
    limit: DMV_CHAT_RESULTS.maxSummaryRows,
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
          // What its points add up, for their formulas: the column and the split's values.
          item: dmvDashboardItem_(tile, base, column),
          keys: splits.map(function (split) {
            return { key: split.key, value: row[split.key] };
          }),
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
    // Each point as a formula over the data tabs; a chart without rows has no points to follow.
    formulas: points.map(function (point) {
      return series.map(function (item) {
        return empty
          ? null
          : dmvDashboardLive_(
              context,
              tile,
              null,
              base,
              item.item,
              [{ key: dimensions[0].key, value: point.x }].concat(item.keys),
              null,
              dmvDashboardBlank_(point.values[item.name])
            );
      });
    }),
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

// The first day dmvDashboardBucket_ counts into bucket index or a later one. A month or year
// bucket starts on the start's day of its month, or on the 1st after a month too short for it.
function dmvDashboardBucketStart_(start, index, bucket) {
  if (bucket === 'day' || bucket === 'week')
    return new Date(
      Date.parse(start + 'T12:00:00Z') + index * (bucket === 'week' ? 7 : 1) * 86400000
    )
      .toISOString()
      .slice(0, 10);
  var year = Number(start.slice(0, 4)),
    month = Number(start.slice(5, 7)) - 1 + index * (bucket === 'year' ? 12 : 1),
    day = Number(start.slice(8, 10));
  var fits = day <= new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, fits ? month : month + 1, fits ? day : 1))
    .toISOString()
    .slice(0, 10);
}

// The first day of a bucket, counted from the first day of the current period. A month or year
// bucket that starts on the first of a month reads as that month or year.
function dmvDashboardBucketLabel_(start, index, bucket) {
  if (bucket === 'day' || bucket === 'week') return dmvDashboardBucketStart_(start, index, bucket);
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
        // A side is a sum or a count (dmvChatRatioSide_); counts add up over days, distinct
        // counts do not.
        var sides = [ratio.numerator, ratio.denominator].map(function (field) {
          var side = dmvChatRatioSide_(base, field, 'ratio column');
          if (side.agg === 'count_distinct')
            throw new Error(
              name +
                ': a compared chart adds days up into buckets, so its metrics use sum, avg, min, max or count.'
            );
          return side;
        });
        var money = sides.filter(function (side) {
          return side.agg === 'sum' && side.column.type === 'currency';
        }).length;
        return {
          name: ratio.key,
          agg: 'ratio',
          label: ratio.label || ratio.key,
          type: money === 1 ? 'currency' : ratio.percent ? 'percent' : 'number',
          numerator: part(sides[0].column.key, sides[0].agg),
          denominator: part(sides[1].column.key, sides[1].agg),
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
  // Each split by its name, and the values it stands for.
  var splits = [],
    splitKeys = Object.create(null);
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
      var keys = extra.map(function (column) {
        return {
          key: column.key,
          value: dmvDashboardBlank_(row[column.key]) ? '' : String(row[column.key]),
        };
      });
      var split = keys
        .map(function (entry) {
          return entry.value;
        })
        .join(' · ');
      if (splits.indexOf(split) < 0) {
        splits.push(split);
        splitKeys[split] = keys;
      }
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
  // Bucket i of each dataset: its days from the first day of its own period, a previous one's
  // cut to the days it keeps.
  var startOf = function (member) {
    return context.ranges[member.dataset.id].startDate;
  };
  var bounds = function (index, previous) {
    return [
      {
        key: axis.key,
        op: 'gte',
        value: function (member) {
          return dmvDashboardBucketStart_(startOf(member), index, bucket);
        },
      },
      {
        key: axis.key,
        op: 'lt',
        value: function (member) {
          var end = dmvDashboardBucketStart_(startOf(member), index + 1, bucket);
          if (!previous || !sameDays) return end;
          var cut = dmvDashboardBucketStart_(startOf(member), keep[member.label], 'day');
          return cut < end ? cut : end;
        },
      },
    ];
  };
  var formulas = [];
  for (var i = first; i < count; i++) {
    var values = ordered.map(function (item) {
      return valueAt(sides[item.previous ? 1 : 0].cells[i + '|' + item.split], item.spec);
    });
    matrix.push([dmvDashboardBucketLabel_(origin, i, bucket)].concat(values));
    // Each point as a formula over the data tabs.
    formulas.push(
      ordered.map(function (item, at) {
        return dmvDashboardLive_(
          context,
          tile,
          item.previous ? 'previous' : 'current',
          base,
          { agg: item.spec.agg, name: item.spec.name },
          (splitKeys[item.split] || []).concat(bounds(i, item.previous)),
          null,
          values[at] === ''
        );
      })
    );
  }
  var block = {
    formulas: formulas,
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
