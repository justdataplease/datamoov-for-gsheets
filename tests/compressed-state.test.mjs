import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { createDatamoovSandbox, plain } from './helpers/datamoov-sandbox.mjs';

const SETTINGS = 'dmv:v1:ai:settings';
const SECRET = 'private-mime-regression-key';
const save = (f, values = {}) =>
  f.api.dmvSaveAiSettings({ provider: 'gemini', apiKey: SECRET, ...values });

function seedLegacyInstructions(f, instructions) {
  const encoded = gzipSync(
    Buffer.from(JSON.stringify({ instructions, sourceInstructions: {} }), 'utf8')
  ).toString('base64');
  const ref = { generation: 'previous-release', parts: 1, digest: f.api.dmvOutputDigest_(encoded) };
  f.state.user.setProperty('dmv:v1:ai-instructions:previous-release:0', encoded);
  f.state.user.setProperty(
    SETTINGS,
    JSON.stringify({
      id: 'settings',
      provider: 'gemini',
      apiKey: SECRET,
      model: 'gemini-3.8-flash',
      revision: 2,
      maxRows: 1000,
      instructionRef: ref,
    })
  );
}

test('previous compressed settings reopen unchanged and can be edited without entering the key again', () => {
  const f = createDatamoovSandbox();
  const instructions = 'Use EUR; \u039a\u03b1\u03bb\u03b7\u03bc\u03ad\u03c1\u03b1 \ud83d\ude80';
  seedLegacyInstructions(f, instructions);
  const before = f.state.user.getProperties();
  assert.equal(f.api.dmvAiSettings().instructions, instructions);
  assert.deepEqual(
    f.state.user.getProperties(),
    before,
    'opening must not rewrite private settings'
  );
  const updated = save(f, { apiKey: '', maxRows: 2000 });
  assert.equal(updated.maxRows, 2000);
  assert.equal(updated.instructions, instructions);
  assert.equal(f.api.dmvAiRead_().apiKey, SECRET);
  assert.ok(!JSON.stringify(updated).includes(SECRET));
});

test('a saved but corrupted new instruction piece cannot replace the last readable settings', () => {
  const f = createDatamoovSandbox();
  save(f, { instructions: 'Keep this guidance' });
  const previous = f.state.user.getProperty(SETTINGS);
  const write = f.state.user.setProperty;
  f.state.user.setProperty = (key, value) =>
    write(key, key.startsWith('dmv:v1:ai-instructions:') ? '!' + value.slice(1) : value);
  assert.throws(
    () => save(f, { instructions: 'Replacement guidance' }),
    /Could not save chat settings/
  );
  assert.equal(f.state.user.getProperty(SETTINGS), previous);
  assert.equal(f.api.dmvAiSettings().instructions, 'Keep this guidance');
  assert.equal(f.api.dmvAiRead_().apiKey, SECRET);
  f.state.user.setProperty = write;
  save(f, { instructions: 'Replacement guidance' });
  assert.equal(f.api.dmvAiSettings().instructions, 'Replacement guidance');
});

test('invalid gzip bytes with a matching checksum are rejected without clearing private settings', () => {
  const f = createDatamoovSandbox();
  seedLegacyInstructions(f, 'Keep');
  const broken = Buffer.from('not compressed data').toString('base64');
  const record = JSON.parse(f.state.user.getProperty(SETTINGS));
  record.instructionRef.digest = f.api.dmvOutputDigest_(broken);
  f.state.user.setProperty('dmv:v1:ai-instructions:previous-release:0', broken);
  f.state.user.setProperty(SETTINGS, JSON.stringify(record));
  const before = f.state.user.getProperties();
  assert.throws(() => f.api.dmvAiSettings(), /missing or damaged/);
  assert.throws(() => save(f, { instructions: 'New' }), /missing or damaged/);
  assert.deepEqual(f.state.user.getProperties(), before);
});

test('continuation snapshots restore with gzip metadata and retain their original contents', () => {
  const f = createDatamoovSandbox();
  const report = { id: 'checkpoint-fixture', spreadsheetId: f.book.getId(), revision: 1 };
  const snapshot = {
    version: 1,
    reportId: report.id,
    spreadsheetId: report.spreadsheetId,
    revision: 1,
    createdAt: f.api.Date.now(),
    result: {
      columns: [{ key: 'name', type: 'text' }],
      rows: [{ name: '\u039a\u03b1\u03bb\u03b7\u03bc\u03ad\u03c1\u03b1' }],
      metadata: { complete: false },
    },
  };
  f.api.dmvSaveContinuation_(report, snapshot);
  const before = f.state.user.getProperties();
  assert.deepEqual(plain(f.api.dmvReadContinuation_(report)), snapshot);
  assert.deepEqual(f.state.user.getProperties(), before);
});
