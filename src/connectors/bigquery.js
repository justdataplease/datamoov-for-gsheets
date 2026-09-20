/** BigQuery read-only reports, validated with a dry-run Job before execution. */
function dmvBigQueryConfig_(ctx) {
  var project = String(ctx.config.projectId || '').trim();
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(project))
    throw new Error('Enter a valid Google Cloud project ID.');
  var sql = dmvReadOnlySql_(ctx.config.sql, { hashComments: true });
  // A subquery cannot contain DDL, DML, or scripting statements. Validate and
  // execute this identical wrapper; never execute the original SQL separately.
  sql =
    'SELECT * FROM (\n' + sql + '\n) AS datamoov_report LIMIT ' + (Number(ctx.maxRows || 1000) + 1);
  var bytes = String(ctx.config.maximumBytesBilled || '1073741824');
  if (!/^\d+$/.test(bytes) || Number(bytes) < 1 || Number(bytes) > 10737418240)
    throw new Error('Maximum bytes billed must be between 1 and 10 GiB (10737418240 bytes).');
  var location = String(ctx.config.location || '').trim();
  if (location && !/^[a-z0-9-]+$/i.test(location))
    throw new Error('Enter a valid BigQuery location, such as US or europe-west1.');
  return {
    project: project,
    sql: sql,
    bytes: bytes,
    location: location,
    base: 'https://bigquery.googleapis.com/bigquery/v2/projects/' + encodeURIComponent(project),
  };
}

function dmvBigQueryRequest_(ctx, url, body) {
  if (ctx.checkDeadline) ctx.checkDeadline();
  var request = { url: url, headers: { Authorization: 'Bearer ' + ctx.accessToken() } };
  if (body) {
    request.method = 'post';
    request.body = body;
    request.retrySafe = body.dryRun === true;
  }
  var response = ctx.http(request);
  if (
    !response ||
    response.error ||
    (response.errors && response.errors.length) ||
    (response.status && response.status.errorResult)
  ) {
    throw new Error(
      'BigQuery could not complete the query. Check its syntax, permissions, and scan limit.'
    );
  }
  return response;
}

function dmvBigQueryDryRun_(ctx) {
  var config = dmvBigQueryConfig_(ctx);
  var request = {
    dryRun: true,
    query: config.sql,
    useLegacySql: false,
    maximumBytesBilled: config.bytes,
  };
  if (config.location) request.location = config.location;
  var response = dmvBigQueryRequest_(ctx, config.base + '/queries', request);
  if (
    response.totalBytesProcessed != null &&
    Number(response.totalBytesProcessed) > Number(config.bytes)
  ) {
    throw new Error(
      'BigQuery dry run exceeds maximum bytes billed. Narrow the query or adjust the scan limit.'
    );
  }
  var fields = response.schema && response.schema.fields;
  if (!Array.isArray(fields) || !fields.length || fields.length > 100)
    throw new Error('BigQuery must return between 1 and 100 named columns.');
  var seen = Object.create(null);
  fields.forEach(function (field) {
    if (
      !field ||
      !field.name ||
      seen[field.name] ||
      ['__proto__', 'prototype', 'constructor'].indexOf(field.name) >= 0
    ) {
      throw new Error('Use unique, ordinary column aliases in the BigQuery query.');
    }
    seen[field.name] = true;
  });
  return { config: config, fields: fields };
}

function dmvBigQueryField_(field) {
  var numeric = ['INTEGER', 'INT64', 'FLOAT', 'FLOAT64'].indexOf(field.type) >= 0;
  return {
    key: field.name,
    label: field.name,
    type:
      field.mode === 'REPEATED'
        ? 'text'
        : numeric
          ? 'number'
          : ['DATE', 'DATETIME', 'TIMESTAMP'].indexOf(field.type) >= 0
            ? 'date'
            : 'text',
    default: true,
  };
}

function dmvBigQueryDiscover_(ctx) {
  return dmvBigQueryDryRun_(ctx).fields.map(dmvBigQueryField_);
}

// Up to 10 project.dataset names the chat may explore.
function dmvBigQueryDatasets_(credentials) {
  var names = String(credentials.chatDatasets || '')
    .split(',')
    .map(function (name) {
      return name.trim();
    })
    .filter(Boolean);
  if (!names.length)
    throw new Error(
      'No datasets are set for chat on this BigQuery connection. Ask the user for a project.dataset to explore (they can save it on the connection as "Datasets for chat"), then query its INFORMATION_SCHEMA.COLUMNS with config.projectId set to that project.'
    );
  if (
    names.length > 10 ||
    names.some(function (name) {
      return !/^[a-z][a-z0-9-]{4,28}[a-z0-9]\.[A-Za-z0-9_]{1,1024}$/.test(name);
    })
  )
    throw new Error(
      'Datasets for chat must be up to 10 project.dataset names separated by commas.'
    );
  return names;
}

var DMV_BIGQUERY_DESCRIBE_LIMIT = 3000;

// Tables and columns of the chat datasets, read through the same dry-run-validated query path.
// An optional table-name search is applied in SQL, before the per-dataset cap.
function dmvBigQueryTables_(ctx, options) {
  var datasets = dmvBigQueryDatasets_(ctx.credentials);
  var search = dmvTableSearch_((options || {}).search);
  var tables = [],
    truncated = false;
  datasets.forEach(function (dataset) {
    var result = dmvBigQueryFetch_(
      Object.assign({}, ctx, {
        config: {
          projectId: dataset.split('.')[0],
          sql:
            'SELECT table_name, column_name, data_type FROM `' +
            dataset +
            '`.INFORMATION_SCHEMA.COLUMNS' +
            (search ? " WHERE STRPOS(LOWER(table_name), '" + search + "') > 0" : '') +
            ' ORDER BY table_name, ordinal_position LIMIT ' +
            DMV_BIGQUERY_DESCRIBE_LIMIT,
        },
        fields: [],
        maxRows: DMV_BIGQUERY_DESCRIBE_LIMIT,
      })
    );
    if (result.rows.length >= DMV_BIGQUERY_DESCRIBE_LIMIT) truncated = true;
    tables = tables.concat(
      dmvGroupTables_(result.rows, function (row) {
        return dataset + '.' + String(row.table_name);
      })
    );
  });
  return { scope: 'datasets ' + datasets.join(', '), tables: tables, truncated: truncated };
}

function dmvBigQueryValue_(field, value) {
  if (value == null) return '';
  if (field.mode === 'REPEATED') {
    if (!Array.isArray(value)) throw new Error('BigQuery returned an invalid repeated value.');
    var single = { type: field.type, fields: field.fields, mode: 'NULLABLE' };
    return value.map(function (item) {
      return dmvBigQueryValue_(single, item.v);
    });
  }
  if (field.type === 'RECORD' || field.type === 'STRUCT') {
    var object = Object.create(null);
    if (!value.f || value.f.length !== (field.fields || []).length)
      throw new Error('BigQuery returned an invalid record value.');
    field.fields.forEach(function (child, index) {
      object[child.name] = dmvBigQueryValue_(child, value.f[index].v);
    });
    return object;
  }
  if (field.type === 'BOOLEAN' || field.type === 'BOOL')
    return value === true || String(value).toLowerCase() === 'true';
  if (field.type === 'INTEGER' || field.type === 'INT64') {
    var integer = Number(value);
    return Number.isSafeInteger(integer) ? integer : String(value);
  }
  if (field.type === 'FLOAT' || field.type === 'FLOAT64') {
    var number = Number(value);
    return isFinite(number) ? number : String(value);
  }
  if (field.type === 'TIMESTAMP') {
    var timestamp = new Date(Number(value) * 1000);
    return isFinite(timestamp.getTime()) ? timestamp.toISOString() : String(value);
  }
  // NUMERIC/BIGNUMERIC retain the provider's decimal text to avoid precision loss.
  return value;
}

function dmvBigQuerySchemaShape_(fields) {
  return JSON.stringify(
    (fields || []).map(function (field) {
      return {
        name: field.name,
        type: field.type,
        mode: field.mode || 'NULLABLE',
        fields: field.fields ? dmvBigQuerySchemaShape_(field.fields) : '',
      };
    })
  );
}

function dmvBigQueryFetch_(ctx) {
  var prepared = dmvBigQueryDryRun_(ctx),
    config = prepared.config,
    fields = prepared.fields;
  var columns;
  try {
    columns = dmvSelectFields_(ctx.fields, fields.map(dmvBigQueryField_));
  } catch (error) {
    throw new Error(
      'The BigQuery result schema changed. Refresh fields and save the report again.'
    );
  }
  var selected = columns.map(function (column) {
    return column.key;
  });
  var maximum = Number(ctx.maxRows) || 1000;
  var request = {
    query: config.sql,
    useLegacySql: false,
    maximumBytesBilled: config.bytes,
    maxResults: Math.min(maximum + 1, 1000),
    timeoutMs: 10000,
    jobTimeoutMs: '45000',
  };
  if (config.location) request.location = config.location;
  var response = dmvBigQueryRequest_(ctx, config.base + '/queries', request);
  var job = response.jobReference,
    rows = [],
    pages = 0,
    polls = 0,
    seen = Object.create(null),
    total;
  function resultUrl(pageToken) {
    if (!job || !job.jobId || job.projectId !== config.project)
      throw new Error('BigQuery omitted a valid query job reference.');
    var url =
      config.base +
      '/queries/' +
      encodeURIComponent(job.jobId) +
      '?maxResults=' +
      Math.min(maximum + 1, 1000) +
      '&timeoutMs=10000';
    var location = job.location || config.location;
    if (location) url += '&location=' + encodeURIComponent(location);
    if (pageToken) url += '&pageToken=' + encodeURIComponent(pageToken);
    return url;
  }
  while (true) {
    if (ctx.checkDeadline) ctx.checkDeadline();
    if (response.jobComplete === false) {
      if (++polls > 5) throw new Error('BigQuery is still running. Simplify the query and retry.');
      response = dmvBigQueryRequest_(ctx, resultUrl());
      continue;
    }
    if (response.jobComplete !== true)
      throw new Error('BigQuery did not confirm query completion.');
    if (++pages > 100) throw new Error('BigQuery pagination exceeded the report budget.');
    if (response.totalRows != null) {
      total = Number(response.totalRows);
      if (!Number.isSafeInteger(total) || total < 0 || total > maximum)
        throw new Error(
          'BigQuery result exceeds the row limit. Add a LIMIT or aggregate the query.'
        );
    }
    if (
      response.schema &&
      dmvBigQuerySchemaShape_(response.schema.fields) !== dmvBigQuerySchemaShape_(fields)
    ) {
      throw new Error('The BigQuery schema changed after validation. Refresh fields and retry.');
    }
    if (response.rows != null && !Array.isArray(response.rows))
      throw new Error('BigQuery returned invalid result rows.');
    (response.rows || []).forEach(function (record) {
      if (!record || !Array.isArray(record.f) || record.f.length !== fields.length)
        throw new Error('BigQuery returned a row with an unexpected schema.');
      var row = Object.create(null);
      fields.forEach(function (field, index) {
        if (selected.indexOf(field.name) < 0) return;
        var value = dmvBigQueryValue_(field, record.f[index].v);
        row[field.name] = value && typeof value === 'object' ? JSON.stringify(value) : value;
      });
      rows.push(row);
    });
    if (rows.length > maximum)
      throw new Error('BigQuery result exceeds the row limit. Add a LIMIT or aggregate the query.');
    if (!response.pageToken) break;
    if (rows.length >= maximum)
      throw new Error('BigQuery result exceeds the row limit. Add a LIMIT or aggregate the query.');
    if (seen[response.pageToken]) throw new Error('BigQuery returned a repeated result page.');
    seen[response.pageToken] = true;
    response = dmvBigQueryRequest_(ctx, resultUrl(response.pageToken));
  }
  if (total != null && total !== rows.length)
    throw new Error('BigQuery returned an incomplete result. Retry the report.');
  return {
    columns: columns,
    rows: rows,
    metadata: {
      complete: true,
      rowCount: rows.length,
      projectId: config.project,
      jobId: (job && job.jobId) || '',
      maximumBytesBilled: config.bytes,
    },
  };
}

dmvRegisterConnector_({
  id: 'bigquery',
  label: 'BigQuery',
  description: 'Read-only SQL reports with a scan limit and field discovery.',
  category: 'Database',
  color: '#4285f4',
  allowedHosts: ['bigquery.googleapis.com'],
  googleScopes: ['https://www.googleapis.com/auth/bigquery.readonly'],
  credentialFamily: DMV_GOOGLE_CREDENTIAL,
  authFields: [
    {
      key: 'chatDatasets',
      label: 'Datasets for chat',
      type: 'text',
      perConnection: true,
      help: 'Comma-separated project.dataset names the chat may explore, for example my-project.analytics. Reports are not limited by this.',
    },
  ].concat(
    dmvGoogleAuthFields_(
      'Grant BigQuery Job User on the query project and read access to the datasets.'
    )
  ),
  describeTables: dmvBigQueryTables_,
  guide: dmvGoogleGuide_({
    apis: 'the BigQuery API',
    access: 'the query project and its datasets',
    scope: 'https://www.googleapis.com/auth/bigquery.readonly',
    grant:
      'IAM & Admin → IAM → grant the service account BigQuery Job User on the query project and BigQuery Data Viewer on the datasets it reads.',
    links: [
      {
        label: 'BigQuery access control',
        url: 'https://cloud.google.com/bigquery/docs/access-control',
      },
    ],
  }),
  reports: [
    {
      id: 'query',
      label: 'SQL query',
      description: 'One SELECT or WITH query. Dry-run validation happens before execution.',
      fields: [],
      dateRange: false,
      configFields: [
        { key: 'projectId', label: 'Query project ID', type: 'text', required: true },
        {
          key: 'location',
          label: 'Location',
          type: 'text',
          help: 'For example US, EU, or europe-west1; must match the queried datasets.',
        },
        {
          key: 'sql',
          label: 'Read-only SQL',
          type: 'textarea',
          required: true,
          help: 'Select just the columns you need and add a LIMIT.',
        },
        {
          key: 'maximumBytesBilled',
          label: 'Maximum bytes billed',
          type: 'number',
          default: 1073741824,
          help: 'Default 1 GiB; maximum 10 GiB. A dry run checks this before execution.',
        },
      ],
      fetch: dmvBigQueryFetch_,
      discoverFields: dmvBigQueryDiscover_,
    },
  ],
});
