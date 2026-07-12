// Cross-role consistency alarm (src/eval/consistency.ts) — the two independently-fitted
// curve families (hitter → line, pitcher → allowed line) must roughly agree on a closed
// pool's implied event totals IN-FRAME, and their divergence must GROW as the pool moves
// out of the training frame (that growth is the alarm). Deliberately NO exact-number
// assertions — the magnitudes move whenever the model is retrained; only the structure
// (agreement tolerance in-frame, strict monotone growth out-of-frame, gap signs) is pinned.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { computeConsistency, CONSISTENCY_EVENTS } from "../src/eval/consistency.ts";
import { makeRawPolyModel, type Coeffs } from "../src/scoring-core/index.ts";
import type { EventForm } from "../src/model/curves.ts";

// The committed frozen #2 form + neutralized capture coeffs (same recipe as
// raw-poly.test.ts) — env factors identity so only the fitted curves speak.
const form = JSON.parse(readFileSync("fixtures/eventform-active.json", "utf8")).eventForm as EventForm;
function neutralCoeffs(): Coeffs {
  const base = JSON.parse(readFileSync("fixtures/captures/_synthetic.json", "utf8")).coeffs as Coeffs;
  return {
    ...base,
    tournament_hr_adjust: false,
    park_avg_l: 1, park_avg_r: 1, park_hr_l: 1, park_hr_r: 1, park_gap: 1,
    era_bb: 1, era_k: 1, era_avg: 1, era_hr: 1, era_bip: 1, era_gap: 1, era_thr: 1,
    adv_hbp: 6, adv_sh: 3, adv_sf: 4,
    ssp_adv_hitting: 1, ssp_basic_hitting: 1, ssp_basic_pitching: 1,
  };
}

// Deterministic synthetic catalog (CSV-column shape, both roles' ratings on every card,
// per tests/raw-poly.test.ts cardFrom). Two things make the strong pool "in-frame":
//   • each channel is centered near its REAL reference-field mean (the training frame
//     runs pitcher Control ~100 but hitter Eye ~124 — one shared level would itself
//     push a role out of frame and manufacture divergence);
//   • ratings are CORRELATED within a card (one quality draw + per-channel jitter),
//     like real cards, so the top-X selection doesn't cherry-pick single channels.
// `scale` shrinks every rating — scale 1 ≈ the league frame; scale 0.5 ≈ the weak
// sub-85 pool the alarm exists for. Same seed ⇒ the weak pool is a scaled copy.
const CENTERS: Record<string, number> = {
  Eye: 124, Power: 118, "Avoid K": 116, BABIP: 123, Gap: 105,
  Control: 100, Stuff: 122, pBABIP: 118, pHR: 123,
};
function lcg(seed: number) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32; }
function makeCards(count: number, scale: number, seed = 42): Record<string, unknown>[] {
  const rnd = lcg(seed);
  const cards: Record<string, unknown>[] = [];
  for (let i = 0; i < count; i++) {
    const c: Record<string, unknown> = {
      "Card ID": `synth-${i}`, "//Card Title": `synth ${i}`, Bats: 1, Throws: 1,
      Speed: 80, Stealing: 80, Baserunning: 80,
    };
    const quality = (rnd() - 0.5) * 50; // card-wide quality offset (correlates channels)
    for (const side of ["vR", "vL"]) for (const col of Object.keys(CENTERS))
      c[`${col} ${side}`] = Math.max(1, Math.round((CENTERS[col]! + quality + (rnd() - 0.5) * 24) * scale));
    cards.push(c);
  }
  return cards;
}

describe("cross-role consistency alarm", () => {
  const coeffs = neutralCoeffs();
  const model = makeRawPolyModel(form);
  const strong = makeCards(160, 1);
  const weak = makeCards(160, 0.5);
  const rStrong = computeConsistency(strong, strong, coeffs, model, { topX: 100, fieldN: 50 });
  const rWeak = computeConsistency(weak, strong, coeffs, model, { topX: 100, fieldN: 50 });

  it("(a) in-frame pool: hitter- and pitcher-implied totals agree within tolerance", () => {
    // Loose bounds on purpose (proxy identity — deployment weights differ; see module header).
    expect(rStrong.maxAbsEventDiffPer600).toBeLessThan(25);
    for (const ev of CONSISTENCY_EVENTS) {
      const { ratio, hitterPer600, pitcherPer600 } = rStrong.events[ev];
      expect(hitterPer600).toBeGreaterThan(0);
      expect(pitcherPer600).toBeGreaterThan(0);
      expect(ratio).toBeGreaterThan(0.6);
      expect(ratio).toBeLessThan(1.67);
    }
  });

  it("(b) out-of-frame pool: divergence strictly GROWS vs the in-frame pool (the alarm)", () => {
    expect(rWeak.maxAbsEventDiffPer600).toBeGreaterThan(rStrong.maxAbsEventDiffPer600);
    // …and vs its own reference baseline (the comparison the endpoint surfaces).
    expect(rWeak.maxAbsEventDiffPer600).toBeGreaterThan(rWeak.referenceMaxAbsEventDiffPer600);
  });

  it("pool == reference ⇒ events mirror referenceEvents and frame gaps are ~0", () => {
    expect(rStrong.events).toEqual(rStrong.referenceEvents);
    for (const blk of [rStrong.gaps.hit, rStrong.gaps.pit])
      for (const g of Object.values(blk)) expect(Math.abs(g.gap)).toBeLessThan(1e-9);
  });

  it("weak pool ⇒ every frame gap is positive (reference field sits above the pool field)", () => {
    for (const blk of [rWeak.gaps.hit, rWeak.gaps.pit])
      for (const g of Object.values(blk)) {
        expect(g.gap).toBeGreaterThan(0);
        expect(g.refMu).toBeGreaterThan(g.poolMu);
      }
  });

  it("report shape: all five events present, counts + sizes carried through", () => {
    expect(Object.keys(rWeak.events).sort()).toEqual([...CONSISTENCY_EVENTS].sort());
    expect(rWeak.topX).toBe(100);
    expect(rWeak.fieldN).toBe(50);
    expect(rWeak.poolCards).toBe(160);
    expect(rWeak.refCards).toBe(160);
  });
});
