// The ONE place a card becomes scores. Extracts ratings, runs the (swappable)
// event model, and produces every metric mode the trusted roster-page scores
// expose — hitting {woba,basic}×{vL,vR} and pitching {woba,basic}×{vR,vL,ovr}.
// This is the single core every consumer (grid, optimizer, SP, training) reads.

import type { ScoringConfig, Side } from "../config/types.ts";
import type { EventModel } from "../model/types.ts";
import { logLinearModel } from "../model/log-linear.ts";
import { makeRawPolyModel } from "../model/raw-poly.ts";
import { applyAffine } from "../model/pool-transform.ts";
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
  const { coeffs, derived, calScales, eventForm, poolTransform } = config;
  // Model selection (D3): an explicit `model` wins (tests/tools); otherwise #2 raw-poly
  // when the config carries a fitted eventForm, else the parity log-linear default.
  const evModel = model ?? (eventForm ? makeRawPolyModel(eventForm) : logLinearModel);
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
    // Pool transform (rating space, BEFORE the model). Absent ⇒ applyAffine returns raw.
    const t = poolTransform?.hit[side];
    const ratings = {
      eye: applyAffine(n(card[`Eye ${side}`]), t?.eye),
      pow: applyAffine(n(card[`Power ${side}`]), t?.pow),
      kRat: applyAffine(n(card[`Avoid K ${side}`]), t?.kRat),
      babip: applyAffine(n(card[`BABIP ${side}`]), t?.babip),
      gap: applyAffine(n(card[`Gap ${side}`]), t?.gap),
      speed, steal, run,
    };
    const e = evModel.predictHitting(ratings, coeffs);

    // SSP (same-side platoon penalty) — REMOVED under #2 (value → 1); log-linear keeps it (parity).
    const sspAdv = sameSidePenaltyHitting(bats, side, eventForm ? 1 : coeffs.ssp_adv_hitting);
    const rawWoba = assembleRawHittingWoba(e, sspAdv, speed, steal, run, coeffs);
    const woba = trustedHittingWoba(e, rawWoba, bats, side, coeffs, derived, calScales, eventForm);

    // Basic metric: direct basic-hitting score × pool scale × cross-pool multiplier.
    const basicRaw = basicHittingSide({
      babipRaw: ratings.babip, powRaw: ratings.pow, eyeRaw: ratings.eye, kRaw: ratings.kRat, gapRaw: ratings.gap,
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
    const ratings = {
      con: applyAffine(n(card[`Control ${side}`]), tp?.con),
      stu: applyAffine(n(card[`Stuff ${side}`]), tp?.stu),
      pbabip: applyAffine(n(card[`pBABIP ${side}`]), tp?.pbabip),
      hrr: applyAffine(n(card[`pHR ${side}`]), tp?.hrr),
    };
    const e = evModel.predictPitching(ratings, coeffs);

    const sspP = sameSidePenaltyPitching(thr, side, eventForm ? 1 : coeffs.ssp_basic_pitching);
    const rawWoba = assembleRawPitchingWoba(e, sspP, coeffs);
    const woba = trustedPitchingSideWoba(e, rawWoba, thr, side, coeffs, derived, calScales, eventForm);

    const vR = side === "vR";
    const basicRaw = basicPitchingSide({
      stuffRaw: ratings.stu, ctrlRaw: ratings.con, pbabipRaw: ratings.pbabip, hrrRaw: ratings.hrr, gb,
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
