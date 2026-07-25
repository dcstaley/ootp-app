// Non-budgeted (Top-X) roster objective: "just pick the best players per role."
// Versus cap/slots it (a) drops rotation slot-decay and (b) drops the both-sides bonus.
// The rule both modes share: a card deployed as a STARTER is valued once, as a starter —
// a slotted SP is not also credited the bullpen (RP-blend) value it won't pitch, and a
// lineup starter is not also credited bench-depth value. Depth is STILL valued (uniform
// bench/bullpen membership) so the best-available reliever/bench bat fills each spot.

import { describe, it, expect } from "vitest";
import { buildRosterLp } from "../src/optimizer/roster-lp.ts";
import { generateFullRoster } from "../src/optimizer/generate.ts";
import { blendPitch, type PitchSplit, type HitterCandidate, type PitcherCandidate, type RosterOptimizeOptions } from "../src/optimizer/index.ts";

// Coefficient of a single variable on the LP objective line (" obj: c1 v1 + c2 v2 - c3 v3 …").
// NOTE: the builder folds "+ -" into "-" (roster-lp.ts, the `.replace(/\+ -/g, "-")` on the obj
// line), so splitting on " + " alone silently returns 0/NaN for every NETTED (negative) term —
// i.e. exactly the terms these tests now assert on. Tokenise instead: read sign + number + var.
function coefOf(lp: string, v: string): number {
  const obj = lp.split("\n").find((l) => l.trim().startsWith("obj:"))!.replace(/^\s*obj:\s*/, "");
  for (const m of obj.matchAll(/([+-]?)\s*(-?\d+(?:\.\d+)?)\s+(\S+)/g)) {
    if (m[3] === v) return (m[1] === "-" ? -1 : 1) * Number(m[2]);
  }
  return 0;
}

const ps: PitchSplit = { sp: { r: 0.47, l: 0.27 }, rp: { r: 0.5, l: 0.33 } };
const HIT: HitterCandidate[] = [
  { id: "h1", title: "H1", bats: 1, valueVR: 0.05, valueVL: 0.04, positions: ["1B", "DH"], coverPositions: ["1B"], playPositions: ["1B", "DH"], cost: 60 },
];
const PIT: PitcherCandidate[] = [
  // LHP starter, deliberately better vs RHB (vR) than vs LHB (vL) so vSP ≠ vRP.
  { id: "p1", title: "P1", throws: 2, valueVR: 0.05, valueVL: 0.02, stamina: 80, pitchTypes: 4, cost: 60 },
];
const BASE: RosterOptimizeOptions = {
  nHitters: 1, nPitchers: 1, dh: true, minStarters: 2, minStarterStamina: 70, minPitchTypes: 3,
  platoonVR: 0.58, platoonVL: 0.42, pitchSplit: ps, mode: "none",
};

const vSP = blendPitch(0.05, 0.02, 2, "sp", ps, 0.58, 0.42);
const vRP = blendPitch(0.05, 0.02, 2, "rp", ps, 0.58, 0.42);
const relief = 0.15 * vRP; // default bullpenWeight
// RE-BASELINED (2026-07-25, findings §5 / §8 Option 2): the bench-depth credit was
// `benchWeight · max(vR, vL)`; it is now `benchWeight · platoon-blended value`, because a card that
// never starts has no platoon assignment and pricing it at its better side made pure bench bats the
// most lopsided segment of the roster. This fixture carries no platoonCapture (ρ=1), so the change
// visible here is the FORM of the credit alone — the ρ threading is exactly neutral at ρ=1.
const bench = 0.3 * (0.58 * 0.05 + 0.42 * 0.04);  // benchWeight · (platoonVR·vR + platoonVL·vL)

describe("non-cap objective — pick the best players per role (cap/slots unchanged)", () => {
  const none = buildRosterLp(HIT, PIT, { ...BASE, mode: "none" }).lp;
  const cap = buildRosterLp(HIT, PIT, { ...BASE, mode: "cap", totalCap: 1000 }).lp;

  it("non-cap: a slotted starter is valued by vSP alone (no double-credited relief)", () => {
    expect(coefOf(none, "rp_0") + coefOf(none, "xp_0_s1")).toBeCloseTo(vSP, 6);
  });

  // RE-BASELINED (2026-07-25) — was `toBeCloseTo(vSP + relief)`, i.e. it pinned the legacy cap
  // branch's SP/relief double-count as correct. That assertion is left as-is on purpose: this
  // fix is the HITTER half only (the pitcher legacy netting is a separate, unreached-in-production
  // path — production cap/slots always supplies usageWeights, whose branch already nets it, and
  // refineUpgrades now does too). Renamed so the name no longer reads as an endorsement.
  it("cap (legacy, no usageWeights): the SP relief double-credit still lives in this branch", () => {
    expect(coefOf(cap, "rp_0") + coefOf(cap, "xp_0_s1")).toBeCloseTo(vSP + relief, 6);
  });

  // RE-BASELINED (2026-07-25). This used to assert `coefOf(*, "rh_0") == bench` and call it
  // "bench stays valued" — but h1 STARTS in this fixture (nHitters:1, dh:true), so what it
  // actually pinned was the hitter bench double-count: a lineup starter paid both its lineup
  // value AND 0.3·max(vR,vL). Because the bench credit keys on max(vR,vL) while the lineup term
  // keys on the platoon blend, that systematically over-paid platoon specialists. The netting
  // (zst) is now emitted in every mode, so the correct expectation is: rh still carries the
  // bench credit (a PURE bench bat keeps it), and zst cancels it exactly for a starter.
  it("both modes: a hitter who STARTS nets zero bench credit; a pure bench bat keeps it", () => {
    for (const lp of [none, cap]) {
      expect(coefOf(lp, "rh_0")).toBeCloseTo(bench, 6);   // depth value, for a card that doesn't start
      expect(coefOf(lp, "zst_0")).toBeCloseTo(-bench, 6); // …cancelled the moment it starts a side
      expect(coefOf(lp, "rh_0") + coefOf(lp, "zst_0")).toBeCloseTo(0, 9);
    }
  });

  it("both modes: relievers stay valued (uniformly) so the best available fills the bullpen", () => {
    expect(coefOf(none, "rp_0")).toBeCloseTo(relief, 6);
    expect(coefOf(cap, "rp_0")).toBeCloseTo(relief, 6);
  });

  it("non-cap: no rotation slot-decay (every SP slot weighs the same)", () => {
    expect(coefOf(none, "xp_0_s1")).toBeCloseTo(coefOf(none, "xp_0_s2"), 6);
  });

  // NOT re-baselined: slot decay is D5's deliberate starters-≫-support economics, not a defect
  // (findings doc §1.4). This fix removes role OVERLAP only; it does not flatten role weights.
  it("cap: rotation slots decay (slot 1 > slot 2)", () => {
    expect(coefOf(cap, "xp_0_s1")).toBeGreaterThan(coefOf(cap, "xp_0_s2"));
  });

  it("non-cap: no both-sides bonus on a platoon-neutral hitter", () => {
    expect(coefOf(none, "yh_0_1B_vR")).toBeCloseTo(0.58 * 0.05, 6);
  });

  // NOT re-baselined: the both-sides bonus is an out-of-scope legacy weight (see the task's
  // OUT OF SCOPE note + findings doc §1.5). Still pinned so a later change to it is deliberate.
  it("cap: both-sides bonus applies to a platoon-neutral hitter", () => {
    expect(coefOf(cap, "yh_0_1B_vR")).toBeCloseTo(1.25 * 0.58 * 0.05, 6);
  });
});

// REGRESSION (2026-07-25) — the defect this file previously asserted as correct, caught by an
// actual solve rather than by reading the objective string. Pool shaped so exactly one roster
// spot is contested and EVERY rostered hitter starts (8 field positions, dh:false, nHitters:8):
// there is no legitimate bench role at all, so any bench credit paid here is pure double-count.
// The two rivals for 1B have near-identical platoon-blended lineup value, but the specialist has
// the higher max(vR,vL) — the quantity the bench credit keys on. Pre-fix the specialist won by
// 0.00344 of spurious credit against a real gap of 0.00016 (22×); post-fix the better lineup
// card wins. Numbers from docs/CAP_SLOTS_DOUBLE_COUNT_FINDINGS_2026-07-25.md §2.1.
describe("non-cap regression — the bench credit must not out-vote real lineup value", () => {
  const FIELD = ["C", "1B", "2B", "3B", "SS", "LF", "CF", "RF"];
  const filler = (pos: string, v: number): HitterCandidate =>
    ({ id: `f_${pos}`, title: `F_${pos}`, bats: 1, valueVR: v, valueVL: v, positions: [pos], coverPositions: FIELD, playPositions: [pos], cost: 75 });
  // Two rivals for the single 1B spot, equal cost. Platoon blend at 0.62/0.38:
  //   C_neutral 0.62·0.050 + 0.38·0.050 = 0.05000   (bench credit 0.3·0.050 = 0.01500)
  //   D_special 0.62·0.062 + 0.38·0.030 = 0.04984   (bench credit 0.3·0.062 = 0.01860)
  // C is the better lineup card by 0.00016; D is "better" by 0.00344 of bench credit it can
  // never earn, because it starts.
  const RIVALS: HitterCandidate[] = [
    { id: "C_neutral", title: "C_neutral", bats: 1, valueVR: 0.05, valueVL: 0.05, positions: ["1B"], coverPositions: FIELD, playPositions: ["1B"], cost: 75 },
    { id: "D_special", title: "D_special", bats: 1, valueVR: 0.062, valueVL: 0.03, positions: ["1B"], coverPositions: FIELD, playPositions: ["1B"], cost: 75 },
  ];
  // 1B filler is deliberately weak so the contest is genuinely C vs D for the 1B slot.
  const POOL: HitterCandidate[] = [...FIELD.filter((p) => p !== "1B").map((p) => filler(p, 0.04)), filler("1B", 0.001), ...RIVALS];
  const ARMS: PitcherCandidate[] = Array.from({ length: 6 }, (_, k) => (
    { id: `p${k}`, title: `P${k}`, throws: 1, valueVR: 0.03 - k * 0.001, valueVL: 0.03 - k * 0.001, stamina: 80, pitchTypes: 4, cost: 75 }
  ));
  const OPTS: RosterOptimizeOptions = {
    nHitters: 8, nPitchers: 5, rosterSize: 13, dh: false, minStarters: 3,
    minStarterStamina: 70, minPitchTypes: 3, minPlayersPerPosition: 1, backupCatcherDepth: 1,
    platoonVR: 0.62, platoonVL: 0.38, mode: "none",
  };

  it("non-cap: picks the better lineup bat over the platoon specialist with the bigger max()", async () => {
    const r = await generateFullRoster(POOL, ARMS, OPTS);
    expect(r.status).toBe("Optimal");
    expect(r.hitters).toContain("C_neutral");
    expect(r.hitters).not.toContain("D_special");
  });

  it("non-cap: the contested pair's objective credits equal their lineup value alone", () => {
    const lp = buildRosterLp(POOL, ARMS, OPTS).lp;
    const net = (id: string) => {
      const i = POOL.findIndex((c) => c.id === id);
      return coefOf(lp, `rh_${i}`) + coefOf(lp, `zst_${i}`) + coefOf(lp, `yh_${i}_1B_vR`) + coefOf(lp, `yh_${i}_1B_vL`);
    };
    expect(net("C_neutral")).toBeCloseTo(0.62 * 0.05 + 0.38 * 0.05, 6);   // 0.05000
    expect(net("D_special")).toBeCloseTo(0.62 * 0.062 + 0.38 * 0.03, 6);  // 0.04984
    expect(net("C_neutral")).toBeGreaterThan(net("D_special"));
  });
});
