/* Chat is a client of the saved report runtime: a report it saves is validated, stored, run and
   written exactly like one built in the form, and appears under Reports as a draft. */
function dmvChatReportTools_(session, baseTools) {
  var query = JSON.parse(
    JSON.stringify(
      baseTools.filter(function (tool) {
        return tool.name === 'run_report';
      })[0].input_schema
    )
  );
  var properties = Object.assign({}, query.properties, {
    id: { type: 'string', description: 'Only when updating a saved report, from list_reports.' },
    revision: { type: 'integer', description: 'The saved revision, from list_reports.' },
    name: { type: 'string', description: 'A short report name, at most 80 characters.' },
    target: {
      type: 'object',
      properties: {
        sheetName: {
          type: 'string',
          description:
            'The tab that receives the table; a new descriptive name unless the user named one.',
        },
        startCell: { type: 'string', description: 'Top-left cell, default A1.' },
      },
      required: ['sheetName'],
    },
    schedule: {
      type: 'string',
      enum: ['manual', 'hourly', 'daily', 'weekly'],
      description:
        'Automatic background refresh from the user account, without AI. Set it only when the user asks for one; it saves the report outright instead of as a draft.',
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
  });
  return [
    {
      name: 'list_reports',
      description:
        'List your saved reports in this spreadsheet (drafts included). Reuse an existing report when the user asks to change or refresh it.',
      input_schema: { type: 'object', properties: {} },
      run: function (active, input) {
        dmvChatSheetObject_(input || {}, []);
        return {
          reports: dmvListReports()
            .filter(function (report) {
              return active.connections.some(function (connection) {
                return connection.id === report.connectionId;
              });
            })
            .map(function (report) {
              return {
                id: report.id,
                revision: report.revision,
                name: report.name,
                draft: report.draft === true,
                connectionId: report.connectionId,
                reportType: report.reportType,
                fields: report.fields,
                dateRange: report.dateRange,
                target: report.target,
                schedule: report.schedule,
                lastRun: report.lastRun || null,
                lastRowCount: report.lastRowCount === undefined ? null : report.lastRowCount,
              };
            }),
        };
      },
    },
    {
      name: 'save_report',
      description:
        'Save one report query (a connection, report, fields and dates written to its own tab) as a refreshable report and run it once. It appears under Reports as a draft the user can save, refresh or remove; a schedule saves it outright. Use it when the user asks to create, keep or refresh a report; a plain request for data in a tab uses run_report and write_to_sheet instead. Updates need id and revision from list_reports.',
      input_schema: {
        type: 'object',
        properties: properties,
        required: ['name', 'target'].concat(query.required),
      },
      run: dmvChatSaveReport_,
    },
  ];
}

function dmvChatSaveReport_(session, input) {
  dmvChatRequireSource_(session, (input || {}).connectionId);
  dmvChatSheetObject_(input, [
    'id',
    'revision',
    'name',
    'connectionId',
    'reportType',
    'fields',
    'config',
    'dateRange',
    'maxRows',
    'target',
    'schedule',
    'at',
  ]);
  dmvChatSheetDeadline_(session);
  if (input.id) {
    var current = dmvReportHere_(input.id);
    if (!Number.isInteger(input.revision) || input.revision !== current.revision)
      throw new Error('List reports first and use the saved revision when editing a report.');
  }
  var cap = Math.min(session.maxRows || DMV_LIMITS.chatDefaultRows, DMV_LIMITS.reportRows);
  var report = Object.assign({}, input, {
    maxRows: input.maxRows === undefined ? cap : input.maxRows,
    origin: 'chat',
    draft: !input.schedule || input.schedule === 'manual',
  });
  delete report.revision;
  if (!Number.isInteger(report.maxRows) || report.maxRows < 1 || report.maxRows > cap)
    throw new Error(
      'A chat report must use at most ' +
        cap +
        ' rows.' +
        (cap < DMV_LIMITS.reportRows
          ? ' Change Maximum rows per chat report in Settings when needed.'
          : ' A saved report is written in one Sheets request; a dashboard holds more rows.')
    );
  var saved;
  try {
    saved = dmvSaveReport(report);
  } catch (error) {
    throw new Error(error.message + ' ' + dmvChatReportHint_(session, input));
  }
  var result = dmvExecuteReport_(saved, session.deadline);
  var url = dmvSheetLink_(dmvChatSeeNewTabs_(session), saved.target);
  session.events.push({
    kind: 'saved_report',
    action: result.pending ? 'saved' : 'refreshed',
    record: { id: saved.id, draft: saved.draft === true },
    links: url ? [{ label: saved.target.sheetName, url: url }] : [],
    text:
      (saved.draft ? 'Saved report draft "' : 'Saved report "') +
      saved.name +
      '"' +
      (result.pending
        ? '; its first refresh is paused and resumes from Reports.'
        : ' and wrote ' +
          Number(result.rowCount || 0).toLocaleString() +
          ' rows to ' +
          saved.target.sheetName +
          '.'),
    details: dmvChatDetails_([
      ['Tab', saved.target.sheetName + ' · ' + saved.target.startCell],
      ['Fields', saved.fields],
      ['Dates', saved.dateRange.preset],
      ['Refresh', saved.schedule],
      ['Listed under', saved.draft ? 'Reports > Drafts' : 'Reports > Saved'],
    ]),
  });
  return {
    id: saved.id,
    revision: saved.revision,
    name: saved.name,
    draft: saved.draft === true,
    target: saved.target,
    schedule: saved.schedule,
    rowCount: result.pending ? null : result.rowCount,
    pending: result.pending === true,
    warning: result.warning || null,
    url: url,
    note: saved.draft
      ? 'Listed under Reports > Drafts. The sidebar tells the user how to save or remove it; do not repeat those steps.'
      : 'Listed under Reports > Saved with its schedule.',
  };
}
