// GOLDEN HARNESS — verbatim copy of C:\ootp_app\frontend\lib\scoringCore.ts
// DO NOT EDIT THE FORMULA BODIES. This is the old app's authoritative per-card
// scoring core, used only to generate reference ("golden") numbers the rebuild
// must reproduce. Pure functions; no React, no app state.

export type Side = "vR" | "vL";

export function n(v: any): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

export function softcap(x: number, top: number, bot: number, pen: number): number {
  if (!Number.isFinite(x)) return x;
  if (x > top) return top + (x - top) * (1 - pen);
  if (x < bot) return x - (bot - x) * pen;
  return x;
}

// Park factor compression: OOTP engine applies park factors non-linearly.
// A park factor of 2.0 increases outcomes by ~26%, not 100%.
// Compression formula: 1 + (park - 1) * PARK_COMPRESSION
export const PARK_COMPRESSION = 0.26;
export const cp = (p: number): number => 1 + (p - 1) * PARK_COMPRESSION;

export function parkAvgFactor(bats: number, side: Side, c: any): number {
  if (side === "vR") {
    if (bats === 1) return cp(c.park_avg_r);
    if (bats === 2) return cp(c.park_avg_l);
    if (bats === 3) return cp(c.park_avg_l);
    return 1;
  } else {
    if (bats === 1) return cp(c.park_avg_r);
    if (bats === 2) return cp(c.park_avg_l);
    if (bats === 3) return cp(c.park_avg_r);
    return 1;
  }
}

export function parkHrFactor(bats: number, side: Side, c: any): number {
  if (side === "vR") {
    if (bats === 1) return cp(c.park_hr_r);
    if (bats === 2) return cp(c.park_hr_l);
    if (bats === 3) return cp(c.park_hr_l);
    return 1;
  } else {
    if (bats === 1) return cp(c.park_hr_r);
    if (bats === 2) return cp(c.park_hr_l);
    if (bats === 3) return cp(c.park_hr_r);
    return 1;
  }
}

export function sameSidePenaltyHitting(bats: number, side: Side, ssp: number): number {
  if (side === "vR") return bats === 1 ? ssp : 1;
  return bats === 2 ? ssp : 1;
}

export function sameSidePenaltyPitching(throws: number, side: Side, ssp: number): number {
  if (side === "vR") return throws === 2 ? ssp : 1;
  return throws === 1 ? ssp : 1;
}

export function gbMult(gb: number, c: any): number {
  switch (gb) {
    case 0: return c.hradj_exgb;
    case 1: return c.hradj_gb;
    case 2: return c.hradj_neu;
    case 3: return c.hradj_fb;
    case 4: return c.hradj_exfb;
    default: return 1;
  }
}

// ── Basic Hitting (per side) ────────────────────────────────────────────────
export function basicHittingSide(input: {
  babipRaw: number; powRaw: number; eyeRaw: number; kRaw: number; gapRaw: number;
  babipMod: number; powMod: number; eyeMod: number; kMod: number; gapMod: number;
  ssp: number;
  speed: number; run: number; steal: number;
  coeffs: any;
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

// ── Advanced Hitting / wOBA (per side) ──────────────────────────────────────
export function advHittingSide(input: {
  eyeRaw: number; powRaw: number; kRaw: number; babipRaw: number; gapRaw: number;
  speed: number; steal: number; run: number;
  ssp: number;
  coeffs: any;
}): { woba: number; BB: number; SO: number; oneB: number; GAP: number; HR: number; AB: number; BIP: number; babipSC: number; gapSC: number } {
  const c = input.coeffs;

  const eyeSC = softcap(input.eyeRaw, c.cap_eye_top, c.cap_eye_bot, c.pen_eye);
  const BB = Math.max(c.eyeInt + c.eye * Math.log(Math.max(eyeSC, 1)), 0);

  const powSC = softcap(input.powRaw, c.cap_pow_top, c.cap_pow_bot, c.pen_pow);
  const HR = Math.max(c.powInt + c.pow * Math.log(Math.max(powSC, 1)), 0);

  const Ksc = softcap(input.kRaw, c.cap_k_top, c.cap_k_bot, c.pen_k);
  const SO = Math.min(Math.max(c.kInt + c.k * Math.log(Math.max(Ksc, 1)) + c.kbb600 * BB, 0), 600 - BB - HR);

  const AB = 600 - BB - c.adv_sf - c.adv_sh - c.adv_hbp;
  const babipSC = softcap(input.babipRaw, c.cap_babip_top, c.cap_babip_bot, c.pen_babip);
  const BIP = Math.max(AB - SO - HR + c.adv_sf, 1);

  const BA = Math.max(c.baInt + c.ba * Math.log(Math.max(babipSC, 1)) + c.bipba * Math.log(Math.max(BIP, 1)), 0);

  const gapSC = Math.max(softcap(input.gapRaw, c.cap_gap_top, c.cap_gap_bot, c.pen_gap), 1);
  const GAP = Math.max((c.gapLogA + c.gapLogB * Math.log(gapSC)) * BA, 0);

  const oneB = Math.max(BA - GAP, 0);

  const woba = (((0.704 * BB) + (0.704 * c.adv_hbp) + (0.8992 * oneB) + (1.29 * GAP) + (2.0759 * HR)) / 600 +
    (c.adv_speed * input.speed) + (c.adv_steal * input.steal) + (c.adv_run * input.run)) * input.ssp;

  return { woba, BB, SO, oneB, GAP, HR, AB, BIP, babipSC, gapSC };
}

// ── Basic Pitching (per side) ───────────────────────────────────────────────
export function basicPitchingSide(input: {
  stuffRaw: number; ctrlRaw: number; pbabipRaw: number; hrrRaw: number; gb: number;
  eraK: number; eraBb: number; eraBabipParkAvg: number; eraEffHrParkHr: number;
  ssp: number; hold: number;
  coeffs: any;
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

// ── Advanced Pitching / wOBA (per side) ─────────────────────────────────────
export function advPitchingSide(input: {
  conRaw: number; stuRaw: number; pbabipRaw: number; hrrRaw: number;
  ssp: number;
  coeffs: any;
}): { woba: number; BB: number; K: number; HR: number; nHH: number; XBH: number; PBABIP_SC: number } {
  const c = input.coeffs;

  const CON    = softcap(input.conRaw,    c.cap_p_con_top,    c.cap_p_con_bot,    c.pen_p_con);
  const STU    = softcap(input.stuRaw,    c.cap_p_stu_top,    c.cap_p_stu_bot,    c.pen_p_stu);
  const PBABIP = softcap(input.pbabipRaw, c.cap_p_pbabip_top, c.cap_p_pbabip_bot, c.pen_p_pbabip);
  const HRR    = softcap(input.hrrRaw,    c.cap_p_hrr_top,    c.cap_p_hrr_bot,    c.pen_p_hrr);

  const BB  = Math.max(c.p_bb_int + c.p_bb_con * Math.log(Math.max(CON, 1)), 0);
  const K   = Math.min(Math.max(c.p_k_int  + c.p_k_stu  * Math.log(Math.max(STU, 1)), 0), 600 - BB);
  const HR  = Math.max(c.p_hr_int + c.p_hr_hrr * Math.log(Math.max(HRR, 1)), 0);
  const AB  = 600 - BB - c.adv_hbp;
  const BIP = Math.max(AB - K - HR, 1);
  const nHH_raw = Math.max(c.p_nHH_int + c.p_nHH_pbabip * Math.log(Math.max(PBABIP, 1)) + c.p_nHH_bip * Math.log(Math.max(BIP, 1)), 0);

  const BB_n  = BB      * (c.p_leagueNorm_bb ?? 1);
  const HR_n  = HR      * (c.p_leagueNorm_hr ?? 1);
  const nHH_n = nHH_raw * (c.p_leagueNorm_h  ?? 1);
  const XBH   = nHH_n   * c.p_xbh_share * (c.p_xbh_norm ?? 1);
  const oneB  = nHH_n   - XBH;
  const woba  = ((0.704 * BB_n + 0.704 * c.adv_hbp + 0.8992 * oneB + 1.29 * XBH + 2.0759 * HR_n) / 600) * input.ssp;

  return { woba, BB: BB_n, K, HR: HR_n, nHH: nHH_n, XBH, PBABIP_SC: PBABIP };
}
