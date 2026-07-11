// Reusable sortable table. Columns declare a sort `value` (number|string) and an
// optional custom `render`. Click a header to sort (toggles asc/desc; numeric columns
// start DESCENDING — best first, like the Cards grid); an optional `initialSort` sets
// the default. Headers are sticky (the wrapper scrolls vertically past 74vh, like the
// Cards grid). Used across the roster-page tabs.
//
// `fit` mode: the table always fits its container (never scrolls). Columns marked
// shrinkable (`shrink` = priority, lower shrinks first; `min` = floor) absorb the
// squeeze in priority order; protected columns keep their `width`. Spare space goes
// to the last-to-shrink column.
//
// `resizable`: drag a header's right edge to set a column's width. A resized column
// becomes fixed at that width (the table scrolls if the total exceeds the container).
// Widths reset whenever `resetKey` changes (the roster page passes the roster, so a
// Regenerate restores the defaults).

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { C } from "./shared.ts";

export type Align = "l" | "r" | "c";
export interface Column<T> {
  key: string;
  label: string;
  align?: Align;
  width?: number;                            // px; if any col sets it → fixed layout (lets tables align)
  min?: number;                              // fit mode: minimum px before clipping
  max?: number;                              // fit mode: cap on grow-to-fill (avoids a giant empty cell)
  shrink?: number;                           // fit mode: shrink priority (lower = shrink first); absent = protected
  value: (row: T) => string | number;       // sort key + default cell text
  render?: (row: T) => ReactNode;            // custom cell (falls back to value())
  title?: string;                            // header tooltip
}

const ta = (a?: Align) => (a === "r" ? "right" : a === "c" ? "center" : "left");

/**
 * Fit columns into exactly `avail` px (never overflow → never scroll, always fill the width).
 * Over: squeeze shrinkables by priority (lower `order` first) to their `min`; if still over,
 * clip the flex columns below min (content ellipsizes), keeping fixed columns intact. Under:
 * grow the primary flex column (highest `order` — the name, which has real content to show)
 * so the table uses the full available width without ballooning a fixed/short column.
 */
function fitWidths<T>(cols: Column<T>[], avail: number): number[] {
  const res = cols.map((c) => c.width ?? 80);
  const total = res.reduce((a, b) => a + b, 0);
  const shrinkable = cols.map((c, i) => ({ i, order: c.shrink, min: c.min ?? c.width ?? 80 }))
    .filter((x) => x.order != null) as { i: number; order: number; min: number }[];
  if (total < avail && shrinkable.length) { // under: grow the primary flex column to fill the width
    const grow = [...shrinkable].sort((a, b) => b.order - a.order)[0]!;
    const cap = cols[grow.i]!.max ?? Infinity; // don't balloon past content into a giant empty cell
    res[grow.i]! = Math.min(cap, res[grow.i]! + (avail - total));
    return res;
  }
  let over = total - avail;
  for (const s of [...shrinkable].sort((a, b) => a.order - b.order)) {
    if (over <= 0) break;
    const take = Math.min(res[s.i]! - s.min, over);
    res[s.i]! -= take; over -= take;
  }
  if (over > 0) { // past all mins: clip flex columns below their min (fixed cols stay intact)
    for (const s of [...shrinkable].sort((a, b) => a.order - b.order)) {
      if (over <= 0) break;
      const take = Math.min(res[s.i]! - 8, over);
      res[s.i]! -= take; over -= take;
    }
  }
  if (over > 0) { // pathological (nothing left to give) → scale all so it still never scrolls
    const k = avail / res.reduce((a, b) => a + b, 0);
    for (let i = 0; i < res.length; i++) res[i] = Math.floor(res[i]! * k);
  }
  return res;
}

export function DataTable<T>({ rows, cols, getKey, initialSort, rowStyle, fit, resizable, resetKey }: {
  rows: T[];
  cols: Column<T>[];
  getKey: (row: T) => string;
  initialSort?: { key: string; dir: 1 | -1 };
  rowStyle?: (row: T) => CSSProperties;
  fit?: boolean;
  resizable?: boolean;
  resetKey?: unknown;          // changing this clears user-set column widths (e.g. on Regenerate)
}) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(initialSort ?? null);
  const [widths, setWidths] = useState<Record<string, number>>({}); // user-resized column widths
  const wrapRef = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState(0);

  useEffect(() => { setWidths({}); }, [resetKey]); // a fresh roster restores default widths

  useLayoutEffect(() => {
    if (!fit) return;
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setAvail(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = cols.find((c) => c.key === sort.key);
    if (!col) return rows;
    return [...rows].sort((a, b) => {
      const av = col.value(a), bv = col.value(b);
      const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
      return cmp * sort.dir;
    });
  }, [rows, cols, sort]);

  // First click on a NUMERIC column sorts descending (best-first, matching CardsPage);
  // text columns ascending. Clicking again toggles.
  const clickSort = (key: string) =>
    setSort((s) => {
      if (s && s.key === key) return { key, dir: (s.dir === 1 ? -1 : 1) as 1 | -1 };
      const col = cols.find((c) => c.key === key);
      const numeric = !!col && rows.length > 0 && typeof col.value(rows[0]!) === "number";
      return { key, dir: numeric ? -1 : 1 };
    });

  const cell: CSSProperties = { padding: "5px 6px", borderBottom: `1px solid ${C.border}`, fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
  // A user-resized column becomes fixed (protected) at its width.
  const effCols = useMemo(() => cols.map((c) => (widths[c.key] != null ? { ...c, width: widths[c.key], shrink: undefined } : c)), [cols, widths]);
  const anyW = effCols.some((c) => c.width != null);
  const allFixed = anyW && effCols.every((c) => c.width != null);
  const sumW = effCols.reduce((s, c) => s + (c.width ?? 0), 0);

  // Fit mode: compute per-column px from the measured container; table fills it.
  const fitW = fit && avail > 0 ? fitWidths(effCols, avail) : null;
  const tableLayout = fit || anyW ? "fixed" : "auto";
  const tableWidth = fitW ? fitW.reduce((a, b) => a + b, 0) : allFixed ? sumW : "100%";
  const colWidths = fitW ?? effCols.map((c) => c.width);
  // Fit tables never scroll — a user-resized column is treated as fixed and the rest re-fit
  // around it (fitWidths proportionally clamps if needed). Non-fit tables may scroll.
  const overflowX: CSSProperties["overflowX"] = fit ? "hidden" : "auto";

  const startResize = (key: string, startX: number, startW: number, minW: number) => {
    const onMove = (e: MouseEvent) => setWidths((m) => ({ ...m, [key]: Math.max(minW, Math.round(startW + (e.clientX - startX))) }));
    const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); document.body.style.cursor = ""; };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
  };

  return (
    <div ref={wrapRef} style={{ overflowX, overflowY: "auto", maxHeight: "74vh", width: "100%" }}>
      <table style={{ borderCollapse: "collapse", width: tableWidth, tableLayout, border: `1px solid ${C.border}` }}>
        {(fit || anyW) && <colgroup>{cols.map((c, i) => <col key={c.key} style={colWidths[i] != null ? { width: colWidths[i] } : undefined} />)}</colgroup>}
        <thead>
          <tr>
            {cols.map((c, i) => (
              <th key={c.key} onClick={() => clickSort(c.key)} title={c.title ?? c.label}
                style={{ ...cell, position: "sticky", top: 0, zIndex: 2, textAlign: ta(c.align), background: C.head, cursor: "pointer", userSelect: "none" }}>
                {c.label}{sort?.key === c.key ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
                {resizable && (
                  <span onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); startResize(c.key, e.clientX, colWidths[i] ?? c.width ?? 80, c.min ?? 32); }}
                    onClick={(e) => e.stopPropagation()} title="Drag to resize"
                    style={{ position: "absolute", top: 0, right: 0, width: 9, height: "100%", cursor: "col-resize", display: "flex", alignItems: "center", justifyContent: "flex-end" }}>
                    <span style={{ width: 2, height: "58%", background: C.sub, opacity: 0.55, borderRadius: 1 }} />
                  </span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={getKey(r)} style={rowStyle?.(r)}>
              {cols.map((c) => (
                <td key={c.key} style={{ ...cell, textAlign: ta(c.align) }}>{c.render ? c.render(r) : c.value(r)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
