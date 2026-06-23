// Shared types + theme used across the shell and pages.
import type { CSSProperties } from "react";

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
export interface RosterHitterRow { id: string; title: string; last: string; bats: string; role: string; positions: string[]; def: CardDef; wobaVL: number; wobaVR: number; cost: number; owned: number }
export interface RosterPitcherRow { id: string; title: string; last: string; throws: string; role: string; woba: number; stamina: number; pitchTypes: number; cost: number; owned: number }
export interface RosterResult {
  status: string; mode: string; cap: number | null; cost: number | null; objective: number; ownedOnly: boolean;
  minStarterStamina: number; minPitchTypes: number;
  balance: { hitterValue: number; pitcherValue: number } | null;
  poolHitters: number; poolPitchers: number;
  lineupVR: RosterSlotCard[]; lineupVL: RosterSlotCard[];
  rotation: RosterSlotCard[]; bullpen: RosterSlotCard[]; bench: RosterSlotCard[];
  rosterHitters: RosterHitterRow[]; rosterPitchers: RosterPitcherRow[];
  memberIds: string[];
  roles: Record<string, string>; // base Card ID -> both|vL|vR|bench|starter|reliever
}

// Roster role colours (match the old app): both/starter = blue, vL = purple,
// vR = green, bench/reliever = orange.
export const ROSTER_COLORS: Record<string, string> = {
  both: "rgba(59, 130, 246, 0.28)",
  vL: "rgba(168, 85, 247, 0.28)",
  vR: "rgba(34, 197, 94, 0.28)",
  bench: "rgba(249, 115, 22, 0.28)",
  starter: "rgba(59, 130, 246, 0.28)",
  reliever: "rgba(249, 115, 22, 0.28)",
};
export const ROSTER_BORDER: Record<string, string> = {
  both: "#3b82f6", vL: "#a855f7", vR: "#22c55e", bench: "#f97316", starter: "#3b82f6", reliever: "#f97316",
};
export const ROLE_LABEL: Record<string, string> = {
  both: "Both", vL: "vL", vR: "vR", bench: "Bench", starter: "Starter", reliever: "Reliever",
};

export interface TournamentOpt { id: string; name: string }
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
