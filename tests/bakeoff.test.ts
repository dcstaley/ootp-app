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

  const MODELS = ["woba", "basic", "woba·rawpoly", "woba·logcubic", "woba·rawlin", "woba·rawquad", "woba·rawcubic", "woba·qpow-lin", "woba·rawpoly-hlin", "woba·biplin", "woba·perbip", "woba·matchupK", "woba·poisson", "woba·nb", "woba·seqcond", "ceiling·flex"];
  it("covers the baselines + candidate forms × roles × {in-sample, cv} (no OOT: the fixture has no out-of-window year)", () => {
    expect(sb.years).toEqual([2037, 2038]);
    expect(new Set(sb.rows.map((r) => r.evaluation))).toEqual(new Set(["in-sample", "cv"]));
    expect(new Set(sb.rows.map((r) => `${r.model}-${r.role}`))).toEqual(new Set(MODELS.flatMap((m) => [`${m}-hitter`, `${m}-pitcher`])));
    expect(sb.rows.length).toBe(MODELS.length * 2 * 2); // (model×role) × {in-sample, cv}
  });
  it("OOT tracks the selected window: a sub-window fits on the window + tests the held-out year", () => {
    const sb2 = buildScoreboard(FIXTURE, { minN: 1000, k: 5, window: [2038] });
    const evals = new Set(sb2.rows.map((r) => r.evaluation));
    expect(evals.has("backward")).toBe(true);  // train 2038 → test 2037 (out-of-window past)
    expect(evals.has("forward")).toBe(false);  // no year after 2038
    expect(sb2.rows.find((r) => r.evaluation === "backward")!.window).toBe("2038→2037");
  });
  it("only candidate forms carry a gate, and only on the in-sample row", () => {
    const gated = sb.rows.filter((r) => r.gate);
    expect(gated.every((r) => r.model !== "woba" && r.model !== "basic" && r.evaluation === "in-sample")).toBe(true);
    expect(gated.length).toBe(13 * 2); // 13 forms × {hitter, pitcher}, in-sample only (incl. matchupK)
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

describe.skipIf(!existsSync(FIXTURE))("analyzeResiduals — leaderboards + signatures + distributions + grid", () => {
  const obs = loadTrainingDir(FIXTURE).observations;
  const a = analyzeResiduals(obs, "hitter", 1000);
  it("over-valued leaderboard is sorted above under-valued", () => {
    expect(a.over.length).toBeGreaterThan(0);
    expect(a.over[0]!.valErrPts).toBeGreaterThanOrEqual(a.under[0]!.valErrPts);
  });
  it("hitter ratings include gap; distributions cover every rating", () => {
    expect(a.ratings).toEqual(["babip", "pow", "eye", "k", "gap"]);
    expect(a.over[0]!.ratings).toHaveProperty("gap");
    expect(a.distributions.map((d) => d.rating)).toEqual(a.ratings);
    for (const d of a.distributions) expect(d.tierCounts.L + d.tierCounts.M + d.tierCounts.H).toBe(a.n);
  });
  it("a 2D grid exists for every rating pair (incl gap), 3×3, partitioning every card", () => {
    expect(a.grids.length).toBe(10); // C(5,2) pairs of the 5 ratings
    for (const g of a.grids) expect(g.cells.flat().reduce((s, c) => s + c.n, 0)).toBe(a.n);
  });
  it("signatures are FULL band combos of the 4 sig-ratings, members + volume", () => {
    expect(a.sigRatings).toEqual(["babip", "pow", "eye", "k"]);
    const big = a.signatures[0]!; // sorted by volume desc
    expect(Object.keys(big.sig)).toEqual(a.sigRatings);
    expect(big.members.length).toBe(big.n);
    expect(big.n).toBeGreaterThanOrEqual(2);
    // every populated bucket's cards share the bucket's full signature
    for (const b of a.signatures) expect(b.members.length).toBe(b.n);
  });
  it("computes 1-D marginals (3-band + 5-band) per rating", () => {
    expect(a.marginals.map((m) => m.rating)).toEqual(a.ratings);
    const pow = a.marginals.find((m) => m.rating === "pow")!;
    expect(pow.bands3.map((t) => t.band)).toEqual(["L", "M", "H"]);
    expect(pow.bands5.map((t) => t.band)).toEqual(["XL", "L", "M", "H", "XH"]);
    expect(pow.bands3.reduce((s, t) => s + t.n, 0)).toBe(a.n);
  });
  it("fits a residual meta-model: r² in [0,1], coef per rating + interactions", () => {
    const rm = a.residualModel;
    expect(rm.r2).toBeGreaterThanOrEqual(0); expect(rm.r2).toBeLessThanOrEqual(1);
    expect(rm.perRating.map((p) => p.rating)).toEqual(a.ratings);
    expect(rm.interactions.length).toBe((a.ratings.length * (a.ratings.length - 1)) / 2); // C(5,2)=10
    // sorted by |coef| desc
    for (let i = 1; i < rm.interactions.length; i++) expect(Math.abs(rm.interactions[i - 1]!.coef)).toBeGreaterThanOrEqual(Math.abs(rm.interactions[i]!.coef));
  });
  it("grid cells carry an interaction residual (raw minus marginals)", () => {
    const g = a.grids[0]!;
    expect(g.cells[0]![0]!).toHaveProperty("interErrPts");
  });
  it("variants can be excluded", () => {
    const baseOnly = analyzeResiduals(obs, "hitter", 1000, { includeVariants: false });
    expect(baseOnly.over.every((c) => !c.variant)).toBe(true);
    expect(baseOnly.n).toBeLessThanOrEqual(a.n);
  });
});
