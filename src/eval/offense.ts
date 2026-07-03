// Availability-weighted team offense: the fix for "bench = 0 value". Expected offense is NOT
// just the best nine's wRAA — a manager fields the best nine only part of the time and, when a
// starter is unavailable, RE-OPTIMISES the lineup from whoever's left. Modelling that (a
// leave-one-starter-out re-match) values bench DEPTH by how well it cushions absences, and
// handles platoons (partner slides in), multi-position cards (matching reassigns freely), and
// starters shifting to cover — all for free, because re-matching is exactly what a manager does.
//
//   E[offense] = f0 · wRAA(best nine)  +  (1 − f0) · mean_i wRAA(best nine without starter i)
//
// f0 = fullStrengthShare. Bounded convex weighting (no negative weights); an all-average roster
// is 0 wRAA regardless of f0, so the .500 baseline holds.

import type { HitterCandidate, RosterOptimizeOptions } from "../optimizer/types.ts";
import { lineupPositions } from "../optimizer/types.ts";
import { bestLineup, effectiveWoba } from "../optimizer/assign.ts";
import { lineupWraa, type WinParams, type Usage } from "./expected-wins.ts";

/** Availability-weighted team offensive wRAA (runs) for a rostered hitter set; null if it
 *  cannot field a lineup for either platoon side. */
export function offenseRunsAboveAvg(
  hitters: HitterCandidate[], opts: RosterOptimizeOptions, usage: Usage, p: WinParams,
): number | null {
  const positions = lineupPositions(opts.dh);
  const f0 = p.fullStrengthShare;

  const rho = p.platoonCapture;
  const wraaOf = (lineup: HitterCandidate[], side: "R" | "L") =>
    lineupWraa(lineup.map((c) => effectiveWoba(c, side, rho)), usage.lineupPA, p);

  const sideRAA = (side: "R" | "L"): number | null => {
    const full = bestLineup(hitters, positions, side, rho);
    if (!full) return null;
    const wraaFull = wraaOf(full, side);
    if (f0 >= 1 || full.length === 0) return wraaFull;

    // Leave-one-starter-out: re-match the WHOLE lineup from the remaining rostered hitters, so
    // shifts/platoon-partners/utility cards fill in optimally. If a slot can't be re-covered,
    // that starter's absence forfeits its share (wRAA 0) — which is exactly why depth matters.
    let sumOut = 0;
    for (const out of full) {
      const reduced = hitters.filter((c) => c.id !== out.id);
      const lu = bestLineup(reduced, positions, side, rho);
      sumOut += lu ? wraaOf(lu, side) : 0;
    }
    return f0 * wraaFull + (1 - f0) * (sumOut / full.length);
  };

  const r = sideRAA("R");
  const l = sideRAA("L");
  if (r == null || l == null) return null;
  return opts.platoonVR * r + opts.platoonVL * l;
}
