// M4 — Roster & Lineups page. One page, three sub-tabs (Roster / Lineups /
// Pitching) over the same generated roster. Generation controls (Generate +
// Owned-only) live here; the optimizer runs server-side (the one core). Roster
// members are colour-coded by role. (Drag-to-edit lineups/rotation is the next
// step — these views show the structure, scores, defense, and values first.)

import { useEffect, useState } from "react";
import { useAppData } from "./state.tsx";
import {
  C, inputStyle, ROSTER_COLORS, ROSTER_BORDER, ROLE_LABEL,
  type RosterHitterRow, type RosterPitcherRow, type CardDef,
} from "./shared.ts";

const star = (t: string) => (t.startsWith("★") ? <><span style={{ color: C.star }}>★</span>{t.slice(1)}</> : t);
const notOwned = (o: number) => (o > 0 ? <span style={{ color: C.sub }}>{o}</span> : <span style={{ color: "#ef4444", fontWeight: 700 }} title="Not owned">!</span>);
const IF = ["1B", "2B", "3B", "SS"], OF = ["LF", "CF", "RF"], FIELD = ["C", "1B", "2B", "3B", "SS", "LF", "CF", "RF"];

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
  return parts.join("  ·  ");
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

export function RosterPage() {
  const { roster, rosterLoading, generateRoster, meta, ownedOnly, setOwnedOnly } = useAppData();
  const [tab, setTab] = useState<Tab>("roster");
  const [side, setSide] = useState<Side>("vR");

  useEffect(() => { if (!roster && !rosterLoading) generateRoster(); }, []);
  useEffect(() => { if (roster) generateRoster(); }, [ownedOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  const cell: React.CSSProperties = { padding: "5px 9px", borderBottom: `1px solid ${C.border}`, fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
  const th: React.CSSProperties = { ...cell, textAlign: "left", background: C.head };
  const num: React.CSSProperties = { ...cell, textAlign: "right" };
  const roleBg = (role: string): React.CSSProperties => ({ background: ROSTER_COLORS[role] });
  const tabBtn = (id: Tab, label: string) => (
    <button onClick={() => setTab(id)} style={{ ...inputStyle, cursor: "pointer", background: tab === id ? C.accent : C.input, color: "#fff", fontWeight: tab === id ? 600 : 400 }}>{label}</button>
  );
  const sideBtn = (id: Side, label: string) => (
    <button onClick={() => setSide(id)} style={{ ...inputStyle, cursor: "pointer", background: side === id ? "#374151" : C.input, color: side === id ? "#fff" : C.sub, fontWeight: side === id ? 700 : 400, border: side === id ? `2px solid ${C.accent}` : `1px solid ${C.border}` }}>{label}</button>
  );

  const capPct = roster?.cap && roster.cost != null ? Math.round((roster.cost / roster.cap) * 100) : null;
  const money = (n: number | null) => (n == null ? "—" : n.toLocaleString());

  // Lineup helpers (depend on roster + side)
  const hById = new Map((roster?.rosterHitters ?? []).map((h) => [h.id, h]));
  const lineup = roster ? (side === "vR" ? roster.lineupVR : roster.lineupVL) : [];
  const lineupIds = new Set(lineup.map((s) => s.id.replace(/#V$/, "")));
  const score = (h: RosterHitterRow) => (side === "vR" ? h.wobaVR : h.wobaVL);
  const bench = (roster?.rosterHitters ?? []).filter((h) => !lineupIds.has(h.id)).sort((a, b) => score(b) - score(a));
  const starterAt = (pos: string) => { const slot = lineup.find((s) => s.pos === pos); return slot ? slot.id.replace(/#V$/, "") : null; };
  const backupsAt = (pos: string) => (roster?.rosterHitters ?? [])
    .filter((h) => h.positions.includes(pos) && h.id !== starterAt(pos))
    .sort((a, b) => score(b) - score(a)).slice(0, 2);

  return (
    <div style={{ maxWidth: 1040 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0 }}>Roster & Lineups</h2>
        <button onClick={generateRoster} disabled={rosterLoading} style={{ ...inputStyle, cursor: "pointer", background: C.accent, color: "#fff" }}>{rosterLoading ? "Generating…" : roster ? "Regenerate" : "Generate"}</button>
        <label style={{ fontSize: 13, color: C.sub }} title="Off = consider every eligible card, even unowned, for the best possible roster (affects SELECTION only — calibration always uses all eligible cards)">
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

          {/* ── ROSTER tab ── */}
          {tab === "roster" && (
            <div style={{ display: "flex", gap: 22, flexWrap: "wrap" }}>
              <div style={{ flex: "1 1 480px" }}>
                <h3 style={{ margin: "0 0 6px", fontSize: 14 }}>Hitters ({roster.rosterHitters.length})</h3>
                <table style={{ borderCollapse: "collapse", width: "100%", border: `1px solid ${C.border}` }}>
                  <thead><tr><th style={th}>Player</th><th style={th}>B</th><th style={th}>Starts</th><th style={{ ...th, textAlign: "right" }}>vL</th><th style={{ ...th, textAlign: "right" }}>vR</th><th style={{ ...th, textAlign: "right" }}>Value</th><th style={{ ...th, textAlign: "right" }}>Own</th></tr></thead>
                  <tbody>
                    {roster.rosterHitters.map((h) => (
                      <tr key={h.id} style={roleBg(h.role)}>
                        <td style={cell}>{star(h.title)}</td>
                        <td style={{ ...cell, color: C.sub }}>{h.bats}</td>
                        <td style={cell}>{ROLE_LABEL[h.role]}</td>
                        <td style={num}>{h.wobaVL.toFixed(4)}</td>
                        <td style={num}>{h.wobaVR.toFixed(4)}</td>
                        <td style={num}>{h.cost}</td>
                        <td style={{ ...num, textAlign: "center" }}>{notOwned(h.owned)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ flex: "1 1 380px" }}>
                <h3 style={{ margin: "0 0 6px", fontSize: 14 }}>Pitchers ({roster.rosterPitchers.length})</h3>
                <table style={{ borderCollapse: "collapse", width: "100%", border: `1px solid ${C.border}` }}>
                  <thead><tr><th style={th}>Player</th><th style={th}>T</th><th style={th}>Role</th><th style={{ ...th, textAlign: "right" }}>wOBA</th><th style={{ ...th, textAlign: "right" }}>Stam</th><th style={{ ...th, textAlign: "right" }}>Value</th><th style={{ ...th, textAlign: "right" }}>Own</th></tr></thead>
                  <tbody>
                    {roster.rosterPitchers.map((p) => (
                      <tr key={p.id} style={roleBg(p.role)}>
                        <td style={cell}>{star(p.title)}</td>
                        <td style={{ ...cell, color: C.sub }}>{p.throws}</td>
                        <td style={cell}>{ROLE_LABEL[p.role]}</td>
                        <td style={num}>{p.woba.toFixed(4)}</td>
                        <td style={num}>{p.stamina}</td>
                        <td style={num}>{p.cost}</td>
                        <td style={{ ...num, textAlign: "center" }}>{notOwned(p.owned)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── LINEUPS tab (vs LHP / vs RHP) ── */}
          {tab === "lineups" && (
            <div>
              <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                {sideBtn("vL", "vs LHP")}{sideBtn("vR", "vs RHP")}
              </div>
              <div style={{ display: "flex", gap: 22, flexWrap: "wrap" }}>
                <div style={{ flex: "2 1 560px" }}>
                  <table style={{ borderCollapse: "collapse", width: "100%", border: `1px solid ${C.border}` }}>
                    <thead><tr><th style={{ ...th, width: 40 }}>Pos</th><th style={th}>Player</th><th style={{ ...th, width: 28 }}>B</th><th style={th}>Defense</th><th style={{ ...th, textAlign: "right" }}>Score</th><th style={{ ...th, textAlign: "right" }}>Value</th></tr></thead>
                    <tbody>
                      {lineup.map((slot) => {
                        const h = hById.get(slot.id.replace(/#V$/, ""));
                        return (
                          <tr key={slot.pos} style={tint(slot.id, roster.roles)}>
                            <td style={{ ...cell, color: C.sub }}>{slot.pos}</td>
                            <td style={cell}>{h ? star(h.title) : "—"}</td>
                            <td style={{ ...cell, color: C.sub }}>{h?.bats}</td>
                            <td style={{ ...cell, color: C.sub, fontSize: 12 }}>{h ? defStr(h.def, slot.pos!) : ""}</td>
                            <td style={num}>{h ? score(h).toFixed(4) : ""}</td>
                            <td style={num}>{h?.cost}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>

                  <h3 style={{ margin: "16px 0 6px", fontSize: 14 }}>Bench ({bench.length}) — vs {side === "vR" ? "RHP" : "LHP"}</h3>
                  <table style={{ borderCollapse: "collapse", width: "100%", border: `1px solid ${C.border}` }}>
                    <thead><tr><th style={th}>Player</th><th style={{ ...th, width: 28 }}>B</th><th style={th}>Defense</th><th style={{ ...th, textAlign: "right" }}>Score</th><th style={{ ...th, textAlign: "right" }}>Value</th></tr></thead>
                    <tbody>
                      {bench.length === 0 ? <tr><td style={{ ...cell, color: C.sub }} colSpan={5}>No bench (all rostered hitters start this side).</td></tr>
                        : bench.map((h) => (
                          <tr key={h.id} style={{ background: ROSTER_COLORS.bench }}>
                            <td style={cell}>{star(h.title)}</td>
                            <td style={{ ...cell, color: C.sub }}>{h.bats}</td>
                            <td style={{ ...cell, color: C.sub, fontSize: 12 }}>{defSummary(h)}</td>
                            <td style={num}>{score(h).toFixed(4)}</td>
                            <td style={num}>{h.cost}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>

                {/* Depth chart / backups */}
                <div style={{ flex: "1 1 240px" }}>
                  <h3 style={{ margin: "0 0 6px", fontSize: 14 }}>Depth (vs {side === "vR" ? "RHP" : "LHP"})</h3>
                  <div style={{ display: "grid", gap: 6 }}>
                    {FIELD.map((pos) => {
                      const backups = backupsAt(pos);
                      return (
                        <div key={pos} style={{ padding: "6px 8px", border: `1px solid ${C.border}`, borderRadius: 6 }}>
                          <div style={{ fontWeight: 700, fontSize: 12, color: C.link }}>{pos}</div>
                          {backups.length === 0 ? <div style={{ fontSize: 11, color: "#ef4444", fontStyle: "italic" }}>No backups</div>
                            : backups.map((b, i) => <div key={b.id} style={{ fontSize: 11, paddingLeft: 6 }}>{i + 1}. {b.title.replace(/^★\s*/, "")} <span style={{ color: C.sub }}>({score(b).toFixed(3)})</span></div>)}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ── PITCHING tab ── */}
          {tab === "pitching" && (
            <div style={{ display: "flex", gap: 22, flexWrap: "wrap" }}>
              <div style={{ flex: "1 1 460px" }}>
                <h3 style={{ margin: "0 0 6px", fontSize: 14 }}>Rotation</h3>
                <PitcherTable rows={roster.rotation.map((r) => roster.rosterPitchers.find((p) => p.id === r.id.replace(/#V$/, ""))!).filter(Boolean)} th={th} cell={cell} num={num} slotLabel="SP" bg={ROSTER_COLORS.starter} />
                <h3 style={{ margin: "14px 0 6px", fontSize: 14 }}>Bullpen ({roster.bullpen.length})</h3>
                <PitcherTable rows={roster.rosterPitchers.filter((p) => p.role === "reliever")} th={th} cell={cell} num={num} bg={ROSTER_COLORS.reliever} />
              </div>
              <div style={{ flex: "1 1 360px" }}>
                <h3 style={{ margin: "0 0 6px", fontSize: 14 }}>Available Starters</h3>
                <p style={{ margin: "0 0 6px", fontSize: 12, color: C.sub }}>Rostered bullpen arms that qualify as SP (stamina ≥ {roster.minStarterStamina}, ≥ {roster.minPitchTypes} pitch types).</p>
                <PitcherTable rows={roster.rosterPitchers.filter((p) => p.role === "reliever" && p.stamina >= roster.minStarterStamina && p.pitchTypes >= roster.minPitchTypes)} th={th} cell={cell} num={num} empty="None — no spare qualified starters." />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function tint(id: string, roles: Record<string, string>): React.CSSProperties {
  const r = roles[id.replace(/#V$/, "")];
  return r ? { background: ROSTER_COLORS[r] } : {};
}

function PitcherTable({ rows, th, cell, num, slotLabel, bg, empty }: {
  rows: RosterPitcherRow[]; th: React.CSSProperties; cell: React.CSSProperties; num: React.CSSProperties; slotLabel?: string; bg?: string; empty?: string;
}) {
  if (rows.length === 0) return <p style={{ fontSize: 12, color: C.sub }}>{empty ?? "None."}</p>;
  return (
    <table style={{ borderCollapse: "collapse", width: "100%", border: `1px solid ${C.border}` }}>
      <thead><tr>{slotLabel && <th style={{ ...th, width: 44 }}>Slot</th>}<th style={th}>Pitcher</th><th style={{ ...th, width: 28 }}>T</th><th style={{ ...th, textAlign: "right" }}>wOBA</th><th style={{ ...th, textAlign: "right" }}>Stam</th><th style={{ ...th, textAlign: "right" }}>Value</th></tr></thead>
      <tbody>
        {rows.map((p, i) => (
          <tr key={p.id} style={bg ? { background: bg } : {}}>
            {slotLabel && <td style={{ ...cell, color: C.sub }}>{slotLabel}{i + 1}</td>}
            <td style={cell}>{star(p.title)}</td>
            <td style={{ ...cell, color: C.sub }}>{p.throws}</td>
            <td style={num}>{p.woba.toFixed(4)}</td>
            <td style={num}>{p.stamina}</td>
            <td style={num}>{p.cost}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
