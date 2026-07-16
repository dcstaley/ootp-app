// THE TWO-LEDGER DIAGNOSTIC core — pure statistics behind `tools/cwhit-two-ledger.ts`.
//
// PURPOSE (Derek's steer): the composite (wOBA / wOBAA) level bias is NOT the thing to worry about —
// the PER-CHANNEL error levels are. This module MEASURES; it fits nothing and feeds nothing into the
// scoring path. Three instruments:
//
//   1. CHANNEL ATTRIBUTION — decompose a composite's level bias into each channel's contribution, in
//      composite units, by one-at-a-time substitution. Answers "is hitter wOBA's ~0 bias correctness
//      or cancellation?" and, critically, reports the part the channels DON'T explain instead of
//      silently absorbing it.
//
//   2. THE TWO-LEDGER TEST — hitters and pitchers are two views of THE SAME GAMES, so a genuine frame
//      effect must show the SAME SIGN from both sides. Two INDEPENDENT estimates of one physical
//      quantity = a free falsification test. Requires a common unit (per-PA ≡ per-BF).
//
//   3. THE SELECTION / SPREAD-ARTIFACT TEST — the discriminator between a genuine format constant and
//      a regression-to-mean artifact:
//        · a genuine level constant is FLAT across the quality range;
//        · a spread artifact is a GRADIENT in predicted quality (a compressed predictor's error is
//          proportional to −(pred − poolmean)).
//      Since we judge on top-100-BY-USAGE subsamples (= the best hitters and the best pitchers), a
//      compressed predictor under-predicts elite hitters' HR and over-predicts elite pitchers' HR
//      allowed — one gradient, opposite selection, opposite-signed level bias. Testable, so tested.
//
// ── THE REGRESSOR CHOICE (load-bearing; do not "fix" it to obs) ──────────────────────────────────
// The gradient regresses bias on PREDICTED quality, never on observed. Regressing bias = (pred − obs)
// on OBS is mechanically biased: cov(pred−obs, obs) = cov(pred,obs) − var(obs), and var(obs) carries
// binomial sampling noise, so even a PERFECT predictor yields a spurious negative slope of size
// −noiseVar/var(obs). PRED is a deterministic model output with zero sampling noise and is
// uncorrelated with the observed noise, so cov(pred, noise) = 0 and the slope is clean. This is the
// classic errors-in-variables trap and it is exactly the artifact the test is trying to detect —
// regressing on obs would MANUFACTURE the very gradient we are here to measure.

import { SAC_PER_PA, HBP_PER_PA, BF_PER_9 } from "./scorecard.ts";

export type Chan = Record<string, number>;

// ── estimate plumbing ────────────────────────────────────────────────────────

/** A point estimate with a 95% CI. `sig` = CI excludes 0. */
export interface Est { est: number; lo: number; hi: number; se: number; n: number; sig: boolean }

const mk = (est: number, se: number, n: number, crit: number): Est =>
  ({ est, se, n, lo: est - crit * se, hi: est + crit * se, sig: (est - crit * se) * (est + crit * se) > 0 });

/**
 * Two-sided 95% t quantile (Abramowitz & Stegun 26.7.5). The rest of the eval stack uses a flat 1.96,
 * which is fine at N=100 but materially anti-conservative at the N=11–22 cells this diagnostic must
 * report on (t(9) = 2.26, a 15% wider CI). Using t here is a deliberate divergence: the whole point of
 * this tool is to say honestly when a cell CANNOT separate flat from gradient, and a normal CI at
 * N=11 would understate exactly that.
 */
export function t95(df: number): number {
  if (!(df > 0)) return NaN;
  if (df > 200) return 1.959964;
  const z = 1.959964, v = df;
  return z + (z ** 3 + z) / (4 * v) + (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * v ** 2)
    + (3 * z ** 7 + 19 * z ** 5 + 17 * z ** 3 - 15 * z) / (384 * v ** 3)
    + (79 * z ** 9 + 776 * z ** 7 + 1482 * z ** 5 - 1920 * z ** 3 - 945 * z) / (92160 * v ** 4);
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const sdPop = (xs: number[]): number => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };

/** Mean of a series with a t-based 95% CI (cards are the unit). */
export function meanEst(xs: number[]): Est {
  const v = xs.filter((x) => Number.isFinite(x));
  const n = v.length;
  if (n < 2) return { est: n ? v[0]! : NaN, se: NaN, n, lo: NaN, hi: NaN, sig: false };
  const m = mean(v);
  const se = Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / (n - 1)) / Math.sqrt(n);
  return mk(m, se, n, t95(n - 1));
}

/** Rescale an estimate by an EXACT constant (unit conversion): the CI scales with it. */
export function scaleEst(e: Est, k: number): Est {
  return { est: e.est * k, se: e.se * Math.abs(k), n: e.n, lo: Math.min(e.lo * k, e.hi * k), hi: Math.max(e.lo * k, e.hi * k), sig: e.sig };
}

/** Difference of two INDEPENDENT estimates (different card sets ⇒ independent errors). */
export function diffEst(a: Est, b: Est): Est {
  const se = Math.sqrt(a.se ** 2 + b.se ** 2);
  const df = Math.max(Math.min(a.n, b.n) - 1, 1);
  return mk(a.est - b.est, se, Math.min(a.n, b.n), t95(df));
}

// ── 1. CHANNEL ATTRIBUTION ───────────────────────────────────────────────────

export interface AttribRow<C = unknown> { obs: Chan; pred: Chan; mPred: number; mObs: number; ctx: C }

export interface AttribResult {
  n: number;
  /** Per-channel contribution to the composite level bias, in composite units. */
  channels: { channel: string; contrib: Est }[];
  /** Σ of the one-at-a-time contributions. */
  sumSingles: number;
  /** Substituting ALL channels at once — the attribution's own total. */
  fullSub: Est;
  /** fullSub − sumSingles: the non-additivity of the composite assembly. */
  interaction: number;
  /** The composite bias the scorecard actually reports (mean(predWoba − obsWoba)). */
  measured: Est;
  /** measured − fullSub: the part the four channels DO NOT explain through the common assembly.
   *  For pitchers this MUST be ~0 (pred and obs wOBAA are literally built by that assembly) — it is a
   *  self-check on the whole method. For hitters it is real: our predicted wOBA comes from the model's
   *  own 1B/XBH split, while the observed wOBA is rebuilt from cwhit's AVG/SLG hit-mix, so the residual
   *  isolates the HIT-MIX (XBH) channel that the four headline channels cannot see. */
  reconResid: Est;
}

/**
 * Attribute a composite's level bias to its channels by ONE-AT-A-TIME substitution: start from the
 * card's OBSERVED line, swap in the PREDICTED value of one channel, and read the change in the
 * composite. Per-card, then averaged — so every contribution carries an honest card-level CI.
 *
 * `assemble(row, ch)` must be the SAME function for both sides. Any interaction (the composite is not
 * additive in its channels) shows up in `interaction`, and anything the channels cannot reach shows up
 * in `reconResid`. Neither is swept up: a decomposition that does not reconstruct its total is a
 * finding, not a rounding error.
 */
export function attributeComposite<C>(
  rows: AttribRow<C>[],
  channels: string[],
  assemble: (r: AttribRow<C>, ch: Chan) => number,
): AttribResult {
  const per = channels.map((c) => ({
    channel: c,
    contrib: meanEst(rows.map((r) => assemble(r, { ...r.obs, [c]: r.pred[c]! }) - assemble(r, r.obs))),
  }));
  const full = meanEst(rows.map((r) => {
    const swapped = { ...r.obs };
    for (const c of channels) swapped[c] = r.pred[c]!;
    return assemble(r, swapped) - assemble(r, r.obs);
  }));
  const measured = meanEst(rows.map((r) => r.mPred - r.mObs));
  const resid = meanEst(rows.map((r) => {
    const swapped = { ...r.obs };
    for (const c of channels) swapped[c] = r.pred[c]!;
    return (r.mPred - r.mObs) - (assemble(r, swapped) - assemble(r, r.obs));
  }));
  const sumSingles = per.reduce((a, p) => a + p.contrib.est, 0);
  return { n: rows.length, channels: per, sumSingles, fullSub: full, interaction: full.est - sumSingles, measured, reconResid: resid };
}

// ── 2. THE TWO-LEDGER TEST (common unit) ─────────────────────────────────────

/** Multiplier that converts a channel's native level-bias unit to the COMMON per-PA (≡ per-BF) unit. */
export function commonUnitFactor(role: "pit" | "hit", channel: string): { k: number; note: string } {
  if (role === "hit") {
    if (channel === "bbPct" || channel === "soPct") return { k: 1 / 100, note: "pp per PA ÷ 100" };
    if (channel === "hr600") return { k: 1 / 600, note: "per 600 PA ÷ 600" };
    if (channel === "babip") return { k: 1, note: "already a per-BIP rate — no conversion, no BF/9 exposure" };
  } else {
    if (channel === "k9" || channel === "bb9" || channel === "hr9") return { k: 1 / BF_PER_9, note: `per 9 IP ÷ BF/9=${BF_PER_9.toFixed(1)} (ASSUMED IP×4.3)` };
    if (channel === "babip") return { k: 1, note: "already a per-BIP rate — no conversion, no BF/9 exposure" };
  }
  return { k: NaN, note: "no common-unit mapping" };
}

/** The physical channel a role's channel label maps onto (the thing both sides are estimating). */
export const LEDGER_PAIRS: { channel: string; hit: string; pit: string }[] = [
  { channel: "BB", hit: "bbPct", pit: "bb9" },
  { channel: "K", hit: "soPct", pit: "k9" },
  { channel: "HR", hit: "hr600", pit: "hr9" },
  { channel: "BABIP", hit: "babip", pit: "babip" },
];

export interface LedgerCompare {
  channel: string;
  hit: Est; pit: Est;           // both in the COMMON per-PA/per-BF unit
  diff: Est;                    // hit − pit
  signAgree: boolean;           // both CI-clear and same sign
  ciOverlap: boolean;           // the difference's CI includes 0 ⇒ statistically one number
  verdict: string;
}

/** Compare the hitter-side and pitcher-side estimate of ONE channel's frame effect. */
export function ledgerCompare(channel: string, hit: Est, pit: Est): LedgerCompare {
  const diff = diffEst(hit, pit);
  const bothSig = hit.sig && pit.sig;
  const signAgree = bothSig && Math.sign(hit.est) === Math.sign(pit.est);
  const ciOverlap = !diff.sig;
  const verdict = !bothSig
    ? "INCONCLUSIVE — a side's estimate is not CI-clear of zero; no cross-check available"
    : signAgree
      ? (ciOverlap
        ? "AGREE (sign + magnitude) — two independent views of the same games give one number ⇒ a coherent frame effect; LEGAL fit target"
        : "AGREE ON SIGN, DIFFER ON MAGNITUDE — the direction replicates but the size does not; a frame effect PLUS a role-specific component")
      : "DISAGREE (sign flips) — the two views of the SAME games contradict ⇒ NOT a single frame constant; something role-specific is generating it (§C decomposes what)";
  return { channel, hit, pit, diff, signAgree, ciOverlap, verdict };
}

// ── 3. THE SELECTION / SPREAD-ARTIFACT TEST ──────────────────────────────────

export interface Gradient {
  n: number;
  /** Intercept at the SAMPLE-mean quality. Because the regressor is centered, this IS the mean bias. */
  constant: Est;
  /** d(bias)/d(predicted quality). Negative ⇒ the compression signature. */
  slope: Est;
  qualMean: number; qualSd: number; qualMin: number; qualMax: number;
  r2: number;
  /** 1.96·SE(slope)-scale smallest gradient this sample could have called CI-clear. */
  minDetectableSlope: number;
}

/**
 * Regress per-card level bias (pred − obs) on CENTERED predicted quality. See the module header for
 * why the regressor is PRED and not OBS. Returns the flat component (intercept at the sample mean) and
 * the gradient, each with a t-based CI. OLS intercept-at-mean and slope are UNCORRELATED, which is
 * what makes the pool decomposition below exact.
 */
export function biasGradient(pred: number[], obs: number[]): Gradient {
  const keep = pred.map((_, i) => i).filter((i) => Number.isFinite(pred[i]!) && Number.isFinite(obs[i]!));
  const x = keep.map((i) => pred[i]!), y = keep.map((i) => pred[i]! - obs[i]!);
  const n = x.length;
  const nan: Est = { est: NaN, lo: NaN, hi: NaN, se: NaN, n, sig: false };
  const base = { n, qualMean: mean(x), qualSd: sdPop(x), qualMin: Math.min(...x), qualMax: Math.max(...x) };
  if (n < 4) return { ...base, constant: nan, slope: nan, r2: NaN, minDetectableSlope: NaN };
  const mx = mean(x), my = mean(y);
  const sxx = x.reduce((a, v) => a + (v - mx) ** 2, 0);
  const sxy = x.reduce((a, v, i) => a + (v - mx) * (y[i]! - my), 0);
  const syy = y.reduce((a, v) => a + (v - my) ** 2, 0);
  const b = sxx > 0 ? sxy / sxx : NaN;
  const resSs = y.reduce((a, v, i) => a + (v - (my + b * (x[i]! - mx))) ** 2, 0);
  const s2 = resSs / (n - 2);
  const crit = t95(n - 2);
  const seB = Math.sqrt(s2 / sxx), seA = Math.sqrt(s2 / n);
  return {
    ...base,
    constant: mk(my, seA, n, crit),
    slope: mk(b, seB, n, crit),
    r2: syy > 0 ? 1 - resSs / syy : NaN,
    minDetectableSlope: crit * seB,
  };
}

export type GradVerdict = "FLAT" | "GRADIENT" | "BOTH" | "NEITHER";

/** FLAT = a genuine level constant. GRADIENT = a pure spread artifact. BOTH = a constant PLUS an
 *  artifact (decompose). NEITHER = the cell cannot call it — read `minDetectableSlope` and say so. */
export function gradientVerdict(g: Gradient): GradVerdict {
  const c = g.constant.sig, s = g.slope.sig;
  return c && s ? "BOTH" : c ? "FLAT" : s ? "GRADIENT" : "NEITHER";
}

export interface PoolDecomp {
  poolMean: number; poolSd: number; poolN: number;
  sampleMean: number; sampleSd: number;
  /** sampleMean − poolMean, in the channel's own units. THE selection displacement. */
  displacement: number;
  /** displacement in pool-SD units — how far out on the tail the judged sample sits. */
  displacementSd: number;
  /** sampleSd / poolSd — how much of the pool's quality range the judged sample spans. */
  rangeFrac: number;
  /** slope × displacement: the part of the sample's mean bias the gradient explains by selection. */
  artifact: Est;
  /** meanBias − artifact: the level bias extrapolated to a POOL-AVERAGE card = the real constant. */
  constAtPool: Est;
  /** TRUE when the gradient must be extrapolated outside the sample's own quality range to reach the
   *  pool mean — the decomposition is then a model-dependent extrapolation, not a measurement. */
  extrapolated: boolean;
}

/**
 * Split the sample's mean level bias into a REAL CONSTANT (what a pool-average card would show) and a
 * SELECTION ARTIFACT (the gradient acting over the sample's displacement from the pool mean).
 *
 *   bias(q) = c_sample + β·(q − q̄_sample)  ⇒  constAtPool = c_sample − β·(q̄_sample − q̄_pool)
 *
 * Exact CIs: OLS intercept-at-mean and slope are uncorrelated, so
 * Var(constAtPool) = Var(c) + displacement²·Var(β) with no covariance term.
 *
 * CAVEAT (`extrapolated`): when the pool mean lies outside the judged sample's quality range this
 * assumes the gradient stays linear where nothing was observed. That is the assumption the top-100
 * capture makes unavoidable — surface it, never bury it.
 */
export function decomposeAtPool(g: Gradient, poolQual: number[]): PoolDecomp {
  const p = poolQual.filter((x) => Number.isFinite(x));
  const poolMean = mean(p), poolSd = sdPop(p);
  const displacement = g.qualMean - poolMean;
  const artifact = mk(g.slope.est * displacement, g.slope.se * Math.abs(displacement), g.n, t95(Math.max(g.n - 2, 1)));
  const seConst = Math.sqrt(g.constant.se ** 2 + displacement ** 2 * g.slope.se ** 2);
  return {
    poolMean, poolSd, poolN: p.length,
    sampleMean: g.qualMean, sampleSd: g.qualSd,
    displacement,
    displacementSd: poolSd > 0 ? displacement / poolSd : NaN,
    rangeFrac: poolSd > 0 ? g.qualSd / poolSd : NaN,
    artifact,
    constAtPool: mk(g.constant.est - artifact.est, seConst, g.n, t95(Math.max(g.n - 2, 1))),
    extrapolated: poolMean < g.qualMin || poolMean > g.qualMax,
  };
}

export interface QBin { label: string; n: number; qualMean: number; bias: Est }

/** Quality quantile bins with per-bin mean bias — the non-parametric companion to the regression. A
 *  gradient the regression calls linear should show monotonically across these; if it doesn't, the
 *  linear extrapolation in `decomposeAtPool` is not trustworthy. */
export function qualityBins(pred: number[], obs: number[], k = 4): QBin[] {
  const rows = pred.map((_, i) => i)
    .filter((i) => Number.isFinite(pred[i]!) && Number.isFinite(obs[i]!))
    .map((i) => ({ q: pred[i]!, d: pred[i]! - obs[i]! }))
    .sort((a, b) => a.q - b.q);
  const out: QBin[] = [];
  for (let b = 0; b < k; b++) {
    const lo = Math.floor((b * rows.length) / k), hi = Math.floor(((b + 1) * rows.length) / k);
    const cell = rows.slice(lo, hi);
    if (!cell.length) continue;
    out.push({ label: `Q${b + 1}`, n: cell.length, qualMean: mean(cell.map((r) => r.q)), bias: meanEst(cell.map((r) => r.d)) });
  }
  return out;
}

// ── THE MMSE / SPACING BATTERY ───────────────────────────────────────────────
//
// THE QUESTION: our predictions are compressed (SD(pred)/SD(obs) ≈ 0.5–0.9). Is that a DEFECT, or is it
// a correctly humble predictor? Both look identical to a naive spread ratio, and the distinction decides
// whether there is anything to fix.
//
// THE ANSWER: an MMSE-optimal predictor (a posterior mean) is SUPPOSED to be shrunk — it satisfies
//   SD(pred)/SD(T) = corr(pred, T)
// exactly, where T is the true talent rate. Shrinking MORE than that is miscalibration; shrinking less is
// over-dispersion. So "optimal ratio" is not 1.0, it is `corr` — and a predictor with corr 0.95 that sits
// at ratio 0.54 is over-shrunk by ~1.8×, while one with corr 0.54 at ratio 0.54 is perfectly calibrated.
//
// THE PRIMARY STATISTIC IS THE CALIBRATION SLOPE, and it is NOISE-IMMUNE — this is the key point:
//   slope(obs ~ pred) = cov(obs,pred)/var(pred) = cov(T,pred)/var(pred)   [since obs = T + e and e ⊥ pred]
// The observed sampling noise lands entirely in the RESIDUAL, never in the estimand. So the slope needs NO
// deconvolution and carries no assumption about the noise model. slope = 1 ⟺ calibrated ⟺ consistent with
// optimal shrinkage. slope > 1 ⟺ we under-react by that factor.
// The SD-space form (ratio vs corr) says the SAME thing — slope = corr/ratio identically, in raw or
// deconvolved units — but needs the binomial noise model to get SD(T). Report both; trust the slope.
//
// NOTE the exact identity to §C's gradient: slope = 1 − β. They are one statistic in two framings, so the
// CIs agree by construction. §C asks "is the level bias flat or a gradient"; this asks "are we
// under-reacting". Same number, and that is a feature: the level and spacing stories are not independent.

export interface Mmse {
  n: number;
  corrRaw: number; corrDeconv: number;
  sdPred: number; sdObs: number; sdObsDeconv: number;
  ratioRaw: number; ratioDeconv: number;
  /** What an MMSE-optimal predictor's ratio SHOULD be = corr(pred, T). */
  optimalRatio: number;
  /** ratioDeconv / optimalRatio. 1 = optimally shrunk, <1 = OVER-shrunk, >1 = over-dispersed. */
  shrinkIndex: number;
  /** slope(obs~pred), noise-immune, with a t-CI. 1.0 = calibrated; >1 = we under-react by this factor. */
  slope: Est;
  noiseShare: number;
  verdict: string;
}

/** The full spacing battery for one pred/obs series. `noiseVar` per card (optional) enables the SD-space
 *  deconvolution; without it the deconvolved fields read NaN rather than silently echoing the raw ratio. */
export function mmse(pred: number[], obs: number[], noiseVar?: number[]): Mmse {
  const keep = pred.map((_, i) => i).filter((i) => Number.isFinite(pred[i]!) && Number.isFinite(obs[i]!));
  const p = keep.map((i) => pred[i]!), o = keep.map((i) => obs[i]!);
  const n = p.length;
  const g = biasGradient(p, o);
  // slope = 1 − β, exactly; the CI flips with the sign.
  const slope: Est = {
    est: 1 - g.slope.est, lo: 1 - g.slope.hi, hi: 1 - g.slope.lo, se: g.slope.se, n,
    sig: (1 - g.slope.hi - 1) * (1 - g.slope.lo - 1) > 0,   // CI excludes 1 (calibration), not 0
  };
  const sdP = sdPop(p), sdO = sdPop(o);
  const nv = noiseVar ? mean(keep.map((i) => noiseVar[i] ?? 0)) : NaN;
  const sdOd = Number.isFinite(nv) ? Math.sqrt(Math.max(sdO ** 2 - nv, 0)) : NaN;
  const corrRaw = pearsonOf(p, o);
  // corr(pred,T) = corr(pred,obs) × SD(obs)/SD(T) — undo the attenuation from the observed noise.
  const corrDec = Number.isFinite(sdOd) && sdOd > 0 ? Math.min(corrRaw * (sdO / sdOd), 1) : NaN;
  const ratioRaw = sdO > 0 ? sdP / sdO : NaN;
  const ratioDec = sdOd > 0 ? sdP / sdOd : NaN;
  const shrink = Number.isFinite(corrDec) && corrDec > 0 ? ratioDec / corrDec : NaN;
  const verdict = !Number.isFinite(slope.est) ? "n/a"
    : !slope.sig ? "CALIBRATED — CI covers 1.0; consistent with honest MMSE shrinkage, nothing to fix"
      : slope.est > 1 ? `OVER-SHRUNK — we under-react ${slope.est.toFixed(2)}× (CI excludes 1.0)`
        : `OVER-DISPERSED — we over-react (slope ${slope.est.toFixed(2)} < 1, CI excludes 1.0)`;
  return {
    n, corrRaw, corrDeconv: corrDec, sdPred: sdP, sdObs: sdO, sdObsDeconv: sdOd,
    ratioRaw, ratioDeconv: ratioDec, optimalRatio: corrDec, shrinkIndex: shrink, slope,
    noiseShare: Number.isFinite(nv) && sdO > 0 ? nv / sdO ** 2 : NaN, verdict,
  };
}

function pearsonOf(xs: number[], ys: number[]): number {
  const nn = xs.length; if (nn < 3) return NaN;
  const mx = mean(xs), my = mean(ys);
  let cv = 0, vx = 0, vy = 0;
  for (let i = 0; i < nn; i++) { cv += (xs[i]! - mx) * (ys[i]! - my); vx += (xs[i]! - mx) ** 2; vy += (ys[i]! - my) ** 2; }
  return vx > 0 && vy > 0 ? cv / Math.sqrt(vx * vy) : NaN;
}

/** De-shrink a prediction to the calibration slope: mean + slope×(x − mean). LEVEL-PRESERVING by
 *  construction (the mean is untouched), so the change it produces in a composite is a PURE SPACING
 *  effect — which is what makes it a fair "what would fixing this channel's spacing be worth" probe. */
export const deShrink = (xs: number[], slope: number): number[] => {
  const m = mean(xs);
  return xs.map((x) => m + slope * (x - m));
};

/** De-meaned bias per quality quartile — the LEVEL-FREE view of spacing. A uniform compression marches
 *  monotonically across the quartiles; a tail-concentrated one is flat then dives at the top. */
export function spacingBins(pred: number[], obs: number[], k = 4): QBin[] {
  const keep = pred.map((_, i) => i).filter((i) => Number.isFinite(pred[i]!) && Number.isFinite(obs[i]!));
  const mp = mean(keep.map((i) => pred[i]!)), mo = mean(keep.map((i) => obs[i]!));
  const dp = pred.map((x) => x - mp), dobs = obs.map((x) => x - mo);
  return qualityBins(dp, dobs, k);
}

// ── THE PA/BF LEDGER (over-identification checks on the judged subsample) ─────

/**
 * BF/9 MEASURED from a pitcher's own observed line, instead of assumed.
 *
 * WHY IT MATTERS HERE: our predicted per-9 pitcher line is `per600 × BF_PER_9/600`, so BF/9 is a pure
 * MULTIPLIER on every predicted per-9 channel. If 4.3 is wrong, part of the pitcher K9/BB9/HR9 level
 * bias is a unit error rather than a frame effect — which would outrank every other reading. It is
 * also the only assumption the pitcher side of the two-ledger test carries that the hitter side (per-PA
 * natively) does not.
 *
 * IDENTITY (dominant terms): 9 IP = 27 outs = K + BIP outs, and BIP outs = BIP × (1 − BABIP), so
 *   BIP/9 = (27 − K9)/(1 − BABIP)   and   BF/9 = K9 + BB9 + HR9 + HBP9 + BIP/9.
 *
 * THIS IS AN UPPER BOUND, and deliberately so: double plays (a second out off one BIP), caught
 * stealing and pickoffs all retire batters/runners WITHOUT consuming a BIP, so ignoring them
 * over-states BIP/9 and hence BF/9 by roughly (DP + CS)/(1 − BABIP) ≈ 1.0–1.5. Reached-on-error pushes
 * the other way but is smaller. Read the measured value as "4.3 is right if the gap sits inside that
 * band"; the decisive test is `bfPer9ThatZeroes` (below), not this number alone.
 */
export function measuredBfPer9(k9: number, bb9: number, hr9: number, babip: number, hbp9 = 0.35): number {
  const bip9 = (27 - k9) / Math.max(1 - babip, 1e-6);
  return k9 + bb9 + hr9 + hbp9 + bip9;
}

/**
 * The BF/9 that would drive this channel's level bias to exactly zero. Since every predicted per-9
 * channel is proportional to BF/9, ONE BF/9 value must zero ALL of them if a unit error is the
 * explanation. Wildly different required values across channels ⇒ a single scalar cannot be the story,
 * and the biases are real. (BABIP is BF/9-INVARIANT — it is a ratio of per-600 quantities — so a BABIP
 * bias is, on its own, proof that a unit error is not the whole explanation.)
 */
export function bfPer9ThatZeroes(predPer9: number, obsPer9: number, bf9 = BF_PER_9): number {
  return predPer9 !== 0 ? (bf9 * obsPer9) / predPer9 : NaN;
}

/**
 * OBP rebuilt from cwhit's RATE columns alone — a genuine OVER-IDENTIFICATION check, because it uses
 * only (BB%, SO%, HR600, BABIP) and never touches his published OBP or the AB/PA path. If his rate
 * columns and his OBP column disagree, the rates we compute level biases from are internally
 * inconsistent and every level estimate is suspect.
 *   OBP = H/PA + BB/PA + HBP/PA,  H/PA = BABIP × BIP/PA + HR/PA,  BIP/PA = 1 − BB − HBP − K − HR.
 * Known second-order term: BIP/PA here still contains sac bunts/flies (a sac is a PA that is neither
 * BB/HBP/K/HR nor a ball in play in the BABIP denominator), so the recon runs slightly HIGH by ~BABIP ×
 * SAC/PA ≈ 0.004. A residual near that size is the identity working, not a defect.
 */
export function obpFromRates(bbPct: number, soPctPerPa: number, hr600: number, babip: number, hbp = HBP_PER_PA): number {
  const bb = bbPct / 100, k = soPctPerPa / 100, hr = hr600 / 600;
  const bip = Math.max(1 - bb - hbp - k - hr, 0);
  return babip * bip + hr + bb + hbp;
}

/** AVG rebuilt from the rate columns (uses the measured SAC_PER_PA for the AB/PA denominator). Weaker
 *  than the OBP check — SAC_PER_PA was itself calibrated off the AVG/OBP identity — so it is reported
 *  as corroboration, never as the primary ledger. */
export function avgFromRates(bbPct: number, soPctPerPa: number, hr600: number, babip: number, hbp = HBP_PER_PA, sac = SAC_PER_PA): number {
  const bb = bbPct / 100, k = soPctPerPa / 100, hr = hr600 / 600;
  const bip = Math.max(1 - bb - hbp - k - hr, 0);
  const ab = Math.max(1 - bb - hbp - sac, 1e-6);
  return (babip * bip + hr) / ab;
}
