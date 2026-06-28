// DIAGNOSTIC — multiplicative scaling + top-X pool definition, on the real OLD<->NEW
// transfer (hitters). Redo of the rating re-scaling with the corrections from review:
//   • scaling mode: "mult" = r * (trainMean/testMean) per skill (multiplicative,
//     compresses/expands gaps; clean additive shift in the model's ln space) — vs
//     "add" = the old additive H1 (trainMean + (r - testMean)) for comparison, vs H0 raw.
//   • pool average defined three ways, PER PLATOON SIDE (vL/vR separately):
//       allPA = PA^0.75-weighted over all qualifiers (the old default)
//       top25 = mean ratings of the top 25 hitters by actual wOBA (the fielded elite)
//       top50 = top 50
// Fit on train pool, predict test pool, report weighted Pearson vs the in-sample ceiling.
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

type Def = "allPA" | "top25" | "top50";
type Means = Record<Side, Record<string, number>>;
function buildMeans(obs: TrainObs[], def: Def): Means {
  const out = { L: {}, R: {} } as Means;
  for (const side of ["L", "R"] as Side[]) {
    const pool = obs.filter((o) => o.side === side && o.hit.PA >= MIN_N);
    for (const s of SK) {
      if (def === "allPA") {
        const w = pool.map((o) => Math.pow(o.hit.PA, 0.75));
        out[side][s] = pool.reduce((a, o, i) => a + w[i]! * getR(o, s), 0) / w.reduce((a, x) => a + x, 0);
      } else {
        const n = def === "top25" ? 25 : 50;
        const top = [...pool].sort((a, b) => actualHitWoba(b) - actualHitWoba(a)).slice(0, n);
        out[side][s] = top.reduce((a, o) => a + getR(o, s), 0) / top.length;
      }
    }
  }
  return out;
}

type Mode = "H0" | "add" | "mult";
function adjust(o: TrainObs, mode: Mode, trM: Means, teM: Means): TrainObs {
  const h = { ...o.ratings.hit } as unknown as Record<string, number>;
  for (const s of SK) {
    const tr = trM[o.side][s]!, te = teM[o.side][s]!, r = getR(o, s);
    h[s] = mode === "H0" ? r : mode === "add" ? tr + (r - te) : r * (tr / te);
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
  console.log(`\n== ${label} ==  (ceiling=${ceiling(form, testObs).toFixed(4)})`);
  console.log(`  pool-def   H0 raw    add(H1)   mult`);
  for (const def of ["allPA", "top25", "top50"] as Def[]) {
    const h0 = transfer(form, trainObs, testObs, def, "H0"); // H0 ignores def, shown once per row for reference
    const add = transfer(form, trainObs, testObs, def, "add");
    const mult = transfer(form, trainObs, testObs, def, "mult");
    console.log(`  ${def.padEnd(8)}  ${h0.toFixed(4)}   ${add.toFixed(4)}   ${mult.toFixed(4)}`);
  }
}

console.log(`pool-scale — hitters, OLD=2032-33 vs NEW=2038-39, minN=${MIN_N}; per-side means; weighted Pearson`);
for (const [ml, form] of [["log", LOG_HIT], ["rawpoly(#2)", RAWPOLY_HIT]] as [string, HitForm][]) {
  block(`${ml}  OLD→NEW (extrapolate up)`, form, OLD, NEW);
  block(`${ml}  NEW→OLD (extrapolate down)`, form, NEW, OLD);
}
