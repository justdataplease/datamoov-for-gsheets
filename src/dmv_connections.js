/* Saved connections: credentials stay private to the Google user who entered them. */
function dmvConnectionSummary_(connection) {
  var fields = dmvConnector_(connection.connectorId).authFields || [];
  var values = {};
  var configured = [];
  fields.forEach(function (field) {
    var value = connection.credentials[field.key];
    if (value !== undefined && value !== '') configured.push(field.key);
    if (field.type !== 'password' && !field.secret && field.key !== 'serviceAccountJson')
      values[field.key] = value;
  });
  return {
    id: connection.id,
    label: connection.label,
    connectorId: connection.connectorId,
    values: values,
    configuredFields: configured,
  };
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

function dmvConnectionCredentials_(connector, input, previous) {
  var credentials = {};
  (connector.authFields || []).forEach(function (field) {
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
  var credentials = dmvConnectionCredentials_(connector, input, previous);
  credentials = dmvFieldsInput_(
    (connector.authFields || []).filter(function (field) {
      return keys.indexOf(field.key) === -1;
    }),
    credentials
  );
  if (!dmvVisible_(connector.accountDiscovery, credentials))
    throw new Error('Choose the supported authorization method to find accounts.');
  try {
    var accounts = connector.discoverAccounts(
      dmvContext_(
        connector,
        { credentials: credentials },
        { config: {}, fields: [], maxRows: 1000 },
        {}
      )
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

function dmvSaveConnection(input) {
  return dmvLocked_(function () {
    input = input || {};
    var connector = dmvConnector_(input.connectorId);
    var previous = input.id ? dmvRead_('connection', input.id) : null;
    if (previous && previous.connectorId !== input.connectorId)
      throw new Error('Create a separate connection for a different source.');
    if (
      previous &&
      dmvList_('report').some(function (report) {
        return (
          report.connectionId === previous.id &&
          report.runToken &&
          Date.now() - report.startedAt < 300000
        );
      })
    )
      throw new Error('Wait for the current refresh to finish before editing this connection.');
    if (!previous && dmvList_('connection').length >= DMV_LIMITS.maxConnections)
      throw new Error('Keep at most ' + DMV_LIMITS.maxConnections + ' connections in this app.');
    var credentials = dmvFieldsInput_(
      connector.authFields,
      dmvConnectionCredentials_(connector, input, previous)
    );
    (connector.authFields || []).forEach(function (field) {
      if (String(credentials[field.key] || '').length > 12000)
        throw new Error(field.label + ' is too long.');
    });
    var changed =
      !previous ||
      (connector.authFields || []).some(function (field) {
        return credentials[field.key] !== previous.credentials[field.key];
      });
    var selectionChanged =
      previous &&
      dmvAccountSelectionKeys_(connector).some(function (key) {
        return String(previous.credentials[key] || '') !== String(credentials[key] || '');
      });
    if (
      selectionChanged &&
      dmvList_('report').some(function (report) {
        return report.connectionId === previous.id;
      })
    )
      throw new Error('Create a new connection to change the account used by saved reports.');
    // New or changed credentials are checked with the provider before they are saved, so a bad
    // key fails here instead of at the first scheduled refresh. Label-only edits skip the check.
    var verified = changed && (typeof connector.test === 'function' || !!connector.googleScopes);
    if (verified) {
      try {
        var context = dmvContext_(
          connector,
          { credentials: credentials },
          { config: {}, fields: [], maxRows: 1 },
          {}
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
      credentials: credentials,
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
  var raw = dmvStore_().getProperty(dmvKey_('connection', connection.id));
  if (!raw) return;
  var saved = JSON.parse(raw);
  if ((saved.revision || 0) !== (connection.revision || 0)) return;
  var secrets = (dmvConnector_(saved.connectorId).authFields || [])
    .filter(function (field) {
      return field.secret || field.type === 'password';
    })
    .map(function (field) {
      return field.key;
    });
  var changed = false;
  Object.keys(patch).forEach(function (key) {
    if (secrets.indexOf(key) < 0 || typeof patch[key] !== 'string') return;
    saved.credentials[key] = patch[key];
    changed = true;
  });
  if (changed) dmvSave_('connection', saved);
}

function dmvDeleteConnection(id) {
  return dmvLocked_(function () {
    dmvRead_('connection', id);
    if (
      dmvList_('report').some(function (report) {
        return report.connectionId === id;
      })
    )
      throw new Error('Remove or update the reports using this connection first.');
    dmvStore_().deleteProperty(dmvKey_('connection', id));
    return { ok: true };
  });
}

function dmvTestConnection(id) {
  var connection = dmvRead_('connection', id);
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
