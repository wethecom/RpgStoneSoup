/* =============================================================
 * Crawl Web — a browser roguelike driven by the DCSS export.
 *
 * Every monster, species and background in this game comes from
 * web-game/game-data.json, which is built by build_game_data.py
 * from LuaInit-safe-dungeon.sqlite3 (the structured DCSS export).
 *
 * The combat math deliberately mirrors the exported fight.cc
 * helpers (fight_to_hit_formula_rule_defs, fight_weapon_damage_*,
 * fight_ac_chunked_rule_defs): a to-hit roll vs the defender's EV,
 * then damage reduced by per-point AC blocking.
 * ============================================================= */

"use strict";

/* ---------- map / display constants ---------- */
const MAP_W = 56;
const MAP_H = 26;
const FOV_RADIUS = 8;

/* ---------- the dungeon as a branch tree ----------
 * The Dungeon ("D") is the trunk; the other branches hang off it,
 * reached by a branch-entrance staircase placed at a random Dungeon
 * depth each game. `theme` indexes MANIFEST.dngn.themes. The Orb of
 * Zot sits at the bottom of the Dungeon trunk. */
const BRANCHES = {
  Surface:{ name: "Surface",      levels: 1, theme: 1, parent: null },
  D:      { name: "Dungeon",      levels: 5, theme: 0, parent: "Surface" },
  Lair:   { name: "Lair",         levels: 3, theme: 1, parent: "D" },
  Orc:    { name: "Orcish Mines", levels: 3, theme: 2, parent: "D" },
  Crypt:  { name: "Crypt",        levels: 2, theme: 3, parent: "D" },
  Vaults: { name: "Vaults",       levels: 3, theme: 4, parent: "D" },
  Swamp:  { name: "Swamp",        levels: 3, theme: 1, parent: "D" },
  Shoals: { name: "Shoals",       levels: 3, theme: 1, parent: "D" },
  Ruin:   { name: "Ruin",         levels: 3, theme: 0, parent: "Surface" },
  // an indoor sub-level inside a Surface building -- cellars + upper
  // floors. Keyed by (chunk, building idx, floor) not by depth, so the
  // same key returns the same room across visits.
  Indoors:{ name: "Indoors",      levels: 1, theme: 0, parent: "Surface" },
};
/* the non-trunk branches, in the order their entrances are assigned */
const SIDE_BRANCHES = ["Lair", "Orc", "Crypt", "Vaults", "Swamp", "Shoals"];
const TRUNK_LEVELS = BRANCHES.D.levels;       // Orb is on the last one

/* how much ambient terrain (water lakes, lava pools, tree groves) the
 * generator scatters through each branch -- this is what gives the
 * Lair its woods, the Swamp its water, the Mines their lava. */
const TERRAIN = {
  D:      { water: 1, lava: 0, trees: 1 },
  Lair:   { water: 2, lava: 0, trees: 3 },
  Orc:    { water: 0, lava: 2, trees: 0 },
  Crypt:  { water: 0, lava: 0, trees: 0 },
  Vaults: { water: 1, lava: 1, trees: 0 },
  Swamp:  { water: 5, lava: 0, trees: 4 },
  Shoals: { water: 6, lava: 0, trees: 1 },
  Ruin:   { water: 0, lava: 0, trees: 1 },
  // the Surface is painted by surfaceLayout, not scatterTerrain
  Surface:{ water: 0, lava: 0, trees: 0 },
};

/* Tile rendering. The level is MAP_W x MAP_H; the canvas shows a
 * VIEW_W x VIEW_H window that scrolls to keep the player centred. */
const TILE = 26;
const VIEW_W = 38;
const VIEW_H = 22;

/* DCSS colour-enum names -> CSS hex. */
const COLOURS = {
  BLACK: "#15151c", BLUE: "#5566dd", GREEN: "#33aa33", CYAN: "#33aaaa",
  RED: "#cc3333", MAGENTA: "#aa33aa", BROWN: "#aa7733", LIGHTGRAY: "#b0b0bc",
  DARKGRAY: "#666672", LIGHTBLUE: "#7799ff", LIGHTGREEN: "#66dd66",
  LIGHTCYAN: "#77dddd", LIGHTRED: "#ff6666", LIGHTMAGENTA: "#ee77ee",
  YELLOW: "#ffdd55", WHITE: "#ffffff", COLOUR_UNDEF: "#b0b0bc",
  ETC_FIRE: "#ff6633", ETC_ICE: "#88ccff", ETC_EARTH: "#bb8844",
  ETC_AIR: "#cce0ff", ETC_ELECTRICITY: "#bbccff", ETC_BLOOD: "#cc2222",
  ETC_BONE: "#e8e8d0", ETC_IRON: "#9999a5", ETC_GOLD: "#ffcc33",
  ETC_SILVER: "#d0d0dd", ETC_HOLY: "#fff0c0", ETC_UNHOLY: "#7744aa",
  ETC_MAGIC: "#aa66ff", ETC_MUTAGENIC: "#cc55cc", ETC_RANDOM: "#cccccc",
  ETC_JEWEL: "#ff66aa", ETC_TREE: "#338833", ETC_ORB_GLOW: "#ffdd88",
};
function colourHex(name) { return COLOURS[name] || "#b0b0bc"; }

/* ---------- tiles ---------- */
const T = { WALL: 0, FLOOR: 1, STAIRS_DOWN: 2, STAIRS_UP: 3,
            DOOR: 4, DOOR_OPEN: 5, WATER: 6, LAVA: 7, TREE: 8,
            ALTAR: 9, BRANCH: 10, SHOP: 11,
            DOOR_LOCKED: 12, DOOR_STEEL: 13, GATE: 14,
            ROOF: 15,
            // surface points of interest: walkable, trigger an effect
            // the first time the player steps on them
            WELL: 16, SHRINE: 17, GRAVE: 18,
            CAMPSITE: 19, IDOL: 20, MANA_NODE: 21, SIGNPOST: 22,
            BEACON: 23, WISHING_WELL: 24,
            // an upright standing stone -- impassable scenery, placed
            // in rings around a centre shrine to form a henge
            STANDING_STONE: 25,
            // soft POIs: a flower patch (small heal + cure poison), a
            // lectern (identifies a random unknown scroll), a fruit
            // cache (heals + small poison risk)
            FLOWERS: 26, LECTERN: 27, FRUIT_CACHE: 28,
            // deep water -- impassable centre of lakes / shoals.
            // T.WATER stays the wadeable shallows.
            DEEP_WATER: 29,
            // a teleporter cell -- step on to warp to a destination
            // (cx, cy, x, y) stored on lvl.teleporters
            TELEPORTER: 30,
            // CASTLE_GATE: painted on a Surface chunk. Stepping on it
            // teleports the player into the Castle pocket-branch
            // indexed by the surface chunk coord -- so the gate at
            // Surface (3,-2) leads to Castle:3,-2 at interior chunk
            // (0,0).  The castle's interior is a chunked grid in its
            // own right (walk to icx+1 etc), painted in the editor.
            CASTLE_GATE: 31,
            // EXIT_GATE: painted inside a Castle interior. Stepping
            // on it pops the player back to the Surface chunk the
            // castle belongs to, at the cell that the entering gate
            // occupied (stashed in G.castleReturn on entry).
            EXIT_GATE: 32,
            // HEARTH: the player's home center (build with B). Stepping
            // on it fully heals HP/MP. New runs spawn at the hearth's
            // surface chunk. Capped at one per save -- claiming a home.
            HEARTH: 33,
            // BED: lie down (s) to sleep until full HP/MP. Built.
            BED: 34,
            // PLAYER_CHEST: persistent storage that survives runs.
            // Contents stored under crawlweb.playerHome.chestSlots.
            PLAYER_CHEST: 35,
            // PLAYER_SIGN: a sign with a message the player wrote.
            PLAYER_SIGN: 36,
            // FORGE: a smouldering fire-pit / anvil setup. Walkable.
            // Bumping a blacksmith NPC standing next to one trades
            // wood + stone for a weapon upgrade.
            FORGE: 37,
          };

/* the difficulty depth of the current level: depth in the Dungeon,
 * or, in a branch, the Dungeon depth it was entered from plus the
 * depth reached inside the branch. Drives monster tier and spawns. */
function effectiveDepth() {
  if (!G) return 1;
  if (G.branch === "D") return G.depth;
  const ret = G.branchReturn && G.branchReturn[G.branch];
  return (ret ? ret.depth : 2) + G.depth;
}

/* ---------- RNG ---------- */
function ri(lo, hi) { return lo + Math.floor(Math.random() * (hi - lo + 1)); }
function chance(n) { return Math.random() < n; }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
/* roll d(n) summed `dice` times -- a DCSS-style dice_def(dice, n). */
function roll(dice, sides) {
  let s = 0;
  for (let i = 0; i < dice; i++) s += ri(1, sides);
  return s;
}

/* ---------- global game state ---------- */
let DATA = null;          // loaded game-data.json
let MANIFEST = null;      // loaded tiles/manifest.json (may stay null)
let TILEIMG = {};         // path -> HTMLImageElement cache
let G = null;             // active game

/* ---------- tile loading ---------- */

async function loadManifest() {
  try {
    const resp = await fetch("tiles/manifest.json");
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    MANIFEST = await resp.json();
  } catch (e) {
    MANIFEST = null;       // game still runs in ASCII fallback mode
  }
}

/* Preload every tile the manifest lists. Resolves once all images have
 * either loaded or failed -- a failed tile just falls back to ASCII. */
function preloadTiles() {
  if (!MANIFEST) return Promise.resolve();
  // the manifest nests paths as strings, arrays, and objects (themes);
  // walk it recursively and collect every .png path.
  const paths = [];
  (function collect(node) {
    if (!node) return;
    if (typeof node === "string") {
      if (node.endsWith(".png")) paths.push(node);
    } else if (Array.isArray(node)) {
      for (const v of node) collect(v);
    } else if (typeof node === "object") {
      for (const k in node) collect(node[k]);
    }
  })(MANIFEST);
  let done = 0;
  return new Promise((resolve) => {
    if (!paths.length) return resolve();
    for (const rel of paths) {
      const img = new Image();
      img.onload = img.onerror = () => {
        if (++done === paths.length) resolve();
      };
      img.src = "tiles/" + rel;
      TILEIMG[rel] = img;
    }
  });
}

function tileReady(rel) {
  const img = rel && TILEIMG[rel];
  return img && img.complete && img.naturalWidth > 0 ? img : null;
}

/* ---------- vaults ----------
 * Authored room layouts extracted from the DCSS .des files by
 * build_vaults.py. Each vault is { name, w, h, rows[], entries[] }
 * where rows use '#' wall, '.' floor, ' ' outside-the-vault. */
let VAULTS = [];

async function loadVaults() {
  try {
    const resp = await fetch("vaults.json");
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const doc = await resp.json();
    VAULTS = doc.vaults || [];
  } catch (e) {
    VAULTS = [];           // generator just uses random rooms only
  }
}

/* =============================================================
 * Data loading + character creation
 * ============================================================= */

async function loadData() {
  const banner = document.getElementById("data-banner");
  try {
    const resp = await fetch("game-data.json");
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    DATA = await resp.json();
  } catch (e) {
    banner.innerHTML =
      "<b>Could not load game-data.json.</b> Serve this folder over " +
      "http (e.g. <code>python -m http.server</code> in web-game/) " +
      "rather than opening the file directly. (" + e.message + ")";
    return false;
  }
  banner.innerHTML =
    "Loaded the DCSS export: schema <b>v" + DATA.schema_version + "</b> &mdash; " +
    DATA.species.length + " species, " + DATA.jobs.length +
    " backgrounds, <b>" + DATA.monsters.length + "</b> monsters. " +
    "Source: <code>" + DATA.source + "</code>.";
  return true;
}

/* A curated front-of-list so new players see familiar picks first. */
const SPECIES_FEATURE = ["Human", "Minotaur", "Hill Orc", "Deep Elf",
  "Gargoyle", "Troll", "Kobold", "Spriggan"];
const JOB_FEATURE = ["Fighter", "Berserker", "Gladiator", "Hunter",
  "Wizard", "Conjurer", "Monk"];

function orderedBy(list, feature, nameKey) {
  const feat = [], rest = [];
  for (const x of list) {
    (feature.includes(x[nameKey]) ? feat : rest).push(x);
  }
  feat.sort((a, b) => feature.indexOf(a[nameKey]) - feature.indexOf(b[nameKey]));
  rest.sort((a, b) => a[nameKey].localeCompare(b[nameKey]));
  return feat.concat(rest);
}

/* live character preview -- shows the chosen species' actual sprite
 * and the stats / kit the run will start with, recomputed with the
 * same formulas startGame uses. */
function updatePreview() {
  const species = G_CHARSEL.species, jobs = G_CHARSEL.jobs;
  if (!species || !jobs) return;
  const sp = species[document.getElementById("sel-species").value | 0];
  const jb = jobs[document.getElementById("sel-job").value | 0];
  if (!sp || !jb) return;

  // a throwaway character built exactly as startGame would
  const tp = {
    xl: 1,
    str: Math.max(1, (sp.str || 0) + (jb.str || 0)),
    int: Math.max(1, (sp.int || 0) + (jb.int || 0)),
    dex: Math.max(1, (sp.dex || 0) + (jb.dex || 0)),
    armour: null, ring: null, quiver: null, god: null, piety: 0,
    heroismTurns: 0,
    size: sp.size || "medium",
    trait: speciesTrait(sp),
    weapon: startingWeapon(),
  };
  applyJobKit(tp, jb);              // reflect the background's gear
  tp.hpMax = playerMaxHp(tp, sp);
  const mpMax = Math.max(0, 3 + Math.floor(tp.int / 2) + (sp.mp_mod || 0));
  const knownSpells = (CASTER_SPELLS[jb.name] || [])
    .map(id => { const s = spellById(id); return s ? s.title : null; })
    .filter(Boolean);

  const nameEl = document.getElementById("preview-name");
  if (nameEl) nameEl.textContent = sp.name + " " + jb.name;

  const row = (k, v) => `<div class="row"><span class="k">${k}</span>` +
    `<span class="v">${v}</span></div>`;
  // describe the starting kit from the kitted-out preview character
  let kit = "Wields a " + weaponLabel(tp.weapon);
  if (tp.armour) kit += ", wears " + armourLabel(tp.armour);
  if (tp.quiver) {
    kit += ", " + tp.quiver.count + " " + tp.quiver.name + "s quivered";
  }
  kit += ". Carries 4 healing &amp; 1 might potion and a teleport scroll";
  if (tp.god) kit += ". Worships " + godName(tp.god) + " from the start";
  kit += ".";

  const body = document.getElementById("preview-body");
  if (body) body.innerHTML =
    row("Strength", `<span class="stat">${tp.str}</span>`) +
    row("Intelligence", `<span class="stat">${tp.int}</span>`) +
    row("Dexterity", `<span class="stat">${tp.dex}</span>`) +
    `<hr>` +
    row("Health", tp.hpMax + " HP") +
    row("Magic", mpMax + " MP") +
    row("Armour class", playerAC(tp)) +
    row("Evasion", playerEV(tp)) +
    `<hr>` +
    (tp.trait
      ? `<div class="spell">${tp.trait.desc}.</div>` : "") +
    `<div class="kit">${kit}</div>` +
    (knownSpells.length
      ? `<div class="spell">Knows: ${knownSpells.join(", ")}.</div>`
      : `<div class="k">A martial background &mdash; no spells.</div>`);

  // a paper-doll of the species body with the starting short sword
  const cvs = document.getElementById("preview-sprite");
  const ctx = cvs && cvs.getContext && cvs.getContext("2d");
  if (ctx) {
    ctx.clearRect(0, 0, cvs.width, cvs.height);
    const rel = MANIFEST && MANIFEST.player &&
      (MANIFEST.player[sp.id] || MANIFEST.player._default);
    const drew = drawDoll(ctx, 0, 0, cvs.width, rel,
      tp.weapon && tp.weapon.name, tp.armour && tp.armour.name);
    if (!drew) {
      ctx.fillStyle = "#ffffff";
      ctx.font = (cvs.height * 0.6 | 0) + "px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("@", cvs.width / 2, cvs.height / 2 + 2);
    }
  }
}

function buildCharSelect() {
  const selSp = document.getElementById("sel-species");
  const selJob = document.getElementById("sel-job");
  const species = orderedBy(DATA.species, SPECIES_FEATURE, "name");
  const jobs = orderedBy(DATA.jobs, JOB_FEATURE, "name");

  species.forEach((sp, i) => {
    const o = document.createElement("option");
    o.value = i; o.textContent = sp.name;
    selSp.appendChild(o);
  });
  jobs.forEach((jb, i) => {
    const o = document.createElement("option");
    o.value = i; o.textContent = jb.name;
    selJob.appendChild(o);
  });

  G_CHARSEL.species = species;
  G_CHARSEL.jobs = jobs;

  function modSpan(label, v) {
    if (!v) return "";
    const cls = v > 0 ? "good" : "bad";
    return ` <span class="${cls}">${label} ${v > 0 ? "+" : ""}${v}</span>`;
  }
  function showSpecies() {
    const sp = species[selSp.value | 0];
    document.getElementById("species-info").innerHTML =
      `<span class="stat">${sp.name}</span> (${sp.abbr})<br>` +
      `HP modifier:${modSpan("", sp.hp_mod) || " +0"} &nbsp; ` +
      `MP modifier:${modSpan("", sp.mp_mod) || " +0"}<br>` +
      `Willpower:${modSpan("", sp.wl_mod) || " +0"} &nbsp; ` +
      `XP rate:${modSpan("", sp.xp_mod) || " +0"}`;
  }
  function showJob() {
    const jb = jobs[selJob.value | 0];
    document.getElementById("job-info").innerHTML =
      `<span class="stat">${jb.name}</span> (${jb.abbr})<br>` +
      `Starting stats &mdash; ` +
      `<span class="stat">Str ${jb.str}</span>, ` +
      `<span class="stat">Int ${jb.int}</span>, ` +
      `<span class="stat">Dex ${jb.dex}</span>`;
  }
  selSp.addEventListener("change", () => { showSpecies(); updatePreview(); });
  selJob.addEventListener("change", () => { showJob(); updatePreview(); });
  selSp.selectedIndex = 0;
  selJob.selectedIndex = 0;
  showSpecies();
  showJob();
  updatePreview();

  document.getElementById("btn-start").disabled = false;
}
const G_CHARSEL = { species: [], jobs: [] };

/* =============================================================
 * Dungeon generation -- rooms joined by L-shaped corridors.
 * ============================================================= */

/* rectangle-overlap test with a margin, used for both rooms and vaults */
function rectsClash(ax, ay, aw, ah, bx, by, bw, bh, margin) {
  return ax - margin < bx + bw && ax + aw + margin > bx &&
         ay - margin < by + bh && ay + ah + margin > by;
}

/* stamp a vault layout into the tile grid at (ox, oy).
 * '#' wall, '.' floor, '+' door, '~' water, 'l' lava, 't' tree;
 * ' ' is left as-is (outside the vault footprint). */
const VAULT_TILE = {
  "#": T.WALL, "+": T.DOOR, "~": T.WATER, "l": T.LAVA, "t": T.TREE,
};
function stampVault(tiles, vault, ox, oy) {
  for (let y = 0; y < vault.h; y++) {
    const row = vault.rows[y] || "";
    for (let x = 0; x < vault.w; x++) {
      const c = row[x];
      if (c === " " || c === undefined) continue;
      const tx = ox + x, ty = oy + y;
      if (tx < 1 || ty < 1 || tx >= MAP_W - 1 || ty >= MAP_H - 1) continue;
      tiles[ty][tx] = (c in VAULT_TILE) ? VAULT_TILE[c] : T.FLOOR;
    }
  }
}

/* a level coordinate inside the vault to connect a corridor to:
 * prefer one of its authored @ entry points, else any floor cell. */
function vaultConnectPoint(vault, ox, oy) {
  if (vault.entries && vault.entries.length) {
    const e = pick(vault.entries);
    return { x: ox + e[0], y: oy + e[1] };
  }
  for (let y = 0; y < vault.h; y++) {
    const row = vault.rows[y] || "";
    for (let x = 0; x < vault.w; x++) {
      if (row[x] === ".") return { x: ox + x, y: oy + y };
    }
  }
  return { x: ox + (vault.w >> 1), y: oy + (vault.h >> 1) };
}

/* an organic cave layout (cellular automata), used on some depths
 * instead of rooms + corridors. Carves the non-vault rock into
 * caverns, keeps the largest connected region, and returns pseudo-
 * rooms for stairs / spawning -- or null if the cave came out too
 * cramped, so the caller falls back to rooms. */
function caveLayout(tiles, blockers) {
  const inVault = (x, y) =>
    blockers.some(b => x >= b.x && x < b.x + b.w &&
                       y >= b.y && y < b.y + b.h);
  // 1. random fill of the non-vault interior
  for (let y = 1; y < MAP_H - 1; y++)
    for (let x = 1; x < MAP_W - 1; x++)
      if (!inVault(x, y))
        tiles[y][x] = chance(0.45) ? T.WALL : T.FLOOR;
  // 2. smoothing passes -- a cell turns to rock if crowded by rock
  for (let pass = 0; pass < 5; pass++) {
    const snap = tiles.map(r => r.slice());
    for (let y = 1; y < MAP_H - 1; y++)
      for (let x = 1; x < MAP_W - 1; x++) {
        if (inVault(x, y)) continue;
        let wc = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= MAP_W || ny >= MAP_H ||
                snap[ny][nx] === T.WALL) wc++;
          }
        tiles[y][x] = (wc >= 5) ? T.WALL : T.FLOOR;
      }
  }
  // 3. keep only the largest connected floor region
  const seen = [];
  for (let y = 0; y < MAP_H; y++) seen.push(new Array(MAP_W).fill(false));
  let best = [];
  for (let y = 1; y < MAP_H - 1; y++)
    for (let x = 1; x < MAP_W - 1; x++) {
      if (seen[y][x] || tiles[y][x] !== T.FLOOR) continue;
      const cells = [], stack = [[x, y]];
      seen[y][x] = true;
      while (stack.length) {
        const [cx, cy] = stack.pop();
        cells.push([cx, cy]);
        for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 1 || ny < 1 || nx >= MAP_W - 1 || ny >= MAP_H - 1) continue;
          if (seen[ny][nx] || tiles[ny][nx] !== T.FLOOR) continue;
          seen[ny][nx] = true;
          stack.push([nx, ny]);
        }
      }
      if (cells.length > best.length) best = cells;
    }
  // fill the smaller pockets back to rock
  const keep = new Set(best.map(c => c[1] * MAP_W + c[0]));
  for (let y = 1; y < MAP_H - 1; y++)
    for (let x = 1; x < MAP_W - 1; x++)
      if (tiles[y][x] === T.FLOOR && !keep.has(y * MAP_W + x) &&
          !inVault(x, y))
        tiles[y][x] = T.WALL;
  if (best.length < 150) return null;        // too cramped -- fall back
  // 4. pseudo-rooms: entry near one corner, exit near the far one,
  //    plus scattered points so monsters / items spread out
  best.sort((a, b) => (a[0] + a[1]) - (b[0] + b[1]));
  // a 5x5 spawn rect kept fully in bounds; cx,cy stays the true cell
  const mkRoom = (cx, cy) => ({
    x: Math.min(MAP_W - 6, Math.max(1, cx - 2)),
    y: Math.min(MAP_H - 6, Math.max(1, cy - 2)),
    w: 5, h: 5, cx, cy,
  });
  const rooms = [mkRoom(best[0][0], best[0][1])];
  for (let i = 0; i < 10; i++) {
    const c = best[(Math.random() * best.length) | 0];
    rooms.push(mkRoom(c[0], c[1]));
  }
  const far = best[best.length - 1];
  rooms.push(mkRoom(far[0], far[1]));
  return rooms;
}

/* keep only the largest connected FLOOR region, wall off the rest,
 * and return its cells sorted top-left -> bottom-right. */
function largestFloorRegion(tiles, inVault) {
  const seen = [];
  for (let y = 0; y < MAP_H; y++) seen.push(new Array(MAP_W).fill(false));
  let best = [];
  for (let y = 1; y < MAP_H - 1; y++)
    for (let x = 1; x < MAP_W - 1; x++) {
      if (seen[y][x] || tiles[y][x] !== T.FLOOR) continue;
      const cells = [], stack = [[x, y]];
      seen[y][x] = true;
      while (stack.length) {
        const [cx, cy] = stack.pop();
        cells.push([cx, cy]);
        for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 1 || ny < 1 || nx >= MAP_W - 1 || ny >= MAP_H - 1) continue;
          if (seen[ny][nx] || tiles[ny][nx] !== T.FLOOR) continue;
          seen[ny][nx] = true;
          stack.push([nx, ny]);
        }
      }
      if (cells.length > best.length) best = cells;
    }
  const keep = new Set(best.map(c => c[1] * MAP_W + c[0]));
  for (let y = 1; y < MAP_H - 1; y++)
    for (let x = 1; x < MAP_W - 1; x++)
      if (tiles[y][x] === T.FLOOR && !keep.has(y * MAP_W + x) &&
          !inVault(x, y))
        tiles[y][x] = T.WALL;
  best.sort((a, b) => (a[0] + a[1]) - (b[0] + b[1]));
  return best;
}

/* turn a cell list into pseudo-rooms: entry near a corner, exit near
 * the far one, plus scattered points for spawning. */
function cellsToRooms(cells) {
  const mk = (cx, cy) => ({
    x: Math.min(MAP_W - 6, Math.max(1, cx - 2)),
    y: Math.min(MAP_H - 6, Math.max(1, cy - 2)),
    w: 5, h: 5, cx, cy,
  });
  const rooms = [mk(cells[0][0], cells[0][1])];
  for (let i = 0; i < 10; i++) {
    const c = cells[(Math.random() * cells.length) | 0];
    rooms.push(mk(c[0], c[1]));
  }
  const far = cells[cells.length - 1];
  rooms.push(mk(far[0], far[1]));
  return rooms;
}

/* a labyrinth: a perfect maze of 1-wide corridors carved by a
 * recursive backtracker, avoiding the placed vaults. */
function mazeLayout(tiles, blockers) {
  const inVault = (x, y) =>
    blockers.some(b => x >= b.x && x < b.x + b.w &&
                       y >= b.y && y < b.y + b.h);
  const ok = (x, y) => x >= 1 && y >= 1 && x < MAP_W - 1 &&
                       y < MAP_H - 1 && !inVault(x, y);
  let sx = -1, sy = -1;
  for (let t = 0; t < 300 && sx < 0; t++) {
    const cx = 1 + 2 * ri(0, ((MAP_W - 3) / 2) | 0);
    const cy = 1 + 2 * ri(0, ((MAP_H - 3) / 2) | 0);
    if (ok(cx, cy)) { sx = cx; sy = cy; }
  }
  if (sx < 0) return null;            // no room for a maze
  const visited = new Set([sy * MAP_W + sx]);
  const stack = [[sx, sy]];
  tiles[sy][sx] = T.FLOOR;
  while (stack.length) {
    const [cx, cy] = stack[stack.length - 1];
    const nbrs = [];
    for (const [dx, dy] of [[2,0],[-2,0],[0,2],[0,-2]]) {
      const nx = cx + dx, ny = cy + dy;
      if (ok(nx, ny) && !visited.has(ny * MAP_W + nx)) {
        nbrs.push([nx, ny, dx, dy]);
      }
    }
    if (!nbrs.length) { stack.pop(); continue; }
    const [nx, ny, dx, dy] = pick(nbrs);
    tiles[cy + dy / 2][cx + dx / 2] = T.FLOOR;
    tiles[ny][nx] = T.FLOOR;
    visited.add(ny * MAP_W + nx);
    stack.push([nx, ny]);
  }
  const cells = largestFloorRegion(tiles, inVault);
  if (cells.length < 120) return null;
  return cellsToRooms(cells);
}

/* a city: open streets with a loose grid of walled buildings, each
 * a room reached through a single door. */
function cityLayout(tiles, blockers) {
  const inVault = (x, y) =>
    blockers.some(b => x >= b.x && x < b.x + b.w &&
                       y >= b.y && y < b.y + b.h);
  // streets: floor everywhere outside the vaults
  for (let y = 1; y < MAP_H - 1; y++)
    for (let x = 1; x < MAP_W - 1; x++)
      if (!inVault(x, y)) tiles[y][x] = T.FLOOR;
  const rooms = [];
  const cols = 4, rowsN = 3;
  const plotW = ((MAP_W - 2) / cols) | 0;
  const plotH = ((MAP_H - 2) / rowsN) | 0;
  for (let r = 0; r < rowsN; r++) {
    for (let c = 0; c < cols; c++) {
      const px = 1 + c * plotW, py = 1 + r * plotH;
      const bw = ri(6, plotW - 3), bh = ri(4, plotH - 3);
      const bx = px + ri(1, plotW - bw - 1);
      const by = py + ri(1, plotH - bh - 1);
      let clear = true;
      for (let y = by; y <= by + bh && clear; y++)
        for (let x = bx; x <= bx + bw && clear; x++)
          if (inVault(x, y) || x < 1 || y < 1 ||
              x >= MAP_W - 1 || y >= MAP_H - 1) clear = false;
      if (!clear) continue;
      for (let y = by; y <= by + bh; y++)
        for (let x = bx; x <= bx + bw; x++) {
          tiles[y][x] = (y === by || y === by + bh ||
                         x === bx || x === bx + bw) ? T.WALL : T.FLOOR;
        }
      // a door somewhere on the wall ring
      const side = ri(0, 3);
      let dx, dy;
      if (side === 0) { dx = bx + ri(1, bw - 1); dy = by; }
      else if (side === 1) { dx = bx + ri(1, bw - 1); dy = by + bh; }
      else if (side === 2) { dx = bx; dy = by + ri(1, bh - 1); }
      else { dx = bx + bw; dy = by + ri(1, bh - 1); }
      tiles[dy][dx] = T.DOOR;
      rooms.push({ x: bx + 1, y: by + 1, w: bw - 1, h: bh - 1,
                   cx: bx + (bw >> 1), cy: by + (bh >> 1) });
    }
  }
  return rooms.length >= 3 ? rooms : null;
}

/* which layout a (branch, depth) uses */
function pickLayout(branch, depth) {
  if (branch === "Surface") return "surface";
  if (branch === "Ruin") return chance(0.5) ? "cave" : "rooms";
  if (branch === "Lair" || branch === "Swamp" || branch === "Orc") {
    return "cave";
  }
  if (branch === "Vaults") return "city";
  if (branch === "Crypt") {              // the Crypt is a labyrinth
    return chance(0.6) ? "maze" : "rooms";
  }
  if (branch === "D") {
    // the Dungeon trunk stays readable -- rooms and caves, no mazes
    // (labyrinths live in the Crypt); it is the mandatory path.
    if (depth === 1 || depth === BRANCHES.D.levels) return "rooms";
    return depth % 2 === 0 ? "cave" : "rooms";
  }
  return "rooms";                        // Shoals
}

/* the surface: an outdoor map painted in biomes -- plains, forest,
 * swamp, mountains, lake. Tiles are open ground by default; each
 * biome's signature terrain is sprinkled on top. */
/* the world's biome at world coordinate (wx,wy). Deterministic --
 * the same coord always returns the same biome -- so chunks meet
 * seamlessly. Coords are quantised onto a coarse grid so each biome
 * region spans roughly half to three-quarters of a chunk -- big
 * enough that a forest reads as a forest, not as scattered trees. */
function biomeAtWorld(wx, wy) {
  // biome cells are 42x21 tiles -- about 3/4 of a chunk in each
  // direction. A chunk (56x26) usually holds 1-2 biome regions, not
  // a mosaic. Tweak these divisors to grow / shrink biome size.
  const bx = Math.floor(wx / 42), by = Math.floor(wy / 21);
  // a cheap 2D hash -> 0..1
  let k = (bx * 73856093) ^ (by * 19349663);
  k = (k >>> 0) % 1000;
  const r = k / 1000;
  // weights tuned so the surface FEELS open: lots of plains, real
  // forests and lakes for flavour, mountains kept sparse so the
  // overworld never feels like one walled-in room
  if (r < 0.58) return "plains";
  if (r < 0.78) return "forest";
  if (r < 0.86) return "mountains";
  if (r < 0.94) return "swamp";
  return "lake";
}

/* the surface as a chunk at (coord.cx, coord.cy). World coords come
 * from cx*MAP_W + x, cy*MAP_H + y -- so neighbouring chunks line up
 * in biome. */
function surfaceLayout(tiles, blockers, coord) {
  const cx = (coord && coord.cx) || 0;
  const cy = (coord && coord.cy) || 0;
  const inVault = (x, y) =>
    blockers.some(b => x >= b.x && x < b.x + b.w &&
                       y >= b.y && y < b.y + b.h);

  // 1. open ground EVERYWHERE -- including the very edge rows and
  //    columns. The Surface has no chunk-border wall; that's what
  //    lets the player step off into the neighbour chunk.
  for (let y = 0; y < MAP_H; y++)
    for (let x = 0; x < MAP_W; x++)
      if (!inVault(x, y)) tiles[y][x] = T.FLOOR;

  // 2. paint signature terrain by world-coord biome (full extent).
  // the SPAWN chunk (0,0) is kept extra open so the player can roam
  // freely as soon as they emerge: no mountains, gentler trees.
  const isSpawn = (cx === 0 && cy === 0);
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      if (inVault(x, y)) continue;
      const wx = cx * MAP_W + x, wy = cy * MAP_H + y;
      const b = biomeAtWorld(wx, wy);
      if (b === "forest" && chance(isSpawn ? 0.18 : 0.28)) {
        tiles[y][x] = T.TREE;
      } else if (b === "swamp") {
        if (chance(0.28)) tiles[y][x] = T.WATER;
        else if (chance(0.15)) tiles[y][x] = T.TREE;
      } else if (b === "mountains" && !isSpawn && chance(0.10)) {
        // sparse boulders, never solid walls
        tiles[y][x] = T.WALL;
      } else if (b === "lake" && chance(0.55)) {
        // deep middle of the lake when all 4 neighbours are also lake
        // biome; shallow rim when only some are -- gives lakes a
        // wadeable shore the player can step into
        const nb = [[1,0],[-1,0],[0,1],[0,-1]];
        const allLake = nb.every(([dx, dy]) =>
          biomeAtWorld(wx + dx, wy + dy) === "lake");
        tiles[y][x] = allLake ? T.DEEP_WATER : T.WATER;
      } else if (b === "plains" && chance(0.03)) {
        tiles[y][x] = T.TREE;
      }
    }
  }

  // 3. NO `largestFloorRegion` pass on the Surface -- the world keeps
  //    going, and walling off pockets just turns the chunk into one
  //    cramped room. Sample plains cells for the spawn / dungeon
  //    entrance positions so they land in open ground.
  const plainsCells = [];
  const anyCells = [];
  for (let y = 1; y < MAP_H - 1; y++) {
    for (let x = 1; x < MAP_W - 1; x++) {
      if (tiles[y][x] !== T.FLOOR) continue;
      anyCells.push([x, y]);
      const wx = cx * MAP_W + x, wy = cy * MAP_H + y;
      if (biomeAtWorld(wx, wy) === "plains") plainsCells.push([x, y]);
    }
  }
  if (anyCells.length < 60) return null;
  return cellsToRooms(plainsCells.length > 30 ? plainsCells : anyCells);
}

/* ---------- buildings on the Surface ----------
 * A small chunked sprinkling of homes, shops and the occasional
 * castle. Each building has walls + a door + a roof mask + a friendly
 * NPC inside; the NPC offers a quest (or runs a shop). Buildings are
 * stamped after the biome layout so they always carve a clean
 * footprint over trees / water. */
const NPC_NAMES_M = ["Aldric", "Brennan", "Cedric", "Dorin", "Eamon",
                     "Faolan", "Gawen", "Halric", "Ivar", "Jorund",
                     "Kael", "Lothar", "Mercer", "Niall", "Owain"];
const NPC_NAMES_F = ["Alira", "Brenna", "Cora", "Dahlia", "Elen",
                     "Faye", "Gwyn", "Hilde", "Iona", "Jora",
                     "Kit", "Lira", "Mira", "Nessa", "Orla"];
const SHOPKEEP_TITLES = ["the Trader", "the Provisioner", "the Merchant",
                         "the Stocker", "the Outfitter"];
const QUEST_GREETINGS = [
  "Traveller -- there's trouble. Will you help?",
  "You've the look of a hero. We've a need...",
  "Stranger, well met. Hear me out, would you?",
  "Help me, and you'll be paid for it.",
  "Bandits have been bold of late. Can you act?",
];
const QUEST_FETCH_HOOKS = [
  "We need a {item}. Find one and we'll reward you.",
  "Bring me a {item} from the wilds.",
  "A {item} would help my work -- bring one back.",
];
const QUEST_KILL_HOOKS = [
  "Slay {count} {name} -- they prey on our roads.",
  "{count} {name} have killed our livestock. Hunt them.",
  "Rid us of {count} {name}, and gold is yours.",
];

/* a sprinkling of buildings on a chunk: at most one each of home /
 * shop / castle. Stamps walls + floor + door onto the tile grid and
 * returns descriptors. */
/* the building sizes + how many rooms the interior partitions into */
const BUILDING_SIZES = {
  home:    { w: 5,  h: 5,  rooms: 1 },
  shop:    { w: 6,  h: 5,  rooms: 1 },
  manor:   { w: 9,  h: 7,  rooms: 3 },
  mansion: { w: 13, h: 11, rooms: 6 },
  ruin:    { w: 7,  h: 6,  rooms: 2 },
  castle:  { w: 13, h: 9,  rooms: 5 },
};

/* BSP-style partition: split the largest sub-rect of the building's
 * interior until we have the target number of rooms. Returns the room
 * rects plus the interior walls (each with one door) that separate
 * them. Rooms with one dimension < 5 stop splitting further. */
function partitionBuildingInterior(b, targetCount) {
  const rooms = [{ x: b.x + 1, y: b.y + 1, w: b.w - 2, h: b.h - 2 }];
  const walls = [];
  while (rooms.length < targetCount) {
    let bestIdx = -1, bestArea = 0;
    for (let i = 0; i < rooms.length; i++) {
      const r = rooms[i];
      if (r.w < 6 && r.h < 6) continue;
      const area = r.w * r.h;
      if (area > bestArea) { bestArea = area; bestIdx = i; }
    }
    if (bestIdx < 0) break;
    const r = rooms[bestIdx];
    let splitVert;
    if (r.w >= 6 && r.h >= 6) splitVert = r.w >= r.h;
    else if (r.w >= 6) splitVert = true;
    else splitVert = false;
    if (splitVert) {
      const sx = ri(r.x + 2, r.x + r.w - 3);
      const doorY = ri(r.y + 1, r.y + r.h - 2);
      const left  = { x: r.x, y: r.y, w: sx - r.x, h: r.h };
      const right = { x: sx + 1, y: r.y, w: r.w - (sx - r.x) - 1, h: r.h };
      walls.push({ vertical: true, col: sx,
                   y1: r.y, y2: r.y + r.h - 1, doorY });
      rooms.splice(bestIdx, 1, left, right);
    } else {
      const sy = ri(r.y + 2, r.y + r.h - 3);
      const doorX = ri(r.x + 1, r.x + r.w - 2);
      const top    = { x: r.x, y: r.y, w: r.w, h: sy - r.y };
      const bottom = { x: r.x, y: sy + 1, w: r.w, h: r.h - (sy - r.y) - 1 };
      walls.push({ vertical: false, row: sy,
                   x1: r.x, x2: r.x + r.w - 1, doorX });
      rooms.splice(bestIdx, 1, top, bottom);
    }
  }
  return { rooms, walls };
}

/* a proper castle: outer curtain wall + four corner towers + open
 * courtyard + central keep with its own door and rooms. Returns a
 * building descriptor whose ROOF only covers the inner keep, so the
 * courtyard reads as open ground (no roof from outside) but the keep
 * still hides its rooms until you walk in.
 *
 * Layout (W = wall, . = floor, K = keep wall, = = main gate, + = keep door):
 *   T-WWWWWWWWWWWWW-T
 *   W................W
 *   W..KKKKKKKKKKK...W
 *   W..K.........K...W
 *   W..K..rooms..K...W
 *   W..K.........K...W
 *   W..KKKKK+KKKKK...W
 *   W................W
 *   T-WWWWWW=WWWWWW-T
 */
function placeCastleFootprint(tiles, blockers) {
  const w = 19, h = 13;             // big outer footprint
  for (let tries = 0; tries < 80; tries++) {
    const x = ri(2, MAP_W - w - 4);
    const y = ri(2, MAP_H - h - 5);
    let ok = true;
    for (let yy = y; yy < y + h && ok; yy++) {
      for (let xx = x; xx < x + w && ok; xx++) {
        const t = tiles[yy][xx];
        if (t === T.WATER || t === T.LAVA || t === T.BRANCH ||
            t === T.STAIRS_DOWN || t === T.STAIRS_UP ||
            t === T.ALTAR || t === T.SHOP) ok = false;
      }
    }
    if (!ok) continue;
    const clash = (blockers || []).some(b =>
      rectsClash(x, y, w, h, b.x, b.y, b.w, b.h, 1));
    if (clash) continue;

    // 1. carve the whole footprint to FLOOR (the courtyard)
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        tiles[yy][xx] = T.FLOOR;
      }
    }
    // 2. outer curtain wall ring
    for (let xx = x; xx < x + w; xx++) {
      tiles[y][xx] = T.WALL;
      tiles[y + h - 1][xx] = T.WALL;
    }
    for (let yy = y; yy < y + h; yy++) {
      tiles[yy][x] = T.WALL;
      tiles[yy][x + w - 1] = T.WALL;
    }
    // 3. four corner towers -- a 2x2 wall bump at each outer corner
    // makes the silhouette read as a fortified building, not a barn
    const corners = [
      [x + 1, y + 1], [x + w - 3, y + 1],
      [x + 1, y + h - 3], [x + w - 3, y + h - 3],
    ];
    for (const [tx, ty] of corners) {
      for (let dx = 0; dx < 2; dx++)
        for (let dy = 0; dy < 2; dy++) tiles[ty + dy][tx + dx] = T.WALL;
    }
    // 4. main gate -- a THREE-TILE wide gate centred on the south
    // curtain (left + middle + right pieces). Render picks the sprite
    // automatically from neighbours.
    const gateX = x + (w >> 1), gateY = y + h - 1;
    tiles[gateY][gateX - 1] = T.GATE;
    tiles[gateY][gateX]     = T.GATE;
    tiles[gateY][gateX + 1] = T.GATE;
    // approach south of the gate -- 3-tile wide road too
    for (let ay = 1; ay <= 3; ay++) {
      const yy = gateY + ay;
      if (yy >= 1 && yy < MAP_H - 1) {
        tiles[yy][gateX - 1] = T.FLOOR;
        tiles[yy][gateX]     = T.FLOOR;
        tiles[yy][gateX + 1] = T.FLOOR;
      }
    }
    // 5. inner keep -- centred, leaving courtyard around it (3+ cells
    // of breathing room from the outer wall)
    const kw = 11, kh = 7;
    const kx = x + ((w - kw) >> 1);
    const ky = y + ((h - kh) >> 1) - 1;     // leans north to leave a yard
    for (let yy = ky; yy < ky + kh; yy++) {
      for (let xx = kx; xx < kx + kw; xx++) {
        const isEdge = (xx === kx || xx === kx + kw - 1 ||
                        yy === ky || yy === ky + kh - 1);
        tiles[yy][xx] = isEdge ? T.WALL : T.FLOOR;
      }
    }
    // partition the keep into multiple rooms (a great hall + chambers)
    const part = partitionBuildingInterior(
      { x: kx, y: ky, w: kw, h: kh }, 4);
    for (const wall of part.walls) {
      if (wall.vertical) {
        for (let yy = wall.y1; yy <= wall.y2; yy++)
          tiles[yy][wall.col] = T.WALL;
        tiles[wall.doorY][wall.col] = T.DOOR;
      } else {
        for (let xx = wall.x1; xx <= wall.x2; xx++)
          tiles[wall.row][xx] = T.WALL;
        tiles[wall.row][wall.doorX] = T.DOOR;
      }
    }
    // 6. keep door -- south face of the inner keep
    const keepDoorX = kx + (kw >> 1);
    const keepDoorY = ky + kh - 1;
    tiles[keepDoorY][keepDoorX] = T.DOOR;
    // ensure the cell south of the keep door is FLOOR (courtyard)
    if (keepDoorY + 1 < y + h - 1) tiles[keepDoorY + 1][keepDoorX] = T.FLOOR;
    // a roof variant + stone theme for the whole castle
    const roofTile = 4;             // heavy old shingle
    const wallPool = ri(0, 9999);
    const floorPool = ri(0, 5);
    return {
      type: "castle",
      x, y, w, h,
      doorX: gateX, doorY: gateY,    // outer gate
      roofTile, wallPool, floorPool,
      // the roof only covers the inner keep, NOT the courtyard
      roofRect: { x: kx, y: ky, w: kw, h: kh },
      keepDoorX, keepDoorY,
      rooms: part.rooms,
    };
  }
  return null;
}

function placeBuildingFootprint(tiles, type, blockers) {
  const sz = BUILDING_SIZES[type] || BUILDING_SIZES.home;
  for (let tries = 0; tries < 80; tries++) {
    const x = ri(2, MAP_W - sz.w - 4);
    const y = ri(2, MAP_H - sz.h - 5);
    let ok = true;
    for (let yy = y; yy < y + sz.h && ok; yy++) {
      for (let xx = x; xx < x + sz.w && ok; xx++) {
        const t = tiles[yy][xx];
        if (t === T.WATER || t === T.LAVA || t === T.BRANCH ||
            t === T.STAIRS_DOWN || t === T.STAIRS_UP ||
            t === T.ALTAR || t === T.SHOP) ok = false;
      }
    }
    if (!ok) continue;
    const clash = (blockers || []).some(b =>
      rectsClash(x, y, sz.w, sz.h, b.x, b.y, b.w, b.h, 1));
    if (clash) continue;
    // outer ring of walls, interior floor
    for (let yy = y; yy < y + sz.h; yy++) {
      for (let xx = x; xx < x + sz.w; xx++) {
        const isEdge = (xx === x || xx === x + sz.w - 1 ||
                        yy === y || yy === y + sz.h - 1);
        tiles[yy][xx] = isEdge ? T.WALL : T.FLOOR;
      }
    }
    // partition the interior; walls + doors are then stamped on top
    const b0 = { x, y, w: sz.w, h: sz.h };
    const part = partitionBuildingInterior(b0, sz.rooms);
    for (const w of part.walls) {
      if (w.vertical) {
        for (let yy = w.y1; yy <= w.y2; yy++) tiles[yy][w.col] = T.WALL;
        tiles[w.doorY][w.col] = T.DOOR;
      } else {
        for (let xx = w.x1; xx <= w.x2; xx++) tiles[w.row][xx] = T.WALL;
        tiles[w.row][w.doorX] = T.DOOR;
      }
    }
    // outer door on the south side, with a short FLOOR approach so
    // trees / mountain biome can't wall the player out
    const doorX = x + (sz.w >> 1), doorY = y + sz.h - 1;
    tiles[doorY][doorX] = T.DOOR;
    for (let ay = 1; ay <= 3; ay++) {
      const yy = doorY + ay;
      if (yy >= 1 && yy < MAP_H - 1) tiles[yy][doorX] = T.FLOOR;
    }
    // ensure the south door opens into a room: clear any interior wall
    // tile right inside the door
    const insideX = doorX, insideY = doorY - 1;
    if (insideY > y && tiles[insideY][insideX] === T.WALL) {
      tiles[insideY][insideX] = T.FLOOR;
    }
    // Surface shops no longer paint a T.SHOP counter tile -- the
    // shopkeeper NPC handles the bump-to-shop interaction. The
    // tile type still exists for dungeon-floor shops generated by
    // the regular level pipeline.
    // pick a roof variant per building type
    let roofTile;
    if (type === "shop") roofTile = chance(0.5) ? 1 : 2;
    else if (type === "castle" || type === "ruin") roofTile = 4;
    else if (type === "mansion") roofTile = pick([0, 3, 5]);  // red/yellow/raw
    else roofTile = ri(0, 5);
    // each building rolls its own stone style from MANIFEST.dngn.
    // building_walls (100+ themes derived from source/rltiles/dngn/wall)
    // -- the modulo in render keeps things in range if the array grows
    // or shrinks across versions. Floors stay in the small curated pool
    // so interiors read as living spaces, not biomes.
    const wallPool = ri(0, 9999);
    const floorPool = ri(0, 5);
    return { type, x, y, w: sz.w, h: sz.h, doorX, doorY, roofTile,
             wallPool, floorPool, rooms: part.rooms };
  }
  return null;
}

/* generate an indoor sub-level (cellar / upper floor) that MIRRORS the
 * source building's footprint -- same outer walls, same room partition,
 * same stone theme -- but with new doors, new mobs and new treasure
 * each visit. The "return" stair lands at the cell the player took to
 * leave (so coming back puts you back on the same tile), and there is
 * sometimes a further stair to keep climbing / descending. */
function generateIndoorLevel(coord) {
  const floor = coord && coord.floor ? coord.floor : -1;
  // chunk-editor override -- a hand-painted indoor floor at this
  // (cx, cy, floor) takes precedence over the procedural mirror
  if (coord && Number.isFinite(coord.cx) && Number.isFinite(coord.cy)) {
    const custom = loadCustomChunkData(coord.cx, coord.cy, floor);
    if (custom) {
      return buildCustomLevel(custom, "Indoors",
        coord.cx, coord.cy, floor);
    }
  }
  const tiles = [];
  for (let y = 0; y < MAP_H; y++) tiles.push(new Array(MAP_W).fill(T.WALL));
  // look up the source building so the mirror level can use its
  // footprint, rooms and stone theme
  let source = null;
  if (coord && typeof coord.bidx === "number") {
    const sl = G.levels["Surface:" + coord.cx + "," + coord.cy];
    if (sl) source = sl.level.buildings && sl.level.buildings[coord.bidx];
  }
  // footprint: either a copy of the source building, or a small
  // fallback rectangle if the building can't be found
  let ox, oy, w, h;
  if (source) {
    ox = source.x; oy = source.y; w = source.w; h = source.h;
  } else {
    w = ri(13, 21); h = ri(9, 13);
    ox = (MAP_W - w) >> 1; oy = (MAP_H - h) >> 1;
  }
  for (let yy = oy; yy < oy + h; yy++) {
    for (let xx = ox; xx < ox + w; xx++) {
      const isEdge = (xx === ox || xx === ox + w - 1 ||
                      yy === oy || yy === oy + h - 1);
      tiles[yy][xx] = isEdge ? T.WALL : T.FLOOR;
    }
  }
  // partition into rooms. Use the same count as the source for mirror
  // floors so the upstairs feels like a second story of the same house;
  // otherwise pick a count tied to the floor distance.
  const roomCount = source ? Math.max(1, source.rooms.length)
                            : ri(2, Math.min(5, 2 + Math.abs(floor)));
  const part = partitionBuildingInterior(
    { x: ox, y: oy, w, h }, roomCount);
  for (const wall of part.walls) {
    if (wall.vertical) {
      for (let yy = wall.y1; yy <= wall.y2; yy++) tiles[yy][wall.col] = T.WALL;
      tiles[wall.doorY][wall.col] = T.DOOR;
    } else {
      for (let xx = wall.x1; xx <= wall.x2; xx++) tiles[wall.row][xx] = T.WALL;
      tiles[wall.row][wall.doorX] = T.DOOR;
    }
  }
  const rooms = part.rooms;
  // place the return-stair: upper floors land on STAIRS_DOWN (descend
  // back to ground), cellars land on STAIRS_UP (ascend back). Land at
  // coord.returnAt (the cell the player came from) so traversal is
  // round-trip-consistent; fall back to the source stair's surface pos
  // and finally to the first room's centre.
  const returnKind = (floor > 0) ? T.STAIRS_DOWN : T.STAIRS_UP;
  const inFootprint = (x, y) => x > ox && x < ox + w - 1 &&
                                y > oy && y < oy + h - 1;
  let rx, ry;
  const ra = coord && coord.returnAt;
  if (ra && inFootprint(ra.x, ra.y)) { rx = ra.x; ry = ra.y; }
  else if (source) {
    const ss = (floor > 0) ? source.upperStair : source.cellarStair;
    if (ss && inFootprint(ss.x, ss.y)) { rx = ss.x; ry = ss.y; }
  }
  if (rx == null) {
    const r0 = rooms[0];
    rx = r0.x + (r0.w >> 1); ry = r0.y + (r0.h >> 1);
  }
  tiles[ry][rx] = returnKind;
  // chance of a further stair extending the chain. Place it in a
  // different room than the return stair so navigation feels real.
  const farRoll = (Math.abs(floor) >= 3) ? 0.20 : 0.55;
  if (chance(farRoll)) {
    const chainKind = (floor > 0) ? T.STAIRS_UP : T.STAIRS_DOWN;
    for (let i = rooms.length - 1; i >= 0; i--) {
      const r = rooms[i];
      if (rx >= r.x && rx < r.x + r.w && ry >= r.y && ry < r.y + r.h) continue;
      const cells = pickInteriorCells(tiles, r);
      if (!cells.length) continue;
      const c = cells[ri(0, cells.length - 1)];
      tiles[c.y][c.x] = chainKind;
      break;
    }
  }
  // hostile mobs: cellars + deeper floors hold more (and tougher) ones.
  // Boss areas: cellar floor -3 or deeper has a chance of a BOSS lairing
  // in the final room (a huge surprise sprite + heavy HP/damage).
  const buildingMons = [];
  if (floor < 0) {
    const want = Math.min(5, 1 + Math.abs(floor) * 2);
    const tier = Math.min(4, 1 + Math.abs(floor));
    // bosses are RARE -- a sure-death surprise. Most cellar runs end
    // with a captain or rabble; only the deepest, luckiest floors hold
    // a boss in the back room.
    const bossRoll = (Math.abs(floor) >= 4) ? 0.25
                   : (Math.abs(floor) === 3) ? 0.10
                   : 0;
    const bossRoom = chance(bossRoll) ? rooms[rooms.length - 1] : null;
    if (bossRoom) {
      const cells = pickInteriorCells(tiles, bossRoom);
      if (cells.length) {
        const c = cells[ri(0, cells.length - 1)];
        const bn = pickBossName();
        if (bn) buildingMons.push({ x: c.x, y: c.y, defName: bn });
      }
    }
    for (let i = 0; i < want; i++) {
      const r = pick(rooms);
      // don't crowd the boss room with rabble -- skip it for regular mobs
      if (bossRoom && r === bossRoom) continue;
      const cells = pickInteriorCells(tiles, r);
      if (!cells.length) continue;
      const c = cells[ri(0, cells.length - 1)];
      const name = pickIndoorMonsterName(tier);
      if (name) buildingMons.push({ x: c.x, y: c.y, defName: name });
    }
  } else if (floor > 0 && chance(0.20)) {
    // a haunted upstairs occasionally has a single weak mob
    const r = pick(rooms);
    const cells = pickInteriorCells(tiles, r);
    if (cells.length) {
      const c = cells[ri(0, cells.length - 1)];
      const name = pickIndoorMonsterName(1);
      if (name) buildingMons.push({ x: c.x, y: c.y, defName: name });
    }
  }
  // treasure: cellars hold proper chests (worth descending for); upper
  // floors keep the lighter background loot you find around a house.
  // Deeper cellars roll a higher chest tier and chest chance.
  const buildingItems = [];
  const treasureCount = (floor < 0) ? ri(2, 4) : ri(0, 2);
  for (let i = 0; i < treasureCount; i++) {
    const r = pick(rooms);
    const cells = pickInteriorCells(tiles, r);
    if (!cells.length) continue;
    const c = cells[ri(0, cells.length - 1)];
    const roll = Math.random();
    const chestChance = floor < 0 ? (0.30 + Math.abs(floor) * 0.05) : 0.0;
    if (roll < chestChance) {
      buildingItems.push(makeChestItem(Math.abs(floor) + 1, c.x, c.y));
      // a guard stands watch beside the chest -- adjacent free floor
      const guardCells = pickInteriorCells(tiles, r)
        .filter(gc => Math.max(Math.abs(gc.x - c.x),
                                Math.abs(gc.y - c.y)) === 1);
      if (guardCells.length) {
        const g = guardCells[ri(0, guardCells.length - 1)];
        const gTier = Math.min(4, 2 + Math.abs(floor));
        const gName = pickGuardName(gTier);
        if (gName) buildingMons.push({
          x: g.x, y: g.y, defName: gName,
          guardsChest: { x: c.x, y: c.y } });
      }
    } else if (roll < chestChance + 0.40) {
      buildingItems.push({ ...ITEM_KINDS[2], x: c.x, y: c.y,
        amount: ri(15, 35 + Math.abs(floor) * 18) });
    } else if (roll < chestChance + 0.62) {
      buildingItems.push(makePotionItem(
        pick(["heal", "might", "haste", "magic"]), c.x, c.y));
    } else if (roll < chestChance + 0.82) {
      buildingItems.push(makeGemItem(Math.abs(floor) + 1, c.x, c.y));
    } else {
      buildingItems.push(makeScrollItem(c.x, c.y));
    }
  }
  // captives for active rescue quests targeting this (chunk, floor).
  // The quest's hook only names the region + building TYPE, not the
  // specific building, and chunks routinely hold several buildings
  // with cellars -- so we match on (cx, cy, floor) and lock the
  // captive to the FIRST cellar the player descends into.  After
  // that, q.captiveCellarBidx pins the spawn so other cellars in the
  // same chunk don't double-spawn the same captive on later visits.
  const npcs = [];
  if (G && G.quests && coord) {
    for (const q of G.quests) {
      if (q.status !== "active" || q.type !== "rescue") continue;
      const ra = q.rescueAt;
      if (!ra) continue;
      if (ra.cx !== coord.cx || ra.cy !== coord.cy) continue;
      if (ra.floor !== floor) continue;
      if (q.captiveCellarBidx == null) q.captiveCellarBidx = coord.bidx;
      if (q.captiveCellarBidx !== coord.bidx) continue;
      // pick a free FLOOR cell in a non-return room
      const free = [];
      for (let i = 0; i < rooms.length; i++) {
        if (rooms[i].x <= rx && rx < rooms[i].x + rooms[i].w &&
            rooms[i].y <= ry && ry < rooms[i].y + rooms[i].h) continue;
        for (const c of pickInteriorCells(tiles, rooms[i])) free.push(c);
      }
      const spot = free.length ? free[ri(0, free.length - 1)]
                                : { x: rx + 1, y: ry };
      npcs.push({
        x: spot.x, y: spot.y,
        name: q.captiveName + " (captive)",
        glyph: "@", colour: "LIGHTCYAN",
        kind: "captive",
        tile: pickNpcTile("captive"),
        captiveQuestId: q.id,
      });
      break;
    }
  }

  // expose a building entry for the mirror so render's per-building
  // stone theme + roomAt lookups work indoors too. We use the source
  // building's roofTile / wallPool / floorPool so the upstairs reads
  // visually as "the same house, one storey higher."
  const buildingMirror = source
    ? { type: source.type, x: ox, y: oy, w, h,
        doorX: source.doorX, doorY: source.doorY,
        roofTile: source.roofTile, wallPool: source.wallPool,
        floorPool: source.floorPool, rooms: rooms,
        hostile: source.hostile, indoorMirror: true }
    : { type: "indoor", x: ox, y: oy, w, h,
        doorX: ox + (w >> 1), doorY: oy + h - 1,
        roofTile: 0, wallPool: 0, floorPool: 0,
        rooms: rooms, hostile: floor < 0, indoorMirror: true };
  return {
    tiles,
    rooms: rooms.map(r => ({ ...r, cx: r.x + (r.w >> 1),
                              cy: r.y + (r.h >> 1) })),
    branch: "Indoors", depth: 1,
    diff: Math.max(1, 1 + Math.abs(floor)),
    entrances: [], orbCell: null, traps: [], shop: null,
    vaultCount: 0, vaultMons: [], vaultItems: [], tileArt: {},
    isCave: false, altarGod: null,
    indoorFloor: floor,
    buildings: [buildingMirror], npcs,
    buildingMons, buildingItems,
    surfaceCoord: null,
  };
}

/* ----- Castle pocket-branch -----
 *
 * A castle is keyed by the Surface chunk it belongs to (sx, sy). Its
 * interior is a chunked grid in its own right -- (icx, icy) coords
 * with edge transitions like the Surface -- so the castle takes ONE
 * tile on the world map but can be many chunks across inside.
 *
 * Painted castle chunks are loaded verbatim from
 * `Editor:Castle:<sx>,<sy>:<icx>,<icy>:<floor>`. Unpainted chunks
 * fall back to a procedural stone courtyard so the player can walk
 * between painted areas without hitting unreachable voids.
 */
function generateCastleLevel(coord) {
  const c = coord || { sx: 0, sy: 0, icx: 0, icy: 0, floor: 0 };
  const sx = c.sx | 0, sy = c.sy | 0;
  const icx = c.icx | 0, icy = c.icy | 0;
  const floor = c.floor | 0;
  // editor override takes precedence
  const custom = loadCustomCastleChunk(sx, sy, icx, icy, floor);
  if (custom) {
    const lvl = buildCustomLevel(custom, "Castle", icx, icy, floor);
    lvl.castleCoord = { sx, sy, icx, icy };
    lvl.indoorFloor = floor;
    return lvl;
  }
  // procedural courtyard: stone-tiled walkway with scattered standing
  // stones for visual interest. Edges stay open so the player can
  // cross into the neighbouring interior chunk.
  const tiles = [];
  for (let y = 0; y < MAP_H; y++) tiles.push(new Array(MAP_W).fill(T.FLOOR));
  // scatter a handful of standing stones away from the edges so a
  // pure-courtyard chunk still has some texture
  const seed = (sx * 73856093) ^ (sy * 19349663) ^
               (icx * 83492791) ^ (icy * 73856093) ^ floor;
  const rng = (() => { let s = (seed >>> 0) || 1;
    return () => (s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000; })();
  const decor = 4 + Math.floor(rng() * 6);
  for (let i = 0; i < decor; i++) {
    const x = 3 + Math.floor(rng() * (MAP_W - 6));
    const y = 3 + Math.floor(rng() * (MAP_H - 6));
    if (tiles[y][x] === T.FLOOR) tiles[y][x] = T.STANDING_STONE;
  }
  const rooms = [{ x: 1, y: 1, w: MAP_W - 2, h: MAP_H - 2,
                   cx: MAP_W >> 1, cy: MAP_H >> 1 }];
  return {
    tiles, rooms,
    branch: "Castle", depth: 1, diff: 2,
    entrances: [], orbCell: null, traps: [], shop: null,
    vaultCount: 0, vaultMons: [], vaultItems: [], tileArt: {},
    isCave: false, altarGod: null,
    castleCoord: { sx, sy, icx, icy },
    indoorFloor: floor,
    buildings: [], npcs: [], buildingMons: [], buildingItems: [],
    poiCells: [], teleporters: {},
    surfaceCoord: null,
  };
}

/* the building's room containing (lx, ly), or null. Used by the roof
 * mask: only the player's current room is unroofed; other rooms stay
 * hidden until you walk into them. */
function roomAt(b, lx, ly) {
  for (const r of (b.rooms || [])) {
    if (lx >= r.x && lx < r.x + r.w &&
        ly >= r.y && ly < r.y + r.h) return r;
  }
  return null;
}

/* the building whose *interior* (not the wall ring) contains (lx,ly),
 * or null. Used for "player is inside this building" tests. */
/* pick a friendly NPC sprite from MANIFEST.npc for the given kind.
 * Falls back to a halfling sprite when the npc tile bundle isn't
 * loaded (older data file). Tile choice is a one-off at gen time --
 * the chosen path is stamped on the NPC so it stays consistent. */
function pickNpcTile(kind) {
  const npc = (MANIFEST && MANIFEST.npc) || null;
  if (!npc) return null;
  let prefixes;
  if (kind === "shopkeeper") {
    prefixes = ["farmer-man", "worker-man", "official", "elder-woman",
                "elder-man", "magic-elder", "robbed-elder", "man", "woman"];
  } else if (kind === "captive") {
    prefixes = ["cloaked-girl", "girl", "boy", "robbed-elder"];
  } else if (kind === "child") {
    prefixes = ["girl", "boy"];
  } else if (kind === "king") {
    // a wise / regal silhouette -- magic elder + officials lean kingly
    prefixes = ["magic-elder", "elder-man", "official", "robbed-elder"];
  } else if (kind === "blacksmith") {
    // burly worker / fighter silhouettes for the smith
    prefixes = ["fighter-man", "worker-man", "farmer-man", "man"];
  } else {
    // questgiver, default
    prefixes = ["man", "woman", "elder-man", "elder-woman",
                "fighter-man", "magic-elder", "farmer-man", "official"];
  }
  const candidates = [];
  for (const p of prefixes) {
    for (const k in npc) {
      if (k === p || k.startsWith(p + "-") || k.startsWith(p + "1-")) {
        candidates.push(npc[k]);
      }
    }
  }
  return candidates.length ? pick(candidates) : null;
}

function buildingAt(lvl, lx, ly) {
  const list = lvl && lvl.buildings;
  if (!list || !list.length) return null;
  for (const b of list) {
    // castles count "inside" as the inner keep -- the courtyard is
    // open ground even though it's within the outer wall
    const r = b.roofRect || { x: b.x, y: b.y, w: b.w, h: b.h };
    if (lx > r.x && lx < r.x + r.w - 1 &&
        ly > r.y && ly < r.y + r.h - 1) return b;
  }
  return null;
}

/* the building whose ROOFED rectangle (interior + roofed walls)
 * contains (lx,ly), or null. For most buildings that's the full
 * footprint; for castles it's just the inner keep so the courtyard
 * stays unroofed (open air, visible from outside). */
function buildingInBoundsAt(lvl, lx, ly) {
  const list = lvl && lvl.buildings;
  if (!list || !list.length) return null;
  for (const b of list) {
    const r = b.roofRect || { x: b.x, y: b.y, w: b.w, h: b.h };
    if (lx >= r.x && lx <= r.x + r.w - 1 &&
        ly >= r.y && ly <= r.y + r.h - 1) return b;
  }
  return null;
}

/* the building whose OUTER footprint contains (lx,ly). Used for the
 * per-building stone theme so castle outer walls match the keep's. */
function buildingOuterAt(lvl, lx, ly) {
  const list = lvl && lvl.buildings;
  if (!list || !list.length) return null;
  for (const b of list) {
    if (lx >= b.x && lx <= b.x + b.w - 1 &&
        ly >= b.y && ly <= b.y + b.h - 1) return b;
  }
  return null;
}

/* mobs that lurk inside cellars + deeper floors -- the full pool of
 * indoor creatures: underground weirdos (aberrations, undead, demons,
 * fungi, statues) PLUS humanoids (kobolds, orcs, ogres ...) and the
 * smaller fauna that nest in dark places. Tier caps depth. */
function pickIndoorMonsterName(tier) {
  const cap = Math.max(1, tier);
  let pool = (DATA.monsters || []).filter(m =>
    !m.boss && m.tier >= 1 && m.tier <= cap &&
    m.name && m.name.length < 28 &&
    !/kraken|swamp drake|deep elf master/i.test(m.name));
  return pool.length ? pick(pool).name : null;
}

/* a boss: chosen at random from the pool of m.boss === true defs.
 * Caller decides where to place it (deep cellar terminal room, castle
 * treasury, etc) -- bosses are deliberately rare encounters. */
function pickBossName() {
  const pool = (DATA.monsters || []).filter(m => m.boss);
  return pool.length ? pick(pool).id : null;
}

/* the soldier / knight pool, by tier. Used to populate castle guards
 * and chest-defenders -- the "asses" who answer for the treasure.
 * Falls back to a generic surface humanoid if no def exists yet. */
const GUARD_BY_TIER = {
  1: ["MONS_SQUIRE", "MONS_TOWN_GUARD", "MONS_WATCHMAN"],
  2: ["MONS_FOOTMAN", "MONS_HALBERDIER", "MONS_SPEARMAN", "MONS_CROSSBOWMAN"],
  3: ["MONS_KNIGHT", "MONS_SERGEANT", "MONS_CAPTAIN"],
  4: ["MONS_PALADIN", "MONS_BLACK_KNIGHT"],
};

/* the set of monster ids that are LAWFUL guards -- spawn as neutral,
 * patrol idly, and only turn hostile when the player provokes them
 * (attacks them, or opens a chest they're watching). */
const GUARDIAN_IDS = new Set([
  "MONS_SQUIRE", "MONS_TOWN_GUARD", "MONS_WATCHMAN",
  "MONS_FOOTMAN", "MONS_HALBERDIER", "MONS_SPEARMAN", "MONS_CROSSBOWMAN",
  "MONS_KNIGHT", "MONS_SERGEANT", "MONS_CAPTAIN",
  "MONS_PALADIN", "MONS_BLACK_KNIGHT", "MONS_VAULT_GUARD",
]);
function isGuardian(def) { return !!(def && GUARDIAN_IDS.has(def.id)); }
function pickGuardName(tier) {
  const t = Math.max(1, Math.min(4, tier));
  const pool = (GUARD_BY_TIER[t] || []).filter(
    id => DATA.monsters.some(m => m.id === id));
  if (pool.length) return pick(pool);
  // fallback if the new defs aren't loaded (older save / data)
  return pickSurfaceLairMonsterName(tier);
}

/* mobs for SURFACE ruined buildings -- restricted to the surface
 * biomes (humanoids + animals) so abandoned houses on the open road
 * are bandits / verminous wildlife, not eldritch flesh-cages. */
function pickSurfaceLairMonsterName(tier) {
  const cap = Math.max(1, tier);
  let pool = (DATA.monsters || []).filter(m =>
    !m.boss &&
    (m.biome === "surface_humanoid" || m.biome === "surface_animal") &&
    m.tier >= 1 && m.tier <= cap &&
    m.name && m.name.length < 28);
  if (!pool.length) {
    pool = (DATA.monsters || []).filter(m =>
      !m.boss && m.tier >= 1 && m.tier <= cap && m.name && m.name.length < 28);
  }
  return pool.length ? pick(pool).name : null;
}

function pickInteriorCells(tiles, room) {
  const out = [];
  for (let yy = room.y; yy < room.y + room.h; yy++) {
    for (let xx = room.x; xx < room.x + room.w; xx++) {
      if (tiles[yy][xx] === T.FLOOR) out.push({ x: xx, y: yy });
    }
  }
  return out;
}

/* generate the buildings + NPCs for a Surface chunk */
function generateSurfaceBuildings(tiles, coord, blockers) {
  const buildings = [];
  const npcs = [];
  const buildingMons = [];   // hostile mobs placed inside ruined / haunted
  const buildingItems = [];  // treasure piles inside cellars / mansions

  const onSpawn = coord && coord.cx === 0 && coord.cy === 0;
  // 10% of non-spawn chunks are villages: a cluster of 3-5 homes,
  // usually a shop, sometimes a manor. The rest of the world is the
  // sparse mix the player wanders between.
  const isVillage = !onSpawn && chance(0.10);
  const rolls = onSpawn
    ? [{ type: "home", chance: 1.0 }]
    : isVillage
    ? (() => {
        const list = [{ type: "shop", chance: 0.75 },
                      { type: "manor", chance: 0.45 }];
        const homes = ri(3, 5);
        for (let i = 0; i < homes; i++) {
          list.push({ type: "home", chance: 1.0 });
        }
        return list;
      })()
    : [{ type: "home",    chance: 0.24 },
       { type: "manor",   chance: 0.10 },
       { type: "shop",    chance: 0.08 },
       { type: "ruin",    chance: 0.07 },
       { type: "mansion", chance: 0.03 },
       { type: "castle",  chance: 0.02 }];

  for (const r of rolls) {
    if (!chance(r.chance)) continue;
    // castles use a bespoke generator (curtain wall + courtyard + keep)
    const b = (r.type === "castle")
      ? placeCastleFootprint(tiles, blockers)
      : placeBuildingFootprint(tiles, r.type, blockers);
    if (!b) continue;
    buildings.push(b);
    blockers.push(b);

    // hostile vs friendly variant
    // castles are always defended -- soldiers + knights stand between
    // the player and the treasure. Ruins are bandit / vermin lairs.
    // Mansions are mostly civilian but 30% haunted.
    const hostile = (r.type === "ruin") ||
                    (r.type === "castle") ||
                    (r.type === "mansion" && chance(0.30));
    b.hostile = hostile;

    // cellar + upper-floor stairs -- placed FIRST so NPCs / treasure /
    // mobs picked afterwards naturally avoid those cells (they only
    // accept FLOOR tiles).
    const cellarRoll = ({ home: 0.18, shop: 0.10, manor: 0.45,
                          ruin: 0.85, mansion: 0.75, castle: 0.60
                        })[r.type] || 0;
    const upperRoll  = ({ home: 0.10, manor: 0.30, mansion: 0.75,
                          castle: 0.65, shop: 0.05
                        })[r.type] || 0;
    if (chance(cellarRoll)) {
      const room = b.rooms[b.rooms.length - 1];
      const cells = pickInteriorCells(tiles, room);
      if (cells.length) {
        const c = cells[ri(0, cells.length - 1)];
        tiles[c.y][c.x] = T.STAIRS_DOWN;
        b.cellarStair = { x: c.x, y: c.y };
      }
    }
    if (chance(upperRoll)) {
      const room = b.rooms[Math.min(1, b.rooms.length - 1)];
      const cells = pickInteriorCells(tiles, room);
      if (cells.length) {
        const c = cells[ri(0, cells.length - 1)];
        tiles[c.y][c.x] = T.STAIRS_UP;
        b.upperStair = { x: c.x, y: c.y };
      }
    }

    if (!hostile) {
      // friendly NPC stands in the FIRST partitioned room (closest to
      // the door); other rooms hold quiet life or small treasure
      const mainRoom = b.rooms[0];
      const candidates = pickInteriorCells(tiles, mainRoom);
      if (candidates.length) {
        const npcPos = candidates[ri(0, candidates.length - 1)];
        const female = chance(0.5);
        const baseName = pick(female ? NPC_NAMES_F : NPC_NAMES_M);
        const npcKind = r.type === "shop" ? "shopkeeper" : "questgiver";
        npcs.push({
          x: npcPos.x, y: npcPos.y,
          name: r.type === "shop"
            ? baseName + " " + pick(SHOPKEEP_TITLES)
            : baseName,
          glyph: "@",
          colour: r.type === "shop" ? "LIGHTGREEN"
                : r.type === "castle" ? "WHITE"
                : r.type === "mansion" ? "YELLOW"
                : "LIGHTCYAN",
          kind: npcKind,
          tile: pickNpcTile(npcKind),
          building: buildings.length - 1,
        });
        // a wandering child for the household (atmosphere only -- bump
        // for a quip, no quests). Homes + manors get them most often.
        const childRoll = r.type === "home" ? 0.45
                        : r.type === "manor" ? 0.35
                        : r.type === "mansion" ? 0.30
                        : 0;
        if (chance(childRoll)) {
          const others = candidates.filter(c =>
            !(c.x === npcPos.x && c.y === npcPos.y));
          if (others.length) {
            const cp = others[ri(0, others.length - 1)];
            const childName = pick(NPC_NAMES_M.concat(NPC_NAMES_F));
            npcs.push({
              x: cp.x, y: cp.y, name: childName,
              glyph: "@", colour: "LIGHTBLUE",
              kind: "child",
              tile: pickNpcTile("child"),
              building: buildings.length - 1,
            });
          }
        }
      }
      // a manor / mansion's side rooms hold a mix of small stashes and
      // the occasional treasure chest -- mansions especially earn their
      // exploration. Castles get the best chest odds.
      if (r.type === "manor" || r.type === "mansion") {
        const chestRoll = r.type === "mansion" ? 0.4 : 0.2;
        const chestTier = r.type === "mansion" ? 2 : 1;
        for (let ri2 = 1; ri2 < b.rooms.length; ri2++) {
          const cells = pickInteriorCells(tiles, b.rooms[ri2]);
          if (!cells.length) continue;
          const spot = cells.splice(ri(0, cells.length - 1), 1)[0];
          const roll = Math.random();
          if (roll < chestRoll) {
            buildingItems.push(makeChestItem(chestTier, spot.x, spot.y));
            // mansions occasionally post a private guard next to a chest
            if (r.type === "mansion" && cells.length && chance(0.55)) {
              const g = cells[ri(0, cells.length - 1)];
              const gName = pickGuardName(2);
              if (gName) buildingMons.push({
                x: g.x, y: g.y, defName: gName,
                guardsChest: { x: spot.x, y: spot.y } });
            }
          } else if (roll < chestRoll + 0.5) {
            buildingItems.push({ ...ITEM_KINDS[2],
              x: spot.x, y: spot.y, amount: ri(8, 26) });
          } else {
            buildingItems.push(makePotionItem(
              pick(["heal", "might", "haste"]),
              spot.x, spot.y));
          }
        }
      }
    } else {
      // hostile: each room gets one or more guards; the final room is
      // the treasury (chest + a captain / knight standing watch).
      // Castles use soldier / knight defs ("being asses"); ruins use
      // brigand + vermin wildlife.
      const tier = (r.type === "castle") ? 3
                 : (r.type === "mansion") ? 2 : 1;
      const useGuards = (r.type === "castle");
      // castles enthrone a KING in the main keep room -- a friendly
      // questgiver who hands out major retrieve-the-relic quests with
      // hefty rewards. Place him first so the guard loop below knows
      // to avoid his tile.
      let kingPos = null;
      if (r.type === "castle" && b.rooms.length) {
        const kingRoom = b.rooms[0];
        const cells = pickInteriorCells(tiles, kingRoom);
        if (cells.length) {
          kingPos = cells[ri(0, cells.length - 1)];
          const baseName = pick(NPC_NAMES_M);
          npcs.push({
            x: kingPos.x, y: kingPos.y,
            name: "King " + baseName,
            glyph: "@", colour: "YELLOW",
            kind: "king",
            tile: pickNpcTile("king"),
            building: buildings.length - 1,
          });
        }
      }
      // castle courtyard: stationed patrol guards between the curtain
      // wall and the inner keep, so reaching the keep door is a real
      // approach, not just a stroll through an empty yard
      if (r.type === "castle" && b.roofRect) {
        const rr = b.roofRect;
        const yard = [];
        for (let yy = b.y + 1; yy < b.y + b.h - 1; yy++) {
          for (let xx = b.x + 1; xx < b.x + b.w - 1; xx++) {
            if (xx >= rr.x && xx < rr.x + rr.w &&
                yy >= rr.y && yy < rr.y + rr.h) continue;
            if (tiles[yy][xx] !== T.FLOOR) continue;
            yard.push([xx, yy]);
          }
        }
        const patrol = ri(3, 5);
        for (let i = 0; i < patrol && yard.length; i++) {
          const [px, py] = yard.splice(ri(0, yard.length - 1), 1)[0];
          const gName = pickGuardName(tier);
          if (gName) buildingMons.push({ x: px, y: py, defName: gName });
        }
      }
      for (let ri2 = 0; ri2 < b.rooms.length; ri2++) {
        const cells = pickInteriorCells(tiles, b.rooms[ri2])
          .filter(c => !(kingPos && c.x === kingPos.x && c.y === kingPos.y));
        if (!cells.length) continue;
        const wantMobs = (r.type === "castle") ? 2
                       : (r.type === "mansion") ? 2 : 1;
        for (let m = 0; m < wantMobs && cells.length; m++) {
          const idx = ri(0, cells.length - 1);
          const pos = cells.splice(idx, 1)[0];
          const defName = useGuards
            ? pickGuardName(tier)
            : pickSurfaceLairMonsterName(tier);
          if (defName) buildingMons.push({ x: pos.x, y: pos.y, defName });
        }
        // terminal room: a chest + a higher-tier guard standing right
        // beside it. Castles get a captain / paladin; mansions a knight.
        if (ri2 === b.rooms.length - 1) {
          const remaining = cells;
          if (remaining.length) {
            const t = remaining.splice(ri(0, remaining.length - 1), 1)[0];
            const ct = (r.type === "castle") ? 4
                     : (r.type === "mansion") ? 3 : 2;
            buildingItems.push(makeChestItem(ct, t.x, t.y));
            // chest guard -- the "ass" who answers for the treasure.
            // Castle treasuries occasionally swap the guard for a true
            // BOSS encounter (a giant sprite, big HP, surprise!)
            if (remaining.length) {
              const g = remaining[ri(0, remaining.length - 1)];
              const gTier = (r.type === "castle") ? 4 : 3;
              // castles guard their treasury, but a boss is the rare
              // exception, not the rule
              const useBoss = (r.type === "castle") && chance(0.12);
              const gName = useBoss ? pickBossName()
                : (useGuards
                  ? pickGuardName(gTier)
                  : pickGuardName(Math.min(3, gTier)));
              if (gName) buildingMons.push({
                x: g.x, y: g.y, defName: gName,
                guardsChest: { x: t.x, y: t.y } });
            }
          }
        }
      }
    }
  }
  return { buildings, npcs, buildingMons, buildingItems };
}

/* the biome at the player's current Surface tile */
function biomeAtSurfaceTile(x, y) {
  if (!G || G.branch !== "Surface") return null;
  const c = G.surfaceCoord || { cx: 0, cy: 0 };
  return biomeAtWorld(c.cx * MAP_W + x, c.cy * MAP_H + y);
}

/* ---------- chunk lookup for multi-chunk rendering ----------
 * Returns the cached chunk for (cx,cy), generating it on demand. The
 * generator is the same `newLevel` pipeline as a normal level, but
 * the chunk doesn't become "current" -- it sits in G.levels purely
 * so the render can read its tiles when the viewport spans chunk
 * boundaries. */
/* read a custom chunk that the chunk editor stashed in localStorage,
 * keyed by (cx,cy,floor). Returns the saved snapshot or null. */
function loadCustomChunkData(cx, cy, floor) {
  if (typeof localStorage === "undefined") return null;
  let raw;
  try { raw = localStorage.getItem("crawlweb.customChunks"); }
  catch (e) { return null; }
  if (!raw) return null;
  let all;
  try { all = JSON.parse(raw); } catch (e) { return null; }
  return all["Editor:" + cx + "," + cy + ":" + (floor || 0)] || null;
}

/* ---- Build mode: player paints tiles into the live chunk ----
 *
 * Press B in-game to open. Click a brush, click the map to place.
 * Right-click erases to FLOOR. Edits are applied to G.level.tiles
 * immediately AND snapshotted to crawlweb.playerHome so they survive
 * deaths / new runs. Costs in materials are checked in phase 3+.
 */
const BUILD_BRUSHES = [
  { t: 1,  name: "Floor",   glyph: ".", costs: {},          tileKey: "floor",       tileScope: "dngn", desc: "erase / floor" },
  { t: 0,  name: "Wall",    glyph: "#", costs: { stone: 1 }, tileKey: "wall",        tileScope: "dngn" },
  { t: 4,  name: "Door",    glyph: "+", costs: { wood: 2 },  tileKey: "door_closed", tileScope: "dngn" },
  { t: 8,  name: "Tree",    glyph: "&", costs: { wood: 1 },  tileKey: "tree",        tileScope: "dngn" },
  { t: 33, name: "Hearth",  glyph: "H", costs: { wood: 5, stone: 5 }, oneOnly: "hearth", tileKey: "campsite", tileScope: "dngn" },
  { t: 34, name: "Bed",     glyph: "b", costs: { wood: 3 } },
  { t: 35, name: "Chest",   glyph: "c", costs: { wood: 2, stone: 1 }, tileKey: "chest", tileScope: "item" },
  { t: 36, name: "Sign",    glyph: "s", costs: { wood: 1 },  tileKey: "signpost",    tileScope: "dngn" },
  { t: 26, name: "Flowers", glyph: '"', costs: {},           tileKey: "flowers",     tileScope: "dngn" },
  { t: 6,  name: "Water",   glyph: "~", costs: {},           tileKey: "water",       tileScope: "dngn" },
  { t: 22, name: "Signpost",glyph: "s", costs: { wood: 2 },  tileKey: "signpost",    tileScope: "dngn" },
  { t: 19, name: "Camp",    glyph: "c", costs: { wood: 2 },  tileKey: "campsite",    tileScope: "dngn" },
  { t: 37, name: "Forge",   glyph: "F", costs: { wood: 3, stone: 5 }, tileKey: "forge", tileScope: "dngn" },
];

/* resolve a build brush's preview image path from the manifest. Some
 * keys are arrays of variants -- use the first. Returns null if the
 * brush has no image (e.g. Bed -- falls back to ASCII glyph). */
function brushImage(b) {
  if (!b || !b.tileKey || !MANIFEST) return null;
  const scope = (b.tileScope === "item") ? MANIFEST.item
              : (b.tileScope === "dngn") ? MANIFEST.dngn
              : MANIFEST.dngn;
  if (!scope) return null;
  const v = scope[b.tileKey];
  if (Array.isArray(v)) return v[0] || null;
  return v || null;
}
function getMaterials() {
  const h = ensurePlayerHome();
  return h.materials || { wood: 0, stone: 0 };
}
function canAfford(brush) {
  const mats = getMaterials();
  for (const k in (brush.costs || {})) {
    if ((mats[k] | 0) < brush.costs[k]) return false;
  }
  return true;
}
function spendCosts(costs) {
  if (!costs) return;
  const h = ensurePlayerHome();
  h.materials = h.materials || { wood: 0, stone: 0 };
  for (const k in costs) {
    h.materials[k] = Math.max(0, (h.materials[k] | 0) - costs[k]);
  }
  savePlayerHome(h);
}
function openBuildMode() {
  if (!G || G.over) return;
  G.buildMode = true;
  G.buildBrush = G.buildBrush || BUILD_BRUSHES[0];
  renderBuildHud();
  const hud = document.getElementById("build-hud");
  if (hud) hud.classList.remove("hidden");
  const cv = document.getElementById("map-canvas");
  if (cv) cv.classList.add("in-build-mode");
  logMsg("Build mode: pick a brush, click to place. (B / Esc closes)", "sys");
  render();
}
function closeBuildMode() {
  if (!G) return;
  G.buildMode = false;
  const hud = document.getElementById("build-hud");
  if (hud) hud.classList.add("hidden");
  const cv = document.getElementById("map-canvas");
  if (cv) cv.classList.remove("in-build-mode");
  render();
}
function toggleBuildMode() {
  if (G && G.buildMode) closeBuildMode();
  else openBuildMode();
}
function renderBuildHud() {
  const matsEl = document.getElementById("build-materials");
  const brushesEl = document.getElementById("build-brushes");
  if (!matsEl || !brushesEl) return;
  const mats = getMaterials();
  matsEl.innerHTML = "<b>Wood:</b> " + (mats.wood | 0) +
                     " &nbsp; <b>Stone:</b> " + (mats.stone | 0);
  const h = ensurePlayerHome();
  brushesEl.innerHTML = "";
  for (const b of BUILD_BRUSHES) {
    const btn = document.createElement("button");
    btn.className = "build-brush";
    if (G.buildBrush && G.buildBrush.t === b.t) btn.classList.add("active");
    const affordable = canAfford(b);
    const oneOnly = b.oneOnly === "hearth" && h.hearth;
    if (!affordable || oneOnly) btn.classList.add("cant");
    const costText = Object.keys(b.costs || {}).length
      ? Object.entries(b.costs).map(([k, v]) => v + k[0]).join(" ")
      : "free";
    const img = brushImage(b);
    const preview = img
      ? '<img class="brush-img" src="tiles/' + img + '" alt="">'
      : '<span class="glyph">' + b.glyph + '</span>';
    btn.innerHTML = preview + b.name + '<br><span class="cost">' +
                    (oneOnly ? "placed" : costText) + '</span>';
    btn.addEventListener("click", () => {
      if (oneOnly) {
        logMsg("Hearth already placed -- you can only have one home.", "dim");
        return;
      }
      G.buildBrush = b;
      renderBuildHud();
    });
    brushesEl.appendChild(btn);
  }
}
/* paint one cell with the current brush. erase = true sets it to
 * FLOOR (the universal "undo"). Returns true if the cell changed.
 * Erasing a TREE yields wood; erasing a WALL in the Dungeon (or in
 * build mode on any non-player wall) yields stone. */
function paintBuildCell(lx, ly, erase) {
  if (!G.buildMode) return false;
  if (lx < 0 || ly < 0 || lx >= MAP_W || ly >= MAP_H) return false;
  const brush = erase
    ? BUILD_BRUSHES[0]    // floor / erase
    : G.buildBrush || BUILD_BRUSHES[0];
  // can't paint over the player's tile
  if (G.player.x === lx && G.player.y === ly && brush.t !== T.FLOOR) {
    logMsg("Can't build under your own feet.", "dim");
    return false;
  }
  // one-only enforcement (hearth)
  const home = ensurePlayerHome();
  if (brush.oneOnly === "hearth" && home.hearth) return false;
  // affordability
  if (!erase && !canAfford(brush)) {
    logMsg("Not enough materials for " + brush.name + ".", "dim");
    return false;
  }
  // erasing trees / walls yields materials so the player has reason
  // to chop / mine in build mode
  if (erase) {
    const old = G.level.tiles[ly][lx];
    if (old === T.TREE) {
      home.materials = home.materials || { wood: 0, stone: 0 };
      home.materials.wood = (home.materials.wood | 0) + 1;
      savePlayerHome(home);
      logMsg("You chop the tree. +1 wood.", "good");
    } else if (old === T.WALL) {
      home.materials = home.materials || { wood: 0, stone: 0 };
      home.materials.stone = (home.materials.stone | 0) + 1;
      savePlayerHome(home);
      logMsg("You quarry the wall. +1 stone.", "good");
    }
  }
  // figure out the current chunk coord (Surface) or use 0,0 otherwise
  let chunkCx = 0, chunkCy = 0;
  if (G.branch === "Surface" && G.surfaceCoord) {
    chunkCx = G.surfaceCoord.cx; chunkCy = G.surfaceCoord.cy;
  } else if (G.branch === "Castle" && G.castleCoord) {
    // castles: build mode operates on the interior chunk too
    chunkCx = G.castleCoord.icx; chunkCy = G.castleCoord.icy;
  }
  // apply to live tiles
  G.level.tiles[ly][lx] = brush.t;
  // record on player home (Surface only for now -- the persistence
  // path is Surface-shaped)
  if (G.branch === "Surface") {
    snapshotPlayerChunk(chunkCx, chunkCy, 0, [{ x: lx, y: ly, t: brush.t }]);
  }
  // claim a hearth if that's what we placed
  if (brush.t === T.HEARTH) {
    home.hearth = { cx: chunkCx, cy: chunkCy, x: lx, y: ly };
    savePlayerHome(home);
    logMsg("You set the Hearth. This chunk is now your home.", "good");
  }
  // a sign: prompt for the message to engrave on it
  if (brush.t === T.PLAYER_SIGN && typeof prompt === "function") {
    const msg = prompt("Write on the sign:", "Welcome home.");
    if (msg != null) {
      home.signs = home.signs || {};
      const k = chunkCx + "," + chunkCy + ":" + lx + "," + ly;
      home.signs[k] = String(msg).slice(0, 120);   // cap to keep storage small
      savePlayerHome(home);
    }
  }
  // pay for it
  if (!erase) spendCosts(brush.costs);
  renderBuildHud();
  return true;
}

/* ---- Player Home: persistent across runs ----
 *
 * The player paints tiles into a chunk via build mode (B key). Those
 * changes are snapshotted into localStorage under `crawlweb.playerHome`
 * and re-applied every time the player walks back into that chunk --
 * across deaths, across new games, forever. Distinct namespace from
 * the editor's Editor: prefix so author and player don't collide.
 */
const PLAYER_HOME_KEY = "crawlweb.playerHome";
function loadPlayerHome() {
  if (typeof localStorage === "undefined") return null;
  let raw;
  try { raw = localStorage.getItem(PLAYER_HOME_KEY); }
  catch (e) { return null; }
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}
function savePlayerHome(data) {
  if (typeof localStorage === "undefined") return;
  try { localStorage.setItem(PLAYER_HOME_KEY, JSON.stringify(data)); }
  catch (e) { /* quota / disabled */ }
}
function ensurePlayerHome() {
  let h = loadPlayerHome();
  if (!h) {
    h = {
      chunks: {},            // "cx,cy:floor" -> { tiles: [[]] }
      hearth: null,          // { cx, cy, x, y } once placed
      materials: { wood: 0, stone: 0 },
      chestSlots: [],        // persistent chest inventory (across runs)
      signs: {},             // "cx,cy:x,y" -> "message text"
    };
  }
  return h;
}
function loadPlayerChunkPatch(cx, cy, floor) {
  const h = loadPlayerHome();
  if (!h || !h.chunks) return null;
  const key = (cx | 0) + "," + (cy | 0) + ":" + (floor | 0);
  return h.chunks[key] || null;
}
/* apply a player-home patch to a freshly-built level's tile array.
 * Only overwrites cells the player explicitly painted, so procedural
 * features the player didn't touch stay intact. */
function applyPlayerHomePatch(lvl, patch) {
  if (!lvl || !patch || !patch.tiles) return;
  for (let y = 0; y < MAP_H && y < patch.tiles.length; y++) {
    for (let x = 0; x < MAP_W && x < patch.tiles[y].length; x++) {
      const t = patch.tiles[y][x];
      if (t === -1 || t == null) continue;   // -1 = "not painted"
      lvl.tiles[y][x] = t | 0;
    }
  }
}
/* called after build mode commits edits: snapshot the chunk's tiles
 * (only the cells the player has painted) into localStorage. */
function snapshotPlayerChunk(cx, cy, floor, paintedCells) {
  const h = ensurePlayerHome();
  const key = (cx | 0) + "," + (cy | 0) + ":" + (floor | 0);
  const existing = h.chunks[key] || { tiles: null };
  // start a sparse 2D array of -1 (= not painted), or use the existing
  // patch as the base
  const tiles = existing.tiles || (() => {
    const t = [];
    for (let y = 0; y < MAP_H; y++) t.push(new Array(MAP_W).fill(-1));
    return t;
  })();
  for (const c of paintedCells) {
    if (c.y < 0 || c.y >= MAP_H || c.x < 0 || c.x >= MAP_W) continue;
    tiles[c.y][c.x] = c.t | 0;
  }
  h.chunks[key] = { tiles, savedAt: Date.now() };
  savePlayerHome(h);
}

/* Castle pocket-branch: a chunk-editor save keyed by the owning
 * Surface chunk (sx, sy), the INTERIOR chunk coord within the castle
 * (icx, icy), and a floor (0 / -1 / +1). Stored under the same
 * crawlweb.customChunks bag as Surface saves, with a distinct prefix. */
function loadCustomCastleChunk(sx, sy, icx, icy, floor) {
  if (typeof localStorage === "undefined") return null;
  let raw;
  try { raw = localStorage.getItem("crawlweb.customChunks"); }
  catch (e) { return null; }
  if (!raw) return null;
  let all;
  try { all = JSON.parse(raw); } catch (e) { return null; }
  const key = "Editor:Castle:" + sx + "," + sy +
              ":" + icx + "," + icy + ":" + (floor || 0);
  return all[key] || null;
}

/* turn a chunk-editor snapshot into a level object the game can use.
 * Skips the procedural niceties (rooms, vault detection, biome scatter)
 * -- the editor is responsible for what's on the canvas. */
function buildCustomLevel(snap, branch, cx, cy, floor) {
  const tiles = [];
  for (let y = 0; y < MAP_H; y++) tiles.push(new Array(MAP_W).fill(T.FLOOR));
  if (snap.tiles) {
    for (let y = 0; y < MAP_H && y < snap.tiles.length; y++) {
      for (let x = 0; x < MAP_W && x < snap.tiles[y].length; x++) {
        tiles[y][x] = snap.tiles[y][x] | 0;
      }
    }
  }
  const tileArt = {};
  if (snap.tileArt) {
    for (const k in snap.tileArt) {
      const v = snap.tileArt[k];
      if (typeof v === "string" && v.endsWith(".png")) tileArt[k] = v;
    }
  }
  const npcs = [];
  const buildingMons = [];
  const buildingItems = [];
  for (const e of (snap.entities || [])) {
    if (!Number.isFinite(e.x) || !Number.isFinite(e.y)) continue;
    if (e.kind === "mon") {
      const def = DATA.monsters.find(m => m.id === e.defId);
      if (def) buildingMons.push({ x: e.x, y: e.y, defName: def.name });
    } else if (e.kind === "npc") {
      const baseName = e.name || pick(NPC_NAMES_M.concat(NPC_NAMES_F));
      npcs.push({
        x: e.x, y: e.y,
        name: e.npcKind === "king" ? "King " + baseName : baseName,
        glyph: "@",
        colour: e.npcKind === "king" ? "YELLOW"
              : e.npcKind === "shopkeeper" ? "LIGHTGREEN"
              : e.npcKind === "blacksmith" ? "LIGHTRED"
              : "LIGHTCYAN",
        kind: e.npcKind || "questgiver",
        tile: pickNpcTile(e.npcKind || "questgiver"),
        building: 0,
        dialog: e.dialog || null,    // custom editor-written speech
      });
    } else if (e.kind === "item") {
      if (e.itemKey === "gold") {
        buildingItems.push({ ...ITEM_KINDS[2], x: e.x, y: e.y,
          amount: ri(20, 80) });
      } else if (e.itemKey === "chest") {
        buildingItems.push(makeChestItem(2, e.x, e.y));
      } else if (e.itemKey === "key") {
        buildingItems.push(makeKeyItem(e.x, e.y));
      } else if (e.itemKey === "food") {
        const k = (FOOD_KINDS || []).find(f => f.sub === e.sub) ||
                  (FOOD_KINDS && FOOD_KINDS[0]);
        if (k) buildingItems.push(makeFoodItem(e.x, e.y, k));
      } else if (POTION_FLAVOR[e.itemKey]) {
        buildingItems.push(makePotionItem(e.itemKey, e.x, e.y));
      } else if (SCROLL_FLAVOR[e.itemKey]) {
        buildingItems.push(makeScrollItemOf(e.itemKey, e.x, e.y));
      }
    }
  }
  // a single room covering the painted area so existing loops that
  // iterate lvl.rooms don't crash
  const rooms = [{ x: 1, y: 1, w: MAP_W - 2, h: MAP_H - 2,
                   cx: MAP_W >> 1, cy: MAP_H >> 1 }];
  // collect POI cells for the world-map markers
  const POI_KINDS = new Set([T.WELL, T.SHRINE, T.GRAVE, T.CAMPSITE,
    T.IDOL, T.MANA_NODE, T.SIGNPOST, T.BEACON, T.WISHING_WELL,
    T.STANDING_STONE, T.FLOWERS, T.LECTERN, T.FRUIT_CACHE]);
  const poiCells = [];
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      if (POI_KINDS.has(tiles[y][x])) {
        poiCells.push({ x, y, t: tiles[y][x] });
      }
    }
  }
  // teleporter destinations, keyed by y*MAP_W+x -> {cx, cy, x, y}
  const teleporters = {};
  if (snap.teleporters) {
    for (const k in snap.teleporters) teleporters[k] = snap.teleporters[k];
  }
  return {
    tiles, rooms,
    branch, depth: 1, diff: 2,
    entrances: [], orbCell: null, traps: [], shop: null,
    vaultCount: 0, vaultMons: [], vaultItems: [], tileArt,
    isCave: false, altarGod: null,
    surfaceCoord: branch === "Surface" ? { cx, cy } : null,
    indoorFloor: branch === "Indoors" ? (floor | 0) : 0,
    buildings: [], npcs, buildingMons, buildingItems,
    poiCells, teleporters, custom: true,
  };
}

function ensureSurfaceChunk(cx, cy) {
  const key = "Surface:" + cx + "," + cy;
  let entry = G.levels[key];
  if (entry) return entry;
  // chunk editor override -- if the player painted a chunk at (cx,cy)
  // via editor.html and clicked "Save to game", use it verbatim
  const custom = loadCustomChunkData(cx, cy, 0);
  const lvl = custom ? buildCustomLevel(custom, "Surface", cx, cy)
                     : newLevel("Surface", 1, 2, { cx, cy });
  // player-home overlay: stamp the player's own painted tiles ON TOP
  // of the procedural / editor chunk, so a player-built home survives
  // the procedural respawn / level regeneration.
  const patch = loadPlayerChunkPatch(cx, cy, 0);
  if (patch) applyPlayerHomePatch(lvl, patch);
  const monsters = spawnMonsters(lvl);
  // hostile mobs placed inside ruined / haunted buildings
  for (const bm of (lvl.buildingMons || [])) {
    const def = monsterDefByName(bm.defName);
    if (!def) continue;
    const m = makeMonster(def, bm.x, bm.y);
    if (bm.guardsChest) m.guardsChest = bm.guardsChest;
    monsters.push(m);
  }
  const items = spawnItems(lvl);
  // treasure stashes generated inside buildings
  for (const bi of (lvl.buildingItems || [])) items.push(bi);
  const npcs = lvl.npcs || [];
  const visible = [], seen = [];
  for (let y = 0; y < MAP_H; y++) {
    visible.push(new Array(MAP_W).fill(false));
    seen.push(new Array(MAP_W).fill(false));
  }
  entry = { level: lvl, monsters, items, npcs, visible, seen, orbPos: null };
  G.levels[key] = entry;
  return entry;
}

/* the "live" data for chunk (cx,cy): if it's the chunk the player is
 * standing on, the live G.level/G.visible/G.seen; otherwise a stash */
function chunkData(cx, cy) {
  if (G.branch === "Surface" && G.surfaceCoord &&
      G.surfaceCoord.cx === cx && G.surfaceCoord.cy === cy) {
    return { level: G.level, monsters: G.monsters, items: G.items,
             npcs: G.npcs || [], visible: G.visible, seen: G.seen,
             orbPos: G.orbPos };
  }
  return ensureSurfaceChunk(cx, cy);
}

/* look up the tile at world coord (wx,wy), generating its chunk if
 * we have not seen it yet */
function worldTileAt(wx, wy) {
  const cx = Math.floor(wx / MAP_W), cy = Math.floor(wy / MAP_H);
  const lx = wx - cx * MAP_W, ly = wy - cy * MAP_H;
  const d = chunkData(cx, cy);
  return d.level.tiles[ly][lx];
}

/* the player's position in world coords (chunked surface) */
function playerWorldX() {
  return (G.surfaceCoord ? G.surfaceCoord.cx * MAP_W : 0) + G.player.x;
}
function playerWorldY() {
  return (G.surfaceCoord ? G.surfaceCoord.cy * MAP_H : 0) + G.player.y;
}

/* an organic blob of up to `size` cells grown by random walk from a
 * seed -- the shape of a lake / lava pool / tree grove. */
function blobCells(sx, sy, size) {
  const cells = [[sx, sy]];
  const set = new Set([sy * MAP_W + sx]);
  let guard = 0;
  while (cells.length < size && guard++ < size * 12) {
    const [cx, cy] = cells[ri(0, cells.length - 1)];
    const [dx, dy] = pick([[1, 0], [-1, 0], [0, 1], [0, -1]]);
    const nx = cx + dx, ny = cy + dy;
    if (nx < 1 || ny < 1 || nx >= MAP_W - 1 || ny >= MAP_H - 1) continue;
    const k = ny * MAP_W + nx;
    if (set.has(k)) continue;
    set.add(k);
    cells.push([nx, ny]);
  }
  return cells;
}

/* can the up stair still reach the down stair, every branch entrance
 * and the Orb cell -- and is a healthy chunk of the level reachable?
 * Used to reject terrain that would wall the level off. */
function levelConnected(tiles, mustReach) {
  let up = null;
  const required = [];
  for (let y = 0; y < MAP_H; y++)
    for (let x = 0; x < MAP_W; x++) {
      const t = tiles[y][x];
      if (t === T.STAIRS_UP) up = { x, y };
      else if (t === T.STAIRS_DOWN || t === T.BRANCH) required.push(y * MAP_W + x);
    }
  if (mustReach) required.push(mustReach.y * MAP_W + mustReach.x);
  if (!up) return true;
  const seen = [];
  for (let y = 0; y < MAP_H; y++) seen.push(new Array(MAP_W).fill(false));
  const stack = [[up.x, up.y]];
  seen[up.y][up.x] = true;
  let reached = 1;
  while (stack.length) {
    const [x, y] = stack.pop();
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= MAP_W || ny >= MAP_H) continue;
      if (seen[ny][nx]) continue;
      const t = tiles[ny][nx];
      if (t === T.WALL || t === T.LAVA || t === T.TREE) continue;
      seen[ny][nx] = true;
      reached++;
      stack.push([nx, ny]);
    }
  }
  // the up stair must not be sealed into a cramped pocket
  if (reached < 80) return false;
  return required.every(k => seen[(k / MAP_W) | 0][k % MAP_W]);
}

/* scatter ambient terrain -- lakes, lava pools, tree groves -- across
 * the open level, themed per branch. Water is always safe (passable);
 * lava and trees are reverted if a blob would wall the level off. */
function scatterTerrain(tiles, branch, blockers, orbCell) {
  const cfg = TERRAIN[branch] || TERRAIN.D;
  const inVault = (x, y) =>
    blockers.some(b => x >= b.x && x < b.x + b.w &&
                       y >= b.y && y < b.y + b.h);
  const placeable = (x, y) => {
    if (inVault(x, y)) return false;
    if (orbCell && x === orbCell.x && y === orbCell.y) return false;
    const t = tiles[y][x];
    return t === T.FLOOR || t === T.WALL;   // never stairs/doors/altar/branch
  };
  // water lakes -- carve freely, they only ever add passable space
  for (let i = 0; i < cfg.water; i++) {
    for (const [x, y] of blobCells(ri(4, MAP_W - 5), ri(4, MAP_H - 5),
                                   ri(14, 46))) {
      if (placeable(x, y)) tiles[y][x] = T.WATER;
    }
  }
  // lava pools and tree groves -- placed, then rolled back per blob
  // if they would break the level's connectivity
  const risky = [[cfg.lava, T.LAVA, 10, 26], [cfg.trees, T.TREE, 8, 22]];
  for (const [count, feat, lo, hi] of risky) {
    for (let i = 0; i < count; i++) {
      const changes = [];
      for (const [x, y] of blobCells(ri(4, MAP_W - 5), ri(4, MAP_H - 5),
                                     ri(lo, hi))) {
        if (!placeable(x, y)) continue;
        changes.push([x, y, tiles[y][x]]);
        tiles[y][x] = feat;
      }
      if (!levelConnected(tiles, orbCell)) {
        for (const [x, y, old] of changes) tiles[y][x] = old;
      }
    }
  }
}

/* a shop's stock: a handful of items with gold prices, rolled when
 * the level is generated. Bought equipment goes to the backpack. */
function rollShopStock(diff) {
  const stock = [];
  const n = ri(4, 7);
  for (let i = 0; i < n; i++) {
    const r = Math.random();
    let item = null;
    if (r < 0.30 && WEAPONS.length) {
      const w = brandWeapon(WEAPONS[ri(1, Math.min(WEAPONS.length - 1,
                                                   2 + diff))]);
      item = { key: "weapon", name: weaponLabel(w), weapon: w,
               price: 22 + w.sides * 6 + (w.ego ? 45 : 0) };
    } else if (r < 0.55) {
      const a = makeArmourItem(diff, 0, 0);
      if (a) item = { key: "armour", name: a.name, armour: a.armour,
                      price: 18 + a.armour.ac * 13 };
    } else if (r < 0.68) {
      const g = makeRingItem(0, 0);
      if (g) item = { key: "ring", name: g.name, ring: g.ring,
                      price: 40 + g.ring.plus * 9 };
    } else if (r < 0.79) {
      const wd = makeWandItem(0, 0);
      if (wd) item = { key: "wand", name: wd.name, wand: wd.wand,
                       price: 50 + wd.wand.charges * 4 };
    } else if (r < 0.90) {
      const pot = pick(["heal", "heal", "heal", "might", "haste",
                        "berserk", "magic", "cancel"]);
      const f = POTION_FLAVOR[pot];
      item = { key: pot, name: f.name,
               price: (pot === "haste" || pot === "berserk") ? 38
                    : (pot === "magic" || pot === "cancel") ? 34 : 28 };
    } else {
      const sc = pick(["teleport", "fear", "mapping", "noise"]);
      item = { key: "scroll", scroll: sc, price: 32,
               name: SCROLL_FLAVOR[sc].name };
    }
    if (item) stock.push(item);
  }
  return stock;
}

/* hidden traps on plain floor -- dart (damage), teleport (relocation)
 * and alarm (wakes the floor). Stored as data; the tile stays floor
 * until the trap is sprung or spotted. */
function placeTraps(tiles, orbCell) {
  const traps = [];
  const want = ri(1, 4);
  let guard = 0;
  while (traps.length < want && guard++ < 300) {
    const x = ri(2, MAP_W - 3), y = ri(2, MAP_H - 3);
    if (tiles[y][x] !== T.FLOOR) continue;
    if (orbCell && x === orbCell.x && y === orbCell.y) continue;
    if (traps.some(t => t.x === x && t.y === y)) continue;
    traps.push({
      x, y, known: false,
      kind: pick(["dart", "dart", "dart", "teleport", "alarm", "slow"]),
    });
  }
  return traps;
}

function newLevel(branch, depth, diff, coord) {
  // Indoors levels (cellars / upper floors) have their own pipeline -- a
  // small partitioned space, not the full chunk/cave generator
  if (branch === "Indoors") return generateIndoorLevel(coord);
  // Castle pocket-branch: each interior chunk is either loaded verbatim
  // from a chunk-editor save, or filled with a procedural stone
  // courtyard so unpainted chunks still walkable.
  if (branch === "Castle") return generateCastleLevel(coord);

  const tiles = [];
  for (let y = 0; y < MAP_H; y++) {
    tiles.push(new Array(MAP_W).fill(T.WALL));
  }

  // --- 1. place authored vaults first, into the empty rock ---
  const vaultRooms = [];
  const blockers = [];          // rects rooms must avoid
  const vaultMons = [];         // {x,y,name} content placed by vaults
  const vaultItems = [];        // {x,y,kind}
  const tileArt = {};           // y*MAP_W+x -> custom tile name (FTILE/RTILE)
  const wantVaults = VAULTS.length ? ri(1, 2) : 0;
  for (let v = 0; v < wantVaults; v++) {
    const vault = pick(VAULTS);
    if (vault.w > MAP_W - 4 || vault.h > MAP_H - 4) continue;
    for (let tries = 0; tries < 60; tries++) {
      const ox = ri(1, MAP_W - vault.w - 2);
      const oy = ri(1, MAP_H - vault.h - 2);
      const clash = blockers.some(b =>
        rectsClash(ox, oy, vault.w, vault.h, b.x, b.y, b.w, b.h, 2));
      if (clash) continue;
      stampVault(tiles, vault, ox, oy);
      const rect = {
        x: ox, y: oy, w: vault.w, h: vault.h,
        cx: ox + (vault.w >> 1), cy: oy + (vault.h >> 1),
        isVault: true, vaultName: vault.name,
        connect: vaultConnectPoint(vault, ox, oy),
      };
      vaultRooms.push(rect);
      blockers.push(rect);
      // the vault's authored monsters / items (vault-local -> level)
      for (const m of (vault.mons || [])) {
        vaultMons.push({ x: ox + m[0], y: oy + m[1], name: m[2] });
      }
      for (const it of (vault.items || [])) {
        vaultItems.push({ x: ox + it[0], y: oy + it[1], kind: it[2] });
      }
      // the vault's authored custom floor / wall tiles (FTILE / RTILE)
      for (const a of (vault.art || [])) {
        const ax = ox + a[0], ay = oy + a[1];
        if (ax >= 0 && ay >= 0 && ax < MAP_W && ay < MAP_H) {
          tileArt[ay * MAP_W + ax] = a[2];
        }
      }
      break;
    }
  }

  // --- 2. lay out the level: caves, a maze, a city, a surface, or rooms ---
  let rooms = null;
  let layout = pickLayout(branch, depth);
  if (layout === "cave") rooms = caveLayout(tiles, blockers);
  else if (layout === "maze") rooms = mazeLayout(tiles, blockers);
  else if (layout === "city") rooms = cityLayout(tiles, blockers);
  else if (layout === "surface") rooms = surfaceLayout(tiles, blockers, coord);
  if (!rooms) layout = "rooms";          // any layout may fall back
  // open layouts (cave / maze) hold fewer monsters and skip the
  // room-edge door pass; the rooms layout chains corridors itself
  const isCave = (layout === "cave" || layout === "maze");
  const roomsLayout = (layout === "rooms");
  if (!rooms) {
    rooms = [];
    for (let a = 0; a < 90 && rooms.length < 12; a++) {
      const w = ri(4, 11), h = ri(3, 7);
      const x = ri(1, MAP_W - w - 2), y = ri(1, MAP_H - h - 2);
      const r = { x, y, w, h, cx: x + (w >> 1), cy: y + (h >> 1) };
      const clash = rooms.concat(blockers).some(o =>
        rectsClash(x, y, w, h, o.x, o.y, o.w, o.h, 1));
      if (clash) continue;
      for (let yy = y; yy < y + h; yy++)
        for (let xx = x; xx < x + w; xx++)
          tiles[yy][xx] = T.FLOOR;
      rooms.push(r);
    }
    // chain the rooms with corridors (caves / mazes / cities connect
    // themselves)
    for (let i = 1; i < rooms.length; i++) {
      carveCorridor(tiles, rooms[i - 1].cx, rooms[i - 1].cy,
                    rooms[i].cx, rooms[i].cy);
    }
  }

  // --- 3. connect each vault to the nearest room / cave point ---
  for (const vr of vaultRooms) {
    let near = rooms[0], best = 1e9;
    for (const r of rooms) {
      const d = Math.abs(r.cx - vr.cx) + Math.abs(r.cy - vr.cy);
      if (d < best) { best = d; near = r; }
    }
    if (near) {
      carveCorridor(tiles, vr.connect.x, vr.connect.y, near.cx, near.cy);
    }
  }

  // --- 3b. doorways: turn some room entrances into closed doors ---
  if (roomsLayout) for (const r of rooms) {
    const edges = [];
    for (let x = r.x; x < r.x + r.w; x++) {
      edges.push([x, r.y - 1, 1, 0]);       // top edge, check left/right
      edges.push([x, r.y + r.h, 1, 0]);     // bottom edge
    }
    for (let y = r.y; y < r.y + r.h; y++) {
      edges.push([r.x - 1, y, 0, 1]);       // left edge, check up/down
      edges.push([r.x + r.w, y, 0, 1]);     // right edge
    }
    for (const [ex, ey, perpX, perpY] of edges) {
      if (ex < 1 || ey < 1 || ex >= MAP_W - 1 || ey >= MAP_H - 1) continue;
      if (tiles[ey][ex] !== T.FLOOR) continue;          // a carved opening
      // only a clean 1-wide doorway: the perpendicular sides are walls
      if (tiles[ey - perpY][ex - perpX] !== T.WALL) continue;
      if (tiles[ey + perpY][ex + perpX] !== T.WALL) continue;
      if (chance(0.55)) {
        // pick a door flavour: mostly plain wooden, sometimes locked
        // or gated, rarely (on deeper floors) steel-reinforced
        const r = Math.random();
        if (r < 0.60) tiles[ey][ex] = T.DOOR;
        else if (r < 0.85) tiles[ey][ex] = T.DOOR_LOCKED;
        else if (r < 0.95) tiles[ey][ex] = T.GATE;
        else tiles[ey][ex] = (depth >= 3) ? T.DOOR_STEEL : T.DOOR_LOCKED;
      }
    }
  }

  // --- 4. stairs go in real rooms (never a vault) ---
  // the Surface has no stairs of its own -- you reach it by climbing
  // out of a dungeon, and descend into one via a branch entrance
  const firstRoom = rooms[0];
  const lastRoom = rooms[rooms.length - 1];
  if (branch !== "Surface") {
    tiles[firstRoom.cy][firstRoom.cx] = T.STAIRS_UP;
  }
  // a down stair on every level except the bottom of its branch
  if (branch !== "Surface" && depth < BRANCHES[branch].levels) {
    tiles[lastRoom.cy][lastRoom.cx] = T.STAIRS_DOWN;
  }
  // the Crown rests in a real room at the Dungeon's bottom
  let orbCell = null;
  if (branch === "D" && depth === BRANCHES.D.levels) {
    const realRooms = rooms.filter(r => !r.isVault);
    const r = realRooms[realRooms.length - 1];
    tiles[r.cy][r.cx] = T.FLOOR;
    orbCell = { x: r.cx, y: r.cy };
  }

  // a pool of free middle rooms for altars / branch entrances
  const midRooms = [];
  for (let i = 1; i < rooms.length - 1; i++) {
    const r = rooms[i];
    if (tiles[r.cy][r.cx] === T.FLOOR) midRooms.push(r);
  }

  // --- 5. branch entrances ---
  // the Dungeon hosts the Lair / Orc / ... side branches; the Surface
  // hosts the dungeon entrances (the main Dungeon plus a Ruin).
  const entrances = [];
  // dungeon entrances live on the spawn chunk of the Surface (0,0);
  // other surface chunks are just biome to explore. The Dungeon trunk
  // hosts its own side-branches as before.
  const onSpawnChunk = branch === "Surface" && coord &&
                       coord.cx === 0 && coord.cy === 0;
  const sideList = onSpawnChunk
    ? ["D", "Ruin"]
    : (branch === "D" && G && G.branchEntries
       ? (G.branchEntries[depth] || []) : []);
  for (const sb of sideList) {
    const room = midRooms.length ? midRooms.splice(
      ri(0, midRooms.length - 1), 1)[0] : null;
    if (room) {
      tiles[room.cy][room.cx] = T.BRANCH;
      entrances.push({ x: room.cx, y: room.cy, branch: sb });
    }
  }

  // --- 6. most levels hold an altar to a random god ---
  let altarGod = null;
  if ((DATA.gods || []).length && midRooms.length && chance(0.7)) {
    const room = midRooms[ri(0, midRooms.length - 1)];
    if (tiles[room.cy][room.cx] === T.FLOOR) {
      tiles[room.cy][room.cx] = T.ALTAR;
      altarGod = pick(DATA.gods).id;
    }
  }

  // --- 6b. a shop on some levels ---
  let shop = null;
  if (midRooms.length && chance(0.4)) {
    const room = midRooms[ri(0, midRooms.length - 1)];
    if (tiles[room.cy][room.cx] === T.FLOOR) {
      tiles[room.cy][room.cx] = T.SHOP;
      shop = rollShopStock(diff || depth);
    }
  }

  // --- 7. scatter ambient terrain: lakes, lava pools, tree groves ---
  scatterTerrain(tiles, branch, blockers, orbCell);

  // --- 7b. Surface buildings: homes, shops, manors, mansions, ruins,
  // castles. Each holds either a friendly NPC (questgiver / shopkeeper)
  // or, for ruined / haunted variants, hostile mobs + treasure.
  let buildings = [];
  let npcs = [];
  let buildingMons = [];
  let buildingItems = [];
  if (branch === "Surface") {
    const gen = generateSurfaceBuildings(tiles, coord, blockers);
    buildings = gen.buildings;
    npcs = gen.npcs;
    buildingMons = gen.buildingMons || [];
    buildingItems = gen.buildingItems || [];
    // each shop building rolls its own stock; the first one's stock
    // also becomes the chunk's lvl.shop so bump-talk and counter-step
    // both open the same store
    for (const b of buildings) {
      if (b.type === "shop") {
        b.shop = rollShopStock(2);
        if (!shop) shop = b.shop;
      }
    }
    // sprinkle a few wilderness points of interest -- wells, shrines,
    // a small graveyard. Skip cells inside a building footprint or
    // already occupied by a special tile.
    const inBld = (x, y) => buildings.some(b =>
      x >= b.x && x <= b.x + b.w - 1 && y >= b.y && y <= b.y + b.h - 1);
    const tryPlace = (kind, count) => {
      let guard = 0;
      let placed = 0;
      while (placed < count && guard++ < 60) {
        const x = ri(3, MAP_W - 4), y = ri(3, MAP_H - 4);
        if (tiles[y][x] !== T.FLOOR) continue;
        if (inBld(x, y)) continue;
        tiles[y][x] = kind;
        placed++;
      }
    };
    if (chance(0.55)) tryPlace(T.WELL, 1);
    if (chance(0.30)) tryPlace(T.SHRINE, 1);
    if (chance(0.40)) tryPlace(T.GRAVE, ri(2, 4));
    // a roving traveller's bedroll, a roadside idol, a crystal node,
    // and an occasional signpost when there's a village nearby
    if (chance(0.25)) tryPlace(T.CAMPSITE, 1);
    if (chance(0.18)) tryPlace(T.IDOL, 1);
    if (chance(0.20)) tryPlace(T.MANA_NODE, 1);
    if (chance(0.35)) tryPlace(T.SIGNPOST, 1);
    // rare wonders: beacon (reveals the map), wishing well (gamble)
    if (chance(0.08)) tryPlace(T.BEACON, 1);
    if (chance(0.05)) tryPlace(T.WISHING_WELL, 1);
    // soft scenery POIs -- common, gentle effects
    if (chance(0.55)) tryPlace(T.FLOWERS, ri(2, 4));
    if (chance(0.15)) tryPlace(T.LECTERN, 1);
    if (chance(0.22)) tryPlace(T.FRUIT_CACHE, 1);
    // a standing-stone henge: 5 stones in a ring with a shrine at the
    // centre. Strictly an open-ground feature, away from buildings.
    if (chance(0.06)) {
      const ringOffsets = [[0,-2],[2,-1],[2,1],[0,2],[-2,1],[-2,-1]];
      for (let tries = 0; tries < 40; tries++) {
        const cx2 = ri(4, MAP_W - 5), cy2 = ri(4, MAP_H - 5);
        // centre + ring cells must all be FLOOR + not in a building
        let ok = tiles[cy2][cx2] === T.FLOOR && !inBld(cx2, cy2);
        for (const [dx, dy] of ringOffsets) {
          if (!ok) break;
          const xx = cx2 + dx, yy = cy2 + dy;
          if (tiles[yy][xx] !== T.FLOOR || inBld(xx, yy)) ok = false;
        }
        if (!ok) continue;
        tiles[cy2][cx2] = T.SHRINE;
        for (const [dx, dy] of ringOffsets) {
          tiles[cy2 + dy][cx2 + dx] = T.STANDING_STONE;
        }
        break;
      }
    }
  }

  // --- 8. hidden traps ---
  const traps = placeTraps(tiles, orbCell);

  // precompute POI cell positions for the world map (so it can draw
  // markers without scanning every tile every render)
  const poiCells = [];
  if (branch === "Surface") {
    const POI_KINDS = new Set([T.WELL, T.SHRINE, T.GRAVE, T.CAMPSITE,
      T.IDOL, T.MANA_NODE, T.SIGNPOST, T.BEACON,
      T.WISHING_WELL, T.STANDING_STONE,
      T.FLOWERS, T.LECTERN, T.FRUIT_CACHE]);
    for (let yy = 0; yy < MAP_H; yy++) {
      for (let xx = 0; xx < MAP_W; xx++) {
        if (POI_KINDS.has(tiles[yy][xx])) {
          poiCells.push({ x: xx, y: yy, t: tiles[yy][xx] });
        }
      }
    }
  }

  // rooms used for spawning include the vaults; entry room stays first.
  return { tiles, rooms: rooms.concat(vaultRooms), branch, depth,
           diff: diff || depth, entrances, orbCell, traps, shop,
           vaultCount: vaultRooms.length, vaultMons, vaultItems, tileArt,
           isCave, altarGod, surfaceCoord: coord || null,
           buildings, npcs, buildingMons, buildingItems, poiCells };
}

function carveCorridor(tiles, x1, y1, x2, y2) {
  let x = x1, y = y1;
  const horizFirst = chance(0.5);
  function dig() {
    // a corridor clears rock and any impassable vault terrain
    // (lava, trees) it crosses, so connectivity always holds
    const t = tiles[y][x];
    if (t === T.WALL || t === T.LAVA || t === T.TREE) {
      tiles[y][x] = T.FLOOR;
    }
  }
  if (horizFirst) {
    while (x !== x2) { x += Math.sign(x2 - x); dig(); }
    while (y !== y2) { y += Math.sign(y2 - y); dig(); }
  } else {
    while (y !== y2) { y += Math.sign(y2 - y); dig(); }
    while (x !== x2) { x += Math.sign(x2 - x); dig(); }
  }
}

function passable(lvl, x, y) {
  if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) return false;
  const t = lvl.tiles[y][x];
  // walls, any closed door / gate, lava and trees block movement;
  // water is wadeable
  return t !== T.WALL && t !== T.DOOR && t !== T.DOOR_LOCKED &&
         t !== T.DOOR_STEEL && t !== T.GATE &&
         t !== T.LAVA && t !== T.TREE &&
         t !== T.STANDING_STONE &&
         t !== T.DEEP_WATER;
}

/* =============================================================
 * Field of view -- Bresenham LOS from the player to every cell
 * within FOV_RADIUS. Simple and exact for a level this size.
 * ============================================================= */

function losClear(lvl, x0, y0, x1, y1) {
  let dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  let sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy, x = x0, y = y0;
  while (true) {
    if (x === x1 && y === y1) return true;
    if (!(x === x0 && y === y0)) {
      const t = lvl.tiles[y][x];
      // walls, any closed door / gate, and trees block sight;
      // water and lava do not
      if (t === T.WALL || t === T.DOOR || t === T.DOOR_LOCKED ||
          t === T.DOOR_STEEL || t === T.GATE || t === T.TREE) {
        return false;
      }
    }
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
}

function computeFOV() {
  const lvl = G.level;
  const vis = G.visible;
  for (let y = 0; y < MAP_H; y++) vis[y].fill(false);
  const px = G.player.x, py = G.player.y;
  for (let y = Math.max(0, py - FOV_RADIUS); y <= Math.min(MAP_H - 1, py + FOV_RADIUS); y++) {
    for (let x = Math.max(0, px - FOV_RADIUS); x <= Math.min(MAP_W - 1, px + FOV_RADIUS); x++) {
      const dx = x - px, dy = y - py;
      if (dx * dx + dy * dy > FOV_RADIUS * FOV_RADIUS) continue;
      if (losClear(lvl, px, py, x, y)) {
        vis[y][x] = true;
        G.seen[y][x] = true;
      }
    }
  }
  // spot any traps that fall within sight
  for (const t of (lvl.traps || [])) {
    if (vis[t.y][t.x]) t.known = true;
  }
  // first-sighting lore -- the first time the player ever sees a
  // monster of a given def in the whole run, drop its flavor line
  // into the log. Skip neutrals (they're scenery, not threats) and
  // anything already announced.
  if (!G.seenMonsterIds) G.seenMonsterIds = {};
  for (const m of G.monsters) {
    if (!m.def || G.seenMonsterIds[m.def.id]) continue;
    if (m.neutral) continue;
    if (!vis[m.y] || !vis[m.y][m.x]) continue;
    G.seenMonsterIds[m.def.id] = true;
    if (m.def.lore) logMsg(m.def.lore, "dim");
  }
}

/* =============================================================
 * Entities
 * ============================================================= */

function makeMonster(def, x, y) {
  return {
    kind: "monster",
    def,
    name: def.name,
    glyph: def.glyph,
    colour: def.colour,
    x, y,
    hpMax: def.hp,
    hp: def.hp,
    ac: def.ac,
    ev: def.ev,
    speed: def.speed || 10,
    energy: 0,
    awake: false,
    // lawful guards / watchmen are neutral on spawn -- they only fight
    // back when struck, or when the player steals a chest they're
    // watching (see doPickup + playerAttack hooks)
    neutral: isGuardian(def),
  };
}

/* Spawn monsters whose depth tier is close to the current depth. */
function spawnMonsters(lvl) {
  // indoor levels (cellars / upper floors) get their hostile mobs from
  // generateIndoorLevel.buildingMons -- skip the generic spawner so the
  // small space stays tight and predictable
  if (lvl.branch === "Indoors") return [];
  const monsters = [];
  // caves are wide open -- fewer monsters there, since every one can
  // converge on the player at once (and ranged ones get clear shots)
  let want = 3 + lvl.diff + ri(0, 2);
  if (lvl.isCave) want = Math.round(want * 0.55);
  // the Surface is enormous and meant to be wandered between fights,
  // not a packed dungeon floor -- one or two hostiles per chunk
  if (lvl.branch === "Surface") want = ri(1, 2);
  const lo = Math.max(1, lvl.diff - 1);
  const hi = lvl.diff;
  // the Surface narrows the pool to wandering animals + brigands; the
  // dungeon keeps its historical wide pool (every kind of weird thing).
  // Cellars / Indoors are handled separately.
  // bosses never roll from the generic spawner -- they only appear in
  // their dedicated boss rooms (castle treasuries, deep cellars)
  const inTier = (m) => !m.boss && m.tier >= lo && m.tier <= hi;
  const inWideTier = (m) => !m.boss && m.tier <= hi + 1;
  let pool;
  if (lvl.branch === "Surface") {
    const surfaceBiome = (m) =>
      m.biome === "surface_animal" || m.biome === "surface_humanoid";
    pool = DATA.monsters.filter(m => surfaceBiome(m) && inTier(m));
    if (!pool.length) pool = DATA.monsters.filter(m =>
      surfaceBiome(m) && inWideTier(m));
  } else {
    pool = DATA.monsters.filter(inTier);
  }
  const fallback = DATA.monsters.filter(inWideTier);
  const usePool = pool.length ? pool : fallback;
  let guard = 0;
  while (monsters.length < want && guard++ < 400) {
    const room = pick(lvl.rooms.slice(1)); // not the entry room
    if (!room) break;
    const x = ri(room.x, room.x + room.w - 1);
    const y = ri(room.y, room.y + room.h - 1);
    if (lvl.tiles[y][x] !== T.FLOOR) continue;
    if (monsters.some(m => m.x === x && m.y === y)) continue;
    monsters.push(makeMonster(pick(usePool), x, y));
  }
  return monsters;
}

/* =============================================================
 * Items
 * ============================================================= */

const ITEM_KINDS = [
  { key: "heal", name: "potion of healing", glyph: "!", colour: "LIGHTRED" },
  { key: "might", name: "potion of might", glyph: "!", colour: "RED" },
  { key: "gold", name: "gold", glyph: "$", colour: "YELLOW" },
  { key: "haste", name: "potion of haste", glyph: "!", colour: "LIGHTBLUE" },
];

/* potion flavours -- key/sub -> floor item shape */
const POTION_FLAVOR = {
  heal:    { name: "potion of healing",       colour: "LIGHTRED" },
  might:   { name: "potion of might",         colour: "RED" },
  haste:   { name: "potion of haste",         colour: "LIGHTBLUE" },
  berserk: { name: "potion of berserk rage",  colour: "RED" },
  magic:   { name: "potion of magic",         colour: "BLUE" },
  cancel:  { name: "potion of cancellation",  colour: "WHITE" },
};
function makePotionItem(sub, x, y) {
  const f = POTION_FLAVOR[sub] || POTION_FLAVOR.heal;
  return { key: sub, name: f.name, glyph: "!", colour: f.colour, x, y };
}

/* scroll flavours */
const SCROLL_FLAVOR = {
  teleport: { name: "scroll of teleportation" },
  fear:     { name: "scroll of fear" },
  mapping:  { name: "scroll of magic mapping" },
  noise:    { name: "scroll of noise" },
};
function makeScrollItemOf(sub, x, y) {
  const f = SCROLL_FLAVOR[sub] || SCROLL_FLAVOR.teleport;
  return { key: "scroll", scroll: sub, name: f.name, glyph: "?",
           colour: "WHITE", x, y };
}

/* gems -- pure treasure. Pick one up, take it to a shop, sell it for
 * gold. They drop on later levels alongside gold piles. */
const GEM_KINDS = [
  { sub: "topaz",    name: "topaz",    value:  70 },
  { sub: "emerald",  name: "emerald",  value:  90 },
  { sub: "opal",     name: "opal",     value: 100 },
  { sub: "sapphire", name: "sapphire", value: 110 },
  { sub: "ruby",     name: "ruby",     value: 130 },
  { sub: "diamond",  name: "diamond",  value: 180 },
];

/* a food item: rations are filling, fruit / cheese / sausage less so.
 * Drops from fruit caches, occasional monster loot, sometimes chests. */
const FOOD_KINDS = [
  { sub: "ration", name: "meat ration" },
  { sub: "bread",  name: "bread ration" },
  { sub: "meat",   name: "strip of jerky" },
  { sub: "fruit",  name: "ripe apple" },
  { sub: "cheese", name: "wedge of cheese" },
  { sub: "sausage",name: "sausage" },
];
/* a key item -- one use, opens any locked wooden door without the
 * risk of a failed bash. Stacks in the pack like other consumables. */
function makeKeyItem(x, y) {
  return { key: "key", name: "iron key", glyph: "*", colour: "YELLOW",
           x, y };
}

function makeFoodItem(x, y, kind) {
  const k = kind || pick(FOOD_KINDS);
  return { key: "food", sub: k.sub, name: k.name, glyph: "%",
           colour: "BROWN", x, y };
}

function makeGemItem(depth, x, y) {
  const g = pick(GEM_KINDS);
  return { key: "gem", sub: g.sub, name: g.name, value: g.value,
           glyph: "*", colour: "LIGHTGREEN", x, y };
}

/* a treasure chest: a single floor item whose `loot` field carries
 * 2-5 nested items. Stepping onto it and pressing g (doPickup) opens
 * the chest, drops every loot entry into the player's inventory, and
 * removes the chest. Tier scales gold + item quality. */
function makeChestItem(tier, x, y) {
  const loot = [];
  // every chest has a base gold pile
  loot.push({ key: "gold", amount: ri(20, 50 + tier * 30) });
  // a key shows up in ~25% of chests -- the standard reward for cracking
  if (chance(0.25)) loot.push(makeKeyItem(x, y));
  // 1-3 extra items: potions, scrolls, gems, occasional weapon
  const extras = ri(1, 3);
  for (let i = 0; i < extras; i++) {
    const r = Math.random();
    if (r < 0.35) {
      loot.push(makePotionItem(pick(["heal", "might", "haste", "magic"]),
                               x, y));
    } else if (r < 0.55) {
      loot.push(makeScrollItem(x, y));
    } else if (r < 0.75) {
      loot.push(makeGemItem(tier, x, y));
    } else if (r < 0.92 && WEAPONS.length) {
      const w = brandWeapon(WEAPONS[ri(0, Math.min(WEAPONS.length - 1,
                                                    1 + tier))]);
      loot.push({ key: "weapon", name: weaponLabel(w), glyph: "(",
                  colour: "LIGHTCYAN", weapon: w, x, y });
    } else {
      loot.push({ key: "gold", amount: ri(30, 60 + tier * 25) });
    }
  }
  return { key: "chest", name: "treasure chest", glyph: "=",
           colour: "YELLOW", loot, x, y };
}
/* The weapon pool. Populated from the export's weapon_defs (every
 * melee weapon, with real damage / accuracy) once game data loads;
 * this hardcoded set is only the fallback if the export is missing.
 * A weapon rolls roll(dice, sides) base damage; sides == export
 * damage, str is a flat bonus scaled to the weapon's weight. */
let WEAPONS = [
  { name: "dagger",        dice: 1, sides: 4,  acc: 6, str: 1 },
  { name: "short sword",   dice: 1, sides: 5,  acc: 4, str: 1 },
  { name: "mace",          dice: 1, sides: 9,  acc: 3, str: 2 },
  { name: "long sword",    dice: 1, sides: 10, acc: 2, str: 3 },
  { name: "war axe",       dice: 1, sides: 13, acc: 0, str: 3 },
  { name: "great sword",   dice: 1, sides: 16, acc: -2, str: 4 },
];

/* turn the exported weapon_defs rows into the game's weapon objects */
function buildWeaponPool() {
  if (!DATA.weapons || !DATA.weapons.length) return;
  WEAPONS = DATA.weapons.map(w => ({
    name: w.name,
    dice: 1,
    sides: Math.max(2, w.damage),
    acc: w.acc,
    str: Math.round(w.damage / 3),
    speed: w.speed,
    skill: w.skill,
  }));
}

/* a fresh copy of the adventurer's starting weapon */
function startingWeapon() {
  const w = WEAPONS.find(x => x.name === "short sword");
  return w ? Object.assign({}, w)
           : { name: "short sword", dice: 1, sides: 5, acc: 4, str: 1 };
}

/* ---------- item brands (egos) ----------
 * a generated weapon or armour may carry an ego: a flaming blade, a
 * cloak of protection. Egos add damage or defence and rename the item.
 */
const WEAPON_EGOS = {
  flaming:  { adj: "flaming",  bonus: 5 },
  freezing: { adj: "freezing", bonus: 5 },
  heavy:    { adj: "heavy",    bonus: 7 },
  draining: { adj: "draining", bonus: 4 },
  venom:    { adj: "venomous", bonus: 2, poison: true },
};
const ARMOUR_EGOS = {
  protection: { adj: "of protection", ac: 2 },
  evasion:    { adj: "of evasion",    ev: 3 },
};

/* a fresh weapon instance, ~28% of the time carrying an ego */
function brandWeapon(w) {
  const inst = Object.assign({}, w);
  if (chance(0.28)) inst.ego = pick(Object.keys(WEAPON_EGOS));
  return inst;
}
/* a weapon's display name, with any ego adjective */
function weaponLabel(w) {
  if (!w) return "";
  return w.ego ? WEAPON_EGOS[w.ego].adj + " " + w.name : w.name;
}
/* an armour's display name, with any ego suffix */
function armourLabel(a) {
  if (!a) return "";
  return a.ego ? a.name + " " + ARMOUR_EGOS[a.ego].adj : a.name;
}

/* ---------- innate species traits ----------
 * a handful of iconic abilities so the species you pick changes how
 * you play, the way it does in real DCSS.
 */
const SPECIES_TRAITS = {
  "Troll":       { id: "regen",
                   desc: "Trollish vigour — regenerates very quickly" },
  "Minotaur":    { id: "retaliate",
                   desc: "Horns — headbutts back when struck in melee" },
  "Gargoyle":    { id: "rock",
                   desc: "Stone body — heavy innate armour" },
  "Deep Dwarf":  { id: "shave",
                   desc: "Dwarven toughness — shrugs off some damage" },
  "Felid":       { id: "ninelives",
                   desc: "Nine lives — rises once from death" },
  "Vampire":     { id: "bloodthirst",
                   desc: "Bloodthirst — drains life from melee kills" },
  "Poltergeist": { id: "incorporeal",
                   desc: "Ghostly form — drifts past traps and poison" },
  "Mummy":       { id: "embalmed",
                   desc: "Embalmed — immune to poison and slow" },
  "Ghoul":       { id: "clawed",
                   desc: "Natural claws — extra melee damage" },
  "Spriggan":    { id: "fleet",
                   desc: "Fleet of foot — moves 20% faster" },
  "Centaur":     { id: "fleet",
                   desc: "Equine legs — moves 20% faster" },
  "Formicid":    { id: "anchored",
                   desc: "Anchored stance — immune to teleportation" },
  "Tengu":       { id: "flight",
                   desc: "Flight — may glide over lava" },
  "Naga":        { id: "poisonblood",
                   desc: "Serpentine blood — immune to poison" },
};

/* the trait object for a species (any draconian gets scales) */
function speciesTrait(sp) {
  const nm = (sp && sp.name) || "";
  if (/draconian/i.test(nm)) {
    return { id: "scales",
             desc: "Draconian scales — armour that hardens with level" };
  }
  return SPECIES_TRAITS[nm] || null;
}

/* does player p carry trait `id`? */
function traitIs(p, id) {
  return !!(p && p.trait && p.trait.id === id);
}

/* ---- Time of day ----
 *
 * A 300-turn loop split into four phases (dawn, day, dusk, night).
 * Only the Surface and Castle branches see it -- the underworld is
 * windowless. Drives a screen-tint overlay, the stealth night bonus,
 * and NPC "sleeping" state at night.
 */
// a full day-night cycle is 2400 turns. At a slow walk that's ~40
// chunk crossings -- a real adventure, not a flicker. Dawn is brief,
// day dominates, dusk is brief, night gets a long quiet stretch so
// stealth gameplay has time to breathe.
const DAY_LENGTH = 2400;
const PHASES = ["dawn", "day", "dusk", "night"];
function timeOfDay() {
  const t = ((G && G.turn) || 0) % DAY_LENGTH;
  if (t <  300) return { phase: "dawn",  t };       //  300t dawn
  if (t < 1500) return { phase: "day",   t };       // 1200t day (bulk)
  if (t < 1800) return { phase: "dusk",  t };       //  300t dusk
  return               { phase: "night", t };       //  600t night
}
function isOutdoors(branch) {
  return branch === "Surface" || branch === "Castle";
}
function timeLabel() {
  return timeOfDay().phase;
}

/* ---- Moon phase ----
 *
 * An 8-day lunar cycle (one phase per in-game day). New moon = 0,
 * full moon = 4, then waning back to 0. Drawn as an emoji disc at
 * the top of the map, and ties into stealth: bright moonlight at
 * night makes sneaking harder, a new moon makes it easier.
 */
const MOON_GLYPHS  = ["🌑", "🌒", "🌓", "🌔", "🌕", "🌖", "🌗", "🌘"];
const MOON_NAMES   = ["new", "waxing crescent", "first quarter",
                      "waxing gibbous", "full", "waning gibbous",
                      "last quarter", "waning crescent"];
function moonPhase() {
  const day = Math.floor(((G && G.turn) || 0) / DAY_LENGTH);
  return ((day % 8) + 8) % 8;
}
function moonPhaseName(i) { return MOON_NAMES[(i | 0) % 8] || "new"; }

/* ---- Blacksmith ----
 *
 * Bumping a blacksmith NPC offers to forge an edge onto the player's
 * equipped weapon. Costs wood + stone (heat + heft). Each smith visit
 * stacks a small permanent str-bonus on the weapon, capped to keep
 * runaway scaling out of the picture.
 */
const SMITH_WOOD_COST = 4;
const SMITH_STONE_COST = 6;
const SMITH_MAX_UPGRADES = 5;
function blacksmithService(npc) {
  const p = G.player;
  if (!p.weapon) {
    logMsg(npc.name + ": \"Bring me a blade first.\"", "dim");
    return;
  }
  const home = ensurePlayerHome();
  home.materials = home.materials || { wood: 0, stone: 0 };
  const haveWood = home.materials.wood | 0;
  const haveStone = home.materials.stone | 0;
  const upgrades = (p.weapon.smithLevel | 0);
  if (upgrades >= SMITH_MAX_UPGRADES) {
    logMsg(npc.name + ": \"That edge'll cut iron now. Nothing more I can do.\"",
           "dim");
    return;
  }
  if (haveWood < SMITH_WOOD_COST || haveStone < SMITH_STONE_COST) {
    logMsg(npc.name + ': "I\'ll re-edge that blade for ' +
           SMITH_WOOD_COST + ' wood and ' + SMITH_STONE_COST +
           ' stone. You\'ve got ' + haveWood + 'w / ' + haveStone +
           's. Come back when you can pay."', "warn");
    return;
  }
  // pay + upgrade. Bump the weapon's str so damage rises but not by
  // a wild amount -- +1 per upgrade.
  home.materials.wood -= SMITH_WOOD_COST;
  home.materials.stone -= SMITH_STONE_COST;
  savePlayerHome(home);
  p.weapon.smithLevel = upgrades + 1;
  p.weapon.str = (p.weapon.str | 0) + 1;
  if (!/forged/i.test(p.weapon.name)) {
    p.weapon.name = p.weapon.name + " (forged)";
  } else {
    // already labelled forged -- bump the suffix to (forged x N)
    p.weapon.name = p.weapon.name.replace(/\s*\(forged.*\)$/, "") +
                    " (forged x" + p.weapon.smithLevel + ")";
  }
  logMsg(npc.name + ": \"That'll bite better.\" Your " + p.weapon.name +
         " gleams hot from the forge.", "good");
  sfx("hit");
  flashDamage();
}

/* ---- Night raids ----
 *
 * On the player's home Surface chunk at night, low-tier hostiles
 * occasionally drift in from a chunk edge. They wake hostile and
 * pathfind to the player -- which means your built walls and doors
 * actually earn their keep, since the existing monster AI already
 * respects passability and opens (or stalls at) closed doors.
 *
 * Roll every 200 turns at night, ~40% chance. One mob per attempt.
 */
function maybeNightRaid() {
  if (!G || !isOutdoors(G.branch)) return;
  if (G.over || G.camping) return;
  if (timeOfDay().phase !== "night") return;
  if ((G.turn % 200) !== 0) return;
  const home = loadPlayerHome();
  if (!home || !home.hearth) return;
  const sc = G.surfaceCoord;
  if (!sc || sc.cx !== home.hearth.cx || sc.cy !== home.hearth.cy) return;
  if (!chance(0.4)) return;
  // tier-1 surface mob -- enough to be a real threat, not a slog
  const pool = (DATA && DATA.monsters || []).filter(m =>
    m.tier === 1 &&
    (m.biome === "surface_humanoid" || m.biome === "surface_animal"));
  if (!pool.length) return;
  const def = pick(pool);
  // find a passable spawn cell on the chunk's perimeter, away from
  // the player and the hearth so the raid HAS to approach
  const candidates = [];
  const addIf = (x, y) => {
    if (!G.level.tiles[y]) return;
    if (!passable(G.level, x, y)) return;
    if (Math.abs(x - G.player.x) + Math.abs(y - G.player.y) < 12) return;
    candidates.push({ x, y });
  };
  for (let x = 0; x < MAP_W; x++) {
    addIf(x, 0); addIf(x, MAP_H - 1);
  }
  for (let y = 0; y < MAP_H; y++) {
    addIf(0, y); addIf(MAP_W - 1, y);
  }
  if (!candidates.length) return;
  const spot = pick(candidates);
  const mon = makeMonster(def, spot.x, spot.y);
  mon.awake = true;       // they know you're here -- this is a raid
  G.monsters.push(mon);
  logMsg("A " + def.name + " drifts in from the dark, hunting...", "warn");
  sfx("hurt");
}
/* nighttime visibility cost from moonlight. Only matters outdoors at
 * night; the full moon (+lit) makes you visible, a new moon (dark)
 * gives you the best cover. */
function moonStealthMod() {
  if (!G || !isOutdoors(G.branch)) return 0;
  if (timeOfDay().phase !== "night") return 0;
  const p = moonPhase();
  if (p === 4) return -2;             // full -- bright as day
  if (p === 3 || p === 5) return -1;  // gibbous
  if (p === 0) return  2;             // new -- pitch dark
  if (p === 1 || p === 7) return  1;  // crescent
  return 0;                            // quarters
}

/* ---- Real-time mode ----
 *
 * Optional flip from the default turn-based loop. When on, a tick
 * fires every REALTIME_TICK_MS and calls endTurn() so the world
 * advances even when the player stands still -- monsters close in,
 * food drains, day passes. The player still moves per-keypress and
 * each keypress still ends a turn; this layer just makes "doing
 * nothing" cost time. Paused while any overlay / prompt is open so
 * you don't get killed mid-inventory.
 */
const REALTIME_TICK_MS = 600;
let realtimeIntervalId = null;
function isAnyOverlayOpen() {
  return !!(helpOpen || invOpen || shopOpen || mapOpen || questListOpen ||
            npcOpen || (G && G.buildMode) ||
            awaitingQuaff || awaitingRead || awaitingCast);
}
function realtimeTick() {
  if (!G || G.over) return;
  if (isAnyOverlayOpen()) return;
  // a real-time tick is one world turn -- monsters act, statuses
  // decrement, day/night advances, food drains, etc.
  endTurn();
  render();
}
function setRealtime(on) {
  if (!G) return;
  G.realtime = !!on;
  if (realtimeIntervalId) {
    clearInterval(realtimeIntervalId);
    realtimeIntervalId = null;
  }
  if (G.realtime) {
    realtimeIntervalId = setInterval(realtimeTick, REALTIME_TICK_MS);
  }
  // visually mark the canvas so the player knows the timer is live
  if (typeof document !== "undefined") {
    const cv = document.getElementById("map-canvas");
    if (cv) {
      if (G.realtime) cv.classList.add("realtime-on");
      else cv.classList.remove("realtime-on");
    }
  }
  // persist preference
  if (typeof localStorage !== "undefined") {
    try { localStorage.setItem("crawlweb.realtime", G.realtime ? "1" : "0"); }
    catch (e) { /* ignore */ }
  }
}
function toggleRealtime() {
  setRealtime(!(G && G.realtime));
  logMsg("Real-time mode " + (G.realtime ? "ON -- the world moves on its own."
                                          : "OFF -- turn-based."),
         G.realtime ? "warn" : "sys");
  render();
}

/* ---- Stealth ----
 *
 * Stealth is a per-turn opposed check between the player and every
 * monster within sight: success means sleeping mobs don't wake, awake
 * mobs lose track and revert to wandering. Adjacent mobs that act
 * also roll. If any monster wins its roll, stealth breaks and you
 * "reappear" (everything in sight is now actively aware of you).
 *
 * stealthScore(p) = 4 + dex/3 + species bonus + job bonus + buffs.
 * Mostly matches DCSS canon (Spriggans sneak, Centaurs clop).
 */
const STEALTH_SPECIES_BONUS = {
  SP_SPRIGGAN: 5, SP_HALFLING: 3, SP_FELID: 3, SP_OCTOPODE: 3,
  SP_KOBOLD: 2, SP_VAMPIRE: 2, SP_DEEP_ELF: 1, SP_DEMONSPAWN: 1,
  SP_HIGH_ELF: 1, SP_SLUDGE_ELF: 1, SP_TENGU: 1, SP_REVENANT: 2,
  SP_POLTERGEIST: 3, SP_VINE_STALKER: 2,
  SP_NAGA: -2, SP_CENTAUR: -2, SP_GALE_CENTAUR: -2,
  SP_TROLL: -2, SP_MINOTAUR: -1, SP_GARGOYLE: -1, SP_ARMATAUR: -1,
  SP_MAYFLYTAUR: -1, SP_FORMICID: -1, SP_ONI: -1,
};
const STEALTH_JOB_BONUS = {
  JOB_STALKER: 4, JOB_BRIGAND: 4, JOB_HEXSLINGER: 3,
  JOB_HUNTER: 2, JOB_ENCHANTER: 2, JOB_ALCHEMIST: 1,
  JOB_ARTIFICER: 1, JOB_WANDERER: 1, JOB_WARPER: 1,
  JOB_FIGHTER: -1, JOB_GLADIATOR: -1, JOB_BERSERKER: -2,
  JOB_MONK: -1, JOB_PRIEST: -1, JOB_DEATH_KNIGHT: -1,
  JOB_REAVER: -1, JOB_CHAOS_KNIGHT: -1,
};
function stealthScore(p) {
  if (!p) return 0;
  const dexBonus = Math.floor((p.dex | 0) / 3);
  const spId = (p.species && p.species.id) || "";
  const jbId = (p.job && p.job.id) || "";
  const spB = STEALTH_SPECIES_BONUS[spId] || 0;
  const jbB = STEALTH_JOB_BONUS[jbId] || 0;
  // hauling a corpse is heavy and bloody -- noisier by 3
  const bodyPenalty = p.carriedBody ? -3 : 0;
  // night cover: outdoors at night, you get a +3 to stealth.
  // Indoors/dungeon is windowless, no time-of-day bonus.
  let timeBonus = 0;
  if (G && isOutdoors(G.branch)) {
    const ph = timeOfDay().phase;
    if (ph === "night") timeBonus = 3;
    else if (ph === "dusk" || ph === "dawn") timeBonus = 1;
  }
  // moonlight modifier at night -- full moon hurts, new moon helps
  const moonMod = moonStealthMod();
  return 4 + dexBonus + spB + jbB + bodyPenalty + timeBonus + moonMod;
}

/* drop the corpse currently slung over the player's shoulder onto
 * the cell underfoot (or a passable neighbour). Bound to D. */
function dropCarriedBody() {
  const p = G.player;
  if (!p.carriedBody) {
    logMsg("You're not carrying anything to drop.", "dim");
    return false;
  }
  // can't drop on top of an existing item -- shove it to a neighbour
  let dx = p.x, dy = p.y;
  if ((G.items || []).some(i => i.x === dx && i.y === dy)) {
    const DIRS = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
    let placed = false;
    for (const d of DIRS) {
      const nx = p.x + d[0], ny = p.y + d[1];
      if (passable(G.level, nx, ny) &&
          !G.items.some(i => i.x === nx && i.y === ny)) {
        dx = nx; dy = ny; placed = true; break;
      }
    }
    if (!placed) {
      logMsg("Nowhere to set the body down.", "dim");
      return false;
    }
  }
  const body = p.carriedBody;
  G.items.push({
    key: "corpse",
    name: body.name,
    corpseName: body.fromKill ? body.name.replace(/'s body$/, "") : body.name,
    tile: body.tile, fromKill: body.fromKill || null,
    x: dx, y: dy,
    glyph: "%", colour: "ETC_BLOOD",
  });
  p.carriedBody = null;
  logMsg("You set the body down.", "sys");
  sfx("body");
  return true;
}

/* odds (0..1) that a given monster spots a stealthed player this
 * turn. Closer + higher-HD = riskier; bigger stealthScore = safer.
 * Distance 1 is dangerous but not certain (a stealthed roll-by). */
function stealthFailChance(p, mon, dist) {
  const hd = (mon && mon.def && mon.def.hd) || 1;
  const ss = stealthScore(p);
  const proximity = Math.max(0, 6 - dist);   // 0..5 closer
  let chance = (hd - ss + 2 + proximity) / 25;
  if (chance < 0.02) chance = 0.02;
  if (chance > 0.6) chance = 0.6;
  return chance;
}

/* enter / exit stealth. Bound to `H`. */
function tryStealth() {
  const p = G.player;
  if (p.stealthed) {
    p.stealthed = false;
    logMsg("You stop sneaking.", "dim");
    endTurn();
    return true;
  }
  if ((p.stealthCD | 0) > 0) {
    logMsg("You're still too rattled to slip away (" +
           p.stealthCD + ").", "dim");
    return false;
  }
  if (p.berserkTurns > 0) {
    logMsg("You can't sneak while berserk.", "dim");
    return false;
  }
  p.stealthed = true;
  logMsg("You melt into the shadows. (stealth " +
         stealthScore(p) + ")", "good");
  // monsters that can't currently see you forget about you immediately
  for (const m of G.monsters) {
    if (m.awake && (!G.visible[m.y] || !G.visible[m.y][m.x])) {
      m.awake = false;
    }
  }
  sfx("sneak");
  endTurn();
  return true;
}

/* break stealth from any source (spotted, attacked, loud action).
 * `reason` is shown in the log. */
function breakStealth(reason) {
  const p = G.player;
  if (!p.stealthed) return;
  p.stealthed = false;
  p.stealthCD = 4;       // brief lockout so you can't immediately re-stealth
  if (reason) logMsg(reason, "bad");
  flashDamage();
}

/* ---------- status effects (poison / slow / haste) ---------- */

const VENOMOUS_NAME =
  /(spider|scorpion|wasp|snake|viper|adder|serpent|anaconda|bee|naga|venomous|poison)/i;

function isVenomousMonster(mon) {
  return !!mon && VENOMOUS_NAME.test(mon.name || "");
}

/* afflict the player with poison for at least `turns` turns */
function applyPoison(p, turns) {
  if (poisonImmune(p)) {
    if (turns > 0) logMsg("The venom slides off you harmlessly.", "good");
    return;
  }
  const before = p.poisonTurns || 0;
  if (turns > before) {
    p.poisonTurns = turns;
    logMsg(before > 0 ? "You feel more poisoned."
                      : "You are poisoned!", "bad");
  }
}

/* trait-aggregate helpers -- multiple species share an immunity */
function poisonImmune(p) {
  return traitIs(p, "embalmed") || traitIs(p, "incorporeal") ||
         traitIs(p, "poisonblood");
}
function teleportImmune(p) {
  return traitIs(p, "anchored") || traitIs(p, "incorporeal");
}
function paralyseImmune(p) {
  return traitIs(p, "anchored");          // Formicid anchored stance
}
function drainImmune(p) {
  return traitIs(p, "embalmed") || traitIs(p, "incorporeal");
}

/* apply slow / paralysis / confusion / drain to the player */
function applySlow(p, turns) {
  if (traitIs(p, "embalmed")) {
    logMsg("The cold finds no living muscle to grip.", "good");
    return;
  }
  if (turns > (p.slowTurns || 0)) {
    p.slowTurns = turns;
    logMsg("You feel sluggish!", "warn");
  }
}
function applyParalysis(p, turns) {
  if (paralyseImmune(p)) {
    logMsg("Your anchored stance resists the paralysis.", "good");
    return;
  }
  if (turns > (p.paralyzedTurns || 0)) {
    p.paralyzedTurns = turns;
    logMsg("You are paralysed!", "bad");
  }
}
function applyConfusion(p, turns) {
  if (traitIs(p, "incorporeal")) {
    logMsg("Your insubstantial mind brushes off the confusion.", "good");
    return;
  }
  if (turns > (p.confusedTurns || 0)) {
    p.confusedTurns = turns;
    logMsg("You feel confused!", "warn");
  }
}
function applyDrain(p) {
  if (drainImmune(p)) {
    logMsg("Your undead soul shrugs off the draining touch.", "good");
    return;
  }
  if ((p.xl || 1) > 1) {
    p.xl--;
    p.xpNext = Math.max(p.xp + 1, 12 + (p.xl - 1) * 8);
    logMsg("You feel your life force drain away!", "bad");
  } else {
    logMsg("You feel a chill, but it passes.", "dim");
  }
}

/* monster-name classifiers -- what kind of nasty melee touch this is */
const COLD_MON_NAME =
  /(frost|ice|cold|white drac|polar|snow|simulacrum|freeze)/i;
const DRAIN_MON_NAME =
  /(wraith|shadow|spectre|spectral|ghost|barrow|wight|eidolon|phantom)/i;
const PARALYSE_MON_NAME =
  /(medusa|royal mummy|mummy priest|greater mummy)/i;
const CONFUSE_MON_NAME =
  /(gibbering|moth of wrath|harpy)/i;
function isColdMon(m)     { return !!m && COLD_MON_NAME.test(m.name || ""); }
function isDrainMon(m)    { return !!m && DRAIN_MON_NAME.test(m.name || ""); }
function isParalyseMon(m) { return !!m && PARALYSE_MON_NAME.test(m.name || ""); }
function isConfuseMon(m)  { return !!m && CONFUSE_MON_NAME.test(m.name || ""); }

/* ---------- spells ----------
 * The web-game implements three spells; their metadata (title, level,
 * MP cost, schools) comes from game-data.json (the export's
 * spell_defs). SPELL_EFFECTS holds the game-side mechanics. */
const SPELL_EFFECTS = {
  // pure damage bolts -- damage scales with int + xl
  SPELL_MAGIC_DART:    { kind: "bolt" },
  SPELL_THROW_FLAME:   { kind: "bolt" },
  SPELL_STING:         { kind: "bolt" },
  SPELL_FREEZE:        { kind: "bolt_cold" },         // chance to slow
  SPELL_LIGHTNING_BOLT:{ kind: "bolt_big" },
  SPELL_BOLT_OF_FIRE:  { kind: "bolt_big" },
  SPELL_IRON_SHOT:     { kind: "bolt_big" },
  SPELL_FIREBALL:      { kind: "area" },              // small AoE
  SPELL_MEPHITIC_CLOUD:{ kind: "hex_confuse" },       // confuses target
  SPELL_SLOW:          { kind: "hex_slow" },
  SPELL_CONFUSE:       { kind: "hex_confuse" },
  SPELL_SWIFTNESS:     { kind: "self_haste" },        // self-buff
  SPELL_BLINK:         { kind: "blink" },
};

/* which spells each caster background starts knowing */
const CASTER_SPELLS = {
  "Conjurer":           ["SPELL_MAGIC_DART", "SPELL_THROW_FLAME"],
  "Hedge Wizard":       ["SPELL_MAGIC_DART", "SPELL_BLINK"],
  "Fire Elementalist":  ["SPELL_THROW_FLAME", "SPELL_BOLT_OF_FIRE"],
  "Cinder Acolyte":     ["SPELL_THROW_FLAME", "SPELL_FIREBALL"],
  "Air Elementalist":   ["SPELL_MAGIC_DART", "SPELL_LIGHTNING_BOLT",
                         "SPELL_SWIFTNESS"],
  "Ice Elementalist":   ["SPELL_FREEZE", "SPELL_BLINK"],
  "Earth Elementalist": ["SPELL_MAGIC_DART", "SPELL_IRON_SHOT"],
  "Necromancer":        ["SPELL_MAGIC_DART", "SPELL_SLOW"],
  "Alchemist":          ["SPELL_STING", "SPELL_MEPHITIC_CLOUD"],
  "Enchanter":          ["SPELL_SLOW", "SPELL_CONFUSE", "SPELL_BLINK"],
  "Summoner":           ["SPELL_MAGIC_DART"],
  "Warper":             ["SPELL_BLINK", "SPELL_MAGIC_DART"],
  "Hexslinger":         ["SPELL_MAGIC_DART", "SPELL_SLOW"],
  "Reaver":             ["SPELL_THROW_FLAME"],
  "Skald":              ["SPELL_MAGIC_DART", "SPELL_SWIFTNESS"],
  "Death Knight":       ["SPELL_MAGIC_DART", "SPELL_SLOW"],
};

function spellById(id) {
  return (DATA.spells || []).find(s => s.id === id) || null;
}

/* ---------- wands ----------
 * wand names come from game-data.json (the export's wand_type_defs);
 * WAND_EFFECTS holds the game-side mechanics. */
const WAND_EFFECTS = {
  flame:     { kind: "damage", dice: 2, base: 5 },
  iceblast:  { kind: "damage", dice: 3, base: 6 },
  acid:      { kind: "damage", dice: 2, base: 7 },
  paralysis: { kind: "paralyse" },
};

/* ---------- gods ----------
 * god ids / names come from game-data.json (the export's god_defs).
 * GOD_EFFECTS holds the game-side passive + invokable ability. Each
 * god grants one passive (a tag the rest of the code checks) and one
 * ability paid for with piety. */
const GOD_EFFECTS = {
  GOD_TROG: {
    passive: "Trog lends raw fury to your blows.",
    ability: { name: "Berserk", piety: 30,
               desc: "your blows hit far harder for a while" },
  },
  GOD_OKAWARU: {
    passive: "Okawaru steadies your aim.",
    ability: { name: "Heroism", piety: 25,
               desc: "a surge of heroism: +AC, +EV and accuracy" },
  },
  GOD_MAKHLEB: {
    passive: "Makhleb feeds you life from your kills.",
    ability: { name: "Minor Destruction", piety: 16,
               desc: "hurl destruction at the nearest foe" },
  },
  GOD_ELYVILON: {
    passive: "Elyvilon quickens your natural healing.",
    ability: { name: "Lesser Healing", piety: 20,
               desc: "channel divine healing" },
  },
  GOD_SHINING_ONE: {
    passive: "The Shining One shields the faithful (+AC).",
    ability: { name: "Cleansing Flame", piety: 35,
               desc: "scour every foe in sight with holy fire" },
  },
  GOD_VEHUMET: {
    passive: "Vehumet eases the cost of your magic.",
    ability: { name: "Magic Bolt", piety: 16,
               desc: "loose a bolt of raw magic at the nearest foe" },
  },
  GOD_KIKUBAAQUDGHA: {
    passive: "Kikubaaqudgha sustains you on the souls of your kills.",
    ability: { name: "Pain", piety: 18,
               desc: "wrack the nearest foe with necromantic agony" },
  },
  GOD_SIF_MUNA: {
    passive: "Sif Muna deepens the flow of your magic.",
    ability: { name: "Channel Magic", piety: 25,
               desc: "restore a burst of magical reserve" },
  },
  GOD_ASHENZARI: {
    passive: "Ashenzari's bound sight reveals every hidden trap.",
    ability: { name: "Scry", piety: 20,
               desc: "look across the whole floor for a moment" },
  },
};

function godName(id) {
  const g = (DATA.gods || []).find(x => x.id === id);
  return g ? g.name : id;
}

/* the nearest monster in the player's field of view, or null --
 * shared by spells, wands and thrown weapons (no targeting UI). */
function nearestVisibleMonster() {
  const p = G.player;
  let best = null, bd = 1e9;
  for (const m of G.monsters) {
    if (!G.visible[m.y][m.x]) continue;
    const d = Math.max(Math.abs(m.x - p.x), Math.abs(m.y - p.y));
    if (d < bd) { bd = d; best = m; }
  }
  return best;
}

/* build a randomised piece of body armour from the exported list,
 * weighted toward lighter armour early and heavier armour deep. */
function makeArmourItem(depth, x, y) {
  const list = DATA.armour || [];
  if (!list.length) return null;
  // a window into the AC-sorted list that slides down with depth
  const lo = Math.max(0, Math.min(list.length - 1, depth - 1));
  const hi = Math.min(list.length - 1, depth + 3);
  const a = list[ri(lo, hi)];
  const armour = { name: a.name, ac: a.ac, ev_penalty: a.ev_penalty };
  if (chance(0.25)) armour.ego = pick(Object.keys(ARMOUR_EGOS));
  return { key: "armour", name: armourLabel(armour), glyph: "[",
           colour: "BROWN", armour, x, y };
}

/* a randomised ring from the exported list, with a rolled enchant. */
function makeRingItem(x, y) {
  const list = DATA.rings || [];
  if (!list.length) return null;
  const r = pick(list);
  return { key: "ring", name: "ring of " + r.name, glyph: "=",
           colour: "YELLOW",
           ring: { name: r.name, terse: r.terse, plus: ri(2, 6) },
           x, y };
}

function makeScrollItem(x, y) {
  // mix DCSS export scrolls with the new mapping / noise kinds
  const kind = pick(["teleport", "teleport", "fear", "mapping", "noise"]);
  return makeScrollItemOf(kind, x, y);
}

function makeWandItem(x, y) {
  const list = DATA.wands || [];
  if (!list.length) return null;
  const w = pick(list);
  return { key: "wand", name: "wand of " + w.name, glyph: "/",
           colour: "LIGHTMAGENTA",
           wand: { name: w.name, kind: w.name, charges: ri(3, 7) }, x, y };
}

function makeMissileItem(x, y) {
  const list = DATA.missiles || [];
  if (!list.length) return null;
  const m = pick(list);
  return { key: "missile", name: m.name, glyph: ")", colour: "LIGHTCYAN",
           missile: { name: m.name, damage: m.damage },
           count: ri(3, 8), x, y };
}

function spawnItems(lvl) {
  // indoor levels stock their treasure via generateIndoorLevel
  if (lvl.branch === "Indoors") return [];
  const items = [];
  // the Surface is sparse on background loot -- most treasure comes
  // from monster drops; chunks just sprinkle the occasional find
  const count = lvl.branch === "Surface" ? ri(0, 2) : 4 + ri(0, 3);
  for (let i = 0; i < count; i++) {
    const room = pick(lvl.rooms);
    const x = ri(room.x, room.x + room.w - 1);
    const y = ri(room.y, room.y + room.h - 1);
    if (lvl.tiles[y][x] !== T.FLOOR) continue;
    if (items.some(it => it.x === x && it.y === y)) continue;
    let item;
    const r = Math.random();
    if (r < 0.20) {
      item = makePotionItem("heal", x, y);
    } else if (r < 0.40) {
      // a grab-bag of the rarer potions
      item = makePotionItem(pick(["might", "haste", "berserk",
                                  "magic", "cancel"]), x, y);
    } else if (r < 0.56) {
      // gold piles -- or, on deeper floors, sometimes a gem
      if (lvl.diff >= 2 && chance(0.30)) {
        item = makeGemItem(lvl.diff, x, y);
      } else {
        item = { ...ITEM_KINDS[2], x, y, amount: ri(4, 22) };
      }
    } else if (r < 0.70) {
      const tierMax = Math.min(WEAPONS.length - 1, 1 + lvl.diff);
      const w = brandWeapon(WEAPONS[ri(0, tierMax)]);
      item = { key: "weapon", name: weaponLabel(w), glyph: "(",
               colour: "LIGHTCYAN", weapon: w, x, y };
    } else if (r < 0.80) {
      item = makeArmourItem(lvl.diff, x, y);            // body armour
    } else if (r < 0.88) {
      item = makeScrollItem(x, y);                       // scroll
    } else if (r < 0.93) {
      item = makeRingItem(x, y);                         // ring
    } else if (r < 0.97) {
      item = makeMissileItem(x, y);                      // throwing weapons
    } else {
      item = makeWandItem(x, y);                         // wand
    }
    if (item) items.push(item);
  }
  // a treasure stash: on a deeper level (~25%), drop a small pile of
  // gold and gems clustered around one cell. A real reason to detour.
  if (lvl.diff >= 3 && chance(0.25)) {
    const rooms = lvl.rooms;
    const room = rooms[ri(0, rooms.length - 1)];
    if (room) {
      const cells = [];
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const x = room.cx + dx, y = room.cy + dy;
          if (x < 1 || y < 1 || x >= MAP_W - 1 || y >= MAP_H - 1) continue;
          if (lvl.tiles[y][x] !== T.FLOOR) continue;
          if (items.some(i => i.x === x && i.y === y)) continue;
          cells.push([x, y]);
        }
      // gold piles
      for (let i = 0; i < Math.min(2, cells.length); i++) {
        const [x, y] = cells.shift();
        items.push({ ...ITEM_KINDS[2], x, y, amount: ri(30, 80) });
      }
      // and a gem or two
      for (let i = 0; i < Math.min(2, cells.length); i++) {
        const [x, y] = cells.shift();
        items.push(makeGemItem(lvl.diff, x, y));
      }
    }
  }
  return items;
}

/* ---------- vault content placement ---------- */

/* find a monster definition by its display name (cached) */
function monsterDefByName(name) {
  if (!DATA._monByName) {
    DATA._monByName = {};
    for (const m of DATA.monsters) DATA._monByName[m.name] = m;
  }
  return DATA._monByName[name] || null;
}

/* build an item object from a vault's KITEM kind */
function makeVaultItem(kind, x, y) {
  if (kind === "gold") {
    return { ...ITEM_KINDS[2], x, y, amount: ri(6, 30) };
  }
  if (kind === "heal") return makePotionItem("heal", x, y);
  if (kind === "might") return makePotionItem("might", x, y);
  if (kind === "potion") {
    return makePotionItem(pick(["heal", "heal", "might", "haste",
                                "berserk", "magic", "cancel"]), x, y);
  }
  if (kind === "weapon") {
    const w = brandWeapon(WEAPONS[ri(1, Math.min(WEAPONS.length - 1, 4))]);
    return { key: "weapon", name: weaponLabel(w), glyph: "(",
             colour: "LIGHTCYAN", weapon: w, x, y };
  }
  return null;
}

/* place the monsters and items a vault's .des authored, after the
 * normal random spawns. Vault content is the reward/risk a designed
 * room carries; a depth cap keeps a deep-branch vault from dropping
 * something unfair on an early floor. */
function placeVaultContent(lvl) {
  for (const vm of (lvl.vaultMons || [])) {
    if (lvl.tiles[vm.y] === undefined) continue;
    const mt = lvl.tiles[vm.y][vm.x];
    if (mt !== T.FLOOR && mt !== T.WATER) continue;
    if (vm.x === G.player.x && vm.y === G.player.y) continue;
    if (G.monsters.some(m => m.x === vm.x && m.y === vm.y)) continue;
    const def = monsterDefByName(vm.name);
    if (!def || def.tier > effectiveDepth() + 2) continue;
    G.monsters.push(makeMonster(def, vm.x, vm.y));
  }
  for (const vi of (lvl.vaultItems || [])) {
    if (lvl.tiles[vi.y] === undefined) continue;
    if (lvl.tiles[vi.y][vi.x] !== T.FLOOR) continue;
    if (G.items.some(i => i.x === vi.x && i.y === vi.y)) continue;
    const it = makeVaultItem(vi.kind, vi.x, vi.y);
    if (it) G.items.push(it);
  }
}

/* =============================================================
 * Game setup
 * ============================================================= */

/* ---------- background starting kits ----------
 * each martial background begins with gear that suits it, instead of
 * everyone holding the same short sword. Casters keep their spells
 * (set elsewhere); jobs not listed here use the plain default kit. */
const JOB_KITS = {
  "Fighter":    { armour: "scale mail" },
  "Gladiator":  { armour: "leather armour",
                  quiver: { name: "javelin", damage: 7, count: 6 } },
  "Berserker":  { weapon: "hand axe", armour: "animal skin",
                  god: "GOD_TROG", piety: 35 },
  "Hunter":     { armour: "animal skin",
                  quiver: { name: "javelin", damage: 8, count: 12 } },
  "Brigand":    { weapon: "dagger",
                  quiver: { name: "dart", damage: 4, count: 10 } },
  "Warper":     { armour: "leather armour" },
  "Artificer":  { armour: "leather armour" },
  "Reaver":     { armour: "ring mail" },
  "Hexslinger": { quiver: { name: "dart", damage: 4, count: 8 } },
};

/* ---------- item identification ----------
 * iconic DCSS: a picked-up potion is just an "amber potion" until you
 * quaff one. Each run gets a random appearance for every consumable
 * subtype, and a separate flag for whether it has been identified. */
const POTION_LOOKS = ["amber", "ruby", "crimson", "azure", "emerald",
                      "silver", "golden", "mauve", "violet", "smoky",
                      "milky", "dichroic", "sky-blue", "brown",
                      "yellow", "white"];
const SCROLL_LOOKS = ["XYZZY", "FOOBAR", "QUUX", "GORZ", "NIBLE",
                      "VORPL", "PEWMU", "BOMBO", "GLOM", "RHAN",
                      "KRABBI", "ZYXX", "WIBBLE", "TIBIBI"];

function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* set up this run's per-subtype labels */
function rollItemAppearance() {
  const p = shuffled(POTION_LOOKS);
  const s = shuffled(SCROLL_LOOKS);
  return {
    potion: { heal: p[0], might: p[1], haste: p[2],
              berserk: p[3], magic: p[4], cancel: p[5] },
    scroll: { teleport: s[0], fear: s[1],
              mapping: s[2], noise: s[3] },
  };
}

/* the consumable's "true" name -- used when it has been identified */
function trueConsumableName(key, sub) {
  if (key === "potion" && POTION_FLAVOR[sub]) return POTION_FLAVOR[sub].name;
  if (key === "scroll" && SCROLL_FLAVOR[sub]) return SCROLL_FLAVOR[sub].name;
  const word = sub === "heal" ? "healing"
             : sub === "teleport" ? "teleportation"
             : sub;
  if (key === "potion") return "potion of " + word;
  if (key === "scroll") return "scroll of " + word;
  return word;
}

/* the name to show: identified -> "potion of healing", otherwise the
 * per-run appearance ("amber potion", "scroll labelled XYZZY") */
function displayName(item) {
  if (!item) return "";
  // floor items: a potion uses its sub as the top-level key
  if (POTION_FLAVOR[item.key]) {
    const sub = item.key;
    if (G && G.id && G.id.potion && G.id.potion[sub]) {
      return trueConsumableName("potion", sub);
    }
    const a = G && G.appearance && G.appearance.potion[sub];
    return a ? a + " potion" : (item.name || "potion");
  }
  if (item.key === "potion") {
    if (G && G.id && G.id.potion && G.id.potion[item.sub]) {
      return trueConsumableName("potion", item.sub);
    }
    const a = G && G.appearance && G.appearance.potion[item.sub];
    return a ? a + " potion" : (item.name || "potion");
  }
  if (item.key === "scroll") {
    const sub = item.sub || item.scroll;
    if (G && G.id && G.id.scroll && G.id.scroll[sub]) {
      return trueConsumableName("scroll", sub);
    }
    const a = G && G.appearance && G.appearance.scroll[sub];
    return a ? "scroll labelled " + a : (item.name || "scroll");
  }
  return item.name || "";
}

/* a short label for the sidebar -- known kind word, else appearance */
function sidebarLabel(key, sub) {
  if (G && G.id && G.id[key] && G.id[key][sub]) {
    return sub === "teleport" ? "tele" : sub;       // short identified
  }
  const a = G && G.appearance && G.appearance[key] && G.appearance[key][sub];
  return a || sub;
}

/* mark a consumable subtype as identified; logs the reveal */
function identifyConsumable(key, sub) {
  if (!G.id[key]) G.id[key] = {};
  if (G.id[key][sub]) return;
  G.id[key][sub] = true;
  logMsg("It was a " + trueConsumableName(key, sub) + "!", "good");
}

/* fit a freshly-built player with its background's starting kit */
function applyJobKit(player, job) {
  const kit = JOB_KITS[job.name];
  if (!kit) return;
  if (kit.weapon) {
    const w = WEAPONS.find(x => x.name === kit.weapon);
    if (w) player.weapon = Object.assign({}, w);
  }
  if (kit.armour) {
    const a = (DATA.armour || []).find(x => x.name === kit.armour);
    if (a) {
      player.armour = { name: a.name, ac: a.ac, ev_penalty: a.ev_penalty };
    }
  }
  if (kit.quiver) player.quiver = Object.assign({}, kit.quiver);
  if (kit.god) { player.god = kit.god; player.piety = kit.piety || 30; }
}

function startGame(species, job) {
  cancelWalk();
  hoverTile = null;
  awaitingQuaff = false;
  awaitingRead = false;
  awaitingCast = false;
  setInv(false);
  setShop(false);
  G = {
    species, job,
    branch: "D",
    depth: 0,
    levels: {},                 // "branch:depth" -> persisted level state
    branchReturn: {},            // branch id -> where its entrance was
    branchEntries: rollBranchEntries(),
    level: null,
    visible: null,
    seen: null,
    monsters: [],
    items: [],
    npcs: [],
    log: [],
    turn: 0,
    over: false,
    won: false,
    appearance: rollItemAppearance(),     // per-run consumable labels
    id: { potion: {}, scroll: {} },        // identified subtypes
    surfaceCoord: { cx: 0, cy: 0 },        // current Surface chunk
    castleCoord: null,                     // {sx,sy,icx,icy} while inside a castle
    castleReturn: null,                    // {cx,cy,x,y} surface cell to return to
    quests: [],                            // active / completed quests
    trackedQuest: null,                    // id of the compass-tracked quest
  };

  // DCSS character stats: the species' base + the background's bonus
  const player = {
    kind: "player",
    name: species.name + " " + job.name,
    glyph: "@", colour: "WHITE",
    x: 0, y: 0,
    xl: 1, xp: 0, xpNext: 12,
    str: Math.max(1, (species.str || 0) + (job.str || 0)),
    int: Math.max(1, (species.int || 0) + (job.int || 0)),
    dex: Math.max(1, (species.dex || 0) + (job.dex || 0)),
    speed: speciesTrait(species) &&
           speciesTrait(species).id === "fleet" ? 12 : 10,
    energy: 0,
    size: species.size || "medium",
    trait: speciesTrait(species),     // innate species ability, or null
    gold: 0,
    // every adventurer starts with a serviceable blade and a little
    // emergency healing -- a careless run can still end on D:1, but a
    // careful one has a fighting chance to reach the Orb.
    weapon: startingWeapon(),
    armour: null,            // worn body armour {name, ac, ev_penalty}
    ring: null,              // worn ring {name, terse, plus}
    wand: null,              // held wand {name, kind, charges}
    quiver: null,            // thrown weapons {name, damage, count}
    // the backpack: one list of everything carried -- gear and
    // stackable consumables alike
    pack: [
      { key: "potion", sub: "heal", name: "potion of healing", qty: 4 },
      { key: "potion", sub: "might", name: "potion of might", qty: 1 },
      { key: "scroll", sub: "teleport",
        name: "scroll of teleportation", qty: 1 },
    ],
    spells: (CASTER_SPELLS[job.name] || []).slice(),
    god: null,               // worshipped god id, or null
    piety: 0,
    mightTurns: 0,
    berserkTurns: 0,
    heroismTurns: 0,
    poisonTurns: 0,
    slowTurns: 0,
    hasteTurns: 0,
    paralyzedTurns: 0,
    confusedTurns: 0,
    // stealth: stat-driven sneak mode. H toggles. Breaks on spotted
    // / attack / loud quaff. stealthCD is a brief cooldown after
    // breaking so you can't immediately retoggle.
    stealthed: false,
    stealthCD: 0,
    // carrying a backstab victim's body -- capacity ONE. Drops with D.
    // Hauling the corpse costs -3 to stealth (heavy, dripping).
    carriedBody: null,
    species, job,                       // keep refs so stealthScore can read .id
    kills: 0,
  };
  applyJobKit(player, job);          // background-specific starting gear
  player.hpMax = playerMaxHp(player, species);
  player.hp = player.hpMax;
  player.mpMax = Math.max(0, 3 + Math.floor(player.int / 2) + (species.mp_mod || 0));
  player.mp = player.mpMax;
  // food + hunger -- ticks down each turn, eat to restore. Hits zero
  // and starvation starts eating HP.
  player.foodMax = 200;
  player.food = 200;
  // start with a couple of rations so a fresh run isn't immediately
  // hungry while you find your first cache
  player.pack.push({ key: "food", sub: "ration", name: "ration", qty: 2 });
  G.player = player;

  // resolve the player's sprite from the tile manifest
  G.playerTile = (MANIFEST && MANIFEST.player &&
    (MANIFEST.player[species.id] || MANIFEST.player._default)) || null;

  buildSpellButtons();   // an action button per spell the player knows

  // restore real-time mode preference from a prior session
  if (typeof localStorage !== "undefined") {
    try {
      const saved = localStorage.getItem("crawlweb.realtime");
      if (saved === "1") setRealtime(true);
    } catch (e) { /* ignore */ }
  }

  // if the player has a hearth from a prior run, spawn there instead
  // of dropping into D:1. The world resumes from your home.
  const home = loadPlayerHome();
  if (home && home.hearth) {
    const hc = home.hearth;
    G.surfaceCoord = { cx: hc.cx | 0, cy: hc.cy | 0 };
    enterLevel("Surface", 1, "cell:" + (hc.x | 0) + "," + (hc.y | 0),
               { cx: hc.cx | 0, cy: hc.cy | 0 });
    logMsg("Welcome home, " + player.name + ". Your hearth burns.", "good");
  } else {
    enterLevel("D", 1, "up");
    logMsg("Welcome, " + player.name + ". Descend the Dungeon's " +
           TRUNK_LEVELS + " floors to the Crown; the side branches " +
           "off it hold extra danger and loot. Press B to build a home.",
           "sys");
  }
  showScreen("game");
  const cv = document.getElementById("map-canvas");
  if (cv.focus) cv.focus();
  render();
}

function playerMaxHp(p, species) {
  // base curve + species hp modifier (export field species_defs.hp_mod)
  const base = 23 + (p.xl - 1) * 6 + Math.floor(p.str / 3);
  return Math.max(1, Math.round(base * (1 + (species.hp_mod || 0) * 0.08)));
}

/* derived defence stats -- folding in worn armour and ring.
 * Str/Dex rings are applied directly to p.str/p.dex when worn, so
 * they flow through here automatically; AC / EV / Slay rings are
 * read live. */
function ringBonus(p, terse) {
  return (p.ring && p.ring.terse === terse) ? p.ring.plus : 0;
}
function armourEvPenalty(p) {
  // armour_defs ev_penalty is a large negative number (plate -180);
  // scale it down to a sensible EV hit.
  if (!p.armour) return 0;
  return Math.floor(Math.abs(p.armour.ev_penalty || 0) / 45);
}
function playerAC(p) {
  // baseline + strength + worn body armour + ring of protection,
  // plus the Shining One's aura, Okawaru's Heroism and species traits
  let ego = 0;
  if (p.armour && p.armour.ego && ARMOUR_EGOS[p.armour.ego].ac) {
    ego = ARMOUR_EGOS[p.armour.ego].ac;
  }
  let innate = 0;
  if (traitIs(p, "rock")) innate = 6;                 // Gargoyle stone body
  else if (traitIs(p, "scales")) innate = 2 + Math.floor((p.xl || 1) / 3);
  return 3 + Math.floor(p.str / 6) +
         (p.armour ? p.armour.ac : 0) + ego + innate + ringBonus(p, "AC") +
         (p.god === "GOD_SHINING_ONE" ? 3 : 0) +
         (p.heroismTurns > 0 ? 4 : 0);
}
function playerEV(p) {
  let ego = 0;
  if (p.armour && p.armour.ego && ARMOUR_EGOS[p.armour.ego].ev) {
    ego = ARMOUR_EGOS[p.armour.ego].ev;
  }
  // small, nimble species are harder to hit; large ones easier
  const sz = { little: 3, small: 2, large: -2 }[p.size] || 0;
  // an incorporeal ghost is hard to land a blow on
  const ghost = traitIs(p, "incorporeal") ? 3 : 0;
  return 9 + Math.floor(p.dex / 3) + ego + sz + ghost +
         ringBonus(p, "EV") - armourEvPenalty(p) +
         (p.heroismTurns > 0 ? 4 : 0);
}

/* a short label for a level, e.g. "D:3" or "Lair:2" */
/* a deterministic procedurally-generated name for a Surface chunk --
 * pulled from prefix + biome-stem + suffix tables hashed against the
 * (cx,cy) so every region of the world always has the same name. */
const REGION_PREFIXES = ["Old", "Far", "Hollow", "Misty", "Stony",
                          "Gilded", "Quiet", "Wind-swept", "Lonely",
                          "Whispering", "Cold", "Sun-bleached", "Bramble",
                          "Iron", "Black", "Pale", "High", "Low",
                          "Forgotten", "Frosthold", "Shadowed", "Bright",
                          "Wild", "Glassy", "Salt"];
const REGION_BIOME_STEMS = {
  plains:    ["Meadow", "Field", "Heath", "Steppe", "Veldt", "Plain"],
  forest:    ["Wood", "Grove", "Glen", "Copse", "Thicket", "Forest"],
  mountains: ["Crag", "Ridge", "Peak", "Spire", "Bluff", "Highland"],
  swamp:     ["Mire", "Marsh", "Fen", "Bog", "Slough", "Quag"],
  lake:      ["Lake", "Mere", "Pool", "Tarn", "Loch", "Basin"],
};
const REGION_SUFFIXES = ["s", "land", "reach", "march", "country",
                          "shore", "watch", "fold", "fells", "downs"];
function regionNameFor(cx, cy) {
  let h = (cx * 73856093) ^ (cy * 19349663) ^ 0x9e3779b9;
  h = (h ^ (h >>> 13)) >>> 0;
  const biome = biomeAtWorld(cx * MAP_W + 30, cy * MAP_H + 16);
  const stems = REGION_BIOME_STEMS[biome] || REGION_BIOME_STEMS.plains;
  const pre = REGION_PREFIXES[h % REGION_PREFIXES.length];
  h = (h * 16777619) >>> 0;
  const stem = stems[h % stems.length];
  h = (h * 16777619) >>> 0;
  // most regions are "Prefix Stem"; about 1/3 add a suffix for variety
  const useSuffix = (h % 3) === 0;
  if (useSuffix) {
    h = (h * 16777619) >>> 0;
    const suf = REGION_SUFFIXES[h % REGION_SUFFIXES.length];
    return pre + " " + stem + suf;
  }
  return pre + " " + stem;
}

function levelLabel(branch, depth) {
  if (branch === "Surface") {
    const c = (G && G.surfaceCoord) || { cx: 0, cy: 0 };
    return regionNameFor(c.cx, c.cy) + " (" + c.cx + "," + c.cy + ")";
  }
  if (branch === "Indoors") {
    const f = (G && typeof G.indoorFloor === "number") ? G.indoorFloor : -1;
    return f < 0 ? "Cellar " + f : "Upper floor +" + f;
  }
  if (branch === "Castle") {
    const cc = (G && G.castleCoord) || { sx: 0, sy: 0, icx: 0, icy: 0 };
    return "Castle (" + cc.sx + "," + cc.sy +
           ") interior (" + cc.icx + "," + cc.icy + ")";
  }
  return (branch === "D" ? "D" : BRANCHES[branch].name) + ":" + depth;
}

/* roll which Dungeon depth each side branch's entrance sits on --
 * different every game, so the dungeon is never the same shape. */
function rollBranchEntries() {
  const depths = [];
  for (let d = 2; d < TRUNK_LEVELS; d++) depths.push(d);   // 2 .. last-1
  const branches = SIDE_BRANCHES.slice();
  for (let i = branches.length - 1; i > 0; i--) {
    const j = ri(0, i);
    [branches[i], branches[j]] = [branches[j], branches[i]];
  }
  const entries = {};
  branches.forEach((b, i) => {
    const d = depths[i % depths.length];
    (entries[d] = entries[d] || []).push(b);
  });
  return entries;
}

function findTile(lvl, kind) {
  for (let y = 0; y < MAP_H; y++)
    for (let x = 0; x < MAP_W; x++)
      if (lvl.tiles[y][x] === kind) return { x, y };
  return null;
}

/* put the player on the stair they arrived through */
function placePlayerAt(arriveAt) {
  const lvl = G.level;
  let pos = null;
  if (arriveAt && arriveAt.indexOf("branch:") === 0) {
    const b = arriveAt.slice(7);
    const e = (lvl.entrances || []).find(en => en.branch === b);
    if (e) pos = { x: e.x, y: e.y };
  }
  // "cell:X,Y" -- an explicit landing cell (used when returning to the
  // Surface from a building's indoor floor: we land on the stair tile
  // we left from, not just any STAIRS_UP/DOWN in the chunk)
  if (!pos && arriveAt && arriveAt.indexOf("cell:") === 0) {
    const parts = arriveAt.slice(5).split(",");
    const cx = parseInt(parts[0], 10), cy = parseInt(parts[1], 10);
    if (Number.isFinite(cx) && Number.isFinite(cy)) pos = { x: cx, y: cy };
  }
  if (!pos) {
    pos = findTile(lvl, arriveAt === "down" ? T.STAIRS_DOWN : T.STAIRS_UP);
  }
  if (!pos) pos = findTile(lvl, T.STAIRS_UP) || findTile(lvl, T.FLOOR);
  if (!pos) { const r = lvl.rooms[0]; pos = { x: r.cx, y: r.cy }; }
  G.player.x = pos.x;
  G.player.y = pos.y;
}

/* travel to (branch, depth), generating the level the first time and
 * restoring it from G.levels on a revisit. `arriveAt` is "up",
 * "down", or "branch:<id>" -- which stair to drop the player on. */
/* the cache key for a level -- Surface chunks are keyed by their
 * (cx,cy) coordinate so neighbours persist as separate chunks */
function levelKey(branch, depth, coord) {
  if (branch === "Surface") {
    const c = coord || { cx: 0, cy: 0 };
    return "Surface:" + c.cx + "," + c.cy;
  }
  if (branch === "Indoors") {
    const c = coord || { cx: 0, cy: 0, bidx: 0, floor: -1 };
    return "Indoors:" + c.cx + "," + c.cy + ":" + c.bidx + ":" + c.floor;
  }
  if (branch === "Castle") {
    const c = coord || { sx: 0, sy: 0, icx: 0, icy: 0, floor: 0 };
    return "Castle:" + c.sx + "," + c.sy +
           ":" + c.icx + "," + c.icy + ":" + (c.floor || 0);
  }
  return branch + ":" + depth;
}

function enterLevel(branch, depth, arriveAt, coord) {
  // compute the cache key for the level we're LEAVING. Surface uses
  // surfaceCoord, Indoors uses surfaceReturn + indoorFloor (so the
  // same building-floor pair always restores the same stash), and
  // Castle uses castleCoord + indoorFloor.
  let leavingCoord = G.surfaceCoord;
  if (G.branch === "Indoors" && G.surfaceReturn) {
    leavingCoord = { cx: G.surfaceReturn.cx, cy: G.surfaceReturn.cy,
                     bidx: G.surfaceReturn.bidx, floor: G.indoorFloor };
  } else if (G.branch === "Castle" && G.castleCoord) {
    leavingCoord = { sx: G.castleCoord.sx, sy: G.castleCoord.sy,
                     icx: G.castleCoord.icx, icy: G.castleCoord.icy,
                     floor: G.indoorFloor | 0 };
  }
  if (G.level) {
    G.levels[levelKey(G.branch, G.depth, leavingCoord)] = {
      level: G.level, monsters: G.monsters, items: G.items,
      npcs: G.npcs || [],
      visible: G.visible, seen: G.seen, orbPos: G.orbPos,
    };
  }
  G.branch = branch;
  G.depth = depth;
  if (branch === "Surface") {
    G.surfaceCoord = coord || G.surfaceCoord || { cx: 0, cy: 0 };
    G.indoorFloor = 0;
  }
  if (branch === "Indoors") {
    G.indoorFloor = (coord && typeof coord.floor === "number")
      ? coord.floor : -1;
  }
  if (branch === "Castle") {
    G.indoorFloor = (coord && typeof coord.floor === "number")
      ? coord.floor : 0;
    G.castleCoord = {
      sx: (coord && coord.sx) | 0,
      sy: (coord && coord.sy) | 0,
      icx: (coord && coord.icx) | 0,
      icy: (coord && coord.icy) | 0,
    };
    // record where on the Surface we came from, so an EXIT_GATE knows
    // where to drop the player back. Only set on the FIRST entry --
    // subsequent edge transitions inside the castle keep the return
    // point pinned to the entry gate cell.
    if (coord && coord.returnAt && !G.castleReturn) {
      G.castleReturn = {
        cx: G.castleCoord.sx, cy: G.castleCoord.sy,
        x: coord.returnAt.x | 0, y: coord.returnAt.y | 0,
      };
    }
  }
  // Indoors uses the full coord (cx,cy,bidx,floor); Castle uses
  // (sx,sy,icx,icy,floor); other branches use surfaceCoord (or the
  // bare branch:depth fallback inside levelKey).
  const lookupCoord = (branch === "Indoors" || branch === "Castle")
    ? coord : G.surfaceCoord;
  const key = levelKey(branch, depth, lookupCoord);
  const cached = G.levels[key];
  if (cached) {
    G.level = cached.level;
    G.monsters = cached.monsters;
    G.items = cached.items;
    G.npcs = cached.npcs || [];
    G.visible = cached.visible;
    G.seen = cached.seen;
    G.orbPos = cached.orbPos;
    placePlayerAt(arriveAt);
    // Surface respawn: if the player has been away from this chunk for
    // a while and it's near-empty, fresh wandering mobs drift in so the
    // world keeps feeling alive after the player has cleared everything
    if (branch === "Surface") {
      const lastTurn = cached.lastVisitTurn || 0;
      const delta = G.turn - lastTurn;
      const wandering = (G.monsters || []).filter(m => {
        const bm = (G.level.buildingMons || []).some(b =>
          b.x === m.x && b.y === m.y);
        return !bm; // building-placed mobs don't respawn
      }).length;
      if (delta > 60 && wandering < 2) {
        const want = ri(1, 2);
        const tempMons = spawnMonsters(G.level);
        for (let i = 0; i < Math.min(want, tempMons.length); i++) {
          G.monsters.push(tempMons[i]);
        }
      }
      cached.lastVisitTurn = G.turn;
    }
  } else {
    const ret = G.branchReturn[branch];
    const diff = (branch === "D") ? depth
      : ((ret ? ret.depth : 2) + depth);
    const lvl = newLevel(branch, depth, diff, lookupCoord);
    G.level = lvl;
    G.monsters = spawnMonsters(lvl);
    for (const bm of (lvl.buildingMons || [])) {
      const def = monsterDefByName(bm.defName);
      if (!def) continue;
      const m = makeMonster(def, bm.x, bm.y);
      if (bm.guardsChest) m.guardsChest = bm.guardsChest;
      G.monsters.push(m);
    }
    G.items = spawnItems(lvl);
    for (const bi of (lvl.buildingItems || [])) G.items.push(bi);
    G.npcs = lvl.npcs || [];
    G.visible = [];
    G.seen = [];
    for (let y = 0; y < MAP_H; y++) {
      G.visible.push(new Array(MAP_W).fill(false));
      G.seen.push(new Array(MAP_W).fill(false));
    }
    // the Crown rests at the bottom of the Dungeon trunk;
    // newLevel reserved its cell and kept terrain clear of it
    G.orbPos = lvl.orbCell || null;
    placePlayerAt(arriveAt);
    placeVaultContent(lvl);
  }
  G.player.energy = 0;
  // Ashenzari reveals every trap on the floor to her faithful
  if (G.player.god === "GOD_ASHENZARI" && G.level.traps) {
    for (const t of G.level.traps) t.known = true;
  }
  computeFOV();
  if (G.orbPos) {
    logMsg("The Crown glints somewhere on this floor!", "warn");
  }
  for (const e of (G.level.entrances || [])) {
    logMsg("A passage here leads down to the " +
           BRANCHES[e.branch].name + ".", "sys");
  }
  // notable buildings on this Surface chunk -- so the player knows they
  // just walked into a castle / mansion / shop without having to spot
  // the walls. Each per-entry, not repeated across re-visits.
  if (branch === "Surface" && G.level && G.level.buildings) {
    const seen = G.level.buildings;
    const tag = (b) => b.type === "castle"   ? "a castle"
                     : b.type === "mansion"  ? "a grand mansion"
                     : b.type === "manor"    ? "a manor house"
                     : b.type === "shop"     ? "a shop"
                     : b.type === "ruin"     ? "a ruin"
                     : null;
    const labels = seen.map(tag).filter(Boolean);
    if (labels.length) {
      const parts = labels.length === 1 ? labels[0]
                  : labels.slice(0, -1).join(", ") + " and " +
                    labels[labels.length - 1];
      logMsg("You see " + parts + " here.", "sys");
    }
  }
  saveGame();              // checkpoint on every level transition
}

/* =============================================================
 * Combat -- mirrors the exported fight.cc to-hit / damage helpers.
 * ============================================================= */

function entityAt(x, y) {
  if (G.player.x === x && G.player.y === y) return G.player;
  return G.monsters.find(m => m.x === x && m.y === y) || null;
}

/* to-hit: roll(1..toHit); hit if it clears the defender's EV, with a
 * MIN/MAX hit floor/ceiling like mon_to_hit_pct in fight.cc. */
function attackRoll(toHit, ev) {
  const r = ri(1, Math.max(2, toHit));
  if (r >= ev) return true;
  // small auto-hit chance even on a low roll
  return chance(0.08);
}

function playerToHit(p) {
  // analogue of aux_to_hit / calc_to_hit: dex + fighting (XL) + weapon acc
  // + a ring of slaying, Okawaru's aim and Heroism
  return 12 + p.xl * 2 + Math.floor(p.dex / 2) + p.weapon.acc +
         ringBonus(p, "Slay") +
         (p.god === "GOD_OKAWARU" ? 3 : 0) +
         (p.heroismTurns > 0 ? 4 : 0);
}

/* per-point AC blocking, the apply_chunked_AC idea: each AC point has an
 * independent chance to shave a point of damage. */
function applyAC(dam, ac) {
  let hurt = 0;
  for (let i = 0; i < dam; i++) {
    let blocked = false;
    for (let a = 0; a < ac; a++) {
      if (chance(1 / 81)) { blocked = true; break; }
    }
    if (!blocked) hurt++;
  }
  // guarantee a sting on a clean hit
  return Math.max(dam > 0 ? 1 : 0, hurt);
}

function playerAttack(mon) {
  const p = G.player;
  // attacking a neutral guard turns them (and any other neutrals
  // sharing the same chest watch) hostile -- guards talk to each other
  if (mon.neutral) {
    mon.neutral = false;
    mon.awake = true;
    logMsg("The " + mon.name + " draws steel -- combat!", "warn");
    for (const o of G.monsters) {
      if (o !== mon && o.neutral && o.guardsChest && mon.guardsChest &&
          o.guardsChest.x === mon.guardsChest.x &&
          o.guardsChest.y === mon.guardsChest.y) {
        o.neutral = false;
        o.awake = true;
      }
    }
  }
  // sneak attack: striking from stealth (against an unaware target)
  // guarantees the blow lands and bumps damage. Hitting from stealth
  // always breaks it -- you're now in plain view, weapon swinging.
  const fromStealth = p.stealthed && !mon.awake;
  if (!fromStealth && !attackRoll(playerToHit(p), mon.ev + 1)) {
    logMsg("You miss the " + mon.name + ".", "dim");
    sfx("miss");
    if (p.stealthed) breakStealth("The " + mon.name + " sees your strike.");
    return;
  }
  sfx("hit");
  let dam = roll(p.weapon.dice, p.weapon.sides);
  dam += Math.floor(p.str / 4) + p.weapon.str;
  dam += Math.floor(p.xl / 2);                 // fighting-skill analogue
  dam += ringBonus(p, "Slay");                 // ring of slaying damage
  if (p.weapon.ego) {                          // a flaming / heavy / ... blade
    dam += roll(1, WEAPON_EGOS[p.weapon.ego].bonus);
  }
  if (traitIs(p, "clawed")) dam += 2;          // Ghoul natural claws
  if (p.god === "GOD_TROG") dam += 2 + Math.floor(p.piety / 50);
  if (p.mightTurns > 0) dam = Math.round(dam * 1.3);
  if (p.berserkTurns > 0) dam = Math.round(dam * 1.5);   // Trog's berserk
  if (fromStealth) {
    // backstab: +75% damage, ignore most of the target's AC
    dam = Math.round(dam * 1.75) + ri(2, 5);
    logMsg("You backstab the " + mon.name + "!", "good");
    sfx("backstab");
    dam = applyAC(dam, Math.max(0, mon.ac - 4));
  } else {
    dam = applyAC(dam, mon.ac);
  }
  if (p.stealthed) breakStealth(null);
  mon.hp -= dam;
  showHitArrow(mon.x, mon.y, p.x, p.y);
  if (mon.hp <= 0) {
    // bosses go out with a puff of black smoke instead of just vanishing
    if (mon.def && mon.def.boss && MANIFEST && MANIFEST.effect) {
      addEffect(mon.x, mon.y, MANIFEST.effect.cloud_smoke, 900);
    }
    logMsg("You kill the " + mon.name + "!", "good");
    const killedAtX = mon.x, killedAtY = mon.y;
    const killedName = mon.name;
    const killedTile = mon.tile;
    // a backstab kill rewards the sneak: +50% XP and a small piety
    // bump on top of the normal kill bookkeeping inside killMonster
    const backstabBonusXP = fromStealth
      ? Math.max(1, Math.round((mon.def.exp || 1) * 0.5)) : 0;
    killMonster(mon);
    if (backstabBonusXP) gainXP(backstabBonusXP);
    // a backstab leaves a body. Drop a corpse item the player can
    // pick up (capacity 1) and stash elsewhere -- hides evidence,
    // moves the trail.  Only on stealth kills, only if the tile is
    // not already occupied by another item.
    if (fromStealth) {
      const occupied = (G.items || []).some(it =>
        it.x === killedAtX && it.y === killedAtY);
      if (!occupied) {
        G.items.push({
          key: "corpse",
          name: killedName + "'s body",
          corpseName: killedName,
          tile: killedTile,
          fromKill: true,
          x: killedAtX, y: killedAtY,
          glyph: "%", colour: "ETC_BLOOD",
        });
        logMsg("The " + killedName + " crumples. Press g to carry the body.",
               "dim");
      }
    }
    // a Vampire drinks the victim's blood -- heal a little on a kill
    if (traitIs(p, "bloodthirst") && p.hp < p.hpMax) {
      const heal = ri(2, 6);
      p.hp = Math.min(p.hpMax, p.hp + heal);
      logMsg("You drink its blood (+" + heal + " HP).", "good");
    }
  } else {
    logMsg("You hit the " + mon.name + " (" + dam + ").", "");
    // a venomous weapon may poison its target
    if (p.weapon.ego === "venom" && chance(0.5)) {
      const t = ri(5, 10);
      if ((mon.poisonTurns || 0) < t) {
        mon.poisonTurns = t;
        logMsg("The " + mon.name + " looks poisoned.", "good");
      }
    }
  }
}

function monsterAttack(mon) {
  const p = G.player;
  // mon_to_hit_base from fight.cc: 18 + hd * 3/2  (unskilled)
  const toHit = 18 + Math.floor(mon.def.hd * 3 / 2);
  if (!attackRoll(toHit, playerEV(p) + 1)) {
    logMsg("The " + mon.name + " misses you.", "dim");
    return;
  }
  const atk = pick(mon.def.attacks);
  let dam = roll(1, Math.max(2, atk.damage));
  dam = applyAC(dam, playerAC(p));
  if (traitIs(p, "shave")) {            // Deep Dwarf shrugs off some
    dam = Math.max(1, dam - roll(1, 4));
  }
  p.hp -= dam;
  logMsg("The " + mon.name + " hits you (" + dam + ").", "bad");
  sfx("hurt"); flashDamage();
  showHitArrow(p.x, p.y, mon.x, mon.y);
  if (p.hp <= 0) { gameOver(false, mon.name); return; }
  // venomous creatures (snakes, spiders, scorpions, wasps...) poison
  if (isVenomousMonster(mon) && chance(0.30)) applyPoison(p, ri(7, 14));
  // cold-touched melee (frost / ice / white / simulacrum) slows
  if (isColdMon(mon) && chance(0.25)) applySlow(p, ri(8, 16));
  // negative-energy attackers (wraiths, shadows, spectres) drain XL
  if (isDrainMon(mon) && chance(0.20)) applyDrain(p);
  // medusa-kin paralyse with their gaze for a turn or two
  if (isParalyseMon(mon) && chance(0.15)) applyParalysis(p, ri(2, 3));
  // gibbering / harpy / moth attacks confuse
  if (isConfuseMon(mon) && chance(0.20)) applyConfusion(p, ri(4, 8));
  // Minotaur horns: a free headbutt back at the attacker
  if (traitIs(p, "retaliate") && mon.hp > 0 &&
      Math.abs(mon.x - p.x) <= 1 && Math.abs(mon.y - p.y) <= 1) {
    const hb = applyAC(roll(1, 8) + Math.floor(p.str / 4), mon.ac);
    mon.hp -= hb;
    if (mon.hp <= 0) {
      logMsg("You headbutt the " + mon.name + " — and it dies!", "good");
      killMonster(mon);
    } else {
      logMsg("You headbutt the " + mon.name + " (" + hb + ").", "");
    }
  }
}

/* a ranged caster's bolt -- its damage scales with the monster's HD,
 * is dodged against the player's EV and reduced by AC. */
function monsterBolt(mon) {
  const p = G.player;
  const hd = mon.def.hd || 1;
  // cast a spell the monster's actual spellbook carries
  const spells = mon.def.ranged_spells || [];
  const spell = spells.length ? pick(spells)
    : { title: "a bolt of energy", level: 2 };
  if (!attackRoll(14 + hd, playerEV(p) + 1)) {
    logMsg("The " + mon.name + " casts " + spell.title +
           " at you, but it misses.", "dim");
    return;
  }
  // damage scales with the monster's HD and the spell's level
  let dam = roll(2, 1 + Math.floor(hd / 4) + (spell.level || 2));
  dam = applyAC(dam, playerAC(p));
  p.hp -= dam;
  logMsg("The " + mon.name + " hits you with " + spell.title +
         " (" + dam + ").", "bad");
  sfx("hurt"); flashDamage();
  if (p.hp <= 0) gameOver(false, mon.name);
}

function killMonster(mon) {
  G.monsters = G.monsters.filter(m => m !== mon);
  const p = G.player;
  p.kills++;
  sfx("kill");
  gainXP(mon.def.exp);
  gainPiety(ri(2, 5));                       // kills please your god
  if (p.god === "GOD_MAKHLEB" && p.hp < p.hpMax) {
    p.hp = Math.min(p.hpMax, p.hp + ri(1, 4));   // Makhleb's lifesteal
  }
  if (p.god === "GOD_KIKUBAAQUDGHA" && p.hp < p.hpMax) {
    p.hp = Math.min(p.hpMax, p.hp + ri(1, 3));   // Kiku's necromantic vigour
  }
  dropMonsterLoot(mon);
  tickKillQuests(mon.def && mon.def.name);
  // a boss kill always drops a high-tier chest on its tile -- the
  // surprise / risk earns a proper reward
  if (mon.def && mon.def.boss && G.level) {
    const occupied = (G.items || []).some(it =>
      it.x === mon.x && it.y === mon.y);
    if (!occupied) {
      G.items.push(makeChestItem(4, mon.x, mon.y));
      logMsg("The " + mon.name + " falls. A chest crashes to the floor!",
             "good");
    }
  }
}

/* a slain monster sometimes leaves a small piece of loot on its tile
 * -- mostly gold, occasionally a useful consumable. Higher-tier kills
 * have better odds of dropping something good. */
function dropMonsterLoot(mon) {
  if (!G.level) return;
  // skip if another item is already on the tile (rare but possible)
  if (G.items.some(it => it.x === mon.x && it.y === mon.y)) return;
  const tier = mon.def && mon.def.tier ? mon.def.tier : 1;
  const dropChance = 0.30 + Math.min(0.30, tier * 0.05);
  if (!chance(dropChance)) return;
  const r = Math.random();
  let item = null;
  if (r < 0.55) {
    // a small purse of coin
    item = { ...ITEM_KINDS[2], x: mon.x, y: mon.y,
             amount: ri(3, 8 + tier * 4) };
  } else if (r < 0.75) {
    // a healing potion or a flavoured one for tougher kills
    const sub = tier >= 3 && chance(0.5)
      ? pick(["might", "haste", "magic"]) : "heal";
    item = makePotionItem(sub, mon.x, mon.y);
  } else if (r < 0.88) {
    item = makeScrollItem(mon.x, mon.y);
  } else if (r < 0.92 && tier >= 2) {
    // tougher foes occasionally drop a gem
    item = makeGemItem(tier, mon.x, mon.y);
  } else if (r < 0.98) {
    // a snack -- a piece of food
    item = makeFoodItem(mon.x, mon.y);
  } else {
    item = makeMissileItem(mon.x, mon.y);
  }
  if (item) {
    G.items.push(item);
    logMsg("The " + mon.name + " drops something.", "dim");
  }
}

function gainXP(amount) {
  const p = G.player;
  const scaled = Math.max(1, amount);
  p.xp += scaled;
  while (p.xp >= p.xpNext && p.xl < 27) {
    p.xp -= p.xpNext;
    p.xl++;
    sfx("levelup");
    p.xpNext = Math.round(p.xpNext * 1.45) + 6;
    const oldMax = p.hpMax;
    p.hpMax = playerMaxHp(p, G.species);
    p.hp += (p.hpMax - oldMax);
    // every few levels, a stat bump
    if (p.xl % 3 === 0) {
      const s = pick(["str", "int", "dex"]);
      p[s] += 1;
      logMsg("You reach experience level " + p.xl + "! (+1 " +
             s.toUpperCase() + ")", "good");
    } else {
      logMsg("You reach experience level " + p.xl + "!", "good");
    }
  }
}

/* =============================================================
 * Player actions
 * ============================================================= */

/* if (p.x,p.y) is impassable, find the nearest passable cell nearby
 * (used after a chunk transition lands on a wall / lake) */
function nudgeToPassable(p) {
  if (passable(G.level, p.x, p.y)) return;
  for (let r = 1; r < 8; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const nx = p.x + dx, ny = p.y + dy;
        if (nx < 1 || ny < 1 || nx >= MAP_W - 1 || ny >= MAP_H - 1) continue;
        if (passable(G.level, nx, ny)) { p.x = nx; p.y = ny; return; }
      }
    }
  }
}

function tryMovePlayer(dx, dy) {
  if (G.over) return false;
  const p = G.player;
  // confusion: there's a 50% chance the player stumbles in a random
  // direction instead of the one they meant to go
  if (p.confusedTurns > 0 && chance(0.5)) {
    const rd = pick([[1,0],[-1,0],[0,1],[0,-1],
                     [1,1],[1,-1],[-1,1],[-1,-1]]);
    dx = rd[0]; dy = rd[1];
    logMsg("You stumble drunkenly.", "warn");
  }
  const nx = p.x + dx, ny = p.y + dy;
  // stepping off the edge of a Surface chunk drifts you into the
  // neighbouring chunk -- the world is endless
  if (G.branch === "Surface" &&
      (nx < 0 || ny < 0 || nx >= MAP_W || ny >= MAP_H)) {
    const dxSign = nx < 0 ? -1 : (nx >= MAP_W ? 1 : 0);
    const dySign = ny < 0 ? -1 : (ny >= MAP_H ? 1 : 0);
    const dir = dxSign > 0 ? "east" : dxSign < 0 ? "west"
              : dySign > 0 ? "south" : "north";
    const next = { cx: G.surfaceCoord.cx + dxSign,
                   cy: G.surfaceCoord.cy + dySign };
    enterLevel("Surface", 1, "edge", next);
    G.player.x = (nx + MAP_W) % MAP_W;
    G.player.y = (ny + MAP_H) % MAP_H;
    nudgeToPassable(G.player);
    logMsg("You walk " + dir + " into " +
           regionNameFor(next.cx, next.cy) +
           " (" + next.cx + "," + next.cy + ").", "sys");
    springTrap();
    pickupUnderfootHint();
    return true;
  }
  // edge of a Castle interior chunk -- step into the adjacent
  // (icx, icy). Unpainted neighbours auto-generate a stone courtyard
  // so the player can always walk forward.
  if (G.branch === "Castle" && G.castleCoord &&
      (nx < 0 || ny < 0 || nx >= MAP_W || ny >= MAP_H)) {
    const dxSign = nx < 0 ? -1 : (nx >= MAP_W ? 1 : 0);
    const dySign = ny < 0 ? -1 : (ny >= MAP_H ? 1 : 0);
    const cc = G.castleCoord;
    const next = {
      sx: cc.sx, sy: cc.sy,
      icx: cc.icx + dxSign, icy: cc.icy + dySign,
      floor: G.indoorFloor | 0,
    };
    enterLevel("Castle", 1, "edge", next);
    G.player.x = (nx + MAP_W) % MAP_W;
    G.player.y = (ny + MAP_H) % MAP_H;
    nudgeToPassable(G.player);
    logMsg("You move deeper into the castle (" +
           next.icx + "," + next.icy + ").", "sys");
    return true;
  }
  if (nx < 0 || ny < 0 || nx >= MAP_W || ny >= MAP_H) return false;
  // a friendly NPC standing on the target tile -- bumping opens
  // their dialog instead of an attack (shop UI for shopkeepers,
  // instant rescue for captives). Captives stay rescuable. A
  // STEALTHED bump against any other NPC is a sneak kill: the
  // body drops as an item the player can hoist; nearby neutral
  // guards who later spot the corpse turn the whole keep hostile.
  const npc = (G.npcs || []).find(n => n.x === nx && n.y === ny);
  if (npc && p.stealthed && npc.kind !== "captive") {
    cancelWalk(); cancelRest();
    logMsg("You sneak up and silence the " + npc.name + ".", "bad");
    sfx("backstab");
    G.npcs = G.npcs.filter(n => n !== npc);
    // a body the player can carry away. wasNpc tags it as a murder
    // victim -- guards passing it turn hostile.
    G.items.push({
      key: "corpse",
      name: npc.name + "'s body",
      corpseName: npc.name,
      tile: npc.tile || null,
      fromKill: true, wasNpc: true,
      x: npc.x, y: npc.y,
      glyph: "%", colour: "ETC_BLOOD",
    });
    // murdering a questgiver / king / shopkeeper fails their open quest
    // -- the dead can't pay you. The quest stays in the log as failed
    // so the player can see what they sacrificed.
    if (npc.questId) {
      const q = G.quests.find(x => x.id === npc.questId);
      if (q && q.status === "active") {
        q.status = "failed";
        q.failedReason = "questgiver murdered";
        logMsg("Quest \"" + (q.type || "task") +
               "\" with " + npc.name + " fails -- the dead don't pay.",
               "warn");
      }
    }
    breakStealth(null);
    flashDamage();
    return true;
  }
  if (npc) {
    cancelWalk(); cancelRest();
    if (npc.kind === "shopkeeper") {
      setShop(true, npc);
    } else if (npc.kind === "blacksmith") {
      blacksmithService(npc);
    } else if (npc.kind === "king") {
      openNPCDialog(npc);
    } else if (npc.kind === "child") {
      const lines = [
        "wants to know if you've fought a dragon.",
        "shows you a pebble they're convinced is magic.",
        "asks how heavy your sword is.",
        "hides behind a chair when you wave.",
        "tells you a secret nobody else knows.",
      ];
      logMsg(npc.name + " " + pick(lines), "dim");
      render();
    } else if (npc.kind === "captive") {
      const q = G.quests.find(x => x.id === npc.captiveQuestId);
      if (q && q.status === "active" && q.type === "rescue") {
        q.rescued = true;
        logMsg(npc.name + ": \"Thank you! Tell " + q.giver.name +
               " I'll find my way home.\"", "good");
        sfx("pickup");
      } else {
        logMsg(npc.name + " nods at you, freed.", "dim");
      }
      // remove the captive from the level so they don't block re-bumps
      G.npcs = G.npcs.filter(n => n !== npc);
      render();
    } else {
      openNPCDialog(npc);
    }
    return false; // talking is not a move
  }
  const mon = G.monsters.find(m => m.x === nx && m.y === ny);
  if (mon) {
    // bumping a neutral guard the FIRST time just warns -- you have to
    // mean it. A second bump (or attacking the chest they watch) flips
    // them hostile and the normal attack goes through.
    if (mon.neutral && !mon.warnedBump) {
      mon.warnedBump = true;
      logMsg("The " + mon.name + " is on watch -- bump again to attack.",
             "warn");
      return false;
    }
    playerAttack(mon);
    return true;
  }
  // a closed wooden door opens on a push
  if (G.level.tiles[ny][nx] === T.DOOR) {
    G.level.tiles[ny][nx] = T.DOOR_OPEN;
    logMsg("You open the door.", "");
    return true;
  }
  // a locked wooden door: a key in the pack opens it cleanly (and is
  // consumed); without a key the player has to bash it
  if (G.level.tiles[ny][nx] === T.DOOR_LOCKED) {
    const keyIdx = (p.pack || []).findIndex(it => it.key === "key");
    if (keyIdx >= 0) {
      const k = p.pack[keyIdx];
      if (k.qty && k.qty > 1) k.qty--;
      else p.pack.splice(keyIdx, 1);
      G.level.tiles[ny][nx] = T.DOOR_OPEN;
      logMsg("You turn a key in the lock -- the door swings open.", "good");
      sfx("pickup");
      return true;
    }
    const bashChance = 0.5 + Math.floor(p.str / 4) * 0.04;
    if (Math.random() < bashChance) {
      G.level.tiles[ny][nx] = T.DOOR_OPEN;
      logMsg("You bash the locked door open!", "good");
    } else {
      logMsg("You slam against the locked door, but it holds.", "warn");
    }
    return true;
  }
  // a steel door takes much more effort
  if (G.level.tiles[ny][nx] === T.DOOR_STEEL) {
    const bashChance = 0.20 + Math.floor(p.str / 4) * 0.03;
    if (Math.random() < bashChance) {
      G.level.tiles[ny][nx] = T.DOOR_OPEN;
      logMsg("With a grinding crash, the steel door gives way!", "good");
    } else {
      logMsg("You batter the steel door — it barely shudders.", "warn");
    }
    return true;
  }
  // a heavy gate opens, but the noise wakes nearby monsters
  if (G.level.tiles[ny][nx] === T.GATE) {
    G.level.tiles[ny][nx] = T.DOOR_OPEN;
    logMsg("You shoulder the gate open with a creak.", "");
    let n = 0;
    for (const m of G.monsters) {
      const d = Math.max(Math.abs(m.x - p.x), Math.abs(m.y - p.y));
      if (!m.awake && d <= 12) { m.awake = true; n++; }
    }
    if (n > 0) {
      logMsg("The creak rouses " + n + " monster" +
             (n === 1 ? "" : "s") + ".", "warn");
    }
    return true;
  }
  // a Tengu may stride across lava; everyone else respects passable()
  const targ = G.level.tiles[ny][nx];
  const canFly = traitIs(p, "flight") && targ === T.LAVA;
  if (!canFly && !passable(G.level, nx, ny)) {
    return false;
  }
  p.x = nx; p.y = ny;
  springTrap();              // a hidden trap underfoot goes off
  if (!G.over && G.level.tiles[p.y][p.x] === T.SHOP) {
    cancelWalk();
    setShop(true);           // stepping onto a shop opens it
  }
  // Surface points of interest: wells heal, shrines bless, graves
  // sometimes drop a small find. One-shot: the tile becomes FLOOR after
  // use so the same well doesn't refill the player every step.
  const here = G.level.tiles[p.y][p.x];
  // POIs stay on the map as scenery after one use; instead of removing
  // the tile, we mark the cell as drained on lvl.drainedPOIs. The render
  // dims drained cells so they still read as "you've been here before".
  if (!G.level.drainedPOIs) G.level.drainedPOIs = {};
  const poiKey = p.y * MAP_W + p.x;
  const drainPOI = () => { G.level.drainedPOIs[poiKey] = true; };
  const isDrained = !!G.level.drainedPOIs[poiKey];
  if (here === T.WELL) {
    if (isDrained) { logMsg("The well is dry now.", "dim"); cancelWalk(); }
    else {
      const heal = ri(8, 18);
      p.hp = Math.min(p.hpMax, p.hp + heal);
      logMsg("You drink from the well -- you recover " + heal + " HP.", "good");
      sfx("quaff");
      drainPOI(); cancelWalk(); cancelRest();
    }
  } else if (here === T.SHRINE) {
    if (isDrained) { logMsg("The shrine has fallen silent.", "dim"); cancelWalk(); }
    else {
      p.mightTurns = Math.max(p.mightTurns || 0, 12);
      logMsg("You touch the shrine and feel a surge of might (12 turns).", "good");
      sfx("quaff");
      drainPOI(); cancelWalk(); cancelRest();
    }
  } else if (here === T.GRAVE) {
    if (isDrained) { logMsg("The grave has already been disturbed.", "dim"); cancelWalk(); }
    else {
      if (chance(0.35)) {
        const gem = makeGemItem(2, p.x, p.y);
        G.items.push(gem);
        logMsg("You disturb the grave and unearth a " + gem.name + ".", "good");
        sfx("pickup");
      } else {
        logMsg("The grave is undisturbed.", "dim");
      }
      drainPOI(); cancelWalk();
    }
  } else if (here === T.CAMPSITE) {
    if (isDrained) { logMsg("The camp's embers are cold.", "dim"); cancelWalk(); }
    else {
      const heal = ri(10, 22);
      p.hp = Math.min(p.hpMax, p.hp + heal);
      const stash = ri(8, 20);
      p.gold += stash;
      logMsg("You rest at the abandoned camp -- recover " + heal +
             " HP and find " + stash + " gold in the embers.", "good");
      sfx("pickup");
      drainPOI(); cancelWalk(); cancelRest();
    }
  } else if (here === T.IDOL) {
    if (isDrained) { logMsg("The idol's eyes are dark.", "dim"); cancelWalk(); }
    else {
      if (chance(0.5)) {
        p.mightTurns = Math.max(p.mightTurns || 0, 15);
        logMsg("The idol's eyes glow -- you feel mighty (15 turns).", "good");
        sfx("quaff");
      } else {
        p.slowTurns = Math.max(p.slowTurns || 0, 8);
        logMsg("The idol whispers -- your limbs grow leaden (8 turns).", "warn");
      }
      drainPOI(); cancelWalk(); cancelRest();
    }
  } else if (here === T.MANA_NODE) {
    if (isDrained) { logMsg("The crystal's light has faded.", "dim"); cancelWalk(); }
    else {
      if (p.mpMax > 0) {
        const mp = ri(3, 7);
        p.mp = Math.min(p.mpMax, p.mp + mp);
        logMsg("The crystal hums -- you recover " + mp + " MP.", "good");
        sfx("cast");
      } else {
        logMsg("The crystal hums, but its energy slides off you.", "dim");
      }
      drainPOI(); cancelWalk(); cancelRest();
    }
  } else if (here === T.SIGNPOST) {
    // a wayfinder -- names the regions to the cardinal sides so the
    // player can plot a path. The post itself stays standing.
    const sc = G.surfaceCoord || { cx: 0, cy: 0 };
    const dirs = [
      { name: "north", c: { cx: sc.cx,     cy: sc.cy - 1 } },
      { name: "east",  c: { cx: sc.cx + 1, cy: sc.cy     } },
      { name: "south", c: { cx: sc.cx,     cy: sc.cy + 1 } },
      { name: "west",  c: { cx: sc.cx - 1, cy: sc.cy     } },
    ];
    const parts = dirs.map(d => d.name + ": " +
      regionNameFor(d.c.cx, d.c.cy)).join(" · ");
    logMsg("You read the signpost. " + parts, "sys");
    cancelWalk();
  } else if (here === T.BEACON) {
    if (isDrained) { logMsg("The beacon already burned -- nothing to relight.", "dim"); cancelWalk(); }
    else {
      const sc = G.surfaceCoord || { cx: 0, cy: 0 };
      let lit = 0;
      for (let dx = -2; dx <= 2; dx++) {
        for (let dy = -2; dy <= 2; dy++) {
          ensureSurfaceChunk(sc.cx + dx, sc.cy + dy);
          lit++;
        }
      }
      logMsg("You light the beacon -- " + lit +
             " chunks of the world unfurl on your map (M).", "good");
      sfx("levelup");
      drainPOI(); cancelWalk(); cancelRest();
    }
  } else if (here === T.FLOWERS) {
    if (isDrained) { logMsg("The flowers are picked.", "dim"); cancelWalk(); }
    else {
      const heal = ri(3, 8);
      p.hp = Math.min(p.hpMax, p.hp + heal);
      if (p.poisonTurns > 0) {
        p.poisonTurns = 0;
        logMsg("Sweet petals -- +" + heal + " HP, the poison fades.", "good");
      } else {
        logMsg("Sweet petals -- you feel a little better (+" + heal + " HP).", "good");
      }
      sfx("pickup");
      drainPOI(); cancelWalk();
    }
  } else if (here === T.LECTERN) {
    if (isDrained) { logMsg("The lectern's pages are blank.", "dim"); cancelWalk(); }
    else {
      const candidates = (p.pack || []).filter(it =>
        (it.key === "scroll" || it.key === "potion") &&
        it.sub && !(G.id[it.key] && G.id[it.key][it.sub]));
      if (candidates.length) {
        const pick1 = pick(candidates);
        identifyConsumable(pick1.key, pick1.sub);
        logMsg("The lectern's pages name your " +
               (pick1.key === "scroll" ? "scroll" : "potion") + ".", "good");
        sfx("cast");
      } else {
        logMsg("The lectern names items you already know.", "dim");
      }
      drainPOI(); cancelWalk();
    }
  } else if (here === T.FRUIT_CACHE) {
    if (isDrained) { logMsg("The fruit's all gone.", "dim"); cancelWalk(); }
    else {
      // eat one fruit now (heal + food), grab the rest for the pack
      const heal = ri(8, 16);
      p.hp = Math.min(p.hpMax, p.hp + heal);
      p.food = Math.min(p.foodMax, p.food + 40);
      if (chance(0.15)) {
        p.poisonTurns = Math.max(p.poisonTurns || 0, 5);
        logMsg("You eat from the cache (+" + heal +
               " HP, +40 food) but one was spoiled -- poisoned!", "warn");
      } else {
        logMsg("You eat from the cache (+" + heal + " HP, +40 food).", "good");
      }
      // a couple of extra pieces of fruit go in the pack
      const extras = ri(1, 3);
      for (let i = 0; i < extras; i++) {
        const k = pick(FOOD_KINDS);
        packAdd({ key: "food", sub: k.sub, name: k.name, qty: 1 });
      }
      logMsg("You stuff " + extras + " more in your pack.", "good");
      sfx("quaff");
      drainPOI(); cancelWalk();
    }
  } else if (here === T.TELEPORTER) {
    const tp = G.level.teleporters &&
               G.level.teleporters[p.y * MAP_W + p.x];
    if (tp && G.branch === "Surface") {
      logMsg("The runes flare -- you are torn through space!", "good");
      sfx("cast");
      cancelWalk(); cancelRest();
      enterLevel("Surface", 1,
        "cell:" + (tp.x || 1) + "," + (tp.y || 1),
        { cx: tp.cx | 0, cy: tp.cy | 0 });
      return true;
    }
    logMsg("The runes flicker, but no destination answers.", "dim");
    cancelWalk();
  } else if (here === T.CASTLE_GATE && G.branch === "Surface") {
    // step into the castle's pocket interior. The castle is keyed by
    // the surface chunk coord; we land at interior (0,0).
    const sc = G.surfaceCoord || { cx: 0, cy: 0 };
    logMsg("The gate looms open -- you step inside.", "sys");
    sfx("descend");
    cancelWalk(); cancelRest();
    G.castleReturn = null;  // fresh entry -- record where we came from
    enterLevel("Castle", 1, "cell:" + ((MAP_W >> 1) | 0) +
                            "," + ((MAP_H - 3) | 0),
      { sx: sc.cx, sy: sc.cy, icx: 0, icy: 0, floor: 0,
        returnAt: { x: p.x, y: p.y } });
    return true;
  } else if (here === T.HEARTH) {
    // your own hearth: a full rest, free of cost. Skip if already full.
    if (p.hp >= p.hpMax && p.mp >= p.mpMax) {
      logMsg("Your hearth burns warm; you're already whole.", "dim");
    } else {
      p.hp = p.hpMax;
      p.mp = p.mpMax;
      p.food = p.foodMax;
      logMsg("You rest by your hearth -- fully restored.", "good");
      sfx("levelup");
      cancelWalk();
    }
  } else if (here === T.BED) {
    // a built bed: same effect as hearth-rest (heal to full)
    if (p.hp < p.hpMax || p.mp < p.mpMax) {
      p.hp = p.hpMax; p.mp = p.mpMax;
      logMsg("You sleep deeply. You wake refreshed.", "good");
      sfx("descend");
      cancelWalk();
    } else {
      logMsg("You're not tired enough to sleep.", "dim");
    }
  } else if (here === T.PLAYER_SIGN) {
    const home = ensurePlayerHome();
    const k = (G.surfaceCoord ? G.surfaceCoord.cx : 0) + "," +
              (G.surfaceCoord ? G.surfaceCoord.cy : 0) +
              ":" + p.x + "," + p.y;
    const msg = (home.signs && home.signs[k]) || "(blank sign)";
    logMsg('Sign: "' + msg + '"', "sys");
    cancelWalk();
  } else if (here === T.PLAYER_CHEST) {
    // your home chest -- persistent storage. The big feature in
    // Phase 1: dump the body you're carrying so guards never find it.
    const home = ensurePlayerHome();
    home.chestSlots = home.chestSlots || [];
    if (p.carriedBody) {
      home.chestSlots.push({
        kind: "body",
        name: p.carriedBody.name,
        corpseName: p.carriedBody.corpseName,
        wasNpc: !!p.carriedBody.wasNpc,
        savedAt: Date.now(),
      });
      logMsg("You stash " + p.carriedBody.name +
             " in your chest. Hidden forever.", "good");
      sfx("body");
      p.carriedBody = null;
      savePlayerHome(home);
    } else {
      const n = home.chestSlots.length;
      logMsg("Your chest holds " + n + " item" +
             (n === 1 ? "" : "s") +
             (n ? " (stashed bodies / loot)" : "") + ".", "sys");
    }
    cancelWalk();
  } else if (here === T.EXIT_GATE && G.branch === "Castle") {
    // leave the castle, returning to the surface cell that owned the
    // entry gate (or to (1,1) of the home chunk as a fallback).
    const ret = G.castleReturn || { cx: (G.castleCoord && G.castleCoord.sx) | 0,
                                    cy: (G.castleCoord && G.castleCoord.sy) | 0,
                                    x: 1, y: 1 };
    logMsg("You step back through the gate.", "sys");
    sfx("descend");
    cancelWalk(); cancelRest();
    G.castleReturn = null;
    G.castleCoord = null;
    enterLevel("Surface", 1, "cell:" + (ret.x | 0) + "," + (ret.y | 0),
      { cx: ret.cx | 0, cy: ret.cy | 0 });
    return true;
  } else if (here === T.WISHING_WELL) {
    if (isDrained) { logMsg("The wishing well is silent now.", "dim"); cancelWalk(); cancelRest(); return true; }
    // a fey well: high-variance outcome. Heals BIG, drops a gold
    // pile, hands over a gem, identifies your potions, hits with a
    // curse, or summons a watcher. Rare and memorable.
    const roll = Math.random();
    if (roll < 0.18) {
      const heal = ri(35, 80);
      p.hp = Math.min(p.hpMax, p.hp + heal);
      logMsg("The well floods you with vigour -- +" + heal + " HP.", "good");
      sfx("quaff");
    } else if (roll < 0.36) {
      const gp = ri(80, 200);
      p.gold += gp;
      logMsg("The well coughs up a heap of " + gp + " gold!", "good");
      sfx("pickup");
    } else if (roll < 0.52) {
      const gem = makeGemItem(3, p.x, p.y);
      G.items.push(gem);
      logMsg("A " + gem.name + " bobs to the surface.", "good");
      sfx("pickup");
    } else if (roll < 0.66) {
      // identify all unknown potions in the player's pack
      let count = 0;
      for (const it of (G.player.pack || [])) {
        if (it.key === "potion" && it.sub && !(G.id.potion[it.sub])) {
          identifyConsumable("potion", it.sub);
          count++;
        }
      }
      if (count) {
        logMsg("The waters whisper their names to your potions (" +
               count + " identified).", "good");
      } else {
        logMsg("The waters murmur, but you have nothing to identify.", "dim");
      }
    } else if (roll < 0.80) {
      p.mightTurns = Math.max(p.mightTurns || 0, 25);
      logMsg("Your reflection grins -- you feel emboldened (Might, 25).", "good");
    } else if (roll < 0.92) {
      const dmg = ri(8, 16);
      p.hp = Math.max(1, p.hp - dmg);
      logMsg("Something cold grips you -- " + dmg + " damage!", "bad");
      sfx("hurt");
    } else {
      // summon a tier-2 hostile right next to the player
      const DIRS = [[1,0],[-1,0],[0,1],[0,-1]];
      for (const [dx, dy] of DIRS) {
        const nx = p.x + dx, ny = p.y + dy;
        if (passable(G.level, nx, ny) &&
            !G.monsters.some(m => m.x === nx && m.y === ny)) {
          const pool = (DATA.monsters || []).filter(m =>
            !m.boss && m.tier <= 2 &&
            (m.biome === "surface_humanoid" ||
             m.biome === "surface_animal"));
          if (pool.length) {
            G.monsters.push(makeMonster(pick(pool), nx, ny));
            logMsg("Something climbs out of the well!", "bad");
          }
          break;
        }
      }
    }
    drainPOI(); cancelWalk(); cancelRest();
  }
  pickupUnderfootHint();
  return true;
}

/* spring a hidden trap the player just stepped onto, if any */
function springTrap() {
  const p = G.player;
  const traps = G.level.traps;
  if (!traps) return;
  const idx = traps.findIndex(t => t.x === p.x && t.y === p.y);
  if (idx < 0) return;
  const trap = traps[idx];
  traps.splice(idx, 1);                       // one-shot
  // a Poltergeist is incorporeal -- traps trigger but slip through it
  if (traitIs(p, "incorporeal")) {
    logMsg("The " + trap.kind + " trap fires through your ghostly form " +
           "and does nothing.", "good");
    return;
  }
  if (trap.kind === "teleport" && teleportImmune(p)) {
    logMsg("The teleport trap fizzles against your anchored stance.",
           "good");
    return;
  }
  if (trap.kind === "slow" && traitIs(p, "embalmed")) {
    logMsg("The slowing trap finds no living muscle to grip.", "good");
    return;
  }
  if (trap.kind === "dart") {
    const dam = applyAC(roll(1, 4 + Math.floor(effectiveDepth() / 2)),
                        playerAC(p));
    p.hp -= dam;
    logMsg("A dart trap springs -- it hits you (" + dam + ")!", "bad");
    sfx("hurt"); flashDamage();
    if (p.hp <= 0) gameOver(false, "a dart trap");
  } else if (trap.kind === "teleport") {
    logMsg("You step on a teleport trap and are flung away!", "warn");
    const spots = [];
    for (let y = 1; y < MAP_H - 1; y++)
      for (let x = 1; x < MAP_W - 1; x++) {
        if (G.level.tiles[y][x] !== T.FLOOR) continue;
        if (Math.max(Math.abs(x - p.x), Math.abs(y - p.y)) < 8) continue;
        if (G.monsters.some(m => m.x === x && m.y === y)) continue;
        spots.push([x, y]);
      }
    if (spots.length) {
      const s = pick(spots);
      p.x = s[0]; p.y = s[1];
      cancelWalk();
      computeFOV();
    }
  } else if (trap.kind === "alarm") {
    let n = 0;
    for (const m of G.monsters) if (!m.awake) { m.awake = true; n++; }
    logMsg("An alarm trap shrieks across the floor! " + n + " monster" +
           (n === 1 ? "" : "s") + " stir.", "warn");
  } else if (trap.kind === "slow") {
    p.slowTurns = Math.max(p.slowTurns || 0, ri(20, 40));
    logMsg("A slowing trap clutches at your limbs!", "warn");
  }
}

function pickupUnderfootHint() {
  const it = G.items.find(i => i.x === G.player.x && i.y === G.player.y);
  if (it) logMsg("You see here a " + displayName(it) +
                 ". Press g to pick it up.", "dim");
}

/* --- the backpack: one list, gear + stackable consumables --- */

/* add an item to the pack, stacking potions / scrolls of a kind */
function packAdd(item) {
  const p = G.player;
  if (item.key === "potion" || item.key === "scroll" ||
      item.key === "gem") {
    const have = p.pack.find(e => e.key === item.key && e.sub === item.sub);
    if (have) { have.qty += (item.qty || 1); return; }
  }
  p.pack.push(item);
}

/* how many of a stackable consumable the player carries */
function packCount(key, sub) {
  const e = G.player.pack.find(x => x.key === key && x.sub === sub);
  return e ? e.qty : 0;
}

/* consume one of a stackable; true if one was removed */
function packTake(key, sub) {
  const p = G.player;
  const i = p.pack.findIndex(x => x.key === key && x.sub === sub &&
                                  x.qty > 0);
  if (i < 0) return false;
  if (--p.pack[i].qty <= 0) p.pack.splice(i, 1);
  return true;
}

function doPickup() {
  const idx = G.items.findIndex(i => i.x === G.player.x && i.y === G.player.y);
  if (idx < 0) { logMsg("There is nothing here to pick up.", "dim"); return false; }
  const it = G.items[idx];
  const p = G.player;
  sfx("pickup");
  if (it.key === "chest") {
    // open the chest: each loot entry is handled as if the player
    // stepped onto it, then the chest itself is removed
    logMsg("You open the " + it.name + ".", "good");
    // any neutral guards watching THIS chest see the theft and rush
    let alerted = 0;
    for (const m of G.monsters) {
      if (m.neutral && m.guardsChest &&
          m.guardsChest.x === it.x && m.guardsChest.y === it.y) {
        m.neutral = false; m.awake = true; alerted++;
      }
    }
    if (alerted) {
      logMsg((alerted === 1 ? "The guard" : "The guards") +
             " rush you -- thief!", "bad");
    }
    // king's quest relic? drop a unique item into the player's pack.
    if (it.questRelic && it.questId) {
      G.player.pack.push({
        key: "quest_item", sub: it.questId, name: it.questRelic,
        questRelic: true, questId: it.questId, qty: 1,
      });
      logMsg("Among the spoils you find the " + it.questRelic +
             "!", "good");
      sfx("levelup");
    }
    G.items.splice(idx, 1);
    for (const lootItem of (it.loot || [])) {
      // pretend the loot is on the player's tile so doPickup picks it up
      lootItem.x = G.player.x;
      lootItem.y = G.player.y;
      G.items.push(lootItem);
      doPickup();
    }
    return true;
  }
  if (it.key === "corpse") {
    if (p.carriedBody) {
      logMsg("You already carry a body -- drop it first (D).", "dim");
      return false;
    }
    p.carriedBody = {
      name: it.name || ((it.corpseName || "thing") + "'s body"),
      corpseName: it.corpseName || null,
      tile: it.tile || null,
      fromKill: it.fromKill || null,
      wasNpc: !!it.wasNpc,
    };
    G.items.splice(idx, 1);
    logMsg("You hoist the " + p.carriedBody.name +
           " onto your shoulder.", "good");
    sfx("body");
    return true;
  }
  if (it.key === "gold") {
    p.gold += it.amount;
    logMsg("You pick up " + it.amount + " gold (" + p.gold + " total).", "good");
  } else if (POTION_FLAVOR[it.key]) {
    packAdd({ key: "potion", sub: it.key, name: it.name, qty: 1 });
    logMsg("You pick up a " + displayName(it) + ".", "good");
  } else if (it.key === "food") {
    packAdd({ key: "food", sub: it.sub, name: it.name, qty: 1 });
    logMsg("You pick up a " + it.name + ".", "good");
  } else if (it.key === "key") {
    packAdd({ key: "key", name: it.name, qty: 1 });
    logMsg("You pick up an iron key.", "good");
  } else if (it.key === "gem") {
    packAdd({ key: "gem", sub: it.sub, name: it.name,
              value: it.value, qty: 1 });
    logMsg("You pick up a " + it.name + " (" + it.value + " gp).", "good");
  } else if (it.key === "scroll") {
    packAdd({ key: "scroll", sub: it.scroll, name: it.name, qty: 1 });
    logMsg("You pick up a " + displayName(it) + ".", "good");
  } else if (it.key === "weapon" || it.key === "armour" ||
             it.key === "ring" || it.key === "wand") {
    // gear goes into the backpack -- equip it from the inventory (i)
    packAdd({ key: it.key, name: it.name, weapon: it.weapon,
              armour: it.armour, ring: it.ring, wand: it.wand });
    logMsg("You pick up the " + it.name +
           " and stow it in your pack. (open inventory with i)", "good");
  } else if (it.key === "missile") {
    if (p.quiver && p.quiver.name === it.missile.name) {
      p.quiver.count += it.count;
    } else {
      p.quiver = { name: it.missile.name, damage: it.missile.damage,
                   count: it.count };
    }
    logMsg("You pick up " + it.count + " " + it.missile.name + "s.", "good");
  }
  G.items.splice(idx, 1);
  return true;
}

/* put on a piece of body armour, replacing whatever was worn */
function wearArmour(armour) {
  const p = G.player;
  const old = p.armour ? armourLabel(p.armour) : null;
  p.armour = armour;
  logMsg("You don the " + armourLabel(armour) + " (AC " + armour.ac + ")" +
         (old ? ", dropping the " + old : "") + ".", "good");
}

/* put on a ring. Str/Dex rings adjust the stat directly; the old
 * ring's bonus (if any) is removed first so swapping is clean. */
function wearRing(ring) {
  const p = G.player;
  if (p.ring && p.ring.terse === "Str") p.str -= p.ring.plus;
  if (p.ring && p.ring.terse === "Dex") p.dex -= p.ring.plus;
  const old = p.ring ? p.ring.name : null;
  p.ring = ring;
  if (ring.terse === "Str") p.str += ring.plus;
  if (ring.terse === "Dex") p.dex += ring.plus;
  logMsg("You put on the ring of " + ring.name + " (+" + ring.plus + ")" +
         (old ? ", removing the ring of " + old : "") + ".", "good");
}

/* equip an item (weapon / armour / ring / wand); returns the gear it
 * displaced as a pack-shaped item, or null. Works on floor items and
 * pack items alike -- both carry {key, weapon|armour|ring|wand}. */
function equip(item) {
  const p = G.player;
  let displaced = null;
  if (item.key === "weapon") {
    if (p.weapon) {
      displaced = { key: "weapon", name: weaponLabel(p.weapon),
                    weapon: p.weapon };
    }
    p.weapon = item.weapon;
    logMsg("You wield the " + weaponLabel(item.weapon) + ".", "good");
  } else if (item.key === "armour") {
    if (p.armour) {
      displaced = { key: "armour", name: armourLabel(p.armour),
                    armour: p.armour };
    }
    wearArmour(item.armour);
  } else if (item.key === "ring") {
    if (p.ring) {
      displaced = { key: "ring", name: "ring of " + p.ring.name,
                    ring: p.ring };
    }
    wearRing(item.ring);
  } else if (item.key === "wand") {
    if (p.wand) {
      displaced = { key: "wand", name: "wand of " + p.wand.name,
                    wand: p.wand };
    }
    p.wand = item.wand;
    logMsg("You ready the wand of " + item.wand.name + " (" +
           item.wand.charges + " charges).", "good");
  }
  return displaced;
}

/* equip pack item #idx; whatever it replaces returns to the pack */
function equipFromPack(idx) {
  const p = G.player;
  const item = p.pack[idx];
  if (!item) return false;
  p.pack.splice(idx, 1);
  const displaced = equip(item);
  if (displaced) p.pack.push(displaced);
  return true;
}

/* use backpack item #idx in context: gear is equipped (a free menu
 * action), a potion / scroll is quaffed / read. Returns true if the
 * action spends a turn (i.e. a consumable was used). */
function useFromPack(idx) {
  const it = G.player.pack[idx];
  if (!it) return false;
  if (it.key === "potion") return quaff(it.sub);
  if (it.key === "scroll") return readScroll(it.sub);
  if (it.key === "food") return eatFood(idx);
  equipFromPack(idx);
  return false;
}

/* food values + restore amounts. Eat from pack -- one unit per use. */
const FOOD_RESTORE = { ration: 80, bread: 50, meat: 60, fruit: 25 };
function eatFood(idx) {
  const p = G.player;
  const it = p.pack[idx];
  if (!it || it.key !== "food") return false;
  const sub = it.sub || "ration";
  const restore = FOOD_RESTORE[sub] || 30;
  const before = p.food;
  p.food = Math.min(p.foodMax, p.food + restore);
  logMsg("You eat the " + (it.name || sub) + " (+" +
         (p.food - before) + " food).", "good");
  sfx("quaff");
  if (it.qty && it.qty > 1) it.qty--;
  else p.pack.splice(idx, 1);
  return true;
}

function quaff(kind) {
  const p = G.player;
  if (!POTION_FLAVOR[kind]) return false;
  if (!packTake("potion", kind)) {
    logMsg("You have no " + (POTION_FLAVOR[kind].name) + ".", "dim");
    return false;
  }
  if (kind === "heal") {
    const amt = Math.round(p.hpMax * 0.45) + ri(3, 9);
    p.hp = Math.min(p.hpMax, p.hp + amt);
    logMsg("You quaff a potion (+" + amt + " HP).", "good");
    if (p.poisonTurns > 0) {                 // healing purges poison
      p.poisonTurns = 0;
      logMsg("The healing draught flushes the poison from your veins.",
             "good");
    }
  } else if (kind === "might") {
    p.mightTurns += 25;
    logMsg("You feel mighty! (Your blows hit harder for a while.)", "good");
  } else if (kind === "haste") {
    p.hasteTurns += 25;
    logMsg("You feel yourself speed up!", "good");
  } else if (kind === "berserk") {
    p.berserkTurns += 22;
    logMsg("A red haze rises behind your eyes — you go berserk!", "good");
  } else if (kind === "magic") {
    const amt = Math.round(p.mpMax * 0.6) + 1;
    p.mp = Math.min(p.mpMax, p.mp + amt);
    logMsg("Magical energy floods you (+" + amt + " MP).", "good");
  } else if (kind === "cancel") {
    // wipe every active status, good and bad
    let wiped = 0;
    for (const k of ["mightTurns","berserkTurns","heroismTurns",
                     "hasteTurns","slowTurns","poisonTurns",
                     "paralyzedTurns","confusedTurns"]) {
      if (p[k] > 0) { p[k] = 0; wiped++; }
    }
    logMsg("A cool calm settles — every effect on you fades" +
           (wiped ? "." : ", though there was nothing to wipe."), "good");
  }
  identifyConsumable("potion", kind);     // ID-by-use
  sfx("quaff");
  return true;
}

/* read a scroll. Both scroll effects are self / area cast -- no
 * targeting -- so they fit the game's input model cleanly. */
function readScroll(kind) {
  const p = G.player;
  if (!SCROLL_FLAVOR[kind]) return false;
  if (!packTake("scroll", kind)) {
    logMsg("You have no " + SCROLL_FLAVOR[kind].name + ".", "dim");
    return false;
  }
  identifyConsumable("scroll", kind);     // reading a scroll IDs it
  if (kind === "teleport") {
    const spots = [];
    for (let y = 1; y < MAP_H - 1; y++) {
      for (let x = 1; x < MAP_W - 1; x++) {
        if (G.level.tiles[y][x] !== T.FLOOR) continue;
        if (Math.max(Math.abs(x - p.x), Math.abs(y - p.y)) < 9) continue;
        if (G.monsters.some(m => m.x === x && m.y === y)) continue;
        spots.push([x, y]);
      }
    }
    if (spots.length) {
      const [tx, ty] = pick(spots);
      p.x = tx; p.y = ty;
      logMsg("You read a scroll of teleportation. " +
             "The world warps around you!", "warn");
      computeFOV();
    } else {
      logMsg("You read a scroll of teleportation, but nothing happens.",
             "dim");
    }
    return true;
  }
  if (kind === "fear") {
    let n = 0;
    for (const m of G.monsters) {
      if (!G.visible[m.y][m.x]) continue;
      m.feared = ri(10, 16);
      m.awake = true;
      n++;
    }
    logMsg("You read a scroll of fear." + (n
      ? " " + n + " monster" + (n > 1 ? "s" : "") +
        " recoil" + (n > 1 ? "" : "s") + " in terror!"
      : " Nothing nearby is afraid."), "warn");
    return true;
  }
  if (kind === "mapping") {
    for (let y = 0; y < MAP_H; y++) G.seen[y].fill(true);
    // and reveal known-trap markers
    for (const t of (G.level.traps || [])) t.known = true;
    logMsg("The scroll's map of the dungeon floor unfolds in your mind!",
           "good");
    return true;
  }
  if (kind === "noise") {
    let n = 0;
    for (const m of G.monsters) if (!m.awake) { m.awake = true; n++; }
    logMsg("A piercing shriek echoes from the scroll — " + n +
           " monster" + (n === 1 ? "" : "s") + " stir.", "warn");
    return true;
  }
  return false;
}

/* cast a spell the player knows. Damage spells auto-target the
 * nearest monster in sight (no targeting UI); Blink self-casts.
 * Returns true if a turn was spent. */
function castSpell(id) {
  const p = G.player;
  if (!p.spells.includes(id)) return false;
  const spell = spellById(id);
  const eff = SPELL_EFFECTS[id];
  if (!spell || !eff) return false;
  // Vehumet eases the MP cost of magic
  const cost = Math.max(1, spell.mp - (p.god === "GOD_VEHUMET" ? 1 : 0));
  if (p.mp < cost) {
    logMsg("You lack the magic to cast " + spell.title +
           " (need " + cost + " MP).", "dim");
    return false;
  }
  sfx("cast");
  // Trog detests spellcasting and docks piety for it
  if (p.god === "GOD_TROG" && p.piety > 0) {
    p.piety = Math.max(0, p.piety - 8);
    logMsg("Trog is displeased by your use of magic.", "bad");
  }

  if (eff.kind === "bolt") {
    const best = nearestVisibleMonster();
    if (!best) {
      logMsg("There is nothing in sight to aim " + spell.title + " at.",
             "dim");
      return false;
    }
    p.mp -= cost;
    // spell power scales with Intelligence and experience level
    let dam = (id === "SPELL_THROW_FLAME")
      ? roll(2, 4 + Math.floor(p.int / 2) + p.xl)
      : roll(1, 3 + Math.floor(p.int / 3) + Math.floor(p.xl / 2));
    dam = applyAC(dam, best.ac);
    best.hp -= dam;
    logMsg("You cast " + spell.title + " at the " + best.name +
           " (" + dam + ").", "good");
    if (best.hp <= 0) {
      logMsg("You kill the " + best.name + "!", "good");
      killMonster(best);
    }
    return true;
  }

  if (eff.kind === "blink") {
    const spots = [];
    for (let y = Math.max(1, p.y - 4); y <= Math.min(MAP_H - 2, p.y + 4); y++) {
      for (let x = Math.max(1, p.x - 4); x <= Math.min(MAP_W - 2, p.x + 4); x++) {
        if (x === p.x && y === p.y) continue;
        if (!passable(G.level, x, y)) continue;
        if (G.monsters.some(m => m.x === x && m.y === y)) continue;
        spots.push([x, y]);
      }
    }
    if (!spots.length) {
      logMsg("There is nowhere to blink to.", "dim");
      return false;
    }
    p.mp -= cost;
    const [tx, ty] = pick(spots);
    p.x = tx; p.y = ty;
    logMsg("You cast Blink and flicker a short way away.", "good");
    computeFOV();
    return true;
  }
  // a freezing bolt -- normal bolt damage + a chance to slow the target
  if (eff.kind === "bolt_cold") {
    const best = nearestVisibleMonster();
    if (!best) { logMsg("Nothing in sight to chill.", "dim"); return false; }
    p.mp -= cost;
    let dam = roll(1, 4 + Math.floor(p.int / 2) + Math.floor(p.xl / 2));
    dam = applyAC(dam, best.ac);
    best.hp -= dam;
    logMsg("You cast " + spell.title + " at the " + best.name +
           " (" + dam + ").", "good");
    if (best.hp <= 0) { logMsg("It freezes solid!", "good"); killMonster(best); }
    else if (chance(0.5)) {
      best.slowedTurns = Math.max(best.slowedTurns || 0, ri(6, 10));
      logMsg("The " + best.name + " is slowed by cold.", "good");
    }
    return true;
  }
  // a heavier conjuration -- ~1.6x bolt damage, but the MP cost is
  // already higher via the spell's level
  if (eff.kind === "bolt_big") {
    const best = nearestVisibleMonster();
    if (!best) { logMsg("Nothing in sight.", "dim"); return false; }
    p.mp -= cost;
    let dam = roll(2, 4 + Math.floor(p.int / 2) + p.xl);
    dam = applyAC(dam, best.ac);
    best.hp -= dam;
    logMsg("You cast " + spell.title + " at the " + best.name +
           " (" + dam + ").", "good");
    if (best.hp <= 0) {
      logMsg("You kill the " + best.name + "!", "good");
      killMonster(best);
    }
    return true;
  }
  // an area conjuration -- damages every monster within 1 tile of the
  // primary target (a small fireball)
  if (eff.kind === "area") {
    const best = nearestVisibleMonster();
    if (!best) { logMsg("Nothing in sight to ignite.", "dim"); return false; }
    p.mp -= cost;
    const cx = best.x, cy = best.y;
    let killed = 0, hit = 0;
    for (const m of [...G.monsters]) {
      if (Math.abs(m.x - cx) > 1 || Math.abs(m.y - cy) > 1) continue;
      let dam = roll(1, 4 + Math.floor(p.int / 2) + Math.floor(p.xl / 2));
      dam = applyAC(dam, m.ac);
      m.hp -= dam;
      hit++;
      if (m.hp <= 0) { killMonster(m); killed++; }
    }
    logMsg("You cast " + spell.title + " — it engulfs " + hit +
           " creature" + (hit === 1 ? "" : "s") +
           (killed ? ", killing " + killed : "") + ".", "good");
    return true;
  }
  // a hex that slows the target (mon.slowedTurns ticks in endTurn)
  if (eff.kind === "hex_slow") {
    const best = nearestVisibleMonster();
    if (!best) { logMsg("Nothing in sight to hex.", "dim"); return false; }
    p.mp -= cost;
    best.slowedTurns = Math.max(best.slowedTurns || 0, ri(8, 14));
    logMsg("You cast Slow — the " + best.name + " staggers.", "good");
    return true;
  }
  // a hex that confuses the target
  if (eff.kind === "hex_confuse") {
    const best = nearestVisibleMonster();
    if (!best) { logMsg("Nothing in sight to bewilder.", "dim"); return false; }
    p.mp -= cost;
    best.confusedTurns = Math.max(best.confusedTurns || 0, ri(6, 12));
    logMsg("You cast " + spell.title + " — the " + best.name +
           " looks dazed.", "good");
    return true;
  }
  // a self-buff -- the air-elementalist swiftness
  if (eff.kind === "self_haste") {
    p.mp -= cost;
    p.hasteTurns = Math.max(p.hasteTurns || 0, 15);
    logMsg("You cast " + spell.title + " — quickening yourself.", "good");
    return true;
  }
  return false;
}

/* evoke the held wand at the nearest monster in sight. Returns true
 * if a turn was spent. */
function evokeWand() {
  const p = G.player;
  if (!p.wand) { logMsg("You have no wand to evoke.", "dim"); return false; }
  const eff = WAND_EFFECTS[p.wand.kind];
  if (!eff) { logMsg("Nothing happens.", "dim"); return false; }
  const target = nearestVisibleMonster();
  if (!target) {
    logMsg("There is nothing in sight to aim the wand at.", "dim");
    return false;
  }
  sfx("cast");
  p.wand.charges--;
  if (eff.kind === "damage") {
    let dam = roll(eff.dice, eff.base + Math.floor(effectiveDepth() / 2));
    dam = applyAC(dam, target.ac);
    target.hp -= dam;
    logMsg("You evoke the wand of " + p.wand.name + " at the " +
           target.name + " (" + dam + ").", "good");
    if (target.hp <= 0) {
      logMsg("You kill the " + target.name + "!", "good");
      killMonster(target);
    }
  } else if (eff.kind === "paralyse") {
    target.paralysed = ri(4, 8);
    target.awake = true;
    logMsg("You evoke the wand of paralysis. The " + target.name +
           " freezes in place!", "good");
  }
  if (p.wand.charges <= 0) {
    logMsg("The wand of " + p.wand.name + " crumbles to dust.", "dim");
    p.wand = null;
  }
  return true;
}

/* throw one weapon from the quiver at the nearest monster in sight. */
function throwMissile() {
  const p = G.player;
  if (!p.quiver || p.quiver.count <= 0) {
    logMsg("You have nothing to throw.", "dim");
    return false;
  }
  const target = nearestVisibleMonster();
  if (!target) {
    logMsg("There is nothing in sight to throw at.", "dim");
    return false;
  }
  sfx("cast");
  p.quiver.count--;
  const name = p.quiver.name;
  if (!attackRoll(playerToHit(p), target.ev + 1)) {
    logMsg("You throw a " + name + " at the " + target.name +
           ", but miss.", "dim");
  } else {
    let dam = roll(1, p.quiver.damage) +
              Math.floor(p.dex / 4) + Math.floor(p.xl / 2);
    dam = applyAC(dam, target.ac);
    target.hp -= dam;
    logMsg("You throw a " + name + " at the " + target.name +
           " (" + dam + ").", "good");
    if (target.hp <= 0) {
      logMsg("You kill the " + target.name + "!", "good");
      killMonster(target);
    }
  }
  if (p.quiver.count <= 0) {
    logMsg("That was your last " + name + ".", "dim");
    p.quiver = null;
  }
  return true;
}

/* =============================================================
 * Religion -- worship a god at an altar, build piety from kills,
 * and call on the god's ability.
 * ============================================================= */

function gainPiety(amount) {
  if (G.player.god) {
    G.player.piety = Math.min(200, G.player.piety + amount);
  }
}

/* pray at the altar underfoot to join its god */
function prayAtAltar() {
  const p = G.player;
  if (G.level.tiles[p.y][p.x] !== T.ALTAR) {
    logMsg("You are not standing at an altar.", "dim");
    return false;
  }
  if (p.god) {
    logMsg("You already follow " + godName(p.god) + ".", "dim");
    return false;
  }
  const god = G.level.altarGod;
  const eff = god && GOD_EFFECTS[god];
  if (!eff) {
    logMsg("This altar's god is beyond your understanding.", "dim");
    return false;
  }
  p.god = god;
  p.piety = 30;
  logMsg("You kneel and dedicate yourself to " + godName(god) + ".", "good");
  logMsg(eff.passive, "sys");
  logMsg("Call on " + godName(god) + " with 'a' (" + eff.ability.name +
         ", " + eff.ability.piety + " piety).", "sys");
  sfx("levelup");
  return true;
}

/* invoke the worshipped god's ability, paid for with piety */
function invokeAbility() {
  const p = G.player;
  if (!p.god) { logMsg("You have no god to call upon.", "dim"); return false; }
  const eff = GOD_EFFECTS[p.god];
  if (!eff) return false;
  const ab = eff.ability;
  if (p.piety < ab.piety) {
    logMsg(godName(p.god) + " withholds " + ab.name + " (need " +
           ab.piety + " piety, you have " + p.piety + ").", "dim");
    return false;
  }
  switch (p.god) {
    case "GOD_TROG":
      p.berserkTurns += 22;
      logMsg("You go berserk in Trog's name!", "good");
      break;
    case "GOD_OKAWARU":
      p.heroismTurns += 24;
      logMsg("Okawaru fills you with heroism!", "good");
      break;
    case "GOD_MAKHLEB":
    case "GOD_VEHUMET": {
      const tgt = nearestVisibleMonster();
      if (!tgt) {
        logMsg("There is nothing in sight to strike.", "dim");
        return false;
      }
      let dam = applyAC(roll(3, 5 + Math.floor(p.xl / 2)), tgt.ac);
      tgt.hp -= dam;
      logMsg("You unleash " + ab.name + " on the " + tgt.name +
             " (" + dam + ").", "good");
      if (tgt.hp <= 0) {
        logMsg("You kill the " + tgt.name + "!", "good");
        killMonster(tgt);
      }
      break;
    }
    case "GOD_ELYVILON": {
      const amt = Math.round(p.hpMax * 0.40) + ri(4, 10);
      p.hp = Math.min(p.hpMax, p.hp + amt);
      logMsg("Elyvilon's grace heals you (+" + amt + " HP).", "good");
      break;
    }
    case "GOD_SHINING_ONE": {
      let n = 0;
      for (const m of G.monsters.slice()) {
        if (!G.visible[m.y][m.x]) continue;
        m.hp -= applyAC(roll(2, 6 + effectiveDepth()), m.ac);
        n++;
        if (m.hp <= 0) killMonster(m);
      }
      logMsg("Cleansing flame scours " + n + " foe" +
             (n !== 1 ? "s" : "") + "!", n ? "good" : "dim");
      break;
    }
    case "GOD_KIKUBAAQUDGHA": {
      const tgt = nearestVisibleMonster();
      if (!tgt) { logMsg("Nothing in sight to wrack.", "dim"); return false; }
      const dam = applyAC(roll(2, 6 + Math.floor(p.xl / 2)), tgt.ac);
      tgt.hp -= dam;
      logMsg("You wrack the " + tgt.name + " with Pain (" + dam + ").",
             "good");
      if (tgt.hp <= 0) {
        logMsg("You kill the " + tgt.name + "!", "good");
        killMonster(tgt);
      }
      break;
    }
    case "GOD_SIF_MUNA": {
      const amt = Math.round(p.mpMax * 0.7) + 1;
      p.mp = Math.min(p.mpMax, p.mp + amt);
      logMsg("Sif Muna's font refills your magic (+" + amt + " MP).",
             "good");
      break;
    }
    case "GOD_ASHENZARI": {
      // reveal the floor for a moment
      for (let y = 0; y < MAP_H; y++) G.seen[y].fill(true);
      logMsg("Ashenzari's bound sight pierces the dungeon's veil.", "good");
      break;
    }
    default:
      return false;
  }
  p.piety -= ab.piety;
  sfx("cast");
  return true;
}

/* enter the indoor floor of the given building at floor delta (+1 for
 * upper, -1 for cellar). Remembers the Surface cell so returning lands
 * the player on the same stair tile that was used to leave. */
function enterIndoors(b, floor) {
  const bidx = (G.level.buildings || []).indexOf(b);
  if (bidx < 0) return false;
  G.surfaceReturn = {
    cx: G.surfaceCoord.cx, cy: G.surfaceCoord.cy,
    x: G.player.x, y: G.player.y, bidx,
  };
  const coord = { cx: G.surfaceCoord.cx, cy: G.surfaceCoord.cy,
                  bidx, floor,
                  // pass the surface stair cell as returnAt so the
                  // indoor level mirrors it as the return-stair
                  returnAt: { x: G.player.x, y: G.player.y } };
  // enterLevel updates G.indoorFloor from coord.floor after stashing
  // the leaving level (which depends on the OLD G.indoorFloor)
  const arrive = floor > 0 ? "down" : "up";
  enterLevel("Indoors", 1, arrive, coord);
  logMsg(floor < 0 ? "You descend into the cellar."
                    : "You climb to the upper floor.", "sys");
  sfx("descend");
  return true;
}

/* take a single staircase step in an indoor sub-level: delta = +1 means
 * "up one floor", -1 means "down one floor". When the new floor would
 * be 0 the player emerges back onto the Surface chunk. */
function stepIndoorFloor(delta) {
  const here = G.indoorFloor || -1;
  const next = here + delta;
  if (next === 0) {
    // emerge to the Surface at the cell we originally left from.
    // Don't pre-set G.indoorFloor here -- enterLevel uses its OLD value
    // to stash the leaving indoor level under the right key, then sets
    // it to 0 itself when entering the Surface branch.
    const ret = G.surfaceReturn ||
                { cx: G.surfaceCoord.cx, cy: G.surfaceCoord.cy, x: 0, y: 0 };
    enterLevel("Surface", 1, "cell:" + ret.x + "," + ret.y,
               { cx: ret.cx, cy: ret.cy });
    G.surfaceReturn = null;
    logMsg("You step back onto the surface.", "sys");
    sfx("descend");
    return true;
  }
  // chain to a deeper / higher indoor floor in the same building.
  // CRUCIAL: leave G.indoorFloor at `here` so enterLevel stashes the
  // current level under its OWN key, not under the next floor's key.
  // enterLevel will then bump G.indoorFloor to coord.floor itself.
  const bidx = G.surfaceReturn ? G.surfaceReturn.bidx : 0;
  const coord = {
    cx: (G.surfaceReturn ? G.surfaceReturn.cx : G.surfaceCoord.cx),
    cy: (G.surfaceReturn ? G.surfaceReturn.cy : G.surfaceCoord.cy),
    bidx, floor: next,
    // remember the cell we stepped off so the new level lands us
    // back on it (mirror traversal -- round-trip stable)
    returnAt: { x: G.player.x, y: G.player.y },
  };
  const arrive = delta > 0 ? "down" : "up";
  enterLevel("Indoors", 1, arrive, coord);
  logMsg(delta > 0
    ? "You climb to a higher floor."
    : "You descend to a deeper cellar.", "sys");
  sfx("descend");
  return true;
}

/* step one floor up or down inside a Castle interior, keeping the
 * same (icx, icy) interior chunk coord. Mirrors stepIndoorFloor. */
function stepCastleFloor(delta) {
  if (!G.castleCoord) return false;
  const here = G.indoorFloor | 0;
  const next = here + delta;
  const cc = G.castleCoord;
  const coord = {
    sx: cc.sx, sy: cc.sy,
    icx: cc.icx, icy: cc.icy,
    floor: next,
    returnAt: { x: G.player.x, y: G.player.y },
  };
  const arrive = delta > 0 ? "down" : "up";
  enterLevel("Castle", 1, arrive, coord);
  logMsg(delta > 0
    ? "You climb to a higher floor of the castle."
    : "You descend deeper into the castle.", "sys");
  sfx("descend");
  return true;
}

function tryDescend() {
  const t = G.level.tiles[G.player.y][G.player.x];
  if (t === T.STAIRS_DOWN) {
    // a stair inside a Surface building enters its cellar (floor -1)
    if (G.branch === "Surface") {
      const b = buildingAt(G.level, G.player.x, G.player.y);
      if (b) { enterIndoors(b, -1); return true; }
    }
    // a stair on an indoor floor takes you one floor lower; floor 0
    // returns you to the Surface on the cell you originally took
    if (G.branch === "Indoors") { stepIndoorFloor(-1); return true; }
    // a stair inside a Castle interior chunk steps down one floor in
    // the same (icx, icy) interior coord
    if (G.branch === "Castle") { stepCastleFloor(-1); return true; }
    enterLevel(G.branch, G.depth + 1, "up");
    logMsg("You descend to " + levelLabel(G.branch, G.depth) + ".", "sys");
    sfx("descend");
    return true;
  }
  if (t === T.BRANCH) {
    const e = (G.level.entrances || []).find(
      en => en.x === G.player.x && en.y === G.player.y);
    if (!e) { logMsg("There is no passage here.", "dim"); return false; }
    G.branchReturn[e.branch] = {
      branch: G.branch, depth: G.depth,
      coord: G.surfaceCoord ? Object.assign({}, G.surfaceCoord) : null,
    };
    enterLevel(e.branch, 1, "up");
    logMsg("You enter the " + BRANCHES[e.branch].name + ".", "sys");
    sfx("descend");
    return true;
  }
  logMsg("There are no down stairs here.", "dim");
  return false;
}

function tryAscend() {
  const t = G.level.tiles[G.player.y][G.player.x];
  if (t !== T.STAIRS_UP) {
    logMsg("There are no up stairs here.", "dim");
    return false;
  }
  // a stair inside a Surface building enters the upper floor (+1)
  if (G.branch === "Surface") {
    const b = buildingAt(G.level, G.player.x, G.player.y);
    if (b) { enterIndoors(b, +1); return true; }
  }
  // a stair on an indoor floor takes you one floor higher
  if (G.branch === "Indoors") { stepIndoorFloor(+1); return true; }
  // a stair in a Castle steps up one interior floor
  if (G.branch === "Castle") { stepCastleFloor(+1); return true; }
  if (G.depth > 1) {
    enterLevel(G.branch, G.depth - 1, "down");
    logMsg("You climb to " + levelLabel(G.branch, G.depth) + ".", "sys");
    sfx("descend");
    return true;
  }
  // depth 1: emerge to the parent branch (Surface for the Dungeon /
  // Ruin, Dungeon for the side-branches), via remembered branchReturn
  const from = G.branch;
  const parent = BRANCHES[from].parent;
  if (!parent) {
    logMsg("There is nothing above the surface.", "dim");
    return false;
  }
  const ret = G.branchReturn[from] ||
              { branch: parent, depth: 1, coord: { cx: 0, cy: 0 } };
  enterLevel(ret.branch, ret.depth, "branch:" + from, ret.coord);
  logMsg("You climb out of the " + BRANCHES[from].name + " into the " +
         levelLabel(G.branch, G.depth) + ".", "sys");
  // if this is the first time emerging onto the Surface, hint that the
  // world keeps going past the screen
  if (G.branch === "Surface" && !G._sawSurfaceHint) {
    G._sawSurfaceHint = true;
    logMsg("The land stretches in every direction — walk off any " +
           "edge to cross into the next part of the world.", "warn");
  }
  sfx("descend");
  return true;
}

/* =============================================================
 * Monster AI -- wake on sight, walk toward the player, attack
 * when adjacent. Greedy step with light obstacle avoidance.
 * ============================================================= */

function monsterAct(mon) {
  const p = G.player;
  // neutral guards / watchmen wander idly and never pursue the player.
  // They turn hostile only via playerAttack (struck), chest theft, or
  // discovering a murdered NPC's body in their line of sight.
  if (mon.neutral) {
    // first: scan visible corpses for evidence of murder. A guard
    // catching sight of a `wasNpc` body raises the alarm: it turns
    // hostile, wakes, and all guards in the same squad follow suit.
    for (const it of (G.items || [])) {
      if (it.key !== "corpse" || !it.wasNpc) continue;
      const d = Math.max(Math.abs(it.x - mon.x), Math.abs(it.y - mon.y));
      if (d > FOV_RADIUS) continue;
      if (!losClear(G.level, mon.x, mon.y, it.x, it.y)) continue;
      mon.neutral = false; mon.awake = true;
      logMsg("The " + mon.name + " sees " + (it.name || "a body") +
             " -- MURDER! Guards close in!", "bad");
      sfx("alert");
      flashDamage();
      // alert other neutrals in the same chest watch / patrol
      for (const o of G.monsters) {
        if (o === mon || !o.neutral) continue;
        if (o.guardsChest && mon.guardsChest &&
            o.guardsChest.x === mon.guardsChest.x &&
            o.guardsChest.y === mon.guardsChest.y) {
          o.neutral = false; o.awake = true;
        } else if (Math.max(Math.abs(o.x - mon.x),
                            Math.abs(o.y - mon.y)) <= FOV_RADIUS) {
          // nearby guards hear the shout
          o.neutral = false; o.awake = true;
        }
      }
      return;  // guard spent its turn raising the alarm
    }
    // mostly stand still; sometimes take a step in a random cardinal
    if (chance(0.6)) return;
    const DIRS = [[1,0],[-1,0],[0,1],[0,-1]];
    const d = pick(DIRS);
    const nx = mon.x + d[0], ny = mon.y + d[1];
    if (passable(G.level, nx, ny) && !entityAt(nx, ny) &&
        !(G.player.x === nx && G.player.y === ny)) {
      mon.x = nx; mon.y = ny;
    }
    return;
  }
  // a confused monster wanders -- half the time it stumbles instead of
  // taking its proper turn
  if (mon.confusedTurns > 0 && chance(0.5)) {
    const d = pick([[1,0],[-1,0],[0,1],[0,-1],
                    [1,1],[1,-1],[-1,1],[-1,-1]]);
    const nx = mon.x + d[0], ny = mon.y + d[1];
    if (passable(G.level, nx, ny) && !entityAt(nx, ny)) {
      mon.x = nx; mon.y = ny;
    }
    return;
  }
  const dist = Math.max(Math.abs(mon.x - p.x), Math.abs(mon.y - p.y));
  if (!mon.awake) {
    if (dist <= FOV_RADIUS && G.visible[mon.y][mon.x]) {
      // a stealthed player must roll past the wake check, too
      if (p.stealthed) {
        const fc = stealthFailChance(p, mon, dist);
        if (!chance(fc)) return;        // monster fails to notice
        breakStealth("The " + mon.name + " spots you! You reappear.");
      }
      mon.awake = true;
      if (G.visible[mon.y][mon.x]) {
        logMsg("The " + mon.name + " notices you.", "warn");
      }
    } else {
      return;
    }
  }
  // a paralysed monster (wand of paralysis) can do nothing
  if (mon.paralysed > 0) {
    mon.paralysed--;
    return;
  }
  // a feared monster (scroll of fear) flees instead of fighting
  if (mon.feared > 0) {
    mon.feared--;
    const fx = -Math.sign(p.x - mon.x), fy = -Math.sign(p.y - mon.y);
    for (const [dx, dy] of [[fx, fy], [fx, 0], [0, fy],
                            [fx, fy === 0 ? 1 : fy], [fx, fy === 0 ? -1 : fy]]) {
      if (dx === 0 && dy === 0) continue;
      const nx = mon.x + dx, ny = mon.y + dy;
      if (!passable(G.level, nx, ny)) continue;
      if (entityAt(nx, ny)) continue;
      mon.x = nx; mon.y = ny;
      return;
    }
    return;            // cornered: cower in place
  }
  const hasMelee = mon.def.attacks && mon.def.attacks.length > 0;
  // a ranged caster fires a bolt when it can see the player -- but
  // only some turns (a spell-frequency analogue), so the player gets
  // room to close in or take cover rather than being bolted every turn
  if (mon.def.ranged && dist >= 2 && dist <= FOV_RADIUS + 2 &&
      chance(0.55) && losClear(G.level, mon.x, mon.y, p.x, p.y)) {
    monsterBolt(mon);
    return;
  }
  if (dist === 1) {
    if (hasMelee) monsterAttack(mon);
    else monsterBolt(mon);       // a ranged-only caster zaps point-blank
    return;
  }
  // step toward player
  const sx = Math.sign(p.x - mon.x);
  const sy = Math.sign(p.y - mon.y);
  const tries = [
    [sx, sy], [sx, 0], [0, sy],
    [sx, sy === 0 ? (chance(0.5) ? 1 : -1) : sy],
    [sx === 0 ? (chance(0.5) ? 1 : -1) : sx, sy],
  ];
  for (const [dx, dy] of tries) {
    if (dx === 0 && dy === 0) continue;
    const nx = mon.x + dx, ny = mon.y + dy;
    if (nx === p.x && ny === p.y) { monsterAttack(mon); return; }
    // a closed door on the way toward the player gets opened
    if (G.level.tiles[ny] && G.level.tiles[ny][nx] === T.DOOR) {
      G.level.tiles[ny][nx] = T.DOOR_OPEN;
      if (G.visible[ny][nx]) {
        logMsg("The " + mon.name + " opens a door.", "dim");
      }
      return;
    }
    if (!passable(G.level, nx, ny)) continue;
    if (entityAt(nx, ny)) continue;
    mon.x = nx; mon.y = ny;
    return;
  }
}

/* =============================================================
 * Turn scheduler -- energy based. Player speed 10; monster speed
 * from the export (monster_defs.speed). Faster monsters act more
 * often.
 * ============================================================= */

function runWorld() {
  // Hand out energy until the player can act again; monsters that
  // reach 100 energy act in between.
  let safety = 0;
  while (!G.over && safety++ < 5000) {
    // slow / haste scale the player's energy gain
    const pp = G.player;
    const sp = pp.slowTurns > 0 ? pp.speed * 0.5
             : pp.hasteTurns > 0 ? pp.speed * 1.5
             : pp.speed;
    pp.energy += sp;
    for (const m of G.monsters) {
      // a hexed monster gains energy at half rate -- it acts less often
      m.energy += m.speed * (m.slowedTurns > 0 ? 0.5 : 1);
    }
    // monsters act
    for (const m of [...G.monsters]) {
      while (m.energy >= 100 && !G.over) {
        m.energy -= 100;
        if (G.monsters.includes(m)) monsterAct(m);
      }
    }
    if (G.player.energy >= 100) {
      // paralysis: the player burns a turn doing nothing and the
      // monsters keep gaining energy. Capped via paralyzedTurns.
      if (G.player.paralyzedTurns > 0) {
        G.player.paralyzedTurns--;
        G.player.energy = 0;
        if (G.player.paralyzedTurns === 0) {
          logMsg("You can move again.", "good");
        }
        continue;
      }
      G.player.energy -= 100;
      break;
    }
  }
}

/* called after every player action that consumes a turn */
function endTurn() {
  if (G.over) { render(); return; }
  const prevPhase = timeOfDay().phase;
  G.turn++;
  const newPhase = timeOfDay().phase;
  if (newPhase !== prevPhase && G && isOutdoors(G.branch)) {
    const TRANSITION_MSG = {
      dawn:  "Dawn breaks. Pale light reaches you.",
      day:   "The sun climbs high.",
      dusk:  "Dusk pools in the shadows.",
      night: "Night closes in. Stay sharp.",
    };
    logMsg(TRANSITION_MSG[newPhase] || ("The light shifts to " + newPhase + "."),
           "sys");
  }
  const pp = G.player;
  if (pp.mightTurns > 0) {
    pp.mightTurns--;
    if (pp.mightTurns === 0) logMsg("Your might fades.", "dim");
  }
  if (pp.berserkTurns > 0) {
    pp.berserkTurns--;
    if (pp.berserkTurns === 0) logMsg("Your berserk rage subsides.", "dim");
  }
  if (pp.heroismTurns > 0) {
    pp.heroismTurns--;
    if (pp.heroismTurns === 0) logMsg("Your heroism fades.", "dim");
  }
  if (pp.slowTurns > 0) {
    pp.slowTurns--;
    if (pp.slowTurns === 0) logMsg("You feel quicker again.", "good");
  }
  if (pp.hasteTurns > 0) {
    pp.hasteTurns--;
    if (pp.hasteTurns === 0) logMsg("You feel yourself slow down.", "dim");
  }
  if (pp.poisonTurns > 0) {
    pp.poisonTurns--;
    if (G.turn % 3 === 0 && pp.hp > 1) {     // poison hurts but won't kill
      pp.hp = Math.max(1, pp.hp - 1);
      logMsg("You feel sick from the poison.", "bad");
    }
    if (pp.poisonTurns === 0) logMsg("You recover from the poison.", "good");
  }
  if (pp.confusedTurns > 0) {
    pp.confusedTurns--;
    if (pp.confusedTurns === 0) logMsg("Your head clears.", "good");
  }
  if (pp.stealthCD > 0) pp.stealthCD--;
  // night raid roll -- a wandering hostile drifts to the home chunk
  maybeNightRaid();
  // stealth maintenance: while sneaking, every nearby visible monster
  // gets a per-turn chance to detect us. Distance and HD swing the
  // odds.  First detection wins -- stealth breaks and that monster
  // becomes aware.
  if (pp.stealthed) {
    for (const m of G.monsters) {
      if (!m || m.neutral) continue;
      const dist = Math.max(Math.abs(m.x - pp.x), Math.abs(m.y - pp.y));
      if (dist > FOV_RADIUS) continue;
      if (!G.visible[m.y] || !G.visible[m.y][m.x]) continue;
      const fc = stealthFailChance(pp, m, dist);
      if (chance(fc)) {
        m.awake = true;
        breakStealth("The " + m.name + " spots you! You reappear.");
        break;
      }
    }
  }
  // monsters carry their own statuses too
  for (const m of [...G.monsters]) {
    if (m.poisonTurns > 0) {
      m.poisonTurns--;
      if (G.turn % 3 === 0 && m.hp > 0) {
        m.hp -= 1;
        if (m.hp <= 0) {
          logMsg("The " + m.name + " succumbs to the poison.", "good");
          killMonster(m);
        }
      }
    }
    if (m.slowedTurns > 0) m.slowedTurns--;
    if (m.confusedTurns > 0) m.confusedTurns--;
  }
  // light natural regeneration -- HP and MP. Elyvilon quickens it;
  // a Troll's innate vigour quickens it far more.
  const regenEvery = traitIs(pp, "regen") ? 3
    : (pp.god === "GOD_ELYVILON") ? 6 : 10;
  if (G.turn % regenEvery === 0 && pp.hp < pp.hpMax) {
    pp.hp = Math.min(pp.hpMax, pp.hp + (traitIs(pp, "regen") ? 2 : 1));
  }
  // Sif Muna gives faster MP regeneration to her faithful
  const mpEvery = (pp.god === "GOD_SIF_MUNA") ? 8 : 14;
  if (G.turn % mpEvery === 0 && G.player.mp < G.player.mpMax) {
    G.player.mp = Math.min(G.player.mpMax, G.player.mp + 1);
  }
  // hunger: every 8 turns the player burns one food unit. At zero,
  // starvation chews on HP every 4 turns and threshold log lines warn
  // the player as they cross from Full -> Hungry -> Starving -> Dying.
  if (pp.foodMax > 0) {
    const before = pp.food;
    if (G.turn % 8 === 0 && pp.food > 0) pp.food = Math.max(0, pp.food - 1);
    const thresholds = [
      { at: 100, msg: "You are getting hungry.",  cls: "warn" },
      { at: 30,  msg: "You are HUNGRY!",          cls: "bad" },
      { at: 0,   msg: "You are STARVING!",        cls: "bad" },
    ];
    for (const th of thresholds) {
      if (before > th.at && pp.food <= th.at) {
        logMsg(th.msg, th.cls);
        break;
      }
    }
    if (pp.food === 0 && G.turn % 4 === 0 && pp.hp > 0) {
      pp.hp = Math.max(0, pp.hp - 1);
      if (pp.hp === 0) {
        logMsg("You starve to death.", "bad");
        gameOver(false, "starvation");
      }
    }
  }
  runWorld();
  // friendly NPCs amble around their building -- a small step every
  // few turns gives towns / houses a sense of life, without making
  // them dart out of reach mid-conversation
  if (G.turn % 3 === 0) {
    for (const n of (G.npcs || [])) npcWander(n);
  }
  // ambient banter -- pick a random visible NPC and put a line above
  // their head (or echo their first authored dialog line)
  tickNpcBarks();
  computeFOV();
  render();
  // persist the run every few turns so a closed tab can be resumed
  if (G.turn % 6 === 0) saveGame();
}

/* =============================================================
 * Win / lose
 * ============================================================= */

function gameOver(won, killer) {
  const pl = G.player;
  // Felid: a spare life -- rise once instead of dying
  if (!won && pl && traitIs(pl, "ninelives") && !pl.trait.used) {
    pl.trait.used = true;
    pl.hp = Math.max(1, Math.round(pl.hpMax / 2));
    logMsg("You die... but feline luck flares — you spring back to life!",
           "warn");
    sfx("quaff");
    return;
  }
  G.over = true;
  G.won = won;
  // halt the real-time tick so it doesn't keep advancing the world
  // while the death / win screen is showing
  if (realtimeIntervalId) {
    clearInterval(realtimeIntervalId);
    realtimeIntervalId = null;
  }
  // a corpse the player was carrying drops at their feet on death --
  // a small atmospheric touch for the post-mortem
  if (!won && pl && pl.carriedBody && G.items && G.level) {
    G.items.push({
      key: "corpse",
      name: pl.carriedBody.name,
      corpseName: pl.carriedBody.corpseName,
      tile: pl.carriedBody.tile,
      fromKill: pl.carriedBody.fromKill,
      wasNpc: pl.carriedBody.wasNpc,
      x: pl.x, y: pl.y,
      glyph: "%", colour: "ETC_BLOOD",
    });
    pl.carriedBody = null;
  }
  clearSave();             // the run is finished -- nothing to resume
  sfx(won ? "win" : "death");
  const p = G.player;
  const title = document.getElementById("over-title");
  title.textContent = won ? "YOU WIN" : "YOU DIE";
  title.className = won ? "win" : "";
  // tally up the run's achievements -- gives the post-mortem some
  // teeth, especially for losses
  const chunksExplored = Object.keys(G.levels || {})
    .filter(k => k.startsWith("Surface:")).length;
  const indoorsExplored = Object.keys(G.levels || {})
    .filter(k => k.startsWith("Indoors:")).length;
  const questsDone = (G.quests || []).filter(
    q => q.status === "turnedIn").length;
  const questsActive = (G.quests || []).filter(
    q => q.status === "active").length;
  const kingsMet = Object.values(G.levels || {})
    .filter(v => (v.npcs || []).some(n => n.kind === "king")).length;
  const regionLastSeen = (G.branch === "Surface" && G.surfaceCoord)
    ? regionNameFor(G.surfaceCoord.cx, G.surfaceCoord.cy) +
      " (" + G.surfaceCoord.cx + "," + G.surfaceCoord.cy + ")"
    : levelLabel(G.branch, G.depth);
  const lines = [];
  lines.push(won
    ? `You took up the <b>Crown</b> at the bottom of the ` +
      `Dungeon and placed it upon your head. ` +
      `You are <b>${p.name}, King of the Depths</b>.<br>`
    : `Slain by a <b>${killer}</b> in ${regionLastSeen}.<br>`);
  lines.push(`<span class="stat">${p.name}</span>` +
    ` &nbsp;&middot;&nbsp; XL ${p.xl}` +
    ` &nbsp;&middot;&nbsp; ${G.turn} turns`);
  lines.push(`<b>${p.kills}</b> monsters slain` +
    ` &nbsp;&middot;&nbsp; <b>${p.gold}</b> gold`);
  lines.push(`Surface chunks explored: <b>${chunksExplored}</b>` +
    (indoorsExplored
      ? ` &nbsp;&middot;&nbsp; indoor floors: <b>${indoorsExplored}</b>`
      : ""));
  if (questsDone || questsActive) {
    lines.push(`Quests completed: <b>${questsDone}</b>` +
      (questsActive ? ` &nbsp;&middot;&nbsp; left unfinished: ` +
                       `<b>${questsActive}</b>` : ""));
  }
  if (kingsMet) lines.push(`Kings encountered: <b>${kingsMet}</b>`);
  lines.push(`Last seen in <b>${regionLastSeen}</b>`);
  document.getElementById("over-body").innerHTML =
    lines.join("<br>");
  showScreen("over");
}

function checkWin() {
  // stepping onto the Crown crowns you king and wins the run
  const orb = G.orbPos;
  if (orb && G.player.x === orb.x && G.player.y === orb.y) {
    gameOver(true, null);
    return true;
  }
  return false;
}

/* =============================================================
 * Logging
 * ============================================================= */

function logMsg(text, cls) {
  G.log.push({ text, cls: cls || "", turn: G.turn });
  if (G.log.length > 200) G.log.shift();
}

/* =============================================================
 * Rendering
 * ============================================================= */

let canvasReady = false;

function setupCanvas() {
  const c = document.getElementById("map-canvas");
  c.width = VIEW_W * TILE;
  c.height = VIEW_H * TILE;
  canvasReady = true;
}

function tileGlyph(t) {
  switch (t) {
    case T.WALL: return { ch: "#", col: "#5a5a6a" };
    case T.FLOOR: return { ch: ".", col: "#4a4a55" };
    case T.STAIRS_DOWN: return { ch: ">", col: "#ffffff" };
    case T.STAIRS_UP: return { ch: "<", col: "#ffffff" };
    case T.DOOR: return { ch: "+", col: "#c08a4a" };
    case T.DOOR_OPEN: return { ch: "'", col: "#c08a4a" };
    case T.DOOR_LOCKED: return { ch: "+", col: "#cc4040" };
    case T.DOOR_STEEL: return { ch: "+", col: "#8a8aa0" };
    case T.GATE: return { ch: "=", col: "#d8a060" };
    case T.WATER: return { ch: "~", col: "#5a9ed5" };
    case T.DEEP_WATER: return { ch: "~", col: "#1a3e6e" };
    case T.TELEPORTER: return { ch: "T", col: "#b986ff" };
    case T.CASTLE_GATE: return { ch: "=", col: "#ffd24a" };
    case T.EXIT_GATE: return { ch: "=", col: "#88c0ff" };
    case T.HEARTH: return { ch: "H", col: "#ff8a3a" };
    case T.BED: return { ch: "b", col: "#a866cc" };
    case T.PLAYER_CHEST: return { ch: "C", col: "#c8a060" };
    case T.PLAYER_SIGN: return { ch: "s", col: "#cccc88" };
    case T.FORGE: return { ch: "F", col: "#ff6622" };
    case T.LAVA: return { ch: "~", col: "#d2562a" };
    case T.TREE: return { ch: "&", col: "#3c7a3c" };
    case T.ALTAR: return { ch: "_", col: "#d8d8a0" };
    case T.BRANCH: return { ch: ">", col: "#ffcc44" };
    case T.SHOP: return { ch: "$", col: "#ffd24a" };
    case T.ROOF: return { ch: "^", col: "#b95a2a" };
    case T.WELL: return { ch: "u", col: "#5cc7ff" };
    case T.SHRINE: return { ch: "I", col: "#ffd070" };
    case T.GRAVE: return { ch: "t", col: "#b0b0b0" };
    case T.CAMPSITE: return { ch: "c", col: "#e3a060" };
    case T.IDOL: return { ch: "i", col: "#cc4444" };
    case T.MANA_NODE: return { ch: "m", col: "#5cd2ff" };
    case T.SIGNPOST: return { ch: "s", col: "#d8d0a0" };
    case T.BEACON: return { ch: "*", col: "#ffea60" };
    case T.WISHING_WELL: return { ch: "W", col: "#9ae0ff" };
    case T.STANDING_STONE: return { ch: "I", col: "#9c9c9c" };
    case T.FLOWERS: return { ch: "\"", col: "#ff89d8" };
    case T.LECTERN: return { ch: "n", col: "#b08a4a" };
    case T.FRUIT_CACHE: return { ch: "%", col: "#ff7f3f" };
    default: return { ch: "?", col: "#f0f" };
  }
}

/* draw a sprite (or an ASCII glyph fallback) into a screen cell */
function drawCell(ctx, rel, glyph, glyphCol, sx, sy) {
  const img = tileReady(rel);
  if (img) {
    ctx.drawImage(img, sx, sy, TILE, TILE);
  } else if (glyph) {
    ctx.fillStyle = glyphCol || "#b0b0bc";
    ctx.fillText(glyph, sx + TILE / 2, sy + TILE / 2 + 1);
  }
}

/* ---------- autotiling ----------
 * A stable per-cell hash so floor/wall variant choices never flicker
 * between renders or shift as the camera scrolls. */
function cellHash(x, y) {
  let h = (x * 73856093) ^ (y * 19349663) ^ 0x9e3779b9;
  h = (h ^ (h >>> 13)) >>> 0;
  return h;
}

/* pick a deterministic variant from a manifest entry that may be a
 * single path string or an array of variant paths. */
/* draw a layered paper-doll: species body, then worn armour, then
 * the wielded weapon -- the way DCSS composites its player tiles.
 * Returns true if at least one layer was drawn. */
function drawDoll(ctx, dx, dy, size, speciesRel, weaponName, armourName) {
  if (!ctx) return false;
  ctx.imageSmoothingEnabled = false;
  const doll = (MANIFEST && MANIFEST.doll) || {};
  const layers = [];
  if (speciesRel) layers.push(speciesRel);
  if (armourName && doll.armour && doll.armour[armourName]) {
    layers.push(doll.armour[armourName]);
  }
  if (weaponName && doll.weapon && doll.weapon[weaponName]) {
    layers.push(doll.weapon[weaponName]);
  }
  let drew = false;
  for (const rel of layers) {
    const img = tileReady(rel);
    if (img) { ctx.drawImage(img, dx, dy, size, size); drew = true; }
  }
  return drew;
}

function variantTile(entry, x, y) {
  if (!entry) return null;
  if (typeof entry === "string") return entry;
  if (!entry.length) return null;
  return entry[cellHash(x, y) % entry.length];
}

function render() {
  const canvas = document.getElementById("map-canvas");
  const ctx = canvas.getContext && canvas.getContext("2d");
  if (ctx) {
    if (!canvasReady) setupCanvas();
    const lvl = G.level, p = G.player;
    // camera: keep the player centred (clamped on closed levels; on
    // the Surface it runs in WORLD coords so chunks scroll seamlessly)
    const cam = camOrigin();
    const camX = cam.camX, camY = cam.camY;
    const isSurface = G && G.branch === "Surface";
    const sc = G.surfaceCoord || { cx: 0, cy: 0 };

    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = (TILE - 6) + "px monospace";

    const dn = MANIFEST && MANIFEST.dngn || {};
    const vt = MANIFEST && MANIFEST.vault_tiles || {};
    // positions of traps the player has spotted (current level only)
    const knownTraps = {};
    for (const tr of (lvl.traps || [])) {
      if (tr.known) knownTraps[tr.y * MAP_W + tr.x] = true;
    }
    // each branch has its own floor / wall theme
    const themes = dn.themes || [];
    const theme = themes.length
      ? themes[Math.min(BRANCHES[G.branch].theme, themes.length - 1)]
      : null;
    const floorSet = theme ? theme.floor : null;
    const wallSet = theme ? theme.wall : null;
    // cross-chunk lookups for the Surface; trivial for sealed levels
    const tileAt = isSurface
      ? (x, y) => worldTileAt(x, y)
      : (x, y) => (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H)
                  ? T.WALL : lvl.tiles[y][x];
    // the Surface has no fog of war -- the whole world is visible.
    // Sealed levels (dungeons / ruins) keep the dungeon-crawl fog.
    const seenAt = isSurface
      ? () => true
      : (x, y) => G.seen[y] && G.seen[y][x];
    const visibleAt = isSurface
      ? () => true
      : (x, y) => G.visible[y] && G.visible[y][x];
    const isWall = (x, y) => tileAt(x, y) === T.WALL;
    // is world cell (wx,wy) under a roof? Returns the masking building
    // or null. Rules:
    //   - the south wall row (front facade with the door) is always
    //     visible -- you can see the building from outside and know
    //     where the door is
    //   - every other cell in the bounding rect (walls + interior) is
    //     roofed when the player is outside
    //   - inside: the player's current room is unroofed, plus its
    //     immediate bounding walls + doors; other rooms + the rest of
    //     the building's outer walls remain roofed so you only ever
    //     see your room and the next door over
    const playerBuilding = isSurface ? buildingAt(lvl, p.x, p.y) : null;
    const playerRoom = (playerBuilding && isSurface)
      ? roomAt(playerBuilding, p.x, p.y) : null;
    const roofingAt = (wx, wy) => {
      if (!isSurface) return null;
      const ccx = Math.floor(wx / MAP_W), ccy = Math.floor(wy / MAP_H);
      const lx = wx - ccx * MAP_W, ly = wy - ccy * MAP_H;
      const dd = chunkData(ccx, ccy);
      const b = buildingInBoundsAt(dd.level, lx, ly);
      if (!b) return null;
      // south facade always visible (the front of the house + door)
      if (ly === b.y + b.h - 1) return null;
      const sameBuilding = (ccx === sc.cx && ccy === sc.cy &&
                            playerBuilding === b);
      if (sameBuilding && playerRoom) {
        // cell inside the player's current room rect -> visible
        if (lx >= playerRoom.x && lx < playerRoom.x + playerRoom.w &&
            ly >= playerRoom.y && ly < playerRoom.y + playerRoom.h) {
          return null;
        }
        // one-tile rim around the player's room: visible if it's a
        // wall or door (those bound the room); otherwise stay roofed
        const inRim =
          lx >= playerRoom.x - 1 && lx <= playerRoom.x + playerRoom.w &&
          ly >= playerRoom.y - 1 && ly <= playerRoom.y + playerRoom.h;
        if (inRim) {
          const t = dd.level.tiles[ly][lx];
          if (t === T.WALL || t === T.DOOR || t === T.DOOR_OPEN) return null;
        }
      }
      return b;
    };
    const cellRoofed = (wx, wy) => roofingAt(wx, wy) !== null;
    const roofTiles = (dn && dn.roof) || null;
    const buildingWalls = (dn && dn.building_walls) || null;
    const buildingFloors = (dn && dn.building_floors) || null;
    const biomeFloors = (dn && dn.biome_floors) || null;
    const isIndoor = G && G.branch === "Indoors";
    // each building gets its own stone + floor pool, picked at gen
    // time -- look up the appropriate variant arrays for the current
    // cell so wall + floor textures vary house-to-house and tile-to-tile.
    // Indoors levels mirror their source building's footprint and use
    // its theme, so the upstairs reads as the same house.
    const cellWallSet = (wx, wy) => {
      if (!buildingWalls) return wallSet;
      if (isSurface) {
        const ccx = Math.floor(wx / MAP_W), ccy = Math.floor(wy / MAP_H);
        const lx = wx - ccx * MAP_W, ly = wy - ccy * MAP_H;
        const dd = chunkData(ccx, ccy);
        // OUTER footprint match -- castle curtain walls get the same
        // stone theme as the inner keep
        const cb = buildingOuterAt(dd.level, lx, ly);
        if (!cb) return wallSet;
        return buildingWalls[cb.wallPool % buildingWalls.length] || wallSet;
      }
      if (isIndoor && lvl.buildings && lvl.buildings.length) {
        const cb = lvl.buildings[0];
        return buildingWalls[cb.wallPool % buildingWalls.length] || wallSet;
      }
      return wallSet;
    };
    const cellFloorSet = (wx, wy) => {
      if (isSurface) {
        const ccx = Math.floor(wx / MAP_W), ccy = Math.floor(wy / MAP_H);
        const lx = wx - ccx * MAP_W, ly = wy - ccy * MAP_H;
        const dd = chunkData(ccx, ccy);
        // inside a building -> the building's stone floor pool
        const cb = buildingOuterAt(dd.level, lx, ly);
        if (cb && buildingFloors) {
          return buildingFloors[cb.floorPool % buildingFloors.length]
                 || floorSet;
        }
        // outdoor wilderness -> grass / dirt / sand / bog by biome
        if (biomeFloors) {
          const biome = biomeAtWorld(wx, wy);
          const arr = biomeFloors[biome];
          if (arr && arr.length) return arr;
        }
        return floorSet;
      }
      if (isIndoor && lvl.buildings && lvl.buildings.length && buildingFloors) {
        const cb = lvl.buildings[0];
        return buildingFloors[cb.floorPool % buildingFloors.length] || floorSet;
      }
      return floorSet;
    };
    for (let vy = 0; vy < VIEW_H; vy++) {
      for (let vx = 0; vx < VIEW_W; vx++) {
        const x = camX + vx, y = camY + vy;
        if (!isSurface && (x >= MAP_W || y >= MAP_H)) continue;
        if (!seenAt(x, y)) continue;
        const sx = vx * TILE, sy = vy * TILE;
        {
          const rb = roofingAt(x, y);
          if (rb) {
            // pick the roof variant the building was assigned at
            // generation; fall back to a brown caret if tiles aren't
            // bundled yet (e.g. headless render harness)
            const tileRel = (roofTiles && roofTiles.length)
              ? roofTiles[(rb.roofTile || 0) % roofTiles.length] : null;
            ctx.fillStyle = "#3a2418";
            ctx.fillRect(sx, sy, TILE, TILE);
            drawCell(ctx, tileRel, "^", "#b95a2a", sx, sy);
            continue;
          }
        }
        const t = tileAt(x, y);

        // a vault may override a cell's floor/wall with its own
        // authored tile (.des FTILE / RTILE); otherwise use the
        // building's own stone/floor pool (Surface) or the depth
        // theme's autotiled variant.
        // tileArt lookup -- non-Surface chunks always read it; Surface
        // chunks read the OWNING chunk's tileArt (so editor-painted
        // overrides on neighbour chunks render correctly when in view)
        let artName = null;
        if (!isSurface) {
          artName = lvl.tileArt && lvl.tileArt[y * MAP_W + x];
        } else {
          const ccx = Math.floor(x / MAP_W), ccy = Math.floor(y / MAP_H);
          const lx = x - ccx * MAP_W, ly = y - ccy * MAP_H;
          const dd = chunkData(ccx, ccy);
          artName = dd.level.tileArt && dd.level.tileArt[ly * MAP_W + lx];
        }
        // tileArt values are either a vault_tiles key OR a direct path
        // ending in .png (the chunk editor stamps full sprite paths so
        // user-painted overrides can use any manifest tile)
        const artRel = artName && (
          (typeof artName === "string" && artName.endsWith(".png")) ? artName
          : (vt && vt[artName])
        );
        const myFloorSet = cellFloorSet(x, y);
        const myWallSet  = cellWallSet(x, y);
        const floorBase = artRel && t !== T.WALL
          ? artRel : variantTile(myFloorSet, x, y);

        let rel;
        if (t === T.WALL) {
          rel = artRel || variantTile(myWallSet, x, y);
        } else if (t === T.WATER) {
          rel = variantTile(dn.shallow_water || dn.water, x, y);
        } else if (t === T.DEEP_WATER) {
          rel = variantTile(dn.deep_water, x, y);
        } else if (t === T.LAVA) {
          rel = variantTile(dn.lava, x, y);
        } else {
          rel = floorBase;
        }
        // stairs, doors and trees sit on top of a floor base
        if (t === T.STAIRS_DOWN || t === T.STAIRS_UP) {
          drawCell(ctx, floorBase, null, null, sx, sy);
          let stairRel = (t === T.STAIRS_DOWN) ? dn.stairs_down : dn.stairs_up;
          if (G.branch === "Indoors") {
            // indoor sub-levels: hatch-style sprite so it reads as
            // "leaving the building" rather than a dungeon descent
            stairRel = (t === T.STAIRS_DOWN) ? (dn.cellar_down || stairRel)
                                              : (dn.cellar_up || stairRel);
          } else if (isSurface) {
            const b = buildingAt(lvl, x, y);
            if (b) {
              stairRel = (t === T.STAIRS_DOWN) ? (dn.cellar_down || stairRel)
                                                : (dn.cellar_up || stairRel);
            }
          } else if (t === T.STAIRS_UP && G.depth === 1 &&
                     dn.exit && dn.exit[G.branch]) {
            // a branch's level 1 STAIRS_UP is the EXIT to the parent
            // -- use the branch-specific exit gateway sprite (e.g. the
            // Crypt arch on D, the Lair sigil on the way back up)
            stairRel = dn.exit[G.branch];
          }
          rel = stairRel;
        } else if (t === T.BRANCH) {
          drawCell(ctx, floorBase, null, null, sx, sy);
          // a per-branch entrance sprite -- Lair gets the green portal,
          // Crypt the dark arch, etc.
          let branchRel = dn.stairs_down;
          const e = (lvl.entrances || []).find(
            en => en.x === x && en.y === y);
          if (e && dn.enter && dn.enter[e.branch]) {
            branchRel = dn.enter[e.branch];
          }
          rel = branchRel;
        } else if (t === T.DOOR || t === T.DOOR_OPEN ||
                   t === T.DOOR_LOCKED || t === T.DOOR_STEEL ||
                   t === T.GATE) {
          drawCell(ctx, floorBase, null, null, sx, sy);
          // Crypt branch uses its own darker door / gate sprites
          const inCrypt = (G.branch === "Crypt");
          if (t === T.GATE) {
            // multi-tile gate: pick the LEFT, MIDDLE or RIGHT sprite
            // based on whether the neighbours are also GATE tiles
            const leftIsGate  = tileAt(x - 1, y) === T.GATE;
            const rightIsGate = tileAt(x + 1, y) === T.GATE;
            if (leftIsGate && rightIsGate) {
              rel = inCrypt ? dn.gate_mid_closed_crypt
                            : dn.gate_mid_closed;
            } else if (rightIsGate) {
              rel = inCrypt ? dn.gate_left_closed_crypt
                            : dn.gate_left_closed;
            } else if (leftIsGate) {
              rel = inCrypt ? dn.gate_right_closed_crypt
                            : dn.gate_right_closed;
            } else {
              rel = inCrypt ? dn.door_closed_crypt : dn.door_closed;
            }
          } else if (t === T.DOOR_OPEN) {
            rel = dn.door_open;
          } else {
            rel = (inCrypt ? dn.door_closed_crypt : dn.door_closed);
          }
        } else if (t === T.TREE) {
          drawCell(ctx, floorBase, null, null, sx, sy);
          rel = variantTile(dn.tree, x, y);
        } else if (t === T.ALTAR) {
          drawCell(ctx, floorBase, null, null, sx, sy);
          rel = dn["altar_" + (lvl.altarGod || "")] || rel;
        } else if (t === T.SHOP) {
          drawCell(ctx, floorBase, null, null, sx, sy);
          rel = null;                  // the $ glyph marks the shop
        } else if (t === T.WELL) {
          drawCell(ctx, floorBase, null, null, sx, sy);
          rel = dn.well || null;
        } else if (t === T.SHRINE) {
          drawCell(ctx, floorBase, null, null, sx, sy);
          rel = dn.shrine || null;
        } else if (t === T.GRAVE) {
          drawCell(ctx, floorBase, null, null, sx, sy);
          rel = dn.grave || null;
        } else if (t === T.CAMPSITE) {
          drawCell(ctx, floorBase, null, null, sx, sy);
          rel = dn.campsite || null;
        } else if (t === T.IDOL) {
          drawCell(ctx, floorBase, null, null, sx, sy);
          rel = dn.idol || null;
        } else if (t === T.MANA_NODE) {
          drawCell(ctx, floorBase, null, null, sx, sy);
          rel = dn.mana_node || null;
        } else if (t === T.SIGNPOST) {
          drawCell(ctx, floorBase, null, null, sx, sy);
          rel = dn.signpost || null;
        } else if (t === T.BEACON) {
          drawCell(ctx, floorBase, null, null, sx, sy);
          rel = dn.beacon || null;
        } else if (t === T.WISHING_WELL) {
          drawCell(ctx, floorBase, null, null, sx, sy);
          rel = dn.wishing_well || null;
        } else if (t === T.STANDING_STONE) {
          drawCell(ctx, floorBase, null, null, sx, sy);
          rel = variantTile(dn.standing_stone, x, y);
        } else if (t === T.FLOWERS) {
          drawCell(ctx, floorBase, null, null, sx, sy);
          rel = dn.flowers || null;
        } else if (t === T.LECTERN) {
          drawCell(ctx, floorBase, null, null, sx, sy);
          rel = dn.lectern || null;
        } else if (t === T.FRUIT_CACHE) {
          drawCell(ctx, floorBase, null, null, sx, sy);
          rel = dn.fruit_cache || null;
        } else if (t === T.TELEPORTER) {
          drawCell(ctx, floorBase, null, null, sx, sy);
          rel = "dngn/gateways/abyssal_stair.png";  // re-use the rune disc
        } else if (t === T.CASTLE_GATE) {
          drawCell(ctx, floorBase, null, null, sx, sy);
          rel = "dngn/gate_closed_middle.png";
        } else if (t === T.EXIT_GATE) {
          drawCell(ctx, floorBase, null, null, sx, sy);
          rel = "dngn/gate_open_middle.png";
        } else if (t === T.HEARTH) {
          // hearth = warm fire. Reuse the campsite tile -- visually
          // identical and already preloaded.
          drawCell(ctx, floorBase, null, null, sx, sy);
          rel = dn.campsite || null;
        } else if (t === T.BED) {
          drawCell(ctx, floorBase, null, null, sx, sy);
          rel = null;     // no good sprite -- fall back to glyph "b"
        } else if (t === T.PLAYER_CHEST) {
          // reuse the chest item sprite for the player-built chest
          drawCell(ctx, floorBase, null, null, sx, sy);
          rel = im.chest || null;
        } else if (t === T.PLAYER_SIGN) {
          drawCell(ctx, floorBase, null, null, sx, sy);
          rel = dn.signpost || null;
        } else if (t === T.FORGE) {
          drawCell(ctx, floorBase, null, null, sx, sy);
          rel = dn.forge || null;
        }
        const g = tileGlyph(t);
        drawCell(ctx, rel, g.ch, g.col, sx, sy);
        // POIs that have been used show through a darker overlay so the
        // player remembers they've already drunk that well / read that
        // signpost / unearthed that grave. Look up the OWNING chunk
        // (which may be a neighbour on the Surface) for its drained set.
        if (t === T.WELL || t === T.SHRINE || t === T.GRAVE ||
            t === T.CAMPSITE || t === T.IDOL || t === T.MANA_NODE ||
            t === T.BEACON || t === T.WISHING_WELL ||
            t === T.FLOWERS || t === T.LECTERN || t === T.FRUIT_CACHE) {
          let drainedHere;
          if (isSurface) {
            const ccx = Math.floor(x / MAP_W), ccy = Math.floor(y / MAP_H);
            const lx = x - ccx * MAP_W, ly = y - ccy * MAP_H;
            const dd = chunkData(ccx, ccy);
            drainedHere = dd.level.drainedPOIs &&
              dd.level.drainedPOIs[ly * MAP_W + lx];
          } else {
            drainedHere = lvl.drainedPOIs && lvl.drainedPOIs[y * MAP_W + x];
          }
          if (drainedHere) {
            ctx.fillStyle = "rgba(0,0,0,0.45)";
            ctx.fillRect(sx, sy, TILE, TILE);
          }
        }

        // a spotted trap shows a warning mark over the floor (current
        // chunk only -- traps on neighbour chunks render when visited)
        if (!isSurface && knownTraps[y * MAP_W + x] && visibleAt(x, y)) {
          ctx.fillStyle = "#ff7733";
          ctx.fillText("^", sx + (TILE >> 1), sy + (TILE >> 1) + 1);
        }

        // neighbour-aware wall shadows: a floor cell draws a soft dark
        // edge against each adjacent wall, so walls read as raised.
        if (t !== T.WALL && visibleAt(x, y)) {
          ctx.fillStyle = "rgba(0,0,0,0.34)";
          if (isWall(x, y - 1)) ctx.fillRect(sx, sy, TILE, 5);
          if (isWall(x - 1, y)) ctx.fillRect(sx, sy, 5, TILE);
          ctx.fillStyle = "rgba(0,0,0,0.20)";
          if (isWall(x + 1, y)) ctx.fillRect(sx + TILE - 4, sy, 4, TILE);
          if (isWall(x, y + 1)) ctx.fillRect(sx, sy + TILE - 4, TILE, 4);
        }

        // remembered-but-dark fog only on the player's current
        // chunk; neighbouring Surface chunks render at full brightness
        // so the world reads as a continuous landscape
        if (!visibleAt(x, y)) {
          const isHere = !isSurface ||
            (Math.floor(x / MAP_W) === sc.cx &&
             Math.floor(y / MAP_H) === sc.cy);
          if (isHere) {
            ctx.fillStyle = "rgba(0,0,0,0.55)";
            ctx.fillRect(sx, sy, TILE, TILE);
          }
        }
      }
    }

    // turn a chunk-local (x,y) into world coords, identity off the
    // Surface. Items / monsters / player are stored in chunk-local
    // coords but the camera reads in world coords on the Surface, so
    // each entity has to be promoted before its screen position is
    // computed.
    const wxOf = isSurface ? (lx) => sc.cx * MAP_W + lx : (lx) => lx;
    const wyOf = isSurface ? (ly) => sc.cy * MAP_H + ly : (ly) => ly;
    const onScreen = (lx, ly) => {
      const wx = wxOf(lx), wy = wyOf(ly);
      return wx >= camX && wx < camX + VIEW_W &&
             wy >= camY && wy < camY + VIEW_H;
    };
    const im = MANIFEST && MANIFEST.item || {};

    // items + monsters -- on the Surface, render from EVERY chunk
    // intersecting the viewport, not just the player's current one
    const iw = (MANIFEST && MANIFEST.item_weapons) || {};
    const mm = MANIFEST && MANIFEST.monsters || {};
    const inViewWorld = (wx, wy) =>
      wx >= camX && wx < camX + VIEW_W &&
      wy >= camY && wy < camY + VIEW_H;
    const renderChunkEntities = (data, cxBase, cyBase) => {
      for (const it of (data.items || [])) {
        const wx = cxBase + it.x, wy = cyBase + it.y;
        if (!inViewWorld(wx, wy)) continue;
        if (cellRoofed(wx, wy)) continue;
        const tile = (it.key === "weapon" && it.weapon &&
                      iw[it.weapon.name])
                  || (it.key === "food" && im.food && im.food[it.sub])
                  || im[it.key]
                  || null;
        drawCell(ctx, tile, it.glyph, colourHex(it.colour),
                 (wx - camX) * TILE, (wy - camY) * TILE);
      }
      const bossTiles = (MANIFEST && MANIFEST.boss) || null;
      for (const m of (data.monsters || [])) {
        const wx = cxBase + m.x, wy = cyBase + m.y;
        if (!inViewWorld(wx, wy)) continue;
        if (cellRoofed(wx, wy)) continue;
        // bosses: render at 2.2x tile size, centred on the cell, so the
        // sprite loom over the surrounding floor and read as a real
        // threat. Still occupies a single tile for combat/AI.
        if (m.def.boss && bossTiles && m.def.bossTile) {
          const bossRel = bossTiles[m.def.bossTile];
          const img = tileReady(bossRel);
          if (img) {
            const sz = Math.round(TILE * 2.2);
            const cx0 = (wx - camX) * TILE + (TILE >> 1);
            const cy0 = (wy - camY) * TILE + (TILE >> 1);
            ctx.drawImage(img, cx0 - (sz >> 1), cy0 - (sz >> 1), sz, sz);
            continue;
          }
        }
        drawCell(ctx, mm[m.def.id], m.glyph, colourHex(m.colour),
                 (wx - camX) * TILE, (wy - camY) * TILE);
        // tactical HP bar for wounded mobs -- shown only when injured
        // so an undamaged crowd doesn't disappear under bars
        if (m.hp > 0 && m.hp < m.hpMax) {
          const f = Math.max(0, m.hp) / m.hpMax;
          const bx = (wx - camX) * TILE;
          const by = (wy - camY) * TILE;
          ctx.fillStyle = "rgba(0,0,0,0.7)";
          ctx.fillRect(bx, by + TILE - 4, TILE, 3);
          ctx.fillStyle = f > 0.5 ? "#3cd47a"
                        : f > 0.25 ? "#d4c43c" : "#d44a3c";
          ctx.fillRect(bx, by + TILE - 4, Math.max(1, Math.round(TILE * f)), 3);
        }
      }
      // friendly NPCs (questgivers, shopkeepers, captives, children).
      // Each NPC was stamped with a specific tile at gen time; falls
      // back to the halfling sprite if the npc bundle isn't loaded.
      // At NIGHT (outdoors only), most NPCs are asleep -- rendered
      // dimmer with a 'zZ' over their head, no barks, easy backstab.
      const barkBubbles = [];   // collect; draw after sprites so they sit on top
      const npcsAsleep = isOutdoors(G.branch) &&
                         timeOfDay().phase === "night";
      for (const n of (data.npcs || [])) {
        const wx = cxBase + n.x, wy = cyBase + n.y;
        if (!inViewWorld(wx, wy)) continue;
        if (cellRoofed(wx, wy)) continue;
        const asleep = npcsAsleep && n.kind !== "captive" &&
                       n.kind !== "king";  // kings keep watch
        if (asleep) ctx.globalAlpha = 0.55;
        drawCell(ctx, n.tile || mm.MONS_HALFLING, n.glyph || "@",
                 colourHex(n.colour || "WHITE"),
                 (wx - camX) * TILE, (wy - camY) * TILE);
        if (asleep) {
          ctx.globalAlpha = 1.0;
          ctx.save();
          ctx.font = "bold 12px monospace";
          ctx.textBaseline = "top";
          ctx.fillStyle = "#9be0ff";
          ctx.shadowColor = "#000";
          ctx.shadowBlur = 2;
          ctx.fillText("zZ", (wx - camX) * TILE + 1, (wy - camY) * TILE);
          ctx.restore();
        }
        if (!asleep && n.barkText && n.barkExpireTurn > G.turn) {
          barkBubbles.push({ wx, wy, text: n.barkText });
        }
      }
      // speech bubbles -- a small rounded box above each NPC's tile.
      // Drawn after all sprites so bubbles don't get covered.
      if (barkBubbles.length) {
        ctx.save();
        ctx.font = "11px monospace";
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        for (const b of barkBubbles) {
          const sx = (b.wx - camX) * TILE;
          const sy = (b.wy - camY) * TILE;
          const padX = 5, padY = 3;
          const w = Math.min(220, ctx.measureText(b.text).width + padX * 2);
          // wrap if too wide
          const lines = [];
          if (ctx.measureText(b.text).width + padX * 2 <= w) {
            lines.push(b.text);
          } else {
            const words = b.text.split(" ");
            let cur = "";
            for (const wd of words) {
              const probe = cur ? cur + " " + wd : wd;
              if (ctx.measureText(probe).width + padX * 2 > w) {
                if (cur) lines.push(cur);
                cur = wd;
              } else cur = probe;
            }
            if (cur) lines.push(cur);
          }
          const h = lines.length * 13 + padY * 2;
          let bx = sx + (TILE >> 1) - (w >> 1);
          let by = sy - h - 2;
          // keep within canvas
          if (bx < 2) bx = 2;
          if (bx + w > canvas.width - 2) bx = canvas.width - 2 - w;
          if (by < 2) by = sy + TILE + 2; // flip below if no room above
          ctx.fillStyle = "rgba(20,20,32,0.92)";
          ctx.fillRect(bx, by, w, h);
          ctx.strokeStyle = "rgba(255,210,74,0.7)";
          ctx.lineWidth = 1;
          ctx.strokeRect(bx + 0.5, by + 0.5, w - 1, h - 1);
          // little tail pointing at the NPC
          ctx.beginPath();
          const tailX = sx + (TILE >> 1);
          if (by < sy) {
            ctx.moveTo(tailX - 4, by + h);
            ctx.lineTo(tailX + 4, by + h);
            ctx.lineTo(tailX, by + h + 4);
          } else {
            ctx.moveTo(tailX - 4, by);
            ctx.lineTo(tailX + 4, by);
            ctx.lineTo(tailX, by - 4);
          }
          ctx.closePath();
          ctx.fillStyle = "rgba(20,20,32,0.92)";
          ctx.fill();
          ctx.fillStyle = "#ffe89c";
          for (let i = 0; i < lines.length; i++) {
            ctx.fillText(lines[i], bx + padX, by + padY + i * 13);
          }
        }
        ctx.restore();
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
      }
    };
    if (isSurface) {
      // walk the corners of the viewport to find the up-to-4 chunks
      // visible, then render each chunk's items + monsters
      const seenChunks = new Set();
      const c0 = [camX, camY], c1 = [camX + VIEW_W - 1, camY],
            c2 = [camX, camY + VIEW_H - 1],
            c3 = [camX + VIEW_W - 1, camY + VIEW_H - 1];
      for (const [wx, wy] of [c0, c1, c2, c3]) {
        const cx = Math.floor(wx / MAP_W), cy = Math.floor(wy / MAP_H);
        const k = cx + "," + cy;
        if (seenChunks.has(k)) continue;
        seenChunks.add(k);
        renderChunkEntities(chunkData(cx, cy), cx * MAP_W, cy * MAP_H);
      }
    } else {
      // dungeons / ruins -- only on-screen, visible items/monsters
      for (const it of G.items) {
        if (!visibleAt(it.x, it.y) || !onScreen(it.x, it.y)) continue;
        const tile = (it.key === "weapon" && it.weapon &&
                      iw[it.weapon.name])
                  || (it.key === "food" && im.food && im.food[it.sub])
                  || im[it.key]
                  || null;
        drawCell(ctx, tile, it.glyph, colourHex(it.colour),
                 (it.x - camX) * TILE, (it.y - camY) * TILE);
      }
      for (const m of G.monsters) {
        if (!visibleAt(m.x, m.y) || !onScreen(m.x, m.y)) continue;
        drawCell(ctx, mm[m.def.id], m.glyph, colourHex(m.colour),
                 (m.x - camX) * TILE, (m.y - camY) * TILE);
        if (m.hp > 0 && m.hp < m.hpMax) {
          const f = Math.max(0, m.hp) / m.hpMax;
          const bx = (m.x - camX) * TILE;
          const by = (m.y - camY) * TILE;
          ctx.fillStyle = "rgba(0,0,0,0.7)";
          ctx.fillRect(bx, by + TILE - 4, TILE, 3);
          ctx.fillStyle = f > 0.5 ? "#3cd47a"
                        : f > 0.25 ? "#d4c43c" : "#d44a3c";
          ctx.fillRect(bx, by + TILE - 4, Math.max(1, Math.round(TILE * f)), 3);
        }
      }
    }
    // the Orb (current level only -- it sits on D's bottom)
    if (G.orbPos && visibleAt(G.orbPos.x, G.orbPos.y) &&
        onScreen(G.orbPos.x, G.orbPos.y)) {
      drawCell(ctx, im.orb, "0", colourHex("ETC_ORB_GLOW"),
               (wxOf(G.orbPos.x) - camX) * TILE,
               (wyOf(G.orbPos.y) - camY) * TILE);
    }
    // player -- dimmed when sneaking, full alpha otherwise
    if (p.stealthed) ctx.globalAlpha = 0.45;
    const ppx = (wxOf(p.x) - camX) * TILE;
    const ppy = (wyOf(p.y) - camY) * TILE;
    drawCell(ctx, G.playerTile, "@", "#ffffff", ppx, ppy);
    if (p.stealthed) ctx.globalAlpha = 1.0;
    // small red "%" badge over the player's shoulder when hauling a
    // body, so you don't forget you're walking around with evidence
    if (p.carriedBody) {
      ctx.save();
      ctx.font = "bold 16px monospace";
      ctx.textBaseline = "top";
      ctx.fillStyle = "#cc2222";
      ctx.shadowColor = "#000";
      ctx.shadowBlur = 3;
      ctx.fillText("%", ppx + TILE - 14, ppy + 2);
      ctx.restore();
    }

    // transient effects (blood arrows, smoke clouds) -- drawn last so
    // they sit on top of everything; expired entries get filtered out
    if (G.transientEffects && G.transientEffects.length) {
      const now = Date.now();
      const live = [];
      for (const eff of G.transientEffects) {
        if (eff.expireAt <= now) continue;
        live.push(eff);
        const ex = wxOf(eff.x), ey = wyOf(eff.y);
        if (ex < camX || ey < camY ||
            ex >= camX + VIEW_W || ey >= camY + VIEW_H) continue;
        const img = tileReady(eff.sprite);
        if (img) {
          ctx.drawImage(img, (ex - camX) * TILE, (ey - camY) * TILE,
                        TILE, TILE);
        }
      }
      G.transientEffects = live;
    }

    // time-of-day tint: a translucent fill over the whole viewport
    // pushes the canvas warm at dawn / dusk and cold + dark at night.
    // Only outdoor branches (Surface, Castle interior) get the tint;
    // the Dungeon and Indoors stay neutral.
    if (isOutdoors(G.branch)) {
      const ph = timeOfDay().phase;
      let tint = null;
      if (ph === "dawn")  tint = "rgba(255, 170, 120, 0.18)";
      else if (ph === "dusk")  tint = "rgba(255, 130,  60, 0.22)";
      else if (ph === "night") tint = "rgba( 20,  40,  90, 0.38)";
      if (tint) {
        ctx.save();
        ctx.fillStyle = tint;
        ctx.fillRect(0, 0, VIEW_W * TILE, VIEW_H * TILE);
        ctx.restore();
      }
      // lit hearths + beds at night: warm halo around each, so your
      // home reads as a glowing pocket of safety in the dark. Only
      // drawn when the tint is active (dusk / night).
      if (ph === "dusk" || ph === "night") {
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        for (let yy = camY; yy < camY + VIEW_H; yy++) {
          for (let xx = camX; xx < camX + VIEW_W; xx++) {
            let lx = xx, ly = yy;
            let tile = -1;
            if (G.branch === "Surface") {
              const ccx = Math.floor(xx / MAP_W), ccy = Math.floor(yy / MAP_H);
              const lxm = xx - ccx * MAP_W, lym = yy - ccy * MAP_H;
              const dd = chunkData(ccx, ccy);
              if (dd && dd.level && dd.level.tiles) {
                tile = dd.level.tiles[lym] && dd.level.tiles[lym][lxm];
              }
            } else if (G.level && G.level.tiles[yy]) {
              tile = G.level.tiles[yy][xx];
            }
            if (tile !== T.HEARTH && tile !== T.BED && tile !== T.FORGE) continue;
            const cxp = (xx - camX) * TILE + (TILE >> 1);
            const cyp = (yy - camY) * TILE + (TILE >> 1);
            const r = tile === T.HEARTH ? 60
                    : tile === T.FORGE ? 70 : 36;
            const halo = ctx.createRadialGradient(cxp, cyp, 4, cxp, cyp, r);
            halo.addColorStop(0,
              tile === T.HEARTH ? "rgba(255, 180,  80, 0.55)"
            : tile === T.FORGE  ? "rgba(255, 120,  40, 0.65)"
                                : "rgba(180, 160, 220, 0.30)");
            halo.addColorStop(1, "rgba(0, 0, 0, 0)");
            ctx.fillStyle = halo;
            ctx.fillRect(cxp - r, cyp - r, r * 2, r * 2);
          }
        }
        ctx.restore();
      }
      // moon disc -- top-centre of the viewport, alpha keyed to phase
      // of day so it fades during noon and dominates at night
      const mp = moonPhase();
      const moonAlpha = ph === "night" ? 1.0
                      : ph === "dusk"  ? 0.85
                      : ph === "dawn"  ? 0.55
                      : 0.30;          // faint daytime moon
      const mx = (VIEW_W * TILE) >> 1;
      const my = 22;
      ctx.save();
      ctx.globalAlpha = moonAlpha;
      // a soft halo behind the moon so it reads on bright tiles
      const grd = ctx.createRadialGradient(mx, my, 4, mx, my, 28);
      grd.addColorStop(0, "rgba(255, 245, 210, 0.55)");
      grd.addColorStop(1, "rgba(255, 245, 210, 0)");
      ctx.fillStyle = grd;
      ctx.fillRect(mx - 30, my - 30, 60, 60);
      ctx.font = "28px serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(MOON_GLYPHS[mp], mx, my);
      ctx.restore();
    }

    // mouse hover: highlight the tile and describe what is on it.
    // hoverTile is in WORLD coords on the Surface, chunk-local off it.
    const hoverOnScreen = hoverTile &&
      hoverTile.x >= camX && hoverTile.x < camX + VIEW_W &&
      hoverTile.y >= camY && hoverTile.y < camY + VIEW_H;
    if (hoverOnScreen && seenAt(hoverTile.x, hoverTile.y)) {
      const hx = (hoverTile.x - camX) * TILE;
      const hy = (hoverTile.y - camY) * TILE;
      ctx.strokeStyle = "rgba(120,180,255,0.85)";
      ctx.lineWidth = 2;
      ctx.strokeRect(hx + 1, hy + 1, TILE - 2, TILE - 2);
      // a small tooltip naming whatever is under the cursor
      const desc = describeTileAt(hoverTile.x, hoverTile.y);
      if (desc) {
        ctx.font = "12px monospace";
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        const pad = 6, lh = 15;
        // multi-line tooltip -- monster lore returns "name\nlore"
        const lines = String(desc).split("\n");
        let bw = 0;
        for (const ln of lines) {
          const w = ctx.measureText(ln).width + pad * 2;
          if (w > bw) bw = w;
        }
        // wrap long lore lines so the box doesn't shoot off-canvas
        const maxW = Math.min(360, canvas.width - 24);
        bw = Math.min(bw, maxW);
        const wrapped = [];
        for (const ln of lines) {
          if (ctx.measureText(ln).width + pad * 2 <= bw) {
            wrapped.push(ln);
          } else {
            const words = ln.split(" ");
            let cur = "";
            for (const w of words) {
              const probe = cur ? cur + " " + w : w;
              if (ctx.measureText(probe).width + pad * 2 > bw) {
                if (cur) wrapped.push(cur);
                cur = w;
              } else cur = probe;
            }
            if (cur) wrapped.push(cur);
          }
        }
        const bh = lh * wrapped.length + pad;
        let bx = hx + TILE + 4, by = hy;
        if (bx + bw > canvas.width) bx = hx - bw - 4;     // flip left
        if (bx < 0) bx = 2;
        by = Math.max(2, Math.min(canvas.height - bh - 2, by));
        ctx.fillStyle = "rgba(8,10,16,0.94)";
        ctx.fillRect(bx, by, bw, bh);
        ctx.strokeStyle = "rgba(120,180,255,0.7)";
        ctx.lineWidth = 1;
        ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
        ctx.fillStyle = "#dfe6f0";
        for (let i = 0; i < wrapped.length; i++) {
          // first line is the header (mob name + HP); subsequent
          // wrapped lines are the lore -- dim them slightly
          ctx.fillStyle = i === 0 ? "#dfe6f0" : "#9aa6b8";
          ctx.fillText(wrapped[i], bx + pad, by + 3 + i * lh);
        }
        ctx.textAlign = "center";       // restore the map default
        ctx.textBaseline = "middle";
      }
    }
  }

  renderSidebar();
  renderLog();
  renderProvenance();
}

/* the top-left tile the camera currently shows -- shared by the
 * renderer and the mouse code so clicks map to the right tile. */
function camOrigin() {
  const p = G.player;
  // on the Surface the camera follows the player in WORLD coords --
  // no chunk clamping, so the screen scrolls smoothly across chunk
  // boundaries and you see neighbouring biomes
  if (G && G.branch === "Surface") {
    return {
      camX: playerWorldX() - (VIEW_W >> 1),
      camY: playerWorldY() - (VIEW_H >> 1),
      world: true,
    };
  }
  return {
    camX: Math.max(0, Math.min(MAP_W - VIEW_W, p.x - (VIEW_W >> 1))),
    camY: Math.max(0, Math.min(MAP_H - VIEW_H, p.y - (VIEW_H >> 1))),
    world: false,
  };
}

function bar(cls, cur, max, label) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (cur / max) * 100)) : 0;
  const low = cls === "hp" && cur / max <= 0.33 ? " low" : "";
  return `<div class="bar ${cls}${low}"><span style="width:${pct}%"></span>` +
    `<span class="bar-label">${label}</span></div>`;
}

function renderSidebar() {
  const p = G.player;
  const sb = document.getElementById("sidebar");
  sb.innerHTML =
    `<div class="name">${p.name}</div>` +
    `<div class="sub">XL ${p.xl} &middot; ` +
    `${levelLabel(G.branch, G.depth)} &middot; ` +
    (BRANCHES[G.branch] ? BRANCHES[G.branch].name : G.branch) +
    ` &middot; turn ${G.turn} &middot; ${timeLabel()} ` +
    MOON_GLYPHS[moonPhase()] + `</div>` +
    `<canvas id="sb-doll" class="sb-doll" width="64" height="64"></canvas>` +
    `<canvas id="sb-doll" class="sb-doll" width="64" height="64"></canvas>` +
    `<hr>` +
    bar("hp", p.hp, p.hpMax, `HP ${p.hp}/${p.hpMax}`) +
    (p.mpMax > 0 ? bar("mp", p.mp, p.mpMax, `MP ${p.mp}/${p.mpMax}`) : "") +
    bar("xp", p.xp, p.xpNext, `XP ${p.xp}/${p.xpNext}`) +
    (p.foodMax > 0 ? bar("food", p.food, p.foodMax,
        `Food ${(p.food >= 150 ? "Full" : p.food >= 80 ? "Sated"
          : p.food >= 30 ? "Hungry" : p.food > 0 ? "Starving"
          : "DYING")}`) : "") +
    `<hr>` +
    `<div><span class="lbl">Str</span><span class="val">${p.str}</span></div>` +
    `<div><span class="lbl">Int</span><span class="val">${p.int}</span></div>` +
    `<div><span class="lbl">Dex</span><span class="val">${p.dex}</span></div>` +
    `<div><span class="lbl">AC</span><span class="val">${playerAC(p)}</span></div>` +
    `<div><span class="lbl">EV</span><span class="val">${playerEV(p)}</span></div>` +
    `<hr>` +
    `<div><span class="lbl">Weapon</span><span class="val">${p.weapon.name}</span></div>` +
    `<div><span class="lbl">Armour</span><span class="val">` +
    `${p.armour ? p.armour.name : "&mdash;"}</span></div>` +
    `<div><span class="lbl">Ring</span><span class="val">` +
    `${p.ring ? "of " + p.ring.name + " +" + p.ring.plus : "&mdash;"}</span></div>` +
    `<div><span class="lbl">Gold</span><span class="val">${p.gold}</span></div>` +
    `<div><span class="lbl">Kills</span><span class="val">${p.kills}</span></div>` +
    (p.mightTurns > 0 ? `<div class="val" style="color:#f66">Might (${p.mightTurns})</div>` : "") +
    (p.berserkTurns > 0 ? `<div class="val" style="color:#f66">Berserk (${p.berserkTurns})</div>` : "") +
    (p.heroismTurns > 0 ? `<div class="val" style="color:#fc6">Heroic (${p.heroismTurns})</div>` : "") +
    (p.hasteTurns > 0 ? `<div class="val" style="color:#6cf">Hasted (${p.hasteTurns})</div>` : "") +
    (p.slowTurns > 0 ? `<div class="val" style="color:#aaa">Slowed (${p.slowTurns})</div>` : "") +
    (p.poisonTurns > 0 ? `<div class="val" style="color:#9f6">Poisoned (${p.poisonTurns})</div>` : "") +
    (p.paralyzedTurns > 0 ? `<div class="val" style="color:#f99">Paralysed (${p.paralyzedTurns})</div>` : "") +
    (p.confusedTurns > 0 ? `<div class="val" style="color:#fc9">Confused (${p.confusedTurns})</div>` : "") +
    (p.stealthed
      ? `<div class="val" style="color:#9be0ff">Sneaking (stealth ${stealthScore(p)})</div>`
      : "") +
    (p.carriedBody
      ? `<div class="val" style="color:#cc4040">Carrying: ${p.carriedBody.name} (D drops)</div>`
      : "") +
    (G.realtime
      ? `<div class="val" style="color:#ffaa66">Real-time mode</div>`
      : "") +
    `<hr>` +
    `<div><span class="lbl">Potions</span><span class="val">` +
    `${sidebarLabel("potion","heal")} ${packCount("potion", "heal")} &middot; ` +
    `${sidebarLabel("potion","might")} ${packCount("potion", "might")} &middot; ` +
    `${sidebarLabel("potion","haste")} ${packCount("potion", "haste")}</span></div>` +
    `<div><span class="lbl">Scrolls</span><span class="val">` +
    `${sidebarLabel("scroll","teleport")} ${packCount("scroll", "teleport")} &middot; ` +
    `${sidebarLabel("scroll","fear")} ${packCount("scroll", "fear")}</span></div>` +
    `<div><span class="lbl">Wand</span><span class="val">` +
    `${p.wand ? p.wand.name + " (" + p.wand.charges + ")" : "&mdash;"}</span></div>` +
    `<div><span class="lbl">Quiver</span><span class="val">` +
    `${p.quiver ? p.quiver.count + " " + p.quiver.name + "s" : "&mdash;"}</span></div>` +
    (p.spells.length
      ? `<div><span class="lbl">Spells</span><span class="val">` +
        p.spells.map(id => {
          const s = spellById(id);
          return s ? s.title : id;
        }).join(", ") + `</span></div>`
      : "") +
    (p.god
      ? `<div><span class="lbl">God</span><span class="val">` +
        godName(p.god) + `</span></div>` +
        `<div><span class="lbl">Piety</span><span class="val">` +
        p.piety + `/200</span></div>`
      : "") +
    compassHTML() +
    `<div class="sub" style="margin-top:6px">` +
    `q quaff &middot; r read &middot; i inv &middot; Q quests &middot; ` +
    `<b style="color:#ffd24a">M world map</b> &middot; ` +
    `<b style="color:#9be0ff">H sneak</b> &middot; ` +
    `<b style="color:#cc8080">D drop body</b>` +
    (p.spells.length ? ` &middot; z cast` : "") +
    (p.god ? ` &middot; a invoke` : ` &middot; p pray`) + `</div>` +
    (function () {
      const uf = describeUnderfoot();
      const here = G.items.some(i => i.x === p.x && i.y === p.y);
      if (!uf) return "";
      return `<div class="underfoot">Here: ${uf}` +
        (here ? ' &mdash; <b>g</b> picks it up' : "") + `</div>`;
    })();

  // the paper-doll: species body + worn armour + wielded weapon,
  // redrawn on the canvas the innerHTML above just created
  const dollCv = document.getElementById("sb-doll");
  const dctx = dollCv && dollCv.getContext && dollCv.getContext("2d");
  if (dctx) {
    dctx.clearRect(0, 0, dollCv.width, dollCv.height);
    const drew = drawDoll(dctx, 0, 0, dollCv.width, G.playerTile,
      p.weapon && p.weapon.name, p.armour && p.armour.name);
    if (!drew) {
      dctx.fillStyle = "#ffffff";
      dctx.font = "40px monospace";
      dctx.textAlign = "center";
      dctx.textBaseline = "middle";
      dctx.fillText("@", dollCv.width / 2, dollCv.height / 2);
    }
  }
}

function renderLog() {
  const logEl = document.getElementById("log");
  let html = "";
  let lastTurn = -1;
  for (const m of G.log.slice(-40)) {
    if (m.turn !== lastTurn && lastTurn !== -1) {
      html += `<div class="turn-sep">&mdash;</div>`;
    }
    lastTurn = m.turn;
    html += `<div class="msg-${m.cls || "norm"}">${m.text}</div>`;
  }
  logEl.innerHTML = html;
  logEl.scrollTop = logEl.scrollHeight;
}

function renderProvenance() {
  const el = document.getElementById("provenance");
  const visMon = G.monsters.filter(m => G.visible[m.y][m.x]);
  let detail = "";
  if (visMon.length) {
    const m = visMon[0];
    detail = ` &mdash; in view: <b>${m.name}</b> ` +
      `(monster_defs: HD ${m.def.hd}, HP ${m.def.hp}, AC ${m.def.ac}, ` +
      `EV ${m.def.ev}, speed ${m.def.speed})`;
  }
  el.innerHTML =
    `data: DCSS export schema <b>v${DATA.schema_version}</b> &middot; ` +
    `${DATA.monsters.length} monster defs &middot; ` +
    `combat math mirrors <b>fight.cc</b> exports` + detail;
}

/* =============================================================
 * Input
 * ============================================================= */

const MOVE_KEYS = {
  ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
  k: [0, -1], j: [0, 1], h: [-1, 0], l: [1, 0],
  y: [-1, -1], u: [1, -1], b: [-1, 1], n: [1, 1],
  "8": [0, -1], "2": [0, 1], "4": [-1, 0], "6": [1, 0],
  "7": [-1, -1], "9": [1, -1], "1": [-1, 1], "3": [1, 1],
};

let awaitingQuaff = false;
let awaitingRead = false;
let awaitingCast = false;
let helpOpen = false;
let invOpen = false;

function setHelp(open) {
  helpOpen = open;
  document.getElementById("help-overlay").classList.toggle("hidden", !open);
}

function setInv(open) {
  invOpen = open;
  if (open) renderInventory();
  document.getElementById("inv-overlay").classList.toggle("hidden", !open);
}

let shopOpen = false;

function setShop(open) {
  shopOpen = open;
  if (open) renderShop();
  document.getElementById("shop-overlay").classList.toggle("hidden", !open);
}

/* fill the shop overlay with the current floor's stock */
function renderShop() {
  const el = document.getElementById("shop-body");
  if (!el) return;
  const p = G.player;
  const stock = (G.level && G.level.shop) || [];
  let html = `<div class="inv-row"><span class="inv-slot">Your gold` +
    `</span><span class="inv-val"><b>${p.gold}</b> pieces</span></div><hr>`;
  if (!stock.length) {
    html += `<div class="inv-empty">The shelves are bare &mdash; you have ` +
      `bought everything.</div>`;
  } else {
    stock.forEach((it, i) => {
      const afford = p.gold >= it.price;
      html += `<div class="inv-row${afford ? " inv-clickable" : ""}"` +
        (afford ? ` data-buy="${i}"` : "") +
        `><span class="inv-slot">` +
        String.fromCharCode(97 + i) + `)</span>` +
        `<span class="inv-val${afford ? "" : " inv-empty"}">` +
        `<b>${displayName(it)}</b> &mdash; ${it.price} gold` +
        (afford ? "" : " <i>(not enough gold)</i>") +
        `</span></div>`;
    });
  }
  // the player's own pack, with a per-item sell offer
  const sellable = p.pack.map((it, i) =>
    ({ it, i, price: sellPrice(it) })).filter(x => x.price > 0);
  if (sellable.length) {
    html += `<hr><div class="inv-row"><span class="inv-slot">Sell` +
      `</span><span class="inv-val inv-empty">click to sell ` +
      `(or press the uppercase letter)</span></div>`;
    sellable.forEach(({ it, i, price }) => {
      const letter = String.fromCharCode(65 + i);    // A, B, C...
      const desc = (it.key === "potion" || it.key === "scroll")
        ? displayName(it) : (it.name || "item");
      const qty = (it.qty && it.qty > 1) ? " &times;" + it.qty : "";
      html += `<div class="inv-row inv-clickable" data-sell="${i}">` +
        `<span class="inv-slot">${letter})</span>` +
        `<span class="inv-val">${desc}${qty} &mdash; ` +
        `${price} gold</span></div>`;
    });
  }
  html += `<div class="inv-here" style="margin-top:8px">` +
    `Click a row to buy or sell. Letters still work.</div>`;
  el.innerHTML = html;
}

/* what a shopkeeper will pay for a pack item */
function sellPrice(item) {
  if (!item) return 0;
  if (item.key === "weapon" && item.weapon) {
    return Math.max(5, Math.round((22 + item.weapon.sides * 6 +
      (item.weapon.ego ? 40 : 0)) * 0.4));
  }
  if (item.key === "armour" && item.armour) {
    return Math.max(5, Math.round((18 + item.armour.ac * 13) * 0.4));
  }
  if (item.key === "ring" && item.ring) {
    return Math.max(5, Math.round((40 + item.ring.plus * 9) * 0.4));
  }
  if (item.key === "wand" && item.wand) {
    return Math.max(5, Math.round((50 + (item.wand.charges || 0) * 4) * 0.4));
  }
  if (item.key === "potion") return item.sub === "haste" ? 14 : 10;
  if (item.key === "scroll") return 12;
  if (item.key === "gem") return item.value || 80;
  return 0;
}

/* sell pack item #idx to the shop */
function sellItem(idx) {
  const p = G.player;
  const it = p.pack[idx];
  if (!it) return false;
  const price = sellPrice(it);
  if (price <= 0) {
    logMsg("The shopkeeper has no use for that.", "dim");
    return false;
  }
  const desc = (it.key === "potion" || it.key === "scroll")
    ? displayName(it) : (it.name || "item");
  p.gold += price;
  if (it.qty && it.qty > 1) it.qty--;
  else p.pack.splice(idx, 1);
  logMsg("You sell " + desc + " for " + price + " gold.", "good");
  sfx("pickup");
  return true;
}

/* buy stock item #idx if the player can afford it */
function buyItem(idx) {
  const p = G.player;
  const stock = (G.level && G.level.shop) || [];
  const it = stock[idx];
  if (!it) return false;
  if (p.gold < it.price) {
    logMsg("You cannot afford the " + it.name + ".", "dim");
    return false;
  }
  p.gold -= it.price;
  if (POTION_FLAVOR[it.key]) {
    packAdd({ key: "potion", sub: it.key, name: it.name, qty: 1 });
  } else if (it.key === "scroll") {
    packAdd({ key: "scroll", sub: it.scroll, name: it.name, qty: 1 });
  } else {
    // weapon / armour / ring / wand -> the backpack
    packAdd({ key: it.key, name: it.name, weapon: it.weapon,
              armour: it.armour, ring: it.ring, wand: it.wand });
  }
  stock.splice(idx, 1);
  logMsg("You buy the " + displayName(it) + " for " + it.price +
         " gold.", "good");
  sfx("pickup");
  return true;
}

/* a plain-language description of the tile / item under the player,
 * or null for unremarkable floor */
function describeUnderfoot() {
  const p = G.player;
  const it = G.items.find(i => i.x === p.x && i.y === p.y);
  if (it) {
    if (it.key === "gold") return it.amount + " gold pieces";
    if (it.key === "missile") return it.count + " " + it.missile.name + "s";
    return displayName(it);
  }
  if (G.orbPos && p.x === G.orbPos.x && p.y === G.orbPos.y) {
    return "the Crown";
  }
  switch (G.level.tiles[p.y][p.x]) {
    case T.STAIRS_DOWN: return "a staircase down (press >)";
    case T.STAIRS_UP: return "a staircase up (press <)";
    case T.DOOR_OPEN: return "an open doorway";
    case T.DOOR_LOCKED: return "a locked door (walk into it to bash)";
    case T.DOOR_STEEL: return "a steel door (it will take some bashing)";
    case T.GATE: return "a great gate";
    case T.WATER: return "shallow water";
    case T.ALTAR:
      return "an altar of " +
        (G.level.altarGod ? godName(G.level.altarGod) : "a forgotten god");
    case T.BRANCH: {
      const e = (G.level.entrances || []).find(
        en => en.x === p.x && en.y === p.y);
      return e ? "a passage down to the " + BRANCHES[e.branch].name +
                 " (press >)" : "a branch passage";
    }
    case T.SHOP: return "a shop";
    case T.WATER: return "shallow water -- you can wade through";
    case T.DEEP_WATER: return "deep water";
    case T.WELL: return "a well -- step on it to drink and heal";
    case T.SHRINE: return "a shrine -- step on it for a blessing";
    case T.GRAVE: return "a gravestone";
    case T.CAMPSITE: return "an abandoned camp -- rest here";
    case T.IDOL: return "a pagan idol -- touch it and find out";
    case T.MANA_NODE: return "a crystal node -- restores MP";
    case T.SIGNPOST: return "a wayfinder signpost";
    case T.BEACON: return "an unlit beacon -- light it to reveal the area";
    case T.WISHING_WELL: return "a wishing well -- toss in your luck";
    case T.STANDING_STONE: return "a standing stone, part of an old henge";
    case T.FLOWERS: return "a patch of wildflowers";
    case T.LECTERN: return "a wayside lectern";
    case T.FRUIT_CACHE: return "a cache of fruit";
    default: return null;
  }
}

/* describe whatever is on tile (x, y) -- a monster, an item, or the
 * terrain -- for the mouse-hover tooltip. null if the tile is
 * unexplored. */
function describeTileAt(x, y) {
  // on the Surface, x/y are world coords; off the Surface they are
  // chunk-local. Resolve to the chunk-local cell of the appropriate
  // chunk for tile lookups.
  const isSurface = G && G.branch === "Surface";
  let cx = 0, cy = 0, lx = x, ly = y, chunkLvl = G.level;
  let chunkSeen = G.seen, chunkVis = G.visible;
  let chunkMons = G.monsters, chunkItems = G.items;
  let pHere = G.player.x, pHereY = G.player.y;
  if (isSurface) {
    cx = Math.floor(x / MAP_W); cy = Math.floor(y / MAP_H);
    lx = x - cx * MAP_W; ly = y - cy * MAP_H;
    const d = chunkData(cx, cy);
    chunkLvl = d.level; chunkSeen = d.seen; chunkVis = d.visible;
    chunkMons = d.monsters || []; chunkItems = d.items || [];
    pHere = G.player.x + G.surfaceCoord.cx * MAP_W;
    pHereY = G.player.y + G.surfaceCoord.cy * MAP_H;
  } else if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) {
    return null;
  }
  if (!chunkSeen[ly] || !chunkSeen[ly][lx]) return null;
  const vis = chunkVis[ly] && chunkVis[ly][lx];
  if (pHere === x && pHereY === y) return "you, the adventurer";
  if (vis) {
    const m = chunkMons.find(mo => mo.x === lx && mo.y === ly);
    if (m) {
      const status = m.feared > 0 ? ", fleeing"
                   : m.neutral ? ", peaceful"
                   : (m.awake ? "" : ", asleep");
      const head = m.name + " — " + Math.max(0, m.hp) + "/" + m.hpMax +
                   " HP" + status;
      const lore = m.def && m.def.lore;
      return lore ? head + "\n" + lore : head;
    }
    const it = chunkItems.find(i => i.x === lx && i.y === ly);
    if (it) {
      if (it.key === "gold") return it.amount + " gold pieces";
      if (it.key === "missile") {
        return it.count + " " + it.missile.name + "s";
      }
      if (it.key === "gem") return it.name + " (" + it.value + " gp)";
      return displayName(it);
    }
    if (G.orbPos && G.orbPos.x === lx && G.orbPos.y === ly) {
      return "the Crown";
    }
  }
  const trap = (chunkLvl.traps || []).find(
    tr => tr.known && tr.x === lx && tr.y === ly);
  if (trap) return "a " + trap.kind + " trap";
  switch (chunkLvl.tiles[ly][lx]) {
    case T.WALL: return "rock wall";
    case T.FLOOR: return "stone floor";
    case T.STAIRS_DOWN: return "a staircase down";
    case T.STAIRS_UP: return "a staircase up";
    case T.DOOR: return "a closed door";
    case T.DOOR_OPEN: return "an open door";
    case T.DOOR_LOCKED: return "a locked door";
    case T.DOOR_STEEL: return "a steel door";
    case T.GATE: return "a great gate";
    case T.WATER: return "shallow water";
    case T.LAVA: return "a pool of lava";
    case T.TREE: return "a tree";
    case T.ALTAR:
      return "an altar of " +
        (chunkLvl.altarGod ? godName(chunkLvl.altarGod) : "a god");
    case T.BRANCH: {
      const e = (chunkLvl.entrances || []).find(
        en => en.x === lx && en.y === ly);
      return e ? "a passage to the " + BRANCHES[e.branch].name
               : "a branch passage";
    }
    case T.SHOP: return "a shop";
    case T.WATER: return "shallow water";
    case T.DEEP_WATER: return "deep water";
    case T.WELL: return "a well";
    case T.SHRINE: return "a shrine";
    case T.GRAVE: return "a gravestone";
    case T.CAMPSITE: return "an abandoned camp";
    case T.IDOL: return "a pagan idol";
    case T.MANA_NODE: return "a crystal node";
    case T.SIGNPOST: return "a wayfinder signpost";
    case T.BEACON: return "an unlit beacon";
    case T.WISHING_WELL: return "a wishing well";
    case T.STANDING_STONE: return "a standing stone";
    case T.FLOWERS: return "wildflowers";
    case T.LECTERN: return "a lectern";
    case T.FRUIT_CACHE: return "a fruit cache";
    default: return null;
  }
}

/* fill the inventory overlay with a clean, readable list */
function renderInventory() {
  const el = document.getElementById("inv-body");
  if (!el) return;
  const p = G.player;
  const row = (slot, val, empty) =>
    `<div class="inv-row"><span class="inv-slot">${slot}</span>` +
    `<span class="inv-val${empty ? " inv-empty" : ""}">${val}</span></div>`;
  let html = "";
  html += row("Weapon", "<b>" + weaponLabel(p.weapon) + "</b>");
  html += row("Armour", p.armour
    ? "<b>" + armourLabel(p.armour) + "</b> &nbsp;AC +" + p.armour.ac
    : "&mdash; nothing worn", !p.armour);
  html += row("Ring", p.ring
    ? "<b>ring of " + p.ring.name + "</b> +" + p.ring.plus
    : "&mdash; none", !p.ring);
  html += row("Wand", p.wand
    ? "<b>wand of " + p.wand.name + "</b> &nbsp;" + p.wand.charges +
      " charges"
    : "&mdash; none", !p.wand);
  html += row("Quiver", p.quiver
    ? "<b>" + p.quiver.count + "</b> " + p.quiver.name + "s"
    : "&mdash; empty", !p.quiver);
  html += row("Gold", "<b>" + p.gold + "</b> pieces");
  if (p.spells.length) {
    html += row("Spells", p.spells.map(id => {
      const s = spellById(id);
      return s ? s.title : id;
    }).join(", "));
  }
  if (p.god) {
    html += row("Religion", "<b>" + godName(p.god) + "</b> &nbsp;piety " +
      p.piety + "/200");
  }
  // the backpack -- one list of everything carried; a letter uses it
  html += "<hr>";
  if (p.pack.length) {
    html += `<div class="inv-row"><span class="inv-slot">Backpack</span>` +
      `<span class="inv-val inv-empty">click an item (or press its letter) ` +
      `to wield / wear / quaff / read</span></div>`;
    p.pack.forEach((it, i) => {
      let desc = (it.key === "potion" || it.key === "scroll")
        ? displayName(it) : it.name;
      if (it.qty && it.qty > 1) desc += " &times;<b>" + it.qty + "</b>";
      if (it.key === "gem" && it.value) {
        desc += " &nbsp;" + it.value + " gp each";
      }
      if (it.key === "armour" && it.armour) {
        desc += " &nbsp;AC +" + it.armour.ac;
      } else if (it.key === "wand" && it.wand) {
        desc += " &nbsp;" + it.wand.charges + " charges";
      } else if (it.key === "ring" && it.ring) {
        desc += " +" + it.ring.plus;
      } else if (it.key === "weapon" && it.weapon) {
        desc += " &nbsp;dam " + it.weapon.sides;
      } else if (it.key === "key") {
        desc = "<span style='color:#ffd24a'>" + desc + "</span> &nbsp;<i>unlocks a door</i>";
      } else if (it.questRelic) {
        desc = "<span style='color:#ffd24a'>&#9733; " + desc +
               "</span> &nbsp;<i>a king awaits this</i>";
      }
      html += `<div class="inv-row inv-clickable" data-use-pack="${i}">` +
        `<span class="inv-slot">` +
        String.fromCharCode(97 + i) + `)</span>` +
        `<span class="inv-val">${desc}</span></div>`;
    });
  } else {
    html += `<div class="inv-row"><span class="inv-slot">Backpack</span>` +
      `<span class="inv-val inv-empty">&mdash; empty</span></div>`;
  }
  html += "<hr>";
  const uf = describeUnderfoot();
  const here = G.items.some(i => i.x === p.x && i.y === p.y);
  html += `<div class="inv-here">You are standing on ${uf || "bare floor"}.` +
    (here ? " &mdash; press <b>g</b> to pick it up." : "") + `</div>`;
  el.innerHTML = html;
}

/* =============================================================
 * Mouse input -- click a tile to walk / attack, click yourself to
 * wait or pick up, and use the on-screen action buttons. Keyboard
 * still works; the two share the same underlying actions.
 * ============================================================= */

let hoverTile = null;
let walkTimer = null;            // setTimeout handle for auto-walk

/* breadth-first path over *explored* passable tiles, avoiding
 * monsters. Returns an array of {x,y} steps (excluding the start),
 * or null if there is no known route. */
function findPath(sx, sy, tx, ty) {
  if (sx === tx && sy === ty) return [];
  const lvl = G.level;
  const seen = [];
  const prev = [];
  for (let y = 0; y < MAP_H; y++) {
    seen.push(new Array(MAP_W).fill(false));
    prev.push(new Array(MAP_W).fill(null));
  }
  // every closed door (plain, locked, steel, gated) counts as walkable
  // -- travel opens or bashes them as the player crosses. The Surface
  // has no fog of war, so its pathing ignores the seen check.
  const isSurface = G.branch === "Surface";
  const walkable = (x, y) => {
    if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) return false;
    if (!isSurface && !G.seen[y][x]) return false;
    if (passable(lvl, x, y)) return true;
    const t = lvl.tiles[y][x];
    return t === T.DOOR || t === T.DOOR_LOCKED ||
           t === T.DOOR_STEEL || t === T.GATE;
  };
  const monAt = (x, y) => G.monsters.some(m => m.x === x && m.y === y);
  const q = [[sx, sy]];
  seen[sy][sx] = true;
  let head = 0;
  const DIRS = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
  while (head < q.length) {
    const [x, y] = q[head++];
    if (x === tx && y === ty) {
      const path = [];
      let cx = x, cy = y;
      while (!(cx === sx && cy === sy)) {
        path.push({ x: cx, y: cy });
        const p = prev[cy][cx];
        cx = p[0]; cy = p[1];
      }
      path.reverse();
      return path;
    }
    for (const [dx, dy] of DIRS) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= MAP_W || ny >= MAP_H) continue;
      if (seen[ny][nx] || !walkable(nx, ny)) continue;
      // never route through a monster (the destination may be one,
      // but travel targets are empty tiles)
      if (monAt(nx, ny) && !(nx === tx && ny === ty)) continue;
      seen[ny][nx] = true;
      prev[ny][nx] = [x, y];
      q.push([nx, ny]);
    }
  }
  return null;
}

/* the monster (if any) occupying world coord (wx,wy), looking up
 * the right chunk (current or cached neighbour) for that tile */
function monsterAtWorld(wx, wy) {
  if (G.branch !== "Surface") return null;
  const cx = Math.floor(wx / MAP_W), cy = Math.floor(wy / MAP_H);
  const lx = wx - cx * MAP_W, ly = wy - cy * MAP_H;
  const d = chunkData(cx, cy);
  return (d.monsters || []).find(m => m.x === lx && m.y === ly) || null;
}

/* BFS from (sx,sy) within the current chunk, returning the path to
 * whichever reachable cell sits closest (in world Chebyshev distance)
 * to (dwx, dwy). This handles clicks on unwalkable biome (mountain,
 * tree, water) and cross-chunk clicks gracefully -- the player walks
 * as close as they can. Returns null if no movement is possible. */
function findPathTowardWorld(sx, sy, dwx, dwy) {
  const lvl = G.level;
  const sc = G.surfaceCoord || { cx: 0, cy: 0 };
  const seen = [];
  const prev = [];
  for (let y = 0; y < MAP_H; y++) {
    seen.push(new Array(MAP_W).fill(false));
    prev.push(new Array(MAP_W).fill(null));
  }
  const walkable = (x, y) => {
    if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) return false;
    if (passable(lvl, x, y)) return true;
    const t = lvl.tiles[y][x];
    return t === T.DOOR || t === T.DOOR_LOCKED ||
           t === T.DOOR_STEEL || t === T.GATE;
  };
  const monAt = (x, y) => G.monsters.some(m => m.x === x && m.y === y) ||
                          (G.npcs || []).some(n => n.x === x && n.y === y);
  const distAt = (x, y) => {
    const wx = sc.cx * MAP_W + x, wy = sc.cy * MAP_H + y;
    return Math.max(Math.abs(wx - dwx), Math.abs(wy - dwy));
  };
  seen[sy][sx] = true;
  const q = [[sx, sy]];
  let head = 0;
  let bestX = sx, bestY = sy, bestD = distAt(sx, sy);
  const DIRS = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
  while (head < q.length) {
    const [x, y] = q[head++];
    for (const [dx, dy] of DIRS) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= MAP_W || ny >= MAP_H) continue;
      if (seen[ny][nx]) continue;
      if (!walkable(nx, ny)) continue;
      if (monAt(nx, ny)) continue;
      seen[ny][nx] = true;
      prev[ny][nx] = [x, y];
      q.push([nx, ny]);
      const d = distAt(nx, ny);
      if (d < bestD) { bestD = d; bestX = nx; bestY = ny; }
    }
  }
  if (bestX === sx && bestY === sy) return null;
  const path = [];
  let cx = bestX, cy = bestY;
  while (!(cx === sx && cy === sy)) {
    path.push({ x: cx, y: cy });
    const p = prev[cy][cx];
    cx = p[0]; cy = p[1];
  }
  path.reverse();
  return path;
}

function cancelWalk() {
  if (walkTimer) { clearTimeout(walkTimer); walkTimer = null; }
  if (G) { G.walkPath = null; G.walkDestWorld = null; }
}

/* camping -- a multi-turn rest that ticks endTurn() until HP and MP
 * are full or anything interrupts. A visible monster, a damage tick,
 * a status change, or any other input all break the camp. */
let restTimer = null;

function cancelRest() {
  if (restTimer) { clearTimeout(restTimer); restTimer = null; }
  if (G) G.camping = false;
}

function startCamp() {
  if (!G || G.over) return;
  cancelWalk();
  cancelRest();
  if (G.monsters.some(m => G.visible[m.y] && G.visible[m.y][m.x])) {
    logMsg("You cannot make camp -- there are enemies in sight.", "warn");
    render();
    return;
  }
  const pp = G.player;
  // sleeping at home: on a HEARTH or BED, you bed down until dawn
  // even if you're already healed. A time-skip for waiting out the
  // moon, a hostile phase, or a tracked NPC's schedule.
  const here = (G.level && G.level.tiles[pp.y] && G.level.tiles[pp.y][pp.x]) | 0;
  const atHome = here === T.HEARTH || here === T.BED;
  if (!atHome && pp.hp >= pp.hpMax && pp.mp >= pp.mpMax) {
    logMsg("You are already fully rested.", "dim");
    render();
    return;
  }
  G.camping = true;
  G.campStartTurn = G.turn;
  G.campSleepUntilDawn = !!atHome;
  logMsg(atHome
    ? "You bed down. Sleeping until dawn..."
    : "You set up camp and rest.", "sys");
  restTimer = setTimeout(stepRest, 30);
}

/* ---------- quests + NPC dialog ----------
 * Friendly NPCs hand out one quest each. Two kinds: "kill" (slay N of
 * monster X), "fetch" (bring a potion / scroll of type Y). Progress
 * ticks in killMonster + doPickup, turn-in happens by talking to the
 * giver. The player can track one quest -- the sidebar compass points
 * at the giver's world position. */
const POTION_FETCH_POOL = ["heal", "might", "haste", "magic"];
const SCROLL_FETCH_POOL = ["teleport", "fear", "mapping"];

function itemDisplayName(key, sub) {
  if (key === "potion" && POTION_FLAVOR[sub]) return POTION_FLAVOR[sub].name;
  if (key === "scroll" && SCROLL_FLAVOR[sub]) return SCROLL_FLAVOR[sub].name;
  return sub;
}

function questPickKillTarget() {
  // surface villagers ask for the things that actually trouble them:
  // wild animals and brigands. Once in a while a cellar weirdo if the
  // surface pool is empty.
  let pool = (DATA.monsters || []).filter(m =>
    (m.biome === "surface_animal" || m.biome === "surface_humanoid") &&
    m.tier >= 1 && m.tier <= 2 && m.name && m.name.length < 28);
  if (!pool.length) {
    pool = (DATA.monsters || []).filter(m =>
      m.tier >= 1 && m.tier <= 2 && m.name && m.name.length < 28);
  }
  return pool.length ? pick(pool) : null;
}

/* pick a (chunk, building) that has a cellar (or upper floor) and is
 * different from the giver -- used by rescue quests to choose a place
 * for the captive. Scans up to `radius` chunks from the giver. */
function findRescueSite(giverCX, giverCY, radius) {
  const r = radius == null ? 3 : radius;
  const candidates = [];
  for (let dx = -r; dx <= r; dx++) {
    for (let dy = -r; dy <= r; dy++) {
      const cx = giverCX + dx, cy = giverCY + dy;
      const data = ensureSurfaceChunk(cx, cy);
      const blds = data.level.buildings || [];
      for (let i = 0; i < blds.length; i++) {
        const b = blds[i];
        if (!b.cellarStair) continue;
        // skip the giver's own building (player must travel)
        if (cx === giverCX && cy === giverCY) continue;
        candidates.push({ cx, cy, bidx: i, type: b.type });
      }
    }
  }
  return candidates.length ? pick(candidates) : null;
}

/* a KING'S quest: retrieve a named relic from a guarded chest in a
 * distant building. Heavy reward, real risk -- the chest is in another
 * castle / manor and is watched by neutral guards who turn hostile the
 * moment the chest leaves the lid. */
const RELIC_NAMES = [
  "Crown of Vainglory", "Sceptre of the First Dawn", "Orb of Whispers",
  "Chalice of the Long Night", "Mantle of Storms", "Blade of the Eclipse",
  "Tome of Hollow Names", "Heart of the Mountain",
];
function makeKingQuest(npc) {
  const giverCX = G.surfaceCoord.cx, giverCY = G.surfaceCoord.cy;
  const site = findRescueSite(giverCX, giverCY, 5);
  if (!site) return null;
  const relic = pick(RELIC_NAMES);
  const id = "q" + (G.quests.length + 1);
  const giver = { chunkCX: giverCX, chunkCY: giverCY,
                  x: npc.x, y: npc.y, name: npc.name };
  const q = {
    id, giver, type: "retrieve",
    targetAt: { cx: site.cx, cy: site.cy, bidx: site.bidx },
    relic,
    status: "active",
    reward: { gold: ri(300, 500) },
    hook: "I, " + npc.name + ", charge you with the recovery of the " +
          relic + ". It was lost to the " + site.type +
          " at " + regionNameFor(site.cx, site.cy) +
          " (" + site.cx + "," + site.cy + "). Brave the guards.",
    greeting: "Approach the throne, traveller.",
  };
  // pre-place the relic in a chest at the target. Use any existing
  // chest, or spawn a new tier-4 chest in the deepest room.
  ensureSurfaceChunk(site.cx, site.cy);
  const entry = G.levels["Surface:" + site.cx + "," + site.cy];
  if (entry) {
    let chest = (entry.items || []).find(it => it.key === "chest");
    if (!chest) {
      const lvl = entry.level;
      const b = lvl.buildings && lvl.buildings[site.bidx];
      if (b && b.rooms && b.rooms.length) {
        const room = b.rooms[b.rooms.length - 1];
        const cells = pickInteriorCells(lvl.tiles, room);
        if (cells.length) {
          const c = cells[ri(0, cells.length - 1)];
          chest = makeChestItem(4, c.x, c.y);
          entry.items.push(chest);
        }
      }
    }
    if (chest) { chest.questRelic = relic; chest.questId = id; }
  }
  G.quests.push(q);
  npc.questId = id;
  return q;
}

function makeQuestForNPC(npc) {
  if (npc && npc.kind === "king") return makeKingQuest(npc);
  // roll a quest type. Rescue requires a nearby building with a cellar;
  // if one isn't around, fall through to fetch/kill.
  const roll = Math.random();
  let questType = "kill";
  if (roll < 0.30) questType = "rescue";
  else if (roll < 0.65) questType = "fetch";
  const id = "q" + (G.quests.length + 1);
  const giver = {
    chunkCX: G.surfaceCoord.cx, chunkCY: G.surfaceCoord.cy,
    x: npc.x, y: npc.y, name: npc.name,
  };
  let q;
  if (questType === "rescue") {
    const site = findRescueSite(giver.chunkCX, giver.chunkCY, 3);
    if (site) {
      const kin = pick(["sister", "cousin", "apprentice",
                        "friend", "child"]);
      const captiveName = pick(NPC_NAMES_M.concat(NPC_NAMES_F));
      q = { id, giver, type: "rescue",
            rescueAt: { cx: site.cx, cy: site.cy,
                        bidx: site.bidx, floor: -1 },
            captiveCellarBidx: null,
            captiveName, kin,
            count: 1, progress: 0, rescued: false,
            reward: { gold: ri(70, 130) },
            status: "active",
            hook: "My " + kin + " " + captiveName +
                  " was taken to a cellar at " +
                  regionNameFor(site.cx, site.cy) +
                  " (" + site.cx + "," + site.cy +
                  "). Search the cellars there -- bring them home." };
      q.greeting = pick(QUEST_GREETINGS);
      G.quests.push(q);
      npc.questId = id;
      return q;
    }
    // no rescue site nearby -- fall back to fetch
    questType = "fetch";
  }
  const isFetch = questType === "fetch";
  if (isFetch) {
    const isPot = chance(0.7);
    const key = isPot ? "potion" : "scroll";
    const sub = isPot ? pick(POTION_FETCH_POOL) : pick(SCROLL_FETCH_POOL);
    // baseline = how many of this exact item the player already has at
    // accept time. The quest is complete only when they've acquired one
    // MORE than they were carrying when the giver asked -- so starting
    // potions / scrolls don't auto-redeem the moment they hear the ask.
    const baseline = (G.player.pack || [])
      .filter(it => it.key === key && it.sub === sub)
      .reduce((sum, it) => sum + (it.qty || 1), 0);
    q = { id, giver, type: "fetch",
          target: { key, sub },
          count: 1, progress: 0, baseline,
          reward: { gold: ri(45, 85) },
          status: "active",
          hook: "Bring me a " + itemDisplayName(key, sub) +
                " and I'll see you well paid." };
  } else {
    const mon = questPickKillTarget();
    if (!mon) return null;
    const count = ri(2, 4);
    q = { id, giver, type: "kill",
          target: { monsterName: mon.name },
          count, progress: 0,
          reward: { gold: ri(25, 50) + count * 12 },
          status: "active",
          hook: "Slay " + count + " " + mon.name +
                (count > 1 ? "s" : "") + " on the wilds." };
  }
  q.greeting = pick(QUEST_GREETINGS);
  G.quests.push(q);
  npc.questId = id;
  return q;
}

/* a friendly NPC takes a random step within their building's interior
 * room. Stays put if no free adjacent FLOOR cell is reachable, or if
 * the player would lose track of them mid-talk. Captives also wander
 * once freed so they don't block the doorway. */
/* random ambient banter for NPCs in view -- pulled from a per-kind
 * pool, shown as a speech bubble above their head for a few turns.
 * NPCs with editor-written dialog get the first line of that as a
 * bark instead, so authored speech actually comes out of their mouth. */
const NPC_BARKS = {
  questgiver: [
    "Stranger. Stay sharp out there.",
    "These roads aren't what they were.",
    "Travel safe.",
    "If you're hunting work, ask around.",
    "Quiet days are good days.",
    "I don't remember the last time it rained.",
    "Mind the cellar -- something moves in it.",
    "My grandfather walked to the castle. Imagine that.",
  ],
  shopkeeper: [
    "Looking? Or buying?",
    "Fresh stock today.",
    "No haggling.",
    "Coin first, fingers later.",
    "Step right in.",
    "I sold the last healing potion this morning.",
    "Spend it before the road claims you.",
  ],
  king: [
    "Approach, traveller.",
    "Few cross my threshold uninvited.",
    "The relic must be returned. The realm depends on it.",
    "Speak plainly in my hall.",
    "Even kings sleep poorly these days.",
  ],
  child: [
    "Mum says don't talk to strangers!",
    "Did you fight a dragon??",
    "Watch my chicken!",
    "I have a secret -- bet you can't guess.",
    "The cat went under the table again.",
    "I want to be a knight when I grow up.",
    "Father says the woods are full of bandits.",
  ],
  captive: [
    "Please... help...",
    "Don't let them hear you.",
    "I won't go quiet.",
    "Is it really you? Have you come?",
  ],
};

function pickNpcBark(npc) {
  // honour authored dialog if the editor wrote one
  if (npc.dialog) {
    const first = String(npc.dialog).split(/\n/)[0].trim();
    if (first) return first.slice(0, 80);
  }
  const pool = NPC_BARKS[npc.kind] || NPC_BARKS.questgiver;
  return pick(pool);
}

function tickNpcBarks() {
  if (!G.npcs || !G.visible) return;
  // expire old barks first
  for (const n of G.npcs) {
    if (n.barkExpireTurn && G.turn >= n.barkExpireTurn) {
      n.barkText = null; n.barkExpireTurn = null;
    }
  }
  // every 5 turns, give a visible NPC a fresh line (35% chance)
  if (G.turn % 5 !== 0) return;
  if (!chance(0.35)) return;
  const visible = G.npcs.filter(n =>
    G.visible[n.y] && G.visible[n.y][n.x] && !n.barkText);
  if (!visible.length) return;
  const n = pick(visible);
  n.barkText = pickNpcBark(n);
  n.barkExpireTurn = G.turn + 6;       // about 6 player turns
}

function npcWander(npc) {
  if (!npc || G.over) return;
  // skip captives (they stand still until rescued; once freed they're
  // removed from the level entirely)
  if (npc.kind === "captive") return;
  // do nothing while talking to this NPC -- they'd walk out from under
  // the dialog overlay otherwise
  if (npcOpen === npc) return;
  // 60% of ticks the NPC just rests
  if (chance(0.6)) return;
  // find the building they belong to -- only step within its rooms
  const b = (G.level.buildings || [])[npc.building];
  const DIRS = [[1,0],[-1,0],[0,1],[0,-1]];
  const cands = [];
  for (const [dx, dy] of DIRS) {
    const nx = npc.x + dx, ny = npc.y + dy;
    if (nx < 0 || ny < 0 || nx >= MAP_W || ny >= MAP_H) continue;
    if (!passable(G.level, nx, ny)) continue;
    if ((G.npcs || []).some(o => o !== npc && o.x === nx && o.y === ny)) continue;
    if (G.monsters.some(m => m.x === nx && m.y === ny)) continue;
    if (G.player.x === nx && G.player.y === ny) continue;
    // shopkeepers stay on / next to their counter; questgivers may roam
    // their building but not leave it
    if (b) {
      const inBld = nx > b.x && nx < b.x + b.w - 1 &&
                    ny > b.y && ny < b.y + b.h - 1;
      if (!inBld) continue;
      if (npc.kind === "shopkeeper") {
        // shopkeepers stay within 2 tiles of their original spot
        if (npc.homeX == null) { npc.homeX = npc.x; npc.homeY = npc.y; }
        if (Math.abs(nx - npc.homeX) > 2 ||
            Math.abs(ny - npc.homeY) > 2) continue;
      }
    }
    cands.push([nx, ny]);
  }
  if (!cands.length) return;
  const [nx, ny] = cands[ri(0, cands.length - 1)];
  npc.x = nx;
  npc.y = ny;
}

function ensureQuestForNPC(npc) {
  if (!npc) return null;
  if (npc.kind !== "questgiver" && npc.kind !== "king") return null;
  if (npc.questId) {
    const q = G.quests.find(x => x.id === npc.questId);
    if (q) return q;
  }
  return makeQuestForNPC(npc);
}

function questIsComplete(q) {
  if (!q || q.status !== "active") return false;
  if (q.type === "kill") return q.progress >= q.count;
  if (q.type === "fetch") {
    const have = (G.player.pack || [])
      .filter(it => it.key === q.target.key && it.sub === q.target.sub)
      .reduce((sum, it) => sum + (it.qty || 1), 0);
    return have > (q.baseline || 0);
  }
  if (q.type === "rescue") return !!q.rescued;
  if (q.type === "retrieve") {
    return (G.player.pack || []).some(it =>
      it.questRelic && it.questId === q.id);
  }
  return false;
}

function turnInQuest(id) {
  const q = G.quests.find(x => x.id === id);
  if (!q || q.status !== "active" || !questIsComplete(q)) return false;
  if (q.type === "fetch") {
    const idx = G.player.pack.findIndex(it =>
      it.key === q.target.key && it.sub === q.target.sub);
    if (idx < 0) return false;
    const it = G.player.pack[idx];
    if (it.qty && it.qty > 1) it.qty--;
    else G.player.pack.splice(idx, 1);
  } else if (q.type === "retrieve") {
    const idx = G.player.pack.findIndex(it =>
      it.questRelic && it.questId === q.id);
    if (idx < 0) return false;
    G.player.pack.splice(idx, 1);
  }
  G.player.gold += q.reward.gold;
  q.status = "turnedIn";
  sfx("pickup");
  logMsg("Quest complete! You receive " + q.reward.gold + " gold.", "good");
  if (G.trackedQuest === id) G.trackedQuest = null;
  return true;
}

/* hook quests to combat + pickup events */
function tickKillQuests(monDefName) {
  for (const q of (G.quests || [])) {
    if (q.status !== "active") continue;
    if (q.type !== "kill") continue;
    if (q.target.monsterName !== monDefName) continue;
    if (q.progress >= q.count) continue;
    q.progress++;
    if (q.progress === q.count) {
      logMsg("Quest progress: " + monDefName + " quota met for " +
             q.giver.name + ".", "good");
    }
  }
}

/* NPC dialog overlay */
let npcOpen = null;

function openNPCDialog(npc) {
  if (!npc) return;
  ensureQuestForNPC(npc);
  npcOpen = npc;
  renderNPCDialog();
  const ov = document.getElementById("npc-overlay");
  if (ov) ov.classList.remove("hidden");
}

function closeNPCDialog() {
  npcOpen = null;
  const ov = document.getElementById("npc-overlay");
  if (ov) ov.classList.add("hidden");
  render();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;",
    '"': "&quot;", "'": "&#39;",
  }[c]));
}

function renderNPCDialog() {
  const el = document.getElementById("npc-body");
  if (!el || !npcOpen) return;
  const npc = npcOpen;
  const q = npc.questId
    ? G.quests.find(x => x.id === npc.questId) : null;
  let html = `<h2>${npc.name}</h2>`;
  // an editor-written dialog overrides the auto-generated greeting --
  // each line of npc.dialog renders as its own paragraph
  if (npc.dialog) {
    const lines = String(npc.dialog).split(/\n+/).filter(s => s.trim());
    for (const line of lines) {
      html += `<p>${escapeHtml(line)}</p>`;
    }
    if (!q) {
      html += `<button class="big-btn" data-quest-act="close">Leave</button>`;
      el.innerHTML = html;
      return;
    }
    // dialog + quest: show dialog first, then quest controls below
  }
  if (!q) {
    html += `<p>${npc.name} smiles, but has nothing pressing.</p>`;
  } else if (q.status === "turnedIn") {
    html += `<p>"${npc.name} has no more work for you today."</p>`;
  } else if (questIsComplete(q)) {
    html += `<p>"You've done it. Take this with my thanks."</p>` +
            `<p><b>Reward:</b> ${q.reward.gold} gold` +
            (q.type === "fetch"
              ? ` (you'll hand over the ${itemDisplayName(q.target.key, q.target.sub)})`
              : "") + `</p>` +
            `<button class="big-btn" data-quest-act="claim:${q.id}">` +
            `Claim reward</button> ` +
            `<button class="big-btn" data-quest-act="close">Later</button>`;
  } else {
    html += `<p>"${q.greeting}"</p>` +
            `<p>${q.hook}</p>` +
            `<p><b>Reward:</b> ${q.reward.gold} gold</p>`;
    if (q.type === "kill") {
      html += `<p>Progress: <b>${q.progress}</b> / ${q.count} ` +
              `${q.target.monsterName}s slain</p>`;
    } else if (q.type === "fetch") {
      const has = G.player.pack.find(it =>
        it.key === q.target.key && it.sub === q.target.sub);
      html += `<p>You ${has ? "carry one" : "do not carry one"}.</p>`;
    } else if (q.type === "rescue") {
      html += `<p>The captive is held in a cellar somewhere at ` +
              `${regionNameFor(q.rescueAt.cx, q.rescueAt.cy)} ` +
              `(${q.rescueAt.cx},${q.rescueAt.cy}). ` +
              (q.rescued
                ? "You've freed them!"
                : "Check every cellar in the region.") +
              `</p>`;
    } else if (q.type === "retrieve") {
      const has = (G.player.pack || []).some(it =>
        it.questRelic && it.questId === q.id);
      html += `<p>Recover the <b>${q.relic}</b> from ` +
              `${regionNameFor(q.targetAt.cx, q.targetAt.cy)} ` +
              `(${q.targetAt.cx},${q.targetAt.cy}).</p>` +
              `<p>You ${has ? "carry the relic" : "do not yet hold it"}.</p>`;
    }
    html += `<button class="big-btn" data-quest-act="track:${q.id}">` +
            (G.trackedQuest === q.id ? "Untrack" : "Track on compass") +
            `</button> ` +
            `<button class="big-btn" data-quest-act="close">Leave</button>`;
  }
  el.innerHTML = html;
}

/* world map overlay (M key) -- visualises every Surface chunk the
 * player has visited (cached in G.levels). Each chunk is a square
 * tinted by its dominant biome with a building icon overlaid; the
 * player's chunk pulses, and the tracked quest gets a flag marker. */
let mapOpen = false;
function openWorldMap() {
  mapOpen = true;
  renderWorldMap();
  const ov = document.getElementById("map-overlay");
  if (ov) ov.classList.remove("hidden");
}
function closeWorldMap() {
  mapOpen = false;
  const ov = document.getElementById("map-overlay");
  if (ov) ov.classList.add("hidden");
  render();
}
const BIOME_MAP_COLOUR = {
  plains: "#3d5b2c", forest: "#244a1d", mountains: "#5c5c64",
  swamp: "#3a3a1f", lake: "#1f3c5b",
};
// world-map layout snapshot, re-written by renderWorldMap and read by
// the mousemove handler in init() so hover can resolve pixel -> chunk
let MAP_LAYOUT = null;

function renderWorldMap() {
  const cv = document.getElementById("world-map");
  if (!cv || !cv.getContext) return;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#0c1014";
  ctx.fillRect(0, 0, cv.width, cv.height);
  // collect visited Surface chunks from cache + current chunk
  const visited = new Set();
  const buildingHits = {};
  const poiHits = {};    // key "cx,cy" -> Set of POI tile kinds in the chunk
  const castleHits = {};   // chunks with at least one castle
  const kingHits = {};     // chunks that hold a king
  const collect = (cx, cy, lvl) => {
    const key = cx + "," + cy;
    visited.add(key);
    if ((lvl.buildings || []).length) buildingHits[key] = lvl.buildings.length;
    if ((lvl.buildings || []).some(b => b.type === "castle"))
      castleHits[key] = true;
    if ((lvl.npcs || []).some(n => n.kind === "king")) kingHits[key] = true;
    if ((lvl.poiCells || []).length) {
      const kinds = new Set();
      for (const p of lvl.poiCells) kinds.add(p.t);
      poiHits[key] = kinds;
    }
  };
  for (const k in (G.levels || {})) {
    if (!k.startsWith("Surface:")) continue;
    const coords = k.slice("Surface:".length).split(",").map(Number);
    if (coords.length !== 2 || !Number.isFinite(coords[0]) ||
        !Number.isFinite(coords[1])) continue;
    collect(coords[0], coords[1], G.levels[k].level);
  }
  if (G.branch === "Surface" || G.surfaceCoord) {
    const sc = G.surfaceCoord || { cx: 0, cy: 0 };
    collect(sc.cx, sc.cy, G.level || { buildings: [] });
  }
  if (!visited.size) {
    ctx.fillStyle = "#888";
    ctx.font = "16px monospace";
    ctx.textAlign = "center";
    ctx.fillText("You haven't visited the Surface yet.",
                 cv.width / 2, cv.height / 2);
    return;
  }
  // bounding box
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const k of visited) {
    const [x, y] = k.split(",").map(Number);
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  // expand by 1 chunk for context
  minX--; minY--; maxX++; maxY++;
  const w = maxX - minX + 1, h = maxY - minY + 1;
  // fit into canvas; max cell 32, min 8
  const cell = Math.max(8, Math.min(32,
    Math.floor(Math.min((cv.width - 20) / w, (cv.height - 40) / h))));
  const ox = Math.floor((cv.width  - cell * w) / 2);
  const oy = Math.floor((cv.height - cell * h) / 2);
  // expose layout so the hover handler can hit-test the canvas
  MAP_LAYOUT = { minX, minY, maxX, maxY, cell, ox, oy,
                 visited, buildingHits, castleHits, kingHits, poiHits };
  const sc = G.surfaceCoord || { cx: 0, cy: 0 };
  const trackedQ = G.trackedQuest
    ? (G.quests || []).find(q => q.id === G.trackedQuest) : null;
  for (let cy = minY; cy <= maxY; cy++) {
    for (let cx = minX; cx <= maxX; cx++) {
      const px = ox + (cx - minX) * cell;
      const py = oy + (cy - minY) * cell;
      const isVisited = visited.has(cx + "," + cy);
      // biome tint: pick the cell at chunk centre as the representative
      const biome = biomeAtWorld(cx * MAP_W + (MAP_W >> 1),
                                  cy * MAP_H + (MAP_H >> 1));
      const base = BIOME_MAP_COLOUR[biome] || "#3d5b2c";
      // unvisited chunks are darkened "fog"
      ctx.fillStyle = isVisited ? base : "#171a20";
      ctx.fillRect(px, py, cell - 1, cell - 1);
      if (isVisited && buildingHits[cx + "," + cy]) {
        // building dot -- castles get a bigger bright-red marker so
        // they stand out from regular homes / shops
        if (castleHits[cx + "," + cy]) {
          ctx.fillStyle = "#ff4040";
          const sz = Math.max(4, Math.floor(cell * 0.55));
          ctx.fillRect(px + ((cell - sz) >> 1),
                       py + ((cell - sz) >> 1), sz, sz);
        } else {
          ctx.fillStyle = "#d8a060";
          ctx.fillRect(px + (cell >> 2), py + (cell >> 2),
                       Math.max(2, cell >> 2), Math.max(2, cell >> 2));
        }
      }
      // POI markers -- coloured pips in the corners by category, so
      // you can see at a glance which chunks have a shrine, well, or
      // beacon you might want to revisit
      const kinds = poiHits[cx + "," + cy];
      if (kinds && cell >= 8) {
        const pip = Math.max(2, Math.floor(cell / 5));
        const drawPip = (dx, dy, col) => {
          ctx.fillStyle = col;
          ctx.fillRect(px + dx, py + dy, pip, pip);
        };
        // top-left: shrine / henge (gold)
        if (kinds.has(T.SHRINE) || kinds.has(T.STANDING_STONE))
          drawPip(1, 1, "#ffd070");
        // top-right: beacon (bright yellow)
        if (kinds.has(T.BEACON))
          drawPip(cell - pip - 2, 1, "#ffea60");
        // bottom-left: well / wishing well (cyan)
        if (kinds.has(T.WELL) || kinds.has(T.WISHING_WELL))
          drawPip(1, cell - pip - 2, "#5cd2ff");
        // bottom-right: signpost (cream)
        if (kinds.has(T.SIGNPOST))
          drawPip(cell - pip - 2, cell - pip - 2, "#d8d0a0");
      }
      // king crown -- a small star on the chunk's centre if a king
      // is enthroned here (you've already discovered this castle)
      if (kingHits[cx + "," + cy] && cell >= 12) {
        ctx.fillStyle = "#ffd24a";
        ctx.font = (Math.max(8, Math.floor(cell * 0.55))) + "px monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("★", px + (cell >> 1), py + (cell >> 1) + 1);
      }
      if (cx === sc.cx && cy === sc.cy &&
          (G.branch === "Surface" || G.branch === "Indoors")) {
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2;
        ctx.strokeRect(px + 0.5, py + 0.5, cell - 2, cell - 2);
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(px + (cell >> 1) - 1, py + (cell >> 1) - 1, 3, 3);
      }
      // player's hearth marker -- a small orange circle so the player
      // can always find their way home from the world map
      const hh = (function () {
        const h = loadPlayerHome();
        return h && h.hearth ? h.hearth : null;
      })();
      if (hh && hh.cx === cx && hh.cy === cy && cell >= 8) {
        ctx.fillStyle = "#ff8a3a";
        ctx.beginPath();
        ctx.arc(px + (cell >> 1), py + (cell >> 1),
                Math.max(3, Math.floor(cell / 4)), 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#fff1c0";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      if (trackedQ) {
        const ta = trackedQ.type === "rescue" && !trackedQ.rescued
          ? trackedQ.rescueAt
          : (trackedQ.type === "retrieve" && !questIsComplete(trackedQ))
          ? trackedQ.targetAt
          : { cx: trackedQ.giver.chunkCX, cy: trackedQ.giver.chunkCY };
        if (ta.cx === cx && ta.cy === cy) {
          ctx.fillStyle = "#ffd24a";
          ctx.beginPath();
          ctx.arc(px + (cell >> 1), py + (cell >> 1),
                  Math.max(3, cell >> 3), 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }
  const legend = document.getElementById("map-legend");
  if (legend) {
    legend.innerHTML =
      "<b>" + regionNameFor(sc.cx, sc.cy) + "</b> &middot; " +
      visited.size + " chunks explored<br>" +
      "<span style='color:#fff'>white</span> here &middot; " +
      "<span style='color:#d8a060'>orange</span> building &middot; " +
      "<span style='color:#ff4040'>RED</span> castle &middot; " +
      "<span style='color:#ffd24a'>★</span> king &middot; " +
      "<span style='color:#ffd24a'>yellow</span> quest &middot; " +
      "<span style='color:#ffd070'>&#9632;</span> shrine &middot; " +
      "<span style='color:#ffea60'>&#9632;</span> beacon &middot; " +
      "<span style='color:#5cd2ff'>&#9632;</span> well &middot; " +
      "<span style='color:#d8d0a0'>&#9632;</span> sign";
  }
}

/* quest selector overlay (Q key) */
let questListOpen = false;
function openQuestList() {
  questListOpen = true;
  renderQuestList();
  const ov = document.getElementById("quest-overlay");
  if (ov) ov.classList.remove("hidden");
}
function closeQuestList() {
  questListOpen = false;
  const ov = document.getElementById("quest-overlay");
  if (ov) ov.classList.add("hidden");
  render();
}
function renderQuestList() {
  const el = document.getElementById("quest-body");
  if (!el) return;
  const active = (G.quests || []).filter(q => q.status === "active");
  const done = (G.quests || []).filter(q => q.status === "turnedIn");
  let html = "";
  if (!active.length && !done.length) {
    html += "<p>You have not taken on any quests yet. Bump a friendly " +
            "<b>@</b> on the Surface to talk.</p>";
  }
  if (active.length) {
    html += `<h3>Active</h3>`;
    active.forEach((q, i) => {
      const isTrack = G.trackedQuest === q.id;
      const summary = q.type === "kill"
        ? `Slay ${q.target.monsterName}s (${q.progress}/${q.count})`
        : q.type === "rescue"
        ? `Rescue ${q.captiveName} from a cellar in ${regionNameFor(q.rescueAt.cx, q.rescueAt.cy)} (${q.rescueAt.cx},${q.rescueAt.cy})`
        : q.type === "retrieve"
        ? `KING'S CHARGE: Recover ${q.relic} from ${regionNameFor(q.targetAt.cx, q.targetAt.cy)} (${q.targetAt.cx},${q.targetAt.cy})`
        : `Fetch a ${itemDisplayName(q.target.key, q.target.sub)}`;
      const compl = questIsComplete(q) ? " <b>(READY)</b>" : "";
      html += `<div class="inv-row">` +
        `<span class="inv-slot">${String.fromCharCode(97 + i)})</span>` +
        `<span class="inv-val">` +
        `<b>${q.giver.name}</b>${isTrack ? " &#9673;" : ""}: ${summary}${compl}<br>` +
        `<span class="dim">at chunk (${q.giver.chunkCX},${q.giver.chunkCY})</span>` +
        `</span></div>` +
        `<div class="inv-row"><span class="inv-slot"></span>` +
        `<span class="inv-val">` +
        `<button class="big-btn" data-quest-act="track:${q.id}">` +
        (isTrack ? "Untrack" : "Track") + `</button></span></div>`;
    });
  }
  if (done.length) {
    html += `<h3>Completed</h3>`;
    done.forEach(q => {
      const sum = q.type === "kill"
        ? "killed " + q.count + " " + q.target.monsterName + "s"
        : q.type === "rescue"
        ? "rescued " + q.captiveName
        : q.type === "retrieve"
        ? "recovered the " + q.relic
        : "delivered a " + itemDisplayName(q.target.key, q.target.sub);
      html += `<div class="inv-row"><span class="inv-slot">&#10003;</span>` +
        `<span class="inv-val">${q.giver.name}: ${sum}</span></div>`;
    });
  }
  el.innerHTML = html;
}

/* handle a button click inside the NPC dialog or quest list -- act
 * encodes "claim:<id>", "track:<id>", or "close". */
function handleQuestAction(act) {
  if (!act) return;
  if (act === "close") { closeNPCDialog(); return; }
  const colon = act.indexOf(":");
  if (colon < 0) return;
  const cmd = act.slice(0, colon), id = act.slice(colon + 1);
  if (cmd === "claim") {
    if (turnInQuest(id)) {
      closeNPCDialog();
      render();
    } else {
      renderNPCDialog();
    }
    return;
  }
  if (cmd === "track") {
    G.trackedQuest = (G.trackedQuest === id) ? null : id;
    if (npcOpen) renderNPCDialog();
    if (questListOpen) renderQuestList();
    render();
    return;
  }
}

/* compass widget for the sidebar -- points to the rescue site while a
 * rescue quest is open, and to the giver otherwise (or once rescued) */
function compassHTML() {
  if (!G.trackedQuest) return "";
  const q = (G.quests || []).find(x => x.id === G.trackedQuest);
  if (!q || q.status === "turnedIn") return "";
  let tgx, tgy, target;
  if (q.type === "rescue" && !q.rescued) {
    tgx = q.rescueAt.cx * MAP_W + (MAP_W >> 1);
    tgy = q.rescueAt.cy * MAP_H + (MAP_H >> 1);
    target = "captive";
  } else if (q.type === "retrieve" && !questIsComplete(q)) {
    tgx = q.targetAt.cx * MAP_W + (MAP_W >> 1);
    tgy = q.targetAt.cy * MAP_H + (MAP_H >> 1);
    target = q.relic;
  } else {
    tgx = q.giver.chunkCX * MAP_W + q.giver.x;
    tgy = q.giver.chunkCY * MAP_H + q.giver.y;
    target = q.giver.name;
  }
  const pwx = playerWorldX(), pwy = playerWorldY();
  const dx = tgx - pwx, dy = tgy - pwy;
  const dist = Math.max(Math.abs(dx), Math.abs(dy));
  let arrow;
  if (dist === 0) arrow = "&bull;";
  else if (Math.abs(dx) > Math.abs(dy) * 2) arrow = dx > 0 ? "&rarr;" : "&larr;";
  else if (Math.abs(dy) > Math.abs(dx) * 2) arrow = dy > 0 ? "&darr;" : "&uarr;";
  else if (dx > 0 && dy > 0) arrow = "&searr;";
  else if (dx < 0 && dy > 0) arrow = "&swarr;";
  else if (dx > 0 && dy < 0) arrow = "&nearr;";
  else arrow = "&nwarr;";
  const stateLabel = q.type === "kill"
    ? `${q.progress}/${q.count}`
    : q.type === "rescue"
    ? (q.rescued ? "return" : "rescue")
    : q.type === "retrieve"
    ? (questIsComplete(q) ? "return" : "relic")
    : (questIsComplete(q) ? "ready" : "fetch");
  return `<hr><div class="compass">` +
    `<div><b>Quest:</b> ${target}</div>` +
    `<div><span class="compass-arrow" style="font-size:18px">${arrow}</span> ` +
    `${dist} away &middot; ${stateLabel}` +
    `</div></div>`;
}

function stepRest() {
  restTimer = null;
  if (!G || G.over || !G.camping) return;
  const pp = G.player;
  if (G.monsters.some(m => G.visible[m.y] && G.visible[m.y][m.x])) {
    G.camping = false;
    G.campSleepUntilDawn = false;
    logMsg("Your rest is broken -- enemies are near!", "warn");
    render();
    return;
  }
  // sleeping-at-home: stop only when the world reaches dawn AND we're
  // fully rested. Cap at one full day (2400 turns) so a starting-at-
  // dawn sleep doesn't immediately exit.
  if (G.campSleepUntilDawn) {
    const ph = timeOfDay().phase;
    const elapsed = G.turn - G.campStartTurn;
    if (ph === "dawn" && pp.hp >= pp.hpMax && pp.mp >= pp.mpMax && elapsed > 60) {
      G.camping = false;
      G.campSleepUntilDawn = false;
      logMsg("You wake at dawn, fully rested.", "good");
      render();
      return;
    }
    if (elapsed >= 2400) {
      // safety: don't sleep more than a full day
      G.camping = false;
      G.campSleepUntilDawn = false;
      logMsg("You wake stiff -- a full day has passed.", "dim");
      render();
      return;
    }
  } else if (pp.hp >= pp.hpMax && pp.mp >= pp.mpMax) {
    G.camping = false;
    logMsg("You break camp, fully rested.", "good");
    render();
    return;
  } else if (G.turn - G.campStartTurn >= 500) {
    // a hard cap so a stuck status (e.g. permanent poison vs regen)
    // can't camp the player forever
    G.camping = false;
    logMsg("You give up resting.", "dim");
    render();
    return;
  }
  endTurn();
  if (G.over) { G.camping = false; return; }
  // when sleeping at home, tick faster so the day passes visibly
  restTimer = setTimeout(stepRest, G.campSleepUntilDawn ? 4 : 20);
}

/* walk the queued path one tile at a time, pausing for animation,
 * and stop the moment anything noteworthy happens. */
function stepWalk() {
  walkTimer = null;
  if (!G || G.over) return;

  // the Surface walks toward a world-coord destination. Each tick we
  // (re)plan a chunk-local path toward a sub-target: the destination
  // itself when it lives in the player's current chunk, otherwise an
  // edge cell pointing at the destination's chunk. findPath routes
  // around mountains, trees and water; tryMovePlayer's edge-transition
  // hands off into the next chunk and we replan from the new position.
  if (G.branch === "Surface" && G.walkDestWorld) {
    const p = G.player;
    const pwx = playerWorldX(), pwy = playerWorldY();
    const d = G.walkDestWorld;
    if (pwx === d.wx && pwy === d.wy) {
      G.walkDestWorld = null; G.walkPath = null; render(); return;
    }
    // adjacent to the click: a single step. If the click was a
    // monster, tryMovePlayer will detect it and swing instead of moving.
    const dWX = d.wx - pwx, dWY = d.wy - pwy;
    if (Math.max(Math.abs(dWX), Math.abs(dWY)) === 1) {
      G.walkDestWorld = null; G.walkPath = null;
      if (tryMovePlayer(Math.sign(dWX), Math.sign(dWY))) {
        if (checkWin()) { render(); return; }
        endTurn();
      } else {
        render();
      }
      return;
    }
    // a plain travel click stops when a monster enters sight so you
    // don't sleepwalk into combat; a fight click ignores that guard
    if (!d.fight && G.monsters.some(m => G.visible[m.y] && G.visible[m.y][m.x])) {
      G.walkDestWorld = null; G.walkPath = null; render(); return;
    }
    // plan a chunk-local path to whichever reachable cell sits closest
    // to the (world-coord) click. handles unwalkable clicks (mountains
    // etc.) and cross-chunk clicks alike -- the player walks as close
    // as the current chunk allows.
    if (!G.walkPath || !G.walkPath.length) {
      G.walkPath = findPathTowardWorld(p.x, p.y, d.wx, d.wy);
    }
    if (!G.walkPath || !G.walkPath.length) {
      // BFS couldn't move us any closer in this chunk. If the destination
      // sits in a neighbouring chunk, step directly toward it so the
      // edge transition hands off; otherwise the click is unreachable.
      const sc = G.surfaceCoord;
      const destCX = Math.floor(d.wx / MAP_W);
      const destCY = Math.floor(d.wy / MAP_H);
      if (destCX === sc.cx && destCY === sc.cy) {
        G.walkDestWorld = null; render(); return;
      }
      const dxSign = destCX > sc.cx ? 1 : destCX < sc.cx ? -1 : 0;
      const dySign = destCY > sc.cy ? 1 : destCY < sc.cy ? -1 : 0;
      const wasCX = sc.cx, wasCY = sc.cy;
      if (!tryMovePlayer(dxSign, dySign)) {
        G.walkDestWorld = null; render(); return;
      }
      if (G.surfaceCoord.cx !== wasCX || G.surfaceCoord.cy !== wasCY) {
        G.walkPath = null;
      }
      if (checkWin()) {
        G.walkDestWorld = null; G.walkPath = null; render(); return;
      }
      endTurn();
      if (G.over) { G.walkDestWorld = null; G.walkPath = null; return; }
      walkTimer = setTimeout(stepWalk, 70);
      return;
    }
    const next = G.walkPath[0];
    if (G.monsters.some(m => m.x === next.x && m.y === next.y)) {
      G.walkDestWorld = null; G.walkPath = null; render(); return;
    }
    const dx = Math.sign(next.x - p.x), dy = Math.sign(next.y - p.y);
    const wasWX = pwx, wasWY = pwy;
    const wasCX = G.surfaceCoord.cx, wasCY = G.surfaceCoord.cy;
    if (!tryMovePlayer(dx, dy)) {
      G.walkDestWorld = null; G.walkPath = null; render(); return;
    }
    // a chunk transition makes the in-chunk walkPath stale -- replan
    if (G.surfaceCoord.cx !== wasCX || G.surfaceCoord.cy !== wasCY) {
      G.walkPath = null;
    } else if (playerWorldX() === wasWX && playerWorldY() === wasWY) {
      // didn't move (door bash etc.) -- keep path tile, take a turn
      endTurn();
      if (!G.over) walkTimer = setTimeout(stepWalk, 70);
      return;
    } else {
      G.walkPath.shift();
    }
    if (checkWin()) {
      G.walkDestWorld = null; G.walkPath = null; render(); return;
    }
    endTurn();
    if (G.over) { G.walkDestWorld = null; G.walkPath = null; return; }
    walkTimer = setTimeout(stepWalk, 70);
    return;
  }

  if (!G.walkPath || !G.walkPath.length) {
    if (G) G.walkPath = null;
    return;
  }
  const p = G.player;
  const next = G.walkPath[0];
  // a monster standing on the next tile -- stop, do not auto-attack
  if (G.monsters.some(m => m.x === next.x && m.y === next.y)) {
    G.walkPath = null; render(); return;
  }
  const dx = Math.sign(next.x - p.x), dy = Math.sign(next.y - p.y);
  const wasX = p.x, wasY = p.y;
  if (!tryMovePlayer(dx, dy)) { G.walkPath = null; render(); return; }
  // if the step only opened a door (player did not move), keep the
  // path tile -- next tick walks through the now-open doorway
  if (p.x === wasX && p.y === wasY) {
    endTurn();
    if (!G.over) walkTimer = setTimeout(stepWalk, 70);
    return;
  }
  G.walkPath.shift();
  if (checkWin()) { G.walkPath = null; render(); return; }
  endTurn();
  if (G.over) { G.walkPath = null; return; }
  // interrupt travel as soon as a monster is in sight
  if (G.monsters.some(m => G.visible[m.y][m.x])) {
    G.walkPath = null; render(); return;
  }
  if (G.walkPath.length) {
    walkTimer = setTimeout(stepWalk, 70);
  } else {
    G.walkPath = null; render();
  }
}

function startWalk(path) {
  G.walkPath = path;
  stepWalk();
}

/* a click (or button) maps to one of the same actions the keys do */
/* (re)build the action-bar's per-spell buttons for the current
 * character. No-op in a headless DOM that lacks querySelectorAll. */
function buildSpellButtons() {
  const bar = document.getElementById("action-bar");
  if (!bar || typeof bar.querySelectorAll !== "function") return;
  for (const old of [...bar.querySelectorAll(".spell-btn")]) old.remove();
  for (const id of G.player.spells) {
    const s = spellById(id);
    if (!s) continue;
    const btn = document.createElement("button");
    btn.className = "spell-btn";
    btn.dataset.act = "spell:" + id;
    btn.title = "Cast " + s.title + " (" + s.mp + " MP)";
    btn.textContent = "Cast " + s.title;
    bar.appendChild(btn);
  }
}

function doAction(act) {
  switch (act) {
    case "wait": endTurn(); break;
    case "camp": startCamp(); break;
    case "pickup": if (doPickup()) endTurn(); else render(); break;
    case "descend": tryDescend(); render(); break;
    case "ascend": tryAscend(); render(); break;
    case "heal": if (quaff("heal")) endTurn(); else render(); break;
    case "might": if (quaff("might")) endTurn(); else render(); break;
    case "teleport": if (readScroll("teleport")) endTurn(); else render(); break;
    case "fear": if (readScroll("fear")) endTurn(); else render(); break;
    case "pray": if (prayAtAltar()) endTurn(); else render(); break;
    case "invoke": if (invokeAbility()) endTurn(); else render(); break;
    case "evoke": if (evokeWand()) endTurn(); else render(); break;
    case "throw": if (throwMissile()) endTurn(); else render(); break;
    case "cast": {
      const sp = G.player.spells;
      if (!sp.length) { logMsg("You know no spells.", "dim"); render(); break; }
      awaitingCast = true;
      const opts = sp.map((id, i) => {
        const s = spellById(id);
        return String.fromCharCode(97 + i) + ": " + s.title + " (" + s.mp + " MP)";
      }).join(", ");
      logMsg("Cast which spell? " + opts, "sys");
      render();
      break;
    }
    case "music": toggleSound(); render(); break;
    case "map": if (mapOpen) closeWorldMap(); else openWorldMap(); break;
    case "quests": if (questListOpen) closeQuestList(); else openQuestList(); break;
    case "build": toggleBuildMode(); break;
    case "sneak": if (tryStealth()) render(); break;
    case "realtime": toggleRealtime(); break;
    default:
      if (act && act.indexOf("spell:") === 0) {
        if (castSpell(act.slice(6))) endTurn(); else render();
      }
      break;
    case "inv": setInv(true); break;
    case "help": setHelp(true); break;
  }
}

function handleTileClick(tx, ty) {
  if (G.over || helpOpen) return;
  cancelWalk();
  cancelRest();
  const p = G.player;
  // on the Surface, tx/ty come in as WORLD coords. Set a world
  // destination and let stepWalk drive toward it, naturally crossing
  // chunk boundaries via tryMovePlayer's edge transition.
  if (G.branch === "Surface") {
    const pwx = playerWorldX(), pwy = playerWorldY();
    if (tx === pwx && ty === pwy) {
      // clicked yourself -- pickup or wait
      if (G.items.some(i => i.x === p.x && i.y === p.y)) {
        if (doPickup()) endTurn(); else render();
      } else {
        endTurn();
      }
      return;
    }
    // adjacent click is a single manual step -- bypass auto-walk so
    // visible monsters don't freeze the mouse (and clicking onto a
    // monster does a normal melee swing via tryMovePlayer)
    const adx = tx - pwx, ady = ty - pwy;
    if (Math.max(Math.abs(adx), Math.abs(ady)) === 1) {
      if (tryMovePlayer(Math.sign(adx), Math.sign(ady))) {
        if (!checkWin()) endTurn(); else render();
      }
      return;
    }
    // clicking on a monster is fight mode: walk through the
    // visible-monster guard and swing the moment we're adjacent
    const fightTarget = !!monsterAtWorld(tx, ty);
    // with a monster already in sight, a distant click is treated as
    // a single step toward the click instead of an auto-walk -- so
    // the player can manoeuvre one tile at a time during combat
    if (!fightTarget &&
        G.monsters.some(m => G.visible[m.y] && G.visible[m.y][m.x])) {
      if (tryMovePlayer(Math.sign(adx), Math.sign(ady))) {
        if (!checkWin()) endTurn(); else render();
      }
      return;
    }
    G.walkDestWorld = { wx: tx, wy: ty, fight: fightTarget };
    walkTimer = setTimeout(stepWalk, 30);
    return;
  }
  // sealed levels keep the existing chunk-local path walk
  let lx = tx, ly = ty;
  const dx = lx - p.x, dy = ly - p.y;
  const cheb = Math.max(Math.abs(dx), Math.abs(dy));

  if (cheb === 0) {
    // clicked yourself: pick up an item here, otherwise wait
    if (G.items.some(i => i.x === p.x && i.y === p.y)) {
      if (doPickup()) endTurn(); else render();
    } else {
      endTurn();
    }
    return;
  }
  if (cheb === 1) {
    // adjacent tile: a single step (tryMovePlayer attacks if a
    // monster is there)
    if (tryMovePlayer(Math.sign(dx), Math.sign(dy))) {
      if (!checkWin()) endTurn(); else render();
    }
    return;
  }
  // farther away: travel there, if it is a known reachable tile
  const destOk = passable(G.level, lx, ly) ||
                 G.level.tiles[ly][lx] === T.DOOR;
  if (!G.seen[ly] || !G.seen[ly][lx] || !destOk) {
    logMsg("You can't see a route there.", "dim");
    render();
    return;
  }
  const path = findPath(p.x, p.y, lx, ly);
  if (!path || !path.length) {
    logMsg("No known path there.", "dim");
    render();
    return;
  }
  startWalk(path);
}

function onCanvasClick(e) {
  initAudio();              // first click unlocks Web Audio
  if (G.over || helpOpen) return;
  const canvas = document.getElementById("map-canvas");
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const { camX, camY } = camOrigin();
  // tx,ty are the cell the user clicked, in WORLD coords on Surface,
  // chunk-local elsewhere
  const tx = camX + Math.floor((e.clientX - rect.left) / rect.width * VIEW_W);
  const ty = camY + Math.floor((e.clientY - rect.top) / rect.height * VIEW_H);
  const isSurface = G.branch === "Surface";
  // build mode: click paints, right-click erases. Convert Surface
  // world coord back to chunk-local for the paint call.
  if (G.buildMode) {
    let lx = tx, ly = ty;
    if (isSurface && G.surfaceCoord) {
      lx = tx - G.surfaceCoord.cx * MAP_W;
      ly = ty - G.surfaceCoord.cy * MAP_H;
    }
    if (lx < 0 || ly < 0 || lx >= MAP_W || ly >= MAP_H) return;
    const erase = e.button === 2 || e.shiftKey;
    if (paintBuildCell(lx, ly, erase)) render();
    return;
  }
  if (!isSurface && (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H)) {
    return;
  }
  handleTileClick(tx, ty);
}

function onCanvasHover(e) {
  if (!G || G.over) return;
  const canvas = document.getElementById("map-canvas");
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const { camX, camY } = camOrigin();
  const tx = camX + Math.floor((e.clientX - rect.left) / rect.width * VIEW_W);
  const ty = camY + Math.floor((e.clientY - rect.top) / rect.height * VIEW_H);
  const isSurface = G.branch === "Surface";
  if (hoverTile && hoverTile.x === tx && hoverTile.y === ty) return;
  const inBounds = isSurface ||
    (tx >= 0 && ty >= 0 && tx < MAP_W && ty < MAP_H);
  hoverTile = inBounds ? { x: tx, y: ty } : null;
  render();
}

function onKey(e) {
  const k = e.key;
  initAudio();              // first keypress unlocks Web Audio
  // an "s" press starts camping; any other key cancels an active camp,
  // matching how any keypress also cancels an auto-walk
  if (k !== "s" && k !== "S") cancelRest();
  cancelWalk();             // any keypress cancels an auto-walk

  // the help overlay can be opened at any time, even after death
  if (k === "?") {
    setHelp(!helpOpen);
    e.preventDefault();
    return;
  }
  if (helpOpen) {
    if (k === "Escape" || k === " " || k === "Enter") setHelp(false);
    e.preventDefault();      // swallow all other input while help is up
    return;
  }
  // the inventory overlay, toggled with i
  if (k === "i" || k === "I") {
    setInv(!invOpen);
    e.preventDefault();
    return;
  }
  if (invOpen) {
    if (k === "Escape" || k === " " || k === "Enter") {
      setInv(false);
    } else {
      // a letter uses that backpack item (equip / quaff / read)
      const idx = "abcdefghijklmnopqrstuvwxyz".indexOf(k);
      if (idx >= 0 && idx < G.player.pack.length) {
        const tookTurn = useFromPack(idx);
        if (tookTurn) {           // a consumable -- spend the turn
          setInv(false);
          if (!checkWin()) endTurn();
        } else {
          renderInventory();      // gear equipped -- refresh the panel
          render();
        }
      }
    }
    e.preventDefault();
    return;
  }
  if (npcOpen) {
    if (k === "Escape" || k === " " || k === "Enter") closeNPCDialog();
    e.preventDefault();
    return;
  }
  if (questListOpen) {
    if (k === "Escape" || k === " " || k === "Enter" ||
        k === "Q" || k === "q") closeQuestList();
    e.preventDefault();
    return;
  }
  if (k === "Q") {
    if (questListOpen) closeQuestList(); else openQuestList();
    e.preventDefault();
    return;
  }
  if (mapOpen) {
    if (k === "Escape" || k === " " || k === "Enter" ||
        k === "M" || k === "m") closeWorldMap();
    e.preventDefault();
    return;
  }
  if (k === "M") {
    if (mapOpen) closeWorldMap(); else openWorldMap();
    e.preventDefault();
    return;
  }
  if (shopOpen) {
    if (k === "Escape" || k === " " || k === "Enter") {
      setShop(false);
    } else {
      // lowercase letter buys stock; uppercase letter sells a pack item
      const lo = "abcdefghijklmnopqrstuvwxyz".indexOf(k);
      const hi = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".indexOf(k);
      const stock = (G.level && G.level.shop) || [];
      if (lo >= 0 && lo < stock.length) {
        buyItem(lo);
        renderShop();
        render();
      } else if (hi >= 0 && hi < G.player.pack.length) {
        sellItem(hi);
        renderShop();
        render();
      }
    }
    e.preventDefault();
    return;
  }

  if (G.over) return;

  if (awaitingQuaff) {
    awaitingQuaff = false;
    if (k === "h") { if (quaff("heal")) endTurn(); }
    else if (k === "m") { if (quaff("might")) endTurn(); }
    else logMsg("Quaff cancelled.", "dim");
    e.preventDefault();
    render();
    return;
  }

  if (awaitingRead) {
    awaitingRead = false;
    if (k === "t") { if (readScroll("teleport")) endTurn(); }
    else if (k === "f") { if (readScroll("fear")) endTurn(); }
    else logMsg("Reading cancelled.", "dim");
    e.preventDefault();
    render();
    return;
  }

  if (awaitingCast) {
    awaitingCast = false;
    const idx = "abcdef".indexOf(k);
    if (idx >= 0 && idx < G.player.spells.length) {
      if (castSpell(G.player.spells[idx])) endTurn();
    } else {
      logMsg("Spellcasting cancelled.", "dim");
    }
    e.preventDefault();
    render();
    return;
  }

  if (MOVE_KEYS[k]) {
    const [dx, dy] = MOVE_KEYS[k];
    if (tryMovePlayer(dx, dy)) {
      if (!checkWin()) endTurn();
      else render();
    }
    e.preventDefault();
    return;
  }

  switch (k) {
    case ",": case ".": case "5": case " ":
      endTurn(); e.preventDefault(); break;
    case "s": case "S":
      startCamp(); e.preventDefault(); break;
    case "g":
      if (doPickup()) endTurn(); else render();
      e.preventDefault(); break;
    case ">":
      if (tryDescend()) render();
      e.preventDefault(); break;
    case "<":
      if (tryAscend()) render();
      e.preventDefault(); break;
    case "q":
      awaitingQuaff = true;
      logMsg("Quaff which? (h: healing, m: might)", "sys");
      render();
      e.preventDefault(); break;
    case "r":
      awaitingRead = true;
      logMsg("Read which scroll? (t: teleportation, f: fear)", "sys");
      render();
      e.preventDefault(); break;
    case "v":
      if (evokeWand()) endTurn(); else render();
      e.preventDefault(); break;
    case "f":
      if (throwMissile()) endTurn(); else render();
      e.preventDefault(); break;
    case "p": case "P":
      if (prayAtAltar()) endTurn(); else render();
      e.preventDefault(); break;
    case "a": case "A":
      if (invokeAbility()) endTurn(); else render();
      e.preventDefault(); break;
    case "z": case "Z": {
      const sp = G.player.spells;
      if (!sp.length) {
        logMsg("You know no spells.", "dim");
      } else {
        awaitingCast = true;
        const opts = sp.map((id, i) => {
          const s = spellById(id);
          return String.fromCharCode(97 + i) + ": " + s.title +
                 " (" + s.mp + " MP)";
        }).join(", ");
        logMsg("Cast which spell? " + opts, "sys");
      }
      render();
      e.preventDefault(); break;
    }
    case "m": case "M":
      toggleSound(); render();
      e.preventDefault(); break;
    case "H":
      if (tryStealth()) render();
      e.preventDefault(); break;
    case "D":
      if (dropCarriedBody()) { endTurn(); render(); }
      else render();
      e.preventDefault(); break;
    case "b": case "B":
      toggleBuildMode();
      e.preventDefault(); break;
    case "t": case "T":
      toggleRealtime();
      e.preventDefault(); break;
    case "Escape":
      if (G && G.buildMode) { closeBuildMode(); e.preventDefault(); }
      break;
    default: break;
  }
}

/* =============================================================
 * Sound -- short Web Audio tones for the key events. The audio
 * context is created lazily on the first input (browser autoplay
 * policy). Headless / no-audio environments simply stay silent.
 * ============================================================= */

let audioCtx = null;
let soundOn = true;

function initAudio() {
  if (audioCtx) return;
  const Ctx = (typeof window !== "undefined") &&
    (window.AudioContext || window.webkitAudioContext);
  if (!Ctx) return;
  try { audioCtx = new Ctx(); } catch (e) { audioCtx = null; }
}

/* visible damage feedback -- pulse a red overlay over the map canvas
 * for ~140 ms so the player can't miss being hit. */
function flashDamage() {
  if (typeof document === "undefined") return;
  const cv = document.getElementById("map-canvas");
  if (!cv) return;
  cv.classList.add("hit-flash");
  setTimeout(() => cv.classList.remove("hit-flash"), 140);
}

/* transient overlay effects -- blood arrows showing hit direction,
 * smoke clouds for boss deaths, etc. Each entry expires by wall-clock
 * time; the render reads the live list and draws current ones. */
function addEffect(x, y, sprite, durationMs) {
  if (!G) return;
  if (!G.transientEffects) G.transientEffects = [];
  const ms = durationMs || 400;
  const eff = { x, y, sprite, expireAt: Date.now() + ms,
                onSurface: G.branch === "Surface" };
  G.transientEffects.push(eff);
  // schedule a render at expiry so the effect disappears cleanly
  if (typeof setTimeout === "function") {
    setTimeout(() => {
      if (G && G.transientEffects) {
        G.transientEffects = G.transientEffects.filter(e =>
          e.expireAt > Date.now());
      }
      if (!G || G.over) return;
      try { render(); } catch (e) { /* ignore */ }
    }, ms + 16);
  }
}

/* an attack hit -- show a blood arrow on the victim's tile pointing
 * back toward the attacker. dxSign/dySign are -1..1 from attacker to
 * victim; the arrow index walks clockwise from "up". */
function showHitArrow(victimX, victimY, attackerX, attackerY) {
  const dx = Math.sign(victimX - attackerX);
  const dy = Math.sign(victimY - attackerY);
  // standard 8-dir clockwise from up: up, ne, right, se, down, sw, left, nw
  const idx = (dx === 0 && dy === -1) ? 0
            : (dx ===  1 && dy === -1) ? 1
            : (dx ===  1 && dy ===  0) ? 2
            : (dx ===  1 && dy ===  1) ? 3
            : (dx ===  0 && dy ===  1) ? 4
            : (dx === -1 && dy ===  1) ? 5
            : (dx === -1 && dy ===  0) ? 6
            : (dx === -1 && dy === -1) ? 7
            : 0;
  const arr = MANIFEST && MANIFEST.effect && MANIFEST.effect.blood_arrow;
  if (!arr || !arr[idx]) return;
  addEffect(victimX, victimY, arr[idx], 320);
}

function tone(freq, dur, type, vol, delay) {
  if (!audioCtx) return;
  const t0 = audioCtx.currentTime + (delay || 0);
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type || "square";
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.linearRampToValueAtTime(vol || 0.14, t0 + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

const SFX = {
  hit:     () => tone(170, 0.07, "square", 0.13),
  hurt:    () => tone(95, 0.14, "sawtooth", 0.17),
  miss:    () => tone(240, 0.04, "sine", 0.06),
  kill:    () => { tone(300, 0.07, "triangle", 0.14);
                   tone(150, 0.11, "triangle", 0.12, 0.07); },
  pickup:  () => tone(680, 0.09, "sine", 0.12),
  quaff:   () => tone(430, 0.12, "sine", 0.12),
  cast:    () => tone(720, 0.10, "sawtooth", 0.10),
  descend: () => { tone(260, 0.10, "sine", 0.13);
                   tone(175, 0.15, "sine", 0.12, 0.09); },
  levelup: () => { tone(440, 0.09, "square", 0.12);
                   tone(554, 0.09, "square", 0.12, 0.09);
                   tone(660, 0.15, "square", 0.13, 0.18); },
  win:     () => [523, 659, 784, 1047].forEach(
                   (f, i) => tone(f, 0.17, "triangle", 0.14, i * 0.13)),
  death:   () => { tone(200, 0.5, "sawtooth", 0.16);
                   tone(90, 0.7, "sawtooth", 0.14, 0.1); },
  // soft slow whisper as you melt into shadow
  sneak:   () => { tone(220, 0.18, "sine", 0.06);
                   tone(160, 0.22, "sine", 0.05, 0.08); },
  // short sharp metallic stab (sneak attack)
  backstab:() => { tone(900, 0.04, "square", 0.10);
                   tone(420, 0.08, "triangle", 0.13, 0.03); },
  // heavy thump of a body hitting the floor
  body:    () => { tone(110, 0.16, "sawtooth", 0.14);
                   tone(70, 0.20, "sawtooth", 0.10, 0.05); },
  // klaxon -- alternating two-tone urgency, ~0.6s. Used when a guard
  // discovers a murdered NPC and the keep goes hostile.
  alert:   () => { [0, 0.16, 0.32, 0.48].forEach(t => {
                    tone(820, 0.10, "square", 0.16, t);
                    tone(560, 0.10, "square", 0.14, t + 0.08);
                  }); },
};

function sfx(name) {
  if (!soundOn || !audioCtx) return;
  const fn = SFX[name];
  if (fn) { try { fn(); } catch (e) { /* ignore audio glitches */ } }
}

function toggleSound() {
  soundOn = !soundOn;
  if (soundOn) initAudio();
  if (typeof localStorage !== "undefined") {
    try { localStorage.setItem("crawlweb.sound", soundOn ? "1" : "0"); }
    catch (e) { /* ignore */ }
  }
  logMsg("Sound " + (soundOn ? "on" : "off") + ".", "sys");
}

/* =============================================================
 * Save / resume -- the whole run lives in G, which is plain data,
 * so it round-trips through JSON in localStorage.
 * ============================================================= */

const SAVE_KEY = "crawlweb.save.v1";

function saveGame() {
  if (typeof localStorage === "undefined") return;
  try {
    if (!G || G.over) { localStorage.removeItem(SAVE_KEY); return; }
    const snap = Object.assign({}, G, { walkPath: null });
    localStorage.setItem(SAVE_KEY, JSON.stringify(snap));
  } catch (e) { /* storage full / disabled -- play on without a save */ }
}

function loadSave() {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const g = JSON.parse(raw);
    return (g && g.player && g.level && !g.over) ? g : null;
  } catch (e) { return null; }
}

function clearSave() {
  if (typeof localStorage === "undefined") return;
  try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* ignore */ }
}

function continueGame() {
  const g = loadSave();
  if (!g) return false;
  G = g;
  G.walkPath = null;
  canvasReady = false;
  buildSpellButtons();
  showScreen("game");
  render();
  const cv = document.getElementById("map-canvas");
  if (cv && cv.focus) cv.focus();
  return true;
}

/* =============================================================
 * Screen flow
 * ============================================================= */

function showScreen(name) {
  for (const id of ["title", "game", "over"]) {
    document.getElementById("screen-" + id).classList.toggle("hidden", id !== name);
  }
}

/* =============================================================
 * Boot
 * ============================================================= */

async function boot() {
  const ok = await loadData();
  if (ok) buildWeaponPool();      // every export weapon into the pool
  // tile art is optional -- if the manifest or images fail to load the
  // game renders in ASCII fallback mode and still plays identically.
  await loadManifest();
  // authored vault layouts are optional too -- without them the
  // generator just uses random rooms.
  await loadVaults();
  document.getElementById("btn-start").addEventListener("click", () => {
    const sp = G_CHARSEL.species[document.getElementById("sel-species").value | 0];
    const jb = G_CHARSEL.jobs[document.getElementById("sel-job").value | 0];
    canvasReady = false;
    startGame(sp, jb);
  });
  document.getElementById("btn-continue").addEventListener("click", () => {
    continueGame();
  });
  document.getElementById("btn-again").addEventListener("click", () => {
    setHelp(false);
    setInv(false);
    setShop(false);
    // a finished run cleared its save; show Continue only if one exists
    document.getElementById("btn-continue").classList.toggle(
      "hidden", !loadSave());
    showScreen("title");
  });
  document.getElementById("btn-help-close").addEventListener("click", () => {
    setHelp(false);
  });
  document.getElementById("btn-inv-close").addEventListener("click", () => {
    setInv(false);
  });
  document.getElementById("btn-shop-close").addEventListener("click", () => {
    setShop(false);
  });
  // delegate clicks inside the inventory + shop bodies so individual
  // item rows fire the right handler (use / buy / sell) without
  // needing to type the letter
  const invOv = document.getElementById("inv-overlay");
  if (invOv) invOv.addEventListener("click", (e) => {
    const row = e.target.closest("[data-use-pack]");
    if (!row) return;
    const idx = parseInt(row.dataset.usePack, 10);
    if (!Number.isFinite(idx)) return;
    const tookTurn = useFromPack(idx);
    if (tookTurn) {
      setInv(false);
      if (!checkWin()) endTurn();
    } else {
      renderInventory();
      render();
    }
  });
  const shopOv = document.getElementById("shop-overlay");
  if (shopOv) shopOv.addEventListener("click", (e) => {
    const buyRow = e.target.closest("[data-buy]");
    if (buyRow) {
      const idx = parseInt(buyRow.dataset.buy, 10);
      if (Number.isFinite(idx)) {
        buyItem(idx);
        renderShop();
        render();
      }
      return;
    }
    const sellRow = e.target.closest("[data-sell]");
    if (sellRow) {
      const idx = parseInt(sellRow.dataset.sell, 10);
      if (Number.isFinite(idx)) {
        sellItem(idx);
        renderShop();
        render();
      }
    }
  });
  const npcCloseBtn = document.getElementById("btn-npc-close");
  if (npcCloseBtn) npcCloseBtn.addEventListener("click", closeNPCDialog);
  const questCloseBtn = document.getElementById("btn-quest-close");
  if (questCloseBtn) questCloseBtn.addEventListener("click", closeQuestList);
  const mapCloseBtn = document.getElementById("btn-map-close");
  if (mapCloseBtn) mapCloseBtn.addEventListener("click", closeWorldMap);
  // world-map hover: convert pixel -> chunk coord and report what
  // sits there (region name, building count, POI summary)
  const mapCanvas = document.getElementById("world-map");
  if (mapCanvas) mapCanvas.addEventListener("mousemove", (e) => {
    if (!MAP_LAYOUT) return;
    const L = MAP_LAYOUT;
    const rect = mapCanvas.getBoundingClientRect();
    const px = (e.clientX - rect.left) * (mapCanvas.width / rect.width);
    const py = (e.clientY - rect.top) * (mapCanvas.height / rect.height);
    const ccx = L.minX + Math.floor((px - L.ox) / L.cell);
    const ccy = L.minY + Math.floor((py - L.oy) / L.cell);
    const k = ccx + "," + ccy;
    const visited = L.visited.has(k);
    let info = `<b>${regionNameFor(ccx, ccy)}</b> (${ccx},${ccy})`;
    if (!visited) info += " <span class='dim'>(unexplored)</span>";
    const bits = [];
    if (L.castleHits[k]) bits.push("castle");
    if (L.kingHits[k]) bits.push("king");
    if (L.buildingHits[k]) bits.push(L.buildingHits[k] + " building" +
      (L.buildingHits[k] > 1 ? "s" : ""));
    const poi = L.poiHits[k];
    if (poi) {
      if (poi.has(T.SHRINE) || poi.has(T.STANDING_STONE)) bits.push("shrine");
      if (poi.has(T.BEACON)) bits.push("beacon");
      if (poi.has(T.WELL)) bits.push("well");
      if (poi.has(T.WISHING_WELL)) bits.push("wishing well");
      if (poi.has(T.SIGNPOST)) bits.push("signpost");
    }
    if (bits.length) info += " &middot; " + bits.join(", ");
    const legend = document.getElementById("map-legend");
    if (legend) legend.innerHTML = info;
  });
  if (mapCanvas) mapCanvas.addEventListener("mouseleave",
    () => { if (mapOpen) renderWorldMap(); });
  // delegate clicks inside the NPC dialog + quest list overlays so the
  // in-body buttons (Claim, Track, Leave) drive the right callback
  const npcOv = document.getElementById("npc-overlay");
  if (npcOv) npcOv.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-quest-act]");
    if (!btn) return;
    handleQuestAction(btn.dataset.questAct);
  });
  const questOv = document.getElementById("quest-overlay");
  if (questOv) questOv.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-quest-act]");
    if (!btn) return;
    handleQuestAction(btn.dataset.questAct);
  });
  document.addEventListener("keydown", (e) => {
    if (!document.getElementById("screen-game").classList.contains("hidden")) {
      onKey(e);
    }
  });
  // --- mouse controls ---
  const canvas = document.getElementById("map-canvas");
  canvas.addEventListener("click", onCanvasClick);
  canvas.addEventListener("mousemove", onCanvasHover);
  canvas.addEventListener("mouseleave", () => {
    if (hoverTile) { hoverTile = null; if (G && !G.over) render(); }
  });
  // right-click = erase while in build mode. Suppress the browser
  // context menu so the click reaches our handler cleanly.
  canvas.addEventListener("contextmenu", (e) => {
    if (G && G.buildMode) { e.preventDefault(); onCanvasClick(e); }
  });
  document.getElementById("action-bar").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const act = btn.dataset.act;
    if (G.over && act !== "help") return;
    if (helpOpen && act !== "help") return;
    if (invOpen && act !== "inv") return;
    if (shopOpen) return;
    cancelWalk();
    doAction(act);
  });
  if (ok) buildCharSelect();
  // offer to resume an interrupted run, if one was saved
  if (loadSave()) {
    document.getElementById("btn-continue").classList.remove("hidden");
  }
  // restore the player's sound preference
  if (typeof localStorage !== "undefined") {
    try {
      if (localStorage.getItem("crawlweb.sound") === "0") soundOn = false;
    } catch (e) { /* ignore */ }
  }
  // preload tile sprites in the background; render() falls back to
  // ASCII for any tile that has not arrived yet.
  preloadTiles().then(() => {
    if (MANIFEST && DATA) {
      const banner = document.getElementById("data-banner");
      banner.innerHTML += " &nbsp;<b style='color:#6f6'>" +
        Object.keys(MANIFEST.monsters || {}).length +
        " monster tiles loaded.</b>";
      if (G && !G.over) render();
      // species sprites are loaded now -- refresh the char preview
      if (!G) updatePreview();
    }
    // ?demo auto-starts a game and explores a little (handy for a
    // quick look / screenshots).
    const search = (typeof window !== "undefined" && window.location &&
      window.location.search) || "";
    if (ok && /[?&]demo/.test(search) && !G) {
      // ?demo&caster starts a spellcaster, for a quick look at spells
      const demoJob = /[?&]caster/.test(search)
        ? (G_CHARSEL.jobs.find(j => j.name === "Conjurer") || G_CHARSEL.jobs[0])
        : G_CHARSEL.jobs[0];
      startGame(G_CHARSEL.species[0], demoJob);
      // ?demo&depthN jumps down the Dungeon trunk to depth N
      const dm = search.match(/[?&]depth(\d)/);
      if (dm) {
        const want = Math.min(TRUNK_LEVELS, parseInt(dm[1], 10));
        while (G && !G.over && G.depth < want) {
          let s = null;
          for (let y = 0; y < MAP_H && !s; y++)
            for (let x = 0; x < MAP_W && !s; x++)
              if (G.level.tiles[y][x] === T.STAIRS_DOWN) s = { x, y };
          if (!s) break;
          G.player.x = s.x; G.player.y = s.y;
          if (!tryDescend()) break;
        }
      }
      const dirs = [[1,0],[0,1],[-1,0],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]];
      for (let i = 0; i < 30 && G && !G.over; i++) {
        const d = dirs[(Math.random() * dirs.length) | 0];
        if (tryMovePlayer(d[0], d[1]) && !checkWin()) endTurn();
      }
      // ?demo&shop descends until a shop appears, then steps into it
      if (/[?&]shop/.test(search) && G) {
        for (let g = 0; g < TRUNK_LEVELS && G && !G.over; g++) {
          if (G.level.shop && G.level.shop.length) {
            for (let y = 0; y < MAP_H; y++)
              for (let x = 0; x < MAP_W; x++)
                if (G.level.tiles[y][x] === T.SHOP) {
                  G.player.x = x; G.player.y = y;
                }
            setShop(true);
            break;
          }
          let s = null;
          for (let y = 0; y < MAP_H && !s; y++)
            for (let x = 0; x < MAP_W && !s; x++)
              if (G.level.tiles[y][x] === T.STAIRS_DOWN) s = { x, y };
          if (!s) break;
          G.player.x = s.x; G.player.y = s.y;
          if (!tryDescend()) break;
        }
      }
      // ?demo&reveal uncovers the whole level (for screenshots)
      if (/[?&]reveal/.test(search) && G) {
        for (let y = 0; y < MAP_H; y++) G.seen[y].fill(true);
      }
      render();
      // ?demo&surface walks you out of D:1 onto the surface
      if (/[?&]surface/.test(search) && G) {
        for (let y = 0; y < MAP_H; y++) {
          for (let x = 0; x < MAP_W; x++) {
            if (G.level.tiles[y][x] === T.STAIRS_UP) {
              G.player.x = x; G.player.y = y;
            }
          }
        }
        tryAscend();
        // park the player near the east edge so the screenshot shows
        // both the spawn chunk and the chunk past it
        if (/[?&]edge/.test(search) && G.branch === "Surface") {
          G.player.x = MAP_W - 3;
        }
        if (/[?&]reveal/.test(search)) {
          for (let y = 0; y < MAP_H; y++) G.seen[y].fill(true);
        }
        computeFOV();
        render();
      }
      // ?demo&hover parks the cursor on something to show the tooltip
      if (/[?&]hover/.test(search) && G) {
        for (let y = 0; y < MAP_H; y++) {
          G.seen[y].fill(true);
          G.visible[y].fill(true);
        }
        const m = G.monsters[0];
        if (m) hoverTile = { x: m.x, y: m.y };
        render();
      }
      if (/[?&]help/.test(search)) setHelp(true);
      if (/[?&]inv/.test(search) && G) {
        // seed the backpack so the panel shows carried gear
        G.player.pack.push(
          { key: "weapon", name: "war axe",
            weapon: { name: "war axe", dice: 1, sides: 13, acc: 0, str: 4 } },
          { key: "armour", name: "ring mail",
            armour: { name: "ring mail", ac: 5, ev_penalty: -70 } },
          { key: "wand", name: "wand of flame",
            wand: { name: "flame", kind: "flame", charges: 5 } });
        setInv(true);
      }
    }
  });
}

boot();
