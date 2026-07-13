// EVALUATION-ONLY tournament-outcome ingestion.
//
// HARD INVARIANT (correctness-critical): tournament outcomes are EVALUATION-ONLY. They
// must be structurally INCAPABLE of entering any training fit. This module is a SEPARATE
// path from src/training/loader.ts — it shares NO code with parseTrainingFilename /
// windowObs / loadWindow / getFit, and its output type (TournamentObs) is DISTINCT from
// the trainer's TrainObs and carries `evalOnly: true`. Nothing here fits a model, and no
// fit function anywhere imports this module. See the guard test in tests/tournament-eval.ts.
//
// WHY separate: tournament CSVs are COMBINED stat lines — one line per card with NO vL/vR
// split (unlike the league training files, which are per-side). Feeding a combined line into
// the per-side trainer would silently corrupt the fit. So there is no side-detection here and
// no path back into the loader.
//
// Parse conventions mirror tools/tournament-kslope.ts and tools/quicks-levelbias.ts (the
// diagnostic prototypes for these exact CSVs): numeric fields via Number()||0; ratings read
// from `<COL> vR`/`<COL> vL` columns; aggregation keyed by (CID, VLvl) so a base card and its
// variant levels — which carry different ratings — never merge. The ghost-cleaner is passed
// IN by the caller (dependency injection); this module never imports it.

import Papa from "papaparse";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { computeDerived } from "../scoring-core/index.ts";
import { hittingComponents, pitchingComponents } from "../scoring-core/woba.ts";
import { wobaWeightsFromCoeffs } from "../scoring-core/woba-weights.ts";
import { makeRawPolyModel } from "../model/raw-poly.ts";
import { logLinearModel } from "../model/log-linear.ts";
import { applyAffine, applyFrameShift, applyKSpread, type PoolTransform, type FrameShift } from "../model/pool-transform.ts";
import type { EventForm } from "../model/curves.ts";
import type { Coeffs, Derived, KSpread } from "../config/types.ts";
import type { EventModel, HittingRatings, PitchingRatings } from "../model/types.ts";

const num = (v: unknown): number => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
// Hand code, catalog convention: 1=R, 2=L, 3=S (mirrors loader.ts handCode). CSV B/T are letters.
const handCode = (v: unknown): number => { const s = String(v ?? "").trim().toUpperCase(); return s === "R" ? 1 : s === "L" ? 2 : s === "S" ? 3 : num(v); };
// Throwing hand collapsed to the R/L axis for the pitcher exposure blend (no switch pitchers).
const thr = (throws: number): 1 | 2 => (throws === 1 ? 1 : 2);

type Row = Record<string, unknown>;
const R = (r: Row, side: "vR" | "vL", col: string): number => num(r[`${col} ${side}`]);

const hitRatings = (r: Row, side: "vR" | "vL"): HittingRatings => ({
  eye: R(r, side, "EYE"), pow: R(r, side, "POW"), kRat: R(r, side, "K"),
  babip: R(r, side, "BA"), gap: R(r, side, "GAP"),
  speed: 0, steal: 0, run: 0, // not per-side; the level table never reads them (mirrors kslope/quicks)
});
const pitRatings = (r: Row, side: "vR" | "vL"): PitchingRatings => ({
  con: R(r, side, "CON"), stu: R(r, side, "STU"), pbabip: R(r, side, "PBABIP"), hrr: R(r, side, "HRA"),
});

/** Per-600 event levels (uBB = unintentional BB, HmHR = non-HR hits). One block per role. `XBH`
 *  (extra-base hits = 2B+3B, a subset of HmHR) is carried on ACTUAL lines only, for realized-wOBA
 *  assembly in the scorecard — predicted level tables leave it undefined. */
export interface EventLevels { uBB: number; K: number; HR: number; HmHR: number; XBH?: number }

/**
 * A single EVALUATION-ONLY tournament observation: one card's COMBINED (no vL/vR split) stat
 * line, aggregated across every running in the directory. TAGGED `combined`/`evalOnly` so it
 * is structurally distinct from the trainer's TrainObs and can never be fed to a fit.
 */
export interface TournamentObs {
  cid: string;
  vlvl: number;          // variant level (0 = base); part of the aggregation key so ratings never mix
  combined: true;        // combined stat line (no side split) — structural tag
  evalOnly: true;        // NEVER enters a training fit — structural tag
  pa: number;            // total batting PA (hitter weight + threshold)
  bf: number;            // total batters faced (pitcher weight + threshold)
  bats: number;          // 1=R 2=L 3=S
  throws: number;        // 1=R 2=L 3=S
  ratings: {
    hit: { vR: HittingRatings; vL: HittingRatings };
    pit: { vR: PitchingRatings; vL: PitchingRatings };
  };
  actual: {
    hit: EventLevels;    // per-600 PA
    pit: EventLevels;    // per-600 BF
  };
}

interface Agg {
  cid: string; vlvl: number; bats: number; throws: number;
  ratings: TournamentObs["ratings"];
  hPA: number; hBB: number; hIBB: number; hK: number; hHR: number; hH: number; hXBH: number;
  pBF: number; pBB: number; pIBB: number; pK: number; pHR: number; p1B: number; p2B: number; p3B: number;
}

export interface LoadTournamentOpts {
  /** Ghost-cleaner, INJECTED by the caller (do NOT import it here — DI keeps this module isolated
   *  from the cleaner). Applied per-running (per CSV). Receives (rows, filename) so the caller can
   *  record a per-running diagnostic keyed by file. Returns the rows to keep. */
  clean?: (rows: Row[], file: string) => Row[];
}

/**
 * Read the combined-line tournament CSVs in `dir`, optionally ghost-clean each running via the
 * injected `opts.clean`, aggregate by (CID, VLvl), and return EVAL-ONLY tagged observations.
 * NO filename side-detection (these lines are combined). This function fits nothing.
 */
export function loadTournamentOutcomes(dir: string, opts: LoadTournamentOpts = {}): TournamentObs[] {
  const m = new Map<string, Agg>();
  for (const f of readdirSync(dir).filter((x) => x.toLowerCase().endsWith(".csv"))) {
    const parsed = Papa.parse<Row>(readFileSync(join(dir, f), "utf8"), { header: true, skipEmptyLines: true });
    let rows = (parsed.data ?? []).filter((r) => r && r["CID"] != null && String(r["CID"]) !== "");
    // Ghost-clean this running (one CSV = one running) via the injected cleaner. DI — the
    // cleaner is a caller concern; this module stays data-shape-agnostic and import-free of it.
    if (opts.clean) rows = opts.clean(rows, f);
    for (const r of rows) {
      const cid = String(r["CID"]);
      const vlvl = num(r["VLvl"]);
      const key = `${cid}|${vlvl}`;
      let a = m.get(key);
      if (!a) {
        a = {
          cid, vlvl, bats: handCode(r["B"]), throws: handCode(r["T"]),
          ratings: {
            hit: { vR: hitRatings(r, "vR"), vL: hitRatings(r, "vL") },
            pit: { vR: pitRatings(r, "vR"), vL: pitRatings(r, "vL") },
          },
          hPA: 0, hBB: 0, hIBB: 0, hK: 0, hHR: 0, hH: 0, hXBH: 0,
          pBF: 0, pBB: 0, pIBB: 0, pK: 0, pHR: 0, p1B: 0, p2B: 0, p3B: 0,
        };
        m.set(key, a);
      }
      a.hPA += num(r["PA"]); a.hBB += num(r["BB"]); a.hIBB += num(r["IBB"]); a.hK += num(r["K"]); a.hHR += num(r["HR"]); a.hH += num(r["H"]);
      a.hXBH += num(r["2B_1"]) + num(r["3B_1"]);
      a.pBF += num(r["BF"]); a.pBB += num(r["BB_1"]); a.pIBB += num(r["IBB_1"]); a.pK += num(r["K_1"]); a.pHR += num(r["HR_1"]);
      a.p1B += num(r["1B_2"]); a.p2B += num(r["2B_2"]); a.p3B += num(r["3B_2"]);
    }
  }
  const per600 = (x: number, denom: number) => (denom > 0 ? (x * 600) / denom : 0);
  return [...m.values()].map((a) => ({
    cid: a.cid, vlvl: a.vlvl, combined: true as const, evalOnly: true as const,
    pa: a.hPA, bf: a.pBF, bats: a.bats, throws: a.throws, ratings: a.ratings,
    actual: {
      hit: { uBB: per600(a.hBB - a.hIBB, a.hPA), K: per600(a.hK, a.hPA), HR: per600(a.hHR, a.hPA), HmHR: per600(a.hH - a.hHR, a.hPA), XBH: per600(a.hXBH, a.hPA) },
      pit: { uBB: per600(a.pBB - a.pIBB, a.pBF), K: per600(a.pK, a.pBF), HR: per600(a.pHR, a.pBF), HmHR: per600(a.p1B + a.p2B + a.p3B, a.pBF), XBH: per600(a.p2B + a.p3B, a.pBF) },
    },
  }));
}

/** vR/vL blend weights, realized from the running's own handedness mix (mirrors kslope/quicks). */
export interface TournamentExposure {
  /** Hitter vR weight = league RHP share of BF (a hitter faces RHP this fraction of the time). */
  wRhit: number;
  /** Pitcher vR weight by throwing hand: {1: RHB share, 2: (RHB+switch) share vs a LHP}. */
  wRpit: Record<number, number>;
}

/**
 * Realized vR/vL exposure weights, computed from the aggregated obs' own handedness mix — the
 * same pool-realized shares tools/quicks-levelbias.ts derives from the raw rows (aggregation
 * preserves the totals, so obs-level sums == row-level sums).
 */
export function tournamentExposure(obs: TournamentObs[]): TournamentExposure {
  let bfAll = 0, bfR = 0, paTot = 0, paR = 0, paL = 0, paS = 0;
  for (const o of obs) {
    bfAll += o.bf; if (o.throws === 1) bfR += o.bf;
    paTot += o.pa; if (o.bats === 1) paR += o.pa; else if (o.bats === 2) paL += o.pa; else paS += o.pa;
  }
  const wRhit = bfAll > 0 ? bfR / bfAll : 0.5;
  const denom = paR + paL + paS;
  const wRpit: Record<number, number> = denom > 0
    ? { 1: paR / denom, 2: (paR + paS) / denom }
    : { 1: 0.5, 2: 0.5 };
  return { wRhit, wRpit };
}

/** One row of the pooled level-bias table: predicted vs actual per-600, and their difference. */
export interface LevelBias { event: string; pred: number; actual: number; bias: number }
export interface TournamentLevelTable { hit: LevelBias[]; pit: LevelBias[] }
export interface EvaluateOpts { minPA?: number; minBF?: number }

/**
 * The scoring config the level table evaluates against — the SAME objects the server threads into
 * scoreCard/calibrate for this tournament, so the eval reflects EXACTLY how the app scores it. When
 * only `coeffs` (+ optional `eventForm`) is supplied, it evaluates the raw base model (own-gap with
 * no transform), matching the historical behavior.
 */
export interface TournamentEvalConfig {
  coeffs: Coeffs;
  eventForm?: EventForm;
  poolTransform?: PoolTransform;   // own-gap
  frameShift?: FrameShift;         // frame-v2
  kSpread?: KSpread;               // frame-v2 / matchup K-spread
  matchup?: { model: EventModel; shift: FrameShift }; // matchup mode (model shifts internally)
}

// Per-side FINAL component rates (per 600) via the real recompute — the ONE shared prediction path
// used by both the level table and the scorecard. Rating re-basing mirrors score-card exactly:
// own-gap `applyAffine` and/or frame-v2 `applyFrameShift` (skipped under matchup, whose model shifts
// internally), then K-spread on the raw predicted K pre-era. K has no BIP dependence → `K × era_k`.
export interface FinalComp { BB: number; K: number; HR: number; oneB: number; xbh: number }
interface PredictCtx {
  coeffs: Coeffs; derived: Derived; eventForm?: EventForm; evModel: EventModel;
  poolTransform?: PoolTransform; frameShift?: FrameShift; kSpread?: KSpread;
  matchup?: { model: EventModel; shift: FrameShift };
}
function makeCtx(config: TournamentEvalConfig): PredictCtx {
  const { coeffs, eventForm, poolTransform, frameShift, kSpread, matchup } = config;
  return {
    coeffs, derived: computeDerived(coeffs, true), eventForm, poolTransform, frameShift, kSpread, matchup,
    // Model selection mirrors scoreCard: matchup wrapper → #2 raw-poly → parity log.
    evModel: matchup?.model ?? (eventForm ? makeRawPolyModel(eventForm) : logLinearModel),
  };
}
function hitComp(o: TournamentObs, side: "vR" | "vL", c: PredictCtx): FinalComp {
  const t = c.poolTransform?.hit[side], fs = c.frameShift?.hit[side], raw = o.ratings.hit[side];
  const rat = c.matchup ? raw : {
    ...raw,
    eye: applyFrameShift(applyAffine(raw.eye, t?.eye), fs?.eye),
    pow: applyFrameShift(applyAffine(raw.pow, t?.pow), fs?.pow),
    kRat: applyFrameShift(applyAffine(raw.kRat, t?.kRat), fs?.kRat),
    babip: applyFrameShift(applyAffine(raw.babip, t?.babip), fs?.babip),
    gap: applyFrameShift(applyAffine(raw.gap, t?.gap), fs?.gap),
  };
  const e = c.evModel.predictHitting(rat, c.coeffs);
  if (c.kSpread) e.SO = applyKSpread(e.SO, c.kSpread.meanHit, c.kSpread.sHit);
  const k = hittingComponents(e, 1, 1, o.bats, side, c.coeffs, c.derived, c.eventForm);
  return { BB: k.BB_fin, K: e.SO * c.coeffs.era_k, HR: k.HR_fin, oneB: k.oneB_fin, xbh: k.GAP_fin };
}
function pitComp(o: TournamentObs, side: "vR" | "vL", c: PredictCtx): FinalComp {
  const tp = c.poolTransform?.pit[side], fp = c.frameShift?.pit[side], raw = o.ratings.pit[side];
  const rat = c.matchup ? raw : {
    con: applyFrameShift(applyAffine(raw.con, tp?.con), fp?.con),
    stu: applyFrameShift(applyAffine(raw.stu, tp?.stu), fp?.stu),
    pbabip: applyFrameShift(applyAffine(raw.pbabip, tp?.pbabip), fp?.pbabip),
    hrr: applyFrameShift(applyAffine(raw.hrr, tp?.hrr), fp?.hrr),
  };
  const e = c.evModel.predictPitching(rat, c.coeffs);
  if (c.kSpread) e.K = applyKSpread(e.K, c.kSpread.meanPit, c.kSpread.sPit);
  const k = pitchingComponents(e, 1, 1, side, c.coeffs, c.derived, c.eventForm);
  return { BB: k.BB_fin, K: e.K * c.coeffs.era_k, HR: k.HR_fin, oneB: k.oneB_fin, xbh: k.XBH_fin };
}
const compToLevels = (f: FinalComp): EventLevels => ({ uBB: f.BB, K: f.K, HR: f.HR, HmHR: f.oneB + f.xbh });
/** Raw wOBA from final component rates (per 600) + the coeff-derived event weights. HBP is the model's
 *  fixed constant (not rating-driven), so it enters both predicted and realized identically. */
const compToWoba = (f: FinalComp, coeffs: Coeffs): number => {
  const w = wobaWeightsFromCoeffs(coeffs);
  return (w.bb * f.BB + w.hbp * coeffs.adv_hbp + w.b1 * f.oneB + w.xbh * f.xbh + w.hr * f.HR) / 600;
};
/** Raw wOBA from an ACTUAL combined line (per-600 events). Mirrors compToWoba: 1B = HmHR − XBH. */
const actualWoba = (a: EventLevels, coeffs: Coeffs): number => {
  const w = wobaWeightsFromCoeffs(coeffs);
  const xbh = a.XBH ?? 0;
  return (w.bb * a.uBB + w.hbp * coeffs.adv_hbp + w.b1 * (a.HmHR - xbh) + w.xbh * xbh + w.hr * a.HR) / 600;
};

/**
 * Pooled predicted-vs-actual per-600 level-bias table. Predictions run through the REAL scoring
 * recompute — the shared `hittingComponents`/`pitchingComponents` (calibrate BB/HR → era/park →
 * BIP recompute → re-derived hits), NOT a frozen-BIP shortcut — so non-neutral eras move BIP and
 * hits consistently with production. It also HONORS the active `transformMode`: own-gap
 * (`poolTransform`), frame-v2 (`frameShift` + `kSpread`), or matchup (`matchup.model` shifts
 * internally). Each side is recomputed to its final component rates, then the two sides are blended
 * by the realized exposure weights (blend-of-finals, since the BIP recompute is nonlinear).
 */
export function evaluateTournamentLevels(
  obs: TournamentObs[], config: TournamentEvalConfig, exposure: TournamentExposure, opts: EvaluateOpts = {},
): TournamentLevelTable {
  const ctx = makeCtx(config);
  const minPA = opts.minPA ?? 100, minBF = opts.minBF ?? 100;
  const bl = (a: number, b: number, w: number) => w * a + (1 - w) * b;

  const hitLevels = (o: TournamentObs, side: "vR" | "vL"): EventLevels => compToLevels(hitComp(o, side, ctx));
  const pitLevels = (o: TournamentObs, side: "vR" | "vL"): EventLevels => compToLevels(pitComp(o, side, ctx));
  const blendLevels = (Rr: EventLevels, L: EventLevels, w: number): EventLevels => ({
    uBB: bl(Rr.uBB, L.uBB, w), K: bl(Rr.K, L.K, w), HR: bl(Rr.HR, L.HR, w), HmHR: bl(Rr.HmHR, L.HmHR, w),
  });

  interface Row { w: number; pred: EventLevels; actual: EventLevels }
  const hitRows: Row[] = obs.filter((o) => o.pa >= minPA).map((o) => ({
    w: o.pa,
    pred: blendLevels(hitLevels(o, "vR"), hitLevels(o, "vL"), exposure.wRhit),
    actual: o.actual.hit,
  }));
  const pitRows: Row[] = obs.filter((o) => o.bf >= minBF).map((o) => ({
    w: o.bf,
    pred: blendLevels(pitLevels(o, "vR"), pitLevels(o, "vL"), exposure.wRpit[thr(o.throws)]!),
    actual: o.actual.pit,
  }));

  const wmean = (rows: Row[], get: (r: Row) => number) => {
    let nn = 0, dd = 0; for (const r of rows) { nn += r.w * get(r); dd += r.w; } return dd ? nn / dd : 0;
  };
  const table = (rows: Row[]): LevelBias[] =>
    (["uBB", "K", "HR", "HmHR"] as (keyof EventLevels)[]).map((event) => {
      const pred = wmean(rows, (r) => r.pred[event] ?? 0);
      const actual = wmean(rows, (r) => r.actual[event] ?? 0);
      return { event: event === "HmHR" ? "H-HR" : event, pred, actual, bias: pred - actual };
    });
  return { hit: table(hitRows), pit: table(pitRows) };
}

// ── Predictive scorecard ─────────────────────────────────────────────────────────────────────
// Level bias measures CALIBRATION (are we right on average?). The scorecard measures DISCRIMINATION
// (does the model rank + predict each card well after all scaling?) — the roster-relevant thing.
// Predicted and realized wOBA are BOTH raw (same event weights, same scale), so Pearson/Spearman/
// RMSE/spread are directly comparable; the anchor is a global level scale that doesn't affect them.

/** One role's predictive quality. `spreadRatio` = SD(pred)/SD(actual) — <1 ⇒ the model UNDER-separates
 *  (the K-defect signature). `valueRegret` = realized-wOBA gap between the model's top-N picks and the
 *  true best top-N (roster-honest: how much value the model would leave on the table). */
export interface RoleScore {
  n: number; predMean: number; realMean: number; levelBias: number;
  pearson: number; spearman: number; rmse: number; spreadRatio: number;
  valueRegret: number; topNOverlap: number; topN: number;
}
export interface TournamentScorecard { hit: RoleScore | null; pit: RoleScore | null }
export interface ScorecardOpts { minPA?: number; minBF?: number; topN?: number }

const wStats = (x: number[], w: number[]) => {
  let sw = 0, sx = 0; for (let i = 0; i < x.length; i++) { sw += w[i]!; sx += w[i]! * x[i]!; }
  const mean = sw ? sx / sw : 0;
  let v = 0; for (let i = 0; i < x.length; i++) v += w[i]! * (x[i]! - mean) ** 2;
  return { mean, sd: sw ? Math.sqrt(v / sw) : 0, sw };
};
const wPearson = (x: number[], y: number[], w: number[]) => {
  const sx = wStats(x, w), sy = wStats(y, w);
  if (!sx.sd || !sy.sd) return 0;
  let cov = 0; for (let i = 0; i < x.length; i++) cov += w[i]! * (x[i]! - sx.mean) * (y[i]! - sy.mean);
  return cov / sx.sw / (sx.sd * sy.sd);
};
const ranks = (v: number[]): number[] => {
  const idx = v.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
  const r = new Array<number>(v.length);
  for (let i = 0; i < idx.length;) {
    let j = i; while (j + 1 < idx.length && idx[j + 1]![0] === idx[i]![0]) j++;
    const avg = (i + j) / 2 + 1; for (let k = i; k <= j; k++) r[idx[k]![1]] = avg;
    i = j + 1;
  }
  return r;
};

/** Per-card predicted vs realized wOBA (both raw) → discrimination metrics per role, for one mode.
 *  `value` ranks cards for roster relevance (hitter = wOBA; pitcher = −allowedWOBA, higher = better). */
export function tournamentScorecard(
  obs: TournamentObs[], config: TournamentEvalConfig, exposure: TournamentExposure, opts: ScorecardOpts = {},
): TournamentScorecard {
  const ctx = makeCtx(config);
  const coeffs = config.coeffs;
  const minPA = opts.minPA ?? 500, minBF = opts.minBF ?? 500, topN = opts.topN ?? 26;
  const bl = (a: number, b: number, w: number) => w * a + (1 - w) * b;

  const score = (
    rows: { pred: number; real: number; w: number; val: (v: number) => number }[],
  ): RoleScore | null => {
    if (rows.length < 4) return null;
    const pred = rows.map((r) => r.pred), real = rows.map((r) => r.real), w = rows.map((r) => r.w);
    const sp = wStats(pred, w), sr = wStats(real, w);
    let se = 0, sw = 0; for (const r of rows) { se += r.w * (r.pred - r.real) ** 2; sw += r.w; }
    // value-regret: model's top-N by PREDICTED value vs the true top-N by REALIZED value.
    const N = Math.min(topN, Math.floor(rows.length / 2));
    const byPred = [...rows].sort((a, b) => a.val(b.pred) - a.val(a.pred)); // desc by value(pred)
    const byReal = [...rows].sort((a, b) => a.val(b.real) - a.val(a.real));
    const pick = byPred.slice(0, N), best = byReal.slice(0, N);
    const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / (xs.length || 1);
    const pickedRealVal = mean(pick.map((r) => r.val(r.real)));
    const bestRealVal = mean(best.map((r) => r.val(r.real)));
    const bestSet = new Set(best);
    const overlap = pick.filter((r) => bestSet.has(r)).length / (N || 1);
    return {
      n: rows.length, predMean: sp.mean, realMean: sr.mean, levelBias: sp.mean - sr.mean,
      pearson: wPearson(pred, real, w), spearman: wPearson(ranks(pred), ranks(real), w),
      rmse: sw ? Math.sqrt(se / sw) : 0, spreadRatio: sr.sd ? sp.sd / sr.sd : 0,
      valueRegret: bestRealVal - pickedRealVal, topNOverlap: overlap, topN: N,
    };
  };

  const hitRows = obs.filter((o) => o.pa >= minPA).map((o) => ({
    pred: bl(compToWoba(hitComp(o, "vR", ctx), coeffs), compToWoba(hitComp(o, "vL", ctx), coeffs), exposure.wRhit),
    real: actualWoba(o.actual.hit, coeffs), w: o.pa, val: (v: number) => v, // hitter: higher wOBA better
  }));
  const pitRows = obs.filter((o) => o.bf >= minBF).map((o) => ({
    pred: bl(compToWoba(pitComp(o, "vR", ctx), coeffs), compToWoba(pitComp(o, "vL", ctx), coeffs), exposure.wRpit[thr(o.throws)]!),
    real: actualWoba(o.actual.pit, coeffs), w: o.bf, val: (v: number) => -v, // pitcher: lower allowed better
  }));
  return { hit: score(hitRows), pit: score(pitRows) };
}
