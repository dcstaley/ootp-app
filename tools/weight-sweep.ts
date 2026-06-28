// DIAGNOSTIC (throwaway) — answers "is PA^0.75 the right FIT weight?". Sweeps the
// fit-weight exponent α while holding the EVAL weight fixed at PA^0.75 (the two are
// conceptually distinct: fit weight = statistical efficiency; eval weight = decision
// value). Reports 5-fold CV Pearson + value-regret per (form, role, α). Inverse-
// variance theory says the efficient exponent ≈ 1.0; 0.75 is a robustness compromise
// — this shows empirically where the data actually wants it. GLM/seqcond forms are
// excluded (they don't use this weight — exposure/binomial weighting is built in).
//
// Run: node tools/weight-sweep.ts   (Node type-strips .ts directly)

import { existsSync } from "node:fs";
import { loadWindow, availableYears, type TrainObs } from "../src/training/loader.ts";
import { foldOf } from "../src/training/evaluate.ts";
import { evalMetrics } from "../src/training/metrics.ts";
import { HITTER, PITCHER, type RoleSpec } from "../src/training/bakeoff.ts";
import { LOG_HIT, RAWPOLY_HIT, LOG_PIT, RAWPOLY_PIT, fitHitForm, predictHitForm, fitPitForm, predictPitForm, type HitForm, type PitForm } from "../src/training/forms.ts";

const DIR = [process.env.TRAINING_DIR, "League Files", "Model 2037 and 2038"].find((d) => d && existsSync(d))!;
const years = availableYears(DIR);
const window = years.slice(-2); // match the scoreboard default (recent 2yr)
const obs = loadWindow(DIR, window).observations;
const ALPHAS = [0, 0.25, 0.5, 0.75, 1.0, 1.25];
const MIN_N = 1000, K = 5, TOPN = 26;

/** 5-fold CV with a custom FIT-weight exponent; EVAL weight stays spec.weight (0.75). */
function cvHit(form: HitForm, alpha: number) {
  const qual = obs.filter((o) => HITTER.qualifies(o, MIN_N));
  const pred: number[] = [], actual: number[] = [], weight: number[] = [];
  for (let f = 0; f < K; f++) {
    const test = qual.filter((o) => foldOf(o.key, K) === f), train = qual.filter((o) => foldOf(o.key, K) !== f);
    if (!test.length || train.length < 10) continue;
    const params = fitHitForm(form, train, alpha);
    test.forEach((o) => { pred.push(predictHitForm(params, o)); actual.push(HITTER.actualWoba(o)); weight.push(HITTER.weight(o)); });
  }
  return evalMetrics(pred, actual, weight, HITTER.higherBetter, TOPN);
}
function cvPit(form: PitForm, alpha: number) {
  const qual = obs.filter((o) => PITCHER.qualifies(o, MIN_N));
  const pred: number[] = [], actual: number[] = [], weight: number[] = [];
  for (let f = 0; f < K; f++) {
    const test = qual.filter((o) => foldOf(o.key, K) === f), train = qual.filter((o) => foldOf(o.key, K) !== f);
    if (!test.length || train.length < 10) continue;
    const params = fitPitForm(form, train, alpha);
    test.forEach((o) => { pred.push(predictPitForm(params, o)); actual.push(PITCHER.actualWoba(o)); weight.push(PITCHER.weight(o)); });
  }
  return evalMetrics(pred, actual, weight, PITCHER.higherBetter, TOPN);
}

console.log(`weight-sweep — dir="${DIR}" window=${window.join("+")} | CV ${K}-fold, minN=${MIN_N}, eval weight fixed at PA^0.75`);
console.log(`(α = FIT-weight exponent; reporting CV Pearson / value-regret pts)\n`);
const rows: { role: string; form: string; alpha: number; pearson: number; regret: number }[] = [];
for (const [label, form] of [["woba", LOG_HIT], ["rawpoly", RAWPOLY_HIT]] as [string, HitForm][])
  for (const a of ALPHAS) { const m = cvHit(form, a); rows.push({ role: "hitter", form: label, alpha: a, pearson: m.pearson, regret: m.valueRegret * 1000 }); }
for (const [label, form] of [["woba", LOG_PIT], ["rawpoly", RAWPOLY_PIT]] as [string, PitForm][])
  for (const a of ALPHAS) { const m = cvPit(form, a); rows.push({ role: "pitcher", form: label, alpha: a, pearson: m.pearson, regret: m.valueRegret * 1000 }); }

for (const role of ["hitter", "pitcher"]) for (const form of ["woba", "rawpoly"]) {
  console.log(`== ${role} · ${form} ==`);
  const sub = rows.filter((r) => r.role === role && r.form === form);
  const bestP = Math.max(...sub.map((r) => r.pearson));
  for (const r of sub) console.log(`  α=${r.alpha.toFixed(2)}  Pearson=${r.pearson.toFixed(4)}${r.pearson === bestP ? " ◀ best" : ""}  regret=${r.regret.toFixed(1)}`);
  console.log("");
}
