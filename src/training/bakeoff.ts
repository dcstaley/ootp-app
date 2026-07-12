// M6 — bake-off model abstraction + wOBA assembly. A BakeoffModel is anything that
// can FIT on a training subset and PREDICT assembled wOBA on a held-out subset, so
// candidate forms (cubic, spline, interactions, …) drop in behind one interface and
// land on the same scoreboard. The first implementation wraps the parity log-linear
// fit. Predicted wOBA is the RAW assembly (fixed weights, training-consistent BIP
// chain) — upstream of softcaps / leagueNorm / anchor (all under review; a per-event
// scale or anchor would only distort the gap-fidelity we measure).

import type { TrainObs } from "./loader.ts";
import { trainWobaHitting, trainWobaPitching, trainBasicHitting, trainBasicPitching, type WobaHittingCoeffs, type WobaPitchingCoeffs, type BasicHittingCoeffs, type BasicPitchingCoeffs } from "./fit.ts";
import { DEFAULT_WOBA_WEIGHTS } from "../scoring-core/woba-weights.ts";

const ln1 = (x: number) => Math.log(Math.max(x, 1));
// wOBA event weights — the ONE source (scoring-core). The bake-off/residual target uses
// the defaults (the per-model wRAA-derived weights are applied at SCORING time); since the
// scoreboard metric is Pearson (shift-invariant), this choice doesn't affect selection.
const W_BB = DEFAULT_WOBA_WEIGHTS.bb, W_HBP = DEFAULT_WOBA_WEIGHTS.hbp, W_1B = DEFAULT_WOBA_WEIGHTS.b1, W_XBH = DEFAULT_WOBA_WEIGHTS.xbh, W_HR = DEFAULT_WOBA_WEIGHTS.hr, HBP = 6;

// ── Assembled wOBA from predicted / actual per-600 events ──────────────────────
export function predictHitWoba(c: WobaHittingCoeffs, o: TrainObs): number {
  const r = o.ratings.hit;
  const bb = Math.max(c.bb.intercept + c.bb.eye * ln1(r.eye), 0);
  const k = Math.max(c.k.intercept + c.k.k * ln1(r.kRat), 0);
  const hr = Math.max(c.hr.intercept + c.hr.pow * ln1(r.pow), 0);
  const bip = Math.max(600 - bb - k - hr - 6 - 3 + 4, 1); // training-consistent chain
  const h = Math.max(c.h.intercept + c.h.ba * ln1(r.babip) + c.h.bipba * ln1(bip), 0);
  const xbh = Math.max((c.xbh.logA + c.xbh.logB * ln1(r.gap)) * h, 0);
  const oneB = Math.max(h - xbh, 0);
  return (W_BB * bb + W_BB * HBP + W_1B * oneB + W_XBH * xbh + W_HR * hr) / 600;
}
export function actualHitWoba(o: TrainObs): number {
  const pa = Math.max(o.hit.PA, 1), s = 600 / pa;
  const hr = o.hit.HR * s, xbh = (o.hit.b2 + o.hit.b3) * s, oneB = (o.hit.H - o.hit.HR - o.hit.b2 - o.hit.b3) * s;
  const uBB = Math.max(o.hit.BB - o.hit.IBB, 0); // wOBA convention excludes IBB (models fit + predict uBB)
  return (W_BB * uBB * s + W_BB * HBP + W_1B * Math.max(oneB, 0) + W_XBH * xbh + W_HR * hr) / 600;
}

export function predictPitWoba(c: WobaPitchingCoeffs, o: TrainObs): number {
  const r = o.ratings.pitch;
  const bb = Math.max(c.bb.intercept + c.bb.con * ln1(r.con), 0);
  const k = Math.max(c.k.intercept + c.k.stu * ln1(r.stu), 0);
  const hr = Math.max(c.hr.intercept + c.hr.hrr * ln1(r.hrr), 0);
  const bip = Math.max(600 - bb - k - hr - 6, 1);
  const nHH = Math.max(c.h.intercept + c.h.pbabip * ln1(r.pbabip) + c.h.bip * ln1(bip), 0);
  const xbh = nHH * c.xbh.share, oneB = Math.max(nHH - xbh, 0);
  return (W_BB * bb + W_HBP * HBP + W_1B * oneB + W_XBH * xbh + W_HR * hr) / 600; // HBP now included (matches scoring)
}
export function actualPitWoba(o: TrainObs): number {
  const bf = Math.max(o.pitch.BF, 1), s = 600 / bf;
  const uBB = Math.max(o.pitch.BB - o.pitch.IBB, 0); // wOBA convention excludes IBB (models fit + predict uBB)
  return (W_BB * uBB * s + W_HBP * o.pitch.HP * s + W_1B * o.pitch.b1 * s + W_XBH * (o.pitch.b2 + o.pitch.b3) * s + W_HR * o.pitch.HR * s) / 600;
}

// ── Model abstraction ──────────────────────────────────────────────────────────
export interface BakeoffModel {
  name: string;
  role: "hitter" | "pitcher";
  fit(train: TrainObs[]): unknown;                 // opaque params
  predict(params: unknown, test: TrainObs[]): number[]; // predicted wOBA per test obs
}

// Role config: who qualifies, the volume weight, the actual wOBA, ranking direction.
export interface RoleSpec {
  role: "hitter" | "pitcher";
  qualifies(o: TrainObs, minN: number): boolean;
  weight(o: TrainObs): number;
  actualWoba(o: TrainObs): number;
  higherBetter: boolean;
}
export const HITTER: RoleSpec = {
  role: "hitter",
  qualifies: (o, minN) => o.hit.PA >= minN,
  weight: (o) => Math.pow(o.hit.PA, 0.75),
  actualWoba: actualHitWoba,
  higherBetter: true,
};
export const PITCHER: RoleSpec = {
  role: "pitcher",
  qualifies: (o, minN) => o.pitch.BF >= minN,
  weight: (o) => Math.pow(o.pitch.BF, 0.75),
  actualWoba: actualPitWoba,
  higherBetter: false, // lower wOBA allowed = better
};

// The basic models predict a SCORE that is affine in wOBA (hitting: wOBA×333;
// pitching: (0.64 − wOBA-allowed)×333). Invert to wOBA so they sit on the scoreboard
// in the same space as the wOBA models — directly comparable on every metric.
export function predictBasicHitWoba(c: BasicHittingCoeffs, o: TrainObs): number {
  const r = o.ratings.hit;
  const score = c.basic_intercept + c.w_babip * ln1(r.babip) + c.w_pow * ln1(r.pow) + c.w_eye * ln1(r.eye) + c.w_k * ln1(r.kRat) + c.w_gap * ln1(r.gap);
  return score / 333;
}
export function predictBasicPitWoba(c: BasicPitchingCoeffs, o: TrainObs): number {
  const r = o.ratings.pitch;
  const score = c.basic_intercept + c.p_stuff * ln1(r.stu) + c.p_control * ln1(r.con) + c.p_babip * ln1(r.pbabip) + c.p_hr * ln1(r.hrr);
  return 0.64 - score / 333; // recover predicted wOBA allowed
}

// The four current models as bake-off entries. `model` is the model TYPE (woba /
// basic); when candidate forms arrive they extend the name (e.g. "woba·cubic").
export const wobaHitting: BakeoffModel = {
  name: "woba", role: "hitter",
  fit: (train) => trainWobaHitting(train, 0).coefficients,
  predict: (params, test) => test.map((o) => predictHitWoba(params as WobaHittingCoeffs, o)),
};
export const wobaPitching: BakeoffModel = {
  name: "woba", role: "pitcher",
  fit: (train) => trainWobaPitching(train, 0).coefficients,
  predict: (params, test) => test.map((o) => predictPitWoba(params as WobaPitchingCoeffs, o)),
};
export const basicHitting: BakeoffModel = {
  name: "basic", role: "hitter",
  fit: (train) => trainBasicHitting(train, 0, false).coefficients, // unclamped — see trainBasicHitting
  predict: (params, test) => test.map((o) => predictBasicHitWoba(params as BasicHittingCoeffs, o)),
};
export const basicPitching: BakeoffModel = {
  name: "basic", role: "pitcher",
  fit: (train) => trainBasicPitching(train, 0, false).coefficients,
  predict: (params, test) => test.map((o) => predictBasicPitWoba(params as BasicPitchingCoeffs, o)),
};

// ── Scoreboard registry ─────────────────────────────────────────────────────────
// A model's monotonicity/extrapolation gate status (forms only; baselines pass by
// construction — log curves never turn over). `notes` lists the offending events.
export interface GateStatus { status: "pass" | "warn"; notes: string[] }
// One row-group on the scoreboard: a model+role, plus an optional gate evaluated on
// the in-sample window fit (candidate forms set this; baselines leave it undefined).
export interface BakeoffEntry { model: BakeoffModel; spec: RoleSpec; gate?: (params: unknown, obs: TrainObs[]) => GateStatus }

// The four parity baselines. Candidate forms live in forms.ts (FORM_ENTRIES) and are
// concatenated in evaluate.ts — keeping that dependency one-way (forms → bakeoff).
export const BASE_ENTRIES: BakeoffEntry[] = [
  { model: wobaHitting, spec: HITTER }, { model: basicHitting, spec: HITTER },
  { model: wobaPitching, spec: PITCHER }, { model: basicPitching, spec: PITCHER },
];
