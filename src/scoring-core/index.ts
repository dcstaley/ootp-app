// Public surface of the one scoring core.
export { scoreCard, type CardScores } from "./score-card.ts";
export { computeDerived } from "../config/derived.ts";
export type { Coeffs, CalScales, Derived, ScoringConfig, ScoreSettings, Side } from "../config/types.ts";
export type { EventModel } from "../model/types.ts";
export { logLinearModel } from "../model/log-linear.ts";
