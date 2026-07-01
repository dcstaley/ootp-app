// M4 — Roster & Lineups page. One page, three sub-tabs (Roster / Lineups /
// Pitching) over the same generated roster; all tables sortable. Generation
// controls live here: Owned-only, plus per-card Lock (required) / Exclude
// (forbidden) / Remove (drop from the current roster — returns on Regenerate).
// Lineups support manual position assignment via per-player dropdowns.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DndContext, PointerSensor, useSensor, useSensors, useDraggable, useDroppable, type DragEndEvent } from "@dnd-kit/core";
import { useAppData } from "./state.tsx";
import { DataTable, type Column } from "./DataTable.tsx";
import { LineupTab } from "./LineupTab.tsx";
import {
  C, inputStyle, ROSTER_COLORS, ROSTER_BORDER, ROLE_LABEL,
  type RosterHitterRow, type RosterPitcherRow, type RoleOverride, type AvailRow, type AvailHitterRow, type AvailPitcherRow, type AddedCard,
  type BiggestUpgrades, type UpgradeHitter, type UpgradePitcher, type RefinedValue,
} from "./shared.ts";
import { IF, OF, posStr, posCell, star, nameCell, defSummary, ROLE_OV } from "./roster-cells.tsx";

function Legend({ roles }: { roles: string[] }) {
  return (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 12, color: C.sub, margin: "0 0 12px" }}>
      {roles.map((r) => (
        <span key={r} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 11, height: 11, borderRadius: 2, background: ROSTER_COLORS[r], border: `1px solid ${ROSTER_BORDER[r]}` }} />{ROLE_LABEL[r]}
        </span>
      ))}
    </div>
  );
}

// Pool→roster drag: a Next Best card you can drag onto the roster tables to add +
// lock it (mirrors the +Add button). 5px activation so the +Add click and the rail
// scroll still work. Disabled when the roster is full.
function PoolDraggable({ id, disabled, children }: { id: string; disabled?: boolean; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: `pool:${id}`, disabled });
  return (
    <div ref={setNodeRef} {...attributes} {...(disabled ? {} : listeners)}
      style={{ border: `1px solid ${C.border}`, borderRadius: 6, padding: "5px 7px", cursor: disabled ? "default" : "grab", touchAction: "none", opacity: isDragging ? 0.4 : 1, transform: transform ? `translate(${transform.x}px, ${transform.y}px)` : undefined, zIndex: isDragging ? 50 : undefined, position: isDragging ? "relative" : undefined }}>
      {children}
    </div>
  );
}
function RosterDropZone({ children }: { children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: "roster-drop" });
  return <div ref={setNodeRef} style={{ flex: "999 1 500px", minWidth: 0, maxWidth: 1320, borderRadius: 10, outline: isOver ? `2px dashed ${C.accent}` : "none", outlineOffset: 4 }}>{children}</div>;
}

// Biggest Upgrades — unowned acquisition targets that would improve the roster. Hitters
// ranked by combined lineup-assignment marginal (per-side deltas reveal both-sides vs
// platoon); SP/RP vs the weakest rotation/bullpen arm. ✕ excludes the card and pulls in
// the next-best immediately. Owned-only; in cap/slots the Total is the single-swap stage-1
// estimate, refined in place to the exact whole-roster marginal (stage 2) as it streams in.
function UpgradesPanel({ data, onExclude, onAcquire, busy, refining, refinedCount }: { data: BiggestUpgrades; onExclude: (id: string) => void; onAcquire: (id: string) => void; busy: boolean; refining?: boolean; refinedCount?: number }) {
  const pts = (x: number) => (x >= 0 ? "+" : "−") + Math.round(Math.abs(x) * 1000); // wOBA points
  const dColor = (x: number) => (x > 0.0005 ? "#86efac" : x < -0.0005 ? "#f87171" : C.sub);
  // Numbers come only from stage-2 and populate as each re-solve lands; a pending row
  // shows "…" until its exact value arrives.
  const val = (row: { refined?: boolean }, x: number) => row.refined ? pts(x) : "…";
  const numCell = (row: { refined?: boolean }, x: number, bold = false): React.CSSProperties =>
    ({ ...td, textAlign: "right", fontWeight: bold ? 700 : 400, color: row.refined ? dColor(x) : C.sub, opacity: row.refined ? 1 : 0.5 });
  const exBtn = (id: string) => (
    <button onClick={() => onExclude(id)} disabled={busy} title="Exclude this card and replace it with the next-best upgrade"
      style={{ ...inputStyle, padding: "1px 0", width: 24, textAlign: "center", boxSizing: "border-box", fontSize: 12, cursor: busy ? "default" : "pointer", color: "#f87171", border: "1px solid #ef4444" }}>✕</button>
  );
  const addBtn = (id: string) => (
    <button onClick={() => onAcquire(id)} disabled={busy} title="Acquire: lock this card onto the roster and regenerate"
      style={{ ...inputStyle, padding: "1px 0", width: 24, textAlign: "center", boxSizing: "border-box", fontSize: 12, cursor: busy ? "default" : "pointer", color: "#86efac", border: "1px solid #22c55e" }}>+</button>
  );
  const actions = (id: string) => <div style={{ display: "flex", gap: 3, justifyContent: "center" }}>{addBtn(id)}{exBtn(id)}</div>;
  const tag = (on: boolean) => on ? <span style={{ fontSize: 10, color: ROSTER_BORDER.twoway, border: `1px solid ${ROSTER_BORDER.twoway}`, borderRadius: 3, padding: "0 3px", marginLeft: 5, whiteSpace: "nowrap" }}>2-way</span> : null;
  const th: React.CSSProperties = { padding: "2px 6px", color: C.sub, fontWeight: 600, fontSize: 11, textAlign: "right" };
  const td: React.CSSProperties = { padding: "3px 6px", fontVariantNumeric: "tabular-nums" };
  const name = (title: string, twoWay: boolean) => <td style={{ ...td, lineHeight: 1.25, overflowWrap: "anywhere" }}>{star(title)}{tag(twoWay)}</td>;
  const empty = <p style={{ fontSize: 12, color: C.sub, margin: "2px 0" }}>None — no unowned upgrades.</p>;

  const hitters = (
    <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
      <thead><tr>
        <th style={{ ...th, textAlign: "left" }}>Hitter</th><th style={{ ...th, textAlign: "left" }}>Pos</th>
        <th style={th} title="Lineup gain vs RHP (counts full)">vR</th>
        <th style={th} title="Lineup gain vs LHP, discounted by this tournament's LHP exposure (you face LHP less often)">vL</th>
        <th style={th} title="OVR = vR + vL (a sum, not an average)">Total</th><th style={th}>Cost</th><th />
      </tr></thead>
      <tbody>{data.hitters.map((h: UpgradeHitter) => (
        <tr key={h.id} style={{ borderTop: `1px solid ${C.border}55` }}>
          {name(h.title, h.twoWay)}
          <td style={{ ...td, color: C.sub }}>{posCell(h.allPositions ?? h.positions, h.positions)}</td>
          <td style={numCell(h, h.deltaVR)}>{val(h, h.deltaVR)}</td>
          <td style={numCell(h, h.deltaVL)}>{val(h, h.deltaVL)}</td>
          <td style={numCell(h, h.total, true)}>{val(h, h.total)}</td>
          <td style={{ ...td, textAlign: "right", color: C.sub }}>{h.cost}</td>
          <td style={{ ...td, textAlign: "center" }}>{actions(h.id)}</td>
        </tr>
      ))}</tbody>
    </table>
  );
  const staff = (rows: UpgradePitcher[], showStam: boolean) => (
    <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
      <thead><tr>
        <th style={{ ...th, textAlign: "left" }}>Pitcher</th><th style={th}>Δ</th>
        {showStam && <th style={th}>Stam</th>}<th style={th}>Cost</th><th />
      </tr></thead>
      <tbody>{rows.map((p) => (
        <tr key={p.id} style={{ borderTop: `1px solid ${C.border}55` }}>
          {name(p.title, p.twoWay)}
          <td style={numCell(p, p.total, true)}>{val(p, p.total)}</td>
          {showStam && <td style={{ ...td, textAlign: "right", color: C.sub }}>{p.stamina}</td>}
          <td style={{ ...td, textAlign: "right", color: C.sub }}>{p.cost}</td>
          <td style={{ ...td, textAlign: "center" }}>{actions(p.id)}</td>
        </tr>
      ))}</tbody>
    </table>
  );

  return (
    <div style={{ marginTop: 16, borderTop: `1px solid ${C.border}`, paddingTop: 12 }}>
      <h3 style={{ margin: "0 0 4px", fontSize: 14 }}>Biggest Upgrades <span style={{ fontSize: 12, fontWeight: 400, color: C.sub }}>· unowned cards that would improve this roster (Δ in wOBA points)</span>
        {refining
          ? <span style={{ fontSize: 11, fontWeight: 400, color: C.link, marginLeft: 8 }}>· computing exact values…{refinedCount ? ` (${refinedCount})` : ""}</span>
          : <span style={{ fontSize: 11, fontWeight: 400, color: "#86efac", marginLeft: 8 }}>· exact (whole-roster re-solve)</span>}
      </h3>
      <div style={{ display: "flex", gap: 22, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div style={{ flex: "2 1 420px", minWidth: 340 }}>
          <h4 style={{ margin: "4px 0 2px", fontSize: 12, color: C.link }}>Hitters</h4>
          {data.hitters.length ? hitters : empty}
        </div>
        <div style={{ flex: "1 1 240px", minWidth: 220 }}>
          <h4 style={{ margin: "4px 0 2px", fontSize: 12, color: C.link }}>Starting Pitchers</h4>
          {data.sp.length ? staff(data.sp, true) : empty}
        </div>
        <div style={{ flex: "1 1 200px", minWidth: 200 }}>
          <h4 style={{ margin: "4px 0 2px", fontSize: 12, color: C.link }}>Relievers</h4>
          {data.rp.length ? staff(data.rp, false) : empty}
        </div>
      </div>
    </div>
  );
}

type Tab = "roster" | "lineups" | "pitching";
type AvailCat = "hitVR" | "hitVL" | "pitch" | "sp" | "ifRng" | "ofRng" | "cAbil";
const AVAIL_CATS: { id: AvailCat; label: string; kind: "hitter" | "pitcher" }[] = [
  { id: "hitVR", label: "Hit vR", kind: "hitter" }, { id: "hitVL", label: "Hit vL", kind: "hitter" },
  { id: "pitch", label: "Pitch", kind: "pitcher" }, { id: "sp", label: "SP", kind: "pitcher" },
  { id: "ifRng", label: "IF Rng", kind: "hitter" }, { id: "ofRng", label: "OF Rng", kind: "hitter" },
  { id: "cAbil", label: "C Abil", kind: "hitter" },
];
type PStaffRow = RosterPitcherRow & { slotLabel: string };

export function RosterPage() {
  const {
    roster, rosterLoading, generateRoster, meta, ownedOnly, setOwnedOnly, metric, setMetric,
    locked, excluded, removed, dirty, toggleLock, toggleExclude, removeCard, excludeNoRegen, fetchUpgrades, refineUpgrades, acquireCard,
    added, addCard, roles: roleOverrides, setRole, cards,
  } = useAppData();
  const [tab, setTab] = useState<Tab>("roster");
  const [availCat, setAvailCat] = useState<AvailCat>("hitVR");
  const [nbOwnedOnly, setNbOwnedOnly] = useState(true); // Next Best: owned-only view
  const [nbMaxValue, setNbMaxValue] = useState("");      // Next Best: max Card Value filter

  useEffect(() => { if (!roster && !rosterLoading) generateRoster(); }, []);

  // Biggest Upgrades buffer. Seeded (15/8/8) from each generation; the panel shows the top
  // 10/5/5 after filtering out dismissed (excluded) cards, so a dismiss promotes the next-best
  // instantly with no roster regen. When a bucket runs low, refill from /api/upgrades.
  const [upBuf, setUpBuf] = useState<BiggestUpgrades | null>(null);
  useEffect(() => { setUpBuf(roster?.biggestUpgrades ?? null); }, [roster]);
  const refilling = useRef(false);

  // Stage-2 exact refinement (ALL modes — the one upgrade-value path). Stage 1 only
  // picks the shortlist (which cards to evaluate); its numbers are never shown. Each
  // candidate's exact per-side lineup deltas + weighted total stream in and POPULATE
  // the row as they land. Re-runs whenever the buffer changes (generation / dismiss-refill).
  const [refined, setRefined] = useState<Map<string, RefinedValue>>(new Map());
  const [refineActive, setRefineActive] = useState(false);
  const refineCtl = useRef<AbortController | null>(null);
  useEffect(() => {
    refineCtl.current?.abort();
    setRefined(new Map());
    if (!upBuf) { setRefineActive(false); return; }
    const ctl = new AbortController(); refineCtl.current = ctl;
    setRefineActive(true);
    const shortlist = { hitters: upBuf.hitters.map((h) => h.id), sp: upBuf.sp.map((p) => p.id), rp: upBuf.rp.map((p) => p.id) };
    refineUpgrades(shortlist, (id, r) => setRefined((m) => new Map(m).set(id, r)), ctl.signal)
      .catch(() => { /* aborted or failed */ })
      .finally(() => { if (refineCtl.current === ctl) setRefineActive(false); });
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upBuf]);

  // Build the displayed rows: numbers come ONLY from stage-2. Un-refined rows are pending
  // (shown as "…"); refined rows carry the exact total + per-side deltas, are dropped if
  // non-positive (not a real upgrade), and float above pending, sorted by exact total.
  // Pending rows keep the shortlist order. Slice to the shown count.
  const merge = <T extends UpgradeHitter | UpgradePitcher>(arr: T[], n: number): T[] => {
    const rows = arr.map((x, i) => ({ x, rv: refined.get(x.id), i })).filter(({ rv }) => !rv || rv.total > 0);
    rows.sort((a, b) => {
      if (a.rv && b.rv) return b.rv.total - a.rv.total;
      if (!!a.rv !== !!b.rv) return a.rv ? -1 : 1; // refined (known) above pending
      return a.i - b.i;
    });
    return rows.slice(0, n).map(({ x, rv }) => rv
      ? ({ ...x, total: rv.total, deltaVR: rv.dVR ?? 0, deltaVL: rv.dVL ?? 0, refined: true } as T)
      : ({ ...x, refined: false } as T));
  };
  const upShow = upBuf && {
    hitters: upBuf.hitters.filter((h) => !excluded.has(h.id)),
    sp: upBuf.sp.filter((p) => !excluded.has(p.id)),
    rp: upBuf.rp.filter((p) => !excluded.has(p.id)),
  };
  useEffect(() => {
    if (!upShow || refilling.current) return;
    if (upShow.hitters.length >= 10 && upShow.sp.length >= 5 && upShow.rp.length >= 5) return;
    refilling.current = true;
    fetchUpgrades().then((f) => { if (f) setUpBuf(f); }).finally(() => { refilling.current = false; });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [excluded]);

  // Manually-added cards shown on the roster — hitters as bench bats, pitchers as relievers.
  const addedHitterRows: RosterHitterRow[] = added.filter((a) => a.kind === "hitter")
    .map((a) => ({ ...(a.row as AvailHitterRow), role: "bench", twoWay: false }));
  const addedPitcherRows: RosterPitcherRow[] = added.filter((a) => a.kind === "pitcher")
    .map((a) => { const p = a.row as AvailPitcherRow; return { id: p.id, title: p.title, last: p.last, throws: p.throws, role: "reliever", twoWay: false, woba: p.woba, stamina: p.stamina, pitchTypes: p.pitchTypes, cost: p.cost, owned: p.owned }; });
  // Filtered rosters (manual Remove drops a card; manual Add appends one).
  const hitters = [...(roster?.rosterHitters ?? []), ...addedHitterRows].filter((h) => !removed.has(h.id));
  const pitchers = [...(roster?.rosterPitchers ?? []), ...addedPitcherRows].filter((p) => !removed.has(p.id));
  // Distinct cards (a two-way card is in BOTH tables under one id — count once).
  const distinctCount = new Set([...hitters, ...pitchers].map((r) => r.id)).size;
  const nTwoWay = (roster?.twoWayIds ?? []).filter((id) => !removed.has(id)).length;
  // Open roster slots come from Removing cards; +Add fills them (and locks).
  const rosterSize = roster?.rosterSize ?? 26;
  const emptySpace = roster ? Math.max(0, rosterSize - distinctCount) : 0;
  // The role each card was assigned by the LP (drives the per-card role dropdown's
  // default — there is no "auto" choice; the shown value IS the current role).
  const lpRoleById = new Map<string, RoleOverride>();
  for (const h of roster?.rosterHitters ?? []) lpRoleById.set(h.id, h.twoWay ? "twoway" : "hitter");
  for (const p of roster?.rosterPitchers ?? []) if (!lpRoleById.has(p.id)) lpRoleById.set(p.id, "pitcher");
  // Locked / excluded players — surfaced on the right rail so they can be released.
  const cardById = useMemo(() => new Map(cards.map((c) => [c.id, c])), [cards]);
  const excludedList = [...excluded].map((id) => ({ id, title: cardById.get(id)?.title ?? id }))
    .sort((a, b) => a.title.localeCompare(b.title));
  const lockedList = [...locked].map((id) => ({ id, title: cardById.get(id)?.title ?? id }))
    .sort((a, b) => a.title.localeCompare(b.title));
  const railBtnStyle: React.CSSProperties = { ...inputStyle, padding: "1px 0", width: 26, textAlign: "center", boxSizing: "border-box", fontSize: 12, cursor: "pointer", flex: "0 0 auto", color: "#f87171", border: "1px solid #ef4444" };

  const roleBg = (role: string): React.CSSProperties => ({ background: ROSTER_COLORS[role] });
  const tabBtn = (id: Tab, label: string) => (
    <button onClick={() => setTab(id)} style={{ ...inputStyle, cursor: "pointer", background: tab === id ? C.accent : C.input, color: "#fff", fontWeight: tab === id ? 600 : 400 }}>{label}</button>
  );
  const capPct = roster?.cap && roster.cost != null ? Math.round((roster.cost / roster.cap) * 100) : null;
  const money = (n: number | null) => (n == null ? "—" : n.toLocaleString());
  // Score formatter — basic scores are ~100 (1 decimal), wOBA ~0.3 (4 decimals).
  // Uses the GENERATED roster's metric so numbers don't change until Regenerate.
  const num = (v: number, d?: number) => v.toFixed(d ?? (roster?.metric === "basic" ? 1 : 4));

  // Per-card actions (Lock / Exclude / Remove).
  const iconBtn = (active: boolean, color = "#ef4444"): React.CSSProperties => ({
    ...inputStyle, padding: "1px 0", width: 24, textAlign: "center", boxSizing: "border-box",
    fontSize: 12, cursor: "pointer", lineHeight: 1.4,
    background: active ? `${color}40` : C.input, border: `1px solid ${active ? color : C.border}`,
  });
  // Per-card pool override (single dropdown): Hit / Pitch / 2way. No "auto" — the
  // shown value is the card's current role (override if set, else the LP's pick).
  // Re-selecting the shown value releases the override (lets the optimizer decide);
  // picking a different value forces it. Forced cards get an amber border.
  // Compact H/P/2W selector. Solid dark field + coloured text/border (translucent fills
  // are unreadable as the closed value); only as wide as "2W" + the dropdown caret.
  const roleSel: React.CSSProperties = { ...inputStyle, width: 30, padding: "1px 0", fontSize: 11, cursor: "pointer", lineHeight: 1.4, textAlign: "center", textAlignLast: "center", appearance: "none", WebkitAppearance: "none", MozAppearance: "none" };
  const roleControl = (id: string): ReactNode => {
    const lp = lpRoleById.get(id) ?? "hitter";
    const shown = roleOverrides.get(id) ?? lp;
    const forced = roleOverrides.has(id);
    const col = ROLE_OV[shown]!;
    const optStyle = { background: C.input, color: C.text };
    return (
      <select value={shown} onChange={(e) => { const v = e.target.value as RoleOverride; setRole(id, v === shown ? null : v); }}
        title={`Role (pool) for this card${forced ? " — FORCED" : " — chosen by the optimizer"}. Pick a different role to force it; re-pick the shown role to let the optimizer decide.`}
        style={{ ...roleSel, background: C.input, color: col.fg, fontWeight: 700, border: `${forced ? 2 : 1}px solid ${col.bd}` }}>
        <option value="hitter" style={optStyle}>H</option>
        <option value="pitcher" style={optStyle}>P</option>
        <option value="twoway" style={optStyle}>2W</option>
      </select>
    );
  };
  const actionsCell = (id: string): ReactNode => (
    <span style={{ display: "inline-flex", gap: 2, alignItems: "center" }}>
      {roleControl(id)}
      <button onClick={() => toggleLock(id, roleOverrides.get(id) ?? lpRoleById.get(id) ?? "hitter")} title="Lock to roster in its current role (required on regenerate)" style={iconBtn(locked.has(id), "#22c55e")}>{locked.has(id) ? "🔒" : "🔓"}</button>
      <button onClick={() => toggleExclude(id)} title="Exclude from generation (never selected)" style={iconBtn(excluded.has(id), "#ef4444")}>{excluded.has(id) ? "🚫" : "⊘"}</button>
      <button onClick={() => removeCard(id)} title="Remove from the current roster (returns on Regenerate)" style={{ ...iconBtn(false), color: "#f87171", border: "1px solid #ef4444" }}>✕</button>
    </span>
  );
  const actionsCol = <T extends { id: string }>(): Column<T> => ({ key: "act", label: "Actions", align: "r", value: () => 0, render: (r) => actionsCell(r.id) });

  // Pin the Player column to the widest rendered "<prefix><bold name>" so the full player name
  // always shows. Measured from the real DOM after render (exact): b.right − cell.left = the
  // prefix+name width regardless of the current column width, so it settles in one pass.
  const rosterRef = useRef<HTMLDivElement>(null);
  const [nameW, setNameW] = useState({ h: 280, p: 280 });
  useLayoutEffect(() => {
    const measure = (table?: Element | null): number | null => {
      if (!table) return null;
      let need = 0;
      for (const tr of table.querySelectorAll("tbody tr")) {
        const cell = tr.querySelector("td"); if (!cell) continue;
        const ref = cell.querySelector("b") ?? cell.firstElementChild;
        if (!ref) continue;
        need = Math.max(need, ref.getBoundingClientRect().right - cell.getBoundingClientRect().left);
      }
      // + right padding AND room for the "…" the cell inserts after the name when the team/year
      // suffix overflows (without this slack the ellipsis clips the last letter of the name).
      return need ? Math.min(620, Math.max(140, Math.ceil(need) + 30)) : null;
    };
    const measureAll = () => {
      const root = rosterRef.current;
      if (!root) return;
      const tables = root.querySelectorAll("table");
      const h = measure(tables[0]), p = measure(tables[1]);
      setNameW((prev) => {
        const nh = h ?? prev.h, np = p ?? prev.p;
        return Math.abs(nh - prev.h) < 2 && Math.abs(np - prev.p) < 2 ? prev : { h: nh, p: np };
      });
    };
    measureAll();
    // The layout effect first runs with fallback font metrics; re-measure once the real web
    // font loads (wider glyphs) so the column isn't left too narrow and clipping names. Both a
    // fonts.ready hook and a short delayed pass (fonts.ready can resolve before the bold variant
    // is applied) — measurement is idempotent, so extra passes are harmless.
    let cancelled = false;
    document.fonts?.ready.then(() => { if (!cancelled) measureAll(); });
    const t1 = setTimeout(() => { if (!cancelled) measureAll(); }, 250);
    const t2 = setTimeout(() => { if (!cancelled) measureAll(); }, 800);
    return () => { cancelled = true; clearTimeout(t1); clearTimeout(t2); };
  }, [roster, tab]);

  // ── Roster-tab columns ──
  // The Player column is pinned to nameW (measured above) so the full player name always shows
  // (only team/year may clip). Defense shrinks first, then Pos, to free the room.
  const hitterCols: Column<RosterHitterRow>[] = [
    { key: "player", label: "Player", width: nameW.h, min: nameW.h, max: nameW.h + 140, shrink: 3, value: (h) => h.last || h.title, render: nameCell },
    { key: "value", label: "Val", align: "r", width: 44, value: (h) => h.cost },
    { key: "b", label: "B", align: "c", width: 26, value: (h) => h.bats },
    { key: "vL", label: "vL", align: "r", width: 58, value: (h) => h.wobaVL, render: (h) => num(h.wobaVL) },
    { key: "vR", label: "vR", align: "r", width: 58, value: (h) => h.wobaVR, render: (h) => num(h.wobaVR) },
    { key: "pos", label: "Pos", width: 150, min: 44, shrink: 2, value: (h) => posStr(h.allPositions ?? h.positions), render: (h) => posCell(h.allPositions ?? h.positions, h.positions) },
    { key: "def", label: "Defense", width: 312, min: 90, shrink: 1, value: (h) => h.def.ifR, render: (h) => <span style={{ color: C.sub, fontSize: 12 }}>{defSummary(h)}</span> },
    { ...actionsCol<RosterHitterRow>(), width: 122 },
  ];
  const pitcherCols: Column<RosterPitcherRow>[] = [
    { key: "player", label: "Player", width: nameW.p, min: nameW.p, max: nameW.p + 160, shrink: 1, value: (p) => p.last || p.title, render: nameCell },
    { key: "value", label: "Val", align: "r", width: 44, value: (p) => p.cost },
    { key: "t", label: "T", align: "c", width: 26, value: (p) => p.throws },
    { key: "woba", label: "OVR", align: "r", width: 66, value: (p) => p.woba, render: (p) => num(p.woba) },
    { key: "stam", label: "Stam", align: "r", width: 54, value: (p) => p.stamina },
    { key: "pit", label: "# Pit", align: "r", width: 54, value: (p) => p.pitchTypes },
    { ...actionsCol<RosterPitcherRow>(), width: 122 },
  ];

  // ── Next Best Available (left rail) — compact card list, +Add = lock the card.
  // Tabs by need (Hit vR / Hit vL now; Pitch/SP/defence/value filter to follow).
  const addedIds = new Set(added.map((a) => a.row.id));
  const maxV = nbMaxValue.trim() === "" ? null : Number(nbMaxValue);
  // The full available pool; filter (owned, value, tab) then render only the top slice.
  const availAll: AvailRow[] = (roster?.nextBest?.available ?? []).filter((x) =>
    !addedIds.has(x.id) && !removed.has(x.id)
    && (!nbOwnedOnly || x.owned > 0)
    && (maxV == null || !Number.isFinite(maxV) || x.cost <= maxV));
  const NB_RENDER = 100; // cap rendered cards (keeps the DOM light; filter scans all)
  const activeCat = AVAIL_CATS.find((c) => c.id === availCat)!;
  const minStam = roster?.minStarterStamina ?? 70, minPit = roster?.minPitchTypes ?? 3;
  const toHitter = (a: AvailRow): AvailHitterRow => ({ id: a.id, title: a.title, last: a.last, bats: a.bats, positions: a.positions, startPositions: a.startPositions, def: a.def, cost: a.cost, owned: a.owned, wobaVL: a.hitVL, wobaVR: a.hitVR });
  const toPitcher = (a: AvailRow): AvailPitcherRow => ({ id: a.id, title: a.title, last: a.last, throws: a.throws, cost: a.cost, owned: a.owned, stamina: a.stamina, pitchTypes: a.pitchTypes, woba: a.pitOVR, wobaVL: a.pitVL, wobaVR: a.pitVR });
  // Per-tab list: filter to position/role relevance, sort by the metric, top slice.
  const hitterList = (): AvailHitterRow[] => {
    let list = availAll;
    if (availCat === "ifRng") list = list.filter((a) => IF.some((p) => a.positions.includes(p)));
    else if (availCat === "ofRng") list = list.filter((a) => OF.some((p) => a.positions.includes(p)));
    else if (availCat === "cAbil") list = list.filter((a) => a.positions.includes("C"));
    const key: (a: AvailRow) => number =
      availCat === "hitVL" ? (a) => a.hitVL : availCat === "hitVR" ? (a) => a.hitVR :
      availCat === "ifRng" ? (a) => a.def.ifR : availCat === "ofRng" ? (a) => a.def.ofR : (a) => a.def.cAb;
    return [...list].sort((a, b) => key(b) - key(a)).slice(0, NB_RENDER).map(toHitter);
  };
  const pitcherList = (): AvailPitcherRow[] => {
    const list = availCat === "sp" ? availAll.filter((a) => a.stamina >= minStam && a.pitchTypes >= minPit) : availAll;
    return [...list].sort((a, b) => a.pitOVR - b.pitOVR).slice(0, NB_RENDER).map(toPitcher); // lower allowed = better
  };
  const catBtn = (id: AvailCat, label: string) => (
    <button key={id} onClick={() => setAvailCat(id)} style={{ ...inputStyle, padding: "4px 0", fontSize: 12, cursor: "pointer", background: availCat === id ? C.accent : C.input, color: availCat === id ? "#fff" : C.sub, fontWeight: availCat === id ? 700 : 400, border: `1px solid ${availCat === id ? C.accent : C.border}` }}>{label}</button>
  );
  const addTitle = (canAdd: boolean) => canAdd ? "Add to an open roster slot (locks the card)" : "Roster full — remove a card first to open a slot";
  // Compact action icons matching the Biggest Upgrades panel: + adds+locks the card
  // into an open slot; ✕ excludes it from generation (needs Regenerate).
  const nbIconBtn = (color: string, on: boolean): React.CSSProperties => ({
    ...inputStyle, padding: "1px 0", width: 24, textAlign: "center", boxSizing: "border-box",
    fontSize: 12, flex: "0 0 auto", cursor: on ? "pointer" : "not-allowed", opacity: on ? 1 : 0.45,
    color, border: `1px solid ${color}`,
  });
  const nbActions = (id: string, canAdd: boolean, add: () => void) => (
    <div style={{ display: "flex", gap: 3, flex: "0 0 auto" }}>
      <button onClick={() => canAdd && add()} disabled={!canAdd} title={addTitle(canAdd)} style={nbIconBtn("#86efac", canAdd)}>+</button>
      <button onClick={() => toggleExclude(id)} title="Exclude from generation (kept out until un-excluded + Regenerate)" style={nbIconBtn("#f87171", true)}>✕</button>
    </div>
  );
  const availHitterCard = (h: AvailHitterRow): ReactNode => {
    const canAdd = emptySpace > 0;
    const act = (v: AvailCat) => v === availCat;
    return (
      <PoolDraggable key={h.id} id={h.id} disabled={!canAdd}>
        <div style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
          <span style={{ flex: "1 1 auto", minWidth: 0, fontSize: 12, fontWeight: 600, lineHeight: 1.25, overflowWrap: "anywhere" }}>
            {h.owned <= 0 && <span style={{ color: "#ef4444", fontWeight: 700, marginRight: 3 }} title="Not owned">!</span>}{star(h.title)}
          </span>
          {nbActions(h.id, canAdd, () => addCard({ kind: "hitter", row: h }))}
        </div>
        <div style={{ fontSize: 11, color: C.sub, marginTop: 2 }}>
          <span style={{ color: act("hitVL") ? C.text : C.sub, fontWeight: act("hitVL") ? 700 : 400 }}>vL {num(h.wobaVL)}</span>
          {" · "}
          <span style={{ color: act("hitVR") ? C.text : C.sub, fontWeight: act("hitVR") ? 700 : 400 }}>vR {num(h.wobaVR)}</span>
          {" · "}Val {h.cost} · {posCell(h.positions, h.startPositions ?? h.positions)} {h.bats && `· ${h.bats}`}
        </div>
        {defSummary(h) && <div style={{ fontSize: 10, color: C.sub, marginTop: 1 }}>{defSummary(h)}</div>}
      </PoolDraggable>
    );
  };
  const availPitcherCard = (p: AvailPitcherRow): ReactNode => {
    const canAdd = emptySpace > 0;
    return (
      <PoolDraggable key={p.id} id={p.id} disabled={!canAdd}>
        <div style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
          <span style={{ flex: "1 1 auto", minWidth: 0, fontSize: 12, fontWeight: 600, lineHeight: 1.25, overflowWrap: "anywhere" }}>
            {p.owned <= 0 && <span style={{ color: "#ef4444", fontWeight: 700, marginRight: 3 }} title="Not owned">!</span>}{star(p.title)}
          </span>
          {nbActions(p.id, canAdd, () => addCard({ kind: "pitcher", row: p }))}
        </div>
        <div style={{ fontSize: 11, color: C.sub, marginTop: 2 }}>
          <b style={{ color: C.text }}>OVR {num(p.woba)}</b> · vL {num(p.wobaVL)} · vR {num(p.wobaVR)}
        </div>
        <div style={{ fontSize: 10, color: C.sub, marginTop: 1 }}>{p.throws && `T ${p.throws} · `}Stam {p.stamina} · {p.pitchTypes} pit · Val {p.cost}</div>
      </PoolDraggable>
    );
  };
  // Current tab's cards + an id→AddedCard lookup so a pool→roster drop resolves the
  // dragged card (the +Add path uses the same AddedCard shape).
  const curHitters = activeCat.kind === "hitter" ? hitterList() : [];
  const curPitchers = activeCat.kind === "pitcher" ? pitcherList() : [];
  const addById = useMemo(() => {
    const m = new Map<string, AddedCard>();
    for (const h of curHitters) m.set(h.id, { kind: "hitter", row: h });
    for (const p of curPitchers) m.set(p.id, { kind: "pitcher", row: p });
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availCat, curHitters.length, curPitchers.length, nbOwnedOnly, nbMaxValue, added.length, removed.size]);
  const availItems: ReactNode[] = activeCat.kind === "hitter" ? curHitters.map(availHitterCard) : curPitchers.map(availPitcherCard);
  const poolSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const onPoolDragEnd = (e: DragEndEvent) => {
    const a = String(e.active.id); if (!a.startsWith("pool:") || !e.over || e.over.id !== "roster-drop") return;
    const add = addById.get(a.slice(5));
    if (add && emptySpace > 0) addCard(add);
  };

  // ── Pitching (Rotation + Bullpen share fixed widths so they line up) ──
  const pStaffCols: Column<PStaffRow>[] = [
    { key: "slot", label: "", align: "c", width: 46, value: (p) => p.slotLabel, render: (p) => <span style={{ color: C.sub }}>{p.slotLabel}</span> },
    { key: "player", label: "Player", width: 320, min: 110, shrink: 1, value: (p) => p.last || p.title, render: nameCell },
    { key: "value", label: "Value", align: "r", width: 60, value: (p) => p.cost },
    { key: "t", label: "T", align: "c", width: 36, value: (p) => p.throws },
    { key: "woba", label: "OVR", align: "r", width: 76, value: (p) => p.woba, render: (p) => num(p.woba) },
    { key: "stam", label: "Stam", align: "r", width: 56, value: (p) => p.stamina },
    { key: "pit", label: "# Pit", align: "r", width: 56, value: (p) => p.pitchTypes },
  ];
  const rotRows: PStaffRow[] = useMemo(() => (roster?.rotation ?? []).map((rt) => {
    const p = pitchers.find((x) => x.id === rt.id.replace(/#V$/, ""));
    return p ? { ...p, slotLabel: `SP${rt.slot}` } : null;
  }).filter((r): r is PStaffRow => !!r), [roster, removed]);
  const bullpenRows: PStaffRow[] = pitchers.filter((p) => p.role === "reliever").map((p) => ({ ...p, slotLabel: "RP" }));
  const availSP: PStaffRow[] = bullpenRows.filter((p) => p.stamina >= (roster?.minStarterStamina ?? 70) && p.pitchTypes >= (roster?.minPitchTypes ?? 3));

  const nLock = locked.size, nExcl = excluded.size, nRem = removed.size;

  return (
    <div style={{ width: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0 }}>Roster & Lineups</h2>
        <button onClick={generateRoster} disabled={rosterLoading} style={{ ...inputStyle, cursor: "pointer", background: dirty ? "#b45309" : C.accent, color: "#fff" }}>{rosterLoading ? "Generating…" : roster ? "Regenerate" : "Generate"}</button>
        <label style={{ fontSize: 13, color: C.sub }} title="Off = consider every eligible card, even unowned (SELECTION only — calibration always uses all eligible cards). Press Regenerate to apply.">
          <input type="checkbox" checked={ownedOnly} onChange={(e) => setOwnedOnly(e.target.checked)} disabled={rosterLoading} /> Owned only
        </label>
        <span style={{ display: "inline-flex", border: `1px solid ${C.border}`, borderRadius: 4, overflow: "hidden" }} title="Metric the optimizer maximizes + displays. Press Regenerate to apply.">
          {(["woba", "basic"] as const).map((m) => (
            <button key={m} onClick={() => setMetric(m)} disabled={rosterLoading}
              style={{ ...inputStyle, border: "none", borderRadius: 0, cursor: "pointer", padding: "5px 9px", background: metric === m ? C.accent : C.input, color: metric === m ? "#fff" : C.sub, fontWeight: metric === m ? 700 : 400 }}>
              {m === "woba" ? "wOBA" : "Basic"}
            </button>
          ))}
        </span>
        {(nLock > 0 || nExcl > 0) && <span style={{ fontSize: 12, color: C.sub }}>{nLock} locked · {nExcl} excluded</span>}
        {dirty && <span style={{ fontSize: 12, color: "#f59e0b" }}>⚠ press Regenerate to apply</span>}
        {meta && <span style={{ fontSize: 13, color: C.sub }}>{meta.tournament} · {meta.account}</span>}
      </div>

      {!roster && !rosterLoading && <p style={{ color: C.sub }}>Click Generate to build the optimal roster.</p>}
      {rosterLoading && <p style={{ color: C.sub }}>Optimizing… (this can take a moment)</p>}
      {roster && roster.status !== "Optimal" && (
        <div style={{ margin: "8px 0", padding: "10px 12px", border: "1px solid #ef4444", borderRadius: 8, background: "rgba(239,68,68,0.12)" }}>
          <div style={{ color: "#f87171", fontWeight: 700, marginBottom: 4 }}>⚠ No valid roster — solver returned “{roster.status}”.</div>
          <div style={{ fontSize: 13, color: C.text }}>
            {(locked.size > 0 || added.length > 0)
              ? <>Your <b>locked / added</b> cards over-constrain the roster. This tournament needs <b>{roster.nHitters} hitters + {roster.nPitchers} pitchers</b> ({roster.nHitters + roster.nPitchers} total){roster.mode === "cap" ? <> within the <b>{roster.cap?.toLocaleString()}</b> cap</> : null}. You have <b>{locked.size} locked</b>{added.length > 0 && <> · <b>{added.length} added</b></>} — locking too many of one role (or too much value for the cap) makes a valid roster impossible. Remove some and Regenerate.</>
              : <>Pool: {roster.poolHitters}H / {roster.poolPitchers}P — too few eligible cards for the constraints (e.g. backup depth at a scarce position). Loosen eligibility or position requirements.</>}
          </div>
        </div>
      )}

      {roster && roster.status === "Optimal" && (
        <>
          <p style={{ margin: "0 0 10px", color: C.sub, fontSize: 13 }}>
            {roster.mode === "cap"
              ? <>Cap: <b style={{ color: (capPct ?? 0) > 100 ? "#f87171" : C.text }}>{money(roster.cost)}/{money(roster.cap)}</b> ({capPct}%) · </>
              : <>Mode: {roster.mode} · </>}
            Pool: {roster.poolHitters}H / {roster.poolPitchers}P · H-value <b style={{ color: C.text }}>{roster.balance?.hitterValue.toFixed(3)}</b> · P-value <b style={{ color: C.text }}>{roster.balance?.pitcherValue.toFixed(3)}</b>
            {nTwoWay > 0 && <> · <span style={{ color: "#fde68a" }}>{nTwoWay} two-way</span></>}
            {nRem > 0 && <> · <span style={{ color: "#f59e0b" }}>{nRem} removed</span></>}
          </p>
          <Legend roles={["both", "vL", "vR", "bench", "starter", "reliever", ...(nTwoWay > 0 ? ["twoway"] : [])]} />

          <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
            {tabBtn("roster", `Roster (${distinctCount})`)}
            {tabBtn("lineups", "Lineups")}
            {tabBtn("pitching", `Pitching (${pitchers.length})`)}
          </div>

          {tab === "roster" && (
            <DndContext sensors={poolSensors} onDragEnd={onPoolDragEnd}>
            <div ref={rosterRef} style={{ display: "flex", gap: 18, alignItems: "flex-start", flexWrap: "wrap" }}>
              {/* Left rail: Next Best Available */}
              <div style={{ flex: "1 1 290px", minWidth: 280, maxWidth: 340 }}>
                <h3 style={{ margin: "0 0 6px", fontSize: 14 }}>Next Best Available</h3>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 5, marginBottom: 8 }}>
                  {AVAIL_CATS.map((c) => catBtn(c.id, c.label))}
                </div>
                <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
                  <label style={{ fontSize: 12, color: C.sub, display: "inline-flex", alignItems: "center", gap: 4 }}>
                    <input type="checkbox" checked={nbOwnedOnly} onChange={(e) => setNbOwnedOnly(e.target.checked)} /> Owned only
                  </label>
                  <label style={{ fontSize: 12, color: C.sub, display: "inline-flex", alignItems: "center", gap: 4 }} title={`Show only cards at or below this Card Value (for cap rosters). Min ${roster.cardValueMin}; blank = no limit.`}>
                    ≤ Value
                    <input type="number" value={nbMaxValue} min={roster.cardValueMin} max={roster.cardValueMax ?? undefined} step={1}
                      onChange={(e) => setNbMaxValue(e.target.value)} placeholder="—"
                      style={{ ...inputStyle, width: 54, padding: "2px 5px", fontSize: 12 }} />
                  </label>
                </div>
                {availItems.length === 0
                  ? <p style={{ fontSize: 12, color: C.sub }}>None available for this tab.</p>
                  : <div style={{ display: "grid", gap: 6, maxHeight: "calc(100vh - 260px)", overflowY: "auto", paddingRight: 4 }}>{availItems}</div>}
              </div>

              {/* Center: roster tables (drop target for pool→roster drag) */}
              <RosterDropZone>
                <h3 style={{ margin: "0 0 6px", fontSize: 14 }}>Hitters ({hitters.length})</h3>
                <DataTable rows={hitters} cols={hitterCols} getKey={(h) => h.id} initialSort={{ key: "player", dir: 1 }} rowStyle={(h) => roleBg(h.role)} fit resizable resetKey={roster} />
                <h3 style={{ margin: "16px 0 6px", fontSize: 14 }}>Pitchers ({pitchers.length})</h3>
                <DataTable rows={pitchers} cols={pitcherCols} getKey={(p) => p.id} rowStyle={(p) => roleBg(p.role)} fit resizable resetKey={roster} />
              </RosterDropZone>

              {/* Right rail: budget usage → locked → excluded */}
              <div style={{ flex: "1 1 240px", minWidth: 220, maxWidth: 320, display: "flex", flexDirection: "column", gap: 14 }}>
                {/* Cap / Slot usage (when the tournament budgets) */}
                {roster.mode === "cap" && roster.cap != null && (() => {
                  const used = roster.cost ?? 0, over = used > roster.cap!;
                  return (
                    <div>
                      <h3 style={{ margin: "0 0 6px", fontSize: 14 }}>Cap Usage</h3>
                      <div style={{ fontSize: 12, color: C.sub, display: "flex", justifyContent: "space-between" }}>
                        <span>Used <b style={{ color: over ? "#f87171" : C.text }}>{used}</b> / {roster.cap}</span>
                        <span>{roster.cap! - used} left</span>
                      </div>
                      <div style={{ height: 6, background: C.input, borderRadius: 3, marginTop: 4, overflow: "hidden" }}>
                        <div style={{ height: "100%", width: `${Math.min(100, (100 * used) / roster.cap!)}%`, background: over ? "#f87171" : "#22c55e" }} />
                      </div>
                    </div>
                  );
                })()}
                {roster.mode === "slots" && roster.slotUsage && roster.slotUsage.length > 0 && (
                  <div>
                    <h3 style={{ margin: "0 0 6px", fontSize: 14 }}>Slot Usage</h3>
                    <div style={{ display: "grid", gap: 3 }}>
                      {roster.slotUsage.filter((s) => s.limit > 0).map((s) => (
                        <div key={s.threshold} style={{ fontSize: 12, color: C.sub, display: "flex", justifyContent: "space-between" }}>
                          <span>Value ≥ {s.threshold}</span>
                          <span style={{ color: s.used > s.limit ? "#f87171" : s.used === s.limit ? "#fbbf24" : C.text }}><b>{s.used}</b> / {s.limit}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {/* Locked */}
                <div>
                  <h3 style={{ margin: "0 0 6px", fontSize: 14 }}>Locked ({lockedList.length})</h3>
                  {lockedList.length === 0
                    ? <p style={{ fontSize: 12, color: C.sub }}>None. Use <span style={{ color: "#22c55e" }}>🔒</span> or <b style={{ color: "#86efac" }}>+</b> to force a card onto the roster.</p>
                    : <div style={{ display: "grid", gap: 4 }}>
                        {lockedList.map((e) => (
                          <div key={e.id} style={{ display: "flex", alignItems: "flex-start", gap: 6, padding: "4px 6px", border: `1px solid ${C.border}`, borderRadius: 6 }}>
                            <button onClick={() => toggleLock(e.id)} title="Unlock (no longer forced onto the roster)" style={{ ...railBtnStyle, color: "#86efac", border: "1px solid #22c55e" }}>✕</button>
                            <span style={{ flex: "1 1 auto", minWidth: 0, fontSize: 12, lineHeight: 1.3, overflowWrap: "anywhere" }}>{star(e.title)}</span>
                          </div>
                        ))}
                      </div>}
                </div>
                {/* Excluded */}
                <div>
                  <h3 style={{ margin: "0 0 6px", fontSize: 14 }}>Excluded ({excludedList.length})</h3>
                  {excludedList.length === 0
                    ? <p style={{ fontSize: 12, color: C.sub }}>None. Use the <span style={{ color: "#ef4444" }}>✕</span> action to keep a card out of generation.</p>
                    : <>
                        <div style={{ display: "grid", gap: 4 }}>
                          {excludedList.map((e) => (
                            <div key={e.id} style={{ display: "flex", alignItems: "flex-start", gap: 6, padding: "4px 6px", border: `1px solid ${C.border}`, borderRadius: 6 }}>
                              <button onClick={() => toggleExclude(e.id)} title="Un-exclude (returns to generation on Regenerate)" style={railBtnStyle}>✕</button>
                              <span style={{ flex: "1 1 auto", minWidth: 0, fontSize: 12, lineHeight: 1.3, overflowWrap: "anywhere" }}>{star(e.title)}</span>
                            </div>
                          ))}
                        </div>
                      </>}
                </div>
              </div>
            </div>
            {upShow && <UpgradesPanel data={{ hitters: merge(upShow.hitters, 10), sp: merge(upShow.sp, 5), rp: merge(upShow.rp, 5) }} onExclude={excludeNoRegen} onAcquire={acquireCard} busy={rosterLoading} refining={refineActive} refinedCount={refined.size} />}
            </DndContext>
          )}

          {tab === "lineups" && (
            <LineupTab hitters={hitters} seedVR={roster.lineupVR} seedVL={roster.lineupVL} num={num} roleBg={roleBg} />
          )}

          {tab === "pitching" && (
            <div style={{ display: "flex", gap: 22, flexWrap: "wrap", alignItems: "flex-start" }}>
              <div style={{ flex: "1 1 560px", minWidth: 0, maxWidth: 760 }}>
                <h3 style={{ margin: "0 0 6px", fontSize: 14 }}>Rotation</h3>
                <DataTable rows={rotRows} cols={pStaffCols} getKey={(r) => r.id} rowStyle={() => ({ background: ROSTER_COLORS.starter })} fit resizable resetKey={roster} />
                <h3 style={{ margin: "14px 0 6px", fontSize: 14 }}>Bullpen ({bullpenRows.length})</h3>
                <DataTable rows={bullpenRows} cols={pStaffCols} getKey={(p) => p.id} initialSort={{ key: "woba", dir: 1 }} rowStyle={() => ({ background: ROSTER_COLORS.reliever })} fit resizable resetKey={roster} />
              </div>
              <div style={{ flex: "1 1 380px", minWidth: 0, maxWidth: 760 }}>
                <h3 style={{ margin: "0 0 6px", fontSize: 14 }}>Available Starters</h3>
                <p style={{ margin: "0 0 6px", fontSize: 12, color: C.sub }}>Rostered bullpen arms that qualify as SP (stamina ≥ {roster.minStarterStamina}, ≥ {roster.minPitchTypes} pitch types).</p>
                {availSP.length === 0 ? <p style={{ fontSize: 13, color: C.sub }}>None — no spare qualified starters.</p>
                  : <DataTable rows={availSP} cols={pStaffCols} getKey={(p) => p.id} initialSort={{ key: "woba", dir: 1 }} fit resizable resetKey={roster} />}
              </div>
            </div>
          )}

        </>
      )}
    </div>
  );
}
