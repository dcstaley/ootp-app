// Reusable sortable table. Columns declare a sort `value` (number|string) and an
// optional custom `render`. Click a header to sort (toggles asc/desc); an optional
// `initialSort` sets the default. Used across the roster-page tabs.

import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { C } from "./shared.ts";

export type Align = "l" | "r" | "c";
export interface Column<T> {
  key: string;
  label: string;
  align?: Align;
  width?: number;                            // px; if any col sets it → fixed layout (lets tables align)
  value: (row: T) => string | number;       // sort key + default cell text
  render?: (row: T) => ReactNode;            // custom cell (falls back to value())
  title?: string;                            // header tooltip
}

const ta = (a?: Align) => (a === "r" ? "right" : a === "c" ? "center" : "left");

export function DataTable<T>({ rows, cols, getKey, initialSort, rowStyle }: {
  rows: T[];
  cols: Column<T>[];
  getKey: (row: T) => string;
  initialSort?: { key: string; dir: 1 | -1 };
  rowStyle?: (row: T) => CSSProperties;
}) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(initialSort ?? null);

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
  const fixed = cols.some((c) => c.width != null);
  // When EVERY column has an explicit width, size the table to their sum so two
  // such tables render identical column positions (alignment); otherwise stretch.
  const allFixed = fixed && cols.every((c) => c.width != null);
  const sumW = cols.reduce((s, c) => s + (c.width ?? 0), 0);

  // overflow-x wrapper so a too-wide table scrolls within its container instead of
  // overflowing onto neighbouring content.
  return (
    <div style={{ overflowX: "auto", width: "100%" }}>
      <table style={{ borderCollapse: "collapse", width: allFixed ? sumW : "100%", tableLayout: fixed ? "fixed" : "auto", border: `1px solid ${C.border}` }}>
        {fixed && <colgroup>{cols.map((c) => <col key={c.key} style={c.width != null ? { width: c.width } : undefined} />)}</colgroup>}
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c.key} onClick={() => clickSort(c.key)} title={c.title}
                style={{ ...cell, textAlign: ta(c.align), background: sort?.key === c.key ? C.headActive : C.head, cursor: "pointer", userSelect: "none" }}>
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
