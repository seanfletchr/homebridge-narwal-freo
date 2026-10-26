<p align="center"><img src="narwal-header.png" alt="Homebridge and Narwal" width="100%"></p>

# homebridge-narwal-freo

<p align="center">
  <a href="https://github.com/homebridge/homebridge/wiki/Verified-Plugins"><img src="https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=flat" alt="Verified by Homebridge"></a>
  <a href="https://www.npmjs.com/package/homebridge-narwal-freo"><img src="https://img.shields.io/npm/v/homebridge-narwal-freo?label=npm%40latest" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/homebridge-narwal-freo"><img src="https://img.shields.io/npm/d18m/homebridge-narwal-freo" alt="npm downloads"></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/homebridge-narwal-freo" alt="license"></a>
</p>

Shows the original **Narwal Freo** (model YJCC012 / product group J3) in Apple Home as a
native **robot vacuum** over Matter: start, pause, resume, return to dock, clean mode
(Vacuum & Mop, Vacuum, Mop, Vacuum then Mop, Freo Mind), room selection, and battery/charging state. Optionally adds a **Cleaning** sensor for Home app automations and the
**consumables'** remaining life.

<p align="center"><img src="narwal-devices.png" alt="The Narwal Freo robot vacuum" width="100%"></p>

**Only the original Freo is supported.** Newer Narwal robots (Freo X, Freo Z, …) use different
message formats and won't work.

Unofficial. It talks to Narwal's cloud the same way the Narwal app does (REST sign-in at
`us-app.narwaltech.com`, then MQTT at the broker Narwal assigns). The Freo has no local API.
Message formats come from the MIT-licensed Home Assistant integrations
[mk0000001/ha-narwal-cloud](https://github.com/mk0000001/ha-narwal-cloud),
[madsah211/ha-narwal-cloud-eu](https://github.com/madsah211/ha-narwal-cloud-eu) and
[archieprichard/narwhal-cloud](https://github.com/archieprichard/narwhal-cloud), checked against our own robot.

## Requirements

- Homebridge 2.4 or newer, Node 22+.
- Matter enabled for the plugin's child bridge. "Externals only" is enough: the vacuum gets its
  own Matter pairing, and no Matter bridge is started.
- An Apple Home hub (HomePod or Apple TV) for Matter.

## Config

Set it up from the plugin's settings page in the Homebridge UI:

- **Narwal account:** sign in with the email and password you use in the Narwal app. The page checks
  them with Narwal straight away and lists the robots on the account.
- **One card per robot:** whether it shows in the Home app, its name (e.g. "Upstairs" and
  "Downstairs"), its floors and rooms (or what to do to get them) with the names the Home app
  shows, stair detection per floor, its clean modes, the cleaning sensor and
  consumables. Each robot is its own Matter vacuum with its own pairing code.
- **Security system:** the optional security hold (see below).
- **Vacation mode:** cut back scheduled cleaning while a vacation switch is on (see below).

The same settings in `config.json`:

```json
{
  "platform": "NarwalPlatform",
  "name": "Narwal Freo",
  "email": "you@example.com",
  "password": "…",
  "robots": [
    { "serialNumber": "YA3…", "name": "Downstairs", "cleaningSensor": true, "consumables": true,
      "maps": [
        { "id": 1, "stairDetection": false },
        { "id": 2, "name": "Upstairs", "rooms": [{ "id": 4, "name": "Hallway" }] }
      ] },
    { "serialNumber": "YA4…", "name": "Upstairs", "cleanModes": { "both": { "task": "vacuum_then_mop" } } }
  ],
  "securityHold": true,
  "securityPlugin": "homebridge-example-security",
  "vacationMode": true,
  "vacationCleans": 1,
  "vacationAfter": "vacuum",
  "_bridge": {
    "username": "…",
    "port": 51916,
    "name": "Narwal Bridge",
    "matter": { "enabled": false, "externalsOnly": true, "disableIpv4": true }
  }
}
```

`disableIpv4` keeps Matter's mDNS off IPv4 so it doesn't compete with avahi, which advertises the
HomeKit bridges.

## First-time setup

1. **Enable Matter on the plugin's child bridge** (externals only is enough): add the `matter` block
   to `_bridge`, as in the example above, and restart the child bridge. Without it the log says
   `Matter is not enabled for this bridge` and no vacuum is published.
2. **Pair the vacuum.** Once the log says the Freo is published as a Matter robot vacuum, it prints
   `Commissioning codes for …` (a QR code and a manual code) in the Homebridge log. In the Home app
   choose **+ > Add Accessory** and use that code. This pairing is separate from the Homebridge
   bridge's own HomeKit code.

## Clean modes in the Home app

The Home app offers three choices, **Vacuum**, **Mop** and a combined one (named after its
Automatic task), each with a "⋯" menu of **Automatic / Quick / Deep Clean**. Tapping a choice itself
picks its Automatic. What each of these nine does is set in the plugin settings (`cleanModes`):

| Home app | Automatic | Quick | Deep Clean |
|---|---|---|---|
| Vacuum | Default | 1 pass | 2 passes |
| Mop | Default | 1 pass | 2 passes |
| Combined | Vacuum and Mop (one pass doing both), Default | Vacuum and Mop, 1 pass | Vacuum then Mop (a vacuum pass, then a mop pass), 2 passes each |

For each one you can set the passes (1–3), suction (quiet / standard / strong) and water level
(slightly dry / standard / slightly wet), or leave them at **Default**: the per-room
settings saved in the Narwal app for that task. The combined ones also choose the task: Vacuum and
Mop, Vacuum then Mop, or Freo Mind (the robot decides everything). If the robot
hasn't sent its settings for a task yet, standard suction and water are used and the log says so.

```json
"cleanModes": {
  "both": { "task": "freo_mind" },
  "vacuumDeep": { "passes": "2", "suction": "strong" },
  "mop": { "water": "wet" }
}
```

The vacuum must offer the clean mode it reports as current, or matter.js won't publish it, so a
mode number is never dropped without mapping it to one that stays (see `RETIRED_MODES` in
`lib/vacuum.js`). Labels must be unique too: two slots set up the same get their slot name, e.g.
"Mop, 1 pass (Quick)".

## Room names

The Home app shows your rooms by name, and the plugin gets those names from the robot, so name them in
the **Narwal app** first:

1. In the Narwal app, give each room its type or name (Kitchen, Bathroom, Master Bedroom, Living Room, …).
   A room that has none is shown as "Room", "Room 2", "Room 3", …
2. Restart the plugin's child bridge in the Homebridge UI to pick the change up right away. Without a
   restart the plugin reads the robot's map again every few hours.
3. Two rooms of the same type get a number: "Living Room" and "Living Room 2".

Good to know:

- The robot only describes the map it is on now, so rooms on another saved map keep their generic names
  until the robot is on that map (see [Multiple floors](#multiple-floors-in-development)).
- To show a name in the Home app that differs from the Narwal app's (say "Living Room 2" becomes
  "Hallway"), set it in the plugin's settings: each robot's rooms are listed there with a name field.
  A name set there always wins over the Narwal app's, and an empty field keeps the Narwal app's name.
  In `config.json` it is `maps[].rooms[].name`, as in the example above.
- Renaming a room doesn't affect Home scenes and automations that use it: they follow the room, not its name.

## Multiple floors (in development)

> **Still in development.** Multi-floor support works in testing but isn't finished. Known gaps:
> - The plugin can't tell when you carry the robot to another floor (the robot doesn't report being
>   picked up). After carrying it, start cleans on the floor it's on now; Return to dock may assume
>   the floor it was last cleaning, so put it on its base yourself.
> - A clean started with no rooms picked (for example from an automation) uses the floor of the
>   rooms picked last time.
> - Mopping on a floor without a base station is barely tested.
>
> Robots with a single map are not affected. Feedback is welcome in the GitHub issues.

A Freo can keep several maps, one per floor. The plugin publishes all of them: the Home app shows a
**Cleaning Map** picker, and each floor's rooms. Pick rooms on one floor and start; the plugin does
the rest:

1. It switches the robot to that floor's map and checks the robot says it is on it.
2. It sets **stair detection** for that floor and checks the robot kept it.
3. It asks the security system for its OK (if the security hold is on), then starts the clean.

If any step is refused or not answered, nothing starts and the Home app tile shows an error
("Unable to start or resume"), so you never need the log. Carry the robot to the floor first: it
finds its place on the map from where it stands. A robot put on the wrong floor reports "Robot
positioning failed" after a few minutes. If a Freo can't find its place it may also take another
floor's map for the one it was given; the plugin watches for that during a clean it started, stops the
robot and says so on the tile ("The Freo placed itself on Main Map, not Upstairs"). Start it on the
floor's starting point (the P on the Narwal app's map) to avoid this.

- **Names:** the settings page lists each map and its rooms. Give a floor or a room another name for
  the Home app (say "Corridor" upstairs becomes "Hallway"); leave it empty to keep Narwal's.
  Matter needs the names to be different, so equal ones get a number added.
- **Stair detection** is on for every floor by default, because a robot that doesn't know about
  stairs can drive down them. Turn it off only for floors with no stairs going down: with it on,
  dark floors and toe kicks can cause false "robot is stuck" errors. It is a robot-wide setting in the
  Narwal app, so the plugin sets it again before every clean, and if something else turns it off
  while the robot cleans a floor that needs it, the robot is paused (the tile shows an error;
  Resume turns it back on). A robot with a single map is left alone unless you choose a value.
- **Floors without a base station:** Narwal only offers zone cleaning on them, so the plugin cleans
  each room you pick as a zone shaped like the room, one room at a time (the Narwal app takes one
  zone per job): the room the robot is in (or nearest to) goes first and then the nearest remaining
  one, whatever order the Home app sent, and when a room is finished the next one starts, with the
  security hold kept in force until the last. Stopping, an error, Return to dock or a restart of Homebridge ends the rest of the
  list. Pick no room to clean the whole floor. The robot limits mopping there to about 14 m²
  (150 sq ft) per job, because it has no base to wash the mops; it stops by itself at its limit.
  While the plugin works on such a floor it turns off the Narwal app's "Automatically switch to the main
  map after cleaning" setting (the robot would otherwise leave the floor after every room) and turns it
  back on afterwards; if you had it off, it stays off.
- **Return to dock** on a floor without a base station stops the clean at once and sends the robot
  back to that floor's starting point (the "P" on the map in the Narwal app). The robot refuses to be
  recalled there and has no "go to" command, so the plugin sends it on a tiny zone clean of about
  30 x 30 cm around the point (one pass, quietest suction): it does a few seconds of vacuuming there
  because that is the only way to move it. The trip is checked like a start (right floor, stair
  detection, security hold); if anything fails, or the robot refuses, it stays where it stopped and
  the tile shows "Unable to find charging dock". When the security system sends the robot home
  because Away is being armed, it makes the same trip against the clock, and if it can't make it, the
  clean is simply ended.
- **Existing scenes and automations keep working:** the main map's rooms keep the ids they had,
  other maps' rooms use `map id * 1000 + room id`.
- **Cleaning plans** (your per-room settings from the Narwal app) are kept per map, and each clean
  uses the plan of its own floor.
- Keep scheduling in Home app automations, not in the Narwal app: a schedule started by the app can't
  be changed by the plugin.

In `config.json`, a robot's `maps` lists the entries you changed (`id` is the map's number on the
robot; room `id` is the room's number on that map); the settings page writes them for you.

## Cleaning sensor and consumables (optional)

The Home app can't trigger automations on a robot vacuum's state, so two optional extras are
published as a regular HomeKit accessory on the same child bridge. **Pair the child bridge in the
Home app too** when you turn either on (Homebridge UI > Bridges > the plugin's bridge shows its
setup code); the vacuum keeps its own Matter pairing.

- **`cleaningSensor`:** an occupancy sensor, "Freo Cleaning", that shows Detected for the whole
  cleaning job: from the moment the robot starts until the job ends, including its trips back to
  the dock to wash the mops mid-job (the robot reports the job itself, so there's no guessing from
  dock time). Use it to trigger automations ("when Freo Cleaning detects occupancy…").
- **`consumables`:** one Filter Maintenance service per part, linked to the Cleaning sensor. **Apple's Home
  app doesn't display these** (it only shows filter life on air purifiers); use a third-party HomeKit
  app such as Eve, Controller for HomeKit or Home+, which show each part. They cover the parts the Narwal app shows a life bar for:
  Filter, Side Brush, Rolling Brushes, Mop and Filter Sponge. Each has its life left (%) and shows
  "replace" once it is at or below `replaceAtPercent` (10 by default). Read from Narwal's cloud
  hourly and after each clean. After replacing a part, reset its counter from the same app (its
  "Reset filter" control sends the Narwal app's reset command) or in the Narwal app. The
  app's "clean regularly" reminders (dust bin, base tray, sensors, caster wheel) have no counter
  and aren't shown.

## Vacation mode (optional)

Going away? Turn on **Cut back cleaning on vacation** in the settings, and a **Vacation Mode** switch in the Home app
cuts back cleaning while you're gone. The next clean still runs, so you come home to a clean house.
After that, cleans started from the Home app, including your scheduled automations, are skipped (or
run vacuum only) until you turn the switch off. Your schedules stay as they are.

The plugin follows a switch named "Vacation Mode" if you have one on this Homebridge (on another
bridge: [homebridge-ecobee-security](https://github.com/seanfletchr/homebridge-ecobee-security)'s, or a
[homebridge-dummy](https://github.com/mpatfield/homebridge-dummy) switch, for example), and adds its own
if you don't. The added switch is on the plugin's bridge, so add that bridge to the Home app if you
haven't (the vacuum keeps its own Matter pairing).

- **`vacationCleans`** (default 1, up to 5): how many cleans still run as usual. 0: none.
- **`vacationAfter`**: what happens to later cleans: `none` (default) skips them, `vacuum` runs them
  vacuum only, at the same Automatic, Quick or Deep Clean, saving water while still picking up dust.

Good to know:

- **Schedule cleans with Home app automations**, not in the Narwal app: vacation mode then decides
  before the robot gets the command. Cleans started from the Narwal app, or by schedules set there,
  can't be stopped in time (a mop clean wets its mops before the plugin finds out), but they count
  toward the allowed cleans.
- A clean already running when you turn the switch on doesn't count. Resuming a paused clean is
  always allowed.
- Finding an existing switch needs Homebridge's insecure mode (Homebridge Settings, on by default).
- Once the plugin has found or added a switch, it keeps using it, since your automations are built
  on it. To start over, turn vacation mode off and on again in the plugin settings.

## Security system (optional)

Motion sensors can mistake a robot vacuum for an intruder: ecobee's do, and set off the alarm. With
**Hold security while cleaning** (`securityHold`) on, the robot asks the security
system to switch from Away to **Home** before it starts, so it can clean safely. Doors and windows
stay armed. When the robot is done, the system goes back to Away. If Away is armed while the robot is
cleaning, it heads back to its base, or pauses where it is if it can't make it in time.

Cleans started outside the Home app (the Narwal app, its schedules, the robot's button) are checked
with the security system as the robot leaves its base; without its OK the robot is paused and stays
paused.

It needs a security system plugin that supports this, such as
[homebridge-ecobee-security](https://github.com/seanfletchr/homebridge-ecobee-security). Setup,
what happens in each situation, and the API for other plugins:
[docs/security-hold.md](docs/security-hold.md).

## How it behaves

- **Play Sound to Locate** in the Home app plays the robot's locate sound (the Narwal app's
  "Locate robot").
- **Rooms:** the plugin asks the robot for its saved maps and the Narwal app's cleaning plans by
  itself; the Narwal app doesn't need to be open. The vacuum is published once the rooms arrive.
  Every saved map is published (see Multiple floors). Rooms and
  plans are cached in `<homebridge storage>/narwal/state.json` (mode 600, also holds the session
  tokens), and the plugin re-requests them every 6 hours and when the robot's map changes, so room
  changes made in the app show up on their own.
- **Clean settings:** each start uses the app's saved per-room template for the chosen mode, so
  suction, water level and passes follow what's set in the Narwal app.
- **No room selected** in the Home app means all rooms.
- **Freo Mind** needs the app's plan; without it the plugin refuses instead of guessing.
- **Status:** the plugin keeps the robot publishing status (the same "app open" heartbeat the
  Narwal app sends, every 5 minutes). The robot confirms each command; the log warns if it refuses
  one or doesn't answer. The state the robot reports a second or two later is what the Home app shows.
- **Errors** come from the robot's live status (field 1 of `robot_base_status`), so the Home app
  shows them within seconds and clears them when fixed. `lib/errors.js` maps Narwal's 225 codes
  (generated from Narwal's published error table v1.0.10) to Matter errors — water tank
  missing/empty, dirty water tank full, dust bin, stuck, wheels/brush jammed, can't find dock, low
  battery, sensor — with Narwal's message as the details. Codes not in the table are routine
  notices (e.g. 0x01010072 during mop runs) and are ignored. The cloud work status (polled every
  3 minutes) is only used when live status isn't arriving.
  The plugin also sets these standard errors itself, and they stay until resolved: failed to find
  charging dock when the robot hasn't reached its base within about three times its usual return time
  (10 minutes until it has learned one; an unplugged base station, say), low battery when it has stopped
  answering away from its base, and unable to complete operation when it hasn't answered since start-up.


## Known issues

See the [open issues](https://github.com/seanfletchr/homebridge-narwal-freo/issues).
