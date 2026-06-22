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
      for (const k of Object.keys(bag)) expect(resolved[k]).toBe(bag[k]);
      expect(Object.keys(resolved).sort()).toEqual(Object.keys(bag).sort());
    });
  }
});
