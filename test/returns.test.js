import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NarwalVacuum, median, returnLimit } from '../lib/vacuum.js';

test('the median of a list', () => {
  assert.equal(median([]), undefined);
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

test('a return has 10 minutes until three returns are known', () => {
  assert.equal(returnLimit({ perMetre: [4], seconds: [60, 70] }, 5), 10 * 60 * 1000);
  assert.equal(returnLimit(undefined, undefined), 10 * 60 * 1000);
});

test('the limit is three times the expected time, at least three minutes', () => {
  const learned = { perMetre: [4, 5, 6], seconds: [60, 100, 120] };
  assert.equal(returnLimit(learned, 10), 3 * 66 * 1000);
  assert.equal(returnLimit(learned, 1), 180000); // 3 x 21 s: the minimum applies
  assert.equal(returnLimit(learned, undefined), 3 * 100 * 1000); // no distance: median duration
});

test('the Matter state for a robot in the base station state', () => {
  const vacuum = { queueGap: () => false };
  const op = s => NarwalVacuum.prototype.opFor.call(vacuum, { battery: 100, state: 14, paused: false, returning: 0, docked: true, station: 0, base: 2, atBase: true, ...s });
  assert.equal(op({ paused: true, base: 1, atBase: false }), 0); // paused drying off the base: Stopped
  assert.equal(op({ base: 1, atBase: false }), 64); // driving to its base by itself
  assert.equal(op({ station: 4, base: 3 }), 68); // drying the mops
  assert.equal(op({ battery: 80 }), 65);
  assert.equal(op({}), 66);
});
