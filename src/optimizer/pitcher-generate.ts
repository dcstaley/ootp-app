// M4 Phase B — solve the pitcher staff MILP and parse it into rotation + bullpen.

import type { PitcherCandidate, PitcherOptimizeOptions, PitcherStaff, RotationSlot } from "./types.ts";
import { buildPitcherLp } from "./pitcher-lp.ts";
import { getSolver } from "./solve.ts";

export async function generatePitcherStaff(cands: PitcherCandidate[], opts: PitcherOptimizeOptions): Promise<PitcherStaff> {
  const { lp } = buildPitcherLp(cands, opts);
  const solver = await getSolver();
  const sol = solver.solve(lp);
  if (sol.Status !== "Optimal") {
    return { status: sol.Status, objective: 0, pitchers: [], rotation: [], bullpen: [] };
  }

  const on = (name: string) => (sol.Columns[name]?.Primal ?? 0) > 0.5;
  const pitchers: string[] = [];
  cands.forEach((c, i) => { if (on(`p_${i}`)) pitchers.push(c.id); });

  const rotation: RotationSlot[] = [];
  for (let k = 1; k <= opts.minStarters; k++) {
    const i = cands.findIndex((_, idx) => on(`x_${idx}_s${k}`));
    if (i >= 0) rotation.push({ slot: k, id: cands[i]!.id, title: cands[i]!.title });
  }
  const inRotation = new Set(rotation.map((r) => r.id));
  const bullpen = pitchers.filter((id) => !inRotation.has(id));

  return { status: "Optimal", objective: sol.ObjectiveValue, pitchers, rotation, bullpen };
}
