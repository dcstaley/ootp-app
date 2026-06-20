// The ONE copy of the low-level scoring helpers. Every part of the core uses
// these; there is no second implementation anywhere in the app.

import type { Coeffs, Side } from "../config/types.ts";

export function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

export function softcap(x: number, top: number, bot: number, pen: number): number {
  if (!Number.isFinite(x)) return x;
  if (x > top) return top + (x - top) * (1 - pen);
  if (x < bot) return x - (bot - x) * pen;
  return x;
}

// Park factor compression — OOTP applies park factors non-linearly. Park factors
// are ALWAYS passed through cp() before use; era factors are NOT compressed.
export const PARK_COMPRESSION = 0.26;
export const cp = (p: number): number => 1 + (p - 1) * PARK_COMPRESSION;

export function parkAvgFactor(bats: number, side: Side, c: Coeffs): number {
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

export function parkHrFactor(bats: number, side: Side, c: Coeffs): number {
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

// Park factor by handedness for the calibration path (getParkFactor in old code):
// switch hitters take the opposite-hand factor per side.
export function getParkFactor(bats: number, vR: boolean, rFactor: number, lFactor: number): number {
  if (bats === 1) return cp(rFactor);
  if (bats === 2) return cp(lFactor);
  return vR ? cp(lFactor) : cp(rFactor);
}

export function sameSidePenaltyHitting(bats: number, side: Side, ssp: number): number {
  if (side === "vR") return bats === 1 ? ssp : 1;
  return bats === 2 ? ssp : 1;
}

export function sameSidePenaltyPitching(throws: number, side: Side, ssp: number): number {
  if (side === "vR") return throws === 2 ? ssp : 1;
  return throws === 1 ? ssp : 1;
}

export function gbMult(gb: number, c: Coeffs): number {
  switch (gb) {
    case 0: return c.hradj_exgb;
    case 1: return c.hradj_gb;
    case 2: return c.hradj_neu;
    case 3: return c.hradj_fb;
    case 4: return c.hradj_exfb;
    default: return 1;
  }
}
