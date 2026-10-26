import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NarwalCloud, jwtClaims } from '../lib/cloud.js';

const jwt = claims => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;

function fakeLog() {
  const calls = { warn: [], debug: [], info: [] };
  return { calls, warn: m => calls.warn.push(m), debug: m => calls.debug.push(m), info: m => calls.info.push(m), error() {} };
}

test('jwtClaims reads the payload and tolerates garbage', () => {
  assert.deepEqual(jwtClaims(jwt({ uuid: 'abc', exp: 5 })), { uuid: 'abc', exp: 5 });
  assert.deepEqual(jwtClaims(''), {});
  assert.deepEqual(jwtClaims('not-a-jwt'), {});
});

test('headers default to the built-in app version', () => {
  const h = new NarwalCloud({ email: 'a', password: 'b', log: fakeLog() }).headers();
  assert.equal(h['app-version'], '2.7.03');
  assert.equal(h.version_code, '175');
});

test('headers carry the token and its uuid once signed in', () => {
  const cloud = new NarwalCloud({ email: 'a', password: 'b', tokens: { accessToken: jwt({ uuid: 'u-1' }) }, log: fakeLog() });
  const h = cloud.headers();
  assert.equal(h.uuid, 'u-1');
  assert.equal(h.did, 'u-1');
  assert.equal(h['auth-token'], cloud.accessToken);
});

test('storeTokens finds tokens in the shapes Narwal returns and notifies', () => {
  const seen = [];
  const cloud = new NarwalCloud({ email: 'a', password: 'b', onTokens: t => seen.push(t), log: fakeLog() });
  assert.equal(cloud.storeTokens({ result: { token: 't1', refreshToken: 'r1' } }), true);
  assert.equal(cloud.storeTokens({ result: { userInfo: { accessToken: 't2', refresh_token: 'r2' } } }), true);
  assert.equal(cloud.storeTokens({ result: { token: 'only-access' } }), false);
  assert.equal(cloud.storeTokens(undefined), false);
  assert.deepEqual(seen, [{ accessToken: 't1', refreshToken: 'r1' }, { accessToken: 't2', refreshToken: 'r2' }]);
});

test('ensureToken reuses a token that is not near expiry and renews one that is', async () => {
  const cloud = new NarwalCloud({
    email: 'a', password: 'b', log: fakeLog(),
    tokens: { accessToken: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }) },
  });
  let renewed = 0;
  cloud.renew = async () => { renewed++; };
  await cloud.ensureToken();
  assert.equal(renewed, 0);

  cloud.accessToken = jwt({ exp: Math.floor(Date.now() / 1000) + 60 });
  await cloud.ensureToken();
  assert.equal(renewed, 1);
});

test('login refuses to run without credentials', async () => {
  const cloud = new NarwalCloud({ log: fakeLog() });
  await assert.rejects(() => cloud.login(), /email and password are not configured/);
});
