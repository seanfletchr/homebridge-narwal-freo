import assert from 'node:assert/strict';
import { test } from 'node:test';

import { encodeVarint, fieldBytes, fieldString, fieldVarint } from '../lib/proto.js';
import { mergeRoomInfo, parseMapReplyRooms, parseReducedMaps } from '../lib/protocol.js';
import { NarwalRobot } from '../lib/robot.js';

const wrap = body => Buffer.concat([Buffer.from([1]), encodeVarint(0), body]);
const room = (id, type, name) => Buffer.concat([
  fieldVarint(1, id), fieldVarint(2, type), ...(name ? [fieldString(3, name)] : []),
]);
const reply = (mapId, ...rooms) => wrap(Buffer.concat([
  fieldVarint(1, 1),
  fieldBytes(2, Buffer.concat([fieldVarint(1, mapId), ...rooms.map(r => fieldBytes(12, r))])),
]));

test('the get_map reply gives each room its type name; the saved-map list only has ids', () => {
  const full = parseMapReplyRooms(reply(1, room(2, 1), room(3, 5), room(4, 4), room(1, 3), room(5, 3)));
  assert.equal(full.id, 1);
  assert.deepEqual(full.rooms.map(r => [r.id, r.name]), [
    [2, 'Master Bedroom'], [3, 'Bathroom'], [4, 'Kitchen'], [1, 'Living Room'], [5, 'Living Room 2'],
  ]);

  const list = wrap(Buffer.concat([
    fieldVarint(1, 1),
    fieldBytes(2, Buffer.concat([fieldVarint(1, 1), ...[2, 3, 4, 1, 5].map(id => fieldBytes(12, fieldVarint(1, id)))])),
  ]));
  const [map] = parseReducedMaps(list);
  assert.deepEqual(map.rooms.map(r => r.name), ['Room', 'Room 2', 'Room 3', 'Room 4', 'Room 5']);
});

test('a custom name from the robot wins over the type name', () => {
  const full = parseMapReplyRooms(reply(1, room(2, 4, 'Galley')));
  assert.equal(full.rooms[0].name, 'Galley');
});

test('mergeRoomInfo applies what get_map told us and leaves the rest alone', () => {
  const maps = [
    { id: 1, rooms: [{ id: 2, name: 'Room', type: 0 }, { id: 3, name: 'Room 2', type: 0 }] },
    { id: 2, rooms: [{ id: 1, name: 'Room', type: 0 }] },
  ];
  const info = new Map([[1, [{ id: 2, name: 'Kitchen', type: 4 }]]]);
  const merged = mergeRoomInfo(maps, info);
  assert.deepEqual(merged[0].rooms, [{ id: 2, name: 'Kitchen', type: 4 }, { id: 3, name: 'Room 2', type: 0 }]);
  assert.equal(merged[1], maps[1]);
  assert.equal(maps[0].rooms[0].name, 'Room');
});

test('a reply without a map, or without rooms, is harmless', () => {
  assert.equal(parseMapReplyRooms(wrap(fieldVarint(1, 1))), undefined);
  assert.deepEqual(parseMapReplyRooms(reply(1)).rooms, []);
});

test('the robot keeps the room names from get_map across the periodic map refresh', () => {
  const emitted = [];
  const robot = {
    maps: [], listedMaps: [], roomInfo: new Map(), log: { debug() {}, warn() {} },
    emit: (event, value) => emitted.push(value.maps[0].rooms.map(r => r.name)),
    maybeRequestPlans() {},
    onReducedMaps: NarwalRobot.prototype.onReducedMaps,
    onMapRooms: NarwalRobot.prototype.onMapRooms,
  };
  const listed = () => [{
    id: 1, name: '', hasDock: true, main: true,
    rooms: [{ id: 2, name: 'Room', type: 0 }, { id: 3, name: 'Room 2', type: 0 }],
  }];
  robot.onReducedMaps(listed());
  robot.onMapRooms({ id: 1, rooms: [{ id: 2, name: 'Kitchen', type: 4 }, { id: 3, name: 'Bathroom', type: 5 }] });
  robot.onReducedMaps(listed());
  assert.deepEqual(emitted, [['Room', 'Room 2'], ['Kitchen', 'Bathroom'], ['Kitchen', 'Bathroom']]);
});
