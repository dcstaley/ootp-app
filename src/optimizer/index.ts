// Public surface of the M4 optimizer. Consumes scored candidates (one core) and
// produces rosters/lineups; never scores.
export { generateHitterRoster, generateRoster } from "./generate.ts";
export { generatePitcherStaff } from "./pitcher-generate.ts";
export { buildHitterLp } from "./lp.ts";
export { buildPitcherLp } from "./pitcher-lp.ts";
export { getSolver, type SolveResult } from "./solve.ts";
export {
  type HitterCandidate, type HitterOptimizeOptions, type HitterResult,
  type PitcherCandidate, type PitcherOptimizeOptions, type PitcherStaff,
  type Roster, type LineupSlot, type RotationSlot,
  FIELD_POSITIONS, lineupPositions, qualifiesStarter,
} from "./types.ts";
