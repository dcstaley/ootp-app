// Rating-space pool-strength transform — a mean-scalar lift with a LOGISTIC FADE.
// Re-bases a weaker tournament pool's ratings UP toward the league reference frame (the
// frame the model trained in), but fades the lift out as a rating nears/exceeds the model's
// trained max — so mid-tier cards play up fully while already-elite ratings barely move.
// Per (rating, side):
//
//     effective = r · ( 1 + (k − 1)·σ((C − r)/w) )      σ = logistic, k = leagueμ / poolμ
//
// Shape of the LIFT (gap = effective − r):
//   • BULK (r ≪ C): σ ≈ 1 → effective ≈ r·k — the full mean-scalar lift.
//   • The gap rises, then PEAKS BELOW C and starts shrinking as the rating approaches the max.
//   • Past C it keeps shrinking — diminishing returns — toward ~0 (σ → 0) but NEVER exactly 0,
//     so a genuine above-max rating (a diamond card's eye 230 on an otherwise-weak card) is
//     gently controlled, not capped, not frozen at raw, and never thrown out.
//   • k ≤ 1 (unrestricted/stronger pool) ⇒ lift ≤ 0, faded the same way (elite cards untouched).
//
// Why mean-scalar (vs z-score): anchored at 0 → true lows survive (a 1-rating stays ~1) and
// relative spacing is preserved → genuinely-best cards keep their lead (the z-score's spread
// match compressed the widest ratings and demoted the best card). A config without a
// poolTransform applies nothing → bit-identical scores (parity).

export interface RatingStats { mu: number; sd: number }

/** Mean/sd over positive rating values (0 = "no rating for this card-side", excluded). */
export function ratingStats(values: number[]): RatingStats {
  const v = values.filter((x) => x > 0);
  if (!v.length) return { mu: 0, sd: 1 };
  const mu = v.reduce((s, x) => s + x, 0) / v.length;
  const sd = Math.sqrt(v.reduce((s, x) => s + (x - mu) ** 2, 0) / v.length) || 1;
  return { mu, sd };
}

// Fade width as a fraction of the ceiling (how gradually the lift tapers around the max).
// Small ⇒ ~full scalar until close to the max, then a quick fade to ~0 by the rating cap
// (~255). The monotone guard below widens it only when the lift k is large.
export const DECAY_FRAC = 0.07;
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

/** Apply a map to a raw rating: mean-scalar lift r·k, with the lift faded out by a logistic
 *  centered on the trained max C — so the gap peaks below C and decays toward ~0 (never 0)
 *  above it. No ceiling ⇒ pure scalar. Absent map ⇒ identity (parity). Clamped ≥ 0. */
export const applyAffine = (r: number, m: RatingAffine | undefined) => {
  if (!m) return r;
  if (!Number.isFinite(m.c) || !(m.w > 0)) return Math.max(0, r * m.k); // no ceiling → pure scalar
  const fade = logistic((m.c - r) / m.w); // 1 in the bulk → 0 far above the max
  return Math.max(0, r * (1 + (m.k - 1) * fade));
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
