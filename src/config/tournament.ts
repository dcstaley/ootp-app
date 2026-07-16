// M2b — configuration types (D4). The Tournament is the single config source;
// it references reusable Era and Park libraries by id and carries tournament-
// scoped softcaps + rules. (Model coefficients are a separate model-scoped
// artifact; assembling the scoring `Coeffs` bag from these parts is the next
// sub-step — see assemble-coeffs.) The global mutable coeff bag dissolves.

// ── Eligibility (ALL/ANY rule groups over card columns) ─────────────────────
export type RuleOp =
  | "num_between" | "num_ge" | "num_gt" | "num_le" | "num_lt" | "num_eq"
  | "set_in" | "set_not_in"
  | "text_contains" | "text_equals"
  | "is_blank" | "is_not_blank";

export interface EligibilityRule {
  id: string;
  column: string;
  op: RuleOp;
  a?: string;
  b?: string;
  values?: string[];
}

export interface EligibilityGroup {
  mode: "ALL" | "ANY";
  rules: EligibilityRule[];
}

// ── Reusable libraries (referenced by id) ───────────────────────────────────
export interface Era {
  id: string;
  name: string;
  bb: number; k: number; avg: number; hr: number; bip: number; gap: number;
  thr_toggle: boolean; // tournament-HR multiplier toggle
  thr?: number;        // the tHR multiplier (e.g. 1.15); applied when thr_toggle
  // Optional enrichments from the BBRef per-year import (baseline = 2010).
  year?: number;
  hbp?: number;        // HBP modifier (stored; not consumed by scoring yet, like bip)
  // Baserunning era scaling (BBRef SB/CS/R). sbFreq = era SB/PA ÷ baseline (stealing frequency —
  // scales STEAL value); runVal = baseline R/G ÷ era R/G (run scarcity — scales ALL baserunning value).
  // See eras-bbref.ts for the UBR-vs-steal scaling decision. Absent on capture/synthetic eras ⇒ neutral 1.
  sbFreq?: number;
  runVal?: number;
  rates?: { bb: number; k: number; hr: number; h: number; b2: number; b3: number; hbp: number; bip: number; sb?: number; cs?: number; rg?: number }; // raw per-PA league rates (recompute-without-refetch) + raw SB/CS per PA and R/G
}

export interface Park {
  id: string;
  name: string;
  avg_l: number; avg_r: number; hr_l: number; hr_r: number; gap: number;
  // Optional enrichments from the pt_ballparks import. Per-hand gap (2B) + triples
  // (3B) are stored but not yet consumed by scoring (a future per-hand-gap upgrade
  // won't need a re-import). Metadata is for navigating/labelling the parks library.
  gap_l?: number; gap_r?: number; triple?: number; triple_l?: number; triple_r?: number;
  year?: number; league?: string; team?: string; ptLevel?: number;
}

// Tournament-scoped softcaps (model-seeded; the right values depend on the pool).
export interface Softcaps {
  cap_k_top: number;     cap_k_bot: number;     pen_k: number;
  cap_babip_top: number; cap_babip_bot: number; pen_babip: number;
  cap_gap_top: number;   cap_gap_bot: number;   pen_gap: number;
  cap_pow_top: number;   cap_pow_bot: number;   pen_pow: number;
  cap_eye_top: number;   cap_eye_bot: number;   pen_eye: number;
  cap_p_con_top: number;    cap_p_con_bot: number;    pen_p_con: number;
  cap_p_stu_top: number;    cap_p_stu_bot: number;    pen_p_stu: number;
  cap_p_pbabip_top: number; cap_p_pbabip_bot: number; pen_p_pbabip: number;
  cap_p_hrr_top: number;    cap_p_hrr_bot: number;    pen_p_hrr: number;
}

// Tournament-scoped environment adjustment (D4): a SECOND set of era modifiers that
// MULTIPLY onto the era factors (era 1.12 × adj 1.15 = 1.288), on top of era/park. Lets a
// tournament tune its run environment beyond the shared era — e.g. a hotter HR / lower-walk
// pool. OFF unless a tournament explicitly enables it: real-tournament validation
// (2026-07-12, plan doc §10) showed the blanket HR 1.15 / BB 0.85 default is mis-shaped —
// the measured bias is role-asymmetric (hitter BB ≈ 0, pitcher BB over), which a symmetric
// era multiplier cannot express; pool-strength effects belong to the pool transform instead.
export interface TournamentAdjustment {
  enabled: boolean;
  hr: number; bb: number; k: number; h: number; gap: number;
}
// Seed values a manually-ENABLED adjustment starts from (the knob's initial position).
export const TOURNAMENT_ADJ_DEFAULTS = { hr: 1.15, bb: 0.85, k: 1, h: 1, gap: 1 } as const;
/** Effective adjustment for a tournament: its own explicit field, else disabled. */
export function resolveTournamentAdjustment(t: Tournament): TournamentAdjustment {
  return t.tournamentAdjustment ?? { enabled: false, ...TOURNAMENT_ADJ_DEFAULTS };
}

export interface Tournament {
  id: string;
  name: string;

  // Cap / value rules
  card_value_min?: number | null;
  card_value_max?: number | null;
  total_cap?: number | null;

  // Roster shape
  roster_size: number;
  hitters: number;
  pitchers: number;
  min_starters: number;
  min_starter_stamina: number;
  min_pitch_types: number;
  dh: boolean;

  // Variants policy
  variants_allowed: boolean;
  max_variants_on_roster: number;

  // League vs tournament (drives platoon-exposure sourcing): "league" pools ARE the model's
  // training pool → use the model's REALIZED splits directly; "tournament" pools estimate
  // via pool baseline + the model's deployment shift. Absent ⇒ "tournament". See
  // docs/REBUILD_PLATOON_EXPOSURE_PLAN.md Part A.
  kind?: "league" | "tournament";

  // Run environment by reference (D4)
  eraId: string;
  parkId: string;

  // Tournament-scoped config
  softcaps: Softcaps;
  eligibility: EligibilityGroup;
  tournamentAdjustment?: TournamentAdjustment; // second era-modifier set (multiplied onto era)
  // BUILD-2 gap-conditioned hitter tail correction (HR/BABIP/SO — src/scoring-core/hit-tail.ts).
  // Absent/false ⇒ scoring is bit-identical to before (dormant; Derek activates per tournament).
  hitTailCorrection?: boolean;

  // Pool sizing / generation settings (used by M4 optimization pool, not calibration)
  topHitters?: number | null;
  topPitchers?: number | null;
  ownedOnly?: boolean;

  // Budget + generation knobs (D4 — moved off the old page-level RosterSettings).
  budget_mode?: "none" | "cap" | "slots"; // explicit; falls back to derived (slots>cap>none)
  slot_counts?: Record<string, number>;   // slots mode: per Card-Value tier counts
  platoonVR?: number;                      // team RHP/LHP exposure weights (default league 0.62/0.38)
  platoonVL?: number;
  // Per-hand OVR-blend splits (D4 platoon-as-tournament-setting). Seeded from the active
  // model's measured exposure on CREATE; absent ⇒ the model/coeff defaults (existing tournaments untouched).
  platoon?: {
    r_hit_split: number; l_hit_split: number; s_hit_split: number; r_pitch_split: number; l_pitch_split: number;
    // Role-conditional pitch splits (M6, optional). Seeded on CREATE from the active
    // model's measured SP/RP exposure; absent ⇒ the optimizer falls back to the active
    // model's role splits, then the role-blind split above. See server resolvePitchSplit.
    r_pitch_split_sp?: number; l_pitch_split_sp?: number; r_pitch_split_rp?: number; l_pitch_split_rp?: number;
  };
  minPlayersPerPosition?: number;          // coverage depth / backups (default 2)
  // Per-position min defensive ratings. starter = bar to START there (lineup); backup
  // = bar to count toward coverage depth. Keys are rating ids relevant to the position
  // group (C: ability/frame/arm · IF: range/error/arm/dp · OF: range/error/arm).
  positionMins?: Record<string, { starter?: Record<string, number>; backup?: Record<string, number> }>;
  // Rank-based position requirements (the rostered player's rating must place within the
  // top-K of eligible-at-position players in the Top-X pool, ranked by that specific
  // rating). Same starter/backup structure as positionMins; the value is K. Enforced by
  // converting K → an effective min (the K-th highest rating in the pool) at solve time.
  positionRanks?: Record<string, { starter?: Record<string, number>; backup?: Record<string, number> }>;
  // ── E[wins] optimizer (CAP/SLOTS ONLY) ──────────────────────────────────────
  // Best-of-N series format of the tournament's rounds. Drives the rotation usage curve
  // (a slot's expected starts). Absent ⇒ Bo7. Rotation SIZE is min_starters (4 or 5).
  bestOf?: number;
  // User steering for the E[wins] objective (all optional; absent ⇒ model defaults, so
  // existing tournaments are unchanged). Tier-1 belief knobs + relative spend dials.
  tuning?: TournamentTuning;
}

export interface TournamentTuning {
  rotationShare?: number;      // fraction of team BF thrown by the rotation (vs bullpen)
  rotationDecay?: number;      // extra manual tilt of rotation innings toward SP1 ("value SP5 less")
  platoonCapture?: number;     // ρ: how often a fielded card gets its favorable matchup
  fullStrengthShare?: number;  // fraction of games at full strength (bench-depth value)
  bullpenLeverage?: number[];  // leverage premiums for the top relievers (closer, setup, …)
  // Relative spend dials: a fraction of the segment's NATURAL spend (1 = leave alone).
  dials?: { lineup?: number; bench?: number; rotation?: number; bullpen?: number };
}
