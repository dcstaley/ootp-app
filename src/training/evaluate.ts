// M6 — model-evaluation runner: cross-validation, out-of-time (forward + backward)
// validation, and a scoreboard over the available year windows. Everything runs in
// wOBA space (upstream of anchoring/baseline, which are under review). Folds are
// deterministic (key-hash, no RNG) so runs are reproducible.

import type { TrainObs } from "./loader.ts";
import { loadWindow, availableYears } from "./loader.ts";
import { evalMetrics, type EvalMetrics } from "./metrics.ts";
import { type BakeoffModel, type RoleSpec, type BakeoffEntry, type GateStatus, BASE_ENTRIES, HITTER, PITCHER } from "./bakeoff.ts";
import { FORM_ENTRIES } from "./forms.ts";

/** Deterministic fold assignment by observation key (FNV-1a hash → no RNG). */
export function foldOf(key: string, k: number): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % k;
}

interface EvalOpts { minN?: number; topN?: number; k?: number; window?: number[]; includeVariants?: boolean; foldKey?: (o: TrainObs) => string }

// CV fold key (T-2). Decision (Derek): vL and vR are different players (profiles can
// differ materially by side) → sides stay in INDEPENDENT folds; but base+variant are
// near-duplicates (same player, uniformly boosted ratings) → they must travel TOGETHER.
// So fold on `cid|side`, dropping the B/V token from o.key (`cid|B|V|side`). This changes
// ONLY which rows are hidden together in CV — nothing about what is trained or scored
// (variants stay in everything). Overridable via opts.foldKey for the one-time A/B.
export const cvFoldKey = (o: TrainObs) => `${o.cid}|${o.side}`;

// The complementary role's spec — used to hand joint-fit models (matchup-K) the other
// role's observations alongside their own train set (see BakeoffModel.fit's `opp`).
const oppSpecOf = (spec: RoleSpec): RoleSpec => (spec.role === "hitter" ? PITCHER : HITTER);

/** k-fold CV: pooled out-of-sample predictions → one metric bundle. */
export function crossValidate(obs: TrainObs[], model: BakeoffModel, spec: RoleSpec, opts: EvalOpts = {}): EvalMetrics {
  const { minN = 1000, topN = 26, k = 5 } = opts;
  const fk = opts.foldKey ?? cvFoldKey;
  const qual = obs.filter((o) => spec.qualifies(o, minN));
  const oppQual = obs.filter((o) => oppSpecOf(spec).qualifies(o, minN));
  const pred: number[] = [], actual: number[] = [], weight: number[] = [];
  for (let f = 0; f < k; f++) {
    const test = qual.filter((o) => foldOf(fk(o), k) === f);
    const train = qual.filter((o) => foldOf(fk(o), k) !== f);
    if (test.length === 0 || train.length < 10) continue;
    // opp rows follow the SAME fold discipline (fk is cid|side for both roles), so a
    // two-way card's other-role row never leaks into the fit of its held-out fold.
    const params = model.fit(train, oppQual.filter((o) => foldOf(fk(o), k) !== f));
    const p = model.predict(params, test);
    test.forEach((o, i) => { pred.push(p[i]!); actual.push(spec.actualWoba(o)); weight.push(spec.weight(o)); });
  }
  return evalMetrics(pred, actual, weight, spec.higherBetter, topN);
}

/** In-sample (train == test) — the optimistic bound; the CV gap shows overfit. */
export function inSample(obs: TrainObs[], model: BakeoffModel, spec: RoleSpec, opts: EvalOpts = {}): EvalMetrics {
  const { minN = 1000, topN = 26 } = opts;
  const qual = obs.filter((o) => spec.qualifies(o, minN));
  const params = model.fit(qual, obs.filter((o) => oppSpecOf(spec).qualifies(o, minN)));
  return evalMetrics(model.predict(params, qual), qual.map(spec.actualWoba), qual.map(spec.weight), spec.higherBetter, topN);
}

/** Out-of-time: fit on one period, evaluate on another (forward or backward). */
export function outOfTime(trainObs: TrainObs[], testObs: TrainObs[], model: BakeoffModel, spec: RoleSpec, opts: EvalOpts = {}): EvalMetrics {
  const { minN = 1000, topN = 26 } = opts;
  const tr = trainObs.filter((o) => spec.qualifies(o, minN));
  const te = testObs.filter((o) => spec.qualifies(o, minN));
  const params = model.fit(tr, trainObs.filter((o) => oppSpecOf(spec).qualifies(o, minN)));
  return evalMetrics(model.predict(params, te), te.map(spec.actualWoba), te.map(spec.weight), spec.higherBetter, topN);
}

export interface ScoreRow { model: string; role: "hitter" | "pitcher"; evaluation: string; window: string; metrics: EvalMetrics; gate?: GateStatus }
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
  const { minN = 1000, topN = 26, k = 5, includeVariants = true } = opts;
  const vf = (o: TrainObs) => includeVariants || !o.variant;
  const years = availableYears(root);
  const window = opts.window?.length ? opts.window : defaultWindow(years);
  const winObs = loadWindow(root, window).observations.filter(vf);
  // Baselines + candidate forms, grouped by role (each role's models adjacent for
  // easy comparison): woba / basic / form… for hitters, then the same for pitchers.
  const all: BakeoffEntry[] = [...BASE_ENTRIES, ...FORM_ENTRIES];
  const models: BakeoffEntry[] = [...all.filter((e) => e.spec.role === "hitter"), ...all.filter((e) => e.spec.role === "pitcher")];
  const rows: ScoreRow[] = [];

  // OOT tests the ACTUAL trained model: fit on the SELECTED window (the model's years) and
  // evaluate on the held-out BLOCK outside it — backward = the distant-past block (the leading
  // run of early years split from the window by a >2yr gap, e.g. 2032+2033), forward = the
  // trailing future block. So the OOT rows track the chosen window instead of a fixed edge
  // sub-window; a direction with no out-of-window block is omitted.
  const wMin = Math.min(...window), wMax = Math.max(...window);
  const backTest: number[] = [];
  for (let i = 0; i < years.length && years[i]! < wMin; i++) {
    if (i > 0 && years[i]! - years[i - 1]! > 2) break; // gap → past the distant block
    backTest.push(years[i]!);
  }
  const fwdTest: number[] = [];
  for (let i = years.length - 1; i >= 0 && years[i]! > wMax; i--) {
    if (i < years.length - 1 && years[i + 1]! - years[i]! > 2) break;
    fwdTest.unshift(years[i]!);
  }
  const obsOf = (ys: number[]) => (ys.length ? loadWindow(root, ys).observations.filter(vf) : []);
  const fwdTestObs = obsOf(fwdTest), backTestObs = obsOf(backTest);

  for (const { model, spec, gate } of models) {
    // Gate is computed on the in-sample window fit (the curve's primary shape) and
    // attached to the in-sample row only — OOT/CV rows refit on other data, so it
    // would be misleading to repeat it there.
    let gateStatus: GateStatus | undefined;
    if (gate) {
      const qual = winObs.filter((o) => spec.qualifies(o, minN));
      const opp = winObs.filter((o) => oppSpecOf(spec).qualifies(o, minN));
      if (qual.length >= 10) gateStatus = gate(model.fit(qual, opp), qual);
    }
    rows.push({ model: model.name, role: spec.role, evaluation: "in-sample", window: window.join("+"), metrics: inSample(winObs, model, spec, opts), gate: gateStatus });
    rows.push({ model: model.name, role: spec.role, evaluation: "cv", window: `${window.join("+")}, ${k}-fold`, metrics: crossValidate(winObs, model, spec, opts) });
    // OOT: fit on the window (winObs), test on out-of-window years. Each direction independent.
    if (fwdTest.length) rows.push({ model: model.name, role: spec.role, evaluation: "forward", window: `${window.join("+")}→${fwdTest.join(",")}`, metrics: outOfTime(winObs, fwdTestObs, model, spec, opts) });
    if (backTest.length) rows.push({ model: model.name, role: spec.role, evaluation: "backward", window: `${window.join("+")}→${backTest.join(",")}`, metrics: outOfTime(winObs, backTestObs, model, spec, opts) });
  }
  return { minN, k, topN, years, trainWindow: window, rows };
}
