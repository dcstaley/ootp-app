// M4 Phase B — pitcher staff MILP. Select nPitchers, fill `minStarters` rotation
// slots (SP1..SPk, weighted by slot) with starter-QUALIFIED pitchers (stamina +
// pitch-type minimums), the rest become the bullpen. Vars keyed by candidate index.
//   p_<i>        ∈{0,1}  pitcher i rostered
//   x_<i>_s<k>   ∈{0,1}  pitcher i in rotation slot k (only if qualified)
// Objective: Σ slotWeight_k · value_i · x + bullpenWeight · value_i · p   (the
// bullpen term orders rostered non-starters toward the next-best arms; slot
// weights dominate starter placement). value_i = platoon-weighted per-side value.

import type { PitcherCandidate, PitcherOptimizeOptions } from "./types.ts";
import { qualifiesStarter } from "./types.ts";

export interface BuiltLp { lp: string; vars: number; constraints: number }

const f6 = (x: number) => x.toFixed(6);
const DEFAULT_SLOT_WEIGHTS = [1, 0.95, 0.9, 0.8, 0.75];

export function buildPitcherLp(cands: PitcherCandidate[], opts: PitcherOptimizeOptions): BuiltLp {
  const slots = opts.minStarters;
  const weights = opts.rotationSlotWeights ?? DEFAULT_SLOT_WEIGHTS;
  const slotW = (k: number) => weights[k - 1] ?? weights[weights.length - 1] ?? 0.75;
  const bullpenW = opts.bullpenWeight ?? 0.15;
  const value = (c: PitcherCandidate) => opts.platoonVR * c.valueVR + opts.platoonVL * c.valueVL;

  const obj: string[] = [];
  const xVars: string[] = [];
  const pVars = cands.map((_, i) => `p_${i}`);
  const perSlot: Record<number, string[]> = {};
  const perCard: Record<number, string[]> = {};

  cands.forEach((c, i) => {
    const v = value(c);
    obj.push(`${f6(bullpenW * v)} p_${i}`);
    if (qualifiesStarter(c, opts.minStarterStamina, opts.minPitchTypes)) {
      for (let k = 1; k <= slots; k++) {
        const x = `x_${i}_s${k}`;
        xVars.push(x);
        obj.push(`${f6(slotW(k) * v)} ${x}`);
        (perSlot[k] ??= []).push(x);
        (perCard[i] ??= []).push(x);
      }
    }
  });

  const cons: string[] = [];
  cons.push(` psize: ${pVars.join(" + ")} = ${opts.nPitchers}`);
  for (let k = 1; k <= slots; k++) {
    const t = perSlot[k];
    if (t?.length) cons.push(` slot_s${k}: ${t.join(" + ")} = 1`);
  }
  cands.forEach((_, i) => {
    const t = perCard[i];
    if (t?.length) cons.push(` rot_${i}: ${t.join(" + ")} - p_${i} <= 0`);
  });

  const lp = [
    "Maximize", ` obj: ${obj.join(" + ")}`,
    "Subject To", ...cons,
    "Binaries", ` ${[...xVars, ...pVars].join(" ")}`,
    "End",
  ].join("\n");
  return { lp, vars: xVars.length + pVars.length, constraints: cons.length };
}
