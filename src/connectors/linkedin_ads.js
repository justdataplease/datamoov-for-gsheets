/** LinkedIn Marketing API adAnalytics, campaign pivot at daily granularity. Read-only. */
var DMV_LINKEDIN_VERSION = '202606';

function dmvLinkedinFields_() {
  var f = dmvField_;
  return [
    f('date', 'Date', 'date', true, { role: 'dimension' }),
    f('campaign_id', 'Campaign ID', 'text', true, { role: 'dimension' }),
    f('campaign_name', 'Campaign', 'text', true, { role: 'dimension' }),
    f('impressions', 'Impressions', 'number', true, { role: 'metric' }),
    f('clicks', 'Clicks', 'number', true, { role: 'metric' }),
    f('costInLocalCurrency', 'Spend', 'currency', true, { role: 'metric' }),
    f('landingPageClicks', 'Landing page clicks', 'number', false, { role: 'metric' }),
    f('externalWebsiteConversions', 'Conversions', 'number', true, { role: 'metric' }),
    f('conversionValueInLocalCurrency', 'Conversion value', 'currency', false, {
      role: 'metric',
    }),
    f('oneClickLeads', 'Lead form leads', 'number', false, { role: 'metric' }),
    f('likes', 'Likes', 'number', false, { role: 'metric' }),
    f('comments', 'Comments', 'number', false, { role: 'metric' }),
    f('shares', 'Shares', 'number', false, { role: 'metric' }),
    f('follows', 'Follows', 'number', false, { role: 'metric' }),
    f('totalEngagements', 'Total engagements', 'number', false, { role: 'metric' }),
    f('videoViews', 'Video views', 'number', false, { role: 'metric' }),
    f('videoCompletions', 'Video completions', 'number', false, { role: 'metric' }),
  ];
}

function dmvLinkedinToken_(ctx) {
  var credentials = ctx.credentials || {};
  if ((credentials.authMode || 'token') === 'oauth')
    return dmvOAuthRefreshToken_(
      { label: 'LinkedIn OAuth', endpoint: 'https://www.linkedin.com/oauth/v2/accessToken' },
      credentials,
      ctx.deadline,
      ctx.rotateCredentials
    );
  var token = String(credentials.accessToken || '').trim();
  if (!token)
    throw new Error('Enter a LinkedIn access token with r_ads and r_ads_reporting access.');
  return token;
}

function dmvLinkedinConnection_(ctx) {
  var id = String((ctx.credentials || {}).accountId || '')
    .replace(/^urn:li:sponsoredAccount:/, '')
    .trim();
  if (!/^\d{1,20}$/.test(id)) throw new Error('Enter a numeric LinkedIn ad account ID.');
  return {
    id: id,
    base: 'https://api.linkedin.com/rest/',
    headers: {
      Authorization: 'Bearer ' + dmvLinkedinToken_(ctx),
      'Linkedin-Version': DMV_LINKEDIN_VERSION,
      'X-Restli-Protocol-Version': '2.0.0',
    },
  };
}

function dmvLinkedinDate_(value) {
  var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  return (
    '(year:' + Number(match[1]) + ',month:' + Number(match[2]) + ',day:' + Number(match[3]) + ')'
  );
}

function dmvLinkedinAccount_(ctx, connection) {
  var account = ctx.http({
    url: connection.base + 'adAccounts/' + connection.id,
    headers: connection.headers,
  });
  if (!account || String(account.id) !== connection.id)
    throw new Error('LinkedIn did not return the requested ad account.');
  return account;
}

function dmvLinkedinCampaignNames_(ctx, connection) {
  var names = Object.create(null),
    token = '',
    pages = 0,
    seen = Object.create(null);
  do {
    ctx.checkDeadline();
    if (++pages > 50) throw new Error('LinkedIn returned too many campaign pages.');
    var url =
      connection.base + 'adAccounts/' + connection.id + '/adCampaigns?q=search&pageSize=1000';
    if (token) url += '&pageToken=' + encodeURIComponent(token);
    var payload = ctx.http({ url: url, headers: connection.headers });
    if (!payload || !Array.isArray(payload.elements))
      throw new Error('LinkedIn returned an invalid campaign list.');
    payload.elements.forEach(function (campaign) {
      if (campaign && campaign.id !== undefined)
        names[String(campaign.id)] = dmvTextValue_(campaign.name);
    });
    token = (payload.metadata && payload.metadata.nextPageToken) || '';
    if (typeof token !== 'string' || (token && seen[token]))
      throw new Error('LinkedIn returned an invalid or repeated campaign page token.');
    if (token) seen[token] = true;
  } while (token);
  return names;
}

function dmvLinkedinFetch_(ctx) {
  var columns = dmvSelectFields_(ctx.fields, dmvLinkedinFields_());
  var connection = dmvLinkedinConnection_(ctx);
  var account = dmvLinkedinAccount_(ctx, connection);
  var metrics = columns
    .filter(function (field) {
      return field.role === 'metric';
    })
    .map(function (field) {
      return field.key;
    });
  if (!metrics.length) metrics.push('impressions');
  var fields = ['dateRange', 'pivotValues'].concat(metrics);
  if (fields.length > 20) throw new Error('LinkedIn reports support at most 18 metrics.');
  var url =
    connection.base +
    'adAnalytics?q=analytics&pivot=CAMPAIGN&timeGranularity=DAILY' +
    '&dateRange=(start:' +
    dmvLinkedinDate_(ctx.startDate) +
    ',end:' +
    dmvLinkedinDate_(ctx.endDate) +
    ')' +
    '&accounts=List(' +
    encodeURIComponent('urn:li:sponsoredAccount:' + connection.id) +
    ')' +
    '&fields=' +
    fields.join(',');
  var payload = ctx.http({ url: url, headers: connection.headers });
  if (!payload || !Array.isArray(payload.elements))
    throw new Error('LinkedIn returned an invalid analytics response.');
  if (payload.elements.length >= 15000)
    throw new Error(
      'LinkedIn returned its 15,000-element maximum; the report may be incomplete. Narrow the date range.'
    );
  var wantNames = columns.some(function (field) {
    return field.key === 'campaign_name';
  });
  var names = wantNames ? dmvLinkedinCampaignNames_(ctx, connection) : null;
  var seen = Object.create(null),
    rows = [];
  var mapped = payload.elements.map(function (element) {
    var start = element.dateRange && element.dateRange.start;
    if (!start || !start.year) throw new Error('LinkedIn returned a row without a date.');
    var date = start.year + '-' + ('0' + start.month).slice(-2) + '-' + ('0' + start.day).slice(-2);
    var pivot = Array.isArray(element.pivotValues) ? String(element.pivotValues[0] || '') : '';
    var match = /^urn:li:sponsoredCampaign:(\d+)$/.exec(pivot);
    if (!match) throw new Error('LinkedIn returned a row without a campaign.');
    var id = match[1];
    if (seen[id + ':' + date]) throw new Error('LinkedIn returned duplicate campaign days.');
    seen[id + ':' + date] = true;
    var row = {};
    columns.forEach(function (field) {
      if (field.key === 'date') row.date = date;
      else if (field.key === 'campaign_id') row.campaign_id = id;
      else if (field.key === 'campaign_name')
        row.campaign_name = names[id] === undefined ? null : names[id];
      else
        row[field.key] = dmvNumber_(element[field.key] === undefined ? null : element[field.key]);
    });
    return row;
  });
  dmvAppendPage_(rows, mapped, ctx.maxRows);
  return {
    columns: columns,
    rows: rows,
    metadata: {
      apiVersion: DMV_LINKEDIN_VERSION,
      accountId: connection.id,
      currency: account.currency || '',
      timeZone: 'UTC',
      attribution: 'LinkedIn campaign attribution; approximate metrics per LinkedIn privacy rules.',
      grain: 'Daily campaign',
      note: 'Days without delivery are omitted by LinkedIn.',
      complete: true,
    },
  };
}

dmvRegisterConnector_({
  id: 'linkedin_ads',
  label: 'LinkedIn Ads',
  description: 'Daily campaign impressions, clicks, spend, conversions and engagement.',
  category: 'Marketing',
  color: '#0a66c2',
  allowedHosts: ['api.linkedin.com'],
  guide: {
    intro:
      'LinkedIn requires a developer app with the Advertising API product before any token works.',
    steps: [
      'LinkedIn Developers → Create app (linked to your company page) → Products → request Advertising API.',
      'Auth tab → OAuth 2.0 tools → generate a token with r_ads and r_ads_reporting (account and campaign names need r_ads); paste it as the access token (valid 60 days).',
      'For automatic renewal use the app client ID and secret with a refresh token obtained through the same tool (programmatic refresh must be enabled for the app).',
      'The ad account ID is the number shown under the account name in Campaign Manager.',
    ],
    links: [
      { label: 'LinkedIn apps', url: 'https://www.linkedin.com/developers/apps' },
      { label: 'OAuth token tool', url: 'https://www.linkedin.com/developers/tools/oauth' },
    ],
  },
  authFields: [
    {
      key: 'accountId',
      label: 'Ad account ID',
      type: 'text',
      required: true,
      perConnection: true,
      help: 'The numeric sponsored account ID from Campaign Manager.',
    },
    {
      key: 'authMode',
      label: 'Authorization',
      type: 'select',
      default: 'token',
      options: [
        { value: 'token', label: 'Access token' },
        { value: 'oauth', label: 'OAuth client credentials' },
      ],
    },
    {
      key: 'accessToken',
      label: 'Access token',
      type: 'password',
      required: true,
      showWhen: { key: 'authMode', value: 'token' },
      help: 'An OAuth 2.0 token with r_ads and r_ads_reporting. LinkedIn tokens expire after 60 days; replace it when it does.',
    },
    {
      key: 'clientId',
      label: 'OAuth client ID',
      type: 'text',
      required: true,
      showWhen: { key: 'authMode', value: 'oauth' },
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
      help: 'A refresh token issued to this client with r_ads and r_ads_reporting. DataMoov obtains access tokens automatically and keeps the replacement refresh token LinkedIn issues.',
    },
  ],
  test: function (ctx) {
    dmvLinkedinAccount_(ctx, dmvLinkedinConnection_(ctx));
  },
  reports: [
    {
      id: 'campaign_daily',
      label: 'Daily campaign performance',
      description:
        'Impressions, clicks, spend, conversions and engagement per campaign per day, in the account currency.',
      fields: dmvLinkedinFields_(),
      configFields: [],
      dateRange: true,
      fetch: dmvLinkedinFetch_,
    },
  ],
});
