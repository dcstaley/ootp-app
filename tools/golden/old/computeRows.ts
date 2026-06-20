// GOLDEN HARNESS — faithful copy of C:\ootp_app\frontend\lib\computeRows.ts.
// Only two intentional deltas vs the original, neither touching a formula:
//   1. The first-3-cards console.log diagnostic block is removed.
//   2. `Derived` is typed with `era_h` (the original reads `derived.era_h` at
//      runtime but its type omitted it — a known minor old-code defect).
// Per-row wrapper: pull raw ratings + era/park mods off the row, call the core,
// assemble the augmented columns the trusted scores read.

import {
  n,
  cp,
  parkAvgFactor,
  parkHrFactor,
  sameSidePenaltyHitting,
  sameSidePenaltyPitching,
  softcap,
  gbMult,
  basicHittingSide,
  advHittingSide,
  basicPitchingSide,
  advPitchingSide,
  type Side,
} from "./scoringCore.ts";

export type Derived = {
  era_h: number;
  era_effective_hr: number;
};

export const COMPUTED_COL_FIELDS: string[] = [
  "Basic Hitting vR",
  "Basic Hitting vL",
  "Basic Hitting OVR",
  "wOBA vR",
  "wOBA vL",
  "Basic Pitching vR",
  "Basic Pitching vL",
  "Basic Pitching OVR",
  "Pitcher wOBA vR",
  "Pitcher wOBA vL",
  "Pitcher wOBA OVR",
  "Pitcher BB vR",
  "Pitcher BB vL",
  "Pitcher HR vR",
  "Pitcher HR vL",
  "Pitcher nHH vR",
  "Pitcher nHH vL",
  "Pitcher XBH vR",
  "Pitcher XBH vL",
];

export function computeAugmentedRows(rows: any[], coeffs: any, derived: Derived): any[] {
  if (!rows || !rows.length) return rows || [];
  const era_babip = derived?.era_h ?? 1;
  const era_eff_hr = derived?.era_effective_hr ?? 1;

  return rows.map((row: any) => {

      const bats = n(row["Bats"]);
      const thr = n(row["Throws"]);
      const gb = n(row["GB"]);

      const park_avg_vr = parkAvgFactor(bats, "vR", coeffs);
      const park_avg_vl = parkAvgFactor(bats, "vL", coeffs);
      const park_hr_vr = parkHrFactor(bats, "vR", coeffs);
      const park_hr_vl = parkHrFactor(bats, "vL", coeffs);

      const ssp_basic_vr = sameSidePenaltyHitting(bats, "vR", coeffs.ssp_basic_hitting);
      const ssp_basic_vl = sameSidePenaltyHitting(bats, "vL", coeffs.ssp_basic_hitting);
      const ssp_adv_vr = sameSidePenaltyHitting(bats, "vR", coeffs.ssp_adv_hitting);
      const ssp_adv_vl = sameSidePenaltyHitting(bats, "vL", coeffs.ssp_adv_hitting);

      // Base Hitting inputs
      const babipVR_raw = n(row["BABIP vR"]);
      const babipVL_raw = n(row["BABIP vL"]);
      const powVR_raw = n(row["Power vR"]);
      const powVL_raw = n(row["Power vL"]);
      const eyeVR_raw = n(row["Eye vR"]);
      const eyeVL_raw = n(row["Eye vL"]);
      const kVR_raw = n(row["Avoid K vR"]);
      const kVL_raw = n(row["Avoid K vL"]);
      const gapVR_raw = n(row["Gap vR"]);
      const gapVL_raw = n(row["Gap vL"]);

      const speed = n(row["Speed"]);
      const steal = n(row["Stealing"]);
      const run = n(row["Baserunning"]);

      // Era/park modifiers applied per-component post-quadratic
      const babipMod_vr = era_babip * park_avg_vr;
      const babipMod_vl = era_babip * park_avg_vl;
      const powMod_vr   = era_eff_hr * park_hr_vr;
      const powMod_vl   = era_eff_hr * park_hr_vl;
      const eyeMod      = coeffs.era_bb;
      const kMod        = coeffs.era_k;
      const gapMod      = cp(coeffs.park_gap);

      const basicHVR = basicHittingSide({
        babipRaw: babipVR_raw, powRaw: powVR_raw, eyeRaw: eyeVR_raw, kRaw: kVR_raw, gapRaw: gapVR_raw,
        babipMod: babipMod_vr, powMod: powMod_vr, eyeMod, kMod, gapMod,
        ssp: ssp_basic_vr,
        speed, run, steal,
        coeffs,
      });

      const basicHVL = basicHittingSide({
        babipRaw: babipVL_raw, powRaw: powVL_raw, eyeRaw: eyeVL_raw, kRaw: kVL_raw, gapRaw: gapVL_raw,
        babipMod: babipMod_vl, powMod: powMod_vl, eyeMod, kMod, gapMod,
        ssp: ssp_basic_vl,
        speed, run, steal,
        coeffs,
      });

      const basicHOVR = (basicHVR + basicHVL) / 2;

      // Advanced Hitting (wOBA)
      function advSide(side: Side) {
        const ssp = side === "vR" ? ssp_adv_vr : ssp_adv_vl;
        const eyeRaw = side === "vR" ? eyeVR_raw : eyeVL_raw;
        const kRaw = side === "vR" ? kVR_raw : kVL_raw;
        const babipRaw = side === "vR" ? babipVR_raw : babipVL_raw;
        const gapRaw = side === "vR" ? gapVR_raw : gapVL_raw;
        const powRaw = side === "vR" ? powVR_raw : powVL_raw;

        return advHittingSide({ eyeRaw, powRaw, kRaw, babipRaw, gapRaw, speed, steal, run, ssp, coeffs });
      }

      const advR = advSide("vR");
      const advL = advSide("vL");

      // Pitching
      const mult = gbMult(gb, coeffs);
      const hradjL = softcap(n(row["pHR vL"]), coeffs.cap_p_hrr_top, coeffs.cap_p_hrr_bot, coeffs.pen_p_hrr) * mult;
      const hradjR = softcap(n(row["pHR vR"]), coeffs.cap_p_hrr_top, coeffs.cap_p_hrr_bot, coeffs.pen_p_hrr) * mult;

      const hold = n(row["Hold"]);

      const psspR = sameSidePenaltyPitching(thr, "vR", coeffs.ssp_basic_pitching);
      const psspL = sameSidePenaltyPitching(thr, "vL", coeffs.ssp_basic_pitching);

      const basicPR = basicPitchingSide({
        stuffRaw: n(row["Stuff vR"]), ctrlRaw: n(row["Control vR"]), pbabipRaw: n(row["pBABIP vR"]), hrrRaw: n(row["pHR vR"]), gb,
        eraK: coeffs.era_k, eraBb: coeffs.era_bb,
        eraBabipParkAvg: era_babip * cp(coeffs.park_avg_r),
        eraEffHrParkHr: era_eff_hr * cp(coeffs.park_hr_r),
        ssp: psspR, hold,
        coeffs,
      });

      const basicPL = basicPitchingSide({
        stuffRaw: n(row["Stuff vL"]), ctrlRaw: n(row["Control vL"]), pbabipRaw: n(row["pBABIP vL"]), hrrRaw: n(row["pHR vL"]), gb,
        eraK: coeffs.era_k, eraBb: coeffs.era_bb,
        eraBabipParkAvg: era_babip * cp(coeffs.park_avg_l),
        eraEffHrParkHr: era_eff_hr * cp(coeffs.park_hr_l),
        ssp: psspL, hold,
        coeffs,
      });

      const ovrP = (thr === 1)
        ? (basicPR * coeffs.r_pitch_split + basicPL * (1 - coeffs.r_pitch_split))
        : (thr === 2)
          ? (basicPR * (1 - coeffs.l_pitch_split) + basicPL * coeffs.l_pitch_split)
          : 0;

      // Advanced Pitching wOBA
      function advPitchSide(side: Side) {
        const ssp = sameSidePenaltyPitching(thr, side, coeffs.ssp_basic_pitching);
        const conRaw    = side === "vR" ? n(row["Control vR"]) : n(row["Control vL"]);
        const stuRaw    = side === "vR" ? n(row["Stuff vR"])   : n(row["Stuff vL"]);
        const pbabipRaw = side === "vR" ? n(row["pBABIP vR"])  : n(row["pBABIP vL"]);
        const hrrRaw    = side === "vR" ? n(row["pHR vR"])     : n(row["pHR vL"]);

        return advPitchingSide({ conRaw, stuRaw, pbabipRaw, hrrRaw, ssp, coeffs });
      }

      const advPR = advPitchSide("vR");
      const advPL = advPitchSide("vL");
      const advPOVR = (thr === 1)
        ? (advPR.woba * coeffs.r_pitch_split + advPL.woba * (1 - coeffs.r_pitch_split))
        : (thr === 2)
          ? (advPR.woba * (1 - coeffs.l_pitch_split) + advPL.woba * coeffs.l_pitch_split)
          : 0;

      return {
        ...row,
        "Basic Hitting vR": basicHVR,
        "Basic Hitting vL": basicHVL,
        "Basic Hitting OVR": basicHOVR,

        "wOBA vR": advR.woba,
        "wOBA vL": advL.woba,

        "BB vR": advR.BB,
        "SO vR": advR.SO,
        "1B2B3B vR": advR.oneB,
        "2B3B vR": advR.GAP,
        "HR vR": advR.HR,
        "AB vR": advR.AB,
        "BIP vR": advR.BIP,
        "BABIP SC vR": advR.babipSC,
        "GAP SC vR": advR.gapSC,

        "BB vL": advL.BB,
        "SO vL": advL.SO,
        "1B2B3B vL": advL.oneB,
        "2B3B vL": advL.GAP,
        "HR vL": advL.HR,
        "AB vL": advL.AB,
        "BIP vL": advL.BIP,
        "BABIP SC vL": advL.babipSC,
        "GAP SC vL": advL.gapSC,

        "HRAdj L": hradjL,
        "HRAdj R": hradjR,
        "Basic Pitching vR": basicPR,
        "Basic Pitching vL": basicPL,
        "Basic Pitching OVR": ovrP,
        "Pitcher wOBA vR": advPR.woba,
        "Pitcher wOBA vL": advPL.woba,
        "Pitcher wOBA OVR": advPOVR,

        "Pitcher BB vR": advPR.BB,   "Pitcher BB vL": advPL.BB,
        "Pitcher K vR": advPR.K,     "Pitcher K vL": advPL.K,
        "Pitcher HR vR": advPR.HR,   "Pitcher HR vL": advPL.HR,
        "Pitcher nHH vR": advPR.nHH, "Pitcher nHH vL": advPL.nHH,
        "Pitcher XBH vR": advPR.XBH, "Pitcher XBH vL": advPL.XBH,
        "Pitcher PBABIP SC vR": advPR.PBABIP_SC, "Pitcher PBABIP SC vL": advPL.PBABIP_SC,
      };

  });
}
