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

export interface EventDiag { r2: number | null; rmse: number | null; spearman: number | null; pearson?: number | null; n: number; note?: string }
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

// PA-weighted Section-3 baseline targets (per 600 PA) used for league normalization.
const H_SECTION3 = { BB: 48.43, K: 117.40, HR: 14.87, H: 124.75, XBH: 31.26 };
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
