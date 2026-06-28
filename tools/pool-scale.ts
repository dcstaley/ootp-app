// DIAGNOSTIC — head-to-head of ALL re-scaling modes on the real OLD<->NEW transfer
// (hitters), with the pool average defined per platoon side. Settles "is H2 actually
// better, or multiplicative?" by putting them on identical footing (same top-X means).
//   modes: H0 raw | add (additive shift, mean only) | H2 (z-score: mean+sd) |
//          mult (multiplicative, r*(trainMean/testMean))
//   pool-def per side: allPA (PA^0.75-weighted) / top25 / top50 (by actual wOBA)
// Fit on train pool, predict test, weighted Pearson vs the in-sample ceiling.
//
// Run: node tools/pool-scale.ts

import { existsSync } from "node:fs";
import { loadWindow, type TrainObs, type Side } from "../src/training/loader.ts";
import { evalMetrics } from "../src/training/metrics.ts";
import { HITTER, actualHitWoba } from "../src/training/bakeoff.ts";
import { LOG_HIT, RAWPOLY_HIT, fitHitForm, predictHitForm, type HitForm } from "../src/training/forms.ts";

const DIR = [process.env.TRAINING_DIR, "League Files", "Model 2037 and 2038"].find((d) => d && existsSync(d))!;
const OLD = loadWindow(DIR, [2032, 2033]).observations;
const NEW = loadWindow(DIR, [2038, 2039]).observations;
const MIN_N = 600;
const SK = ["eye", "kRat", "pow", "babip", "gap"];
const getR = (o: TrainObs, s: string) => (o.ratings.hit as unknown as Record<string, number>)[s]!;

interface MS { m: number; sd: number }
type Def = "allPA" | "top25" | "top50";
type Means = Record<Side, Record<string, MS>>;
function buildMeans(obs: TrainObs[], def: Def): Means {
  const out = { L: {}, R: {} } as Means;
  for (const side of ["L", "R"] as Side[]) {
    const pool = obs.filter((o) => o.side === side && o.hit.PA >= MIN_N);
    for (const s of SK) {
      let vals: number[], w: number[];
      if (def === "allPA") { vals = pool.map((o) => getR(o, s)); w = pool.map((o) => Math.pow(o.hit.PA, 0.75)); }
      else { const top = [...pool].sort((a, b) => actualHitWoba(b) - actualHitWoba(a)).slice(0, def === "top25" ? 25 : 50); vals = top.map((o) => getR(o, s)); w = vals.map(() => 1); }
      const W = w.reduce((a, x) => a + x, 0);
      const m = vals.reduce((a, v, i) => a + w[i]! * v, 0) / W;
      const sd = Math.sqrt(vals.reduce((a, v, i) => a + w[i]! * (v - m) ** 2, 0) / W) || 1;
      out[side][s] = { m, sd };
    }
  }
  return out;
}

type Mode = "H0" | "add" | "H2" | "mult";
function adjust(o: TrainObs, mode: Mode, trM: Means, teM: Means): TrainObs {
  const h = { ...o.ratings.hit } as unknown as Record<string, number>;
  for (const s of SK) {
    const tr = trM[o.side][s]!, te = teM[o.side][s]!, r = getR(o, s);
    h[s] = mode === "H0" ? r : mode === "add" ? tr.m + (r - te.m) : mode === "H2" ? tr.m + (r - te.m) * (tr.sd / te.sd) : r * (tr.m / te.m);
  }
  return { ...o, ratings: { ...o.ratings, hit: h as any } };
}

function transfer(form: HitForm, trainObs: TrainObs[], testObs: TrainObs[], def: Def, mode: Mode): number {
  const train = trainObs.filter((o) => o.hit.PA >= MIN_N), test = testObs.filter((o) => o.hit.PA >= MIN_N);
  const trM = buildMeans(train, def), teM = buildMeans(test, def);
  const params = fitHitForm(form, train);
  const pred = test.map((o) => predictHitForm(params, adjust(o, mode, trM, teM)));
  return evalMetrics(pred, test.map(actualHitWoba), test.map((o) => HITTER.weight(o)), true, 26).pearson;
}
function ceiling(form: HitForm, testObs: TrainObs[]): number {
  const test = testObs.filter((o) => o.hit.PA >= MIN_N);
  const params = fitHitForm(form, test);
  return evalMetrics(test.map((o) => predictHitForm(params, o)), test.map(actualHitWoba), test.map((o) => HITTER.weight(o)), true, 26).pearson;
}

function block(label: string, form: HitForm, trainObs: TrainObs[], testObs: TrainObs[]) {
  const raw = transfer(form, trainObs, testObs, "allPA", "H0");
  console.log(`\n== ${label} ==  (raw=${raw.toFixed(4)}, ceiling=${ceiling(form, testObs).toFixed(4)})`);
  console.log(`  pool-def   add(H1)   H2(z)     mult`);
  for (const def of ["allPA", "top25", "top50"] as Def[]) {
    const add = transfer(form, trainObs, testObs, def, "add");
    const h2 = transfer(form, trainObs, testObs, def, "H2");
    const mult = transfer(form, trainObs, testObs, def, "mult");
    console.log(`  ${def.padEnd(8)}  ${add.toFixed(4)}   ${h2.toFixed(4)}   ${mult.toFixed(4)}`);
  }
}

console.log(`pool-scale — hitters, OLD=2032-33 vs NEW=2038-39, minN=${MIN_N}; per-side means; weighted Pearson`);
for (const [ml, form] of [["log", LOG_HIT], ["rawpoly(#2)", RAWPOLY_HIT]] as [string, HitForm][]) {
  block(`${ml}  OLD→NEW (extrapolate up)`, form, OLD, NEW);
  block(`${ml}  NEW→OLD (extrapolate down)`, form, NEW, OLD);
}
