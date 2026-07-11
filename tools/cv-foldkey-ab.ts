// ONE-TIME A/B (T-2): compare the CV fold key three ways on the real training data —
//   current  cid|B/V|side   (base+variant SPLIT across folds, sides split)
//   new      cid|side       (base+variant TOGETHER, sides split)   ← adopted
//   full     cid            (base+variant AND sides together)
// For each candidate model we report CV Pearson + the in-sample→CV gap, and flag any
// model-RANKING flip vs the adopted `cid|side`. Adopt cid|side regardless (decided);
// flag to Derek if full-cid flips a ranking (that would mean vL/vR was distorting
// selection). Deliver the printed table to Derek.
//
//   run: node tools/cv-foldkey-ab.ts

import { existsSync } from "node:fs";
import { loadWindow, availableYears, type TrainObs } from "../src/training/loader.ts";
import { inSample, crossValidate, defaultWindow } from "../src/training/evaluate.ts";
import { BASE_ENTRIES, type BakeoffEntry } from "../src/training/bakeoff.ts";
import { FORM_ENTRIES } from "../src/training/forms.ts";

const ROOT = ["League Files", "Model 2037 and 2038"].find((d) => existsSync(d));
if (!ROOT) { console.error("no training data dir found"); process.exit(1); }

const MINN = 1000, K = 5, TOPN = 26;
const years = availableYears(ROOT);
const window = defaultWindow(years);
const winObs = loadWindow(ROOT, window).observations; // includeVariants = true (always)

const KEYS: { name: string; fk: (o: TrainObs) => string }[] = [
  { name: "current cid|BV|side", fk: (o) => `${o.cid}|${o.variant ? "V" : "B"}|${o.side}` },
  { name: "new     cid|side", fk: (o) => `${o.cid}|${o.side}` },
  { name: "full    cid", fk: (o) => `${o.cid}` },
];

const all: BakeoffEntry[] = [...BASE_ENTRIES, ...FORM_ENTRIES];
const models = [...all.filter((e) => e.spec.role === "hitter"), ...all.filter((e) => e.spec.role === "pitcher")];

console.log(`\nCV fold-key A/B — root=${ROOT}, window=${window.join("+")}, minN=${MINN}, k=${K}\n`);
console.log(`obs in window: ${winObs.length} (hitters ${winObs.filter((o) => o.hit.PA > 0).length}, pitchers ${winObs.filter((o) => o.pitch.BF > 0).length})\n`);

// For each key: rows of {model, role, cvPearson, gap}. Also capture per-role ranking.
interface Row { model: string; role: string; is: number; cv: number; gap: number }
const byKey: Record<string, Row[]> = {};
for (const { name, fk } of KEYS) {
  const rows: Row[] = [];
  for (const { model, spec } of models) {
    const is = inSample(winObs, model, spec, { minN: MINN, topN: TOPN }).pearson;
    const cv = crossValidate(winObs, model, spec, { minN: MINN, topN: TOPN, k: K, foldKey: fk }).pearson;
    rows.push({ model: model.name, role: spec.role, is, cv, gap: +(is - cv).toFixed(4) });
  }
  byKey[name] = rows;
}

// Print per-key CV Pearson + gap.
for (const { name } of KEYS) {
  console.log(`── ${name} ──`);
  for (const r of byKey[name]!) console.log(`  ${r.role.padEnd(7)} ${r.model.padEnd(22)} CV r=${r.cv.toFixed(4)}  in=${r.is.toFixed(4)}  gap=${r.gap.toFixed(4)}`);
  console.log();
}

// Ranking per role (by CV Pearson desc) for each key → detect flips vs adopted cid|side.
const ranking = (rows: Row[], role: string) => rows.filter((r) => r.role === role).sort((a, b) => b.cv - a.cv).map((r) => r.model);
for (const role of ["hitter", "pitcher"]) {
  console.log(`RANKING (${role}, by CV Pearson):`);
  for (const { name } of KEYS) console.log(`  ${name.padEnd(20)} ${ranking(byKey[name]!, role).join(" > ")}`);
  const adopted = ranking(byKey["new     cid|side"]!, role).join(">");
  for (const { name } of KEYS) {
    if (name.startsWith("new")) continue;
    const r = ranking(byKey[name]!, role).join(">");
    console.log(`  ${r === adopted ? "· same order as cid|side" : "⚠ RANKING FLIP vs cid|side"} : ${name}`);
  }
  console.log();
}
process.exit(0);
