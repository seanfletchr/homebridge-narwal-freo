import assert from 'node:assert/strict';
import { test } from 'node:test';

import { allAreas, areaIdFor, buildFloors, savedMaps } from '../lib/floors.js';

test('the main map keeps Narwal room ids; other maps get map*1000+room', () => {
  assert.equal(areaIdFor(1, 1, 7), 7);
  assert.equal(areaIdFor(1, 2, 7), 2007);
});

test('duplicate room names are made unique', () => {
  const [floor] = buildFloors([{ id: 1, rooms: [{ id: 1, name: 'Hall' }, { id: 2, name: 'hall' }] }], 1);
  assert.deepEqual(floor.rooms.map(r => r.name), ['Hall', 'hall 2']);
});

test('settings rename floors and rooms without touching Narwal\'s names', () => {
  const maps = [{ id: 1, name: 'Ground', rooms: [{ id: 3, name: 'Room 3' }] }];
  const settings = [{ id: 1, name: 'Downstairs', rooms: [{ id: 3, name: 'Kitchen' }] }];
  const [floor] = buildFloors(maps, 1, settings);
  assert.equal(floor.name, 'Downstairs');
  assert.equal(floor.narwalName, 'Ground');
  assert.equal(floor.rooms[0].name, 'Kitchen');
  assert.equal(floor.rooms[0].narwalName, 'Room 3');
});

test('a floor without a name gets a default; names are capped at 64 characters', () => {
  const floors = buildFloors([{ id: 1, rooms: [] }, { id: 2, rooms: [] }], 1, [{ id: 2, name: 'x'.repeat(100) }]);
  assert.equal(floors[0].name, 'Main Map');
  assert.equal(floors[1].name.length, 64);
});

test('stair detection is managed only with several maps or an explicit choice', () => {
  assert.equal(buildFloors([{ id: 1, rooms: [] }], 1)[0].managed, false);
  assert.equal(buildFloors([{ id: 1, rooms: [] }], 1, [{ id: 1, stairDetection: false }])[0].managed, true);
  assert.equal(buildFloors([{ id: 1, rooms: [] }, { id: 2, rooms: [] }], 1)[0].managed, true);
});

test('allAreas flattens rooms with their floor', () => {
  const floors = buildFloors([{ id: 1, rooms: [{ id: 1, name: 'A' }] }, { id: 2, rooms: [{ id: 1, name: 'B' }] }], 1);
  assert.deepEqual(allAreas(floors).map(a => [a.areaId, a.mapId, a.roomId]), [[1, 1, 1], [2001, 2, 1]]);
});

test('savedMaps reads the pre-0.6 single-map layout', () => {
  const maps = savedMaps({ rooms: [{ id: 1, name: 'Den' }] });
  assert.equal(maps.length, 1);
  assert.equal(maps[0].main, true);
  assert.deepEqual(maps[0].rooms, [{ id: 1, name: 'Den' }]);
  assert.deepEqual(savedMaps({}), []);
});
