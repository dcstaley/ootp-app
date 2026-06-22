// M4 Phase D — Roster & Lineups. Generates an optimal roster for the active
// (tournament, account) via the one optimizer and renders the 26-man: platoon
// lineups (vR/vL side by side), rotation, bullpen, bench, plus cap usage and the
// H/P value balance (SP-7). The grid highlights these members.

import { useEffect } from "react";
import { useAppData } from "./state.tsx";
import { C, inputStyle, type RosterSlotCard } from "./shared.ts";

const money = (n: number | null) => (n == null ? "—" : n.toLocaleString());

export function RosterPage() {
  const { roster, rosterLoading, generateRoster, meta } = useAppData();

  useEffect(() => { if (!roster && !rosterLoading) generateRoster(); /* auto on first visit */ }, []);

  const btn = { ...inputStyle, cursor: "pointer", background: C.accent, color: "#fff" } as React.CSSProperties;
  const cell: React.CSSProperties = { padding: "5px 9px", borderBottom: `1px solid ${C.border}`, fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
  const star = (t: string) => t.startsWith("★") ? <><span style={{ color: C.star }}>★</span>{t.slice(1)}</> : t;
  const card = (c?: RosterSlotCard) => c ? <>{star(c.title)} <span style={{ color: C.sub }}>${c.cost}</span></> : <span style={{ color: C.sub }}>—</span>;

  // Merge the two platoon lineups by position (both share the same position order).
  const positions = roster ? roster.lineupVR.map((s) => s.pos!) : [];
  const vlByPos = new Map((roster?.lineupVL ?? []).map((s) => [s.pos, s]));
  const vrByPos = new Map((roster?.lineupVR ?? []).map((s) => [s.pos, s]));

  const capPct = roster?.cap && roster.cost != null ? Math.round((roster.cost / roster.cap) * 100) : null;

  return (
    <div style={{ maxWidth: 980 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
        <h2 style={{ margin: 0 }}>Roster & Lineups</h2>
        <button onClick={generateRoster} disabled={rosterLoading} style={btn}>{rosterLoading ? "Generating…" : roster ? "Regenerate" : "Generate"}</button>
        {meta && <span style={{ fontSize: 13, color: C.sub }}>{meta.tournament} · {meta.account}</span>}
      </div>

      {!roster && !rosterLoading && <p style={{ color: C.sub }}>Click Generate to build the optimal roster.</p>}
      {rosterLoading && <p style={{ color: C.sub }}>Optimizing… (owned-scoped pool, this can take a moment)</p>}

      {roster && roster.status !== "Optimal" && (
        <p style={{ color: "#f87171" }}>Solver status: {roster.status}. (Pool: {roster.poolHitters} hitters / {roster.poolPitchers} pitchers — too few owned cards for this tournament's constraints?)</p>
      )}

      {roster && roster.status === "Optimal" && (
        <>
          <p style={{ margin: "0 0 14px", color: C.sub, fontSize: 13 }}>
            {roster.mode === "cap"
              ? <>Cap: <b style={{ color: capPct! > 100 ? "#f87171" : C.text }}>{money(roster.cost)}/{money(roster.cap)}</b> ({capPct}%) · </>
              : <>Mode: {roster.mode} · </>}
            Pool: {roster.poolHitters}H / {roster.poolPitchers}P · H-value <b style={{ color: C.text }}>{roster.balance?.hitterValue.toFixed(3)}</b> · P-value <b style={{ color: C.text }}>{roster.balance?.pitcherValue.toFixed(3)}</b>
          </p>

          <div style={{ display: "flex", gap: 22, flexWrap: "wrap" }}>
            {/* Lineups (platoon, side by side) */}
            <div style={{ flex: "1 1 560px" }}>
              <h3 style={{ margin: "0 0 6px", fontSize: 14 }}>Lineups</h3>
              <table style={{ borderCollapse: "collapse", width: "100%", border: `1px solid ${C.border}` }}>
                <thead><tr style={{ background: C.head }}>
                  <th style={{ ...cell, textAlign: "left", width: 44 }}>Pos</th>
                  <th style={{ ...cell, textAlign: "left" }}>vs RHP</th>
                  <th style={{ ...cell, textAlign: "left" }}>vs LHP</th>
                </tr></thead>
                <tbody>
                  {positions.map((p) => (
                    <tr key={p}>
                      <td style={{ ...cell, color: C.sub }}>{p}</td>
                      <td style={cell}>{card(vrByPos.get(p))}</td>
                      <td style={cell}>{card(vlByPos.get(p))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {roster.bench.length > 0 && (
                <div style={{ marginTop: 8, fontSize: 13 }}>
                  <span style={{ color: C.sub }}>Bench:</span> {roster.bench.map((b, i) => <span key={b.id}>{i ? ", " : " "}{star(b.title)} <span style={{ color: C.sub }}>${b.cost}</span></span>)}
                </div>
              )}
            </div>

            {/* Pitching staff */}
            <div style={{ flex: "1 1 360px" }}>
              <h3 style={{ margin: "0 0 6px", fontSize: 14 }}>Rotation</h3>
              <table style={{ borderCollapse: "collapse", width: "100%", border: `1px solid ${C.border}` }}>
                <thead><tr style={{ background: C.head }}>
                  <th style={{ ...cell, textAlign: "left", width: 44 }}>Slot</th>
                  <th style={{ ...cell, textAlign: "left" }}>Pitcher</th>
                  <th style={{ ...cell, textAlign: "right", width: 56 }}>Stam</th>
                </tr></thead>
                <tbody>
                  {roster.rotation.map((r) => (
                    <tr key={r.id}>
                      <td style={{ ...cell, color: C.sub }}>SP{r.slot}</td>
                      <td style={cell}>{card(r)}</td>
                      <td style={{ ...cell, textAlign: "right" }}>{r.stamina}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <h3 style={{ margin: "12px 0 6px", fontSize: 14 }}>Bullpen ({roster.bullpen.length})</h3>
              <div style={{ border: `1px solid ${C.border}`, borderRadius: 6 }}>
                {roster.bullpen.map((b) => <div key={b.id} style={cell}>{card(b)}</div>)}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
