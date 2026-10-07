import test from 'node:test';
import assert from 'node:assert/strict';
import { chatSheetFixture } from './helpers/chat-sheet-fixture.mjs';
import { plain } from './helpers/datamoov-sandbox.mjs';

const successful = (value, call = { name: 'summarize', input: {} }, extra = {}) => [
  { role: 'assistant', content: [{ type: 'tool_use', id: 'review-result', ...call }] },
  {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'review-result',
        content: JSON.stringify(value),
        ...extra,
      },
    ],
  },
];
const review = (f, answer, messages = [], until = f.api.Date.now() + 30000) => {
  const result = f.api.dmvChatReview_(f.session, answer, messages, until);
  return result ? plain(result) : null;
};

test('numeric review grounds grouped money, rounded decimals, percentages, negatives and small counts', () => {
  const f = chatSheetFixture();
  const messages = successful({
    totals: { amount: 1234.5, share: 0.25, change: -4, count: 2, mean: 1.234 },
  });
  assert.equal(
    review(f, 'The total is $1,234.50; share 25%; change -4; 2 groups; mean 1.23.', messages),
    null
  );
  assert.equal(f.state.cellsRead, 0);
  assert.equal(review(f, 'About 1.2k overall.', successful({ total: 1234 })), null);
  assert.match(review(f, 'There are 3 groups.', messages).mark, /Unverified numbers: 3/);
  assert.match(review(f, 'The share is 25%.', successful({ count: 25 })).mark, /25%/);
  assert.match(review(f, 'There are 1 groups.', successful({ mean: 1.4 })).mark, /numbers: 1/);
  assert.match(review(f, 'The result is 1.20.', successful({ mean: 1.2051 })).mark, /1\.20/);
});

test('syntax digits, dates, URLs, result IDs and list numbering are not quoted numeric facts', () => {
  const f = chatSheetFixture();
  assert.equal(
    review(
      f,
      '1. Open A1:B20 on 2026-10-07.\n2) See [the tab](https://example.com/123?gid=456), result r123abc, `=SUM(A1:A20)+7`.'
    ),
    null
  );
  assert.equal(f.state.cellsRead, 0);
  assert.equal(review(f, 'C1 shows #DIV/0!; D1 shows #N/A.'), null);
});

test('currency claims are checked, including locale separators, compact notation and accounting negatives', () => {
  const f = chatSheetFixture();
  for (const answer of [
    '$123.45 total.',
    'USD 123.45 total.',
    '\u20ac1.234,56 total.',
    '1 234 rows.',
    '1.234 rows.',
    '(\u00a3123.45) change.',
  ]) {
    assert.equal(review(f, answer).numeric, true, answer);
  }
  const messages = successful({ total: 1234.56, count: 1234, change: -123.45, share: 0.25 });
  for (const answer of [
    '\u20ac1.234,56 total.',
    '1 234 rows.',
    '1.234 rows.',
    '(\u00a3123.45) change.',
    'Share 25 PERCENT.',
  ])
    assert.equal(review(f, answer, messages), null, answer);
  assert.equal(review(f, 'The decimal is 1.234.', successful({ value: 1.234 })), null);
  assert.match(review(f, 'The decimal is 1.234.', successful({ value: 1234 })).mark, /1\.234/);
  assert.equal(
    review(f, '| 1 | 234 |').numeric,
    true,
    'separate table cells are not merged as grouped digits'
  );
});

test('integer currency allows only its displayed half-unit rounding while integer counts remain exact', () => {
  const f = chatSheetFixture();
  const messages = successful({ total: 533639.82 });
  assert.equal(review(f, '$533,640 total.', messages), null);
  assert.equal(review(f, 'USD 533,640 total.', messages), null);
  assert.match(review(f, '533,640 customers.', messages).mark, /533,640/);
  assert.match(review(f, '$533,641 total.', messages).mark, /533,641/);
});

test('readable calendar dates are syntax and period lengths require successful period evidence', () => {
  const f = chatSheetFixture();
  assert.equal(review(f, 'For the week of 31 August, compared with September 7, 2026.'), null);
  assert.equal(
    review(
      f,
      'For the last 7 days.',
      successful({ dateRange: { startDate: '2026-09-01', endDate: '2026-09-07' }, periodDays: 7 })
    ),
    null
  );
  assert.match(review(f, 'For the last 7 days.', successful({ periodDays: 30 })).mark, /7/);
});

test('explicit calendar years and year ranges are syntax while a four-digit row count remains a fact', () => {
  const f = chatSheetFixture();
  for (const answer of [
    'Calendar year 2025.',
    'Year 2026.',
    'January 2025.',
    'Years 2025\u20132026.',
    'Date range 2025-2026.',
    'FY2025.',
    '2026-10.',
  ])
    assert.equal(review(f, answer), null, answer);
  assert.match(review(f, '2025 rows.').mark, /2025/);
  assert.equal(review(f, '2025 rows.', successful({ rowCount: 2025 })), null);
});

test('decline phrasing grounds negative changes without accepting the opposite direction', () => {
  const f = chatSheetFixture();
  const messages = successful({ percentageChange: -0.12, absoluteChange: -10 });
  assert.equal(review(f, 'It fell by 12% and decreased by 10.', messages), null);
  assert.equal(review(f, 'A 12% decline and a drop of 10.', messages), null);
  assert.match(review(f, 'It increased by 12%.', messages).mark, /12%/);
  assert.match(review(f, 'It rose by 10.', messages).mark, /10/);
});

test('ordinary parentheses keep counts and percentages positive; currency accounting parentheses are negative', () => {
  const f = chatSheetFixture();
  assert.equal(
    review(
      f,
      'The group (20 rows) represents the total (92.4%).',
      successful({ rows: 20, share: 0.924 })
    ),
    null
  );
  assert.equal(review(f, 'The change was ($20.00).', successful({ change: -20 })), null);
  assert.match(review(f, 'The group (20 rows).', successful({ rows: -20 })).mark, /20/);
});

test('numeric claims beyond the bounded parser limit are explicitly marked unverified', () => {
  const f = chatSheetFixture();
  const values = Array.from({ length: f.api.DMV_CHAT_REVIEW.claims + 1 }, (_, index) => index + 1);
  const result = review(
    f,
    values.map((value) => `Value is ${value}.`).join(' '),
    successful({ values })
  );
  assert.equal(result.numeric, true);
  assert.match(result.mark, /Additional numbers.*could not be verified/);
});

test('proposed inputs, user messages, model prose, errors and confirmations are excluded', () => {
  const f = chatSheetFixture();
  const messages = [
    { role: 'user', content: 'Please write 123 rows.' },
    { role: 'assistant', content: [{ type: 'text', text: 'Wrote 123 rows.' }] },
    ...successful(
      { error: 'Failed to write 123 rows.', rows: 123 },
      { name: 'edit_sheet', input: { rows: 123 } }
    ),
    ...successful({ rows: 123 }, undefined, { is_error: true }),
    ...successful({ rows: 123, needsConfirmation: true }),
  ];
  assert.match(
    review(f, 'Wrote 123 rows.', messages).note,
    /These numbers in the answer are unsupported/
  );
  assert.equal(f.state.cellsRead, 0);
});

test('successful counts are evidence but numeric identifiers and positional metadata are excluded', () => {
  const f = chatSheetFixture();
  const messages = successful({
    spreadsheetId: '123456',
    sheetId: 42,
    index: 9,
    createdAt: 111,
    checksum: '88888',
    range: 'A1:C999',
    rowCount: 17,
  });
  assert.equal(review(f, '17 rows.', messages), null);
  for (const number of [123456, 42, 9, 111, 88888, 999])
    assert.match(review(f, `${number} rows.`, messages).mark, /Unverified numbers/);
});

test('metric names ending in id remain facts while structured identifier suffixes are excluded', () => {
  const f = chatSheetFixture();
  const messages = successful({
    stats: { amount_paid: { sum: 123 }, valid: { count: 7 } },
    ID: 88,
    source_id: 99,
    accountId: 55,
  });
  assert.equal(review(f, '123 overall; 7 valid.', messages), null);
  for (const value of [88, 99, 55])
    assert.match(review(f, `${value} total.`, messages).mark, /Unverified numbers/);
});

test('legitimate metric names containing metadata words remain successful numeric evidence', () => {
  const f = chatSheetFixture();
  const messages = successful({
    avg_duration: 123.45,
    range_percentile: 8.5,
    named_metric: 9.5,
    columns: [{ key: 'duration', type: 'number' }],
    rows: [{ duration: 22.5 }],
    apiToken: '87654',
  });
  assert.equal(
    review(f, 'Average 123.45; percentile 8.5; metric 9.5; duration 22.5.', messages),
    null
  );
  assert.match(review(f, '87654 total.', messages).mark, /87654/);
  assert.equal(f.state.cellsRead, 0);
});

test('returned query and saved configuration echoes do not supply numeric data facts', () => {
  const f = chatSheetFixture();
  const messages = successful({
    query: '8001',
    config: { amount: 8002 },
    filters: [{ value: 8003 }],
    schedule: { at: { hour: 8004 } },
    limit: 8005,
    datasets: [{ maxRows: 8006, query: '8007' }],
    tiles: [{ highlight: [{ value: 8008 }] }],
  });
  for (const value of [8001, 8002, 8003, 8004, 8005, 8006, 8007, 8008])
    assert.match(review(f, `${value} customers.`, messages).mark, /Unverified numbers/);
  const typed = successful({
    columns: ['query', 'config', 'limit'].map((key) => ({ key, type: 'number' })),
    rows: [{ query: 123.45, config: 234.56, limit: 345.67 }],
    stats: { query: { sum: 123.45 } },
  });
  assert.equal(review(f, 'Values are 123.45, 234.56 and 345.67.', typed), null);
});

test('successful sample values and totals count as facts, excluding date-typed fields', () => {
  const f = chatSheetFixture();
  const messages = successful({
    columns: [
      { key: 'day', type: 'date' },
      { key: 'metric', type: 'number' },
    ],
    sample_rows: [{ day: 46000, metric: 7 }],
    stats: { metric: { min: 3, max: 8 } },
  });
  assert.equal(review(f, 'The observed sample holds 7; range 3 to 8.', messages), null);
  assert.match(review(f, '46000 total.', messages).mark, /46000/);
});

test('rereads written cells when successful summaries do not contain a claim', () => {
  const f = chatSheetFixture();
  f.setCell(f.sheet, 1, 1, 734.25, '=SUM(B1:B2)');
  f.session.wrote = [
    {
      sheetId: f.sheet.id,
      startRowIndex: 0,
      endRowIndex: 1,
      startColumnIndex: 0,
      endColumnIndex: 1,
    },
  ];
  const deadline = f.session.deadline;
  assert.equal(review(f, 'The total is $734.25.'), null);
  assert.equal(f.state.cellsRead, 1);
  assert.equal(f.session.deadline, deadline);
  f.setCell(f.sheet, 1, 1, 800, '=SUM(B1:B2)');
  assert.match(review(f, 'The total is $734.25.').mark, /734\.25/);
});

test('freshly displayed rounded numeric cells support the visible figure alongside their raw value', () => {
  const f = chatSheetFixture();
  f.setCell(f.sheet, 1, 1, 533639.82);
  f.setMeta(f.sheet, 1, 1, {
    formattedValue: '533,640',
    effectiveFormat: { numberFormat: { type: 'NUMBER', pattern: '#,##0' } },
  });
  f.session.wrote = [
    {
      sheetId: f.sheet.id,
      startRowIndex: 0,
      endRowIndex: 1,
      startColumnIndex: 0,
      endColumnIndex: 1,
    },
  ];
  assert.equal(review(f, 'The total is 533,640.'), null);
  assert.equal(f.state.cellsRead, 1);
  f.setCell(f.sheet, 1, 1, 0.924);
  f.setMeta(f.sheet, 1, 1, {
    formattedValue: '92.4%',
    effectiveFormat: { numberFormat: { type: 'PERCENT', pattern: '0.0%' } },
  });
  assert.equal(review(f, 'The share is 92.4%.'), null);
  assert.match(review(f, '92.4 customers.').mark, /92\.4/);
});

test('successful search positions are separate from metric facts, including an empty inspected range', () => {
  const f = chatSheetFixture({
    setup: (fixture) => {
      fixture.sheet.name = 'Orders';
      fixture.sheet.maxRows = 8005;
      fixture.setCell(fixture.sheet, 8001, 1, 'final-key');
    },
  });
  const messages = [],
    tools = f.api.dmvChatTools_(f.session);
  const search = (id, input) => {
    const call = {
      type: 'tool_use',
      id,
      name: 'search_sheets',
      input: { sheetName: 'Orders', ...input },
    };
    const outcome = f.api.dmvChatRunTool_(f.session, tools, call);
    assert.equal(outcome.isError, false, outcome.content);
    messages.push(
      { role: 'assistant', content: [call] },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            id,
            name: call.name,
            content: outcome.content,
            isError: outcome.isError,
          },
        ],
      }
    );
    return JSON.parse(outcome.content);
  };
  const found = search('find-final', { query: 'final-key', range: 'A8001:A8001' });
  assert.equal(found.matches[0].cell, 'Orders!A8001');
  const empty = search('check-empty', { query: '.', regex: true, range: 'A8002:J8005' });
  assert.equal(empty.total, 0);
  assert.deepEqual(empty.ranges, [{ sheetName: 'Orders', range: 'A8002:J8005' }]);
  const before = f.state.cellsRead;
  assert.equal(review(f, 'Data ends at row 8,001 and row 8,002 is empty.', messages), null);
  assert.equal(review(f, 'Rows 8,001 to 8,002 and column 10 were checked.', messages), null);
  assert.equal(review(f, 'row8001 is present.', messages), null);
  assert.match(review(f, 'There are 8,001 customers.', messages).mark, /8,001/);
  assert.match(review(f, '$8,002 total.', messages).mark, /8,002/);
  assert.match(review(f, 'row 8006 is empty.', messages).mark, /8006/);
  assert.equal(f.state.cellsRead, before, 'structural grounding adds no cell reads');
});

test('failed search envelopes do not supply position facts or convert proposed ranges to data counts', () => {
  const f = chatSheetFixture();
  const messages = [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'failed-search',
          name: 'search_sheets',
          input: { sheetName: 'Orders', range: 'A8002:J8005' },
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          id: 'failed-search',
          name: 'search_sheets',
          content: JSON.stringify({
            error: 'Could not read range.',
            ranges: [{ sheetName: 'Orders', range: 'A8002:J8005' }],
          }),
          isError: true,
        },
      ],
    },
  ];
  assert.match(review(f, 'Row 8002 is empty.', messages).mark, /8002/);
  assert.match(review(f, '8,002 customers.', messages).mark, /8,002/);
});

test('a production empty numeric-query search does not ground its echoed query as a data count', () => {
  const f = chatSheetFixture();
  f.setCell(f.sheet, 1, 1, 'Header');
  f.setCell(f.sheet, 2, 1, 'unrelated text');
  const call = {
    type: 'tool_use',
    id: 'empty-numeric-search',
    name: 'search_sheets',
    input: { sheetName: f.sheet.name, range: 'A1:A2', query: '8001' },
  };
  const outcome = f.api.dmvChatRunTool_(f.session, f.api.dmvChatTools_(f.session), call);
  assert.equal(outcome.isError, false, outcome.content);
  assert.equal(JSON.parse(outcome.content).total, 0);
  const messages = [
    { role: 'assistant', content: [call] },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          id: call.id,
          name: call.name,
          content: outcome.content,
          isError: outcome.isError,
        },
      ],
    },
  ];
  assert.match(review(f, 'There are 8001 customers.', messages).mark, /Unverified numbers: 8001/);
  assert.equal(review(f, 'The search returned 0 matches.', messages), null);
});

test('review notes keep verification internal without changing the correction prefix', () => {
  const f = chatSheetFixture();
  const result = review(f, '123 total.');
  assert.match(result.note, /^These numbers in the answer are unsupported/);
  assert.match(
    result.note,
    /Keep verification internal; answer the original request normally\. Mention only unresolved uncertainty or unfinished work\./
  );
});

test('abbreviated unsupported lists explicitly mark the omitted figures in both correction and final text', () => {
  const f = chatSheetFixture();
  const answer = Array.from({ length: 40 }, (_, index) => `Value is ${10001 + index}.`).join(' ');
  const result = review(f, answer);
  assert.match(result.note, /^These numbers in the answer are unsupported/);
  assert.match(result.note, /abbreviated list; other unsupported figures.*verification or removal/);
  assert.match(result.mark, /^Unverified numbers:/);
  assert.match(result.mark, /Additional unsupported figures are also unverified/);
  assert.ok(result.mark.length < 500, 'the final warning stays bounded');
});

test('successful inspected ranges can supply values beyond their three-row sample', () => {
  const f = chatSheetFixture();
  f.setCell(f.sheet, 8, 1, 9123);
  const inspected = f.inspect('A1:A10');
  const before = f.state.cellsRead;
  assert.equal(
    review(
      f,
      'The value is 9123.',
      successful(inspected, {
        name: 'inspect_sheet',
        input: { sheetName: f.sheet.name, range: 'A1:A10' },
      })
    ),
    null
  );
  assert.equal(f.state.cellsRead - before, 10);
});

test('closing numeric reads share a fixed budget and never infer unseen values', () => {
  const f = chatSheetFixture();
  f.sheet.maxRows = 40000;
  f.setCell(f.sheet, 40000, 1, 999999);
  f.session.wrote = [
    {
      sheetId: f.sheet.id,
      startRowIndex: 0,
      endRowIndex: 40000,
      startColumnIndex: 0,
      endColumnIndex: 1,
    },
  ];
  assert.match(review(f, 'The total is 999999.').mark, /999999/);
  assert.equal(f.state.cellsRead, f.api.DMV_CHAT_REVIEW.cells);
  assert.ok(f.state.largestRead <= f.api.DMV_SHEET_SEARCH.requestCells);
});

test('failed and expired rereads leave a claim unverified and restore the tool deadline', () => {
  const f = chatSheetFixture();
  f.setCell(f.sheet, 1, 1, 88);
  f.session.wrote = [
    {
      sheetId: f.sheet.id,
      startRowIndex: 0,
      endRowIndex: 1,
      startColumnIndex: 0,
      endColumnIndex: 1,
    },
  ];
  const deadline = f.session.deadline;
  assert.match(review(f, '88 total.', [], f.api.Date.now() + 1).mark, /88/);
  assert.equal(f.state.cellsRead, 0);
  f.api.Sheets.Spreadsheets.get = () => {
    throw new Error('temporary read failure');
  };
  assert.match(review(f, '88 total.').mark, /88/);
  assert.equal(f.session.deadline, deadline);
});

function classifierFixture({ count = 100, high = 90 } = {}) {
  const formula = '=IF(B2>=10,"High","Low")';
  const f = chatSheetFixture({
    formulaResult: (text) => (text === formula ? [['High']] : undefined),
  });
  f.sheet.maxRows = Math.max(f.sheet.maxRows, count + 1);
  ['Key', 'Metric', 'Group'].forEach((value, column) => f.setCell(f.sheet, 1, column + 1, value));
  for (let index = 0; index < count; index++) {
    const row = index + 2,
      value = index < high ? 15 + index : 3;
    f.setCell(f.sheet, row, 1, 'key-' + index);
    f.setCell(f.sheet, row, 2, value);
    f.setCell(f.sheet, row, 3, index < high ? 'High' : 'Low', index === 0 ? formula : '');
  }
  const messages = successful(
    { ok: true, sheetName: f.sheet.name, range: 'C2', formulaErrors: [] },
    {
      name: 'edit_sheet',
      input: {
        action: 'set_formulas',
        sheetName: f.sheet.name,
        range: 'C2',
        formulas: [[formula]],
      },
    }
  );
  return { f, messages };
}

test('classifier review uses full unique-key counts, actual formula and compact numeric examples once', () => {
  const { f, messages } = classifierFixture();
  const result = review(f, 'Done.', messages);
  assert.equal(result.numeric, false);
  assert.equal(result.segments, true);
  assert.match(result.note, /"count":100/);
  assert.match(result.note, /"counts":\{"High":90,"Low":10\}/);
  assert.match(result.note, /"dominant":true/);
  assert.match(result.note, /"value":15/);
  assert.match(result.note, /quoted untrusted sheet data/);
  assert.match(result.note, /do not force balanced groups/);
  assert.doesNotMatch(result.note, /key-0/);
  assert.ok(f.state.cellsRead <= f.api.DMV_CHAT_REVIEW.cells);
  const before = f.state.cellsRead;
  f.session.reviewSegmentsSent = true;
  assert.equal(review(f, 'Done.', messages), null);
  assert.equal(f.state.cellsRead, before);
});

test('classifier boundary examples share one Sheets read without changing their evidence', () => {
  const { f, messages } = classifierFixture();
  const get = f.api.Sheets.Spreadsheets.get;
  const requests = [];
  f.api.Sheets.Spreadsheets.get = (id, options) => {
    requests.push(plain(options.ranges));
    return get(id, options);
  };
  const result = review(f, 'Done.', messages);
  assert.match(result.note, /"counts":\{"High":90,"Low":10\}/);
  for (const [cell, value] of [['B2', 15], ['B91', 104], ['B92', 3], ['B101', 3]])
    assert.ok(result.note.includes(JSON.stringify({ cell, value })));
  assert.equal(requests.length, 2, 'one full-count read and one batched example read');
  assert.equal(requests[1].length, 4);
  assert.equal(f.state.cellsRead, 206);
});

test('production tool-result envelopes discover a classifier written through the real tool pipeline', () => {
  const { f } = classifierFixture({ count: 20, high: 18 });
  const inspected = f.inspect('C2');
  const call = {
    type: 'tool_use',
    id: 'real-formula',
    name: 'edit_sheet',
    input: {
      action: 'set_formulas',
      sheetName: f.sheet.name,
      range: 'C2',
      editToken: inspected.editToken,
      formulas: [['=IF(B2>=10,"High","Low")']],
    },
  };
  const outcome = f.api.dmvChatRunTool_(f.session, f.api.dmvChatTools_(f.session), call);
  assert.equal(outcome.isError, false, outcome.content);
  const messages = [
    { role: 'assistant', content: [call] },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          id: call.id,
          name: call.name,
          content: outcome.content,
          isError: outcome.isError,
        },
      ],
    },
  ];
  const result = review(f, 'Done.', messages);
  assert.equal(result.segments, true);
  assert.match(result.note, /"count":20/);
  assert.match(result.note, /"High":18/);
});

test('balanced classifier labels still receive one threshold review', () => {
  const { f, messages } = classifierFixture({ count: 20, high: 10 });
  const result = review(f, 'Done.', messages);
  assert.equal(result.segments, true);
  assert.match(result.note, /"dominant":false/);
  assert.match(result.note, /labels against their numeric thresholds/);
});

test('full classifier counts include blank and error labels in the unique-key denominator', () => {
  const { f, messages } = classifierFixture({ count: 20, high: 18 });
  f.setCell(f.sheet, 20, 3, '');
  f.setError(f.sheet, 21, 3, { type: 'VALUE', message: 'Expected a number.' });
  const result = review(f, 'Done.', messages);
  assert.match(result.note, /"count":20/);
  assert.match(result.note, /"counts":\{"High":18,"\(blank\)":1,"\(error\)":1\}/);
});

test('numeric equality classifiers receive the same bounded threshold review', () => {
  const { f, messages } = classifierFixture({ count: 20, high: 10 });
  const formula = '=IF(B2=1,"First","Repeat")';
  f.setCell(f.sheet, 2, 3, 'Repeat', formula);
  messages[0].content[0].input.formulas = [[formula]];
  const result = review(f, 'Done.', messages);
  assert.equal(result.segments, true);
  assert.match(result.note, /B2=1/);
  assert.equal(f.api.dmvChatReviewClassifier_('=IF(ISBLANK(B2),"First","Repeat")'), false);
});

test('dynamic classifiers with thousands of unique labels send only full-count aggregates', () => {
  const { f, messages } = classifierFixture({ count: 5000, high: 5000 });
  const formula = '=IF(B2>=10,"High "&A2,"Low "&A2)';
  for (let index = 0; index < 5000; index++)
    f.setCell(f.sheet, index + 2, 3, 'High private-key-' + index, index === 0 ? formula : '');
  f.setCell(f.sheet, 2, 1, 'private-key-0');
  messages[0].content[0].input.formulas = [[formula]];
  const result = review(f, 'Done.', messages);
  assert.equal(result.segments, true);
  assert.match(result.note, /"count":5000/);
  assert.match(result.note, /"distinctLabels":5000/);
  assert.match(result.note, /"largestCount":1,"smallestCount":1/);
  assert.match(result.note, /"countsOmitted":true/);
  assert.match(result.note, /Full key count and aggregate group statistics are retained/);
  assert.doesNotMatch(result.note, /private-key-/);
  assert.doesNotMatch(result.note, /"counts":|"examples":/);
  assert.ok(result.note.length < f.api.DMV_CHAT.maxToolResultChars);
  assert.ok(f.state.cellsRead <= f.api.DMV_CHAT_REVIEW.cells);
  assert.match(result.note, /Keep verification internal/);
});

test('long and control-character classifier labels never expand into an unbounded model payload', () => {
  const { f, messages } = classifierFixture({ count: 60, high: 60 });
  for (let index = 0; index < 60; index++)
    f.setCell(
      f.sheet,
      index + 2,
      3,
      '\u0001'.repeat(70) + String(index % 30),
      index === 0 ? '=IF(B2>=10,"High","Low")' : ''
    );
  const result = review(f, 'Done.', messages);
  assert.match(result.note, /"count":60/);
  assert.match(result.note, /"distinctLabels":30/);
  assert.match(result.note, /"countsOmitted":true/);
  assert.match(result.note, /Escaped classification detail exceeds/);
  assert.doesNotMatch(result.note, /\\u0001/);
  const longLabel = 'private-key-' + '\u0000'.repeat(2000);
  const segments = Array.from({ length: 2 }, () => ({
    sheet: 'Output',
    column: 'C',
    count: 20,
    counts: { [longLabel]: 18, Short: 2 },
    dominant: true,
    formula: '=IF(B2>=10,"High","Low")',
    examples: [{ label: longLabel, inputs: [{ cell: 'B2', value: 15 }] }],
  }));
  const bounded = plain(f.api.dmvChatReviewSegments_(segments));
  const json = JSON.stringify(bounded);
  assert.ok(json.length < 10000);
  assert.doesNotMatch(json, /private-key-|\\u0000/);
  for (const segment of bounded) {
    assert.equal(segment.count, 20);
    assert.equal(segment.distinctLabels, 2);
    assert.equal(segment.largestCount, 18);
    assert.equal(segment.smallestCount, 2);
    assert.equal(segment.countsOmitted, true);
    assert.equal(segment.dominant, true);
  }
  for (const segment of segments) segment.formula = '\u0002'.repeat(3000);
  const escapedFormula = plain(f.api.dmvChatReviewSegments_(segments));
  assert.ok(
    JSON.stringify(escapedFormula).length < 10000,
    'formula escaping shares the same total budget'
  );
  for (const segment of escapedFormula) {
    assert.equal(segment.formulaTruncated, true);
    assert.equal(segment.count, 20);
    assert.equal(segment.distinctLabels, 2);
  }
});

test('ordinary short classifier groups keep the exact counts and boundary examples payload', () => {
  const f = chatSheetFixture();
  const segments = [
    {
      sheet: 'Output',
      column: 'C',
      count: 100,
      counts: { High: 90, Low: 10 },
      dominant: true,
      formula: '=IF(B2>=10,"High","Low")',
      examples: [{ label: 'High', inputs: [{ cell: 'B2', value: 15 }] }],
    },
  ];
  assert.deepEqual(plain(f.api.dmvChatReviewSegments_(segments)), segments);
});

test('a truncated classifier column is never treated as a full distribution', () => {
  const { f, messages } = classifierFixture({ count: 10001, high: 9900 });
  assert.equal(review(f, 'Done.', messages), null);
  assert.equal(f.state.cellsRead, 0);
});

test('ordinary numeric IF formulas and failed classifier writes do not trigger semantic reads', () => {
  const f = chatSheetFixture();
  const call = {
    name: 'edit_sheet',
    input: {
      action: 'set_formulas',
      sheetName: f.sheet.name,
      range: 'C2',
      formulas: [['=IF(B2>10,1,0)']],
    },
  };
  assert.equal(review(f, 'Done.', successful({ ok: true, sheetName: f.sheet.name }, call)), null);
  const { messages } = classifierFixture();
  messages.at(-1).content[0].is_error = true;
  assert.equal(review(f, 'Done.', messages), null);
  assert.equal(f.state.cellsRead, 0);
});
