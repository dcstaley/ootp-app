// Cards — the data grid. First UI consumer of the one scoring core; it never
// scores, it reads the (tournament, account) view from the shared state. Global
// Tournament/Account selectors live in the sidebar; this page owns view state
// (preset, sort, filters, column widths, search/highlight).

import { useMemo, useState } from "react";
import { useAppData } from "./state.tsx";
import { C, inputStyle, haystack, type Card } from "./shared.ts";

const BATS: Record<number, string> = { 1: "R", 2: "L", 3: "S" };
const THROWS: Record<number, string> = { 1: "R", 2: "L" };

type Align = "l" | "r" | "c";
type Fmt = "woba" | "basic" | "int";
interface Col { key: string; label: string; align: Align; get: (c: Card) => string | number; sort?: (c: Card) => string | number; fmt?: Fmt }

const def = (k: string) => (c: Card) => c.def?.[k] ?? 0;
const COLS: Record<string, Col> = {
  id: { key: "id", label: "Card ID", align: "l", get: (c) => c.id },
  variant: { key: "variant", label: "Var", align: "c", get: (c) => c.variant },
  title: { key: "title", label: "Card", align: "l", get: (c) => c.title, sort: (c) => `${c.last} ${c.first}`.toLowerCase() },
  bats: { key: "bats", label: "B", align: "c", get: (c) => BATS[c.bats] ?? "", sort: (c) => c.bats },
  throws: { key: "throws", label: "T", align: "c", get: (c) => THROWS[c.throws] ?? "", sort: (c) => c.throws },
  value: { key: "value", label: "Val", align: "r", get: (c) => c.value, fmt: "int" },
  owned: { key: "owned", label: "Own", align: "r", get: (c) => c.owned, fmt: "int" },
  hitOVR: { key: "hitOVR", label: "Hit wOBA", align: "r", get: (c) => c.hitOVR, fmt: "woba" },
  hitVL: { key: "hitVL", label: "Hit vL", align: "r", get: (c) => c.hitVL, fmt: "woba" },
  hitVR: { key: "hitVR", label: "Hit vR", align: "r", get: (c) => c.hitVR, fmt: "woba" },
  basicHit: { key: "basicHit", label: "Basic Hit", align: "r", get: (c) => c.basicHit, fmt: "basic" },
  basicHitVL: { key: "basicHitVL", label: "Basic Hit vL", align: "r", get: (c) => c.basicHitVL, fmt: "basic" },
  basicHitVR: { key: "basicHitVR", label: "Basic Hit vR", align: "r", get: (c) => c.basicHitVR, fmt: "basic" },
  pitchOVR: { key: "pitchOVR", label: "Pitch wOBA", align: "r", get: (c) => c.pitchOVR, fmt: "woba" },
  pitchVL: { key: "pitchVL", label: "Pitch vL", align: "r", get: (c) => c.pitchVL, fmt: "woba" },
  pitchVR: { key: "pitchVR", label: "Pitch vR", align: "r", get: (c) => c.pitchVR, fmt: "woba" },
  basicPitch: { key: "basicPitch", label: "Basic Pitch", align: "r", get: (c) => c.basicPitch, fmt: "basic" },
  basicPitchVL: { key: "basicPitchVL", label: "Basic Pitch vL", align: "r", get: (c) => c.basicPitchVL, fmt: "basic" },
  basicPitchVR: { key: "basicPitchVR", label: "Basic Pitch vR", align: "r", get: (c) => c.basicPitchVR, fmt: "basic" },
  stamina: { key: "stamina", label: "Stam", align: "r", get: (c) => c.stamina, fmt: "int" },
  pitches: { key: "pitches", label: "# Pit", align: "r", get: (c) => c.pitches, fmt: "int" },
  ifR: { key: "ifR", label: "IF Rng", align: "r", get: def("Infield Range"), fmt: "int" },
  ifE: { key: "ifE", label: "IF Err", align: "r", get: def("Infield Error"), fmt: "int" },
  ifA: { key: "ifA", label: "IF Arm", align: "r", get: def("Infield Arm"), fmt: "int" },
  dp: { key: "dp", label: "DP", align: "r", get: def("DP"), fmt: "int" },
  cAb: { key: "cAb", label: "C Abil", align: "r", get: def("CatcherAbil"), fmt: "int" },
  cFr: { key: "cFr", label: "C Frm", align: "r", get: def("CatcherFrame"), fmt: "int" },
  cAr: { key: "cAr", label: "C Arm", align: "r", get: def("Catcher Arm"), fmt: "int" },
  ofR: { key: "ofR", label: "OF Rng", align: "r", get: def("OF Range"), fmt: "int" },
  ofE: { key: "ofE", label: "OF Err", align: "r", get: def("OF Error"), fmt: "int" },
  ofA: { key: "ofA", label: "OF Arm", align: "r", get: def("OF Arm"), fmt: "int" },
};

const POSNS = ["C", "1B", "2B", "3B", "SS", "LF", "CF", "RF"];
const FIELD_POS = POSNS.map((p) => "pos" + p);
for (const p of POSNS) {
  COLS["pos" + p] = { key: "pos" + p, label: p, align: "c", get: (c) => c.learn?.[p] ?? 0, sort: (c) => c.learn?.[p] ?? 0, fmt: "int" };
}

const DEF = ["ifR", "ifE", "ifA", "dp", "cAb", "cFr", "cAr", "ofR", "ofE", "ofA"];
const PRESETS: Record<string, { cols: string[]; sort: string; dir: 1 | -1 }> = {
  Hitting: { cols: ["title", "variant", "bats", "value", "owned", "hitOVR", "hitVL", "hitVR", "basicHit", "basicHitVL", "basicHitVR", ...FIELD_POS, ...DEF], sort: "hitOVR", dir: -1 },
  Pitching: { cols: ["title", "variant", "throws", "value", "owned", "pitchOVR", "pitchVL", "pitchVR", "basicPitch", "basicPitchVL", "basicPitchVR", "stamina", "pitches"], sort: "pitchOVR", dir: 1 },
};

const isNumeric = (col: Col) => !!col.fmt;
const sortVal = (col: Col, c: Card) => (col.sort ? col.sort(c) : col.get(c));
const fmtVal = (col: Col, c: Card): string => {
  const v = col.get(c);
  if (col.fmt === "woba") return Number.isFinite(v as number) ? (v as number).toFixed(4) : "";
  if (col.fmt === "basic") return Number.isFinite(v as number) ? (v as number).toFixed(1) : "";
  return String(v ?? "");
};

function defaultWidth(col: Col): number {
  if (col.key === "title") return 300;
  if (col.key.startsWith("pos")) return 40;
  if (col.key === "variant") return 50;
  if (col.key === "bats" || col.key === "throws") return 40;
  if (col.fmt === "woba") return 92;
  if (col.fmt === "basic") return 100;
  return 64;
}

// ── per-column filter (Sheets-style: condition + values) ─────────────────────
type Op = "" | "empty" | "nempty" | "contains" | "ncontains" | "starts" | "ends" | "exact"
  | "gt" | "ge" | "lt" | "le" | "eq" | "ne" | "between" | "nbetween";
interface ColFilter { op: Op; v1: string; v2: string; values: string[] | null } // values null = all
const emptyFilter = (): ColFilter => ({ op: "", v1: "", v2: "", values: null });
const filterActive = (f?: ColFilter) => !!f && (!!f.op || f.values !== null);
const TXT_CONDS: [Op, string][] = [["contains", "Text contains"], ["ncontains", "Text does not contain"], ["starts", "Text starts with"], ["ends", "Text ends with"], ["exact", "Text is exactly"]];
const NUM_CONDS: [Op, string][] = [["gt", "Greater than"], ["ge", "Greater than or equal to"], ["lt", "Less than"], ["le", "Less than or equal to"], ["eq", "Is equal to"], ["ne", "Is not equal to"], ["between", "Is between"], ["nbetween", "Is not between"]];
const needsV1 = (op: Op) => !["", "empty", "nempty"].includes(op);
const needsV2 = (op: Op) => op === "between" || op === "nbetween";

function passesCond(col: Col, c: Card, f: ColFilter): boolean {
  if (!f.op) return true;
  const disp = fmtVal(col, c);
  if (f.op === "empty") return disp.trim() === "";
  if (f.op === "nempty") return disp.trim() !== "";
  if (!isNumeric(col)) {
    const s = disp.toLowerCase(), q = f.v1.toLowerCase();
    switch (f.op) {
      case "contains": return s.includes(q); case "ncontains": return !s.includes(q);
      case "starts": return s.startsWith(q); case "ends": return s.endsWith(q);
      case "exact": return s === q; default: return true;
    }
  }
  const raw = Number(col.get(c)), x = parseFloat(f.v1), y = parseFloat(f.v2);
  const inRange = raw >= Math.min(x, y) && raw <= Math.max(x, y);
  switch (f.op) {
    case "gt": return raw > x; case "ge": return raw >= x; case "lt": return raw < x; case "le": return raw <= x;
    case "eq": return raw === x; case "ne": return raw !== x;
    case "between": return inRange; case "nbetween": return !inRange; default: return true;
  }
}
const passesFilter = (col: Col, c: Card, f: ColFilter) =>
  (f.values === null || f.values.includes(fmtVal(col, c))) && passesCond(col, c, f);

function Funnel({ active }: { active: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden style={{ display: "block" }}>
      <path d="M1.5 2.5h13l-5 6v4.2l-3 1.6V8.5z" fill={active ? "#facc15" : C.sub} stroke={active ? "#facc15" : C.sub} strokeWidth="0.5" strokeLinejoin="round" />
    </svg>
  );
}

export function CardsPage() {
  const { cards, meta, loading, rosterMemberIds } = useAppData();
  const [preset, setPreset] = useState<keyof typeof PRESETS>("Hitting");
  const [filter, setFilter] = useState("");
  const [highlight, setHighlight] = useState("");
  const [ownedOnly, setOwnedOnly] = useState(false);
  const [eligibleOnly, setEligibleOnly] = useState(false);
  const [sortKey, setSortKey] = useState("hitOVR");
  const [sortDir, setSortDir] = useState<1 | -1>(-1);
  const [colF, setColF] = useState<Record<string, ColFilter>>({});
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [openF, setOpenF] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [valSearch, setValSearch] = useState("");

  const choosePreset = (name: keyof typeof PRESETS) => { setPreset(name); setSortKey(PRESETS[name].sort); setSortDir(PRESETS[name].dir); };
  const cols = PRESETS[preset].cols.map((k) => COLS[k]!);
  const sortCol = COLS[sortKey] ?? COLS.title!;
  const w = (k: string) => widths[k] ?? defaultWidth(COLS[k]!);
  const getF = (k: string) => colF[k] ?? emptyFilter();
  const setF = (k: string, patch: Partial<ColFilter>) => setColF((m) => ({ ...m, [k]: { ...getF(k), ...patch } }));

  const distinct = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const col of cols) {
      const set = new Set<string>();
      let over = false;
      for (const c of cards) { set.add(fmtVal(col, c)); if (set.size > 200) { over = true; break; } }
      out[col.key] = over ? [] : [...set].sort((a, b) => (isNumeric(col) ? Number(a) - Number(b) : a.localeCompare(b)));
    }
    return out;
  }, [cards, cols]);

  const rows = useMemo(() => {
    const fq = filter.trim().toLowerCase();
    let r = cards;
    if (fq) r = r.filter((c) => haystack(c).includes(fq));
    if (ownedOnly) r = r.filter((c) => c.owned > 0);
    if (eligibleOnly) r = r.filter((c) => c.eligible);
    const active = cols.filter((col) => filterActive(colF[col.key]));
    if (active.length) r = r.filter((c) => active.every((col) => passesFilter(col, c, colF[col.key]!)));
    return [...r].sort((a, b) => {
      const av = sortVal(sortCol, a), bv = sortVal(sortCol, b);
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * sortDir;
      return String(av).localeCompare(String(bv)) * sortDir;
    });
  }, [cards, filter, ownedOnly, eligibleOnly, sortCol, sortDir, cols, colF]);

  const hq = highlight.trim().toLowerCase();
  const sortBy = (key: string) => {
    if (key === sortKey) setSortDir((d) => (d === 1 ? -1 : 1));
    else { setSortKey(key); setSortDir(COLS[key]?.fmt ? -1 : 1); }
  };
  const startResize = (key: string, e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    const startX = e.clientX, startW = w(key);
    const move = (ev: MouseEvent) => setWidths((m) => ({ ...m, [key]: Math.max(28, startW + (ev.clientX - startX)) }));
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  };
  const openFilter = (key: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setAnchor({ x: Math.min(r.left - 20, window.innerWidth - 290), y: r.bottom + 4 });
    setValSearch(""); setOpenF(key);
  };
  const ta = (a: Align) => (a === "r" ? "right" : a === "c" ? "center" : "left");

  const fcol = openF ? COLS[openF]! : null;
  const ff = openF ? getF(openF) : emptyFilter();
  const condList = fcol && isNumeric(fcol) ? NUM_CONDS : TXT_CONDS;
  const allVals = fcol ? (distinct[fcol.key] ?? []) : [];
  const shownVals = allVals.filter((v) => v.toLowerCase().includes(valSearch.toLowerCase()));
  const isChecked = (v: string) => ff.values === null || ff.values.includes(v);
  const toggleVal = (v: string, on: boolean) => {
    if (!fcol) return;
    const base = ff.values === null ? new Set(allVals) : new Set(ff.values);
    if (on) base.add(v); else base.delete(v);
    setF(fcol.key, { values: base.size === allVals.length ? null : [...base] });
  };
  const link = { color: C.link, cursor: "pointer", fontSize: 12 } as React.CSSProperties;

  return (
    <div>
      <h2 style={{ margin: "0 0 4px" }}>Cards</h2>
      {meta && (
        <p style={{ margin: "0 0 12px", color: C.sub, fontSize: 13 }}>
          {meta.cardCount} cards ({meta.eligibleCount} eligible) · {meta.ownedCount} owned by <b style={{ color: C.text }}>{meta.account}</b>
          {" "}· Catalog: {meta.catalogSource}{loading ? " · scoring…" : ""}. Pitch wOBA: lower = better.
        </p>
      )}

      <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
        {(Object.keys(PRESETS) as (keyof typeof PRESETS)[]).map((p) => (
          <button key={p} onClick={() => choosePreset(p)} style={{ ...inputStyle, cursor: "pointer", background: preset === p ? C.accent : C.input, color: "#fff", fontWeight: preset === p ? 600 : 400 }}>{p}</button>
        ))}
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
        <input placeholder="Search: hide non-matches…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ ...inputStyle, width: 230 }} />
        <input placeholder="Highlight (keep all)…" value={highlight} onChange={(e) => setHighlight(e.target.value)} style={{ ...inputStyle, width: 200 }} />
        <label style={{ fontSize: 13 }}><input type="checkbox" checked={eligibleOnly} onChange={(e) => setEligibleOnly(e.target.checked)} /> Eligible only</label>
        <label style={{ fontSize: 13 }}><input type="checkbox" checked={ownedOnly} onChange={(e) => setOwnedOnly(e.target.checked)} /> Owned only</label>
        {Object.values(colF).some(filterActive) && <button onClick={() => setColF({})} style={{ ...inputStyle, cursor: "pointer" }}>Clear all filters</button>}
        <span style={{ color: C.sub, fontSize: 13 }}>{rows.length} shown · ⏷ funnel = filter · drag edges to resize</span>
      </div>

      <div style={{ overflow: "auto", border: `1px solid ${C.border}`, maxHeight: "74vh" }}>
        <table style={{ borderCollapse: "collapse", fontSize: 13, tableLayout: "fixed", width: "max-content" }}>
          <colgroup>{cols.map((c) => <col key={c.key} style={{ width: w(c.key) }} />)}</colgroup>
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c.key} onClick={() => sortBy(c.key)}
                  style={{ textAlign: ta(c.align), padding: "7px 24px 7px 8px", borderBottom: `2px solid ${C.border}`, cursor: "pointer",
                    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", position: "sticky", top: 0,
                    background: sortKey === c.key ? C.headActive : C.head, userSelect: "none" }}>
                  {c.label}{sortKey === c.key ? (sortDir === 1 ? " ▲" : " ▼") : ""}
                  <span onClick={(e) => openFilter(c.key, e)} title="Filter"
                    style={{ position: "absolute", right: 7, top: 0, height: "100%", display: "flex", alignItems: "center", padding: "0 3px", cursor: "pointer",
                      background: filterActive(colF[c.key]) ? "rgba(250,204,21,.12)" : "transparent", borderRadius: 3 }}>
                    <Funnel active={filterActive(colF[c.key])} />
                  </span>
                  <span onMouseDown={(e) => startResize(c.key, e)} onClick={(e) => e.stopPropagation()}
                    style={{ position: "absolute", right: 0, top: 0, height: "100%", width: 5, cursor: "col-resize" }} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 1000).map((c, i) => {
              const hot = hq && haystack(c).includes(hq);
              const onRoster = rosterMemberIds.has(c.id);
              return (
                <tr key={c.id + ":" + c.variant + ":" + i} title={onRoster ? "On the generated roster" : undefined}
                  style={{ background: hot ? C.hot : onRoster ? "#243524" : i % 2 ? C.stripe : C.row }}>
                  {cols.map((col, ci) => (
                    <td key={col.key} title={col.key === "title" ? c.title : undefined}
                      style={{ textAlign: ta(col.align), padding: "4px 8px", borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                        borderLeft: ci === 0 && onRoster ? `3px solid #4ade80` : undefined }}>
                      {col.key === "title" && c.title.startsWith("★")
                        ? <><span style={{ color: C.star }}>★</span>{c.title.slice(1)}</>
                        : fmtVal(col, c)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length > 1000 && <p style={{ color: C.sub, fontSize: 12 }}>Showing first 1000 of {rows.length}.</p>}

      {fcol && (
        <>
          <div onClick={() => setOpenF(null)} style={{ position: "fixed", inset: 0, zIndex: 90 }} />
          <div style={{ position: "fixed", left: anchor.x, top: anchor.y, zIndex: 100, width: 270, maxHeight: "70vh", overflow: "auto", background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, padding: 12, boxShadow: "0 10px 30px rgba(0,0,0,.55)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
              <b>Filter · {fcol.label}</b>
              <span onClick={() => setOpenF(null)} style={{ cursor: "pointer", color: C.sub }}>✕</span>
            </div>

            <div style={{ fontSize: 12, color: C.sub, marginBottom: 4 }}>Filter by condition</div>
            <select value={ff.op} onChange={(e) => setF(fcol.key, { op: e.target.value as Op })} style={{ ...inputStyle, width: "100%" }}>
              <option value="">None</option>
              <optgroup label={isNumeric(fcol) ? "Number" : "Text"}>
                {condList.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </optgroup>
            </select>
            {needsV1(ff.op) && (
              <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                <input value={ff.v1} placeholder={isNumeric(fcol) ? "value" : "text"} onChange={(e) => setF(fcol.key, { v1: e.target.value })} style={{ ...inputStyle, flex: 1 }} />
                {needsV2(ff.op) && <input value={ff.v2} placeholder="and" onChange={(e) => setF(fcol.key, { v2: e.target.value })} style={{ ...inputStyle, flex: 1 }} />}
              </div>
            )}

            {allVals.length > 0 ? (
              <div style={{ marginTop: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                  <span style={{ fontSize: 12, color: C.sub }}>Filter by values</span>
                  <span><a style={link} onClick={() => setF(fcol.key, { values: null })}>Select all</a> · <a style={link} onClick={() => setF(fcol.key, { values: [] })}>Clear</a></span>
                </div>
                <input value={valSearch} onChange={(e) => setValSearch(e.target.value)} placeholder="Search values…" style={{ ...inputStyle, width: "100%", marginBottom: 6 }} />
                <div style={{ fontSize: 11, color: C.sub, marginBottom: 4 }}>Displaying {shownVals.length} of {allVals.length}</div>
                <div style={{ maxHeight: 200, overflow: "auto", border: `1px solid ${C.border}`, borderRadius: 4, padding: 4 }}>
                  {shownVals.map((v) => (
                    <label key={v} style={{ display: "block", fontSize: 13, padding: "2px 2px", whiteSpace: "nowrap" }}>
                      <input type="checkbox" checked={isChecked(v)} onChange={(e) => toggleVal(v, e.target.checked)} /> {v === "" ? "(Blanks)" : v}
                    </label>
                  ))}
                </div>
              </div>
            ) : (
              <div style={{ marginTop: 10, fontSize: 12, color: C.sub }}>Too many distinct values to list — use a condition above.</div>
            )}

            <div style={{ marginTop: 12, textAlign: "right" }}>
              <button onClick={() => setColF((m) => ({ ...m, [fcol.key]: emptyFilter() }))} style={{ ...inputStyle, cursor: "pointer", marginRight: 6 }}>Clear</button>
              <button onClick={() => setOpenF(null)} style={{ ...inputStyle, cursor: "pointer", background: C.accent, color: "#fff" }}>Done</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
