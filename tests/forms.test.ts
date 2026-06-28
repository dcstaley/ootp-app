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
} from "../src/training/forms.ts";

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
});
