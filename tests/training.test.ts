// M6 / SP-9 — training-data loader tests. Filename detection must be robust to
// token order; the real dataset must load + group as expected.

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { parseTrainingFilename, loadTrainingDir, loadWindow, availableYears } from "../src/training/loader.ts";

const DIR = "League Files";

describe("parseTrainingFilename — robust to token order + naming", () => {
  it("parses league / side / year in the normal order (league spaces stripped)", () => {
    expect(parseTrainingFilename("HD 450 vL 2037.csv")).toEqual({ league: "HD450", side: "L", year: 2037 });
    expect(parseTrainingFilename("PEL vR 2038.csv")).toEqual({ league: "PEL", side: "R", year: 2038 });
  });
  it("parses year-before-side (HD 452 2038 vR.csv)", () => {
    expect(parseTrainingFilename("HD 452 2038 vR.csv")).toEqual({ league: "HD452", side: "R", year: 2038 });
  });
  it("parses the 2039 year-first format (2039 HD450 vL.csv) to the same league key", () => {
    expect(parseTrainingFilename("2039 HD450 vL.csv")).toEqual({ league: "HD450", side: "L", year: 2039 });
  });
  it("is case-insensitive on the side token", () => {
    expect(parseTrainingFilename("HD 453 VL 2037.csv")?.side).toBe("L");
  });
  it("returns null when side or year is missing", () => {
    expect(parseTrainingFilename("HD 450 2037.csv")).toBeNull();
    expect(parseTrainingFilename("HD 450 vL.csv")).toBeNull();
  });
});

describe.skipIf(!existsSync(DIR))("loadTrainingDir — real dataset", () => {
  const { summary, observations } = loadTrainingDir(DIR);

  it("loads every CSV with no unparsed filenames", () => {
    expect(summary.unparsedFiles).toEqual([]);
    expect(summary.files.length).toBeGreaterThanOrEqual(27);
  });

  it("detects the expected leagues, sides, and years", () => {
    expect(summary.years).toEqual(expect.arrayContaining([2037, 2038, 2039])); // ≥ these (Old Data adds 2032-33 locally)
    expect(summary.leagues).toContain("PEL");
    expect(summary.leagues).toContain("HD452"); // canonical (spaces stripped) — unifies 37/38 "HD 452" + 39 "HD452"
    // both platoon sides present across the cells
    expect(new Set(summary.cells.map((c) => c.side))).toEqual(new Set(["L", "R"]));
  });

  it("selects a window by year; full load = union of windows", () => {
    expect(availableYears(DIR)).toEqual(expect.arrayContaining([2037, 2038, 2039])); // superset OK (Old Data = 2032-33)
    const w38 = loadWindow(DIR, [2038]);
    expect(w38.summary.years).toEqual([2038]);
    expect(w38.observations.every((o) => o.sources.every((s) => s.year === 2038))).toBe(true);
    // the 37-38 window reproduces the parity oracle's hitter/pitcher counts
    const w3738 = loadWindow(DIR, [2037, 2038]);
    expect(w3738.observations.filter((o) => o.hit.PA >= 1000).length).toBe(159);
    expect(w3738.observations.filter((o) => o.pitch.BF >= 1000).length).toBe(129);
  });

  it("groups by (CID, variant, side) — base and variant separate", () => {
    expect(summary.observations).toBeGreaterThan(0);
    expect(summary.baseObs + summary.variantObs).toBe(summary.observations);
    expect(summary.variantObs).toBeGreaterThan(0); // the dataset contains variants
    // a key never mixes base+variant
    for (const o of observations) expect(o.key.endsWith(o.variant ? "|V|" + o.side : "|B|" + o.side)).toBe(true);
  });

  it("sums outcomes across sources (a multi-source obs has >1 source)", () => {
    const multi = observations.find((o) => o.sources.length > 1);
    expect(multi).toBeDefined();
    if (multi) {
      const summedPA = multi.sources.reduce((s, x) => s + x.pa, 0);
      expect(multi.hit.PA).toBe(summedPA);
    }
  });

  it("has positive PA and BF totals", () => {
    expect(summary.totalPA).toBeGreaterThan(0);
    expect(summary.totalBF).toBeGreaterThan(0);
    expect(summary.hitterObs).toBeGreaterThan(0);
    expect(summary.pitcherObs).toBeGreaterThan(0);
  });
});
