# Crawl Web

A browser-runnable, single-window desktop roguelike built on top of the
**Dungeon Crawl Stone Soup** ([DCSS](https://crawl.develz.org/)) data
export.  It plays in JavaScript in a chromeless browser window, loading
its monster definitions, vault recipes and tile sheets from the same
files DCSS ships.

![Crawl Web](docs/screenshot.png)

## What's here

* A 5-floor procedural Dungeon with the Lair / Orc / Crypt / Vaults /
  Swamp / Shoals side-branches.
* An **endless chunked Surface** above D:1 with biomes (plains, forest,
  mountains, swamp, lake) -- walk off any edge and the world keeps going.
* Procedural **buildings** sprinkled across the Surface: homes, shops,
  manors, mansions, ruins and proper **castles** with curtain walls,
  corner towers, courtyards, gates and inner keeps.
* Friendly **NPCs** (questgivers, shopkeepers, wandering kids), real
  **quests** (kill / fetch / rescue) with a tracked-compass + world map
  (press **M**).
* **Cellars + upper floors** that mirror their source building -- enter
  the stairs of a manor and the second storey is recognisably the same
  house, just with different content.
* **Treasure chests** that drop multi-item loot, **bosses** that loom
  at 2.2x tile size in deep cellars and castle treasuries, and **POIs**
  (wells, shrines, henges, beacons, wishing wells, fruit caches, ...) 
  that drain after one use but stay on the map.
* Camp resting (`s`), region names ("Old Marsh"), persistent saves.

## Run from source (web only)

You need any modern browser plus a static file server (the game uses
`fetch()` for its data, which most browsers refuse on `file://`).

```
cd web-game
python -m http.server 8000
```

Then open <http://localhost:8000/>.

(On Windows you can also just double-click `server.bat` in `web-game/`.)

## Run from source (desktop)

Builds a single-file `.exe` that opens its own chromeless window:

```
cd web-game
pip install pyinstaller pillow
python build_desktop.py
```

The bundled binary lands in `web-game/dist/CrawlWeb.exe`.  Run it from
anywhere -- everything is packed inside (Python, the HTML / JS / CSS,
all 1500+ tiles).

## Tests

```
cd web-game
node test_headless.js
```

A pure-Node harness that loads `game.js` in a VM, runs 150+ scripted
scenarios (combat, vaults, biome spawns, quest accept + turn-in, cellar
descent, chest opening, ...) and an agent simulation across many runs.

## Controls (in-game)

| Key | Action |
|---|---|
| Arrows / hjkl / numpad | move (8 directions) |
| `,` `.` `5` Space | wait one turn |
| `s` | set up camp (rest until full HP/MP or interrupted) |
| `>` `<` | use stairs / enter a branch |
| `g` | pick up |
| `q` then `h`/`m` | quaff healing / might |
| `r` then `t`/`f` | read teleport / fear |
| `v` `f` `z` | evoke wand / throw / cast spell |
| `p` `a` | pray at altar / invoke god |
| `i` | inventory |
| `Q` | quest log |
| **`M`** | **world map** |
| `m` | mute / unmute |
| `?` | in-game help |
| Mouse | click to walk / attack; click yourself to wait |

## Project layout

```
web-game/
  index.html          single-page UI (canvas + sidebar + overlays)
  style.css           dark roguelike skin
  game.js             the whole engine: gen, combat, AI, UI, save
  game-data.json      monster + species + job + god defs (DCSS export)
  vaults.json         vault recipes (handlers for des-style maps)
  tiles/              all 32x32 sprites used in render
    dngn/             floor / wall / door / decor (themes + variants)
    item/             potions, scrolls, gold, weapons, ...
    mon/              monster sprites (MONS_<NAME>.png)
    npc_32x32/        friendly NPC portraits
    boss/             large boss sprites (rendered at 2.2x)
    knights_tiles/    soldier / knight / spearman / crossbowman source
    knights2_tiles/   older soldier set (unused)
    roof/             building roof variants
  desktop.py          chromeless-browser launcher (Edge --app fallback Chrome)
  build_desktop.py    PyInstaller wrapper -> CrawlWeb.exe
  build_game_data.py  rebuilds game-data.json from DCSS source/
  build_vaults.py     rebuilds vaults.json from DCSS source/dat/des/
  build_tiles.py      rebuilds tiles/manifest.json + copies images
  test_headless.js    pure-Node test harness
```

## Acknowledgements

* All monster stats, attack flavours, religion lines, vault recipes and
  most of the tile art come from
  [Dungeon Crawl Stone Soup](https://crawl.develz.org/) (GPL-2.0+).
* Additional sprite sets (`npc_32x32/`, `boss/`, `knights_tiles/`) come
  from various CC-licensed pixel-art packs.  See each subfolder for
  origin if redistributing the art separately.

## License

GPL-2.0-or-later, matching DCSS.  See `LICENSE`.
