/** Microsoft Advertising (Bing Ads) Reporting API v13 over REST: submit, poll, download a zipped CSV. */
var DMV_MICROSOFT_ADS = {
  base: 'https://reporting.api.bingads.microsoft.com/Reporting/v13/GenerateReport/',
  downloadHosts: ['download.api.bingads.microsoft.com', 'reporting-download.bingads.microsoft.com'],
  pollIntervalMs: 3000,
  maxPolls: 40,
};

function dmvMicrosoftAdsFields_() {
  var f = dmvField_;
  return [
    f('TimePeriod', 'Date', 'date', true, { role: 'dimension' }),
    f('AccountId', 'Account ID', 'text', true, { role: 'dimension' }),
    f('AccountName', 'Account', 'text', false, { role: 'dimension' }),
    f('CurrencyCode', 'Currency', 'text', true, { role: 'dimension' }),
    f('CampaignId', 'Campaign ID', 'text', true, { role: 'dimension' }),
    f('CampaignName', 'Campaign', 'text', true, { role: 'dimension' }),
    f('CampaignStatus', 'Campaign status', 'text', false, { role: 'dimension' }),
    f('Spend', 'Spend', 'currency', true, { role: 'metric' }),
    f('Impressions', 'Impressions', 'number', true, { role: 'metric' }),
    f('Clicks', 'Clicks', 'number', true, { role: 'metric' }),
    f('Ctr', 'CTR', 'percent', false, { role: 'metric' }),
    f('AverageCpc', 'Average CPC', 'currency', false, { role: 'metric' }),
    f('Conversions', 'Conversions', 'number', true, { role: 'metric' }),
    f('Revenue', 'Revenue', 'currency', true, { role: 'metric' }),
    f('ReturnOnAdSpend', 'Return on ad spend', 'percent', false, { role: 'metric' }),
  ];
}

function dmvMicrosoftAdsToken_(ctx) {
  var credentials = ctx.credentials || {};
  if ((credentials.authMode || 'oauth') === 'token')
    return dmvText_(credentials.accessToken, 'Microsoft access token', 12000, true);
  return dmvOAuthRefreshToken_(
    {
      label: 'Microsoft OAuth',
      endpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      scopes: ['https://ads.microsoft.com/msads.manage', 'offline_access'],
      scopeParameter: true,
    },
    credentials,
    ctx.deadline,
    ctx.rotateCredentials
  );
}

function dmvMicrosoftAdsConnection_(ctx) {
  var credentials = ctx.credentials || {};
  var account = String(credentials.accountId || '').trim();
  var customer = String(credentials.customerId || '').trim();
  if (!/^\d{1,20}$/.test(account) || !/^\d{1,20}$/.test(customer))
    throw new Error('Enter the numeric Microsoft Advertising account ID and customer ID.');
  var developerToken = String(credentials.developerToken || '').trim();
  if (!developerToken) throw new Error('Enter a Microsoft Advertising developer token.');
  return {
    accountId: account,
    headers: {
      Authorization: 'Bearer ' + dmvMicrosoftAdsToken_(ctx),
      DeveloperToken: developerToken,
      CustomerId: customer,
      CustomerAccountId: account,
    },
  };
}

function dmvMicrosoftAdsDate_(value) {
  var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  return { Day: Number(match[3]), Month: Number(match[2]), Year: Number(match[1]) };
}

// Report cells arrive as text: "1,234.50", "12.34%", "9/1/2026" or "2026-09-01".
function dmvMicrosoftAdsValue_(field, text) {
  var value = text === undefined || text === null ? '' : String(text).trim();
  if (value === '' || value === '--') return null;
  if (field.type === 'date') {
    var us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(value);
    if (us) return us[3] + '-' + ('0' + us[1]).slice(-2) + '-' + ('0' + us[2]).slice(-2);
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
    throw new Error('Microsoft Advertising returned an unreadable date.');
  }
  if (field.type === 'number' || field.type === 'currency' || field.type === 'percent') {
    var percent = /%$/.test(value);
    var number = dmvNumber_(value.replace(/[%,]/g, ''));
    return number === null ? null : percent ? number / 100 : number;
  }
  return value;
}

// Submit a daily campaign report request; returns the request id to poll.
function dmvMicrosoftAdsSubmit_(ctx, connection, names, startDate, endDate) {
  var submitted = ctx.http({
    url: DMV_MICROSOFT_ADS.base + 'Submit',
    method: 'post',
    retrySafe: true,
    headers: connection.headers,
    body: {
      ReportRequest: {
        Type: 'CampaignPerformanceReportRequest',
        Format: 'Csv',
        FormatVersion: '2.0',
        ReportName: 'DataMoov daily campaign performance',
        ReturnOnlyCompleteData: false,
        ExcludeColumnHeaders: false,
        ExcludeReportHeader: true,
        ExcludeReportFooter: true,
        Aggregation: 'Daily',
        Columns: names,
        Scope: { AccountIds: [Number(connection.accountId)] },
        Time: {
          CustomDateRangeStart: dmvMicrosoftAdsDate_(startDate),
          CustomDateRangeEnd: dmvMicrosoftAdsDate_(endDate),
        },
      },
    },
  });
  var requestId = submitted && submitted.ReportRequestId;
  if (typeof requestId !== 'string' || !requestId)
    throw new Error(
      'Microsoft Advertising did not accept the report request. Check the developer token, account ID and customer ID.'
    );
  return requestId;
}

// The connection test is a real probe: a one-day, one-column report request that is never
// downloaded. Submit validates the token, developer token, customer and account together.
function dmvMicrosoftAdsTest_(ctx) {
  var yesterday = Utilities.formatDate(new Date(Date.now() - 86400000), 'UTC', 'yyyy-MM-dd');
  dmvMicrosoftAdsSubmit_(
    ctx,
    dmvMicrosoftAdsConnection_(ctx),
    ['TimePeriod', 'Impressions'],
    yesterday,
    yesterday
  );
}

function dmvMicrosoftAdsFetch_(ctx) {
  var columns = dmvSelectFields_(ctx.fields, dmvMicrosoftAdsFields_());
  var connection = dmvMicrosoftAdsConnection_(ctx);
  var names = columns.map(function (field) {
    return field.key;
  });
  ['TimePeriod', 'CampaignId', 'AccountId', 'CurrencyCode'].forEach(function (key) {
    if (names.indexOf(key) < 0) names.push(key);
  });
  var requestId = dmvMicrosoftAdsSubmit_(ctx, connection, names, ctx.startDate, ctx.endDate);
  var downloadUrl = null;
  for (var attempt = 0; attempt < DMV_MICROSOFT_ADS.maxPolls; attempt++) {
    ctx.checkDeadline();
    var polled = ctx.http({
      url: DMV_MICROSOFT_ADS.base + 'Poll',
      method: 'post',
      retrySafe: true,
      headers: connection.headers,
      body: { ReportRequestId: requestId },
    });
    var status = polled && polled.ReportRequestStatus;
    if (!status || typeof status.Status !== 'string')
      throw new Error('Microsoft Advertising returned an invalid report status.');
    if (status.Status === 'Success') {
      downloadUrl = status.ReportDownloadUrl || null;
      break;
    }
    if (status.Status !== 'Pending')
      throw new Error(
        'Microsoft Advertising could not generate the report (' + status.Status + ').'
      );
    Utilities.sleep(DMV_MICROSOFT_ADS.pollIntervalMs);
  }
  if (downloadUrl === null && attempt >= DMV_MICROSOFT_ADS.maxPolls)
    throw new Error(
      'The Microsoft Advertising report is still generating. Try again in a few minutes.'
    );
  var rows = [],
    currency = '';
  if (downloadUrl) {
    var host = dmvHost_(downloadUrl);
    if (DMV_MICROSOFT_ADS.downloadHosts.indexOf(host) < 0)
      throw new Error(
        'Microsoft Advertising offered a report download from an unexpected host (' + host + ').'
      );
    var archive = ctx.http({ url: downloadUrl, headers: {}, responseType: 'blob' });
    var files = Utilities.unzip(archive);
    if (!files || !files.length)
      throw new Error('The Microsoft Advertising report archive was empty.');
    var lines = Utilities.parseCsv(files[0].getDataAsString());
    var header = lines.length ? lines[0] : [];
    var index = {};
    header.forEach(function (name, position) {
      index[String(name).trim()] = position;
    });
    columns.forEach(function (field) {
      if (index[field.key] === undefined)
        throw new Error(
          'The Microsoft Advertising report is missing the ' + field.label + ' column.'
        );
    });
    var seen = Object.create(null);
    var mapped = lines
      .slice(1)
      .filter(function (line) {
        return line.length > 1 || (line.length === 1 && line[0] !== '');
      })
      .map(function (line) {
        if (!currency) currency = String(line[index.CurrencyCode] || '').trim();
        var row = {};
        columns.forEach(function (field) {
          row[field.key] = dmvMicrosoftAdsValue_(field, line[index[field.key]]);
        });
        var key = line[index.TimePeriod] + ':' + line[index.CampaignId];
        if (seen[key]) throw new Error('Microsoft Advertising returned duplicate campaign days.');
        seen[key] = true;
        return row;
      });
    dmvAppendPage_(rows, mapped, ctx.maxRows);
  }
  return {
    columns: columns,
    rows: rows,
    metadata: {
      apiVersion: 'v13',
      accountId: connection.accountId,
      currency: currency,
      attribution:
        'Microsoft Advertising conversion goals; report time zone is the account default.',
      grain: 'Daily campaign',
      complete: true,
    },
  };
}

dmvRegisterConnector_({
  id: 'microsoft_ads',
  label: 'Microsoft Ads (Bing)',
  description: 'Daily campaign performance from Microsoft Advertising.',
  category: 'Marketing',
  color: '#00a4ef',
  allowedHosts: ['reporting.api.bingads.microsoft.com'].concat(DMV_MICROSOFT_ADS.downloadHosts),
  guide: {
    intro:
      'Microsoft Advertising needs a developer token plus a Microsoft Entra app that you consent once.',
    steps: [
      'Microsoft Advertising developer portal → Account → request a developer token (approved tokens work with production accounts).',
      'Azure portal → Microsoft Entra ID → App registrations → New registration → add a client secret under Certificates & secrets.',
      'Consent the app with scope https://ads.microsoft.com/msads.manage offline_access (the quick-start guide walks through it) and keep the refresh token.',
      'Account ID and customer ID are under Settings → Accounts in Microsoft Advertising.',
    ],
    links: [
      { label: 'Developer portal', url: 'https://developers.ads.microsoft.com/Account' },
      {
        label: 'OAuth quick start',
        url: 'https://learn.microsoft.com/advertising/guides/authentication-oauth-quick-start',
      },
    ],
  },
  authFields: [
    {
      key: 'accountId',
      label: 'Account ID',
      type: 'text',
      required: true,
      help: 'The numeric advertising account ID (not the account number).',
    },
    { key: 'customerId', label: 'Customer ID', type: 'text', required: true },
    {
      key: 'developerToken',
      label: 'Developer token',
      type: 'password',
      required: true,
      help: 'From the Microsoft Advertising developer portal.',
    },
    {
      key: 'authMode',
      label: 'Authorization',
      type: 'select',
      default: 'oauth',
      options: [
        { value: 'oauth', label: 'OAuth client credentials' },
        { value: 'token', label: 'Access token' },
      ],
    },
    {
      key: 'clientId',
      label: 'Microsoft app (client) ID',
      type: 'text',
      required: true,
      showWhen: { key: 'authMode', value: 'oauth' },
    },
    {
      key: 'clientSecret',
      label: 'Client secret',
      type: 'password',
      secret: true,
      required: true,
      showWhen: { key: 'authMode', value: 'oauth' },
    },
    {
      key: 'refreshToken',
      label: 'Refresh token',
      type: 'password',
      secret: true,
      required: true,
      showWhen: { key: 'authMode', value: 'oauth' },
      help: 'A refresh token granted to this app with the msads.manage scope. DataMoov obtains access tokens automatically.',
    },
    {
      key: 'accessToken',
      label: 'Access token',
      type: 'password',
      required: true,
      showWhen: { key: 'authMode', value: 'token' },
      help: 'Expires within an hour; only for one-off previews.',
    },
  ],
  test: dmvMicrosoftAdsTest_,
  reports: [
    {
      id: 'campaign_daily',
      label: 'Daily campaign performance',
      description:
        'Spend, impressions, clicks, conversions and revenue per campaign per day. Reports generate asynchronously; allow a minute.',
      fields: dmvMicrosoftAdsFields_(),
      configFields: [],
      dateRange: true,
      fetch: dmvMicrosoftAdsFetch_,
    },
  ],
});
