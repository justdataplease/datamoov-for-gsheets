// Meta Marketing API v26.0. Deliberately small Insights reports; no campaign mutations.
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
  ].map(function (field) {
    field.role =
      ['number', 'currency', 'percent'].indexOf(field.type) >= 0 ? 'metric' : 'dimension';
    return field;
  });
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
  if (matches.length > 1) throw new Error('Facebook Ads returned duplicate purchase action types.');
  return matches.length ? dmvNumber_(matches[0].value) : 0;
}

function dmvFacebookAdsFetch_(ctx) {
  var columns = dmvSelectFields_(ctx.fields, dmvFacebookAdsFields_()),
    connection = dmvFacebookAdsConnection_(ctx);
  var actionType = String((ctx.config || {}).purchaseActionType || 'omni_purchase');
  if (!/^[a-zA-Z][a-zA-Z0-9_.]{0,99}$/.test(actionType))
    throw new Error('Enter a valid purchase action type.');
  var names = ['date_start', 'date_stop', 'account_id', 'campaign_id', 'account_currency'];
  columns.forEach(function (field) {
    var key = field.key;
    var keys =
      key === 'purchases'
        ? ['actions']
        : key === 'purchase_value'
          ? ['action_values']
          : key === 'purchase_roas'
            ? ['action_values', 'spend']
            : [key];
    keys.forEach(function (name) {
      if (names.indexOf(name) < 0) names.push(name);
    });
  });
  var params = {
    fields: names.join(','),
    level: 'campaign',
    time_increment: 1,
    time_range: JSON.stringify({ since: ctx.startDate, until: ctx.endDate }),
    limit: Math.min(500, ctx.maxRows + 1),
    use_unified_attribution_setting: 'true',
  };
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
        var value;
        if (field.key === 'purchases') value = dmvFacebookAdsAction_(item, 'actions', actionType);
        else if (field.key === 'purchase_value')
          value = dmvFacebookAdsAction_(item, 'action_values', actionType);
        else if (field.key === 'purchase_roas') {
          var spend = dmvNumber_(item.spend),
            revenue = dmvFacebookAdsAction_(item, 'action_values', actionType);
          value = spend && revenue !== null ? revenue / spend : null;
        } else if (
          field.type === 'number' ||
          field.type === 'currency' ||
          field.type === 'percent'
        ) {
          value = dmvNumber_(item[field.key]);
          if (field.type === 'percent' && value !== null) value = value / 100;
        } else value = dmvTextValue_(item[field.key]);
        row[field.key] = value;
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
      grain: 'Daily campaign',
      complete: true,
    },
  };
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

dmvRegisterConnector_({
  id: 'facebook_ads',
  label: 'Facebook Ads',
  description: 'Facebook and Instagram daily campaign performance.',
  category: 'Marketing',
  color: '#0866ff',
  test: dmvFacebookAdsTest_,
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
      configFields: [
        {
          key: 'purchaseActionType',
          label: 'Purchase action type',
          type: 'text',
          default: 'omni_purchase',
          required: true,
          help: 'One action type, such as omni_purchase or offsite_conversion.fb_pixel_purchase. Overlapping action types are never summed.',
        },
      ],
      fetch: dmvFacebookAdsFetch_,
    },
  ],
});
