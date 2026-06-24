// M6 — evaluation harness tests: metric properties + the baseline scoreboard.
// Runs on the committed 37-38 fixture so it's live on a fresh clone.

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { wPearson, wR2, gapDistortionRmse, wBias, topNOverlap, valueRegret, evalMetrics } from "../src/training/metrics.ts";
import { foldOf, buildScoreboard } from "../src/training/evaluate.ts";

const ones = (n: number) => new Array(n).fill(1);

describe("metrics — gap-fidelity properties", () => {
  const x = [1, 2, 3, 4, 5, 6, 7, 8];
  it("Pearson is affine-invariant (shift+scale of predictions ⇒ r=1)", () => {
    const shifted = x.map((v) => 2 * v + 5);
    expect(wPearson(shifted, x, ones(x.length))).toBeCloseTo(1, 10);
  });
  it("gap-distortion RMSE ≈ 0 when prediction is an affine transform of actual", () => {
    const pred = x.map((v) => 0.5 * v - 3);
    expect(gapDistortionRmse(pred, x, ones(x.length))).toBeLessThan(1e-9);
  });
  it("R² penalizes a shift that Pearson ignores", () => {
    const shifted = x.map((v) => v + 10);
    expect(wPearson(shifted, x, ones(x.length))).toBeCloseTo(1, 10);
    expect(wR2(shifted, x, ones(x.length))).toBeLessThan(0); // far from the 1:1 line
  });
  it("bias is the mean signed residual", () => {
    expect(wBias([2, 3, 4], [1, 2, 3], ones(3))).toBeCloseTo(1, 10);
  });
  it("top-N overlap = 1 and regret = 0 for a perfectly-ordered prediction", () => {
    const actual = [5, 4, 3, 2, 1], pred = [50, 40, 30, 20, 10];
    expect(topNOverlap(pred, actual, 2, true)).toBe(1);
    expect(valueRegret(pred, actual, 2, true)).toBeCloseTo(0, 10);
  });
  it("regret > 0 when the model's top pick isn't actually best", () => {
    const actual = [1, 2, 10], pred = [100, 2, 1]; // model loves index 0, truth loves index 2
    expect(valueRegret(pred, actual, 1, true)).toBeGreaterThan(0);
  });
  it("evalMetrics returns the full bundle", () => {
    const m = evalMetrics([1, 2, 3, 4], [1, 2, 3, 5], ones(4), true, 2);
    expect(m).toHaveProperty("pearson"); expect(m).toHaveProperty("valueRegret"); expect(m.n).toBe(4);
  });
});

describe("foldOf — deterministic", () => {
  it("is stable and in range", () => {
    expect(foldOf("abc|B|R", 5)).toBe(foldOf("abc|B|R", 5));
    for (const key of ["1|B|R", "2|V|L", "x|B|L"]) expect(foldOf(key, 5)).toBeGreaterThanOrEqual(0);
  });
});

const FIXTURE = "Model 2037 and 2038";
describe.skipIf(!existsSync(FIXTURE))("buildScoreboard — baseline on the 37-38 fixture", () => {
  const sb = buildScoreboard(FIXTURE, { minN: 1000, k: 5 });

  it("covers both roles × {in-sample, cv, forward, backward}", () => {
    expect(sb.years).toEqual([2037, 2038]);
    const evals = new Set(sb.rows.map((r) => r.evaluation));
    expect(evals).toEqual(new Set(["in-sample", "cv", "forward", "backward"]));
    expect(sb.rows.length).toBe(8); // 2 roles × 4 evaluations
  });
  it("the log-linear baseline fits the data (CV Pearson is high, metrics in range)", () => {
    const cvHit = sb.rows.find((r) => r.role === "hitter" && r.evaluation === "cv")!.metrics;
    expect(cvHit.pearson).toBeGreaterThan(0.7);
    expect(cvHit.valueRegret).toBeGreaterThanOrEqual(0);
    expect(cvHit.topNOverlap).toBeGreaterThan(0);
  });
  it("in-sample is no worse than CV (CV is the honest, lower bound)", () => {
    const isHit = sb.rows.find((r) => r.role === "hitter" && r.evaluation === "in-sample")!.metrics;
    const cvHit = sb.rows.find((r) => r.role === "hitter" && r.evaluation === "cv")!.metrics;
    expect(isHit.pearson).toBeGreaterThanOrEqual(cvHit.pearson - 1e-9);
  });
});
