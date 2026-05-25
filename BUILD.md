# Build & development guide

## Quick run (no build)

```
cd web-game
python -m http.server 8000
# open http://localhost:8000/
```

`game.js` is hand-written, no transpiler.  Edit, refresh.

## Headless tests

```
cd web-game
node test_headless.js
```

The harness loads `game.js` in a Node VM with a `document` stub,
executes 150+ scripted scenarios + a 40-run smart-agent simulation,
and exits non-zero on any failure.  Run this before any change.

## Build the desktop .exe (Windows)

```
pip install pyinstaller pillow
cd web-game
python build_desktop.py
```

PyInstaller's `--onefile` mode packs the Python interpreter, the
desktop launcher, every HTML/JS/CSS/JSON file (including the chunk
editor: `editor.html`/`editor.js`/`editor.css`), and the entire
`tiles/` tree into a single ~31 MB `CrawlWeb.exe`.  At launch the
binary extracts to a temp folder, serves itself on a private localhost
port, and opens Microsoft Edge `--app` (or Chrome fallback) pointed at
it.

Smoke-test the bundle:

```
web-game\dist\CrawlWeb.exe --selftest
```

That runs the same data-integrity checks the headless test does but
*inside* the bundled executable.  All asset paths flow through
`sys._MEIPASS` so this catches missing `--add-data` entries.

## Building game-data.json / vaults.json / tiles from DCSS source

These are checked in as built artifacts so the game runs without the
DCSS C++ tree.  If you want to regenerate them from the real DCSS
source (e.g. to pick up changes from upstream), you need the full
DCSS checkout one level up (`crawl-ref/source/`):

```
cd web-game
python build_game_data.py   # rebuilds game-data.json
python build_vaults.py      # rebuilds vaults.json
python build_tiles.py       # rebuilds tiles/manifest.json + copies images
```

## Files you'll most often touch

| File | What's in it |
|---|---|
| `web-game/game.js` | The whole engine -- map gen, render, AI, combat, save. |
| `web-game/style.css` | UI skin (action bar, sidebar, overlays). |
| `web-game/index.html` | UI layout + overlay panels. |
| `web-game/tiles/manifest.json` | Maps tile keys to PNG paths. |
| `web-game/game-data.json` | Monster / species / job / god definitions. |
| `web-game/test_headless.js` | Add a `check(...)` for every new feature. |

## Common pitfalls

* **Anything bundled into the .exe must go through `build_desktop.py`'s
  `--add-data` list.**  If you add a new asset folder, edit the
  `add_data_args` list in `build_desktop.py`.
* **The render uses pixel-perfect tile pasting** -- new tiles must be
  32x32 PNGs.  Larger sources should be pre-resized with aspect
  preserved (see how `MONS_KNIGHT` etc. get resized via PIL in build).
* **`game.js` runs in both browsers AND Node** (for tests).  Don't
  reach for `window.*` or DOM APIs in pure-data code paths.

## Releases

```
cd ..
mkdir release
cp web-game/dist/CrawlWeb.exe release/
# write a README.txt + Play CrawlWeb.bat
powershell -Command "Compress-Archive -Path 'release/*' \
    -DestinationPath 'CrawlWeb-release.zip' -Force"
```
