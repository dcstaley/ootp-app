# REBUILD_MATCHUP_CHANNEL_PLAN.md — the native opponent-aware event model

Status: DESIGN (2026-07-13). A D3 bake-off candidate behind the existing `EventModel` seam.
Feeds the build phase that starts once the quicks tier ladder lands (Bronze+Gold soon, full
ladder ~1 week). Companion to `REBUILD_TOURNAMENT_MODEL_PLAN.md` §10 (read §10.2, §10.3, §10.8).

## 0. One-paragraph thesis
Make the event model evaluate each channel at the **matchup coordinate** `x = own_rating −
opponent_pool_mean` rather than at the raw rating (which silently bakes in "opponent = my training
league"). Doing so **natively** re-bases weak/strong pools (subsuming frame-v2's additive opp-gap
shift) and — when the shared shape is fit on data that *sweeps* the matchup coordinate (the quicks
ladder) — carries the correct **off-frame K slope by construction** (subsuming frame-v2's KSpread
`s`). The one structural subtlety (roles share the K *frame/level* but differ in K *slope* — the
reason the naive single shared curve was rejected, §10 item 4) is handled by a **shared shape +
per-role slope** parameterization. K is the priority channel; BB/HR/BIP adopt the same coordinate
channel-by-channel, mostly as level re-basing.

## 1. Where we are (settled — do not relitigate)
- **Tournament bias = opponent-frame effect** (§10.2): correct first-order fix = shift each rating
  additively by the OPPOSING channel's mean gap, channel-crossed `H.eye↔P.con` (BB),
  `H.kRat↔P.stu` (K), `H.pow↔P.hrr` (HR), `H.babip/gap↔P.pbabip` (BIP).
- **frame-v2 shipped** (§10.8, `src/model/pool-transform.ts` `FrameShift`, `KSpread`;
  `src/scoring-core/score-card.ts` call site): additive shift `r + (μ_train_opp − μ_pool_opp)`
  vs the artifact's `trainingMeans`, plus a per-role K spread scale `K_corr = K̄_pool + s·(K_pred
  − K̄_pool)`, `s ≈ 1.75` constant out-of-frame, `s → 1` in-frame. Ramp shape unobservable on
  current data → **deployment gated on quicks**.
- **K under-separation is a frame artifact, not intrinsic** (§10.3 + Open Quicks null test,
  `tools/quicks-levelbias.ts`): in-frame (full pool, gap≈0, neutral env) the K slope ratio ≈ 1.0.
- **Naive shared K curve REJECTED** (§10 item 4): one curve `f(stu−kRat)` on both roles fixed
  cross-role level but forced ONE slope → pitcher off-frame slope improved, hitter got worse,
  league RMSE +21–33%. → A promotable form MUST keep the shared frame but allow **per-role slope**.
- **League data is insufficient for the K slope** (§10 item 5): the true off-frame K spread is
  *steeper* than any curve fittable on league data alone (EG Q1 hitters sit below the league kRat
  support). In-frame collinearity masks the attribution. → the K fix **requires out-of-frame data**.
- The existing `woba·matchupK` bake-off candidate (`src/training/forms.ts`, `fitMatchupK` /
  `matchupHitK` / `matchupPitK`) is precisely the naive single-curve skeleton. It already:
  - fits `f(x)` (rawpoly-2) jointly on both roles' league obs,
  - stores `muStu`/`muKRat` = PA/BF-weighted training opponent means (the reference frame),
  - exposes an **optional opponent-mean override** (`matchupHitK(mk, kRat, muStu = mk.muStu)`) — i.e.
    the hook for native opponent-awareness is already present,
  - consumes the `opp` observations the harness passes to `BakeoffModel.fit` (`bakeoff.ts` /
    `evaluate.ts` already thread the complementary role under the same fold discipline).

## 2. The matchup FORM (deliverable 1)

### 2.1 The coordinate
Per channel, define `x = own − μ_opp` where `μ_opp` is the exposure-weighted mean of the OPPOSING
channel over the reference field (training league in-frame; the tournament pool off-frame):

| channel | hitter x | pitcher x | crossed pair |
|---|---|---|---|
| K   | `μ_stu − kRat`     | `stu − μ_kRat`     | H.kRat ↔ P.stu |
| BB  | `eye − μ_con`      | `con − μ_eye`      | H.eye ↔ P.con |
| HR  | `pow − μ_hrr`      | `hrr − μ_pow`      | H.pow ↔ P.hrr |
| BIP | `babip − μ_pbabip` | `pbabip − μ_babip` | H.babip/gap ↔ P.pbabip |

Evaluating at pool `μ_opp` instead of training `μ_opp` IS the additive opp-gap shift — first-order
identical, but the native curve also gets the *curvature* wrt the opponent right (the additive shift
assumes local linearity).

### 2.2 K first — Form A (RECOMMENDED): shared shape + per-role slope
```
K_pit(stu; μ_kRat)  = K̄_pit + a_pit · ( g(stu − μ_kRat) − ḡ_pit )
K_hit(kRat; μ_stu)  = K̄_hit + a_hit · ( g(μ_stu − kRat) − ḡ_hit )
```
- `g(x)` — the ONE shared shape, rawpoly degree-2 (z-scored raw basis, standard monotone gate),
  fit **jointly** on both roles across the full swept-x data. Keep degree-2: degree-1 loses the
  convexity (hit-K Pearson 0.943 vs 0.955 on the league window), degree-3 / logistic-in-x gave no
  gain (already tested & rejected for `woba·matchupK`).
- `ḡ_role` = exposure-weighted mean of `g(x)` over the role's training obs ⇒ the per-role correction
  is **mean-zero in-frame**, so in-frame K level is byte-equal to a per-role fit (parity-friendly).
- `K̄_role` = role's exposure-weighted mean K/600.
- `a_role` = **per-role slope multiplier** — the fix for item 4. Shared `g` carries the common frame
  and convexity (kills cross-role level/shape inconsistency); `a_pit ≠ a_hit` restores the different
  league slopes the single curve destroyed.

Parameters: shared `β_g` (3 for rawpoly-2) + `{K̄_hit, K̄_pit, a_hit, a_pit}`. This is exactly the
existing `FittedMatchupK` **plus** two role means and two role slopes.

Why this subsumes KSpread `s`: `s` is a patch that scales a *league-fit* curve's too-shallow slope
out-of-frame. Once `g` (and `a_role`) are fit over data that sweeps x into the off-frame range, the
correct steeper slope lives IN the curve at every x → the residual `s` needed on top collapses to
~1.0. We validate that collapse explicitly (§6, metric 5).

### 2.3 K — Form B (secondary, for the full ladder): two-input surface
```
K = c0 + b_s·φ(stu) + b_k·φ(kRat) + b_x·φ(stu)·φ(kRat)     φ = z-scored ln or raw
```
evaluated marginally per role (plug `μ_kRat` for pitchers, `μ_stu` for hitters). `b_s`,`b_k` give
per-role marginal slopes automatically; the cross term `b_x` is the genuine matchup interaction —
identifiable ONLY once the ladder sweeps both inputs. More flexible, more data-hungry; hold until
the full ladder lands, then bake-off A vs B.

### 2.4 BB / HR / BIP — adopt channel-by-channel (StuffAug-style)
Only K under-separates (§10.3); BB/HR/BIP levels are fixed by the additive shift (with λ→1 once the
reference is the training mean, §10.8). So these channels adopt the matchup **coordinate** as pure
level re-basing — `a_role ≡ 1`, just evaluate the existing curve at pool `μ_opp` — which subsumes the
additive `FrameShift` on them without a slope refit. The pitcher **StuffAug** aux (linear `ln(stu)`
on BB/HR) is a *within-role* secondary channel (stuff suppresses walks/homers) — orthogonal to the
opponent coordinate, so it **composes unchanged**: `BB = f_matchup(con − μ_eye) + aux·ln(stu)`.
Adoption order: **K (full Form A) → BB → HR → BIP**, each a self-contained diff.

## 3. Fitting behind the seam WITHOUT breaking one-core (deliverable 2)

### 3.1 Bake-off side (already wired)
Add Form-A entries to `FORM_ENTRIES` (`src/training/forms.ts`). `BakeoffModel.fit(train, opp)`
already receives the complementary role; `evaluate.ts` already folds `opp` with the same key
discipline (`cid|side`) so no two-way leakage. No harness plumbing change for the league fit. New
plumbing (Phase 1): let the fit also accept **off-frame ladder rows** (§4).

### 3.2 Production seam (the real integration)
The `EventModel` seam (`predictHitting(r, c)` / `predictPitching(r, c)`) has **no opponent
argument** and must not gain one (one-core: the grid/optimizer/single/training all call it
identically). The opponent pool mean is a per-**pool** quantity, not per-card — so bind it at model
construction, exactly as frame-v2 binds `FrameShift`/`KSpread` per scoring config:

```
// src/model/matchup.ts (NEW)
makeMatchupModel(form: EventForm & { matchupK: FittedMatchupKA }, oppMeans: PoolOppMeans): EventModel
```
- K (`SO` for hitters, `K` for pitchers) comes from `matchup*K(mk, rating, μ_opp_pool)`.
- Every other channel comes from the existing raw-poly curves (identical `RawHitting`/`RawPitching`
  shape → downstream woba.ts recompute + era/park/anchor layer is byte-unchanged).
- `oppMeans` is computed once per tournament pool via `computeUnifiedFieldStats(...)` — the SAME
  pool-mean path frame-v2 already uses to build its shift. In-frame (production league scoring, no
  tournament) `oppMeans = trainingMeans` ⇒ `x` reproduces the training frame ⇒ scores match a
  per-role fit at the anchor.

`scoreCard` still calls `model.predictHitting(ratings, coeffs)` **once**. The matchup math lives in
ONE place (`curves.ts` eval + `matchup.ts`); the orchestrator only *selects* the model. No scoring
math is duplicated.

### 3.3 Transform-mode selector
Extend the config's transform mode to three values:
- `own` — legacy multiplicative `PoolTransform`.
- `shift` — frame-v2 additive `FrameShift` + `KSpread` (**current default**; stays until matchup
  proves out).
- `matchup` — select `makeMatchupModel`; **disable** `FrameShift`/`KSpread` (identity) because the
  model does the re-basing natively.

`shift` remains production; `matchup` is opt-in behind the selector and the bake-off until validated.

## 4. Data — why league-only fails, what the ladder gives (deliverable 4)
League-only is insufficient because in-frame every observation has `μ_opp ≈ μ_opp_train`, so
`x = own − μ_opp_train` is explored only over the band driven by own-rating variation around a FIXED
opponent. The slope of `g` wrt x is identified only over that narrow in-frame band, where the
realized slope is the SHALLOW one (in-frame collinearity masks attribution, §10.3). The steeper
off-frame slope (EG Q1 hitters below league kRat support) is literally outside the league x-domain.

The **quicks tier ladder** supplies the missing axis, confound-free:
- Multiple tiers (Iron/Bronze/…/Gold/Open) = pools of different mean strength = different `μ_opp` ⇒
  the **opponent axis is swept**. Low tiers cover the below-support K range; gold/open pin the ramp
  toward the in-frame `s→1` limit.
- Within each tier, the full own-rating range.
- **Neutral park + era-2010** (Open Quicks confirmed all era factors ≈ 1.0) ⇒ no env confound; the
  only moving quantity is the matchup coordinate `x`.

How off-frame rows enter the fit: as `opp`-tagged rows carrying their pool's `μ_opp`. Each row
contributes `(x = own − μ_opp_pool, K/600, weight = exposure^0.75)`; league obs contribute at
`μ_opp_train`, each tier's obs at that tier's `μ_opp`. Pipeline: tier CSVs → **ghost-clean**
(`src/eval/tournament-clean.ts`) → per-card aggregate lines → per-tier `μ_opp` via
`computeUnifiedFieldStats` → `MatchupObs` rows. Coordinate with the eval-only tournament ingestion
built separately (neutralize-on-ingest for env; here the env is already neutral).

**Scoped exception, stated explicitly:** tournament data is otherwise **eval-only** (no talent
re-fit). The K-channel shape `g(x)`/`a_role` is the ONE place off-frame rows enter the FIT — because
the K slope is a *structural constant of the matchup*, not a per-card talent re-rating. Nothing else
about talent is learned from tournament data. Gated on quicks.

## 5. Phased build order (deliverable 5)

### Phase 0 — scaffold now (no quicks data)
1. `curves.ts`: generalize `FittedMatchupK → FittedMatchupKA { f, muStu, muKRat, kbarHit,
   kbarPit, gbarHit, gbarPit, aHit, aPit }`; add `matchupRate(mk, role, rating, μ_opp)` = Form A.
2. `forms.ts`: generalize `fitMatchupK` to also fit `{K̄_role, a_role, ḡ_role}`; keep the existing
   `woba·matchupK` (single curve) as a labeled comparison; add `woba·matchupA` to `FORM_ENTRIES`.
   Structure the fit to accept optional off-frame `(x, y, w)` rows (empty in Phase 0 = league-only).
3. `src/model/matchup.ts` (NEW): `makeMatchupModel(form, oppMeans)` implementing `EventModel`
   (K via matchup, rest via raw-poly), returning the unchanged Raw* shapes.
4. `config/types.ts`: `transformMode: "own"|"shift"|"matchup"`, `matchupK?` on the artifact,
   `oppMeans?` (pool) on `ScoringConfig`.
5. `score-card.ts`: on `matchup`, select `makeMatchupModel` and make `FrameShift`/`KSpread` identity.
6. `server.ts`: compute per-tournament pool `oppMeans` (reuse the frame-v2 pool-stat path); persist
   `matchupK` in the trained-model artifact.
7. Tests (`tests/matchup.test.ts`): in-frame equivalence (matchup at `μ_opp_train` ≈ per-role K),
   parity (`transformMode ≠ matchup` ⇒ bit-identical scores), Raw* shape unchanged; extend
   `tests/frame-v2.test.ts` continuity.

### Phase 1 — Bronze + Gold land (~days): first real fit + validation
1. Ingest the two tiers (ghost-clean) → per-tier `μ_opp` → `MatchupObs`.
2. Fit `g` + `a_role` on league + both tiers jointly (WLS, exposure weights) — first fit with off-
   frame slope signal. Add a `tools/matchup-fit.ts` diagnostic (sibling of `tournament-kslope.ts`)
   reporting slope ratios per tier + role.
3. Validate against the §6 metrics; go/no-go on whether the slope is recoverable from 2 tiers.

### Phase 2 — full ladder (~1 week): finalize + deploy decision
1. Refit with all tiers; confirm `g(x)`/`a_role` pin the off-frame slope and the residual KSpread
   `s` collapses to ~1.0 (subsumption confirmed).
2. If matchup dominates `shift` on levels AND slopes AND does not regress league CV/OOT: flip
   production `transformMode → matchup`; keep `FrameShift`/`KSpread` as a dead-but-tested bridge for
   one release, then remove.
3. Adopt BB → HR → BIP matchup re-basing (each `a_role ≈ 1`) to fully retire the additive shift.

## 6. Validation metrics
1. **Per-role K slope ratio** (pred Q5−Q1 spread / actual Q5−Q1 spread) **→ 1.0**, measured BOTH
   in-frame (league holdout + Open Quicks, `tools/quicks-levelbias.ts`) AND out-of-frame
   (Bronze/Gold/EG). Primary target; both roles.
2. **Cross-role level consistency**: at matched `|x|`, pitcher-frame and hitter-frame K agree within
   tolerance (no systematic role offset) — the shared-`g` invariant. This is the item-4 guard.
3. **League RMSE / CV Pearson NOT regressed** vs deployed raw-poly (the other item-4 guard: shared
   `g` must not cost league fit; per-role `a_role` should recover it). Hard gate.
4. **OOT ranking (top-26)**: forward (extrapolate up to new elite cards) + backward (down to
   weak/limited pools) + per-tier tournament ranking. Watch the §10.4 caveat — the own-gap
   multiplicative transform accidentally aided pitcher *ranking* by adding K spread; the matchup
   form must deliver that spread through the correct slope, not regress it.
5. **Subsumption check**: after the native fit, the residual `KSpread s` needed on top ≈ 1.0 and the
   residual additive shift ≈ 0 — quantitative confirmation frame-v2's two hacks are absorbed.

## 7. File touch-points (summary)
- `src/model/curves.ts` — `FittedMatchupKA`, `matchupRate` (Form A eval).
- `src/training/forms.ts` — generalized `fitMatchupK`, off-frame-row-aware fit, `woba·matchupA`
  entry, later BB/HR/BIP matchup channels.
- `src/model/matchup.ts` (NEW) — `makeMatchupModel(form, oppMeans)`: `EventModel` production seam.
- `src/config/types.ts` — `transformMode` third value, `matchupK` artifact field, pool `oppMeans`.
- `src/scoring-core/score-card.ts` — model selection + FrameShift/KSpread identity under `matchup`.
- `src/server/server.ts` — per-tournament pool `oppMeans`; persist `matchupK`.
- `src/eval/` + tournament ingestion — `MatchupObs` builder from ghost-cleaned tier CSVs;
  `tools/matchup-fit.ts` diagnostic.
- `tests/matchup.test.ts`, `tests/frame-v2.test.ts` — equivalence/parity/subsumption guards.
</content>
</invoke>

---

# STATUS 2026-07-25 — THE FORK, as it stands. (Opus 5, with Fable's two amendments.)

**HELD. A live candidate, not buried. Blocker status DOWNGRADED, not lifted.** This section is the
standing statement of the version-3 ("native opponent-aware model") fork; read it before reviving.

## The three versions and where each stands

1. **own-gap — SHIPPED, production** (`data/state/app.json` `transformMode: "own-gap"`). Matchup
   dependence IS live: the spread corrections key off each format's own opposition gap.
2. **frame-v2 — BUILT, TESTED, REJECTED on the value path.** Additive per-channel rating shift by the
   opposing gap. Lost head-to-head: it COMPRESSED hitters, CI-clear. Code present, switched off.
3. **native matchup model — SCAFFOLDED, NEVER FITTED** (`src/model/matchup.ts`, Phase 0 plumbing
   pinned to identity: `tail ≡ 0`, `aRole ≡ 1`). The principled version — evaluate each curve at
   `own − μ_opp` instead of at the raw rating. It stopped because league data cannot identify it
   (in-frame, everyone faces the same opposition; §1 item 5).

## AMENDMENT 1 (Fable) — the payoff is CHANNEL-SPLIT. "Corrections dissolve" oversells by exactly K.

A native matchup model makes predictions opponent-aware, so **it can only absorb corrections whose
driver is the opponent.** Two independent results say the K correction's driver is NOT the opponent:

- **the battery**: the K need is FLAT under every opposition weighting tried — moved < 0.01 across
  three weightings;
- **the (c) report** (`fixtures/cohort-channel-groundtruth-2026-07-23.txt`): realized opposing
  avoid-K is essentially flat iron→gold, while K needs span 1.83 → 1.48.

So the largest, most stubborn correction in the system would survive version 3 **essentially
untouched**. The channels where a native model could genuinely dissolve corrections are **HR and
BABIP** — the ones that responded to realized-field weighting.

⇒ **Version 3 is a candidate source-fix for the HR/BABIP family ONLY** — the same two-family split
that governs everything else in the composition layer. Do not justify it by pointing at the size of
the K correction.

## AMENDMENT 2 (Fable) — the blocker went IMPOSSIBLE → WEAKLY IDENTIFIED. That is a precondition.

The tournament corpus does span a ladder of opposition strengths. But **within any one format every
card faces the same opposition mix** — exposure is degenerate by construction (the reason the
interaction discriminator died: separating the terms needs opposition to move without the value
window moving). So version 3's matchup response would be identified almost entirely from
**cross-format variation: ~14 opposition points, confounded simultaneously with era, composition and
budget structure.**

Fitting small scalar corrections on that support is one thing. **Refitting the core model's response
curves on it is another.**

⇒ **ENTRY GATE: a pre-registered IDENTIFIABILITY PRE-STUDY, with a kill condition, before any build.**
Can the matchup response be pinned from this corpus's actual variation structure, with CIs that
survive the confounds? Cheap, pre-registerable, and the same discipline that saved centerpiece #2. A
version-3 build that skips it risks a month of fitting noise into the model's foundations.

**Data-authority note:** fitting CORE CURVES on tournament data is permitted under the revised
mission, but this would be the strongest use of that permission yet. Say so out loud when the time
comes; do not let it pass as routine.

## AMENDMENT 3 (Derek, 2026-07-25) — the matchup coordinate is single-rating by construction.

Every channel in §2.1 pairs ONE own rating against ONE opposing rating (`kRat ↔ stu`, `eye ↔ con`,
`pow ↔ hrr`, `babip/gap ↔ pbabip`). That is exactly the single-rating trap this project keeps falling
into: **players do not exist in isolation — a low-K pitcher can be terrible or excellent depending on
the rest of his card** ([[rating-shape-not-quality]]). The same property already broke the z-sum
cohort coordinate (whole-vector selection cannot order a design-decoupled single channel).

⇒ Any version-3 design must state how a card's response depends on its rating SHAPE, not just on the
one channel being evaluated. A per-channel matchup coordinate that assumes otherwise inherits the
defect it is meant to fix. This is a design requirement, not a caveat.

## RECONSIDER TRIGGER

After the two in-frame model fixes land (K curve; the Stuff/contact-side under-credit), measure how
much correction actually REMAINS — **per channel family**. Large residual HR/BABIP correction ⇒ the
argument for going native. Residual K correction ⇒ NOT an argument for it (Amendment 1). Entry gate
is the identifiability pre-study regardless.

(end of STATUS 2026-07-25)

---

# STATUS UPDATE 2026-07-25 (later) — AMENDMENT 2's IDENTIFIABILITY OBJECTION IS MATERIALLY WEAKENED.

Evidence: `fixtures/REFUTATION-kcurve-hand-2026-07-25.txt` (independent-skeptic run; harness
`tools/refute-kcurve-hand.ts`). Measurement only, nothing fit.

**What was found.** `predictPitching` carries NO opponent term. Within LEAGUE data, same-side matchups
face batters averaging **−6.37 avoid-K rating points** weaker than opposite-side ones. The deployed
model's K residual tracks that composition at a fitted **+0.842 K/600 per opposing rating point —
1.14× what the model's own hitter K curve prices a rating point at**, correlation +0.80 across
seasons, same sign in **33/33 league-seasons**. That is the missing opponent term, at full size,
measured in-frame.

**Why it changes the fork.** AMENDMENT 2 held that a version-3 matchup response would be identified
"almost entirely from cross-format variation: ~14 opposition points, confounded simultaneously with
era, composition and budget structure," and set a pre-registered identifiability study as the entry
gate. That objection was about the TOURNAMENT identification route. **A LEAGUE-DATA identification
route now exists** — the same-side/opposite-side platoon contrast supplies abundant within-league
variation in opposing quality, with no era/budget/pool confound, and it yields a direct estimate of
the opponent response. The entry gate is not removed, but its hardest premise no longer holds for the
K channel.

**No contradiction with AMENDMENT 1.** Amendment 1 says the K CORRECTION's driver is not the opponent,
on the battery (K need flat under every opposition weighting) and the (c) report (realized opposing
avoid-K flat iron→gold). Those concern TOURNAMENT opposition across formats. This concerns WITHIN-
LEAGUE platoon matchup opposition. Both hold. The consequence is that an opponent term is a MODEL
(source) fix identified in-frame, whose effect on the tournament K correction must then be re-measured
— it is not licensed by, and does not license, the tournament-side claims.

**Consequences for the K curve work (all of it in-frame):**
- **Hand-conditioning is REJECTED** — on mechanism (Derek: the engine computes from ratings; the
  platoon difference is already carried by the hand-split ratings, and no mechanism makes the
  rating→outcome CONVERSION hand-dependent), and independently on the numbers (removing composition
  erases 98% of the vR−vL cubic gap, −1.0668 → −0.0175, p=0.770; hand-conditioning also predicts
  WORSE on both card-based folds after correction).
- **The hand LEVEL gap is dead** (p=0.481 on the wide window) — already withdrawn from the sweep prereg.
- **The pooled cubic is ATTENUATED, not contaminated**: −0.4983 (CI covers 0) → −0.5999 CI-clear once
  the matchup-cell level is removed. Composition was MASKING it. But it rests on ~**10 effective
  cards** (Kish ESS over cards = 9.9 of 70; Kimbrel alone 26%), and a CUBIC is not established as the
  form (a quartic beats it on all three CVs; trimming |z|≤1.75 cuts it 54%). Only "higher-order than
  quadratic, in the tails" is established.
- **First-best fix = the OPPONENT TERM, not a curve term.** Composition is 54% of the entire K
  residual. Fitting curve shape before the opponent term would fit the curve to absorb the opponent's
  absence — the exact confounding pattern this program is trying to get out of.

**Method corrections this run forced, worth carrying:** (1) the earlier "out-of-time replication"
(in-sample −0.869 vs OOS −0.862) is largely ARITHMETIC — the same cards on both sides over 99% shared
BF, card×arm residuals correlating r=0.94, so 0.8% agreement is the NULL not the finding; (2) the
vR−vL cubic p=0.034 was one of FOUR coefficient contrasts (the LINEAR contrast was larger, p=0.011);
Šidák-corrected the cubic is **p=0.130**.

**AMENDMENT 3 (rating shape) still binds** and now bites harder: any opponent term must not assume a
card's response is a function of one rating against one opposing rating.

(end of STATUS UPDATE 2026-07-25 later)
