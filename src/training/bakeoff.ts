// M6 — bake-off model abstraction + wOBA assembly. A BakeoffModel is anything that
// can FIT on a training subset and PREDICT assembled wOBA on a held-out subset, so
// candidate forms (cubic, spline, interactions, …) drop in behind one interface and
// land on the same scoreboard. The first implementation wraps the parity log-linear
// fit. Predicted wOBA is the RAW assembly (fixed weights, training-consistent BIP
// chain) — upstream of softcaps / leagueNorm / anchor (all under review; a per-event
// scale or anchor would only distort the gap-fidelity we measure).

import type { TrainObs } from "./loader.ts";
import { trainWobaHitting, trainWobaPitching, type WobaHittingCoeffs, type WobaPitchingCoeffs } from "./fit.ts";

const ln1 = (x: number) => Math.log(Math.max(x, 1));
// Fixed wOBA event weights (the league-standard linear weights the app uses).
const W_BB = 0.704, W_1B = 0.8992, W_XBH = 1.29, W_HR = 2.0759, HBP = 6;

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
  return (W_BB * o.hit.BB * s + W_BB * HBP + W_1B * Math.max(oneB, 0) + W_XBH * xbh + W_HR * hr) / 600;
}

export function predictPitWoba(c: WobaPitchingCoeffs, o: TrainObs): number {
  const r = o.ratings.pitch;
  const bb = Math.max(c.bb.intercept + c.bb.con * ln1(r.con), 0);
  const k = Math.max(c.k.intercept + c.k.stu * ln1(r.stu), 0);
  const hr = Math.max(c.hr.intercept + c.hr.hrr * ln1(r.hrr), 0);
  const bip = Math.max(600 - bb - k - hr - 6, 1);
  const nHH = Math.max(c.h.intercept + c.h.pbabip * ln1(r.pbabip) + c.h.bip * ln1(bip), 0);
  const xbh = nHH * c.xbh.share, oneB = Math.max(nHH - xbh, 0);
  return (W_BB * bb + W_1B * oneB + W_XBH * xbh + W_HR * hr) / 600; // no HBP term (matches old)
}
export function actualPitWoba(o: TrainObs): number {
  const bf = Math.max(o.pitch.BF, 1), s = 600 / bf;
  return (W_BB * o.pitch.BB * s + W_1B * o.pitch.b1 * s + W_XBH * (o.pitch.b2 + o.pitch.b3) * s + W_HR * o.pitch.HR * s) / 600;
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

// The parity log-linear as bake-off models (the scoreboard baseline row).
export const logLinearHitting: BakeoffModel = {
  name: "log-linear", role: "hitter",
  fit: (train) => trainWobaHitting(train, 0).coefficients,
  predict: (params, test) => test.map((o) => predictHitWoba(params as WobaHittingCoeffs, o)),
};
export const logLinearPitching: BakeoffModel = {
  name: "log-linear", role: "pitcher",
  fit: (train) => trainWobaPitching(train, 0).coefficients,
  predict: (params, test) => test.map((o) => predictPitWoba(params as WobaPitchingCoeffs, o)),
};
