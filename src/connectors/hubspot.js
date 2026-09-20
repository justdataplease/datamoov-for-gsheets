/** HubSpot CRM deals. Provider-specific search and property discovery. */
function dmvHubspotFields_() {
  return [
    { key: 'id', label: 'Deal ID', type: 'text', default: true },
    { key: 'dealname', label: 'Deal name', type: 'text', default: true },
    { key: 'dealstage', label: 'Stage ID', type: 'text', default: true },
    { key: 'pipeline', label: 'Pipeline ID', type: 'text', default: true },
    { key: 'amount', label: 'Amount', type: 'currency', default: true },
    { key: 'deal_currency_code', label: 'Currency', type: 'text', default: true },
    { key: 'hubspot_owner_id', label: 'Owner ID', type: 'text', default: true },
    { key: 'createdate', label: 'Created at', type: 'date', default: true },
    { key: 'closedate', label: 'Close date', type: 'date', default: true },
    { key: 'hs_lastmodifieddate', label: 'Updated at', type: 'date', default: true },
  ];
}

function dmvHubspotRequest_(ctx, path, body) {
  var token = String(ctx.credentials.accessToken || '').trim();
  if (!token) throw new Error('Enter a HubSpot private-app access token.');
  var request = {
    url: 'https://api.hubapi.com' + path,
    headers: { Authorization: 'Bearer ' + token },
  };
  if (body) {
    request.method = 'post';
    request.body = body;
    request.retrySafe = true;
  }
  return ctx.http(request);
}

function dmvHubspotDiscover_(ctx) {
  var response = dmvHubspotRequest_(ctx, '/crm/v3/properties/deals');
  if (!response || !Array.isArray(response.results)) {
    throw new Error('HubSpot returned an invalid property catalog.');
  }
  var fields = dmvHubspotFields_();
  var seen = Object.create(null);
  fields.forEach(function (field) {
    seen[field.key] = true;
  });
  response.results.forEach(function (property) {
    if (
      !property ||
      property.archived ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(property.name) ||
      seen[property.name]
    )
      return;
    seen[property.name] = true;
    fields.push({
      key: property.name,
      label: String(property.label || property.name),
      type:
        property.type === 'number'
          ? 'number'
          : property.type === 'date' || property.type === 'datetime'
            ? 'date'
            : 'text',
    });
  });
  return fields;
}

function dmvHubspotFetch_(ctx) {
  // Custom properties only need the discovery call when a selected key is not a standard one.
  var fields = dmvHubspotFields_();
  if (dmvNeedsDiscovery_(ctx.fields, fields)) fields = dmvHubspotDiscover_(ctx);
  var columns = dmvSelectFields_(ctx.fields, fields);
  var selected = columns.map(function (field) {
    return field.key;
  });
  var dateField = ctx.config.dateField || 'hs_lastmodifieddate';
  if (['hs_lastmodifieddate', 'createdate', 'closedate'].indexOf(dateField) < 0)
    throw new Error('Choose a valid deal date filter.');
  var window = dmvUtcWindow_(ctx),
    start = window.start,
    end = window.end;
  var maximum = Math.min(10000, Number(ctx.maxRows) || 1000);
  var body = {
    properties: selected.filter(function (key) {
      return key !== 'id';
    }),
    filterGroups: [
      {
        filters: [
          { propertyName: dateField, operator: 'GTE', value: String(start) },
          { propertyName: dateField, operator: 'LT', value: String(end) },
        ],
      },
    ],
    sorts: [dateField],
    limit: Math.min(200, maximum + 1),
  };
  var rows = [],
    cursors = Object.create(null),
    ids = Object.create(null),
    pages = 0;
  do {
    if (ctx.checkDeadline) ctx.checkDeadline();
    if (++pages > 100)
      throw new Error('HubSpot pagination exceeded the report budget. Narrow the date range.');
    var response = dmvHubspotRequest_(ctx, '/crm/v3/objects/deals/search', body);
    if (!response || !Array.isArray(response.results))
      throw new Error('HubSpot returned an invalid deals response.');
    if (response.total != null && Number(response.total) > maximum)
      throw new Error('HubSpot report exceeds the row limit. Narrow the date range.');
    response.results.forEach(function (record) {
      if (!record || record.id == null || !record.properties)
        throw new Error('HubSpot returned an invalid deal record.');
      if (ids[String(record.id)])
        throw new Error('HubSpot returned duplicate deals while paging. Retry the report.');
      ids[String(record.id)] = true;
      var row = Object.create(null);
      columns.forEach(function (field) {
        var value = field.key === 'id' ? String(record.id) : record.properties[field.key];
        if (value == null || value === '') row[field.key] = '';
        else if ((field.type === 'number' || field.type === 'currency') && isFinite(Number(value)))
          row[field.key] = Number(value);
        else row[field.key] = value;
      });
      rows.push(row);
    });
    if (rows.length > maximum)
      throw new Error('HubSpot report exceeds the row limit. Narrow the date range.');
    var next = response.paging && response.paging.next ? response.paging.next.after : null;
    if (next != null) {
      if (rows.length >= maximum || rows.length >= 10000)
        throw new Error('HubSpot report exceeds the row limit. Narrow the date range.');
      if (cursors[String(next)]) throw new Error('HubSpot returned a repeated pagination cursor.');
      cursors[String(next)] = true;
      body.after = String(next);
    } else if (response.total != null && Number(response.total) !== rows.length) {
      throw new Error('HubSpot results changed during pagination. Retry the report.');
    }
  } while (next != null);
  return {
    columns: columns,
    rows: rows,
    metadata: {
      complete: true,
      rowCount: rows.length,
      dateField: dateField,
      startDate: ctx.startDate,
      endDate: ctx.endDate,
      timezone: 'UTC',
      note: 'Current deal values; dates filter deals, not historical pipeline snapshots.',
    },
  };
}

dmvRegisterConnector_({
  id: 'hubspot',
  label: 'HubSpot',
  description: 'Deals, pipeline stages, amounts, and custom properties.',
  category: 'CRM',
  color: '#ff7a59',
  allowedHosts: ['api.hubapi.com'],
  guide: {
    intro: 'A HubSpot private app token gives read access without an OAuth flow.',
    steps: [
      'HubSpot → Settings → Integrations → Private apps → Create a private app.',
      'Scopes: tick crm.objects.deals.read and crm.schemas.deals.read, then create the app.',
      'Copy the access token shown once; paste it here.',
    ],
    links: [{ label: 'Private apps', url: 'https://developers.hubspot.com/docs/api/private-apps' }],
  },
  authFields: [
    {
      key: 'accessToken',
      label: 'Private-app access token',
      type: 'password',
      required: true,
      help: 'Use a private app with CRM deals read access.',
    },
  ],
  reports: [
    {
      id: 'deals',
      label: 'Deals',
      description:
        'Current deal records filtered by created, updated, or close date in UTC. Stage and owner values are IDs.',
      fields: dmvHubspotFields_(),
      dateRange: true,
      configFields: [
        {
          key: 'dateField',
          label: 'Filter dates by',
          type: 'select',
          default: 'hs_lastmodifieddate',
          options: [
            { value: 'hs_lastmodifieddate', label: 'Updated date' },
            { value: 'createdate', label: 'Created date' },
            { value: 'closedate', label: 'Close date' },
          ],
        },
      ],
      fetch: dmvHubspotFetch_,
      discoverFields: dmvHubspotDiscover_,
    },
  ],
});
