// M6 — Model Training page. First slice (SP-9): load the real per-(league, side,
// year) outcome CSVs and show what the trainer will fit against. Ingestion only —
// no model is fit here yet (the fit, diagnostics, and the D3 bake-off are the next
// steps). The data was collected in a neutral league environment, so outcomes sum
// directly. The dataset is grouped by (CID, variant, side): base and variant of a
// player are separate observations; vL/vR stay separate.

import { useEffect, useState } from "react";
import { C, inputStyle } from "./shared.ts";

type Side = "L" | "R";
interface FileStat { file: string; league: string; side: Side; year: number; rows: number; pa: number; bf: number }
interface CellStat { league: string; side: Side; year: number; rows: number; pa: number; bf: number }
interface TrainingSummary {
  available: boolean; dir: string; error?: string;
  files: FileStat[]; unparsedFiles: string[];
  leagues: string[]; years: number[]; cells: CellStat[];
  observations: number; hitterObs: number; pitcherObs: number;
  baseObs: number; variantObs: number; totalPA: number; totalBF: number;
}

interface ResidualBin { lo: number; hi: number; mid: number; n: number; sumW: number; meanResidual: number; signal: number }
interface EventDiag { r2: number | null; rmse: number | null; spearman: number | null; pearson?: number | null; n: number; note?: string; bins?: ResidualBin[] }
interface LeagueNorm { bb: number; k: number; hr: number; h: number; xbh: number }
interface WobaHittingFit {
  modelType: string; split: string; minPA: number; rowCount: number;
  coefficients: {
    bb: { intercept: number; eye: number }; k: { intercept: number; k: number }; hr: { intercept: number; pow: number };
    h: { intercept: number; ba: number; bipba: number }; xbh: { logA: number; logB: number }; hbp: { constant: number };
    leagueNorm: LeagueNorm;
  };
  diagnostics: Record<string, EventDiag>;
}
interface WobaPitchingFit {
  modelType: string; split: string; minBF: number; rowCount: number;
  coefficients: {
    bb: { intercept: number; con: number }; k: { intercept: number; stu: number }; hr: { intercept: number; hrr: number };
    h: { intercept: number; pbabip: number; bip: number }; xbh: { share: number }; leagueNorm: LeagueNorm;
  };
  diagnostics: Record<string, EventDiag>;
}
interface BasicHittingFit { modelType: string; rowCount: number; minPA?: number; coefficients: { basic_intercept: number; w_babip: number; w_pow: number; w_eye: number; w_k: number; w_gap: number }; diagnostics: { weights: EventDiag } }
interface BasicPitchingFit { modelType: string; rowCount: number; minBF?: number; coefficients: { basic_intercept: number; p_stuff: number; p_control: number; p_babip: number; p_hr: number }; diagnostics: { weights: EventDiag } }
interface FitResp {
  available: boolean; error?: string; window?: number[];
  woba_hitting?: WobaHittingFit; woba_pitching?: WobaPitchingFit; basic_hitting?: BasicHittingFit; basic_pitching?: BasicPitchingFit;
  wobaDiagHit?: SbMetrics; wobaDiagPit?: SbMetrics; // assembled-wOBA fidelity (in-sample)
}
interface SbMetrics { n: number; pearson: number; r2: number; spearman: number; gapRmse: number; rmse: number; mae: number; bias: number; topNOverlap: number; valueRegret: number; topN: number }
interface ScoreRow { model: string; role: "hitter" | "pitcher"; evaluation: string; window: string; metrics: SbMetrics }
interface Scoreboard { minN: number; k: number; topN: number; years: number[]; trainWindow: number[]; rows: ScoreRow[] }
interface ScoreboardResp { available: boolean; error?: string; scoreboard?: Scoreboard }

interface CardResidual { name: string; cid: string; variant: boolean; side: "L" | "R"; pred: number; actual: number; valErrPts: number; vol: number }
interface Bucket { name: string; desc: string; n: number; meanValErrPts: number; sumW: number }
interface ResidGrid { rowRating: string; colRating: string; bands: string[]; cells: { n: number; meanValErrPts: number; sumW: number }[][] }
interface ResidualAnalysis { role: "hitter" | "pitcher"; window: number[]; n: number; over: CardResidual[]; under: CardResidual[]; archetypes: Bucket[]; grid: ResidGrid }
interface ResidResp { available: boolean; error?: string; residuals?: ResidualAnalysis }

type FitTab = "woba_hitting" | "woba_pitching" | "basic_hitting" | "basic_pitching";
const FIT_TABS: { id: FitTab; label: string }[] = [
  { id: "woba_hitting", label: "wOBA Hitting" }, { id: "woba_pitching", label: "wOBA Pitching" },
  { id: "basic_hitting", label: "Basic Hitting" }, { id: "basic_pitching", label: "Basic Pitching" },
];

const fmt = (n: number) => n.toLocaleString();
const sig = (n: number, d = 3) => n.toFixed(d);

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ flex: "1 1 130px", minWidth: 120, padding: "10px 12px", border: `1px solid ${C.border}`, borderRadius: 8, background: C.panel }}>
      <div style={{ fontSize: 11, color: C.sub, textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, marginTop: 2 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: C.sub, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

const th: React.CSSProperties = { textAlign: "right", padding: "6px 10px", fontSize: 11, color: C.sub, textTransform: "uppercase", letterSpacing: 0.3, borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap" };
const td: React.CSSProperties = { textAlign: "right", padding: "6px 10px", fontSize: 13, borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap" };
const Coef = ({ v }: { v: number }) => <code style={{ color: C.link }}>{sig(v)}</code>;
// The assembled-wOBA fidelity as a DiagTable row (the bottom line: events → wOBA →
// vs actual). RMSE is in wOBA units (~0.006), unlike the per-event rows (per-600).
const wobaRow = (w?: SbMetrics): { label: string; e: EventDiag }[] =>
  w ? [{ label: "→ wOBA", e: { r2: w.r2, rmse: w.rmse, spearman: w.spearman, pearson: w.pearson, n: w.n } }] : [];

// Diagnostics table shared by all four models (per-event rows, or one "weights" row).
function DiagTable({ rows }: { rows: { label: string; e: EventDiag }[] }) {
  return (
    <div style={{ overflowX: "auto", border: `1px solid ${C.border}`, borderRadius: 8 }}>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead><tr>
          <th style={{ ...th, textAlign: "left" }}>Model</th><th style={th}>R²</th><th style={th}>RMSE</th><th style={th}>Spearman</th><th style={th}>Pearson</th><th style={th}>N</th>
        </tr></thead>
        <tbody>
          {rows.map(({ label, e }) => (
            <tr key={label}>
              <td style={{ ...td, textAlign: "left", textTransform: "uppercase" }}>{label}</td>
              <td style={td}>{e.r2 != null ? sig(e.r2, 4) : "—"}</td>
              <td style={td}>{e.rmse != null ? sig(e.rmse, 3) : "—"}</td>
              <td style={td}>{e.spearman != null ? sig(e.spearman, 4) : "—"}</td>
              <td style={td}>{e.pearson != null ? sig(e.pearson, 4) : "—"}</td>
              <td style={{ ...td, color: C.sub }}>{e.n}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Residual-by-rating heat strip for one event: low→high rating, left→right; each
// cell is a weight-balanced bin coloured by the over-valuation signal (red = model
// over-values that region, green = under-values). Intensity scaled within the event.
function ResidualHeat({ label, rating, bins }: { label: string; rating: string; bins: ResidualBin[] }) {
  const maxAbs = Math.max(1e-9, ...bins.map((b) => Math.abs(b.signal)));
  const cell = (b: ResidualBin, i: number) => {
    const a = Math.min(1, Math.abs(b.signal) / maxAbs) * 0.8;
    const bg = b.signal >= 0 ? `rgba(239,68,68,${a})` : `rgba(34,197,94,${a})`; // red over, green under
    return (
      <div key={i} title={`${rating} ${b.lo}–${b.hi} · signal ${b.signal >= 0 ? "+" : ""}${b.signal} (${b.signal >= 0 ? "over" : "under"}-values) · N=${b.n} · sumW=${b.sumW}`}
        style={{ flex: 1, minWidth: 0, height: 26, background: bg, borderRight: `1px solid ${C.bg}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, color: C.text }}>
        {b.signal >= 0 ? "+" : ""}{b.signal.toFixed(1)}
      </div>
    );
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
      <span style={{ width: 34, fontSize: 11, fontWeight: 700, color: C.sub, textTransform: "uppercase" }}>{label}</span>
      <div style={{ flex: 1, display: "flex", border: `1px solid ${C.border}`, borderRadius: 4, overflow: "hidden" }}>{bins.map(cell)}</div>
    </div>
  );
}

// Evaluation scoreboard — Pearson (headline gap-fidelity) coloured by magnitude;
// forward/backward rows tinted so drift jumps out.
function ScoreboardView({ sb }: { sb: Scoreboard }) {
  const evalLabel: Record<string, string> = { "in-sample": "in-sample", cv: `${sb.k}-fold CV`, forward: "forward (OOT)", backward: "backward (OOT)" };
  const pearColor = (p: number) => { const a = Math.max(0, Math.min(1, (p - 0.5) / 0.5)) * 0.6; return `rgba(34,197,94,${a})`; };
  const rowTint = (e: string) => (e === "forward" ? "rgba(234,179,8,0.07)" : e === "backward" ? "rgba(59,130,246,0.07)" : "transparent");
  // gap RMSE & Regret are in wOBA units (~0.004) — show as wOBA POINTS (×1000) for readability.
  const PTS = new Set<keyof SbMetrics>(["gapRmse", "valueRegret"]);
  const cols: [keyof SbMetrics, string][] = [["r2", "R²"], ["spearman", "Spearman"], ["gapRmse", "gap RMSE"], ["valueRegret", "Regret"], ["topNOverlap", `Top${sb.topN} ovl`], ["n", "N"]];
  const fmtCell = (k: keyof SbMetrics, v: number) => (k === "n" ? v : PTS.has(k) ? (v * 1000).toFixed(1) : sig(v, 3));
  return (
    <div style={{ overflowX: "auto", border: `1px solid ${C.border}`, borderRadius: 8 }}>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead><tr>
          <th style={{ ...th, textAlign: "left" }}>Model</th><th style={{ ...th, textAlign: "left" }}>Role</th><th style={{ ...th, textAlign: "left" }}>Evaluation</th><th style={{ ...th, textAlign: "left" }}>Window</th>
          <th style={th} title="Weighted Pearson — headline gap-fidelity (affine-invariant)">Pearson</th>
          {cols.map(([k, label]) => <th key={label} style={th} title={PTS.has(k) ? "wOBA points (×1000)" : undefined}>{label}{PTS.has(k) ? " (pts)" : ""}</th>)}
        </tr></thead>
        <tbody>
          {sb.rows.map((r, i) => (
            <tr key={i} style={{ background: rowTint(r.evaluation), borderTop: i > 0 && r.evaluation === "in-sample" ? `2px solid ${C.border}` : undefined }}>
              <td style={{ ...td, textAlign: "left", fontWeight: 700, textTransform: "uppercase", color: r.model === "woba" ? "#86efac" : "#93c5fd" }}>{r.model}</td>
              <td style={{ ...td, textAlign: "left", textTransform: "capitalize" }}>{r.role}</td>
              <td style={{ ...td, textAlign: "left" }}>{evalLabel[r.evaluation] ?? r.evaluation}</td>
              <td style={{ ...td, textAlign: "left", color: C.sub, fontSize: 12 }}>{r.window}</td>
              <td style={{ ...td, fontWeight: 700, background: pearColor(r.metrics.pearson) }}>{sig(r.metrics.pearson, 3)}</td>
              {cols.map(([k]) => <td key={k} style={{ ...td, color: k === "n" ? C.sub : C.text }}>{fmtCell(k, r.metrics[k] as number)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Over/under-valuation colour: red = model over-values (positive pts), green =
// under-values. Intensity saturates ~±15 pts.
const errBg = (pts: number) => `rgba(${pts >= 0 ? "239,68,68" : "34,197,94"},${Math.min(1, Math.abs(pts) / 15) * 0.7})`;
const errFg = (pts: number) => (pts >= 0 ? "#fca5a5" : "#86efac");
const pm = (pts: number) => `${pts >= 0 ? "+" : ""}${pts.toFixed(1)}`;

// "Where the model misses": leaderboards + archetype buckets + a 2D interaction grid.
function MissesView({ a }: { a: ResidualAnalysis }) {
  const card = (c: CardResidual) => (
    <div key={c.cid + c.variant + c.side} title={`pred ${c.pred.toFixed(3)} · actual ${c.actual.toFixed(3)} · vol ${c.vol} · v${c.side}`}
      style={{ display: "flex", alignItems: "center", gap: 8, padding: "2px 6px", borderBottom: `1px solid ${C.border}`, fontSize: 12 }}>
      <span style={{ width: 44, textAlign: "right", fontWeight: 700, color: errFg(c.valErrPts) }}>{pm(c.valErrPts)}</span>
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.variant && <span style={{ color: C.star }}>★</span>}{c.name}</span>
      <span style={{ color: C.sub, fontSize: 11 }}>{c.pred.toFixed(3)}→{c.actual.toFixed(3)}</span>
    </div>
  );
  return (
    <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "flex-start", marginTop: 8 }}>
      {/* Leaderboards */}
      <div style={{ flex: "1 1 300px", minWidth: 280 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#fca5a5", margin: "0 0 2px" }}>Most over-valued (model &gt; reality)</div>
        <div style={{ border: `1px solid ${C.border}`, borderRadius: 6 }}>{a.over.map(card)}</div>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#86efac", margin: "10px 0 2px" }}>Most under-valued (model &lt; reality)</div>
        <div style={{ border: `1px solid ${C.border}`, borderRadius: 6 }}>{a.under.map(card)}</div>
        <p style={{ margin: "4px 0 0", fontSize: 10, color: C.sub }}>Valuation error in wOBA points; pred→actual wOBA. ★ = variant.</p>
      </div>
      {/* Archetypes */}
      <div style={{ flex: "1 1 320px", minWidth: 300 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: C.text, margin: "0 0 4px" }}>Card-shape archetypes (mean valuation error)</div>
        <div style={{ overflowX: "auto", border: `1px solid ${C.border}`, borderRadius: 6 }}>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead><tr><th style={{ ...th, textAlign: "left" }}>Archetype</th><th style={{ ...th, textAlign: "left" }}>Profile</th><th style={th}>n</th><th style={th}>err (pts)</th></tr></thead>
            <tbody>{a.archetypes.map((b) => (
              <tr key={b.name}>
                <td style={{ ...td, textAlign: "left", fontWeight: 600 }}>{b.name}</td>
                <td style={{ ...td, textAlign: "left", color: C.sub, fontSize: 11 }}>{b.desc}</td>
                <td style={{ ...td, color: C.sub }}>{b.n}</td>
                <td style={{ ...td, fontWeight: 700, color: errFg(b.meanValErrPts), background: errBg(b.meanValErrPts) }}>{b.n ? pm(b.meanValErrPts) : "—"}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        {/* 2D interaction grid */}
        <div style={{ fontSize: 12, fontWeight: 700, color: C.text, margin: "12px 0 4px" }}>Interaction grid — {a.grid.rowRating.toUpperCase()} (rows) × {a.grid.colRating.toUpperCase()} (cols)</div>
        <div style={{ display: "grid", gridTemplateColumns: `28px repeat(3, 1fr)`, gap: 2, maxWidth: 320 }}>
          <span />{a.grid.bands.map((b) => <span key={b} style={{ textAlign: "center", fontSize: 10, color: C.sub }}>{a.grid.colRating.toUpperCase()} {b}</span>)}
          {a.grid.cells.map((row, ri) => [
            <span key={`r${ri}`} style={{ fontSize: 10, color: C.sub, alignSelf: "center" }}>{a.grid.bands[ri]}</span>,
            ...row.map((cell, ci) => (
              <div key={`${ri}-${ci}`} title={`${a.grid.rowRating} ${a.grid.bands[ri]} × ${a.grid.colRating} ${a.grid.bands[ci]} · n=${cell.n}`}
                style={{ height: 34, borderRadius: 3, background: cell.n ? errBg(cell.meanValErrPts) : C.input, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: cell.n ? errFg(cell.meanValErrPts) : C.sub }}>
                {cell.n ? pm(cell.meanValErrPts) : "—"}<span style={{ fontSize: 9, fontWeight: 400, color: C.sub }}>n{cell.n}</span>
              </div>
            )),
          ])}
        </div>
        <p style={{ margin: "4px 0 0", fontSize: 10, color: C.sub }}><span style={{ color: "#fca5a5" }}>red</span> = over-valued, <span style={{ color: "#86efac" }}>green</span> = under-valued (PA-weighted mean, wOBA pts). Corners reveal interactions an additive model can't capture.</p>
      </div>
    </div>
  );
}

function ResidualPanel({ d, events }: { d: Record<string, EventDiag>; events: [string, string][] }) {
  return (
    <div style={{ marginTop: 16 }}>
      <h4 style={{ margin: "0 0 6px", fontSize: 13 }}>Residual by rating — over-valuation diagnostic</h4>
      {events.map(([ev, rt]) => (d[ev]?.bins ? <ResidualHeat key={ev} label={ev} rating={rt} bins={d[ev]!.bins!} /> : null))}
      <p style={{ margin: "6px 0 0", fontSize: 11, color: C.sub, maxWidth: 760 }}>
        Weight-balanced bins, low→high rating left→right. <span style={{ color: "#ef4444" }}>Red</span> = the model
        over-values that region (predicts more good-event / fewer K than reality); <span style={{ color: "#22c55e" }}>green</span> = under-values.
        Diagnostic only — no softcap is derived (the softcap concept is under review).
      </p>
    </div>
  );
}

// Two-column layout: formula card + note (left) and diagnostics table (right).
function ModelView({ formulas, note, diagRows }: { formulas: React.ReactNode[]; note: React.ReactNode; diagRows: { label: string; e: EventDiag }[] }) {
  return (
    <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "flex-start" }}>
      <div style={{ flex: "1 1 380px", minWidth: 320 }}>
        <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 12px", background: C.panel, fontSize: 13, lineHeight: 1.9 }}>
          {formulas.map((f, i) => <div key={i}>{f}</div>)}
        </div>
        <p style={{ margin: "8px 0 0", fontSize: 11, color: C.sub }}>{note}</p>
      </div>
      <div style={{ flex: "1 1 360px", minWidth: 300 }}><DiagTable rows={diagRows} /></div>
    </div>
  );
}

export function ModelTrainingPage() {
  const [data, setData] = useState<TrainingSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fit, setFit] = useState<FitResp | null>(null);
  const [fitLoading, setFitLoading] = useState(false);
  const [minPA, setMinPA] = useState(1000);
  const [fitTab, setFitTab] = useState<FitTab>("woba_hitting");
  const [sb, setSb] = useState<ScoreboardResp | null>(null);
  const [sbLoading, setSbLoading] = useState(false);
  const [years, setYears] = useState<number[]>([]); // selected training window (empty ⇒ server default: recent 2yr)
  const [resid, setResid] = useState<ResidResp | null>(null);
  const [residRole, setResidRole] = useState<"hitter" | "pitcher">("hitter");

  const yq = (ys: number[]) => (ys.length ? `&years=${ys.join(",")}` : "");
  const load = (reload = false) => {
    setLoading(true); setErr(null);
    fetch(`/api/training/summary${reload ? "?reload=true" : ""}`)
      .then((r) => r.json()).then((d: TrainingSummary) => { setData(d); setYears((cur) => (cur.length ? cur : (d.years ?? []).slice(-2))); })
      .catch((e) => setErr(String(e))).finally(() => setLoading(false));
  };
  const loadFit = (pa: number, ys: number[], reload = false) => {
    setFitLoading(true);
    fetch(`/api/training/fit?minPA=${pa}${yq(ys)}${reload ? "&reload=true" : ""}`)
      .then((r) => r.json()).then((d: FitResp) => setFit(d))
      .catch((e) => setErr(String(e))).finally(() => setFitLoading(false));
  };
  const loadSb = (pa: number, ys: number[], reload = false) => {
    setSbLoading(true);
    fetch(`/api/training/scoreboard?minN=${pa}&k=5${yq(ys)}${reload ? "&reload=true" : ""}`)
      .then((r) => r.json()).then((d: ScoreboardResp) => setSb(d))
      .catch((e) => setErr(String(e))).finally(() => setSbLoading(false));
  };
  const loadResid = (role: "hitter" | "pitcher", ys: number[], reload = false) =>
    fetch(`/api/training/residuals?role=${role}&minN=${minPA}${yq(ys)}${reload ? "&reload=true" : ""}`)
      .then((r) => r.json()).then((d: ResidResp) => setResid(d)).catch((e) => setErr(String(e)));
  useEffect(() => { load(); loadFit(1000, []); loadSb(1000, []); loadResid("hitter", []); }, []);
  // Toggle a year in the training window; refit + rescore + re-analyze on the new window.
  const toggleYear = (y: number) => {
    const next = (years.includes(y) ? years.filter((x) => x !== y) : [...years, y]).sort((a, b) => a - b);
    if (!next.length) return; // keep at least one year
    setYears(next); loadFit(minPA, next); loadSb(minPA, next); loadResid(residRole, next);
  };
  const chooseResidRole = (role: "hitter" | "pitcher") => { setResidRole(role); loadResid(role, years); };

  // Pivot the cells into a league-row × (year/side)-column matrix for the table.
  const colKeys = data ? [...new Set(data.cells.map((c) => `${c.year} v${c.side}`))].sort() : [];
  const cellAt = (league: string, col: string) => data?.cells.find((c) => c.league === league && `${c.year} v${c.side}` === col);

  return (
    <div style={{ width: "100%", maxWidth: 1100 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0 }}>Model Training</h2>
        <button onClick={() => { load(true); loadFit(minPA, years, true); loadSb(minPA, years, true); loadResid(residRole, years, true); }} disabled={loading} style={{ ...inputStyle, cursor: "pointer", background: C.accent, color: "#fff" }}>{loading ? "Loading…" : "Reload data"}</button>
        {data?.dir && <span style={{ fontSize: 13, color: C.sub }}>source: <code style={{ color: C.text }}>{data.dir}</code></span>}
      </div>
      <p style={{ margin: "0 0 16px", color: C.sub, fontSize: 13, maxWidth: 820 }}>
        The real per-(league, side, year) season-outcome dataset the trainer fits against, collected in a
        <b style={{ color: C.text }}> neutral league environment</b> (no park, neutral era) so outcomes sum
        directly. Observations are grouped by <b style={{ color: C.text }}>(card, variant, side)</b> — base
        and variant of a player are separate; vL and vR stay separate; outcomes are summed across every
        league/year a card appears in. This page is <b style={{ color: C.text }}>ingestion only</b> for now —
        fitting, diagnostics, and the D3 bake-off come next.
      </p>

      {err && <div style={{ padding: "10px 12px", border: "1px solid #ef4444", borderRadius: 8, background: "rgba(239,68,68,0.12)", color: "#f87171", marginBottom: 12 }}>{err}</div>}
      {loading && !data && <p style={{ color: C.sub }}>Loading training data…</p>}

      {data && !data.available && (
        <div style={{ padding: "12px 14px", border: "1px solid #ef4444", borderRadius: 8, background: "rgba(239,68,68,0.12)" }}>
          <div style={{ color: "#f87171", fontWeight: 700, marginBottom: 4 }}>⚠ Training data not available</div>
          <div style={{ fontSize: 13, color: C.text }}>Looked in <code>{data.dir}</code>. {data.error}</div>
        </div>
      )}

      {data && data.available && (
        <>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 18 }}>
            <Stat label="Observations" value={fmt(data.observations)} sub={`${fmt(data.baseObs)} base · ${fmt(data.variantObs)} variant`} />
            <Stat label="Hitter obs" value={fmt(data.hitterObs)} sub="PA > 0" />
            <Stat label="Pitcher obs" value={fmt(data.pitcherObs)} sub="BF > 0" />
            <Stat label="Total PA" value={fmt(data.totalPA)} />
            <Stat label="Total BF" value={fmt(data.totalBF)} />
            <Stat label="Files" value={fmt(data.files.length)} sub={`${data.leagues.length} leagues · ${data.years.join("–")}`} />
          </div>

          <h3 style={{ margin: "0 0 8px", fontSize: 14 }}>Coverage by league × year × side</h3>
          <div style={{ overflowX: "auto", border: `1px solid ${C.border}`, borderRadius: 8 }}>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead>
                <tr>
                  <th style={{ ...th, textAlign: "left" }}>League</th>
                  {colKeys.map((c) => <th key={c} style={th}>{c}</th>)}
                  <th style={{ ...th, borderLeft: `1px solid ${C.border}` }}>Σ PA</th>
                  <th style={th}>Σ BF</th>
                </tr>
              </thead>
              <tbody>
                {data.leagues.map((lg) => {
                  const rowCells = colKeys.map((c) => cellAt(lg, c));
                  const pa = rowCells.reduce((s, x) => s + (x?.pa ?? 0), 0);
                  const bf = rowCells.reduce((s, x) => s + (x?.bf ?? 0), 0);
                  return (
                    <tr key={lg}>
                      <td style={{ ...td, textAlign: "left", fontWeight: 600 }}>{lg}</td>
                      {rowCells.map((x, i) => (
                        <td key={i} style={{ ...td, color: x ? C.text : C.sub }}>
                          {x ? <span title={`${fmt(x.rows)} rows · ${fmt(x.pa)} PA · ${fmt(x.bf)} BF`}>{fmt(x.rows)}</span> : "—"}
                        </td>
                      ))}
                      <td style={{ ...td, borderLeft: `1px solid ${C.border}`, color: C.sub }}>{fmt(pa)}</td>
                      <td style={{ ...td, color: C.sub }}>{fmt(bf)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p style={{ margin: "8px 0 0", fontSize: 11, color: C.sub }}>
            Each cell = # card rows in that file (hover for PA/BF). vL/vR are separate observations feeding one
            unified fit; the same card recurs across leagues/years and its outcomes aggregate into a single
            (card, variant, side) observation.
            {data.unparsedFiles.length > 0 && <> · <span style={{ color: "#f59e0b" }}>{data.unparsedFiles.length} file(s) skipped (unrecognized name): {data.unparsedFiles.join(", ")}</span></>}
          </p>

          {/* Training window — the years the live model + scoreboard in-sample/CV fit on */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "20px 0 6px", flexWrap: "wrap" }}>
            <h3 style={{ margin: 0, fontSize: 14 }}>Training window</h3>
            <span style={{ display: "inline-flex", gap: 4 }}>
              {data.years.map((y) => {
                const on = years.includes(y);
                return (
                  <button key={y} onClick={() => toggleYear(y)} disabled={fitLoading || sbLoading}
                    style={{ ...inputStyle, cursor: "pointer", padding: "4px 9px", fontWeight: on ? 700 : 400, background: on ? C.accent : C.input, color: on ? "#fff" : C.sub, border: `1px solid ${on ? C.accent : C.border}` }}>{y}</button>
                );
              })}
            </span>
            <span style={{ fontSize: 12, color: C.sub }}>
              fits the live model + the scoreboard's in-sample/CV on these years. Default = recent 2 (new cards drift; older years blend different pools).
            </span>
          </div>

          {/* Evaluation scoreboard — out-of-sample fidelity for the bake-off baseline */}
          <h3 style={{ margin: "22px 0 8px", fontSize: 14 }}>Evaluation scoreboard {sbLoading && <span style={{ fontSize: 12, color: C.sub }}>· computing…</span>}</h3>
          {sb && !sb.available && <p style={{ color: "#f87171", fontSize: 13 }}>Scoreboard unavailable: {sb.error}</p>}
          {sb?.scoreboard && <>
            <ScoreboardView sb={sb.scoreboard} />
            <p style={{ margin: "8px 0 0", fontSize: 11, color: C.sub, maxWidth: 820 }}>
              Out-of-sample fidelity of the log-linear baseline (the bake-off compares candidate forms here).
              <b style={{ color: C.text }}> Pearson</b> is the headline — affine-invariant, so it rewards preserving
              relative gaps, not hitting exact wOBA (a uniform shift/scale doesn't change the roster). <b style={{ color: C.text }}>R²</b>
              {" "}is diagnostic: R² ≪ Pearson² means harmless level bias. <b style={{ color: C.text }}>gap RMSE</b> &amp;
              {" "}<b style={{ color: C.text }}>Regret</b> are in <b style={{ color: C.text }}>wOBA points</b> (×1000, so 4.0 = .004);
              gap RMSE = gap distortion after affine alignment, Regret = per-card actual-wOBA shortfall if you pick the model's
              top-{sb.scoreboard.topN}. <span style={{ color: "#eab308" }}>Forward</span> trains the 2 oldest→newest (drift to new
              releases); <span style={{ color: "#60a5fa" }}>backward</span> trains the 2 newest→oldest (weaker cards / limited-pool,
              tournament-like). Evaluated in wOBA space, upstream of softcaps/anchoring.
            </p>
          </>}

          {/* Where the model misses — per-card residual leaderboards + archetypes + grid */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "22px 0 4px", flexWrap: "wrap" }}>
            <h3 style={{ margin: 0, fontSize: 14 }}>Where the wOBA model misses</h3>
            <span style={{ display: "inline-flex", border: `1px solid ${C.border}`, borderRadius: 4, overflow: "hidden" }}>
              {(["hitter", "pitcher"] as const).map((r) => (
                <button key={r} onClick={() => chooseResidRole(r)} style={{ ...inputStyle, border: "none", borderRadius: 0, cursor: "pointer", padding: "5px 11px", textTransform: "capitalize", background: residRole === r ? C.accent : C.input, color: residRole === r ? "#fff" : C.sub, fontWeight: residRole === r ? 700 : 400 }}>{r}</button>
              ))}
            </span>
            {resid?.residuals && <span style={{ fontSize: 12, color: C.sub }}>{resid.residuals.n} cards · window {resid.residuals.window.join("+")}</span>}
          </div>
          {resid && !resid.available && <p style={{ color: "#f87171", fontSize: 13 }}>Unavailable: {resid.error}</p>}
          {resid?.residuals && <MissesView a={resid.residuals} />}

          {/* Trained models — all four parity-validated bit-for-bit vs the old trainer */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "22px 0 8px", flexWrap: "wrap" }}>
            <h3 style={{ margin: 0, fontSize: 14 }}>Trained models</h3>
            <label style={{ fontSize: 12, color: C.sub, display: "inline-flex", alignItems: "center", gap: 5 }} title="Minimum PA (hitting) / BF (pitching) for an observation to enter the fit.">
              min PA / BF
              <input type="number" value={minPA} min={0} step={100} onChange={(e) => setMinPA(Number(e.target.value))}
                style={{ ...inputStyle, width: 76, padding: "3px 6px", fontSize: 12 }} />
            </label>
            <button onClick={() => { loadFit(minPA, years); loadSb(minPA, years); loadResid(residRole, years); }} disabled={fitLoading} style={{ ...inputStyle, cursor: "pointer" }}>{fitLoading ? "Fitting…" : "Refit"}</button>
          </div>

          {fit && !fit.available && <p style={{ color: "#f87171", fontSize: 13 }}>Fit unavailable: {fit.error}</p>}
          {fit?.available && (
            <>
              <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
                {FIT_TABS.map((t) => (
                  <button key={t.id} onClick={() => setFitTab(t.id)}
                    style={{ ...inputStyle, cursor: "pointer", background: fitTab === t.id ? C.accent : C.input, color: fitTab === t.id ? "#fff" : C.sub, fontWeight: fitTab === t.id ? 700 : 400, border: `1px solid ${fitTab === t.id ? C.accent : C.border}` }}>
                    {t.label}
                  </button>
                ))}
              </div>

              {fitTab === "woba_hitting" && fit.woba_hitting && (() => {
                const c = fit.woba_hitting.coefficients; const d = fit.woba_hitting.diagnostics;
                return <>
                  <ModelView
                    formulas={[
                      <>BB/600 = <Coef v={c.bb.intercept} /> + <Coef v={c.bb.eye} />·ln(EYE)</>,
                      <>K/600 = <Coef v={c.k.intercept} /> + <Coef v={c.k.k} />·ln(K)</>,
                      <>HR/600 = <Coef v={c.hr.intercept} /> + <Coef v={c.hr.pow} />·ln(POW)</>,
                      <>nonHR-H/600 = <Coef v={c.h.intercept} /> + <Coef v={c.h.ba} />·ln(BABIP) + <Coef v={c.h.bipba} />·ln(predBIP)</>,
                      <>XBH/H = <Coef v={c.xbh.logA} /> + <Coef v={c.xbh.logB} />·ln(GAP)</>,
                      <>HBP/600 = <Coef v={c.hbp.constant} /> (fixed)</>,
                    ]}
                    note={<>{fmt(fit.woba_hitting.rowCount)} obs (PA ≥ {fit.woba_hitting.minPA}), split {fit.woba_hitting.split}. Per-event log-linear WLS (weight = PA<sup>0.75</sup>). League-norm: BB <Coef v={c.leagueNorm.bb} />, K <Coef v={c.leagueNorm.k} />, HR <Coef v={c.leagueNorm.hr} />, H <Coef v={c.leagueNorm.h} />, XBH <Coef v={c.leagueNorm.xbh} />. Parity with the old trainer is test-pinned on the 37-38 window.</>}
                    diagRows={[...["bb", "k", "hr", "h", "xbh"].map((ev) => ({ label: ev, e: d[ev]! })), ...wobaRow(fit.wobaDiagHit)]} />
                  <ResidualPanel d={d} events={[["bb", "EYE"], ["k", "K"], ["hr", "POW"], ["h", "BABIP"], ["xbh", "GAP"]]} />
                </>;
              })()}

              {fitTab === "woba_pitching" && fit.woba_pitching && (() => {
                const c = fit.woba_pitching.coefficients; const d = fit.woba_pitching.diagnostics;
                return <>
                  <ModelView
                    formulas={[
                      <>BB/600 = <Coef v={c.bb.intercept} /> + <Coef v={c.bb.con} />·ln(CON)</>,
                      <>K/600 = <Coef v={c.k.intercept} /> + <Coef v={c.k.stu} />·ln(STU)</>,
                      <>HR/600 = <Coef v={c.hr.intercept} /> + <Coef v={c.hr.hrr} />·ln(HRR)</>,
                      <>nonHR-H/600 = <Coef v={c.h.intercept} /> + <Coef v={c.h.pbabip} />·ln(PBABIP) + <Coef v={c.h.bip} />·ln(predBIP)</>,
                      <>XBH = <Coef v={c.xbh.share} />·H (fixed share)</>,
                    ]}
                    note={<>{fmt(fit.woba_pitching.rowCount)} obs (BF ≥ {fit.woba_pitching.minBF}), split {fit.woba_pitching.split}. Per-event log-linear WLS (weight = BF<sup>0.75</sup>). League-norm: BB <Coef v={c.leagueNorm.bb} />, K <Coef v={c.leagueNorm.k} />, HR <Coef v={c.leagueNorm.hr} />, H <Coef v={c.leagueNorm.h} />, XBH <Coef v={c.leagueNorm.xbh} />. Parity with the old trainer is test-pinned on the 37-38 window.</>}
                    diagRows={[...["bb", "k", "hr", "h"].map((ev) => ({ label: ev, e: d[ev]! })), ...wobaRow(fit.wobaDiagPit)]} />
                  <ResidualPanel d={d} events={[["bb", "CON"], ["k", "STU"], ["hr", "HRR"], ["h", "PBABIP"]]} />
                </>;
              })()}

              {fitTab === "basic_hitting" && fit.basic_hitting && (() => {
                const c = fit.basic_hitting.coefficients;
                return <ModelView
                  formulas={[
                    <>score = <Coef v={c.basic_intercept} /> + <Coef v={c.w_babip} />·ln(BABIP) + <Coef v={c.w_pow} />·ln(POW)</>,
                    <>{"    "}+ <Coef v={c.w_eye} />·ln(EYE) + <Coef v={c.w_k} />·ln(K) + <Coef v={c.w_gap} />·ln(GAP)</>,
                  ]}
                  note={<>{fmt(fit.basic_hitting.rowCount)} obs (PA ≥ {fit.basic_hitting.minPA}). One WLS fit (weight = PA<sup>0.75</sup>) of wOBA×333 on log ratings; intercept clamped ≥ 0. Matches the old “37-38” model.</>}
                  diagRows={[{ label: "score", e: fit.basic_hitting.diagnostics.weights }]} />;
              })()}

              {fitTab === "basic_pitching" && fit.basic_pitching && (() => {
                const c = fit.basic_pitching.coefficients;
                return <ModelView
                  formulas={[
                    <>score = <Coef v={c.basic_intercept} /> + <Coef v={c.p_stuff} />·ln(STU) + <Coef v={c.p_control} />·ln(CON)</>,
                    <>{"    "}+ <Coef v={c.p_babip} />·ln(PBABIP) + <Coef v={c.p_hr} />·ln(HRR)</>,
                  ]}
                  note={<>{fmt(fit.basic_pitching.rowCount)} obs (BF ≥ {fit.basic_pitching.minBF}). One WLS fit (weight = BF<sup>0.75</sup>) of (0.64 − wOBA allowed)×333 on log ratings; intercept clamped ≥ 0. Matches the old “37-38” model.</>}
                  diagRows={[{ label: "score", e: fit.basic_pitching.diagnostics.weights }]} />;
              })()}
            </>
          )}
        </>
      )}
    </div>
  );
}
