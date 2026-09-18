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
    var credentials = dmvConnectionCredentials_(connector, input, previous);
    credentials = dmvFieldsInput_(connector.authFields, credentials);
    if (connector.googleScopes) {
      var mode = credentials.authMode || 'native';
      if (mode === 'token' && !credentials.accessToken)
        throw new Error('Paste a Google access token.');
      if (mode === 'oauth') {
        ['clientId', 'clientSecret', 'refreshToken'].forEach(function (key) {
          var label = {
            clientId: 'OAuth client ID',
            clientSecret: 'OAuth client secret',
            refreshToken: 'OAuth refresh token',
          }[key];
          if (typeof credentials[key] !== 'string') throw new Error(label + ' is required.');
          credentials[key] = dmvText_(
            credentials[key],
            label,
            key === 'clientId' ? 500 : 12000,
            true
          );
        });
      }
      if (mode === 'service_account') {
        var account;
        try {
          account = JSON.parse(credentials.serviceAccountJson || '');
        } catch (error) {
          throw new Error('Paste valid service-account JSON.');
        }
        if (account.type !== 'service_account' || !account.private_key || !account.client_email)
          throw new Error('The service-account key is incomplete.');
      }
    }
    var selectionKeys = dmvAccountSelectionKeys_(connector);
    var selectionChanged =
      previous &&
      selectionKeys.some(function (key) {
        return String(previous.credentials[key] || '') !== String(credentials[key] || '');
      });
    if (
      selectionChanged &&
      dmvList_('report').some(function (report) {
        return report.connectionId === previous.id;
      })
    )
      throw new Error('Create a new connection to change the account used by saved reports.');
    var verifyNativeSelection =
      connector.accountDiscovery &&
      dmvVisible_(connector.accountDiscovery, credentials) &&
      (!previous ||
        selectionChanged ||
        !dmvVisible_(connector.accountDiscovery, previous.credentials));
    var verifyOwnOAuth =
      connector.googleScopes &&
      credentials.authMode === 'oauth' &&
      (!previous ||
        (connector.authFields || []).some(function (field) {
          return (
            dmvVisible_(field, credentials) &&
            credentials[field.key] !== previous.credentials[field.key]
          );
        }));
    if (verifyNativeSelection || verifyOwnOAuth) {
      if (verifyNativeSelection && typeof connector.test !== 'function')
        throw new Error('Account verification is unavailable.');
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
    return dmvConnectionSummary_(connection);
  });
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
