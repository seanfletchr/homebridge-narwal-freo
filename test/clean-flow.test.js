import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildFloors } from '../lib/floors.js';
import {
  NarwalMode, Suction, cornerCleaningBody, easyCleanBody, parseCornerCleaning, parsePlansResponse,
} from '../lib/protocol.js';
import { decodeFields, encodeVarint, fieldBytes, fieldVarint, getInt, getMessage } from '../lib/proto.js';
import { nearestFirst } from '../lib/shapes.js';
import { NarwalVacuum, buildModes, formatCleanReport, planOrder } from '../lib/vacuum.js';

// A map 10 cells wide and 1 high: room 1 = cells 0-2, room 2 = cells 3-4, (gap at 5), room 3 = cells 6-9.
const shape = { width: 10, height: 1, x0: 0, y0: 0, noGo: [], rooms: [1, 1, 1, 2, 2, 0, 3, 3, 3, 3] };

test('rooms: the room with the starting point first, then the nearest one each time', () => {
  assert.deepEqual(nearestFirst(shape, [3, 2, 1], { x: 0, y: 0 }), [1, 2, 3]);
  assert.deepEqual(nearestFirst(shape, [1, 2, 3], { x: 9, y: 0 }), [3, 2, 1]);
});

test('rooms: a starting point in none of the rooms starts with the nearest room', () => {
  // Rooms 2 and 3 are both one cell from the gap (the earlier in the list wins); then 1 is nearer to 2 than 3 is.
  assert.deepEqual(nearestFirst(shape, [1, 2, 3], { x: 5, y: 0 }), [2, 1, 3]);
  assert.deepEqual(nearestFirst(shape, [3, 1, 2], { x: 5, y: 0 }), [3, 2, 1]);
});

test('rooms: distance between rooms is edge to edge, so the nearest room can be one whose middle is far', () => {
  // Room 3 is long; from room 2 its edge is 2 cells away, room 1's 1 cell away.
  assert.deepEqual(nearestFirst(shape, [3, 1, 2], { x: 3, y: 0 }), [2, 1, 3]);
});

test('rooms: an order from the settings goes first, the rest follow nearest first, rooms without floor last', () => {
  assert.deepEqual(nearestFirst(shape, [1, 2, 3], { x: 0, y: 0 }, [3, 1]), [3, 1, 2]);
  assert.deepEqual(nearestFirst(shape, [1, 2, 3], { x: 0, y: 0 }, [2]), [2, 1, 3]);
  assert.deepEqual(nearestFirst(shape, [1, 9, 3], { x: 0, y: 0 }, [7, 3]), [3, 1, 9]);
});

test('maps keep a room order from the settings', () => {
  const [, up] = buildFloors([
    { id: 1, hasDock: true, rooms: [{ id: 1, name: 'A' }] },
    { id: 2, hasDock: false, rooms: [{ id: 4, name: 'B' }, { id: 5, name: 'C' }] },
  ], 1, [{ id: 2, roomOrder: [5, '4', 'x'] }]);
  assert.deepEqual(up.roomOrder, [5, 4]);
});

// clean/plan/get reply: transport header, then { 1: 1, 2: plan { 3: mode, 9: { 1: room } … } … }.
function plansReply(plans) {
  const header = fieldVarint(1, 1);
  const body = Buffer.concat([fieldVarint(1, 1), ...Object.entries(plans).map(([mode, rooms]) =>
    fieldBytes(2, Buffer.concat([fieldVarint(3, Number(mode)), ...rooms.map(id => fieldBytes(9, fieldVarint(1, id)))])))]);
  return Buffer.concat([Buffer.from([1]), encodeVarint(header.length), header, body]);
}

test('the plan\'s room order is kept (object keys would sort it)', () => {
  const plans = parsePlansResponse(plansReply({ 2: [1, 5, 2, 3, 4], 4: [4, 3, 2, 5, 1] }));
  assert.deepEqual(plans.order, { 2: [1, 5, 2, 3, 4], 4: [4, 3, 2, 5, 1] });
  assert.deepEqual(Object.keys(plans[2]), ['1', '2', '3', '4', '5']);
  // Stored through JSON, as in state.json.
  const stored = JSON.parse(JSON.stringify(plans));
  const rooms = [{ id: 2 }, { id: 3 }, { id: 4 }, { id: 1 }, { id: 9 }];
  assert.deepEqual(planOrder(rooms, stored, 2).map(r => r.id), [1, 2, 3, 4, 9]);
  assert.deepEqual(planOrder(rooms, stored, 4).map(r => r.id), [4, 3, 2, 1, 9]);
});

test('plans saved without an order leave the rooms as they were', () => {
  const rooms = [{ id: 2 }, { id: 1 }];
  assert.equal(planOrder(rooms, { 2: { 1: 'aa' } }, 2), rooms);
  assert.equal(planOrder(rooms, undefined, 2), rooms);
});

test('suction Max is 4 in a start body', () => {
  assert.equal(Suction.max, 4);
  const body = easyCleanBody([1], NarwalMode.VACUUM, {}, { suction: Suction.max, passes: 1 }, 1);
  const room = decodeFields(decodeFields(body).find(f => f.number === 3).value);
  const vacuum = decodeFields(room.find(f => f.number === 4).value);
  assert.equal(getInt(vacuum, 1), 4);
});

test('intensive corner cleaning bytes', () => {
  assert.equal(cornerCleaningBody({ on: true, frequency: 0 }).toString('hex'), '520408031000');
  assert.equal(cornerCleaningBody({ on: false, frequency: 7 }).toString('hex'), '520408011007');
  assert.equal(cornerCleaningBody({ on: true, frequency: 1 }).toString('hex'), '520408031001');
});

// config/get reply: transport header, then { 1: 1, 2: settings }.
function settingsReply(settings) {
  const header = fieldVarint(1, 1);
  const body = Buffer.concat([fieldVarint(1, 1), fieldBytes(2, settings)]);
  return Buffer.concat([Buffer.from([1]), encodeVarint(header.length), header, body]);
}

test('corner cleaning is read from settings field 14, a missing frequency is 0', () => {
  const field = (on, frequency) => fieldBytes(14, Buffer.concat([fieldVarint(1, on), ...(frequency ? [fieldVarint(2, frequency)] : [])]));
  assert.deepEqual(parseCornerCleaning(settingsReply(Buffer.concat([fieldVarint(10, 1), field(3, 0)]))), { on: true, frequency: 0 });
  assert.deepEqual(parseCornerCleaning(settingsReply(field(1, 7))), { on: false, frequency: 7 });
  assert.deepEqual(parseCornerCleaning(settingsReply(fieldVarint(10, 1))), { on: false, frequency: 0 });
  assert.equal(getMessage(decodeFields(Buffer.from('520408031000', 'hex')), 10).length, 4);
});

test('the clean report line carries the battery', () => {
  assert.match(formatCleanReport({ reason: 1, percent: 100 }, { from: 74, to: 52 }), /battery 74% → 52%/);
  assert.doesNotMatch(formatCleanReport({ reason: 1, percent: 100 }), /battery/);
});

// ── A vacuum with a main map and a secondary one ──

function setup({ robot = {}, store = {}, vacation = {} } = {}) {
  const status = new Proxy({}, { get: (_, kind) => class extends Error { constructor(message) { super(message); this.kind = kind; } } });
  const logs = [];
  const log = new Proxy({}, { get: (_, level) => (message) => logs.push([level, message]) });
  const updates = [];
  const fake = { connected: true, ...robot };
  const vacuum = new NarwalVacuum({
    api: { matter: { uuid: { generate: () => 'uuid' }, status, updateAccessoryState: async (...args) => { updates.push(args); } } },
    log,
    robot: fake,
    device: { deviceId: 'd' },
    name: 'Freo',
    store: {
      mainMapId: 1,
      maps: [
        { id: 1, name: '', hasDock: true, main: true, start: { x: 0, y: 0 }, rooms: [{ id: 1, name: 'Kitchen' }, { id: 2, name: 'Hall' }] },
        { id: 2, name: 'Upstairs', hasDock: false, start: { x: 1, y: 1 }, rooms: [{ id: 4, name: 'Corridor' }, { id: 5, name: 'Bedroom' }] },
      ],
      cleanMode: 1,
      ...store,
    },
    save: () => {},
    ...vacation,
  });
  vacuum.ready = true;
  return { vacuum, logs, updates };
}

const idle = { state: 1, docked: false, base: 0, atBase: false, battery: 80, paused: false, returning: 0 };
const cleaning = { ...idle, state: 4 };

test('after a clean the selection goes back to every room of the main map', async () => {
  const { vacuum, updates } = setup({ store: { selectedAreas: [2004] } });
  vacuum.selectedAt = Date.now();
  vacuum.cleanOver();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(vacuum.store.selectedAreas, [1, 2]);
  assert.equal(vacuum.selectedAt, undefined);
  assert.deepEqual(updates.at(-1).slice(1), ['serviceArea', { selectedAreas: [1, 2] }]);
  // Nothing to send when it is already so.
  const before = updates.length;
  vacuum.cleanOver();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(updates.length, before);
});

test('a main map job ending resets the selection, a room of a queue ending does not', async () => {
  const { vacuum } = setup({ store: { selectedAreas: [1] } });
  vacuum.status = cleaning;
  await vacuum.refresh(idle);
  assert.deepEqual(vacuum.store.selectedAreas, [1, 2]);

  vacuum.store.selectedAreas = [2004, 2005];
  const floor = vacuum.floors[1];
  vacuum.zoneQueue = { floor, entries: [{ room: floor.rooms[0] }, { room: floor.rooms[1] }], index: 0, done: 0, phase: 'running' };
  vacuum.status = cleaning;
  await vacuum.refresh(idle);
  assert.deepEqual(vacuum.store.selectedAreas, [2004, 2005]);
});

test('the Cleaning sensor stays on through a room queue and its trip', async () => {
  const { vacuum } = setup();
  const seen = [];
  vacuum.onJob = active => seen.push(active);
  const floor = vacuum.floors[1];
  vacuum.zoneQueue = { floor, entries: [{ room: floor.rooms[0] }, { room: floor.rooms[1] }], index: 0, done: 1, phase: 'gap', reportDone: true, continuing: true };
  vacuum.status = cleaning;
  await vacuum.refresh(idle); // between two rooms the robot reports no job
  assert.deepEqual(seen, [true]);
  vacuum.zoneQueue = undefined;
  vacuum.trip = { floor, phase: 'running', sentAt: Date.now() };
  await vacuum.refresh(cleaning);
  assert.deepEqual(seen.at(-1), true);
});

test('a queue ends with one battery line', () => {
  const { vacuum, logs } = setup();
  const floor = vacuum.floors[1];
  vacuum.status = { ...idle, battery: 52 };
  vacuum.run = { battery: 74 };
  const q = vacuum.zoneQueue = { floor, entries: [{ room: floor.rooms[0] }, { room: floor.rooms[1] }], index: 1, done: 2, phase: 'gap', reportDone: true };
  vacuum.finishQueue(q, 'complete'); // the trip follows: no line yet
  assert.equal(logs.filter(([, m]) => /battery/.test(m)).length, 0);
  vacuum.cleanOver(); // the trip is over
  assert.deepEqual(logs.filter(([, m]) => /battery/.test(m)).map(([, m]) => m), ['Clean on Upstairs over: 2 of 2 rooms, battery 74% → 52%.']);
});

test('low battery during a queue ends it and sends the robot to the starting point', async () => {
  const { vacuum, logs } = setup();
  const trips = [];
  vacuum.tripToStart = async (floor, opts) => { trips.push([floor.id, opts]); };
  const floor = vacuum.floors[1];
  const q = vacuum.zoneQueue = { floor, entries: [{ room: floor.rooms[0] }, { room: floor.rooms[1] }], index: 0, done: 0, phase: 'running' };
  vacuum.status = cleaning;
  await vacuum.refresh({ ...cleaning, battery: 11 });
  assert.equal(vacuum.zoneQueue, q);
  await vacuum.refresh({ ...cleaning, battery: 10 });
  assert.equal(vacuum.zoneQueue, undefined);
  assert.deepEqual(trips, [[2, { halted: false, lowBattery: true }]]);
  assert.ok(logs.some(([level, m]) => level === 'warn' && /Battery at 10%: ending the clean on Upstairs and returning to its starting point; not cleaned: Corridor, Bedroom/.test(m)));
});

test('the robot\'s own "battery too low" end of a zone also sends it back', () => {
  const { vacuum } = setup();
  const trips = [];
  vacuum.tripToStart = async (floor, opts) => { trips.push(opts.lowBattery); };
  const floor = vacuum.floors[1];
  vacuum.zoneQueue = { floor, entries: [{ room: floor.rooms[0] }, { room: floor.rooms[1] }], index: 0, done: 0, phase: 'running', sentAt: 0 };
  vacuum.queueReport({ reason: 4 });
  assert.deepEqual(trips, [true]);
});

test('a low battery trip ends with the low battery error, which clears on the base', async () => {
  const { vacuum } = setup();
  const floor = vacuum.floors[1];
  vacuum.status = idle;
  const trip = vacuum.trip = { floor, lowBattery: true, phase: 'starting', sentAt: Date.now() };
  await vacuum.endTrip(trip, 'the robot refused', { notice: 'Couldn\'t return', code: 64 });
  assert.equal(vacuum.condition?.matter, 72);
  assert.equal(vacuum.notice, undefined);
  await vacuum.refresh({ ...idle, docked: true, base: 2, atBase: true });
  assert.equal(vacuum.condition, undefined);
});

test('a failed restore of the corner setting is kept to retry', async () => {
  const { vacuum } = setup({ robot: {} });
  vacuum.store.cornerRestore = { on: false, frequency: 0, at: 0, ran: true };
  vacuum.status = idle;
  vacuum.robot.setCornerCleaning = async () => false;
  vacuum.restoreCorners();
  await vacuum.restoringCorners;
  assert.ok(vacuum.store.cornerRestore);
  assert.ok(vacuum.cornerTimer);
  clearTimeout(vacuum.cornerTimer);
});

test('a clean mode\'s Intensive Clean option: parsing and defaults', () => {
  const modes = buildModes({ vacuumDeep: { corners: 'on' }, mopDeep: { corners: 'weekly' }, mop: { corners: 'bogus' }, both: { corners: 'daily' }, bothDeep: { corners: 'always' } });
  const by = key => modes.find(m => m.key === key);
  assert.equal(by('vacuumDeep').corners, 'always'); // the earlier test value
  assert.equal(by('mopDeep').corners, 'app'); // test-build values
  assert.equal(by('both').corners, 'app');
  assert.equal(by('bothDeep').corners, 'always');
  assert.equal(by('mop').corners, 'app');
  assert.equal(by('vacuum').corners, 'app');
  const defaults = buildModes({});
  for (const m of defaults) {
    assert.equal(m.corners, m.key.endsWith('Quick') ? 'off' : 'app', m.key);
  }
});

function cornerSetup(current, extra = {}) {
  const sets = [];
  const state = { ...current };
  const made = setup({
    robot: {
      cornerCleaning: async () => ({ ...state }),
      setCornerCleaning: async (v) => { sets.push(v); Object.assign(state, v); return true; },
    },
    ...extra,
  });
  return { ...made, sets, state };
}

test('a setting saved by a test build is put back once the clean is over', async () => {
  const { vacuum, sets, state } = cornerSetup({ on: true, frequency: 0 });
  vacuum.store.cornerRestore = { on: false, frequency: 7, at: 1, ran: true };
  vacuum.status = idle;
  vacuum.restoreCorners();
  await vacuum.restoringCorners;
  assert.deepEqual(sets, [{ on: false, frequency: 7 }]);
  assert.deepEqual(state, { on: false, frequency: 7 });
  assert.equal(vacuum.store.cornerRestore, undefined);
});

test('the plugin never changes the corner setting, whatever a slot says in the config', async () => {
  for (const corners of ['always', 'off', 'app']) {
    const { vacuum, sets } = cornerSetup({ on: false, frequency: 7 }, { vacation: { vacationDeepClean: true }, store: { vacation: { since: Date.now(), cleans: 0 } } });
    assert.equal(await vacuum.cornersOn({ corners }), undefined);
    assert.deepEqual(sets, []);
    assert.equal(vacuum.store.cornerRestore, undefined);
  }
});

test('corner cleaning is put back before the trip to the starting point, even with a trip or queue set', async () => {
  const sets = [];
  let current = { on: true, frequency: 0 };
  const { vacuum } = setup({
    robot: {
      cornerCleaning: async () => current,
      setCornerCleaning: async (value) => { sets.push(value); current = value; return true; },
    },
  });
  vacuum.store.cornerRestore = { on: false, frequency: 7, at: Date.now() };
  vacuum.status = idle;
  vacuum.trip = {};
  vacuum.restoreCorners();
  assert.equal(sets.length, 0); // the normal restore waits for the trip to end
  await vacuum.restoreCornersBeforeTrip();
  assert.deepEqual(sets, [{ on: false, frequency: 7 }]);
  assert.equal(vacuum.store.cornerRestore, undefined);
});

test('spotNote says the zone size, clipping and fallback', async () => {
  const { spotNote } = await import('../lib/shapes.js');
  assert.equal(spotNote({ cells: 16, cell: [10, 10] }), '20 cm spot, 16 cells');
  assert.equal(spotNote({ cells: 36, cell: [10, 10] }, { size: 6, fellBack: true }), '30 cm spot (the robot refused 20 cm), 36 cells');
  assert.equal(spotNote({ cells: 12, cell: [10, 10] }), '20 cm spot, clipped by a wall: 12 of 16 cells');
  assert.equal(spotNote({ cells: 16, cell: [12, 10] }, { point: { x: 10, y: 10 } }),
    '20 cm spot, 16 cells, middle 10 cm from the starting point');
});
