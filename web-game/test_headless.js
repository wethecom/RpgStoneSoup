/* Headless smoke test for the web-game.
 *
 * Loads game.js inside a vm context with stubbed DOM + fetch, then
 * drives an actual playthrough with randomised input and asserts the
 * core systems work: char creation, movement, FOV, combat, descent,
 * and that the game terminates. Run: node web-game/test_headless.js
 */

"use strict";
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const DIR = __dirname;
const gameData = fs.readFileSync(path.join(DIR, "game-data.json"), "utf8");
let tileManifest = null;
try {
  tileManifest = fs.readFileSync(path.join(DIR, "tiles", "manifest.json"), "utf8");
} catch (e) { /* tiles optional */ }
let vaultsData = null;
try {
  vaultsData = fs.readFileSync(path.join(DIR, "vaults.json"), "utf8");
} catch (e) { /* vaults optional */ }

/* ---- minimal DOM stub ---- */
class StubEl {
  constructor(tag) {
    this.tagName = tag || "div";
    this._text = "";
    this._html = "";
    this.className = "";
    this.value = "0";
    this.selectedIndex = 0;
    this.disabled = false;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.children = [];
    this.style = {};
    this.classList = {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      toggle(c, on) { if (on === undefined) on = !this._set.has(c);
        on ? this._set.add(c) : this._set.delete(c); return on; },
      contains(c) { return this._set.has(c); },
    };
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); if (v === "") this.children = []; }
  appendChild(c) { this.children.push(c); return c; }
  addEventListener() {}
  focus() {}
  // a fixed on-screen rect so click-coordinate math can be tested
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 38 * 26, height: 22 * 26,
             right: 38 * 26, bottom: 22 * 26 };
  }
}

const elements = {};
function getEl(id) {
  if (!elements[id]) elements[id] = new StubEl("div#" + id);
  return elements[id];
}

const documentStub = {
  getElementById: getEl,
  createElement: (tag) => new StubEl(tag),
  addEventListener: () => {},
};

let fetchCalls = 0;
function fetchStub(url) {
  fetchCalls++;
  if (String(url).includes("manifest")) {
    if (!tileManifest) {
      return Promise.resolve({ ok: false, status: 404, json: () => null });
    }
    return Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve(JSON.parse(tileManifest)),
    });
  }
  if (String(url).includes("vaults")) {
    if (!vaultsData) {
      return Promise.resolve({ ok: false, status: 404, json: () => null });
    }
    return Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve(JSON.parse(vaultsData)),
    });
  }
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(JSON.parse(gameData)),
  });
}

/* Image stub: "loads" immediately so preloadTiles() resolves. The
 * headless canvas has no 2D context, so no pixels are ever drawn --
 * this just exercises the tile-loading bookkeeping. */
class StubImage {
  constructor() {
    this.complete = false;
    this.naturalWidth = 0;
    this._src = "";
  }
  set src(v) {
    this._src = v;
    this.complete = true;
    this.naturalWidth = 32;
    if (this.onload) setTimeout(() => this.onload(), 0);
  }
  get src() { return this._src; }
}

/* ---- vm context ---- */
// a minimal in-memory localStorage so save/resume can be exercised
const storageStub = (() => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
})();

const sandbox = {
  document: documentStub,
  fetch: fetchStub,
  Image: StubImage,
  localStorage: storageStub,
  console,
  Math, JSON, Array, Object, String, Number, Boolean, Error,
  Promise, setTimeout, clearTimeout, setInterval, clearInterval,
  globalThis: null,
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
vm.createContext(sandbox);

let src = fs.readFileSync(path.join(DIR, "game.js"), "utf8");
// expose internals for the harness (same lexical scope as the let bindings)
src += `
;globalThis.__api = {
  get G() { return G; },
  get DATA() { return DATA; },
  get MANIFEST() { return MANIFEST; },
  get TILEIMG() { return TILEIMG; },
  get charsel() { return G_CHARSEL; },
  get hoverTile() { return hoverTile; },
  startGame, tryMovePlayer, endTurn, tryDescend, doPickup, checkWin,
  computeFOV, findPath, handleTileClick, onCanvasClick, doAction,
  tryAscend, turnInQuest, makeQuestForNPC, openNPCDialog,
  ensureSurfaceChunk, enterLevel,
  tryStealth, stealthScore, dropCarriedBody,
  timeOfDay, timeLabel, DAY_LENGTH,
  paintBuildCell, ensurePlayerHome, savePlayerHome, loadPlayerHome,
  toggleBuildMode, openBuildMode, closeBuildMode,
  setRealtime, toggleRealtime, REALTIME_TICK_MS,
  moonPhase, moonPhaseName, moonStealthMod,
  maybeNightRaid,
  MAP_W, MAP_H, TRUNK_LEVELS, VIEW_W, VIEW_H, TILE,
};
`;

vm.runInContext(src, sandbox, { filename: "game.js" });

/* ---- assertions ---- */
let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log("  ok   " + name);
  } else {
    console.log("  FAIL " + name);
    failures++;
  }
}

async function main() {
  // let boot()'s async fetches + tile preload settle
  await new Promise(r => setTimeout(r, 300));
  const api = sandbox.__api;

  check("game data fetched", fetchCalls >= 1);
  check("DATA loaded", api.DATA && api.DATA.monsters.length > 100);
  check("char select populated", api.charsel.species.length > 0 &&
        api.charsel.jobs.length > 0);
  if (tileManifest) {
    check("tile manifest loaded", !!api.MANIFEST &&
          Object.keys(api.MANIFEST.monsters || {}).length > 100);
    check("tile images preloaded into cache",
          Object.keys(api.TILEIMG || {}).length > 100);
  }

  // start a game as the first feature species/job
  const sp = api.charsel.species[0];
  const jb = api.charsel.jobs[0];
  api.startGame(sp, jb);
  let G = api.G;
  check("game started", !!G && !!G.player);
  check("player has positive HP", G.player.hp > 0 && G.player.hp === G.player.hpMax);
  check("first level generated", !!G.level && G.depth === 1);
  check("monsters spawned", G.monsters.length > 0);
  check("items spawned", G.items.length > 0);
  check("FOV reveals player tile", G.visible[G.player.y][G.player.x] === true);
  check("player not stuck in wall", G.level.tiles[G.player.y][G.player.x] !== 0);
  // stealth basics: score positive, toggle works, cooldown after break
  check("stealthScore returns a positive integer",
        api.stealthScore(G.player) > 0);
  G.player.stealthCD = 0;
  G.player.stealthed = false;
  api.tryStealth();
  check("tryStealth flips player into sneaking mode", G.player.stealthed === true);
  // simulate detection break -- find a nearby monster and fire the
  // wake check (we'll just call breakStealth indirectly by calling
  // tryStealth a second time which toggles off, then verify CD path)
  api.tryStealth();
  check("toggling stealth a second time turns it off", !G.player.stealthed);
  // carry-one-body cap: simulate a corpse on the player's tile, pick
  // it up, try to pick up a second, verify the second is refused
  G.player.carriedBody = null;
  // clear anything else at the player's tile so doPickup grabs OUR corpse
  G.items = G.items.filter(i => !(i.x === G.player.x && i.y === G.player.y));
  const fakeCorpseA = {
    key: "corpse", name: "rat's body", corpseName: "rat",
    fromKill: true, x: G.player.x, y: G.player.y,
    glyph: "%", colour: "ETC_BLOOD",
  };
  G.items.push(fakeCorpseA);
  api.doPickup();
  check("picking up a corpse fills player.carriedBody",
        !!G.player.carriedBody && G.player.carriedBody.name === "rat's body");
  // second corpse on the same tile
  const fakeCorpseB = {
    key: "corpse", name: "bat's body", corpseName: "bat",
    fromKill: true, x: G.player.x, y: G.player.y,
    glyph: "%", colour: "ETC_BLOOD",
  };
  G.items.push(fakeCorpseB);
  api.doPickup();
  check("a second body refuses to be carried (one-body cap)",
        G.player.carriedBody && G.player.carriedBody.name === "rat's body");
  // clean up the second corpse + drop the first
  G.items = G.items.filter(i => i !== fakeCorpseB);
  // carrying a body should penalise stealth
  const sWithBody = api.stealthScore(G.player);
  G.player.carriedBody = null;
  const sNoBody = api.stealthScore(G.player);
  check("stealthScore drops by 3 when carrying a body",
        sNoBody - sWithBody === 3);
  // restore for the rest of the run
  G.items = G.items.filter(i => i.key !== "corpse");
  // time-of-day cycles through dawn/day/dusk/night across 300 turns,
  // and being outdoors at night gives the stealth bonus.
  const day = api.DAY_LENGTH;
  const saveTurn = G.turn;
  const saveBranch = G.branch;
  // force outdoors so the time bonus actually applies
  G.branch = "Surface";
  G.turn = 100;  check("dawn phase at turn 100",   api.timeOfDay().phase === "dawn");
  G.turn = 600;  check("day phase at turn 600",    api.timeOfDay().phase === "day");
  G.turn = 1600; check("dusk phase at turn 1600",  api.timeOfDay().phase === "dusk");
  G.turn = 2000; check("night phase at turn 2000", api.timeOfDay().phase === "night");
  // day 0 has a NEW moon (phase 0) -- +2 stealth mod at night on top
  // of the +3 night-time bonus, so night sneak is +5 over noon.
  const sNoon = (G.turn = 600, api.stealthScore(G.player));
  const sNight = (G.turn = 2000, api.stealthScore(G.player));
  check("stealth gains +5 on a new-moon night vs noon",
        sNight - sNoon === 5);
  // day 2 hits a quarter moon (phase 2) -- moon mod is 0, so just +3
  const sNoon2 = (G.turn = 5400, api.stealthScore(G.player));
  const sNight2 = (G.turn = 6600, api.stealthScore(G.player));
  check("stealth gains +3 on a quarter-moon night vs noon",
        sNight2 - sNoon2 === 3);
  // moon phase rolls through 8 phases on consecutive days
  const moonTurnSave = G.turn;
  G.turn = 0;          check("moon phase day 0 = new", api.moonPhase() === 0);
  G.turn = 2400 * 4;   check("moon phase day 4 = full", api.moonPhase() === 4);
  G.turn = 2400 * 8;   check("moon phase day 8 wraps to new", api.moonPhase() === 0);
  G.turn = moonTurnSave;
  // night raids: at night, on the player's home chunk, hostiles
  // occasionally drift in from a chunk edge. Stash and restore the
  // live branch/level so later tests still see D:1.
  const saveBranchR = G.branch;
  const saveLevelR = G.level;
  const saveMonstersR = G.monsters;
  const saveCoordR = G.surfaceCoord ? { ...G.surfaceCoord } : null;
  const savePlayerR = { x: G.player.x, y: G.player.y };
  G.branch = "Surface";
  G.surfaceCoord = { cx: 0, cy: 0 };
  sandbox.ensureSurfaceChunk(0, 0);
  const surfEntry = G.levels["Surface:0,0"];
  G.level = surfEntry.level;
  G.monsters = surfEntry.monsters;
  const fakeHome = api.ensurePlayerHome();
  fakeHome.hearth = { cx: 0, cy: 0, x: 5, y: 5 };
  api.savePlayerHome(fakeHome);
  // place player far from the edges so the raid spawn passes its
  // "at least 12 tiles from player" guard
  G.player.x = 28; G.player.y = 13;
  G.turn = 2200;
  const beforeCount = G.monsters.length;
  for (let i = 0; i < 25; i++) {
    G.turn = 2200;
    api.maybeNightRaid();
  }
  check("night raid eventually spawns a hostile on the home chunk",
        G.monsters.length > beforeCount);
  // restore all the state we touched
  sandbox.localStorage.removeItem("crawlweb.playerHome");
  G.branch = saveBranchR;
  G.level = saveLevelR;
  G.monsters = saveMonstersR;
  if (saveCoordR) G.surfaceCoord = saveCoordR;
  G.player.x = savePlayerR.x; G.player.y = savePlayerR.y;
  G.turn = saveTurn; G.branch = saveBranch;
  // build mode: opens, paints a wall, persists into playerHome, closes
  sandbox.localStorage.removeItem("crawlweb.playerHome");
  api.openBuildMode();
  check("buildMode flag flips on", G.buildMode === true);
  // give materials so the wall is affordable
  const h0 = api.ensurePlayerHome();
  h0.materials = { wood: 50, stone: 50 };
  api.savePlayerHome(h0);
  // make sure we're on Surface so the snapshot path runs
  G.branch = "Surface";
  G.surfaceCoord = G.surfaceCoord || { cx: 0, cy: 0 };
  // ensure the tile exists in G.level (paintBuildCell needs G.level.tiles)
  if (G.level && G.level.tiles) {
    G.level.tiles[5][5] = 1;
    // pick the WALL brush by toggling the global G.buildBrush field
    G.buildBrush = { t: 0, name: "Wall", costs: { stone: 1 } };
    const painted = api.paintBuildCell(5, 5, false);
    check("paintBuildCell places the brush", painted === true &&
          G.level.tiles[5][5] === 0);
    // affordability: drain stone and try again, should fail
    const h1 = api.ensurePlayerHome();
    h1.materials.stone = 0;
    api.savePlayerHome(h1);
    G.level.tiles[6][5] = 1;
    const refused = api.paintBuildCell(5, 6, false);
    check("paintBuildCell refuses when materials insufficient",
          refused === false && G.level.tiles[6][5] === 1);
    // erasing a wall should yield stone
    const before = api.loadPlayerHome().materials.stone | 0;
    api.paintBuildCell(5, 5, true);    // erase the wall we just placed
    const after = api.loadPlayerHome().materials.stone | 0;
    check("erasing a wall yields +1 stone",
          after === before + 1);
  }
  api.closeBuildMode();
  check("buildMode flag flips off", !G.buildMode);
  sandbox.localStorage.removeItem("crawlweb.playerHome");
  // real-time mode: flag flips, interval persists across toggles
  api.setRealtime(true);
  check("setRealtime(true) flips G.realtime on", G.realtime === true);
  api.setRealtime(false);
  check("setRealtime(false) flips G.realtime off", G.realtime === false);
  api.toggleRealtime();
  check("toggleRealtime swings the flag", G.realtime === true);
  api.toggleRealtime();   // back off for the rest of the suite
  check("toggleRealtime back off", G.realtime === false);
  // murder-detection: a neutral guard who sees a `wasNpc` corpse
  // turns hostile and alerts squadmates
  const fakeGuard = {
    name: "watchman",
    def: { id: "MONS_WATCHMAN", hd: 5, attacks: [{ dam: 6 }] },
    x: G.player.x + 2, y: G.player.y,
    hp: 20, hpMax: 20, ac: 3, ev: 8,
    awake: false, neutral: true, guardsChest: null,
    glyph: "@", colour: "WHITE",
  };
  G.monsters.push(fakeGuard);
  G.items.push({
    key: "corpse", name: "villager's body", corpseName: "villager",
    fromKill: true, wasNpc: true,
    x: G.player.x + 3, y: G.player.y,
    glyph: "%", colour: "ETC_BLOOD",
  });
  // run the guard's turn directly
  if (sandbox.monsterAct) {
    sandbox.monsterAct(fakeGuard);
    check("a neutral guard who sees an NPC corpse turns hostile",
          fakeGuard.neutral === false && fakeGuard.awake === true);
  }
  // clean up the test pieces
  G.monsters = G.monsters.filter(m => m !== fakeGuard);
  G.items = G.items.filter(i => i.key !== "corpse");

  // verify the level is connected: flood-fill from the player must
  // reach the down-stairs.
  function connected(lvl, sx, sy) {
    const seen = Array.from({ length: api.MAP_H }, () =>
      new Array(api.MAP_W).fill(false));
    const stack = [[sx, sy]];
    let stairs = false;
    while (stack.length) {
      const [x, y] = stack.pop();
      if (x < 0 || y < 0 || x >= api.MAP_W || y >= api.MAP_H) continue;
      if (seen[y][x]) continue;
      // walls (0), lava (7) and trees (8) block; doors/water do not
      const tt = lvl.tiles[y][x];
      if (tt === 0 || tt === 7 || tt === 8) continue;
      seen[y][x] = true;
      if (tt === 2) stairs = true;
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
    return stairs;
  }
  check("level 1 down-stairs reachable", connected(G.level, G.player.x, G.player.y));

  // drive a randomised playthrough
  const DIRS = [[0,-1],[0,1],[-1,0],[1,0],[-1,-1],[1,-1],[-1,1],[1,1]];
  let moved = 0, attacked = 0, descended = 0, picked = 0, crashed = null;
  let maxTurns = 6000;
  try {
    for (let step = 0; step < maxTurns && !api.G.over; step++) {
      G = api.G;
      const before = { x: G.player.x, y: G.player.y, mon: G.monsters.length,
                       depth: G.depth };
      // try to descend if on stairs
      if (G.level.tiles[G.player.y][G.player.x] === 2 && Math.random() < 0.5) {
        if (api.tryDescend()) { descended++; continue; }
      }
      // pick up if standing on an item
      if (G.items.some(i => i.x === G.player.x && i.y === G.player.y)
          && Math.random() < 0.6) {
        if (api.doPickup()) { picked++; api.endTurn(); continue; }
      }
      const [dx, dy] = DIRS[(Math.random() * 8) | 0];
      const ok = api.tryMovePlayer(dx, dy);
      if (ok) {
        if (G.player.x !== before.x || G.player.y !== before.y) moved++;
        if (G.monsters.length < before.mon) attacked++;
        if (!api.checkWin()) api.endTurn();
      }
    }
  } catch (e) {
    crashed = e;
  }

  check("no crash during playthrough", crashed === null);
  if (crashed) console.log("    " + crashed.stack);
  check("player moved", moved > 5);
  G = api.G;
  check("game terminated or made deep progress",
        G.over || G.depth >= 3 || G.turn > 500);
  check("turn counter advanced", G.turn > 0);
  console.log(`\n  stats: moved=${moved} attacked=${attacked} ` +
              `descended=${descended} pickedUp=${picked} ` +
              `finalDepth=${G.depth} turns=${G.turn} ` +
              `over=${G.over} won=${G.won}`);

  // a second game to a forced deep descent: verify all 8 levels build
  api.startGame(api.charsel.species[1] || sp, api.charsel.jobs[1] || jb);
  let deepOk = true;
  try {
    for (let d = 1; d < api.TRUNK_LEVELS; d++) {
      // teleport player onto the down stairs and descend
      const lvl = api.G.level;
      let found = null;
      for (let y = 0; y < api.MAP_H && !found; y++)
        for (let x = 0; x < api.MAP_W && !found; x++)
          if (lvl.tiles[y][x] === 2) found = { x, y };
      if (!found && d < api.TRUNK_LEVELS) { deepOk = false; break; }
      if (found) { api.G.player.x = found.x; api.G.player.y = found.y; }
      if (!api.tryDescend()) { deepOk = false; break; }
    }
  } catch (e) {
    deepOk = false;
    console.log("    deep-descent crash: " + e.message);
  }
  check("all " + api.TRUNK_LEVELS + " levels generate + descend", deepOk);
  check("reached D:" + api.TRUNK_LEVELS, api.G.depth === api.TRUNK_LEVELS);
  check("Orb placed on deepest level", !!api.G.orbPos);

  /* ---- vaults: authored .des layouts stamped into levels ---- */
  if (vaultsData) {
    check("vaults.json loaded with vaults",
          JSON.parse(vaultsData).vaults.length > 20);
    // generate many fresh levels; vaults should appear and every
    // level must stay fully connected (stairs reachable from start).
    let levelsWithVaults = 0, totalLevels = 0, allConnected = true;
    let vaultMonSlots = 0, vaultMonsPlaced = 0;
    for (let run = 0; run < 12; run++) {
      api.startGame(api.charsel.species[0], api.charsel.jobs[0]);
      for (let d = 1; d <= api.TRUNK_LEVELS; d++) {
        const lvl = api.G.level;
        totalLevels++;
        if (lvl.vaultCount > 0) levelsWithVaults++;
        if (!connected(lvl, api.G.player.x, api.G.player.y) &&
            d < api.TRUNK_LEVELS) {
          allConnected = false;
        }
        // count vault-authored monsters that actually made it onto
        // the map (placeVaultContent ran during descend)
        for (const vm of (lvl.vaultMons || [])) {
          vaultMonSlots++;
          if (api.G.monsters.some(m => m.x === vm.x && m.y === vm.y)) {
            vaultMonsPlaced++;
          }
        }
        // hop to the down stairs and descend
        let s = null;
        for (let y = 0; y < api.MAP_H && !s; y++)
          for (let x = 0; x < api.MAP_W && !s; x++)
            if (lvl.tiles[y][x] === 2) s = { x, y };
        if (!s) break;
        api.G.player.x = s.x; api.G.player.y = s.y;
        if (!api.tryDescend()) break;
      }
    }
    check("vaults are placed into generated levels (" +
          levelsWithVaults + "/" + totalLevels + " levels)",
          levelsWithVaults > totalLevels * 0.5);
    check("levels with vaults stay fully connected", allConnected);
    check("vault-authored monsters are placed on the map (" +
          vaultMonsPlaced + "/" + vaultMonSlots + " slots)",
          vaultMonSlots > 0 && vaultMonsPlaced > 0);
  }

  /* ---- doors (tile 4 = closed, 5 = open) ---- */
  let doorLevels = 0, lvlsWithDoors = 0, totalDoors = 0;
  for (let run = 0; run < 8; run++) {
    api.startGame(api.charsel.species[0], api.charsel.jobs[0]);
    for (let d = 1; d <= api.TRUNK_LEVELS; d++) {
      const lvl = api.G.level;
      doorLevels++;
      let dn = 0;
      for (let y = 0; y < api.MAP_H; y++)
        for (let x = 0; x < api.MAP_W; x++)
          if (lvl.tiles[y][x] === 4 || lvl.tiles[y][x] === 5) dn++;
      totalDoors += dn;
      if (dn > 0) lvlsWithDoors++;
      let s = null;
      for (let y = 0; y < api.MAP_H && !s; y++)
        for (let x = 0; x < api.MAP_W && !s; x++)
          if (lvl.tiles[y][x] === 2) s = { x, y };
      if (!s) break;
      api.G.player.x = s.x; api.G.player.y = s.y;
      if (!api.tryDescend()) break;
    }
  }
  check("doors are placed in levels (" + lvlsWithDoors + "/" +
        doorLevels + " levels, " + totalDoors + " doors)",
        totalDoors > 0 && lvlsWithDoors > doorLevels * 0.3);
  // walking into a closed door opens it
  api.startGame(api.charsel.species[0], api.charsel.jobs[0]);
  let doorOpened = false;
  const dlvl = api.G.level;
  outer:
  for (let y = 1; y < api.MAP_H - 1; y++) {
    for (let x = 1; x < api.MAP_W - 1; x++) {
      if (dlvl.tiles[y][x] !== 4) continue;
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const ax = x - dx, ay = y - dy;
        if (dlvl.tiles[ay] && dlvl.tiles[ay][ax] === 1 &&
            !api.G.monsters.some(m => m.x === ax && m.y === ay)) {
          api.G.player.x = ax; api.G.player.y = ay;
          api.tryMovePlayer(dx, dy);
          doorOpened = dlvl.tiles[y][x] === 5;
          break outer;
        }
      }
    }
  }
  check("walking into a closed door opens it", doorOpened);

  /* ---- vault terrain & custom tiles ---- */
  let waterN = 0, lavaN = 0, treeN = 0, artN = 0;
  for (let run = 0; run < 10; run++) {
    api.startGame(api.charsel.species[0], api.charsel.jobs[0]);
    for (let d = 1; d <= api.TRUNK_LEVELS; d++) {
      const lvl = api.G.level;
      for (let y = 0; y < api.MAP_H; y++)
        for (let x = 0; x < api.MAP_W; x++) {
          const t = lvl.tiles[y][x];
          if (t === 6) waterN++;
          else if (t === 7) lavaN++;
          else if (t === 8) treeN++;
        }
      artN += Object.keys(lvl.tileArt || {}).length;
      let s = null;
      for (let y = 0; y < api.MAP_H && !s; y++)
        for (let x = 0; x < api.MAP_W && !s; x++)
          if (lvl.tiles[y][x] === 2) s = { x, y };
      if (!s) break;
      api.G.player.x = s.x; api.G.player.y = s.y;
      if (!api.tryDescend()) break;
    }
  }
  // lava is only placed by some Orc/Vaults vaults; the trunk-only
  // descent may not see any, so require any *two* of the three.
  check("vault terrain appears: water / lava / trees (" +
        waterN + " / " + lavaN + " / " + treeN + ")",
        (waterN > 0) + (lavaN > 0) + (treeN > 0) >= 2);
  check("vaults carry authored custom floor/wall tiles (" + artN + ")",
        artN > 0);
  // terrain passability rules: water wadeable, lava and trees are not
  check("water is wadeable but lava and trees block movement",
        sandbox.passable({ tiles: [[6]] }, 0, 0) === true &&
        sandbox.passable({ tiles: [[7]] }, 0, 0) === false &&
        sandbox.passable({ tiles: [[8]] }, 0, 0) === false);

  /* ---- cave layouts ---- */
  let sawCave = false;
  for (let run = 0; run < 12 && !sawCave; run++) {
    api.startGame(api.charsel.species[0], api.charsel.jobs[0]);
    for (let d = 1; d <= api.TRUNK_LEVELS; d++) {
      if (api.G.level.isCave) sawCave = true;
      let s = null;
      for (let y = 0; y < api.MAP_H && !s; y++)
        for (let x = 0; x < api.MAP_W && !s; x++)
          if (api.G.level.tiles[y][x] === 2) s = { x, y };
      if (!s) break;
      api.G.player.x = s.x; api.G.player.y = s.y;
      if (!api.tryDescend()) break;
    }
  }
  check("cave layouts are generated on some depths", sawCave);

  /* ---- branches: a tree off the Dungeon trunk ---- */
  function findTileXY(lvl, kind) {
    for (let y = 0; y < api.MAP_H; y++)
      for (let x = 0; x < api.MAP_W; x++)
        if (lvl.tiles[y][x] === kind) return { x, y };
    return null;
  }
  api.startGame(api.charsel.species[0], api.charsel.jobs[0]);
  check("branch entrances are rolled for the run",
        api.G.branchEntries &&
        Object.keys(api.G.branchEntries).length > 0);
  // descend the trunk, find a branch entrance (tile 10), go in & out
  let branchEntered = false, branchReturned = false;
  for (let d = 1; d < api.TRUNK_LEVELS; d++) {
    const bt = findTileXY(api.G.level, 10);     // T.BRANCH
    if (bt) {
      api.G.player.x = bt.x; api.G.player.y = bt.y;
      api.tryDescend();
      branchEntered = api.G.branch !== "D" && api.G.depth === 1;
      if (branchEntered) {
        const up = findTileXY(api.G.level, 3);  // T.STAIRS_UP
        if (up) {
          api.G.player.x = up.x; api.G.player.y = up.y;
          sandbox.tryAscend();
          branchReturned = api.G.branch === "D";
        }
      }
      break;
    }
    const s = findTileXY(api.G.level, 2);       // T.STAIRS_DOWN
    if (!s) break;
    api.G.player.x = s.x; api.G.player.y = s.y;
    api.tryDescend();
  }
  check("a branch can be entered from the Dungeon", branchEntered);
  check("you can climb back out of a branch", branchReturned);
  // level persistence: revisiting a level restores the same object
  api.startGame(api.charsel.species[0], api.charsel.jobs[0]);
  const d1Level = api.G.level;
  const ds = findTileXY(api.G.level, 2);
  let persisted = false;
  if (ds) {
    api.G.player.x = ds.x; api.G.player.y = ds.y;
    api.tryDescend();                            // -> D:2
    const us = findTileXY(api.G.level, 3);
    if (us) {
      api.G.player.x = us.x; api.G.player.y = us.y;
      sandbox.tryAscend();                       // -> D:1 again
      persisted = api.G.level === d1Level && api.G.depth === 1;
    }
  }
  check("levels persist and restore on revisit", persisted);

  /* ---- monster ranged attacks ---- */
  const rangedDefs = api.DATA.monsters.filter(m => m.ranged);
  check("the roster includes ranged casters (" + rangedDefs.length + ")",
        rangedDefs.length > 10);
  // ranged monsters carry their real spellbook's offensive spells
  const withSpells = rangedDefs.filter(
    m => m.ranged_spells && m.ranged_spells.length > 0 &&
         m.ranged_spells[0].title && m.ranged_spells[0].level);
  check("ranged casters carry their spellbook's spells (" +
        withSpells.length + "/" + rangedDefs.length + ")",
        withSpells.length > rangedDefs.length * 0.7);
  api.startGame(api.charsel.species[0], api.charsel.jobs[0]);
  api.G.player.hp = api.G.player.hpMax = 300;
  const boltMon = { name: "test caster", x: 0, y: 0,
                    def: { hd: 12, ranged: true, attacks: [],
                           ranged_spells: [{ title: "Iron Shot", level: 6 }] } };
  const hpBeforeBolt = api.G.player.hp;
  for (let i = 0; i < 50 && api.G.player.hp === hpBeforeBolt; i++) {
    sandbox.monsterBolt(boltMon);
  }
  check("a ranged monster's spell can damage the player",
        api.G.player.hp < hpBeforeBolt);

  /* ---- save / resume ---- */
  api.startGame(api.charsel.species[0], api.charsel.jobs[0]);
  api.G.player.kills = 99;
  const savedDepth = api.G.depth;
  sandbox.saveGame();
  const saved = sandbox.loadSave();
  check("the run is written to storage",
        !!saved && saved.player.kills === 99 && saved.depth === savedDepth);
  api.G.player.kills = 5;            // an in-memory change that was not saved
  const resumed = sandbox.continueGame();
  check("continuing restores the saved run from storage",
        resumed && api.G.player.kills === 99 &&
        api.G.depth === savedDepth);

  /* ---- sound ---- */
  check("sound effects and a mute toggle exist",
        typeof sandbox.sfx === "function" &&
        typeof sandbox.toggleSound === "function");
  let sfxThrew = false;
  try { sandbox.sfx("hit"); sandbox.sfx("descend"); }
  catch (e) { sfxThrew = true; }
  check("sfx is safe with no audio device", !sfxThrew);
  sandbox.toggleSound();
  check("muting persists a sound preference",
        sandbox.localStorage.getItem("crawlweb.sound") === "0");
  sandbox.toggleSound();             // restore for the rest of the run

  /* ---- gods & religion ---- */
  check("the export provides gods", api.DATA.gods.length >= 6);
  // altars are placed in the dungeon
  let altarLevels = 0, altarLvlScan = 0, anyAltarGod = false;
  for (let run = 0; run < 10; run++) {
    api.startGame(api.charsel.species[0], api.charsel.jobs[0]);
    for (let d = 1; d <= api.TRUNK_LEVELS; d++) {
      const lvl = api.G.level;
      altarLvlScan++;
      let hasAltar = false;
      for (let y = 0; y < api.MAP_H; y++)
        for (let x = 0; x < api.MAP_W; x++)
          if (lvl.tiles[y][x] === 9) hasAltar = true;
      if (hasAltar) altarLevels++;
      if (lvl.altarGod) anyAltarGod = true;
      let s = null;
      for (let y = 0; y < api.MAP_H && !s; y++)
        for (let x = 0; x < api.MAP_W && !s; x++)
          if (lvl.tiles[y][x] === 2) s = { x, y };
      if (!s) break;
      api.G.player.x = s.x; api.G.player.y = s.y;
      if (!api.tryDescend()) break;
    }
  }
  check("altars are placed in the dungeon (" + altarLevels + "/" +
        altarLvlScan + " levels)", altarLevels > 0 && anyAltarGod);
  // praying at an altar joins the god
  api.startGame(api.charsel.species[0], api.charsel.jobs[0]);
  api.G.level.tiles[api.G.player.y][api.G.player.x] = 9;
  api.G.level.altarGod = "GOD_TROG";
  api.G.player.god = null;
  const prayed = sandbox.prayAtAltar();
  check("praying at an altar joins the god",
        prayed && api.G.player.god === "GOD_TROG" && api.G.player.piety > 0);
  // a god's passive changes the player's stats
  api.startGame(api.charsel.species[0], api.charsel.jobs[0]);
  api.G.player.god = null;
  const acGodless = sandbox.playerAC(api.G.player);
  api.G.player.god = "GOD_SHINING_ONE";
  check("a god's passive affects the player",
        sandbox.playerAC(api.G.player) > acGodless);
  // invoking an ability spends piety and takes effect
  api.startGame(api.charsel.species[0], api.charsel.jobs[0]);
  api.G.player.god = "GOD_TROG";
  api.G.player.piety = 120;
  const invoked = sandbox.invokeAbility();
  check("invoking a god ability spends piety and takes effect",
        invoked && api.G.player.piety < 120 &&
        api.G.player.berserkTurns > 0);

  /* ---- paper-doll ---- */
  const doll = api.MANIFEST && api.MANIFEST.doll;
  check("paper-doll weapon & armour overlays are in the manifest",
        !!doll && Object.keys(doll.weapon || {}).length >= 5 &&
        Object.keys(doll.armour || {}).length >= 5);
  check("drawDoll is safe without a canvas context",
        sandbox.drawDoll(null, 0, 0, 32, "x", "short sword", null) === false);

  /* ---- backpack inventory ---- */
  api.startGame(api.charsel.species[0], api.charsel.jobs[0]);
  const bp = api.G;
  const oldWeapon = bp.player.weapon.name;
  bp.items.push({ key: "weapon", name: "war axe", glyph: "(", colour: "x",
                  weapon: { name: "war axe", dice: 1, sides: 13,
                            acc: 0, str: 4 },
                  x: bp.player.x, y: bp.player.y });
  api.doPickup();
  check("picked-up gear is stowed in the backpack, not auto-equipped",
        bp.player.weapon.name === oldWeapon &&
        bp.player.pack.some(it => it.name === "war axe"));
  // equipping from the pack wields it and banks the old weapon
  const packIdx = bp.player.pack.findIndex(it => it.name === "war axe");
  sandbox.equipFromPack(packIdx);
  check("equipping from the backpack wields the item",
        bp.player.weapon.name === "war axe" &&
        bp.player.pack.some(it => it.name === oldWeapon));

  /* ---- shops ---- */
  let shopLvl = null;
  for (let run = 0; run < 12 && !shopLvl; run++) {
    api.startGame(api.charsel.species[0], api.charsel.jobs[0]);
    for (let d = 1; d <= api.TRUNK_LEVELS; d++) {
      if (api.G.level.shop && api.G.level.shop.length) {
        shopLvl = api.G.level; break;
      }
      let s = null;
      for (let y = 0; y < api.MAP_H && !s; y++)
        for (let x = 0; x < api.MAP_W && !s; x++)
          if (api.G.level.tiles[y][x] === 2) s = { x, y };
      if (!s) break;
      api.G.player.x = s.x; api.G.player.y = s.y;
      if (!api.tryDescend()) break;
    }
  }
  check("shops are stocked on some levels",
        !!shopLvl && shopLvl.shop.length > 0 &&
        shopLvl.shop.every(it => it.price > 0));
  if (shopLvl) {
    api.G.player.gold = 9999;
    const goldBefore = api.G.player.gold;
    const stockBefore = shopLvl.shop.length;
    const packBefore = api.G.player.pack.length;
    const bought = shopLvl.shop[0];
    sandbox.buyItem(0);
    const went = (bought.key === "heal" || bought.key === "might" ||
                  bought.key === "scroll")
      ? true : api.G.player.pack.length === packBefore + 1;
    check("buying from a shop spends gold and delivers the item",
          api.G.player.gold < goldBefore &&
          shopLvl.shop.length === stockBefore - 1 && went);
  }

  /* ---- item brands (egos) ---- */
  let egoes = 0, renamed = false;
  for (let i = 0; i < 500; i++) {
    const w = sandbox.brandWeapon(
      { name: "mace", dice: 1, sides: 9, acc: 3, str: 3 });
    if (w.ego) {
      egoes++;
      if (sandbox.weaponLabel(w) !== "mace") renamed = true;
    }
  }
  check("weapons roll ego brands and are renamed for it",
        egoes > 70 && egoes < 260 && renamed);

  /* ---- character build: species stats, traits, background kits ---- */
  const trollSp = api.charsel.species.find(s => s.name === "Troll");
  const fighterJob = api.charsel.jobs.find(j => j.name === "Fighter");
  const berserkerJob = api.charsel.jobs.find(j => j.name === "Berserker");
  if (trollSp && fighterJob) {
    api.startGame(trollSp, fighterJob);
    const cp = api.G.player;
    check("character stats are species base + background bonus",
          cp.str === Math.max(1, trollSp.str + fighterJob.str) &&
          cp.dex === Math.max(1, trollSp.dex + fighterJob.dex));
    check("a species carries its innate trait (Troll regenerates)",
          !!cp.trait && cp.trait.id === "regen");
    check("a background starts with its kit (Fighter is armoured)",
          !!cp.armour && cp.armour.ac > 0);
  } else {
    check("character build: Troll / Fighter present", false);
  }
  if (trollSp && berserkerJob) {
    api.startGame(trollSp, berserkerJob);
    check("the Berserker background begins worshipping Trog",
          api.G.player.god === "GOD_TROG");
  }

  /* ---- status effects: poison, haste, slow, venom ---- */
  api.startGame(api.charsel.species[0], api.charsel.jobs[0]);
  const pn = api.G.player;
  const hpStart = pn.hp;
  sandbox.applyPoison(pn, 12);
  check("applyPoison sets poisonTurns", pn.poisonTurns === 12);
  for (let t = 0; t < 10; t++) api.endTurn();
  check("poison ticks damage over turns", pn.hp < hpStart);
  // a heal potion cures poison (DCSS-faithful)
  sandbox.packAdd({ key: "potion", sub: "heal",
                    name: "potion of healing", qty: 1 });
  sandbox.quaff("heal");
  check("a healing potion cures poison", pn.poisonTurns === 0);
  // potion of haste sets hasteTurns
  sandbox.packAdd({ key: "potion", sub: "haste",
                    name: "potion of haste", qty: 1 });
  sandbox.quaff("haste");
  check("potion of haste grants haste", pn.hasteTurns > 0);
  // slow ticks down on endTurn
  pn.slowTurns = 5;
  api.endTurn();
  check("slow status ticks down", pn.slowTurns === 4);
  // venom ego is one of the brandable egos
  let foundVenom = false;
  for (let i = 0; i < 800 && !foundVenom; i++) {
    const w = sandbox.brandWeapon(
      { name: "mace", dice: 1, sides: 9, acc: 0, str: 0 });
    if (w.ego === "venom") foundVenom = true;
  }
  check("venom is one of the weapon egos", foundVenom);
  // a venom-branded weapon can poison its target
  pn.weapon = { name: "long sword", dice: 1, sides: 10, acc: 50,
                str: 0, ego: "venom" };
  let dummy = api.G.monsters[0];
  if (!dummy) {
    dummy = { name: "newt", hp: 9999, hpMax: 9999, ac: 0, ev: 0,
              x: pn.x, y: pn.y, def: { attacks: [] }, energy: 0,
              speed: 10 };
    api.G.monsters.push(dummy);
  } else {
    dummy.hp = dummy.hpMax = 9999;       // survive many strikes
  }
  let mPoisoned = false;
  for (let i = 0; i < 60 && !mPoisoned; i++) {
    sandbox.playerAttack(dummy);
    if ((dummy.poisonTurns || 0) > 0) mPoisoned = true;
  }
  check("a venom-branded weapon poisons its target", mPoisoned);

  /* ---- the rest of the species traits (round 9) ---- */
  const vampSp = api.charsel.species.find(s => s.name === "Vampire");
  const poltSp = api.charsel.species.find(s => s.name === "Poltergeist");
  const mummySp = api.charsel.species.find(s => s.name === "Mummy");
  const ghoulSp = api.charsel.species.find(s => s.name === "Ghoul");
  const sprigSp = api.charsel.species.find(s => s.name === "Spriggan");
  const formSp = api.charsel.species.find(s => s.name === "Formicid");
  const nagaSp = api.charsel.species.find(s => s.name === "Naga");
  const ftrJob = api.charsel.jobs.find(j => j.name === "Fighter");
  if (vampSp && ftrJob) {
    api.startGame(vampSp, ftrJob);
    const v = api.G.player;
    v.hp = Math.max(1, v.hpMax - 30);
    const before = v.hp;
    const dummy = { name: "rat", hp: 1, hpMax: 1, ac: 0, ev: 0,
                    x: v.x + 1, y: v.y, def: { attacks: [] },
                    energy: 0, speed: 10 };
    api.G.monsters.push(dummy);
    sandbox.playerAttack(dummy);
    check("Vampire drinks blood and heals on a melee kill",
          v.hp > before);
  }
  if (poltSp && ftrJob) {
    api.startGame(poltSp, ftrJob);
    const pg = api.G.player;
    sandbox.applyPoison(pg, 8);
    check("Poltergeist is immune to poison",
          pg.poisonTurns === 0);
  }
  if (mummySp && ftrJob) {
    api.startGame(mummySp, ftrJob);
    const mu = api.G.player;
    sandbox.applyPoison(mu, 8);
    check("Mummy is immune to poison", mu.poisonTurns === 0);
  }
  if (ghoulSp && ftrJob) {
    api.startGame(ghoulSp, ftrJob);
    check("Ghoul has the clawed trait",
          api.G.player.trait && api.G.player.trait.id === "clawed");
  }
  if (sprigSp && ftrJob) {
    api.startGame(sprigSp, ftrJob);
    check("Spriggan moves faster than normal",
          api.G.player.speed > 10);
  }
  if (formSp && ftrJob) {
    api.startGame(formSp, ftrJob);
    check("Formicid is teleport-immune",
          sandbox.teleportImmune(api.G.player));
  }
  if (nagaSp && ftrJob) {
    api.startGame(nagaSp, ftrJob);
    sandbox.applyPoison(api.G.player, 8);
    check("Naga is immune to poison",
          api.G.player.poisonTurns === 0);
  }

  /* ---- round 10: more monster status attacks ---- */
  api.startGame(api.charsel.species[0], api.charsel.jobs[0]);
  const r10 = api.G.player;
  sandbox.applySlow(r10, 6);
  check("applySlow sets slowTurns", r10.slowTurns === 6);
  sandbox.applyParalysis(r10, 3);
  check("applyParalysis sets paralyzedTurns", r10.paralyzedTurns === 3);
  sandbox.applyConfusion(r10, 5);
  check("applyConfusion sets confusedTurns", r10.confusedTurns === 5);
  r10.xl = 4;
  sandbox.applyDrain(r10);
  check("applyDrain lowers xl by one", r10.xl === 3);
  check("cold attackers are classified",
        sandbox.isColdMon({ name: "frost giant" }) &&
        sandbox.isColdMon({ name: "ice beast" }));
  check("drain attackers are classified",
        sandbox.isDrainMon({ name: "freezing wraith" }) &&
        sandbox.isDrainMon({ name: "shadow imp" }));
  check("paralyse attackers are classified",
        sandbox.isParalyseMon({ name: "medusa" }));
  check("confuse attackers are classified",
        sandbox.isConfuseMon({ name: "gibbering naga" }));
  // Formicid resists paralysis (anchored)
  if (formSp && ftrJob) {
    api.startGame(formSp, ftrJob);
    sandbox.applyParalysis(api.G.player, 3);
    check("Formicid is paralysis-immune",
          api.G.player.paralyzedTurns === 0);
  }

  /* ---- round 12: more caster spells ---- */
  check("the spell roster has expanded beyond Magic Dart / Throw Flame",
        api.DATA.spells.length >= 10);
  const enchanterJob = api.charsel.jobs.find(j => j.name === "Enchanter");
  const humanSp = api.charsel.species.find(s => s.name === "Human");
  if (enchanterJob && humanSp) {
    api.startGame(humanSp, enchanterJob);
    check("Enchanter starts knowing Slow",
          api.G.player.spells.includes("SPELL_SLOW"));
    // give the player MP and a target, then cast Slow
    const ench = api.G.player;
    ench.mp = ench.mpMax;
    const dummy2 = { name: "rat", hp: 99, hpMax: 99, ac: 0, ev: 0,
                     x: ench.x + 1, y: ench.y, def: { attacks: [] },
                     awake: true, energy: 0, speed: 10 };
    api.G.monsters.push(dummy2);
    api.computeFOV();
    sandbox.castSpell("SPELL_SLOW");
    check("casting Slow afflicts the target with slowedTurns",
          (dummy2.slowedTurns || 0) > 0);
  }

  /* ---- round 13: more gods (Kiku / Sif Muna / Ashenzari) ---- */
  const newGods = api.DATA.gods.map(g => g.id);
  check("Kikubaaqudgha, Sif Muna and Ashenzari are exported",
        newGods.includes("GOD_KIKUBAAQUDGHA") &&
        newGods.includes("GOD_SIF_MUNA") &&
        newGods.includes("GOD_ASHENZARI"));
  if (humanSp && ftrJob) {
    api.startGame(humanSp, ftrJob);
    const k = api.G.player;
    k.god = "GOD_KIKUBAAQUDGHA"; k.piety = 60;
    k.hp = Math.max(1, k.hpMax - 20);
    const before = k.hp;
    const corpse = { name: "rat", hp: 0, hpMax: 1, ac: 0, ev: 0,
                     def: { exp: 0, attacks: [] },
                     x: k.x, y: k.y, energy: 0, speed: 10 };
    api.G.monsters.push(corpse);
    sandbox.killMonster(corpse);
    check("Kikubaaqudgha heals you on a kill", k.hp > before);
  }
  if (humanSp && ftrJob) {
    api.startGame(humanSp, ftrJob);
    const a = api.G.player;
    a.god = "GOD_ASHENZARI"; a.piety = 60;
    // mark a fake unseen trap; enterLevel hook only runs at floor change,
    // so test the invoke ability instead
    sandbox.invokeAbility();
    let allSeen = true;
    for (let y = 0; y < api.MAP_H && allSeen; y++)
      for (let x = 0; x < api.MAP_W && allSeen; x++)
        if (!api.G.seen[y][x]) allSeen = false;
    check("Ashenzari's Scry reveals the floor", allSeen);
  }

  /* ---- round 11: item identification ---- */
  api.startGame(api.charsel.species[0], api.charsel.jobs[0]);
  check("the run rolls per-game potion appearances",
        typeof api.G.appearance.potion.heal === "string");
  check("starting potions begin unidentified",
        !api.G.id.potion.heal);
  // an un-id potion shows its appearance, not the true name
  const unidName = sandbox.displayName({ key: "heal",
                                         name: "potion of healing" });
  check("un-identified potions display the appearance name",
        unidName.endsWith("potion") && unidName !== "potion of healing");
  // quaffing identifies it
  api.G.player.hp = Math.max(1, api.G.player.hpMax - 10);
  sandbox.quaff("heal");
  check("quaffing a potion identifies its subtype",
        api.G.id.potion.heal === true);
  check("identified potions display the true name",
        sandbox.displayName({ key: "heal" }) === "potion of healing");

  /* ---- round 14: selling & treasure ---- */
  api.startGame(api.charsel.species[0], api.charsel.jobs[0]);
  const sl = api.G.player;
  // gems exist and have value
  const gem = sandbox.makeGemItem(3, sl.x, sl.y);
  check("makeGemItem produces a sellable gem",
        gem && gem.key === "gem" && gem.value > 0);
  // picking up two gems of the same kind stacks
  sandbox.packAdd({ key: "gem", sub: gem.sub, name: gem.name,
                    value: gem.value, qty: 1 });
  sandbox.packAdd({ key: "gem", sub: gem.sub, name: gem.name,
                    value: gem.value, qty: 1 });
  const gemEntry = sl.pack.find(p => p.key === "gem" && p.sub === gem.sub);
  check("gems stack in the pack", !!gemEntry && gemEntry.qty === 2);
  // sellPrice + sellItem
  const goldBefore = sl.gold;
  const packBefore = sl.pack.length;
  const idx = sl.pack.findIndex(p => p.key === "gem");
  const priceP = sandbox.sellPrice(sl.pack[idx]);
  check("sellPrice on a gem returns its full value",
        priceP === gem.value);
  sandbox.sellItem(idx);
  check("selling a gem grants gold and reduces stack",
        sl.gold === goldBefore + gem.value &&
        sl.pack[idx].qty === 1);
  // sell a weapon
  sl.pack.push({ key: "weapon", name: "long sword",
                 weapon: { name: "long sword", sides: 10, str: 3 } });
  const goldB2 = sl.gold;
  const widx = sl.pack.length - 1;
  const wprice = sandbox.sellPrice(sl.pack[widx]);
  sandbox.sellItem(widx);
  check("selling a weapon spends a slot and pays gold",
        wprice > 0 && sl.gold === goldB2 + wprice);

  /* ---- round 15: more consumables ---- */
  api.startGame(api.charsel.species[0], api.charsel.jobs[0]);
  const c15 = api.G.player;
  // berserk potion
  sandbox.packAdd({ key: "potion", sub: "berserk",
                    name: "potion of berserk rage", qty: 1 });
  sandbox.quaff("berserk");
  check("potion of berserk grants Berserk", c15.berserkTurns > 0);
  // magic potion restores MP
  c15.mp = 1;
  sandbox.packAdd({ key: "potion", sub: "magic",
                    name: "potion of magic", qty: 1 });
  sandbox.quaff("magic");
  check("potion of magic refills MP", c15.mp > 1);
  // cancellation wipes statuses
  c15.poisonTurns = 5; c15.slowTurns = 5; c15.mightTurns = 5;
  sandbox.packAdd({ key: "potion", sub: "cancel",
                    name: "potion of cancellation", qty: 1 });
  sandbox.quaff("cancel");
  check("potion of cancellation clears every status",
        c15.poisonTurns === 0 && c15.slowTurns === 0 &&
        c15.mightTurns === 0);
  // scroll of magic mapping
  api.startGame(api.charsel.species[0], api.charsel.jobs[0]);
  const m15 = api.G.player;
  sandbox.packAdd({ key: "scroll", sub: "mapping",
                    name: "scroll of magic mapping", qty: 1 });
  sandbox.readScroll("mapping");
  let allSeen2 = true;
  for (let y = 0; y < api.MAP_H && allSeen2; y++)
    for (let x = 0; x < api.MAP_W && allSeen2; x++)
      if (!api.G.seen[y][x]) allSeen2 = false;
  check("scroll of magic mapping reveals the floor", allSeen2);

  /* ---- round 16: door variety ---- */
  api.startGame(api.charsel.species[0], api.charsel.jobs[0]);
  const d16 = api.G.player;
  const tdoor = api.G.level.tiles;
  // place a locked door next to the player on a floor tile
  let dx = d16.x + 1, dy = d16.y;
  if (dx >= api.MAP_W - 1) { dx = d16.x - 1; }
  tdoor[dy][dx] = 1;            // T.FLOOR
  tdoor[dy][dx] = 12;           // T.DOOR_LOCKED
  const goDir = dx > d16.x ? 1 : -1;
  // a locked door blocks
  const xb = d16.x;
  api.tryMovePlayer(goDir, 0);
  check("a locked door blocks the player until bashed",
        api.G.player.x === xb);
  // bash up to 30 times -- 50% per try, should open well before
  let opened = false;
  for (let i = 0; i < 30 && !opened; i++) {
    api.tryMovePlayer(goDir, 0);
    if (tdoor[dy][dx] === 5) opened = true;   // T.DOOR_OPEN
  }
  check("a locked door eventually breaks open from bashing", opened);
  // a gate wakes nearby sleeping monsters when shouldered open
  api.startGame(api.charsel.species[0], api.charsel.jobs[0]);
  const g16 = api.G.player;
  let gx = g16.x + 1, gy = g16.y;
  if (gx >= api.MAP_W - 1) { gx = g16.x - 1; }
  api.G.level.tiles[gy][gx] = 14;     // T.GATE
  const sleeper = { name: "rat", hp: 5, hpMax: 5, ac: 0, ev: 0,
                    awake: false, x: g16.x + 3, y: g16.y,
                    def: { attacks: [] }, energy: 0, speed: 10 };
  api.G.monsters.push(sleeper);
  api.tryMovePlayer(gx > g16.x ? 1 : -1, 0);
  check("opening a gate wakes nearby sleeping monsters", sleeper.awake);

  /* ---- round 17: the surface ---- */
  api.startGame(api.charsel.species[0], api.charsel.jobs[0]);
  let stairsUp = null;
  for (let y = 0; y < api.MAP_H && !stairsUp; y++)
    for (let x = 0; x < api.MAP_W && !stairsUp; x++)
      if (api.G.level.tiles[y][x] === 3) stairsUp = { x, y };
  if (stairsUp) {
    api.G.player.x = stairsUp.x; api.G.player.y = stairsUp.y;
    sandbox.tryAscend();
    check("ascending from D:1 emerges onto the Surface",
          api.G.branch === "Surface");
    check("the Surface has at least two dungeon entrances",
          api.G.level.entrances && api.G.level.entrances.length >= 2);
    check("the Surface is generated with biomes",
          typeof sandbox.biomeAtWorld(0, 0) === "string");
    check("Surface spawns the player on chunk (0,0)",
          api.G.surfaceCoord.cx === 0 && api.G.surfaceCoord.cy === 0);
    // walking off a Surface chunk edge enters the neighbour chunk
    api.G.player.x = api.MAP_W - 1;
    api.G.player.y = (api.MAP_H / 2) | 0;
    api.tryMovePlayer(1, 0);
    check("walking off the east edge enters the (1,0) chunk",
          api.G.surfaceCoord.cx === 1 && api.G.surfaceCoord.cy === 0);
    api.G.player.x = 0;
    api.tryMovePlayer(-1, 0);
    check("walking back returns to the (0,0) chunk",
          api.G.surfaceCoord.cx === 0 && api.G.surfaceCoord.cy === 0);
    // dungeon entrances also work
    const dEnt = api.G.level.entrances.find(e => e.branch === "D");
    if (dEnt) {
      api.G.player.x = dEnt.x; api.G.player.y = dEnt.y;
      api.tryDescend();
      check("stepping onto the Dungeon entrance on the Surface " +
            "enters D:1",
            api.G.branch === "D" && api.G.depth === 1);
    }
    // ascend back to Surface via the dungeon's STAIRS_UP
    let sUp = null;
    for (let y = 0; y < api.MAP_H && !sUp; y++)
      for (let x = 0; x < api.MAP_W && !sUp; x++)
        if (api.G.level.tiles[y][x] === 3) sUp = { x, y };
    if (sUp) {
      api.G.player.x = sUp.x; api.G.player.y = sUp.y;
      sandbox.tryAscend();
      const rEnt = api.G.level.entrances.find(e => e.branch === "Ruin");
      if (rEnt) {
        api.G.player.x = rEnt.x; api.G.player.y = rEnt.y;
        api.tryDescend();
        check("stepping onto the Ruin entrance enters the Ruin",
              api.G.branch === "Ruin" && api.G.depth === 1);
      }
    }
  }

  /* ---- Surface buildings + friendly NPCs + quests ---- */
  {
    api.startGame(api.charsel.species[0], api.charsel.jobs[0]);
    // emerge to Surface (spawn chunk is guaranteed to roll a home)
    for (let y = 0; y < api.MAP_H; y++) {
      for (let x = 0; x < api.MAP_W; x++) {
        if (api.G.level.tiles[y][x] === 3) {
          api.G.player.x = x; api.G.player.y = y;
        }
      }
    }
    sandbox.tryAscend();
    check("spawn chunk has at least one building",
          (api.G.level.buildings || []).length >= 1);
    check("spawn chunk has at least one friendly NPC",
          (api.G.npcs || []).length >= 1);
    // bump-talk a questgiver and accept a quest
    const npc = (api.G.npcs || []).find(n => n.kind === "questgiver");
    if (npc) {
      // place player adjacent to the NPC and bump
      api.G.player.x = npc.x; api.G.player.y = npc.y - 1;
      sandbox.tryMovePlayer(0, 1);  // bump downward into NPC
      check("bumping a questgiver opens dialog (no move spent)",
            api.G.player.y === npc.y - 1);
      check("bumping a questgiver creates a quest",
            api.G.quests.length >= 1 && api.G.quests[0].status === "active");
      // mark the quest as tracked and verify
      const qid = api.G.quests[0].id;
      api.G.trackedQuest = qid;
      check("a tracked quest is recorded",
            api.G.trackedQuest === qid);
      // simulate completion -- all quest types
      const q = api.G.quests[0];
      if (q.type === "kill") {
        q.progress = q.count;
      } else if (q.type === "fetch") {
        api.G.player.pack.push({ key: q.target.key, sub: q.target.sub,
                                  name: "test", qty: 1 });
      } else if (q.type === "rescue") {
        q.rescued = true;
      } else if (q.type === "retrieve") {
        api.G.player.pack.push({ key: "quest_item", questRelic: true,
          questId: q.id, name: q.relic, qty: 1 });
      }
      sandbox.turnInQuest(qid);
      check("turning in a completed quest pays the reward",
            q.status === "turnedIn" && api.G.player.gold > 0);
    }
    // buildings should be multi-room beyond the single cottage size --
    // generate many chunks and confirm a non-trivial layout shows up
    let largeBuildingSeen = false;
    let stairBuildingSeen = false;
    for (let cx = -2; cx <= 2 && (!largeBuildingSeen || !stairBuildingSeen); cx++) {
      for (let cy = -2; cy <= 2 && (!largeBuildingSeen || !stairBuildingSeen); cy++) {
        const data = sandbox.ensureSurfaceChunk(cx, cy);
        for (const b of (data.level.buildings || [])) {
          if (b.rooms && b.rooms.length >= 2) largeBuildingSeen = true;
          if (b.cellarStair || b.upperStair) stairBuildingSeen = true;
        }
      }
    }
    check("Surface generates multi-room buildings",
          largeBuildingSeen);
    check("Surface generates buildings with indoor stairs",
          stairBuildingSeen);
    // rescue-quest captive must spawn in ANY cellar of the target
    // chunk (the quest hook only names the region, not the specific
    // building). Find a chunk with a cellar, plant a rescue quest
    // pointing at that chunk but a DIFFERENT bidx, then walk into
    // the first cellar and confirm the captive shows up.
    if (sandbox.generateIndoorLevel) {
      let captCellars = [];
      for (let cx = -2; cx <= 2; cx++) {
        for (let cy = -2; cy <= 2; cy++) {
          const ch = sandbox.ensureSurfaceChunk(cx, cy);
          const blds = ch.level.buildings || [];
          for (let i = 0; i < blds.length; i++) {
            if (blds[i].cellarStair) {
              captCellars.push({ cx, cy, bidx: i, b: blds[i] });
            }
          }
        }
      }
      // need a chunk with >= 2 cellars to test the wrong-bidx case
      const chunkCounts = {};
      for (const c of captCellars) {
        const k = c.cx + "," + c.cy;
        chunkCounts[k] = (chunkCounts[k] || 0) + 1;
      }
      const multiKey = Object.keys(chunkCounts).find(k => chunkCounts[k] >= 2);
      if (multiKey) {
        const [mcx, mcy] = multiKey.split(",").map(Number);
        const mine = captCellars.filter(c => c.cx === mcx && c.cy === mcy);
        // quest points at cellar #1; player walks into cellar #0
        const target = mine[1], visited = mine[0];
        const q = {
          id: "qRescueRepro",
          giver: { chunkCX: 0, chunkCY: 0, x: 5, y: 5, name: "T" },
          type: "rescue",
          rescueAt: { cx: target.cx, cy: target.cy,
                      bidx: target.bidx, floor: -1 },
          captiveCellarBidx: null,
          captiveName: "TestVictim", kin: "sister",
          count: 1, progress: 0, rescued: false,
          reward: { gold: 100 }, status: "active",
          hook: "", greeting: "",
        };
        api.G.quests.push(q);
        const coord = {
          cx: visited.cx, cy: visited.cy, bidx: visited.bidx, floor: -1,
          returnAt: { x: visited.b.doorX, y: visited.b.doorY },
        };
        const lvl = sandbox.generateIndoorLevel(coord);
        const captive = (lvl.npcs || []).find(n => n.kind === "captive"
                                                && n.captiveQuestId === q.id);
        check("captive spawns even if player enters a different cellar in the target chunk",
              !!captive);
        check("quest locks captiveCellarBidx to the first-visited cellar",
              q.captiveCellarBidx === visited.bidx);
        // visiting the originally-targeted cellar should now NOT
        // double-spawn the captive
        const coord2 = {
          cx: target.cx, cy: target.cy, bidx: target.bidx, floor: -1,
          returnAt: { x: target.b.doorX, y: target.b.doorY },
        };
        const lvl2 = sandbox.generateIndoorLevel(coord2);
        const dup = (lvl2.npcs || []).find(n => n.kind === "captive"
                                              && n.captiveQuestId === q.id);
        check("captive does not double-spawn in a sibling cellar", !dup);
        // clean up so later tests don't see the synthetic quest
        api.G.quests = api.G.quests.filter(qq => qq.id !== q.id);
      }
    }
    // ---- Castle pocket-branch ----
    // CASTLE_GATE on a Surface chunk should warp the player into the
    // Castle branch keyed by the surface (cx,cy), at interior (0,0).
    if (sandbox.generateCastleLevel) {
      // make sure we're on a Surface chunk before we plant the gate
      sandbox.enterLevel("Surface", 1, "edge", { cx: 0, cy: 0 });
      const startBranch = api.G.branch;
      const startCoord = { cx: api.G.surfaceCoord.cx, cy: api.G.surfaceCoord.cy };
      // stamp a CASTLE_GATE onto the current surface chunk at a known
      // walkable cell and step onto it
      const Tcastle = 31, Texit = 32;
      const gx = 5, gy = 5;
      api.G.level.tiles[gy][gx] = 1; // FLOOR underfoot so move succeeds
      api.G.player.x = gx; api.G.player.y = gy;
      api.G.level.tiles[gy][gx + 1] = Tcastle;
      // walk one tile right -- the move handler runs the gate trigger
      api.tryMovePlayer(1, 0);
      check("stepping on a CASTLE_GATE enters the Castle branch",
            api.G.branch === "Castle");
      check("Castle entry records the owning surface chunk",
            api.G.castleCoord &&
            api.G.castleCoord.sx === startCoord.cx &&
            api.G.castleCoord.sy === startCoord.cy);
      // walk west off the edge of (0,0) and confirm we land in (-1,0)
      api.G.player.x = 0; api.G.player.y = 10;
      api.tryMovePlayer(-1, 0);
      check("walking off the west edge of Castle (0,0) lands in (-1,0)",
            api.G.branch === "Castle" &&
            api.G.castleCoord && api.G.castleCoord.icx === -1 &&
            api.G.castleCoord.icy === 0);
      // walk back east into (0,0) so the next test has a clean state
      api.G.player.x = api.MAP_W - 1; api.G.player.y = 10;
      api.tryMovePlayer(1, 0);
      check("walking back east returns to Castle interior (0,0)",
            api.G.castleCoord && api.G.castleCoord.icx === 0);
      // stamp an EXIT_GATE and step on it; should return to surface
      api.G.level.tiles[2][2] = Texit;
      api.G.player.x = 1; api.G.player.y = 2;
      api.tryMovePlayer(1, 0);
      check("EXIT_GATE returns the player to the Surface",
            api.G.branch === "Surface" &&
            api.G.surfaceCoord.cx === startCoord.cx &&
            api.G.surfaceCoord.cy === startCoord.cy);
      check("Castle state is cleared after exiting",
            api.G.castleCoord === null && api.G.castleReturn === null);
      // restore branch / coord so following tests aren't confused
      if (startBranch !== "Surface") {
        api.G.branch = startBranch;
      }
    }
    // descend into one via tryDescend and confirm we hit the Indoors branch
    let foundStair = null, foundChunk = null;
    outer: for (let cx = -2; cx <= 2; cx++) {
      for (let cy = -2; cy <= 2; cy++) {
        const data = sandbox.ensureSurfaceChunk(cx, cy);
        for (const b of (data.level.buildings || [])) {
          if (b.cellarStair) { foundStair = b.cellarStair; foundChunk = {cx, cy}; break outer; }
        }
      }
    }
    if (foundStair && foundChunk) {
      sandbox.enterLevel("Surface", 1,
        "cell:" + foundStair.x + "," + foundStair.y, foundChunk);
      api.G.player.x = foundStair.x; api.G.player.y = foundStair.y;
      api.tryDescend();
      check("descending a cellar stair enters the Indoors branch",
            api.G.branch === "Indoors" && api.G.indoorFloor === -1);
      // find STAIRS_UP on this indoor level and ascend back
      let up = null;
      for (let y = 0; y < api.MAP_H && !up; y++)
        for (let x = 0; x < api.MAP_W && !up; x++)
          if (api.G.level.tiles[y][x] === 3) up = { x, y };
      if (up) {
        api.G.player.x = up.x; api.G.player.y = up.y;
        sandbox.tryAscend();
        check("ascending from a cellar returns to the Surface",
              api.G.branch === "Surface");
      }
    }
    // descend two floors deep: cellar -1, then deeper to -2 if possible,
    // and confirm we're actually on a different level (not the same key
    // re-rendered -- that bug stashed the leaving level under the next
    // floor's key, making the deeper floor look identical)
    if (foundStair && foundChunk) {
      sandbox.enterLevel("Surface", 1,
        "cell:" + foundStair.x + "," + foundStair.y, foundChunk);
      api.G.player.x = foundStair.x; api.G.player.y = foundStair.y;
      api.tryDescend();
      const lvlA = api.G.level;
      // look for a deeper stair (STAIRS_DOWN, tile id 2) on floor -1
      let deeper = null;
      for (let y = 0; y < api.MAP_H && !deeper; y++)
        for (let x = 0; x < api.MAP_W && !deeper; x++)
          if (api.G.level.tiles[y][x] === 2) deeper = { x, y };
      if (deeper) {
        api.G.player.x = deeper.x; api.G.player.y = deeper.y;
        api.tryDescend();
        check("descending from -1 to -2 reaches floor -2",
              api.G.branch === "Indoors" && api.G.indoorFloor === -2);
        check("floor -2 is a different level than floor -1",
              api.G.level !== lvlA);
      }
    }
    // a deep enough cellar should yield at least one treasure chest;
    // opening one should drop its loot into the player's pack + gold
    {
      let chest = null, foundChunk2 = null;
      outer2: for (let cx = -3; cx <= 3; cx++) {
        for (let cy = -3; cy <= 3; cy++) {
          const data = sandbox.ensureSurfaceChunk(cx, cy);
          const c = (data.items || []).find(i => i.key === "chest");
          if (c) { chest = c; foundChunk2 = {cx, cy}; break outer2; }
        }
      }
      // or hunt for a cellar chest if no surface chest rolled
      if (!chest) {
        outer3: for (let cx = -3; cx <= 3; cx++) {
          for (let cy = -3; cy <= 3; cy++) {
            const data = sandbox.ensureSurfaceChunk(cx, cy);
            for (const b of (data.level.buildings || [])) {
              if (!b.cellarStair) continue;
              sandbox.enterLevel("Surface", 1,
                "cell:" + b.cellarStair.x + "," + b.cellarStair.y, {cx, cy});
              api.G.player.x = b.cellarStair.x;
              api.G.player.y = b.cellarStair.y;
              api.tryDescend();
              const c2 = (api.G.items || []).find(i => i.key === "chest");
              if (c2) { chest = c2; break outer3; }
            }
          }
        }
      }
      check("at least one treasure chest exists somewhere on Surface or in a cellar",
            chest !== null);
      if (chest) {
        // make sure the chest's chunk is the current one before doPickup
        if (foundChunk2 &&
            (api.G.branch !== "Surface" ||
             api.G.surfaceCoord.cx !== foundChunk2.cx ||
             api.G.surfaceCoord.cy !== foundChunk2.cy)) {
          sandbox.enterLevel("Surface", 1,
            "cell:" + chest.x + "," + chest.y, foundChunk2);
        }
        const goldBefore = api.G.player.gold;
        const packBefore = api.G.player.pack.length;
        api.G.player.x = chest.x; api.G.player.y = chest.y;
        sandbox.doPickup();
        check("opening a chest gives loot (gold + items)",
              api.G.player.gold > goldBefore ||
              api.G.player.pack.length > packBefore);
      }
    }
    // every monster def has a biome category now -- verify the data is
    // attached and the breakdown is non-degenerate
    {
      const all = api.DATA.monsters || [];
      const bA = all.filter(m => m.biome === "surface_animal").length;
      const bH = all.filter(m => m.biome === "surface_humanoid").length;
      const bU = all.filter(m => m.biome === "underground").length;
      check("every monster def is tagged with a biome",
            bA + bH + bU === all.length);
      check("biome breakdown is non-degenerate",
            bA > 30 && bH > 30 && bU > 50);
    }
    // surface chunks spawn only surface-biome mobs; underground / indoor
    // chunks spawn only underground mobs
    {
      let surfaceOk = true, bad = null;
      for (let cx = -3; cx <= 3 && surfaceOk; cx++) {
        for (let cy = -3; cy <= 3 && surfaceOk; cy++) {
          const data = sandbox.ensureSurfaceChunk(cx, cy);
          for (const m of (data.monsters || [])) {
            const isBuildingMob = (data.level.buildingMons || []).some(bm =>
              bm.x === m.x && bm.y === m.y);
            if (isBuildingMob) continue;
            if (!(m.def.biome === "surface_animal" ||
                  m.def.biome === "surface_humanoid")) {
              surfaceOk = false;
              bad = { name: m.name, biome: m.def.biome,
                      cx, cy, x: m.x, y: m.y };
            }
          }
        }
      }
      if (!surfaceOk) console.log("non-surface wandering:", bad);
      check("surface chunks spawn surface-biome wandering mobs",
            surfaceOk);
    }
  }

  /* ---- armour, rings, scrolls ---- */
  // items spawn across levels
  let armourSeen = 0, ringSeen = 0, scrollSeen = 0;
  for (let run = 0; run < 8; run++) {
    api.startGame(api.charsel.species[0], api.charsel.jobs[0]);
    for (let d = 1; d <= api.TRUNK_LEVELS; d++) {
      for (const it of api.G.items) {
        if (it.key === "armour") armourSeen++;
        else if (it.key === "ring") ringSeen++;
        else if (it.key === "scroll") scrollSeen++;
      }
      let s = null;
      for (let y = 0; y < api.MAP_H && !s; y++)
        for (let x = 0; x < api.MAP_W && !s; x++)
          if (api.G.level.tiles[y][x] === 2) s = { x, y };
      if (!s) break;
      api.G.player.x = s.x; api.G.player.y = s.y;
      if (!api.tryDescend()) break;
    }
  }
  check("armour / rings / scrolls spawn (" + armourSeen + " / " +
        ringSeen + " / " + scrollSeen + ")",
        armourSeen > 0 && ringSeen > 0 && scrollSeen > 0);
  // wearing armour raises AC (start from a known bare-chested state,
  // since some backgrounds now begin already armoured)
  api.startGame(api.charsel.species[0], api.charsel.jobs[0]);
  api.G.player.armour = null;
  const acBefore = sandbox.playerAC(api.G.player);
  sandbox.wearArmour({ name: "plate armour", ac: 10, ev_penalty: -180 });
  check("wearing armour raises AC",
        sandbox.playerAC(api.G.player) === acBefore + 10);
  // wearing a ring of strength raises Str and folds through to HP/AC
  const strBefore = api.G.player.str;
  sandbox.wearRing({ name: "strength", terse: "Str", plus: 4 });
  check("a ring of strength raises Str",
        api.G.player.str === strBefore + 4);
  // reading a scroll of teleportation moves the player far away
  sandbox.packAdd({ key: "scroll", sub: "teleport",
                    name: "scroll of teleportation", qty: 1 });
  const tpFrom = { x: api.G.player.x, y: api.G.player.y };
  sandbox.readScroll("teleport");
  const tpDist = Math.abs(api.G.player.x - tpFrom.x) +
                 Math.abs(api.G.player.y - tpFrom.y);
  check("scroll of teleportation relocates the player", tpDist >= 9);
  // reading a scroll of fear makes a visible monster flee
  api.startGame(api.charsel.species[0], api.charsel.jobs[0]);
  let fearMon = api.G.monsters.find(m => api.G.visible[m.y][m.x]);
  if (!fearMon && api.G.monsters.length) {
    // force one into view next to the player
    fearMon = api.G.monsters[0];
    fearMon.x = api.G.player.x + 1; fearMon.y = api.G.player.y;
    api.computeFOV();
  }
  sandbox.packAdd({ key: "scroll", sub: "fear",
                    name: "scroll of fear", qty: 1 });
  sandbox.readScroll("fear");
  check("scroll of fear frightens a visible monster",
        !!fearMon && fearMon.feared > 0);

  /* ---- spells (caster backgrounds) ---- */
  const conjJob = api.charsel.jobs.find(j => j.name === "Conjurer") ||
                  api.charsel.jobs[0];
  api.startGame(api.charsel.species[0], conjJob);
  const sg = api.G;
  check("a caster background starts knowing spells",
        conjJob.name !== "Conjurer" || sg.player.spells.length > 0);
  // cast a damage spell at a forced-visible monster
  let castOk = false, mpSpent = false;
  if (sg.player.spells.length && sg.monsters.length) {
    const m = sg.monsters[0];
    m.x = sg.player.x + 2; m.y = sg.player.y;
    m.hp = m.hpMax = 40;
    api.computeFOV();
    sg.player.mp = sg.player.mpMax = 8;
    const mpBefore = sg.player.mp;
    const dmgSpell = sg.player.spells.find(
      id => id === "SPELL_MAGIC_DART" || id === "SPELL_THROW_FLAME");
    if (dmgSpell) {
      sandbox.castSpell(dmgSpell);
      castOk = !sg.monsters.includes(m) || m.hp < 40;
      mpSpent = sg.player.mp < mpBefore;
    }
  }
  check("casting a damage spell hits a monster in sight", castOk);
  check("casting a spell spends MP", mpSpent);
  // Blink relocates the caster a short distance
  api.startGame(api.charsel.species[0], conjJob);
  api.G.player.spells = ["SPELL_BLINK"];
  api.G.player.mp = api.G.player.mpMax = 8;
  const blFrom = { x: api.G.player.x, y: api.G.player.y };
  sandbox.castSpell("SPELL_BLINK");
  const blDist = Math.max(Math.abs(api.G.player.x - blFrom.x),
                          Math.abs(api.G.player.y - blFrom.y));
  check("Blink moves the caster a short distance",
        blDist > 0 && blDist <= 4);

  /* ---- ranged combat: wands & throwing ---- */
  function forceVisibleMonster(g) {
    if (!g.monsters.length) return null;
    const m = g.monsters[0];
    m.x = g.player.x + 2; m.y = g.player.y;
    m.hp = m.hpMax = 60;
    api.computeFOV();
    return m;
  }
  // a damage wand hurts the nearest visible monster and spends a charge
  api.startGame(api.charsel.species[0], api.charsel.jobs[0]);
  let wm = forceVisibleMonster(api.G);
  let wandOk = false, chargeSpent = false;
  if (wm) {
    api.G.player.wand = { name: "flame", kind: "flame", charges: 3 };
    sandbox.evokeWand();
    wandOk = !api.G.monsters.includes(wm) || wm.hp < 60;
    chargeSpent = !api.G.player.wand || api.G.player.wand.charges === 2;
  }
  check("a damage wand hits the nearest monster in sight", wandOk);
  check("evoking a wand spends a charge", chargeSpent);
  // a wand of paralysis paralyses its target
  api.startGame(api.charsel.species[0], api.charsel.jobs[0]);
  let pm = forceVisibleMonster(api.G);
  if (pm) {
    api.G.player.wand = { name: "paralysis", kind: "paralysis", charges: 2 };
    sandbox.evokeWand();
  }
  check("a wand of paralysis paralyses its target",
        !!pm && pm.paralysed > 0);
  // throwing consumes a weapon from the quiver
  api.startGame(api.charsel.species[0], api.charsel.jobs[0]);
  let tm = forceVisibleMonster(api.G);
  let threwOk = false;
  if (tm) {
    api.G.player.quiver = { name: "javelin", damage: 10, count: 3 };
    sandbox.throwMissile();
    threwOk = api.G.player.quiver && api.G.player.quiver.count === 2;
  }
  check("throwing a weapon consumes one from the quiver", threwOk);

  /* ---- mouse controls ---- */
  api.startGame(api.charsel.species[0], api.charsel.jobs[0]);
  let mg = api.G;
  // findPath: route to a far tile that is provably reachable -- flood
  // from the player over seen + passable tiles and take a far one, so
  // the test never picks a seen-but-walled-off cell.
  let target = null;
  {
    const fseen = Array.from({ length: api.MAP_H }, () =>
      new Array(api.MAP_W).fill(false));
    const q = [[mg.player.x, mg.player.y]];
    fseen[mg.player.y][mg.player.x] = true;
    let head = 0;
    while (head < q.length) {
      const [x, y] = q[head++];
      const cheb = Math.max(Math.abs(x - mg.player.x),
                            Math.abs(y - mg.player.y));
      if (cheb >= 3 && mg.level.tiles[y][x] === 1 &&
          !mg.monsters.some(m => m.x === x && m.y === y)) {
        target = { x, y };
      }
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= api.MAP_W || ny >= api.MAP_H) continue;
        if (fseen[ny][nx] || !mg.seen[ny][nx]) continue;
        if (!sandbox.passable(mg.level, nx, ny) &&
            mg.level.tiles[ny][nx] !== 4) continue;   // door is openable
        // findPath never routes through a monster, so neither does this
        if (mg.monsters.some(m => m.x === nx && m.y === ny)) continue;
        fseen[ny][nx] = true;
        q.push([nx, ny]);
      }
    }
  }
  let path = target ? api.findPath(mg.player.x, mg.player.y,
                                   target.x, target.y) : null;
  // if the flood found a reachable far tile, findPath must route to it;
  // a degenerate tiny start with no far tile is not a findPath failure
  check("findPath returns a route to a far tile",
        !target || (!!path && path.length > 0));
  if (path && path.length) {
    let ok = path[path.length - 1].x === target.x &&
             path[path.length - 1].y === target.y;
    let prev = { x: mg.player.x, y: mg.player.y };
    for (const step of path) {
      if (Math.max(Math.abs(step.x - prev.x),
                   Math.abs(step.y - prev.y)) !== 1) ok = false;
      prev = step;
    }
    check("findPath steps are contiguous and reach the target", ok);
  }
  // clicking your own tile waits a turn
  let t0 = mg.turn;
  api.handleTileClick(mg.player.x, mg.player.y);
  check("clicking your own tile advances a turn", api.G.turn > t0);
  // clicking an adjacent passable tile moves you
  mg = api.G;
  let mouseMoved = false;
  for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
    const nx = mg.player.x + dx, ny = mg.player.y + dy;
    if (nx >= 0 && ny >= 0 && nx < api.MAP_W && ny < api.MAP_H &&
        mg.level.tiles[ny][nx] === 1 &&
        !mg.monsters.some(m => m.x === nx && m.y === ny)) {
      api.handleTileClick(nx, ny);
      mouseMoved = mg.player.x === nx && mg.player.y === ny;
      break;
    }
  }
  check("clicking an adjacent tile moves the player", mouseMoved);
  // onCanvasClick maps screen pixels to the right tile
  const cam = {
    camX: Math.max(0, Math.min(api.MAP_W - api.VIEW_W,
                               api.G.player.x - (api.VIEW_W >> 1))),
    camY: Math.max(0, Math.min(api.MAP_H - api.VIEW_H,
                               api.G.player.y - (api.VIEW_H >> 1))),
  };
  const screenX = (api.G.player.x - cam.camX) * api.TILE + (api.TILE >> 1);
  const screenY = (api.G.player.y - cam.camY) * api.TILE + (api.TILE >> 1);
  t0 = api.G.turn;
  api.onCanvasClick({ clientX: screenX, clientY: screenY });
  check("onCanvasClick maps a pixel to the player's tile (waits)",
        api.G.turn > t0);
  // action buttons dispatch
  t0 = api.G.turn;
  api.doAction("wait");
  check("doAction('wait') advances a turn", api.G.turn > t0);
  const healBefore = sandbox.packCount("potion", "heal");
  api.G.player.hp = Math.max(1, api.G.player.hpMax >> 1);
  api.doAction("heal");
  check("doAction('heal') consumes a healing potion",
        sandbox.packCount("potion", "heal") === healBefore - 1);

  /* ---- smart agent: prove the game is winnable with sensible play ---- */
  // Greedy: head for the down-stairs, attack what's adjacent on the way,
  // quaff healing when low, descend when on stairs, grab the Orb on D:8.
  let wins = 0, runs = 40, deepest = 0;
  for (let run = 0; run < runs; run++) {
    api.startGame(api.charsel.species[0], api.charsel.jobs[0]);
    const won = playSmart(api);
    if (won) wins++;
    deepest = Math.max(deepest, api.G.depth);
  }
  const winPct = Math.round((wins / runs) * 100);
  console.log(`\n  smart agent: ${wins}/${runs} wins (${winPct}%), ` +
              `deepest D:${deepest}`);
  check("smart agent reaches at least D:4", deepest >= 4);
  check("smart agent wins (game is winnable with care)", wins >= 1);
  check("game is still lethal (not a walkover)", wins < runs);

  console.log("\n" + (failures === 0
    ? "ALL CHECKS PASSED"
    : failures + " CHECK(S) FAILED"));
  process.exit(failures === 0 ? 0 : 1);
}

/* A genuinely competent agent. It plays like a cautious human:
 *  - heals when low,
 *  - quaffs might before a fight,
 *  - does NOT dive underlevelled -- it hunts monsters for XP until
 *    its experience level keeps pace with the dungeon depth,
 *  - collects healing potions,
 *  - then descends, and grabs the Orb on D:8.
 * Returns true on a win. A win proves the game is beatable with
 * sensible (not perfect) play. */
function playSmart(api) {
  const W = api.MAP_W, H = api.MAP_H;
  for (let guard = 0; guard < 40000 && !api.G.over; guard++) {
    const G = api.G;
    const p = G.player;

    // --- survive ---
    if (p.hp <= p.hpMax * 0.55 && sandbox.packCount("potion", "heal") > 0) {
      if (sandbox_quaff(api, "heal")) { api.endTurn(); continue; }
    }
    // --- might before a fight ---
    const nearMon = G.monsters.some(m =>
      Math.abs(m.x - p.x) <= 2 && Math.abs(m.y - p.y) <= 2);
    if (nearMon && p.mightTurns === 0 &&
        sandbox.packCount("potion", "might") > 0 && p.hp > p.hpMax * 0.5) {
      if (sandbox_quaff(api, "might")) { api.endTurn(); continue; }
    }
    // --- tactics: if 2+ monsters are adjacent, retreat to a tile that
    //     touches fewer of them (kite the pack into a 1-wide fight). ---
    const adj = G.monsters.filter(m =>
      Math.abs(m.x - p.x) <= 1 && Math.abs(m.y - p.y) <= 1);
    if (adj.length >= 2) {
      let bestStep = null, bestCount = adj.length;
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1],
                              [1,1],[1,-1],[-1,1],[-1,-1]]) {
        const nx = p.x + dx, ny = p.y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        { const bt = G.level.tiles[ny][nx];
          if (bt === 0 || bt === 7 || bt === 8) continue; }
        if (G.monsters.some(m => m.x === nx && m.y === ny)) continue;
        const c = G.monsters.filter(m =>
          Math.abs(m.x - nx) <= 1 && Math.abs(m.y - ny) <= 1).length;
        if (c < bestCount) { bestCount = c; bestStep = [dx, dy]; }
      }
      if (bestStep) {
        api.tryMovePlayer(bestStep[0], bestStep[1]);
        if (!api.checkWin()) api.endTurn();
        continue;
      }
      // cannot improve -- attack the weakest adjacent monster
      adj.sort((a, b) => a.hp - b.hp);
      const t = adj[0];
      api.tryMovePlayer(Math.sign(t.x - p.x), Math.sign(t.y - p.y));
      if (!api.checkWin()) api.endTurn();
      continue;
    }
    // --- win ---
    if (G.depth === api.TRUNK_LEVELS && G.orbPos &&
        p.x === G.orbPos.x && p.y === G.orbPos.y) {
      api.checkWin(); break;
    }
    // --- grab item underfoot ---
    if (G.items.some(i => i.x === p.x && i.y === p.y)) {
      if (api.doPickup()) {
        agentEquipBest(api);      // wield the best gear in the pack
        api.endTurn(); continue;
      }
    }

    // Underlevelled = behind the depth curve AND there is still XP
    // to be had on this floor. If the floor is cleared, descend even
    // when behind -- there is nothing else to do here.
    const underlevelled = p.xl < G.depth + 1 && G.monsters.length > 0;

    // --- descend when levelled enough, or when the floor is cleared ---
    if (G.level.tiles[p.y][p.x] === 2 && !underlevelled &&
        G.depth < api.TRUNK_LEVELS) {
      if (api.tryDescend()) continue;
    }

    // --- choose a goal ---
    let goal = null;
    if (G.depth === api.TRUNK_LEVELS && G.orbPos) {
      goal = G.orbPos;
    } else if (underlevelled && G.monsters.length) {
      // hunt the nearest monster for XP
      let best = null, bestD = 1e9;
      for (const m of G.monsters) {
        const d = Math.abs(m.x - p.x) + Math.abs(m.y - p.y);
        if (d < bestD) { bestD = d; best = m; }
      }
      goal = { x: best.x, y: best.y };
    } else {
      // collect potions / a better weapon when reasonably close
      if (sandbox.packCount("potion", "heal") < 4) {
        let best = null, bestD = 1e9;
        for (const it of G.items) {
          if (it.key !== "heal" && it.key !== "might" &&
              it.key !== "weapon") continue;
          const d = Math.abs(it.x - p.x) + Math.abs(it.y - p.y);
          if (d < bestD) { bestD = d; best = it; }
        }
        if (best && bestD < 26) goal = { x: best.x, y: best.y };
      }
      if (!goal) {
        for (let y = 0; y < H && !goal; y++)
          for (let x = 0; x < W && !goal; x++)
            if (G.level.tiles[y][x] === 2) goal = { x, y };
      }
      // levelled, no stairs left to find, nothing to do -> hunt
      if (!goal && G.monsters.length) {
        goal = { x: G.monsters[0].x, y: G.monsters[0].y };
      }
    }
    if (!goal) break;

    const step = bfsStep(api, p.x, p.y, goal.x, goal.y);
    if (!step) {
      // unreachable goal -- wander a step so the turn still advances
      const d = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,-1],[1,-1],[-1,1]]
        [(Math.random()*8)|0];
      if (!api.tryMovePlayer(d[0], d[1])) api.endTurn();
      else if (!api.checkWin()) api.endTurn();
      continue;
    }
    const moved = api.tryMovePlayer(step.dx, step.dy);
    if (!moved) {
      const d = [[1,0],[-1,0],[0,1],[0,-1]][(Math.random()*4)|0];
      if (!api.tryMovePlayer(d[0], d[1])) { api.endTurn(); continue; }
    }
    if (!api.checkWin()) api.endTurn();
  }
  return api.G.won === true;
}

function bfsStep(api, sx, sy, gx, gy) {
  const W = api.MAP_W, H = api.MAP_H, G = api.G;
  const prev = Array.from({ length: H }, () => new Array(W).fill(null));
  const seen = Array.from({ length: H }, () => new Array(W).fill(false));
  const q = [[sx, sy]];
  seen[sy][sx] = true;
  let head = 0;
  while (head < q.length) {
    const [x, y] = q[head++];
    if (x === gx && y === gy) {
      // walk back
      let cx = x, cy = y;
      while (prev[cy][cx] && !(prev[cy][cx][0] === sx && prev[cy][cx][1] === sy)) {
        const p = prev[cy][cx]; cx = p[0]; cy = p[1];
      }
      return { dx: Math.sign(cx - sx), dy: Math.sign(cy - sy) };
    }
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      if (seen[ny][nx]) continue;
      if (G.level.tiles[ny][nx] === 0) continue;
      seen[ny][nx] = true;
      prev[ny][nx] = [x, y];
      q.push([nx, ny]);
    }
  }
  return null;
}

/* drive the quaff path the way the key handler would */
function sandbox_quaff(api, kind) {
  // the game's quaff() is a function decl -> a context global
  return sandbox.quaff ? sandbox.quaff(kind) : false;
}

/* equip the strongest weapon / armour the agent is carrying -- a
 * sensible player optimises gear, so the canary should too */
function agentEquipBest(api) {
  let changed = true;
  while (changed) {
    changed = false;
    const p = api.G.player;
    for (let i = 0; i < p.pack.length; i++) {
      const it = p.pack[i];
      if (it.key === "weapon" && it.weapon &&
          (it.weapon.sides + it.weapon.str) >
          (p.weapon.sides + p.weapon.str)) {
        sandbox.equipFromPack(i); changed = true; break;
      }
      if (it.key === "armour" && it.armour &&
          it.armour.ac > (p.armour ? p.armour.ac : 0)) {
        sandbox.equipFromPack(i); changed = true; break;
      }
    }
  }
}

main();
