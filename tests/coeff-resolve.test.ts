// M3 (D4) — resolveCoeffs parity gate. A captured bag decomposed into its
// Model + Era + Park + Softcaps parts and resolved back must be byte-identical,
// i.e. selecting a tournament reproduces the captured scores exactly (no drift
// from the "single config source" flow). Runs over the committed _synthetic
// fixture plus any local real captures (gitignored).

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Coeffs } from "../src/scoring-core/index.ts";
import { resolveCoeffs, modelFromCoeffs, eraFromCoeffs, parkFromCoeffs, softcapsFromCoeffs } from "../src/config/coeff-resolve.ts";

const captureDir = "fixtures/captures";
const captures = existsSync(captureDir) ? readdirSync(captureDir).filter((f) => f.endsWith(".json")) : [];
const loadCoeffs = (file: string): Coeffs => (JSON.parse(readFileSync(join(captureDir, file), "utf8")) as { coeffs: Coeffs }).coeffs;

describe("baserunning value: derived + era-scaled by runVal", () => {
  const synth = "_synthetic.json";
  const has = existsSync(join(captureDir, synth));
  it.runIf(has)("adv_speed/adv_run are nonzero at baseline and scale linearly with runVal", () => {
    const bag = loadCoeffs(synth);
    const model = modelFromCoeffs(bag, "m", "m"), park = parkFromCoeffs(bag, "p", "p"), sc = softcapsFromCoeffs(bag);
    const era1 = { ...eraFromCoeffs(bag, "e", "e"), runVal: 1, sbFreq: 1 };
    const era2 = { ...eraFromCoeffs(bag, "e", "e"), runVal: 2, sbFreq: 1 };
    const era3 = { ...eraFromCoeffs(bag, "e", "e"), runVal: 2, sbFreq: 3 };
    const r1 = resolveCoeffs(model, era1, park, sc);
    const r2 = resolveCoeffs(model, era2, park, sc);
    const r3 = resolveCoeffs(model, era3, park, sc);
    expect(r1.adv_speed).toBeGreaterThan(0);      // UBR valued (was 0)
    expect(r1.adv_run).toBeGreaterThan(r1.adv_speed); // Baserunning rating weighted above Speed (per the fit)
    expect(r2.adv_speed).toBeCloseTo(r1.adv_speed * 2, 12); // UBR scales by runVal only
    expect(r2.adv_run).toBeCloseTo(r1.adv_run * 2, 12);
    expect(r1.adv_steal).toBe(0);                 // ability-only linear steal retired
    // steal coeffs: tendency term negative, interaction positive; both scale by sbFreq×runVal.
    expect(r1.adv_stealRate!).toBeLessThan(0);
    expect(r1.adv_stealInt!).toBeGreaterThan(0);
    expect(r2.adv_stealInt!).toBeCloseTo(r1.adv_stealInt! * 2, 12);   // ×runVal (sbFreq=1)
    expect(r3.adv_stealInt!).toBeCloseTo(r1.adv_stealInt! * 6, 12);   // ×(sbFreq 3 · runVal 2)
  });
  it.runIf(has)("missing runVal (capture/synthetic era) falls back to neutral scaling", () => {
    const bag = loadCoeffs(synth);
    const era = eraFromCoeffs(bag, "e", "e"); // no runVal
    const r = resolveCoeffs(modelFromCoeffs(bag, "m", "m"), era, parkFromCoeffs(bag, "p", "p"), softcapsFromCoeffs(bag));
    expect(r.adv_speed).toBeGreaterThan(0);       // neutral runVal=1, still valued
  });
});

describe("resolveCoeffs reproduces the capture bag", () => {
  for (const f of captures) {
    it(`is byte-identical for ${f}`, () => {
      const bag = loadCoeffs(f);
      const resolved = resolveCoeffs(
        modelFromCoeffs(bag, "m", "m"),
        eraFromCoeffs(bag, "e", "e"),
        parkFromCoeffs(bag, "p", "p"),
        softcapsFromCoeffs(bag),
      );
      // Baserunning coeffs are now DERIVED post-assembly (league-fit value × era factors), like
      // era_h_bip — not passed through from the bag. adv_speed/adv_run are recomputed (value differs);
      // adv_stealRate/adv_stealInt are NEW keys absent from older capture bags. Exclude both from the
      // byte-identity round-trip.
      const derivedVal = new Set(["adv_speed", "adv_run", "adv_stealRate", "adv_stealInt"]);
      const newKeys = new Set(["adv_stealRate", "adv_stealInt"]); // added by resolve, not in captures
      for (const k of Object.keys(bag)) if (!derivedVal.has(k)) expect(resolved[k]).toBe(bag[k]);
      expect(Object.keys(resolved).filter((k) => !newKeys.has(k)).sort()).toEqual(Object.keys(bag).filter((k) => !newKeys.has(k)).sort());
    });
  }
});
