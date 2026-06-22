// M4 — orchestrate the hitter roster + dual-lineup solve: build the MILP, run
// HiGHS in-process, parse the solution back into a Roster. (Pitchers, rotation,
// and cap/slots budgets are later phases.)

import type {
  HitterCandidate, HitterOptimizeOptions, HitterResult, LineupSlot,
  PitcherCandidate, PitcherOptimizeOptions, Roster,
} from "./types.ts";
import { lineupPositions } from "./types.ts";
import { buildHitterLp } from "./lp.ts";
import { getSolver } from "./solve.ts";
import { generatePitcherStaff } from "./pitcher-generate.ts";

export async function generateHitterRoster(cands: HitterCandidate[], opts: HitterOptimizeOptions): Promise<HitterResult> {
  const { lp } = buildHitterLp(cands, opts);
  const solver = await getSolver();
  const sol = solver.solve(lp);

  if (sol.Status !== "Optimal") {
    return { status: sol.Status, objective: 0, hitters: [], lineupVR: [], lineupVL: [] };
  }

  const on = (name: string) => (sol.Columns[name]?.Primal ?? 0) > 0.5;
  const hitters: string[] = [];
  cands.forEach((c, i) => { if (on(`r_${i}`)) hitters.push(c.id); });

  const lineup = (side: "L" | "R"): LineupSlot[] => {
    const slots: LineupSlot[] = [];
    for (const p of lineupPositions(opts.dh)) {
      const i = cands.findIndex((_, idx) => on(`y_${idx}_${p}_v${side}`));
      if (i >= 0) slots.push({ pos: p, id: cands[i]!.id, title: cands[i]!.title });
    }
    return slots;
  };

  return { status: "Optimal", objective: sol.ObjectiveValue, hitters, lineupVR: lineup("R"), lineupVL: lineup("L") };
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
