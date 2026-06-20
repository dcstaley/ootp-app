# OOTP Optimizer — Discovery Findings (Full File Inventory)

Discovery pass over the actual codebase, cross-checked against `OOTP_Optimizer_Handover.md`.
Ground truth = the code. This document records what each file is, whether it's live or dead,
and where the handover conflicts with or missed reality.

> Confidence note: live/dead status is derived from the import graph (reliable). Small/medium
> files were read in full. The large files (`rosterGenerator.js` ~4.8k lines,
> `RosterAndLineupPage.tsx` ~3k, `server.js` ~2k, `DataGrid.tsx`) were read in the relevant
> sections and characterized structurally — flagged below as "characterized, needs deep audit."

---

## 1. Headline findings (the things that change the rebuild picture)

### 1.1 The handover has the scoring core exactly backwards
- §11 says *"Any `scoringCore.* files — deleted/superseded"* and calls `computeRows.ts` THE authoritative path.
- Reality: **`scoringCore.ts` is alive and IS the single formula core.** `computeRows.ts` is a thin
  per-row wrapper that pulls ratings/modifiers off the row and delegates every formula to `scoringCore`.
  `spAdapter.ts` also imports `scoringCore` directly.
- Good news: the formula bodies really are consolidated into one module on the frontend.

### 1.2 The real "scoring in multiple places" problem is the FRONTEND/BACKEND split, plus calibration scatter
- There are **two copies of the formula core**: `frontend/lib/scoringCore.ts` and
  `backend/lib/scoringCore.js`, kept in sync **by hand** (the backend file says so in its header).
  They are currently formula-identical, but this is a latent drift source.
- **`backend/lib/scoringCore.js` is imported by nothing.** `rosterGenerator.js` (the LP) imports only
  the lineup optimizer + solver, and **re-derives scoring inline** rather than calling the core. So:
  - the *formula core* is consolidated on the frontend, but
  - the *backend LP re-derives scores independently* (handover §3A/§10.2 — confirmed and real), and
  - the backend keeps an orphaned synced copy of the core that nothing uses.
- **Calibration / scaling is the genuinely scattered layer** — not the per-card formulas. Calibration
  logic appears across at least 9 files: `RosterAndLineupPage.tsx`, `rosterGenerator.js`,
  `lineupOptimizer.js`, `server.js`, `ScoutingPage.tsx`, `DataGrid.tsx`, `coeffs.tsx`,
  `ModelTrainingPage.tsx`, and `recalibrate_pt_model.py`.
- **Display-vs-LP divergence is in the code, explicitly.** `RosterAndLineupPage.tsx` comment:
  *"Basic pitching with calibration scale only — crossPoolPitcherMultiplier is LP-only, not for display."*
  So the same player can be scored differently for the grid vs the optimizer. This is the §10.1 bug
  class, live.
- The `modifiers` bundle that §10.2 warns about is assembled in the **frontend**
  (`RosterAndLineupPage.tsx`, two places) and POSTed to the backend, which uses it to rebuild scores
  for the LP. Confirmed.

### 1.3 Persistence is a hybrid, not "all IndexedDB"
- §1/§4 say everything (incl. coefficients) is IndexedDB. Reality:
  - **IndexedDB** (`idb.ts`, DB `ootp_card_eval`): dataset, variants, eras, tournaments.
  - **localStorage**: coefficients (`coeffs.tsx`, key `ootp_coeffs_v2`), grid state + dataset meta
    (`storage.ts`), and **calibration scales** (`ootp.calibrationScales`, written by the roster page,
    read by DataGrid).
  - `idb.ts` declares `coeffs` and `grid_state` object stores that are **never used** (those live in
    localStorage instead) — orphaned store definitions.

### 1.4 "No default coefficients" is false
- §1 says *"No default coefficients needed — a trained model supplies them."*
- `coeffs.tsx` ships a complete `DEFAULT_COEFFS` set **with real fitted values baked in**
  (commented "trained on PEL 2042-2049 data"). The app scores against these on first load before any
  model is loaded. Whether that's desired is a rebuild decision, but it's not "no defaults."

### 1.5 There are remnants of an older, all-frontend solver architecture
The app clearly migrated from an in-browser JS solver to a backend Python/HiGHS solver. Leftovers:
- `frontend/lib/LPRosterOptimizer.tsx` — frontend LP optimizer, **imported by nothing (DEAD)**.
- `frontend/lib/optimizerAPI.ts` — client that calls `/api/optimize-roster`, an endpoint that
  **does not exist** (live endpoint is `/api/generate-roster`). **Imported by nothing (DEAD).**
- `frontend/components/ScriptLoader.tsx` (`LPSolverLoader`) — injects a `/solver.js` browser script
  and looks for `window.solver`. **Used by nothing (DEAD).**
- `backend/api/optimize.js` — a CommonJS Express router using the `highs` (highs-js) npm module
  directly. The backend is ESM and `server.js` defines its own `/api/optimize` inline using the
  Python path; this router is **not mounted (DEAD)**.
- `backend/debug_roster_model.lp`, `backend/debug_lineup_model_ERROR.lp` — solver temp-file dumps,
  not source.

### 1.6 The live solve path
`solver.js` writes the LP to a temp `.lp` file and shells out to `python3 solve_lp.py`, which uses
`highspy`. So `solve_lp.py` is not an "alternative" path (as §11 implies) — it **is** the solver.
`solver.js` is just the wrapper around it.

### 1.7 Files the handover never mentioned
`LPRosterOptimizer.tsx`, `optimizerAPI.ts` (dead, above); `backend/api/optimize.js` (dead);
`backend/lib/positionConstraints.js` (live, shared); `frontend/lib/storage.ts` (live, localStorage
helpers); `idb.ts` (live); and UI components `PitchingRotationEditor.tsx`, `SettingsTab.tsx`,
`DepthChart.tsx`, `PositionConstraintEditor.tsx`, `DefensiveStatInput.tsx`, `ScriptLoader.tsx`.
Plus `recalibrate_pt_model.py` at the repo root (a Python recalibration script) and
`backend/trained_models.json` (the model store is a flat JSON file).

### 1.8 Smaller corrections
- **Era DB has no HR toggle.** §1/§5 attribute a "tournament-HR toggle" to eras. `era.tsx` stores only
  `{bb,k,avg,hr,bip,gap}`. The tHR toggle lives in coefficients (`tournament_hr_adjust`/`era_thr`) /
  tournament, not in the Era record.
- **Position constraints are split, not purely frontend.** §6 says position constraints live only in
  the frontend `RosterSettings`. The *definitions* do (page state), but the *enforcement logic* is a
  real shared backend module, `positionConstraints.js`, imported by both `rosterGenerator.js` and
  `lineupOptimizer.js`.
- The SP page component is literally named `ScoutingPage.tsx` / route `/scouting` — the "SP Scouting"
  misnomer §8 wants renamed is baked into filenames and routes.
- `computeRows.ts` still has a leftover `console.log` diagnostic and a `Derived` type that omits
  `era_h` (it's read at runtime but not typed). Minor.

---

## 2. Per-file inventory

### Frontend — `frontend/lib/`
| File | Role | Status | Notes vs handover |
|---|---|---|---|
| `scoringCore.ts` | **The single formula core** (softcap, park `cp()`, ssp, basic/adv hitting/pitching, wOBA). Pure functions. | **LIVE — authoritative** | Handover said deleted/superseded. Wrong — this is the core. |
| `computeRows.ts` | Thin per-row wrapper; assembles columns by calling `scoringCore`. | LIVE | Handover called this the core; it's a wrapper. Leftover console.log; `Derived` type missing `era_h`. |
| `spAdapter.ts` | SP `Export.csv` → PT-card remapper; reuses `computeRows`+`scoringCore`; adds Potential (neutral ssp/park) scores. | **LIVE** | Handover said "superseded." It's alive and is basically the clean adapter pattern the rebuild wants. |
| `coeffs.tsx` | Global coeff store (`useCoeffs`), hydration flag, `derived` (era_h, era_effective_hr). Single flat bag. | LIVE | Persists to **localStorage**, not IndexedDB. Ships full `DEFAULT_COEFFS` with fitted values. |
| `dataset.tsx` | CSV load, variants (add/recalc/delete), base+variant merge. IndexedDB. | LIVE (characterized) | Matches §2 intent; deep audit pending. |
| `tournament.tsx` | Tournament data model + `rowEligible` eligibility + `variants_allowed` gate. IndexedDB. | LIVE (characterized) | Canonical tournament shape; deep audit pending. |
| `era.tsx` | Era library CRUD (factors only). IndexedDB. | LIVE | No HR toggle in the record (handover implied one). |
| `idb.ts` | IndexedDB helpers (DB `ootp_card_eval`). | LIVE | Declares unused `coeffs`/`grid_state` stores. |
| `storage.ts` | localStorage helpers for grid state + dataset meta. | LIVE | Not mentioned by handover. |
| `optimizerAPI.ts` | Client for `/api/optimize-roster`. | **DEAD** | Endpoint doesn't exist; imported by nothing. |
| `LPRosterOptimizer.tsx` | Old frontend LP optimizer. | **DEAD** | Imported by nothing; remnant of in-browser solver era. |

### Frontend — `frontend/components/`
| File | Role | Status | Notes |
|---|---|---|---|
| `DataGrid.tsx` | Card grid: sort/filter/search/columns, `datasetOverride`, `rowPredicate`, highlighting, view-state persistence; reads `ootp.calibrationScales` for calibrated display. | LIVE (characterized) | Column/preset machinery flagged for deep audit (handover agrees). |
| `RosterAndLineupPage.tsx` | Roster page orchestration; holds `RosterSettings` (the 2nd config source); builds the `modifiers` bundle; does anchor calibration + sends `calibrationCards`. | LIVE (characterized) | Confirms two-config split + frontend calibration + display/LP divergence. ~3k lines; deep audit pending. |
| `ScoutingPage.tsx` | SP page; uses `spAdapter` + reuses DataGrid; own roster gen via `/api/sp/generate-roster`. | LIVE (characterized) | This is "Single Player." Same calibration concerns as PT. |
| `ModelTrainingPage.tsx` | Training UI; `modelToCoeffPatch`; "Load into App"; residual/softcap rendering; calls `/api/train-model`, `/api/models`. | LIVE (characterized) | Matches §7. |
| `RosterManager.tsx` | Drag-drop roster editing; "Next Best Available" tabbed pool. | LIVE (characterized) | §3E. Deep audit pending. |
| `LineupEditor_v2.tsx` | Drag-drop lineup editing; position locks (`lockedVL/VR_positions`). | LIVE (characterized) | Flagged "not fully audited" by handover; still pending. |
| `ClientShell.tsx` | App shell/nav, providers, dataset load entry, tHR toggle. | LIVE (characterized) | §11 listed. |
| `PitchingRotationEditor.tsx` | Rotation/bullpen editing UI. | LIVE (characterized) | Not in handover. |
| `DepthChart.tsx` | Depth-chart view using positionConstraints + eligibility. | LIVE (characterized) | Not in handover. |
| `SettingsTab.tsx` | Settings UI incl. positionConstraints editing. | LIVE (characterized) | Not in handover. |
| `PositionConstraintEditor.tsx` | Per-position constraint editor widget. | LIVE (characterized) | Not in handover. |
| `DefensiveStatInput.tsx` | Defensive-rating input widget. | LIVE (characterized) | Not in handover. |
| `ScriptLoader.tsx` | Injects `/solver.js`, looks for `window.solver`. | **DEAD** | In-browser solver remnant; used by nothing. |

### Frontend — `frontend/app/` (Next.js routes)
`layout.tsx`, `page.tsx`, and route folders `roster/`, `scouting/`, `tournament/`, `coefficients/`,
`eras/`, `training/` (+ `globals.css`). Routing scaffold wrapping the components above. LIVE.
`.next/` is build output (ignore).

### Backend — `backend/`
| File | Role | Status | Notes |
|---|---|---|---|
| `server.js` | Express API: `/api/generate-roster`, `/api/optimize-lineups`, `/api/sp/generate-roster`, `/api/optimize`(+`/test`), `/api/models` (GET/DELETE), `/api/train-model`; training fns; `seedLegacyModels`. | LIVE (characterized) | ~2k lines; deep audit pending. `/api/optimize` appears legacy (frontend uses generate-roster). |
| `lib/rosterGenerator.js` | LP build (`generateRosterModel`) + multi-phase post-processing (`parseRosterResult`). Re-derives scoring inline from the `modifiers` bundle; takes `calibrationPool`. | LIVE — authoritative for LP | The backend re-derivation (§10.2). Heavy two-way / both-sides / backup-catcher logic. ~4.8k lines; deep audit pending. |
| `lib/lineupOptimizer.js` | Smaller lineup-only LP + batting order; imports `positionConstraints`. | LIVE (characterized) | §11 listed. |
| `lib/positionConstraints.js` | Shared starter/backup/defensive constraint checks. | LIVE | Not in handover; contradicts "constraints are frontend-only." |
| `lib/scoringCore.js` | Hand-synced JS copy of `scoringCore.ts`. | **LIVE FILE, but imported by nothing (orphaned)** | Latent drift risk; LP doesn't use it. |
| `lib/spAdapter.js` | Node copy of SP remapper for backend SP roster gen. | LIVE (characterized) | Backend twin of `spAdapter.ts`. |
| `lib/solver.js` | Writes temp `.lp`, shells out to `python3 solve_lp.py`. | LIVE | The real solver wrapper. |
| `solve_lp.py` | `highspy` LP solver. | LIVE | The actual solver (not an "alternative"). |
| `api/optimize.js` | CommonJS Express router using highs-js directly. | **DEAD** | Not mounted; superseded by Python path. |
| `trained_models.json` | Flat-file model store. | LIVE (data) | Not in handover manifest. |
| `debug_roster_model.lp`, `debug_lineup_model_ERROR.lp` | Solver dumps. | Artifacts | Not source. |
| `next.config.js`, `package.json`, `BACKEND_SETUP.md` | Config / setup. | LIVE (infra) | — |

### Repo root
| File | Role | Status |
|---|---|---|
| `recalibrate_pt_model.py` | Python recalibration script for the PT model. | LIVE (script) — not in handover; deep audit pending |
| `README.md` | Repo readme. | infra |
| `OOTP_Optimizer_Handover.md` | The handover. | reference |

### Abandoned set (safe-to-drop candidates, pending your confirmation)
`LPRosterOptimizer.tsx`, `optimizerAPI.ts`, `ScriptLoader.tsx`, `backend/api/optimize.js`,
`backend/lib/scoringCore.js` (orphaned synced copy), `seedLegacyModels` in `server.js`,
`debug_*.lp`, and the unused `coeffs`/`grid_state` IDB store declarations.

---

## 3. Consolidated requirements lens — the three flagged open problems

**§9.5 scoring/scaling/calibration layering (highest value).** Confirmed as the real mess. The
per-card *formulas* are consolidated (`scoringCore`), but the *calibration/scaling* layer is (a) split
frontend↔backend via the `modifiers` bundle, (b) re-derived in the LP rather than consumed, and (c)
already divergent between display and LP (`crossPoolPitcherMultiplier` LP-only). The distinct
operations to untangle, as they exist today: per-event softcaps (in core), anchor calibration on
BB/HR (frontend), calibration scales cached to localStorage for display, and a cross-pool
pitcher/hitter multiplier applied only in the LP. Whether these are all necessary, and their order vs
era/park, is the design question — and now we can point at the exact code for each.

**§9 model functional form.** Confirmed: `coeffs.tsx` carries unused quadratic/cubic slots
(`*2`/`*3`, all 0) alongside the log terms, exactly the dead slots §9.1 flags as nonsensical mixed
with logs. Re-deriving form against residuals is open.

**§6 multi-source config split.** Confirmed and slightly worse than described: generation config is
split across the IndexedDB Tournament **and** the page-level `RosterSettings`, **and** enforcement
logic for position constraints lives in a separate backend module. Park factors duplicate between
tournament and coeffs; softcaps duplicate between tournament and coeffs.

---

## 4. Calibration layer — end-to-end trace (the §9.5 deep dive)

### 4.1 The wOBA → calibrated-score pipeline is re-implemented FOUR times
The per-event → BIP → BA/nHH → GAP/XBH → wOBA recomputation (with calibration scales + era + park)
exists, nearly identically, in four places:

1. **`scoringCore.ts` `advHittingSide`/`advPitchingSide`** — produces the **raw** per-event columns
   and a raw wOBA, with **no era/park and no calibration**.
2. **`RosterAndLineupPage.tsx` `getHittingScore`/`getPitchingScore`** (frontend) — takes the raw
   per-event columns and re-derives a **calibrated** wOBA (Steps 1–4: apply BB/HR scales, era, park,
   recompute BIP, recompute BA/GAP). Used for the roster page's own ranking/display.
3. **`rosterGenerator.js` `getHittingScore`/`computePitchScoreRaw`** (backend) — the same Steps 1–4
   again, reading the `modifiers` bundle the frontend sent. Used to build LP objective coefficients.
4. **`rosterGenerator.js` `calcAnchorWoba`** — the same recompute a fourth time, over the anchor pool,
   to derive the calibration scales.

`DataGrid.tsx` is a fifth consumer (reads `ootp.calibrationScales` to show calibrated columns).
This is the literal embodiment of §10.1. Any formula tweak must be hand-mirrored across all of them.

### 4.2 Era/park is applied at INCONSISTENT layers
- **Basic hitting/pitching:** era + park are applied **inside the core** (`scoringCore` via the
  `*Mod` inputs from `computeRows`). The stored `Basic Hitting/Pitching` columns already include era/park.
- **Advanced (wOBA):** the core produces **raw** wOBA with **no** era/park; era + park are applied
  **later, in the consumer** (`getHittingScore` Steps 2–4, frontend and backend).

So whether a stored column already contains era/park depends on the metric. Anyone consuming a column
has to know which regime it's in. This is the "what does each step accomplish and where" ambiguity §9.5
flags — made concrete.

### 4.3 The anchor/scale model (backend `rosterGenerator.js`)
- `TARGET_WOBA = 0.320` (hard-coded wOBA anchor); `TARGET_BASIC_HIT = 100` (basic-mode anchor).
- **Per-event `evScale`:** scales BB/HR/etc. so the top-N anchor pool matches "Section 3" baseline
  rates (`H_SECTION3.BB`, etc.).
- **Anchor calibration:** select top-N anchors **from the calibration pool** (not the full org — §10.5
  done right; the code comment confirms anchoring against the full org collapses scales), compute their
  mean recomputed wOBA, then `hitScaleVR = TARGET_WOBA / anchorMeanVR`, etc.
- Hitters get **per-side** scales (vR/vL); pitchers get a **single OVR** scale applied to both sides.

### 4.4 Cross-pool hitter/pitcher normalization is a POWER transform, and display ≠ LP
- The ×0.0001 hack is gone (as §3C says). Its replacement: the LP objective raises each calibrated
  score to **`POWER_SCALE = 1.2`** and multiplies by a `hitPowerNorm` / `pitchPowerNorm` so hitter and
  pitcher coefficients sit on comparable scales (`Math.pow(raw, 1.2) * powerNorm`).
- **This is explicitly LP-only.** Code comments: `computePitchScoreRaw` is "the SAME value the FRONTEND
  shows"; `computePitchScore` (the LP coefficient) is "NOT the same number the frontend displays."
  So the optimizer ranks on `score^1.2 · norm` while the grid/roster page rank on the linear `score`.
  A power transform is monotonic so ordering within a pool is preserved, but **cross-pool hitter-vs-
  pitcher tradeoffs the LP makes are not reflected in any number the user sees.**
- **Correction / refinement after deeper read:** there are actually **two** cross-pool mechanisms, and
  they coexist:
  1. `crossPoolHitterMultiplier` / `crossPoolPitcherMultiplier` — linear multipliers the backend
     **does** set and send (`rosterGenerator.js` ~1258), but they are **`1.0` in non-cap mode** and
     only meaningful in **cap mode**. So the frontend's `calScales?.crossPoolHitterMultiplier ?? 1` is
     a real field, just inert outside cap mode (my earlier "likely stale" was wrong — it's mode-gated).
  2. `POWER_SCALE = 1.2` + `hitPowerNorm`/`pitchPowerNorm` — a global power transform, also sent to the
     frontend as `calibrationScales.hitPowerNorm/pitchPowerNorm`.
  The frontend display applies these **inconsistently**: basic-hitting display multiplies by
  `crossPoolHitterMultiplier` but not the power-norm; the wOBA display path applies neither; the LP
  objective applies the power transform but the cap-mode linear multiplier is folded in separately.
  There are also **three different power exponents** in different scopes (`POWER_SCALE`, `POWER_SCALE2`,
  `POWER_SCALE3`) — they appear intended to be equal (1.2) but are defined independently, a drift risk.

### 4.5 What crosses the wire (the boundary that should not exist)
Frontend → `/api/generate-roster` sends: `eligibleCards` (with raw per-event columns), a `modifiers`
bundle (era/park **+ the wOBA model coefficients** `baInt/ba/bipba/gapLogA/B/p_nHH_*/xbh/...`), and a
separate `calibrationCards` pool (tournament-eligible, ignoring `ownedOnly`). Backend returns roster +
`calibrationScales`. Because the model coefficients themselves cross the wire, the backend can (and
does) re-run the scoring math — this is exactly the §10.2 split. In a single-core design none of
`modifiers` needs to exist: the core would emit final consumable values and the LP would read them.

### 4.6 Bonus persistence finding
The roster page adds a **fourth** persistence mechanism: **`sessionStorage`** (`ootp_roster_state_v1`)
for the working roster/lineup/rotation, on top of IndexedDB (data/config), localStorage
(coeffs/grid/calibration scales). Four storage layers total.

### 4.7 Implication for the rebuild
A single scoring core must own: the per-event model, the BIP interdependency recompute (§9.5: "once,
in one place"), era/park application, calibration/anchoring, and cross-pool normalization — and emit
**one** final score per (card, side, role) that the grid, roster page, LP, and SP all read without
recomputation. The hard design questions that remain (genuinely open, for us to decide): the correct
**order** of calibration vs era/park; whether per-event scaling + anchor scalar + power-norm are three
necessary steps or collapsible into fewer; and whether cross-pool comparability should be a power
transform, a shared unit (e.g. runs above replacement), or something the LP handles directly.

---

## 5. Roster generation phases & the §3D open question

Read of `generateRosterModel` + `parseRosterResult` confirms the multi-solve structure and resolves
the flagged open question.

- **Multiple full LP re-solves per generation.** Confirmed: the catcher 3-pass, the cap-reclaim pass,
  and bonus-candidate evaluation each call `generateRosterModel`/`solveLP` again. A single generation
  can run many solves.
- **Catcher 3-pass (confirmed, matches §3D Phase 4).** Pass 1 = free solve → find starter catcher(s);
  if two catchers already start, Passes 2–3 are skipped. Pass 2 = lock starter(s) + apply
  `backupCAdditional` bench bonus (and skip `coverage_C`) → find the optimal backup. Pass 3 = lock
  starter(s) + backup, restore regular bench weights → final roster. Each pass is a full re-solve.
  This is the single most workaround-heavy mechanism and a prime candidate for a cleaner formulation.
- **§3D open question — "cap reclaim" vs "Phase 4 trim": they are NOT the same thing.**
  - **Cap reclaim** (`rosterGenerator.js` ~3959) is a **re-optimization**: if the reserved support
    sub-budgets (bench/swingman/reliever) weren't fully spent, it computes the surplus and re-runs the
    whole model with `_reclaimedCapBudget = originalStarterBudget + reclaimed` to let leftover cap
    upgrade starters; it keeps the new result only if the objective improves. It removes nothing.
  - **Trim** (removing cards to get back under cap/size after force-adds/bench-fill) is **not a single
    named phase** — that logic is **distributed** into the force-add and bonus-selection cap checks
    (e.g. the `currentCapUsed`/`remainingCap` gating in bonus selection) rather than one trim pass.
  - So the answer for the rebuild: reclaim = "spend leftover budget via re-solve"; trim =
    "stay within cap/size," currently scattered. They're distinct concerns that should be named and
    separated cleanly (or designed out by expressing the budget in one LP).
- **Bonus selection is genuinely N-slot (confirmed §3D Phase 7).** `bonusSlots = roster_size −
  roster.length`; loops per slot. Hitters are tested via candidate sets (top-3 vL + top-3 vR) and added
  if they'd start; otherwise the best available pitcher by **`Cal Pitcher wOBA`** (calibrated + era/park
  — the documented fix; raw `Pitcher wOBA OVR` is only a fallback). Excluded cards filtered. Multiple
  bonus slots (multiple two-ways and/or cap headroom) handled.

## 6. Model training & the functional-form question (§7 / §9.1)

Read of `trainWobaHitting`/`trainWobaPitching`/`trainBasicHitting` + diagnostics confirms the handover's
description is **accurate** here, and pins the functional form:

- **The fit is strictly log-linear, single `ln` term per event.** Design matrices:
  BB = `[1, ln(EYE)]`, K = `[1, ln(Krat)]`, HR = `[1, ln(POW)]`,
  nonHRH = `[1, ln(BABIP), ln(predBIP)]`, XBH-share = `[1, ln(GAP)]`. Weighted least squares (`wls`).
  No quadratic/cubic terms are ever fit — the `*2`/`*3` coeff slots in `coeffs.tsx` are dead.
- **Weighting = `PA^0.75` (hitting) / `BF^0.75` (pitching)** — confirmed exactly as §7/§9.3 say.
- **Training matches inference:** the `h` model uses **predicted** BIP (from the just-fit BB/K/HR
  models), not actual BIP, so the train-time pipeline mirrors the scoring-time recompute.
- **`split='both'` keeps vL and vR as separate observations** feeding one unified fit (filename detects
  side), exactly as §7 describes — one model on doubled observations, not two side models.
- **Diagnostics match §9.4:** `residualBinReport` computes over-valuation signal = `residual ×
  sign(coeff)`, flags sparse bins by `sumW` (not N), uses compressed `sqrt(sumW)` weighting, and emits
  upper/floor softcap recommendations at the interpolated zero-crossing.
- **Implication:** the §9.1 functional-form concern is real and untouched — the model genuinely is
  single-log, and the residual shape (over-predict mid, under-predict high) is a property of that form.
  The rebuild's empirical "fit and compare forms" task is wide open; nothing in the code pre-judges it.

---

## 7. Remaining surfaces (dataset/variants, config flow, grid, manual editing, alt model)

### 7.1 Variants (`dataset.tsx`)
- **Boost formula (function, not to replicate):** per rating field, `v → v + floor((lvl·v + 40)/80) +
  (lvl===5 ? 2 : 1)`, levels 1–5 (default 5), applied to a fixed `VARIANT_RATING_FIELDS` list.
- Variants are **separate appended rows** (`Variant="Y"`, `vlvl`, starred title `★ {title} v{lvl}`),
  persisted in the IndexedDB `variants` store; the live `dataset` is `base rows + variant rows`.
- **One variant per Card ID** (dup-guarded). `recalcVariants` re-derives all variants from base using
  stored `vlvl` (needed after re-import or formula change). Changing `vlvl` via `updateCell` recomputes
  that variant's ratings.
- **Base inline edits are ephemeral:** base edits write to the working copy and are **wiped on next CSV
  import** (variant edits persist). Relevant to the `owned`-override use case — owned overrides on base
  rows don't survive a re-import. A real behavior to decide on deliberately in the rebuild.

### 7.2 Config flow & the real §6 problem (`tournament.tsx` + sync sites)
- **There is a protected default tournament** ("League Neutral (Default)", `default-league-neutral`):
  always injected, can't be edited or deleted, and is the active fallback. The handover didn't mention
  it; note it contradicts a blanket "no defaults" stance (tournaments ship one).
- **Tournament embeds era + park + softcaps + positionWeights + slot_counts** — so config is duplicated
  across **three** homes that must agree: the **Eras DB** (`era.tsx`), the **Tournament** (embedded),
  and the global **Coeffs** store (what scoring actually reads). The handover's §10.6 list should be
  expanded: era is also duplicated (Eras DB vs `tournament.era`), and positionWeights too
  (tournament vs `coeffs.pw_*`).
- **The sync is manual and partial — a genuine footgun.** Scoring always reads `coeffs`. On tournament
  switch, only **`positionWeights`** is auto-pushed into `coeffs` (`RosterAndLineupPage` effect).
  **Era/park/softcaps only enter `coeffs` when the user clicks "Load tournament Era/Park into
  coefficients"** on the tournament page. So selecting a tournament does **not** make scoring use that
  tournament's run environment until a manual button press — a prime correctness trap the rebuild
  should eliminate (tournament selection should directly drive the scoring config, one source).
- **Eligibility (`rowEligible`) confirmed:** full operator set; empty rules → all pass; `variants_allowed`
  filters `Variant=Y` rows pre-LP. Note **incomplete rules are permissive** (a `num_ge` with no operand
  returns true), which is a quiet behavior worth making explicit.
- **Two different pitch-type column lists exist** (`tournament.ts` `countPitchTypes` uses
  `Circlechange`/`Knucklecurve` (no spaces); `RosterAndLineupPage.countPitchTypes` uses
  `Circle Change`/`Knuckle Curve`). Same concept, two definitions — a latent inconsistency.

### 7.3 DataGrid (`DataGrid.tsx`)
- Scores via the core (`computeAugmentedRows`); `COMPUTED_COL_FIELDS` are appended to the dataset's
  columns and are **read-only** for inline editing (along with Card ID / Variant), so inline editing
  targets raw rating / `owned` fields.
- Extensibility props confirmed (the SP-reuse mechanism): `columnPreset` (ordered field list),
  `extraColumns` (caller `ColDef`s), `rowPredicate` (external filter), `datasetOverride` (feed external
  scored rows). View state (`filterModel`/`sortModel`/`columnState`/`pageSize`/`quickFilterText`)
  persists per grid via `storage.ts` (localStorage).
- **No named column presets and no "corrupt Basic Hitting (25,000+)" guard found in code.** Both are
  handover *wants* (`§2 "ADD NEW"`, `"Needs guarding"`), not existing behavior — confirmed absent.
- Has its own `ownedOnly` display filter (distinct from the calibration pool, which deliberately ignores
  ownedOnly — consistent with §6).

### 7.4 Manual editing (`LineupEditor_v2.tsx`, `RosterManager.tsx`)
- **LineupEditor:** drag players into slots; reorder = batting order; per-slot defensive position
  (defaults to "-"); **per-slot position eligibility** (`DH` or `isEligibleForPosition`); **lock a
  player to a lineup position** (`onToggleLock`); two-way pitchers appear in the hitter lineup. Uses the
  `_VAR` suffix to address variant vs base. Matches §3E.
- **RosterManager:** "Next Best Available" is **tabbed by need** (hit vL/vR, pitch, pitch_sp,
  owned-only variants, `if_rng`, `of_rng`, `c_abil`, …), each tab ranking by the relevant score; used
  cards are excluded keyed by **Card ID + base/variant** so base and variant are distinct. Matches §3E.

### 7.5 Alternate model lineage (`recalibrate_pt_model.py`) — relevant to §9.1
- This root script is **not** the model the app trains. It fits a **sequential conditional
  cubic-logistic** model: BB(EYE) → K(K)|noBB → HR(POW)|noBB,noK → nonHR-H(BA)|noBB,noK,noHR →
  XBH(GAP)|hit, each stage a `PolynomialFeatures(3)` + Ridge regression on the logit, weighted by the
  conditional PA. Outputs intercept + b1/b2/b3 per stage, optionally into a `PT_Hitting_Model.xlsx`
  template (**that template is not in the repo** — external).
- **Why it matters:** this is a third modeling lineage (alongside the app's log-linear WLS and the
  in-app `DEFAULT_COEFFS`). It explains the otherwise-orphaned `*2`/`*3` (quadratic/cubic) slots in
  `coeffs.tsx` and the cubic fields in `modelToCoeffPatch` (`pow2/pow3`, `con2/con3`, `stu2/stu3`,
  `hrr2`): those exist to receive a **cubic** model. So the functional-form question already has prior
  art — a sequential-conditional cubic-logit approach — that the rebuild can evaluate against the
  current single-log form. The cubic form (monotone-capable per stage, conditional structure that
  naturally enforces the PA→BB→K→HR→H→XBH accounting) is a serious alternative worth comparing.

### 7.6 `modelToCoeffPatch` (the impedance layer)
Confirmed: maps the saved-model's nested shape (`c.bb.intercept`, `c.hr.pow`, `c.xbh.logA`, …) to the
flat `Coeffs` keys, per model type. It already supports cubic terms the current trainer never emits, so
the "saved-model shape ≠ coeff shape" mismatch (§4) is partly a consequence of supporting a richer
model family than is currently fit. A single canonical model schema would remove this layer.

---

## 7B. PT Account — new feature requirements (decided with the user)

PT Account is the one genuinely net-new feature (not in the current app). Decisions made together:

- **Purpose / scope of generation:** Roster generation keeps an **owned / not-owned** option; when
  "owned" is checked, the owned filter is **per active account** (not cross-account pooling). So PT
  Account is an *ownership-scoping* dimension on the existing `ownedOnly` toggle, with an active-account
  selector — **not** a combined-collection optimizer.
- **Data entry:** **One CSV import per account.** Each account exports its own `pt_card_list.csv`; the
  app keys that file's ownership to the account it was imported under.
- **Ownership granularity:** **Quantity**, and it's already in the CSV — the `owned` column is a count
  (e.g. `owned=2`), not a boolean. "Owned" = `owned > 0`; quantity is carried for variant material /
  multiple usable copies.
- **Applies to:** **PT-only.** Single Player keeps its own single-collection model; the account
  dimension does not apply to SP.

**Data-model implication (function, not design):** the card *catalog* (ratings, value, defensive,
Learn flags) is identical across accounts, so the natural shape is **one shared catalog keyed by Card
ID + a per-account overlay** carrying `owned` quantity, the economy columns, and that account's
variants. Importing account A's and account B's CSVs should reconcile to the same catalog with two
ownership overlays — not two duplicate datasets.

**`pt_card_list.csv` structure (the authoritative PT import format) — observed columns:**
- Identity/meta: `//Card Title, Card ID, Card Value, Card Type, Card Sub Type, Card Badge, Card Series,
  Year, Peak, Team, Franchise, LastName/FirstName/NickName, Nation, UniformNumber, DOB fields,
  Bats, Throws, Position, Pitcher Role`.
- Hitting ratings: `Contact, Gap, Power, Eye, Avoid Ks, BABIP` + `vL`/`vR` splits (note `Contact` is
  present but the scoring core doesn't use it; `Movement` likewise on pitching).
- Pitching ratings: `Stuff, Movement, Control, pHR, pBABIP` + `vL`/`vR` splits; pitch-type columns
  (`Fastball … Knuckleball`, **no-space spellings** `Circlechange`/`Knucklecurve`); `Stamina, Hold, GB,
  Velocity, Arm Slot, Height`.
- Defense/position: `Infield Range/Error/Arm, DP, CatcherAbil/Frame/Arm, OF Range/Error/Arm,
  Pos Rating {P,C,1B,2B,3B,SS,LF,CF,RF}, Learn{C,1B,2B,3B,SS,LF,CF,RF}`.
- **Ownership + economy (the account-relevant tail):** `era, tier, MissionValue, limit, owned, brefid,
  Buy Order High, Sell Order Low, Last 10 Price, Last 10 Price(VAR), date, packs`.
  - `owned` = quantity owned (per account). `tier` ↔ slots-mode tiers. `Last 10 Price(VAR)` = market
    price of the card's **variant** (the format itself distinguishes base vs variant economics).
    `era`/`tier`/`limit`/prices are catalog/market data, not account-specific (aside from `owned`).

**Confirmed bug against this format:** `RosterAndLineupPage.countPitchTypes` searches for
`"Circle Change"`/`"Knuckle Curve"` (with spaces); the CSV uses `Circlechange`/`Knucklecurve`. Those
two pitch types are therefore never counted, affecting `min_pitch_types` starter qualification.
`tournament.ts countPitchTypes` uses the correct names — another instance of the same logic living in
two places with one copy wrong (the §10.1/§10.3 pattern, in miniature).

## 7C. Why the post-processing phases exist (root-cause analysis)

The LP does **not** build the full 26-man roster. It optimizes the high-value core (starters +
rotation) and **deliberately reserves cap budget** (`reservedForSupport` = bench + backup-C + swingman
+ reliever caps, line ~2269) for support roles that are **filled by post-LP greedy passes** within
that reserved budget. Cards are priced by *net* cost (`cardValue − card_value_min`) over a `26 ×
card_value_min` baseline. Almost every post-phase is a consequence of this one choice.

- **Initial extraction** — reads LP solution; prunes hitters the LP selected but the lineup can't seat.
  Bookkeeping.
- **Lineup optimization** — separate assignment of 9 hitters/side + defensive positions + batting
  order. A legitimate sub-solve.
- **Bench fill** — exists only because the LP didn't select the bench. Coverage-aware. Home of the
  "Arozarena" greedy-vs-LP-value bug.
- **Backup-catcher 3-pass** — exists because "starter + qualified backup catcher" couldn't be
  guaranteed in the core LP → three solves. Pure workaround.
- **Locked-card placement** — force-adds user-locked cards the LP didn't place; counterpart removal;
  overflow.
- **Cap reclaim** — exists purely because reserved support budget may go unspent; reclaims surplus and
  re-solves to upgrade starters. Direct artifact of reserve-then-fill.
- **Bonus selection** — separate concern: a two-way player fills two roles with one card, freeing a
  slot; fills it (best hitter who'd start, else best pitcher). N-slot capable.
- **Final lineup re-opt** — re-seats lineups after roster changes.

**Conclusion:** bench fill, backup-C 3-pass, cap reclaim, and swingman/reliever fill are all
consequences of "optimize starters only + reserve a support sub-budget," not fundamental
inexpressibility. A single LP selecting all 26 with full coverage (≥2/pos incl. a backup-qualified
catcher), rotation+bullpen slots, and the whole cap (no reservation) would collapse them into the
solve. Lineup assignment (a legitimate sub-problem) and the two-way freed-slot/lock handling would
remain or become LP constraints. Model-first is achievable; the phases reflect tractability/effort
tradeoffs, not impossibility.

## 8. Coverage status
Every non-`node_modules`/`.next` source file has now been read or structurally characterized. The only
items intentionally not deep-read are pure UI-entry widgets whose function is fully implied by their
props/usage (`SettingsTab`, `DepthChart`, `PositionConstraintEditor`, `DefensiveStatInput`,
`PitchingRotationEditor`, `ClientShell`) and the Next.js route wrappers. Nothing scoring-, LP-, config-,
or persistence-relevant remains unexamined.
