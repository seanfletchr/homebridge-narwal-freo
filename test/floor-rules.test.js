import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NarwalVacuum } from '../lib/vacuum.js';

// A vacuum with two maps (1 = main, with the base; 2 = a secondary map) and a robot that fails the test if
// the plugin sends it anything not listed in `robot`.
function setup({ robot = {}, store = {} } = {}) {
  const status = new Proxy({}, { get: (_, kind) => class extends Error { constructor(message) { super(message); this.kind = kind; } } });
  const quiet = new Proxy({}, { get: () => () => {} });
  const calls = [];
  const fake = new Proxy({ connected: true, currentMapId: 2, stairless: async () => false, ...robot }, {
    get: (target, key) => (key in target ? target[key] : (...args) => { calls.push(String(key)); throw new Error(`robot touched: ${String(key)}`); }),
  });
  const vacuum = new NarwalVacuum({
    api: { matter: { uuid: { generate: () => 'uuid' }, status } },
    log: quiet,
    robot: fake,
    device: { deviceId: 'd' },
    name: 'Freo',
    store: {
      mainMapId: 1,
      maps: [
        { id: 1, name: '', hasDock: true, main: true, start: { x: 0, y: 0 }, rooms: [{ id: 1, name: 'Kitchen' }] },
        { id: 2, name: 'Upstairs', hasDock: false, start: { x: 1, y: 1 }, rooms: [{ id: 4, name: 'Corridor' }] },
      ],
      cleanMode: 1,
      ...store,
    },
    save: () => {},
  });
  return { vacuum, calls };
}

const idle = { state: 1, docked: false, base: 0, atBase: false, battery: 80, paused: false, returning: 0 };
const docked = { ...idle, docked: true, base: 2, atBase: true };

test('without a known floor the robot is on the main floor, whatever its current map says', () => {
  const { vacuum } = setup();
  assert.equal(vacuum.robotFloor().id, 1);
  vacuum.store.robotMapId = 2;
  assert.equal(vacuum.robotFloor().id, 2);
});

test('a start with no rooms picked uses the floor the plugin knows the robot is on, else the main floor', async () => {
  const { vacuum } = setup();
  assert.equal((await vacuum.cleanTarget()).floor.id, 1);
  vacuum.store.robotMapId = 2;
  assert.equal((await vacuum.cleanTarget()).floor.id, 2);
});

test('a start on a secondary map is refused while the robot is on its base', async () => {
  const { vacuum, calls } = setup({ store: { selectedAreas: [2004] } });
  vacuum.status = docked;
  await assert.rejects(vacuum.startClean(), /starting point/);
  assert.deepEqual(calls, []);
});

test('a start on a secondary map is refused for a mop clean', async () => {
  const { vacuum, calls } = setup({ store: { selectedAreas: [2004], cleanMode: 2 } });
  vacuum.status = idle;
  await assert.rejects(vacuum.startClean(), /vacuum only/);
  assert.deepEqual(calls, []);
});

test('a start on another floor than the secondary map the robot is on is refused', async () => {
  const { vacuum, calls } = setup({ store: { selectedAreas: [1], robotMapId: 2 } });
  vacuum.status = idle;
  await assert.rejects(vacuum.startClean(), /put it on its base first/);
  assert.deepEqual(calls, []);
});

test('Return to dock while the robot is idle on a secondary map is refused', async () => {
  const { vacuum, calls } = setup({ store: { robotMapId: 2 } });
  vacuum.status = idle;
  vacuum.lastStatusAt = Date.now();
  await assert.rejects(vacuum.goHome(), /Put the Freo on its base/);
  assert.deepEqual(calls, []);
});

test('the last room finishing sends the robot back to the starting point', async () => {
  const { vacuum } = setup();
  const trips = [];
  vacuum.tripToStart = async (floor, opts) => { trips.push([floor.id, opts]); };
  const floor = vacuum.floors[1];
  const q = vacuum.zoneQueue = { floor, entries: [{ room: floor.rooms[0] }], index: 0, done: 1, phase: 'gap', reportDone: true };
  vacuum.status = idle;
  await vacuum.queueDone(q);
  assert.equal(vacuum.zoneQueue, undefined);
  assert.deepEqual(trips, [[2, { halted: false }]]);
});

test('a robot error after the last room means no trip', async () => {
  const { vacuum } = setup();
  const trips = [];
  vacuum.tripToStart = async () => { trips.push(1); };
  const floor = vacuum.floors[1];
  const q = vacuum.zoneQueue = { floor, entries: [{ room: floor.rooms[0] }], index: 0, done: 1, phase: 'gap', reportDone: true };
  vacuum.fault = { code: 1, message: 'stuck' };
  await vacuum.queueDone(q);
  assert.deepEqual(trips, []);
});

test('stair detection goes off in a room that has it off after a few seconds, and on again outside it', async () => {
  const writes = [];
  const { vacuum } = setup({
    robot: { setStairless: async (on) => { writes.push(on); return true; }, stairless: async () => writes.at(-1) ?? false },
  });
  const floor = vacuum.floors[1];
  floor.rooms[0].stairDetection = false;
  // A 2 m square (40 x 40 cells) at the origin.
  const zone = { points: [[0, 0], [40, 0], [40, 40], [0, 40]] };
  const q = vacuum.zoneQueue = { floor, entries: [{ room: floor.rooms[0], zone }], index: 0, phase: 'running' };
  vacuum.status = { ...idle, state: 3, atBase: false };
  vacuum.followRoomStairs({ x: 1, y: 1 }); // just entered: not yet
  assert.deepEqual(writes, []);
  q.roomSince = Date.now() - 4000;
  vacuum.followRoomStairs({ x: 1, y: 1 });
  await vacuum.settingsOps;
  assert.deepEqual(writes, [true]);
  assert.equal(vacuum.stairNeed, false);
  vacuum.followRoomStairs({ x: 2.2, y: 1 }); // 0.2 m outside: still the room
  assert.deepEqual(writes, [true]);
  vacuum.followRoomStairs({ x: 3, y: 1 }); // 1 m outside
  await vacuum.settingsOps;
  assert.deepEqual(writes, [true, false]);
  assert.equal(vacuum.stairNeed, true);
});

test('the map guard stops a job only when a second answer confirms the other map', async () => {
  const answers = [2]; // the first reply said main, the confirming one says the job's own map
  let stops = 0;
  const { vacuum } = setup({ robot: { currentMap: async () => answers.shift(), stopTask: () => { stops += 1; } } });
  vacuum.status = { ...idle, state: 3, atBase: false };
  vacuum.armMapGuard(2);
  await vacuum.applyCurrentMap(1); // asks again: 2, the job's map
  assert.equal(stops, 0);
  assert.ok(vacuum.mapGuard);
  answers.push(1);
  await vacuum.applyCurrentMap(1); // asks again: still main
  assert.equal(stops, 1);
  assert.equal(vacuum.mapGuard, undefined);
});

test('a start on another map is allowed when the rooms were just picked in the Home app', async () => {
  const { vacuum } = setup({ store: { selectedAreas: [1], robotMapId: 2 } });
  vacuum.status = idle;
  vacuum.selectedAt = Date.now() - 30 * 1000;
  await assert.rejects(vacuum.startClean(), (error) => {
    assert.doesNotMatch(error.message, /base first/);
    return true; // goes on to talk to the robot (the fake refuses)
  });
});

test('a stale room pick does not lift the "put it on its base first" refusal', async () => {
  const { vacuum, calls } = setup({ store: { selectedAreas: [1], robotMapId: 2 } });
  vacuum.status = idle;
  vacuum.selectedAt = Date.now() - 5 * 60 * 1000;
  await assert.rejects(vacuum.startClean(), /put it on its base first/);
  assert.deepEqual(calls, []);
});

test('a secondary map start with the robot on its base stays refused after a fresh pick', async () => {
  const { vacuum, calls } = setup({ store: { selectedAreas: [2004] } });
  vacuum.status = docked;
  vacuum.selectedAt = Date.now();
  await assert.rejects(vacuum.startClean(), /starting point/);
  assert.deepEqual(calls, []);
});

test('room names in the log carry their map when the robot has more than one', () => {
  const { vacuum } = setup();
  assert.equal(vacuum.roomsLabel(2, ['Gym', 'Studio']), 'Gym, Studio (Upstairs)');
  assert.equal(vacuum.roomsLabel(1, ['Kitchen']), `Kitchen (${vacuum.floorName(1)})`);
  vacuum.floors = vacuum.floors.slice(0, 1);
  assert.equal(vacuum.roomsLabel(1, ['Kitchen']), 'Kitchen');
});

test('stair detection note for the log', () => {
  const { vacuum } = setup();
  assert.equal(vacuum.stairsNote(true), 'stair detection on');
  assert.equal(vacuum.stairsNote(false, ', '), ', stair detection off');
  assert.equal(vacuum.stairsNote(undefined), '');
});

test('the trip to the starting point builds the spot zone and logs the Return zone line', async () => {
  const shape = { id: 2, width: 20, height: 20, x0: -10, y0: -10, rooms: new Array(400).fill(4), noGo: [] };
  const sent = [];
  const { vacuum } = setup({
    robot: {
      stopTask: async () => ({ ok: true }),
      mapShape: async () => shape,
      startZones: async (zones, ...rest) => { sent.push([zones, ...rest]); return { ok: true }; },
    },
  });
  const lines = [];
  vacuum.log = { info: m => lines.push(m), debug: () => {}, warn: () => {}, error: () => {} };
  const floor = { ...vacuum.floors[1], id: 2, start: { x: 0, y: 0 } };
  vacuum.status = idle;
  // Everything before the zone is covered elsewhere: stub it out so the zone code runs.
  vacuum.setOpState = async () => {};
  vacuum.update = async () => {};
  vacuum.restoreCornersBeforeTrip = async () => {};
  vacuum.backToFloor = async () => 2;
  vacuum.ensureStairs = async () => true;
  vacuum.holdSecurity = async () => {};
  vacuum.keepAutoMainMapOff = async () => {};
  vacuum.armMapGuard = () => {};
  vacuum.save = () => {};
  vacuum.tripFail = async (trip, why) => { throw new Error(`trip failed: ${why}`); };
  await vacuum.tripToStart(floor, { halted: false });
  clearInterval(vacuum.trip?.watch);
  clearTimeout(vacuum.trip?.timer);
  assert.equal(sent.length, 1);
  assert.ok(lines.some(l => /^Return zone on /.test(l)), lines.join('\n'));
});

function tripSetup(extra = {}) {
  const stops = [];
  const sent = [];
  const shape = { id: 2, width: 20, height: 20, x0: -10, y0: -10, rooms: new Array(400).fill(4), noGo: [] };
  const { vacuum } = setup({
    robot: {
      stopTask: async () => { stops.push(1); return { ok: true }; },
      mapShape: async () => shape,
      startZones: async (zones) => { sent.push(zones); return { ok: true }; },
      ...extra,
    },
  });
  const lines = [];
  vacuum.log = { info: m => lines.push(m), debug: () => {}, warn: () => {}, error: () => {} };
  const floor = { ...vacuum.floors[1], id: 2, start: { x: 0, y: 0 } };
  Object.assign(vacuum, {
    setOpState: async () => {}, update: async () => {}, restoreCornersBeforeTrip: async () => {},
    backToFloor: async () => 2, ensureStairs: async () => true, holdSecurity: async () => {},
    keepAutoMainMapOff: async () => {}, armMapGuard: () => {}, save: () => {}, cleanOver: () => {},
    refresh: async () => {}, restoreStairs: () => {}, notifySoon: () => {},
  });
  vacuum.status = idle;
  return { vacuum, floor, stops, sent, lines };
}

test('a position at the starting point during the trip stops the robot once', async () => {
  const { vacuum, floor, stops, lines } = tripSetup();
  await vacuum.tripToStart(floor, { halted: false });
  const trip = vacuum.trip;
  vacuum.status = { ...idle, state: 4 };
  trip.phase = 'running';
  trip.runningAt = Date.now() - 5000;
  vacuum.applyPose({ x: 0.08, y: 0, heading: 0 });
  vacuum.applyPose({ x: 0.05, y: 0, heading: 0 });
  assert.equal(stops.length, 1);
  assert.ok(lines.some(l => /^Stopped at the starting point of .* \(0\.08 m away\)\.$/.test(l)), lines.join('\n'));
  clearInterval(trip.watch);
  clearTimeout(trip.timer);
});

test('the previous job\'s position at the start of the trip job does not stop the robot', async () => {
  const { vacuum, floor, stops } = tripSetup();
  await vacuum.tripToStart(floor, { halted: false });
  const trip = vacuum.trip;
  vacuum.status = { ...idle, state: 4 };
  trip.phase = 'running';
  trip.runningAt = Date.now();
  vacuum.applyPose({ x: 0.02, y: 0, heading: 0 });
  assert.equal(stops.length, 0);
  clearInterval(trip.watch);
  clearTimeout(trip.timer);
});

test('a robot already at the starting point gets no zone', async () => {
  const { vacuum, floor, sent, lines } = tripSetup();
  vacuum.lastPose = { x: 0.06, y: 0, at: Date.now() };
  await vacuum.tripToStart(floor, { halted: false });
  assert.equal(sent.length, 0);
  assert.equal(vacuum.trip, undefined);
  assert.ok(lines.some(l => /^Already at the starting point of .* \(0\.06 m away\)\.$/.test(l)), lines.join('\n'));
});
