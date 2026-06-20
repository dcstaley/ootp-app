// M2 (D4) — dissolve the old global coeff "bag" into separable parts:
//   Era (run environment) · Park (venue) · Softcaps (tournament-scoped) ·
//   Model (trained coefficients) · extras (everything not yet categorised —
//   ssp/splits/adv constants, dead model slots, position weights, etc.).
//
// splitCoeffs(bag) decomposes a flat Coeffs into these parts (exact, lossless);
// assembleCoeffs(parts) recomposes the flat Coeffs the scoring core consumes.
// Round-trip is identity by construction (extras preserves anything unrouted),
// so a captured bag can be split into reusable Era/Park/Softcaps/Model library
// entries and reassembled with no drift. (Categorising the `extras` remainder —
// e.g. position weights → tournament — and a real model-artifact format are
// follow-ups; this establishes the partition.)

import type { Coeffs } from "./types.ts";
import type { Softcaps } from "./tournament.ts";

export interface EraFactors {
  bb: number; k: number; avg: number; hr: number; bip: number; gap: number;
  thr_toggle: boolean; thr: number;
}
export interface ParkFactors {
  avg_l: number; avg_r: number; hr_l: number; hr_r: number; gap: number;
}
export type ModelCoeffs = Record<string, number>;

export interface CoeffParts {
  era: EraFactors;
  park: ParkFactors;
  softcaps: Softcaps;
  model: ModelCoeffs;
  extras: Record<string, number | boolean>;
}

const SOFTCAP_KEYS: (keyof Softcaps)[] = [
  "cap_k_top", "cap_k_bot", "pen_k", "cap_babip_top", "cap_babip_bot", "pen_babip",
  "cap_gap_top", "cap_gap_bot", "pen_gap", "cap_pow_top", "cap_pow_bot", "pen_pow",
  "cap_eye_top", "cap_eye_bot", "pen_eye",
  "cap_p_con_top", "cap_p_con_bot", "pen_p_con", "cap_p_stu_top", "cap_p_stu_bot", "pen_p_stu",
  "cap_p_pbabip_top", "cap_p_pbabip_bot", "pen_p_pbabip", "cap_p_hrr_top", "cap_p_hrr_bot", "pen_p_hrr",
];

// Trained model coefficients (woba + basic, hitting + pitching) + the GB map.
const MODEL_KEYS: string[] = [
  "basic_intercept", "w_babip", "w_pow", "w_eye", "w_k", "w_gap", "w_speed", "w_run", "w_steal",
  "eyeInt", "eye", "powInt", "pow", "kInt", "k", "kbb600", "baInt", "ba", "bipba", "gapLogA", "gapLogB",
  "p_stuff", "p_control", "p_babip", "p_hr", "p_hold",
  "p_bb_int", "p_bb_con", "p_k_int", "p_k_stu", "p_hr_int", "p_hr_hrr",
  "p_nHH_int", "p_nHH_pbabip", "p_nHH_bip", "p_xbh_share", "p_xbh_norm",
  "p_leagueNorm_bb", "p_leagueNorm_hr", "p_leagueNorm_h",
  "hradj_exgb", "hradj_gb", "hradj_neu", "hradj_fb", "hradj_exfb",
];

// Coeff field names owned by era/park (excluded from `extras`).
const ERA_COEFF_KEYS = ["era_bb", "era_k", "era_avg", "era_hr", "era_bip", "era_gap", "era_thr", "tournament_hr_adjust"];
const PARK_COEFF_KEYS = ["park_avg_l", "park_avg_r", "park_hr_l", "park_hr_r", "park_gap"];

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v) || 0);

export function splitCoeffs(c: Coeffs): CoeffParts {
  const era: EraFactors = {
    bb: num(c.era_bb), k: num(c.era_k), avg: num(c.era_avg), hr: num(c.era_hr),
    bip: num(c.era_bip), gap: num(c.era_gap), thr: num(c.era_thr), thr_toggle: !!c.tournament_hr_adjust,
  };
  const park: ParkFactors = {
    avg_l: num(c.park_avg_l), avg_r: num(c.park_avg_r), hr_l: num(c.park_hr_l), hr_r: num(c.park_hr_r), gap: num(c.park_gap),
  };
  const softcaps = {} as Softcaps;
  for (const k of SOFTCAP_KEYS) softcaps[k] = num(c[k]);
  const model: ModelCoeffs = {};
  for (const k of MODEL_KEYS) if (k in c) model[k] = num(c[k]);

  const routed = new Set<string>([...ERA_COEFF_KEYS, ...PARK_COEFF_KEYS, ...SOFTCAP_KEYS, ...MODEL_KEYS]);
  const extras: Record<string, number | boolean> = {};
  for (const k of Object.keys(c)) if (!routed.has(k)) extras[k] = c[k] as number | boolean;

  return { era, park, softcaps, model, extras };
}

export function assembleCoeffs(parts: CoeffParts): Coeffs {
  const { era, park, softcaps, model, extras } = parts;
  return {
    ...extras,
    ...model,
    ...softcaps,
    era_bb: era.bb, era_k: era.k, era_avg: era.avg, era_hr: era.hr, era_bip: era.bip, era_gap: era.gap,
    era_thr: era.thr, tournament_hr_adjust: era.thr_toggle,
    park_avg_l: park.avg_l, park_avg_r: park.avg_r, park_hr_l: park.hr_l, park_hr_r: park.hr_r, park_gap: park.gap,
  } as Coeffs;
}
