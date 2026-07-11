// wOBA score (D1): the event pipeline. The model supplies raw event components;
// here we (a) assemble the raw wOBA the old stored column held (for the
// calibration guards), and (b) run the calibration recompute. The recompute
// (calibrate BB/HR → era/park → BIP → BA/GAP or nHH) lives in ONE place
// (hittingComponents/pitchingComponents) and is shared by both the trusted
// display score and the anchor calibration — so there is no second copy of the
// math. Faithful port of getHittingScore / getPitchingScore + calcAnchorWoba.

import type { Coeffs, Derived, CalScales } from "../config/types.ts";
import type { RawHitting, RawPitching } from "../model/types.ts";
import { rate, hRate, HIT_BIP_ADJ, PIT_BIP_ADJ, type EventForm } from "../model/curves.ts";
import { cp, getParkFactor } from "./helpers.ts";
import { wobaWeightsFromCoeffs } from "./woba-weights.ts";

// ── Raw wOBA assembly (per-event weights + ssp) — the stored "wOBA" columns ──
// Weights come from the coeff bag (model-derived when present, else the historical
// constants — bit-identical without a weights-bearing model). See woba-weights.ts.
export function assembleRawHittingWoba(
  e: RawHitting, ssp: number, speed: number, steal: number, run: number, c: Coeffs,
): number {
  const w = wobaWeightsFromCoeffs(c);
  return (((w.bb * e.BB) + (w.hbp * c.adv_hbp) + (w.b1 * e.oneB) + (w.xbh * e.GAP) + (w.hr * e.HR)) / 600 +
    (c.adv_speed * speed) + (c.adv_steal * steal) + (c.adv_run * run)) * ssp;
}

export function assembleRawPitchingWoba(e: RawPitching, ssp: number, c: Coeffs): number {
  const w = wobaWeightsFromCoeffs(c);
  const oneB = e.nHH - e.XBH;
  return ((w.bb * e.BB + w.hbp * c.adv_hbp + w.b1 * oneB + w.xbh * e.XBH + w.hr * e.HR) / 600) * ssp;
}

// ── Shared recompute (the ONE copy) ─────────────────────────────────────────
// calibrate BB/HR with the per-event scales → era/park → recompute BIP →
// recompute BA/GAP (hitting) or nHH/XBH (pitching). Returns the final component
// rates; callers assemble wOBA (with or without ssp / HBP / anchor scalar).

export interface HitComponents { BB_fin: number; HR_fin: number; oneB_fin: number; GAP_fin: number }
export interface PitchComponents { BB_fin: number; HR_fin: number; oneB_fin: number; XBH_fin: number }

export function hittingComponents(
  e: RawHitting, sBB: number, sHR: number, bats: number, side: "vR" | "vL", coeffs: Coeffs, derived: Derived,
  eventForm?: EventForm,
): HitComponents {
  const vR = side === "vR";
  const parkHR = getParkFactor(bats, vR, coeffs.park_hr_r, coeffs.park_hr_l);
  const parkAvg = getParkFactor(bats, vR, coeffs.park_avg_r, coeffs.park_avg_l);
  const BB_fin = e.BB * sBB * coeffs.era_bb;
  const HR_fin = e.HR * sHR * derived.era_effective_hr * parkHR;
  const SO_fin = e.SO * coeffs.era_k;
  // BIP: under eventForm the fitted H-curve was trained on BIP = 600 − BB − K − HR −
  // HIT_BIP_ADJ (shared constant, curves.ts) — evaluate it on the SAME convention.
  // Legacy (no-eventForm, retired log path): the coeff-driven adv_hbp+adv_sh, unchanged.
  const BIP_fin = eventForm
    ? Math.max(600 - BB_fin - SO_fin - HR_fin - HIT_BIP_ADJ, 1)
    : Math.max(600 - BB_fin - (coeffs.adv_hbp ?? 6) - (coeffs.adv_sh ?? 0) - SO_fin - HR_fin, 1);
  // BA (non-HR hit rate) and the GAP-share are RE-DERIVED here because era/park move
  // BIP and hits depend on BIP. With #2 (eventForm present) the re-derivation uses the
  // fitted raw-poly curves (H = log babip+BIP, GAP-share = quad in raw GAP) — the SAME
  // curves the deployed model uses (one core). Otherwise the parity log-linear formulas
  // (e.babipSC/e.gapSC are the raw ratings under #2, the softcapped values under log).
  const BA_raw = eventForm
    ? hRate(eventForm.hit.h, e.babipSC, BIP_fin)
    : Math.max((coeffs.baInt ?? 0) + (coeffs.ba ?? 0) * Math.log(Math.max(e.babipSC, 1)) + (coeffs.bipba ?? 0) * Math.log(BIP_fin), 0);
  const BA_fin = BA_raw * derived.era_h * parkAvg;
  const GAP_rate = eventForm
    ? rate(eventForm.hit.xbh, e.gapSC)
    : Math.max((coeffs.gapLogA ?? 0) + (coeffs.gapLogB ?? 0) * Math.log(Math.max(e.gapSC, 1)), 0);
  const GAP_fin = Math.max(GAP_rate * BA_fin * coeffs.era_gap * cp(coeffs.park_gap), 0);
  const oneB_fin = Math.max(BA_fin - GAP_fin, 0);
  return { BB_fin, HR_fin, oneB_fin, GAP_fin };
}

export function pitchingComponents(
  e: RawPitching, sBB: number, sHR: number, side: "vR" | "vL", coeffs: Coeffs, derived: Derived,
  eventForm?: EventForm,
): PitchComponents {
  const vR = side === "vR";
  const parkHR = cp(vR ? coeffs.park_hr_r : coeffs.park_hr_l);
  const parkAvg = cp(vR ? coeffs.park_avg_r : coeffs.park_avg_l);
  const BB_fin = e.BB * sBB * coeffs.era_bb;
  const HR_fin = e.HR * sHR * derived.era_effective_hr * parkHR;
  const K_fin = e.K * coeffs.era_k;
  // Same convention rule as hitting: eventForm ⇒ the training constant (PIT_BIP_ADJ);
  // legacy ⇒ coeff-driven adv_hbp (production carries 6, so these coincide).
  const BIP_fin = eventForm
    ? Math.max(600 - BB_fin - K_fin - HR_fin - PIT_BIP_ADJ, 1)
    : Math.max(600 - BB_fin - (coeffs.adv_hbp ?? 6) - K_fin - HR_fin, 1);
  // nHH (non-HR hits) is RE-DERIVED here because era/park move BIP. With #2 (eventForm
  // present) it uses the fitted pitcher hit-curve — symmetric with the hitter BA path.
  // #2 is fit to ACTUAL rates, so it carries NO league-norm (p_leagueNorm_h was the log
  // model's level-match; #2 needs none — the per-pool pitch scale handles level). Else
  // the parity log formula + league-norm, untouched.
  const nHH_fin = eventForm
    ? hRate(eventForm.pit.h, e.pbabipSC, BIP_fin) * derived.era_h * parkAvg
    : Math.max((coeffs.p_nHH_int ?? 0) + (coeffs.p_nHH_pbabip ?? 0) * Math.log(Math.max(e.pbabipSC, 1)) + (coeffs.p_nHH_bip ?? 0) * Math.log(BIP_fin), 0)
        * (coeffs.p_leagueNorm_h ?? 1) * derived.era_h * parkAvg;
  // park_gap is COMPRESSED here (cp), same as hitting — all park factors are compressed
  // (post-parity reconciliation: pitching previously used raw park_gap, a parity quirk).
  // #2 uses the fixed 0.25 share (matching the bake-off) and drops p_xbh_norm (old norm).
  const xbhShare = eventForm ? 0.25 : (coeffs.p_xbh_share ?? 0.25) * (coeffs.p_xbh_norm ?? 1);
  const XBH_fin = nHH_fin * xbhShare * coeffs.era_gap * cp(coeffs.park_gap);
  const oneB_fin = Math.max(nHH_fin - XBH_fin, 0);
  return { BB_fin, HR_fin, oneB_fin, XBH_fin };
}

// ── Trusted (calibrated, display) wOBA — getHittingScore / getPitchingScore ──
export function trustedHittingWoba(
  e: RawHitting, rawWoba: number, bats: number, side: "vR" | "vL",
  coeffs: Coeffs, derived: Derived, calScales: CalScales | null, eventForm?: EventForm,
): number {
  if (!rawWoba) return 0;
  if (!calScales) return rawWoba;
  const vR = side === "vR";
  const sBB = vR ? (calScales.hitBBScaleVR ?? 1) : (calScales.hitBBScaleVL ?? 1);
  const sHR = vR ? (calScales.hitHRScaleVR ?? 1) : (calScales.hitHRScaleVL ?? 1);
  const sFinal = vR ? (calScales.hitScaleVR ?? 1) : (calScales.hitScaleVL ?? 1);
  const k = hittingComponents(e, sBB, sHR, bats, side, coeffs, derived, eventForm);
  const w = wobaWeightsFromCoeffs(coeffs);
  const adv_hbp = coeffs.adv_hbp ?? 6;
  const ssp = eventForm ? 1 : ((bats === 1 && vR) || (bats === 2 && !vR) ? (calScales.ssp_adv_hitting ?? 0.97) : 1);
  const finalWoba = ((w.bb * k.BB_fin + w.hbp * adv_hbp + w.b1 * k.oneB_fin + w.xbh * k.GAP_fin + w.hr * k.HR_fin) / 600) * ssp;
  return finalWoba * sFinal;
}

export function trustedPitchingSideWoba(
  e: RawPitching, rawWoba: number, throws: number, side: "vR" | "vL",
  coeffs: Coeffs, derived: Derived, calScales: CalScales | null, eventForm?: EventForm,
): number {
  if (!rawWoba) return 0;
  if (!calScales) return rawWoba;
  const vR = side === "vR";
  const sBB = vR ? (calScales.pBBScaleVR ?? 1) : (calScales.pBBScaleVL ?? 1);
  const sHR = vR ? (calScales.pHRScaleVR ?? 1) : (calScales.pHRScaleVL ?? 1);
  const sFinal = vR ? (calScales.pitchScaleVR ?? 1) : (calScales.pitchScaleVL ?? 1);
  const k = pitchingComponents(e, sBB, sHR, side, coeffs, derived, eventForm);
  const w = wobaWeightsFromCoeffs(coeffs);
  const adv_hbp = coeffs.adv_hbp ?? 6;
  const ssp = eventForm ? 1 : ((throws === 2 && vR) || (throws === 1 && !vR) ? (calScales.ssp_basic_pitching ?? 0.97) : 1);
  const finalWoba = ((w.bb * k.BB_fin + w.hbp * adv_hbp + w.b1 * k.oneB_fin + w.xbh * k.XBH_fin + w.hr * k.HR_fin) / 600) * ssp;
  return finalWoba * sFinal;
}

// ── Anchor wOBA (calibration only) — port of calcAnchorWoba ──────────────────
// The anchor uses the SAME event terms as the trusted assemblies (incl. HBP), so
// anchoring the top-50 mean to TARGET_WOBA puts the trusted scores themselves at
// the target — no constant cross-role offset. (The old-app anchor omitted HBP; that
// quirk was reconciled 2026-07-11 post-parity-sunset.) ssp is deliberately absent:
// under eventForm ssp ≡ 1, and the legacy log path keeps the old anchor semantics.
export function anchorHittingWoba(
  e: RawHitting, sBB: number, sHR: number, bats: number, side: "vR" | "vL", coeffs: Coeffs, derived: Derived,
  eventForm?: EventForm,
): number {
  const k = hittingComponents(e, sBB, sHR, bats, side, coeffs, derived, eventForm);
  const w = wobaWeightsFromCoeffs(coeffs);
  return (w.bb * k.BB_fin + w.hbp * (coeffs.adv_hbp ?? 6) + w.b1 * k.oneB_fin + w.xbh * k.GAP_fin + w.hr * k.HR_fin) / 600;
}

export function anchorPitchingWoba(
  e: RawPitching, sBB: number, sHR: number, side: "vR" | "vL", coeffs: Coeffs, derived: Derived,
  eventForm?: EventForm,
): number {
  const k = pitchingComponents(e, sBB, sHR, side, coeffs, derived, eventForm);
  const w = wobaWeightsFromCoeffs(coeffs);
  return (w.bb * k.BB_fin + w.hbp * (coeffs.adv_hbp ?? 6) + w.b1 * k.oneB_fin + w.xbh * k.XBH_fin + w.hr * k.HR_fin) / 600;
}
