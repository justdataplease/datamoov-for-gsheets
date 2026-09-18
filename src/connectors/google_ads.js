// Google Ads API v25. Field keys are GAQL names; monetary micros become account-currency amounts.
function dmvGoogleAdsFields_() {
  var f = dmvField_;
  return [
    f('segments.date', 'Date', 'date', true),
    f('customer.id', 'Account ID', 'text', true),
    f('customer.currency_code', 'Currency', 'text', true),
    f('campaign.id', 'Campaign ID', 'text', true),
    f('campaign.name', 'Campaign', 'text', true),
    f('metrics.cost_micros', 'Spend', 'currency', true, { micros: true }),
    f('metrics.impressions', 'Impressions', 'number', true),
    f('metrics.clicks', 'Clicks', 'number', true),
    f('metrics.conversions', 'Conversions', 'number', true),
    f('metrics.conversions_value', 'Conversion value', 'currency', true),
    f('customer.descriptive_name', 'Account', 'text', false),
    f('customer.time_zone', 'Account time zone', 'text', false),
    f('campaign.status', 'Campaign status', 'text', false),
    f('campaign.advertising_channel_type', 'Channel type', 'text', false),
    f('segments.device', 'Device', 'text', false),
    f('segments.ad_network_type', 'Ad network', 'text', false),
    f('metrics.ctr', 'CTR', 'percent', false),
    f('metrics.average_cpc', 'Average CPC', 'currency', false, { micros: true }),
    f('metrics.average_cpm', 'Average CPM', 'currency', false, { micros: true }),
    f('metrics.all_conversions', 'All conversions', 'number', false),
    f('metrics.all_conversions_value', 'All conversion value', 'currency', false),
    f('campaign.network_settings.target_google_search', 'Targets Google Search', 'text', false),
  ].map(function (field) {
    field.role = field.key.indexOf('metrics.') === 0 ? 'metric' : 'dimension';
    return field;
  });
}

function dmvGoogleAdsConnection_(ctx) {
  var c = ctx.credentials || {};
  var id = String(c.customerId || '')
    .replace(/-/g, '')
    .trim();
  if (!/^\d{10}$/.test(id)) throw new Error('Enter a 10-digit Google Ads customer ID.');
  if (!c.developerToken) throw new Error('Enter your Google Ads developer token.');
  var login = String(c.loginCustomerId || '')
    .replace(/-/g, '')
    .trim();
  if (login && !/^\d{10}$/.test(login))
    throw new Error('The manager customer ID must contain 10 digits.');
  var headers = {
    Authorization: 'Bearer ' + dmvBearer_(ctx),
    'developer-token': c.developerToken,
  };
  if (login) headers['login-customer-id'] = login;
  return { id: id, headers: headers, base: 'https://googleads.googleapis.com/v25/' };
}

function dmvGoogleAdsPages_(ctx, connection, path, query, limit) {
  var rows = [],
    token = '',
    seen = {},
    pages = 0;
  do {
    ctx.checkDeadline();
    if (++pages > 100) throw new Error('Google Ads returned too many pages. Narrow the report.');
    var body = { query: query };
    if (token) body.pageToken = token;
    var result = ctx.http({
      url: connection.base + path,
      method: 'post',
      retrySafe: true,
      headers: connection.headers,
      body: body,
    });
    if (!result || result.error) throw new Error('Google Ads did not return a valid report.');
    var page = result.results === undefined ? [] : result.results;
    dmvAppendPage_(rows, page, limit);
    token = result.nextPageToken || '';
    if (typeof token !== 'string' || (token && seen[token]))
      throw new Error('Google Ads returned a repeated or invalid page token.');
    if (token && !page.length) throw new Error('Google Ads returned an empty nonterminal page.');
    if (token) seen[token] = true;
  } while (token);
  return rows;
}

function dmvGoogleAdsDiscover_(ctx) {
  var connection = dmvGoogleAdsConnection_(ctx),
    available = dmvGoogleAdsFields_();
  var names = available
    .map(function (f) {
      return "'" + f.key + "'";
    })
    .join(',');
  var rows = dmvGoogleAdsPages_(
    ctx,
    connection,
    'googleAdsFields:search',
    'SELECT name,selectable,is_repeated,data_type,selectable_with WHERE name IN (' + names + ')',
    1000
  );
  return available.filter(function (field) {
    return rows.some(function (row) {
      return row.name === field.key && row.selectable === true && !row.isRepeated;
    });
  });
}

function dmvGoogleAdsValue_(row, field) {
  var value = field.key.split('.').reduce(function (object, key) {
    var camel = key.replace(/_([a-z])/g, function (_, letter) {
      return letter.toUpperCase();
    });
    return object === null || object === undefined ? undefined : object[camel];
  }, row);
  if (field.type === 'number' || field.type === 'currency' || field.type === 'percent') {
    var number = dmvNumber_(value);
    return number === null ? null : field.micros ? number / 1000000 : number;
  }
  return dmvTextValue_(value);
}

function dmvGoogleAdsFetch_(ctx) {
  var columns = dmvSelectFields_(ctx.fields, dmvGoogleAdsFields_());
  var connection = dmvGoogleAdsConnection_(ctx);
  var names = columns.map(function (f) {
    return f.key;
  });
  // Always retain the report's documented daily-campaign grain, even with a smaller output selection.
  [
    'segments.date',
    'campaign.id',
    'customer.id',
    'customer.currency_code',
    'customer.time_zone',
  ].forEach(function (key) {
    if (names.indexOf(key) < 0) names.push(key);
  });
  var query =
    'SELECT ' +
    names.join(', ') +
    ' FROM campaign WHERE segments.date BETWEEN ' +
    "'" +
    ctx.startDate +
    "' AND '" +
    ctx.endDate +
    "' ORDER BY segments.date,campaign.id";
  var raw = dmvGoogleAdsPages_(
    ctx,
    connection,
    'customers/' + connection.id + '/googleAds:search',
    query,
    ctx.maxRows
  );
  var rows = raw.map(function (item) {
    var row = {};
    columns.forEach(function (field) {
      row[field.key] = dmvGoogleAdsValue_(item, field);
    });
    return row;
  });
  return {
    columns: columns,
    rows: rows,
    metadata: {
      apiVersion: 'v25',
      accountId: connection.id,
      currency: raw.length && raw[0].customer ? raw[0].customer.currencyCode || '' : '',
      timeZone: raw.length && raw[0].customer ? raw[0].customer.timeZone || '' : '',
      attribution: 'Google Ads conversion-action attribution; interaction-date reporting.',
      grain: 'Daily campaign',
      complete: true,
    },
  };
}

function dmvGoogleAdsTest_(ctx) {
  var connection = dmvGoogleAdsConnection_(ctx);
  var rows = dmvGoogleAdsPages_(
    ctx,
    connection,
    'customers/' + connection.id + '/googleAds:search',
    'SELECT customer.id FROM customer LIMIT 1',
    1
  );
  if (!rows.length || !rows[0].customer)
    throw new Error('Google Ads did not return the requested account.');
}

dmvRegisterConnector_({
  id: 'google_ads',
  label: 'Google Ads',
  description: 'Daily campaign performance in your account currency.',
  category: 'Marketing',
  color: '#4285f4',
  test: dmvGoogleAdsTest_,
  allowedHosts: ['googleads.googleapis.com'],
  googleScopes: ['https://www.googleapis.com/auth/adwords'],
  authFields: [
    {
      key: 'customerId',
      label: 'Customer ID',
      type: 'text',
      required: true,
      help: 'Your advertising account ID, with or without hyphens.',
    },
    {
      key: 'loginCustomerId',
      label: 'Manager customer ID (optional)',
      type: 'text',
      required: false,
    },
    { key: 'developerToken', label: 'Developer token', type: 'password', required: true },
  ].concat(dmvGoogleAuthFields_()),
  reports: [
    {
      id: 'campaign_daily',
      label: 'Daily campaign performance',
      description:
        'Spend, impressions, clicks and attributed conversions. Customize with additional campaign fields.',
      fields: dmvGoogleAdsFields_(),
      configFields: [],
      dateRange: true,
      fetch: dmvGoogleAdsFetch_,
      discoverFields: dmvGoogleAdsDiscover_,
    },
  ],
});
