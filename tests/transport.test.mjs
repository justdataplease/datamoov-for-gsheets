import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createHash, createSign, createVerify, generateKeyPairSync } from 'node:crypto';

function transport(sequence = []) {
  const requests = [], sleeps = [], cache = new Map();
  const context = vm.createContext({
    UrlFetchApp: { fetch(url, options) { requests.push({url, options}); const response = sequence.shift(); if (response instanceof Error) throw response; if (!response) throw new Error('Unexpected request'); return {getResponseCode: () => response.code ?? 200, getContentText: () => response.raw ?? JSON.stringify(response.body ?? {}), getAllHeaders: () => response.headers ?? {}}; } },
    Utilities: {
      sleep: milliseconds => sleeps.push(milliseconds),
      DigestAlgorithm: { SHA_256: 'sha256' },
      computeDigest: (algorithm, text) => [...createHash(algorithm).update(text).digest()],
      base64EncodeWebSafe: data => Buffer.from(data).toString('base64url'),
      computeRsaSha256Signature: (text, key) => [...createSign('RSA-SHA256').update(text).sign(key)],
    },
    ScriptApp: { getOAuthToken: () => 'native-google-token' },
    CacheService: {getUserCache: () => ({get: key => cache.get(key), put: (key, value) => cache.set(key, value)})},
  });
  for (const file of ['dmv_core.js', 'dmv_http.js']) new vm.Script(readFileSync(new URL('../src/' + file, import.meta.url), 'utf8')).runInContext(context);
  const fetch = (request) => context.dmvHttp_(request, ['provider.example'], Date.now() + 240000);
  return {context, requests, sleeps, fetch};
}

test('HTTP refuses foreign origins and redirects without forwarding credentials', () => {
  const t = transport([{code: 302}]);
  assert.throws(() => t.fetch({url: 'https://evil.example/data', headers: {Authorization: 'secret'}}), /outside/);
  assert.throws(() => t.fetch({url: 'http://provider.example/data'}), /HTTPS/);
  assert.throws(() => t.fetch({url: 'https://provider.example@evil.example/data'}), /HTTPS/);
  assert.equal(t.requests.length, 0);
  assert.throws(() => t.fetch({url: 'https://provider.example/data'}), /redirected/);
  assert.equal(t.requests[0].options.followRedirects, false);
});

test('HTTP retries safe reads and honors Retry-After while preserving request payload', () => {
  const t = transport([{code: 429, headers: {'Retry-After': '2'}}, {body: {rows: []}}]);
  const result = t.fetch({url: 'https://provider.example/report', method: 'post', retrySafe: true, body: {limit: 5}});
  assert.equal(result.rows.length, 0);
  assert.deepEqual(t.sleeps, [2000]);
  assert.equal(t.requests[0].options.payload, '{"limit":5}');
  assert.equal(t.requests.length, 2);
});

test('HTTP does not retry auth failures or potentially mutating POSTs', () => {
  for (const code of [401,403]) {
    const t = transport([{code}]);
    assert.throws(() => t.fetch({url: 'https://provider.example/data'}), /Access denied/);
    assert.equal(t.requests.length, 1);
  }
  const t = transport([{code: 503}]);
  assert.throws(() => t.fetch({url: 'https://provider.example/jobs', method: 'post', body: {query: 'SELECT 1'}}), /503/);
  assert.equal(t.requests.length, 1);
});

test('HTTP retries transient connection failures only for declared safe operations', () => {
  const t = transport([new Error('private detail'), {body: {ok:true}}]);
  assert.equal(t.fetch({url:'https://provider.example/report'}).ok,true);
  assert.deepEqual(t.sleeps,[1000]);
  const write = transport([new Error('credential-bearing private detail')]);
  assert.throws(() => write.fetch({url:'https://provider.example/jobs',method:'post'}), error => !error.message.includes('credential-bearing'));
  assert.equal(write.requests.length,1);
});

test('HTTP refuses long rate-limit waits, exhausted deadlines and malformed responses', () => {
  const t = transport([{code:429, headers:{'Retry-After':'300'}}]);
  assert.throws(() => t.fetch({url:'https://provider.example/data'}), /rate-limited/);
  assert.equal(t.sleeps.length,0);
  assert.throws(() => t.context.dmvHttp_({url:'https://provider.example/data'},['provider.example'],Date.now()),/time limit/);
  const bad = transport([{raw:'<html>bad gateway</html>'}]);
  assert.throws(() => bad.fetch({url:'https://provider.example/data'}), /unreadable/);
});

test('Google tokens come only from the connection; there is no add-on identity fallback', () => {
  const t = transport();
  assert.throws(() => t.context.dmvGoogleToken_({},['scope'],Date.now()+100000),/authorization method/);
  assert.equal(t.context.dmvGoogleToken_({authMode:'token',accessToken:'manual-token'},['scope'],Date.now()+100000),'manual-token');
  assert.equal(t.requests.length,0);
  assert.throws(() => t.context.dmvGoogleToken_({authMode:'token'},[],Date.now()+100000),/required/);
});

test('service-account JWT uses the fixed Google endpoint, intended scopes, signature and private cache', () => {
  const {privateKey,publicKey} = generateKeyPairSync('rsa',{modulusLength:2048});
  const credentials = {authMode:'service_account', serviceAccountJson:JSON.stringify({type:'service_account',client_email:'test@example.iam.gserviceaccount.com',private_key:privateKey.export({type:'pkcs8',format:'pem'}),token_uri:'https://evil.example'})};
  const t = transport([{body:{access_token:'service-token',expires_in:3600}}]);
  const token = t.context.dmvGoogleToken_(credentials,['scope-a','scope-b'],Date.now()+240000);
  assert.equal(token,'service-token');
  assert.equal(t.requests[0].url,'https://oauth2.googleapis.com/token');
  const assertion = new URLSearchParams(t.requests[0].options.payload).get('assertion');
  const [header,body,signature] = assertion.split('.');
  const payload = JSON.parse(Buffer.from(body,'base64url'));
  assert.equal(payload.scope,'scope-a scope-b');
  assert.equal(payload.aud,'https://oauth2.googleapis.com/token');
  assert.equal(payload.exp-payload.iat,3600);
  assert.ok(createVerify('RSA-SHA256').update(header+'.'+body).verify(publicKey,Buffer.from(signature,'base64url')));
  assert.equal(t.context.dmvGoogleToken_(credentials,['scope-a','scope-b'],Date.now()+240000),'service-token');
  assert.equal(t.requests.length,1);
});
