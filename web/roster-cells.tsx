// Shared presentational helpers for the roster/lineup tables (cell renderers,
// position helpers, defensive-rating formatting). Extracted from RosterPage so the
// LineupTab editor can reuse them without duplicating the formatting.

import { type ReactNode } from "react";
import { C, ROSTER_COLORS, ROSTER_BORDER, type CardDef } from "./shared.ts";

export const IF = ["1B", "2B", "3B", "SS"];
export const OF = ["LF", "CF", "RF"];
export const FIELD = ["C", "1B", "2B", "3B", "SS", "LF", "CF", "RF"];
export const POS_ORDER = ["C", "1B", "2B", "3B", "SS", "LF", "CF", "RF", "DH"];
export const posRank = (p: string) => { const i = POS_ORDER.indexOf(p); return i < 0 ? 99 : i; };
export const posStr = (positions: string[]) => { const f = positions.filter((p) => p !== "DH"); return f.length ? f.join("/") : "DH"; };

export const star = (t: string): ReactNode => (t.startsWith("★") ? <><span style={{ color: C.star }}>★</span>{t.slice(1)}</> : t);

export const twoWayBadge = (
  <span title="Two-way: fills a hitter and a pitcher slot" style={{ marginLeft: 5, padding: "0 4px", borderRadius: 3, fontSize: 10, fontWeight: 700, background: ROSTER_COLORS.twoway, border: `1px solid ${ROSTER_BORDER.twoway}`, color: "#fde68a" }}>2W</span>
);

// Role-override dropdown colours (Hit = green, Pitch = blue, 2way = amber).
export const ROLE_OV: Record<string, { bg: string; bd: string; fg: string }> = {
  hitter: { bg: "rgba(34,197,94,0.20)", bd: "#22c55e", fg: "#86efac" },
  pitcher: { bg: "rgba(59,130,246,0.22)", bd: "#3b82f6", fg: "#93c5fd" },
  twoway: { bg: "rgba(234,179,8,0.22)", bd: "#eab308", fg: "#fde68a" },
};

export const nameCell = (r: { title: string; owned: number; twoWay?: boolean }): ReactNode => (
  <span>{r.owned <= 0 && <span style={{ color: "#ef4444", fontWeight: 700, marginRight: 4 }} title="Not owned">!</span>}{star(r.title)}{r.twoWay && twoWayBadge}</span>
);

export function defStr(d: CardDef, pos: string): string {
  if (pos === "C") return `Ab${d.cAb} Fr${d.cFr} Ar${d.cAr}`;
  if (IF.includes(pos)) return `R${d.ifR} E${d.ifE} A${d.ifA} DP${d.dp}`;
  if (OF.includes(pos)) return `R${d.ofR} E${d.ofE} A${d.ofA}`;
  return "";
}

export function defSummary(h: { positions: string[]; def: CardDef }): string {
  const parts: string[] = [];
  if (h.positions.includes("C")) parts.push(`C ${defStr(h.def, "C")}`);
  if (IF.some((p) => h.positions.includes(p))) parts.push(`IF ${defStr(h.def, "1B")}`);
  if (OF.some((p) => h.positions.includes(p))) parts.push(`OF ${defStr(h.def, "LF")}`);
  return parts.join("   ");
}
