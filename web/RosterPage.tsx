// M4 — Roster & Lineups page. One page, three sub-tabs (Roster / Lineups /
// Pitching) over the same generated roster; all tables sortable. Generation
// controls (Generate + Owned-only) live here. The Lineups tab supports manual
// position assignment via per-player dropdowns (one player per position); bench
// players sit in a separate Bench table (drag-into-lineup is the next step).

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useAppData } from "./state.tsx";
import { DataTable, type Column } from "./DataTable.tsx";
import {
  C, inputStyle, ROSTER_COLORS, ROSTER_BORDER, ROLE_LABEL,
  type RosterHitterRow, type RosterPitcherRow, type CardDef,
} from "./shared.ts";

const star = (t: string) => (t.startsWith("★") ? <><span style={{ color: C.star }}>★</span>{t.slice(1)}</> : t);
const IF = ["1B", "2B", "3B", "SS"], OF = ["LF", "CF", "RF"], FIELD = ["C", "1B", "2B", "3B", "SS", "LF", "CF", "RF"];
const POS_ORDER = ["C", "1B", "2B", "3B", "SS", "LF", "CF", "RF", "DH"];
const posRank = (p: string) => { const i = POS_ORDER.indexOf(p); return i < 0 ? 99 : i; };
const posStr = (positions: string[]) => { const f = positions.filter((p) => p !== "DH"); return f.length ? f.join("/") : "DH"; };
const nameCell = (r: { title: string; owned: number }): ReactNode => (
  <span>{r.owned <= 0 && <span style={{ color: "#ef4444", fontWeight: 700, marginRight: 4 }} title="Not owned">!</span>}{star(r.title)}</span>
);
function defStr(d: CardDef, pos: string): string {
  if (pos === "C") return `Ab${d.cAb} Fr${d.cFr} Ar${d.cAr}`;
  if (IF.includes(pos)) return `R${d.ifR} E${d.ifE} A${d.ifA} DP${d.dp}`;
  if (OF.includes(pos)) return `R${d.ofR} E${d.ofE} A${d.ofA}`;
  return "";
}
// All defensive ratings the card has (every position group it can field).
function defSummary(h: RosterHitterRow): string {
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
type Side = "vR" | "vL";
type PStaffRow = RosterPitcherRow & { slotLabel: string };

export function RosterPage() {
  const { roster, rosterLoading, generateRoster, meta, ownedOnly, setOwnedOnly } = useAppData();
  const [tab, setTab] = useState<Tab>("roster");
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
  const stale = !!roster && roster.ownedOnly !== ownedOnly;

  // ── Roster-tab columns (Value right after Player) ──
  const hitterCols: Column<RosterHitterRow>[] = [
    { key: "player", label: "Player", value: (h) => h.last || h.title, render: nameCell },
    { key: "value", label: "Value", align: "r", value: (h) => h.cost },
    { key: "b", label: "B", align: "c", value: (h) => h.bats },
    { key: "pos", label: "Pos", value: (h) => posStr(h.positions) },
    { key: "def", label: "Defense", value: (h) => h.def.ifR, render: (h) => <span style={{ color: C.sub, fontSize: 12 }}>{defSummary(h)}</span> },
    { key: "vL", label: "vL", align: "r", value: (h) => h.wobaVL, render: (h) => num(h.wobaVL) },
    { key: "vR", label: "vR", align: "r", value: (h) => h.wobaVR, render: (h) => num(h.wobaVR) },
  ];
  const pitcherCols: Column<RosterPitcherRow>[] = [
    { key: "player", label: "Player", value: (p) => p.last || p.title, render: nameCell },
    { key: "value", label: "Value", align: "r", value: (p) => p.cost },
    { key: "t", label: "T", align: "c", value: (p) => p.throws },
    { key: "role", label: "Role", value: (p) => p.role, render: (p) => ROLE_LABEL[p.role] },
    { key: "woba", label: "wOBA", align: "r", value: (p) => p.woba, render: (p) => num(p.woba) },
    { key: "stam", label: "Stam", align: "r", value: (p) => p.stamina },
    { key: "pit", label: "# Pit", align: "r", value: (p) => p.pitchTypes },
  ];

  // ── Lineups (editable assignment, per side) ──
  const assign = side === "vR" ? assignVR : assignVL;
  const setAssign = side === "vR" ? setAssignVR : setAssignVL;
  const scoreH = (h: RosterHitterRow) => (side === "vR" ? h.wobaVR : h.wobaVL);
  const changePos = (id: string, pos: string) => setAssign((a) => {
    const next = { ...a };
    if (pos !== "-") for (const k of Object.keys(next)) if (next[k] === pos) next[k] = "-"; // one player per position
    next[id] = pos;
    return next;
  });
  const assigned = (roster?.rosterHitters ?? []).filter((h) => (assign[h.id] ?? "-") !== "-");
  const benched = (roster?.rosterHitters ?? []).filter((h) => (assign[h.id] ?? "-") === "-");
  const sel: React.CSSProperties = { ...inputStyle, padding: "2px 4px", fontSize: 12, width: 62, cursor: "pointer" };
  const lineupCols: Column<RosterHitterRow>[] = [
    { key: "player", label: "Player", value: (h) => h.last || h.title, render: nameCell },
    { key: "value", label: "Value", align: "r", value: (h) => h.cost },
    { key: "b", label: "B", align: "c", value: (h) => h.bats },
    { key: "learn", label: "Learn", value: (h) => posStr(h.positions) },
    { key: "def", label: "Defense", value: (h) => h.def.ifR, render: (h) => <span style={{ color: C.sub, fontSize: 12 }}>{defSummary(h)}</span> },
    { key: "pos", label: "Position", align: "c", value: (h) => posRank(assign[h.id] ?? "-"),
      render: (h) => (
        <select value={assign[h.id] ?? "-"} onChange={(e) => changePos(h.id, e.target.value)} style={sel}>
          <option value="-">-</option>
          {h.positions.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      ) },
    { key: "score", label: "Score", align: "r", value: (h) => scoreH(h), render: (h) => num(scoreH(h)) },
  ];
  const benchCols: Column<RosterHitterRow>[] = [
    { key: "player", label: "Player", value: (h) => h.last || h.title, render: nameCell },
    { key: "value", label: "Value", align: "r", value: (h) => h.cost },
    { key: "b", label: "B", align: "c", value: (h) => h.bats },
    { key: "learn", label: "Learn", value: (h) => posStr(h.positions) },
    { key: "def", label: "Defense", value: (h) => h.def.ifR, render: (h) => <span style={{ color: C.sub, fontSize: 12 }}>{defSummary(h)}</span> },
    { key: "pos", label: "Position", align: "c", value: () => "BEN", render: () => <span style={{ color: C.sub }}>BEN</span> },
    { key: "score", label: "Score", align: "r", value: (h) => scoreH(h), render: (h) => num(scoreH(h)) },
  ];
  const backupsAt = (pos: string) => (roster?.rosterHitters ?? [])
    .filter((h) => h.positions.includes(pos) && assign[h.id] !== pos).sort((a, b) => scoreH(b) - scoreH(a)).slice(0, 2);

  // ── Pitching (Rotation + Bullpen share columns/widths so they line up) ──
  const pStaffCols: Column<PStaffRow>[] = [
    { key: "slot", label: "", align: "c", width: 50, value: (p) => p.slotLabel, render: (p) => <span style={{ color: C.sub }}>{p.slotLabel}</span> },
    { key: "player", label: "Player", width: 320, value: (p) => p.last || p.title, render: nameCell },
    { key: "value", label: "Value", align: "r", width: 64, value: (p) => p.cost },
    { key: "t", label: "T", align: "c", width: 38, value: (p) => p.throws },
    { key: "woba", label: "wOBA", align: "r", width: 80, value: (p) => p.woba, render: (p) => num(p.woba) },
    { key: "stam", label: "Stam", align: "r", width: 58, value: (p) => p.stamina },
    { key: "pit", label: "# Pit", align: "r", width: 58, value: (p) => p.pitchTypes },
  ];
  const rotRows: PStaffRow[] = useMemo(() => (roster?.rotation ?? []).map((rt) => {
    const p = (roster?.rosterPitchers ?? []).find((x) => x.id === rt.id.replace(/#V$/, ""));
    return { ...(p as RosterPitcherRow), slotLabel: `SP${rt.slot}`, slot: rt.slot } as PStaffRow & { slot: number };
  }).filter((r) => r.id), [roster]);
  const bullpenRows: PStaffRow[] = (roster?.rosterPitchers ?? []).filter((p) => p.role === "reliever").map((p) => ({ ...p, slotLabel: "RP" }));
  const availSP: PStaffRow[] = bullpenRows.filter((p) => p.stamina >= (roster?.minStarterStamina ?? 70) && p.pitchTypes >= (roster?.minPitchTypes ?? 3));

  return (
    <div style={{ width: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0 }}>Roster & Lineups</h2>
        <button onClick={generateRoster} disabled={rosterLoading} style={{ ...inputStyle, cursor: "pointer", background: stale ? "#b45309" : C.accent, color: "#fff" }}>{rosterLoading ? "Generating…" : roster ? "Regenerate" : "Generate"}</button>
        <label style={{ fontSize: 13, color: C.sub }} title="Off = consider every eligible card, even unowned, for the best possible roster (SELECTION only — calibration always uses all eligible cards). Press Regenerate to apply.">
          <input type="checkbox" checked={ownedOnly} onChange={(e) => setOwnedOnly(e.target.checked)} disabled={rosterLoading} /> Owned only
        </label>
        {stale && <span style={{ fontSize: 12, color: "#f59e0b" }}>⚠ press Regenerate to apply</span>}
        {meta && <span style={{ fontSize: 13, color: C.sub }}>{meta.tournament} · {meta.account}</span>}
      </div>

      {!roster && !rosterLoading && <p style={{ color: C.sub }}>Click Generate to build the optimal roster.</p>}
      {rosterLoading && <p style={{ color: C.sub }}>Optimizing… (this can take a moment)</p>}
      {roster && roster.status !== "Optimal" && <p style={{ color: "#f87171" }}>Solver status: {roster.status}. (Pool: {roster.poolHitters}H / {roster.poolPitchers}P — too few cards for the constraints, e.g. backup depth at a scarce position?)</p>}

      {roster && roster.status === "Optimal" && (
        <>
          <p style={{ margin: "0 0 10px", color: C.sub, fontSize: 13 }}>
            {roster.mode === "cap"
              ? <>Cap: <b style={{ color: (capPct ?? 0) > 100 ? "#f87171" : C.text }}>{money(roster.cost)}/{money(roster.cap)}</b> ({capPct}%) · </>
              : <>Mode: {roster.mode} · </>}
            Pool: {roster.poolHitters}H / {roster.poolPitchers}P · H-value <b style={{ color: C.text }}>{roster.balance?.hitterValue.toFixed(3)}</b> · P-value <b style={{ color: C.text }}>{roster.balance?.pitcherValue.toFixed(3)}</b>
          </p>
          <Legend roles={["both", "vL", "vR", "bench", "starter", "reliever"]} />

          <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
            {tabBtn("roster", `Roster (${roster.rosterHitters.length + roster.rosterPitchers.length})`)}
            {tabBtn("lineups", "Lineups")}
            {tabBtn("pitching", `Pitching (${roster.rosterPitchers.length})`)}
          </div>

          {/* ── ROSTER (stacked) ── */}
          {tab === "roster" && (
            <div style={{ maxWidth: 1280 }}>
              <h3 style={{ margin: "0 0 6px", fontSize: 14 }}>Hitters ({roster.rosterHitters.length})</h3>
              <DataTable rows={roster.rosterHitters} cols={hitterCols} getKey={(h) => h.id} initialSort={{ key: "player", dir: 1 }} rowStyle={(h) => roleBg(h.role)} />
              <h3 style={{ margin: "16px 0 6px", fontSize: 14 }}>Pitchers ({roster.rosterPitchers.length})</h3>
              <DataTable rows={roster.rosterPitchers} cols={pitcherCols} getKey={(p) => p.id} rowStyle={(p) => roleBg(p.role)} />
            </div>
          )}

          {/* ── LINEUPS ── */}
          {tab === "lineups" && (
            <div>
              <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>{sideBtn("vL", "vs LHP")}{sideBtn("vR", "vs RHP")}</div>
              <p style={{ margin: "0 0 8px", fontSize: 12, color: C.sub }}>Set a player's position with the dropdown — one player per position; choose “-” to move them to the bench. Edits are kept until you Regenerate.</p>
              <div style={{ display: "flex", gap: 22, flexWrap: "wrap", alignItems: "flex-start" }}>
                <div style={{ flex: "3 1 700px", minWidth: 0, maxWidth: 1000 }}>
                  <h3 style={{ margin: "0 0 6px", fontSize: 14 }}>Lineup ({assigned.length}) — vs {side === "vR" ? "RHP" : "LHP"}</h3>
                  <DataTable rows={assigned} cols={lineupCols} getKey={(h) => h.id} initialSort={{ key: "score", dir: -1 }} rowStyle={(h) => roleBg(h.role)} />
                  <h3 style={{ margin: "16px 0 6px", fontSize: 14 }}>Bench ({benched.length})</h3>
                  {benched.length === 0 ? <p style={{ fontSize: 13, color: C.sub }}>No bench — every rostered hitter is in the lineup.</p>
                    : <DataTable rows={benched} cols={benchCols} getKey={(h) => h.id} initialSort={{ key: "score", dir: -1 }} rowStyle={() => roleBg("bench")} />}
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

          {/* ── PITCHING ── */}
          {tab === "pitching" && (
            <div style={{ display: "flex", gap: 22, flexWrap: "wrap", alignItems: "flex-start" }}>
              <div style={{ flex: "1 1 560px", minWidth: 0, maxWidth: 760 }}>
                <h3 style={{ margin: "0 0 6px", fontSize: 14 }}>Rotation</h3>
                <DataTable rows={rotRows} cols={pStaffCols} getKey={(r) => r.id} rowStyle={() => ({ background: ROSTER_COLORS.starter })} />
                <h3 style={{ margin: "14px 0 6px", fontSize: 14 }}>Bullpen ({bullpenRows.length})</h3>
                <DataTable rows={bullpenRows} cols={pStaffCols} getKey={(p) => p.id} initialSort={{ key: "woba", dir: 1 }} rowStyle={() => ({ background: ROSTER_COLORS.reliever })} />
              </div>
              <div style={{ flex: "1 1 380px", minWidth: 0, maxWidth: 760 }}>
                <h3 style={{ margin: "0 0 6px", fontSize: 14 }}>Available Starters</h3>
                <p style={{ margin: "0 0 6px", fontSize: 12, color: C.sub }}>Rostered bullpen arms that qualify as SP (stamina ≥ {roster.minStarterStamina}, ≥ {roster.minPitchTypes} pitch types).</p>
                {availSP.length === 0 ? <p style={{ fontSize: 13, color: C.sub }}>None — no spare qualified starters.</p>
                  : <DataTable rows={availSP} cols={pStaffCols} getKey={(p) => p.id} initialSort={{ key: "woba", dir: 1 }} />}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
