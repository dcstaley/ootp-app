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

interface EventDiag { r2: number | null; rmse: number | null; spearman: number | null; pearson?: number | null; n: number; note?: string }
interface WobaHittingFit {
  modelType: string; split: string; minPA: number; rowCount: number;
  coefficients: {
    bb: { intercept: number; eye: number }; k: { intercept: number; k: number }; hr: { intercept: number; pow: number };
    h: { intercept: number; ba: number; bipba: number }; xbh: { logA: number; logB: number }; hbp: { constant: number };
    leagueNorm: { bb: number; k: number; hr: number; h: number; xbh: number };
  };
  diagnostics: Record<string, EventDiag>;
}
interface FitResp { available: boolean; error?: string; woba_hitting?: WobaHittingFit }

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

export function ModelTrainingPage() {
  const [data, setData] = useState<TrainingSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fit, setFit] = useState<FitResp | null>(null);
  const [fitLoading, setFitLoading] = useState(false);
  const [minPA, setMinPA] = useState(1000);

  const load = (reload = false) => {
    setLoading(true); setErr(null);
    fetch(`/api/training/summary${reload ? "?reload=true" : ""}`)
      .then((r) => r.json()).then((d: TrainingSummary) => setData(d))
      .catch((e) => setErr(String(e))).finally(() => setLoading(false));
  };
  const loadFit = (pa: number, reload = false) => {
    setFitLoading(true);
    fetch(`/api/training/fit?minPA=${pa}${reload ? "&reload=true" : ""}`)
      .then((r) => r.json()).then((d: FitResp) => setFit(d))
      .catch((e) => setErr(String(e))).finally(() => setFitLoading(false));
  };
  useEffect(() => { load(); loadFit(1000); }, []);

  // Pivot the cells into a league-row × (year/side)-column matrix for the table.
  const colKeys = data ? [...new Set(data.cells.map((c) => `${c.year} v${c.side}`))].sort() : [];
  const cellAt = (league: string, col: string) => data?.cells.find((c) => c.league === league && `${c.year} v${c.side}` === col);

  const th: React.CSSProperties = { textAlign: "right", padding: "6px 10px", fontSize: 11, color: C.sub, textTransform: "uppercase", letterSpacing: 0.3, borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap" };
  const td: React.CSSProperties = { textAlign: "right", padding: "6px 10px", fontSize: 13, borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap" };

  return (
    <div style={{ width: "100%", maxWidth: 1100 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0 }}>Model Training</h2>
        <button onClick={() => { load(true); loadFit(minPA, true); }} disabled={loading} style={{ ...inputStyle, cursor: "pointer", background: C.accent, color: "#fff" }}>{loading ? "Loading…" : "Reload data"}</button>
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

          {/* Trained model — wOBA hitting (parity-validated vs the old trainer) */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "22px 0 8px", flexWrap: "wrap" }}>
            <h3 style={{ margin: 0, fontSize: 14 }}>Trained model — wOBA Hitting</h3>
            <label style={{ fontSize: 12, color: C.sub, display: "inline-flex", alignItems: "center", gap: 5 }}>
              min PA
              <input type="number" value={minPA} min={0} step={100} onChange={(e) => setMinPA(Number(e.target.value))}
                style={{ ...inputStyle, width: 76, padding: "3px 6px", fontSize: 12 }} />
            </label>
            <button onClick={() => loadFit(minPA)} disabled={fitLoading} style={{ ...inputStyle, cursor: "pointer" }}>{fitLoading ? "Fitting…" : "Refit"}</button>
            {fit?.woba_hitting && <span style={{ fontSize: 12, color: C.sub }}>{fmt(fit.woba_hitting.rowCount)} observations (PA ≥ {fit.woba_hitting.minPA}) · split {fit.woba_hitting.split}</span>}
          </div>

          {fit && !fit.available && <p style={{ color: "#f87171", fontSize: 13 }}>Fit unavailable: {fit.error}</p>}
          {fit?.woba_hitting && (() => {
            const c = fit.woba_hitting.coefficients; const d = fit.woba_hitting.diagnostics;
            const Coef = ({ v }: { v: number }) => <code style={{ color: C.link }}>{sig(v)}</code>;
            const lines: { ev: string; form: React.ReactNode }[] = [
              { ev: "BB", form: <>BB/600 = <Coef v={c.bb.intercept} /> + <Coef v={c.bb.eye} />·ln(EYE)</> },
              { ev: "K", form: <>K/600 = <Coef v={c.k.intercept} /> + <Coef v={c.k.k} />·ln(K)</> },
              { ev: "HR", form: <>HR/600 = <Coef v={c.hr.intercept} /> + <Coef v={c.hr.pow} />·ln(POW)</> },
              { ev: "H", form: <>nonHR-H/600 = <Coef v={c.h.intercept} /> + <Coef v={c.h.ba} />·ln(BABIP) + <Coef v={c.h.bipba} />·ln(predBIP)</> },
              { ev: "XBH", form: <>XBH/H = <Coef v={c.xbh.logA} /> + <Coef v={c.xbh.logB} />·ln(GAP)</> },
              { ev: "HBP", form: <>HBP/600 = <Coef v={c.hbp.constant} /> (fixed)</> },
            ];
            return (
              <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "flex-start" }}>
                <div style={{ flex: "1 1 380px", minWidth: 320 }}>
                  <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 12px", background: C.panel, fontSize: 13, lineHeight: 1.9 }}>
                    {lines.map((l) => <div key={l.ev}>{l.form}</div>)}
                  </div>
                  <p style={{ margin: "8px 0 0", fontSize: 11, color: C.sub }}>
                    Per-event log-linear fits (weighted least squares, weight = PA<sup>0.75</sup>). League-norm scales:
                    BB <Coef v={c.leagueNorm.bb} />, K <Coef v={c.leagueNorm.k} />, HR <Coef v={c.leagueNorm.hr} />,
                    H <Coef v={c.leagueNorm.h} />, XBH <Coef v={c.leagueNorm.xbh} />. Reproduces the old trainer's
                    “37-38” model bit-for-bit.
                  </p>
                </div>
                <div style={{ flex: "1 1 360px", minWidth: 300 }}>
                  <div style={{ overflowX: "auto", border: `1px solid ${C.border}`, borderRadius: 8 }}>
                    <table style={{ borderCollapse: "collapse", width: "100%" }}>
                      <thead><tr>
                        <th style={{ ...th, textAlign: "left" }}>Event</th><th style={th}>R²</th><th style={th}>RMSE</th><th style={th}>Spearman</th><th style={th}>Pearson</th><th style={th}>N</th>
                      </tr></thead>
                      <tbody>
                        {["bb", "k", "hr", "h", "xbh"].map((ev) => {
                          const e = d[ev]!;
                          return (
                            <tr key={ev}>
                              <td style={{ ...td, textAlign: "left", textTransform: "uppercase" }}>{ev}</td>
                              <td style={td}>{e.r2 != null ? sig(e.r2, 4) : "—"}</td>
                              <td style={td}>{e.rmse != null ? sig(e.rmse, 3) : "—"}</td>
                              <td style={td}>{e.spearman != null ? sig(e.spearman, 4) : "—"}</td>
                              <td style={td}>{e.pearson != null ? sig(e.pearson, 4) : "—"}</td>
                              <td style={{ ...td, color: C.sub }}>{e.n}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <p style={{ margin: "8px 0 0", fontSize: 11, color: C.sub }}>
                    Pitching-wOBA and the two basic models, plus residual-bin diagnostics and recommended softcaps,
                    are the next M6 steps.
                  </p>
                </div>
              </div>
            );
          })()}
        </>
      )}
    </div>
  );
}
