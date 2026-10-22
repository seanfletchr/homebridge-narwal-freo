// One long-lived MQTT session to Narwal's broker for a single robot.
//
// Events: 'status' (parseBaseStatus result), 'working' (parseWorkingStatus),
// 'report' (parseCleanReport result), 'maps' ({ maps, mainId }: every saved map with its rooms),
// 'plans' ({ mapId, plans: { mode: { roomId: hex } } }: the cleaning plans of one map), 'pose', 'connected', 'disconnected'.

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

import mqtt from 'mqtt';

import { NarwalAuthError } from './cloud.js';
import {
  BROADCAST_TOPICS, EXTRA_SUBSCRIPTIONS, correlationId, easyCleanBody, forceEndBody, parseBaseStatus, parseCleanReport,
  parseCommandResult, parseCurrentMapId, parseDisplayMap, parseMapShape, parsePlansResponse, mergeRoomInfo, parseMapReplyRooms, parseReducedMaps, parseStairless, parseAutoMainMap, autoMainMapBody, parseWorkingStatus,
  pickMainMap, requestProperties, resetConsumableBody, stairlessBody, switchMapBody, taskPayload, wakeRequests, zoneCleanBody,
} from './protocol.js';
import { fieldVarint } from './proto.js';

const WAKE_INTERVAL = 5 * 60 * 1000; // the robot keeps publishing for 600 s per wake
const STALE_AFTER = 3 * 60 * 1000;
const MAP_RETRY = 2 * 60 * 1000;
const MAP_REFRESH = 6 * 60 * 60 * 1000;
const ACK_TIMEOUT = 5000;
const MAP_REQUEST = Buffer.from([0x08, 0x00, 0x10, 0x00]); // get_map: the current map

export class NarwalRobot extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('./cloud.js').NarwalCloud} opts.cloud
   * @param {string} opts.deviceId
   * @param {string} opts.productId
   * @param {import('homebridge').Logging} opts.log
   */
  constructor({ cloud, deviceId, productId, log }) {
    super();
    this.cloud = cloud;
    this.deviceId = deviceId;
    this.productId = productId;
    this.log = log;
    this.prefix = `/${productId}/${deviceId}/`;
    this.client = undefined;
    this.timers = [];
    this.reconnectDelay = 5000;
    this.lastStatusAt = 0;
    this.haveRooms = false;
    this.maps = [];
    this.listedMaps = [];
    this.roomInfo = new Map();
    this.mainMapId = undefined;
    this.currentMapId = undefined;
    this.noMainWarned = false;
    this.pending = new Map(); // command topic suffix -> [{ id, name, timer }] waiting for a reply
    this.stopped = false;
  }

  start() {
    this.stopped = false;
    this.connect();
    this.timers.push(setInterval(() => this.keepAwake(), WAKE_INTERVAL));
    this.timers.push(setInterval(() => this.checkStale(), 60 * 1000));
  }

  stop() {
    this.stopped = true;
    this.timers.forEach(t => clearInterval(t));
    clearTimeout(this.mapTimer);
    clearTimeout(this.reconnectTimer);
    this.clearPending();
    this.client?.end(true);
    this.client = undefined;
  }

  get connected() {
    return Boolean(this.client?.connected);
  }

  async connect() {
    if (this.stopped) {
      return;
    }
    let token;
    let brokerUrl;
    try {
      token = await this.cloud.ensureToken();
      brokerUrl = await this.cloud.getBrokerUrl();
    } catch (error) {
      this.log.warn(`Cannot reach Narwal cloud: ${error.message}`);
      this.scheduleReconnect();
      return;
    }
    const uuid = this.cloud.uuid;
    const client = mqtt.connect(brokerUrl, {
      protocolVersion: 5,
      clientId: `app_${uuid}_${randomUUID()}`,
      username: uuid,
      password: token,
      keepalive: 30,
      clean: true,
      reconnectPeriod: 0, // we reconnect ourselves so each attempt gets a fresh token
      connectTimeout: 15000,
      resubscribe: false,
    });
    this.client = client;

    client.on('connect', () => {
      this.reconnectDelay = 5000;
      this.log.info('Connected to Narwal MQTT broker');
      const topics = [...BROADCAST_TOPICS, ...EXTRA_SUBSCRIPTIONS].map(t => this.prefix + t);
      client.subscribe(topics, { qos: 0 }, (error) => {
        if (error) {
          this.log.warn(`MQTT subscribe failed: ${error.message}`);
          return;
        }
        this.wake();
        this.scheduleMapRequest(3000);
        this.emit('connected');
      });
    });
    client.on('message', (topic, payload, packet) => this.onMessage(topic, payload, packet));
    client.on('error', (error) => {
      // CONNACK 134/135 = bad credentials / not authorized: renew before the next attempt
      if (error?.code === 134 || error?.code === 135 || error instanceof NarwalAuthError) {
        this.log.warn('Narwal broker rejected the session; renewing sign-in');
        this.cloud.renew().catch(e => this.log.warn(`Narwal sign-in failed: ${e.message}`));
      } else {
        this.log.debug(`MQTT error: ${error?.message ?? error}`);
      }
    });
    client.on('close', () => {
      if (this.client !== client) {
        return;
      }
      this.client = undefined;
      this.clearPending();
      this.emit('disconnected');
      if (!this.stopped) {
        this.log.warn(`Narwal MQTT connection closed; reconnecting in ${Math.round(this.reconnectDelay / 1000)} s`);
        this.scheduleReconnect();
      }
    });
  }

  scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 5 * 60 * 1000);
  }

  checkStale() {
    if (this.connected && Date.now() - this.lastStatusAt > STALE_AFTER) {
      this.log.debug('No robot status recently; waking it again');
      this.wake();
    }
  }

  /**
   * Publish like the Narwal app does: a request that wants a reply carries MQTT 5 Response Topic and
   * Correlation Data (the Freo ignores it otherwise), with the same request id in the payload header.
   * Returns the request id.
   */
  publish(suffix, body = Buffer.alloc(0), wantsResponse = true) {
    if (!this.client?.connected) {
      throw new Error('Not connected to the Narwal cloud');
    }
    const topic = this.prefix + suffix;
    const responseTopic = suffix === 'common/notify_app_event'
      ? this.prefix + 'general/service/response'
      : (wantsResponse ? `${topic}/response` : '');
    const id = randomUUID();
    const properties = responseTopic ? requestProperties(responseTopic, id) : undefined;
    this.client.publish(topic, taskPayload(this.cloud.uuid, responseTopic, body, id), { qos: 0, properties });
    return id;
  }

  /**
   * Publish a request and wait for the robot's reply (it answers within about a second). Resolves with
   * { ok, result, payload } (`ok`: the reply's result code is 1) and never rejects once published: a
   * refusal or 5 s of silence resolves with ok false (`timedOut`; a lost connection too) and is logged as a
   * warning, unless `quiet`. Throws if not connected.
   */
  ask(suffix, name, body = Buffer.alloc(0), { quiet = false } = {}) {
    const id = this.publish(suffix, body);
    return new Promise((resolve) => {
      const entry = { id, name, quiet, resolve };
      entry.timer = setTimeout(() => {
        this.settle(suffix, entry);
        this.log[quiet ? 'debug' : 'warn'](`The Freo did not answer ${name} within ${ACK_TIMEOUT / 1000} s`);
        resolve({ ok: false, timedOut: true });
      }, ACK_TIMEOUT);
      this.pending.set(suffix, [...(this.pending.get(suffix) ?? []), entry]);
    });
  }

  /** A command whose effect shows in the robot's status; the reply is only checked and logged. */
  command(suffix, name, body = Buffer.alloc(0)) {
    return this.ask(suffix, name, body);
  }

  settle(suffix, entry) {
    clearTimeout(entry.timer);
    const left = (this.pending.get(suffix) ?? []).filter(e => e !== entry);
    if (left.length) {
      this.pending.set(suffix, left);
    } else {
      this.pending.delete(suffix);
    }
  }

  clearPending() {
    const entries = [...this.pending.values()].flat();
    this.pending.clear();
    for (const entry of entries) {
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, timedOut: true });
    }
  }

  /**
   * A reply on a request's response topic. The topic is shared with the Narwal app, so a reply whose
   * correlation data names another request is not ours; one without correlation data goes to our oldest
   * waiting request on that topic. Returns whether it was ours.
   */
  onCommandReply(suffix, payload, packet) {
    const list = this.pending.get(suffix);
    if (!list?.length) {
      return false;
    }
    const id = packet?.properties?.correlationData ? correlationId(packet.properties.correlationData) : undefined;
    const entry = id ? list.find(e => e.id === id) : list[0];
    if (!entry) {
      return false;
    }
    this.settle(suffix, entry);
    let result;
    try {
      result = parseCommandResult(payload);
    } catch (error) {
      this.log.debug(`Could not read the reply to ${entry.name}: ${error.message}`);
      entry.resolve({ ok: false, payload });
      return true;
    }
    if (result === 1) {
      this.log.debug(`The Freo accepted ${entry.name}`);
    } else {
      this.log[entry.quiet ? 'debug' : 'warn'](`The Freo did not accept ${entry.name} (reply ${result ?? 'empty'})`);
    }
    entry.resolve({ ok: result === 1, result, payload });
    return true;
  }

  /** Same as opening the Narwal app: the robot publishes status for the next 10 minutes. */
  wake() {
    try {
      for (const [suffix, body, wantsResponse] of wakeRequests()) {
        this.publish(suffix, body, wantsResponse);
      }
    } catch (error) {
      this.log.debug(`Wake skipped: ${error.message}`);
    }
  }

  keepAwake() {
    try {
      this.publish('common/active_robot_publish', fieldVarint(1, 600), false);
      this.publish('status/app_status_heartbeat', fieldVarint(1, 1), false);
    } catch {
      // reconnect logic handles it
    }
  }

  /**
   * Ask for the saved maps (rooms) and which map is current. The cleaning plans of the current map
   * follow: the plans reply doesn't say which map it belongs to.
   */
  requestMap() {
    this.plansDue = true;
    try {
      this.publish('map/get_all_reduced_maps');
      this.publish('map/get_map', MAP_REQUEST);
    } catch (error) {
      this.log.debug(`Map request skipped: ${error.message}`);
    }
  }

  /** The id of the robot's current map right now (undefined if it doesn't say). */
  async currentMap(quiet = true) {
    const reply = await this.ask('map/get_map', 'the current map', MAP_REQUEST, { quiet });
    try {
      return reply.ok ? parseCurrentMapId(reply.payload) : undefined;
    } catch {
      return undefined;
    }
  }

  /** The room shapes of the robot's current map (see parseMapShape); undefined if the robot doesn't send them. */
  async mapShape() {
    const reply = await this.ask('map/get_map', 'the map', MAP_REQUEST, { quiet: true });
    try {
      return reply.ok ? parseMapShape(reply.payload) : undefined;
    } catch (error) {
      this.log.debug(`Could not read the map: ${error.message}`);
      return undefined;
    }
  }

  /**
   * Fetch the cleaning plans of the current map. The reply carries no map id, so the current map is
   * confirmed before and after; a plan set that might belong to another map is dropped.
   */
  fetchPlans() {
    // One at a time: a second caller (a start waiting for them) joins the request in flight.
    this.plansRequest ??= this.requestPlans().finally(() => {
      this.plansRequest = undefined;
    });
    return this.plansRequest;
  }

  async requestPlans() {
    this.plansDue = false;
    try {
      const before = await this.currentMap();
      if (before === undefined) {
        return;
      }
      const reply = await this.ask('clean/plan/get', 'the cleaning plans', Buffer.alloc(0), { quiet: true });
      if (!reply.ok) {
        return;
      }
      const plans = parsePlansResponse(reply.payload);
      if (await this.currentMap() !== before) {
        this.log.debug('Ignoring cleaning plans: the current map changed while asking');
        return;
      }
      this.emit('plans', { mapId: before, plans });
    } catch (error) {
      this.log.debug(`Plans request skipped: ${error.message}`);
    }
  }

  /** Make `mapId` the robot's current map, and check the robot says so. Throws a short reason if it doesn't. */
  async switchMap(mapId) {
    const reply = await this.ask('map/switch_map', 'the floor change', switchMapBody(mapId));
    if (!reply.ok) {
      throw new Error(reply.timedOut ? 'The robot did not answer the floor change' : 'The robot refused the floor change');
    }
    const now = await this.currentMap(false);
    if (now !== mapId) {
      throw new Error(now === undefined ? 'Could not confirm the floor change' : `The robot is on map ${now}, not ${mapId}`);
    }
    this.log.debug(`Current map on the robot: ${mapId}`);
  }

  /** Whether the robot is in "stairless mode" (stair detection off); undefined if it can't be read. */
  async stairless(quiet = false) {
    const reply = await this.ask('config/get', 'the settings', Buffer.alloc(0), { quiet });
    try {
      return reply.ok ? parseStairless(reply.payload) : undefined;
    } catch {
      return undefined;
    }
  }

  /** Whether the Narwal app's "switch to the main map after cleaning" setting is on; undefined if it can't be read. */
  async autoMainMap(quiet = false) {
    const reply = await this.ask('config/get', 'the settings', Buffer.alloc(0), { quiet });
    try {
      return reply.ok ? parseAutoMainMap(reply.payload) : undefined;
    } catch {
      return undefined;
    }
  }

  async setAutoMainMap(on) {
    return (await this.ask('config/set', 'the main map setting', autoMainMapBody(on))).ok;
  }

  /** Turn stairless mode (stair detection off) on or off; whether the robot accepted it. */
  async setStairless(on) {
    return (await this.ask('config/set', 'the stair detection setting', stairlessBody(on))).ok;
  }

  scheduleMapRequest(delay) {
    clearTimeout(this.mapTimer);
    this.mapTimer = setTimeout(() => {
      this.requestMap();
      this.scheduleMapRequest(this.haveRooms ? MAP_REFRESH : MAP_RETRY);
    }, delay);
  }

  /**
   * The robot's current map, with each room's type and name. The saved-map list lacks them, so what we
   * learn here is kept (per map) and applied to every list that follows.
   */
  onMapRooms(info) {
    if (!info || info.id === undefined || !info.rooms.length) {
      return;
    }
    this.roomInfo.set(info.id, info.rooms);
    if (this.listedMaps.length) {
      this.onReducedMaps(this.listedMaps);
    }
  }

  onReducedMaps(listed) {
    this.listedMaps = listed;
    const maps = mergeRoomInfo(listed, this.roomInfo);
    this.maps = maps;
    const main = pickMainMap(maps);
    if (!main) {
      if (!this.noMainWarned) {
        this.noMainWarned = true;
        this.log.warn('The Freo has no saved map with a base station, so there are no rooms to publish.');
      }
      return;
    }
    this.noMainWarned = false;
    this.mainMapId = main.id;
    this.log.debug(`Maps on the robot: ${maps.map(m => `${m.id}${m.name ? ` "${m.name}"` : ''}${m.id === main.id ? ' (main)' : ''}${m.hasDock ? '' : ' (no base)'}`).join(', ')}`);
    if (main.rooms.length) {
      this.haveRooms = true;
      this.emit('maps', { maps, mainId: main.id });
    }
    this.maybeRequestPlans();
  }

  onCurrentMap(mapId) {
    if (mapId !== undefined) {
      this.emit('currentMap', mapId);
    }
    if (mapId === undefined || mapId === this.currentMapId) {
      return;
    }
    const changed = this.currentMapId !== undefined;
    this.currentMapId = mapId;
    this.currentMapSince = Date.now();
    this.log.debug(`Current map on the robot: ${mapId}`);
    if (changed) {
      // The map changed (carried upstairs, switched in the Narwal app, or by us): refresh the list and the plans.
      this.requestMap();
    }
    this.maybeRequestPlans();
  }

  maybeRequestPlans() {
    if (this.plansDue && this.currentMapId !== undefined && this.maps.length) {
      this.fetchPlans();
    }
  }

  onMessage(topic, payload, packet) {
    if (!topic.startsWith(this.prefix)) {
      return;
    }
    const suffix = topic.slice(this.prefix.length);
    try {
      // A reply to something we asked for resolves that request (the state-keeping below also sees it).
      if (suffix.endsWith('/response')) {
        this.onCommandReply(suffix.slice(0, -'/response'.length), payload, packet);
      }
      switch (suffix) {
        case 'status/robot_base_status':
          this.lastStatusAt = Date.now();
          this.emit('status', parseBaseStatus(payload));
          break;
        case 'status/working_status':
          this.emit('working', parseWorkingStatus(payload));
          break;
        case 'map/display_map': {
          const pose = parseDisplayMap(payload);
          if (pose) {
            this.emit('pose', pose);
          }
          break;
        }
        case 'report/clean_report':
          this.emit('report', parseCleanReport(payload));
          break;
        case 'map/get_all_reduced_maps/response':
          this.onReducedMaps(parseReducedMaps(payload));
          break;
        case 'map/get_map/response':
          // Replies go to every client, the Narwal app's included: they all carry the map that is current.
          this.onMapRooms(parseMapReplyRooms(payload));
          this.onCurrentMap(parseCurrentMapId(payload));
          break;
        default:
          break;
      }
    } catch (error) {
      this.log.debug(`Could not parse ${suffix}: ${error.message}`);
    }
  }

  // ── Commands (the reply is only checked and logged; watch 'status' for the effect) ──

  startClean(roomIds, mode, templates, settings) {
    return this.command('clean/easy_clean/start', 'the clean', easyCleanBody(roomIds, mode, templates, settings));
  }

  /** Clean zones (outlines of cells, see zoneCleanBody): the only thing a map without a base station offers. */
  startZones(zones, mode, templates, settings) {
    return this.command('clean/easy_clean/start', 'the clean', zoneCleanBody(zones, mode, templates, settings));
  }

  pause() {
    return this.command('task/pause', 'pause');
  }

  resume() {
    return this.command('task/resume', 'resume');
  }

  returnToDock() {
    return this.command('supply/recall', 'return to dock');
  }

  stopTask() {
    return this.command('task/force_end', 'stop', forceEndBody());
  }

  /** "Locate robot" in the Narwal app: the robot plays a sound. */
  locate() {
    return this.command('common/yell', 'locate');
  }

  /** Reset a consumable's usage counter after replacing it. */
  resetConsumable(type) {
    return this.command('consumable/reset_consumable_info', 'the consumable reset', resetConsumableBody(type));
  }
}
