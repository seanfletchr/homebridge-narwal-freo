// The robot's saved maps and their rooms as the Home app sees them, with the display names
// and stair detection chosen in the plugin settings (`maps` of a robot):
//   maps: [{ id, name, stairDetection, roomOrder: [room id, …], rooms: [{ id, name, stairDetection }] }]   (every field but `id` optional)

const NAME_MAX = 64; // Matter's limit for map and area names

/**
 * Matter area id of a room. The main map's rooms keep their Narwal room id (that is what 0.5.0 and
 * earlier published, and Home scenes and automations remember it); another map's rooms are
 * `map id * 1000 + room id`, since room ids repeat from map to map.
 */
export function areaIdFor(mainMapId, mapId, roomId) {
  return mapId === mainMapId ? roomId : mapId * 1000 + roomId;
}

/** A name that isn't in `used` yet ("Hallway", "Hallway 2", …); adds it to `used`. */
function unique(name, used) {
  let candidate = name;
  for (let n = 2; used.has(candidate.toLowerCase()); n++) {
    candidate = `${name} ${n}`;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

/**
 * A room's name with its map's in brackets ("Corridor (Upstairs)"). The room's own part gives way if
 * the whole name would be longer than Matter allows.
 */
function withMap(name, mapName) {
  const suffix = ` (${mapName})`;
  if (suffix.length > NAME_MAX - 8) {
    return name;
  }
  return `${name.slice(0, NAME_MAX - suffix.length).trimEnd()}${suffix}`;
}

const clean = text => (typeof text === 'string' ? text.trim().slice(0, NAME_MAX) : '');

/**
 * The maps to publish, in map id order (the robot lists them in its own order).
 * @param {Array} maps the robot's maps, as saved by the plugin ([{ id, name, hasDock, main, start, rooms }])
 * @param {number} mainId the map the vacuum has always been published for (the one with the base station)
 * @param {Array} [settings] the `maps` setting
 * @returns {Array} [{ id, name, narwalName, main, hasDock, start, stairDetection, roomOrder, managed, rooms }] where
 *   `name` is what the Home app shows, `roomOrder` the Narwal room ids in the order chosen for cleaning a map's
 *   rooms ([] = automatic), `managed` is whether the plugin sets the robot's stair detection
 *   for this map (every map of a robot with several maps; a lone map only when the user chose a value),
 *   and each room is { id (Narwal's), areaId, name, baseName, narwalName, type, stairDetection }. A room's
 *   `name` is `baseName` (its custom or Narwal name, made different within its map), plus its map's name
 *   in brackets when a room of another map has the same name, on the secondary maps (maps without the
 *   base station, i.e. any but the main one); `stairDetection` is the room's own setting, else its map's.
 */
export function buildFloors(maps = [], mainId, settings = []) {
  const entries = Array.isArray(settings) ? settings : [];
  const usedMaps = new Set();
  const floors = [...maps].sort((a, b) => a.id - b.id).map((map) => {
    const entry = entries.find(e => Number(e?.id) === map.id);
    const narwalName = clean(map.name) || (map.id === mainId ? 'Main Map' : `Map ${map.id}`);
    const usedRooms = new Set();
    const name = unique(clean(entry?.name) || narwalName, usedMaps);
    const main = map.id === mainId;
    const stairDetection = typeof entry?.stairDetection === 'boolean' ? entry.stairDetection : true;
    return {
      id: map.id,
      name,
      narwalName,
      main,
      hasDock: map.hasDock !== false,
      start: map.start ?? { x: 0, y: 0 },
      stairDetection,
      roomOrder: Array.isArray(entry?.roomOrder) ? [...new Set(entry.roomOrder.map(Number).filter(Number.isInteger))] : [],
      managed: maps.length > 1 || typeof entry?.stairDetection === 'boolean',
      rooms: (map.rooms ?? []).map((room) => {
        const saved = entry?.rooms?.find(r => Number(r?.id) === room.id);
        // Names are made different within the map first ("Bedroom 2").
        const baseName = unique(clean(saved?.name) || room.name, usedRooms);
        return {
          id: room.id,
          areaId: areaIdFor(mainId, map.id, room.id),
          name: baseName,
          baseName,
          narwalName: room.name,
          type: room.type,
          stairDetection: typeof saved?.stairDetection === 'boolean' ? saved.stairDetection : stairDetection,
        };
      }),
    };
  });
  // Then the map's name goes onto a room of a secondary map that shares its name with a room of another map.
  for (const floor of floors) {
    if (floor.main) {
      continue;
    }
    for (const room of floor.rooms) {
      const key = room.baseName.toLowerCase();
      if (floors.some(other => other !== floor && other.rooms.some(r => r.baseName.toLowerCase() === key))) {
        room.name = withMap(room.baseName, floor.name);
      }
    }
  }
  return floors;
}

/** Every room of every map, with the map's id: [{ areaId, mapId, roomId, name, baseName, narwalName, type }]. */
export function allAreas(floors) {
  return floors.flatMap(f => f.rooms.map(r => ({
    areaId: r.areaId, mapId: f.id, roomId: r.id, name: r.name, baseName: r.baseName, narwalName: r.narwalName, type: r.type,
  })));
}

/**
 * A robot's saved maps for the settings page, as the robot names them: [{ id, name, main, hasDock, rooms: [{ id, name }] }].
 * Reads the plugin's saved state, including the layout of 0.5.x and earlier (one map's rooms).
 */
export function savedMaps(robotStore = {}) {
  const maps = robotStore.maps
    ?? (robotStore.rooms?.length ? [{ id: robotStore.mapId ?? 1, name: '', hasDock: true, main: true, rooms: robotStore.rooms }] : []);
  const mainId = robotStore.mainMapId ?? maps.find(m => m.main)?.id;
  return buildFloors(maps, mainId).map(f => ({
    id: f.id,
    name: f.narwalName,
    main: f.main,
    hasDock: f.hasDock,
    rooms: f.rooms.map(r => ({ id: r.id, name: r.narwalName })),
  }));
}
