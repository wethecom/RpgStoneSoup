/* Crawl Web -- chunk editor.
 *
 * Lets you paint tiles, drop entities and override per-cell art onto
 * a 56x26 grid (matching the game's Surface chunks), save into
 * localStorage, and seed the game so walking to (cx,cy) loads your
 * custom map instead of the procedural one.
 *
 * The editor is intentionally separate from game.js -- it imports its
 * own minimal tile constants and just *writes* chunk JSON that the
 * game reads.
 */

const MAP_W = 56;
const MAP_H = 26;
const TILE  = 26;

// keep these in sync with the T table in game.js
const T = {
  WALL:0, FLOOR:1, STAIRS_DOWN:2, STAIRS_UP:3, DOOR:4, DOOR_OPEN:5,
  WATER:6, LAVA:7, TREE:8, ALTAR:9, BRANCH:10, SHOP:11,
  DOOR_LOCKED:12, DOOR_STEEL:13, GATE:14, ROOF:15,
  WELL:16, SHRINE:17, GRAVE:18, CAMPSITE:19, IDOL:20, MANA_NODE:21,
  SIGNPOST:22, BEACON:23, WISHING_WELL:24, STANDING_STONE:25,
  FLOWERS:26, LECTERN:27, FRUIT_CACHE:28, DEEP_WATER:29,
  TELEPORTER:30,
};

// the terrain brushes shown in the palette grid
const TILE_BRUSHES = [
  { t: T.FLOOR,         glyph: ".",  col: "#666", name: "floor"  },
  { t: T.WALL,          glyph: "#",  col: "#aaa", name: "wall"   },
  { t: T.WATER,         glyph: "~",  col: "#5a9ed5", name: "water" },
  { t: T.DEEP_WATER,    glyph: "~",  col: "#1a3e6e", name: "deep" },
  { t: T.LAVA,          glyph: "~",  col: "#d2562a", name: "lava" },
  { t: T.TREE,          glyph: "&",  col: "#3c7a3c", name: "tree" },
  { t: T.DOOR,          glyph: "+",  col: "#c08a4a", name: "door" },
  { t: T.DOOR_LOCKED,   glyph: "+",  col: "#cc4040", name: "lock"   },
  { t: T.DOOR_STEEL,    glyph: "+",  col: "#8a8aa0", name: "steel"  },
  { t: T.GATE,          glyph: "=",  col: "#d8a060", name: "gate"   },
  { t: T.STAIRS_UP,     glyph: "<",  col: "#fff",    name: "stairs<"},
  { t: T.STAIRS_DOWN,   glyph: ">",  col: "#fff",    name: "stairs>"},
  { t: T.ALTAR,         glyph: "_",  col: "#d8d8a0", name: "altar"  },
  { t: T.WELL,          glyph: "u",  col: "#5cc7ff", name: "well"   },
  { t: T.SHRINE,        glyph: "I",  col: "#ffd070", name: "shrine" },
  { t: T.GRAVE,         glyph: "t",  col: "#b0b0b0", name: "grave"  },
  { t: T.SIGNPOST,      glyph: "s",  col: "#d8d0a0", name: "sign"   },
  { t: T.BEACON,        glyph: "*",  col: "#ffea60", name: "beacon" },
  { t: T.STANDING_STONE,glyph: "I",  col: "#9c9c9c", name: "henge"  },
  { t: T.CAMPSITE,      glyph: "c",  col: "#e3a060", name: "camp"   },
  { t: T.FLOWERS,       glyph: '"',  col: "#ff89d8", name: "flowers"},
  { t: T.LECTERN,       glyph: "n",  col: "#b08a4a", name: "lectern"},
  { t: T.FRUIT_CACHE,   glyph: "%",  col: "#ff7f3f", name: "fruit"  },
  { t: T.MANA_NODE,     glyph: "m",  col: "#5cd2ff", name: "mana"   },
  { t: T.IDOL,          glyph: "i",  col: "#cc4444", name: "idol"   },
  { t: T.WISHING_WELL,  glyph: "W",  col: "#9ae0ff", name: "wish"   },
  { t: T.TELEPORTER,    glyph: "T",  col: "#b986ff", name: "telep"  },
];

// editor state
const STATE = {
  // tiles[y][x] = T.*
  tiles: makeBlankTiles(),
  // tileArt: { "y*MAP_W+x": "dngn/..." } for per-cell sprite override
  tileArt: {},
  // teleporters: { "y*MAP_W+x": {cx, cy, x, y} }
  teleporters: {},
  // currentTeleportDest: applied to each new teleporter cell until changed
  currentTeleportDest: null,
  // entities[i] = { kind: "mon"|"npc"|"item", x, y, ...payload }
  entities: [],
  brush: TILE_BRUSHES[0],   // default floor
  artBrush: null,           // selected art override (or null)
  tool: "paint",            // paint, erase, entity, fill
  cx: 0, cy: 0, floor: 0,
  paintMode: null,          // "left" | "right" while dragging
  // undo / redo stacks of full {tiles, tileArt, teleporters, entities}
  // snapshots, capped so memory doesn't run away
  undo: [], redo: [],
};
const UNDO_CAP = 40;

function deepCloneState() {
  return {
    tiles: STATE.tiles.map(row => row.slice()),
    tileArt: { ...STATE.tileArt },
    teleporters: { ...STATE.teleporters },
    entities: STATE.entities.map(e => ({ ...e })),
  };
}

function pushUndo() {
  STATE.undo.push(deepCloneState());
  if (STATE.undo.length > UNDO_CAP) STATE.undo.shift();
  STATE.redo.length = 0;   // any new edit invalidates redo history
}

function applyUndoSnap(snap) {
  STATE.tiles = snap.tiles.map(row => row.slice());
  STATE.tileArt = { ...snap.tileArt };
  STATE.teleporters = { ...snap.teleporters };
  STATE.entities = snap.entities.map(e => ({ ...e }));
}

function undo() {
  if (!STATE.undo.length) return setStatus("Nothing to undo.");
  STATE.redo.push(deepCloneState());
  applyUndoSnap(STATE.undo.pop());
  render();
  setStatus("Undid. " + STATE.undo.length + " more steps available.");
}

function redo() {
  if (!STATE.redo.length) return setStatus("Nothing to redo.");
  STATE.undo.push(deepCloneState());
  applyUndoSnap(STATE.redo.pop());
  render();
  setStatus("Redid. " + STATE.redo.length + " more steps available.");
}

function makeBlankTiles() {
  const t = [];
  for (let y = 0; y < MAP_H; y++) t.push(new Array(MAP_W).fill(T.FLOOR));
  return t;
}

let MANIFEST = null;
let TILEIMG = {};
let MONSTER_DATA = null;     // loaded from game-data.json so the editor's
                              // entity picker stays in sync with the game

function loadManifest() {
  return Promise.all([
    fetch("tiles/manifest.json").then(r => r.json()),
    fetch("game-data.json").then(r => r.json()).catch(() => null),
  ]).then(([m, d]) => {
    MANIFEST = m;
    MONSTER_DATA = d && Array.isArray(d.monsters) ? d.monsters : [];
    preloadKey();
    rebuildEntityDropdown();
  });
}

/* repopulate the entity-kind dropdown from MONSTER_DATA so all 500+
 * monster defs become selectable, grouped by biome with bosses + NPCs
 * + items kept at the top / bottom. */
function rebuildEntityDropdown() {
  const sel = document.getElementById("ed-entity-kind");
  if (!sel) return;
  // capture the existing NPC + item entries (they're hand-curated) so
  // we can keep them; replace the monster section with the live list
  const keep = [];
  for (const og of sel.querySelectorAll("optgroup")) {
    if (/NPC|Items/i.test(og.label)) keep.push(og.outerHTML);
  }
  let html = "";
  const mons = (MONSTER_DATA || []).slice();
  mons.sort((a, b) => (a.tier || 0) - (b.tier || 0) ||
                       (a.name || "").localeCompare(b.name || ""));
  const groups = [
    { label: "Bosses", filter: m => m.boss },
    { label: "Surface — humanoids",
      filter: m => !m.boss && m.biome === "surface_humanoid" },
    { label: "Surface — animals",
      filter: m => !m.boss && m.biome === "surface_animal" },
    { label: "Underground — weird + bad",
      filter: m => !m.boss && m.biome === "underground" },
  ];
  for (const g of groups) {
    const items = mons.filter(g.filter);
    if (!items.length) continue;
    html += `<optgroup label="${g.label}">`;
    for (const m of items) {
      const cap = m.name.charAt(0).toUpperCase() + m.name.slice(1);
      html += `<option value="mon:${m.id}">${cap}` +
              ` <small>(t${m.tier || "?"})</small></option>`;
    }
    html += `</optgroup>`;
  }
  html += keep.join("");
  sel.innerHTML = html;
}

// preload a handful of often-used dngn art so the canvas renders
// immediately; the searchable picker lazy-loads thumbs as needed
function preloadKey() {
  const want = [];
  const dn = MANIFEST.dngn || {};
  const walk = (n) => {
    if (!n) return;
    if (typeof n === "string" && n.endsWith(".png")) want.push(n);
    else if (Array.isArray(n)) n.forEach(walk);
    else if (typeof n === "object") for (const k in n) walk(n[k]);
  };
  walk(dn);
  for (const r of want) {
    const img = new Image();
    img.src = "tiles/" + r;
    TILEIMG[r] = img;
  }
}

function tileImg(rel) {
  if (!rel) return null;
  let img = TILEIMG[rel];
  if (!img) {
    img = new Image();
    img.src = "tiles/" + rel;
    TILEIMG[rel] = img;
  }
  return img.complete && img.naturalWidth > 0 ? img : null;
}

/* =============================================================
 * Render
 * ============================================================= */

function render() {
  const cv = document.getElementById("ed-canvas");
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#0a0a10";
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.font = (TILE - 6) + "px monospace";
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      const t = STATE.tiles[y][x];
      const sx = x * TILE, sy = y * TILE;
      // tile fill colour by type (so unbundled paints still read)
      const bg = bgFor(t);
      ctx.fillStyle = bg;
      ctx.fillRect(sx, sy, TILE, TILE);
      // art override?
      const artRel = STATE.tileArt[y * MAP_W + x];
      const img = artRel ? tileImg(artRel) : null;
      if (img) {
        ctx.drawImage(img, sx, sy, TILE, TILE);
      } else {
        const br = brushForTile(t);
        if (br) {
          ctx.fillStyle = br.col;
          ctx.fillText(br.glyph, sx + (TILE >> 1), sy + (TILE >> 1) + 1);
        }
      }
      // light grid
      ctx.strokeStyle = "#1a1a26";
      ctx.lineWidth = 1;
      ctx.strokeRect(sx + 0.5, sy + 0.5, TILE - 1, TILE - 1);
    }
  }
  // teleporter destination badges -- small purple "T" with a thin
  // arrow line toward the target cell when the dest is on this map
  ctx.font = "10px monospace";
  for (const k in STATE.teleporters) {
    const tp = STATE.teleporters[k];
    const idx = +k;
    const tx = idx % MAP_W, ty = Math.floor(idx / MAP_W);
    const sx = tx * TILE, sy = ty * TILE;
    ctx.fillStyle = "rgba(185, 134, 255, 0.85)";
    ctx.fillRect(sx, sy, TILE, 9);
    ctx.fillStyle = "#fff";
    ctx.fillText("→ " + tp.cx + "," + tp.cy,
                 sx + (TILE >> 1), sy + 5);
  }
  ctx.font = (TILE - 6) + "px monospace";
  // entities on top
  for (const e of STATE.entities) {
    const sx = e.x * TILE, sy = e.y * TILE;
    ctx.fillStyle = e.kind === "mon" ? "#ff7777"
                  : e.kind === "npc" ? "#7af"
                  : "#ffd24a";
    ctx.fillRect(sx + 3, sy + 3, TILE - 6, TILE - 6);
    ctx.fillStyle = "#000";
    ctx.font = "10px monospace";
    ctx.fillText(e.kind[0].toUpperCase(),
                 sx + (TILE >> 1), sy + (TILE >> 1) + 1);
    // a tiny green dot in the corner if this NPC has custom dialog
    if (e.kind === "npc" && e.dialog) {
      ctx.fillStyle = "#3cd47a";
      ctx.fillRect(sx + TILE - 6, sy + 2, 4, 4);
    }
    ctx.font = (TILE - 6) + "px monospace";
  }
}

function bgFor(t) {
  switch (t) {
    case T.WALL:       return "#3a3a48";
    case T.FLOOR:      return "#1a1a24";
    case T.WATER:      return "#1a3a5a";
    case T.DEEP_WATER: return "#0c2040";
    case T.LAVA:       return "#5a1a0c";
    case T.TREE:       return "#1a3a1a";
    case T.DOOR:
    case T.DOOR_LOCKED:
    case T.DOOR_STEEL:
    case T.GATE:       return "#3a2818";
    default:           return "#1a1a24";
  }
}

function brushForTile(t) {
  return TILE_BRUSHES.find(b => b.t === t);
}

/* =============================================================
 * Palette UI
 * ============================================================= */

function buildPalette() {
  const grid = document.getElementById("ed-tile-palette");
  grid.innerHTML = "";
  for (const b of TILE_BRUSHES) {
    const btn = document.createElement("button");
    btn.className = "ed-tile-btn";
    btn.dataset.tile = b.t;
    btn.title = b.name;
    btn.innerHTML =
      `<span class="ed-tile-glyph" style="color:${b.col}">${b.glyph}</span>` +
      `<span class="ed-tile-name">${b.name}</span>`;
    btn.addEventListener("click", () => {
      STATE.brush = b;
      STATE.artBrush = null;       // a terrain pick clears the art brush
      STATE.tool = "paint";
      paintPaletteHighlight();
      paintToolHighlight();
      paintArtHighlight();
    });
    grid.appendChild(btn);
  }
  // tile-art search input below the grid
  if (!document.getElementById("ed-art-section")) {
    const sec = document.createElement("div");
    sec.className = "ed-section";
    sec.id = "ed-art-section";
    sec.innerHTML =
      `<label class="ed-label">Art override (rtiles)</label>` +
      `<input id="ed-art-search" type="text" placeholder="search e.g. brick_brown, demon, halfling" style="width:100%">` +
      `<div id="ed-art-results" class="ed-tile-grid" style="grid-template-columns:repeat(5,1fr);max-height:240px;overflow-y:auto"></div>` +
      `<div class="ed-hint" style="margin-top:4px">` +
      `Pick any sprite to override the current brush's appearance.` +
      `</div>`;
    grid.parentElement.appendChild(sec);
    document.getElementById("ed-art-search")
      .addEventListener("input", (e) => searchArt(e.target.value));
    searchArt("brick_brown");      // a sensible default search
  }
  paintPaletteHighlight();
}

function paintPaletteHighlight() {
  document.querySelectorAll(".ed-tile-btn").forEach(b => {
    const t = parseInt(b.dataset.tile, 10);
    b.classList.toggle("active", t === STATE.brush.t && !STATE.artBrush);
  });
  updateBrushPreview();
}

function updateBrushPreview() {
  const el = document.getElementById("ed-brush-preview");
  if (!el) return;
  const br = STATE.brush;
  let html = `<span class="ed-tile-glyph" style="color:${br.col}">` +
             `${br.glyph}</span>` +
             `<span class="ed-brush-label"><b>${br.name}</b>` +
             `<br><span class="ed-brush-sub">tile ${br.t}, ` +
             `tool: ${STATE.tool}</span></span>`;
  if (Array.isArray(STATE.artBrush) && STATE.artBrush.length) {
    const sample = STATE.artBrush[0];
    html += `<img src="tiles/${sample}" title="${STATE.artBrushKey || ""}">`;
    html += `<span class="ed-brush-sub">${STATE.artBrush.length}&times;</span>`;
  }
  el.innerHTML = html;
}

function paintToolHighlight() {
  document.querySelectorAll(".ed-tool").forEach(b => {
    b.classList.toggle("active", b.dataset.tool === STATE.tool);
  });
  updateBrushPreview();
}

function paintArtHighlight() {
  document.querySelectorAll(".ed-art-thumb").forEach(b => {
    const isActive = Array.isArray(STATE.artBrush) &&
      STATE.artBrush.length && b.dataset.key &&
      STATE.artBrushKey === b.dataset.key;
    b.classList.toggle("active", isActive);
  });
}

// flatten MANIFEST into [{name, paths[]}] entries -- "paths" is the
// full variant array if the manifest stores one, or a single-element
// array if not. Painting picks a random variant per cell so a stone
// wall theme spreads natural variation across the grid.
function collectArtEntries() {
  const entries = [];
  const walk = (node, name) => {
    if (!node) return;
    if (typeof node === "string" && node.endsWith(".png")) {
      entries.push({ name, paths: [node] });
    } else if (Array.isArray(node) &&
               node.length && typeof node[0] === "string") {
      // a variant array -> ONE searchable entry that paints randomly
      entries.push({ name: name + " [" + node.length + "]", paths: node });
    } else if (typeof node === "object") {
      for (const k in node) walk(node[k], name ? name + "." + k : k);
    }
  };
  walk(MANIFEST, "");
  return entries;
}

function searchArt(query) {
  const out = document.getElementById("ed-art-results");
  out.innerHTML = "";
  if (!MANIFEST) return;
  const q = (query || "").toLowerCase().trim();
  const entries = collectArtEntries();
  let hits = entries;
  if (q) {
    hits = entries.filter(e =>
      e.name.toLowerCase().includes(q) ||
      e.paths.some(p => p.toLowerCase().includes(q)));
  }
  hits = hits.slice(0, 50);
  for (const e of hits) {
    const btn = document.createElement("button");
    btn.className = "ed-tile-btn ed-art-thumb";
    btn.dataset.key = e.name;
    btn.title = e.name + " (" + e.paths.length + " variant" +
                (e.paths.length === 1 ? "" : "s") + ")";
    // thumbnail: show the FIRST variant
    const img = new Image();
    img.src = "tiles/" + e.paths[0];
    img.style.cssText = "width:28px;height:28px;display:block;margin:0 auto;image-rendering:pixelated";
    btn.appendChild(img);
    const lab = document.createElement("span");
    lab.className = "ed-tile-name";
    const display = e.name.split(".").pop().slice(0, 14);
    lab.textContent = display + (e.paths.length > 1
      ? " ×" + e.paths.length : "");
    btn.appendChild(lab);
    btn.addEventListener("click", () => {
      // brush is the WHOLE array -- painting picks randomly each cell
      STATE.artBrush = e.paths.slice();
      STATE.artBrushKey = e.name;
      STATE.tool = "paint";
      paintArtHighlight();
      paintToolHighlight();
      paintPaletteHighlight();
    });
    out.appendChild(btn);
  }
  setStatus(hits.length + " of " + entries.length + " tile groups matching " +
            (q ? '"' + q + '"' : "all"));
}

function setStatus(s) { document.getElementById("ed-status").textContent = s; }

/* =============================================================
 * Paint
 * ============================================================= */

function paintAt(x, y, button) {
  if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) return;
  if (STATE.tool === "entity") {
    if (button === "right") {
      STATE.entities = STATE.entities.filter(e => !(e.x === x && e.y === y));
    } else {
      // clicking on an existing NPC -> re-open its dialog modal so the
      // user can edit speech without erasing + re-placing
      const existing = STATE.entities.find(o =>
        o.kind === "npc" && o.x === x && o.y === y);
      if (existing) { openNpcDialogModal(existing); return; }
      const sel = document.getElementById("ed-entity-kind").value;
      const e = entityFromSelection(sel, x, y);
      if (e) {
        STATE.entities = STATE.entities.filter(
          o => !(o.x === x && o.y === y));
        STATE.entities.push(e);
        if (e.kind === "npc") openNpcDialogModal(e);
      }
    }
    return;
  }
  if (STATE.tool === "fill") {
    floodFill(x, y, STATE.brush.t, STATE.artBrush);
    return;
  }
  if (button === "right" || STATE.tool === "erase") {
    STATE.tiles[y][x] = T.FLOOR;
    delete STATE.tileArt[y * MAP_W + x];
    delete STATE.teleporters[y * MAP_W + x];
    // also nuke any entity on this cell -- right-click / erase is
    // "make this tile clean", entities included
    STATE.entities = STATE.entities.filter(
      e => !(e.x === x && e.y === y));
    return;
  }
  STATE.tiles[y][x] = STATE.brush.t;
  if (Array.isArray(STATE.artBrush) && STATE.artBrush.length) {
    // each cell pulls a random member so a single brush of "brick_brown"
    // gives the same variation the game's variantTile() does
    STATE.tileArt[y * MAP_W + x] =
      STATE.artBrush[Math.floor(Math.random() * STATE.artBrush.length)];
  } else if (typeof STATE.artBrush === "string") {
    STATE.tileArt[y * MAP_W + x] = STATE.artBrush;
  } else {
    delete STATE.tileArt[y * MAP_W + x];
  }
  // painting a TELEPORTER cell: prompt for destination once, reuse
  // until the user explicitly clears or repaints with a different one
  if (STATE.brush.t === T.TELEPORTER) {
    if (!STATE.currentTeleportDest) {
      const raw = prompt(
        "Teleporter destination?\n" +
        "Enter as: cx,cy,x,y\n" +
        "(cx,cy = target Surface chunk; x,y = cell within it)",
        STATE.cx + "," + STATE.cy + ",1,1");
      if (raw) {
        const parts = raw.split(",").map(s => parseInt(s.trim(), 10));
        if (parts.length === 4 && parts.every(Number.isFinite)) {
          STATE.currentTeleportDest = {
            cx: parts[0], cy: parts[1], x: parts[2], y: parts[3] };
        }
      }
    }
    if (STATE.currentTeleportDest) {
      STATE.teleporters[y * MAP_W + x] = { ...STATE.currentTeleportDest };
      if (typeof updateTpStatus === "function") updateTpStatus();
    }
  } else {
    delete STATE.teleporters[y * MAP_W + x];
  }
}

function floodFill(x, y, newT, newArtBrush) {
  const oldT = STATE.tiles[y][x];
  const oldArt = STATE.tileArt[y * MAP_W + x] || null;
  const arr = Array.isArray(newArtBrush) ? newArtBrush
            : (typeof newArtBrush === "string" ? [newArtBrush] : null);
  const stack = [[x, y]];
  const seen = new Set();
  while (stack.length) {
    const [cx, cy] = stack.pop();
    const k = cy * MAP_W + cx;
    if (seen.has(k)) continue;
    seen.add(k);
    if (cx < 0 || cy < 0 || cx >= MAP_W || cy >= MAP_H) continue;
    if (STATE.tiles[cy][cx] !== oldT) continue;
    if ((STATE.tileArt[k] || null) !== oldArt) continue;
    STATE.tiles[cy][cx] = newT;
    if (arr) STATE.tileArt[k] = arr[Math.floor(Math.random() * arr.length)];
    else delete STATE.tileArt[k];
    stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
  }
}

function entityFromSelection(sel, x, y) {
  const parts = sel.split(":");
  if (parts[0] === "mon") return { kind: "mon", x, y, defId: parts[1] };
  if (parts[0] === "npc") {
    // place a bare NPC now; openDialogModal patches in name + speech
    return { kind: "npc", x, y, npcKind: parts[1],
             name: null, dialog: null };
  }
  if (parts[0] === "item") {
    if (parts[1] === "food") {
      return { kind: "item", x, y, itemKey: "food", sub: parts[2] };
    }
    return { kind: "item", x, y, itemKey: parts[1] };
  }
  return null;
}

function openNpcDialogModal(npc) {
  const modal = document.getElementById("ed-modal");
  document.getElementById("ed-modal-title").textContent =
    "Dialog for the " + (npc.npcKind || "NPC") +
    " at (" + npc.x + "," + npc.y + ")";
  document.getElementById("ed-modal-name").value = npc.name || "";
  document.getElementById("ed-modal-dialog").value = npc.dialog || "";
  modal.classList.remove("hidden");
  setTimeout(() => {
    const f = document.getElementById("ed-modal-dialog");
    f && f.focus();
  }, 0);
  STATE._modalCallback = (result) => {
    if (!result) return;          // cancel: keep defaults
    if (result.name)   npc.name   = result.name;
    if (result.dialog) npc.dialog = result.dialog;
    render();
  };
}

/* =============================================================
 * Save / load
 * ============================================================= */

function chunkKey() {
  return "Editor:" + STATE.cx + "," + STATE.cy + ":" + STATE.floor;
}

function snapshot() {
  return {
    cx: STATE.cx, cy: STATE.cy, floor: STATE.floor,
    tiles: STATE.tiles, tileArt: STATE.tileArt,
    teleporters: STATE.teleporters,
    entities: STATE.entities,
    savedAt: Date.now(),
  };
}

function loadSnapshot(snap) {
  if (!snap || !Array.isArray(snap.tiles)) return false;
  STATE.cx = snap.cx | 0; STATE.cy = snap.cy | 0;
  STATE.floor = snap.floor | 0;
  STATE.tiles = makeBlankTiles();
  for (let y = 0; y < MAP_H && y < snap.tiles.length; y++) {
    for (let x = 0; x < MAP_W && x < snap.tiles[y].length; x++) {
      STATE.tiles[y][x] = snap.tiles[y][x] | 0;
    }
  }
  STATE.tileArt = snap.tileArt ? { ...snap.tileArt } : {};
  STATE.teleporters = snap.teleporters ? { ...snap.teleporters } : {};
  STATE.entities = Array.isArray(snap.entities) ? snap.entities.slice() : [];
  document.getElementById("ed-cx").value = STATE.cx;
  document.getElementById("ed-cy").value = STATE.cy;
  document.getElementById("ed-floor").value = String(STATE.floor);
  return true;
}

function saveToGame() {
  const all = JSON.parse(localStorage.getItem("crawlweb.customChunks") || "{}");
  all[chunkKey()] = snapshot();
  localStorage.setItem("crawlweb.customChunks", JSON.stringify(all));
  setStatus("Saved " + chunkKey() + ". Open the game and walk there.");
}

function listSaved() {
  const all = JSON.parse(localStorage.getItem("crawlweb.customChunks") || "{}");
  const el = document.getElementById("ed-saved-list");
  el.innerHTML = "";
  const keys = Object.keys(all).sort();
  if (!keys.length) { el.textContent = "(none yet)"; return; }
  for (const k of keys) {
    const snap = all[k];
    const row = document.createElement("div");
    row.className = "saved-row";
    const when = snap.savedAt
      ? new Date(snap.savedAt).toLocaleString().replace(",", "")
      : "";
    const entCount = (snap.entities || []).length;
    const tpCount = Object.keys(snap.teleporters || {}).length;
    row.innerHTML = `<b>${k.replace("Editor:", "")}</b> ` +
      `<span style="color:#666">` +
      (entCount ? entCount + "e " : "") +
      (tpCount ? tpCount + "tp " : "") +
      when + `</span>`;
    row.title = "Click to load. " + entCount + " entities, " +
      tpCount + " teleporters.";
    row.addEventListener("click", () => {
      loadSnapshot(snap);
      render();
      setStatus("Loaded " + k);
    });
    el.appendChild(row);
  }
}

function deleteThis() {
  const all = JSON.parse(localStorage.getItem("crawlweb.customChunks") || "{}");
  delete all[chunkKey()];
  localStorage.setItem("crawlweb.customChunks", JSON.stringify(all));
  setStatus("Deleted " + chunkKey());
  listSaved();
}

function downloadJSON() {
  const data = snapshot();
  const blob = new Blob([JSON.stringify(data, null, 2)],
                        { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "chunk_" + STATE.cx + "_" + STATE.cy + "_" +
               STATE.floor + ".json";
  a.click();
  URL.revokeObjectURL(url);
  setStatus("Downloaded JSON for " + chunkKey());
}

function importJSON(file) {
  const r = new FileReader();
  r.onload = () => {
    try {
      const snap = JSON.parse(r.result);
      if (loadSnapshot(snap)) { render(); setStatus("Imported " + chunkKey()); }
      else setStatus("Bad JSON.");
    } catch (e) { setStatus("Parse error: " + e.message); }
  };
  r.readAsText(file);
}

function clearChunk() {
  STATE.tiles = makeBlankTiles();
  STATE.tileArt = {};
  STATE.entities = [];
  render();
}

/* =============================================================
 * Wiring
 * ============================================================= */

function init() {
  buildPalette();
  paintToolHighlight();
  render();
  listSaved();
  const cv = document.getElementById("ed-canvas");
  cv.addEventListener("mousedown", (e) => {
    // begin a new edit stroke -- snapshot the state once so the whole
    // drag is a single undo step
    pushUndo();
    STATE.paintMode = e.button === 2 ? "right" : "left";
    handlePaint(e);
    e.preventDefault();
  });
  cv.addEventListener("mousemove", (e) => {
    const r = cv.getBoundingClientRect();
    const x = Math.floor((e.clientX - r.left) / r.width * MAP_W);
    const y = Math.floor((e.clientY - r.top) / r.height * MAP_H);
    const safe = (y >= 0 && y < MAP_H && x >= 0 && x < MAP_W);
    const tHere = safe ? STATE.tiles[y][x] : "-";
    const tp = safe ? STATE.teleporters[y * MAP_W + x] : null;
    const tpInfo = tp
      ? "  ->  chunk (" + tp.cx + "," + tp.cy + ") cell (" +
        tp.x + "," + tp.y + ")"
      : "";
    const ent = safe ? STATE.entities.find(en =>
      en.x === x && en.y === y) : null;
    const entInfo = ent
      ? "  ent:" + ent.kind + (ent.defId || ent.npcKind ||
          ent.itemKey || "")
      : "";
    document.getElementById("ed-cursor-info").textContent =
      "(" + x + "," + y + ")  tile " + tHere + tpInfo + entInfo;
    if (STATE.paintMode) handlePaint(e);
  });
  window.addEventListener("mouseup", () => { STATE.paintMode = null; });
  cv.addEventListener("contextmenu", (e) => e.preventDefault());

  document.querySelectorAll(".ed-tool").forEach(b => {
    b.addEventListener("click", () => {
      STATE.tool = b.dataset.tool;
      paintToolHighlight();
    });
  });
  document.getElementById("ed-cx").addEventListener("input",
    (e) => { STATE.cx = parseInt(e.target.value, 10) || 0; });
  document.getElementById("ed-cy").addEventListener("input",
    (e) => { STATE.cy = parseInt(e.target.value, 10) || 0; });
  document.getElementById("ed-floor").addEventListener("change",
    (e) => { STATE.floor = parseInt(e.target.value, 10) || 0; });
  document.getElementById("ed-save").addEventListener("click", saveToGame);
  document.getElementById("ed-clear").addEventListener("click", clearChunk);
  document.getElementById("ed-export").addEventListener("click", downloadJSON);
  document.getElementById("ed-import").addEventListener("click",
    () => document.getElementById("ed-import-file").click());
  document.getElementById("ed-import-file").addEventListener("change",
    (e) => { if (e.target.files[0]) importJSON(e.target.files[0]); });
  document.getElementById("ed-list").addEventListener("click", listSaved);
  document.getElementById("ed-delete").addEventListener("click", deleteThis);
  document.getElementById("ed-tp-clear").addEventListener("click", () => {
    STATE.currentTeleportDest = null;
    updateTpStatus();
  });
  updateTpStatus();

  // global undo / redo shortcuts -- Ctrl+Z and Ctrl+Y / Ctrl+Shift+Z
  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.key === "z" || e.key === "Z") {
      if (e.shiftKey) redo(); else undo();
      e.preventDefault();
    } else if (e.key === "y" || e.key === "Y") {
      redo();
      e.preventDefault();
    }
  });

  // NPC dialog modal wiring
  const modal = document.getElementById("ed-modal");
  document.getElementById("ed-modal-cancel").addEventListener("click",
    () => { modal.classList.add("hidden"); STATE._modalCallback &&
            STATE._modalCallback(null); STATE._modalCallback = null; });
  document.getElementById("ed-modal-ok").addEventListener("click", () => {
    const name = document.getElementById("ed-modal-name").value.trim();
    const dialog = document.getElementById("ed-modal-dialog").value;
    modal.classList.add("hidden");
    const cb = STATE._modalCallback;
    STATE._modalCallback = null;
    if (cb) cb({ name: name || null, dialog: dialog.trim() || null });
  });

  // re-render on a steady tick so async tile loads paint correctly
  setInterval(render, 250);
}

function updateTpStatus() {
  const el = document.getElementById("ed-tp-status");
  if (!el) return;
  if (STATE.currentTeleportDest) {
    const d = STATE.currentTeleportDest;
    el.textContent = "Next teleporter -> chunk (" + d.cx + "," + d.cy +
                     ") cell (" + d.x + "," + d.y + ")";
  } else {
    el.textContent = "Next teleporter: you'll be asked.";
  }
}

function handlePaint(e) {
  const cv = document.getElementById("ed-canvas");
  const r = cv.getBoundingClientRect();
  const x = Math.floor((e.clientX - r.left) / r.width * MAP_W);
  const y = Math.floor((e.clientY - r.top) / r.height * MAP_H);
  paintAt(x, y, STATE.paintMode);
  render();
}

loadManifest().then(init).catch(err => setStatus("Manifest load error: " + err));
