/* Bounded continuation snapshots in private UserProperties; no extra scopes or external storage. */
var DMV_CONTINUATION = {
  chunksPerExecution: 10,
  executionMs: 45000,
  lifetimeMs: 86400000,
  partBytes: 7500,
  maxEncodedBytes: 180000,
  maxPropertyBytes: 450000,
};

function dmvContinuationPrefix_(reportId) {
  return dmvKey_('chunk', reportId) + ':';
}

// Called under the user lock. Retain only the generation referenced by the saved report.
function dmvClearContinuation_(reportId, keep) {
  var prefix = dmvContinuationPrefix_(reportId);
  var kept = keep ? prefix + keep + ':' : null;
  var store = dmvStore_();
  Object.keys(store.getProperties()).forEach(function (key) {
    if (key.indexOf(prefix) === 0 && (!kept || key.indexOf(kept) !== 0)) store.deleteProperty(key);
  });
}

function dmvReadContinuation_(report) {
  var ref = report.continuation;
  if (!ref) return null;
  try {
    if (
      !/^[a-zA-Z0-9-]{1,80}$/.test(ref.generation) ||
      !Number.isInteger(ref.parts) ||
      ref.parts < 1 ||
      ref.parts > Math.ceil(DMV_CONTINUATION.maxEncodedBytes / DMV_CONTINUATION.partBytes)
    )
      throw new Error('Invalid reference');
    var encoded = '',
      store = dmvStore_();
    for (var i = 0; i < ref.parts; i++) {
      var part = store.getProperty(dmvContinuationPrefix_(report.id) + ref.generation + ':' + i);
      if (part === null) throw new Error('Missing part');
      encoded += part;
    }
    if (
      encoded.length > DMV_CONTINUATION.maxEncodedBytes ||
      dmvOutputDigest_(encoded) !== ref.digest
    )
      throw new Error('Invalid snapshot');
    var snapshot = JSON.parse(
      Utilities.ungzip(Utilities.newBlob(Utilities.base64Decode(encoded))).getDataAsString()
    );
    if (
      snapshot.version !== 1 ||
      snapshot.reportId !== report.id ||
      snapshot.revision !== report.revision ||
      snapshot.spreadsheetId !== report.spreadsheetId ||
      !Number.isFinite(snapshot.createdAt) ||
      !snapshot.result ||
      snapshot.result.metadata.complete !== false
    )
      throw new Error('Invalid snapshot');
    return snapshot;
  } catch (error) {
    throw new Error(
      'The saved continuation is missing or damaged. Run the report again to restart.'
    );
  }
}

// Write new pieces first and commit the pointer last. Interrupted saves retain the last checkpoint.
function dmvSaveContinuation_(report, snapshot) {
  var store = dmvStore_();
  dmvClearContinuation_(report.id, report.continuation && report.continuation.generation);
  var encoded = Utilities.base64Encode(
    Utilities.gzip(Utilities.newBlob(JSON.stringify(snapshot))).getBytes()
  );
  if (encoded.length > DMV_CONTINUATION.maxEncodedBytes)
    throw new Error('This report is too large for private continuation storage. Narrow its scope.');
  var all = store.getProperties();
  var used = Object.keys(all).reduce(function (size, key) {
    return size + Utilities.newBlob(key + all[key]).getBytes().length;
  }, 0);
  var generation = dmvId_(),
    prefix = dmvContinuationPrefix_(report.id) + generation + ':';
  var parts = Math.ceil(encoded.length / DMV_CONTINUATION.partBytes);
  // Reserve pointer space and keys; old pieces remain until the new pointer is safe.
  if (
    used + encoded.length + parts * (prefix.length + 4) + 8000 >
    DMV_CONTINUATION.maxPropertyBytes
  )
    throw new Error(
      'Private continuation storage is full. Finish or remove paused reports, or narrow this report.'
    );
  for (var i = 0; i < parts; i++)
    store.setProperty(
      prefix + i,
      encoded.slice(i * DMV_CONTINUATION.partBytes, (i + 1) * DMV_CONTINUATION.partBytes)
    );
  report.continuation = { generation: generation, parts: parts, digest: dmvOutputDigest_(encoded) };
  report.fetchedRowCount = snapshot.result.rows.length;
  dmvSave_('report', report);
  dmvClearContinuation_(report.id, generation);
}

function dmvPendingReport_(report) {
  return !!report.continuationRequested;
}

// Cleanup cannot turn a successful atomic write into a reported failure. Orphans are removed
// before the next checkpoint/save/delete for this report.
function dmvFinishContinuation_(reportId) {
  try {
    dmvClearContinuation_(reportId);
  } catch (error) {
    /* Private state only. */
  }
  try {
    dmvEnsureSchedule_();
  } catch (error) {
    /* An existing trigger may retry later. */
  }
}

function dmvFetchContinued_(report, spreadsheet, token, connectionRevision) {
  var connection = dmvRead_('connection', report.connectionId);
  if ((connection.revision || 0) !== connectionRevision)
    throw new Error('The connection changed during the refresh. Run it again.');
  var connector = dmvConnector_(connection.connectorId);
  var definition = dmvDefinition_(connector, report.reportType);
  var snapshot = dmvReadContinuation_(report);
  if (snapshot && snapshot.connectionRevision !== (connection.revision || 0))
    throw new Error('The connection changed during continuation. Run the report again to restart.');
  if (snapshot && Date.now() - snapshot.createdAt > DMV_CONTINUATION.lifetimeMs)
    throw new Error('The saved continuation expired. Run the report again to restart.');
  if (!snapshot)
    snapshot = {
      version: 1,
      reportId: report.id,
      revision: report.revision,
      spreadsheetId: report.spreadsheetId,
      connectionRevision: connection.revision || 0,
      createdAt: Date.now(),
      dates: dmvReportDates_(definition, report, spreadsheet),
      result: null,
    };
  var ctx = dmvContext_(connector, connection, report, snapshot.dates);
  var started = Date.now(),
    chunks = 0;
  try {
    do {
      ctx.checkDeadline();
      snapshot.result = dmvMergeChunk_(
        snapshot.result,
        definition.fetchChunk(ctx, snapshot.result ? snapshot.result.state : null),
        report.maxRows
      );
      if (snapshot.result.metadata.complete)
        return dmvNormalizeResult_(snapshot.result, report.maxRows);
      dmvLocked_(function () {
        var current = dmvRead_('report', report.id);
        if (current.runToken !== token || current.revision !== report.revision)
          throw new Error('The report changed during the refresh. Run it again.');
        if ((dmvRead_('connection', current.connectionId).revision || 0) !== connectionRevision)
          throw new Error('The connection changed during the refresh. Run it again.');
        dmvSaveContinuation_(current, snapshot);
      });
      chunks++;
    } while (
      chunks < DMV_CONTINUATION.chunksPerExecution &&
      Date.now() - started < DMV_CONTINUATION.executionMs
    );
    return { pending: true, rowCount: snapshot.result.rows.length };
  } catch (error) {
    throw new Error(dmvSafeError_(error, connection.credentials));
  }
}
