import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatamoovSandbox } from './helpers/datamoov-sandbox.mjs';

test('chat scopes different account instructions and suppresses a cleared legacy default', () => {
  const { api } = createDatamoovSandbox();
  const session = {
    catalog: { orchard: { label: 'Orchard' } },
    connections: [
      { id: 'account-one', label: 'First account', connectorId: 'orchard' },
      { id: 'account-two', label: 'Second account', connectorId: 'orchard' },
      { id: 'account-three', label: 'Third account', connectorId: 'orchard' },
      { id: 'account-four', label: 'Fourth account', connectorId: 'orchard' },
    ],
    sourceInstructions: { orchard: 'Legacy guidance' },
    connectionInstructions: { 'account-one': 'Use revenue', 'account-two': 'Use clicks', 'account-three': '', deleted: 'Not connected' },
  };
  const text = api.dmvChatSourceInstructions_(session).join('\n');
  assert.match(text, /First account \(connectionId "account-one"\)\nUse revenue/);
  assert.match(text, /Second account \(connectionId "account-two"\)\nUse clicks/);
  assert.match(text, /Fourth account \(connectionId "account-four"\)\nLegacy guidance/);
  assert.doesNotMatch(text, /account-three|Not connected/);
});

test('chat passes private connection overrides into its actual system prompt', () => {
  const { api, book } = createDatamoovSandbox();
  api.dmvAiRead_ = () => ({ provider: 'test', apiKey: 'fixture', connectionInstructions: { 'account-one': 'Use revenue' } });
  const originalSession = api.dmvChatSession_;
  api.dmvChatSession_ = (spreadsheet) => ({ ...originalSession(spreadsheet),
    catalog: { orchard: { label: 'Orchard', reports: [] } },
    connections: [{ id: 'account-one', label: 'First account', connectorId: 'orchard', values: {} }],
  });
  let system;
  api.dmvAiComplete_ = (_settings, request) => { system = request.system; return { text: 'Done', toolCalls: [], stop: 'end' }; };
  api.dmvChat({ text: 'Explain this account' });
  assert.match(system, /First account \(connectionId "account-one"\)\nUse revenue/);
});
