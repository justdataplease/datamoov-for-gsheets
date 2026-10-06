/* Live dashboard numbers: every number a dashboard page shows is a formula over the data tabs it
   came from, so it follows their cells. The runtime still decides the page's shape from the rows
   it fetched (which groups rank, row counts, patterns, colours, highlights); these helpers only
   write the arithmetic, with the same filters, groups and blank rules the in-memory summary used.
   A value is an IFS-family formula over bounded ranges of the data tabs where those functions
   say it exactly; where they cannot (text Sheets would read as a number, an error or an
   operator, booleans, names that differ only in case, timestamps, text tests of numbers, a
   column of mixed types), it is a SUMPRODUCT or FILTER formula over the same ranges whose tests
   compare exactly as the summary does. */

// The first data row of a data tab: three provenance rows and a header come before it. A tab the
// user keeps (a tab dataset) sets its own firstRow.
var DMV_DASHBOARD_FIRST_ROW = 5;

// The datasets one side of a tile reads ('current' or 'previous' of a compare, or null for all of
// its datasets), each with the label its rows carry as their source.
function dmvDashboardMembers_(context, tile, side) {
  var ids = side ? dmvDashboardIds_(tile.compare[side]) : tile.datasets;
  var names = side === 'previous' ? dmvDashboardRenamed_(context, tile) : null;
  return ids.map(function (id, index) {
    return {
      dataset: context.datasets[id],
      tab: context.tabs[id],
      label: names ? names[index] : context.labels[id],
    };
  });
}

// Where a tile column lies on a member's data tab: { range, date } for a column of the tab, or
// { value } for what every row shares: the source label, an account currency, or blank for a
// column the dataset lacks.
function dmvDashboardMemberColumn_(member, key) {
  var dataset = member.dataset,
    tab = member.tab,
    field = key;
  if (dataset.mapping) {
    if (key === 'source') return { value: member.label };
    var entry = dataset.mapping.filter(function (item) {
      return item.key === key;
    })[0];
    if (entry) field = entry.field;
    else if (key !== 'currency') return { value: '' };
    else if (!tab.metadata.currencyColumn)
      return { value: tab.metadata.currency || tab.metadata.currencyCode || '' };
    else field = tab.metadata.currencyColumn;
  }
  var column;
  try {
    column = dmvChatColumn_({ columns: tab.columns }, field, 'column');
  } catch (ignored) {
    return { value: '' };
  }
  return dmvDashboardTabColumn_(tab, tab.columns.indexOf(column));
}

// Column index of a data tab as { range, date }: its cells from the first data row to the last.
function dmvDashboardTabColumn_(tab, index) {
  var letter = dmvChatActionColumn_(index + 1),
    first = tab.firstRow || DMV_DASHBOARD_FIRST_ROW;
  return {
    range:
      dmvChatActionTab_(tab.sheet) +
      ('$' + letter + '$' + first) +
      (':$' + letter + '$' + (first + tab.rows - 1)),
    date: !!tab.dates[index],
  };
}

// The days a date group spans, as [first, first after] yyyy-mm-dd: a day, a week from its Monday,
// a month (yyyy-mm) or a year (yyyy). null for a value no bucket of days gives.
function dmvDashboardBucketDays_(text, bucket) {
  var start = bucket === 'month' ? text + '-01' : bucket === 'year' ? text + '-01-01' : text;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return null;
  var next = new Date(
    Date.UTC(
      Number(start.slice(0, 4)) + (bucket === 'year' ? 1 : 0),
      Number(start.slice(5, 7)) - 1 + (bucket === 'month' ? 1 : 0),
      Number(start.slice(8, 10)) + (bucket === 'day' ? 1 : bucket === 'week' ? 7 : 0)
    )
  );
  return [start, next.toISOString().slice(0, 10)];
}

// A value as a formula's text constant.
function dmvDashboardText_(value) {
  return '"' + String(value).replace(/"/g, '""') + '"';
}

// The options of an "in" filter, as the summary reads them: trimmed, in lower case, each once.
function dmvDashboardOptions_(value) {
  return String(value)
    .split(',')
    .map(function (item) {
      return item.trim().toLowerCase();
    })
    .filter(function (item, at, list) {
      return list.indexOf(item) === at;
    });
}

// The IFS criteria that keep the rows one condition keeps for one value (op 'eq' for each option
// of "in"): a list of criteria, false when no row passes, or null when no criterion says it
// exactly.
function dmvDashboardCriteria_(column, condition, op, value) {
  var symbols = { eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };
  var plain = value === null || value === undefined ? '' : value;
  if (column.date) {
    if (condition.bucket) {
      var days = dmvDashboardBucketDays_(String(plain), condition.bucket);
      return days ? ['>=' + dmvDaySerial_(days[0]), '<' + dmvDaySerial_(days[1])] : null;
    }
    return symbols[op] && /^\d{4}-\d{2}-\d{2}$/.test(String(plain))
      ? [symbols[op] + dmvDaySerial_(String(plain))]
      : null;
  }
  // A date column written as text (timestamps) has no dates to bucket.
  if (condition.bucket) return null;
  // contains reads a number as the text it prints, where a wildcard finds no text in a number.
  if (condition.numeric) {
    var number = Number(plain);
    return !symbols[op] ? null : isFinite(number) ? [symbols[op] + number] : false;
  }
  // A group of numbers holds numbers; a filter compares the text a number prints.
  if (condition.group && typeof plain === 'number') return ['=' + plain];
  plain = String(plain);
  var escaped = plain.replace(/[~*?]/g, '~$&');
  if (op === 'contains') return plain ? ['*' + escaped + '*'] : [];
  // Text Sheets would read as a number, date or boolean would match only such cells.
  if ((op === 'eq' || op === 'ne') && !dmvDashboardCoerced_(plain)) return [symbols[op] + escaped];
  return null;
}

// Whether Sheets may read a criterion's text as something other than that text: a number, a
// date, a time or a boolean, as it reads text typed into a cell ("12", "50%", "$5", "1/2",
// "2026-09", "Sep 2026", "10:00", "TRUE"): digits with only signs, separators, symbols and month
// or am/pm words, or TRUE or FALSE; or an error or an operator of its own ("#N/A", "<5", "=x").
function dmvDashboardCoerced_(text) {
  var plain = text.trim();
  if (/^(true|false)$/i.test(plain) || /^[<>=#]/.test(plain)) return true;
  if (!/\d/.test(plain) || /[^a-z\d\s+\-.,/:%()$€£¥]/i.test(plain)) return false;
  return (plain.match(/[a-z]+/gi) || []).every(function (word) {
    return /^(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?|[ap]m?|[etz])$/i.test(
      word
    );
  });
}

// One condition as IFS criteria pairs over its column: { pairs } for criteria a row meets
// together, { pairs, arrayed } for one array criterion a row meets one of ("in", or a blank a
// filter keeps). false when no row passes, null when the IFS functions cannot say it exactly.
function dmvDashboardIfs_(column, condition, value) {
  if (condition.cased || condition.mixed) return null;
  var op = condition.op === 'in' ? 'eq' : condition.op,
    options = condition.op === 'in' ? dmvDashboardOptions_(value) : [value],
    alternatives = [];
  for (var at = 0; at < options.length; at++) {
    // "in" matches a number by the text it prints: "1.0" names no number, where =1.0 finds 1.
    if (condition.op === 'in' && condition.numeric && String(Number(options[at])) !== options[at])
      return null;
    var criteria = dmvDashboardCriteria_(column, condition, op, options[at]);
    if (criteria === null) return null;
    if (criteria) alternatives.push(criteria);
  }
  // A filter reads a blank number as 0 and a blank date as text that sorts first, where the IFS
  // functions skip blank cells except for <>: a blank the filter keeps is one more
  // alternative, one it drops one more criterion.
  if (
    condition.filter &&
    (condition.numeric || column.date) &&
    /^(eq|ne|gt|gte|lt|lte)$/.test(condition.op)
  ) {
    var blank = dmvChatCompare_('', condition.op, value, condition.numeric);
    if (blank && condition.op !== 'ne') alternatives.push(['']);
    if (!blank && condition.op === 'ne')
      alternatives.forEach(function (list) {
        list.push('<>');
      });
  }
  if (!alternatives.length) return false;
  if (alternatives.length === 1)
    return {
      pairs: alternatives[0]
        .map(function (criterion) {
          return column.range + ',' + dmvDashboardText_(criterion);
        })
        .join(','),
    };
  if (
    alternatives.some(function (list) {
      return list.length > 1;
    })
  )
    return null;
  return {
    pairs:
      column.range +
      ',{' +
      alternatives
        .map(function (list) {
          return dmvDashboardText_(list[0]);
        })
        .join(';') +
      '}',
    arrayed: true,
  };
}

// The rows of one column a condition keeps, as a test of each cell for SUMPRODUCT and FILTER,
// exactly as the summary compares: a group by the value itself, of its own type (a date group by
// the days it spans, of serials or of the text timestamps start with), a filter by
// dmvChatCompare_ (numbers as numbers and a blank as 0, but text never, as the IFS functions
// read a number column; everything else as the text it prints, in lower case). Sheets compares
// values of one type only, text without regard to case. false when no row passes.
function dmvDashboardMask_(column, condition, value) {
  var range = column.range,
    op = condition.op,
    plain = value === null || value === undefined ? '' : value;
  var symbols = { eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };
  if (condition.group) {
    // An empty cell equals 0 and FALSE: the summary keeps blanks in a group of their own.
    if (typeof plain === 'number' || typeof plain === 'boolean')
      return (
        (typeof plain === 'number' ? 'ISNUMBER(' : 'ISLOGICAL(') +
        range +
        ')*(' +
        range +
        '=' +
        String(plain).toUpperCase() +
        ')'
      );
    plain = String(plain);
    var days = plain && condition.bucket && dmvDashboardBucketDays_(plain, condition.bucket);
    // EXACT reads a number or a boolean as the text it prints.
    if (!days)
      return (
        (plain ? 'ISTEXT(' + range + ')*' : '') +
        'EXACT(' +
        range +
        ',' +
        dmvDashboardText_(plain) +
        ')'
      );
    // Text that starts with a day sorts from that day to the next one.
    var bound = column.date ? dmvDaySerial_ : dmvDashboardText_;
    return '(' + range + '>=' + bound(days[0]) + ')*(' + range + '<' + bound(days[1]) + ')';
  }
  if (symbols[op] && condition.numeric) {
    var number = Number(plain);
    if (!isFinite(number)) return false;
    return (
      'ISNUMBER(' +
      range +
      ')*(' +
      range +
      symbols[op] +
      number +
      ')' +
      (dmvChatCompare_('', op, value, true) ? '+(' + range + '="")' : '')
    );
  }
  // A blank date is 0, before every day, as a blank sorts before every day's text.
  if (symbols[op] && column.date && /^\d{4}-\d{2}-\d{2}$/.test(String(plain)))
    return range + symbols[op] + dmvDaySerial_(String(plain));
  if (op === 'in') {
    var tests = dmvDashboardOptions_(plain)
      .map(function (option) {
        if (column.date)
          return /^\d{4}-\d{2}-\d{2}$/.test(option)
            ? range + '=' + dmvDaySerial_(option)
            : option
              ? null
              : range + '=""';
        // Only an option a number or a boolean could print needs the text of each cell.
        var cell = /^(true|false|[\d.e+-]+)$/.test(option) ? 'LOWER(' + range + ')' : range;
        return cell + '=' + dmvDashboardText_(option);
      })
      .filter(Boolean);
    return tests.length ? '(' + tests.join(')+(') + ')' : false;
  }
  var lower = String(plain).toLowerCase(),
    shown = column.date ? 'TEXT(' + range + ',"yyyy-mm-dd")' : 'LOWER(' + range + ')';
  var test =
    op === 'contains'
      ? 'ISNUMBER(FIND(' + dmvDashboardText_(lower) + ',' + shown + '))'
      : shown + symbols[op] + dmvDashboardText_(lower);
  if (!column.date) return test;
  // A blank date prints as no text, where TEXT would print 1899-12-30.
  return (
    '(' +
    range +
    '<>"")*(' +
    test +
    ')' +
    (dmvChatCompare_('', op, value, false) ? '+(' + range + '="")' : '')
  );
}

// The rows of a member that meet the conditions: pairs for the IFS functions ('' for none, null
// when they cannot say them exactly or would need two array criteria), arrayed when they hold an
// array criterion, and mask, the product of the cell tests ('' for none). null when no row passes.
// A condition's value may be a function of the member, such as the first day of its own period;
// a tile filter (filter: true) keeps the rows dmvChatCompare_ keeps, blanks included. A tab
// dataset's period comes first, as conditions on its date column (tab.period).
function dmvDashboardRows_(member, conditions) {
  var pairs = [],
    masks = [],
    arrays = 0,
    exact = true;
  conditions = (member.tab.period || []).concat(conditions);
  for (var index = 0; index < conditions.length; index++) {
    var condition = conditions[index],
      value = typeof condition.value === 'function' ? condition.value(member) : condition.value,
      column = condition.column || dmvDashboardMemberColumn_(member, condition.key);
    if (!('range' in column)) {
      var keeps = condition.group
        ? String(column.value) === String(value === null || value === undefined ? '' : value)
        : dmvChatCompare_(column.value, condition.op, value, condition.numeric);
      if (!keeps) return null;
      continue;
    }
    var mask = dmvDashboardMask_(column, condition, value),
      ifs = exact ? dmvDashboardIfs_(column, condition, value) : null;
    if (mask === false || ifs === false) return null;
    masks.push('(' + mask + ')');
    if (!ifs) exact = false;
    else {
      if (ifs.pairs) pairs.push(ifs.pairs);
      if (ifs.arrayed) arrays++;
    }
  }
  return {
    pairs: exact && arrays < 2 ? pairs.join(',') : null,
    arrayed: arrays > 0,
    // A product, so SUMPRODUCT reads numbers where a single test gives TRUE or FALSE.
    mask: masks.join('*') + (masks.length === 1 ? '*1' : ''),
  };
}

// What one member adds to an aggregate of a column over the rows it keeps (rows of
// dmvDashboardRows_, count rows in all): its rows, the cells the aggregate reads (filled: its
// numbers for a sum, an average, a minimum or a maximum (numeric), any value for a count) and
// their sum, its minimum or maximum (extreme(name)), its distinct count when one formula says it
// (distinct), and the values and tests a distinct count over several members stacks. A column of
// mixed types counts its numbers by ISNUMBER, where COUNTIFS would count text too, and its
// distinct values by the text they print, as the summary does. A column every row shares adds
// its value to each row it keeps.
function dmvDashboardPart_(column, rows, count, numeric, mixed) {
  var exact = rows.pairs !== null;
  var ifs = function (name, head) {
    var call = name + '(' + [head, rows.pairs].filter(Boolean).join(',') + ')';
    // SUMPRODUCT reads the array criterion as an array, one result per option, and adds them.
    return rows.arrayed ? 'SUMPRODUCT(' + call + ')' : call;
  };
  var size = !exact ? 'SUMPRODUCT(' + rows.mask + ')' : rows.pairs ? ifs('COUNTIFS', '') : count;
  if (!('range' in column)) {
    var filled = !dmvDashboardBlank_(column.value);
    return {
      size: size,
      filled: filled ? size : null,
      sum: null,
      extreme: null,
      distinct: null,
      values: filled ? dmvDashboardText_(column.value) : null,
      kept: size,
    };
  }
  var range = column.range,
    single = exact && !rows.arrayed,
    kept = (numeric ? 'ISNUMBER(' + range + ')' : '(' + range + '<>"")') + '*' + (rows.mask || '1');
  return {
    size: size,
    filled:
      exact && !(numeric && mixed) ? ifs('COUNTIFS', range + ',"<>"') : 'SUMPRODUCT(' + kept + ')',
    sum: !exact
      ? 'SUMPRODUCT(' + range + ',' + rows.mask + ')'
      : rows.pairs
        ? ifs('SUMIFS', range)
        : 'SUM(' + range + ')',
    extreme: function (name) {
      if (!single) return name + '(FILTER(' + range + ',' + kept + '>0))';
      return rows.pairs ? name + 'IFS(' + range + ',' + rows.pairs + ')' : name + '(' + range + ')';
    },
    distinct:
      !single || mixed
        ? null
        : rows.pairs
          ? 'COUNTUNIQUEIFS(' + range + ',' + rows.pairs + ')'
          : 'COUNTUNIQUE(' + range + ')',
    // A number as the text it prints, a boolean in lower case, as String() prints them.
    values: mixed ? 'IF(ISTEXT(' + range + '),' + range + ',LOWER(' + range + '))' : range,
    kept: kept,
  };
}

// One aggregate of a tile column over the members' rows that meet the conditions, as the
// in-memory summary computes it: a sum, a count of filled cells, a distinct count, an average,
// a minimum or a maximum, or a term: the sum as a ratio or formula reads it. Averages, minimums
// and maximums are blank without values. A value blank at refresh (blank) says when it is blank
// too: a sum or count of a group without values or rows, and a term as an error, so the ratio
// or formula over it reads blank. Any other value is 0 there, as the plain sum and count are.
// mixed says the column holds values of another type than its own (dmvDashboardFacts_).
function dmvDashboardAggregate_(members, conditions, key, agg, blank, mixed) {
  var parts = [],
    numeric = ['sum', 'avg', 'min', 'max', 'term'].indexOf(agg) >= 0;
  members.forEach(function (member) {
    if (!member.tab.rows) return;
    var rows = dmvDashboardRows_(member, conditions);
    if (rows)
      parts.push(
        dmvDashboardPart_(
          dmvDashboardMemberColumn_(member, key),
          rows,
          member.tab.rows,
          numeric,
          mixed
        )
      );
  });
  if (!parts.length) {
    if (agg === 'term') return blank ? 'NA()' : '0';
    return blank || ['sum', 'count', 'count_distinct'].indexOf(agg) < 0 ? '""' : '0';
  }
  var total = function (list) {
    list = list.filter(function (item) {
      return item !== null;
    });
    return !list.length ? '0' : list.length > 1 ? '(' + list.join('+') + ')' : String(list[0]);
  };
  var of = function (name) {
    return parts.map(function (part) {
      return part[name];
    });
  };
  var filled = total(of('filled')),
    sum = total(of('sum'));
  // A count blank at refresh is of a group without rows: rows pass for certain when a member has
  // no conditions on them.
  var rows = parts.some(function (part) {
    return typeof part.size === 'number';
  });
  var empty = function (value) {
    return !blank || rows ? value : 'IF(' + total(of('size')) + '=0,"",' + value + ')';
  };
  if (agg === 'term') return blank ? 'IF(' + filled + '=0,NA(),' + sum + ')' : sum;
  if (agg === 'sum') return blank ? 'IF(' + filled + '=0,"",' + sum + ')' : sum;
  if (agg === 'count') return empty(filled);
  if (agg === 'count_distinct') {
    // Otherwise the filled values of every member, stacked, counted once each.
    var stacked = parts.filter(function (part) {
      return part.values;
    });
    var stack = function (name) {
      return (
        'VSTACK(' +
        stacked
          .map(function (part) {
            return part[name];
          })
          .join(',') +
        ')'
      );
    };
    var distinct =
      parts.length === 1 && parts[0].distinct
        ? parts[0].distinct
        : !stacked.length
          ? '0'
          : 'IF(' +
            filled +
            '=0,0,COUNTUNIQUE(FILTER(' +
            stack('values') +
            ',' +
            stack('kept') +
            '>0)))';
    return empty(distinct);
  }
  if (agg === 'avg') return 'IFERROR((' + sum + ')/(' + filled + '),"")';
  // A minimum or maximum of no values is blank; MINIFS and MAXIFS would say 0.
  var extreme = agg === 'min' ? 'MIN' : 'MAX',
    ranged = parts.filter(function (part) {
      return part.extreme;
    });
  if (!ranged.length) return '""';
  var values = ranged.map(function (part) {
    return part.extreme(extreme);
  });
  return (
    'IF(' +
    filled +
    '=0,"",' +
    (ranged.length === 1
      ? values[0]
      : extreme +
        '(' +
        values
          .map(function (value, at) {
            return (
              'IF(' +
              ranged[at].filled +
              '=0,' +
              (agg === 'min' ? '' : '-') +
              '9E+307,' +
              value +
              ')'
            );
          })
          .join(',') +
        ')') +
    ')'
  );
}

// A summary value column as the plan names it: a metric by its field and aggregate, a ratio or a
// formula by its key.
function dmvDashboardItem_(tile, base, column) {
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
          return dmvChatColumn_(base, entry.field, 'metric').key + '__' + entry.agg === column.key;
        })[0];
  return {
    name: metric ? metric.field : column.key,
    agg: metric ? metric.agg : formula ? 'formula' : 'ratio',
  };
}

// The live value of one tile column (item: { agg, name }, a metric by its field, a ratio or a
// formula by its key) over one side of a tile, for the rows with the given group values (keys:
// [{ key, value }], a date in the tile's bucket) or within the given bounds (keys: [{ key, op,
// value }]). sibling(key) names the cell of the same row that already holds the sum of a
// column, or null; blank says the value read blank at refresh (dmvDashboardAggregate_).
function dmvDashboardLive_(context, tile, side, base, item, keys, sibling, blank) {
  var members = dmvDashboardMembers_(context, tile, side);
  var facts = function (key) {
    return dmvDashboardFacts_(context, tile, base, key);
  };
  var conditions = (tile.filters || [])
    .map(function (filter) {
      var column = dmvChatColumn_(base, filter.field, 'filter column');
      return {
        key: column.key,
        op: String(filter.op || 'eq'),
        value: filter.value,
        numeric: dmvChatNumeric_(column),
        filter: true,
        mixed: facts(column.key).mixed,
      };
    })
    .concat(
      keys.map(function (entry) {
        var column = dmvChatColumn_(base, entry.key, 'groupBy column'),
          group = !entry.op;
        return {
          key: column.key,
          op: entry.op || 'eq',
          value: entry.value,
          numeric: false,
          group: group,
          bucket: group && column.type === 'date' ? tile.dateBucket || 'day' : undefined,
          // The summary keeps groups apart that the IFS functions, ignoring case, would add up.
          cased:
            group &&
            typeof entry.value === 'string' &&
            !!facts(column.key).cased[entry.value.toLowerCase()],
          mixed: facts(column.key).mixed,
        };
      })
    );
  var term = function (field) {
    var key = dmvChatColumn_(base, field, 'metric').key,
      cell = sibling && sibling(key);
    if (cell) return blank ? 'IF(' + cell + '="",NA(),' + cell + ')' : cell;
    return dmvDashboardAggregate_(members, conditions, key, 'term', blank, facts(key).mixed);
  };
  var ratios = Object.create(null);
  (tile.ratios || []).forEach(function (ratio) {
    ratios[ratio.key] = ratio;
  });
  // A ratio side is a sum, or a count of the column's filled or distinct values
  // (dmvChatRatioSide_): blank or 0 for a group without them, so the division reads blank.
  var side = function (field) {
    var part = dmvChatRatioSide_(base, field, 'metric');
    if (part.agg === 'sum') return term(field);
    var key = part.column.key;
    return dmvDashboardAggregate_(members, conditions, key, part.agg, blank, facts(key).mixed);
  };
  var divide = function (ratio) {
    return '(' + side(ratio.numerator) + ')/(' + side(ratio.denominator) + ')';
  };
  if (item.agg === 'ratio') return 'IFERROR(' + divide(ratios[item.name]) + ',"")';
  if (item.agg === 'formula') {
    var compiled = Object.create(null);
    dmvDashboardCompile_(base, tile.ratios, tile.formulas).forEach(function (formula) {
      compiled[formula.key] = formula;
    });
    // Blanks and divisions by zero turn into errors, and the whole formula then reads blank.
    var node = function (tree) {
      if (tree.type === 'num') return String(tree.value);
      if (tree.type === 'neg') return '-(' + node(tree.arg) + ')';
      if (tree.type === 'bin') return '(' + node(tree.left) + tree.op + node(tree.right) + ')';
      if (tree.type === 'call')
        return tree.name.toUpperCase() + '(' + tree.args.map(node).join(',') + ')';
      if (compiled[tree.key]) return '(' + node(compiled[tree.key].tree) + ')';
      if (ratios[tree.key]) return '(' + divide(ratios[tree.key]) + ')';
      return '(' + term(tree.key) + ')';
    };
    return 'IFERROR(' + node(compiled[item.name].tree) + ',"")';
  }
  var key = dmvChatColumn_(base, item.name, 'metric').key;
  return dmvDashboardAggregate_(members, conditions, key, item.agg, blank, facts(key).mixed);
}

// What the tile's rows hold in one column, read once: mixed when a value is not of the column's
// own type (text in a number column, a number or a boolean among text), and cased, by name in
// lower case, the names spelt in more than one case. The summary reads both otherwise than the
// IFS functions: it reads only numbers as numbers, finds text in what a number or a boolean
// prints, counts a distinct value by its text and keeps a name's spellings apart.
function dmvDashboardFacts_(context, tile, base, key) {
  var memo = 'facts:' + tile.datasets.join('|') + ':' + key;
  if (context.memo[memo]) return context.memo[memo];
  var own = dmvChatNumeric_(dmvChatColumn_(base, key, 'column')) ? 'number' : 'string',
    spellings = Object.create(null),
    facts = { mixed: false, cased: Object.create(null) };
  base.rows.forEach(function (row) {
    var value = row[key];
    if (dmvDashboardBlank_(value)) return;
    if (typeof value !== own) facts.mixed = true;
    if (typeof value !== 'string') return;
    var lower = value.toLowerCase();
    if (!(lower in spellings)) spellings[lower] = value;
    else if (spellings[lower] !== value) facts.cased[lower] = true;
  });
  return (context.memo[memo] = facts);
}

// A change cell: the relative change of the value in cell now against the previous expression,
// blank like dmvDashboardDelta_ when either side is blank or the previous value is 0. LET reads
// the previous value once: it may be many SUMIFS over a large tab.
function dmvDashboardDeltaFormula_(now, before) {
  return (
    'LET(previous,' +
    before +
    ',IF(OR(' +
    now +
    '="",previous=""),"",IFERROR((' +
    now +
    '-previous)/ABS(previous),"")))'
  );
}

// A scorecard's change line, as dmvDashboardChangeText_ words it, over the value in cell now and
// the previous expression, read once; pattern prints the previous value as the card printed it.
// TEXT follows the spreadsheet's locale, like the number formats of the cells around it.
function dmvDashboardChangeFormula_(now, before, pattern) {
  return (
    'LET(previous,' +
    before +
    ',IF(previous="","no previous value",IF(' +
    now +
    '="","no current value",IF(previous=0,"previous 0",IF(' +
    now +
    '>previous,"▲ ",IF(' +
    now +
    '<previous,"▼ ","▶ "))&TEXT(ABS((' +
    now +
    '-previous)/previous),"0.0%")&" vs "&TEXT(previous,"' +
    pattern.replace(/"/g, '""') +
    '")))))'
  );
}
