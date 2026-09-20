import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const credentials = { authMode: 'oauth', clientId: 'client-fixture', clientSecret: 'secret-fixture', refreshToken: 'refresh-fixture' };
function fixture(sequence = []) {
  let now = Date.parse('2026-09-19T12:00:00Z'), currentUser = 'one', nativeCalls = 0;
  const requests = [], puts = [], caches = new Map();
  const userCache = () => { if (!caches.has(currentUser)) caches.set(currentUser, new Map()); return caches.get(currentUser); };
  class ClockDate extends Date { static now() { return now; } }
  const context = vm.createContext({
    Date: ClockDate,
    Utilities: { DigestAlgorithm: { SHA_256: 'sha256' },
      computeDigest: (algorithm, value) => [...createHash(algorithm).update(value).digest()],
      base64EncodeWebSafe: value => Buffer.from(value).toString('base64url'),
      sleep() { throw new Error('Unexpected retry'); } },
    ScriptApp: { getOAuthToken() { nativeCalls++; return 'native-fixture'; } },
    CacheService: { getUserCache() { return { get: key => userCache().get(key), put(key, token, ttl) { puts.push({ key, token, ttl, user: currentUser }); userCache().set(key, token); } }; } },
    UrlFetchApp: { fetch(url, options) {
      requests.push({ url, options });
      const reply = sequence.shift();
      if (reply instanceof Error) throw reply;
      if (!reply) throw new Error('Unexpected network request');
      now += reply.elapsed || 0;
      return { getResponseCode: () => reply.code ?? 200, getContentText: () => reply.raw ?? JSON.stringify(reply.body ?? {}), getAllHeaders: () => reply.headers || {} };
    } },
  });
  for (const name of ['dmv_core.js', 'dmv_http.js']) vm.runInContext(readFileSync(new URL('../src/' + name, import.meta.url), 'utf8'), context);
  return { context, requests, puts, caches, nativeCalls: () => nativeCalls,
    setUser: value => { currentUser = value; },
    token: (values = credentials, scopes = ['scope-a'], deadline = now + 240000) => context.dmvGoogleToken_(values, scopes, deadline),
    now: () => now };
}

test('OAuth refresh sends encoded credentials only in a form body to the fixed Google endpoint', () => {
  const f = fixture([{ body: { access_token: 'access-fixture', expires_in: 3600 } }]);
  const values = { ...credentials, clientId: 'client+&=', clientSecret: 'secret &+=%/值', refreshToken: 'refresh?&/+=$', tokenUri: 'https://evil.example/token' };
  assert.equal(f.token(values), 'access-fixture');
  assert.equal(f.requests.length, 1);
  const request = f.requests[0];
  assert.equal(request.url, 'https://oauth2.googleapis.com/token');
  assert.equal(request.options.method, 'post');
  assert.equal(request.options.contentType, 'application/x-www-form-urlencoded');
  assert.equal(request.options.followRedirects, false);
  assert.equal(request.options.validateHttpsCertificates, true);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(request.options.payload)), {
    client_id: values.clientId, client_secret: values.clientSecret, refresh_token: values.refreshToken, grant_type: 'refresh_token',
  });
  assert.equal(f.nativeCalls(), 0);
  assert.equal(f.puts[0].ttl, 3300);
});

test('missing, nonstring and oversized OAuth credentials fail before network or native fallback', () => {
  for (const name of ['clientId', 'clientSecret', 'refreshToken']) {
    for (const value of [undefined, '', '   ', 123, {}, 'x'.repeat(12001)]) {
      const f = fixture();
      assert.throws(() => f.token({ ...credentials, [name]: value }), /needs a client ID/);
      assert.equal(f.requests.length, 0);
      assert.equal(f.nativeCalls(), 0);
    }
  }
});

test('cache isolates users, every credential and unambiguous scope tuples', () => {
  const variants = [credentials, { ...credentials, clientId: 'other-client' }, { ...credentials, clientSecret: 'other-secret' }, { ...credentials, refreshToken: 'other-refresh' }];
  const f = fixture(Array.from({ length: 8 }, (_, i) => ({ body: { access_token: 'access-' + i, expires_in: 3600 } })));
  for (const value of variants) f.token(value);
  f.token(credentials, ['scope-b']);
  f.token(credentials, ['scope a']);
  f.token(credentials, ['scope', 'a']);
  assert.equal(f.token(credentials), 'access-0');
  assert.equal(f.requests.length, 7);
  assert.equal(new Set(f.puts.map(value => value.key)).size, 7);
  assert.ok(f.puts.every(value => value.key.startsWith('dmv:oauth:') && !value.key.includes('fixture')));
  f.setUser('two');
  assert.equal(f.token(credentials), 'access-7');
  assert.equal(f.requests.length, 8);
});

test('JSON tuple digest prevents concatenation collisions between client and secret', () => {
  const f = fixture([{ body: { access_token: 'first', expires_in: 3600 } }, { body: { access_token: 'second', expires_in: 3600 } }]);
  assert.equal(f.token({ ...credentials, clientId: 'a', clientSecret: 'bc' }), 'first');
  assert.equal(f.token({ ...credentials, clientId: 'ab', clientSecret: 'c' }), 'second');
  assert.notEqual(f.puts[0].key, f.puts[1].key);
});

test('cache TTL subtracts refresh latency and safety margin', () => {
  const f = fixture([{ elapsed: 4000, body: { access_token: 'access-fixture', expires_in: 1200 } }]);
  f.token();
  assert.equal(f.puts[0].ttl, 1076);
});

test('short, missing and malformed expiry allow immediate token use without caching', () => {
  for (const expires_in of [undefined, null, false, 'invalid', '3600', {}, [], 0.5, 1, 120]) {
    const f = fixture([{ body: { access_token: 'short-fixture', expires_in } }, { body: { access_token: 'next-fixture', expires_in } }]);
    assert.equal(f.token(), 'short-fixture');
    assert.equal(f.token(), 'next-fixture');
    assert.equal(f.puts.length, 0);
  }
});

test('zero, negative and already-consumed token lifetimes are rejected', () => {
  for (const expires_in of [0, -1, '0', '-1']) {
    const f = fixture([{ body: { access_token: 'expired-fixture', expires_in } }]);
    assert.throws(() => f.token(), /expired access token/);
    assert.equal(f.puts.length, 0);
  }
  const slow = fixture([{ elapsed: 2000, body: { access_token: 'expired-fixture', expires_in: 1 } }]);
  assert.throws(() => slow.token(), /expired access token/);
  assert.equal(slow.puts.length, 0);
});

test('malformed payloads and header-injecting token values fail safely', () => {
  const bodies = [null, [], false, 'token', {}, ...['', ' ', 'token\r\nX: injected', 'with space', 'with\u0000null', 123, {}, ['token'], 'x'.repeat(12001)].map(access_token => ({ access_token }))];
  for (const body of bodies) {
    const f = fixture([{ raw: JSON.stringify(body) }]);
    assert.throws(() => f.token(), error => /valid access token/.test(error.message) && !/TypeError|injected|with/.test(error.message));
    assert.equal(f.puts.length, 0);
    assert.equal(f.nativeCalls(), 0);
  }
});

test('revoked credentials, hostile redirects, network failures and unreadable bodies never leak secrets', () => {
  const sequence = [
    { code: 400, body: { error: 'invalid_grant', error_description: 'secret-fixture refresh-fixture' } },
    { code: 401, body: { message: 'secret-fixture' } },
    { code: 403, body: { message: 'refresh-fixture' } },
    { code: 302, headers: { Location: 'https://evil.example/?refresh_token=refresh-fixture' } },
    new Error('secret-fixture refresh-fixture'), { raw: 'secret-fixture refresh-fixture' },
  ];
  for (const response of sequence) {
    const f = fixture([response]);
    assert.throws(() => f.token(), error => /could not be refreshed/.test(error.message) && !/secret-fixture|refresh-fixture|evil/.test(error.message));
    assert.equal(f.requests.length, 1);
    assert.equal(f.nativeCalls(), 0);
    assert.equal(f.puts.length, 0);
  }
});

test('OAuth preserves deadline and rate-limit guidance without credential fallback', () => {
  const expired = fixture();
  assert.throws(() => expired.token(credentials, [], expired.now()), /time limit/);
  assert.equal(expired.requests.length, 0);
  const rate = fixture([{ code: 429, body: { error: 'secret-fixture' } }]);
  assert.throws(() => rate.token(), /Google OAuth is rate-limited/);
  assert.equal(rate.nativeCalls(), 0);
});

test('pasted access tokens are used as-is and the add-on never falls back to its own Google identity', () => {
  const f = fixture();
  assert.equal(f.token({ authMode: 'token', accessToken: 'manual-fixture' }), 'manual-fixture');
  assert.equal(f.requests.length, 0);
  for (const credentials of [{}, { authMode: 'native' }, { authMode: 'unsupported' }])
    assert.throws(() => f.token(credentials), /authorization method/);
  assert.equal(f.nativeCalls(), 0);
});

test('a rotated refresh token is handed to onRotate once; unchanged or invalid ones are ignored', () => {
  const f = fixture([
    { body: { access_token: 'first', expires_in: 3600, refresh_token: 'rotated-refresh' } },
    { body: { access_token: 'second', expires_in: 3600, refresh_token: 'refresh-fixture' } },
    { body: { access_token: 'third', expires_in: 3600, refresh_token: 'bad token\n' } },
  ]);
  const rotations = [];
  const provider = { label: 'Rotating OAuth', endpoint: 'https://login.example/token' };
  const exchange = (values) => f.context.dmvOAuthRefreshToken_(provider, values, f.now() + 240000, (patch) => rotations.push(JSON.parse(JSON.stringify(patch))));
  assert.equal(exchange({ ...credentials }), 'first');
  assert.deepEqual(rotations, [{ refreshToken: 'rotated-refresh' }]);
  // Different clients bypass the access-token cache; the reply repeats or mangles the refresh token.
  assert.equal(exchange({ ...credentials, clientId: 'client-two' }), 'second');
  assert.equal(exchange({ ...credentials, clientId: 'client-three' }), 'third');
  assert.equal(rotations.length, 1, 'same or malformed refresh tokens are not rotated');
  assert.equal(exchange({ ...credentials }), 'first', 'the first exchange is still cached; no network call');
  assert.equal(f.requests.length, 3);
});
