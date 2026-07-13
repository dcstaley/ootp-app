// M6 — Model Training page. Loads the real per-(league, side, year) outcome CSVs and
// shows dataset coverage + integrity, the deployed model's coefficients and performance,
// the bake-off evaluation scoreboard, per-card residual diagnostics ("where the model
// misses"), and saved-model management (save / activate / delete). The data was
// collected in a neutral league environment, so outcomes sum directly. The dataset is
// grouped by (CID, variant, side): base and variant of a player are separate
// observations; vL/vR stay separate.

import { useEffect, useRef, useState } from "react";
import { C, inputStyle } from "./shared.ts";

type Side = "L" | "R";
interface FileStat { file: string; league: string; side: Side; year: number; rows: number; pa: number; bf: number }
interface CellStat { league: string; side: Side; year: number; rows: number; pa: number; bf: number }
interface DatasetIssue { severity: "error" | "warn"; scope: string; message: string }
interface DatasetValidation { ok: boolean; errors: number; warnings: number; excluded: string[]; issues: DatasetIssue[] }
interface TrainingSummary {
  available: boolean; dir: string; error?: string;
  files: FileStat[]; unparsedFiles: string[];
  leagues: string[]; years: number[]; cells: CellStat[];
  observations: number; hitterObs: number; pitcherObs: number;
  baseObs: number; variantObs: number; totalPA: number; totalBF: number;
  validation?: DatasetValidation;
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
interface GateStatus { status: "pass" | "warn"; notes: string[] }
interface ScoreRow { model: string; role: "hitter" | "pitcher"; evaluation: string; window: string; metrics: SbMetrics; gate?: GateStatus }
interface Scoreboard { minN: number; k: number; topN: number; years: number[]; trainWindow: number[]; rows: ScoreRow[] }
interface ScoreboardResp { available: boolean; error?: string; scoreboard?: Scoreboard }

interface CardResidual { name: string; cid: string; variant: boolean; side: "L" | "R"; pred: number; actual: number; valErrPts: number; vol: number; ratings: Record<string, number> }
interface ResidGrid { row: string; col: string; cells: { n: number; meanValErrPts: number; interErrPts: number; sumVol: number }[][] }
interface RatingDist { rating: string; min: number; max: number; median: number; terciles: [number, number]; tierCounts: { L: number; M: number; H: number }; hist: number[] }
interface SignatureBucket { sig: Record<string, "L" | "M" | "H">; n: number; sumVol: number; meanValErrPts: number; stdValErrPts: number; members: CardResidual[] }
interface MarginalTier { band: string; n: number; sumVol: number; meanErr: number }
interface RatingMarginal { rating: string; bands3: MarginalTier[]; bands5: MarginalTier[] }
interface ResidualModel { n: number; r2: number; weighted: boolean; intercept: number; perRating: { rating: string; linear: number; quad: number }[]; interactions: { a: string; b: string; coef: number }[] }
interface ResidualAnalysis {
  role: "hitter" | "pitcher"; window: number[]; n: number; minN: number; includeVariants: boolean; weighted: boolean;
  ratings: string[]; sigRatings: string[]; bands: string[]; thresholds: Record<string, [number, number]>;
  distributions: RatingDist[]; marginals: RatingMarginal[]; residualModel: ResidualModel;
  over: CardResidual[]; under: CardResidual[]; signatures: SignatureBucket[]; grids: ResidGrid[];
}
interface ResidResp { available: boolean; error?: string; residuals?: ResidualAnalysis }

interface PlatoonExposure {
  r_hit_split: number; l_hit_split: number; s_hit_split: number; r_pitch_split: number; l_pitch_split: number;
  teamVR: number; teamVL: number;
  hit: { hand: "R" | "L" | "S"; vsRHP: number; vsLHP: number; pa: number }[];
  pit: { hand: "R" | "L"; vsRHB: number; vsLHB: number; bf: number }[];
}
interface TrainedModelSummary {
  id: string; name: string; datasetRoot: string; window: number[]; minPA: number; includeVariants: boolean;
  hasEventForm: boolean; platoon?: PlatoonExposure;
  formatVersion?: number; // evaluation-semantics version at train time; absent ⇒ predates versioning (v1)
  currentFormatVersion: number; // the server's live MODEL_FORMAT_VERSION
  stale: boolean; // artifact predates current evaluation semantics — re-save to retrain
  validation?: { errors: number; warnings: number; excluded: string[]; forced: boolean }; // dataset state at train time
  diag: { hitPearson: number | null; pitPearson: number | null; rowsHit: number; rowsPit: number };
  trainedAt: string; notes?: string;
}
interface ModelsResp { models?: TrainedModelSummary[]; activeId?: string | null }

type FitTab = "woba_hitting" | "woba_pitching" | "basic_hitting" | "basic_pitching";
// The DEPLOYED forms (must match server.ts saveTrainedModel): raw-poly hitting + log pitching.
// Used to filter the bake-off scoreboard down to JUST the live model on the Active-model tab.
const DEPLOYED_HIT_MODEL = "woba·rawpoly";
const DEPLOYED_PIT_MODEL = "woba";

// The DEPLOYED #2 eventForm's fitted curves (from /api/training/active-eventform) — what
// actually scores, shown in the coefficient panel instead of the retired log-linear baseline.
interface DeployedCurve { beta: number[]; mu: number; sd: number; curve: { kind: "log" | "rawpoly" | "logpoly"; degree?: number } }
interface DeployedH { beta: number[]; rating: { curve: { kind: string } }; bip: { curve: { kind: string } } }
interface DeployedForm {
  hit: { bb: DeployedCurve; k: DeployedCurve; hr: DeployedCurve; xbh: DeployedCurve; h: DeployedH };
  pit: { bb: DeployedCurve; k: DeployedCurve; hr: DeployedCurve; h: DeployedH };
}
const fNum = (x: number) => x.toFixed(4);
const fTerm = (x: number) => `${x >= 0 ? "+ " : "− "}${Math.abs(x).toFixed(4)}`;
// One event's deployed curve as a readable formula in the RAW rating. log → a + b·ln(R);
// raw-poly degree-2 → the z-scored quadratic EXPANDED to A + B·R + C·R² (so it reads as a
// real polynomial in the rating, not z-score space).
function curveText(rating: string, ev: DeployedCurve): string {
  const b0 = ev.beta[0] ?? 0, b1 = ev.beta[1] ?? 0, b2 = ev.beta[2] ?? 0, mu = ev.mu, sd = ev.sd || 1;
  if (ev.curve.kind === "log") return `${fNum(b0)} ${fTerm(b1)}·ln(${rating})`;
  if (ev.curve.kind === "rawpoly" && (ev.curve.degree ?? 1) >= 2) {
    const A = b0 - (b1 * mu) / sd + (b2 * mu * mu) / (sd * sd);
    const B = b1 / sd - (2 * b2 * mu) / (sd * sd);
    const Cq = b2 / (sd * sd);
    return `${fNum(A)} ${fTerm(B)}·${rating} ${fTerm(Cq)}·${rating}²`;
  }
  return `${fNum(b0 - (b1 * mu) / sd)} ${fTerm(b1 / sd)}·${rating}`; // raw-poly degree 1
}
const hText = (rating: string, h: DeployedH) => `${fNum(h.beta[0] ?? 0)} ${fTerm(h.beta[1] ?? 0)}·ln(${rating}) ${fTerm(h.beta[2] ?? 0)}·ln(predBIP)`;
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
          <th style={th} title="Monotonicity / extrapolation gate (in-sample fit): ✓ curve never turns over; ⚠ a per-event curve reverses direction in-domain">Gate</th>
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
              <td style={{ ...td, fontWeight: 700, color: !r.gate ? C.sub : r.gate.status === "warn" ? "#eab308" : "#86efac" }} title={r.gate?.notes.join("; ") || undefined}>{!r.gate ? "" : r.gate.status === "warn" ? "⚠" : "✓"}</td>
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

// Independent min PA/BF + variant (+ optional weighting) control for a section.
function SectionControls({ min, onMin, variants, onVariants, weighted, onWeighted }: {
  min: number; onMin: (v: number) => void; variants: boolean; onVariants: (v: boolean) => void;
  weighted?: boolean; onWeighted?: (v: boolean) => void;
}) {
  const apply = (el: HTMLInputElement) => { const v = Math.max(0, Number(el.value) || 0); if (v !== min) onMin(v); };
  const lbl: React.CSSProperties = { fontSize: 12, color: C.sub, display: "inline-flex", alignItems: "center", gap: 4 };
  return (
    <>
      <label style={lbl} title="Minimum PA (hitters) / BF (pitchers) for this section only.">min PA/BF
        <input type="number" key={min} defaultValue={min} min={0} step={100}
          onKeyDown={(e) => { if (e.key === "Enter") apply(e.target as HTMLInputElement); }} onBlur={(e) => apply(e.target)}
          style={{ ...inputStyle, width: 66, padding: "3px 6px", fontSize: 12 }} />
      </label>
      <label style={lbl} title="Off = base cards only (excludes variants from this section's data + fit).">
        <input type="checkbox" checked={variants} onChange={(e) => onVariants(e.target.checked)} /> variants
      </label>
      {onWeighted && <label style={lbl} title="On = PA^0.75-weighted (matches the fit; high-PA cards dominate). Off = each card counts once.">
        <input type="checkbox" checked={!!weighted} onChange={(e) => onWeighted(e.target.checked)} /> PA-weighted
      </label>}
    </>
  );
}

// "Where the model misses": leaderboards + archetype buckets (expandable) + a
// selectable 2D interaction grid.
const BAND_C: Record<string, { bg: string; fg: string; bd: string }> = {
  H: { bg: "rgba(34,197,94,0.16)", fg: "#86efac", bd: "#22c55e" },
  L: { bg: "rgba(239,68,68,0.16)", fg: "#fca5a5", bd: "#ef4444" },
  M: { bg: "rgba(154,163,173,0.14)", fg: "#9aa3ad", bd: "#3a414b" },
};
const bandChip = (r: string, b: string) => (
  <span key={r} style={{ display: "inline-block", padding: "0 4px", borderRadius: 3, fontSize: 10, fontWeight: 700, marginRight: 3, background: BAND_C[b]?.bg, color: BAND_C[b]?.fg, border: `1px solid ${BAND_C[b]?.bd}` }}>{r.slice(0, 4).toUpperCase()}·{b}</span>
);
// One rating's pool distribution: histogram (bars coloured by L/M/H tercile) + counts.
function DistView({ d }: { d: RatingDist }) {
  const maxH = Math.max(1, ...d.hist);
  const tierOf = (i: number) => { const c = d.min + (i + 0.5) * (d.max - d.min) / d.hist.length; return c <= d.terciles[0] ? "L" : c >= d.terciles[1] ? "H" : "M"; };
  return (
    <div style={{ flex: "1 1 130px", minWidth: 118, border: `1px solid ${C.border}`, borderRadius: 6, padding: "5px 7px" }}>
      <div style={{ fontSize: 11, fontWeight: 700 }}>{d.rating.toUpperCase()} <span style={{ color: C.sub, fontWeight: 400 }}>{d.min}–{d.max}</span></div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 1, height: 30, margin: "3px 0" }}>
        {d.hist.map((h, i) => <div key={i} title={`~${Math.round(d.min + (i / d.hist.length) * (d.max - d.min))} · n${h}`} style={{ flex: 1, height: `${Math.max(3, (h / maxH) * 100)}%`, background: BAND_C[tierOf(i)]!.bd, opacity: 0.85, borderRadius: 1 }} />)}
      </div>
      <div style={{ fontSize: 10, color: C.sub }}><span style={{ color: "#fca5a5" }}>L {d.tierCounts.L}</span> · M {d.tierCounts.M} · <span style={{ color: "#86efac" }}>H {d.tierCounts.H}</span> · cuts ≤{d.terciles[0]}/≥{d.terciles[1]}</div>
    </div>
  );
}

// 1-D marginal table: mean valuation error per rating × tier (3- or 5-band).
function MarginalTable({ marginals, mode }: { marginals: RatingMarginal[]; mode: "bands3" | "bands5" }) {
  const bands = mode === "bands5" ? ["XL", "L", "M", "H", "XH"] : ["L", "M", "H"];
  return (
    <div style={{ overflowX: "auto", border: `1px solid ${C.border}`, borderRadius: 6 }}>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead><tr><th style={{ ...th, textAlign: "left" }}>Rating</th>{bands.map((b) => <th key={b} style={th}>{b}</th>)}</tr></thead>
        <tbody>{marginals.map((m) => (
          <tr key={m.rating}>
            <td style={{ ...td, textAlign: "left", fontWeight: 600 }}>{m.rating.toUpperCase()}</td>
            {m[mode].map((t, i) => <td key={i} title={`n${t.n} · ${fmt(t.sumVol)} vol`} style={{ ...td, fontWeight: 700, color: t.n ? errFg(t.meanErr) : C.sub, background: t.n ? errBg(t.meanErr) : undefined }}>{t.n ? pm(t.meanErr) : "—"}</td>)}
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

// The fitted residual meta-model: r² + per-rating linear/quad + top interactions.
function ResidualModelView({ rm }: { rm: ResidualModel }) {
  const coefCell = (v: number) => <td style={{ ...td, fontWeight: 700, color: errFg(v), background: errBg(v) }}>{pm(v)}</td>;
  return (
    <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "flex-start" }}>
      <div style={{ flex: "1 1 300px", minWidth: 280 }}>
        <div style={{ fontSize: 13, marginBottom: 6 }}><b style={{ color: rm.r2 > 0.2 ? "#fbbf24" : C.text }}>{(rm.r2 * 100).toFixed(0)}%</b> of the model's mis-valuation is <b>systematic</b> (ratings-explainable, r²={rm.r2.toFixed(2)}); the rest is card-specific noise.</div>
        <div style={{ overflowX: "auto", border: `1px solid ${C.border}`, borderRadius: 6 }}>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead><tr><th style={{ ...th, textAlign: "left" }}>Rating</th><th style={th} title="over-valuation change per +1 SD of the rating">linear</th><th style={th} title="curvature: negative = the miss worsens at the extremes">quad</th></tr></thead>
            <tbody>{rm.perRating.map((p) => <tr key={p.rating}><td style={{ ...td, textAlign: "left", fontWeight: 600 }}>{p.rating.toUpperCase()}</td>{coefCell(p.linear)}{coefCell(p.quad)}</tr>)}</tbody>
          </table>
        </div>
        <p style={{ margin: "4px 0 0", fontSize: 10, color: C.sub }}>wOBA points per ±1 SD. <span style={{ color: "#fca5a5" }}>+</span> = model over-values as the rating rises; <span style={{ color: "#86efac" }}>−</span> = under-values. Negative quad = the miss accelerates at the extremes.</p>
      </div>
      <div style={{ flex: "1 1 240px", minWidth: 220 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 4 }}>Top interactions (pts per SD·SD)</div>
        {rm.interactions.slice(0, 8).map((x) => (
          <div key={x.a + x.b} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, padding: "2px 6px", borderBottom: `1px solid ${C.border}` }}>
            <span style={{ flex: 1 }}>{x.a.toUpperCase()} × {x.b.toUpperCase()}</span>
            <span style={{ width: 46, textAlign: "right", fontWeight: 700, color: errFg(x.coef) }}>{pm(x.coef)}</span>
          </div>
        ))}
        <p style={{ margin: "4px 0 0", fontSize: 10, color: C.sub }}>Non-zero = a true 2-way interaction the additive model can't capture (combination valued beyond the sum of its parts).</p>
      </div>
    </div>
  );
}

function MissesView({ a }: { a: ResidualAnalysis }) {
  const vol = a.role === "hitter" ? "PA" : "BF";
  const [gi, setGi] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [openCard, setOpenCard] = useState<string | null>(null);
  const [marginMode, setMarginMode] = useState<"bands3" | "bands5">("bands3");
  const [gridMode, setGridMode] = useState<"meanValErrPts" | "interErrPts">("interErrPts");
  const grid = a.grids[Math.min(gi, a.grids.length - 1)];
  // band a rating value vs the pool terciles, for colour (H = strong → green).
  const ratingColor = (r: string, v: number) => { const t = a.thresholds[r]; if (!t) return C.text; return v <= t[0] ? "#fca5a5" : v >= t[1] ? "#86efac" : C.sub; };
  const sideChip = (s: "L" | "R") => (
    <span style={{ display: "inline-block", padding: "0 5px", borderRadius: 3, fontSize: 9, fontWeight: 700, marginLeft: 5, verticalAlign: "middle", background: s === "L" ? "rgba(168,85,247,0.28)" : "rgba(34,197,94,0.24)", color: s === "L" ? "#d8b4fe" : "#86efac", border: `1px solid ${s === "L" ? "#a855f7" : "#22c55e"}` }}>v{s}</span>
  );
  const card = (c: CardResidual, k: number) => {
    const ck = `${c.cid}|${c.variant}|${c.side}`;
    const isOpen = openCard === ck;
    return (
      <div key={k}>
        <div onClick={() => setOpenCard(isOpen ? null : ck)} title="click for ratings"
          style={{ display: "flex", alignItems: "center", gap: 8, padding: "2px 6px", borderBottom: `1px solid ${C.border}`, fontSize: 12, cursor: "pointer", background: isOpen ? C.headActive : undefined }}>
          <span style={{ width: 42, textAlign: "right", fontWeight: 700, color: errFg(c.valErrPts) }}>{pm(c.valErrPts)}</span>
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.variant && <span style={{ color: C.star }} title="variant">★</span>}{c.name}{sideChip(c.side)}</span>
          <span style={{ color: C.sub, fontSize: 11 }}>{c.pred.toFixed(3)}→{c.actual.toFixed(3)}</span>
          <span style={{ width: 46, textAlign: "right", color: C.sub, fontSize: 11 }}>{fmt(c.vol)}</span>
        </div>
        {isOpen && (
          <div style={{ padding: "3px 8px 4px 50px", background: C.bg, borderBottom: `1px solid ${C.border}`, fontSize: 11, display: "flex", gap: 10, flexWrap: "wrap" }}>
            {a.ratings.map((r) => <span key={r}>{r.toUpperCase()} <b style={{ color: ratingColor(r, c.ratings[r] ?? 0) }}>{c.ratings[r]}</b></span>)}
          </div>
        )}
      </div>
    );
  };
  return (
    <div style={{ marginTop: 8 }}>
      {/* Pool distribution per rating — judge the cuts / re-binning */}
      <div style={{ fontSize: 12, fontWeight: 700, color: C.text, margin: "0 0 4px" }}>Rating distribution of this pool ({a.n} cards) — bars coloured by <span style={{ color: "#fca5a5" }}>L</span>/M/<span style={{ color: "#86efac" }}>H</span> tercile</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>{a.distributions.map((d) => <DistView key={d.rating} d={d} />)}</div>

      {/* Systematic error structure — the app-fitted residual model + the 1-D marginals */}
      <div style={{ fontSize: 12, fontWeight: 700, color: C.text, margin: "0 0 6px" }}>Systematic error structure (computed) — what the model gets wrong, and how much is real</div>
      <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "flex-start", marginBottom: 14 }}>
        <div style={{ flex: "2 1 540px", minWidth: 320 }}><ResidualModelView rm={a.residualModel} /></div>
        <div style={{ flex: "1 1 280px", minWidth: 260 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: C.text }}>Marginal err by tier</span>
            <span style={{ display: "inline-flex", border: `1px solid ${C.border}`, borderRadius: 4, overflow: "hidden" }}>
              {([["bands3", "3-band"], ["bands5", "5-band"]] as const).map(([m, lbl]) => (
                <button key={m} onClick={() => setMarginMode(m)} style={{ ...inputStyle, border: "none", borderRadius: 0, cursor: "pointer", padding: "3px 8px", fontSize: 11, background: marginMode === m ? C.accent : C.input, color: marginMode === m ? "#fff" : C.sub }}>{lbl}</button>
              ))}
            </span>
          </div>
          <MarginalTable marginals={a.marginals} mode={marginMode} />
          <p style={{ margin: "4px 0 0", fontSize: 10, color: C.sub }}>One rating's effect, averaging over the rest. <span style={{ color: "#fca5a5" }}>+</span> over-values, <span style={{ color: "#86efac" }}>−</span> under-values. 5-band exposes the tails.</p>
        </div>
      </div>

      <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "flex-start" }}>
      {/* Leaderboards */}
      <div style={{ flex: "1 1 320px", minWidth: 300 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#fca5a5", margin: "0 0 2px" }}>Most over-valued (model &gt; reality)</div>
        <div style={{ border: `1px solid ${C.border}`, borderRadius: 6 }}>{a.over.map(card)}</div>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#86efac", margin: "10px 0 2px" }}>Most under-valued (model &lt; reality)</div>
        <div style={{ border: `1px solid ${C.border}`, borderRadius: 6 }}>{a.under.map(card)}</div>
        <p style={{ margin: "4px 0 0", fontSize: 10, color: C.sub }}>err in wOBA points · pred→actual wOBA · {vol} · <span style={{ color: "#d8b4fe" }}>vL</span>/<span style={{ color: "#86efac" }}>vR</span> are separate observations · ★ = variant · <b style={{ color: C.text }}>click a row for ratings</b>.</p>
      </div>
      {/* Full-signature buckets (expandable) */}
      <div style={{ flex: "1 1 380px", minWidth: 340 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: C.text, margin: "0 0 2px" }}>Card-shape signatures — full {a.sigRatings.map((r) => r.toUpperCase()).join("·")} combos · {a.signatures.length} groups (n≥2) · click to list players</div>
        <div style={{ maxHeight: 360, overflowY: "auto", border: `1px solid ${C.border}`, borderRadius: 6 }}>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead><tr><th style={{ ...th, textAlign: "left" }}>Signature</th><th style={th}>n</th><th style={th}>{vol}</th><th style={th} title="weighted mean ± within-bucket spread">err ± σ</th></tr></thead>
            <tbody>{a.signatures.map((b) => { const key = a.sigRatings.map((r) => b.sig[r]).join(""); return [
              <tr key={key} onClick={() => setOpen(open === key ? null : key)} style={{ cursor: "pointer" }}>
                <td style={{ ...td, textAlign: "left", whiteSpace: "nowrap" }}>{open === key ? "▾ " : "▸ "}{a.sigRatings.map((r) => bandChip(r, b.sig[r]!))}</td>
                <td style={{ ...td, color: C.sub }}>{b.n}</td>
                <td style={{ ...td, color: C.sub, fontSize: 11 }}>{fmt(b.sumVol)}</td>
                <td style={{ ...td, fontWeight: 700, color: errFg(b.meanValErrPts), background: errBg(b.meanValErrPts) }}>{pm(b.meanValErrPts)} <span style={{ fontWeight: 400, color: C.sub, fontSize: 11 }}>±{b.stdValErrPts}</span></td>
              </tr>,
              open === key ? (
                <tr key={key + "-m"}><td colSpan={4} style={{ padding: 0, borderBottom: `1px solid ${C.border}` }}>
                  <div style={{ maxHeight: 200, overflowY: "auto", background: C.bg }}>{b.members.map(card)}</div>
                </td></tr>
              ) : null,
            ]; })}</tbody>
          </table>
        </div>
        <p style={{ margin: "4px 0 0", fontSize: 10, color: C.sub }}>Every populated combination of the {a.sigRatings.length} ratings (each L/M/H) — a card shares its whole profile with its bucket. err ± σ in wOBA pts, {a.weighted ? `${vol}-weighted` : "unweighted"}. gap shown on click (its XBH effect is in the trained-model residual panel).</p>
      </div>
      {/* Selectable 2D interaction grid (any rating pair, incl gap) */}
      <div style={{ flex: "1 1 300px", minWidth: 280 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "0 0 4px", flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: C.text }}>Interaction grid</span>
          <select value={gi} onChange={(e) => setGi(Number(e.target.value))} style={{ ...inputStyle, padding: "2px 6px", fontSize: 12 }}>
            {a.grids.map((g, i) => <option key={i} value={i}>{g.row.toUpperCase()} × {g.col.toUpperCase()}</option>)}
          </select>
          <span style={{ display: "inline-flex", border: `1px solid ${C.border}`, borderRadius: 4, overflow: "hidden" }}>
            {([["interErrPts", "interaction"], ["meanValErrPts", "raw"]] as const).map(([m, lbl]) => (
              <button key={m} onClick={() => setGridMode(m)} title={m === "interErrPts" ? "raw − (row+col marginals): true 2-way interaction" : "raw mean error (mostly the 1-D marginals)"} style={{ ...inputStyle, border: "none", borderRadius: 0, cursor: "pointer", padding: "3px 8px", fontSize: 11, background: gridMode === m ? C.accent : C.input, color: gridMode === m ? "#fff" : C.sub }}>{lbl}</button>
            ))}
          </span>
        </div>
        {grid && (
          <div style={{ display: "grid", gridTemplateColumns: `34px repeat(3, 1fr)`, gap: 2, maxWidth: 340 }}>
            <span style={{ fontSize: 9, color: C.sub, alignSelf: "end", textAlign: "right" }}>{grid.row.toUpperCase()}↓</span>
            {a.bands.map((b) => <span key={b} style={{ textAlign: "center", fontSize: 10, color: C.sub }}>{grid.col.toUpperCase()} {b}</span>)}
            {grid.cells.map((row, ri) => [
              <span key={`r${ri}`} style={{ fontSize: 10, color: C.sub, alignSelf: "center", textAlign: "right" }}>{a.bands[ri]}</span>,
              ...row.map((cell, ci) => { const v = cell[gridMode]; return (
                <div key={`${ri}-${ci}`} title={`${grid.row} ${a.bands[ri]} × ${grid.col} ${a.bands[ci]} · n=${cell.n} · raw ${pm(cell.meanValErrPts)} · interaction ${pm(cell.interErrPts)} · ${vol} ${fmt(cell.sumVol)}`}
                  style={{ height: 34, borderRadius: 3, background: cell.n ? errBg(v) : C.input, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: cell.n ? errFg(v) : C.sub }}>
                  {cell.n ? pm(v) : "—"}<span style={{ fontSize: 9, fontWeight: 400, color: C.sub }}>n{cell.n}</span>
                </div>
              ); }),
            ])}
          </div>
        )}
        <p style={{ margin: "4px 0 0", fontSize: 10, color: C.sub }}><b style={{ color: C.text }}>{gridMode === "interErrPts" ? "Interaction" : "Raw"}</b> view · <span style={{ color: "#fca5a5" }}>red</span> over / <span style={{ color: "#86efac" }}>green</span> under (wOBA pts, {a.weighted ? `${vol}-wt` : "unwt"}). <b style={{ color: C.text }}>interaction</b> = raw − the 1-D marginals, so non-zero = a true 2-way effect; <b style={{ color: C.text }}>raw</b> mostly re-shows the marginals.</p>
      </div>
      </div>
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
  const [fitTab, setFitTab] = useState<FitTab>("woba_hitting");
  const [sb, setSb] = useState<ScoreboardResp | null>(null);
  const [sbLoading, setSbLoading] = useState(false);
  const [years, setYears] = useState<number[]>([]); // GLOBAL training window (empty ⇒ server default: recent 2yr)
  const [resid, setResid] = useState<ResidResp | null>(null);
  const [residLoading, setResidLoading] = useState(false);
  const [residRole, setResidRole] = useState<"hitter" | "pitcher">("hitter");
  // Latest-wins tokens per section: rapid window/section toggles fire overlapping
  // fetches (e.g. toggleYear chains all three loaders); only the NEWEST response per
  // section may install its result, so a slow older response can't clobber a newer one.
  const fitSeq = useRef(0);
  const sbSeq = useRef(0);
  const residSeq = useRef(0);
  const activeSbSeq = useRef(0);
  // Each of the three sections has INDEPENDENT min PA/BF + variant filters (default
  // 1000 + variants on); they don't affect each other. The window above is shared.
  const [fitMin, setFitMin] = useState(1000); const [fitVar, setFitVar] = useState(true);
  const [sbMin, setSbMin] = useState(1000); const [sbVar, setSbVar] = useState(true);
  const [residMin, setResidMin] = useState(1000); const [residVar, setResidVar] = useState(true); const [residWeighted, setResidWeighted] = useState(true);
  const [models, setModels] = useState<TrainedModelSummary[]>([]); const [modelName, setModelName] = useState(""); const [savingModel, setSavingModel] = useState(false);
  const [activeModelId, setActiveModelId] = useState<string | null>(null);
  const [tab, setTab] = useState<"active" | "bakeoff">("active"); // top-level: deployed model vs candidate comparison
  // The deployed-performance table reflects the ACTIVE model on ITS frozen config, not the page window.
  const [activeSb, setActiveSb] = useState<ScoreboardResp | null>(null);
  const [activeSbLoading, setActiveSbLoading] = useState(false);
  const [activeForm, setActiveForm] = useState<DeployedForm | null>(null); // deployed #2 curves for the coefficient panel
  // §10.8 frame-correction v2 — experimental A/B transform mode (server-side re-scores on switch).
  const [transformMode, setTransformMode] = useState<"own-gap" | "frame-v2">("own-gap");
  const [hasTrainingMeans, setHasTrainingMeans] = useState(false);

  const yq = (ys: number[]) => (ys.length ? `&years=${ys.join(",")}` : "");
  const vq = (incl: boolean) => `&variants=${incl ? "all" : "base"}`;
  const load = (reload = false) => {
    setLoading(true); setErr(null);
    fetch(`/api/training/summary${reload ? "?reload=true" : ""}`)
      .then((r) => r.json()).then((d: TrainingSummary) => { setData(d); setYears((cur) => (cur.length ? cur : (d.years ?? []).slice(-2))); })
      .catch((e) => setErr(String(e))).finally(() => setLoading(false));
  };
  const loadFit = (ys: number[], pa = fitMin, incl = fitVar, reload = false) => {
    const seq = ++fitSeq.current;
    setFitLoading(true);
    fetch(`/api/training/fit?minPA=${pa}${vq(incl)}${yq(ys)}${reload ? "&reload=true" : ""}`)
      .then((r) => r.json()).then((d: FitResp) => { if (seq === fitSeq.current) setFit(d); })
      .catch((e) => { if (seq === fitSeq.current) setErr(String(e)); })
      .finally(() => { if (seq === fitSeq.current) setFitLoading(false); });
  };
  const loadSb = (ys: number[], pa = sbMin, incl = sbVar, reload = false) => {
    const seq = ++sbSeq.current;
    setSbLoading(true);
    fetch(`/api/training/scoreboard?minN=${pa}&k=5${vq(incl)}${yq(ys)}${reload ? "&reload=true" : ""}`)
      .then((r) => r.json()).then((d: ScoreboardResp) => { if (seq === sbSeq.current) setSb(d); })
      .catch((e) => { if (seq === sbSeq.current) setErr(String(e)); })
      .finally(() => { if (seq === sbSeq.current) setSbLoading(false); });
  };
  const loadResid = (role: "hitter" | "pitcher", ys: number[], pa = residMin, incl = residVar, wt = residWeighted, reload = false) => {
    const seq = ++residSeq.current;
    setResidLoading(true);
    return fetch(`/api/training/residuals?role=${role}&minN=${pa}${vq(incl)}&weighted=${wt}${yq(ys)}${reload ? "&reload=true" : ""}`)
      .then((r) => r.json()).then((d: ResidResp) => { if (seq === residSeq.current) setResid(d); })
      .catch((e) => { if (seq === residSeq.current) setErr(String(e)); })
      .finally(() => { if (seq === residSeq.current) setResidLoading(false); });
  };
  const applyModelsResp = (d: ModelsResp) => { setModels(d.models ?? []); setActiveModelId(d.activeId ?? null); };
  const loadModels = () => fetch("/api/training/models").then((r) => r.json()).then((d: ModelsResp) => {
    applyModelsResp(d);
    const m = (d.models ?? []).find((x) => x.id === d.activeId); // open the page reflecting the live model's config
    if (m) loadModelConfig(m);
    else { loadFit([]); loadSb([]); loadResid(residRole, []); } // no active model → default-window view
  }).catch((e) => setErr(String(e)));
  const saveModel = () => {
    const name = modelName.trim(); if (!name) return;
    setSavingModel(true);
    fetch("/api/training/models/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, window: years, minPA: fitMin, includeVariants: fitVar }) })
      .then((r) => r.json()).then((d) => { if (d.ok) { applyModelsResp(d); setModelName(""); } else setErr(d.error); })
      .catch((e) => setErr(String(e))).finally(() => setSavingModel(false));
  };
  const deleteModel = (id: string) => {
    const m = models.find((x) => x.id === id);
    const activeNote = id === activeModelId ? " It is the ACTIVE live-scoring model." : "";
    if (!window.confirm(`Delete trained model “${m?.name ?? id}”?${activeNote} This can't be undone.`)) return;
    fetch(`/api/training/models/delete?id=${encodeURIComponent(id)}`, { method: "POST" }).then((r) => r.json()).then((d: ModelsResp) => applyModelsResp(d)).catch((e) => setErr(String(e)));
  };
  // Activate a saved model for live scoring (grid + optimizer + calibration).
  const activateModel = (id: string) => fetch(`/api/training/models/activate?id=${encodeURIComponent(id)}`, { method: "POST" })
    .then((r) => r.json()).then((d: ModelsResp & { ok?: boolean; error?: string }) => {
      if (d.ok === false) { setErr(d.error ?? "activate failed"); return; }
      applyModelsResp(d);
      const m = (d.models ?? []).find((x) => x.id === id); // sync the WHOLE page (window + every section) to the now-active model
      if (m) loadModelConfig(m);
    }).catch((e) => setErr(String(e)));
  // Push a saved model's CONFIG into the page — the GLOBAL window + EVERY section's min/variants —
  // and reload fit / scoreboard / residuals so the whole Active-model tab reflects that model.
  const loadModelConfig = (m: TrainedModelSummary) => {
    setYears(m.window);
    setFitMin(m.minPA); setFitVar(m.includeVariants);
    setSbMin(m.minPA); setSbVar(m.includeVariants);
    setResidMin(m.minPA); setResidVar(m.includeVariants);
    loadFit(m.window, m.minPA, m.includeVariants);
    loadSb(m.window, m.minPA, m.includeVariants);
    loadResid(residRole, m.window, m.minPA, m.includeVariants);
  };
  useEffect(() => { load(); loadModels(); loadTransformMode(); }, []); // loadModels routes to the active model's config (or default-window loads)
  // Deployed-performance scoreboard: scoped to the ACTIVE model's OWN window/min/variants
  // (independent of the page's exploration window); refetched whenever the active model changes.
  const loadActiveSb = (m: TrainedModelSummary) => {
    const seq = ++activeSbSeq.current;
    setActiveSbLoading(true);
    fetch(`/api/training/scoreboard?minN=${m.minPA}&k=5${vq(m.includeVariants)}${yq(m.window)}`)
      .then((r) => r.json()).then((d: ScoreboardResp) => { if (seq === activeSbSeq.current) setActiveSb(d); })
      .catch((e) => { if (seq === activeSbSeq.current) setErr(String(e)); })
      .finally(() => { if (seq === activeSbSeq.current) setActiveSbLoading(false); });
  };
  useEffect(() => {
    const m = models.find((x) => x.id === activeModelId);
    if (m) loadActiveSb(m); else setActiveSb(null);
  }, [activeModelId, models]);
  // §10.8 frame correction — current transform mode + whether the active model can support frame-v2.
  const loadTransformMode = () => fetch("/api/training/transform-mode").then((r) => r.json())
    .then((d: { mode: "own-gap" | "frame-v2"; hasTrainingMeans: boolean }) => { setTransformMode(d.mode); setHasTrainingMeans(!!d.hasTrainingMeans); })
    .catch((e) => setErr(String(e)));
  // Switch transform mode. Server clears the scoring cache (re-scores everything), so refresh the
  // active-model views on success; surfaces the 400 error (e.g. frame-v2 without trainingMeans).
  const applyTransformMode = (mode: "own-gap" | "frame-v2") => fetch(`/api/training/transform-mode?mode=${mode}`, { method: "POST" })
    .then((r) => r.json()).then((d: { ok: boolean; mode?: "own-gap" | "frame-v2"; hasTrainingMeans?: boolean; error?: string }) => {
      if (!d.ok) { setErr(d.error ?? "frame-correction switch failed"); return; }
      setErr(null);
      setTransformMode(d.mode ?? mode);
      if (d.hasTrainingMeans != null) setHasTrainingMeans(d.hasTrainingMeans);
      const m = models.find((x) => x.id === activeModelId); // re-scored server-side → refresh this model's views
      if (m) { loadModelConfig(m); loadActiveSb(m); }
    }).catch((e) => setErr(String(e)));
  useEffect(() => { // deployed curves for the coefficient panel (follows the active model)
    let stale = false;
    fetch("/api/training/active-eventform").then((r) => r.json())
      .then((d) => { if (!stale) setActiveForm(d.eventForm ?? null); })
      .catch((e) => { if (!stale) setErr(String(e)); });
    return () => { stale = true; };
  }, [activeModelId]);
  // Changing the GLOBAL window reloads all three (each with its own section settings).
  const toggleYear = (y: number) => {
    const next = (years.includes(y) ? years.filter((x) => x !== y) : [...years, y]).sort((a, b) => a - b);
    if (!next.length) return; // keep at least one year
    setYears(next); loadFit(next); loadSb(next); loadResid(residRole, next);
  };
  const chooseResidRole = (role: "hitter" | "pitcher") => { setResidRole(role); loadResid(role, years); };

  // Pivot the cells into a league-row × (year/side)-column matrix for the table.
  const colKeys = data ? [...new Set(data.cells.map((c) => `${c.year} v${c.side}`))].sort() : [];
  const cellAt = (league: string, col: string) => data?.cells.find((c) => c.league === league && `${c.year} v${c.side}` === col);
  const excludedSet = new Set(data?.validation?.excluded ?? []); // "league|year" cells dropped from modeling (shown red)
  const activeModel = models.find((m) => m.id === activeModelId); // the live scoring model (● in the table)

  return (
    <div style={{ width: "100%", maxWidth: 1100 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0 }}>Model Training</h2>
        <button onClick={() => { load(true); loadFit(years, fitMin, fitVar, true); loadSb(years, sbMin, sbVar, true); loadResid(residRole, years, residMin, residVar, residWeighted, true); }} disabled={loading} style={{ ...inputStyle, cursor: "pointer", background: C.accent, color: "#fff" }}>{loading ? "Loading…" : "Reload data"}</button>
        {data?.dir && <span style={{ fontSize: 13, color: C.sub }}>source: <code style={{ color: C.text }}>{data.dir}</code></span>}
      </div>
      <p style={{ margin: "0 0 16px", color: C.sub, fontSize: 13, maxWidth: 820 }}>
        The real per-(league, side, year) season-outcome dataset the trainer fits against, collected in a
        <b style={{ color: C.text }}> neutral league environment</b> (no park, neutral era) so outcomes sum
        directly. Observations are grouped by <b style={{ color: C.text }}>(card, variant, side)</b> — base
        and variant of a player are separate; vL and vR stay separate; outcomes are summed across every
        league/year a card appears in.
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

          {data.validation && data.validation.issues.length > 0 && (
            <div style={{ marginBottom: 18, border: `1px solid ${data.validation.ok ? "#f59e0b" : "#ef4444"}`, borderRadius: 8, padding: "10px 12px", background: "rgba(239,68,68,0.06)" }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: data.validation.ok ? "#f59e0b" : "#ef4444", marginBottom: 6 }}>
                Dataset integrity — {data.validation.errors} error{data.validation.errors === 1 ? "" : "s"}, {data.validation.warnings} warning{data.validation.warnings === 1 ? "" : "s"}
                {data.validation.excluded.length > 0 && <span style={{ fontWeight: 400, color: C.sub }}> · {data.validation.excluded.length} cell(s) auto-excluded from modeling (highlighted below)</span>}
              </div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: C.text, display: "grid", gap: 3 }}>
                {data.validation.issues.map((iss, i) => (
                  <li key={i}><b style={{ color: iss.severity === "error" ? "#ef4444" : "#f59e0b" }}>[{iss.severity}]</b> <code style={{ color: C.sub }}>{iss.scope}</code> — {iss.message}</li>
                ))}
              </ul>
            </div>
          )}
          {data.validation && data.validation.issues.length === 0 && (
            <div style={{ marginBottom: 18, fontSize: 12.5, color: "#22c55e" }}>✓ Dataset integrity checks passed.</div>
          )}

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
                      {rowCells.map((x, i) => {
                        const excl = !!x && excludedSet.has(`${lg}|${x.year}`);
                        return (
                          <td key={i} style={{ ...td, color: excl ? "#ef4444" : x ? C.text : C.sub, fontWeight: excl ? 700 : undefined, background: excl ? "rgba(239,68,68,0.14)" : undefined }}>
                            {x ? <span title={`${excl ? "EXCLUDED (corrupt) — " : ""}${fmt(x.rows)} rows · ${fmt(x.pa)} PA · ${fmt(x.bf)} BF`}>{fmt(x.rows)}</span> : "—"}
                          </td>
                        );
                      })}
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

          {/* Top-level tabs — Active model (deployed model + diagnostics) vs Bake-off (candidate comparison) */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "20px 0 12px", flexWrap: "wrap" }}>
            <span style={{ display: "inline-flex", border: `1px solid ${C.border}`, borderRadius: 6, overflow: "hidden" }}>
              {([["active", "Active model"], ["bakeoff", "Bake-off"]] as const).map(([id, label]) => (
                <button key={id} onClick={() => setTab(id)} style={{ ...inputStyle, border: "none", borderRadius: 0, cursor: "pointer", padding: "6px 14px", fontSize: 13, fontWeight: tab === id ? 700 : 400, background: tab === id ? C.accent : C.input, color: tab === id ? "#fff" : C.sub }}>{label}</button>
              ))}
            </span>
            <span style={{ fontSize: 12, color: C.sub }}>{tab === "active" ? "The live scoring model — saved models, its coefficients, and where it misses." : "Candidate-form comparison (model selection). D3 resolved: raw-poly hitting + log pitching."}</span>
          </div>

          {tab === "active" && (<>
          {/* Saved models — named snapshots of the four fits + their training config (parallel league/tournament models) */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "20px 0 6px", flexWrap: "wrap" }}>
            <h3 style={{ margin: 0, fontSize: 14 }}>Saved models</h3>
            <input value={modelName} onChange={(e) => setModelName(e.target.value)} placeholder="name this model…"
              onKeyDown={(e) => { if (e.key === "Enter") saveModel(); }} style={{ ...inputStyle, width: 180, padding: "4px 8px", fontSize: 12 }} />
            <button onClick={saveModel} disabled={savingModel || !modelName.trim()} style={{ ...inputStyle, cursor: "pointer", background: C.accent, color: "#fff" }}>{savingModel ? "Saving…" : "Save current"}</button>
            <span style={{ fontSize: 12, color: C.sub }}>snapshots the four fits at window {years.join("+") || "(default)"} · min {fitMin} · {fitVar ? "variants" : "base"}</span>
          </div>
          <p style={{ margin: "0 0 8px", fontSize: 11, color: C.sub, maxWidth: 820 }}>
            <b style={{ color: "#22c55e" }}>●</b> marks the <b style={{ color: C.text }}>live scoring model</b> — <b style={{ color: C.text }}>Use</b> activates a model for the grid, optimizer &amp; calibration (the <b style={{ color: C.text }}>Scoring ✓</b> badge shows which one is live). Each saved model freezes its own event form, so league vs (future) tournament models can be swapped.
          </p>
          {models.length > 0 && (
            <div style={{ overflowX: "auto", border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 4 }}>
              <table style={{ borderCollapse: "collapse", width: "100%" }}>
                <thead><tr>
                  <th style={{ ...th, textAlign: "left" }}>Name</th><th style={{ ...th, textAlign: "left" }}>Dataset</th><th style={{ ...th, textAlign: "left" }}>Window</th><th style={th}>min</th><th style={{ ...th, textAlign: "left" }}>cards</th>
                  <th style={th} title="in-sample assembled-wOBA Pearson (hit / pitch)">wOBA r</th><th style={{ ...th, textAlign: "left" }}>trained</th><th style={th}></th>
                </tr></thead>
                <tbody>
                  {models.map((m) => (
                    <tr key={m.id}>
                      <td style={{ ...td, textAlign: "left", fontWeight: 600 }}>
                        {activeModelId === m.id && <span title="live scoring model (grid + optimizer)" style={{ color: "#22c55e", marginRight: 4 }}>●</span>}{m.name}{!m.includeVariants && <span style={{ color: C.sub, fontSize: 10 }}> · base</span>}
                        {m.stale && <span title="Artifact predates current evaluation semantics (uBB targets / format v3) — re-save to retrain on current semantics" style={{ color: "#f59e0b", fontSize: 10, fontWeight: 600, marginLeft: 6, padding: "1px 5px", border: "1px solid #f59e0b", borderRadius: 4, whiteSpace: "nowrap" }}>v{m.formatVersion ?? 1} → v{m.currentFormatVersion}</span>}
                        {m.validation && (m.validation.forced || m.validation.errors > 0
                          ? <span title={`trained over ${m.validation.errors} dataset error(s)${m.validation.excluded.length ? ` — excluded: ${m.validation.excluded.join(", ")}` : ""}`} style={{ color: "#ef4444", fontSize: 10, fontWeight: 600, marginLeft: 6, padding: "1px 5px", border: "1px solid #ef4444", borderRadius: 4, whiteSpace: "nowrap" }}>⚠ forced</span>
                          : m.validation.warnings > 0
                            ? <span title={`${m.validation.warnings} dataset warning(s) at train time`} style={{ color: C.sub, fontSize: 10, marginLeft: 6, whiteSpace: "nowrap" }}>· {m.validation.warnings} warn</span>
                            : null)}
                      </td>
                      <td style={{ ...td, textAlign: "left", color: C.sub, fontSize: 12 }}>{m.datasetRoot}</td>
                      <td style={{ ...td, textAlign: "left" }}>{m.window.join("+")}</td>
                      <td style={{ ...td, color: C.sub }}>{m.minPA}</td>
                      <td style={{ ...td, textAlign: "left", color: C.sub, fontSize: 12 }}>{m.diag.rowsHit}H / {m.diag.rowsPit}P</td>
                      <td style={td}>{m.diag.hitPearson != null ? sig(m.diag.hitPearson, 3) : "—"} / {m.diag.pitPearson != null ? sig(m.diag.pitPearson, 3) : "—"}</td>
                      <td style={{ ...td, textAlign: "left", color: C.sub, fontSize: 11 }}>{m.trainedAt.slice(0, 10)}</td>
                      <td style={{ ...td, whiteSpace: "nowrap" }}>
                        {activeModelId === m.id
                          ? <span title="This model drives live scoring (grid + optimizer + calibration)" style={{ ...inputStyle, display: "inline-block", cursor: "default", padding: "2px 8px", fontSize: 12, background: "#16a34a", color: "#fff", border: "1px solid #16a34a" }}>Scoring ✓</span>
                          : <button onClick={() => activateModel(m.id)} disabled={!m.hasEventForm} title={m.hasEventForm ? "Use this model for live scoring (grid + optimizer + calibration)" : "Pre-#2 artifact — re-save to enable scoring"} style={{ ...inputStyle, cursor: m.hasEventForm ? "pointer" : "not-allowed", padding: "2px 8px", fontSize: 12, opacity: m.hasEventForm ? 1 : 0.5 }}>Use</button>}
                        <button onClick={() => loadModelConfig(m)} title="Load this model's window + min + variants into the page" style={{ ...inputStyle, cursor: "pointer", padding: "2px 8px", fontSize: 12, marginLeft: 4 }}>Load</button>
                        <button onClick={() => deleteModel(m.id)} title="Delete" style={{ ...inputStyle, cursor: "pointer", padding: "2px 8px", fontSize: 12, marginLeft: 4, color: "#f87171", border: "1px solid #ef4444" }}>✕</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* §10.8 frame-correction v2 — experimental A/B transform mode; switching re-scores everything server-side */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "12px 0 4px", flexWrap: "wrap" }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: C.text }}>Frame correction:</span>
            <span style={{ display: "inline-flex", border: `1px solid ${C.border}`, borderRadius: 6, overflow: "hidden" }}>
              {([["own-gap", "own-gap (default)", true], ["frame-v2", "frame-v2 (experimental)", hasTrainingMeans]] as const).map(([mode, label, enabled]) => (
                <button key={mode} onClick={() => { if (enabled && transformMode !== mode) applyTransformMode(mode); }} disabled={!enabled}
                  title={mode === "frame-v2" && !hasTrainingMeans ? "active model has no trainingMeans — retrain to enable" : undefined}
                  style={{ ...inputStyle, border: "none", borderRadius: 0, cursor: enabled ? "pointer" : "not-allowed", padding: "5px 11px", fontSize: 12, fontWeight: transformMode === mode ? 700 : 400, background: transformMode === mode ? C.accent : C.input, color: transformMode === mode ? "#fff" : C.sub, opacity: enabled ? 1 : 0.5 }}>{label}</button>
              ))}
            </span>
            {!hasTrainingMeans && <span style={{ fontSize: 11, color: C.sub }}>(active model has no trainingMeans — retrain to enable)</span>}
            <span style={{ fontSize: 11, color: "#eab308" }}>experimental A/B toggle — not the production default; switching re-scores everything.</span>
          </div>

          </>)}

          {tab === "bakeoff" && (<>
          {/* Evaluation scoreboard — out-of-sample fidelity for the bake-off baseline */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "22px 0 8px", flexWrap: "wrap" }}>
            <h3 style={{ margin: 0, fontSize: 14 }}>Evaluation scoreboard {sbLoading && <span style={{ fontSize: 12, color: C.sub }}>· computing…</span>}</h3>
            <SectionControls min={sbMin} onMin={(v) => { setSbMin(v); loadSb(years, v, sbVar); }} variants={sbVar} onVariants={(v) => { setSbVar(v); loadSb(years, sbMin, v); }} />
          </div>
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

          </>)}

          {tab === "active" && (<>
          {/* Deployed model performance — the ACTIVE model's own metrics (raw-poly hitting + log
              pitching) across in-sample / CV / forward / backward, on ITS frozen window/min/variants. */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "22px 0 8px", flexWrap: "wrap" }}>
            <h3 style={{ margin: 0, fontSize: 14 }}>Deployed model performance {activeSbLoading && <span style={{ fontSize: 12, color: C.sub }}>· computing…</span>}</h3>
            {activeModel
              ? <span style={{ fontSize: 12, color: C.sub }}><b style={{ color: C.text }}>{activeModel.name}</b> · window {activeModel.window.join("+")} · min {activeModel.minPA} · {activeModel.includeVariants ? "variants" : "base"} — raw-poly hitting · log pitching</span>
              : <span style={{ fontSize: 12, color: "#eab308" }}>No model active — live scoring is the log-linear baseline. Click <b>Use</b> on a saved model above.</span>}
          </div>
          {activeModel?.stale && (
            <p style={{ margin: "0 0 8px", fontSize: 12, color: "#f59e0b" }}>
              Active model is format v{activeModel.formatVersion ?? 1} (current v{activeModel.currentFormatVersion}) — re-save to retrain.
            </p>
          )}
          {activeModel && (activeSb?.scoreboard ? (() => {
            const rows = activeSb.scoreboard.rows.filter((r) => (r.role === "hitter" && r.model === DEPLOYED_HIT_MODEL) || (r.role === "pitcher" && r.model === DEPLOYED_PIT_MODEL));
            return rows.length
              ? <ScoreboardView sb={{ ...activeSb.scoreboard, rows }} />
              : <p style={{ color: C.sub, fontSize: 13 }}>No deployed-model rows for this model's config.</p>;
          })() : <p style={{ color: C.sub, fontSize: 13 }}>{activeSbLoading ? "Computing…" : "—"}</p>)}

          {/* Platoon exposure — realized RHP/LHP (hitters) & RHB/LHB (pitchers) shares from this
              model's data. Seeds NEW tournaments' OVR splits + team exposure; existing untouched. */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "22px 0 8px", flexWrap: "wrap" }}>
            <h3 style={{ margin: 0, fontSize: 14 }}>Platoon exposure</h3>
            <span style={{ fontSize: 12, color: C.sub }}>realized splits from this model's data — seeds new-tournament OVR weighting &amp; team exposure (existing tournaments untouched)</span>
          </div>
          {activeModel?.platoon ? (() => {
            const p = activeModel.platoon!;
            const HN: Record<string, string> = { R: "RHB", L: "LHB", S: "SHB" };
            const PN: Record<string, string> = { R: "RHP", L: "LHP" };
            const pc = (x: number) => `${(x * 100).toFixed(1)}%`;
            return <><div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
              <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, overflow: "hidden" }}>
                <table style={{ borderCollapse: "collapse" }}>
                  <thead><tr><th style={{ ...th, textAlign: "left" }}>Batter</th><th style={th}>vs RHP</th><th style={th}>vs LHP</th><th style={th}>PA</th></tr></thead>
                  <tbody>
                    {p.hit.filter((h) => h.pa > 0).map((h) => <tr key={h.hand}><td style={{ ...td, textAlign: "left", fontWeight: 600 }}>{HN[h.hand]}</td><td style={td}>{pc(h.vsRHP)}</td><td style={td}>{pc(h.vsLHP)}</td><td style={{ ...td, color: C.sub }}>{h.pa.toLocaleString()}</td></tr>)}
                    <tr><td style={{ ...td, textAlign: "left", color: C.sub }}>team</td><td style={{ ...td, fontWeight: 700 }}>{pc(p.teamVR)}</td><td style={{ ...td, fontWeight: 700 }}>{pc(p.teamVL)}</td><td style={td}></td></tr>
                  </tbody>
                </table>
              </div>
              <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, overflow: "hidden" }}>
                <table style={{ borderCollapse: "collapse" }}>
                  <thead><tr><th style={{ ...th, textAlign: "left" }}>Pitcher</th><th style={th}>vs RHB</th><th style={th}>vs LHB</th><th style={th}>BF</th></tr></thead>
                  <tbody>
                    {p.pit.filter((x) => x.bf > 0).map((x) => <tr key={x.hand}><td style={{ ...td, textAlign: "left", fontWeight: 600 }}>{PN[x.hand]}</td><td style={td}>{pc(x.vsRHB)}</td><td style={td}>{pc(x.vsLHB)}</td><td style={{ ...td, color: C.sub }}>{x.bf.toLocaleString()}</td></tr>)}
                  </tbody>
                </table>
              </div>
            </div>
              <p style={{ margin: "8px 0 0", fontSize: 11, color: C.sub }}>OVR splits seeded to new tournaments: RHB·RHP <b style={{ color: C.text }}>{pc(p.r_hit_split)}</b> · LHB·LHP <b style={{ color: C.text }}>{pc(p.l_hit_split)}</b> · SHB·RHP <b style={{ color: C.text }}>{pc(p.s_hit_split)}</b> · RHP·RHB <b style={{ color: C.text }}>{pc(p.r_pitch_split)}</b> · LHP·LHB <b style={{ color: C.text }}>{pc(p.l_pitch_split)}</b> · team vR <b style={{ color: C.text }}>{pc(p.teamVR)}</b></p>
            </>;
          })() : <p style={{ color: C.sub, fontSize: 13 }}>{activeModel ? "This model predates platoon-exposure — re-save it to compute." : "No active model."}</p>}

          {/* Where the model misses — per-card residual leaderboards + archetypes + grid */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "22px 0 4px", flexWrap: "wrap" }}>
            <h3 style={{ margin: 0, fontSize: 14 }}>Where the wOBA model misses {residLoading && <span style={{ fontSize: 12, color: C.sub }}>· computing…</span>}</h3>
            <span style={{ display: "inline-flex", border: `1px solid ${C.border}`, borderRadius: 4, overflow: "hidden" }}>
              {(["hitter", "pitcher"] as const).map((r) => (
                <button key={r} onClick={() => chooseResidRole(r)} style={{ ...inputStyle, border: "none", borderRadius: 0, cursor: "pointer", padding: "5px 11px", textTransform: "capitalize", background: residRole === r ? C.accent : C.input, color: residRole === r ? "#fff" : C.sub, fontWeight: residRole === r ? 700 : 400 }}>{r}</button>
              ))}
            </span>
            <SectionControls
              min={residMin} onMin={(v) => { setResidMin(v); loadResid(residRole, years, v, residVar, residWeighted); }}
              variants={residVar} onVariants={(v) => { setResidVar(v); loadResid(residRole, years, residMin, v, residWeighted); }}
              weighted={residWeighted} onWeighted={(v) => { setResidWeighted(v); loadResid(residRole, years, residMin, residVar, v); }} />
            {resid?.residuals && <span style={{ fontSize: 12, color: C.sub }}>{resid.residuals.n} cards · window {resid.residuals.window.join("+")}</span>}
          </div>
          {resid && !resid.available && <p style={{ color: "#f87171", fontSize: 13 }}>Unavailable: {resid.error}</p>}
          {resid?.residuals && <MissesView a={resid.residuals} />}

          {/* Trained models — all four parity-validated bit-for-bit vs the old trainer */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "22px 0 8px", flexWrap: "wrap" }}>
            <h3 style={{ margin: 0, fontSize: 14 }}>Trained models {fitLoading && <span style={{ fontSize: 12, color: C.sub }}>· fitting…</span>}</h3>
            <SectionControls min={fitMin} onMin={(v) => { setFitMin(v); loadFit(years, v, fitVar); }} variants={fitVar} onVariants={(v) => { setFitVar(v); loadFit(years, fitMin, v); }} />
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

              {fitTab === "woba_hitting" && (activeForm ? (
                <ModelView
                  formulas={[
                    <>BB/600 = {curveText("EYE", activeForm.hit.bb)}</>,
                    <>K/600 = {curveText("K", activeForm.hit.k)}</>,
                    <>HR/600 = {curveText("POW", activeForm.hit.hr)}</>,
                    <>nonHR-H/600 = {hText("BABIP", activeForm.hit.h)}</>,
                    <>XBH/H = {curveText("GAP", activeForm.hit.xbh)}</>,
                    <>HBP/600 = 6.0000 (fixed)</>,
                  ]}
                  note={<><b>Deployed #2 model</b> — raw-poly (quadratic) on HR (POW) &amp; XBH (GAP), log elsewhere; quadratics shown expanded in the raw rating. Fit quality is in <b>Deployed model performance</b> above.</>}
                  diagRows={[]} />
              ) : <p style={{ color: C.sub, fontSize: 13 }}>No active #2 model — deployed scoring would fall back to the retired log-linear baseline. Click <b>Use</b> on a saved model above.</p>)}

              {fitTab === "woba_pitching" && (activeForm ? (
                <ModelView
                  formulas={[
                    <>BB/600 = {curveText("CON", activeForm.pit.bb)}</>,
                    <>K/600 = {curveText("STU", activeForm.pit.k)}</>,
                    <>HR/600 = {curveText("HRR", activeForm.pit.hr)}</>,
                    <>nonHR-H/600 = {hText("PBABIP", activeForm.pit.h)}</>,
                    <>XBH = 0.25·H (fixed share)</>,
                  ]}
                  note={<><b>Deployed #2 model</b> — pitching is LOG on every event (the raw-poly HR curve was retired — see Bake-off). Fit quality is in <b>Deployed model performance</b> above.</>}
                  diagRows={[]} />
              ) : <p style={{ color: C.sub, fontSize: 13 }}>No active #2 model — deployed scoring would fall back to the retired log-linear baseline.</p>)}

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
          </>)}
        </>
      )}
    </div>
  );
}
