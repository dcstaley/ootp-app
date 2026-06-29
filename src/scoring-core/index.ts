// Public surface of the one scoring core.
export { scoreCard, type CardScores } from "./score-card.ts";
export { calibrate, calibrateBasic, valueFor, TARGET_WOBA, TARGET_BASIC, type CalibrateConfig } from "./calibrate.ts";
export { computeDerived } from "../config/derived.ts";
export type { Coeffs, CalScales, Derived, ScoringConfig, ScoreSettings, Side } from "../config/types.ts";
export type { EventModel } from "../model/types.ts";
export { logLinearModel } from "../model/log-linear.ts";
export { makeRawPolyModel } from "../model/raw-poly.ts";
export type { EventForm, FittedHit, FittedPit } from "../model/curves.ts";
export { ratingStats, affineFor, buildAffines, HIT_RATINGS, PIT_RATINGS, type PoolTransform, type RatingStats } from "../model/pool-transform.ts";
