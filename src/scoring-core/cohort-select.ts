// COHORT SELECTION — the model-free, data-fixed metric (cohort-rule event, 2026-07-23).
//
// STATUS: SCAFFOLD, NOT YET WIRED. This module is built ahead of the Sunday atomic event
// (docs/CWHIT_COHORT_RULE_EVENT_PREREG_2026-07-23.md) so that day is execution, not design. Nothing
// here is called by any scoring path yet — `computeUnifiedFieldStats` still ranks by model wOBA. The
// event's step 2 wires this into BOTH legs (the trainer's train-leg cohort and the pool-leg field),
// under one selection-rule tag. Until then production is bit-identical.
//
// WHY IT EXISTS: the task-0 STOP was a cross-model drift whose entire origin was the cohort being
// MODEL-SELECTED — a retrain (or a form change) reshuffles the wOBA ranking, so the cohort, the
// trainingMeans, and the gap all move even though the catalog did not. A MODEL-FREE metric over the
// WHOLE rating vector makes the cohort a function of the catalog ratings alone: data-fixed, immune to
// retrains and form changes by construction (Fable ruling, 2026-07-23).
//
// HARD CONSTRAINTS (prereg §2, pinned): model-free (no eventForm / predicted wOBA), whole rating
// vector (never one channel), same metric both legs. Any violation is off-spec.

/** Catalog-fixed reference moments for one role's rating vector: per-channel mean and sd over the
 *  full eligible catalog, side-pooled. Computed ONCE from the catalog (not the pool, not the model),
 *  which is what makes the metric data-fixed — the same card scores the same z-sum in every tournament
 *  and under every model version. */
export interface RatingRef {
  channels: readonly string[];
  mu: Record<string, number>;
  sd: Record<string, number>;
}

/** Build the catalog-fixed reference from per-channel value arrays (0 = "no rating this side",
 *  excluded, matching ratingStats). Population sd; a degenerate channel (sd 0) is carried as sd 1 so
 *  its z-contribution is the raw centred rating rather than a divide-by-zero. */
export function buildRatingRef(channels: readonly string[], valuesByChannel: Record<string, number[]>): RatingRef {
  const mu: Record<string, number> = {}, sd: Record<string, number> = {};
  for (const k of channels) {
    const v = (valuesByChannel[k] ?? []).filter((x) => x > 0);
    if (!v.length) { mu[k] = 0; sd[k] = 1; continue; }
    const m = v.reduce((a, b) => a + b, 0) / v.length;
    const s = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length);
    mu[k] = m; sd[k] = s > 0 ? s : 1;
  }
  return { channels, mu, sd };
}

/** THE METRIC. z-sum over the whole rating vector against the catalog-fixed reference. Higher = a
 *  stronger card by raw ratings; the cohort is the top-FIELD_N by this value. Equal channel weight
 *  (the assumption-free default; any weighting would need its own justification and risks smuggling a
 *  model back in — prereg §2). A missing/zero rating on a channel contributes 0 (its own centred value
 *  is undefined for this side), which is the same "absent this side" convention ratingStats uses. */
export function cohortZSum(ratings: Record<string, number>, ref: RatingRef): number {
  let z = 0;
  for (const k of ref.channels) {
    const r = ratings[k] ?? 0;
    if (r > 0) z += (r - ref.mu[k]!) / ref.sd[k]!;
  }
  return z;
}

/** The selection-rule tag stamped on the ramps' provenance (prereg §6). A ramp fit under one rule and
 *  scored under another must throw, exactly as an (N, p) mismatch does — the coordinate is
 *  rule-defined. Bump the version on any metric change (reference basis, channel set, weighting). */
export const COHORT_RULE_TAG = "zsum-catalog-v1" as const;
export type CohortRuleTag = typeof COHORT_RULE_TAG;

/** Selection mode. `model-woba` is the CURRENT production behaviour and the default until the event
 *  wires `zsum-catalog`. Carried as an explicit enum so the wiring is a one-line switch and the tests
 *  can pin both branches. */
export type CohortMode = "model-woba" | "zsum-catalog";
export const COHORT_MODE_DEFAULT: CohortMode = "model-woba";
