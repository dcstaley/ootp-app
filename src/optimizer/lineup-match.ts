// Max-weight lineup assignment — the one reusable "best lineup value for this set of
// hitters" primitive, used by the Biggest Upgrades estimate on the roster page. It
// mirrors the LP's lineup objective (assign players to the side's positions to maximize
// total started value), but as a fast standalone matching so we can evaluate many
// candidate lineups without a HiGHS solve. NEVER scores — consumes already-scored values.

import { lineupPositions } from "./types.ts";

export interface MatchHitter {
  id: string;
  positions: string[]; // STARTER-eligible positions (already filtered by the tournament's mins + rank reqs); includes "DH"
  valueVR: number;
  valueVL: number;
}

const FORBID = 1e9; // cost for an ineligible (player, position) pair

// Hungarian algorithm (Kuhn–Munkres), square cost matrix, minimization. Returns p[],
// where p[j] = row matched to column j (1-indexed; j,row in 1..n). O(n³).
function hungarian(cost: number[][], n: number): number[] {
  const INF = Infinity;
  const u = new Array(n + 1).fill(0);
  const v = new Array(n + 1).fill(0);
  const p = new Array(n + 1).fill(0);
  const way = new Array(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(n + 1).fill(INF);
    const used = new Array(n + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = INF, j1 = -1;
      for (let j = 1; j <= n; j++) if (!used[j]) {
        const cur = cost[i0 - 1]![j - 1]! - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; }
        else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  return p;
}

/**
 * Best total lineup value for `players` on `side`, assigning one player to each of the
 * side's lineup positions (8 field + DH when `dh`). Each player is eligible only for the
 * positions in their `positions` list. Returns -Infinity if no position can be filled
 * (e.g. removing a player leaves a position uncovered). Higher = better.
 */
export function bestLineupValue(players: MatchHitter[], side: "R" | "L", dh: boolean): number {
  const positions = lineupPositions(dh);
  const P = positions.length;
  const N = players.length;
  if (N < P) return -Infinity; // can't fill every position
  const val = (m: MatchHitter) => (side === "R" ? m.valueVR : m.valueVL);
  // Square N×N matrix. Rows 0..P-1 = real positions; rows P..N-1 = dummy "bench" slots
  // (value 0, any player). Cols = players. Minimize negative value.
  const cost: number[][] = [];
  for (let i = 0; i < N; i++) {
    const r = new Array(N);
    for (let j = 0; j < N; j++) {
      if (i < P) r[j] = players[j]!.positions.includes(positions[i]!) ? -val(players[j]!) : FORBID;
      else r[j] = 0;
    }
    cost.push(r);
  }
  const p = hungarian(cost, N);
  let total = 0;
  for (let j = 1; j <= N; j++) {
    const i = p[j]!; // row (slot) matched to player j
    if (i >= 1 && i <= P) {
      if (!players[j - 1]!.positions.includes(positions[i - 1]!)) return -Infinity; // forbidden forced ⇒ infeasible
      total += val(players[j - 1]!);
    }
  }
  return total;
}
