// PITCHER K-SPREAD SPACING CORRECTION — fit, held-out validation, weird-env battery, two-axis gate.
//   run: node tools/fit-kspread-pit.ts
//
// EVIDENCE BASE (docs/CWHIT_MMSE_BATTERY_2026-07-16.md): pitcher K9 calibration slope obs~pred =
// 1.73 [1.65,1.80] pooled, FLAT across quality bands (scalar-correct), monotone in the opponent-frame
// gap (iron 1.90 → gold 1.43). League in-frame K is already calibrated (insample-frame-check) ⇒ the
// amplification is a tournament-frame parameter by construction and s(gap→0)=1 is anchored by the
// league, not fit. Value stake: 4.6 mwOBA/card SD — the program's #1.
//
// WHAT THIS IS NOT: the refuted frame-v2 kSpread (that died as part of the additive-frame PACKAGE).
// This is a standalone multiplicative spread scalar on the CURRENT own-gap scoring path:
//     K_corr = K̄_pool + s(gap)·(K_pred − K̄_pool),   s(g) = 1 + A·(1 − e^(−g/G)),  s(0) = 1 hard
// applied to the raw model K PRE-BIP PRE-ERA (the placement verified correct in the old joint run;
// the surviving kSpread plumbing in score-card.ts/calibrate.ts is reused as-is). Monotone in K_pred
// ⇒ within-pool K ordering unchanged by construction (verified empirically anyway, §4).
//
// gap = the own-channel stu gap convention from the EXISTING frame machinery:
//     gap_pit = buildFrameShift(trainingMeans, poolField).pit.vR.stu
// (= trainingMeans.hit.kRat − poolField.hit.kRat.mu — the opposing-hitter K-avoid gap assigned to the
// pitcher K channel by the §10.2 crossing; the same number tools/tournament-kslope.ts and
// tools/fit-sgap.ts used). K̄_pool = poolMeanKOwn (top-50 field mean predicted K on OWN-GAP ratings —
// the own-gap sibling of production's poolMeanK centering convention).
//
// STEPS: (1) measure per-tier K9 calibration slopes on the cwhit Quick tiers (buildCwhitSample — the
// scorecard's exact path) and fit the ramp PRECISION-WEIGHTED (inverse-variance; iron/bronze dominate);
// (2) held-out: fit without bronze, predict bronze's slope; (3) weird-env battery on the three
// confirmed daily/cap formats (earlygolddaily/early-gold, bronzeheartdaily/bronze-heart,
// goldcapdaily/gold-cap, and diamondcapdaily/diamond-cap-daily since 2026-07-21); (4) two-axis gate.
// Pre-registered gates — never tuned past a failure:
//   G1 post-fix per-tier K9 slope ≈ 1 within CI;   G2 composite wOBAA ordering corr MUST NOT DROP;
//   G3 level bias unchanged (scalar centered on K̄_pool; the top-100 sample sits off the pool mean,
//      so the algebraic expectation (s−1)·(K̄_sample−K̄_pool) is printed next to the measured move);
//   G4 spread ratios move toward the deconvolved-honest optimum (ratioDcv → optRatio).

import { readFileSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import {
  makeRawPolyModel, computeUnifiedFieldStats, applyWobaWeights, computeDerived, calibrate,
  buildPoolTransform, buildFrameShift, poolMeanKOwn,
  type EventForm, type FieldStats, type RatingEnvelope, type WobaWeights, type TrainingMeans,
} from "../src/scoring-core/index.ts";
import { parseCatalogCsv, type Card } from "../src/data/catalog.ts";
import { makeVariant } from "../src/data/variants.ts";
import { rowEligible } from "../src/config/eligibility.ts";
import { pitWobaFromChannels, type WobaWeights as WW } from "../src/eval/cwhit/audit.ts";
import { per9NoiseVar, babipNoiseVar, pearson, spearman, BF_PER_9 } from "../src/eval/cwhit/scorecard.ts";
import { mmse, meanEst, type Mmse, type Est } from "../src/eval/cwhit/two-ledger.ts";
import { parseCwhitPit } from "../src/eval/cwhit/parse.ts";
import { formatByLegacySlug } from "../src/eval/cwhit/corpus.ts";
import { joinCwhit, type JoinCard, type JoinObs } from "../src/eval/cwhit/join.ts";
import {
  buildCwhitSample, wellSampled, ourPit, cardName, handLetter, isPit, n_,
  QUICK, inValueWindow, MIN_BF, FIELD_N, OBS_DIR, type ValueWindow,
  type Rec, type SampleDeps, type KSpreadPit, obsTablePath,} from "../src/eval/cwhit/sample.ts";

const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const sgn = (x: number, d = 2) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}` : "n/a");
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

// ── deployed model + neutral env (IDENTICAL setup to tools/cwhit-mmse.ts) ──
const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state = (await repo.load<{ activeModelId?: string; catalogSourceId?: string }>("state", "app")) ?? {};
type TM_ = { id: string; eventForm?: EventForm; wobaWeights?: WobaWeights; ratingEnvelope?: RatingEnvelope; trainingMeans?: TrainingMeans; platoon?: { pit: { hand: string; vsRHB: number; vsLHB: number }[]; hit: { hand: string; vsRHP: number; vsLHP: number }[] } };
const trained = (await repo.loadAll<TM_>("trained-models")).find((x) => x.id === state.activeModelId);
if (!trained?.eventForm || !trained.wobaWeights || !trained.platoon) throw new Error("active model missing eventForm/wobaWeights/platoon");
if (!trained.trainingMeans) throw new Error("active model has NO trainingMeans — the gap convention needs the artifact frame (retrain post-f88912c)");
const TM = trained.trainingMeans;
const rp = makeRawPolyModel(trained.eventForm);
const W = trained.wobaWeights as WW;
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const tournaments = await repo.loadAll<Tournament>("tournaments");
const bq = tournaments.find((t) => t.id === "bronze-quick")!;
const coeffs = resolveCoeffs(model, eras.get(bq.eraId)!, parks.get(bq.parkId)!, bq.softcaps);
applyWobaWeights(coeffs, trained.wobaWeights);
const derived = computeDerived(coeffs);
const srcId = state.catalogSourceId ?? "cdmx";
const baseCards = parseCatalogCsv(readFileSync(`data/imports/${srcId}.csv`, "utf8")).cards.filter((c) => String(c["Variant"] ?? "").toUpperCase() !== "Y");
const ref: FieldStats = computeUnifiedFieldStats(baseCards, coeffs, rp, FIELD_N, true);
const deps: SampleDeps = {
  baseCards, coeffs, derived, eventForm: trained.eventForm, model: rp, W, ref, envelope: trained.ratingEnvelope,
  pitExp: new Map(trained.platoon.pit.map((p) => [p.hand, { wR: p.vsRHB, wL: p.vsLHB }])),
  hitExp: new Map(trained.platoon.hit.map((p) => [p.hand, { wR: p.vsRHP, wL: p.vsLHP }])),
};

// ═══ BATTERY ITEM 3 — TWO-SIDED GAP PROFILES ═════════════════════════════════
// Per tier, per ROLE, per CHANNEL: how far that pool's field sits from the model's training frame.
//
// WHY BOTH SIDES. The scoring path only ever uses the CROSSED gap (a pitcher channel re-based by the
// opposing HITTER channel's gap, and vice versa — pool-stats.ts buildFrameShift). That crossing means
// a tier's pitcher correction is driven entirely by how its HITTERS sit off-frame. So "is gold odd?"
// cannot be answered from the pitcher side alone: it needs the own-side profile of BOTH roles, which
// no existing tool prints.
//
// RATING SPACE ONLY, and DESCRIPTIVE. No event prediction, no correction, nothing fitted.
console.log(`
╔═══ BATTERY ITEM 3 — TWO-SIDED GAP PROFILES (rating space, descriptive) ═══╗`);
console.log(`model '${trained.id}' | catalog '${srcId}' | field top-N = ${FIELD_N}, side-unified (vR)`);
console.log(`gap = trainingMean(channel) − poolFieldMean(channel), OWN side. Positive = pool is BELOW the training frame on that channel.`);
console.log(`NOTE the pools are NESTED (iron ⊂ bronze ⊂ … ⊂ diamond), so tier rows are not independent samples.`);

const HIT_CH = ["eye", "pow", "kRat", "babip", "gap"] as const;
const PIT_CH = ["con", "stu", "hrr", "pbabip"] as const;

interface Row { tier: string; n: number; hit: Record<string, number>; pit: Record<string, number>; hitSd: Record<string, number>; pitSd: Record<string, number> }
const rows: Row[] = [];
for (const win of QUICK) {
  const basePool = deps.baseCards.filter((c) => inValueWindow(c, win));
  const pf = computeUnifiedFieldStats(basePool, coeffs, rp, FIELD_N, true);
  const g = (mu: number | undefined, s: { mu: number } | undefined) => (mu != null && s ? mu - s.mu : NaN);
  const hit: Record<string, number> = {}, pit: Record<string, number> = {};
  const hitSd: Record<string, number> = {}, pitSd: Record<string, number> = {};
  for (const k of HIT_CH) { hit[k] = g(TM.hit[k], pf.hit.vR[k]); hitSd[k] = pf.hit.vR[k]?.sd ?? NaN; }
  for (const k of PIT_CH) { pit[k] = g(TM.pit[k], pf.pit.vR[k]); pitSd[k] = pf.pit.vR[k]?.sd ?? NaN; }
  rows.push({ tier: win.tier, n: basePool.length, hit, pit, hitSd, pitSd });
}

const F = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d).padStart(7) : "    n/a");
console.log(`
── OWN-SIDE GAPS ──`);
console.log(`tier      poolN  │ HITTER side: ${HIT_CH.map((k) => k.padStart(7)).join(" ")}  │ PITCHER side: ${PIT_CH.map((k) => k.padStart(7)).join(" ")}`);
for (const r of rows)
  console.log(`${r.tier.padEnd(9)} ${String(r.n).padStart(5)}  │              ${HIT_CH.map((k) => F(r.hit[k]!)).join(" ")}  │               ${PIT_CH.map((k) => F(r.pit[k]!)).join(" ")}`);

console.log(`
── POOL FIELD DISPERSION (SD within the top-${FIELD_N} field) ──`);
console.log(`tier            │ HITTER: ${HIT_CH.map((k) => k.padStart(7)).join(" ")}  │ PITCHER: ${PIT_CH.map((k) => k.padStart(7)).join(" ")}`);
for (const r of rows)
  console.log(`${r.tier.padEnd(15)} │         ${HIT_CH.map((k) => F(r.hitSd[k]!)).join(" ")}  │          ${PIT_CH.map((k) => F(r.pitSd[k]!)).join(" ")}`);

// THE DECOUPLING READ. The scoring crossing pairs each pitcher channel with one hitter channel:
//   pit.stu ← hit.kRat · pit.hrr ← hit.pow · pit.con ← hit.eye · pit.pbabip ← hit.babip
// If a tier's two sides move together, the crossed gap tracks the own gap. Where they diverge, the
// correction a tier NEEDS and the gap it is SCORED on come apart — which is the shape gold shows.
console.log(`
── CROSSED PAIRS (the coordinate scoring actually uses) ──`);
const PAIRS: [string, string][] = [["stu", "kRat"], ["hrr", "pow"], ["con", "eye"], ["pbabip", "babip"]];
console.log(`tier      │ ${PAIRS.map(([p, h]) => `pit.${p}←hit.${h}`.padStart(20)).join(" ")}`);
for (const r of rows)
  console.log(`${r.tier.padEnd(9)} │ ${PAIRS.map(([, h]) => F(r.hit[h]!).padStart(20)).join(" ")}`);
console.log(`
── OWN-SIDE PITCHER GAP vs THE CROSSED GAP IT IS SCORED ON ──`);
console.log(`(if these disagree in ORDER across tiers, a gap-only pitcher ramp is reading a different axis than the pitchers' own position)`);
console.log(`tier      │ ${PAIRS.map(([p]) => `own pit.${p}`.padStart(14)).join(" ")} │ ${PAIRS.map(([, h]) => `crossed ${h}`.padStart(14)).join(" ")}`);
for (const r of rows)
  console.log(`${r.tier.padEnd(9)} │ ${PAIRS.map(([p]) => F(r.pit[p]!).padStart(14)).join(" ")} │ ${PAIRS.map(([, h]) => F(r.hit[h]!).padStart(14)).join(" ")}`);
console.log(`
(end of battery item 3)`);
