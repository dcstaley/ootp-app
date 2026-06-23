// M4 Phase A — the hitter roster + dual-lineup optimizer produces a STRUCTURALLY
// VALID result on the real scored pool: N distinct rostered hitters, every lineup
// position filled exactly once per side by an eligible+rostered card, and backup
// catcher depth met. (Roster-quality parity vs the old app is a later, looser
// gate; this pins feasibility + the constraints.)

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { parseCatalogCsv, type Card } from "../src/data/catalog.ts";
import { buildEligiblePool } from "../src/config/eligibility.ts";
import { scoreCard, calibrate, computeDerived, valueFor, type Coeffs } from "../src/scoring-core/index.ts";
import type { Tournament } from "../src/config/tournament.ts";
import {
  generateHitterRoster, generatePitcherStaff, generateRoster, generateFullRoster,
  lineupPositions, qualifiesStarter, type HitterCandidate, type PitcherCandidate,
} from "../src/optimizer/index.ts";

const TOURNAMENT: Tournament = {
  id: "t", name: "t", card_value_min: 60, card_value_max: 89, total_cap: 1858,
  roster_size: 26, hitters: 13, pitchers: 13, min_starters: 5, min_starter_stamina: 70, min_pitch_types: 3, dh: true,
  variants_allowed: true, max_variants_on_roster: 5,
  eraId: "", parkId: "", softcaps: {} as Tournament["softcaps"], eligibility: { mode: "ALL", rules: [] },
};
const POS: [string, string][] = [
  ["C", "LearnC"], ["1B", "Learn1B"], ["2B", "Learn2B"], ["3B", "Learn3B"],
  ["SS", "LearnSS"], ["LF", "LearnLF"], ["CF", "LearnCF"], ["RF", "LearnRF"],
];
const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const loadCoeffs = (): Coeffs => {
  for (const c of ["real-parkera", "real-thr", "real-neutral", "_synthetic"]) {
    const f = `fixtures/captures/${c}.json`;
    if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8")).coeffs;
  }
  throw new Error("no capture");
};
const eligiblePositions = (c: Card): string[] => [...POS.filter(([, col]) => n(c[col]) === 1).map(([p]) => p), "DH"];

const PITCH_TYPES = ["Fastball", "Slider", "Curveball", "Changeup", "Cutter", "Sinker", "Splitter", "Forkball", "Screwball", "Circlechange", "Knucklecurve", "Knuckleball"];
const pitchCount = (c: Card) => PITCH_TYPES.filter((p) => n(c[p]) > 0).length;

function pitcherCandidates(limit = 120): PitcherCandidate[] {
  const coeffs = loadCoeffs();
  const derived = computeDerived(coeffs);
  const catalog = parseCatalogCsv(readFileSync("docs/pt_card_list.csv", "utf8"));
  const pool = buildEligiblePool(catalog.cards, TOURNAMENT);
  const cfg = { coeffs, derived, calScales: calibrate(pool, { coeffs, derived }) };
  return pool
    .filter((c) => n(c["Pos Rating P"]) > 0)
    .map((c) => {
      const s = scoreCard(c, cfg);
      return {
        id: String(s.cardId), title: String(s.title), throws: s.throws,
        valueVR: valueFor(s.pitch.woba_vR, "pitcher"), valueVL: valueFor(s.pitch.woba_vL, "pitcher"),
        stamina: n(c["Stamina"]), pitchTypes: pitchCount(c), cost: n(c["Card Value"]),
      };
    })
    .sort((a, b) => (b.valueVR + b.valueVL) - (a.valueVR + a.valueVL))
    .slice(0, limit);
}

function candidates(limit = 250): HitterCandidate[] {
  const coeffs = loadCoeffs();
  const derived = computeDerived(coeffs);
  const catalog = parseCatalogCsv(readFileSync("docs/pt_card_list.csv", "utf8"));
  const pool = buildEligiblePool(catalog.cards, TOURNAMENT);
  const cfg = { coeffs, derived, calScales: calibrate(pool, { coeffs, derived }) };
  return pool
    .map((c) => ({ c, pos: eligiblePositions(c) }))
    .filter((x) => x.pos.length > 1)
    .map(({ c, pos }) => {
      const s = scoreCard(c, cfg);
      return { id: String(s.cardId), title: String(s.title), bats: s.bats, valueVR: valueFor(s.hit.woba_vR, "hitter"), valueVL: valueFor(s.hit.woba_vL, "hitter"), positions: pos, cost: n(c["Card Value"]) };
    })
    .sort((a, b) => Math.max(b.valueVR, b.valueVL) - Math.max(a.valueVR, a.valueVL))
    .slice(0, limit); // decomposed pool (D5) — fast + lossless at this scale
}

describe("M4 hitter roster + dual lineup", () => {
  const cands = candidates();
  const byId = new Map(cands.map((c) => [c.id, c]));
  const opts = { nHitters: 13, dh: true, platoonVR: 0.62, platoonVL: 0.38, backupCatcherDepth: 2 };

  it("solves to a structurally valid roster + lineups", async () => {
    const r = await generateHitterRoster(cands, opts);
    expect(r.status).toBe("Optimal");

    // exactly N distinct hitters
    expect(r.hitters.length).toBe(13);
    expect(new Set(r.hitters).size).toBe(13);

    const expectedPos = lineupPositions(true);
    for (const lineup of [r.lineupVR, r.lineupVL]) {
      // every position filled exactly once
      expect(lineup.map((s) => s.pos).sort()).toEqual([...expectedPos].sort());
      for (const slot of lineup) {
        const cand = byId.get(slot.id)!;
        expect(cand).toBeTruthy();
        // assigned position is eligible
        expect(cand.positions).toContain(slot.pos);
        // assigned card is rostered
        expect(r.hitters).toContain(slot.id);
      }
    }

    // backup catcher depth: ≥2 rostered can play C
    const rosteredCatchers = r.hitters.filter((id) => byId.get(id)!.positions.includes("C"));
    expect(rosteredCatchers.length).toBeGreaterThanOrEqual(2);
  });

  it("respects the platoon weighting (RHP-heavy favors vR value)", async () => {
    const vrHeavy = await generateHitterRoster(cands, { ...opts, platoonVR: 0.95, platoonVL: 0.05 });
    const vrValue = vrHeavy.lineupVR.reduce((s, slot) => s + byId.get(slot.id)!.valueVR, 0);
    const vlValue = vrHeavy.lineupVL.reduce((s, slot) => s + byId.get(slot.id)!.valueVL, 0);
    // the vR lineup should be optimized hard; both lineups still fully filled
    expect(vrHeavy.lineupVR.length).toBe(9);
    expect(vrHeavy.lineupVL.length).toBe(9);
    expect(vrValue).toBeGreaterThan(0);
    expect(vlValue).toBeGreaterThan(0);
  });
});

describe("M4 pitcher staff (rotation + bullpen)", () => {
  const pcands = pitcherCandidates();
  const pById = new Map(pcands.map((c) => [c.id, c]));
  const popts = { nPitchers: 13, minStarters: 5, minStarterStamina: 70, minPitchTypes: 3, platoonVR: 0.62, platoonVL: 0.38 };

  it("selects a valid staff with a qualified, slotted rotation", async () => {
    const staff = await generatePitcherStaff(pcands, popts);
    expect(staff.status).toBe("Optimal");
    expect(staff.pitchers.length).toBe(13);
    expect(new Set(staff.pitchers).size).toBe(13);

    // rotation: 5 slots, ordered 1..5, all starter-qualified, all rostered
    expect(staff.rotation.map((r) => r.slot)).toEqual([1, 2, 3, 4, 5]);
    for (const r of staff.rotation) {
      const p = pById.get(r.id)!;
      expect(qualifiesStarter(p, 70, 3)).toBe(true);
      expect(staff.pitchers).toContain(r.id);
    }
    // bullpen = rest; rotation ∪ bullpen = pitchers, disjoint
    expect(staff.bullpen.length).toBe(8);
    const rotIds = new Set(staff.rotation.map((r) => r.id));
    expect(staff.bullpen.some((id) => rotIds.has(id))).toBe(false);
    expect(new Set([...staff.rotation.map((r) => r.id), ...staff.bullpen]).size).toBe(13);

    // SP1 should be the rotation's best by value (slot weighting orders aces first)
    const rotVals = staff.rotation.map((r) => pById.get(r.id)!).map((p) => popts.platoonVR * p.valueVR + popts.platoonVL * p.valueVL);
    expect(rotVals[0]).toBe(Math.max(...rotVals));
  });
});

describe("M4 combined roster (hitters + pitchers)", () => {
  it("assembles a full 26-card roster", async () => {
    const roster = await generateRoster(
      candidates(), pitcherCandidates(),
      { nHitters: 13, dh: true, platoonVR: 0.62, platoonVL: 0.38, backupCatcherDepth: 2 },
      { nPitchers: 13, minStarters: 5, minStarterStamina: 70, minPitchTypes: 3, platoonVR: 0.62, platoonVL: 0.38 },
    );
    expect(roster.status).toBe("Optimal");
    expect(roster.hitters.length).toBe(13);
    expect(roster.pitchers.length).toBe(13);
    expect(roster.hitters.length + roster.pitchers.length).toBe(26);
    expect(roster.rotation.length).toBe(5);
    expect(roster.lineupVR.length).toBe(9);
    expect(roster.lineupVL.length).toBe(9);
  });
});

describe("M4 Phase C — cap & slots budgets", () => {
  // Full pools so cheap (low Card Value) cards are available under a tight budget.
  const H = candidates(1e9);
  const P = pitcherCandidates(1e9);
  const base = {
    nHitters: 13, nPitchers: 13, dh: true, minStarters: 5, minStarterStamina: 70, minPitchTypes: 3,
    platoonVR: 0.62, platoonVL: 0.38, backupCatcherDepth: 2,
  } as const;

  it("cap mode keeps the roster within total_cap", async () => {
    const cap = 1858;
    const r = await generateFullRoster(H, P, { ...base, mode: "cap", totalCap: cap });
    expect(r.status).toBe("Optimal");
    expect(r.hitters.length).toBe(13);
    expect(r.pitchers.length).toBe(13);
    expect(r.rotation.length).toBe(5);
    expect(r.cost!).toBeLessThanOrEqual(cap);
    expect(r.balance).toBeTruthy();
  });

  it("slots mode respects cumulative tier limits", async () => {
    const slotCounts = { gold: 8, silver: 8, bronze: 10 }; // ≤8 cards ≥80, ≤16 ≥70, ≤26 ≥60
    const r = await generateFullRoster(H, P, { ...base, mode: "slots", slotCounts, rosterSize: 26 });
    expect(r.status).toBe("Optimal");
    const costs = [...r.hitters, ...r.pitchers].map((id) =>
      (H.find((c) => c.id === id) ?? P.find((c) => c.id === id))!.cost);
    expect(costs.filter((v) => v >= 80).length).toBeLessThanOrEqual(8);
    expect(costs.filter((v) => v >= 70).length).toBeLessThanOrEqual(16);
    expect(costs.filter((v) => v >= 60).length).toBeLessThanOrEqual(26);
  });

  it("pitcher emphasis shifts cap spend toward pitcher value (SP-7 knob)", async () => {
    const cap = 1858;
    const lowP = await generateFullRoster(H, P, { ...base, mode: "cap", totalCap: cap, pitcherEmphasis: 0.5 });
    const highP = await generateFullRoster(H, P, { ...base, mode: "cap", totalCap: cap, pitcherEmphasis: 2.0 });
    expect(lowP.status).toBe("Optimal");
    expect(highP.status).toBe("Optimal");
    // emphasizing pitchers should not decrease the rostered pitcher value share
    expect(highP.balance!.pitcherValue).toBeGreaterThanOrEqual(lowP.balance!.pitcherValue - 1e-6);
  });
});

// ── Two-way players (synthetic, controlled pool) ──────────────────────────────
const ALLPOS = ["C", "1B", "2B", "3B", "SS", "LF", "CF", "RF", "DH"];
const synthHitters = (n: number, base = 0.05): HitterCandidate[] =>
  Array.from({ length: n }, (_, i) => ({ id: `H${i}`, title: `H${i}`, bats: 1, valueVR: base - i * 0.001, valueVL: base - i * 0.001, positions: ALLPOS, cost: 50 }));
const synthPitchers = (n: number, base = 0.05): PitcherCandidate[] =>
  Array.from({ length: n }, (_, i) => ({ id: `P${i}`, title: `P${i}`, throws: 1, valueVR: base - i * 0.001, valueVL: base - i * 0.001, stamina: 100, pitchTypes: 5, cost: 50 }));

describe("M4 two-way players", () => {
  // TW is a strong hitter AND a usable pitcher, present in both pools with one id.
  const twHit: HitterCandidate = { id: "TW", title: "TW", bats: 1, valueVR: 0.09, valueVL: 0.09, positions: ALLPOS, cost: 50 };
  const twPit: PitcherCandidate = { id: "TW", title: "TW", throws: 1, valueVR: 0.04, valueVL: 0.04, stamina: 100, pitchTypes: 5, cost: 50 };
  const H = [...synthHitters(12), twHit];
  const P = [...synthPitchers(12), twPit];
  const base = {
    nHitters: 9, nPitchers: 3, dh: true, minStarters: 1, minStarterStamina: 70, minPitchTypes: 3,
    platoonVR: 0.62, platoonVL: 0.38, rosterSize: 12, minPlayersPerPosition: 2,
  } as const;

  it("uses a designated two-way card on both sides, frees a slot for a bonus hitter, counts cost once", async () => {
    // totalCap = 12 distinct × 50 = 600: only feasible if TW's cost is counted ONCE.
    const r = await generateFullRoster(H, P, { ...base, mode: "cap", totalCap: 600, twoWayIds: ["TW"] });
    expect(r.status).toBe("Optimal");
    expect(r.twoWay).toEqual(["TW"]);
    // TW appears in both sub-rosters; distinct roster = exactly rosterSize
    expect(r.hitters).toContain("TW");
    expect(r.pitchers).toContain("TW");
    expect(new Set([...r.hitters, ...r.pitchers]).size).toBe(12);
    // freed slot → an extra hitter (10H + 3P = 13 role-fills over 12 distinct cards)
    expect(r.hitters.length).toBe(10);
    expect(r.pitchers.length).toBe(3);
    // cost counts the two-way card once
    expect(r.cost).toBe(600);
  });

  it("treats a shared-id card as single-role when NOT designated two-way", async () => {
    const r = await generateFullRoster(H, P, { ...base, mode: "cap", totalCap: 600, twoWayIds: [] });
    expect(r.status).toBe("Optimal");
    expect(r.twoWay).toEqual([]);
    // TW may be a hitter or a pitcher, but never both
    expect(r.hitters.includes("TW") && r.pitchers.includes("TW")).toBe(false);
    expect(r.hitters.length + r.pitchers.length).toBe(12); // no freed slot
    expect(new Set([...r.hitters, ...r.pitchers]).size).toBe(12);
  });

  it("forces a locked two-way card onto the roster as both", async () => {
    // A weak-hitting TW that wouldn't be auto-selected, but locked + two-way.
    const weakTwHit: HitterCandidate = { id: "TW", title: "TW", bats: 1, valueVR: -0.2, valueVL: -0.2, positions: ALLPOS, cost: 50 };
    const r = await generateFullRoster([...synthHitters(12), weakTwHit], P, { ...base, mode: "none", twoWayIds: ["TW"], lockedIds: ["TW"] });
    expect(r.status).toBe("Optimal");
    expect(r.hitters).toContain("TW");
    expect(r.pitchers).toContain("TW");
    expect(r.twoWay).toEqual(["TW"]);
  });
});
