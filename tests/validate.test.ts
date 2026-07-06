import { describe, it, expect } from "vitest";
import { validateDataset, corruptCellKeys } from "../src/training/validate.ts";
import type { TrainingSummary, CellStat } from "../src/training/loader.ts";

// Minimal summary — the validator reads only `cells` + `unparsedFiles`.
const cell = (league: string, year: number, side: "L" | "R", pa: number, bf: number, rows = 100): CellStat => ({ league, side, year, rows, pa, bf });
const summary = (cells: CellStat[], unparsedFiles: string[] = []): TrainingSummary => ({ cells, unparsedFiles } as TrainingSummary);

// A healthy league-year: vR is the majority split (RHP), PA reconciles with BF.
const healthy = (league: string, year: number): CellStat[] => [
  cell(league, year, "L", 70_000, 70_000),
  cell(league, year, "R", 120_000, 120_000),
];

describe("validateDataset", () => {
  it("passes a clean dataset (vR > vL, PA == BF)", () => {
    const v = validateDataset(summary([...healthy("PEL", 2040), ...healthy("HD450", 2040)]));
    expect(v.ok).toBe(true);
    expect(v.errors).toBe(0);
    expect(v.issues).toHaveLength(0);
  });

  it("excludes an identical-vL/vR duplicate from modeling (error) and lists it in `excluded`", () => {
    const dup = [cell("HD450", 2039, "L", 71_886, 74_940, 870), cell("HD450", 2039, "R", 71_886, 74_940, 870)];
    const cells = [...healthy("PEL", 2039), ...dup];
    expect([...corruptCellKeys(cells).keys()]).toEqual(["HD450|2039"]);
    const v = validateDataset(summary(cells));
    expect(v.ok).toBe(false);
    expect(v.excluded).toEqual(["HD450|2039"]);
    expect(v.issues.some((i) => i.severity === "error" && /identical.*EXCLUDED/.test(i.message))).toBe(true);
  });

  it("flags vL ≥ vR as a swap/corruption (warn)", () => {
    const bad = [cell("PEL", 2039, "L", 224_513, 224_513), cell("PEL", 2039, "R", 146_986, 134_027)];
    const v = validateDataset(summary(bad));
    expect(v.issues.some((i) => i.severity === "warn" && /vR > vL/.test(i.message))).toBe(true);
  });

  it("flags a per-year PA/BF reconciliation gap (error)", () => {
    // vR BF short by ~6k → year totals don't reconcile.
    const cells = [cell("PEL", 2039, "L", 70_000, 70_000), cell("PEL", 2039, "R", 120_000, 113_365)];
    const v = validateDataset(summary(cells));
    expect(v.issues.some((i) => i.severity === "error" && /≠ pit BF/.test(i.message))).toBe(true);
  });

  it("flags a missing side and an unparsed file (warn)", () => {
    const v = validateDataset(summary([cell("PEL", 2040, "R", 120_000, 120_000)], ["mystery.csv"]));
    expect(v.issues.some((i) => /missing vL/.test(i.message))).toBe(true);
    expect(v.issues.some((i) => /unparsed/.test(i.message))).toBe(true);
  });
});
