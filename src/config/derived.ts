import type { Coeffs, Derived } from "./types.ts";

// HR share of total hits from the Section-3 baseline; corrects era_avg (which
// includes HRs) so the non-HR-hit era multiplier doesn't double-apply HR.
// HR = 5525, total hits = 5525 + 34700 + 10550 + 1075 = 51850 → ≈ 0.1066
const HR_SHARE_OF_HITS = 5525 / (5525 + 34700 + 10550 + 1075);

/** era_effective_hr folds in the tournament-HR multiplier; era_h scales non-HR hits.
 *  `removeTHR` (set under #2) drops tHR entirely → era_effective_hr = era_hr. The old
 *  tournament_hr_adjust/era_thr path stays only for the log-linear parity baseline; the
 *  full config-field removal rides with the log-model retirement.
 *
 *  era_h is a PER-BIP multiplier (woba.ts applies it to perBIP(rating) × BIP_fin, after
 *  BIP has already expanded/contracted under era_bb/era_k/era_hr). When the resolver
 *  provides `era_h_bip` (computed from the era's raw rates block), use it directly —
 *  the legacy formula below derives era_h from the PER-PA `era_avg`, which double-counts
 *  the era's BIP expansion (dead-ball 1920: 1.152 per-PA vs 0.974 per-BIP; validated
 *  against 280k PA of real era-1920 tournament outcomes, plan doc §10). The legacy path
 *  remains for capture-sourced/synthetic coeffs without an era rates block. */
export function computeDerived(coeffs: Coeffs, removeTHR = false): Derived {
  const era_effective_hr = (!removeTHR && coeffs.tournament_hr_adjust)
    ? (coeffs.era_hr * coeffs.era_thr)
    : coeffs.era_hr;
  const era_h = coeffs.era_h_bip
    ?? (coeffs.era_avg - HR_SHARE_OF_HITS * era_effective_hr) / (1 - HR_SHARE_OF_HITS);
  // era_gap: prefer the resolver's per-share factor (rates-derived); fall back to the legacy
  // per-PA coeff for captures/synthetic eras (bit-identical). See eraGapShare / Job 2.1.
  const era_gap = coeffs.era_gap_share ?? coeffs.era_gap;
  return { era_h, era_effective_hr, era_gap };
}
