// Q-1 — the E[wins] cap/slots MILP guardrail. Everything e45ee3d + b5db870 added runs
// through generateFullRoster with usageWeights (the server ALWAYS builds them for cap/slots,
// server.ts), yet no prior test passed usageWeights / segmentWeights / staffLocks / lineupLocks.
// This suite exercises that path on tiny synthetic pools: cap respected under usageWeights,
// staff locks land in the right group, a lineup lock survives to the RETURNED lineups (S-4),
// the two-way slot rule, dial monotonicity, and bench start-indicator netting (zst).

import { describe, it, expect } from "vitest";
import { generateFullRoster, type HitterCandidate, type PitcherCandidate, type RosterOptimizeOptions } from "../src/optimizer/index.ts";

const NONC = ["1B", "2B", "3B", "SS", "LF", "CF", "RF", "DH"]; // every field pos except C, + DH
const ALLPOS = ["C", ...NONC];

function mkH(id: string, v: number, positions: string[] = ALLPOS, extra: Partial<HitterCandidate> = {}): HitterCandidate {
  return { id, title: id, bats: 1, valueVR: v, valueVL: v, positions, coverPositions: positions, cost: 60, ...extra };
}
function mkP(id: string, v: number, extra: Partial<PitcherCandidate> = {}): PitcherCandidate {
  return { id, title: id, throws: 1, valueVR: v, valueVL: v, stamina: 100, pitchTypes: 5, cost: 60, ...extra };
}

// E[wins] usage weights (the shape the server hands the MILP; leverage active: closer BF > filler).
const UW = { lineupPA: 700, benchPA: 30, rotationBF: [1000, 800], bullpenBF: [300, 200, 100, 100] };

// 9 hitters (one per position slot) + spares; 4 pitchers; nHitters 9 / nPitchers 4 / 2 SP.
const BASE: RosterOptimizeOptions = {
  nHitters: 9, nPitchers: 4, dh: true, minStarters: 2, minStarterStamina: 70, minPitchTypes: 3,
  platoonVR: 0.6, platoonVL: 0.4, minPlayersPerPosition: 1, backupCatcherDepth: 1,
  mode: "cap", totalCap: 100000, usageWeights: UW,
};

// A generous versatile pool: 12 hitters all-position (descending value), 6 qualified pitchers.
const HPOOL = Array.from({ length: 12 }, (_, i) => mkH(`H${i}`, 0.06 - i * 0.002));
const PPOOL = Array.from({ length: 6 }, (_, i) => mkP(`P${i}`, 0.05 - i * 0.002));

const rotValue = (r: Awaited<ReturnType<typeof generateFullRoster>>, byId: Map<string, PitcherCandidate>) =>
  r.rotation.reduce((s, x) => s + (byId.get(x.id)!.valueVR + byId.get(x.id)!.valueVL) / 2, 0);

describe("Q-1 — E[wins] cap/slots MILP", () => {
  it("cap mode under usageWeights: valid roster, cost within cap", async () => {
    const cap = 13 * 60; // 9H + 4P distinct, all cost 60 → exactly the floor
    const r = await generateFullRoster(HPOOL, PPOOL, { ...BASE, totalCap: cap });
    expect(r.status).toBe("Optimal");
    expect(r.hitters.length).toBe(9);
    expect(r.pitchers.length).toBe(4);
    expect(r.rotation.length).toBe(2);
    expect(r.cost!).toBeLessThanOrEqual(cap);
    expect(new Set([...r.hitters, ...r.pitchers]).size).toBe(13);
    // both platoon lineups fully filled
    expect(r.lineupVR.length).toBe(9);
    expect(r.lineupVL.length).toBe(9);
  });

  it("staff locks: a locked SP holds a rotation slot, a locked RP stays in the pen", async () => {
    // Lock the WEAKEST pitcher to SP and a mid pitcher to RP — neither would be auto-chosen there.
    const spLockId = "P5"; // weakest → wouldn't make the 2-man rotation on value
    const rpLockId = "P0"; // strongest → would normally ace the rotation; pin to bullpen instead
    const r = await generateFullRoster(HPOOL, PPOOL, {
      ...BASE,
      lockedIds: [spLockId, rpLockId],
      staffLocks: [{ id: spLockId, role: "sp" }, { id: rpLockId, role: "rp" }],
    });
    expect(r.status).toBe("Optimal");
    expect(r.rotation.map((x) => x.id)).toContain(spLockId);
    expect(r.bullpen).toContain(rpLockId);
    expect(r.rotation.map((x) => x.id)).not.toContain(rpLockId);
  });

  it("lineup lock survives to the RETURNED lineups: pins a weaker card over the natural starter (S-4)", async () => {
    // starC is the strongest bat and would naturally take C; lock lockC (weaker) to C both sides.
    const starC = mkH("starC", 0.10);
    const lockC = mkH("lockC", 0.01);
    const pool = [starC, lockC, ...HPOOL];
    const r = await generateFullRoster(pool, PPOOL, {
      ...BASE,
      lineupLocks: [{ id: "lockC", pos: "C", side: "R" }, { id: "lockC", pos: "C", side: "L" }],
    });
    expect(r.status).toBe("Optimal");
    expect(r.lineupVR.find((s) => s.pos === "C")!.id).toBe("lockC");
    expect(r.lineupVL.find((s) => s.pos === "C")!.id).toBe("lockC");
    // starC is still rostered (best bat) but plays elsewhere, not benched off the display
    expect(r.hitters).toContain("starC");
    expect(r.lineupVR.some((s) => s.id === "starC")).toBe(true);
  });

  it("eligible-but-unqualified lineup lock does not blank the lineup on Optimal (S-4 regression)", async () => {
    // Z is only QUALIFIED at 1B/DH but ELIGIBLE (playPositions) at C — and is the ONLY card that
    // can cover C. Pre-fix, the display re-match (qualified positions only) returned null → empty
    // lineup while status said Optimal. Post-fix it honors the eligible lock.
    const Z = mkH("Z", 0.05, ["1B", "DH"], { playPositions: ["C", "1B", "DH"], coverPositions: ["1B", "DH"] });
    // everyone else can NOT play C (so C is uncoverable except via Z's eligible lock)
    const others = Array.from({ length: 11 }, (_, i) => mkH(`N${i}`, 0.06 - i * 0.002, NONC));
    const pool = [Z, ...others];
    const r = await generateFullRoster(pool, PPOOL, {
      ...BASE,
      lineupLocks: [{ id: "Z", pos: "C", side: "R" }, { id: "Z", pos: "C", side: "L" }],
    });
    expect(r.status).toBe("Optimal");
    expect(r.lineupVR.length).toBe(9);          // NOT empty
    expect(r.lineupVL.length).toBe(9);
    expect(r.lineupVR.find((s) => s.pos === "C")!.id).toBe("Z");
    expect(r.lineupVL.find((s) => s.pos === "C")!.id).toBe("Z");
  });

  it("two-way slot rule: a designated two-way card nets one roster spot (counted once)", async () => {
    // TW is a strong hitter AND a usable pitcher (same id in both pools). Under a cap that only
    // fits 13 distinct cards, TW is feasible only if counted once; it fills a hitter AND a pitcher
    // slot → 14 role-fills over 13 DISTINCT cards (the freed slot flows to a bonus pick, which the
    // E[wins] path awards to whichever segment adds more value under the platoon-neutral pool).
    const twHit = mkH("TW", 0.09);
    const twPit = mkP("TW", 0.04);
    const H = [...HPOOL, twHit];
    const P = [...PPOOL, twPit];
    const cap = 13 * 60;
    const r = await generateFullRoster(H, P, { ...BASE, totalCap: cap, twoWayIds: ["TW"] });
    expect(r.status).toBe("Optimal");
    expect(r.twoWay).toEqual(["TW"]);
    expect(r.hitters).toContain("TW");
    expect(r.pitchers).toContain("TW");
    expect(new Set([...r.hitters, ...r.pitchers]).size).toBe(13);       // distinct roster = size
    expect(r.hitters.length + r.pitchers.length).toBe(14);             // TW fills two slots (one over 13)
    expect(r.hitters.length).toBeGreaterThanOrEqual(9);                // never fewer than nHitters
    expect(r.cost).toBeLessThanOrEqual(cap);                           // cost counts TW once
  });

  it("two-way bonus-hitter regime: a startable extra hitter takes the freed slot", async () => {
    // Give the pool a REASON to start a 10th distinct hitter: a vL-only and a vR-only specialist,
    // so full platooning fields 10 distinct starters across the two sides. Now the freed two-way
    // slot is best spent on a bonus HITTER (who starts on one side), exercising the y2bh regime.
    const twHit = mkH("TW", 0.09);
    const twPit = mkP("TW", 0.04);
    const vlSpec = mkH("VL", 0.02, ALLPOS, { valueVR: -0.20, valueVL: 0.12 });
    const vrSpec = mkH("VR", 0.02, ALLPOS, { valueVR: 0.12, valueVL: -0.20 });
    const H = [vlSpec, vrSpec, ...HPOOL, twHit];
    const P = [...PPOOL, twPit];
    const cap = 14 * 60;
    const r = await generateFullRoster(H, P, { ...BASE, totalCap: cap, twoWayIds: ["TW"] });
    expect(r.status).toBe("Optimal");
    expect(r.twoWay).toEqual(["TW"]);
    expect(r.hitters.length).toBe(10);   // freed slot → bonus starting hitter
    expect(new Set([...r.hitters, ...r.pitchers]).size).toBe(13);
    // the specialists start on their favorable side
    expect(r.lineupVL.some((s) => s.id === "VL")).toBe(true);
    expect(r.lineupVR.some((s) => s.id === "VR")).toBe(true);
  });

  it("dial monotonicity: raising the rotation dial never lowers the rotation's total value", async () => {
    // Binding cap so the solver must trade hitter spend against rotation spend. A stronger rotation
    // dial makes SP value count for more → rotation value must not fall.
    const byId = new Map(PPOOL.map((c) => [c.id, c]));
    const cap = 13 * 60;
    const low = await generateFullRoster(HPOOL, PPOOL, { ...BASE, totalCap: cap, segmentWeights: { rotation: 0.2 } });
    const high = await generateFullRoster(HPOOL, PPOOL, { ...BASE, totalCap: cap, segmentWeights: { rotation: 5 } });
    expect(low.status).toBe("Optimal");
    expect(high.status).toBe("Optimal");
    expect(rotValue(high, byId)).toBeGreaterThanOrEqual(rotValue(low, byId) - 1e-9);
  });

  it("max_variants_on_roster: caps rostered variant cards; 0/undefined = unlimited; two-way variant counts once", async () => {
    // A pool RICH in strictly-better variant cards (id#V) — without a cap the optimizer takes them
    // all. maxVariants=2 must leave exactly ≤2 variants on the roster, and prefer the best 2.
    const baseCards = Array.from({ length: 9 }, (_, i) => mkH(`B${i}`, 0.01 + i * 0.001));
    const varCards = Array.from({ length: 9 }, (_, i) => mkH(`V${i}#V`, 0.20 - i * 0.001)); // dominate on value
    const H = [...baseCards, ...varCards];
    const P = PPOOL;
    const isVar = (id: string) => /#V$/.test(id);

    // unlimited (no cap): the strong variants dominate the 9 hitter slots
    const uncapped = await generateFullRoster(H, P, { ...BASE });
    expect(uncapped.status).toBe("Optimal");
    expect(uncapped.hitters.filter(isVar).length).toBeGreaterThan(2);

    // cap = 2: at most 2 variants, and they should be the two best (V0#V, V1#V)
    const capped = await generateFullRoster(H, P, { ...BASE, maxVariants: 2 });
    expect(capped.status).toBe("Optimal");
    const vars = capped.hitters.filter(isVar);
    expect(vars.length).toBe(2);
    expect(new Set(vars)).toEqual(new Set(["V0#V", "V1#V"]));

    // cap = 0: unlimited (editor convention) — same as uncapped, variants allowed freely
    const zero = await generateFullRoster(H, P, { ...BASE, maxVariants: 0 });
    expect(zero.hitters.filter(isVar).length).toBeGreaterThan(2);
  });

  it("max_variants: a two-way variant counts once against the cap", async () => {
    // TW#V is a two-way variant. With maxVariants=1 and one other variant hitter available, the
    // solver may roster TW#V (counts as ONE variant though it fills a hitter + pitcher slot).
    const twHit = mkH("TW#V", 0.09);
    const twPit = mkP("TW#V", 0.05);
    const otherVar = mkH("W0#V", 0.20); // a strong pure-hitter variant
    const H = [...HPOOL, otherVar, twHit];
    const P = [...PPOOL, twPit];
    const isVar = (id: string) => /#V$/.test(id);
    const r = await generateFullRoster(H, P, { ...BASE, maxVariants: 1, twoWayIds: ["TW#V"] });
    expect(r.status).toBe("Optimal");
    // distinct variant CARDS rostered ≤ 1 (TW#V counted once even in both pools)
    const distinctVars = new Set([...r.hitters, ...r.pitchers].filter(isVar));
    expect(distinctVars.size).toBeLessThanOrEqual(1);
  });

  it("zst netting: a rostered non-starting bench bat occupies neither returned lineup", async () => {
    // nHitters 9 but 10 hitters can be rostered via the bench (bench credit is positive). The
    // 10th (a spare) must not appear in a lineup — the start-indicator (zst) keeps starters and
    // bench distinct so a bench bat never collects a starter's lineupPA.
    const r = await generateFullRoster(HPOOL, PPOOL, { ...BASE });
    expect(r.status).toBe("Optimal");
    const starterIds = new Set([...r.lineupVR.map((s) => s.id), ...r.lineupVL.map((s) => s.id)]);
    const benchOnly = r.hitters.filter((id) => !starterIds.has(id));
    // any bench-only hitter is rostered but in neither lineup (no double-credit)
    for (const id of benchOnly) {
      expect(r.lineupVR.some((s) => s.id === id)).toBe(false);
      expect(r.lineupVL.some((s) => s.id === id)).toBe(false);
    }
  });
});
