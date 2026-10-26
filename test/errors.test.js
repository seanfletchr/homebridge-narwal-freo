import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ERRORS, lookupError } from '../lib/errors.js';

test('a known code maps to a Matter error and Narwal\'s message', () => {
  const hit = lookupError(0x01010013);
  assert.equal(hit.matter, 2);
  assert.match(hit.message, /Dock overflow/);
});

test('codes may be passed as numbers or numeric strings', () => {
  assert.deepEqual(lookupError(String(0x01010013)), lookupError(0x01010013));
});

test('codes outside the table are routine notices, not errors', () => {
  assert.equal(lookupError(0x01010072), undefined);
  assert.equal(lookupError(0), undefined);
  assert.equal(lookupError('nonsense'), undefined);
});

test('every table entry is [matterErrorNumber, non-empty message]', () => {
  assert.ok(ERRORS.size > 100);
  for (const [code, [matter, message]] of ERRORS) {
    assert.ok(Number.isInteger(code) && code > 0, `code ${code}`);
    assert.ok(Number.isInteger(matter) && matter >= 0, `matter for ${code.toString(16)}`);
    assert.ok(typeof message === 'string' && message.length > 0, `message for ${code.toString(16)}`);
  }
});
