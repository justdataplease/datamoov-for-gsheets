/* Reproducible multi-source dashboards stay private to their owner and workbook. */
function dmvDashboardObject_(value, keys) {
  if (
    !value ||
    Object.prototype.toString.call(value) !== '[object Object]' ||
    Object.keys(value).some(function (key) {
      return keys.indexOf(key) < 0;
    })
  )
    throw new Error('Use only the documented dashboard settings.');
  return value;
}

function dmvDashboardInteger_(value, minimum, maximum, label) {
  if (typeof value !== 'number' || !Number.isInteger(value))
    throw new Error(label + ' must be a whole number.');
  return dmvInteger_(value, minimum, maximum, label);
}

function dmvDashboardTarget_(target, spreadsheet) {
  dmvDashboardObject_(target, ['sheetName', 'startCell']);
  var name = dmvSheetName_(target.sheetName),
    sheet = spreadsheet.getSheetByName(name);
  if (sheet && sheet.getRange(1, 1).getValues()[0][0] === DMV_REPORT_SHEET_MARKER)
    throw new Error('Report settings cannot be used as dashboard output.');
  return { sheetName: name, startCell: dmvCell_(target.startCell || 'A1').a1 };
}

function dmvValidateDashboard_(input, spreadsheet) {
  dmvDashboardObject_(input, [
    'id',
    'revision',
    'name',
    'sources',
    'summary',
    'dataTarget',
    'target',
  ]);
  if (JSON.stringify(input).length > 250000)
    throw new Error('The dashboard configuration is too large.');
  if (!Array.isArray(input.sources) || input.sources.length < 2 || input.sources.length > 8)
    throw new Error('Choose between two and eight dashboard sources.');
  var ids = Object.create(null),
    labels = Object.create(null),
    queries = Object.create(null),
    shape;
  var sources = input.sources.map(function (source, index) {
    dmvDashboardObject_(source, [
      'id',
      'label',
      'connectorId',
      'connectionId',
      'reportType',
      'fields',
      'config',
      'dateRange',
      'maxRows',
      'mapping',
    ]);
    var query = dmvValidateQuery_(source, spreadsheet);
    query.maxRows = dmvDashboardInteger_(
      source.maxRows === undefined ? DMV_LIMITS.defaultRows : source.maxRows,
      1,
      DMV_LIMITS.maxRows,
      'Source row limit'
    );
    var id = source.id === undefined ? 'source' + (index + 1) : source.id;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(id) || ids[id])
      throw new Error('Use distinct ordinary source IDs.');
    ids[id] = true;
    var label = dmvText_(source.label, 'Source label', 80, true);
    if (labels[label]) throw new Error('Use distinct dashboard source labels.');
    labels[label] = true;
    var identityQuery = Object.assign({}, query, { fields: query.fields.slice().sort() });
    delete identityQuery.maxRows;
    var identity = JSON.stringify(dmvCanonical_(identityQuery));
    if (queries[identity])
      throw new Error('Do not include the same source query twice in a dashboard.');
    queries[identity] = true;
    if (!Array.isArray(source.mapping) || !source.mapping.length || source.mapping.length > 78)
      throw new Error('Map between one and 78 source columns.');
    var keys = Object.create(null);
    var mapping = source.mapping.map(function (entry) {
      dmvDashboardObject_(entry, ['field', 'key']);
      if (
        typeof entry.field !== 'string' ||
        !entry.field ||
        entry.field.length > 150 ||
        (query.fields.length && query.fields.indexOf(entry.field) < 0)
      )
        throw new Error('Map selected source fields only.');
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
    var currentShape = Object.keys(keys).sort().join('|');
    if (shape !== undefined && shape !== currentShape)
      throw new Error('Every dashboard source must map the same output columns.');
    shape = currentShape;
    return Object.assign({}, query, { id: id, label: label, mapping: mapping });
  });
  var columns = sources[0].mapping
    .map(function (entry) {
      return entry.key;
    })
    .concat(['source', 'currency']);
  var summary = input.summary;
  dmvDashboardObject_(summary, [
    'groupBy',
    'dateBucket',
    'metrics',
    'orderBy',
    'rankWithin',
    'limitPerGroup',
    'limit',
  ]);
  function names(values, allowed, label) {
    if (
      !Array.isArray(values) ||
      values.length > 78 ||
      values.some(function (key, index) {
        return typeof key !== 'string' || allowed.indexOf(key) < 0 || values.indexOf(key) !== index;
      })
    )
      throw new Error('Choose distinct valid ' + label + ' columns.');
    return values.slice();
  }
  var groupBy = names(summary.groupBy || [], columns, 'grouping');
  if (!Array.isArray(summary.metrics) || summary.metrics.length > 78)
    throw new Error('Choose valid dashboard metrics.');
  var metricKeys = Object.create(null);
  var metrics = summary.metrics.map(function (metric) {
    dmvDashboardObject_(metric, ['field', 'agg']);
    if (
      columns.indexOf(metric.field) < 0 ||
      ['sum', 'avg', 'min', 'max', 'count', 'count_distinct'].indexOf(metric.agg) < 0
    )
      throw new Error('Choose a mapped field and supported metric aggregation.');
    var key = metric.field + '__' + metric.agg;
    if (metricKeys[key] || groupBy.indexOf(key) >= 0)
      throw new Error('Choose distinct dashboard metrics.');
    metricKeys[key] = true;
    return { field: metric.field, agg: metric.agg };
  });
  if (!groupBy.length && !metrics.length)
    throw new Error('Choose grouping columns or metrics for the dashboard report.');
  if (groupBy.length + metrics.length > DMV_LIMITS.maxColumns)
    throw new Error('Choose at most 80 report columns.');
  var bucket = summary.dateBucket || 'day';
  if (['day', 'week', 'month', 'year'].indexOf(bucket) < 0)
    throw new Error('Choose day, week, month or year date grouping.');
  var validatedSummary = {
    groupBy: groupBy,
    metrics: metrics,
    dateBucket: bucket,
    limit: dmvDashboardInteger_(
      summary.limit === undefined ? DMV_LIMITS.maxRows : summary.limit,
      1,
      DMV_LIMITS.maxRows,
      'Summary row limit'
    ),
  };
  if (summary.orderBy !== undefined) {
    dmvDashboardObject_(summary.orderBy, ['field', 'direction']);
    if (
      groupBy.concat(Object.keys(metricKeys)).indexOf(summary.orderBy.field) < 0 ||
      ['asc', 'desc'].indexOf(summary.orderBy.direction) < 0
    )
      throw new Error('Choose a valid summary sort column and direction.');
    validatedSummary.orderBy = {
      field: summary.orderBy.field,
      direction: summary.orderBy.direction,
    };
  }
  if (summary.rankWithin !== undefined || summary.limitPerGroup !== undefined) {
    var rankWithin = names(summary.rankWithin, groupBy, 'ranking');
    if (!rankWithin.length || !validatedSummary.orderBy)
      throw new Error('Per-group rankings need grouping columns and an explicit sort metric.');
    validatedSummary.rankWithin = rankWithin;
    validatedSummary.limitPerGroup = dmvDashboardInteger_(
      summary.limitPerGroup,
      1,
      DMV_LIMITS.maxRows,
      'Per-group row limit'
    );
  }
  var dataTarget = dmvDashboardTarget_(input.dataTarget, spreadsheet),
    target = dmvDashboardTarget_(input.target, spreadsheet);
  if (dataTarget.sheetName === target.sheetName)
    throw new Error('Choose different tabs for combined data and the dashboard report.');
  return {
    name: dmvText_(input.name, 'Dashboard name', 80, true),
    sources: sources,
    summary: validatedSummary,
    dataTarget: dataTarget,
    target: target,
  };
}

function dmvDashboardSummary_(dashboard) {
  var expired = dashboard.status === 'running' && Date.now() - dashboard.startedAt >= 300000;
  return {
    id: dashboard.id,
    revision: dashboard.revision,
    name: dashboard.name,
    sourceCount: dashboard.sources.length,
    sourceLabels: dashboard.sources.map(function (source) {
      return source.label;
    }),
    dataTarget: dashboard.dataTarget,
    target: dashboard.target,
    status: expired ? 'error' : dashboard.status,
    statusMessage: expired
      ? 'The previous refresh was interrupted. Refresh again to retry all sources.'
      : dashboard.statusMessage || '',
    lastRun: dashboard.lastRun || null,
    lastRowCount: dashboard.lastRowCount === undefined ? null : dashboard.lastRowCount,
    lastDataRowCount: dashboard.lastDataRowCount === undefined ? null : dashboard.lastDataRowCount,
    lastError: dashboard.lastError || '',
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
  var id = dmvSpreadsheet_().getId();
  return dmvList_('dashboard')
    .filter(function (dashboard) {
      return dashboard.spreadsheetId === id;
    })
    .map(dmvDashboardSummary_);
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
    var dashboard = Object.assign(dmvValidateDashboard_(input, spreadsheet), {
      id: previous ? previous.id : dmvId_(),
      spreadsheetId: spreadsheet.getId(),
      revision: previous ? previous.revision + 1 : 1,
      status: 'ready',
      statusMessage: 'Ready to refresh all sources',
      lastError: '',
      runToken: null,
    });
    ['lastRun', 'lastRowCount', 'lastDataRowCount'].forEach(function (key) {
      if (previous && previous[key] !== undefined) dashboard[key] = previous[key];
    });
    // Reserve record room for execution metadata so a valid plan can always record its outcome.
    dmvCheckRecordSize_(
      Object.assign({}, dashboard, {
        statusMessage: 'x'.repeat(520),
        lastError: 'x'.repeat(1600),
        runToken: 'x'.repeat(80),
        startedAt: Date.now(),
        lastRun: new Date().toISOString(),
        lastRowCount: 20000,
        lastDataRowCount: 20000,
      })
    );
    dmvSave_('dashboard', dashboard);
    return dmvDashboardSummary_(dashboard);
  });
}

function dmvDeleteDashboard(id) {
  return dmvLocked_(function () {
    var dashboard = dmvDashboardHere_(id);
    if (dashboard.runToken && Date.now() - dashboard.startedAt < 300000)
      throw new Error('Wait for this dashboard refresh to finish.');
    dmvStore_().deleteProperty(dmvKey_('dashboard', dashboard.id));
    return { ok: true };
  });
}

function dmvDashboardDeadline_(deadline) {
  if (Date.now() > deadline - 10000)
    throw new Error(
      'This dashboard reached its refresh time limit. Narrow its source reports and try again.'
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
    revisions = {};
  dmvDashboardDeadline_(deadline);
  var dashboard = dmvLocked_(function () {
    var current = dmvDashboardHere_(id);
    if (current.runToken && Date.now() - current.startedAt < 300000)
      throw new Error('This dashboard is already refreshing.');
    var plan = dmvValidateDashboard_(
      {
        name: current.name,
        sources: current.sources,
        summary: current.summary,
        dataTarget: current.dataTarget,
        target: current.target,
      },
      spreadsheet
    );
    plan.sources.forEach(function (source) {
      revisions[source.connectionId] = dmvConnectionRevision_(
        dmvReadConnection_(source.connectionId)
      );
    });
    current.status = 'running';
    current.statusMessage = 'Preparing source reports';
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
    var fetchedRows = 0;
    var combinedSources = dashboard.sources.map(function (source, index) {
      phase(
        'Fetching source ' + (index + 1) + ' of ' + dashboard.sources.length + ': ' + source.label
      );
      var query = dmvValidateQuery_(source, spreadsheet);
      var result = dmvFetchReport_(query, spreadsheet, deadline);
      dmvDashboardDeadline_(deadline);
      fetchedRows += result.rows.length;
      if (fetchedRows > DMV_LIMITS.maxRows)
        throw new Error('Combined dashboard data exceeds 20,000 rows. Narrow its source reports.');
      var resultId = dmvChatResultId_();
      session.results[resultId] = result;
      return {
        resultId: resultId,
        label: source.label,
        columns: source.mapping.map(function (entry) {
          return { from: entry.field, to: entry.key };
        }),
      };
    });
    phase('Combining source data');
    var combined = dmvChatCombine_(session, { sources: combinedSources });
    var raw = dmvChatResult_(session, combined.resultId);
    phase('Building the dashboard report');
    var summarized = dmvChatSummarize_(
      session,
      Object.assign({}, dashboard.summary, { resultId: combined.resultId })
    );
    var summary = dmvChatResult_(session, summarized.resultId);
    if (
      summary.metadata &&
      (summary.metadata.rankedGroups > summary.rows.length ||
        (!summary.metadata.ranking && summary.metadata.totalGroups > summary.rows.length))
    )
      throw new Error(
        'The summary row limit omitted groups. Increase its limit before refreshing the dashboard.'
      );
    var outputs = [
      {
        report: {
          id: dashboard.id + '-data',
          spreadsheetId: spreadsheet.getId(),
          target: dashboard.dataTarget,
        },
        result: dmvNormalizeResult_(raw, DMV_LIMITS.maxRows),
      },
      {
        report: {
          id: dashboard.id + '-report',
          spreadsheetId: spreadsheet.getId(),
          target: dashboard.target,
        },
        result: dmvNormalizeResult_(summary, DMV_LIMITS.maxRows),
      },
    ];
    phase('Updating both dashboard tabs');
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
      dmvWriteReports_(spreadsheet, outputs, check);
      sheetUpdated = true;
      current.status = 'success';
      current.statusMessage = 'Updated both tabs from all ' + dashboard.sources.length + ' sources';
      current.lastRun = new Date().toISOString();
      current.lastRowCount = summary.rows.length;
      current.lastDataRowCount = raw.rows.length;
      current.lastError = '';
      current.runToken = null;
      dmvSave_('dashboard', current);
      return {
        ok: true,
        id: id,
        rowCount: summary.rows.length,
        dataRowCount: raw.rows.length,
        sourceCount: dashboard.sources.length,
        updatedAt: current.lastRun,
        target: current.target,
        dataTarget: current.dataTarget,
        dataRange: dmvDashboardRange_(current.dataTarget, outputs[0].result),
        reportRange: dmvDashboardRange_(current.target, outputs[1].result),
        dataColumns: raw.columns,
        columns: summary.columns,
      };
    });
  } catch (error) {
    sheetUpdated = sheetUpdated || !!error.sheetUpdated;
    var message = sheetUpdated
      ? error.sheetUpdated
        ? dmvSafeError_(error, {})
        : 'The output tabs were updated, but dashboard completion could not be saved. Refresh again to retry safely.'
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
      failure.sheetUpdated = true;
      failure.id = dashboard.id;
      failure.target = dashboard.target;
      failure.dataTarget = dashboard.dataTarget;
    }
    throw failure;
  }
}

function dmvDashboardFingerprint_(dashboard) {
  return dmvOutputDigest_(
    dmvCanonical_({
      name: dashboard.name,
      spreadsheetId: dashboard.spreadsheetId,
      sources: dashboard.sources,
      summary: dashboard.summary,
      dataTarget: dashboard.dataTarget,
      target: dashboard.target,
    })
  );
}

function dmvDashboardRange_(target, result) {
  var cell = dmvCell_(target.startCell);
  return (
    cell.a1 +
    ':' +
    dmvChatA1_(cell.row + result.matrix.length - 1, cell.column + result.columns.length - 1)
  );
}
