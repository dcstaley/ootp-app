// Basic score (D1): a direct score from ratings, with era/park folded into each
// rating's contribution (no event modeling, no BIP recompute, no per-event
// calibration). Faithful port of the old basicHittingSide / basicPitchingSide.

import type { Coeffs } from "../config/types.ts";
import { gbMult, softcap } from "./helpers.ts";

export function basicHittingSide(input: {
  babipRaw: number; powRaw: number; eyeRaw: number; kRaw: number; gapRaw: number;
  babipMod: number; powMod: number; eyeMod: number; kMod: number; gapMod: number;
  ssp: number;
  speed: number; run: number; steal: number;
  coeffs: Coeffs;
}): number {
  const c = input.coeffs;
  const babipSc = Math.max(softcap(input.babipRaw, c.cap_babip_top, c.cap_babip_bot, c.pen_babip), 1);
  const powSc   = Math.max(softcap(input.powRaw,   c.cap_pow_top,   c.cap_pow_bot,   c.pen_pow), 1);
  const eyeSc   = Math.max(softcap(input.eyeRaw,   c.cap_eye_top,   c.cap_eye_bot,   c.pen_eye), 1);
  const kSc     = Math.max(softcap(input.kRaw,     c.cap_k_top,     c.cap_k_bot,     c.pen_k), 1);
  const gapSc   = Math.max(softcap(input.gapRaw,   c.cap_gap_top,   c.cap_gap_bot,   c.pen_gap), 1);

  const bH = (w: number, x: number) => w * Math.log(Math.max(x, 15));
  return (c.basic_intercept ?? 0) + (
    bH(c.w_babip, babipSc) * input.babipMod +
    bH(c.w_pow,   powSc)   * input.powMod +
    bH(c.w_eye,   eyeSc)   * input.eyeMod +
    bH(c.w_k,     kSc)     * input.kMod +
    bH(c.w_gap,   gapSc)   * input.gapMod
  ) * input.ssp +
  c.w_speed * input.speed +
  c.w_run * input.run +
  c.w_steal * input.steal;
}

export function basicPitchingSide(input: {
  stuffRaw: number; ctrlRaw: number; pbabipRaw: number; hrrRaw: number; gb: number;
  eraK: number; eraBb: number; eraBabipParkAvg: number; eraEffHrParkHr: number;
  ssp: number; hold: number;
  coeffs: Coeffs;
}): number {
  const c = input.coeffs;
  const stuffSc  = softcap(input.stuffRaw,  c.cap_p_stu_top,    c.cap_p_stu_bot,    c.pen_p_stu);
  const ctrlSc   = softcap(input.ctrlRaw,   c.cap_p_con_top,    c.cap_p_con_bot,    c.pen_p_con);
  const pbabipSc = softcap(input.pbabipRaw, c.cap_p_pbabip_top, c.cap_p_pbabip_bot, c.pen_p_pbabip);
  const mult = gbMult(input.gb, c);
  const hrAdjSc  = softcap(input.hrrRaw, c.cap_p_hrr_top, c.cap_p_hrr_bot, c.pen_p_hrr) * mult;

  const bP = (w: number, x: number) => w * Math.log(Math.max(x, 15));
  return (c.basic_intercept ?? 0) + (
    bP(c.p_stuff,   stuffSc)  * input.eraK +
    bP(c.p_control, ctrlSc)   * input.eraBb +
    bP(c.p_babip,   pbabipSc) * input.eraBabipParkAvg +
    bP(c.p_hr,      hrAdjSc)  * input.eraEffHrParkHr
  ) * input.ssp + (c.p_hold ?? 0) * input.hold;
}
