/* Small provider-neutral helpers shared by every connector. No Google services at load time. */

// Credential fields for Google APIs: native account, own OAuth client, token, or service account.
function dmvGoogleAuthFields_(serviceAccountHelp) {
  return [
    {
      key: 'authMode',
      label: 'Google authorization',
      type: 'select',
      default: 'native',
      options: [
        { value: 'native', label: 'Google account' },
        { value: 'oauth', label: 'OAuth client credentials' },
        { value: 'token', label: 'Access token' },
        { value: 'service_account', label: 'Service account' },
      ],
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
      required: false,
      showWhen: { key: 'authMode', value: 'token' },
      help: 'Paste an access token. Replace it when it expires.',
    },
    {
      key: 'serviceAccountJson',
      label: 'Service account JSON',
      type: 'textarea',
      secret: true,
      required: false,
      showWhen: { key: 'authMode', value: 'service_account' },
      help:
        serviceAccountHelp ||
        'Grant this service account access to the source account or property.',
    },
  ];
}

// Bearer token for Google APIs from the context; other providers read their own credentials.
function dmvBearer_(ctx) {
  var token =
    typeof ctx.accessToken === 'function' ? ctx.accessToken() : (ctx.credentials || {}).accessToken;
  if (!token) throw new Error('Connect a Google account, access token, or service account first.');
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
