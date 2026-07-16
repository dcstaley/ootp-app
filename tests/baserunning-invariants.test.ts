// Regression guards for the three baserunning (BsR) bugs fixed in 5e16f2d / c489e6e — all
// three shipped without a test, so this file pins the STRUCTURE of how BsR enters a score:
//
//   1. CENTERING  — BsR must be centered on the mean over HITTERS (Position != "1"). Uncentered,
//      every hitter got the whole pool center as a universal uplift (≈ +9.4 mwOBA — brCenterHit
//      itself); centered on the WHOLE pool instead (pitchers barely run) it's a smaller but same-
//      signed uplift (≈ +2.9 mwOBA here). Guarded: hitter-pool mean ≈ 0 AND the spread survives
//      (a zeroed-out term would also have mean 0 — hence the spread + sign assertions).
//   2. ANCHOR INVARIANCE — the anchor/calibration is BATTING-ONLY: it must select its top-50
//      and normalize on batting alone, so toggling BsR cannot move sFinal. The bug: selection
//      used Offense (batting+BsR), normalization used batting → BsR leaked into sFinal.
//   3. OUTSIDE sFinal — BsR is added AFTER the batting calibration correction
//      (battingWoba·sFinal + brBonus), never inside it. The bug rode BsR through sFinal
//      (~1.15 at bronze vs ~1.02 neutral) ⇒ tier-dependent inflation of a term that is
//      already in real wOBA units.
//
// Fixtures: the committed _synthetic capture (coeffs) + docs/pt_card_list.csv (the authoritative
// real card list). The synthetic bag carries adv_speed/adv_run = 0, so the coeffs are RESOLVED
// through resolveCoeffs (the production path) to get the league-fit baserunning weights.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import Papa from "papaparse";
import { calibrate, computeDerived, scoreCard, type Coeffs, type CalScales } from "../src/scoring-core/index.ts";
import { hittingBsr, baserunningWoba, trustedHittingWoba, assembleRawHittingWoba } from "../src/scoring-core/woba.ts";
import { resolveCoeffs, modelFromCoeffs, eraFromCoeffs, parkFromCoeffs, softcapsFromCoeffs } from "../src/config/coeff-resolve.ts";
import { makeRawPolyModel } from "../src/model/raw-poly.ts";
import type { EventForm } from "../src/model/curves.ts";
import { n, sameSidePenaltyHitting } from "../src/scoring-core/helpers.ts";

const base = JSON.parse(readFileSync("fixtures/captures/_synthetic.json", "utf8")).coeffs as Coeffs;
// Production resolve path ⇒ real league-fit baserunning coeffs (neutral era scaling).
const coeffs = resolveCoeffs(
  modelFromCoeffs(base, "m", "m"),
  { ...eraFromCoeffs(base, "e", "e"), runVal: 1, sbFreq: 1 },
  parkFromCoeffs(base, "p", "p"),
  softcapsFromCoeffs(base),
);
const derived = computeDerived(coeffs);
const cards = Papa.parse(readFileSync("docs/pt_card_list.csv", "utf8"), { header: true, skipEmptyLines: true })
  .data as any[];
// The DEPLOYED raw-poly form when the (gitignored) active model is present locally; otherwise the
// no-eventForm path. Every invariant below is model-independent — BsR sits outside the event model.
const eventForm: EventForm | undefined = existsSync("fixtures/eventform-active.json")
  ? (JSON.parse(readFileSync("fixtures/eventform-active.json", "utf8")).eventForm as EventForm)
  : undefined;

const isHitter = (c: any) => String(c["Position"] ?? "") !== "1";
const brOf = (c: any) => baserunningWoba(n(c["Speed"]), n(c["Steal Rate"]), n(c["Stealing"]), n(c["Baserunning"]), coeffs);
const bsrOf = (c: any, cs: CalScales) => hittingBsr(n(c["Speed"]), n(c["Steal Rate"]), n(c["Stealing"]), n(c["Baserunning"]), coeffs, cs);
const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a: number[]) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
const MW = 1000; // wOBA → mwOBA (milli-wOBA), the unit the bug reports are written in

const config = { coeffs, derived, eventForm };
const scales = calibrate(cards, config);
const hitters = cards.filter(isHitter);

describe("BsR invariant 1 — centered on the HITTER pool mean (bug: universal +9 mwOBA uplift)", () => {
  const bsr = hitters.map((c) => bsrOf(c, scales));

  it("the mean BsR over HITTERS is ~0 (that IS the center; pitchers excluded)", () => {
    // Uncentered this reads ≈ +9.4 mwOBA (the reported bug); centered on the whole pool ≈ +2.9.
    expect(Math.abs(mean(bsr)) * MW).toBeLessThan(1.5); // stated tolerance
    expect(Math.abs(mean(bsr))).toBeLessThan(1e-12);    // and in fact it's the exact center
  });

  it("the spread survives centering, signed BOTH ways (a zeroed term would also mean ~0)", () => {
    // Observed: sd ≈ 4.0 mwOBA, range ≈ [−9.0, +16.3], 1038 negative / 853 positive of 1891.
    expect(bsr.filter((x) => x < 0).length).toBeGreaterThan(hitters.length * 0.2);
    expect(bsr.filter((x) => x > 0).length).toBeGreaterThan(hitters.length * 0.2);
    expect(sd(bsr) * MW).toBeGreaterThan(2);        // real dispersion, not a constant
    expect(Math.min(...bsr) * MW).toBeLessThan(-3); // real negatives (bad baserunners LOSE value)
    expect(Math.max(...bsr) * MW).toBeGreaterThan(3);
  });

  it("centering on the WHOLE pool (the bug) would uplift every hitter — the filter is load-bearing", () => {
    const wholePoolCenter = mean(cards.map(brOf));
    const upliftMw = (scales.brCenterHit! - wholePoolCenter) * MW;
    // ≈ +2.9 mwOBA on this fixture pool at neutral era scaling (runVal=sbFreq=1); the ~+9.4 in the
    // bug report is the same defect on the real pool + era, where runVal/sbFreq scale BsR up.
    expect(upliftMw).toBeGreaterThan(2); // pitchers drag the center down ⇒ hitters read falsely positive
    // …and the pitchers we exclude really are the bottom of the running distribution.
    expect(mean(cards.filter((c) => !isHitter(c)).map((c) => bsrOf(c, scales)))).toBeLessThan(0);
  });
});

describe("BsR invariant 2 — the anchor/calibration is batting-only (bug: BsR moved sFinal)", () => {
  // Toggle BsR off at the coeff level (the only place BsR enters the wOBA path).
  const offCoeffs: Coeffs = { ...coeffs, adv_speed: 0, adv_run: 0, adv_steal: 0, adv_stealRate: 0, adv_stealInt: 0 };
  const off = calibrate(cards, { coeffs: offCoeffs, derived: computeDerived(offCoeffs), eventForm });

  it("the toggle is real (non-vacuous): BsR-off zeroes the pool center", () => {
    expect(Math.abs(scales.brCenterHit!)).toBeGreaterThan(1e-4);
    expect(off.brCenterHit).toBe(0);
  });

  it("anchor means and sFinal are IDENTICAL with BsR on vs off", () => {
    for (const k of ["anchorMeanVR", "anchorMeanVL", "hitScaleVR", "hitScaleVL"] as const) {
      expect(Math.abs((scales[k] as number) - (off[k] as number))).toBeLessThan(1e-12);
    }
  });

  it("the anchor's raw wOBA (its top-50 SELECTOR) carries no BsR at all", () => {
    // Bug 3 selected the top-50 on Offense but normalized on batting → toggling BsR reshuffled
    // the anchor set. The raw assembly the anchor sorts on must be batting-only for any card.
    const model = eventForm ? makeRawPolyModel(eventForm) : undefined;
    if (!model) return;
    for (const c of hitters.slice(0, 200)) {
      const speed = n(c["Speed"]), steal = n(c["Stealing"]), run = n(c["Baserunning"]);
      const e = model.predictHitting({
        eye: n(c["Eye vR"]), pow: n(c["Power vR"]), kRat: n(c["Avoid K vR"]),
        babip: n(c["BABIP vR"]), gap: n(c["Gap vR"]), speed, steal, run,
      }, coeffs);
      const ssp = sameSidePenaltyHitting(n(c["Bats"]), "vR", 1);
      const withBr = assembleRawHittingWoba(e, ssp, speed, n(c["Steal Rate"]), steal, run, coeffs);
      const battingOnly = assembleRawHittingWoba(e, ssp, 0, 0, 0, 0, coeffs);
      // calibrate() must feed the anchor the battingOnly form — proven by the identity above;
      // here we pin that the two DO differ, so passing the wrong one would be caught.
      if (Math.abs(brOf(c)) > 1e-6) expect(Math.abs(withBr - battingOnly)).toBeGreaterThan(0);
    }
  });
});

describe("BsR invariant 3 — added OUTSIDE sFinal (bug: tier-dependent BsR inflation)", () => {
  // Two tournaments that differ ONLY in the batting calibration correction. The bronze-tier
  // sFinal is taken from a real calibration over a weakened (bronze-like) pool, so the spread
  // is the production one, not an invented constant.
  const weakPool = cards.map((c) => {
    const o: any = { ...c };
    for (const k of Object.keys(o)) if (/^(Eye|Power|Avoid K|BABIP|Gap) v[RL]$/.test(k)) o[k] = Math.round(n(o[k]) * 0.8);
    return o;
  });
  const weak = calibrate(weakPool, config);
  const bronze: CalScales = { ...scales, hitScaleVR: weak.hitScaleVR, hitScaleVL: weak.hitScaleVL };
  const ratio = bronze.hitScaleVR! / scales.hitScaleVR!;

  it("the two tournaments' sFinal really differ (non-vacuous)", () => {
    expect(ratio).toBeGreaterThan(1.05);
  });

  it("the BsR contribution is IDENTICAL across tiers; only the batting part scales", () => {
    let worstBsrDrift = 0, worstRatioDev = 0, smallestBattingMove = Infinity;
    for (const c of hitters.slice(0, 500)) {
      if (Math.abs(brOf(c)) < 1e-6) continue;
      const a = scoreCard(c, { ...config, calScales: scales });
      const b = scoreCard(c, { ...config, calScales: bronze });
      // offense − woba is the BsR term: same real wOBA units in both tournaments.
      worstBsrDrift = Math.max(worstBsrDrift, Math.abs((a.hit.offense_vR - a.hit.woba_vR) - (b.hit.offense_vR - b.hit.woba_vR)));
      // …while batting-only wOBA scales EXACTLY by the sFinal ratio. This is the assertion that
      // fails if BsR rides inside sFinal: woba would then carry bsr·(sFinal−1).
      worstRatioDev = Math.max(worstRatioDev, Math.abs(b.hit.woba_vR / a.hit.woba_vR - ratio));
      smallestBattingMove = Math.min(smallestBattingMove, Math.abs(b.hit.woba_vR - a.hit.woba_vR));
    }
    expect(worstBsrDrift).toBeLessThan(1e-12);
    expect(worstRatioDev).toBeLessThan(1e-12);
    expect(smallestBattingMove * MW).toBeGreaterThan(1); // the batting part DID move (non-vacuous)
  });

  it("trustedHittingWoba is affine in sFinal with the BsR bonus as the intercept", () => {
    const model = eventForm ? makeRawPolyModel(eventForm) : undefined;
    if (!model) return;
    for (const c of hitters.slice(0, 200)) {
      const speed = n(c["Speed"]), steal = n(c["Stealing"]), run = n(c["Baserunning"]), sr = n(c["Steal Rate"]);
      if (Math.abs(brOf(c)) < 1e-6) continue;
      const bats = n(c["Bats"]);
      const e = model.predictHitting({
        eye: n(c["Eye vR"]), pow: n(c["Power vR"]), kRat: n(c["Avoid K vR"]),
        babip: n(c["BABIP vR"]), gap: n(c["Gap vR"]), speed, steal, run,
      }, coeffs);
      const raw = assembleRawHittingWoba(e, 1, speed, sr, steal, run, coeffs);
      const at = (s: number) => trustedHittingWoba(
        e, raw, bats, "vR", coeffs, derived, { ...scales, hitScaleVR: s }, eventForm, speed, sr, steal, run,
      );
      const s1 = 1.151, s2 = 1.024; // the real bronze/neutral spread from the bug report
      // Solve the two-point line: slope = the batting wOBA, intercept = the BsR bonus.
      const battingImplied = (at(s1) - at(s2)) / (s1 - s2);
      const bsrImplied = at(s1) - battingImplied * s1;
      expect(Math.abs(bsrImplied - bsrOf(c, scales))).toBeLessThan(1e-12);
    }
  });
});
