// D3 — the prediction model is a SWAPPABLE component behind this fixed seam.
// The scoring core asks the model for the raw per-card event prediction; nothing
// downstream (calibration, era/park, anchor, value, optimizer) may assume HOW the
// numbers were produced. Today's only implementation is log-linear (a faithful
// port of the old app); the D3 bake-off will add candidates behind this same seam.

import type { Coeffs } from "../config/types.ts";

export interface HittingRatings {
  eye: number; pow: number; kRat: number; babip: number; gap: number;
  speed: number; steal: number; run: number;
}

export interface PitchingRatings {
  con: number; stu: number; pbabip: number; hrr: number;
}

// Raw, un-calibrated per-card event components (no era/park, no calibration
// scales, no ssp). Mirrors the old advHittingSide/advPitchingSide component
// outputs; the core assembles raw wOBA (fixed weights + ssp) and the calibrated
// score from these. Note BB/HR/nHH already carry pitching league-norm factors,
// matching the old stored columns the calibration layer reads.
export interface RawHitting {
  BB: number; SO: number; oneB: number; GAP: number; HR: number;
  AB: number; BIP: number; babipSC: number; gapSC: number;
}

export interface RawPitching {
  BB: number; K: number; HR: number; nHH: number; XBH: number; pbabipSC: number;
}

export interface EventModel {
  predictHitting(r: HittingRatings, c: Coeffs): RawHitting;
  predictPitching(r: PitchingRatings, c: Coeffs): RawPitching;
}
