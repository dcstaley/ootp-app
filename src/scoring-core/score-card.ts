// The ONE place a card becomes scores. Extracts ratings, runs the (swappable)
// event model, and produces every metric mode the trusted roster-page scores
// expose — hitting {woba,basic}×{vL,vR} and pitching {woba,basic}×{vR,vL,ovr}.
// This is the single core every consumer (grid, optimizer, SP, training) reads.

import type { ScoringConfig, Side } from "../config/types.ts";
import type { EventModel } from "../model/types.ts";
import { logLinearModel } from "../model/log-linear.ts";
import { makeRawPolyModel } from "../model/raw-poly.ts";
import { applyAffine, applyFrameShift } from "../model/pool-transform.ts";
import {
  n, cp, parkAvgFactor, parkHrFactor, sameSidePenaltyHitting, sameSidePenaltyPitching,
} from "./helpers.ts";
import { basicHittingSide, basicPitchingSide } from "./basic.ts";
import {
  assembleRawHittingWoba, assembleRawPitchingWoba, trustedHittingWoba, trustedPitchingSideWoba,
} from "./woba.ts";

export interface CardScores {
  cardId: unknown;
  title: unknown;
  bats: number;
  throws: number;
  hit: { woba_vL: number; woba_vR: number; woba_ovr: number; basic_vL: number; basic_vR: number; basic_ovr: number };
  pitch: {
    woba_vR: number; woba_vL: number; woba_ovr: number;
    basic_vR: number; basic_vL: number; basic_ovr: number;
  };
}

export function scoreCard(card: any, config: ScoringConfig, model?: EventModel): CardScores {
  const { coeffs, derived, calScales, eventForm, poolTransform, frameShift, kSpread, matchup } = config;
  // Model selection (D3): an explicit `model` wins (tests/tools); then the matchup wrapper
  // (Phase 0 — it binds the frame-v2 shift into the model, so score-card passes OWN ratings and
  // the wrapper shifts internally); otherwise #2 raw-poly when the config carries a fitted
  // eventForm. PRODUCTION always passes an eventForm (server threads the active model into BOTH
  // the wOBA and basic configs), so the log-linear fallback below is now reached ONLY by
  // no-eventForm test/tool callers — it is dead in general scoring. (Full removal of the
  // fallback + branch collapse is a separate pass; it requires giving those ~10 callers a
  // synthetic eventForm.)
  const evModel = model ?? matchup?.model ?? (eventForm ? makeRawPolyModel(eventForm) : logLinearModel);
  const bats = n(card["Bats"]);
  const thr = n(card["Throws"]);
  const gb = n(card["GB"]);
  const speed = n(card["Speed"]);
  const steal = n(card["Stealing"]);
  const run = n(card["Baserunning"]);
  const hold = n(card["Hold"]);

  const hitCross = calScales?.crossPoolHitterMultiplier ?? 1;

  // ── Hitting, per side ──────────────────────────────────────────────────────
  const hit = (side: Side) => {
    // Rating-space re-basing (BEFORE the model): own-gap multiplicative PoolTransform OR the
    // frame-v2 additive shift — mutually exclusive (the transform-mode setting sets one).
    // Both are identity when absent, so own-gap scoring is bit-unchanged.
    const t = poolTransform?.hit[side];
    const fs = frameShift?.hit[side];
    const ratings = {
      eye: applyFrameShift(applyAffine(n(card[`Eye ${side}`]), t?.eye), fs?.eye),
      pow: applyFrameShift(applyAffine(n(card[`Power ${side}`]), t?.pow), fs?.pow),
      kRat: applyFrameShift(applyAffine(n(card[`Avoid K ${side}`]), t?.kRat), fs?.kRat),
      babip: applyFrameShift(applyAffine(n(card[`BABIP ${side}`]), t?.babip), fs?.babip),
      gap: applyFrameShift(applyAffine(n(card[`Gap ${side}`]), t?.gap), fs?.gap),
      speed, steal, run,
    };
    const e = evModel.predictHitting(ratings, coeffs);
    // K spread scaling (frame-v2): rescale raw predicted K about the pool mean BEFORE the BIP
    // chain, so BIP = 600 − BB − K_scaled − HR − adj (woba.ts) recomputes hits consistently.
    // Pre-era by construction (era_k applies later, once) — see §10.8d.
    if (kSpread) e.SO = Math.max(0, kSpread.meanHit + kSpread.sHit * (e.SO - kSpread.meanHit));

    // Matchup: the event model got OWN ratings (it shifts internally), but the rating-DIRECT
    // basic metric must see the SAME effective coordinate → shift here from matchup.shift. Absent
    // matchup ⇒ bR === ratings (own-gap/frame-v2 basic path byte-unchanged).
    const mh = matchup?.shift.hit[side];
    const bR = mh ? {
      eye: applyFrameShift(ratings.eye, mh.eye), pow: applyFrameShift(ratings.pow, mh.pow),
      kRat: applyFrameShift(ratings.kRat, mh.kRat), babip: applyFrameShift(ratings.babip, mh.babip),
      gap: applyFrameShift(ratings.gap, mh.gap),
    } : ratings;

    // SSP (same-side platoon penalty) — REMOVED under #2 (value → 1); log-linear keeps it (parity).
    const sspAdv = sameSidePenaltyHitting(bats, side, eventForm ? 1 : coeffs.ssp_adv_hitting);
    const rawWoba = assembleRawHittingWoba(e, sspAdv, speed, steal, run, coeffs);
    const woba = trustedHittingWoba(e, rawWoba, bats, side, coeffs, derived, calScales, eventForm);

    // Basic metric: direct basic-hitting score × pool scale × cross-pool multiplier.
    const basicRaw = basicHittingSide({
      babipRaw: bR.babip, powRaw: bR.pow, eyeRaw: bR.eye, kRaw: bR.kRat, gapRaw: bR.gap,
      babipMod: derived.era_h * parkAvgFactor(bats, side, coeffs),
      powMod: derived.era_effective_hr * parkHrFactor(bats, side, coeffs),
      eyeMod: coeffs.era_bb,
      kMod: coeffs.era_k,
      gapMod: cp(coeffs.park_gap),
      ssp: sameSidePenaltyHitting(bats, side, eventForm ? 1 : coeffs.ssp_basic_hitting),
      speed, run, steal,
      coeffs,
    });
    const hitScale = side === "vR" ? (calScales?.hitScaleVR ?? 1) : (calScales?.hitScaleVL ?? 1);
    const basic = basicRaw * hitScale * hitCross;

    return { woba, basic };
  };
  const hVL = hit("vL");
  const hVR = hit("vR");

  // ── Pitching, per side ─────────────────────────────────────────────────────
  const pitch = (side: Side) => {
    const tp = poolTransform?.pit[side];
    const fp = frameShift?.pit[side];
    const ratings = {
      con: applyFrameShift(applyAffine(n(card[`Control ${side}`]), tp?.con), fp?.con),
      stu: applyFrameShift(applyAffine(n(card[`Stuff ${side}`]), tp?.stu), fp?.stu),
      pbabip: applyFrameShift(applyAffine(n(card[`pBABIP ${side}`]), tp?.pbabip), fp?.pbabip),
      hrr: applyFrameShift(applyAffine(n(card[`pHR ${side}`]), tp?.hrr), fp?.hrr),
    };
    const e = evModel.predictPitching(ratings, coeffs);
    if (kSpread) e.K = Math.max(0, kSpread.meanPit + kSpread.sPit * (e.K - kSpread.meanPit)); // §10.8d

    // Matchup: basic reads the effective coordinate (see the hitting note). Absent ⇒ bRp === ratings.
    const mp = matchup?.shift.pit[side];
    const bRp = mp ? {
      con: applyFrameShift(ratings.con, mp.con), stu: applyFrameShift(ratings.stu, mp.stu),
      pbabip: applyFrameShift(ratings.pbabip, mp.pbabip), hrr: applyFrameShift(ratings.hrr, mp.hrr),
    } : ratings;

    const sspP = sameSidePenaltyPitching(thr, side, eventForm ? 1 : coeffs.ssp_basic_pitching);
    const rawWoba = assembleRawPitchingWoba(e, sspP, coeffs);
    const woba = trustedPitchingSideWoba(e, rawWoba, thr, side, coeffs, derived, calScales, eventForm);

    const vR = side === "vR";
    const basicRaw = basicPitchingSide({
      stuffRaw: bRp.stu, ctrlRaw: bRp.con, pbabipRaw: bRp.pbabip, hrrRaw: bRp.hrr, gb,
      eraK: coeffs.era_k, eraBb: coeffs.era_bb,
      eraBabipParkAvg: derived.era_h * cp(vR ? coeffs.park_avg_r : coeffs.park_avg_l),
      eraEffHrParkHr: derived.era_effective_hr * cp(vR ? coeffs.park_hr_r : coeffs.park_hr_l),
      ssp: sspP, hold,
      coeffs,
    });
    const pitchScale = vR ? (calScales?.pitchScaleVR ?? 1) : (calScales?.pitchScaleVL ?? 1);
    const basic = basicRaw * pitchScale;

    return { woba, basic };
  };
  const pVR = pitch("vR");
  const pVL = pitch("vL");

  // OVR blends use the pitcher handedness split (matches getPitchingScore ovr).
  const blend = (vr: number, vl: number): number => {
    if (thr === 1) return vr * coeffs.r_pitch_split + vl * (1 - coeffs.r_pitch_split);
    if (thr === 2) return vr * (1 - coeffs.l_pitch_split) + vl * coeffs.l_pitch_split;
    return (vr + vl) / 2;
  };
  // Hitting OVR blend, same convention as pitching but on the batter handedness
  // + hit splits. (Weighting basis is a domain choice — see note; currently the
  // codebase's existing split convention.)
  const hitBlend = (vr: number, vl: number): number => {
    if (bats === 1) return vr * coeffs.r_hit_split + vl * (1 - coeffs.r_hit_split);
    if (bats === 2) return vr * (1 - coeffs.l_hit_split) + vl * coeffs.l_hit_split;
    const s = typeof coeffs.s_hit_split === "number" ? coeffs.s_hit_split : 0.5; // switch: PA share vs RHP (default 0.5 = parity)
    return vr * s + vl * (1 - s);
  };

  return {
    cardId: card["Card ID"],
    title: card["//Card Title"],
    bats, throws: thr,
    hit: {
      woba_vL: hVL.woba, woba_vR: hVR.woba, woba_ovr: hitBlend(hVR.woba, hVL.woba),
      basic_vL: hVL.basic, basic_vR: hVR.basic, basic_ovr: hitBlend(hVR.basic, hVL.basic),
    },
    pitch: {
      woba_vR: pVR.woba, woba_vL: pVL.woba, woba_ovr: blend(pVR.woba, pVL.woba),
      basic_vR: pVR.basic, basic_vL: pVL.basic, basic_ovr: blend(pVR.basic, pVL.basic),
    },
  };
}
