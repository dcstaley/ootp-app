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
    const era1 = { ...eraFromCoeffs(bag, "e", "e"), runVal: 1 };
    const era2 = { ...eraFromCoeffs(bag, "e", "e"), runVal: 2 };
    const r1 = resolveCoeffs(model, era1, park, sc);
    const r2 = resolveCoeffs(model, era2, park, sc);
    expect(r1.adv_speed).toBeGreaterThan(0);      // baserunning is now valued (was 0)
    expect(r1.adv_run).toBeGreaterThan(r1.adv_speed); // Baserunning rating weighted above Speed (per the fit)
    expect(r2.adv_speed).toBeCloseTo(r1.adv_speed * 2, 12); // run-scarcity doubles the value
    expect(r2.adv_run).toBeCloseTo(r1.adv_run * 2, 12);
    expect(r1.adv_steal).toBe(0);                 // steal deferred (needs a tendency×ability term)
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
      // adv_speed/adv_run are now DERIVED post-assembly (league-fit baserunning value × era runVal),
      // like era_h_bip — no longer passed through from the bag, so they're excluded from the
      // byte-identity round-trip (the keys still match; only these two values are recomputed).
      const derived = new Set(["adv_speed", "adv_run"]);
      for (const k of Object.keys(bag)) if (!derived.has(k)) expect(resolved[k]).toBe(bag[k]);
      expect(Object.keys(resolved).sort()).toEqual(Object.keys(bag).sort());
    });
  }
});
