/* Import local credential bundles into the executing user's private settings. */
/* A ready-to-edit bundle covering every source, built from the live registry. */
function dmvSampleValue_(field, connectorId) {
  if (field.type === 'select') {
    var options = field.options || [];
    var chosen = field.default === undefined ? options[0] : field.default;
    return typeof chosen === 'string' || typeof chosen === 'number'
      ? chosen
      : (chosen && chosen.value) || '';
  }
  if (field.default !== undefined && field.default !== null && field.type !== 'password')
    return field.default;
  if (field.type === 'number') return 0;
  if (field.key === 'serviceAccountJson')
    return JSON.stringify({
      type: 'service_account',
      project_id: 'REPLACE_PROJECT',
      private_key_id: 'REPLACE',
      private_key: 'REPLACE_WITH_YOUR_PRIVATE_KEY',
      client_email: 'datamoov@REPLACE_PROJECT.iam.gserviceaccount.com',
      client_id: '000000000000000000000',
      token_uri: 'https://oauth2.googleapis.com/token',
    });
  // Placeholders say what belongs there; no sample ever carries a usable secret.
  return (
    'REPLACE_' +
    String(field.key)
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .toUpperCase() +
    (connectorId ? '_' + connectorId.toUpperCase() : '')
  );
}

function dmvSampleValues_(fields, connectorId) {
  var values = {};
  (fields || []).forEach(function (field) {
    values[field.key] = dmvSampleValue_(field, connectorId);
  });
  return values;
}

// One credential per type and one connection per source, so the file shows every shape the
// importer accepts. Values are placeholders: importing it unchanged fails the provider checks.
function dmvCredentialSample() {
  var families = dmvCredentialFamilies_();
  var credentials = Object.keys(families)
    .sort()
    .map(function (id) {
      var family = families[id];
      return {
        ref: id,
        label: family.label + ' (sample)',
        family: family.id,
        values: dmvSampleValues_(family.fields, family.connectors.length === 1 ? family.id : ''),
      };
    });
  var connections = Object.keys(DMV_CONNECTORS || {})
    .sort()
    .filter(function (id) {
      return !!families[dmvFamilyId_(dmvConnector_(id))];
    })
    .map(function (id) {
      var connector = dmvConnector_(id);
      return {
        ref: id,
        label: connector.label + ' (sample)',
        connectorId: id,
        credentialRef: dmvFamilyId_(connector),
        credentials: dmvSampleValues_(dmvConnectionFields_(connector), id),
      };
    });
  return {
    fileName: 'datamoov-credentials-sample.json',
    json: JSON.stringify(
      { version: 1, credentials: credentials, connections: connections },
      null,
      2
    ),
  };
}

function dmvImportObject_(value, allowed, label) {
  if (!value || Object.prototype.toString.call(value) !== '[object Object]')
    throw new Error(label + ' must be an object.');
  if (
    Object.keys(value).some(function (key) {
      return allowed.indexOf(key) < 0;
    })
  )
    throw new Error(label + ' contains an unsupported field.');
  return value;
}

function dmvImportRef_(value) {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(value) ||
    ['constructor', 'prototype', '__proto__'].indexOf(value) >= 0
  )
    throw new Error('Import references must be distinct ordinary names of at most 80 characters.');
  return value;
}

function dmvImportLabel_(value) {
  if (typeof value !== 'string') throw new Error('Each imported item needs a name.');
  return dmvText_(value, 'Imported item name', 80, true);
}

function dmvImportValues_(fields, input) {
  dmvImportObject_(
    input,
    fields.map(function (field) {
      return field.key;
    }),
    'Imported settings'
  );
  Object.keys(input).forEach(function (key) {
    var value = input[key];
    if (value !== null && ['string', 'number', 'boolean'].indexOf(typeof value) < 0)
      throw new Error('Imported settings must contain only text, numbers or booleans.');
    if (typeof value === 'number' && !Number.isFinite(value))
      throw new Error('Imported settings contain an invalid number.');
    if (value !== null && String(value).length > 12000)
      throw new Error('An imported setting is too long.');
  });
  var normalized = dmvFieldsInput_(fields, input);
  var active = {};
  fields.forEach(function (field) {
    if (dmvVisible_(field, normalized) && normalized[field.key] !== undefined)
      active[field.key] = normalized[field.key];
  });
  return active;
}

// Validate the entire package before any provider request or settings mutation. Version 1 holds
// credentials and connections; version 2 (what Export to file writes) adds reports and dashboards
// that refer to the bundle's connections by ref.
var DMV_IMPORT_MAX_BYTES = 4000000;

function dmvImportPlan_(bundle) {
  dmvImportObject_(
    bundle,
    ['version', 'exportedAt', 'credentials', 'connections', 'reports', 'dashboards'],
    'Settings import'
  );
  var text;
  try {
    text = JSON.stringify(bundle);
  } catch (ignored) {
    throw new Error('Choose a valid DataMoov settings JSON file.');
  }
  if (
    text.length > DMV_IMPORT_MAX_BYTES ||
    Utilities.newBlob(text).getBytes().length > DMV_IMPORT_MAX_BYTES
  )
    throw new Error('The settings import must be at most 4,000,000 bytes.');
  if (
    (bundle.version !== 1 && bundle.version !== 2) ||
    !Array.isArray(bundle.credentials) ||
    !Array.isArray(bundle.connections) ||
    (bundle.version === 1 && (bundle.reports !== undefined || bundle.dashboards !== undefined)) ||
    (bundle.version === 2 && (!Array.isArray(bundle.reports) || !Array.isArray(bundle.dashboards)))
  )
    throw new Error(
      'Choose a version 1 credentials file (credentials and connections) or a version 2 settings file (credentials, connections, reports and dashboards).'
    );
  var reportItems = bundle.reports || [],
    dashboardItems = bundle.dashboards || [];
  // An export of a full account can list every credential and connection, plus one credential
  // per older connection that embedded its own; the account caps still apply when saving.
  if (
    bundle.credentials.length > DMV_LIMITS.maxCredentials + DMV_LIMITS.maxConnections ||
    bundle.connections.length > DMV_LIMITS.maxConnections
  )
    throw new Error(
      'Import at most ' +
        (DMV_LIMITS.maxCredentials + DMV_LIMITS.maxConnections) +
        ' credentials and ' +
        DMV_LIMITS.maxConnections +
        ' connections at a time.'
    );
  if (
    !bundle.credentials.length &&
    !bundle.connections.length &&
    !reportItems.length &&
    !dashboardItems.length
  )
    throw new Error('The file holds no credentials, connections, reports or dashboards.');
  if (reportItems.length > DMV_LIMITS.maxReports || dashboardItems.length > DMV_LIMITS.maxReports)
    throw new Error(
      'Import at most ' +
        DMV_LIMITS.maxReports +
        ' reports and ' +
        DMV_LIMITS.maxReports +
        ' dashboards at a time.'
    );
  var byRef = Object.create(null),
    connectionRefs = Object.create(null);
  var credentials = bundle.credentials.map(function (item) {
    dmvImportObject_(item, ['ref', 'label', 'family', 'values'], 'Imported credential');
    var ref = dmvImportRef_(item.ref);
    if (byRef[ref]) throw new Error('Each imported credential needs a distinct reference.');
    if (typeof item.family !== 'string') throw new Error('Choose a supported credential type.');
    var family = dmvCredentialFamily_(item.family);
    var planned = {
      ref: ref,
      label: dmvImportLabel_(item.label),
      family: family.id,
      values: dmvImportValues_(family.fields, item.values),
    };
    dmvCheckRecordSize_({
      id: '00000000-0000-0000-0000-000000000000',
      label: planned.label,
      family: planned.family,
      values: planned.values,
      revision: 1,
    });
    byRef[ref] = planned;
    return planned;
  });
  var connections = bundle.connections.map(function (item, index) {
    dmvImportObject_(
      item,
      ['ref', 'label', 'connectorId', 'credentialRef', 'credentials'],
      'Imported connection'
    );
    var ref = dmvImportRef_(item.ref === undefined ? 'connection-' + (index + 1) : item.ref);
    if (connectionRefs[ref])
      throw new Error('Each imported connection needs a distinct reference.');
    connectionRefs[ref] = true;
    if (typeof item.connectorId !== 'string') throw new Error('Choose an available data source.');
    var connector = dmvConnector_(item.connectorId);
    var credentialRef = dmvImportRef_(item.credentialRef),
      credential = byRef[credentialRef];
    if (!credential) throw new Error('Each connection must reference a credential in this import.');
    if (credential.family !== dmvFamilyId_(connector))
      throw new Error('An imported connection references another type of credential.');
    var own = dmvImportValues_(dmvConnectionFields_(connector), item.credentials);
    dmvFieldsInput_(connector.authFields || [], Object.assign({}, credential.values, own));
    var planned = {
      ref: ref,
      label: dmvImportLabel_(item.label),
      connectorId: connector.id,
      credentialRef: credentialRef,
      credentials: own,
    };
    dmvCheckRecordSize_({
      id: '00000000-0000-0000-0000-000000000000',
      label: planned.label,
      connectorId: planned.connectorId,
      credentialId: '00000000-0000-0000-0000-000000000000',
      credentials: own,
      revision: 1,
    });
    return planned;
  });
  // Reports and dashboards are checked for shape here; their queries need the saved connection,
  // so the report and dashboard validators run at save time, after connections are resolved.
  var reportRefs = Object.create(null);
  var reports = reportItems.map(function (item, index) {
    dmvImportObject_(
      item,
      [
        'ref',
        'name',
        'connectionRef',
        'reportType',
        'fields',
        'config',
        'dateRange',
        'maxRows',
        'target',
        'schedule',
        'at',
      ],
      'Imported report'
    );
    var ref = dmvImportRef_(item.ref === undefined ? 'report-' + (index + 1) : item.ref);
    if (reportRefs[ref]) throw new Error('Each imported report needs a distinct reference.');
    reportRefs[ref] = true;
    var connectionRef = dmvImportRef_(item.connectionRef);
    if (!connectionRefs[connectionRef])
      throw new Error('Each imported report must reference a connection in this import.');
    return {
      ref: ref,
      name: dmvText_(item.name, 'Imported report name', 80, true),
      connectionRef: connectionRef,
      reportType: dmvText_(item.reportType, 'Imported report type', 80, true),
      fields: dmvImportStrings_(item.fields, 'Imported report fields'),
      config: dmvImportPlain_(
        item.config === undefined ? {} : item.config,
        'Imported report settings'
      ),
      dateRange: dmvImportPlain_(
        item.dateRange === undefined ? {} : item.dateRange,
        'Imported date range'
      ),
      maxRows: item.maxRows,
      target: dmvImportObject_(
        item.target || {},
        ['sheetName', 'startCell'],
        'Imported report tab'
      ),
      schedule: dmvSchedule_(item.schedule),
      at: item.at === undefined ? null : dmvImportPlain_(item.at, 'Imported schedule time'),
    };
  });
  var dashboardRefs = Object.create(null);
  var dashboards = dashboardItems.map(function (item, index) {
    dmvImportObject_(
      item,
      [
        'ref',
        'name',
        'target',
        'datasets',
        'tiles',
        'lowerIsBetter',
        'neutral',
        'toned',
        'schedule',
        'at',
      ],
      'Imported dashboard'
    );
    var ref = dmvImportRef_(item.ref === undefined ? 'dashboard-' + (index + 1) : item.ref);
    if (dashboardRefs[ref]) throw new Error('Each imported dashboard needs a distinct reference.');
    dashboardRefs[ref] = true;
    if (!Array.isArray(item.datasets) || !item.datasets.length || !Array.isArray(item.tiles))
      throw new Error('Each imported dashboard needs datasets and tiles.');
    var datasets = item.datasets.map(function (dataset) {
      dmvImportObject_(
        dataset,
        [
          'id',
          'label',
          'sheetName',
          'connectionRef',
          'reportType',
          'fields',
          'config',
          'dateRange',
          'maxRows',
          'mapping',
        ],
        'Imported dashboard dataset'
      );
      var connectionRef = dmvImportRef_(dataset.connectionRef);
      if (!connectionRefs[connectionRef])
        throw new Error('Each dashboard dataset must reference a connection in this import.');
      var planned = Object.assign({}, dmvImportPlain_(dataset, 'Imported dashboard dataset'));
      planned.connectionRef = connectionRef;
      return planned;
    });
    if (item.toned !== undefined && typeof item.toned !== 'boolean')
      throw new Error('Imported dashboard toned must be true or false.');
    var dashboard = {
      ref: ref,
      name: dmvText_(item.name, 'Imported dashboard name', 80, true),
      target: {
        sheetName: dmvSheetName_(
          dmvImportObject_(item.target || {}, ['sheetName'], 'Imported dashboard tab').sheetName
        ),
      },
      datasets: datasets,
      tiles: dmvImportPlain_(item.tiles, 'Imported dashboard tiles'),
      // Files written before changes carried colour have no toned flag: their plans had none.
      toned: item.toned === true,
      schedule: dmvSchedule_(item.schedule),
      at: item.at === undefined ? null : dmvImportPlain_(item.at, 'Imported schedule time'),
    };
    // The names are checked against the tiles by the dashboard validator at save time.
    ['lowerIsBetter', 'neutral'].forEach(function (name) {
      if (item[name] !== undefined)
        dashboard[name] = dmvImportStrings_(item[name], 'Imported dashboard ' + name);
    });
    return dashboard;
  });
  return {
    credentials: credentials,
    connections: connections,
    reports: reports,
    dashboards: dashboards,
  };
}

function dmvImportStrings_(value, label) {
  if (
    !Array.isArray(value) ||
    value.length > DMV_LIMITS.maxColumns ||
    value.some(function (item) {
      return typeof item !== 'string' || !item || item.length > 150;
    })
  )
    throw new Error(label + ' must be a list of field names.');
  return value.slice();
}

// Plain JSON only: objects and arrays of text, numbers, booleans and null, without prototype
// keys, so a bundle can never smuggle code or reach beyond the validators that read it.
function dmvImportPlain_(value, label, depth) {
  depth = depth || 0;
  if (depth > 8) throw new Error(label + ' is nested too deeply.');
  if (value === null || ['string', 'boolean'].indexOf(typeof value) >= 0) return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(label + ' contains an invalid number.');
    return value;
  }
  if (Array.isArray(value))
    return value.map(function (item) {
      return dmvImportPlain_(item, label, depth + 1);
    });
  if (Object.prototype.toString.call(value) !== '[object Object]')
    throw new Error(label + ' must contain only plain values.');
  var out = {};
  Object.keys(value).forEach(function (key) {
    if (['constructor', 'prototype', '__proto__'].indexOf(key) >= 0 || key.length > 150)
      throw new Error(label + ' contains an unsupported key.');
    out[key] = dmvImportPlain_(value[key], label, depth + 1);
  });
  return out;
}

function dmvImportSameValues_(fields, left, right) {
  try {
    var a = dmvFieldsInput_(fields, left),
      b = dmvFieldsInput_(fields, right);
    return fields.every(function (field) {
      if (dmvVisible_(field, a) !== dmvVisible_(field, b)) return false;
      if (!dmvVisible_(field, a)) return true;
      var first = a[field.key] === undefined || a[field.key] === null ? '' : a[field.key];
      var second = b[field.key] === undefined || b[field.key] === null ? '' : b[field.key];
      return first === second;
    });
  } catch (ignored) {
    return false;
  }
}

function dmvImportUniqueLabel_(label, saved) {
  var next = label,
    index = 2;
  while (
    saved.some(function (item) {
      return item.label === next;
    })
  ) {
    var suffix = ' (imported ' + index++ + ')';
    next = label.slice(0, 80 - suffix.length) + suffix;
  }
  return next;
}

function dmvImportFailure_(error, kind) {
  var message = String((error && error.message) || '');
  if (/time limit|deadline/i.test(message))
    return {
      code: 'time_limit',
      message:
        'Import time limit reached. Import the same file again to finish; saved entries will be reused.',
    };
  if (/another refresh|wait for the current refresh/i.test(message))
    return {
      code: 'busy',
      message: 'Another run is updating your settings. Import again after it finishes.',
    };
  if (/keep at most/i.test(message))
    return {
      code: 'capacity',
      message:
        'Your private settings limit was reached. Remove unused entries before importing again.',
    };
  // Reports and dashboards are validated without provider requests, so their messages name
  // the field or tab at fault and are safe to show.
  if (kind === 'report' || kind === 'dashboard') {
    if (message === 'unresolved connection') return dmvImportUnresolved_('connection');
    return {
      code: 'invalid',
      message:
        'Could not save this ' + kind + ': ' + (message || 'check its settings.').slice(0, 300),
    };
  }
  return {
    code: 'verification_failed',
    message:
      kind === 'credential'
        ? 'Could not verify or save this credential. Check its authorization and import again.'
        : 'Could not verify this connection. Check its account settings, permissions and provider access policy, then import again.',
  };
}

function dmvImportCredentials(bundle) {
  var plan = dmvImportPlan_(bundle),
    deadline = Date.now() + 200000;
  var resolved = Object.create(null),
    resolvedConnections = Object.create(null);
  var response = {
    credentials: [],
    connections: [],
    reports: [],
    dashboards: [],
    summary: {
      credentials: { saved: 0, existing: 0, failed: 0 },
      connections: { saved: 0, existing: 0, failed: 0 },
      reports: { saved: 0, existing: 0, failed: 0 },
      dashboards: { saved: 0, existing: 0, failed: 0 },
    },
  };
  function record(kind, item, action) {
    var outcome = { ref: item.ref, label: item.label || item.name };
    try {
      if (Date.now() > deadline - 10000) throw new Error('Import time limit reached.');
      Object.assign(
        outcome,
        dmvLocked_(function () {
          if (Date.now() > deadline - 10000) throw new Error('Import time limit reached.');
          return action();
        })
      );
    } catch (error) {
      Object.assign(outcome, { status: 'failed' }, dmvImportFailure_(error, kind));
    }
    var group = {
      credential: 'credentials',
      connection: 'connections',
      report: 'reports',
      dashboard: 'dashboards',
    }[kind];
    response[group].push(outcome);
    response.summary[group][outcome.status]++;
  }
  plan.credentials.forEach(function (item) {
    record('credential', item, function () {
      var fields = dmvCredentialFamily_(item.family).fields,
        saved = dmvList_('credential');
      var existing = saved.filter(function (credential) {
        return (
          credential.family === item.family &&
          dmvImportSameValues_(fields, credential.values, item.values)
        );
      })[0];
      var result =
        existing ||
        dmvSaveCredential(
          {
            family: item.family,
            label: dmvImportUniqueLabel_(item.label, saved),
            values: item.values,
          },
          deadline
        );
      var current = dmvRead_('credential', result.id);
      resolved[item.ref] = { id: current.id, revision: current.revision || 0 };
      var outcome = { id: result.id, label: result.label, status: existing ? 'existing' : 'saved' };
      if (!existing) outcome.verified = result.verified === true;
      return outcome;
    });
  });
  plan.connections.forEach(function (item) {
    record('connection', item, function () {
      var credential = resolved[item.credentialRef];
      if (!credential)
        return {
          status: 'failed',
          code: 'credential_unavailable',
          message:
            'The referenced credential was not imported. Resolve its error and import again.',
        };
      var current = dmvRead_('credential', credential.id);
      if ((current.revision || 0) !== credential.revision)
        return {
          status: 'failed',
          code: 'credential_changed',
          message:
            'The credential changed during import. Import again after other settings changes finish.',
        };
      var connector = dmvConnector_(item.connectorId),
        fields = dmvConnectionFields_(connector);
      var saved = dmvList_('connection');
      var existing = saved.filter(function (connection) {
        return (
          connection.connectorId === item.connectorId &&
          connection.credentialId === credential.id &&
          dmvImportSameValues_(fields, connection.credentials, item.credentials)
        );
      })[0];
      // An older connection that embeds the same credential values is the same connection;
      // link it to the imported credential so reports resolve to it and nothing is duplicated.
      if (!existing) {
        var legacy = saved.filter(function (connection) {
          return (
            connection.connectorId === item.connectorId &&
            !connection.credentialId &&
            dmvImportSameValues_(
              connector.authFields || [],
              connection.credentials,
              Object.assign({}, current.values, item.credentials)
            )
          );
        })[0];
        if (legacy)
          existing = dmvSaveConnection(
            {
              id: legacy.id,
              connectorId: legacy.connectorId,
              credentialId: credential.id,
              label: legacy.label,
              credentials: item.credentials,
            },
            deadline
          );
      }
      var result =
        existing ||
        dmvSaveConnection(
          {
            connectorId: item.connectorId,
            credentialId: credential.id,
            label: dmvImportUniqueLabel_(item.label, saved),
            credentials: item.credentials,
          },
          deadline
        );
      var outcome = { id: result.id, label: result.label, status: existing ? 'existing' : 'saved' };
      if (!existing) outcome.verified = result.verified === true;
      resolvedConnections[item.ref] = result.id;
      return outcome;
    });
  });
  // Reports and dashboards are saved into this spreadsheet through the ordinary validators;
  // no data is fetched. An item that matches a saved one is reused, never overwritten.
  var spreadsheet = dmvSpreadsheet_();
  plan.reports.forEach(function (item) {
    record('report', item, function () {
      var connectionId = resolvedConnections[item.connectionRef];
      if (!connectionId) return dmvImportUnresolved_('connection');
      var input = {
        name: item.name,
        connectionId: connectionId,
        reportType: item.reportType,
        fields: item.fields,
        config: item.config,
        dateRange: item.dateRange,
        maxRows: item.maxRows,
        target: item.target,
        schedule: item.schedule,
        at: item.at,
      };
      var wanted = dmvValidateReport_(input, spreadsheet);
      var identity = dmvImportReportIdentity_(wanted);
      var existing = dmvListReports_(spreadsheet).filter(function (report) {
        return dmvImportReportIdentity_(report) === identity;
      })[0];
      var result = existing || dmvSaveReport(input);
      return { id: result.id, label: result.name, status: existing ? 'existing' : 'saved' };
    });
  });
  plan.dashboards.forEach(function (item) {
    record('dashboard', item, function () {
      var datasets = item.datasets.map(function (dataset) {
        var connectionId = resolvedConnections[dataset.connectionRef];
        if (!connectionId) throw new Error('unresolved connection');
        var query = Object.assign({}, dataset, { connectionId: connectionId });
        delete query.connectionRef;
        return query;
      });
      var existing = dmvList_('dashboard').filter(function (dashboard) {
        return (
          dashboard.spreadsheetId === spreadsheet.getId() &&
          dashboard.name === item.name &&
          dashboard.target &&
          dashboard.target.sheetName === item.target.sheetName
        );
      })[0];
      var result = existing || dmvImportSaveDashboard_(item, datasets);
      return { id: result.id, label: result.name, status: existing ? 'existing' : 'saved' };
    });
  });
  return response;
}

// A dashboard is saved through the ordinary validator, its polarity lists included, so it keeps
// the colours of its changes. A plan saved before changes carried colour (no toned flag) is
// saved the way a refresh reads it: what a save now refuses is repaired, its periods are not
// checked again and no rise of a cost is called good, so it imports wherever it refreshed.
function dmvImportSaveDashboard_(item, datasets) {
  var input = {
    name: item.name,
    target: item.target,
    datasets: datasets,
    tiles: item.tiles,
    schedule: item.schedule,
    at: item.at,
  };
  if (item.lowerIsBetter) input.lowerIsBetter = item.lowerIsBetter;
  if (item.neutral) input.neutral = item.neutral;
  return dmvDashboardSave_(input, !item.toned);
}

function dmvImportUnresolved_(kind) {
  return {
    status: 'failed',
    code: kind + '_unavailable',
    message: 'The referenced ' + kind + ' was not imported. Resolve its error and import again.',
  };
}

// Two reports are the same when they read the same query into the same place.
function dmvImportReportIdentity_(report) {
  return JSON.stringify(
    dmvCanonical_({
      connectionId: report.connectionId,
      reportType: report.reportType,
      fields: (report.fields || []).slice().sort(),
      config: report.config || {},
      dateRange: report.dateRange || {},
      target: report.target || {},
    })
  );
}

// Every private setting of this account and spreadsheet as a version 2 bundle: credentials with
// their secrets, connections, and this spreadsheet's reports and dashboards, linked by refs the
// importer resolves. It is written only when the user asks for the download; keep the file private.
function dmvExportSettings() {
  var spreadsheet = dmvSpreadsheet_();
  var used = Object.create(null);
  function ref(label, fallback) {
    var base =
      String(label || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || fallback;
    if (!/^[a-z]/.test(base) || ['constructor', 'prototype', '__proto__'].indexOf(base) >= 0)
      base = fallback + '-' + base;
    var next = base,
      index = 2;
    while (used[next]) next = base + '-' + index++;
    used[next] = true;
    return next;
  }
  var credentialRefs = Object.create(null),
    connectionRefs = Object.create(null),
    skipped = [];
  var credentials = [];
  dmvList_('credential').forEach(function (credential, index) {
    try {
      dmvCredentialFamily_(credential.family);
    } catch (ignored) {
      skipped.push({
        kind: 'credential',
        label: credential.label,
        reason: 'its source is no longer installed',
      });
      return;
    }
    var item = {
      ref: ref(credential.label, 'credential-' + (index + 1)),
      label: credential.label,
      family: credential.family,
      values: credential.values || {},
    };
    credentialRefs[credential.id] = item.ref;
    credentials.push(item);
  });
  var connections = [];
  dmvList_('connection').forEach(function (connection, index) {
    var connector;
    try {
      connector = dmvConnector_(connection.connectorId);
    } catch (ignored) {
      skipped.push({
        kind: 'connection',
        label: connection.label,
        reason: 'its source is no longer installed',
      });
      return;
    }
    var credentialRef = credentialRefs[connection.credentialId];
    var own = {};
    if (!credentialRef) {
      // An older connection embeds its whole credential: split it into a credential entry of its
      // family plus the connection's own values, the shape newer records use.
      var family = dmvFamilyId_(connector),
        values = {};
      dmvCredentialFields_(connector).forEach(function (field) {
        if (connection.credentials && connection.credentials[field.key] !== undefined)
          values[field.key] = connection.credentials[field.key];
      });
      credentialRef = ref(
        connection.label + ' credential',
        'credential-' + (credentials.length + 1)
      );
      credentials.push({
        ref: credentialRef,
        label: connection.label,
        family: family,
        values: values,
      });
    }
    dmvConnectionFields_(connector).forEach(function (field) {
      if (connection.credentials && connection.credentials[field.key] !== undefined)
        own[field.key] = connection.credentials[field.key];
    });
    var item = {
      ref: ref(connection.label, 'connection-' + (index + 1)),
      label: connection.label,
      connectorId: connection.connectorId,
      credentialRef: credentialRef,
      credentials: own,
    };
    connectionRefs[connection.id] = item.ref;
    connections.push(item);
  });
  var reports = dmvListReports_(spreadsheet)
    .filter(function (report) {
      if (connectionRefs[report.connectionId]) return true;
      skipped.push({ kind: 'report', label: report.name, reason: 'its connection is missing' });
      return false;
    })
    .map(function (report, index) {
      return {
        ref: ref(report.name, 'report-' + (index + 1)),
        name: report.name,
        connectionRef: connectionRefs[report.connectionId],
        reportType: report.reportType,
        fields: report.fields,
        config: report.config || {},
        dateRange: report.dateRange,
        maxRows: report.maxRows,
        target: report.target,
        schedule: report.schedule || 'manual',
        at: report.at || null,
      };
    });
  var dashboards = [];
  dmvList_('dashboard').forEach(function (dashboard, index) {
    if (dashboard.spreadsheetId !== spreadsheet.getId()) return;
    var plan;
    try {
      plan = dmvDashboardPlan_(dashboard);
    } catch (ignored) {
      skipped.push({
        kind: 'dashboard',
        label: dashboard.name,
        reason: 'it was saved by an earlier version',
      });
      return;
    }
    if (
      plan.datasets.some(function (dataset) {
        return !connectionRefs[dataset.connectionId];
      })
    ) {
      skipped.push({
        kind: 'dashboard',
        label: dashboard.name,
        reason: 'a dataset connection is missing',
      });
      return;
    }
    var exported = {
      ref: ref(dashboard.name, 'dashboard-' + (index + 1)),
      name: dashboard.name,
      target: { sheetName: dashboard.target.sheetName },
      datasets: plan.datasets.map(function (dataset) {
        var item = {
          id: dataset.id,
          label: dataset.label,
          sheetName: dataset.sheetName,
          connectionRef: connectionRefs[dataset.connectionId],
          reportType: dataset.reportType,
          fields: dataset.fields,
          config: dataset.config || {},
          dateRange: dataset.dateRange,
          maxRows: dataset.maxRows,
        };
        if (dataset.mapping) item.mapping = dataset.mapping;
        return item;
      }),
      tiles: plan.tiles,
      // The colours of its changes: whether they are coloured at all (plans saved before were
      // not), and which values are better low or neither good nor bad.
      toned: plan.toned === true,
      schedule: dashboard.schedule || 'manual',
      at: dashboard.at || null,
    };
    if (plan.lowerIsBetter) exported.lowerIsBetter = plan.lowerIsBetter;
    if (plan.neutral) exported.neutral = plan.neutral;
    dashboards.push(exported);
  });
  if (!credentials.length && !connections.length && !reports.length && !dashboards.length)
    throw new Error(
      'There is nothing to export yet' +
        (skipped.length ? ': every saved item was skipped (' + skipped[0].reason + ').' : '.')
    );
  var bundle = {
    version: 2,
    exportedAt: new Date().toISOString(),
    credentials: credentials,
    connections: connections,
    reports: reports,
    dashboards: dashboards,
  };
  // Dashboard plans are stored compressed and grow when written out; the file must stay
  // within what Import accepts, so drop the pretty printing before refusing.
  var json = JSON.stringify(bundle, null, 2);
  if (json.length > DMV_IMPORT_MAX_BYTES) json = JSON.stringify(bundle);
  if (Utilities.newBlob(json).getBytes().length > DMV_IMPORT_MAX_BYTES)
    throw new Error(
      'The export is larger than the ' +
        DMV_IMPORT_MAX_BYTES.toLocaleString() +
        ' bytes Import accepts. Remove dashboards you no longer need and export again.'
    );
  return {
    fileName: 'datamoov-settings.json',
    json: json,
    skipped: skipped,
    counts: {
      credentials: credentials.length,
      connections: connections.length,
      reports: reports.length,
      dashboards: dashboards.length,
    },
  };
}
