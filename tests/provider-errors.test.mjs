import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createDatamoovSandbox } from './helpers/datamoov-sandbox.mjs';

function ads() {
  const f = createDatamoovSandbox();
  vm.runInContext(readFileSync(new URL('../src/connectors/google_ads.js', import.meta.url), 'utf8'), f.api);
  return f;
}

test('generic context uses connector-provided static authorization guidance without provider switches', () => {
  const f = createDatamoovSandbox();
  const connector = { allowedHosts: ['orchard.example'], errorMessage(code, body) {
    assert.equal(code, 403);
    return body.error.reason === 'PROJECT_APPROVAL' ? 'Approve this project in the provider console.' : '';
  } };
  f.state.responses.push({ code: 403, body: { error: { reason: 'PROJECT_APPROVAL', message: 'PRIVATE_SECRET' } } });
  const ctx = f.api.dmvContext_(connector, { credentials: {} }, {}, {});
  assert.throws(() => ctx.http({ url: 'https://orchard.example/query' }), /^Error: Approve this project in the provider console\.$/);
  assert.equal(f.state.http.length, 1);
});

test('malformed, oversized and throwing authorization mappings retain safe generic fallback', () => {
  for (const value of ['PRIVATE_SECRET', 'x'.repeat(100001), { error: { message: 'PRIVATE_SECRET' } }]) {
    const f = createDatamoovSandbox();
    f.state.responses.push({ code: 403, body: value });
    assert.throws(() => f.api.dmvHttp_({ url: 'https://orchard.example/query' }, ['orchard.example'], f.api.Date.now() + 30000,
      () => { throw new Error('PRIVATE_SECRET'); }), error => /HTTP 403/.test(error.message) && !error.message.includes('PRIVATE_SECRET'));
  }
});

test('Google Ads fixed messages distinguish project approval and account authorization without raw payload leakage', () => {
  for (const [code, expected] of [['CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION', /Explorer access/], ['USER_PERMISSION_DENIED', /Find accounts/], ['UNRECOGNIZED_PRIVATE_SECRET', /HTTP 403/]]) {
    const f = ads();
    f.state.responses.push({ code: 403, body: { error: { message: 'PRIVATE_SECRET', details: [{ errors: [{
      errorCode: { authorizationError: code }, message: 'PRIVATE_SECRET', trigger: 'PRIVATE_SECRET',
    }] }] } } });
    assert.throws(() => f.api.dmvDiscoverAccounts({ connectorId: 'google_ads', credentials: { authMode: 'token', accessToken: 'g-offline-token' } }),
      error => expected.test(error.message) && !error.message.includes('PRIVATE_SECRET'));
  }
});

test('Ads discovery, save verification and subsequent test work without legacy developer token', () => {
  const f = ads();
  const id = '1234567890';
  f.state.responses.push({ body: { resourceNames: ['customers/' + id] } }, { body: { results: [{ customerClient: {
    id, descriptiveName: 'Native account', manager: false, status: 'ENABLED',
  } }] } });
  const discovered = f.api.dmvDiscoverAccounts({ connectorId: 'google_ads', credentials: { authMode: 'token', accessToken: 'g-offline-token' } });
  assert.equal(discovered.accounts[0].credentials.customerId, id);
  f.state.responses.push({ body: { results: [{ customer: { id } }] } });
  const saved = f.api.dmvSaveConnection({ connectorId: 'google_ads', label: 'Token account', credentials: { authMode: 'token', accessToken: 'g-offline-token', customerId: id } });
  assert.equal(saved.verified, true);
  f.state.responses.push({ body: { results: [{ customer: { id } }] } });
  assert.equal(f.api.dmvTestConnection(saved.id).ok, true);
  assert.ok(f.state.http.every(call => !Object.hasOwn(call.options.headers, 'developer-token')));
  const field = f.api.dmvConnector_('google_ads').authFields.find(field => field.key === 'developerToken');
  assert.equal(field.required, false);
  assert.equal(field.type, 'password');
});
