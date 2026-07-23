// Rating-space pool-strength transform — a mean-scalar lift, faded BEFORE the trained max,
// with a HARD CEILING at the trained max + a small buffer.
// Re-bases a weaker tournament pool's ratings UP toward the league reference frame (the frame
// the model trained in), but shuts the lift off as a rating approaches the model's trained max
// — so mid-tier cards play up, near-max cards barely move, and above-buffer cards are left as-is.
// Per (rating, side), with trained ceiling C and buffer B (=MAX_BUFFER):
//
//     effective = min( r · (1 + (k−1)·σ((C·(1−CENTER_FRAC) − r)/w)),  C + B )   for r < C + B
//     effective = r                                                              for r ≥ C + B
//     (σ = logistic, k = leagueμ / poolμ)
//
// Shape of the LIFT (gap = effective − r):
//   • BULK (r well below C): σ ≈ 1 → effective ≈ r·k — the full mean-scalar lift.
//   • The fade is CENTERED BELOW C (by CENTER_FRAC·C), so the lift is already shrinking a good
//     way before the max and is nearly gone by it — an AGGRESSIVE taper (140 lifts less than 130).
//   • HARD CEILING: nothing is lifted past C + B. A rating at/above C + B keeps its raw value
//     (a diamond eye 230 on a 200-ceiling stays 230). Because the cap == the identity threshold,
//     the curve is monotone (no jump at the boundary).
//   • k ≤ 1 (unrestricted/stronger pool) ⇒ lift ≤ 0, faded the same way.
//
// Why mean-scalar (vs z-score): anchored at 0 → true lows survive (a 1-rating stays ~1) and
// relative spacing is preserved → genuinely-best cards keep their lead. A config without a
// poolTransform applies nothing → identity (no scaling).

// Shared BIP-chain constant (curves.ts, import-free) for applyPitSpread below.
import { PIT_BIP_ADJ } from "./curves.ts";

export interface RatingStats { mu: number; sd: number }

/** Mean/sd over positive rating values (0 = "no rating for this card-side", excluded). */
export function ratingStats(values: number[]): RatingStats {
  const v = values.filter((x) => x > 0);
  if (!v.length) return { mu: 0, sd: 1 };
  const mu = v.reduce((s, x) => s + x, 0) / v.length;
  const sd = Math.sqrt(v.reduce((s, x) => s + (x - mu) ** 2, 0) / v.length) || 1;
  return { mu, sd };
}

// Fade STEEPNESS as a fraction of the ceiling (how sharply the lift tapers). Small ⇒ a
// tight, aggressive fade. The monotone guard below widens it only when the lift k is large.
export const DECAY_FRAC = 0.06;
// Fade is CENTERED this fraction of the ceiling BELOW the trained max, so the lift is already
// diminishing well before the max and is nearly gone by it (not merely half, as before).
export const CENTER_FRAC = 0.12;
// A sub-max rating may be lifted at most this many points past the trained max (a small
// buffer); a rating already at/above the trained max keeps its raw value (never lifted).
export const MAX_BUFFER = 5;
/** Numerically-stable logistic σ(z) = 1/(1+e^−z). */
export const logistic = (z: number) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

// Per-rating map: scale `k`, trained ceiling `c` (where the lift fades), fade width `w`. (Name
// kept for call-site stability; it is no longer an affine — it's the faded mean-scalar above.)
export interface RatingAffine { k: number; c: number; w: number }

/** Build the faded mean-scalar that lifts the POOL toward the LEAGUE, the lift tapering around
 *  the trained ceiling C. `w` is widened with k so the effective curve stays monotone. */
export function affineFor(league: RatingStats, pool: RatingStats, ceiling: number): RatingAffine {
  const k = pool.mu > 1e-9 ? league.mu / pool.mu : 1;
  // Monotone guard: a deeper lift (bigger |k−1|) needs a wider fade or the curve can turn over.
  const w = Number.isFinite(ceiling) ? Math.max(ceiling * DECAY_FRAC, Math.abs(k - 1) * ceiling * 0.35) : Infinity;
  return { k, c: ceiling, w };
}

/** Apply a map to a raw rating (faded mean-scalar with a hard ceiling):
 *   • r AT or ABOVE C + buffer → keep the raw rating (already past the buffer; untouched).
 *   • r BELOW C + buffer → mean-scalar lift r·k, faded by a logistic centered BELOW C (so the
 *     lift is diminishing well before the max and aggressively near it), then HARD-CAPPED at
 *     C + buffer — so a rating just under the max (or just over it) can be nudged up to the
 *     buffer but no further. The cap == the identity threshold ⇒ the curve stays monotone.
 *  No ceiling ⇒ pure scalar. Absent map ⇒ identity (parity). Clamped ≥ 0. */
export const applyAffine = (r: number, m: RatingAffine | undefined) => {
  if (!m) return r;
  if (!Number.isFinite(m.c) || !(m.w > 0)) return Math.max(0, r * m.k); // no ceiling → pure scalar
  if (r >= m.c + MAX_BUFFER) return r;                                  // at/above max+buffer: keep raw
  const center = m.c * (1 - CENTER_FRAC);                               // fade midpoint, below the max
  const fade = logistic((center - r) / m.w);                           // ~1 well below C → ~0 by C (aggressive)
  const lifted = r * (1 + (m.k - 1) * fade);
  return Math.min(Math.max(0, lifted), m.c + MAX_BUFFER);              // cap at trained max + buffer
};

// The rating-driven inputs the transform covers, per role (speed/steal/run — a minor
// advanced-bonus term — are left raw for now; flagged for a later pass).
export const HIT_RATINGS = ["eye", "pow", "kRat", "babip", "gap"] as const;
export const PIT_RATINGS = ["con", "stu", "pbabip", "hrr"] as const;
export type HitRating = (typeof HIT_RATINGS)[number];
export type PitRating = (typeof PIT_RATINGS)[number];

// Per-rating training maxima (where the lift fades), per role. Computed at model-build time
// from the qualifying training obs and stored on the artifact, so the envelope tracks the
// model. Pooled over sides (curves are fit on both sides' values together).
export interface RatingEnvelope { hit: Record<string, number>; pit: Record<string, number> }

// ── Frame-correction v2 (additive, channel-crossed opponent-gap shift) ─────────
// The model predicts each card's line vs its TRAINING opposition; in a weak pool everyone
// faces weak opposition. The first-order re-basing (plan §10.2/§10.8) shifts each rating
// ADDITIVELY by the OPPOSING channel's mean gap (μ_train − μ_pool), crossing the matchup
// channels (H.eye↔P.con, H.kRat↔P.stu, H.pow↔P.hrr, H.babip/gap↔P.pbabip). This SUPERSEDES
// the own-gap multiplicative PoolTransform when a `trainingMeans`-bearing model is active.
//
// Per-channel PA/BF-weighted TRAINING opponent means — the model's true reference frame
// (NOT the catalog top-50 field; measured to differ by up to +16 on hit.eye). Stored on the
// artifact like RatingEnvelope, pooled over sides.
export interface TrainingMeans { hit: Record<string, number>; pit: Record<string, number> }

// The additive shift, per role × platoon side × channel (a plain rating delta). Side-unified
// at build time (vR === vL, matching the side-unified pool field), but carried per side so the
// score-card call site is symmetric with PoolTransform. Absent channel ⇒ 0 (identity).
export interface FrameShift {
  hit: { vR: Partial<Record<HitRating, number>>; vL: Partial<Record<HitRating, number>> };
  pit: { vR: Partial<Record<PitRating, number>>; vL: Partial<Record<PitRating, number>> };
}

/** Apply an additive frame shift to a raw rating (clamped ≥ 0, matching applyAffine).
 *  Absent delta ⇒ identity (parity: an unshifted / in-frame channel is untouched). */
export const applyFrameShift = (r: number, d: number | undefined) => (d ? Math.max(0, r + d) : r);

/**
 * K-spread rescale about the pool mean (frame-v2, §10.8d): the ONE copy of the transform
 * `K_corr = max(0, mean + s·(K − mean))`. Applied to raw predicted K (hitting `SO` / pitching `K`)
 * BEFORE the BIP chain so `era_k` applies once. Scalar (no KSpread type import — config/types.ts
 * imports FROM this module, so the coupling can only go one way).
 */
export const applyKSpread = (k: number, mean: number, s: number): number =>
  (s === 1 ? Math.max(0, k) : Math.max(0, mean + s * (k - mean)));
// s === 1 short-circuits to the raw K EXACTLY (not `mean + (k − mean)`, which can differ in the
// last ulp) — the in-frame identity guarantee "s → 1 ⇒ bit-identical scores" is a test invariant.

/** The pitcher per-channel spread fields carried on `KSpread` (config/types.ts imports FROM this
 *  module, so the structural subset is declared here — same reason applyKSpread is scalar-typed).
 *  All optional fields absent ⇒ the K-only behavior, bit-identical to the pre-BUILD-3 seam. */
export interface PitSpreadFields {
  sPit: number; meanPit: number;
  sPitHr?: number; meanPitHr?: number;
  sPitBab?: number; meanPitBab?: number;
}

/**
 * BUILD-3 — apply the pitcher spread corrections to one side's raw pitching events, IN PLACE:
 * the ONE copy of the order of operations (score-card.ts, calibrate.ts and the eval line all call
 * this; the fit tool judges these exact semantics).
 *   1. K about K̄_pool (the shipped BUILD-1 ramp) — bit-identical to the old inline applyKSpread;
 *   2. HR about HR̄_pool (raw pre-era per-600; era_effective_hr/park multiply downstream, once —
 *      the same pre-era placement as K, whose era_k applies downstream);
 *   3. BABIP measured on the ORIGINAL BIP, pivoted about BAB̄_pool, clamped to [0, 0.6]; the rate
 *      move rides `e.hMul` (pitchingComponents re-derives nHH from the rating and would discard a
 *      count-only change — the RawHitting.hMul lesson), and nHH/XBH are rescaled mix-preserving on
 *      the NEW BIP so the raw stored-column assembly stays consistent (more K/HR cost hits).
 * Every leg with s = 1 (or absent) is an EXACT identity (applyKSpread short-circuit).
 */
export function applyPitSpread(
  e: { BB: number; K: number; HR: number; nHH: number; XBH: number; hMul?: number },
  s: PitSpreadFields,
): void {
  const bip0 = Math.max(600 - e.BB - e.K - e.HR - PIT_BIP_ADJ, 1);
  const bab0 = e.nHH / bip0;
  e.K = applyKSpread(e.K, s.meanPit, s.sPit);
  const sHr = s.sPitHr ?? 1;
  if (sHr !== 1) e.HR = applyKSpread(e.HR, s.meanPitHr ?? 0, sHr);
  const sBab = s.sPitBab ?? 1;
  if (sBab !== 1 && bab0 > 1e-9) {
    const bab2 = Math.min(applyKSpread(bab0, s.meanPitBab ?? 0, sBab), 0.6);
    if (bab2 !== bab0) {
      e.hMul = (e.hMul ?? 1) * (bab2 / bab0);
      const bip2 = Math.max(600 - e.BB - e.K - e.HR - PIT_BIP_ADJ, 1);
      const scale = e.nHH > 1e-9 ? (bab2 * bip2) / e.nHH : 1;
      e.nHH *= scale;
      e.XBH *= scale; // fixed share preserved
    }
  }
}

// ── Pitcher K-spread ramp (own-gap path; PRODUCTION, on by default) ─────────────
// ORIGINAL FIT PROVENANCE (2026-07-16, tools/fit-kspread-pit.ts; results doc
// docs/CWHIT_KSPREAD_PIT_2026-07-16.md; Derek ruled 2026-07-17: ship on-by-default), fitted under
// model league-41-42: per-tier cwhit K9 calibration slopes (iron 1.90 / bronze 1.70 / silver 1.51 /
// gold 1.43 at stu-gaps 27.7/25.7/22.5/19.3), precision-weighted; s(0)=1 hard — league in-frame K is
// already calibrated (insample-frame-check), so the amplification is a tournament-frame parameter by
// construction. G is identified only as a LOWER BOUND over the observed gap range (g≈19–28 is
// near-linear, β≈0.0287/pt); A/G pinned by rule at the most-saturating member within 5% of the
// linear-limit SSE. Held-out bronze: predicted 1.77 [1.64,1.87] vs measured 1.70 [1.60,1.80].
// Old values were { A: 9.5394, G: 319 }.
//
// ── DATED PARAMETER REFRESH — 2026-07-21, refit under model league-42-43 ─────────
// (tools/fit-kspread-pit.ts; fixtures/kspread-refit-run-2026-07-21-league-42-43.txt; Fable ruled:
// refit + model ship as ONE unit.) Gate records are NOT re-opened; this is a refresh, not a re-fit
// of the design.
//
// COMPARE ramps on β, NEVER on raw {A,G} — this is now the standing convention. G is only
// lower-bounded (SSE within 5% of the linear limit for G ∈ [152.5, 400+]), so a G point value is a
// PINNING-RULE OUTCOME, not an estimate; only s over the observed gap range is measured.
// β, each ramp over ITS OWN observed gaps: old {9.5394,319} = 0.0278/pt (19.3–27.7)
//                                          new {5.0871,152.5} = 0.0293/pt (15.9–23.6)   ⇒ +5.4%
// At MATCHED gaps the new ramp delivers uniformly MORE correction: +0.040 at g=16 rising to +0.052
// at g=28. The OLD deployed A=9.5394 sits INSIDE the refit CI [0.947, 9.666] ⇒ WINDOW-COHERENT by
// the ruling's criterion.
// CAUTION, learned the hard way: do NOT compare against a run's LINEAR-LIMIT figure (this run's was
// 0.0310). That is a different member of the within-5%-SSE family (G→∞), not the pinned ramp. The
// first draft of this comment mixed the two and claimed "+8%"; the regression pin in
// tests/kspread-pit.test.ts caught it.
//
// THE +5.4% IS A COORDINATE TAX, NOT A CHANGE IN THE WORLD. Measured per-tier slopes barely moved
// (iron 1.90→1.86, bronze 1.70→1.65, silver 1.51→1.46, gold 1.43→1.39; −2..−3%) while the GAPS
// moved a lot (27.7→23.6, 25.7→22.8, 22.5→20.5, 19.3→15.9; −13..−18%). β had to steepen to deliver
// the same correction over a shorter gap range. Cause traced in tools/kramp-gap-trace.ts (commit
// c0e9f78): g = train.hit.kRat − pool.hit.kRat, and BOTH sides are top-FIELD_N cohorts selected by
// the model's OWN predicted wOBA — so g is a property of (league, pool, MODEL), and a new artifact
// reshuffles it. The pool side moved +3.17 on an IDENTICAL catalog (64% of the shrink); the league
// side moved −1.76 because kRat is the one hitter channel that fell while the frame otherwise rose.
// ⇒ Cohort-rule arbitration MUST LAND before the 43-44 retrain; this refresh visibly paid the tax.
//
// Held-out bronze (refit): predicted 1.74 [1.60,1.86] vs measured 1.65 [1.56,1.76] — PASS.
// Hitter identity check: bit-identical (max |Δ| = 0).
//
// GATE OVERRULES ON THIS RAMP (both dated, both standing):
//  · GOLD-QUICK G2 — overruled by Derek 2026-07-17. Thin pre-declared cell (N=15), non-replicating
//    at matched gap in gold-cap daily, instrument-inherent per the oracle-s test. Still FAILs on the
//    2026-07-21 refit (Δcorr −0.134 [−0.316,−0.021]) while gold-cap daily at the SAME gap 15.9 reads
//    −0.0057 ns. Prior overrule STANDS.
//  · SILVER G1 — overruled by Fable 2026-07-21. Grounds: the same documented +0.14–0.15 thin-cell
//    overshoot accepted at BUILD-1 shipping; a 0.02 boundary crossing at N=22 (orig 0.91 [0.64,1.02]
//    PASS → refit 0.89 [0.62,1.00] FAIL); no new mechanism; and the cell already sits under the open
//    truncation-diagnostic question. CONDITION: the silver cell gets a FORMAL RE-READ when deeper
//    silver/gold captures land — a CI-clear overshoot on deeper data RE-OPENS the ramp's tier response.
//  · EG / Bronze-Heart weird-env K9 FAILs (post 1.51 / 1.46) remain the RECORDED TASK-1 RESIDUAL
//    (era_k over-compresses at extreme eras) — not a defect of this ramp.
//
// ══ 2026-07-22 CONSTANTS EVENT — C3. THE FAMILY CHANGED; EVERYTHING ABOVE IS SUPERSEDED. ══
// Spec: docs/CWHIT_C3_RAMP_PREREG_2026-07-22.md + amendments 1, 2, 3 (all approved pre-fit except
// amendment 3, which rules on a STOP the fit itself raised). Fit artifact, quoted by name because a
// constant with no reproducible run behind it is the defect this program keeps paying for:
// fixtures/cwhit-c3-ramp-fit-a2-2026-07-22.txt (tools/fit-kspread-c3.ts).
//
// THE SATURATING FAMILY 1 + A(1 − e^(−g/G)) IS RETIRED AS FALSIFIED. It is concave for every (A, G)
// and the coherent tiers' needs are CONVEX in gap, so it could not reach them: at its last fit it
// over-corrected diamond (s 1.335 against a need of ~1.04) and that was a standing G1 failure, not
// noise. The replacement is the minimal convex-CAPABLE monotone form, with the linear limit as an
// interior point:
//         s(g) = 1 + A·(g/G0)^q       q > 1 convex · q = 1 linear · q < 1 saturating
// G0 = 20 is a FIXED reference gap, not a parameter — it only fixes the units of A, so A = s(20) − 1.
//
// WHAT THE FIT ESTIMATES, AND WHY THE PREVIOUS ONE DID NOT (ruling (z)). The objective is per-card
// residuals, per-card noise weights, and A PER-TIER FREE LEVEL. The previous objective took its
// residual about K̄_pool, and because the judged sample sits off K̄_pool it priced LEVEL as well as
// SPREAD: its estimand sat +0.18 above the free slope the gates score against, in every tier, same
// sign. Level belongs to the ANCHOR layer, never to s. With a free level the pivot is unidentified
// and s is a pure spread response; the remaining fit-vs-gate difference is weighting only (+0.03,
// inside every need's own CI). Under the retired objective this same family and selection rule
// deliver 0 of 4 tiers inside CI with diamond out — the level conflation WAS the defect.
//
// GATES (all on the post-C1/C2' coordinate, at fit-p = 0.30, re-checked at 0.25 and 0.35):
//   iron    s 1.862 vs need 1.80 [1.70,1.90]   IN      bronze  1.642 vs 1.62 [1.54,1.69]   IN
//   silver  s 1.486 vs need 1.47 [1.37,1.56]   IN      diamond 1.136 vs 1.04 [0.80,1.27]   IN
//   4 of 4 coherent tiers inside, DIAMOND IN — the standing G1 diamond failure is RESOLVED.
//   Identifiability PASS · equivalence set interior PASS · leave-one-tier-out (deliverable space)
//   PASS · monotone PASS · whole verdict reproduces at p = 0.25 and 0.35.
//
// SELECTION IS IN DELIVERABLE SPACE, NOT SSE SPACE (ruling (x)). The old "most-saturating member
// within 5% of the linear-limit SSE" rule was calibrated on a TIER-AGGREGATE SSE; against a per-card
// SSE dominated by sampling noise its band spanned the whole grid and ran to the edge. Two
// candidates are now equal iff the acceptance instrument cannot tell them apart —
// max over fitted tiers |s₁(g_t) − s₂(g_t)|/se_t ≤ 1 — and the shipped point is that set's MINIMAX
// CENTRE. THE EQUIVALENCE SET TRAVELS WITH THE CONSTANT AS ITS HONEST PRECISION:
//         q ∈ [1.76, 3.04]   129 of 796 grid points   contiguous, interior   1.99 need-SEs wide
// Compare ramps on s(g) over the observed range, NEVER on raw {A, q} — those are selection outcomes.
//
// GOLD IS FITTED OUT, AND ITS RESIDUAL IS PUBLISHED (ruling (y)). Gold at gap 15.02 needs 1.78,
// ABOVE silver's 1.47 at the HIGHER gap 17.53: gold's need is NON-MONOTONE in this coordinate, so no
// monotone s(g) can carry gold and the coherent four at once. Including it flattens the family to
// q = 1.00 and ejects diamond — one tier bought at the cost of four.
//   PUBLISHED RESIDUAL #1 — gold: need 1.78 vs s(15.02) = 1.34 ⇒ +0.449 [0.24, 0.63].
// Assigned to the COMPOSITION/COHORT axis (task 2). The five named light-usage gold cards (Radke,
// Randy Jones, Hilton Smith, Barnes, Quisenberry) are PROVENANCE, NOT CAUSE: noise-weighting them
// down by their own evidential mass barely moves gold's need.
//
// ══ THE DOMAIN RULE (amendment 3) — WHY THIS RAMP IS FLAT ABOVE gMax ══
// A convex form is UNBOUNDED above, and the fit was measured over gaps 10.31–22.25 only. Re-derived
// over PRODUCTION's 46 configured tournaments (not the 14 captured formats): 11 sit ABOVE that
// range, 8 of them live-pool formats at g = 41–44.5 where the unclamped fit returns s = 4.8–5.5.
// THE MEASURED NEED THERE IS ~1 — live-open-daily's PRE slope is 0.91 [0.69,1.08], CI covering 1,
// i.e. already calibrated UNCORRECTED, and the unclamped s drives it to 0.16. Tangent-linear
// extension (s ≈ 3.9) is refuted by the same measurement.
// GOAL OF THE RULE, stated with it: THE RAMP MUST NEVER ASSERT MORE CORRECTION THAN THE FIT
// OBSERVED. gMax is not a safety margin — it is the largest gap the fit was measured at.
//   PUBLISHED RESIDUAL #2 — live pools: flat hold gives s = 1.862 at g ≈ 44 against a need of ~1.0
//   ⇒ ≈ +0.86. Also COMPOSITION/COHORT axis. Better than today, still wrong, and not called a fix.
// STANDING DEFECT EXPOSED, not created: the retired ramp already gave s = 2.29 there. Live-pool K
// spread has been OVER-CORRECTED all along; this event reduces that error, it does not introduce it.
// Evidence strength: the RANGE fact is certain; the NEED at g ≈ 44 rests on ONE captured format at
// 42 judged rows (over THIN_N, so it carries a verdict) with the other seven inferred by shared pool.
//
// WHY LIVE POOLS READ A HUGE GAP AT ALL (recorded so the number is never misread as pool weakness):
// the gap coordinate reads ONE channel — opposing-hitter avoid-K. Live cards are NOT weak; their
// top-50 beats iron's on every channel EXCEPT avoid-K, which sits low because live card design bakes
// in the modern strikeout meta. The coordinate conflates CHANNEL META with POOL WEAKNESS. Quick
// tiers correlate the two, which is why the ramp works there; live pools decouple them.
//
// PROVENANCE IS STAMPED AND ASSERTED, NEVER ASSUMED (amendment A2.4 / A3.4). fitN, fitP and gMax are
// all fit-derived and coordinate-dependent: the gap is NOT monotone in p (measured across p = 0..1
// the iron gap runs 23.64/21.22/22.15/21.59/19.06), so a ramp can never be RESCALED to another
// (N, p) — only RE-DERIVED. assertKSpreadProvenance() below is the one check, and it throws.
//
// STILL OPEN AND DELIBERATELY NOT ADDRESSED HERE: both published residuals sit on the composition
// axis, which is task 2 and is not built. The lead pre-registrable hypothesis is CHANNEL DECOUPLING
// — the divergence between a pool's gap-channel position and its overall-quality position, computable
// ex-ante from the catalog — which would unify both residuals under one measurable property.
export const K_SPREAD_PIT = {
  A: 0.6668,
  q: 2.40,
  /** FIXED reference gap. Not fitted — it only sets the units of A, so A = s(G0) − 1. */
  G0: 20,
  /** The largest gap the fit was MEASURED at. Above it s is held flat (amendment 3). */
  gMax: 22.25,
  /** Fit-derived provenance, asserted against the values actually in force. Never rescale. */
  fitN: 50,
  fitP: 0.30,
  /** The COHORT SELECTION RULE this ramp was fit under (cohort-rule event, 2026-07-23). "model-woba"
   *  = the pre-event coordinate these constants live on. The cohort-rule event re-fits the ramp under
   *  "zsum-catalog-v1" and re-stamps this; activating a model whose cohortRule differs from this tag
   *  is a coordinate mismatch (the arm-B same-construction violation) and is guarded at activation. */
  cohortRule: "model-woba",
} as const;

/** s(gap) for the pitcher K-spread on the own-gap path:
 *
 *      s(g) = 1                         g <= 0    EXACTLY (league anchor — a stronger-than-training
 *                                                 pool is never compressed)
 *      s(g) = 1 + A·(g/G0)^q            0 < g <= gMax
 *      s(g) = s(gMax) = 1.862           g > gMax  (amendment 3: never assert more correction than
 *                                                 the fit observed)
 *
 *  The caller applies it via applyKSpread to the raw model K, PRE-BIP PRE-ERA (score-card.ts), so
 *  hits re-derive from the corrected BIP and era_k applies once. gap = the own-K-channel stu gap,
 *  buildFrameShift(trainingMeans, poolField).pit.vR.stu. */
export const kSpreadPitRamp = (gap: number): number => {
  if (!(gap > 0)) return 1;
  const g = Math.min(gap, K_SPREAD_PIT.gMax);
  return 1 + K_SPREAD_PIT.A * Math.pow(g / K_SPREAD_PIT.G0, K_SPREAD_PIT.q);
};

/** THE ONE PROVENANCE CHECK. A ramp fitted at one (cohort size, presence prior) and evaluated at
 *  another is meaningless, and because the gap is NOT monotone in p it cannot be rescaled — only
 *  re-derived. gMax is in the same class: it is the largest FITTED gap at that (N, p), so a
 *  coordinate move makes it stale exactly as it makes A and q stale.
 *
 *  THROWS rather than warns. A mismatch means someone moved a cohort constant without re-deriving
 *  the ramp, which is precisely the failure a warning would let through. */
export function assertKSpreadProvenance(fieldN: number, presenceP: number, gMaxFitted?: number): void {
  const bad: string[] = [];
  if (fieldN !== K_SPREAD_PIT.fitN) bad.push(`FIELD_N is ${fieldN} but K_SPREAD_PIT was fitted at fitN = ${K_SPREAD_PIT.fitN}`);
  if (presenceP !== K_SPREAD_PIT.fitP) bad.push(`PRESENCE_P is ${presenceP} but K_SPREAD_PIT was fitted at fitP = ${K_SPREAD_PIT.fitP}`);
  if (gMaxFitted !== undefined && gMaxFitted !== K_SPREAD_PIT.gMax) bad.push(`the fitted gap max is ${gMaxFitted} but K_SPREAD_PIT carries gMax = ${K_SPREAD_PIT.gMax}`);
  // The HR ramp is fitted at the SAME cohort coordinate and must move with it — a coordinate change
  // stales BOTH pitcher ramps at once (that is the atomic-event rule made executable). Its gMax is
  // its OWN (the HR fit spans a different gap range), so only (N, p) are checked against the shared
  // cohort constants here; gMax is pinned in tests/pitspread.test.ts.
  if (fieldN !== PIT_SPREAD_HR.fitN) bad.push(`FIELD_N is ${fieldN} but PIT_SPREAD_HR was fitted at fitN = ${PIT_SPREAD_HR.fitN}`);
  if (presenceP !== PIT_SPREAD_HR.fitP) bad.push(`PRESENCE_P is ${presenceP} but PIT_SPREAD_HR was fitted at fitP = ${PIT_SPREAD_HR.fitP}`);
  if (bad.length) {
    throw new Error(
      `PITCHER-SPREAD PROVENANCE MISMATCH — a pitcher spread ramp is being evaluated at a different `
      + `coordinate from the one it was fitted at, and it CANNOT be rescaled to fit:\n  - ${bad.join("\n  - ")}\n`
      + `Re-derive the ramp(s) (tools/fit-kspread-c3.ts / tools/fit-hrspread-c6.ts) and update A, q AND `
      + `gMax together. See src/model/pool-transform.ts.`,
    );
  }
}

// ── Pitcher HR9 spread ramp (BUILD-3, own-gap path; PRODUCTION, on by default) ──
// FIT PROVENANCE (2026-07-17, tools/fit-pitspread-hrbab.ts; snapshot
// fixtures/pitspread-fit-run-2026-07-17.txt; doc docs/CWHIT_PITSPREAD_BUILD3_2026-07-17.md):
// per-tier cwhit HR9 calibration slopes on the SHIPPED K-ramp baseline are gap-FLAT
// (iron 1.30 / bronze 1.23 / silver 1.25 / gold 1.31 at hrr-gaps 47.7/36.3/27.6/17.5 — NOT the
// K ramp's monotone geometry), so the data identify a constant out-of-frame amplification and
// G is pinned by the BUILD-3 rule: G = g_min/3 (95% saturation at the lowest observed tier gap
// ⇒ continuous league anchor, no amplification extrapolated below the first measured point).
// A = 0.2648 [boot 0.157, 0.355] closed-form at that G; held-out bronze PASS (pred 1.29
// [1.14,1.42] vs measured 1.23 [1.09,1.34]). HR-only gate record: G1 4/4 quicks PASS (pooled
// 1.26→1.00), G2 4/4 + pooled PASS (iron +0.027 CI-clear IMPROVE), G3 levels ~0, G4 ratios on
// optimum. KNOWN FLAG: gold-cap overshoots (post 0.78 [0.60,0.83]) — gold-quick (1.31)
// and gold-cap (0.97) disagree at the SAME gap; era factors are 1.0 there so it is NOT the era
// class — but that clearance is INCOMPLETE (2026-07-20): gold-cap's park-156 is non-neutral on
// the HR channel (hr_l 0.964 / hr_r 1.199, gap 1.132 — largest in the set) AND gold-cap is the
// tightest cap format (TIGHT 0.317), so cap-composition and park are DEGENERATE here — no depth
// at gold-cap can separate them. (Quick-vs-daily is DEAD as an axis — Derek ruling 2026-07-20:
// no functional difference.) Discriminator = bronze-cap-weekly (cap, park-1 neutral,
// window-matched vs bronze-quick). NOTE this flag is HR-channel-only; parks carry no K factor,
// so the K ramp above is park-clean everywhere. The
// sibling BABIP scalar was HELD (bronze G1 CI-clear fail) — sPitBab is never set in production.
//
// ══ 2026-07-22 CONSTANTS EVENT — HR REFIT. THE FAMILY CHANGED; the BUILD-3 block above is history. ══
// Spec: docs/CWHIT_HRRAMP_REFIT_PREREG_2026-07-22.md + amendment 1. Fit artifact:
// fixtures/cwhit-hrspread-c6-2026-07-22.txt (tools/fit-hrspread-c6.ts). This is the second leg of the
// atomic event (C3 K ramp + this HR ramp + the BUILD-2 hitter tail all ship on ONE coordinate).
//
// WHY IT WAS REFIT: the BUILD-3 saturating constant was fitted at the PRE-C1/C2' coordinate and on a
// residual taken ABOUT HR̄_pool with no per-tier free level — the same pivot conflation ruling (z)
// corrected for C3. C1/C2' moved the coordinate; the C6 sweep then caught the stale ramp
// over-correcting (bronze G1-HR 0.86 [0.73,0.99]). The refit re-derives it on production's coordinate
// with the free-slope estimand, the deliverable-space selection, and the C3 family.
//
// THE NEED IS GAP-FLAT, and the family was chosen to SAY SO HONESTLY. On the current coordinate the
// per-tier HR9 needs are 1.15/1.09/1.17/1.29/1.24 across hrr-gaps 44.6/33.4/25.3/16.0/4.1 — no
// monotone geometry. The C3 power law s(g)=1+A(g/G0)^q contains BOTH the constant (q→0) and a ramp
// (q>0), so it does not pre-judge; the deliverable-space selection landed at q=0.54, a near-flat
// s_hr ~1.08-1.17. GEOMETRY-UNIDENTIFIED (Fable): the response is unresolved between the constant and
// a mild ramp — the DELIVERABLE is determined, the SHAPE is not. That is the honest successor to the
// old "HR is gap-flat" claim, and it is why q carries a wide bootstrap CI while s(g) does not.
//
// GATE (w)2' (Fable ruling, 2026-07-22): family misfit iff the shipped s(g) is not well-determined
// over the APPLIED domain — the equivalence set's s-spread at the hrr gap of all 46 production
// tournaments (post-clamp) must be ≤ 1 need-SE everywhere, on the INTERPOLATED-SE yardstick (local
// SE = linear interpolation of the bracketing tiers' need-SEs; nearest-tier snap would claim measured
// precision at unmeasured gaps, which is anti-statistical). PASSED at worst 1.00× (0 of 46 exceed),
// the 1.00× sitting AT gold's own fitted gap = the equivalence set's definitional tightness. The
// low-q edge is the STRUCTURAL-LIMIT constant closure, not a grid edge — touching it is information.
//
// SELECTION, ESTIMAND, DOMAIN, PROVENANCE — all identical to C3: deliverable-space equivalence with a
// minimax centre (set q ∈ [0.05,1.25], published); per-card free-level objective; flat-hold above the
// largest fitted gap; fitN/fitP/gMax stamped and asserted. Compare ramps on s(g), never on {A,q}.
// GATES: (w)1 span 96-99.6%; (w)3 LOTO pass; acceptance 5/5 fit-set tiers inside CI with the
// smallest-gap tier (diamond) mandatory-inside; band holds at p=0.25/0.35.
//
// BASELINE: the C3 K ramp was ACTIVE at every step of the fit (the HR residual sits on the shipped
// K line, not a stale one). The RAW Quick-tier HR9 line is invariant to the K leg by construction
// (applyPitSpread moves only K when sHr=1), so the K baseline is load-bearing only for the deployed
// env-bearing held-out legs — which it carried.
export const PIT_SPREAD_HR = {
  A: 0.1135,
  q: 0.54,
  G0: 20,
  gMax: 44.56,
  fitN: 50,
  fitP: 0.30,
  /** The cohort selection rule this ramp was fit under — see K_SPREAD_PIT.cohortRule. */
  cohortRule: "model-woba",
  /** Fable's (w)2' verdict: the deliverable is determined, the SHAPE (constant vs mild ramp) is not. */
  geometry: "unidentified" as const,
} as const;

/** s(gap) for the pitcher HR9 spread on the own-gap path:
 *
 *      s(g) = 1                         g <= 0    EXACTLY (league anchor)
 *      s(g) = 1 + A·(g/G0)^q            0 < g <= gMax
 *      s(g) = s(gMax) = 1.175           g > gMax  (domain flat-hold — never assert more than the fit saw)
 *
 *  Applied via applyPitSpread to the raw model HR, PRE-BIP PRE-ERA (era_effective_hr/park multiply
 *  downstream, once — the K precedent's placement). gap = the own-HR-channel hrr gap,
 *  buildFrameShift(trainingMeans, poolField).pit.vR.hrr. */
export const pitSpreadHrRamp = (gap: number): number => {
  if (!(gap > 0)) return 1;
  const g = Math.min(gap, PIT_SPREAD_HR.gMax);
  return 1 + PIT_SPREAD_HR.A * Math.pow(g / PIT_SPREAD_HR.G0, PIT_SPREAD_HR.q);
};

// The full transform: a per-rating map for each role × platoon side. Absent entries fall
// back to identity (applyAffine with undefined → raw r), so a partial transform is safe.
export interface PoolTransform {
  hit: { vR: Partial<Record<HitRating, RatingAffine>>; vL: Partial<Record<HitRating, RatingAffine>> };
  pit: { vR: Partial<Record<PitRating, RatingAffine>>; vL: Partial<Record<PitRating, RatingAffine>> };
}

/** Build one side's per-rating maps from matched league + pool stat maps + ceilings. */
export function buildAffines<K extends string>(
  keys: readonly K[], league: Record<K, RatingStats>, pool: Record<K, RatingStats>,
  ceilings: Partial<Record<K, number>> = {},
): Partial<Record<K, RatingAffine>> {
  const out: Partial<Record<K, RatingAffine>> = {};
  for (const k of keys) if (league[k] && pool[k]) out[k] = affineFor(league[k], pool[k], ceilings[k] ?? Infinity);
  return out;
}
