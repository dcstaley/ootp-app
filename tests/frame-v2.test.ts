// Guard tests for frame-correction v2 (additive, channel-crossed opponent-gap shift +
// K-spread scaling) — the scoring path added to the core in the working tree.
//
// Invariants covered:
//   1) applyFrameShift edge cases (pure unit).
//   2) buildFrameShift channel-crossing + in-frame identity.
//   3) In-frame identity at the scoreCard level (zero shift + s=1 ⇒ no-op).
//   4) Own-gap (poolTransform) scores are unchanged by the new optional frame-v2 fields.
//
// Determinism: these invariants are MODEL-AGNOSTIC (the frame shift acts on ratings
// before the model; kSpread rescales the raw K about a mean with s=1 ⇒ identity for any
// model that returns SO/K, which both do). So the scoreCard-level tests run through the
// log-linear path (no eventForm) using the committed _synthetic.json coeffs — no training
// data, no tournament data, fully deterministic.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  applyFrameShift, buildFrameShift, computeDerived, scoreCard,
  type Coeffs, type CalScales, type FrameShift,
} from "../src/scoring-core/index.ts";
import { buildPoolTransform, type FieldStats } from "../src/scoring-core/pool-stats.ts";
import type { TrainingMeans } from "../src/model/pool-transform.ts";
import type { RatingStats } from "../src/model/pool-transform.ts";

// ── Shared fixtures ─────────────────────────────────────────────────────────────
function synthCoeffs(): Coeffs {
  return JSON.parse(readFileSync("fixtures/captures/_synthetic.json", "utf8")).coeffs as Coeffs;
}

// A card in the CSV-column shape scoreCard reads, with varied, non-degenerate ratings.
function sampleCard(): Record<string, unknown> {
  const hit = { Eye: 120, Power: 145, "Avoid K": 90, BABIP: 110, Gap: 130 };
  const pit = { Control: 105, Stuff: 150, pBABIP: 95, pHR: 115 };
  const card: Record<string, unknown> = {
    "Card ID": "frame-v2-sample", "//Card Title": "Frame V2 Sample",
    Bats: 1, Throws: 1, Speed: 60, Stealing: 40, Baserunning: 55, Hold: 0, GB: 2,
  };
  for (const side of ["vR", "vL"]) {
    card[`Eye ${side}`] = hit.Eye; card[`Power ${side}`] = hit.Power; card[`Avoid K ${side}`] = hit["Avoid K"];
    card[`BABIP ${side}`] = hit.BABIP; card[`Gap ${side}`] = hit.Gap;
    card[`Control ${side}`] = pit.Control; card[`Stuff ${side}`] = pit.Stuff;
    card[`pBABIP ${side}`] = pit.pBABIP; card[`pHR ${side}`] = pit.pHR;
  }
  return card;
}

const IDENTITY: CalScales = {
  hitBBScaleVR: 1, hitBBScaleVL: 1, hitHRScaleVR: 1, hitHRScaleVL: 1, hitScaleVR: 1, hitScaleVL: 1,
  pBBScaleVR: 1, pBBScaleVL: 1, pHRScaleVR: 1, pHRScaleVL: 1, pitchScaleVR: 1, pitchScaleVL: 1,
  ssp_adv_hitting: 1, ssp_basic_pitching: 1,
};

const ZERO_SHIFT: FrameShift = {
  hit: { vR: { eye: 0, pow: 0, kRat: 0, babip: 0, gap: 0 }, vL: { eye: 0, pow: 0, kRat: 0, babip: 0, gap: 0 } },
  pit: { vR: { con: 0, stu: 0, pbabip: 0, hrr: 0 }, vL: { con: 0, stu: 0, pbabip: 0, hrr: 0 } },
};

const st = (mu: number, sd = 10): RatingStats => ({ mu, sd });
// A FieldStats-shaped object (side-unified: vR === vL) with per-rating {mu, sd}.
function makeField(hitMu: Record<string, number | undefined>, pitMu: Record<string, number | undefined>): FieldStats {
  const hit: Record<string, RatingStats> = {};
  for (const k of ["eye", "pow", "kRat", "babip", "gap"]) hit[k] = st(hitMu[k] ?? 0);
  const pit: Record<string, RatingStats> = {};
  for (const k of ["con", "stu", "pbabip", "hrr"]) pit[k] = st(pitMu[k] ?? 0);
  return { hit: { vR: hit, vL: hit }, pit: { vR: pit, vL: pit } };
}

// ── 1) applyFrameShift edge cases ───────────────────────────────────────────────
describe("applyFrameShift (additive, clamped ≥ 0)", () => {
  it("identity when the delta is absent", () => {
    expect(applyFrameShift(100, undefined)).toBe(100);
  });
  it("identity when the delta is exactly 0", () => {
    expect(applyFrameShift(100, 0)).toBe(100);
  });
  it("a positive delta adds", () => {
    expect(applyFrameShift(100, 12)).toBe(112);
  });
  it("a negative delta that would go below 0 is clamped to 0", () => {
    expect(applyFrameShift(5, -20)).toBe(0);
  });
});

// ── 2) buildFrameShift channel-crossing + in-frame identity ─────────────────────
describe("buildFrameShift (channel-crossed opponent-gap shift)", () => {
  // `satisfies` (not `: TrainingMeans`) keeps concrete keys, so train.hit.pow is `number`
  // (not `number | undefined`) under noUncheckedIndexedAccess.
  const train = {
    hit: { eye: 100, pow: 130, kRat: 90, babip: 110, gap: 120 },
    pit: { con: 95, stu: 140, pbabip: 85, hrr: 105 },
  } satisfies TrainingMeans;
  // Pool means chosen distinct from train so every crossed gap is non-zero.
  const pool = makeField(
    { eye: 84, pow: 118, kRat: 78, babip: 96, gap: 108 },
    { con: 80, stu: 122, pbabip: 70, hrr: 88 },
  );

  const fs = buildFrameShift(train, pool);

  it("hitting channels are re-based by the OPPOSING pitching gap (eye↔con, kRat↔stu, pow↔hrr, babip/gap↔pbabip)", () => {
    expect(fs.hit.vR.eye).toBe(train.pit.con - pool.pit.vR.con!.mu);
    expect(fs.hit.vR.kRat).toBe(train.pit.stu - pool.pit.vR.stu!.mu);
    expect(fs.hit.vR.pow).toBe(train.pit.hrr - pool.pit.vR.hrr!.mu);
    expect(fs.hit.vR.babip).toBe(train.pit.pbabip - pool.pit.vR.pbabip!.mu);
    expect(fs.hit.vR.gap).toBe(train.pit.pbabip - pool.pit.vR.pbabip!.mu);
    // babip and gap share the same pBABIP-derived shift.
    expect(fs.hit.vR.babip).toBe(fs.hit.vR.gap);
  });

  it("pitching channels are re-based by the OPPOSING hitting gap (con↔eye, stu↔kRat, hrr↔pow, pbabip↔babip)", () => {
    expect(fs.pit.vR.con).toBe(train.hit.eye - pool.hit.vR.eye!.mu);
    expect(fs.pit.vR.stu).toBe(train.hit.kRat - pool.hit.vR.kRat!.mu);
    expect(fs.pit.vR.hrr).toBe(train.hit.pow - pool.hit.vR.pow!.mu);
    expect(fs.pit.vR.pbabip).toBe(train.hit.babip - pool.hit.vR.babip!.mu);
  });

  it("is side-unified (vL === vR for every channel)", () => {
    expect(fs.hit.vL).toEqual(fs.hit.vR);
    expect(fs.pit.vL).toEqual(fs.pit.vR);
  });

  it("IN-FRAME: when pool means equal the crossed training means, every delta is 0", () => {
    // For each crossed channel, set the pool mu equal to the training mean it is compared to.
    const inFramePool = makeField(
      // hitting-side pool mu's are compared to train.hit.{eye,kRat,pow,babip}
      { eye: train.hit.eye, kRat: train.hit.kRat, pow: train.hit.pow, babip: train.hit.babip, gap: 0 },
      // pitching-side pool mu's are compared to train.pit.{con,stu,hrr,pbabip}
      { con: train.pit.con, stu: train.pit.stu, hrr: train.pit.hrr, pbabip: train.pit.pbabip },
    );
    const zero = buildFrameShift(train, inFramePool);
    expect(zero.hit.vR).toEqual({ eye: 0, kRat: 0, pow: 0, babip: 0, gap: 0 });
    expect(zero.pit.vR).toEqual({ con: 0, stu: 0, hrr: 0, pbabip: 0 });
    expect(zero.hit.vL).toEqual(zero.hit.vR);
    expect(zero.pit.vL).toEqual(zero.pit.vR);
  });
});

// ── 3) scoreCard-level in-frame identity ────────────────────────────────────────
describe("scoreCard: zero frame shift + s=1 K-spread is a no-op", () => {
  const coeffs = synthCoeffs();
  const derived = computeDerived(coeffs);
  const card = sampleCard();

  it("baseline == (frameShift all-zero, kSpread s=1) — deeply equal CardScores", () => {
    // Same calScales object passed to both so ONLY the frame-v2 fields differ.
    const baseline = scoreCard(card, { coeffs, derived, calScales: IDENTITY });
    const frameV2 = scoreCard(card, {
      coeffs, derived, calScales: IDENTITY,
      frameShift: ZERO_SHIFT,
      // s=1 ⇒ K_corr = mean + 1·(K − mean) = K, regardless of the (arbitrary) means.
      kSpread: { sHit: 1, sPit: 1, meanHit: 42, meanPit: 137 },
    });
    expect(frameV2).toEqual(baseline);
  });

  it("also a no-op with calScales: null (raw assembled path)", () => {
    const baseline = scoreCard(card, { coeffs, derived, calScales: null });
    const frameV2 = scoreCard(card, {
      coeffs, derived, calScales: null,
      frameShift: ZERO_SHIFT,
      kSpread: { sHit: 1, sPit: 1, meanHit: 5, meanPit: 200 },
    });
    expect(frameV2).toEqual(baseline);
  });
});

// ── 4) own-gap poolTransform unchanged by the new optional fields ───────────────
describe("scoreCard: own-gap poolTransform is unaffected by absent frame-v2 fields", () => {
  const coeffs = synthCoeffs();
  const derived = computeDerived(coeffs);
  const card = sampleCard();

  // A real own-gap transform: pool field weaker (lower mu) than the reference → k > 1 lift.
  const ref = makeField(
    { eye: 130, pow: 150, kRat: 120, babip: 130, gap: 140 },
    { con: 130, stu: 155, pbabip: 120, hrr: 140 },
  );
  const pool = makeField(
    { eye: 100, pow: 120, kRat: 95, babip: 105, gap: 110 },
    { con: 100, stu: 125, pbabip: 92, hrr: 110 },
  );
  const poolTransform = buildPoolTransform(ref, pool); // no envelope ⇒ pure scalar lift

  it("adding frameShift: undefined, kSpread: undefined equals omitting them", () => {
    const withTransform = scoreCard(card, { coeffs, derived, calScales: IDENTITY, poolTransform });
    const withUndefined = scoreCard(card, {
      coeffs, derived, calScales: IDENTITY, poolTransform,
      frameShift: undefined, kSpread: undefined,
    });
    expect(withUndefined).toEqual(withTransform);
  });

  it("the own-gap transform is actually active (it changes scores vs no transform)", () => {
    const noTransform = scoreCard(card, { coeffs, derived, calScales: IDENTITY });
    const withTransform = scoreCard(card, { coeffs, derived, calScales: IDENTITY, poolTransform });
    // At least one metric must move, or the "unchanged by frame-v2" guard above is vacuous.
    expect(withTransform.hit.woba_vR).not.toBe(noTransform.hit.woba_vR);
  });
});
