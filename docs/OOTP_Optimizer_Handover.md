# OOTP Roster Optimizer — Rebuild Handover Document

## How to read this document

This document captures **the full intended feature set and behavior** of an existing OOTP (Out of the Park Baseball) roster optimization application, as preparation for a **complete from-scratch rebuild**.

**Global conventions — read these first:**

1. **Everything here describes CURRENT implementation to convey INTENT and BEHAVIOR — not a design to replicate.** Each feature is subject to redesign. The rebuild is explicitly free to re-architect everything: language, framework, structure, persistence, solver integration, data models. Nothing about the current architecture is a constraint. Where current behavior is a domain fact about how OOTP works (e.g. park factor compression), that is called out explicitly as a must-preserve.

2. **Anything that happens in multiple places in the current app is unintended by definition.** A recurring theme is logic (scoring, config) scattered across locations. The rebuild should consolidate. These are flagged throughout and catalogued in §10.

3. **Where intended behavior is genuinely unresolved, it is flagged as an OPEN QUESTION** rather than documented as if settled. These are real design decisions for the rebuild, not gaps in this document.

4. **"Review for rebuild:"** lines flag the specific open design questions for each area.

5. **The model structure itself is under review.** We are not just retraining models — we are re-examining whether the current model *structure* (log-linear regressions) is even correct. Specific fitted coefficients are disposable. See §9.

6. **A reference file manifest (§11) maps old files to behaviors.** Additional files beyond those listed likely exist in the current codebase and should also be reviewed during the rebuild.

---

## §1 — Purpose, Modes & Feature Areas

### Purpose

An OOTP roster optimizer. The user exports card/player data from OOTP, loads it into the app, and the app uses linear programming to build an optimal roster (default 26 cards) plus optimized left-handed (vL) and right-handed (vR) lineups, subject to tournament rules and constraints. A separate statistical-modeling pipeline predicts player performance (wOBA and component events) from OOTP ratings, producing the coefficients that drive scoring.

### Two game modes

- **Perfect Team (PT)** — the main application. Card ratings are on an **undefined/proprietary scale**.
- **Single Player (SP)** — a newer addition (currently mislabeled "SP Scouting"; the correct name is **Single Player**). Ratings are on either a **20–80 or 1–100 scale** depending on the user's OOTP settings.

**Rating scales are mode-dependent and must never be assumed.** Critically, **scale should NOT be a mode-specific concern in the rebuild** — normalizing whatever scale comes in is the job of the scaling/anchoring layer (§9). If anchoring is built correctly, SP's scale is handled automatically and is a non-issue.

### Current technology (documented for context only — rebuild is free to change everything)

React/TypeScript + Next.js frontend, Node/Express backend, HiGHS LP solver, IndexedDB browser persistence. **This is the current state, not a requirement.** The rebuild should choose its own architecture.

### Six feature areas + Tournaments as a cross-cutting concern

1. **Data Grid** — card browser/scoring surface
2. **Roster & Lineup** — LP optimization + manual editing
3. **Coefficients** — scoring parameters (may integrate more cleanly elsewhere in the rebuild)
4. **Eras** — a database of era-modifier definitions, selected within Tournaments (may relocate)
5. **Model Training** — fits statistical models that produce scoring coefficients
6. **Single Player (SP)** — same engine, different input format + scale + potential ratings

**Tournaments** is a database of tournament rules/settings that nearly everything reads from. It is the central configuration object (§6).

### Dependency relationships

- Model Training → produces coefficients → Coefficients
- Coefficients + Eras + Park factors → feed scoring
- Eras DB → selected inside Tournaments
- Tournaments DB → feeds Roster & Lineup
- Scoring → feeds Data Grid, Roster & Lineup, SP
- **Two scoring paths, both permanent and both trained:** "basic" and "woba". Basic is NOT legacy.
- **No default coefficients needed** — a trained model supplies them.

### Persistence (current)

Two persistent databases: **Eras** and **Tournaments**. Plus dataset, variants, trained models, and coefficient state. All currently IndexedDB.

---

## §2 — Data Grid

### Intent

The primary card browser and scoring surface. Loads a CSV of cards, runs every row through the scoring pipeline using current coefficients, and displays raw ratings plus computed/scored columns (wOBA vL/vR, basic scores, defensive ratings, etc.). The workhorse inspection view.

### Core behaviors

- Loads from the dataset context (CSV in persistence), scores every row
- Full **sorting** on any column
- Full **per-column filtering** with operators (>, <, =, contains, etc.)
- **Search** (text, with quoted/multi-term support)
- **Column management** — show/hide/reorder
- **Highlighting** — rows highlighted by roster membership (e.g. cards on the current generated roster)
- **Persisted view state** (filters/sort/columns/page size) per grid, separate from the data itself
- **`datasetOverride`** — can be fed an external dataset instead of reading context (how SP reuses the grid)
- **`rowPredicate`** — external filter function (SP uses this to split hitters/pitchers)
- **`columnPreset`** and **`extraColumns`** — caller defines columns and computed additions

### Inline cell editing

Supported; **not critical but desirable**. Primary use case: editing fields like **`owned`** status so the user can correct/override values that came from the CSV.

### Variants — CARRY FORWARD AND EXPAND

The variant system is core: add a variant by Card ID, boost to levels v1–v5, recalculate, delete. Variants are appended rows (`Variant=Y`), with `_VAR` key handling and a `vlvl` boost level. Base + variant rows are merged in the grid view.

**New requirement:** expand variants into a broader feature that tracks **which PT Account** is being worked with. PT Account is a brand-new concept (rebuild-led): two (or more) separate PT accounts that own different cards. This matters most for variants — variant/card ownership becomes **account-scoped**. Detailed design happens in the rebuild; captured here as context. It will ripple into the dataset model, ownership, and potentially owned-only roster constraints.

### Column presets — ADD NEW

No presets currently exist. The rebuild **should add** named column presets (e.g. hitting/pitching views).

### Edge cases

- Variant + base row merging; `_VAR` suffix handling; `vlvl` boost levels
- Calibration scales applied for display
- **Corrupt Basic Hitting columns** — some pools have values in the 25,000+ range instead of the expected 40–100, which breaks scoring/normalization. Needs guarding.
- Grid must not double-score when `datasetOverride` already carries scored rows

### Review for rebuild

- Is `datasetOverride` / `rowPredicate` / `columnPreset` the right extensibility model, or should PT and SP share the grid differently?
- How does the **PT Account** dimension integrate with variants and ownership?
- Preset design (named, user-saved, per-mode?)

---

## §3 — Roster & Lineup

This is the largest, most edge-case-dense area. Broken into: pipeline shape (3A), tournament rules/restrictions (3B), the LP model (3C), multi-phase post-processing (3D), and manual editing (3E).

### §3A — Pipeline Shape

**Intent:** Given a scored card pool and a tournament's rules, produce an optimal roster plus optimized vL/vR lineups, maximizing total team value subject to roster-construction constraints.

**The current pipeline (a multi-solve sequence, not a single solve):**

1. Scored cards + tournament settings + optimization settings (incl. era/park modifiers) are assembled.
2. **`generateRosterModel`** builds the LP: decision variables per card, an objective maximizing calibrated team value, and roster-construction constraints.
3. **HiGHS solves** the LP.
4. **`parseRosterResult`** extracts the solution and runs **multi-phase post-processing** (lineup optimization, bench fill, catcher passes, locked-card placement, cap reclaim/trim, bonus selection, lineup re-optimization).
5. Returns roster + vL/vR lineups + rotation/bullpen + diagnostics.

**The LP is solved several times in a single generation** (catcher passes, locked-card reruns, bonus-candidate evaluation, lineup re-optimization each add solves). The exact count varies by flow. **Much of this multi-solve structure evolved specifically to handle cap and slots modes and catcher constraints that were hard to express in a single LP.** Documented for comprehension; the rebuild should evaluate whether a cleaner formulation eliminates phases.

**KNOWN ARCHITECTURAL PROBLEM (not intended design):** Scoring currently happens frontend-side, then the backend re-derives calibrated scores for LP coefficients, requiring a `modifiers` coefficient bundle to cross the boundary. This split was a repeated source of bugs. **The rebuild must consolidate scoring into a single source of truth.** See §10.1/§10.2.

### §3B — Tournament Rules & Card Restrictions

**Eligibility rule system:** A tournament defines which cards are legal via a structured **eligibility group** — ALL/ANY logic over individual rules. Each rule operates on a card column with an operator: `num_between`, `num_ge`, `num_gt`, `num_le`, `num_lt`, `num_eq`, `set_in`, `set_not_in`, `text_contains`, `text_equals`, `is_blank`, `is_not_blank`. This expresses restrictions like "only cards with value ≤ N", "only certain card types", etc. Adequate so far; revisit expressiveness only if a real restriction can't be expressed.

**Eligibility runs frontend-side** (`rowEligible`), filtering the pool *before* the LP sees it. **The same point also enforces `variants_allowed`**: if the tournament disallows variants, any `Variant=Y` row is filtered out regardless of other rules. Empty rule set → all cards pass. **Note:** eligibility filtering, variant gating, scoring, and pool construction are all currently tangled together on the frontend before the LP — a key untangling target for the rebuild's single-source-of-truth goal.

**Required cards (locks) and excluded cards are session-scoped.** If the user generates a roster with locked cards, the locks persist **until the user manually clears the roster or switches tournament settings**. Locks are bound to the active roster/session — not to the tournament definition, and not purely ad-hoc per-run.

**Required/excluded edge cases:**
- Locks carry a variant/base distinction, a `side` (hitter/pitcher), and a two-way flag.
- Excluding a *variant* does NOT exclude the *base*, and vice versa.
- Locking one of a variant/base pair must remove the counterpart — only one of the pair can be on the roster.
- The LP doesn't always place locked cards, so post-processing force-adds them (§3D Phase 5).

**Era selection does NOT restrict the card pool.** Era applies era factors only. Era and eligibility rules are fully independent.

### §3C — The LP Model (intent level)

Documents **what must be true of any valid roster**, not the current variable encoding (which the rebuild may discard entirely).

**What the objective maximizes:** Total calibrated team value — the sum of each selected card's contribution. Hitters contribute via lineup value (better side, with both-sides bonus in cap/slots mode only); pitchers via rotation-slot-weighted value; bench at reduced weight.

**Constraints — what must be true of any valid roster:**

1. **Roster size** — exactly N cards (default 26).
2. **Hitter/pitcher counts** — exactly the target split (e.g. 14H/12P), accounting for two-way players.
3. **Position coverage** — every position playable by enough rostered cards to field both vL and vR lineups including backups (≥2 per position by default).
4. **Starter qualification** — enough pitchers meeting stamina + pitch-type minimums to fill the required starting rotation slots.
5. **Rotation slots** — pitchers assigned to weighted slots (SP1–SP5, swingman, relievers), each slot weight reflecting its value contribution.
6. **One-card-one-use** — a card cannot be double-counted; variant and base of the same card are mutually exclusive.
7. **Required cards present; excluded cards absent.**
8. **Cap mode:** total card value ≤ budget, with reserved sub-budgets for bench/swingman/relievers.
9. **Slots mode:** tiered card-value-count limits (perfect ≥100, diamond ≥90, gold ≥80, silver ≥70, bronze ≥60, iron ≥40), each with cumulative max counts.

**REMOVED — do not carry forward:**

- **Lineup balance ratio** (weaker platoon side ≥ 0.95 of stronger) — a workaround for lopsided roster selection. Remove for now; reintroduce only if lopsided rosters prove to be a real problem in practice.
- **Non-cap pitcher coefficient scaling (×0.0001)** — a numerical band-aid masking that pitcher and hitter values live on incomparable scales. Do NOT carry forward; solve cross-pool normalization properly instead (§9.5).

**Both-sides hitter bonus is CAP/SLOTS MODE ONLY.** The bonus multiplier for hitters in the top-N of both vL and vR pools is a cap/slots construct, applied pre-LP. Not used in non-cap mode.

**Two-way players create an effective free roster slot.** This is the correct mental model: a two-way player occupies BOTH a hitter slot and a pitcher slot with a single card, satisfying two roster requirements with one card. The roster's card total therefore has one slot "freed up" — the 14H + 12P obligations are met using fewer than 26 distinct cards. **That freed slot flows into bonus selection** (§3D Phase 7). The bug-prone part: counting the two-way player once against the card total but once against EACH of the hitter and pitcher position counts, and correctly detecting and handing the freed slot to bonus selection. **Multiple two-way players each free an additional slot.**

**DH handling:** When DH is off, the lineup simply has no DH slot. **Pitcher hitting ability is never considered** in selection or lineup construction, regardless of DH. No pitcher-batting modeling exists or is wanted.

**Other LP-level edge cases (current implementation):**
- Tiny coefficients (<0.001) skipped to avoid solver numerical issues.
- Helper-variable structure (per-card binaries for selection/slots/bench/two-way, plus linking constraints preventing ghost selections and double-firing) exists as the current mechanism — implementation detail the rebuild may replace.

### §3D — Multi-Phase Post-Processing

**BANNER:** This entire post-processing structure largely exists because cap/slots constraints and catcher requirements were hard to express in one LP. Documented for comprehension. The rebuild should treat each phase as "here is a problem that needed solving," not "here is a phase to replicate," and should evaluate whether better LP formulation eliminates whole phases.

**Phase 1 — Extract LP solution into a roster.** Read selected cards (hitters, pitchers, rotation-slot assignments), build the initial roster, assign initial vL/vR lineups.
- *Edge case:* The LP can set more hitter-selection variables than the lineup can place (the recurring "selected 17 but only 9 placed" warnings). Extra selected-but-unplaced hitters become bench candidates or get pruned.
- *Edge case:* Two-way players selected as pitchers but flagged as hitters need correct attribution to avoid double-counting.

**Phase 2 — Lineup optimization.** Given the rostered hitters, solve a separate smaller LP for the best vL and vR starting lineups; assign batting orders.
- *Edge case:* Re-runs every time roster composition changes (bench adds, bonus adds, locked-card adds) — multiple lineup solves per generation.

**Phase 3 — Bench fill.** The roster often comes out of Phase 1 short of the hitter target (pruned unplaced LP hitters). Bench fill adds the best remaining hitters to reach the target, **with position-coverage awareness** — it prioritizes filling positions lacking a backup before adding pure best-available.
- *Edge case (KNOWN BUG):* Bench fill's greedy per-card score sometimes skips a clearly-better hitter (the "Arozarena case") because its standalone score doesn't match the lineup-LP's notion of value; the better player gets passed over and only added later as a bonus. **The fix direction: bench fill should evaluate candidates by their actual contribution (would they start / improve a lineup), not a standalone greedy score.** See §10.8.
- *Edge case:* Position gaps detected against the tournament's position constraints (min ratings per position).

**Phase 4 — Backup catcher passes (the 3-pass system).** Catcher is special — you need a starter and a qualified backup, hard to satisfy in the main LP. Multi-pass: Pass 1 (main), Pass 2 locks required cards including the backup catcher, Pass 3 enforces the backup-catcher requirement.
- *Edge case (KNOWN BUG SOURCE):* Pass 3's required-card constraint can inadvertently fire a player as a pitcher. The catcher pass is the known origin of certain misfires.
- **Catcher is the ONLY position with multi-pass treatment.** SS/CF scarcity is handled within normal bench-fill position-gap logic, not a dedicated pass.
- **Flag:** the entire 3-pass catcher system is a workaround. Strong rebuild candidate for a cleaner single formulation.

**Phase 5 — Locked / required card placement.** Cards the user locked must appear. The LP doesn't always place them, so post-processing force-adds missing locked cards.
- *Edge case (fixed this session):* Variant vs base key mismatch (`_VAR` suffix) caused locked variants to be re-added even when already present.
- *Edge case (fixed this session):* Force-adding a locked card must REMOVE its counterpart (base if adding variant, vice versa). The LP mutex handles this in-solve, but the force-add path bypassed it.
- *Edge case:* Force-adding can overflow the roster, requiring trim.

**Phase 6 — Cap reclaim / trim.** In cap mode, force-adds and bench fills can push over budget or over size. A reclaim/trim phase removes the least-valuable removable cards (respecting position minimums and locks) to get back under cap and to exactly the roster size.
- *Edge case:* Cannot remove a card if doing so violates a position minimum.
- *Edge case:* Locked cards are never trimmed.
- *OPEN QUESTION:* The code shows both a "cap reclaim check" and a "Phase 4 trim." Whether these are genuinely distinct mechanisms or overlapping is unconfirmed. The rebuild should determine from reference files whether both are needed.

**Phase 7 — Bonus selection.** When the roster has a free slot (most importantly from a two-way player satisfying two roles with one card, or from cap headroom), bonus selection fills it. **A hitter is added if they would start; otherwise the best available pitcher (by calibrated score) is taken.**
- *Edge case (fixed this session):* Pitcher bonus was sorting by raw uncalibrated wOBA, ignoring era/park — fixed to use calibrated score.
- *Edge case:* Bonus hitter candidates are evaluated via the lineup LP (would they actually start / improve the lineup), then the best is added and lineups re-optimized.
- *Edge case:* Excluded cards filtered from bonus candidates; slot/tier limits (slots mode) filter candidates.
- **Multiple bonus slots are possible** (e.g. two two-way players, or two-way + cap headroom). Bonus selection must handle N slots, not assume one.

**Phase 8 — Final lineup re-optimization.** After all adds/trims, re-solve vL/vR lineups one final time.

### §3E — Manual Roster & Lineup Editing

**Intent:** After the optimizer generates a roster and lineups, the user can **manually override** the result through drag-and-drop UIs (human-in-the-loop).

- **RosterManager** — drag cards between a "Next Best Available" pool and the roster. The Next Best pool is tabbed by need (hitters vL/vR, owned-only, starters, infield/outfield range, catcher ability, etc.) and excludes cards already used (variant/base-aware). Add/remove respecting max roster size and starter-qualification hints.
- **LineupEditor** — drag players into lineup slots, change defensive position per slot, lock players into lineup positions, remove them. Position eligibility enforced per slot.

**Key behaviors:**
- **Lineup position locks** — a player can be locked to a specific lineup position; subsequent re-optimization respects the lock (`lockedVL_positions` / `lockedVR_positions`).
- Next-Best ranking uses the same scoring the optimizer uses.
- Variant/base treated as distinct throughout.

**Review for rebuild:** This is a genuine feature, not just display. Decide how manual overrides and re-optimization interact cleanly.

---

## §4 — Coefficients

### Intent

Coefficients are the complete parameter set that drives scoring. Currently a **mixed bag of conceptually-distinct things stored together:**

1. **Model coefficients** — trained log-model parameters (per-event intercepts/slopes) from Model Training
2. **Run-environment & park factors** — era factors AND park factors (`park_hr_r/l`, `park_avg_r/l`, `park_gap`)
3. **Same-side platoon penalties (SSP)**
4. **Fixed constants** — wOBA linear weights
5. **Manual tuning** — softcaps (post-fit corrections)
6. **Derived values** — computed from the above (e.g. `era_effective_hr`, `era_h`)

### Current mechanism

- A coefficient store (`useCoeffs`) holds one **global** active set, persisted in IndexedDB, with a **`hydrated` flag** consumers must wait on before scoring (scoring against unloaded/default values is a real bug source — §10.10).
- Coefficients are **global** (one active set for the whole app), not per-tournament.
- A trained model becomes active when the user clicks **"Load into App"**, which patches the model's coefficients into the global set via a **`modelToCoeffPatch`** translation layer (saved-model shape ≠ app-coefficient shape). The app tracks which model is loaded per type. Some model types may have no patch mapping ("not yet implemented").
- `derived` values are computed from coefficients and exposed alongside.

### Park factors

Park factors currently live in **both tournaments and coefficients** — a duplication (multiple-places = unintended). They are **manually set in tournament settings**. Park belongs conceptually with the tournament (it is the venue environment). **Future intent:** possibly a Park database analogous to the Eras database, not yet built. The presence in the coefficient bag is incidental.

### Review for rebuild

- Separate coefficients by **provenance and lifecycle**: trained values (regenerate on retrain), environment values (era/park from tournament context), platoon penalties, fixed constants, manual softcaps, derived values. The current single bag obscures these distinctions.
- The `modelToCoeffPatch` translation layer is a symptom of a "saved model shape ≠ app coefficient shape" impedance mismatch a cleaner design might eliminate.
- Park factors need ONE home (likely tournament-scoped, possibly a future Park DB).

---

## §5 — Eras & Park Factors

### Eras DB

A database of saved era definitions, selected from within Tournaments. Contains **era factors only** — run-environment scalers (BB, K, AVG/H, HR, BIP, GAP) plus a tournament-HR toggle, from which derived values (`era_effective_hr`, `era_h`) are computed. **No park data. No compression** — era factors apply directly/linearly.

### Park factors

Separate from eras. Manually set in tournament settings (currently also duplicated into the coefficient bag — flagged). HR and AVG factors specified per side (`park_hr_r/l`, `park_avg_r/l`, plus `park_gap`).

### Park factor compression — CRITICAL, easily-lost domain behavior

OOTP's engine applies park factors **non-linearly**. A raw park factor of 2.0 does NOT double outcomes — it increases them by roughly 26%. The app models this with:

```
cp(p) = 1 + (p - 1) × PARK_COMPRESSION,  where PARK_COMPRESSION = 0.26
```

So a raw park HR factor of 2.0 → effective multiplier of 1 + (2.0 − 1) × 0.26 = 1.26.

**Park factors are ALWAYS passed through `cp()` before application. Era factors are NOT compressed — they apply as-is.** This asymmetry is intentional and reflects how the OOTP engine actually treats the two. It must be preserved regardless of architecture.

### Park factor application by handedness/side

- bats = R: uses the R-side park factor on both vR and vL
- bats = L: uses the L-side park factor on both
- bats = Switch: uses the opposite-handed factor depending on side — a switch hitter bats left vs RHP (vR → L factor) and right vs LHP (vL → R factor)
- Compression is applied to whichever factor is selected.

### Review for rebuild

- Park may become its own reusable DB (mirroring Eras).
- The compression constant (0.26) and the era-vs-park compression asymmetry are domain facts that must carry forward.
- Park's single home should be resolved (tournament-scoped, not duplicated into coefficients).

---

## §6 — Tournaments

The central configuration object. **NOTE:** Captured as current state; redesign happens in the rebuild.

### A saved Tournament currently holds

- **Identity:** id, name, created_at, updated_at
- **Cap/value rules:** `card_value_min`, `card_value_max`, `total_cap` (null = not cap-limited)
- **Roster shape:** `roster_size`, `hitters`, `pitchers`, `min_starters`, `min_starter_stamina`, `min_pitch_types`, `dh`
- **Variants:** `variants_allowed`, `max_variants_on_roster`
- **Era factors** (embedded): `bb, k, avg, hr, bip, gap, thr_toggle`
- **Park factors** (embedded): `avg_l, avg_r, hr_l, hr_r, gap` — manually set, compressed via `cp()` at scoring time
- **Eligibility:** an eligibility group (ALL/ANY + rules with the full operator set)
- **Softcaps:** the complete hitting + pitching softcap set (cap_top/cap_bot/penalty per rating). **Softcaps live on the tournament** — and ALSO in coefficients (duplication, flagged).
- **Slot counts** (slots mode): perfect/diamond/gold/silver/bronze/iron cumulative maxes with value thresholds (≥100/90/80/70/60/40)
- **Position weights:** lineup (bothSides, bothSidesBonus, bothSidesThreshold, bench, backupCAdditional), rotation (sp1–sp5, pitcherScale), bullpen (swingman, reliever)

Tournament context holds the list of saved tournaments + active tournament id; CRUD via save/delete; persisted in IndexedDB.

### MAJOR ARCHITECTURAL FINDING — generation config is split across TWO sources

Position constraints are **NOT** part of the saved tournament. They live in a separate **`RosterSettings`** object on the Roster page, alongside other generation-time settings:

- `hittingMetric`, `pitchingMetric`, `pitchingSide`
- `positionPriority` (default `[SS, CF, 2B, C, RF, 3B, LF, 1B]` — drives position-assignment ordering)
- `positionConstraints` — per-position min ratings / topN, for both starters AND backups (e.g. catcher ability, infield range, OF range, with backup variants)
- `topHitters` / `topPitchers` (pool sizes)
- `minPlayersPerPosition`
- `ownedOnly`

So a roster generation is configured by **two separate sources** — the saved Tournament AND the page-level RosterSettings — which are not unified, and the RosterSettings may not persist with the tournament the way tournament fields do. **This is a prime rebuild target:** position constraints, metrics, pool sizes, and ownedOnly arguably belong with the tournament but currently don't.

### `ownedOnly` (resolves owned-status behavior)

A RosterSettings toggle. When on, cards with `owned == 0` are excluded from selection. **Important nuance:** the calibration pool and the "next best available" display **deliberately ignore `ownedOnly`** — calibration uses the full tournament-eligible pool so scores stay stable regardless of the owned filter, and the display shows unowned cards too so the user sees what they're missing. So `owned` feeds generation but is deliberately bypassed for calibration stability and informational display.

### Review for rebuild

- Unify the two config sources (Tournament + RosterSettings).
- Resolve softcap and park duplication (each config concern has one home).
- Decide whether position constraints, metrics, pool sizes, and ownedOnly are tournament-scoped (likely yes).
- Verify intended persistence of RosterSettings across tournament switches.

---

## §7 — Model Training

### Intent

Fit the statistical models that predict player performance from ratings, producing the coefficients that drive scoring. The offline/analytical side of the app.

### Training data contract

The trainer consumes **CSV files of real outcome data** — whatever CSVs the user provides (the current "PEL" naming is incidental). What matters is the **contract**: each row pairs a player's OOTP ratings (Eye, Power, AvoidK, BABIP, Gap for hitting; Control, Stuff, pBABIP, pHR for pitching — split into vL/vR rating columns) with accumulated outcomes (PA/BF, BB, SO, HR, H, 2B, 3B, AB, SF). The doc captures the required columns/stats, not the filename convention.

### All four models are trained

`woba_hitting`, `woba_pitching`, `basic_hitting`, `basic_pitching`. **Basic is a trained model too, not a fixed formula.**

### Split handling — IMPORTANT

We do **NOT** train separate vL and vR models. Instead:

- Each player has different ratings vL and vR, so the player's **vL line and vR line are treated as two separate observations** in the training set (keyed by name + variant + split, each using that split's rating columns).
- These combined vL+vR observations feed **ONE unified regression** producing **ONE model**.
- Mechanically: separate input files (or filename-detected splits) supply the vL and vR observations; a `split='both'` mode keeps them as distinct rows; all flow into a single weighted least squares fit.
- Output is **one model trained on doubled observations**, not two side-specific models.

### Current wOBA model structure (OPEN FOR REDESIGN — see §9)

Per-event log-linear regressions, weighted least squares:

- **Hitting:** BB from ln(Eye); K from ln(AvoidK); HR from ln(Power); non-HR hits from ln(BABIP) + ln(BIP); XBH as a log-share of hits from ln(Gap)
- **Pitching:** BB from ln(Control); K from ln(Stuff); HR from ln(pHR); non-HR hits from ln(pBABIP) + ln(BIP)
- **Weighting:** observations weighted by PA^0.75 (hitting) / BF^0.75 (pitching) — dampened so high-volume cards influence but don't dominate
- **Minimum threshold:** cards below a minimum PA/BF (currently 1000) excluded
- **Aggregation:** all instances of a given card (name + variant + split) summed into one entry (thousands of PA → one row)

### Diagnostics produced per model

- R², RMSE, Spearman, Pearson per sub-model
- **Residual-by-rating-bin report:** bins each rating into ranges, computes weighted mean residual (predicted − actual) and `sumW` per bin, flags sparse bins
- **Softcap recommendations** (direction-aware over-valuation analysis — see §9.4)

These diagnostics **stay as a permanent capability**, but the **current form is not prescriptive** — the rebuild may redesign how they are computed and presented. The intent and analytical findings (§9) are the durable parts.

### Model lifecycle (current)

Train → save to backend model store → manual "Load into App" patches global coefficients via `modelToCoeffPatch` → scoring uses them. Models named by user, filtered by type, deletable.

### Edge cases / findings

- **Aggregated cards make raw N meaningless** — one entry can represent 50,000+ PA. Sparse detection must use `sumW`, not N.
- `modelToCoeffPatch` impedance (saved-model shape ≠ coefficient shape); some types unimplemented for loading.
- **`seedLegacyModels` exists** — a legacy/default model seed. Removable, since no defaults are wanted (a model will always be trained).
- **Naming collisions:** the model dropdown couldn't distinguish two same-named models of different types ("2038" appearing twice); needs type-aware identification + separate hitting/pitching model selection.
- **SP absolute-scale mismatch** — PT-trained models produce wrong absolute values for SP's scale (§8); this is a scaling-layer symptom, not an SP problem.

### Review for rebuild

Model structure itself is the big open question (§9) — log-linear may not be correct. The training-data contract, the "vL/vR as separate observations → one unified model" approach, aggregation, weighting, and the diagnostic goals are the durable parts.

---

## §8 — Single Player (SP)

### Mental model

SP is **the same scoring + roster engine applied to a different input format** — not a separate system. PT and SP should share one scoring/roster core in the rebuild. SP's genuine differences are narrow:

1. **Different input format** — SP Export CSV uses different column names than PT (e.g. `BA vL/vR → BABIP`, `POW → Power`, `STU → Stuff`, `C ABI → CatcherAbil`). This is an **adapter / column-mapping concern**, not a different engine. (`Export.csv` in the reference files is the authoritative SP column format.)

2. **Different rating scale (20–80 or 1–100) — but this should NOT require special handling.** Scale normalization is the **scaling/anchoring system's responsibility** (§9). If anchoring is built correctly, SP's scale normalizes to the same target as PT automatically. The current SP-specific calibration workarounds exist only because the scaling layer isn't unified — the rebuild should make scale a non-issue.

3. **Features PT doesn't have — most notably Potential ratings.** SP cards carry potential/future ratings (e.g. HT P, POW P, EYE P, STU P) alongside current ratings. The app computes a "Potential wOBA" by scoring the potential-rating columns through the same pipeline. SP needs **additional UI** to surface current vs. potential scoring. This is the main place SP genuinely diverges.

### Current implementation (for reference, being replaced)

- Reuses PT's `DataGrid` via `datasetOverride` + `rowPredicate` (to split hitters/pitchers tabs)
- Remaps SP columns to PT names, then runs the same scoring path
- Has its own roster-generation endpoint and its own persistence store (separate from PT)
- Everyone eligible for every position in SP (defensive constraints do the filtering)

### Edge cases / findings

- **Absolute-value mismatch (current):** PT-trained models produce wrong absolute wOBA for SP's scale — relative ranking correct, absolute values off. A scaling-layer symptom; fixed properly by unified anchoring, not SP-specific patches.
- **Potential scoring:** computed by substituting potential-rating columns and re-running the same scoring — must carry forward; needs UI.
- **Persistence parity:** SP data must persist/clear like PT data (caused hydration-gating bugs).
- **Two-way/roster logic:** SP roster gen reuses the same LP engine; same two-way/bonus/cap logic applies.

### Review for rebuild

- One scoring/roster engine; SP is an **input adapter** (column mapping) + **scale-agnostic anchoring** + **potential-rating UI**.
- Don't replicate SP-specific calibration hacks — they exist only because scaling isn't unified.
- Resolve naming (SP = "Single Player," not "SP Scouting").
- **OPEN ITEM:** SP-specific data dimensions beyond Potential ratings (e.g. aging/development curves, scouting uncertainty, positional versatility) are TBD — to be identified at build time using the SP Export format as the source of truth for what fields actually exist.

---

## §9 — Model Weaknesses & Lessons Learned

The transferable, hard-won knowledge that should inform model design regardless of architecture. Specific tuning thresholds are intentionally omitted — the rebuild should re-derive them.

### 9.1 — The functional-form question (biggest open problem)

Current models are log-linear per event. Residual analysis suggests log-linear may be **systematically wrong**, not just miscalibrated. The pattern across BB, K, and HR is consistent: **over-prediction in the lower-mid (dense) range, under-prediction at the high end** — a shape mismatch suggesting the true rating→outcome relationship is **slightly superlogarithmic** (steeper at the top than a pure log allows). `ln²` terms or a different functional form may fit better. The unused cubic/quadratic coefficient slots **do not make sense mixed with a log term** (they would create non-monotone curves that turn back down). **Recommendation:** treat functional form as an open empirical question — fit and compare forms against residual diagnostics; do not assume log.

### 9.2 — Diminishing returns & high-rating extrapolation

Log curves flatten at high ratings, so each additional rating point is worth less. At extreme ratings (e.g. Avoid K 178), the model extrapolates into sparse training data and **over-values** players whose real performance doesn't match. The softcap system is the current mitigation (post-fit compression above a threshold).

### 9.3 — Sparse data at the extremes

High/low ratings inherently have few cards. Because cards are aggregated, **raw N is meaningless** (one entry can be 50,000+ PA). Density must be measured by weighted sum of observations (PA^0.75 weighted), not count. Residual signals in sparse bins are real but uncertain — the dense-vs-sparse penalty split exists to avoid over-reacting to a handful of outlier cards while not ignoring them.

### 9.4 — Softcap & floor-cap mechanics (analytical findings)

- **Over-valuation signal = residual × sign(coefficient)** — direction-aware, so negative-coefficient events (like K, where a higher rating means fewer strikeouts) are handled correctly.
- **Cap threshold = interpolated zero-crossing** of the over-valuation signal, not snapped to a bin boundary.
- **Penalty (level-based):** solve for the penalty that makes the model's output at the mean overfit rating match observed, via `effectiveX = meanX × exp(−meanSignal / |coeff|)`. Higher mean over-valuation or lower coefficient magnitude → larger penalty.
- **Upper softcap** compresses the top (reduces effective rating above the cap). **Floor cap** compresses *downward* — low ratings are pushed lower: `effective_x = x − (cap_bot − x) × penalty`, reducing model output for low-rated players to correct over-prediction there.
- **Weighting matters:** raw PA-weighting lets a single dense bin dominate and wash out large signals in sparse extreme bins; a compressed weight (e.g. sqrt of the weight) balances this. A dense-vs-sparse penalty split surfaces both "what the well-sampled data supports" and "what the sparse tail suggests."

### 9.5 — Calibration / anchoring / scaling (highest-value area to get right)

- **OPEN DESIGN PROBLEM — scaling & calibration layering.** The current implementation has multiple distinct-seeming operations: per-event scaling against baselines, anchor calibration (pool mean → target wOBA), and cross-pool hitter/pitcher normalization. It is **not established** whether these are genuinely separate necessary steps or partially redundant artifacts of incremental development, nor is their correct order relative to era/park modifiers settled. The rebuild must derive the correct layering from first principles — "what transformation does each step accomplish, and is it actually needed" — rather than replicating the current sequence.
- **Calibration pool matters enormously:** anchoring against the full org pool produces ~1.0 scales (elite out-of-pool players already match baselines), collapsing calibration. Must anchor against the **eligible/topX pool being optimized.**
- **Cross-pool hitter/pitcher normalization must be solved properly** — the ×0.0001 non-cap hack is a symptom of pitcher and hitter values living on incomparable scales.
- **Event interdependency:** BIP (balls in play) is derived from the other events; hits-on-contact depend on BIP. Whenever component events change, BIP and dependent events must recompute — once, in one place. This is intrinsic to the model, not an architectural choice.
- **Era vs park asymmetry:** park factors are compressed (`cp`, 0.26); era factors are not.

### 9.6 — Errors here pick the wrong players

Mistakes in scaling/calibration don't just produce slightly-off numbers — they cause the optimizer to **select the wrong players** (the SP wOBA-too-low symptom; the calibration-collapse symptom). This is why this area is the highest priority to get right.

---

## §10 — Known Bad Patterns to NOT Carry Forward

**10.1 — Scoring logic in multiple places.** The single biggest structural problem. Scoring happens in the frontend scoring path AND is re-derived in the roster generator via passed coefficient bundles, AND has had parallel implementations. This caused a long tail of bugs. **Rule: one scoring core, one implementation, called identically by every consumer.**

**10.2 — Frontend-scores / backend-recalibrates split.** A specific instance of 10.1: the frontend scores cards, then the backend re-derives calibrated scores for LP coefficients, requiring a `modifiers` bundle across the boundary. Drift between the two derivations mis-scored players. **Rule: scoring and calibration produce final values once; the LP consumes them, never re-derives.**

**10.3 — Recreating functions that already exist.** A repeated correction: scoring/formula logic re-implemented in new places instead of reusing the authoritative version. **Rule: the authoritative scoring path is THE scoring path — never re-create it.**

**10.4 — Numerical band-aids masking real problems.** The ×0.0001 non-cap pitcher scaling, tiny-coefficient skipping, etc., patch symptoms of unnormalized cross-pool values. **Rule: fix the normalization, don't scale-hack the objective.**

**10.5 — Calibrating against the wrong pool.** Anchoring against the full org instead of the eligible/topX pool collapses calibration to ~1.0 scales. **Rule: calibrate against the pool being optimized.**

**10.6 — Multi-place duplication of config.** Park factors live in tournament AND coefficients; softcaps live in tournament AND coefficients; generation config is split between the saved Tournament and page-level RosterSettings. **Rule: each config concern has exactly one home.**

**10.7 — LP couldn't express constraints → post-processing workarounds.** The 3-pass catcher system, bench-fill position-gap patching, cap-reclaim/trim, locked-card force-add all exist because constraints were hard to encode in one LP. **Rule: prefer expressing constraints in the optimization model; treat each post-processing phase as a candidate for elimination via better formulation.**

**10.8 — Greedy scoring that disagrees with the optimizer.** Bench fill's standalone greedy score passed over a clearly-better player the lineup LP would have valued. **Rule: candidate evaluation should use the same value notion as the optimizer (would this player start / improve the objective), not a separate greedy proxy.**

**10.9 — Variant/base counterpart mismatches.** The `_VAR` suffix key-mismatch and force-add-without-removing-counterpart bugs. **Rule: variant and base of the same card are mutually exclusive everywhere; counterpart removal must be intrinsic to any add path, not just the LP.**

**10.10 — Hydration races.** Scoring ran against unloaded/default coefficients before persistence hydration completed. **Rule: scoring must gate on coefficient readiness.**

**10.11 — Stale-file regressions (process, not code).** Working from stale file copies repeatedly reintroduced fixed bugs. **Rule: single source of truth in version control; never work from copies of uncertain currency.**

---

## §11 — Reference Files Manifest

**NOTE:** Additional files beyond those listed below likely exist in the current codebase. This manifest covers the files reviewed during handover preparation. The rebuild should review the complete current file list for anything missed.

### Authoritative for current behavior (read for ground truth)

| File | Governs | Notes |
|---|---|---|
| `computeRows.ts` | **Scoring pipeline** — wOBA + basic event computation, softcaps, park/era application, BIP recalc | THE authoritative scoring path (`computeAugmentedRows`). Most important file for scoring intent. |
| `rosterGenerator.js` | **LP model + multi-phase post-processing** | ~4,850 lines. `generateRosterModel` (LP build) + `parseRosterResult` (phases). Contains the backend re-derivation (a bad pattern, but authoritative for current LP behavior). |
| `server.js` | **Backend API + model training** | Endpoints, `trainWoba*`/`trainBasic*`, residual/softcap diagnostics, model store. |
| `tournament.tsx` | **Tournament data model + eligibility evaluation** | The tournament type = canonical tournament shape. `rowEligible` = frontend eligibility filtering + `variants_allowed` gate. |
| `dataset.tsx` | **Dataset + variants** | CSV load, persistence, variant add/recalc/delete, base+variant merge, variant boost formula. |
| `coeffs.tsx` | **Coefficient store + derived values** | Global coefficient store, hydration gating, `derived` (era_effective_hr, era_h). |
| `lineupOptimizer.js` | **Lineup LP** | The smaller lineup-only optimization + batting-order assignment. |
| `ModelTrainingPage.tsx` | **Model training UI + model→coeff loading** | `modelToCoeffPatch`, residual/softcap rendering, "Load into App." |
| `DataGrid.tsx` | **Card grid** | Sorting/filtering/search/columns, `datasetOverride`, `rowPredicate`, highlighting, view-state persistence. |
| `RosterAndLineupPage.tsx` | **Roster page orchestration + RosterSettings** | ~2,990 lines. Position constraints, `isEligibleForPosition`, `ownedOnly`, the two-config-source split. |
| `RosterManager.tsx` / `LineupEditor_v2.tsx` | **Manual roster/lineup editing** | Drag-drop override UIs (§3E). |
| `ClientShell.tsx` | **App shell + nav + tournament HR toggle** | Sidebar, routing, dataset load entry, era_thr input. |

### Infrastructure / lower-value

| File | Role |
|---|---|
| `solver.js` | HiGHS solver invocation wrapper |
| `solve_lp.py` | Python LP solve path |
| `layout.tsx` / `page.tsx` | Next.js routing scaffold |

### Reference data

| File | Role |
|---|---|
| `Export.csv` | A sample SP Export — **authoritative for the SP input column format** |

### Contains abandoned / superseded approaches (do NOT treat as authoritative)

- Any `scoringCore.*` files — deleted/superseded; represented the multi-implementation bug
- `spAdapter.ts` (TS version) — superseded by a pure column-remapper approach
- `seedLegacyModels` in `server.js` — legacy default models; removable
- `.lp` debug dumps (`debug_roster_model.lp`, etc.) — solver output artifacts, not source

### Files NOT fully audited during handover (flag for rebuild inspection)

- `era.tsx` / the era provider (referenced but not read in full)
- `LineupEditor_v2.tsx` internals
- `solve_lp.py`
- Full `DataGrid.tsx` column/preset machinery
- Any current-codebase files not present in the handover file set

---

## Recommended Rebuild Workflow

1. **Phase 0 — This document is the spec.** Review and refine in Cowork.
2. **Phase 1 — Interrogation.** Provide the rebuild agent this document + the full current file list. Explicitly instruct: *read everything, ask clarifying questions, and propose an architecture before writing any code. Do not start building until the plan is approved.* This forces the design conversation before commitment.
3. **Phase 2 — Architecture proposal.** Agent proposes structure (single scoring core, unified config, etc.). Approve/adjust.
4. **Phase 3 — Incremental build,** one feature area at a time, validating each against the current app's behavior before moving on.

**The single most important architectural principle for the rebuild:** one scoring core, one pass, all scaling/calibration/era/park applied once in that core, consumed identically by every feature (Data Grid, Roster & Lineup, SP, Model Training validation). The majority of this project's bugs trace to scoring logic living in multiple places.
