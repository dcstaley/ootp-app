// Pool-strength rating transform (z-score) — the math must re-base a pool's rating
// distribution onto the league's: a card N SDs above its pool mean lands N SDs above
// the league mean, anchored at the mean (not zero). Guards the property and the
// weak-pool "lift up" direction that's the dominant real case.

import { describe, it, expect } from "vitest";
import { ratingStats, affineFor, applyAffine, type RatingStats } from "../src/model/pool-transform.ts";

describe("pool-transform — z-score re-basing", () => {
  // The worked example: league avg 100 ±20, weak pool avg 50 (±20) → lift up.
  const league: RatingStats = { mu: 100, sd: 20 };
  const poolSameSpread: RatingStats = { mu: 50, sd: 20 };

  it("pool mean maps to league mean", () => {
    const m = affineFor(league, poolSameSpread);
    expect(applyAffine(50, m)).toBeCloseTo(100, 9);
  });

  it("a card +1 SD in its pool lands +1 SD in the league (standing preserved)", () => {
    const m = affineFor(league, poolSameSpread);
    expect(applyAffine(70, m)).toBeCloseTo(120, 9); // +1 pool SD → +1 league SD
    expect(applyAffine(30, m)).toBeCloseTo(80, 9);  // −1 pool SD → −1 league SD
  });

  it("when spreads match it's a pure shift (slope 1) — NOT a stretch toward zero", () => {
    const m = affineFor(league, poolSameSpread);
    expect(m.b).toBeCloseTo(1, 9);         // pure shift
    expect(m.a).toBeCloseTo(50, 9);        // +50
    // multiplicative would have used ×2 (→ 140 for a 70 card); z-score gives 120.
    expect(applyAffine(70, m)).not.toBeCloseTo(140, 1);
  });

  it("a narrower pool stretches; a wider pool compresses (the second knob)", () => {
    const tight = affineFor(league, { mu: 50, sd: 10 }); // pool half as spread
    expect(tight.b).toBeCloseTo(2, 9);                   // +1 pool SD (=+10) → +2 league SD (=+40)
    expect(applyAffine(60, tight)).toBeCloseTo(120, 9);
    const wide = affineFor(league, { mu: 50, sd: 40 });  // pool twice as spread
    expect(wide.b).toBeCloseTo(0.5, 9);
    expect(applyAffine(90, wide)).toBeCloseTo(120, 9);   // +1 pool SD (=+40) → +1 league SD (=+20)
  });

  it("an identical pool (pool == league) is the identity transform (no-op)", () => {
    const m = affineFor(league, league);
    expect(m.a).toBeCloseTo(0, 9);
    expect(m.b).toBeCloseTo(1, 9);
    for (const r of [40, 80, 120, 160]) expect(applyAffine(r, m)).toBeCloseTo(r, 9);
  });

  it("ratingStats ignores 0s (no-rating card-sides) and never returns sd 0", () => {
    expect(ratingStats([100, 100, 100])).toEqual({ mu: 100, sd: 1 }); // sd floor
    const s = ratingStats([0, 0, 60, 100, 140]); // zeros excluded → mean of 60/100/140
    expect(s.mu).toBeCloseTo(100, 9);
  });

  it("effective ratings clamp ≥ 0 (an extreme down-shift can't go negative)", () => {
    const m = affineFor({ mu: 50, sd: 20 }, { mu: 150, sd: 20 }); // map a strong pool DOWN
    expect(applyAffine(80, m)).toBeGreaterThanOrEqual(0);
  });
});
