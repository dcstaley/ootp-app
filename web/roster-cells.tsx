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
export const posStr = (positions: string[]) => {
  const f = positions.filter((p) => p !== "DH");
  if (!f.length) return "DH";
  return f.length > 7 ? f.slice(0, 7).join("/") + "…" : f.join("/"); // cap at 7 positions
};

// POS cell: shows every position a card CAN play (Learn), with positions it does NOT
// meet the tournament's defensive minimum for shown in amber (still playable, just
// below the def requirement to start there). `eligible` = the starter-eligible subset.
export const posCell = (all: string[], eligible: string[]): ReactNode => {
  const elig = new Set(eligible);
  const f = [...all].filter((p) => p !== "DH").sort((a, b) => posRank(a) - posRank(b));
  if (!f.length) return "DH";
  const shown = f.slice(0, 7);
  return (
    <span>
      {shown.map((p, i) => (
        <span key={p}>
          {i > 0 && <span style={{ color: C.sub }}>/</span>}
          <span style={elig.has(p) ? undefined : { color: "#fbbf24" }} title={elig.has(p) ? undefined : `${p}: below this tournament's defensive minimum to start`}>{p}</span>
        </span>
      ))}
      {f.length > 7 && <span style={{ color: C.sub }}>…</span>}
    </span>
  );
};

export const star = (t: string): ReactNode => (t.startsWith("★") ? <><span style={{ color: C.star }}>★</span>{t.slice(1)}</> : t);

export const twoWayBadge = (
  <span title="Two-way: fills a hitter and a pitcher slot" style={{ marginLeft: 5, padding: "0 4px", borderRadius: 3, fontSize: 10, fontWeight: 700, background: ROSTER_COLORS.twoway, border: `1px solid ${ROSTER_BORDER.twoway}`, color: "#fde68a" }}>2W</span>
);

// BsR badge: flags a card's baserunning contribution (steals + extra bases), which is already folded
// into the vL/vR Offense value but otherwise invisible. Only shown when notable (|BsR| ≥ 1.5 runs) so
// average baserunners don't clutter the row; green = plus, red = minus. Full split is on the Cards grid.
export const bsrBadge = (bsr: number | undefined): ReactNode => {
  if (bsr == null || !Number.isFinite(bsr) || Math.abs(bsr) < 1.5) return null;
  const pos = bsr >= 0, s = `${pos ? "+" : ""}${bsr.toFixed(1)}`;
  return (
    <span title={`Baserunning ${s} runs/600 (steals + extra bases) — already included in the vL/vR value; batting-only wOBA + BsR are on the Cards grid`}
      style={{ marginLeft: 5, padding: "0 4px", borderRadius: 3, fontSize: 10, fontWeight: 700,
        background: pos ? "rgba(34,197,94,0.16)" : "rgba(239,68,68,0.16)", border: `1px solid ${pos ? "#22c55e" : "#ef4444"}`, color: pos ? "#86efac" : "#fca5a5" }}>
      {s} BsR
    </span>
  );
};

// Role-override dropdown colours (Hit = green, Pitch = blue, 2way = amber).
export const ROLE_OV: Record<string, { bg: string; bd: string; fg: string }> = {
  hitter: { bg: "rgba(34,197,94,0.20)", bd: "#22c55e", fg: "#86efac" },
  pitcher: { bg: "rgba(59,130,246,0.22)", bd: "#3b82f6", fg: "#93c5fd" },
  twoway: { bg: "rgba(234,179,8,0.22)", bd: "#eab308", fg: "#fde68a" },
};

// Card titles are "<series/type> <Pos> <First Last> <TEAM> <Year>". Rendered as plain inline
// text (the cell truncates it on the right with an ellipsis); we only BOLD the player's name
// (located via First+Last) for legibility. Falls back to the plain title if not found.
export const nameCell = (r: { title: string; first?: string; last?: string; owned: number; twoWay?: boolean; bsr?: number }): ReactNode => {
  const name = [r.first, r.last].filter(Boolean).join(" ").trim();
  const idx = name ? r.title.toLowerCase().indexOf(name.toLowerCase()) : -1;
  const body: ReactNode = idx < 0
    ? star(r.title)
    : <>{star(r.title.slice(0, idx))}<b style={{ fontWeight: 700 }}>{r.title.slice(idx, idx + name.length)}</b>{r.title.slice(idx + name.length)}</>;
  return (
    <span>
      {r.owned <= 0 && <span style={{ color: "#ef4444", fontWeight: 700, marginRight: 4 }} title="Not owned">!</span>}
      {body}{r.twoWay && twoWayBadge}{bsrBadge(r.bsr)}
    </span>
  );
};

export function defStr(d: CardDef, pos: string): string {
  if (pos === "C") return `Ab${d.cAb} Fr${d.cFr} Ar${d.cAr}`;
  if (IF.includes(pos)) return `R${d.ifR} E${d.ifE} A${d.ifA} DP${d.dp}`;
  if (OF.includes(pos)) return `R${d.ofR} E${d.ofE} A${d.ofA}`;
  return "";
}

// Group ratings (label + its individual ratings) the card has, capped at 8 ratings total
// with a trailing "…" when there are more (keeps multi-position lines from running wide).
// Uses ALL positions the card can play (allPositions) — a player shows the ratings for a
// position they can play even when they don't meet its defensive minimum (e.g. Prince
// Fielder still shows IF ratings at 1B).
export function defSummary(h: { positions: string[]; allPositions?: string[]; def: CardDef }): string {
  const pos = h.allPositions ?? h.positions;
  const segs: [string, string][] = [];
  if (pos.includes("C")) segs.push(["C", defStr(h.def, "C")]);
  if (IF.some((p) => pos.includes(p))) segs.push(["IF", defStr(h.def, "1B")]);
  if (OF.some((p) => pos.includes(p))) segs.push(["OF", defStr(h.def, "LF")]);
  let budget = 8, truncated = false;
  const parts: string[] = [];
  for (const [label, str] of segs) {
    if (budget <= 0) { truncated = true; break; }
    const rs = str.split(" ");
    const take = rs.slice(0, budget);
    parts.push(`${label} ${take.join(" ")}`);
    budget -= take.length;
    if (take.length < rs.length) truncated = true;
  }
  return parts.join("   ") + (truncated ? " …" : "");
}
