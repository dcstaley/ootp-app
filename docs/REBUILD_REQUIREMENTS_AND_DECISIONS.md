# OOTP Optimizer Rebuild — Consolidated Requirements & Open Decisions

Companion to `REBUILD_DISCOVERY_FINDINGS.md` (the evidence). This doc is decision-oriented:
Part A confirms *what the app must do* (function, not current code); Part B lists the *decisions we
still need to make together* before architecture. Nothing here locks in implementation — current
behavior is cited only as evidence of intent.

---

## Part A — Requirements confirmation by feature area

Each line states the durable function + any must-preserve domain fact. Detail/evidence in the
findings doc.

1. **Scoring core.** From a card's raw ratings, produce per-event predictions (BB, K, HR, non-HR hits,
   XBH) and from them wOBA and a "basic" score, per side (vL/vR) and per role (hitter/pitcher).
   Must-preserve domain facts: park factors are compressed (`cp`, 0.26) **before** application; era
   factors are **not** compressed; BIP is derived from the other events and dependent hits recompute
   from it; switch-hitter handedness rules; same-side platoon penalty. **One implementation, consumed
   identically by grid, roster/LP, SP, training-validation.**
2. **Data Grid.** Browse the card pool with every card scored; sort/filter/search/column-manage;
   per-grid view persistence; inline edit of raw fields (esp. `owned`); highlight roster membership;
   be reusable for SP via an override/predicate/preset mechanism. New wants: named column presets;
   guard against corrupt rating values.
3. **Roster & Lineup.** From a scored, eligible pool + tournament rules, produce an optimal 26-card
   roster and optimized vL/vR lineups + rotation/bullpen. Must-preserve constraints (intent level):
   roster size, hitter/pitcher split (two-way players free a slot), position coverage for both
   platoon lineups incl. backups, starter qualification (stamina + pitch-type minimums), rotation
   slot weighting, one-card-one-use (variant/base mutually exclusive), required/excluded cards, and
   cap-mode budget / slots-mode tier caps. Manual drag-drop override of roster and lineups with
   per-position locks. Both-sides bonus is cap/slots-only. No pitcher batting.
4. **Coefficients / scoring parameters.** A parameter set drives scoring. Today it's one global flat
   bag mixing trained model params, era/park, platoon penalties, fixed wOBA weights, softcaps, and
   derived values — to be separated by provenance/lifecycle in the rebuild.
5. **Eras.** A reusable library of era run-environment factors (BB, K, AVG, HR, BIP, GAP), selected
   per tournament. Factors apply linearly (no compression).
6. **Park.** Per-side HR/AVG factors + gap, the venue environment, compressed via `cp`. Needs exactly
   one home (today duplicated). Possibly a reusable Park library mirroring Eras.
7. **Tournaments.** The central rules object: cap/value rules, roster shape, variants policy, era,
   park, eligibility (ALL/ANY rule groups), softcaps, slot counts, position weights — plus the
   generation-time settings currently split into a separate page-level object.
8. **Model Training.** Fit the four models (woba/basic × hitting/pitching) from outcome CSVs; treat
   vL and vL as separate observations into one unified fit; weight by PA^0.75 / BF^0.75; aggregate
   duplicate cards; produce residual + softcap diagnostics measured by weighted volume (not row count).
9. **Single Player (SP).** Same scoring/roster engine on a different input format (column adapter) +
   scale-agnostic anchoring + Potential-rating scoring/UI. Not a separate engine. PT-only features
   (accounts) excluded.
10. **PT Account (new).** Per-account ownership scoping on the owned/not-owned generation filter; one
    CSV import per account; `owned` is a quantity already in the CSV; PT-only. Shared catalog + per-
    account ownership/variant overlay. (Full detail: findings §7B.)

---

## Part B — Open decisions (to resolve together before architecture)

Each: the question, the options, and a recommendation. **These are yours to decide.**

### D1 — Calibration / scaling / anchoring layering ✅ RESOLVED
**Decision:** Two score types, one implementation each, computed once and consumed identically:
- **Basic score** = direct function of ratings (each rating's contribution with era/park folded into
  the contribution). No event modeling, no BIP recompute, no per-event calibration.
- **wOBA score** = event-based pipeline, in this order:
  `raw → softcap → per-event calibration (to neutral baselines) → era/park → recompute BIP &
  dependent hits → assemble wOBA → uniform per-pool/side anchor (AFTER era/park)`.
- **Anchor is after era/park.** Rationale: the anchor is a single uniform multiplier per pool/side, so
  it can't change within-pool ranking; era/park's *relative* effects are already baked into the events
  before it; its only real jobs are cross-pool reference (D2) and display. We optimize for roster
  quality, not realistic absolute numbers, so the absolute level the anchor sets is irrelevant.
- Per-event calibration is computed against neutral baselines and the reference pool is the
  eligible/top-X pool (both already correct in current code).
- All cards normalized to 600 PA so cards compare fairly regardless of training-data volume.

### D2 — Cross-pool hitter/pitcher comparability ✅ RESOLVED
> **Superseded for cap/slots (as built):** the signed-distance VALUE is unchanged, but cap/slots no longer
> weight it by role/slot constants — the shipped **E[wins] single-MILP objective** multiplies each card's
> value by its run-scoring playing time (usage model), which subsumes the old role/slot weights. See
> `docs/REBUILD_CAP_SLOTS_OBJECTIVE_PLAN.md`. Non-cap is still unweighted Σ(signed-distance).

**Decision:** Compare players by **signed distance from a common baseline**, with the sign flipped for
pitchers, all at 600-PA normalization:
- Hitter value = `wOBA − baseline`; Pitcher value = `baseline − allowedWOBA`. Same unit (wOBA points),
  same direction (more = better). This serves both within-pool ranking (monotonic with wOBA) and
  cross-pool comparison.
- **Drop the `^1.2` power transform** and the LP-only multipliers. With both pools honestly on the same
  wOBA scale (guaranteed by D1) and measured from a shared baseline, the exponent only distorted the
  balance. (Consistent with the project rule: fix the scale, don't scale-hack.)
- **Natural hitter/pitcher balance, no tilt knob.** The H/P exchange falls out of each pool's real
  wOBA spread. If a split ever looks wrong, treat it as a calibration signal to fix at the source.
- Because playing time is constant (600 PA), the runs/playing-time apparatus collapses to constants and
  is unnecessary; the baseline (from D1) is the only input.
- **Role/slot weights and the both-sides bonus apply in CAP and SLOTS modes only.** Non-cap objective =
  unweighted Σ(signed-distance value) subject to structural constraints; cap/slots objective =
  Σ(signed-distance value × role/slot weight) subject to budget/tier caps. The value unit and natural
  balance are identical across all modes.

### D3 — Model functional form ✅ RESOLVED (bake-off, 2026-06-29)
> **RESOLVED via the data bake-off:** the deployed form is the **raw-poly** event model for HITTING
> (quadratic on POW/GAP captures the real accelerating power structure) and **StuffAug** for PITCHING (a
> log curve + a linear Stuff term on BB & HR — high Stuff suppresses walks/homers beyond Control/HRR). It
> lives behind the `EventModel` seam (`src/model/raw-poly.ts`); the comparison harness stays for future
> forms. The original deferral text is kept below for provenance.

**Decision:** Defer the functional-form choice to a dedicated data-exploration phase. Needs a real
bake-off across many structures (sequential & non-sequential; log / linear / quadratic / cubic;
logistic vs rate). The earlier poor sequential result is weak evidence (old tooling).
**Firm requirements this imposes on the rebuild (decided now):**
- The **model is a swappable component behind a clean interface.** The scoring core, calibration (D1),
  and value/LP layers (D2) consume predicted events / scores abstractly — never assumptions about how
  they were produced — so the form can change later without touching anything downstream.
- A **model-comparison harness** is part of the plan: fit candidate forms, score them against the
  residual/diagnostic suite on real data, and select. Diagnostics (residual bins by weighted volume,
  over-valuation signal, etc.) are a permanent capability.

### D4 — Unified configuration model ✅ RESOLVED
**Decision:** One home per concern; selecting a tournament *is* the configuration (no manual "load"
step).
- **Tournament = single source** for roster shape, cap/slots rules, eligibility, position constraints,
  metrics, pool sizes, ownedOnly. The page-level RosterSettings folds into the tournament.
- **Era → reusable Eras library**, referenced by the tournament by id (not embedded).
- **Park → its own reusable Park library**, referenced by id, mirroring Eras (new).
- **Position weights → tournament-scoped** (cap/slots roster rules).
- **Softcaps → tournament/pool-scoped**, because the right softcap depends on the card pool (elite vs
  mid-tier pools need different high-end compression) — currently hand-tuned per tournament. **Model
  training emits recommended softcaps to seed** a tournament's values. Note: the need for per-pool
  manual softcaps is largely a symptom of model-shape error at the extremes; D3's better model should
  reduce it over time.
- **The global mutable coeff bag dissolves:** model coefficients are model-scoped; era/park come from
  libraries via the tournament; position weights + softcaps are tournament-scoped; fixed wOBA weights
  are constants; derived values are computed. No button-synced global state.

### D5 — Optimizer shape & post-processing ✅ RESOLVED (keep decomposition; fix quality)
> **Superseded for cap/slots (as built):** the starters-first *decomposition* was replaced by a **single
> E[wins] MILP** — one solve allocates the budget across lineup/bench/rotation/bullpen via usage-weighted
> value (no reserve→greedy→reclaim). The quality goals below (principled matching, real coverage depth,
> backup-catcher as a "need two" constraint) all shipped inside that one solve. See
> `docs/REBUILD_CAP_SLOTS_OBJECTIVE_PLAN.md`.
Root cause understood (findings §7C): the LP optimizes the starting core and reserves cap for support
roles filled post-LP. **Decision: the starters-first decomposition STAYS** — it is correct, for two
reasons, not just tractability:
- **Value structure:** in cap/slots mode starters are valued *massively* above bench, and the per-role
  support budgets (`maxCap` bench / backup-C / swingman / reliever) are an **explicit user feature**.
  Pouring scarce budget/tier-slots into high-value starters and cheaply filling low-value support is
  the right economics; jointly optimizing all 26 spends huge solver/modeling cost on near-zero-stakes
  bench picks.
- **Tractability:** full 26-card selection + feasible defensive *assignment* across vL/vR + backups is
  a covering-vs-matching problem (counts ≠ feasible simultaneous alignment); a single MILP with
  card×position×side assignment + sub-budgets + slots tiers is big and brittle (matches Derek's
  experience that it doesn't solve reliably in cap/slots, and base mode chokes on positional
  constraints).

**The rebuild's win is QUALITY, not restructuring:**
1. Keep starters-first (cap/slots). Non-cap mode = pick best roster meeting structural + positional
   constraints, no role weighting / sub-budgets.
2. Replace the **greedy** support/bench fill with a small **principled** optimization (maximize
   coverage + value within the reserved sub-budgets) — kills the Arozarena-class bug without touching
   starter logic.
3. Make defensive feasibility a **principled matching/assignment check** so a chosen starter set is
   guaranteed alignable across vL/vR + backups — removes greedy gap-patching and the catcher misfires
   (backup catcher = a coverage-depth requirement, not a 3-pass).
4. Keep cap-reclaim (unspent support budget → starters) but make it deterministic.
5. Lineup assignment stays a legitimate sub-solve; all steps consume the one D1/D2 scoring value.
- Formulation specifics settled during the build with the solver in hand.

### D6 — PT Account data model details ✅ RESOLVED
Core (from findings §7B): per-account ownership scoping, one CSV import per account, quantity in CSV,
PT-only. Specifics:
- **Account count: two**, but don't hard-code it — model accounts as keyed overlays so N is possible
  later (two is the immediate need; N kept as a cheap backup option).
- **Quantity: carried as information, filter on `owned > 0`.** Roster building uses owned-vs-not;
  quantity is stored/displayed (variant material, "you own 3") but constrains nothing for now.
- **Active-account selector scopes the whole PT view:** owned/quantity shown in the Data Grid, which
  account's variants you see/edit, and the owned filter in generation. (Variants are account-scoped,
  so the selector must drive grid + variants, not just generation.)

### D7 — Persistence & platform ✅ RESOLVED (principle now, tech at architecture)
**Decision:** Lock the principle, defer the technology to the architecture phase (Claude Code).
- **Principle:** consolidated, coherent persistence — one home for libraries (tournaments / eras /
  parks / models), one for the active working session; the D6 per-account overlays are first-class. No
  replicating today's four-mechanism sprawl (IndexedDB + localStorage + sessionStorage + backend JSON).
- **Deferred to architecture:** the actual storage technology (local vs server, which DB) and whether
  the solver stays Python/HiGHS (works today, no forcing function) or moves in-process.

---

## Decision status — ALL RESOLVED
- **D1** ✅ Two score types (basic direct / wOBA event-based); wOBA pipeline order locked; anchor after
  era/park; 600-PA normalization.
- **D2** ✅ Signed distance from a common baseline (sign-flipped for pitchers); drop the power
  transform; natural H/P balance. *(Cap/slots role/slot weights superseded by the E[wins] usage-weighted
  objective — see the D2 note above.)*
- **D3** ✅ RESOLVED via the bake-off — **raw-poly hitting + StuffAug pitching**, behind the EventModel
  seam; comparison harness retained. *(Was deferred; decided 2026-06-29.)*
- **D4** ✅ Tournament is the single config source; Era + Park reusable libraries by reference; weights
  tournament-scoped; global coeff bag dissolves. *(Softcaps are no longer a tournament feature — the
  raw-poly model replaced them; retirement pending.)*
- **D5** ✅ Keep the value structure; fix quality — principled matching-based defensive feasibility;
  catcher backup = depth constraint. *(Cap/slots: the starters-first decomposition was replaced by a
  single E[wins] MILP — see the D5 note above.)*
- **D6** ✅ Two accounts (not hard-coded); quantity carried, filter `owned>0`; active-account selector
  scopes grid + variants + generation.
- **D7** ✅ Principle locked (consolidated persistence, per-account overlays first-class); storage tech
  + solver placement deferred to architecture.

Discovery + requirements are now closed, and **all of D1–D7 are resolved** (D3 was the last open item —
resolved by the 2026-06-29 bake-off). The one remaining live thread is the weak/extreme-player
overscoring investigation (the Stuff residual), tracked in `docs/REBUILD_ROADMAP.md`. Everything remains
anchored by the single most important principle: **one scoring core, computed once, consumed identically
everywhere.**
