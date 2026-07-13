// Matchup reparametrization (Phase 0 — PLUMBING ONLY, no refitting).
//
// frame-v2 re-bases a weak pool by ADDING each channel's opposing-channel gap
// (μ_train_opp − μ_pool_opp) to the rating BEFORE the event model (applyFrameShift in
// score-card/calibrate). This module expresses the SAME re-basing on the "matchup
// coordinate" by BINDING the shift INTO the event model: `makeMatchupModel` wraps a base
// EventModel and, for each channel, evaluates the base curve at the effective rating
//
//     x = own + (μ_train_opp − μ_pool_opp)
//
// i.e. the shift is computed here (from oppMeans = {train, pool}) instead of applied by the
// orchestrator. The crossing + subtraction reuse `buildFrameShift` verbatim, so the effective
// coordinate is bit-identical to the frame-v2 shift.
//
// Phase 0 also carries the Phase-1 structure — a `tail` term and a per-role slope `aRole` on
// the K channel — but PINNED to the identity (tail ≡ 0, aRole ≡ 1), so NO new curve is fit and
// the model is BIT-IDENTICAL to "apply frame-v2 shift, then base model". The interim per-role
// K spread scaling (`kSpread`) stays applied by score-card/calibrate in matchup mode (the K
// patch until Phase 1 fits the tail); it is NOT part of this wrapper.

import type { Coeffs } from "../config/types.ts";
import type { EventModel, HittingRatings, PitchingRatings, RawHitting, RawPitching } from "./types.ts";
import { applyFrameShift, type TrainingMeans, type FrameShift } from "./pool-transform.ts";
import { buildFrameShift, type FieldStats } from "../scoring-core/pool-stats.ts";

// The opponent means the matchup coordinate is measured against: the model's TRAINING-league
// opponent means (the reference frame) and the tournament POOL's unified field means. Since the
// matched-legs change (f88912c), fresh artifacts store `trainingMeans` = the TOP-50 field of the
// training league (matched to the top-50 pool μ, so the in-frame gap is 0). FORWARD-ONLY: artifacts
// trained before f88912c still carry the older PA/BF usage-weighted means (a mismatched leg).
export interface OppMeans { train: TrainingMeans; pool: FieldStats }

// Phase-1 structure, PINNED to identity in Phase 0. `tail` = an additive K offset; `aRole` = a
// per-role K slope. Both no-ops here (tail 0, aRole 1) — present so the seam exists for the fit.
export interface MatchupOpts { tail?: number; aRole?: { hit: number; pit: number } }

/** The crossed opponent-gap shift for a matchup binding — the SAME shift frame-v2 applies,
 *  so score-card's basic path (which reads ratings directly, not via the model) can re-base on
 *  the identical coordinate. Reuses buildFrameShift ⇒ zero divergence from frame-v2. */
export const matchupShift = (opp: OppMeans): FrameShift => buildFrameShift(opp.train, opp.pool);

/**
 * Wrap a base EventModel so it evaluates on the matchup coordinate: each channel's own rating is
 * shifted by its opposing-channel gap (μ_train_opp − μ_pool_opp) BEFORE the base curve. The shift
 * is side-unified (vR === vL, matching frame-v2), so the wrapper is side-agnostic. Phase 0:
 * tail ≡ 0, aRole ≡ 1 ⇒ the K post-term is skipped and the wrapper is bit-identical to applying
 * the frame-v2 shift then the base model.
 */
export function makeMatchupModel(base: EventModel, opp: OppMeans, opts: MatchupOpts = {}): EventModel {
  const shift = matchupShift(opp);
  const hd = shift.hit.vR, pd = shift.pit.vR; // side-unified
  const tail = opts.tail ?? 0;                // Phase 1 fits this; 0 here
  const aHit = opts.aRole?.hit ?? 1;          // Phase 1 fits this; 1 here
  const aPit = opts.aRole?.pit ?? 1;

  function predictHitting(r: HittingRatings, c: Coeffs): RawHitting {
    const e = base.predictHitting({
      eye: applyFrameShift(r.eye, hd.eye),
      pow: applyFrameShift(r.pow, hd.pow),
      kRat: applyFrameShift(r.kRat, hd.kRat),
      babip: applyFrameShift(r.babip, hd.babip),
      gap: applyFrameShift(r.gap, hd.gap),
      speed: r.speed, steal: r.steal, run: r.run,
    }, c);
    // Phase-0 no-op (aHit ≡ 1, tail ≡ 0) — Phase 1 replaces this with the fitted K tail.
    if (aHit !== 1 || tail !== 0) e.SO = Math.max(0, aHit * e.SO + tail);
    return e;
  }

  function predictPitching(r: PitchingRatings, c: Coeffs): RawPitching {
    const e = base.predictPitching({
      con: applyFrameShift(r.con, pd.con),
      stu: applyFrameShift(r.stu, pd.stu),
      pbabip: applyFrameShift(r.pbabip, pd.pbabip),
      hrr: applyFrameShift(r.hrr, pd.hrr),
    }, c);
    if (aPit !== 1 || tail !== 0) e.K = Math.max(0, aPit * e.K + tail);
    return e;
  }

  return { predictHitting, predictPitching };
}
