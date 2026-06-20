// wOBA score (D1): the event pipeline. The model supplies raw event components;
// here we (a) assemble the raw wOBA the old stored column held (for the
// calibration guards), and (b) run the calibration recompute. The recompute
// (calibrate BB/HR → era/park → BIP → BA/GAP or nHH) lives in ONE place
// (hittingComponents/pitchingComponents) and is shared by both the trusted
// display score and the anchor calibration — so there is no second copy of the
// math. Faithful port of getHittingScore / getPitchingScore + calcAnchorWoba.

import type { Coeffs, Derived, CalScales } from "../config/types.ts";
import type { RawHitting, RawPitching } from "../model/types.ts";
import { cp, getParkFactor } from "./helpers.ts";

// ── Raw wOBA assembly (fixed weights + ssp) — the stored "wOBA" columns ──────
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

// ── Shared recompute (the ONE copy) ─────────────────────────────────────────
// calibrate BB/HR with the per-event scales → era/park → recompute BIP →
// recompute BA/GAP (hitting) or nHH/XBH (pitching). Returns the final component
// rates; callers assemble wOBA (with or without ssp / HBP / anchor scalar).

export interface HitComponents { BB_fin: number; HR_fin: number; oneB_fin: number; GAP_fin: number }
export interface PitchComponents { BB_fin: number; HR_fin: number; oneB_fin: number; XBH_fin: number }

export function hittingComponents(
  e: RawHitting, sBB: number, sHR: number, bats: number, side: "vR" | "vL", coeffs: Coeffs, derived: Derived,
): HitComponents {
  const vR = side === "vR";
  const parkHR = getParkFactor(bats, vR, coeffs.park_hr_r, coeffs.park_hr_l);
  const parkAvg = getParkFactor(bats, vR, coeffs.park_avg_r, coeffs.park_avg_l);
  const BB_fin = e.BB * sBB * coeffs.era_bb;
  const HR_fin = e.HR * sHR * derived.era_effective_hr * parkHR;
  const SO_fin = e.SO * coeffs.era_k;
  const adv_hbp = coeffs.adv_hbp ?? 6;
  const adv_sh = coeffs.adv_sh ?? 0;
  const BIP_fin = Math.max(600 - BB_fin - adv_hbp - adv_sh - SO_fin - HR_fin, 1);
  const BA_raw = Math.max((coeffs.baInt ?? 0) + (coeffs.ba ?? 0) * Math.log(Math.max(e.babipSC, 1)) + (coeffs.bipba ?? 0) * Math.log(BIP_fin), 0);
  const BA_fin = BA_raw * derived.era_h * parkAvg;
  const GAP_rate = Math.max((coeffs.gapLogA ?? 0) + (coeffs.gapLogB ?? 0) * Math.log(Math.max(e.gapSC, 1)), 0);
  const GAP_fin = Math.max(GAP_rate * BA_fin * coeffs.era_gap * cp(coeffs.park_gap), 0);
  const oneB_fin = Math.max(BA_fin - GAP_fin, 0);
  return { BB_fin, HR_fin, oneB_fin, GAP_fin };
}

export function pitchingComponents(
  e: RawPitching, sBB: number, sHR: number, side: "vR" | "vL", coeffs: Coeffs, derived: Derived,
): PitchComponents {
  const vR = side === "vR";
  const parkHR = cp(vR ? coeffs.park_hr_r : coeffs.park_hr_l);
  const parkAvg = cp(vR ? coeffs.park_avg_r : coeffs.park_avg_l);
  const BB_fin = e.BB * sBB * coeffs.era_bb;
  const HR_fin = e.HR * sHR * derived.era_effective_hr * parkHR;
  const K_fin = e.K * coeffs.era_k;
  const adv_hbp = coeffs.adv_hbp ?? 6;
  const BIP_fin = Math.max(600 - BB_fin - adv_hbp - K_fin - HR_fin, 1);
  const nHH = Math.max(
    (coeffs.p_nHH_int ?? 0) + (coeffs.p_nHH_pbabip ?? 0) * Math.log(Math.max(e.pbabipSC, 1)) + (coeffs.p_nHH_bip ?? 0) * Math.log(BIP_fin),
    0,
  );
  const nHH_norm = nHH * (coeffs.p_leagueNorm_h ?? 1);
  const nHH_fin = nHH_norm * derived.era_h * parkAvg;
  // QUIRK (replicate, reconcile post-parity): XBH uses RAW era_gap & park_gap (no cp()),
  // unlike hitting which uses cp(park_gap).
  const XBH_fin = nHH_fin * (coeffs.p_xbh_share ?? 0.25) * (coeffs.p_xbh_norm ?? 1) * coeffs.era_gap * coeffs.park_gap;
  const oneB_fin = Math.max(nHH_fin - XBH_fin, 0);
  return { BB_fin, HR_fin, oneB_fin, XBH_fin };
}

// ── Trusted (calibrated, display) wOBA — getHittingScore / getPitchingScore ──
export function trustedHittingWoba(
  e: RawHitting, rawWoba: number, bats: number, side: "vR" | "vL",
  coeffs: Coeffs, derived: Derived, calScales: CalScales | null,
): number {
  if (!rawWoba) return 0;
  if (!calScales) return rawWoba;
  const vR = side === "vR";
  const sBB = vR ? (calScales.hitBBScaleVR ?? 1) : (calScales.hitBBScaleVL ?? 1);
  const sHR = vR ? (calScales.hitHRScaleVR ?? 1) : (calScales.hitHRScaleVL ?? 1);
  const sFinal = vR ? (calScales.hitScaleVR ?? 1) : (calScales.hitScaleVL ?? 1);
  const k = hittingComponents(e, sBB, sHR, bats, side, coeffs, derived);
  const adv_hbp = coeffs.adv_hbp ?? 6;
  const ssp = (bats === 1 && vR) || (bats === 2 && !vR) ? (calScales.ssp_adv_hitting ?? 0.97) : 1;
  const finalWoba = ((0.704 * k.BB_fin + 0.704 * adv_hbp + 0.8992 * k.oneB_fin + 1.29 * k.GAP_fin + 2.0759 * k.HR_fin) / 600) * ssp;
  return finalWoba * sFinal;
}

export function trustedPitchingSideWoba(
  e: RawPitching, rawWoba: number, throws: number, side: "vR" | "vL",
  coeffs: Coeffs, derived: Derived, calScales: CalScales | null,
): number {
  if (!rawWoba) return 0;
  if (!calScales) return rawWoba;
  const vR = side === "vR";
  const sBB = vR ? (calScales.pBBScaleVR ?? 1) : (calScales.pBBScaleVL ?? 1);
  const sHR = vR ? (calScales.pHRScaleVR ?? 1) : (calScales.pHRScaleVL ?? 1);
  const sFinal = vR ? (calScales.pitchScaleVR ?? 1) : (calScales.pitchScaleVL ?? 1);
  const k = pitchingComponents(e, sBB, sHR, side, coeffs, derived);
  const adv_hbp = coeffs.adv_hbp ?? 6;
  const ssp = (throws === 2 && vR) || (throws === 1 && !vR) ? (calScales.ssp_basic_pitching ?? 0.97) : 1;
  const finalWoba = ((0.704 * k.BB_fin + 0.704 * adv_hbp + 0.8992 * k.oneB_fin + 1.29 * k.XBH_fin + 2.0759 * k.HR_fin) / 600) * ssp;
  return finalWoba * sFinal;
}

// ── Anchor wOBA (calibration only) — port of calcAnchorWoba ──────────────────
// QUIRK (replicate): the anchor wOBA omits BOTH ssp AND the 0.704*HBP term that
// the display score includes (HBP is still used in the BIP subtraction inside
// the components). Flagged for post-parity reconciliation.
export function anchorHittingWoba(
  e: RawHitting, sBB: number, sHR: number, bats: number, side: "vR" | "vL", coeffs: Coeffs, derived: Derived,
): number {
  const k = hittingComponents(e, sBB, sHR, bats, side, coeffs, derived);
  return (0.704 * k.BB_fin + 0.8992 * k.oneB_fin + 1.29 * k.GAP_fin + 2.0759 * k.HR_fin) / 600;
}

export function anchorPitchingWoba(
  e: RawPitching, sBB: number, sHR: number, side: "vR" | "vL", coeffs: Coeffs, derived: Derived,
): number {
  const k = pitchingComponents(e, sBB, sHR, side, coeffs, derived);
  return (0.704 * k.BB_fin + 0.8992 * k.oneB_fin + 1.29 * k.XBH_fin + 2.0759 * k.HR_fin) / 600;
}
