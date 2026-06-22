// Public surface of the M4 optimizer. Consumes scored candidates (one core) and
// produces rosters/lineups; never scores.
export { generateHitterRoster } from "./generate.ts";
export { buildHitterLp } from "./lp.ts";
export { getSolver, type SolveResult } from "./solve.ts";
export {
  type HitterCandidate, type HitterOptimizeOptions, type Roster, type LineupSlot,
  FIELD_POSITIONS, lineupPositions,
} from "./types.ts";
