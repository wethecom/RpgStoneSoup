#!/usr/bin/env python3
"""Build the compact game-data.json that the web-game consumes.

Reads the canonical safe-export SQLite database
(`LuaInit-safe-dungeon.sqlite3` in the repo root) and writes
`web-game/game-data.json` — a small, browser-friendly subset of the
exported DCSS definitions: species, backgrounds, monsters, and weapons.

This is the bridge that proves the export is good for something: the
HTML/JS roguelike in this directory runs entirely off this file, with
no C++ and no Python server at play time.

Usage:
    python web-game/build_game_data.py
"""

from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DB_PATH = REPO_ROOT / "LuaInit-safe-dungeon.sqlite3"
OUT_PATH = Path(__file__).with_name("game-data.json")

# Monsters that are a poor fit for a simple melee roguelike (no body,
# special placement, or otherwise not a normal floor encounter).
MONSTER_NAME_BLOCKLIST = {
    "the royal jelly", "test spawner", "orb of fire", "ball lightning",
    "fulminant prism", "battlesphere", "spectral weapon", "lurking horror",
}


def _depth_tier(hp: int, max_atk_damage: int, hd: int) -> int:
    """Bucket a monster into a dungeon depth tier 1..9.

    Hit dice alone is a poor danger proxy: several DCSS entries are
    derived job-monsters (battlemage, hexer, ...) with placeholder
    `hd=1` but a real, lethal melee attack. Tier on a *threat score*
    that weights both how much punishment the monster can take (hp)
    and how hard it hits (attack damage), so a glass-cannon sorts
    deep rather than landing on D:1.
    """
    threat = hp + 4 * max_atk_damage + hd
    bands = [22, 38, 60, 92, 140, 215, 330, 520]
    for tier, ceiling in enumerate(bands, start=1):
        if threat <= ceiling:
            return tier
    return 9


def build() -> dict:
    if not DB_PATH.exists():
        sys.exit(
            f"export database not found: {DB_PATH}\n"
            "run: python tools/regenerate_safe_export.py LuaInit"
        )

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    schema_version = cur.execute(
        "SELECT schema_version FROM schema_info"
    ).fetchone()[0]

    # --- species ---------------------------------------------------------
    species = []
    for row in cur.execute(
        """
        SELECT species_id, name, abbr, hp_mod, mp_mod, xp_mod, wl_mod,
               strength, intelligence, dexterity, size
        FROM species_defs
        ORDER BY name
        """
    ):
        species.append(
            {
                "id": row["species_id"],
                "name": row["name"],
                "abbr": row["abbr"],
                "hp_mod": row["hp_mod"] or 0,
                "mp_mod": row["mp_mod"] or 0,
                "xp_mod": row["xp_mod"] or 0,
                "wl_mod": row["wl_mod"] or 0,
                "str": row["strength"] or 0,
                "int": row["intelligence"] or 0,
                "dex": row["dexterity"] or 0,
                "size": (row["size"] or "SIZE_MEDIUM")
                        .replace("SIZE_", "").lower(),
            }
        )

    # --- backgrounds (jobs) ---------------------------------------------
    jobs = []
    for row in cur.execute(
        """
        SELECT job_id, name, abbr, strength, intelligence, dexterity,
               weapon_choice
        FROM job_defs
        ORDER BY name
        """
    ):
        jobs.append(
            {
                "id": row["job_id"],
                "name": row["name"],
                "abbr": row["abbr"],
                "str": row["strength"] or 0,
                "int": row["intelligence"] or 0,
                "dex": row["dexterity"] or 0,
            }
        )

    # --- monsters --------------------------------------------------------
    # Attacks first, keyed by the monster_defs row id.
    attacks: dict[int, list[dict]] = {}
    for row in cur.execute(
        """
        SELECT monster_def_id, attack_type, attack_flavour, damage
        FROM monster_attacks
        WHERE damage > 0
        ORDER BY monster_def_id, attack_index
        """
    ):
        attacks.setdefault(row["monster_def_id"], []).append(
            {
                "type": (row["attack_type"] or "AT_HIT"),
                "flavour": (row["attack_flavour"] or "AF_PLAIN"),
                "damage": row["damage"],
            }
        )

    # A monster is a ranged caster if its spellbook holds a conjuration
    # (ranged damage) spell. Resolve that purely from the export:
    # spell_defs -> conjuration spells -> the spellbooks that use them.
    # Each ranged monster keeps its real offensive spell list, so it
    # casts what its spellbook actually carries.
    conj_spells = {}
    for r in cur.execute(
        "SELECT spell_id, title, level FROM spell_defs "
        "WHERE schools_expr LIKE '%conjuration%'"
    ):
        conj_spells[r["spell_id"]] = {
            "title": r["title"], "level": int(r["level"] or 1),
        }
    book_offensive: dict[str, list] = {}
    for r in cur.execute(
        "SELECT spellbook_id, spell_id FROM monster_spellbook_spells"
    ):
        spell = conj_spells.get(r["spell_id"])
        if not spell:
            continue
        seen_titles = book_offensive.setdefault(r["spellbook_id"], [])
        if spell["title"] not in [s["title"] for s in seen_titles]:
            seen_titles.append(spell)
    ranged_books = set(book_offensive)

    monsters = []
    for row in cur.execute(
        """
        SELECT id, monster_id, name, glyph, colour, hd, avg_hp_10x,
               ac, ev, speed, exp, intel, holiness, spellbook
        FROM monster_defs
        WHERE length(glyph) = 1
          AND glyph GLOB '[A-Za-z]'
          AND avg_hp_10x > 0
          AND hd >= 1 AND hd <= 20
        ORDER BY hd, name
        """
    ):
        name = (row["name"] or "").strip()
        if not name or name.lower() in MONSTER_NAME_BLOCKLIST:
            continue
        if name.startswith(("the ", "a ")):
            continue
        mon_attacks = attacks.get(row["id"], [])
        ranged = (row["spellbook"] or "") in ranged_books
        if not mon_attacks and not ranged:
            # neither melee nor ranged -- a non-combatant; skip it.
            continue
        hd = int(row["hd"] or 1)
        hp = max(1, int(round((row["avg_hp_10x"] or 10) / 10.0)))
        melee_max = max((a["damage"] for a in mon_attacks), default=0)
        # a ranged-only caster still needs an attack value for tiering
        max_atk = max(melee_max, hd + 2 if ranged else 0, 1)
        monsters.append(
            {
                "id": row["monster_id"],
                "name": name,
                "glyph": row["glyph"],
                "colour": row["colour"] or "LIGHTGRAY",
                "hd": hd,
                "hp": hp,
                "ac": int(row["ac"] or 0),
                "ev": int(row["ev"] or 0),
                "speed": int(row["speed"] or 10),
                "exp": int(row["exp"] or 1),
                "intel": row["intel"] or "I_ANIMAL",
                "tier": _depth_tier(hp, max_atk, hd),
                "attacks": mon_attacks,
                "ranged": ranged,
                "ranged_spells": book_offensive.get(row["spellbook"] or "", []),
            }
        )

    # --- weapons (every melee weapon in weapon_defs) ---------------------
    # the real columns are name / damage / to_hit / speed / skill.
    MELEE_SKILLS = {"SK_SHORT_BLADES", "SK_LONG_BLADES", "SK_AXES",
                    "SK_MACES_FLAILS", "SK_POLEARMS", "SK_STAVES"}
    weapons = []
    for row in cur.execute(
        """
        SELECT name, damage, to_hit, speed, skill FROM weapon_defs
        WHERE damage > 0 AND name NOT LIKE 'old %'
          AND name NOT LIKE '%removed%'
        ORDER BY damage
        """
    ):
        if (row["skill"] or "") not in MELEE_SKILLS:
            continue                           # melee weapons only
        weapons.append({
            "name": row["name"],
            "damage": int(row["damage"]),
            "acc": int(row["to_hit"] or 0),
            "speed": int(row["speed"] or 10),
            "skill": (row["skill"] or "").replace("SK_", "")
                     .replace("_", " ").lower(),
        })

    # --- body armour (armour_defs) --------------------------------------
    armour = []
    for row in cur.execute(
        """
        SELECT name, ac, ev_penalty
        FROM armour_defs
        WHERE slot = 'SLOT_BODY_ARMOUR' AND ac > 0
          AND name NOT LIKE 'removed%' AND name NOT LIKE '%hide'
        ORDER BY ac
        """
    ):
        armour.append({
            "name": row["name"],
            "ac": int(row["ac"]),
            "ev_penalty": int(row["ev_penalty"] or 0),
        })

    # --- rings (jewellery_type_defs) ------------------------------------
    # only the rings whose effect the web-game actually models
    rings = []
    for row in cur.execute(
        """
        SELECT name, terse_name
        FROM jewellery_type_defs
        WHERE kind = 'ring' AND is_obsolete = 0
          AND terse_name IN ('AC', 'EV', 'Str', 'Dex', 'Slay')
        ORDER BY order_index
        """
    ):
        rings.append({"name": row["name"], "terse": row["terse_name"]})

    # --- scrolls (scroll_type_defs) -------------------------------------
    # the no-targeting scrolls the web-game implements
    scrolls = []
    for row in cur.execute(
        """
        SELECT name FROM scroll_type_defs
        WHERE name IN ('teleportation', 'fear') AND is_real_scroll_type = 1
        ORDER BY order_index
        """
    ):
        scrolls.append({"name": row["name"]})

    # --- spells (spell_defs) --------------------------------------------
    # the small set of spells the web-game implements for casters; MP
    # cost follows DCSS convention (= spell level).
    spells = []
    for row in cur.execute(
        """
        SELECT spell_id, title, level, schools_expr
        FROM spell_defs
        WHERE title IN ('Magic Dart', 'Throw Flame', 'Blink',
                        'Sting', 'Freeze', 'Slow', 'Confuse',
                        'Swiftness', 'Mephitic Cloud',
                        'Lightning Bolt', 'Bolt of Fire',
                        'Iron Shot', 'Fireball')
        ORDER BY level
        """
    ):
        schools = (row["schools_expr"] or "").replace("spschool::", "")
        schools = " / ".join(s.strip() for s in schools.split("|") if s.strip())
        spells.append({
            "id": row["spell_id"],
            "title": row["title"],
            "level": int(row["level"]),
            "mp": int(row["level"]),
            "schools": schools,
        })

    # --- gods (god_defs) ------------------------------------------------
    # the gods the web-game implements an altar / worship for
    gods = []
    for row in cur.execute(
        """
        SELECT god_id, name, colour FROM god_defs
        WHERE god_id IN ('GOD_TROG', 'GOD_OKAWARU', 'GOD_MAKHLEB',
                         'GOD_ELYVILON', 'GOD_SHINING_ONE', 'GOD_VEHUMET',
                         'GOD_KIKUBAAQUDGHA', 'GOD_SIF_MUNA',
                         'GOD_ASHENZARI')
        """
    ):
        gods.append({
            "id": row["god_id"],
            "name": row["name"],
            "colour": row["colour"] or "WHITE",
        })

    # --- wands (wand_type_defs) -----------------------------------------
    # the wands the web-game implements an effect for
    wands = []
    for row in cur.execute(
        """
        SELECT name FROM wand_type_defs
        WHERE name IN ('flame', 'iceblast', 'acid', 'paralysis')
          AND is_real_wand_type = 1 AND is_removed = 0
        ORDER BY order_index
        """
    ):
        wands.append({"name": row["name"]})

    # --- throwing weapons (missile_defs) --------------------------------
    missiles = []
    for row in cur.execute(
        """
        SELECT name, damage FROM missile_defs
        WHERE name IN ('javelin', 'boomerang') AND damage > 0
        """
    ):
        missiles.append({"name": row["name"], "damage": int(row["damage"])})

    conn.close()

    return {
        "schema_version": schema_version,
        "source": "LuaInit-safe-dungeon.sqlite3",
        "generated_by": "web-game/build_game_data.py",
        "species": species,
        "jobs": jobs,
        "monsters": monsters,
        "weapons": weapons,
        "armour": armour,
        "rings": rings,
        "scrolls": scrolls,
        "spells": spells,
        "wands": wands,
        "missiles": missiles,
        "gods": gods,
    }


def main() -> int:
    data = build()
    OUT_PATH.write_text(json.dumps(data, indent=1), encoding="utf-8")
    size_kb = OUT_PATH.stat().st_size / 1024
    print(f"wrote {OUT_PATH}  ({size_kb:.1f} KB)")
    print(
        f"schema_version={data['schema_version']}  "
        f"species={len(data['species'])}  "
        f"jobs={len(data['jobs'])}  "
        f"monsters={len(data['monsters'])}  "
        f"weapons={len(data['weapons'])}  "
        f"armour={len(data['armour'])}  "
        f"rings={len(data['rings'])}  "
        f"scrolls={len(data['scrolls'])}  "
        f"spells={len(data['spells'])}  "
        f"wands={len(data['wands'])}  "
        f"missiles={len(data['missiles'])}  "
        f"gods={len(data['gods'])}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
