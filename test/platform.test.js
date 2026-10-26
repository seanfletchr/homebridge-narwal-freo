import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NarwalPlatform } from '../lib/platform.js';

function fakeLog() {
  const errors = [];
  return { errors, error: m => errors.push(m), warn() {}, info() {}, debug() {} };
}

test('asks for credentials when none are configured', () => {
  const log = fakeLog();
  new NarwalPlatform(log, { name: 'Narwal Freo' }, { isMatterEnabled: () => true, matter: {}, on() {} });
  assert.match(log.errors[0], /Sign in to Narwal/);
});
