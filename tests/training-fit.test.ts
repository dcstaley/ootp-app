// M6 — parity test for the per-event model fit. The old app's `trained_models.json`
// "37-38" woba_hitting model was fit on this same neutral-environment dataset
// (minPA=1000); our port must reproduce its coefficients.

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { loadTrainingDir } from "../src/training/loader.ts";
import { trainWobaHitting, trainWobaPitching, trainBasicHitting, trainBasicPitching } from "../src/training/fit.ts";

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

// Oracle: "37-38" woba_pitching (minBF=1000).
const ORACLE_P = {
  rowCount: 129,
  bb: { intercept: 262.7588424534687, con: -46.62850372855541 },
  k: { intercept: -138.5679986653758, stu: 53.983051661947705 },
  hr: { intercept: 84.68888507055685, hrr: -14.686153600012728 },
  h: { intercept: -497.07228036869134, pbabip: -15.500531653947304, bip: 115.57741562275744 },
  leagueNorm: { bb: 0.977922, k: 1.003271, hr: 0.988549, h: 0.986275, xbh: 0.984286 },
};
describe.skipIf(!existsSync(DIR))("trainWobaPitching — parity vs old trainer", () => {
  const { observations } = loadTrainingDir(DIR);
  const fit = trainWobaPitching(observations, 1000);
  const c = fit.coefficients;
  const near = (a: number, b: number, tol = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(tol);
  it("matches the oracle row count (129)", () => expect(fit.rowCount).toBe(ORACLE_P.rowCount));
  it("reproduces BB / K / HR coefficients", () => {
    near(c.bb.intercept, ORACLE_P.bb.intercept); near(c.bb.con, ORACLE_P.bb.con);
    near(c.k.intercept, ORACLE_P.k.intercept); near(c.k.stu, ORACLE_P.k.stu);
    near(c.hr.intercept, ORACLE_P.hr.intercept); near(c.hr.hrr, ORACLE_P.hr.hrr);
  });
  it("reproduces the H (non-HR hits allowed) coefficients", () => {
    near(c.h.intercept, ORACLE_P.h.intercept); near(c.h.pbabip, ORACLE_P.h.pbabip); near(c.h.bip, ORACLE_P.h.bip);
  });
  it("reproduces the league-norm scales", () => {
    near(c.leagueNorm.bb, ORACLE_P.leagueNorm.bb, 5e-7); near(c.leagueNorm.k, ORACLE_P.leagueNorm.k, 5e-7);
    near(c.leagueNorm.hr, ORACLE_P.leagueNorm.hr, 5e-7); near(c.leagueNorm.h, ORACLE_P.leagueNorm.h, 5e-7);
    near(c.leagueNorm.xbh, ORACLE_P.leagueNorm.xbh, 5e-7);
  });
});

// Oracle: "37-38" basic models (intercept clamped to 0). Jacobi solver → looser tol.
describe.skipIf(!existsSync(DIR))("basic models — parity vs old trainer", () => {
  const { observations } = loadTrainingDir(DIR);
  const near = (a: number, b: number, tol = 1e-5) => expect(Math.abs(a - b)).toBeLessThan(tol);
  it("trainBasicHitting reproduces the weight coefficients", () => {
    const c = trainBasicHitting(observations, 1000).coefficients;
    expect(c.basic_intercept).toBe(0); // negative intercept clamped
    near(c.w_babip, 13.109641222522812); near(c.w_pow, 12.468767521068079);
    near(c.w_eye, 12.2203409552218); near(c.w_k, 14.8920049520125); near(c.w_gap, 5.390092995993487);
  });
  it("trainBasicPitching reproduces the weight coefficients", () => {
    const c = trainBasicPitching(observations, 1000).coefficients;
    expect(c.basic_intercept).toBe(0);
    near(c.p_stuff, 14.23917960232144); near(c.p_control, 14.816672536446086);
    near(c.p_babip, 8.075912036489093); near(c.p_hr, 15.933055873479155);
  });
});
