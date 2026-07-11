// T-5 — the direction-aware monotone cap on degree-2 rawpoly curves. A quadratic that turns
// over past an INTERIOR vertex must be flattened on the WRONG-direction tail only, for BOTH
// increasing and decreasing events, and never wholesale-flattened. The uncapped curve stays
// available (rateRaw) so the gate can still see the corruption.

import { describe, it, expect } from "vitest";
import { rate, rateRaw, capActive, type FittedEvent } from "../src/model/curves.ts";

// A rawpoly-2 event with an explicit z-domain. beta = [b0, b1, b2] on u = (v-mu)/sd.
const mk = (beta: number[], uMin: number, uMax: number): FittedEvent =>
  ({ beta, mu: 0, sd: 1, curve: { kind: "rawpoly", degree: 2 }, uMin, uMax });

describe("T-5 direction-aware monotone cap", () => {
  it("increasing event (∩, interior peak): flat past the peak, rising before it", () => {
    // f(u) = u − 0.25u²  → peak at u=2 (interior of [-3,3]); increasing for u<2.
    const e = mk([0, 1, -0.25], -3, 3);
    // rising region preserved
    expect(rate(e, 1)).toBeGreaterThan(rate(e, 0));
    // past the peak: flat, NEVER decreasing
    expect(rate(e, 3)).toBeCloseTo(rate(e, 2), 9);
    expect(rate(e, 2.5)).toBeGreaterThanOrEqual(rate(e, 2) - 1e-9);
    // the uncapped curve DOES decrease past the peak (gate must see this)
    expect(rateRaw(e, 3)).toBeLessThan(rateRaw(e, 2));
    expect(capActive(e, -3, 3)).toBe(true);
  });

  it("decreasing event (∪, interior valley): flat past the valley, falling before it — NOT wholesale-flattened", () => {
    // f(u) = 5 − u + 0.25u²  → valley at u=2 (interior); decreasing for u<2, rising after. The +5
    // intercept keeps values positive (rate() floors at 0). Intended direction is DECREASING
    // (f(−3) ≫ f(3)); the RISING tail (u>2) is the violation.
    const e = mk([5, -1, 0.25], -3, 3);
    // falling region preserved (a better/lower-rated card still separates)
    expect(rate(e, 1)).toBeLessThan(rate(e, 0));
    expect(rate(e, 0)).toBeLessThan(rate(e, -1));
    // past the valley: flat, never rising back up
    expect(rate(e, 3)).toBeCloseTo(rate(e, 2), 9);
    expect(rate(e, 2.5)).toBeLessThanOrEqual(rate(e, 2) + 1e-9);
    // NOT wholesale flattened: the pre-valley domain keeps its spread
    expect(Math.abs(rate(e, -3) - rate(e, 2))).toBeGreaterThan(0.5);
    // uncapped rises after the valley (the corruption the gate must catch)
    expect(rateRaw(e, 3)).toBeGreaterThan(rateRaw(e, 2));
  });

  it("vertex outside the domain: no cap (curve already monotone over the domain)", () => {
    // peak at u=10, domain [-3,3] → increasing throughout, nothing to clamp.
    const e = mk([0, 1, -0.05], -3, 3);
    expect(capActive(e, -3, 3)).toBe(false);
    for (const u of [-3, -1, 0, 2, 3]) expect(rate(e, u)).toBeCloseTo(rateRaw(e, u), 9);
  });

  it("legacy artifact (no fit domain): falls back to the old increasing-only clamp", () => {
    // Same ∩ curve but WITHOUT uMin/uMax → old behavior: clamp above the peak only.
    const e: FittedEvent = { beta: [0, 1, -0.25], mu: 0, sd: 1, curve: { kind: "rawpoly", degree: 2 } };
    expect(rate(e, 3)).toBeCloseTo(rate(e, 2), 9); // flat past peak (unchanged deployed behavior)
    expect(rate(e, 1)).toBeGreaterThan(rate(e, 0));
  });
});
