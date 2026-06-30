// Pool-strength rating transform — a mean-scalar lift with a logistic fade. It must (1) lift a
// weaker pool toward the league by the MEAN ratio (preserving true lows + relative spacing) in
// the bulk, (2) FADE the lift out as a rating nears/exceeds the model's trained max — the gap
// peaking BELOW the max and decaying toward ~0 (never 0, never capped) past it, and (3) be the
// identity when there's no lift (k = 1).

import { describe, it, expect } from "vitest";
import { ratingStats, affineFor, applyAffine, type RatingStats } from "../src/model/pool-transform.ts";

describe("pool-transform — mean-scalar with logistic fade", () => {
  const league: RatingStats = { mu: 120, sd: 20 };
  const weakPool: RatingStats = { mu: 100, sd: 20 }; // k = 120/100 = 1.2 (a realistic weak-pool gap)
  const C = 200;                                      // trained ceiling (fade centered here)
  const m = affineFor(league, weakPool, C);

  it("applies the full mean-scalar lift in the bulk (r ≪ C)", () => {
    expect(m.k).toBeCloseTo(1.2, 9);
    expect(applyAffine(20, m)).toBeCloseTo(24, 0); // ~ ×1.2 (σ ≈ 1 far below C)
    expect(applyAffine(40, m)).toBeCloseTo(48, 0);
  });

  it("preserves true lows — a 1-rating stays ~1, not lifted to the mean", () => {
    expect(applyAffine(1, m)).toBeLessThan(3); // ≈ 1×k = 1.2, NOT ~120
    expect(applyAffine(0, m)).toBeCloseTo(0, 6);
  });

  it("the lift (gap) PEAKS BELOW the max, then DECAYS through and past it toward ~0", () => {
    const gap = (r: number) => applyAffine(r, m) - r;
    const g = [60, 100, 150, 200, 280, 400].map(gap);
    // rises to a peak somewhere in the low/mid range...
    const peak = Math.max(...g), peakAt = g.indexOf(peak);
    expect(peakAt).toBeGreaterThan(0);            // not at the very bottom
    expect(peakAt).toBeLessThan(g.length - 1);    // and not at the very top — it's a hump
    // ...then strictly decreases through and past the max
    expect(gap(200)).toBeLessThan(gap(150));      // shrinking by the max
    expect(gap(280)).toBeLessThan(gap(200));      // keeps shrinking after
    expect(gap(400)).toBeLessThan(gap(280));
    // toward ~0 but NEVER 0 (always at least a touch of lift), and NEVER capped
    expect(gap(400)).toBeGreaterThan(0);
    expect(applyAffine(400, m)).toBeGreaterThan(400); // not capped / not pulled to raw
  });

  it("effective stays monotone increasing (a higher raw never scores lower)", () => {
    let prev = -Infinity;
    for (let r = 0; r <= 500; r += 10) { const e = applyAffine(r, m); expect(e).toBeGreaterThan(prev - 1e-9); prev = e; }
  });

  it("is the identity when there is no lift (pool == league, k = 1)", () => {
    const id = affineFor(league, league, C);
    expect(id.k).toBeCloseTo(1, 9);
    for (const r of [40, 120, 200, 260]) expect(applyAffine(r, id)).toBeCloseTo(r, 6);
  });

  it("no ceiling (Infinity) ⇒ a pure scalar (no fade)", () => {
    const pure = affineFor(league, weakPool, Infinity);
    expect(applyAffine(120, pure)).toBeCloseTo(144, 6); // 120 × 1.2, unfaded
  });

  it("ratingStats ignores 0s (no-rating card-sides) and never returns sd 0", () => {
    expect(ratingStats([100, 100, 100])).toEqual({ mu: 100, sd: 1 });
    expect(ratingStats([0, 0, 60, 100, 140]).mu).toBeCloseTo(100, 9);
  });
});
