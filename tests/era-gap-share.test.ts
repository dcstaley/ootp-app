// Per-share era_gap derivation (Job 2.1 — the dead-ball XBH over-prediction fix, same class
// as era_h_bip). era_gap was a PER-PA XBH ratio, but woba.ts multiplies it onto
// GAP_rate × BA_fin, where BA_fin already carries the hit level (era_h) and the BIP
// expansion — so a per-PA era_gap triple-counts. resolveCoeffs now computes era_gap_share
// (the XBH SHARE of non-HR hits vs 2010) from the rates block; computeDerived prefers it.
// Legacy (rates-less) configs keep the per-PA era_gap bit-identically.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { eraGapShare } from "../src/config/coeff-resolve.ts";
import { computeDerived } from "../src/scoring-core/index.ts";
import type { Coeffs } from "../src/config/types.ts";
import type { Era } from "../src/config/tournament.ts";

const era = (id: string): Era => JSON.parse(readFileSync(`data/eras/${id}.json`, "utf8"));

describe("eraGapShare — per-non-HR-hit XBH-share era factor from the rates block", () => {
  it("the reference era (2010) maps to exactly 1 (guards REF_XBH_SHARE_NHH against library drift)", () => {
    expect(eraGapShare(era("era-2010").rates!)).toBeCloseTo(1, 9);
  });
  it("era-1920 (dead-ball): per-share factor ≈ 0.855, NOT the per-PA 0.987", () => {
    expect(eraGapShare(era("era-1920").rates!)).toBeCloseTo(0.855, 3);
    expect(era("era-1920").gap).toBeCloseTo(0.987, 3); // the legacy per-PA value it replaces
  });
  it("modern high-XBH-share eras flip the sign (per-share ABOVE the per-PA gap)", () => {
    const e = era("era-2019");
    expect(eraGapShare(e.rates!)).toBeGreaterThan(e.gap); // model was UNDER-predicting modern XBH
    expect(eraGapShare(e.rates!)).toBeCloseTo(1.070, 3);
  });
});

describe("computeDerived — era_gap source selection", () => {
  it("uses era_gap_share when the resolver provided it", () => {
    const d = computeDerived({ era_gap: 0.987, era_gap_share: 0.855, era_avg: 1, era_hr: 1, era_thr: 1, tournament_hr_adjust: false } as Coeffs, true);
    expect(d.era_gap).toBeCloseTo(0.855, 9);
  });
  it("falls back to the legacy per-PA era_gap without it (captures/synthetic configs unchanged)", () => {
    const d = computeDerived({ era_gap: 0.987, era_avg: 1, era_hr: 1, era_thr: 1, tournament_hr_adjust: false } as Coeffs, true);
    expect(d.era_gap).toBeCloseTo(0.987, 9);
  });
});
