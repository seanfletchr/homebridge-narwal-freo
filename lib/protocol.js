// Narwal Freo (YJCC012 / "J3") MQTT message formats.
//
// Ported from the MIT-licensed Home Assistant integrations
// mk0000001/ha-narwal-cloud and madsah211/ha-narwal-cloud-eu, and checked
// against captures from our own Freo.

import { randomUUID } from 'node:crypto';
import { inflateSync } from 'node:zlib';

import {
  decodeFields, encodeFields, encodeVarint, fieldBytes, fieldString, fieldVarint, getFloat, getInt, getMessage, getMessages,
  unwrapTransport,
} from './proto.js';

/** Topics the robot publishes on. The broker only delivers them to explicit subscriptions. */
export const BROADCAST_TOPICS = [
  'status/robot_base_status',
  'status/working_status',
  'upgrade/upgrade_status',
  'status/download_status',
  'map/display_map',
  'status/time_line_status',
  'report/clean_report',
];

/** Extra subscriptions the official app holds (older Freo firmware won't answer get_map without them). */
export const EXTRA_SUBSCRIPTIONS = [
  'status/point_navi_plan_traj',
  'developer/planning_debug_info',
  'map/get_map/response',
  'map/get_all_reduced_maps/response',
  'map/switch_map/response',
  'config/get/response',
  'config/set/response',
  'clean/plan/get/response',
  'common/active_robot_publish/response',
  'general/service/response',
  // Replies to our commands (the robot answers on <topic>/response).
  'clean/easy_clean/start/response',
  'task/pause/response',
  'task/resume/response',
  'supply/recall/response',
  'task/force_end/response',
  'common/yell/response',
  'consumable/reset_consumable_info/response',
];

/** Narwal easy_clean modes. */
export const NarwalMode = {
  FREO_MIND: 1,
  VACUUM: 2,
  MOP: 3,
  VACUUM_AND_MOP: 4,
  VACUUM_THEN_MOP: 5,
};

/**
 * robot_base_status field 3.1 values seen on our Freo. Anything else is a cleaning job: 2 and 3 were
 * seen on vacuum / mop runs, 4 for a whole Vacuum then Mop job, mop-wash visits to the dock included.
 * 1 with field 3.3 set is idle on the dock (before and right after a job); 14 is the base station
 * working with the robot on it (field 3.12 says what: 4 = drying the mops).
 */
export const WorkState = {
  IDLE: 1,
  STATION: 14,
};

/** The robot is in a cleaning job (out cleaning, paused, or back at the dock mid-job to wash its mops). */
export function inJob(s) {
  return Boolean(s) && ![0, WorkState.IDLE, WorkState.STATION].includes(s.state);
}

/** The robot is on the dock and not in a job. */
export function onDock(s) {
  return Boolean(s) && (s.state === WorkState.STATION || (s.state === WorkState.IDLE && s.docked));
}

// Names for rooms that have a type but no custom name. The upstream table had
// 8 = Corridor, but on our Freo the Narwal app shows type 8 as "Dining Room"
// (and the corridor is type 10).
const ROOM_TYPE_NAMES = {
  0: 'Room', 1: 'Master Bedroom', 2: 'Secondary Bedroom', 3: 'Living Room', 4: 'Kitchen', 5: 'Bathroom',
  6: 'Toilet', 7: 'Balcony', 8: 'Dining Room', 9: 'Closet', 10: 'Hallway', 11: 'Study', 12: "Kids' Room",
  13: 'Entertainment Room', 14: 'Storage Room', 15: 'Other Room',
};

/**
 * Wrap a command body in Narwal's request header. The header names the
 * account (twice) and the topic the robot should reply on, plus a request id;
 * the command body follows outside the declared header length.
 */
export function taskPayload(clientUuid, responseTopic, body = Buffer.alloc(0), id = randomUUID()) {
  const response = Buffer.concat([fieldString(1, responseTopic), fieldString(2, id)]);
  const header = Buffer.concat([fieldString(1, clientUuid), fieldString(2, clientUuid), fieldBytes(5, response)]);
  return Buffer.concat([Buffer.from([1]), encodeVarint(header.length), header, body]);
}

/**
 * MQTT 5 publish properties like the Narwal app sends. The Freo only answers a request that carries
 * them (the response topic inside the payload header alone is ignored): Response Topic plus
 * Correlation Data { 1: request id (the one in the payload header), 4: time in ms }.
 */
export function requestProperties(responseTopic, id) {
  return {
    responseTopic,
    correlationData: Buffer.concat([fieldString(1, id), fieldVarint(4, Date.now())]),
  };
}

/** The request id inside a reply's correlation data (or undefined). */
export function correlationId(correlationData) {
  try {
    const id = getMessage(decodeFields(correlationData), 1);
    return id ? id.toString('utf8') : undefined;
  } catch {
    return undefined;
  }
}

/** Result code of a command's reply: 1 = ok. Replies are `08 <code>`, with or without the transport header. */
export function parseCommandResult(payload) {
  let body = payload;
  try {
    ({ body } = unwrapTransport(payload));
  } catch {
    // bare protobuf
  }
  return getInt(decodeFields(body), 1);
}

/** Ask the robot to publish its broadcasts for `seconds` (what the app does when opened). */
export function activeRobotBody(seconds = 600) {
  return Buffer.concat(BROADCAST_TOPICS.map(topic =>
    fieldBytes(1, Buffer.concat([fieldString(1, topic), fieldVarint(2, seconds)]))));
}

/** The official app's "app opened" sequence: [topic suffix, body, wants a response]. */
export function wakeRequests() {
  return [
    ['common/notify_app_event', fieldVarint(1, 1), true],
    ['common/active_robot_publish', activeRobotBody(600), true],
    ['common/active_robot_publish', fieldVarint(1, 600), false],
    ['status/app_status_heartbeat', fieldVarint(1, 1), false],
    ['status/get_device_base_status', Buffer.alloc(0), true],
  ];
}

/** consumable/reset_consumable_info body: { 1: { 2: consumable type } } (types as in the cloud's consumables list). */
export function resetConsumableBody(type) {
  return fieldBytes(1, fieldVarint(2, type));
}

/** map/switch_map body: { 1: map id }. The robot's reply is `08 01`; it announces nothing else. */
export function switchMapBody(mapId) {
  return fieldVarint(1, mapId);
}

/**
 * config/set body for "stairless mode" (the Narwal app's stair detection switch, inverted): a single
 * varint, field 11 = 1 stairless (stair detection off), 0 stair detection on.
 */
export function stairlessBody(stairless) {
  return fieldVarint(11, stairless ? 1 : 0);
}

/** config/set body for "Automatically switch to the main map after cleaning" (captured 2026-10-21): field 20 = 1 on, 0 off. */
export function autoMainMapBody(on) {
  return fieldVarint(20, on ? 1 : 0);
}

export function forceEndBody() {
  return fieldBytes(2, Buffer.from([1, 2]));
}

/**
 * Build a clean/easy_clean/start body. Uses the official app's per-room
 * template for this mode when available (it carries the suction, water and
 * pass settings chosen in the Narwal app), otherwise the defaults the HA
 * integration verified for each mode. `settings` ({ passes, suction, water },
 * each optional) overrides the template's values.
 */
export function easyCleanBody(roomIds, mode, templates = {}, settings = {}) {
  const parts = [fieldVarint(1, mode), fieldVarint(2, 1)];
  for (const roomId of roomIds) {
    const room = templates[roomId] ?? defaultRoomSettings(roomId, mode);
    parts.push(fieldBytes(3, withSettings(room, mode, settings)));
  }
  return Buffer.concat(parts);
}

/** A signed protobuf varint field (negative numbers take ten bytes, as int64). */
function fieldSigned(number, value) {
  return Buffer.concat([encodeVarint(number << 3), encodeVarint(BigInt.asUintN(64, BigInt(value)))]);
}

/**
 * Build a clean/easy_clean/start body for zones, the way the Narwal app does on a map without a base
 * station (where rooms can't be picked): `{ 1: mode, 2: 2 (zones; rooms are 1), 3: zone, … }` with
 * each zone `{ 1: number from 1, 2: 2, 3: outline, then the room's settings }` and the outline
 * `{ 1: { 1: x, 2: y } … the zone's edge cell by cell, 2: { 1: x, 2: y } × 4 the corners of its box }`.
 * `zones` is [{ roomId, points, box }]; the settings (suction, water, passes) are the room's
 * template for the mode, or the defaults, with `settings` applied, exactly as for a room clean.
 */
export function zoneCleanBody(zones, mode, templates = {}, settings = {}) {
  const parts = [fieldVarint(1, mode), fieldVarint(2, 2)];
  zones.forEach((zone, index) => {
    const room = withSettings(templates[zone.roomId] ?? defaultRoomSettings(zone.roomId, mode), mode, settings);
    const point = ([x, y]) => Buffer.concat([fieldSigned(1, x), fieldSigned(2, y)]);
    const outline = Buffer.concat([
      ...zone.points.map(p => fieldBytes(1, point(p))),
      ...zone.box.map(p => fieldBytes(2, point(p))),
    ]);
    const message = encodeFields([
      { number: 1, wireType: 0, value: index + 1 },
      { number: 2, wireType: 0, value: 2 },
      { number: 3, wireType: 2, value: outline },
      ...decodeFields(room).filter(f => ![1, 2, 3].includes(f.number)),
    ]);
    parts.push(fieldBytes(3, message));
  });
  return Buffer.concat(parts);
}

/** Suction (vacuum) and water level (mop) values in room settings. */
export const Suction = { quiet: 1, standard: 2, strong: 3 };
export const Water = { dry: 1, standard: 2, wet: 3 };

/** Replace varint fields of a message ({ fieldNumber: value }; undefined values are left alone). */
function setFields(message, values) {
  const set = Object.entries(values).filter(([, v]) => v !== undefined).map(([n, v]) => [Number(n), v]);
  const fields = decodeFields(message).filter(f => !set.some(([n]) => n === f.number));
  for (const [number, value] of set) {
    fields.push({ number, wireType: 0, value });
  }
  fields.sort((a, b) => a.number - b.number);
  return encodeFields(fields);
}

/**
 * Apply pass / suction / water overrides to a room message, keeping everything else.
 * Room field 4 = vacuum { 1 suction, 2 passes }, 5 = mop { 1 const, 2 passes, 3 water },
 * 6 = vacuum and mop { 1 suction, 2 vacuum passes, 3 water, 4 mop passes },
 * 7 = vacuum then mop { 1 vacuum settings, 2 mop settings }. Freo Mind is left as is.
 */
function withSettings(room, mode, { passes, suction, water } = {}) {
  if (passes === undefined && suction === undefined && water === undefined) {
    return room;
  }
  const vacuum = msg => setFields(msg, { 1: suction, 2: passes });
  const mop = msg => setFields(msg, { 2: passes, 3: water });
  const edit = {
    [NarwalMode.VACUUM]: [4, vacuum],
    [NarwalMode.MOP]: [5, mop],
    [NarwalMode.VACUUM_AND_MOP]: [6, msg => setFields(msg, { 1: suction, 2: passes, 3: water, 4: passes })],
    [NarwalMode.VACUUM_THEN_MOP]: [7, msg => encodeFields(decodeFields(msg).map(p => {
      if (p.wireType !== 2) {
        return p;
      }
      return p.number === 1 ? { ...p, value: vacuum(p.value) } : p.number === 2 ? { ...p, value: mop(p.value) } : p;
    }))],
  }[mode];
  if (!edit) {
    return room;
  }
  const [settingsField, change] = edit;
  return encodeFields(decodeFields(room).map(f =>
    (f.number === settingsField && f.wireType === 2) ? { ...f, value: change(f.value) } : f));
}

function defaultRoomSettings(roomId, mode) {
  const suction = 2;
  const humidity = 2;
  const cycles = 1;
  const room = [fieldVarint(1, roomId)];
  if (mode === NarwalMode.FREO_MIND) {
    room.push(fieldVarint(2, 3), fieldBytes(6, Buffer.concat([
      fieldVarint(1, 2), fieldVarint(2, 1), fieldVarint(3, 2), fieldVarint(4, 1)])));
  } else if (mode === NarwalMode.VACUUM) {
    room.push(fieldVarint(2, 1), fieldBytes(4, Buffer.concat([fieldVarint(1, suction), fieldVarint(2, cycles)])));
  } else if (mode === NarwalMode.MOP) {
    room.push(fieldVarint(2, 1), fieldBytes(5, Buffer.concat([
      fieldVarint(1, 1), fieldVarint(2, cycles), fieldVarint(3, humidity)])));
  } else if (mode === NarwalMode.VACUUM_AND_MOP) {
    room.push(fieldVarint(2, 1), fieldBytes(6, Buffer.concat([
      fieldVarint(1, suction), fieldVarint(2, cycles), fieldVarint(3, humidity), fieldVarint(4, cycles)])));
  } else {
    const vacuum = Buffer.concat([fieldVarint(1, suction), fieldVarint(2, cycles)]);
    const mop = Buffer.concat([fieldVarint(1, 1), fieldVarint(2, cycles), fieldVarint(3, humidity)]);
    room.push(fieldVarint(2, 1), fieldBytes(7, Buffer.concat([fieldBytes(1, vacuum), fieldBytes(2, mop)])));
  }
  return Buffer.concat(room);
}

/**
 * Parse status/robot_base_status (published every ~1.5 s while active).
 * Field meanings were worked out by watching our robot through
 * vacuum / pause / resume / dock / mop runs.
 */
export function parseBaseStatus(payload) {
  const fields = decodeFields(payload);
  const battery = getFloat(fields, 2);
  const work = getMessage(fields, 3);
  const w = work ? decodeFields(work) : [];
  // Field 1 carries the current error/notice code (empty when there is none).
  const notice = getMessage(fields, 1);
  let code;
  if (notice?.length) {
    try {
      code = getInt(decodeFields(notice), 1);
    } catch {
      code = undefined;
    }
  }
  const base = getInt(fields, 11, 0);
  return {
    code,
    // Protobuf leaves out zero values, so a missing battery field is 0% (a flat robot charging), not unknown.
    battery: Math.max(0, Math.min(100, Math.round(battery ?? 0))),
    state: getInt(w, 1, 0),
    paused: getInt(w, 2, 0) > 0,
    docked: getInt(w, 3, 0) === 1,
    step: getInt(w, 7, 0),
    station: getInt(w, 12, 0),
    returning: getInt(w, 10, 0),
    dockFlag: getInt(fields, 7, 0),
    // Field 11 (`base`): 1 while the robot is out of the base, 2 in it (also mid-job, washing the mops),
    // 3 drying, 0 unknown.
    base,
    atBase: base >= 2,
  };
}

// Size of a map unit in metres (checked 2026-10-16: 47.1 units measured as 2.24 m from the base).
export const MAP_UNIT = 0.05;

/**
 * map/display_map (every ~1.5 s during a job): field 1 is the robot's pose, {1: {1: x, 2: y} in
 * map units of 5 cm (returned here in metres), 2: heading in radians}, the base at about (0, 0);
 * field 2 the trail so far. The pose stays exactly the same while
 * the robot stands still (or is lifted), and can jump far while it re-localises after being moved.
 */
export function parseDisplayMap(payload) {
  const pose = getMessage(decodeFields(payload), 1);
  if (!pose) {
    return undefined;
  }
  const p = decodeFields(pose);
  const xy = decodeFields(getMessage(p, 1) ?? Buffer.alloc(0));
  // Zero coordinates are left out of the message.
  return { x: getFloat(xy, 1, 0) * MAP_UNIT, y: getFloat(xy, 2, 0) * MAP_UNIT, heading: getFloat(p, 2, 0) };
}

/**
 * report/clean_report (sent once when a job ends): 1 percent done, 2 area in m² (float32), 3 seconds,
 * 6 / 7 start / end (Unix seconds), 8 how it ended (1 finished, 2 stopped early by the user).
 */
export function parseCleanReport(payload) {
  const fields = decodeFields(payload);
  let area = getFloat(fields, 2);
  if (area === undefined) {
    const raw = getMessage(fields, 2);
    area = raw?.length === 4 ? raw.readFloatLE(0) : undefined;
  }
  return {
    percent: getInt(fields, 1),
    area,
    seconds: getInt(fields, 3),
    start: getInt(fields, 6),
    end: getInt(fields, 7),
    reason: getInt(fields, 8),
  };
}

/** status/working_status: field 3 elapsed seconds, 6 current room id. */
export function parseWorkingStatus(payload) {
  if (!payload.length) {
    return {};
  }
  const fields = decodeFields(payload);
  return { elapsed: getInt(fields, 3), roomId: getInt(fields, 6) };
}

/** Rooms of a map message (a get_map reply and a reduced-map entry share the layout): [{ id, name, type }]. */
function parseRooms(mapFields) {
  const rooms = [];
  const seen = {};
  for (const raw of getMessages(mapFields, 12)) {
    const room = decodeFields(raw);
    const id = getInt(room, 1, 0);
    const type = getInt(room, 2, 0);
    const index = getInt(room, 8, 0);
    let name = (getMessage(room, 3) ?? Buffer.alloc(0)).toString('utf8').trim();
    if (!name) {
      name = ROOM_TYPE_NAMES[type] ?? 'Room';
      if (index > 1) {
        name = `${name} ${index}`;
      }
    }
    seen[name] = (seen[name] ?? 0) + 1;
    if (seen[name] > 1) {
      name = `${name} ${seen[name]}`;
    }
    if (id) {
      rooms.push({ id, name, type });
    }
  }
  return rooms;
}

function responseBody(payload, what) {
  const { body } = unwrapTransport(payload);
  const response = decodeFields(body);
  if (getInt(response, 1) !== 1) {
    throw new Error(`Narwal ${what} request was not successful`);
  }
  return response;
}

/**
 * Parse map/get_map/response into the id of the robot's current map. The reply goes to every client
 * that asked, and carries whichever map is current; its field 1 is the map id (small integer), not a revision.
 */
export function parseCurrentMapId(payload) {
  const map = getMessage(responseBody(payload, 'map'), 2);
  return map ? getInt(decodeFields(map), 1) : undefined;
}

/**
 * Parse map/get_map/response into { id, rooms } for the current map. Only this reply carries each room's
 * type (and custom name); the saved-map list (get_all_reduced_maps) has just the room ids.
 */
export function parseMapReplyRooms(payload) {
  const map = getMessage(responseBody(payload, 'map'), 2);
  if (!map) {
    return undefined;
  }
  const fields = decodeFields(map);
  return { id: getInt(fields, 1), rooms: parseRooms(fields) };
}

/**
 * The saved maps with each room's type and name taken from `info` (map id -> rooms from a get_map reply)
 * where the robot has told us. Rooms and maps without information are left as they are.
 */
export function mergeRoomInfo(maps, info) {
  return maps.map((map) => {
    const known = info.get(map.id);
    if (!known) {
      return map;
    }
    return { ...map, rooms: map.rooms.map(room => ({ ...room, ...(known.find(k => k.id === room.id) ?? {}) })) };
  });
}

const signed = value => Number(BigInt.asIntN(64, BigInt(value)));
const signedField = (fields, number) => {
  const hit = fields.find(f => f.number === number && f.wireType === 0);
  return hit ? signed(hit.value) : undefined;
};

/**
 * Parse a map/get_map reply into the shape of the current map's rooms: { id, width, height, x0, y0,
 * rooms: Uint8Array (room id per cell, 0 = none; cell (col, row) is at row * width + col), noGo }.
 * Checked against the app's zone clean on 2026-10-21. Map message: 4 = width in cells, 5 = height,
 * 6 = { 1: first row's y, 3: first column's x, … } so a cell's zone coordinates are (x0 + col, y0 + row),
 * 9 = no-go zones { 1: corner { 1: x, 2: y } (floats, same coordinates) … }, 17 = zlib of `{ 1: cells }`.
 * Cells run row by row; a cell whose first byte has bit 7 set (floor) is followed by a second byte, the
 * room: its id times two. Other first bytes (0 unknown, 32/40 wall, 8 door) are single-byte cells.
 * Undefined when the reply has no bitmap or it doesn't add up.
 */
export function parseMapShape(payload) {
  const map = getMessage(responseBody(payload, 'map'), 2);
  if (!map) {
    return undefined;
  }
  const fields = decodeFields(map);
  const width = getInt(fields, 4, 0);
  const height = getInt(fields, 5, 0);
  const bounds = getMessage(fields, 6);
  const bitmap = getMessage(fields, 17);
  if (!width || !height || !bounds || !bitmap) {
    return undefined;
  }
  const cells = getMessage(decodeFields(inflateSync(bitmap)), 1);
  if (!cells) {
    return undefined;
  }
  const rooms = new Uint8Array(width * height);
  let pos = 0;
  for (let n = 0; n < rooms.length; n++) {
    if (pos >= cells.length) {
      return undefined;
    }
    const state = cells[pos++];
    if (state & 0x80) {
      if (pos >= cells.length) {
        return undefined;
      }
      const room = cells[pos++] >> 1;
      // Bit 4 marks the band of floor along walls and obstacles, which the app's outlines leave out.
      rooms[n] = state & 0x10 ? 0 : room;
    }
  }
  const frame = decodeFields(bounds);
  const noGo = getMessages(fields, 9).map(raw => getMessages(decodeFields(raw), 1).map((point) => {
    const xy = decodeFields(point);
    return [getFloat(xy, 1, 0), getFloat(xy, 2, 0)];
  }));
  return {
    id: getInt(fields, 1),
    width,
    height,
    y0: signedField(frame, 1) ?? 0,
    x0: signedField(frame, 3) ?? 0,
    rooms,
    noGo,
  };
}

/**
 * Parse map/get_all_reduced_maps/response: every saved map with its rooms, [{ id, name, hasDock, main, start, rooms }].
 * Entry field 1 = map id, 28 = name (the first map has none), 7 = starting point (the "P" in the app; x, y
 * in metres, about (0, 0) in the frame the robot's position uses), 8 = dock pose (x = y = 10000 means no
 * dock), 12 = rooms, 30 = 1 on the main map.
 */
export function parseReducedMaps(payload) {
  const maps = [];
  for (const raw of getMessages(responseBody(payload, 'map list'), 2)) {
    const entry = decodeFields(raw);
    const id = getInt(entry, 1, 0);
    if (!id) {
      continue;
    }
    const dock = getMessage(entry, 8);
    let hasDock = false;
    if (dock?.length) {
      const xy = decodeFields(getMessage(decodeFields(dock), 1) ?? Buffer.alloc(0));
      hasDock = !(getFloat(xy, 1, 0) >= 10000 && getFloat(xy, 2, 0) >= 10000);
    }
    const startPose = getMessage(entry, 7);
    const startXy = startPose?.length ? decodeFields(getMessage(decodeFields(startPose), 1) ?? Buffer.alloc(0)) : [];
    maps.push({
      id,
      name: (getMessage(entry, 28) ?? Buffer.alloc(0)).toString('utf8').trim(),
      hasDock,
      main: getInt(entry, 30, 0) === 1,
      start: { x: getFloat(startXy, 1, 0) * MAP_UNIT, y: getFloat(startXy, 2, 0) * MAP_UNIT },
      rooms: parseRooms(entry),
    });
  }
  return maps;
}

/** The map the vacuum is published for: the one with a dock (several: the one flagged main, else the lowest id). */
export function pickMainMap(maps) {
  const docked = maps.filter(m => m.hasDock).sort((a, b) => a.id - b.id);
  return docked.find(m => m.main) ?? docked[0];
}

/**
 * Parse a config/get reply into whether the robot is in "stairless mode" (stair detection off):
 * reply field 2 holds the settings and its field 10 is 1 exactly while stairless mode is on. Checked
 * against the app's two toggles in the 2026-10-21 capture (set field 11 = 0: field 10 vanished; set
 * field 11 = 1: field 10 = 1 again); the settings' own field 11 stays 1 whatever the app does, so
 * the write goes to field 11 and the read to field 10. Undefined when the reply has no settings.
 */
export function parseStairless(payload) {
  const settings = getMessage(responseBody(payload, 'settings'), 2);
  return settings ? getInt(decodeFields(settings), 10, 0) === 1 : undefined;
}

/** Parse a config/get reply into whether "switch to the main map after cleaning" is on (settings field 20 = 1); undefined when the reply has no settings. */
export function parseAutoMainMap(payload) {
  const settings = getMessage(responseBody(payload, 'settings'), 2);
  return settings ? getInt(decodeFields(settings), 20, 0) === 1 : undefined;
}

/**
 * Parse clean/plan/get/response: the app's saved plan per mode, each holding
 * the exact room messages easy_clean/start accepts. Returns { mode: { roomId: hex } }.
 */
export function parsePlansResponse(payload) {
  const { body } = unwrapTransport(payload);
  const response = decodeFields(body);
  if (getInt(response, 1) !== 1) {
    throw new Error('Narwal cleaning-plan request was not successful');
  }
  const plans = {};
  for (const rawPlan of getMessages(response, 2)) {
    const plan = decodeFields(rawPlan);
    const mode = getInt(plan, 3, 0);
    const templates = {};
    for (const template of getMessages(plan, 9)) {
      const roomId = getInt(decodeFields(template), 1, 0);
      if (roomId) {
        templates[roomId] = Buffer.from(template).toString('hex');
      }
    }
    if (mode) {
      plans[mode] = templates;
    }
  }
  return plans;
}
