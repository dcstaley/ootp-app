// M6 — evaluation harness tests: metric properties + the baseline scoreboard.
// Runs on the committed 37-38 fixture so it's live on a fresh clone.

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { wPearson, wR2, gapDistortionRmse, wBias, topNOverlap, valueRegret, evalMetrics } from "../src/training/metrics.ts";
import { foldOf, buildScoreboard } from "../src/training/evaluate.ts";
import { analyzeResiduals } from "../src/training/residuals.ts";
import { loadTrainingDir } from "../src/training/loader.ts";

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

  const pick = (model: string, role: string, evaluation: string) => sb.rows.find((r) => r.model === model && r.role === role && r.evaluation === evaluation)!.metrics;

  it("covers all four models × roles × {in-sample, cv, forward, backward}", () => {
    expect(sb.years).toEqual([2037, 2038]);
    expect(new Set(sb.rows.map((r) => r.evaluation))).toEqual(new Set(["in-sample", "cv", "forward", "backward"]));
    expect(new Set(sb.rows.map((r) => `${r.model}-${r.role}`))).toEqual(new Set(["woba-hitter", "basic-hitter", "woba-pitcher", "basic-pitcher"]));
    expect(sb.rows.length).toBe(16); // 4 (model×role) × 4 evaluations
  });
  it("the wOBA + basic baselines fit the data (CV Pearson high, metrics in range)", () => {
    for (const model of ["woba", "basic"]) {
      const cv = pick(model, "hitter", "cv");
      expect(cv.pearson).toBeGreaterThan(0.7);
      expect(cv.valueRegret).toBeGreaterThanOrEqual(0);
      expect(cv.topNOverlap).toBeGreaterThan(0);
    }
  });
  it("in-sample is no worse than CV (CV is the honest, lower bound)", () => {
    expect(pick("woba", "hitter", "in-sample").pearson).toBeGreaterThanOrEqual(pick("woba", "hitter", "cv").pearson - 1e-9);
  });
});

describe.skipIf(!existsSync(FIXTURE))("analyzeResiduals — leaderboards + archetypes + grid", () => {
  const obs = loadTrainingDir(FIXTURE).observations;
  const a = analyzeResiduals(obs, "hitter", 1000);
  it("over-valued leaderboard is sorted above under-valued", () => {
    expect(a.over.length).toBeGreaterThan(0);
    expect(a.over[0]!.valErrPts).toBeGreaterThanOrEqual(a.under[0]!.valErrPts);
  });
  it("archetypes are named with weighted means", () => {
    expect(a.archetypes.length).toBe(6);
    expect(a.archetypes.some((b) => b.n > 0)).toBe(true);
  });
  it("a 2D grid exists for every rating pair, 3×3, partitioning every card", () => {
    expect(a.grids.length).toBe(6); // C(4,2) pairs of the 4 core ratings
    for (const g of a.grids) {
      expect(g.cells.length).toBe(3);
      expect(g.cells.every((row) => row.length === 3)).toBe(true);
      expect(g.cells.flat().reduce((s, c) => s + c.n, 0)).toBe(a.n); // each card in exactly one cell
    }
  });
  it("archetypes carry members + total volume; variants can be excluded", () => {
    const withN = a.archetypes.find((b) => b.n > 0)!;
    expect(withN.members.length).toBe(withN.n);
    expect(withN.sumVol).toBeGreaterThan(0);
    const baseOnly = analyzeResiduals(obs, "hitter", 1000, { includeVariants: false });
    expect(baseOnly.over.every((c) => !c.variant)).toBe(true);
    expect(baseOnly.n).toBeLessThanOrEqual(a.n);
  });
});
