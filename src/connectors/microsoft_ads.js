/** Microsoft Advertising (Bing Ads) Reporting API v13 over REST: submit, poll, download a zipped CSV. */
var DMV_MICROSOFT_ADS = {
  base: 'https://reporting.api.bingads.microsoft.com/Reporting/v13/GenerateReport/',
  // The service's own schema lists every column of every report type.
  schema:
    'https://reporting.api.bingads.microsoft.com/Api/Advertiser/Reporting/v13/ReportingService.svc?singleWsdl',
  accounts: 'https://clientcenter.api.bingads.microsoft.com/CustomerManagement/v13/',
  // Reports are served from Microsoft's storage account; the first two are the documented hosts.
  downloadHosts: [
    'download.api.bingads.microsoft.com',
    'reporting-download.bingads.microsoft.com',
    'bingadsappsstorageprod.blob.core.windows.net',
  ],
  pollIntervalMs: 3000,
  maxPolls: 40,
};

// The period column selected decides the aggregation; with none the rows are period totals.
var DMV_MICROSOFT_ADS_PERIODS = {
  TimePeriod: 'Daily',
  Week: 'WeeklyStartingMonday',
  Month: 'Monthly',
  DayOfWeek: 'DayOfWeek',
  HourOfDay: 'HourOfDay',
};

var DMV_MICROSOFT_ADS_LABELS = {
  TimePeriod: 'Date',
  Week: 'Week',
  Month: 'Month',
  DayOfWeek: 'Day of week (1 = Sunday)',
  HourOfDay: 'Hour of day',
  AccountName: 'Account',
  CampaignName: 'Campaign',
  AdGroupName: 'Ad group',
  AssetGroupName: 'Asset group',
  AudienceName: 'Audience',
  CurrencyCode: 'Currency',
  SearchQuery: 'Search term',
  BidMatchType: 'Match type (bid)',
  DeliveredMatchType: 'Match type (delivered)',
  Ctr: 'CTR',
  ReturnOnAdSpend: 'Return on ad spend',
  Status: 'Ad group status',
  Title: 'Product title',
  MerchantProductId: 'Product ID',
  AgeGroup: 'Age',
};

// Counts and scores; money, rates and text are recognised by name in dmvMicrosoftAdsColumn_.
var DMV_MICROSOFT_ADS_COUNTS =
  ' Impressions Clicks Conversions ConversionsQualified AllConversions AllConversionsQualified Assists ViewThroughConversions ViewThroughConversionsQualified PhoneCalls PhoneImpressions LowQualityClicks LowQualityImpressions LowQualityConversions LowQualityConversionsQualified LowQualityGeneralClicks LowQualitySophisticatedClicks VideoViews CompletedVideoViews TotalWatchTimeInMS Installs AppInstalls Downloads Purchases Subscriptions Sales NewCustomerConversions NewCustomerCount UnknownCustomerConversions AssistedClicks AssistedConversions AssistedConversionsQualified AssistedImpressions TotalClicksOnAdElements QuantityBought ';
var DMV_MICROSOFT_ADS_SCORES =
  ' QualityScore AdRelevance ExpectedCtr LandingPageExperience HistoricalQualityScore HistoricalAdRelevance HistoricalExpectedCtr HistoricalLandingPageExperience AveragePosition AverageWatchTimePerImpression AverageWatchTimePerVideoView QualityImpact ';

// Column lists read "selected at the start | also offered".
var DMV_MICROSOFT_ADS_CORE =
  'Impressions Clicks Spend Conversions Revenue | Ctr AverageCpc ConversionRate CostPerConversion ReturnOnAdSpend AverageCpm AllConversions AllRevenue ViewThroughConversions Assists TopImpressionRatePercent AbsoluteTopImpressionRatePercent';
var DMV_MICROSOFT_ADS_AUDIENCE_METRICS =
  'Impressions Clicks Spend Conversions Revenue | AllConversions AllRevenue ViewThroughConversions Assists';

// One report request type per level: id, label, request type, dimensions, the metrics where the
// report type supports fewer than the core list, and the columns Microsoft refuses to go without
// (found by submitting each report type to the live API).
function dmvMicrosoftAdsLevel_(id, label, type, dims, metrics, requires) {
  var lists = function (text) {
    return text.split('|').map(function (part) {
      return part.trim().split(/\s+/);
    });
  };
  var d = lists(dims),
    m = lists(metrics || DMV_MICROSOFT_ADS_CORE);
  return {
    id: id,
    label: label,
    type: type + 'ReportRequest',
    dims: d[0].concat(d[1]),
    metrics: m[0].concat(m[1]),
    defaults: d[0].concat(m[0]),
    requires: requires ? requires.split(' ') : [],
  };
}

var DMV_MICROSOFT_ADS_LEVELS = [
  [
    'account',
    'Account performance',
    'AccountPerformance',
    'TimePeriod AccountName CurrencyCode | AccountId DeviceType Network AdDistribution',
  ],
  [
    'campaign',
    'Campaign performance',
    'CampaignPerformance',
    'TimePeriod CampaignName CurrencyCode | CampaignId CampaignStatus CampaignType AccountName DeviceType Network CampaignLabels',
  ],
  [
    'ad_group',
    'Ad group performance',
    'AdGroupPerformance',
    'CampaignName AdGroupName CurrencyCode | AdGroupId Status AdGroupType DeviceType Network Language',
  ],
  [
    'ad',
    'Ad performance',
    'AdPerformance',
    'CampaignName AdGroupName AdId AdType TitlePart1 CurrencyCode | AdTitle TitlePart2 TitlePart3 Headline LongHeadline AdDescription Path1 Path2 FinalUrl AdStatus AdStrength DeviceType',
  ],
  [
    'keyword',
    'Keyword performance',
    'KeywordPerformance',
    'CampaignName AdGroupName Keyword BidMatchType CurrencyCode | KeywordId DeliveredMatchType KeywordStatus DeviceType',
    DMV_MICROSOFT_ADS_CORE +
      ' QualityScore ExpectedCtr AdRelevance LandingPageExperience CurrentMaxCpc',
  ],
  [
    'search_term',
    'Search terms',
    'SearchQueryPerformance',
    'SearchQuery CampaignName AdGroupName DeliveredMatchType | Keyword BidMatchType DeviceType',
    DMV_MICROSOFT_ADS_CORE.replace(' ViewThroughConversions', ''),
    'SearchQuery',
  ],
  [
    'geographic',
    'Geography (targeted or physical location)',
    'GeographicPerformance',
    'Country CampaignName CurrencyCode | State MetroArea City County PostalCode LocationType MostSpecificLocation AdGroupName DeviceType',
  ],
  [
    'user_location',
    'User location',
    'UserLocationPerformance',
    'Country CampaignName CurrencyCode | State MetroArea City County PostalCode QueryIntentCountry QueryIntentState QueryIntentCity AdGroupName DeviceType',
  ],
  [
    'age_gender',
    'Age and gender',
    'AgeGenderAudience',
    'AgeGroup Gender CampaignName | AdGroupName AccountName Language',
    DMV_MICROSOFT_ADS_AUDIENCE_METRICS,
    'AgeGroup Gender',
  ],
  [
    'professional',
    'Professional demographics (LinkedIn profile)',
    'ProfessionalDemographicsAudience',
    'IndustryName JobFunctionName CampaignName | JobSeniorityName CompanyName AdGroupName AccountName',
    DMV_MICROSOFT_ADS_AUDIENCE_METRICS,
    'AccountName IndustryName JobFunctionName CompanyName',
  ],
  [
    'audience',
    'Audiences',
    'AudiencePerformance',
    'AudienceName AudienceType CampaignName | AudienceId AdGroupName AssociationLevel BidAdjustment TargetingSetting',
    DMV_MICROSOFT_ADS_CORE.replace(' Assists', ''),
    'AudienceId',
  ],
  [
    'landing_page',
    'Landing pages',
    'DestinationUrlPerformance',
    'DestinationUrl CampaignName CurrencyCode | FinalUrl AdGroupName AdId DeviceType',
    undefined,
    'DestinationUrl',
  ],
  [
    'product',
    'Shopping products',
    'ProductDimensionPerformance',
    'Title MerchantProductId CampaignName CurrencyCode | Brand Condition ProductCategory1 ProductCategory2 ProductType1 ProductType2 CustomLabel0 CustomLabel1 AdGroupName DeviceType',
    'Impressions Clicks Spend Conversions Revenue | Ctr AverageCpc ConversionRate CostPerConversion ReturnOnAdSpend AverageCpm AllConversions AllRevenue ViewThroughConversions ImpressionSharePercent ClickSharePercent BenchmarkCtr BenchmarkBid Price',
  ],
  [
    'asset_group',
    'Performance Max asset groups',
    'AssetGroupPerformance',
    'AssetGroupName CampaignName | AssetGroupId AssetGroupStatus AccountName',
    'Impressions Clicks Spend Conversions Revenue | Ctr AverageCpc CostPerConversion ReturnOnAdSpend',
    'AssetGroupName',
  ],
  [
    'conversion',
    'Conversions by goal',
    'ConversionPerformance',
    'Goal CampaignName | GoalType AdGroupName Keyword DeviceType',
    'Conversions Revenue | ConversionRate CostPerConversion ReturnOnAdSpend AllConversions AllRevenue ViewThroughConversions Assists Impressions Clicks Spend',
  ],
  [
    'goal',
    'Goals and funnels',
    'GoalsAndFunnels',
    'Goal CampaignName | GoalType AdGroupName Keyword DeviceType',
    'AllConversions AllRevenue | Assists ViewThroughConversions',
    'Goal',
  ],
  [
    'share_of_voice',
    'Keyword impression share',
    'ShareOfVoice',
    'Keyword CampaignName AdGroupName | BidMatchType DeliveredMatchType',
    'Impressions ImpressionSharePercent ImpressionLostToBudgetPercent ImpressionLostToRankAggPercent Clicks Spend | ClickSharePercent ExactMatchImpressionSharePercent TopImpressionSharePercent AbsoluteTopImpressionSharePercent Ctr AverageCpc Conversions QualityScore',
    'ImpressionSharePercent',
  ],
  [
    'publisher',
    'Website placements',
    'PublisherUsagePerformance',
    'PublisherUrl CampaignName CurrencyCode | DeviceType Network AdGroupName',
    undefined,
    'PublisherUrl',
  ],
].map(function (row) {
  return dmvMicrosoftAdsLevel_(row[0], row[1], row[2], row[3], row[4], row[5]);
});

// A descriptor for any report column, typed by Microsoft's naming.
function dmvMicrosoftAdsColumn_(name, isDefault) {
  var f = dmvField_,
    label = DMV_MICROSOFT_ADS_LABELS[name];
  if (!label) {
    label = name
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .replace(/([A-Za-z])(\d)/g, '$1 $2')
      .replace(/\b(Cpc|Cpm|Ctr|Ptr|Id|Url|Os)\b/g, function (word) {
        return word.toUpperCase();
      });
    label =
      label.charAt(0) +
      label.slice(1).replace(/\b[A-Z][a-z]+\b/g, function (word) {
        return word.toLowerCase();
      });
  }
  if (DMV_MICROSOFT_ADS_PERIODS[name])
    return f(
      name,
      label,
      name === 'DayOfWeek' || name === 'HourOfDay' ? 'text' : 'date',
      isDefault,
      {
        role: 'dimension',
      }
    );
  var metric = function (type, additive) {
    return f(
      name,
      label,
      type,
      isDefault,
      additive ? { role: 'metric' } : { role: 'metric', additive: false }
    );
  };
  if (
    DMV_MICROSOFT_ADS_COUNTS.indexOf(' ' + name + ' ') >= 0 ||
    /^VideoViewsAt\d+Percent$/.test(name)
  )
    return metric('number', true);
  if (DMV_MICROSOFT_ADS_SCORES.indexOf(' ' + name + ' ') >= 0) return metric('number', false);
  if (/(Percent|Rate|Ctr|ReturnOnAdSpend)$/.test(name) || name === 'Ptr')
    return metric('percent', false);
  if (
    /^(Spend|Revenue|AllRevenue|ViewThroughRevenue|ExtendedCost|NewCustomerRevenue|NewCustomerSpend|UnknownCustomerRevenue)$/.test(
      name
    )
  )
    return metric('currency', true);
  if (
    /(Cpc|Cpm|CPV|Bid|CPA|CPI|CPP|CPS)$/.test(name) ||
    /^(All)?(Cost|Revenue)Per/.test(name) ||
    name === 'Price'
  )
    return metric('currency', false);
  return f(name, label, 'text', isDefault, { role: 'dimension' });
}

function dmvMicrosoftAdsLevelFields_(level) {
  return Object.keys(DMV_MICROSOFT_ADS_PERIODS)
    .concat(
      level.dims.filter(function (name) {
        return !DMV_MICROSOFT_ADS_PERIODS[name];
      })
    )
    .concat(level.metrics)
    .map(function (name) {
      return dmvMicrosoftAdsColumn_(name, level.defaults.indexOf(name) >= 0);
    });
}

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
  // An app registered for one organisation only signs in at its own tenant, not at "common".
  var tenant = String(credentials.tenantId || '').trim() || 'common';
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,99}$/.test(tenant))
    throw new Error('Enter the Microsoft Entra tenant ID (a GUID or domain), or leave it empty.');
  return dmvOAuthRefreshToken_(
    {
      label: 'Microsoft OAuth',
      endpoint: 'https://login.microsoftonline.com/' + tenant + '/oauth2/v2.0/token',
      scopes: ['https://ads.microsoft.com/msads.manage', 'offline_access'],
      scopeParameter: true,
    },
    credentials,
    ctx.deadline,
    ctx.rotateCredentials
  );
}

function dmvMicrosoftAdsDeveloperToken_(ctx) {
  var developerToken = String((ctx.credentials || {}).developerToken || '').trim();
  if (!developerToken) throw new Error('Enter a Microsoft Advertising developer token.');
  return developerToken;
}

function dmvMicrosoftAdsConnection_(ctx) {
  var credentials = ctx.credentials || {};
  var account = String(credentials.accountId || '').trim();
  var customer = String(credentials.customerId || '').trim();
  if (!/^\d{1,20}$/.test(account) || !/^\d{1,20}$/.test(customer))
    throw new Error('Enter the numeric Microsoft Advertising account ID and customer ID.');
  var developerToken = dmvMicrosoftAdsDeveloperToken_(ctx);
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

// Submit a report request; returns the request id to poll.
function dmvMicrosoftAdsSubmit_(ctx, connection, names, startDate, endDate, type, aggregation) {
  var submitted = ctx.http({
    url: DMV_MICROSOFT_ADS.base + 'Submit',
    method: 'post',
    retrySafe: true,
    headers: connection.headers,
    body: {
      ReportRequest: {
        Type: type || 'CampaignPerformanceReportRequest',
        Format: 'Csv',
        FormatVersion: '2.0',
        ReportName: 'DataMoov report',
        ReturnOnlyCompleteData: false,
        ExcludeColumnHeaders: false,
        ExcludeReportHeader: true,
        ExcludeReportFooter: true,
        Aggregation: aggregation || 'Daily',
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

// Polls until the report is ready and returns its CSV lines (header first), or [] when empty.
function dmvMicrosoftAdsDownload_(ctx, connection, requestId) {
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
  if (!downloadUrl) return [];
  var host = dmvHost_(downloadUrl);
  if (DMV_MICROSOFT_ADS.downloadHosts.indexOf(host) < 0)
    throw new Error(
      'Microsoft Advertising offered a report download from an unexpected host (' + host + ').'
    );
  var archive = ctx.http({ url: downloadUrl, headers: {}, responseType: 'blob' });
  var files = Utilities.unzip(archive);
  if (!files || !files.length)
    throw new Error('The Microsoft Advertising report archive was empty.');
  return Utilities.parseCsv(files[0].getDataAsString()).filter(function (line) {
    return line.length > 1 || (line.length === 1 && line[0] !== '');
  });
}

// One engine for every report. "fixed" is the original daily campaign report, which always
// asks for its identifying columns; a level takes period and ranking from the selected columns.
function dmvMicrosoftAdsReport_(ctx, level, available, fixed) {
  var keys = ctx.fields && ctx.fields.length ? ctx.fields : dmvDefaultFields_(available);
  var columns = dmvSelectFields_(
    keys,
    available.concat(
      fixed
        ? []
        : (Array.isArray(keys) ? keys : [])
            .filter(function (key) {
              return (
                /^[A-Z][A-Za-z0-9]{1,79}$/.test(String(key)) &&
                !available.some(function (field) {
                  return field.key === key;
                })
              );
            })
            .map(function (key) {
              return dmvMicrosoftAdsColumn_(key, false);
            })
    )
  );
  // Columns Microsoft insists on join the output, so the rows they split stay readable.
  (level.requires || []).forEach(function (name) {
    if (
      !columns.some(function (field) {
        return field.key === name;
      })
    )
      columns.push(dmvMicrosoftAdsColumn_(name, false));
  });
  var connection = dmvMicrosoftAdsConnection_(ctx);
  var periods = columns.filter(function (field) {
    return DMV_MICROSOFT_ADS_PERIODS[field.key];
  });
  if (periods.length > 1)
    throw new Error('Choose one of Date, Week, Month, Day of week or Hour of day, not several.');
  var aggregation = fixed
    ? 'Daily'
    : periods.length
      ? DMV_MICROSOFT_ADS_PERIODS[periods[0].key]
      : 'Summary';
  // Every period column is Microsoft's TimePeriod at another aggregation.
  var source = function (field) {
    return DMV_MICROSOFT_ADS_PERIODS[field.key] ? 'TimePeriod' : field.key;
  };
  var names = [];
  columns.forEach(function (field) {
    if (names.indexOf(source(field)) < 0) names.push(source(field));
  });
  if (fixed)
    ['TimePeriod', 'CampaignId', 'AccountId', 'CurrencyCode'].forEach(function (key) {
      if (names.indexOf(key) < 0) names.push(key);
    });
  else {
    // A report needs at least one performance column.
    if (
      !columns.some(function (field) {
        return field.role === 'metric';
      })
    )
      names.push(level.metrics[0]);
    var money = columns.some(function (field) {
      return field.type === 'currency';
    });
    if (money && level.dims.indexOf('CurrencyCode') >= 0 && names.indexOf('CurrencyCode') < 0)
      names.push('CurrencyCode');
  }
  var lines = dmvMicrosoftAdsDownload_(
    ctx,
    connection,
    dmvMicrosoftAdsSubmit_(
      ctx,
      connection,
      names,
      ctx.startDate,
      ctx.endDate,
      level.type,
      aggregation
    )
  );
  var rows = [],
    currency = '',
    note = '';
  if (lines.length) {
    var index = {};
    lines[0].forEach(function (name, position) {
      index[String(name).trim()] = position;
    });
    columns.forEach(function (field) {
      if (index[source(field)] === undefined)
        throw new Error(
          'The Microsoft Advertising report is missing the ' + field.label + ' column.'
        );
    });
    var seen = Object.create(null);
    var mapped = lines.slice(1).map(function (line) {
      if (!currency && index.CurrencyCode !== undefined)
        currency = String(line[index.CurrencyCode] || '').trim();
      var row = {};
      columns.forEach(function (field) {
        row[field.key] = dmvMicrosoftAdsValue_(field, line[index[source(field)]]);
      });
      if (fixed) {
        var key = line[index.TimePeriod] + ':' + line[index.CampaignId];
        if (seen[key]) throw new Error('Microsoft Advertising returned duplicate campaign days.');
        seen[key] = true;
      }
      return row;
    });
    // Without a period the rows are a ranking: the biggest spenders first, and the row limit
    // keeps the top of it, as for Google Ads. A trend needs every row and fails over the limit.
    var ranked =
      !fixed &&
      aggregation === 'Summary' &&
      columns.some(function (field) {
        return field.key === 'Spend';
      });
    if (ranked) {
      mapped.sort(function (a, b) {
        return (b.Spend || 0) - (a.Spend || 0);
      });
      if (mapped.length > ctx.maxRows) {
        mapped = mapped.slice(0, ctx.maxRows);
        note =
          'Top ' + ctx.maxRows.toLocaleString() + ' rows by spend; raise the row limit for more.';
      }
    }
    dmvAppendPage_(rows, mapped, ctx.maxRows);
  }
  if (aggregation === 'WeeklyStartingMonday' || aggregation === 'Monthly')
    note =
      'Microsoft Advertising reports whole ' +
      (aggregation === 'Monthly' ? 'months' : 'weeks') +
      ', so the first and last period can include days outside the date range.';
  var metadata = {
    apiVersion: 'v13',
    accountId: connection.accountId,
    currency: currency,
    attribution: 'Microsoft Advertising conversion goals; report time zone is the account default.',
    grain: fixed
      ? 'Daily campaign'
      : level.label + (periods.length ? ' by ' + periods[0].label.toLowerCase() : ', whole period'),
    complete: true,
  };
  if (note) metadata.note = note;
  return { columns: columns, rows: rows, metadata: metadata };
}

function dmvMicrosoftAdsFetch_(ctx) {
  return dmvMicrosoftAdsReport_(
    ctx,
    { type: 'CampaignPerformanceReportRequest' },
    dmvMicrosoftAdsFields_(),
    true
  );
}

// Load columns reads the report type's column list from the service's own schema, so every
// column Microsoft supports is offered without keeping hundreds of names here.
function dmvMicrosoftAdsDiscover_(ctx, level) {
  var curated = dmvMicrosoftAdsLevelFields_(level);
  var schema = ctx
    .http({ url: DMV_MICROSOFT_ADS.schema, headers: {}, responseType: 'blob' })
    .getDataAsString();
  var block = new RegExp(
    '<xs:simpleType name="' +
      level.type.replace(/Request$/, 'Column') +
      '">([\\s\\S]*?)</xs:simpleType>'
  ).exec(schema);
  if (!block) throw new Error('Microsoft Advertising did not describe this report type.');
  var known = {};
  curated.forEach(function (field) {
    known[field.key] = true;
  });
  var extra = [],
    pattern = /<xs:enumeration value="([A-Z][A-Za-z0-9]{1,79})"/g,
    match;
  while ((match = pattern.exec(block[1])) && extra.length < 300)
    if (!known[match[1]]) {
      known[match[1]] = true;
      extra.push(dmvMicrosoftAdsColumn_(match[1], false));
    }
  return curated.concat(extra);
}

function dmvMicrosoftAdsLevelReport_(level) {
  var curated = dmvMicrosoftAdsLevelFields_(level);
  return {
    id: level.id,
    label: level.label,
    description:
      'One row per combination of the dimensions you select. Date, Week or Month sets the period; with none, rows are totals ranked by spend. Load columns lists every column Microsoft offers for this report. Reports generate asynchronously; allow a minute.',
    fields: curated,
    configFields: [],
    dateRange: true,
    fetch: function (ctx) {
      return dmvMicrosoftAdsReport_(ctx, level, dmvMicrosoftAdsLevelFields_(level), false);
    },
    discoverFields: function (ctx) {
      return dmvMicrosoftAdsDiscover_(ctx, level);
    },
  };
}

// Find accounts: the signed-in user, then every advertising account that user can reach.
function dmvMicrosoftAdsDiscoverAccounts_(ctx) {
  var headers = {
    Authorization: 'Bearer ' + dmvMicrosoftAdsToken_(ctx),
    DeveloperToken: dmvMicrosoftAdsDeveloperToken_(ctx),
  };
  var user = ctx.http({
    url: DMV_MICROSOFT_ADS.accounts + 'User/Query',
    method: 'post',
    retrySafe: true,
    headers: headers,
    body: { UserId: null },
  });
  var userId = user && user.User && user.User.Id;
  if (!/^\d{1,20}$/.test(String(userId || '')))
    throw new Error('Microsoft Advertising did not return the signed-in user.');
  var found = ctx.http({
    url: DMV_MICROSOFT_ADS.accounts + 'Accounts/Search',
    method: 'post',
    retrySafe: true,
    headers: headers,
    body: {
      Predicates: [{ Field: 'UserId', Operator: 'Equals', Value: String(userId) }],
      Ordering: [{ Field: 'Name', Order: 'Ascending' }],
      PageInfo: { Index: 0, Size: 1000 },
    },
  });
  if (!found || !Array.isArray(found.Accounts))
    throw new Error('Microsoft Advertising returned an invalid account list.');
  return found.Accounts.filter(function (account) {
    return (
      account &&
      /^\d{1,20}$/.test(String(account.Id || '')) &&
      /^\d{1,20}$/.test(String(account.ParentCustomerId || '')) &&
      (!account.AccountLifeCycleStatus || account.AccountLifeCycleStatus === 'Active')
    );
  }).map(function (account) {
    return {
      id: String(account.Id),
      label:
        String(account.Name || 'Microsoft Advertising account').slice(0, 160) +
        ' (' +
        String(account.Number || account.Id) +
        ')',
      credentials: { accountId: String(account.Id), customerId: String(account.ParentCustomerId) },
    };
  });
}

// Microsoft explains a refused report (a column that does not fit the report or the other
// columns) in words about the request itself; those are shown. Access problems get fixed text.
function dmvMicrosoftAdsErrorMessage_(code, body) {
  var errors = []
    .concat((body && body.OperationErrors) || [])
    .concat((body && body.BatchErrors) || [])
    .concat((body && body.Errors) || []);
  var first = errors[0] || {};
  var number = Number(first.Code);
  if (number === 105 || number === 109 || number === 120)
    return 'Microsoft Advertising rejected the sign-in. Check the app (client) ID, secret, tenant and refresh token, and that the token was granted msads.manage.';
  if (number === 106 || number === 1001 || number === 1102)
    return 'This user cannot reach the advertising account. Check the account ID and customer ID (Find accounts fills both) and the user’s access in Microsoft Advertising.';
  if (number === 117)
    return 'Microsoft Advertising is rate limiting these requests. Try again in a minute.';
  if (first.ErrorCode === 'NullRequest')
    return 'Microsoft Advertising could not read the request: a column does not exist in this report type. Load columns lists the columns that fit.';
  if (first.ErrorCode === 'RequiredColumnsNotSelected')
    return 'Microsoft Advertising needs more columns for this report type. Select the dimension the report is named after (for example the search term, audience or landing page) and try again.';
  if (/restricted column/i.test(String(first.Message || '')))
    return 'Microsoft Advertising does not combine these columns. Impression share and top impression rate columns cannot be reported with match type (bid), device OS, goal, top vs. other or budget columns; remove one side.';
  if (typeof first.Message === 'string' && first.Message && number >= 2000 && number < 3000)
    return (
      'Microsoft Advertising rejected the report. ' +
      String(first.Message)
        .slice(0, 280)
        .replace(/[\s.]+$/, '') +
      '. Remove the column named, or Load columns to see what fits this report.'
    ).slice(0, 400);
  return '';
}

dmvRegisterConnector_({
  id: 'microsoft_ads',
  label: 'Microsoft Ads (Bing)',
  description:
    'Microsoft Advertising performance at every report level, from account to search term.',
  category: 'Marketing',
  color: '#00a4ef',
  icon: {
    viewBox: '0 0 250 250',
    shapes: [
      {
        d: 'M122.986 91.91c-.032.26-.032.554-.032.843 0 1.123.22 2.204.617 3.198l.355.745 1.404 3.662 7.293 18.967 6.36 16.563c1.814 3.343 4.72 5.968 8.225 7.367l1.088.408c.043.013.114.013.173.029l17.432 6.112v.014l6.665 2.333.456.157c.015 0 .042.016.058.016 1.314.337 2.601.791 3.83 1.345a25.448 25.448 0 0 1 7.621 5.206 24.937 24.937 0 0 1 2.458 2.79 23.978 23.978 0 0 1 1.759 2.625c2.326 3.938 3.661 8.567 3.661 13.495 0 .881-.042 1.731-.13 2.596a15.1 15.1 0 0 1-.129 1.112v.03c-.059.386-.13.786-.202 1.178-.074.38-.143.758-.228 1.137a2.284 2.284 0 0 1-.045.132c-.079.383-.18.761-.283 1.142-.093.359-.209.729-.339 1.078-.114.381-.248.756-.4 1.123-.13.378-.284.762-.456 1.124a23.659 23.659 0 0 1-1.663 3.195 26.41 26.41 0 0 1-2.774 3.767 58.562 58.562 0 0 0 14.972-33.356c.228-2.101.344-4.232.344-6.376 0-1.369-.058-2.725-.145-4.086-1.031-15.364-7.891-29.105-18.363-38.911a56.286 56.286 0 0 0-9.435-7.208l-6.411-3.34-32.483-16.996a7.86 7.86 0 0 0-3.161-.659c-4.206 0-7.679 3.27-8.092 7.443Z',
        fill: '#7f7f7f',
      },
      {
        d: 'M122.986 91.91c-.032.26-.032.554-.032.843 0 1.123.22 2.204.617 3.198l.355.745 1.404 3.662 7.293 18.967 6.36 16.563c1.814 3.343 4.72 5.968 8.225 7.367l1.088.408c.043.013.114.013.173.029l17.432 6.112v.014l6.665 2.333.456.157c.015 0 .042.016.058.016 1.314.337 2.601.791 3.83 1.345a25.448 25.448 0 0 1 7.621 5.206 24.937 24.937 0 0 1 2.458 2.79 23.978 23.978 0 0 1 1.759 2.625c2.326 3.938 3.661 8.567 3.661 13.495 0 .881-.042 1.731-.13 2.596a15.1 15.1 0 0 1-.129 1.112v.03c-.059.386-.13.786-.202 1.178-.074.38-.143.758-.228 1.137a2.284 2.284 0 0 1-.045.132c-.079.383-.18.761-.283 1.142-.093.359-.209.729-.339 1.078-.114.381-.248.756-.4 1.123-.13.378-.284.762-.456 1.124a23.659 23.659 0 0 1-1.663 3.195 26.41 26.41 0 0 1-2.774 3.767 58.562 58.562 0 0 0 14.972-33.356c.228-2.101.344-4.232.344-6.376 0-1.369-.058-2.725-.145-4.086-1.031-15.364-7.891-29.105-18.363-38.911a56.286 56.286 0 0 0-9.435-7.208l-6.411-3.34-32.483-16.996a7.86 7.86 0 0 0-3.161-.659c-4.206 0-7.679 3.27-8.092 7.443Z',
        fill: '#36cee9',
      },
      {
        d: 'M65.146 17c-4.622.084-8.334 3.94-8.334 8.656v150.982c.019 1.053.077 2.093.152 3.149.066.556.137 1.134.238 1.696 2.111 12.117 12.453 21.313 24.94 21.313 4.378 0 8.484-1.137 12.076-3.114.021-.016.058-.038.077-.038l1.293-.796 5.239-3.144 6.665-4.032.016-134.149c0-8.915-4.376-16.774-11.075-21.443a3.902 3.902 0 0 1-.453-.316l-25.933-17.29A8.522 8.522 0 0 0 65.45 17h-.305Z',
        fill: '#7f7f7f',
      },
      {
        d: 'M65.146 17c-4.622.084-8.334 3.94-8.334 8.656v150.982c.019 1.053.077 2.093.152 3.149.066.556.137 1.134.238 1.696 2.111 12.117 12.453 21.313 24.94 21.313 4.378 0 8.484-1.137 12.076-3.114.021-.016.058-.038.077-.038l1.293-.796 5.239-3.144 6.665-4.032.016-134.149c0-8.915-4.376-16.774-11.075-21.443a3.902 3.902 0 0 1-.453-.316l-25.933-17.29A8.522 8.522 0 0 0 65.45 17h-.305Z',
        fill: '#2080f1',
      },
      {
        d: 'm167.975 154.933-59.625 36.032-.858.526v.192l-6.665 4.024-5.237 3.152-1.285.791-.087.043a24.813 24.813 0 0 1-12.069 3.108c-12.484 0-22.839-9.19-24.942-21.313a58.356 58.356 0 0 0 8.434 24.317c9.208 14.818 24.778 25.126 42.791 26.917h11.014c9.743-1.037 17.878-5.015 26.429-10.387l13.149-8.199c5.923-3.87 22-13.39 26.736-18.732a26.324 26.324 0 0 0 2.773-3.764 23.82 23.82 0 0 0 1.664-3.198c.159-.378.31-.745.455-1.121.138-.372.268-.748.4-1.128.247-.73.443-1.462.631-2.215.095-.429.183-.853.27-1.275a27.68 27.68 0 0 0 .442-4.918c0-4.928-1.335-9.557-3.647-13.489a22.751 22.751 0 0 0-1.759-2.625c-.755-1-1.571-1.926-2.458-2.79-2.202-2.174-4.771-3.957-7.621-5.21a23.059 23.059 0 0 0-3.831-1.342c-.016 0-.042-.016-.058-.016l-.456-.157-4.59 2.777Z',
        fill: '#7f7f7f',
      },
      {
        d: 'm167.975 154.933-59.625 36.032-.858.526v.192l-6.665 4.024-5.237 3.152-1.285.791-.087.043a24.813 24.813 0 0 1-12.069 3.108c-12.484 0-22.839-9.19-24.942-21.313a58.356 58.356 0 0 0 8.434 24.317c9.208 14.818 24.778 25.126 42.791 26.917h11.014c9.743-1.037 17.878-5.015 26.429-10.387l13.149-8.199c5.923-3.87 22-13.39 26.736-18.732a26.324 26.324 0 0 0 2.773-3.764 23.82 23.82 0 0 0 1.664-3.198c.159-.378.31-.745.455-1.121.138-.372.268-.748.4-1.128.247-.73.443-1.462.631-2.215.095-.429.183-.853.27-1.275a27.68 27.68 0 0 0 .442-4.918c0-4.928-1.335-9.557-3.647-13.489a22.751 22.751 0 0 0-1.759-2.625c-.755-1-1.571-1.926-2.458-2.79-2.202-2.174-4.771-3.957-7.621-5.21a23.059 23.059 0 0 0-3.831-1.342c-.016 0-.042-.016-.058-.016l-.456-.157-4.59 2.777Z',
        fill: '#248ffa',
      },
      {
        d: 'M192.395 177.785c0 1.694-.156 3.33-.445 4.921a26.817 26.817 0 0 1-.898 3.489c-.129.378-.262.756-.4 1.124-.143.378-.296.745-.458 1.123a23.753 23.753 0 0 1-1.658 3.195 26.012 26.012 0 0 1-2.776 3.765c-4.736 5.344-20.813 14.864-26.736 18.734l-13.149 8.199c-9.64 6.055-18.747 10.341-30.232 10.635-.544.016-1.076.03-1.603.03-.742 0-1.473-.013-2.207-.043-19.448-.756-36.41-11.41-46.192-27.152a58.36 58.36 0 0 1-8.434-24.317c2.103 12.123 12.458 21.313 24.942 21.313 4.376 0 8.485-1.126 12.069-3.108l.087-.046 1.285-.789 5.237-3.151 6.665-4.024v-.192l.858-.526 59.625-36.035 4.59-2.774.456.157c.013 0 .042.016.058.016 1.32.332 2.604.789 3.831 1.342 2.85 1.253 5.417 3.036 7.621 5.21a24.614 24.614 0 0 1 2.458 2.79 22.751 22.751 0 0 1 1.759 2.625 26.577 26.577 0 0 1 3.647 13.489Z',
        fill: '#7f7f7f',
        opacity: 0.15,
      },
      {
        d: 'M192.395 177.785c0 1.694-.156 3.33-.445 4.921a26.817 26.817 0 0 1-.898 3.489c-.129.378-.262.756-.4 1.124-.143.378-.296.745-.458 1.123a23.753 23.753 0 0 1-1.658 3.195 26.012 26.012 0 0 1-2.776 3.765c-4.736 5.344-20.813 14.864-26.736 18.734l-13.149 8.199c-9.64 6.055-18.747 10.341-30.232 10.635-.544.016-1.076.03-1.603.03-.742 0-1.473-.013-2.207-.043-19.448-.756-36.41-11.41-46.192-27.152a58.36 58.36 0 0 1-8.434-24.317c2.103 12.123 12.458 21.313 24.942 21.313 4.376 0 8.485-1.126 12.069-3.108l.087-.046 1.285-.789 5.237-3.151 6.665-4.024v-.192l.858-.526 59.625-36.035 4.59-2.774.456.157c.013 0 .042.016.058.016 1.32.332 2.604.789 3.831 1.342 2.85 1.253 5.417 3.036 7.621 5.21a24.614 24.614 0 0 1 2.458 2.79 22.751 22.751 0 0 1 1.759 2.625 26.577 26.577 0 0 1 3.647 13.489Z',
        fill: '#ffffff',
        opacity: 0.15,
      },
    ],
  },
  allowedHosts: [
    'reporting.api.bingads.microsoft.com',
    'clientcenter.api.bingads.microsoft.com',
  ].concat(DMV_MICROSOFT_ADS.downloadHosts),
  errorMessage: dmvMicrosoftAdsErrorMessage_,
  accountDiscovery: {
    label: 'Microsoft Advertising account',
    credentialKeys: ['accountId', 'customerId'],
  },
  discoverAccounts: dmvMicrosoftAdsDiscoverAccounts_,
  guide: {
    intro:
      'Microsoft Advertising needs a developer token plus a Microsoft Entra app that you consent once.',
    steps: [
      'Microsoft Advertising developer portal → Account → request a developer token (approved tokens work with production accounts).',
      'Azure portal → Microsoft Entra ID → App registrations → New registration → add a client secret under Certificates & secrets.',
      'Consent the app with scope https://ads.microsoft.com/msads.manage offline_access (the quick-start guide walks through it) and keep the refresh token.',
      'An app registered for one organisation only also needs its Directory (tenant) ID from the app Overview page.',
      'Find accounts fills the account ID and customer ID; both are also under Settings → Accounts in Microsoft Advertising.',
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
      perConnection: true,
      help: 'The numeric advertising account ID (not the account number).',
    },
    { key: 'customerId', label: 'Customer ID', type: 'text', required: true, perConnection: true },
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
      key: 'tenantId',
      label: 'Tenant ID (optional)',
      type: 'text',
      required: false,
      showWhen: { key: 'authMode', value: 'oauth' },
      help: 'Leave empty for apps open to any Microsoft account. An app registered for one organisation needs its Directory (tenant) ID.',
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
  ].concat(DMV_MICROSOFT_ADS_LEVELS.map(dmvMicrosoftAdsLevelReport_)),
});
