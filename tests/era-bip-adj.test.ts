// Per-era BIP_ADJ scale (§11.3 — the last dead-ball residual after era_h_bip + era_gap_share).
// The fitted H-curve trained on BIP = 600 − BB − K − HR − BIP_ADJ with a FIXED BIP_ADJ, but the
// real non-BIP-out level (HBP+SH+SF) varies by era. eraBipAdj scales the constant per era from
// the rates block (2010 → 1, dead-ball → ~2.4); computeDerived exposes it; rates-less configs
// keep the fixed constant (era_bip_adj = 1, bit-identical).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { eraBipAdj } from "../src/config/coeff-resolve.ts";
import { computeDerived } from "../src/scoring-core/index.ts";
import type { Coeffs } from "../src/config/types.ts";
import type { Era } from "../src/config/tournament.ts";

const era = (id: string): Era => JSON.parse(readFileSync(`data/eras/${id}.json`, "utf8"));

describe("eraBipAdj — per-era BIP_ADJ scale from the rates block", () => {
  it("the reference era (2010) maps to exactly 1 (guards REF_NONBIP_2010 against drift)", () => {
    expect(eraBipAdj(era("era-2010").rates!)).toBeCloseTo(1, 9);
  });
  it("era-1920 (dead-ball, heavy sac bunting): scale ≈ 2.4 (much more non-BIP outs)", () => {
    expect(eraBipAdj(era("era-1920").rates!)).toBeCloseTo(2.4, 1);
  });
  it("modern high-K era (2019): scale < 1 (fewer non-BIP outs than 2010)", () => {
    expect(eraBipAdj(era("era-2019").rates!)).toBeLessThan(1);
    expect(eraBipAdj(era("era-2019").rates!)).toBeCloseTo(0.90, 2);
  });
});

describe("computeDerived — era_bip_adj source selection", () => {
  const base = { era_avg: 1, era_hr: 1, era_thr: 1, tournament_hr_adjust: false } as Coeffs;
  it("uses the resolver's era_bip_adj when present", () => {
    expect(computeDerived({ ...base, era_bip_adj: 2.4 } as Coeffs, true).era_bip_adj).toBeCloseTo(2.4, 9);
  });
  it("falls back to 1 without it (captures/synthetic eras — fixed BIP_ADJ unchanged)", () => {
    expect(computeDerived(base, true).era_bip_adj).toBe(1);
  });
});
