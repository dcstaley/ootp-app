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
}

export interface Park {
  id: string;
  name: string;
  avg_l: number; avg_r: number; hr_l: number; hr_r: number; gap: number;
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

  // Run environment by reference (D4)
  eraId: string;
  parkId: string;

  // Tournament-scoped config
  softcaps: Softcaps;
  eligibility: EligibilityGroup;

  // Pool sizing / generation settings (used by M4 optimization pool, not calibration)
  topHitters?: number | null;
  topPitchers?: number | null;
  ownedOnly?: boolean;
}
