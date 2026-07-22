// Public surface of the one scoring core.
export { scoreCard, type CardScores } from "./score-card.ts";
export { calibrate, calibrateBasic, valueFor, TARGET_WOBA, TARGET_BASIC, type CalibrateConfig } from "./calibrate.ts";
export { computeDerived } from "../config/derived.ts";
export type { Coeffs, CalScales, Derived, ScoringConfig, ScoreSettings, Side } from "../config/types.ts";
export type { EventModel } from "../model/types.ts";
export { logLinearModel } from "../model/log-linear.ts";
export { makeRawPolyModel } from "../model/raw-poly.ts";
export type { EventForm, FittedHit, FittedPit } from "../model/curves.ts";
export { ratingStats, affineFor, applyAffine, applyFrameShift, applyKSpread, applyPitSpread, kSpreadPitRamp, K_SPREAD_PIT, assertKSpreadProvenance, pitSpreadHrRamp, PIT_SPREAD_HR, buildAffines, logistic, HIT_RATINGS, PIT_RATINGS, type PoolTransform, type PitSpreadFields, type RatingStats, type RatingEnvelope, type TrainingMeans, type FrameShift } from "../model/pool-transform.ts";
export { FIELD_N, productionFieldStats, computeFieldStats, computeUnifiedFieldStats, buildPoolTransform, buildFrameShift, poolMeanK, poolMeanKOwn, poolPitMeansOwn, cardSideWobas, type FieldStats } from "./pool-stats.ts";

// ── PROVENANCE ASSERTION, AT THE ONE PLACE THAT SEES ALL THREE CONSTANTS ────────────────────────
// The K-spread ramp is fitted at a specific (FIELD_N, PRESENCE_P) coordinate and measured out to a
// specific gMax. Those three live in three different modules — pool-stats, data/variants and
// pool-transform — and pool-transform cannot import the first two without a cycle. This file is the
// public surface every consumer of the scoring core goes through, so it is the one place all three
// are visible at once, and the check runs AT MODULE LOAD: importing the scoring core at all is
// enough to validate that the shipped ramp matches the cohort constants actually in force.
//
// It THROWS. That is deliberate: the failure mode being trapped is someone moving FIELD_N or
// PRESENCE_P without re-deriving the ramp, and a warning is exactly what that mistake would survive.
// gMax is passed as the constant's own value here because nothing at runtime re-derives the fitted
// gap range; the fit tool is what checks it against the data, and tests/kspread-pit.test.ts pins it.
import { FIELD_N as FIELD_N_ } from "./pool-stats.ts";
import { PRESENCE_P as PRESENCE_P_ } from "../data/variants.ts";
import { assertKSpreadProvenance as assertKSpreadProvenance_ } from "../model/pool-transform.ts";
assertKSpreadProvenance_(FIELD_N_, PRESENCE_P_);
export { DEFAULT_WOBA_WEIGHTS, wobaWeightsFromCoeffs, applyWobaWeights, type WobaWeights } from "./woba-weights.ts";
