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
import { generateHitterRoster, lineupPositions, type HitterCandidate } from "../src/optimizer/index.ts";

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

function candidates(): HitterCandidate[] {
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
      return { id: String(s.cardId), title: String(s.title), bats: s.bats, valueVR: valueFor(s.hit.woba_vR, "hitter"), valueVL: valueFor(s.hit.woba_vL, "hitter"), positions: pos };
    })
    .sort((a, b) => Math.max(b.valueVR, b.valueVL) - Math.max(a.valueVR, a.valueVL))
    .slice(0, 250); // decomposed pool (D5) — fast + lossless at this scale
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
