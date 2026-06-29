// THROWAWAY — quantify the out-of-distribution gap. The model is fit on a narrow
// elite slice (the training cards). Tournaments must score the WHOLE catalog,
// including low-rated cards CAP formats force into play. This shows, per rating,
// how far BELOW the training envelope the deployable catalog extends = exactly the
// range where the model is extrapolating with no data to validate it.

import Papa from "papaparse";
import { readFileSync, existsSync } from "node:fs";
import { loadWindow, availableYears, type TrainObs } from "../src/training/loader.ts";
import { defaultWindow } from "../src/training/evaluate.ts";

const ROOT = ["League Files", "Model 2037 and 2038"].find(existsSync)!;
const WINDOW = ROOT === "League Files" ? defaultWindow(availableYears(ROOT)) : [2037, 2038];
const { observations } = loadWindow(ROOT, WINDOW);
const hitObs = observations.filter((o) => o.hit.PA >= 1000);
const pitObs = observations.filter((o) => o.pitch.BF >= 1000);
const cards = (Papa.parse(readFileSync("docs/pt_card_list.csv", "utf8"), { header: true, skipEmptyLines: true }).data as any[]).filter((c) => c["Card ID"]);
const num = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : NaN; };

const pctl = (arr: number[], p: number) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]!; };
const stat = (arr: number[]) => ({ n: arr.length, min: Math.min(...arr), p5: pctl(arr, 0.05), med: pctl(arr, 0.5), p95: pctl(arr, 0.95), max: Math.max(...arr) });

// (rating label, training extractor, catalog vR/vL column)
type Spec = { name: string; tr: (o: TrainObs) => number; cols: [string, string] };
const HIT: Spec[] = [
  { name: "POW  ", tr: (o) => o.ratings.hit.pow, cols: ["Power vR", "Power vL"] },
  { name: "EYE  ", tr: (o) => o.ratings.hit.eye, cols: ["Eye vR", "Eye vL"] },
  { name: "K    ", tr: (o) => o.ratings.hit.kRat, cols: ["Avoid K vR", "Avoid K vL"] },
  { name: "BABIP", tr: (o) => o.ratings.hit.babip, cols: ["BABIP vR", "BABIP vL"] },
  { name: "GAP  ", tr: (o) => o.ratings.hit.gap, cols: ["Gap vR", "Gap vL"] },
];
const PIT: Spec[] = [
  { name: "STU  ", tr: (o) => o.ratings.pitch.stu, cols: ["Stuff vR", "Stuff vL"] },
  { name: "CON  ", tr: (o) => o.ratings.pitch.con, cols: ["Control vR", "Control vL"] },
  { name: "PBABIP", tr: (o) => o.ratings.pitch.pbabip, cols: ["pBABIP vR", "pBABIP vL"] },
  { name: "HRR  ", tr: (o) => o.ratings.pitch.hrr, cols: ["pHR vR", "pHR vL"] },
];

function report(title: string, obs: TrainObs[], specs: Spec[]) {
  console.log(`\n=== ${title} — training envelope vs catalog (per rating) ===`);
  console.log(`rating |  train: min   p5  med  p95  max  (n) |  catalog: min   p5  med  p95  max  (n) | %cat<trainMin  %cat<trainP5`);
  for (const s of specs) {
    const tr = obs.map(s.tr).filter((x) => x > 0 && Number.isFinite(x));
    const cat = cards.flatMap((c) => s.cols.map((col) => num(c[col]))).filter((x) => x > 0 && Number.isFinite(x));
    const t = stat(tr), c = stat(cat);
    const belowMin = (cat.filter((x) => x < t.min).length / cat.length) * 100;
    const belowP5 = (cat.filter((x) => x < t.p5).length / cat.length) * 100;
    const r = (x: number) => String(Math.round(x)).padStart(4);
    console.log(`${s.name} | ${r(t.min)} ${r(t.p5)} ${r(t.med)} ${r(t.p95)} ${r(t.max)} (${String(t.n).padStart(4)}) | ${r(c.min)} ${r(c.p5)} ${r(c.med)} ${r(c.p95)} ${r(c.max)} (${String(c.n).padStart(5)}) | ${belowMin.toFixed(1).padStart(6)}%      ${belowP5.toFixed(1).padStart(6)}%`);
  }
}

console.log(`window ${WINDOW.join("+")} (${ROOT}); catalog ${cards.length} cards (×2 sides)`);
report("HITTING", hitObs, HIT);
report("PITCHING", pitObs, PIT);
console.log(`\n%cat<trainMin = share of catalog card-sides BELOW the lowest rating the model ever saw = pure extrapolation.`);
