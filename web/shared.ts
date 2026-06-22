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
export interface RosterResult {
  status: string; mode: string; cap: number | null; cost: number | null; objective: number;
  balance: { hitterValue: number; pitcherValue: number } | null;
  poolHitters: number; poolPitchers: number;
  lineupVR: RosterSlotCard[]; lineupVL: RosterSlotCard[];
  rotation: RosterSlotCard[]; bullpen: RosterSlotCard[]; bench: RosterSlotCard[];
  memberIds: string[];
}

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
