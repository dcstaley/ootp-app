// Pitcher K-spread (own-gap path) — invariants for the machinery that landed with the
// 2026-07-16 evidence-backed resurrection (tools/fit-kspread-pit.ts):
//
//   1) applyKSpread: s === 1 is an EXACT identity (bit-level, any mean) — the in-frame
//      guarantee "pool ≈ training ⇒ gap → 0 ⇒ s → 1 ⇒ bit-identical scores" rests on this
//      short-circuit, because `mean + 1·(k − mean)` is NOT k in floating point.
//   2) scoreCard on the OWN-GAP path (poolTransform active) with an s=1 kSpread attached is
//      bit-identical to no kSpread at all — the production in-frame identity.
//   3) poolMeanKOwn (the own-gap K̄_pool centering) == poolMeanK when both re-basings are the
//      identity, and it actually responds to a real own-gap lift.
//   4) ourPit (the eval line) under a K-spread: s=1 ⇒ identical TwoLines; s>1 amplifies K about
//      the mean, preserves within-set K ordering (monotone by construction), and the composite
//      moves the physical way (more K ⇒ fewer BIP ⇒ fewer hits ⇒ lower wOBAA).
//
// All fixtures are synthetic (committed _synthetic.json coeffs + hand-built curves) — no
// training data, no tournament data, fully deterministic.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  scoreCard, computeDerived, logLinearModel, makeRawPolyModel,
  poolMeanK, poolMeanKOwn, buildPoolTransform,
  type Coeffs, type CalScales, type FrameShift, type PoolTransform, type EventForm,
} from "../src/scoring-core/index.ts";
import type { FieldStats } from "../src/scoring-core/pool-stats.ts";
import { applyKSpread, kSpreadPitRamp, K_SPREAD_PIT, type RatingStats } from "../src/model/pool-transform.ts";
import type { FittedEvent, FittedH } from "../src/model/curves.ts";
import { ourPit, type SampleDeps, type KSpreadPit } from "../src/eval/cwhit/sample.ts";
import { DEFAULT_WOBA_WEIGHTS } from "../src/scoring-core/woba-weights.ts";

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
    "Card ID": `k-${JSON.stringify(over)}`, "//Card Title": "kspread sample", "Card Value": 80,
    Bats: 1, Throws: 1, Speed: 40, Stealing: 30, Baserunning: 45, "Steal Rate": 50, Hold: 0, GB: 2,
    Stamina: 55, "Pitcher Role": 1, Position: 1,
  };
  for (const side of ["vR", "vL"]) {
    for (const [col, key] of [["Eye", "Eye"], ["Power", "Power"], ["Avoid K", "Avoid K"], ["BABIP", "BABIP"], ["Gap", "Gap"], ["Control", "Control"], ["Stuff", "Stuff"], ["pBABIP", "pBABIP"], ["pHR", "pHR"]] as const) {
      c[`${col} ${side}`] = base[key];
    }
  }
  return c;
}

// ── 0) the production ramp (constants shipped 2026-07-17, Derek's ruling) ───────
describe("kSpreadPitRamp — fitted constants + league anchor + shape (regression pins)", () => {
  it("pins the fit provenance constants exactly (A=9.5394, G=319 — docs/CWHIT_KSPREAD_PIT_2026-07-16.md §2)", () => {
    expect(K_SPREAD_PIT.A).toBe(9.5394);
    expect(K_SPREAD_PIT.G).toBe(319);
  });
  it("s(0) === 1 EXACTLY, and s(g ≤ 0) === 1 (league anchor; stronger-than-training pools never compressed)", () => {
    expect(kSpreadPitRamp(0)).toBe(1);
    expect(kSpreadPitRamp(-5)).toBe(1);
    expect(kSpreadPitRamp(-100)).toBe(1);
  });
  it("reproduces the fitted ramp values at the reference gaps (stable gate-run numbers, 2dp)", () => {
    // From the shipping-candidate table in the results doc: s(10)=1.29, s(20)=1.58, s(28)=1.80.
    expect(kSpreadPitRamp(10)).toBeCloseTo(1.29, 2);
    expect(kSpreadPitRamp(20)).toBeCloseTo(1.58, 2);
    expect(kSpreadPitRamp(28)).toBeCloseTo(1.80, 2);
    // And at the measured Quick-tier gaps: iron 27.7→1.79, bronze 25.7→1.74, silver 22.5→1.65, gold 19.3→1.56.
    expect(kSpreadPitRamp(27.7)).toBeCloseTo(1.79, 2);
    expect(kSpreadPitRamp(25.7)).toBeCloseTo(1.74, 2);
    expect(kSpreadPitRamp(22.5)).toBeCloseTo(1.65, 2);
    expect(kSpreadPitRamp(19.3)).toBeCloseTo(1.56, 2);
  });
  it("is monotone non-decreasing in the gap and bounded by the plateau 1 + A", () => {
    let prev = kSpreadPitRamp(0);
    for (let g = 1; g <= 400; g += 1) {
      const s = kSpreadPitRamp(g);
      expect(s).toBeGreaterThanOrEqual(prev);
      expect(s).toBeLessThan(1 + K_SPREAD_PIT.A);
      prev = s;
    }
  });
  it("in-frame identity is STRUCTURAL: s(0)=1 hits applyKSpread's exact short-circuit (bit-identical K)", () => {
    const awkwardK = 137.29999999999998, awkwardMean = 121.90000000000003;
    expect(applyKSpread(awkwardK, awkwardMean, kSpreadPitRamp(0))).toBe(awkwardK);
  });
});

// ── 1) applyKSpread exact-identity + arithmetic ─────────────────────────────────
describe("applyKSpread — s=1 exact identity, amplification, clamp, monotonicity", () => {
  it("s === 1 returns the raw K BIT-EXACTLY for awkward float pairs (any mean)", () => {
    const ks = [0.1 + 0.2, 137.29999999999998, 5.1, 1e-9, 240.00000000000003];
    const means = [7.77, 133.3, 0.1 + 0.2, 121.9];
    for (const k of ks) for (const m of means) expect(applyKSpread(k, m, 1)).toBe(Math.max(0, k));
  });
  it("s > 1 amplifies the deviation about the mean, both directions", () => {
    expect(applyKSpread(10, 8, 1.5)).toBeCloseTo(11, 12);   // above the mean → further above
    expect(applyKSpread(6, 8, 1.5)).toBeCloseTo(5, 12);     // below the mean → further below
  });
  it("clamps at 0 (a weak K amplified far below the mean cannot go negative)", () => {
    expect(applyKSpread(1, 10, 2)).toBe(0);
  });
  it("is strictly monotone in K for any s > 0 ⇒ within-pool K ordering is unchanged by construction", () => {
    const s = 1.79, mean = 121.9;
    const ks = [40, 80, 121.9, 150, 200];
    const out = ks.map((k) => applyKSpread(k, mean, s));
    for (let i = 1; i < out.length; i++) expect(out[i]!).toBeGreaterThan(out[i - 1]!);
  });
});

// ── 2) scoreCard in-frame identity on the OWN-GAP path ──────────────────────────
describe("scoreCard (own-gap): an s=1 kSpread is bit-identical to no kSpread", () => {
  const coeffs = synthCoeffs();
  const derived = computeDerived(coeffs);
  const st = (mu: number): RatingStats => ({ mu, sd: 10 });
  const mkField = (hit: number[], pit: number[]): FieldStats => {
    const h: Record<string, RatingStats> = {}, p: Record<string, RatingStats> = {};
    (["eye", "pow", "kRat", "babip", "gap"] as const).forEach((k, i) => { h[k] = st(hit[i]!); });
    (["con", "stu", "pbabip", "hrr"] as const).forEach((k, i) => { p[k] = st(pit[i]!); });
    return { hit: { vR: h, vL: h }, pit: { vR: p, vL: p } };
  };
  // A REAL lift (weaker pool → k > 1), so the identity is tested on the transformed path.
  const poolTransform = buildPoolTransform(
    mkField([130, 150, 120, 130, 140], [130, 155, 120, 140]),
    mkField([100, 120, 95, 105, 110], [100, 125, 92, 110]),
  );
  it("kSpread { sHit: 1, sPit: 1 } with arbitrary (non-zero, awkward) means is a no-op", () => {
    const c = card();
    const base = scoreCard(c, { coeffs, derived, calScales: IDENTITY, poolTransform });
    const withKs = scoreCard(c, {
      coeffs, derived, calScales: IDENTITY, poolTransform,
      kSpread: { sHit: 1, sPit: 1, meanHit: 42.7, meanPit: 133.29999999999998 },
    });
    expect(withKs).toEqual(base);
  });
  it("a pitcher-only kSpread (sHit=1, sPit>1) moves pitching scores and NOT hitting scores", () => {
    const c = card();
    const base = scoreCard(c, { coeffs, derived, calScales: IDENTITY, poolTransform });
    const withKs = scoreCard(c, {
      coeffs, derived, calScales: IDENTITY, poolTransform,
      kSpread: { sHit: 1, sPit: 1.7, meanHit: 0, meanPit: 100 },
    });
    expect(withKs.hit).toEqual(base.hit);                    // hitter path untouched (BUILD-2's lane)
    expect(withKs.pitch.woba_vR).not.toBe(base.pitch.woba_vR); // pitcher path moved
  });
});

// ── 3) poolMeanKOwn ≡ poolMeanK under identity re-basings ──────────────────────
describe("poolMeanKOwn — the own-gap K̄_pool centering", () => {
  const coeffs = synthCoeffs();
  const cards = [
    card(), card({ Stuff: 100, "Avoid K": 120 }), card({ Stuff: 180, "Avoid K": 70 }),
    card({ Stuff: 120, Control: 140 }), card({ Stuff: 160, pBABIP: 120 }), card({ Stuff: 90, Power: 160 }),
  ];
  const ZERO_FS: FrameShift = {
    hit: { vR: {}, vL: {} }, pit: { vR: {}, vL: {} },
  };
  const EMPTY_PT: PoolTransform = { hit: { vR: {}, vL: {} }, pit: { vR: {}, vL: {} } };
  it("equals poolMeanK exactly when both re-basings are the identity (same cohorts, same math)", () => {
    const a = poolMeanK(cards, coeffs, logLinearModel, ZERO_FS, 4);
    const b = poolMeanKOwn(cards, coeffs, logLinearModel, EMPTY_PT, 4);
    expect(b.hit).toBe(a.hit);
    expect(b.pit).toBe(a.pit);
  });
  it("responds to a real own-gap lift (lifted Stuff ⇒ higher pitcher K̄)", () => {
    const lift: PoolTransform = {
      hit: { vR: {}, vL: {} },
      pit: {
        vR: { stu: { k: 1.2, c: Infinity, w: Infinity } },
        vL: { stu: { k: 1.2, c: Infinity, w: Infinity } },
      },
    };
    const base = poolMeanKOwn(cards, coeffs, logLinearModel, EMPTY_PT, 4);
    const lifted = poolMeanKOwn(cards, coeffs, logLinearModel, lift, 4);
    expect(lifted.pit).toBeGreaterThan(base.pit);
    expect(lifted.hit).toBe(base.hit);   // hitter cohort ratings untouched by a pit-only lift
  });
});

// ── 4) ourPit under a K-spread (the eval line the fit tool judges) ──────────────
describe("ourPit — eval-line K-spread behavior (synthetic #2 form)", () => {
  // Hand-built log-curve EventForm with sane per-600 magnitudes; deterministic, no training data.
  const ev = (b0: number, b1: number): FittedEvent => ({ beta: [b0, b1], mu: 0, sd: 1, curve: { kind: "log" } });
  const h = (b0: number, bRat: number, bBip: number): FittedH =>
    ({ beta: [b0, bRat, bBip], rating: { curve: { kind: "log" }, mu: 0, sd: 1 }, bip: { curve: { kind: "log" }, mu: 0, sd: 1 } });
  const form: EventForm = {
    hit: { bb: ev(-20, 15), k: ev(250, -30), hr: ev(-40, 12), h: h(-120, 15, 35), xbh: ev(-0.5, 0.17) },
    pit: { bb: ev(160, -25), k: ev(-140, 55), hr: ev(60, -10), h: h(-120, 10, 38) },
  };
  const coeffs = synthCoeffs();
  const deps: SampleDeps = {
    baseCards: [], coeffs, derived: computeDerived(coeffs), eventForm: form,
    model: makeRawPolyModel(form), W: DEFAULT_WOBA_WEIGHTS, ref: undefined as unknown as SampleDeps["ref"],
    pitExp: new Map(), hitExp: new Map(),
  };
  const EMPTY_PT: PoolTransform = { hit: { vR: {}, vL: {} }, pit: { vR: {}, vL: {} } };
  const lo = card({ Stuff: 90 }), mid = card({ Stuff: 140 }), hi = card({ Stuff: 190 });
  const pre = [lo, mid, hi].map((c) => ourPit(c as any, EMPTY_PT, deps, IDENTITY));
  const mean = pre[1]!.raw.k9! / (38.7 / 600) * 1; // center s.t. mid sits ~at the mean (per-600 units)
  const ks: KSpreadPit = { s: 1.74, mean };

  it("s = 1 ⇒ TwoLines identical to no correction at all", () => {
    const a = ourPit(mid as any, EMPTY_PT, deps, IDENTITY);
    const b = ourPit(mid as any, EMPTY_PT, deps, IDENTITY, { s: 1, mean: 999 });
    expect(b).toEqual(a);
  });
  it("s > 1 amplifies K about the mean and preserves K ordering", () => {
    const post = [lo, mid, hi].map((c) => ourPit(c as any, EMPTY_PT, deps, IDENTITY, ks));
    expect(post[2]!.raw.k9!).toBeGreaterThan(pre[2]!.raw.k9!);   // above-mean K pushed up
    expect(post[0]!.raw.k9!).toBeLessThan(pre[0]!.raw.k9!);      // below-mean K pushed down
    expect(post[0]!.raw.k9!).toBeLessThan(post[1]!.raw.k9!);     // ordering intact
    expect(post[1]!.raw.k9!).toBeLessThan(post[2]!.raw.k9!);
  });
  it("the raw composite moves the physical way (more K ⇒ fewer BIP ⇒ fewer hits ⇒ lower wOBAA)", () => {
    const postHi = ourPit(hi as any, EMPTY_PT, deps, IDENTITY, ks);
    const postLo = ourPit(lo as any, EMPTY_PT, deps, IDENTITY, ks);
    expect(postHi.raw.woba!).toBeLessThan(pre[2]!.raw.woba!);
    expect(postLo.raw.woba!).toBeGreaterThan(pre[0]!.raw.woba!);
  });
  it("BABIP stays a rate (the hit recompute rides the corrected BIP, not a stale hit count)", () => {
    const postHi = ourPit(hi as any, EMPTY_PT, deps, IDENTITY, ks);
    // The channel must move far less than K9 does — a stale nHH against a shrunken BIP would
    // inflate BABIP mechanically; the hRate recompute keeps it a near-stable rate.
    const dBabip = Math.abs(postHi.raw.babip! - pre[2]!.raw.babip!) / pre[2]!.raw.babip!;
    const dK9 = Math.abs(postHi.raw.k9! - pre[2]!.raw.k9!) / pre[2]!.raw.k9!;
    expect(dBabip).toBeLessThan(dK9 * 0.5);
  });
});
