import { describe, it, expect } from "vitest";
import {
  computeBaseline, deploymentFrom, applyDeployment, logit, expit,
  type FieldMember, type RealizedSplits,
} from "../src/eval/exposure.ts";

// A tiny synthetic field where value == an index so top-X selection is deterministic.
function member(bats: number, throws: number, v: number, w = 1): FieldMember {
  return { bats, throws, hitVR: v, hitVL: v, pitVal: v, hitWeight: w, pitWeight: w };
}

describe("exposure baseline", () => {
  it("counts handedness over the top-X field (role-agnostic, usage-weighted)", () => {
    // 6 cards; take top-3. Values 6..1 so the top-3 are the first three.
    const members: FieldMember[] = [
      member(1, 1, 6), // RHB / RHP
      member(2, 2, 5), // LHB / LHP
      member(1, 1, 4), // RHB / RHP
      member(2, 2, 3), // (excluded from top-3)
      member(3, 1, 2),
      member(1, 2, 1),
    ];
    const b = computeBaseline(members, 3);
    // pitcher field top-3 throws = [R,L,R] → 2/3 RHP
    expect(b.platoonVR).toBeCloseTo(2 / 3, 6);
    expect(b.platoonVL).toBeCloseTo(1 / 3, 6);
    // hitter field top-3 bats = [R,L,R] → fRHB=2/3, fLHB=1/3
    expect(b.r_pitch_split).toBeCloseTo(2 / 3, 6); // RHP faces RHB at pop rate
    expect(b.l_pitch_split).toBeCloseTo(1 / 3, 6); // LHP faces LHB at pop rate
    // hit splits derive from platoonVR
    expect(b.r_hit_split).toBeCloseTo(2 / 3, 6);
    expect(b.l_hit_split).toBeCloseTo(1 / 3, 6);
    expect(b.s_hit_split).toBeCloseTo(2 / 3, 6);
  });

  it("usage weights shift the composition", () => {
    // Two pitchers, one RHP with 10x the innings → RHP share ≫ 0.5.
    const members: FieldMember[] = [member(1, 1, 2, 10), member(2, 2, 1, 1)];
    const b = computeBaseline(members, 2);
    expect(b.platoonVR).toBeCloseTo(10 / 11, 6);
  });

  it("switch hitters never count as the pitcher's same-hand batter", () => {
    // All switch hitters → fRHB = fLHB = 0 (pure-hand fractions), so pitchers face 0 same-hand.
    const members: FieldMember[] = [member(3, 1, 3), member(3, 2, 2), member(3, 1, 1)];
    const b = computeBaseline(members, 3);
    expect(b.r_pitch_split).toBeCloseTo(0, 6);
    expect(b.l_pitch_split).toBeCloseTo(0, 6);
  });
});

describe("deployment shift", () => {
  const base = { platoonVR: 0.62, platoonVL: 0.38, r_hit_split: 0.62, l_hit_split: 0.38, s_hit_split: 0.62, r_pitch_split: 0.48, l_pitch_split: 0.38 };
  const realized: RealizedSplits = {
    teamVR: 0.58, r_hit_split: 0.54, l_hit_split: 0.337, s_hit_split: 0.562,
    r_pitch_split_sp: 0.471, l_pitch_split_sp: 0.273, r_pitch_split_rp: 0.499, l_pitch_split_rp: 0.33,
  };

  it("round-trips: applying deployment to its own baseline reconstructs realized", () => {
    const d = deploymentFrom(realized, base);
    const eff = applyDeployment(base, d);
    expect(eff.platoonVR).toBeCloseTo(realized.teamVR, 6);
    expect(eff.r_hit_split).toBeCloseTo(realized.r_hit_split, 6);
    expect(eff.l_hit_split).toBeCloseTo(realized.l_hit_split, 6);
    expect(eff.s_hit_split).toBeCloseTo(realized.s_hit_split, 6);
    expect(eff.r_pitch_split_sp).toBeCloseTo(realized.r_pitch_split_sp, 6);
    expect(eff.l_pitch_split_sp).toBeCloseTo(realized.l_pitch_split_sp, 6);
    expect(eff.r_pitch_split_rp).toBeCloseTo(realized.r_pitch_split_rp, 6);
    expect(eff.l_pitch_split_rp).toBeCloseTo(realized.l_pitch_split_rp, 6);
  });

  it("transfers directionally: a skewed target baseline keeps the deployment pull", () => {
    const d = deploymentFrom(realized, base);
    // A 70%-LHP pool: platoonVR baseline much lower.
    const skewed = { ...base, platoonVR: 0.30, platoonVL: 0.70, r_hit_split: 0.30, l_hit_split: 0.70, s_hit_split: 0.30 };
    const eff = applyDeployment(skewed, d);
    // deployment pulled teamVR DOWN (0.58<0.62), so the skewed effective stays below its baseline.
    expect(eff.platoonVR).toBeLessThan(0.30);
    expect(eff.platoonVR).toBeGreaterThan(0);
  });

  it("null deployment = baseline unchanged", () => {
    const eff = applyDeployment(base, null);
    expect(eff.platoonVR).toBeCloseTo(base.platoonVR, 6);
    expect(eff.r_pitch_split_sp).toBeCloseTo(base.r_pitch_split, 6);
  });

  it("logit/expit are inverse", () => {
    for (const p of [0.05, 0.3, 0.5, 0.62, 0.95]) expect(expit(logit(p))).toBeCloseTo(p, 9);
  });
});
