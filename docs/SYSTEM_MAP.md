# SYSTEM MAP — how the scoring system composes (read before designing ANY measurement)

Written 2026-07-26 (Fable) after an Opus session correctly reported it could name every piece
but not explain how they compose. This is the teaching document. FORMAT_FACTS.md is its
companion (per-format instances). The batch record (memory) is archival history — do not
try to hold it; hold THIS.

## 1. The pipeline, in application order (and what couples to what)

```
raw ratings (per card, per side)
  → POOL TRANSFORM (own-gap faded mean-scalar: lifts a weak pool's ratings toward the
    league frame; identity in-frame; ceiling-faded so elite ratings barely move)
  → EVENT MODEL (the fitted curves: rating → per-600 events, per channel, ONE-SIDED —
    no opponent input; fit on league data ⇒ predictions are conditional on league-average
    opposition BY CONSTRUCTION)
  → SPREAD CORRECTIONS, PRE-BIP (K ramp, HR ramp: rescale predicted K/HR about the pool
    mean by s(gap); hitter tail: stretch HR/BABIP/SO extremes, gap-conditioned; all are
    zero-mean-ish, in-frame-identity constructions)
  → BIP RECOMPUTE:  BIP = 600 − BB − K − HR − BIP_ADJ;  hits = BIP × hit-rate;
    XBH = share of non-HR hits.  ANY change to BB/K/HR changes BIP changes hits.
    A hit-RATE correction must ride the rate multiplier (hMul) or the recompute discards it.
  → ERA / PARK (event-space multipliers on rates; era_h is PER-BIP grain, not per-PA;
    park factors are COMPRESSED (cp=0.26) and exist only for avg/hr/gap — K and BB have
    NO park factor anywhere, in our model or the sim)
  → wOBA ASSEMBLY (event weights; + baserunning terms; + ssp)
  → CALIBRATION / ANCHOR (per tournament: pins the pool's top-N mean to a fixed target)
  → value / optimizer
```

Non-commuting facts that have bitten real work: spread corrections are deliberately PRE-BIP
and PRE-ERA (so hits recompute consistently and era scales corrected rates); the pool
transform passes ratings through NONLINEAR curves (lift interacts with curvature); the gap's
two legs must share every convention (cohort rule, N, variant policy) or the gap is
biased BY CONSTRUCTION (this failure has occurred; see §3).

## 2. The anchor — what it absorbs and why "level = convention"

Per tournament, calibration rescales the pool's scores so the pool's anchor cohort hits a
fixed target. Consequences:
- Any error that shifts EVERY card in a pool equally (a uniform level bias) is removed by
  the anchor automatically. Correcting it upstream is redundant and risks double-correction.
  Within a tournament only RELATIVE order/spacing matters; across tournaments the anchor
  restores comparability. THIS is why level biases (e.g. pit BB9 +0.86/9 everywhere) are
  "conventions" — confirmed empirically 2026-07-23 (flat slope on the driving rating).
- The anchor CANNOT fix: rank order, relative spacing, or any bias CORRELATED WITH A CARD
  PROPERTY (a Stuff-sloped bias is invisible to a mean-pinning operation). That is why
  spread/shape corrections are legitimate and live upstream, and why the anchor-uniformity
  audit regresses bias on the driving rating: flat slope ⇒ absorbed; sloped ⇒ real defect.
- Corrections are built "anchor-neutral" (zero-mean about the pool) so they change spacing
  without fighting the anchor's level-pinning.

## 3. The gap coordinate — what it is, honestly

For each channel the "gap" = (league training frame mean) − (pool cohort mean) on the
OPPOSING crossed channel (your K vs their Avoid-K: pit.stu↔hit.kRat, con↔eye, hrr↔pow,
pbabip↔babip). Both cohorts are top-FIELD_N=50, currently selected by model-predicted wOBA
("model-woba" rule).

- The LEVEL logic is first-principles: the model predicts vs league-average opposition;
  opposition in a pool differs; shift by the difference (frame shift).
- The SPREAD logic is EMPIRICAL, NOT DERIVED: in weak pools observed spread exceeds
  predicted, and the needed amplification happened to grow with the gap on the quick
  ladder. THE MECHANISM IS UNKNOWN (this is the program's central open fact). The gap is a
  PROXY coordinate: its virtues are consistency, spread across formats, and ex-ante
  computability — NOT truth. s(g≤0)=1 is the one principled part: in-frame the model is
  calibrated by construction, so zero distance ⇒ zero correction.
- MEASURED LIMITS of the proxy: (a) it is model-dependent (the cohort rule; retrains move
  it — "managed drift": every retrain forces a visible K/HR recalibration via tag
  assertions); (b) for K it is a TIER-INDEX IN DISGUISE (realized opposing Avoid-K is
  nearly FLAT iron→gold while K needs vary hugely — the K need is NOT opposition-driven;
  battery + (c)-report, twice-proven); (c) it reads ONE channel, so pools whose rating
  SHAPE decouples that channel from overall quality break it (live pools: elite overall,
  floor Avoid-K by modern-meta design ⇒ g≈44 vs measured need ≈1 ⇒ the flat-hold clamp
  above gMax=22.25 and a published residual). A "correct" coordinate per channel family:
  HR/BABIP-class (opposition-responsive) → an EX-ANTE PREDICTOR OF THE REALIZED FIELD
  (real play is a mass of moderately-rated cards, 10–17 pts below any top-50); K-class →
  pitcher-side pool composition (cause unknown; coordinate undesignable until it isn't).
  Four constraints any future coordinate must satisfy: data-fixed / per-channel
  identifiable / shape-aware / ex-ante. No single-cohort single-channel-mean satisfies all.

## 4. Pool / tier / window / composition — the clean separation

- WINDOW: the card-value eligibility RULE (min/max) in a tournament config. Bare tier name
  = quick window with game floor 40 (bronze 40–69, silver ≤79, gold ≤89, diamond ≤99).
  Tiers are ALWAYS nested, by game design.
- POOL: the SET of eligible cards right now = window + card-cut rules applied to the
  current catalog. Grows/changes as cards release.
- TIER: a NAME for the standard window family. Never a modeling input (identity).
- COMPOSITION: the DISTRIBUTION of the pool's card attributes — rating shapes, joint
  structure — beyond level. Two pools with IDENTICAL windows can have wildly different
  composition (live-bronze vs bronze-quick: same 40–69, disjoint populations).
- REALIZED composition/deployment: who actually PLAYS and how much (usage) — shaped by
  budget rules (caps/slots force weak cards into lineups) and ownership. Ex-post; any
  shipped rule needs an ex-ante predictor of it.

## 5. Tier confound and identification (the answer is (b))

On the quick ladder, tier ↔ window ↔ pool-property are confounded BY DESIGN. That is fine
for INTERPOLATION within the ladder (the ramp works there no matter which confounded thing
is causal) and provably unsafe for EXTRAPOLATION (live pools, the gold history). The
doctrine "no tier identity" is about the FORM of a rule: corrections must be functions of
measurable properties evaluated per pool, so when the confound breaks, the correction
follows the property, not the name. IDENTIFYING which property is causal requires
window-matched, population-different contrasts — the live tiers (same windows as quicks,
different card population) are THE identification instrument. This is why live-tier
captures are prioritized.

## 6. The three layers, mechanically

Same machinery class (property-conditioned adjustments in the one pipeline), different
coordinate SOURCES:
- ERA layer: coordinate = the era's factor VALUES from config (exact, known). Known open
  defect: era_k compresses predicted K spread in extreme eras (EG 1.53 / BH 1.64 / LB G2);
  fix shape = spread scale as a function of factor values. Stratum B.
- COMPOSITION layer: coordinate = measured properties of the eligible pool's rating
  distribution (catalog, ex-ante; e.g. channel-decoupling). Owns: gold K residual,
  live-pool residual, hitter-tail redesign. Stratum C (with deployment).
- DEPLOYMENT layer: coordinate = format budget RULES (cap tightness, slot structure).
  Phenomenon: budget formats run hot at matched gap (who-plays reaches deep). Stratum C.
Strata doctrine: a defect attributes to the FIRST stratum it appears in (A = neutral
quicks = core; B = env dailies; C = budget/restricted).

## 7. Standing verdicts a session must not re-litigate accidentally

(Full history in the batch record; these are the load-bearing ones.)
- Event model is CLOSED IN-FRAME: production is AT its measured ceiling (~0.78); opponent
  term dead at correct grain; hand-K withdrawn; EYE axis declined (six-leg cancelling set;
  sign sorts by fit window); shape-level correction failed identification+concentration;
  minPA=1000/window near-optimal (relaxing WIDENS intervals). Remaining reachable error =
  era + composition/deployment layers on tournament data.
- Per-event cancellation is the RULE (0/9 in-frame CI-clear composite nets). A channel fix
  is judged on the COMPOSITE; a cancelling set cannot be partially closed.
- stuffAug: VALIDATED, keep. Chaining plausible; cross-channel aux terms are not
  automatically artifacts.
- pit BABIP heterogeneity: DOES NOT EXIST (I²=0; tier CIs intersect [1.05,1.41]). The old
  "bronze 1.48 vs silver/gold 1.0" was a POINT-ESTIMATE over-read. What may exist: a
  modest COMMON under-spread — a flat scalar is the candidate, fit only post-pull.
- Six published residuals, tracked with gold semantics (re-measured every sweep; CI-clear
  growth blocks). Ledger discipline: a 7th requires an explicit STOP; residual = a
  CHARACTERISED defect we choose to carry, never "measured-and-not-identified".
- Data authority: Derek's league exports = fitting truth for league; cwhit RAW observed =
  tournament truth; cwhit projections/derived cols = benchmark opponent, weight zero.
  Current captures (ending ~07-19) are valid for MEASUREMENT; NO fit may use them until
  the wide re-pull (Derek's action).
- Rating-shape doctrine: NEVER infer card quality from one rating. Game meta-economy NEVER
  enters modeling. Derek's config edits are never questioned. No tier/type identity rules.
- Gates are FROZEN; failures resolve by STOPPING. Instrument defects masquerade as model
  findings — when two analyses share an anomaly, check the shared instrument first
  (§15.8: six exhibits and counting).
