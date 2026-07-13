// INTEGRATION guard for the era trilogy (era_h_bip · era_gap_share · era_bip_adj) THROUGH the
// scoring-core recompute. The existing era tests (era-h-bip / era-gap-share / era-bip-adj) are
// RESOLVER-ONLY — they check the factors derived from the rates block, but NOT that woba.ts's
// hittingComponents applies each factor to the right quantity. A misplaced multiply inside
// hittingComponents (e.g. era_bip_adj on the wrong term, era_gap on 1B instead of XBH) would pass
// all of those. This test runs a fixed card through hittingComponents at era-1920 (dead-ball, where
// all three factors are non-trivial: era_h_bip≈0.974, era_bip_adj≈2.4, era_gap_share≠1) and pins the
// full chain against an INDEPENDENT re-derivation assembled from the low-level primitives.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { hittingComponents } from "../src/scoring-core/woba.ts";
import { computeDerived, makeRawPolyModel } from "../src/scoring-core/index.ts";
import { eraHBip, eraGapShare, eraBipAdj } from "../src/config/coeff-resolve.ts";
import { hRate, rate, HIT_BIP_ADJ, type EventForm } from "../src/model/curves.ts";
import { cp } from "../src/scoring-core/helpers.ts";
import { loadWindow } from "../src/training/loader.ts";
import { fitHitForm, fitPitForm, RAWPOLY_HIT, RAWPOLY_PIT } from "../src/training/forms.ts";
import type { Coeffs } from "../src/config/types.ts";
import type { Era } from "../src/config/tournament.ts";

const TRAIN = "Model 2037 and 2038";
const era = (id: string): Era => JSON.parse(readFileSync(`data/eras/${id}.json`, "utf8"));

// era-1920 coeffs, park-neutral, resolved exactly as resolveCoeffs would from the rates block.
function era1920Coeffs(): Coeffs {
  const e = era("era-1920");
  const r = e.rates!;
  return {
    era_bb: e.bb, era_k: e.k, era_hr: e.hr, era_avg: e.avg, era_gap: e.gap, era_thr: 1,
    era_h_bip: eraHBip(r), era_gap_share: eraGapShare(r), era_bip_adj: eraBipAdj(r),
    tournament_hr_adjust: false,
    park_avg_l: 1, park_avg_r: 1, park_hr_l: 1, park_hr_r: 1, park_gap: 1,
    adv_hbp: 6, adv_sh: 3, adv_sf: 4,
  } as Coeffs;
}

describe.skipIf(!existsSync(TRAIN))("hittingComponents — era-1920 integration (era trilogy applied correctly)", () => {
  const { observations } = loadWindow(TRAIN, [2037, 2038]);
  const form: EventForm = {
    hit: fitHitForm(RAWPOLY_HIT, observations.filter((o) => o.hit.PA >= 1000)),
    pit: fitPitForm(RAWPOLY_PIT, observations.filter((o) => o.pitch.BF >= 1000)),
  };
  const model = makeRawPolyModel(form);
  const coeffs = era1920Coeffs();
  const derived = computeDerived(coeffs, true);
  const bats = 1, side = "vR" as const;
  // A fixed mid-range hitter; raw predicted events feed the recompute.
  const e = model.predictHitting({ eye: 110, pow: 120, kRat: 100, babip: 105, gap: 108, speed: 0, steal: 0, run: 0 }, coeffs);
  const k = hittingComponents(e, 1, 1, bats, side, coeffs, derived, form);

  it("BB_fin = raw BB × era_bb (no park on BB) — catches a misplaced era_bb multiply", () => {
    expect(k.BB_fin).toBeCloseTo(e.BB * coeffs.era_bb, 9);
  });

  it("HR_fin = raw HR × era_effective_hr (park-neutral) — catches a misplaced era_hr multiply", () => {
    expect(k.HR_fin).toBeCloseTo(e.HR * derived.era_effective_hr, 9);
  });

  it("the full non-HR-hit chain matches an independent re-derivation (BIP→BA→GAP→1B)", () => {
    // Independent re-derivation — the KNOWN-CORRECT arrangement of the primitives, assembled in
    // this file so a misplaced multiply inside woba.ts diverges from it.
    const BB_fin = e.BB * coeffs.era_bb;
    const SO_fin = e.SO * coeffs.era_k;
    const HR_fin = e.HR * derived.era_effective_hr;
    const BIP_fin = Math.max(600 - BB_fin - SO_fin - HR_fin - HIT_BIP_ADJ * derived.era_bip_adj, 1);
    const BA_fin = hRate(form.hit.h, e.babipSC, BIP_fin) * derived.era_h; // parkAvg = 1
    const GAP_fin = Math.max(rate(form.hit.xbh, e.gapSC) * BA_fin * derived.era_gap * cp(coeffs.park_gap), 0);
    const oneB_fin = Math.max(BA_fin - GAP_fin, 0);
    expect(k.GAP_fin).toBeCloseTo(GAP_fin, 9);
    expect(k.oneB_fin).toBeCloseTo(oneB_fin, 9);
  });

  it("era_bip_adj actually flows into BIP (dead-ball scale ≠ 1 moves the hit rate)", () => {
    // Force era_bip_adj → 1 and the hits must change — proves the scale is wired into the recompute
    // (not silently dropped). era-1920's scale ≈ 2.4, so this is a large, unambiguous move.
    const derivedOff = { ...derived, era_bip_adj: 1 };
    const kOff = hittingComponents(e, 1, 1, bats, side, coeffs, derivedOff, form);
    expect(derived.era_bip_adj).toBeGreaterThan(2); // sanity: dead-ball scale is large
    expect(kOff.oneB_fin + kOff.GAP_fin).not.toBeCloseTo(k.oneB_fin + k.GAP_fin, 3);
  });
});
