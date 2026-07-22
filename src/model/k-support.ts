// ═══ LOW-SUPPORT DISPLAY FLAG (constants event C4) — INFORMATIONAL, NON-SCORING ═══
//
// WHAT IT MARKS. A pitcher whose EFFECTIVE STUFF — the exact coordinate the deployed K curve
// is evaluated at — sits below the 5th percentile of that curve's LEAGUE TRAINING SUPPORT.
// These are the cards the K-need investigation closed on (fixtures/cwhit-centerpiece2-step0-
// domain-2026-07-21.txt): gold's ELEVEN sub-p05 pitchers — 12.1% of its realized cards — carry
// 50.8% of that tier's predicted-K variance, and they are the named provenance behind the shipped
// K ramp's recorded gold misfit. They are NOT irrelevant cards (Derek's standing correction): budget and
// restricted formats force weak cards into play, so this flag marks exactly the population a
// cap/slots optimizer chooses between.
//
// NON-SCORING, structurally. Nothing here is imported by scoring-core, the optimizer, the pool
// statistics or any ramp; the flag is produced at PAYLOAD-ASSEMBLY time (server toRow) and read
// by a human in the data grid. It must never enter a score, ranking, transform, gate or
// optimizer decision. `effectiveStuff` READS the poolTransform — it does not build or alter one.
//
// ONE COPY of both halves lives here:
//   · the CARD coordinate  — applyAffine(Stuff v{R,L}, poolTransform.pit.v{R,L}.stu), blended by
//     the pitcher's exposure weights (the same convention score-card's OVR blend uses). This is
//     the construction tools/centerpiece2-step0-domain.ts introduced; that tool now imports it.
//   · the LEAGUE threshold — the BF^0.75-weighted 5th percentile of `ratings.pitch.stu` over the
//     observations the K curve was FIT on (`pitch.BF >= minPA`), i.e. the trainer's own row
//     selection and weighting (bakeoff.ts PITCHER.qualifies + forms.ts fitPitForm's fitExp).
//
// The threshold is a property of the MODEL, not of a tournament: it is stamped onto the trained
// artifact at save time (`TrainedModel.kSupport`) and recomputed only for artifacts trained
// before this existed. The card coordinate IS tournament-scoped (the pool transform is), which
// is the point — a weak-pool lift can carry a card back into the supported region.

import { applyAffine, type PoolTransform } from "./pool-transform.ts";

/** The quantile of league training support below which a card is flagged. */
export const LOW_SUPPORT_Q = 0.05;
/** Stored percentile ladder resolution: p0…p100 of the training stuff distribution. */
export const LADDER_N = 101;

/** The minimum shape `computeKSupport` needs from a training observation (structurally
 *  satisfied by `TrainObs`; declared here so this module carries no training import). */
export interface KSupportObs { pitch: { BF: number }; ratings: { pitch: { stu: number } } }

/** Model-scoped low-support reference for the deployed K curve. All stuff values are RAW
 *  rating units (the curve's own coordinate); `z` restates the threshold in the curve's
 *  z units for the reader. */
export interface KSupport {
  q: number;        // the marked quantile (LOW_SUPPORT_Q)
  stuff: number;    // THE THRESHOLD: weighted q-quantile of training stuff, rating units
  z: number;        // the same point in the K curve's z units ((stuff − mu)/sd)
  mu: number;       // the curve's stored centering …
  sd: number;       // … and scale, carried so `z` is reproducible
  minBF: number;    // the trainer's row floor (BF >= minPA)
  nObs: number;     // qualifying observations (vL and vR counted separately, as the trainer counts them)
  ladder: number[]; // weighted p0…p100 of training stuff — percentile lookups without the raw rows
}

/** Weighted quantile, ascending: the first value whose cumulative weight reaches p·W.
 *  (The same reading tools/centerpiece2-step0-domain.ts's `wq` takes.) */
function weightedQuantile(sorted: { v: number; w: number }[], wTot: number, p: number): number {
  let acc = 0;
  for (const x of sorted) { acc += x.w; if (acc >= p * wTot) return x.v; }
  return sorted[sorted.length - 1]?.v ?? NaN;
}

/**
 * The league training support for the deployed K curve, from the observations the curve was
 * fit on. Row selection + weighting are the trainer's: `pitch.BF >= minBF`, weight `BF^0.75`.
 * Returns null when there is nothing to measure (no training data on disk, empty window).
 */
export function computeKSupport(
  obs: readonly KSupportObs[], minBF: number, curve: { mu: number; sd: number }, q = LOW_SUPPORT_Q,
): KSupport | null {
  const rows = obs
    .filter((o) => o.pitch.BF >= minBF && Number.isFinite(o.ratings.pitch.stu))
    .map((o) => ({ v: o.ratings.pitch.stu, w: Math.pow(o.pitch.BF, 0.75) }))
    .sort((a, b) => a.v - b.v);
  if (!rows.length) return null;
  const wTot = rows.reduce((a, x) => a + x.w, 0);
  if (!(wTot > 0)) return null;
  const stuff = weightedQuantile(rows, wTot, q);
  const sd = curve.sd > 1e-9 ? curve.sd : 1;
  return {
    q, stuff, z: (stuff - curve.mu) / sd, mu: curve.mu, sd: curve.sd, minBF, nObs: rows.length,
    ladder: Array.from({ length: LADDER_N }, (_, i) => weightedQuantile(rows, wTot, i / (LADDER_N - 1))),
  };
}

/** Where a card's effective stuff sits in the training distribution, in whole percent
 *  (0…100, read off the stored ladder). Informational only — the FLAG uses the exact
 *  threshold below, never this rounded value. */
export function supportPercentile(ks: KSupport, effStuff: number): number {
  if (!Number.isFinite(effStuff) || !ks.ladder.length) return 0;
  let i = 0;
  while (i < ks.ladder.length && ks.ladder[i]! <= effStuff) i++;
  // ladder[i] is the i-th percentile (LADDER_N − 1 === 100), so the last index at or below
  // the card IS its percentile; below p0 ⇒ 0.
  return Math.max(0, Math.min(100, i - 1));
}

/** THE FLAG: is this card's effective stuff below the league training support's q-quantile? */
export const isLowKSupport = (ks: KSupport, effStuff: number): boolean =>
  Number.isFinite(effStuff) && effStuff < ks.stuff;

/** Exposure weights for a pitcher's two sides (they sum to 1). Same convention as
 *  score-card's pitching OVR blend: a RHP's `r_pitch_split` is its vR share, a LHP's
 *  `l_pitch_split` is its vL share, and an unknown/switch hand splits evenly. */
export interface SideWeights { wR: number; wL: number }
export const pitcherSideWeights = (
  throws: number, splits: { r_pitch_split?: number; l_pitch_split?: number },
): SideWeights => {
  if (throws === 1) { const r = splits.r_pitch_split ?? 0.5; return { wR: r, wL: 1 - r }; }
  if (throws === 2) { const l = splits.l_pitch_split ?? 0.5; return { wR: 1 - l, wL: l }; }
  return { wR: 0.5, wL: 0.5 };
};

const num = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

/** THE CARD COORDINATE: effective stuff = the argument the K curve is evaluated at, per side
 *  through `applyAffine` (exactly what score-card's `pitch()` feeds the model), blended by the
 *  card's exposure weights so one number can be compared against the training support.
 *  Absent transform ⇒ raw ratings (applyAffine is the identity), matching scoring. */
export function effectiveStuff(
  card: Record<string, unknown>, pt: PoolTransform | undefined, w: SideWeights,
): number {
  return w.wR * applyAffine(num(card["Stuff vR"]), pt?.pit.vR?.stu)
       + w.wL * applyAffine(num(card["Stuff vL"]), pt?.pit.vL?.stu);
}
