// DRIFT GUARD for the deployed pair (2026-07-25).
//
// "Which form does production ship" is a single fact that used to be written down independently
// in every place that claimed to mirror production. The copies drifted, twice on the same file:
// src/training/residuals.ts (the live /api/training/residuals endpoint + the Model-Training
// "where the model misses" view) sat on LOG_PIT, was corrected to STUFFAUG_PIT, and then stayed
// there when the deployed pitcher form moved to PARETO_PIT on 2026-07-14 — so for weeks the page
// answering "where is the model wrong" described a RETIRED model's misses.
//
// The fix is DEPLOYED_FORMS (src/training/forms.ts) as the one record; these tests fail if any
// mirror stops agreeing with it. "Agreeing" means the FIT, not just the name: production always
// hands fitHitForm/fitPitForm a vertex-pin collector, and an unpinned mirror is a different
// model (the parity defect commit 7dea19a fixed for the bake-off wrappers).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fitHitForm, fitPitForm, DEPLOYED_FORMS, RAWPOLY_HIT, PARETO_PIT, type VertexPin } from "../src/training/forms.ts";
import { residualModelFor } from "../src/training/residuals.ts";
import type { TrainObs } from "../src/training/loader.ts";

// Synthetic observations with an ∪-shaped HR channel: the unconstrained quad's vertex lands
// strictly inside the rating domain, so the vertex pin FIRES. That makes the pinned and unpinned
// fits genuinely different here — which is what lets the equality assertions below detect a
// mirror that forgot the collector, instead of passing vacuously on a window where no pin fires.
const hit0 = { PA: 0, AB: 0, H: 0, b1: 0, b2: 0, b3: 0, HR: 0, BB: 0, IBB: 0, HP: 0, SH: 0, SF: 0, K: 0, GIDP: 0 };
const pitch0 = { BF: 0, IP: 0, AB: 0, b1: 0, b2: 0, b3: 0, HR: 0, BB: 0, IBB: 0, K: 0, HP: 0, SH: 0, SF: 0 };

function obsAt(i: number): TrainObs {
  const hrr = 50 + i * 2.5, stu = 80 + (i % 10) * 8, con = 60 + (i % 12) * 10;
  const pbabip = 60 + ((i * 7) % 40) * 2.5;
  const pow = 50 + i * 2.5, eye = 40 + (i % 10) * 10, kRat = 50 + (i % 8) * 12;
  const babip = 60 + ((i * 3) % 40) * 2, gap = 50 + ((i * 11) % 50) * 2;
  const hHR = 40 - 0.002 * (pow - 150) ** 2, hb1 = 90 + 0.2 * babip; // ∩-shaped hitter HR (vertex at POW 150)
  return {
    key: `x${i}|B|R`, cid: `x${i}`, variant: false, side: "R", name: `X${i}`, pos: "SP", bats: 1, throws: 1,
    ratings: { hit: { eye, pow, kRat, babip, gap, speed: 50, steal: 50, run: 50 }, pitch: { con, stu, pbabip, hrr } },
    hit: { ...hit0, PA: 600, AB: 540, H: hb1 + 30 + hHR, b1: hb1, b2: 25, b3: 5, HR: hHR, BB: 20 + 0.3 * eye, K: 150 - 0.4 * kRat },
    pitch: {
      ...pitch0, BF: 600, IP: 150, AB: 550,
      b1: 60 + 0.8 * pbabip + 0.002 * pbabip * pbabip,
      HR: 5 + 0.001 * (hrr - 160) ** 2,                    // ∪-shaped pitcher HR (vertex at HRR 160)
      BB: 90 - 0.25 * con, K: 40 + 0.3 * stu + 0.002 * stu * stu,
    },
    sources: [{ league: "SYN", year: 2042, pa: 600, bf: 600 }],
  };
}
const OBS = Array.from({ length: 60 }, (_, i) => obsAt(i));

describe("DEPLOYED_FORMS — the one record of what production ships", () => {
  it("names the pair the trainer actually fits, and fits it PINNED", () => {
    // Asserting the literal identities here (not just any two forms) is what makes a silent
    // swap of the deployed pair a deliberate, reviewed edit rather than an invisible one.
    expect(DEPLOYED_FORMS.hit).toBe(RAWPOLY_HIT);
    expect(DEPLOYED_FORMS.pit).toBe(PARETO_PIT);
    expect(DEPLOYED_FORMS.pinned).toBe(true); // saveTrainedModel always passes a `vertexPinned` collector
  });

  it("the pin genuinely fires on this fixture (so the equality tests below can't pass vacuously)", () => {
    const pins: VertexPin[] = [];
    fitHitForm(DEPLOYED_FORMS.hit, OBS, 0.75, pins);
    fitPitForm(DEPLOYED_FORMS.pit, OBS, 0.75, pins);
    expect(pins.map((p) => p.channel).sort()).toEqual(["hit.hr", "pit.hr"]);
  });
});

describe("the residual path mirrors production (the drift that started this)", () => {
  // The live endpoint's fit must be BIT-IDENTICAL to the trainer's, per role. This catches both
  // failure modes at once: a wrong FORM (what happened on 2026-07-14) and a missing PIN COLLECTOR
  // (a different model with the right name).
  for (const role of ["hitter", "pitcher"] as const) {
    it(`${role}: analyzeResiduals scores the production fit exactly`, () => {
      const resid = residualModelFor(role).fit(OBS);
      const prod = role === "hitter"
        ? fitHitForm(DEPLOYED_FORMS.hit, OBS, 0.75, [])
        : fitPitForm(DEPLOYED_FORMS.pit, OBS, 0.75, []);
      expect(JSON.stringify(resid)).toBe(JSON.stringify(prod));
    });
  }
});

describe("mirrors that cannot import DEPLOYED_FORMS still agree with it", () => {
  it("server.saveTrainedModel fits DEPLOYED_FORMS, not a form of its own", () => {
    // saveTrainedModel needs a training dir + a live repo, so this is a source assertion rather
    // than a behavioural one: the point is only that the trainer names no form itself.
    const src = readFileSync("src/server/server.ts", "utf8");
    expect(src).toMatch(/fitHitForm\(DEPLOYED_FORMS\.hit,/);
    expect(src).toMatch(/fitPitForm\(DEPLOYED_FORMS\.pit,/);
  });

  it("the Model-Training page's DEPLOYED_*_MODEL names match the deployed pair", () => {
    // The browser bundle must not pull in the trainer, so web/ carries the two scoreboard NAMES
    // as literals. They are a copy, so they get a guard: this is the assertion that would have
    // caught DEPLOYED_PIT_MODEL sitting on "woba" (the retired log-linear parity baseline).
    const web = readFileSync("web/ModelTrainingPage.tsx", "utf8");
    const nameOf = (k: string) => web.match(new RegExp(`const ${k} = "([^"]+)"`))?.[1];
    expect(nameOf("DEPLOYED_HIT_MODEL")).toBe(DEPLOYED_FORMS.hit.name);
    expect(nameOf("DEPLOYED_PIT_MODEL")).toBe(DEPLOYED_FORMS.pit.name);
  });
});
