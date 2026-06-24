// M6 — model-evaluation runner: cross-validation, out-of-time (forward + backward)
// validation, and a scoreboard over the available year windows. Everything runs in
// wOBA space (upstream of anchoring/baseline, which are under review). Folds are
// deterministic (key-hash, no RNG) so runs are reproducible.

import type { TrainObs } from "./loader.ts";
import { loadWindow, availableYears } from "./loader.ts";
import { evalMetrics, type EvalMetrics } from "./metrics.ts";
import { type BakeoffModel, type RoleSpec, HITTER, PITCHER, wobaHitting, wobaPitching, basicHitting, basicPitching } from "./bakeoff.ts";

/** Deterministic fold assignment by observation key (FNV-1a hash → no RNG). */
export function foldOf(key: string, k: number): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % k;
}

interface EvalOpts { minN?: number; topN?: number; k?: number; window?: number[] }

/** k-fold CV: pooled out-of-sample predictions → one metric bundle. */
export function crossValidate(obs: TrainObs[], model: BakeoffModel, spec: RoleSpec, opts: EvalOpts = {}): EvalMetrics {
  const { minN = 1000, topN = 26, k = 5 } = opts;
  const qual = obs.filter((o) => spec.qualifies(o, minN));
  const pred: number[] = [], actual: number[] = [], weight: number[] = [];
  for (let f = 0; f < k; f++) {
    const test = qual.filter((o) => foldOf(o.key, k) === f);
    const train = qual.filter((o) => foldOf(o.key, k) !== f);
    if (test.length === 0 || train.length < 10) continue;
    const params = model.fit(train);
    const p = model.predict(params, test);
    test.forEach((o, i) => { pred.push(p[i]!); actual.push(spec.actualWoba(o)); weight.push(spec.weight(o)); });
  }
  return evalMetrics(pred, actual, weight, spec.higherBetter, topN);
}

/** In-sample (train == test) — the optimistic bound; the CV gap shows overfit. */
export function inSample(obs: TrainObs[], model: BakeoffModel, spec: RoleSpec, opts: EvalOpts = {}): EvalMetrics {
  const { minN = 1000, topN = 26 } = opts;
  const qual = obs.filter((o) => spec.qualifies(o, minN));
  const params = model.fit(qual);
  return evalMetrics(model.predict(params, qual), qual.map(spec.actualWoba), qual.map(spec.weight), spec.higherBetter, topN);
}

/** Out-of-time: fit on one period, evaluate on another (forward or backward). */
export function outOfTime(trainObs: TrainObs[], testObs: TrainObs[], model: BakeoffModel, spec: RoleSpec, opts: EvalOpts = {}): EvalMetrics {
  const { minN = 1000, topN = 26 } = opts;
  const tr = trainObs.filter((o) => spec.qualifies(o, minN));
  const te = testObs.filter((o) => spec.qualifies(o, minN));
  const params = model.fit(tr);
  return evalMetrics(model.predict(params, te), te.map(spec.actualWoba), te.map(spec.weight), spec.higherBetter, topN);
}

export interface ScoreRow { model: string; role: "hitter" | "pitcher"; evaluation: string; window: string; metrics: EvalMetrics }
export interface Scoreboard { minN: number; k: number; topN: number; years: number[]; trainWindow: number[]; rows: ScoreRow[] }

/** Default live window = the most recent two years (limits cross-year drift). */
export function defaultWindow(years: number[]): number[] {
  return years.slice(-2);
}

/**
 * Scoreboard for all four models (woba/basic × hit/pitch), grouped by model+role:
 *   • in-sample + k-fold CV on the SELECTED training window (default: recent 2yr).
 *   • forward + backward out-of-time, BOTH training on 2 years → testing on 1 (so
 *     neither direction is hobbled by a single-year fit, which would overfit flexible
 *     forms): forward trains the 2 oldest → tests newest (extrapolate UP to new
 *     elite cards); backward trains the 2 newest → tests oldest (extrapolate DOWN to
 *     weaker / limited-pool cards, the tournament-like stress). Needs ≥3 years for a
 *     2yr train + held-out year; with only 2 years it falls back to 1yr↔1yr.
 */
export function buildScoreboard(root: string, opts: EvalOpts = {}): Scoreboard {
  const { minN = 1000, topN = 26, k = 5 } = opts;
  const years = availableYears(root);
  const window = opts.window?.length ? opts.window : defaultWindow(years);
  const winObs = loadWindow(root, window).observations;
  const models: [BakeoffModel, RoleSpec][] = [[wobaHitting, HITTER], [basicHitting, HITTER], [wobaPitching, PITCHER], [basicPitching, PITCHER]];
  const rows: ScoreRow[] = [];

  // Both OOT directions train on up to 2 adjacent years, test on the held-out edge year.
  const n = years.length;
  const fwdTrain = years.slice(Math.max(0, n - 3), n - 1), fwdTest = n >= 2 ? [years[n - 1]!] : [];
  const backTrain = years.slice(1, Math.min(n, 3)), backTest = n >= 2 ? [years[0]!] : [];
  const obsOf = (ys: number[]) => (ys.length ? loadWindow(root, ys).observations : []);
  const fwdTrainObs = obsOf(fwdTrain), fwdTestObs = obsOf(fwdTest), backTrainObs = obsOf(backTrain), backTestObs = obsOf(backTest);

  for (const [model, spec] of models) {
    rows.push({ model: model.name, role: spec.role, evaluation: "in-sample", window: window.join("+"), metrics: inSample(winObs, model, spec, opts) });
    rows.push({ model: model.name, role: spec.role, evaluation: "cv", window: `${window.join("+")}, ${k}-fold`, metrics: crossValidate(winObs, model, spec, opts) });
    if (fwdTest.length) {
      rows.push({ model: model.name, role: spec.role, evaluation: "forward", window: `${fwdTrain.join("+")}→${fwdTest[0]}`, metrics: outOfTime(fwdTrainObs, fwdTestObs, model, spec, opts) });
      rows.push({ model: model.name, role: spec.role, evaluation: "backward", window: `${backTrain.join("+")}→${backTest[0]}`, metrics: outOfTime(backTrainObs, backTestObs, model, spec, opts) });
    }
  }
  return { minN, k, topN, years, trainWindow: window, rows };
}
