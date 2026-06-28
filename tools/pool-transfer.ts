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
import { LOG_HIT, LOG_PIT, fitHitForm, predictHitForm, fitPitForm, predictPitForm } from "../src/training/forms.ts";

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

function run(label: string, trainObs: TrainObs[], testObs: TrainObs[], role: RoleSpec, isHit: boolean) {
  const skills = isHit ? HIT_SK : PIT_SK, getR = isHit ? getHit : getPit, wt = (o: TrainObs) => role.weight(o);
  const train = trainObs.filter((o) => role.qualifies(o, MIN_N));
  const test = testObs.filter((o) => role.qualifies(o, MIN_N));
  const trStats = skillStats(train, skills, getR, wt), teStats = skillStats(test, skills, getR, wt);
  const params = isHit ? fitHitForm(LOG_HIT, train) : fitPitForm(LOG_PIT, train);
  const pred = (o: TrainObs) => (isHit ? predictHitForm(params as any, o) : predictPitForm(params as any, o));

  // ceiling: fit on TEST itself, predict TEST in-sample (best achievable on this pool)
  const ceilParams = isHit ? fitHitForm(LOG_HIT, test) : fitPitForm(LOG_PIT, test);
  const ceil = evalMetrics(test.map((o) => (isHit ? predictHitForm(ceilParams as any, o) : predictPitForm(ceilParams as any, o))), test.map(role.actualWoba), test.map(wt), role.higherBetter, TOPN);

  console.log(`\n== ${label} ==  (train n=${train.length}, test n=${test.length}; ceiling in-sample Pearson=${ceil.pearson.toFixed(4)})`);
  for (const mode of ["H0 raw", "H1 level", "H2 zscore"] as Mode[]) {
    const aligned = test.map((o) => (isHit ? alignHit(o, mode, trStats, teStats) : alignPit(o, mode, trStats, teStats)));
    const m = evalMetrics(aligned.map(pred), test.map(role.actualWoba), test.map(wt), role.higherBetter, TOPN);
    console.log(`  ${mode.padEnd(9)} Pearson=${m.pearson.toFixed(4)}  regret=${(m.valueRegret * 1000).toFixed(1)}`);
  }
}

console.log(`pool-transfer — log form, OLD=2032+2033 vs NEW=2037+2038+2039, minN=${MIN_N}, eval weight ^0.75 (fixed)`);
run("HITTERS  OLD→NEW (extrapolate up)", OLD, NEW, HITTER, true);
run("HITTERS  NEW→OLD (extrapolate down)", NEW, OLD, HITTER, true);
run("PITCHERS OLD→NEW (extrapolate up)", OLD, NEW, PITCHER, false);
run("PITCHERS NEW→OLD (extrapolate down)", NEW, OLD, PITCHER, false);
