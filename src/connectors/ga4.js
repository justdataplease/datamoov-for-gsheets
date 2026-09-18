// Analytics Data API v1beta, with property metadata and compatibility checks for custom fields.
function dmvGa4Fields_() {
  var f = dmvField_;
  return [
    f('date', 'Date', 'date', true, { role: 'dimension' }),
    f('sessionSource', 'Session source', 'text', true, { role: 'dimension' }),
    f('sessionMedium', 'Session medium', 'text', true, { role: 'dimension' }),
    f('sessionCampaignName', 'Session campaign', 'text', true, { role: 'dimension' }),
    f('sessions', 'Sessions', 'number', true, { role: 'metric' }),
    f('activeUsers', 'Active users', 'number', true, { role: 'metric' }),
    f('screenPageViews', 'Page views', 'number', true, { role: 'metric' }),
    f('keyEvents', 'Key events', 'number', true, { role: 'metric' }),
    f('totalRevenue', 'Total revenue', 'currency', true, { role: 'metric' }),
  ];
}

function dmvGa4Connection_(ctx) {
  var id = String((ctx.credentials || {}).propertyId || '')
    .replace(/^properties\//, '')
    .trim();
  if (!/^\d{1,20}$/.test(id)) throw new Error('Enter a numeric GA4 property ID.');
  return {
    id: id,
    base: 'https://analyticsdata.googleapis.com/v1beta/properties/' + id,
    headers: { Authorization: 'Bearer ' + dmvBearer_(ctx) },
  };
}

function dmvGa4Metadata_(ctx, connection) {
  var payload = ctx.http({ url: connection.base + '/metadata', headers: connection.headers });
  if (!payload || !Array.isArray(payload.dimensions) || !Array.isArray(payload.metrics))
    throw new Error('GA4 field metadata is unavailable.');
  var defaults = dmvGa4Fields_().map(function (f) {
      return f.key;
    }),
    fields = [];
  ['dimensions', 'metrics'].forEach(function (group) {
    payload[group].forEach(function (item) {
      if (!item.apiName || (item.blockedReasons || []).length) return;
      var role = group === 'dimensions' ? 'dimension' : 'metric';
      var type =
        role === 'dimension'
          ? item.apiName === 'date'
            ? 'date'
            : 'text'
          : item.type === 'TYPE_CURRENCY'
            ? 'currency'
            : 'number';
      fields.push(
        dmvField_(
          item.apiName,
          item.uiName || item.apiName,
          type,
          defaults.indexOf(item.apiName) >= 0,
          { role: role, help: item.description || '', custom: !!item.customDefinition }
        )
      );
    });
  });
  return fields;
}

function dmvGa4Discover_(ctx) {
  return dmvGa4Metadata_(ctx, dmvGa4Connection_(ctx));
}

function dmvGa4Fetch_(ctx) {
  var keys =
    ctx.fields && ctx.fields.length
      ? ctx.fields
      : dmvGa4Fields_().map(function (f) {
          return f.key;
        });
  if (
    !Array.isArray(keys) ||
    !keys.length ||
    keys.length > 19 ||
    keys.some(function (key) {
      return typeof key !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_:.[\]-]{0,199}$/.test(key);
    })
  ) {
    throw new Error('Choose valid GA4 field names from field discovery.');
  }
  if (new Set(keys).size !== keys.length) throw new Error('Field selections must be unique.');
  var connection = dmvGa4Connection_(ctx),
    columns = dmvSelectFields_(keys, dmvGa4Metadata_(ctx, connection));
  var dimensions = columns
    .filter(function (f) {
      return f.role === 'dimension';
    })
    .map(function (f) {
      return { name: f.key };
    });
  var metrics = columns
    .filter(function (f) {
      return f.role === 'metric';
    })
    .map(function (f) {
      return { name: f.key };
    });
  if (dimensions.length > 9 || metrics.length < 1 || metrics.length > 10)
    throw new Error('GA4 reports support up to 9 dimensions and between 1 and 10 metrics.');
  var compatible = ctx.http({
    url: connection.base + ':checkCompatibility',
    method: 'post',
    retrySafe: true,
    headers: connection.headers,
    body: { dimensions: dimensions, metrics: metrics, compatibilityFilter: 'COMPATIBLE' },
  });
  if (!compatible || compatible.error)
    throw new Error('GA4 field compatibility could not be checked.');
  var allowed = [];
  (compatible.dimensionCompatibilities || []).forEach(function (item) {
    if (item.compatibility === 'COMPATIBLE' && item.dimensionMetadata)
      allowed.push(item.dimensionMetadata.apiName);
  });
  (compatible.metricCompatibilities || []).forEach(function (item) {
    if (item.compatibility === 'COMPATIBLE' && item.metricMetadata)
      allowed.push(item.metricMetadata.apiName);
  });
  if (
    columns.some(function (field) {
      return allowed.indexOf(field.key) < 0;
    })
  )
    throw new Error(
      'These GA4 dimensions and metrics cannot be combined. Choose compatible fields.'
    );
  var rows = [],
    expected = null,
    metadata = {},
    pages = 0;
  do {
    ctx.checkDeadline();
    if (++pages > 100) throw new Error('GA4 returned too many pages. Narrow the report.');
    var body = {
      dateRanges: [{ startDate: ctx.startDate, endDate: ctx.endDate }],
      dimensions: dimensions,
      metrics: metrics,
      limit: String(Math.min(10000, ctx.maxRows + 1)),
      offset: String(rows.length),
      keepEmptyRows: true,
    };
    if (dimensions.length)
      body.orderBys = dimensions.map(function (d) {
        return { dimension: { dimensionName: d.name } };
      });
    var payload = ctx.http({
      url: connection.base + ':runReport',
      method: 'post',
      retrySafe: true,
      headers: connection.headers,
      body: body,
    });
    if (
      !payload ||
      payload.error ||
      !Number.isInteger(
        Number(payload.rowCount === undefined && !payload.rows ? 0 : payload.rowCount)
      ) ||
      Number(payload.rowCount || 0) < 0
    )
      throw new Error('GA4 returned an invalid row count.');
    var count = Number(payload.rowCount || 0);
    if (count > ctx.maxRows)
      throw new Error(
        'This report exceeds the row limit. Choose a smaller date range or fewer dimensions.'
      );
    if (expected !== null && expected !== count)
      throw new Error('The GA4 report changed during pagination. Run it again.');
    expected = count;
    var page = payload.rows === undefined ? [] : payload.rows;
    if (!Array.isArray(page) || (!page.length && rows.length < expected))
      throw new Error('GA4 returned an incomplete report page.');
    var dimHeaders = (payload.dimensionHeaders || []).map(function (h) {
      return h.name;
    });
    var metricHeaders = (payload.metricHeaders || []).map(function (h) {
      return h.name;
    });
    if (
      page.length &&
      (JSON.stringify(dimHeaders) !==
        JSON.stringify(
          dimensions.map(function (d) {
            return d.name;
          })
        ) ||
        JSON.stringify(metricHeaders) !==
          JSON.stringify(
            metrics.map(function (m) {
              return m.name;
            })
          ))
    )
      throw new Error('GA4 response columns do not match the requested fields.');
    dmvAppendPage_(
      rows,
      page.map(function (item) {
        var row = {};
        if (
          (item.dimensionValues || []).length !== dimensions.length ||
          (item.metricValues || []).length !== metrics.length
        )
          throw new Error('GA4 returned a malformed report row.');
        dimensions.forEach(function (d, i) {
          var value = item.dimensionValues[i].value;
          if (d.name === 'date' && /^\d{8}$/.test(value))
            value = value.slice(0, 4) + '-' + value.slice(4, 6) + '-' + value.slice(6, 8);
          row[d.name] = dmvTextValue_(value);
        });
        metrics.forEach(function (m, i) {
          row[m.name] = dmvNumber_(item.metricValues[i].value);
        });
        return row;
      }),
      ctx.maxRows
    );
    if (rows.length > expected) throw new Error('GA4 returned more rows than its reported total.');
    var current = payload.metadata || {};
    if (
      current.subjectToThresholding ||
      current.dataLossFromOtherRow ||
      (current.samplingMetadatas || []).length
    ) {
      throw new Error(
        'GA4 marked this report as thresholded, sampled, or grouped into an other row. Adjust the fields or date range before exporting.'
      );
    }
    metadata = current;
  } while (rows.length < expected);
  return {
    columns: columns,
    rows: rows,
    metadata: {
      apiVersion: 'v1beta',
      propertyId: connection.id,
      currency: metadata.currencyCode || '',
      timeZone: metadata.timeZone || '',
      attribution: 'GA4 property reporting; users are nonadditive across dates and dimensions.',
      complete: true,
    },
  };
}

dmvRegisterConnector_({
  id: 'ga4',
  label: 'Google Analytics 4',
  description: 'Traffic, engagement and key events with property-specific field discovery.',
  category: 'Marketing',
  color: '#e37400',
  test: dmvGa4Discover_,
  allowedHosts: ['analyticsdata.googleapis.com'],
  googleScopes: ['https://www.googleapis.com/auth/analytics.readonly'],
  authFields: [
    {
      key: 'propertyId',
      label: 'Property ID',
      type: 'text',
      required: true,
      help: 'The numeric GA4 property ID, not the G- measurement ID.',
    },
  ].concat(dmvGoogleAuthFields_()),
  reports: [
    {
      id: 'acquisition_daily',
      label: 'Daily acquisition',
      description:
        'A small acquisition report, or custom compatible dimensions and metrics from your property.',
      fields: dmvGa4Fields_(),
      configFields: [],
      dateRange: true,
      fetch: dmvGa4Fetch_,
      discoverFields: dmvGa4Discover_,
    },
  ],
});
