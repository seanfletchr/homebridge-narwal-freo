import assert from 'node:assert/strict';
import { test } from 'node:test';

import { allAreas, areaIdFor, buildFloors, savedMaps } from '../lib/floors.js';

// Home scenes and automations point at these ids: changing the scheme breaks them without any error.
test('the main map keeps Narwal room ids; other maps get map*1000+room', () => {
  assert.equal(areaIdFor(1, 1, 7), 7);
  assert.equal(areaIdFor(1, 2, 7), 2007);
});

test('allAreas flattens rooms with their floor', () => {
  const floors = buildFloors([{ id: 1, rooms: [{ id: 1, name: 'A' }] }, { id: 2, rooms: [{ id: 1, name: 'B' }] }], 1);
  assert.deepEqual(allAreas(floors).map(a => [a.areaId, a.mapId, a.roomId]), [[1, 1, 1], [2001, 2, 1]]);
});

const maps = [
  { id: 1, name: '', hasDock: true, rooms: [{ id: 1, name: 'Kitchen' }, { id: 4, name: 'Corridor' }] },
  { id: 2, name: 'Upstairs', hasDock: false, rooms: [{ id: 4, name: 'Corridor' }, { id: 5, name: 'Bedroom' }, { id: 6, name: 'Bedroom' }] },
];

test('a secondary map\'s room gets its map\'s name only when another map has a room with that name', () => {
  const [main, up] = buildFloors(maps, 1);
  assert.deepEqual(main.rooms.map(r => r.name), ['Kitchen', 'Corridor']);
  assert.deepEqual(up.rooms.map(r => r.name), ['Corridor (Upstairs)', 'Bedroom', 'Bedroom 2']);
  assert.deepEqual(up.rooms.map(r => r.areaId), [2004, 2005, 2006]); // ids don't depend on names
  assert.equal(up.rooms[0].baseName, 'Corridor');
  assert.equal(up.rooms[0].narwalName, 'Corridor');
});

test('a clash is found after custom names, ignoring case; the main map\'s room stays plain', () => {
  const settings = [{ id: 2, rooms: [{ id: 5, name: 'KITCHEN' }, { id: 4, name: 'Hallway' }] }];
  const [main, up] = buildFloors(maps, 1, settings);
  assert.deepEqual(main.rooms.map(r => r.name), ['Kitchen', 'Corridor']);
  assert.deepEqual(up.rooms.map(r => r.name), ['Hallway', 'KITCHEN (Upstairs)', 'Bedroom']);
});

test('rooms clashing on two secondary maps both get their map\'s name', () => {
  const three = [
    { id: 1, hasDock: true, rooms: [{ id: 1, name: 'Kitchen' }] },
    { id: 2, name: '2F', hasDock: false, rooms: [{ id: 1, name: 'Office' }] },
    { id: 3, name: '3F', hasDock: false, rooms: [{ id: 1, name: 'Office' }] },
  ];
  const floors = buildFloors(three, 1);
  assert.deepEqual(floors.map(f => f.rooms[0].name), ['Kitchen', 'Office (2F)', 'Office (3F)']);
});

test('maps come in map id order, whatever order the robot lists them in', () => {
  const listed = [
    { id: 3, name: '3F', hasDock: false, rooms: [{ id: 1, name: 'Gym' }] },
    { id: 2, name: '2F', hasDock: false, rooms: [{ id: 1, name: 'Office' }] },
    { id: 1, hasDock: true, rooms: [{ id: 1, name: 'Kitchen' }] },
  ];
  assert.deepEqual(buildFloors(listed, 1).map(f => f.id), [1, 2, 3]);
  assert.deepEqual(allAreas(buildFloors(listed, 1)).map(a => a.areaId), [1, 2001, 3001]);
  assert.deepEqual(savedMaps({ mainMapId: 1, maps: listed }).map(m => m.id), [1, 2, 3]);
});

test('custom names and map names are used in the brackets, and the whole name fits Matter\'s limit', () => {
  const settings = [{ id: 2, name: 'Attic', rooms: [{ id: 4, name: 'Corridor' }] }];
  const up = buildFloors(maps, 1, settings)[1];
  assert.equal(up.rooms[0].name, 'Corridor (Attic)');
  const long = buildFloors(maps, 1, [{ id: 2, rooms: [{ id: 4, name: 'Kitchen'.padEnd(64, 'x') }] }, { id: 1, rooms: [{ id: 1, name: 'Kitchen'.padEnd(64, 'x') }] }])[1];
  assert.ok(long.rooms[0].name.length <= 64);
  assert.ok(long.rooms[0].name.endsWith(' (Upstairs)'));
});

test('a room\'s stair detection is its own, else its floor\'s', () => {
  const settings = [{ id: 1, stairDetection: false, rooms: [{ id: 4, stairDetection: true }] }, { id: 2 }];
  const [main, up] = buildFloors(maps, 1, settings);
  assert.deepEqual(main.rooms.map(r => r.stairDetection), [false, true]);
  assert.deepEqual(up.rooms.map(r => r.stairDetection), [true, true, true]);
});
