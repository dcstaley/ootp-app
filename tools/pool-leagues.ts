// DIAGNOSTIC (pool-adjustment step 0b) — are the LEAGUES different talent tiers?
// Year drift is tiny (see pool-drift), so years can't give us the pool-strength
// contrast needed to study/calibrate pool adjustment. The trainer SUMS outcomes
// across leagues (PEL, HD 450/451/452/453); if those leagues are actually different
// talent tiers, THEY are the cross-pool variation we need (and summing over them is
// itself worth questioning). Characterize each league's rating distribution per skill
// (PA/BF-weighted). Ratings only → leak-free.
//
// Run: node tools/pool-leagues.ts

import { existsSync } from "node:fs";
import { loadWindow, availableYears, type TrainObs } from "../src/training/loader.ts";

const DIR = [process.env.TRAINING_DIR, "League Files", "Model 2037 and 2038"].find((d) => d && existsSync(d))!;
const obs = loadWindow(DIR, availableYears(DIR)).observations;

// PA/BF in a given league = sum of that league's per-(league,year) source exposures.
const paIn = (o: TrainObs, lg: string) => o.sources.filter((s) => s.league === lg).reduce((a, s) => a + s.pa, 0);
const bfIn = (o: TrainObs, lg: string) => o.sources.filter((s) => s.league === lg).reduce((a, s) => a + s.bf, 0);
const leagues = [...new Set(obs.flatMap((o) => o.sources.map((s) => s.league)))].sort();

const wStats = (vals: number[], w: number[]) => {
  const W = w.reduce((s, x) => s + x, 0) || 1;
  const mean = vals.reduce((s, v, i) => s + w[i]! * v, 0) / W;
  const sd = Math.sqrt(vals.reduce((s, v, i) => s + w[i]! * (v - mean) ** 2, 0) / W);
  return { mean, sd, W };
};

const HIT: [string, (o: TrainObs) => number][] = [["POW", (o) => o.ratings.hit.pow], ["EYE", (o) => o.ratings.hit.eye], ["K", (o) => o.ratings.hit.kRat], ["BABIP", (o) => o.ratings.hit.babip]];
const PIT: [string, (o: TrainObs) => number][] = [["STU", (o) => o.ratings.pitch.stu], ["CON", (o) => o.ratings.pitch.con], ["HRR", (o) => o.ratings.pitch.hrr], ["PBABIP", (o) => o.ratings.pitch.pbabip]];

function report(title: string, skills: typeof HIT, expo: (o: TrainObs, lg: string) => number) {
  console.log(`\n== ${title} ==  (PA/BF-weighted mean ± sd per league)`);
  for (const [name, get] of skills) {
    const line = leagues.map((lg) => {
      const q = obs.filter((o) => expo(o, lg) > 0);
      const s = wStats(q.map(get), q.map((o) => expo(o, lg)));
      return `${lg}: ${s.mean.toFixed(1)}±${s.sd.toFixed(1)}`;
    }).join("   ");
    console.log(`  ${name.padEnd(7)} ${line}`);
  }
  // total exposure per league (how much data each tier carries)
  console.log(`  exposure: ${leagues.map((lg) => `${lg}=${Math.round(obs.reduce((a, o) => a + expo(o, lg), 0) / 1000)}k`).join(", ")}`);
}

console.log(`pool-leagues — dir="${DIR}" leagues=${leagues.join(",")}`);
report("HITTERS", HIT, paIn);
report("PITCHERS", PIT, bfIn);
