// Per-BIP era_h derivation (plan doc §10 — the dead-ball 1B over-prediction fix).
// era_avg is a PER-PA hits ratio; era_h multiplies a PER-BIP quantity in the recompute,
// so deriving one from the other double-counts the era's K/BB-driven BIP expansion.
// resolveCoeffs now computes era_h_bip from the era's raw rates block; computeDerived
// prefers it. Legacy (rates-less) configs keep the old per-PA derivation bit-identical.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { eraHBip } from "../src/config/coeff-resolve.ts";
import { computeDerived } from "../src/scoring-core/index.ts";
import type { Coeffs } from "../src/config/types.ts";
import type { Era } from "../src/config/tournament.ts";

const era = (id: string): Era => JSON.parse(readFileSync(`data/eras/${id}.json`, "utf8"));

describe("eraHBip — per-BIP non-HR-hit era factor from the rates block", () => {
  it("the reference era (2010) maps to exactly 1 (guards the REF constant against library drift)", () => {
    expect(eraHBip(era("era-2010").rates!)).toBeCloseTo(1, 9);
  });
  it("era-1920 (dead-ball): per-BIP factor ≈ 0.974, NOT the per-PA-derived 1.152", () => {
    expect(eraHBip(era("era-1920").rates!)).toBeCloseTo(0.974, 3);
  });
  it("modern high-K eras flip the sign of the error (per-BIP ABOVE the per-PA derivation)", () => {
    const e = era("era-2019");
    const perBip = eraHBip(e.rates!);
    const perPaDerived = computeDerived({ era_avg: e.avg, era_hr: e.hr, era_thr: 1, tournament_hr_adjust: false } as Coeffs, true).era_h;
    expect(perBip).toBeGreaterThan(perPaDerived); // model was UNDER-predicting hits here
  });
});

describe("computeDerived — era_h source selection", () => {
  const base = { era_avg: 1.056042, era_hr: 0.25184, era_thr: 1, tournament_hr_adjust: false } as Coeffs;
  it("uses era_h_bip when the resolver provided it", () => {
    expect(computeDerived({ ...base, era_h_bip: 0.974 } as Coeffs, true).era_h).toBeCloseTo(0.974, 9);
  });
  it("falls back to the legacy per-PA derivation without it (captures/synthetic configs unchanged)", () => {
    const d = computeDerived(base, true);
    expect(d.era_h).toBeCloseTo((1.056042 - (5525 / 51850) * 0.25184) / (1 - 5525 / 51850), 6);
  });
});
