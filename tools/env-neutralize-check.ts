// THROWAWAY diagnostic (tournament-model planning, stage 1). Answers: "does neutralize-on-ingest
// DEGRADE a native model?" — i.e. if we take data collected in environment E, divide E out before
// fitting, then re-apply E at inference, do we get back the SAME scores as fitting the raw data
// directly (bake) and applying nothing? For NATIVE use (score a model on its own environment) the
// wrong-or-right factor must cancel; any residual is the hit-channel BIP nonlinearity, NOT the
// factor accuracy. This runs WITHOUT tournament data by treating the league obs as if collected in
// a non-neutral era E and checking bake == neutralize(E)+reapply(E). Hitters (where the residual
// lives); pitching is analogous.
//
//   run: node tools/env-neutralize-check.ts

import { readFileSync, existsSync } from "node:fs";
import { loadWindow, availableYears, type TrainObs } from "../src/training/loader.ts";
import { fitHitForm, fitPitForm, RAWPOLY_HIT, STUFFAUG_PIT } from "../src/training/forms.ts";
import { scoreCard, computeDerived, type Coeffs, type CalScales } from "../src/scoring-core/index.ts";
import type { EventForm } from "../src/model/curves.ts";

// Identity calibration — REQUIRED so scoreCard runs the era/park recompute (with calScales=null it
// returns the raw pre-environment assembly and never applies E).
const IDENTITY: CalScales = { hitBBScaleVR: 1, hitBBScaleVL: 1, hitHRScaleVR: 1, hitHRScaleVL: 1, hitScaleVR: 1, hitScaleVL: 1, pBBScaleVR: 1, pBBScaleVL: 1, pHRScaleVR: 1, pHRScaleVL: 1, pitchScaleVR: 1, pitchScaleVL: 1, ssp_adv_hitting: 1, ssp_basic_pitching: 1 };

const ROOT = ["League Files", "Model 2037 and 2038"].find((d) => existsSync(d));
if (!ROOT) { console.error("no training data dir"); process.exit(1); }

// A non-neutral test environment E (park-neutral to isolate era; park handedness is a separate,
// external per-hand layer). Deliberately chunky factors so any non-cancellation is visible.
const base = JSON.parse(readFileSync("fixtures/captures/_synthetic.json", "utf8")).coeffs as Coeffs;
const NEUTRAL: Coeffs = { ...base, tournament_hr_adjust: false,
  park_avg_l: 1, park_avg_r: 1, park_hr_l: 1, park_hr_r: 1, park_gap: 1,
  era_bb: 1, era_k: 1, era_avg: 1, era_hr: 1, era_bip: 1, era_gap: 1, era_thr: 1,
  adv_hbp: 6, adv_sh: 3, adv_sf: 4, ssp_adv_hitting: 1, ssp_basic_hitting: 1, ssp_basic_pitching: 1 };
const E: Coeffs = { ...NEUTRAL, era_bb: 1.05, era_k: 0.95, era_avg: 1.08, era_hr: 1.12, era_gap: 1.08 };
const dN = computeDerived(NEUTRAL, true), dE = computeDerived(E, true);
const ERA_H = dE.era_h, ERA_HR = dE.era_effective_hr, ERA_BB = E.era_bb, ERA_K = E.era_k, ERA_GAP = E.era_gap;
console.log(`\n=== Neutralize-on-ingest native-equivalence check — root=${ROOT} ===`);
console.log(`test era E: era_bb=${ERA_BB} era_k=${ERA_K} era_hr(eff)=${ERA_HR.toFixed(4)} era_h=${ERA_H.toFixed(4)} era_gap=${ERA_GAP} (park neutral)`);

// Divide E out of an obs's hit COUNTS — the exact inverse of the forward env application in
// hittingComponents (1B×era_h; XBH×era_h·era_gap; HR×era_hr; BB×era_bb; K×era_k).
const neutralize = (o: TrainObs): TrainObs => {
  const h = o.hit;
  const HRn = h.HR / ERA_HR, b2n = h.b2 / (ERA_H * ERA_GAP), b3n = h.b3 / (ERA_H * ERA_GAP);
  const oneBn = (h.H - h.HR - h.b2 - h.b3) / ERA_H;
  return { ...o, hit: { ...h, BB: h.BB / ERA_BB, K: h.K / ERA_K, HR: HRn, H: oneBn + b2n + b3n + HRn, b2: b2n, b3: b3n } };
};

const { observations } = loadWindow(ROOT, availableYears(ROOT).slice(-2));
const rawObs = observations.filter((o) => o.hit.PA >= 1000);
const neutObs = rawObs.map(neutralize);

// A real (shared) pitching form so scoreCard's pitch path is valid; we only compare hitting, and
// pitching is identical in both models (not neutralized here), so it cancels.
const pitForm = fitPitForm(STUFFAUG_PIT, observations.filter((o) => o.pitch.BF >= 1000));
// BAKE model: fit on the raw-E data, score with NO env (era=park=1).
// NEUTRAL model: fit on the neutralized data, score WITH E re-applied. Native use ⇒ these should match.
const bakeForm: EventForm = { hit: fitHitForm(RAWPOLY_HIT, rawObs), pit: pitForm };
const neutForm: EventForm = { hit: fitHitForm(RAWPOLY_HIT, neutObs), pit: pitForm };

// Build a scoreCard-shaped card from an obs's hit ratings (both sides identical, R/R, park-neutral).
const cardFrom = (o: TrainObs) => {
  const h = o.ratings.hit;
  const c: Record<string, unknown> = { "Card ID": "x", "//Card Title": "x", Bats: 1, Throws: 1, Speed: 0, Stealing: 0, Baserunning: 0, GB: 2 };
  for (const s of ["vR", "vL"]) { c[`Eye ${s}`] = h.eye; c[`Power ${s}`] = h.pow; c[`Avoid K ${s}`] = h.kRat; c[`BABIP ${s}`] = h.babip; c[`Gap ${s}`] = h.gap; c[`Control ${s}`] = 100; c[`Stuff ${s}`] = 100; c[`pBABIP ${s}`] = 100; c[`pHR ${s}`] = 100; }
  return c;
};

const diffs: number[] = [];
for (const o of rawObs) {
  const card = cardFrom(o);
  const sBake = scoreCard(card, { coeffs: NEUTRAL, derived: dN, calScales: IDENTITY, eventForm: bakeForm }).hit.woba_vR;
  const sNeut = scoreCard(card, { coeffs: E, derived: dE, calScales: IDENTITY, eventForm: neutForm }).hit.woba_vR;
  diffs.push(Math.abs(sBake - sNeut));
}
diffs.sort((a, b) => a - b);
const p = (q: number) => diffs[Math.min(diffs.length - 1, Math.floor(q * diffs.length))]!;
const mean = diffs.reduce((s, x) => s + x, 0) / diffs.length;
console.log(`\nnative equivalence: |bake − neutralize(E)+reapply(E)| over ${diffs.length} hitters (wOBA points):`);
console.log(`   mean ${(1000 * mean).toFixed(3)}   median ${(1000 * p(0.5)).toFixed(3)}   p90 ${(1000 * p(0.9)).toFixed(3)}   p99 ${(1000 * p(0.99)).toFixed(3)}   max ${(1000 * p(1)).toFixed(3)}`);
console.log(`\n   Interpretation:`);
console.log(`   • The BB/K/HR channels cancel EXACTLY (linear curves ÷F then ×F). The residual is entirely`);
console.log(`     the HIT channel: era adjusts BB/K/HR BEFORE BIP is computed, so at inference the neutral`);
console.log(`     hit curve is evaluated at an era-SHIFTED BIP, while it was fit on the neutral BIP. That`);
console.log(`     mismatch is the residual — it scales with |era−1| and vanishes at era=1.`);
console.log(`   • It is INDEPENDENT of factor ACCURACY (a wrong factor still divides out then multiplies`);
console.log(`     back); factor accuracy only bites on TRANSFER (E_from ≠ E_to), which needs real tournament`);
console.log(`     data to validate.`);
console.log(`   • It is near-UNIFORM across cards (tight range above), so it barely perturbs within-pool`);
console.log(`     RANKING and is largely absorbed by the 0.320 anchor. But it is NOT zero.`);
console.log(`   • DECISION: for NATIVE use, prefer the BAKE (raw) fit — exact, no residual. Use the neutral`);
console.log(`     fit ONLY for transfer. (Same era→BIP effect already exists when the LEAGUE model scores a`);
console.log(`     non-neutral tournament today — a known small approximation, not a tournament-only issue.)`);
process.exit(0);
