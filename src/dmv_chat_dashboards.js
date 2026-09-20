/* Chat is a client of the saved dashboard runtime; saved plans contain no credentials. */
function dmvChatDashboardTools_(session, baseTools) {
  function schema(name) {
    return JSON.parse(
      JSON.stringify(
        baseTools.filter(function (tool) {
          return tool.name === name;
        })[0].input_schema
      )
    );
  }
  var query = schema('run_report'),
    summary = schema('summarize');
  delete summary.properties.resultId;
  delete summary.properties.filters;
  summary.required = [];
  query.properties.id = {
    type: 'string',
    pattern: '^[a-zA-Z0-9_-]{1,80}$',
    maxLength: 80,
    description: 'A distinct stable local source key using letters, digits, underscores or dashes.',
  };
  query.properties.label = {
    type: 'string',
    description: 'Distinct platform and account label for the combined rows.',
  };
  query.properties.mapping = {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        field: { type: 'string', description: 'Original source column key.' },
        key: {
          type: 'string',
          description:
            'Shared output key, for example date, campaign_id, campaign_name, spend, clicks or impressions.',
        },
      },
      required: ['field', 'key'],
    },
    description: 'Align matching fields from every source. Keep the same shared keys and types.',
  };
  query.required = query.required.concat(['label', 'mapping']);
  var target = {
    type: 'object',
    properties: {
      sheetName: { type: 'string' },
      startCell: { type: 'string', description: 'Default A1.' },
    },
    required: ['sheetName'],
  };
  return [
    {
      name: 'list_dashboards',
      description:
        'List your saved multi-source dashboards in this spreadsheet. Reuse an existing dashboard when the user asks to refresh it.',
      input_schema: { type: 'object', properties: {} },
      run: function (active, input) {
        dmvChatSheetObject_(input || {}, []);
        return { dashboards: dmvListDashboards() };
      },
    },
    {
      name: 'save_dashboard',
      description:
        'Save a repeatable multi-source performance dashboard. Stores source queries, column mappings, dates and aggregation/ranking rules. It appears under Reports > Dashboards with Refresh dashboard. The raw combined data and final report use two distinct tabs. Saving does not fetch or change output; call run_dashboard next. Start with list_dashboards to avoid duplicates; updates need id and revision. Plans stay private to this account. Charts or native pivots can be added to the output separately.',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          revision: { type: 'integer' },
          name: { type: 'string' },
          sources: { type: 'array', items: query, minItems: 2, maxItems: 8 },
          summary: summary,
          dataTarget: target,
          target: target,
        },
        required: ['name', 'sources', 'summary', 'dataTarget', 'target'],
      },
      run: dmvChatSaveDashboard_,
    },
    {
      name: 'run_dashboard',
      description:
        'Refetch every source in a saved dashboard, validate and combine complete results, then rebuild the raw-data and report tabs together. Both previous outputs stay unchanged if a source or destination fails. Reuse this or the Refresh dashboard button on later visits; no cached chat results are needed.',
      input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      run: dmvChatRunDashboard_,
    },
  ];
}

function dmvChatSaveDashboard_(session, input) {
  dmvChatSheetObject_(input, [
    'id',
    'revision',
    'name',
    'sources',
    'summary',
    'dataTarget',
    'target',
  ]);
  dmvChatSheetDeadline_(session);
  var plan = Object.assign({}, input);
  if (input.id && !Number.isInteger(input.revision))
    throw new Error('List dashboards first and use the saved revision when editing a dashboard.');
  if (!Array.isArray(input.sources)) throw new Error('Choose the dashboard sources.');
  var cap = session.maxRows || DMV_LIMITS.chatDefaultRows;
  plan.sources = input.sources.map(function (source, index) {
    var item = Object.assign({}, source);
    item.id = item.id || 'source-' + (index + 1);
    item.maxRows = item.maxRows === undefined ? cap : item.maxRows;
    if (!Number.isInteger(item.maxRows) || item.maxRows < 1 || item.maxRows > cap)
      throw new Error(
        'Each dashboard source must use at most ' +
          cap +
          ' rows. Change Maximum rows per chat report in Settings when needed.'
      );
    return item;
  });
  plan.summary = Object.assign({ limit: DMV_LIMITS.maxRows }, input.summary || {});
  var saved = dmvSaveDashboard(plan);
  session.events.push({
    kind: 'dashboard',
    action: 'saved',
    text:
      'Saved dashboard "' +
      saved.name +
      '" with ' +
      saved.sourceCount +
      ' sources. Refresh it from Reports > Dashboards.',
  });
  return saved;
}

function dmvChatRunDashboard_(session, input) {
  dmvChatSheetObject_(input, ['id']);
  dmvChatSheetDeadline_(session);
  var result;
  try {
    result = dmvRunDashboard(input.id, session.deadline);
  } catch (error) {
    if (error.sheetUpdated)
      session.events.push({
        kind: 'write',
        links: dmvChatDashboardLinks_(error),
        action: 'updated_incomplete',
        text:
          'Updated the data and report tabs, but could not finish saving refresh status. ' +
          error.message,
      });
    throw error;
  }
  session.events.push({
    kind: 'dashboard',
    action: 'refreshed',
    links: dmvChatDashboardLinks_(result),
    text: 'Refreshed every source in the saved dashboard.',
  });
  session.events.push({
    kind: 'write',
    text:
      'Updated ' +
      result.dataRowCount +
      ' combined data rows in ' +
      result.dataTarget.sheetName +
      ' and ' +
      result.rowCount +
      ' report rows in ' +
      result.target.sheetName +
      '.',
  });
  return result;
}

function dmvChatDashboardLinks_(result) {
  return [
    { label: 'Report: ' + result.target.sheetName, url: result.reportUrl },
    { label: 'Data: ' + result.dataTarget.sheetName, url: result.dataUrl },
  ].filter(function (link) {
    return !!link.url;
  });
}
