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
  Math.max(0, mean + s * (k - mean));

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
