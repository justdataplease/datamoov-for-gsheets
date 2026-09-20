// Meta Marketing API v26.0 Insights. Read-only: no campaign mutations.
var DMV_FACEBOOK_ADS_ACTION =
  /^(actions|action_values|cost_per_action_type):([a-zA-Z][a-zA-Z0-9_.]{0,99})$/;

// The deepest entity column selected decides the Insights level.
var DMV_FACEBOOK_ADS_LEVELS = [
  ['ad', ['ad_id', 'ad_name']],
  ['adset', ['adset_id', 'adset_name', 'optimization_goal']],
  ['campaign', ['campaign_id', 'campaign_name', 'objective', 'buying_type']],
];

// Columns sent as breakdowns instead of fields. Meta accepts only some combinations and says
// which when it refuses one.
var DMV_FACEBOOK_ADS_BREAKDOWNS = [
  'age',
  'gender',
  'country',
  'region',
  'dma',
  'publisher_platform',
  'platform_position',
  'impression_device',
  'device_platform',
  'hourly_stats_aggregated_by_advertiser_time_zone',
];

// Metrics Meta returns as a list with one entry rather than as a number.
var DMV_FACEBOOK_ADS_LISTS = [
  'outbound_clicks',
  'video_play_actions',
  'video_p25_watched_actions',
  'video_p50_watched_actions',
  'video_p75_watched_actions',
  'video_p100_watched_actions',
  'video_thruplay_watched_actions',
  'video_avg_time_watched_actions',
];

function dmvFacebookAdsRole_(field) {
  field.role = ['number', 'currency', 'percent'].indexOf(field.type) >= 0 ? 'metric' : 'dimension';
  return field;
}

function dmvFacebookAdsFields_() {
  var f = dmvField_;
  return [
    f('date_start', 'Date', 'date', true),
    f('account_id', 'Account ID', 'text', true),
    f('account_currency', 'Currency', 'text', true),
    f('campaign_id', 'Campaign ID', 'text', true),
    f('campaign_name', 'Campaign', 'text', true),
    f('spend', 'Spend', 'currency', true),
    f('impressions', 'Impressions', 'number', true),
    f('clicks', 'Clicks', 'number', true),
    f('purchases', 'Purchases', 'number', true),
    f('purchase_value', 'Purchase value', 'currency', true),
    f('account_name', 'Account', 'text', false),
    f('objective', 'Objective', 'text', false),
    f('inline_link_clicks', 'Link clicks', 'number', false),
    f('ctr', 'CTR', 'percent', false),
    f('cpc', 'CPC', 'currency', false),
    f('cpm', 'CPM', 'currency', false),
    f('purchase_roas', 'Purchase ROAS', 'number', false),
    f('attribution_setting', 'Attribution setting', 'text', false),
  ].map(dmvFacebookAdsRole_);
}

function dmvFacebookAdsInsightFields_() {
  var f = dmvField_,
    single = { additive: false };
  return [
    f('date_start', 'Date', 'date', true),
    f('week', 'Week', 'date', false),
    f('month', 'Month', 'date', false),
    f('date_stop', 'Period end', 'date', false),
    f('account_currency', 'Currency', 'text', true),
    f('campaign_name', 'Campaign', 'text', true),
    f('adset_name', 'Ad set', 'text', false),
    f('ad_name', 'Ad', 'text', false),
    f('account_id', 'Account ID', 'text', false),
    f('account_name', 'Account', 'text', false),
    f('campaign_id', 'Campaign ID', 'text', false),
    f('adset_id', 'Ad set ID', 'text', false),
    f('ad_id', 'Ad ID', 'text', false),
    f('objective', 'Objective', 'text', false),
    f('buying_type', 'Buying type', 'text', false),
    f('optimization_goal', 'Optimization goal', 'text', false),
    f('attribution_setting', 'Attribution setting', 'text', false),
    f('age', 'Age', 'text', false),
    f('gender', 'Gender', 'text', false),
    f('country', 'Country', 'text', false),
    f('region', 'Region', 'text', false),
    f('dma', 'DMA region', 'text', false),
    f('publisher_platform', 'Platform', 'text', false),
    f('platform_position', 'Placement', 'text', false),
    f('impression_device', 'Impression device', 'text', false),
    f('device_platform', 'Device platform', 'text', false),
    f('hourly_stats_aggregated_by_advertiser_time_zone', 'Hour of day', 'text', false),
    f('spend', 'Spend', 'currency', true),
    f('impressions', 'Impressions', 'number', true),
    f('reach', 'Reach', 'number', false, single),
    f('frequency', 'Frequency', 'number', false, single),
    f('clicks', 'Clicks (all)', 'number', true),
    f('inline_link_clicks', 'Link clicks', 'number', true),
    f('outbound_clicks', 'Outbound clicks', 'number', false),
    f('unique_clicks', 'Unique clicks (all)', 'number', false, single),
    f('unique_inline_link_clicks', 'Unique link clicks', 'number', false, single),
    f('ctr', 'CTR (all)', 'percent', false),
    f('inline_link_click_ctr', 'CTR (link)', 'percent', false),
    f('cpc', 'CPC (all)', 'currency', false, single),
    f('cost_per_inline_link_click', 'CPC (link)', 'currency', false, single),
    f('cpm', 'CPM', 'currency', false, single),
    f('cpp', 'Cost per 1,000 people reached', 'currency', false, single),
    f('purchases', 'Purchases', 'number', true),
    f('purchase_value', 'Purchase value', 'currency', true),
    f('purchase_roas', 'Purchase ROAS', 'number', false, single),
    f('actions:lead', 'Leads', 'number', false),
    f('cost_per_action_type:lead', 'Cost per lead', 'currency', false, single),
    f('actions:landing_page_view', 'Landing page views', 'number', false),
    f('actions:omni_view_content', 'Content views', 'number', false),
    f('actions:omni_add_to_cart', 'Adds to cart', 'number', false),
    f('action_values:omni_add_to_cart', 'Adds to cart value', 'currency', false),
    f('actions:omni_initiated_checkout', 'Checkouts initiated', 'number', false),
    f('actions:omni_complete_registration', 'Registrations completed', 'number', false),
    f('actions:omni_app_install', 'App installs', 'number', false),
    f(
      'actions:onsite_conversion.messaging_conversation_started_7d',
      'Messaging conversations started',
      'number',
      false
    ),
    f('actions:post_engagement', 'Post engagements', 'number', false),
    f('actions:page_engagement', 'Page engagements', 'number', false),
    f('actions:post_reaction', 'Post reactions', 'number', false),
    f('actions:comment', 'Post comments', 'number', false),
    f('actions:post', 'Post shares', 'number', false),
    f('actions:video_view', '3-second video plays', 'number', false),
    f('video_play_actions', 'Video plays', 'number', false),
    f('video_thruplay_watched_actions', 'ThruPlays', 'number', false),
    f('video_p25_watched_actions', 'Video plays at 25%', 'number', false),
    f('video_p50_watched_actions', 'Video plays at 50%', 'number', false),
    f('video_p75_watched_actions', 'Video plays at 75%', 'number', false),
    f('video_p100_watched_actions', 'Video plays at 100%', 'number', false),
    f('video_avg_time_watched_actions', 'Average video play time (s)', 'number', false, single),
  ].map(dmvFacebookAdsRole_);
}

function dmvFacebookAdsConnection_(ctx) {
  var c = ctx.credentials || {},
    id = String(c.adAccountId || '')
      .replace(/^act_/, '')
      .trim();
  if (!/^\d{1,30}$/.test(id)) throw new Error('Enter a numeric Facebook ad account ID.');
  if (!c.accessToken) throw new Error('Enter a Facebook Ads access token with ads_read access.');
  return {
    id: id,
    headers: { Authorization: 'Bearer ' + c.accessToken },
    base: 'https://graph.facebook.com/v26.0/act_' + id,
  };
}

function dmvFacebookAdsAction_(row, field, actionType) {
  var actions = row[field];
  if (actions === undefined || actions === null) return 0;
  if (!Array.isArray(actions)) throw new Error('Facebook Ads returned an invalid action metric.');
  var matches = actions.filter(function (action) {
    return action.action_type === actionType;
  });
  if (matches.length > 1) throw new Error('Facebook Ads returned duplicate action types.');
  return matches.length ? dmvNumber_(matches[0].value) : 0;
}

// A column for any action type: "actions:lead", "action_values:lead", "cost_per_action_type:lead".
function dmvFacebookAdsActionColumn_(key, names) {
  var match = DMV_FACEBOOK_ADS_ACTION.exec(String(key));
  if (!match) return null;
  var type = match[2],
    text = (names && names[type]) || type.replace(/[._]+/g, ' ');
  var plain = text;
  text = text.charAt(0).toUpperCase() + text.slice(1);
  return dmvFacebookAdsRole_(
    match[1] === 'actions'
      ? dmvField_(key, text, 'number', false)
      : match[1] === 'action_values'
        ? dmvField_(key, text + ' value', 'currency', false)
        : dmvField_(key, 'Cost per ' + plain, 'currency', false, { additive: false })
  );
}

// Custom conversions are reported under their id; their names make the column readable.
function dmvFacebookAdsConversionNames_(ctx, connection) {
  var names = {};
  try {
    var payload = ctx.http({
      url: connection.base + '/customconversions?fields=id,name&limit=200',
      headers: connection.headers,
    });
    ((payload && payload.data) || []).forEach(function (item) {
      if (item && item.id && item.name)
        names['offsite_conversion.custom.' + item.id] = String(item.name).slice(0, 80);
    });
  } catch (ignored) {
    // A token without access to custom conversions still reports them, under their id.
  }
  return names;
}

// Calendar weeks from Monday, cut to the requested dates like the chat's weekly buckets.
function dmvFacebookAdsWeeks_(startDate, endDate) {
  var day = 86400000,
    text = function (time) {
      return new Date(time).toISOString().slice(0, 10);
    },
    start = Date.parse(startDate + 'T00:00:00Z'),
    end = Date.parse(endDate + 'T00:00:00Z'),
    ranges = [];
  while (start <= end) {
    var sunday = start + ((7 - new Date(start).getUTCDay()) % 7) * day;
    ranges.push({ since: text(start), until: text(Math.min(sunday, end)) });
    start = sunday + day;
  }
  if (ranges.length > 60)
    throw new Error('Weekly rows cover at most 60 weeks. Choose a shorter date range or Month.');
  return ranges;
}

function dmvFacebookAdsMonday_(date) {
  var time = Date.parse(date + 'T00:00:00Z');
  return new Date(time - ((new Date(time).getUTCDay() + 6) % 7) * 86400000)
    .toISOString()
    .slice(0, 10);
}

// One Insights engine for both reports. "fixed" pins the level and the daily grain of the
// original campaign report; otherwise the selected columns decide both.
function dmvFacebookAdsInsights_(ctx, available, fixed) {
  var connection = dmvFacebookAdsConnection_(ctx),
    selected = ctx.fields && ctx.fields.length ? ctx.fields : dmvDefaultFields_(available),
    keys = Array.isArray(selected) ? selected : [];
  var custom =
    !fixed &&
    keys.some(function (key) {
      return /:offsite_conversion\.custom\.\d+$/.test(String(key));
    });
  var conversions = custom ? dmvFacebookAdsConversionNames_(ctx, connection) : {};
  var columns = dmvSelectFields_(
    keys,
    available.concat(
      fixed
        ? []
        : keys
            .filter(function (key) {
              return !available.some(function (field) {
                return field.key === key;
              });
            })
            .map(function (key) {
              return dmvFacebookAdsActionColumn_(key, conversions);
            })
            .filter(Boolean)
    )
  );
  var has = function (key) {
    return columns.some(function (field) {
      return field.key === key;
    });
  };
  var actionType = String((ctx.config || {}).purchaseActionType || 'omni_purchase');
  if (!/^[a-zA-Z][a-zA-Z0-9_.]{0,99}$/.test(actionType))
    throw new Error('Enter a valid purchase action type.');

  var grains = ['date_start', 'week', 'month'].filter(has);
  if (grains.length > 1) throw new Error('Choose one of Date, Week or Month, not several.');
  var grain = fixed ? 'date_start' : grains[0] || '';
  var level = fixed
    ? fixed
    : (DMV_FACEBOOK_ADS_LEVELS.filter(function (entry) {
        return entry[1].some(has);
      })[0] || ['account'])[0];
  var breakdowns = DMV_FACEBOOK_ADS_BREAKDOWNS.filter(has);

  var requested = fixed
    ? ['date_start', 'date_stop', 'account_id', 'campaign_id', 'account_currency']
    : ['date_start', 'date_stop', 'account_currency'];
  columns.forEach(function (field) {
    var key = field.key,
      action = DMV_FACEBOOK_ADS_ACTION.exec(key);
    var wanted = action
      ? [action[1]]
      : key === 'purchases'
        ? ['actions']
        : key === 'purchase_value'
          ? ['action_values']
          : key === 'purchase_roas'
            ? ['action_values', 'spend']
            : key === 'week' || key === 'month' || breakdowns.indexOf(key) >= 0
              ? []
              : [key];
    wanted.forEach(function (name) {
      if (requested.indexOf(name) < 0) requested.push(name);
    });
  });
  var params = {
    fields: requested.join(','),
    level: level,
    limit: Math.min(500, ctx.maxRows + 1),
    use_unified_attribution_setting: 'true',
  };
  if (grain === 'week')
    params.time_ranges = JSON.stringify(dmvFacebookAdsWeeks_(ctx.startDate, ctx.endDate));
  else {
    params.time_increment = grain === 'date_start' ? 1 : grain === 'month' ? 'monthly' : 'all_days';
    params.time_range = JSON.stringify({ since: ctx.startDate, until: ctx.endDate });
  }
  if (breakdowns.length) params.breakdowns = breakdowns.join(',');
  // Without a period the rows are a ranking, so the biggest spenders come first.
  if (!grain && has('spend')) params.sort = 'spend_descending';

  var account = ctx.http({
    url: connection.base + '?fields=currency,timezone_name',
    headers: connection.headers,
  });
  if (!account || account.error)
    throw new Error('Facebook Ads account metadata could not be read.');
  var rows = [],
    after = '',
    seen = {},
    pages = 0;
  do {
    ctx.checkDeadline();
    if (++pages > 100)
      throw new Error('Facebook Ads returned too many pages. Narrow the date range.');
    if (after) params.after = after;
    var payload = ctx.http({
      url: connection.base + '/insights?' + dmvQueryString_(params),
      headers: connection.headers,
    });
    if (!payload || payload.error || !Array.isArray(payload.data))
      throw new Error('Facebook Ads did not return a complete Insights page.');
    var mapped = payload.data.map(function (item) {
      var row = {};
      columns.forEach(function (field) {
        var key = field.key,
          action = DMV_FACEBOOK_ADS_ACTION.exec(key),
          value;
        if (key === 'purchases') value = dmvFacebookAdsAction_(item, 'actions', actionType);
        else if (key === 'purchase_value')
          value = dmvFacebookAdsAction_(item, 'action_values', actionType);
        else if (key === 'purchase_roas') {
          var spend = dmvNumber_(item.spend),
            revenue = dmvFacebookAdsAction_(item, 'action_values', actionType);
          value = spend && revenue !== null ? revenue / spend : null;
        } else if (action) {
          value = dmvFacebookAdsAction_(item, action[1], action[2]);
          // A cost that was not reported is unknown, not free.
          if (action[1] === 'cost_per_action_type' && !value) value = null;
        } else if (DMV_FACEBOOK_ADS_LISTS.indexOf(key) >= 0) {
          if (item[key] !== undefined && item[key] !== null && !Array.isArray(item[key]))
            throw new Error('Facebook Ads returned an invalid action metric.');
          value = (item[key] || []).reduce(function (sum, entry) {
            return sum + (dmvNumber_(entry && entry.value) || 0);
          }, 0);
        } else if (key === 'week')
          value = item.date_start ? dmvFacebookAdsMonday_(String(item.date_start)) : null;
        else if (key === 'month')
          value = item.date_start ? String(item.date_start).slice(0, 7) + '-01' : null;
        else if (field.type === 'number' || field.type === 'currency' || field.type === 'percent') {
          value = dmvNumber_(item[key]);
          if (field.type === 'percent' && value !== null) value = value / 100;
        } else value = dmvTextValue_(item[key]);
        row[key] = value;
      });
      return row;
    });
    dmvAppendPage_(rows, mapped, ctx.maxRows);
    var paging = payload.paging || {};
    after = '';
    if (paging.next) {
      // Rebuild the known endpoint with the cursor; never follow a next URL carrying credentials.
      if (typeof paging.next !== 'string' || !/^https:\/\/graph\.facebook\.com\//.test(paging.next))
        throw new Error('Facebook Ads returned an unsafe next-page address.');
      after = paging.cursors && paging.cursors.after;
      if (typeof after !== 'string' || !after || seen[after] || !payload.data.length)
        throw new Error('Facebook Ads returned an invalid or repeated page cursor.');
      seen[after] = true;
    }
  } while (after);
  var grainLabel =
    (grain === 'date_start'
      ? 'Daily '
      : grain === 'week'
        ? 'Weekly '
        : grain === 'month'
          ? 'Monthly '
          : 'Whole-period ') +
    { account: 'account', campaign: 'campaign', adset: 'ad set', ad: 'ad' }[level] +
    (breakdowns.length ? ' by ' + breakdowns.join(', ').replace(/_/g, ' ') : '');
  return {
    columns: columns,
    rows: rows,
    metadata: {
      apiVersion: 'v26.0',
      accountId: connection.id,
      currency: account.currency || '',
      timeZone: account.timezone_name || '',
      purchaseActionType: actionType,
      attribution:
        'Provider ad-set attribution settings (unified attribution requested); provider-selected action report time.',
      grain: grainLabel,
      complete: true,
    },
  };
}

function dmvFacebookAdsFetch_(ctx) {
  return dmvFacebookAdsInsights_(ctx, dmvFacebookAdsFields_(), 'campaign');
}

// Load columns adds every action type the account reported in the last 90 days.
function dmvFacebookAdsDiscover_(ctx) {
  var connection = dmvFacebookAdsConnection_(ctx),
    curated = dmvFacebookAdsInsightFields_();
  var payload = ctx.http({
    url:
      connection.base +
      '/insights?' +
      dmvQueryString_({
        fields: 'actions,action_values',
        level: 'account',
        date_preset: 'last_90d',
        use_unified_attribution_setting: 'true',
      }),
    headers: connection.headers,
  });
  if (!payload || payload.error || !Array.isArray(payload.data))
    throw new Error('Facebook Ads did not return the account action types.');
  var found = { actions: {}, action_values: {} };
  payload.data.slice(0, 10).forEach(function (item) {
    ['actions', 'action_values'].forEach(function (list) {
      (Array.isArray(item && item[list]) ? item[list] : []).forEach(function (action) {
        var type = action && action.action_type;
        if (typeof type === 'string' && DMV_FACEBOOK_ADS_ACTION.test(list + ':' + type))
          found[list][type] = true;
      });
    });
  });
  var types = Object.keys(found.actions).sort().slice(0, 150);
  var names = types.some(function (type) {
    return /^offsite_conversion\.custom\.\d+$/.test(type);
  })
    ? dmvFacebookAdsConversionNames_(ctx, connection)
    : {};
  var known = {};
  curated.forEach(function (field) {
    known[field.key] = true;
  });
  var extra = [];
  types.forEach(function (type) {
    ['actions', 'action_values', 'cost_per_action_type'].forEach(function (list) {
      if (list === 'action_values' && !found.action_values[type]) return;
      var key = list + ':' + type;
      if (!known[key]) extra.push(dmvFacebookAdsActionColumn_(key, names));
    });
  });
  return curated.concat(extra);
}

// Meta explains a refused request (an unsupported breakdown combination, a field that does not
// fit the level) in words about the request itself. Anything else gets fixed guidance only.
function dmvFacebookAdsErrorMessage_(code, body) {
  var error = (body && body.error) || {},
    number = Number(error.code);
  if (number === 190)
    return 'Facebook Ads rejected the access token. Generate a new system user token with ads_read and update the saved credential.';
  if (number === 10 || number === 200 || number === 294 || number === 3)
    return 'The token has no access to this ad account or lacks ads_read. Assign the ad account to the system user with View performance, then generate the token with ads_read.';
  if (number === 4 || number === 17 || number === 613 || number === 80000 || number === 80004)
    return 'Facebook Ads is rate limiting this ad account. Wait a few minutes, then refresh again.';
  if (number === 1 || number === 2 || number === 960)
    return 'Facebook Ads could not process this much data in one request. Choose a shorter date range, fewer breakdowns or a higher level (campaign instead of ad).';
  if (number === 100 && typeof error.message === 'string')
    return (
      'Facebook Ads rejected the request. ' +
      String(error.error_user_msg || error.message)
        .slice(0, 260)
        .replace(/[\s.]+$/, '') +
      '. Breakdown columns combine only in the sets Meta supports.'
    ).slice(0, 400);
  return '';
}

function dmvFacebookAdsTest_(ctx) {
  var connection = dmvFacebookAdsConnection_(ctx);
  var response = ctx.http({
    url: connection.base + '?fields=account_id',
    headers: connection.headers,
  });
  if (!response || !response.account_id || String(response.account_id) !== connection.id)
    throw new Error('Facebook Ads did not return the requested account.');
}

var DMV_FACEBOOK_ADS_PURCHASE = {
  key: 'purchaseActionType',
  label: 'Purchase action type',
  type: 'text',
  default: 'omni_purchase',
  required: true,
  help: 'One action type, such as omni_purchase or offsite_conversion.fb_pixel_purchase. Overlapping action types are never summed.',
};

dmvRegisterConnector_({
  id: 'facebook_ads',
  label: 'Facebook Ads',
  description: 'Facebook and Instagram performance at any level, with breakdowns and conversions.',
  category: 'Marketing',
  color: '#0866ff',
  icon: {
    viewBox: '0 0 250 250',
    shapes: [
      {
        d: 'M96.902 218.069V142.91H76.5v-31.754h19.79c0-3.197.01-6.272.019-9.282.018-5.832.036-11.418-.02-17.164 0-25.004 19.028-32.259 36.134-32.259h28.84V83.82c-1.651.01-6.56.006-11.055.003l-5.653-.003c-.021 0-.054 0-.097-.002-1.21-.025-10.712-.222-10.712 9.317.062 4.036 0 17.933 0 17.933h27.629l-2.239 31.24h-24.744v79.446C183.557 217.029 222 175.605 222 125.201c0-53.571-43.428-97-97-97s-97 43.429-97 97c0 43.801 29.032 80.821 68.902 92.868Z',
        fill: '#4089e9',
        rule: 'evenodd',
      },
    ],
  },
  test: dmvFacebookAdsTest_,
  errorMessage: dmvFacebookAdsErrorMessage_,
  allowedHosts: ['graph.facebook.com'],
  guide: {
    intro: 'A system user token from Meta Business Suite keeps working without a browser login.',
    steps: [
      'Meta Business Suite → Settings → Users → System users → Add (Admin or Employee role).',
      'Assign assets: give the system user the ad account with View performance.',
      'Generate token → choose the app → tick ads_read → set expiry to Never → copy the token.',
      'The ad account ID is the number under Accounts → Ad accounts, with or without act_.',
    ],
    links: [
      { label: 'System users', url: 'https://business.facebook.com/settings/system-users' },
      {
        label: 'Marketing API tokens',
        url: 'https://developers.facebook.com/docs/marketing-api/overview/authorization',
      },
    ],
  },
  authFields: [
    {
      key: 'adAccountId',
      label: 'Ad account ID',
      type: 'text',
      required: true,
      perConnection: true,
      help: 'Numeric account ID, with or without act_.',
    },
    {
      key: 'accessToken',
      label: 'Access token',
      type: 'password',
      required: true,
      help: 'Use a token with ads_read permission for this ad account.',
    },
  ],
  reports: [
    {
      id: 'campaign_daily',
      label: 'Daily campaign performance',
      description:
        'Core delivery and purchase metrics using your Meta attribution settings. Choose from the supported report fields.',
      fields: dmvFacebookAdsFields_(),
      dateRange: true,
      configFields: [DMV_FACEBOOK_ADS_PURCHASE],
      fetch: dmvFacebookAdsFetch_,
    },
    {
      id: 'insights',
      label: 'Insights (any level and breakdown)',
      description:
        'One row per combination of the dimensions you select. Campaign, Ad set or Ad sets the level; Date, Week or Month sets the period (none gives totals); Age, Gender, Country, Platform or Placement split the rows. Load columns adds every conversion and action your account reports.',
      fields: dmvFacebookAdsInsightFields_(),
      dateRange: true,
      configFields: [DMV_FACEBOOK_ADS_PURCHASE],
      fetch: function (ctx) {
        return dmvFacebookAdsInsights_(ctx, dmvFacebookAdsInsightFields_());
      },
      discoverFields: dmvFacebookAdsDiscover_,
    },
  ],
});
