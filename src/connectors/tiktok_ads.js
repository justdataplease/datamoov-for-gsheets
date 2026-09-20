/** TikTok Marketing API v1.3 integrated report; daily campaign grain, no campaign mutations. */
function dmvTiktokFields_() {
  var f = dmvField_;
  return [
    f('stat_time_day', 'Date', 'date', true, { role: 'dimension' }),
    f('campaign_id', 'Campaign ID', 'text', true, { role: 'dimension' }),
    f('campaign_name', 'Campaign', 'text', true, { role: 'dimension' }),
    f('spend', 'Spend', 'currency', true, { role: 'metric' }),
    f('impressions', 'Impressions', 'number', true, { role: 'metric' }),
    f('clicks', 'Clicks', 'number', true, { role: 'metric' }),
    f('ctr', 'CTR', 'percent', true, { role: 'metric' }),
    f('cpc', 'CPC', 'currency', false, { role: 'metric' }),
    f('cpm', 'CPM', 'currency', false, { role: 'metric' }),
    f('reach', 'Reach', 'number', false, { role: 'metric', additive: false }),
    f('conversion', 'Conversions', 'number', true, { role: 'metric' }),
    f('cost_per_conversion', 'Cost per conversion', 'currency', false, { role: 'metric' }),
    f('conversion_rate', 'Conversion rate', 'percent', false, { role: 'metric' }),
    f('video_play_actions', 'Video plays', 'number', false, { role: 'metric' }),
    f('video_watched_2s', '2-second views', 'number', false, { role: 'metric' }),
    f('video_watched_6s', '6-second views', 'number', false, { role: 'metric' }),
    f('likes', 'Likes', 'number', false, { role: 'metric' }),
    f('comments', 'Comments', 'number', false, { role: 'metric' }),
    f('shares', 'Shares', 'number', false, { role: 'metric' }),
    f('follows', 'Follows', 'number', false, { role: 'metric' }),
  ];
}

function dmvTiktokConnection_(ctx) {
  var id = String((ctx.credentials || {}).advertiserId || '').trim();
  if (!/^\d{1,30}$/.test(id)) throw new Error('Enter a numeric TikTok advertiser ID.');
  var token = String((ctx.credentials || {}).accessToken || '').trim();
  if (!token) throw new Error('Enter a TikTok Marketing API access token.');
  return {
    id: id,
    base: 'https://business-api.tiktok.com/open_api/v1.3/',
    headers: { 'Access-Token': token },
  };
}

function dmvTiktokRequest_(ctx, connection, path, params) {
  var payload = ctx.http({
    url: connection.base + path + '?' + dmvQueryString_(params),
    headers: connection.headers,
  });
  if (!payload || typeof payload !== 'object')
    throw new Error('TikTok returned an unreadable response.');
  if (payload.code !== 0)
    throw new Error(
      'TikTok rejected the request' +
        (payload.message ? ': ' + String(payload.message).slice(0, 200) : '.')
    );
  if (!payload.data || typeof payload.data !== 'object')
    throw new Error('TikTok returned an empty response.');
  return payload.data;
}

function dmvTiktokAdvertiser_(ctx, connection) {
  var data = dmvTiktokRequest_(ctx, connection, 'advertiser/info/', {
    advertiser_ids: JSON.stringify([connection.id]),
    fields: JSON.stringify(['advertiser_id', 'name', 'currency', 'timezone']),
  });
  var info = Array.isArray(data.list) ? data.list[0] : null;
  if (!info || String(info.advertiser_id) !== connection.id)
    throw new Error('TikTok did not return the requested advertiser.');
  return info;
}

function dmvTiktokFetch_(ctx) {
  var columns = dmvSelectFields_(ctx.fields, dmvTiktokFields_());
  var connection = dmvTiktokConnection_(ctx);
  var advertiser = dmvTiktokAdvertiser_(ctx, connection);
  var metrics = columns
    .filter(function (field) {
      return field.key !== 'stat_time_day' && field.key !== 'campaign_id';
    })
    .map(function (field) {
      return field.key;
    });
  if (metrics.indexOf('campaign_name') < 0) metrics.push('campaign_name');
  var rows = [],
    seen = Object.create(null),
    page = 1,
    totalPages = 1,
    pageSize = Math.min(1000, ctx.maxRows + 1);
  do {
    ctx.checkDeadline();
    if (page > 100) throw new Error('TikTok returned too many pages. Narrow the date range.');
    var data = dmvTiktokRequest_(ctx, connection, 'report/integrated/get/', {
      advertiser_id: connection.id,
      service_type: 'AUCTION',
      report_type: 'BASIC',
      data_level: 'AUCTION_CAMPAIGN',
      dimensions: JSON.stringify(['campaign_id', 'stat_time_day']),
      metrics: JSON.stringify(metrics),
      start_date: ctx.startDate,
      end_date: ctx.endDate,
      page: page,
      page_size: pageSize,
    });
    if (!Array.isArray(data.list) || !data.page_info)
      throw new Error('TikTok returned an incomplete report page.');
    var info = data.page_info;
    if (
      !Number.isInteger(Number(info.total_page)) ||
      Number(info.total_page) < 0 ||
      Number(info.page) !== page
    )
      throw new Error('TikTok returned invalid paging information.');
    totalPages = Number(info.total_page);
    if (Number(info.total_number) > ctx.maxRows)
      throw new Error(
        'This report exceeds the row limit. Choose a smaller date range or raise the limit.'
      );
    var mapped = data.list.map(function (item) {
      var dimensions = item.dimensions || {},
        values = item.metrics || {};
      var date = String(dimensions.stat_time_day || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('TikTok returned an invalid date.');
      var id = String(dimensions.campaign_id || '');
      if (!id) throw new Error('TikTok returned a row without a campaign.');
      if (seen[id + ':' + date])
        throw new Error('TikTok returned duplicate rows while paging. Retry the report.');
      seen[id + ':' + date] = true;
      var row = {};
      columns.forEach(function (field) {
        if (field.key === 'stat_time_day') row[field.key] = date;
        else if (field.key === 'campaign_id') row[field.key] = id;
        else if (field.type === 'percent') {
          // TikTok rates are percentages (1.5 means 1.5%).
          var rate = dmvNumber_(values[field.key]);
          row[field.key] = rate === null ? null : rate / 100;
        } else if (field.type === 'number' || field.type === 'currency')
          row[field.key] = dmvNumber_(values[field.key]);
        else row[field.key] = dmvTextValue_(values[field.key]);
      });
      return row;
    });
    dmvAppendPage_(rows, mapped, ctx.maxRows);
    if (!data.list.length && page < totalPages)
      throw new Error('TikTok returned an empty nonterminal page.');
    page++;
  } while (page <= totalPages);
  return {
    columns: columns,
    rows: rows,
    metadata: {
      apiVersion: 'v1.3',
      advertiserId: connection.id,
      currency: advertiser.currency || '',
      timeZone: advertiser.timezone || '',
      attribution: 'TikTok reporting attribution; auction campaigns only.',
      grain: 'Daily campaign',
      complete: true,
    },
  };
}

dmvRegisterConnector_({
  id: 'tiktok_ads',
  label: 'TikTok Ads',
  description: 'Daily campaign spend, delivery, engagement and conversions.',
  category: 'Marketing',
  color: '#ff0050',
  allowedHosts: ['business-api.tiktok.com'],
  guide: {
    intro: 'TikTok issues long-lived Marketing API tokens to a developer app you authorize once.',
    steps: [
      'TikTok for Business developer portal → My apps → Create app with the Reporting permission.',
      'Open the app authorization link, sign in as an advertiser admin and approve the ad account.',
      'Exchange the auth code for an access token (Authorization → Get access token). It does not expire unless revoked.',
      'The advertiser ID is shown next to the account name in TikTok Ads Manager.',
    ],
    links: [
      { label: 'TikTok developer portal', url: 'https://business-api.tiktok.com/portal' },
      {
        label: 'Authorization guide',
        url: 'https://business-api.tiktok.com/portal/docs?id=1738373141733378',
      },
    ],
  },
  authFields: [
    {
      key: 'advertiserId',
      label: 'Advertiser ID',
      type: 'text',
      required: true,
      help: 'The numeric advertiser (ad account) ID from TikTok Ads Manager.',
    },
    {
      key: 'accessToken',
      label: 'Access token',
      type: 'password',
      required: true,
      help: 'A long-lived Marketing API access token authorized for this advertiser.',
    },
  ],
  test: function (ctx) {
    dmvTiktokAdvertiser_(ctx, dmvTiktokConnection_(ctx));
  },
  reports: [
    {
      id: 'campaign_daily',
      label: 'Daily campaign performance',
      description:
        'Spend, impressions, clicks, conversions and engagement per auction campaign per day.',
      fields: dmvTiktokFields_(),
      configFields: [],
      dateRange: true,
      fetch: dmvTiktokFetch_,
    },
  ],
});
