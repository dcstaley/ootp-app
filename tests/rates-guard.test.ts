// Guard: a partial/malformed era rates block must be REJECTED (not silently ÷0 → Infinity scores).
// The per-BIP era factors divide by rates.bip and (rates.h − rates.hr); validateRates fails fast at
// ingestion + resolve. See coeff-resolve.validateRates + eras-bbref/resolveCoeffs wiring.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { validateRates } from "../src/config/coeff-resolve.ts";
import type { Era } from "../src/config/tournament.ts";

const goodRates = (JSON.parse(readFileSync("data/eras/era-1920.json", "utf8")) as Era).rates!;

describe("validateRates — reject partial/malformed era rates blocks", () => {
  it("accepts a complete real rates block", () => {
    expect(() => validateRates(goodRates)).not.toThrow();
  });
  it("rejects null / non-object", () => {
    expect(() => validateRates(null)).toThrow(/missing or not an object/);
    expect(() => validateRates(undefined)).toThrow(/missing or not an object/);
  });
  it("rejects a missing required field", () => {
    const { bip, ...noBip } = goodRates;
    void bip;
    expect(() => validateRates(noBip)).toThrow(/non-finite\/missing field\(s\): bip/);
  });
  it("rejects a non-finite field", () => {
    expect(() => validateRates({ ...goodRates, h: NaN })).toThrow(/field\(s\): h/);
  });
  it("rejects bip <= 0 (the divisor)", () => {
    expect(() => validateRates({ ...goodRates, bip: 0 })).toThrow(/rates.bip must be > 0/);
  });
  it("rejects h − hr <= 0 (the divisor)", () => {
    expect(() => validateRates({ ...goodRates, h: 0.01, hr: 0.02 })).toThrow(/rates\.h − rates\.hr must be > 0/);
  });
});
