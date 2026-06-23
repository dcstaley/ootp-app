// M4 — Roster & Lineups page. One page, three sub-tabs (Roster / Lineups /
// Pitching) over the same generated roster; all tables sortable. Generation
// controls live here: Owned-only, plus per-card Lock (required) / Exclude
// (forbidden) / Remove (drop from the current roster — returns on Regenerate).
// Lineups support manual position assignment via per-player dropdowns.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useAppData } from "./state.tsx";
import { DataTable, type Column } from "./DataTable.tsx";
import {
  C, inputStyle, ROSTER_COLORS, ROSTER_BORDER, ROLE_LABEL,
  type RosterHitterRow, type RosterPitcherRow, type CardDef, type RoleOverride, type AvailRow, type AvailHitterRow, type AvailPitcherRow,
} from "./shared.ts";

const star = (t: string) => (t.startsWith("★") ? <><span style={{ color: C.star }}>★</span>{t.slice(1)}</> : t);
const twoWayBadge = (
  <span title="Two-way: fills a hitter and a pitcher slot" style={{ marginLeft: 5, padding: "0 4px", borderRadius: 3, fontSize: 10, fontWeight: 700, background: ROSTER_COLORS.twoway, border: `1px solid ${ROSTER_BORDER.twoway}`, color: "#fde68a" }}>2W</span>
);
// Role-override dropdown colours (Hit = green, Pitch = blue, 2way = amber).
const ROLE_OV: Record<string, { bg: string; bd: string; fg: string }> = {
  hitter: { bg: "rgba(34,197,94,0.20)", bd: "#22c55e", fg: "#86efac" },
  pitcher: { bg: "rgba(59,130,246,0.22)", bd: "#3b82f6", fg: "#93c5fd" },
  twoway: { bg: "rgba(234,179,8,0.22)", bd: "#eab308", fg: "#fde68a" },
};
const IF = ["1B", "2B", "3B", "SS"], OF = ["LF", "CF", "RF"], FIELD = ["C", "1B", "2B", "3B", "SS", "LF", "CF", "RF"];
const POS_ORDER = ["C", "1B", "2B", "3B", "SS", "LF", "CF", "RF", "DH"];
const posRank = (p: string) => { const i = POS_ORDER.indexOf(p); return i < 0 ? 99 : i; };
const posStr = (positions: string[]) => { const f = positions.filter((p) => p !== "DH"); return f.length ? f.join("/") : "DH"; };
const nameCell = (r: { title: string; owned: number; twoWay?: boolean }): ReactNode => (
  <span>{r.owned <= 0 && <span style={{ color: "#ef4444", fontWeight: 700, marginRight: 4 }} title="Not owned">!</span>}{star(r.title)}{r.twoWay && twoWayBadge}</span>
);
function defStr(d: CardDef, pos: string): string {
  if (pos === "C") return `Ab${d.cAb} Fr${d.cFr} Ar${d.cAr}`;
  if (IF.includes(pos)) return `R${d.ifR} E${d.ifE} A${d.ifA} DP${d.dp}`;
  if (OF.includes(pos)) return `R${d.ofR} E${d.ofE} A${d.ofA}`;
  return "";
}
function defSummary(h: { positions: string[]; def: CardDef }): string {
  const parts: string[] = [];
  if (h.positions.includes("C")) parts.push(`C ${defStr(h.def, "C")}`);
  if (IF.some((p) => h.positions.includes(p))) parts.push(`IF ${defStr(h.def, "1B")}`);
  if (OF.some((p) => h.positions.includes(p))) parts.push(`OF ${defStr(h.def, "LF")}`);
  return parts.join("   ");
}

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

type Tab = "roster" | "lineups" | "pitching";
type AvailCat = "hitVR" | "hitVL" | "pitch" | "sp" | "ifRng" | "ofRng" | "cAbil";
const AVAIL_CATS: { id: AvailCat; label: string; kind: "hitter" | "pitcher" }[] = [
  { id: "hitVR", label: "Hit vR", kind: "hitter" }, { id: "hitVL", label: "Hit vL", kind: "hitter" },
  { id: "pitch", label: "Pitch", kind: "pitcher" }, { id: "sp", label: "SP", kind: "pitcher" },
  { id: "ifRng", label: "IF Rng", kind: "hitter" }, { id: "ofRng", label: "OF Rng", kind: "hitter" },
  { id: "cAbil", label: "C Abil", kind: "hitter" },
];
type Side = "vR" | "vL";
type PStaffRow = RosterPitcherRow & { slotLabel: string };

export function RosterPage() {
  const {
    roster, rosterLoading, generateRoster, meta, ownedOnly, setOwnedOnly,
    locked, excluded, removed, dirty, toggleLock, toggleExclude, removeCard,
    added, addCard, roles: roleOverrides, setRole, cards,
  } = useAppData();
  const [tab, setTab] = useState<Tab>("roster");
  const [availCat, setAvailCat] = useState<AvailCat>("hitVR");
  const [nbOwnedOnly, setNbOwnedOnly] = useState(true); // Next Best: owned-only view
  const [nbMaxValue, setNbMaxValue] = useState("");      // Next Best: max Card Value filter
  const [side, setSide] = useState<Side>("vR");
  const [assignVR, setAssignVR] = useState<Record<string, string>>({});
  const [assignVL, setAssignVL] = useState<Record<string, string>>({});

  useEffect(() => { if (!roster && !rosterLoading) generateRoster(); }, []);
  useEffect(() => {
    if (!roster) return;
    const mk = (lineup: { id: string; pos?: string }[]) => {
      const m: Record<string, string> = {};
      for (const h of roster.rosterHitters) m[h.id] = "-";
      for (const s of lineup) m[s.id.replace(/#V$/, "")] = s.pos ?? "-";
      return m;
    };
    setAssignVR(mk(roster.lineupVR));
    setAssignVL(mk(roster.lineupVL));
  }, [roster]);

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
  // Excluded players (kept out of generation) — surfaced so they can be un-excluded.
  const cardById = useMemo(() => new Map(cards.map((c) => [c.id, c])), [cards]);
  const excludedList = [...excluded].map((id) => ({ id, title: cardById.get(id)?.title ?? id }))
    .sort((a, b) => a.title.localeCompare(b.title));

  const roleBg = (role: string): React.CSSProperties => ({ background: ROSTER_COLORS[role] });
  const tabBtn = (id: Tab, label: string) => (
    <button onClick={() => setTab(id)} style={{ ...inputStyle, cursor: "pointer", background: tab === id ? C.accent : C.input, color: "#fff", fontWeight: tab === id ? 600 : 400 }}>{label}</button>
  );
  const sideBtn = (id: Side, label: string) => (
    <button onClick={() => setSide(id)} style={{ ...inputStyle, cursor: "pointer", background: side === id ? "#374151" : C.input, color: side === id ? "#fff" : C.sub, fontWeight: side === id ? 700 : 400, border: side === id ? `2px solid ${C.accent}` : `1px solid ${C.border}` }}>{label}</button>
  );
  const capPct = roster?.cap && roster.cost != null ? Math.round((roster.cost / roster.cap) * 100) : null;
  const money = (n: number | null) => (n == null ? "—" : n.toLocaleString());
  const num = (v: number, d = 4) => v.toFixed(d);

  // Per-card actions (Lock / Exclude / Remove).
  const iconBtn = (active: boolean, color = "#ef4444"): React.CSSProperties => ({
    ...inputStyle, padding: "1px 0", width: 26, textAlign: "center", boxSizing: "border-box",
    fontSize: 12, cursor: "pointer", lineHeight: 1.4,
    background: active ? `${color}40` : C.input, border: `1px solid ${active ? color : C.border}`,
  });
  // Per-card pool override (single dropdown): Hit / Pitch / 2way. No "auto" — the
  // shown value is the card's current role (override if set, else the LP's pick).
  // Re-selecting the shown value releases the override (lets the optimizer decide);
  // picking a different value forces it. Forced cards get an amber border.
  const roleSel: React.CSSProperties = { ...inputStyle, padding: "1px 3px", fontSize: 11, cursor: "pointer", lineHeight: 1.4 };
  const roleControl = (id: string): ReactNode => {
    const lp = lpRoleById.get(id) ?? "hitter";
    const shown = roleOverrides.get(id) ?? lp;
    const forced = roleOverrides.has(id);
    const col = ROLE_OV[shown]!;
    return (
      <select value={shown} onChange={(e) => { const v = e.target.value as RoleOverride; setRole(id, v === shown ? null : v); }}
        title={`Role (pool) for this card${forced ? " — FORCED" : " — chosen by the optimizer"}. Pick a different role to force it; re-pick the shown role to let the optimizer decide.`}
        style={{ ...roleSel, background: col.bg, color: col.fg, fontWeight: forced ? 700 : 400, border: `${forced ? 2 : 1}px solid ${col.bd}` }}>
        <option value="hitter">Hit</option>
        <option value="pitcher">Pitch</option>
        <option value="twoway">2way</option>
      </select>
    );
  };
  const actionsCell = (id: string): ReactNode => (
    <span style={{ display: "inline-flex", gap: 3, alignItems: "center" }}>
      {roleControl(id)}
      <button onClick={() => toggleLock(id)} title="Lock to roster (required on regenerate)" style={iconBtn(locked.has(id), "#22c55e")}>{locked.has(id) ? "🔒" : "🔓"}</button>
      <button onClick={() => toggleExclude(id)} title="Exclude from generation (never selected)" style={iconBtn(excluded.has(id), "#ef4444")}>{excluded.has(id) ? "🚫" : "⊘"}</button>
      <button onClick={() => removeCard(id)} title="Remove from the current roster (returns on Regenerate)" style={{ ...iconBtn(false), color: "#f87171", border: "1px solid #ef4444" }}>✕</button>
    </span>
  );
  const actionsCol = <T extends { id: string }>(): Column<T> => ({ key: "act", label: "Actions", align: "r", value: () => 0, render: (r) => actionsCell(r.id) });

  // ── Roster-tab columns (fit mode — never scroll; shrink Pos → Def → Player) ──
  // Numeric/action columns are protected (fixed width); Pos/Def/Player absorb the
  // squeeze in priority order via `shrink` (1 = shrink first).
  const hitterCols: Column<RosterHitterRow>[] = [
    { key: "player", label: "Player", width: 240, min: 86, shrink: 3, value: (h) => h.last || h.title, render: nameCell },
    { key: "value", label: "Value", align: "r", width: 56, value: (h) => h.cost },
    { key: "b", label: "B", align: "c", width: 32, value: (h) => h.bats },
    { key: "vL", label: "vL", align: "r", width: 66, value: (h) => h.wobaVL, render: (h) => num(h.wobaVL) },
    { key: "vR", label: "vR", align: "r", width: 66, value: (h) => h.wobaVR, render: (h) => num(h.wobaVR) },
    { key: "pos", label: "Pos", width: 96, min: 40, shrink: 1, value: (h) => posStr(h.positions) },
    { key: "def", label: "Defense", width: 200, min: 60, shrink: 2, value: (h) => h.def.ifR, render: (h) => <span style={{ color: C.sub, fontSize: 12 }}>{defSummary(h)}</span> },
    { ...actionsCol<RosterHitterRow>(), width: 156 },
  ];
  const pitcherCols: Column<RosterPitcherRow>[] = [
    { key: "player", label: "Player", width: 260, min: 90, shrink: 1, value: (p) => p.last || p.title, render: nameCell },
    { key: "value", label: "Value", align: "r", width: 56, value: (p) => p.cost },
    { key: "t", label: "T", align: "c", width: 32, value: (p) => p.throws },
    { key: "woba", label: "OVR", align: "r", width: 70, value: (p) => p.woba, render: (p) => num(p.woba) },
    { key: "stam", label: "Stam", align: "r", width: 56, value: (p) => p.stamina },
    { key: "pit", label: "# Pit", align: "r", width: 56, value: (p) => p.pitchTypes },
    { ...actionsCol<RosterPitcherRow>(), width: 156 },
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
  const catDesc = ({ hitVR: "by vs-RHP value", hitVL: "by vs-LHP value", pitch: "pitchers by overall value", sp: "SP-qualified pitchers", ifRng: "by infield range", ofRng: "by OF range", cAbil: "by catcher ability" } as Record<AvailCat, string>)[availCat];
  const minStam = roster?.minStarterStamina ?? 70, minPit = roster?.minPitchTypes ?? 3;
  const toHitter = (a: AvailRow): AvailHitterRow => ({ id: a.id, title: a.title, last: a.last, bats: a.bats, positions: a.positions, def: a.def, cost: a.cost, owned: a.owned, wobaVL: a.hitVL, wobaVR: a.hitVR });
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
  const addBtnStyle = (canAdd: boolean): React.CSSProperties => ({
    ...inputStyle, flex: "0 0 auto", padding: "1px 7px", fontSize: 11, whiteSpace: "nowrap",
    cursor: canAdd ? "pointer" : "not-allowed", opacity: canAdd ? 1 : 0.45,
    background: canAdd ? "rgba(34,197,94,0.18)" : C.input, color: canAdd ? "#86efac" : C.sub, border: `1px solid ${canAdd ? "#22c55e" : C.border}`,
  });
  const addTitle = (canAdd: boolean) => canAdd ? "Add to an open roster slot (locks the card)" : "Roster full — remove a card first to open a slot";
  const availHitterCard = (h: AvailHitterRow): ReactNode => {
    const canAdd = emptySpace > 0;
    const act = (v: AvailCat) => v === availCat;
    return (
      <div key={h.id} style={{ border: `1px solid ${C.border}`, borderRadius: 6, padding: "5px 7px" }}>
        <div style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
          <span style={{ flex: "1 1 auto", minWidth: 0, fontSize: 12, fontWeight: 600, lineHeight: 1.25, overflowWrap: "anywhere" }}>
            {h.owned <= 0 && <span style={{ color: "#ef4444", fontWeight: 700, marginRight: 3 }} title="Not owned">!</span>}{star(h.title)}
          </span>
          <button onClick={() => canAdd && addCard({ kind: "hitter", row: h })} disabled={!canAdd} title={addTitle(canAdd)} style={addBtnStyle(canAdd)}>+ Add</button>
        </div>
        <div style={{ fontSize: 11, color: C.sub, marginTop: 2 }}>
          <span style={{ color: act("hitVL") ? C.text : C.sub, fontWeight: act("hitVL") ? 700 : 400 }}>vL {num(h.wobaVL, 3)}</span>
          {" · "}
          <span style={{ color: act("hitVR") ? C.text : C.sub, fontWeight: act("hitVR") ? 700 : 400 }}>vR {num(h.wobaVR, 3)}</span>
          {" · "}Val {h.cost} · {posStr(h.positions)} {h.bats && `· ${h.bats}`}
        </div>
        {defSummary(h) && <div style={{ fontSize: 10, color: C.sub, marginTop: 1 }}>{defSummary(h)}</div>}
      </div>
    );
  };
  const availPitcherCard = (p: AvailPitcherRow): ReactNode => {
    const canAdd = emptySpace > 0;
    return (
      <div key={p.id} style={{ border: `1px solid ${C.border}`, borderRadius: 6, padding: "5px 7px" }}>
        <div style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
          <span style={{ flex: "1 1 auto", minWidth: 0, fontSize: 12, fontWeight: 600, lineHeight: 1.25, overflowWrap: "anywhere" }}>
            {p.owned <= 0 && <span style={{ color: "#ef4444", fontWeight: 700, marginRight: 3 }} title="Not owned">!</span>}{star(p.title)}
          </span>
          <button onClick={() => canAdd && addCard({ kind: "pitcher", row: p })} disabled={!canAdd} title={addTitle(canAdd)} style={addBtnStyle(canAdd)}>+ Add</button>
        </div>
        <div style={{ fontSize: 11, color: C.sub, marginTop: 2 }}>
          <b style={{ color: C.text }}>OVR {num(p.woba, 3)}</b> · vL {num(p.wobaVL, 3)} · vR {num(p.wobaVR, 3)}
        </div>
        <div style={{ fontSize: 10, color: C.sub, marginTop: 1 }}>{p.throws && `T ${p.throws} · `}Stam {p.stamina} · {p.pitchTypes} pit · Val {p.cost}</div>
      </div>
    );
  };
  const availItems: ReactNode[] = activeCat.kind === "hitter" ? hitterList().map(availHitterCard) : pitcherList().map(availPitcherCard);

  // ── Lineups (editable assignment, per side) ──
  const assign = side === "vR" ? assignVR : assignVL;
  const setAssign = side === "vR" ? setAssignVR : setAssignVL;
  const scoreH = (h: RosterHitterRow) => (side === "vR" ? h.wobaVR : h.wobaVL);
  const changePos = (id: string, pos: string) => setAssign((a) => {
    const next = { ...a };
    if (pos !== "-") for (const k of Object.keys(next)) if (next[k] === pos) next[k] = "-";
    next[id] = pos;
    return next;
  });
  const assigned = hitters.filter((h) => (assign[h.id] ?? "-") !== "-");
  const benched = hitters.filter((h) => (assign[h.id] ?? "-") === "-");
  const sel: React.CSSProperties = { ...inputStyle, padding: "2px 4px", fontSize: 12, width: 62, cursor: "pointer" };
  // Lineup/bench columns mirror the roster-tab order (Score next to B, like vL/vR)
  // and use fit mode (shrink Learn → Defense → Player; never scroll).
  const lineupCols: Column<RosterHitterRow>[] = [
    { key: "player", label: "Player", width: 200, min: 80, shrink: 3, value: (h) => h.last || h.title, render: nameCell },
    { key: "value", label: "Value", align: "r", width: 56, value: (h) => h.cost },
    { key: "b", label: "B", align: "c", width: 32, value: (h) => h.bats },
    { key: "score", label: "Score", align: "r", width: 66, value: (h) => scoreH(h), render: (h) => num(scoreH(h)) },
    { key: "learn", label: "Learn", width: 90, min: 40, shrink: 1, value: (h) => posStr(h.positions) },
    { key: "def", label: "Defense", width: 190, min: 60, shrink: 2, value: (h) => h.def.ifR, render: (h) => <span style={{ color: C.sub, fontSize: 12 }}>{defSummary(h)}</span> },
    { key: "pos", label: "Position", align: "c", width: 78, value: (h) => posRank(assign[h.id] ?? "-"),
      render: (h) => (
        <select value={assign[h.id] ?? "-"} onChange={(e) => changePos(h.id, e.target.value)} style={sel}>
          <option value="-">-</option>
          {h.positions.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      ) },
  ];
  const benchCols: Column<RosterHitterRow>[] = [
    { key: "player", label: "Player", width: 200, min: 80, shrink: 3, value: (h) => h.last || h.title, render: nameCell },
    { key: "value", label: "Value", align: "r", width: 56, value: (h) => h.cost },
    { key: "b", label: "B", align: "c", width: 32, value: (h) => h.bats },
    { key: "score", label: "Score", align: "r", width: 66, value: (h) => scoreH(h), render: (h) => num(scoreH(h)) },
    { key: "learn", label: "Learn", width: 90, min: 40, shrink: 1, value: (h) => posStr(h.positions) },
    { key: "def", label: "Defense", width: 190, min: 60, shrink: 2, value: (h) => h.def.ifR, render: (h) => <span style={{ color: C.sub, fontSize: 12 }}>{defSummary(h)}</span> },
    { key: "pos", label: "Position", align: "c", width: 56, value: () => "BEN", render: () => <span style={{ color: C.sub }}>BEN</span> },
  ];
  const backupsAt = (pos: string) => hitters
    .filter((h) => h.positions.includes(pos) && assign[h.id] !== pos).sort((a, b) => scoreH(b) - scoreH(a)).slice(0, 2);

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
        {(nLock > 0 || nExcl > 0) && <span style={{ fontSize: 12, color: C.sub }}>{nLock} locked · {nExcl} excluded</span>}
        {dirty && <span style={{ fontSize: 12, color: "#f59e0b" }}>⚠ press Regenerate to apply</span>}
        {meta && <span style={{ fontSize: 13, color: C.sub }}>{meta.tournament} · {meta.account}</span>}
      </div>

      {!roster && !rosterLoading && <p style={{ color: C.sub }}>Click Generate to build the optimal roster.</p>}
      {rosterLoading && <p style={{ color: C.sub }}>Optimizing… (this can take a moment)</p>}
      {roster && roster.status !== "Optimal" && <p style={{ color: "#f87171" }}>Solver status: {roster.status}. (Pool: {roster.poolHitters}H / {roster.poolPitchers}P — too few cards for the constraints, e.g. too many locks, or backup depth at a scarce position?)</p>}

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
            <div style={{ display: "flex", gap: 18, alignItems: "flex-start", flexWrap: "wrap" }}>
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
                <p style={{ margin: "0 0 8px", fontSize: 11, color: C.sub }}>
                  Top available cards, {catDesc}.{" "}
                  {emptySpace > 0
                    ? <><b style={{ color: "#86efac" }}>+ Add</b> fills an open slot ({emptySpace}) and locks the card.</>
                    : <>Roster full — <span style={{ color: "#f87171" }}>remove</span> a card to open a slot.</>}
                </p>
                {availItems.length === 0
                  ? <p style={{ fontSize: 12, color: C.sub }}>None available for this tab.</p>
                  : <div style={{ display: "grid", gap: 6, maxHeight: "calc(100vh - 260px)", overflowY: "auto", paddingRight: 4 }}>{availItems}</div>}
              </div>

              {/* Center: roster tables */}
              <div style={{ flex: "999 1 500px", minWidth: 0, maxWidth: 1320 }}>
                <h3 style={{ margin: "0 0 6px", fontSize: 14 }}>Hitters ({hitters.length})</h3>
                <DataTable rows={hitters} cols={hitterCols} getKey={(h) => h.id} initialSort={{ key: "player", dir: 1 }} rowStyle={(h) => roleBg(h.role)} fit />
                <h3 style={{ margin: "16px 0 6px", fontSize: 14 }}>Pitchers ({pitchers.length})</h3>
                <DataTable rows={pitchers} cols={pitcherCols} getKey={(p) => p.id} rowStyle={(p) => roleBg(p.role)} fit />
              </div>

              {/* Right rail: Excluded */}
              <div style={{ flex: "1 1 240px", minWidth: 220, maxWidth: 320 }}>
                <h3 style={{ margin: "0 0 6px", fontSize: 14 }}>Excluded ({excludedList.length})</h3>
                {excludedList.length === 0
                  ? <p style={{ fontSize: 12, color: C.sub }}>None. Use the <span style={{ color: "#ef4444" }}>⊘</span> action to keep a card out of generation.</p>
                  : <>
                      <p style={{ margin: "0 0 6px", fontSize: 11, color: C.sub }}>Never selected. Click ✕ to un-exclude, then Regenerate.</p>
                      <div style={{ display: "grid", gap: 4 }}>
                        {excludedList.map((e) => (
                          <div key={e.id} style={{ display: "flex", alignItems: "flex-start", gap: 6, padding: "4px 6px", border: `1px solid ${C.border}`, borderRadius: 6 }}>
                            <button onClick={() => toggleExclude(e.id)} title="Un-exclude (returns to generation on Regenerate)" style={{ ...inputStyle, padding: "1px 0", width: 26, textAlign: "center", boxSizing: "border-box", fontSize: 12, cursor: "pointer", flex: "0 0 auto", color: "#f87171", border: "1px solid #ef4444" }}>✕</button>
                            <span style={{ flex: "1 1 auto", minWidth: 0, fontSize: 12, lineHeight: 1.3, overflowWrap: "anywhere" }}>{star(e.title)}</span>
                          </div>
                        ))}
                      </div>
                    </>}
              </div>
            </div>
          )}

          {tab === "lineups" && (
            <div>
              <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>{sideBtn("vL", "vs LHP")}{sideBtn("vR", "vs RHP")}</div>
              <p style={{ margin: "0 0 8px", fontSize: 12, color: C.sub }}>Set a player's position with the dropdown — one player per position; choose “-” to move them to the bench. Edits are kept until you Regenerate.</p>
              <div style={{ display: "flex", gap: 22, flexWrap: "wrap", alignItems: "flex-start" }}>
                <div style={{ flex: "3 1 700px", minWidth: 0, maxWidth: 1000 }}>
                  <h3 style={{ margin: "0 0 6px", fontSize: 14 }}>Lineup ({assigned.length}) — vs {side === "vR" ? "RHP" : "LHP"}</h3>
                  <DataTable rows={assigned} cols={lineupCols} getKey={(h) => h.id} initialSort={{ key: "score", dir: -1 }} rowStyle={(h) => roleBg(h.role)} fit />
                  <h3 style={{ margin: "16px 0 6px", fontSize: 14 }}>Bench ({benched.length})</h3>
                  {benched.length === 0 ? <p style={{ fontSize: 13, color: C.sub }}>No bench — every rostered hitter is in the lineup.</p>
                    : <DataTable rows={benched} cols={benchCols} getKey={(h) => h.id} initialSort={{ key: "score", dir: -1 }} rowStyle={() => roleBg("bench")} fit />}
                </div>
                <div style={{ flex: "1 1 260px", minWidth: 0 }}>
                  <h3 style={{ margin: "0 0 6px", fontSize: 14 }}>Depth (vs {side === "vR" ? "RHP" : "LHP"})</h3>
                  <div style={{ display: "grid", gap: 6 }}>
                    {FIELD.map((pos) => {
                      const backups = backupsAt(pos);
                      return (
                        <div key={pos} style={{ padding: "6px 8px", border: `1px solid ${C.border}`, borderRadius: 6 }}>
                          <div style={{ fontWeight: 700, fontSize: 12, color: C.link }}>{pos}</div>
                          {backups.length === 0 ? <div style={{ fontSize: 11, color: "#ef4444", fontStyle: "italic" }}>No backups</div>
                            : backups.map((b, i) => (
                              <div key={b.id} style={{ fontSize: 11, paddingLeft: 6 }}>
                                {i + 1}. {b.title.replace(/^★\s*/, "")} <span style={{ color: C.sub }}>· {defStr(b.def, pos)} · {scoreH(b).toFixed(3)}</span>
                              </div>
                            ))}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          )}

          {tab === "pitching" && (
            <div style={{ display: "flex", gap: 22, flexWrap: "wrap", alignItems: "flex-start" }}>
              <div style={{ flex: "1 1 560px", minWidth: 0, maxWidth: 760 }}>
                <h3 style={{ margin: "0 0 6px", fontSize: 14 }}>Rotation</h3>
                <DataTable rows={rotRows} cols={pStaffCols} getKey={(r) => r.id} rowStyle={() => ({ background: ROSTER_COLORS.starter })} fit />
                <h3 style={{ margin: "14px 0 6px", fontSize: 14 }}>Bullpen ({bullpenRows.length})</h3>
                <DataTable rows={bullpenRows} cols={pStaffCols} getKey={(p) => p.id} initialSort={{ key: "woba", dir: 1 }} rowStyle={() => ({ background: ROSTER_COLORS.reliever })} fit />
              </div>
              <div style={{ flex: "1 1 380px", minWidth: 0, maxWidth: 760 }}>
                <h3 style={{ margin: "0 0 6px", fontSize: 14 }}>Available Starters</h3>
                <p style={{ margin: "0 0 6px", fontSize: 12, color: C.sub }}>Rostered bullpen arms that qualify as SP (stamina ≥ {roster.minStarterStamina}, ≥ {roster.minPitchTypes} pitch types).</p>
                {availSP.length === 0 ? <p style={{ fontSize: 13, color: C.sub }}>None — no spare qualified starters.</p>
                  : <DataTable rows={availSP} cols={pStaffCols} getKey={(p) => p.id} initialSort={{ key: "woba", dir: 1 }} fit />}
              </div>
            </div>
          )}

        </>
      )}
    </div>
  );
}
