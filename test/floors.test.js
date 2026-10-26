import assert from 'node:assert/strict';
import { test } from 'node:test';

import { allAreas, areaIdFor, buildFloors } from '../lib/floors.js';

// Home scenes and automations point at these ids: changing the scheme breaks them without any error.
test('the main map keeps Narwal room ids; other maps get map*1000+room', () => {
  assert.equal(areaIdFor(1, 1, 7), 7);
  assert.equal(areaIdFor(1, 2, 7), 2007);
});

test('allAreas flattens rooms with their floor', () => {
  const floors = buildFloors([{ id: 1, rooms: [{ id: 1, name: 'A' }] }, { id: 2, rooms: [{ id: 1, name: 'B' }] }], 1);
  assert.deepEqual(allAreas(floors).map(a => [a.areaId, a.mapId, a.roomId]), [[1, 1, 1], [2001, 2, 1]]);
});
