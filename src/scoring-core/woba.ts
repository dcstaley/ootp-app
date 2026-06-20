// wOBA score (D1): the event pipeline. The model supplies raw event components;
// here we (a) assemble the raw wOBA the old stored column held (needed only for
// the calibration guards), then (b) run the trusted calibration pipeline:
//   calibrate BB/HR → era/park → recompute BIP → recompute BA/GAP(or nHH) →
//   assemble wOBA → ssp → uniform pool anchor (sFinal).
// Faithful port of getHittingScore / getPitchingScore from the old roster page.

import type { Coeffs, Derived, CalScales } from "../config/types.ts";
import type { RawHitting, RawPitching } from "../model/types.ts";
import { cp, getParkFactor } from "./helpers.ts";

// ── Raw wOBA assembly (fixed wOBA weights + ssp) ────────────────────────────
// Matches the old advHittingSide / advPitchingSide `.woba` line, which became the
// stored "wOBA"/"Pitcher wOBA" columns. The calibration layer reads these only to
// short-circuit (return 0 if raw is 0; return raw if no calibration scales).

export function assembleRawHittingWoba(
  e: RawHitting, ssp: number, speed: number, steal: number, run: number, c: Coeffs,
): number {
  return (((0.704 * e.BB) + (0.704 * c.adv_hbp) + (0.8992 * e.oneB) + (1.29 * e.GAP) + (2.0759 * e.HR)) / 600 +
    (c.adv_speed * speed) + (c.adv_steal * steal) + (c.adv_run * run)) * ssp;
}

export function assembleRawPitchingWoba(e: RawPitching, ssp: number, c: Coeffs): number {
  const oneB = e.nHH - e.XBH;
  return ((0.704 * e.BB + 0.704 * c.adv_hbp + 0.8992 * oneB + 1.29 * e.XBH + 2.0759 * e.HR) / 600) * ssp;
}

// ── Trusted (calibrated) hitting wOBA — port of getHittingScore woba branch ──
export function trustedHittingWoba(
  e: RawHitting, rawWoba: number, bats: number, side: "vR" | "vL",
  coeffs: Coeffs, derived: Derived, calScales: CalScales | null,
): number {
  if (!rawWoba) return 0;
  if (!calScales) return rawWoba;

  const vR = side === "vR";
  const sBB    = vR ? (calScales.hitBBScaleVR ?? 1) : (calScales.hitBBScaleVL ?? 1);
  const sHR    = vR ? (calScales.hitHRScaleVR ?? 1) : (calScales.hitHRScaleVL ?? 1);
  const sFinal = vR ? (calScales.hitScaleVR   ?? 1) : (calScales.hitScaleVL   ?? 1);

  // Step 1: calibration on BB and HR
  const BB_cal = e.BB * sBB;
  const HR_cal = e.HR * sHR;

  // Step 2: era/park on BB, HR, K → recompute BIP
  const parkHR  = getParkFactor(bats, vR, coeffs.park_hr_r,  coeffs.park_hr_l);
  const parkAvg = getParkFactor(bats, vR, coeffs.park_avg_r, coeffs.park_avg_l);
  const BB_fin  = BB_cal * coeffs.era_bb;
  const HR_fin  = HR_cal * derived.era_effective_hr * parkHR;
  const SO_fin  = e.SO   * coeffs.era_k;
  const adv_hbp = coeffs.adv_hbp ?? 6;
  const adv_sh  = coeffs.adv_sh  ?? 0;
  const BIP_fin = Math.max(600 - BB_fin - adv_hbp - adv_sh - SO_fin - HR_fin, 1);

  // Step 3: recompute BA from softcapped babip + new BIP, apply park_avg
  const BA_raw  = Math.max((coeffs.baInt ?? 0) + (coeffs.ba ?? 0) * Math.log(Math.max(e.babipSC, 1)) + (coeffs.bipba ?? 0) * Math.log(BIP_fin), 0);
  const BA_fin  = BA_raw * derived.era_h * parkAvg;

  // Step 4: recompute GAP and 1B from new BA
  const GAP_rate = Math.max((coeffs.gapLogA ?? 0) + (coeffs.gapLogB ?? 0) * Math.log(Math.max(e.gapSC, 1)), 0);
  const GAP_fin  = Math.max(GAP_rate * BA_fin * coeffs.era_gap * cp(coeffs.park_gap), 0);
  const oneB_fin = Math.max(BA_fin - GAP_fin, 0);

  const ssp = (bats === 1 && vR) || (bats === 2 && !vR)
    ? (calScales.ssp_adv_hitting ?? 0.97)
    : 1;
  const finalWoba = ((0.704 * BB_fin + 0.704 * adv_hbp + 0.8992 * oneB_fin + 1.29 * GAP_fin + 2.0759 * HR_fin) / 600) * ssp;
  return finalWoba * sFinal;
}

// ── Trusted (calibrated) pitching wOBA per side — port of getPitchingScore ───
export function trustedPitchingSideWoba(
  e: RawPitching, rawWoba: number, throws: number, side: "vR" | "vL",
  coeffs: Coeffs, derived: Derived, calScales: CalScales | null,
): number {
  if (!rawWoba) return 0;
  if (!calScales) return rawWoba;

  const vR = side === "vR";
  const sBB    = vR ? (calScales.pBBScaleVR  ?? 1) : (calScales.pBBScaleVL  ?? 1);
  const sHR    = vR ? (calScales.pHRScaleVR  ?? 1) : (calScales.pHRScaleVL  ?? 1);
  const sFinal = vR ? (calScales.pitchScaleVR ?? 1) : (calScales.pitchScaleVL ?? 1);

  // Step 1: calibration on BB and HR
  const BB_cal = e.BB * sBB;
  const HR_cal = e.HR * sHR;

  // Step 2: era/park on BB, HR, K → recompute BIP (note: raw park_*_r/l by side,
  // NOT handedness-based — matches the old getPitchingScore).
  const parkHR  = cp(vR ? coeffs.park_hr_r  : coeffs.park_hr_l);
  const parkAvg = cp(vR ? coeffs.park_avg_r : coeffs.park_avg_l);
  const BB_fin  = BB_cal * coeffs.era_bb;
  const HR_fin  = HR_cal * derived.era_effective_hr * parkHR;
  const K_fin   = e.K    * coeffs.era_k;
  const adv_hbp = coeffs.adv_hbp ?? 6;
  const BIP_fin = Math.max(600 - BB_fin - adv_hbp - K_fin - HR_fin, 1);

  // Step 3: recompute nHH from softcapped pBABIP + new BIP, apply park_avg.
  // QUIRK (replicate, reconcile post-parity): XBH here uses RAW era_gap & park_gap
  // (no cp()), unlike hitting which uses cp(park_gap).
  const nHH_recomputed = Math.max(
    (coeffs.p_nHH_int ?? 0) +
    (coeffs.p_nHH_pbabip ?? 0) * Math.log(Math.max(e.pbabipSC, 1)) +
    (coeffs.p_nHH_bip ?? 0)    * Math.log(BIP_fin),
    0,
  );
  const nHH_norm = nHH_recomputed * (coeffs.p_leagueNorm_h ?? 1);
  const nHH_fin  = nHH_norm * derived.era_h * parkAvg;
  const XBH_fin  = nHH_fin * (coeffs.p_xbh_share ?? 0.25) * (coeffs.p_xbh_norm ?? 1) * coeffs.era_gap * coeffs.park_gap;
  const oneB_fin = Math.max(nHH_fin - XBH_fin, 0);

  const ssp = (throws === 2 && vR) || (throws === 1 && !vR)
    ? (calScales.ssp_basic_pitching ?? 0.97)
    : 1;
  const finalWoba = ((0.704 * BB_fin + 0.704 * adv_hbp + 0.8992 * oneB_fin + 1.29 * XBH_fin + 2.0759 * HR_fin) / 600) * ssp;
  return finalWoba * sFinal;
}
