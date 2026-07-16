// M5 — Lineup editor (per platoon side). A batting order (1–9) with a defensive
// position per slot and a LOCK per player. A lock round-trips to the optimizer on
// Regenerate (state.toggleLineupLock), so the LP keeps that player there.
//
// Lineup state (batting order + non-locked positions) is seeded from the generated
// roster and is a manual layer — it resets on Regenerate (like added/removed). The
// position LOCKS persist (they're an LP constraint). Position, add/bench, and lock
// are all button/dropdown driven (no drag).

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useAppData } from "./state.tsx";
import { C, inputStyle, lockKey, type RosterHitterRow, type RosterSlotCard } from "./shared.ts";
import { FIELD, star, nameCell, defStr, posCell, bsrTag } from "./roster-cells.tsx";

type Side = "L" | "R";
const strip = (id: string) => id.replace(/#V$/, "");
// Lineup-row grid: lock | # | player | B | pos | defense | score | remove
const GRID = "26px 24px minmax(0,1fr) 22px 84px minmax(0,1.1fr) 56px 24px";

export function LineupTab({
  hitters, seedVR, seedVL, num, roleBg,
}: {
  hitters: RosterHitterRow[];
  seedVR: RosterSlotCard[];
  seedVL: RosterSlotCard[];
  num: (v: number, d?: number) => string;
  roleBg: (role: string) => CSSProperties;
}) {
  const { lineupLocks, toggleLineupLock } = useAppData();
  const [side, setSide] = useState<Side>("R");

  const byId = useMemo(() => new Map(hitters.map((h) => [h.id, h])), [hitters]);
  const score = (id: string, s: Side) => { const h = byId.get(id); return h ? (s === "R" ? h.wobaVR : h.wobaVL) : 0; };
  // Lineup positions come from the generated lineup (so DH presence matches the
  // tournament): field 8 + DH only if the seed used one.
  const hasDH = useMemo(() => seedVR.some((x) => x.pos === "DH") || seedVL.some((x) => x.pos === "DH"), [seedVR, seedVL]);
  const lineupPositions = useMemo(() => (hasDH ? [...FIELD, "DH"] : [...FIELD]), [hasDH]);

  // Ordered batting order per side + the defensive position each occupies.
  const [order, setOrder] = useState<{ L: string[]; R: string[] }>({ L: [], R: [] });
  const [pos, setPos] = useState<{ L: Record<string, string>; R: Record<string, string> }>({ L: {}, R: {} });

  // Seed both sides from the server lineup (position-ordered); batting order is
  // seeded by score desc as a sensible default. Re-runs only when the generated
  // lineup changes (Regenerate), so manual edits survive a side switch but reset
  // on Regenerate.
  useEffect(() => {
    const seedSide = (seed: RosterSlotCard[], s: Side) => {
      const pm: Record<string, string> = {};
      const ids: string[] = [];
      for (const x of seed) { const id = strip(x.id); if (byId.has(id)) { pm[id] = x.pos ?? "-"; ids.push(id); } }
      ids.sort((a, b) => score(b, s) - score(a, s));
      return { ids, pm };
    };
    const r = seedSide(seedVR, "R"); const l = seedSide(seedVL, "L");
    setOrder({ L: l.ids, R: r.ids });
    setPos({ L: l.pm, R: r.pm });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedVR, seedVL]);

  // Live view of the active side, defended against stale ids (removed cards).
  const hitterIds = useMemo(() => new Set(hitters.map((h) => h.id)), [hitters]);
  const lineIds = order[side].filter((id) => hitterIds.has(id) && (pos[side][id] ?? "-") !== "-");
  const benchIds = hitters.map((h) => h.id).filter((id) => !lineIds.includes(id)).sort((a, b) => score(b, side) - score(a, side));
  const usedPos = new Set(lineIds.map((id) => pos[side][id]));
  const lockOf = (id: string) => lineupLocks.get(lockKey(side, id));

  // ── Mutators (operate on the active side) ──
  const mutPos = (fn: (p: Record<string, string>) => Record<string, string>) => setPos((s) => ({ ...s, [side]: fn(s[side]) }));
  const mutOrder = (fn: (o: string[]) => string[]) => setOrder((s) => ({ ...s, [side]: fn(s[side]) }));
  const clearLockIfSet = (id: string) => { const lk = lockOf(id); if (lk) toggleLineupLock(id, lk.pos, side); };

  // Assign a defensive position to a player (swap if the position is taken). "-"
  // benches them. Changing position clears any lock (the lock no longer matches).
  // A displaced holder inherits the vacated position only if he's ELIGIBLE there
  // (can play it — Learn); otherwise he goes to the bench instead of getting a
  // blank/bogus assignment he can't play.
  const changePos = (id: string, newPos: string) => {
    const old = pos[side][id] ?? "-";
    if (newPos === old) return;
    const lk = lockOf(id); if (lk && lk.pos !== newPos) clearLockIfSet(id);
    const holder = newPos !== "-" ? order[side].find((x) => x !== id && pos[side][x] === newPos) : undefined;
    const hh = holder ? byId.get(holder) : undefined;
    const holderKeeps = !!hh && old !== "-" && (hh.allPositions ?? hh.positions).includes(old);
    if (holder && !holderKeeps) clearLockIfSet(holder); // benched → any lock he held is stale
    mutPos((p) => {
      const next = { ...p };
      if (holder) next[holder] = holderKeeps ? old : "-";
      next[id] = newPos;
      return next;
    });
    mutOrder((o) => {
      let next = newPos === "-" ? o.filter((x) => x !== id) : (o.includes(id) ? o : [...o, id]);
      if (holder && !holderKeeps) next = next.filter((x) => x !== holder);
      return next;
    });
  };

  const firstOpenPos = (id: string): string => {
    const h = byId.get(id); if (!h) return "-";
    const elig = lineupPositions.filter((p) => (h.allPositions ?? h.positions).includes(p));
    return elig.find((p) => !usedPos.has(p)) ?? elig[0] ?? "-";
  };
  const addToLineup = (id: string) => {
    const p = firstOpenPos(id); if (p === "-") return;
    mutPos((pm) => { const next = { ...pm }; const holder = order[side].find((x) => x !== id && next[x] === p); if (holder) next[holder] = "-"; next[id] = p; return next; });
    mutOrder((o) => (o.includes(id) ? o : [...o, id]));
  };
  const removeFromLineup = (id: string) => { clearLockIfSet(id); mutPos((p) => ({ ...p, [id]: "-" })); mutOrder((o) => o.filter((x) => x !== id)); };

  const autoFill = () => {
    // Greedy: for each open position, take the best available bat that can play it.
    const working = [...lineIds];
    const next = { ...pos[side] };
    for (const p of lineupPositions) {
      if (working.some((id) => next[id] === p)) continue;
      const cand = hitters.map((h) => h.id).filter((id) => !working.includes(id) && (byId.get(id)!.allPositions ?? byId.get(id)!.positions).includes(p))
        .sort((a, b) => score(b, side) - score(a, side))[0];
      if (cand) { next[cand] = p; working.push(cand); }
    }
    working.sort((a, b) => score(b, side) - score(a, side));
    setPos((s) => ({ ...s, [side]: next })); setOrder((s) => ({ ...s, [side]: working }));
  };
  const clearLineup = () => { for (const id of lineIds) clearLockIfSet(id); setPos((s) => ({ ...s, [side]: {} })); setOrder((s) => ({ ...s, [side]: [] })); };

  const sideLabel = side === "R" ? "RHP" : "LHP";

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 10, alignItems: "center", flexWrap: "wrap" }}>
        {(["L", "R"] as Side[]).map((s) => (
          <button key={s} onClick={() => setSide(s)} style={{ ...inputStyle, cursor: "pointer", background: side === s ? "#374151" : C.input, color: side === s ? "#fff" : C.sub, fontWeight: side === s ? 700 : 400, border: side === s ? `2px solid ${C.accent}` : `1px solid ${C.border}` }}>
            vs {s === "R" ? "RHP" : "LHP"}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <button onClick={autoFill} style={{ ...inputStyle, cursor: "pointer" }} title="Fill every open position with the best available bat">Auto-fill</button>
        <button onClick={clearLineup} style={{ ...inputStyle, cursor: "pointer" }} title="Empty the lineup (everyone to the bench)">Clear</button>
      </div>
      <p style={{ margin: "0 0 8px", fontSize: 12, color: C.sub }}>
        Set a position with the dropdown; click <span style={{ color: "#22c55e" }}>🔒</span> to lock a player there — locks bind the optimizer on Regenerate (displacing whoever it would pick). Edits reset on Regenerate; locks persist.
      </p>

      <div style={{ display: "flex", gap: 22, flexWrap: "wrap", alignItems: "flex-start" }}>
        {/* Lineup */}
        <div style={{ flex: "3 1 640px", minWidth: 0, maxWidth: 1000 }}>
          <h3 style={{ margin: "0 0 6px", fontSize: 14 }}>Batting order ({lineIds.length}) — vs {sideLabel} <span style={{ fontSize: 11, fontWeight: 400, color: C.sub }}>· scores are <b style={{ color: C.text }}>Offense</b> (batting wOBA + baserunning), not batting wOBA</span></h3>
          <div style={{ border: `1px solid ${C.border}` }}>
            <HeaderRow />
            {lineIds.length === 0 && <div style={{ fontSize: 13, color: C.sub, padding: "10px 6px" }}>Empty — add a bench player, or Auto-fill.</div>}
            {lineIds.map((id, i) => {
              const h = byId.get(id)!; const p = pos[side][id] ?? "-"; const lk = lockOf(id);
              return (
                <Row key={id} style={roleBg(h.role)}>
                  {lockBtn(!!lk, () => toggleLineupLock(id, p, side), p)}
                  <span style={{ textAlign: "center", color: C.sub, fontSize: 12 }}>{i + 1}</span>
                  <span style={ell}>{nameCell(h)}</span>
                  <span style={{ textAlign: "center", fontSize: 12 }}>{h.bats}</span>
                  <select value={p} onChange={(e) => changePos(id, e.target.value)} style={posSel} disabled={!!lk} title={lk ? "Unlock to change position" : "Defensive position (⚠ = eligible but below the def minimum)"}>
                    <option value="-">-</option>
                    {(h.allPositions ?? h.positions).filter((q) => lineupPositions.includes(q)).map((q) => <option key={q} value={q}>{q}{h.positions.includes(q) ? "" : " ⚠"}</option>)}
                  </select>
                  <span style={{ ...ell, color: C.sub, fontSize: 11 }}>{defStr(h.def, p) || "—"}</span>
                  <span style={{ textAlign: "right", fontSize: 12 }}>{num(score(id, side))} {bsrTag(h.bsr, true)}</span>
                  <button onClick={() => removeFromLineup(id)} title="Send to bench" style={xBtn}>✕</button>
                </Row>
              );
            })}
          </div>
        </div>

        {/* Bench + depth */}
        <div style={{ flex: "1 1 300px", minWidth: 260 }}>
          <h3 style={{ margin: "0 0 6px", fontSize: 14 }}>Bench ({benchIds.length})</h3>
          <div style={{ border: `1px solid ${C.border}` }}>
            {benchIds.length === 0 && <div style={{ fontSize: 12, color: C.sub, padding: "8px 6px" }}>No bench — every hitter is starting.</div>}
            {benchIds.map((id) => {
              const h = byId.get(id)!; const canAdd = firstOpenPos(id) !== "-";
              return (
                <Row key={id} grid="minmax(0,1fr) 52px 26px" style={roleBg("bench")}>
                  <span style={{ ...ell, fontSize: 12 }}>{nameCell(h)} <span style={{ color: C.sub, fontSize: 11 }}>· {posCell(h.allPositions ?? h.positions, h.positions)}</span></span>
                  <span style={{ textAlign: "right", color: C.sub, fontSize: 11 }}>{num(score(id, side))} {bsrTag(h.bsr, true)}</span>
                  <button onClick={() => addToLineup(id)} disabled={!canAdd} title={canAdd ? "Add to the lineup" : "No eligible position open"} style={addBtn(canAdd)}>+</button>
                </Row>
              );
            })}
          </div>

          <h3 style={{ margin: "16px 0 6px", fontSize: 14 }}>Depth (vs {sideLabel})</h3>
          <div style={{ display: "grid", gap: 6 }}>
            {FIELD.map((p) => {
              // A qualified BACKUP meets the position's BACKUP min (coverPositions), not the
              // stricter starter min. Qualified backups sort first; eligible-only (can play but
              // below even the backup min) sort after and show amber.
              const qual = (h: RosterHitterRow) => (h.coverPositions ?? h.positions).includes(p);
              const backups = hitters.filter((h) => (h.allPositions ?? h.positions).includes(p) && pos[side][h.id] !== p)
                .sort((a, b) => (Number(qual(b)) - Number(qual(a))) || (score(b.id, side) - score(a.id, side))).slice(0, 2);
              const noQualified = !backups.some(qual);
              return (
                <div key={p} style={{ padding: "6px 8px", border: `1px solid ${C.border}`, borderRadius: 6 }}>
                  <div style={{ fontWeight: 700, fontSize: 12, color: C.link }}>{p}{noQualified && backups.length > 0 && <span style={{ color: "#fbbf24", fontWeight: 400 }} title="No rostered backup meets the defensive minimum here"> · no qualified backup</span>}</div>
                  {backups.length === 0 ? <div style={{ fontSize: 11, color: "#ef4444", fontStyle: "italic" }}>No backups</div>
                    : backups.map((b, i) => {
                      const q = qual(b);
                      return (
                        <div key={b.id} style={{ fontSize: 11, paddingLeft: 6, color: q ? undefined : "#fbbf24" }} title={q ? undefined : `Eligible at ${p} but below the defensive minimum`}>
                          {i + 1}. {b.title.replace(/^★\s*/, "")}{!q && " ⚠"} <span style={{ color: C.sub }}>· {defStr(b.def, p)} · {num(score(b.id, side))}</span>
                        </div>
                      );
                    })}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Small presentational pieces ──
const ell: CSSProperties = { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const posSel: CSSProperties = { ...inputStyle, padding: "1px 3px", fontSize: 12, width: "100%", cursor: "pointer" };
const xBtn: CSSProperties = { ...inputStyle, padding: "0", width: 22, height: 22, fontSize: 11, cursor: "pointer", color: "#f87171", border: "1px solid #ef4444", lineHeight: 1 };
const addBtn = (on: boolean): CSSProperties => ({ ...inputStyle, padding: "0", width: 24, height: 22, fontSize: 12, textAlign: "center", cursor: on ? "pointer" : "not-allowed", opacity: on ? 1 : 0.45, color: on ? "#86efac" : C.sub, border: `1px solid ${on ? "#22c55e" : C.border}`, lineHeight: 1 });
const lockBtn = (on: boolean, onClick: () => void, p: string): ReactNode => (
  <button onClick={onClick} disabled={p === "-"} title={on ? `Locked at ${p} — click to unlock` : p === "-" ? "Assign a position first" : `Lock at ${p} (binds the optimizer on Regenerate)`}
    style={{ ...inputStyle, padding: 0, width: 22, height: 22, fontSize: 11, lineHeight: 1, cursor: p === "-" ? "not-allowed" : "pointer", background: on ? "rgba(34,197,94,0.25)" : C.input, border: `1px solid ${on ? "#22c55e" : C.border}`, opacity: p === "-" ? 0.5 : 1 }}>
    {on ? "🔒" : "🔓"}
  </button>
);

function HeaderRow() {
  const h: CSSProperties = { fontSize: 13, color: C.text };
  return (
    <div style={{ display: "grid", gridTemplateColumns: GRID, gap: 6, padding: "5px 6px", alignItems: "center", background: C.head, borderBottom: `1px solid ${C.border}` }}>
      <span style={h}>🔒</span><span style={{ ...h, textAlign: "center" }}>#</span><span style={h}>Player</span><span style={{ ...h, textAlign: "center" }}>B</span><span style={h}>Pos</span><span style={h}>Defense</span><span style={{ ...h, textAlign: "right" }}>Score</span><span />
    </div>
  );
}

// Plain lineup/bench row (grid layout matching the roster tables).
function Row({ children, style, grid = GRID }: { children: ReactNode; style?: CSSProperties; grid?: string }) {
  return (
    <div style={{ ...style, borderBottom: `1px solid ${C.border}`, display: "grid", gridTemplateColumns: grid, gap: 6, alignItems: "center", padding: "5px 6px", fontSize: 13 }}>
      {children}
    </div>
  );
}
