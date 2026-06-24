// M6 — per-event model FITTING (training). Parity port of the old app's backend
// `trainWobaHitting` (C:\ootp_app\backend\server.js): each event's per-600-PA rate
// is fit by weighted least squares (weight = PA^0.75) as a LOG-LINEAR function of
// its driving rating. The non-HR-hit model uses the model's own PREDICTED BIP (not
// actual), so training mirrors inference (S6.2). leagueNorm scales each event so
// the PA-weighted mean prediction hits a fixed Section-3 baseline.
//
// Parity oracle: the old `trained_models.json` "37-38" model (trained on this same
// neutral-environment dataset, minPA=1000) — reproduced bit-for-bit by tests.
// Diagnostics here are the scalar fit stats (r2/rmse/spearman/pearson); the
// residual-bin report + softcap recommendation are a later increment.

import type { TrainObs } from "./loader.ts";

// ── Math: weighted least squares (normal equations + Gauss-Jordan) ─────────────
export function wls(X: number[][], y: number[], w: number[]): number[] {
  const n = X.length, p = X[0]!.length;
  const XtWX = Array.from({ length: p }, () => new Array(p).fill(0));
  const XtWy = new Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    const wi = w[i]!;
    for (let j = 0; j < p; j++) {
      XtWy[j] += wi * X[i]![j]! * y[i]!;
      for (let k = 0; k < p; k++) XtWX[j]![k] += wi * X[i]![j]! * X[i]![k]!;
    }
  }
  const aug = XtWX.map((row, i) => [...row, XtWy[i]]);
  for (let col = 0; col < p; col++) {
    let maxRow = col;
    for (let row = col + 1; row < p; row++) if (Math.abs(aug[row]![col]!) > Math.abs(aug[maxRow]![col]!)) maxRow = row;
    [aug[col], aug[maxRow]] = [aug[maxRow]!, aug[col]!];
    if (Math.abs(aug[col]![col]!) < 1e-12) continue;
    for (let row = 0; row < p; row++) {
      if (row === col) continue;
      const f = aug[row]![col]! / aug[col]![col]!;
      for (let k = col; k <= p; k++) aug[row]![k] -= f * aug[col]![k]!;
    }
  }
  return aug.map((row, i) => Math.abs(row[i]!) < 1e-12 ? 0 : row[p]! / row[i]!);
}

export function spearman(a: number[], b: number[]): number {
  const n = a.length;
  const rankOf = (arr: number[]) => {
    const sorted = arr.map((v, i) => ({ v, i })).sort((x, y) => x.v - y.v);
    const ranks = new Array<number>(n);
    sorted.forEach(({ i }, r) => { ranks[i] = r + 1; });
    return ranks;
  };
  const ra = rankOf(a), rb = rankOf(b);
  return 1 - (6 * ra.reduce((s, r, i) => s + (r - rb[i]!) ** 2, 0)) / (n * (n * n - 1));
}
export function rSquared(actual: number[], predicted: number[], weights: number[]): number {
  const wSum = weights.reduce((s, w) => s + w, 0);
  const wMean = weights.reduce((s, w, i) => s + w * actual[i]!, 0) / wSum;
  const ssTot = weights.reduce((s, w, i) => s + w * (actual[i]! - wMean) ** 2, 0);
  const ssRes = weights.reduce((s, w, i) => s + w * (actual[i]! - predicted[i]!) ** 2, 0);
  return ssTot < 1e-12 ? 0 : 1 - ssRes / ssTot;
}
export const rmse = (actual: number[], predicted: number[]): number =>
  Math.sqrt(actual.reduce((s, a, i) => s + (a - predicted[i]!) ** 2, 0) / actual.length);
export function pearson(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n;
  const num = a.reduce((s, v, i) => s + (v - ma) * (b[i]! - mb), 0);
  const da = Math.sqrt(a.reduce((s, v) => s + (v - ma) ** 2, 0));
  const db = Math.sqrt(b.reduce((s, v) => s + (v - mb) ** 2, 0));
  return da * db < 1e-12 ? 0 : num / (da * db);
}

// Residual-by-weighted-volume diagnostic. Bins per-card residuals (predicted −
// actual) across the driving rating using WEIGHT-BALANCED (quantile) bins — each
// bin holds ~equal total weight, so the tails are as well-sampled as the middle
// (the old app's equal-width bins left the tails sparse/noisy). `signal` =
// meanResidual × sign(slope): positive ⇒ the model OVER-values that rating region
// (predicts more good-event / fewer K than reality). No softcap recommendation —
// this is a pure diagnostic; the over/under-valuation structure is the scoring
// function the D3 bake-off compares model forms against.
export interface ResidualBin { lo: number; hi: number; mid: number; n: number; sumW: number; meanResidual: number; signal: number }
export function residualBins(rating: number[], residual: number[], weight: number[], slope: number, nBins = 10): ResidualBin[] {
  const pts = rating.map((r, i) => ({ r, res: residual[i]!, w: weight[i]! }))
    .filter((p) => Number.isFinite(p.r) && Number.isFinite(p.res)).sort((a, b) => a.r - b.r);
  if (!pts.length) return [];
  const totalW = pts.reduce((s, p) => s + p.w, 0);
  const target = totalW / nBins;
  const sign = slope >= 0 ? 1 : -1;
  const mk = (group: typeof pts): ResidualBin => {
    const sumW = group.reduce((s, p) => s + p.w, 0);
    const meanResidual = group.reduce((s, p) => s + p.res * p.w, 0) / sumW;
    const lo = group[0]!.r, hi = group[group.length - 1]!.r;
    return { lo: +lo.toFixed(1), hi: +hi.toFixed(1), mid: +((lo + hi) / 2).toFixed(1), n: group.length, sumW: +sumW.toFixed(0), meanResidual: +meanResidual.toFixed(3), signal: +(meanResidual * sign).toFixed(3) };
  };
  // Weighted-quantile bucketing: assign each point by the cumulative weight at its
  // midpoint, so bins carry ~equal weight and the last bin isn't a leftover remainder.
  const groups: (typeof pts)[] = Array.from({ length: nBins }, () => []);
  let cum = 0;
  for (const p of pts) { groups[Math.min(Math.floor((cum + p.w / 2) / target), nBins - 1)]!.push(p); cum += p.w; }
  return groups.filter((g) => g.length).map(mk);
}

export interface EventDiag { r2: number | null; rmse: number | null; spearman: number | null; pearson?: number | null; n: number; note?: string; bins?: ResidualBin[] }
export interface WobaHittingCoeffs {
  bb: { intercept: number; eye: number; eye2: number; eye3: number };
  k: { intercept: number; k: number; k2: number };
  hr: { intercept: number; pow: number; pow2: number; pow3: number; alt_log: true };
  h: { intercept: number; ba: number; bipba: number };
  xbh: { logA: number; logB: number };
  hbp: { constant: number };
  leagueNorm: { bb: number; k: number; hr: number; h: number; xbh: number };
}
export interface WobaHittingFit {
  modelType: "woba_hitting"; split: "both"; minPA: number; rowCount: number;
  coefficients: WobaHittingCoeffs;
  diagnostics: Record<string, EventDiag>;
}

// Alternate WLS solver (parity port of the old `wlsSolve`): sqrt-weighted normal
// equations solved via Jacobi eigendecomposition + pseudo-inverse. The BASIC models
// were fit with this (numerically distinct from the Gauss-Jordan `wls` the wOBA
// models use), so reproduce it exactly.
export function wlsSolve(X: number[][], y: number[], w: number[]): number[] {
  const n = X.length, p = X[0]!.length;
  const sw = w.map((wi) => Math.sqrt(wi));
  const Xw = X.map((row, i) => row.map((x) => x * sw[i]!));
  const yw = y.map((yi, i) => yi * sw[i]!);
  const A = Array.from({ length: p }, () => new Array(p).fill(0));
  const b = new Array(p).fill(0);
  for (let i = 0; i < n; i++) for (let j = 0; j < p; j++) {
    b[j] += Xw[i]![j]! * yw[i]!;
    for (let k = 0; k < p; k++) A[j]![k] += Xw[i]![j]! * Xw[i]![k]!;
  }
  const V: number[][] = Array.from({ length: p }, (_, i) => Array.from({ length: p }, (_, j) => (i === j ? 1 : 0)));
  const D: number[][] = A.map((row) => [...row]);
  for (let sweep = 0; sweep < 100; sweep++) {
    let maxOff = 0;
    for (let i = 0; i < p; i++) for (let j = i + 1; j < p; j++) maxOff = Math.max(maxOff, Math.abs(D[i]![j]!));
    if (maxOff < 1e-14) break;
    for (let i = 0; i < p; i++) for (let j = i + 1; j < p; j++) {
      if (Math.abs(D[i]![j]!) < 1e-15) continue;
      const tau = (D[j]![j]! - D[i]![i]!) / (2 * D[i]![j]!);
      const t = tau >= 0 ? 1 / (tau + Math.sqrt(1 + tau * tau)) : 1 / (tau - Math.sqrt(1 + tau * tau));
      const c = 1 / Math.sqrt(1 + t * t), s2 = t * c;
      const Dii = D[i]![i]!, Djj = D[j]![j]!, Dij = D[i]![j]!;
      D[i]![i] = Dii - t * Dij; D[j]![j] = Djj + t * Dij; D[i]![j] = D[j]![i] = 0;
      for (let k = 0; k < p; k++) {
        if (k !== i && k !== j) {
          const Dki = D[k]![i]!, Dkj = D[k]![j]!;
          D[k]![i] = D[i]![k] = c * Dki - s2 * Dkj;
          D[k]![j] = D[j]![k] = s2 * Dki + c * Dkj;
        }
        const Vki = V[k]![i]!, Vkj = V[k]![j]!;
        V[k]![i] = c * Vki - s2 * Vkj;
        V[k]![j] = s2 * Vki + c * Vkj;
      }
    }
  }
  const eig = D.map((row, i) => row[i]!);
  const maxEig = Math.max(...eig.map(Math.abs));
  const rcond = maxEig * 1e-12;
  const Vtb = V[0]!.map((_, j) => V.reduce((s, row, k) => s + row[j]! * b[k]!, 0));
  const scaled = Vtb.map((v, i) => (Math.abs(eig[i]!) > rcond ? v / eig[i]! : 0));
  return V.map((row) => row.reduce((s, v, i) => s + v * scaled[i]!, 0));
}

// PA-weighted Section-3 baseline targets (per 600 PA) used for league normalization.
const H_SECTION3 = { BB: 48.43, K: 117.40, HR: 14.87, H: 124.75, XBH: 31.26 };
const P_SECTION3 = { BB: 47.80, K: 117.40, HR: 14.96, H: 123.97, XBH: 30.93 };
const ln1 = (x: number) => Math.log(Math.max(x, 1));
const r6 = (x: number) => +x.toFixed(6);

/**
 * Fit the wOBA hitting event model over the loader's observations (both platoon
 * sides pooled — split "both"; each side keeps its own ratings). Parity port.
 */
export function trainWobaHitting(obs: TrainObs[], minPA = 1000): WobaHittingFit {
  const players = obs.filter((o) => o.hit.PA >= minPA);
  if (players.length < 10) throw new Error(`Only ${players.length} observations meet minPA=${minPA} (need 10+)`);
  const n = players.length;
  const weights = players.map((p) => Math.pow(p.hit.PA, 0.75));
  const per600 = (f: (o: TrainObs) => number) => players.map((p) => f(p) / p.hit.PA * 600);

  const BB = per600((p) => p.hit.BB);
  const K = per600((p) => p.hit.K);
  const HR = per600((p) => p.hit.HR);
  const H = per600((p) => p.hit.H);
  const XBH = per600((p) => p.hit.b2 + p.hit.b3);
  const nonHRH = H.map((h, i) => h - HR[i]!);

  const EYE = players.map((p) => p.ratings.hit.eye);
  const Krat = players.map((p) => p.ratings.hit.kRat);
  const POW = players.map((p) => p.ratings.hit.pow);
  const BABIP = players.map((p) => p.ratings.hit.babip);
  const GAP = players.map((p) => p.ratings.hit.gap);

  const diagnostics: Record<string, EventDiag> = {};
  const runModel = (name: string, X: number[][], y: number[]): number[] => {
    const beta = wls(X, y, weights);
    const pred = X.map((row) => row.reduce((s, x, j) => s + x * beta[j]!, 0));
    diagnostics[name] = { r2: +rSquared(y, pred, weights).toFixed(4), rmse: +rmse(y, pred).toFixed(4), spearman: +spearman(y, pred).toFixed(4), pearson: +pearson(y, pred).toFixed(4), n };
    return beta;
  };

  const bbB = runModel("bb", players.map((_, i) => [1, ln1(EYE[i]!)]), BB);
  const kB = runModel("k", players.map((_, i) => [1, ln1(Krat[i]!)]), K);
  const hrB = runModel("hr", players.map((_, i) => [1, ln1(POW[i]!)]), HR);

  const bbPred = players.map((_, i) => Math.max(bbB[0]! + bbB[1]! * ln1(EYE[i]!), 0));
  const kPred = players.map((_, i) => Math.max(kB[0]! + kB[1]! * ln1(Krat[i]!), 0));
  const hrPred = players.map((_, i) => Math.max(hrB[0]! + hrB[1]! * ln1(POW[i]!), 0));
  // Predicted BIP per 600 (fixed HBP=6, SH=3, SF=4 constants) — training mirrors inference.
  const bipPred = players.map((_, i) => Math.max(600 - bbPred[i]! - kPred[i]! - hrPred[i]! - 6 - 3 + 4, 1));

  const hB = runModel("h", players.map((_, i) => [1, ln1(BABIP[i]!), ln1(bipPred[i]!)]), nonHRH);
  const hPred = players.map((_, i) => Math.max(hB[0]! + hB[1]! * ln1(BABIP[i]!) + hB[2]! * ln1(bipPred[i]!), 0));

  // XBH as a log-share of predicted hits: XBH/predH = logA + logB·ln(GAP).
  const xbhShareY = players.map((_, i) => hPred[i]! > 1 ? XBH[i]! / hPred[i]! : 0);
  const xbhB = runModel("xbh", players.map((_, i) => [1, ln1(GAP[i]!)]), xbhShareY);
  const xbhPred = players.map((_, i) => Math.max((xbhB[0]! + xbhB[1]! * ln1(GAP[i]!)) * hPred[i]!, 0));

  // Residual-by-weighted-volume bins per event (diagnostic only; no softcap rec).
  diagnostics.bb!.bins = residualBins(EYE, bbPred.map((p, i) => p - BB[i]!), weights, bbB[1]!);
  diagnostics.k!.bins = residualBins(Krat, kPred.map((p, i) => p - K[i]!), weights, kB[1]!);
  diagnostics.hr!.bins = residualBins(POW, hrPred.map((p, i) => p - HR[i]!), weights, hrB[1]!);
  diagnostics.h!.bins = residualBins(BABIP, hPred.map((p, i) => p - nonHRH[i]!), weights, hB[1]!);
  diagnostics.xbh!.bins = residualBins(GAP, xbhPred.map((p, i) => p - XBH[i]!), weights, xbhB[1]!);

  diagnostics.hbp = { r2: null, rmse: null, spearman: null, n, note: "Fixed constant = 6.0" };

  const totalW = weights.reduce((s, w) => s + w, 0);
  const wavg = (arr: number[]) => arr.reduce((s, v, i) => s + weights[i]! * v, 0) / totalW;

  const coefficients: WobaHittingCoeffs = {
    bb: { intercept: bbB[0]!, eye: bbB[1]!, eye2: 0, eye3: 0 },
    k: { intercept: kB[0]!, k: kB[1]!, k2: 0 },
    hr: { intercept: hrB[0]!, pow: hrB[1]!, pow2: 0, pow3: 0, alt_log: true },
    h: { intercept: hB[0]!, ba: hB[1]!, bipba: hB[2]! },
    xbh: { logA: xbhB[0]!, logB: xbhB[1]! },
    hbp: { constant: 6.0 },
    leagueNorm: {
      bb: r6(H_SECTION3.BB / wavg(bbPred)),
      k: r6(H_SECTION3.K / wavg(kPred)),
      hr: r6(H_SECTION3.HR / wavg(hrPred)),
      h: r6(H_SECTION3.H / wavg(hPred)),
      xbh: r6(H_SECTION3.XBH / wavg(xbhPred)),
    },
  };

  return { modelType: "woba_hitting", split: "both", minPA, rowCount: n, coefficients, diagnostics };
}

// ── wOBA pitching (parity port of trainWobaPitching; uses `wls`) ───────────────
export interface WobaPitchingCoeffs {
  bb: { intercept: number; con: number; con2: number; con3: number };
  k: { intercept: number; stu: number; stu2: number; stu3: number };
  hr: { intercept: number; hrr: number; hrr2: number; hrr_exgb: number; hrr_gb: number; hrr_fb: number; hrr_exfb: number };
  h: { intercept: number; pbabip: number; bip: number };
  xbh: { share: number };
  leagueNorm: { bb: number; k: number; hr: number; h: number; xbh: number };
}
export interface WobaPitchingFit {
  modelType: "woba_pitching"; split: "both"; minBF: number; rowCount: number;
  coefficients: WobaPitchingCoeffs; diagnostics: Record<string, EventDiag>;
}

export function trainWobaPitching(obs: TrainObs[], minBF = 1000): WobaPitchingFit {
  const players = obs.filter((o) => o.pitch.BF >= minBF);
  if (players.length < 10) throw new Error(`Only ${players.length} observations meet minBF=${minBF} (need 10+)`);
  const n = players.length;
  const weights = players.map((p) => Math.pow(p.pitch.BF, 0.75));
  const per600 = (f: (o: TrainObs) => number) => players.map((p) => f(p) / p.pitch.BF * 600);

  const BB = per600((p) => p.pitch.BB);
  const K = per600((p) => p.pitch.K);
  const HR = per600((p) => p.pitch.HR);
  const nHH = per600((p) => p.pitch.b1 + p.pitch.b2 + p.pitch.b3);

  const CON = players.map((p) => p.ratings.pitch.con);
  const STU = players.map((p) => p.ratings.pitch.stu);
  const HRR = players.map((p) => p.ratings.pitch.hrr);
  const PBABIP = players.map((p) => p.ratings.pitch.pbabip);

  const diagnostics: Record<string, EventDiag> = {};
  const runModel = (name: string, X: number[][], y: number[]): number[] => {
    const beta = wls(X, y, weights);
    const pred = X.map((row) => row.reduce((s, x, j) => s + x * beta[j]!, 0));
    diagnostics[name] = { r2: +rSquared(y, pred, weights).toFixed(4), rmse: +rmse(y, pred).toFixed(4), spearman: +spearman(y, pred).toFixed(4), pearson: +pearson(y, pred).toFixed(4), n };
    return beta;
  };

  const bbB = runModel("bb", players.map((_, i) => [1, ln1(CON[i]!)]), BB);
  const kB = runModel("k", players.map((_, i) => [1, ln1(STU[i]!)]), K);
  const hrB = runModel("hr", players.map((_, i) => [1, ln1(HRR[i]!)]), HR);

  const bbPred = players.map((_, i) => Math.max(bbB[0]! + bbB[1]! * ln1(CON[i]!), 0));
  const kPred = players.map((_, i) => Math.max(kB[0]! + kB[1]! * ln1(STU[i]!), 0));
  const hrPred = players.map((_, i) => Math.max(hrB[0]! + hrB[1]! * ln1(HRR[i]!), 0));
  const bipPred = players.map((_, i) => Math.max(600 - bbPred[i]! - kPred[i]! - hrPred[i]! - 6, 1)); // HBP=6

  const hB = runModel("h", players.map((_, i) => [1, ln1(PBABIP[i]!), ln1(bipPred[i]!)]), nHH);
  const hPred = players.map((_, i) => Math.max(hB[0]! + hB[1]! * ln1(PBABIP[i]!) + hB[2]! * ln1(bipPred[i]!), 0));

  diagnostics.bb!.bins = residualBins(CON, bbPred.map((p, i) => p - BB[i]!), weights, bbB[1]!);
  diagnostics.k!.bins = residualBins(STU, kPred.map((p, i) => p - K[i]!), weights, kB[1]!);
  diagnostics.hr!.bins = residualBins(HRR, hrPred.map((p, i) => p - HR[i]!), weights, hrB[1]!);
  diagnostics.h!.bins = residualBins(PBABIP, hPred.map((p, i) => p - nHH[i]!), weights, hB[1]!);

  const totalW = weights.reduce((s, w) => s + w, 0);
  const wavg = (arr: number[]) => arr.reduce((s, v, i) => s + weights[i]! * v, 0) / totalW;
  const xbhPred = hPred.map((h) => h * 0.25);

  const coefficients: WobaPitchingCoeffs = {
    bb: { intercept: bbB[0]!, con: bbB[1]!, con2: 0, con3: 0 },
    k: { intercept: kB[0]!, stu: kB[1]!, stu2: 0, stu3: 0 },
    hr: { intercept: hrB[0]!, hrr: hrB[1]!, hrr2: 0, hrr_exgb: 0, hrr_gb: 0, hrr_fb: 0, hrr_exfb: 0 },
    h: { intercept: hB[0]!, pbabip: hB[1]!, bip: hB[2]! },
    xbh: { share: 0.25 },
    leagueNorm: {
      bb: r6(P_SECTION3.BB / wavg(bbPred)), k: r6(P_SECTION3.K / wavg(kPred)), hr: r6(P_SECTION3.HR / wavg(hrPred)),
      h: r6(P_SECTION3.H / wavg(hPred)), xbh: r6(P_SECTION3.XBH / wavg(xbhPred)),
    },
  };
  return { modelType: "woba_pitching", split: "both", minBF, rowCount: n, coefficients, diagnostics };
}

// ── Basic models (parity port; use `wlsSolve`; intercept clamped ≥ 0) ──────────
export interface BasicHittingCoeffs {
  basic_intercept: number; w_babip: number; w_babip2: number; w_pow: number; w_pow2: number;
  w_eye: number; w_eye2: number; w_k: number; w_k2: number; w_gap: number; w_gap2: number;
}
export interface BasicPitchingCoeffs {
  basic_intercept: number; p_stuff: number; p_stuff2: number; p_control: number; p_control2: number;
  p_babip: number; p_babip2: number; p_hr: number; p_hr2: number;
}
export interface BasicFit<C> { modelType: string; minPA?: number; minBF?: number; rowCount: number; coefficients: C; diagnostics: { weights: EventDiag } }

export function trainBasicHitting(obs: TrainObs[], minPA = 1000): BasicFit<BasicHittingCoeffs> {
  const players = obs.filter((o) => o.hit.PA >= minPA);
  if (players.length < 10) throw new Error(`Only ${players.length} observations with PA>=${minPA}`);
  const weights = players.map((p) => Math.pow(p.hit.PA, 0.75));
  // Y: actual wOBA × 333 (per PA, matching the basic-hitting score scale).
  const y = players.map((p) => {
    const b1 = Math.max(p.hit.H - p.hit.HR - p.hit.b2 - p.hit.b3, 0);
    return (0.704 * p.hit.BB + 0.8992 * b1 + 1.29 * (p.hit.b2 + p.hit.b3) + 2.0759 * p.hit.HR) / Math.max(p.hit.PA, 1) * 333;
  });
  const r = players.map((p) => p.ratings.hit);
  const X = players.map((_, i) => [1, ln1(r[i]!.babip), ln1(r[i]!.pow), ln1(r[i]!.eye), ln1(r[i]!.kRat), ln1(r[i]!.gap)]);
  const beta = wlsSolve(X, y, weights);
  const pred = X.map((row) => row.reduce((s, x, j) => s + beta[j]! * x, 0)); // pred uses the UNCLAMPED beta
  if (beta[0]! < 0) beta[0] = 0;
  const coefficients: BasicHittingCoeffs = {
    basic_intercept: beta[0]!, w_babip: beta[1]!, w_babip2: 0, w_pow: beta[2]!, w_pow2: 0,
    w_eye: beta[3]!, w_eye2: 0, w_k: beta[4]!, w_k2: 0, w_gap: beta[5]!, w_gap2: 0,
  };
  const diagnostics = { weights: { r2: +rSquared(y, pred, weights).toFixed(4), rmse: +rmse(y, pred).toFixed(4), spearman: +spearman(y, pred).toFixed(4), pearson: +pearson(y, pred).toFixed(4), n: players.length } };
  return { modelType: "basic_hitting", minPA, rowCount: players.length, coefficients, diagnostics };
}

export function trainBasicPitching(obs: TrainObs[], minBF = 1000): BasicFit<BasicPitchingCoeffs> {
  const players = obs.filter((o) => o.pitch.BF >= minBF);
  if (players.length < 10) throw new Error(`Only ${players.length} observations with BF>=${minBF}`);
  const weights = players.map((p) => Math.pow(p.pitch.BF, 0.75));
  // Y: (0.64 − wOBA allowed) × 333 — higher = better pitcher.
  const y = players.map((p) => {
    const xbh = p.pitch.b2 + p.pitch.b3;
    const wobaAllowed = (0.704 * p.pitch.BB + 0.8992 * p.pitch.b1 + 1.29 * xbh + 2.0759 * p.pitch.HR) / Math.max(p.pitch.BF, 1);
    return (0.64 - wobaAllowed) * 333;
  });
  const r = players.map((p) => p.ratings.pitch);
  const X = players.map((_, i) => [1, ln1(r[i]!.stu), ln1(r[i]!.con), ln1(r[i]!.pbabip), ln1(r[i]!.hrr)]);
  const beta = wlsSolve(X, y, weights);
  const pred = X.map((row) => row.reduce((s, x, j) => s + beta[j]! * x, 0));
  if (beta[0]! < 0) beta[0] = 0;
  const coefficients: BasicPitchingCoeffs = {
    basic_intercept: beta[0]!, p_stuff: beta[1]!, p_stuff2: 0, p_control: beta[2]!, p_control2: 0,
    p_babip: beta[3]!, p_babip2: 0, p_hr: beta[4]!, p_hr2: 0,
  };
  const diagnostics = { weights: { r2: +rSquared(y, pred, weights).toFixed(4), rmse: +rmse(y, pred).toFixed(4), spearman: +spearman(y, pred).toFixed(4), pearson: +pearson(y, pred).toFixed(4), n: players.length } };
  return { modelType: "basic_pitching", minBF, rowCount: players.length, coefficients, diagnostics };
}
