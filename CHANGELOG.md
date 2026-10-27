# Changelog

## 0.6.2

### Multiple maps (still in development)

- New: **cleaning a secondary map** (a map without a base station) works the way a person would do it. Put the
  robot on the map's starting point (the P in the Narwal app), pick the map and rooms in the Home app and start.
  The robot cleans the rooms one by one and, when the last is done, drives back to the starting point by
  itself and stops there. The tile shows Returning on the way and Stopped there, without an error, and the
  security hold stays in force until it arrives. Carry it back onto its base and the plugin switches it to
  the main map.
- New: the rooms of a secondary map are cleaned like the Freo does on the main map: the room with the map's
  starting point first, then always the nearest room left.
- New: you can go straight from one secondary map to another, or down to the main map without using the
  base: carry the robot to the next map's starting point and pick the rooms in the Home app. A start from
  Siri or an automation, which picks no rooms, still needs the robot on its base first.
- New: if the battery drops to 10% during a clean of a secondary map (or the robot ends a room because its
  battery is low), the plugin ends the clean, sends the robot back to the starting point and logs the rooms
  that were left. The tile shows a low battery error until the robot is on its base or a new clean starts.
- New: **stair detection per room** (a "Detect stairs" switch for every room of a robot with several maps; it
  follows the map's switch until you change it). On the main map one job covers all the picked rooms, so it
  is on if any of them wants it. On a secondary map each room is its own job: it starts with stair
  detection on, and in a room set to off the plugin turns it off a few seconds after the robot is inside,
  and back on as it leaves, is paused or the job ends. It is never off between rooms, on the way to the
  starting point or after the clean. If the robot doesn't take a change, it stays on.
- Changed: **the plugin owns the map.** On a robot with several maps it turns off the Narwal app's
  "Automatically switch to the main map after cleaning" once and leaves it off (a robot with one map keeps
  its setting). Whenever the robot is on its base the plugin switches it to the main map if it is on
  another one, and says so in the log; a failed switch is tried again every minute.
- Changed: the plugin goes by what it knows about where the robot is: the map it started work on, until it
  is back on its base, else the main map. A start with no rooms picked uses the rooms picked last, else the
  map the robot was last sent to, else the main map.
- Changed: a room pick is for one clean. When a clean is over, the Home app goes back to the main map with
  every room picked, so a start from Siri or an automation cleans the whole main map (it is still refused
  while the robot is on a secondary map).
- New: clear refusals on the tile and in the log that send nothing to the robot: "Put the Freo on its base"
  (Return to dock while it stands idle on a secondary map), "The Freo is on Upstairs: put it on its base
  first" (a clean on another map while it is on a secondary map) and "Carry the Freo to Upstairs's starting
  point first" (a clean on a secondary map while the robot is on its base).
- Changed: **secondary maps are vacuum only.** A Mop, Vacuum and Mop or Freo Mind start there is refused
  ("Upstairs: vacuum only"), because there is no base station to wash the mops.
- Changed: a room keeps its plain name unless a room on another map has the same name; then the room on the
  secondary map shows its map's name in brackets, "Corridor (Upstairs)". Room ids are unchanged, so scenes
  and automations keep working.
- Changed: maps are shown in the order of their map numbers on the robot (Cleaning Map picker, settings page,
  log), and the plugin says "map" instead of "floor" everywhere.
- Changed: the return to a map's starting point uses a smaller spot (about 20 cm), so the robot ends closer
  to the P; if the robot refuses it, the plugin tries a bigger one once. It stops as soon as it arrives.
- Fixed: cleans on a third (or later) map ran on the wrong map: the start named map 2 for every secondary
  map. The start now names the map it is meant for.
- Fixed: a clean on a secondary map was stopped seconds after it started ("placed itself on …") while the
  Narwal app was open, because the robot's answer to the app's own map request was taken for the plugin's.
  Only answers to the plugin's own requests count now, and the plugin asks twice before stopping a job.
- New: the Freo Cleaning sensor stays Detected through a whole clean of a secondary map, from the first room
  until the robot is back at the starting point, instead of dropping between rooms.
- Fixed: the trip back to the starting point and the room list always end: when the robot reports an error,
  is back on its base, hasn't set off within a minute, or has been idle for a minute without finishing. Return
  to dock on a secondary map could stay "Returning" for good after an error such as a missing dust bin, with
  Start taken for a Resume and the Narwal app's map setting left off.

### Cleaning

- New: suction can be set to Max (Quiet, Standard, Strong, Max) in the clean modes. Existing settings are
  unchanged.
- Changed: a main map clean sends the picked rooms in the order of the room plan saved in the Narwal app for
  that mode (rooms the plan doesn't list follow); the start line in the log shows the order.
- Changed: the settings page and README explain what Default means for passes, suction and water: what the
  Narwal app has saved for that mode (the same for every room), standard on a secondary map.
- New: the log says how much battery a clean used ("battery 74% → 52%"): in the clean report for a main map
  clean, and in one line at the end of a room list and its trip back.
- New: stair detection is turned back on after every clean, so a robot carried to another level is never left
  without it. A map or room set to have it off still cleans without it.
- Changed: while the base dries the mops the Home app shows that (Cleaning Mop) instead of Charging.

### Fixes

- Fixed: the tile no longer gets stuck on Paused (with only Resume) when the robot is lifted out of its base
  while the base dries the mops: it shows Stopped and you can start a clean.
- New: when the robot drives back to its base by itself (for example after Resume on a paused mop drying in
  the Narwal app or on the robot), the plugin asks the security system first, like for any other move, and
  pauses the robot if there is no OK.
- New: the tile shows an error, and the log a warning, when the Freo can't get back to its base. After a
  clean, Return to dock or a mop wash the robot is expected home within a few times its usual time (the
  plugin learns this from your earlier returns; 10 minutes until it has), so an unplugged base station or
  a blocked path shows "Failed to find charging dock" instead of a tile that keeps saying Returning. It
  clears when the robot reaches the base or starts something new.
- New: the tile shows an error when the robot stops answering. A robot that goes quiet while away from its
  base is woken once and then shown with a low battery error (its battery has most likely run flat), also
  after a Homebridge restart; one that hasn't answered at all since Homebridge started shows "unable to
  complete operation" instead of Ready. It clears as soon as the robot reports again.
- Fixed: a robot charging from 0% showed 100% (and Docked instead of Charging) in the Home app.
- Fixed: after a restart the Home app could show 100% and not charging until the next restart: the vacuum was
  published with made-up starting values. It is now published from the robot's first status (battery
  unknown if the robot hasn't reported within 30 seconds).
- Fixed: a robot charging in its base could show as Stopped and not charging when it didn't send its docked
  flag.
- Fixed: on some Freos every room showed as "Room", "Room 2", … instead of its Narwal app name. Room names
  now also come from the robot's current map, which carries them on every Freo. Room ids, and so Home
  scenes and automations, don't change. (Thanks @linuxliam)

### Settings & logs

- Changed: with more than one map, every log line that names rooms also names their map, and the log says
  whether stair detection is on or off whenever a clean is about to move the robot. Map switches are logged
  at info level.
- Changed: the log names the room when stair detection goes back on after it ("Stair detection back on
  (Kitchen done)") and no longer says "Ending the clean…" when the rooms are done and there is nothing
  left to end.
- Changed: the robot being sent back to its base from the Narwal app or its button is logged as "Returning
  to its base (started outside the Home app)" instead of "Cleaning started outside the Home app".
- Changed: the settings page lists each map and its rooms with name fields and a "Detect
  stairs" switch per room.
- New: the log says when the configured region is unknown, instead of signing in to the US region without a
  word. (Thanks @linuxliam)
- New: the "Matter is not enabled" error shows the `matter` block to add to the child bridge. (Thanks
  @linuxliam)
- README: new "First-time setup", "Room names" and "Multiple maps" sections (how to clean another map, known
  gaps). (Thanks @linuxliam)
- Development: a small test suite (`npm test`) and a GitHub Actions workflow. (Thanks @linuxliam)

## 0.6.1

- Settings page: clean-mode options say Default again (Room setting didn't fit the Home UI's selects).
- README: updated header and device images.
- 0.6.0 wasn't published on npm; updating from 0.4.x brings everything listed under 0.6.0 below.

## 0.6.0

- **Rooms and cleaning plans load by themselves.** The robot only answers requests that look exactly like
  the Narwal app's, so before, they arrived only while the Narwal app was open; the plugin now asks the
  way the app does. You no longer need to open the Narwal app on the map, and map changes you make in the
  Narwal app show up in the Home app and the settings automatically.
- The robot now confirms each command, and the log warns when it refuses one (start, pause, resume,
  return to dock, stop, locate, consumable reset) or doesn't answer within 5 seconds.
- Rooms the Narwal app shows by type get the app's names in title case (Bathroom, Hallway, Living Room,
  Master Bedroom, …); some were wrong before, e.g. a bathroom was called Study. Room numbers are
  unchanged, so scenes and automations keep working, but Siri and the Home app use the new names.
- Settings page: redesigned, with clearer labels, and names for floors and rooms in the Home app.
- Errors the plugin itself puts on the tile (a refused start, for example) clear after a minute, and at
  once when you start, resume or send the robot home, because the Home app hides the vacuum's controls
  while it shows an error. The robot's own errors still clear only when the robot does.

### Multiple floors (in development)

Robots with more than one saved map (for example an upstairs map without a base station) now get every
floor in the Home app. **This is still in development:** it works in testing, but expect rough edges, and
see the README for what's known not to work yet. Robots with one map are not affected.

- The Home app shows a Cleaning Map picker; rooms of the main map keep their ids, so existing scenes and
  automations keep working (other maps' rooms use `map id * 1000 + room id`). Starting a clean on another
  floor switches the robot's map and sets that floor's stair detection first, checking each step;
  anything refused means no start, with an error on the tile.
- Stair detection per floor (on by default for every floor; set it in the settings).
- Floors without a base station: Narwal only allows one zone per job there, so the plugin cleans the
  rooms you pick one at a time, nearest first, each as a zone shaped like the room. The robot limits
  mopping there to about 14 m² per job. Return to dock stops the clean and sends the robot back to the
  floor's starting point (the "P" in the Narwal app). While it works there, the plugin turns off the
  Narwal app's "Automatically switch to the main map after cleaning" and turns it back on afterwards.
- A job the plugin started is stopped, with an error on the tile, if the robot places itself on another
  floor's map.
- Cleaning plans are kept per map. The robot's state file now keeps every map; an older one is converted
  on start.

## 0.4.2

- The log now shows a short report when each clean ends: why it ended (finished, stopped,
  battery too low, …), how much was done, the area and the time.
- Settings page: Vacation mode now comes before Security hold (renamed from Security system).
- The vacation switch name is no longer a setting: it's always "Vacation Mode". An existing setting
  keeps working.
- Vacation mode: after the vacation switch's bridge restarts, the switch is found again within
  30 seconds (it could take up to 10 minutes), and the log says it's back.
- README: header and device images, and badges.

## 0.4.1

- Security hold: a clean started outside the Home app (Narwal app, its schedule, the robot's button), or a
  stopped robot that starts moving again, is checked with the security system as soon as the robot
  leaves its base (or moves). With the OK it carries on; if the security system can't be reached or
  says no, the robot is paused and stays paused (resume it from the Home app). Before, a failed check
  was only logged and the robot kept going.
- Fixed: the robot showed as docked after being taken off its base (to empty the dustbin), and
  Return to dock did nothing. A robot that reports being out of its base now shows as stopped, and
  Return to dock checks the robot's current status instead of the tile.
- Return to dock asks for the security hold before the robot sets off, like a clean, unless the
  robot's hold is still in force (a clean that got the OK and hasn't released it; a stuck robot's
  hold is released after it stands still): the trip home passes the motion sensors, so if the
  security system can't be reached (or says no) the robot stays where it is. A trip home ordered by
  the security plugin itself (Away being armed) doesn't ask either. It was logged as "Cleaning started outside the Home app".
- Cleans started outside the Home app are only checked once the robot leaves its base, not for what
  it reports while in it (the end of a trip home looked like a start).
- Fixed false "Battery: sent …% but the vacuum reports …%" warnings: the check read the value back
  before Homebridge had applied it (the Home app always got the right level). It now waits for it.
- After Return to dock the plugin checks that the robot set off; a robot with an error to clear
  (a jammed brush, say) can ignore it, and the log now says so instead of the tile showing it on
  its way home.

## 0.4.0

- **Vacation mode** (`vacationMode`, `vacationSwitch`): follows a switch named "Vacation Mode" on
  another bridge of the same Homebridge (a homebridge-dummy switch, for example). Once it's turned
  on, the next cleans run as usual (`vacationCleans`, default 1) and later ones started from the Home
  app are refused or run vacuum only (`vacationAfter`) until it's off.
  Needs Homebridge's insecure mode (on by default). Without such a switch, the plugin adds its own
  Vacation Mode switch to its child bridge (HomeKit side).
- The security hold setting is now **Keep security from arming Away while cleaning** (still
  `securityHold`). A hold is about keeping Away off while a robot works: Away asked for in the Home
  app meanwhile waits until the robot is done (homebridge-ecobee-security's Arm Away Now switch
  arms at once and sends it home), and Home and Night aren't held back.
- Security hold: the security plugin can stop a robot that's out when Away is armed in a way it
  can't hold off (the ecobee app, a keypad). The plugin serves `POST /halt` on
  `<storage>/narwal/control.sock` and sends it with each hold (`&halt=`). The robot heads back to its
  base if it can be there before the exit delay ends (`&armAt=`, judged from its distance to the
  base), and pauses where it is if it can't or isn't in 10 seconds before; without `armAt` it pauses
  at once. Once it's in, or paused at the deadline, it tells the security plugin (`/release`), which
  can extend the exit delay to wait for it. A paused robot asks for a new hold when it moves again.
  Supported by homebridge-ecobee-security 0.6.0.
- Security hold: the robot now releases after every hold the security plugin accepted, not only
  when it switched to Home, so the security plugin knows when it's done.
- Security hold: a robot that stops away from its base mid-job (stuck, lifted, paused…) no longer
  keeps the security system in Home until someone frees it. The plugin now follows the robot's
  position (`map/display_map`, in 5-cm map units); once it hasn't moved or turned for **Back to Away
  when a robot stops moving for** (`securityStoppedMinutes`, default 10 minutes; 0 keeps the old
  behaviour), it
  releases its hold, and switches it to Home again as soon as it moves. Time in the base (mop washes,
  recharging) doesn't count.

## 0.3.1

First public release.

- Plugin icon in the README.
