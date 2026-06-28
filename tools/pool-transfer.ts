// DIAGNOSTIC (pool-adjustment step 1) — does re-centering ratings to the training
// pool fix cross-pool transfer? Now that we have OLD (2032-33) vs NEW (2039) pools
// that genuinely differ in talent, we can run the real test:
//   • fit the log (woba) form on the TRAIN pool,
//   • predict the TEST pool's wOBA three ways:
//       H0 raw    — test ratings as-is (status quo: no pool adjustment)
//       H1 level  — shift each test rating so the test-pool MEAN lands on the train mean
//       H2 zscore — also rescale by sd: train_mean + (r − test_mean)·(sd_train/sd_test)
//   • score weighted-Pearson + value-regret (eval weight = PA/BF^0.75, fixed),
//   • both directions (OLD→NEW = extrapolate up; NEW→OLD = extrapolate down),
//   • with the within-test in-sample fit as the "home pool" ceiling.
// If H1/H2 beat H0, pool-relative (rating-space) adjustment is empirically supported.
// Pearson is affine-invariant, so a pure level shift can't fake a gain — only a real
// change to the relative-gap structure (through the nonlinear curve) moves it.
//
// Run: node tools/pool-transfer.ts

import { existsSync } from "node:fs";
import { loadWindow, type TrainObs } from "../src/training/loader.ts";
import { evalMetrics } from "../src/training/metrics.ts";
import { HITTER, PITCHER, type RoleSpec } from "../src/training/bakeoff.ts";
import {
  LOG_HIT, LOG_PIT, RAWPOLY_HIT, RAWPOLY_PIT, RAWQUAD_HIT, RAWQUAD_PIT,
  fitHitForm, predictHitForm, fitPitForm, predictPitForm,
  fitHitGLM, predictHitGLM, fitPitGLM, predictPitGLM,
  fitHitSeq, predictHitSeq, fitPitSeq, predictPitSeq,
} from "../src/training/forms.ts";

const DIR = [process.env.TRAINING_DIR, "League Files", "Model 2037 and 2038"].find((d) => d && existsSync(d))!;
const OLD = loadWindow(DIR, [2032, 2033]).observations;
const NEW = loadWindow(DIR, [2037, 2038, 2039]).observations; // pool 3yr to cut small-N noise
const MIN_N = 600, TOPN = 26;

type Mode = "H0 raw" | "H1 level" | "H2 zscore";
const wmean = (v: number[], w: number[]) => v.reduce((s, x, i) => s + w[i]! * x, 0) / w.reduce((s, x) => s + x, 0);
const wsd = (v: number[], w: number[], m: number) => Math.sqrt(v.reduce((s, x, i) => s + w[i]! * (x - m) ** 2, 0) / w.reduce((s, x) => s + x, 0));

// Per-skill (mean, sd) of a pool, weighted by exposure.
function skillStats(obs: TrainObs[], skills: string[], get: (o: TrainObs, s: string) => number, wt: (o: TrainObs) => number) {
  const w = obs.map(wt);
  const out: Record<string, { m: number; sd: number }> = {};
  for (const s of skills) { const v = obs.map((o) => get(o, s)); const m = wmean(v, w); out[s] = { m, sd: wsd(v, w, m) || 1 }; }
  return out;
}
// Remap a test rating onto the TRAIN pool's scale (same relative standing).
const remap = (r: number, mode: Mode, tr: { m: number; sd: number }, te: { m: number; sd: number }) =>
  mode === "H0 raw" ? r : mode === "H1 level" ? tr.m + (r - te.m) : tr.m + (r - te.m) * (tr.sd / te.sd);

const HIT_SK = ["eye", "kRat", "pow", "babip", "gap"];
const PIT_SK = ["con", "stu", "hrr", "pbabip"];
const getHit = (o: TrainObs, s: string) => (o.ratings.hit as unknown as Record<string, number>)[s]!;
const getPit = (o: TrainObs, s: string) => (o.ratings.pitch as unknown as Record<string, number>)[s]!;

function alignHit(o: TrainObs, mode: Mode, tr: Record<string, { m: number; sd: number }>, te: Record<string, { m: number; sd: number }>): TrainObs {
  const h = { ...o.ratings.hit };
  for (const s of HIT_SK) (h as unknown as Record<string, number>)[s] = remap((o.ratings.hit as unknown as Record<string, number>)[s]!, mode, tr[s]!, te[s]!);
  return { ...o, ratings: { ...o.ratings, hit: h } };
}
function alignPit(o: TrainObs, mode: Mode, tr: Record<string, { m: number; sd: number }>, te: Record<string, { m: number; sd: number }>): TrainObs {
  const p = { ...o.ratings.pitch };
  for (const s of PIT_SK) (p as unknown as Record<string, number>)[s] = remap((o.ratings.pitch as unknown as Record<string, number>)[s]!, mode, tr[s]!, te[s]!);
  return { ...o, ratings: { ...o.ratings, pitch: p } };
}

// Each form as a (fit, predict) pair; alignment is model-agnostic (it transforms the
// test obs' ratings, then ANY model predicts on them). Covers curve forms (log, the
// targeted #2, uniform raw-quad) + the structural alternatives (Poisson GLM, seqcond).
type FitFn = (obs: TrainObs[]) => unknown;
type PredFn = (params: unknown, o: TrainObs) => number;
interface Model { name: string; hitFit: FitFn; hitPred: PredFn; pitFit: FitFn; pitPred: PredFn }
const MODELS: Model[] = [
  { name: "log",     hitFit: (o) => fitHitForm(LOG_HIT, o),     hitPred: (p, o) => predictHitForm(p as any, o), pitFit: (o) => fitPitForm(LOG_PIT, o),     pitPred: (p, o) => predictPitForm(p as any, o) },
  { name: "rawpoly", hitFit: (o) => fitHitForm(RAWPOLY_HIT, o), hitPred: (p, o) => predictHitForm(p as any, o), pitFit: (o) => fitPitForm(RAWPOLY_PIT, o), pitPred: (p, o) => predictPitForm(p as any, o) },
  { name: "rawquad", hitFit: (o) => fitHitForm(RAWQUAD_HIT, o), hitPred: (p, o) => predictHitForm(p as any, o), pitFit: (o) => fitPitForm(RAWQUAD_PIT, o), pitPred: (p, o) => predictPitForm(p as any, o) },
  { name: "poisson", hitFit: (o) => fitHitGLM(o, false),        hitPred: (p, o) => predictHitGLM(p as any, o),  pitFit: (o) => fitPitGLM(o, false),        pitPred: (p, o) => predictPitGLM(p as any, o) },
  { name: "seqcond", hitFit: (o) => fitHitSeq(o),               hitPred: (p, o) => predictHitSeq(p as any, o),  pitFit: (o) => fitPitSeq(o),               pitPred: (p, o) => predictPitSeq(p as any, o) },
];

function run(trainObs: TrainObs[], testObs: TrainObs[], role: RoleSpec, isHit: boolean, m: Model) {
  const skills = isHit ? HIT_SK : PIT_SK, getR = isHit ? getHit : getPit, wt = (o: TrainObs) => role.weight(o);
  const train = trainObs.filter((o) => role.qualifies(o, MIN_N));
  const test = testObs.filter((o) => role.qualifies(o, MIN_N));
  const trStats = skillStats(train, skills, getR, wt), teStats = skillStats(test, skills, getR, wt);
  const fit = isHit ? m.hitFit : m.pitFit, pred = isHit ? m.hitPred : m.pitPred;
  const params = fit(train);
  const pear = (obsList: TrainObs[]) => evalMetrics(obsList.map((o) => pred(params, o)), test.map(role.actualWoba), test.map(wt), role.higherBetter, TOPN).pearson;
  const ceil = evalMetrics(test.map((o) => pred(fit(test), o)), test.map(role.actualWoba), test.map(wt), role.higherBetter, TOPN).pearson; // fit-on-test ceiling
  const modes = (["H0 raw", "H1 level", "H2 zscore"] as Mode[]).map((mode) => pear(test.map((o) => (isHit ? alignHit(o, mode, trStats, teStats) : alignPit(o, mode, trStats, teStats)))));
  return { ceil, h0: modes[0]!, h1: modes[1]!, h2: modes[2]!, nTrain: train.length, nTest: test.length };
}

function table(title: string, trainObs: TrainObs[], testObs: TrainObs[], role: RoleSpec, isHit: boolean) {
  const first = run(trainObs, testObs, role, isHit, MODELS[0]!);
  console.log(`\n== ${title} ==  (train n=${first.nTrain}, test n=${first.nTest})`);
  console.log(`  model      ceiling   H0 raw    H1 level  H2 zscore   Δ(H1−H0)`);
  for (const m of MODELS) {
    const r = run(trainObs, testObs, role, isHit, m), d = r.h1 - r.h0;
    console.log(`  ${m.name.padEnd(9)}  ${r.ceil.toFixed(4)}    ${r.h0.toFixed(4)}    ${r.h1.toFixed(4)}    ${r.h2.toFixed(4)}     ${d >= 0 ? "+" : ""}${d.toFixed(4)}`);
  }
}

console.log(`pool-transfer — OLD=2032+2033 vs NEW=2037+2038+2039, minN=${MIN_N}, eval weight ^0.75 (fixed); values = weighted Pearson`);
table("HITTERS  OLD→NEW (extrapolate up)", OLD, NEW, HITTER, true);
table("HITTERS  NEW→OLD (extrapolate down)", NEW, OLD, HITTER, true);
table("PITCHERS OLD→NEW (extrapolate up)", OLD, NEW, PITCHER, false);
table("PITCHERS NEW→OLD (extrapolate down)", NEW, OLD, PITCHER, false);
