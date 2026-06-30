// M4 — optimizer types. The optimizer NEVER scores: it consumes already-scored
// candidates (per-side value from the one core, D2 `valueFor`) and produces a
// roster + vL/vR lineups. Pitchers/rotation/cap-mode come in later phases.

export interface HitterCandidate {
  id: string;          // card id (base or variant — caller ensures uniqueness intent)
  title: string;
  bats: number;
  valueVR: number;     // per-side hitter value (D2 signed distance from baseline)
  valueVL: number;
  positions: string[]; // STARTER-eligible lineup positions (Learn flags + "DH", filtered by per-position starter mins)
  coverPositions?: string[]; // BACKUP-eligible field positions (coverage depth); defaults to `positions` when absent
  cost: number;        // Card Value — the cap/slots budget cost
}

export interface LineupSlot { pos: string; id: string; title: string }

// ── Pitchers ─────────────────────────────────────────────────────────────────
export interface PitcherCandidate {
  id: string;
  title: string;
  throws: number;
  valueVR: number;     // per-side pitcher value (D2 signed distance; higher = allows less)
  valueVL: number;
  stamina: number;
  pitchTypes: number;  // # distinct pitch types (> 0)
  cost: number;        // Card Value — the cap/slots budget cost
}

export interface HitterResult {
  status: string;
  objective: number;
  hitters: string[];
  lineupVR: LineupSlot[];
  lineupVL: LineupSlot[];
}

export interface RotationSlot { slot: number; id: string; title: string } // slot 1 = SP1 (ace)

export interface PitcherStaff {
  status: string;
  objective: number;
  pitchers: string[];
  rotation: RotationSlot[];  // ordered SP1..SP(minStarters)
  bullpen: string[];
}

export interface PitcherOptimizeOptions {
  nPitchers: number;
  minStarters: number;            // rotation size
  minStarterStamina: number;
  minPitchTypes: number;
  platoonVR: number;
  platoonVL: number;
  pitchSplit?: PitchSplit;         // (hand,role) batter-hand exposure; absent ⇒ team-split fallback
  rotationSlotWeights?: number[];  // SP1..SP5 weights (default 1, .95, .9, .8, .75)
  bullpenWeight?: number;          // weight on rostered non-starters (default 0.15)
}

export const qualifiesStarter = (p: PitcherCandidate, minStam: number, minTypes: number): boolean =>
  p.stamina >= minStam && p.pitchTypes >= minTypes;

// ── Pitcher platoon collapse (M6) ───────────────────────────────────────────
// A pitcher faces both batter hands every game, so — unlike a hitter — it can't be
// assigned to a side; it MUST collapse to one value. The correct collapse weight is
// the pitcher's own batter-hand exposure (`pitch_split`, handedness-specific), NOT
// the offense's team split. Exposure further depends on realized role: starters face
// ~full lineups, relievers a leverage-skewed mix. So the weight is keyed by (hand,
// deployed role). Same-side-share convention: `r` = RHP vsRHB share, `l` = LHP vsLHB.
export type PitchRole = "sp" | "rp";
export interface PitchSplit { sp: { r: number; l: number }; rp: { r: number; l: number } }

/** Weight on valueVR (= value vs RHB) for a pitcher of `throws` (1=R,2=L) deployed in `role`. */
export const pitchVsRWeight = (throws: number, role: PitchRole, ps: PitchSplit): number =>
  throws === 1 ? ps[role].r : throws === 2 ? 1 - ps[role].l : 0.5;

/**
 * Collapse a pitcher's per-side values to one number. With `ps` present, weights by
 * (hand, role); absent ⇒ legacy team-split fallback (`platoonVR/VL`) so callers with
 * no model artifact (and existing tests) keep their prior behavior unchanged.
 */
export const blendPitch = (
  valueVR: number, valueVL: number, throws: number, role: PitchRole,
  ps: PitchSplit | undefined, platoonVR: number, platoonVL: number,
): number => {
  if (!ps) return platoonVR * valueVR + platoonVL * valueVL;
  const wR = pitchVsRWeight(throws, role, ps);
  return wR * valueVR + (1 - wR) * valueVL;
};

// ── Combined cap/slots roster (Phase C) ─────────────────────────────────────
export type BudgetMode = "none" | "cap" | "slots";

// Card-Value tiers for slots mode (cumulative limits; a higher tier slot may hold
// a lower-value card). Mirrors the old app's tier thresholds.
export const SLOT_TIERS = [
  { key: "perfect", threshold: 100 }, { key: "diamond", threshold: 90 },
  { key: "gold", threshold: 80 }, { key: "silver", threshold: 70 },
  { key: "bronze", threshold: 60 }, { key: "iron", threshold: 40 },
] as const;

export interface RosterOptimizeOptions {
  // roster shape
  nHitters: number; nPitchers: number; dh: boolean;
  minStarters: number; minStarterStamina: number; minPitchTypes: number;
  // platoon exposure (weights the vR/vL lineup value)
  platoonVR: number; platoonVL: number;
  // pitcher batter-hand exposure by (hand, deployed role); absent ⇒ team-split fallback.
  // Rotation-slot value uses the SP weight, bullpen value the RP weight.
  pitchSplit?: PitchSplit;
  // D2 H/P emphasis knob — multiplies hitter vs pitcher objective value (default 1).
  // A lighter, user-controlled stand-in for the old auto cross-pool normalization.
  hitterEmphasis?: number; pitcherEmphasis?: number;
  // role/slot weights (cap/slots only)
  rotationSlotWeights?: number[]; bullpenWeight?: number; benchWeight?: number;
  backupCatcherDepth?: number;
  minPlayersPerPosition?: number; // coverage depth: ≥ this many rostered can play EACH field position (default 2)
  bothSidesBonus?: number;     // multiplier for platoon-neutral hitters (default 1.25)
  bothSidesThreshold?: number; // min(valueVR,valueVL) ≥ this → "both-sides" (valueFor scale; default 0)
  // required cards (locks) — these candidates are forced onto the roster (matched
  // by base card id; variant rows count). Excluded cards are filtered before the
  // pool is built, so they never appear here.
  lockedIds?: string[];
  // lineup position locks (S5.3) — pin a hitter to a defensive position in a
  // specific platoon lineup (vL/vR can differ). Forces yh_i_pos_vS = 1, so the
  // per-position fill constraint displaces whoever the LP would have placed there
  // (and rosters the locked card). Matched by base card id; a lock to a position
  // the card can't start is ignored (the var doesn't exist).
  lineupLocks?: { id: string; pos: string; side: "L" | "R" }[];
  // two-way players: candidate ids that appear in BOTH the hitter and pitcher
  // pools AND are designated two-way (Top-X overlap, or forced via the per-card
  // toggle). Such a card fills a hitter slot AND a pitcher slot with one entity —
  // counted ONCE toward roster size + cap (the freed slot flows to a bonus pick).
  // A card present in both pools but NOT listed here is single-role (rh+rp ≤ 1):
  // it can be chosen as a hitter OR a pitcher, never both.
  twoWayIds?: string[];
  // budget
  mode: BudgetMode;
  totalCap?: number;
  slotCounts?: Record<string, number>;
  rosterSize?: number;         // for implied-iron in slots mode (default nHitters+nPitchers)
}

export interface Roster {
  status: string;            // solver status ("Optimal", "Infeasible", …)
  objective: number;
  hitters: string[];         // rostered hitter card ids
  lineupVR: LineupSlot[];    // 9 (or 8) slots vs RHP
  lineupVL: LineupSlot[];    // vs LHP
  pitchers: string[];
  rotation: RotationSlot[];
  bullpen: string[];
  twoWay?: string[];         // ids used as BOTH a hitter and a pitcher (freed a slot)
  cost?: number;             // total roster Card Value (cap/slots modes)
  balance?: { hitterValue: number; pitcherValue: number }; // SP-7 H/P value split
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
