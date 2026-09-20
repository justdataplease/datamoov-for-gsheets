import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatamoovSandbox } from './helpers/datamoov-sandbox.mjs';

const plain = (value) => JSON.parse(JSON.stringify(value));
const titles = (f) => f.book.server.sheets.map((sheet) => sheet.name);
const welcomeRequests = (f) =>
  f.state.batches.flatMap((batch) => batch.body.requests).filter(Boolean);

test('opening the workspace only reports that the page is owed; it writes nothing', () => {
  const f = createDatamoovSandbox();
  const first = plain(f.api.dmvBootstrap());
  assert.deepEqual(first.welcome, { offer: true, sheetName: 'Start here' });
  // Bootstrap is a read: no Sheets batch, no legacy write, no private record.
  assert.equal(f.state.batches.length, 0);
  assert.equal(f.state.legacyWrites.length, 0);
  assert.equal(f.state.user.data.size, 0);
  assert.deepEqual(titles(f), ['Output']);
  // Repeating it changes nothing.
  assert.deepEqual(plain(f.api.dmvBootstrap()).welcome, { offer: true, sheetName: 'Start here' });
  assert.equal(f.state.batches.length, 0);
});

test('the first open writes one Start here page and never offers it again', () => {
  const f = createDatamoovSandbox();
  const page = plain(f.api.dmvCreateWelcome());
  assert.equal(page.sheetName, 'Start here');
  assert.match(page.url, /^https:\/\/docs\.google\.com\/spreadsheets\/d\/spreadsheet-one\/edit#gid=\d+&range=A1$/);
  assert.deepEqual(titles(f), ['Output', 'Start here']);
  // One atomic batch, never a direct SpreadsheetApp write.
  assert.equal(f.state.batches.length, 1);
  assert.equal(f.state.legacyWrites.length, 0);

  const requests = welcomeRequests(f);
  const added = requests.find((request) => request.addSheet);
  assert.equal(added.addSheet.properties.title, 'Start here');
  assert.equal(added.addSheet.properties.gridProperties.hideGridlines, true);
  const cells = requests.filter((request) => request.updateCells);
  const lines = cells.map((request) => request.updateCells.rows[0].values[0].userEnteredValue.stringValue);
  assert.equal(lines[0], 'DataMoov');
  assert.ok(lines.some((line) => line.startsWith('1')), 'the page is numbered steps');
  assert.ok(lines.some((line) => line.startsWith('5')));
  // The page explains the product without naming a source, because that list changes.
  const prose = lines.join(' ');
  for (const source of ['Google Ads', 'Facebook', 'LinkedIn', 'BigQuery', 'Snowflake', 'HubSpot'])
    assert.ok(!prose.includes(source), 'the page must not list integrations: ' + source);
  assert.ok(prose.includes('no DataMoov server'), 'the page states there is no backend');

  // Offered once: a second open, and a user who deleted the tab, are both left alone.
  assert.deepEqual(plain(f.api.dmvBootstrap()).welcome, { offer: false, sheetName: 'Start here' });
  assert.equal(f.api.dmvCreateWelcome(), null);
  assert.equal(f.state.batches.length, 1);
});

test('a colleague who opens DataMoov second adopts the existing page instead of duplicating it', () => {
  const f = createDatamoovSandbox();
  f.api.dmvCreateWelcome();
  assert.equal(f.state.batches.length, 1);

  // A second Google user shares the workbook but not UserProperties, and their Spreadsheet
  // object predates the tab, so the check has to reach the server rather than trust it.
  const other = createDatamoovSandbox();
  other.state.books.set(f.book.id, f.book.server);
  other.setActive(f.book);
  assert.deepEqual(plain(other.api.dmvBootstrap()).welcome, { offer: true, sheetName: 'Start here' });
  assert.equal(other.api.dmvCreateWelcome(), null);
  assert.equal(other.state.batches.length, 0);
  assert.deepEqual(titles(f), ['Output', 'Start here']);
  // Recorded as seen, so it is not retried on every open.
  assert.deepEqual(plain(other.api.dmvBootstrap()).welcome, { offer: false, sheetName: 'Start here' });
});

test('a failed write leaves no record, so the next open tries again', () => {
  const f = createDatamoovSandbox();
  f.state.failBatch = true;
  assert.equal(f.api.dmvCreateWelcome(), null);
  assert.equal(f.state.user.data.size, 0, 'nothing is recorded when the page was not written');
  assert.deepEqual(plain(f.api.dmvBootstrap()).welcome, { offer: true, sheetName: 'Start here' });

  f.state.failBatch = false;
  assert.equal(plain(f.api.dmvCreateWelcome()).sheetName, 'Start here');
  assert.deepEqual(titles(f), ['Output', 'Start here']);
});
