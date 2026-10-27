// The Freo as a Matter RoboticVacuumCleaner (Apple Home shows it as a native vacuum).

import { lookupError } from './errors.js';
import { allAreas, buildFloors } from './floors.js';
import { MAP_UNIT, NarwalMode, Suction, Water, WorkState, inJob, onDock } from './protocol.js';
import { nearestFirst, roomOutlines, spotOutline } from './shapes.js';

// Matter enum values (matter.js RvcOperationalState / RvcRunMode / RvcCleanMode).
const Op = { Stopped: 0, Running: 1, Paused: 2, Error: 3, SeekingCharger: 64, Charging: 65, Docked: 66, CleaningMop: 68 };
const RunTag = { Idle: 16384, Cleaning: 16385 };
const CleanTag = { Auto: 0, Quick: 1, DeepClean: 16384, Vacuum: 16385, Mop: 16386 };
// UnableToStartOrResume: a start (or resume) the plugin refused or couldn't set up; UnableToCompleteOperation:
// a clean the plugin had to pause (stair detection), or a robot that stopped answering on its base or never
// answered; FailedToFindChargingDock: Return to dock on a floor with no base, or a return to the base that takes
// far too long; LowBattery: a robot that stopped answering away from its base (its battery ran flat).
// Only standard Matter errors: the Home app shows its own text for each and ignores the details.
const ErrorState = { NoError: 0, UnableToStartOrResume: 1, UnableToCompleteOperation: 2, FailedToFindChargingDock: 64, LowBattery: 72 };
const ChargeState = { Unknown: 0, IsCharging: 1, IsAtFullCharge: 2, IsNotCharging: 3 };

// How long after a start the robot may take to report the job before the security hold is released.
const START_TIMEOUT = 2 * 60 * 1000;

// Security hold stop detection: the robot counts as stopped while its position stays within this many
// metres and its heading within this many radians (neither drifts when still; it can turn on the
// spot for several seconds before driving off), and only while positions keep arriving (~1.5 s apart).
const STILL_TOLERANCE = 0.3;
const TURN_TOLERANCE = 0.5;
const POSE_GAP = 15 * 1000;
// After pausing for the security plugin: time to coast to a stop, and to check the pause landed.
const HALT_SETTLE = 10 * 1000;
const HALT_CHECK = 8 * 1000;
// Sent home because the security system is arming Away: be in the base this long before the motion
// sensors arm, or pause where it is. The deadline is what keeps it safe; the estimate only skips trips
// that can't possibly make it: start-up and docking time plus the straight line to the base (about
// (0, 0) on the map) at full speed. Measured 2026-10-16: ~6 s turning before it sets off, 0.25 m/s
// driving, ~10 s backing into the base; routes around furniture can be several times the straight line.
const HOME_MARGIN = 10 * 1000;
const HOME_OVERHEAD = 16 * 1000;
const RETURN_SPEED = 0.25;
// Return to dock on a floor without a base (see tripToStart): after ending the clean the robot has this long
// to leave the job state, and after the small zone is sent this long to show it as a job.
// A robot position this recent says where the robot is when ordering rooms to clean.
const POSE_FRESH = 10 * 60 * 1000;
const TRIP_LEAVE_WAIT = 15 * 1000;
const TRIP_START_WAIT = 60 * 1000;
const TRIP_IDLE_WAIT = 60 * 1000; // a trip's job gone and the robot idle off the base this long: the trip is over
const TRIP_MAX_ENDING = 90 * 1000; // ending the clean and the checks before the zone is sent
const TRIP_WATCH = 5 * 1000;

const RUN_IDLE = 0;
const RUN_CLEANING = 1;

// While a job runs on a floor that needs stair detection, the robot's setting is checked this often.
const STAIR_CHECK = 60 * 1000;
// Retry after failing to turn stair detection back on.
const STAIR_RESTORE_RETRY = 60 * 1000;
// While a job runs, ask which map is current this often: the robot may put itself on another floor's map.
const MAP_CHECK = 5 * 1000;
// A plugin-started job's floor is only trusted if the job shows up this soon after the start command.
const GUARD_MAX_AGE = 2 * 60 * 1000;
// Rooms in turn (see startQueue): after a zone's job ends the robot has this long to send its end report
// (and, once it has, to leave the job state), and after a start this long to show the new job.
const REPORT_WAIT = 30 * 1000;
const LEAVE_JOB_WAIT = 15 * 1000;
const ZONE_START_WAIT = 60 * 1000;
// A report older than this before the zone was sent belongs to an earlier job (robot and Pi clocks may differ a little).
const REPORT_SKEW = 30 * 1000;
// No answer about the current map for this long during a guarded job is worth a warning.
const MAP_SILENT = 30 * 1000;
const NOTICE_SHOWN = 60 * 1000; // a plugin-made error stays on the tile this long (the Home app hides the controls during an error)
const MAP_SWITCH_SLACK = 10 * 1000; // a map change this close before a job's end still counts as the robot's switch at the end

// Matter Common Area namespace tags (areaType), so Siri can match "vacuum the kitchen".
const AREA_TAGS = {
  balcony: 4, bathroom: 6, bedroom: 7, cloakroom: 13, closet: 14, corridor: 16, den: 20, dining: 21,
  diningroom: 21, entrance: 27, entryway: 28, entry: 28, familyroom: 29, foyer: 30, garage: 34,
  guestbedroom: 39, guestroom: 41, gym: 42, hallway: 43, hall: 43, kidsroom: 45, kitchen: 47,
  laundryroom: 49, laundry: 49, library: 51, livingroom: 52, lounge: 53, mudroom: 55, nursery: 57,
  office: 58, pantry: 61, playroom: 65, primarybathroom: 68, primarybedroom: 69, masterbedroom: 69,
  mainbedroom: 69, secondarybedroom: 7, entertainmentroom: 72, recreationroom: 72, staircase: 84, stairs: 84, storageroom: 86, studio: 87,
  study: 88, sunroom: 89, utilityroom: 92, toilet: 95,
};
// Narwal room type -> area tag, for rooms whose name doesn't match a tag.
const TYPE_TAGS = { 1: 69, 2: 7, 3: 52, 4: 47, 5: 6, 6: 95, 7: 4, 8: 21, 9: 14, 10: 43, 11: 88, 12: 45, 13: 72, 14: 86 };

// The tag for a room: by the name shown in the Home app, else Narwal's name for it, else its room type.
function areaType(room) {
  const tag = name => AREA_TAGS[name.toLowerCase().replace(/[^a-z]/g, '')];
  return tag(room.name) ?? tag(room.narwalName ?? '') ?? TYPE_TAGS[room.type] ?? null;
}

/**
 * Home app clean-mode slots. Apple Home lists the modes in three groups by their Vacuum / Mop tags,
 * names each group after its first mode's label, and shows the others in its "…" menu by their
 * intensity tag (Automatic, Quick, Deep Clean); tapping a group picks its Automatic mode. What each
 * slot does is set in the plugin settings (`cleanModes`); `mode` numbers stay put (see RETIRED_MODES).
 */
const SLOTS = [
  { mode: 1, key: 'vacuum', group: 'vacuum', tags: [CleanTag.Vacuum, CleanTag.Auto] },
  { mode: 5, key: 'vacuumQuick', group: 'vacuum', tags: [CleanTag.Vacuum, CleanTag.Quick] },
  { mode: 6, key: 'vacuumDeep', group: 'vacuum', tags: [CleanTag.Vacuum, CleanTag.DeepClean] },
  { mode: 2, key: 'mop', group: 'mop', tags: [CleanTag.Mop, CleanTag.Auto] },
  { mode: 7, key: 'mopQuick', group: 'mop', tags: [CleanTag.Mop, CleanTag.Quick] },
  { mode: 8, key: 'mopDeep', group: 'mop', tags: [CleanTag.Mop, CleanTag.DeepClean] },
  { mode: 0, key: 'both', group: 'both', tags: [CleanTag.Vacuum, CleanTag.Mop, CleanTag.Auto] },
  { mode: 9, key: 'bothQuick', group: 'both', tags: [CleanTag.Vacuum, CleanTag.Mop, CleanTag.Quick] },
  { mode: 3, key: 'bothDeep', group: 'both', tags: [CleanTag.Vacuum, CleanTag.Mop, CleanTag.DeepClean] },
];

/** Slot defaults; "app" means the room settings saved in the Narwal app. */
export const DEFAULT_CLEAN_MODES = {
  vacuum: { passes: 'app', suction: 'app' },
  vacuumQuick: { passes: '1', suction: 'app' },
  vacuumDeep: { passes: '2', suction: 'app' },
  mop: { passes: 'app', water: 'app' },
  mopQuick: { passes: '1', water: 'app' },
  mopDeep: { passes: '2', water: 'app' },
  both: { task: 'vacuum_and_mop', passes: 'app', suction: 'app', water: 'app' },
  bothQuick: { task: 'vacuum_and_mop', passes: '1', suction: 'app', water: 'app' },
  bothDeep: { task: 'vacuum_then_mop', passes: '2', suction: 'app', water: 'app' },
};

// Earlier `defaultCleanMode` values (named after what the slot did up to 0.2.0) -> slot keys.
const LEGACY_KEYS = {
  vacuum_quick: 'vacuumQuick', vacuum_deep: 'vacuumDeep', mop_quick: 'mopQuick', mop_deep: 'mopDeep',
  vacuum_then_mop: 'both', vacuum_mop: 'both', vacuum_then_mop_quick: 'bothQuick',
  vacuum_then_mop_deep: 'bothDeep',
};

export function slotKey(key) {
  return LEGACY_KEYS[key] ?? key;
}

const TASKS = {
  vacuum_and_mop: { narwal: NarwalMode.VACUUM_AND_MOP, label: 'Vacuum and Mop' },
  vacuum_then_mop: { narwal: NarwalMode.VACUUM_THEN_MOP, label: 'Vacuum then Mop' },
  freo_mind: { narwal: NarwalMode.FREO_MIND, label: 'Freo Mind' },
};
const SUCTION_LABELS = { quiet: 'quiet', standard: 'standard suction', strong: 'strong suction' };
const WATER_LABELS = { dry: 'slightly dry', standard: 'standard water', wet: 'slightly wet' };

// How the Home app shows each slot, to tell apart slots that are set up the same.
const SLOT_NAMES = {
  vacuum: 'Automatic', vacuumQuick: 'Quick', vacuumDeep: 'Deep Clean', mop: 'Automatic', mopQuick: 'Quick',
  mopDeep: 'Deep Clean', both: 'Automatic', bothQuick: 'Quick', bothDeep: 'Deep Clean',
};

/**
 * The clean modes offered to the Home app, from the `cleanModes` setting. Matter requires unique
 * labels (matter.js won't publish the vacuum otherwise), so slots set up the same get their slot name.
 */
export function buildModes(config = {}) {
  const modes = buildSlots(config);
  const count = label => modes.filter(m => m.label === label).length;
  const duplicates = new Set(modes.map(m => m.label).filter(label => count(label) > 1));
  for (const mode of modes) {
    if (duplicates.has(mode.label)) {
      mode.label = `${mode.label} (${SLOT_NAMES[mode.key]})`;
    }
  }
  return modes;
}

function buildSlots(config = {}) {
  return SLOTS.map(slot => {
    const c = { ...DEFAULT_CLEAN_MODES[slot.key], ...config[slot.key] };
    const task = slot.group === 'vacuum' ? { narwal: NarwalMode.VACUUM, label: 'Vacuum' }
      : slot.group === 'mop' ? { narwal: NarwalMode.MOP, label: 'Mop' }
        : TASKS[c.task] ?? TASKS[DEFAULT_CLEAN_MODES[slot.key].task];
    const settings = {};
    const details = [];
    if (task.narwal !== NarwalMode.FREO_MIND) {
      const passes = Number(c.passes);
      if (passes >= 1 && passes <= 3) {
        settings.passes = passes;
        details.push(`${passes} pass${passes > 1 ? 'es' : ''}`);
      }
      if (task.narwal !== NarwalMode.MOP && Suction[c.suction]) {
        settings.suction = Suction[c.suction];
        details.push(SUCTION_LABELS[c.suction]);
      }
      if (task.narwal !== NarwalMode.VACUUM && Water[c.water]) {
        settings.water = Water[c.water];
        details.push(WATER_LABELS[c.water]);
      }
    }
    return {
      mode: slot.mode,
      key: slot.key,
      label: [task.label, ...details].join(', '),
      narwal: task.narwal,
      settings,
      tags: slot.tags,
    };
  });
}

/**
 * The vacuum must offer the mode it reports as current, or matter.js won't publish it, so a saved
 * mode number that's no longer offered maps to one that is (unknown ones fall back to the first).
 * History: 0 was "Vacuum & Mop" (Narwal 4) up to 0.1.6; 3 was "Vacuum then Mop" (app settings) in
 * 0.1.4–0.1.7; 4 was the combined button's separate Automatic (Freo Mind) until 0.3.0, when every
 * button got the same Automatic / Quick / Deep Clean and Freo Mind became a task choice.
 */
const RETIRED_MODES = { 4: 0 };

const FRESH_STATUS = 5000; // a status this recent is trusted by Return to dock
const STATUS_WAIT = 5000; // how long Return to dock waits for a status from a robot that was quiet
const BATTERY_LAND = 3000; // a battery update should show in Homebridge's Matter state within this
const RECALL_CHECK = 20000; // the robot should be on its way home this soon after Return to dock

// A return to the base (end of a job, Return to dock, a mop wash) that takes far longer than usual means
// the base is unplugged or the way is blocked. The limit is learned from earlier returns: RETURN_FACTOR
// times the expected time, at least RETURN_MIN; RETURN_DEFAULT until RETURN_LEARNED returns are known.
const RETURN_DEFAULT = 10 * 60 * 1000;
const RETURN_MIN = 3 * 60 * 1000;
const RETURN_FACTOR = 3;
const RETURN_LEARNED = 3; // samples needed before the limit is learned
const RETURN_SAMPLES = 20; // samples kept (the median is used)
const RETURN_MAX_SAMPLE = 30 * 60 * 1000; // a longer return isn't a sample
const RETURN_MIN_DISTANCE = 1; // metres: closer than this, time per metre means nothing
const RETURN_POSE_FRESH = 5 * 1000; // a position this recent is where a return started
// A robot away from its base sends status every ~1.5 s while kept awake. Silent for ROBOT_SILENT (or, with
// no status since start-up, STARTUP_SILENT): wake it, then warn if it is still silent SILENT_RECHECK later.
const WATCH_TICK = 15 * 1000;
const ROBOT_SILENT = 3 * 60 * 1000;
const STARTUP_SILENT = 2 * 60 * 1000;
const SILENT_RECHECK = 60 * 1000;

/**
 * On the dock and not in a job. Field 11 saying out of the base wins over the state: a robot lifted
 * off its base while idle may keep reporting the station state or the docked flag. Field 11 saying in
 * the base counts too: an idle robot charging after a flat battery reported base 3 without the docked flag.
 */
function isDocked(s) {
  return (onDock(s) || (Boolean(s) && !inJob(s) && s.atBase)) && s.base !== 1;
}

/**
 * The base station is working on the robot (state 14) and the robot reports itself out of the base,
 * not paused and not recalled: it is driving back to its base by itself (a paused mop drying that was
 * resumed from the Narwal app or the robot's button does this, wherever the robot was put down).
 */
function seekingBase(s) {
  return Boolean(s) && s.state === WorkState.STATION && s.base === 1 && !s.paused && !s.returning;
}

/** The base station is drying the mops with the robot on it. */
function dryingMops(s) {
  return Boolean(s) && s.state === WorkState.STATION && (s.station === 4 || s.base === 3);
}

/** Median of a list of numbers (undefined when empty). */
export function median(list) {
  if (!list?.length) {
    return undefined;
  }
  const sorted = [...list].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * How long (ms) a return to the base may take before something is wrong. `learned` = { perMetre, seconds }
 * from earlier returns, `distance` = metres from the base when this one started (undefined if unknown).
 */
export function returnLimit(learned, distance) {
  let expected;
  if ((learned?.perMetre?.length ?? 0) >= RETURN_LEARNED && distance !== undefined) {
    expected = HOME_OVERHEAD + distance * median(learned.perMetre) * 1000;
  } else if ((learned?.seconds?.length ?? 0) >= RETURN_LEARNED) {
    expected = median(learned.seconds) * 1000;
  }
  return expected === undefined ? RETURN_DEFAULT : Math.max(RETURN_MIN, RETURN_FACTOR * expected);
}

// Why a clean ended: Narwal app's TaskResult enum (only 1 and 2 seen on the Freo so far).
const END_REASONS = {
  1: 'finished', 2: 'stopped by you', 3: 'the robot shut down', 4: 'battery too low',
  5: 'overflow (tank or dustbin full)', 6: 'paused too long', 7: 'system error', 8: 'stopped at the base station',
  9: 'stopped from the Narwal app', 10: 'sent back to the base', 11: 'finished, but the map couldn\'t be updated',
  12: 'the map didn\'t match', 13: 'the robot lost its position (near the base)',
  14: 'the robot lost its position (away from the base)', 15: 'an error before the job started',
  16: 'ended by a schedule', 17: 'never started', 18: 'pet not found',
};
// Normal or user-driven ends; every other reason is logged as a warning.
const NORMAL_END_REASONS = [1, 2, 8, 9, 10, 16];

/** One log line for a parseCleanReport result. */
export function formatCleanReport(r) {
  const how = END_REASONS[r.reason] ?? (r.reason === undefined ? 'ended' : `ended (reason ${r.reason})`);
  const parts = [];
  if (r.percent !== undefined) {
    parts.push(`${r.percent}% done`);
  }
  const details = [];
  if (r.area !== undefined) {
    details.push(`${r.area.toFixed(1)} m²`);
  }
  if (r.seconds !== undefined) {
    details.push(r.seconds >= 60 ? `${Math.floor(r.seconds / 60)} min ${r.seconds % 60} s` : `${r.seconds} s`);
  }
  const text = [...parts, details.join(' in ')].filter(Boolean).join(', ');
  return `Clean report: ${how}${text ? `, ${text}` : ''}.`;
}

export class NarwalVacuum {
  /**
   * @param {object} opts
   * @param {import('homebridge').API} opts.api
   * @param {import('homebridge').Logging} opts.log
   * @param {import('./robot.js').NarwalRobot} opts.robot
   * @param {object} opts.device Narwal device record
   * @param {string} opts.name
   * @param {object} opts.store persisted state (rooms, plans, cleanMode, selectedAreas)
   * @param {() => void} opts.save persist `store`
   * @param {import('./security-hold.js').SecurityHold} [opts.security] switch the security system from Away to Stay while cleaning
   * @param {number} [opts.securityStoppedMinutes] let the security system go back to Away once the
   *   robot has stood still this long off the base mid-job (0: keep the hold until the job ends)
   * @param {object} [opts.cleanModes] the `cleanModes` setting (see buildModes)
   * @param {Array} [opts.mapSettings] the `maps` setting: floor names, room names, stair detection (see floors.js)
   * @param {number} [opts.vacationCleans] cleans allowed after vacation mode is turned on
   * @param {string} [opts.vacationAfter] then: 'none' (refuse cleans) or 'vacuum' (vacuum only)
   */
  constructor({ api, log, robot, device, name, store, save, security, securityStoppedMinutes = 10, cleanModes,
    mapSettings, vacationCleans = 1, vacationAfter = 'none' }) {
    if (store.cleanMode in RETIRED_MODES) {
      store.cleanMode = RETIRED_MODES[store.cleanMode];
    }
    this.api = api;
    this.matter = api.matter;
    this.log = log;
    this.robot = robot;
    this.store = store;
    this.save = save;
    this.modeList = buildModes(cleanModes);
    this.mapSettings = mapSettings;
    this.refreshFloors();
    this.ready = false;
    this.status = undefined;
    this.fault = undefined;
    this.uuid = this.matter.uuid.generate(`narwal-${device.deviceId}`);
    this.name = name;
    this.device = device;
    this.opState = Op.Docked;
    this.security = security;
    this.securityStoppedMinutes = securityStoppedMinutes;
    this.vacationCleans = vacationCleans;
    this.vacationAfter = vacationAfter;
    // Whether the security system was checked (and held, if Away) for the current outing.
    this.securityChecked = false;
  }

  stop() {
    if (this.zoneQueue) {
      clearTimeout(this.zoneQueue.reportTimer);
      clearTimeout(this.zoneQueue.leaveTimer);
      clearTimeout(this.zoneQueue.startTimer);
      this.zoneQueue = undefined;
    }
    this.dropTrip();
    clearInterval(this.watchTimer);
    clearTimeout(this.releaseTimer);
    clearTimeout(this.haltTimer);
    clearTimeout(this.homeTimer);
    clearTimeout(this.stairFirst);
    clearInterval(this.stairTimer);
    clearTimeout(this.mapFirst);
    clearInterval(this.mapTimer);
  }

  /** Rebuild the floors (maps and their rooms, with the names and stair detection chosen in the settings). */
  refreshFloors() {
    this.floors = buildFloors(this.store.maps ?? [], this.store.mainMapId, this.mapSettings);
    this.areas = allAreas(this.floors);
  }

  /** The floor the robot is on: where the last job started until it's back on its base, else its current map. */
  robotFloor() {
    const id = this.store.robotMapId ?? this.robot.currentMapId;
    return this.floors.find(f => f.id === id) ?? this.floors.find(f => f.main) ?? this.floors[0];
  }

  /** Modes offered to the Home app. */
  get modes() {
    return this.modeList;
  }

  get cleanMode() {
    return this.modes.find(m => m.mode === this.store.cleanMode) ?? this.modes[0];
  }

  supportedMaps() {
    return this.floors.map(f => ({ mapId: f.id, name: f.name }));
  }

  supportedAreas() {
    return this.areas.map(area => ({
      areaId: area.areaId,
      mapId: area.mapId,
      areaInfo: {
        locationInfo: { locationName: area.name, floorNumber: 0, areaType: areaType(area) },
        landmarkInfo: null,
      },
    }));
  }

  /** The accessory definition handed to api.matter.registerPlatformAccessories. */
  accessory() {
    const status = this.matter.status;
    // Published from the robot's status when one has arrived; otherwise unknown, never made up (the Home
    // app takes these values when its hub connects, and may keep them).
    const s = this.status;
    const op = s ? this.opFor(s) : Op.Stopped;
    return {
      UUID: this.uuid,
      displayName: this.name,
      deviceType: this.matter.deviceTypes.RoboticVacuumCleaner,
      serialNumber: this.device.snNumber ?? this.device.deviceId,
      manufacturer: 'Narwal',
      model: this.device.robotName ?? 'Freo',
      firmwareRevision: this.device.firmwareVersion ?? '1.0.0',
      context: { deviceId: this.device.deviceId },
      clusters: {
        powerSource: {
          status: 1,
          order: 0,
          description: 'Battery',
          batReplaceability: 1,
          ...this.powerFor(s, op),
        },
        rvcRunMode: {
          supportedModes: [
            { label: 'Idle', mode: RUN_IDLE, modeTags: [{ value: RunTag.Idle }] },
            { label: 'Cleaning', mode: RUN_CLEANING, modeTags: [{ value: RunTag.Cleaning }] },
          ],
          currentMode: op === Op.Running || op === Op.Paused ? RUN_CLEANING : RUN_IDLE,
        },
        rvcCleanMode: {
          supportedModes: this.modes.map(m => ({ label: m.label, mode: m.mode, modeTags: m.tags.map(value => ({ value })) })),
          currentMode: this.cleanMode.mode,
        },
        rvcOperationalState: {
          operationalStateList: Object.values(Op).map(id => ({ operationalStateId: id })),
          operationalState: op,
          operationalError: { errorStateId: ErrorState.NoError },
        },
        serviceArea: {
          supportedMaps: this.supportedMaps(),
          supportedAreas: this.supportedAreas(),
          selectedAreas: this.validSelection(this.store.selectedAreas),
          currentArea: null,
        },
      },
      handlers: this.logged({
        rvcRunMode: {
          changeToMode: async ({ newMode }) => {
            if (newMode === RUN_CLEANING) {
              await this.start();
            } else if (newMode === RUN_IDLE) {
              await this.goHome();
            } else {
              throw new status.InvalidCommand(`Unknown run mode ${newMode}`);
            }
          },
        },
        rvcCleanMode: {
          changeToMode: async ({ newMode }) => {
            const mode = this.modes.find(m => m.mode === newMode);
            if (!mode) {
              throw new status.InvalidCommand(`Unknown clean mode ${newMode}`);
            }
            this.store.cleanMode = mode.mode;
            this.save();
            this.log.info(`Clean mode set to ${mode.label}`);
          },
        },
        identify: {
          // The Home app's "Play Sound to Locate".
          identify: async () => {
            this.ensureConnected();
            this.log.info('Playing the locate sound');
            this.robot.locate();
          },
        },
        rvcOperationalState: {
          pause: async () => this.pause(),
          resume: async () => this.resume(),
          goHome: async () => this.goHome(),
        },
        serviceArea: {
          selectAreas: async ({ newAreas }) => {
            // Home ignores a refusal here and sends the start anyway, so the request is remembered
            // either way: start() decides what to do with it.
            this.store.selectedAreas = [...newAreas];
            this.save();
            const known = new Map(this.areas.map(a => [a.areaId, a]));
            const bad = newAreas.filter(id => !known.has(id));
            if (bad.length) {
              throw new status.NotFound(`Unknown room ${bad.join(', ')}`);
            }
            if (new Set(newAreas.map(id => known.get(id).mapId)).size > 1) {
              throw new status.InvalidCommand('Pick rooms from one floor');
            }
            this.log.info(`Rooms selected: ${newAreas.map(id => this.floorLabel(known.get(id))).join(', ') || 'all'}`);
          },
          skipArea: async ({ skippedArea }) => {
            this.store.selectedAreas = (this.store.selectedAreas ?? []).filter(id => id !== skippedArea);
            this.save();
          },
        },
      }),
    };
  }

  /** Wrap every Home app command handler so each call, and any refusal, shows in the log. */
  logged(handlers) {
    return Object.fromEntries(Object.entries(handlers).map(([cluster, methods]) => [cluster,
      Object.fromEntries(Object.entries(methods).map(([name, fn]) => [name, async (request, ...rest) => {
        const args = request && Object.keys(request).length ? ` ${JSON.stringify(request)}` : '';
        this.log.debug(`Home app: ${cluster}.${name}${args} (state ${this.opState})`);
        try {
          return await fn(request, ...rest);
        } catch (error) {
          this.log.warn(`Home app ${cluster}.${name}${args} refused: ${error.message}`);
          throw error;
        }
      }]))]));
  }

  /** A room's name for the log; with several floors, the floor's too. */
  floorLabel(area) {
    return this.floors.length > 1 ? `${area.name} (${this.floors.find(f => f.id === area.mapId)?.name})` : area.name;
  }

  /** The selection as the Home app should see it: rooms we know, all on one floor (the first room's). */
  validSelection(ids) {
    const known = new Map(this.areas.map(a => [a.areaId, a]));
    const valid = (ids ?? []).filter(id => known.has(id));
    return valid.filter(id => known.get(id).mapId === known.get(valid[0]).mapId);
  }

  setReady() {
    this.ready = true;
    this.readyAt = Date.now();
    clearInterval(this.watchTimer);
    this.watchTimer = setInterval(() => this.watch().catch(() => {}), WATCH_TICK);
    this.watchTimer.unref?.();
    const s = this.status;
    if (s) {
      // Statuses that arrived before publishing weren't sent; push this one in full.
      this.status = undefined;
      this.opState = undefined;
      this.applyStatus(s);
    }
  }

  async update(cluster, attributes) {
    if (!this.ready) {
      return;
    }
    try {
      await this.matter.updateAccessoryState(this.uuid, cluster, attributes);
    } catch (error) {
      this.log.warn(`Matter update of ${cluster} failed: ${error.message}`);
      return false;
    }
    return true;
  }

  // ── Commands from the Home app ──

  ensureConnected() {
    if (!this.robot.connected) {
      throw new this.matter.status.Busy('Not connected to the Narwal cloud yet');
    }
  }

  /** The robot is inside a vacuum/mop task (running, paused, or halted by an error). */
  inTask() {
    const s = this.status;
    return inJob(s) && !s.returning;
  }

  /** A task the robot is holding that `resume` would continue (paused, or stopped by an error). */
  canResume() {
    return this.opState === Op.Paused || (this.inTask() && (this.status.paused || this.opState === Op.Error));
  }

  async start() {
    this.ensureConnected();
    // A trip back to the starting point (or a room queue) that isn't really running is over; a trip that
    // is, is replaced by the new clean (the robot is told to end its job first).
    this.reapStale();
    if (this.trip) {
      await this.replaceTrip();
    } else if (this.canResume()) {
      return this.resume();
    }
    if (this.starting) {
      throw new this.matter.status.Busy('A clean is already starting');
    }
    this.starting = true;
    try {
      const s = this.status;
      if (s && s.state === WorkState.STATION && s.paused && s.base === 1) {
        this.log.debug('Starting while the base\'s mop drying is paused off the base.');
      }
      await this.clearNotice();
      await this.clearCondition('return');
      await this.startClean();
    } finally {
      this.starting = false;
    }
  }

  /**
   * Refuse a start: the reason goes to the log and, shorter (`tile`: Matter allows 64 characters), onto the
   * tile as a Matter error, and the Home app gets the exception to throw. The robot isn't started.
   */
  async refuse(message, tile = message) {
    this.log.warn(`Not cleaning: ${message}.`);
    await this.setNotice(ErrorState.UnableToStartOrResume, tile).catch(() => {});
    return new this.matter.status.InvalidInState(tile.slice(0, 64));
  }

  /**
   * Which floor and rooms the Home app asked for. The rooms decide the floor (Home never mixes floors);
   * with none selected, it's every room of the robot's current floor. A selection we can't make sense of
   * is refused, never turned into a clean of everything.
   */
  async cleanTarget() {
    const asked = this.store.selectedAreas ?? [];
    if (!asked.length) {
      const floor = this.robotFloor();
      return { floor, rooms: floor.rooms };
    }
    const known = new Map(this.areas.map(a => [a.areaId, a]));
    if (asked.some(id => !known.has(id))) {
      throw await this.refuse('Some of the selected rooms no longer exist. Pick the rooms again', 'Selected rooms no longer exist');
    }
    const floors = new Set(asked.map(id => known.get(id).mapId));
    if (floors.size > 1) {
      throw await this.refuse('The selected rooms are on different floors. Pick rooms from one floor', 'Selected rooms are on different floors');
    }
    const floor = this.floors.find(f => f.id === known.get(asked[0]).mapId);
    return { floor, rooms: asked.map(id => floor.rooms.find(r => r.areaId === id)) };
  }

  /** The cleaning plans saved for a floor (the app's per-room settings for each mode). */
  plansFor(floor) {
    return this.store.plansByMap?.[floor.id];
  }

  async startClean() {
    if (!this.areas.length) {
      throw new this.matter.status.InvalidInState(
        'The room list has not loaded yet. Try again in a minute; if it keeps failing, check that the robot is online.');
    }
    const { floor, rooms } = await this.cleanTarget();
    const roomIds = rooms.map(r => r.id);
    const mode = this.vacationMode(this.cleanMode);

    // The robot cleans the floor it is set to, and the start command names none: change floors first.
    // Everything must be confirmed by the robot's replies; otherwise nothing starts.
    let switched = false;
    if (this.floors.length > 1) {
      const here = await this.robot.currentMap();
      if (here !== floor.id) {
        if (inJob(this.status)) {
          throw await this.refuse(`Can't change to ${floor.name} while the robot is cleaning`, 'Can\'t change floors while cleaning');
        }
        this.log.info(`Switching the robot to ${floor.name}.`);
        await this.robot.switchMap(floor.id).catch(async (error) => {
          throw await this.refuse(`Could not change to ${floor.name} (${error.message})`, error.message);
        });
        switched = true;
      }
    }
    await this.ensureStairs(floor);
    let plans = this.plansFor(floor);
    if (this.floors.length > 1 && (switched || !plans)) {
      await this.robot.fetchPlans();
      plans = this.plansFor(floor) ?? plans;
    }

    // A floor without a base station only does zone cleaning (Narwal's rule, and the Narwal app offers
    // no rooms there): each room is cleaned as a zone shaped like the room.
    const noBase = floor.hasDock === false;
    let narwalMode = mode.narwal;
    if (noBase && narwalMode === NarwalMode.FREO_MIND) {
      this.log.info(`Freo Mind can't clean zones on ${floor.name}; cleaning with Vacuum and Mop instead.`);
      narwalMode = NarwalMode.VACUUM_AND_MOP;
    }
    const templates = Object.fromEntries(
      Object.entries(plans?.[narwalMode] ?? {}).map(([id, hex]) => [id, Buffer.from(hex, 'hex')]));
    if (narwalMode === NarwalMode.FREO_MIND && roomIds.some(id => !templates[id])) {
      throw new this.matter.status.InvalidInState(
        'Freo Mind needs the room plans from the robot, which have not loaded yet. Try again in a minute.');
    }
    const missing = rooms.filter(r => !templates[r.id]);
    if (missing.length) {
      this.log.info(`No Narwal app settings for this task in ${missing.map(r => r.name).join(', ')} yet; using standard suction and water.`);
    }
    const zones = noBase ? await this.zonesFor(floor, rooms) : [];
    // On a floor without a base the rooms run nearest first, not in the Home app's order.
    const cleanOrder = noBase ? [...new Set(zones.map(z => z.roomId))].map(id => rooms.find(r => r.id === id)) : rooms;
    if (noBase && cleanOrder.length > 1) {
      this.log.info(`Rooms on ${floor.name} in this order: ${cleanOrder.map(r => r.name).join(', ')}.`);
    }
    await this.holdSecurity();
    this.log.info(`Starting ${mode.label}: ${cleanOrder.map(r => r.name).join(', ')}${this.floors.length > 1 ? ` (${floor.name})` : ''}`
      + (noBase ? `, as ${zones.length} ${zones.length === 1 ? 'zone' : 'zones'} shaped like the ${rooms.length === 1 ? 'room' : 'rooms'}`
        + (zones.length > 1 ? ', one after another' : '') : ''));
    if (noBase && [NarwalMode.MOP, NarwalMode.VACUUM_AND_MOP, NarwalMode.VACUUM_THEN_MOP].includes(narwalMode)) {
      this.log.info(`Mopping on ${floor.name} is limited by the robot to about 14 m² per job (no base station to wash the mops); it stops by itself at its limit.`);
    }
    this.store.robotMapId = floor.id;
    this.save();
    // A new start replaces whatever rooms were still queued.
    this.finishQueue(this.zoneQueue, 'a new clean was started');
    if (noBase) {
      await this.holdAutoMainMapOff(floor);
    }
    let reply;
    if (noBase) {
      // The Narwal app takes one zone per job on such a map, so the rooms are cleaned in turn.
      const byId = new Map(rooms.map(r => [r.id, r]));
      const q = this.zoneQueue = {
        floor, narwalMode, templates, settings: mode.settings, index: 0, done: 0,
        entries: zones.map(zone => ({ zone, room: byId.get(zone.roomId) })),
      };
      reply = await this.launchZone(q);
    } else {
      // The job must stay on this floor's map (see checkMap).
      this.armMapGuard(floor.id);
      reply = await this.robot.startClean(roomIds, narwalMode, templates, mode.settings);
    }
    if (reply && !reply.ok && !reply.timedOut) {
      this.finishQueue(this.zoneQueue, 'the robot refused to start');
      throw await this.refuse('The robot refused to start');
    }
    await this.setOpState(Op.Running);
    await this.update('rvcRunMode', { currentMode: RUN_CLEANING });
    if (noBase) {
      // The robot may not say which room a zone is in: show the first one until it does (applyWorking).
      await this.update('serviceArea', { currentArea: this.zoneQueue.entries[0].room.areaId });
    }
  }

  /** The job must stay on this floor's map (see checkMap): armed at every start. */
  armMapGuard(floorId) {
    this.mapGuard = { floorId, at: Date.now() };
    this.mapStopped = false;
    this.mapSilentSince = undefined;
    this.mapSilentWarned = false;
  }

  // ── Rooms in turn (a floor without a base station: one zone per job) ──
  //
  // Narwal's app only allows one area per job on such a map, and a start with several zones cleans just
  // the first. So the rooms are queued (in memory only: after a restart a second zone must not set the
  // robot off without anyone asking) and each zone is a job of its own. A zone's end is the robot's
  // clean report saying "finished" (the robot's job state leaving the job too); the next zone starts
  // from there, after checking the floor, stair detection and the security hold again. The queue is
  // dropped by anything else: a pause that is never resumed simply waits, but a stop, a different end
  // reason, an error, Return to dock, the security system arming Away, a floor change, or a job started
  // from elsewhere all end it. Phases: starting (sent, waiting for the job to show), running, gap
  // (zone ended; waiting for the report and for the robot to leave the job, then the next one starts).

  /** Between two zones (or after the last one, until its report): the tile keeps showing a clean. */
  queueGap() {
    const q = this.zoneQueue;
    return q?.phase === 'gap' && q.index < q.entries.length - 1;
  }

  /** Send zone `q.index` (one zone per job). */
  async launchZone(q) {
    const entry = q.entries[q.index];
    this.armMapGuard(q.floor.id);
    q.phase = 'starting';
    q.sentAt = Date.now();
    q.reportDone = false;
    q.userPaused = false;
    clearTimeout(q.reportTimer);
    clearTimeout(q.leaveTimer);
    clearTimeout(q.startTimer);
    q.startTimer = setTimeout(() => {
      if (this.zoneQueue === q && q.phase === 'starting') {
        this.log.warn(`The robot didn't start ${entry.room.name} within ${ZONE_START_WAIT / 1000} s.`);
        this.abortQueue(q, 'the robot didn\'t start the next room', q.index > 0 ? 'The robot didn\'t start the next room' : undefined);
      }
    }, ZONE_START_WAIT);
    q.startTimer.unref?.();
    return this.robot.startZones([entry.zone], q.narwalMode, q.templates, q.settings);
  }

  /** Drop the queue (nothing is sent) and say how far it got. */
  finishQueue(q, why) {
    if (!q || this.zoneQueue !== q) {
      return;
    }
    this.zoneQueue = undefined;
    if (why !== 'a new clean was started') {
      this.restoreAutoMainMap();
      this.restoreStairs({ force: true });
    }
    clearTimeout(q.reportTimer);
    clearTimeout(q.leaveTimer);
    clearTimeout(q.startTimer);
    const total = q.entries.length;
    if (total > 1) {
      const left = q.entries.slice(q.done).map(e => e.room.name);
      this.log.info(why === 'complete'
        ? `Rooms on ${q.floor.name} done: ${q.entries.map(e => e.room.name).join(', ')}.`
        : `Rooms on ${q.floor.name}: stopped after ${q.done} of ${total} (${why})${left.length ? `; not cleaned: ${left.join(', ')}` : ''}.`);
    } else {
      this.log.debug(`Zone clean on ${q.floor.name} over (${why})`);
    }
  }

  /** End the queue and let the tile and the security hold follow the robot again; `notice` puts an error on the tile. */
  async abortQueue(q, why, notice, code = ErrorState.UnableToStartOrResume) {
    if (!q || this.zoneQueue !== q) {
      return;
    }
    this.finishQueue(q, why);
    this.commandGraceUntil = 0;
    this.jobSeen = true; // a start that failed after a re-check of the hold: don't wait out the start timeout to release it
    if (notice) {
      await this.setNotice(code, notice).catch(() => {});
    }
    if (this.status) {
      await this.refresh(this.status).catch(() => {});
    }
  }

  /** The robot's job state went from in a job to out of one. */
  queueJobEnded() {
    const q = this.zoneQueue;
    if (!q) {
      return;
    }
    if (q.phase === 'running') {
      q.phase = 'gap';
      clearTimeout(q.reportTimer);
      q.reportTimer = setTimeout(() => {
        if (this.zoneQueue === q && !q.reportDone) {
          this.log.warn(`No end-of-clean report ${REPORT_WAIT / 1000} s after the robot left the job; not cleaning the next room.`);
          this.abortQueue(q, 'no end report from the robot', q.index < q.entries.length - 1 ? 'No end report from the robot' : undefined,
            ErrorState.UnableToCompleteOperation);
        }
      }, REPORT_WAIT);
      q.reportTimer.unref?.();
    }
    this.queueNext();
  }

  /** The robot's job state shows the job we started. */
  queueJobStarted() {
    const q = this.zoneQueue;
    if (!q) {
      return;
    }
    if (q.phase === 'starting') {
      q.phase = 'running';
      clearTimeout(q.startTimer);
    } else if (q.phase === 'gap') {
      // A job began between zones that we didn't send: the robot is being run from somewhere else.
      this.finishQueue(q, 'a clean was started elsewhere');
    }
  }

  /** The end-of-clean report of a job (already de-duplicated). */
  queueReport(r) {
    const q = this.zoneQueue;
    if (!q || !['starting', 'running', 'gap'].includes(q.phase) || q.reportDone) {
      return;
    }
    if (r.end !== undefined && r.end * 1000 < q.sentAt - REPORT_SKEW) {
      return; // an earlier job's report
    }
    if (r.reason !== 1) {
      const how = END_REASONS[r.reason] ?? (r.reason === undefined ? 'ended' : `ended (reason ${r.reason})`);
      this.finishQueue(q, `the robot's job ${how}`);
      this.commandGraceUntil = 0;
      if (this.status) {
        this.refresh(this.status).catch(() => {});
      }
      return;
    }
    q.reportDone = true;
    q.done = q.index + 1;
    clearTimeout(q.reportTimer);
    q.phase = 'gap';
    if (q.index >= q.entries.length - 1) {
      this.finishQueue(q, 'complete');
      this.commandGraceUntil = 0;
      if (this.status) {
        this.refresh(this.status).catch(() => {});
      }
      return;
    }
    // The next zone waits for the robot to leave the job state.
    clearTimeout(q.leaveTimer);
    q.leaveTimer = setTimeout(() => {
      if (this.zoneQueue === q && q.phase === 'gap' && inJob(this.status)) {
        this.log.warn('The robot still reports a job after its clean report; not cleaning the next room.');
        this.abortQueue(q, 'the robot didn\'t leave the job', 'The robot didn\'t end the job',
          ErrorState.UnableToCompleteOperation);
      }
    }, LEAVE_JOB_WAIT);
    q.leaveTimer.unref?.();
    this.queueNext();
  }

  /** Start the next zone once the last one has ended (report finished, job state left) and nobody paused. */
  queueNext() {
    const q = this.zoneQueue;
    if (q && q.phase === 'gap' && q.reportDone && !inJob(this.status) && !q.userPaused && !q.continuing) {
      this.continueQueue(q).catch(error => this.log.warn(`Could not carry on with the next room (${error.message}).`));
    }
  }

  /**
   * Check everything again and send the next zone: the robot still on this floor with stair detection as
   * the floor wants it, and the security system's hold (it fails closed). Any failure ends the queue
   * with an error on the tile.
   */
  async continueQueue(q) {
    q.continuing = true;
    clearTimeout(q.leaveTimer);
    const stop = (why, tile, code) => this.abortQueue(q, why, tile, code);
    try {
      if (!this.robot.connected) {
        return await stop('not connected to the Narwal cloud', 'Lost the robot before the next room');
      }
      if (this.fault || this.notice) {
        this.log.warn('Not cleaning the next room: the robot has an error.');
        return await stop('the robot has an error'); // the tile already shows it
      }
      const here = await this.backToFloor(q.floor);
      if (this.zoneQueue !== q) {
        return;
      }
      if (here !== q.floor.id) {
        const where = here === undefined ? 'the robot didn\'t say which map it is on' : `the robot is on ${this.floorName(here)}`;
        this.log.warn(`Not cleaning the next room: ${where}, not ${q.floor.name}.`);
        return await stop(where, `Next room: robot is not on ${q.floor.name}`.slice(0, 64), ErrorState.UnableToCompleteOperation);
      }
      try {
        await this.ensureStairs(q.floor);
        await this.holdSecurity('cleaning the next room');
      } catch (error) {
        return await stop(error.message, error.message, ErrorState.UnableToStartOrResume);
      }
      if (this.zoneQueue !== q || q.phase !== 'gap') {
        return;
      }
      if (inJob(this.status)) {
        return this.finishQueue(q, 'a clean was started elsewhere');
      }
      if (q.userPaused) {
        return; // paused during the checks: Resume carries on
      }
      q.index++;
      const entry = q.entries[q.index];
      this.log.info(`Next room on ${q.floor.name}: ${entry.room.name} (${q.index + 1} of ${q.entries.length})`);
      const reply = await this.launchZone(q);
      if (this.zoneQueue !== q) {
        return;
      }
      if (reply && !reply.ok && !reply.timedOut) {
        this.log.warn(`The robot refused to start ${entry.room.name}.`);
        return await stop('the robot refused the next room', 'The robot refused the next room');
      }
      await this.update('serviceArea', { currentArea: entry.room.areaId });
    } finally {
      q.continuing = false;
    }
  }

  /**
   * The zones for cleaning rooms on a floor without a base station, one per patch of floor of each room,
   * shaped from the map the robot is on now. Refuses (nothing starts) if the map can't be read.
   */
  async zonesFor(floor, rooms) {
    const shape = await this.robot.mapShape();
    if (!shape || shape.id !== floor.id) {
      throw await this.refuse(`Could not read the map of ${floor.name} to shape the zones`, 'Could not read the room shapes');
    }
    // Nearest room first, from where the robot is (its last position if recent, else the starting point).
    const pose = this.lastPose && Date.now() - this.lastPose.at <= POSE_FRESH ? this.lastPose : undefined;
    const from = pose ? { x: pose.x / MAP_UNIT, y: pose.y / MAP_UNIT } : { x: floor.start.x / MAP_UNIT, y: floor.start.y / MAP_UNIT };
    const ordered = nearestFirst(shape, rooms.map(r => r.id), from).map(id => rooms.find(r => r.id === id));
    const zones = [];
    for (const room of ordered) {
      const outlines = roomOutlines(shape, room.id);
      if (!outlines.length) {
        this.log.warn(`${room.name} has no floor on the map of ${floor.name}; leaving it out.`);
      }
      zones.push(...outlines.map(outline => ({ roomId: room.id, ...outline })));
    }
    if (!zones.length) {
      throw await this.refuse(`None of the selected rooms has floor on the map of ${floor.name}`, 'The selected rooms have no floor on the map');
    }
    return zones;
  }

  // ── Stair detection (per floor) ──

  /**
   * Make the robot's stair detection what the floor's setting says, and check it took. A floor that
   * needs stair detection on is not cleaned if that can't be set (a robot without it could drive down
   * the stairs); one that wants it off still is, with a warning, since it only risks false "stuck" errors.
   */
  async ensureStairs(floor) {
    if (!floor.managed) {
      return;
    }
    const want = !floor.stairDetection; // stairless mode
    clearTimeout(this.stairRestoreTimer);
    this.stairRestoreTimer = undefined;
    if (want) {
      this.stairsOff = true; // restoreStairs turns it back on after the clean
    }
    const word = on => (on ? 'on' : 'off');
    const fail = async (what) => {
      if (floor.stairDetection) {
        throw await this.refuse(`${what}. ${floor.name} needs stair detection on`, what);
      }
      this.log.warn(`${what}; cleaning ${floor.name} with stair detection as the robot has it.`);
    };
    const have = await this.robot.stairless();
    if (have === undefined) {
      return fail('Could not read the robot\'s stair detection setting');
    }
    if (have !== want) {
      if (!await this.robot.setStairless(want)) {
        return fail(`The robot didn't accept turning stair detection ${word(!want)}`);
      }
      if (await this.robot.stairless() !== want) {
        return fail(`The robot didn't keep stair detection ${word(!want)}`);
      }
      this.log.info(`Stair detection turned ${word(!want)} for ${floor.name}.`);
    }
    this.stairPaused = false;
  }

  /**
   * While a job runs on a floor that needs stair detection, check the robot still has it (something
   * else, such as the Narwal app, may have turned it off): if not, pause the robot and say so on the tile.
   */
  async checkStairs() {
    const floor = this.robotFloor();
    if (this.checkingStairs || !floor?.managed || !floor.stairDetection || !inJob(this.status)
      || this.status.paused || !this.robot.connected) {
      return;
    }
    this.checkingStairs = true;
    try {
      if (await this.robot.stairless(true) !== true || !inJob(this.status) || this.status.paused) {
        return;
      }
      this.stairPaused = true;
      this.log.warn(`Stair detection is off on the robot, but ${floor.name} needs it on: pausing the robot. `
        + 'Resume it from the Home app to turn stair detection back on and carry on.');
      this.robot.pause();
      await this.setOpState(Op.Paused).catch(() => {});
      await this.setNotice(ErrorState.UnableToCompleteOperation, `Stair detection is off, but ${floor.name} needs it on`);
    } catch (error) {
      this.log.debug(`Stair detection check skipped: ${error.message}`);
    } finally {
      this.checkingStairs = false;
    }
  }

  /** Keep checking stair detection while a job runs (and once soon after it starts). */
  watchStairs(active) {
    if (!active) {
      clearTimeout(this.stairFirst);
      clearInterval(this.stairTimer);
      this.stairFirst = this.stairTimer = undefined;
      return;
    }
    if (!this.stairTimer) {
      this.stairFirst = setTimeout(() => this.checkStairs(), 3000);
      this.stairTimer = setInterval(() => this.checkStairs(), STAIR_CHECK);
      this.stairFirst.unref?.();
      this.stairTimer.unref?.();
    }
  }

  // ── Floor guard ──

  /**
   * The Freo can switch its own current map during a job: if it can't place itself on the map it was
   * given, it tries its others and may settle on the wrong floor, where the no-go zones mean nothing.
   * While a job the plugin started runs, ask for the current map every few seconds (the robot's
   * answers to other clients count too, see applyCurrentMap); on another floor's map, stop the job.
   */
  watchMap(active) {
    if (!active) {
      clearTimeout(this.mapFirst);
      clearInterval(this.mapTimer);
      this.mapFirst = this.mapTimer = undefined;
      return;
    }
    if (!this.mapTimer && this.floors.length > 1) {
      this.mapFirst = setTimeout(() => this.checkMap(), 1000);
      this.mapTimer = setInterval(() => this.checkMap(), MAP_CHECK);
      this.mapFirst.unref?.();
      this.mapTimer.unref?.();
    }
  }

  async checkMap() {
    if (this.checkingMap || !inJob(this.status) || !this.robot.connected) {
      return;
    }
    this.checkingMap = true;
    try {
      // The reply also reaches applyCurrentMap through the robot's message handler.
      const id = await this.robot.currentMap();
      if (id === undefined) {
        this.noMapAnswer();
      }
    } catch (error) {
      this.log.debug(`Floor check skipped: ${error.message}`);
    } finally {
      this.checkingMap = false;
    }
  }

  /** The robot said which map is current (to us or to another client). */
  async applyCurrentMap(mapId) {
    if (!this.status || !inJob(this.status) || mapId === undefined) {
      return;
    }
    this.mapSilentSince = undefined;
    const guard = this.mapGuard;
    if (!guard) {
      // Started elsewhere (the Narwal app, a schedule, the button): not ours to stop, just say so.
      const expected = this.store.robotMapId;
      if (expected !== undefined && mapId !== expected && this.reportedMap !== mapId) {
        this.reportedMap = mapId;
        this.log.info(`The robot's current map changed during a job: ${this.floorName(expected)} to ${this.floorName(mapId)}.`);
        // The robot ran this job on the other map, so that is where it is now.
        this.store.robotMapId = mapId;
        this.save();
      }
      return;
    }
    this.reportedMap = undefined;
    if (mapId === guard.floorId || this.mapStopped) {
      return;
    }
    this.mapStopped = true;
    this.mapGuard = undefined;
    this.dropTrip();
    this.finishQueue(this.zoneQueue, `the robot placed itself on ${this.floorName(mapId)}`);
    const message = `The Freo placed itself on ${this.floorName(mapId)}, not ${this.floorName(guard.floorId)}`;
    this.log.warn(`${message}: stopping the job. Carry the robot to the starting point of ${this.floorName(guard.floorId)} and start again.`);
    this.robot.stopTask();
    await this.setNotice(ErrorState.UnableToCompleteOperation, message).catch(() => {});
  }

  noMapAnswer() {
    if (!this.mapGuard) {
      return;
    }
    this.mapSilentSince ??= Date.now();
    if (!this.mapSilentWarned && Date.now() - this.mapSilentSince > MAP_SILENT) {
      this.mapSilentWarned = true;
      this.log.warn(`The robot has not said which map it is on for ${Math.round((Date.now() - this.mapSilentSince) / 1000)} s during a job on ${this.floorName(this.mapGuard.floorId)}.`);
    }
  }

  /**
   * The robot's current map, put back on `floor` if the robot itself switched away after the last job
   * ended (the Narwal app's "switch to the main map after cleaning" setting does this on every job, with
   * the robot still on the floor without a base). A change at any other time is left alone, except with
   * `anyTime` (a trip back to the starting point of the floor the robot is known to be on). Returns the
   * map the robot is on afterwards (undefined if it doesn't say).
   */
  async backToFloor(floor, { anyTime = false } = {}) {
    const here = await this.robot.currentMap();
    if (here === undefined || here === floor.id) {
      return here;
    }
    const since = this.robot.currentMapSince;
    if (!anyTime && (since === undefined || this.lastJobEnd === undefined || since < this.lastJobEnd - MAP_SWITCH_SLACK)) {
      return here;
    }
    this.log.debug(`robot switched to ${this.floorName(here)} at the job end (Narwal app setting); switching back to ${floor.name}`);
    try {
      await this.robot.switchMap(floor.id);
      return floor.id;
    } catch (error) {
      this.log.warn(`Could not switch the robot back to ${floor.name} (${error.message}).`);
      return await this.robot.currentMap().catch(() => here);
    }
  }

  // ── The Narwal app's "Automatically switch to the main map after cleaning" ──
  //
  // On a floor without a base the robot would switch to the main map at every job end while still
  // standing upstairs, which breaks the next room and the trip back. So while the plugin works there
  // the setting is turned off, and turned back on afterwards (`store.autoMainMap = 'restore'` is kept
  // in the state file so a restart still restores it). A setting the user had off is never touched.

  /** Run `fn` after the previous setting change. */
  inMainMapOrder(fn) {
    const run = (this.mainMapOps ?? Promise.resolve()).then(fn, fn);
    this.mainMapOps = run.catch(() => {});
    return run;
  }

  /** Turn the setting off for work on `floor` (a floor without a base). Failing is only a warning: backToFloor still copes. */
  holdAutoMainMapOff(floor) {
    return this.inMainMapOrder(async () => {
      try {
        if (floor.hasDock !== false || this.store.autoMainMap === 'restore') {
          return;
        }
        const on = await this.robot.autoMainMap();
        if (on === undefined) {
          this.log.warn('Could not read the robot\'s "switch to the main map after cleaning" setting; carrying on.');
          return;
        }
        if (!on) {
          return; // off already: the user's choice, left alone
        }
        this.store.autoMainMap = 'restore'; // saved first, so a restart in between still turns it back on
        this.save();
        const accepted = await this.robot.setAutoMainMap(false);
        if (!accepted || await this.robot.autoMainMap() !== false) {
          if (await this.robot.autoMainMap() !== false) {
            delete this.store.autoMainMap;
            this.save();
          }
          this.log.warn('Could not turn off the Narwal app\'s "switch to the main map after cleaning" setting; the plugin will switch the map back itself.');
          return;
        }
        this.log.info(`Turned off "switch to the main map after cleaning" while working on ${floor.name}; it comes back on afterwards.`);
      } catch (error) {
        this.log.warn(`Could not change the "switch to the main map after cleaning" setting (${error.message}).`);
      }
    });
  }

  /**
   * Turn the setting back on if the plugin turned it off and nothing of the plugin's is running on that
   * floor. `idleOnly` (on connecting) leaves it while the robot reports a job: the job's end restores it.
   */
  restoreAutoMainMap({ idleOnly = false } = {}) {
    if (this.store.autoMainMap !== 'restore') {
      return Promise.resolve();
    }
    return this.inMainMapOrder(async () => {
      try {
        if (this.store.autoMainMap !== 'restore' || this.zoneQueue || this.trip || (idleOnly && inJob(this.status)) || !this.robot.connected) {
          return;
        }
        if (await this.robot.autoMainMap() !== true) {
          if (!await this.robot.setAutoMainMap(true) || await this.robot.autoMainMap() !== true) {
            this.log.warn('Could not turn the Narwal app\'s "switch to the main map after cleaning" setting back on; trying again later.');
            return;
          }
        }
        delete this.store.autoMainMap;
        this.save();
        this.log.info('Turned "switch to the main map after cleaning" back on.');
      } catch (error) {
        this.log.warn(`Could not restore the "switch to the main map after cleaning" setting (${error.message}); trying again later.`);
      }
    });
  }

  /**
   * Turn stair detection back on once the clean is over: the setting is robot-wide and a floor without
   * stairs has it off for the clean, so a robot carried upstairs afterwards would be left without it.
   * Only asks the robot when the plugin turned it off (`stairsOff`), on connecting (`idleOnly`, which
   * leaves it while the robot reports a job: the job's end restores it) or when `force`d (job ends: the
   * Narwal app or a restart may have left it off). One attempt at a time; failing retries in a minute.
   */
  restoreStairs({ idleOnly = false, force = false } = {}) {
    if (!this.floors.some(f => f.managed && f.stairDetection) || (!idleOnly && !force && !this.stairsOff)) {
      return Promise.resolve();
    }
    if (this.restoringStairs) {
      return this.restoringStairs;
    }
    const busy = () => this.zoneQueue || this.trip || this.starting || inJob(this.status) || !this.robot.connected;
    const run = this.restoringStairs = this.inMainMapOrder(async () => {
      try {
        if (busy()) {
          return;
        }
        if (await this.robot.stairless() === false) {
          this.stairsOff = false;
          return;
        }
        if (busy()) {
          return; // a clean started meanwhile: ensureStairs sets what it needs
        }
        if (!await this.robot.setStairless(false) || await this.robot.stairless() !== false) {
          this.retryStairs('Could not turn stair detection back on after the clean');
          return;
        }
        this.stairsOff = false;
        clearTimeout(this.stairRestoreTimer);
        this.stairRestoreTimer = undefined;
        this.log.info('Stair detection turned back on after the clean.');
      } catch (error) {
        this.retryStairs(`Could not turn stair detection back on (${error.message})`);
      }
    }).finally(() => {
      if (this.restoringStairs === run) {
        this.restoringStairs = undefined;
      }
    });
    return run;
  }

  retryStairs(message) {
    this.stairsOff = true;
    if (this.stairRestoreTimer) {
      return; // already waiting to retry: one warning per cycle
    }
    this.log.warn(`${message}; trying again in a minute.`);
    this.stairRestoreTimer = setTimeout(() => {
      this.stairRestoreTimer = undefined;
      this.restoreStairs();
    }, STAIR_RESTORE_RETRY);
    this.stairRestoreTimer.unref?.();
  }

  floorName(id) {
    return this.floors.find(f => f.id === id)?.name ?? `map ${id}`;
  }

  // ── Errors the plugin puts on the tile (the robot's own errors are `fault`) ──

  async setNotice(matter, message) {
    const notice = this.notice = { matter, message };
    // The Home app hides the vacuum's controls while it is in an error state, so the plugin's own
    // errors clear by themselves; the robot's own errors (`fault`) only clear when the robot clears them.
    clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => {
      if (this.notice === notice) {
        this.clearNotice().catch(() => {});
      }
    }, NOTICE_SHOWN);
    this.noticeTimer.unref?.();
    this.opState = Op.Error;
    this.commandGraceUntil = 0;
    await this.update('rvcOperationalState', {
      operationalState: Op.Error,
      operationalError: { errorStateId: matter, errorStateDetails: message.slice(0, 64) },
    });
  }

  async clearNotice() {
    if (!this.notice) {
      return;
    }
    this.notice = undefined;
    clearTimeout(this.noticeTimer);
    if (!this.fault) {
      await this.showError(this.condition);
    }
  }

  // Conditions are plugin-made errors that stay until what caused them is over (kind 'return': the robot
  // can't get back to its base; 'silent': it has stopped answering). Unlike notices they don't time out.
  // A robot error or a notice is shown first; the condition appears again when those clear.
  async setCondition(kind, matter, message) {
    if (this.condition?.kind === 'return' && kind === 'silent') {
      return; // already showing the more specific message
    }
    this.condition = { kind, matter, message };
    if (!this.fault && !this.notice) {
      this.opState = Op.Error;
      this.commandGraceUntil = 0;
      await this.update('rvcOperationalState', {
        operationalState: Op.Error,
        operationalError: { errorStateId: matter, errorStateDetails: message.slice(0, 64) },
      });
    }
  }

  async clearCondition(kind) {
    if (this.condition?.kind !== kind) {
      return;
    }
    this.condition = undefined;
    if (!this.fault && !this.notice) {
      await this.showError();
    }
  }

  /** Put `error` ({ matter, message }) on the tile, or clear it and show the robot's state again. */
  async showError(error) {
    if (error) {
      this.opState = Op.Error;
      await this.update('rvcOperationalState', {
        operationalState: Op.Error,
        operationalError: { errorStateId: error.matter, errorStateDetails: error.message.slice(0, 64) },
      });
      return;
    }
    this.opState = undefined; // re-evaluate from the next status
    await this.update('rvcOperationalState', { operationalError: { errorStateId: ErrorState.NoError } });
    if (this.status) {
      await this.refresh(this.status);
    }
  }

  async pause() {
    this.ensureConnected();
    this.reapStale();
    if (this.opState !== Op.Running && this.opState !== Op.SeekingCharger) {
      throw new this.matter.status.InvalidInState('The robot is not cleaning');
    }
    if (this.queueGap()) {
      // Between two rooms there is no job to pause: hold the next one until Resume.
      this.log.info('Pausing (between rooms)');
      this.zoneQueue.userPaused = true;
      await this.setOpState(Op.Paused);
      return;
    }
    this.log.info('Pausing');
    this.robot.pause();
    await this.setOpState(Op.Paused);
  }

  async resume() {
    this.ensureConnected();
    this.reapStale();
    if (!this.canResume()) {
      throw new this.matter.status.InvalidInState('The robot has no paused task to resume');
    }
    if (this.queueGap() && this.zoneQueue.userPaused) {
      this.log.info('Resuming (between rooms)');
      this.zoneQueue.userPaused = false;
      await this.clearNotice();
      await this.setOpState(Op.Running);
      this.queueNext();
      return;
    }
    const floor = this.robotFloor();
    if (this.stairPaused && floor) {
      await this.ensureStairs(floor);
    }
    await this.clearNotice();
    await this.holdSecurity();
    this.log.info('Resuming');
    this.robot.resume();
    await this.setOpState(Op.Running);
    await this.update('rvcRunMode', { currentMode: RUN_CLEANING });
  }

  async goHome() {
    this.ensureConnected();
    await this.clearNotice();
    // The tile can be stale (a robot lifted off its base while idle may still look docked), so ask
    // the robot, not the cached state.
    let s = this.status;
    if (Date.now() - (this.lastStatusAt ?? 0) > FRESH_STATUS) {
      const asked = this.lastStatusAt ?? 0;
      this.robot.wake();
      for (let waited = 0; waited < STATUS_WAIT && (this.lastStatusAt ?? 0) === asked; waited += 250) {
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      s = (this.lastStatusAt ?? 0) !== asked ? this.status : undefined;
    }
    if (s && isDocked(s)) {
      this.log.info('Already on its base; nothing to do.');
      return;
    }
    // A floor without a base station: the robot refuses to recall, so end the clean and send it to the
    // map's starting point as a small zone clean (see tripToStart).
    const here = this.robotFloor();
    if (here && here.hasDock === false) {
      this.reapStale();
      if (this.trip) {
        this.log.info('Return to dock: the robot is already on its way back to the starting point.');
        return;
      }
      await this.clearNotice();
      this.finishQueue(this.zoneQueue, 'Return to dock');
      // Not awaited: the Home app gets its answer at once; the tile follows the trip and shows a failure.
      this.tripToStart(here, { halted: false })
        .catch(error => this.log.warn(`Return to the starting point failed (${error.message}).`));
      return;
    }
    // Still no status: send it anyway. Recalling a robot that is already on its base is assumed harmless.
    // The trip home passes the motion sensors like a clean does, so it needs the security system's
    // OK first, and the robot stays put without it. Not needed while this robot's hold is still in
    // force (a job that got the OK, not released since), or for a trip home the security plugin
    // ordered (halt).
    const holdActive = this.store.securityHeld && !this.releasing && !this.store.securityStopped;
    if (this.security && !this.homeBound && !holdActive) {
      this.recalling = !inJob(s);
      try {
        await this.holdSecurity('returning to the base');
      } catch (error) {
        this.recalling = false;
        throw error;
      }
    }
    await this.clearNotice();
    this.finishQueue(this.zoneQueue, 'Return to dock');
    this.log.info(this.fault ? `Returning to dock (the robot reports: ${this.fault.message})` : 'Returning to dock');
    this.robot.returnToDock();
    await this.setOpState(Op.SeekingCharger);
    await this.update('rvcRunMode', { currentMode: RUN_IDLE });
    this.checkRecall();
  }

  // ── Return to dock on a floor without a base station ──
  //
  // The Freo refuses `supply/recall` on such a map (reply code 15) and the app has no "go to" command,
  // so the clean is ended at once and the robot is sent to the map's starting point (the "P" in the
  // Narwal app, about (0, 0) in the robot's frame) as a tiny zone clean: a square of about 30 cm there at
  // quiet suction, vacuum mode, one pass. That is a movement, so it is checked like a start (current map,
  // stair detection, the security hold; fail closed) and, if anything fails, the robot stays where the
  // clean stopped. Phases: ending (force_end sent; waiting for the job to go), starting (zone sent;
  // waiting for the job), running (waiting for the job to end: the trip is over, the tile shows Stopped).

  /**
   * End the clean and send the robot to the starting point of `floor`.
   * @param {object} opts
   * @param {boolean} opts.halted ordered by the security plugin (halt): no hold is asked for
   */
  async tripToStart(floor, { halted }) {
    const trip = this.trip = { floor, halted, phase: 'ending', since: Date.now() };
    trip.watch = setInterval(() => this.tripWatch(trip), TRIP_WATCH);
    trip.watch.unref?.();
    const fail = (why, tile = why) => this.tripFail(trip, why, tile);
    this.log.info(`Returning to the starting point on ${floor.name}: ending the clean`
      + `${halted ? ' (the security system is arming Away)' : ''}; ${floor.name} has no base station.`);
    await this.setOpState(Op.SeekingCharger);
    await this.update('rvcRunMode', { currentMode: RUN_IDLE });
    await this.update('serviceArea', { currentArea: null }).catch(() => {});
    // 1. End the clean, before anything else is sent.
    if (inJob(this.status)) {
      const reply = await this.robot.stopTask();
      if (this.trip !== trip) {
        return;
      }
      if (!reply.ok && !reply.timedOut) {
        return fail('the robot refused to end the clean', 'the robot wouldn\'t end the clean');
      }
      for (let waited = 0; inJob(this.status) && waited < TRIP_LEAVE_WAIT && this.trip === trip; waited += 250) {
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (this.trip !== trip) {
        return;
      }
      if (inJob(this.status)) {
        return fail('the robot still reports a job after the clean was ended', 'the robot didn\'t end the clean');
      }
    }
    // 2. The checks of a start.
    try {
      if (!this.robot.connected) {
        return await fail('not connected to the Narwal cloud', 'lost the robot');
      }
      const current = await this.backToFloor(floor, { anyTime: true });
      if (this.trip !== trip) {
        return;
      }
      if (current !== floor.id) {
        const where = current === undefined ? 'the robot didn\'t say which map it is on' : `the robot is on ${this.floorName(current)}`;
        return await fail(where, current === undefined ? 'unknown map' : `robot is on ${this.floorName(current)}`);
      }
      await this.ensureStairs(floor);
      const holdActive = this.store.securityHeld && !this.releasing && !this.store.securityStopped;
      if (!halted && !holdActive) {
        await this.holdSecurity('returning to the starting point');
      }
      await this.holdAutoMainMapOff(floor);
      if (this.trip !== trip) {
        return;
      }
    } catch (error) {
      return fail(error.message);
    }
    if (this.trip !== trip) {
      return;
    }
    // 3. The zone: a small square around the starting point.
    const shape = await this.robot.mapShape();
    if (this.trip !== trip) {
      return;
    }
    if (!shape || shape.id !== floor.id) {
      return fail('could not read the map', 'couldn\'t read the map');
    }
    const zone = spotOutline(shape, { x: floor.start.x / MAP_UNIT, y: floor.start.y / MAP_UNIT });
    if (!zone) {
      return fail('the map has no floor', 'no floor on the map');
    }
    if (inJob(this.status)) {
      return fail('the robot started a job meanwhile', 'a job started meanwhile');
    }
    this.log.debug(`Starting point of ${floor.name}: cell (${Math.round(floor.start.x / MAP_UNIT)}, ${Math.round(floor.start.y / MAP_UNIT)}); `
      + `zone of ${zone.cells} cells around (${zone.cell.join(', ')})`);
    this.store.robotMapId = floor.id;
    this.save();
    this.armMapGuard(floor.id);
    trip.phase = 'starting';
    trip.sentAt = Date.now();
    trip.timer = setTimeout(() => {
      fail(`the robot didn't set off within ${TRIP_START_WAIT / 1000} s`, 'the robot didn\'t set off');
    }, TRIP_START_WAIT);
    trip.timer.unref?.();
    const reply = await this.robot.startZones([zone], NarwalMode.VACUUM, {}, { passes: 1, suction: Suction.quiet });
    if (this.trip !== trip) {
      return;
    }
    if (!reply.ok && !reply.timedOut) {
      return fail('the robot refused to go', 'the robot refused');
    }
  }

  /** A trip that couldn't be carried out: the robot stays where it is, the tile shows Stopped with the error on top. */
  async tripFail(trip, why, tile = why) {
    if (this.trip !== trip) {
      return;
    }
    this.log.warn(`Not going back to the starting point of ${trip.floor.name}: ${why}. The robot stays where it is.`);
    await this.endTrip(trip, why, { notice: `Couldn't return: ${tile}`, code: ErrorState.FailedToFindChargingDock });
  }

  /**
   * End a trip, whatever the reason: forget it, clear what it held (map guard, command grace, the
   * "job seen" flag so the security hold is released), put the tile where the robot really is (Docked
   * in the base, else Stopped; an error on the robot stays on the tile) and let the Narwal app's
   * "switch to the main map" setting come back on. `notice` puts a plugin error on the tile.
   */
  async endTrip(trip, why, { notice, code } = {}) {
    if (!trip || this.trip !== trip) {
      return;
    }
    this.log.debug(`Trip to the starting point of ${trip.floor.name} over (${why})`);
    this.dropTrip();
    this.mapGuard = undefined;
    this.commandGraceUntil = 0;
    this.jobSeen = true;
    this.opState = undefined; // re-evaluated from the robot's status below
    if (notice) {
      // Stopped first, with the error on top.
      await this.setOpState(Op.Stopped, false).catch(() => {});
      await this.update('rvcRunMode', { currentMode: RUN_IDLE }).catch(() => {});
      await this.setNotice(code ?? ErrorState.UnableToCompleteOperation, notice).catch(() => {});
    }
    if (this.status) {
      await this.refresh(this.status).catch(() => {});
    } else {
      await this.setOpState(Op.Stopped, false).catch(() => {});
      await this.update('rvcRunMode', { currentMode: RUN_IDLE }).catch(() => {});
    }
  }

  /** Every few seconds while a trip is active: end it if it can't be going anywhere. */
  tripWatch(trip) {
    if (this.trip !== trip) {
      clearInterval(trip.watch);
      return;
    }
    const now = Date.now();
    const s = this.status;
    if (isDocked(s) && trip.phase !== 'ending') {
      this.endTrip(trip, 'the robot is on its base');
    } else if (trip.phase === 'ending' && now - trip.since > TRIP_MAX_ENDING) {
      this.tripFail(trip, 'the checks before going took too long', 'it took too long');
    } else if (trip.phase === 'starting' && now - trip.sentAt > TRIP_START_WAIT) {
      this.tripFail(trip, `the robot didn't set off within ${TRIP_START_WAIT / 1000} s`, 'the robot didn\'t set off');
    } else if (trip.phase === 'running' && !inJob(s) && now - (trip.idleSince ?? now) > TRIP_IDLE_WAIT) {
      this.log.info(`The robot has been idle for ${TRIP_IDLE_WAIT / 1000} s on the way back to the starting point of ${trip.floor.name}; treating the trip as over.`);
      this.endTrip(trip, 'the robot stopped without a report');
    }
  }

  /** A trip or room queue that is not really running any more (nothing in the robot's state backs it) is over. */
  reapStale() {
    const trip = this.trip;
    if (trip) {
      const s = this.status;
      const now = Date.now();
      const stale = isDocked(s)
        || (trip.phase === 'running' && !inJob(s) && now - (trip.idleSince ?? now) > 5000)
        || (trip.phase === 'starting' && now - trip.sentAt > TRIP_START_WAIT)
        || (trip.phase === 'ending' && now - trip.since > TRIP_MAX_ENDING);
      if (stale) {
        this.log.info('The trip back to the starting point was no longer running; dropping it.');
        this.endTrip(trip, 'stale');
      }
    }
    const q = this.zoneQueue;
    if (q && (isDocked(this.status)
      || (q.phase === 'starting' && Date.now() - q.sentAt > ZONE_START_WAIT))) {
      this.finishQueue(q, 'the room queue was no longer running');
    }
  }

  /** A new clean replaces a trip that is still under way: end the robot's trip job first. */
  async replaceTrip() {
    this.log.info('Starting a clean while the robot was on its way back to the starting point: ending the trip.');
    const wasRunning = inJob(this.status);
    this.dropTrip();
    this.mapGuard = undefined;
    this.commandGraceUntil = 0;
    this.jobSeen = true;
    if (wasRunning) {
      this.robot.stopTask();
      for (let waited = 0; inJob(this.status) && waited < TRIP_LEAVE_WAIT; waited += 250) {
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
    this.opState = undefined;
  }

  /** Follow the robot's job state through a trip (see tripToStart). */
  tripFollow(previous, s) {
    const trip = this.trip;
    if (trip.phase === 'running') {
      trip.idleSince = inJob(s) ? undefined : (trip.idleSince ?? Date.now());
    }
    if (trip.phase === 'starting' && inJob(s)) {
      trip.phase = 'running';
      clearTimeout(trip.timer);
    } else if (trip.phase === 'running' && previous && inJob(previous) && !inJob(s)) {
      const secs = Math.round((Date.now() - trip.since) / 1000);
      this.dropTrip();
      this.commandGraceUntil = 0;
      if (this.homeBound?.noBase) {
        this.arrivedHome();
      } else {
        this.log.info(`The robot is back at the starting point of ${trip.floor.name} after ${secs} s.`);
      }
    }
  }

  /** Forget a trip (nothing is sent). */
  dropTrip() {
    if (this.trip) {
      clearTimeout(this.trip.timer);
      clearInterval(this.trip.watch);
      // Its end report may still arrive.
      this.lastTrip = { sentAt: this.trip.sentAt, until: Date.now() + 2 * REPORT_WAIT };
      this.trip = undefined;
      this.restoreAutoMainMap();
      this.restoreStairs({ force: true });
    }
  }

  /** Whether a clean report belongs to a trip's zone job (not to the clean that was ended). */
  tripReport(r) {
    const trip = this.trip ?? (Date.now() < (this.lastTrip?.until ?? 0) ? this.lastTrip : undefined);
    return Boolean(trip?.sentAt && r.start !== undefined && r.start * 1000 >= trip.sentAt - REPORT_SKEW);
  }

  /**
   * The Freo never acknowledges commands, and one with an error to clear (say, a brush jammed and
   * then freed) may ignore Return to dock. Check that it set off, and say so if it didn't.
   */
  checkRecall() {
    clearTimeout(this.recallTimer);
    this.recallTimer = setTimeout(async () => {
      const s = this.status;
      if (!s || s.returning || s.atBase || isDocked(s)) {
        return;
      }
      this.log.warn('The robot didn\'t start back to its base'
        + (this.fault ? ` (it reports: ${this.fault.message}). Clear the error with the robot's button or in the Narwal app, then try again.`
          : '. Check it isn\'t stuck, then try again.'));
      // Show what it's really doing rather than "returning".
      this.commandGraceUntil = 0;
      this.opState = undefined;
      await this.refresh(s).catch(() => {});
    }, RECALL_CHECK);
    this.recallTimer.unref?.();
  }

  // ── Vacation mode (a set number of cleans, then none or vacuum only) ──

  /** The vacation switch changed (or was read for the first time). */
  setVacation(on) {
    if (on && !this.store.vacation) {
      this.store.vacation = { since: Date.now(), cleans: 0 };
      const then = this.vacationAfter === 'vacuum' ? 'vacuum only' : 'no cleaning';
      this.log.info(`Vacation mode on: ${this.vacationCleans ? `the next ${this.vacationCleans === 1 ? 'clean runs'
        : `${this.vacationCleans} cleans run`} as usual, then ${then}` : then} until it's off.`);
    } else if (!on && this.store.vacation) {
      delete this.store.vacation;
      this.log.info('Vacation mode off: cleaning as usual.');
    } else {
      return;
    }
    this.save();
  }

  /** A job started (from anywhere): under vacation mode, it counts toward the allowed cleans. */
  vacationJob() {
    const vacation = this.store.vacation;
    if (!vacation) {
      return;
    }
    vacation.cleans = (vacation.cleans ?? 0) + 1;
    this.save();
    if (vacation.cleans === this.vacationCleans) {
      this.log.info(`Vacation mode: this is the last clean allowed as usual; after it, ${this.vacationAfter === 'vacuum'
        ? 'cleans vacuum only' : 'cleans are refused'} until vacation mode is off.`);
    }
  }

  /** The mode to start in: as chosen, or (allowed cleans used up) refused or switched to vacuuming. */
  vacationMode(mode) {
    const vacation = this.store.vacation;
    if (!vacation || (vacation.cleans ?? 0) < this.vacationCleans) {
      return mode;
    }
    const since = new Date(vacation.since).toLocaleString();
    if (this.vacationAfter !== 'vacuum') {
      this.log.info(`Vacation mode (on since ${since}): not cleaning; cleans start again when it's turned off.`);
      throw new this.matter.status.InvalidInState('Vacation mode: no more cleaning');
    }
    if (mode.narwal === NarwalMode.VACUUM) {
      return mode;
    }
    // Same intensity: Mop / Vacuum and Mop Quick -> Vacuum Quick, and so on.
    const key = mode.key.replace(/^(mop|both)/, 'vacuum');
    const vacuum = this.modes.find(m => m.key === key) ?? this.modes.find(m => m.key === 'vacuum');
    this.log.info(`Vacation mode (on since ${since}): vacuuming only, ${vacuum.label} instead of ${mode.label}.`);
    return vacuum;
  }

  // ── Security hold (Away -> Stay while the robot is out) ──

  /**
   * Before the robot moves: if the security system is armed Away, have it switched to Stay so
   * the motion sensors don't set it off. Refuses the command when that can't be done, because
   * cleaning under Away means a false alarm (and a monitoring call). A trip home from off the base
   * moves past the sensors too, so it's refused the same way (`what` names it in the log).
   */
  async holdSecurity(what = 'cleaning') {
    if (!this.security) {
      return;
    }
    clearTimeout(this.releaseTimer);
    // Moving again on purpose: a pending "did the halt's pause land?" check must not pause it again.
    clearTimeout(this.haltTimer);
    this.cancelHome();
    let result;
    try {
      result = await this.security.hold();
    } catch (error) {
      this.log.error(`Not ${what}: could not check the security system (${error.message}).`);
      throw new this.matter.status.Busy(`Security system unreachable: ${error.message}`.slice(0, 64));
    }
    if (!result.ok) {
      this.log.warn(`Not ${what}: ${result.reason ?? 'the security system said no'}.`);
      throw new this.matter.status.InvalidInState(`Security system: ${result.reason ?? 'not safe to clean'}`);
    }
    this.securityChecked = true;
    this.unapproved = false;
    this.heldAt = Date.now();
    if (this.store.securityStopped) {
      delete this.store.securityStopped;
      this.save();
    }
    this.jobSeen = inJob(this.status);
    // securityHeld: the security plugin knows this robot is out ('out'), and holds Stay for it (true).
    if (!this.store.securityHeld || (result.held && this.store.securityHeld === 'out')) {
      if (result.held) {
        this.log.info(`Security system switched from Away to Stay while the robot is ${this.recalling ? 'on its way back' : 'cleaning'}.`);
      }
      this.store.securityHeld = result.held ? true : 'out';
      this.save();
    }
  }

  /**
   * Follow cleaning jobs for the security hold: check when a job starts (also one started from the
   * Narwal app), release when it ends. The robot reports the job through its dock visits.
   */
  securityFollow(active) {
    if (!this.security) {
      return;
    }
    if (active) {
      this.jobSeen = true;
      // Released because the robot stopped: applyPose pauses and asks again once it moves. Sent home
      // by the security plugin: no new hold on the way. Sent home from the Home app: the hold was
      // already granted before it set off.
      if (!this.securityChecked && !this.store.securityStopped && !this.homeBound && !this.recalling && !this.trip
        && !this.unapproved && !this.checking) {
        const st = this.status;
        if (this.store.securityHeld) {
          // Restarted mid-job with the hold on record: it was approved before the restart.
          this.securityChecked = true;
        } else if (st?.base !== 1 && (st?.base || isDocked(st))) {
          // Still in the base: whatever it reports there (the base's own work, the end of a trip
          // home) isn't moving past sensors. A job that really starts is caught as it leaves.
        } else {
          // Started from the Narwal app, its schedule or the robot's button, or found running at
          // startup: it must not keep moving without the security system's OK.
          this.checkBeforeMoving('Cleaning started outside the Home app', 'cleaning started outside the Home app')
            .catch(error => this.log.warn(`Could not pause the robot (${error.message}).`));
        }
      }
      return;
    }
    if (this.zoneQueue || this.trip) {
      return; // more rooms to clean, or the trip to the starting point: the hold stays until it's over
    }
    if (this.jobSeen) {
      // The trip home is over (right after the command the robot still reports idle for a moment).
      this.recalling = false;
    }
    this.unapproved = false;
    if (this.store.securityStopped) {
      delete this.store.securityStopped;
      this.save();
    }
    if (!this.securityChecked && !this.store.securityHeld) {
      return;
    }
    // Right after a start the robot still reports idle for a moment; release only once the job has
    // been seen, or if it never got going.
    if (!this.jobSeen && Date.now() - (this.heldAt ?? 0) < START_TIMEOUT) {
      return;
    }
    if (!this.releasing && !this.releaseTimer) {
      this.releaseSecurity();
    }
  }

  /**
   * The security plugin is arming Away while this robot is out. The plugin has already let go of
   * the hold; moving again (a resume) asks for a new one.
   * @param {number} [armAt] when the motion sensors arm (ms; the end of the exit delay). The robot
   *   heads back to its base if it can be in `HOME_MARGIN` before then, and pauses wherever it is if
   *   it isn't. Without it (already armed), or too far away: pause where it is now.
   */
  async halt(armAt) {
    this.finishQueue(this.zoneQueue, 'the security system is arming Away');
    this.store.securityHeld = false;
    clearTimeout(this.haltTimer);
    this.cancelHome();
    if (!inJob(this.status) && !this.trip) {
      this.save();
      return { halted: false, reason: 'not cleaning' };
    }
    if (this.status.paused && !this.trip) {
      this.store.securityStopped = true;
      this.save();
      this.haltSettleUntil = Date.now() + HALT_SETTLE;
      this.log.info('Security system arming Away; the robot is already paused, so it stays where it is.');
      return { halted: true };
    }
    const deadline = armAt - HOME_MARGIN;
    const left = deadline - Date.now();
    if (Number.isFinite(left) && left > 0 && !this.status.atBase) {
      // Without a recent position, try anyway: the deadline still pauses it in time. On a floor with
      // no base station the trip ends at the map's starting point, not at the base (about (0, 0)).
      const floor = this.robotFloor();
      const noBase = Boolean(floor && !floor.hasDock);
      const goal = noBase ? floor.start : { x: 0, y: 0 };
      const pose = Date.now() - (this.poseAt ?? 0) <= POSE_GAP ? this.pose : undefined;
      const distance = pose && Math.hypot(pose.x - goal.x, pose.y - goal.y);
      const needs = HOME_OVERHEAD + (distance === undefined ? 0 : distance / RETURN_SPEED * 1000);
      if (needs <= left) {
        return this.sendHome(deadline, distance, noBase);
      }
      this.log.warn(`Security system arming Away: the robot can't be back at its ${noBase ? 'starting point' : 'base'} within ${Math.round(left / 1000)} s`
        + (distance === undefined ? '.' : ` (${distance.toFixed(1)} m away).`));
    }
    const why = armAt > Date.now() ? 'Security system arming Away' : 'Security system armed Away';
    // A floor without a base station: end the clean and stay (a paused clean there would only be resumed).
    return this.robotFloor()?.hasDock === false ? this.stopForSecurity(why) : this.pauseForSecurity(why);
  }

  /**
   * Back to the base before the motion sensors arm; pause wherever it is at `deadline`. On a floor with
   * no base station (`noBase`) "home" is the map's starting point (see tripToStart), the trip is over
   * when its job ends, and at the deadline the job is ended where the robot is.
   */
  sendHome(deadline, distance, noBase = false) {
    const at = new Date(deadline).toLocaleTimeString();
    this.log.warn(`Security system arming Away: sending the robot back to its ${noBase ? 'starting point' : 'base'}${distance === undefined ? ''
      : ` (${distance.toFixed(1)} m away)`}; if it isn't in by ${at}, it pauses where it is.`);
    this.homeBound = { since: Date.now(), distance, noBase };
    if (noBase) {
      // A trip from the Home app may already be under way: it carries on, now with the deadline.
      if (this.trip) {
        this.trip.halted = true;
      } else {
        this.tripToStart(this.robotFloor(), { halted: true })
          .catch(error => this.log.warn(`Return to the starting point failed (${error.message}).`));
      }
    } else {
      this.robot.returnToDock();
      this.setOpState(Op.SeekingCharger).catch(() => {});
      this.update('rvcRunMode', { currentMode: RUN_IDLE }).catch(() => {});
      // The Freo never acknowledges commands: check it's on its way, and try once more.
      this.haltTimer = setTimeout(() => {
        const s = this.status;
        if (this.homeBound && inJob(s) && !s.returning && !s.atBase) {
          this.log.warn('The robot did not head back; trying again.');
          this.robot.returnToDock();
        }
      }, HALT_CHECK);
    }
    this.homeTimer = setTimeout(() => {
      this.homeTimer = undefined;
      if (this.homeBound && !this.arrived(this.status)) {
        this.homeBound = undefined;
        if (noBase) {
          this.stopForSecurity('Not back at the starting point in time');
        } else {
          this.pauseForSecurity('Not back at the base in time');
        }
        this.reportIn();
      }
    }, deadline - Date.now());
    return { halted: true, returning: true };
  }

  /**
   * A robot sent home has arrived: in the base. (On a floor without a base station the trip's own job
   * ending is the arrival: see tripFollow.)
   */
  arrived(s) {
    return Boolean(s && (s.atBase || isDocked(s)));
  }

  /** Sent home and now in the base: log how long it took. */
  arrivedHome() {
    const { since, distance, noBase } = this.homeBound;
    const secs = Math.round((Date.now() - since) / 1000);
    this.log.info(`The robot is back at its ${noBase ? 'starting point' : 'base'} after ${secs} s${distance === undefined ? '' : ` from ${distance.toFixed(1)} m away`
      + (secs > 0 ? ` (${(distance / secs).toFixed(2)} m/s straight-line)` : '')}.`);
    this.cancelHome();
    this.reportIn();
  }

  /** Tell the security plugin the robot is in (or stopped), so it needn't wait for it to arm Away. */
  reportIn() {
    this.security?.release().catch(error => this.log.warn(`Could not tell the security system the robot is in (${error.message}).`));
  }

  cancelHome() {
    clearTimeout(this.homeTimer);
    this.homeTimer = undefined;
    this.homeBound = undefined;
  }

  /**
   * Stop where it is on a floor without a base station: end the job (a trip to the starting point
   * included), since there is no base to dock at and a paused job would only be resumed.
   */
  async stopForSecurity(why) {
    this.dropTrip();
    this.mapGuard = undefined;
    this.haltSettleUntil = Date.now() + HALT_SETTLE;
    this.log.warn(`${why}: ending the clean where the robot is.`);
    this.robot.stopTask();
    await this.setOpState(Op.Stopped).catch(() => {});
    await this.update('rvcRunMode', { currentMode: RUN_IDLE }).catch(() => {});
    // The Freo never acknowledges commands: check the job ended, and try once more.
    clearTimeout(this.haltTimer);
    this.haltTimer = setTimeout(() => {
      if (inJob(this.status)) {
        this.log.warn('The robot did not stop; trying again.');
        this.robot.stopTask();
      }
    }, HALT_CHECK);
    return { halted: true };
  }

  /** Stop where it is (pause, not dock, so it doesn't drive through the house). */
  async pauseForSecurity(why) {
    this.store.securityStopped = true;
    this.save();
    this.haltSettleUntil = Date.now() + HALT_SETTLE;
    this.log.warn(`${why}: pausing the robot where it is.`);
    this.robot.pause();
    await this.setOpState(Op.Paused).catch(() => {});
    // The Freo never acknowledges commands: check its status, and try once more.
    clearTimeout(this.haltTimer);
    this.haltTimer = setTimeout(() => {
      const s = this.status;
      if ((inJob(s) || s?.returning) && !s.paused && !s.atBase) {
        this.log.warn('The robot did not pause; trying again.');
        this.robot.pause();
      }
    }, HALT_CHECK);
    return { halted: true };
  }

  /**
   * The robot is moving without the security system's OK (a job from the Narwal app, its schedule or
   * the robot's button; or moving again after the stop release): ask for the hold straight away (the
   * answer takes about a second, while the robot is still by its base or where it stopped). With the
   * OK it carries on; if the security system can't be reached or says no, pause it and leave it
   * paused (once per start: a Home app Resume goes through resume() and asks again).
   * @param {string} message what was noticed (log)
   * @param {string} how what to tell the user the robot did
   * @param {string} [next] what the user can do once the security system allows it (log)
   */
  async checkBeforeMoving(message, how, next = 'Resume it from the Home app once the security system allows it.') {
    if (this.checking) {
      return;
    }
    this.checking = true;
    try {
      this.log.info(`${message}; checking the security system.`);
      try {
        await this.holdSecurity('cleaning');
        return;
      } catch (error) {
        this.unapproved = true;
        this.robot.pause();
        await this.setOpState(Op.Paused).catch(() => {});
        await this.update('rvcRunMode', { currentMode: RUN_CLEANING }).catch(() => {});
        this.log.warn(`Paused: ${how}, and the security system didn't give the OK (${error.message}). `
          + next);
        // The Freo never acknowledges commands: check the pause landed, and try once more.
        clearTimeout(this.haltTimer);
        this.haltTimer = setTimeout(() => {
          const s = this.status;
          if (this.unapproved && (inJob(s) || seekingBase(s)) && !s.paused && !s.atBase) {
            this.log.warn('The robot did not pause; trying again.');
            this.robot.pause();
          }
        }, HALT_CHECK);
      }
    } finally {
      this.checking = false;
    }
  }

  /** Log the robot's end-of-clean report once (the broker may deliver it again). */
  applyCleanReport(r) {
    const key = `${r.start}-${r.end}`;
    if (r.start !== undefined && key === this.lastReport) {
      return;
    }
    this.lastReport = key;
    if (this.tripReport(r)) {
      this.log.debug(`Trip to the starting point: ${formatCleanReport(r)}`);
      return;
    }
    this.log[NORMAL_END_REASONS.includes(r.reason) ? 'info' : 'warn'](formatCleanReport(r));
    this.queueReport(r);
  }

  /**
   * Robot position during a job. A robot that has stood still off the base for
   * `securityStoppedMinutes` (stuck, lifted, paused…) can't set off motion sensors: release the
   * hold, and hold again as soon as it moves or turns. Any change counts, re-localisation jumps
   * included, and a gap in the positions restarts the wait: both only keep Stay longer.
   */
  applyPose(p) {
    this.lastPose = { x: p.x, y: p.y, at: Date.now() };
    if (!this.security) {
      return;
    }
    const now = Date.now();
    this.pose = p;
    const anchor = this.stillFrom;
    const turn = anchor && Math.abs(Math.atan2(Math.sin(p.heading - anchor.heading), Math.cos(p.heading - anchor.heading)));
    const moved = anchor !== undefined && (Math.hypot(p.x - anchor.x, p.y - anchor.y) > STILL_TOLERANCE || turn > TURN_TOLERANCE);
    const counting = inJob(this.status) && !this.status.atBase && now - (this.poseAt ?? 0) <= POSE_GAP;
    // Coasting to a stop right after a halt isn't moving again.
    if (now < (this.haltSettleUntil ?? 0)) {
      this.poseAt = now;
      this.stillFrom = { x: p.x, y: p.y, heading: p.heading, at: now };
      return;
    }
    this.poseAt = now;
    if (!anchor || moved || !counting) {
      this.stillFrom = { x: p.x, y: p.y, heading: p.heading, at: now };
    }
    // Sent home by the security plugin: driving there isn't a reason to hold again.
    if (!inJob(this.status) || this.homeBound || this.trip) {
      return;
    }
    if (this.store.securityStopped) {
      if (moved) {
        delete this.store.securityStopped;
        this.save();
        this.checkBeforeMoving('Robot moving again', 'it started moving again').catch(() => {});
      }
      return;
    }
    if (this.isStopped() && this.store.securityHeld && !this.releasing && !this.releaseTimer) {
      this.releaseSecurity(true);
    }
  }

  /** Stood still off the base, with fresh positions, for `securityStoppedMinutes`. */
  isStopped() {
    const now = Date.now();
    return this.securityStoppedMinutes > 0 && this.stillFrom !== undefined && now - (this.poseAt ?? 0) <= POSE_GAP
      && now - this.stillFrom.at >= this.securityStoppedMinutes * 60 * 1000;
  }

  /** @param {boolean} [stopped] release although the job is still open, because the robot stopped moving */
  async releaseSecurity(stopped = false) {
    this.releaseTimer = undefined;
    if (inJob(this.status) && !(stopped && this.isStopped())) {
      return;
    }
    if (!stopped) {
      this.securityChecked = false;
      this.jobSeen = false;
    }
    if (!this.store.securityHeld) {
      return;
    }
    const why = stopped ? `Robot hasn't moved for ${this.securityStoppedMinutes} min` : 'Cleaning finished';
    const held = this.store.securityHeld;
    this.releasing = true;
    try {
      const result = await this.security.release();
      this.store.securityHeld = false;
      if (stopped) {
        this.store.securityStopped = true;
      }
      this.save();
      if (result.released) {
        this.log.info(`${why}: security system set to Away again.`);
      } else {
        // Nothing to say if the system wasn't Away when the robot set off.
        this.log[held === 'out' ? 'debug' : 'info'](`${why}: security system left as it is (${result.state ?? 'changed while cleaning, or still held for another robot'}).`);
      }
    } catch (error) {
      this.log.warn(`Could not set the security system back to Away (${error.message}); retrying in 2 min.`);
      this.releaseTimer = setTimeout(() => this.releaseSecurity(stopped), 2 * 60 * 1000);
    } finally {
      this.releasing = false;
    }
  }

  async setOpState(state, fromCommand = true) {
    this.opState = state;
    if (fromCommand) {
      // The robot keeps reporting its old state for a second or two after a command.
      this.commandGraceUntil = Date.now() + 8000;
    }
    await this.update('rvcOperationalState', { operationalState: state });
  }

  // ── State from the robot ──

  async applyStatus(s) {
    this.lastStatusAt = Date.now();
    // Kept across restarts: a robot last seen away from its base that never answers again ran flat.
    const away = s.base === 1 || (inJob(s) && !s.atBase);
    if (this.store.lastSeenAway !== away) {
      this.store.lastSeenAway = away;
      this.save();
    }
    this.silence = undefined;
    if (this.condition?.kind === 'silent') {
      this.log.info('The Freo is responding again.');
      this.condition = undefined;
      if (!this.fault && !this.notice) {
        this.opState = undefined;
        await this.update('rvcOperationalState', { operationalError: { errorStateId: ErrorState.NoError } });
      }
    }
    await this.setError(s.code);
    await this.refresh(s);
  }

  /** Time how long a return to the base takes (see RETURN_DEFAULT); learn from the ones that finish. */
  followReturn(s) {
    const r = this.ret;
    const heading = inJob(s) && s.returning && !s.paused && !s.atBase && !this.trip && this.robotFloor()?.hasDock !== false;
    if (!r) {
      if (heading) {
        const pose = this.lastPose && Date.now() - this.lastPose.at <= RETURN_POSE_FRESH ? this.lastPose : undefined;
        this.ret = { since: Date.now(), distance: pose && Math.hypot(pose.x, pose.y) };
      }
      return;
    }
    if (s.atBase || isDocked(s)) {
      this.ret = undefined;
      this.clearCondition('return').catch(() => {});
      if (!r.warned) {
        this.learnReturn(r);
      }
    } else if (!heading) {
      this.ret = undefined; // stopped, paused, cleaning again: no longer on its way
      this.clearCondition('return').catch(() => {});
    }
  }

  learnReturn({ since, distance }) {
    const duration = Date.now() - since;
    if (duration > RETURN_MAX_SAMPLE) {
      return;
    }
    const returns = this.store.returns ??= { perMetre: [], seconds: [] };
    const keep = (list, value) => list.push(value) && list.splice(0, Math.max(0, list.length - RETURN_SAMPLES));
    keep(returns.seconds, Math.round(duration / 1000));
    if (distance !== undefined && distance >= RETURN_MIN_DISTANCE && duration > HOME_OVERHEAD) {
      keep(returns.perMetre, Number(((duration - HOME_OVERHEAD) / 1000 / distance).toFixed(2)));
    }
    this.save();
    this.log.debug(`Back at its base after ${Math.round(duration / 1000)} s`
      + (distance === undefined ? '' : ` from ${distance.toFixed(1)} m away`)
      + `; limit for the next return ${Math.round(returnLimit(returns, distance) / 1000)} s`);
  }

  /** Every WATCH_TICK: a return that takes too long, a robot that has stopped answering. Timer-driven, since statuses may stop. */
  async watch() {
    const now = Date.now();
    const r = this.ret;
    if (r && !r.warned && now - r.since > returnLimit(this.store.returns, r.distance)) {
      r.warned = true;
      this.log.warn(`The Freo hasn't reached its base after ${Math.round((now - r.since) / 60000)} min. `
        + 'Is the base station plugged in, and is the way to it clear?');
      await this.setCondition('return', ErrorState.FailedToFindChargingDock, "Hasn't reached its base. Is the base plugged in?");
    }
    if (!this.robot.connected) {
      return;
    }
    const s = this.status;
    // A docked robot may sleep; only one away from its base (or never heard from) is worth worrying about.
    if (s && !(s.base === 1 || (inJob(s) && !s.atBase))) {
      return;
    }
    const since = Math.max(this.lastStatusAt ?? 0, this.readyAt ?? 0, this.connectedAt ?? 0);
    const sil = this.silence;
    if (!sil) {
      if (now - since > (s ? ROBOT_SILENT : STARTUP_SILENT)) {
        this.silence = { wokeAt: now };
        this.robot.wake();
      }
    } else if (now - sil.wokeAt > SILENT_RECHECK && !sil.warned) {
      sil.warned = true;
      if (s) {
        this.log.warn('The Freo has stopped responding while away from its base. Its battery may be flat: put it back on the base.');
        await this.setCondition('silent', ErrorState.LowBattery, 'Not responding away from its base. Battery flat?');
      } else {
        const flat = this.store.lastSeenAway === true; // last seen off its base before the restart
        this.log.warn(flat
          ? "The Freo hasn't answered since Homebridge started and was last seen away from its base. Its battery may be flat: put it back on the base."
          : "The Freo hasn't answered since Homebridge started. Is it on, charged and online?");
        await this.setCondition('silent', flat ? ErrorState.LowBattery : ErrorState.UnableToCompleteOperation,
          flat ? 'Not responding away from its base. Battery flat?' : 'No response from the robot');
      }
    }
  }

  /** The cloud connection is (back) up: silence is timed from now. */
  markConnected() {
    this.connectedAt = Date.now();
  }

  /** The Matter operational state for status `s` (plugin errors, trips and room queues first). */
  opFor(s) {
    if (this.fault || this.notice || this.condition) {
      return Op.Error;
    } else if (this.trip) {
      return Op.SeekingCharger; // on its way back to the starting point (no base station on this floor)
    } else if (this.queueGap()) {
      return this.zoneQueue.userPaused ? Op.Paused : Op.Running; // between rooms: still one clean
    } else if (isDocked(s)) {
      return dryingMops(s) ? Op.CleaningMop : s.battery < 100 ? Op.Charging : Op.Docked;
    } else if (s.returning || seekingBase(s)) {
      return Op.SeekingCharger;
    } else if (s.paused && inJob(s)) {
      return Op.Paused; // a paused mop drying taken off the base is Stopped: Start works
    } else if (!inJob(s)) {
      return Op.Stopped;
    }
    return Op.Running;
  }

  /** PowerSource battery attributes for status `s` (null / unknown before the first status). */
  powerFor(s, op) {
    if (!s) {
      return { batPercentRemaining: null, batChargeLevel: 0, batChargeState: ChargeState.Unknown };
    }
    const level = s.battery;
    return {
      batPercentRemaining: level * 2,
      batChargeLevel: level < 15 ? 2 : level < 30 ? 1 : 0,
      batChargeState: op === Op.Charging || (op === Op.CleaningMop && level < 100) ? ChargeState.IsCharging
        : op === Op.Docked || op === Op.CleaningMop ? ChargeState.IsAtFullCharge : ChargeState.IsNotCharging,
    };
  }

  async refresh(s) {
    const previous = this.status;
    this.status = s;
    this.followReturn(s);
    if (this.trip) {
      this.tripFollow(previous, s);
    }
    if (this.zoneQueue && isDocked(s)) {
      this.finishQueue(this.zoneQueue, 'the robot is on its base');
    }
    const op = this.opFor(s);
    const inGrace = Date.now() < (this.commandGraceUntil ?? 0);
    if ((op !== this.opState || !previous) && !inGrace) {
      this.log.debug(`Robot state ${s.state}${s.paused ? ' paused' : ''}${s.returning ? ' returning' : ''}`
        + ` (base ${s.base}, docked ${s.docked ? 1 : 0}) -> Matter ${op}`);
      await this.setOpState(op, false);
      const cleaning = op === Op.Running || op === Op.Paused;
      await this.update('rvcRunMode', { currentMode: cleaning ? RUN_CLEANING : RUN_IDLE });
      if (!cleaning) {
        await this.update('serviceArea', { currentArea: null });
      }
    }
    if (s.battery !== undefined && s.battery !== previous?.battery || op !== previous?.op) {
      const sent = await this.update('powerSource', this.powerFor(s, op));
      if (sent) {
        await this.checkBattery(s.battery, !previous);
      }
    }
    this.status.op = op;
    // Set off for the base on its own (a resumed mop drying): it passes the sensors like any move, so it
    // needs the OK. Not when the plugin sent it, nor while an approved hold is in force.
    if (this.security && previous && !seekingBase(previous) && seekingBase(s) && !inGrace && !this.homeBound
      && !this.recalling && !this.trip && !this.checking && !this.unapproved
      && !(this.store.securityHeld && !this.releasing && !this.store.securityStopped)) {
      this.checkBeforeMoving('The robot set off for its base by itself', 'it set off for its base by itself',
        'Send it to its base from the Home app once the security system allows it.')
        .catch(error => this.log.warn(`Could not pause the robot (${error.message}).`));
    }
    if (this.homeBound && this.arrived(s)) {
      this.arrivedHome();
    }
    // From the raw state, so an error during a job doesn't end it.
    const active = inJob(s);
    if (s.returning && this.zoneQueue) {
      this.finishQueue(this.zoneQueue, 'the robot is heading back');
    }
    if (active && previous && !inJob(previous)) {
      // The next room of a queue is part of the same clean: it doesn't count again for vacation mode.
      if (!this.trip && !(this.zoneQueue?.phase === 'starting' && this.zoneQueue.index > 0)) {
        this.vacationJob();
      }
      this.jobStarted();
      this.queueJobStarted();
    }
    if (isDocked(s) || (previous && inJob(previous) && !active)) {
      this.restoreAutoMainMap(); // does nothing unless the plugin turned the setting off
      this.restoreStairs({ force: previous && inJob(previous) && !active }); // gated by what the plugin changed, unless a job just ended
    }
    if (previous && inJob(previous) && !active) {
      this.lastJobEnd = Date.now();
      this.mapGuard = undefined;
      this.queueJobEnded();
    }
    if (isDocked(s) && this.store.robotMapId !== undefined) {
      // On its base: back on the floor that has it.
      delete this.store.robotMapId;
      this.save();
    }
    if (!active) {
      this.stairPaused = false;
    }
    this.watchStairs(active);
    this.watchMap(active);
    this.securityFollow(active);
    this.onJob?.(active || this.queueGap());
  }

  /** A job began, from the Home app or anywhere else. */
  jobStarted() {
    if (this.mapGuard && Date.now() - this.mapGuard.at > GUARD_MAX_AGE) {
      this.mapGuard = undefined; // an old start that never ran: this job began elsewhere
    }
    this.mapSilentSince = undefined;
    if (this.notice && !this.starting) {
      this.clearNotice().catch(() => {});
    }
    if (!this.status?.returning) {
      this.ret = undefined; // a return that started this job (Return to dock) is timed from its start
      this.clearCondition('return').catch(() => {});
    }
    // Started elsewhere (the Narwal app, a schedule, the robot's button): it's on the map the robot is set to.
    if (this.store.robotMapId === undefined && this.robot.currentMapId !== undefined) {
      this.store.robotMapId = this.robot.currentMapId;
      this.save();
    }
  }

  /** Read the battery back from Matter, so a dropped update shows in the log. */
  async checkBattery(level, first) {
    try {
      const read = async () => (await this.matter.getAccessoryState(this.uuid, 'powerSource'))?.batPercentRemaining;
      // Homebridge applies an update a moment after updateAccessoryState() returns (it only queues
      // it), so a read straight away still sees the old value: wait for it to land.
      let reported = await read();
      for (let waited = 0; reported !== undefined && reported !== level * 2 && waited < BATTERY_LAND; waited += 200) {
        await new Promise(resolve => setTimeout(resolve, 200));
        reported = await read();
      }
      if (reported !== undefined && reported !== level * 2) {
        this.log.warn(`Battery: sent ${level}% but the vacuum reports ${reported / 2}%`);
      } else if (first) {
        this.log.info(`Battery ${level}%`);
      } else {
        this.log.debug(`Battery ${level}%`);
      }
    } catch (error) {
      this.log.debug(`Could not read the battery back: ${error.message}`);
    }
  }

  async applyWorking(w) {
    // Zone jobs (a floor without a base, and the trip back to the starting point) report the zone's
    // number as the room, which is some other room's id: the queue knows the room, so ignore it.
    if (this.zoneQueue || this.trip || this.robotFloor()?.hasDock === false) {
      return;
    }
    // Room ids repeat from floor to floor: the room is on the floor the robot is cleaning.
    const floorId = this.robotFloor()?.id;
    const area = w.roomId && this.areas.find(a => a.mapId === floorId && a.roomId === w.roomId);
    if ((this.opState === Op.Running || this.opState === Op.Paused) && area) {
      await this.update('serviceArea', { currentArea: area.areaId });
    }
  }

  /**
   * Set the current Narwal error code (undefined = none). Codes missing from Narwal's error
   * table are routine notices and don't count. Returns true when the error state changed.
   */
  async setError(code) {
    const err = code ? lookupError(code) : undefined;
    const hex = code ? `0x${Number(code).toString(16).toUpperCase().padStart(8, '0')}` : '';
    if (code && !err && this.lastNotice !== code) {
      this.log.debug(`Narwal notice ${hex} (not an error)`);
    }
    this.lastNotice = code;
    if ((err ? code : undefined) === this.fault?.code) {
      return false;
    }
    this.fault = err ? { code, ...err } : undefined;
    if (err) {
      this.log.warn(`Narwal error ${hex}: ${err.message}`);
      this.opState = Op.Error;
      this.commandGraceUntil = 0;
      await this.update('rvcOperationalState', {
        operationalState: Op.Error,
        // Matter limits the details string to 64 characters.
        operationalError: { errorStateId: err.matter, errorStateDetails: err.message.slice(0, 64) },
      });
      // An error stops the trip home (or a room queue that has no job running to resume): end it, Stopped with the error.
      if (this.trip) {
        this.log.warn(`The trip back to the starting point ended: ${err.message}`);
        await this.endTrip(this.trip, 'robot error');
      }
      const q = this.zoneQueue;
      if (q && (q.phase === 'starting' || q.phase === 'gap')) {
        this.finishQueue(q, `the robot reported an error (${err.message})`);
      }
    } else {
      this.log.info('Narwal error cleared');
      this.opState = undefined; // re-evaluate from the next status
      const shown = this.notice ?? this.condition;
      await this.update('rvcOperationalState', {
        operationalError: shown
          ? { errorStateId: shown.matter, errorStateDetails: shown.message.slice(0, 64) }
          : { errorStateId: ErrorState.NoError },
      });
    }
    return true;
  }

  /** Cloud work status: only a backup for when live robot status isn't arriving. */
  async applyFault(workStatus) {
    if (Date.now() - (this.lastStatusAt ?? 0) < 2 * 60 * 1000) {
      return;
    }
    const changed = await this.setError(workStatus?.fault ? workStatus.fault_code : undefined);
    if (changed && !this.fault && this.status) {
      await this.refresh(this.status);
    }
  }

  /** New maps or rooms: update the Home app's floor and room lists. */
  async applyRooms() {
    // A selection that lost rooms (a changed map) is dropped rather than turned into a smaller clean.
    const known = new Set(this.areas.map(a => a.areaId));
    if ((this.store.selectedAreas ?? []).some(id => !known.has(id))) {
      this.store.selectedAreas = this.validSelection(this.store.selectedAreas);
      this.save();
    }
    await this.update('serviceArea', {
      supportedMaps: this.supportedMaps(),
      supportedAreas: this.supportedAreas(),
      selectedAreas: this.validSelection(this.store.selectedAreas),
    });
  }
}
