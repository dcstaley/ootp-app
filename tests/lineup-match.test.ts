// Unit tests for the lineup-assignment primitive behind Biggest Upgrades. The matching
// must (a) pick the best player per position, (b) resolve position cascades (a strong
// multi-position player shifting to free a slot), and (c) report infeasible when a
// position can't be filled.
import { describe, it, expect } from "vitest";
import { bestLineupValue, type MatchHitter } from "../src/optimizer/lineup-match.ts";

const POS = ["C", "1B", "2B", "3B", "SS", "LF", "CF", "RF", "DH"];
const one = (id: string, positions: string[], v: number): MatchHitter => ({ id, positions, valueVR: v, valueVL: v });

describe("bestLineupValue", () => {
  it("fills every position with the available players", () => {
    const players = POS.map((p, i) => one("p" + i, [p], 1));
    expect(bestLineupValue(players, "R", true)).toBe(9);
  });

  it("uses a higher-value candidate, benching the player it displaces", () => {
    const base = POS.map((p, i) => one("p" + i, [p], 1));
    const withSS = [...base, one("x", ["SS"], 5)]; // SS 1 → 5, old SS benched: 9 - 1 + 5
    expect(bestLineupValue(withSS, "R", true)).toBe(13);
  });

  it("resolves a position cascade (multi-position player shifts to free a slot)", () => {
    const rest = ["C", "1B", "3B", "LF", "CF", "RF", "DH"].map((p, i) => one("r" + i, [p], 1));
    const cascade = [one("A", ["SS", "2B"], 10), one("B", ["2B"], 1), ...rest]; // A@SS, B@2B → 18
    expect(bestLineupValue(cascade, "R", true)).toBe(18);
    const withC = [...cascade, one("C", ["SS"], 6)]; // C@SS(6), A→2B(10), B benched(1): 18 - 1 + 6
    expect(bestLineupValue(withC, "R", true)).toBe(23);
  });

  it("respects per-side values independently", () => {
    const base = POS.slice(0, 8).map((p, i) => one("p" + i, [p], 1));
    const dhPlayer: MatchHitter = { id: "dh", positions: ["DH"], valueVR: 3, valueVL: 7 };
    const players = [...base, dhPlayer];
    expect(bestLineupValue(players, "R", true)).toBe(8 + 3);
    expect(bestLineupValue(players, "L", true)).toBe(8 + 7);
  });

  it("returns -Infinity when a position cannot be filled", () => {
    const players = POS.slice(0, 8).map((p, i) => one("p" + i, [p], 1)); // 8 players, 9 slots
    expect(bestLineupValue(players, "R", true)).toBe(-Infinity);
  });

  it("ignores the DH slot when dh = false", () => {
    const players = POS.slice(0, 8).map((p, i) => one("p" + i, [p], 1)); // 8 field players
    expect(bestLineupValue(players, "R", false)).toBe(8);
  });
});
