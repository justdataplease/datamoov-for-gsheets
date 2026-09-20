/* Saved credentials: one secret bundle (a Google service-account key, an OAuth client, an API
   token) reused by any number of connections. Private to the Google user who saved it. */

// A connector's auth fields split in two: the credential part, shared between connections, and
// the per-connection part (account ids, chat scope) flagged with perConnection.
function dmvCredentialFields_(connector) {
  return (connector.authFields || []).filter(function (field) {
    return !field.perConnection;
  });
}

function dmvConnectionFields_(connector) {
  return (connector.authFields || []).filter(function (field) {
    return !!field.perConnection;
  });
}

function dmvFamilyId_(connector) {
  return connector.credentialFamily ? connector.credentialFamily.id : connector.id;
}

// Credential types: one per shared family (Google) or one per connector.
function dmvCredentialFamilies_() {
  var families = Object.create(null);
  Object.keys(DMV_CONNECTORS || {}).forEach(function (id) {
    var connector = DMV_CONNECTORS[id];
    var fields = dmvCredentialFields_(connector);
    if (!fields.length) return;
    var familyId = dmvFamilyId_(connector);
    var family = families[familyId];
    if (!family) {
      var shared = connector.credentialFamily;
      family = families[familyId] = {
        id: familyId,
        label: shared ? shared.label : connector.label,
        fields: shared && shared.fields ? shared.fields.slice() : fields,
        guide: (shared ? shared.guide : connector.guide) || null,
        connectors: [],
        scopes: [],
        google: !!connector.googleScopes,
      };
    }
    fields.forEach(function (field) {
      if (
        !family.fields.some(function (item) {
          return item.key === field.key;
        })
      )
        family.fields.push(field);
    });
    family.connectors.push(id);
    (connector.googleScopes || []).forEach(function (scope) {
      if (family.scopes.indexOf(scope) < 0) family.scopes.push(scope);
    });
  });
  return families;
}

function dmvCredentialFamily_(id) {
  var family = dmvCredentialFamilies_()[String(id || '')];
  if (!family) throw new Error('Choose a supported credential type.');
  return family;
}

// What the sidebar needs to build the Credentials tab and the connection form's dropdown.
function dmvFamilyCatalog_() {
  var families = dmvCredentialFamilies_();
  return JSON.parse(
    JSON.stringify(
      Object.keys(families)
        .map(function (id) {
          var family = families[id];
          return {
            id: family.id,
            label: family.label,
            fields: family.fields,
            guide: family.guide,
            connectors: family.connectors.slice().sort(),
          };
        })
        .sort(function (a, b) {
          return a.label.localeCompare(b.label);
        })
    )
  );
}

function dmvSecretKeys_(fields) {
  return fields
    .filter(function (field) {
      return field.secret || field.type === 'password' || field.key === 'serviceAccountJson';
    })
    .map(function (field) {
      return field.key;
    });
}

// Blank secrets keep their saved value; everything else is taken from the input.
function dmvMergeSecrets_(fields, input, previous) {
  var secrets = dmvSecretKeys_(fields);
  var values = {};
  fields.forEach(function (field) {
    var value = (input || {})[field.key];
    if (secrets.indexOf(field.key) >= 0 && (value === '' || value === undefined) && previous)
      value = previous[field.key];
    if (value !== undefined) values[field.key] = value;
  });
  return values;
}

function dmvCredentialSummary_(credential, connections) {
  var family = dmvCredentialFamilies_()[credential.family];
  var fields = family ? family.fields : [];
  var secrets = dmvSecretKeys_(fields);
  var values = {},
    configured = [];
  fields.forEach(function (field) {
    var value = credential.values[field.key];
    if (value !== undefined && value !== '') configured.push(field.key);
    if (secrets.indexOf(field.key) < 0) values[field.key] = value;
  });
  return {
    id: credential.id,
    label: credential.label,
    family: credential.family,
    familyLabel: family ? family.label : credential.family,
    values: values,
    configuredFields: configured,
    usedBy: (connections || []).filter(function (connection) {
      return connection.credentialId === credential.id;
    }).length,
  };
}

function dmvCredentialSummaries_() {
  var connections = dmvList_('connection');
  return dmvList_('credential')
    .map(function (credential) {
      return dmvCredentialSummary_(credential, connections);
    })
    .sort(function (a, b) {
      return a.label.localeCompare(b.label);
    });
}

function dmvSaveCredential(input) {
  return dmvLocked_(function () {
    input = input || {};
    var family = dmvCredentialFamily_(input.family);
    var previous = input.id ? dmvRead_('credential', input.id) : null;
    if (previous && previous.family !== family.id)
      throw new Error('A credential keeps its type. Add a new one for another type.');
    if (!previous && dmvList_('credential').length >= DMV_LIMITS.maxCredentials)
      throw new Error('Keep at most ' + DMV_LIMITS.maxCredentials + ' credentials in this app.');
    var values = dmvFieldsInput_(
      family.fields,
      dmvMergeSecrets_(family.fields, input.values, previous ? previous.values : null)
    );
    family.fields.forEach(function (field) {
      if (String(values[field.key] || '').length > 12000)
        throw new Error(field.label + ' is too long.');
    });
    var changed =
      !previous ||
      family.fields.some(function (field) {
        return values[field.key] !== previous.values[field.key];
      });
    // A Google key or OAuth client can be checked on its own by minting one token with the
    // family's scopes; account access is checked later, when a connection is saved.
    var verified = false;
    if (changed && family.google && values.authMode !== 'token') {
      try {
        dmvGoogleToken_(values, family.scopes, Date.now() + 60000);
        verified = true;
      } catch (error) {
        throw new Error(dmvSafeError_(error, values));
      }
    }
    var credential = {
      id: previous ? previous.id : dmvId_(),
      label: dmvText_(input.label, 'Credential name', 80, true),
      family: family.id,
      values: values,
      revision: previous ? (previous.revision || 0) + 1 : 1,
    };
    dmvSave_('credential', credential);
    var summary = dmvCredentialSummary_(credential, dmvList_('connection'));
    summary.verified = verified;
    return summary;
  });
}

function dmvDeleteCredential(id) {
  return dmvLocked_(function () {
    dmvRead_('credential', id);
    var users = dmvList_('connection').filter(function (connection) {
      return connection.credentialId === id;
    });
    if (users.length)
      throw new Error(
        'This credential is used by ' +
          users
            .map(function (connection) {
              return connection.label;
            })
            .join(', ') +
          '. Point those connections at another credential first.'
      );
    dmvStore_().deleteProperty(dmvKey_('credential', id));
    return { ok: true };
  });
}

// The complete credential set of a connection: its saved credential's values (when it uses one)
// under its own per-connection values. Records the credential revision for rotation checks.
function dmvConnectionValues_(connection) {
  var values = {};
  if (connection.credentialId) {
    var credential = dmvRead_('credential', connection.credentialId);
    Object.keys(credential.values).forEach(function (key) {
      values[key] = credential.values[key];
    });
    connection.credentialRevision = credential.revision || 0;
  }
  Object.keys(connection.credentials || {}).forEach(function (key) {
    values[key] = connection.credentials[key];
  });
  return values;
}

// A saved connection with its credential merged in, ready for a connector context.
function dmvReadConnection_(id) {
  var connection = dmvRead_('connection', id);
  connection.credentials = dmvConnectionValues_(connection);
  return connection;
}
