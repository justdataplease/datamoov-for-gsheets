/* The dashboard page: scorecards, table tiles, highlights and their layout on the twelve-column
   grid, with text fitted to its cards. */
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

// Changes print as "▲ 12.4%", "▼ 3.0%" or "▶ 0.0%": an icon beside the colour, never colour alone.
var DMV_DASHBOARD_DELTA = '"▲ "0.0%;"▼ "0.0%;"▶ "0.0%';

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
// 0.006 does not read 0.01), rates as percentages. They round half away from zero like a cell
// does, so 746.145 (stored as 746.1449...) reads 746.15 in the text and in the cell.
function dmvDashboardNumber_(value, type) {
  var number = Number(value);
  if (dmvDashboardBlank_(value) || !isFinite(number)) return '';
  if (type === 'percent') return dmvFormulaRoundTo_(number * 100, 2).toFixed(2) + '%';
  var whole = Math.abs(number) >= 1000 || (type !== 'currency' && number % 1 === 0);
  var digits = whole ? 0 : type !== 'currency' && Math.abs(number) < 1 ? 4 : 2;
  var parts = dmvFormulaRoundTo_(Math.abs(number), digits).toFixed(digits).split('.');
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
    base = dmvChatResult_(session, resultId),
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
          keys: [],
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
        keys: splits.map(function (column) {
          return { key: column.key, value: row[column.key] };
        }),
      };
    });
  }
  tile.metrics
    .map(function (metric) {
      return {
        key: metric.field,
        spec: { metrics: [metric] },
        item: { agg: metric.agg, name: metric.field },
      };
    })
    .concat(
      (tile.ratios || []).map(function (ratio) {
        return {
          key: ratio.key,
          spec: { metrics: [], ratios: [ratio] },
          item: { agg: 'ratio', name: ratio.key },
        };
      }),
      (tile.formulas || []).map(function (formula) {
        var needs = dmvDashboardNeeds_(tile, formula.key);
        return {
          key: formula.key,
          spec: { metrics: [], ratios: needs.ratios, formulas: needs.formulas },
          item: { agg: 'formula', name: formula.key },
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
        // The value and the change line follow the data tabs.
        card.formula = dmvDashboardLive_(
          context,
          tile,
          inputs.previous ? 'current' : null,
          base,
          item.item,
          entry.keys,
          null,
          card.value === ''
        );
        if (inputs.previous)
          card.before = dmvDashboardLive_(
            context,
            tile,
            'previous',
            base,
            item.item,
            entry.keys,
            null,
            card.previous === null
          );
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
      var named = dmvDashboardItem_(tile, base, column);
      item.name = named.name;
      item.agg = named.agg;
      // Rates, averages and formulas are shaded by rank; amounts get the bar instead.
      item.heat = item.agg === 'ratio' || item.agg === 'avg' || item.agg === 'formula';
      values.push(item);
    }
  });
  var currencyOf = function (row) {
    return currency && !dmvDashboardBlank_(row[currency]) ? String(row[currency]) : '';
  };
  var entries = summary.rows.map(function (row) {
    return {
      values: row,
      deltas: {},
      tint: null,
      bar: '',
      keys: dims.map(function (dim) {
        return { key: dim.key, value: row[dim.key] };
      }),
    };
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
      return {
        values: row,
        currency: split ? String(row[split]) : '',
        deltas: {},
        keys: split ? [{ key: split, value: row[split] }] : [],
      };
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
    // The live value of a column for a row's group values, on the current or previous side;
    // blank says it read blank at refresh.
    live: function (keys, column, previous, blank, sibling) {
      return dmvDashboardLive_(
        context,
        tile,
        tile.compare ? (previous ? 'previous' : 'current') : null,
        base,
        { agg: column.agg, name: column.name },
        keys,
        sibling,
        blank
      );
    },
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
// it. Numbers are formulas over the data tabs (dmv_dashboard_cells.js), the rest literal
// values; formats, merges and sizes come from the layout, and the page digest of what each cell
// holds as entered guards it like any output. Cards are placed by content column (1-based); the
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
  function put(at, column, value, cellOf) {
    if (typeof value === 'function') value = value(cellOf);
    matrix[at][column] = value instanceof DmvFormula_ ? value : dmvSheetValue_(value);
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
      var valueCell = dmvChatA1_(value + 1, place(column) + 1);
      text(value, place(column), cover(columns), new DmvFormula_('=' + item.formula), {
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
        line = new DmvFormula_(
          '=' +
            dmvDashboardChangeFormula_(
              valueCell,
              item.before,
              dmvDashboardPattern_(item.previous, item.type).pattern
            )
        );
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
        put(firstRow + offset, column, line.cells[index], function (key) {
          var found = entry.columns.filter(function (other) {
            return other.kind === 'value' && other.column.key === key;
          })[0];
          return found ? dmvChatA1_(firstRow + offset + 1, place(found.start) + 1) : null;
        });
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
      var shown = dmvDashboardPad_(
        !index
          ? [line[0]].concat(block.names || line.slice(1))
          : [block.labels ? block.labels[index - 1] : line[0]].concat(line.slice(1)),
        data.width
      );
      // The points are formulas over the data tabs.
      if (index)
        block.formulas[index - 1].forEach(function (live, at) {
          if (live) shown[at + 1] = new DmvFormula_('=' + live);
        });
      data.matrix.push(shown);
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
// with one decimal, other numbers as their values at refresh (the cells hold formulas).
function dmvDashboardDataColumn_(column, matrix, index) {
  if (column.type === 'percent') return { type: 'percent', pattern: '0.0%' };
  if (column.type === 'number')
    return {
      type: 'number',
      pattern: dmvNumberPattern_(
        matrix.slice(1).map(function (line) {
          return line[index];
        })
      ),
    };
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
    if (column.type !== 'number') return undefined;
    return column.agg === 'avg'
      ? '#,##0.0'
      : dmvNumberPattern_(
          rows.map(function (entry) {
            return entry.values[column.key];
          })
        );
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
      // Values and changes are formulas over the data tabs; a value reads the sums its row
      // already shows.
      var column = item.column;
      return function (cellOf) {
        if (item.kind === 'delta')
          return new DmvFormula_(
            '=' +
              dmvDashboardDeltaFormula_(
                cellOf(key),
                block.live(entry.keys, column, true, dmvDashboardBlank_(entry.deltas[key]))
              )
          );
        return new DmvFormula_(
          '=' +
            block.live(
              entry.keys,
              column,
              false,
              dmvDashboardBlank_(entry.values[key]),
              function (field) {
                return cellOf(field + '__sum');
              }
            )
        );
      };
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
