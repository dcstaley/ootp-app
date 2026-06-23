// M4 Phase C — the combined cap/slots roster MILP. Hitters and pitchers solve
// TOGETHER because they share the budget. One optimal solve (D5: principled, not
// the old reserve→greedy→reclaim — cap-reclaim is automatic since nothing is
// artificially reserved). Vars:
//   rh_<i>, yh_<i>_<pos>_v<S>   hitter membership + dual-lineup assignment
//   rp_<j>, xp_<j>_s<k>         pitcher membership + rotation slot
// Objective (D2): signed-distance value × platoon/role weights × H/P emphasis,
// + a both-sides bonus for platoon-neutral hitters. NO cross-pool multiplier and
// NO power transform (those are exactly what D2 removed). Budget:
//   cap:   Σ cost·rostered ≤ total_cap
//   slots: per Card-Value tier, Σ rostered with cost ≥ threshold ≤ cumulative limit

import type { HitterCandidate, PitcherCandidate, RosterOptimizeOptions } from "./types.ts";
import { lineupPositions, qualifiesStarter, SLOT_TIERS, FIELD_POSITIONS } from "./types.ts";

export interface BuiltRosterLp { lp: string; vars: number; constraints: number }

const f6 = (x: number) => x.toFixed(6);
const DEFAULT_SLOT_WEIGHTS = [1, 0.95, 0.9, 0.8, 0.75];

/** Cumulative slot limits by tier (implied iron absorbs leftover roster spots). */
export function cumulativeSlotLimits(slotCounts: Record<string, number>, rosterSize: number): { threshold: number; limit: number }[] {
  const explicitTotal = SLOT_TIERS.reduce((s, t) => s + (slotCounts[t.key] || 0), 0);
  const impliedIron = Math.max(0, rosterSize - explicitTotal);
  let cumulative = 0;
  return SLOT_TIERS.map((t) => {
    const explicit = slotCounts[t.key] || 0;
    const eff = t.key === "iron" && !explicit ? impliedIron : explicit;
    cumulative += eff;
    return { threshold: t.threshold, limit: cumulative };
  });
}

export function buildRosterLp(hitters: HitterCandidate[], pitchers: PitcherCandidate[], opts: RosterOptimizeOptions): BuiltRosterLp {
  const positions = lineupPositions(opts.dh);
  const slots = opts.minStarters;
  const rotW = opts.rotationSlotWeights ?? DEFAULT_SLOT_WEIGHTS;
  const slotW = (k: number) => rotW[k - 1] ?? rotW[rotW.length - 1] ?? 0.75;
  const benchW = opts.benchWeight ?? 0.3;
  const bullpenW = opts.bullpenWeight ?? 0.15;
  const depth = opts.backupCatcherDepth ?? 2;
  const hEmph = opts.hitterEmphasis ?? 1;
  const pEmph = opts.pitcherEmphasis ?? 1;
  const bonus = opts.bothSidesBonus ?? 1.25;
  const bsThresh = opts.bothSidesThreshold ?? 0;
  const pValue = (c: PitcherCandidate) => opts.platoonVR * c.valueVR + opts.platoonVL * c.valueVL;

  const obj: string[] = [];
  const bin: string[] = [];
  const cons: string[] = [];

  // ── Hitters ──
  const rhVars = hitters.map((_, i) => `rh_${i}`);
  const hPosSide: Record<string, string[]> = {};
  const hCardSide: Record<string, string[]> = {};
  hitters.forEach((c, i) => {
    const bothSides = Math.min(c.valueVR, c.valueVL) >= bsThresh ? bonus : 1;
    for (const side of ["L", "R"] as const) {
      const w = side === "R" ? opts.platoonVR : opts.platoonVL;
      const val = side === "R" ? c.valueVR : c.valueVL;
      for (const p of c.positions) {
        if (!positions.includes(p)) continue;
        const y = `yh_${i}_${p}_v${side}`;
        bin.push(y);
        obj.push(`${f6(hEmph * bothSides * w * val)} ${y}`);
        (hPosSide[`${p}|${side}`] ??= []).push(y);
        (hCardSide[`${i}|${side}`] ??= []).push(y);
      }
    }
    obj.push(`${f6(hEmph * benchW * Math.max(c.valueVR, c.valueVL))} rh_${i}`);
  });
  bin.push(...rhVars);
  for (const side of ["L", "R"]) for (const p of positions) {
    const t = hPosSide[`${p}|${side}`];
    if (t?.length) cons.push(` fill_${p}_v${side}: ${t.join(" + ")} = 1`);
  }
  hitters.forEach((_, i) => {
    for (const side of ["L", "R"]) {
      const t = hCardSide[`${i}|${side}`];
      if (t?.length) cons.push(` hone_${i}_v${side}: ${t.join(" + ")} - rh_${i} <= 0`);
    }
  });
  cons.push(` hsize: ${rhVars.join(" + ")} = ${opts.nHitters}`);
  // Required cards (locks): force the candidate onto the roster.
  const locked = new Set(opts.lockedIds ?? []);
  const strip = (id: string) => id.replace(/#V$/, "");
  if (locked.size) {
    hitters.forEach((c, i) => { if (locked.has(strip(c.id))) cons.push(` lock_h_${i}: rh_${i} = 1`); });
    pitchers.forEach((c, j) => { if (locked.has(strip(c.id))) cons.push(` lock_p_${j}: rp_${j} = 1`); });
  }
  // Coverage depth: ≥ minPlayersPerPosition rostered hitters can play EACH field
  // position (so every position has a backup, not just catcher). Catcher may use a
  // higher backupCatcherDepth. Skipped where the pool can't satisfy it (avoids
  // guaranteed infeasibility — the shortage is then visible in the result).
  const minPos = opts.minPlayersPerPosition ?? 2;
  for (const pos of FIELD_POSITIONS) {
    const eligible = hitters.map((c, i) => ({ c, i })).filter((x) => x.c.positions.includes(pos)).map((x) => `rh_${x.i}`);
    const need = pos === "C" ? Math.max(minPos, depth) : minPos;
    if (eligible.length >= need) cons.push(` cover_${pos}: ${eligible.join(" + ")} >= ${need}`);
  }

  // ── Pitchers ──
  const rpVars = pitchers.map((_, j) => `rp_${j}`);
  const pSlot: Record<number, string[]> = {};
  const pCard: Record<number, string[]> = {};
  pitchers.forEach((c, j) => {
    const v = pValue(c);
    obj.push(`${f6(pEmph * bullpenW * v)} rp_${j}`);
    if (qualifiesStarter(c, opts.minStarterStamina, opts.minPitchTypes)) {
      for (let k = 1; k <= slots; k++) {
        const x = `xp_${j}_s${k}`;
        bin.push(x);
        obj.push(`${f6(pEmph * slotW(k) * v)} ${x}`);
        (pSlot[k] ??= []).push(x);
        (pCard[j] ??= []).push(x);
      }
    }
  });
  bin.push(...rpVars);
  cons.push(` psize: ${rpVars.join(" + ")} = ${opts.nPitchers}`);
  for (let k = 1; k <= slots; k++) {
    const t = pSlot[k];
    if (t?.length) cons.push(` slot_s${k}: ${t.join(" + ")} = 1`);
  }
  pitchers.forEach((_, j) => {
    const t = pCard[j];
    if (t?.length) cons.push(` prot_${j}: ${t.join(" + ")} - rp_${j} <= 0`);
  });

  // ── Budget ──
  if (opts.mode === "cap" && opts.totalCap != null) {
    const terms = [
      ...hitters.map((c, i) => `${c.cost} rh_${i}`),
      ...pitchers.map((c, j) => `${c.cost} rp_${j}`),
    ];
    cons.push(` cap: ${terms.join(" + ")} <= ${opts.totalCap}`);
  } else if (opts.mode === "slots" && opts.slotCounts) {
    const rosterSize = opts.rosterSize ?? opts.nHitters + opts.nPitchers;
    for (const { threshold, limit } of cumulativeSlotLimits(opts.slotCounts, rosterSize)) {
      const terms = [
        ...hitters.map((c, i) => ({ cost: c.cost, v: `rh_${i}` })),
        ...pitchers.map((c, j) => ({ cost: c.cost, v: `rp_${j}` })),
      ].filter((x) => x.cost >= threshold).map((x) => x.v);
      if (terms.length) cons.push(` tier_${threshold}: ${terms.join(" + ")} <= ${limit}`);
    }
  }

  const lp = ["Maximize", ` obj: ${obj.join(" + ")}`, "Subject To", ...cons, "Binaries", ` ${bin.join(" ")}`, "End"].join("\n");
  return { lp, vars: bin.length, constraints: cons.length };
}
