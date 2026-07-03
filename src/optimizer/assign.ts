// Phase 2 of the cap/slots objective rework: the ASSIGNMENT sub-solve. Given a SELECTED set
// of hitters + pitchers, produce the optimal roster — the best dual-platoon lineup and the
// best rotation/bullpen split — that the E[wins] evaluator then scores. This is exact and
// tiny (≤26 cards), independent of the ~3000-card pool: the E[wins] evaluator
// (src/eval) calls it to value a selected set; the pool never enters here.
//
// Why assignment decomposes cleanly: given a fixed set, E[wins] is monotone in runs scored
// (fixed pitching) and in runs prevented (fixed hitting), and both are LINEAR in the
// assignment. So the offensive assignment that maximises team wRAA is an exact max-weight
// matching (cards → the 9 fielding positions, per platoon side), and the rotation is just the
// best `minStarters` starter-qualified arms by SP value (rotation BF is ~flat — no ordering).

import type { HitterCandidate, PitcherCandidate, Roster, RosterOptimizeOptions, LineupSlot, RotationSlot } from "./types.ts";
import { lineupPositions, qualifiesStarter, blendPitch } from "./types.ts";
import { TARGET_WOBA } from "../scoring-core/calibrate.ts";

const BIG = 1e9; // pseudo-cost for an ineligible (position, card) cell

/**
 * Rectangular assignment (Kuhn–Munkres): assign each of `n` rows to a DISTINCT column of an
 * `n × m` cost matrix (n ≤ m) minimising total cost. Returns the column chosen per row.
 * Standard O(n²m) potentials-and-augmenting-path form.
 */
function hungarian(cost: number[][], n: number, m: number): number[] {
  const u = new Array(n + 1).fill(0);
  const v = new Array(m + 1).fill(0);
  const p = new Array(m + 1).fill(0); // p[j] = row matched to column j (1-indexed; 0 = none)
  const way = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(m + 1).fill(Infinity);
    const used = new Array(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = -1;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1]![j - 1]! - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; }
        else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const rowCol = new Array(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j] !== 0) rowCol[p[j] - 1] = j - 1;
  return rowCol;
}

/** wOBA of a hitter vs the given opposing hand (value is D2 signed distance from TARGET_WOBA). */
export const sideWoba = (c: HitterCandidate, side: "R" | "L") => (side === "R" ? c.valueVR : c.valueVL) + TARGET_WOBA;

/**
 * Deployment-adjusted wOBA for a card fielded on `side`. With capture rate `ρ < 1` a platoon
 * specialist doesn't ALWAYS get its favorable matchup, so `(1−ρ)` of its off-side value bleeds
 * in — shrinking the specialist-vs-all-around gap (ρ=1 = perfect deployment, the old behavior).
 */
export const effectiveWoba = (c: HitterCandidate, side: "R" | "L", capture = 1) =>
  capture * sideWoba(c, side) + (1 - capture) * sideWoba(c, side === "R" ? "L" : "R");

/**
 * Best position→card assignment for one platoon side (max total effective wOBA): the cards
 * filling each lineup position, in `positions` order. null if the set can't cover a slot. Exact
 * max-weight matching — the offense/availability model re-runs this on leave-one-out sets.
 */
export function bestLineup(hitters: HitterCandidate[], positions: string[], side: "R" | "L", capture = 1): HitterCandidate[] | null {
  const n = positions.length;
  const m = hitters.length;
  if (m < n) return null;
  const eligible = (pos: string, c: HitterCandidate) => c.positions.includes(pos);
  const cost: number[][] = positions.map((pos) => hitters.map((c) => (eligible(pos, c) ? -effectiveWoba(c, side, capture) : BIG)));
  const rowCol = hungarian(cost, n, m);
  const out: HitterCandidate[] = [];
  for (let i = 0; i < n; i++) {
    const j = rowCol[i]!;
    if (j < 0 || !eligible(positions[i]!, hitters[j]!)) return null; // uncoverable position
    out.push(hitters[j]!);
  }
  return out;
}

/** Best lineup as display slots (position + card id). */
function matchLineup(hitters: HitterCandidate[], positions: string[], side: "R" | "L"): LineupSlot[] | null {
  const lu = bestLineup(hitters, positions, side);
  return lu && lu.map((c, i) => ({ pos: positions[i]!, id: c.id, title: c.title }));
}

/**
 * The optimal roster for a fixed selected set. Returns null when the set is structurally
 * infeasible (can't field either platoon lineup, or can't staff the rotation).
 */
export function assignRoster(hitters: HitterCandidate[], pitchers: PitcherCandidate[], opts: RosterOptimizeOptions): Roster | null {
  const positions = lineupPositions(opts.dh);
  const lineupVR = matchLineup(hitters, positions, "R");
  const lineupVL = matchLineup(hitters, positions, "L");
  if (!lineupVR || !lineupVL) return null;

  const vSP = (c: PitcherCandidate) => blendPitch(c.valueVR, c.valueVL, c.throws, "sp", opts.pitchSplit, opts.platoonVR, opts.platoonVL);
  const qualified = pitchers.filter((c) => qualifiesStarter(c, opts.minStarterStamina, opts.minPitchTypes));
  if (qualified.length < opts.minStarters) return null;
  const starters = [...qualified].sort((a, b) => vSP(b) - vSP(a)).slice(0, opts.minStarters);
  const rotation: RotationSlot[] = starters.map((c, k) => ({ slot: k + 1, id: c.id, title: c.title }));
  const rotIds = new Set(starters.map((c) => c.id));
  const bullpen = pitchers.filter((c) => !rotIds.has(c.id)).map((c) => c.id);

  const twoWayIds = new Set(hitters.map((c) => c.id));
  const twoWay = pitchers.filter((c) => twoWayIds.has(c.id)).map((c) => c.id);
  const cost = hitters.reduce((s, c) => s + c.cost, 0) + pitchers.filter((c) => !twoWayIds.has(c.id)).reduce((s, c) => s + c.cost, 0);
  // SP-7 H/P value split (display parity with generateFullRoster): hitters by best side,
  // pitchers by deployed-role blend.
  const vRP = (c: PitcherCandidate) => blendPitch(c.valueVR, c.valueVL, c.throws, "rp", opts.pitchSplit, opts.platoonVR, opts.platoonVL);
  const hitterValue = hitters.reduce((s, c) => s + Math.max(c.valueVR, c.valueVL), 0);
  const pitcherValue = pitchers.reduce((s, c) => s + (rotIds.has(c.id) ? vSP(c) : vRP(c)), 0);

  return {
    status: "Optimal", objective: 0,
    hitters: hitters.map((c) => c.id), lineupVR, lineupVL,
    pitchers: pitchers.map((c) => c.id), rotation, bullpen,
    twoWay, cost, balance: { hitterValue, pitcherValue },
  };
}
