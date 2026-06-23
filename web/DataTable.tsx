// Reusable sortable table. Columns declare a sort `value` (number|string) and an
// optional custom `render`. Click a header to sort (toggles asc/desc); an optional
// `initialSort` sets the default. Used across the roster-page tabs.
//
// `fit` mode: the table always fits its container (never scrolls). Columns marked
// shrinkable (`shrink` = priority, lower shrinks first; `min` = floor) absorb the
// squeeze in priority order; protected columns keep their `width`. Spare space goes
// to the last-to-shrink column.

import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { C } from "./shared.ts";

export type Align = "l" | "r" | "c";
export interface Column<T> {
  key: string;
  label: string;
  align?: Align;
  width?: number;                            // px; if any col sets it → fixed layout (lets tables align)
  min?: number;                              // fit mode: minimum px before clipping
  shrink?: number;                           // fit mode: shrink priority (lower = shrink first); absent = protected
  value: (row: T) => string | number;       // sort key + default cell text
  render?: (row: T) => ReactNode;            // custom cell (falls back to value())
  title?: string;                            // header tooltip
}

const ta = (a?: Align) => (a === "r" ? "right" : a === "c" ? "center" : "left");

/** Fit shrinkable columns into `avail` px by priority; grow the last to fill spare. */
function fitWidths<T>(cols: Column<T>[], avail: number): number[] {
  const res = cols.map((c) => c.width ?? 80);
  const total = res.reduce((a, b) => a + b, 0);
  const shrinkable = cols.map((c, i) => ({ i, order: c.shrink, min: c.min ?? c.width ?? 80 }))
    .filter((x) => x.order != null) as { i: number; order: number; min: number }[];
  if (total > avail) {
    let over = total - avail;
    for (const s of [...shrinkable].sort((a, b) => a.order - b.order)) {
      if (over <= 0) break;
      const take = Math.min(res[s.i]! - s.min, over);
      res[s.i]! -= take; over -= take;
    }
  } else if (total < avail && shrinkable.length) {
    const grow = [...shrinkable].sort((a, b) => b.order - a.order)[0]!;
    res[grow.i]! += avail - total;
  }
  return res;
}

export function DataTable<T>({ rows, cols, getKey, initialSort, rowStyle, fit }: {
  rows: T[];
  cols: Column<T>[];
  getKey: (row: T) => string;
  initialSort?: { key: string; dir: 1 | -1 };
  rowStyle?: (row: T) => CSSProperties;
  fit?: boolean;
}) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(initialSort ?? null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState(0);

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

  const clickSort = (key: string) =>
    setSort((s) => (s && s.key === key ? { key, dir: (s.dir === 1 ? -1 : 1) as 1 | -1 } : { key, dir: 1 }));

  const cell: CSSProperties = { padding: "5px 9px", borderBottom: `1px solid ${C.border}`, fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
  const anyW = cols.some((c) => c.width != null);
  const allFixed = anyW && cols.every((c) => c.width != null);
  const sumW = cols.reduce((s, c) => s + (c.width ?? 0), 0);

  // Fit mode: compute per-column px from the measured container; table fills it.
  const fitW = fit && avail > 0 ? fitWidths(cols, avail) : null;
  const tableLayout = fit || anyW ? "fixed" : "auto";
  const tableWidth = fitW ? fitW.reduce((a, b) => a + b, 0) : allFixed ? sumW : "100%";
  const colWidths = fitW ?? cols.map((c) => c.width);

  return (
    <div ref={wrapRef} style={{ overflowX: fit ? "hidden" : "auto", width: "100%" }}>
      <table style={{ borderCollapse: "collapse", width: tableWidth, tableLayout, border: `1px solid ${C.border}` }}>
        {(fit || anyW) && <colgroup>{cols.map((c, i) => <col key={c.key} style={colWidths[i] != null ? { width: colWidths[i] } : undefined} />)}</colgroup>}
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c.key} onClick={() => clickSort(c.key)} title={c.title ?? c.label}
                style={{ ...cell, textAlign: ta(c.align), background: C.head, cursor: "pointer", userSelect: "none" }}>
                {c.label}{sort?.key === c.key ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
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
