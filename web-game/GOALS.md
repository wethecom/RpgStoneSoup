# Crawl Web — Goals

A followable list of what this browser game is, what's done, and what's
next. Updated as work lands so progress is easy to track at a glance.

The game lives in `web-game/` and runs entirely on the structured DCSS
export — see `README.md` for how it all fits together.

## Done

- [x] **Game-data extraction** — `build_game_data.py` reads the SQLite
  export into a compact `game-data.json` (48 species, 32 backgrounds,
  329 monsters).
- [x] **Playable roguelike core** — character creation, procedural
  dungeon (rooms + corridors), field-of-view, energy-based turns,
  monster AI, melee combat mirroring the exported `fight.cc` math,
  XP / levels, items, potions, descent, win/lose.
- [x] **Headless test** — `test_headless.js` plays full games in a
  stubbed DOM; verifies generation, connectivity, combat, descent and
  that the game is winnable-but-lethal (23 checks).
- [x] **Tile graphics** — real DCSS sprite art from `source/rltiles/`.
  All 329 / 329 monsters resolved (via `dc-mon.txt` + an override
  table for draconians / tentacles / kraken / etc.).
- [x] **Autotiling** — deterministic per-cell floor/wall variants plus
  neighbour-aware wall shadows.
- [x] **Per-depth dungeon themes** — each of the 5 depths uses the real
  DCSS branch tiles (Dungeon, Lair, Orcish Mines, Crypt, Vaults),
  resolved from `dc-floor.txt` / `dc-wall.txt`.
- [x] **On-page instructions** — How-to-Play panel on the title screen,
  a controls strip on the game screen, and an in-game `?` help overlay.
- [x] **Vault layouts in the generator** — `build_vaults.py` parses the
  authored room layouts from the DCSS `.des` files (`source/dat/des/`,
  the `MAP`/`ENDMAP` blocks); the generator stamps 1-2 of them into
  every level and connects them with corridors, so dungeons contain
  hand-designed rooms, not only random rectangles.
- [x] **Mouse controls** — click a tile to walk there (BFS pathfinding
  with auto-walk that stops when a monster comes into view), click an
  adjacent tile to step or attack, click yourself to wait / pick up,
  plus an on-screen action-button bar and a hover-tile highlight. The
  keyboard still works.
- [x] **Vault contents** — `build_vaults.py` also parses each vault's
  `MONS:` / `KMONS:` / `KITEM:` directives; the generator places those
  authored monsters and items when it stamps a vault, with a depth cap
  so a deep-branch vault can't drop something unfair on an early floor.
- [x] **Vault terrain & custom tiles** — vaults are no longer reduced
  to wall/floor. `build_vaults.py` keeps the real terrain: water
  (`w`/`W`), lava (`l`) and trees (`t`) become their own tile types
  (water is wadeable, lava and trees block), and the `.des`
  `FTILE:` / `RTILE:` / `TILE:` directives are parsed so each vault
  cell keeps its **authored floor / wall art** (grass, moss,
  checkered stone, sand, …), resolved to real DCSS tiles by
  `build_tiles.py`. A vault now looks like the room its designer drew.

- [x] **Doors** — the `.des` `+` glyph and a share of generated room
  entrances become closed doors. A closed door blocks movement and
  line-of-sight; walking into it opens it (so does a monster, and
  click-travel opens doors en route). Real DCSS door sprites.
- [x] **Item variety: armour, rings, scrolls** — `build_game_data.py`
  exports body armour (`armour_defs`), the five modelled rings
  (`jewellery_type_defs`) and the no-targeting scrolls
  (`scroll_type_defs`). You can wear armour (+AC, EV penalty), wear a
  ring (protection / evasion / strength / dexterity / slaying), and
  read scrolls of teleportation and fear. Wands are deferred to the
  ranged-combat goal since they need targeting.

- [x] **Spells for caster backgrounds** — `build_game_data.py` exports
  Magic Dart, Throw Flame and Blink from `spell_defs`. Caster
  backgrounds (Conjurer, the Elementalists, Necromancer, …) start
  knowing some; cast with `z` or the per-spell action buttons. Damage
  spells auto-target the nearest monster in sight; Blink is a short
  self-teleport. Spells cost MP, which regenerates slowly.

- [x] **Ranged combat** — wands and thrown weapons, both from the
  export. `build_game_data.py` exports the wands it implements
  (`wand_type_defs`: flame / iceblast / acid / paralysis) and the
  throwables (`missile_defs`: javelin, boomerang). Wands are found with
  charges and evoked with `v`; thrown weapons stack in a quiver and are
  hurled with `f`. Both auto-target the nearest monster in sight, like
  spells. Wand of paralysis freezes its target.

## Round two — done

A second round of goals, closing the gaps where the game still used
its own simplifications instead of the export:

- [x] **Monster ranged attacks** — `build_game_data.py` reads each
  monster's spellbook (`monster_defs.spellbook` → `monster_spellbook_spells`
  → conjuration spells in `spell_defs`) and marks the spellcasters
  `ranged`. They are no longer filtered out; in-game a ranged monster
  fires a bolt when it has line of sight (114 of 342 monsters).
- [x] **Dungeon layout variety** — a cellular-automata cave generator
  (`caveLayout`) runs on D:2 and D:4, so the dungeon alternates
  organic caverns with rooms-and-corridors. Vaults still stamp in;
  corridors clear terrain so connectivity always holds.
- [x] **Save / resume** — the run persists to `localStorage` every
  few turns and on every descent; the title screen shows "Continue
  your run", and a finished run clears its save.
- [x] **Sound** — Web Audio sound effects for hits, misses, kills,
  descent, pickups, quaffs, spells, level-up, win and death; `m`
  mutes (the preference persists).

## Round three — deeper DCSS faithfulness

- [x] **Gods & religion** — altars (from the export's `god_defs`)
  appear on most levels. Stand on one and **pray** (`p`) to join its
  god. Kills build **piety**; each god grants a passive and an
  **invokable ability** (`a`, paid for with piety):
  - **Trog** — fury (+melee damage); *Berserk*. Detests spellcasting.
  - **Okawaru** — steadier aim (+accuracy); *Heroism* (+AC/EV/acc).
  - **Makhleb** — lifesteal on kills; *Minor Destruction* (a bolt).
  - **Elyvilon** — quicker regeneration; *Lesser Healing*.
  - **the Shining One** — a protective aura (+AC); *Cleansing Flame*.
  - **Vehumet** — cheaper spells (-1 MP); *Magic Bolt*.
- [x] **Per-monster spells** — a ranged caster no longer throws one
  generic bolt: `build_game_data.py` reads each monster's spellbook
  (`monster_spellbook_spells` → `spell_defs`) and gives it that
  spellbook's real offensive spells. In play it casts one of them by
  name (Magic Dart, Electrical Bolt, Iron Shot, Lehudib's Crystal
  Spear, …) with damage scaled to the spell's level.

## Interface

- [x] **Live character builder** — the title screen has a "Your
  Adventurer" panel: the chosen species' real sprite plus the stats,
  kit and spells the run will start with, recomputed live as you pick.
- [x] **Paper-doll** — the character is drawn as layered DCSS player
  tiles: species body + worn body armour + wielded weapon. It shows
  in the character preview and in the in-game sidebar, updating as you
  change weapon or armour.
- [x] **Desktop app** — `desktop.py` runs the game in its own
  chromeless Edge / Chrome window; `build_desktop.py` bundles it into
  a single standalone `CrawlWeb.exe` (PyInstaller) that needs no
  Python. `CrawlWeb.exe --selftest` verifies a build headlessly.
- [x] **Inventory & underfoot** — `i` opens a proper inventory panel
  (weapon, armour, ring, wand, quiver, potions, scrolls, gold, spells,
  religion); the sidebar always shows a "Here: …" line naming the item
  or feature under the player, so you can tell what you're standing on
  before you press `g`.

## Round four — the branching dungeon

- [x] **Branch tree** — the dungeon is no longer a fixed linear list
  of themed floors. The **Dungeon** is a 5-level trunk (the Orb sits
  at its bottom); **branch entrances** for the side branches are
  placed at *random Dungeon depths each game*. Stepping on one
  (`>`) enters that branch; `<` climbs back out. Levels **persist** —
  go back up and the floor is exactly as you left it.
- [x] **Side branches** — Lair, Orcish Mines, Crypt, Vaults, **Swamp**
  and **Shoals**, each its own short sub-dungeon with its own theme.
- [x] **Ambient terrain generation** — the generator scatters **water
  lakes, lava pools and tree groves** across open levels (organic
  random blobs), themed per branch: the Lair has woods and pools, the
  Mines have lava, the Swamp is half water and trees, the Shoals are
  flooded. Lava / tree blobs that would wall a level off are rolled
  back, so every level stays traversable.

## Round five — fuller generation

- [x] **Labyrinth layout** — a recursive-backtracker maze generator
  (`mazeLayout`); it is the Crypt's layout (a crypt-as-labyrinth).
- [x] **City layout** — `cityLayout`: open streets with a loose grid
  of walled, doored buildings — the Vaults branch.
- [x] **Traps** — hidden trap tiles (`placeTraps`): dart (damage),
  teleport (relocation), alarm (wakes the floor). Unseen until sprung
  or spotted in the field of view; stepping on one triggers it.
- [x] **Backpack & shops** — a real carryable inventory (`player.pack`):
  picked-up gear equips and the displaced item is *kept* in the pack,
  and the inventory panel lets you wield / wear pack items by letter.
  Shops appear on some levels — step onto one and a stocked shop
  opens; buy with gold, and equipment goes into the backpack.

## Round six — real items & a unified inventory

Items the way DCSS does it: the real weapon roster from the export,
and one backpack that carries everything — gear and stackable
consumables alike.

- [x] **6a — every weapon from the export.** `build_game_data.py`
  queried `weapon_defs` with the wrong column names, silently failed
  and fell back to 9 hardcoded weapons. Fixed: it now loads **41 melee
  weapons** with their real `damage / to_hit / speed / skill`, and
  `game.js` builds the weapon pool from them.
- [x] **6b — unified backpack.** The fragmented system (equipped slots
  + a gear-only `pack` + potion/scroll *counts*) is gone. `player.pack`
  is now one list holding everything carried — gear *and* potions /
  scrolls as stackable `{key, sub, name, qty}` entries.
- [x] **6c — pickup, shops and use routed through it.** Picking up,
  buying, wielding / wearing, quaffing and reading all add to or draw
  from the one backpack (`packAdd` / `packCount` / `packTake`).
- [x] **6d — the inventory panel.** One list: equipped gear up top,
  then the whole backpack with slot letters — a letter wields / wears
  gear or quaffs / reads a consumable in context.
- [x] **6e — item brands.** Generated weapons (~28%) and armour (~25%)
  carry an ego: flaming / freezing / heavy / draining blades, armour
  of protection / evasion. Egos add damage or defence and rename the
  item ("flaming long sword").
- [x] **6f — save / resume + tests.** The pack is plain data and
  round-trips through the save unchanged; the headless suite (77
  checks) covers weapons, the backpack, shops and ego brands.
- [x] **6g — per-weapon tile icons.** `build_tiles.py` resolves each
  of the 41 weapons to its real DCSS sprite: a floor / inventory icon
  (`manifest.item_weapons`, 41/41) and a held paper-doll overlay
  (`doll.weapon`, 32/41). A weapon on the ground now looks like that
  weapon, not a generic blade.

## Round seven — character choices that matter

The species and backgrounds are **not yet faithful**. Today a species
is just four small numbers (`hp_mod / mp_mod / xp_mod / wl_mod`) and a
background is its starting `str / int / dex`. Species base stats,
sizes and every innate trait are unused — so a Troll and a Spriggan
play almost identically, and none of the famously strong picks feel
strong. The export has all of it.

- [x] **7a — species base stats.** `species_defs` now exports
  `strength / intelligence / dexterity / size`; a character's stats are
  **species base + background bonus**, DCSS's real formula. (This also
  fixed a latent bug — characters had near-zero STR because the
  species base was being ignored entirely.)
- [x] **7b — sturdiness from size.** Body `size` feeds evasion — small,
  nimble species dodge better, large ones less — on top of the
  existing `hp_mod` HP scaling and STR-driven HP.
- [x] **7c — innate species traits.** Picking a species changes how
  you play: Troll regenerates very fast, Minotaur headbutts back when
  struck, Gargoyle has heavy innate AC, Deep Dwarf shrugs off damage,
  Felid rises once from death, any Draconian gains scaling scales.
- [x] **7d — background starting kits.** Backgrounds begin differently
  — Fighter / Reaver armoured, Gladiator / Hunter with a loaded
  quiver, Berserker already worshipping Trog — via a `JOB_KITS` table.
- [x] **7e — the builder shows it.** The live character preview names
  the species trait, the real combined stats, the AC/EV the kit gives,
  and the exact starting gear.

## Round eight — combat status effects

Real DCSS combat has lasting effects: a snake bites you and you're
**poisoned**, a hex **slows** you, you quaff **haste** and act twice
as fast. Today the game has only timed buffs (Might / Berserk /
Heroism) and Fear on monsters. Add the rest.

- [x] **8a — poison.** Venomous monsters (spiders, snakes, scorpions,
  wasps, vipers, nagas, bees) have a 30% chance to poison the player
  on a melee hit. Poison ticks 1 HP every 3 turns (caps before the
  killing blow) and counts down in the sidebar.
- [x] **8b — slow.** A **slow trap** is now one of the trap kinds;
  stepping on it halves the player's energy gain for ~20–40 turns.
- [x] **8c — haste.** A **potion of haste** is in the loot pool and
  the shop; quaffing it grants 1.5× energy for 25 turns.
- [x] **8d — curing.** Quaffing a healing potion clears poison.
- [x] **8e — sidebar status display.** Active statuses — Might,
  Berserk, Heroic, Hasted, Slowed, Poisoned — show as colour-coded
  rows with turns remaining.
- [x] **8f — venom weapon ego.** Generated weapons can roll the
  **venomous** ego; on a hit it has a 50% chance to poison the target,
  and the monster ticks damage in `endTurn`.
- [x] **8g — tests.** Seven headless checks cover poison apply/tick/
  cure, slow tick, haste, venom ego presence and monster poisoning.

## Round nine — the rest of the species traits

Round 7 hand-picked six species with iconic traits (Troll, Minotaur,
Gargoyle, Deep Dwarf, Felid, Draconian) — but a Vampire still drains
nothing, a Poltergeist isn't insubstantial, a Mummy doesn't shrug off
poison, a Spriggan moves at human pace. Add the missing traits.

- [x] **9a — Vampire: bloodthirst.** Each melee kill heals 2–6 HP.
- [x] **9b — Poltergeist: incorporeal.** Traps fire through them
  harmlessly, poison slides off, and +3 EV (a ghost is hard to hit).
- [x] **9c — Mummy: embalmed.** Immune to poison, slow traps fail.
- [x] **9d — Ghoul: clawed.** +2 flat melee damage.
- [x] **9e — Spriggan / Centaur: fleet of foot.** `player.speed` 12.
- [x] **9f — Formicid: anchored.** Teleport traps fizzle.
- [x] **9g — Tengu: flight.** `tryMovePlayer` lets them step onto
  lava tiles that everyone else cannot enter.
- [x] **9h — Naga: poison-blooded.** Immune to poison.
- [x] **9i — tests + builder.** Seven headless checks pass; the
  character builder already pulls `trait.desc` from the table, so each
  new species's description shows in the live preview automatically.

## Round ten — more monster special attacks

The status system (poison, slow, haste) is in place; only venomous
melee uses it. Extend the status-as-monster-attack surface so combat
encounters feel varied.

- [x] **10a — cold attacks slow.** Frost / ice / white / simulacrum
  melee has a 25% chance to apply the slow status.
- [x] **10b — drain attacks lower XL.** Wraith / shadow / spectre /
  ghost melee has a 20% chance to drop a level of experience.
- [x] **10c — paralysis.** Medusa / royal mummy / mummy priest melee
  paralyses the player for 2–3 turns (`paralyzedTurns` is consumed in
  `runWorld` so monsters keep acting while you can't).
- [x] **10d — confusion.** Gibbering / moth-of-wrath / harpy attacks
  apply confusion; movement is randomised 50% of the time.

## Round eleven — item identification

The DCSS layer of mystery: picked-up potions / scrolls / wands start
**unidentified** ("amber potion", "scroll labelled XYZZY") and reveal
their kind only when used or seen working.

- [x] **11a — unidentified item names.** Each run rolls a random
  per-subtype label: potions get a colour (`amber potion`, `ruby
  potion`, …), scrolls get a nonsense label (`scroll labelled
  XYZZY`). The inventory, sidebar counts, shop, pickup log and hover
  tooltip all use the appearance until you've identified the kind.
- [x] **11b — ID by use.** Quaffing a potion or reading a scroll
  reveals its true kind with an "It was a …!" log, and every future
  copy in the pack / floor / shop shows the real name.
- [ ] **11c — scroll of identify.** Deferred — adds little when only
  a handful of consumable kinds exist; revisit if more get added.

## Round twelve — more caster spells

The export has many spells; the game implements three. Pull a wider
roster so a Conjurer has more than Magic Dart.

- [x] **12a — broaden CASTER_SPELLS.** Sting, Freeze, Slow, Confuse,
  Mephitic Cloud, Swiftness, Lightning Bolt, Bolt of Fire, Fireball
  and Iron Shot are all loaded from the export and have effects:
  `bolt`, `bolt_cold` (slow on hit), `bolt_big`, `area` (fireball),
  `hex_slow`, `hex_confuse`, `self_haste`.
- [x] **12b — spell schools shape backgrounds.** Backgrounds now open
  with appropriate spells: Fire → Throw Flame + Bolt of Fire, Ice →
  Freeze + Blink, Air → Magic Dart + Lightning Bolt + Swiftness,
  Earth → Iron Shot, Enchanter → Slow + Confuse + Blink, Alchemist →
  Sting + Mephitic Cloud, Necromancer → Slow.

## Round thirteen — more gods

Six gods are in; the export has more.

- [x] **13a — Kikubaaqudgha, Sif Muna, Ashenzari.** Three new gods,
  each with a real passive and ability — **Kikubaaqudgha** heals you
  on a kill (necromantic vigour) and channels *Pain* at a foe;
  **Sif Muna** doubles MP regeneration and *Channel Magic* refills
  your reserve; **Ashenzari** reveals every trap on entry and *Scry*
  uncovers the whole floor for a moment.

## Round fourteen — selling & treasure

Right now shops only sell to you, and the only "treasure" is gold.
DCSS-flavoured games let you offload spare gear at a shop and pick
up gems that exist purely to be cashed in.

- [x] **14a — selling.** The shop overlay shows a second list of
  your pack with sell prices; **uppercase** letters sell, lowercase
  letters still buy. Sell price is ~40% of buy price for gear,
  full face value for gems.
- [x] **14b — gems.** A new pack item kind: gems (topaz, emerald,
  opal, sapphire, ruby, diamond) with values 70–180 gold. They drop
  on D:2+ in place of some gold piles, stack in the pack, and exist
  only to be sold.
- [x] **14c — treasure stashes.** On a deeper floor (D:3+, ~25%) a
  random room is seeded with a small pile of two gold heaps and a
  pair of gems clustered together — a real reason to detour into a
  room you might otherwise pass.

## Round fifteen — more consumables

Identification (round 11) works, so adding more potion / scroll kinds
genuinely enriches the discovery layer instead of just adding noise.

- [x] **15a — potion of berserk.** 22 turns of berserk rage (+50%
  damage) without the Trog-piety entanglement.
- [x] **15b — potion of magic.** Restores ~60% of max MP.
- [x] **15c — potion of cancellation.** Clears every active status —
  poison, slow, might, haste, confused, paralysed, berserk.
- [x] **15d — scroll of magic mapping.** Reveals the whole floor.
- [x] **15e — scroll of noise.** Wakes every sleeping monster on the
  floor (without the slow side-effect of an alarm trap).

## Round sixteen — door variety

A wooden door is the only door right now. DCSS has runed, gated and
steel doors — they slow you down, block line of sight differently,
and need to be *bashed* sometimes.

- [x] **16a — locked wooden doors.** ~25% of generated doors are
  locked; walking into one bashes it (50% per attempt, slightly
  better with STR). The Here line tells you to bash.
- [x] **16b — steel / iron doors.** A rare door (~5%, weighted toward
  D:3+) that takes ~20% per bash to crack open.
- [x] **16c — gates.** Large reinforced wooden gates open normally
  but the creak rouses **every sleeping monster within 12 tiles**.
- [x] **16d — render + describe.** Each door type has a distinct
  glyph colour — yellow `+` plain, red `+` locked, grey `+` steel,
  yellow `=` gate — and the Here / hover line names the type.

## Round seventeen — the surface

A breakaway from the cave. The Dungeon's up-stair on D:1 doesn't
say *"you cannot leave"* any more — it emerges you onto an **overworld
surface** with biomes, and there are *multiple* dungeons to descend
into. Finite-large surface this round; endless / chunked is round 18.

- [x] **17a — Surface branch.** New `Surface` branch (one level for
  now); `BRANCHES.D.parent === "Surface"`. Ascending past D:1 routes
  through the parent-lookup in `tryAscend` and emerges onto Surface
  at the Dungeon entrance tile.
- [x] **17b — biome generator.** `surfaceLayout` paints open ground,
  then scatters biome-signature terrain: **plains** (open + sparse
  trees), **forest** (dense trees), **swamp** (water + trees),
  **mountains** (walls), **lake** (large water). Zones placed via a
  Voronoi-style nearest-centre pass, then connectivity-filtered.
- [x] **17c — surface ↔ dungeon transit.** Stepping onto a surface
  branch entrance opens that dungeon at depth 1; climbing past depth
  1 of any branch returns to its parent's entrance tile.
- [x] **17d — multiple dungeon entrances.** Surface seeds two
  entrances: the original 5-level **Dungeon**, and one **Ruin**.
- [x] **17e — the Ruin.** A 3-level mini-dungeon branch with mixed
  rooms / caves; reuses every existing system (monsters, loot, traps,
  items).
- [x] **17f — render + tests.** Six headless checks cover Surface
  emergence, entrance count, biome zones, descent to D and Ruin from
  the surface entrances.

## Round eighteen — endless / chunked surface

- [x] **18a — chunk coordinates.** `G.surfaceCoord = {cx, cy}` tracks
  the current Surface chunk; `levelKey()` keys the Surface cache by
  coord so every chunk persists separately.
- [x] **18b — world-coord biome noise.** `biomeAtWorld(wx, wy)` is a
  deterministic hash over world coords (chunk*MAP + tile), quantised
  to ~7×5 cells so neighbouring chunks meet seamlessly at their
  biome edges.
- [x] **18c — edge transitions.** Walking off any edge of a Surface
  chunk enters its neighbour and lands you on the corresponding
  opposite edge (with a small nudge to a passable cell if the wrap
  point lands on a wall / lake).
- [x] **18d — chunk persistence.** Visited chunks are cached in
  `G.levels`; returning to one finds it exactly as you left it.
  Returning from a dungeon places you on the surface chunk you came
  from (the `branchReturn` now records the coord too).

## Round nineteen — more ruins & biome dungeons (placeholder)

Each biome can spawn a flavoured ruin entrance — forest temple,
swamp barrow, mountain pass — each a short themed sub-dungeon.

## Round twenty — surface life (placeholder)

Distinct surface monsters (bandits, wolves, treants, will-o-the-
wisps); maybe weather / day-night.

## Known limitations

- A compact run: a 5-level Dungeon trunk plus optional branches, not a
  full DCSS game with runes.
- Combat math approximates `fight.cc` rather than reproducing it
  exactly. Monster spells fire as direct damage scaled by spell level;
  the spells' individual side-effects (poison, slow, …) are not modelled.
- Tiles that fail to resolve fall back to an ASCII glyph.
