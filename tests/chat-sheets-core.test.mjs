import test from 'node:test';
import assert from 'node:assert/strict';
import { plain } from './helpers/datamoov-sandbox.mjs';
import { chatSheetFixture } from './helpers/chat-sheet-fixture.mjs';

// The shared core of the analyst sheet tools: protected DataMoov output, undo of chat edits,
// server-side confirmation, and how the analyst actions and tools extend the sheet tools.
// The sandbox answers spreadsheets.get like the Sheets API (gridData), so inspections, undo
// snapshots and read-backs see real cell data.

const BOLD = { textFormat: { bold: true } };
const LIST = {
  condition: {
    type: 'ONE_OF_LIST',
    values: [{ userEnteredValue: 'a' }, { userEnteredValue: 'b' }],
  },
  showCustomUi: true,
};

function fixture() {
  const f = chatSheetFixture({
    tabTitles: true,
    sortRange: true,
    orchard: {
      rows: [
        { date: '2026-08-01', campaign: 'Brand', spend: 10.5, clicks: 100 },
        { date: '2026-08-02', campaign: 'Generic', spend: 5, clicks: 20 },
      ],
      token: 'core-private-token',
    },
  });
  f.report = () => f.saveReport().report;
  return f;
}

function seed(f) {
  f.setCell(f.sheet, 1, 1, 'old');
  f.sheet.formats.set('1:1', BOLD);
  f.setMeta(f.sheet, 1, 1, { note: 'first note' });
  f.setCell(f.sheet, 1, 2, 5);
  f.setMeta(f.sheet, 1, 2, { dataValidation: LIST });
  f.setCell(f.sheet, 2, 1, 2, '=1+1');
  f.sheet.formats.set('2:2', { backgroundColorStyle: { rgbColor: { red: 1 } } });
}

test('the guard refuses value and order changes over saved report output, naming the report', () => {
  const f = fixture();
  const report = f.report();
  const before = f.state.batches.length;
  const refusal =
    /^Error: This change would touch the output of the saved report "Daily" on tab "Output"\. DataMoov rewrites that output on every refresh, so change the report instead/;
  assert.throws(() => f.edit('set_values', { values: [['x']] }, f.inspect('B2')), refusal);
  assert.throws(() => f.edit('set_formulas', { formulas: [['=1']] }, f.inspect('D3')), refusal);
  assert.throws(
    () => f.edit('sort', { sortBy: [{ column: 1, ascending: false }] }, f.inspect('A1:D3')),
    refusal
  );
  // A range that only partly overlaps is refused too.
  assert.throws(() => f.edit('set_values', { values: [['x', 'y']] }, f.inspect('D3:E3')), refusal);
  assert.equal(f.state.batches.length, before, 'nothing written');
  // Formatting, beside the output and on it, stays allowed as before; so do cells beside it.
  assert.equal(f.edit('format', { format: { bold: true } }, f.inspect('A1:D1')).ok, true);
  assert.equal(f.edit('set_values', { values: [['note']] }, f.inspect('F1')).ok, true);
  assert.equal(f.edit('set_values', { values: [['below']] }, f.inspect('A4')).ok, true);
  // And the report still refreshes over its untouched output.
  assert.equal(f.api.dmvRunReport(report.id).ok, true);
  assert.equal(f.value(f.sheet, 1, 6), 'note');
});

test('the guard protects dashboard data ranges and whole dashboard tabs, but not chat tables', () => {
  const f = fixture();
  const saved = plain(
    f.api.dmvSaveDashboard({
      name: 'Overview',
      target: { sheetName: 'Dash' },
      datasets: [
        {
          id: 'main',
          label: 'Main',
          sheetName: 'Main data',
          connectionId: f.connection.id,
          reportType: 'daily',
          fields: ['date', 'campaign', 'spend', 'clicks'],
          config: {},
          dateRange: { preset: 'lastMonth' },
          maxRows: 100,
        },
      ],
      tiles: [
        { title: 'Totals', type: 'kpi', metrics: [{ field: 'spend', agg: 'sum' }] },
        {
          title: 'Spend by campaign',
          type: 'column',
          groupBy: ['campaign'],
          metrics: [{ field: 'spend', agg: 'sum' }],
        },
      ],
    })
  );
  f.api.dmvRunDashboard(saved.id);
  const page = f.tab('Dash');
  const refusal = (tab) =>
    new RegExp(
      `^Error: This change would touch the output of the dashboard "Overview" on tab "${tab}"\\..*change the dashboard instead`
    );
  assert.throws(
    () => f.edit('set_values', { values: [['x']] }, f.inspect('B2', 'Main data')),
    refusal('Main data')
  );
  // Every cell of the page tab belongs to the dashboard, even far below its content.
  assert.ok(page.maxRows >= 90);
  assert.throws(
    () => f.edit('set_values', { values: [['x']] }, f.inspect('Z90', 'Dash')),
    refusal('Dash')
  );
  assert.throws(
    () => f.edit('set_values', { values: [['x']] }, f.inspect('Z90', 'Dash (chart data)')),
    refusal('Dash \\(chart data\\)')
  );
  assert.equal(
    f.edit('set_values', { values: [['beside']] }, f.inspect('H1', 'Main data')).ok,
    true
  );
  // A chat table is the user's to edit; a changed one only stops a rewrite at the same cell.
  const ran = plain(
    f.api.dmvChatRunReport_(f.session, { connectionId: f.connection.id, reportType: 'daily' })
  );
  f.api.dmvChatWriteSheet_(f.session, { resultId: ran.resultId, sheetName: 'Spend' });
  assert.equal(f.edit('set_values', { values: [['Edited']] }, f.inspect('A1', 'Spend')).ok, true);
  assert.equal(f.value(f.tab('Spend'), 1, 1), 'Edited');
});

test('the guard takes open ranges: a whole tab, or every row or column from an index', () => {
  const f = fixture();
  f.report();
  const other = f.book.insertSheet('Other');
  const guard = (ranges) => f.api.dmvChatSheetGuard_(f.session, ranges);
  const id = f.sheet.id;
  assert.throws(() => guard([{ sheetId: id }]), /saved report "Daily"/);
  // Rows 1-3 are the output (indexes 0-2): an insert at index 2 moves it, one at index 3 does not.
  assert.throws(() => guard([{ sheetId: id, startRowIndex: 2 }]), /saved report/);
  assert.doesNotThrow(() => guard([{ sheetId: id, startRowIndex: 3 }]));
  assert.throws(() => guard([{ sheetId: id, startColumnIndex: 3 }]), /saved report/);
  assert.doesNotThrow(() => guard([{ sheetId: id, startColumnIndex: 4 }]));
  assert.doesNotThrow(() => guard([{ sheetId: other.id }]));
  assert.doesNotThrow(() =>
    guard([
      { sheetId: id, startRowIndex: 0, endRowIndex: 3, startColumnIndex: 4, endColumnIndex: 9 },
    ])
  );
});

test('undo restores values, formulas, formats, notes and validation exactly, once', () => {
  const f = fixture();
  seed(f);
  const before = f.cellState(f.sheet, 1, 1, 2, 2);
  const edited = f.edit('set_values', {
    values: [
      ['new', 'x'],
      [3, ''],
    ],
  });
  assert.match(edited.undoId, /^u[a-f0-9]{12}$/);
  assert.equal(f.state.batches.length, 1);
  assert.equal(f.value(f.sheet, 2, 1), 3);
  assert.equal(f.formula(f.sheet, 2, 1), '');
  const listed = f.undo({ action: 'list' });
  assert.deepEqual(
    listed.entries.map((entry) => [entry.id, entry.action, entry.sheetName, entry.range]),
    [[edited.undoId, 'set_values', 'Output', 'A1:B2']]
  );
  const undone = f.undo({ action: 'undo' });
  assert.equal(undone.ok, true);
  assert.equal(undone.undone, edited.undoId);
  assert.equal(undone.range, 'A1:B2');
  assert.equal(f.state.batches.length, 2, 'one batch for the undo');
  const request = f.state.batches[1].body.requests[0].updateCells;
  assert.equal(
    request.fields,
    'userEnteredValue,userEnteredFormat,note,dataValidation,textFormatRuns'
  );
  assert.deepEqual(f.cellState(f.sheet, 1, 1, 2, 2), before);
  assert.equal(f.formula(f.sheet, 2, 1), '=1+1', 'formulas come back as formulas');
  assert.deepEqual(plain(f.session.events.at(-1)).kind, 'write');
  assert.match(f.session.events.at(-1).text, /^Undid: set_values Output!A1:B2/);
  assert.deepEqual(f.undo({ action: 'list' }).entries, []);
  assert.throws(() => f.undo({ action: 'undo' }), /no recent chat edit to undo/);
  assert.throws(() => f.undo({ action: 'undo', id: edited.undoId }), /no recent chat edit/);
});

test('undo covers formatting and sorting, and refuses once the cells changed since', () => {
  const f = fixture();
  seed(f);
  const before = f.cellState(f.sheet, 1, 1, 2, 2);
  f.edit('format', { format: { backgroundColor: '#FF0000', numberFormat: 'percent' } });
  assert.notDeepEqual(f.cellState(f.sheet, 1, 1, 2, 2), before);
  f.undo({ action: 'undo' });
  assert.deepEqual(f.cellState(f.sheet, 1, 1, 2, 2), before);

  [3, 1, 2].forEach((value, r) => f.setCell(f.sheet, r + 5, 1, value));
  const sorted = f.cellState(f.sheet, 5, 1, 3, 1);
  f.edit('sort', { sortBy: [{ column: 1, ascending: true }], headerRows: 0 }, f.inspect('A5:A7'));
  assert.deepEqual(
    [5, 6, 7].map((row) => f.value(f.sheet, row, 1)),
    [1, 2, 3]
  );
  f.undo({ action: 'undo' });
  assert.deepEqual(f.cellState(f.sheet, 5, 1, 3, 1), sorted);

  const edited = f.edit('set_values', { values: [['y']] }, f.inspect('C1'));
  f.setCell(f.sheet, 1, 3, 'typed by hand');
  let batches = f.state.batches.length;
  assert.throws(
    () => f.undo({ action: 'undo', id: edited.undoId }),
    /^Error: The cells in Output!C1 changed since that edit, so it cannot be undone here\. Sheets version history can restore it\.$/
  );
  // A changed format counts as a change too.
  const second = f.edit('set_values', { values: [['z']] }, f.inspect('D1'));
  batches = f.state.batches.length;
  f.sheet.formats.set('1:4', BOLD);
  assert.throws(() => f.undo({ action: 'undo', id: second.undoId }), /Output!D1 changed/);
  assert.equal(f.state.batches.length, batches);
  assert.equal(f.value(f.sheet, 1, 3), 'typed by hand');
  // A refused undo keeps the entry; restoring the cells makes it undoable again.
  f.sheet.formats.delete('1:4');
  assert.equal(f.undo({ action: 'undo', id: second.undoId }).ok, true);
  assert.equal(f.value(f.sheet, 1, 4), '');
});

test('undo keeps the last ten edits for six hours, newest first, and undoes an older one by id', () => {
  const f = fixture();
  const ids = [];
  for (let row = 1; row <= 11; row++) {
    ids.push(f.edit('set_values', { values: [[row]] }, f.inspect('A' + row)).undoId);
    f.advance(1000);
  }
  const listed = f.undo({ action: 'list' });
  assert.deepEqual(
    listed.entries.map((entry) => entry.id),
    ids.slice(1).reverse()
  );
  assert.match(listed.note, /last 10 chat edits for 6 hours/);
  // The dropped entry's cells are gone from the cache.
  const prefix = [...f.state.cache.data.keys()].find(
    (key) => key.startsWith('dmv:sheet-undo:') && !key.includes(':u')
  );
  assert.ok(prefix);
  assert.ok(![...f.state.cache.data.keys()].some((key) => key.includes(ids[0])));
  assert.ok([...f.state.cache.data.keys()].some((key) => key.includes(ids[1])));
  // The cache holds packed snapshots, never raw cell text.
  assert.ok(![...f.state.cache.data.values()].some((value) => value.includes('stringValue')));
  // An older edit whose cells are unchanged can be undone by id.
  assert.equal(f.undo({ action: 'undo', id: ids[3] }).ok, true);
  assert.equal(f.value(f.sheet, 4, 1), '');
  assert.equal(f.value(f.sheet, 5, 1), 5);
  assert.equal(f.undo({ action: 'list' }).entries.length, 9);
  assert.throws(() => f.undo({ action: 'undo', id: 'bad' }), /exactly as list returns it/);
  assert.throws(
    () => f.undo({ action: 'undo', id: 'u000000000000' }),
    /No recent edit has that id/
  );
  assert.throws(() => f.undo({ action: 'redo' }), /Choose list or undo/);
  assert.throws(() => f.undo({ action: 'list', extra: 1 }), /documented fields/);
  f.advance(6 * 3600 * 1000);
  f.session = f.api.dmvChatSession_(f.book);
  assert.deepEqual(f.undo({ action: 'list' }).entries, []);
  assert.throws(() => f.undo({ action: 'undo' }), /keeps the last 10 chat edits for 6 hours/);
});

test('an edit stands without an undo entry when the read-back fails or the cache refuses it', () => {
  const f = fixture();
  const inspected = f.inspect('A1');
  const get = f.api.Sheets.Spreadsheets.get;
  let calls = 0;
  f.api.Sheets.Spreadsheets.get = (id, options) => {
    if (options?.includeGridData && ++calls === 2) throw new Error('read failed');
    return get(id, options);
  };
  const result = f.edit('set_values', { values: [['kept']] }, inspected);
  assert.equal(result.ok, true);
  assert.equal(result.undoId, undefined);
  assert.equal(f.value(f.sheet, 1, 1), 'kept');
  f.api.Sheets.Spreadsheets.get = get;
  f.state.cache.putAll = () => {
    throw new Error('cache full');
  };
  const second = f.edit('set_values', { values: [['also kept']] }, f.inspect('B1'));
  assert.equal(second.ok, true);
  assert.equal(second.undoId, undefined);
  assert.equal(f.value(f.sheet, 1, 2), 'also kept');
});

test('replacing more than 200 non-empty cells needs the user to confirm in the next request', () => {
  const f = fixture();
  for (let row = 1; row <= 21; row++)
    for (let column = 1; column <= 10; column++) f.setCell(f.sheet, row, column, row * column);
  const values = Array.from({ length: 21 }, () => Array.from({ length: 10 }, () => 'x'));
  const inspected = f.inspect('A1:J21');
  const asked = f.edit('set_values', { values }, inspected);
  assert.equal(asked.needsConfirmation, true);
  assert.match(asked.confirmToken, /^c[a-f0-9]{32}$/);
  assert.match(asked.summary, /^This replaces 210 non-empty cells in Output!A1:J21\.$/);
  assert.match(asked.next, /ask_user/);
  assert.equal(f.state.batches.length, 0, 'nothing changed yet');
  assert.ok(f.state.cache.get('dmv:sheet-edit:' + inspected.editToken), 'the inspection stays');
  assert.deepEqual(plain(f.session.events.at(-1)), {
    kind: 'summary',
    text: 'Asked to confirm: ' + asked.summary,
    ref: 'confirmToken ' + asked.confirmToken,
  });
  // The model cannot approve its own question in the same request.
  assert.throws(
    () => f.edit('set_values', { values, confirmToken: asked.confirmToken }, inspected),
    /not approved by the user in this request/
  );
  assert.throws(
    () => f.edit('set_values', { values, confirmToken: 'yes' }, inspected),
    /exactly as it was returned/
  );
  // A no drops it.
  const no = f.answer('No, leave it');
  assert.throws(
    () => f.edit('set_values', { values, confirmToken: asked.confirmToken }, inspected, no),
    /not approved/
  );
  assert.equal(f.state.batches.length, 0);
  // Asked again, then a yes: the token works for this exact input once.
  const again = f.edit('set_values', { values }, inspected);
  const yes = f.answer('Yes, go ahead');
  const other = values.map((row) => row.map(() => 'y'));
  assert.throws(
    () => f.edit('set_values', { values: other, confirmToken: again.confirmToken }, inspected, yes),
    /given for a different change/
  );
  const done = f.edit('set_values', { values, confirmToken: again.confirmToken }, inspected, yes);
  assert.equal(done.ok, true);
  assert.equal(f.state.batches.length, 1);
  assert.equal(f.value(f.sheet, 21, 10), 'x');
  const fresh = f.inspect('A1:J21', 'Output', yes);
  assert.throws(
    () => f.edit('set_values', { values, confirmToken: again.confirmToken }, fresh, yes),
    /already used/
  );
  // The undo entry restores all 210 cells.
  f.undo({ action: 'undo' });
  assert.equal(f.value(f.sheet, 21, 10), 210);
});

test('confirmations expire, follow the sidebar token, match by input and survive a fresh inspection', () => {
  const f = fixture();
  for (let row = 1; row <= 21; row++)
    for (let column = 1; column <= 10; column++) f.setCell(f.sheet, row, column, 1);
  const values = Array.from({ length: 21 }, () => Array.from({ length: 10 }, () => 2));
  const asked = f.edit('set_values', { values }, f.inspect('A1:J21'));
  f.advance(1801 * 1000);
  f.session = f.api.dmvChatSession_(f.book);
  const late = f.answer('yes');
  assert.throws(
    () =>
      f.edit(
        'set_values',
        { values, confirmToken: asked.confirmToken },
        f.inspect('A1:J21', 'Output', late),
        late
      ),
    /not approved/
  );
  // Two questions; the sidebar sends the token of the one the user approved.
  const first = f.edit('set_values', { values }, f.inspect('A1:J21'));
  const flipped = values.map((row) => row.map(() => 3));
  const second = f.edit('set_values', { values: flipped }, f.inspect('A1:J21'));
  const chip = f.answer('Yes', second.confirmToken);
  assert.throws(
    () =>
      f.edit(
        'set_values',
        { values, confirmToken: first.confirmToken },
        f.inspect('A1:J21', 'Output', chip),
        chip
      ),
    /not approved/
  );
  // The approved input acts without the token too, and only once; the edit token may be new.
  const acted = f.edit(
    'set_values',
    { values: flipped },
    f.inspect('A1:J21', 'Output', chip),
    chip
  );
  assert.equal(acted.ok, true);
  assert.equal(f.value(f.sheet, 1, 1), 3);
  const repeat = f.edit(
    'set_values',
    { values: flipped },
    f.inspect('A1:J21', 'Output', chip),
    chip
  );
  assert.equal(repeat.needsConfirmation, true);
  // A request that offered nothing approves nothing; a plain question is no yes.
  for (const text of ['yesterday please', 'what would that change?']) {
    const session = f.answer(text);
    assert.deepEqual(plain(session.confirm.approved), [], text);
  }
});

test('a chat turn asks, the next turn answers yes and the edit happens once', () => {
  const f = fixture();
  f.api.dmvSaveAiSettings({ provider: 'anthropic', apiKey: 'sk-ant-offline-core-0001' });
  for (let row = 1; row <= 21; row++)
    for (let column = 1; column <= 10; column++) f.setCell(f.sheet, row, column, row);
  const values = Array.from({ length: 21 }, () => Array.from({ length: 10 }, () => ''));
  const anthropic = (blocks, stop = 'tool_use') => ({
    body: { content: blocks, stop_reason: stop },
  });
  const call = (id, name, input) => ({ type: 'tool_use', id, name, input });
  const seen = {};
  const fetch = f.api.UrlFetchApp.fetch;
  f.api.UrlFetchApp.fetch = (url, options) => {
    const body = JSON.parse(options.payload);
    for (const message of body.messages)
      for (const block of Array.isArray(message.content) ? message.content : [])
        if (block.type === 'tool_result') Object.assign(seen, JSON.parse(block.content));
    for (const block of f.state.responses[0]?.body?.content || [])
      if (block.type === 'tool_use') {
        if (block.input.editToken === 'EDIT') block.input.editToken = seen.editToken;
        if (block.input.confirmToken === 'CONFIRM') block.input.confirmToken = seen.confirmToken;
      }
    return fetch(url, options);
  };
  const edit = (extra) =>
    call('e', 'edit_sheet', {
      action: 'set_values',
      sheetName: 'Output',
      range: 'A1:J21',
      editToken: 'EDIT',
      values,
      ...extra,
    });
  f.state.responses.push(
    anthropic([call('i', 'inspect_sheet', { sheetName: 'Output', range: 'A1:J21' })]),
    anthropic([edit()]),
    // The model tries its own token before asking: refused.
    anthropic([edit({ confirmToken: 'CONFIRM' })]),
    anthropic([
      call('q', 'ask_user', { question: 'Clear 210 cells in Output?', options: ['Yes', 'No'] }),
    ])
  );
  const first = plain(f.api.dmvChat({ text: 'Clear A1:J21', transcript: [] }));
  assert.equal(first.text, 'Clear 210 cells in Output?');
  assert.deepEqual(first.options, ['Yes', 'No']);
  assert.equal(f.state.batches.length, 0);
  assert.ok(
    first.transcriptAppend[1].actions.some((action) =>
      action.includes('[confirmToken ' + seen.confirmToken + ']')
    )
  );
  f.state.responses.push(
    anthropic([edit({ confirmToken: 'CONFIRM' })]),
    anthropic([edit({ confirmToken: 'CONFIRM' })]),
    anthropic([{ type: 'text', text: 'Cleared.' }], 'end_turn')
  );
  const second = plain(f.api.dmvChat({ text: 'Yes', transcript: first.transcriptAppend }));
  assert.equal(second.text, 'Cleared.');
  assert.equal(f.state.batches.length, 1, 'the edit happened once; the replay was refused');
  assert.equal(f.value(f.sheet, 1, 1), '');
  assert.deepEqual(
    second.events.map((event) => event.kind),
    ['write', 'error']
  );
  assert.match(second.events[1].text, /already used|inspection expired/);
});

test('without the analyst actions and tools, the existing tools and schemas are as they were', () => {
  const f = fixture();
  // The analyst sheet files add actions and tools; without them, edit_sheet and the tools are
  // exactly as before.
  f.api.dmvChatSheetActions_ = () => ({});
  f.api.dmvChatSheetActionSchema_ = () => ({ actions: [], properties: {} });
  for (const part of ['ConditionTools', 'FormulaTools'])
    f.api['dmvChatSheet' + part + '_'] = () => [];
  assert.deepEqual(plain(f.api.dmvChatSheetExtraTools_()), []);
  const tools = f.api.dmvChatTools_(f.session);
  const names = tools.map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length, 'tool names are unique');
  assert.deepEqual(
    plain(names.slice(names.indexOf('list_sheets'), names.indexOf('create_pivot') + 1)),
    ['list_sheets', 'inspect_sheet', 'edit_sheet', 'undo_sheet_edit', 'create_pivot']
  );
  const edit = plain(tools.find((tool) => tool.name === 'edit_sheet').input_schema);
  assert.deepEqual(edit.properties.action.enum, [
    'set_values',
    'set_formulas',
    'format',
    'sort',
    'filter',
    'freeze',
    'create_sheet',
    'rename_sheet',
  ]);
  assert.equal(edit.properties.confirmToken.type, 'string');
  assert.deepEqual(plain(tools.find((tool) => tool.name === 'undo_sheet_edit').input_schema), {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'undo'] },
      id: { type: 'string', description: 'An id from list; omit to undo the latest edit.' },
    },
    required: ['action'],
  });
  assert.equal(f.api.DMV_CHAT_PROGRESS_LABELS.undo_sheet_edit, 'Undoing a sheet edit');
  assert.throws(
    () => f.api.dmvChatEditSheet_(f.session, { action: 'delete_rows' }),
    /^Error: Choose a supported sheet action\.$/
  );
  assert.throws(
    () => f.api.dmvChatEditSheet_(f.session, { action: 'constructor' }),
    /^Error: Choose a supported sheet action\.$/
  );
});

test('a registered action runs with the token, guard, confirmation, undo and one batch', () => {
  const f = fixture();
  seed(f);
  const plans = [];
  f.api.dmvChatSheetActions_ = () => ({
    clear_notes: {
      fields: ['keepFirst'],
      plan(context) {
        plans.push(context);
        if (context.input.keepFirst !== undefined && typeof context.input.keepFirst !== 'boolean')
          throw new Error('keepFirst must be true or false.');
        return {
          requests: [{ repeatCell: { range: context.area.grid, cell: {}, fields: 'note' } }],
          text: 'Cleared notes in ' + context.sheet.getName() + '!' + context.area.a1,
          details: [['Notes', 'cleared']],
          result: { cleared: true },
          confirm: context.area.rows > 2 ? 'Clear notes in a wide range?' : '',
        };
      },
    },
    // Built-in names stay built in.
    set_values: { plan: () => assert.fail('a registered action never replaces a built-in one') },
  });
  f.api.dmvChatSheetActionSchema_ = () => ({
    actions: ['clear_notes', 'set_values'],
    properties: { keepFirst: { type: 'boolean' }, values: { type: 'string' } },
  });
  const schema = plain(
    f.api.dmvChatTools_(f.session).find((tool) => tool.name === 'edit_sheet').input_schema
  );
  assert.equal(schema.properties.action.enum.filter((name) => name === 'set_values').length, 1);
  assert.ok(schema.properties.action.enum.includes('clear_notes'));
  assert.equal(schema.properties.values.type, 'array', 'built-in properties keep their meaning');
  assert.deepEqual(schema.properties.keepFirst, { type: 'boolean' });

  assert.throws(
    () =>
      f.api.dmvChatEditSheet_(f.session, {
        action: 'clear_notes',
        sheetName: 'Output',
        range: 'A1',
      }),
    /Inspect the target range before editing it/
  );
  assert.throws(() => f.edit('clear_notes', { other: 1 }), /documented fields/);
  const before = f.cellState(f.sheet, 1, 1, 2, 2);
  const result = f.edit('clear_notes', { keepFirst: true });
  assert.equal(plans.length, 1);
  assert.equal(plans[0].snapshot.cells[0][0].note, 'first note', 'plan sees the inspected cells');
  assert.equal(result.ok, true);
  assert.equal(result.cleared, true);
  assert.equal(result.range, 'A1:B2');
  assert.match(result.url, /#gid=\d+&range=A1%3AB2$/);
  assert.match(result.undoId, /^u[a-f0-9]{12}$/);
  assert.equal(f.state.batches.length, 1);
  assert.deepEqual(f.meta(f.sheet, 1, 1), {});
  const event = plain(f.session.events.at(-1));
  assert.equal(event.text, 'Cleared notes in Output!A1:B2');
  assert.deepEqual(event.details, [
    { label: 'Action', value: 'clear_notes' },
    { label: 'Range', value: 'A1:B2' },
    { label: 'Notes', value: 'cleared' },
  ]);
  f.undo({ action: 'undo' });
  assert.deepEqual(f.cellState(f.sheet, 1, 1, 2, 2), before);
  // The token is single use, a wide range asks first, and owned output is refused.
  const inspected = f.inspect('A1:A3');
  const asked = f.edit('clear_notes', {}, inspected);
  assert.equal(asked.needsConfirmation, true);
  assert.equal(asked.summary, 'Clear notes in a wide range?');
  const yes = f.answer('yes');
  assert.equal(
    f.edit('clear_notes', { confirmToken: asked.confirmToken }, inspected, yes).ok,
    true
  );
  assert.throws(() => f.edit('clear_notes', {}, inspected, yes), /inspection expired/);
  const g = fixture();
  g.report();
  g.api.dmvChatSheetActions_ = f.api.dmvChatSheetActions_;
  assert.throws(() => g.edit('clear_notes', {}, g.inspect('A1')), /saved report "Daily"/);
});

test('registered tools join the chat tools with their progress label, without name clashes', () => {
  const f = fixture();
  f.api.dmvChatSheetConditionTools_ = () => [
    {
      name: 'search_sheets',
      label: 'Searching the spreadsheet',
      description: 'Find text.',
      input_schema: { type: 'object', properties: {} },
      run: () => ({ matches: [] }),
    },
    { name: 'edit_sheet', description: 'clash', input_schema: { type: 'object' }, run: () => 1 },
  ];
  f.api.dmvChatSheetFormulaTools_ = () => [
    {
      name: 'search_sheets',
      description: 'second',
      input_schema: { type: 'object' },
      run: () => 2,
    },
  ];
  const tools = f.api.dmvChatTools_(f.session);
  const names = tools.map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length);
  assert.equal(tools.find((tool) => tool.name === 'search_sheets').description, 'Find text.');
  assert.notEqual(tools.find((tool) => tool.name === 'edit_sheet').description, 'clash');
  assert.equal(f.api.dmvChatSheetToolLabel_('search_sheets'), 'Searching the spreadsheet');
  assert.equal(f.api.dmvChatSheetToolLabel_('nothing'), '');
  const ran = f.api.dmvChatRunTool_(f.session, tools, {
    name: 'search_sheets',
    id: 's',
    input: {},
  });
  assert.deepEqual(JSON.parse(ran.content), { matches: [] });
});

test('a tab deleted through a registered action comes back from its hidden copy, which expires', () => {
  const f = fixture();
  const notes = f.book.insertSheet('Notes');
  f.setCell(notes, 1, 1, 'keep me');
  f.api.dmvChatSheetActions_ = () => ({
    delete_sheet: {
      target: 'sheet',
      plan(context) {
        const copy = f.api.dmvChatUndoSheetCopy_(context.session, context.sheet);
        return {
          requests: copy.requests.concat([
            { deleteSheet: { sheetId: context.sheet.getSheetId() } },
          ]),
          guard: [{ sheetId: context.sheet.getSheetId() }],
          undo: copy.undo,
          confirm: 'Delete the tab "' + context.sheet.getName() + '"?',
          text: 'Deleted tab ' + context.sheet.getName(),
        };
      },
    },
  });
  const remove = (session) =>
    plain(f.api.dmvChatEditSheet_(session, { action: 'delete_sheet', sheetName: 'Notes' }));
  const asked = remove(f.session);
  assert.equal(asked.needsConfirmation, true);
  assert.ok(f.tab('Notes'));
  const yes = f.answer('Yes');
  const deleted = remove(yes);
  assert.equal(deleted.ok, true);
  assert.equal(deleted.url, null, 'no link to the deleted tab');
  assert.match(deleted.undoId, /^u[a-f0-9]{12}$/);
  assert.equal(f.tab('Notes'), null);
  const copy = f.tab('DataMoov undo · Notes');
  assert.ok(copy && copy.hidden);
  assert.equal(f.value(copy, 1, 1), 'keep me');
  assert.deepEqual(
    f.state.batches.at(-1).body.requests.map((request) => Object.keys(request)[0]),
    ['duplicateSheet', 'updateSheetProperties', 'deleteSheet']
  );
  const undone = f.undo({ action: 'undo' }, yes);
  assert.equal(undone.ok, true);
  assert.match(undone.note, /#REF!/);
  const back = f.tab('Notes');
  assert.ok(back && !back.hidden);
  assert.equal(back.id, copy.id);
  assert.equal(f.book.sheets.indexOf(back), 1, 'back in its place');
  assert.equal(f.value(back, 1, 1), 'keep me');
  assert.equal(f.state.user.getProperty('dmv:v1:undo-tabs:' + f.book.id), null);

  // Deleted again: once the undo window ends, the next edit removes the hidden copy.
  remove(f.session);
  remove(f.answer('yes'));
  const hidden = f.tab('DataMoov undo · Notes');
  assert.ok(hidden?.hidden);
  f.advance(6 * 3600 * 1000 + 1);
  f.api.dmvChatSheetActions_ = () => ({
    stamp: {
      plan: (context) => ({
        requests: [
          {
            updateCells: {
              range: context.area.grid,
              rows: [{ values: [{ userEnteredValue: { stringValue: 'stamp' } }] }],
              fields: 'userEnteredValue',
            },
          },
        ],
      }),
    },
  });
  const later = f.api.dmvChatSession_(f.book);
  plain(
    f.api.dmvChatEditSheet_(later, {
      action: 'stamp',
      sheetName: 'Output',
      range: 'A1',
      editToken: f.inspect('A1', 'Output', later).editToken,
    })
  );
  assert.equal(f.tab('DataMoov undo · Notes'), null);
  assert.deepEqual(f.state.batches.at(-1).body.requests.at(-1), {
    deleteSheet: { sheetId: hidden.id },
  });
  assert.equal(f.state.user.getProperty('dmv:v1:undo-tabs:' + f.book.id), null);
});

test('the formula policy hook checks formulas, guards its spill and reads results back', () => {
  const f = fixture();
  f.book.insertSheet('Other');
  f.setCell(f.sheet, 2, 1, 'under the spill');
  const seen = [];
  f.api.dmvChatSheetFormulaPolicy_ = (session, sheet, area, formulas) => {
    seen.push(plain(formulas));
    if (String(formulas[0][0]).includes('IMPORTRANGE'))
      throw new Error('IMPORTRANGE is not allowed.');
    return {
      touches: [
        {
          sheetId: sheet.getSheetId(),
          startRowIndex: 1,
          endRowIndex: 3,
          startColumnIndex: 0,
          endColumnIndex: 1,
        },
      ],
    };
  };
  f.api.dmvChatSheetFormulaReadBack_ = (session, written) => ({
    readBack: written.after.map((item) => [item.grid.startRowIndex, item.cells.length]),
  });
  const result = f.edit(
    'set_formulas',
    { formulas: [['=FILTER(Other!A:A, Other!A:A<>"")']] },
    f.inspect('A1')
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.readBack, [
    [0, 1],
    [1, 2],
  ]);
  assert.equal(f.formula(f.sheet, 1, 1), '=FILTER(Other!A:A, Other!A:A<>"")');
  assert.throws(
    () => f.edit('set_formulas', { formulas: [['=IMPORTRANGE("x","y")']] }, f.inspect('C1')),
    /IMPORTRANGE is not allowed/
  );
  assert.throws(
    () => f.edit('set_formulas', { formulas: [[1]] }, f.inspect('C1')),
    /text beginning with =/
  );
  // Undo restores the range and the spill area it touched.
  f.undo({ action: 'undo' });
  assert.equal(f.formula(f.sheet, 1, 1), '');
  assert.equal(f.value(f.sheet, 2, 1), 'under the spill');
  assert.equal(seen.length, 3);
  // A spill onto report output is refused.
  const g = fixture();
  g.report();
  g.api.dmvChatSheetFormulaPolicy_ = f.api.dmvChatSheetFormulaPolicy_;
  assert.throws(
    () => g.edit('set_formulas', { formulas: [['=1']] }, g.inspect('H1')),
    /saved report "Daily"/
  );
  assert.equal(g.value(g.sheet, 1, 8), '');
});
