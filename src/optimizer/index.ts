// Public surface of the M4 optimizer. Consumes scored candidates (one core) and
// produces rosters/lineups; never scores.
export { generateHitterRoster, generateRoster, generateFullRoster } from "./generate.ts";
export { generatePitcherStaff } from "./pitcher-generate.ts";
export { buildHitterLp } from "./lp.ts";
export { buildPitcherLp } from "./pitcher-lp.ts";
export { buildRosterLp, cumulativeSlotLimits } from "./roster-lp.ts";
export { bestLineupValue, type MatchHitter } from "./lineup-match.ts";
export { getSolver, type SolveResult } from "./solve.ts";
export {
  type HitterCandidate, type HitterOptimizeOptions, type HitterResult,
  type PitcherCandidate, type PitcherOptimizeOptions, type PitcherStaff,
  type Roster, type RosterOptimizeOptions, type BudgetMode, type LineupSlot, type RotationSlot,
  FIELD_POSITIONS, SLOT_TIERS, lineupPositions, qualifiesStarter,
} from "./types.ts";
