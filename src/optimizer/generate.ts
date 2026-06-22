// M4 — orchestrate the hitter roster + dual-lineup solve: build the MILP, run
// HiGHS in-process, parse the solution back into a Roster. (Pitchers, rotation,
// and cap/slots budgets are later phases.)

import type { HitterCandidate, HitterOptimizeOptions, Roster, LineupSlot } from "./types.ts";
import { lineupPositions } from "./types.ts";
import { buildHitterLp } from "./lp.ts";
import { getSolver } from "./solve.ts";

export async function generateHitterRoster(cands: HitterCandidate[], opts: HitterOptimizeOptions): Promise<Roster> {
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
