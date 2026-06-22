// M4 — optimizer types. The optimizer NEVER scores: it consumes already-scored
// candidates (per-side value from the one core, D2 `valueFor`) and produces a
// roster + vL/vR lineups. Pitchers/rotation/cap-mode come in later phases.

export interface HitterCandidate {
  id: string;          // card id (base or variant — caller ensures uniqueness intent)
  title: string;
  bats: number;
  valueVR: number;     // per-side hitter value (D2 signed distance from baseline)
  valueVL: number;
  positions: string[]; // eligible lineup positions (field Learn flags + "DH")
}

export interface LineupSlot { pos: string; id: string; title: string }

export interface Roster {
  status: string;            // solver status ("Optimal", "Infeasible", …)
  objective: number;
  hitters: string[];         // rostered hitter card ids
  lineupVR: LineupSlot[];    // 9 (or 8) slots vs RHP
  lineupVL: LineupSlot[];    // vs LHP
}

export interface HitterOptimizeOptions {
  nHitters: number;          // roster hitters (e.g. tournament.hitters)
  dh: boolean;               // DH slot present
  platoonVR: number;         // team exposure weights (sum ~1); weight the vR/vL lineup value
  platoonVL: number;
  backupCatcherDepth?: number; // rostered cards able to play C (default 2)
  benchWeight?: number;      // small weight on roster membership so bench fills with next-best (default 0.1)
}

export const FIELD_POSITIONS = ["C", "1B", "2B", "3B", "SS", "LF", "CF", "RF"] as const;
export const lineupPositions = (dh: boolean): string[] => (dh ? [...FIELD_POSITIONS, "DH"] : [...FIELD_POSITIONS]);
