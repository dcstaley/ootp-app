// Platoon capture ρ in the SELECTION objective (docs/PLATOON_SPECIALIST_FINDINGS_2026-07-25.md).
//
// The defect: `platoonCapture` (ρ, default 0.8) — the parameter whose own docstring says it curbs
// "over-valuation of platoon specialists" — was applied in the E[wins] EVALUATOR (eval/offense.ts
// via assign.ts `effectiveWoba`) and NOWHERE in the MILP that picks the roster. The optimizer
// maximised at ρ=1 (every card always gets its favourable matchup) and the app then reported a
// win% computed at ρ=0.8. Measured across 47 tournaments: rostered hitters carried 2.1× the platoon
// spread of the top of their own pool, and the rosters matched "top-N by max(vR,vL)" to three
// decimals — the fingerprint of valuing every card at its favourable side.
//
// These tests are solve-driven (real HiGHS), not objective-string reading, and they assert BOTH
// directions on one fixture: ρ=1 reproduces the old pick (the specialist), ρ<1 flips it to the
// balanced bat. The ρ=1 leg is what makes this a genuine regression test — it fails on the fixed
// build if ρ is ever hard-wired, and it is exactly the pre-fix behaviour, so the ρ<1 leg is the
// assertion the pre-fix build could not satisfy.

import { describe, it, expect } from "vitest";
import { buildRosterLp } from "../src/optimizer/roster-lp.ts";
import { generateFullRoster } from "../src/optimizer/generate.ts";
import { effectiveValue, effectiveWoba, sideWoba } from "../src/optimizer/assign.ts";
import type { HitterCandidate, PitcherCandidate, RosterOptimizeOptions } from "../src/optimizer/index.ts";

const FIELD = ["C", "1B", "2B", "3B", "SS", "LF", "CF", "RF"];
const filler = (pos: string, v: number): HitterCandidate =>
  ({ id: `f_${pos}`, title: `F_${pos}`, bats: 1, valueVR: v, valueVL: v, positions: [pos], coverPositions: FIELD, playPositions: [pos], cost: 75 });

// Two rivals for the single 1B slot, same cost, so the contest is purely objective value.
// Platoon blend at 0.62/0.38 (ρ=1, i.e. today's objective):
//   BALANCED  0.62·0.0500 + 0.38·0.0500 = 0.05000
//   SPECIAL   0.62·0.0750 + 0.38·0.0100 = 0.05030   ← wins, by 0.0003
// The SAME pair under ρ=0.8 (both sides bled 20% toward the off side):
//   BALANCED  unchanged                  = 0.05000
//   SPECIAL   0.62·0.0620 + 0.38·0.0230 = 0.04718   ← loses, by 0.0028
// So the fixture straddles the flip: the winner is decided by ρ and nothing else.
const BALANCED: HitterCandidate = { id: "BALANCED", title: "Balanced", bats: 1, valueVR: 0.05, valueVL: 0.05, positions: ["1B"], coverPositions: FIELD, playPositions: ["1B"], cost: 75 };
const SPECIAL: HitterCandidate = { id: "SPECIAL", title: "Specialist", bats: 2, valueVR: 0.075, valueVL: 0.01, positions: ["1B"], coverPositions: FIELD, playPositions: ["1B"], cost: 75 };

// 1B filler is deliberately weak so the real contest is BALANCED vs SPECIAL for the 1B slot.
const POOL: HitterCandidate[] = [...FIELD.filter((p) => p !== "1B").map((p) => filler(p, 0.04)), filler("1B", 0.001), BALANCED, SPECIAL];
const ARMS: PitcherCandidate[] = Array.from({ length: 6 }, (_, k) => (
  { id: `p${k}`, title: `P${k}`, throws: 1, valueVR: 0.03 - k * 0.001, valueVL: 0.03 - k * 0.001, stamina: 80, pitchTypes: 4, cost: 75 }
));
// dh:false + nHitters:8 over 8 field positions ⇒ EVERY rostered hitter starts both sides, so the
// bench-depth term nets to zero (zst) and this isolates the LINEUP value term.
const BASE: RosterOptimizeOptions = {
  nHitters: 8, nPitchers: 5, rosterSize: 13, dh: false, minStarters: 3,
  minStarterStamina: 70, minPitchTypes: 3, minPlayersPerPosition: 1, backupCatcherDepth: 1,
  platoonVR: 0.62, platoonVL: 0.38, mode: "none",
};
// Cap mode with usage weights = the production cap/slots (E[wins]) objective branch. The defect is
// mode-independent (measured non-cap 0.0313 vs cap/slots 0.0316), so both branches are covered.
const CAP: RosterOptimizeOptions = {
  ...BASE, mode: "cap", totalCap: 5000,
  usageWeights: { lineupPA: 689, benchPA: 82.7, rotationBF: [900, 800, 700], bullpenBF: [300, 200, 150, 100, 100, 100] },
};

describe("platoon capture ρ — the selection objective must use the evaluator's function", () => {
  it("effectiveValue at ρ=1 is the raw per-side value, BIT-for-bit (the reproduction gate)", () => {
    // Not toBeCloseTo: the whole point is that ρ=1 leaves today's objective coefficients untouched
    // to the last bit, so shipping ρ can never silently perturb an existing roster.
    expect(Object.is(effectiveValue(SPECIAL, "R", 1), SPECIAL.valueVR)).toBe(true);
    expect(Object.is(effectiveValue(SPECIAL, "L", 1), SPECIAL.valueVL)).toBe(true);
    expect(Object.is(effectiveValue(SPECIAL, "R"), SPECIAL.valueVR)).toBe(true); // default arg
  });

  it("effectiveValue is effectiveWoba on the signed-distance scale (ONE blend, not two copies)", () => {
    for (const rho of [1, 0.8, 0.5, 0]) for (const side of ["R", "L"] as const) {
      const anchor = sideWoba(SPECIAL, side) - (side === "R" ? SPECIAL.valueVR : SPECIAL.valueVL);
      expect(effectiveValue(SPECIAL, side, rho)).toBeCloseTo(effectiveWoba(SPECIAL, side, rho) - anchor, 12);
    }
  });

  it("an absent platoonCapture builds the IDENTICAL LP to an explicit ρ=1", () => {
    for (const opts of [BASE, CAP]) {
      expect(buildRosterLp(POOL, ARMS, { ...opts, platoonCapture: 1 }).lp).toBe(buildRosterLp(POOL, ARMS, opts).lp);
    }
  });

  // The two legs of the fix, on the same pool, differing ONLY in ρ.
  for (const [label, opts] of [["non-cap", BASE], ["cap/slots (E[wins])", CAP]] as const) {
    it(`${label}: ρ=1 takes the specialist (the pre-fix behaviour, pinned)`, async () => {
      const r = await generateFullRoster(POOL, ARMS, { ...opts, platoonCapture: 1 });
      expect(r.status).toBe("Optimal");
      expect(r.hitters).toContain("SPECIAL");
      expect(r.hitters).not.toContain("BALANCED");
    });

    it(`${label}: ρ<1 takes the balanced bat instead`, async () => {
      const r = await generateFullRoster(POOL, ARMS, { ...opts, platoonCapture: 0.8 });
      expect(r.status).toBe("Optimal");
      expect(r.hitters).toContain("BALANCED");
      expect(r.hitters).not.toContain("SPECIAL");
    });
  }

  it("ρ shrinks the rostered platoon spread, it does not merely reshuffle", async () => {
    const spread = async (rho: number) => {
      const r = await generateFullRoster(POOL, ARMS, { ...BASE, platoonCapture: rho });
      const by = new Map(POOL.map((c) => [c.id, c]));
      const gaps = r.hitters.map((id) => Math.abs(by.get(id)!.valueVR - by.get(id)!.valueVL));
      return gaps.reduce((s, x) => s + x, 0) / gaps.length;
    };
    expect(await spread(0.8)).toBeLessThan(await spread(1));
  });
});

// SECOND, SEPARABLE fix (findings §5 / §8 Option 2): the bench-depth credit keyed on
// max(valueVR, valueVL). `zst` nets that credit away for STARTERS, so only PURE bench bats were
// affected — and they came out the most lopsided segment of the roster (bench gap 0.0336 vs 0.0126
// for both-sides starters). Unlike the ρ threading this changes the objective even at ρ=1, which is
// why it is called out separately here.
describe("bench-depth credit — a card that never starts is not priced at its better side", () => {
  // Room for one PURE bench bat: 9 hitters for 8 field slots.
  const BENCH_BASE: RosterOptimizeOptions = { ...BASE, nHitters: 9, rosterSize: 14 };
  // Neither rival can start — both are 1B-only behind a much better 1B — so they compete purely
  // for the one bench slot, which is what the bench-depth term is supposed to price.
  const STRONG_1B = { ...filler("1B", 0.09), id: "STRONG_1B" };
  // OLD credit, max(vR,vL):        BAL 0.050  ·  SPEC 0.060  → the specialist wins
  // NEW credit, ρ-blended platoon: BAL 0.050  ·  SPEC 0.572·0.060 + 0.428·0.010 = 0.0386 → BAL wins
  // (at ρ=0.8 the platoon weights 0.62/0.38 bleed to 0.572/0.428 — see effectiveValue).
  const BENCH_BAL: HitterCandidate = { id: "BENCH_BAL", title: "Bench balanced", bats: 1, valueVR: 0.05, valueVL: 0.05, positions: ["1B"], coverPositions: FIELD, playPositions: ["1B"], cost: 75 };
  const BENCH_SPEC: HitterCandidate = { id: "BENCH_SPEC", title: "Bench specialist", bats: 2, valueVR: 0.06, valueVL: 0.01, positions: ["1B"], coverPositions: FIELD, playPositions: ["1B"], cost: 75 };
  const BPOOL = [...FIELD.filter((p) => p !== "1B").map((p) => filler(p, 0.04)), STRONG_1B, BENCH_BAL, BENCH_SPEC];

  it("the bench credit follows the platoon blend, so the balanced bench bat is taken", async () => {
    const r = await generateFullRoster(BPOOL, ARMS, { ...BENCH_BASE, platoonCapture: 0.8 });
    expect(r.status).toBe("Optimal");
    expect(r.hitters).toContain("BENCH_BAL");
    expect(r.hitters).not.toContain("BENCH_SPEC");
    // …and it really is a pure bench bat: the strong 1B holds the slot in both lineups.
    expect(r.lineupVR.find((s) => s.pos === "1B")!.id).toBe("STRONG_1B");
    expect(r.lineupVL.find((s) => s.pos === "1B")!.id).toBe("STRONG_1B");
  });

  it("…and it is the CREDIT that changed, not a lineup effect: rh coef is the blend, not max()", () => {
    const lp = buildRosterLp(BPOOL, ARMS, { ...BENCH_BASE, platoonCapture: 0.8 }).lp;
    const obj = lp.split("\n").find((l) => l.trim().startsWith("obj:"))!;
    const coefOf = (v: string) => {
      for (const m of obj.matchAll(/([+-]?)\s*(-?\d+(?:\.\d+)?)\s+(\S+)/g)) if (m[3] === v) return (m[1] === "-" ? -1 : 1) * Number(m[2]);
      return 0;
    };
    const i = (id: string) => BPOOL.findIndex((c) => c.id === id);
    expect(coefOf(`rh_${i("BENCH_SPEC")}`)).toBeCloseTo(0.3 * (0.572 * 0.06 + 0.428 * 0.01), 6); // 0.011580
    expect(coefOf(`rh_${i("BENCH_SPEC")}`)).toBeLessThan(0.3 * 0.06);                            // NOT max(vR,vL)
    expect(coefOf(`rh_${i("BENCH_BAL")}`)).toBeCloseTo(0.3 * 0.05, 6);                           // balanced: blend == max
  });
});
