/* Small provider-neutral helpers shared by every connector. No Google services at load time. */

// Credential fields for Google APIs. The add-on never asks for Google API scopes of its own:
// the user brings a service-account key (default), an OAuth client with a refresh token, or a token.
function dmvGoogleAuthFields_(serviceAccountHelp) {
  return [
    {
      key: 'authMode',
      label: 'Google authorization',
      type: 'select',
      default: 'service_account',
      options: [
        { value: 'service_account', label: 'Service account key (JSON)' },
        { value: 'oauth', label: 'OAuth client credentials' },
        { value: 'token', label: 'Access token' },
      ],
    },
    {
      key: 'serviceAccountJson',
      label: 'Service account JSON',
      type: 'textarea',
      secret: true,
      required: true,
      showWhen: { key: 'authMode', value: 'service_account' },
      help:
        serviceAccountHelp ||
        'Paste the whole JSON key file. Grant this service account access to the source account or property.',
    },
    {
      key: 'clientId',
      label: 'OAuth client ID',
      type: 'text',
      required: true,
      showWhen: { key: 'authMode', value: 'oauth' },
      help: 'Use your own Google OAuth client. A client ID and secret alone do not grant account access.',
    },
    {
      key: 'clientSecret',
      label: 'OAuth client secret',
      type: 'password',
      secret: true,
      required: true,
      showWhen: { key: 'authMode', value: 'oauth' },
    },
    {
      key: 'refreshToken',
      label: 'OAuth refresh token',
      type: 'password',
      secret: true,
      required: true,
      showWhen: { key: 'authMode', value: 'oauth' },
      help: 'Supply a refresh token already granted for this client and the API you need. DataMoov obtains and refreshes access tokens automatically.',
    },
    {
      key: 'accessToken',
      label: 'Access token',
      type: 'password',
      required: true,
      showWhen: { key: 'authMode', value: 'token' },
      help: 'Paste an access token. It expires within an hour, so this suits one-off previews.',
    },
  ];
}

// Setup guide for a Google source: shared Cloud Console steps plus the product-specific grant.
// product: { apis, access, grant, scope, links: [{label, url}] }
function dmvGoogleGuide_(product) {
  return {
    intro:
      'Create the credential in Google Cloud Console, enable ' +
      product.apis +
      ' in that project, then give the credential access to ' +
      product.access +
      '.',
    modes: {
      service_account: {
        steps: [
          'Google Cloud Console → IAM & Admin → Service accounts → Create service account.',
          'Open the account → Keys → Add key → JSON. Download the file and paste its whole contents above.',
          'APIs & Services → Library: enable ' + product.apis + '.',
          product.grant,
        ],
      },
      oauth: {
        steps: [
          'Google Cloud Console → APIs & Services → Credentials → Create OAuth client (Web or Desktop).',
          'APIs & Services → Library: enable ' + product.apis + '.',
          'Authorize that client once for ' +
            product.scope +
            ' with offline access (the OAuth 2.0 Playground works with your own client) and copy the refresh token.',
          'The Google account that authorized must have access to ' + product.access + '.',
        ],
      },
      token: {
        steps: [
          'Paste an access token issued for ' +
            product.scope +
            ' (for example from the OAuth 2.0 Playground). It expires within an hour.',
        ],
      },
    },
    links: [
      {
        label: 'Service accounts',
        url: 'https://console.cloud.google.com/iam-admin/serviceaccounts',
      },
      { label: 'OAuth clients', url: 'https://console.cloud.google.com/apis/credentials' },
      { label: 'OAuth 2.0 Playground', url: 'https://developers.google.com/oauthplayground/' },
    ].concat(product.links || []),
  };
}

// A table-name search term safe to embed in an information_schema query: lower-case, no quotes.
function dmvTableSearch_(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_ .-]/g, '')
    .slice(0, 80);
}

// Group information_schema rows into {name, columns} tables, keeping column order.
function dmvGroupTables_(rows, nameOf) {
  var tables = [],
    byName = Object.create(null);
  rows.forEach(function (row) {
    var name = nameOf(row);
    if (!byName[name]) {
      byName[name] = { name: name, columns: [] };
      tables.push(byName[name]);
    }
    byName[name].columns.push({ name: String(row.column_name), type: String(row.data_type) });
  });
  return tables;
}

// One saved Google credential (service account, OAuth client or token) serves every Google
// source; each source adds its own account or property id per connection.
var DMV_GOOGLE_CREDENTIAL = {
  id: 'google',
  label: 'Google Cloud',
  fields: dmvGoogleAuthFields_(),
  guide: dmvGoogleGuide_({
    apis: 'the APIs of the Google sources you will connect (Google Ads API, Analytics Data and Admin APIs, BigQuery API, Search Console API)',
    access: 'each account or property you connect',
    scope:
      'the scopes of those sources (adwords, analytics.readonly, bigquery.readonly, webmasters.readonly)',
    grant:
      'Grant the service account email access in each product you connect: Google Ads → Admin → Access and security; Analytics → Property access management; BigQuery → IAM; Search Console → Users and permissions. Each source guide repeats its step.',
  }),
};

// Bearer token for Google APIs from the context; other providers read their own credentials.
function dmvBearer_(ctx) {
  var token =
    typeof ctx.accessToken === 'function' ? ctx.accessToken() : (ctx.credentials || {}).accessToken;
  if (!token) throw new Error('Add a service account key, OAuth client, or access token first.');
  return token;
}

// Field descriptor shorthand: dmvField_('clicks', 'Clicks', 'number', true, { role: 'metric' }).
function dmvField_(key, label, type, isDefault, extra) {
  return Object.assign({ key: key, label: label, type: type, default: !!isDefault }, extra || {});
}

// Resolve the user's selected keys (or the declared defaults) against the available descriptors.
function dmvSelectFields_(keys, available) {
  var selected = keys && keys.length ? keys : dmvDefaultFields_(available);
  if (!Array.isArray(selected) || !selected.length || selected.length > DMV_LIMITS.maxColumns)
    throw new Error('Choose between 1 and ' + DMV_LIMITS.maxColumns + ' fields.');
  var seen = {};
  return selected.map(function (key) {
    if (typeof key !== 'string' || seen[key]) throw new Error('Field selections must be unique.');
    seen[key] = true;
    var field = available.filter(function (item) {
      return item.key === key;
    })[0];
    if (!field)
      throw new Error('Unknown or unavailable report field: ' + String(key).slice(0, 100));
    return field;
  });
}

// True when a selection needs account-specific discovery before it can be resolved.
function dmvNeedsDiscovery_(keys, declared) {
  var known = declared.map(function (field) {
    return field.key;
  });
  return (keys || []).some(function (key) {
    return known.indexOf(key) < 0;
  });
}

// Provider metric text/number to a finite number; blanks become null, never zero.
function dmvNumber_(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean' || (typeof value !== 'number' && typeof value !== 'string'))
    throw new Error('The provider returned an invalid numeric metric.');
  var number = Number(value);
  if (!isFinite(number)) throw new Error('The provider returned a non-finite numeric metric.');
  return number;
}

// Provider dimension to text, preserving booleans and null.
function dmvTextValue_(value) {
  if (value === undefined || value === null) return null;
  return typeof value === 'boolean' ? value : String(value);
}

// Append one page while enforcing the report row budget; overflow fails, never truncates.
function dmvAppendPage_(rows, page, maxRows) {
  if (!Array.isArray(page)) throw new Error('The provider returned an invalid report page.');
  if (rows.length + page.length > maxRows)
    throw new Error(
      'This report exceeds the row limit. Choose a smaller date range or fewer dimensions.'
    );
  page.forEach(function (row) {
    rows.push(row);
  });
}

// Inclusive YYYY-MM-DD range to UTC epoch milliseconds [start, end).
function dmvUtcWindow_(ctx) {
  var start = Date.parse(String(ctx.startDate) + 'T00:00:00Z');
  var end = Date.parse(String(ctx.endDate) + 'T00:00:00Z') + 86400000;
  if (!isFinite(start) || !isFinite(end) || start >= end)
    throw new Error('Choose a valid date range.');
  return { start: start, end: end };
}

function dmvQueryString_(params) {
  return Object.keys(params)
    .map(function (key) {
      return encodeURIComponent(key) + '=' + encodeURIComponent(String(params[key]));
    })
    .join('&');
}

// A chunk is a complete provider page, not a complete report. Only the aggregate may be written.
function dmvMergeChunk_(previous, chunk, maxRows) {
  if (
    !chunk ||
    !chunk.metadata ||
    typeof chunk.metadata.complete !== 'boolean' ||
    chunk.nextState === undefined ||
    chunk.metadata.complete !== (chunk.nextState === null) ||
    chunk.truncated ||
    chunk.metadata.truncated
  )
    throw new Error('The connector returned an invalid continuation chunk.');
  var page = dmvNormalizeResult_({ columns: chunk.columns, rows: chunk.rows }, maxRows);
  if (previous && JSON.stringify(previous.columns) !== JSON.stringify(page.columns))
    throw new Error('The report columns changed during continuation. Run it again.');
  var rows = previous ? previous.rows.slice() : [];
  dmvAppendPage_(rows, page.rows, maxRows);
  var result = dmvNormalizeResult_(
    {
      columns: page.columns,
      rows: rows,
      metadata: Object.assign({}, chunk.metadata, { complete: true }),
    },
    maxRows
  );
  var pages = (previous ? previous.pages : 0) + 1;
  if (pages > 100) throw new Error('This report needs too many chunks. Narrow its scope.');
  return {
    columns: result.columns,
    rows: result.rows,
    metadata: chunk.metadata,
    state: chunk.nextState,
    pages: pages,
  };
}

// Previews and direct adapter calls exhaust all pages within the existing request/time budget.
function dmvFetchChunks_(ctx, fetchChunk) {
  var result = null;
  do {
    ctx.checkDeadline();
    result = dmvMergeChunk_(result, fetchChunk(ctx, result ? result.state : null), ctx.maxRows);
  } while (!result.metadata.complete);
  return { columns: result.columns, rows: result.rows, metadata: result.metadata };
}
