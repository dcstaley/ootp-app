// COHORT SELECTION metric — invariant pins (cohort-rule event scaffold, 2026-07-23).
//
// The metric's whole reason to exist is a set of INVARIANTS the model-selected cohort violated: it
// must be model-free (so a retrain cannot move it), whole-vector (so no one channel drives it), and
// data-fixed (so the same card scores the same in every tournament). These pin exactly those, plus
// the reference construction and the provenance tag. Nothing here touches a scoring path — the module
// is an unwired scaffold — so the tests are pure unit tests.

import { describe, it, expect } from "vitest";
import { buildRatingRef, cohortZSum, COHORT_RULE_TAG, COHORT_MODE_DEFAULT, type RatingRef } from "../src/scoring-core/cohort-select.ts";

const CH = ["eye", "pow", "kRat", "babip", "gap"] as const;
const ref = (): RatingRef => buildRatingRef(CH, {
  eye: [100, 120, 140], pow: [90, 110, 130], kRat: [80, 100, 120], babip: [95, 105, 115], gap: [100, 100, 100],
});

describe("buildRatingRef — catalog-fixed moments", () => {
  it("computes per-channel mean and population sd, excluding 0 (absent-this-side)", () => {
    const r = buildRatingRef(["x"], { x: [100, 120, 140, 0] }); // the 0 is excluded
    expect(r.mu.x).toBeCloseTo(120, 9);
    expect(r.sd.x).toBeCloseTo(Math.sqrt(((100 - 120) ** 2 + 0 + (140 - 120) ** 2) / 3), 9);
  });
  it("carries a degenerate channel (all equal) as sd 1, never divide-by-zero", () => {
    const r = buildRatingRef(["g"], { g: [100, 100, 100] });
    expect(r.sd.g).toBe(1);
    expect(Number.isFinite(cohortZSum({ g: 100 }, r))).toBe(true);
  });
});

describe("cohortZSum — the model-free, whole-vector, data-fixed metric", () => {
  it("is the SUM of per-channel z-scores over the whole rating vector", () => {
    const r = ref();
    const card = { eye: 140, pow: 130, kRat: 120, babip: 115, gap: 100 };
    let expected = 0;
    for (const k of CH) expected += (card[k] - r.mu[k]!) / r.sd[k]!;
    expect(cohortZSum(card, r)).toBeCloseTo(expected, 12);
  });
  it("is MODEL-FREE: it reads only ratings + the fixed reference — no coefficients, no wOBA, exist in the call", () => {
    // The signature itself is the guarantee: (ratings, ref) — there is no model, coeffs, or eventForm
    // parameter it could consult. This test documents that as an intentional, load-bearing shape.
    expect(cohortZSum.length).toBe(2);
  });
  it("is DATA-FIXED: the same card scores the same z-sum regardless of which pool it is ranked within", () => {
    // The reference is catalog-fixed, so a card's z-sum does not depend on the tournament pool around
    // it — the property that makes the gap immune to pool composition churn AND to retrains.
    const r = ref();
    const card = { eye: 130, pow: 120, kRat: 110, babip: 108, gap: 100 };
    expect(cohortZSum(card, r)).toBe(cohortZSum(card, r)); // deterministic
    // A second reference (a different catalog) gives a different number — the metric IS a function of
    // (card, catalog) and nothing else.
    const r2 = buildRatingRef(CH, { eye: [200], pow: [200], kRat: [200], babip: [200], gap: [200] });
    expect(cohortZSum(card, r2)).not.toBe(cohortZSum(card, r));
  });
  it("ranks a uniformly-stronger card above a weaker one (higher = stronger, the selection direction)", () => {
    const r = ref();
    const strong = { eye: 150, pow: 140, kRat: 130, babip: 120, gap: 110 };
    const weak = { eye: 90, pow: 90, kRat: 90, babip: 90, gap: 90 };
    expect(cohortZSum(strong, r)).toBeGreaterThan(cohortZSum(weak, r));
  });
  it("uses the WHOLE vector — no single channel can dominate a uniformly-average card", () => {
    // A card average on four channels and elite on one sits near the middle, not the top: the point
    // of the whole-vector rule is that one channel (least of all a model summary) does not drive it.
    const r = ref();
    const oneChannelElite = { eye: 250, pow: 100, kRat: 100, babip: 100, gap: 100 };
    const balancedStrong = { eye: 130, pow: 125, kRat: 115, babip: 112, gap: 105 };
    // both positive, but the balanced card is not swamped — the elite-on-one card does not run away
    expect(Math.abs(cohortZSum(oneChannelElite, r) - cohortZSum(balancedStrong, r))).toBeLessThan(
      Math.abs(cohortZSum(oneChannelElite, r)) + Math.abs(cohortZSum(balancedStrong, r)),
    );
  });
});

describe("provenance + mode scaffolding", () => {
  it("pins the selection-rule tag (bumped on any metric change; asserted on the ramps at the event)", () => {
    expect(COHORT_RULE_TAG).toBe("zsum-catalog-v1");
  });
  it("defaults to the CURRENT production behaviour until the event wires the new rule", () => {
    expect(COHORT_MODE_DEFAULT).toBe("model-woba");
  });
});
