// Eras & Parks libraries (D4) — reusable run environments referenced by tournaments.
// Phase 1: view both libraries; import the parks library from OOTP's pt_ballparks.txt
// (re-run each season when factors change). Era editing + park hand-editing are later.

import { useEffect, useMemo, useRef, useState } from "react";
import { useAppData } from "./state.tsx";
import { DataTable, type Column } from "./DataTable.tsx";
import { C, inputStyle, type ParkCfg, type EraCfg } from "./shared.ts";

const f3 = (x: number | undefined) => (x == null ? "" : x.toFixed(3));

export function ErasParksPage() {
  const { reloadTournaments } = useAppData();
  const [parks, setParks] = useState<ParkCfg[]>([]);
  const [eras, setEras] = useState<EraCfg[]>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = () => Promise.all([
    fetch("/api/parks").then((r) => r.json()).then((d) => setParks(d.parks ?? [])),
    fetch("/api/eras").then((r) => r.json()).then((d) => setEras(d.eras ?? [])),
  ]);
  useEffect(() => { load().catch((e) => setMsg({ text: "Failed to load eras/parks: " + String(e), ok: false })); }, []);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setBusy(true); setMsg(null);
      const text = await file.text();
      const r = await fetch("/api/parks/import", { method: "POST", headers: { "Content-Type": "text/plain" }, body: text });
      const d = await r.json(); setBusy(false);
      if (!r.ok) setMsg({ text: d.error || "Import failed.", ok: false });
      else { setParks(d.parks ?? []); setMsg({ text: `Imported ${d.imported} parks.`, ok: true }); await reloadTournaments().catch(() => {}); }
    }
    if (fileRef.current) fileRef.current.value = "";
  };

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return parks;
    return parks.filter((p) => `${p.name} ${p.team ?? ""} ${p.league ?? ""} ${p.year ?? ""}`.toLowerCase().includes(s));
  }, [parks, q]);

  const parkCols: Column<ParkCfg>[] = [
    { key: "name", label: "Park", width: 240, min: 100, shrink: 2, value: (p) => p.name },
    { key: "year", label: "Yr", align: "r", width: 52, value: (p) => p.year ?? 0 },
    { key: "lg", label: "Lg", align: "c", width: 48, value: (p) => p.league ?? "" },
    { key: "team", label: "Team", width: 150, min: 60, shrink: 1, value: (p) => p.team ?? "" },
    { key: "lvl", label: "Lvl", align: "r", width: 46, value: (p) => p.ptLevel ?? 0 },
    { key: "avgL", label: "AVG vL", align: "r", width: 70, value: (p) => p.avg_l, render: (p) => f3(p.avg_l) },
    { key: "avgR", label: "AVG vR", align: "r", width: 70, value: (p) => p.avg_r, render: (p) => f3(p.avg_r) },
    { key: "hrL", label: "HR vL", align: "r", width: 66, value: (p) => p.hr_l, render: (p) => f3(p.hr_l) },
    { key: "hrR", label: "HR vR", align: "r", width: 66, value: (p) => p.hr_r, render: (p) => f3(p.hr_r) },
    { key: "gap", label: "Gap", align: "r", width: 62, value: (p) => p.gap, render: (p) => f3(p.gap) },
  ];
  const eraCols: Column<EraCfg>[] = [
    { key: "name", label: "Era", width: 150, min: 80, shrink: 1, value: (e) => e.name },
    { key: "yr", label: "Yr", align: "r", width: 54, value: (e) => e.year ?? 0 },
    { key: "bb", label: "BB", align: "r", width: 64, value: (e) => e.bb, render: (e) => f3(e.bb) },
    { key: "k", label: "K", align: "r", width: 64, value: (e) => e.k, render: (e) => f3(e.k) },
    { key: "avg", label: "AVG", align: "r", width: 64, value: (e) => e.avg, render: (e) => f3(e.avg) },
    { key: "hr", label: "HR", align: "r", width: 64, value: (e) => e.hr, render: (e) => f3(e.hr) },
    { key: "bip", label: "BIP", align: "r", width: 64, value: (e) => e.bip, render: (e) => f3(e.bip) },
    { key: "gap", label: "Gap", align: "r", width: 64, value: (e) => e.gap, render: (e) => f3(e.gap) },
    { key: "hbp", label: "HBP", align: "r", width: 64, value: (e) => e.hbp ?? 1, render: (e) => (e.hbp == null ? "—" : f3(e.hbp)) },
    { key: "thr", label: "tHR", align: "r", width: 60, value: (e) => (e.thr_toggle ? e.thr ?? 1 : 0), render: (e) => (e.thr_toggle ? `×${f3(e.thr ?? 1)}` : "—") },
  ];

  return (
    <div style={{ width: "100%" }}>
      <h2 style={{ margin: "0 0 12px" }}>Eras & Parks</h2>

      <h3 style={{ margin: "0 0 6px", fontSize: 15 }}>Parks ({parks.length})</h3>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
        <button onClick={() => fileRef.current?.click()} disabled={busy} style={{ ...inputStyle, cursor: "pointer", background: C.accent, color: "#fff" }}>{busy ? "Importing…" : "Import pt_ballparks.txt…"}</button>
        <input ref={fileRef} type="file" accept=".txt,.csv" onChange={onFile} style={{ display: "none" }} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search park / team / league / year…" style={{ ...inputStyle, width: 280 }} />
        {q && <span style={{ fontSize: 12, color: C.sub }}>{filtered.length} match</span>}
        {msg && <span style={{ fontSize: 13, color: msg.ok ? "#86efac" : "#f87171" }}>{msg.text}</span>}
      </div>
      <p style={{ margin: "0 0 8px", fontSize: 12, color: C.sub }}>
        From OOTP <code>…/OOTP Baseball 27/database/pt_ballparks.txt</code>. Factors are raw multipliers (scoring compresses them); tournaments reference a park by id. Re-import to refresh each season.
      </p>
      {parks.length === 0
        ? <p style={{ fontSize: 13, color: C.sub }}>No parks imported yet — use the import button above (the built-in neutral/full parks still work for tournaments).</p>
        : <div style={{ maxWidth: 1100 }}><DataTable rows={filtered} cols={parkCols} getKey={(p) => p.id} initialSort={{ key: "year", dir: -1 }} fit /></div>}

      <h3 style={{ margin: "20px 0 6px", fontSize: 15 }}>Eras ({eras.length})</h3>
      <p style={{ margin: "0 0 8px", fontSize: 12, color: C.sub }}>Run-environment factors vs the 2010 baseline (BB/K/AVG/HR/BIP/Gap consumed by scoring; HBP stored, not yet consumed; tHR is a per-tournament knob). Per-year eras are baked from Baseball-Reference league batting.</p>
      <div style={{ maxWidth: 880 }}><DataTable rows={eras} cols={eraCols} getKey={(e) => e.id} initialSort={{ key: "yr", dir: -1 }} fit /></div>
    </div>
  );
}
