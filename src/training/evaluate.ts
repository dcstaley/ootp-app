// M6 — model-evaluation runner: cross-validation, out-of-time (forward + backward)
// validation, and a scoreboard over the available year windows. Everything runs in
// wOBA space (upstream of anchoring/baseline, which are under review). Folds are
// deterministic (key-hash, no RNG) so runs are reproducible.

import type { TrainObs } from "./loader.ts";
import { loadWindow, availableYears } from "./loader.ts";
import { evalMetrics, type EvalMetrics } from "./metrics.ts";
import { type BakeoffModel, type RoleSpec, HITTER, PITCHER, logLinearHitting, logLinearPitching } from "./bakeoff.ts";

/** Deterministic fold assignment by observation key (FNV-1a hash → no RNG). */
export function foldOf(key: string, k: number): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % k;
}

interface EvalOpts { minN?: number; topN?: number; k?: number }

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
export interface Scoreboard { minN: number; k: number; topN: number; years: number[]; rows: ScoreRow[] }

/**
 * Build the baseline scoreboard for a data root: in-sample + 5-fold CV on the full
 * window, plus forward (older→newest) and backward (newest→older) out-of-time when
 * ≥2 years exist. Backward = train newest → test older: stresses weaker cards /
 * limited-pool (tournament-like) conditions, per the user.
 */
export function buildScoreboard(root: string, opts: EvalOpts = {}): Scoreboard {
  const { minN = 1000, topN = 26, k = 5 } = opts;
  const years = availableYears(root);
  const all = loadWindow(root).observations;
  const models: [BakeoffModel, RoleSpec][] = [[logLinearHitting, HITTER], [logLinearPitching, PITCHER]];
  const rows: ScoreRow[] = [];

  for (const [model, spec] of models) {
    rows.push({ model: model.name, role: spec.role, evaluation: "in-sample", window: `all (${years.join("+")})`, metrics: inSample(all, model, spec, opts) });
    rows.push({ model: model.name, role: spec.role, evaluation: "cv", window: `all, ${k}-fold`, metrics: crossValidate(all, model, spec, opts) });
  }

  if (years.length >= 2) {
    const older = years.slice(0, -1), newest = [years[years.length - 1]!];
    const olderObs = loadWindow(root, older).observations;
    const newestObs = loadWindow(root, newest).observations;
    const fwd = `${older.join("+")}→${newest[0]}`, back = `${newest[0]}→${older.join("+")}`;
    for (const [model, spec] of models) {
      rows.push({ model: model.name, role: spec.role, evaluation: "forward", window: fwd, metrics: outOfTime(olderObs, newestObs, model, spec, opts) });
      rows.push({ model: model.name, role: spec.role, evaluation: "backward", window: back, metrics: outOfTime(newestObs, olderObs, model, spec, opts) });
    }
  }
  return { minN, k, topN, years, rows };
}
