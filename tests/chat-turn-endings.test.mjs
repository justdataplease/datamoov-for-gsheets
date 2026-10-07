import test from 'node:test';
import assert from 'node:assert/strict';
import { plain } from './helpers/datamoov-sandbox.mjs';
import { chatSheetFixture } from './helpers/chat-sheet-fixture.mjs';

// How a chat request ends: the reason the final answer gives (step limit or time), the rounds
// left, replies that describe changes no tool made, result ids the conversation never had,
// the user's no to a confirmation, one question for several changes, and formula errors left in
// cells the request wrote. Every model reply here is scripted; nothing leaves the sandbox.

const REQUEST = '8a1c51f0-7d0e-4a8f-9f53-0e9b8c7d6a51';
const CONVERSATION = '2b7e9d40-3c1a-4f6e-8d2b-7a6c5e4f3d21';
const reply = (text = '', toolCalls = [], stop = 'end') => ({ text, toolCalls, stop });
const call = (name, input, id = name) => ({ id, name, input });
const listSheets = () => reply('', [call('list_sheets', {})], 'tool');
// The text blocks of a request's last message (a closing note, or lines beside tool results).
const notes = (request) =>
  request.messages
    .at(-1)
    .content.filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
const results = (request) =>
  request.messages
    .at(-1)
    .content.filter((block) => block.type === 'tool_result')
    .map((block) => JSON.parse(block.content));

function fixture(options = {}) {
  const f = chatSheetFixture({ setup: options.setup, sortRange: options.sortRange });
  f.api.dmvAiRead_ = () => ({
    provider: 'gemini',
    model: 'gemini-3.8-flash',
    apiKey: 'offline-endings-key',
    maxRows: 1000,
    timeLimit: options.timeLimit,
  });
  f.api.DMV_AI.defaultTimeLimit = 200;
  f.replies = [];
  f.requests = [];
  f.api.dmvAiComplete_ = (_settings, request) => {
    f.requests.push(plain(request));
    const next = f.replies.shift();
    assert.ok(next, 'unexpected extra model request');
    return typeof next === 'function' ? next(request) : next;
  };
  f.chat = (text, extra = {}) => plain(f.api.dmvChat({ text, transcript: [], ...extra }));
  return f;
}

test('the round cap ends with a step-limit answer, the clock with a time answer', () => {
  const f = fixture();
  f.api.DMV_CHAT.maxRounds = 2;
  f.replies.push(listSheets(), listSheets(), reply('Two tabs were listed.'));
  const capped = f.chat('List the tabs twice');
  assert.equal(capped.text, 'Two tabs were listed.');
  const closing = f.requests.at(-1);
  assert.deepEqual(closing.tools, []);
  assert.match(notes(closing), /step limit/i);
  assert.doesNotMatch(notes(closing), /time for this turn is over/);

  const g = fixture();
  g.replies.push(() => {
    g.advance(201000);
    return listSheets();
  }, reply('Out of time.'));
  g.chat('List the tabs');
  const late = g.requests.at(-1);
  assert.deepEqual(late.tools, []);
  assert.match(notes(late), /time for this turn is over/);
  assert.doesNotMatch(notes(late), /step limit/i);
});

test('a 600-second request may take 48 tool rounds before its closing answer', () => {
  const f = fixture({ timeLimit: 600 });
  for (let i = 0; i < 48; i++) f.replies.push(listSheets());
  f.replies.push(reply('Done.'));
  const result = f.chat('Keep listing tabs', { requestId: REQUEST });
  assert.equal(result.text, 'Done.');
  assert.equal(f.requests.length, 49);
  assert.ok(f.requests[47].tools.length > 0);
  assert.deepEqual(f.requests[48].tools, []);
});

test('the last five tool rounds carry a line that says how many are left', () => {
  const f = fixture();
  f.api.DMV_CHAT.maxRounds = 4;
  f.replies.push(listSheets(), listSheets(), listSheets(), listSheets(), reply('Done.'));
  f.chat('List the tabs');
  assert.match(notes(f.requests[1]), /3 tool rounds left/);
  assert.match(notes(f.requests[2]), /2 tool rounds left/);
  assert.match(notes(f.requests[3]), /1 tool round left/);
  // The tool results still come first, so each provider pairs them with their calls.
  assert.equal(f.requests[1].messages.at(-1).content[0].type, 'tool_result');

  const g = fixture();
  g.replies.push(listSheets(), reply('Done.'));
  g.chat('List the tabs');
  assert.doesNotMatch(notes(g.requests[1]), /rounds? left/);
});

test('a reply that describes changes no tool made is sent back up to twice, then marked', () => {
  const f = fixture();
  f.replies.push(
    reply('I created the tab "Totals" with a KPI row and a chart.'),
    reply('I have not built it yet: tell me which tab holds the data.')
  );
  const result = f.chat('Build a totals tab with a chart');
  assert.equal(result.text, 'I have not built it yet: tell me which tab holds the data.');
  assert.equal(f.requests.length, 2);
  assert.ok(f.requests[1].tools.length > 0, 'the model may still do the work');
  assert.match(notes(f.requests[1]), /No tool changed the spreadsheet in this request/);

  // A reply that claims the change again keeps it, with a line that says nothing changed.
  const g = fixture();
  g.replies.push(
    reply('I created the tab "Totals" with a KPI row.'),
    reply('The tab "Totals" was created with a KPI row.'),
    reply('The tab "Totals" was created with a KPI row.')
  );
  const marked = g.chat('Build a totals tab');
  assert.equal(g.requests.length, 3);
  assert.match(marked.text, /^The tab "Totals" was created with a KPI row\./);
  assert.match(marked.text, /No tool changed the spreadsheet in this request\.$/);

  // An answer that claims nothing, and a claim a tool backs, go out as they are.
  const h = fixture();
  h.replies.push(reply('No total is available yet.'));
  assert.equal(h.chat('What is the total?').text, 'No total is available yet.');
  assert.equal(h.requests.length, 1);
  const k = fixture();
  k.replies.push(
    reply('', [call('edit_sheet', { action: 'create_sheet', newName: 'Totals' })], 'tool'),
    reply('I created the tab "Totals".')
  );
  assert.equal(k.chat('Make a Totals tab').text, 'I created the tab "Totals".');
  assert.equal(k.requests.length, 2);
});

test('a second correction can finish the requested change without replaying earlier actions', () => {
  const f = fixture();
  f.replies.push(
    reply('I created the tab "Totals".'),
    reply('I created the tab "Totals".'),
    reply('', [call('edit_sheet', { action: 'create_sheet', newName: 'Totals' })], 'tool'),
    reply('I created the tab "Totals".')
  );
  const result = f.chat('Create a Totals tab');
  assert.equal(result.text, 'I created the tab "Totals".');
  assert.equal(f.requests.length, 4);
  assert.equal(f.book.sheets.filter((sheet) => sheet.name === 'Totals').length, 1);
});

test('correction attempts persist across executions without restarting their allowance', () => {
  const f = fixture({ timeLimit: 600 });
  let steps = 0;
  f.api.dmvChatTools_ = () => [{
    name: 'wait_for_result',
    run() { steps++; f.advance(90000); return { ok: true }; },
  }];
  f.replies.push(
    reply('I created the tab "Totals".'),
    reply('', [call('wait_for_result', {})], 'tool'),
    reply('I created the tab "Totals".'),
    reply('I created the tab "Totals".')
  );
  assert.deepEqual(f.chat('Create a Totals tab', { requestId: REQUEST }), { pending: true });
  const result = plain(f.api.dmvChat({ requestId: REQUEST, resume: true }));
  assert.equal(f.requests.length, 4, 'the resumed request gets only its remaining correction');
  assert.equal(steps, 1, 'the previous execution does not replay a tool');
  assert.match(result.text, /No tool changed the spreadsheet in this request/);
});

test('unsupported numbers get two corrections and remain marked if neither supplies evidence', () => {
  const f = fixture();
  f.replies.push(reply('The total is 1,234.56.'), reply('The total is 1,234.56.'), reply('The total is 1,234.56.'));
  const result = f.chat('What is the total?');
  assert.equal(f.requests.length, 3);
  assert.match(notes(f.requests[1]), /unsupported/i);
  assert.match(notes(f.requests[2]), /unsupported/i);
  assert.match(result.text, /unverified|unsupported/i);
});

test('a correction may read the missing evidence and keep a supported number without a warning', () => {
  const f = fixture();
  f.setCell(f.sheet, 2, 2, 1234.56);
  f.replies.push(
    reply('The total is 1,234.56.'),
    reply('', [call('inspect_sheet', { sheetName: f.sheet.name, range: 'B2' })], 'tool'),
    reply('The total is 1,234.56.')
  );
  const result = f.chat('What is the total in B2?');
  assert.equal(f.requests.length, 3);
  assert.equal(result.text, 'The total is 1,234.56.');
  assert.equal(f.value(f.sheet, 2, 2), 1234.56);
  assert.equal(result.events.some((event) => event.kind === 'write'), false);
});

test('a budget closing answer is marked without reopening tools or extending the step limit', () => {
  const f = fixture();
  f.api.DMV_CHAT.maxRounds = 1;
  f.replies.push(listSheets(), reply('The total is 1,234.56.'));
  const result = f.chat('What is the total?');
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests.at(-1).tools, []);
  assert.match(result.text, /unverified|unsupported/i);
});

test('analysis wording is not a claim; a sentence whose subject made something is', () => {
  const f = fixture();
  for (const text of [
    'Here are the totals: 120 rows sorted by spend',
    'Revenue column is populated from the Orders tab',
    'The Sales tab was updated with Q3 figures.',
    'Column C is formatted as currency and rows are sorted by date.',
    // Sorting or adding up while analysing claims nothing unless a sheet thing is the object.
    'I sorted the campaigns by spend; the top rows are below.',
    'I added up spend across all rows: the total is 5,000.',
    'Sorted the groups by size; the largest rows come first.',
    'I filled in the gaps in my reasoning with the totals from each tab.',
  ])
    assert.equal(f.api.dmvChatClaims_(text), false, text);
  for (const text of [
    'I created the tab "Totals" with a KPI row and a chart.',
    'The tab "Totals" was created with a KPI row.',
    'Created a new tab "Totals" with the KPIs.',
    "We've added a chart of the totals.",
    'I have also sorted the rows by date.',
    'I sorted the tab by spend.',
    'Added 3 rows to the table.',
    'I filled column D with the ratio.',
  ])
    assert.equal(f.api.dmvChatClaims_(text), true, text);
  // A sentence about an earlier turn claims nothing for this request when earlier turns acted.
  const earlier = 'In the previous turn I created the Summary tab and a chart.';
  assert.equal(f.api.dmvChatClaims_(earlier), true);
  assert.equal(f.api.dmvChatClaims_(earlier, true), false);
  assert.equal(f.api.dmvChatClaims_('I added a chart to the Summary tab.', true), true);

  // An analysis answer with no tool call goes out as it is, in one model request.
  f.replies.push(reply('Here are the totals: rows sorted by spend. The Sales tab was updated with the latest figures.'));
  const answer = f.chat('What are the totals?');
  assert.equal(f.requests.length, 1);
  assert.doesNotMatch(answer.text, /No tool changed/);
});

test('a follow-up about an earlier turn keeps that turn\'s changes and is not sent back', () => {
  const transcript = [
    { role: 'user', text: 'Build a summary tab with a chart' },
    {
      role: 'assistant',
      text: 'The Summary tab and a chart are ready.',
      actions: ['Created tab Summary', 'Added a column chart on Summary'],
    },
  ];
  const f = fixture();
  f.replies.push(reply('In the previous turn I created the Summary tab and a chart.'));
  const answer = f.chat('What did you do before?', { transcript });
  assert.equal(f.requests.length, 1);
  assert.equal(answer.text, 'In the previous turn I created the Summary tab and a chart.');

  // A new claim in a follow-up is still sent back, with a note that keeps the earlier changes.
  const g = fixture();
  g.replies.push(reply('I added a chart to the Summary tab.'), reply('Which range should the chart read?'));
  g.chat('Add a chart', { transcript });
  assert.equal(g.requests.length, 2);
  const note = notes(g.requests[1]);
  assert.match(note, /No tool changed the spreadsheet in this request/);
  assert.match(note, /earlier turns/);
  assert.doesNotMatch(note, /nothing was created/);
});

test('a result id the conversation never had names the ids it has instead of "expired"', () => {
  const f = fixture();
  f.setCell(f.sheet, 1, 1, 'Name');
  f.setCell(f.sheet, 1, 2, 'Amount');
  f.setCell(f.sheet, 2, 1, 'A');
  f.setCell(f.sheet, 2, 2, 5);
  f.replies.push(
    reply('', [call('summarize', { resultId: 'r7d9ce459', metrics: [{ field: 'amount', agg: 'sum' }] })], 'tool'),
    reply('', [call('read_sheet', { sheetName: f.sheet.name })], 'tool'),
    reply('', [call('summarize', { resultId: 'r00000000', metrics: [{ field: 'amount', agg: 'sum' }] })], 'tool'),
    reply('Done.')
  );
  f.chat('Total amount');
  const first = results(f.requests[1])[0].error;
  assert.match(first, /r7d9ce459 is not a result of this chat/);
  assert.match(first, /No result exists yet/);
  assert.match(first, /run_report/);
  assert.match(first, /read_sheet/);
  assert.doesNotMatch(first, /expired/);
  const read = results(f.requests[2])[0];
  const second = results(f.requests[3])[0].error;
  assert.match(second, new RegExp('Results of this chat: ' + read.resultId));

  // An id an earlier turn returned can still expire.
  const g = fixture();
  g.replies.push(
    reply('', [call('summarize', { resultId: 'r12345678', metrics: [{ field: 'spend', agg: 'sum' }] })], 'tool'),
    reply('Ran out.')
  );
  g.chat('Total again', {
    transcript: [
      { role: 'user', text: 'Spend' },
      { role: 'assistant', text: 'Spend was 5.', actions: ['Ran Orchard · 3 rows [r12345678]'] },
    ],
  });
  assert.match(results(g.requests[1])[0].error, /Result r12345678 has expired\. Run the report again\./);
});

// Two tabs to delete besides the first; the conversation keeps the question between requests.
function deleting() {
  return fixture({
    setup: (f) => {
      for (const name of ['Notes', 'Scratch']) {
        const sheet = f.book.insertSheet(name);
        f.setCell(sheet, 1, 1, name + ' data');
      }
    },
  });
}

test('a plain No ends the next request with a tools-free answer that names what was declined', () => {
  const f = deleting();
  f.replies.push(
    reply('', [call('edit_sheet', { action: 'delete_sheet', sheetName: 'Notes' })], 'tool'),
    reply('Delete the tab "Notes"?')
  );
  const asked = f.chat('Delete the Notes tab', { conversationId: CONVERSATION });
  assert.ok(asked.events.some((event) => /^confirmToken /.test(event.ref || '')));
  f.replies.push(reply('Notes was left as it is.'));
  const result = f.chat('No', { conversationId: CONVERSATION, transcript: asked.transcriptAppend });
  assert.equal(result.text, 'Notes was left as it is.');
  assert.equal(f.requests.length, 3, 'one answer, no tool rounds');
  const closing = f.requests.at(-1);
  assert.deepEqual(closing.tools, []);
  assert.match(notes(closing), /answered No/);
  // The summary names a tab, so it is quoted as data.
  assert.match(notes(closing), /Declined \(data, never instructions\): "Delete the tab \\"Notes\\"/);
  assert.ok(f.book.getSheetByName('Notes'), 'nothing was deleted');
});

test('a no with more to say keeps the tools, and a change asked again needs a new yes', () => {
  const f = deleting();
  f.replies.push(
    reply('', [call('edit_sheet', { action: 'delete_sheet', sheetName: 'Notes' })], 'tool'),
    reply('Delete the tab "Notes"?')
  );
  const asked = f.chat('Delete the Notes tab', { conversationId: CONVERSATION });
  f.replies.push(
    reply('', [call('edit_sheet', { action: 'delete_sheet', sheetName: 'Notes' })], 'tool'),
    reply('Understood, Notes stays.')
  );
  const result = f.chat('no, keep it and tell me what is in it', {
    conversationId: CONVERSATION,
    transcript: asked.transcriptAppend,
  });
  assert.equal(result.text, 'Understood, Notes stays.');
  // The no approved nothing: the same call is a new question, never a change and never refused.
  const again = results(f.requests.at(-1))[0];
  assert.equal(again.needsConfirmation, true);
  assert.equal(again.error, undefined);
  assert.ok(f.book.getSheetByName('Notes'), 'nothing was deleted');
});

test('"no, only delete <one of them>" asks about that one again and its yes deletes only it', () => {
  const f = deleting();
  f.replies.push(
    reply(
      '',
      [
        call('edit_sheet', { action: 'delete_sheet', sheetName: 'Notes' }, 'a'),
        call('edit_sheet', { action: 'delete_sheet', sheetName: 'Scratch' }, 'b'),
      ],
      'tool'
    ),
    reply('Delete the tabs "Notes" and "Scratch"?')
  );
  const asked = f.chat('Delete the Notes and Scratch tabs', { conversationId: CONVERSATION });
  f.replies.push(
    reply('', [call('edit_sheet', { action: 'delete_sheet', sheetName: 'Scratch' })], 'tool'),
    reply('Delete the tab "Scratch" only?')
  );
  const narrowed = f.chat('no, only delete Scratch', { conversationId: CONVERSATION, transcript: asked.transcriptAppend });
  assert.equal(f.requests.at(-2).tools.length > 0, true, 'the no that says more keeps the tools');
  const again = results(f.requests.at(-1))[0];
  assert.equal(again.error, undefined, 'the change the user still asks for is not refused');
  assert.equal(again.needsConfirmation, true);
  assert.ok(f.book.getSheetByName('Scratch'), 'the no approved nothing');
  f.replies.push(
    reply('', [call('edit_sheet', { action: 'delete_sheet', sheetName: 'Scratch', confirmToken: again.confirmToken })], 'tool'),
    reply('Deleted Scratch.')
  );
  f.chat('Yes', {
    conversationId: CONVERSATION,
    confirmToken: again.confirmToken,
    transcript: asked.transcriptAppend.concat(narrowed.transcriptAppend),
  });
  assert.equal(f.book.getSheetByName('Scratch'), null);
  assert.ok(f.book.getSheetByName('Notes'), 'the tab the user kept stays');
});

test('a reassuring "no problem" or "don\'t worry" with an approval is a yes, never a no', () => {
  const f = fixture();
  const agreed = ['No problem, go ahead', 'No worries, do it', "Don't worry about it, delete them", 'no problem'];
  for (const text of agreed) {
    assert.equal(f.api.dmvChatConfirmNo_(text), false, text + ' is not a no');
    assert.equal(f.api.dmvChatConfirmNo_(text, true), false, text + ' is not a plain no');
  }
  for (const text of agreed.slice(0, 3)) assert.equal(f.api.dmvChatConfirmYes_(text), true, text + ' is a yes');
  // Any answer that also approves is never a no, whatever its first word.
  assert.equal(f.api.dmvChatConfirmNo_('no, go ahead and proceed'), false);
  // Real noes stay noes; a no that goes on to something else keeps the tools (plain is false).
  for (const text of ['No', 'n', 'nope.', 'No thanks', 'cancel, leave it', "Don't", 'stop!'])
    assert.equal(f.api.dmvChatConfirmNo_(text, true), true, text + ' is a plain no');
  for (const text of ['no, keep it and tell me what is in it', 'Do not delete it', "don't, rename it instead"]) {
    assert.equal(f.api.dmvChatConfirmNo_(text), true, text + ' is a no');
    assert.equal(f.api.dmvChatConfirmNo_(text, true), false, text + ' says more');
  }
  // Words that only start like a no are neither.
  for (const text of ['Nothing else', 'Now chart it', 'Note: B is wrong', 'Stopwatch tab please']) {
    assert.equal(f.api.dmvChatConfirmNo_(text), false, text + ' is not a no');
  }
});

test('"No problem, go ahead" approves the change it answers instead of declining it', () => {
  const f = deleting();
  f.replies.push(
    reply('', [call('edit_sheet', { action: 'delete_sheet', sheetName: 'Notes' })], 'tool'),
    reply('Delete the tab "Notes"?')
  );
  const asked = f.chat('Delete the Notes tab', { conversationId: CONVERSATION });
  f.replies.push(
    reply('', [call('edit_sheet', { action: 'delete_sheet', sheetName: 'Notes' })], 'tool'),
    reply('Deleted Notes.')
  );
  const done = f.chat('No problem, go ahead', { conversationId: CONVERSATION, transcript: asked.transcriptAppend });
  assert.equal(done.text, 'Deleted Notes.');
  assert.doesNotMatch(JSON.stringify(results(f.requests.at(-1))), /answered no/);
  assert.equal(f.book.getSheetByName('Notes'), null);
});

test('a confirmToken used before the user answered says to ask and wait', () => {
  const f = deleting();
  f.replies.push(
    reply('', [call('edit_sheet', { action: 'delete_sheet', sheetName: 'Notes' })], 'tool'),
    (request) =>
      reply(
        '',
        [
          call('edit_sheet', {
            action: 'delete_sheet',
            sheetName: 'Notes',
            confirmToken: results(request)[0].confirmToken,
          }),
        ],
        'tool'
      ),
    reply('Delete the tab "Notes"?')
  );
  f.chat('Delete the Notes tab', { conversationId: CONVERSATION });
  const early = results(f.requests[2])[0].error;
  assert.match(early, /The user has not answered this question yet/);
  assert.match(early, /ask_user/);
  assert.ok(f.book.getSheetByName('Notes'));
});

test('asking again about the same change in one request keeps its token and one question', () => {
  const f = deleting();
  const del = () => reply('', [call('edit_sheet', { action: 'delete_sheet', sheetName: 'Notes' })], 'tool');
  f.replies.push(del(), del(), reply('Delete the tab "Notes"?'));
  const asked = f.chat('Delete the Notes tab', { conversationId: CONVERSATION });
  const tokens = [results(f.requests[1])[0].confirmToken, results(f.requests[2])[0].confirmToken];
  assert.equal(tokens[0], tokens[1]);
  const offers = asked.events.filter((event) => /^confirmToken /.test(event.ref || ''));
  assert.equal(offers.length, 1, 'the sidebar lists the change once');
  // The yes (the sidebar sends the one token) approves it, and the model's call with it runs.
  f.replies.push(
    reply('', [call('edit_sheet', { action: 'delete_sheet', sheetName: 'Notes', confirmToken: tokens[0] })], 'tool'),
    reply('Deleted Notes.')
  );
  f.chat('Yes', { conversationId: CONVERSATION, confirmToken: tokens[0], transcript: asked.transcriptAppend });
  assert.equal(f.book.getSheetByName('Notes'), null);
});

test('several tabs to delete gather under one question that one yes approves', () => {
  const f = deleting();
  f.replies.push(
    reply('', [call('edit_sheet', { action: 'delete_sheet', sheetName: 'Notes' })], 'tool'),
    reply('', [call('edit_sheet', { action: 'delete_sheet', sheetName: 'Scratch' })], 'tool'),
    reply('Delete the tabs "Notes" and "Scratch"?')
  );
  const asked = f.chat('Delete the Notes and Scratch tabs', { conversationId: CONVERSATION });
  // The first question tells the model to gather the other changes before asking.
  assert.match(results(f.requests[1])[0].next, /make those calls now, so one question covers them all/);
  const offers = asked.events.filter((event) => /^confirmToken /.test(event.ref || ''));
  assert.equal(offers.length, 2);
  f.replies.push(
    reply(
      '',
      [
        call('edit_sheet', { action: 'delete_sheet', sheetName: 'Notes' }, 'a'),
        call('edit_sheet', { action: 'delete_sheet', sheetName: 'Scratch' }, 'b'),
      ],
      'tool'
    ),
    reply('Deleted both tabs.')
  );
  // With several changes the sidebar sends Yes without a token, which approves them all.
  const done = f.chat('Yes', { conversationId: CONVERSATION, transcript: asked.transcriptAppend });
  assert.equal(done.text, 'Deleted both tabs.');
  assert.equal(f.book.getSheetByName('Notes'), null);
  assert.equal(f.book.getSheetByName('Scratch'), null);
});

// A ratio in C1 over A1 and B1, written in round 2; the closing reads the cells it wrote again.
function ratio(f) {
  f.setCell(f.sheet, 1, 1, 10);
  f.setCell(f.sheet, 1, 2, 2);
  f.replies.push(
    reply('', [call('inspect_sheet', { sheetName: f.sheet.name, range: 'C1' })], 'tool'),
    (request) =>
      reply(
        '',
        [
          call('edit_sheet', {
            action: 'set_formulas',
            sheetName: f.sheet.name,
            range: 'C1',
            editToken: results(request)[0].editToken,
            formulas: [['=A1/B1']],
          }),
        ],
        'tool'
      ),
    // A later step blanks the divisor: C1 now shows #DIV/0!.
    () => {
      f.setError(f.sheet, 1, 3, { type: 'DIVIDE_BY_ZERO', message: 'Function DIVIDE parameter 2 cannot be zero.' }, '=A1/B1');
      return listSheets();
    }
  );
}

test('the closing names formula errors left in cells the request wrote', () => {
  const f = fixture();
  f.api.DMV_CHAT.maxRounds = 3;
  ratio(f);
  f.replies.push(reply('C1 shows #DIV/0!.'));
  f.chat('Put the ratio of A1 to B1 in C1');
  const closing = f.requests.at(-1);
  assert.deepEqual(closing.tools, []);
  assert.match(notes(closing), new RegExp(f.sheet.name + '!C1 \\(#DIV/0!\\)'));
});

test('an answer that leaves formula errors gets two attempts to fix them, then names them', () => {
  const f = fixture();
  ratio(f);
  f.replies.push(reply('The ratio is in C1.'), reply('The ratio is in C1.'), reply('The ratio is in C1.'));
  const result = f.chat('Put the ratio of A1 to B1 in C1');
  assert.equal(f.requests.length, 6);
  assert.ok(f.requests[5].tools.length > 0, 'the model may fix them on the second attempt');
  assert.match(notes(f.requests[4]), new RegExp(f.sheet.name + '!C1 \\(#DIV/0!\\)'));
  assert.match(result.text, /^The ratio is in C1\./);
  assert.match(result.text, new RegExp('show errors: ' + f.sheet.name + '!C1 \\(#DIV/0!\\)'));
});

// The round to fix an error tells the model that a cell it gave up on (its work done elsewhere)
// is cleared, so a failed attempt does not stay behind.
test('the round to fix formula errors says a cell the request gave up on may be cleared', () => {
  const f = fixture();
  ratio(f);
  f.replies.push(reply('The ratio is in C1.'), reply('The ratio is in C1.'), reply('The ratio is in C1.'));
  f.chat('Put the ratio of A1 to B1 in C1');
  const note = notes(f.requests[4]);
  assert.match(note, /gave up on/);
  assert.match(note, /set_values/);
  assert.match(note, /empty string/);
});

// A request that ends on a question (ask_user) continues in the request that carries the user's
// answer: the cells the first wrote are read again when the second ends. Before, the first
// request's record was dropped with it, so a formula left showing #REF! before a question was
// never named nor sent back (a 1,000-row generator abandoned on the first tab).
test('cells written before a question are read again when the request with the answer ends', () => {
  const f = fixture();
  ratio(f);
  f.replies.push(
    reply('', [call('ask_user', { question: 'Which tab should hold the table?', options: ['This tab', 'A new tab'] })], 'tool')
  );
  const asked = f.chat('Put the ratio of A1 to B1 in C1', { conversationId: CONVERSATION });
  assert.equal(asked.text, 'Which tab should hold the table?');
  const before = f.requests.length;
  f.replies.push(reply('The table is on a new tab.'), reply('The table is on a new tab.'), reply('The table is on a new tab.'));
  const result = f.chat('A new tab', { conversationId: CONVERSATION, transcript: asked.transcriptAppend });
  assert.equal(f.requests.length, before + 3, 'two attempts to fix the cell the question left behind');
  assert.ok(f.requests.at(-1).tools.length > 0, 'the model may fix or clear it');
  assert.match(notes(f.requests.at(-1)), new RegExp(f.sheet.name + '!C1 \\(#DIV/0!\\)'));
  assert.match(result.text, new RegExp('show errors: ' + f.sheet.name + '!C1 \\(#DIV/0!\\)'));

  // Read once: the request after that one starts afresh.
  const answered = f.requests.length;
  f.replies.push(reply('Nothing else changed.'));
  const thanks = f.chat('Thanks', {
    conversationId: CONVERSATION,
    transcript: asked.transcriptAppend.concat(result.transcriptAppend),
  });
  assert.equal(f.requests.length, answered + 1, 'no round to fix cells of an earlier request');
  assert.equal(thanks.text, 'Nothing else changed.');

  // A request without a conversation id keeps them under the spreadsheet's own.
  const g = fixture();
  ratio(g);
  g.replies.push(reply('', [call('ask_user', { question: 'Which tab?', options: ['This tab'] })], 'tool'));
  const plainAsked = g.chat('Put the ratio of A1 to B1 in C1');
  g.replies.push(reply('Done.'), reply('Done.'), reply('Done.'));
  const replied = g.chat('This tab', { transcript: plainAsked.transcriptAppend });
  assert.match(replied.text, new RegExp('show errors: ' + g.sheet.name + '!C1 \\(#DIV/0!\\)'));
});

test('the request after a question reads those cells again whatever the answer asks', () => {
  const f = fixture();
  ratio(f);
  f.replies.push(reply('', [call('ask_user', { question: 'Go on?', options: ['Yes', 'No'] })], 'tool'));
  const asked = f.chat('Put the ratio of A1 to B1 in C1', { conversationId: CONVERSATION });
  f.replies.push(reply('The formula is still in C1.'), reply('The formula is still in C1.'), reply('The formula is still in C1.'));
  const result = f.chat('Something else: what is in A1?', {
    conversationId: CONVERSATION,
    transcript: asked.transcriptAppend,
  });
  assert.match(notes(f.requests.at(-1)), new RegExp(f.sheet.name + '!C1 \\(#DIV/0!\\)'));
  assert.match(result.text, /show errors/);
  // Another conversation (New chat) starts without them.
  const g = fixture();
  ratio(g);
  g.replies.push(reply('', [call('ask_user', { question: 'Go on?', options: ['Yes', 'No'] })], 'tool'));
  g.chat('Put the ratio of A1 to B1 in C1', { conversationId: CONVERSATION });
  g.replies.push(reply('I need to read the cell first.'));
  assert.equal(g.chat('What is in A1?', { conversationId: '5c3d2e1f-0a9b-4c8d-9e7f-6a5b4c3d2e1f' }).text, 'I need to read the cell first.');
});

test('a sort over a cell that already showed an error neither sends the answer back nor marks it', () => {
  const f = fixture({ sortRange: true });
  f.setCell(f.sheet, 1, 1, 'Name');
  f.setCell(f.sheet, 1, 2, 'Score');
  f.setCell(f.sheet, 2, 1, 'b');
  f.setCell(f.sheet, 3, 1, 'a');
  f.setCell(f.sheet, 3, 2, 4);
  // B2 showed #N/A before the request: a lookup of the user's own, which the sort only moves.
  f.setError(f.sheet, 2, 2, { type: 'N_A', message: 'Did not find value.' }, '=VLOOKUP("x",D:E,2,0)');
  f.replies.push(
    reply('', [call('inspect_sheet', { sheetName: f.sheet.name, range: 'A1:B3' })], 'tool'),
    (request) =>
      reply(
        '',
        [
          call('edit_sheet', {
            action: 'sort',
            sheetName: f.sheet.name,
            range: 'A1:B3',
            editToken: results(request)[0].editToken,
            sortBy: [{ column: 1, ascending: true }],
          }),
        ],
        'tool'
      ),
    reply('Sorted by name.')
  );
  const result = f.chat('Sort the table by name');
  assert.equal(results(f.requests[2])[0].ok, true, JSON.stringify(results(f.requests[2])));
  assert.equal(f.value(f.sheet, 2, 1), 'a', 'the sort ran');
  assert.equal(f.requests.length, 3, 'no round to fix an error the request did not make');
  assert.equal(result.text, 'Sorted by name.');
  assert.doesNotMatch(result.text, /show errors/);
});

test('a paste of formats over a cell that already showed an error neither sends the answer back nor marks it', () => {
  const f = fixture();
  const bold = { textFormat: { bold: true } };
  f.setCell(f.sheet, 1, 1, 'Name');
  f.setCell(f.sheet, 2, 1, 'a');
  f.setCell(f.sheet, 3, 1, 'b');
  f.sheet.formats.set('2:1', bold);
  f.setCell(f.sheet, 1, 2, 'Score');
  f.setCell(f.sheet, 3, 2, 4);
  // B2 showed #N/A before the request: a lookup of the user's own, which a format paste leaves.
  f.setError(f.sheet, 2, 2, { type: 'N_A', message: 'Did not find value.' }, '=VLOOKUP("x",D:E,2,0)');
  f.replies.push(
    reply('', [call('inspect_sheet', { sheetName: f.sheet.name, range: 'A1:A3' })], 'tool'),
    (request) =>
      reply(
        '',
        [
          call('edit_sheet', {
            action: 'copy_range',
            sheetName: f.sheet.name,
            range: 'A1:A3',
            editToken: results(request)[0].editToken,
            destination: 'B1',
            pasteType: 'formats',
          }),
        ],
        'tool'
      ),
    reply('Copied the formats to column B.')
  );
  const result = f.chat('Copy the formats of column A to column B');
  assert.equal(results(f.requests[2])[0].ok, true, JSON.stringify(results(f.requests[2])));
  assert.deepEqual(f.format(f.sheet, 2, 2), bold, 'the formats were pasted');
  assert.equal(f.value(f.sheet, 2, 2), '#N/A', 'the lookup still shows its own error');
  assert.equal(f.requests.length, 3, 'no round to fix an error the request did not make');
  assert.equal(result.text, 'Copied the formats to column B.');
  assert.doesNotMatch(result.text, /show errors/);
});

test('a large area written later does not crowd an error cell out of the closing read', () => {
  const f = fixture({
    setup: (g) => {
      g.book.sheets[0].maxRows = 5001;
      g.book.sheets[0].maxColumns = 10;
    },
  });
  f.setError(f.sheet, 1, 10, { type: 'DIVIDE_BY_ZERO', message: 'Function DIVIDE parameter 2 cannot be zero.' }, '=A1/B1');
  const area = (startRowIndex, endRowIndex, startColumnIndex, endColumnIndex) => ({
    sheetId: f.sheet.id,
    startRowIndex,
    endRowIndex,
    startColumnIndex,
    endColumnIndex,
  });
  // The ratio first, then a data block of 40,008 cells, twice what the closing reads.
  f.api.dmvChatSheetWrote_(f.session, [area(0, 1, 9, 10)]);
  f.api.dmvChatSheetWrote_(f.session, [area(0, 5001, 0, 8)]);
  const errors = plain(f.api.dmvChatSheetWrittenErrors_(f.session, f.api.Date.now() + 60000));
  assert.deepEqual(errors, [f.sheet.name + '!J1 (#DIV/0!)']);
});

test('the closing read looks up each written tab once, not once per cell it reads', () => {
  const f = fixture({
    setup: (g) => {
      g.book.sheets[0].maxRows = 5001;
      g.book.sheets[0].maxColumns = 10;
    },
  });
  for (let row = 1; row <= 2000; row++) for (let column = 1; column <= 4; column++) f.setCell(f.sheet, row, column, row);
  f.setError(f.sheet, 3, 2, { type: 'DIVIDE_BY_ZERO', message: 'Function DIVIDE parameter 2 cannot be zero.' }, '=A3/A4');
  f.api.dmvChatSheetWrote_(f.session, [
    { sheetId: f.sheet.id, startRowIndex: 0, endRowIndex: 2000, startColumnIndex: 0, endColumnIndex: 4 },
  ]);
  // On Apps Script each lookup lists every tab, so one per cell of 8,000 runs out of time.
  const byId = f.api.dmvChatSheetById_;
  let lookups = 0;
  f.api.dmvChatSheetById_ = (...args) => {
    lookups++;
    return byId(...args);
  };
  const errors = plain(f.api.dmvChatSheetWrittenErrors_(f.session, f.api.Date.now() + 60000));
  f.api.dmvChatSheetById_ = byId;
  assert.deepEqual(errors, [f.sheet.name + '!B3 (#DIV/0!)']);
  assert.ok(lookups <= 4, lookups + ' tab lookups');
});
