import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NarwalCloud } from '../lib/cloud.js';

function fakeLog() {
  const warnings = [];
  return { warnings, warn: m => warnings.push(m), debug() {}, info() {}, error() {} };
}

test('an unknown region warns and falls back to the US endpoint', () => {
  const log = fakeLog();
  const cloud = new NarwalCloud({ email: 'a', password: 'b', region: 'eu', log });
  assert.equal(cloud.country, 'US');
  assert.equal(log.warnings.length, 1);
  assert.match(log.warnings[0], /Unknown Narwal cloud region "eu"/);
});

test('the default and the "us" region do not warn', () => {
  const log = fakeLog();
  new NarwalCloud({ email: 'a', password: 'b', log });
  new NarwalCloud({ email: 'a', password: 'b', region: 'us', log });
  assert.equal(log.warnings.length, 0);
});
