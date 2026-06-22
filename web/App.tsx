import { useEffect, useMemo, useState } from "react";

interface Card {
  id: string; variant: string; title: string; first: string; last: string;
  bats: number; throws: number; value: number; owned: number;
  learn: Record<string, number>; eligible: boolean;
  stamina: number; pitches: number;
  hitVL: number; hitVR: number; hitOVR: number; basicHit: number; basicHitVL: number; basicHitVR: number;
  pitchVL: number; pitchVR: number; pitchOVR: number; basicPitch: number; basicPitchVL: number; basicPitchVR: number;
  def: Record<string, number>;
}
interface Meta { configName: string; tournament: string; cardCount: number; eligibleCount: number }

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
const haystack = (c: Card) => `${c.title} ${c.first} ${c.last} ${c.id}`.toLowerCase();

function defaultWidth(col: Col): number {
  if (col.key === "title") return 300;
  if (col.key.startsWith("pos")) return 40;
  if (col.key === "variant") return 50;
  if (col.key === "bats" || col.key === "throws") return 40;
  if (col.fmt === "woba") return 92;
  if (col.fmt === "basic") return 100;
  return 64;
}

// ── per-column filter (Sheets-style) ────────────────────────────────────────
type Op = "" | "eq" | "ne" | "gt" | "ge" | "lt" | "le" | "between" | "contains" | "ncontains";
interface ColFilter { op: Op; v1: string; v2: string; values: string[] } // values: selected display strings ([]=all)
const emptyFilter = (): ColFilter => ({ op: "", v1: "", v2: "", values: [] });
const filterActive = (f?: ColFilter) => !!f && (!!f.op || f.values.length > 0);
const NUM_OPS: [Op, string][] = [["", "(any)"], ["ge", "≥"], ["gt", ">"], ["le", "≤"], ["lt", "<"], ["eq", "="], ["ne", "≠"], ["between", "between"]];
const TXT_OPS: [Op, string][] = [["", "(any)"], ["contains", "contains"], ["ncontains", "doesn't contain"], ["eq", "is"], ["ne", "is not"]];

function passesFilter(col: Col, c: Card, f: ColFilter): boolean {
  if (f.values.length && !f.values.includes(fmtVal(col, c))) return false;
  if (!f.op) return true;
  if (isNumeric(col)) {
    const raw = Number(col.get(c)); const x = parseFloat(f.v1); const y = parseFloat(f.v2);
    switch (f.op) {
      case "eq": return raw === x; case "ne": return raw !== x;
      case "gt": return raw > x; case "ge": return raw >= x;
      case "lt": return raw < x; case "le": return raw <= x;
      case "between": return raw >= Math.min(x, y) && raw <= Math.max(x, y);
      default: return true;
    }
  }
  const s = fmtVal(col, c).toLowerCase(); const q = (f.v1 || "").toLowerCase();
  switch (f.op) {
    case "contains": return s.includes(q); case "ncontains": return !s.includes(q);
    case "eq": return s === q; case "ne": return s !== q; default: return true;
  }
}

const C = {
  bg: "#1e2228", text: "#d7dbe0", sub: "#9aa3ad", border: "#3a414b",
  head: "#2a2f37", headActive: "#3b4657", stripe: "#23282f", row: "#1e2228",
  input: "#2a2f37", hot: "#4a4326", accent: "#2563eb", star: "#b06bf0", panel: "#2a2f37",
};

export function App() {
  const [cards, setCards] = useState<Card[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [err, setErr] = useState<string | null>(null);
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

  useEffect(() => {
    Promise.all([fetch("/api/meta").then((r) => r.json()), fetch("/api/cards").then((r) => r.json())])
      .then(([m, c]) => { setMeta(m); setCards(c); }).catch((e) => setErr(String(e)));
  }, []);

  const choosePreset = (name: keyof typeof PRESETS) => { setPreset(name); setSortKey(PRESETS[name].sort); setSortDir(PRESETS[name].dir); };
  const cols = PRESETS[preset].cols.map((k) => COLS[k]!);
  const sortCol = COLS[sortKey] ?? COLS.title!;
  const w = (k: string) => widths[k] ?? defaultWidth(COLS[k]!);
  const getF = (k: string) => colF[k] ?? emptyFilter();
  const setF = (k: string, patch: Partial<ColFilter>) => setColF((m) => ({ ...m, [k]: { ...getF(k), ...patch } }));

  // distinct display values per column (for the checkbox list), capped.
  const distinct = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const col of cols) {
      const set = new Set<string>();
      for (const c of cards) { set.add(fmtVal(col, c)); if (set.size > 40) break; }
      out[col.key] = set.size <= 40 ? [...set].sort((a, b) => (isNumeric(col) ? Number(a) - Number(b) : a.localeCompare(b))) : [];
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
    setAnchor({ x: Math.min(r.left, window.innerWidth - 280), y: r.bottom + 2 }); setOpenF(key);
  };

  const inputStyle: React.CSSProperties = { background: C.input, color: C.text, border: `1px solid ${C.border}`, borderRadius: 4, padding: "6px 8px", fontSize: 13 };
  const ta = (a: Align) => (a === "r" ? "right" : a === "c" ? "center" : "left");
  const fcol = openF ? COLS[openF]! : null;
  const ff = openF ? getF(openF) : emptyFilter();
  const ops = fcol && isNumeric(fcol) ? NUM_OPS : TXT_OPS;

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: 16, color: C.text, background: C.bg, minHeight: "100vh" }}>
      <h2 style={{ margin: "0 0 4px" }}>OOTP Optimizer — Data Grid</h2>
      {err && <p style={{ color: "#f87171" }}>Failed to load: {err} — is the server running?</p>}
      {meta && (
        <p style={{ margin: "0 0 12px", color: C.sub, fontSize: 13 }}>
          Tournament: <b style={{ color: C.text }}>{meta.tournament}</b> · Config: <b style={{ color: C.text }}>{meta.configName}</b> · {meta.cardCount} cards
          ({meta.eligibleCount} eligible). Pitch wOBA: lower = better.
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
        <span style={{ color: C.sub, fontSize: 13 }}>{rows.length} shown · click ▾ to filter · drag edges to resize</span>
      </div>

      <div style={{ overflow: "auto", border: `1px solid ${C.border}`, maxHeight: "74vh" }}>
        <table style={{ borderCollapse: "collapse", fontSize: 13, tableLayout: "fixed", width: "max-content" }}>
          <colgroup>{cols.map((c) => <col key={c.key} style={{ width: w(c.key) }} />)}</colgroup>
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c.key} onClick={() => sortBy(c.key)}
                  style={{ textAlign: ta(c.align), padding: "6px 16px 6px 8px", borderBottom: `2px solid ${C.border}`, cursor: "pointer",
                    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", position: "sticky", top: 0,
                    background: sortKey === c.key ? C.headActive : C.head, userSelect: "none" }}>
                  {c.label}{sortKey === c.key ? (sortDir === 1 ? " ▲" : " ▼") : ""}
                  <span onClick={(e) => openFilter(c.key, e)} title="Filter"
                    style={{ position: "absolute", right: 8, top: 5, cursor: "pointer", fontSize: 11, color: filterActive(colF[c.key]) ? "#facc15" : C.sub }}>▾</span>
                  <span onMouseDown={(e) => startResize(c.key, e)} onClick={(e) => e.stopPropagation()}
                    style={{ position: "absolute", right: 0, top: 0, height: "100%", width: 6, cursor: "col-resize" }} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 1000).map((c, i) => {
              const hot = hq && haystack(c).includes(hq);
              return (
                <tr key={c.id + ":" + c.variant + ":" + i} style={{ background: hot ? C.hot : i % 2 ? C.stripe : C.row }}>
                  {cols.map((col) => (
                    <td key={col.key} title={col.key === "title" ? c.title : undefined}
                      style={{ textAlign: ta(col.align), padding: "4px 8px", borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
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
          <div style={{ position: "fixed", left: anchor.x, top: anchor.y, zIndex: 100, width: 260, background: C.panel, border: `1px solid ${C.border}`, borderRadius: 6, padding: 12, boxShadow: "0 8px 24px rgba(0,0,0,.5)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
              <b>Filter: {fcol.label}</b>
              <span onClick={() => setOpenF(null)} style={{ cursor: "pointer", color: C.sub }}>✕</span>
            </div>
            <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
              <select value={ff.op} onChange={(e) => setF(fcol.key, { op: e.target.value as Op })} style={{ ...inputStyle, flex: 1 }}>
                {ops.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
              {ff.op && ff.op !== "" && (
                <input value={ff.v1} placeholder={isNumeric(fcol) ? "value" : "text"} onChange={(e) => setF(fcol.key, { v1: e.target.value })} style={{ ...inputStyle, width: 70 }} />
              )}
              {ff.op === "between" && (
                <input value={ff.v2} placeholder="to" onChange={(e) => setF(fcol.key, { v2: e.target.value })} style={{ ...inputStyle, width: 70 }} />
              )}
            </div>
            {distinct[fcol.key]!.length > 0 && (
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: C.sub, marginBottom: 4 }}>
                  <span>Values</span>
                  <span>
                    <a onClick={() => setF(fcol.key, { values: [] })} style={{ cursor: "pointer", marginRight: 8 }}>all</a>
                    <a onClick={() => setF(fcol.key, { values: [...distinct[fcol.key]!] })} style={{ cursor: "pointer" }}>none-but…</a>
                  </span>
                </div>
                <div style={{ maxHeight: 180, overflow: "auto", border: `1px solid ${C.border}`, borderRadius: 4, padding: 4 }}>
                  {distinct[fcol.key]!.map((val) => {
                    const checked = ff.values.length === 0 || ff.values.includes(val);
                    return (
                      <label key={val} style={{ display: "block", fontSize: 13, padding: "1px 2px" }}>
                        <input type="checkbox" checked={checked} onChange={(e) => {
                          const all = distinct[fcol.key]!;
                          const cur = ff.values.length === 0 ? new Set(all) : new Set(ff.values);
                          if (e.target.checked) cur.add(val); else cur.delete(val);
                          const arr = [...cur];
                          setF(fcol.key, { values: arr.length === all.length ? [] : arr });
                        }} /> {val === "" ? "(blank)" : val}
                      </label>
                    );
                  })}
                </div>
              </div>
            )}
            <div style={{ marginTop: 8, textAlign: "right" }}>
              <button onClick={() => { setColF((m) => ({ ...m, [fcol.key]: emptyFilter() })); }} style={{ ...inputStyle, cursor: "pointer" }}>Clear</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
