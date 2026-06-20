// GOLDEN HARNESS — the TRUSTED scores. Extracted verbatim (formula bodies) from
// getHittingScore / getPitchingScore / getParkFactor in
// C:\ootp_app\frontend\components\RosterAndLineupPage.tsx (~lines 580-717).
//
// These are the numbers the user trusts (the Roster & Lineup page's calibrated
// scores), and the single source of truth the rebuilt core must reproduce.
// Refactored only to be pure: React hooks/useCallback removed; `coeffs`,
// `derived`, `calScales`, and `settings` are passed in explicitly. A single
// diagnostic console.log in the original calScales==null hitting branch is
// dropped (it had no effect on the return value).

import { n, cp } from "./scoringCore.ts";
import type { Derived } from "./computeRows.ts";

export interface ScoreSettings {
  hittingMetric: "basic" | "woba";
  pitchingMetric: "basic" | "woba";
  pitchingSide: "vR" | "vL" | "ovr";
}

export interface ScoreCtx {
  coeffs: any;
  derived: Derived;
  calScales: any | null;
  settings: ScoreSettings;
}

// getParkFactor(bats, vR, rFactor, lFactor)
function getParkFactor(bats: number, vR: boolean, rFactor: number, lFactor: number): number {
  if (bats === 1) return cp(rFactor);
  if (bats === 2) return cp(lFactor);
  return vR ? cp(lFactor) : cp(rFactor);
}

export function getHittingScore(card: any, side: "vL" | "vR", ctx: ScoreCtx): number {
  const { coeffs, derived, calScales, settings } = ctx;

  if (settings.hittingMetric === "basic") {
    const raw = n(card[`Basic Hitting ${side}`]);
    const scale = side === "vR" ? (calScales?.hitScaleVR ?? 1) : (calScales?.hitScaleVL ?? 1);
    const cross = calScales?.crossPoolHitterMultiplier ?? 1;
    return raw * scale * cross;
  }
  const rawWoba = n(card[`wOBA ${side}`]);
  if (!rawWoba) return 0;
  if (!calScales) {
    return rawWoba;
  }

  const vR  = side === "vR";
  const BB   = n(card[`BB ${side}`]);
  const HR   = n(card[`HR ${side}`]);
  const SO   = n(card[`SO ${side}`]);
  const babipSC = n(card[`BABIP SC ${side}`]);
  const gapSC   = n(card[`GAP SC ${side}`]);

  const sBB    = vR ? (calScales.hitBBScaleVR ?? 1) : (calScales.hitBBScaleVL ?? 1);
  const sHR    = vR ? (calScales.hitHRScaleVR ?? 1) : (calScales.hitHRScaleVL ?? 1);
  const sFinal = vR ? (calScales.hitScaleVR   ?? 1) : (calScales.hitScaleVL   ?? 1);

  // Step 1: calibration on BB and HR
  const BB_cal = BB * sBB;
  const HR_cal = HR * sHR;

  // Step 2: era/park on BB, HR, K → recompute BIP
  const bats = n(card["Bats"]);
  const parkHR  = getParkFactor(bats, vR, coeffs.park_hr_r,  coeffs.park_hr_l);
  const parkAvg = getParkFactor(bats, vR, coeffs.park_avg_r, coeffs.park_avg_l);
  const BB_fin  = BB_cal * coeffs.era_bb;
  const HR_fin  = HR_cal * derived.era_effective_hr * parkHR;
  const SO_fin  = SO     * coeffs.era_k;
  const adv_hbp = coeffs.adv_hbp ?? 6;
  const adv_sh  = coeffs.adv_sh  ?? 0;
  const BIP_fin = Math.max(600 - BB_fin - adv_hbp - adv_sh - SO_fin - HR_fin, 1);

  // Step 3: recompute BA from softcapped babip + new BIP, apply park_avg
  const BA_raw  = Math.max((coeffs.baInt ?? 0) + (coeffs.ba ?? 0) * Math.log(Math.max(babipSC, 1)) + (coeffs.bipba ?? 0) * Math.log(BIP_fin), 0);
  const BA_fin  = BA_raw * derived.era_h * parkAvg;

  // Step 4: recompute GAP and 1B from new BA
  const GAP_rate = Math.max((coeffs.gapLogA ?? 0) + (coeffs.gapLogB ?? 0) * Math.log(Math.max(gapSC, 1)), 0);
  const GAP_fin  = Math.max(GAP_rate * BA_fin * coeffs.era_gap * cp(coeffs.park_gap), 0);
  const oneB_fin = Math.max(BA_fin - GAP_fin, 0);

  const ssp = (bats === 1 && vR) || (bats === 2 && !vR)
    ? (calScales.ssp_adv_hitting ?? 0.97)
    : 1;
  const finalWoba = ((0.704 * BB_fin + 0.704 * adv_hbp + 0.8992 * oneB_fin + 1.29 * GAP_fin + 2.0759 * HR_fin) / 600) * ssp;
  return finalWoba * sFinal;
}

export function getPitchingScore(card: any, ctx: ScoreCtx): number {
  const { coeffs, derived, calScales, settings } = ctx;

  if (settings.pitchingMetric === "woba") {
    const calcSide = (s: "vR" | "vL"): number => {
      const vR = s === "vR";
      const rawWoba = n(card[`Pitcher wOBA ${s}`]);
      if (!rawWoba) return 0;
      if (!calScales) return rawWoba;

      const BB      = n(card[`Pitcher BB ${s}`]);
      const HR      = n(card[`Pitcher HR ${s}`]);
      const K       = n(card[`Pitcher K ${s}`]);
      const pbabipSC = n(card[`Pitcher PBABIP SC ${s}`]);
      const nHH_raw = n(card[`Pitcher nHH ${s}`]);
      const XBH_raw = n(card[`Pitcher XBH ${s}`]);
      const oneB_raw = Math.max(nHH_raw - XBH_raw, 0);

      const sBB    = vR ? (calScales.pBBScaleVR  ?? 1) : (calScales.pBBScaleVL  ?? 1);
      const sHR    = vR ? (calScales.pHRScaleVR  ?? 1) : (calScales.pHRScaleVL  ?? 1);
      const sFinal = vR ? (calScales.pitchScaleVR ?? 1) : (calScales.pitchScaleVL ?? 1);

      // Step 1: calibration on BB and HR
      const BB_cal = BB * sBB;
      const HR_cal = HR * sHR;

      // Step 2: era/park on BB, HR, K → recompute BIP
      const parkHR  = cp(vR ? coeffs.park_hr_r  : coeffs.park_hr_l);
      const parkAvg = cp(vR ? coeffs.park_avg_r : coeffs.park_avg_l);
      const BB_fin  = BB_cal * coeffs.era_bb;
      const HR_fin  = HR_cal * derived.era_effective_hr * parkHR;
      const K_fin   = K      * coeffs.era_k;
      const adv_hbp = coeffs.adv_hbp ?? 6;
      const BIP_fin = Math.max(600 - BB_fin - adv_hbp - K_fin - HR_fin, 1);

      // Step 3: recompute nHH from softcapped pBABIP + new BIP, apply park_avg
      const nHH_recomputed = Math.max(
        (coeffs.p_nHH_int ?? 0) +
        (coeffs.p_nHH_pbabip ?? 0) * Math.log(Math.max(pbabipSC, 1)) +
        (coeffs.p_nHH_bip ?? 0)    * Math.log(BIP_fin),
        0
      );
      const nHH_norm = nHH_recomputed * (coeffs.p_leagueNorm_h ?? 1);
      const nHH_fin  = nHH_norm * derived.era_h * parkAvg;
      const XBH_fin  = nHH_fin * (coeffs.p_xbh_share ?? 0.25) * (coeffs.p_xbh_norm ?? 1) * coeffs.era_gap * coeffs.park_gap;
      const oneB_fin = Math.max(nHH_fin - XBH_fin, 0);

      const thrHand = n(card["Throws"]);
      const ssp = (thrHand === 2 && vR) || (thrHand === 1 && !vR)
        ? (calScales.ssp_basic_pitching ?? 0.97)
        : 1;
      const finalWoba = ((0.704 * BB_fin + 0.704 * adv_hbp + 0.8992 * oneB_fin + 1.29 * XBH_fin + 2.0759 * HR_fin) / 600) * ssp;
      return finalWoba * sFinal;
    };

    if (settings.pitchingSide === "ovr") {
      const vR = calcSide("vR");
      const vL = calcSide("vL");
      const thr = n(card["Throws"]);
      if (thr === 1) return vR * coeffs.r_pitch_split + vL * (1 - coeffs.r_pitch_split);
      if (thr === 2) return vR * (1 - coeffs.l_pitch_split) + vL * coeffs.l_pitch_split;
      return (vR + vL) / 2;
    }
    if (settings.pitchingSide === "vL")  return calcSide("vL");
    return calcSide("vR");
  }
  // Basic pitching with calibration scale only — crossPoolPitcherMultiplier is LP-only, not for display
  const bpVR = n(card["Basic Pitching vR"]) * (calScales?.pitchScaleVR ?? 1);
  const bpVL = n(card["Basic Pitching vL"]) * (calScales?.pitchScaleVL ?? 1);
  if (settings.pitchingSide === "vL") return bpVL;
  if (settings.pitchingSide === "vR") return bpVR;
  const thrB = n(card["Throws"]);
  if (thrB === 1) return bpVR * coeffs.r_pitch_split + bpVL * (1 - coeffs.r_pitch_split);
  if (thrB === 2) return bpVR * (1 - coeffs.l_pitch_split) + bpVL * coeffs.l_pitch_split;
  return (bpVR + bpVL) / 2;
}
