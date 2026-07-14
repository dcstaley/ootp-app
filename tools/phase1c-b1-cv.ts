// VERIFICATION DEBT B.1 — league CV + out-of-time (BOTH directions) for the pitcher form winner
// rawquad-all+aux, vs the deployed StuffAug and the aux-OFF rawquad. The ORIGINAL M6 bake-off
// REJECTED quad-everything; quad over-fit is exactly what CV/OOT catches, and the in-frame spread
// metric is CIRCULAR for a spread-adding form — so ordering fidelity (Pearson/Spearman/valueRegret)
// out of sample is the honest test. If OOT degrades vs deployed, the winner is NOT the winner.
//   OOT down = train recent 41-42 → test distant 32-33 (extrapolate DOWN to weaker pool = the
//   tournament-like stress, and where a runaway quad tail bites). OOT up = the reverse.
//   run: node tools/phase1c-b1-cv.ts
import { existsSync } from "node:fs";
import { loadWindow, availableYears, type TrainObs } from "../src/training/loader.ts";
import { inSample, crossValidate, outOfTime } from "../src/training/evaluate.ts";
import { HITTER, PITCHER } from "../src/training/bakeoff.ts";
import { pitFormModel, hitFormModel, gatePit, STUFFAUG_PIT, RAWQUAD_PIT, RAWPOLY_HIT, type PitForm } from "../src/training/forms.ts";
import type { EvalMetrics } from "../src/training/metrics.ts";

const R2 = { kind: "rawpoly", degree: 2 } as const;
const ROOT = "League Files";
const MINN = 1000, K = 5, TOPN = 26;
const years = availableYears(ROOT);
const winY = [2041, 2042];          // the active model's window
const oldY = [2032, 2033];          // distant-past block (extrapolate DOWN — weak-pool / tournament-like)
const winObs = loadWindow(ROOT, winY).observations;
const oldObs = existsSync(ROOT) && oldY.every((y) => years.includes(y)) ? loadWindow(ROOT, oldY).observations : [];

const WINNER: PitForm = { name: "rawquad+aux (WINNER)", bb: R2, k: R2, hr: R2, h: R2, stuffAug: true };
const pitForms: PitForm[] = [STUFFAUG_PIT, { ...RAWQUAD_PIT, name: "rawquad (aux OFF)" }, WINNER];

const f = (n: number) => (Number.isFinite(n) ? n.toFixed(4) : "n/a");
const line = (label: string, m: EvalMetrics) =>
  `  ${label.padEnd(26)} r=${f(m.pearson)}  ρ=${f(m.spearman)}  regret=${f(m.valueRegret)}  gapRmse=${f(m.gapRmse)}  n=${m.n}`;

console.log(`B.1 CV/OOT — pitcher form winner vs deployed. window=${winY.join("+")}, OOT-down→${oldY.join("+")}, k=${K}, minPA=${MINN}\n`);
console.log(`Read: WINNER must not degrade vs deployed on CV or OOT (esp. OOT-down = the weak-pool / quad-tail stress).`);
console.log(`A large in-sample→CV gap or an OOT r/ρ/regret regression = quad over-fit → the winner is not the winner.\n`);

for (const form of pitForms) {
  const model = pitFormModel(form);
  console.log(`PIT · ${form.name}`);
  console.log(line("in-sample (41-42)", inSample(winObs, model, PITCHER, { minN: MINN, topN: TOPN })));
  console.log(line("cv 5-fold (41-42)", crossValidate(winObs, model, PITCHER, { minN: MINN, topN: TOPN, k: K })));
  if (oldObs.length) {
    console.log(line("OOT-down 41-42→32-33", outOfTime(winObs, oldObs, model, PITCHER, { minN: MINN, topN: TOPN })));
    console.log(line("OOT-up   32-33→41-42", outOfTime(oldObs, winObs, model, PITCHER, { minN: MINN, topN: TOPN })));
  }
  const g = gatePit(model.fit(winObs.filter((o: TrainObs) => PITCHER.qualifies(o, MINN)), []) as any, winObs.filter((o: TrainObs) => PITCHER.qualifies(o, MINN)));
  console.log(`  gate(41-42): ${g.status}${g.notes.length ? " — " + g.notes.join("; ") : ""}\n`);
}

// Hitter control (RAWPOLY_HIT is deployed; confirm it is untouched by this exercise).
{
  const model = hitFormModel(RAWPOLY_HIT);
  console.log(`HIT · ${RAWPOLY_HIT.name} (deployed control)`);
  console.log(line("in-sample (41-42)", inSample(winObs, model, HITTER, { minN: MINN, topN: TOPN })));
  console.log(line("cv 5-fold (41-42)", crossValidate(winObs, model, HITTER, { minN: MINN, topN: TOPN, k: K })));
  if (oldObs.length) {
    console.log(line("OOT-down 41-42→32-33", outOfTime(winObs, oldObs, model, HITTER, { minN: MINN, topN: TOPN })));
    console.log(line("OOT-up   32-33→41-42", outOfTime(oldObs, winObs, model, HITTER, { minN: MINN, topN: TOPN })));
  }
}
process.exit(0);
