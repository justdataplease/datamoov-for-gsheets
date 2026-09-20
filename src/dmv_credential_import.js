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

// Validate the entire package before any provider request or settings mutation.
function dmvImportPlan_(bundle) {
  dmvImportObject_(bundle, ['version', 'credentials', 'connections'], 'Credential import');
  var text;
  try {
    text = JSON.stringify(bundle);
  } catch (ignored) {
    throw new Error('Choose a valid credential import JSON file.');
  }
  if (text.length > 250000 || Utilities.newBlob(text).getBytes().length > 250000)
    throw new Error('The credential import must be at most 250,000 bytes.');
  if (
    bundle.version !== 1 ||
    !Array.isArray(bundle.credentials) ||
    !Array.isArray(bundle.connections)
  )
    throw new Error(
      'Choose a version 1 credential import with credentials and connections arrays.'
    );
  if (
    bundle.credentials.length > 20 ||
    bundle.connections.length > 20 ||
    !bundle.credentials.length
  )
    throw new Error('Import between 1 and 20 credentials and at most 20 connections at a time.');
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
  return { credentials: credentials, connections: connections };
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
  var resolved = Object.create(null);
  var response = {
    credentials: [],
    connections: [],
    summary: {
      credentials: { saved: 0, existing: 0, failed: 0 },
      connections: { saved: 0, existing: 0, failed: 0 },
    },
  };
  function record(kind, item, action) {
    var outcome = { ref: item.ref, label: item.label };
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
    var group = kind === 'credential' ? 'credentials' : 'connections';
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
      return outcome;
    });
  });
  return response;
}
