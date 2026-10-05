import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatamoovSandbox, plain } from './helpers/datamoov-sandbox.mjs';

// Findings of a live sweep of build 1bbe049 on a real spreadsheet. Asked which store had the
// highest revenue on a 1,001-row tab, chat read 500 rows (read_sheet refused more), summarized
// them and gave totals about half the real ones as the whole tab. Asked to add a total row to a
// tab that does not exist, it searched the spreadsheet for a minute and failed with "Out of
// memory error.".

const STORES = ['Downtown', 'Riverside Mall', 'Northgate', 'Harbor Plaza', 'Airport'];

// A tab of a header and rows of Store, Units and Revenue, with the totals per store.
function salesTab(f, name, rows) {
  const sheet = f.book.insertSheet(name);
  sheet.maxRows = rows + 1;
  sheet.maxColumns = 3;
  ['Store', 'Units', 'Revenue'].forEach((label, c) => f.setCell(sheet, 1, c + 1, label));
  const totals = {};
  for (let r = 0; r < rows; r++) {
    const store = STORES[r % STORES.length],
      revenue = 10 + (r % 37);
    f.setCell(sheet, r + 2, 1, store);
    f.setCell(sheet, r + 2, 2, 1 + (r % 4));
    f.setCell(sheet, r + 2, 3, revenue);
    totals[store] = (totals[store] || 0) + revenue;
  }
  return totals;
}

function byStore(f, session, resultId) {
  const summary = plain(
    f.api.dmvChatSummarize_(session, {
      resultId,
      groupBy: ['store'],
      metrics: [{ field: 'revenue', agg: 'sum' }],
    })
  );
  return {
    summary,
    totals: Object.fromEntries(summary.rows.map((row) => [row.store, row.revenue__sum])),
  };
}

test('read_sheet reads every row of a 1,000-row tab, so its totals are the whole tab', () => {
  const f = createDatamoovSandbox();
  const expected = salesTab(f, 'Sweep data', 1000);
  const session = f.api.dmvChatSession_(f.book);
  const read = plain(f.api.dmvChatReadSheet_(session, { sheetName: 'Sweep data' }));
  assert.equal(read.rowCount, 1000);
  assert.equal(read.metadata, undefined, 'a whole tab is not marked partial');
  assert.equal(session.events.at(-1).text, 'Read 1,000 rows from Sweep data');
  const { summary, totals } = byStore(f, session, read.resultId);
  assert.deepEqual(totals, expected);
  assert.equal(summary.inputRows, 1000);
  assert.equal(summary.metadata, undefined);
});

test('a read that holds only part of a tab says so, and so does every summary of it', () => {
  const f = createDatamoovSandbox();
  salesTab(f, 'Sweep data', 1000);
  const session = f.api.dmvChatSession_(f.book);
  // The range the model passed in the sweep: the header and the first 500 rows.
  const part = plain(
    f.api.dmvChatReadSheet_(session, { sheetName: 'Sweep data', range: 'A1:C501' })
  );
  assert.equal(part.rowCount, 500);
  assert.equal(
    part.metadata.partial,
    "Holds 500 of the tab's 1,000 data rows (rows 2-501). Totals, counts and rankings from it are partial: say so, or use formulas over whole columns."
  );
  assert.equal(session.events.at(-1).text, 'Read 500 of 1,000 rows from Sweep data');
  const { summary } = byStore(f, session, part.resultId);
  assert.equal(summary.metadata.partial, part.metadata.partial);
  // A combined result keeps the label of each partial source.
  assert.equal(
    f.api.dmvChatMetadata_({ partial: part.metadata.partial }).partial,
    part.metadata.partial
  );
  // The prompt tells the model what a partial result means for its answer.
  assert.match(
    f.api.dmvChatSystemPrompt_(session),
    /A result with metadata\.partial holds only the rows it names: say the answer is partial or use a formula; never call it the whole tab\./
  );
});

test('a range past the last row reads only the rows that hold data', () => {
  const f = createDatamoovSandbox();
  const expected = salesTab(f, 'Sweep data', 1000);
  f.book.getSheetByName('Sweep data').maxRows = 5000;
  const session = f.api.dmvChatSession_(f.book);
  const read = plain(
    f.api.dmvChatReadSheet_(session, { sheetName: 'Sweep data', range: 'A1:C5000' })
  );
  assert.equal(read.rowCount, 1000);
  assert.equal(read.metadata, undefined, 'the whole table is not marked partial');
  const { totals } = byStore(f, session, read.resultId);
  assert.deepEqual(totals, expected, 'no group of blank rows');
});

test('a read that starts inside a table says its first row is data, not a header', () => {
  const f = createDatamoovSandbox();
  salesTab(f, 'Sweep data', 1000);
  const session = f.api.dmvChatSession_(f.book);
  // A page after a partial first read.
  const page = plain(
    f.api.dmvChatReadSheet_(session, { sheetName: 'Sweep data', range: 'A502:C1001' })
  );
  assert.equal(page.rowCount, 499);
  assert.equal(
    page.metadata.partial,
    'Starts inside a table: row 502 was read as its header and the rows above it are left out. Totals, counts and rankings from it are partial: say so, or use formulas over whole columns.'
  );
});

test('a side table read whole is not marked partial beside a longer table', () => {
  const f = createDatamoovSandbox();
  salesTab(f, 'Sweep data', 1000);
  const sheet = f.book.getSheetByName('Sweep data');
  sheet.maxColumns = 6;
  [['Target', 'Value'], ['Units', 2000], ['Revenue', 9000], ['Stores', 5], ['Margin', 0.3]].forEach(
    (row, r) => row.forEach((value, c) => f.setCell(sheet, r + 1, c + 5, value))
  );
  const session = f.api.dmvChatSession_(f.book);
  const side = plain(f.api.dmvChatReadSheet_(session, { sheetName: 'Sweep data', range: 'E1:F5' }));
  assert.equal(side.rowCount, 4);
  assert.equal(side.metadata, undefined);
  // The first rows of the long table are still part of it.
  const head = plain(f.api.dmvChatReadSheet_(session, { sheetName: 'Sweep data', range: 'A1:B5' }));
  assert.match(head.metadata.partial, /^Holds 4 of the tab's 1,000 data rows \(rows 2-5\)\./);
});

test('read_sheet of a 100,000-row tab reads within its cell budget and marks the result partial', () => {
  const f = createDatamoovSandbox();
  const sheet = f.book.insertSheet('Big');
  const rows = 100000;
  sheet.maxRows = rows + 1;
  sheet.maxColumns = 2;
  f.setCell(sheet, 1, 1, 'Store');
  f.setCell(sheet, 1, 2, 'Revenue');
  for (let r = 0; r < rows; r++) {
    f.setCell(sheet, r + 2, 1, STORES[r % STORES.length]);
    f.setCell(sheet, r + 2, 2, 1);
  }
  const session = f.api.dmvChatSession_(f.book);
  const before = f.state.cellsRead;
  const read = plain(f.api.dmvChatReadSheet_(session, { sheetName: 'Big' }));
  const budget = f.api.DMV_CHAT_RESULTS.readMaxCells;
  assert.ok(
    f.state.cellsRead - before <= budget,
    'read ' + (f.state.cellsRead - before) + ' cells'
  );
  assert.equal(read.rowCount, budget / 2 - 1);
  assert.match(
    read.metadata.partial,
    new RegExp(
      '^Holds ' +
        (budget / 2 - 1).toLocaleString() +
        " of the tab's 100,000 data rows \\(rows 2-" +
        budget / 2 +
        '\\)\\.'
    )
  );
});

test('a tool given a tab that does not exist says so at once, closest tab first', () => {
  const f = createDatamoovSandbox({ gridData: true });
  f.book.insertSheet('Notes');
  salesTab(f, 'Sweep data', 20);
  const session = f.api.dmvChatSession_(f.book);
  const tools = f.api.dmvChatTools_(session);
  const before = { cells: f.state.cellsRead, batches: f.state.batches.length };
  const message =
    'No tab named "Sweep budget". Tabs: Sweep data, Output, Notes (closest first). Never search for it: for a new tab, make it first with edit_sheet create_sheet; otherwise tell the user it does not exist.';
  for (const [name, input] of [
    ['read_sheet', { sheetName: 'Sweep budget' }],
    ['inspect_sheet', { sheetName: 'Sweep budget', range: 'A1:C5' }],
    ['search_sheets', { query: 'Total', sheetName: 'Sweep budget' }],
    ['edit_sheet', { action: 'insert_rows', sheetName: 'Sweep budget', start: 2, count: 1 }],
  ]) {
    const result = f.api.dmvChatRunTool_(session, tools, { name, id: name, input });
    assert.equal(result.isError, true, name);
    assert.equal(JSON.parse(result.content).error, message, name);
  }
  assert.equal(f.state.cellsRead, before.cells, 'no cells were read');
  assert.equal(f.state.batches.length, before.batches, 'nothing was written');
  // The prompt says a tab missing from its list does not exist, unless the user asks for it.
  assert.match(
    f.api.dmvChatSystemPrompt_(session),
    /A tab missing from Tabs does not exist: make it with create_sheet if asked for a new tab, else say so, naming the closest tab; never search for it\./
  );
  // "Build a Sweep budget tab": the model makes the tab, then fills it.
  const made = f.api.dmvChatRunTool_(session, tools, {
    name: 'edit_sheet',
    id: 'make',
    input: { action: 'create_sheet', newName: 'Sweep budget' },
  });
  assert.equal(made.isError, false, made.content);
  const inspected = f.api.dmvChatRunTool_(session, tools, {
    name: 'inspect_sheet',
    id: 'look',
    input: { sheetName: 'Sweep budget', range: 'A1:C5' },
  });
  assert.equal(inspected.isError, false, inspected.content);
});

test('search_sheets reads a large spreadsheet in bounded requests and still finds every match', () => {
  const f = createDatamoovSandbox({ gridData: true });
  // Three tabs of 30,000 rows × 2 columns beside the one-cell Output tab, within the search cap.
  for (const name of ['One', 'Two', 'Three']) {
    const sheet = f.book.insertSheet(name);
    sheet.maxRows = 30000;
    sheet.maxColumns = 2;
    for (let r = 1; r <= 30000; r++) {
      f.setCell(sheet, r, 1, 'row ' + r);
      f.setCell(sheet, r, 2, r);
    }
    f.setCell(sheet, 30000, 2, 'Sweep budget');
  }
  f.setCell(f.book.getSheetByName('Two'), 1, 1, 'Sweep budget');
  const session = f.api.dmvChatSession_(f.book);
  const sheets = f.api.Sheets.Spreadsheets,
    get = sheets.get,
    calls = [];
  sheets.get = (id, options) => {
    const before = f.state.cellsRead;
    const result = get(id, options);
    calls.push(f.state.cellsRead - before);
    return result;
  };
  const found = plain(f.api.dmvChatSearchSheets_(session, { query: 'sweep budget' }));
  assert.equal(found.total, 4);
  assert.deepEqual(
    found.matches.map((match) => match.cell),
    ['One!B30000', 'Two!A1', 'Two!B30000', 'Three!B30000']
  );
  assert.equal(found.scannedCells, 180001);
  const most = f.api.DMV_SHEET_SEARCH.requestCells;
  assert.ok(most <= 20000, 'requestCells ' + most);
  assert.ok(calls.length > 1);
  for (const cells of calls) assert.ok(cells <= most, 'one request read ' + cells + ' cells');
});

test('search_sheets packs many small tabs into one request, as undo snapshots are read', () => {
  const f = createDatamoovSandbox({ gridData: true });
  for (let t = 1; t <= 40; t++) {
    const sheet = f.book.insertSheet('Tab ' + t);
    sheet.maxRows = 10;
    sheet.maxColumns = 3;
    for (let r = 1; r <= 10; r++) f.setCell(sheet, r, 1, t === 25 && r === 7 ? 'Needle' : 'hay ' + r);
  }
  const session = f.api.dmvChatSession_(f.book);
  const sheets = f.api.Sheets.Spreadsheets,
    get = sheets.get;
  let calls = 0;
  sheets.get = (id, options) => {
    calls++;
    return get(id, options);
  };
  const found = plain(f.api.dmvChatSearchSheets_(session, { query: 'needle' }));
  assert.deepEqual(found.matches.map((match) => match.cell), ['Tab 25!A7']);
  assert.equal(found.searchedTabs.length, 41);
  assert.equal(calls, 1, 'one request for 41 tabs of 401 cells');
});

test('a read that starts inside a table and stops before its end keeps its whole partial label', () => {
  const f = createDatamoovSandbox();
  salesTab(f, 'Sweep data', 1000);
  const session = f.api.dmvChatSession_(f.book);
  const page = plain(
    f.api.dmvChatReadSheet_(session, { sheetName: 'Sweep data', range: 'A502:C700' })
  );
  assert.match(page.metadata.partial, /^Starts inside a table: .* Holds 198 of the tab's 499 data rows/);
  assert.match(page.metadata.partial, /say so, or use formulas over whole columns\.$/);
  // combine_results lists each source's label whole.
  assert.equal(f.api.dmvChatMetadata_({ partial: page.metadata.partial }).partial, page.metadata.partial);
});
