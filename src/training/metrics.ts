// M6 — model-evaluation metric library. Operates on (predicted, actual, weight)
// arrays in wOBA space (or per-event). Design notes (decided with the user):
//   • We care about RELATIVE gaps, not absolute level: a uniform shift/scale of a
//     pool's predicted wOBA doesn't change the roster (value = wOBA − pool baseline;
//     the objective is affine-invariant per pool). So the headline fidelity metric
//     is WEIGHTED PEARSON r (affine-invariant, gap-sensitive), NOT raw RMSE.
//   • R² (coefficient of determination) is kept only as a diagnostic: the gap
//     R² ⟶ Pearson r² measures how much purely-harmless shift/scale bias exists.
//   • Decision relevance: top-N overlap + value-regret (rank by predicted, score by
//     actual) — naturally shift/scale invariant.
// All weighted by PA^0.75 / BF^0.75 unless noted (rank metrics are unweighted).

import { spearman } from "./fit.ts";

const wsum = (w: number[]) => w.reduce((s, x) => s + x, 0);
const wmean = (x: number[], w: number[]) => { const W = wsum(w); return x.reduce((s, v, i) => s + w[i]! * v, 0) / W; };

/** Weighted Pearson correlation — affine-invariant gap fidelity (headline). */
export function wPearson(pred: number[], actual: number[], w: number[]): number {
  const mp = wmean(pred, w), ma = wmean(actual, w);
  let cov = 0, vp = 0, va = 0;
  for (let i = 0; i < pred.length; i++) {
    const dp = pred[i]! - mp, da = actual[i]! - ma;
    cov += w[i]! * dp * da; vp += w[i]! * dp * dp; va += w[i]! * da * da;
  }
  return vp * va < 1e-15 ? 0 : cov / Math.sqrt(vp * va);
}

/** Weighted coefficient of determination (vs the 1:1 line; penalizes shift+scale). */
export function wR2(pred: number[], actual: number[], w: number[]): number {
  const ma = wmean(actual, w);
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < pred.length; i++) { ssRes += w[i]! * (actual[i]! - pred[i]!) ** 2; ssTot += w[i]! * (actual[i]! - ma) ** 2; }
  return ssTot < 1e-15 ? 0 : 1 - ssRes / ssTot;
}

export function wRmse(pred: number[], actual: number[], w: number[]): number {
  let s = 0; const W = wsum(w);
  for (let i = 0; i < pred.length; i++) s += w[i]! * (pred[i]! - actual[i]!) ** 2;
  return Math.sqrt(s / W);
}
export function wMae(pred: number[], actual: number[], w: number[]): number {
  let s = 0; const W = wsum(w);
  for (let i = 0; i < pred.length; i++) s += w[i]! * Math.abs(pred[i]! - actual[i]!);
  return s / W;
}
/** Weighted mean residual (predicted − actual); ~0 for an unbiased fit. */
export function wBias(pred: number[], actual: number[], w: number[]): number {
  return wmean(pred.map((p, i) => p - actual[i]!), w);
}

/**
 * Gap-distortion RMSE: weighted residual RMSE AFTER the best affine alignment
 * (actual ≈ α + β·pred). Removes the harmless shift/scale and reports only the
 * distortion of the relative-gap structure the optimizer actually feels.
 */
export function gapDistortionRmse(pred: number[], actual: number[], w: number[]): number {
  const mp = wmean(pred, w), ma = wmean(actual, w);
  let cov = 0, vp = 0;
  for (let i = 0; i < pred.length; i++) { const dp = pred[i]! - mp; cov += w[i]! * dp * (actual[i]! - ma); vp += w[i]! * dp * dp; }
  const beta = vp < 1e-15 ? 0 : cov / vp;
  const alpha = ma - beta * mp;
  return wRmse(pred.map((p) => alpha + beta * p), actual, w);
}

const rank = (x: number[]): number[] => {
  const order = x.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const r = new Array<number>(x.length);
  order.forEach((o, k) => { r[o.i] = k; });
  return r;
};
/** Indices of the top-N by value (higherBetter=false ranks ascending — pitchers). */
function topIdx(value: number[], n: number, higherBetter: boolean): Set<number> {
  const order = value.map((v, i) => ({ v, i })).sort((a, b) => (higherBetter ? b.v - a.v : a.v - b.v));
  return new Set(order.slice(0, n).map((o) => o.i));
}

/** Fraction of the model's top-N that are truly top-N (by actual). */
export function topNOverlap(pred: number[], actual: number[], n: number, higherBetter: boolean): number {
  const P = topIdx(pred, n, higherBetter), A = topIdx(actual, n, higherBetter);
  let hit = 0; for (const i of P) if (A.has(i)) hit++;
  return hit / n;
}

/**
 * Value-regret: pick the model's top-N, measure the actual-value shortfall vs the
 * true top-N, averaged per slot (in wOBA units). 0 = perfect; lower = better.
 * Shift/scale invariant in the prediction (selection is by predicted rank).
 */
export function valueRegret(pred: number[], actual: number[], n: number, higherBetter: boolean): number {
  const picked = topIdx(pred, n, higherBetter);
  const sortedActual = [...actual].sort((a, b) => (higherBetter ? b - a : a - b));
  const bestSum = sortedActual.slice(0, n).reduce((s, v) => s + v, 0);
  let pickSum = 0; for (const i of picked) pickSum += actual[i]!;
  // For pitchers (lower better) the shortfall is pickSum − bestSum; normalize to ≥0.
  return Math.abs(bestSum - pickSum) / n;
}

export interface EvalMetrics {
  n: number;
  pearson: number;        // headline fidelity (affine-invariant, gap-sensitive)
  r2: number;             // diagnostic (vs 1:1; r2≪pearson² ⇒ harmless shift/scale)
  spearman: number;       // ordering
  gapRmse: number;        // gap-distortion (affine-aligned residual)
  rmse: number; mae: number; bias: number;
  topNOverlap: number; valueRegret: number; topN: number;
}

/** Full metric bundle for one (predicted, actual, weight) set in wOBA space. */
export function evalMetrics(pred: number[], actual: number[], w: number[], higherBetter: boolean, topN = 26): EvalMetrics {
  const n = pred.length;
  const N = Math.min(topN, n);
  return {
    n,
    pearson: +wPearson(pred, actual, w).toFixed(4),
    r2: +wR2(pred, actual, w).toFixed(4),
    spearman: +spearman(pred, actual).toFixed(4),
    gapRmse: +gapDistortionRmse(pred, actual, w).toFixed(5),
    rmse: +wRmse(pred, actual, w).toFixed(5),
    mae: +wMae(pred, actual, w).toFixed(5),
    bias: +wBias(pred, actual, w).toFixed(5),
    topNOverlap: +topNOverlap(pred, actual, N, higherBetter).toFixed(4),
    valueRegret: +valueRegret(pred, actual, N, higherBetter).toFixed(5),
    topN: N,
  };
}
