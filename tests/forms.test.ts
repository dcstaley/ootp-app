// M6 — D3 bake-off form engine. The generic basis-driven chain (forms.ts) must
// reproduce the parity log-linear assembly (bakeoff.ts wobaHitting/wobaPitching)
// bit-for-bit when every event uses the log curve — the regression guard for the
// refactor. Plus light sanity on candidate #2 (rawpoly) and the monotonicity gate.

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { loadWindow } from "../src/training/loader.ts";
import { wobaHitting, wobaPitching } from "../src/training/bakeoff.ts";
import {
  LOG_HIT, LOG_PIT, RAWPOLY_HIT, RAWPOLY_PIT, LOGCUBIC_HIT, RAWCUBIC_HIT,
  hitFormModel, pitFormModel, fitHitForm, fitPitForm, gateHit, gatePit,
  fitHitGLM, predictHitGLM, fitPitGLM, gateGLMHit, gateGLMPit,
  fitHitSeq, predictHitSeq, fitPitSeq, gateSeqHit, gateSeqPit,
} from "../src/training/forms.ts";
import { actualHitWoba } from "../src/training/bakeoff.ts";
import { wPearson } from "../src/training/metrics.ts";

const DIR = "Model 2037 and 2038";
const WINDOW = [2037, 2038];

describe.skipIf(!existsSync(DIR))("forms — log curve reproduces the parity woba assembly", () => {
  const { observations } = loadWindow(DIR, WINDOW);
  const hitObs = observations.filter((o) => o.hit.PA >= 1000);
  const pitObs = observations.filter((o) => o.pitch.BF >= 1000);

  it("hitting: log form === wobaHitting per-obs (bit-level)", () => {
    const logModel = hitFormModel(LOG_HIT);
    const logPred = logModel.predict(logModel.fit(hitObs), hitObs);
    const refPred = wobaHitting.predict(wobaHitting.fit(hitObs), hitObs);
    expect(logPred.length).toBe(refPred.length);
    logPred.forEach((p, i) => expect(Math.abs(p - refPred[i]!)).toBeLessThan(1e-9));
  });

  it("pitching: log form === wobaPitching per-obs (bit-level)", () => {
    const logModel = pitFormModel(LOG_PIT);
    const logPred = logModel.predict(logModel.fit(pitObs), pitObs);
    const refPred = wobaPitching.predict(wobaPitching.fit(pitObs), pitObs);
    expect(logPred.length).toBe(refPred.length);
    logPred.forEach((p, i) => expect(Math.abs(p - refPred[i]!)).toBeLessThan(1e-9));
  });

  it("rawpoly (#2) actually departs from the log baseline", () => {
    const log = hitFormModel(LOG_HIT), raw = hitFormModel(RAWPOLY_HIT);
    const lp = log.predict(log.fit(hitObs), hitObs), rp = raw.predict(raw.fit(hitObs), hitObs);
    const maxDiff = Math.max(...lp.map((p, i) => Math.abs(p - rp[i]!)));
    expect(maxDiff).toBeGreaterThan(1e-4); // the HR/XBH curves must change something
  });

  it("cubic-in-log (#1) departs from the log baseline (higher-order log terms bite)", () => {
    const log = hitFormModel(LOG_HIT), cub = hitFormModel(LOGCUBIC_HIT);
    const lp = log.predict(log.fit(hitObs), hitObs), cp = cub.predict(cub.fit(hitObs), hitObs);
    expect(Math.max(...lp.map((p, i) => Math.abs(p - cp[i]!)))).toBeGreaterThan(1e-4);
  });

  it("gate runs and returns a defined status for every candidate form", () => {
    for (const m of [RAWPOLY_HIT, LOGCUBIC_HIT, RAWCUBIC_HIT]) expect(["pass", "warn"]).toContain(gateHit(fitHitForm(m, hitObs), hitObs).status);
    expect(["pass", "warn"]).toContain(gatePit(fitPitForm(RAWPOLY_PIT, pitObs), pitObs).status);
  });

  it("count GLM (#8): Poisson IRLS converges, fits the data, and passes the gate", () => {
    const params = fitHitGLM(hitObs, false);
    // every fitted coefficient is finite (IRLS didn't diverge)
    expect(Object.values(params).flat().every((b) => Number.isFinite(b))).toBe(true);
    const pred = hitObs.map((o) => predictHitGLM(params, o));
    const r = wPearson(pred, hitObs.map(actualHitWoba), hitObs.map((o) => Math.pow(o.hit.PA, 0.75)));
    expect(r).toBeGreaterThan(0.7); // a sane in-sample fit
    // power-law events are monotone by construction → gate passes for both roles
    expect(gateGLMHit(params, hitObs).status).toBe("pass");
    expect(gateGLMPit(fitPitGLM(pitObs, false), pitObs).status).toBe("pass");
  });

  it("negative-binomial differs from Poisson (dispersion reweights the fit)", () => {
    const pois = fitHitGLM(hitObs, false), nb = fitHitGLM(hitObs, true);
    const dp = pois.hr.reduce((s, b, j) => s + Math.abs(b - nb.hr[j]!), 0);
    expect(dp).toBeGreaterThan(0); // θ is finite for overdispersed counts → coefficients move
  });

  it("sequential conditional (#6): logistic IRLS fits, predicts sane wOBA, passes the gate", () => {
    const m = fitHitSeq(hitObs);
    expect(Object.values(m).flat().every((b) => Number.isFinite(b))).toBe(true);
    const pred = hitObs.map((o) => predictHitSeq(m, o));
    expect(pred.every((w) => w > 0.15 && w < 0.6)).toBe(true); // wOBA in a plausible band
    const r = wPearson(pred, hitObs.map(actualHitWoba), hitObs.map((o) => Math.pow(o.hit.PA, 0.75)));
    expect(r).toBeGreaterThan(0.7);
    // every stage is a monotone logit (logistic of log-linear) → gate passes both roles
    expect(gateSeqHit(m, hitObs).status).toBe("pass");
    expect(gateSeqPit(fitPitSeq(pitObs), pitObs).status).toBe("pass");
  });
});
