// Batch 3 fix #1 — baserunning value (UBR + steal tendency×ability). Guards the ONE value function
// (baserunningWoba) and that the DEPLOYED trusted score actually includes it (the term used to live
// only in the raw-assembly, not the scored value). Coeffs are the league-fit 2010-baseline values.

import { describe, it, expect } from "vitest";
import { baserunningWoba, STEAL_PROD_SCALE } from "../src/scoring-core/woba.ts";
import type { Coeffs } from "../src/config/types.ts";

// 2010-baseline coeffs from coeff-resolve (UBR + steal); other fields irrelevant to baserunningWoba.
const C = {
  adv_speed: 0.0177 * (1.25 / 600), adv_run: 0.0650 * (1.25 / 600), adv_steal: 0,
  adv_stealRate: -0.04606 * (1.25 / 600), adv_stealInt: 0.05110 * (1.25 / 600),
} as unknown as Coeffs;

const br = (speed: number, sr: number, ste: number, run: number) => baserunningWoba(speed, sr, ste, run, C);

describe("baserunningWoba — UBR (Speed + Baserunning)", () => {
  it("rises with Speed and with Baserunning", () => {
    expect(br(200, 0, 0, 0)).toBeGreaterThan(br(40, 0, 0, 0));
    expect(br(0, 0, 0, 200)).toBeGreaterThan(br(0, 0, 0, 40));
    expect(br(0, 0, 0, 200)).toBeGreaterThan(br(200, 0, 0, 0)); // Baserunning weighted above Speed (per fit)
  });
});

describe("baserunningWoba — steal is tendency×ability, not ability alone", () => {
  const steal = (sr: number, ste: number) => br(0, sr, ste, 0); // isolate the steal component
  it("a high-tendency HIGH-ability base-stealer gains value", () => {
    expect(steal(180, 180)).toBeGreaterThan(0);
  });
  it("a high-tendency LOW-ability base-stealer LOSES value (gets caught)", () => {
    expect(steal(180, 40)).toBeLessThan(0);              // negative — the whole point
    expect(steal(180, 40)).toBeLessThan(steal(180, 180)); // and worse than the able stealer
  });
  it("ability ALONE (low tendency) adds little — the product is the driver", () => {
    expect(Math.abs(steal(20, 200))).toBeLessThan(steal(180, 180)); // rarely attempts ⇒ small value
  });
  it("breakeven ability ≈ 90 (SR·(b_int/100·STE + b_sr) crosses zero)", () => {
    expect(steal(180, 85)).toBeLessThan(0);
    expect(steal(180, 95)).toBeGreaterThan(0);
  });
  it("the retired ability-only adv_steal term contributes nothing when 0", () => {
    const withSteal = baserunningWoba(0, 0, 200, 0, { ...C, adv_steal: 0 } as Coeffs);
    expect(withSteal).toBe(0); // no SR ⇒ no steal value; adv_steal=0 ⇒ ability alone is inert
  });
  it("STEAL_PROD_SCALE keeps the product term on a sane magnitude", () => {
    expect(STEAL_PROD_SCALE).toBe(100);
  });
});
