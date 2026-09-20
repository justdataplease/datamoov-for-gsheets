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

// YouTube ads are Google Ads video campaigns; this report keeps the same daily campaign grain.
function dmvGoogleAdsVideoFields_() {
  var f = dmvField_;
  return [
    f('segments.date', 'Date', 'date', true),
    f('customer.id', 'Account ID', 'text', true),
    f('customer.currency_code', 'Currency', 'text', true),
    f('campaign.id', 'Campaign ID', 'text', true),
    f('campaign.name', 'Campaign', 'text', true),
    f('metrics.cost_micros', 'Spend', 'currency', true, { micros: true }),
    f('metrics.impressions', 'Impressions', 'number', true),
    f('metrics.video_trueview_views', 'TrueView views', 'number', true),
    f('metrics.video_trueview_view_rate', 'TrueView view rate', 'percent', true),
    f('metrics.trueview_average_cpv', 'Average TrueView CPV', 'currency', true, { micros: true }),
    f('metrics.clicks', 'Clicks', 'number', true),
    f('metrics.conversions', 'Conversions', 'number', true),
    f('metrics.conversions_value', 'Conversion value', 'currency', true),
    f('metrics.video_quartile_p25_rate', 'Watched 25%', 'percent', false),
    f('metrics.video_quartile_p50_rate', 'Watched 50%', 'percent', false),
    f('metrics.video_quartile_p75_rate', 'Watched 75%', 'percent', false),
    f('metrics.video_quartile_p100_rate', 'Watched 100%', 'percent', false),
    f('campaign.status', 'Campaign status', 'text', false),
    f('campaign.advertising_channel_sub_type', 'Campaign subtype', 'text', false),
    f('customer.descriptive_name', 'Account', 'text', false),
    f('customer.time_zone', 'Account time zone', 'text', false),
    f('metrics.ctr', 'CTR', 'percent', false),
    f('metrics.average_cpm', 'Average CPM', 'currency', false, { micros: true }),
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
  var login = String(c.loginCustomerId || '')
    .replace(/-/g, '')
    .trim();
  if (login && !/^\d{10}$/.test(login))
    throw new Error('The manager customer ID must contain 10 digits.');
  var headers = {
    Authorization: 'Bearer ' + dmvBearer_(ctx),
  };
  if (c.developerToken) headers['developer-token'] = c.developerToken;
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

function dmvGoogleAdsDiscover_(ctx, available) {
  var connection = dmvGoogleAdsConnection_(ctx);
  available = available || dmvGoogleAdsFields_();
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

// Preserve saved report field keys while querying the current Google Ads API names.
function dmvGoogleAdsColumns_(selected, available) {
  var aliases = {
    'metrics.video_views': 'metrics.video_trueview_views',
    'metrics.video_view_rate': 'metrics.video_trueview_view_rate',
    'metrics.average_cpv': 'metrics.trueview_average_cpv',
  };
  var compatible = available.slice();
  Object.keys(aliases).forEach(function (legacy) {
    var field = available.filter(function (item) {
      return item.key === aliases[legacy];
    })[0];
    if (field)
      compatible.push(
        Object.assign({}, field, { key: legacy, apiName: field.key, default: false })
      );
  });
  return dmvSelectFields_(selected, compatible);
}

function dmvGoogleAdsValue_(row, field) {
  var value = (field.apiName || field.key).split('.').reduce(function (object, key) {
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
  return dmvGoogleAdsCampaignFetch_(ctx, dmvGoogleAdsFields_(), '', 'Daily campaign');
}

function dmvGoogleAdsVideoFetch_(ctx) {
  return dmvGoogleAdsCampaignFetch_(
    ctx,
    dmvGoogleAdsVideoFields_(),
    " AND campaign.advertising_channel_type = 'VIDEO'",
    'Daily video campaign'
  );
}

function dmvGoogleAdsCampaignFetch_(ctx, available, extraWhere, grain) {
  var columns = dmvGoogleAdsColumns_(ctx.fields, available);
  var connection = dmvGoogleAdsConnection_(ctx);
  var names = [];
  columns.forEach(function (field) {
    var name = field.apiName || field.key;
    if (names.indexOf(name) < 0) names.push(name);
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
    "'" +
    extraWhere +
    ' ORDER BY segments.date,campaign.id';
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
      grain: grain,
      complete: true,
    },
  };
}

/* Custom query: any Google Ads resource through one read-only GAQL statement. The search
   endpoint cannot change an account, so the guard only keeps the statement a single SELECT
   whose columns the runtime can name and type. */
function dmvGoogleAdsParseQuery_(text) {
  var query = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  var match =
    /^SELECT (.+?) FROM ([a-z_]+)( WHERE (.+?))?( ORDER BY (.+?))?( LIMIT ([0-9]+))?( PARAMETERS (.+))?$/i.exec(
      query
    );
  if (!match || query.length > 5000 || query.indexOf(';') >= 0)
    throw new Error(
      'Write one GAQL query: SELECT fields FROM resource [WHERE conditions] [ORDER BY field] [LIMIT n].'
    );
  var names = match[1].split(',').map(function (name) {
    return name.trim();
  });
  if (
    names.length > DMV_LIMITS.maxColumns ||
    names.some(function (name, index) {
      return !/^[a-z_]+(\.[a-z0-9_]+)+$/.test(name) || names.indexOf(name) !== index;
    })
  )
    throw new Error(
      'Select up to 80 distinct GAQL fields such as campaign.name or metrics.clicks.'
    );
  return {
    names: names,
    resource: match[2].toLowerCase(),
    where: match[4] || '',
    orderBy: match[6] || '',
    limit: match[8] || '',
    parameters: match[10] || '',
  };
}

// GAQL names carry their own typing conventions: *_micros and average costs are money in
// micros, rates and shares are fractions, every other metric is a count or value.
function dmvGoogleAdsQueryColumn_(name) {
  var known = dmvGoogleAdsFields_()
    .concat(dmvGoogleAdsVideoFields_())
    .filter(function (field) {
      return field.key === name;
    })[0];
  if (known) return Object.assign({}, known);
  var metric = name.indexOf('metrics.') === 0;
  var micros =
    /_micros$/.test(name) ||
    /^metrics\.(average_(cpc|cpm|cpv|cpe|cost|target_cpa)|cost_per_|trueview_average_cpv)/.test(
      name
    );
  var rate = /(^metrics\.ctr$|_rate$|_share$|_percentage$|percent)/.test(name);
  var label = name
    .replace(/^(metrics|segments)\./, '')
    .replace(/_micros$/, '')
    .replace(/[._]/g, ' ');
  var column = {
    key: name,
    label: label.charAt(0).toUpperCase() + label.slice(1),
    type: micros
      ? 'currency'
      : rate
        ? 'percent'
        : metric
          ? 'number'
          : /^segments\.(date|week|month|quarter)$/.test(name)
            ? 'date'
            : 'text',
    role: metric ? 'metric' : 'dimension',
  };
  if (micros) column.micros = true;
  if (metric && (rate || /(average_|_per_|score|position)/.test(name))) column.additive = false;
  return column;
}

function dmvGoogleAdsQueryFetch_(ctx) {
  var parsed = dmvGoogleAdsParseQuery_(ctx.config.gaql);
  var connection = dmvGoogleAdsConnection_(ctx);
  var columns = parsed.names.map(dmvGoogleAdsQueryColumn_);
  // Metrics and segments cover a period, so the report's date range applies to them unless
  // the query already filters dates itself. Attribute-only resources (negative keywords,
  // settings) have no period.
  var dated = parsed.names.some(function (name) {
    return /^(metrics|segments)\./.test(name);
  });
  var where = parsed.where;
  if (dated && !/segments\.(date|week|month|quarter|year)\b/.test(where))
    where =
      (where ? where + ' AND ' : '') +
      "segments.date BETWEEN '" +
      ctx.startDate +
      "' AND '" +
      ctx.endDate +
      "'";
  var query =
    'SELECT ' +
    parsed.names.join(', ') +
    ' FROM ' +
    parsed.resource +
    (where ? ' WHERE ' + where : '') +
    (parsed.orderBy ? ' ORDER BY ' + parsed.orderBy : '') +
    (parsed.limit ? ' LIMIT ' + parsed.limit : '') +
    (parsed.parameters ? ' PARAMETERS ' + parsed.parameters : '');
  var path = 'customers/' + connection.id + '/googleAds:search';
  var raw = dmvGoogleAdsPages_(ctx, connection, path, query, ctx.maxRows);
  var account = {};
  if (
    columns.some(function (column) {
      return column.type === 'currency';
    })
  )
    account =
      (
        dmvGoogleAdsPages_(
          ctx,
          connection,
          path,
          'SELECT customer.currency_code, customer.time_zone FROM customer LIMIT 1',
          1
        )[0] || {}
      ).customer || {};
  return {
    columns: columns,
    rows: raw.map(function (item) {
      var row = {};
      columns.forEach(function (column) {
        var value = column.key.split('.').reduce(function (object, key) {
          var camel = key.replace(/_([a-z])/g, function (_, letter) {
            return letter.toUpperCase();
          });
          return object === null || object === undefined ? undefined : object[camel];
        }, item);
        row[column.key] =
          value !== null && typeof value === 'object'
            ? JSON.stringify(value)
            : dmvGoogleAdsValue_(item, column);
      });
      return row;
    }),
    metadata: {
      apiVersion: 'v25',
      accountId: connection.id,
      currency: account.currencyCode || '',
      timeZone: account.timeZone || '',
      grain: 'Custom GAQL query FROM ' + parsed.resource,
      dateFiltered: dated,
      complete: true,
    },
  };
}

// discover_fields for a custom query: "resources" lists what can follow FROM; "FROM x" (or a
// whole query) lists that resource's attributes plus the metrics and segments it supports.
function dmvGoogleAdsQueryDiscover_(ctx) {
  var connection = dmvGoogleAdsConnection_(ctx);
  var text = String(ctx.config.gaql || '');
  var from = /\bFROM\s+([a-z_]+)/i.exec(text) || /^\s*([a-z_]+)\s*$/i.exec(text);
  var resource = from && from[1].toLowerCase() !== 'resources' ? from[1].toLowerCase() : '';
  function search(query) {
    return dmvGoogleAdsPages_(ctx, connection, 'googleAdsFields:search', query, 2000);
  }
  if (!resource)
    return search("SELECT name WHERE category = 'RESOURCE'").map(function (row) {
      return { key: String(row.name), label: 'Resource for FROM', type: 'text' };
    });
  var attributes = search(
    "SELECT name, selectable, is_repeated WHERE name LIKE '" + resource + ".%'"
  ).filter(function (row) {
    return row.selectable === true;
  });
  var related = search("SELECT name, selectable_with WHERE name = '" + resource + "'")[0];
  if (!related)
    throw new Error(
      'Google Ads has no resource named ' + resource + '. Discover "resources" to list them.'
    );
  return attributes
    .map(function (row) {
      return String(row.name);
    })
    .concat(
      (related.selectableWith || []).filter(function (name) {
        return /^(metrics|segments)\./.test(String(name));
      })
    )
    .map(dmvGoogleAdsQueryColumn_);
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

function dmvGoogleAdsDiscoverAccounts_(ctx) {
  var headers = {
    Authorization: 'Bearer ' + dmvBearer_(ctx),
  };
  if (ctx.credentials.developerToken) headers['developer-token'] = ctx.credentials.developerToken;
  var base = 'https://googleads.googleapis.com/v25/';
  var result = ctx.http({ url: base + 'customers:listAccessibleCustomers', headers: headers });
  var resources = result.resourceNames === undefined ? [] : result.resourceNames;
  if (!Array.isArray(resources) || resources.length > 1000)
    throw new Error('Google Ads returned an invalid or oversized account list.');
  var choices = [],
    byId = Object.create(null),
    seen = Object.create(null);
  resources.forEach(function (resource) {
    ctx.checkDeadline();
    var match = /^customers\/(\d{10})$/.exec(String(resource));
    if (!match) throw new Error('Google Ads returned an invalid accessible account.');
    var managerId = match[1];
    if (seen[managerId]) return;
    seen[managerId] = true;
    var accountHeaders = {
      Authorization: headers.Authorization,
      'login-customer-id': managerId,
    };
    if (headers['developer-token']) accountHeaders['developer-token'] = headers['developer-token'];
    var rows = dmvGoogleAdsPages_(
      ctx,
      { base: base, headers: accountHeaders },
      'customers/' + managerId + '/googleAds:search',
      "SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager, customer_client.status FROM customer_client WHERE customer_client.status = 'ENABLED'",
      1000
    );
    rows.forEach(function (row) {
      var customer = row.customerClient;
      if (!customer || !/^\d{10}$/.test(String(customer.id || '')))
        throw new Error('Google Ads returned an invalid client account.');
      if (customer.manager === true || customer.status !== 'ENABLED') return;
      var id = String(customer.id),
        login = id === managerId ? '' : managerId;
      var choice = {
        id: id,
        label:
          String(customer.descriptiveName || 'Google Ads account').slice(0, 160) + ' (' + id + ')',
        credentials: { customerId: id, loginCustomerId: login },
      };
      if (byId[id] !== undefined) {
        if (!login) choices[byId[id]] = choice;
      } else {
        byId[id] = choices.length;
        choices.push(choice);
        if (choices.length > 1000)
          throw new Error('Too many Google Ads accounts to list completely.');
      }
    });
  });
  return choices;
}

function dmvGoogleAdsErrorMessage_(code, body) {
  var details = body && body.error && body.error.details;
  var codes = Object.create(null);
  (Array.isArray(details) ? details : []).slice(0, 20).forEach(function (detail) {
    if (!detail || typeof detail !== 'object') return;
    if (detail['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo') codes[detail.reason] = true;
    if (!Array.isArray(detail.errors)) return;
    detail.errors.slice(0, 20).forEach(function (error) {
      var value = error && error.errorCode;
      if (!value || typeof value !== 'object') return;
      ['authenticationError', 'authorizationError', 'requestError'].forEach(function (kind) {
        if (typeof value[kind] === 'string') codes[value[kind]] = true;
      });
    });
  });
  // A rejected query is explained with Google's own words: they describe the GAQL the user or
  // the chat wrote (an unknown field, a segment that does not fit the resource), never a secret.
  var queryErrors = [];
  (Array.isArray(details) ? details : []).slice(0, 20).forEach(function (detail) {
    (Array.isArray(detail && detail.errors) ? detail.errors : [])
      .slice(0, 5)
      .forEach(function (error) {
        var value = (error && error.errorCode) || {};
        var kind = value.queryError || value.fieldError || value.dateRangeError || value.enumError;
        if (typeof kind === 'string')
          queryErrors.push(
            kind + (error.message ? ': ' + String(error.message).slice(0, 240) : '')
          );
      });
  });
  if (queryErrors.length)
    return (
      'Google Ads rejected the query. ' +
      queryErrors.slice(0, 3).join(' | ') +
      ' GAQL joins conditions with AND only (no parentheses or OR); use discover_fields with "FROM <resource>" to see which fields fit together.'
    );
  // Otherwise only fixed guidance is returned: other provider messages can contain secrets.
  var guidance = {
    ACCESS_TOKEN_SCOPE_INSUFFICIENT:
      'The Google credential lacks the Google Ads scope. Reauthorize its OAuth client with https://www.googleapis.com/auth/adwords and save the new refresh token. A GA4-only grant cannot read Ads.',
    NOT_ADS_USER:
      'The Google identity behind this credential has no Google Ads access. Invite that Google user or the service account email under Google Ads > Admin > Access and security, then retry.',
    OAUTH_TOKEN_EXPIRED:
      'The Google Ads access token has expired. Replace a pasted token, or use a service account key or OAuth client with a refresh token for automatic renewal.',
    OAUTH_TOKEN_INVALID:
      'Google Ads rejected the access token. Choose the correct saved Google credential. In Access token mode, paste a current access token, not a refresh token, developer token, or API key.',
    OAUTH_TOKEN_HEADER_INVALID:
      'The Google Ads access token is malformed. Paste only the token value, without a Bearer prefix, quotes, or line breaks.',
    OAUTH_TOKEN_REVOKED:
      'Google Ads access was revoked. Reauthorize the Google identity with the Ads scope and update the saved credential.',
    OAUTH_TOKEN_DISABLED:
      'Google Ads access was disabled. Check the Google identity and reauthorize it before updating the saved credential.',
    CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION:
      "The credential's Google Cloud project has Google Ads Test access only. Open Google Ads API Overview in that project and apply for Explorer access to use production accounts.",
    USER_PERMISSION_DENIED:
      'These credentials cannot access the selected Google Ads account. Use Find accounts, or grant the identity access. For access through a manager, enter its Manager customer ID.',
    INVALID_LOGIN_CUSTOMER_ID_SERVING_CUSTOMER_ID_COMBINATION:
      'The selected Google Ads manager cannot access this customer. Use Find accounts or correct the customer and manager IDs.',
    CUSTOMER_NOT_FOUND:
      'Google Ads could not find this customer. Check the advertising Customer ID or choose it with Find accounts.',
    CLIENT_CUSTOMER_ID_INVALID:
      'Google Ads rejected the customer ID. Enter the 10-digit advertising account ID, with or without hyphens.',
    CUSTOMER_NOT_ENABLED:
      'This Google Ads customer is not enabled. Complete account setup or reactivate it in Google Ads before connecting.',
    PROJECT_DISABLED:
      "The credential's Google Cloud project cannot access Google Ads API. Enable the API and check its API access level in that project.",
    SERVICE_DISABLED:
      'Enable Google Ads API in the Google Cloud project that owns this credential, then retry.',
    TWO_STEP_VERIFICATION_NOT_ENROLLED:
      'This Google Ads account requires 2-Step Verification. Enable it for the Google identity that authorized this credential.',
    ADVANCED_PROTECTION_NOT_ENROLLED:
      'This Google Ads account requires Advanced Protection. Enroll the Google identity that authorized this credential.',
  };
  var match = Object.keys(guidance).filter(function (key) {
    return codes[key];
  })[0];
  if (match) return 'Google Ads (' + match + '): ' + guidance[match];
  if (code === 401)
    return 'Google Ads could not authenticate this credential (HTTP 401). Check the selected Google credential, its authorization mode and Ads access. Use OAuth client credentials with an Ads-authorized refresh token, or a service account invited to Google Ads.';
  return '';
}

dmvRegisterConnector_({
  id: 'google_ads',
  label: 'Google Ads',
  description:
    'Campaign performance, or any resource with a custom query, in your account currency.',
  category: 'Marketing',
  color: '#4285f4',
  test: dmvGoogleAdsTest_,
  errorMessage: dmvGoogleAdsErrorMessage_,
  allowedHosts: ['googleads.googleapis.com'],
  accountDiscovery: {
    label: 'Google Ads account',
    credentialKeys: ['customerId', 'loginCustomerId'],
  },
  guide: dmvGoogleGuide_({
    apis: 'the Google Ads API',
    access: 'the Google Ads account',
    scope: 'https://www.googleapis.com/auth/adwords',
    grant:
      'Google Ads → Admin → Access and security → invite the service account email (client_email) with Read only access. Production accounts also need Explorer access approved under API Center in that Cloud project.',
    links: [
      {
        label: 'Google Ads API access',
        url: 'https://developers.google.com/google-ads/api/docs/get-started/introduction',
      },
    ],
  }),
  discoverAccounts: dmvGoogleAdsDiscoverAccounts_,
  googleScopes: ['https://www.googleapis.com/auth/adwords'],
  credentialFamily: DMV_GOOGLE_CREDENTIAL,
  authFields: [
    {
      key: 'customerId',
      label: 'Customer ID',
      type: 'text',
      required: true,
      perConnection: true,
      help: 'Your advertising account ID, with or without hyphens.',
    },
    {
      key: 'loginCustomerId',
      label: 'Manager customer ID (optional)',
      type: 'text',
      required: false,
      perConnection: true,
    },
    {
      key: 'developerToken',
      label: 'Legacy developer token (optional)',
      type: 'password',
      required: false,
    },
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
    {
      id: 'youtube_campaign_daily',
      label: 'YouTube video campaigns',
      description:
        'Daily performance of video (YouTube) campaigns: views, view rate, cost per view, quartile completion, spend and conversions.',
      fields: dmvGoogleAdsVideoFields_(),
      configFields: [],
      dateRange: true,
      fetch: dmvGoogleAdsVideoFetch_,
      discoverFields: function (ctx) {
        return dmvGoogleAdsDiscover_(ctx, dmvGoogleAdsVideoFields_());
      },
    },
    {
      id: 'custom_query',
      label: 'Custom query (GAQL)',
      description:
        'Any Google Ads resource in one GAQL query: customer (account totals), campaign, ad_group, ad_group_ad (ads), keyword_view, search_term_view, campaign_criterion or ad_group_criterion (negative keywords: WHERE campaign_criterion.negative = TRUE), asset_group, geographic_view, age_range_view, gender_view, landing_page_view. Select segments.date only for a daily trend; without it rows are totals for the date range, which keeps reports small. Money fields (*_micros, average costs) arrive in account currency.',
      fields: [],
      configFields: [
        {
          key: 'gaql',
          label: 'GAQL query',
          type: 'textarea',
          required: true,
          help: 'SELECT fields FROM resource [WHERE ...] [ORDER BY ...] [LIMIT n]. Leave dates out: the report date range is applied whenever metrics or segments are selected. For discover_fields pass "resources" to list resources, or "FROM ad_group" to list the fields of one.',
        },
      ],
      dateRange: true,
      fetch: dmvGoogleAdsQueryFetch_,
      discoverFields: dmvGoogleAdsQueryDiscover_,
    },
  ],
});
