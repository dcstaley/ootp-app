// Pool-strength rating transform — a mean-scalar lift, faded BEFORE the trained max, HARD-CAPPED
// at max + buffer. It must (1) lift a weaker pool toward the league by the MEAN ratio (preserving
// true lows + relative spacing) in the bulk, (2) aggressively fade the lift as a rating nears the
// trained max, (3) never lift past C + buffer and keep a rating at/above C + buffer at its raw
// value, and (4) be the identity when there's no lift (k = 1).

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

  it("the lift PEAKS below the max, then AGGRESSIVELY fades approaching it", () => {
    const gap = (r: number) => applyAffine(r, m) - r;
    const g = [60, 100, 150, 190].map(gap);
    const peak = Math.max(...g), peakAt = g.indexOf(peak);
    expect(peakAt).toBeGreaterThan(0);            // not at the very bottom
    expect(peakAt).toBeLessThan(g.length - 1);    // and not at the very top — it's a hump below C
    // strictly shrinking as the rating climbs toward the max
    expect(gap(180)).toBeLessThan(gap(150));
    expect(gap(190)).toBeLessThan(gap(180));
  });

  it("HARD-CAPS the lift at C + buffer, and keeps raw at/above it", () => {
    const B = 5; // MAX_BUFFER
    for (const r of [150, 190, 200, 204]) expect(applyAffine(r, m)).toBeLessThanOrEqual(C + B + 1e-9);
    // a rating just under the max can be nudged up to the buffer (here 200 → 205)
    expect(applyAffine(200, m)).toBeCloseTo(C + B, 6);
    // at/above C + buffer, the raw rating is kept exactly (elite / off-chart cards untouched)
    expect(applyAffine(C + B, m)).toBeCloseTo(C + B, 6);
    expect(applyAffine(280, m)).toBeCloseTo(280, 6);
    expect(applyAffine(400, m)).toBeCloseTo(400, 6);
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
