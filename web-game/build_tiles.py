#!/usr/bin/env python3
"""Copy the DCSS tile art the web-game needs into web-game/tiles/.

DCSS ships every monster / floor / wall / feature as an individual PNG
under source/rltiles/. This script:

  1. parses source/rltiles/dc-mon.txt to map each MONS_* tile enum to
     its PNG file,
  2. resolves the tile for every monster in game-data.json and copies
     that PNG to web-game/tiles/mon/<MONSTER_ID>.png,
  3. copies floor / wall / stairs art to web-game/tiles/dngn/,
  4. copies a player sprite per species to web-game/tiles/player/,
  5. copies a few item sprites,
  6. writes web-game/tiles/manifest.json mapping game ids -> files.

Monsters whose tile cannot be resolved are simply omitted from the
manifest; the game falls back to an ASCII glyph for those.

Usage:
    python web-game/build_tiles.py
"""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
RLTILES = REPO_ROOT / "source" / "rltiles"
WEB = Path(__file__).resolve().parent
GAME_DATA = WEB / "game-data.json"
TILES_DIR = WEB / "tiles"

# A handful of monsters are not defined in dc-mon.txt by their MONS_*
# enum: derived monsters (draconians live in dc-player.txt as DRACONIAN_*),
# tentacles (dc-tentacles.txt, directional), composites (mutant beast),
# and a few others. Map those game ids straight to their rltiles art.
MONSTER_TILE_OVERRIDES = {
    "MONS_KRAKEN":            "mon/aquatic/kraken_head.png",
    "MONS_KRAKEN_TENTACLE":   "mon/tentacles/kraken_ends/kraken_tentacle1.png",
    "MONS_ELDRITCH_TENTACLE": "mon/tentacles/eldritch_ends/eldritch_tentacle1.png",
    "MONS_BOUND_SOUL":        "mon/undead/bound_souls/bound_humanoid.png",
    "MONS_MUTANT_BEAST":      "mon/mutantbeast/base1.png",
    "MONS_DJINNI":            "player/base/djinni_blue_m.png",
    "MONS_NAMELESS":          "mon/aberrations/nameless_horror.png",
    "MONS_ELEPHANT_SLUG":     "mon/animals/elephant_slug.png",
    "MONS_DRACONIAN":         "player/base/draconian.png",
    "MONS_BLACK_DRACONIAN":   "player/base/draconian_black.png",
    "MONS_GREEN_DRACONIAN":   "player/base/draconian_green.png",
    "MONS_GREY_DRACONIAN":    "player/base/draconian_grey.png",
    "MONS_PALE_DRACONIAN":    "player/base/draconian_pale.png",
    "MONS_PURPLE_DRACONIAN":  "player/base/draconian_purple.png",
    "MONS_RED_DRACONIAN":     "player/base/draconian_red.png",
}


def parse_dc_tiles(filename: str) -> dict:
    """Parse a dc-*.txt tile-definition file (dc-floor.txt / dc-wall.txt).

    Returns {TILE_TOKEN: [png Path, ...]}. The format, like dc-mon.txt:
      %sdir dngn/floor          -- sets the source directory
      grey_dirt0 FLOOR_GREY_DIRT FLOOR_NORMAL   -- file + token(s)
      grey_dirt1                -- a bare line is another variant frame
                                   of the most recent token group
    A token line may declare several aliases (FLOOR_NORMAL is an alias
    of FLOOR_GREY_DIRT). `%weight` may appear mid-group; any other
    `%` directive ends the current group.
    """
    txt = (RLTILES / filename).read_text(encoding="utf-8")
    token_to_pngs: dict = {}
    cur_dir = "dngn"
    cur_tokens: list = []          # tokens the current variant run feeds
    for raw in txt.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("%"):
            if line.startswith("%sdir"):
                cur_dir = line.split(None, 1)[1].strip()
                cur_tokens = []
            elif not line.startswith("%weight"):
                cur_tokens = []     # %variation / %repeat / ... end the run
            continue
        parts = line.split()
        fname = parts[0]
        tokens = [p for p in parts[1:] if p.isupper() or "_" in p and
                  p.upper() == p]
        png = (RLTILES / (fname + ".png")) if "/" in fname \
            else (RLTILES / cur_dir / (fname + ".png"))
        if tokens:
            cur_tokens = tokens
            for tok in tokens:
                token_to_pngs.setdefault(tok, [])
        if png.exists():
            for tok in cur_tokens:
                token_to_pngs[tok].append(png)
    return token_to_pngs


def parse_dc_mon() -> dict:
    """Map MONS_* tile enum -> PNG path relative to rltiles."""
    txt = (RLTILES / "dc-mon.txt").read_text(encoding="utf-8")
    enum_to_png = {}
    cur_dir = "mon"
    for raw in txt.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("%sdir"):
            cur_dir = line.split(None, 1)[1].strip()
            continue
        if line.startswith("%"):
            continue
        parts = line.split()
        if len(parts) < 2:
            continue  # animation frame for the previous entry -- skip
        fname, enum = parts[0], parts[1]
        if not enum.startswith("MONS_"):
            continue
        # A filename containing '/' is a path relative to rltiles and
        # overrides the current %sdir (e.g. 'mon/undead/bone_dragon').
        if "/" in fname:
            png = RLTILES / (fname + ".png")
        else:
            png = RLTILES / cur_dir / (fname + ".png")
        if png.exists():
            enum_to_png[enum] = png
    return enum_to_png


def resolve_monster_tile(tile_base, enum_to_png):
    """tile_base like 'TILEP_MONS_RAT' -> the mon PNG, or None."""
    if not tile_base:
        return None
    enum = tile_base
    for prefix in ("TILEP_", "TILE_"):
        if enum.startswith(prefix):
            enum = enum[len(prefix):]
            break
    return enum_to_png.get(enum)


def first_existing(*rel_paths):
    for rel in rel_paths:
        p = RLTILES / rel
        if p.exists():
            return p
    return None


def species_sprite(name: str):
    """Best-effort player base sprite for a species name."""
    base = RLTILES / "player" / "base"
    slug = name.lower().replace("'", "").replace("-", "_")
    words = slug.split()
    candidates = []
    candidates.append("_".join(words) + "_m")
    if len(words) > 1:
        candidates.append(words[-1] + "_m")           # 'hill orc' -> orc_m
    candidates.append("_".join(words) + "1_m")
    for c in candidates:
        p = base / (c + ".png")
        if p.exists():
            return p
    return base / "human_m.png"


def main() -> int:
    if not GAME_DATA.exists():
        sys.exit("game-data.json missing -- run build_game_data.py first")
    data = json.loads(GAME_DATA.read_text(encoding="utf-8"))

    # fresh tiles dir
    if TILES_DIR.exists():
        shutil.rmtree(TILES_DIR)
    (TILES_DIR / "mon").mkdir(parents=True)
    (TILES_DIR / "dngn").mkdir(parents=True)
    (TILES_DIR / "player").mkdir(parents=True)
    (TILES_DIR / "item").mkdir(parents=True)

    enum_to_png = parse_dc_mon()
    print(f"dc-mon.txt: {len(enum_to_png)} monster tile enums resolved")

    manifest = {
        "source": "source/rltiles",
        "tile_size": 32,
        "monsters": {},
        "dngn": {},
        "player": {},
        "item": {},
    }

    # --- monsters ---
    resolved = 0
    unresolved = []
    for mon in data["monsters"]:
        png = resolve_monster_tile(mon.get("tile_base") if "tile_base" in mon
                                   else None, enum_to_png)
        # game-data.json does not carry tile_base; resolve by id directly.
        if png is None:
            # mon["id"] is like MONS_RAT
            png = enum_to_png.get(mon["id"])
        # fall back to the explicit override table
        if png is None and mon["id"] in MONSTER_TILE_OVERRIDES:
            cand = RLTILES / MONSTER_TILE_OVERRIDES[mon["id"]]
            if cand.exists():
                png = cand
        if png is None:
            unresolved.append(mon["id"])
            continue
        dst_name = mon["id"] + ".png"
        shutil.copy(png, TILES_DIR / "mon" / dst_name)
        manifest["monsters"][mon["id"]] = "mon/" + dst_name
        resolved += 1
    print(f"monsters: {resolved}/{len(data['monsters'])} tiles copied")
    if unresolved:
        print(f"  still unresolved ({len(unresolved)}): " +
              ", ".join(unresolved))

    # --- dungeon features ---
    # Each depth gets its own floor/wall theme. The theme tiles are the
    # real DCSS tile tokens that each branch uses -- taken from the
    # branch .des files in source/dat/des/branches/ (lair.des uses
    # floor_lair, orc.des uses floor_orc, vaults.des uses floor_vault,
    # etc.) and resolved to PNG variant sets via dc-floor.txt /
    # dc-wall.txt. Within a floor the renderer autotiles by picking a
    # deterministic per-cell variant from the theme's set.
    #
    # (label, floor token, wall token)  -- one per descending depth
    DEPTH_THEMES = [
        ("Dungeon",       "FLOOR_NORMAL", "WALL_NORMAL"),
        ("Lair",          "FLOOR_LAIR",   "WALL_LAIR"),
        ("Orcish Mines",  "FLOOR_ORC",    "WALL_ORC"),
        ("Crypt",         "FLOOR_CRYPT",  "WALL_CRYPT"),
        ("Vaults",        "FLOOR_VAULT",  "WALL_TOMB"),
    ]

    floor_tokens = parse_dc_tiles("dc-floor.txt")
    wall_tokens = parse_dc_tiles("dc-wall.txt")
    print(f"dc-floor.txt: {len(floor_tokens)} floor tokens; "
          f"dc-wall.txt: {len(wall_tokens)} wall tokens")

    def copy_token(token_map, token, prefix, limit=6):
        """Copy up to `limit` variant PNGs for a DCSS tile token."""
        pngs = token_map.get(token, [])[:limit]
        out = []
        for i, src in enumerate(pngs):
            dst = f"{prefix}{i}.png"
            shutil.copy(src, TILES_DIR / "dngn" / dst)
            out.append("dngn/" + dst)
        return out

    def copy_variants(glob_pat, prefix, limit=6):
        """Copy up to `limit` tiles matching dngn/<glob_pat> -> tiles/dngn."""
        matches = sorted((RLTILES / "dngn").glob(glob_pat))
        out = []
        for i, src in enumerate(matches[:limit]):
            dst = f"{prefix}{i}.png"
            shutil.copy(src, TILES_DIR / "dngn" / dst)
            out.append("dngn/" + dst)
        return out

    themes = []
    for d, (label, floor_tok, wall_tok) in enumerate(DEPTH_THEMES, start=1):
        floor = copy_token(floor_tokens, floor_tok, f"d{d}_floor")
        wall = copy_token(wall_tokens, wall_tok, f"d{d}_wall")
        if not floor or not wall:
            print(f"  WARNING: depth {d} ({label}) theme missing tiles "
                  f"-- floor {floor_tok}={len(floor)} "
                  f"wall {wall_tok}={len(wall)}")
        themes.append({"label": label, "floor": floor, "wall": wall})
    manifest["dngn"]["themes"] = themes
    print("dngn themes: " +
          ", ".join(f"D:{i+1} {t['label']}({len(t['floor'])}f/{len(t['wall'])}w)"
                    for i, t in enumerate(themes)))

    feature_pick = {
        "stairs_down": first_existing("dngn/gateways/one_way_stairs_down.png",
                                      "dngn/gateways/metal_stairs_down.png"),
        "stairs_up": first_existing("dngn/gateways/one_way_stairs_up.png",
                                    "dngn/gateways/metal_stairs_up.png"),
        "door_closed": first_existing("dngn/doors/closed_door.png"),
        "door_open": first_existing("dngn/doors/open_door.png"),
        "water": first_existing("dngn/water/deep_water.png"),
    }
    for key, png in feature_pick.items():
        if png is None:
            print(f"  WARNING: no tile found for dngn/{key}")
            continue
        dst = key + ".png"
        shutil.copy(png, TILES_DIR / "dngn" / dst)
        manifest["dngn"][key] = "dngn/" + dst

    # per-god altar tiles
    ALTAR_FILES = {
        "GOD_TROG": "trog", "GOD_OKAWARU": "okawaru",
        "GOD_ELYVILON": "elyvilon", "GOD_SHINING_ONE": "shining_one",
        "GOD_MAKHLEB": "makhleb_flame1", "GOD_VEHUMET": "vehumet1",
    }
    for god_id, fname in ALTAR_FILES.items():
        png = first_existing("dngn/altars/" + fname + ".png")
        if png is None:
            continue
        dst = "altar_" + god_id.lower() + ".png"
        shutil.copy(png, TILES_DIR / "dngn" / dst)
        manifest["dngn"]["altar_" + god_id] = "dngn/" + dst

    # lava and trees autotile from variant sets, like floors and walls
    lava = copy_variants("floor/lava[0-9]*.png", "lava")
    tree = copy_variants("trees/tree[0-9]*.png", "tree")
    if lava:
        manifest["dngn"]["lava"] = lava
    if tree:
        manifest["dngn"]["tree"] = tree
    print(f"terrain: water + {len(lava)} lava + {len(tree)} tree variants")

    # --- player sprites, one per species in the data ---
    seen = set()
    for sp in data["species"]:
        png = species_sprite(sp["name"])
        if not png.exists():
            continue
        dst = sp["id"] + ".png"
        shutil.copy(png, TILES_DIR / "player" / dst)
        manifest["player"][sp["id"]] = "player/" + dst
        seen.add(png.name)
    # generic fallback
    human = RLTILES / "player" / "base" / "human_m.png"
    if human.exists():
        shutil.copy(human, TILES_DIR / "player" / "_default.png")
        manifest["player"]["_default"] = "player/_default.png"
    print(f"player: {len(manifest['player'])} species sprites copied")

    # --- paper-doll overlays: weapon (hand1) and body armour (body) ---
    # these layer over a species base sprite, the way DCSS composites
    # its player tiles.
    manifest["doll"] = {"weapon": {}, "armour": {}}
    # a few weapons whose hand1 tile is not a plain slug match
    WEAPON_DOLL = {
        "long sword": "long_sword_slant", "great sword": "great_sword_slant",
        "hand axe": "hand_axe", "executioner's axe": "axe_executioner",
        "demon blade": "demonblade", "giant club": "giant_club",
    }
    for w in data.get("weapons", []):
        wname = w["name"]
        slug = wname.replace(" ", "_").replace("'", "")
        cands = []
        if wname in WEAPON_DOLL:
            cands.append("player/hand1/" + WEAPON_DOLL[wname] + ".png")
        for suf in ("1", "", "_slant", "1_slant", "2"):
            cands.append("player/hand1/" + slug + suf + ".png")
        png = first_existing(*cands)
        if png is None:
            continue
        dst = "dollw_" + slug + ".png"
        shutil.copy(png, TILES_DIR / "player" / dst)
        manifest["doll"]["weapon"][wname] = "player/" + dst
    # armour name keyword -> body paper-doll tile
    ARMOUR_DOLL_KW = [
        ("animal skin", "animal_skin"), ("troll", "troll_leather"),
        ("leather", "leather2"), ("ring mail", "ringmail"),
        ("scale", "scalemail"), ("chain", "chainmail"),
        ("plate", "plate"), ("robe", "robe_black"),
    ]
    for arm in data.get("armour", []):
        nm = arm["name"].lower()
        for kw, fname in ARMOUR_DOLL_KW:
            if kw in nm:
                png = first_existing("player/body/" + fname + ".png")
                if png is None:
                    break
                dst = "dolla_" + fname + ".png"
                if not (TILES_DIR / "player" / dst).exists():
                    shutil.copy(png, TILES_DIR / "player" / dst)
                manifest["doll"]["armour"][arm["name"]] = "player/" + dst
                break
    print(f"paper-doll: {len(manifest['doll']['weapon'])} weapon + "
          f"{len(manifest['doll']['armour'])} armour overlays")

    # --- per-weapon item icons: each weapon its own floor / inventory
    #     tile, resolved from rltiles item/weapon by name ---
    WEAPON_ICON_ALIAS = {
        "quick blade": "quickblade1", "whip": "bullwhip",
        "eudemon blade": "blessed_blade", "battleaxe": "battle_axe1",
        "great mace": "mace_large1", "great sword": "greatsword1",
        "executioner's axe": "executioner_axe1",
    }
    (TILES_DIR / "item" / "weapon").mkdir(parents=True, exist_ok=True)
    manifest["item_weapons"] = {}
    for w in data.get("weapons", []):
        nm = w["name"]
        if nm in WEAPON_ICON_ALIAS:
            cands = ["item/weapon/" + WEAPON_ICON_ALIAS[nm] + ".png"]
        else:
            slug = nm.replace(" ", "_").replace("'", "")
            cands = ["item/weapon/" + slug + s + ".png"
                     for s in ("1", "", "2", "3")]
        png = first_existing(*cands)
        if png is None:
            continue
        rel = "item/weapon/" + png.name
        shutil.copy(png, TILES_DIR / rel)
        manifest["item_weapons"][nm] = rel
    print(f"weapon icons: {len(manifest['item_weapons'])} / "
          f"{len(data.get('weapons', []))}")

    # --- items ---
    item_pick = {
        "heal": first_existing("item/potion/ruby.png",
                               "item/potion/brilliant_blue.png",
                               "item/potion/brown.png"),
        "might": first_existing("item/potion/crimson.png",
                                "item/potion/black.png"),
        "gold": first_existing("item/gold/08.png", "item/gold/01.png"),
        "weapon": first_existing("item/weapon/short_sword1.png",
                                 "item/weapon/dagger.png"),
        "orb": first_existing("item/misc/orb_of_zot1.png",
                              "item/misc/uncollected_orb.png"),
        "armour": first_existing("item/armour/chain_mail1.png",
                                 "item/armour/cloak1_leather.png"),
        "ring": first_existing("item/ring/emerald.png",
                               "item/ring/agate.png"),
        "scroll": first_existing("item/scroll/i-blinking.png",
                                 "item/scroll/i-fear.png"),
        "wand": first_existing("item/wand/gem_brass.png",
                               "item/wand/gem_bone.png"),
        "missile": first_existing("item/weapon/ranged/javelin1.png",
                                  "item/weapon/ranged/boomerang1.png"),
    }
    for key, png in item_pick.items():
        if png is None:
            print(f"  WARNING: no tile found for item/{key}")
            continue
        dst = key + ".png"
        shutil.copy(png, TILES_DIR / "item" / dst)
        manifest["item"][key] = "item/" + dst

    # --- custom vault tiles (FTILE / RTILE / TILE from the .des) ---------
    # vaults.json records, per cell, an authored tile name like
    # 'floor_moss' or 'wall_church'. Resolve each to a PNG through the
    # tile-definition files so a vault keeps its designed floor / wall.
    manifest["vault_tiles"] = {}
    vaults_path = WEB / "vaults.json"
    if vaults_path.exists():
        vault_doc = json.loads(vaults_path.read_text(encoding="utf-8"))
        art_names = set()
        for v in vault_doc.get("vaults", []):
            for cell in v.get("art", []):
                art_names.add(cell[2])
        # one combined token map from the floor / wall / dngn defs
        tok = {}
        for fn in ("dc-floor.txt", "dc-wall.txt", "dc-dngn.txt"):
            for k, vlist in parse_dc_tiles(fn).items():
                tok.setdefault(k, vlist)
        COLOURS_SUFFIX = ("brown", "blue", "green", "cyan", "red",
                          "magenta", "darkgray", "lightgray", "lightblue",
                          "lightgreen", "lightcyan", "lightred",
                          "lightmagenta", "yellow", "white", "black",
                          "gray", "grey")
        resolved = 0
        for name in sorted(art_names):
            token = name.upper()
            pngs = tok.get(token)
            if not pngs:
                # 'wall_pebble_darkgray' -> try the base 'wall_pebble'
                parts = name.split("_")
                if len(parts) > 2 and parts[-1] in COLOURS_SUFFIX:
                    pngs = tok.get("_".join(parts[:-1]).upper())
            if not pngs:
                continue
            dst = "vt_" + name + ".png"
            shutil.copy(pngs[0], TILES_DIR / "dngn" / dst)
            manifest["vault_tiles"][name] = "dngn/" + dst
            resolved += 1
        print(f"vault tiles: {resolved}/{len(art_names)} custom tile "
              f"names resolved to art")

    (TILES_DIR / "manifest.json").write_text(
        json.dumps(manifest, indent=1), encoding="utf-8")

    total = (len(manifest["monsters"]) + len(manifest["dngn"]) +
             len(manifest["player"]) + len(manifest["item"]))
    print(f"wrote {TILES_DIR}/manifest.json  ({total} tiles total)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
