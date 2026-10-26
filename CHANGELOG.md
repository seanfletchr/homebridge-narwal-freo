# Changelog

## Unreleased

- Fixed: Return to dock on a floor without a base could stay "Returning" for good if the robot stopped with
  an error on the way (a missing dust bin, say): the Home app then showed the wrong state, Start was taken
  for a Resume, and the Narwal app's "switch to the main map after cleaning" setting stayed off. The trip
  back to the starting point now always ends: when the robot reports an error, is back on its base, hasn't
  set off within a minute, or has been idle for a minute without finishing; and a new clean, or a Home app
  Pause or Resume while nothing is really running, treats it as over. A room queue also ends when the
  robot is on its base or reports an error between rooms.
- On start-up the "switch to the main map" setting is turned back on if the plugin had turned it off and
  the robot is idle.
- Fixed: on some Freos every room showed as "Room", "Room 2", … instead of its Narwal app name. Room
  names now also come from the robot's current map, which carries them on every Freo. Room ids, and so
  Home scenes and automations, don't change. README: new "Room names" section. (Thanks @linuxliam)
- The log now says when the configured region is unknown, instead of signing in to the US region without
  a word. (Thanks @linuxliam)
- The "Matter is not enabled" error now shows the `matter` block to add to the child bridge. (Thanks
  @linuxliam)
- README: new "First-time setup" section (enabling Matter, pairing the vacuum). (Thanks @linuxliam)
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
