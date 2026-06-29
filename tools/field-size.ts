// THROWAWAY diagnostic — at what usage bar does each category cross N cards?
// NO VARIANTS (base cards only). PA/BF = aggregate usage across the playerbase.
// Window = 2039-2040, ALL leagues. For each of the 4 categories (hit vL/vR,
// pit vL/vR) it reports the usage value of the Nth-ranked card — i.e. "at this
// bar you have exactly N cards." So the rank-50 column = where we cross 50 players.

import { existsSync } from "node:fs";
import { loadWindow, type TrainObs } from "../src/training/loader.ts";

const ROOT = ["League Files", "Model 2037 and 2038"].find((d) => existsSync(d))!;
const WINDOW = [2039, 2040];
const RANKS = [25, 50, 75, 100];

const { observations, summary } = loadWindow(ROOT, WINDOW);
const base = observations.filter((o) => !o.variant); // strictly no variants
const L = base.filter((o) => o.side === "L"), R = base.filter((o) => o.side === "R");

function atRanks(arr: TrainObs[], stat: (o: TrainObs) => number): number[] {
  const sorted = arr.map(stat).filter((x) => x > 0).sort((a, b) => b - a);
  return RANKS.map((n) => sorted[n - 1] ?? 0); // usage of the Nth card (0 if fewer than N exist)
}
const fmt = (xs: number[]) => xs.map((x) => Math.round(x).toLocaleString().padStart(9)).join(" ");

console.log(`window=${WINDOW.join("+")}; leagues=[${summary.leagues.join(", ")}]; NO VARIANTS (base only): ${L.length} vL / ${R.length} vR cards`);
console.log(`\nUsage of the Nth-ranked card (= the bar at which that category has exactly N cards):`);
console.log(`category     | rank:  ${RANKS.map((n) => String(n).padStart(9)).join(" ")}`);
console.log(`hit  vL (PA) |        ${fmt(atRanks(L, (o) => o.hit.PA))}`);
console.log(`hit  vR (PA) |        ${fmt(atRanks(R, (o) => o.hit.PA))}`);
console.log(`pit  vL (BF) |        ${fmt(atRanks(L, (o) => o.pitch.BF))}`);
console.log(`pit  vR (BF) |        ${fmt(atRanks(R, (o) => o.pitch.BF))}`);
console.log(`\nThe rank-50 column = the PA/BF bar where each category crosses 50 cards.`);
