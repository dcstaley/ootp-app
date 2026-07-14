// computeEras parity: per-year run-environment modifiers vs the 2010 baseline,
// from the committed BBRef league-batting CSV. 2010 must come out all-1.0; spot
// values are checked by hand from the raw rows; missing data (e.g. 1884 HR "--")
// must fall back to neutral 1, not NaN.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { computeEras } from "../src/data/eras-bbref.ts";

const eras = computeEras(readFileSync("docs/bbref_batting_league.csv", "utf8"));
const byId = new Map(eras.map((e) => [e.id, e]));

describe("BBRef era modifiers", () => {
  it("covers every year and ids/names them", () => {
    expect(eras.length).toBeGreaterThan(150);          // 1871–2026
    expect(byId.get("era-2010")!.name).toBe("2010");
    expect(byId.get("era-2010")!.year).toBe(2010);
  });

  it("2010 baseline is all-1.0 (≡ neutral)", () => {
    const e = byId.get("era-2010")!;
    for (const k of ["bb", "k", "avg", "hr", "gap", "bip", "hbp"] as const) expect(e[k]).toBeCloseTo(1, 6);
    expect(e.sbFreq).toBeCloseTo(1, 6);   // baserunning factors neutral at baseline
    expect(e.runVal).toBeCloseTo(1, 6);
  });

  it("baserunning era factors: sbFreq (stealing frequency) + runVal (run scarcity)", () => {
    const y1911 = byId.get("era-1911")!, y1968 = byId.get("era-1968")!, y2019 = byId.get("era-2019")!;
    expect(y1911.sbFreq!).toBeCloseTo(2.27, 1);  // dead-ball ran ~2.3× as much as 2010
    expect(y1911.runVal!).toBeCloseTo(0.97, 1);
    expect(y1968.sbFreq!).toBeLessThan(1);        // low-steal era…
    expect(y1968.runVal!).toBeCloseTo(1.28, 1);   // …but the pitcher's era makes each run worth more
    expect(y2019.sbFreq!).toBeCloseTo(0.77, 1);   // modern game steals less
    expect(byId.get("era-2010")!.rates!.sb).toBeCloseTo(0.61 / 38.18, 4); // raw SB/PA stored
  });

  it("2026 modifiers match hand-computed rates vs 2010", () => {
    const e = byId.get("era-2026")!;
    expect(e.bb).toBeCloseTo(1.0643, 3);   // BB up ~6%
    expect(e.k).toBeCloseTo(1.1913, 3);    // K up ~19%
    expect(e.hr).toBeCloseTo(1.1995, 3);   // HR up ~20%
    expect(e.avg).toBeCloseTo(0.9405, 3);  // hits down ~6%
    expect(e.gap).toBeCloseTo(0.8935, 3);  // gap = temp 2B+3B weighted rate vs 2010 (XBH rate down ~11%)
    expect(e.hbp).toBeCloseTo(1.3866, 3);  // HBP way up
    expect(e.bip).toBe(1);                  // bip pinned neutral (removed from scoring)
  });

  it("stores raw per-PA rates for future recompute", () => {
    const e = byId.get("era-2010")!;
    expect(e.rates!.bb).toBeCloseTo(3.25 / 38.18, 4);
    expect(e.rates!.hr).toBeCloseTo(0.95 / 38.18, 4);
  });

  it("falls back to neutral 1 on missing data (1871 HBP is blank)", () => {
    const e = byId.get("era-1871")!;
    expect(e.hbp).toBe(1);                // HBP not recorded in 1871 → neutral, not NaN
    expect(Number.isFinite(e.bb)).toBe(true); // other factors still computed
    expect(Number.isFinite(e.avg)).toBe(true);
  });
});
