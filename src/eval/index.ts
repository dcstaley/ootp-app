// Public surface of the roster-level expected-wins evaluator (the true cap/slots objective).
export {
  winPctFromRuns, lineupWraa, defaultUsage, rotationStarts, DEFAULT_WIN_PARAMS,
  type WinParams, type WinBreakdown, type RosterShape, type Usage,
} from "./expected-wins.ts";
export { offenseRunsAboveAvg } from "./offense.ts";
export { setExpectedWins, buildUsage, defenseRunsAboveAvg } from "./set-eval.ts";
export {
  computeBaseline, deploymentFrom, applyDeployment, logit, expit,
  type FieldMember, type ExposureBaseline, type RealizedSplits, type DeploymentShift, type EffectiveExposure,
} from "./exposure.ts";
