RPG STONE SOUP -- desktop build
===============================

HOW TO PLAY
-----------
  Double-click `RpgStoneSoup.exe`.
  (Or launch from a command prompt: `RpgStoneSoup.exe`.)

The game opens a windowed Chromium-based view (Microsoft Edge in --app mode,
falling back to Chrome). It serves itself on a private localhost port and
loads its own assets out of the .exe -- no install, no extras, no internet.

WHAT'S BUNDLED
--------------
  RpgStoneSoup.exe          single-file desktop build (~31 MB)
  README.txt                this file
  Play RpgStoneSoup.bat     optional one-click launcher (same as double-click)

GAME CONTROLS
-------------
  Arrow keys / hjkl     move
  yubn                  diagonals
  >  <                  use stairs / branch entrance
  ,  .  5  Space        wait one turn
  s                     set up camp (rest until full HP+MP or interrupted)
  g                     pick up
  q / r                 quaff potion / read scroll
  e                     eat from inventory
  i                     inventory  (clickable list)
  z                     cast a spell
  v                     evoke wand
  f                     throw missile
  p                     pray at altar
  a                     invoke god ability
  Q                     quest log
  M                     world map
  m                     mute / unmute
  ?                     in-game help
  Mouse click           move toward / attack a tile

CHUNK / ROOM EDITOR
-------------------
The build ships with a built-in room editor (paint tiles, drop NPCs,
wire up teleporters, save to localStorage so the game uses your edits
instead of the procedural chunk at that coord).
  - On the title screen, click "Open Chunk Editor".
  - Set cx / cy / floor, paint the map, save.
  - Walk to that (cx,cy) in-game to see your custom chunk.
  - Cellars and upper floors (floor != 0) work too.
  - The art search browses the bundled rltiles set; type a word
    (e.g. "dragon", "altar", "shoals") to see the first 50 matches.

TROUBLESHOOTING
---------------
  First launch is slowest -- PyInstaller unpacks bundled assets to a
  temporary folder. Subsequent launches are quick.

  If a corporate firewall blocks the localhost port, allow
  `RpgStoneSoup.exe` through Windows Defender.

  Saves are kept in your browser's localStorage. Closing the window
  preserves the run; reopen and click `Continue`.

  `--selftest` runs the headless data check and exits without opening
  a window (`RpgStoneSoup.exe --selftest`).

OPEN-SOURCE
-----------
This is the binary release. Sources, build instructions, and the
editor live at https://github.com/wethecom/RpgStoneSoup
(see BUILD.md / CONTRIBUTING.md in the repo).
