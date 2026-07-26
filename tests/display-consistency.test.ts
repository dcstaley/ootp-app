// Consistency sweep 2026-07-25, findings 2 / 3 / 4 / 6 — four quantities that were computed one way
// where the user READS them and another way where the app ACTS on them. Same class as the platoon-
// capture defect fixed in 7c8a061 (tests/platoon-capture.test.ts is the template): every fix here is
// a second copy being deleted, so every test below asserts AGREEMENT between two producers, plus a
// concrete fixture on which the pre-fix expression gave a different answer (the leg that fails on the
// old build — without it an agreement test can pass vacuously).
//
// Items 1-2 are solve-driven (real HiGHS), not objective-string reading.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { generateFullRoster } from "../src/optimizer/generate.ts";
import { assignRoster, bestLineup, effectiveValue } from "../src/optimizer/assign.ts";
import { lineupPositions } from "../src/optimizer/types.ts";
import type { HitterCandidate, PitcherCandidate, RosterOptimizeOptions } from "../src/optimizer/index.ts";
import { computeConsistency } from "../src/eval/consistency.ts";
import {
  computeUnifiedFieldStats, productionFieldStats, FIELD_N, computeDerived, makeRawPolyModel, type Coeffs,
} from "../src/scoring-core/index.ts";
import { hittingComponents, pitchingComponents } from "../src/scoring-core/woba.ts";
import { HIT_RATINGS, PIT_RATINGS } from "../src/model/pool-transform.ts";
import { PRESENCE_M } from "../src/data/variants.ts";
import { hRate, HIT_BIP_ADJ, PIT_BIP_ADJ, type EventForm } from "../src/model/curves.ts";

const form = JSON.parse(readFileSync("fixtures/eventform-active.json", "utf8")).eventForm as EventForm;
const model = makeRawPolyModel(form);
/** The captures/synthetic coeff bag with every environment factor neutralised — same recipe as
 *  tests/consistency.test.ts and tests/raw-poly.test.ts, so only the fitted curves speak. */
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

// ══ ITEMS 1 + 2 — the DISPLAYED roster must be the SCORED roster ═════════════════════════════════

const FIELD = ["C", "1B", "2B", "3B", "SS", "LF", "CF", "RF"];
const filler = (pos: string, v: number): HitterCandidate =>
  ({ id: `f_${pos}`, title: `F_${pos}`, bats: 1, valueVR: v, valueVL: v, positions: [pos], coverPositions: FIELD, playPositions: [pos], cost: 75 });

// Two catchers, and ONLY these two can play C — so which of them starts vs RHP is decided by the
// matching weight and nothing else. This is the Rutschman/Dingler shape from the sweep:
//   ρ=1   (the pre-fix display): SPEC_C 0.0750 > BAL_C 0.0650  → the specialist starts
//   ρ=0.8 (selection + E[wins]): SPEC_C 0.0620 < BAL_C 0.0640  → the balanced bat starts
// The fixture straddles the flip, so the displayed nine is decided by ρ alone.
const SPEC_C: HitterCandidate = { id: "SPEC_C", title: "Specialist C", bats: 2, valueVR: 0.075, valueVL: 0.010, positions: ["C"], coverPositions: ["C"], playPositions: ["C"], cost: 75 };
const BAL_C: HitterCandidate = { id: "BAL_C", title: "Balanced C", bats: 1, valueVR: 0.065, valueVL: 0.060, positions: ["C"], coverPositions: ["C"], playPositions: ["C"], cost: 75 };
// Exactly 9 hitters for nHitters=9 ⇒ the SELECTED SET IS FORCED. Only the display can move, which
// is what isolates these tests from roster selection.
const POOL: HitterCandidate[] = [...FIELD.filter((p) => p !== "C").map((p) => filler(p, 0.04)), SPEC_C, BAL_C];
const ARMS: PitcherCandidate[] = Array.from({ length: 6 }, (_, k) => (
  { id: `p${k}`, title: `P${k}`, throws: 1, valueVR: 0.03 - k * 0.001, valueVL: 0.03 - k * 0.001, stamina: 80, pitchTypes: 4, cost: 75 }
));
const BASE: RosterOptimizeOptions = {
  nHitters: 9, nPitchers: 5, rosterSize: 14, dh: false, minStarters: 3,
  minStarterStamina: 70, minPitchTypes: 3, minPlayersPerPosition: 1, backupCatcherDepth: 2,
  platoonVR: 0.62, platoonVL: 0.38, mode: "none",
};
const CAP: RosterOptimizeOptions = {
  ...BASE, mode: "cap", totalCap: 5000,
  usageWeights: { lineupPA: 689, benchPA: 82.7, rotationBF: [900, 800, 700], bullpenBF: [300, 200, 150, 100, 100, 100] },
};
const byId = new Map(POOL.map((c) => [c.id, c]));

describe("finding 2 — the displayed lineup is the lineup the app scores", () => {
  for (const [label, opts] of [["non-cap", BASE], ["cap/slots (E[wins])", CAP]] as const) {
    it(`${label}: generateFullRoster's lineups ARE bestLineup at the options' own ρ`, async () => {
      for (const rho of [1, 0.8, 0.5]) {
        const r = await generateFullRoster(POOL, ARMS, { ...opts, platoonCapture: rho });
        expect(r.status).toBe("Optimal");
        const rostered = r.hitters.map((id) => byId.get(id)!);
        for (const side of ["R", "L"] as const) {
          const want = bestLineup(rostered, lineupPositions(opts.dh), side, rho)!.map((c) => c.id);
          expect((side === "R" ? r.lineupVR : r.lineupVL).map((s) => s.id)).toEqual(want);
        }
      }
    });

    // THE LEG THAT FAILS ON THE OLD BUILD: at ρ=0.8 the pre-fix display (hard-coded ρ=1) showed
    // SPEC_C behind the plate while selection and E[wins] both assumed BAL_C.
    it(`${label}: at ρ=0.8 the vR catcher SHOWN is the one the evaluator starts, not the specialist`, async () => {
      const r = await generateFullRoster(POOL, ARMS, { ...opts, platoonCapture: 0.8 });
      expect(r.hitters.sort()).toEqual(POOL.map((c) => c.id).sort()); // set forced — display only
      expect(r.lineupVR.find((s) => s.pos === "C")!.id).toBe("BAL_C");
      const r1 = await generateFullRoster(POOL, ARMS, { ...opts, platoonCapture: 1 });
      expect(r1.lineupVR.find((s) => s.pos === "C")!.id).toBe("SPEC_C"); // ρ=1 still reproduces it
    });
  }

  it("assignRoster (the evaluator's own display path) agrees with generateFullRoster", async () => {
    for (const rho of [1, 0.8]) {
      const opts = { ...BASE, platoonCapture: rho };
      const g = await generateFullRoster(POOL, ARMS, opts);
      const a = assignRoster(g.hitters.map((id) => byId.get(id)!), ARMS.slice(0, 5), opts)!;
      expect(a.lineupVR.map((s) => s.id)).toEqual(g.lineupVR.map((s) => s.id));
      expect(a.lineupVL.map((s) => s.id)).toEqual(g.lineupVL.map((s) => s.id));
    }
    // …and it moves with ρ (assign.ts:155-156 carried the identical hard-coded 1).
    const at = (rho: number) => assignRoster(POOL, ARMS.slice(0, 5), { ...BASE, platoonCapture: rho })!
      .lineupVR.find((s) => s.pos === "C")!.id;
    expect(at(1)).toBe("SPEC_C");
    expect(at(0.8)).toBe("BAL_C");
  });
});

describe("finding 3 — balance.hitterValue is the blend the objective and the evaluator use", () => {
  const blend = (cs: HitterCandidate[], o: RosterOptimizeOptions, rho: number) =>
    cs.reduce((s, c) => s + o.platoonVR * effectiveValue(c, "R", rho) + o.platoonVL * effectiveValue(c, "L", rho), 0);
  const sumMax = (cs: HitterCandidate[]) => cs.reduce((s, c) => s + Math.max(c.valueVR, c.valueVL), 0);

  it("hitterValue equals the ρ-blend, and is NOT Σ max(vR, vL)", async () => {
    for (const rho of [1, 0.8]) {
      const opts = { ...CAP, platoonCapture: rho };
      const r = await generateFullRoster(POOL, ARMS, opts);
      const rostered = r.hitters.map((id) => byId.get(id)!);
      expect(r.balance!.hitterValue).toBeCloseTo(blend(rostered, opts, rho), 12);
      // The pre-fix formula. It is STRICTLY larger here (Σ max ≥ any convex blend of the two
      // sides, strictly so whenever a card has a platoon gap), so this leg cannot pass vacuously.
      expect(r.balance!.hitterValue).toBeLessThan(sumMax(rostered) - 1e-9);
    }
  });

  it("generateFullRoster and assignRoster report the SAME balance for the same set", async () => {
    const opts = { ...BASE, platoonCapture: 0.8 };
    const g = await generateFullRoster(POOL, ARMS, opts);
    const a = assignRoster(g.hitters.map((id) => byId.get(id)!), ARMS.slice(0, 5), opts)!;
    expect(a.balance!.hitterValue).toBeCloseTo(g.balance!.hitterValue, 12);
  });

  it("H-value and P-value are on the same footing: both move with the deployment weights", async () => {
    // The readout exists to let cross-pool balance be watched (generate.ts header), so a hitter
    // half insensitive to platoon exposure while the pitcher half tracks it is not a comparison.
    const a = await generateFullRoster(POOL, ARMS, { ...BASE, platoonCapture: 0.8, platoonVR: 0.62, platoonVL: 0.38 });
    const b = await generateFullRoster(POOL, ARMS, { ...BASE, platoonCapture: 0.8, platoonVR: 0.40, platoonVL: 0.60 });
    expect(a.balance!.hitterValue).not.toBeCloseTo(b.balance!.hitterValue, 6); // Σ max(vR,vL) would be identical
  });
});

// ══ ITEM 3 — the consistency ALARM must watch production's field cohort ══════════════════════════

describe("finding 4 — the consistency alarm measures production's field, not a variant-free copy", () => {
  // A MIXED population: half the cards are variant-eligible, half are `Card Type: "1"` (Live), which
  // `canHaveVariant` forbids. So the presence mixture doesn't merely shift every card by the same
  // boost — it re-orders WHO IS IN the top-N, which is the drift that matters.
  const CENTERS: Record<string, number> = {
    Eye: 124, Power: 118, "Avoid K": 116, BABIP: 123, Gap: 105,
    Control: 100, Stuff: 122, pBABIP: 118, pHR: 123,
  };
  function lcg(seed: number) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32; }
  function makeCards(count: number, scale: number, seed = 7): Record<string, unknown>[] {
    const rnd = lcg(seed);
    const out: Record<string, unknown>[] = [];
    for (let i = 0; i < count; i++) {
      const c: Record<string, unknown> = {
        "Card ID": `synth-${i}`, "//Card Title": `synth ${i}`, Bats: 1, Throws: 1,
        Speed: 80, Stealing: 80, Baserunning: 80,
        "Card Type": i % 2 === 0 ? "1" : "",   // even = Live ⇒ CANNOT carry a variant
      };
      const quality = (rnd() - 0.5) * 50;
      for (const side of ["vR", "vL"]) for (const col of Object.keys(CENTERS))
        c[`${col} ${side}`] = Math.max(1, Math.round((CENTERS[col]! + quality + (rnd() - 0.5) * 24) * scale));
      out.push(c);
    }
    return out;
  }
  const coeffs = neutralCoeffs();
  const ref = makeCards(300, 1);
  const pool = makeCards(300, 0.7, 11);
  const report = computeConsistency(pool, ref, coeffs, model, { topX: 100 });
  const gapsFrom = (r: ReturnType<typeof productionFieldStats>, p: ReturnType<typeof productionFieldStats>) => ({
    hit: Object.fromEntries(HIT_RATINGS.map((k) => [k, Math.round(1e3 * ((r.hit.vR[k]?.mu ?? 0) - (p.hit.vR[k]?.mu ?? 0))) / 1e3])),
    pit: Object.fromEntries(PIT_RATINGS.map((k) => [k, Math.round(1e3 * ((r.pit.vR[k]?.mu ?? 0) - (p.pit.vR[k]?.mu ?? 0))) / 1e3])),
  });

  it("its gaps are EXACTLY productionFieldStats' gaps (one construction, both legs)", () => {
    const want = gapsFrom(
      productionFieldStats(ref, coeffs, model, true),
      productionFieldStats(pool, coeffs, model, true),
    );
    for (const role of ["hit", "pit"] as const)
      for (const [k, g] of Object.entries(report.gaps[role])) expect(g.gap).toBe(want[role][k]);
  });

  // THE LEG THAT FAILS ON THE OLD BUILD: the pre-fix construction.
  it("…and NOT the bare variant-free top-FIELD_N it used to measure", () => {
    const stale = gapsFrom(
      computeUnifiedFieldStats(ref, coeffs, model, FIELD_N, true),
      computeUnifiedFieldStats(pool, coeffs, model, FIELD_N, true),
    );
    const moved = [...HIT_RATINGS.map((k) => [k, report.gaps.hit[k]!.gap - stale.hit[k]!] as const),
                   ...PIT_RATINGS.map((k) => [k, report.gaps.pit[k]!.gap - stale.pit[k]!] as const)];
    expect(moved.some(([, d]) => Math.abs(d) > 0.1)).toBe(true); // the two coordinates are not the same
  });

  it("reports production's cohort size (FIELD_N × PRESENCE_M), not a caller-chosen one", () => {
    expect(report.fieldN).toBe(FIELD_N * PRESENCE_M);
  });
});

// ══ ITEM 4 — the debug event trace must not fork the BIP ═════════════════════════════════════════

describe("finding 6 — components return the BIP their own hits were derived from", () => {
  const coeffs = neutralCoeffs();
  // era-1920's rates-derived BIP_ADJ scale (tests/era-bip-adj.test.ts pins ≈2.4). Under it the
  // pre-fix trace printed a BIP 1.4-2.1% off the singles/XBH beside it.
  const ERA_1920_BIP_ADJ = 2.3977;
  const derived = computeDerived({ ...coeffs, era_bip_adj: ERA_1920_BIP_ADJ } as Coeffs, true);
  const flat = computeDerived({ ...coeffs, era_bip_adj: 1 } as Coeffs, true);
  const hRatings = { eye: 130, pow: 125, kRat: 120, babip: 128, gap: 110, speed: 60, steal: 40, run: 60 };
  const pRatings = { con: 110, stu: 130, pbabip: 120, hrr: 125 };

  it("hitting: the returned BIP reproduces the returned hits; the un-scaled one does not", () => {
    const e = model.predictHitting(hRatings, coeffs);
    const k = hittingComponents(e, 1, 1, 1, "vR", coeffs, derived, form);
    // BA_fin = oneB + XBH is hRate(curve, rating, BIP) × era_h. Feed the PRINTED BIP back in.
    expect(hRate(form.hit.h, (e as any).babipSC, k.BIP_fin) * ((e as any).hMul ?? 1) * derived.era_h)
      .toBeCloseTo(k.oneB_fin + k.GAP_fin, 12);
    const naive = Math.max(600 - k.BB_fin - e.SO * coeffs.era_k - k.HR_fin - HIT_BIP_ADJ, 1); // the pre-fix trace
    expect(Math.abs(naive / k.BIP_fin - 1)).toBeGreaterThan(0.01); // ~1.4% on this era
    expect(hRate(form.hit.h, (e as any).babipSC, naive) * ((e as any).hMul ?? 1) * derived.era_h)
      .not.toBeCloseTo(k.oneB_fin + k.GAP_fin, 6);
  });

  it("pitching: same identity (this leg was ~2.1% off)", () => {
    const e = model.predictPitching(pRatings, coeffs);
    const k = pitchingComponents(e, 1, 1, "vR", coeffs, derived, form);
    const nHH = k.oneB_fin + k.XBH_fin;
    expect(hRate(form.pit.h, (e as any).pbabipSC, k.BIP_fin) * ((e as any).hMul ?? 1) * derived.era_h)
      .toBeCloseTo(nHH, 12);
    const naive = Math.max(600 - k.BB_fin - e.K * coeffs.era_k - k.HR_fin - PIT_BIP_ADJ, 1);
    expect(Math.abs(naive / k.BIP_fin - 1)).toBeGreaterThan(0.02);
  });

  it("era_bip_adj = 1 (era-2010, captures, synthetic) ⇒ BIP is the plain constant, bit-for-bit", () => {
    const e = model.predictHitting(hRatings, coeffs);
    const k = hittingComponents(e, 1, 1, 1, "vR", coeffs, flat, form);
    expect(k.BIP_fin).toBe(Math.max(600 - k.BB_fin - e.SO * coeffs.era_k - k.HR_fin - HIT_BIP_ADJ, 1));
  });
});
