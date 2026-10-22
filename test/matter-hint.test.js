import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NarwalPlatform } from '../lib/platform.js';

test('without Matter, the error shows the config to add', () => {
  const errors = [];
  const log = { error: m => errors.push(m), warn() {}, info() {}, debug() {} };
  new NarwalPlatform(log, { email: 'a', password: 'b' }, { isMatterEnabled: () => false, on() {} });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Matter is not enabled for this bridge/);
  assert.match(errors[0], /"matter": \{ "enabled": false, "externalsOnly": true/);
});
