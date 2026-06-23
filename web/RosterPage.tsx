// M4 — Roster & Lineups page. One page, three sub-tabs (Roster / Lineups /
// Pitching) over the same generated roster. Generation controls (Generate +
// Owned-only) live here; the optimizer runs server-side (the one core). Roster
// members are colour-coded by role (both/vL/vR/bench, starter/reliever).

import { useEffect, useState } from "react";
import { useAppData } from "./state.tsx";
import { C, inputStyle, ROSTER_COLORS, ROSTER_BORDER, ROLE_LABEL, type RosterSlotCard } from "./shared.ts";

const money = (n: number | null) => (n == null ? "—" : n.toLocaleString());
const star = (t: string) => (t.startsWith("★") ? <><span style={{ color: C.star }}>★</span>{t.slice(1)}</> : t);
const notOwned = (o: number) => (o > 0 ? <span style={{ color: C.sub }}>{o}</span> : <span style={{ color: "#ef4444", fontWeight: 700 }} title="Not owned">!</span>);

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

export function RosterPage() {
  const { roster, rosterLoading, generateRoster, meta, ownedOnly, setOwnedOnly } = useAppData();
  const [tab, setTab] = useState<Tab>("roster");

  useEffect(() => { if (!roster && !rosterLoading) generateRoster(); /* auto on first visit */ }, []);
  // Re-generate when the owned-only scope changes (only if a roster already exists).
  useEffect(() => { if (roster) generateRoster(); }, [ownedOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  const cell: React.CSSProperties = { padding: "5px 9px", borderBottom: `1px solid ${C.border}`, fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
  const th: React.CSSProperties = { ...cell, textAlign: "left", background: C.head, position: "sticky", top: 0 };
  const num: React.CSSProperties = { ...cell, textAlign: "right" };
  const card = (c?: RosterSlotCard) => (c ? <>{star(c.title)} <span style={{ color: C.sub }}>${c.cost}</span></> : <span style={{ color: C.sub }}>—</span>);
  const roleBg = (role: string): React.CSSProperties => ({ background: ROSTER_COLORS[role] });

  // Lineups merged by position.
  const positions = roster ? roster.lineupVR.map((s) => s.pos!) : [];
  const vlByPos = new Map((roster?.lineupVL ?? []).map((s) => [s.pos, s]));
  const vrByPos = new Map((roster?.lineupVR ?? []).map((s) => [s.pos, s]));
  const roleOf = (id?: string) => (id ? roster?.roles[id.replace(/#V$/, "")] : undefined);
  const tint = (id?: string): React.CSSProperties => { const r = roleOf(id); return r ? { background: ROSTER_COLORS[r] } : {}; };

  const capPct = roster?.cap && roster.cost != null ? Math.round((roster.cost / roster.cap) * 100) : null;
  const tabBtn = (id: Tab, label: string) => (
    <button onClick={() => setTab(id)} style={{ ...inputStyle, cursor: "pointer", background: tab === id ? C.accent : C.input, color: "#fff", fontWeight: tab === id ? 600 : 400 }}>{label}</button>
  );

  return (
    <div style={{ maxWidth: 1000 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0 }}>Roster & Lineups</h2>
        <button onClick={generateRoster} disabled={rosterLoading} style={{ ...inputStyle, cursor: "pointer", background: C.accent, color: "#fff" }}>{rosterLoading ? "Generating…" : roster ? "Regenerate" : "Generate"}</button>
        <label style={{ fontSize: 13, color: C.sub }} title="Off = consider every eligible card, even ones you don't own (best possible roster)">
          <input type="checkbox" checked={ownedOnly} onChange={(e) => setOwnedOnly(e.target.checked)} disabled={rosterLoading} /> Owned only
        </label>
        {meta && <span style={{ fontSize: 13, color: C.sub }}>{meta.tournament} · {meta.account}</span>}
      </div>

      {!roster && !rosterLoading && <p style={{ color: C.sub }}>Click Generate to build the optimal roster.</p>}
      {rosterLoading && <p style={{ color: C.sub }}>Optimizing… (this can take a moment)</p>}

      {roster && roster.status !== "Optimal" && (
        <p style={{ color: "#f87171" }}>Solver status: {roster.status}. (Pool: {roster.poolHitters} hitters / {roster.poolPitchers} pitchers — too few cards for the constraints?)</p>
      )}

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

          {/* ── ROSTER tab: the 26-card list ── */}
          {tab === "roster" && (
            <div style={{ display: "flex", gap: 22, flexWrap: "wrap" }}>
              <div style={{ flex: "1 1 480px" }}>
                <h3 style={{ margin: "0 0 6px", fontSize: 14 }}>Hitters ({roster.rosterHitters.length})</h3>
                <table style={{ borderCollapse: "collapse", width: "100%", border: `1px solid ${C.border}` }}>
                  <thead><tr><th style={th}>Player</th><th style={th}>B</th><th style={th}>Starts</th><th style={{ ...th, textAlign: "right" }}>vL</th><th style={{ ...th, textAlign: "right" }}>vR</th><th style={{ ...th, textAlign: "right" }}>Val</th><th style={{ ...th, textAlign: "right" }}>Own</th></tr></thead>
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
                  <thead><tr><th style={th}>Player</th><th style={th}>T</th><th style={th}>Role</th><th style={{ ...th, textAlign: "right" }}>wOBA</th><th style={{ ...th, textAlign: "right" }}>Stam</th><th style={{ ...th, textAlign: "right" }}>Val</th><th style={{ ...th, textAlign: "right" }}>Own</th></tr></thead>
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

          {/* ── LINEUPS tab ── */}
          {tab === "lineups" && (
            <div style={{ maxWidth: 620 }}>
              <table style={{ borderCollapse: "collapse", width: "100%", border: `1px solid ${C.border}` }}>
                <thead><tr><th style={{ ...th, width: 44 }}>Pos</th><th style={th}>vs RHP</th><th style={th}>vs LHP</th></tr></thead>
                <tbody>
                  {positions.map((p) => (
                    <tr key={p}>
                      <td style={{ ...cell, color: C.sub }}>{p}</td>
                      <td style={{ ...cell, ...tint(vrByPos.get(p)?.id) }}>{card(vrByPos.get(p))}</td>
                      <td style={{ ...cell, ...tint(vlByPos.get(p)?.id) }}>{card(vlByPos.get(p))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {roster.bench.length > 0 && (
                <div style={{ marginTop: 8, fontSize: 13, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                  <span style={{ color: C.sub }}>Bench:</span>
                  {roster.bench.map((b) => <span key={b.id} style={{ background: ROSTER_COLORS.bench, borderRadius: 4, padding: "2px 6px" }}>{star(b.title)} <span style={{ color: C.sub }}>${b.cost}</span></span>)}
                </div>
              )}
            </div>
          )}

          {/* ── PITCHING tab ── */}
          {tab === "pitching" && (
            <div style={{ maxWidth: 480 }}>
              <h3 style={{ margin: "0 0 6px", fontSize: 14 }}>Rotation</h3>
              <table style={{ borderCollapse: "collapse", width: "100%", border: `1px solid ${C.border}` }}>
                <thead><tr><th style={{ ...th, width: 44 }}>Slot</th><th style={th}>Pitcher</th><th style={{ ...th, textAlign: "right", width: 56 }}>Stam</th></tr></thead>
                <tbody>
                  {roster.rotation.map((r) => (
                    <tr key={r.id}>
                      <td style={{ ...cell, color: C.sub }}>SP{r.slot}</td>
                      <td style={{ ...cell, background: ROSTER_COLORS.starter }}>{card(r)}</td>
                      <td style={num}>{r.stamina}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <h3 style={{ margin: "12px 0 6px", fontSize: 14 }}>Bullpen ({roster.bullpen.length})</h3>
              <div style={{ border: `1px solid ${C.border}`, borderRadius: 6 }}>
                {roster.bullpen.map((b) => <div key={b.id} style={{ ...cell, background: ROSTER_COLORS.reliever }}>{card(b)}</div>)}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
