// Config types for the rebuild. For Step 1 (parity) the coefficient SHAPE mirrors
// the old app's single bag so captured `ootp_coeffs_v2` deserializes directly.
// D4 (separating model-scoped vs tournament-scoped vs derived) is a later step;
// here we keep one bag and a logical model/calibration seam in code.

import type { EventForm } from "../model/curves.ts";
import type { PoolTransform } from "../model/pool-transform.ts";

export type Side = "vR" | "vL";

export interface Coeffs {
  tournament_hr_adjust: boolean;

  // Park
  park_avg_l: number; park_avg_r: number;
  park_hr_l: number;  park_hr_r: number;
  park_gap: number;

  // Era
  era_bb: number; era_k: number; era_avg: number; era_hr: number;
  era_bip: number; era_gap: number; era_thr: number;
  // Per-BIP non-HR-hit era factor, computed from the era's rates block at resolve time
  // (resolveCoeffs). When present it REPLACES the era_avg-derived era_h — era_avg is a
  // per-PA ratio, but era_h multiplies a per-BIP quantity in the recompute, so deriving
  // one from the other double-counts the era's K/BB-driven BIP expansion (the dead-ball
  // 1B over-prediction; plan doc §10). Absent (captures, synthetic/neutral eras) ⇒ the
  // legacy per-PA derivation applies unchanged.
  era_h_bip?: number;

  // Soft caps (hitting)
  cap_k_top: number;     cap_k_bot: number;     pen_k: number;
  cap_babip_top: number; cap_babip_bot: number; pen_babip: number;
  cap_gap_top: number;   cap_gap_bot: number;   pen_gap: number;
  cap_pow_top: number;   cap_pow_bot: number;   pen_pow: number;
  cap_eye_top: number;   cap_eye_bot: number;   pen_eye: number;

  // Soft caps (pitching)
  cap_p_con_top: number;    cap_p_con_bot: number;    pen_p_con: number;
  cap_p_stu_top: number;    cap_p_stu_bot: number;    pen_p_stu: number;
  cap_p_pbabip_top: number; cap_p_pbabip_bot: number; pen_p_pbabip: number;
  cap_p_hrr_top: number;    cap_p_hrr_bot: number;    pen_p_hrr: number;

  // Splits & penalties
  ssp_basic_hitting: number; ssp_adv_hitting: number; ssp_basic_pitching: number;
  l_pitch_split: number; r_pitch_split: number;
  l_hit_split: number;   r_hit_split: number;
  // s_hit_split (switch-hitter OVR split) is carried via the string index signature, optional —
  // absent ⇒ 0.5 (parity). Not declared explicitly: an optional field conflicts with the index type.

  // Basic model
  basic_intercept: number;
  w_babip: number; w_pow: number; w_eye: number; w_k: number; w_gap: number;
  w_speed: number; w_run: number; w_steal: number;

  // Advanced hitting weights
  adv_speed: number; adv_run: number; adv_steal: number;
  adv_sf: number; adv_sh: number; adv_hbp: number;

  // Advanced hitting model
  ba: number; bipba: number; baInt: number;
  gapLogA: number; gapLogB: number;
  k: number; kInt: number; kbb600: number;
  eye: number; eyeInt: number;
  pow: number; powInt: number;

  // Basic pitching
  p_stuff: number; p_control: number; p_babip: number; p_hr: number; p_hold: number;

  // HR adjustment GB map
  hradj_exgb: number; hradj_gb: number; hradj_neu: number; hradj_fb: number; hradj_exfb: number;

  // Advanced pitching model
  p_bb_int: number; p_bb_con: number;
  p_k_int: number;  p_k_stu: number;
  p_hr_int: number; p_hr_hrr: number;
  p_nHH_int: number; p_nHH_pbabip: number; p_nHH_bip: number;
  p_xbh_share: number; p_xbh_norm: number;
  p_leagueNorm_bb: number; p_leagueNorm_hr: number; p_leagueNorm_h: number;

  // tolerate extra keys present in captures (position weights, etc.); undefined admits
  // the optional resolver-attached fields (era_h_bip)
  [key: string]: number | boolean | undefined;
}

// Pool-dependent calibration/anchor scales (from the old backend calcAnchorWoba,
// captured from localStorage `ootp.calibrationScales`). All optional — the trusted
// score functions default each to 1 when absent.
export interface CalScales {
  hitBBScaleVR?: number; hitBBScaleVL?: number;
  hitHRScaleVR?: number; hitHRScaleVL?: number;
  hitScaleVR?: number;   hitScaleVL?: number;
  pBBScaleVR?: number;   pBBScaleVL?: number;
  pHRScaleVR?: number;   pHRScaleVL?: number;
  pitchScaleVR?: number; pitchScaleVL?: number;
  crossPoolHitterMultiplier?: number;
  crossPoolPitcherMultiplier?: number;
  ssp_adv_hitting?: number;
  ssp_basic_pitching?: number;
  [key: string]: number | undefined;
}

export interface Derived {
  era_h: number;
  era_effective_hr: number;
}

export interface ScoreSettings {
  hittingMetric: "basic" | "woba";
  pitchingMetric: "basic" | "woba";
  pitchingSide: "vR" | "vL" | "ovr";
}

// Everything the core needs to score a card: model+softcap+env coeffs, the
// derived era values, and the pool-dependent calibration scales.
//
// `eventForm` (D3 #2 raw-poly) is OPTIONAL: present ⇒ the deployed scorer uses the
// raw-poly event model + its fitted curves in the woba.ts recompute; ABSENT ⇒ the
// parity log-linear path, bit-identical to before. The fitted params travel here in
// a dedicated field, NOT folded into the flat `Coeffs` bag.
export interface ScoringConfig {
  coeffs: Coeffs;
  derived: Derived;
  calScales: CalScales | null;
  eventForm?: EventForm;
  // Pool-strength rating transform (z-score), applied to ratings BEFORE the model.
  // Absent ⇒ no transform (bit-identical scores). Present ⇒ the pool is re-based onto
  // the league reference frame. See src/model/pool-transform.ts.
  poolTransform?: PoolTransform;
}
