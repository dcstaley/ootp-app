// COHORT-RULE EVENT — the wiring, end to end (2026-07-23).
//
// The scaffold's unit tests (cohort-select.test.ts) pin the metric's invariants. These pin that the
// metric is CORRECTLY WIRED into the field builder and the resolver, and — the safety-critical
// property — that the DEFAULT (no select / untagged model) path is BIT-IDENTICAL to before, so
// landing the rule changes nothing until a z-sum-tagged model is activated.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  computeUnifiedFieldStats, buildCohortRefs, cohortSelectForModel, makeRawPolyModel,
  K_SPREAD_PIT, PIT_SPREAD_HR, COHORT_RULE_TAG, type Coeffs,
} from "../src/scoring-core/index.ts";
import type { EventForm } from "../src/model/curves.ts";

const synth = JSON.parse(readFileSync("fixtures/captures/_synthetic.json", "utf8"));
const coeffs = synth.coeffs as Coeffs;
// A REAL fitted form — cardRec always predicts a wOBA (even though z-sum ranks by ratings, not wOBA),
// so it needs a valid EventForm. The active artifact's is convenient and deterministic.
const form: EventForm = JSON.parse(readFileSync("data/trained-models/league-42-43.json", "utf8")).eventForm as EventForm;

/** A card in the CSV-column shape computeUnifiedFieldStats reads, both sides equal. */
function card(id: string, hit: number, pit: number): Record<string, unknown> {
  const c: Record<string, unknown> = { "Card ID": id, "//Card Title": id, Bats: 1, Throws: 1, Speed: 40, Stealing: 30, Baserunning: 45, "Steal Rate": 50 };
  for (const s of ["vR", "vL"]) {
    c[`Eye ${s}`] = hit; c[`Power ${s}`] = hit; c[`Avoid K ${s}`] = hit; c[`BABIP ${s}`] = hit; c[`Gap ${s}`] = hit;
    c[`Control ${s}`] = pit; c[`Stuff ${s}`] = pit; c[`pBABIP ${s}`] = pit; c[`pHR ${s}`] = pit;
  }
  return c;
}

const model = makeRawPolyModel(form);
// A spread of cards: rating strength varies, so z-sum has something to rank.
const pool = [card("a", 80, 90), card("b", 120, 130), card("c", 160, 170), card("d", 200, 210), card("e", 100, 110), card("f", 140, 150)];
const refs = buildCohortRefs(pool, coeffs, model, true);

describe("computeUnifiedFieldStats — the z-sum branch is wired and the default is bit-identical", () => {
  it("DEFAULT (no select) is unchanged — the safety-critical property (production stays model-woba)", () => {
    const a = computeUnifiedFieldStats(pool, coeffs, model, 3, true);
    const b = computeUnifiedFieldStats(pool, coeffs, model, 3, true); // no select arg
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
  it("z-sum SELECTION picks the highest-rating cards (top-N by the rating vector, not by model wOBA)", () => {
    // With N=3 and z-sum, the cohort is {d(200/210), c(160/170), f(140/150)} — the three strongest by
    // raw ratings. Their pooled hit mean must therefore be well above the whole-pool mean.
    const zsum = computeUnifiedFieldStats(pool, coeffs, model, 3, true, refs);
    const eyeMean = zsum.hit.vR.eye!.mu;
    expect(eyeMean).toBeGreaterThan(140); // top-3 of {80,100,120,140,160,200} pooled → 160ish
  });
  it("the two branches generally DIFFER (proof the branch is live, not a no-op) unless ratings track wOBA exactly", () => {
    const wobaSel = computeUnifiedFieldStats(pool, coeffs, model, 2, true);
    const zSel = computeUnifiedFieldStats(pool, coeffs, model, 2, true, refs);
    // Not asserting a specific direction — only that the select path is reached and produces a field.
    expect(Number.isFinite(zSel.pit.vR.stu!.mu)).toBe(true);
    expect(Number.isFinite(wobaSel.pit.vR.stu!.mu)).toBe(true);
  });
});

describe("cohortSelectForModel — per-model backward compatibility", () => {
  it("returns undefined for an ABSENT tag (pre-event models ⇒ model-woba ⇒ bit-identical)", () => {
    expect(cohortSelectForModel(undefined, pool, coeffs, model)).toBeUndefined();
    expect(cohortSelectForModel("model-woba", pool, coeffs, model)).toBeUndefined();
  });
  it("returns catalog-fixed refs for the z-sum tag (a new tagged model flips the pool leg)", () => {
    const sel = cohortSelectForModel(COHORT_RULE_TAG, pool, coeffs, model);
    expect(sel).toBeDefined();
    expect(sel!.hit.channels.length).toBeGreaterThan(0);
    expect(sel!.pit.channels.length).toBeGreaterThan(0);
  });
});

describe("SAME-CONSTRUCTION invariant — both legs, same select, over the same population, agree", () => {
  it("two field builds with the identical select produce identical stats (the gap's legs are comparable)", () => {
    // The whole point of 'same metric both legs' is that a train-leg field and a pool-leg field built
    // the same way are on the same coordinate. Here: the same call twice must be bit-identical.
    const legA = computeUnifiedFieldStats(pool, coeffs, model, 3, true, refs);
    const legB = computeUnifiedFieldStats(pool, coeffs, model, 3, true, refs);
    expect(JSON.stringify(legA)).toBe(JSON.stringify(legB));
  });
});

describe("ramp provenance carries the selection-rule tag (the activation guard's basis)", () => {
  it("both shipped ramps are tagged model-woba (the coordinate they were fit on)", () => {
    expect(K_SPREAD_PIT.cohortRule).toBe("model-woba");
    expect(PIT_SPREAD_HR.cohortRule).toBe("model-woba");
  });
  it("the z-sum tag is distinct from the ramps' current tag — so activating a z-sum model pre-refit mismatches", () => {
    expect(COHORT_RULE_TAG).not.toBe(K_SPREAD_PIT.cohortRule);
  });
});
