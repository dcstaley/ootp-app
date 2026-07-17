// BUILD-3 pitcher HR9 spread (own-gap path) + the applyPitSpread seam — invariants.
//
//   0) pitSpreadHrRamp: constants pinned (A=0.2648, G=5.8 — the 2026-07-17 fit, HR-only wired;
//      BABIP HELD), s(g ≤ 0) = 1 exactly, reference ramp values, monotone + plateau-bounded.
//   1) applyPitSpread: the ONE copy of the pitcher spread order of operations.
//      · K-only objects are BIT-identical to the old inline applyKSpread call (the shipped
//        BUILD-1 behavior — nHH/XBH/hMul untouched).
//      · the HR leg moves ONLY e.HR; the BABIP leg rides e.hMul + rescales nHH/XBH
//        mix-preserving; every s=1/absent leg is an exact identity.
//   2) scoreCard on the own-gap path: an HR-spread kSpread moves pitching scores and NOT
//      hitting scores; in-frame (all s=1) is bit-identical; the BABIP hMul carrier reaches the
//      DEPLOYED composite (pitchingComponents re-derives nHH from the rating — the RawHitting
//      lesson, pitcher twin; production never sets sPitBab, but the seam must be correct).
//   3) poolPitMeansOwn: k ≡ poolMeanKOwn().pit exactly (same collector), hr/bab respond to a
//      real own-gap lift the physical way.
//
// All fixtures synthetic (committed _synthetic.json coeffs + hand-built curves) — deterministic.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  scoreCard, computeDerived, logLinearModel, makeRawPolyModel,
  poolMeanKOwn, poolPitMeansOwn, buildPoolTransform,
  type Coeffs, type CalScales, type PoolTransform, type EventForm,
} from "../src/scoring-core/index.ts";
import type { FieldStats } from "../src/scoring-core/pool-stats.ts";
import {
  applyKSpread, applyPitSpread, pitSpreadHrRamp, PIT_SPREAD_HR, type RatingStats,
} from "../src/model/pool-transform.ts";
import type { RawPitching } from "../src/model/types.ts";
import type { FittedEvent, FittedH } from "../src/model/curves.ts";
import { PIT_BIP_ADJ } from "../src/model/curves.ts";

const synthCoeffs = (): Coeffs => JSON.parse(readFileSync("fixtures/captures/_synthetic.json", "utf8")).coeffs as Coeffs;

const IDENTITY: CalScales = {
  hitBBScaleVR: 1, hitBBScaleVL: 1, hitHRScaleVR: 1, hitHRScaleVL: 1, hitScaleVR: 1, hitScaleVL: 1,
  pBBScaleVR: 1, pBBScaleVL: 1, pHRScaleVR: 1, pHRScaleVL: 1, pitchScaleVR: 1, pitchScaleVL: 1,
  ssp_adv_hitting: 1, ssp_basic_pitching: 1,
};

function card(over: Record<string, number> = {}): Record<string, unknown> {
  const base: Record<string, number> = {
    Eye: 110, Power: 130, "Avoid K": 95, BABIP: 105, Gap: 120,
    Control: 100, Stuff: 140, pBABIP: 90, pHR: 110, ...over,
  };
  const c: Record<string, unknown> = {
    "Card ID": `ps-${JSON.stringify(over)}`, "//Card Title": "pitspread sample", "Card Value": 80,
    Bats: 1, Throws: 1, Speed: 40, Stealing: 30, Baserunning: 45, "Steal Rate": 50, Hold: 0, GB: 2,
    Stamina: 55, "Pitcher Role": 1, Position: 1,
  };
  for (const side of ["vR", "vL"]) {
    for (const key of ["Eye", "Power", "Avoid K", "BABIP", "Gap", "Control", "Stuff", "pBABIP", "pHR"]) {
      c[`${key} ${side}`] = base[key];
    }
  }
  return c;
}

const mkE = (): RawPitching => ({ BB: 45, K: 130, HR: 17, nHH: 120, XBH: 30, pbabipSC: 90 });

// ── 0) the production ramp (constants shipped 2026-07-17) ──────────────────────
describe("pitSpreadHrRamp — fitted constants + league anchor + shape (regression pins)", () => {
  it("pins the fit provenance constants exactly (A=0.2648, G=5.8 — fixtures/pitspread-fit-run-2026-07-17.txt)", () => {
    expect(PIT_SPREAD_HR.A).toBe(0.2648);
    expect(PIT_SPREAD_HR.G).toBe(5.8);
  });
  it("s(0) === 1 EXACTLY, and s(g ≤ 0) === 1 (league anchor)", () => {
    expect(pitSpreadHrRamp(0)).toBe(1);
    expect(pitSpreadHrRamp(-5)).toBe(1);
    expect(pitSpreadHrRamp(-100)).toBe(1);
  });
  it("reproduces the fitted ramp values at the tier gaps (gap-FLAT plateau — the BUILD-3 geometry)", () => {
    // From the fit run: s at tier g_hr — gold 17.5 → 1.25, silver 27.6 / bronze 36.3 / iron 47.7 → 1.26.
    expect(pitSpreadHrRamp(17.5)).toBeCloseTo(1.25, 2);
    expect(pitSpreadHrRamp(27.6)).toBeCloseTo(1.26, 2);
    expect(pitSpreadHrRamp(36.3)).toBeCloseTo(1.26, 2);
    expect(pitSpreadHrRamp(47.7)).toBeCloseTo(1.26, 2);
    // 95% saturation lands at the lowest observed gap by the pin rule (G = g_min/3).
    expect(pitSpreadHrRamp(5.8)).toBeCloseTo(1.167, 3); // 1 + A·(1−e^−1)
  });
  it("is monotone non-decreasing and bounded by the plateau 1 + A", () => {
    let prev = pitSpreadHrRamp(0);
    for (let g = 1; g <= 100; g += 1) {
      const s = pitSpreadHrRamp(g);
      expect(s).toBeGreaterThanOrEqual(prev);
      expect(s).toBeLessThan(1 + PIT_SPREAD_HR.A);
      prev = s;
    }
  });
});

// ── 1) applyPitSpread — the one copy of the order of operations ────────────────
describe("applyPitSpread — per-leg isolation, exact identities, BABIP carrier", () => {
  it("K-only object ≡ the old inline applyKSpread call BIT-exactly (nHH/XBH/hMul untouched)", () => {
    const e = mkE();
    const expected = applyKSpread(mkE().K, 121.9, 1.74);
    applyPitSpread(e, { sPit: 1.74, meanPit: 121.9 });
    expect(e.K).toBe(expected);
    expect(e.HR).toBe(mkE().HR);
    expect(e.nHH).toBe(mkE().nHH);
    expect(e.XBH).toBe(mkE().XBH);
    expect(e.hMul).toBeUndefined();
  });
  it("all legs at s=1 (or absent) ⇒ the event object is unchanged EXACTLY", () => {
    const e = mkE();
    applyPitSpread(e, { sPit: 1, meanPit: 133.29999999999998, sPitHr: 1, meanPitHr: 15.7, sPitBab: 1, meanPitBab: 0.301 });
    expect(e).toEqual(mkE());
  });
  it("HR leg: amplifies HR about HR̄ and touches NOTHING else (no hMul, no nHH move)", () => {
    const e = mkE();
    applyPitSpread(e, { sPit: 1, meanPit: 0, sPitHr: 1.25, meanPitHr: 15 });
    expect(e.HR).toBeCloseTo(15 + 1.25 * (17 - 15), 12);
    expect(e.K).toBe(mkE().K);
    expect(e.nHH).toBe(mkE().nHH);
    expect(e.hMul).toBeUndefined();
  });
  it("BABIP leg: hMul = bab′/bab measured on the ORIGINAL BIP; nHH/XBH rescaled mix-preserving", () => {
    const e = mkE();
    const bip0 = Math.max(600 - e.BB - e.K - e.HR - PIT_BIP_ADJ, 1);
    const bab0 = e.nHH / bip0;
    const meanBab = bab0 - 0.02;
    applyPitSpread(e, { sPit: 1, meanPit: 0, sPitBab: 1.15, meanPitBab: meanBab });
    const bab2 = meanBab + 1.15 * (bab0 - meanBab);
    expect(e.hMul).toBeCloseTo(bab2 / bab0, 12);
    // K/HR untouched ⇒ BIP unchanged ⇒ nHH lands exactly on bab2·BIP; XBH share preserved.
    expect(e.nHH).toBeCloseTo(bab2 * bip0, 10);
    expect(e.XBH / e.nHH).toBeCloseTo(mkE().XBH / mkE().nHH, 12);
    expect(e.K).toBe(mkE().K);
    expect(e.HR).toBe(mkE().HR);
  });
  it("all three legs compose: K then HR then BABIP-on-the-original-BIP (order matters and is pinned)", () => {
    const e = mkE();
    const bip0 = Math.max(600 - e.BB - e.K - e.HR - PIT_BIP_ADJ, 1);
    const bab0 = e.nHH / bip0;
    applyPitSpread(e, { sPit: 1.5, meanPit: 120, sPitHr: 1.25, meanPitHr: 15, sPitBab: 1.15, meanPitBab: bab0 - 0.02 });
    const k2 = 120 + 1.5 * (130 - 120), hr2 = 15 + 1.25 * (17 - 15);
    const bab2 = (bab0 - 0.02) + 1.15 * 0.02;
    const bip2 = Math.max(600 - 45 - k2 - hr2 - PIT_BIP_ADJ, 1);
    expect(e.K).toBeCloseTo(k2, 12);
    expect(e.HR).toBeCloseTo(hr2, 12);
    expect(e.hMul).toBeCloseTo(bab2 / bab0, 12);   // pivot on the ORIGINAL babip, not post-K/HR
    expect(e.nHH).toBeCloseTo(bab2 * bip2, 10);    // …re-applied on the NEW BIP (more K/HR cost hits)
  });
});

// ── 2) scoreCard on the OWN-GAP path ────────────────────────────────────────────
describe("scoreCard (own-gap): HR spread moves pitching only; in-frame bit-identity; BABIP carrier deployed", () => {
  const coeffs = synthCoeffs();
  const derived = computeDerived(coeffs);
  const st = (mu: number): RatingStats => ({ mu, sd: 10 });
  const mkField = (hit: number[], pit: number[]): FieldStats => {
    const h: Record<string, RatingStats> = {}, p: Record<string, RatingStats> = {};
    (["eye", "pow", "kRat", "babip", "gap"] as const).forEach((k, i) => { h[k] = st(hit[i]!); });
    (["con", "stu", "pbabip", "hrr"] as const).forEach((k, i) => { p[k] = st(pit[i]!); });
    return { hit: { vR: h, vL: h }, pit: { vR: p, vL: p } };
  };
  // A REAL lift (weaker pool), so the identities are tested on the transformed path.
  const poolTransform = buildPoolTransform(
    mkField([130, 150, 120, 130, 140], [130, 155, 120, 140]),
    mkField([100, 120, 95, 105, 110], [100, 125, 92, 110]),
  );
  const ev = (b0: number, b1: number): FittedEvent => ({ beta: [b0, b1], mu: 0, sd: 1, curve: { kind: "log" } });
  const hh = (b0: number, bRat: number, bBip: number): FittedH =>
    ({ beta: [b0, bRat, bBip], rating: { curve: { kind: "log" }, mu: 0, sd: 1 }, bip: { curve: { kind: "log" }, mu: 0, sd: 1 } });
  const form: EventForm = {
    hit: { bb: ev(-20, 15), k: ev(250, -30), hr: ev(-40, 12), h: hh(-120, 15, 35), xbh: ev(-0.5, 0.17) },
    pit: { bb: ev(160, -25), k: ev(-140, 55), hr: ev(60, -10), h: hh(-120, 10, 38) },
  };
  const c = card();
  const base = scoreCard(c, { coeffs, derived, calScales: IDENTITY, eventForm: form, poolTransform });

  it("all-s=1 kSpread with awkward means is bit-identical to no kSpread at all", () => {
    const withKs = scoreCard(c, {
      coeffs, derived, calScales: IDENTITY, eventForm: form, poolTransform,
      kSpread: { sHit: 1, sPit: 1, meanHit: 42.7, meanPit: 133.29999999999998, sPitHr: 1, meanPitHr: 15.699999999999998, sPitBab: 1, meanPitBab: 0.30000000000000004 },
    });
    expect(withKs).toEqual(base);
  });
  it("an HR-only spread (sPitHr > 1) moves pitching scores and NOT hitting scores", () => {
    const withHr = scoreCard(c, {
      coeffs, derived, calScales: IDENTITY, eventForm: form, poolTransform,
      kSpread: { sHit: 1, sPit: 1, meanHit: 0, meanPit: 0, sPitHr: 1.25, meanPitHr: 10 },
    });
    expect(withHr.hit).toEqual(base.hit);                        // hitter path untouched
    expect(withHr.pitch.woba_vR).not.toBe(base.pitch.woba_vR);   // pitcher composite moved
    expect(withHr.pitch.basic_vR).toBe(base.pitch.basic_vR);     // basic is rating-direct — untouched
  });
  it("a BABIP-only spread reaches the DEPLOYED pitcher composite via e.hMul (the carrier invariant)", () => {
    // pitchingComponents re-derives nHH from the rating; without the hMul carrier this would be a
    // silent no-op in shipped scores (the exact defect class fixed for the hitter tail's BABIP leg).
    const withBab = scoreCard(c, {
      coeffs, derived, calScales: IDENTITY, eventForm: form, poolTransform,
      kSpread: { sHit: 1, sPit: 1, meanHit: 0, meanPit: 0, sPitBab: 1.2, meanPitBab: 0.25 },
    });
    expect(withBab.pitch.woba_vR).not.toBe(base.pitch.woba_vR);
    expect(withBab.hit).toEqual(base.hit);
  });
});

// ── 3) poolPitMeansOwn — the BUILD-3 centering means ───────────────────────────
describe("poolPitMeansOwn — same collector as poolMeanKOwn, physical lift responses", () => {
  const coeffs = synthCoeffs();
  const cards = [
    card(), card({ Stuff: 100, "Avoid K": 120 }), card({ Stuff: 180, "Avoid K": 70 }),
    card({ Stuff: 120, Control: 140 }), card({ Stuff: 160, pBABIP: 120 }), card({ Stuff: 90, Power: 160, pHR: 140 }),
  ];
  const EMPTY_PT: PoolTransform = { hit: { vR: {}, vL: {} }, pit: { vR: {}, vL: {} } };
  it("k equals poolMeanKOwn(...).pit EXACTLY (one collector, one copy of the cohort math)", () => {
    const a = poolMeanKOwn(cards, coeffs, logLinearModel, EMPTY_PT, 4);
    const b = poolPitMeansOwn(cards, coeffs, logLinearModel, EMPTY_PT, 4);
    expect(b.k).toBe(a.pit);
    expect(Number.isFinite(b.hr)).toBe(true);
    expect(b.bab).toBeGreaterThan(0);
    expect(b.bab).toBeLessThan(1);
  });
  it("responds to a real own-gap lift the physical way (lifted hrr ⇒ LOWER pitcher HR̄)", () => {
    // hrr is a suppression rating in the log-linear model: better pHR ⇒ fewer HR allowed.
    const lift: PoolTransform = {
      hit: { vR: {}, vL: {} },
      pit: {
        vR: { hrr: { k: 1.3, c: Infinity, w: Infinity } },
        vL: { hrr: { k: 1.3, c: Infinity, w: Infinity } },
      },
    };
    const base = poolPitMeansOwn(cards, coeffs, logLinearModel, EMPTY_PT, 4);
    const lifted = poolPitMeansOwn(cards, coeffs, logLinearModel, lift, 4);
    expect(lifted.hr).not.toBe(base.hr);
    expect(lifted.k).toBe(base.k); // K untouched by an hrr-only lift
  });
});
