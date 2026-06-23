// M5 — Lineup editor (per platoon side). A real batting order (1–9) you can drag
// to reorder, drag players between bench and lineup, assign a defensive position
// per slot, and LOCK a player to a position. A lock round-trips to the optimizer
// on Regenerate (state.toggleLineupLock), so the LP keeps that player there.
//
// Lineup state (batting order + non-locked positions) is seeded from the generated
// roster and is a manual layer — it resets on Regenerate (like added/removed). The
// position LOCKS persist (they're an LP constraint). Buttons mirror every drag
// action so the editor is fully usable without dragging.

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  DndContext, DragOverlay, PointerSensor, useSensor, useSensors, closestCenter,
  useDroppable, type DragStartEvent, type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useAppData } from "./state.tsx";
import { C, inputStyle, lockKey, type RosterHitterRow, type RosterSlotCard } from "./shared.ts";
import { FIELD, star, defStr, posStr } from "./roster-cells.tsx";

type Side = "L" | "R";
const strip = (id: string) => id.replace(/#V$/, "");
// Lineup-row grid: grip | lock | # | player | B | pos | defense | score | remove
const GRID = "18px 26px 24px minmax(0,1fr) 22px 84px minmax(0,1.1fr) 56px 24px";

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
  const [dragId, setDragId] = useState<string | null>(null);

  // Seed both sides from the server lineup (position-ordered); batting order is
  // seeded by score desc as a sensible default the user then reorders. Re-runs only
  // when the generated lineup changes (Regenerate), so manual edits survive a side
  // switch but reset on Regenerate.
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
  const changePos = (id: string, newPos: string) => {
    const old = pos[side][id] ?? "-";
    if (newPos === old) return;
    const lk = lockOf(id); if (lk && lk.pos !== newPos) clearLockIfSet(id);
    mutPos((p) => {
      const next = { ...p };
      if (newPos !== "-") { const holder = order[side].find((x) => x !== id && next[x] === newPos); if (holder) next[holder] = old; }
      next[id] = newPos;
      return next;
    });
    if (newPos === "-") mutOrder((o) => o.filter((x) => x !== id));
    else if (!order[side].includes(id)) mutOrder((o) => [...o, id]);
  };

  const firstOpenPos = (id: string): string => {
    const h = byId.get(id); if (!h) return "-";
    const elig = lineupPositions.filter((p) => h.positions.includes(p));
    return elig.find((p) => !usedPos.has(p)) ?? elig[0] ?? "-";
  };
  const addToLineupAt = (id: string, index: number) => {
    const p = firstOpenPos(id); if (p === "-") return;
    mutPos((pm) => { const next = { ...pm }; const holder = order[side].find((x) => x !== id && next[x] === p); if (holder) next[holder] = "-"; next[id] = p; return next; });
    mutOrder((o) => { const without = o.filter((x) => x !== id); const at = Math.max(0, Math.min(index, without.length)); return [...without.slice(0, at), id, ...without.slice(at)]; });
  };
  const removeFromLineup = (id: string) => { clearLockIfSet(id); mutPos((p) => ({ ...p, [id]: "-" })); mutOrder((o) => o.filter((x) => x !== id)); };

  const autoFill = () => {
    // Greedy: for each open position, take the best available bat that can play it.
    const working = [...lineIds];
    const next = { ...pos[side] };
    for (const p of lineupPositions) {
      if (working.some((id) => next[id] === p)) continue;
      const cand = hitters.map((h) => h.id).filter((id) => !working.includes(id) && byId.get(id)!.positions.includes(p))
        .sort((a, b) => score(b, side) - score(a, side))[0];
      if (cand) { next[cand] = p; working.push(cand); }
    }
    working.sort((a, b) => score(b, side) - score(a, side));
    setPos((s) => ({ ...s, [side]: next })); setOrder((s) => ({ ...s, [side]: working }));
  };
  const clearLineup = () => { for (const id of lineIds) clearLockIfSet(id); setPos((s) => ({ ...s, [side]: {} })); setOrder((s) => ({ ...s, [side]: [] })); };

  // ── DnD: reorder batting order, and drag between bench and lineup ──
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const findContainer = (id: string): "lineup" | "bench" => (lineIds.includes(id) ? "lineup" : "bench");
  const onDragStart = (e: DragStartEvent) => setDragId(String(e.active.id));
  const onDragEnd = (e: DragEndEvent) => {
    setDragId(null);
    const a = String(e.active.id); const over = e.over; if (!over) return;
    const o = String(over.id);
    const ca = findContainer(a);
    const co = o === "lineup-drop" ? "lineup" : o === "bench-drop" ? "bench" : findContainer(o);
    if (ca === "lineup" && co === "lineup") {
      const oldI = lineIds.indexOf(a); const newI = lineIds.indexOf(o);
      if (oldI >= 0 && newI >= 0 && oldI !== newI) {
        const moved = arrayMove(lineIds, oldI, newI);
        mutOrder((prev) => { const tail = prev.filter((x) => !moved.includes(x)); return [...moved, ...tail]; });
      }
    } else if (ca === "bench" && co === "lineup") {
      addToLineupAt(a, lineIds.includes(o) ? lineIds.indexOf(o) : lineIds.length);
    } else if (ca === "lineup" && co === "bench") {
      removeFromLineup(a);
    }
  };

  const dragRow = dragId ? byId.get(dragId) : null;
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
        Drag the <span style={{ color: C.text }}>⠿</span> handle to reorder the batting order or move players between bench and lineup. Set a position with the dropdown; click <span style={{ color: "#22c55e" }}>🔒</span> to lock a player there — locks bind the optimizer on Regenerate (displacing whoever it would pick). Edits reset on Regenerate; locks persist.
      </p>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={onDragStart} onDragEnd={onDragEnd}>
        <div style={{ display: "flex", gap: 22, flexWrap: "wrap", alignItems: "flex-start" }}>
          {/* Lineup */}
          <div style={{ flex: "3 1 640px", minWidth: 0, maxWidth: 1000 }}>
            <h3 style={{ margin: "0 0 6px", fontSize: 14 }}>Batting order ({lineIds.length}) — vs {sideLabel}</h3>
            <HeaderRow />
            <LineupDrop>
              <SortableContext items={lineIds} strategy={verticalListSortingStrategy}>
                {lineIds.length === 0 && <div style={{ fontSize: 13, color: C.sub, padding: "10px 6px" }}>Empty — drag a bench player here, or Auto-fill.</div>}
                {lineIds.map((id, i) => {
                  const h = byId.get(id)!; const p = pos[side][id] ?? "-"; const lk = lockOf(id);
                  return (
                    <SortableRow key={id} id={id} grid={GRID} style={roleBg(h.role)}>
                      {lockBtn(!!lk, () => toggleLineupLock(id, p, side), p)}
                      <span style={{ textAlign: "center", color: C.sub, fontSize: 12 }}>{i + 1}</span>
                      <span style={ell}>{h.owned <= 0 && <span style={{ color: "#ef4444", fontWeight: 700, marginRight: 3 }} title="Not owned">!</span>}{star(h.title)}</span>
                      <span style={{ textAlign: "center", fontSize: 12 }}>{h.bats}</span>
                      <select value={p} onChange={(e) => changePos(id, e.target.value)} style={posSel} disabled={!!lk} title={lk ? "Unlock to change position" : "Defensive position"}>
                        <option value="-">-</option>
                        {h.positions.filter((q) => lineupPositions.includes(q)).map((q) => <option key={q} value={q}>{q}</option>)}
                      </select>
                      <span style={{ ...ell, color: C.sub, fontSize: 11 }}>{defStr(h.def, p) || "—"}</span>
                      <span style={{ textAlign: "right", fontSize: 12 }}>{num(score(id, side))}</span>
                      <button onClick={() => removeFromLineup(id)} title="Send to bench" style={xBtn}>✕</button>
                    </SortableRow>
                  );
                })}
              </SortableContext>
            </LineupDrop>
          </div>

          {/* Bench + depth */}
          <div style={{ flex: "1 1 300px", minWidth: 260 }}>
            <h3 style={{ margin: "0 0 6px", fontSize: 14 }}>Bench ({benchIds.length})</h3>
            <BenchDrop>
              <SortableContext items={benchIds} strategy={verticalListSortingStrategy}>
                {benchIds.length === 0 && <div style={{ fontSize: 12, color: C.sub, padding: "8px 6px" }}>No bench — every hitter is starting.</div>}
                {benchIds.map((id) => {
                  const h = byId.get(id)!; const canAdd = firstOpenPos(id) !== "-";
                  return (
                    <SortableRow key={id} id={id} grid="18px minmax(0,1fr) 50px 58px" style={roleBg("bench")}>
                      <span style={{ ...ell, fontSize: 12 }}>{h.owned <= 0 && <span style={{ color: "#ef4444", fontWeight: 700, marginRight: 3 }} title="Not owned">!</span>}{star(h.title)} <span style={{ color: C.sub, fontSize: 11 }}>· {h.bats} · {posStr(h.positions)}</span></span>
                      <span style={{ textAlign: "right", color: C.sub, fontSize: 11 }}>{num(score(id, side))}</span>
                      <button onClick={() => addToLineupAt(id, lineIds.length)} disabled={!canAdd} title={canAdd ? "Add to the lineup" : "No eligible position open"} style={addBtn(canAdd)}>+ Add</button>
                    </SortableRow>
                  );
                })}
              </SortableContext>
            </BenchDrop>

            <h3 style={{ margin: "16px 0 6px", fontSize: 14 }}>Depth (vs {sideLabel})</h3>
            <div style={{ display: "grid", gap: 6 }}>
              {FIELD.map((p) => {
                const backups = hitters.filter((h) => h.positions.includes(p) && pos[side][h.id] !== p).sort((a, b) => score(b.id, side) - score(a.id, side)).slice(0, 2);
                return (
                  <div key={p} style={{ padding: "6px 8px", border: `1px solid ${C.border}`, borderRadius: 6 }}>
                    <div style={{ fontWeight: 700, fontSize: 12, color: C.link }}>{p}</div>
                    {backups.length === 0 ? <div style={{ fontSize: 11, color: "#ef4444", fontStyle: "italic" }}>No backups</div>
                      : backups.map((b, i) => (
                        <div key={b.id} style={{ fontSize: 11, paddingLeft: 6 }}>
                          {i + 1}. {b.title.replace(/^★\s*/, "")} <span style={{ color: C.sub }}>· {defStr(b.def, p)} · {num(score(b.id, side))}</span>
                        </div>
                      ))}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <DragOverlay>
          {dragRow ? (
            <div style={{ borderRadius: 6, background: C.headActive, border: `1px solid ${C.accent}`, boxShadow: "0 6px 18px rgba(0,0,0,0.5)", display: "flex", gap: 8, alignItems: "center", padding: "5px 8px" }}>
              <span style={{ color: C.sub }}>⠿</span><span style={{ fontWeight: 600, fontSize: 13 }}>{star(dragRow.title)}</span>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

// ── Small presentational pieces ──
const ell: CSSProperties = { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const posSel: CSSProperties = { ...inputStyle, padding: "1px 3px", fontSize: 12, width: "100%", cursor: "pointer" };
const xBtn: CSSProperties = { ...inputStyle, padding: "0", width: 22, height: 22, fontSize: 11, cursor: "pointer", color: "#f87171", border: "1px solid #ef4444", lineHeight: 1 };
const addBtn = (on: boolean): CSSProperties => ({ ...inputStyle, padding: "1px 7px", fontSize: 11, whiteSpace: "nowrap", cursor: on ? "pointer" : "not-allowed", opacity: on ? 1 : 0.45, background: on ? "rgba(34,197,94,0.18)" : C.input, color: on ? "#86efac" : C.sub, border: `1px solid ${on ? "#22c55e" : C.border}` });
const lockBtn = (on: boolean, onClick: () => void, p: string): ReactNode => (
  <button onClick={onClick} disabled={p === "-"} title={on ? `Locked at ${p} — click to unlock` : p === "-" ? "Assign a position first" : `Lock at ${p} (binds the optimizer on Regenerate)`}
    style={{ ...inputStyle, padding: 0, width: 22, height: 22, fontSize: 11, lineHeight: 1, cursor: p === "-" ? "not-allowed" : "pointer", background: on ? "rgba(34,197,94,0.25)" : C.input, border: `1px solid ${on ? "#22c55e" : C.border}`, opacity: p === "-" ? 0.5 : 1 }}>
    {on ? "🔒" : "🔓"}
  </button>
);

function HeaderRow() {
  const h: CSSProperties = { fontSize: 11, color: C.sub, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4 };
  return (
    <div style={{ display: "grid", gridTemplateColumns: GRID, gap: 6, padding: "0 8px 4px", alignItems: "center" }}>
      <span /><span style={h}>🔒</span><span style={{ ...h, textAlign: "center" }}>#</span><span style={h}>Player</span><span style={{ ...h, textAlign: "center" }}>B</span><span style={h}>Pos</span><span style={h}>Defense</span><span style={{ ...h, textAlign: "right" }}>Score</span><span />
    </div>
  );
}

// Sortable row — a leading grip cell drives the drag; the rest stays interactive.
function SortableRow({ id, children, style, grid }: { id: string; children: ReactNode; style?: CSSProperties; grid: string }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const wrap: CSSProperties = {
    ...style, transform: CSS.Transform.toString(transform), transition,
    opacity: isDragging ? 0.4 : 1, border: `1px solid ${C.border}`, borderRadius: 6, marginBottom: 4,
    display: "grid", gridTemplateColumns: grid, gap: 6, alignItems: "center", padding: "4px 8px",
  };
  return (
    <div ref={setNodeRef} style={wrap}>
      <span {...attributes} {...listeners} title="Drag to move" style={{ cursor: "grab", color: C.sub, fontSize: 14, lineHeight: 1, userSelect: "none", touchAction: "none" }}>⠿</span>
      {children}
    </div>
  );
}

function LineupDrop({ children }: { children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: "lineup-drop" });
  return <div ref={setNodeRef} style={{ minHeight: 60, padding: 2, borderRadius: 8, outline: isOver ? `2px dashed ${C.accent}` : "none" }}>{children}</div>;
}
function BenchDrop({ children }: { children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: "bench-drop" });
  return <div ref={setNodeRef} style={{ minHeight: 40, padding: 2, borderRadius: 8, outline: isOver ? `2px dashed ${C.accent}` : "none" }}>{children}</div>;
}
