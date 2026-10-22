import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NarwalCloud } from '../lib/cloud.js';

const log = { warn() {}, debug() {}, info() {}, error() {} };

test('the built-in app version is used by default', () => {
  const h = new NarwalCloud({ email: 'a', password: 'b', log }).headers();
  assert.equal(h['app-version'], '2.7.03');
  assert.equal(h.app_version, '2.7.03');
  assert.equal(h.version_code, '175');
});

test('app version and code can be overridden', () => {
  const h = new NarwalCloud({ email: 'a', password: 'b', appVersion: '9.9.99', versionCode: 999, log }).headers();
  assert.equal(h['app-version'], '9.9.99');
  assert.equal(h.app_version, '9.9.99');
  assert.equal(h.version_code, '999');
});

test('an override on one instance does not leak into another', () => {
  new NarwalCloud({ email: 'a', password: 'b', appVersion: '9.9.99', log });
  assert.equal(new NarwalCloud({ email: 'a', password: 'b', log }).headers()['app-version'], '2.7.03');
});
