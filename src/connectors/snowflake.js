/* Snowflake SQL API. Use a role limited to warehouse/schema USAGE and table/view SELECT. */
var DMV_SNOWFLAKE = { maxPolls: 45, maxPartitions: 50, timeoutSeconds: 45, describeLimit: 3000 };

function dmvSnowflakeHost_(credentials) {
  var host = String(credentials.account || '')
    .trim()
    .toLowerCase();
  if (!host.endsWith('.snowflakecomputing.com')) host += '.snowflakecomputing.com';
  var account = host.slice(0, -'.snowflakecomputing.com'.length);
  if (
    !account ||
    host.length > 253 ||
    account.split('.').some(function (label) {
      return !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label);
    })
  )
    throw new Error(
      'Enter a Snowflake account identifier or snowflakecomputing.com hostname, without a URL, path or port.'
    );
  return host;
}

function dmvSnowflakeConfig_(credentials) {
  var mode = credentials.authMode || 'pat';
  if (['pat', 'oauth'].indexOf(mode) < 0)
    throw new Error('Choose a supported Snowflake token type.');
  var token = String(credentials.token || '').trim();
  if (!token || token.length > 12000 || /[\s\u0000-\u001f\u007f]/.test(token))
    throw new Error('Enter a Snowflake programmatic access token or OAuth access token.');
  var config = {
    base: 'https://' + dmvSnowflakeHost_(credentials) + '/api/v2/statements',
    headers: {
      Authorization: 'Bearer ' + token,
      'X-Snowflake-Authorization-Token-Type':
        mode === 'pat' ? 'PROGRAMMATIC_ACCESS_TOKEN' : 'OAUTH',
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'DataMoov/1.0',
    },
    context: {},
  };
  ['warehouse', 'database', 'schema', 'role'].forEach(function (key) {
    var value = String(credentials[key] || '').trim();
    if ((!value && key === 'role') || value.length > 255 || /[\u0000-\u001f\u007f]/.test(value))
      throw new Error('Enter a valid Snowflake ' + key + ' name. Use a dedicated read-only role.');
    if (value) config.context[key] = value;
  });
  return config;
}

function dmvSnowflakeError_(status, body) {
  var code = body && /^\d{6}$/.test(String(body.code || '')) ? ' (code ' + body.code + ')' : '';
  if (body && String(body.code) === '390432')
    return (
      'Snowflake requires an active network policy for this programmatic access token' +
      code +
      '. Ask your Snowflake administrator to apply a network policy that permits the environment running DataMoov. Deployed runs originate from Google Apps Script.'
    );
  if (body && String(body.code) === '390509')
    return (
      'Snowflake rejected the request identifier' +
      code +
      '. Try the connection or report again. If this persists, update DataMoov so it supplies a valid request UUID.'
    );
  if (status === 401 || status === 403)
    return (
      'Snowflake rejected access' +
      code +
      '. Check the token, account, role, token expiry, and network/authentication policies for Apps Script requests.'
    );
  if (status === 408)
    return 'Snowflake exceeded the 45-second statement timeout. Narrow or aggregate the query.';
  if (status === 422 || status === 400)
    return (
      'Snowflake could not execute the query' +
      code +
      '. Check SELECT syntax, database/schema names, warehouse availability and the role grants.'
    );
  return '';
}

function dmvSnowflakeHandle_(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value))
    throw new Error('Snowflake returned an invalid statement handle.');
  return value;
}

// Later SQL API partitions can be gzip or already decompressed by the transport.
// Decode locally; never follow returned statementStatusUrl or Link URLs.
function dmvSnowflakePartition_(blob) {
  var bytes = blob.getBytes();
  if (bytes.length >= 2 && (bytes[0] & 255) === 31 && (bytes[1] & 255) === 139) {
    if (bytes.length < 18) throw new Error('Snowflake returned a damaged compressed partition.');
    var expected = 0;
    for (var i = 0; i < 4; i++) expected += (bytes[bytes.length - 4 + i] & 255) * Math.pow(256, i);
    if (expected > DMV_LIMITS.maxBytes)
      throw new Error('The Snowflake result is too large. Select fewer columns or rows.');
    try {
      blob = Utilities.ungzip(blob);
    } catch (error) {
      throw new Error('Snowflake returned an unreadable compressed partition.');
    }
  }
  var text = blob.getDataAsString();
  if (text.length > DMV_LIMITS.maxBytes || blob.getBytes().length > DMV_LIMITS.maxBytes)
    throw new Error('The Snowflake result is too large. Select fewer columns or rows.');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error('Snowflake returned an unreadable result partition.');
  }
}

function dmvSnowflakeRequest_(ctx, config, suffix, body, partition) {
  ctx.checkDeadline();
  var request = { url: config.base + suffix, headers: config.headers };
  if (body !== undefined) {
    request.method = 'post';
    request.body = body;
    // Even SELECT can incur compute charges; do not retry an ambiguous submission.
    request.retrySafe = false;
  }
  if (partition) request.responseType = 'blob';
  var response = ctx.http(request);
  if (partition) response = dmvSnowflakePartition_(response);
  if (!response || typeof response !== 'object')
    throw new Error('Snowflake returned an invalid statement response.');
  return response;
}

function dmvSnowflakeFields_(rowType) {
  if (!Array.isArray(rowType) || !rowType.length || rowType.length > DMV_LIMITS.maxColumns)
    throw new Error('Select between 1 and ' + DMV_LIMITS.maxColumns + ' Snowflake result columns.');
  var seen = Object.create(null);
  return rowType.map(function (field, index) {
    var key = field && field.name;
    if (
      typeof key !== 'string' ||
      !key ||
      key.length > 150 ||
      seen[key] ||
      ['__proto__', 'prototype', 'constructor'].indexOf(key) >= 0 ||
      typeof field.type !== 'string'
    )
      throw new Error(
        'Give each Snowflake result column a unique, ordinary alias of at most 150 characters.'
      );
    seen[key] = true;
    var nativeType = field.type.toLowerCase();
    // Sheets preserves only about 15 decimal digits. Exact decimal / large integer values stay text.
    var smallInteger =
      nativeType === 'fixed' &&
      field.scale === 0 &&
      Number.isInteger(field.precision) &&
      field.precision > 0 &&
      field.precision <= 15;
    var numeric = smallInteger || /^(real|float|double)$/.test(nativeType);
    return {
      key: key,
      label: key,
      type: numeric ? 'number' : nativeType === 'date' ? 'date' : 'text',
      nativeType: nativeType,
      smallInteger: smallInteger,
      columnIndex: index,
      role: numeric ? 'metric' : 'dimension',
      default: true,
    };
  });
}

function dmvSnowflakeValue_(column, value) {
  if (value === null) return null;
  // The SQL API's JSON format represents non-null scalar values as strings.
  if (typeof value !== 'string') throw new Error('Snowflake returned an unexpected result value.');
  if (column.type === 'number') {
    if (!value.trim()) throw new Error('Snowflake returned an empty numeric value.');
    var number = Number(value);
    if (!Number.isFinite(number) || (column.smallInteger && !Number.isSafeInteger(number)))
      throw new Error('Snowflake returned a numeric value outside the supported range.');
    return number;
  }
  if (column.nativeType === 'boolean') {
    if (value !== 'true' && value !== 'false')
      throw new Error('Snowflake returned an invalid boolean value.');
    return value === 'true';
  }
  return value;
}

function dmvSnowflakeQuery_(ctx, discoverOnly) {
  var config = dmvSnowflakeConfig_(ctx.credentials);
  var sql = dmvReadOnlySql_(ctx.config.query, { hashComments: false });
  var maximum = dmvInteger_(ctx.maxRows, 1, DMV_LIMITS.maxRows, 'Row limit');
  var body = Object.assign({}, config.context, {
    statement:
      'SELECT * FROM (\n' +
      sql +
      '\n) AS datamoov_report LIMIT ' +
      (discoverOnly ? 0 : maximum + 1),
    timeout: DMV_SNOWFLAKE.timeoutSeconds,
    parameters: {
      multi_statement_count: '1',
      // Override a user/account result cap so it cannot silently truncate a report.
      rows_per_resultset: 0,
      client_result_chunk_size: 16,
      date_output_format: 'YYYY-MM-DD',
      time_output_format: 'HH24:MI:SS.FF9',
      timestamp_ntz_output_format: 'YYYY-MM-DD"T"HH24:MI:SS.FF9',
      timestamp_ltz_output_format: 'YYYY-MM-DD"T"HH24:MI:SS.FF9TZH:TZM',
      timestamp_tz_output_format: 'YYYY-MM-DD"T"HH24:MI:SS.FF9TZH:TZM',
      timezone: 'UTC',
    },
  });
  var response = dmvSnowflakeRequest_(
    ctx,
    config,
    '?async=true&requestId=' + encodeURIComponent(dmvId_()),
    body
  );
  var handle = dmvSnowflakeHandle_(response.statementHandle);
  var pending = response.code === '333334';
  var polls = 0;
  try {
    while (pending) {
      if (polls++ >= DMV_SNOWFLAKE.maxPolls)
        throw new Error(
          'Snowflake is still running after the polling limit. Narrow the query and try again.'
        );
      ctx.checkDeadline();
      Utilities.sleep(1000);
      response = dmvSnowflakeRequest_(ctx, config, '/' + handle);
      if (response.statementHandle !== handle)
        throw new Error('Snowflake changed the statement handle while fetching the report.');
      pending = response.code === '333334';
    }
  } catch (error) {
    if (pending && Date.now() < ctx.deadline - 12000) {
      try {
        dmvSnowflakeRequest_(ctx, config, '/' + handle + '/cancel', {});
      } catch (ignored) {
        /* The server-side timeout still bounds this statement. */
      }
    }
    throw error;
  }
  var metadata = response.resultSetMetaData;
  if (
    response.code !== '090001' ||
    response.sqlState !== '00000' ||
    response.statementHandles ||
    !metadata ||
    metadata.format !== 'jsonv2' ||
    !Number.isSafeInteger(metadata.numRows) ||
    metadata.numRows < 0
  )
    throw new Error('Snowflake did not return a complete single-statement result.');
  if (metadata.numRows > (discoverOnly ? 0 : maximum))
    throw new Error(
      'The SQL result exceeds the row limit. Add filters, aggregation, or a deliberate LIMIT.'
    );
  var available = dmvSnowflakeFields_(metadata.rowType);
  var columns = discoverOnly ? available : dmvSelectFields_(ctx.fields, available);
  var partitions = metadata.partitionInfo;
  if (
    !Array.isArray(partitions) ||
    partitions.length > DMV_SNOWFLAKE.maxPartitions ||
    (!partitions.length && metadata.numRows !== 0)
  )
    throw new Error('Snowflake returned missing or excessive result partitions. Narrow the query.');
  var totalRows = 0,
    totalBytes = 0;
  partitions.forEach(function (part) {
    if (
      !part ||
      !Number.isSafeInteger(part.rowCount) ||
      part.rowCount < 0 ||
      !Number.isSafeInteger(part.uncompressedSize) ||
      part.uncompressedSize < 0 ||
      (part.compressedSize !== undefined &&
        (!Number.isSafeInteger(part.compressedSize) || part.compressedSize < 0))
    )
      throw new Error('Snowflake returned invalid partition metadata.');
    totalRows += part.rowCount;
    totalBytes += part.uncompressedSize;
  });
  if (totalRows !== metadata.numRows)
    throw new Error('Snowflake returned inconsistent partition row counts.');
  if (totalBytes > DMV_LIMITS.maxBytes)
    throw new Error('The Snowflake result is too large. Select fewer columns or rows.');
  var rows = [],
    fetchedBytes = 0;
  function append(data, expected) {
    if (!Array.isArray(data) || data.length !== expected)
      throw new Error('Snowflake returned an incomplete result partition.');
    data.forEach(function (values) {
      ctx.checkDeadline();
      if (!Array.isArray(values) || values.length !== available.length)
        throw new Error('Snowflake returned a result row that does not match its schema.');
      var row = Object.create(null);
      columns.forEach(function (column) {
        row[column.key] = dmvSnowflakeValue_(column, values[column.columnIndex]);
      });
      fetchedBytes += JSON.stringify(row).length;
      if (fetchedBytes > DMV_LIMITS.maxBytes)
        throw new Error('The Snowflake result is too large. Select fewer columns or rows.');
      rows.push(row);
    });
  }
  append(response.data, partitions.length ? partitions[0].rowCount : 0);
  for (var index = 1; index < partitions.length; index++) {
    var page = dmvSnowflakeRequest_(
      ctx,
      config,
      '/' + handle + '?partition=' + index,
      undefined,
      true
    );
    if (!Array.isArray(page)) {
      if (
        (page.statementHandle && page.statementHandle !== handle) ||
        page.statementHandles ||
        (page.code !== undefined && page.code !== '090001') ||
        (page.sqlState !== undefined && page.sqlState !== '00000')
      )
        throw new Error('Snowflake returned an unsuccessful result partition.');
      if (
        page.resultSetMetaData &&
        (page.resultSetMetaData.numRows !== metadata.numRows ||
          JSON.stringify(page.resultSetMetaData.rowType) !== JSON.stringify(metadata.rowType) ||
          (page.resultSetMetaData.partition !== undefined &&
            page.resultSetMetaData.partition !== index))
      )
        throw new Error('The Snowflake result schema changed between partitions.');
    }
    append(Array.isArray(page) ? page : page.data, partitions[index].rowCount);
  }
  if (rows.length !== metadata.numRows)
    throw new Error('Snowflake returned an incomplete query result.');
  if (discoverOnly) return available;
  return {
    columns: columns,
    rows: rows,
    metadata: {
      complete: true,
      mode: 'Read-only SQL',
      note: 'Exact decimals and integer columns wider than 15 digits are exported as text. Timestamps retain up to 9 fractional digits.',
    },
  };
}

function dmvSnowflakeTables_(ctx, options) {
  var config = dmvSnowflakeConfig_(ctx.credentials);
  if (!config.context.database || !config.context.schema)
    throw new Error(
      'Set an explicit database and schema on this Snowflake connection before using chat table discovery.'
    );
  var database = config.context.database;
  var schema = config.context.schema;
  var search = dmvTableSearch_((options || {}).search);
  var query =
    'SELECT table_schema AS "table_schema", table_name AS "table_name", ' +
    'column_name AS "column_name", data_type AS "data_type" FROM "' +
    database.replace(/"/g, '""') +
    '".INFORMATION_SCHEMA.COLUMNS WHERE table_schema = \'' +
    schema.replace(/'/g, "''") +
    "'" +
    (search ? " AND POSITION('" + search + "' IN LOWER(table_name)) > 0" : '') +
    ' ORDER BY table_schema, table_name, ordinal_position LIMIT ' +
    DMV_SNOWFLAKE.describeLimit;
  var result = dmvSnowflakeQuery_(
    Object.assign({}, ctx, {
      config: { query: query },
      fields: [],
      maxRows: DMV_SNOWFLAKE.describeLimit,
    }),
    false
  );
  return {
    scope: 'database ' + database + ', schema ' + schema,
    tables: dmvGroupTables_(result.rows, function (row) {
      return database + '.' + row.table_schema + '.' + row.table_name;
    }),
    truncated: result.rows.length >= DMV_SNOWFLAKE.describeLimit,
  };
}

dmvRegisterConnector_({
  id: 'snowflake',
  label: 'Snowflake',
  description: 'Read-only SQL reports from your Snowflake account.',
  category: 'Databases',
  color: '#29b5e8',
  icon: {
    viewBox: '0 0 146.36 139.16',
    shapes: [
      {
        d: 'M134.81,60.1l-16.47,9.49L134.81,79a8.65,8.65,0,1,1-8.67,15l-29.51-17a8.68,8.68,0,0,1-4.33-7.75,8.48,8.48,0,0,1,.31-2,8.68,8.68,0,0,1,4-5.19l29.51-16.94A8.69,8.69,0,0,1,138,48.31,8.58,8.58,0,0,1,134.81,60.1Zm-15.59,46L89.72,89.13a8.72,8.72,0,0,0-13.06,7.48v33.9a8.69,8.69,0,0,0,17.37,0v-19L110.54,121a8.66,8.66,0,1,0,8.68-15Zm-34-33.16L72.92,85.09a2.44,2.44,0,0,1-1.54.65H67.77a2.51,2.51,0,0,1-1.54-.65L54,72.9a2.45,2.45,0,0,1-.64-1.52v-3.6A2.5,2.5,0,0,1,54,66.25L66.23,54.06a2.5,2.5,0,0,1,1.54-.64h3.61a2.45,2.45,0,0,1,1.54.64L85.18,66.25a2.49,2.49,0,0,1,.63,1.53v3.6A2.44,2.44,0,0,1,85.18,72.9Zm-9.8-3.38A2.59,2.59,0,0,0,74.73,68l-3.55-3.51a2.51,2.51,0,0,0-1.54-.64h-.13a2.46,2.46,0,0,0-1.53.64L64.43,68a2.51,2.51,0,0,0-.63,1.55v.13a2.41,2.41,0,0,0,.63,1.52L68,74.7a2.48,2.48,0,0,0,1.53.64h.13a2.51,2.51,0,0,0,1.54-.64l3.55-3.53a2.49,2.49,0,0,0,.65-1.52ZM19.93,33.08,49.44,50a8.73,8.73,0,0,0,13.07-7.49V8.64a8.69,8.69,0,0,0-17.37,0v19l-16.53-9.5a8.65,8.65,0,1,0-8.68,15ZM84.69,51.16a8.64,8.64,0,0,0,5-1.13l29.5-17a8.65,8.65,0,1,0-8.68-15L94,27.61v-19a8.69,8.69,0,0,0-17.37,0v33.9A8.66,8.66,0,0,0,84.69,51.16ZM54.48,88a8.58,8.58,0,0,0-5,1.13L19.93,106.06a8.66,8.66,0,1,0,8.68,15l16.53-9.49v19a8.69,8.69,0,0,0,17.37,0V96.61A8.65,8.65,0,0,0,54.48,88Zm-8-15.87a8.61,8.61,0,0,0-4-10L13,45.14A8.69,8.69,0,0,0,1.17,48.31,8.59,8.59,0,0,0,4.35,60.1l16.47,9.49L4.35,79A8.65,8.65,0,1,0,13,94l29.48-17A8.59,8.59,0,0,0,46.47,72.13Zm93.15-56.22H138.3v1.63h1.32c.61,0,1-.28,1-.8S140.26,15.91,139.62,15.91Zm-2.94-1.5h3c1.62,0,2.7.89,2.7,2.27a2.16,2.16,0,0,1-1.08,1.9l1.17,1.68v.34h-1.69L139.62,19H138.3V20.6h-1.62Zm8.3,3.22a5.48,5.48,0,0,0-5.58-5.83c-3.31,0-5.51,2.39-5.51,5.83,0,3.28,2.2,5.82,5.51,5.82A5.47,5.47,0,0,0,145,17.63Zm1.38,0c0,3.89-2.6,7.14-7,7.14s-6.89-3.28-6.89-7.14,2.57-7.14,6.89-7.14S146.36,13.73,146.36,17.63Z',
        fill: '#29b5e8',
      },
    ],
  },
  allowedHosts: function (credentials) {
    return [dmvSnowflakeHost_(credentials)];
  },
  connectionKeys: ['account', 'database', 'schema', 'role', 'warehouse'],
  errorMessage: dmvSnowflakeError_,
  guide: {
    intro:
      'Connect directly to your Snowflake SQL API with a programmatic access token or a pasted OAuth access token. No password or Google provider scope is used.',
    steps: [
      'Create a dedicated role with USAGE on the warehouse, database and schema, and SELECT on only the tables or views needed by reports. The SQL guard is not a substitute for read-only Snowflake grants.',
      'Find your account identifier or SQL API hostname, for example myorg-myaccount.snowflakecomputing.com. Enter names exactly as stored in Snowflake, usually uppercase.',
      'Allow Apps Script outbound requests in the Snowflake network and authentication policies that apply to this user and token.',
      'Enter the role and, when needed, warehouse, database and schema. Empty warehouse/database/schema fields use the Snowflake user defaults. Set an explicit database and schema for chat table discovery.',
      'Save the connection to run SELECT 1. Preview your report to verify warehouse and table access. Snowflake compute charges and token expiry still apply.',
    ],
    modes: {
      pat: {
        steps: [
          'In Snowsight, open your user profile and Programmatic access tokens, then generate a token restricted to the read-only role. Your administrator must allow programmatic access tokens.',
          'Copy the token when it is shown and paste it into the token field. Rotate it here before it expires; DataMoov does not renew programmatic access tokens.',
        ],
      },
      oauth: {
        steps: [
          'Use your own Snowflake OAuth or External OAuth integration to obtain an access token authorized for the chosen role.',
          'Paste the access token. This mode does not obtain or refresh OAuth tokens; replace the token when it expires.',
        ],
      },
    },
    links: [
      {
        label: 'Snowflake SQL API authentication',
        url: 'https://docs.snowflake.com/en/developer-guide/sql-api/authenticating',
      },
      {
        label: 'Programmatic access tokens',
        url: 'https://docs.snowflake.com/en/user-guide/programmatic-access-tokens',
      },
      {
        label: 'Snowflake account identifiers',
        url: 'https://docs.snowflake.com/en/user-guide/admin-account-identifier',
      },
      {
        label: 'SQL API reference',
        url: 'https://docs.snowflake.com/en/developer-guide/sql-api/reference',
      },
    ],
  },
  authFields: [
    {
      key: 'authMode',
      label: 'Snowflake authorization',
      type: 'select',
      default: 'pat',
      options: [
        { value: 'pat', label: 'Programmatic access token' },
        { value: 'oauth', label: 'OAuth access token' },
      ],
    },
    {
      key: 'token',
      label: 'Access token',
      type: 'password',
      secret: true,
      required: true,
      help: 'Use a token for a dedicated read-only role. Tokens are stored privately; replace them before expiry.',
    },
    {
      key: 'account',
      label: 'Account identifier or hostname',
      type: 'text',
      required: true,
      perConnection: true,
      help: 'For example myorg-myaccount or myorg-myaccount.snowflakecomputing.com. No URL or port.',
    },
    {
      key: 'role',
      label: 'Read-only role',
      type: 'text',
      required: true,
      perConnection: true,
      help: 'Exact role name, usually uppercase. The token must permit this role.',
    },
    {
      key: 'warehouse',
      label: 'Warehouse',
      type: 'text',
      perConnection: true,
      help: 'Exact warehouse name; leave empty to use the Snowflake user default.',
    },
    {
      key: 'database',
      label: 'Database',
      type: 'text',
      perConnection: true,
      help: 'Exact database name. Required for chat table discovery; otherwise the user default applies.',
    },
    {
      key: 'schema',
      label: 'Schema',
      type: 'text',
      perConnection: true,
      help: 'Exact schema name. Chat discovers only this schema; otherwise the user default applies.',
    },
  ],
  describeTables: dmvSnowflakeTables_,
  test: function (ctx) {
    var result = dmvSnowflakeQuery_(
      Object.assign({}, ctx, {
        config: { query: 'SELECT 1 AS DATAMOOV_CONNECTION_OK' },
        fields: [],
        maxRows: 1,
      }),
      false
    );
    if (result.rows.length !== 1 || String(result.rows[0].DATAMOOV_CONNECTION_OK) !== '1')
      throw new Error('Snowflake did not return the expected connection check.');
  },
  reports: [
    {
      id: 'sql_report',
      label: 'SQL report',
      description:
        'One SELECT or WITH query, with complete result partitions and a 45-second statement limit.',
      dateRange: false,
      fields: [],
      configFields: [
        {
          key: 'query',
          label: 'Read-only SQL',
          type: 'textarea',
          required: true,
          help: 'One SELECT or WITH query. Filter or aggregate before importing. Exact decimals and large integers remain text.',
        },
      ],
      fetch: function (ctx) {
        return dmvSnowflakeQuery_(ctx, false);
      },
      discoverFields: function (ctx) {
        return dmvSnowflakeQuery_(ctx, true);
      },
    },
  ],
});
