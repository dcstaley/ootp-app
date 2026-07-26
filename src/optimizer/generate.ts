// M4 — orchestrate the hitter roster + dual-lineup solve: build the MILP, run
// HiGHS in-process, parse the solution back into a Roster. (Pitchers, rotation,
// and cap/slots budgets are later phases.)

import type {
  HitterCandidate, HitterOptimizeOptions, HitterResult, LineupSlot,
  PitcherCandidate, PitcherOptimizeOptions, Roster, RosterOptimizeOptions, RotationSlot,
} from "./types.ts";
import { lineupPositions } from "./types.ts";
import { buildHitterLp } from "./lp.ts";
import { buildRosterLp } from "./roster-lp.ts";
import { getSolver } from "./solve.ts";
import { generatePitcherStaff } from "./pitcher-generate.ts";
import { bestLineupLocked, rosterBalance } from "./assign.ts";

// The DISPLAYED dual lineups come from the exact max-weight assignment (bestLineup) over the
// ROSTERED hitters — the SAME routine the E[wins] evaluator scores with — so the highest
// side-value eligible player always starts each position (no roster-depth/insurance credit can
// bench a better bat). Manual lineup locks (S-4) are honored: a pinned card is fixed at its
// locked position (using its ELIGIBLE positions, matching the MILP) and the rest matched around
// it — so the displayed lineup can't bench a lock or blank out on an eligible-but-unqualified pin.
//
// `capture` is a PARAMETER, not the 1 it used to be hard-coded to. The MILP now SELECTS at ρ and
// the evaluator SCORES at ρ, so matching the display at ρ=1 meant the nine cards shown were not
// the nine the reported win% was computed over: on the real roster the vR nine SHOWN started
// Rutschman at C while the nine SCORED started Dingler. A user who fields the displayed lineup
// must get the roster the optimizer priced.
function displayLineup(
  rostered: HitterCandidate[], dh: boolean, side: "L" | "R", capture: number,
  lineupLocks?: { id: string; pos: string; side: "L" | "R" }[],
): LineupSlot[] {
  const positions = lineupPositions(dh);
  const locks = (lineupLocks ?? []).filter((l) => l.side === side).map((l) => ({ id: l.id, pos: l.pos }));
  const lu = bestLineupLocked(rostered, positions, side, capture, locks);
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

  // ρ=1 is CORRECT here, not a leftover: this legacy hitter-only objective (lp.ts) values cards at
  // their raw per-side value, so its display matches its own selection. HitterOptimizeOptions
  // carries no ρ precisely because the objective has none.
  return { status: "Optimal", objective: sol.ObjectiveValue, hitters, lineupVR: displayLineup(rostered, opts.dh, "R", 1), lineupVL: displayLineup(rostered, opts.dh, "L", 1) };
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

  // The SAME ρ the MILP just selected at (roster-lp.ts) and the E[wins] evaluator will score at.
  const rho = opts.platoonCapture ?? 1;
  const lineup = (side: "L" | "R"): LineupSlot[] => displayLineup(hitters_, opts.dh, side, rho, opts.lineupLocks);
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

  return {
    status: "Optimal", objective: sol.ObjectiveValue,
    hitters: hitters_.map((c) => c.id), lineupVR: lineup("R"), lineupVL: lineup("L"),
    pitchers: pitchers_.map((c) => c.id), rotation, bullpen, twoWay,
    // SP-7 H/P value split — the ONE producer (assign.ts), shared with assignRoster.
    cost, balance: rosterBalance(hitters_, pitchers_, opts, (c) => inRot.has(c.id)),
  };
}
