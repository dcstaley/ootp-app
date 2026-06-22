// M4 — build the dual-platoon lineup MILP as a CPLEX LP string. Decision vars
// (keyed by candidate INDEX so base/variant rows sharing a Card ID never collide):
//   r_<i>            ∈{0,1}  candidate i is a rostered hitter
//   y_<i>_<pos>_v<S> ∈{0,1}  candidate i plays <pos> in side S's lineup (S∈L,R)
// Objective: platoon-weighted lineup value + a small bench weight on roster
// membership (so the non-starting roster slots fill with the next-best hitters
// rather than being left arbitrary). Constraints:
//   • each lineup position filled exactly once, per side
//   • a candidate plays ≤1 position per side, and only if rostered
//   • roster size = nHitters
//   • coverage depth: ≥ backupCatcherDepth rostered candidates can play C
//
// Starters-first cap/slots budgets (D5) layer on in a later phase; this is the
// non-cap structural core.

import type { HitterCandidate, HitterOptimizeOptions } from "./types.ts";
import { lineupPositions } from "./types.ts";

export interface BuiltLp { lp: string; vars: number; constraints: number }

const f6 = (x: number) => x.toFixed(6);

export function buildHitterLp(cands: HitterCandidate[], opts: HitterOptimizeOptions): BuiltLp {
  const positions = lineupPositions(opts.dh);
  const benchW = opts.benchWeight ?? 0.1;
  const depth = opts.backupCatcherDepth ?? 2;

  const obj: string[] = [];
  const yVars: string[] = [];
  const rVars = cands.map((_, i) => `r_${i}`);
  const perCardSide: Record<string, string[]> = {};
  const perPosSide: Record<string, string[]> = {};

  cands.forEach((c, i) => {
    for (const side of ["L", "R"] as const) {
      const w = side === "R" ? opts.platoonVR : opts.platoonVL;
      const val = side === "R" ? c.valueVR : c.valueVL;
      for (const p of c.positions) {
        if (!positions.includes(p)) continue;
        const y = `y_${i}_${p}_v${side}`;
        yVars.push(y);
        obj.push(`${f6(w * val)} ${y}`);
        (perCardSide[`${i}|${side}`] ??= []).push(y);
        (perPosSide[`${p}|${side}`] ??= []).push(y);
      }
    }
    // Bench weight: reward rostering high-value hitters (best of the two sides).
    obj.push(`${f6(benchW * Math.max(c.valueVR, c.valueVL))} r_${i}`);
  });

  const cons: string[] = [];
  for (const side of ["L", "R"]) for (const p of positions) {
    const t = perPosSide[`${p}|${side}`];
    if (t?.length) cons.push(` fill_${p}_v${side}: ${t.join(" + ")} = 1`);
  }
  cands.forEach((_, i) => {
    for (const side of ["L", "R"]) {
      const t = perCardSide[`${i}|${side}`];
      if (t?.length) cons.push(` one_${i}_v${side}: ${t.join(" + ")} - r_${i} <= 0`);
    }
  });
  cons.push(` rsize: ${rVars.join(" + ")} = ${opts.nHitters}`);
  const catchers = cands.map((c, i) => ({ c, i })).filter((x) => x.c.positions.includes("C")).map((x) => `r_${x.i}`);
  if (catchers.length >= depth) cons.push(` backupC: ${catchers.join(" + ")} >= ${depth}`);

  const lp = [
    "Maximize", ` obj: ${obj.join(" + ")}`,
    "Subject To", ...cons,
    "Binaries", ` ${[...yVars, ...rVars].join(" ")}`,
    "End",
  ].join("\n");
  return { lp, vars: yVars.length + rVars.length, constraints: cons.length };
}
