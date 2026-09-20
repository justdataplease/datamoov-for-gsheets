/* Chat tools. Each tool validates its input with the same rules as the sidebar, runs through the
   existing report runtime and writer, and returns a compact summary: the model sees column
   descriptors, counts, statistics and a few sample rows, never a full result set. */
var DMV_CHAT_RESULTS = {
  ttlSeconds: 3600,
  chunkChars: 90000,
  maxChars: 900000,
  sampleHead: 5,
  sampleTail: 3,
  inlineRows: 20,
  maxSummaryRows: 20000,
  readMaxRows: 500,
  maxDescribedTables: 60,
  readMaxColumns: 30,
  maxDiscoveredFields: 400,
  maxReceipts: 20,
  cellChars: 80,
};

function dmvChatResultId_() {
  return 'r' + dmvOutputDigest_(Utilities.getUuid() + ':' + Date.now()).slice(0, 8);
}

// Results stay in memory for the turn and are spilled to the user's private cache so the next
// turn can summarize, write or chart them. Nothing is written to Drive or any server.
function dmvChatStoreResult_(session, result) {
  var id = dmvChatResultId_();
  session.results[id] = result;
  // A dashboard refresh keeps its working results in memory only.
  if (session.transient) return id;
  var text = JSON.stringify({
    columns: result.columns,
    rows: result.rows,
    source: result.source,
    metadata: result.metadata,
  });
  if (text.length <= DMV_CHAT_RESULTS.maxChars) {
    try {
      var values = {},
        parts = Math.ceil(text.length / DMV_CHAT_RESULTS.chunkChars);
      for (var i = 0; i < parts; i++)
        values['dmv:chat:' + id + ':' + i] = text.slice(
          i * DMV_CHAT_RESULTS.chunkChars,
          (i + 1) * DMV_CHAT_RESULTS.chunkChars
        );
      values['dmv:chat:' + id] = String(parts);
      CacheService.getUserCache().putAll(values, DMV_CHAT_RESULTS.ttlSeconds);
    } catch (ignored) {
      /* The cache is optional; the result still works for this turn. */
    }
  }
  return id;
}

function dmvChatResult_(session, id) {
  id = String(id || '');
  if (!/^r[a-f0-9]{8}$/.test(id))
    throw new Error(
      'Unknown resultId. Use a resultId returned by run_report, combine_results, summarize or read_sheet.'
    );
  if (session.results[id]) return session.results[id];
  var cache = CacheService.getUserCache();
  var parts = Number(cache.get('dmv:chat:' + id) || 0);
  if (!parts) throw new Error('Result ' + id + ' has expired. Run the report again.');
  var keys = [];
  for (var i = 0; i < parts; i++) keys.push('dmv:chat:' + id + ':' + i);
  var chunks = cache.getAll(keys);
  if (
    keys.some(function (key) {
      return typeof chunks[key] !== 'string' || !chunks[key];
    })
  )
    throw new Error('Result ' + id + ' has expired. Run the report again.');
  var text = keys
    .map(function (key) {
      return chunks[key] || '';
    })
    .join('');
  var parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error('Result ' + id + ' has expired. Run the report again.');
  }
  session.results[id] = parsed;
  return parsed;
}

function dmvChatCell_(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  var text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return text.length > DMV_CHAT_RESULTS.cellChars
    ? text.slice(0, DMV_CHAT_RESULTS.cellChars) + '…'
    : text;
}

function dmvChatNumeric_(column) {
  return ['number', 'currency', 'percent'].indexOf(column.type) >= 0;
}

// Rates, averages and ratios must not be summed across rows.
function dmvChatAdditive_(column) {
  if (column.type === 'percent') return false;
  if (column.additive === false) return false;
  return !/(^|[._ ])(ctr|cpc|cpm|cpv|cpa|roas|rate|average|avg|ratio|position|frequency|score|share)([._ ]|$)/i.test(
    column.key + ' ' + (column.label || '')
  );
}

function dmvChatStats_(result) {
  var stats = {};
  result.columns.forEach(function (column) {
    var numeric = dmvChatNumeric_(column);
    var entry = numeric ? { min: null, max: null, nulls: 0 } : { distinct: 0, nulls: 0 };
    var sum = 0,
      seen = Object.create(null),
      distinct = 0;
    result.rows.forEach(function (row) {
      var value = row[column.key];
      if (value === null || value === undefined || value === '') {
        entry.nulls++;
        return;
      }
      if (numeric) {
        var number = Number(value);
        if (!isFinite(number)) return;
        sum += number;
        if (entry.min === null || number < entry.min) entry.min = number;
        if (entry.max === null || number > entry.max) entry.max = number;
      } else {
        var key = String(value);
        if (!seen[key] && distinct < 1000) {
          seen[key] = true;
          distinct++;
        }
        if (column.type === 'date') {
          if (entry.min === undefined || key < entry.min) entry.min = key;
          if (entry.max === undefined || key > entry.max) entry.max = key;
        }
      }
    });
    if (
      numeric &&
      dmvChatAdditive_(column) &&
      !(column.type === 'currency' && dmvChatCurrencies_(result).length > 1)
    )
      entry.sum = Math.round(sum * 10000) / 10000;
    if (!numeric) entry.distinct = distinct >= 1000 ? '1000+' : distinct;
    stats[column.key] = entry;
  });
  return stats;
}

function dmvChatSample_(result) {
  var rows = result.rows;
  var pick = function (row) {
    var out = {};
    result.columns.forEach(function (column) {
      out[column.key] = dmvChatCell_(row[column.key]);
    });
    return out;
  };
  if (rows.length <= DMV_CHAT_RESULTS.inlineRows) return { rows: rows.map(pick), complete: true };
  return {
    rows: rows
      .slice(0, DMV_CHAT_RESULTS.sampleHead)
      .concat(rows.slice(-DMV_CHAT_RESULTS.sampleTail))
      .map(pick),
    complete: false,
    note:
      'sample_rows are the FIRST ' +
      DMV_CHAT_RESULTS.sampleHead +
      ' and LAST ' +
      DMV_CHAT_RESULTS.sampleTail +
      ' rows, not the minimum and maximum. Use summarize for totals, rankings and comparisons.',
  };
}

function dmvChatDescribe_(session, result, id) {
  var sample = dmvChatSample_(result);
  var description = {
    resultId: id,
    rowCount: result.rows.length,
    columns: result.columns.map(function (column) {
      var entry = {
        key: column.key,
        label: column.label || column.key,
        type: column.type || 'text',
      };
      if (dmvChatNumeric_(column) && !dmvChatAdditive_(column)) entry.additive = false;
      return entry;
    }),
    stats: dmvChatStats_(result),
  };
  if (sample.complete) description.rows = sample.rows;
  else {
    description.sample_rows = sample.rows;
    description.note = sample.note;
  }
  if (result.metadata && Object.keys(result.metadata).length)
    description.metadata = result.metadata;
  return description;
}

function dmvChatColumn_(result, name, label) {
  var wanted = String(name || '').toLowerCase();
  var column = result.columns.filter(function (item) {
    return item.key.toLowerCase() === wanted || String(item.label || '').toLowerCase() === wanted;
  })[0];
  if (!column)
    throw new Error(
      'Unknown ' +
        (label || 'column') +
        ' "' +
        String(name).slice(0, 80) +
        '". Result columns are: ' +
        result.columns
          .map(function (item) {
            return item.key;
          })
          .join(', ')
    );
  return column;
}

/* run_report: the existing connector runtime, validated like a saved report. */
function dmvChatRunReport_(session, input) {
  input = Object.assign({}, input || {});
  var configuredRows =
    session.maxRows === undefined
      ? DMV_LIMITS.maxRows
      : dmvAiMaxRows_({ maxRows: session.maxRows });
  if (input.maxRows === undefined || input.maxRows === null || input.maxRows === '')
    input.maxRows = session.maxRows === undefined ? DMV_LIMITS.defaultRows : configuredRows;
  if (!Number.isInteger(input.maxRows) || input.maxRows < 1 || input.maxRows > configuredRows)
    throw new Error(
      'Choose a whole-number row limit between 1 and ' +
        configuredRows.toLocaleString() +
        '. Increase Maximum rows per chat report under Settings > AI provider when needed (up to 20,000).'
    );
  var query;
  try {
    query = dmvValidateQuery_(input, session.spreadsheet);
  } catch (error) {
    throw new Error(error.message + ' ' + dmvChatReportHint_(session, input));
  }
  var connection = dmvReadConnection_(query.connectionId),
    revision = dmvConnectionRevision_(connection),
    definition = dmvDefinition_(dmvConnector_(query.connectorId), query.reportType),
    dates = dmvReportDates_(definition, query, session.spreadsheet);
  // Reuse only complete identical queries within this turn. Relative date aliases share a
  // key only when they resolve to exactly the same dates; row limits are enforced separately.
  var identity = Object.assign({}, query, {
    fields: query.fields.slice().sort(),
    dateRange: dates,
    connectionRevision: revision,
  });
  delete identity.maxRows;
  var key = dmvOutputDigest_(JSON.stringify(dmvCanonical_(identity))),
    reusedId = session.reportResults && session.reportResults[key],
    reused = reusedId && session.results[reusedId];
  var result;
  try {
    if (reused) {
      if (reused.rows.length > query.maxRows)
        throw new Error('The complete report exceeds the requested row limit.');
      session.events.push({
        kind: 'report',
        text:
          'Reused ' +
          reused.source +
          ' - ' +
          reused.rows.length.toLocaleString() +
          ' rows' +
          (dates.startDate ? ' - ' + dates.startDate + ' to ' + dates.endDate : ''),
        ref: reusedId,
      });
      var description = dmvChatDescribe_(session, reused, reusedId);
      description.reused = true;
      return description;
    }
    // Freeze this fetch to the resolved window used in the identity, including at midnight.
    var fetchQuery = Object.assign({}, query);
    if (definition.dateRange) fetchQuery.dateRange = Object.assign({ preset: 'custom' }, dates);
    result = dmvFetchReport_(fetchQuery, session.spreadsheet, session.deadline);
  } catch (error) {
    var message = error.message;
    if (/row limit|too many rows|more than .*rows/i.test(message))
      message +=
        ' This fetch allows ' +
        query.maxRows.toLocaleString() +
        ' rows. Increase Maximum rows per chat report under Settings > AI provider, or narrow the report; partial data was not used.';
    if (/Unknown or unavailable report field/.test(message))
      message += ' Call discover_fields to list the fields this account supports.';
    throw new Error(message);
  }
  var stored = {
    columns: result.columns.map(function (column) {
      return {
        key: column.key,
        label: column.label || column.key,
        type: column.type || 'text',
        role: column.role,
        additive: column.additive === false ? false : undefined,
      };
    }),
    rows: result.rows,
    metadata: dmvChatMetadata_(result.metadata),
    source: dmvChatSourceLabel_(session, query),
  };
  var id = dmvChatStoreResult_(session, stored);
  if (result.metadata.complete === true) {
    try {
      // A credential/connection edit during the fetch must not seed a reusable stale entry.
      if (dmvConnectionRevision_(dmvReadConnection_(query.connectionId)) === revision) {
        if (!session.reportResults) session.reportResults = Object.create(null);
        session.reportResults[key] = id;
      }
    } catch (ignored) {
      /* Reuse is optional; a completed fetch remains available to this turn. */
    }
  }
  session.events.push({
    kind: 'report',
    text: 'Ran ' + stored.source + ' · ' + result.rows.length.toLocaleString() + ' rows',
    ref: id,
  });
  return dmvChatDescribe_(session, stored, id);
}

function dmvChatMetadata_(metadata) {
  var keep = {};
  [
    'currency',
    'currencyCode',
    'timeZone',
    'timezone',
    'note',
    'attribution',
    'grain',
    'mode',
  ].forEach(function (key) {
    if (metadata && metadata[key]) keep[key] = String(metadata[key]).slice(0, 200);
  });
  return keep;
}

function dmvChatSourceLabel_(session, query) {
  var connection = session.connections.filter(function (item) {
    return item.id === query.connectionId;
  })[0];
  var connector = session.catalog[query.connectorId];
  var report = connector
    ? connector.reports.filter(function (item) {
        return item.id === query.reportType;
      })[0]
    : null;
  return (
    (connector ? connector.label : query.connectorId) +
    (connection ? ' (' + connection.label + ')' : '') +
    (report ? ' · ' + report.label : '')
  );
}

function dmvChatReportHint_(session, input) {
  var connection = session.connections.filter(function (item) {
    return item.id === (input || {}).connectionId;
  })[0];
  if (!connection)
    return (
      'Available connectionIds: ' +
      session.connections
        .map(function (item) {
          return item.id + ' (' + item.label + ')';
        })
        .join(', ') +
      '.'
    );
  var connector = session.catalog[connection.connectorId];
  return (
    'Reports for this connection: ' +
    connector.reports
      .map(function (report) {
        return report.id;
      })
      .join(', ') +
    '. Date presets: ' +
    DMV_DATE_PRESETS.join(', ') +
    ', or custom with startDate and endDate.'
  );
}

/* discover_fields: account-specific columns (custom fields, SQL result columns). */
/* describe_database: tables and columns of the schemas/datasets the user scoped for chat. */
function dmvChatDescribeDatabase_(session, input) {
  var connection = dmvReadConnection_((input || {}).connectionId);
  var connector = dmvConnector_(connection.connectorId);
  if (typeof connector.describeTables !== 'function')
    throw new Error(
      connector.label + ' has no database to describe. Use discover_fields for its report fields.'
    );
  var search = String(input.search || '')
    .trim()
    .toLowerCase();
  var described;
  try {
    described = connector.describeTables(
      dmvContext_(
        connector,
        connection,
        { config: {}, fields: [], maxRows: 3000 },
        {},
        session.deadline
      ),
      { search: search }
    );
  } catch (error) {
    throw new Error(dmvSafeError_(error, connection.credentials));
  }
  var matched = described.tables.filter(function (table) {
    return !search || table.name.toLowerCase().indexOf(search) >= 0;
  });
  var response = {
    scope: described.scope,
    totalTables: matched.length,
    tables: matched.slice(0, DMV_CHAT_RESULTS.maxDescribedTables).map(function (table) {
      return {
        name: table.name,
        columns: table.columns.slice(0, DMV_LIMITS.maxColumns).map(function (column) {
          return column.name + ' ' + column.type;
        }),
      };
    }),
  };
  var notes = [];
  if (matched.length > DMV_CHAT_RESULTS.maxDescribedTables)
    notes.push('Only the first ' + DMV_CHAT_RESULTS.maxDescribedTables + ' tables are listed.');
  if (described.truncated)
    notes.push('The listing stopped at the column cap, so some tables are missing.');
  if (notes.length) response.note = notes.join(' ') + ' Pass search to narrow the listing.';
  session.events.push({
    kind: 'report',
    text:
      'Listed ' +
      matched.length +
      ' tables · ' +
      described.scope +
      (search ? ' · search "' + search + '"' : ''),
  });
  return response;
}
function dmvChatDiscoverFields_(session, input) {
  dmvRead_('connection', (input || {}).connectionId);
  var fields = dmvDiscoverFields({
    connectionId: input.connectionId,
    reportType: input.reportType,
    config: input.config || {},
  });
  var search = String(input.search || '')
    .trim()
    .toLowerCase();
  var matched = fields.filter(function (field) {
    return (
      !search ||
      field.key.toLowerCase().indexOf(search) >= 0 ||
      String(field.label || '')
        .toLowerCase()
        .indexOf(search) >= 0
    );
  });
  var response = {
    total: fields.length,
    matched: matched.length,
    fields: matched.slice(0, DMV_CHAT_RESULTS.maxDiscoveredFields).map(function (field) {
      var entry = { key: field.key, label: field.label || field.key, type: field.type || 'text' };
      if (field.role) entry.role = field.role;
      if (field.custom) entry.custom = true;
      return entry;
    }),
  };
  if (matched.length > DMV_CHAT_RESULTS.maxDiscoveredFields)
    response.note =
      'Only the first ' +
      DMV_CHAT_RESULTS.maxDiscoveredFields +
      ' fields are listed. Pass search to narrow them.';
  return response;
}

// Currency totals stay separate when results from different accounts are combined.
function dmvChatCurrencies_(result, rows) {
  var metadata = result.metadata || {};
  var key = metadata.currencyColumn;
  var scalar = metadata.currency || metadata.currencyCode;
  if (!key) return scalar && /^[A-Z]{3}$/.test(scalar) ? [scalar] : [];
  var seen = Object.create(null);
  (rows || result.rows).forEach(function (row) {
    if (!/^[A-Z]{3}$/.test(String(row[key] || '')))
      throw new Error(
        'This result is missing its currency context. Run the original report again.'
      );
    seen[String(row[key])] = true;
  });
  return Object.keys(seen).sort();
}

/* combine_results: append actual fetched rows with an explicit, common column mapping.
   No joins, user-supplied rows, arithmetic or provider-specific field switches. */
function dmvChatCombine_(session, input, minimum) {
  var sources = input && input.sources;
  // The chat tool appends at least two results; a dashboard tile may rename just one.
  if (!Array.isArray(sources) || sources.length < (minimum || 2) || sources.length > 20)
    throw new Error('Combine between 2 and 20 existing results.');
  var columns = [],
    rows = [],
    seenResults = Object.create(null),
    labels = Object.create(null);
  var money = false,
    shape = null;
  sources.forEach(function (item) {
    if (!item || typeof item !== 'object')
      throw new Error('Each source needs resultId, label and columns.');
    var result = dmvChatResult_(session, item.resultId);
    if (result.metadata && result.metadata.limited)
      throw new Error(
        'This result is a limited ranking. Combine the original complete reports, or summarize them with a sufficient limit first.'
      );
    if (seenResults[item.resultId]) throw new Error('Do not combine the same result twice.');
    seenResults[item.resultId] = true;
    var label = dmvText_(item.label, 'Source label', 100, true);
    if (labels[label]) throw new Error('Use a distinct source label for each account or result.');
    labels[label] = true;
    if (!Array.isArray(item.columns) || !item.columns.length || item.columns.length > 78)
      throw new Error('Map between 1 and 78 columns per source.');
    var keys = Object.create(null);
    var mapping = item.columns.map(function (mapping) {
      if (!mapping || typeof mapping !== 'object')
        throw new Error('Each mapping needs from and to.');
      var key = String(mapping.to || '');
      if (
        !/^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(key) ||
        ['source', 'constructor', 'prototype', '__proto__'].indexOf(key) >= 0 ||
        keys[key]
      )
        throw new Error('Use unique ordinary output names; source is reserved.');
      keys[key] = true;
      var column = dmvChatColumn_(result, mapping.from, 'source column');
      if (column.type === 'currency') money = true;
      return { key: key, column: column };
    });
    var currentShape = mapping
      .map(function (entry) {
        return entry.key + ':' + (entry.column.type || 'text');
      })
      .sort()
      .join('|');
    if (shape !== null && shape !== currentShape)
      throw new Error('Every source must map the same output columns with matching types.');
    if (shape === null) {
      shape = currentShape;
      columns = [{ key: 'source', label: 'Source', type: 'text', role: 'dimension' }].concat(
        mapping.map(function (entry) {
          return {
            key: entry.key,
            label: entry.key.replace(/_/g, ' '),
            type: entry.column.type || 'text',
            role: entry.column.role,
            additive: dmvChatAdditive_(entry.column) ? undefined : false,
          };
        })
      );
    } else {
      mapping.forEach(function (entry) {
        if (!dmvChatAdditive_(entry.column))
          columns.filter(function (column) {
            return column.key === entry.key;
          })[0].additive = false;
      });
    }
    if (rows.length + result.rows.length > DMV_LIMITS.maxRows)
      throw new Error('Combined results exceed 20,000 rows. Narrow each report first.');
    result.rows.forEach(function (original) {
      var row = { source: label };
      mapping.forEach(function (entry) {
        row[entry.key] =
          original[entry.column.key] === undefined ? null : original[entry.column.key];
      });
      // A mapped currency wins; otherwise use the connector's account-currency metadata.
      var sourceMetadata = result.metadata || {};
      var sourceCurrency = sourceMetadata.currencyColumn
        ? original[sourceMetadata.currencyColumn]
        : sourceMetadata.currency || sourceMetadata.currencyCode;
      if (keys.currency && sourceCurrency && row.currency !== sourceCurrency)
        throw new Error(
          'A mapped currency disagrees with the source account currency. Preserve its original currency codes.'
        );
      if (!keys.currency) row.currency = sourceCurrency || '';
      rows.push(row);
    });
  });
  if (money) {
    if (
      rows.some(function (row) {
        return !/^[A-Z]{3}$/.test(String(row.currency || ''));
      })
    )
      throw new Error(
        'Currency is required to combine money. Fetch each account currency, map it to currency, and retry.'
      );
    var currencyColumn = columns.filter(function (column) {
      return column.key === 'currency';
    })[0];
    if (currencyColumn && currencyColumn.type !== 'text')
      throw new Error('Map currency codes to a text column named currency.');
    if (!currencyColumn)
      columns.push({ key: 'currency', label: 'Currency', type: 'text', role: 'dimension' });
  } else if (
    !columns.some(function (column) {
      return column.key === 'currency';
    })
  ) {
    rows.forEach(function (row) {
      delete row.currency;
    });
  }
  var metadata = {
    complete: true,
    grain: 'Rows appended from the selected results',
    sources: sources.map(function (item) {
      return {
        label: item.label,
        metadata: dmvChatMetadata_(dmvChatResult_(session, item.resultId).metadata),
      };
    }),
  };
  if (money) metadata.currencyColumn = 'currency';
  var normalized = dmvNormalizeResult_(
    { columns: columns, rows: rows, metadata: metadata },
    DMV_LIMITS.maxRows
  );
  var stored = {
    columns: normalized.columns,
    rows: normalized.rows,
    metadata: metadata,
    source: 'Combined: ' + Object.keys(labels).join(', '),
  };
  var id = dmvChatStoreResult_(session, stored);
  session.events.push({
    kind: 'summary',
    text: 'Combined ' + sources.length + ' results into ' + rows.length.toLocaleString() + ' rows',
    ref: id,
  });
  return dmvChatDescribe_(session, stored, id);
}

/* summarize: the in-memory query planner over a fetched result. */
function dmvChatDateBucket_(value, bucket) {
  var text = String(value || '');
  var match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (!match) return text;
  if (bucket === 'year') return match[1];
  if (bucket === 'month') return match[1] + '-' + match[2];
  if (bucket === 'week') {
    var date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12));
    date = new Date(date.getTime() - ((date.getUTCDay() + 6) % 7) * 86400000);
    return date.toISOString().slice(0, 10);
  }
  return match[1] + '-' + match[2] + '-' + match[3];
}

function dmvChatCompare_(value, op, expected, numeric) {
  if (op === 'in') {
    var options = String(expected)
      .split(',')
      .map(function (item) {
        return item.trim().toLowerCase();
      });
    return (
      options.indexOf(String(value === null || value === undefined ? '' : value).toLowerCase()) >= 0
    );
  }
  if (op === 'contains')
    return (
      String(value === null || value === undefined ? '' : value)
        .toLowerCase()
        .indexOf(String(expected).toLowerCase()) >= 0
    );
  var left = numeric
    ? Number(value)
    : String(value === null || value === undefined ? '' : value).toLowerCase();
  var right = numeric ? Number(expected) : String(expected).toLowerCase();
  if (numeric && (!isFinite(left) || !isFinite(right))) return false;
  switch (op) {
    case 'eq':
      return left === right;
    case 'ne':
      return left !== right;
    case 'gt':
      return left > right;
    case 'gte':
      return left >= right;
    case 'lt':
      return left < right;
    case 'lte':
      return left <= right;
  }
  throw new Error(
    'Unsupported filter op "' + op + '". Use eq, ne, gt, gte, lt, lte, contains or in.'
  );
}

function dmvChatSummarize_(session, input) {
  input = input || {};
  var result = dmvChatResult_(session, input.resultId);
  var bucket = input.dateBucket || 'day';
  if (['day', 'week', 'month', 'year'].indexOf(bucket) < 0)
    throw new Error('dateBucket must be day, week, month or year.');
  var groupBy = (Array.isArray(input.groupBy) ? input.groupBy : []).map(function (name) {
    return dmvChatColumn_(result, name, 'groupBy column');
  });
  var metrics = (Array.isArray(input.metrics) ? input.metrics : []).map(function (metric) {
    if (!metric || typeof metric !== 'object') throw new Error('Each metric needs field and agg.');
    var column = dmvChatColumn_(result, metric.field, 'metric');
    var agg = String(metric.agg || 'sum');
    if (['sum', 'avg', 'min', 'max', 'count', 'count_distinct'].indexOf(agg) < 0)
      throw new Error(
        'Unsupported agg "' + agg + '". Use sum, avg, min, max, count or count_distinct.'
      );
    if (['sum', 'avg', 'min', 'max'].indexOf(agg) >= 0 && !dmvChatNumeric_(column))
      throw new Error('Column "' + column.key + '" is not numeric; use count or count_distinct.');
    if (agg === 'sum' && !dmvChatAdditive_(column))
      throw new Error(
        'Column "' +
          column.key +
          '" is a rate or average and cannot be summed. Use avg, min or max, or sum its underlying counts.'
      );
    return { column: column, agg: agg };
  });
  if (!groupBy.length && !metrics.length)
    throw new Error('Provide groupBy columns, metrics, or both.');
  var filters = (Array.isArray(input.filters) ? input.filters : []).map(function (filter) {
    if (!filter || typeof filter !== 'object')
      throw new Error('Each filter needs field, op and value.');
    var column = dmvChatColumn_(result, filter.field, 'filter column');
    return {
      column: column,
      op: String(filter.op || 'eq'),
      value: filter.value,
      numeric: dmvChatNumeric_(column),
    };
  });
  var rows = result.rows.filter(function (row) {
    return filters.every(function (filter) {
      return dmvChatCompare_(row[filter.column.key], filter.op, filter.value, filter.numeric);
    });
  });
  if (
    (metrics.some(function (metric) {
      return metric.column.type === 'currency';
    }) ||
      groupBy.some(function (column) {
        return column.type === 'currency';
      })) &&
    dmvChatCurrencies_(result, rows).length > 1 &&
    !groupBy.some(function (column) {
      return column.key === result.metadata.currencyColumn;
    })
  )
    throw new Error(
      'These results use different currencies. Include currency in groupBy or filter to one currency before aggregating money.'
    );
  var groups = Object.create(null),
    order = [];
  rows.forEach(function (row) {
    var keys = groupBy.map(function (column) {
      var value = row[column.key];
      return column.type === 'date'
        ? dmvChatDateBucket_(value, bucket)
        : value === undefined
          ? null
          : value;
    });
    var id = JSON.stringify(keys);
    var group = groups[id];
    if (!group) {
      group = groups[id] = {
        keys: keys,
        count: 0,
        values: metrics.map(function () {
          return {
            sum: 0,
            n: 0,
            min: null,
            max: null,
            distinct: Object.create(null),
            distinctCount: 0,
          };
        }),
      };
      order.push(id);
      if (order.length > 20000)
        throw new Error('Too many groups. Add filters or fewer groupBy columns.');
    }
    group.count++;
    metrics.forEach(function (metric, index) {
      var value = row[metric.column.key];
      if (value === null || value === undefined || value === '') return;
      var slot = group.values[index];
      if (metric.agg === 'count_distinct') {
        var text = String(value);
        if (!slot.distinct[text]) {
          slot.distinct[text] = true;
          slot.distinctCount++;
        }
        return;
      }
      if (metric.agg === 'count') {
        slot.n++;
        return;
      }
      var number = Number(value);
      if (!isFinite(number)) return;
      slot.sum += number;
      slot.n++;
      if (slot.min === null || number < slot.min) slot.min = number;
      if (slot.max === null || number > slot.max) slot.max = number;
    });
  });
  var columns = groupBy.map(function (column) {
    return {
      key: column.key,
      label: column.label || column.key,
      type: column.type === 'date' && bucket !== 'day' ? 'text' : column.type,
      role: 'dimension',
      additive: column.additive === false ? false : undefined,
    };
  });
  metrics.forEach(function (metric) {
    var label = metric.column.label || metric.column.key;
    columns.push({
      key: metric.column.key + '__' + metric.agg,
      label:
        metric.agg === 'sum'
          ? label
          : {
              avg: 'Avg ',
              min: 'Min ',
              max: 'Max ',
              count: 'Count of ',
              count_distinct: 'Distinct ',
            }[metric.agg] + label,
      type:
        metric.agg === 'count' || metric.agg === 'count_distinct' ? 'number' : metric.column.type,
      role: 'metric',
      additive:
        ['avg', 'min', 'max', 'count_distinct'].indexOf(metric.agg) >= 0 ? false : undefined,
    });
  });
  var output = order.map(function (id) {
    var group = groups[id],
      row = {};
    groupBy.forEach(function (column, index) {
      row[column.key] = group.keys[index];
    });
    metrics.forEach(function (metric, index) {
      var slot = group.values[index],
        value;
      if (metric.agg === 'sum') value = slot.n ? Math.round(slot.sum * 10000) / 10000 : null;
      else if (metric.agg === 'avg')
        value = slot.n ? Math.round((slot.sum / slot.n) * 10000) / 10000 : null;
      else if (metric.agg === 'min') value = slot.min;
      else if (metric.agg === 'max') value = slot.max;
      else if (metric.agg === 'count') value = slot.n;
      else value = slot.distinctCount;
      row[metric.column.key + '__' + metric.agg] = value;
    });
    return row;
  });
  var orderBy = input.orderBy && typeof input.orderBy === 'object' ? input.orderBy : null;
  var sortColumn = orderBy
    ? dmvChatColumn_({ columns: columns }, orderBy.field, 'orderBy column')
    : columns[groupBy.length] || columns[0];
  var direction =
    orderBy && String(orderBy.direction || '').toLowerCase() === 'asc'
      ? 1
      : orderBy
        ? -1
        : columns[groupBy.length]
          ? -1
          : 1;
  output.sort(function (a, b) {
    var left = a[sortColumn.key],
      right = b[sortColumn.key];
    if (left === right) return 0;
    if (left === null || left === undefined) return 1;
    if (right === null || right === undefined) return -1;
    return (left < right ? -1 : 1) * direction;
  });
  var limit = dmvInteger_(
    input.limit === undefined ? 50 : input.limit,
    1,
    DMV_CHAT_RESULTS.maxSummaryRows,
    'limit'
  );
  var totalGroups = output.length;
  var ranking = null;
  if (input.rankWithin !== undefined || input.limitPerGroup !== undefined) {
    if (
      !Array.isArray(input.rankWithin) ||
      !input.rankWithin.length ||
      input.limitPerGroup === undefined
    )
      throw new Error(
        'Use rankWithin groupBy columns and limitPerGroup together to rank separately within each group.'
      );
    var rankWithin = input.rankWithin.map(function (key) {
      if (
        typeof key !== 'string' ||
        !groupBy.some(function (column) {
          return column.key === key;
        })
      )
        throw new Error('Every rankWithin column must also be in groupBy.');
      return key;
    });
    if (
      rankWithin.some(function (key, index) {
        return rankWithin.indexOf(key) !== index;
      })
    )
      throw new Error('Choose distinct rankWithin columns.');
    var perGroup = dmvInteger_(
      input.limitPerGroup,
      1,
      DMV_CHAT_RESULTS.maxSummaryRows,
      'limitPerGroup'
    );
    if (!orderBy || !dmvChatNumeric_(sortColumn))
      throw new Error(
        'Ranking within groups needs an explicit numeric orderBy metric, such as spend__sum descending.'
      );
    if (
      sortColumn.type === 'currency' &&
      dmvChatCurrencies_(result, rows).length > 1 &&
      rankWithin.indexOf((result.metadata || {}).currencyColumn) < 0
    )
      throw new Error(
        'Include currency in rankWithin or filter to one currency before ranking money.'
      );
    var partitions = Object.create(null);
    output = output.filter(function (row) {
      var key = JSON.stringify(
        rankWithin.map(function (column) {
          return row[column];
        })
      );
      partitions[key] = (partitions[key] || 0) + 1;
      return partitions[key] <= perGroup;
    });
    ranking = {
      within: rankWithin,
      limitPerGroup: perGroup,
      orderBy: { field: sortColumn.key, direction: direction === 1 ? 'asc' : 'desc' },
      totalGroups: totalGroups,
      selectedGroups: output.length,
    };
  }
  var rankedGroups = output.length;
  var truncated = rankedGroups > limit;
  output = output.slice(0, limit);
  var summaryMetadata = Object.assign({}, result.metadata || {});
  if (ranking) {
    summaryMetadata.ranking = ranking;
    summaryMetadata.limited = true;
    summaryMetadata.totalGroups = totalGroups;
    summaryMetadata.keptGroups = output.length;
    summaryMetadata.note =
      'This is a ranking of up to ' +
      ranking.limitPerGroup +
      ' rows within each ' +
      ranking.within.join(', ') +
      ' group, not the complete report. Ties keep the original group order.';
  }
  if (
    summaryMetadata.currencyColumn &&
    !columns.some(function (column) {
      return column.key === summaryMetadata.currencyColumn;
    })
  ) {
    var currencies = dmvChatCurrencies_(result, rows);
    delete summaryMetadata.currencyColumn;
    delete summaryMetadata.currency;
    delete summaryMetadata.currencyCode;
    if (currencies.length === 1) summaryMetadata.currency = currencies[0];
  }
  if (truncated) {
    summaryMetadata.limited = true;
    summaryMetadata.totalGroups = totalGroups;
    summaryMetadata.rankedGroups = rankedGroups;
    summaryMetadata.keptGroups = output.length;
    summaryMetadata.note = ranking
      ? 'The overall limit omitted some ranked rows or groups. Raise limit to include every group; this is not a complete per-group ranking.'
      : 'This is a limited ranking, not the complete report.';
  }
  var stored = {
    columns: columns,
    rows: output,
    metadata: summaryMetadata,
    source: 'Summary of ' + (result.source || input.resultId),
  };
  var id = dmvChatStoreResult_(session, stored);
  session.events.push({
    kind: 'summary',
    text:
      'Summarized ' + rows.length.toLocaleString() + ' rows into ' + output.length.toLocaleString(),
    ref: id,
  });
  var description = dmvChatDescribe_(session, stored, id);
  description.inputRows = rows.length;
  if (ranking) description.ranking = ranking;
  if (truncated)
    description.note =
      'Only the first ' +
      limit +
      ' groups are kept; raise limit (max ' +
      DMV_CHAT_RESULTS.maxSummaryRows +
      ') or add filters.';
  return description;
}

/* write_to_sheet: the same protected atomic writer as saved reports. */
function dmvChatWriteSheet_(session, input) {
  input = input || {};
  var result = dmvChatResult_(session, input.resultId);
  var sheetName = dmvSheetName_(input.sheetName);
  var cell = dmvCell_(input.startCell || 'A1');
  var normalized = dmvNormalizeResult_(
    { columns: result.columns, rows: result.rows, metadata: { complete: true } },
    DMV_LIMITS.maxRows
  );
  var report = {
    id: 'chat-' + dmvOutputDigest_(sheetName + '!' + cell.a1).slice(0, 16),
    spreadsheetId: session.spreadsheetId,
    target: { sheetName: sheetName, startCell: cell.a1 },
  };
  var sheetUpdated = false;
  try {
    dmvLocked_(function () {
      dmvWorkbookLocked_(function () {
        if (session.spreadsheet.getSheetByName(sheetName)) dmvChatSheetTarget_(session, sheetName);
        dmvWriteReport_(session.spreadsheet, report, normalized);
        sheetUpdated = true;
      });
      dmvChatPruneReceipts_(session.spreadsheetId);
    });
  } catch (error) {
    if (sheetUpdated || error.sheetUpdated) {
      error.sheetUpdated = true;
      var committedUrl = dmvSheetLink_(dmvChatSeeNewTabs_(session), report.target);
      session.events.push({
        kind: 'write',
        text: 'Updated ' + sheetName + '. ' + error.message,
        links: committedUrl ? [{ label: sheetName, url: committedUrl }] : [],
      });
    }
    throw error;
  }
  var sheet = dmvChatSeeNewTabs_(session).getSheetByName(sheetName);
  var area = {
    sheetName: sheetName,
    sheetId: sheet.getSheetId(),
    row: cell.row,
    column: cell.column,
    rows: normalized.matrix.length,
    columns: result.columns,
  };
  session.written[input.resultId] = area;
  var range =
    sheetName +
    '!' +
    cell.a1 +
    ':' +
    dmvChatA1_(cell.row + area.rows - 1, cell.column + result.columns.length - 1);
  var url = dmvSheetUrl_(session.spreadsheet, sheet.getSheetId(), cell.a1);
  session.events.push({
    kind: 'write',
    links: [{ label: sheetName, url: url }],
    text: 'Wrote ' + result.rows.length.toLocaleString() + ' rows to ' + range,
    ref: input.resultId + ' at ' + range,
  });
  if (session.sheetNames.indexOf(sheetName) < 0) session.sheetNames.push(sheetName);
  return {
    ok: true,
    range: range,
    url: url,
    rows: result.rows.length,
    columns: result.columns.map(function (column) {
      return column.label || column.key;
    }),
  };
}

function dmvChatA1_(row, column) {
  var label = '';
  while (column > 0) {
    var remainder = (column - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    column = (column - 1 - remainder) / 26;
  }
  return label + row;
}

// Chat receipts protect the areas the chat wrote; keep only the most recent ones per user.
function dmvChatPruneReceipts_(spreadsheetId) {
  var store = dmvStore_();
  var prefix = dmvOutputKey_(spreadsheetId, 'chat-');
  var all = store.getProperties();
  var receipts = Object.keys(all)
    .filter(function (key) {
      return key.indexOf(prefix) === 0;
    })
    .map(function (key) {
      return { key: key, writtenAt: (JSON.parse(all[key]) || {}).writtenAt || 0 };
    })
    .sort(function (a, b) {
      return b.writtenAt - a.writtenAt;
    });
  receipts.slice(DMV_CHAT_RESULTS.maxReceipts).forEach(function (receipt) {
    store.deleteProperty(receipt.key);
  });
}

/* read_sheet: the user's own tab as a result, so it can be summarized, written or charted. */
function dmvChatReadSheet_(session, input) {
  input = input || {};
  var sheetName = dmvSheetName_(input.sheetName);
  var sheet = dmvChatSheetTarget_(session, sheetName);
  var range;
  if (input.range) {
    var match = /^([A-Z]{1,3})([1-9][0-9]{0,6}):([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(
      String(input.range).toUpperCase()
    );
    if (!match) throw new Error('range must look like A1:F200.');
    var start = dmvCell_(match[1] + match[2]),
      end = dmvCell_(match[3] + match[4]);
    if (end.row < start.row || end.column < start.column)
      throw new Error('range must end after it starts.');
    range = sheet.getRange(
      start.row,
      start.column,
      end.row - start.row + 1,
      end.column - start.column + 1
    );
  } else range = sheet.getDataRange();
  var rows = range.getNumRows(),
    columns = range.getNumColumns();
  if (rows > DMV_CHAT_RESULTS.readMaxRows + 1 || columns > DMV_CHAT_RESULTS.readMaxColumns)
    throw new Error(
      'Tab "' +
        sheetName +
        '" has ' +
        rows +
        ' rows × ' +
        columns +
        ' columns. Pass a range of at most ' +
        DMV_CHAT_RESULTS.readMaxRows +
        ' rows × ' +
        DMV_CHAT_RESULTS.readMaxColumns +
        ' columns (header included).'
    );
  var values = range.getValues();
  if (values.length < 2) throw new Error('The range needs a header row and at least one data row.');
  var seen = Object.create(null);
  var descriptors = values[0].map(function (header, index) {
    var label = String(header === '' ? 'Column ' + (index + 1) : header)
      .trim()
      .slice(0, 100);
    var key =
      label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'column_' + (index + 1);
    while (seen[key]) key += '_';
    seen[key] = true;
    return { key: key, label: label, index: index, numbers: 0, dates: 0, texts: 0 };
  });
  var data = values.slice(1).map(function (line) {
    var row = {};
    descriptors.forEach(function (column) {
      var value = line[column.index];
      if (value === '' || value === null || value === undefined) {
        row[column.key] = null;
        return;
      }
      if (value instanceof Date) {
        column.dates++;
        row[column.key] = Utilities.formatDate(value, session.timezone, 'yyyy-MM-dd');
        return;
      }
      if (typeof value === 'number') column.numbers++;
      else column.texts++;
      // Cell text is kept whole; only the samples sent to the model are shortened.
      row[column.key] =
        typeof value === 'number' || typeof value === 'boolean' ? value : String(value);
    });
    return row;
  });
  var stored = {
    columns: descriptors.map(function (column) {
      var type =
        column.numbers && !column.texts && !column.dates
          ? 'number'
          : column.dates && !column.texts && !column.numbers
            ? 'date'
            : 'text';
      return {
        key: column.key,
        label: column.label,
        type: type,
        role: type === 'number' ? 'metric' : 'dimension',
      };
    }),
    rows: data,
    metadata: {},
    source: 'Tab ' + sheetName,
  };
  var id = dmvChatStoreResult_(session, stored);
  session.events.push({
    kind: 'read',
    text: 'Read ' + data.length.toLocaleString() + ' rows from ' + sheetName,
    ref: id,
  });
  return dmvChatDescribe_(session, stored, id);
}

/* create_chart: a native Sheets chart over a table already in the spreadsheet. */
var DMV_CHART_TYPES = {
  line: 'LINE',
  column: 'COLUMN',
  bar: 'BAR',
  area: 'AREA',
  scatter: 'SCATTER',
  pie: 'PIE',
};

function dmvChatCreateChart_(session, input) {
  input = input || {};
  if (input.includeFutureRows !== undefined && typeof input.includeFutureRows !== 'boolean')
    throw new Error('includeFutureRows must be true or false.');
  var type = DMV_CHART_TYPES[String(input.chartType || '').toLowerCase()];
  if (!type)
    throw new Error('chartType must be one of: ' + Object.keys(DMV_CHART_TYPES).join(', '));
  var area = input.resultId ? session.written[input.resultId] : null;
  if (!area) {
    var sheetName = dmvSheetName_(input.sheetName);
    var sheet = dmvChatSheetTarget_(session, sheetName);
    var match = /^([A-Z]{1,3})([1-9][0-9]{0,6}):([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(
      String(input.range || '').toUpperCase()
    );
    if (!match)
      throw new Error(
        'Pass the resultId of a table written by write_to_sheet, or sheetName plus range (A1:F31, header row included).'
      );
    var start = dmvCell_(match[1] + match[2]),
      end = dmvCell_(match[3] + match[4]);
    if (end.row <= start.row || end.column < start.column)
      throw new Error('range must cover a header row and at least one data row.');
    var headers = sheet
      .getRange(start.row, start.column, 1, end.column - start.column + 1)
      .getValues()[0];
    area = {
      sheetName: sheetName,
      sheetId: sheet.getSheetId(),
      row: start.row,
      column: start.column,
      rows: end.row - start.row + 1,
      columns: headers.map(function (header, index) {
        var label = String(header || 'Column ' + (index + 1));
        return { key: label, label: label };
      }),
    };
  }
  var table = { columns: area.columns };
  var x = dmvChatColumn_(table, input.xColumn, 'xColumn');
  var seriesNames = Array.isArray(input.seriesColumns) ? input.seriesColumns : [];
  if (!seriesNames.length || seriesNames.length > 10)
    throw new Error('Pass between 1 and 10 seriesColumns.');
  var series = seriesNames.map(function (name) {
    var column = dmvChatColumn_(table, name, 'series column');
    if (column.key === x.key) throw new Error('A series column cannot be the xColumn.');
    return column;
  });
  if (type === 'PIE' && series.length !== 1)
    throw new Error('A pie chart takes exactly one series column.');
  var offset = function (column) {
    return area.columns.indexOf(column);
  };
  var gridRange = function (column, skipHeader) {
    var range = {
      sheetId: area.sheetId,
      startRowIndex: area.row - 1 + (skipHeader ? 1 : 0),
      startColumnIndex: area.column - 1 + offset(column),
      endColumnIndex: area.column + offset(column),
    };
    if (!input.includeFutureRows) range.endRowIndex = area.row - 1 + area.rows;
    return range;
  };
  var title = dmvText_(
    input.title ||
      series
        .map(function (column) {
          return column.label;
        })
        .join(', ') +
        ' by ' +
        x.label,
    'Chart title',
    120,
    false
  );
  var spec = { title: title };
  if (type === 'PIE')
    spec.pieChart = {
      legendPosition: 'RIGHT_LEGEND',
      domain: { sourceRange: { sources: [gridRange(x, true)] } },
      series: { sourceRange: { sources: [gridRange(series[0], true)] } },
    };
  else
    spec.basicChart = {
      chartType: type,
      legendPosition: 'BOTTOM_LEGEND',
      headerCount: 1,
      // Sheets draws a bar chart sideways: values run along the bottom axis, categories up the
      // left one, and it rejects bar series on any other axis.
      axis: [
        { position: type === 'BAR' ? 'LEFT_AXIS' : 'BOTTOM_AXIS', title: x.label },
        {
          position: type === 'BAR' ? 'BOTTOM_AXIS' : 'LEFT_AXIS',
          title: series.length === 1 ? series[0].label : '',
        },
      ],
      domains: [{ domain: { sourceRange: { sources: [gridRange(x, false)] } } }],
      series: series.map(function (column) {
        return {
          series: { sourceRange: { sources: [gridRange(column, false)] } },
          targetAxis: type === 'BAR' ? 'BOTTOM_AXIS' : 'LEFT_AXIS',
        };
      }),
    };
  var anchor = input.anchorCell
    ? dmvCell_(input.anchorCell)
    : { row: area.row, column: area.column + area.columns.length + 1 };
  var response = dmvWorkbookLocked_(function () {
    var currentSheet = dmvChatSheetTarget_(session, area.sheetName);
    if (currentSheet.getSheetId() !== area.sheetId)
      throw new Error(
        'The chart source tab changed. Read or write the table again before charting.'
      );
    return Sheets.Spreadsheets.batchUpdate(
      {
        requests: [
          {
            addChart: {
              chart: {
                spec: spec,
                position: {
                  overlayPosition: {
                    anchorCell: {
                      sheetId: area.sheetId,
                      rowIndex: anchor.row - 1,
                      columnIndex: anchor.column - 1,
                    },
                    widthPixels: 600,
                    heightPixels: 360,
                  },
                },
              },
            },
          },
        ],
      },
      session.spreadsheetId
    );
  });
  var reply = response && response.replies && response.replies[0] && response.replies[0].addChart;
  var url = dmvSheetUrl_(session.spreadsheet, area.sheetId, dmvChatA1_(anchor.row, anchor.column));
  session.events.push({
    kind: 'chart',
    links: [{ label: area.sheetName, url: url }],
    text:
      'Added a ' +
      String(input.chartType).toLowerCase() +
      ' chart "' +
      title +
      '" on ' +
      area.sheetName,
  });
  return {
    ok: true,
    chartId: reply && reply.chart ? reply.chart.chartId : null,
    url: url,
    sheetName: area.sheetName,
    anchorCell: dmvChatA1_(anchor.row, anchor.column),
    title: title,
  };
}

/* ask_user: terminal for the turn; the sidebar renders the options as chips. */
function dmvChatAskUser_(session, input) {
  input = input || {};
  var question = dmvText_(input.question, 'question', 500, true);
  var options = (Array.isArray(input.options) ? input.options : [])
    .slice(0, 6)
    .map(function (option) {
      return dmvText_(option, 'option', 80, true);
    });
  session.question = { question: question, options: options };
  return {
    asked: true,
    note: 'Wait for the user to answer. Other tool calls in this round were skipped.',
  };
}
