import type { Coeffs, Derived } from "./types.ts";

// HR share of total hits from the Section-3 baseline; corrects era_avg (which
// includes HRs) so the non-HR-hit era multiplier doesn't double-apply HR.
// HR = 5525, total hits = 5525 + 34700 + 10550 + 1075 = 51850 → ≈ 0.1066
const HR_SHARE_OF_HITS = 5525 / (5525 + 34700 + 10550 + 1075);

/** era_effective_hr folds in the tournament-HR multiplier; era_h scales non-HR hits. */
export function computeDerived(coeffs: Coeffs): Derived {
  const era_effective_hr = coeffs.tournament_hr_adjust
    ? (coeffs.era_hr * coeffs.era_thr)
    : coeffs.era_hr;
  const era_h = (coeffs.era_avg - HR_SHARE_OF_HITS * era_effective_hr) / (1 - HR_SHARE_OF_HITS);
  return { era_h, era_effective_hr };
}
