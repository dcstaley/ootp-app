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

// `sspFree` = the caller runs under an eventForm (#2) — the deployed pipeline forces
// ssp → 1 there (woba.ts, calibrate.ts, score-card.ts), so field SELECTION must rank
// on the same ssp-free basis. false ⇒ legacy log-path behavior (coeff ssp), unchanged.
function cardRec(c: any, coeffs: Coeffs, model: EventModel, sspFree: boolean): CardRec {
  const bats = n(c["Bats"]), thr = n(c["Throws"]);
  const speed = n(c["Speed"]), steal = n(c["Stealing"]), run = n(c["Baserunning"]);
  const hit = (side: "vR" | "vL"): SideRec => {
    const rat: Record<string, number> = { eye: n(c[`Eye ${side}`]), pow: n(c[`Power ${side}`]), kRat: n(c[`Avoid K ${side}`]), babip: n(c[`BABIP ${side}`]), gap: n(c[`Gap ${side}`]) };
    const e = model.predictHitting({ eye: rat.eye!, pow: rat.pow!, kRat: rat.kRat!, babip: rat.babip!, gap: rat.gap!, speed, steal, run }, coeffs);
    const ssp = sspFree ? 1 : sameSidePenaltyHitting(bats, side, coeffs.ssp_adv_hitting);
    return { rat, woba: assembleRawHittingWoba(e, ssp, speed, steal, run, coeffs) };
  };
  const pit = (side: "vR" | "vL"): SideRec => {
    const rat: Record<string, number> = { con: n(c[`Control ${side}`]), stu: n(c[`Stuff ${side}`]), pbabip: n(c[`pBABIP ${side}`]), hrr: n(c[`pHR ${side}`]) };
    const e = model.predictPitching({ con: rat.con!, stu: rat.stu!, pbabip: rat.pbabip!, hrr: rat.hrr! }, coeffs);
    const ssp = sspFree ? 1 : sameSidePenaltyPitching(thr, side, coeffs.ssp_basic_pitching);
    return { rat, woba: assembleRawPitchingWoba(e, ssp, coeffs) };
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

/** Raw per-side predicted wOBA for one card — the env-free field-SELECTION basis (same
 *  raw wOBA the field stats rank by). Reused by the exposure baseline so its field matches. */
export function cardSideWobas(c: any, coeffs: Coeffs, model: EventModel, sspFree = false): { hitVR: number; hitVL: number; pitVR: number; pitVL: number } {
  const r = cardRec(c, coeffs, model, sspFree);
  return { hitVR: r.hitVR.woba, hitVL: r.hitVL.woba, pitVR: r.pitVR.woba, pitVL: r.pitVL.woba };
}

/** Per-(role, side) rating μ/σ of the top-N field by raw predicted wOBA. */
export function computeFieldStats(cards: any[], coeffs: Coeffs, model: EventModel, topN: number, sspFree = false): FieldStats {
  const recs = cards.map((c) => cardRec(c, coeffs, model, sspFree));
  return {
    hit: { vR: topStats(recs.map((r) => r.hitVR), HIT_RATINGS, topN, true), vL: topStats(recs.map((r) => r.hitVL), HIT_RATINGS, topN, true) },
    pit: { vR: topStats(recs.map((r) => r.pitVR), PIT_RATINGS, topN, false), vL: topStats(recs.map((r) => r.pitVL), PIT_RATINGS, topN, false) },
  };
}

/** Side-UNIFIED field stats: one μ/σ per rating, applied to BOTH sides (vR === vL), so the
 *  pool-strength lift preserves each card's platoon shape instead of reshaping it.
 *   • Pitchers (Option A): a pitcher faces both hands every game → select the top-N by COMBINED
 *     allowed wOBA and pool BOTH sides' rating values.
 *   • Hitters (#2): platooned → select per-side cohorts (top-N vs R, top-N vs L) but pool each
 *     cohort's DEPLOYMENT-side values (vR-cohort's vR ratings + vL-cohort's vL ratings), so a
 *     platoon specialist counts on the side he actually plays and his rarely-used bad side
 *     doesn't define the frame. */
export function computeUnifiedFieldStats(cards: any[], coeffs: Coeffs, model: EventModel, topN: number, sspFree = false): FieldStats {
  const recs = cards.map((c) => cardRec(c, coeffs, model, sspFree));
  // Pitchers: top-N by combined allowed wOBA (lower = better), both-side values pooled.
  const pitTop = [...recs].sort((a, b) => (a.pitVR.woba + a.pitVL.woba) - (b.pitVR.woba + b.pitVL.woba)).slice(0, topN);
  const pit: Record<string, RatingStats> = {};
  for (const k of PIT_RATINGS) pit[k] = ratingStats(pitTop.flatMap((r) => [r.pitVR.rat[k] ?? 0, r.pitVL.rat[k] ?? 0]));
  // Hitters: per-side cohorts, each contributing its deployment-side values.
  const hVR = recs.map((r) => r.hitVR).sort((a, b) => b.woba - a.woba).slice(0, topN);
  const hVL = recs.map((r) => r.hitVL).sort((a, b) => b.woba - a.woba).slice(0, topN);
  const hit: Record<string, RatingStats> = {};
  for (const k of HIT_RATINGS) hit[k] = ratingStats([...hVR.map((x) => x.rat[k] ?? 0), ...hVL.map((x) => x.rat[k] ?? 0)]);
  return { hit: { vR: hit, vL: hit }, pit: { vR: pit, vL: pit } };
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
