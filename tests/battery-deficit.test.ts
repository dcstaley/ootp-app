// THE DEGENERATE IDENTITY behind battery item 1 (Fable ruling, 2026-07-21).
//
// The per-opponent integration shifts each channel by (mu_train_opp − r_j) for EVERY opponent j and
// averages the resulting predictions. The existing scalar machinery shifts once by
// (mu_train_opp − mu_pool_opp) — the opponents collapsed to their mean — and predicts once.
//
// The construction is only a legitimate generalisation if MEAN-OVER-J OF THE SHIFT recovers the
// scalar shift exactly. It does, algebraically: mean_j(mu − r_j) = mu − mean_j(r_j) = mu − mu_pool.
// Pinned here because the whole item-1 claim rests on it — if it broke, the tool would be measuring
// something other than "the scalar path plus a curvature term", and the difference between the two
// could no longer be attributed to opponent-distribution curvature.
//
// The pin deliberately does NOT assert that mean-of-PREDICTIONS equals prediction-at-mean-shift.
// That is exactly the Jensen gap item 1 exists to measure, and asserting it would be asserting the
// finding away.
import { describe, it, expect } from "vitest";
import { makeRawPolyModel } from "../src/scoring-core/index.ts";
import { Repository } from "../src/persistence/repository.ts";
import { buildFrameShift } from "../src/scoring-core/pool-stats.ts";
import type { EventForm } from "../src/model/curves.ts";

describe("per-opponent integration — degenerate identity", () => {
  it("mean over opponents of the per-opponent shift IS the scalar pool shift", () => {
    // Opponent ratings on one channel, deliberately asymmetric so a mistaken median/trimmed mean fails.
    const rj = [40, 55, 61, 78, 96, 120];
    const muTrain = 100;
    const muPool = rj.reduce((a, b) => a + b, 0) / rj.length;

    const perOpponent = rj.map((r) => muTrain - r);
    const meanOfShifts = perOpponent.reduce((a, b) => a + b, 0) / perOpponent.length;
    const scalarShift = muTrain - muPool;

    expect(meanOfShifts).toBeCloseTo(scalarShift, 12);
  });

  it("the channel CROSSING the integration uses is the one buildFrameShift defines", () => {
    // If the crossing map ever changes, item 1 must change with it or it integrates the wrong axis.
    // Pitcher channels are re-based by the OPPOSING hitter channel and vice versa.
    const train = { hit: { eye: 10, kRat: 20, pow: 30, babip: 40 }, pit: { con: 50, stu: 60, hrr: 70, pbabip: 80 } };
    const pool = {
      hit: { vR: { eye: { mu: 1, sd: 1 }, kRat: { mu: 2, sd: 1 }, pow: { mu: 3, sd: 1 }, babip: { mu: 4, sd: 1 } }, vL: {} },
      pit: { vR: { con: { mu: 5, sd: 1 }, stu: { mu: 6, sd: 1 }, hrr: { mu: 7, sd: 1 }, pbabip: { mu: 8, sd: 1 } }, vL: {} },
    };
    const s = buildFrameShift(train as never, pool as never);

    // pitcher side ← hitter means
    expect(s.pit.vR.con).toBeCloseTo(10 - 1, 12);      // con  ← hit.eye
    expect(s.pit.vR.stu).toBeCloseTo(20 - 2, 12);      // stu  ← hit.kRat
    expect(s.pit.vR.hrr).toBeCloseTo(30 - 3, 12);      // hrr  ← hit.pow
    expect(s.pit.vR.pbabip).toBeCloseTo(40 - 4, 12);   // pbabip ← hit.babip
    // hitter side ← pitcher means, with gap sharing babip's opposing channel
    expect(s.hit.vR.eye).toBeCloseTo(50 - 5, 12);      // eye   ← pit.con
    expect(s.hit.vR.kRat).toBeCloseTo(60 - 6, 12);     // kRat  ← pit.stu
    expect(s.hit.vR.pow).toBeCloseTo(70 - 7, 12);      // pow   ← pit.hrr
    expect(s.hit.vR.babip).toBeCloseTo(80 - 8, 12);    // babip ← pit.pbabip
    expect(s.hit.vR.gap).toBeCloseTo(80 - 8, 12);      // gap   ← pit.pbabip (shared)
  });

  it("the curvature gap is REAL on the DEPLOYED curves — mean-of-predictions != prediction-at-mean", async () => {
    // The premise of item 1: because the curves are nonlinear, averaging predictions over opponents is
    // NOT the same as predicting once at the average opponent. If these ever came out equal the whole
    // construction would collapse onto the scalar path and item 1 would have nothing to measure.
    // Uses the ACTIVE model's real event form — a fabricated form would prove nothing about production.
    const repo = new Repository("data");
    const state = (await repo.load<{ activeModelId?: string }>("state", "app")) ?? {};
    type TM = { id: string; eventForm?: EventForm };
    const trained = (await repo.loadAll<TM>("trained-models")).find((x) => x.id === state.activeModelId);
    if (!trained?.eventForm) { console.warn("[battery-deficit] no active model — curvature pin SKIPPED, not passed"); return; }
    const rp = makeRawPolyModel(trained.eventForm);
    const c = { era_k: 1, era_bb: 1, era_hr: 1, era_h: 1 } as never;

    const opp = [20, 60, 100, 140];                       // a wide, asymmetric opposing field
    const muOpp = opp.reduce((a, b) => a + b, 0) / opp.length;
    const base = { con: 80, stu: 90, hrr: 70, pbabip: 60 };

    const each = opp.map((o) => rp.predictPitching({ ...base, stu: base.stu + (100 - o) }, c).K);
    const meanOfPred = each.reduce((a, b) => a + b, 0) / each.length;
    const predAtMean = rp.predictPitching({ ...base, stu: base.stu + (100 - muOpp) }, c).K;

    expect(Number.isFinite(meanOfPred), "mean of per-opponent predictions").toBe(true);
    expect(Number.isFinite(predAtMean), "prediction at the mean opponent").toBe(true);
    // Not a magnitude claim — only that the two are genuinely different quantities.
    expect(Math.abs(meanOfPred - predAtMean)).toBeGreaterThan(1e-9);
  });
});
