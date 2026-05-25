# Crawl Web

A small, complete **tile-based** browser roguelike that runs **entirely
on the structured DCSS export** — every monster, species and background
comes from `LuaInit-safe-dungeon.sqlite3`, the database produced by the
exporter in `tools/`. The graphics are the real DCSS sprite tiles from
`source/rltiles/`. No C++ and no server are involved while you play.

This is the payoff of the export work: proof that the extracted game
knowledge is good enough to *power a real game*, not just describe one.

## Play it

From the repo root (`crawl-ref/`):

```sh
cd web-game
python -m http.server 8099
```

Then open <http://127.0.0.1:8099/> in a browser.

(It must be served over http — opening `index.html` directly with a
`file://` URL is blocked from `fetch`-ing `game-data.json`.)

## Run it as a desktop app

`desktop.py` runs the game in its **own chromeless window** — it
serves the folder on a private localhost port and opens it in Edge or
Chrome in `--app` mode (no tabs, no address bar). Edge's engine is
Chromium, so it is effectively the same as embedding CEF, with none of
the C++ build.

```sh
python web-game/desktop.py
```

To ship it as a single double-click executable that needs no Python:

```sh
pip install pyinstaller
python web-game/build_desktop.py      # -> web-game/dist/CrawlWeb.exe
```

`CrawlWeb.exe` packs the HTML / JS / JSON and the whole `tiles/` folder
inside itself; it only relies on the Chromium browser the machine
already has (Edge ships with Windows). Re-run `build_desktop.py` after
regenerating data so the bundle stays current. Verify a build without
opening a window with `CrawlWeb.exe --selftest`.

## How to play

- **Move / attack:** arrow keys, `hjkl`, `yubn` for diagonals, or the
  numpad. Walk into a monster to attack it.
- **`>`** descends stairs &nbsp;·&nbsp; **`g`** picks up an item
- **`,`** waits a turn &nbsp;·&nbsp; **`q`** then `h`/`m` quaffs a
  healing / might potion &nbsp;·&nbsp; **`r`** then `t`/`f` reads a
  scroll of teleportation / fear &nbsp;·&nbsp; **`i`** lists inventory
- **`z`** casts a spell (caster backgrounds only) — damage spells
  auto-target the nearest monster in sight; Blink is a short hop.
- **`v`** evokes a held wand &nbsp;·&nbsp; **`f`** throws from your
  quiver — both fire at the nearest monster in sight.
- **`m`** mutes sound. Close the tab mid-run and the title screen
  offers **Continue your run** — the game autosaves to `localStorage`.
- Stand on an **altar** and **`p`** to worship its god; kills build
  piety, and **`a`** invokes your god's ability. Six gods, each with a
  passive and an ability (Trog, Okawaru, Makhleb, Elyvilon, the
  Shining One, Vehumet).

Watch for **ranged casters**: monsters with a conjuration spellbook
fire bolts at you on sight, so closing the distance or breaking line
of sight matters. D:2 and D:4 are open **caves** rather than rooms.
- Pick up **armour** (`[`) and **rings** (`=`) — gear equips and the
  piece it replaces is kept in your **backpack**; open the inventory
  (`i`) and press a letter to wield / wear a pack item. Pick up
  **scrolls** (`?`) to read later.
- Walk into a **closed door** (`+`) to open it. Doors block sight and
  movement until opened.
- **Shops** (`$`) appear on some levels — step onto one to browse and
  buy with gold; purchases go to your backpack.
- Watch for **traps** — dart, teleport, alarm and *slow* traps lurk
  hidden in the floor until you spot or spring one (`^`).
- **Status effects** — venomous monsters (snakes, spiders, scorpions,
  wasps, …) can poison you on a melee hit; a slow trap halves your
  energy; a **potion of haste** is the cure for the slow and a real
  combat edge. A healing potion also clears poison. Active statuses
  show in the sidebar with turns remaining.
- **Picking your character matters.** Species carry their real DCSS
  base stats and innate traits: a Troll regenerates very quickly, a
  Minotaur headbutts back when struck, a Gargoyle has heavy innate
  AC, a Deep Dwarf shrugs off part of every hit, a Felid rises once
  from death, any Draconian gains scaling scales. Backgrounds begin
  with kits: Fighter wears scale mail, Berserker already worships
  Trog, Gladiator and Hunter come with a loaded quiver.
- The dungeon is a **branch tree**: descend the 5-level Dungeon trunk
  (`>`) to the **Orb of Zot (`0`)** at its bottom. Gold `>` tiles are
  **branch entrances** — placed at random Dungeon depths each game —
  leading to the Lair, Orcish Mines, Crypt, Vaults, Swamp or Shoals,
  each optional extra danger and loot. `<` climbs back; levels persist.
- Levels carry **terrain**: water lakes (wadeable), lava and tree
  groves (impassable). The Lair has woods, the Swamp is half water.

## What comes from the export

| In-game thing | Export source |
| --- | --- |
| Monster roster (glyph, HP, AC, EV, speed, attacks) | `monster_defs`, `monster_attacks` |
| Monster / floor / wall / item **sprites** | `source/rltiles/` (resolved via `dc-mon.txt` + `dc-tentacles.txt`) |
| Species (HP / MP / WL / XP modifiers) | `species_defs` |
| Backgrounds (starting Str/Int/Dex) | `job_defs` |
| Combat math (to-hit vs EV, per-point AC blocking) | mirrors the exported `fight.cc` helpers |

All **329 / 329** monsters now have a resolved tile (draconians,
tentacles, kraken and other derived monsters are mapped explicitly,
since they live outside `dc-mon.txt`).

The dungeon is **themed per depth**, and the tiles are the real DCSS
branch tiles &mdash; not arbitrary picks. Each depth uses the floor /
wall tile *tokens* that branch's `.des` files in
`source/dat/des/branches/` reference (`lair.des` uses `floor_lair`,
`orc.des` uses `floor_orc`, `vaults.des` uses `floor_vault`, &hellip;),
resolved to PNG variant sets through `dc-floor.txt` / `dc-wall.txt`:

| Depth | Theme | Floor / wall token |
| --- | --- | --- |
| D:1 | Dungeon | `FLOOR_NORMAL` / `WALL_NORMAL` |
| D:2 | Lair | `FLOOR_LAIR` / `WALL_LAIR` |
| D:3 | Orcish Mines | `FLOOR_ORC` / `WALL_ORC` |
| D:4 | Crypt | `FLOOR_CRYPT` / `WALL_CRYPT` |
| D:5 | Vaults | `FLOOR_VAULT` / `WALL_TOMB` |

Within a floor the renderer **autotiles**: each cell picks a
deterministic variant from its theme's tile set, and floor cells draw a
soft shadow against any adjacent wall, so the dungeon reads as raised
stone rather than a flat grid.

Levels are not purely random rooms: each one also stamps in **1-2
authored vaults** &mdash; hand-designed room layouts lifted straight
from the DCSS `.des` files (`source/dat/des/`, the `MAP`/`ENDMAP`
blocks) by `build_vaults.py`. The generator places them into rock and
connects them with corridors, so a dungeon mixes random rectangles with
real Crawl room designs.

A vault keeps its real character, not just its outline:

- **Terrain** &mdash; water (`w`/`W`), lava (`l`) and trees (`t`) are
  preserved as their own tile types. Water is wadeable; lava and trees
  block movement (trees block sight too).
- **Custom tiles** &mdash; the `.des` `FTILE:` / `RTILE:` / `TILE:`
  directives are parsed, so a vault's cells keep their authored floor
  and wall art (grass, moss, checkered stone, sand, marble, &hellip;),
  resolved to real DCSS tiles by `build_tiles.py`.
- **Contents** &mdash; the vault's `MONS:` / `KMONS:` / `KITEM:`
  directives place specific monsters and items (with a depth cap so a
  deep-branch vault can't drop something unfair on an early floor).

The provenance line under the message log shows, live, which export
schema and which `monster_defs` row the monster in view came from. Any
monster whose tile cannot be resolved (~6%) falls back to an ASCII
glyph automatically.

## Files

- `build_game_data.py` — reads the SQLite export, writes `game-data.json`
  (the compact ~130 KB subset the game loads). Re-run after a new
  export: `python web-game/build_game_data.py`.
- `build_tiles.py` — copies the DCSS tile PNGs the game needs from
  `source/rltiles/` into `tiles/`, and writes `tiles/manifest.json`.
  Re-run after `build_game_data.py`: `python web-game/build_tiles.py`.
- `build_vaults.py` — extracts authored room layouts from the DCSS
  `.des` files into `vaults.json`. Run: `python web-game/build_vaults.py`.
- `game-data.json` — generated game data (monsters / species / jobs).
- `vaults.json` — generated vault layouts (~140 rooms).
- `tiles/` — generated sprite art (~2.6 MB) + `manifest.json`.
- `GOALS.md` — the project goals / roadmap checklist.
- `index.html`, `style.css`, `game.js` — the game itself.
- `desktop.py` — runs the game in its own chromeless window.
- `build_desktop.py` — bundles it into `dist/CrawlWeb.exe` (PyInstaller).
- `test_headless.js` — a headless smoke test that loads `game.js` in a
  stubbed DOM and plays full games (a competent BFS agent) to verify
  level generation, FOV, combat, descent, tile loading and win/lose all
  work, and that the game is winnable-but-lethal (~45% win rate for the
  agent). Run: `node web-game/test_headless.js`.

Add `?demo` to the URL (`http://127.0.0.1:8099/?demo`) to auto-start a
game and explore a few steps — handy for a quick look.
