// M4 — Roster & Lineups page. One page, three sub-tabs (Roster / Lineups /
// Pitching) over the same generated roster, all tables sortable. Generation
// controls (Generate + Owned-only) live here; the optimizer runs server-side.
// (Drag-to-edit lineups/rotation is the next step.)

import { useEffect, useState, type ReactNode } from "react";
import { useAppData } from "./state.tsx";
import { DataTable, type Column } from "./DataTable.tsx";
import {
  C, inputStyle, ROSTER_COLORS, ROSTER_BORDER, ROLE_LABEL,
  type RosterHitterRow, type RosterPitcherRow, type CardDef,
} from "./shared.ts";

const star = (t: string) => (t.startsWith("★") ? <><span style={{ color: C.star }}>★</span>{t.slice(1)}</> : t);
const IF = ["1B", "2B", "3B", "SS"], OF = ["LF", "CF", "RF"], FIELD = ["C", "1B", "2B", "3B", "SS", "LF", "CF", "RF"];
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
type LRow = { pos: string; h?: RosterHitterRow };
type RotRow = RosterPitcherRow & { slot: number };

export function RosterPage() {
  const { roster, rosterLoading, generateRoster, meta, ownedOnly, setOwnedOnly } = useAppData();
  const [tab, setTab] = useState<Tab>("roster");
  const [side, setSide] = useState<Side>("vR");

  useEffect(() => { if (!roster && !rosterLoading) generateRoster(); }, []);
  useEffect(() => { if (roster) generateRoster(); }, [ownedOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  const roleBg = (role: string): React.CSSProperties => ({ background: ROSTER_COLORS[role] });
  const tabBtn = (id: Tab, label: string) => (
    <button onClick={() => setTab(id)} style={{ ...inputStyle, cursor: "pointer", background: tab === id ? C.accent : C.input, color: "#fff", fontWeight: tab === id ? 600 : 400 }}>{label}</button>
  );
  const sideBtn = (id: Side, label: string) => (
    <button onClick={() => setSide(id)} style={{ ...inputStyle, cursor: "pointer", background: side === id ? "#374151" : C.input, color: side === id ? "#fff" : C.sub, fontWeight: side === id ? 700 : 400, border: side === id ? `2px solid ${C.accent}` : `1px solid ${C.border}` }}>{label}</button>
  );
  const capPct = roster?.cap && roster.cost != null ? Math.round((roster.cost / roster.cap) * 100) : null;
  const money = (n: number | null) => (n == null ? "—" : n.toLocaleString());

  // ── Column definitions ──
  const num = (v: number, d = 4) => v.toFixed(d);
  const hitterCols: Column<RosterHitterRow>[] = [
    { key: "player", label: "Player", value: (h) => h.last || h.title, render: nameCell },
    { key: "b", label: "B", align: "c", value: (h) => h.bats },
    { key: "pos", label: "Pos", value: (h) => posStr(h.positions) },
    { key: "def", label: "Defense", value: (h) => h.def.ifR, render: (h) => <span style={{ color: C.sub, fontSize: 12 }}>{defSummary(h)}</span> },
    { key: "vL", label: "vL", align: "r", value: (h) => h.wobaVL, render: (h) => num(h.wobaVL) },
    { key: "vR", label: "vR", align: "r", value: (h) => h.wobaVR, render: (h) => num(h.wobaVR) },
    { key: "value", label: "Value", align: "r", value: (h) => h.cost },
  ];
  const pitcherCols: Column<RosterPitcherRow>[] = [
    { key: "player", label: "Player", value: (p) => p.last || p.title, render: nameCell },
    { key: "t", label: "T", align: "c", value: (p) => p.throws },
    { key: "role", label: "Role", value: (p) => p.role, render: (p) => ROLE_LABEL[p.role] },
    { key: "woba", label: "wOBA", align: "r", value: (p) => p.woba, render: (p) => num(p.woba) },
    { key: "stam", label: "Stam", align: "r", value: (p) => p.stamina },
    { key: "pit", label: "# Pit", align: "r", value: (p) => p.pitchTypes },
    { key: "value", label: "Value", align: "r", value: (p) => p.cost },
  ];

  // Lineup / bench (side-specific)
  const hById = new Map((roster?.rosterHitters ?? []).map((h) => [h.id, h]));
  const lineup = roster ? (side === "vR" ? roster.lineupVR : roster.lineupVL) : [];
  const lineupIds = new Set(lineup.map((s) => s.id.replace(/#V$/, "")));
  const scoreH = (h: RosterHitterRow) => (side === "vR" ? h.wobaVR : h.wobaVL);
  const lineupRows: LRow[] = lineup.map((s) => ({ pos: s.pos!, h: hById.get(s.id.replace(/#V$/, "")) }));
  const bench = (roster?.rosterHitters ?? []).filter((h) => !lineupIds.has(h.id));
  const starterAt = (pos: string) => { const s = lineup.find((x) => x.pos === pos); return s ? s.id.replace(/#V$/, "") : null; };
  const backupsAt = (pos: string) => (roster?.rosterHitters ?? [])
    .filter((h) => h.positions.includes(pos) && h.id !== starterAt(pos)).sort((a, b) => scoreH(b) - scoreH(a)).slice(0, 2);

  const lineupCols: Column<LRow>[] = [
    { key: "slot", label: "Pos", value: (r) => FIELD.indexOf(r.pos), render: (r) => <span style={{ color: C.sub }}>{r.pos}</span> },
    { key: "player", label: "Player", value: (r) => r.h?.last ?? "", render: (r) => (r.h ? nameCell(r.h) : "—") },
    { key: "b", label: "B", align: "c", value: (r) => r.h?.bats ?? "" },
    { key: "learn", label: "Learn", value: (r) => (r.h ? posStr(r.h.positions) : "") },
    { key: "def", label: "Defense", value: (r) => (r.h ? defStr(r.h.def, r.pos) : ""), render: (r) => <span style={{ color: C.sub, fontSize: 12 }}>{r.h ? defStr(r.h.def, r.pos) : ""}</span> },
    { key: "score", label: "Score", align: "r", value: (r) => (r.h ? scoreH(r.h) : 0), render: (r) => (r.h ? num(scoreH(r.h)) : "") },
    { key: "value", label: "Value", align: "r", value: (r) => r.h?.cost ?? 0 },
  ];
  const benchCols: Column<RosterHitterRow>[] = [
    { key: "player", label: "Player", value: (h) => h.last || h.title, render: nameCell },
    { key: "b", label: "B", align: "c", value: (h) => h.bats },
    { key: "learn", label: "Learn", value: (h) => posStr(h.positions) },
    { key: "def", label: "Defense", value: (h) => h.def.ifR, render: (h) => <span style={{ color: C.sub, fontSize: 12 }}>{defSummary(h)}</span> },
    { key: "score", label: "Score", align: "r", value: (h) => scoreH(h), render: (h) => num(scoreH(h)) },
    { key: "value", label: "Value", align: "r", value: (h) => h.cost },
  ];

  // Pitching
  const rotRows: RotRow[] = (roster?.rotation ?? []).map((rt) => {
    const p = (roster?.rosterPitchers ?? []).find((x) => x.id === rt.id.replace(/#V$/, ""));
    return { ...(p as RosterPitcherRow), slot: rt.slot };
  }).filter((r) => r.id);
  const bullpen = (roster?.rosterPitchers ?? []).filter((p) => p.role === "reliever");
  const availSP = bullpen.filter((p) => p.stamina >= (roster?.minStarterStamina ?? 70) && p.pitchTypes >= (roster?.minPitchTypes ?? 3));
  const rotCols: Column<RotRow>[] = [{ key: "slot", label: "Slot", value: (r) => r.slot, render: (r) => <span style={{ color: C.sub }}>SP{r.slot}</span> }, ...(pitcherCols.filter((c) => c.key !== "role") as Column<RotRow>[])];
  const bpCols = pitcherCols.filter((c) => c.key !== "role");

  return (
    <div style={{ width: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0 }}>Roster & Lineups</h2>
        <button onClick={generateRoster} disabled={rosterLoading} style={{ ...inputStyle, cursor: "pointer", background: C.accent, color: "#fff" }}>{rosterLoading ? "Generating…" : roster ? "Regenerate" : "Generate"}</button>
        <label style={{ fontSize: 13, color: C.sub }} title="Off = consider every eligible card, even unowned, for the best possible roster (SELECTION only — calibration always uses all eligible cards)">
          <input type="checkbox" checked={ownedOnly} onChange={(e) => setOwnedOnly(e.target.checked)} disabled={rosterLoading} /> Owned only
        </label>
        {meta && <span style={{ fontSize: 13, color: C.sub }}>{meta.tournament} · {meta.account}</span>}
      </div>

      {!roster && !rosterLoading && <p style={{ color: C.sub }}>Click Generate to build the optimal roster.</p>}
      {rosterLoading && <p style={{ color: C.sub }}>Optimizing… (this can take a moment)</p>}
      {roster && roster.status !== "Optimal" && <p style={{ color: "#f87171" }}>Solver status: {roster.status}. (Pool: {roster.poolHitters}H / {roster.poolPitchers}P — too few cards for the constraints?)</p>}

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

          {tab === "roster" && (
            <div style={{ display: "flex", gap: 22, flexWrap: "wrap", alignItems: "flex-start" }}>
              <div style={{ flex: "1 1 600px", minWidth: 0 }}>
                <h3 style={{ margin: "0 0 6px", fontSize: 14 }}>Hitters ({roster.rosterHitters.length})</h3>
                <DataTable rows={roster.rosterHitters} cols={hitterCols} getKey={(h) => h.id} initialSort={{ key: "player", dir: 1 }} rowStyle={(h) => roleBg(h.role)} />
              </div>
              <div style={{ flex: "1 1 460px", minWidth: 0 }}>
                <h3 style={{ margin: "0 0 6px", fontSize: 14 }}>Pitchers ({roster.rosterPitchers.length})</h3>
                <DataTable rows={roster.rosterPitchers} cols={pitcherCols} getKey={(p) => p.id} rowStyle={(p) => roleBg(p.role)} />
              </div>
            </div>
          )}

          {tab === "lineups" && (
            <div>
              <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>{sideBtn("vL", "vs LHP")}{sideBtn("vR", "vs RHP")}</div>
              <div style={{ display: "flex", gap: 22, flexWrap: "wrap", alignItems: "flex-start" }}>
                <div style={{ flex: "3 1 640px", minWidth: 0 }}>
                  <DataTable rows={lineupRows} cols={lineupCols} getKey={(r) => r.pos} initialSort={{ key: "score", dir: -1 }} rowStyle={(r) => (r.h ? roleBg(r.h.role) : {})} />
                  <h3 style={{ margin: "16px 0 6px", fontSize: 14 }}>Bench ({bench.length}) — vs {side === "vR" ? "RHP" : "LHP"}</h3>
                  {bench.length === 0 ? <p style={{ fontSize: 13, color: C.sub }}>No bench (all rostered hitters start this side).</p>
                    : <DataTable rows={bench} cols={benchCols} getKey={(h) => h.id} initialSort={{ key: "score", dir: -1 }} rowStyle={(h) => roleBg(h.role)} />}
                </div>
                <div style={{ flex: "1 1 240px", minWidth: 0 }}>
                  <h3 style={{ margin: "0 0 6px", fontSize: 14 }}>Depth (vs {side === "vR" ? "RHP" : "LHP"})</h3>
                  <div style={{ display: "grid", gap: 6 }}>
                    {FIELD.map((pos) => {
                      const backups = backupsAt(pos);
                      return (
                        <div key={pos} style={{ padding: "6px 8px", border: `1px solid ${C.border}`, borderRadius: 6 }}>
                          <div style={{ fontWeight: 700, fontSize: 12, color: C.link }}>{pos}</div>
                          {backups.length === 0 ? <div style={{ fontSize: 11, color: "#ef4444", fontStyle: "italic" }}>No backups</div>
                            : backups.map((b, i) => <div key={b.id} style={{ fontSize: 11, paddingLeft: 6 }}>{i + 1}. {b.title.replace(/^★\s*/, "")} <span style={{ color: C.sub }}>({scoreH(b).toFixed(3)})</span></div>)}
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
              <div style={{ flex: "1 1 520px", minWidth: 0 }}>
                <h3 style={{ margin: "0 0 6px", fontSize: 14 }}>Rotation</h3>
                <DataTable rows={rotRows} cols={rotCols} getKey={(r) => r.id} initialSort={{ key: "slot", dir: 1 }} rowStyle={() => ({ background: ROSTER_COLORS.starter })} />
                <h3 style={{ margin: "14px 0 6px", fontSize: 14 }}>Bullpen ({bullpen.length})</h3>
                <DataTable rows={bullpen} cols={bpCols} getKey={(p) => p.id} initialSort={{ key: "woba", dir: 1 }} rowStyle={() => ({ background: ROSTER_COLORS.reliever })} />
              </div>
              <div style={{ flex: "1 1 380px", minWidth: 0 }}>
                <h3 style={{ margin: "0 0 6px", fontSize: 14 }}>Available Starters</h3>
                <p style={{ margin: "0 0 6px", fontSize: 12, color: C.sub }}>Rostered bullpen arms that qualify as SP (stamina ≥ {roster.minStarterStamina}, ≥ {roster.minPitchTypes} pitch types).</p>
                {availSP.length === 0 ? <p style={{ fontSize: 13, color: C.sub }}>None — no spare qualified starters.</p>
                  : <DataTable rows={availSP} cols={bpCols} getKey={(p) => p.id} initialSort={{ key: "woba", dir: 1 }} />}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
