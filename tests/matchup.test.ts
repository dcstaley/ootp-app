// Guard tests for the Phase-0 matchup reparametrization (src/model/matchup.ts).
//
// The matchup binding expresses the frame-v2 opponent-gap shift on the "matchup coordinate" by
// evaluating the base curve at x = own + (μ_train_opp − μ_pool_opp), i.e. the shift is bound INTO
// the event model instead of applied to ratings in score-card. Phase 0 fits NO new curve
// (tail ≡ 0, aRole ≡ 1), so the SAFETY PROPERTY is: matchup mode is BIT-IDENTICAL to frame-v2.
//
// Invariants covered (per the task):
//   2) matchup config == frame-v2 config, bit-identical, over a real card set — through the
//      DEPLOYED raw-poly model (fixtures/eventform-active.json). Proves the reparametrization and
//      guards against any accidental refit/regression. (calScales are recomputed independently
//      per config, so this also proves the anchor sees the same re-based events.)
//   3) In-frame identity: μ_pool == μ_train ⇒ matchup == the untransformed base model.
// Plus a unit check that the matchup wrapper's internal shift == buildFrameShift, and that a
// zero-shift wrapper is a pure pass-through of the base model.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  scoreCard, calibrate, calibrateBasic, computeDerived,
  makeRawPolyModel, computeUnifiedFieldStats, buildFrameShift, poolMeanK,
  type Coeffs, type EventForm, type CardScores,
} from "../src/scoring-core/index.ts";
import type { TrainingMeans } from "../src/model/pool-transform.ts";
import { makeMatchupModel, matchupShift } from "../src/model/matchup.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────────
const eventForm = JSON.parse(readFileSync("fixtures/eventform-active.json", "utf8")).eventForm as EventForm;
function synthCoeffs(): Coeffs {
  return JSON.parse(readFileSync("fixtures/captures/_synthetic.json", "utf8")).coeffs as Coeffs;
}

// A deterministic, varied pool of cards in the CSV-column shape scoreCard/pool-stats read.
function makePool(nCards: number): Record<string, unknown>[] {
  const cards: Record<string, unknown>[] = [];
  for (let i = 0; i < nCards; i++) {
    // Spread ratings across a realistic band with per-card variation, distinct per channel.
    const r = (base: number, span: number) => base + ((i * 37) % span) - span / 2;
    const hit = { eye: r(110, 60), pow: r(130, 70), kRat: r(95, 55), babip: r(105, 50), gap: r(120, 60) };
    const pit = { con: r(105, 55), stu: r(140, 65), pbabip: r(92, 45), hrr: r(112, 50) };
    const card: Record<string, unknown> = {
      "Card ID": `matchup-${i}`, "//Card Title": `Matchup ${i}`,
      Bats: (i % 3) + 1, Throws: (i % 2) + 1, // 1/2/3 bats, 1/2 throws — exercises the OVR blends
      Speed: 40 + (i % 40), Stealing: 30 + (i % 30), Baserunning: 45 + (i % 25), Hold: i % 10, GB: i % 5,
    };
    for (const side of ["vR", "vL"]) {
      // Slight per-side asymmetry so vR/vL are genuinely distinct.
      const d = side === "vL" ? 6 : 0;
      card[`Eye ${side}`] = hit.eye - d; card[`Power ${side}`] = hit.pow + d; card[`Avoid K ${side}`] = hit.kRat - d;
      card[`BABIP ${side}`] = hit.babip; card[`Gap ${side}`] = hit.gap + d;
      card[`Control ${side}`] = pit.con - d; card[`Stuff ${side}`] = pit.stu + d;
      card[`pBABIP ${side}`] = pit.pbabip; card[`pHR ${side}`] = pit.hrr - d;
    }
    cards.push(card);
  }
  return cards;
}

// Training-opponent means DISTINCT from the pool field, so every crossed gap is non-zero
// (a genuinely out-of-frame pool — the case matchup exists to handle).
const TRAIN: TrainingMeans = {
  hit: { eye: 128, pow: 150, kRat: 120, babip: 128, gap: 142 },
  pit: { con: 126, stu: 158, pbabip: 118, hrr: 138 },
};

const FIELD_N = 15;

// Compare two CardScores structurally with a tight tolerance.
function maxDiff(a: CardScores, b: CardScores): number {
  let m = 0;
  const walk = (x: any, y: any) => {
    for (const k of Object.keys(x)) {
      const xv = x[k], yv = y[k];
      if (typeof xv === "number") m = Math.max(m, Math.abs(xv - (yv as number)));
      else if (xv && typeof xv === "object") walk(xv, yv);
      else if (xv !== yv) m = Number.POSITIVE_INFINITY; // non-numeric field diverged (id/title/hand)
    }
  };
  walk(a, b);
  return m;
}

// ── 1) unit: the wrapper's shift == buildFrameShift; zero shift ⇒ pass-through ──
describe("makeMatchupModel / matchupShift (Phase 0 structure)", () => {
  const coeffs = synthCoeffs();
  const pool = makePool(40);
  const base = makeRawPolyModel(eventForm);
  const poolField = computeUnifiedFieldStats(pool, coeffs, base, FIELD_N, true);

  it("matchupShift == buildFrameShift for the same train/pool", () => {
    expect(matchupShift({ train: TRAIN, pool: poolField })).toEqual(buildFrameShift(TRAIN, poolField));
  });

  it("a zero-shift wrapper (train == pool) is a pure pass-through of the base model", () => {
    // Build an in-frame TrainingMeans equal to the pool's crossed means → every gap 0.
    const inFrameTrain: TrainingMeans = {
      hit: { eye: poolField.hit.vR.eye!.mu, kRat: poolField.hit.vR.kRat!.mu, pow: poolField.hit.vR.pow!.mu, babip: poolField.hit.vR.babip!.mu, gap: poolField.hit.vR.gap!.mu },
      pit: { con: poolField.pit.vR.con!.mu, stu: poolField.pit.vR.stu!.mu, hrr: poolField.pit.vR.hrr!.mu, pbabip: poolField.pit.vR.pbabip!.mu },
    };
    const wrapped = makeMatchupModel(base, { train: inFrameTrain, pool: poolField });
    const ratingsH = { eye: 120, pow: 140, kRat: 100, babip: 110, gap: 125, speed: 50, steal: 30, run: 40 };
    const ratingsP = { con: 110, stu: 150, pbabip: 95, hrr: 115 };
    expect(wrapped.predictHitting(ratingsH, coeffs)).toEqual(base.predictHitting(ratingsH, coeffs));
    expect(wrapped.predictPitching(ratingsP, coeffs)).toEqual(base.predictPitching(ratingsP, coeffs));
  });
});

// ── 2) matchup == frame-v2, bit-identical, over a real card set (deployed model) ─
describe("matchup mode is BIT-IDENTICAL to frame-v2 mode (safety property)", () => {
  const coeffs = synthCoeffs();
  const derived = computeDerived(coeffs, true); // eventForm active ⇒ tHR removed, as production
  const pool = makePool(48);
  const base = makeRawPolyModel(eventForm);
  const poolField = computeUnifiedFieldStats(pool, coeffs, base, FIELD_N, true);

  // The shift + K spread are shared by both modes (exactly how server.ts builds them).
  const shift = buildFrameShift(TRAIN, poolField);
  const kBar = poolMeanK(pool, coeffs, base, shift, FIELD_N);
  const kSpread = { sHit: 1.4, sPit: 1.75, meanHit: kBar.hit, meanPit: kBar.pit }; // arbitrary non-identity s

  // frame-v2: shift applied to ratings in score-card. Own calScales.
  const frameV2Base = { coeffs, derived, eventForm, frameShift: shift, kSpread };
  const frameV2 = { ...frameV2Base, calScales: calibrate(pool, frameV2Base) };
  const frameV2Basic = { ...frameV2Base, calScales: calibrateBasic(pool, frameV2Base) };

  // matchup: SAME shift bound into the model + used for basic. Own calScales.
  const matchup = { model: makeMatchupModel(base, { train: TRAIN, pool: poolField }), shift: matchupShift({ train: TRAIN, pool: poolField }) };
  const matchBase = { coeffs, derived, eventForm, matchup, kSpread };
  const match = { ...matchBase, calScales: calibrate(pool, matchBase) };
  const matchBasic = { ...matchBase, calScales: calibrateBasic(pool, matchBase) };

  it("calibrate (wOBA anchor) is bit-identical between the two modes", () => {
    expect(match.calScales).toEqual(frameV2.calScales);
  });

  it("calibrateBasic scales are bit-identical between the two modes", () => {
    expect(matchBasic.calScales).toEqual(frameV2Basic.calScales);
  });

  it("scoreCard (wOBA config) is bit-identical for EVERY card (< 1e-9)", () => {
    let worst = 0;
    for (const c of pool) worst = Math.max(worst, maxDiff(scoreCard(c, match), scoreCard(c, frameV2)));
    expect(worst).toBeLessThan(1e-9);
  });

  it("scoreCard (basic config) is bit-identical for EVERY card (< 1e-9)", () => {
    let worst = 0;
    for (const c of pool) worst = Math.max(worst, maxDiff(scoreCard(c, matchBasic), scoreCard(c, frameV2Basic)));
    expect(worst).toBeLessThan(1e-9);
  });

  it("the transform is actually ACTIVE (matchup differs from no-transform)", () => {
    // Guard against a vacuous pass: the out-of-frame shift must move scores.
    const plain = { coeffs, derived, eventForm, calScales: calibrate(pool, { coeffs, derived, eventForm }) };
    let moved = false;
    for (const c of pool) {
      if (maxDiff(scoreCard(c, match), scoreCard(c, plain)) > 1e-6) { moved = true; break; }
    }
    expect(moved).toBe(true);
  });
});

// ── 3) in-frame identity at the scoreCard level ─────────────────────────────────
describe("matchup in-frame identity (μ_pool == μ_train ⇒ untransformed base)", () => {
  const coeffs = synthCoeffs();
  const derived = computeDerived(coeffs, true);
  const pool = makePool(40);
  const base = makeRawPolyModel(eventForm);
  const poolField = computeUnifiedFieldStats(pool, coeffs, base, FIELD_N, true);

  // Train means set to the pool's crossed means → zero shift on every channel.
  const inFrameTrain: TrainingMeans = {
    hit: { eye: poolField.hit.vR.eye!.mu, kRat: poolField.hit.vR.kRat!.mu, pow: poolField.hit.vR.pow!.mu, babip: poolField.hit.vR.babip!.mu, gap: poolField.hit.vR.gap!.mu },
    pit: { con: poolField.pit.vR.con!.mu, stu: poolField.pit.vR.stu!.mu, hrr: poolField.pit.vR.hrr!.mu, pbabip: poolField.pit.vR.pbabip!.mu },
  };
  const matchup = { model: makeMatchupModel(base, { train: inFrameTrain, pool: poolField }), shift: matchupShift({ train: inFrameTrain, pool: poolField }) };

  it("scoreCard with an in-frame matchup (no kSpread) == the untransformed base scoreCard", () => {
    const plainBase = { coeffs, derived, eventForm };
    const plain = { ...plainBase, calScales: calibrate(pool, plainBase) };
    const inFrameBase = { coeffs, derived, eventForm, matchup };
    const inFrame = { ...inFrameBase, calScales: calibrate(pool, inFrameBase) };
    let worst = 0;
    for (const c of pool) worst = Math.max(worst, maxDiff(scoreCard(c, inFrame), scoreCard(c, plain)));
    expect(worst).toBeLessThan(1e-9);
  });
});
