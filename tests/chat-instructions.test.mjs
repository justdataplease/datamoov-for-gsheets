import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatamoovSandbox, plain } from './helpers/datamoov-sandbox.mjs';

function fixture() {
  const f = createDatamoovSandbox();
  f.api.dmvRegisterConnector_({
    id: 'orchard',
    label: 'Orchard',
    authFields: [],
    reports: [
      {
        id: 'rows',
        label: 'Rows',
        fields: [{ key: 'n', type: 'number' }],
        fetch() {
          return {
            columns: [{ key: 'n', type: 'number' }],
            rows: [],
            metadata: { complete: true },
          };
        },
      },
    ],
  });
  return f;
}
function text(length) {
  let seed = 123456789;
  return Array.from({ length }, () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return String.fromCharCode(256 + ((seed >>> 0) % 1500));
  }).join('');
}
const save = (f, input = {}) =>
  f.api.dmvSaveAiSettings({
    provider: 'gemini',
    apiKey: 'private-instructions-fixture-key',
    ...input,
  });
const read = (f) => plain(f.api.dmvAiSettings());

test('100,000 combined Unicode characters round-trip privately in bounded chunks', () => {
  const f = fixture(),
    general = text(20000),
    source = text(80000);
  save(f, { instructions: general, sourceInstructions: { orchard: source }, maxRows: 5000 });
  const output = read(f);
  assert.equal(output.instructions, general);
  assert.equal(output.sourceInstructions.orchard, source);
  assert.equal(output.maxRows, 5000);
  const all = f.state.user.getProperties();
  assert.ok(Object.keys(all).filter((key) => key.startsWith('dmv:v1:ai-instructions:')).length > 1);
  assert.ok(Object.values(all).every((value) => Buffer.byteLength(value, 'utf8') <= 8000));
  assert.deepEqual(f.state.script.getProperties(), {});
  assert.deepEqual(f.state.document.getProperties(), {});
  assert.ok(!JSON.stringify(output).includes('private-instructions-fixture-key'));
  assert.equal(createDatamoovSandbox().api.dmvAiSettings().configured, false);
});

test('combined budget and invalid source maps are rejected before changing saved settings', () => {
  const f = fixture();
  save(f, { instructions: 'General', sourceInstructions: { orchard: 'Source' } });
  const before = f.state.user.getProperties();
  for (const input of [
    { instructions: 'a'.repeat(60000), sourceInstructions: { orchard: 'b'.repeat(40001) } },
    { instructions: 'a'.repeat(100001) },
    { sourceInstructions: { missing: 'x' } },
    { sourceInstructions: { orchard: { text: 'wrong' } } },
    { sourceInstructions: JSON.parse('{"__proto__":"injected"}') },
    { sourceInstructions: [] },
  ]) {
    assert.throws(() => save(f, input));
    assert.deepEqual(f.state.user.getProperties(), before);
  }
});

test('interrupted piece or pointer writes retain old settings and retry cleans orphan generations', () => {
  for (const failPointer of [false, true]) {
    const f = fixture();
    save(f, { instructions: 'Original', sourceInstructions: { orchard: 'Keep' } });
    const before = read(f),
      original = f.state.user.setProperty;
    let pieces = 0;
    f.state.user.setProperty = (key, value) => {
      if (
        (failPointer && key === 'dmv:v1:ai:settings') ||
        (!failPointer && key.startsWith('dmv:v1:ai-instructions:') && ++pieces === 2)
      )
        throw new Error('Write failed');
      return original(key, value);
    };
    assert.throws(
      () => save(f, { instructions: text(30000), sourceInstructions: {} }),
      /Could not save/
    );
    assert.deepEqual(read(f), before);
    f.state.user.setProperty = original;
    save(f, { instructions: 'Replacement', sourceInstructions: {} });
    assert.equal(read(f).instructions, 'Replacement');
    const all = f.state.user.getProperties(),
      ref = JSON.parse(all['dmv:v1:ai:settings']).instructionRef;
    assert.ok(
      Object.keys(all)
        .filter((key) => key.startsWith('dmv:v1:ai-instructions:'))
        .every((key) => key.includes(ref.generation))
    );
  }
});

test('legacy inline instructions migrate, omitted source drafts remain and provider removal cleans pieces', () => {
  const f = fixture();
  f.state.user.setProperty(
    'dmv:v1:ai:settings',
    JSON.stringify({
      id: 'settings',
      provider: 'gemini',
      apiKey: 'private-instructions-fixture-key',
      model: 'fixture',
      instructions: 'Legacy',
      revision: 1,
    })
  );
  save(f, { apiKey: '', sourceInstructions: { orchard: 'Provider notes' } });
  assert.equal(read(f).instructions, 'Legacy');
  const priorGeneration = JSON.parse(f.state.user.getProperty('dmv:v1:ai:settings')).instructionRef
    .generation;
  save(f, { apiKey: '', maxRows: 8000 });
  assert.equal(
    JSON.parse(f.state.user.getProperty('dmv:v1:ai:settings')).instructionRef.generation,
    priorGeneration,
    'unchanged instruction pieces are reused'
  );
  assert.equal(read(f).sourceInstructions.orchard, 'Provider notes');
  f.state.user.setProperty('unrelated', 'keep');
  f.api.dmvDeleteAiSettings();
  assert.deepEqual(f.state.user.getProperties(), { unrelated: 'keep' });
});

test('quota exhaustion preserves active instruction pieces and missing chunks fail closed', () => {
  const f = fixture();
  save(f, { instructions: 'Original' });
  const ref = JSON.parse(f.state.user.getProperty('dmv:v1:ai:settings')).instructionRef;
  f.state.user.setProperty('existing-private-state', 'x'.repeat(445000));
  assert.throws(() => save(f, { instructions: text(40000) }), /Private settings storage is full/);
  assert.equal(read(f).instructions, 'Original');
  f.state.user.deleteProperty('dmv:v1:ai-instructions:' + ref.generation + ':0');
  assert.throws(() => f.api.dmvAiSettings(), /missing or damaged/);
});
