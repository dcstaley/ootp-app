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
  RAWPOLY_EYEAUG_HIT, EYEAXIS_KB_HIT, EYEAXIS_KBH_HIT, EYEAXIS_KBH_HBPMEAN_HIT, EYEAXIS_ALL4_HIT,
  hitFormModel, pitFormModel, fitHitForm, fitPitForm, predictHitForm, gateHit, gatePit,
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

  // EYE-AXIS LADDER (2026-07-26). Four legs of one cancellation, added one at a time. The guard
  // that matters is that each rung carries EXACTLY the legs it declares and the deployed form
  // carries NONE — an accidental aux on RAWPOLY_HIT would silently change what we ship.
  it("eye-axis ladder: each rung carries exactly its declared legs; the deployed form carries none", () => {
    const dep = fitHitForm(RAWPOLY_HIT, hitObs);
    expect(dep.k.aux).toBeUndefined(); expect(dep.hr.aux).toBeUndefined();
    expect(dep.h.aux).toBeUndefined(); expect(dep.hbp).toBeUndefined();
    const legs = (f: ReturnType<typeof fitHitForm>) => [!!f.k.aux, !!f.h.aux, !!f.hr.aux, !!f.hbp];
    expect(legs(fitHitForm(RAWPOLY_EYEAUG_HIT, hitObs))).toEqual([true, false, false, false]);
    expect(legs(fitHitForm(EYEAXIS_KB_HIT, hitObs))).toEqual([true, true, false, false]);
    expect(legs(fitHitForm(EYEAXIS_KBH_HIT, hitObs))).toEqual([true, true, true, false]);
    expect(legs(fitHitForm(EYEAXIS_ALL4_HIT, hitObs))).toEqual([true, true, true, true]);
  });

  it("eye-axis ladder: the legs move predictions; the HBP-mean leg is a LEVEL move with a small chain leak", () => {
    const pDep = hitObs.map((o) => predictHitForm(fitHitForm(RAWPOLY_HIT, hitObs), o));
    const pAll = hitObs.map((o) => predictHitForm(fitHitForm(EYEAXIS_ALL4_HIT, hitObs), o));
    expect(Math.max(...pDep.map((p, i) => Math.abs(p - pAll[i]!)))).toBeGreaterThan(1e-5);
    // "mean" fits the HBP CONSTANT — no rating pathway — so ALMOST all of what it does is a level
    // shift every card shares. NOT all: HBP is also in the BIP bookkeeping (BIP = 600 − BB − K −
    // HR − (HBP + SH − SF)), so a lower HBP hands every card more balls in play and hit.h is refit
    // on that column. The leak is per-card and real, but ~2 orders below the level move — which is
    // why this leg is very nearly (not exactly) invisible to the affine-invariant metrics.
    const kbh = fitHitForm(EYEAXIS_KBH_HIT, hitObs), mean = fitHitForm(EYEAXIS_KBH_HBPMEAN_HIT, hitObs);
    const d = hitObs.map((o) => predictHitForm(mean, o) - predictHitForm(kbh, o));
    const level = Math.abs(d.reduce((s, x) => s + x, 0) / d.length), spread = Math.max(...d) - Math.min(...d);
    expect(level).toBeGreaterThan(1e-6);      // a REAL level move (the observed HBP is below 6)
    expect(spread).toBeGreaterThan(0);        // and the BIP chain does leak into the spread
    expect(spread).toBeLessThan(level / 5);   // but the leg is dominated by its level component
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
