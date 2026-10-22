import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { NarwalCloud } from './cloud.js';
import { startControlServer } from './control.js';
import { NarwalRobot } from './robot.js';
import { SecurityHold } from './security-hold.js';
import { findSecurityProviders } from './security-providers.js';
import { FreoSensors } from './sensors.js';
import { VacationSwitch } from './vacation.js';
import { NarwalVacuum, buildModes, slotKey } from './vacuum.js';

export const PLUGIN_NAME = 'homebridge-narwal-freo';
export const PLATFORM_NAME = 'NarwalPlatform';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const FAULT_POLL = 3 * 60 * 1000;

// Per-robot settings that lived at the top level of the config before `robots` (up to 0.2.x).
const LEGACY_ROBOT_KEYS = ['serialNumber', 'defaultCleanMode', 'cleanModes', 'cleaningSensor', 'consumables',
  'replaceAtPercent'];

export class NarwalPlatform {
  /**
   * @param {import('homebridge').Logging} log
   * @param {import('homebridge').PlatformConfig} config
   * @param {import('homebridge').API} api
   */
  constructor(log, config, api) {
    this.log = log;
    this.config = config ?? {};
    this.api = api;
    this.cached = [];
    this.units = [];

    if (!this.config.email || !this.config.password) {
      log.error('Sign in to Narwal in the plugin settings.');
      return;
    }
    if (!api.isMatterEnabled?.() || !api.matter) {
      log.error('Matter is not enabled for this bridge. The Freo needs Matter to appear as a robot vacuum: '
        + 'enable Matter for this child bridge (externals only is enough) and restart.');
      return;
    }

    const dir = join(api.user.storagePath(), 'narwal');
    mkdirSync(dir, { recursive: true });
    this.storePath = join(dir, 'state.json');
    this.controlPath = join(dir, 'control.sock');
    this.store = this.load();

    this.cloud = new NarwalCloud({
      email: this.config.email,
      password: this.config.password,
      region: this.config.region ?? 'us',
      appVersion: this.config.appVersion,
      versionCode: this.config.appVersionCode,
      tokens: this.store.tokens ?? {},
      onTokens: (tokens) => {
        this.store.tokens = tokens;
        this.save();
      },
      log,
    });

    api.on('didFinishLaunching', () => {
      this.launch().catch(error => log.error(`Startup failed: ${error.message}`));
    });
    api.on('shutdown', () => {
      this.control?.close();
      this.vacation?.stop();
      for (const unit of this.units) {
        unit.stop();
      }
    });
  }

  /** Called for cached Matter accessories; we re-register the vacuums on every start. */
  configureMatterAccessory() {}

  /** @param {import('homebridge').PlatformAccessory} accessory */
  configureAccessory(accessory) {
    this.cached.push(accessory);
  }

  load() {
    let store;
    try {
      store = JSON.parse(readFileSync(this.storePath, 'utf8'));
    } catch {
      store = {};
    }
    // Up to 0.2.x one robot's state was at the top level.
    if (store.deviceId && !store.robots) {
      const { tokens, deviceId, ...robot } = store;
      store = { tokens, robots: { [deviceId]: robot } };
    }
    store.robots ??= {};
    return store;
  }

  save() {
    try {
      writeFileSync(this.storePath, JSON.stringify(this.store, null, 2), { mode: 0o600 });
      chmodSync(this.storePath, 0o600);
    } catch (error) {
      this.log.warn(`Could not save plugin state: ${error.message}`);
    }
  }

  /** The robots to publish, each with its settings. Before `robots`, the top level held one robot's. */
  robotConfigs() {
    if (Array.isArray(this.config.robots) && this.config.robots.length) {
      return this.config.robots.filter(r => r && r.enabled !== false);
    }
    const legacy = Object.fromEntries(LEGACY_ROBOT_KEYS.map(k => [k, this.config[k]]).filter(([, v]) => v !== undefined));
    return [{ ...legacy, name: this.config.name }];
  }

  /**
   * Where the security hold API is: a custom endpoint, the chosen plugin's socket, or the only installed
   * plugin that offers it. Undefined (with the reason logged) when it can't be decided: cleans are then
   * refused while the hold is on.
   */
  securityEndpoint() {
    const custom = this.config.securityEndpoint?.trim();
    if (custom) {
      return custom;
    }
    const providers = findSecurityProviders(this.api.user.storagePath());
    const chosen = this.config.securityPlugin;
    if (chosen) {
      const provider = providers.find(p => p.name === chosen);
      if (!provider) {
        this.log.error(`Security hold: ${chosen} isn't installed or doesn't offer the security hold. `
          + 'Cleans are refused until it is; pick another security system in the plugin settings or turn the hold off.');
      }
      return provider?.socket;
    }
    if (providers.length === 1) {
      this.log.info(`Security hold: using ${providers[0].displayName} (the only installed plugin offering it).`);
      return providers[0].socket;
    }
    this.log.error(providers.length
      ? `Security hold: several plugins offer it (${providers.map(p => p.displayName).join(', ')}); pick one in the plugin settings. Cleans are refused until then.`
      : 'Security hold: no installed plugin offers it. Install one, enter an endpoint in the plugin settings, or turn the hold off. Cleans are refused until then.');
    return undefined;
  }

  async launch() {
    const devices = await this.cloud.getDevices();
    if (!devices.length) {
      this.log.error('No robots found on this Narwal account.');
      return;
    }
    if (this.config.securityHold) {
      this.holdEndpoint = this.securityEndpoint();
      // Where the security plugin can stop a robot if the system is armed Away while it's out.
      this.control = startControlServer({
        path: this.controlPath,
        log: this.log,
        findUnits: name => this.units.filter(u => !name || u.name === name),
      });
    }
    const used = new Set();
    const configs = this.robotConfigs();
    this.several = configs.length > 1;
    for (const settings of configs) {
      const wanted = settings.serialNumber;
      const device = wanted
        ? devices.find(d => d.snNumber === wanted || d.deviceId === wanted)
        : devices.find(d => !used.has(d.deviceId));
      if (!device) {
        this.log.error(`No robot with serial number ${wanted} on this Narwal account.`);
        continue;
      }
      if (used.has(device.deviceId)) {
        this.log.warn(`${device.robotName} (${device.snNumber}) is listed twice in the settings; using the first.`);
        continue;
      }
      if (!wanted && !this.config.robots && devices.length > 1) {
        this.log.warn(`Several robots on this account; using ${device.robotName} (${device.snNumber}). `
          + 'Pick the robots in the plugin settings.');
      }
      used.add(device.deviceId);
      this.units.push(new RobotUnit(this, device, settings));
    }

    // HAP accessories (cleaning sensor / consumables) of robots no longer set up for them.
    const wanted = new Set(this.units.map(u => u.sensorsUuid).filter(Boolean));
    this.vacationUuid = this.api.hap.uuid.generate('narwal-vacation-switch');
    if (this.config.vacationMode) {
      wanted.add(this.vacationUuid);
    }
    const stale = this.cached.filter(a => !wanted.has(a.UUID));
    if (stale.length) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      this.cached = this.cached.filter(a => wanted.has(a.UUID));
    }
    for (const unit of this.units) {
      await unit.start();
    }
    this.startVacation();
  }

  /** Vacation mode: follow the vacation switch (another bridge's, or our own). */
  startVacation() {
    if (this.config.vacationMode) {
      // `vacationSwitch` is no longer offered in the settings; an existing value still works.
      const name = this.config.vacationSwitch?.trim() || 'Vacation Mode';
      // The first switch found is kept for good, as Home app automations get built on it: our own
      // (no searching any more), or one on another bridge (ours is never added, even while it's missing).
      if (this.cached.some(a => a.UUID === this.vacationUuid)) {
        this.useOwnSwitch(name);
        return;
      }
      this.vacation = new VacationSwitch({
        configPath: this.api.user.configPath(),
        name,
        log: this.log,
        onChange: on => this.applyVacation(on),
        bridge: this.store.vacationBridge,
        onMissing: () => this.vacationMissing(name),
        onBack: bridge => {
          if (this.vacationWarned) {
            this.vacationWarned = false;
            this.log.info(`Vacation mode: the "${name}" switch on ${bridge} is back.`);
          }
        },
        onFound: bridge => {
          this.vacationWarned = false;
          this.store.vacationBridge = bridge;
          this.save();
        },
      });
      this.vacation.start();
    } else {
      // Turned off in the settings: forget a vacation in progress, and which switch was used.
      delete this.store.vacationOn;
      delete this.store.vacationBridge;
      this.save();
      this.applyVacation(false);
    }
  }

  applyVacation(on) {
    this.units.forEach(u => u.vacuum.setVacation(on));
  }

  /** No switch found (after the start-up grace period). */
  vacationMissing(name) {
    if (!this.store.vacationBridge) {
      this.vacation.stop();
      this.useOwnSwitch(name);
    } else if (!this.vacationWarned) {
      this.vacationWarned = true;
      this.log.warn(`Vacation mode: can't reach the "${name}" switch on ${this.store.vacationBridge}; keeping the last `
        + 'state until it\'s back. To use another switch, turn vacation mode off and on in the plugin settings.');
    }
  }

  /** No vacation switch on the other bridges: publish one on this bridge (HAP side). */
  useOwnSwitch(name) {
    if (this.ownSwitch) {
      return;
    }
    const { api } = this;
    const { Service, Characteristic } = api.hap;
    let accessory = this.cached.find(a => a.UUID === this.vacationUuid);
    if (!accessory) {
      accessory = new api.platformAccessory(name, this.vacationUuid);
      api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.cached.push(accessory);
      this.log.info(`Vacation mode: no "${name}" switch on the other bridges, so this plugin added its own to this `
        + 'bridge. If the bridge isn\'t in the Home app yet, pair it (Homebridge UI > Bridges shows its setup code).');
    }
    this.ownSwitch = accessory;
    accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'homebridge-narwal-freo')
      .setCharacteristic(Characteristic.Model, 'Vacation Mode')
      .setCharacteristic(Characteristic.SerialNumber, 'vacation-mode')
      .setCharacteristic(Characteristic.FirmwareRevision, VERSION);
    const service = accessory.getService(Service.Switch) ?? accessory.addService(Service.Switch, name);
    service.getCharacteristic(Characteristic.On)
      .onGet(() => Boolean(this.store.vacationOn))
      .onSet(value => {
        this.store.vacationOn = Boolean(value);
        this.save();
        this.applyVacation(Boolean(value));
      });
    service.updateCharacteristic(Characteristic.On, Boolean(this.store.vacationOn));
    this.applyVacation(Boolean(this.store.vacationOn));
  }

}

/**
 * Bring a robot's saved state up to date. Up to 0.5.x it held only the main map's rooms (`rooms`,
 * `mapId`) and plans (`plans`); now every map is kept (`maps`, `mainMapId`) and the plans per map
 * (`plansByMap`).
 */
export function migrateStore(store) {
  if (!store.maps && store.rooms?.length) {
    const id = store.mapId ?? 1;
    store.maps = [{ id, name: '', hasDock: true, main: true, start: { x: 0, y: 0 }, rooms: store.rooms }];
    store.mainMapId = id;
  }
  if (store.plans) {
    store.plansByMap ??= {};
    store.plansByMap[store.mainMapId ?? store.mapId ?? 1] ??= store.plans;
  }
  delete store.rooms;
  delete store.mapId;
  delete store.plans;
}

/** A logger that puts the robot's name in front, for homes with several robots. */
function prefixed(log, name) {
  const wrap = level => (message, ...rest) => log[level](`${name}: ${message}`, ...rest);
  return { info: wrap('info'), warn: wrap('warn'), error: wrap('error'), debug: wrap('debug'), success: wrap('success') };
}

/** One robot: its cloud connection, Matter vacuum and optional HAP sensors. */
class RobotUnit {
  constructor(platform, device, settings) {
    this.platform = platform;
    this.api = platform.api;
    this.device = device;
    this.settings = settings;
    this.name = settings.name || device.robotName || 'Freo';
    this.log = platform.several ? prefixed(platform.log, this.name) : platform.log;
    this.store = platform.store.robots[device.deviceId] ??= {};
    migrateStore(this.store);
    if (this.store.cleanMode === undefined) {
      const modes = buildModes();
      const key = slotKey(settings.defaultCleanMode ?? 'both');
      this.store.cleanMode = (modes.find(m => m.key === key) ?? modes.find(m => m.key === 'both')).mode;
    }
    platform.save();

    this.robot = new NarwalRobot({ cloud: platform.cloud, deviceId: device.deviceId, productId: device.productId, log: this.log });
    this.vacuum = new NarwalVacuum({
      api: this.api,
      log: this.log,
      robot: this.robot,
      device,
      name: this.name,
      store: this.store,
      save: () => platform.save(),
      security: platform.config.securityHold
        ? new SecurityHold({ endpoint: platform.holdEndpoint, by: this.name, halt: platform.controlPath })
        : undefined,
      securityStoppedMinutes: platform.config.securityStoppedMinutes ?? 10,
      cleanModes: settings.cleanModes,
      mapSettings: settings.maps,
      vacationCleans: Math.min(5, Math.max(0, Math.round(Number(platform.config.vacationCleans ?? 1)) || 0)),
      vacationAfter: platform.config.vacationAfter === 'vacuum' ? 'vacuum' : 'none',
    });
    this.setupSensors();
  }

  /** The optional HAP accessory: Cleaning occupancy sensor and consumables. */
  setupSensors() {
    const cleaning = Boolean(this.settings.cleaningSensor);
    const consumables = Boolean(this.settings.consumables);
    if (!cleaning && !consumables) {
      return;
    }
    const { api } = this;
    this.sensorsUuid = api.hap.uuid.generate(`narwal-sensors-${this.device.deviceId}`);
    let accessory = this.platform.cached.find(a => a.UUID === this.sensorsUuid);
    if (!accessory) {
      accessory = new api.platformAccessory(`${this.name} ${cleaning ? 'Cleaning' : 'Maintenance'}`, this.sensorsUuid);
      api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }
    this.sensors = new FreoSensors({
      api,
      log: this.log,
      accessory,
      device: this.device,
      cloud: this.platform.cloud,
      robot: this.robot,
      cleaning,
      consumables,
      replaceAt: Math.min(100, Math.max(0, Number(this.settings.replaceAtPercent ?? 10))),
      version: VERSION,
    });
    if (cleaning) {
      this.vacuum.onJob = active => this.sensors.follow(active);
    }
  }

  async start() {
    const { device, store } = this;
    this.log.info(`Found ${device.robotName ?? 'robot'} ${device.snNumber ?? ''} (firmware ${device.firmwareVersion ?? '?'})`
      + (this.name !== device.robotName ? `, shown as ${this.name}` : ''));
    this.robot.on('status', s => this.vacuum.applyStatus(s));
    this.robot.on('working', w => this.vacuum.applyWorking(w));
    this.robot.on('pose', p => this.vacuum.applyPose(p));
    this.robot.on('currentMap', id => this.vacuum.applyCurrentMap(id));
    this.robot.on('connected', () => this.vacuum.restoreAutoMainMap());
    this.robot.on('report', r => this.vacuum.applyCleanReport(r));
    this.robot.on('plans', ({ mapId, plans }) => {
      (store.plansByMap ??= {})[mapId] = plans;
      this.platform.save();
      this.log.debug(`${this.name}: cleaning plans of map ${mapId} updated for modes ${Object.keys(plans).join(', ')}`);
    });
    this.robot.on('maps', maps => this.onMaps(maps));
    this.robot.start();
    this.sensors?.start();

    if (store.maps?.length) {
      await this.register();
    } else {
      this.log.info(`Waiting for ${this.name}'s room list from the robot; the vacuum appears in Homebridge `
        + 'once it arrives. If it takes more than a few minutes, check that the robot is online and has a saved map with its base station.');
    }
    this.faultTimer = setInterval(() => this.pollFault(), FAULT_POLL);
  }

  stop() {
    clearInterval(this.faultTimer);
    this.sensors?.stop();
    this.vacuum.stop();
    this.robot.stop();
  }

  async onMaps({ maps, mainId }) {
    const saved = maps.map(({ id, name, hasDock, main, start, rooms }) => ({ id, name, hasDock, main, start, rooms }));
    const before = JSON.stringify([this.store.maps ?? [], this.store.mainMapId]);
    this.store.maps = saved;
    this.store.mainMapId = mainId;
    this.platform.save();
    if (JSON.stringify([saved, mainId]) === before) {
      return;
    }
    this.vacuum.refreshFloors();
    const floors = this.vacuum.floors;
    for (const floor of floors) {
      this.log.info(`${this.name} ${floors.length > 1 ? `${floor.name}${floor.hasDock ? '' : ' (no base station)'} ` : ''}rooms: `
        + floor.rooms.map(r => r.name).join(', '));
    }
    if (this.registered) {
      await this.vacuum.applyRooms();
    } else {
      await this.register();
    }
  }

  async register() {
    if (this.registered || this.registering) {
      return;
    }
    this.registering = true;
    try {
      await this.api.matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [this.vacuum.accessory()]);
      // registerPlatformAccessories resolves even when publishing failed; check the endpoint exists.
      const state = await this.api.matter.getAccessoryState(this.vacuum.uuid, 'rvcOperationalState');
      if (!state) {
        this.log.error(`Homebridge could not publish ${this.name} as a Matter vacuum; see the Matter errors above.`);
        return;
      }
      this.registered = true;
      this.vacuum.setReady();
      this.log.info(`${this.name} is published as a Matter robot vacuum. If it isn't in the Home app yet, `
        + 'add it with the pairing code shown above (Home app > + > Add Accessory).');
    } catch (error) {
      this.log.error(`Could not publish ${this.name} as a Matter vacuum: ${error.message}`);
    } finally {
      this.registering = false;
    }
  }

  async pollFault() {
    try {
      const work = await this.platform.cloud.getWorkStatus(this.device.deviceId, this.device.productId);
      await this.vacuum.applyFault(work);
    } catch (error) {
      this.log.debug(`${this.name}: work status poll failed: ${error.message}`);
    }
  }
}
