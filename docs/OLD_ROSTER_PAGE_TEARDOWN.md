# Old Roster & Lineup page — teardown / shared spec

A section-by-section inventory of the OLD app's `RosterAndLineupPage.tsx` (2,991 lines) + its
child components, to serve as the shared spec for rebuilding the Roster & Lineups page. Source of
truth for *what the page does*; the rebuild re-architects *how* (D4/D5/D6). Marks what's **built**,
**missing**, **M5 (manual editing)**, and **intentionally changed**.

Old files surveyed: `RosterAndLineupPage.tsx` (orchestrator, ~133 KB), `SettingsTab.tsx` (config),
`RosterManager.tsx` (Next Best pool), `LineupEditor_v2.tsx` (lineup editor), `DepthChart.tsx`,
`PitchingRotationEditor.tsx`; plus handover §3 (3A–3E) and §6.

---

## 0. Page layout (top level)

A single page with a drag-and-drop context (`@dnd-kit`) and these regions/tabs:
- **Settings / Optimization Settings** panel (`SettingsTab`) — generation config + **Generate Roster** button.
- **Roster & Lineup Manager** (`RosterManager` + `RosterDropZone`) — Next Best Available pool ↔ roster, drag in/out.
- **Lineup editors** — `LineupEditor` ×2 (vL and vR), each a draggable 9-slot lineup.
- **Pitching Rotation editor** (`PitchingRotationEditor`) + **Depth Chart** (`DepthChart`).
- Side panels: **Cap Spending Limits**, **Cap Usage**, **Slots Usage**, **Locked to Roster**, **Bullpen**.

Our current rebuild page = a read-only summary of generate output. **Missing: essentially all of §A config,
§C/§D editing, and the §E panels.**

---

## A. Generation config (`SettingsTab` + page-level `RosterSettings`)

The old app split generation config across the saved Tournament AND a page-level `RosterSettings`
(handover §6 "MAJOR ARCHITECTURAL FINDING"). **Rebuild decision (D4): these should merge into the Tournament.**

**`RosterSettings` (page-level today → move to Tournament):**
- **Hitting Metric** — `basic` | `wOBA`. **Pitching Model** — `basic` | `wOBA`. (+ `pitchingSide`.)
- **Top X Hitters / Top X Pitchers** (pool sizes; 0/blank = all; default 100).
- **Min Players Per Position** (1–5; roster depth / backups).
- **Owned Cards Only** toggle (D6; calibration + Next-Best display deliberately ignore it).
- **Position Requirements** (accordion, per position `C/1B/2B/3B/SS/LF/CF/RF/DH`): per-position **min
  ratings / topN for starters AND backups** (catcher ability/frame/arm, infield range/error/arm/DP,
  OF range/error/arm). `PositionConstraintEditor` per position. Shows "N active".
- **`positionPriority`** — assignment ordering, default `[SS, CF, 2B, C, RF, 3B, LF, 1B]`.

**Tournament-sourced (already in our config or nearby):** cap (`total_cap`), slot_counts (slots mode),
eligibility, roster shape (hitters/pitchers/min_starters/stamina/pitch_types/dh), variants, era/park,
softcaps, **position weights** (lineup bothSides/bench/backupC, rotation sp1–5/pitcherScale, bullpen).

**Status:** ⬜ none of `RosterSettings` is built in the rebuild yet. `ownedOnly` is currently forced ON
implicitly (we always owned-scope). Metrics are hard-wired to wOBA. Position constraints absent.

---

## B. Generation behavior (LP + post-processing)

Old: one LP solved **several times** + 8 post-processing phases (§3D): extract → lineup-opt → bench fill
→ **3-pass catcher** → locked placement → cap reclaim/trim → bonus selection → final lineup re-opt.

**Rebuild (D5) — already done in our single MILP (Phases A–C):** roster + dual-lineup assignment +
rotation + cap/slots + backup-catcher-as-coverage-depth + automatic cap-reclaim. The multi-phase greedy
(incl. the Arozarena bench-fill bug, the 3-pass catcher) is **intentionally retired**.

**Still MISSING from generation (M4 polish):**
- **Required/locked cards** (force onto roster; variant/base mutex; two-way flag; "Locked to Roster"
  panel; `regenerateWithLocks`). Locks are session-scoped, persist until clear/tournament-switch.
- **Excluded cards** (forbid).
- **Two-way players** — occupy a hitter AND pitcher slot with one card → free a roster slot → bonus.
  *(We currently force two-way to pitcher-only.)*
- **Bonus selection** — fill N free slots (from two-way and/or cap headroom); add a hitter if they'd
  start, else best pitcher.
- **Position constraints / min ratings per position** (from §A) as real constraints, incl. backups
  (≥ `minPlayersPerPosition`, default 2, per position — not just catcher).
- **Metrics** (basic vs wOBA) feeding selection.
- **Top X pool sizes** (decomposition) + **ownedOnly** as an explicit toggle.

---

## C. Roster Manager — "Next Best Available" (`RosterManager.tsx`) — **M5**

Two-pane drag-and-drop: a **Next Best Available** pool ↔ the current roster (`RosterDropZone`).
- **11 need-tabs:** `Hit vL`, `Hit vR`, `vL (O)`, `vR (O)` [owned], `Pitch`, `SP` (stamina+pitch-type
  qualified), `Pitch (O)`, `SP (O)`, `IF Rng`, `OF Rng`, `C Abil`. Each = top-50 of available, sorted by
  that tab's metric (hit score / pitch score [wOBA asc] / IF range / OF range / catcher ability).
- **Variant/base treated as DISTINCT** (`Card ID + _VAR/_BASE` key); cards already on the roster are
  excluded.
- Each card shows: title (variant ★ colored by level), the tab's score + Card Value + (pitch: throws),
  and **defensive rating lines** (C: Ab/Fr/Ar; IF: R/E/A/DP; OF: R/E/A).
- **Drag a card onto the roster drop zone to add** (respects max roster size); **✕ to remove**.

**Status:** ⬜ entirely missing. Our Cards grid is the closest analog but isn't a roster editor.

---

## D. Lineup Editor (`LineupEditor_v2.tsx`) — **M5**

Per side (vL, vR): left = **Available Hitters** (draggable, rostered non-pitchers); right = a **9-slot
lineup table**. Columns: **🔒 lock | # (batting order) | Bats | Player | POS (dropdown) | Defense | Score**.
- **Drag** an available hitter onto a slot to fill it; **drag slots to reorder** (updates batting order).
- **POS dropdown** per slot = `-` + the card's eligible positions (Learn flags + DH). Selecting a taken
  position **swaps** with the other slot.
- **Defense** column shows ratings for the chosen position (C: Ab/Fr/Ar; IF: R/E/A/DP; OF: R/E/A).
- **Lock** (🔒) a player to a position; re-optimization respects locks (`lockedVL/VR_positions`).
  Locks **clear** when the player is moved, position-changed, or removed.
- **Auto-Fill Lineup** + **Clear** buttons. **`optimizeLineups`** re-solves both lineups.

**Status:** ⬜ missing. We render static vL/vR tables (no editing, no batting order, no defense, no locks).

---

## E. Other panels — mostly missing

- **Cap Spending Limits** — set the support sub-budgets (bench/swingman/relievers). *(Rebuild folds these
  into the single MILP as optional caps; default off — user chose "weights only.")*
- **Cap Usage** — visual cap spend vs budget. *(We show a single "cost/cap (%)" line — much thinner.)*
- **Slots Usage** — per-tier (Perfect…Iron) used vs limit, overflow + cumulative-violation flags.
- **Locked to Roster** — list of locked cards + clear.
- **Depth Chart** (`DepthChart.tsx`) — roster by position depth.
- **Pitching Rotation Editor** (`PitchingRotationEditor.tsx`) — edit rotation order/roles (SP/swingman/RP).
- **Bullpen** panel.

---

## F. Display details to preserve

- **`CardTitle`** — variant rows render a ★ colored by `vlvl` (variant level: 1 orange…5 purple). Our
  rebuild is v5-only, so a single star color is fine, but the rich title styling should match.
- **Defensive rating lines** everywhere (C/IF/OF formats above) — we don't surface these on the roster page.
- **Batting order** (1–9), **Bats** (R/L/S), per-card **Card Value** shown inline.

---

## Mapping to our milestones + proposed build order

- **M4 polish (generation correctness/control):** §A config (merge `RosterSettings` into Tournament) ·
  §B locks/excluded · two-way + bonus · position constraints + backups · metrics · pool sizes/ownedOnly.
  Plus richer **Cap/Slots Usage** display (§E).
- **M5 (manual editing):** §C Roster Manager (Next Best Available, drag in/out) · §D Lineup Editor (slots,
  position, batting order, locks, defense) · Depth Chart · Rotation Editor. Needs `@dnd-kit` (or equivalent).
- **Intentionally changed (NOT regressions):** single MILP replaces the multi-solve + 8 phases; 3-pass
  catcher → coverage-depth constraint; `RosterSettings` merges into Tournament (D4); cross-pool
  normalization + power transform dropped (D2) with a tunable H/P knob instead.

**Open questions for the build:**
1. `RosterSettings` → Tournament merge: do position constraints + metrics + pool sizes + ownedOnly become
   tournament fields (persisted), per-session overrides, or both?
2. Manual editing library: `@dnd-kit` (old app's choice) vs a lighter custom DnD?
3. Which to build first — finish M4 generation surface, or jump to the M5 editor?
