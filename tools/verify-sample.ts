// Verify the rebuilt core against ACTUAL numbers copied from the live old app's
// Roster & Lineup page (the ground truth). Prints app value vs rebuilt value vs
// diff for each sample, at the app's display rounding.

import { readFileSync } from "node:fs";
import Papa from "papaparse";
import { scoreCard, computeDerived, type Coeffs, type CalScales } from "../src/scoring-core/index.ts";

const cards = Papa.parse(readFileSync("docs/pt_card_list.csv", "utf8"), { header: true, skipEmptyLines: true }).data as any[];

function cfg(name: string) {
  const c = JSON.parse(readFileSync(`fixtures/captures/${name}.json`, "utf8")) as { coeffs: Coeffs; calScales: CalScales | null };
  return { coeffs: c.coeffs, derived: computeDerived(c.coeffs), calScales: c.calScales };
}
const find = (title: string) => cards.find((c) => c["//Card Title"] === title);

interface Sample { title: string; vL: number; vR: number }

function check(label: string, capture: string, metric: "woba" | "basic", samples: Sample[], dp: number) {
  const config = cfg(capture);
  console.log(`\n=== ${label} (capture: ${capture}, hitting metric: ${metric}) ===`);
  console.log("  card".padEnd(54) + "side  app        rebuilt     diff");
  let worst = 0;
  for (const s of samples) {
    const card = find(s.title);
    if (!card) { console.log(`  !! NOT FOUND: ${s.title}`); continue; }
    const sc = scoreCard(card, config);
    for (const side of ["vL", "vR"] as const) {
      const appVal = side === "vL" ? s.vL : s.vR;
      const mine = metric === "woba" ? (side === "vL" ? sc.hit.offense_vL : sc.hit.offense_vR)
                                     : (side === "vL" ? sc.hit.basic_vL : sc.hit.basic_vR);
      const rounded = Number(mine.toFixed(dp));
      const diff = Math.abs(rounded - appVal);
      worst = Math.max(worst, diff);
      console.log(`  ${s.title.slice(0, 50).padEnd(52)}${side}  ${appVal.toFixed(dp).padEnd(10)} ${rounded.toFixed(dp).padEnd(11)} ${diff.toExponential(2)}`);
    }
  }
  console.log(`  worst diff at ${dp}dp: ${worst.toExponential(3)}  ${worst === 0 ? "✅ EXACT MATCH" : worst < Math.pow(10, -dp) / 2 ? "✅ matches at display precision" : "❌"}`);
}

function checkPitch(label: string, capture: string, metric: "woba" | "basic", samples: Array<{ title: string; score: number }>, dp: number) {
  const config = cfg(capture);
  console.log(`\n=== ${label} (capture: ${capture}, pitching metric: ${metric}) ===`);
  console.log("  card".padEnd(54) + "app        ovr        vR         vL        match");
  let worst = Infinity;
  for (const s of samples) {
    const card = find(s.title);
    if (!card) { console.log(`  !! NOT FOUND: ${s.title}`); continue; }
    const p = scoreCard(card, config).pitch;
    const [ovr, vR, vL] = metric === "woba"
      ? [p.woba_ovr, p.woba_vR, p.woba_vL]
      : [p.basic_ovr, p.basic_vR, p.basic_vL];
    const best = Math.min(...[ovr, vR, vL].map((v) => Math.abs(Number(v.toFixed(dp)) - s.score)));
    worst = Math.min(worst, best); // track best-matching mode's residual
    const which = best === Math.abs(Number(ovr.toFixed(dp)) - s.score) ? "OVR" : best === Math.abs(Number(vR.toFixed(dp)) - s.score) ? "vR" : "vL";
    console.log(`  ${s.title.slice(0, 50).padEnd(52)}${s.score.toFixed(dp).padEnd(11)}${ovr.toFixed(dp).padEnd(11)}${vR.toFixed(dp).padEnd(11)}${vL.toFixed(dp).padEnd(10)} ${which}${best === 0 ? " ✅" : ""}`);
  }
}

// Run 1 — wOBA metric (real-parkera capture), values copied from the live app
check("RUN 1 — wOBA hitting", "real-parkera", "woba", [
  { title: "PTCS 3 - Hardware Heroes 1B Prince Fielder DET 2013", vL: 0.3426, vR: 0.3421 },
  { title: "PTCS 1 - Future Legend 2B Travis Bazzana CLE 2026", vL: 0.3311, vR: 0.3402 },
  { title: "PTCS 3 - Veteran Presence 2B Rogers Hornsby CHC 1931", vL: 0.3385, vR: 0.3293 },
], 4);

// Run 2 — basic metric (real-parkera-basic capture), values copied from the live app
check("RUN 2 — basic hitting", "real-parkera-basic", "basic", [
  { title: "PTCS 3 - Hardware Heroes 1B Prince Fielder DET 2013", vL: 102.794, vR: 101.676 },
  { title: "PTCS 1 - Future Legend 2B Travis Bazzana CLE 2026", vL: 101.989, vR: 101.735 },
  { title: "Family Connections - Historical All-Star CF Ken Griffey Jr. SEA 1991", vL: 99.721, vR: 100.987 },
], 3);

// Run 2 — basic PITCHING (real-parkera-basic capture), values copied from the live app
checkPitch("RUN 2 — basic pitching", "real-parkera-basic", "basic", [
  { title: "Electric No-Hitter SP Dock Ellis PIT 1970", score: 102.284 },
  { title: "Limited Edition/107 SP Steve Trout CHC 1985", score: 98.748 },
  { title: "Clubhouse - April Fools' Day SP Bob Miller LAD 1963", score: 99.286 },
], 3);
