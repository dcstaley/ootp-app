// M6 — D3 bake-off: candidate model FORMS behind the BakeoffModel seam.
//
// The wOBA assembly chain (BB,K,HR → BIP → H → XBH-share → 1B/XBH split → wOBA)
// is fixed and correct; only the per-event CURVE changes between candidates. So we
// factor the curve out of the chain: a "form" picks a basis per event, and the
// chain + BIP + wOBA weights are written ONCE here. With all-log-linear bases this
// engine reproduces trainWobaHitting/predictHitWoba bit-for-bit (asserted in
// forms.test.ts) — the free regression guard for the refactor.
//
// Candidate #2 (targeted raw-polynomial): keep BB~ln EYE, K~ln K; HR = quadratic in
// raw POW; XBH-share = quadratic in raw GAP (pitcher: HR = quadratic in raw HRR).
// Targets the residual finding — POW under-valued & ACCELERATING at the extremes
// (the log flattening), plus GAP curvature.
//
// Raw-polynomial terms are z-scored with the TRAINING mean/sd (stored in the fitted
// params, reused at predict) — pure conditioning for the Gauss-Jordan normal
// equations (raw POW² reaches the tens-of-thousands while the intercept is ~1); the
// fitted function value is unchanged.

import type { TrainObs } from "./loader.ts";
import { wls } from "./fit.ts";
import { HITTER, PITCHER, actualHitWoba, actualPitWoba, type BakeoffModel, type BakeoffEntry, type GateStatus } from "./bakeoff.ts";

const ln1 = (x: number) => Math.log(Math.max(x, 1));
const dot = (b: number[], x: number[]) => b.reduce((s, bi, j) => s + bi * x[j]!, 0);
// Fixed wOBA event weights (must match bakeoff.ts — the league-standard weights).
const W_BB = 0.704, W_1B = 0.8992, W_XBH = 1.29, W_HR = 2.0759, HBP = 6;

// ── Curve = the per-event basis choice ─────────────────────────────────────────
export type Curve =
  | { kind: "log" }                          // [1, ln(max(r,1))] — parity baseline, NOT z-scored
  | { kind: "rawpoly"; degree: 1 | 2 | 3 }   // [1, u, u², …] with u = z(r)        — raw curvature
  | { kind: "logpoly"; degree: 2 | 3 };      // [1, u, u², …] with u = z(ln r)      — higher-order log

interface FittedEvent { beta: number[]; mu: number; sd: number; curve: Curve }

// The pre-z-score base value for a polynomial curve: ln(rating) for logpoly, the
// raw rating for rawpoly. (log is handled separately — kept exactly [1, ln r] so it
// stays bit-identical to the parity assembly.)
const baseVal = (curve: Curve, v: number) => (curve.kind === "logpoly" ? ln1(v) : v);

/** Design row for one rating value under a curve (uses stored μ/σ for poly curves). */
function row(curve: Curve, v: number, mu: number, sd: number): number[] {
  if (curve.kind === "log") return [1, ln1(v)];
  const u = sd > 1e-9 ? (baseVal(curve, v) - mu) / sd : 0;
  const out = [1];
  for (let d = 1; d <= curve.degree; d++) out.push(u ** d);
  return out;
}
/** Fitted per-event rate at a rating value, clamped ≥ 0 (matches the chain). */
const rate = (e: FittedEvent, v: number) => Math.max(dot(e.beta, row(e.curve, v, e.mu, e.sd)), 0);

/** WLS-fit one event's curve on (rating → per-600 rate); weighted μ/σ z-scores the
 *  (raw or log) base term for conditioning — fitted function value is unchanged. */
function fitEvent(curve: Curve, vals: number[], y: number[], w: number[]): FittedEvent {
  let mu = 0, sd = 1;
  if (curve.kind !== "log") {
    const W = w.reduce((s, x) => s + x, 0);
    const b = vals.map((v) => baseVal(curve, v));
    mu = b.reduce((s, v, i) => s + w[i]! * v, 0) / W;
    sd = Math.sqrt(b.reduce((s, v, i) => s + w[i]! * (v - mu) ** 2, 0) / W) || 1;
  }
  const X = vals.map((v) => row(curve, v, mu, sd));
  return { beta: wls(X, y, w), mu, sd, curve };
}

// ── Hitting form ───────────────────────────────────────────────────────────────
// H stays log in [1, ln babip, ln bip] (residuals don't implicate it). The XBH
// curve fits the SHARE of (predicted) hits that go for extra bases.
export interface HitForm { name: string; bb: Curve; k: Curve; hr: Curve; xbh: Curve }
export interface FittedHit { bb: FittedEvent; k: FittedEvent; hr: FittedEvent; h: number[]; xbh: FittedEvent }

export function fitHitForm(form: HitForm, obs: TrainObs[], fitExp = 0.75): FittedHit {
  const w = obs.map((p) => Math.pow(p.hit.PA, fitExp));
  const per600 = (f: (o: TrainObs) => number) => obs.map((p) => (f(p) / Math.max(p.hit.PA, 1)) * 600);
  const BB = per600((p) => p.hit.BB), K = per600((p) => p.hit.K), HR = per600((p) => p.hit.HR);
  const H = per600((p) => p.hit.H), XBH = per600((p) => p.hit.b2 + p.hit.b3);
  const nonHRH = H.map((h, i) => h - HR[i]!);
  const eye = obs.map((p) => p.ratings.hit.eye), kr = obs.map((p) => p.ratings.hit.kRat);
  const pow = obs.map((p) => p.ratings.hit.pow), gap = obs.map((p) => p.ratings.hit.gap);
  const babip = obs.map((p) => p.ratings.hit.babip);

  const bb = fitEvent(form.bb, eye, BB, w);
  const k = fitEvent(form.k, kr, K, w);
  const hr = fitEvent(form.hr, pow, HR, w);
  // Predicted BB/K/HR drive BIP — training mirrors inference (S6.2).
  const bip = obs.map((_, i) => Math.max(600 - rate(bb, eye[i]!) - rate(k, kr[i]!) - rate(hr, pow[i]!) - 6 - 3 + 4, 1));
  const hX = obs.map((_, i) => [1, ln1(babip[i]!), ln1(bip[i]!)]);
  const h = wls(hX, nonHRH, w);
  const hP = obs.map((_, i) => Math.max(dot(h, hX[i]!), 0));
  const share = obs.map((_, i) => (hP[i]! > 1 ? XBH[i]! / hP[i]! : 0));
  const xbh = fitEvent(form.xbh, gap, share, w);
  return { bb, k, hr, h, xbh };
}

export function predictHitForm(m: FittedHit, o: TrainObs): number {
  const r = o.ratings.hit;
  const bb = rate(m.bb, r.eye), k = rate(m.k, r.kRat), hr = rate(m.hr, r.pow);
  const bip = Math.max(600 - bb - k - hr - 6 - 3 + 4, 1);
  const h = Math.max(dot(m.h, [1, ln1(r.babip), ln1(bip)]), 0);
  const xbh = Math.max(rate(m.xbh, r.gap) * h, 0); // xbh curve gives the share of h
  const oneB = Math.max(h - xbh, 0);
  return (W_BB * bb + W_BB * HBP + W_1B * oneB + W_XBH * xbh + W_HR * hr) / 600;
}

// ── Pitching form ──────────────────────────────────────────────────────────────
// H stays log; XBH stays the fixed 0.25 share (no GAP analog pitcher-side).
export interface PitForm { name: string; bb: Curve; k: Curve; hr: Curve }
export interface FittedPit { bb: FittedEvent; k: FittedEvent; hr: FittedEvent; h: number[] }

export function fitPitForm(form: PitForm, obs: TrainObs[], fitExp = 0.75): FittedPit {
  const w = obs.map((p) => Math.pow(p.pitch.BF, fitExp));
  const per600 = (f: (o: TrainObs) => number) => obs.map((p) => (f(p) / Math.max(p.pitch.BF, 1)) * 600);
  const BB = per600((p) => p.pitch.BB), K = per600((p) => p.pitch.K), HR = per600((p) => p.pitch.HR);
  const nHH = per600((p) => p.pitch.b1 + p.pitch.b2 + p.pitch.b3);
  const con = obs.map((p) => p.ratings.pitch.con), stu = obs.map((p) => p.ratings.pitch.stu);
  const hrr = obs.map((p) => p.ratings.pitch.hrr), pbabip = obs.map((p) => p.ratings.pitch.pbabip);

  const bb = fitEvent(form.bb, con, BB, w);
  const k = fitEvent(form.k, stu, K, w);
  const hr = fitEvent(form.hr, hrr, HR, w);
  const bip = obs.map((_, i) => Math.max(600 - rate(bb, con[i]!) - rate(k, stu[i]!) - rate(hr, hrr[i]!) - 6, 1));
  const hX = obs.map((_, i) => [1, ln1(pbabip[i]!), ln1(bip[i]!)]);
  const h = wls(hX, nHH, w);
  return { bb, k, hr, h };
}

export function predictPitForm(m: FittedPit, o: TrainObs): number {
  const r = o.ratings.pitch;
  const bb = rate(m.bb, r.con), k = rate(m.k, r.stu), hr = rate(m.hr, r.hrr);
  const bip = Math.max(600 - bb - k - hr - 6, 1);
  const nHH = Math.max(dot(m.h, [1, ln1(r.pbabip), ln1(bip)]), 0);
  const xbh = nHH * 0.25, oneB = Math.max(nHH - xbh, 0);
  return (W_BB * bb + W_1B * oneB + W_XBH * xbh + W_HR * hr) / 600; // no HBP term (matches old)
}

// ── Monotonicity + sane-extrapolation gate ─────────────────────────────────────
// Raw polynomials can turn over (a parabola peaks); past the vertex the model would
// predict FEWER good events for a BETTER rating — nonsense, and most dangerous at
// the top of the range where elite cards live and new cards push the envelope. The
// gate samples each event's rate across the observed domain PLUS a 10% extrapolation
// margin and flags any direction REVERSAL. (Log curves are always monotone; a
// wrong-DIRECTION-but-monotone fit isn't flagged here — it surfaces as poor Pearson.)
// Sample a rate function across [lo, hi] + a 10% extrapolation margin; true unless
// the direction reverses (a turning point) somewhere in that range.
function monotoneSampled(fn: (r: number) => number, lo: number, hi: number): boolean {
  const ext = hi + 0.1 * (hi - lo), N = 200;
  let dir = 0, prev = fn(lo);
  for (let i = 1; i <= N; i++) {
    const cur = fn(lo + ((ext - lo) * i) / N), d = cur - prev;
    if (Math.abs(d) > 1e-9) { const s = d > 0 ? 1 : -1; if (dir === 0) dir = s; else if (s !== dir) return false; }
    prev = cur;
  }
  return true;
}
function eventMonotone(e: FittedEvent, rmin: number, rmax: number): boolean {
  return e.curve.kind === "log" ? true : monotoneSampled((v) => rate(e, v), rmin, rmax);
}
const span = (vals: number[]): [number, number] => [Math.min(...vals), Math.max(...vals)];

export function gateHit(m: FittedHit, obs: TrainObs[]): GateStatus {
  const notes: string[] = [];
  const chk = (name: string, e: FittedEvent, vals: number[]) => { const [lo, hi] = span(vals); if (!eventMonotone(e, lo, hi)) notes.push(`${name} curve non-monotone in-domain`); };
  chk("HR", m.hr, obs.map((o) => o.ratings.hit.pow));
  chk("XBH", m.xbh, obs.map((o) => o.ratings.hit.gap));
  chk("BB", m.bb, obs.map((o) => o.ratings.hit.eye));
  chk("K", m.k, obs.map((o) => o.ratings.hit.kRat));
  return { status: notes.length ? "warn" : "pass", notes };
}
export function gatePit(m: FittedPit, obs: TrainObs[]): GateStatus {
  const notes: string[] = [];
  const chk = (name: string, e: FittedEvent, vals: number[]) => { const [lo, hi] = span(vals); if (!eventMonotone(e, lo, hi)) notes.push(`${name} curve non-monotone in-domain`); };
  chk("HR", m.hr, obs.map((o) => o.ratings.pitch.hrr));
  chk("BB", m.bb, obs.map((o) => o.ratings.pitch.con));
  chk("K", m.k, obs.map((o) => o.ratings.pitch.stu));
  return { status: notes.length ? "warn" : "pass", notes };
}

// ── Count GLMs (candidate #8): Poisson / negative-binomial with a PA/BF offset ──
// The parity fit regresses per-600 RATES by WLS (Gaussian) with an ad-hoc PA^0.75
// weight. The statistically-correct model treats each event as a non-negative COUNT
// with exposure: y ~ Poisson(μ), log μ = log(exposure) + β·[1, ln rating]. The log
// link makes every event a power law (rate ∝ rating^β) — monotone by construction,
// no clamp — and the exposure offset replaces the ad-hoc weight. Negative-binomial
// adds a dispersion θ (var = μ + μ²/θ) for the overdispersion real count data shows;
// it only reweights the IRLS, so Poisson is the θ→∞ limit. Predicted per-600 rate
// = 600·e^{β·x} (exposure-free). Assembled by the SAME chain as every other form.

const POISSON = Infinity;
/** One IRLS fit of a log-link count GLM with exposure offset. theta=∞ ⇒ Poisson. */
function glmFit(X: number[][], count: number[], expo: number[], theta: number, iters = 60): number[] {
  const p = X[0]!.length;
  const off = expo.map((e) => Math.log(Math.max(e, 1e-9)));
  const total = count.reduce((s, y) => s + y, 0), totE = expo.reduce((s, e) => s + e, 0);
  const beta = new Array(p).fill(0);
  beta[0] = Math.log(Math.max(total, 0.5) / Math.max(totE, 1)); // start at the pooled mean rate
  for (let it = 0; it < iters; it++) {
    const lin = X.map((x) => dot(beta, x));
    const mu = lin.map((l, i) => Math.exp(Math.min(off[i]! + l, 30)));
    const W = mu.map((m) => (theta === POISSON ? m : m / (1 + m / theta)));
    const z = X.map((x, i) => dot(beta, x) + (count[i]! - mu[i]!) / Math.max(mu[i]!, 1e-9));
    const next = wls(X, z, W);
    const delta = next.reduce((s, b, j) => s + Math.abs(b - beta[j]!), 0);
    for (let j = 0; j < p; j++) beta[j] = next[j]!;
    if (delta < 1e-11) break;
  }
  return beta;
}

/** Method-of-moments θ: match the NB Pearson dispersion to its dof (bisection). */
function estimateTheta(count: number[], mu: number[], p: number): number {
  const dof = Math.max(count.length - p, 1);
  const pearson = (th: number) => count.reduce((s, y, i) => { const m = mu[i]!, v = m + (m * m) / th; return s + ((y - m) ** 2) / v; }, 0);
  if (pearson(1e6) <= dof) return POISSON;     // not overdispersed ⇒ Poisson
  let lo = 0.05, hi = 1e6;
  if (pearson(lo) >= dof) return lo;
  for (let it = 0; it < 60; it++) { const mid = Math.sqrt(lo * hi); if (pearson(mid) > dof) hi = mid; else lo = mid; }
  return Math.sqrt(lo * hi);
}
/** Fit one count event: Poisson, or (nb) Poisson → estimate θ → one NB refit. */
function fitCount(X: number[][], count: number[], expo: number[], nb: boolean): number[] {
  const beta = glmFit(X, count, expo, POISSON);
  if (!nb) return beta;
  const off = expo.map((e) => Math.log(Math.max(e, 1e-9)));
  const mu = X.map((x, i) => Math.exp(Math.min(off[i]! + dot(beta, x), 30)));
  const theta = estimateTheta(count, mu, X[0]!.length);
  return theta === POISSON ? beta : glmFit(X, count, expo, theta);
}
/** Predicted per-600 rate from a log-link fit: 600·e^{β0 + Σ βⱼ·predⱼ} (no clamp). */
const expRate = (beta: number[], preds: number[]) => 600 * Math.exp(Math.min(beta[0]! + preds.reduce((s, v, j) => s + beta[j + 1]! * v, 0), 30));

export interface GLMHitParams { bb: number[]; k: number[]; hr: number[]; h: number[]; xbh: number[] }
export function fitHitGLM(obs: TrainObs[], nb: boolean): GLMHitParams {
  const PA = obs.map((p) => Math.max(p.hit.PA, 1));
  const lne = obs.map((p) => ln1(p.ratings.hit.eye)), lnk = obs.map((p) => ln1(p.ratings.hit.kRat));
  const lnp = obs.map((p) => ln1(p.ratings.hit.pow)), lng = obs.map((p) => ln1(p.ratings.hit.gap));
  const lnb = obs.map((p) => ln1(p.ratings.hit.babip));
  const bb = fitCount(obs.map((_, i) => [1, lne[i]!]), obs.map((p) => p.hit.BB), PA, nb);
  const k = fitCount(obs.map((_, i) => [1, lnk[i]!]), obs.map((p) => p.hit.K), PA, nb);
  const hr = fitCount(obs.map((_, i) => [1, lnp[i]!]), obs.map((p) => p.hit.HR), PA, nb);
  // training-consistent BIP from the predicted per-600 counts
  const bip = obs.map((_, i) => Math.max(600 - expRate(bb, [lne[i]!]) - expRate(k, [lnk[i]!]) - expRate(hr, [lnp[i]!]) - 6 - 3 + 4, 1));
  const h = fitCount(obs.map((_, i) => [1, lnb[i]!, Math.log(bip[i]!)]), obs.map((p) => Math.max(p.hit.H - p.hit.HR, 0)), PA, nb);
  const xbh = fitCount(obs.map((_, i) => [1, lng[i]!]), obs.map((p) => p.hit.b2 + p.hit.b3), PA, nb);
  return { bb, k, hr, h, xbh };
}
export function predictHitGLM(m: GLMHitParams, o: TrainObs): number {
  const r = o.ratings.hit;
  const bb = expRate(m.bb, [ln1(r.eye)]), k = expRate(m.k, [ln1(r.kRat)]), hr = expRate(m.hr, [ln1(r.pow)]);
  const bip = Math.max(600 - bb - k - hr - 6 - 3 + 4, 1);
  const h = expRate(m.h, [ln1(r.babip), Math.log(bip)]);
  const xbh = expRate(m.xbh, [ln1(r.gap)]);
  const oneB = Math.max(h - xbh, 0);
  return (W_BB * bb + W_BB * HBP + W_1B * oneB + W_XBH * xbh + W_HR * hr) / 600;
}

export interface GLMPitParams { bb: number[]; k: number[]; hr: number[]; h: number[] }
export function fitPitGLM(obs: TrainObs[], nb: boolean): GLMPitParams {
  const BF = obs.map((p) => Math.max(p.pitch.BF, 1));
  const lnc = obs.map((p) => ln1(p.ratings.pitch.con)), lns = obs.map((p) => ln1(p.ratings.pitch.stu));
  const lnh = obs.map((p) => ln1(p.ratings.pitch.hrr)), lnpb = obs.map((p) => ln1(p.ratings.pitch.pbabip));
  const bb = fitCount(obs.map((_, i) => [1, lnc[i]!]), obs.map((p) => p.pitch.BB), BF, nb);
  const k = fitCount(obs.map((_, i) => [1, lns[i]!]), obs.map((p) => p.pitch.K), BF, nb);
  const hr = fitCount(obs.map((_, i) => [1, lnh[i]!]), obs.map((p) => p.pitch.HR), BF, nb);
  const bip = obs.map((_, i) => Math.max(600 - expRate(bb, [lnc[i]!]) - expRate(k, [lns[i]!]) - expRate(hr, [lnh[i]!]) - 6, 1));
  const h = fitCount(obs.map((_, i) => [1, lnpb[i]!, Math.log(bip[i]!)]), obs.map((p) => p.pitch.b1 + p.pitch.b2 + p.pitch.b3), BF, nb);
  return { bb, k, hr, h };
}
export function predictPitGLM(m: GLMPitParams, o: TrainObs): number {
  const r = o.ratings.pitch;
  const bb = expRate(m.bb, [ln1(r.con)]), k = expRate(m.k, [ln1(r.stu)]), hr = expRate(m.hr, [ln1(r.hrr)]);
  const bip = Math.max(600 - bb - k - hr - 6, 1);
  const nHH = expRate(m.h, [ln1(r.pbabip), Math.log(bip)]);
  const xbh = nHH * 0.25, oneB = Math.max(nHH - xbh, 0);
  return (W_BB * bb + W_1B * oneB + W_XBH * xbh + W_HR * hr) / 600; // no HBP term (matches old)
}

// GLM gate: each single-rating event is a power law (rate ∝ rating^β), monotone by
// construction — we still sample to confirm (and to catch the multiplicative chain).
export function gateGLMHit(m: GLMHitParams, obs: TrainObs[]): GateStatus {
  const notes: string[] = [];
  const chk = (name: string, beta: number[], vals: number[]) => { const [lo, hi] = span(vals); if (!monotoneSampled((v) => expRate(beta, [ln1(v)]), lo, hi)) notes.push(`${name} curve non-monotone in-domain`); };
  chk("HR", m.hr, obs.map((o) => o.ratings.hit.pow));
  chk("XBH", m.xbh, obs.map((o) => o.ratings.hit.gap));
  chk("BB", m.bb, obs.map((o) => o.ratings.hit.eye));
  chk("K", m.k, obs.map((o) => o.ratings.hit.kRat));
  return { status: notes.length ? "warn" : "pass", notes };
}
export function gateGLMPit(m: GLMPitParams, obs: TrainObs[]): GateStatus {
  const notes: string[] = [];
  const chk = (name: string, beta: number[], vals: number[]) => { const [lo, hi] = span(vals); if (!monotoneSampled((v) => expRate(beta, [ln1(v)]), lo, hi)) notes.push(`${name} curve non-monotone in-domain`); };
  chk("HR", m.hr, obs.map((o) => o.ratings.pitch.hrr));
  chk("BB", m.bb, obs.map((o) => o.ratings.pitch.con));
  chk("K", m.k, obs.map((o) => o.ratings.pitch.stu));
  return { status: notes.length ? "warn" : "pass", notes };
}
const glmHitModel = (name: string, nb: boolean): BakeoffModel => ({ name, role: "hitter", fit: (t) => fitHitGLM(t, nb), predict: (p, test) => test.map((o) => predictHitGLM(p as GLMHitParams, o)) });
const glmPitModel = (name: string, nb: boolean): BakeoffModel => ({ name, role: "pitcher", fit: (t) => fitPitGLM(t, nb), predict: (p, test) => test.map((o) => predictPitGLM(p as GLMPitParams, o)) });

// ── Sequential conditional (candidate #6): a conditional tree over a PA ──────────
// Each plate appearance walks an outcome tree — BB, then (given no BB) K, then
// (given contact) HR, then (given a ball in play) a non-HR hit, then (given a hit)
// XBH — so probabilities are CONDITIONAL, multiply down the chain, and a stage's
// count can never exceed its denominator (the "BIP is derived" bookkeeping is free).
// This re-architects the prior art (recalibrate_pt_model.py) which had the right
// tree but three flaws: cubic-on-RAW-ratings (overfits / non-monotone — the bake-off
// confirmed), linearized-logit LEAST-SQUARES instead of a real binomial GLM, and
// denominators built from PREDICTED stage probabilities (propagates model error).
// Here each stage is a proper binomial logistic GLM fit by IRLS, with denominators
// from ACTUAL counts, and a log-linear logit (monotone) — isolating the STRUCTURAL
// question (conditional tree vs additive chain) from the curve question.

const logistic = (e: number) => 1 / (1 + Math.exp(-Math.max(Math.min(e, 30), -30)));
const probAt = (beta: number[], r: number) => logistic(beta[0]! + beta[1]! * ln1(r));

/** Binomial logistic GLM (logit link) by IRLS: fit logit p = β·[1, ln rating] to
 *  successes y out of trials n. Proper likelihood weighting (W = n·p·(1−p)). */
function logitFit(rating: number[], y: number[], n: number[], iters = 60): number[] {
  const X = rating.map((r) => [1, ln1(r)]);
  const sy = y.reduce((s, v) => s + v, 0), sn = n.reduce((s, v) => s + v, 0);
  const pbar = Math.min(Math.max(sy / Math.max(sn, 1), 1e-4), 1 - 1e-4);
  const beta = [Math.log(pbar / (1 - pbar)), 0];
  for (let it = 0; it < iters; it++) {
    const p = X.map((x) => logistic(dot(beta, x)));
    const W = p.map((pi, i) => Math.max(n[i]! * pi * (1 - pi), 1e-9));
    const z = X.map((x, i) => dot(beta, x) + (y[i]! - n[i]! * p[i]!) / W[i]!);
    const next = wls(X, z, W);
    const delta = Math.abs(next[0]! - beta[0]!) + Math.abs(next[1]! - beta[1]!);
    beta[0] = next[0]!; beta[1] = next[1]!;
    if (delta < 1e-11) break;
  }
  return beta;
}

export interface SeqHitParams { bb: number[]; k: number[]; hr: number[]; h: number[]; xbh: number[] }
export function fitHitSeq(obs: TrainObs[]): SeqHitParams {
  // Per-stage (successes y, trials n) from ACTUAL counts; clamp n ≥ y for the binomial.
  const PA = obs.map((o) => o.hit.PA), BB = obs.map((o) => o.hit.BB), HP = obs.map((o) => o.hit.HP);
  const K = obs.map((o) => o.hit.K), HR = obs.map((o) => o.hit.HR);
  const Hn = obs.map((o) => Math.max(o.hit.H - o.hit.HR, 0)), XBH = obs.map((o) => o.hit.b2 + o.hit.b3);
  const nK = obs.map((_, i) => Math.max(PA[i]! - BB[i]! - HP[i]!, K[i]!));
  const nHR = obs.map((_, i) => Math.max(nK[i]! - K[i]!, HR[i]!));
  const nH = obs.map((_, i) => Math.max(nHR[i]! - HR[i]!, Hn[i]!));
  return {
    bb: logitFit(obs.map((o) => o.ratings.hit.eye), BB, PA),
    k: logitFit(obs.map((o) => o.ratings.hit.kRat), K, nK),
    hr: logitFit(obs.map((o) => o.ratings.hit.pow), HR, nHR),
    h: logitFit(obs.map((o) => o.ratings.hit.babip), Hn, nH),
    xbh: logitFit(obs.map((o) => o.ratings.hit.gap), XBH, Hn.map((v, i) => Math.max(v, XBH[i]!))),
  };
}
export function predictHitSeq(m: SeqHitParams, o: TrainObs): number {
  const r = o.ratings.hit, HBP = 6;
  const bb = 600 * probAt(m.bb, r.eye);
  const n2 = Math.max(600 - bb - HBP, 0), k = n2 * probAt(m.k, r.kRat);
  const n3 = Math.max(n2 - k, 0), hr = n3 * probAt(m.hr, r.pow);
  const n4 = Math.max(n3 - hr, 0), hn = n4 * probAt(m.h, r.babip);
  const xbh = hn * probAt(m.xbh, r.gap), oneB = Math.max(hn - xbh, 0);
  return (W_BB * bb + W_BB * HBP + W_1B * oneB + W_XBH * xbh + W_HR * hr) / 600;
}

export interface SeqPitParams { bb: number[]; k: number[]; hr: number[]; h: number[] }
export function fitPitSeq(obs: TrainObs[]): SeqPitParams {
  const BF = obs.map((o) => o.pitch.BF), BB = obs.map((o) => o.pitch.BB), HP = obs.map((o) => o.pitch.HP);
  const K = obs.map((o) => o.pitch.K), HR = obs.map((o) => o.pitch.HR);
  const Hn = obs.map((o) => o.pitch.b1 + o.pitch.b2 + o.pitch.b3);
  const nK = obs.map((_, i) => Math.max(BF[i]! - BB[i]! - HP[i]!, K[i]!));
  const nHR = obs.map((_, i) => Math.max(nK[i]! - K[i]!, HR[i]!));
  const nH = obs.map((_, i) => Math.max(nHR[i]! - HR[i]!, Hn[i]!));
  return {
    bb: logitFit(obs.map((o) => o.ratings.pitch.con), BB, BF),
    k: logitFit(obs.map((o) => o.ratings.pitch.stu), K, nK),
    hr: logitFit(obs.map((o) => o.ratings.pitch.hrr), HR, nHR),
    h: logitFit(obs.map((o) => o.ratings.pitch.pbabip), Hn, nH),
  };
}
export function predictPitSeq(m: SeqPitParams, o: TrainObs): number {
  const r = o.ratings.pitch, HBP = 6;
  const bb = 600 * probAt(m.bb, r.con);
  const n2 = Math.max(600 - bb - HBP, 0), k = n2 * probAt(m.k, r.stu);
  const n3 = Math.max(n2 - k, 0), hr = n3 * probAt(m.hr, r.hrr);
  const n4 = Math.max(n3 - hr, 0), hn = n4 * probAt(m.h, r.pbabip);
  const xbh = hn * 0.25, oneB = Math.max(hn - xbh, 0); // fixed XBH share (no GAP analog)
  return (W_BB * bb + W_1B * oneB + W_XBH * xbh + W_HR * hr) / 600; // no HBP term (matches old)
}

export function gateSeqHit(m: SeqHitParams, obs: TrainObs[]): GateStatus {
  const notes: string[] = [];
  const chk = (name: string, beta: number[], vals: number[]) => { const [lo, hi] = span(vals); if (!monotoneSampled((v) => probAt(beta, v), lo, hi)) notes.push(`${name} stage non-monotone in-domain`); };
  chk("HR", m.hr, obs.map((o) => o.ratings.hit.pow));
  chk("XBH", m.xbh, obs.map((o) => o.ratings.hit.gap));
  chk("BB", m.bb, obs.map((o) => o.ratings.hit.eye));
  chk("K", m.k, obs.map((o) => o.ratings.hit.kRat));
  return { status: notes.length ? "warn" : "pass", notes };
}
export function gateSeqPit(m: SeqPitParams, obs: TrainObs[]): GateStatus {
  const notes: string[] = [];
  const chk = (name: string, beta: number[], vals: number[]) => { const [lo, hi] = span(vals); if (!monotoneSampled((v) => probAt(beta, v), lo, hi)) notes.push(`${name} stage non-monotone in-domain`); };
  chk("HR", m.hr, obs.map((o) => o.ratings.pitch.hrr));
  chk("BB", m.bb, obs.map((o) => o.ratings.pitch.con));
  chk("K", m.k, obs.map((o) => o.ratings.pitch.stu));
  return { status: notes.length ? "warn" : "pass", notes };
}
const seqHitModel: BakeoffModel = { name: "woba·seqcond", role: "hitter", fit: fitHitSeq, predict: (p, test) => test.map((o) => predictHitSeq(p as SeqHitParams, o)) };
const seqPitModel: BakeoffModel = { name: "woba·seqcond", role: "pitcher", fit: fitPitSeq, predict: (p, test) => test.map((o) => predictPitSeq(p as SeqPitParams, o)) };

// ── Ceiling benchmark (candidate #5): direct flexible wOBA ──────────────────────
// Bypass the event chain — regress ACTUAL wOBA directly on a flexible polynomial in
// the z-scored ratings (intercept + linear + quadratic + all pairwise interactions).
// Its CV Pearson is the practical CEILING for a smooth model: how much signal the
// ratings even carry. NOT deployable — unconstrained (non-monotone) and over-
// parameterized (21 hit / 15 pit terms), so it overfits at small N (the in-sample↔CV
// gap shows it). It only tells us whether the structured forms (#2) are near-optimal.
interface FlexParams { beta: number[]; mu: number[]; sd: number[]; keys: string[] }
function flexRow(z: number[]): number[] {
  const r = [1, ...z];
  for (const v of z) r.push(v * v);                                                   // quadratic
  for (let i = 0; i < z.length; i++) for (let j = i + 1; j < z.length; j++) r.push(z[i]! * z[j]!); // interactions
  return r;
}
function fitFlex(obs: TrainObs[], keys: string[], get: (o: TrainObs, k: string) => number, wt: (o: TrainObs) => number, actual: (o: TrainObs) => number): FlexParams {
  const w = obs.map(wt), W = w.reduce((s, x) => s + x, 0);
  const mu = keys.map((k) => obs.reduce((s, o, i) => s + w[i]! * get(o, k), 0) / W);
  const sd = keys.map((k, j) => Math.sqrt(obs.reduce((s, o, i) => s + w[i]! * (get(o, k) - mu[j]!) ** 2, 0) / W) || 1);
  const X = obs.map((o) => flexRow(keys.map((k, j) => (get(o, k) - mu[j]!) / sd[j]!)));
  return { beta: wls(X, obs.map(actual), w), mu, sd, keys };
}
const predictFlex = (p: FlexParams, o: TrainObs, get: (o: TrainObs, k: string) => number) => dot(p.beta, flexRow(p.keys.map((k, j) => (get(o, k) - p.mu[j]!) / p.sd[j]!)));
const HIT_KEYS = ["eye", "kRat", "pow", "babip", "gap"], PIT_KEYS = ["con", "stu", "hrr", "pbabip"];
const getHitK = (o: TrainObs, k: string) => (o.ratings.hit as unknown as Record<string, number>)[k]!;
const getPitK = (o: TrainObs, k: string) => (o.ratings.pitch as unknown as Record<string, number>)[k]!;
const flexHitModel: BakeoffModel = { name: "ceiling·flex", role: "hitter", fit: (t) => fitFlex(t, HIT_KEYS, getHitK, (o) => Math.pow(o.hit.PA, 0.75), actualHitWoba), predict: (p, test) => test.map((o) => predictFlex(p as FlexParams, o, getHitK)) };
const flexPitModel: BakeoffModel = { name: "ceiling·flex", role: "pitcher", fit: (t) => fitFlex(t, PIT_KEYS, getPitK, (o) => Math.pow(o.pitch.BF, 0.75), actualPitWoba), predict: (p, test) => test.map((o) => predictFlex(p as FlexParams, o, getPitK)) };

// ── Seam wrappers + form definitions ───────────────────────────────────────────
export function hitFormModel(form: HitForm): BakeoffModel {
  return { name: form.name, role: "hitter", fit: (train) => fitHitForm(form, train), predict: (p, test) => test.map((o) => predictHitForm(p as FittedHit, o)) };
}
export function pitFormModel(form: PitForm): BakeoffModel {
  return { name: form.name, role: "pitcher", fit: (train) => fitPitForm(form, train), predict: (p, test) => test.map((o) => predictPitForm(p as FittedPit, o)) };
}

// All-log forms — identical to the parity woba models; used only by the regression test.
export const LOG_HIT: HitForm = { name: "woba", bb: { kind: "log" }, k: { kind: "log" }, hr: { kind: "log" }, xbh: { kind: "log" } };
export const LOG_PIT: PitForm = { name: "woba", bb: { kind: "log" }, k: { kind: "log" }, hr: { kind: "log" } };

// Candidate #2 — targeted raw-polynomial (only the events the residuals implicate).
export const RAWPOLY_HIT: HitForm = { name: "woba·rawpoly", bb: { kind: "log" }, k: { kind: "log" }, hr: { kind: "rawpoly", degree: 2 }, xbh: { kind: "rawpoly", degree: 2 } };
export const RAWPOLY_PIT: PitForm = { name: "woba·rawpoly", bb: { kind: "log" }, k: { kind: "log" }, hr: { kind: "rawpoly", degree: 2 } };

// Uniform-curve forms apply one curve to every rating-driven event (BB,K,HR + XBH
// for hitters), holding the chain fixed — the "is log the right curve" comparison.
// H stays log: its second input (BIP) is itself derived from the other predicted
// events, so polynomializing it is unstable, and the residuals don't implicate babip.
const uHit = (name: string, c: Curve): HitForm => ({ name, bb: c, k: c, hr: c, xbh: c });
const uPit = (name: string, c: Curve): PitForm => ({ name, bb: c, k: c, hr: c });
// Candidate #1 — cubic-in-log on every event (the artifact's unused eye2/pow2/… slots).
export const LOGCUBIC_HIT = uHit("woba·logcubic", { kind: "logpoly", degree: 3 });
export const LOGCUBIC_PIT = uPit("woba·logcubic", { kind: "logpoly", degree: 3 });
// The raw curve family vs the log baseline (raw-linear = no log, no curvature; quad/cubic add it).
export const RAWLIN_HIT = uHit("woba·rawlin", { kind: "rawpoly", degree: 1 });
export const RAWLIN_PIT = uPit("woba·rawlin", { kind: "rawpoly", degree: 1 });
export const RAWQUAD_HIT = uHit("woba·rawquad", { kind: "rawpoly", degree: 2 });
export const RAWQUAD_PIT = uPit("woba·rawquad", { kind: "rawpoly", degree: 2 });
export const RAWCUBIC_HIT = uHit("woba·rawcubic", { kind: "rawpoly", degree: 3 });
export const RAWCUBIC_PIT = uPit("woba·rawcubic", { kind: "rawpoly", degree: 3 });

const hitEntry = (f: HitForm): BakeoffEntry => ({ model: hitFormModel(f), spec: HITTER, gate: (p, obs) => gateHit(p as FittedHit, obs) });
const pitEntry = (f: PitForm): BakeoffEntry => ({ model: pitFormModel(f), spec: PITCHER, gate: (p, obs) => gatePit(p as FittedPit, obs) });

/** Scoreboard entries contributed by candidate forms (appended to the baselines). */
export const FORM_ENTRIES: BakeoffEntry[] = [
  hitEntry(RAWPOLY_HIT), pitEntry(RAWPOLY_PIT),     // #2 targeted raw-poly
  hitEntry(LOGCUBIC_HIT), pitEntry(LOGCUBIC_PIT),   // #1 cubic-in-log
  hitEntry(RAWLIN_HIT), pitEntry(RAWLIN_PIT),       // curve family — is log the right curve?
  hitEntry(RAWQUAD_HIT), pitEntry(RAWQUAD_PIT),
  hitEntry(RAWCUBIC_HIT), pitEntry(RAWCUBIC_PIT),
  // #8 count GLMs — Poisson + negative-binomial, exposure offset, log link.
  { model: glmHitModel("woba·poisson", false), spec: HITTER, gate: (p, obs) => gateGLMHit(p as GLMHitParams, obs) },
  { model: glmPitModel("woba·poisson", false), spec: PITCHER, gate: (p, obs) => gateGLMPit(p as GLMPitParams, obs) },
  { model: glmHitModel("woba·nb", true), spec: HITTER, gate: (p, obs) => gateGLMHit(p as GLMHitParams, obs) },
  { model: glmPitModel("woba·nb", true), spec: PITCHER, gate: (p, obs) => gateGLMPit(p as GLMPitParams, obs) },
  // #6 sequential conditional — a binomial logistic tree over the PA outcomes.
  { model: seqHitModel, spec: HITTER, gate: (p, obs) => gateSeqHit(p as SeqHitParams, obs) },
  { model: seqPitModel, spec: PITCHER, gate: (p, obs) => gateSeqPit(p as SeqPitParams, obs) },
  // #5 ceiling benchmark — direct flexible wOBA. No gate: it's a reference, not a
  // deployable candidate (intentionally unconstrained / non-monotone).
  { model: flexHitModel, spec: HITTER },
  { model: flexPitModel, spec: PITCHER },
];
