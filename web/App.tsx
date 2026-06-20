import { useEffect, useMemo, useState } from "react";

interface Card {
  id: string; variant: string; title: string; first: string; last: string;
  bats: number; throws: number; value: number; owned: number;
  positions: string; eligible: boolean;
  hitVL: number; hitVR: number; hitOVR: number; basicHit: number;
  pitchVL: number; pitchVR: number; pitchOVR: number; basicPitch: number;
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
  title: { key: "title", label: "Card", align: "l", get: (c) => c.title, sort: (c) => `${c.first} ${c.last}`.toLowerCase() },
  positions: { key: "positions", label: "Positions", align: "l", get: (c) => c.positions },
  bats: { key: "bats", label: "B", align: "c", get: (c) => BATS[c.bats] ?? "", sort: (c) => c.bats },
  throws: { key: "throws", label: "T", align: "c", get: (c) => THROWS[c.throws] ?? "", sort: (c) => c.throws },
  value: { key: "value", label: "Val", align: "r", get: (c) => c.value, fmt: "int" },
  owned: { key: "owned", label: "Own", align: "r", get: (c) => c.owned, fmt: "int" },
  hitOVR: { key: "hitOVR", label: "Hit wOBA", align: "r", get: (c) => c.hitOVR, fmt: "woba" },
  hitVL: { key: "hitVL", label: "Hit vL", align: "r", get: (c) => c.hitVL, fmt: "woba" },
  hitVR: { key: "hitVR", label: "Hit vR", align: "r", get: (c) => c.hitVR, fmt: "woba" },
  basicHit: { key: "basicHit", label: "Basic Hit", align: "r", get: (c) => c.basicHit, fmt: "basic" },
  pitchOVR: { key: "pitchOVR", label: "Pitch wOBA", align: "r", get: (c) => c.pitchOVR, fmt: "woba" },
  pitchVL: { key: "pitchVL", label: "Pitch vL", align: "r", get: (c) => c.pitchVL, fmt: "woba" },
  pitchVR: { key: "pitchVR", label: "Pitch vR", align: "r", get: (c) => c.pitchVR, fmt: "woba" },
  basicPitch: { key: "basicPitch", label: "Basic Pitch", align: "r", get: (c) => c.basicPitch, fmt: "basic" },
  spd: { key: "spd", label: "Spd", align: "r", get: def("Speed"), fmt: "int" },
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

const PRESETS: Record<string, { cols: string[]; sort: string; dir: 1 | -1 }> = {
  Hitting: { cols: ["title", "variant", "positions", "bats", "value", "owned", "hitOVR", "hitVL", "hitVR", "basicHit"], sort: "hitOVR", dir: -1 },
  Pitching: { cols: ["title", "variant", "positions", "throws", "value", "owned", "pitchOVR", "pitchVL", "pitchVR", "basicPitch"], sort: "pitchOVR", dir: 1 },
  Defense: { cols: ["title", "variant", "positions", "value", "owned", "spd", "ifR", "ifE", "ifA", "dp", "cAb", "cFr", "cAr", "ofR", "ofE", "ofA"], sort: "title", dir: 1 },
  All: { cols: ["id", "variant", "title", "positions", "bats", "throws", "value", "owned", "hitOVR", "hitVL", "hitVR", "basicHit", "pitchOVR", "pitchVL", "pitchVR", "basicPitch", "spd", "ifR", "ifE", "ifA", "dp", "cAb", "cFr", "cAr", "ofR", "ofE", "ofA"], sort: "hitOVR", dir: -1 },
};

const sortVal = (col: Col, c: Card) => (col.sort ? col.sort(c) : col.get(c));
const fmtVal = (col: Col, c: Card) => {
  const v = col.get(c);
  if (col.fmt === "woba") return Number.isFinite(v as number) ? (v as number).toFixed(4) : "";
  if (col.fmt === "basic") return Number.isFinite(v as number) ? (v as number).toFixed(1) : "";
  return v ?? "";
};
const haystack = (c: Card) => `${c.title} ${c.first} ${c.last} ${c.id}`.toLowerCase();

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

  useEffect(() => {
    Promise.all([fetch("/api/meta").then((r) => r.json()), fetch("/api/cards").then((r) => r.json())])
      .then(([m, c]) => { setMeta(m); setCards(c); }).catch((e) => setErr(String(e)));
  }, []);

  const choosePreset = (name: keyof typeof PRESETS) => {
    setPreset(name);
    setSortKey(PRESETS[name].sort);
    setSortDir(PRESETS[name].dir);
  };

  const cols = PRESETS[preset].cols.map((k) => COLS[k]!);
  const sortCol = COLS[sortKey] ?? COLS.title!;

  const rows = useMemo(() => {
    const fq = filter.trim().toLowerCase();
    let r = cards;
    if (fq) r = r.filter((c) => haystack(c).includes(fq));
    if (ownedOnly) r = r.filter((c) => c.owned > 0);
    if (eligibleOnly) r = r.filter((c) => c.eligible);
    return [...r].sort((a, b) => {
      const av = sortVal(sortCol, a), bv = sortVal(sortCol, b);
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * sortDir;
      return String(av).localeCompare(String(bv)) * sortDir;
    });
  }, [cards, filter, ownedOnly, eligibleOnly, sortCol, sortDir]);

  const hq = highlight.trim().toLowerCase();
  const sortBy = (key: string) => {
    if (key === sortKey) setSortDir((d) => (d === 1 ? -1 : 1));
    else { setSortKey(key); setSortDir(COLS[key]?.fmt ? -1 : 1); }
  };

  const box: React.CSSProperties = { padding: "6px 10px", fontSize: 14, border: "1px solid #ccc", borderRadius: 4 };
  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: 16, color: "#111", background: "#fff", minHeight: "100vh" }}>
      <h2 style={{ margin: "0 0 4px" }}>OOTP Optimizer — Data Grid</h2>
      {err && <p style={{ color: "crimson" }}>Failed to load: {err} — is the server running?</p>}
      {meta && (
        <p style={{ margin: "0 0 12px", color: "#555", fontSize: 13 }}>
          Tournament: <b>{meta.tournament}</b> · Config: <b>{meta.configName}</b> · {meta.cardCount} cards
          ({meta.eligibleCount} eligible). Pitch wOBA: lower = better.
        </p>
      )}

      <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
        {(Object.keys(PRESETS) as (keyof typeof PRESETS)[]).map((p) => (
          <button key={p} onClick={() => choosePreset(p)}
            style={{ ...box, cursor: "pointer", background: preset === p ? "#2563eb" : "#f3f4f6", color: preset === p ? "#fff" : "#111", fontWeight: preset === p ? 600 : 400 }}>
            {p}
          </button>
        ))}
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
        <input placeholder="Filter (hide non-matches)…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ ...box, width: 240 }} />
        <input placeholder="Highlight (keep all)…" value={highlight} onChange={(e) => setHighlight(e.target.value)} style={{ ...box, width: 220, background: "#fffbe6" }} />
        <label style={{ fontSize: 13 }}><input type="checkbox" checked={eligibleOnly} onChange={(e) => setEligibleOnly(e.target.checked)} /> Eligible only</label>
        <label style={{ fontSize: 13 }}><input type="checkbox" checked={ownedOnly} onChange={(e) => setOwnedOnly(e.target.checked)} /> Owned only</label>
        <span style={{ color: "#777", fontSize: 13 }}>{rows.length} shown</span>
      </div>

      <div style={{ overflow: "auto", border: "1px solid #eee", maxHeight: "75vh" }}>
        <table style={{ borderCollapse: "collapse", fontSize: 13, width: "100%" }}>
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c.key} onClick={() => sortBy(c.key)}
                  style={{ textAlign: c.align === "r" ? "right" : c.align === "c" ? "center" : "left", padding: "6px 8px",
                    borderBottom: "2px solid #ccc", cursor: "pointer", whiteSpace: "nowrap", position: "sticky", top: 0,
                    background: sortKey === c.key ? "#dbeafe" : "#f3f4f6" }}>
                  {c.label}{sortKey === c.key ? (sortDir === 1 ? " ▲" : " ▼") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 750).map((c, i) => {
              const hot = hq && haystack(c).includes(hq);
              return (
                <tr key={c.id + ":" + c.variant + ":" + i} style={{ background: hot ? "#fef08a" : i % 2 ? "#fafafa" : "#fff" }}>
                  {cols.map((col) => (
                    <td key={col.key} style={{ textAlign: col.align === "r" ? "right" : col.align === "c" ? "center" : "left",
                      padding: "4px 8px", borderBottom: "1px solid #eee", whiteSpace: "nowrap",
                      maxWidth: col.key === "title" ? 340 : undefined, overflow: "hidden", textOverflow: "ellipsis" }}>
                      {fmtVal(col, c)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length > 750 && <p style={{ color: "#777", fontSize: 12 }}>Showing first 750 of {rows.length}.</p>}
    </div>
  );
}
