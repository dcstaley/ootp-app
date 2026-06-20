import { useEffect, useMemo, useState } from "react";

interface Card {
  id: string; title: string; bats: number; throws: number;
  value: number; owned: number; position: string;
  hitVL: number; hitVR: number; pitchOVR: number;
}
interface Meta { configName: string; tournament: string; cardCount: number; eligibleCount: number }

type Col = { key: keyof Card; label: string; num: boolean };
const COLS: Col[] = [
  { key: "title", label: "Card", num: false },
  { key: "position", label: "Pos", num: false },
  { key: "bats", label: "B", num: true },
  { key: "throws", label: "T", num: true },
  { key: "value", label: "Value", num: true },
  { key: "owned", label: "Own", num: true },
  { key: "hitVL", label: "Hit wOBA vL", num: true },
  { key: "hitVR", label: "Hit wOBA vR", num: true },
  { key: "pitchOVR", label: "Pitch wOBA", num: true },
];
const BATS: Record<number, string> = { 1: "R", 2: "L", 3: "S" };
const THROWS: Record<number, string> = { 1: "R", 2: "L" };

export function App() {
  const [cards, setCards] = useState<Card[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [ownedOnly, setOwnedOnly] = useState(false);
  const [sortKey, setSortKey] = useState<keyof Card>("hitVR");
  const [sortDir, setSortDir] = useState<1 | -1>(-1);

  useEffect(() => {
    Promise.all([fetch("/api/meta").then((r) => r.json()), fetch("/api/cards").then((r) => r.json())])
      .then(([m, c]) => { setMeta(m); setCards(c); })
      .catch((e) => setErr(String(e)));
  }, []);

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    let r = cards;
    if (q) r = r.filter((c) => c.title.toLowerCase().includes(q));
    if (ownedOnly) r = r.filter((c) => c.owned > 0);
    const dir = sortDir;
    return [...r].sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey];
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }, [cards, filter, ownedOnly, sortKey, sortDir]);

  const sortBy = (key: keyof Card) => {
    if (key === sortKey) setSortDir((d) => (d === 1 ? -1 : 1));
    else { setSortKey(key); setSortDir(key === "title" || key === "position" ? 1 : -1); }
  };

  const fmt = (c: Card, key: keyof Card) => {
    const v = c[key];
    if (key === "bats") return BATS[c.bats] ?? c.bats;
    if (key === "throws") return THROWS[c.throws] ?? (c.throws || "");
    if (key === "hitVL" || key === "hitVR" || key === "pitchOVR") return (v as number).toFixed(4);
    return v as string | number;
  };

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: 16, color: "#111" }}>
      <h2 style={{ margin: "0 0 4px" }}>OOTP Optimizer — Data Grid</h2>
      {err && <p style={{ color: "crimson" }}>Failed to load: {err} — is the server running? (npm run server)</p>}
      {meta && (
        <p style={{ margin: "0 0 12px", color: "#555", fontSize: 13 }}>
          Tournament: <b>{meta.tournament}</b> · Config: <b>{meta.configName}</b> · {meta.cardCount} cards
          ({meta.eligibleCount} eligible). Pitch wOBA: lower = better.
        </p>
      )}
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 10 }}>
        <input placeholder="Search card…" value={filter} onChange={(e) => setFilter(e.target.value)}
          style={{ padding: "6px 10px", width: 280, fontSize: 14 }} />
        <label style={{ fontSize: 13 }}>
          <input type="checkbox" checked={ownedOnly} onChange={(e) => setOwnedOnly(e.target.checked)} /> Owned only
        </label>
        <span style={{ color: "#777", fontSize: 13 }}>{rows.length} shown</span>
      </div>
      <table style={{ borderCollapse: "collapse", fontSize: 13, width: "100%" }}>
        <thead>
          <tr>
            {COLS.map((c) => (
              <th key={c.key} onClick={() => sortBy(c.key)}
                style={{ textAlign: c.num ? "right" : "left", padding: "6px 8px", borderBottom: "2px solid #ccc",
                  cursor: "pointer", whiteSpace: "nowrap", background: sortKey === c.key ? "#eef" : undefined }}>
                {c.label}{sortKey === c.key ? (sortDir === 1 ? " ▲" : " ▼") : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 500).map((c, i) => (
            <tr key={c.id + ":" + i} style={{ background: i % 2 ? "#fafafa" : undefined }}>
              {COLS.map((col) => (
                <td key={col.key} style={{ textAlign: col.num ? "right" : "left", padding: "4px 8px",
                  borderBottom: "1px solid #eee", whiteSpace: "nowrap",
                  maxWidth: col.key === "title" ? 360 : undefined, overflow: "hidden", textOverflow: "ellipsis" }}>
                  {fmt(c, col.key)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 500 && <p style={{ color: "#777", fontSize: 12 }}>Showing first 500 of {rows.length}.</p>}
    </div>
  );
}
