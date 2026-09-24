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
  // Search Console returns at most 25,000 rows per request, so pages advance by startRow until
  // a short page. Fetching one row past the limit detects overflow instead of truncating.
  var rows = [];
  var wanted = ctx.maxRows + 1;
  for (var startRow = 0; startRow < wanted;) {
    ctx.checkDeadline();
    var rowLimit = Math.min(25000, wanted - startRow);
    var payload = ctx.http({
      url: connection.base + '/searchAnalytics/query',
      method: 'post',
      retrySafe: true,
      headers: connection.headers,
      body: {
        startDate: ctx.startDate,
        endDate: ctx.endDate,
        dimensions: dimensions,
        rowLimit: rowLimit,
        startRow: startRow,
        type: 'web',
      },
    });
    if (!payload || payload.error) throw new Error('Search Console did not return a report.');
    var page = payload.rows === undefined ? [] : payload.rows;
    if (!Array.isArray(page)) throw new Error('Search Console returned invalid rows.');
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
    if (page.length < rowLimit) break;
    startRow += page.length;
  }
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
  icon: {
    viewBox: '0 0 24 24',
    shapes: [
      {
        d: 'M8.548 1.156L6.832 2.872v1.682h1.716zm0 3.398v.035H6.832v-.035H3.386L0 7.844v3.577h2.826V8.94c0-.525.429-.954.954-.954h16.476c.525 0 .954.43.954.954v2.48h2.754V7.844l-3.386-3.29H17.3v.035h-1.717v-.035zm7.035 0H17.3V2.872l-1.717-1.716zM8.679 1.188V2.84h6.773V1.188zm11.471 7.07a.834.834 0 00-.132.01l-.543.002c-5.216.014-10.432-.008-15.648.01-.435-.063-.794.436-.716.883v2.264h17.812c-.016-.888.045-1.782-.034-2.666-.104-.342-.427-.502-.739-.502zm-15.422.634a.689.698 0 01.689.698.689.698 0 01-.689.697.689.698 0 01-.688-.697.689.698 0 01.688-.698zm2.134 0a.689.698 0 01.689.698.689.698 0 01-.689.697.689.698 0 01-.688-.697.689.698 0 01.688-.698zM.036 11.645v9.156c0 1.05.858 1.908 1.907 1.908h.883V11.645zm21.174 0v11.064h.882c1.05 0 1.908-.858 1.908-1.908v-9.156zM4.057 13.133v6.85h6.137v-6.85zm13.243.021v3.777l-1.708.977-1.708-.977v-3.758a4.006 4.006 0 000 7.23v2.441h3.457v-2.442a4.006 4.006 0 00-.041-7.248zm-13.243 8.26v1.43h7.925v-1.43z',
        fill: '#4285f4',
      },
    ],
  },
  allowedHosts: ['searchconsole.googleapis.com', 'www.googleapis.com'],
  googleScopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
  credentialFamily: DMV_GOOGLE_CREDENTIAL,
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
      perConnection: true,
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
