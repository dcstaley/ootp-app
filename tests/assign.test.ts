// Phase 2: the assignment sub-solve (assignRoster). Pins that the lineup matching is
// EXACTLY max-weight (it will place a flexible star at a less-natural slot to cover a
// position only a weaker card can fill), that infeasible sets return null, that the rotation
// takes the best starter-qualified arms, and that better sets score higher E[wins].

import { describe, it, expect } from "vitest";
import { assignRoster } from "../src/optimizer/assign.ts";
import { setExpectedWins } from "../src/eval/index.ts";
import type { HitterCandidate, PitcherCandidate, RosterOptimizeOptions } from "../src/optimizer/index.ts";

const H = (id: string, positions: string[], vR: number, vL = vR): HitterCandidate =>
  ({ id, title: id, bats: 1, valueVR: vR, valueVL: vL, positions, cost: 60 });
const P = (id: string, vR: number, stamina = 80, pitchTypes = 4): PitcherCandidate =>
  ({ id, title: id, throws: 1, valueVR: vR, valueVL: vR, stamina, pitchTypes, cost: 60 });

const OPTS: RosterOptimizeOptions = {
  nHitters: 9, nPitchers: 4, dh: true, minStarters: 2, minStarterStamina: 70, minPitchTypes: 3,
  platoonVR: 0.58, platoonVL: 0.42, mode: "cap",
};

// 7 single-position fillers + two cards contesting {1B, DH}: A is 1B-only (weaker),
// B is 1B-or-DH (stronger). Max weight must send B to DH so A can cover 1B.
const FILLERS = [
  H("c", ["C"], 0.01), H("2b", ["2B"], 0.01), H("3b", ["3B"], 0.01), H("ss", ["SS"], 0.01),
  H("lf", ["LF"], 0.01), H("cf", ["CF"], 0.01), H("rf", ["RF"], 0.01),
];
const A = H("A_1b", ["1B"], 0.04);
const B = H("B_flex", ["1B", "DH"], 0.05);
const HITTERS = [...FILLERS, A, B];
const PITCHERS = [P("sp1", 0.05), P("sp2", 0.04), P("rp1", 0.03, 40), P("rp2", 0.02, 40)];

describe("assignRoster — exact assignment sub-solve", () => {
  it("fields both platoon lineups covering every position exactly once", () => {
    const r = assignRoster(HITTERS, PITCHERS, OPTS)!;
    expect(r).not.toBeNull();
    for (const lineup of [r.lineupVR, r.lineupVL]) {
      expect(lineup.map((s) => s.pos).sort()).toEqual(["1B", "2B", "3B", "C", "CF", "DH", "LF", "RF", "SS"]);
    }
  });

  it("max-weight: the flexible star is placed at DH so the 1B-only card covers 1B", () => {
    const r = assignRoster(HITTERS, PITCHERS, OPTS)!;
    const at = (pos: string) => r.lineupVR.find((s) => s.pos === pos)!.id;
    expect(at("1B")).toBe("A_1b");   // weaker, but 1B is its only slot
    expect(at("DH")).toBe("B_flex"); // star slides to DH — higher total wOBA
  });

  it("returns null when a position cannot be covered by the set", () => {
    const noSS = HITTERS.filter((c) => c.id !== "ss"); // nobody else can play SS
    expect(assignRoster(noSS, PITCHERS, OPTS)).toBeNull();
  });

  it("returns null when too few starter-qualified arms for the rotation", () => {
    const onlyOneSP = [P("sp1", 0.05), P("rp1", 0.03, 40), P("rp2", 0.02, 40), P("rp3", 0.02, 40)];
    expect(assignRoster(HITTERS, onlyOneSP, OPTS)).toBeNull();
  });

  it("the rotation takes the best starter-qualified arms by SP value", () => {
    const r = assignRoster(HITTERS, PITCHERS, OPTS)!;
    expect(new Set(r.rotation.map((x) => x.id))).toEqual(new Set(["sp1", "sp2"]));
    expect(r.bullpen.sort()).toEqual(["rp1", "rp2"]);
  });

  it("a stronger set scores higher E[wins] through the evaluator", () => {
    const strongHitters = HITTERS.map((c) => ({ ...c, valueVR: c.valueVR + 0.03, valueVL: c.valueVL + 0.03 }));
    const wWeak = setExpectedWins(HITTERS, PITCHERS, OPTS)!.winPct;
    const wStrong = setExpectedWins(strongHitters, PITCHERS, OPTS)!.winPct;
    expect(wStrong).toBeGreaterThan(wWeak);
  });
});
