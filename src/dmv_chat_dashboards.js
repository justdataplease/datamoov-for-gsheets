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
          'kpi: scorecards of its metrics, no groupBy. Charts: groupBy[0] is the axis, an optional second groupBy column (for example source) splits one metric into series. For a share or a breakdown by category (spend by channel) use bar: categories largest first, labelled with their values; pie is drawn as bars too. table: any groupBy and metrics.',
      },
      datasets: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Dataset ids this tile reads. Several ids need a mapping on each dataset. Previous-period datasets belong only to tiles with compare; left out, a compared tile reads its compare lists and any other tile every current-period dataset.',
      },
      groupBy: summary.groupBy,
      dateBucket: summary.dateBucket,
      metrics: summary.metrics,
      ratios: summary.ratios,
      filters: Object.assign({}, summary.filters, {
        description:
          (summary.filters.description ? summary.filters.description + ' ' : '') +
          'Filters apply to dataset rows before grouping, so "without conversions" needs a dataset without a date column, where each row covers the whole period.',
      }),
      orderBy: summary.orderBy,
      limit: {
        type: 'integer',
        description: 'Rows or axis points kept. Defaults: 50 table rows, 15 categories, 400 dates.',
      },
      rankWithin: summary.rankWithin,
      limitPerGroup: summary.limitPerGroup,
      stacked: {
        type: 'boolean',
        description: 'column, bar or area: stack the series, for a share over time.',
      },
      secondaryAxis: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Metric fields or ratio keys drawn on the right axis of a line, area, scatter or column chart (on columns they become lines), for example ["cpc"] beside spend.',
      },
      width: {
        type: 'string',
        enum: ['full'],
        description: 'A chart that takes the whole row, for a long trend.',
      },
      compare: {
        type: 'object',
        properties: {
          current: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            description:
              'Dataset ids of the current period, every account of it, for example ["gads1", "gads2"].',
          },
          previous: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            description:
              'Dataset ids of the previous period, one per current dataset of the same account and report, for example ["gads1_prev", "gads2_prev"].',
          },
        },
        required: ['current', 'previous'],
        description:
          'Change against the previous period, which must end the day before the current one starts (previous30 before last30, previousMonth before lastMonth); both lists are datasets of this tile and each side is added up across its datasets. kpi: each scorecard shows its change. table grouped by names (not dates): a Δ % column after each metric and ratio, rows matched by their groupBy values. line, area or column over one date groupBy column: a dashed previous-period line (lighter column) per value over the same days, aligned by position in the period (first week under first week).',
      },
      highlight: {
        type: 'array',
        maxItems: DMV_DASHBOARD.maxRules,
        items: {
          type: 'object',
          properties: {
            field: {
              type: 'string',
              description:
                'A metric field or ratio key of this tile, or one of its groupBy columns.',
            },
            op: {
              type: 'string',
              enum: ['gt', 'gte', 'lt', 'lte', 'eq', 'ne', 'contains', 'in'],
              description:
                'gt, gte, lt, lte or eq for a metric or ratio; eq, ne, contains or in for a groupBy column.',
            },
            value: {
              anyOf: [{ type: 'number' }, { type: 'string' }],
              description:
                'A number for a metric or ratio (a fixed threshold; a percent ratio or field is a fraction, so 2% is 0.02); text for a groupBy column, matched without regard to case (comma-separated for in).',
            },
            ofTotal: {
              type: 'number',
              description:
                'Metrics and ratios only, instead of value: a multiple of the overall value of this tile, 1.5 means 150% of the overall CPA. The overall value of a summed metric is the table total, so there it is a share below 1: 0.1 flags the rows holding at least a tenth of all conversions.',
            },
            color: { type: 'string', enum: ['red', 'green', 'amber'] },
          },
          required: ['field', 'op', 'color'],
        },
        description:
          'table only, for flag, highlight or alert requests: tint the rows whose value meets a rule (the first rule that matches wins). A metric or ratio takes value or ofTotal, not both; ofTotal keeps a rule meaningful on every refresh, for example {field: "cpa", op: "gt", ofTotal: 1.5, color: "red"}, or top converters {field: "conversions", op: "gte", ofTotal: 0.1, color: "green"}. A groupBy column takes a text value, for example {field: "performance_label", op: "eq", value: "LOW", color: "red"}. Highlights name the rows each rule flags; a rule that flags none appears only in the table legend.',
      },
    },
    required: ['title', 'type'],
  };
  return [
    {
      name: 'list_dashboards',
      description:
        'List your saved dashboards in this spreadsheet. Reuse an existing dashboard when the user asks to refresh or change it.',
      input_schema: { type: 'object', properties: {} },
      run: function (active, input) {
        dmvChatSheetObject_(input || {}, []);
        return {
          dashboards: dmvListDashboards().filter(function (dashboard) {
            return (dmvDashboardHere_(dashboard.id).connectionIds || []).every(function (id) {
              return active.connections.some(function (connection) {
                return connection.id === id;
              });
            });
          }),
        };
      },
    },
    {
      name: 'save_dashboard',
      description:
        'Save a refreshable dashboard: 1 to 8 datasets (each a report query written to its own tab) and up to 12 tiles laid out on the dashboard tab (target): kpi scorecards on top, then native charts, then the tables behind them. At least one tile must be a chart. The runtime fetches, aggregates, writes and charts; it appears under Reports > Dashboards as a draft (or saved outright with a schedule the user asked for), where Refresh dashboard rebuilds every tab and chart without AI. Saving does not fetch; call run_dashboard next. Updates need id and revision from list_dashboards. Plans stay private to this account.',
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
          lowerIsBetter: {
            type: 'array',
            items: { type: 'string' },
            maxItems: DMV_DASHBOARD.maxPolarity,
            description:
              'Metric fields or ratio keys where a rise is bad, such as cpa, cpc and other costs: their changes show red when they rise and their table shading darkens as they fall.',
          },
          neutral: {
            type: 'array',
            items: { type: 'string' },
            maxItems: DMV_DASHBOARD.maxPolarity,
            description:
              'Metric fields or ratio keys whose change is neither good nor bad, such as spend or budget: shown grey. Every other value is good when it rises.',
          },
          schedule: {
            type: 'string',
            enum: ['manual', 'hourly', 'daily', 'weekly'],
            description:
              'Automatic background refresh from the user account, without AI. Default manual; set it only when the user asks for one.',
          },
          at: {
            type: 'object',
            properties: {
              hour: {
                type: 'integer',
                minimum: 0,
                maximum: 23,
                description: 'Hour of the spreadsheet day a daily or weekly refresh runs in.',
              },
              weekday: {
                type: 'integer',
                minimum: 1,
                maximum: 7,
                description: 'Weekly only: 1 Monday to 7 Sunday.',
              },
            },
            description: 'When a daily or weekly schedule runs; default 6:00, Monday.',
          },
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
        'Fetch every dataset of a saved dashboard and rebuild its data tabs, scorecards, charts and tables in one atomic write; earlier output stays unchanged if anything fails. Returns scorecard values with their change, highlights (findings computed from the numbers on the page: the largest scorecard changes, rows flagged by highlight rules, the largest share of a chart, the leader of a ranked table) to quote, the first rows of each chart and table (the latest points of a trend) and tab links. It is all a dashboard request needs: do not also call run_report, write_to_sheet or create_chart for the same data.',
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
    'datasets',
    'tiles',
    'target',
    'schedule',
    'at',
    'lowerIsBetter',
    'neutral',
  ]);
  dmvChatSheetDeadline_(session);
  var plan = Object.assign({}, input);
  if (input.id && !Number.isInteger(input.revision))
    throw new Error('List dashboards first and use the saved revision when editing a dashboard.');
  if (!Array.isArray(input.datasets)) throw new Error('Choose the dashboard datasets.');
  input.datasets.forEach(function (dataset) {
    dmvChatRequireSource_(session, dataset.connectionId);
  });
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
  // Chat saves drafts; only a schedule the user asked for saves outright.
  plan.origin = 'chat';
  plan.draft = !input.schedule || input.schedule === 'manual';
  var saved = dmvSaveDashboard(plan);
  session.events.push({
    kind: 'dashboard',
    action: 'saved',
    record: { id: saved.id, draft: saved.draft === true },
    text:
      (saved.draft ? 'Saved dashboard draft "' : 'Saved dashboard "') +
      saved.name +
      '" with ' +
      saved.datasets.length +
      (saved.datasets.length === 1 ? ' dataset and ' : ' datasets and ') +
      saved.chartCount +
      (saved.chartCount === 1 ? ' chart.' : ' charts.') +
      (saved.draft ? ' Listed under Reports > Drafts.' : ' Refresh it from Reports > Dashboards.'),
    details: dmvChatDetails_([
      ['Dashboard tab', saved.target.sheetName],
      [
        'Datasets',
        saved.datasets.map(function (dataset) {
          return dataset.label + ' → ' + dataset.sheetName;
        }),
      ],
      [
        'Tiles',
        plan.tiles.map(function (tile) {
          return tile && tile.title;
        }),
      ],
    ]),
  });
  return saved;
}

function dmvChatRunDashboard_(session, input) {
  dmvChatSheetObject_(input, ['id']);
  dmvChatSheetDeadline_(session);
  (dmvDashboardHere_(input.id).connectionIds || []).forEach(function (id) {
    dmvChatRequireSource_(session, id);
  });
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
    record: { id: input.id, draft: dmvRead_('dashboard', input.id).draft === true },
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
    details: dmvChatDetails_(
      (result.highlights || [])
        .map(function (text) {
          return ['Highlight', text];
        })
        .concat(
          result.scorecards.map(function (card) {
            return [card.label, card.value];
          })
        )
        .concat(
          result.tiles.map(function (tile) {
            return [
              tile.title,
              tile.type + ' · ' + tile.rows + ' rows' + (tile.note ? ' · ' + tile.note : ''),
            ];
          })
        )
    ),
  });
  dmvChatSeeNewTabs_(session);
  return result;
}
