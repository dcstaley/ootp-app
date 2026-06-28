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
import { HITTER, PITCHER, type BakeoffModel, type BakeoffEntry, type GateStatus } from "./bakeoff.ts";

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

export function fitHitForm(form: HitForm, obs: TrainObs[]): FittedHit {
  const w = obs.map((p) => Math.pow(p.hit.PA, 0.75));
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

export function fitPitForm(form: PitForm, obs: TrainObs[]): FittedPit {
  const w = obs.map((p) => Math.pow(p.pitch.BF, 0.75));
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
function eventMonotone(e: FittedEvent, rmin: number, rmax: number): boolean {
  if (e.curve.kind === "log") return true;
  const ext = rmax + 0.1 * (rmax - rmin), N = 200;
  let dir = 0, prev = rate(e, rmin);
  for (let i = 1; i <= N; i++) {
    const cur = rate(e, rmin + ((ext - rmin) * i) / N), d = cur - prev;
    if (Math.abs(d) > 1e-9) { const s = d > 0 ? 1 : -1; if (dir === 0) dir = s; else if (s !== dir) return false; }
    prev = cur;
  }
  return true;
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
];
