// Log-linear event model — faithful port of the old app's advHittingSide /
// advPitchingSide (single ln term per event, weighted-least-squares-fit
// coefficients supplied via Coeffs). This is ONE implementation behind the D3
// EventModel seam; the bake-off will add others without touching the core.

import type { Coeffs } from "../config/types.ts";
import { softcap } from "../scoring-core/helpers.ts";
import type { EventModel, HittingRatings, PitchingRatings, RawHitting, RawPitching } from "./types.ts";

function predictHitting(r: HittingRatings, c: Coeffs): RawHitting {
  const eyeSC = softcap(r.eye, c.cap_eye_top, c.cap_eye_bot, c.pen_eye);
  const BB = Math.max(c.eyeInt + c.eye * Math.log(Math.max(eyeSC, 1)), 0);

  const powSC = softcap(r.pow, c.cap_pow_top, c.cap_pow_bot, c.pen_pow);
  const HR = Math.max(c.powInt + c.pow * Math.log(Math.max(powSC, 1)), 0);

  const Ksc = softcap(r.kRat, c.cap_k_top, c.cap_k_bot, c.pen_k);
  const SO = Math.min(Math.max(c.kInt + c.k * Math.log(Math.max(Ksc, 1)) + c.kbb600 * BB, 0), 600 - BB - HR);

  const AB = 600 - BB - c.adv_sf - c.adv_sh - c.adv_hbp;
  const babipSC = softcap(r.babip, c.cap_babip_top, c.cap_babip_bot, c.pen_babip);
  const BIP = Math.max(AB - SO - HR + c.adv_sf, 1);

  const BA = Math.max(c.baInt + c.ba * Math.log(Math.max(babipSC, 1)) + c.bipba * Math.log(Math.max(BIP, 1)), 0);

  const gapSC = Math.max(softcap(r.gap, c.cap_gap_top, c.cap_gap_bot, c.pen_gap), 1);
  const GAP = Math.max((c.gapLogA + c.gapLogB * Math.log(gapSC)) * BA, 0);

  const oneB = Math.max(BA - GAP, 0);

  return { BB, SO, oneB, GAP, HR, AB, BIP, babipSC, gapSC };
}

function predictPitching(r: PitchingRatings, c: Coeffs): RawPitching {
  const CON    = softcap(r.con,    c.cap_p_con_top,    c.cap_p_con_bot,    c.pen_p_con);
  const STU    = softcap(r.stu,    c.cap_p_stu_top,    c.cap_p_stu_bot,    c.pen_p_stu);
  const PBABIP = softcap(r.pbabip, c.cap_p_pbabip_top, c.cap_p_pbabip_bot, c.pen_p_pbabip);
  const HRR    = softcap(r.hrr,    c.cap_p_hrr_top,    c.cap_p_hrr_bot,    c.pen_p_hrr);

  const BB  = Math.max(c.p_bb_int + c.p_bb_con * Math.log(Math.max(CON, 1)), 0);
  const K   = Math.min(Math.max(c.p_k_int + c.p_k_stu * Math.log(Math.max(STU, 1)), 0), 600 - BB);
  const HR  = Math.max(c.p_hr_int + c.p_hr_hrr * Math.log(Math.max(HRR, 1)), 0);
  const AB  = 600 - BB - c.adv_hbp;
  const BIP = Math.max(AB - K - HR, 1);
  const nHH_raw = Math.max(c.p_nHH_int + c.p_nHH_pbabip * Math.log(Math.max(PBABIP, 1)) + c.p_nHH_bip * Math.log(Math.max(BIP, 1)), 0);

  const BB_n  = BB      * (c.p_leagueNorm_bb ?? 1);
  const HR_n  = HR      * (c.p_leagueNorm_hr ?? 1);
  const nHH_n = nHH_raw * (c.p_leagueNorm_h  ?? 1);
  const XBH   = nHH_n   * c.p_xbh_share * (c.p_xbh_norm ?? 1);

  return { BB: BB_n, K, HR: HR_n, nHH: nHH_n, XBH, pbabipSC: PBABIP };
}

export const logLinearModel: EventModel = { predictHitting, predictPitching };
