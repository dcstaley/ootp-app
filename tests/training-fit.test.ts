// M6 — parity test for the per-event model fit. The old app's `trained_models.json`
// "37-38" woba_hitting model was fit on this same neutral-environment dataset
// (minPA=1000); our port must reproduce its coefficients.

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { loadTrainingDir } from "../src/training/loader.ts";
import { trainWobaHitting } from "../src/training/fit.ts";

const DIR = "Model 2037 and 2038";

// Oracle: trained_models.json "37-38" woba_hitting (C:\ootp_app\backend).
const ORACLE = {
  rowCount: 159,
  bb: { intercept: -160.27892235728777, eye: 45.13218230541101 },
  k: { intercept: 546.4189751104443, k: -90.84705642616986 },
  hr: { intercept: -43.5802955986308, pow: 12.627006049066486 },
  h: { intercept: -713.6094975843864, ba: 28.363820822264593, bipba: 116.84194132448617 },
  xbh: { logA: -0.5429438609501159, logB: 0.17009373283502627 },
  leagueNorm: { bb: 0.989556, k: 1.001195, hr: 0.982529, h: 0.996074, xbh: 0.997353 },
};

describe.skipIf(!existsSync(DIR))("trainWobaHitting — parity vs old trainer", () => {
  const { observations } = loadTrainingDir(DIR);
  const fit = trainWobaHitting(observations, 1000);
  const c = fit.coefficients;
  // Regression coefficients are exact maths on the same data → very tight tolerance.
  const near = (a: number, b: number, tol = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(tol);

  it("matches the oracle row count (grouping coincides)", () => {
    expect(fit.rowCount).toBe(ORACLE.rowCount);
  });
  it("reproduces the BB / K / HR coefficients", () => {
    near(c.bb.intercept, ORACLE.bb.intercept); near(c.bb.eye, ORACLE.bb.eye);
    near(c.k.intercept, ORACLE.k.intercept); near(c.k.k, ORACLE.k.k);
    near(c.hr.intercept, ORACLE.hr.intercept); near(c.hr.pow, ORACLE.hr.pow);
  });
  it("reproduces the H (non-HR hits) and XBH coefficients", () => {
    near(c.h.intercept, ORACLE.h.intercept); near(c.h.ba, ORACLE.h.ba); near(c.h.bipba, ORACLE.h.bipba);
    near(c.xbh.logA, ORACLE.xbh.logA); near(c.xbh.logB, ORACLE.xbh.logB);
  });
  it("reproduces the league-norm scales (6-dp rounded)", () => {
    near(c.leagueNorm.bb, ORACLE.leagueNorm.bb, 5e-7);
    near(c.leagueNorm.k, ORACLE.leagueNorm.k, 5e-7);
    near(c.leagueNorm.hr, ORACLE.leagueNorm.hr, 5e-7);
    near(c.leagueNorm.h, ORACLE.leagueNorm.h, 5e-7);
    near(c.leagueNorm.xbh, ORACLE.leagueNorm.xbh, 5e-7);
  });
  it("produces sane diagnostics (per-event r² in [0,1])", () => {
    for (const ev of ["bb", "k", "hr", "h", "xbh"]) {
      expect(fit.diagnostics[ev]!.r2!).toBeGreaterThan(0);
      expect(fit.diagnostics[ev]!.r2!).toBeLessThanOrEqual(1);
    }
  });
});
