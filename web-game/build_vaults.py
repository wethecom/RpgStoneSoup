#!/usr/bin/env python3
"""Extract authored room layouts (vaults) from the DCSS .des files.

DCSS dungeons are not purely random: hand-designed rooms called
"vaults" are stamped into generated levels. They live in
source/dat/des/ as `MAP` ... `ENDMAP` ASCII blocks.

This script walks every .des file, pulls out the room-sized vault
layouts, normalises their glyphs to a wall / floor / outside grid the
web-game generator can stamp, and writes web-game/vaults.json.

Glyph handling (DCSS .des conventions):
  x X c v b   rock / stone / metal / crystal wall   -> '#'
  t l G m     tree / lava / statue / column         -> '#'  (obstacle)
  ' ' (space) not part of the vault                 -> ' '  (outside)
  @           a vault entry connection point        -> '.'  (+ recorded)
  everything else (floor, doors, water, monster and
  item slots, stairs, ...)                          -> '.'  (floor)

Usage:
    python web-game/build_vaults.py
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DES_ROOT = REPO_ROOT / "source" / "dat" / "des"
OUT_PATH = Path(__file__).with_name("vaults.json")

WALL_GLYPHS = set("xXcvbGm")     # rock / stone / metal / crystal / statue

# size bounds -- room-sized vaults that fit comfortably in the
# web-game's 56 x 26 level, never the giant encompass / branch-end maps.
MIN_W, MAX_W = 5, 22
MIN_H, MAX_H = 4, 13
MAX_VAULTS = 140


def classify(ch: str) -> str:
    """A .des map glyph -> the web-game terrain kind it stamps.

    '#' wall, '.' floor, '+' closed door, '~' water, 'l' lava,
    't' tree, ' ' outside the vault footprint."""
    if ch == " ":
        return " "
    if ch in WALL_GLYPHS:
        return "#"
    if ch == "+":
        return "+"
    if ch == "w" or ch == "W":     # deep / shallow water
        return "~"
    if ch == "l":                  # lava
        return "l"
    if ch == "t":                  # tree
        return "t"
    return "."                     # floor / feature / monster slot


def extract_maps(text: str):
    """Yield (name, [directive lines], [raw map lines]) per MAP block."""
    name = "unnamed"
    directives: list[str] = []
    in_map = False
    rows: list[str] = []
    for raw in text.splitlines():
        stripped = raw.strip()
        if stripped.startswith("NAME:"):
            name = stripped.split(":", 1)[1].strip() or "unnamed"
            directives = []
            continue
        if not in_map:
            if stripped == "MAP":
                in_map = True
                rows = []
            else:
                directives.append(stripped)
            continue
        if stripped == "ENDMAP":
            in_map = False
            yield name, directives, rows
            continue
        # inside a MAP block: keep the line verbatim (layout is literal)
        rows.append(raw.rstrip("\n"))


def clean_monster(spec: str):
    """A .des monster spec -> a plain monster name, or None.

    Specs can be elaborate ('demonic plant / withered plant w:5',
    'goblin ; stone', 'place:Shoals:1'); we keep the first random
    alternative, drop equipment / weight / decorators, and reject
    anything with a ':' (special placement)."""
    s = spec.split("/")[0].split(";")[0]
    s = re.split(r"\bw:", s)[0]
    s = s.strip().lower()
    for pref in ("generate_awake ", "patrolling ", "hostile ",
                 "fix_slot: ", "good_neutral ", "neutral "):
        if s.startswith(pref):
            s = s[len(pref):]
    s = re.sub(r"\s+band$", "", s).strip()    # 'brain worm band' -> 'brain worm'
    if not s or ":" in s or s in ("nothing", "0") or s.isdigit():
        return None
    return s


def clean_item(spec: str):
    """A .des item spec -> one of the web-game's item kinds, or None."""
    s = spec.lower()
    if "gold" in s:
        return "gold"
    if "healing" in s:
        return "heal"
    if "might" in s:
        return "might"
    if "potion" in s:
        return "potion"
    if any(w in s for w in ("weapon", "sword", "axe", "mace",
                            "dagger", "spear", "blade", "flail")):
        return "weapon"
    return None


def parse_content(directives: list[str]) -> dict:
    """Map MAP glyphs -> placed content via MONS / KMONS / KITEM lines.

    Returns {glyph: ('mon', name) | ('item', kind)}."""
    glyphs: dict = {}
    mons_slot = 0
    for line in directives:
        if line.startswith("MONS:"):
            for spec in line.split(":", 1)[1].split(","):
                mons_slot += 1
                if mons_slot > 9:
                    break
                name = clean_monster(spec)
                if name:
                    glyphs.setdefault(str(mons_slot), ("mon", name))
        elif line.startswith("KMONS:"):
            body = line.split(":", 1)[1]
            if "=" not in body:
                continue
            gpart, spec = body.split("=", 1)
            name = clean_monster(spec)
            if name:
                for g in gpart.strip():
                    glyphs[g] = ("mon", name)
        elif line.startswith("KITEM:"):
            body = line.split(":", 1)[1]
            if "=" not in body:
                continue
            gpart, spec = body.split("=", 1)
            kind = clean_item(spec)
            if kind:
                for g in gpart.strip():
                    glyphs[g] = ("item", kind)
    return glyphs


def parse_tile_overrides(directives: list[str]) -> dict:
    """Map MAP glyphs -> a custom tile name via FTILE / RTILE / TILE
    lines, so a vault keeps its authored floor / wall art.

    Returns {glyph: tile_name}, e.g. {"'": "floor_grass_dark"}."""
    glyphs: dict = {}
    for line in directives:
        for pfx in ("FTILE:", "RTILE:", "TILE:"):
            if not line.startswith(pfx):
                continue
            body = line[len(pfx):]
            if "=" not in body:
                break
            gpart, name = body.split("=", 1)
            # a tile spec can list random alternatives ('a / b'); the
            # first is good enough for the web-game.
            name = name.split("/")[0].strip()
            if name and name != "none":
                for g in gpart.strip():
                    glyphs[g] = name
            break
    return glyphs


def normalise(rows: list[str], content: dict, tile_overrides: dict):
    """Turn raw map lines into a normalised grid + entry / content /
    art lists, or None. `content` maps glyphs to placed monsters /
    items; `tile_overrides` maps glyphs to custom tile names."""
    if not rows:
        return None
    width = max(len(r) for r in rows)
    height = len(rows)
    if not (MIN_W <= width <= MAX_W and MIN_H <= height <= MAX_H):
        return None

    grid = []
    entries = []
    mons = []
    items = []
    art = []                 # [x, y, tile_name] custom-tile cells
    floor = 0
    nonspace = 0
    for y, raw in enumerate(rows):
        line = raw.ljust(width)
        out = []
        for x, ch in enumerate(line):
            c = classify(ch)
            if ch == "@":
                entries.append([x, y])
            if c != " " and ch in content:
                kind, val = content[ch]
                if kind == "mon":
                    mons.append([x, y, val])
                else:
                    items.append([x, y, val])
            if c != " " and ch in tile_overrides:
                art.append([x, y, tile_overrides[ch]])
            if c != " ":
                nonspace += 1
            if c == "." or c == "+" or c == "~":   # walkable space
                floor += 1
            out.append(c)
        grid.append("".join(out))

    # must be a usable room: enough floor, and a solid (mostly
    # rectangular) footprint so it stamps cleanly into rock.
    if floor < 8:
        return None
    if nonspace < width * height * 0.55:
        return None
    if floor > nonspace * 0.95:
        return None    # all floor, no structure -- not interesting

    return {"w": width, "h": height, "rows": grid, "entries": entries,
            "mons": mons, "items": items, "art": art, "floor": floor}


def main() -> int:
    if not DES_ROOT.is_dir():
        sys.exit(f"des directory not found: {DES_ROOT}")

    vaults = []
    seen = set()
    files = sorted(DES_ROOT.rglob("*.des"))
    for path in files:
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for name, directives, rows in extract_maps(text):
            content = parse_content(directives)
            tile_overrides = parse_tile_overrides(directives)
            v = normalise(rows, content, tile_overrides)
            if v is None:
                continue
            key = "\n".join(v["rows"])
            if key in seen:
                continue
            seen.add(key)
            vaults.append({
                "name": name,
                "source": str(path.relative_to(REPO_ROOT)).replace("\\", "/"),
                "w": v["w"], "h": v["h"],
                "rows": v["rows"], "entries": v["entries"],
                "mons": v["mons"], "items": v["items"], "art": v["art"],
            })

    # keep a manageable, varied set: sort by area then sample evenly
    vaults.sort(key=lambda v: v["w"] * v["h"])
    if len(vaults) > MAX_VAULTS:
        step = len(vaults) / MAX_VAULTS
        vaults = [vaults[int(i * step)] for i in range(MAX_VAULTS)]

    OUT_PATH.write_text(json.dumps(
        {"source": "source/dat/des", "count": len(vaults), "vaults": vaults},
        indent=1), encoding="utf-8")
    size_kb = OUT_PATH.stat().st_size / 1024
    print(f"scanned {len(files)} .des files")
    print(f"wrote {OUT_PATH}  ({len(vaults)} vaults, {size_kb:.1f} KB)")
    if vaults:
        sizes = [v["w"] * v["h"] for v in vaults]
        tot_mons = sum(len(v["mons"]) for v in vaults)
        tot_items = sum(len(v["items"]) for v in vaults)
        tot_art = sum(len(v["art"]) for v in vaults)
        terrain = {"~": 0, "l": 0, "t": 0}
        for v in vaults:
            for r in v["rows"]:
                for ch in r:
                    if ch in terrain:
                        terrain[ch] += 1
        print(f"vault size range: {min(sizes)}..{max(sizes)} cells")
        print(f"content: {tot_mons} monsters, {tot_items} items, "
              f"{tot_art} custom-tile cells")
        print(f"terrain cells: {terrain['~']} water, {terrain['l']} lava, "
              f"{terrain['t']} tree")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
