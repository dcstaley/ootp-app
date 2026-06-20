// M2 (D4) — splitCoeffs/assembleCoeffs round-trip. Proves the global coeff bag
// decomposes into Era/Park/Softcaps/Model (+ extras) and recomposes with no
// drift, so a captured bag yields reusable library entries. Uses the committed
// _synthetic fixture AND, when present, the local real captures (gitignored).

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { splitCoeffs, assembleCoeffs } from "../src/config/coeff-assembly.ts";
import type { Coeffs } from "../src/scoring-core/index.ts";

function loadCoeffs(file: string): Coeffs {
  return (JSON.parse(readFileSync(file, "utf8")) as { coeffs: Coeffs }).coeffs;
}

const captureDir = "fixtures/captures";
const captures = existsSync(captureDir) ? readdirSync(captureDir).filter((f) => f.endsWith(".json")) : [];

describe("splitCoeffs / assembleCoeffs round-trip", () => {
  for (const f of captures) {
    it(`is lossless for ${f}`, () => {
      const coeffs = loadCoeffs(join(captureDir, f));
      const round = assembleCoeffs(splitCoeffs(coeffs));
      // every original key/value preserved exactly
      for (const k of Object.keys(coeffs)) {
        expect(round[k]).toBe(coeffs[k]);
      }
      // no spurious keys added
      expect(Object.keys(round).sort()).toEqual(Object.keys(coeffs).sort());
    });
  }

  it("routes fields into the expected parts (synthetic)", () => {
    const coeffs = loadCoeffs(join(captureDir, "_synthetic.json"));
    const p = splitCoeffs(coeffs);
    expect(p.era.bb).toBe(coeffs.era_bb);
    expect(p.era.thr_toggle).toBe(coeffs.tournament_hr_adjust);
    expect(p.park.hr_r).toBe(coeffs.park_hr_r);
    expect(p.softcaps.cap_eye_top).toBe(coeffs.cap_eye_top);
    expect(p.model.eyeInt).toBe(coeffs.eyeInt);
    // ssp / splits are not yet categorised → land in extras (holding bucket)
    expect(p.extras.ssp_adv_hitting).toBe(coeffs.ssp_adv_hitting);
    expect(p.extras.r_pitch_split).toBe(coeffs.r_pitch_split);
  });
});
