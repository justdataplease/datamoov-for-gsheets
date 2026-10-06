import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatamoovSandbox, plain } from './helpers/datamoov-sandbox.mjs';

// The analyst sheet tools end to end, through dmvChat with a scripted Anthropic model: "clean
// this export: trim, dedupe on email, split name, add a status dropdown, pivot spend by campaign
// and month on a new tab, colour CPA > 50 red, then undo the colour". The first request asks
// before removing duplicates; the second is the sidebar's Yes chip, which sends the offered
// confirmToken with the message, exactly as src/dmv_client_chat.html does.

const AI_KEY = 'sk-ant-offline-analyst-0001';
const HEADER = [
  'Email',
  'Name',
  '',
  'Campaign',
  'Date',
  'Currency',
  'Spend',
  'Conversions',
  'CPA',
  'Status',
];
const day = (iso) => new Date(iso + 'T12:00:00Z');

function fixture() {
  const f = createDatamoovSandbox({ gridData: true });
  f.sheet = f.book.sheets[0];
  f.sheet.name = 'Export';
  const rows = [
    HEADER,
    [' ann@x.com ', 'Ann Lee', '', 'Brand', day('2026-08-03'), 'EUR', 120, 3, 40, ''],
    ['bob@x.com', 'Bob Ray', '', 'Generic', day('2026-08-10'), 'EUR', 300, 4, 75, ''],
    ['ann@x.com', 'Ann Lee', '', 'Brand', day('2026-08-03'), 'EUR', 120, 3, 40, ''],
    ['cy@x.com  ', 'Cy Fox', '', 'Brand', day('2026-09-02'), 'EUR', 90, 1, 90, ''],
    ['di@x.com', 'Di Moss', '', 'Generic', day('2026-09-15'), 'EUR', 60, 2, 30, ''],
  ];
  rows.forEach((row, r) =>
    row.forEach((value, c) => value !== '' && f.setCell(f.sheet, r + 1, c + 1, value))
  );
  f.api.dmvSaveAiSettings({ provider: 'anthropic', apiKey: AI_KEY });
  // Scripted replies name tokens by placeholder, replaced as a model would copy them from the
  // tool results: the edit token of the latest inspection of that range, the latest confirmToken.
  // REPLAYED is the confirmToken as the replayed transcript text shows it, all a model has of a
  // token from an earlier request.
  f.seen = {};
  f.tokens = {};
  f.requests = [];
  const fetch = f.api.UrlFetchApp.fetch;
  f.api.UrlFetchApp.fetch = (url, options) => {
    const body = JSON.parse(options.payload);
    f.requests.push(body);
    let replayed;
    for (const message of body.messages)
      for (const block of Array.isArray(message.content) ? message.content : [])
        if (block.type === 'tool_result') {
          const result = JSON.parse(block.content);
          Object.assign(f.seen, result);
          if (result.editToken) f.tokens[result.range] = result.editToken;
        } else if (block.type === 'text')
          for (const found of block.text.matchAll(/confirmToken (c[a-f0-9]*)/g))
            replayed = found[1];
    for (const block of f.state.responses[0]?.body?.content || [])
      if (block.type === 'tool_use') {
        if (block.input.editToken === 'EDIT') block.input.editToken = f.tokens[block.input.range];
        if (block.input.confirmToken === 'CONFIRM') block.input.confirmToken = f.seen.confirmToken;
        if (block.input.confirmToken === 'REPLAYED') block.input.confirmToken = replayed;
      }
    return fetch(url, options);
  };
  return f;
}

// The question the sidebar turns into Yes and No chips: a summary event carrying the token.
const offered = (events) =>
  events.filter((event) => event.kind === 'summary' && /^confirmToken /.test(event.ref || ''));
const reply = (blocks, stop = 'tool_use') => ({ body: { content: blocks, stop_reason: stop } });
let calls = 0;
const call = (name, input) => ({ type: 'tool_use', id: 'call' + ++calls, name, input });
const inspect = (range) => call('inspect_sheet', { sheetName: 'Export', range });
const edit = (action, range, extra) =>
  call('edit_sheet', { action, sheetName: 'Export', range, editToken: 'EDIT', ...extra });
const dedupe = (extra) => edit('remove_duplicates', 'A1:J6', { keyColumns: [1], ...extra });

function row(f, r) {
  return HEADER.map((_, c) => {
    const value = f.value(f.sheet, r, c + 1);
    return value instanceof Date ? value.toISOString().slice(0, 10) : value;
  });
}

test('a scripted chat cleans an export, pivots it, colours high CPA and undoes the colour', () => {
  const f = fixture();
  f.state.responses.push(
    reply([inspect('A1:J6')]),
    reply([edit('trim_whitespace', 'A1:J6'), inspect('A1:J6')]),
    reply([dedupe()]),
    reply([
      call('ask_user', { question: 'Remove 1 duplicate row by email?', options: ['Yes', 'No'] }),
    ])
  );
  const first = plain(f.api.dmvChat({ text: 'Clean this export', transcript: [] }));
  assert.equal(first.failed, false);
  assert.equal(first.text, 'Remove 1 duplicate row by email?');
  assert.deepEqual(first.options, ['Yes', 'No']);
  // The sheet tools reach the model, and the prompt carries the analyst guidance.
  const names = f.requests[0].tools.map((tool) => tool.name);
  for (const name of [
    'inspect_sheet',
    'edit_sheet',
    'undo_sheet_edit',
    'search_sheets',
    'conditional_format',
    'create_pivot',
  ])
    assert.ok(names.includes(name), name);
  assert.match(
    f.requests[0].system[0].text,
    /Work like an analyst: lookups across tabs, pivots, conditional_format and cleanup actions/
  );
  assert.match(
    f.requests[0].system[0].text,
    /Never edit report or dashboard output \(change the report instead\)/
  );
  assert.doesNotMatch(f.requests[0].system[0].text, /same-tab references/);
  // Only the trim ran; the dedupe waits for the user's answer and its token travels in the
  // transcript and in the event the sidebar turns into Yes and No chips.
  assert.equal(f.state.batches.length, 1);
  assert.deepEqual(row(f, 2).slice(0, 2), ['ann@x.com', 'Ann Lee']);
  assert.equal(f.value(f.sheet, 5, 1), 'cy@x.com');
  const asked = offered(first.events);
  assert.equal(asked.length, 1);
  const token = /^confirmToken (c[a-f0-9]{32})$/.exec(asked[0].ref)[1];
  assert.equal(token, f.seen.confirmToken);
  assert.ok(first.transcriptAppend[1].actions.some((action) => action.includes(token)));

  f.state.responses.push(
    reply([inspect('A1:J6')]),
    // Calls in one reply run in order, so an inspection after an edit sees the edited cells.
    reply([dedupe({ confirmToken: 'CONFIRM' }), inspect('B1:B5')]),
    reply([
      edit('split_columns', 'B1:B5', { delimiter: 'space' }),
      inspect('B1:C1'),
      inspect('J2:J5'),
    ]),
    reply([
      edit('set_values', 'B1:C1', { values: [['First name', 'Last name']] }),
      edit('data_validation', 'J2:J5', {
        validation: { type: 'list', values: ['New', 'Contacted', 'Won'] },
      }),
      call('create_pivot', {
        sourceSheet: 'Export',
        sourceRange: 'A1:J5',
        targetSheet: 'Spend by campaign',
        rows: [{ column: 4, order: 'desc', sortByValue: 1 }, { column: 6 }],
        columns: [{ column: 5, dateBucket: 'month' }],
        values: [{ column: 7, summarize: 'SUM' }],
        totals: true,
      }),
      call('conditional_format', {
        action: 'add',
        sheetName: 'Export',
        range: 'I2:I',
        condition: { type: 'number_gt', value: 50 },
        format: { backgroundColor: '#ff0000' },
      }),
    ]),
    reply([call('undo_sheet_edit', { action: 'undo' })]),
    reply([{ type: 'text', text: 'Cleaned and pivoted; the CPA colour is undone.' }], 'end_turn')
  );
  const second = plain(
    f.api.dmvChat({ text: 'Yes', transcript: first.transcriptAppend, confirmToken: token })
  );
  assert.equal(second.failed, false, second.text);
  assert.equal(second.text, 'Cleaned and pivoted; the CPA colour is undone.');
  assert.equal(second.options, null, 'nothing waits for an answer any more');
  assert.equal(offered(second.events).length, 0);
  const writes = second.events.filter((event) => event.kind === 'write');
  assert.deepEqual(
    writes.map((event) => event.text),
    [
      'Removed duplicate rows from Export!A2:J6',
      'Split Export!B1:B5 into columns',
      writes[2].text,
      'Set validation on Export!J2:J5',
      writes[4].text,
      'Added conditional formatting to Export!I2:I',
      'Undid: Added conditional formatting to Export!I2:I',
    ]
  );
  assert.match(writes[2].text, /Export!B1:C1/);
  assert.match(writes[4].text, /Spend by campaign/);
  assert.deepEqual(row(f, 1).slice(0, 3), ['Email', 'First name', 'Last name']);
  // The export reads clean: trimmed, one row per email, names split, CPA uncoloured.
  assert.deepEqual(
    [2, 3, 4, 5, 6].map((r) => row(f, r)),
    [
      ['ann@x.com', 'Ann', 'Lee', 'Brand', '2026-08-03', 'EUR', 120, 3, 40, ''],
      ['bob@x.com', 'Bob', 'Ray', 'Generic', '2026-08-10', 'EUR', 300, 4, 75, ''],
      ['cy@x.com', 'Cy', 'Fox', 'Brand', '2026-09-02', 'EUR', 90, 1, 90, ''],
      ['di@x.com', 'Di', 'Moss', 'Generic', '2026-09-15', 'EUR', 60, 2, 30, ''],
      ['', '', '', '', '', '', '', '', '', ''],
    ]
  );
  // The status dropdown is on every data row and nowhere else.
  for (const r of [2, 3, 4, 5]) {
    const rule = f.meta(f.sheet, r, 10).dataValidation;
    assert.equal(rule.condition.type, 'ONE_OF_LIST', 'row ' + r);
    assert.deepEqual(
      rule.condition.values.map((value) => value.userEnteredValue),
      ['New', 'Contacted', 'Won']
    );
  }
  assert.equal(f.meta(f.sheet, 1, 10).dataValidation, undefined);
  // The colour rule covered CPA from row 2 to the last row before the undo removed it.
  const added = f.state.batches
    .flatMap((batch) => plain(batch.body.requests))
    .map((request) => request.addConditionalFormatRule)
    .find(Boolean);
  assert.deepEqual(added.rule.ranges, [
    { sheetId: f.sheet.id, startRowIndex: 1, startColumnIndex: 8, endColumnIndex: 9 },
  ]);
  assert.deepEqual(added.rule.booleanRule.condition, {
    type: 'NUMBER_GREATER',
    values: [{ userEnteredValue: '50' }],
  });
  assert.deepEqual(f.conditionalFormats(f.sheet), [], 'the colour is undone');
  // The pivot is a native pivot on its own new tab, grouped by campaign, currency and month.
  const pivotTab = f.tab('Spend by campaign');
  assert.ok(pivotTab, 'the pivot tab stays after the undo');
  const pivot = f.state.batches
    .flatMap((batch) => plain(batch.body.requests))
    .map((request) => request.updateCells?.rows?.[0]?.values?.[0]?.pivotTable)
    .find(Boolean);
  assert.deepEqual(
    pivot.rows.map((group) => [group.sourceColumnOffset, group.sortOrder]),
    [
      [3, 'DESCENDING'],
      [5, 'ASCENDING'],
    ]
  );
  assert.deepEqual(pivot.rows[0].valueBucket, { valuesIndex: 0 });
  assert.equal(pivot.columns[0].sourceColumnOffset, 4);
  assert.deepEqual(pivot.columns[0].groupRule, { dateTimeRule: { type: 'YEAR_MONTH' } });
  assert.deepEqual(plain(pivot.values), [{ sourceColumnOffset: 6, summarizeFunction: 'SUM' }]);
  assert.deepEqual(pivot.source, {
    sheetId: f.sheet.id,
    startRowIndex: 0,
    endRowIndex: 5,
    startColumnIndex: 0,
    endColumnIndex: 10,
  });
  // One batch per change, the undo included; the answer was the yes, so nothing else ran.
  assert.equal(f.state.batches.length, 8);
  // Only the AI provider was called; every sheet change went through the Sheets service.
  assert.ok(f.state.http.every((request) => request.url.startsWith('https://api.anthropic.com/')));
  assert.equal(JSON.stringify(second).includes(AI_KEY), false);
});

test('a No, another message or a replayed token leaves the confirmation unused', () => {
  const run = (answer) => {
    const f = fixture();
    f.setCell(f.sheet, 2, 1, 'ann@x.com');
    f.state.responses.push(
      reply([inspect('A1:J6')]),
      reply([dedupe()]),
      reply([call('ask_user', { question: 'Remove the duplicate?', options: ['Yes', 'No'] })])
    );
    const first = plain(f.api.dmvChat({ text: 'Remove duplicate emails', transcript: [] }));
    const token = /^confirmToken (c[a-f0-9]{32})$/.exec(offered(first.events)[0].ref)[1];
    f.state.responses.push(
      reply([inspect('A1:J6')]),
      reply([dedupe({ confirmToken: 'CONFIRM' })]),
      reply([{ type: 'text', text: 'Done.' }], 'end_turn')
    );
    const second = plain(
      f.api.dmvChat({
        text: answer.text,
        transcript: first.transcriptAppend,
        ...answer.extra(token),
      })
    );
    return { f, token, first, second };
  };
  // A plain No ends the request with one answer and no tool round, so no call can use the token.
  {
    const { f, second } = run({ text: 'No', extra: () => ({}) });
    assert.equal(f.state.batches.length, 0);
    assert.equal(f.requests.at(-1).tools, undefined, 'the answer to a No has no tools');
    assert.equal(second.events.filter((event) => event.kind !== 'summary').length, 0);
    assert.equal(f.value(f.sheet, 4, 1), 'ann@x.com');
  }
  for (const answer of [
    { text: 'Keep both rows', extra: () => ({}) },
    { text: 'Yes', extra: () => ({ confirmToken: 'c' + '0'.repeat(32) }) },
  ]) {
    const { f, second } = run(answer);
    assert.equal(f.state.batches.length, 0, answer.text);
    const error = second.events.find((event) => event.kind === 'error');
    assert.match(error.text, /not approved by the user in this request/, answer.text);
    assert.equal(f.value(f.sheet, 4, 1), 'ann@x.com', answer.text);
  }
  // The right token acts once; the same token in a later request is refused, even when there
  // is a duplicate to remove again.
  const { f, token, second } = run({
    text: 'Yes',
    extra: (offered) => ({ confirmToken: offered }),
  });
  assert.equal(f.state.batches.length, 1);
  assert.equal(second.events.filter((event) => event.kind === 'error').length, 0);
  f.setCell(f.sheet, 6, 1, 'ann@x.com');
  f.state.responses.push(
    reply([inspect('A1:J6')]),
    reply([dedupe({ confirmToken: token })]),
    reply([{ type: 'text', text: 'Done again.' }], 'end_turn')
  );
  const third = plain(
    f.api.dmvChat({ text: 'Yes', transcript: second.transcriptAppend, confirmToken: token })
  );
  assert.equal(f.state.batches.length, 1, 'a replayed token changes nothing');
  assert.match(third.events.find((event) => event.kind === 'error').text, /not approved/);
});

test('the confirmToken reaches the next request whole, after a long question or a busy turn', () => {
  for (const inspections of [0, 11]) {
    const f = fixture();
    // A long tab name makes a long question; the token comes after it.
    f.sheet.name = 'Campaign performance Q3 by country';
    const tab = f.sheet.name;
    const remove = (extra) =>
      call('edit_sheet', { action: 'delete_rows', sheetName: tab, start: 3, count: 2, ...extra });
    f.state.responses.push(
      ...(inspections
        ? [
            reply(
              Array.from({ length: inspections }, () =>
                call('inspect_sheet', { sheetName: tab, range: 'A1:B2' })
              )
            ),
          ]
        : []),
      reply([remove()]),
      reply([call('ask_user', { question: 'Delete rows 3-4?', options: ['Yes', 'No'] })])
    );
    const first = plain(f.api.dmvChat({ text: 'Delete rows 3 and 4', transcript: [] }));
    const token = /^confirmToken (c[a-f0-9]{32})$/.exec(offered(first.events)[0].ref)[1];
    f.state.responses.push(
      reply([remove({ confirmToken: 'REPLAYED' })]),
      reply([{ type: 'text', text: 'Deleted.' }], 'end_turn')
    );
    const second = plain(
      f.api.dmvChat({ text: 'Yes', transcript: first.transcriptAppend, confirmToken: token })
    );
    const label = inspections + ' inspections first';
    assert.deepEqual(
      second.events.filter((event) => event.kind === 'error'),
      [],
      label
    );
    assert.equal(f.state.batches.length, 1, label);
    assert.equal(f.value(f.sheet, 3, 1).trim(), 'cy@x.com', label);
  }
});

test('a cut-off confirmToken says the call works without it once the user said yes', () => {
  const f = fixture();
  f.setCell(f.sheet, 2, 1, 'ann@x.com');
  f.state.responses.push(
    reply([inspect('A1:J6')]),
    reply([dedupe()]),
    reply([call('ask_user', { question: 'Remove the duplicate?', options: ['Yes', 'No'] })])
  );
  const first = plain(f.api.dmvChat({ text: 'Remove duplicate emails', transcript: [] }));
  const token = /^confirmToken (c[a-f0-9]{32})$/.exec(offered(first.events)[0].ref)[1];
  f.state.responses.push(
    reply([inspect('A1:J6')]),
    reply([dedupe({ confirmToken: token.slice(0, 20) })]),
    reply([dedupe()]),
    reply([{ type: 'text', text: 'Done.' }], 'end_turn')
  );
  const second = plain(
    f.api.dmvChat({ text: 'Yes', transcript: first.transcriptAppend, confirmToken: token })
  );
  const errors = second.events.filter((event) => event.kind === 'error');
  assert.equal(errors.length, 1);
  assert.match(errors[0].text, /repeat the identical call without confirmToken/);
  assert.equal(f.state.batches.length, 1, 'the call without the token acted');
});

test('a confirmToken sent with another call returns the approved call to repeat', () => {
  const f = fixture();
  f.setCell(f.sheet, 2, 1, 'ann@x.com');
  f.state.responses.push(
    reply([inspect('A1:J6')]),
    reply([dedupe()]),
    reply([call('ask_user', { question: 'Remove the duplicate?', options: ['Yes', 'No'] })])
  );
  const first = plain(f.api.dmvChat({ text: 'Remove duplicate emails', transcript: [] }));
  const token = /^confirmToken (c[a-f0-9]{32})$/.exec(offered(first.events)[0].ref)[1];
  f.state.responses.push(
    reply([inspect('A1:J6')]),
    reply([dedupe({ keep: 'last', confirmToken: 'CONFIRM' })]),
    reply([{ type: 'text', text: 'Asked again.' }], 'end_turn')
  );
  plain(f.api.dmvChat({ text: 'Yes', transcript: first.transcriptAppend, confirmToken: token }));
  const result = JSON.parse(
    f.requests
      .at(-1)
      .messages.at(-1)
      .content.find((block) => block.type === 'tool_result').content
  );
  assert.match(result.error, /given for a different change/);
  assert.deepEqual(result.approvedCalls, [
    { action: 'remove_duplicates', keyColumns: [1], range: 'A1:J6', sheetName: 'Export' },
  ]);
  assert.equal(f.state.batches.length, 0);
});

test('a question waits for its own conversation: another chat neither drops nor approves it', () => {
  const f = fixture();
  f.setCell(f.sheet, 2, 1, 'ann@x.com');
  const ONE = 'conversation-one-0000-0000-000000000001';
  const TWO = 'conversation-two-0000-0000-000000000002';
  f.state.responses.push(
    reply([inspect('A1:J6')]),
    reply([dedupe()]),
    reply([call('ask_user', { question: 'Remove the duplicate?', options: ['Yes', 'No'] })])
  );
  const first = plain(
    f.api.dmvChat({ text: 'Remove duplicate emails', transcript: [], conversationId: ONE })
  );
  const token = /^confirmToken (c[a-f0-9]{32})$/.exec(offered(first.events)[0].ref)[1];
  // Another sidebar, or the same one after New chat, answers yes to something else; the same
  // call there still has to ask.
  f.state.responses.push(
    reply([inspect('A1:J6')]),
    reply([dedupe()]),
    reply([{ type: 'text', text: 'Asked.' }], 'end_turn')
  );
  const other = plain(f.api.dmvChat({ text: 'Yes', transcript: [], conversationId: TWO }));
  assert.equal(offered(other.events).length, 1, 'the other chat was not approved');
  assert.equal(f.state.batches.length, 0);
  // The first conversation's Yes chip still approves its own question.
  f.state.responses.push(
    reply([inspect('A1:J6')]),
    reply([dedupe({ confirmToken: 'REPLAYED' })]),
    reply([{ type: 'text', text: 'Done.' }], 'end_turn')
  );
  const yes = plain(
    f.api.dmvChat({
      text: 'Yes',
      transcript: first.transcriptAppend,
      confirmToken: token,
      conversationId: ONE,
    })
  );
  assert.deepEqual(
    yes.events.filter((event) => event.kind === 'error'),
    []
  );
  assert.equal(f.state.batches.length, 1);
  assert.throws(
    () => f.api.dmvChat({ text: 'Yes', transcript: [], conversationId: 'short' }),
    /Choose a valid chat conversation ID/
  );
});
