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
  var dataset = schema('run_report'),
    summary = schema('summarize').properties;
  dataset.properties.id = {
    type: 'string',
    pattern: '^[a-zA-Z0-9_-]{1,40}$',
    maxLength: 40,
    description:
      'Short stable key that tiles use to name this dataset, for example gads_campaigns.',
  };
  dataset.properties.label = {
    type: 'string',
    description: 'Distinct platform, account and subject, for example "Google Ads 1 campaigns".',
  };
  dataset.properties.sheetName = {
    type: 'string',
    description: 'The tab that receives this dataset, for example "Google Ads 1 Data".',
  };
  dataset.properties.mapping = {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        field: { type: 'string', description: 'Original dataset column key.' },
        key: {
          type: 'string',
          description:
            'Shared name, for example date, campaign_name, spend, clicks, impressions, conversions or currency.',
        },
      },
      required: ['field', 'key'],
    },
    description:
      'Only for datasets that a tile reads together with another dataset: give matching columns the same key and type in each of them. Such tiles then use these keys, plus source (the dataset label) and currency.',
  };
  dataset.required = dataset.required.concat(['id', 'label', 'sheetName']);
  var tile = {
    type: 'object',
    properties: {
      title: { type: 'string' },
      type: {
        type: 'string',
        enum: ['kpi', 'table'].concat(DMV_DASHBOARD.chartTypes),
        description:
          'kpi: scorecards of its metrics, no groupBy. Charts: groupBy[0] is the axis, an optional second groupBy column (for example source) splits one metric into series. table: any groupBy and metrics.',
      },
      datasets: {
        type: 'array',
        items: { type: 'string' },
        description: 'Dataset ids this tile reads. Several ids need a mapping on each dataset.',
      },
      groupBy: summary.groupBy,
      dateBucket: summary.dateBucket,
      metrics: summary.metrics,
      orderBy: summary.orderBy,
      limit: {
        type: 'integer',
        description: 'Rows or axis points kept. Defaults: 50 table rows, 15 categories, 400 dates.',
      },
      rankWithin: summary.rankWithin,
      limitPerGroup: summary.limitPerGroup,
    },
    required: ['title', 'type', 'metrics'],
  };
  return [
    {
      name: 'list_dashboards',
      description:
        'List your saved dashboards in this spreadsheet. Reuse an existing dashboard when the user asks to refresh or change it.',
      input_schema: { type: 'object', properties: {} },
      run: function (active, input) {
        dmvChatSheetObject_(input || {}, []);
        return { dashboards: dmvListDashboards() };
      },
    },
    {
      name: 'save_dashboard',
      description:
        'Save a refreshable dashboard: 1 to 6 datasets (each a report query written to its own tab) and up to 12 tiles laid out on the dashboard tab (target): kpi scorecards on top, then native charts, then the tables behind them. At least one tile must be a chart. The runtime fetches, aggregates, writes and charts; it appears under Reports > Dashboards, where Refresh dashboard rebuilds every tab and chart without AI. Saving does not fetch; call run_dashboard next. Updates need id and revision from list_dashboards. Plans stay private to this account.',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          revision: { type: 'integer' },
          name: { type: 'string' },
          datasets: {
            type: 'array',
            items: dataset,
            minItems: 1,
            maxItems: DMV_DASHBOARD.maxDatasets,
          },
          tiles: { type: 'array', items: tile, minItems: 1, maxItems: DMV_DASHBOARD.maxTiles },
          target: {
            type: 'object',
            properties: {
              sheetName: {
                type: 'string',
                description: 'The dashboard tab, "<subject> Dashboard".',
              },
            },
            required: ['sheetName'],
          },
        },
        required: ['name', 'datasets', 'tiles', 'target'],
      },
      run: dmvChatSaveDashboard_,
    },
    {
      name: 'run_dashboard',
      description:
        'Fetch every dataset of a saved dashboard and rebuild its data tabs, scorecards, charts and tables in one atomic write; earlier output stays unchanged if anything fails. Returns scorecard values, tile row counts and tab links. It is all a dashboard request needs: do not also call run_report, write_to_sheet or create_chart for the same data.',
      input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      run: dmvChatRunDashboard_,
    },
  ];
}

function dmvChatSaveDashboard_(session, input) {
  dmvChatSheetObject_(input, ['id', 'revision', 'name', 'datasets', 'tiles', 'target']);
  dmvChatSheetDeadline_(session);
  var plan = Object.assign({}, input);
  if (input.id && !Number.isInteger(input.revision))
    throw new Error('List dashboards first and use the saved revision when editing a dashboard.');
  if (!Array.isArray(input.datasets)) throw new Error('Choose the dashboard datasets.');
  var cap = session.maxRows || DMV_LIMITS.chatDefaultRows;
  plan.datasets = input.datasets.map(function (dataset) {
    var item = Object.assign({}, dataset);
    item.maxRows = item.maxRows === undefined ? cap : item.maxRows;
    if (!Number.isInteger(item.maxRows) || item.maxRows < 1 || item.maxRows > cap)
      throw new Error(
        'Each dashboard dataset must use at most ' +
          cap +
          ' rows. Change Maximum rows per chat report in Settings when needed.'
      );
    return item;
  });
  var saved = dmvSaveDashboard(plan);
  session.events.push({
    kind: 'dashboard',
    action: 'saved',
    text:
      'Saved dashboard "' +
      saved.name +
      '" with ' +
      saved.datasets.length +
      (saved.datasets.length === 1 ? ' dataset and ' : ' datasets and ') +
      saved.chartCount +
      (saved.chartCount === 1 ? ' chart.' : ' charts.') +
      ' Refresh it from Reports > Dashboards.',
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
        links: error.links || [],
        action: 'updated_incomplete',
        text:
          'Updated the dashboard tabs, but could not finish saving refresh status. ' +
          error.message,
      });
    throw error;
  }
  result.datasets.forEach(function (dataset) {
    session.events.push({
      kind: 'report',
      text:
        'Fetched ' +
        dataset.label +
        ' · ' +
        Number(dataset.rowCount).toLocaleString() +
        ' rows into ' +
        dataset.sheetName,
    });
  });
  session.events.push({
    kind: 'dashboard',
    action: 'refreshed',
    links: result.links,
    text:
      'Built "' +
      result.name +
      '" on ' +
      result.target.sheetName +
      ': ' +
      result.chartCount +
      (result.chartCount === 1 ? ' chart, ' : ' charts, ') +
      result.scorecards.length +
      (result.scorecards.length === 1 ? ' scorecard.' : ' scorecards.'),
  });
  dmvChatSeeNewTabs_(session);
  return result;
}
