// M1.5 — calibrate() self-consistency. Uses the committed _synthetic fixture
// (no gitignored real captures). Validates the anchor identity (the top-N pool's
// mean anchor wOBA, scaled, hits the target) and the D2 value function. Exact
// reproduction of the old app's captured scales is validated separately/locally
// (tools/spike-calibrate.ts) since it needs the real eligible pool incl. variants.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import Papa from "papaparse";
import { calibrate, valueFor, computeDerived, TARGET_WOBA, type Coeffs } from "../src/scoring-core/index.ts";

const capture = JSON.parse(readFileSync("fixtures/captures/_synthetic.json", "utf8")) as { coeffs: Coeffs };
const cards = Papa.parse(readFileSync("docs/pt_card_list.csv", "utf8"), { header: true, skipEmptyLines: true }).data as any[];
const config = { coeffs: capture.coeffs, derived: computeDerived(capture.coeffs) };

describe("calibrate() — anchor identity & sanity", () => {
  const s = calibrate(cards, config);

  it("produces positive, finite anchor means and scales", () => {
    for (const k of ["anchorMeanVR", "anchorMeanVL", "anchorMeanPitchVR", "anchorMeanPitchVL"] as const) {
      expect(s[k]).toBeGreaterThan(0);
      expect(Number.isFinite(s[k] as number)).toBe(true);
    }
    for (const k of ["hitScaleVR", "hitScaleVL", "pitchScale"] as const) {
      expect(s[k]).toBeGreaterThan(0);
      expect(Number.isFinite(s[k] as number)).toBe(true);
    }
  });

  it("anchors each pool's mean to TARGET_WOBA (hitScale·anchorMean == target)", () => {
    expect((s.anchorMeanVR as number) * (s.hitScaleVR as number)).toBeCloseTo(TARGET_WOBA, 9);
    expect((s.anchorMeanVL as number) * (s.hitScaleVL as number)).toBeCloseTo(TARGET_WOBA, 9);
    expect((s.anchorMeanPitch as number) * (s.pitchScale as number)).toBeCloseTo(TARGET_WOBA, 9);
  });

  it("per-event BB/HR scales are present and finite", () => {
    for (const k of ["hitBBScaleVR", "hitHRScaleVR", "hitBBScaleVL", "hitHRScaleVL", "pBBScaleVR", "pHRScaleVR"] as const) {
      expect(Number.isFinite(s[k] as number)).toBe(true);
      expect(s[k]).toBeGreaterThan(0);
    }
  });

  it("carries ssp + non-cap cross-pool defaults so scoreCard can consume it", () => {
    expect(s.ssp_adv_hitting).toBe(config.coeffs.ssp_adv_hitting);
    expect(s.ssp_basic_pitching).toBe(config.coeffs.ssp_basic_pitching);
    expect(s.crossPoolHitterMultiplier).toBe(1);
  });
});

describe("valueFor() — D2 signed distance", () => {
  it("hitter = wOBA - baseline; pitcher = baseline - allowedWOBA", () => {
    expect(valueFor(0.350, "hitter", 0.320)).toBeCloseTo(0.030, 12);
    expect(valueFor(0.300, "pitcher", 0.320)).toBeCloseTo(0.020, 12);
    // both directions: higher = better for both roles
    expect(valueFor(0.360, "hitter")).toBeGreaterThan(valueFor(0.340, "hitter"));
    expect(valueFor(0.300, "pitcher")).toBeGreaterThan(valueFor(0.310, "pitcher"));
  });
});
