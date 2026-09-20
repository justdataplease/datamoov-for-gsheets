function dmvConnectionInUse_(id, activeOnly) {
  function active(item) {
    return !activeOnly || (item.runToken && Date.now() - item.startedAt < 300000);
  }
  return (
    dmvList_('report').some(function (report) {
      return report.connectionId === id && active(report);
    }) ||
    dmvList_('dashboard').some(function (dashboard) {
      return (
        active(dashboard) &&
        // Plans are stored packed; their connections are listed beside them. Dashboards saved
        // by an earlier version still carry plain sources.
        (
          dashboard.connectionIds ||
          (dashboard.sources || []).map(function (source) {
            return source.connectionId;
          })
        ).indexOf(id) >= 0
      );
    })
  );
}

/* Saved connections: a saved credential (or, for older connections, embedded secrets) plus the
   per-connection values. Secrets stay private to the Google user who entered them. */
// Connections of a source that is no longer offered stay stored but are not listed.
function dmvConnections_() {
  return dmvList_('connection').filter(function (connection) {
    return !!(DMV_CONNECTORS && DMV_CONNECTORS[connection.connectorId]);
  });
}

function dmvConnectionSummary_(connection) {
  var fields = dmvConnector_(connection.connectorId).authFields || [];
  var merged,
    credentialMissing = false;
  try {
    merged = dmvConnectionValues_(connection);
  } catch (error) {
    merged = connection.credentials || {};
    credentialMissing = true;
  }
  var values = {};
  var configured = [];
  fields.forEach(function (field) {
    var value = merged[field.key];
    if (value !== undefined && value !== '') configured.push(field.key);
    if (field.type !== 'password' && !field.secret && field.key !== 'serviceAccountJson')
      values[field.key] = value;
  });
  var summary = {
    id: connection.id,
    label: connection.label,
    connectorId: connection.connectorId,
    credentialId: connection.credentialId || null,
    values: values,
    configuredFields: configured,
  };
  if (credentialMissing) summary.credentialMissing = true;
  return summary;
}

function dmvAccountSelectionKeys_(connector) {
  var keys = connector.accountDiscovery ? connector.accountDiscovery.credentialKeys : [];
  if (!Array.isArray(keys)) throw new Error('Invalid account discovery declaration.');
  keys.forEach(function (key) {
    var field = (connector.authFields || []).filter(function (item) {
      return item.key === key;
    })[0];
    if (!field || field.secret || field.type === 'password' || key === 'serviceAccountJson')
      throw new Error('Account discovery must select non-secret credential fields.');
  });
  return keys;
}

// Target identity fields can be declared without offering account discovery.
function dmvConnectionIdentityKeys_(connector) {
  var declared = connector.connectionKeys || [];
  if (!Array.isArray(declared)) throw new Error('Invalid connection identity declaration.');
  var keys = dmvAccountSelectionKeys_(connector).slice();
  declared.forEach(function (key) {
    var field = (connector.authFields || []).filter(function (item) {
      return item.key === key;
    })[0];
    if (!field || !field.perConnection || field.secret || field.type === 'password')
      throw new Error('Connection identity must use non-secret per-connection fields.');
    if (keys.indexOf(key) < 0) keys.push(key);
  });
  return keys;
}

function dmvConnectionCredentials_(connector, input, previous, fields) {
  var credentials = {};
  (fields || connector.authFields || []).forEach(function (field) {
    var value = (input.credentials || {})[field.key];
    var secret = field.secret || field.type === 'password' || field.key === 'serviceAccountJson';
    if (secret && (value === '' || value === undefined) && previous)
      value = previous.credentials[field.key];
    if (value !== undefined) credentials[field.key] = value;
  });
  return credentials;
}

function dmvDiscoverAccounts(input) {
  input = input || {};
  var connector = dmvConnector_(input.connectorId);
  if (!connector.accountDiscovery || typeof connector.discoverAccounts !== 'function')
    throw new Error('This source does not support account discovery.');
  var previous = input.id ? dmvRead_('connection', input.id) : null;
  if (previous && previous.connectorId !== connector.id)
    throw new Error('Choose a connection for this source.');
  var keys = dmvAccountSelectionKeys_(connector);
  var credentials;
  var discoveryConnection = {};
  if (input.credentialId) {
    // The selected credential is authoritative; an older embedded connection cannot override
    // it with its retained secrets, and a credential from another provider is never consulted.
    var credential = dmvRead_('credential', input.credentialId);
    if (credential.family !== dmvFamilyId_(connector))
      throw new Error('This credential is for another type of source.');
    credentials = Object.assign(
      {},
      credential.values,
      dmvConnectionCredentials_(connector, input, previous, dmvConnectionFields_(connector))
    );
    discoveryConnection.credentialId = credential.id;
    discoveryConnection.credentialRevision = credential.revision || 0;
  } else {
    var stored = previous ? dmvConnectionValues_(previous) : null;
    credentials = Object.assign(
      {},
      stored || {},
      dmvConnectionCredentials_(connector, input, stored ? { credentials: stored } : null)
    );
  }
  credentials = dmvFieldsInput_(
    (connector.authFields || []).filter(function (field) {
      return keys.indexOf(field.key) === -1;
    }),
    credentials
  );
  if (!dmvVisible_(connector.accountDiscovery, credentials))
    throw new Error('Choose the supported authorization method to find accounts.');
  discoveryConnection.credentials = credentials;
  try {
    var accounts = connector.discoverAccounts(
      dmvContext_(connector, discoveryConnection, { config: {}, fields: [], maxRows: 1000 }, {})
    );
    if (!Array.isArray(accounts) || accounts.length > 1000)
      throw new Error('The account list is incomplete or too large.');
    var seen = Object.create(null);
    return {
      complete: true,
      accounts: accounts.map(function (account) {
        if (!account || !account.credentials) throw new Error('Invalid account discovery result.');
        var id = dmvText_(account.id, 'Account choice', 200, true);
        if (seen[id]) throw new Error('The provider returned duplicate account choices.');
        seen[id] = true;
        var selected = {};
        keys.forEach(function (key) {
          var field = connector.authFields.filter(function (item) {
            return item.key === key;
          })[0];
          selected[key] = dmvText_(account.credentials[key], field.label, 200, field.required);
        });
        return {
          id: id,
          label: dmvText_(account.label, 'Account label', 240, true),
          credentials: selected,
        };
      }),
    };
  } catch (error) {
    throw new Error(dmvSafeError_(error, credentials));
  }
}

function dmvSaveConnection(input, deadline) {
  deadline = Number.isFinite(deadline)
    ? Math.min(deadline, Date.now() + 240000)
    : Date.now() + 240000;
  return dmvLocked_(function () {
    input = input || {};
    var connector = dmvConnector_(input.connectorId);
    var previous = input.id ? dmvRead_('connection', input.id) : null;
    if (previous && previous.connectorId !== input.connectorId)
      throw new Error('Create a separate connection for a different source.');
    if (previous && dmvConnectionInUse_(previous.id, true))
      throw new Error('Wait for the current refresh to finish before editing this connection.');
    if (!previous && dmvList_('connection').length >= DMV_LIMITS.maxConnections)
      throw new Error('Keep at most ' + DMV_LIMITS.maxConnections + ' connections in this app.');
    // With a saved credential the connection keeps only its own values (account ids, chat scope);
    // older connections may still embed the whole credential.
    var credential = null;
    if (input.credentialId) {
      credential = dmvRead_('credential', input.credentialId);
      if (credential.family !== dmvFamilyId_(connector))
        throw new Error('This credential is for another type of source.');
    }
    var ownFields = credential ? dmvConnectionFields_(connector) : connector.authFields || [];
    var own = dmvFieldsInput_(
      ownFields,
      dmvConnectionCredentials_(connector, input, previous, ownFields)
    );
    ownFields.forEach(function (field) {
      if (String(own[field.key] || '').length > 12000)
        throw new Error(field.label + ' is too long.');
    });
    var credentials = credential ? Object.assign({}, credential.values, own) : own;
    var before = previous ? dmvConnectionValues_(previous) : null;
    var changed =
      !previous ||
      (previous.credentialId || null) !== (credential ? credential.id : null) ||
      (connector.authFields || []).some(function (field) {
        return credentials[field.key] !== before[field.key];
      });
    var selectionChanged =
      previous &&
      dmvConnectionIdentityKeys_(connector).some(function (key) {
        return String(before[key] || '') !== String(credentials[key] || '');
      });
    if (selectionChanged && dmvConnectionInUse_(previous.id, false))
      throw new Error(
        'Create a new connection to change the account used by saved reports or dashboards.'
      );
    // New or changed credentials are checked with the provider before they are saved, so a bad
    // key fails here instead of at the first scheduled refresh. Label-only edits skip the check.
    var verified = changed && (typeof connector.test === 'function' || !!connector.googleScopes);
    if (verified) {
      if (Date.now() > deadline - 10000) throw new Error('Connection save reached its time limit.');
      try {
        // Rotated secrets from the check land on the credential record, or (embedded) on the
        // very object stored below.
        var context = dmvContext_(
          connector,
          credential
            ? {
                credentials: credentials,
                credentialId: credential.id,
                credentialRevision: credential.revision || 0,
              }
            : { credentials: credentials },
          { config: {}, fields: [], maxRows: 1 },
          {},
          deadline
        );
        if (typeof connector.test === 'function') connector.test(context);
        else context.accessToken();
      } catch (error) {
        throw new Error(dmvSafeError_(error, credentials));
      }
    }
    var connection = {
      id: previous ? previous.id : dmvId_(),
      label: dmvText_(input.label, 'Connection name', 80, true),
      connectorId: connector.id,
      credentialId: credential ? credential.id : undefined,
      credentials: own,
      revision: previous ? (previous.revision || 0) + 1 : 1,
    };
    dmvSave_('connection', connection);
    var summary = dmvConnectionSummary_(connection);
    summary.verified = verified;
    return summary;
  });
}

// Persist a provider-issued replacement secret (a rotated refresh token) into the saved
// connection. Skipped when the user edited the connection meanwhile; only secret fields change.
function dmvRotateCredentials_(connection, patch) {
  var kind = connection.credentialId ? 'credential' : 'connection';
  var id = connection.credentialId || connection.id;
  if (!id) return;
  return dmvLocked_(function () {
    var raw = dmvStore_().getProperty(dmvKey_(kind, id));
    if (!raw) return;
    var saved = JSON.parse(raw);
    var expected = connection.credentialId ? connection.credentialRevision : connection.revision;
    if ((saved.revision || 0) !== (expected || 0)) return;
    var fields = connection.credentialId
      ? dmvCredentialFamily_(saved.family).fields
      : dmvConnector_(saved.connectorId).authFields || [];
    var secrets = dmvSecretKeys_(fields);
    var target = connection.credentialId ? saved.values : saved.credentials;
    var changed = false;
    Object.keys(patch).forEach(function (key) {
      if (secrets.indexOf(key) < 0 || typeof patch[key] !== 'string') return;
      target[key] = patch[key];
      changed = true;
    });
    if (changed) dmvSave_(kind, saved);
  });
}

function dmvDeleteConnection(id) {
  return dmvLocked_(function () {
    dmvRead_('connection', id);
    if (dmvConnectionInUse_(id, false))
      throw new Error('Remove or update the reports and dashboards using this connection first.');
    dmvStore_().deleteProperty(dmvKey_('connection', id));
    return { ok: true };
  });
}

function dmvTestConnection(id) {
  var connection = dmvReadConnection_(id);
  var connector = dmvConnector_(connection.connectorId);
  if (typeof connector.test !== 'function')
    return {
      ok: true,
      message: 'Credentials are saved. Preview a report to verify provider access.',
    };
  try {
    connector.test(dmvContext_(connector, connection, { config: {}, fields: [], maxRows: 1 }, {}));
    return { ok: true, message: 'Connection verified.' };
  } catch (error) {
    throw new Error(dmvSafeError_(error, connection.credentials));
  }
}
