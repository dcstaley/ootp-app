// Shared types + theme used across the shell and pages.
import type { CSSProperties } from "react";

// Shared fetch helpers — uniform `r.ok` handling: a non-OK response throws with the
// server's {error} message when present (falling back to the HTTP status), so failures
// surface as messages instead of being silently installed as data.
export async function getJson<T = any>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error(d?.error ? String(d.error) : `${r.status} ${r.statusText}`);
  return d as T;
}
export const postJson = <T = any>(url: string, body: unknown): Promise<T> =>
  getJson<T>(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export interface Card {
  id: string; variant: string; title: string; first: string; last: string;
  bats: number; throws: number; value: number; owned: number;
  learn: Record<string, number>; eligible: boolean;
  stamina: number; pitches: number;
  hitVL: number; hitVR: number; hitOVR: number; basicHit: number; basicHitVL: number; basicHitVR: number;
  pitchVL: number; pitchVR: number; pitchOVR: number; basicPitch: number; basicPitchVL: number; basicPitchVR: number;
  def: Record<string, number>;
}
export interface Meta {
  configName: string; tournament: string; account: string; accountId: string | null;
  catalogSource: string; cardCount: number; eligibleCount: number; ownedCount: number;
}
export interface RosterSlotCard { pos?: string; slot?: number; id: string; title: string; cost: number; stamina?: number; pitchTypes?: number }
export interface CardDef { ifR: number; ifE: number; ifA: number; dp: number; cAb: number; cFr: number; cAr: number; ofR: number; ofE: number; ofA: number }
// `positions` = QUALIFIED to START (meets starter def min); `coverPositions` = QUALIFIED to
// BACK UP (meets starter OR backup min); `allPositions` = ELIGIBLE (can play, Learn).
export interface RosterHitterRow { id: string; title: string; last: string; first?: string; bats: string; role: string; twoWay: boolean; positions: string[]; coverPositions?: string[]; allPositions?: string[]; def: CardDef; wobaVL: number; wobaVR: number; cost: number; owned: number }
export interface RosterPitcherRow { id: string; title: string; last: string; first?: string; throws: string; role: string; twoWay: boolean; woba: number; wobaSP?: number; wobaRP?: number; stamina: number; pitchTypes: number; cost: number; owned: number }
// Next Best Available pool (M5) — every available card as one unified row (both
// hit + pitch values); the client derives hitter/pitcher cards per tab.
// `positions` = every position the card can play (Learn); `startPositions` = the starter-eligible (def-met) subset.
export interface AvailRow {
  id: string; title: string; last: string; bats: string; throws: string;
  positions: string[]; startPositions?: string[]; def: CardDef; cost: number; owned: number;
  hitVL: number; hitVR: number; pitOVR: number; pitVL: number; pitVR: number;
  stamina: number; pitchTypes: number;
}
// Per-card shapes the Available cards + manual-add use (derived from AvailRow).
export interface AvailHitterRow { id: string; title: string; last: string; bats: string; positions: string[]; startPositions?: string[]; def: CardDef; cost: number; owned: number; wobaVL: number; wobaVR: number }
export interface AvailPitcherRow { id: string; title: string; last: string; throws: string; cost: number; owned: number; stamina: number; pitchTypes: number; woba: number; wobaVL: number; wobaVR: number }
// A manually-added card (fills an open roster slot); tagged by which table it joins.
export type AddedCard = { kind: "hitter"; row: AvailHitterRow } | { kind: "pitcher"; row: AvailPitcherRow };
export interface SlotTierUsage { threshold: number; limit: number; used: number }
export interface RosterResult {
  status: string; mode: string; cap: number | null; cost: number | null; objective: number; ownedOnly: boolean; metric: string;
  slotUsage?: SlotTierUsage[] | null;
  minStarterStamina: number; minPitchTypes: number;
  balance: { hitterValue: number; pitcherValue: number } | null;
  expectedWinPct?: number | null; // calibrated E[win%] (cap/slots): .500 = a perfect 0-variant roster
  poolHitters: number; poolPitchers: number; rosterSize: number; nHitters: number; nPitchers: number;
  lineupVR: RosterSlotCard[]; lineupVL: RosterSlotCard[];
  rotation: RosterSlotCard[]; bullpen: RosterSlotCard[]; bench: RosterSlotCard[];
  rosterHitters: RosterHitterRow[]; rosterPitchers: RosterPitcherRow[];
  memberIds: string[]; twoWayIds: string[];
  nextBest: { available: AvailRow[] };
  cardValueMin: number; cardValueMax: number | null;
  roles: Record<string, string>; // base Card ID -> both|vL|vR|bench|starter|reliever|twoway
  biggestUpgrades?: BiggestUpgrades | null; // unowned acquisition targets (owned-only; cap/slots totals are refined exact via /api/upgrades/refine)
}

// Biggest Upgrades (M5b): non-owned cards that would improve the current roster. Hitters
// ranked by combined lineup-assignment marginal (per-side deltas show both-sides vs platoon);
// pitchers vs the weakest rotation (SP) / bullpen (RP) arm. `total` = the upgrade magnitude.
// `refined` (client-only) = this row's `total` is the exact stage-2 marginal (cap/slots).
export interface UpgradeHitter { id: string; title: string; last: string; bats: string; positions: string[]; allPositions?: string[]; cost: number; deltaVR: number; deltaVL: number; total: number; twoWay: boolean; refined?: boolean }
export interface UpgradePitcher { id: string; title: string; last: string; throws: string; stamina: number; pitchTypes: number; cost: number; total: number; twoWay: boolean; refined?: boolean }
export interface BiggestUpgrades { hitters: UpgradeHitter[]; sp: UpgradePitcher[]; rp: UpgradePitcher[] }
// Stage-2 exact refinement result for one candidate (value units): per-side lineup
// deltas (hitters) + the weighted total. Streamed in and populated onto the row.
export interface RefinedValue { total: number; dVR?: number; dVL?: number }

// Per-card pool override (Roster page Actions). "auto" = no override (default).
export type RoleOverride = "hitter" | "pitcher" | "twoway";

// Lineup position lock (S5.3): pin a hitter to a defensive position in one platoon
// lineup (vL/vR independent). Round-trips to the optimizer on Regenerate so the
// LP keeps the locked player at that position (displacing whoever it would pick).
export interface LineupLock { id: string; pos: string; side: "L" | "R" }
export const lockKey = (side: "L" | "R", id: string) => `${side}:${id}`;

// Roster role colours (match the old app): both/starter = blue, vL = purple,
// vR = green, bench/reliever = orange.
export const ROSTER_COLORS: Record<string, string> = {
  both: "rgba(59, 130, 246, 0.28)",
  vL: "rgba(168, 85, 247, 0.28)",
  vR: "rgba(34, 197, 94, 0.28)",
  bench: "rgba(249, 115, 22, 0.28)",
  starter: "rgba(59, 130, 246, 0.28)",
  reliever: "rgba(249, 115, 22, 0.28)",
  twoway: "rgba(234, 179, 8, 0.30)", // two-way = amber/gold
};
export const ROSTER_BORDER: Record<string, string> = {
  both: "#3b82f6", vL: "#a855f7", vR: "#22c55e", bench: "#f97316", starter: "#3b82f6", reliever: "#f97316", twoway: "#eab308",
};
export const ROLE_LABEL: Record<string, string> = {
  both: "Both", vL: "vL", vR: "vR", bench: "Bench", starter: "Starter", reliever: "Reliever", twoway: "Two-way",
};

export interface TournamentOpt { id: string; name: string }
// Eligibility rules (mirror the server engine — rowEligible).
export type RuleOp =
  | "num_between" | "num_ge" | "num_gt" | "num_le" | "num_lt" | "num_eq"
  | "set_in" | "set_not_in" | "text_contains" | "text_equals" | "is_blank" | "is_not_blank";
export interface EligibilityRule { id: string; column: string; op: RuleOp; a?: string; b?: string; values?: string[] }
export interface EligibilityGroup { mode: "ALL" | "ANY"; rules: EligibilityRule[] }
// Full tournament config for the editor (Phase 1). softcaps/eligibility ride along
// opaquely (loaded, preserved on save — not edited in Phase 1).
export interface TournamentCfg {
  id: string; name: string;
  kind?: "league" | "tournament"; // league ⇒ use the model's realized platoon splits; tournament ⇒ pool baseline + deployment
  card_value_min?: number | null; card_value_max?: number | null; total_cap?: number | null;
  roster_size: number; hitters: number; pitchers: number;
  min_starters: number; min_starter_stamina: number; min_pitch_types: number; dh: boolean;
  variants_allowed: boolean; max_variants_on_roster: number;
  eraId: string; parkId: string;
  topHitters?: number | null; topPitchers?: number | null;
  budget_mode?: "none" | "cap" | "slots"; slot_counts?: Record<string, number>;
  platoonVR?: number; platoonVL?: number; minPlayersPerPosition?: number;
  // Per-hand OVR-blend splits (seeded from the active model on create; absent ⇒ model/coeff defaults).
  platoon?: {
    r_hit_split: number; l_hit_split: number; s_hit_split: number; r_pitch_split: number; l_pitch_split: number;
    // Role-conditional pitch splits (SP vs RP usage); optional — absent ⇒ active-model role split / role-blind fallback.
    r_pitch_split_sp?: number; l_pitch_split_sp?: number; r_pitch_split_rp?: number; l_pitch_split_rp?: number;
  };
  eligibility?: EligibilityGroup;
  tournamentAdjustment?: TournamentAdjustment; // second era-modifier set (multiplied onto era)
  softcaps?: Record<string, number>; // cap_<grp>_top/_bot + pen_<grp>
  positionMins?: Record<string, PositionMin>;
  positionRanks?: Record<string, PositionMin>; // top-K rank requirement (value = K) per rating
  // E[wins] optimizer (cap/slots only): series format + Tier-1 steering. Absent ⇒ defaults.
  bestOf?: number;
  tuning?: TournamentTuning;
}

// User steering for the E[wins] cap/slots objective (all optional; absent ⇒ model defaults).
export interface TournamentTuning {
  rotationShare?: number;      // fraction of team BF thrown by the rotation (vs bullpen)
  rotationDecay?: number;      // extra tilt of rotation innings toward SP1 ("value SP5 less")
  platoonCapture?: number;     // ρ: how often a fielded card gets its favorable matchup
  fullStrengthShare?: number;  // fraction of games at full strength (bench-depth value)
  bullpenLeverage?: number[];  // leverage premiums for the top relievers [closer, setup, …]
  dials?: { lineup?: number; bench?: number; rotation?: number; bullpen?: number }; // relative spend
}
// Per-position min defensive ratings (starter = bar to start, backup = bar to cover).
// For positionRanks the same shape holds, but each value is a top-K rank (not a rating min).
export interface PositionMin { starter?: Record<string, number>; backup?: Record<string, number> }

// Tournament environment adjustment — a second era-modifier set multiplied onto the era
// factors (era × adj). OFF by default everywhere (retired as a blanket default 2026-07-12 —
// the bias it targeted is role-asymmetric; see src/config/tournament.ts). Enabling the knob
// in the editor starts from HR 1.15 / BB 0.85 / others 1.0.
export interface TournamentAdjustment { enabled: boolean; hr: number; bb: number; k: number; h: number; gap: number }
export const TOURNAMENT_ADJ_DEFAULTS: TournamentAdjustment = { enabled: false, hr: 1.15, bb: 0.85, k: 1, h: 1, gap: 1 };

// New-tournament defaults (the +New template). era-2010 = BBRef baseline; park-1 = Heinsohn
// (neutral). platoon/platoonVR/VL are intentionally omitted so the server seeds them from the
// active model on create; softcaps omitted so the server preserves the base softcaps.
export const DEFAULT_ERA_ID = "era-2010";
export const DEFAULT_PARK_ID = "park-1";
export const TOURNAMENT_DEFAULTS = {
  roster_size: 26, hitters: 14, pitchers: 12, min_starters: 5, min_starter_stamina: 55,
  min_pitch_types: 3, topHitters: 100, topPitchers: 100, minPlayersPerPosition: 2,
  max_variants_on_roster: 0,
} as const;
export function newTournamentCfg(): TournamentCfg {
  return {
    id: "", name: "New Tournament",
    card_value_min: null, card_value_max: null, total_cap: null,
    roster_size: TOURNAMENT_DEFAULTS.roster_size, hitters: TOURNAMENT_DEFAULTS.hitters, pitchers: TOURNAMENT_DEFAULTS.pitchers,
    min_starters: TOURNAMENT_DEFAULTS.min_starters, min_starter_stamina: TOURNAMENT_DEFAULTS.min_starter_stamina,
    min_pitch_types: TOURNAMENT_DEFAULTS.min_pitch_types, dh: true,
    variants_allowed: true, max_variants_on_roster: TOURNAMENT_DEFAULTS.max_variants_on_roster,
    eraId: DEFAULT_ERA_ID, parkId: DEFAULT_PARK_ID,
    topHitters: TOURNAMENT_DEFAULTS.topHitters, topPitchers: TOURNAMENT_DEFAULTS.topPitchers,
    budget_mode: "none", minPlayersPerPosition: TOURNAMENT_DEFAULTS.minPlayersPerPosition,
    eligibility: { mode: "ALL", rules: [] },
    tournamentAdjustment: { ...TOURNAMENT_ADJ_DEFAULTS },
  };
}
const IF_KEYS = [{ key: "range", label: "Range" }, { key: "error", label: "Error" }, { key: "arm", label: "Arm" }, { key: "dp", label: "DP" }];
const OF_KEYS = [{ key: "range", label: "Range" }, { key: "error", label: "Error" }, { key: "arm", label: "Arm" }];
const C_KEYS = [{ key: "ability", label: "Ability" }, { key: "frame", label: "Frame" }, { key: "arm", label: "Arm" }];
export const POSITION_RATING_KEYS: Record<string, { key: string; label: string }[]> = {
  C: C_KEYS, "1B": IF_KEYS, "2B": IF_KEYS, "3B": IF_KEYS, SS: IF_KEYS, LF: OF_KEYS, CF: OF_KEYS, RF: OF_KEYS,
};
export const FIELD_POS = ["C", "1B", "2B", "3B", "SS", "LF", "CF", "RF"] as const;
// Softcap rating groups: per group, ratings above _top get diminishing returns and
// below _bot get penalized, by strength pen_<grp>. 5 hitting + 4 pitching.
export const SOFTCAP_GROUPS: { key: string; label: string }[] = [
  { key: "k", label: "Avoid K" }, { key: "babip", label: "BABIP" }, { key: "gap", label: "Gap" },
  { key: "pow", label: "Power" }, { key: "eye", label: "Eye" },
  { key: "p_con", label: "Control (P)" }, { key: "p_stu", label: "Stuff (P)" },
  { key: "p_pbabip", label: "pBABIP (P)" }, { key: "p_hrr", label: "HR rate (P)" },
];
export const SLOT_TIER_KEYS = ["perfect", "diamond", "gold", "silver", "bronze", "iron"] as const;
// Reusable run-environment libraries (referenced by tournaments by id).
export interface ParkCfg {
  id: string; name: string; avg_l: number; avg_r: number; hr_l: number; hr_r: number; gap: number;
  gap_l?: number; gap_r?: number; triple?: number; triple_l?: number; triple_r?: number;
  year?: number; league?: string; team?: string; ptLevel?: number;
}
export interface EraCfg {
  id: string; name: string; bb: number; k: number; avg: number; hr: number; bip: number; gap: number;
  thr_toggle: boolean; thr?: number; year?: number; hbp?: number;
}
export interface AccountOpt { id: string; name: string; ownedCount: number; totalQty: number; variantCount: number }

export const C = {
  bg: "#1e2228", text: "#d7dbe0", sub: "#9aa3ad", border: "#3a414b",
  head: "#2a2f37", headActive: "#3b4657", stripe: "#23282f", row: "#1e2228",
  input: "#2a2f37", hot: "#4a4326", accent: "#2563eb", star: "#b06bf0", panel: "#2a2f37", link: "#7aa2f7",
  sidebar: "#181b20", navActive: "#2d3340",
};

export const inputStyle: CSSProperties = {
  background: C.input, color: C.text, border: `1px solid ${C.border}`, borderRadius: 4, padding: "6px 8px", fontSize: 13,
};

export const haystack = (c: Card) => `${c.title} ${c.first} ${c.last} ${c.id}`.toLowerCase();
