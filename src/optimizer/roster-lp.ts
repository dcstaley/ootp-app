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
import { lineupPositions, qualifiesStarter, blendPitch, SLOT_TIERS, FIELD_POSITIONS } from "./types.ts";

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
  // Non-budgeted (Top-X) mode: JUST PICK THE BEST PLAYERS per role. Versus cap/slots
  // it drops the rotation slot-decay (every SP slot weighs the same) and the both-sides
  // bonus, and — crucially — values a slotted starter on its SP blend ALONE, not also
  // credited the bullpen (RP-blend) value it will never pitch. That double-credit is
  // what let a worse starter who happens to be a good reliever edge a better starter
  // for a rotation spot. The UNIFORM membership values stay (every bench bat and bullpen
  // arm is still valued, so the best-available fill those spots — no per-slot weighting).
  // Cap/slots keep their weighted objective exactly as-is; the double-credit there is a
  // separate, deferred fix (the cap/slots/weights overhaul), not touched here.
  const weighted = opts.mode !== "none";
  const bonusEff = weighted ? bonus : 1;
  // Per-segment PREFERENCE dials — pure objective value multipliers (NOT caps). Down-dialing a
  // segment shrinks its value so the solver shifts slots to higher-weighted segments; relative
  // order WITHIN a segment is untouched, so the best card always wins its slot. Default 1.
  const sw = opts.segmentWeights ?? {};
  const wLineup = sw.lineup ?? 1, wBench = sw.bench ?? 1, wRotation = sw.rotation ?? 1, wBullpen = sw.bullpen ?? 1;
  // Role-aware pitcher collapse (M6): rotation-slot value uses the SP batter-hand
  // weight, the bullpen membership term the RP weight. Absent pitchSplit ⇒ legacy
  // team-split fallback (both roles identical), so behavior is unchanged without it.
  const vSP = (c: PitcherCandidate) => blendPitch(c.valueVR, c.valueVL, c.throws, "sp", opts.pitchSplit, opts.platoonVR, opts.platoonVL);
  const vRP = (c: PitcherCandidate) => blendPitch(c.valueVR, c.valueVL, c.throws, "rp", opts.pitchSplit, opts.platoonVR, opts.platoonVL);

  // E[wins] objective (cap/slots): coefficients are the card's run contribution in its role —
  // value × playing time (PA/BF) from the usage model — instead of the legacy tuned weights.
  // Puts H and P in one run currency and, with the netting below, values each card once by role.
  const uw = opts.usageWeights;
  const eweins = weighted && !!uw;
  const fillerBF = uw ? (uw.bullpenBF[uw.bullpenBF.length - 1] ?? 0) : 0; // a filler reliever's BF
  const closerBF = uw ? (uw.bullpenBF[0] ?? 0) : 0;  // highest-leverage arm
  const setupBF = uw ? (uw.bullpenBF[1] ?? 0) : 0;   // 2nd-highest
  const hasLeverage = eweins && closerBF > fillerBF; // leverage-weighted bullpen active
  const rotBF = (k: number) => (uw ? (uw.rotationBF[k - 1] ?? uw.rotationBF[uw.rotationBF.length - 1] ?? 0) : 0);

  const obj: string[] = [];
  const bin: string[] = [];
  const cons: string[] = [];
  const strip = (id: string) => id.replace(/#V$/, "");

  // A manual lineup lock may pin a card to any ELIGIBLE (can-play) position — even one
  // it isn't def-QUALIFIED to start. We emit the yh var for such positions so the lock
  // (yh=1) can bind; the AUTO optimizer still only assigns QUALIFIED positions (below).
  const lockEligPos = new Map<number, Set<string>>();
  if (opts.lineupLocks?.length) {
    const idxByBase = new Map<string, number>(); hitters.forEach((c, i) => idxByBase.set(strip(c.id), i));
    for (const lk of opts.lineupLocks) {
      const i = idxByBase.get(strip(lk.id));
      if (i == null || !positions.includes(lk.pos)) continue;
      const c = hitters[i]!;
      if ((c.playPositions ?? c.positions).includes(lk.pos)) (lockEligPos.get(i) ?? lockEligPos.set(i, new Set()).get(i)!).add(lk.pos);
    }
  }

  // ── Hitters ──
  const rhVars = hitters.map((_, i) => `rh_${i}`);
  const hPosSide: Record<string, string[]> = {};
  const hCardSide: Record<string, string[]> = {};
  hitters.forEach((c, i) => {
    const bothSides = Math.min(c.valueVR, c.valueVL) >= bsThresh ? bonusEff : 1;
    for (const side of ["L", "R"] as const) {
      const w = side === "R" ? opts.platoonVR : opts.platoonVL;
      const val = side === "R" ? c.valueVR : c.valueVL;
      for (const p of new Set([...c.positions, ...(lockEligPos.get(i) ?? [])])) {
        if (!positions.includes(p)) continue;
        const y = `yh_${i}_${p}_v${side}`;
        bin.push(y);
        obj.push(`${f6((eweins ? w * val * uw!.lineupPA : hEmph * bothSides * w * val) * wLineup)} ${y}`);
        (hPosSide[`${p}|${side}`] ??= []).push(y);
        (hCardSide[`${i}|${side}`] ??= []).push(y);
      }
    }
    const benchMax = Math.max(c.valueVR, c.valueVL);
    obj.push(`${f6((eweins ? benchMax * uw!.benchPA : hEmph * benchW * benchMax) * wBench)} rh_${i}`);
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
  // E[wins] bench NETTING: a hitter that STARTS a side must not ALSO collect the bench-depth
  // credit on rh (that double-count inflated hitters and starved pitching). z_i = 1 iff the card
  // starts any side (Σ yh ≥ 1 ⇒ z=1, forced by the constraint; the −bench coef on z keeps it 0
  // otherwise). So a starter is valued on its lineup value alone; only a PURE bench bat keeps
  // the bench credit.
  const stVars: string[] = []; // zst start-indicators (one per hitter, eweins) — reused by 2b below
  if (eweins) hitters.forEach((c, i) => {
    const allY = [...(hCardSide[`${i}|L`] ?? []), ...(hCardSide[`${i}|R`] ?? [])];
    if (!allY.length) return;
    const z = `zst_${i}`; bin.push(z); stVars.push(z);
    obj.push(`${f6(-Math.max(c.valueVR, c.valueVL) * uw!.benchPA * wBench)} ${z}`);
    // z = 1 iff the card starts a side: znet forces z ≥ Σyh/2 (starting ⇒ z=1); zub forces
    // z ≤ Σyh (not starting ⇒ z=0). The hard pin matters for the 2b cap below, which must not be
    // gamed by flagging a non-starter as a "starter".
    cons.push(` znet_${i}: ${allY.join(" + ")} - 2 ${z} <= 0`);
    cons.push(` zub_${i}: ${z} - ${allY.join(" - ")} <= 0`);
  });
  // hsize/psize are FLOORS (≥), not equalities — two-way players free roster slots
  // that flow to bonus picks (extra hitter who'd start, else an extra pitcher). The
  // distinct-card roster size (rsize, below) is the hard equality; with zero
  // two-way cards the floors collapse to exact nHitters/nPitchers (today's behavior).
  cons.push(` hsize: ${rhVars.join(" + ")} >= ${opts.nHitters}`);
  // Coverage depth: ≥ minPlayersPerPosition rostered hitters can play EACH field
  // position (so every position has a backup, not just catcher). Catcher may use a
  // higher backupCatcherDepth. Skipped where the pool can't satisfy it (avoids
  // guaranteed infeasibility — the shortage is then visible in the result).
  const minPos = opts.minPlayersPerPosition ?? 2;
  for (const pos of FIELD_POSITIONS) {
    // Coverage counts cards that can BACK UP the position (starter-or-backup tier).
    const eligible = hitters.map((c, i) => ({ c, i })).filter((x) => (x.c.coverPositions ?? x.c.positions).includes(pos)).map((x) => `rh_${x.i}`);
    const need = pos === "C" ? Math.max(minPos, depth) : minPos;
    if (eligible.length >= need) cons.push(` cover_${pos}: ${eligible.join(" + ")} >= ${need}`);
  }

  // ── Pitchers ──
  const rpVars = pitchers.map((_, j) => `rp_${j}`);
  const pSlot: Record<number, string[]> = {};
  const pCard: Record<number, string[]> = {};
  const closerVars: string[] = [];
  const setupVars: string[] = [];
  const leverByCard: Record<number, string[]> = {};
  pitchers.forEach((c, j) => {
    const relief = bullpenW * vRP(c); // legacy relief credit (both modes)
    // E[wins]: a rostered pitcher's base = its relief run-prevention over a FILLER reliever's BF.
    obj.push(`${f6((eweins ? vRP(c) * fillerBF : pEmph * relief) * wBullpen)} rp_${j}`);
    // Bullpen LEVERAGE (E[wins]): a reliever placed in the closer/setup slot earns the extra
    // high-leverage BF on top of its filler base — so the solver puts its BEST arm at the top and
    // fills the rest cheaply ("1–2 good relievers"). The delta form keeps it valued once.
    if (hasLeverage) {
      const xc = `xrpc_${j}`; bin.push(xc); obj.push(`${f6(vRP(c) * (closerBF - fillerBF) * wBullpen)} ${xc}`); closerVars.push(xc); (leverByCard[j] ??= []).push(xc);
      if (setupBF > fillerBF) { const xs = `xrps_${j}`; bin.push(xs); obj.push(`${f6(vRP(c) * (setupBF - fillerBF) * wBullpen)} ${xs}`); setupVars.push(xs); (leverByCard[j] ??= []).push(xs); }
    }
    if (qualifiesStarter(c, opts.minStarterStamina, opts.minPitchTypes)) {
      const v = vSP(c);
      for (let k = 1; k <= slots; k++) {
        const x = `xp_${j}_s${k}`;
        bin.push(x);
        // E[wins] cap/slots: SP value over the slot's FORMAT BF, NET of the relief membership it
        // also gets on rp (above) → a slotted starter is valued ONCE as a starter (kills the
        // SP/relief double-count). The rotation dial weights the SP value; the netted relief credit
        // uses the SAME bullpen weight as rp so a slotted starter nets to exactly wRotation·SP.
        // Legacy cap/slots = slotW·v (on top of rp); non-cap = v − relief.
        const coef = eweins ? (v * rotBF(k) * wRotation - vRP(c) * fillerBF * wBullpen) : (weighted ? slotW(k) * v * wRotation : v - relief);
        obj.push(`${f6(eweins ? coef : pEmph * coef)} ${x}`);
        (pSlot[k] ??= []).push(x);
        (pCard[j] ??= []).push(x);
      }
    }
  });
  bin.push(...rpVars);
  cons.push(` psize: ${rpVars.join(" + ")} >= ${opts.nPitchers}`);
  for (let k = 1; k <= slots; k++) {
    const t = pSlot[k];
    if (t?.length) cons.push(` slot_s${k}: ${t.join(" + ")} = 1`);
  }
  pitchers.forEach((_, j) => {
    const t = pCard[j];
    if (t?.length) cons.push(` prot_${j}: ${t.join(" + ")} - rp_${j} <= 0`);
  });
  // Bullpen leverage: exactly one closer + one setup; a pitcher fills at most one role (closer,
  // setup, or a rotation slot) and only if rostered (so a starter can't also be the closer).
  if (hasLeverage) {
    cons.push(` closer_slot: ${closerVars.join(" + ")} = 1`);
    if (setupVars.length) cons.push(` setup_slot: ${setupVars.join(" + ")} = 1`);
    pitchers.forEach((_, j) => {
      const lv = leverByCard[j]; if (!lv?.length) return;
      cons.push(` lever_${j}: ${[...lv, ...(pCard[j] ?? [])].join(" + ")} - rp_${j} <= 0`);
    });
  }

  // ── Two-way players ──────────────────────────────────────────────────────────
  // A physical card present in BOTH pools is matched by id. Two of them:
  //   • two-way (Top-X overlap or forced toggle): rh_i = rp_j — used as both sides
  //     or neither (always-two-way per the user); counted ONCE toward roster + cap.
  //   • single-role (in both pools but not two-way): rh_i + rp_j ≤ 1 — pick one.
  const hIdxById = new Map<string, number>(); hitters.forEach((c, i) => hIdxById.set(c.id, i));
  const twoWaySet = new Set(opts.twoWayIds ?? []);
  const overlapTerms: { i: number; j: number; cost: number; twoWay: boolean }[] = [];
  pitchers.forEach((c, j) => {
    const i = hIdxById.get(c.id);
    if (i == null) return; // pitcher-only card
    const twoWay = twoWaySet.has(c.id) || twoWaySet.has(strip(c.id));
    overlapTerms.push({ i, j, cost: c.cost, twoWay });
    if (twoWay) cons.push(` tw_${i}_${j}: rh_${i} - rp_${j} = 0`);
    else cons.push(` sr_${i}_${j}: rh_${i} + rp_${j} <= 1`);
  });
  // The freed slot = the overlap. For a two-way card rh_i = rp_j, so subtracting
  // rh_i once removes the double-count from roster size + cost.
  const twoWay = overlapTerms.filter((o) => o.twoWay);
  const overlapCount = twoWay.map((o) => `rh_${o.i}`);

  // 2b — a two-way card frees a roster slot; it may add a HITTER only if that hitter STARTS,
  // otherwise it becomes an extra pitcher. Cap total hitters at max(nHitters, #starting hitters):
  // a spare BENCH bat can never inflate the hitter count past nHitters, but a fully-platooned
  // lineup that starts MORE than nHitters distinct hitters still can. Big-M disjunction — y=0 ⇒
  // Σrh ≤ nHitters (the usual regime), y=1 ⇒ Σrh ≤ Σstarters (every rostered hitter must start).
  // The solver takes whichever regime yields the better roster.
  if (eweins && twoWay.length && stVars.length) {
    const M = hitters.length;
    bin.push("y2bh");
    cons.push(` twh_base: ${rhVars.join(" + ")} - ${M} y2bh <= ${opts.nHitters}`);
    cons.push(` twh_plat: ${rhVars.join(" + ")} - ${stVars.join(" - ")} + ${M} y2bh <= ${M}`);
  }

  // ── Roster size (distinct cards) — the hard equality ──
  const rosterSize = opts.rosterSize ?? opts.nHitters + opts.nPitchers;
  const sizeTerms = [...rhVars, ...rpVars, ...overlapCount.map((v) => `- ${v}`)];
  cons.push(` rsize: ${sizeTerms.join(" + ").replace(/\+ -/g, "-")} = ${rosterSize}`);

  // ── Variant cap (S-6): ≤ maxVariants rostered VARIANT cards (0/undefined ⇒ unlimited).
  // A variant candidate's id carries the `#V` display suffix. Count each physical card ONCE:
  // sum variant hitter + variant pitcher memberships, minus the two-way overlap (a two-way
  // variant holds both an rh and rp for one card) — mirroring the rsize netting. A single-role
  // variant in both pools can't double (its sr constraint caps rh+rp ≤ 1). Locks that force
  // more variants than the cap yield an Infeasible, same as any other lock conflict.
  const maxVar = opts.maxVariants ?? 0;
  if (maxVar > 0) {
    const isVariant = (id: string) => /#V$/.test(id);
    const vTerms = [
      ...hitters.map((c, i) => (isVariant(c.id) ? `rh_${i}` : null)),
      ...pitchers.map((c, j) => (isVariant(c.id) ? `rp_${j}` : null)),
      ...twoWay.filter((o) => isVariant(hitters[o.i]!.id)).map((o) => `- rh_${o.i}`),
    ].filter((x): x is string => x != null);
    if (vTerms.length) cons.push(` maxvar: ${vTerms.join(" + ").replace(/\+ -/g, "-")} <= ${maxVar}`);
  }

  // ── Required cards (locks): force the entity onto the roster ──
  const locked = new Set(opts.lockedIds ?? []);
  if (locked.size) {
    const isLocked = (id: string) => locked.has(strip(id)) || locked.has(id);
    // A locked card present in BOTH pools needs care:
    //   • two-way (rh_i = rp_j): lock the hitter var; the pitcher var follows.
    //   • single-role (rh_i + rp_j ≤ 1): do NOT pin the hitter var — that would force
    //     the pitcher var to 0 and strand a pitcher on the bench. Instead force the
    //     pair onto the roster (≥ 1); the ≤ 1 sr constraint + the objective then pick
    //     the better role (e.g. a locked SP stays an SP, not a low-value bench bat).
    // A pure hitter / pure pitcher is locked via its own membership.
    const twoWayHIdx = new Set(twoWay.map((o) => o.i));
    const srPairByH = new Map<number, number>();
    for (const o of overlapTerms) if (!o.twoWay) srPairByH.set(o.i, o.j);
    const lockedH = new Set<number>();
    hitters.forEach((c, i) => {
      if (!isLocked(c.id)) return;
      const j = srPairByH.get(i);
      if (j != null) cons.push(` lock_sr_${i}_${j}: rh_${i} + rp_${j} >= 1`);
      else cons.push(` lock_h_${i}: rh_${i} = 1`);
      lockedH.add(i);
    });
    pitchers.forEach((c, j) => {
      const i = hIdxById.get(c.id);
      if (i != null && (lockedH.has(i) || twoWayHIdx.has(i))) return; // covered above / rh=rp
      if (isLocked(c.id)) cons.push(` lock_p_${j}: rp_${j} = 1`);
    });
  }

  // ── Staff role locks: pin a pitcher to the rotation (SP) or bullpen (RP) ──
  // SP ⇒ the pitcher must hold exactly one rotation slot (Σ_k xp_j_sk = 1); RP ⇒ it holds
  // none (= 0), so it's a reliever. Rostering is forced separately via lockedIds. An "sp"
  // lock on a non-qualified arm has no slot vars and is silently ignored (server flags it).
  for (const lk of opts.staffLocks ?? []) {
    const j = pitchers.findIndex((c) => strip(c.id) === strip(lk.id) || c.id === lk.id);
    if (j < 0) continue;
    const slotTerms = pCard[j];
    if (lk.role === "sp") { if (slotTerms?.length) cons.push(` splock_${j}: ${slotTerms.join(" + ")} = 1`); }
    else if (slotTerms?.length) cons.push(` rplock_${j}: ${slotTerms.join(" + ")} = 0`);
  }

  // ── Lineup position locks (S5.3): pin a hitter to a position in one platoon
  // lineup. yh_i_pos_vS = 1 → the fill_pos_vS = 1 constraint forces every other
  // candidate at that (pos, side) to 0, displacing whoever the LP would have
  // placed there; hone links it to rh_i so the locked card is rostered. A lock to
  // a position the card can't start (var never emitted) is silently skipped. ──
  const hIdxByBase = new Map<string, number>(); hitters.forEach((c, i) => hIdxByBase.set(strip(c.id), i));
  for (const lk of opts.lineupLocks ?? []) {
    const i = hIdxByBase.get(strip(lk.id));
    if (i == null) continue;
    const c = hitters[i]!;
    // Allow the lock at any ELIGIBLE position (the yh var was emitted above for it).
    if (!positions.includes(lk.pos) || !(c.playPositions ?? c.positions).includes(lk.pos)) continue;
    cons.push(` lkpos_${i}_${lk.pos}_v${lk.side}: yh_${i}_${lk.pos}_v${lk.side} = 1`);
  }

  // ── Budget ──
  if (opts.mode === "cap" && opts.totalCap != null) {
    const terms = [
      ...hitters.map((c, i) => `${c.cost} rh_${i}`),
      ...pitchers.map((c, j) => `${c.cost} rp_${j}`),
      ...twoWay.map((o) => `- ${o.cost} rh_${o.i}`), // two-way card costs once
    ];
    cons.push(` cap: ${terms.join(" + ").replace(/\+ -/g, "-")} <= ${opts.totalCap}`);
  } else if (opts.mode === "slots" && opts.slotCounts) {
    for (const { threshold, limit } of cumulativeSlotLimits(opts.slotCounts, rosterSize)) {
      const terms = [
        ...hitters.map((c, i) => ({ cost: c.cost, v: `rh_${i}` })),
        ...pitchers.map((c, j) => ({ cost: c.cost, v: `rp_${j}` })),
      ].filter((x) => x.cost >= threshold).map((x) => x.v);
      // subtract two-way overlaps that clear the tier (counted once)
      const subs = twoWay.filter((o) => o.cost >= threshold).map((o) => `- rh_${o.i}`);
      if (terms.length) cons.push(` tier_${threshold}: ${[...terms, ...subs].join(" + ").replace(/\+ -/g, "-")} <= ${limit}`);
    }
  }

  // (Segment DIALS are now pure objective PREFERENCE weights — applied inline to each segment's
  // value terms above via wLineup/wBench/wRotation/wBullpen — NOT spend caps. See segmentWeights.)

  const lp = ["Maximize", ` obj: ${obj.join(" + ").replace(/\+ -/g, "-")}`, "Subject To", ...cons, "Binaries", ` ${bin.join(" ")}`, "End"].join("\n");
  return { lp, vars: bin.length, constraints: cons.length };
}
