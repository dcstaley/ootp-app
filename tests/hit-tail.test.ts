// BUILD-2 hitter tail correction — invariant tests (src/scoring-core/hit-tail.ts).
//
// ACTIVATION MODEL (since 2026-07-17, Derek's ruling — plan §15.7): the correction is STANDARD
// SCORING, on by default, with a GLOBAL kill-switch (server `state.hitTail`, POST
// /api/training/hit-tail?enabled=false). The invariants that must never ship broken:
//   1. KILL-SWITCH / OFF-PATH IDENTITY — a config without `hitTail` (global kill-switch off,
//      per-tournament override-off, or non-tournament scoring) ⇒ EXACT bit-identity; likewise
//      zero strength. Default-ON is a server activation property; it rests on this invariant
//      bounding the off path.
//   2. LEAGUE IDENTITY — pool == reference (gap 0) ⇒ every strength is 0 by construction.
//   3. MONOTONICITY — no family, at any shipped strength, can flip within-pool ordering.
//   4. BIP CONSISTENCY — after correction, the babip implied by (oneB+GAP)/BIP′ equals the
//      corrected babip, and the hit MIX (GAP:oneB) is untouched.
//   5. PINNED CONSTANTS — the deployed operating point can only change deliberately.
//   6. DEPLOYED-PATH CARRIER — the BABIP leg reaches the TRUSTED composite via e.hMul
//      (hittingComponents re-derives hits from the rating and discards oneB/GAP moves; the
//      missing carrier was found in the 2026-07-17 pre-default-flip audit — a bab-only tail was
//      a silent no-op in shipped scores while HR/SO flowed). Pitcher scores stay bit-identical.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  correctChannel, applyHitTail, computeHitTail, hitTailW, PINNED_HIT_TAIL,
  type HitTail, type HitTailChanStat, type HitTailFamily,
} from "../src/scoring-core/hit-tail.ts";
import { HIT_BIP_ADJ, type EventForm, type FittedEvent, type FittedH } from "../src/model/curves.ts";
import { scoreCard, computeDerived, makeRawPolyModel, type Coeffs, type CalScales } from "../src/scoring-core/index.ts";
import type { EventModel } from "../src/model/types.ts";
import type { PoolTransform } from "../src/model/pool-transform.ts";

const ST: HitTailChanStat = { m: 10, s: 4, p50: 9, p75: 13, zLo: -2.2 };
const FAMS: HitTailFamily[] = ["hinge", "hinge50", "quad", "pivot", "step"];

const mkTail = (lwHr: number, lwBab: number, lwSo: number): HitTail => ({
  hr: { fam: "hinge", lw: lwHr, st: { m: 10, s: 6, p50: 8, p75: 14, zLo: -1.6 } },
  bab: { fam: "hinge", lw: lwBab, st: { m: 0.30, s: 0.02, p50: 0.30, p75: 0.315, zLo: -3 } },
  so: { fam: "step", lw: lwSo, st: { m: 100, s: 25, p50: 98, p75: 118, zLo: -3.5 } },
});
const mkEvents = () => ({ BB: 50, SO: 110, HR: 18, oneB: 95, GAP: 40 });

describe("hitTailW (gap conditioning)", () => {
  it("is 0 at gap 0 and for negative gaps (league/stronger pools) — the identity anchor", () => {
    expect(hitTailW(0, "lin")).toBe(0);
    expect(hitTailW(0, "sat")).toBe(0);
    expect(hitTailW(-0.3, "lin")).toBe(0);
    expect(hitTailW(-0.3, "sat")).toBe(0);
  });
  it("is positive and increasing in the gap", () => {
    expect(hitTailW(0.2, "lin")).toBeGreaterThan(hitTailW(0.1, "lin"));
    expect(hitTailW(0.2, "sat")).toBeGreaterThan(hitTailW(0.1, "sat"));
    expect(hitTailW(0.4, "sat")).toBeLessThan(1); // saturating, never exceeds 1
  });
});

describe("correctChannel", () => {
  it("is the exact identity at zero/negative strength, every family", () => {
    for (const fam of FAMS) {
      for (const x of [2, 9.5, 13, 21]) {
        expect(correctChannel(x, ST, 0, fam)).toBe(x);
        expect(correctChannel(x, ST, -0.5, fam)).toBe(x);
      }
    }
  });
  it("is monotone (never flips within-pool ordering) at strong strengths, every family", () => {
    for (const fam of FAMS) {
      for (const lw of [0.3, 1.0, 2.5]) {
        let prev = -Infinity;
        for (let x = ST.m + ST.s * ST.zLo; x <= ST.m + 5 * ST.s; x += 0.05) {
          const y = correctChannel(x, ST, lw, fam);
          expect(y).toBeGreaterThanOrEqual(prev - 1e-9);
          prev = y;
        }
      }
    }
  });
  it("hinge leaves everything at/below the pool p75 untouched", () => {
    expect(correctChannel(ST.p75, ST, 2, "hinge")).toBe(ST.p75);
    expect(correctChannel(ST.p75 - 1, ST, 2, "hinge")).toBe(ST.p75 - 1);
    expect(correctChannel(ST.p75 + 2, ST, 2, "hinge")).toBeCloseTo(ST.p75 + 2 + 4, 12);
  });
  it("pivot preserves the pool mean point (level-preserving stretch)", () => {
    expect(correctChannel(ST.m, ST, 1.3, "pivot")).toBeCloseTo(ST.m, 12);
  });
  it("step is flat at both ends (the inverse-tail instrument): far-tail local slope ≈ 1", () => {
    const lw = 1.0, eps = 0.01;
    for (const x of [ST.m + 5 * ST.s, ST.m - 5 * ST.s]) {
      const d = (correctChannel(x + eps, ST, lw, "step") - correctChannel(x, ST, lw, "step")) / eps;
      expect(Math.abs(d - 1)).toBeLessThan(0.01);
    }
    // ...and steeper than 1 in the mid band, where SO% under-reacts.
    const dm = (correctChannel(ST.m + eps, ST, lw, "step") - correctChannel(ST.m, ST, lw, "step")) / eps;
    expect(dm).toBeGreaterThan(1.5);
  });
  it("quad stays monotone even at absurd strength (left-edge clamp)", () => {
    let prev = -Infinity;
    for (let x = ST.m + ST.s * ST.zLo; x <= ST.m + 5 * ST.s; x += 0.05) {
      const y = correctChannel(x, ST, 50, "quad");
      expect(y).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = y;
    }
  });
});

describe("applyHitTail (event-layer application)", () => {
  it("zero strengths ⇒ events unchanged EXACTLY, no hMul set (the kill-switch/off-path invariant)", () => {
    const e = mkEvents();
    applyHitTail(e, mkTail(0, 0, 0));
    expect(e).toEqual(mkEvents());
    expect((e as { hMul?: number }).hMul).toBeUndefined();
  });
  it("BIP consistency: implied babip after == corrected babip on the NEW BIP; hit mix untouched", () => {
    const ht = mkTail(1.4, 0.8, 0.4);
    const e0 = mkEvents();
    const bip0 = 600 - e0.BB - e0.SO - e0.HR - HIT_BIP_ADJ;
    const bab0 = (e0.oneB + e0.GAP) / bip0;
    const babC = correctChannel(bab0, ht.bab.st, ht.bab.lw, ht.bab.fam);
    const e = mkEvents();
    applyHitTail(e, ht);
    const bip2 = 600 - e.BB - e.SO - e.HR - HIT_BIP_ADJ;
    expect((e.oneB + e.GAP) / bip2).toBeCloseTo(babC, 10);
    expect(e.GAP / e.oneB).toBeCloseTo(mkEvents().GAP / mkEvents().oneB, 12); // XBH share preserved
    expect(e.BB).toBe(e0.BB); // walks never touched
    // the deployed-path carrier records the babip-RATE move exactly
    expect((e as { hMul?: number }).hMul).toBeCloseTo(babC / bab0, 12);
  });
  it("HR/SO-only correction sets NO hMul (bab rate untouched ⇒ carrier absent, hits still recompute via BIP)", () => {
    const e = mkEvents();
    applyHitTail(e, mkTail(2.0, 0, 1.0));
    expect((e as { hMul?: number }).hMul).toBeUndefined();
  });
  it("more strikeouts and homers consistently COST hits (BIP shrinks, H scales down with it)", () => {
    const ht = mkTail(2.0, 0, 1.0); // HR up (18 > p75 14) + SO mid-stretch, babip leg off
    const e = mkEvents();
    applyHitTail(e, ht);
    expect(e.HR).toBeGreaterThan(18);
    expect(e.SO).toBeGreaterThan(110);
    expect(e.oneB + e.GAP).toBeLessThan(135); // same babip on a smaller BIP
  });
});

describe("computeHitTail (pool-property state builder)", () => {
  // Minimal synthetic world: a linear fake model + a pool whose field stats EQUAL the reference
  // ⇒ every gap is 0 ⇒ every strength is 0 ⇒ the correction is the identity, by construction.
  const fakeModel: EventModel = {
    predictHitting: (r: any) => ({ BB: r.eye / 2, SO: 120 - r.kRat / 3, HR: r.pow / 5, oneB: r.babip / 2, GAP: r.gap / 4 }) as any,
    predictPitching: (() => { throw new Error("pitcher path must never be touched by hit-tail"); }) as any,
  };
  const card = (pow: number, babip: number, kRat: number) => ({
    "Bats": 1, "Eye vR": 100, "Eye vL": 100, "Power vR": pow, "Power vL": pow,
    "Avoid K vR": kRat, "Avoid K vL": kRat, "BABIP vR": babip, "BABIP vL": babip,
    "Gap vR": 90, "Gap vL": 90, "Speed": 50, "Stealing": 50, "Baserunning": 50,
  });
  const pool = [card(80, 90, 100), card(120, 110, 130), card(160, 130, 160)];
  const fs = (mu: number) => ({ mu, sd: 10 });
  const stats = { pow: fs(120), babip: fs(110), kRat: fs(130) };
  const fieldStats = { hit: { vR: stats, vL: stats }, pit: { vR: {}, vL: {} } } as any;
  const noPt: PoolTransform = { hit: { vR: {}, vL: {} }, pit: { vR: {}, vL: {} } };
  const coeffs = { r_hit_split: 0.6, l_hit_split: 0.6, s_hit_split: 0.5 } as any;

  it("league frame (pool field == reference field) ⇒ every strength is 0 ⇒ exact identity", () => {
    const ht = computeHitTail(pool, coeffs, fakeModel, noPt, fieldStats, fieldStats);
    expect(ht.hr.lw).toBe(0);
    expect(ht.bab.lw).toBe(0);
    expect(ht.so.lw).toBe(0);
    const e = mkEvents();
    applyHitTail(e, ht);
    expect(e).toEqual(mkEvents());
  });
  it("weaker pool (reference μ above pool μ) ⇒ positive strengths on every leg", () => {
    const weak = { pow: fs(100), babip: fs(100), kRat: fs(118) };
    const weakField = { hit: { vR: weak, vL: weak }, pit: { vR: {}, vL: {} } } as any;
    const ht = computeHitTail(pool, coeffs, fakeModel, noPt, fieldStats, weakField);
    expect(ht.hr.lw).toBeGreaterThan(0);
    expect(ht.bab.lw).toBeGreaterThan(0);
    expect(ht.so.lw).toBeGreaterThan(0);
    // pool moments are real numbers from the pool's predicted lines
    expect(Number.isFinite(ht.hr.st.p75)).toBe(true);
    expect(ht.hr.st.s).toBeGreaterThan(0);
  });
});

// ── 6) deployed-path coverage: the correction reaches scoreCard's TRUSTED composite ─────────────
// Synthetic #2 form + committed synthetic coeffs (the kspread-pit.test.ts pattern) — deterministic,
// no training data. Regression for the 2026-07-17 pre-default-flip audit finding: hittingComponents
// re-derives hits from the rating, so WITHOUT the e.hMul carrier a bab-only tail was bit-invisible
// in deployed scores (verified: base == babOnly to the last bit before the fix).
describe("scoreCard (deployed path): every leg reaches the trusted composite; off path bit-identical", () => {
  const coeffs = JSON.parse(readFileSync("fixtures/captures/_synthetic.json", "utf8")).coeffs as Coeffs;
  const derived = computeDerived(coeffs, true);
  const ev = (b0: number, b1: number): FittedEvent => ({ beta: [b0, b1], mu: 0, sd: 1, curve: { kind: "log" } });
  const hh = (b0: number, bRat: number, bBip: number): FittedH =>
    ({ beta: [b0, bRat, bBip], rating: { curve: { kind: "log" }, mu: 0, sd: 1 }, bip: { curve: { kind: "log" }, mu: 0, sd: 1 } });
  const form: EventForm = {
    hit: { bb: ev(-20, 15), k: ev(250, -30), hr: ev(-40, 12), h: hh(-120, 15, 35), xbh: ev(-0.5, 0.17) },
    pit: { bb: ev(160, -25), k: ev(-140, 55), hr: ev(60, -10), h: hh(-120, 10, 38) },
  };
  const IDENTITY: CalScales = {
    hitBBScaleVR: 1, hitBBScaleVL: 1, hitHRScaleVR: 1, hitHRScaleVL: 1, hitScaleVR: 1, hitScaleVL: 1,
    pBBScaleVR: 1, pBBScaleVL: 1, pHRScaleVR: 1, pHRScaleVL: 1, pitchScaleVR: 1, pitchScaleVL: 1,
    ssp_adv_hitting: 1, ssp_basic_pitching: 1,
  } as CalScales;
  const card: Record<string, unknown> = {
    "Card ID": "ht-dep", "//Card Title": "hit-tail deployed", Bats: 1, Throws: 1,
    Speed: 40, Stealing: 30, Baserunning: 45, "Steal Rate": 50, GB: 2,
  };
  for (const side of ["vR", "vL"]) {
    card[`Eye ${side}`] = 110; card[`Power ${side}`] = 130; card[`Avoid K ${side}`] = 95;
    card[`BABIP ${side}`] = 140; card[`Gap ${side}`] = 120;
    card[`Control ${side}`] = 100; card[`Stuff ${side}`] = 140; card[`pBABIP ${side}`] = 90; card[`pHR ${side}`] = 110;
  }
  // Place each leg's pivot just below this card's predicted channel value so the leg engages.
  const e0 = makeRawPolyModel(form).predictHitting(
    { eye: 110, pow: 130, kRat: 95, babip: 140, gap: 120, speed: 40, steal: 30, run: 45 }, coeffs,
  );
  const bab0 = (e0.oneB + e0.GAP) / Math.max(600 - e0.BB - e0.SO - e0.HR - HIT_BIP_ADJ, 1);
  const st = (m: number, s: number, p75: number): HitTailChanStat => ({ m, s, p50: m, p75, zLo: -2 });
  const legOnly = (leg: "hr" | "bab" | "so"): HitTail => ({
    hr: { fam: "hinge", lw: leg === "hr" ? 2.2 : 0, st: st(e0.HR - 5, 6, e0.HR - 2) },
    bab: { fam: "hinge", lw: leg === "bab" ? 1.1 : 0, st: st(bab0 - 0.03, 0.02, bab0 - 0.02) },
    so: { fam: "step", lw: leg === "so" ? 0.3 : 0, st: st(e0.SO - 20, 25, e0.SO + 15) }, // mean below the card ⇒ z > 0 ⇒ SO stretches UP
  });
  const cfg = (hitTail?: HitTail) => ({ coeffs, derived, calScales: IDENTITY, eventForm: form, hitTail });
  const base = scoreCard(card, cfg());

  it("config without hitTail == config with zero-strength hitTail, BIT-identical (kill-switch/league identity)", () => {
    const zero: HitTail = { hr: { ...legOnly("hr").hr, lw: 0 }, bab: { ...legOnly("bab").bab, lw: 0 }, so: { ...legOnly("so").so, lw: 0 } };
    expect(scoreCard(card, cfg(zero))).toEqual(base);
  });
  it("BABIP-only tail MOVES the deployed hitter wOBA (the fixed defect: was a silent no-op pre-hMul)", () => {
    const s = scoreCard(card, cfg(legOnly("bab")));
    expect(s.hit.woba_vR).toBeGreaterThan(base.hit.woba_vR);
    expect(s.hit.offense_vR).toBeGreaterThan(base.hit.offense_vR);
  });
  it("HR-only and SO-only tails move the deployed hitter wOBA in the physical directions", () => {
    expect(scoreCard(card, cfg(legOnly("hr"))).hit.woba_vR).toBeGreaterThan(base.hit.woba_vR); // more HR ⇒ up
    expect(scoreCard(card, cfg(legOnly("so"))).hit.woba_vR).toBeLessThan(base.hit.woba_vR);    // more SO ⇒ down
  });
  it("pitcher scores and the rating-direct basic metric are bit-identical under any tail", () => {
    for (const leg of ["hr", "bab", "so"] as const) {
      const s = scoreCard(card, cfg(legOnly(leg)));
      expect(s.pitch).toEqual(base.pitch);
      expect(s.hit.basic_vR).toBe(base.hit.basic_vR);
      expect(s.hit.basic_vL).toBe(base.hit.basic_vL);
    }
  });
});

describe("pinned operating point", () => {
  it("matches the bake-off record (changing these constants is a DELIBERATE re-fit, never a drive-by)", () => {
    expect(PINNED_HIT_TAIL).toEqual({
      hr: { fam: "hinge", shape: "lin", lam: 2.2 },
      bab: { fam: "hinge", shape: "sat", lam: 1.1 },
      so: { fam: "step", shape: "sat", lam: 0.3 },
    });
  });
});
