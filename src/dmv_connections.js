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

function dmvSaveConnection(input) {
  return dmvLocked_(function () {
    input = input || {};
    var connector = dmvConnector_(input.connectorId);
    var previous = input.id ? dmvRead_('connection', input.id) : null;
    if (previous && previous.connectorId !== input.connectorId)
      throw new Error('Create a separate connection for a different source.');
    if (!previous && dmvList_('connection').length >= DMV_LIMITS.maxConnections)
      throw new Error('Keep at most ' + DMV_LIMITS.maxConnections + ' connections in this app.');
    var credentials = {};
    (connector.authFields || []).forEach(function (field) {
      var value = (input.credentials || {})[field.key];
      var secret = field.secret || field.type === 'password' || field.key === 'serviceAccountJson';
      if (secret && (value === '' || value === undefined) && previous)
        value = previous.credentials[field.key];
      if (value !== undefined) credentials[field.key] = value;
    });
    credentials = dmvFieldsInput_(connector.authFields, credentials);
    if (connector.googleScopes) {
      var mode = credentials.authMode || 'native';
      if (mode === 'token' && !credentials.accessToken)
        throw new Error('Paste a Google access token.');
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
    var connection = {
      id: previous ? previous.id : dmvId_(),
      label: dmvText_(input.label, 'Connection name', 80, true),
      connectorId: connector.id,
      credentials: credentials,
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
