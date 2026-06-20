// Dev spot-check: print the rebuilt core's trusted scores for recognizable
// cards so they can be eyeballed against the live old app's Roster & Lineup page.
// Usage: node tools/spot-check.ts [captureName]   (default real-neutral)

import { readFileSync } from "node:fs";
import Papa from "papaparse";
import { scoreCard, computeDerived, type Coeffs, type CalScales } from "../src/scoring-core/index.ts";

const captureName = process.argv[2] ?? "real-neutral";
const capture = JSON.parse(readFileSync(`fixtures/captures/${captureName}.json`, "utf8")) as {
  coeffs: Coeffs; calScales: CalScales | null;
};
const cards = Papa.parse(readFileSync("docs/pt_card_list.csv", "utf8"), { header: true, skipEmptyLines: true }).data as any[];
const config = { coeffs: capture.coeffs, derived: computeDerived(capture.coeffs), calScales: capture.calScales };

const scored = cards.map((c) => ({ card: c, s: scoreCard(c, config) }));
const f = (x: number) => x.toFixed(4);

console.log(`\nCapture: ${captureName}   (hitting wOBA higher = better; pitching wOBA lower = better)\n`);

console.log("TOP 10 HITTERS by wOBA vR");
console.log("  " + "card".padEnd(52) + "  vL      vR");
scored
  .filter((x) => x.s.hit.woba_vR > 0)
  .sort((a, b) => b.s.hit.woba_vR - a.s.hit.woba_vR)
  .slice(0, 10)
  .forEach((x) => console.log("  " + String(x.card["//Card Title"]).padEnd(52) + `  ${f(x.s.hit.woba_vL)}  ${f(x.s.hit.woba_vR)}`));

console.log("\nTOP 10 PITCHERS by wOBA OVR (lowest allowed)");
console.log("  " + "card".padEnd(52) + "  OVR     vR      vL");
scored
  .filter((x) => Number(x.card["Throws"]) > 0 && x.s.pitch.woba_ovr > 0)
  .sort((a, b) => a.s.pitch.woba_ovr - b.s.pitch.woba_ovr)
  .slice(0, 10)
  .forEach((x) => console.log("  " + String(x.card["//Card Title"]).padEnd(52) + `  ${f(x.s.pitch.woba_ovr)}  ${f(x.s.pitch.woba_vR)}  ${f(x.s.pitch.woba_vL)}`));
