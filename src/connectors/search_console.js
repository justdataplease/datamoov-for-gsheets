/** Google Search Console Search Analytics; site discovery through the Sites list. */
function dmvSearchConsoleFields_() {
  var f = dmvField_;
  return [
    f('date', 'Date', 'date', true, { role: 'dimension' }),
    f('query', 'Query', 'text', true, { role: 'dimension' }),
    f('page', 'Page', 'text', false, { role: 'dimension' }),
    f('country', 'Country', 'text', false, { role: 'dimension' }),
    f('device', 'Device', 'text', false, { role: 'dimension' }),
    f('clicks', 'Clicks', 'number', true, { role: 'metric' }),
    f('impressions', 'Impressions', 'number', true, { role: 'metric' }),
    f('ctr', 'CTR', 'percent', true, { role: 'metric' }),
    f('position', 'Average position', 'number', true, { role: 'metric' }),
  ];
}

function dmvSearchConsoleConnection_(ctx) {
  var site = String((ctx.credentials || {}).siteUrl || '').trim();
  if (!/^(sc-domain:[a-z0-9.-]+|https?:\/\/[^\s/]+\/?[^\s]*)$/i.test(site))
    throw new Error(
      'Enter a Search Console property such as sc-domain:example.com or https://example.com/.'
    );
  return {
    site: site,
    base: 'https://searchconsole.googleapis.com/webmasters/v3/sites/' + encodeURIComponent(site),
    headers: { Authorization: 'Bearer ' + dmvBearer_(ctx) },
  };
}

function dmvSearchConsoleFetch_(ctx) {
  var columns = dmvSelectFields_(ctx.fields, dmvSearchConsoleFields_());
  var connection = dmvSearchConsoleConnection_(ctx);
  var dimensions = columns
    .filter(function (field) {
      return field.role === 'dimension';
    })
    .map(function (field) {
      return field.key;
    });
  // One request covers the 20,000-row maximum; one extra row detects overflow.
  ctx.checkDeadline();
  var payload = ctx.http({
    url: connection.base + '/searchAnalytics/query',
    method: 'post',
    retrySafe: true,
    headers: connection.headers,
    body: {
      startDate: ctx.startDate,
      endDate: ctx.endDate,
      dimensions: dimensions,
      rowLimit: Math.min(25000, ctx.maxRows + 1),
      startRow: 0,
      type: 'web',
    },
  });
  if (!payload || payload.error) throw new Error('Search Console did not return a report.');
  var page = payload.rows === undefined ? [] : payload.rows;
  if (!Array.isArray(page)) throw new Error('Search Console returned invalid rows.');
  var rows = [];
  dmvAppendPage_(
    rows,
    page.map(function (item) {
      if (
        dimensions.length &&
        (!Array.isArray(item.keys) || item.keys.length !== dimensions.length)
      )
        throw new Error('Search Console returned a malformed row.');
      var row = {};
      columns.forEach(function (field) {
        if (field.role === 'dimension')
          row[field.key] = dmvTextValue_(item.keys[dimensions.indexOf(field.key)]);
        else row[field.key] = dmvNumber_(item[field.key]);
      });
      return row;
    }),
    ctx.maxRows
  );
  return {
    columns: columns,
    rows: rows,
    metadata: {
      apiVersion: 'v3',
      site: connection.site,
      timeZone: 'America/Los_Angeles',
      attribution: 'Search Console web search data; anonymized queries are omitted by Google.',
      grain: dimensions.length ? 'By ' + dimensions.join(', ') : 'Total',
      complete: true,
    },
  };
}

function dmvSearchConsoleDiscoverAccounts_(ctx) {
  var payload = ctx.http({
    url: 'https://www.googleapis.com/webmasters/v3/sites',
    headers: { Authorization: 'Bearer ' + dmvBearer_(ctx) },
  });
  var entries = payload && payload.siteEntry === undefined ? [] : payload && payload.siteEntry;
  if (!Array.isArray(entries)) throw new Error('Search Console returned an invalid property list.');
  return entries
    .filter(function (entry) {
      return entry && entry.siteUrl && entry.permissionLevel !== 'siteUnverifiedUser';
    })
    .map(function (entry) {
      return {
        id: String(entry.siteUrl),
        label: String(entry.siteUrl) + ' (' + String(entry.permissionLevel || 'user') + ')',
        credentials: { siteUrl: String(entry.siteUrl) },
      };
    });
}

dmvRegisterConnector_({
  id: 'search_console',
  label: 'Search Console',
  description: 'Clicks, impressions, CTR and position by query, page, country or device.',
  category: 'Marketing',
  color: '#34a853',
  allowedHosts: ['searchconsole.googleapis.com', 'www.googleapis.com'],
  googleScopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
  accountDiscovery: {
    label: 'Search Console property',
    credentialKeys: ['siteUrl'],
  },
  guide: dmvGoogleGuide_({
    apis: 'the Google Search Console API',
    access: 'the Search Console property',
    scope: 'https://www.googleapis.com/auth/webmasters.readonly',
    grant:
      'Search Console → Settings → Users and permissions → add the service account email (client_email) with Restricted permission.',
    links: [
      {
        label: 'Search Console users',
        url: 'https://support.google.com/webmasters/answer/7687615',
      },
    ],
  }),
  discoverAccounts: dmvSearchConsoleDiscoverAccounts_,
  test: function (ctx) {
    var connection = dmvSearchConsoleConnection_(ctx);
    var sites = dmvSearchConsoleDiscoverAccounts_(ctx);
    if (
      !sites.some(function (site) {
        return site.id === connection.site;
      })
    )
      throw new Error('These credentials cannot access the requested Search Console property.');
  },
  authFields: [
    {
      key: 'siteUrl',
      label: 'Property',
      type: 'text',
      required: true,
      help: 'A domain property (sc-domain:example.com) or URL-prefix property (https://example.com/).',
    },
  ].concat(
    dmvGoogleAuthFields_('Grant this service account access to the property in Search Console.')
  ),
  reports: [
    {
      id: 'search_performance',
      label: 'Search performance',
      description:
        'Web search clicks, impressions, CTR and average position for the selected dimensions. Choose fewer dimensions for totals.',
      fields: dmvSearchConsoleFields_(),
      configFields: [],
      dateRange: true,
      fetch: dmvSearchConsoleFetch_,
    },
  ],
});
