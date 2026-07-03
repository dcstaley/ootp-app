// The roster → E[win%] evaluator core. Pins: the runs → win% math (.500 baseline, one
// currency, ranking-invariance to the display calibration), lineup wRAA, and — the property
// added when "bench = 0" was fixed — that a stronger BENCH raises expected offense, because a
// manager re-optimises the lineup around an absent starter (availability weighting).

import { describe, it, expect } from "vitest";
import { winPctFromRuns, lineupWraa, defaultUsage, rotationStarts, offenseRunsAboveAvg, type WinParams } from "../src/eval/index.ts";
import { effectiveWoba, sideWoba } from "../src/optimizer/assign.ts";
import type { HitterCandidate, RosterOptimizeOptions } from "../src/optimizer/index.ts";

const P: WinParams = { wobaScale: 1.157, lgWoba: 0.32, leagueRuns: 729, pythExp: 1.83, fullStrengthShare: 0.6, platoonCapture: 1, rotationShare: 0.62, rotationDecay: 0, bullpenLeverage: [2.5, 1.5] };

describe("winPctFromRuns — runs → win%", () => {
  it("an average roster (0 wRAA both sides) is exactly .500", () => {
    const r = winPctFromRuns(0, 0, P);
    expect(r.winPct).toBeCloseTo(0.5, 12);
    expect(r.runsScored).toBeCloseTo(P.leagueRuns, 9);
    expect(r.runsAllowed).toBeCloseTo(P.leagueRuns, 9);
  });

  it("offense and defense each move only their own run column; both raise win%", () => {
    expect(winPctFromRuns(60, 0, P).winPct).toBeGreaterThan(0.5);
    expect(winPctFromRuns(60, 0, P).runsAllowed).toBeCloseTo(P.leagueRuns, 9);
    expect(winPctFromRuns(0, 60, P).winPct).toBeGreaterThan(0.5);
    expect(winPctFromRuns(0, 60, P).runsScored).toBeCloseTo(P.leagueRuns, 9);
  });

  it("marginal symmetry at RS==RA: a tiny run on either side moves win% equally", () => {
    expect(winPctFromRuns(1e-3, 0, P).winPct).toBeCloseTo(winPctFromRuns(0, 1e-3, P).winPct, 9);
  });

  it("ranking is invariant to the display calibration (leagueRuns / pythExp scale)", () => {
    const p2: WinParams = { ...P, leagueRuns: 650 };
    const a1 = winPctFromRuns(50, 10, P).winPct - winPctFromRuns(10, 50, P).winPct;
    const a2 = winPctFromRuns(50, 10, p2).winPct - winPctFromRuns(10, 50, p2).winPct;
    expect(Math.sign(a1)).toBe(Math.sign(a2));
  });
});

describe("lineupWraa", () => {
  it("an all-average lineup is 0 wRAA; a better lineup is positive", () => {
    expect(lineupWraa(Array(8).fill(P.lgWoba), defaultUsage({ lineupSize: 8, rotationSize: 5, bullpenSize: 7 }).lineupPA, P)).toBeCloseTo(0, 9);
    expect(lineupWraa(Array(8).fill(P.lgWoba + 0.02), defaultUsage({ lineupSize: 8, rotationSize: 5, bullpenSize: 7 }).lineupPA, P)).toBeGreaterThan(0);
  });
});

// ── Availability: bench depth has value ─────────────────────────────────────────
const H = (id: string, positions: string[], v: number): HitterCandidate =>
  ({ id, title: id, bats: 1, valueVR: v, valueVL: v, positions, coverPositions: positions, cost: 60 });
const FIELDS = ["C", "1B", "2B", "3B", "SS", "LF", "CF", "RF"];
const STARTERS = FIELDS.map((pos) => H(`s_${pos}`, [pos], 0.05));
const OPTS: RosterOptimizeOptions = {
  nHitters: 9, nPitchers: 4, dh: false, minStarters: 2, minStarterStamina: 70, minPitchTypes: 3,
  platoonVR: 0.58, platoonVL: 0.42, mode: "cap",
};
const usage = defaultUsage({ lineupSize: 8, rotationSize: 2, bullpenSize: 2 });

describe("effectiveWoba — platoon capture rate ρ", () => {
  const spec: HitterCandidate = { id: "spec", title: "spec", bats: 1, valueVR: 0.08, valueVL: 0.0, positions: ["1B"], cost: 60 };
  const allround: HitterCandidate = { id: "all", title: "all", bats: 1, valueVR: 0.04, valueVL: 0.04, positions: ["1B"], cost: 60 };

  it("ρ=1 is perfect deployment (= raw favorable-side wOBA)", () => {
    expect(effectiveWoba(spec, "R", 1)).toBeCloseTo(sideWoba(spec, "R"), 12);
  });

  it("ρ<1 shrinks a specialist's edge over an all-around bat (curbs over-platooning)", () => {
    const edgePerfect = effectiveWoba(spec, "R", 1) - effectiveWoba(allround, "R", 1);
    const edgeReal = effectiveWoba(spec, "R", 0.6) - effectiveWoba(allround, "R", 0.6);
    expect(edgePerfect).toBeGreaterThan(edgeReal);
    expect(edgeReal).toBeGreaterThan(0); // the specialist is still better on its good side
  });

  it("ρ<1 lowers a specialist-heavy lineup's offense (off-side bleeds in)", () => {
    const specs = ["1B", "2B", "3B", "SS", "LF", "CF", "RF", "C"].map((pos): HitterCandidate =>
      ({ id: `s_${pos}`, title: pos, bats: 1, valueVR: 0.06, valueVL: -0.01, positions: [pos], coverPositions: [pos], cost: 60 }));
    const perfect: WinParams = { ...P, platoonCapture: 1 };
    const real: WinParams = { ...P, platoonCapture: 0.6 };
    expect(offenseRunsAboveAvg(specs, OPTS, usage, real)!).toBeLessThan(offenseRunsAboveAvg(specs, OPTS, usage, perfect)!);
  });
});

describe("offenseRunsAboveAvg — bench depth is valued", () => {
  it("a strong utility bench beats a junk bench (same starters)", () => {
    const strong = [...STARTERS, H("bench", ["1B", "2B", "3B", "SS"], 0.04)];
    const junk = [...STARTERS, H("bench", ["1B", "2B", "3B", "SS"], -0.02)];
    expect(offenseRunsAboveAvg(strong, OPTS, usage, P)!).toBeGreaterThan(offenseRunsAboveAvg(junk, OPTS, usage, P)!);
  });

  it("at full-strength-share 1.0 the bench is irrelevant (only the best nine plays)", () => {
    const strong = [...STARTERS, H("bench", ["1B", "2B", "3B", "SS"], 0.04)];
    const junk = [...STARTERS, H("bench", ["1B", "2B", "3B", "SS"], -0.02)];
    const p1: WinParams = { ...P, fullStrengthShare: 1 };
    expect(offenseRunsAboveAvg(strong, OPTS, usage, p1)!).toBeCloseTo(offenseRunsAboveAvg(junk, OPTS, usage, p1)!, 9);
  });
});

describe("defaultUsage — Tier-1 usage knobs", () => {
  it("rotation BF follows the format curve (Bo7: SP1 > SP5, but SP5 non-zero); conserves budget", () => {
    const u = defaultUsage({ lineupSize: 9, rotationSize: 5, bullpenSize: 7 }, 6200, 6200, 0.62, 0, 7);
    expect(u.rotationBF.reduce((s, x) => s + x, 0)).toBeCloseTo(6200 * 0.62, 6);
    expect(u.rotationBF[0]!).toBeGreaterThan(u.rotationBF[4]!); // SP1 > SP5
    expect(u.rotationBF[4]!).toBeGreaterThan(0.5 * u.rotationBF[0]!); // SP5 ≈ 0.95/1.30 ≈ 0.73 of SP1 — mild lean
    expect(u.lineupPA.reduce((s, x) => s + x, 0)).toBeCloseTo(6200, 6);
    expect(u.lineupPA[0]!).toBeGreaterThan(u.lineupPA[8]!); // top-of-order lean
  });

  it("rotationDecay adds a manual tilt to SP1 on top of the format curve; rotationShare sizes the pen", () => {
    const format = defaultUsage({ lineupSize: 9, rotationSize: 5, bullpenSize: 7 }, 6200, 6200, 0.62, 0, 7);
    const tilted = defaultUsage({ lineupSize: 9, rotationSize: 5, bullpenSize: 7 }, 6200, 6200, 0.62, 0.5, 7);
    expect(tilted.rotationBF[0]! / tilted.rotationBF[4]!).toBeGreaterThan(format.rotationBF[0]! / format.rotationBF[4]!);
    expect(tilted.rotationBF.reduce((s, x) => s + x, 0)).toBeCloseTo(6200 * 0.62, 6);
    const biggerRot = defaultUsage({ lineupSize: 9, rotationSize: 5, bullpenSize: 7 }, 6200, 6200, 0.72);
    expect(biggerRot.bullpenBF.reduce((s, x) => s + x, 0)).toBeLessThan(6200 * 0.38);
  });

  it("bullpen leverage: the top 1–2 arms carry a premium, the rest are flat filler", () => {
    const u = defaultUsage({ lineupSize: 9, rotationSize: 5, bullpenSize: 8 }, 6200, 6200, 0.62, 0, 7, [2.5, 1.5]);
    expect(u.bullpenBF.reduce((s, x) => s + x, 0)).toBeCloseTo(6200 * 0.38, 6); // same total innings
    expect(u.bullpenBF[0]!).toBeGreaterThan(u.bullpenBF[1]!); // closer > setup
    expect(u.bullpenBF[1]!).toBeGreaterThan(u.bullpenBF[2]!); // setup > filler
    expect(u.bullpenBF[2]!).toBeCloseTo(u.bullpenBF[7]!, 9);  // all filler valued the same
    expect(u.bullpenBF[0]! / u.bullpenBF[2]!).toBeCloseTo(2.5, 6); // closer ≈ 2.5× a filler
  });

  it("rotationStarts: continuous cycle, mild top-lean from rest, SP5 never zero", () => {
    const bo7 = rotationStarts(7, 5);
    expect(bo7.reduce((s, x) => s + x, 0)).toBeCloseTo(5.81, 1); // total starts ≈ E[games] in a Bo7
    expect(bo7[0]!).toBeGreaterThan(bo7[4]!);   // SP1 leans above SP5 …
    expect(bo7[4]!).toBeGreaterThan(0.5);       // … but SP5 is real (~0.95 starts/series)
    expect(bo7[0]! / bo7[4]!).toBeLessThan(1.6); // and the lean is MILD (continuous cycle), not steep
    // Bo3: SP5 is NOT zero — the cycle keeps advancing across rounds (the correction).
    const bo3 = rotationStarts(3, 5);
    expect(bo3[4]!).toBeGreaterThan(0.15);
    expect(bo3.reduce((s, x) => s + x, 0)).toBeCloseTo(2.5, 1); // ≈ E[games] in a Bo3
    // A 4-man rotation gives the ace a larger SHARE of starts than a 5-man.
    const bo7_4 = rotationStarts(7, 4);
    const share = (a: number[], i: number) => a[i]! / a.reduce((s, x) => s + x, 0);
    expect(share(bo7_4, 0)).toBeGreaterThan(share(bo7, 0));
  });
});
