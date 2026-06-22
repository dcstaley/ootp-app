# OOTP Optimizer Rebuild — Roadmap & Backlog

A living plan. Companion to the settled docs: `REBUILD_REQUIREMENTS_AND_DECISIONS.md` (D1–D7),
`REBUILD_ARCHITECTURE.md` (build order, Part 5), `REBUILD_DISCOVERY_FINDINGS.md` (old-app evidence).
This doc turns those into milestones, **user stories**, and **spikes** we can build against.

**Status legend:** ✅ done · 🔜 next · ⬜ planned · 🔬 spike (needs exploration first) · ⏸ deferred

**The product, in one line:** a single-user desktop-ish web app (local Node server + browser) that
imports OOTP card data, scores every card through one shared core, and builds optimal rosters/lineups
under tournament rules — with model training and a Single-Player mode. "User" below = the OOTP manager
(you) unless it says *maintainer*.

**The through-line:** one scoring core, computed once, consumed identically. Every milestone reads that
core; none recomputes scoring.

---

## Milestone map

| # | Milestone | Goal | Status | Depends on |
|---|---|---|---|---|
| M0 | Foundations | TS project, tests, version control | ✅ | — |
| M1 | Scoring core | One core; reproduce old app scores | ✅ | M0 |
| M1.5 | Self-contained calibration | Compute our own anchor/calibration scales | ✅ | SP-1 |
| M2 | Data layer + config | Catalog, account overlays, Tournament/Era/Park libraries | ✅ | SP-2, M1.5 |
| M3 | Data Grid | First UI consumer of the core | 🔜 (scaffold + grid live) | M2, SP-11 |
| M4 | Optimizer | Roster + lineups + rotation/bullpen | ⬜ | SP-4/5/6, M2 |
| M5 | Manual editing | Drag-drop roster/lineup overrides | ⬜ | M4 |
| M6 | Training + bake-off | Fit models; D3 comparison harness | ⬜ | SP-8/9 |
| M7 | Single Player | SP import adapter + potential ratings | ⬜ | SP-10, M2 |
| X | Cross-cutting | Packaging, persistence, parity method | ongoing | — |

Sequencing rationale: M1.5 finishes the scoring story (no more pasting scales from the old app); M2
builds the structure everything reads; M3 makes it visible/checkable; M4 is the payoff; M5–M7 round it
out. Spikes gate the milestones that need exploration.

---

## M0 — Foundations ✅

- **S0.1** ✅ As maintainer, a single TypeScript project (ESM, Vitest, no build step via Node type-strip)
  so all logic lives in one language/codebase. *Done.*
- **S0.2** ✅ As maintainer, version control on GitHub (private `dcstaley/ootp-app`) with the validated
  baseline committed; trained-model captures gitignored. *Done.*

## M1 — Scoring core ✅

- **S1.1** ✅ As maintainer, exactly one scoring core (`src/scoring-core`) with a swappable model seam
  (`src/model`, D3), so scoring math exists in one place. *Done.*
- **S1.2** ✅ As a manager, every card is scored for **wOBA** and **basic**, per side (vL/vR) and role
  (hitter/pitcher), reproducing the old Roster & Lineup page's trusted scores.
  *Done — exact-to-displayed-digit vs the live app (hitting wOBA+basic, pitching) across neutral and
  full park+era tournaments; bit-identical across 10 score fields/card in `tests/parity.test.ts`.*
- **S1.3** ✅ As maintainer, must-preserve domain facts hold: park compression `cp()` 0.26 before use,
  era uncompressed, switch-hitter handedness, ssp, BIP-derived hits. *Done (validated).*

**Parity gate (met):** rebuilt core == old app on the same inputs.

## M1.5 — Self-contained calibration & cross-pool value 🔜

Today the core *consumes* `calScales` captured from the old app. To stand alone it must *produce* them.

- **S1.5.1** 🔜 As maintainer, the core computes per-event calibration scales + the per-pool/side
  **anchor** over the eligible/top-N pool (reproducing the old backend `calcAnchorWoba`), so we no
  longer paste scales. *Acceptance:* reproduces captured `anchorMeanVR/VL`, `hitBB/HR/Scale*`,
  `pBB/HR/pitchScale*` within tight tolerance on the same pool. *(SP-1 done — see below.)*
  *Notes from SP-1:* only **BB and HR** are per-event scaled (1B/GAP/nHH scales computed but unused —
  see Open Questions); the anchor wOBA omits **ssp and the HBP term**. Exact scales depend on the
  eligible pool (card-value range) **+ hitter/pitcher pool-tagging**, so **bit-exact parity lands with
  M2** (eligibility + pool construction); the math itself is proven (reproduces to ~0.1–0.5% on real
  eligibility, residual = pool-tagging).
- **S1.5.2** 🔜 As maintainer, anchor is applied **after** era/park, all cards normalized to 600 PA (D1).
- **S1.5.3** 🔜 As maintainer, a `valueFor(card, role)` = **signed distance from a common baseline**
  (hitter `wOBA − baseline`, pitcher `baseline − allowedWOBA`), no power transform (D2), exposed as the
  cross-pool comparable value the optimizer will use. *Acceptance:* monotonic with wOBA within a pool;
  hitter/pitcher on the same unit.
- **S1.5.4** ⬜ As maintainer, basic-mode anchoring (target ~100) reproduced too. *(Already have captured
  basic-anchored scales as targets.)*

**Parity gate:** our computed scales == old app's captured scales.

## M2 — Data layer + config ⬜

- **S2.1** ⬜ As a manager, I import a `pt_card_list.csv` to build/refresh the shared **card catalog**
  (ratings, value, defense, learn flags, pitch types with no-space spellings).
- **S2.2** ⬜ As a manager with **two PT accounts**, I import each account's CSV; ownership is keyed
  per account as an **overlay** on one shared catalog (D6; model N, default 2). `owned` is a quantity.
- **S2.3** ⬜ As a manager, I select the **active account**; the catalog view, variants, and generation
  scope to it (owned = `owned > 0`); quantity is shown but constrains nothing yet (D6).
- **S2.4** ⬜ As a manager, I add **account-scoped variants** to owned cards; base+variant merge;
  variant/base mutually exclusive. **DECISION (2026-06-20): v5-only** — drop old levels 1–4 and the
  `vlvl` selector; a variant is just the v5 boost, present or not. *Acceptance:* the L5 boost
  (`v + floor((5·v+40)/80) + 2`) matches old `applyVariantBoost(row, 5)`. (Deliberate divergence from
  the old app's 1–5 support, not a parity target.)
- **S2.4b** ⬜ (future, noted) As a manager, I **bulk-import variants from a CSV** — a list of Card IDs
  the account has variants for (ignore level/ratings; we generate the v5 boost). Import **replaces** the
  account's current variant list; keep manual add/delete alongside. Maps to `AccountOverlay.variantCardIds`.
- **S2.5** ⬜ As a manager, I create/edit/save **Tournaments** as the single config source: roster shape,
  cap/slots rules, eligibility (ALL/ANY rule groups), position constraints, metrics, pool sizes,
  ownedOnly, softcaps, position weights (D4). No separate page-level settings object.
- **S2.6** ⬜ As a manager, I maintain reusable **Eras** and **Parks** libraries; a tournament references
  one of each **by id** (D4; Park is new, mirrors Eras).
- **S2.7** ⬜ As a manager, **selecting a tournament immediately drives scoring config** — era/park/
  softcaps/weights flow in with no "Load into coefficients" button (D4). *Acceptance:* the scores from
  S1.2 are reproduced with config sourced from tournament+libraries instead of a pasted bag.
- **S2.8** ⬜ As maintainer, everything persists as **plain files in one folder** (D7); account overlays
  first-class; no IndexedDB/localStorage/sessionStorage sprawl. *(Gated by SP-2.)*
- **S2.9** ⬜ As maintainer, eligibility evaluation (`num_*`/`set_*`/`text_*`/`is_blank`) + `variants_allowed`
  gating reproduce old `rowEligible`. *Acceptance:* same pool in/out on sample tournaments.

**Parity gate:** tournament-sourced config reproduces M1 scores; variant boost & eligibility match old.

## M3 — Data Grid ⬜

- **S3.1** ⬜ As a manager, I browse all cards with computed score columns, scoped to the active account,
  reading the one core (grid never scores).
- **S3.2** ⬜ As a manager, I sort, per-column filter (operators), and search (quoted/multi-term).
- **S3.3** ⬜ As a manager, I show/hide/reorder columns and use **named presets** (new) per view; view
  state persists per grid.
- **S3.4** ⬜ As a manager, I inline-edit raw fields (esp. `owned`); computed columns are read-only.
- **S3.5** ⬜ As a manager, rows on the current generated roster are highlighted.
- **S3.6** ⬜ As maintainer, a guard flags **corrupt rating values** (e.g. 25,000+ Basic Hitting) (new).

## M4 — Optimizer (roster + lineup) ⬜

- **S4.1** ⬜ As a manager, I generate an optimal **26-card roster + vL/vR lineups + rotation/bullpen**
  under the active tournament's rules, ranked by the one core's values.
- **S4.2** ⬜ As a manager, constraints hold: roster size, H/P split (two-way frees a slot), position
  coverage for both platoon lineups incl. backups, starter qualification (stamina + pitch-type mins),
  rotation-slot weighting, one-card-one-use, required/excluded, cap budget / slots tiers.
- **S4.3** ⬜ As maintainer, **starters-first** decomposition (D5): cap/slots = role-weighted starters in
  main budget + **principled** support fill within per-role sub-budgets (kills the Arozarena greedy
  bug); non-cap = best roster meeting structural+positional constraints, unweighted.
- **S4.4** ⬜ As maintainer, defensive feasibility is a **matching/assignment** check (covering ≠ matching),
  so a chosen set is guaranteed alignable across vL/vR + backups; **backup catcher = a coverage-depth
  constraint** (retire the 3-pass). *(Gated by SP-5.)*
- **S4.5** ⬜ As a manager, locked/excluded cards, two-way players, and the **bonus slot** (N-slot) are
  handled inside the optimization, not patched after. *Note (user):* `topHitters`/`topPitchers` also
  define **two-way membership** (a card in both pools), **even in cap mode** — reconstruct that here.
- **S4.6** ⬜ As maintainer, **cap-reclaim** (unspent support budget → starters) is deterministic.
- **S4.7** ⬜ As a manager, both-sides hitter bonus + role/slot weights apply in **cap/slots only** (D2).
- **S4.8** ⬜ As maintainer, the solver is **HiGHS-WASM in-process** (no Python). *(Gated by SP-4/6.)*

**Parity gate (looser):** rosters/lineups comparable to the old app on known-good cases (selection is
"in a reasonable state" per the user; scores are exact). Differences must be explainable as intended
D5 fixes, not regressions.

## M5 — Manual editing ⬜

- **S5.1** ⬜ As a manager, I drag cards in/out of the roster; a **Next Best Available** pool tabbed by
  need (hit vL/vR, owned-only, starters, IF/OF range, catcher ability…), variant/base-aware.
- **S5.2** ⬜ As a manager, I drag players into lineup slots, set per-slot defensive position, **lock** a
  player to a position, and remove them; position eligibility enforced per slot.
- **S5.3** ⬜ As a manager, re-optimization respects my lineup position locks and is ranked by the same
  core — manual and automatic agree.

## M6 — Model training + comparison harness ⬜

- **S6.1** ⬜ As maintainer, I fit the four models (woba/basic × hit/pitch) from outcome CSVs; vL and vR
  are **separate observations → one unified fit**; weight PA^0.75 / BF^0.75; aggregate duplicate cards.
- **S6.2** ⬜ As maintainer, training-time pipeline mirrors inference (predicted BIP, not actual).
- **S6.3** ⬜ As maintainer, diagnostics: residual bins by **weighted volume** (`sumW`, not N),
  over-valuation signal, and **recommended softcaps** that seed a tournament's values.
- **S6.4** ⬜ As maintainer, a **comparison harness** fits candidate model forms and scores them against
  the diagnostic suite on real data (the D3 bake-off). *(Gated by SP-8.)*
- **S6.5** ⬜ As maintainer, a trained model is a model-scoped artifact behind the D3 `EventModel` seam —
  nothing downstream assumes its form.

**Parity gate:** reproduce the old trainer's log-linear fit before exploring new forms.

## M7 — Single Player ⬜

- **S7.1** ⬜ As a manager, I import an SP `Export.csv`; a **column adapter** maps SP names to standard
  names; the same core scores it (scale handled by anchoring, not SP-specific hacks).
- **S7.2** ⬜ As a manager, I see **current vs potential** scoring (potential ratings run through the same
  pipeline) with the UI to surface both. *(Gated by SP-10.)*
- **S7.3** ⬜ As a manager, SP reuses the roster engine; account features (D6) do **not** apply to SP.

## X — Cross-cutting ⬜/ongoing

- **SX.1** ⬜ As a manager, I launch the app once and use it in a browser (local Node server serves the
  SPA; Node has filesystem access to the one data folder). *(Gated by SP-11.)*
- **SX.2** ⬜ As maintainer, a file-based persistence repository (D7) is the one home for libraries +
  working session; account overlays first-class.
- **SX.3** ongoing — parity methodology: each milestone validated against the old app where an oracle
  exists (capture → golden → diff), via `tools/`.
- **SX.4** ✅ version control (M0).

---

## Spike / exploration backlog

Each spike: the **question**, **why it matters / what it unblocks**, **rough approach**, **output**.

| ID | Question | Unblocks |
|---|---|---|
| SP-1 ✅ | How does the old `calcAnchorWoba` build its anchor pool + per-event scales? | M1.5 |
| SP-2 | What's the file-based persistence shape (schema/layout)? | M2, SX.2 |
| SP-3 | Variant boost + eligibility exact behavior | M2 |
| SP-4 | Optimizer LP formulation in HiGHS-WASM (starters-first) | M4 |
| SP-5 | Defensive feasibility as matching/assignment | M4 |
| SP-6 | HiGHS-WASM performance on real pool sizes | M4, SX.1 |
| SP-7 | Does D2 signed-distance give sane H/P balance in the objective? | M4 |
| SP-8 | D3 model functional-form bake-off | M6 |
| SP-9 | Training-data loader + parity vs old trainer | M6 |
| SP-10 | SP Export format + potential-rating fields | M7 |
| SP-11 | Packaging scaffold (local server + browser) | M3, SX.1 |

**SP-1 — Anchor/calibration internals. ✅ DONE (exploration).** *Findings:* `calcAnchorWoba` + `evScale`
fully reverse-engineered and reproduced line-for-line (`tools/spike-calibrate.ts`). ANCHOR_N=50,
TARGET_WOBA=0.320, Section-3 baselines `H_SECTION3`/`P_SECTION3`. Anchor pool = top-50 by raw wOBA over
the tournament-eligible pool (hitters desc / pitchers asc). **Only BB & HR per-event scales feed the
result** (1B/GAP/nHH scales computed but unused). Anchor wOBA **omits ssp and the HBP term** (HBP only in
the BIP subtraction). *Validation:* with the real eligibility (card value ∈ [60,89] for the real-parkera
tournament; the `1858` is the total cap, a roster constraint, not a pool filter) the scales reproduce to
~0.1–0.5%; the residual is the frontend's hitter/pitcher pool-tagging (`_inHitterPool`/`_inPitcherPool`),
which M2 reconstructs → **bit-exact parity is an M2 deliverable.** *Output:* `tools/spike-calibrate.ts`;
promote to `src/scoring-core/calibrate.ts` for M1.5.

**SP-2 — Persistence design.** *Why:* M2 needs a concrete on-disk shape. *Approach:* decide JSON (and/or
SQLite) layout for catalog, account overlays, tournaments, eras, parks, models, saved rosters; a
repository interface. *Output:* schema + repo API; folder layout.

**SP-3 — Variants + eligibility parity.** *Why:* M2 must match old behavior. *Approach:* port the variant
boost formula and `rowEligible` operators; validate pool in/out and boosted ratings against the old app.
*Output:* parity tests.

**SP-4 — Optimizer formulation. ✅ DONE (spike).** *Output:* `tools/spike-highs.ts` — a working MILP on
the real scored pool: binary `r_<card>` (roster membership) + `y_<card>_<pos>_v{L,R}` (dual-lineup
assignment), objective = Σ value(card,side)·y, constraints = each position filled once per side, ≤1
position per card per side (linked to roster membership), roster size, **backup catcher = a coverage-depth
constraint** (`Σ rostered catchers ≥ 2`, retiring the 3-pass). Solved to **Optimal**, integral, no greedy
fill. Variable encoding confirmed (CPLEX LP-format string → `highs.solve`). The starters-first
decomposition + cap/slots budgets are the remaining M4 build (not re-explored — the encoding is proven).

**SP-5 — Defensive feasibility. ✅ (largely answered by SP-4).** The "covering ≠ matching" concern is
handled *inside* the MILP: per-position fill + ≤1-position-per-card IS the bipartite assignment, solved
exactly (both vL and vR), and backup catcher is a coverage-depth constraint. So a separate matching pass
isn't required for feasibility — the MILP guarantees an alignable set. (A standalone matching check may
still be handy for fast manual-edit validation, M5.)

**SP-6 — Solver performance. ✅ DONE — GO.** *Timings (`tools/spike-highs.ts`, real real-parkera pool):*
HiGHS-WASM loads ~12ms in-process (no Python, no native build). Full un-decomposed pool (1499 hitters,
13,727 binaries, 3018 constraints) → **Optimal in ~480ms**; decomposed top-150 → 27ms; top-60 → 9ms. All
three return the identical objective/roster, so D5 decomposition loses nothing while giving 20–50× headroom
(pitchers are a simpler pick-top-N, not the bottleneck). **Solver decision confirmed: HiGHS-WASM (`highs`
npm, MIT), in-process.** `highs` added zero vulnerabilities (the npm-audit warnings are pre-existing
dev-only vite/esbuild advisories). Fallback ladder if a future pool stresses it: tighten decomposition →
OR-Tools CP-SAT (native) → glpk.js.

**SP-7 — Cross-pool balance.** *Why:* D2 drops the power transform; verify natural H/P balance is sane.
*Approach:* compare rosters/value splits under signed-distance vs the old app's; treat skew as a
calibration signal. *Output:* confidence note or a flagged calibration fix.

**SP-8 — D3 bake-off (deferred form choice).** *Why:* log-linear may be systematically wrong at the
extremes. *Approach:* fit candidate forms (log/linear/quadratic/cubic, sequential vs not, logistic vs
rate) behind the `EventModel` seam; score vs residual diagnostics on `Model 2037 and 2038/` data; also
evaluate `recalibrate_pt_model.py`'s sequential cubic-logit. *Output:* a chosen form + evidence. ⏸ until
parity-complete (per the user: parity first, modeling after).

**SP-9 — Training loader.** *Why:* M6 needs robust ingestion. *Approach:* load per-(pool, split, year)
CSVs; **filename split detection robust to token order** (e.g. `HD 452 2038 vR.csv`); aggregate dup
cards; PA/BF threshold. *Output:* loader + parity vs old trainer's log fit.

**SP-10 — SP format.** *Why:* M7 needs the real column set. *Approach:* read `Export.csv` (old repo) as
the authoritative SP format; enumerate current vs potential rating fields + any extra SP dimensions.
*Output:* the adapter column map + potential-field list.

**SP-11 — Packaging scaffold.** *Why:* M3 needs somewhere to render. *Approach:* stand up a local Node
server + React SPA + the data folder; "launch once." *Output:* runnable shell, no scoring/logic dupes.

---

## Open questions / risks

- **Optimizer is the hardest part** (SP-4/5/6). De-risk early with a spike before committing M4 scope.
- **Parity gets looser past scoring.** Scores are exact; rosters are "comparable" — we need agreed
  acceptance criteria for M4 so intended D5 fixes aren't read as regressions.
- **D3 model form** stays deferred until parity is fully done; don't let it creep into M1.5/M2.
- **Two-config-source & multi-home duplication** (old app) must not re-emerge — D4 single-source is a
  standing invariant, not a one-time task.
- **🔬 REVISIT — per-event calibration only scales BB and HR.** The old anchor scales only **BB** and
  **HR** to the Section-3 baselines; the **1B / GAP / nHH** per-event scales are computed but **unused**,
  so non-HR-hit and XBH components are never independently re-anchored — they ride the BIP recompute and
  the final per-pool anchor scalar. Parity preserves this exactly (S1.5.1). **Flagged for follow-up
  (user request):** this may under-/mis-calibrate the non-HR-hit components and is a candidate scoring
  issue. Revisit **post-parity**, alongside D1 (per-event calibration design) and the D3 model work —
  not during M1.5/M2.

- **🔬 REVISIT — OVR vL/vR split weighting is hand-set, and the RHB weight is directionally wrong.**
  `score-card.ts` blends vL/vR into OVR leaning 0.6 toward the batter's platoon-*advantage* side
  (RHB → `0.4·vR + 0.6·vL`; LHB → `0.6·vR + 0.4·vL`; SHB 0.5/0.5). **Realized exposure, conditional on
  batter hand, from the user's leagues** (PEL + HD 450–453, 2037–38, ~1.77M PA): **RHB face RHP 56.6% /
  LHP 43.4%** (→ vR≈0.57/vL≈0.43); **LHB 72.1% / 27.9%** (→ vR≈0.72/vL≈0.28); **SHB 61.3% / 38.7%** (→
  vR≈0.61/vL≈0.39). So the platoon effect is real and hand-dependent (justifies a per-hand weight), but
  the code's **RHB** weight is *backwards* (0.60 on vL while RHB actually face RHP more), LHB undershoots,
  and SHB should lean vR not 50/50. (Caveat: realized PA shares are endogenous — managers platoon — so
  M6 should decide realized-exposure vs neutral weighting.) **Does NOT affect the optimizer** (M4 uses
  per-side vL/vR directly; OVR is display/sort only). Set from data in **M6**.

**Anchoring/scaling correctness audit (2026-06-22):** of the four flagged suspects — (#3) hitter-pool
gating bug is **already fixed** in `calibrate.ts` (anchor = top-50 by wOBA over the whole eligible pool);
(#1) BB/HR-only per-event scaling, (#2) anchor omits ssp + HBP vs the display score, and (#4) OVR weight
above all need **real outcome data to judge** and are **decoupled from M4** (the optimizer reads scoring
values as objective coefficients; recalibration later just changes the numbers, not the machinery).
**Decision: M4 first, then evaluate/fix all four against outcome data in M6.** The one composition-relevant
effect (#2's cross-pool offset) gets an SP-7 H/P-balance guardrail during M4.

---

## Flagged old-app issues (parity-preserved; revisit, don't blindly copy)

**Standing policy:** the old app is usable but may contain real logic/calc bugs. We reproduce it for a
safe parity baseline, but we **scrutinise as we port, flag suspected bugs** (in code comments + here),
and **surface them** — we never assume the old behavior is correct. Fixes happen post-parity unless
trivial and agreed.

- **Per-event calibration only scales BB & HR** — the `1B/GAP/nHH` scales are computed but unused, so
  non-HR-hit and XBH components are never independently re-anchored (see Open Questions). *Suspected
  issue (user flagged for follow-up).*
- **`countPitchTypes` name mismatch** (findings §7B/§7.2): `RosterAndLineupPage.countPitchTypes` searches
  `Circle Change`/`Knuckle Curve` (with spaces) but the CSV uses `Circlechange`/`Knucklecurve`, so those
  two pitch types are never counted → wrong `min_pitch_types` starter qualification. `tournament.ts` uses
  the correct names. *Confirmed bug; same logic in two places, one wrong.*
- **Display ≠ LP scoring** (findings §1.2/§4.4): the grid/display score and the optimizer objective
  diverge (the `^1.2` power transform + cross-pool mults are LP-only). The rebuild unifies on one value
  (D2). *Known; fixed by design.*
- **Anchor wOBA omits ssp + the HBP term** while the display score includes them — looks intentional but
  worth confirming it isn't an oversight that skews calibration. *Quirk — verify.*
- **Hitter pool gated on non-DH position eligibility** (`RosterAndLineupPage` ~1243:
  `_inHitterPool = ALL_POSITIONS(≠DH).some(Learn{pos}===1)`): wrongly excludes DH-only cards and
  pitchers-who-can-hit. Every player has a hitting score → every player is a potential hitter. This tag
  gates the **calibration anchor pool**, so it skews the calScales (and thus the display scores).
  *Confirmed bug (user-flagged).* **Correct design:** hitter pool = all players (everyone has a score);
  the only narrowing is `topHitters` (non-cap, default 100) or `HARD_POOL_CAP=1500` — and that narrowing
  is for the **optimization** pool (M4), not calibration. Calibration anchor = top-50 by wOBA over all
  eligible cards.

(Append here whenever something looks wrong during a port.)

---

## Right now

**M2 COMPLETE** — M2a catalog · M2b config + eligibility + pool · assemble-coeffs (D4) · M2c accounts +
v5 variants (D6) · M2d file-based persistence (D7). 40 tests green; parity bit-identical; capstone
persists config, reloads from disk, and drives the full chain. The data + config layers are done.

**In progress: M3 — Data Grid.** App shell (SP-11): local Node server `src/server/server.ts` runs the one
core and serves scored cards (`/api/cards`, `/api/meta`); React+Vite SPA in `web/` renders the grid.
**Dev run:** `npm run dev` (`tools/dev.ts`) starts the api (8787) and, once it's listening, Vite (5173,
hot-reload, proxies /api → 8787) — it's the FIRST `.claude/launch.json` config, so Claude's "Start preview"
button opens the live-reload UI on 5173 (not the static build on 8787). The api child is pinned to PORT 8787
inside the launcher (the preview harness injects PORT=5173 for the config). `api`/`web` remain as separate
configs for granular use. Standalone: `npm run build:web` then `npm run server` → http://localhost:8787.

**Grid done so far:** two views (Hitting / Pitching — Defense folded into Hitting); columns = Card, Var
(purple ★, "v5" suffix), wOBA OVR + vL/vR, Basic OVR + vL/vR (BOTH metrics accurate — server
double-scores with independent wOBA-anchored and basic-anchored calibration), the 8 real `Learn*`
position columns (raw 0/1), defensive ratings, Stam + # pitches (pitching, far right); player-name sort
(last, first); global Search + Highlight; Eligible-only + Owned-only; **Sheets-style per-column filter
popover** (funnel icon → Filter-by-condition dropdown + Filter-by-values checklist with search /
Select-all / Clear / (Blanks)); resizable, smart-sized columns; dark theme. Two demo variant rows are
injected server-side so variant inclusion is visible.

**Tournament selector — DONE.** The file-based tournaments DB (D7) is now live: on first run the server
seeds `data/{models,eras,parks,tournaments}` from the local captures (one shared Model + reusable Era/Park
libraries + one Tournament per capture, plus a built-in neutral default) via `seedDefaults` (idempotent —
skips if the DB is non-empty, so hand-edits survive). `resolveCoeffs(model, era, park, softcaps)` assembles
the scoring bag from a tournament's parts (built on the lossless split/assembleCoeffs partition); a parity
test proves it reproduces every capture bag byte-for-byte. The server resolves → re-calibrates → re-scores
per tournament (lazy + cached); `/api/tournaments`, `/api/cards?tournament=`, `/api/meta?tournament=` serve
it; the grid has a read-only tournament `<select>` that re-scores live (verified: eligible count 3376→1919
and per-card wOBA shift across neutral/tHR/park+era). `data/` is gitignored (embeds the trained model +
tournament settings → local state). Tournament create/edit/rename UI is a later step (read-only for now,
per the user). Note: the shared Model carries `pw_*` position weights from one capture (don't affect grid
scoring — optimizer-only); categorising `pw_*` → tournament is a carried-forward follow-up.

**Account selector — DONE (D6).** Accounts are a NEW concept (no old-app parity): they share one catalog
and differ only in `owned` quantities + variants. **Catalog model decision:** the shared catalog is sourced
from the *latest uploaded* `pt_card_list` CSV (not the committed file), so new card releases flow in on
upload and a card always scores identically across accounts (single scoring core). The committed
`docs/pt_card_list.csv` is now only a format reference + fresh-clone fallback. On first run the server seeds
accounts from the user's OOTP `online_data` folder (`seedAccounts`, idempotent; names from filenames →
CDMX/Oaxaca, user-renamable); each CSV becomes a saved import + an owned overlay, and the most complete list
becomes the catalog source. Scoring depends ONLY on tournament + catalog, so switching accounts just stamps
`owned` and adds that account's variant rows — no re-score. Endpoints: `/api/accounts`, `/api/state` (persists
active account + tournament across reloads), `/api/accounts/rename`, `/api/accounts/import` (raw CSV → updates
ownership + refreshes shared catalog; `?id=` updates an account, `?name=` creates one). Grid gains an Account
dropdown + Rename + Upload CSV… + "+ Account". Verified: CDMX 2984 owned / Oaxaca 3054 (differ on 1864 cards),
identical scores across accounts, catalog now 3382 cards (from upload, not the stale 3376), active selection
persists across reload. **Per-account variant management — DONE (D6, S2.4b).** Two ways to populate an account's `variantCardIds`,
both writing the same overlay field; we always recompute the v5 boost ourselves (ignore the game's level/ratings):
(1) **manual add/remove** via a search-and-select modal (search the catalog by player/card name → + Add; remove
from the current list) — replaces the old Card-ID-entry flow; (2) **variant CSV import** — the game's "manage
cards variant export" (a `Name,CID` list); `parseVariantExport` picks the `CID` column (falls back to `Card ID`,
and deliberately REJECTS an unrelated `ID` column so the wrong export can't be misread), matches against the
catalog, and REPLACES the account's variant list. Endpoints: `/api/accounts/variants/toggle` (add/remove one,
deduped, catalog-existence-checked) and `/api/accounts/variants/import` (raw CSV). Variant rows are scored on
demand from the tournament's cached config (no re-score) and show as ★…v5. Verified: CDMX import 72 matched /
0 unmatched via `CID`; toggle add/remove/dedupe/bad-id-reject; modal lists 72, hides already-variant cards from
add-search. 4 parser unit tests (incl. the wrong-`ID`-column rejection).

**Navigation shell — DONE.** Split the monolithic grid into an app shell: a left sidebar (app title, the
global **Tournament + Account** selectors that scope every page, grouped page nav) + a routed main area
(hash routing; no server route config — the server already falls back to index.html). New web modules:
`shared.ts` (types + theme), `state.tsx` (`AppDataProvider`/`useAppData` — all fetching + mutations),
`CardsPage.tsx` (the grid), `AccountsPage.tsx` (account table: set-active/rename/import-ownership/+new,
plus inline variant management — moved off the grid header), `App.tsx` (shell + nav + hash router). Nav:
**Build** group (Cards ✅, Roster & Lineups ⬜M4, Single Player ⬜M7) · **Setup** group (Accounts ✅,
Tournaments ⬜, Eras & Parks ⬜, Model Training ⬜M6) — unbuilt pages are labeled placeholders. IA matches
the old app's left-nav concept but D4-correct (no "Coefficients" page; tournaments/eras/parks replace it).
Verified: nav + routing, sidebar selectors, Accounts set-active syncs the sidebar + variant section.

**M3 remaining:** highlight generated-roster members (needs M4). M3 is otherwise complete.

Carried-forward follow-ups: categorise the D4 `extras` remainder; real model-artifact format (M6);
CSV variant import (S2.4b); revisit BB/HR-only per-event calibration + the OVR vL/vR split weighting
(both flagged). Engineering stack (React+Vite+Node) is the assistant's call (user is not an engineer).

---

## Session handoff (read first on resume)

**State:** M0 / M1 / M1.5 / M2 complete; M3 (Data Grid) well underway (above). Branch `main`, everything
pushed to GitHub `dcstaley/ootp-app`. ~45 tests green; parity vs the old app bit-identical. The entire
headless core — scoring, self-contained calibration, eligibility/pool, accounts + v5 variants,
persistence — is done and validated; current work is the UI.

**Immediate next step:** finish M3 — the **load-a-tournament selector**, then the account selector.
After M3: **M4 optimizer** is the big one — run its spikes first (SP-4 LP formulation in HiGHS-WASM,
SP-5 defensive matching/assignment, SP-6 solver perf). Build order continues M5 manual editing, M6
training + D3 bake-off, M7 Single Player.

**Working agreement (also in auto-memory — `MEMORY.md`):**
- User is NOT a software engineer: own tooling/implementation decisions; only surface product / domain /
  UX choices, and when you do, give concrete options + plain-language tradeoffs + a recommendation.
- NEVER post screenshots — the user watches the live preview; verify via `preview_console_logs` (errors)
  + `/api` curl. Use the Claude_Preview MCP (`preview_start`/`preview_stop`) to manage servers.
- Treat the OLD app (`C:\ootp_app`) as suspect, not authoritative — flag suspected bugs (see "Flagged
  old-app issues"), don't blindly copy.
- Commit AND push after each milestone, as SEPARATE git commands (compound `&&` chains re-prompt).
- Parity = equivalence with the old app's trusted Roster & Lineup numbers, NOT endorsement.
- Real captures in `fixtures/captures/*.json` are gitignored (contain the user's trained model); only
  `_synthetic.json` is tracked. Validate with: `npm run golden` → `npm test`.
