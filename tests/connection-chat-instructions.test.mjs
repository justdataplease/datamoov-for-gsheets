import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatamoovSandbox, plain } from './helpers/datamoov-sandbox.mjs';

function fixture(configured = true) {
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
  const first = f.api.dmvSaveConnection({
    connectorId: 'orchard',
    label: 'First account',
    credentials: {},
  });
  const second = f.api.dmvSaveConnection({
    connectorId: 'orchard',
    label: 'Second account',
    credentials: {},
  });
  if (configured)
    f.api.dmvSaveAiSettings({
      provider: 'gemini',
      apiKey: 'private-connection-instructions-key',
      instructions: 'General',
      sourceInstructions: { orchard: 'Legacy source default' },
    });
  return { ...f, first, second };
}
const read = (f, id = f.first.id) => plain(f.api.dmvConnectionChatInstructions(id));
const save = (f, instructions, id = f.first.id) =>
  f.api.dmvSaveConnectionChatInstructions({
    connectionId: id,
    instructions,
    revision: read(f, id).revision,
  });

test('connections inherit legacy defaults until overridden, including an explicit empty override', () => {
  const f = fixture();
  const inherited = read(f);
  assert.equal(inherited.inherited, true);
  assert.equal(inherited.instructions, '');
  assert.equal(inherited.effectiveInstructions, 'Legacy source default');
  assert.equal(inherited.replacedCharacters, 0);
  assert.equal(inherited.totalCharacters, 'GeneralLegacy source default'.length);
  assert.equal(inherited.maxCharacters, 100000);
  const originalConnection = f.state.user.getProperty('dmv:v1:connection:' + f.first.id);
  const updated = save(f, 'Only the first account');
  assert.equal(updated.inherited, false);
  assert.equal(updated.effectiveInstructions, 'Only the first account');
  assert.equal(updated.replacedCharacters, 'Only the first account'.length);
  assert.equal(read(f, f.second.id).effectiveInstructions, 'Legacy source default');
  assert.equal(
    f.api.dmvAiConnectionInstructions_(f.api.dmvAiRead_(), f.first),
    'Only the first account'
  );
  assert.equal(
    f.api.dmvAiConnectionInstructions_(f.api.dmvAiRead_(), f.second),
    'Legacy source default'
  );
  save(f, '');
  assert.equal(read(f).inherited, false);
  assert.equal(read(f).effectiveInstructions, '');
  assert.equal(f.api.dmvAiConnectionInstructions_(f.api.dmvAiRead_(), f.first), '');
  assert.equal(read(f, f.second.id).effectiveInstructions, 'Legacy source default');
  assert.equal(f.state.user.getProperty('dmv:v1:connection:' + f.first.id), originalConnection);
  assert.equal(f.state.http.length, 0, 'editing instructions never checks provider credentials');
});

test('general, legacy source and connection instructions share one 100,000 character budget', () => {
  const f = fixture();
  f.api.dmvSaveAiSettings({
    provider: 'gemini',
    instructions: 'a'.repeat(30000),
    sourceInstructions: { orchard: 'b'.repeat(20000) },
  });
  f.api.dmvSaveConnection({ connectorId: 'orchard', label: 'Retain default', credentials: {} });
  save(f, 'c'.repeat(30000));
  save(f, 'd'.repeat(20000), f.second.id);
  assert.equal(read(f).totalCharacters, 100000);
  assert.equal(f.api.dmvAiSettings().instructionCharacters, 100000);
  assert.equal(f.api.dmvAiSettings().maxInstructionCharacters, 100000);
  const before = f.state.user.getProperties();
  assert.throws(() => save(f, 'd'.repeat(20001), f.second.id), /100,000 characters/);
  assert.deepEqual(f.state.user.getProperties(), before);
  assert.throws(
    () => f.api.dmvSaveAiSettings({ provider: 'gemini', instructions: 'a'.repeat(30001) }),
    /100,000 characters/
  );
  assert.deepEqual(f.state.user.getProperties(), before);
});

test('settings saves retain connection overrides and stale instruction drafts cannot overwrite changes', () => {
  const f = fixture();
  save(f, 'Keep first');
  const stale = read(f);
  f.api.dmvSaveAiSettings({
    provider: 'gemini',
    maxRows: 3000,
    connectionInstructions: { [f.first.id]: 'Ignore client map' },
  });
  assert.equal(read(f).effectiveInstructions, 'Keep first');
  assert.throws(
    () =>
      f.api.dmvSaveConnectionChatInstructions({
        connectionId: f.first.id,
        instructions: 'Stale',
        revision: stale.revision,
      }),
    /settings changed/
  );
  const next = read(f);
  save(f, 'Second override', f.second.id);
  assert.throws(
    () =>
      f.api.dmvSaveConnectionChatInstructions({
        connectionId: f.first.id,
        instructions: 'Stale again',
        revision: next.revision,
      }),
    /settings changed/
  );
  assert.equal(read(f).effectiveInstructions, 'Keep first');
  assert.throws(
    () =>
      f.api.dmvSaveConnectionChatInstructions({
        connectionId: f.first.id,
        instructions: 'Missing revision',
      }),
    /settings changed/
  );
});

test('failed connection-instruction chunk or pointer writes preserve the previous settings', () => {
  for (const failPointer of [false, true]) {
    const f = fixture();
    save(f, 'Original override');
    const originalSet = f.state.user.setProperty;
    f.state.user.setProperty = (key, value) => {
      if (
        (failPointer && key === 'dmv:v1:ai:settings') ||
        (!failPointer && key.startsWith('dmv:v1:ai-instructions:'))
      )
        throw new Error('Private storage unavailable');
      return originalSet(key, value);
    };
    assert.throws(() => save(f, 'Replacement override'), /Could not save/);
    assert.equal(read(f).effectiveInstructions, 'Original override');
    f.state.user.setProperty = originalSet;
    save(f, 'Replacement override');
    assert.equal(read(f).effectiveInstructions, 'Replacement override');
  }
});

test('connection instruction APIs remain private, reject nonexistent connections and require AI setup', () => {
  const f = fixture(false);
  assert.equal(read(f).configured, false);
  assert.equal(read(f).totalCharacters, 0);
  assert.throws(() => save(f, 'Not configured'), /AI provider and API key/);
  assert.throws(() => read(f, 'another-users-connection'), /no longer exists/);
  assert.throws(
    () =>
      f.api.dmvSaveConnectionChatInstructions({
        connectionId: 'another-users-connection',
        instructions: 'x',
        revision: 0,
      }),
    /no longer exists/
  );
  f.api.dmvSaveAiSettings({ provider: 'gemini', apiKey: 'private-connection-instructions-key' });
  save(f, 'Private account rule');
  assert.ok(!JSON.stringify(read(f)).includes('private-connection-instructions-key'));
  assert.deepEqual(f.state.script.getProperties(), {});
  assert.deepEqual(f.state.document.getProperties(), {});
  assert.equal(f.state.http.length, 0);
  assert.equal(f.state.lockAcquires, f.state.lockReleases);
});

test('connection instructions validate values, stay outside the small settings record and tolerate deleted connections', () => {
  const f = fixture();
  const before = f.state.user.getProperties();
  for (const value of [null, 4, {}, []]) assert.throws(() => save(f, value), /must be text/);
  assert.deepEqual(f.state.user.getProperties(), before);
  save(f, 'x'.repeat(20000));
  const raw = JSON.parse(f.state.user.getProperty('dmv:v1:ai:settings'));
  assert.equal(raw.connectionInstructions, undefined);
  assert.ok(raw.instructionRef);
  f.state.user.deleteProperty('dmv:v1:connection:' + f.first.id);
  assert.equal(f.api.dmvAiSettings().connectionInstructions[f.first.id], undefined);
  assert.equal(f.api.dmvAiSettings().instructionCharacters, 'GeneralLegacy source default'.length);
  f.api.dmvSaveAiSettings({ provider: 'gemini', debug: false });
  const stored = JSON.parse(f.state.user.getProperty('dmv:v1:ai:settings'));
  const instructions = f.api.dmvAiReadInstructions_(
    stored.instructionRef,
    f.state.user.getProperties()
  );
  assert.equal(instructions.connectionInstructions[f.first.id], undefined);
  assert.equal(f.api.dmvAiSettings().configured, true);
  assert.throws(() => read(f), /no longer exists/);
});

test('a sole inheriting connection can replace a 100,000 character legacy default', () => {
  const f = fixture();
  f.state.user.deleteProperty('dmv:v1:connection:' + f.second.id);
  f.api.dmvSaveAiSettings({
    provider: 'gemini',
    instructions: '',
    sourceInstructions: { orchard: 'a'.repeat(100000) },
  });
  const summary = read(f);
  assert.equal(summary.totalCharacters, 100000);
  assert.equal(summary.replacedCharacters, 100000);
  const saved = save(f, 'b'.repeat(100000));
  assert.equal(saved.totalCharacters, 100000);
  assert.equal(saved.effectiveInstructions, 'b'.repeat(100000));
  assert.equal(f.api.dmvAiSettings().sourceInstructions.orchard, undefined);
});

test('a legacy default survives while another account inherits and is removed after the last migration', () => {
  const f = fixture();
  assert.equal(read(f).replacedCharacters, 0);
  save(f, 'First account override');
  assert.equal(f.api.dmvAiSettings().sourceInstructions.orchard, 'Legacy source default');
  const last = read(f, f.second.id);
  assert.equal(last.inherited, true);
  assert.equal(last.replacedCharacters, 'Legacy source default'.length);
  save(f, 'Second account override', f.second.id);
  assert.equal(f.api.dmvAiSettings().sourceInstructions.orchard, undefined);
  assert.equal(read(f).effectiveInstructions, 'First account override');
  assert.equal(read(f, f.second.id).effectiveInstructions, 'Second account override');
  assert.equal(
    read(f).totalCharacters,
    'GeneralFirst account overrideSecond account override'.length
  );
});
