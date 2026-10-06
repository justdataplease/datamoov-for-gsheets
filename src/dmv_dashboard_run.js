/* Dashboard refresh: fetches every dataset fresh, summarizes each tile from the rows and writes
   the data tabs, the chart data tab and the page with its charts, without an AI call. */
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

// A data tab's title: its dataset label, source, connection and report, each said once. A part
// another part already holds in whole words goes, such as the source in "Google Ads 5317611041"
// and that account in a dataset labelled "Google Ads 5317611041 Prev".
function dmvDashboardProvenance_(parts) {
  var words = parts.map(function (part) {
    return ' ' + String(part).trim().toLowerCase().split(/\s+/).join(' ') + ' ';
  });
  return parts
    .filter(function (part, index) {
      return !words.some(function (other, at) {
        return (
          at !== index && other.indexOf(words[index]) >= 0 && (other !== words[index] || at < index)
        );
      });
    })
    .join(' · ');
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
  // Two unmapped periods of one report or tab (dmvDashboardPaired_): each side reads its own
  // rows, and the tile's columns are the current side's.
  if (dmvDashboardPaired_(tile.compare, members)) {
    var current = fetched[dmvDashboardIds_(tile.compare.current)[0]];
    memo['sides:' + current] = Object.create(null);
    members.forEach(function (dataset) {
      memo['sides:' + current][dataset.label] = fetched[dataset.id];
    });
    return (memo[key] = current);
  }
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
  // A paired side is one dataset's own rows, with the source column a combined side has.
  var direct = context.memo['sides:' + resultId];
  if (direct && labels.length === 1 && direct[labels[0]]) {
    var own = dmvChatResult_(context.session, direct[labels[0]]),
      name = renamed ? renamed[0] : labels[0];
    return (context.memo[key] = dmvChatStoreResult_(context.session, {
      columns: [{ key: 'source', label: 'Source', type: 'text', role: 'dimension' }].concat(
        own.columns.filter(function (column) {
          return column.key !== 'source';
        })
      ),
      rows: own.rows.map(function (row) {
        return Object.assign({}, row, { source: name });
      }),
      metadata: own.metadata,
      source: own.source,
    }));
  }
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

// A dashboard shows the rows worth acting on, not a full dump: what narrows a dataset that is
// too large, in words that fit every source. A query's own LIMIT is left to the sources whose
// description offers it, as only those label the rows it keeps; elsewhere it would cut a list
// without a word.
function dmvDashboardNarrow_(subject) {
  return (
    'Keep only the rows worth acting on' +
    (subject ? ' in ' + subject : '') +
    ": a ranked report's Keep the top rows, query conditions or aggregation, or fewer dimensions."
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
// per-output sizes (those at least a tenth of the largest), and what shrinks them. The rows of
// the data tabs follow in further writes, so only the page and its chart data can be too large.
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
    'Lower the row limit of its longest table tiles, give them fewer metrics and ratios, or narrow its datasets.'
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
      // A tab dataset reads its tab when the rows are read; its period is anchored here too.
      if (dmvDashboardIsTab_(dataset)) {
        dates[index] = dataset.dateRange ? dmvDateRange_(dataset.dateRange, today) : null;
        return null;
      }
      revisions[dataset.connectionId] = dmvConnectionRevision_(
        dmvReadConnection_(dataset.connectionId)
      );
      var query = dmvValidateQuery_(dataset, spreadsheet);
      // Reports fail instead of truncating, so a limit raised in Settings after this plan
      // was saved must apply here; the datasets' combined DMV_LIMITS.maxCells budget still holds.
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
      fetchedCells = 0,
      outputs = [],
      sources = [],
      // Each dataset's rows and columns, by dataset id.
      counts = {},
      widths = {},
      // The period each dataset holds (null without one), and its label, by dataset id.
      ranges = {},
      labels = {},
      // Datasets a connector cut to their top rows, and each dataset's own note, by id.
      tops = {},
      // Each dataset's data tab as formulas read it: name, rows, columns and date columns.
      tabs = {},
      notes = {},
      // What the page and its chart data hold, by output id, to name them in a write too large.
      parts = {},
      // Each tab the tab datasets read, read once, and how many data tabs this refresh writes.
      read = {},
      written = 0;
    plan.datasets.forEach(function (dataset, index) {
      var tabbed = dmvDashboardIsTab_(dataset);
      phase(
        (tabbed ? 'Reading' : 'Fetching') +
          ' dataset ' +
          (index + 1) +
          ' of ' +
          plan.datasets.length +
          ': ' +
          dataset.label
      );
      var result, kept;
      try {
        if (tabbed) {
          kept = dmvDashboardReadTab_(spreadsheet, dataset, dates[index], timezone, read);
          result = kept.result;
        } else result = dmvFetchReport_(queries[index], spreadsheet, deadline);
      } catch (error) {
        var reason = dmvSafeError_(error, {});
        if (tabbed) throw new Error(dataset.label + ': ' + reason);
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
      fetchedCells += result.rows.length * result.columns.length;
      counts[dataset.id] = result.rows.length;
      widths[dataset.id] = result.columns.length;
      labels[dataset.id] = dataset.label;
      if (fetchedCells > DMV_LIMITS.maxCells)
        throw new Error(
          dmvDashboardMessage_(
            'The dashboard datasets exceed ' +
              DMV_LIMITS.maxCells.toLocaleString() +
              ' cells together (',
            plan.datasets
              .slice(0, index + 1)
              .sort(function (a, b) {
                return counts[b.id] * widths[b.id] - counts[a.id] * widths[a.id];
              })
              .map(function (item) {
                return (
                  item.label +
                  ' ' +
                  counts[item.id].toLocaleString() +
                  ' rows x ' +
                  widths[item.id] +
                  ' columns'
                );
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
      if (tabbed) {
        // The user's tab is read in place: formulas point at it and nothing is written to it.
        tabs[dataset.id] = kept.tab;
        sources.push([
          dataset.label,
          'Spreadsheet tab',
          '',
          dataset.dateColumn ? 'Rows by ' + dataset.dateColumn : 'Every row',
          ranges[dataset.id] ? dmvDashboardPeriod_([ranges[dataset.id]]) : 'All dates',
          result.rows.length,
          dataset.sourceSheet,
          '',
        ]);
        return;
      }
      written++;
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
      var width = result.columns.length,
        tab = dmvDayColumns_(result);
      tabs[dataset.id] = {
        sheet: dataset.sheetName,
        rows: result.rows.length,
        columns: result.columns,
        metadata: metadata,
        dates: tab.dates,
      };
      outputs.push({
        report: {
          id: dmvDashboardOutputId_(dashboard, dataset),
          spreadsheetId: spreadsheet.getId(),
          target: { sheetName: dataset.sheetName, startCell: 'A1' },
          rewrite: true,
        },
        result: {
          columns: result.columns,
          matrix: [
            dmvDashboardPad_([dmvDashboardProvenance_(provenance.slice(0, 4))], width),
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
          ].concat(tab.matrix),
          layout: {
            tables: [{ row: 3, rows: tab.matrix.length, columns: tab.columns }],
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
        tabs: tabs,
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
    if (dmvUtf8Bytes_(JSON.stringify(page.matrix)) > DMV_LIMITS.maxBytes)
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
        'Updated ' + written + ' data tabs and ' + page.charts.length + ' charts';
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
