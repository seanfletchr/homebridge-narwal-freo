import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NarwalRobot } from '../lib/robot.js';
import { fieldString, fieldVarint, fieldBytes, encodeVarint } from '../lib/proto.js';

const quiet = new Proxy({}, { get: () => () => {} });

function setup() {
  const published = [];
  const robot = new NarwalRobot({ cloud: { uuid: 'u' }, deviceId: 'd', productId: 'p', log: quiet });
  robot.client = { connected: true, publish: (topic, payload, opts) => published.push({ topic, opts }) };
  return { robot, published };
}

// map/get_map/response: transport header + { 1: 1 (ok), 2: { 1: map id } }
function mapReply(mapId) {
  const header = fieldString(1, 'x');
  const body = Buffer.concat([fieldVarint(1, 1), fieldBytes(2, fieldVarint(1, mapId))]);
  return Buffer.concat([Buffer.from([1]), encodeVarint(header.length), header, body]);
}
const correlation = id => Buffer.concat([fieldString(1, id), fieldVarint(4, Date.now())]);

test('only the answer to our own map request sets the current map', async () => {
  const { robot, published } = setup();
  const seen = [];
  robot.on('currentMap', id => seen.push(id));
  const topic = `${robot.prefix}map/get_map/response`;

  // The Narwal app asked for another map: no request of ours is waiting, nothing is learned.
  robot.onMessage(topic, mapReply(3), { properties: { correlationData: correlation('the-apps-request') } });
  assert.deepEqual(seen, []);
  assert.equal(robot.currentMapId, undefined);

  // Ours is waiting; a reply for the app's request still isn't ours, ours is.
  const asking = robot.currentMap();
  const id = published[0].opts.properties.correlationData;
  robot.onMessage(topic, mapReply(3), { properties: { correlationData: correlation('the-apps-request') } });
  assert.deepEqual(seen, []);
  robot.onMessage(topic, mapReply(2), { properties: { correlationData: id } });
  assert.equal(await asking, 2);
  assert.deepEqual(seen, [2]);
  assert.equal(robot.currentMapId, 2);
});
