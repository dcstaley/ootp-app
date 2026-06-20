// GOLDEN HARNESS — `derived` values extracted verbatim from the old
// C:\ootp_app\frontend\lib\coeffs.tsx (the useMemo body + HR_SHARE_OF_HITS).
// era_h corrects era_avg (which includes HRs) for non-HR hits; era_effective_hr
// folds in the tournament-HR multiplier when enabled.

import type { Derived } from "./computeRows.ts";

// HR = 5525, total hits = 5525 + 34700 + 10550 + 1075 = 51850 → HR share ≈ 0.1066
const HR_SHARE_OF_HITS = 5525 / (5525 + 34700 + 10550 + 1075);

export function computeDerived(coeffs: any): Derived {
  const era_effective_hr = coeffs.tournament_hr_adjust
    ? (coeffs.era_hr * coeffs.era_thr)
    : coeffs.era_hr;
  const era_h = (coeffs.era_avg - HR_SHARE_OF_HITS * era_effective_hr) / (1 - HR_SHARE_OF_HITS);
  return { era_h, era_effective_hr };
}
