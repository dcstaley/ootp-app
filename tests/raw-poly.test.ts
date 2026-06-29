// M6 Phase-1 — the deployed #2 (raw-poly) event model behind the EventModel seam
// must reproduce the bake-off model (src/training/forms.ts predictHitForm/predictPitForm)
// when scored through the single core (scoreCard). This is the "one core" check: the
// thing the grid/optimizer/calibration runs == the thing the bake-off validated.
//
// Two levels:
//   A) RAW path (calScales=null → scoreCard returns the raw assembled wOBA): bit-exact
//      to predictHitForm — same curves, same BIP chain, same weights.
//   B) FULL recompute (calScales=identity, neutral era/park → hittingComponents runs):
//      within tol of predictHitForm. The only gap is the recompute's BIP convention
//      (subtracts adv_hbp+adv_sh, no +adv_sf) vs the training BIP (−6−3+4) — a known
//      pre-existing quirk shared with the log path, ~0.001 wOBA.
//
// Parity (eventForm ABSENT) is guarded separately by tests/parity.test.ts.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { loadWindow } from "../src/training/loader.ts";
import {
  RAWPOLY_HIT, RAWPOLY_PIT, LOG_HIT, LOG_PIT,
  fitHitForm, fitPitForm, predictHitForm, predictPitForm,
} from "../src/training/forms.ts";
import type { EventForm } from "../src/model/curves.ts";
import { scoreCard, computeDerived, type Coeffs, type CalScales } from "../src/scoring-core/index.ts";

const DIR = "Model 2037 and 2038";
const WINDOW = [2037, 2038];
const HBP = 6;

// Neutralised env coeffs: era/park all 1, no ssp, adv_hbp=6 / adv_sh=3 — so the
// recompute scaffolding is identity and the only signal is the fitted #2 curves.
function neutralCoeffs(): Coeffs {
  const base = JSON.parse(readFileSync("fixtures/captures/_synthetic.json", "utf8")).coeffs as Coeffs;
  return {
    ...base,
    tournament_hr_adjust: false,
    park_avg_l: 1, park_avg_r: 1, park_hr_l: 1, park_hr_r: 1, park_gap: 1,
    era_bb: 1, era_k: 1, era_avg: 1, era_hr: 1, era_bip: 1, era_gap: 1, era_thr: 1,
    adv_hbp: 6, adv_sh: 3, adv_sf: 4,
    ssp_adv_hitting: 1, ssp_basic_hitting: 1, ssp_basic_pitching: 1,
  };
}

// Build a card (CSV-column shape scoreCard reads) from a TrainObs's ratings; both
// sides identical so woba_vR carries the obs ratings. Right/right, no speed.
function cardFrom(o: any): Record<string, unknown> {
  const h = o.ratings.hit, p = o.ratings.pitch;
  const card: Record<string, unknown> = {
    "Card ID": "synth", "//Card Title": "synth", Bats: 1, Throws: 1,
    Speed: 0, Stealing: 0, Baserunning: 0, Hold: 0, GB: 2,
  };
  for (const side of ["vR", "vL"]) {
    card[`Eye ${side}`] = h.eye; card[`Power ${side}`] = h.pow; card[`Avoid K ${side}`] = h.kRat;
    card[`BABIP ${side}`] = h.babip; card[`Gap ${side}`] = h.gap;
    card[`Control ${side}`] = p.con; card[`Stuff ${side}`] = p.stu; card[`pBABIP ${side}`] = p.pbabip; card[`pHR ${side}`] = p.hrr;
  }
  return card;
}

const IDENTITY: CalScales = {
  hitBBScaleVR: 1, hitBBScaleVL: 1, hitHRScaleVR: 1, hitHRScaleVL: 1, hitScaleVR: 1, hitScaleVL: 1,
  pBBScaleVR: 1, pBBScaleVL: 1, pHRScaleVR: 1, pHRScaleVL: 1, pitchScaleVR: 1, pitchScaleVL: 1,
  ssp_adv_hitting: 1, ssp_basic_pitching: 1,
};

describe.skipIf(!existsSync(DIR))("raw-poly (#2) integration — deployed model == bake-off model", () => {
  const { observations } = loadWindow(DIR, WINDOW);
  const hitObs = observations.filter((o) => o.hit.PA >= 1000);
  const pitObs = observations.filter((o) => o.pitch.BF >= 1000);
  const fit: EventForm = { hit: fitHitForm(RAWPOLY_HIT, hitObs), pit: fitPitForm(RAWPOLY_PIT, pitObs) };
  const coeffs = neutralCoeffs();
  const derived = computeDerived(coeffs);

  it("derived era factors are exactly neutral (era_h = era_effective_hr = 1)", () => {
    expect(Math.abs(derived.era_h - 1)).toBeLessThan(1e-12);
    expect(Math.abs(derived.era_effective_hr - 1)).toBeLessThan(1e-12);
  });

  it("A) hitting RAW path (calScales=null) reproduces predictHitForm bit-exactly", () => {
    let worst = 0;
    for (const o of hitObs) {
      const s = scoreCard(cardFrom(o), { coeffs, derived, calScales: null, eventForm: fit });
      const ref = predictHitForm(fit.hit, o);
      worst = Math.max(worst, Math.abs(s.hit.woba_vR - ref));
    }
    expect(worst).toBeLessThan(1e-9);
  });

  it("A) pitching RAW path reproduces predictPitForm (+ the raw-assembly HBP term)", () => {
    // predictPitForm omits the 0.704·HBP term that assembleRawPitchingWoba includes;
    // matching after that constant offset proves the raw pitching events are identical.
    const offset = (0.704 * HBP) / 600;
    let worst = 0;
    for (const o of pitObs) {
      const s = scoreCard(cardFrom(o), { coeffs, derived, calScales: null, eventForm: fit });
      const ref = predictPitForm(fit.pit, o) + offset;
      worst = Math.max(worst, Math.abs(s.pitch.woba_vR - ref));
    }
    expect(worst).toBeLessThan(1e-9);
  });

  it("B) hitting FULL recompute (neutral env, identity scales) matches predictHitForm within tol", () => {
    let worst = 0;
    for (const o of hitObs) {
      const s = scoreCard(cardFrom(o), { coeffs, derived, calScales: IDENTITY, eventForm: fit });
      worst = Math.max(worst, Math.abs(s.hit.woba_vR - predictHitForm(fit.hit, o)));
    }
    // Only the BIP convention (adv_sf=4) separates the recompute from the training fit.
    expect(worst).toBeLessThan(3e-3);
  });

  it("the #2 path actually departs from the log-linear default (eventForm changes scores)", () => {
    const logFit: EventForm = { hit: fitHitForm(LOG_HIT, hitObs), pit: fitPitForm(LOG_PIT, pitObs) };
    let maxDiff = 0;
    for (const o of hitObs.slice(0, 40)) {
      const withForm = scoreCard(cardFrom(o), { coeffs, derived, calScales: IDENTITY, eventForm: fit });
      const noForm = scoreCard(cardFrom(o), { coeffs, derived, calScales: IDENTITY }); // log-linear default
      maxDiff = Math.max(maxDiff, Math.abs(withForm.hit.woba_vR - noForm.hit.woba_vR));
      // sanity: an all-log eventForm and the #2 eventForm differ on the power events
      void logFit;
    }
    expect(maxDiff).toBeGreaterThan(1e-3);
  });
});
