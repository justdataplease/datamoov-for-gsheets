import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatamoovSandbox, plain } from './helpers/datamoov-sandbox.mjs';

function fixture() {
  const f = createDatamoovSandbox();
  f.session = f.api.dmvChatSession_(f.book);
  const resultId = f.api.dmvChatStoreResult_(f.session, {
    columns: [{ key: 'spend', label: 'Spend', type: 'number' }],
    rows: [{ spend: 42 }],
    metadata: { complete: true },
  });
  f.write = () =>
    f.api.dmvChatRunTool_(f.session, f.api.dmvChatTools_(f.session), {
      name: 'write_to_sheet',
      id: 'write',
      input: { resultId, sheetName: 'Completed output' },
    });
  return f;
}

test('receipt cleanup failure after a committed write preserves its output status and link', () => {
  const f = fixture();
  f.api.dmvChatPruneReceipts_ = () => {
    throw new Error('Receipt cleanup failed');
  };
  const result = f.write();
  assert.equal(result.isError, true);
  assert.match(JSON.parse(result.content).error, /Receipt cleanup failed/);
  assert.equal(f.state.batches.length, 1);
  const sheet = f.book.getSheetByName('Completed output');
  assert.equal(sheet.getRange(2, 1).getValues()[0][0], 42);
  assert.deepEqual(plain(f.session.events.map((event) => event.kind)), ['write', 'error']);
  const write = f.session.events[0];
  assert.match(write.text, /Updated Completed output/);
  assert.equal(write.links.length, 1);
  assert.match(write.links[0].url, new RegExp('#gid=' + sheet.getSheetId() + '&range=A1$'));
  assert.match(f.session.events[1].text, /Receipt cleanup failed/);
});

test('a failed Sheets batch never produces a committed-output event', () => {
  const f = fixture();
  f.state.failBatch = true;
  const result = f.write();
  assert.equal(result.isError, true);
  assert.equal(f.book.getSheetByName('Completed output'), null);
  assert.deepEqual(plain(f.session.events.map((event) => event.kind)), ['error']);
});
