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
  "Downstairs"), its maps and rooms (or what to do to get them) with the names the Home app
  shows, stair detection per map and room, its clean modes, the cleaning sensor and
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

For each one you can set the passes (1–3), suction (quiet / standard / strong / max) and water level
(slightly dry / standard / slightly wet), or leave them at **Default**: the settings the Narwal app has
saved for that mode, which are what the mode tiles in the Narwal app (Vacuum, Mop, Vacuum then mop) are set to.
They are the same for every room, so Default is not a per-room choice. The floor material of each room
(set on the Narwal app's map: wood, tile and so on) is separate: the robot applies it itself (mopping
pressure, and in Freo Mind the mopping humidity), and the plugin doesn't change it. A secondary map has no
saved settings in the Narwal app (its rooms are cleaned as zones), so Default there means standard suction,
standard water and 1 pass. The combined ones also choose the task: Vacuum and
Mop, Vacuum then Mop, or Freo Mind (the robot decides everything; it needs the saved settings, so it isn't
available on a secondary map). If the robot hasn't sent its settings for a task yet, standard suction and water
are used and the log says so.

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
  until the robot is on that map (see [Multiple maps](#multiple-maps-in-development)).
- To show a name in the Home app that differs from the Narwal app's (say "Living Room 2" becomes
  "Hallway"), set it in the plugin's settings: each robot's rooms are listed there with a name field.
  A name set there always wins over the Narwal app's, and an empty field keeps the Narwal app's name.
  In `config.json` it is `maps[].rooms[].name`, as in the example above.
- Renaming a room doesn't affect Home scenes and automations that use it: they follow the room, not its name.

<a name="multiple-floors-in-development"></a>

## Multiple maps (in development)

> **Still in development.** Support for several maps (often one per floor of a house, hence "multiple
> floors" in older notes) works in testing but isn't finished. Known gaps:
> - The plugin can't tell when you carry the robot to another map (the robot doesn't report being
>   picked up). It goes by what it did last: the map it started work on, until it is back on its base.
>   Picking the rooms in the Home app tells it you carried the robot to the new map; a start from Siri or
>   an automation needs the robot on its base first.
> - A secondary map (a map without a base station) is vacuum only: mopping there is switched off.
> - A start with no rooms picked (Siri, an automation) uses the rooms picked last, so on a secondary map
>   pick the rooms in the Home app first.
> - The low-battery trip back, per-room stair detection and the automatic switch back to the main map
>   have had only a few live runs; a map layout very different from the tested ones may show gaps.
>
> Robots with a single map are not affected. Feedback is welcome in the GitHub issues.

### How cleaning another map works

1. Put the robot down on the map's starting point (the P marker on that map in the Narwal app) before you
   start a clean on a secondary map. The robot finds its place on the map from there.
2. In the Home app, pick the map in Cleaning Map, pick the rooms, and start (vacuum only on secondary
   maps).
3. It cleans the rooms one after another and drives back to P when done; it waits there.
4. Carry it back onto its base (the plugin then switches it to the main map), or carry it to the next
   map's P and pick that map's rooms in the Home app.

A Freo can keep several maps: usually one per floor of the house, but a map can just as well be a
detached space such as a guest house or a workshop, so the plugin says "map", never "floor" (which
also collides with the floor-type settings). It publishes all of them, in the order of their map
numbers on the robot: the Home app shows a **Cleaning Map** picker, and each map's rooms. Pick rooms on
one map and start; the plugin does
the rest:

1. It switches the robot to that map and checks the robot says it is on it.
2. It sets **stair detection** for that map and checks the robot kept it.
3. It asks the security system for its OK (if the security hold is on), then starts the clean.

If any step is refused or not answered, nothing starts and the Home app tile shows an error
("Unable to start or resume"), so you never need the log. Carry the robot onto the map first: it
finds its place on the map from where it stands. A robot put on the wrong map reports "Robot
positioning failed" after a few minutes. If a Freo can't find its place it may also take another
map for the one it was given; the plugin watches for that during a clean it started (it only goes by
the robot's answers to its own questions, and asks twice before stopping), stops the
robot and says so on the tile ("The Freo placed itself on Main Map, not Upstairs"). Start it on the
map's starting point (the P on the Narwal app's map) to avoid this.

- **Names:** the settings page lists each map and its rooms. Give a map or a room another name for
  the Home app (say "Corridor" upstairs becomes "Hallway"); leave it empty to keep Narwal's.
  Matter needs the names to be different, so equal ones within a map get a number added. A room keeps
  its plain name unless another map has a room with the same name; then the room on the secondary map
  gets its map's name in brackets, "Corridor (Upstairs)" (the main map's room stays "Corridor"; if
  both are on secondary maps, both get their map's name), so you can tell them apart in the Home app and
  with Siri.
- **Stair detection** is on for every map by default, because a robot that doesn't know about
  stairs can drive down them. Turn it off only for maps, or rooms, with no stairs going down: with
  it on, dark floors and toe kicks can cause false "robot is stuck" errors. Each room on the settings
  page has its own "Detect stairs" switch, which follows its map's until you change it. It is a
  robot-wide setting in the Narwal app, so the plugin sets it again before every clean. On the main
  map one clean covers all the rooms you picked, so stair detection is on if any of them wants it.
  On a secondary map each room is its own job: it starts with stair detection on (for the drive
  there), and in a room set to off the plugin turns it off once the robot has been inside the room for
  a few seconds, and back on as the robot leaves the room, is paused, or the job ends. It is never off
  between rooms, on the way back to the starting point, or after the clean. If the robot doesn't take a
  change, stair detection stays on. If something else turns it off while the robot cleans somewhere
  that needs it, the robot is paused (the tile shows an error; Resume turns it back on). After each
  clean the plugin turns stair detection back on, so a robot you carry upstairs afterwards has it. A
  robot with a single map is left alone unless you choose a value.
- **The plugin owns the map.** The robot never says which map it is on, and the Narwal app has a
  setting, "Automatically switch to the main map after cleaning", that moves it to the main map after
  every job, which on a secondary map would take it off the map it is standing on, between two
  rooms. So on a robot with several maps the plugin turns that setting off, once, and leaves it off
  (it logs that it did); a robot with one map keeps its setting. Instead, whenever the robot is on its
  base the plugin checks its current map and, if it isn't the main map, switches it ("Back on its
  base: switched the robot to Main Map" in the log; if that fails it tries again every minute).
- **Don't use the Narwal app's "End Mop Wash & Dry" while the robot is off its base:** the robot then
  drives back to its base by itself (the plugin asks the security system first and pauses it without
  the OK, but it is easy to forget stairs).
- **Secondary maps** (a map without a base station): Narwal only offers zone cleaning on them, so the
  plugin cleans each room you pick as a zone shaped like the room, one room at a time (the Narwal app
  takes one zone per job). See "Cleaning a secondary map" below. They are vacuum only.
- **Return to dock** on a secondary map, while the robot is cleaning there, stops the clean at once and
  sends the robot back to that map's starting point (the "P" on the map in the Narwal app). The robot
  refuses to be recalled there and has no "go to" command, so the plugin sends it on a tiny zone clean of about
  30 x 30 cm around the point (one pass, quietest suction): it does a few seconds of vacuuming there
  because that is the only way to move it. The trip is checked like a start (right map, stair
  detection, security hold); if anything fails, or the robot refuses, it stays where it stopped and
  the tile shows "Unable to find charging dock". When the security system sends the robot home
  because Away is being armed, it makes the same trip against the clock, and if it can't make it, the
  clean is simply ended. Return to dock while the robot stands idle on a secondary map is refused ("Put
  the Freo on its base"): the plugin can't tell if it is still at the starting point or was carried
  away.
- **Existing scenes and automations keep working:** the main map's rooms keep the ids they had,
  other maps' rooms use `map id * 1000 + room id`.
- **Cleaning plans** (your per-room settings from the Narwal app) are kept per map, and each clean
  uses the plan of its own map.
- Keep scheduling in Home app automations, not in the Narwal app: a schedule started by the app can't
  be changed by the plugin.

### Cleaning a secondary map

Start as described in "How cleaning another map works" above (with no rooms picked, a start from Siri
or an automation uses the rooms picked last, so pick them in the Home app first). Then:

- The robot cleans the rooms one by one, the way it works on the main map: first the room that has the
  map's starting point, then always the nearest room left (measured edge to edge, so a long corridor
  counts as next to every room along it). If the starting point is in none of the picked rooms, the
  nearest room goes first. To choose the order yourself, set it per map on the settings page (the
  `roomOrder` of the map in `config.json`): picked rooms follow it, and rooms it doesn't list come
  after, nearest first. The log shows the order ("Rooms on Upstairs in this order: …").
- When the last is done it goes back to the starting point by itself: the tile shows Returning on the
  way and Stopped there, with no error. Pause, Return to dock, Stop, an error or losing the connection
  end the rest of the list, and the robot stays where it is.
- If the battery drops to 10% (or the robot itself ends a room because its battery is low), the plugin
  ends the clean and sends the robot back to the starting point, and logs which rooms were left. The
  tile then shows a low battery error until the robot is on its base or you start a new clean, so the
  Home app tells you to pick it up. There is no check at the start, so a robot with a low battery
  can still be sent out. If the battery is too low even for the way back, the robot stays where it is
  with the same error.
- A room pick is for one clean: when a clean is over (a main map clean, all the rooms and the way back,
  or an end by any error), the Home app goes back to the main map with every room picked. A start
  that picks no rooms (Siri, an automation) then cleans the whole main map, or is refused while the
  robot is on a secondary map.
- The log says how much battery a clean used ("battery 74% → 52%"), once per clean.
- Once it is back on its base the plugin sees it is docked and switches it to the main map.

Good to know: mopping isn't offered on a secondary map (a Mop, Vacuum and Mop or Freo Mind start is
refused: "Upstairs: vacuum only"); Return to dock while it waits at the starting point is refused
("Put the Freo on its base"); a clean of another map's rooms while it is on a secondary map is
refused ("The Freo is on Upstairs: put it on its base first") unless you just picked the rooms in the Home app; and a clean of a secondary map while the
robot is on its base is refused ("Carry the Freo to Upstairs's starting point first"). The plugin
turns off the Narwal app's "switch to the main map after cleaning" on purpose (see above).

In `config.json`, a robot's `maps` lists the entries you changed (`id` is the map's number on the
robot; room `id` is the room's number on that map; a room's `stairDetection` overrides its map's;
`roomOrder` lists room ids in the order to clean them on a secondary map); the settings page writes
them for you.

On the main map, picked rooms are sent in the order of the room plan saved in the Narwal app for the
mode (the order the app's own full clean follows); rooms the plan doesn't list come after, in the Home
app's order. The start line in the log shows the order.

## Cleaning sensor and consumables (optional)

The Home app can't trigger automations on a robot vacuum's state, so two optional extras are
published as a regular HomeKit accessory on the same child bridge. **Pair the child bridge in the
Home app too** when you turn either on (Homebridge UI > Bridges > the plugin's bridge shows its
setup code); the vacuum keeps its own Matter pairing.

- **`cleaningSensor`:** an occupancy sensor, "Freo Cleaning", that shows Detected for the whole
  cleaning job: from the moment the robot starts until the job ends, including its trips back to
  the dock to wash the mops mid-job (the robot reports the job itself, so there's no guessing from
  dock time). On a secondary map it stays Detected through all the rooms and the trip back to the
  starting point, not dropping between rooms. Use it to trigger automations ("when Freo Cleaning detects occupancy…").
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
  Every saved map is published (see Multiple maps). Rooms and
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
