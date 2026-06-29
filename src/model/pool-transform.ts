// Rating-space pool-strength transform (z-score). Re-bases a tournament pool's
// ratings onto the LEAGUE reference frame — the frame the model was trained in — so a
// card competing in a weaker pool is scored at its lifted, league-frame ability ("a
// big fish in a small pond plays up"). Per (rating, side):
//
//     effective = leagueμ + (r − poolμ)·(leagueσ / poolσ)
//
// i.e. "how many SDs is this rating above its pool's mean" → "the same SDs above the
// league's mean." Anchored at the pool MEAN (not zero, which is why multiplicative is
// wrong), with the stretch set by the spread ratio (the second knob multiplicative
// lacks). Pure math here; the league/pool stats are MEASURED upstream (training data /
// the pool's top-50 realistic field). Runs BEFORE the event model, in rating space —
// era/park stay AFTER it in event space. A config without a poolTransform applies
// nothing → bit-identical scores (parity).

export interface RatingStats { mu: number; sd: number }

/** Mean/sd over positive rating values (0 = "no rating for this card-side", excluded). */
export function ratingStats(values: number[]): RatingStats {
  const v = values.filter((x) => x > 0);
  if (!v.length) return { mu: 0, sd: 1 };
  const mu = v.reduce((s, x) => s + x, 0) / v.length;
  const sd = Math.sqrt(v.reduce((s, x) => s + (x - mu) ** 2, 0) / v.length) || 1;
  return { mu, sd };
}

// Per-rating affine map: effective = a + b·r. Precomputed so score-time is one mul+add.
export interface RatingAffine { a: number; b: number }

/** The affine that sends the POOL's distribution onto the LEAGUE's (full z-score lift). */
export function affineFor(league: RatingStats, pool: RatingStats): RatingAffine {
  const b = pool.sd > 1e-9 ? league.sd / pool.sd : 1; // spread-ratio stretch
  return { a: league.mu - pool.mu * b, b };            // shift so pool mean → league mean
}

/** Apply an affine map to a raw rating, clamped ≥ 0 (ratings can't go negative). */
export const applyAffine = (r: number, m: RatingAffine | undefined) =>
  m ? Math.max(m.a + m.b * r, 0) : r;

// The rating-driven inputs the transform covers, per role (speed/steal/run — a minor
// advanced-bonus term — are left raw for now; flagged for a later pass).
export const HIT_RATINGS = ["eye", "pow", "kRat", "babip", "gap"] as const;
export const PIT_RATINGS = ["con", "stu", "pbabip", "hrr"] as const;
export type HitRating = (typeof HIT_RATINGS)[number];
export type PitRating = (typeof PIT_RATINGS)[number];

// The full transform: a per-rating affine for each role × platoon side. Absent entries
// fall back to identity (applyAffine with undefined → raw r), so a partial transform is
// safe. Built per-tournament from (league stats, pool top-50 stats).
export interface PoolTransform {
  hit: { vR: Partial<Record<HitRating, RatingAffine>>; vL: Partial<Record<HitRating, RatingAffine>> };
  pit: { vR: Partial<Record<PitRating, RatingAffine>>; vL: Partial<Record<PitRating, RatingAffine>> };
}

/** Build one side's per-rating affines from matched league + pool stat maps. */
export function buildAffines<K extends string>(
  keys: readonly K[], league: Record<K, RatingStats>, pool: Record<K, RatingStats>,
): Partial<Record<K, RatingAffine>> {
  const out: Partial<Record<K, RatingAffine>> = {};
  for (const k of keys) if (league[k] && pool[k]) out[k] = affineFor(league[k], pool[k]);
  return out;
}
