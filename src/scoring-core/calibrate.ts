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

import type { Coeffs, Derived, CalScales, KSpread } from "../config/types.ts";
import type { EventModel, RawHitting, RawPitching } from "../model/types.ts";
import type { EventForm } from "../model/curves.ts";
import { applyAffine, applyFrameShift, applyKSpread, type PoolTransform, type FrameShift } from "../model/pool-transform.ts";
import { logLinearModel } from "../model/log-linear.ts";
import { makeRawPolyModel } from "../model/raw-poly.ts";
import { scoreCard } from "./score-card.ts";
import { n, sameSidePenaltyHitting, sameSidePenaltyPitching } from "./helpers.ts";
import { assembleRawHittingWoba, assembleRawPitchingWoba, anchorHittingWoba, anchorPitchingWoba, baserunningWoba } from "./woba.ts";
import { applyHitTail, type HitTail } from "./hit-tail.ts";

export const TARGET_WOBA = 0.320;
export const TARGET_BASIC = 100;
export const ANCHOR_N = 50;
// League baseline event rates (per 600). Only BB & HR feed the result; the old
// 1B/GAP/nHH scales were computed but unused (flagged to revisit post-parity).
export const H_SECTION3 = { BB: 48.43, HR: 14.87 };
export const P_SECTION3 = { BB: 47.80, HR: 14.96 };

export interface CalibrateConfig { coeffs: Coeffs; derived: Derived; eventForm?: EventForm; poolTransform?: PoolTransform; frameShift?: FrameShift; kSpread?: KSpread; matchup?: { model: EventModel; shift: FrameShift }; hitTail?: HitTail }

interface SideRaw { e: RawHitting | RawPitching; woba: number }
interface Aug { bats: number; thr: number; speed: number; stealRate: number; steal: number; run: number; hVR: { e: RawHitting; woba: number }; hVL: { e: RawHitting; woba: number }; pVR: SideRaw; pVL: SideRaw }

// Re-basing here MUST mirror score-card exactly (own-gap OR frame-v2 + K scaling), so the
// 0.320 anchor is computed on the same re-based events the display scores use.
function augment(card: any, coeffs: Coeffs, model: EventModel, pt?: PoolTransform, noSsp = false, fs?: FrameShift, ks?: KSpread, ht?: HitTail): Aug {
  const bats = n(card["Bats"]), thr = n(card["Throws"]);
  const speed = n(card["Speed"]), steal = n(card["Stealing"]), run = n(card["Baserunning"]), stealRate = n(card["Steal Rate"]);
  const hit = (side: "vR" | "vL") => {
    const t = pt?.hit[side]; const f = fs?.hit[side]; // pool transform / frame shift (rating space), absent ⇒ raw
    const e = model.predictHitting(
      { eye: applyFrameShift(applyAffine(n(card[`Eye ${side}`]), t?.eye), f?.eye), pow: applyFrameShift(applyAffine(n(card[`Power ${side}`]), t?.pow), f?.pow), kRat: applyFrameShift(applyAffine(n(card[`Avoid K ${side}`]), t?.kRat), f?.kRat), babip: applyFrameShift(applyAffine(n(card[`BABIP ${side}`]), t?.babip), f?.babip), gap: applyFrameShift(applyAffine(n(card[`Gap ${side}`]), t?.gap), f?.gap), speed, steal, run },
      coeffs,
    );
    if (ks) e.SO = applyKSpread(e.SO, ks.meanHit, ks.sHit);
    // BUILD-2 hitter tail correction — mirrors score-card exactly, so the anchor is computed on
    // the same corrected events the display scores use. Identity when absent.
    if (ht) applyHitTail(e, ht);
    // BATTING-ONLY for the anchor (pass 0 for baserunning): the anchor selects its top-50 and normalizes
    // to TARGET_WOBA on batting alone, so toggling baserunning can't shift the top-50 or sFinal. Baserunning
    // is added additively (and pool-centered) in trustedHittingWoba; the pool's real BsR still feeds
    // brCenterHit via the speed/stealRate/steal/run returned below. (Fixes the ~+1 mwOBA centering drift.)
    return { e, woba: assembleRawHittingWoba(e, sameSidePenaltyHitting(bats, side, noSsp ? 1 : coeffs.ssp_adv_hitting), 0, 0, 0, 0, coeffs) };
  };
  const pit = (side: "vR" | "vL") => {
    const tp = pt?.pit[side]; const fp = fs?.pit[side];
    const e = model.predictPitching(
      { con: applyFrameShift(applyAffine(n(card[`Control ${side}`]), tp?.con), fp?.con), stu: applyFrameShift(applyAffine(n(card[`Stuff ${side}`]), tp?.stu), fp?.stu), pbabip: applyFrameShift(applyAffine(n(card[`pBABIP ${side}`]), tp?.pbabip), fp?.pbabip), hrr: applyFrameShift(applyAffine(n(card[`pHR ${side}`]), tp?.hrr), fp?.hrr) },
      coeffs,
    );
    if (ks) e.K = applyKSpread(e.K, ks.meanPit, ks.sPit);
    return { e, woba: assembleRawPitchingWoba(e, sameSidePenaltyPitching(thr, side, noSsp ? 1 : coeffs.ssp_basic_pitching), coeffs) };
  };
  return { bats, thr, speed, stealRate, steal, run, hVR: hit("vR"), hVL: hit("vL"), pVR: pit("vR"), pVL: pit("vL") };
}

const mean = (arr: number[]) => { const v = arr.filter((x) => x > 0); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0; };
const evScale = (vals: number[], tgt: number) => { const m = mean(vals); return m > 0 ? tgt / m : 1; };

/**
 * Compute calibration scales over an (already eligibility-filtered) card pool.
 * The hitter/pitcher anchors self-select from the whole pool by raw wOBA.
 */
export function calibrate(pool: any[], config: CalibrateConfig, model?: EventModel): CalScales {
  const { coeffs, derived, eventForm, poolTransform, frameShift, kSpread, matchup, hitTail } = config;
  // Same model selection as scoreCard: explicit model, then the matchup wrapper (Phase 0 — it
  // binds the frame-v2 shift into the model, so augment passes OWN ratings and the wrapper
  // shifts internally), then #2 raw-poly when a fitted eventForm is present, else the parity
  // log-linear default. The anchor recompute uses the SAME model + curves, so per-pool
  // calibration self-adjusts to #2's event levels. The rating re-basing (own-gap pool transform
  // OR frame-v2 shift OR matchup + K scaling) is applied here too, so the anchor is computed on
  // the same re-based events the display scores use.
  const evModel = model ?? matchup?.model ?? (eventForm ? makeRawPolyModel(eventForm) : logLinearModel);
  const aug = pool.map((c) => augment(c, coeffs, evModel, poolTransform, !!eventForm, frameShift, kSpread, hitTail));

  const hAnchVR = [...aug].sort((a, b) => b.hVR.woba - a.hVR.woba).slice(0, ANCHOR_N);
  const hAnchVL = [...aug].sort((a, b) => b.hVL.woba - a.hVL.woba).slice(0, ANCHOR_N);
  const pAnch = [...aug].sort((a, b) => (a.pVR.woba + a.pVL.woba) - (b.pVR.woba + b.pVL.woba)).slice(0, ANCHOR_N);

  // PER-EVENT CALIBRATION (sBB/sHR) — REMOVED under #2. Its job (pull the field's BB/HR
  // to the league baseline = crude pool-relativity) moved to the rating-space pool
  // transform; what's left is the dubious elite→league-average deflation. So with #2 these
  // are 1 (the model's native event composition stands; the final wOBA scale sets level).
  // log-linear path keeps them (parity).
  const noEvCal = !!eventForm;
  const hitBBScaleVR = noEvCal ? 1 : evScale(hAnchVR.map((x) => x.hVR.e.BB), H_SECTION3.BB);
  const hitHRScaleVR = noEvCal ? 1 : evScale(hAnchVR.map((x) => x.hVR.e.HR), H_SECTION3.HR);
  const hitBBScaleVL = noEvCal ? 1 : evScale(hAnchVL.map((x) => x.hVL.e.BB), H_SECTION3.BB);
  const hitHRScaleVL = noEvCal ? 1 : evScale(hAnchVL.map((x) => x.hVL.e.HR), H_SECTION3.HR);
  const pBBScale = noEvCal ? 1 : evScale(pAnch.map((x) => (x.pVR.e as RawPitching).BB), P_SECTION3.BB);
  const pHRScale = noEvCal ? 1 : evScale(pAnch.map((x) => (x.pVR.e as RawPitching).HR), P_SECTION3.HR);

  const anchorMeanVR = mean(hAnchVR.map((x) => anchorHittingWoba(x.hVR.e, hitBBScaleVR, hitHRScaleVR, x.bats, "vR", coeffs, derived, eventForm)));
  const anchorMeanVL = mean(hAnchVL.map((x) => anchorHittingWoba(x.hVL.e, hitBBScaleVL, hitHRScaleVL, x.bats, "vL", coeffs, derived, eventForm)));
  const anchorMeanPVR = mean(pAnch.map((x) => anchorPitchingWoba(x.pVR.e as RawPitching, pBBScale, pHRScale, "vR", coeffs, derived, eventForm)));
  const anchorMeanPVL = mean(pAnch.map((x) => anchorPitchingWoba(x.pVL.e as RawPitching, pBBScale, pHRScale, "vL", coeffs, derived, eventForm)));
  const anchorMeanPOVR = (anchorMeanPVR + anchorMeanPVL) / 2;

  const hitScaleVR = anchorMeanVR > 0 ? TARGET_WOBA / anchorMeanVR : 1;
  const hitScaleVL = anchorMeanVL > 0 ? TARGET_WOBA / anchorMeanVL : 1;
  const pitchScale = anchorMeanPOVR > 0 ? TARGET_WOBA / anchorMeanPOVR : 1;

  // Baserunning CENTER = the pool's mean baserunning value (side-invariant). Our "wOBA" is the offense
  // component of WAR (batting + baserunning + steal runs), so baserunning is credited as runs ABOVE/BELOW
  // the average card in the pool — subtracted in trustedHittingWoba so the average card gets ~0 (not a
  // universal uplift) and below-average baserunners go negative, as intended.
  // Baserunning CENTER = the TRUE mean BsR over the pool's HITTERS (pitchers barely bat, so they'd
  // drag the average down and make every hitter read falsely positive). A plain mean (incl. negatives),
  // NOT the x>0-filtered `mean` helper. Subtracted in trustedHittingWoba ⇒ the average hitter's
  // baserunning is ~0 and cards are +/- by their edge over the hitter field.
  const brVals = pool.filter((c) => String(c["Position"] ?? "") !== "1")
    .map((c) => baserunningWoba(n(c["Speed"]), n(c["Steal Rate"]), n(c["Stealing"]), n(c["Baserunning"]), coeffs));
  const brCenterHit = brVals.length ? brVals.reduce((s, x) => s + x, 0) / brVals.length : 0;

  return {
    brCenterHit,
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
  const { coeffs, derived, eventForm, poolTransform, frameShift, kSpread, matchup, hitTail } = config;
  // calScales=null → unscaled basic. Thread eventForm so the card's (discarded) wOBA uses
  // #2, not the log-linear fallback — basic itself is rating-direct, so this is for the
  // "no log-linear in production scoring" guarantee (the wOBA columns here are unused).
  // Re-basing (poolTransform / frameShift / kSpread / matchup / hitTail) threaded so basic reads the same events.
  const raw = pool.map((c) => scoreCard(c, { coeffs, derived, calScales: null, eventForm, poolTransform, frameShift, kSpread, matchup, hitTail }));
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
