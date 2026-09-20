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
  icon: {
    viewBox: '0 0 250 250',
    shapes: [
      {
        d: 'M178.194 90.764V65.867a19.172 19.172 0 0 0 11.054-17.281v-.571c0-10.59-8.584-19.173-19.172-19.173h-.572c-10.588 0-19.172 8.584-19.172 19.173v.57a19.166 19.166 0 0 0 11.054 17.282v24.897a54.29 54.29 0 0 0-25.815 11.366L67.29 48.945a21.41 21.41 0 0 0 .77-5.379 21.602 21.602 0 1 0-21.63 21.56 21.368 21.368 0 0 0 10.638-2.895l67.238 52.321c-12.362 18.674-12.031 43.011.833 61.343l-20.451 20.456a17.56 17.56 0 0 0-5.11-.832c-9.794.008-17.728 7.951-17.726 17.745.003 9.793 7.942 17.731 17.735 17.734 9.794.002 17.736-7.932 17.745-17.726a17.495 17.495 0 0 0-.834-5.11l20.231-20.238c18.076 13.915 42.903 15.114 62.237 3.005 19.333-12.11 29.09-34.972 24.457-57.308-4.632-22.338-22.675-39.434-45.229-42.858Zm-8.386 81.884a27.998 27.998 0 0 1-20.276-7.923 27.995 27.995 0 0 1-6.262-30.94 27.985 27.985 0 0 1 26.538-17.094c15.062.527 27.001 12.886 27.01 27.958.006 15.07-11.921 27.442-26.982 27.984',
        fill: '#ff7a59',
      },
    ],
  },
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
