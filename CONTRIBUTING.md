# Contributing to Crawl Web

Pull requests welcome.  Quick rules:

1. **Run the tests before pushing.**  From `web-game/`:
   ```
   node test_headless.js
   ```
   The smart-agent run is RNG-flaky; the deterministic checks must
   all pass.

2. **Build the desktop binary if you touched build glue.**
   ```
   python build_desktop.py
   web-game/dist/CrawlWeb.exe --selftest
   ```

3. **License:** all contributions are GPL-2.0-or-later, matching DCSS.

4. **Style:** match the surrounding code.  `game.js` is plain ES2015
   JS, four-space indent, no transpiler, no semicolons-as-statement-
   starters.  CSS / HTML are vanilla.

5. **New features** should add at least one headless `check(...)` so
   regressions get caught.  See the `Surface buildings + friendly
   NPCs + quests` block in `test_headless.js` for the pattern.

6. **New assets** (tiles): 32x32 PNGs only.  Larger sources should
   be resized at build time with aspect preserved (see how
   `knights_tiles/` was processed via PIL).

7. **Don't bundle binary blobs that aren't yours to redistribute.**
   The `npc_32x32/`, `boss/` and `knights*_tiles/` packs ship under
   their own licenses -- preserve any READMEs / LICENSEs that come
   with them.
