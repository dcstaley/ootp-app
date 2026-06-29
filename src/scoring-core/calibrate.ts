// M1.5 — compute our own calibration/anchor scales over the eligible pool, so the
// app no longer depends on captured calScales. Faithful to the old backend
// calcAnchorWoba/evScale (SP-1), with ONE deliberate correction:
//
//   CORRECTED: the hitter pool is EVERY player (everyone has a hitting score),
//   not only cards with a non-DH position Learn flag. The old `_inHitterPool`
//   gate wrongly excluded DH-only cards and pitchers-who-hit (see roadmap
//   "Flagged old-app issues"). The pitcher anchor takes the lowest-allowed-wOBA
//   50, so it naturally selects real pitchers. (topHitters/HARD_POOL_CAP narrow
//   the OPTIMIZATION pool — M4 — not the calibration anchor.)
//
// Reuses the single scoring core (model + woba recompute); no scoring math here.

import type { Coeffs, Derived, CalScales } from "../config/types.ts";
import type { EventModel, RawHitting, RawPitching } from "../model/types.ts";
import type { EventForm } from "../model/curves.ts";
import { logLinearModel } from "../model/log-linear.ts";
import { makeRawPolyModel } from "../model/raw-poly.ts";
import { scoreCard } from "./score-card.ts";
import { n, sameSidePenaltyHitting, sameSidePenaltyPitching } from "./helpers.ts";
import { assembleRawHittingWoba, assembleRawPitchingWoba, anchorHittingWoba, anchorPitchingWoba } from "./woba.ts";

export const TARGET_WOBA = 0.320;
export const TARGET_BASIC = 100;
export const ANCHOR_N = 50;
// League baseline event rates (per 600). Only BB & HR feed the result; the old
// 1B/GAP/nHH scales were computed but unused (flagged to revisit post-parity).
export const H_SECTION3 = { BB: 48.43, HR: 14.87 };
export const P_SECTION3 = { BB: 47.80, HR: 14.96 };

export interface CalibrateConfig { coeffs: Coeffs; derived: Derived; eventForm?: EventForm }

interface SideRaw { e: RawHitting | RawPitching; woba: number }
interface Aug { bats: number; thr: number; hVR: { e: RawHitting; woba: number }; hVL: { e: RawHitting; woba: number }; pVR: SideRaw; pVL: SideRaw }

function augment(card: any, coeffs: Coeffs, model: EventModel): Aug {
  const bats = n(card["Bats"]), thr = n(card["Throws"]);
  const speed = n(card["Speed"]), steal = n(card["Stealing"]), run = n(card["Baserunning"]);
  const hit = (side: "vR" | "vL") => {
    const e = model.predictHitting(
      { eye: n(card[`Eye ${side}`]), pow: n(card[`Power ${side}`]), kRat: n(card[`Avoid K ${side}`]), babip: n(card[`BABIP ${side}`]), gap: n(card[`Gap ${side}`]), speed, steal, run },
      coeffs,
    );
    return { e, woba: assembleRawHittingWoba(e, sameSidePenaltyHitting(bats, side, coeffs.ssp_adv_hitting), speed, steal, run, coeffs) };
  };
  const pit = (side: "vR" | "vL") => {
    const e = model.predictPitching(
      { con: n(card[`Control ${side}`]), stu: n(card[`Stuff ${side}`]), pbabip: n(card[`pBABIP ${side}`]), hrr: n(card[`pHR ${side}`]) },
      coeffs,
    );
    return { e, woba: assembleRawPitchingWoba(e, sameSidePenaltyPitching(thr, side, coeffs.ssp_basic_pitching), coeffs) };
  };
  return { bats, thr, hVR: hit("vR"), hVL: hit("vL"), pVR: pit("vR"), pVL: pit("vL") };
}

const mean = (arr: number[]) => { const v = arr.filter((x) => x > 0); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0; };
const evScale = (vals: number[], tgt: number) => { const m = mean(vals); return m > 0 ? tgt / m : 1; };

/**
 * Compute calibration scales over an (already eligibility-filtered) card pool.
 * The hitter/pitcher anchors self-select from the whole pool by raw wOBA.
 */
export function calibrate(pool: any[], config: CalibrateConfig, model?: EventModel): CalScales {
  const { coeffs, derived, eventForm } = config;
  // Same model selection as scoreCard: #2 raw-poly when a fitted eventForm is present,
  // else the parity log-linear default. The anchor recompute uses the SAME model + curves,
  // so per-pool calibration self-adjusts to #2's event levels.
  const evModel = model ?? (eventForm ? makeRawPolyModel(eventForm) : logLinearModel);
  const aug = pool.map((c) => augment(c, coeffs, evModel));

  const hAnchVR = [...aug].sort((a, b) => b.hVR.woba - a.hVR.woba).slice(0, ANCHOR_N);
  const hAnchVL = [...aug].sort((a, b) => b.hVL.woba - a.hVL.woba).slice(0, ANCHOR_N);
  const pAnch = [...aug].sort((a, b) => (a.pVR.woba + a.pVL.woba) - (b.pVR.woba + b.pVL.woba)).slice(0, ANCHOR_N);

  const hitBBScaleVR = evScale(hAnchVR.map((x) => x.hVR.e.BB), H_SECTION3.BB);
  const hitHRScaleVR = evScale(hAnchVR.map((x) => x.hVR.e.HR), H_SECTION3.HR);
  const hitBBScaleVL = evScale(hAnchVL.map((x) => x.hVL.e.BB), H_SECTION3.BB);
  const hitHRScaleVL = evScale(hAnchVL.map((x) => x.hVL.e.HR), H_SECTION3.HR);
  const pBBScale = evScale(pAnch.map((x) => (x.pVR.e as RawPitching).BB), P_SECTION3.BB);
  const pHRScale = evScale(pAnch.map((x) => (x.pVR.e as RawPitching).HR), P_SECTION3.HR);

  const anchorMeanVR = mean(hAnchVR.map((x) => anchorHittingWoba(x.hVR.e, hitBBScaleVR, hitHRScaleVR, x.bats, "vR", coeffs, derived, eventForm)));
  const anchorMeanVL = mean(hAnchVL.map((x) => anchorHittingWoba(x.hVL.e, hitBBScaleVL, hitHRScaleVL, x.bats, "vL", coeffs, derived, eventForm)));
  const anchorMeanPVR = mean(pAnch.map((x) => anchorPitchingWoba(x.pVR.e as RawPitching, pBBScale, pHRScale, "vR", coeffs, derived)));
  const anchorMeanPVL = mean(pAnch.map((x) => anchorPitchingWoba(x.pVL.e as RawPitching, pBBScale, pHRScale, "vL", coeffs, derived)));
  const anchorMeanPOVR = (anchorMeanPVR + anchorMeanPVL) / 2;

  const hitScaleVR = anchorMeanVR > 0 ? TARGET_WOBA / anchorMeanVR : 1;
  const hitScaleVL = anchorMeanVL > 0 ? TARGET_WOBA / anchorMeanVL : 1;
  const pitchScale = anchorMeanPOVR > 0 ? TARGET_WOBA / anchorMeanPOVR : 1;

  return {
    hitScaleVR, hitScaleVL, pitchScale, pitchScaleVR: pitchScale, pitchScaleVL: pitchScale,
    hitBBScaleVR, hitHRScaleVR, hitBBScaleVL, hitHRScaleVL,
    pBBScaleVR: pBBScale, pBBScaleVL: pBBScale, pHRScaleVR: pHRScale, pHRScaleVL: pHRScale,
    anchorMeanVR, anchorMeanVL, anchorMeanPitchVR: anchorMeanPVR, anchorMeanPitchVL: anchorMeanPVL,
    anchorMeanPitch: anchorMeanPOVR, targetWoba: TARGET_WOBA, anchorN: ANCHOR_N,
    ssp_adv_hitting: coeffs.ssp_adv_hitting, ssp_basic_pitching: coeffs.ssp_basic_pitching,
    crossPoolHitterMultiplier: 1, crossPoolPitcherMultiplier: 1,
  };
}

/** D2 — cross-pool comparable value: signed distance from a common baseline. */
export function valueFor(woba: number, role: "hitter" | "pitcher", baseline = TARGET_WOBA): number {
  return role === "hitter" ? woba - baseline : baseline - woba;
}

/**
 * Basic-metric calibration: anchor the top-N basic scores to TARGET_BASIC (100),
 * independent of the wOBA anchoring. Returns a CalScales whose hit/pitch scales
 * are basic-anchored, so the grid can show accurate basic AND wOBA at once
 * (score each card with the wOBA scales for wOBA columns and these for basic).
 */
export function calibrateBasic(pool: any[], config: CalibrateConfig): CalScales {
  const { coeffs, derived } = config;
  const raw = pool.map((c) => scoreCard(c, { coeffs, derived, calScales: null })); // calScales=null → unscaled basic
  const topMean = (vals: number[]) => {
    const t = vals.filter((x) => x > 0).sort((a, b) => b - a).slice(0, ANCHOR_N);
    return t.length ? t.reduce((s, x) => s + x, 0) / t.length : 0;
  };
  const mHitVR = topMean(raw.map((s) => s.hit.basic_vR));
  const mHitVL = topMean(raw.map((s) => s.hit.basic_vL));
  const mPitch = topMean(raw.map((s) => s.pitch.basic_ovr));
  const hitScaleVR = mHitVR > 0 ? TARGET_BASIC / mHitVR : 1;
  const hitScaleVL = mHitVL > 0 ? TARGET_BASIC / mHitVL : 1;
  const pitchScale = mPitch > 0 ? TARGET_BASIC / mPitch : 1;
  return {
    hitScaleVR, hitScaleVL, pitchScale, pitchScaleVR: pitchScale, pitchScaleVL: pitchScale,
    crossPoolHitterMultiplier: 1, crossPoolPitcherMultiplier: 1,
    ssp_adv_hitting: coeffs.ssp_adv_hitting, ssp_basic_pitching: coeffs.ssp_basic_pitching,
  };
}
