// Non-budgeted (Top-X) roster objective: "just pick the best players per role."
// Versus cap/slots it (a) drops rotation slot-decay, (b) drops the both-sides bonus,
// and (c) values a slotted starter on its SP blend ALONE — not also credited the
// bullpen (RP-blend) value it won't pitch (the double-credit that flipped near-tied SP
// picks, e.g. Kralic over Hammaker). Depth is STILL valued (uniform bench/bullpen
// membership) so the best-available reliever/bench bat fills each spot. Cap/slots is
// asserted byte-for-byte unchanged.

import { describe, it, expect } from "vitest";
import { buildRosterLp } from "../src/optimizer/roster-lp.ts";
import { blendPitch, type PitchSplit, type HitterCandidate, type PitcherCandidate, type RosterOptimizeOptions } from "../src/optimizer/index.ts";

// Coefficient of a single variable on the LP objective line (" obj: c1 v1 + c2 v2 + …").
function coefOf(lp: string, v: string): number {
  const obj = lp.split("\n").find((l) => l.trim().startsWith("obj:"))!.replace(/^\s*obj:\s*/, "");
  for (const term of obj.split(" + ")) {
    const parts = term.trim().split(/\s+/);
    if (parts[parts.length - 1] === v) return Number(parts.slice(0, -1).join(" "));
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
const bench = 0.3 * 0.05;  // default benchWeight · max(vR,vL)

describe("non-cap objective — pick the best players per role (cap/slots unchanged)", () => {
  const none = buildRosterLp(HIT, PIT, { ...BASE, mode: "none" }).lp;
  const cap = buildRosterLp(HIT, PIT, { ...BASE, mode: "cap", totalCap: 1000 }).lp;

  it("non-cap: a slotted starter is valued by vSP alone (no double-credited relief)", () => {
    expect(coefOf(none, "rp_0") + coefOf(none, "xp_0_s1")).toBeCloseTo(vSP, 6);
  });

  it("cap: a slotted starter keeps SP slot value PLUS the relief credit (unchanged)", () => {
    expect(coefOf(cap, "rp_0") + coefOf(cap, "xp_0_s1")).toBeCloseTo(vSP + relief, 6);
  });

  it("both modes: relievers + bench stay valued (uniformly) so the best available fill them", () => {
    expect(coefOf(none, "rp_0")).toBeCloseTo(relief, 6); // bullpen arm still valued
    expect(coefOf(none, "rh_0")).toBeCloseTo(bench, 6);  // bench bat still valued
    expect(coefOf(cap, "rp_0")).toBeCloseTo(relief, 6);
    expect(coefOf(cap, "rh_0")).toBeCloseTo(bench, 6);
  });

  it("non-cap: no rotation slot-decay (every SP slot weighs the same)", () => {
    expect(coefOf(none, "xp_0_s1")).toBeCloseTo(coefOf(none, "xp_0_s2"), 6);
  });

  it("cap: rotation slots decay (slot 1 > slot 2)", () => {
    expect(coefOf(cap, "xp_0_s1")).toBeGreaterThan(coefOf(cap, "xp_0_s2"));
  });

  it("non-cap: no both-sides bonus on a platoon-neutral hitter", () => {
    expect(coefOf(none, "yh_0_1B_vR")).toBeCloseTo(0.58 * 0.05, 6);
  });

  it("cap: both-sides bonus applies to a platoon-neutral hitter", () => {
    expect(coefOf(cap, "yh_0_1B_vR")).toBeCloseTo(1.25 * 0.58 * 0.05, 6);
  });
});
