// Room shapes for zone cleaning. On a map without a base station the Narwal app offers no rooms, only
// zones, and the robot takes a zone as an outline of cells (see zoneCleanBody in protocol.js). A room's
// outline is the edge of its floor cells on the map (parseMapShape), minus the map's no-go zones.

const DIRECTIONS = [[0, -1], [1, 0], [0, 1], [-1, 0]]; // north, east, south, west (y grows southward)

// A patch of floor smaller than this many cells (about 0.1 m²) is a speck, not a part of the room.
const MIN_CELLS = 40;

/** Whether (x, y) is inside a polygon (ray casting). */
function insidePolygon(polygon, x, y) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (((yi > y) !== (yj > y)) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Trace a region's edge with the right hand on the wall: the cells along its boundary, step by step
 * (each one next to the last), starting at the top row's right end and heading west, as the app's
 * outlines do. `has(x, y)` tells whether a cell is in the region.
 */
function trace(start, has, limit) {
  const path = [start];
  let [x, y] = start;
  let heading = 3; // west
  let first;
  for (let step = 0; step < limit; step++) {
    let moved;
    for (const turn of [1, 0, 3, 2]) { // right, straight, left, back
      const d = (heading + turn) % 4;
      if (has(x + DIRECTIONS[d][0], y + DIRECTIONS[d][1])) {
        moved = d;
        break;
      }
    }
    if (moved === undefined) {
      break; // a single cell
    }
    if (first === undefined) {
      first = moved;
    } else if (x === start[0] && y === start[1] && moved === first) {
      break; // back at the start and about to go round again
    }
    x += DIRECTIONS[moved][0];
    y += DIRECTIONS[moved][1];
    heading = moved;
    path.push([x, y]);
  }
  // The loop closes on the start cell; the app's outlines don't repeat it.
  const last = path[path.length - 1];
  if (path.length > 1 && last[0] === start[0] && last[1] === start[1]) {
    path.pop();
  }
  return path;
}

/**
 * The outlines of one room, one per separate patch of floor: [{ cells, points, box }] in zone
 * coordinates, ordered as the app's are: `points` a closed loop that isn't repeated at its end,
 * `box` the corners of its bounding box (top right, top left, bottom left, bottom right). The biggest
 * patch comes first. Empty when the map has no floor for the room.
 * @param {object} shape from parseMapShape
 * @param {number} roomId
 */
export function roomOutlines(shape, roomId) {
  const { width, height, x0, y0, rooms, noGo } = shape;
  const free = new Uint8Array(width * height);
  for (let i = 0; i < free.length; i++) {
    if (rooms[i] !== roomId) {
      continue;
    }
    const x = x0 + (i % width);
    const y = y0 + Math.floor(i / width);
    // A no-go zone takes the cells on its low-x edge but not those on its low-y edge, as the app's
    // outline does (checked against its hallway zone): the cell is tested a little up and right.
    free[i] = noGo.some(zone => insidePolygon(zone, x + 0.25, y - 0.25)) ? 0 : 1;
  }
  const seen = new Uint8Array(width * height);
  const patches = [];
  for (let i = 0; i < free.length; i++) {
    if (!free[i] || seen[i]) {
      continue;
    }
    // Flood the patch (cells next to each other, not diagonal).
    const cells = [];
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const at = stack.pop();
      cells.push(at);
      const col = at % width;
      for (const next of [col > 0 ? at - 1 : -1, col < width - 1 ? at + 1 : -1, at - width, at + width]) {
        if (next >= 0 && next < free.length && free[next] && !seen[next]) {
          seen[next] = 1;
          stack.push(next);
        }
      }
    }
    if (cells.length >= MIN_CELLS) {
      patches.push(cells);
    }
  }
  patches.sort((a, b) => b.length - a.length);

  return patches.map(cells => outlineOf(shape, cells));
}

/**
 * The outline of one patch of cells (indexes into the map's cell array, cells next to each other):
 * { cells, points, box } as roomOutlines describes.
 */
function outlineOf(shape, cells) {
  const { width, height, x0, y0 } = shape;
  const inPatch = new Set(cells);
  const has = (x, y) => {
    const col = x - x0;
    const row = y - y0;
    return col >= 0 && col < width && row >= 0 && row < height && inPatch.has(row * width + col);
  };
  // Top row, right end.
  let top = cells[0];
  for (const at of cells) {
    const row = Math.floor(at / width);
    const topRow = Math.floor(top / width);
    if (row < topRow || (row === topRow && at % width > top % width)) {
      top = at;
    }
  }
  const start = [x0 + (top % width), y0 + Math.floor(top / width)];
  const points = trace(start, has, cells.length * 4 + 8);
  const xs = points.map(p => p[0]);
  const ys = points.map(p => p[1]);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  return {
    cells: cells.length,
    points,
    box: [[maxX, minY], [minX, minY], [minX, maxY], [maxX, maxY]],
  };
}

/**
 * How far a point is outside an outline: 0 inside it (or on its edge), else the distance to the nearest
 * edge. Everything is in cells (5 cm each), the outline being `points` as roomOutlines gives them.
 */
export function outlineDistance(points, x, y) {
  if (points.length < 3 || insidePolygon(points, x, y)) {
    return 0;
  }
  let best = Infinity;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [ax, ay] = points[j];
    const [bx, by] = points[i];
    const length2 = (bx - ax) ** 2 + (by - ay) ** 2;
    const t = length2 ? Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / length2)) : 0;
    best = Math.min(best, Math.hypot(x - (ax + t * (bx - ax)), y - (ay + t * (by - ay))));
  }
  return best;
}

// The zone a robot is sent to, to take it to a map's starting point: this many cells (5 cm each) a side.
export const SPOT_CELLS = 4;
export const SPOT_FALLBACK_CELLS = 6; // tried once if the robot refuses the small zone

/**
 * A small square zone around a point, to move the robot there (a map without a base station has no
 * "go to" command; a zone clean is the only way to send it somewhere). `point` is in cells (the map's
 * zone coordinates, 5 cm each). The square is SPOT_CELLS cells a side with the point in its middle,
 * clipped to the map's floor cells: if the point's own cell isn't floor, the nearest floor cell is the
 * middle instead. Returns { roomId, cell: [x, y] (the middle), cells, points, box } like roomOutlines
 * (roomId = the room at the middle cell), or undefined when the map has no floor.
 * @param {object} shape from parseMapShape
 * @param {{x: number, y: number}} point in cells
 */
export function spotOutline(shape, point, size = SPOT_CELLS) {
  const { width, height, x0, y0, rooms, noGo } = shape;
  const floorAt = (x, y) => {
    const col = x - x0;
    const row = y - y0;
    if (col < 0 || col >= width || row < 0 || row >= height || !rooms[row * width + col]) {
      return false;
    }
    return !noGo.some(zone => insidePolygon(zone, x + 0.25, y - 0.25));
  };
  const px = Math.round(point.x);
  const py = Math.round(point.y);
  // The point's cell, else the nearest floor cell (searching outwards ring by ring).
  let middle;
  const reach = Math.max(width, height);
  for (let r = 0; r <= reach && !middle; r++) {
    let best;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r || !floorAt(px + dx, py + dy)) {
          continue;
        }
        const d = dx * dx + dy * dy;
        if (!best || d < best.d) {
          best = { d, x: px + dx, y: py + dy };
        }
      }
    }
    middle = best;
  }
  if (!middle) {
    return undefined;
  }
  // `size` cells a side with the middle cell just right of and below the centre (half left/up, half - 1 right/down).
  const half = size / 2;
  const members = new Set();
  const stack = [[middle.x, middle.y]];
  const inBlock = (x, y) => x >= middle.x - half && x < middle.x - half + size
    && y >= middle.y - half && y < middle.y - half + size;
  while (stack.length) {
    const [x, y] = stack.pop();
    const key = (y - y0) * width + (x - x0);
    if (members.has(key) || !inBlock(x, y) || !floorAt(x, y)) {
      continue;
    }
    members.add(key);
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  const outline = outlineOf(shape, [...members]);
  return {
    roomId: rooms[(middle.y - y0) * width + (middle.x - x0)],
    cell: [middle.x, middle.y],
    ...outline,
  };
}

/**
 * One short line for the log about a spot zone: its size, its cells (fewer than a full square when walls
 * clipped it) and, when the starting point itself wasn't floor, how far the middle moved.
 * @param {object} zone from spotOutline
 * @param {{size?: number, fellBack?: boolean, point?: {x: number, y: number}}} opts size in cells; point in cells
 */
export function spotNote(zone, { size = SPOT_CELLS, fellBack = false, point } = {}) {
  const cm = size * 5;
  let text = fellBack ? `${cm} cm spot (the robot refused ${SPOT_CELLS * 5} cm)` : `${cm} cm spot`;
  const full = size * size;
  text += zone.cells < full ? `, clipped by a wall: ${zone.cells} of ${full} cells` : `, ${zone.cells} cells`;
  if (point) {
    const off = Math.hypot(zone.cell[0] - Math.round(point.x), zone.cell[1] - Math.round(point.y)) * 5;
    if (off >= 1) {
      text += `, middle ${Math.round(off)} cm from the starting point`;
    }
  }
  return text;
}

/**
 * The order to clean rooms in, like the Freo does on its main map (it starts in the base's area and works
 * outwards): the room the point `from` (cells, a map's starting point) is in, or the one whose floor is
 * nearest to it; then, again and again, the remaining room nearest to the one before. The distance
 * between two rooms is the smallest distance between their outlines (their edge cells), so a long
 * corridor counts as close to every room along it; ties go to the earlier room in `roomIds`.
 * `preferred` (room ids) are cleaned first, in that order (those not among `roomIds` are ignored); the
 * rest follow by the rule above, starting from the last preferred room. Rooms with no floor on the map
 * keep their place at the end.
 * @param {object} shape from parseMapShape
 * @param {number[]} roomIds in the order asked for
 * @param {{x: number, y: number}} from in cells
 * @param {number[]} [preferred]
 */
export function nearestFirst(shape, roomIds, from, preferred = []) {
  const { width, x0, y0, rooms } = shape;
  const cells = new Map(roomIds.map(id => [id, []]));
  for (let i = 0; i < rooms.length; i++) {
    cells.get(rooms[i])?.push(i);
  }
  const edge = new Map();
  for (const [id, list] of cells) {
    edge.set(id, list.filter((i) => {
      const col = i % width;
      return [col > 0 ? i - 1 : -1, col < width - 1 ? i + 1 : -1, i - width, i + width].some(n => rooms[n] !== id);
    }).map(i => [x0 + (i % width), y0 + Math.floor(i / width)]));
  }
  const toPoint = (id, point) => edge.get(id).reduce((best, [x, y]) => Math.min(best, Math.hypot(x - point.x, y - point.y)), Infinity);
  const toRoom = (a, b) => edge.get(a).reduce((best, point) => Math.min(best, toPoint(b, { x: point[0], y: point[1] })), Infinity);
  const left = roomIds.filter(id => cells.get(id).length);
  const order = [];
  for (const id of preferred) {
    const n = left.indexOf(id);
    if (n >= 0) {
      order.push(...left.splice(n, 1));
    }
  }
  const pick = (distance) => {
    let best = 0;
    let bestDistance = Infinity;
    left.forEach((id, n) => {
      const d = distance(id);
      if (d < bestDistance) {
        best = n;
        bestDistance = d;
      }
    });
    order.push(...left.splice(best, 1));
  };
  if (!order.length && left.length) {
    // The room the point is in has no edge cell nearer than 0 only if the point lies on it; a point inside
    // a room is measured to the room's floor, not just its edge.
    const inside = left.find(id => cells.get(id).some(i => x0 + (i % width) === Math.round(from.x) && y0 + Math.floor(i / width) === Math.round(from.y)));
    if (inside !== undefined) {
      order.push(...left.splice(left.indexOf(inside), 1));
    } else {
      pick(id => toPoint(id, from));
    }
  }
  while (left.length) {
    const last = order[order.length - 1];
    pick(id => toRoom(last, id));
  }
  return [...order, ...roomIds.filter(id => !cells.get(id).length)];
}
