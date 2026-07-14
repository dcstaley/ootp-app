// SP-1 spike: reproduce the old backend calcAnchorWoba / evScale calibration
// from our own core, and compare to the captured calScales. Determines whether
// we can reconstruct the anchor pool without the tournament's eligibility rules.
//
// calcAnchorWoba quirks (vs the display getHittingScore): NO ssp, NO 0.704*hbp
// term in the wOBA numerator (hbp still used in the BIP subtraction).

import { readFileSync } from "node:fs";
import Papa from "papaparse";
import { logLinearModel } from "../src/model/log-linear.ts";
import { assembleRawHittingWoba, assembleRawPitchingWoba } from "../src/scoring-core/woba.ts";
import { computeDerived } from "../src/config/derived.ts";
import { n, cp, getParkFactor, sameSidePenaltyHitting, sameSidePenaltyPitching } from "../src/scoring-core/helpers.ts";
import { calibrate } from "../src/scoring-core/calibrate.ts";
import type { Coeffs, Derived } from "../src/config/types.ts";

const captureName = process.argv[2] ?? "real-parkera";
const cap = JSON.parse(readFileSync(`fixtures/captures/${captureName}.json`, "utf8")) as { coeffs: Coeffs; calScales: any };
const coeffs = cap.coeffs;
const derived = computeDerived(coeffs);
const target = cap.calScales;

const cards = Papa.parse(readFileSync("docs/pt_card_list.csv", "utf8"), { header: true, skipEmptyLines: true }).data as any[];

const ANCHOR_N = 50, TARGET_WOBA = 0.320;
const H_SECTION3 = { BB: 48.43, HR: 14.87, H1B: 93.49, XBH: 31.26 };
const P_SECTION3 = { BB: 47.80, HR: 14.96, nHH: 123.97 };

// classification (approximation of the frontend _inHitterPool/_inPitcherPool flags)
const learn = (c: any, p: string) => n(c[`Learn${p}`]) === 1;
const canHit = (c: any) => ["C", "1B", "2B", "3B", "SS", "LF", "CF", "RF"].some((p) => learn(c, p));
const canPitch = (c: any) => n(c["Pos Rating P"]) > 0 || learn(c, "P");

// Build the raw augmented columns (matching computeAugmentedRows) from our core.
function augment(c: any) {
  const bats = n(c["Bats"]), thr = n(c["Throws"]);
  const speed = n(c["Speed"]), steal = n(c["Stealing"]), run = n(c["Baserunning"]), stealRate = n(c["Steal Rate"]);
  const hit = (side: "vR" | "vL") => {
    const e = logLinearModel.predictHitting(
      { eye: n(c[`Eye ${side}`]), pow: n(c[`Power ${side}`]), kRat: n(c[`Avoid K ${side}`]), babip: n(c[`BABIP ${side}`]), gap: n(c[`Gap ${side}`]), speed, steal, run },
      coeffs,
    );
    const woba = assembleRawHittingWoba(e, sameSidePenaltyHitting(bats, side, coeffs.ssp_adv_hitting), speed, stealRate, steal, run, coeffs);
    return { e, woba };
  };
  const pit = (side: "vR" | "vL") => {
    const e = logLinearModel.predictPitching(
      { con: n(c[`Control ${side}`]), stu: n(c[`Stuff ${side}`]), pbabip: n(c[`pBABIP ${side}`]), hrr: n(c[`pHR ${side}`]) },
      coeffs,
    );
    const woba = assembleRawPitchingWoba(e, sameSidePenaltyPitching(thr, side, coeffs.ssp_basic_pitching), coeffs);
    return { e, woba };
  };
  return { bats, thr, hitR: hit("vR"), hitL: hit("vL"), pitR: pit("vR"), pitL: pit("vL") };
}

const MINV = Number(process.argv[3] ?? 60);
const MAXV = Number(process.argv[4] ?? 89);
const eligible = (c: any) => { const v = n(c["Card Value"]); return v >= MINV && v <= MAXV; };

const aug = cards.map((c) => ({ c, a: augment(c) }));
const hitters = aug.filter((x) => canHit(x.c) && eligible(x.c));
const pitchers = aug.filter((x) => canPitch(x.c) && eligible(x.c));
console.log(`  eligibility: Card Value in [${MINV}, ${MAXV}]`);

const hAnchVR = [...hitters].sort((x, y) => y.a.hitR.woba - x.a.hitR.woba).slice(0, ANCHOR_N);
const hAnchVL = [...hitters].sort((x, y) => y.a.hitL.woba - x.a.hitL.woba).slice(0, ANCHOR_N);
const pAnchOVR = [...pitchers].sort((x, y) => (x.a.pitR.woba + x.a.pitL.woba) - (y.a.pitR.woba + y.a.pitL.woba)).slice(0, ANCHOR_N);

const mean = (arr: number[]) => { const v = arr.filter((x) => x > 0); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0; };
const evScale = (vals: number[], tgt: number) => { const m = mean(vals); return m > 0 ? tgt / m : 1; };

const hitBBScaleVR = evScale(hAnchVR.map((x) => x.a.hitR.e.BB), H_SECTION3.BB);
const hitHRScaleVR = evScale(hAnchVR.map((x) => x.a.hitR.e.HR), H_SECTION3.HR);
const hitBBScaleVL = evScale(hAnchVL.map((x) => x.a.hitL.e.BB), H_SECTION3.BB);
const hitHRScaleVL = evScale(hAnchVL.map((x) => x.a.hitL.e.HR), H_SECTION3.HR);
const pBBScaleOVR = evScale(pAnchOVR.map((x) => x.a.pitR.e.BB), P_SECTION3.BB);
const pHRScaleOVR = evScale(pAnchOVR.map((x) => x.a.pitR.e.HR), P_SECTION3.HR);

// calcAnchorWoba — NO ssp, NO hbp term in numerator (hbp only in BIP)
function anchorHit(x: typeof hAnchVR[number], side: "vR" | "vL", bbS: number, hrS: number): number {
  const e = side === "vR" ? x.a.hitR.e : x.a.hitL.e;
  const bats = x.a.bats, vR = side === "vR";
  const BB_fin = e.BB * bbS * coeffs.era_bb;
  const HR_fin = e.HR * hrS * derived.era_effective_hr * getParkFactor(bats, vR, coeffs.park_hr_r, coeffs.park_hr_l);
  const SO_fin = e.SO * coeffs.era_k;
  const BIP_fin = Math.max(600 - BB_fin - coeffs.adv_hbp - (coeffs.adv_sh ?? 0) - SO_fin - HR_fin, 1);
  const BA_fin = Math.max(coeffs.baInt + coeffs.ba * Math.log(Math.max(e.babipSC, 1)) + coeffs.bipba * Math.log(BIP_fin), 0) * derived.era_h * getParkFactor(bats, vR, coeffs.park_avg_r, coeffs.park_avg_l);
  const GAP_fin = Math.max(Math.max(coeffs.gapLogA + coeffs.gapLogB * Math.log(Math.max(e.gapSC, 1)), 0) * BA_fin * coeffs.era_gap * cp(coeffs.park_gap), 0);
  const oneB_fin = Math.max(BA_fin - GAP_fin, 0);
  return (0.704 * BB_fin + 0.8992 * oneB_fin + 1.29 * GAP_fin + 2.0759 * HR_fin) / 600;
}
function anchorPit(x: typeof pAnchOVR[number], side: "vR" | "vL", bbS: number, hrS: number): number {
  const e = side === "vR" ? x.a.pitR.e : x.a.pitL.e;
  const vR = side === "vR";
  const BB_fin = e.BB * bbS * coeffs.era_bb;
  const HR_fin = e.HR * hrS * derived.era_effective_hr * cp(vR ? coeffs.park_hr_r : coeffs.park_hr_l);
  const K_fin = e.K * coeffs.era_k;
  const BIP_fin = Math.max(600 - BB_fin - coeffs.adv_hbp - K_fin - HR_fin, 1);
  const nHH = Math.max(coeffs.p_nHH_int + coeffs.p_nHH_pbabip * Math.log(Math.max(e.pbabipSC, 1)) + coeffs.p_nHH_bip * Math.log(BIP_fin), 0) * (coeffs.p_leagueNorm_h ?? 1) * derived.era_h * cp(vR ? coeffs.park_avg_r : coeffs.park_avg_l);
  const XBH = nHH * coeffs.p_xbh_share * (coeffs.p_xbh_norm ?? 1) * coeffs.era_gap * cp(coeffs.park_gap);
  const oneB = Math.max(nHH - XBH, 0);
  return (0.704 * BB_fin + 0.8992 * oneB + 1.29 * XBH + 2.0759 * HR_fin) / 600;
}

const anchorMeanVR = mean(hAnchVR.map((x) => anchorHit(x, "vR", hitBBScaleVR, hitHRScaleVR)));
const anchorMeanVL = mean(hAnchVL.map((x) => anchorHit(x, "vL", hitBBScaleVL, hitHRScaleVL)));
const anchorMeanPVR = mean(pAnchOVR.map((x) => anchorPit(x, "vR", pBBScaleOVR, pHRScaleOVR)));
const anchorMeanPVL = mean(pAnchOVR.map((x) => anchorPit(x, "vL", pBBScaleOVR, pHRScaleOVR)));
const anchorMeanPOVR = (anchorMeanPVR + anchorMeanPVL) / 2;

const row = (label: string, mine: number, app: number) => {
  const d = Math.abs(mine - app);
  console.log(`  ${label.padEnd(20)} mine=${mine.toFixed(6)}  app=${app.toFixed(6)}  diff=${d.toExponential(2)}  ${d < 1e-4 ? "✅" : d < 2e-3 ? "≈" : "❌"}`);
};
console.log(`\nSP-1 calibration reproduction — capture ${captureName}  (hitters=${hitters.length}, pitchers=${pitchers.length}, full catalog)\n`);
row("anchorMeanVR", anchorMeanVR, target.anchorMeanVR);
row("anchorMeanVL", anchorMeanVL, target.anchorMeanVL);
row("anchorMeanPitchVR", anchorMeanPVR, target.anchorMeanPitchVR);
row("anchorMeanPitchVL", anchorMeanPVL, target.anchorMeanPitchVL);
row("hitBBScaleVR", hitBBScaleVR, target.hitBBScaleVR);
row("hitHRScaleVR", hitHRScaleVR, target.hitHRScaleVR);
row("pBBScaleVR", pBBScaleOVR, target.pBBScaleVR);
row("pHRScaleVR", pHRScaleOVR, target.pHRScaleVR);
row("hitScaleVR", anchorMeanVR > 0 ? TARGET_WOBA / anchorMeanVR : 1, target.hitScaleVR);
row("hitScaleVL", anchorMeanVL > 0 ? TARGET_WOBA / anchorMeanVL : 1, target.hitScaleVL);
row("pitchScale", anchorMeanPOVR > 0 ? TARGET_WOBA / anchorMeanPOVR : 1, target.pitchScale);

// Hypothesis probe: is eligibility a card-value cap? Sweep max Card Value and
// watch anchorMeanVR converge to the captured target.
console.log(`\n  card-value MAX sweep → anchorMeanVR (target ${Number(target.anchorMeanVR).toFixed(6)}):`);
for (const maxV of [100, 95, 92, 90, 89, 88, 87, 86, 85, 84, 83, 82, 80, 75, 70]) {
  const hs = hitters.filter((x) => n(x.c["Card Value"]) <= maxV);
  const top = [...hs].sort((a, b) => b.a.hitR.woba - a.a.hitR.woba).slice(0, ANCHOR_N);
  const bbS = evScale(top.map((x) => x.a.hitR.e.BB), H_SECTION3.BB);
  const hrS = evScale(top.map((x) => x.a.hitR.e.HR), H_SECTION3.HR);
  const am = mean(top.map((x) => anchorHit(x, "vR", bbS, hrS)));
  const hit = Math.abs(am - Number(target.anchorMeanVR)) < 1e-4 ? "  ← MATCH" : "";
  console.log(`    Card Value <= ${String(maxV).padStart(3)}: anchorMeanVR=${am.toFixed(6)}  (eligible hitters=${hs.length})${hit}`);
}

// Corrected hitter-pool (everyone) via the real calibrate(), over the eligible pool.
const eligiblePool = cards.filter((c) => eligible(c));
const corrected = calibrate(eligiblePool, { coeffs, derived });
console.log(`\n  CORRECTED def (everyone is a hitter) via calibrate() vs OLD position-gated vs APP-captured:`);
const cmp = (label: string, corr: number, old: number, app: number) =>
  console.log(`    ${label.padEnd(14)} corrected=${corr.toFixed(6)}  old-def=${old.toFixed(6)}  app=${app.toFixed(6)}`);
cmp("anchorMeanVR", corrected.anchorMeanVR as number, anchorMeanVR, target.anchorMeanVR);
cmp("anchorMeanVL", corrected.anchorMeanVL as number, anchorMeanVL, target.anchorMeanVL);
cmp("hitScaleVR", corrected.hitScaleVR as number, anchorMeanVR > 0 ? TARGET_WOBA / anchorMeanVR : 1, target.hitScaleVR);
cmp("hitScaleVL", corrected.hitScaleVL as number, anchorMeanVL > 0 ? TARGET_WOBA / anchorMeanVL : 1, target.hitScaleVL);
cmp("pitchScale", corrected.pitchScale as number, anchorMeanPOVR > 0 ? TARGET_WOBA / anchorMeanPOVR : 1, target.pitchScale);
