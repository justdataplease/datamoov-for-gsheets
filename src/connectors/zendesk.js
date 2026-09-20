/** Zendesk Support: bounded cursor exports, no per-ticket requests. */
function dmvZendeskFields_() {
  return [
    { key: 'id', label: 'Ticket ID', type: 'text', default: true },
    { key: 'subject', label: 'Subject', type: 'text', default: true },
    { key: 'status', label: 'Status', type: 'text', default: true },
    { key: 'priority', label: 'Priority', type: 'text', default: true },
    { key: 'type', label: 'Type', type: 'text', default: true },
    { key: 'group_id', label: 'Group ID', type: 'text', default: true },
    { key: 'assignee_id', label: 'Assignee ID', type: 'text', default: true },
    { key: 'requester_id', label: 'Requester ID', type: 'text' },
    { key: 'organization_id', label: 'Organization ID', type: 'text' },
    { key: 'created_at', label: 'Created at', type: 'date', default: true },
    { key: 'updated_at', label: 'Updated at', type: 'date', default: true },
    { key: 'tags', label: 'Tags', type: 'text' },
    { key: 'satisfaction_rating', label: 'Satisfaction', type: 'text' },
  ];
}

function dmvZendeskMetricFields_() {
  return [
    { key: 'ticket_id', label: 'Ticket ID', type: 'text', default: true },
    { key: 'replies', label: 'Agent replies', type: 'number', default: true },
    { key: 'reopens', label: 'Reopens', type: 'number', default: true },
    {
      key: 'reply_time_calendar_minutes',
      label: 'First reply (calendar minutes)',
      type: 'number',
      default: true,
    },
    { key: 'reply_time_business_minutes', label: 'First reply (business minutes)', type: 'number' },
    {
      key: 'full_resolution_time_calendar_minutes',
      label: 'Full resolution (calendar minutes)',
      type: 'number',
      default: true,
    },
    {
      key: 'full_resolution_time_business_minutes',
      label: 'Full resolution (business minutes)',
      type: 'number',
    },
    {
      key: 'requester_wait_time_calendar_minutes',
      label: 'Requester wait (calendar minutes)',
      type: 'number',
    },
    { key: 'solved_at', label: 'Solved at', type: 'date', default: true },
    { key: 'updated_at', label: 'Metrics updated at', type: 'date', default: true },
  ];
}

function dmvZendeskConnection_(ctx) {
  var subdomain = String(ctx.credentials.subdomain || '')
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain))
    throw new Error('Enter only your Zendesk subdomain, without a URL.');
  var email = String(ctx.credentials.email || '').trim();
  var token = String(ctx.credentials.apiToken || '').trim();
  if (!email || /[\r\n:]/.test(email) || !token)
    throw new Error('Enter a Zendesk agent email and API token.');
  return {
    base: 'https://' + subdomain + '.zendesk.com',
    headers: { Authorization: 'Basic ' + Utilities.base64Encode(email + '/token:' + token) },
  };
}

function dmvZendeskPages_(ctx, path, collection, maximum) {
  var connection = dmvZendeskConnection_(ctx);
  var initial = connection.base + path,
    url = initial,
    seen = Object.create(null),
    rows = [],
    pages = 0;
  do {
    if (ctx.checkDeadline) ctx.checkDeadline();
    if (++pages > 100 || seen[url])
      throw new Error('Zendesk pagination exceeded the report budget or repeated a page.');
    seen[url] = true;
    var response = ctx.http({ url: url, headers: connection.headers });
    if (!response || !Array.isArray(response[collection]))
      throw new Error('Zendesk returned an invalid report response.');
    Array.prototype.push.apply(rows, response[collection]);
    if (rows.length > maximum)
      throw new Error(
        'Zendesk report exceeds the row limit. Narrow the report or raise the limit.'
      );
    var meta = response.meta;
    if (
      (!meta || typeof meta.has_more !== 'boolean') &&
      !Object.prototype.hasOwnProperty.call(response, 'next_page')
    ) {
      throw new Error(
        'Zendesk did not confirm whether the report has more pages. Retry the report.'
      );
    }
    var next = (response.links && response.links.next) || response.next_page || null;
    if (meta && meta.has_more === false) next = null;
    else if (meta && meta.has_more === true && !next) {
      if (!meta.after_cursor) throw new Error('Zendesk returned an incomplete pagination cursor.');
      next = initial + '&page%5Bafter%5D=' + encodeURIComponent(meta.after_cursor);
    }
    if (next) {
      if (rows.length >= maximum)
        throw new Error(
          'Zendesk report exceeds the row limit. Narrow the report or raise the limit.'
        );
      var endpoint = initial.split('?')[0];
      // Never forward a credential to an origin or endpoint supplied by a response.
      if (typeof next !== 'string' || next.indexOf(endpoint + '?') !== 0 || /[\r\n\\]/.test(next)) {
        throw new Error('Zendesk returned an unexpected pagination URL.');
      }
      url = next;
    } else url = null;
  } while (url);
  return rows;
}

function dmvZendeskDiscover_(ctx) {
  var catalog = dmvZendeskPages_(
    ctx,
    '/api/v2/ticket_fields?page%5Bsize%5D=100',
    'ticket_fields',
    1000
  );
  var fields = dmvZendeskFields_();
  var systemTypes = [
    'subject',
    'description',
    'status',
    'tickettype',
    'priority',
    'group',
    'assignee',
  ];
  catalog.forEach(function (field) {
    if (
      !field ||
      field.active === false ||
      systemTypes.indexOf(field.type) >= 0 ||
      !/^\d+$/.test(String(field.id))
    )
      return;
    fields.push({
      key: 'custom_' + field.id,
      label: String(field.title || 'Custom field ' + field.id),
      type:
        field.type === 'integer' || field.type === 'decimal'
          ? 'number'
          : field.type === 'date'
            ? 'date'
            : 'text',
    });
  });
  return fields;
}

function dmvZendeskFetch_(ctx) {
  // Custom ticket fields only need the discovery call when a selected key is not a standard one.
  var catalog = dmvZendeskFields_();
  if (dmvNeedsDiscovery_(ctx.fields, catalog)) catalog = dmvZendeskDiscover_(ctx);
  var columns = dmvSelectFields_(ctx.fields, catalog);
  var dateField = ctx.config.dateField || 'created';
  if (['created', 'updated'].indexOf(dateField) < 0)
    throw new Error('Choose a valid ticket date filter.');
  var window = dmvUtcWindow_(ctx),
    start = window.start,
    end = window.end;
  var query =
    dateField +
    '>=' +
    new Date(start).toISOString().slice(0, 10) +
    ' ' +
    dateField +
    '<' +
    new Date(end).toISOString().slice(0, 10);
  var records = dmvZendeskPages_(
    ctx,
    '/api/v2/search/export?filter%5Btype%5D=ticket&page%5Bsize%5D=100&query=' +
      encodeURIComponent(query),
    'results',
    Number(ctx.maxRows) || 1000
  );
  var ids = Object.create(null);
  var rows = records.map(function (record) {
    if (!record || record.id == null) throw new Error('Zendesk returned an invalid ticket.');
    if (ids[String(record.id)])
      throw new Error('Zendesk returned duplicate tickets while paging. Retry the report.');
    ids[String(record.id)] = true;
    var custom = Object.create(null);
    (record.custom_fields || []).forEach(function (field) {
      custom['custom_' + field.id] = field.value;
    });
    var row = Object.create(null);
    columns.forEach(function (field) {
      var value = field.key.indexOf('custom_') === 0 ? custom[field.key] : record[field.key];
      if (field.key === 'satisfaction_rating' && value && typeof value === 'object')
        value = value.score;
      if (field.key === 'tags' && Array.isArray(value)) value = value.join(', ');
      if (field.key === 'id' || /_id$/.test(field.key)) value = value == null ? '' : String(value);
      row[field.key] = value == null ? '' : value;
    });
    return row;
  });
  return {
    columns: columns,
    rows: rows,
    metadata: {
      complete: true,
      rowCount: rows.length,
      startDate: ctx.startDate,
      endDate: ctx.endDate,
      dateField: dateField,
      timezone: 'UTC',
      note: 'Current tickets matching dates. Search indexing can lag recent updates; deleted tickets are excluded.',
    },
  };
}

function dmvZendeskMetricsFetch_(ctx) {
  var columns = dmvSelectFields_(ctx.fields, dmvZendeskMetricFields_());
  var records = dmvZendeskPages_(
    ctx,
    '/api/v2/ticket_metrics?page%5Bsize%5D=100',
    'ticket_metrics',
    Number(ctx.maxRows) || 1000
  );
  var ids = Object.create(null);
  var rows = records.map(function (record) {
    if (!record || record.ticket_id == null || ids[String(record.ticket_id)])
      throw new Error('Zendesk returned invalid or duplicate ticket metrics. Retry the report.');
    ids[String(record.ticket_id)] = true;
    var row = Object.create(null);
    columns.forEach(function (field) {
      var match =
        /^(reply_time|full_resolution_time|requester_wait_time)_(calendar|business)_minutes$/.exec(
          field.key
        );
      var value = match ? (record[match[1] + '_in_minutes'] || {})[match[2]] : record[field.key];
      if (field.key === 'ticket_id' && value != null) value = String(value);
      row[field.key] = value == null ? '' : value;
    });
    return row;
  });
  return {
    columns: columns,
    rows: rows,
    metadata: {
      complete: true,
      rowCount: rows.length,
      note: 'Current metrics for non-archived tickets only. This endpoint excludes archived tickets.',
    },
  };
}

dmvRegisterConnector_({
  id: 'zendesk',
  label: 'Zendesk',
  description: 'Support tickets, custom fields, replies, and resolution times.',
  category: 'Support',
  color: '#03363d',
  icon: {
    viewBox: '0 0 250 250',
    shapes: [
      {
        d: 'm137.407 49.592-82.73-23.5-21.568 76.936L8 191.231l82.73 23.177L113.907 132l23.5-82.409Z',
        fill: '#78a300',
      },
      {
        d: 'm160.263 214.408 82.73-23.177-23.499-82.409L137.086 132l23.177 82.408Z',
        fill: '#00363d',
      },
    ],
  },
  allowedHosts: function (credentials) {
    var subdomain = String(credentials.subdomain || '')
      .trim()
      .toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain))
      throw new Error('Enter only your Zendesk subdomain.');
    return [subdomain + '.zendesk.com'];
  },
  guide: {
    intro: 'Zendesk API tokens pair with an agent email address.',
    steps: [
      'Admin Center → Apps and integrations → APIs → Zendesk API → enable Token access.',
      'Add API token → copy it; it is shown only once.',
      'Use the email of an agent who can view tickets and your subdomain (acme from acme.zendesk.com).',
    ],
    links: [
      {
        label: 'API token help',
        url: 'https://support.zendesk.com/hc/en-us/articles/4408889192858',
      },
    ],
  },
  authFields: [
    {
      key: 'subdomain',
      label: 'Zendesk subdomain',
      type: 'text',
      required: true,
      perConnection: true,
      help: 'For example: acme from acme.zendesk.com.',
    },
    { key: 'email', label: 'Agent email', type: 'text', required: true },
    { key: 'apiToken', label: 'API token', type: 'password', required: true },
  ],
  reports: [
    {
      id: 'tickets',
      label: 'Tickets',
      description: 'Tickets created or updated in the selected dates. Dates use UTC.',
      fields: dmvZendeskFields_(),
      dateRange: true,
      configFields: [
        {
          key: 'dateField',
          label: 'Filter dates by',
          type: 'select',
          default: 'created',
          options: [
            { value: 'created', label: 'Created date' },
            { value: 'updated', label: 'Updated date' },
          ],
        },
      ],
      fetch: dmvZendeskFetch_,
      discoverFields: dmvZendeskDiscover_,
    },
    {
      id: 'ticket_metrics',
      label: 'Ticket metrics',
      description:
        'Current replies, reopens, and resolution times for non-archived tickets. Archived tickets are excluded.',
      fields: dmvZendeskMetricFields_(),
      configFields: [],
      dateRange: false,
      fetch: dmvZendeskMetricsFetch_,
    },
  ],
});
