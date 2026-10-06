import test from 'node:test';
import assert from 'node:assert/strict';
import { plain } from './helpers/datamoov-sandbox.mjs';
import { chatSheetFixture, ORCHARD_COLUMNS } from './helpers/chat-sheet-fixture.mjs';

// create_pivot's analyst options (filters, totals, sorting, percentages, MEDIAN, quarters and a
// cell of an existing tab) and the conditional_format tool. The sandbox answers spreadsheets.get
// like the Sheets API and checks pivot and conditional format requests as the API does, so a
// malformed body fails the whole batch.

const RED = { red: 1, green: 0, blue: 0 };

function fixture() {
  const f = chatSheetFixture({
    setup(f) {
      f.source = f.sheet;
      f.source.name = 'Source';
      const matrix = [
        ['Date', 'Campaign', 'Currency', 'Spend', 'Clicks'],
        [new Date('2026-08-01T12:00:00Z'), 'Brand', 'EUR', 10.5, 100],
        [new Date('2026-08-02T12:00:00Z'), 'Brand', 'EUR', 20, 150],
        [new Date('2026-09-01T12:00:00Z'), 'Generic', 'USD', 5, 20],
      ];
      matrix.forEach((row, r) =>
        row.forEach((value, c) => f.setCell(f.source, r + 3, c + 2, value))
      );
    },
    orchard: {
      columns: ORCHARD_COLUMNS.slice(0, 3),
      rows: [
        { date: '2026-08-01', campaign: 'Brand', spend: 10.5 },
        { date: '2026-08-02', campaign: 'Generic', spend: 5 },
      ],
      token: 'pivot-private-token',
    },
  });
  f.input = {
    sourceSheet: 'Source',
    sourceRange: 'B3:F8',
    targetSheet: 'Pivot',
    rows: [{ column: 3 }, { column: 2 }],
    values: [
      { column: 4, summarize: 'SUM' },
      { column: 5, summarize: 'SUM' },
    ],
  };
  f.pivot = (patch, session = f.session) =>
    plain(f.api.dmvChatCreatePivot_(session, { ...f.input, ...patch }));
  f.rule = (input, session = f.session) =>
    plain(f.api.dmvChatConditionalFormat_(session, { sheetName: 'Source', ...input }));
  // Every cell of a tab, to show a pivot left its source as it was.
  f.tabCells = (sheet) => plain([...sheet.cells]);
  f.report = (sheetName = 'Report') =>
    f.saveReport({ fields: ['date', 'campaign', 'spend'], sheetName }).report;
  return f;
}

function sourceGrid(f) {
  return {
    sheetId: f.source.id,
    startRowIndex: 2,
    endRowIndex: 8,
    startColumnIndex: 1,
    endColumnIndex: 6,
  };
}

/* create_pivot */

test('the tabs a request makes are remembered for it, and no tab it found', () => {
  const f = fixture();
  assert.equal(f.tabAction('create_sheet', { newName: 'Made' }).ok, true);
  assert.equal(f.tabAction('duplicate_sheet', { sheetName: 'Source', newName: 'Copy' }).ok, true);
  assert.equal(f.pivot({}).ok, true);
  assert.deepEqual(plain(f.session.newTabs), [f.tab('Made').id, f.tab('Copy').id, f.tab('Pivot').id]);
  assert.equal(f.session.newTabs.includes(f.source.id), false);
  // A later request starts with none.
  assert.deepEqual(plain(f.answer('Yes').newTabs), []);
});

test('COUNT over a column of text is refused on both paths: it would show 0 for every group', () => {
  const f = fixture();
  const count = (column, patch = {}) => ({ values: [{ column, summarize: 'COUNT' }], ...patch });
  for (const patch of [{}, { totals: false }]) {
    const before = f.state.batches.length;
    assert.throws(
      () => f.pivot(count(2, patch)),
      /COUNT counts numbers only; "Campaign" holds text: use COUNTA\./,
      JSON.stringify(patch)
    );
    assert.equal(f.state.batches.length, before);
  }
  // Numbers and dates are what COUNT counts; COUNTA counts text.
  assert.equal(f.pivot(count(4, { targetSheet: 'Counted' })).ok, true);
  assert.equal(f.pivot(count(1, { targetSheet: 'Dated', totals: false })).ok, true);
  assert.equal(
    f.pivot({ targetSheet: 'Named', values: [{ column: 2, summarize: 'COUNTA' }] }).ok,
    true
  );
});

test('the original create_pivot options keep the original path; any analyst option takes the new one', () => {
  const f = fixture();
  assert.equal(f.api.dmvChatPivotExtended_(f.input), false);
  assert.equal(
    f.api.dmvChatPivotExtended_({ ...f.input, columns: [{ column: 1, dateBucket: 'month' }] }),
    false
  );
  for (const patch of [
    { filters: [] },
    { totals: false },
    { targetCell: 'H2' },
    { rows: [{ column: 3, order: 'desc' }] },
    { columns: [{ column: 2, sortByValue: 1 }] },
    { columns: [{ column: 1, dateBucket: 'quarter' }] },
    { values: [{ column: 4, summarize: 'MEDIAN' }] },
    { values: [{ column: 4, summarize: 'SUM', showAs: 'percent_of_grand_total' }] },
  ])
    assert.equal(f.api.dmvChatPivotExtended_({ ...f.input, ...patch }), true, patch);
  for (const odd of [null, [], 'x', { rows: 'x', values: 3 }])
    assert.equal(f.api.dmvChatPivotExtended_(odd), false);
  // The original path: the same two requests, no undo entry and its own refusals.
  const result = f.pivot({});
  assert.equal(result.undoId, undefined);
  assert.equal(f.state.batches.length, 1);
  assert.deepEqual(
    f.requests().map((request) => Object.keys(request)[0]),
    ['addSheet', 'updateCells']
  );
  assert.throws(() => f.pivot({ targetSheet: 'Other', requests: [] }), /documented fields/);
});

test('an analyst pivot sends the exact native pivot: filters, sort by value, totals, percentages, MEDIAN and quarters', () => {
  const f = fixture(),
    before = f.tabCells(f.source);
  f.setCell(f.source, 5, 4, 'EUR');
  f.setCell(f.source, 6, 4, 'EUR');
  const result = f.pivot({
    targetSheet: 'Spend pivot',
    rows: [{ column: 3 }, { column: 2, order: 'desc', sortByValue: 1 }],
    columns: [{ column: 1, dateBucket: 'quarter' }],
    values: [
      { column: 4, summarize: 'MEDIAN' },
      { column: 5, summarize: 'SUM', showAs: 'percent_of_grand_total' },
    ],
    filters: [
      { column: 2, values: ['Brand', 'Generic'] },
      { column: 5, condition: { type: 'number_gt', value: 10 } },
      { column: 1, condition: { type: 'date_after', value: '2026-07-31' } },
    ],
    totals: true,
  });
  assert.equal(f.state.batches.length, 1);
  const requests = f.requests();
  assert.equal(requests.length, 2, 'no clean-up or other request joins the batch');
  const created = requests[0].addSheet.properties;
  assert.equal(created.title, 'Spend pivot');
  assert.ok(Number.isInteger(created.sheetId) && created.sheetId !== f.source.id);
  assert.deepEqual(created.gridProperties, { rowCount: 100, columnCount: 26 });
  assert.deepEqual(requests[1], {
    updateCells: {
      start: { sheetId: created.sheetId, rowIndex: 0, columnIndex: 0 },
      rows: [
        {
          values: [
            {
              pivotTable: {
                source: sourceGrid(f),
                rows: [
                  {
                    sourceColumnOffset: 2,
                    showTotals: true,
                    sortOrder: 'ASCENDING',
                    repeatHeadings: true,
                  },
                  {
                    sourceColumnOffset: 1,
                    showTotals: true,
                    sortOrder: 'DESCENDING',
                    repeatHeadings: true,
                    valueBucket: { valuesIndex: 0 },
                  },
                ],
                columns: [
                  {
                    sourceColumnOffset: 0,
                    showTotals: true,
                    sortOrder: 'ASCENDING',
                    groupRule: { dateTimeRule: { type: 'YEAR_QUARTER' } },
                  },
                ],
                values: [
                  { sourceColumnOffset: 3, summarizeFunction: 'MEDIAN' },
                  {
                    sourceColumnOffset: 4,
                    summarizeFunction: 'SUM',
                    calculatedDisplayType: 'PERCENT_OF_GRAND_TOTAL',
                  },
                ],
                valueLayout: 'HORIZONTAL',
                filterSpecs: [
                  {
                    columnOffsetIndex: 1,
                    filterCriteria: { visibleValues: ['Brand', 'Generic'] },
                  },
                  {
                    columnOffsetIndex: 4,
                    filterCriteria: {
                      condition: { type: 'NUMBER_GREATER', values: [{ userEnteredValue: '10' }] },
                      visibleByDefault: true,
                    },
                  },
                  {
                    columnOffsetIndex: 0,
                    filterCriteria: {
                      condition: {
                        type: 'DATE_AFTER',
                        values: [{ userEnteredValue: '=DATE(2026,7,31)' }],
                      },
                      visibleByDefault: true,
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
      fields: 'pivotTable',
    },
  });
  // The sandbox kept the pivot the API accepted; the source cells did not change.
  const pivotTab = f.tab('Spend pivot');
  assert.deepEqual(
    f.meta(pivotTab, 1, 1).pivotTable,
    requests[1].updateCells.rows[0].values[0].pivotTable
  );
  before.find(([key]) => key === '5:4')[1] = { value: 'EUR', formula: '' };
  before.find(([key]) => key === '6:4')[1] = { value: 'EUR', formula: '' };
  assert.deepEqual(f.tabCells(f.source), before);
  assert.equal(result.ok, true);
  assert.equal(result.nativePivot, true);
  assert.equal(result.sheetName, 'Spend pivot');
  assert.equal(result.anchorCell, 'A1');
  assert.equal(result.range, 'A1');
  assert.match(result.url, new RegExp('#gid=' + created.sheetId + '&range=A1$'));
  assert.equal(result.undoId, null, 'a new tab needs no undo, as with the original tool');
  assert.deepEqual(result.rowsBy, ['Currency', 'Campaign']);
  assert.deepEqual(result.columnsBy, ['Date']);
  assert.deepEqual(result.valuesShown, [
    'MEDIAN of Spend',
    'SUM of Clicks as percent of grand total',
  ]);
  assert.equal(result.filters, 3);
  assert.equal(result.totals, true);
  assert.doesNotMatch(result.note, /left out/);
  assert.equal(JSON.stringify(result).includes('Brand'), false, 'no source rows in the result');
  const event = plain(f.session.events.at(-1));
  assert.equal(event.kind, 'write');
  assert.equal(event.text, 'Created a native pivot table on Spend pivot from Source!B3:F8');
  assert.deepEqual(event.links, [{ label: 'Spend pivot', url: result.url }]);
  assert.ok(f.session.sheetNames.includes('Spend pivot'), 'later tools this turn see the tab');
});

test('the currency checks read every source row, past the first rows the other checks read', () => {
  // Every row USD up to the rows the other checks read, then one more row below them.
  const big = (last) => {
    const f = fixture();
    const rows = f.api.DMV_CHAT_PIVOT.checkRows + 1;
    f.source.maxRows = rows + 3;
    for (let r = 0; r < rows; r++)
      [new Date('2026-08-01T12:00:00Z'), 'Brand', r === rows - 1 ? last : 'USD', 1, 1].forEach(
        (value, c) => f.setCell(f.source, r + 4, c + 2, value)
      );
    f.input.sourceRange = 'B3:F' + (rows + 3);
    return f;
  };
  const f = big('EUR');
  const result = f.pivot({ totals: true });
  assert.deepEqual(
    f.requests()[1].updateCells.rows[0].values[0].pivotTable.rows.map((group) => group.showTotals),
    [false, true]
  );
  assert.match(result.note, /Totals were left out for Currency/);
  const g = big('');
  assert.throws(() => g.pivot({ totals: true }), /three-letter currency code/);
  assert.equal(g.state.batches.length, 0);
});

test('with several currencies, totals and percentages never add up different currencies', () => {
  // Currency is the outer row group: its own total and the grand total would mix EUR and USD.
  const f = fixture();
  const result = f.pivot({
    values: [{ column: 4, summarize: 'SUM', showAs: 'percent_of_row_total' }],
    columns: [{ column: 1, dateBucket: 'month' }],
    totals: true,
  });
  const pivot = f.requests()[1].updateCells.rows[0].values[0].pivotTable;
  assert.deepEqual(
    pivot.rows.map((group) => group.showTotals),
    [false, true]
  );
  assert.equal(pivot.columns[0].showTotals, true, 'each row keeps one currency');
  assert.match(
    result.note,
    /Totals were left out for Currency, because they would add up different currencies\./
  );
  for (const showAs of ['percent_of_grand_total', 'percent_of_column_total']) {
    const g = fixture();
    assert.throws(
      () => g.pivot({ values: [{ column: 4, summarize: 'SUM', showAs }] }),
      /would divide by a total of different currencies/
    );
    assert.equal(g.state.batches.length, 0);
  }
  // Currency as a column group: each column keeps one currency instead.
  const g = fixture();
  g.pivot({
    rows: [{ column: 2 }],
    columns: [{ column: 3 }],
    values: [{ column: 4, summarize: 'SUM', showAs: 'percent_of_column_total' }],
    totals: true,
  });
  const across = g.requests()[1].updateCells.rows[0].values[0].pivotTable;
  assert.equal(across.rows[0].showTotals, true);
  assert.equal(across.columns[0].showTotals, false);
  assert.throws(
    () =>
      g.pivot({
        targetSheet: 'Second',
        rows: [{ column: 2 }],
        columns: [{ column: 3 }],
        values: [{ column: 4, summarize: 'SUM', showAs: 'percent_of_row_total' }],
      }),
    /different currencies/
  );
  // Money must still be grouped by its currency column, as in the original tool.
  const h = fixture();
  assert.throws(
    () => h.pivot({ rows: [{ column: 2 }], totals: true }),
    /Group money and mixed-currency values by the currency column/
  );
  // One currency: every total and percentage is allowed.
  const one = fixture();
  one.setCell(one.source, 6, 4, 'EUR');
  const single = one.pivot({
    values: [{ column: 4, summarize: 'SUM', showAs: 'percent_of_grand_total' }],
    totals: true,
  });
  const whole = one.requests()[1].updateCells.rows[0].values[0].pivotTable;
  assert.deepEqual(
    whole.rows.map((group) => group.showTotals),
    [true, true]
  );
  assert.doesNotMatch(single.note, /left out/);
});

test('analyst pivot options are validated before any batch', () => {
  for (const [patch, message] of [
    [{ rows: [{ column: 3, sortByValue: 3 }] }, /sortByValue is the 1-based position/],
    [{ rows: [{ column: 3, sortByValue: 0 }, { column: 2 }] }, /sortByValue/],
    [{ rows: [{ column: 3, order: 'up' }] }, /asc or desc/],
    [{ rows: [{ column: 3, limit: 5 }], totals: true }, /documented fields/],
    [{ columns: [{ column: 1, dateBucket: 'week' }], totals: true }, /day, month, quarter or year/],
    [
      { values: [{ column: 4, summarize: 'SUM', showAs: 'percent' }] },
      /showAs is percent_of_row_total/,
    ],
    [{ values: [{ column: 4, summarize: 'STDEV' }], totals: true }, /MEDIAN for pivot values/],
    [
      {
        values: [
          { column: 4, summarize: 'MEDIAN' },
          { column: 4, summarize: 'MEDIAN' },
        ],
      },
      /Do not repeat/,
    ],
    [{ totals: 'yes' }, /totals must be true or false/],
    [{ filters: {} }, /at most 6 pivot filters/],
    [
      { filters: Array.from({ length: 7 }, (_, i) => ({ column: 1, values: [String(i)] })) },
      /at most 6/,
    ],
    [
      { filters: [{ column: 2, values: ['Brand'], condition: { type: 'blank' } }] },
      /either values or a condition/,
    ],
    [{ filters: [{ column: 2 }] }, /either values or a condition/],
    [{ filters: [{ column: 9, values: ['Brand'] }] }, /one-based offsets/],
    [{ filters: [{ column: 2, values: ['Brand'], extra: 1 }] }, /documented fields/],
    [
      {
        filters: [
          { column: 2, values: ['Brand'] },
          { column: 2, values: ['Generic'] },
        ],
      },
      /one pivot filter per source column/,
    ],
    [{ filters: [{ column: 2, values: [] }] }, /lists 1 to 100 values/],
    [{ filters: [{ column: 2, values: [''] }] }, /texts of 1 to 500 characters/],
    [
      { filters: [{ column: 2, values: ['brand'] }] },
      /No cell under "Campaign" is exactly "brand"\. Filter values match the cells exactly/,
    ],
    [
      { filters: [{ column: 2, condition: { type: 'text_eq', value: '=IMPORTRANGE("x","A1")' } }] },
      /cannot start with =/,
    ],
    [
      {
        filters: [
          {
            column: 1,
            condition: { type: 'date_between', value: '2026-08-01', value2: '2026-08-31' },
          },
        ],
      },
      /A pivot filter cannot use date_between/,
    ],
    [
      { filters: [{ column: 5, condition: { type: 'custom_formula', value: '=TRUE' } }] },
      /A pivot filter cannot use custom_formula/,
    ],
    [
      { filters: [{ column: 5, condition: { type: 'number_gt', value: 'ten' } }] },
      /must be a number/,
    ],
    [{ targetCell: 'H2' }, /No tab named "Pivot"/],
    [{ targetSheet: 'Source', targetCell: 'H2:H3' }, /targetCell is one cell/],
    [
      { targetSheet: 'source', totals: false },
      /already exists\. Choose a new tab name, or give targetCell/,
    ],
  ]) {
    const f = fixture();
    assert.throws(() => f.pivot(patch), message, JSON.stringify(patch));
    assert.equal(f.state.batches.length, 0, JSON.stringify(patch));
  }
  // MEDIAN reads only numbers, like SUM; COUNTA takes any value.
  const f = fixture();
  f.setCell(f.source, 4, 5, '10.5');
  assert.throws(
    () => f.pivot({ values: [{ column: 4, summarize: 'MEDIAN' }] }),
    /Numeric text is not silently ignored/
  );
  assert.equal(f.pivot({ values: [{ column: 2, summarize: 'COUNTA' }], totals: true }).ok, true);
});

test('a condition filter shows every value that meets it, so it sets visibleByDefault', () => {
  // PivotFilterCriteria: with visibleByDefault false (the default) only values both listed in
  // visibleValues and meeting the condition show, so a condition alone would hide every row.
  const f = fixture();
  f.pivot({
    filters: [
      { column: 2, values: ['Brand'] },
      { column: 5, condition: { type: 'number_gt', value: 10 } },
      { column: 1, condition: { type: 'date_after', value: '2026-07-31' } },
    ],
  });
  assert.deepEqual(f.requests()[1].updateCells.rows[0].values[0].pivotTable.filterSpecs, [
    { columnOffsetIndex: 1, filterCriteria: { visibleValues: ['Brand'] } },
    {
      columnOffsetIndex: 4,
      filterCriteria: {
        condition: { type: 'NUMBER_GREATER', values: [{ userEnteredValue: '10' }] },
        visibleByDefault: true,
      },
    },
    {
      columnOffsetIndex: 0,
      filterCriteria: {
        condition: { type: 'DATE_AFTER', values: [{ userEnteredValue: '=DATE(2026,7,31)' }] },
        visibleByDefault: true,
      },
    },
  ]);
});

test('a values filter matches text cells; number and date cells take a condition filter', () => {
  // A pivot lists number and date cells as it displays them ('8/1/2026', '1,000'), so a value in
  // another form would quietly empty it.
  for (const [filter, message] of [
    [{ column: 1, values: ['2026-08-01'] }, /"Date" holds numbers or dates/],
    [{ column: 4, values: [10.5] }, /"Spend" holds numbers or dates/],
    [{ column: 5, values: ['100'] }, /Use a condition filter such as number_eq/],
  ]) {
    const f = fixture();
    assert.throws(() => f.pivot({ filters: [filter] }), message, JSON.stringify(filter));
    assert.equal(f.state.batches.length, 0);
  }
  // A text cell among dates can still be listed; a date in it cannot.
  const f = fixture();
  f.setCell(f.source, 6, 2, 'n/a');
  f.pivot({ filters: [{ column: 1, values: ['n/a'] }] });
  assert.deepEqual(f.requests()[1].updateCells.rows[0].values[0].pivotTable.filterSpecs, [
    { columnOffsetIndex: 0, filterCriteria: { visibleValues: ['n/a'] } },
  ]);
  assert.throws(
    () => f.pivot({ targetSheet: 'Second', filters: [{ column: 1, values: ['n/a', '8/1/2026'] }] }),
    /No text cell under "Date" is exactly "8\/1\/2026"/
  );
});

test('only the columns a pivot uses need a distinct, nonempty header; numbers and dates are their text', () => {
  // A blank spacer or a year typed as a number between the needed columns no longer blocks it.
  for (const header of ['', 2025, new Date('2026-08-01T12:00:00Z'), 'Campaign'])
    for (const patch of [{}, { totals: true }]) {
      const f = fixture();
      f.setCell(f.source, 3, 2, header);
      assert.equal(f.pivot(patch).ok, true, JSON.stringify([header, patch]));
    }
  const f = fixture();
  f.setCell(f.source, 3, 6, 2025);
  const result = f.pivot({ totals: true });
  assert.deepEqual(result.valuesShown, ['SUM of Spend', 'SUM of 2025']);
  // A used column, as a group, a value or a filter, still needs its own header.
  for (const [cell, header, patch] of [
    [3, '', {}],
    [5, ' ', { totals: true }],
    [4, 'campaign', {}],
    [2, '', { filters: [{ column: 1, condition: { type: 'not_blank' } }] }],
  ]) {
    const g = fixture();
    g.setCell(g.source, 3, cell, header);
    assert.throws(
      () => g.pivot(patch),
      /Each source column the pivot uses needs a distinct, nonempty header/,
      JSON.stringify([cell, header, patch])
    );
    assert.equal(g.state.batches.length, 0);
  }
});

test('decimal thresholds go as formulas, which read the same in every spreadsheet locale', () => {
  // ConditionValue.userEnteredValue is parsed as typed, so '1.5' is no number in a de_DE sheet;
  // formulas always take a dot. Whole numbers read the same everywhere and stay as they are.
  const f = fixture();
  f.pivot({
    filters: [{ column: 4, condition: { type: 'number_between', value: 0.5, value2: '2.5' } }],
  });
  assert.deepEqual(
    f.requests()[1].updateCells.rows[0].values[0].pivotTable.filterSpecs[0].filterCriteria
      .condition,
    { type: 'NUMBER_BETWEEN', values: [{ userEnteredValue: '=0.5' }, { userEnteredValue: '=2.5' }] }
  );
  f.rule({
    action: 'add',
    range: 'E4:E8',
    condition: { type: 'number_gt', value: -1.5 },
    format: { bold: true },
  });
  assert.deepEqual(f.requests()[0].addConditionalFormatRule.rule.booleanRule.condition, {
    type: 'NUMBER_GREATER',
    values: [{ userEnteredValue: '=-1.5' }],
  });
  f.rule({
    action: 'add',
    range: 'E4:E8',
    scale: {
      min: { type: 'number', value: 0.25, color: '#ffffff' },
      mid: { type: 'percentile', value: 12.5, color: '#ffffff' },
      max: { type: 'number', value: 3, color: '#000000' },
    },
  });
  const scale = f.requests()[0].addConditionalFormatRule.rule.gradientRule;
  assert.deepEqual(
    [scale.minpoint.value, scale.midpoint.value, scale.maxpoint.value],
    ['=0.25', '=12.5', '3']
  );
  assert.equal(f.conditionalFormats(f.source).length, 2, 'the sandbox accepted both rules');
});

test('a pivot placed on an existing tab needs empty cells there, and undo removes it', () => {
  const f = fixture();
  const summary = f.book.insertSheet('Summary');
  f.setCell(summary, 1, 1, 'Notes stay');
  summary.formats.set('3:3', { textFormat: { bold: true } });
  const input = { targetSheet: 'Summary', targetCell: 'b2', totals: true };
  const result = f.pivot(input);
  assert.equal(result.anchorCell, 'B2');
  assert.equal(result.range, 'B2');
  assert.match(result.undoId, /^u[a-f0-9]{12}$/);
  assert.match(result.url, new RegExp('#gid=' + summary.id + '&range=B2$'));
  assert.equal(f.state.batches.length, 1);
  const [request] = f.requests();
  assert.deepEqual(Object.keys(request), ['updateCells']);
  assert.deepEqual(request.updateCells.start, { sheetId: summary.id, rowIndex: 1, columnIndex: 1 });
  assert.equal(request.updateCells.fields, 'pivotTable');
  assert.deepEqual(request.updateCells.rows[0].values[0].pivotTable.source, sourceGrid(f));
  assert.ok(f.meta(summary, 2, 2).pivotTable);
  assert.equal(
    plain(f.session.events.at(-1)).text,
    'Created a native pivot table at Summary!B2 from Source!B3:F8'
  );
  const undone = f.undo();
  assert.equal(undone.undone, result.undoId);
  assert.deepEqual(f.meta(summary, 2, 2), {}, 'the pivot is gone');
  assert.deepEqual(f.format(summary, 3, 3), { textFormat: { bold: true } });
  assert.equal(f.value(summary, 1, 1), 'Notes stay');
  // Undo restored the cells once; the entry is used up.
  assert.throws(() => f.undo(), /no recent chat edit/);

  // The cells it could fill must be empty, inside the grid and off its own source.
  f.setCell(summary, 4, 4, 'taken');
  assert.throws(
    () => f.pivot(input),
    /The cells this pivot could fill \(Summary!B2:\w+\) hold 1 non-empty cell\. Choose an empty area/
  );
  assert.throws(
    () => f.pivot({ ...input, targetCell: 'Y99' }),
    /beyond the grid of "Summary"\. Choose another cell, or leave out targetCell/
  );
  assert.throws(
    () => f.pivot({ ...input, targetSheet: 'Source', targetCell: 'C4' }),
    /cover its own source range/
  );
  assert.equal(f.state.batches.length, 2, 'only the pivot and its undo were written');
});

test('after a new tab, a renamed tab, a pivot on a new tab or a chart, undo says how to reverse it rather than undo the edit before it', () => {
  const f = fixture();
  f.api.dmvReadDefinitions_ = () => ({ definitions: [] });
  const edited = f.edit('set_values', { values: [['x']] }, f.inspect('A1', 'Source'));
  const cannot = (text, hint) =>
    new RegExp(
      '^Error: Chat cannot undo "' +
        text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
        '"\\. ' +
        hint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
        '$'
    );
  const batches = () => f.state.batches.length;
  for (const [make, text, hint] of [
    [
      () => f.tabAction('create_sheet', { newName: 'Scratch' }),
      'Created tab Scratch',
      'Delete the tab "Scratch" to remove it.',
    ],
    [
      () => f.edit('rename_sheet', { newName: 'Notes' }, f.inspect('A1', 'Scratch')),
      'Renamed tab Scratch to Notes',
      'Rename it back to "Scratch" to reverse it.',
    ],
    [
      () => f.pivot({}),
      'Created a native pivot table on Pivot from Source!B3:F8',
      'Delete the tab "Pivot" to remove it.',
    ],
    [
      () => f.pivot({ targetSheet: 'Totals', totals: false }),
      'Created a native pivot table on Totals from Source!B3:F8',
      'Delete the tab "Totals" to remove it.',
    ],
    [
      () =>
        f.api.dmvChatCreateChart_(f.session, {
          sheetName: 'Source',
          range: 'B3:F6',
          chartType: 'column',
          xColumn: 'Campaign',
          seriesColumns: ['Spend'],
        }),
      'Added a column chart "Spend by Campaign" on Source',
      'Delete the chart to remove it.',
    ],
  ]) {
    const done = plain(make());
    assert.equal(done.undoId ?? null, null, text);
    // Asked nothing, and undo changes nothing: it names the edit and how to reverse it.
    assert.equal(done.needsConfirmation, undefined, text);
    const before = batches();
    assert.throws(() => f.undo(), cannot(text, hint), text);
    assert.equal(batches(), before, text);
    assert.equal(f.value(f.source, 1, 1), 'x', text);
  }
  assert.deepEqual(
    f.undo({ action: 'list' }).entries.map((entry) => [entry.text, entry.undoable]),
    [
      ['Added a column chart "Spend by Campaign" on Source', false],
      ['Created a native pivot table on Totals from Source!B3:F8', false],
      ['Created a native pivot table on Pivot from Source!B3:F8', false],
      ['Renamed tab Scratch to Notes', false],
      ['Created tab Scratch', false],
      ['set_values Source!A1', undefined],
    ]
  );
  assert.equal(f.undo({ action: 'undo', id: edited.undoId }).ok, true);
  assert.equal(f.value(f.source, 1, 1), '');
});

test('pivots never land on report output, while their source may be report output', () => {
  const f = fixture();
  const report = f.report();
  const batches = f.state.batches.length;
  assert.throws(
    () => f.pivot({ targetSheet: 'Report', targetCell: 'A1' }),
    /touch the output of the saved report "Daily" on tab "Report"/
  );
  assert.equal(f.state.batches.length, batches);
  // Report output is a fine pivot source.
  const result = f.pivot({
    sourceSheet: 'Report',
    sourceRange: 'A1:C3',
    rows: [{ column: 2, order: 'desc' }],
    values: [{ column: 3, summarize: 'COUNTA' }],
  });
  assert.equal(result.ok, true);
  assert.equal(f.api.dmvRunReport(report.id).ok, true);
});

/* conditional_format */

test('add sends one exact addConditionalFormatRule after existing rules, and undo removes it', () => {
  const f = fixture();
  const result = f.rule({
    action: 'add',
    range: 'E4:E8',
    condition: { type: 'number_gt', value: 10 },
    format: { backgroundColor: '#FF0000', bold: true },
  });
  const rule = {
    ranges: [
      {
        sheetId: f.source.id,
        startColumnIndex: 4,
        endColumnIndex: 5,
        startRowIndex: 3,
        endRowIndex: 8,
      },
    ],
    booleanRule: {
      condition: { type: 'NUMBER_GREATER', values: [{ userEnteredValue: '10' }] },
      format: { backgroundColorStyle: { rgbColor: RED }, textFormat: { bold: true } },
    },
  };
  assert.deepEqual(f.requests(), [{ addConditionalFormatRule: { rule, index: 0 } }]);
  assert.deepEqual(f.conditionalFormats(f.source), [rule]);
  assert.equal(result.ok, true);
  assert.equal(result.action, 'conditional_format');
  assert.equal(result.change, 'added');
  assert.equal(result.rule, 'NUMBER_GREATER 10');
  assert.equal(result.range, 'E4:E8');
  assert.match(result.url, /&range=E4%3AE8$/);
  assert.match(result.undoId, /^u[a-f0-9]{12}$/);
  assert.equal(result.note, undefined);
  const event = plain(f.session.events.at(-1));
  assert.equal(event.text, 'Added conditional formatting to Source!E4:E8');
  assert.deepEqual(event.details, [
    { label: 'Action', value: 'conditional_format' },
    { label: 'Range', value: 'E4:E8' },
    { label: 'Rule', value: 'NUMBER_GREATER 10' },
  ]);
  // A second rule goes after the first, and says the first wins where both apply.
  const second = f.rule({
    action: 'add',
    range: 'E:E',
    condition: { type: 'blank' },
    format: { textColor: '#999999', italic: true, strikethrough: false },
  });
  assert.equal(f.requests()[0].addConditionalFormatRule.index, 1);
  assert.equal(
    second.note,
    '1 earlier rule covers some of these cells and comes first where both apply.'
  );
  assert.equal(second.url.includes('&range='), false, 'an open range links to the tab');
  assert.equal(f.undo().undone, second.undoId);
  assert.deepEqual(f.conditionalFormats(f.source), [rule]);
  f.undo();
  assert.deepEqual(f.conditionalFormats(f.source), []);
  // No cell changed at any point.
  assert.equal(f.value(f.source, 4, 5), 10.5);
});

test('each condition kind becomes the BooleanCondition the API documents', () => {
  const cases = [
    [
      { type: 'number_gte', value: '2.5' },
      { type: 'NUMBER_GREATER_THAN_EQ', values: [{ userEnteredValue: '=2.5' }] },
    ],
    [
      { type: 'number_lt', value: -1 },
      { type: 'NUMBER_LESS', values: [{ userEnteredValue: '-1' }] },
    ],
    [
      { type: 'number_lte', value: 0 },
      { type: 'NUMBER_LESS_THAN_EQ', values: [{ userEnteredValue: '0' }] },
    ],
    [
      { type: 'number_eq', value: 7 },
      { type: 'NUMBER_EQ', values: [{ userEnteredValue: '7' }] },
    ],
    [
      { type: 'number_ne', value: 7 },
      { type: 'NUMBER_NOT_EQ', values: [{ userEnteredValue: '7' }] },
    ],
    [
      { type: 'number_between', value: 1, value2: '2.5' },
      { type: 'NUMBER_BETWEEN', values: [{ userEnteredValue: '1' }, { userEnteredValue: '=2.5' }] },
    ],
    [
      { type: 'number_not_between', value: 1, value2: 1 },
      {
        type: 'NUMBER_NOT_BETWEEN',
        values: [{ userEnteredValue: '1' }, { userEnteredValue: '1' }],
      },
    ],
    [
      { type: 'text_contains', value: 'ran' },
      { type: 'TEXT_CONTAINS', values: [{ userEnteredValue: 'ran' }] },
    ],
    [
      { type: 'text_not_contains', value: 'x' },
      { type: 'TEXT_NOT_CONTAINS', values: [{ userEnteredValue: 'x' }] },
    ],
    [
      { type: 'text_starts_with', value: 'Br' },
      { type: 'TEXT_STARTS_WITH', values: [{ userEnteredValue: 'Br' }] },
    ],
    [
      { type: 'text_ends_with', value: 'nd' },
      { type: 'TEXT_ENDS_WITH', values: [{ userEnteredValue: 'nd' }] },
    ],
    [
      { type: 'text_eq', value: 'Brand' },
      { type: 'TEXT_EQ', values: [{ userEnteredValue: 'Brand' }] },
    ],
    [
      { type: 'date_before', value: 'today' },
      { type: 'DATE_BEFORE', values: [{ relativeDate: 'TODAY' }] },
    ],
    [
      { type: 'date_after', value: 'past_month' },
      { type: 'DATE_AFTER', values: [{ relativeDate: 'PAST_MONTH' }] },
    ],
    [
      { type: 'date_eq', value: '2026-08-01' },
      { type: 'DATE_EQ', values: [{ userEnteredValue: '=DATE(2026,8,1)' }] },
    ],
    [
      { type: 'date_between', value: '2026-08-01', value2: '2026-08-31' },
      {
        type: 'CUSTOM_FORMULA',
        values: [
          { userEnteredValue: '=AND(ISNUMBER(B4),B4>=DATE(2026,8,1),B4<DATE(2026,8,31)+1)' },
        ],
      },
    ],
    [{ type: 'blank' }, { type: 'BLANK' }],
    [{ type: 'not_blank' }, { type: 'NOT_BLANK' }],
    [
      { type: 'custom_formula', value: '=$E4>100' },
      { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: '=$E4>100' }] },
    ],
  ];
  const f = fixture();
  cases.forEach(([condition, expected], index) => {
    f.rule({ action: 'add', range: 'B4:F8', condition, format: { bold: true } });
    assert.deepEqual(f.requests()[0].addConditionalFormatRule.rule.booleanRule.condition, expected);
    assert.equal(f.conditionalFormats(f.source).length, index + 1, 'the sandbox accepted it');
  });
  for (const [condition, message] of [
    [{ type: 'number_gt' }, /number_gt needs a value/],
    [{ type: 'number_gt', value: 'abc' }, /must be a number/],
    [{ type: 'number_gt', value: Infinity }, /must be a number/],
    [{ type: 'number_between', value: 1 }, /needs value and value2/],
    [{ type: 'number_between', value: 3, value2: 1 }, /must not be below value/],
    [{ type: 'number_gt', value: 1, value2: 2 }, /value2 is for between conditions only/],
    [{ type: 'text_contains', value: '' }, /1 to 500 characters/],
    [{ type: 'text_contains', value: 5 }, /1 to 500 characters/],
    [{ type: 'text_eq', value: '=IMPORTXML("https://example.com","//a")' }, /cannot start with =/],
    [{ type: 'date_before', value: '2026-02-30' }, /Dates are YYYY-MM-DD, or today/],
    [{ type: 'date_before', value: 'next_week' }, /Dates are YYYY-MM-DD/],
    [
      { type: 'date_between', value: 'today', value2: '2026-08-31' },
      /^Error: Dates are YYYY-MM-DD\.$/,
    ],
    [
      { type: 'date_between', value: '2026-09-01', value2: '2026-08-31' },
      /must not be before value/,
    ],
    [{ type: 'blank', value: 'x' }, /blank takes no value/],
    [{ type: 'regex', value: 'x' }, /Choose a condition type: number_gt/],
    [{ type: 'number_gt', value: 1, extra: true }, /documented fields/],
    [{ type: 'custom_formula', value: 'TRUE' }, /beginning with =/],
  ]) {
    const batches = f.state.batches.length;
    assert.throws(
      () => f.rule({ action: 'add', range: 'B4:F8', condition, format: { bold: true } }),
      message,
      JSON.stringify(condition)
    );
    assert.equal(f.state.batches.length, batches);
  }
});

test('custom formulas pass the set_formulas checks, with references to their own tab only', () => {
  const f = fixture();
  f.book.insertSheet('Other');
  const add = (value, range = 'E4:E8') =>
    f.rule({
      action: 'add',
      range,
      condition: { type: 'custom_formula', value },
      format: { backgroundColor: '#ffeeee' },
    });
  // Any built-in outside the denylist, as in set_formulas, over cells of the rule's own tab.
  assert.equal(add('=XLOOKUP($C4,$C$4:$C$8,$E$4:$E$8)>1', 'E4:F').ok, true);
  assert.equal(add('=AND($E4>10,$D4="EUR")').ok, true);
  // Conditional-format formulas cannot refer to other tabs, so those are refused before Sheets.
  assert.throws(
    () => add('=XLOOKUP($C4,Other!A:A,Other!B:B)>1'),
    /E4: this formula can refer only to cells of its own tab \("Source"\)/
  );
  assert.throws(() => add('=importrange("x","A1")>0'), /IMPORTRANGE/);
  assert.throws(() => add('=IMAGE("https://example.com/a.png")'), /IMAGE/);
  assert.equal(f.conditionalFormats(f.source).length, 2);
});

test('the policy dmv_chat_sheet_formulas.js registers refuses outside data in rule formulas too', () => {
  const f = fixture();
  const add = (value) =>
    f.rule({
      action: 'add',
      range: 'E4:E8',
      condition: { type: 'custom_formula', value },
      format: { bold: true },
    });
  assert.equal(add('=$E4>AVERAGE($E$4:$E$8)').ok, true);
  for (const formula of [
    '=IMPORTRANGE("abc","A1")>0',
    '=ImportData ("https://example.com")',
    '=LEN(INDIRECT("A1"))>0',
    '=MYCUSTOM($E4)',
  ]) {
    const batches = f.state.batches.length;
    assert.throws(() => add(formula), /./, formula);
    assert.equal(f.state.batches.length, batches, formula);
  }
});

test('colour scales send the exact gradientRule for 2 and 3 points', () => {
  const f = fixture();
  f.rule({
    action: 'add',
    range: 'E4:E8',
    scale: { min: { type: 'min', color: '#FFFFFF' }, max: { type: 'max', color: '#00ff00' } },
  });
  assert.deepEqual(f.requests()[0].addConditionalFormatRule.rule.gradientRule, {
    minpoint: { colorStyle: { rgbColor: { red: 1, green: 1, blue: 1 } }, type: 'MIN' },
    maxpoint: { colorStyle: { rgbColor: { red: 0, green: 1, blue: 0 } }, type: 'MAX' },
  });
  const result = f.rule({
    action: 'add',
    range: 'F4:F8',
    scale: {
      min: { type: 'number', value: 0, color: '#ff0000' },
      mid: { type: 'percentile', value: 50, color: '#ffff00' },
      max: { type: 'percent', value: '90', color: '#00ff00' },
    },
  });
  assert.deepEqual(f.requests()[0].addConditionalFormatRule.rule.gradientRule, {
    minpoint: { colorStyle: { rgbColor: RED }, type: 'NUMBER', value: '0' },
    midpoint: {
      colorStyle: { rgbColor: { red: 1, green: 1, blue: 0 } },
      type: 'PERCENTILE',
      value: '50',
    },
    maxpoint: {
      colorStyle: { rgbColor: { red: 0, green: 1, blue: 0 } },
      type: 'PERCENT',
      value: '90',
    },
  });
  assert.equal(
    result.rule,
    'colour scale number 0 #ff0000, percentile 50 #ffff00, percent 90 #00ff00'
  );
  assert.equal(f.conditionalFormats(f.source).length, 2);
  for (const [input, message] of [
    [
      { scale: { min: { type: 'min', color: '#fff' }, max: { type: 'max', color: '#000000' } } },
      /#RRGGBB/,
    ],
    [
      { scale: { min: { type: 'max', color: '#ffffff' }, max: { type: 'max', color: '#000000' } } },
      /min point type/,
    ],
    [
      {
        scale: {
          min: { type: 'min', color: '#ffffff' },
          mid: { type: 'min', color: '#ffffff' },
          max: { type: 'max', color: '#000000' },
        },
      },
      /mid point type is one of number, percent, percentile/,
    ],
    [
      {
        scale: {
          min: { type: 'min', value: 1, color: '#ffffff' },
          max: { type: 'max', color: '#000000' },
        },
      },
      /takes no value/,
    ],
    [
      {
        scale: {
          min: { type: 'percent', value: 120, color: '#ffffff' },
          max: { type: 'max', color: '#000000' },
        },
      },
      /0 to 100/,
    ],
    [
      {
        scale: {
          min: { type: 'number', color: '#ffffff' },
          max: { type: 'max', color: '#000000' },
        },
      },
      /must be a number/,
    ],
    [{ scale: { min: { type: 'min', color: '#ffffff' } } }, /needs min and max/],
    [
      {
        scale: { min: { type: 'min', color: '#ffffff' }, max: { type: 'max', color: '#000000' } },
        format: { bold: true },
      },
      /leave out format/,
    ],
    [
      {
        scale: { min: { type: 'min', color: '#ffffff' }, max: { type: 'max', color: '#000000' } },
        condition: { type: 'blank' },
      },
      /either a condition with a format, or a colour scale/,
    ],
    [{}, /either a condition with a format, or a colour scale/],
    [{ condition: { type: 'blank' } }, /A condition needs a format/],
    [{ condition: { type: 'blank' }, format: {} }, /at least one of backgroundColor/],
    [{ condition: { type: 'blank' }, format: { bold: 'yes' } }, /bold must be true or false/],
    [{ condition: { type: 'blank' }, format: { fontSize: 12 } }, /documented fields/],
    [
      { condition: { type: 'blank' }, format: { bold: true }, ruleId: 'r000000000000' },
      /ruleId is for delete only/,
    ],
  ]) {
    const batches = f.state.batches.length;
    assert.throws(
      () => f.rule({ action: 'add', range: 'E4:E8', ...input }),
      message,
      JSON.stringify(input)
    );
    assert.equal(f.state.batches.length, batches);
  }
});

test('rule ranges take one cell, a range, columns to the last row or whole columns, inside the grid', () => {
  const f = fixture();
  const grid = (range) => {
    f.rule({ action: 'add', range, condition: { type: 'not_blank' }, format: { bold: true } });
    return f.requests()[0].addConditionalFormatRule.rule.ranges[0];
  };
  const id = f.source.id;
  assert.deepEqual(grid('c5'), {
    sheetId: id,
    startColumnIndex: 2,
    endColumnIndex: 3,
    startRowIndex: 4,
    endRowIndex: 5,
  });
  assert.deepEqual(grid('E4:E'), {
    sheetId: id,
    startColumnIndex: 4,
    endColumnIndex: 5,
    startRowIndex: 3,
  });
  assert.deepEqual(grid('D:F'), { sheetId: id, startColumnIndex: 3, endColumnIndex: 6 });
  assert.deepEqual(grid('A1:Z100'), {
    sheetId: id,
    startColumnIndex: 0,
    endColumnIndex: 26,
    startRowIndex: 0,
    endRowIndex: 100,
  });
  for (const range of [
    'E',
    'E:E5',
    '4:5',
    'E5:D9',
    'E9:E4',
    'AA1:AA2',
    'A101',
    'Source!E4:E8',
    'E4:E8,F4',
    undefined,
  ]) {
    assert.throws(
      () =>
        f.rule({ action: 'add', range, condition: { type: 'not_blank' }, format: { bold: true } }),
      /Use an A1 range of this tab|run forward and fit inside/,
      String(range)
    );
  }
  assert.equal(f.conditionalFormats(f.source).length, 4);
});

test('list shows each rule with a stable ruleId; delete removes that rule and undo puts it back', () => {
  const f = fixture();
  f.rule({
    action: 'add',
    range: 'E4:E8',
    condition: { type: 'number_gt', value: 10 },
    format: { backgroundColor: '#ff0000', bold: true },
  });
  f.rule({
    action: 'add',
    range: 'D4:D',
    scale: { min: { type: 'min', color: '#ffffff' }, max: { type: 'max', color: '#00ff00' } },
  });
  f.rule({
    action: 'add',
    range: 'C4:C8',
    condition: { type: 'text_eq', value: 'EUR' },
    format: { textColor: '#0000ff' },
  });
  const all = f.conditionalFormats(f.source);
  const batches = f.state.batches.length;
  const listed = f.rule({ action: 'list' });
  assert.equal(f.state.batches.length, batches, 'list writes nothing');
  assert.equal(listed.total, 3);
  assert.equal(listed.sheetName, 'Source');
  assert.equal(listed.rules[0].priority, 1);
  assert.deepEqual(listed.rules[0].ranges, ['E4:E8']);
  assert.equal(listed.rules[0].condition, 'NUMBER_GREATER 10');
  assert.deepEqual(listed.rules[0].format, { backgroundColor: '#ff0000', bold: true });
  assert.deepEqual(listed.rules[1].ranges, ['D4:D']);
  assert.equal(listed.rules[1].scale, 'min #ffffff, max #00ff00');
  assert.deepEqual(listed.rules[2].format, { textColor: '#0000ff' });
  for (const rule of listed.rules) assert.match(rule.ruleId, /^r[a-f0-9]{12}$/);
  assert.equal(new Set(listed.rules.map((rule) => rule.ruleId)).size, 3);
  assert.equal(plain(f.session.events.at(-1)).text, 'Listed conditional formatting on Source');

  const removed = f.rule({ action: 'delete', ruleId: listed.rules[1].ruleId });
  assert.deepEqual(f.requests(), [
    { deleteConditionalFormatRule: { sheetId: f.source.id, index: 1 } },
  ]);
  assert.equal(removed.change, 'deleted');
  assert.equal(removed.range, 'D4:D');
  assert.equal(removed.rulesOnTab, 2);
  assert.deepEqual(f.conditionalFormats(f.source), [all[0], all[2]]);
  // The other ids still hold after the positions moved.
  assert.deepEqual(
    f.rule({ action: 'list' }).rules.map((rule) => rule.ruleId),
    [listed.rules[0].ruleId, listed.rules[2].ruleId]
  );
  assert.throws(
    () => f.rule({ action: 'delete', ruleId: listed.rules[1].ruleId }),
    /No conditional format rule on "Source" has that ruleId now/
  );
  f.undo();
  // The API leaves out zero colour parts, so the rule is compared as list reads it.
  assert.deepEqual(f.rule({ action: 'list' }).rules, listed.rules, 'back in its place');
  assert.equal(f.conditionalFormats(f.source).length, all.length);
  for (const [input, message] of [
    [{ action: 'delete', ruleId: 'r1' }, /exactly as list returns it/],
    [{ action: 'delete' }, /exactly as list returns it/],
    [
      { action: 'delete', ruleId: listed.rules[0].ruleId, range: 'E4' },
      /delete takes sheetName and ruleId only/,
    ],
    [{ action: 'list', range: 'E4' }, /list takes sheetName only/],
    [{ action: 'remove' }, /Choose add, list or delete/],
    [{ action: 'add', requests: [] }, /documented fields/],
    [{ action: 'list', sheetName: 'Nope' }, /No tab named "Nope"/],
  ])
    assert.throws(() => f.rule(input), message, JSON.stringify(input));
});

test('conditional formats may colour report output, which still refreshes', () => {
  const f = fixture();
  const report = f.report();
  const result = f.rule({
    sheetName: 'Report',
    action: 'add',
    range: 'C2:C',
    condition: { type: 'number_gt', value: 6 },
    format: { backgroundColor: '#ff0000' },
  });
  assert.equal(result.ok, true);
  assert.equal(f.api.dmvRunReport(report.id).ok, true);
  assert.equal(f.conditionalFormats(f.tab('Report')).length, 1);
});

test('chat runs create_pivot, conditional_format and undo with their schemas, labels and events', () => {
  const f = fixture();
  const tools = f.api.dmvChatTools_(f.session);
  const names = tools.map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.includes('conditional_format'));
  assert.equal(
    f.api.dmvChatSheetToolLabel_('conditional_format'),
    'Updating conditional formatting'
  );
  const schema = (name) => plain(tools.find((tool) => tool.name === name).input_schema);
  const pivot = schema('create_pivot');
  // The fields the model already uses keep their names, types and required list.
  assert.deepEqual(pivot.required, ['sourceSheet', 'sourceRange', 'targetSheet', 'rows', 'values']);
  assert.deepEqual(pivot.properties.rows.items.required, ['column']);
  assert.deepEqual(pivot.properties.values.items.required, ['column', 'summarize']);
  assert.equal(pivot.properties.filters.items.additionalProperties, false);
  assert.deepEqual(
    pivot.properties.filters.items.properties.condition.properties.type.enum.includes(
      'custom_formula'
    ),
    false
  );
  assert.equal(pivot.properties.totals.type, 'boolean');
  assert.equal(pivot.properties.targetCell.type, 'string');
  assert.deepEqual(pivot.properties.rows.items.properties.dateBucket.enum, [
    'day',
    'month',
    'quarter',
    'year',
  ]);
  const rule = schema('conditional_format');
  assert.deepEqual(rule.required, ['action', 'sheetName']);
  assert.equal(rule.additionalProperties, false);
  assert.equal(rule.properties.condition.properties.type.enum.length, 20);
  // Every value has one type, or an anyOf of typed alternatives, for Gemini.
  const check = (node, path) => {
    if (node.anyOf) {
      assert.equal(node.type, undefined, path);
      node.anyOf.forEach((branch, i) => check(branch, path + '.anyOf' + i));
      return;
    }
    assert.equal(typeof node.type, 'string', path);
    for (const [key, value] of Object.entries(node.properties || {}))
      check(value, path + '.' + key);
    if (node.items) check(node.items, path + '[]');
    for (const key of node.required || [])
      assert.ok(node.properties[key], path + ' requires ' + key);
  };
  check(pivot, 'create_pivot');
  check(rule, 'conditional_format');

  f.setCell(f.source, 6, 4, 'EUR');
  const run = (name, input) => {
    const reply = f.api.dmvChatRunTool_(f.session, tools, { name, id: name, input });
    assert.equal(reply.isError, false, reply.content);
    return JSON.parse(reply.content);
  };
  const made = run('create_pivot', {
    ...f.input,
    targetSheet: 'Spend by campaign and month',
    rows: [{ column: 2, order: 'desc', sortByValue: 1 }, { column: 3 }],
    columns: [{ column: 1, dateBucket: 'month' }],
    values: [{ column: 4, summarize: 'SUM' }],
    totals: true,
  });
  assert.equal(made.sheetName, 'Spend by campaign and month');
  const coloured = run('conditional_format', {
    action: 'add',
    sheetName: 'Source',
    range: 'E4:E8',
    condition: { type: 'number_gt', value: 15 },
    format: { backgroundColor: '#ff0000' },
  });
  assert.equal(f.conditionalFormats(f.source).length, 1);
  const undone = run('undo_sheet_edit', { action: 'undo' });
  assert.equal(undone.undone, coloured.undoId);
  assert.deepEqual(f.conditionalFormats(f.source), []);
  assert.ok(f.tab('Spend by campaign and month'), 'the pivot stays');
  assert.deepEqual(plain(f.session.events.map((event) => event.kind)), ['write', 'write', 'write']);
  assert.equal(f.session.events[2].text, 'Undid: Added conditional formatting to Source!E4:E8');
  const failed = f.api.dmvChatRunTool_(f.session, tools, {
    name: 'conditional_format',
    id: 'x',
    input: { action: 'add', sheetName: 'Source', range: 'E4', condition: { type: 'blank' } },
  });
  assert.equal(failed.isError, true);
  assert.match(JSON.parse(failed.content).error, /needs a format/);
  assert.equal(f.state.http.length, 0, 'no request leaves the Sheets API');
});
