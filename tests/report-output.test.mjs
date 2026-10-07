import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatamoovSandbox, plain } from './helpers/datamoov-sandbox.mjs';

// Findings of a live sweep of build 1bbe049 on a real spreadsheet. Chat styled a saved report's
// output (a dark header with white bold text, AED amounts, a conditional format); pressing Run
// then put the light header fill and the plain number format back but kept the white text, so the
// header read white on white. And a daily report wrote its Date column as text, so sorting,
// filters, QUERY date comparisons and charts did not read it as dates.

const rgb = (hex) => ({ red: parseInt(hex.slice(1, 3), 16) / 255, green: parseInt(hex.slice(3, 5), 16) / 255, blue: parseInt(hex.slice(5, 7), 16) / 255 });
const SLATE = rgb('#334155'), WHITE = rgb('#ffffff'), HEADER = { red: 0.93, green: 0.95, blue: 1 };
const AED = { type: 'NUMBER', pattern: '"AED "#,##0.00' };

const day = (n) => `2026-09-${String(n).padStart(2, '0')}`;
const rowsFor = (days) => Array.from({ length: days }, (_, i) => ({ date: day(i + 1), campaign: 'Brand', cost: 10 + i }));

function fixture() {
  const f = createDatamoovSandbox();
  const fields = [
    { key: 'date', label: 'Date', type: 'date', default: true },
    { key: 'campaign', label: 'Campaign', type: 'text', default: true },
    { key: 'cost', label: 'Cost', type: 'currency', default: true },
    { key: 'updated', label: 'Updated', type: 'date', default: false },
    { key: 'conversions', label: 'Conversions', type: 'number', default: false },
  ];
  let rows = rowsFor(2);
  f.api.dmvRegisterConnector_({
    id: 'ledger', label: 'Ledger', description: 'A test connector', category: 'Test', allowedHosts: ['ledger.example'],
    authFields: [{ key: 'token', label: 'Token', type: 'password', required: true }],
    reports: [{ id: 'daily', label: 'Daily', fields, dateRange: true, configFields: [],
      fetch: (ctx) => ({ columns: ctx.fields.map((key) => fields.find((field) => field.key === key)), rows, metadata: { complete: true } }) }],
  });
  const connection = f.api.dmvSaveConnection({ connectorId: 'ledger', label: 'Ledger account', credentials: { token: 'private-ledger-token' } });
  f.report = f.api.dmvSaveReport({
    connectionId: connection.id, name: 'Daily cost', reportType: 'daily', fields: ['date', 'campaign', 'cost'], config: {}, maxRows: 100,
    dateRange: { preset: 'custom', startDate: day(1), endDate: day(30) }, target: { sheetName: 'Output', startCell: 'A1' }, schedule: 'manual',
  });
  f.setRows = (next) => { rows = next; };
  f.run = () => plain(f.api.dmvRunReport(f.report.id));
  f.edit = (changes) => { f.report = f.api.dmvSaveReport({ ...plain(f.api.dmvRead_('report', f.report.id)), ...changes }); };
  f.sheet = () => f.tab('Output');
  // What chat applies through edit_sheet and conditional_format on the report's output.
  f.style = (rows) => {
    const sheetId = f.sheet().id, cells = (startRowIndex, endRowIndex, startColumnIndex, endColumnIndex) => ({ sheetId, startRowIndex, endRowIndex, startColumnIndex, endColumnIndex });
    f.api.Sheets.Spreadsheets.batchUpdate({ requests: [
      { repeatCell: { range: cells(0, 1, 0, 3), cell: { userEnteredFormat: { backgroundColor: SLATE, textFormat: { bold: true, foregroundColor: WHITE } } },
        fields: 'userEnteredFormat.backgroundColor,userEnteredFormat.textFormat' } },
      { repeatCell: { range: cells(1, rows + 1, 2, 3), cell: { userEnteredFormat: { numberFormat: AED } }, fields: 'userEnteredFormat.numberFormat' } },
      { addConditionalFormatRule: { index: 0, rule: { ranges: [cells(1, rows + 1, 2, 3)],
        booleanRule: { condition: { type: 'NUMBER_GREATER', values: [{ userEnteredValue: '10' }] }, format: { backgroundColor: rgb('#fde68a') } } } } },
    ] }, f.book.id);
  };
  return f;
}

test('a rerun keeps the formatting chat gave report output, so its header stays readable', () => {
  const f = fixture();
  f.run();
  f.style(2);
  assert.equal(f.run().ok, true);
  const sheet = f.sheet();
  for (const column of [1, 2, 3]) {
    const header = f.format(sheet, 1, column);
    assert.deepEqual(header.backgroundColor, SLATE, 'the header keeps the fill chat gave it');
    assert.deepEqual(header.textFormat, { bold: true, foregroundColor: WHITE });
  }
  assert.deepEqual(f.format(sheet, 2, 3).numberFormat, AED);
  assert.deepEqual(f.format(sheet, 3, 3).numberFormat, AED);
  assert.equal(f.conditionalFormats(sheet).length, 1);
});

test('rows a rerun adds take the formatting of the last row it had', () => {
  const f = fixture();
  f.run();
  f.style(2);
  f.setRows(rowsFor(4));
  f.run();
  const sheet = f.sheet();
  assert.deepEqual([2, 3, 4, 5].map((row) => f.format(sheet, row, 3).numberFormat), [AED, AED, AED, AED]);
  assert.deepEqual(f.format(sheet, 1, 1).backgroundColor, SLATE);
  assert.equal(f.shown(sheet, 5, 1), day(4));
});

test('a rerun with other columns formats the whole table afresh, never white on white', () => {
  const f = fixture();
  f.run();
  f.style(2);
  f.edit({ fields: ['date', 'cost', 'campaign'] });
  f.run();
  const sheet = f.sheet();
  assert.deepEqual(f.format(sheet, 1, 1).textFormat, { bold: true }, 'no white text is left on the light header');
  assert.deepEqual(f.format(sheet, 1, 1).backgroundColor, HEADER);
  assert.deepEqual(f.format(sheet, 2, 2).numberFormat, { type: 'NUMBER', pattern: '#,##0.00' });
  assert.deepEqual(f.format(sheet, 2, 3).numberFormat, { type: 'TEXT', pattern: '@' }, 'the old AED column now holds names');
});

test('a rerun whose numbers gain decimals shows them, never rounded by the pattern of whole ones', () => {
  const f = fixture();
  f.edit({ fields: ['date', 'campaign', 'conversions'] });
  f.setRows([{ date: day(1), campaign: 'Brand', conversions: 2 }, { date: day(2), campaign: 'Brand', conversions: 3 }]);
  f.run();
  const sheet = f.sheet();
  assert.deepEqual(f.format(sheet, 2, 3).numberFormat, { type: 'NUMBER', pattern: '#,##0' });
  f.setRows([{ date: day(1), campaign: 'Brand', conversions: 2.5 }, { date: day(2), campaign: 'Brand', conversions: 3.25 }]);
  f.run();
  assert.deepEqual(
    [2, 3].map((row) => f.format(sheet, row, 3).numberFormat),
    [{ type: 'NUMBER', pattern: '#,##0.00' }, { type: 'NUMBER', pattern: '#,##0.00' }]
  );
  // The same pattern again keeps what chat or the user gave the cells.
  f.style(2);
  f.setRows([{ date: day(1), campaign: 'Brand', conversions: 1.5 }, { date: day(2), campaign: 'Brand', conversions: 4.75 }]);
  f.run();
  assert.deepEqual(f.format(sheet, 1, 1).backgroundColor, SLATE);
});

test('a report writes plain days as real dates shown yyyy-mm-dd, and reruns, edit checks and chat still read them', () => {
  const f = fixture();
  f.setRows([{ date: day(28), campaign: 'Brand', cost: 12 }, { date: '', campaign: 'Generic', cost: 3 }]);
  f.run();
  const sheet = f.sheet();
  assert.equal(typeof f.value(sheet, 2, 1), 'number', 'the date is a date serial, not text');
  assert.equal(f.shown(sheet, 2, 1), day(28));
  assert.deepEqual(f.format(sheet, 2, 1), { numberFormat: { type: 'DATE', pattern: 'yyyy-mm-dd' }, horizontalAlignment: 'LEFT' }, 'aligned left like the text it was');
  assert.equal(f.value(sheet, 3, 1), '');
  // The ownership check reads the dates back as Sheets returns them, as dates.
  const receipt = f.readOutput(f.report.id);
  assert.equal(f.run().ok, true);
  assert.equal(f.readOutput(f.report.id).digest, receipt.digest);
  // Chat reads the column as dates.
  const session = f.api.dmvChatSession_(f.book);
  const read = plain(f.api.dmvChatReadSheet_(session, { sheetName: 'Output' }));
  assert.equal(read.columns.find((column) => column.key === 'date').type, 'date');
  assert.equal(f.api.dmvChatResult_(session, read.resultId).rows[0].date, day(28));
  // Another day typed over a written date is an edit, and stops the refresh.
  f.setCell(sheet, 2, 1, new Date('2026-09-27T00:00:00+03:00'));
  assert.throws(() => f.run(), /edited or moved/);
});

test('timestamps and date columns that are not all plain days stay text', () => {
  const f = fixture();
  f.edit({ fields: ['date', 'campaign', 'cost', 'updated'] });
  f.setRows([{ date: day(28), campaign: 'Brand', cost: 1, updated: '2026-09-28T10:00:00Z' }, { date: 'unknown', campaign: 'Generic', cost: 2, updated: day(28) }]);
  f.run();
  const sheet = f.sheet();
  assert.equal(f.value(sheet, 2, 1), day(28));
  assert.equal(f.value(sheet, 2, 4), '2026-09-28T10:00:00Z');
  assert.deepEqual(f.format(sheet, 2, 1).numberFormat, { type: 'TEXT', pattern: '@' });
});

test('impossible calendar days in date columns stay literal instead of rolling into another day', () => {
  const f = fixture();
  f.setRows([{ date: '2026-02-30', campaign: 'Brand', cost: 1 }, { date: '2026-13-01', campaign: 'Generic', cost: 2 }]);
  f.run();
  const sheet = f.sheet();
  assert.equal(f.value(sheet, 2, 1), '2026-02-30');
  assert.equal(f.shown(sheet, 2, 1), '2026-02-30');
  assert.equal(f.value(sheet, 3, 1), '2026-13-01');
  assert.deepEqual(f.format(sheet, 2, 1).numberFormat, { type: 'TEXT', pattern: '@' });
  assert.equal(f.run().ok, true, 'literal invalid dates still verify their ownership receipt');
});

test('valid early years retain their year when plain dates become serials', () => {
  const f = fixture();
  f.setRows([{ date: '0099-01-01', campaign: 'Brand', cost: 1 }]);
  f.run();
  assert.equal(f.shown(f.sheet(), 2, 1), '0099-01-01');
});

test('the prompt says report dates are dates, for month helpers and QUERY comparisons', () => {
  const f = fixture();
  const prompt = f.api.dmvChatSystemPrompt_(f.api.dmvChatSession_(f.book));
  assert.match(prompt, /Report days are date cells: a month is TEXT\(A2,"yyyy-mm"\) and QUERY compares date 'yyyy-mm-dd'\./);
});
