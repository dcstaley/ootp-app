// DIAGNOSTIC (pool-adjustment step 0) — does pool drift actually exist, and how big?
// Characterizes each YEAR's rating distribution per skill (PA/BF-weighted mean ± sd,
// plus the max = the envelope the extrapolation gate worries about). If the means
// drift materially year-over-year, the forward/backward OOT splits are training and
// testing on different-talent pools — confirming pool adjustment is needed and that
// raw forward/backward numbers are confounded. Ratings only (inputs) → leak-free.
//
// Run: node tools/pool-drift.ts

import { existsSync } from "node:fs";
import { loadWindow, availableYears, type TrainObs } from "../src/training/loader.ts";

const DIR = [process.env.TRAINING_DIR, "League Files", "Model 2037 and 2038"].find((d) => d && existsSync(d))!;
const years = availableYears(DIR);

const wStats = (vals: number[], w: number[]) => {
  const W = w.reduce((s, x) => s + x, 0);
  const mean = vals.reduce((s, v, i) => s + w[i]! * v, 0) / W;
  const sd = Math.sqrt(vals.reduce((s, v, i) => s + w[i]! * (v - mean) ** 2, 0) / W);
  return { mean, sd, max: Math.max(...vals), n: vals.length };
};

const HIT: [string, (o: TrainObs) => number][] = [
  ["POW", (o) => o.ratings.hit.pow], ["GAP", (o) => o.ratings.hit.gap], ["EYE", (o) => o.ratings.hit.eye],
  ["K", (o) => o.ratings.hit.kRat], ["BABIP", (o) => o.ratings.hit.babip],
];
const PIT: [string, (o: TrainObs) => number][] = [
  ["STU", (o) => o.ratings.pitch.stu], ["CON", (o) => o.ratings.pitch.con], ["HRR", (o) => o.ratings.pitch.hrr], ["PBABIP", (o) => o.ratings.pitch.pbabip],
];

const byYear = years.map((y) => ({ y, obs: loadWindow(DIR, [y]).observations }));

function report(title: string, skills: typeof HIT, qual: (o: TrainObs) => boolean, wt: (o: TrainObs) => number) {
  console.log(`\n== ${title} ==  (PA/BF-weighted mean ± sd  [max];  drift = last − first year mean)`);
  for (const [name, get] of skills) {
    const cells = byYear.map(({ obs }) => { const q = obs.filter(qual); return wStats(q.map(get), q.map(wt)); });
    const line = byYear.map(({ y }, i) => `${y}: ${cells[i]!.mean.toFixed(1)}±${cells[i]!.sd.toFixed(1)} [${cells[i]!.max.toFixed(0)}]`).join("   ");
    const drift = cells[cells.length - 1]!.mean - cells[0]!.mean;
    const driftSd = drift / cells[0]!.sd; // drift in pooled-sd units
    console.log(`  ${name.padEnd(7)} ${line}   Δmean=${drift >= 0 ? "+" : ""}${drift.toFixed(1)} (${driftSd >= 0 ? "+" : ""}${driftSd.toFixed(2)}σ)`);
  }
  const ns = byYear.map(({ obs }) => obs.filter(qual).length);
  console.log(`  (n per year: ${byYear.map(({ y }, i) => `${y}=${ns[i]}`).join(", ")})`);
}

console.log(`pool-drift — dir="${DIR}" years=${years.join(",")} | qualifying = PA/BF ≥ 100`);
report("HITTERS", HIT, (o) => o.hit.PA >= 100, (o) => o.hit.PA);
report("PITCHERS", PIT, (o) => o.pitch.BF >= 100, (o) => o.pitch.BF);
