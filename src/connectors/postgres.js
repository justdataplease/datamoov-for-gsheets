/* Native Apps Script JDBC; use a dedicated read-only PostgreSQL role. */
function dmvPostgresSql_(sql) {
  sql = String(sql || '').trim();
  if (!sql || sql.length > 6000)
    throw new Error('Enter a read-only SELECT query of at most 6,000 characters.');
  // PostgreSQL uses #, #> and #>> as operators, never as line comments.
  // The shared grammar is a conservative guard; the database read-only transaction remains mandatory.
  return dmvReadOnlySql_(sql, { hashComments: false });
}

function dmvPostgresConnection_(credentials) {
  var host = String(credentials.host || '').trim();
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host))
    throw new Error('Enter a PostgreSQL hostname without a URL or port.');
  var port = Number(credentials.port || 5432);
  if (!Number.isInteger(port) || port < 1025 || port > 65535)
    throw new Error('PostgreSQL needs a port between 1025 and 65535.');
  var database = String(credentials.database || '').trim();
  if (!database || !credentials.username || !credentials.password)
    throw new Error('Enter the database name, username and password.');
  var url =
    'jdbc:postgresql://' +
    host +
    ':' +
    port +
    '/' +
    encodeURIComponent(database) +
    '?sslmode=verify-full&connectTimeout=15&socketTimeout=40';
  try {
    var connection = Jdbc.getConnection(
      url,
      String(credentials.username),
      String(credentials.password)
    );
    connection.setReadOnly(true);
    connection.setAutoCommit(false);
    var statement = connection.createStatement();
    try {
      statement.setQueryTimeout(30);
      statement.execute('SET TRANSACTION READ ONLY');
    } finally {
      statement.close();
    }
    return connection;
  } catch (error) {
    if (connection) {
      try {
        connection.close();
      } catch (ignored) {}
    }
    throw new Error(
      'Could not open a read-only PostgreSQL connection. Check credentials, TLS certificate, and Apps Script IP access.'
    );
  }
}

// Up to 10 plain schema names the chat may explore; reports still take any SQL the role allows.
function dmvPostgresSchemas_(credentials) {
  var names = String(credentials.chatSchemas || 'public')
    .split(',')
    .map(function (name) {
      return name.trim();
    })
    .filter(Boolean);
  if (
    !names.length ||
    names.length > 10 ||
    names.some(function (name) {
      return !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(name);
    })
  )
    throw new Error('Schemas for chat must be up to 10 plain schema names separated by commas.');
  return names;
}

function dmvPostgresClose_(result, statement, connection) {
  [result, statement].forEach(function (resource) {
    if (resource) {
      try {
        resource.close();
      } catch (ignored) {}
    }
  });
  if (connection) {
    try {
      connection.rollback();
    } catch (ignored) {}
    try {
      connection.close();
    } catch (ignored) {}
  }
}

var DMV_POSTGRES_DESCRIBE_LIMIT = 3000;

// Tables and columns of the chat schemas, read from information_schema through the same bounded
// read-only query path as reports. An optional table-name search is applied in SQL, before the cap.
function dmvPostgresTables_(ctx, options) {
  var schemas = dmvPostgresSchemas_(ctx.credentials);
  var search = dmvTableSearch_((options || {}).search);
  var sql =
    'SELECT table_schema, table_name, column_name, data_type FROM information_schema.columns WHERE table_schema IN (' +
    schemas
      .map(function (name) {
        return "'" + name + "'";
      })
      .join(', ') +
    ')' +
    (search ? " AND strpos(lower(table_name), '" + search + "') > 0" : '') +
    ' ORDER BY table_schema, table_name, ordinal_position LIMIT ' +
    DMV_POSTGRES_DESCRIBE_LIMIT;
  var result;
  try {
    result = dmvPostgresQuery_(
      Object.assign({}, ctx, {
        config: { query: sql },
        fields: [],
        maxRows: DMV_POSTGRES_DESCRIBE_LIMIT,
      }),
      false
    );
  } catch (error) {
    if (/^Could not open/.test(String((error && error.message) || ''))) throw error;
    throw new Error(
      'PostgreSQL could not list the tables. Check that the role may read information_schema for these schemas.'
    );
  }
  return {
    scope: 'schemas ' + schemas.join(', '),
    tables: dmvGroupTables_(result.rows, function (row) {
      return row.table_schema + '.' + row.table_name;
    }),
    truncated: result.rows.length >= DMV_POSTGRES_DESCRIBE_LIMIT,
  };
}

function dmvPostgresFields_(metadata) {
  var fields = [],
    seen = {};
  if (metadata.getColumnCount() > 80) throw new Error('Select at most 80 SQL columns.');
  for (var i = 1; i <= metadata.getColumnCount(); i++) {
    var key = metadata.getColumnLabel(i);
    if (!key || seen[key]) throw new Error('Give each SQL result column a unique alias.');
    seen[key] = true;
    var nativeType = metadata.getColumnTypeName(i).toLowerCase();
    // Exact decimal and 64-bit integer values stay text to avoid spreadsheet rounding.
    var type = /^(int2|int4|smallint|integer|float4|float8|real|double precision)$/.test(nativeType)
      ? 'number'
      : 'text';
    fields.push({
      key: key,
      label: key,
      type: type,
      nativeType: nativeType,
      role: type === 'number' ? 'metric' : 'dimension',
      default: true,
      columnIndex: i,
    });
  }
  return fields;
}

function dmvPostgresQuery_(ctx, discoverOnly) {
  var sql = dmvPostgresSql_(ctx.config.query);
  var connection, statement, result;
  try {
    connection = dmvPostgresConnection_(ctx.credentials);
    statement = connection.prepareStatement(
      'SELECT * FROM (' + sql + ') AS datamoov_report LIMIT ' + (discoverOnly ? 0 : ctx.maxRows + 1)
    );
    statement.setQueryTimeout(30);
    statement.setMaxRows(discoverOnly ? 1 : ctx.maxRows + 1);
    result = statement.executeQuery();
    var available = dmvPostgresFields_(result.getMetaData());
    if (discoverOnly) return available;
    var columns = dmvSelectFields_(ctx.fields, available);
    var rows = [];
    while (result.next()) {
      ctx.checkDeadline();
      if (rows.length >= ctx.maxRows)
        throw new Error(
          'The SQL result exceeds the row limit. Add filters, aggregation, or a deliberate LIMIT.'
        );
      var row = {};
      columns.forEach(function (column) {
        var value = result.getString(column.columnIndex);
        if (result.wasNull()) value = null;
        else if (column.type === 'number') value = Number(value);
        else if (/^(bool|boolean)$/.test(column.nativeType))
          value = value === 't' || value === 'true';
        row[column.key] = value;
      });
      rows.push(row);
    }
    return {
      columns: columns,
      rows: rows,
      metadata: {
        complete: true,
        mode: 'Read-only SQL',
        note: 'Exact decimal and 64-bit integer columns are exported as text.',
      },
    };
  } catch (error) {
    var message = String((error && error.message) || '');
    if (
      /^(The SQL result|Unknown or unavailable|Field selections|Choose between|Give each SQL|Select at most|Could not open)/.test(
        message
      )
    )
      throw error;
    throw new Error(
      'PostgreSQL query failed. Check SELECT syntax, column access, and the 30-second query limit.'
    );
  } finally {
    dmvPostgresClose_(result, statement, connection);
  }
}

dmvRegisterConnector_({
  id: 'postgres',
  label: 'PostgreSQL',
  description: 'A focused, read-only SQL report from your database.',
  category: 'Databases',
  color: '#336791',
  guide: {
    intro: 'Use a dedicated read-only role; the database must be reachable from Google over TLS.',
    steps: [
      "CREATE ROLE datamoov_ro LOGIN PASSWORD '...'; GRANT CONNECT ON DATABASE app TO datamoov_ro; GRANT USAGE ON SCHEMA public TO datamoov_ro; GRANT SELECT ON ALL TABLES IN SCHEMA public TO datamoov_ro;",
      'Allow inbound connections from the Apps Script IP ranges and require SSL with a certificate from a trusted CA.',
      'Enter the public host name, port, database name and the role credentials.',
    ],
    links: [
      {
        label: 'Apps Script JDBC and IP ranges',
        url: 'https://developers.google.com/apps-script/guides/jdbc',
      },
    ],
  },
  authFields: [
    { key: 'host', label: 'Database host', type: 'text', required: true, perConnection: true },
    {
      key: 'port',
      label: 'Port',
      type: 'number',
      default: 5432,
      required: true,
      perConnection: true,
    },
    { key: 'database', label: 'Database', type: 'text', required: true, perConnection: true },
    { key: 'username', label: 'Read-only username', type: 'text', required: true },
    {
      key: 'password',
      label: 'Password',
      type: 'password',
      required: true,
      help: 'Use a dedicated read-only role. Allow Apps Script IP ranges and a trusted TLS certificate.',
    },
    {
      key: 'chatSchemas',
      label: 'Schemas for chat',
      type: 'text',
      default: 'public',
      perConnection: true,
      help: 'Comma-separated schemas the chat may explore, for example public, analytics. Reports are not limited by this.',
    },
  ],
  describeTables: dmvPostgresTables_,
  test: function (ctx) {
    var connection = dmvPostgresConnection_(ctx.credentials);
    try {
      if (!connection.isValid(5)) throw new Error('Database connection failed.');
    } finally {
      connection.close();
    }
  },
  reports: [
    {
      id: 'sql_report',
      label: 'SQL report',
      description: 'Use a SELECT query for the exact summary or table you need.',
      fields: [],
      dateRange: false,
      configFields: [
        {
          key: 'query',
          label: 'Read-only SQL',
          type: 'textarea',
          required: true,
          help: 'One SELECT or WITH query. Filter or aggregate large tables before importing.',
        },
      ],
      fetch: function (ctx) {
        return dmvPostgresQuery_(ctx, false);
      },
      discoverFields: function (ctx) {
        return dmvPostgresQuery_(ctx, true);
      },
    },
  ],
});
