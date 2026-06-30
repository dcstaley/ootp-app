// Field-stats + pool-transform assembly (the server's bridge to the rating transform).
// A "field" = the top-N cards by raw predicted wOBA (hitters: highest; pitchers: lowest
// allowed), per role × platoon side; we take their per-rating μ/σ. The rating-space pool
// transform is then built from two fields:
//   reference = top-N of the FULL catalog (the unrestricted "league" — dynamic, tracks
//               new releases since it's by predicted wOBA, not usage)
//   pool      = top-N of a tournament's eligible subset
// → map the (weaker) pool's rating distribution onto the reference (z-score). Selection
// uses RAW wOBA (no transform, no calibration) so it's a stable quality ranking.

import type { Coeffs } from "../config/types.ts";
import type { EventModel } from "../model/types.ts";
import {
  ratingStats, buildAffines, HIT_RATINGS, PIT_RATINGS, type RatingStats, type PoolTransform, type RatingEnvelope,
} from "../model/pool-transform.ts";
import { n, sameSidePenaltyHitting, sameSidePenaltyPitching } from "./helpers.ts";
import { assembleRawHittingWoba, assembleRawPitchingWoba } from "./woba.ts";

export interface FieldStats {
  hit: { vR: Record<string, RatingStats>; vL: Record<string, RatingStats> };
  pit: { vR: Record<string, RatingStats>; vL: Record<string, RatingStats> };
}

interface SideRec { rat: Record<string, number>; woba: number }
interface CardRec { hitVR: SideRec; hitVL: SideRec; pitVR: SideRec; pitVL: SideRec }

function cardRec(c: any, coeffs: Coeffs, model: EventModel): CardRec {
  const bats = n(c["Bats"]), thr = n(c["Throws"]);
  const speed = n(c["Speed"]), steal = n(c["Stealing"]), run = n(c["Baserunning"]);
  const hit = (side: "vR" | "vL"): SideRec => {
    const rat: Record<string, number> = { eye: n(c[`Eye ${side}`]), pow: n(c[`Power ${side}`]), kRat: n(c[`Avoid K ${side}`]), babip: n(c[`BABIP ${side}`]), gap: n(c[`Gap ${side}`]) };
    const e = model.predictHitting({ eye: rat.eye!, pow: rat.pow!, kRat: rat.kRat!, babip: rat.babip!, gap: rat.gap!, speed, steal, run }, coeffs);
    return { rat, woba: assembleRawHittingWoba(e, sameSidePenaltyHitting(bats, side, coeffs.ssp_adv_hitting), speed, steal, run, coeffs) };
  };
  const pit = (side: "vR" | "vL"): SideRec => {
    const rat: Record<string, number> = { con: n(c[`Control ${side}`]), stu: n(c[`Stuff ${side}`]), pbabip: n(c[`pBABIP ${side}`]), hrr: n(c[`pHR ${side}`]) };
    const e = model.predictPitching({ con: rat.con!, stu: rat.stu!, pbabip: rat.pbabip!, hrr: rat.hrr! }, coeffs);
    return { rat, woba: assembleRawPitchingWoba(e, sameSidePenaltyPitching(thr, side, coeffs.ssp_basic_pitching), coeffs) };
  };
  return { hitVR: hit("vR"), hitVL: hit("vL"), pitVR: pit("vR"), pitVL: pit("vL") };
}

// Top-N by wOBA (hitterBest=true → highest; false → lowest allowed), then per-rating μ/σ.
function topStats(recs: SideRec[], keys: readonly string[], topN: number, hitterBest: boolean): Record<string, RatingStats> {
  const top = [...recs].sort((a, b) => (hitterBest ? b.woba - a.woba : a.woba - b.woba)).slice(0, topN);
  const out: Record<string, RatingStats> = {};
  for (const k of keys) out[k] = ratingStats(top.map((x) => x.rat[k] ?? 0));
  return out;
}

/** Per-(role, side) rating μ/σ of the top-N field by raw predicted wOBA. */
export function computeFieldStats(cards: any[], coeffs: Coeffs, model: EventModel, topN: number): FieldStats {
  const recs = cards.map((c) => cardRec(c, coeffs, model));
  return {
    hit: { vR: topStats(recs.map((r) => r.hitVR), HIT_RATINGS, topN, true), vL: topStats(recs.map((r) => r.hitVL), HIT_RATINGS, topN, true) },
    pit: { vR: topStats(recs.map((r) => r.pitVR), PIT_RATINGS, topN, false), vL: topStats(recs.map((r) => r.pitVL), PIT_RATINGS, topN, false) },
  };
}

/** Build the saturating mean-scalar transform mapping the POOL field onto the REFERENCE
 *  field, with per-rating saturation ceilings from the model's training envelope (pooled
 *  over sides → the same ceiling for vR/vL). Absent envelope ⇒ no cap (pure scalar). */
export function buildPoolTransform(ref: FieldStats, pool: FieldStats, env?: RatingEnvelope): PoolTransform {
  const h = env?.hit ?? {}, p = env?.pit ?? {};
  return {
    hit: { vR: buildAffines(HIT_RATINGS, ref.hit.vR, pool.hit.vR, h), vL: buildAffines(HIT_RATINGS, ref.hit.vL, pool.hit.vL, h) },
    pit: { vR: buildAffines(PIT_RATINGS, ref.pit.vR, pool.pit.vR, p), vL: buildAffines(PIT_RATINGS, ref.pit.vL, pool.pit.vL, p) },
  };
}
