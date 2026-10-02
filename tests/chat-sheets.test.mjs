import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatamoovSandbox, plain } from './helpers/datamoov-sandbox.mjs';

// Model the selected Sheets API grid response; source rows stay out of the edit-token cache.
function fixture() {
  const f = createDatamoovSandbox();
  f.sheet = f.book.sheets[0];
  const sheets = f.api.Sheets.Spreadsheets,
    get = sheets.get,
    batch = sheets.batchUpdate;
  sheets.get = (id, options) => {
    if (!options?.includeGridData) return get(id, options);
    f.state.gets.push({ spreadsheetId: id, options: plain(options) });
    const match = /^'((?:[^']|'')*)'!(.+)$/.exec(options.ranges[0]);
    const sheet = f.tab(match[1].replace(/''/g, "'"), f.state.books.get(id));
    const area = f.api.dmvChatSheetArea_(sheet, match[2]);
    return {
      sheets: [
        {
          properties: {
            sheetId: sheet.id,
            title: sheet.name,
            gridProperties: {
              rowCount: sheet.maxRows,
              columnCount: sheet.maxColumns,
              frozenRowCount: sheet.frozenRows,
              frozenColumnCount: sheet.frozenColumns || 0,
            },
          },
          basicFilter: sheet.filter || null,
          data: [
            {
              startRow: area.grid.startRowIndex,
              startColumn: area.grid.startColumnIndex,
              rowData: Array.from({ length: area.rows }, (_, r) => ({
                values: Array.from({ length: area.columns }, (_, c) => {
                  const key = `${r + area.grid.startRowIndex + 1}:${c + area.grid.startColumnIndex + 1}`;
                  const entry = sheet.cells.get(key),
                    metadata = sheet.metadata?.get(key) || {};
                  if (!entry) return { ...metadata };
                  const value = entry.value;
                  const effectiveValue =
                    typeof value === 'number'
                      ? { numberValue: value }
                      : typeof value === 'boolean'
                        ? { boolValue: value }
                        : { stringValue: value };
                  return {
                    userEnteredValue: entry.formula
                      ? { formulaValue: entry.formula }
                      : effectiveValue,
                    effectiveValue,
                    ...metadata,
                  };
                }),
              })),
            },
          ],
        },
      ],
    };
  };
  sheets.batchUpdate = (body, id) => {
    const req = plain(body.requests[0]);
    if (req.sortRange || req.setBasicFilter) {
      f.state.batches.push({ body: plain(body), spreadsheetId: id });
      if (f.state.failBatch) throw new Error('Simulated atomic batch failure');
      const grid = req.sortRange?.range || req.setBasicFilter.filter.range;
      const sheet = f.state.books.get(id).sheets.find((s) => s.id === grid.sheetId);
      if (req.setBasicFilter) sheet.filter = req.setBasicFilter.filter;
      else {
        const rows = [];
        for (let r = grid.startRowIndex; r < grid.endRowIndex; r++) {
          rows.push(
            Array.from({ length: grid.endColumnIndex - grid.startColumnIndex }, (_, c) =>
              sheet.cells.get(`${r + 1}:${c + grid.startColumnIndex + 1}`)
            )
          );
        }
        rows.sort((a, b) => {
          for (const spec of req.sortRange.sortSpecs) {
            const column = spec.dimensionIndex - grid.startColumnIndex;
            const av = a[column]?.value,
              bv = b[column]?.value;
            if (av !== bv) return (av < bv ? -1 : 1) * (spec.sortOrder === 'ASCENDING' ? 1 : -1);
          }
          return 0;
        });
        rows.forEach((row, r) =>
          row.forEach((value, c) => {
            const key = `${r + grid.startRowIndex + 1}:${c + grid.startColumnIndex + 1}`;
            if (value) sheet.cells.set(key, value);
            else sheet.cells.delete(key);
          })
        );
      }
      return { replies: [{}] };
    }
    const result = batch(body, id);
    if (req.updateSheetProperties) {
      const props = req.updateSheetProperties.properties;
      const sheet = f.state.books.get(id).sheets.find((s) => s.id === props.sheetId);
      if (props.title) sheet.name = props.title;
      if (props.gridProperties?.frozenColumnCount !== undefined)
        sheet.frozenColumns = props.gridProperties.frozenColumnCount;
    }
    return result;
  };
  f.session = f.api.dmvChatSession_(f.book);
  f.inspect = (range = 'A1:B3', sheetName = 'Output', session = f.session) =>
    plain(f.api.dmvChatInspectSheet_(session, { sheetName, range }));
  f.edit = (action, extra, inspected = f.inspect()) =>
    f.api.dmvChatEditSheet_(f.session, {
      action,
      sheetName: inspected.sheetName,
      range: inspected.range,
      editToken: inspected.editToken,
      ...extra,
    });
  return f;
}

test('literal edits require exact inspection, use one atomic batch and preserve adjacent cells', () => {
  const f = fixture();
  f.setCell(f.sheet, 1, 3, 'keep');
  const inspected = f.inspect('A1:B2');
  f.edit(
    'set_values',
    {
      values: [
        ['=IMPORTDATA("https://example.com")', true],
        [12.5, ''],
      ],
    },
    inspected
  );
  assert.equal(f.state.batches.length, 1);
  assert.equal(f.state.scriptLockAcquires, 1);
  assert.equal(f.value(f.sheet, 1, 1), '=IMPORTDATA("https://example.com")');
  assert.equal(f.formula(f.sheet, 1, 1), '');
  assert.equal(f.value(f.sheet, 1, 3), 'keep');
  assert.equal(f.value(f.sheet, 2, 1), 12.5);
  assert.equal(f.session.events.at(-1).kind, 'write');
  assert.throws(
    () =>
      f.edit(
        'set_values',
        {
          values: [
            [1, 2],
            [3, 4],
          ],
        },
        inspected
      ),
    /expired/
  );
  assert.equal(f.state.batches.length, 1);
});

test('edit tokens carry metadata only and reject user, workbook, range and expiry mismatches', () => {
  const f = fixture();
  f.setCell(f.sheet, 1, 1, 'private-cell-content');
  const inspected = f.inspect('A1');
  assert.ok(
    [...f.state.cache.data.values()].every((value) => !value.includes('private-cell-content'))
  );
  assert.throws(
    () => f.edit('set_values', { values: [[1]], range: 'B1' }, inspected),
    /another range/
  );
  const book = f.addSpreadsheet('other', ['Output']);
  const session = f.api.dmvChatSession_(book);
  assert.throws(
    () =>
      f.api.dmvChatEditSheet_(session, {
        action: 'set_values',
        sheetName: 'Output',
        range: 'A1',
        editToken: inspected.editToken,
        values: [[1]],
      }),
    /another range/
  );
  const otherUser = fixture();
  assert.throws(() => otherUser.edit('set_values', { values: [[1]] }, inspected), /expired/);
  f.advance(300001);
  f.session.deadline = f.api.Date.now() + 60000;
  assert.throws(() => f.edit('set_values', { values: [[1]] }, inspected), /expired/);
  assert.equal(f.state.batches.length, 0);
});

test('changed values, formulas, formatting and validation invalidate a prior inspection', () => {
  for (const change of [
    (f) => f.setCell(f.sheet, 1, 1, 'changed'),
    (f) => f.setCell(f.sheet, 1, 1, '=1+2', '=1+2'),
    (f) => {
      f.sheet.metadata = new Map([['1:1', { userEnteredFormat: { textFormat: { bold: true } } }]]);
    },
    (f) => {
      f.sheet.metadata = new Map([
        ['1:1', { dataValidation: { strict: true, condition: { type: 'ONE_OF_LIST' } } }],
      ]);
    },
  ]) {
    const f = fixture(),
      inspected = f.inspect('A1');
    change(f);
    assert.throws(() => f.edit('set_values', { values: [[42]] }, inspected), /changed/);
    assert.equal(f.state.batches.length, 0);
  }
});

// Changed with the analyst formula policy (dmv_chat_sheet_formulas.js): arrays, other tabs and
// named ranges of this spreadsheet are now accepted; external, custom and indirect functions,
// unknown names and missing tabs are still refused, each by name.
test('formulas take built-ins, arrays and ranges, never external, custom or indirect functions', () => {
  const f = fixture();
  f.setCell(f.sheet, 2, 1, 2);
  f.setCell(f.sheet, 3, 1, 4);
  f.edit('set_formulas', { formulas: [['=SUM(A2:A3)', '=IF(A2>0,A2,0)']] }, f.inspect('B1:C1'));
  assert.equal(f.formula(f.sheet, 1, 2), '=SUM(A2:A3)');
  assert.equal(f.formula(f.sheet, 1, 3), '=IF(A2>0,A2,0)');
  for (const [formula, refusal] of [
    ['=IMPORTDATA("https://example.com")', /IMPORTDATA is not allowed/],
    ['=IMAGE("https://example.com")', /IMAGE is not allowed/],
    ['=GOOGLEFINANCE("X")', /GOOGLEFINANCE is not allowed/],
    ['=CUSTOM(A1)', /unknown function CUSTOM/],
    ['=INDIRECT("A1")', /INDIRECT is not allowed/],
    ['=NamedRange', /unknown name NAMEDRANGE/],
    ['=Other!A1', /No tab named "Other"/],
    ["='DataMoovReports'!A1", /No tab named "DataMoovReports"/],
  ]) {
    assert.throws(
      () => f.edit('set_formulas', { formulas: [[formula]] }, f.inspect('D1')),
      refusal,
      formula
    );
  }
  assert.equal(f.state.batches.length, 1);
  for (const [column, formula] of [
    [4, '=A1:A3'],
    [5, '=IF(TRUE,A1:A3,0)'],
    [6, '=IF(TRUE,{1,2},0)'],
    [7, '=SUMIF(A1:A3,B1:B3,C1:C3)'],
    [8, '=COUNTIFS(A1:A3,B1:B3)'],
  ]) {
    f.edit('set_formulas', { formulas: [[formula]] }, f.inspect('DEFGH'[column - 4] + '1'));
    assert.equal(f.formula(f.sheet, 1, column), formula);
  }
  assert.equal(f.state.batches.length, 6);
});

// Changed with the analyst formula policy: the old validator walked the formulas of referenced
// cells, which whole columns and other tabs make impossible. Reading a cell's result fetches
// nothing new; only the formulas chat writes are checked.
test('a formula may refer to cells whatever formulas they already hold', () => {
  const f = fixture();
  f.setCell(f.sheet, 1, 1, '=B1', '=B1');
  f.setCell(f.sheet, 1, 2, '=INDIRECT("DataMoovReports!A1")', '=INDIRECT("DataMoovReports!A1")');
  f.edit('set_formulas', { formulas: [['=A1']] }, f.inspect('C1'));
  assert.equal(f.formula(f.sheet, 1, 3), '=A1');
  assert.equal(f.formula(f.sheet, 1, 2), '=INDIRECT("DataMoovReports!A1")');
  assert.equal(f.state.batches.length, 1);
});

test('sort preserves its header and rows outside the explicit range', () => {
  const f = fixture();
  [
    ['Campaign', 'Spend'],
    ['Low', 1],
    ['High', 3],
    ['Outside', 99],
  ].forEach((row, r) => row.forEach((v, c) => f.setCell(f.sheet, r + 1, c + 1, v)));
  f.edit('sort', { sortBy: [{ column: 2, ascending: false }] });
  assert.deepEqual(
    [1, 2, 3, 4].map((r) => f.value(f.sheet, r, 1)),
    ['Campaign', 'High', 'Low', 'Outside']
  );
  assert.equal(f.state.batches[0].body.requests[0].sortRange.range.startRowIndex, 1);
});

test('formatting uses color styles and narrow masks without replacing unrelated formatting', () => {
  const f = fixture();
  f.edit('format', {
    format: {
      bold: true,
      textColor: '#FF0000',
      backgroundColor: '#00FF00',
      numberFormat: 'percent',
      horizontalAlignment: 'RIGHT',
    },
  });
  const request = f.state.batches[0].body.requests[0].repeatCell;
  assert.deepEqual(request.cell.userEnteredFormat.textFormat.foregroundColorStyle.rgbColor, {
    red: 1,
    green: 0,
    blue: 0,
  });
  assert.deepEqual(request.cell.userEnteredFormat.backgroundColorStyle.rgbColor, {
    red: 0,
    green: 1,
    blue: 0,
  });
  assert.ok(request.fields.includes('userEnteredFormat.textFormat.foregroundColorStyle'));
  assert.ok(!request.fields.includes('*'));
  assert.equal(request.cell.userEnteredFormat.numberFormat.type, 'PERCENT');
});

test('the number format never leaves a trailing dot on whole numbers', () => {
  const f = fixture();
  f.setCell(f.sheet, 1, 1, 2494);
  f.edit('format', { format: { numberFormat: 'number' } });
  // '#,##0.###' showed 2494 as "2,494."; Sheets has no optional-decimals pattern without the dot.
  assert.deepEqual(f.state.batches[0].body.requests[0].repeatCell.cell.userEnteredFormat.numberFormat, {
    type: 'NUMBER',
    pattern: '#,##0.00',
  });
  f.edit('format', { format: { numberFormat: 'currency' } });
  assert.equal(
    f.state.batches[1].body.requests[0].repeatCell.cell.userEnteredFormat.numberFormat.pattern,
    '#,##0.00'
  );
});

test('currency with a currencyCode shows that code; without one the schema says it shows none', () => {
  // A locale default symbol could show $ on AED or EUR amounts, so the code is given, never guessed.
  const f = fixture();
  f.setCell(f.sheet, 1, 1, 1234.5);
  f.edit('format', { format: { numberFormat: 'currency', currencyCode: 'EUR' } });
  assert.deepEqual(f.state.batches[0].body.requests[0].repeatCell, {
    range: f.state.batches[0].body.requests[0].repeatCell.range,
    cell: { userEnteredFormat: { numberFormat: { type: 'CURRENCY', pattern: '#,##0.00" EUR"' } } },
    fields: 'userEnteredFormat.numberFormat',
  });
  for (const [format, message] of [
    [{ numberFormat: 'currency', currencyCode: 'eur' }, /three-letter code in capitals/],
    [{ numberFormat: 'currency', currencyCode: 'EU"R' }, /three-letter code in capitals/],
    [{ numberFormat: 'number', currencyCode: 'EUR' }, /currencyCode is for numberFormat currency/],
    [{ currencyCode: 'EUR' }, /currencyCode is for numberFormat currency/],
  ])
    assert.throws(() => f.edit('format', { format }), message, JSON.stringify(format));
  const tool = f.api
    .dmvChatTools_(f.session)
    .find((item) => item.name === 'edit_sheet').input_schema.properties.format.properties;
  assert.match(tool.numberFormat.description, /currency without currencyCode shows no symbol/);
  assert.match(tool.currencyCode.description, /EUR/);
});

test('filters reject formula-bearing criteria, normalize numbers and preserve other criteria', () => {
  const f = fixture();
  for (const value of [
    '=IMPORTDATA("https://example.com")',
    '  +IMPORTXML("https://example.com","//x")',
  ]) {
    assert.throws(
      () => f.edit('filter', { filter: { column: 1, condition: 'TEXT_EQ', value } }),
      /literal text/
    );
  }
  assert.equal(f.state.batches.length, 0);
  f.edit('filter', { filter: { column: 2, condition: 'NUMBER_GREATER', value: ' +001.50 ' } });
  assert.equal(f.sheet.filter.criteria[1].condition.values[0].userEnteredValue, '=1.5');
  f.edit('filter', { filter: { column: 1, condition: 'TEXT_CONTAINS', value: 'High' } });
  assert.equal(f.sheet.filter.criteria[1].condition.values[0].userEnteredValue, '=1.5');
  assert.equal(f.sheet.filter.criteria[0].condition.values[0].userEnteredValue, 'High');
  assert.throws(() => f.edit('filter', { filter: {} }, f.inspect('A1:A3')), /different range/);
});

test('a decimal filter threshold goes as a formula, which reads the same in every locale', () => {
  // As for conditional formats: '0.25' typed into a de_DE sheet is no number.
  const f = fixture();
  f.edit('filter', { filter: { column: 2, condition: 'NUMBER_LESS', value: '0.25' } });
  assert.deepEqual(f.sheet.filter.criteria[1].condition.values, [{ userEnteredValue: '=0.25' }]);
  f.edit('filter', { filter: { column: 2, condition: 'NUMBER_LESS', value: 1000 } });
  assert.deepEqual(f.sheet.filter.criteria[1].condition.values, [{ userEnteredValue: '1000' }]);
});

test('freeze and new-tab creation are bounded, while rename protects saved report destinations', () => {
  const f = fixture();
  f.edit('freeze', { frozenRows: 1, frozenColumns: 1 });
  assert.equal(f.sheet.frozenRows, 1);
  assert.equal(f.sheet.frozenColumns, 1);
  f.api.dmvChatEditSheet_(f.session, { action: 'create_sheet', newName: 'New output' });
  assert.ok(f.tab('New output'));
  assert.throws(
    () => f.api.dmvChatEditSheet_(f.session, { action: 'create_sheet', newName: 'New output' }),
    /already exists/
  );
  f.api.dmvList_ = (kind) =>
    kind === 'report' ? [{ spreadsheetId: f.book.id, target: { sheetName: 'Output' } }] : [];
  assert.throws(() => f.edit('rename_sheet', { newName: 'Renamed' }), /saved report/);
  // A dashboard owns its dashboard tab and one tab per dataset; a record saved by the earlier
  // single-table version still owns its data tab until the user removes it.
  for (const dashboard of [
    { target: { sheetName: 'Output' }, outputs: [{ id: 'gads', sheetName: 'Google Ads Data' }] },
    { target: { sheetName: 'Ads Dashboard' }, outputs: [{ id: 'gads', sheetName: 'Output' }] },
    { target: { sheetName: 'Old report' }, dataTarget: { sheetName: 'Output' } },
  ]) {
    f.api.dmvList_ = (kind) =>
      kind === 'dashboard' ? [{ spreadsheetId: f.book.id, ...dashboard }] : [];
    assert.throws(() => f.edit('rename_sheet', { newName: 'Renamed' }), /saved dashboard/);
  }
  f.api.dmvList_ = () => [];
  f.edit('rename_sheet', { newName: 'Renamed' });
  assert.ok(f.tab('Renamed'));
  assert.equal(f.state.batches.length, 3);
});

test('bounds, malformed actions and concurrent workbook work fail before mutation', () => {
  const f = fixture();
  for (const range of ['A1:Z100', 'A0', 'Output!A1', 'A1:A101'])
    assert.throws(() => f.inspect(range));
  const inspected = f.inspect('A1');
  assert.throws(() => f.edit('set_values', { values: [[1, 2]] }, inspected), /match/);
  assert.throws(
    () => f.edit('set_values', { values: [[1]], requests: [] }, inspected),
    /documented fields/
  );
  assert.throws(
    () => f.api.dmvChatEditSheet_(f.session, { action: 'delete_spreadsheet' }),
    /supported sheet action/
  );
  assert.throws(
    () => f.edit('sort', { sortBy: [{ column: 1, ascending: true }], headerRows: null }),
    /integer number/
  );
  assert.throws(() => f.edit('freeze', { frozenRows: null }), /integer number/);
  assert.throws(
    () => f.edit('sort', { sortBy: [{ column: true, ascending: true }] }),
    /integer number/
  );
  f.state.scriptLockAvailable = false;
  assert.throws(
    () => f.edit('set_values', { values: [[1]] }, inspected),
    /busy|writing|another|try again/i
  );
  assert.equal(f.state.batches.length, 0);
});

test('batch failure preserves cells and token; post-commit cache failure still records a write', () => {
  const f = fixture(),
    inspected = f.inspect('A1');
  f.state.failBatch = true;
  assert.throws(() => f.edit('set_values', { values: [[7]] }, inspected), /atomic batch failure/);
  assert.equal(f.value(f.sheet, 1, 1), '');
  assert.ok(f.state.cache.get('dmv:sheet-edit:' + inspected.editToken));
  assert.ok(!f.session.events.some((event) => event.kind === 'write'));
  f.state.failBatch = false;
  f.state.cache.remove = () => {
    throw new Error('cache unavailable');
  };
  f.api.SpreadsheetApp.flush = () => {
    throw new Error('metadata unavailable');
  };
  f.edit('set_values', { values: [[7]] }, inspected);
  assert.equal(f.value(f.sheet, 1, 1), 7);
  assert.equal(f.session.events.at(-1).kind, 'write');
  assert.throws(() => f.edit('set_values', { values: [[8]] }, inspected), /changed/);
});

test('registered tools expose typed operations and fixed actual progress labels', () => {
  const f = fixture();
  const tools = f.api.dmvChatTools_(f.session);
  assert.ok(
    ['list_sheets', 'inspect_sheet', 'edit_sheet'].every((name) =>
      tools.some((tool) => tool.name === name)
    )
  );
  assert.equal(f.api.DMV_CHAT_PROGRESS_LABELS.edit_sheet, 'Updating the spreadsheet');
  const schema = tools.find((tool) => tool.name === 'edit_sheet').input_schema;
  assert.ok(!schema.properties.requests);
});

test('rename_sheet runs against the real runtime, with no stand-in for removed report stores', () => {
  // rename_sheet once read workbook report definitions through a function no file defines any
  // more; with nothing stubbed, renaming a free tab must work and a saved report's tab must not.
  const f = fixture();
  assert.equal(typeof f.api.dmvReadDefinitions_, 'undefined');
  f.edit('rename_sheet', { newName: 'Renamed' });
  assert.ok(f.tab('Renamed'));
});
