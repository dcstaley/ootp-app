// M4 — orchestrate the hitter roster + dual-lineup solve: build the MILP, run
// HiGHS in-process, parse the solution back into a Roster. (Pitchers, rotation,
// and cap/slots budgets are later phases.)

import type {
  HitterCandidate, HitterOptimizeOptions, HitterResult, LineupSlot,
  PitcherCandidate, PitcherOptimizeOptions, Roster, RosterOptimizeOptions, RotationSlot,
} from "./types.ts";
import { lineupPositions, blendPitch } from "./types.ts";
import { buildHitterLp } from "./lp.ts";
import { buildRosterLp } from "./roster-lp.ts";
import { getSolver } from "./solve.ts";
import { generatePitcherStaff } from "./pitcher-generate.ts";
import { bestLineup } from "./assign.ts";

// The DISPLAYED dual lineups come from the exact max-weight assignment (bestLineup) over the
// ROSTERED hitters — the SAME routine the E[wins] evaluator scores with — so the highest
// side-value eligible player always starts each position (no roster-depth/insurance credit can
// bench a better bat). Pure side value (capture = 1): the vR lineup is the best-vR nine, the vL
// lineup the best-vL nine.
function displayLineup(rostered: HitterCandidate[], dh: boolean, side: "L" | "R"): LineupSlot[] {
  const positions = lineupPositions(dh);
  const lu = bestLineup(rostered, positions, side, 1);
  return lu ? lu.map((c, i) => ({ pos: positions[i]!, id: c.id, title: c.title })) : [];
}

export async function generateHitterRoster(cands: HitterCandidate[], opts: HitterOptimizeOptions): Promise<HitterResult> {
  const { lp } = buildHitterLp(cands, opts);
  const solver = await getSolver();
  const sol = solver.solve(lp);

  if (sol.Status !== "Optimal") {
    return { status: sol.Status, objective: 0, hitters: [], lineupVR: [], lineupVL: [] };
  }

  const on = (name: string) => (sol.Columns[name]?.Primal ?? 0) > 0.5;
  const rostered = cands.filter((_, i) => on(`r_${i}`));
  const hitters = rostered.map((c) => c.id);

  return { status: "Optimal", objective: sol.ObjectiveValue, hitters, lineupVR: displayLineup(rostered, opts.dh, "R"), lineupVL: displayLineup(rostered, opts.dh, "L") };
}

/**
 * Full roster (non-cap): hitters and pitchers are independent solves here (no
 * shared budget). Cap/slots mode (Phase C) will couple them via the budget. The
 * combined status is "Optimal" only if both sub-solves succeed.
 */
export async function generateRoster(
  hitters: HitterCandidate[], pitchers: PitcherCandidate[],
  hitterOpts: HitterOptimizeOptions, pitcherOpts: PitcherOptimizeOptions,
): Promise<Roster> {
  const [h, p] = await Promise.all([
    generateHitterRoster(hitters, hitterOpts),
    generatePitcherStaff(pitchers, pitcherOpts),
  ]);
  const ok = h.status === "Optimal" && p.status === "Optimal";
  return {
    status: ok ? "Optimal" : `hitters:${h.status} pitchers:${p.status}`,
    objective: h.objective + p.objective,
    hitters: h.hitters, lineupVR: h.lineupVR, lineupVL: h.lineupVL,
    pitchers: p.pitchers, rotation: p.rotation, bullpen: p.bullpen,
  };
}

/**
 * Phase C — the combined cap/slots roster: hitters + pitchers in ONE MILP sharing
 * the budget (cap or slots), so the optimizer allocates optimally (starters-first
 * by weight; cap-reclaim automatic). Reports total cost + the H/P value split
 * (SP-7) so cross-pool balance under signed-distance can be watched.
 */
export async function generateFullRoster(
  hitters: HitterCandidate[], pitchers: PitcherCandidate[], opts: RosterOptimizeOptions,
): Promise<Roster> {
  const { lp } = buildRosterLp(hitters, pitchers, opts);
  const solver = await getSolver();
  const sol = solver.solve(lp);
  const empty: Roster = { status: sol.Status, objective: 0, hitters: [], lineupVR: [], lineupVL: [], pitchers: [], rotation: [], bullpen: [] };
  if (sol.Status !== "Optimal") return empty;

  const on = (name: string) => (sol.Columns[name]?.Primal ?? 0) > 0.5;
  const hitters_ = hitters.filter((_, i) => on(`rh_${i}`));
  const pitchers_ = pitchers.filter((_, j) => on(`rp_${j}`));

  const lineup = (side: "L" | "R"): LineupSlot[] => displayLineup(hitters_, opts.dh, side);
  const rotation: RotationSlot[] = [];
  for (let k = 1; k <= opts.minStarters; k++) {
    const j = pitchers.findIndex((_, idx) => on(`xp_${idx}_s${k}`));
    if (j >= 0) rotation.push({ slot: k, id: pitchers[j]!.id, title: pitchers[j]!.title });
  }
  const inRot = new Set(rotation.map((r) => r.id));
  const bullpen = pitchers_.map((c) => c.id).filter((id) => !inRot.has(id));

  // Two-way cards are rostered as BOTH a hitter and a pitcher (same id in both
  // sub-results). Count each physical card ONCE toward cost / roster size.
  const hIds = new Set(hitters_.map((c) => c.id));
  const twoWay = pitchers_.filter((c) => hIds.has(c.id)).map((c) => c.id);
  const twoWaySet = new Set(twoWay);
  const cost = hitters_.reduce((s, c) => s + c.cost, 0)
    + pitchers_.filter((c) => !twoWaySet.has(c.id)).reduce((s, c) => s + c.cost, 0);
  const hitterValue = hitters_.reduce((s, c) => s + Math.max(c.valueVR, c.valueVL), 0);
  const pitcherValue = pitchers_.reduce((s, c) => s + blendPitch(c.valueVR, c.valueVL, c.throws, inRot.has(c.id) ? "sp" : "rp", opts.pitchSplit, opts.platoonVR, opts.platoonVL), 0);

  return {
    status: "Optimal", objective: sol.ObjectiveValue,
    hitters: hitters_.map((c) => c.id), lineupVR: lineup("R"), lineupVL: lineup("L"),
    pitchers: pitchers_.map((c) => c.id), rotation, bullpen, twoWay,
    cost, balance: { hitterValue, pitcherValue },
  };
}
