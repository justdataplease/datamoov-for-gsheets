/** LinkedIn Marketing API adAnalytics: any pivot and period, names resolved. Read-only. */
var DMV_LINKEDIN_VERSION = '202606';

// Columns that become adAnalytics pivots. LinkedIn groups by at most three of them.
var DMV_LINKEDIN_PIVOTS = {
  campaign_group_id: 'CAMPAIGN_GROUP',
  campaign_group_name: 'CAMPAIGN_GROUP',
  campaign_id: 'CAMPAIGN',
  campaign_name: 'CAMPAIGN',
  creative_id: 'CREATIVE',
  company: 'MEMBER_COMPANY',
  company_size: 'MEMBER_COMPANY_SIZE',
  industry: 'MEMBER_INDUSTRY',
  seniority: 'MEMBER_SENIORITY',
  job_title: 'MEMBER_JOB_TITLE',
  job_function: 'MEMBER_JOB_FUNCTION',
  country: 'MEMBER_COUNTRY_V2',
  region: 'MEMBER_REGION_V2',
  placement: 'PLACEMENT_NAME',
  device: 'IMPRESSION_DEVICE_TYPE',
};

// Computed here from the counts LinkedIn returns; the API has no such fields.
var DMV_LINKEDIN_RATIOS = {
  ctr: ['clicks', 'impressions', 1],
  cpc: ['costInLocalCurrency', 'clicks', 1],
  cpm: ['costInLocalCurrency', 'impressions', 1000],
};

// LinkedIn leaves these out of professional demographic (MEMBER_) reports.
var DMV_LINKEDIN_NOT_DEMOGRAPHIC = ['conversionValueInLocalCurrency', 'approximateMemberReach'];

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

function dmvLinkedinAnalyticsFields_() {
  var f = dmvField_,
    dimension = { role: 'dimension' },
    metric = { role: 'metric' },
    single = { role: 'metric', additive: false };
  return [
    f('date', 'Date', 'date', true, dimension),
    f('month', 'Month', 'date', false, dimension),
    f('campaign_group_name', 'Campaign group', 'text', false, dimension),
    f('campaign_name', 'Campaign', 'text', true, dimension),
    f('creative_id', 'Creative ID', 'text', false, dimension),
    f('campaign_group_id', 'Campaign group ID', 'text', false, dimension),
    f('campaign_id', 'Campaign ID', 'text', false, dimension),
    f('company', 'Company', 'text', false, dimension),
    f('company_size', 'Company size', 'text', false, dimension),
    f('industry', 'Industry', 'text', false, dimension),
    f('seniority', 'Seniority', 'text', false, dimension),
    f('job_title', 'Job title', 'text', false, dimension),
    f('job_function', 'Job function', 'text', false, dimension),
    f('country', 'Country', 'text', false, dimension),
    f('region', 'Region', 'text', false, dimension),
    f('placement', 'Placement', 'text', false, dimension),
    f('device', 'Device', 'text', false, dimension),
    f('impressions', 'Impressions', 'number', true, metric),
    f('clicks', 'Clicks', 'number', true, metric),
    f('costInLocalCurrency', 'Spend', 'currency', true, metric),
    f('costInUsd', 'Spend (USD)', 'number', false, metric),
    f('ctr', 'CTR', 'percent', false, single),
    f('cpc', 'CPC', 'currency', false, single),
    f('cpm', 'CPM', 'currency', false, single),
    f('approximateMemberReach', 'Reach (approximate)', 'number', false, single),
    f('landingPageClicks', 'Landing page clicks', 'number', false, metric),
    f('externalWebsiteConversions', 'Conversions', 'number', true, metric),
    f('externalWebsitePostClickConversions', 'Post-click conversions', 'number', false, metric),
    f('externalWebsitePostViewConversions', 'View-through conversions', 'number', false, metric),
    f('conversionValueInLocalCurrency', 'Conversion value', 'currency', false, metric),
    f('oneClickLeads', 'Lead form leads', 'number', false, metric),
    f('oneClickLeadFormOpens', 'Lead form opens', 'number', false, metric),
    f('qualifiedLeads', 'Qualified leads', 'number', false, metric),
    f('totalEngagements', 'Total engagements', 'number', false, metric),
    f('reactions', 'Reactions', 'number', false, metric),
    f('likes', 'Likes', 'number', false, metric),
    f('comments', 'Comments', 'number', false, metric),
    f('shares', 'Shares', 'number', false, metric),
    f('follows', 'Follows', 'number', false, metric),
    f('companyPageClicks', 'Company page clicks', 'number', false, metric),
    f('otherEngagements', 'Other engagements', 'number', false, metric),
    f('videoStarts', 'Video starts', 'number', false, metric),
    f('videoViews', 'Video views', 'number', false, metric),
    f('videoFirstQuartileCompletions', 'Video plays at 25%', 'number', false, metric),
    f('videoMidpointCompletions', 'Video plays at 50%', 'number', false, metric),
    f('videoThirdQuartileCompletions', 'Video plays at 75%', 'number', false, metric),
    f('videoCompletions', 'Video completions', 'number', false, metric),
    f('sends', 'Message sends', 'number', false, metric),
    f('opens', 'Message opens', 'number', false, metric),
    f('actionClicks', 'Message button clicks', 'number', false, metric),
    f('documentCompletions', 'Document completions', 'number', false, metric),
    f('jobApplications', 'Job applications', 'number', false, metric),
    f('registrations', 'Event registrations', 'number', false, metric),
    f('viralImpressions', 'Viral impressions', 'number', false, metric),
    f('viralClicks', 'Viral clicks', 'number', false, metric),
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

// Names of the account's campaigns ("adCampaigns") or campaign groups ("adCampaignGroups") by id.
function dmvLinkedinNames_(ctx, connection, collection) {
  var names = Object.create(null),
    token = '',
    pages = 0,
    seen = Object.create(null);
  do {
    ctx.checkDeadline();
    if (++pages > 50) throw new Error('LinkedIn returned too many campaign pages.');
    var url =
      connection.base +
      'adAccounts/' +
      connection.id +
      '/' +
      (collection || 'adCampaigns') +
      '?q=search&pageSize=1000';
    if (token) url += '&pageToken=' + encodeURIComponent(token);
    var payload = ctx.http({ url: url, headers: connection.headers });
    if (!payload || !Array.isArray(payload.elements))
      throw new Error('LinkedIn returned an invalid campaign list.');
    payload.elements.forEach(function (item) {
      if (item && item.id !== undefined) names[String(item.id)] = dmvTextValue_(item.name);
    });
    token = (payload.metadata && payload.metadata.nextPageToken) || '';
    if (typeof token !== 'string' || (token && seen[token]))
      throw new Error('LinkedIn returned an invalid or repeated campaign page token.');
    if (token) seen[token] = true;
  } while (token);
  return names;
}

// Names of companies, industries, titles, places and other targeting values, by URN.
function dmvLinkedinEntityNames_(ctx, connection, urns) {
  var names = Object.create(null);
  for (var start = 0; start < urns.length; start += 50) {
    ctx.checkDeadline();
    var payload = ctx.http({
      url:
        connection.base +
        'adTargetingEntities?q=urns&urns=List(' +
        urns
          .slice(start, start + 50)
          .map(encodeURIComponent)
          .join(',') +
        ')',
      headers: connection.headers,
    });
    ((payload && payload.elements) || []).forEach(function (item) {
      if (item && item.urn && item.name) names[String(item.urn)] = String(item.name);
    });
  }
  return names;
}

// One engine for both reports. "fixed" is the original daily campaign report; otherwise the
// selected columns decide the pivots and the period.
function dmvLinkedinAnalytics_(ctx, available, fixed) {
  var columns = dmvSelectFields_(ctx.fields, available);
  var connection = dmvLinkedinConnection_(ctx);
  var account = dmvLinkedinAccount_(ctx, connection);
  var has = function (key) {
    return columns.some(function (field) {
      return field.key === key;
    });
  };
  if (has('date') && has('month')) throw new Error('Choose Date or Month, not both.');
  var granularity = fixed || has('date') ? 'DAILY' : has('month') ? 'MONTHLY' : 'ALL';
  var pivots = fixed ? ['CAMPAIGN'] : [];
  columns.forEach(function (field) {
    var pivot = DMV_LINKEDIN_PIVOTS[field.key];
    if (pivot && pivots.indexOf(pivot) < 0) pivots.push(pivot);
  });
  if (pivots.length > 3)
    throw new Error(
      'LinkedIn groups a report by at most three of campaign group, campaign, creative and the audience columns. Select fewer.'
    );
  var demographic = pivots.some(function (pivot) {
    return pivot.indexOf('MEMBER_') === 0;
  });
  var blocked = DMV_LINKEDIN_NOT_DEMOGRAPHIC.filter(has);
  if (demographic && blocked.length)
    throw new Error(
      'LinkedIn does not report ' +
        blocked.join(' or ') +
        ' by company, industry, job or location. Remove it or the audience column.'
    );
  var metrics = [];
  columns.forEach(function (field) {
    (DMV_LINKEDIN_RATIOS[field.key]
      ? DMV_LINKEDIN_RATIOS[field.key].slice(0, 2)
      : field.role === 'metric'
        ? [field.key]
        : []
    ).forEach(function (name) {
      if (metrics.indexOf(name) < 0) metrics.push(name);
    });
  });
  if (!metrics.length) metrics.push('impressions');
  if (metrics.length > 18) throw new Error('LinkedIn reports support at most 18 metrics.');
  var url =
    connection.base +
    'adAnalytics?q=' +
    (pivots.length > 1
      ? 'statistics&pivots=List(' + pivots.join(',') + ')'
      : 'analytics&pivot=' + (pivots[0] || 'ACCOUNT')) +
    '&timeGranularity=' +
    granularity +
    '&dateRange=(start:' +
    dmvLinkedinDate_(ctx.startDate) +
    ',end:' +
    dmvLinkedinDate_(ctx.endDate) +
    ')' +
    '&accounts=List(' +
    encodeURIComponent('urn:li:sponsoredAccount:' + connection.id) +
    ')' +
    '&fields=' +
    ['dateRange', 'pivotValues'].concat(metrics).join(',');
  var payload = ctx.http({ url: url, headers: connection.headers });
  if (!payload || !Array.isArray(payload.elements))
    throw new Error('LinkedIn returned an invalid analytics response.');
  if (payload.elements.length >= 15000)
    throw new Error(
      'LinkedIn returned its 15,000-element maximum; the report may be incomplete. Narrow the date range.'
    );
  var campaigns = has('campaign_name') ? dmvLinkedinNames_(ctx, connection, 'adCampaigns') : {};
  var groups = has('campaign_group_name')
    ? dmvLinkedinNames_(ctx, connection, 'adCampaignGroups')
    : {};
  // Audience values arrive as URNs; their names come from one lookup per fifty values.
  var urns = [],
    listed = Object.create(null),
    note = '';
  if (demographic)
    payload.elements.forEach(function (element) {
      (element.pivotValues || []).forEach(function (value, position) {
        value = String(value);
        if (
          String(pivots[position]).indexOf('MEMBER_') === 0 &&
          /^urn:li:/.test(value) &&
          !listed[value]
        ) {
          listed[value] = true;
          urns.push(value);
        }
      });
    });
  var entities = {};
  try {
    if (urns.length) entities = dmvLinkedinEntityNames_(ctx, connection, urns.slice(0, 2000));
  } catch (error) {
    note = 'LinkedIn did not return names for the audience values, so their IDs are shown.';
  }
  var seen = Object.create(null),
    rows = [];
  var mapped = payload.elements.map(function (element) {
    var start = element.dateRange && element.dateRange.start;
    if (granularity !== 'ALL' && (!start || !start.year))
      throw new Error('LinkedIn returned a row without a date.');
    var date =
      start && start.year
        ? start.year +
          '-' +
          ('0' + start.month).slice(-2) +
          '-' +
          ('0' + (start.day || 1)).slice(-2)
        : '';
    var values = Array.isArray(element.pivotValues) ? element.pivotValues.map(String) : [];
    if (fixed && !/^urn:li:sponsoredCampaign:\d+$/.test(values[0] || ''))
      throw new Error('LinkedIn returned a row without a campaign.');
    var key = date + '|' + values.join('|');
    if (seen[key]) throw new Error('LinkedIn returned duplicate rows.');
    seen[key] = true;
    var row = {};
    columns.forEach(function (field) {
      var pivot = DMV_LINKEDIN_PIVOTS[field.key],
        ratio = DMV_LINKEDIN_RATIOS[field.key];
      if (field.key === 'date') row.date = date;
      else if (field.key === 'month') row.month = date.slice(0, 7) + '-01';
      else if (pivot) {
        var value = values[pivots.indexOf(pivot)];
        var id = value === undefined ? null : value.replace(/^urn:li:[A-Za-z]+:/, '');
        row[field.key] =
          id === null
            ? null
            : field.key === 'campaign_name'
              ? campaigns[id] === undefined
                ? null
                : campaigns[id]
              : field.key === 'campaign_group_name'
                ? groups[id] === undefined
                  ? null
                  : groups[id]
                : entities[value] || id;
      } else if (ratio) {
        var top = dmvNumber_(element[ratio[0]] === undefined ? null : element[ratio[0]]),
          bottom = dmvNumber_(element[ratio[1]] === undefined ? null : element[ratio[1]]);
        row[field.key] = bottom ? ((top || 0) / bottom) * ratio[2] : null;
      } else
        row[field.key] = dmvNumber_(element[field.key] === undefined ? null : element[field.key]);
    });
    return row;
  });
  // Without a period the rows are a ranking, so the biggest spenders come first.
  if (granularity === 'ALL' && has('costInLocalCurrency'))
    mapped.sort(function (a, b) {
      return (b.costInLocalCurrency || 0) - (a.costInLocalCurrency || 0);
    });
  dmvAppendPage_(rows, mapped, ctx.maxRows);
  var metadata = {
    apiVersion: DMV_LINKEDIN_VERSION,
    accountId: connection.id,
    currency: account.currency || '',
    timeZone: 'UTC',
    attribution: 'LinkedIn campaign attribution; approximate metrics per LinkedIn privacy rules.',
    grain: fixed
      ? 'Daily campaign'
      : (granularity === 'DAILY'
          ? 'Daily'
          : granularity === 'MONTHLY'
            ? 'Monthly'
            : 'Whole period') +
        ' by ' +
        (pivots
          .join(', ')
          .toLowerCase()
          .replace(/member_|_v2/g, '')
          .replace(/_/g, ' ') || 'account'),
    note:
      note ||
      (demographic
        ? 'Audience values are approximate, need at least 3 events and keep the top 100 values per creative per day.'
        : 'Days without delivery are omitted by LinkedIn.'),
    complete: true,
  };
  return { columns: columns, rows: rows, metadata: metadata };
}

function dmvLinkedinFetch_(ctx) {
  return dmvLinkedinAnalytics_(ctx, dmvLinkedinFields_(), true);
}

dmvRegisterConnector_({
  id: 'linkedin_ads',
  label: 'LinkedIn Ads',
  description:
    'Campaign group, campaign and creative performance, and the companies, jobs and places behind it.',
  category: 'Marketing',
  color: '#0a66c2',
  icon: {
    viewBox: '0 0 250 250',
    shapes: [
      {
        d: 'M201.813 30H46.187C36.695 30 29 37.695 29 47.187v155.625C29 212.305 36.695 220 46.187 220h155.625c9.493 0 17.188-7.695 17.188-17.188V47.187C219 37.695 211.305 30 201.813 30ZM87.794 194.059a5.001 5.001 0 0 1-5.002 5.001h-21.29a5.001 5.001 0 0 1-5.002-5.001v-89.251a5.001 5.001 0 0 1 5.001-5.002h21.291a5.001 5.001 0 0 1 5.002 5.002v89.251ZM72.147 91.393c-11.17 0-20.227-9.056-20.227-20.227 0-11.17 9.056-20.226 20.227-20.226 11.17 0 20.227 9.056 20.227 20.226 0 11.171-9.056 20.227-20.227 20.227ZM199.06 194.46a4.599 4.599 0 0 1-4.599 4.599h-22.847a4.599 4.599 0 0 1-4.598-4.599v-41.863c0-6.245 1.831-27.367-16.321-27.367-14.08 0-16.936 14.457-17.51 20.945v48.285a4.599 4.599 0 0 1-4.599 4.599H106.49a4.599 4.599 0 0 1-4.599-4.599v-90.056a4.599 4.599 0 0 1 4.599-4.599h22.096a4.599 4.599 0 0 1 4.599 4.599v7.786c5.221-7.835 12.98-13.883 29.501-13.883 36.583 0 36.374 34.179 36.374 52.958v43.195Z',
        fill: '#0077b7',
      },
    ],
  },
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
    {
      id: 'analytics',
      label: 'Analytics (any level and audience)',
      description:
        'One row per combination of the dimensions you select: campaign group, campaign or creative, and the companies, industries, job titles, seniorities, countries or devices reached (at most three). Date or Month sets the period; with none, rows are totals ranked by spend.',
      fields: dmvLinkedinAnalyticsFields_(),
      configFields: [],
      dateRange: true,
      fetch: function (ctx) {
        return dmvLinkedinAnalytics_(ctx, dmvLinkedinAnalyticsFields_(), false);
      },
    },
  ],
});
