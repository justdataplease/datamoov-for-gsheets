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
  // Not offered for now; remove this line to bring the source back.
  hidden: true,
  description: 'Daily campaign spend, delivery, engagement and conversions.',
  category: 'Marketing',
  color: '#ff0050',
  icon: {
    viewBox: '0 0 250 250',
    shapes: [
      {
        d: 'M105.168 103.231v-7.986a58.344 58.344 0 0 0-8.332-.72c-27.02-.058-50.941 17.55-59.055 43.467-8.114 25.917 1.463 54.13 23.642 69.648a62.189 62.189 0 0 1-15.663-31.479 62.378 62.378 0 0 1 3.884-34.982 61.982 61.982 0 0 1 22.18-27.23 61.466 61.466 0 0 1 33.342-10.717l.002-.001Z',
        fill: '#25f4ee',
      },
      {
        d: 'M106.666 193.697c15.107-.021 27.524-11.989 28.186-27.166V31.095h24.604a46.686 46.686 0 0 1-.716-8.576h-33.654v135.306c-.559 15.254-13.007 27.337-28.186 27.362a28.52 28.52 0 0 1-13.018-3.273 28.296 28.296 0 0 0 9.987 8.638 28.124 28.124 0 0 0 12.797 3.145Zm98.747-116.65v-7.528a45.77 45.77 0 0 1-25.452-7.724 46.622 46.622 0 0 0 25.452 15.252Z',
        fill: '#25f4ee',
      },
      {
        d: 'M179.961 61.795a46.756 46.756 0 0 1-11.521-30.767h-8.984a47.02 47.02 0 0 0 7.102 17.507 46.742 46.742 0 0 0 13.403 13.26Zm-83.125 66.573a28.149 28.149 0 0 0-17.356 6.106 28.426 28.426 0 0 0-9.943 15.555 28.558 28.558 0 0 0 1.683 18.414 28.344 28.344 0 0 0 12.596 13.471 28.477 28.477 0 0 1-2.272-29.523 28.288 28.288 0 0 1 10.395-11.286 28.08 28.08 0 0 1 14.727-4.163c2.825.038 5.63.48 8.331 1.314V103.82a58.677 58.677 0 0 0-8.331-.654h-1.498v26.183a28.784 28.784 0 0 0-8.332-.981Z',
        fill: '#fe2c55',
      },
      {
        d: 'M205.413 77.047v26.184a79.568 79.568 0 0 1-46.673-15.252v68.799c-.072 34.329-27.766 62.121-61.904 62.121a61.02 61.02 0 0 1-35.413-11.259 61.693 61.693 0 0 0 31.537 18.275 61.454 61.454 0 0 0 36.296-2.755 61.833 61.833 0 0 0 28.453-22.829 62.367 62.367 0 0 0 10.731-34.976V96.751a79.697 79.697 0 0 0 46.737 15.056V78.092a47.477 47.477 0 0 1-9.764-1.045Z',
        fill: '#fe2c55',
      },
      {
        d: 'M158.74 156.777V87.979a79.558 79.558 0 0 0 46.738 15.055V76.851a46.622 46.622 0 0 1-25.517-15.056 46.742 46.742 0 0 1-13.403-13.26 47.02 47.02 0 0 1-7.102-17.507h-24.604v135.505a28.513 28.513 0 0 1-5.896 16.241 28.252 28.252 0 0 1-14.167 9.797 28.102 28.102 0 0 1-17.191-.277 28.26 28.26 0 0 1-13.848-10.248 28.344 28.344 0 0 1-12.598-13.471 28.557 28.557 0 0 1-1.684-18.415 28.423 28.423 0 0 1 9.944-15.556 28.155 28.155 0 0 1 17.358-6.106c2.826.026 5.633.467 8.332 1.31v-26.185a61.482 61.482 0 0 0-33.546 10.658 61.987 61.987 0 0 0-22.303 27.36 62.377 62.377 0 0 0-3.812 35.169 62.18 62.18 0 0 0 15.917 31.549 61.005 61.005 0 0 0 35.478 10.54c34.137 0 61.832-27.792 61.904-62.122Z',
        fill: '#000000',
      },
    ],
  },
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
      perConnection: true,
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
