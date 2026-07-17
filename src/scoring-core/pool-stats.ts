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
import { PIT_BIP_ADJ } from "../model/curves.ts";
import {
  ratingStats, buildAffines, applyFrameShift, applyAffine, HIT_RATINGS, PIT_RATINGS, type RatingStats, type PoolTransform,
  type RatingAffine, type RatingEnvelope, type TrainingMeans, type FrameShift,
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
  const speed = n(c["Speed"]), steal = n(c["Stealing"]), run = n(c["Baserunning"]), stealRate = n(c["Steal Rate"]);
  const hit = (side: "vR" | "vL"): SideRec => {
    const rat: Record<string, number> = { eye: n(c[`Eye ${side}`]), pow: n(c[`Power ${side}`]), kRat: n(c[`Avoid K ${side}`]), babip: n(c[`BABIP ${side}`]), gap: n(c[`Gap ${side}`]) };
    const e = model.predictHitting({ eye: rat.eye!, pow: rat.pow!, kRat: rat.kRat!, babip: rat.babip!, gap: rat.gap!, speed, steal, run }, coeffs);
    const ssp = sspFree ? 1 : sameSidePenaltyHitting(bats, side, coeffs.ssp_adv_hitting);
    return { rat, woba: assembleRawHittingWoba(e, ssp, speed, stealRate, steal, run, coeffs) };
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

// ── Frame-correction v2 (additive, channel-crossed) ────────────────────────────
// The additive opponent-gap shift for a channel is the OPPOSING channel's (μ_train − μ_pool)
// gap: a hitting channel is re-based by the pitching training/pool means it faces, and vice
// versa (the §10.2 crossing). Both means are side-unified, so the shift is one number per
// (role, channel) applied to both sides. μ_train = the artifact's PA/BF-weighted training
// opponent means; μ_pool = the tournament pool's unified top-N field means. When the pool
// means equal the training means (in-frame) every delta is 0 ⇒ identity.
export function buildFrameShift(train: TrainingMeans, pool: FieldStats): FrameShift {
  const pHit = pool.hit.vR, pPit = pool.pit.vR; // side-unified (vR === vL)
  const gap = (mu: number | undefined, p: RatingStats | undefined) => (mu != null && p ? mu - p.mu : 0);
  // Hitting channels re-based by the opposing PITCHING gap (eye↔con, kRat↔stu, pow↔hrr,
  // babip & gap ↔ pbabip).
  const hit = {
    eye: gap(train.pit.con, pPit.con),
    kRat: gap(train.pit.stu, pPit.stu),
    pow: gap(train.pit.hrr, pPit.hrr),
    babip: gap(train.pit.pbabip, pPit.pbabip),
    gap: gap(train.pit.pbabip, pPit.pbabip),
  };
  // Pitching channels re-based by the opposing HITTING gap.
  const pit = {
    con: gap(train.hit.eye, pHit.eye),
    stu: gap(train.hit.kRat, pHit.kRat),
    hrr: gap(train.hit.pow, pHit.pow),
    pbabip: gap(train.hit.babip, pHit.babip),
  };
  return { hit: { vR: { ...hit }, vL: { ...hit } }, pit: { vR: { ...pit }, vL: { ...pit } } };
}

// One rating-mapper seam for the two K̄_pool variants below: frame-v2 centers on FRAME-SHIFTED
// ratings, the own-gap K-spread centers on POOL-TRANSFORMED ratings. The cohort selection and
// pooling are identical — only the rating re-basing differs — so the math lives here once.
type KRatingMapper = (role: "hit" | "pit", side: "vR" | "vL", key: string, raw: number) => number;

function poolChanBy(cards: any[], coeffs: Coeffs, model: EventModel, topN: number, map: KRatingMapper): { hit: { k: number }; pit: { k: number; hr: number; bab: number } } {
  const recs = cards.map((c) => {
    const speed = n(c["Speed"]), steal = n(c["Stealing"]), run = n(c["Baserunning"]), stealRate = n(c["Steal Rate"]);
    const hitK = (side: "vR" | "vL") => {
      const g = (key: string, col: string) => map("hit", side, key, n(c[`${col} ${side}`]));
      const e = model.predictHitting({ eye: g("eye", "Eye"), pow: g("pow", "Power"), kRat: g("kRat", "Avoid K"), babip: g("babip", "BABIP"), gap: g("gap", "Gap"), speed, steal, run }, coeffs);
      return { woba: assembleRawHittingWoba(e, 1, speed, stealRate, steal, run, coeffs), k: e.SO };
    };
    const pitK = (side: "vR" | "vL") => {
      const g = (key: string, col: string) => map("pit", side, key, n(c[`${col} ${side}`]));
      const e = model.predictPitching({ con: g("con", "Control"), stu: g("stu", "Stuff"), pbabip: g("pbabip", "pBABIP"), hrr: g("hrr", "pHR") }, coeffs);
      // hr + bab: the raw pre-era per-600 HR and the raw BABIP (nHH over the model's BIP
      // convention) — the centering means for the BUILD-3 pitcher HR/BABIP spread scalars,
      // measured in exactly the frame the per-card predictions live in (like K̄ for the K ramp).
      const bip = Math.max(600 - e.BB - e.K - e.HR - PIT_BIP_ADJ, 1);
      return { woba: assembleRawPitchingWoba(e, 1, coeffs), k: e.K, hr: e.HR, bab: e.nHH / bip };
    };
    return { hVR: hitK("vR"), hVL: hitK("vL"), pVR: pitK("vR"), pVL: pitK("vL") };
  });
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
  // Hitters: top-N per-side cohort by raw wOBA, deployment-side K pooled.
  const hVR = recs.map((r) => r.hVR).sort((a, b) => b.woba - a.woba).slice(0, topN);
  const hVL = recs.map((r) => r.hVL).sort((a, b) => b.woba - a.woba).slice(0, topN);
  // Pitchers: top-N by combined allowed wOBA (lower = better), both sides pooled.
  const pTop = [...recs].sort((a, b) => (a.pVR.woba + a.pVL.woba) - (b.pVR.woba + b.pVL.woba)).slice(0, topN);
  const pSides = [...pTop.map((r) => r.pVR), ...pTop.map((r) => r.pVL)];
  return {
    hit: { k: mean([...hVR.map((x) => x.k), ...hVL.map((x) => x.k)]) },
    pit: { k: mean(pSides.map((x) => x.k)), hr: mean(pSides.map((x) => x.hr)), bab: mean(pSides.map((x) => x.bab)) },
  };
}

function poolMeanKBy(cards: any[], coeffs: Coeffs, model: EventModel, topN: number, map: KRatingMapper): { hit: number; pit: number } {
  const r = poolChanBy(cards, coeffs, model, topN, map);
  return { hit: r.hit.k, pit: r.pit.k };
}

/** Per-role mean predicted K over the top-N field, computed on FRAME-V2-SHIFTED ratings —
 *  the centering mean K̄_pool for the K spread scaling K_corr = K̄ + s·(K_pred − K̄). Uses the
 *  same top-N cohort (by raw predicted wOBA) the frame shift is built from, so the mean the
 *  specialists deviate from matches how s* was fit. Hitters center on the deployment-side K of
 *  each per-side cohort; pitchers on the combined-wOBA top-N, both sides pooled. Predictions
 *  use the shift so K̄ and the per-card K live in the same shifted frame (plan §10.8d). */
export function poolMeanK(cards: any[], coeffs: Coeffs, model: EventModel, fs: FrameShift, topN: number): { hit: number; pit: number } {
  // §10.8d frame shift — the one copy lives in pool-transform.ts.
  return poolMeanKBy(cards, coeffs, model, topN, (role, side, key, raw) => applyFrameShift(raw, (fs[role][side] as Record<string, number | undefined>)[key]));
}

/** OWN-GAP sibling of poolMeanK: the same top-N cohorts and pooling, but predictions run on
 *  POOL-TRANSFORMED (own-gap) ratings — the centering mean K̄_pool for the pitcher K-spread
 *  correction on the production own-gap path, so K̄ and each card's predicted K live in the
 *  same own-gap frame score-card predicts in. Pre-era (raw model K per 600), like poolMeanK. */
export function poolMeanKOwn(cards: any[], coeffs: Coeffs, model: EventModel, pt: PoolTransform, topN: number): { hit: number; pit: number } {
  return poolMeanKBy(cards, coeffs, model, topN, (role, side, key, raw) => applyAffine(raw, (pt[role][side] as Record<string, RatingAffine | undefined>)[key]));
}

/** BUILD-3 sibling: the pitcher field's own-gap centering means for ALL three spread channels —
 *  K̄ (identical to poolMeanKOwn(...).pit — same cohorts, same math, one copy), plus the raw
 *  pre-era HR̄/600 and the raw BABIP̄ (nHH over the model's BIP convention). These are the pivot
 *  means for the pitcher HR9/BABIP spread scalars (K_corr-style: x̄ + s·(x − x̄)). */
export function poolPitMeansOwn(cards: any[], coeffs: Coeffs, model: EventModel, pt: PoolTransform, topN: number): { k: number; hr: number; bab: number } {
  return poolChanBy(cards, coeffs, model, topN, (role, side, key, raw) => applyAffine(raw, (pt[role][side] as Record<string, RatingAffine | undefined>)[key])).pit;
}
