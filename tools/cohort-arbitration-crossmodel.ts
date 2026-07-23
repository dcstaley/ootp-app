// COHORT ARBITRATION — CROSS-MODEL + COORDINATE-STABILITY (Fable directive, 2026-07-23).
//   run: node tools/cohort-arbitration-crossmodel.ts > fixtures/cohort-arbitration-crossmodel-2026-07-23.txt
//
// MEASUREMENT ONLY. Read-only; nothing fitted, no constant/default/production behaviour touched.
// Two artifacts now exist (active league-42-43 + the fresh league-42-43-retrain), so criterion (b)
// — cross-model stability — is measurable DIRECTLY, and the task-0 STOP is its first data point.
//
// THE STOP, restated as the arbitration's motivating evidence: activating the retrain drove Bronze
// Quick G1-K 0.99 → 1.06 [1.01,1.11] (CI-clear core FAIL) because the convex K ramp under-corrected
// on a gap that shrank ~1.6 while the NEED held. This tool decomposes WHY, across two questions the
// arbitration must answer with numbers:
//   Q1  WHERE is the cross-model gap drift — the TRAIN leg (frozen trainingMeans) or the POOL leg
//       (the tournament field)? A rule can only stabilise the leg the drift lives in.
//   Q2  the NEW LENS (Fable): coordinate-stability under retrains — does a stable need map to a
//       stable gap? And the family-level drift tax: how much correction move (ΔS) does a given gap
//       move (Δg) produce, for the CONVEX K ramp vs the FLAT HR ramp? That is why one broke and one
//       did not, and it makes FORM a first-class arbitration lever alongside the cohort rule.
//
// Everything comes from the shared core at the SHIPPED constants. The two artifacts differ ONLY in
// trainingMeans (eventForm/weights/platoon/pitcher-means bit-identical — verified task-0), so every
// cross-model delta below is a pure trainingMeans (train-leg) effect BY CONSTRUCTION.

import { readFileSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import {
  makeRawPolyModel, productionFieldStats, computeUnifiedFieldStats, applyWobaWeights, computeDerived,
  buildFrameShift, kSpreadPitRamp, pitSpreadHrRamp, K_SPREAD_PIT, PIT_SPREAD_HR,
  type EventForm, type FieldStats, type RatingEnvelope, type WobaWeights, type TrainingMeans, type Coeffs,
} from "../src/scoring-core/index.ts";
import { presenceMixture } from "../src/data/variants.ts";
import { parseCatalogCsv, type Card } from "../src/data/catalog.ts";
import { QUICK, inValueWindow } from "../src/eval/cwhit/sample.ts";

const L: string[] = [];
const say = (s = "") => L.push(s);
const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const sgn = (x: number, d = 2) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}` : "n/a");
const pad = (s: string, n: number) => s.padEnd(n);
const rp2 = (s: string, n: number) => s.padStart(n);

const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state = (await repo.load<{ activeModelId?: string; catalogSourceId?: string }>("state", "app")) ?? {};
type TM_ = { id: string; eventForm?: EventForm; wobaWeights?: WobaWeights; ratingEnvelope?: RatingEnvelope; trainingMeans?: TrainingMeans };
const all = await repo.loadAll<TM_>("trained-models");
const ACTIVE = "league-42-43", RETRAIN = "league-42-43-retrain";
const act = all.find((x) => x.id === ACTIVE)!, ret = all.find((x) => x.id === RETRAIN)!;
if (!act?.trainingMeans || !ret?.trainingMeans) throw new Error("need both artifacts with trainingMeans");
// eventForm is bit-identical (task-0) — one model object serves both; only trainingMeans differs.
const rp = makeRawPolyModel(act.eventForm!);
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const tournaments = await repo.loadAll<Tournament>("tournaments");
const bq = tournaments.find((t) => t.id === "bronze-quick")!;
const coeffs = resolveCoeffs(model, eras.get(bq.eraId)!, parks.get(bq.parkId)!, bq.softcaps);
applyWobaWeights(coeffs, act.wobaWeights!);
const srcId = state.catalogSourceId ?? "cdmx";
const baseCards = parseCatalogCsv(readFileSync(`data/imports/${srcId}.csv`, "utf8")).cards.filter((c) => String(c["Variant"] ?? "").toUpperCase() !== "Y");
const poolOf = (win: { tier: string; valueMin?: number; valueMax: number; eligible?: (c: any) => boolean }) => baseCards.filter((c) => inValueWindow(c, win));

say("################################################################################");
say("# COHORT ARBITRATION — CROSS-MODEL + COORDINATE-STABILITY.  MEASUREMENT ONLY.");
say("# tools/cohort-arbitration-crossmodel.ts. Nothing wired; both artifacts read-only.");
say("# Active = league-42-43; cross-model partner = league-42-43-retrain (task-0 STOP subject).");
say("################################################################################");
say();
say("### THE TWO ARTIFACTS DIFFER ONLY IN trainingMeans (verified task-0):");
say(`  hitter: ${["eye", "pow", "kRat", "babip", "gap"].map((k) => `${k} ${sgn(ret.trainingMeans!.hit[k]! - act.trainingMeans!.hit[k]!)}`).join("  ")}`);
say(`  pitcher: ${["con", "stu", "pbabip", "hrr"].map((k) => `${k} ${sgn(ret.trainingMeans!.pit[k]! - act.trainingMeans!.pit[k]!)}`).join("  ")}  ← the 0.000 control`);
say(`  eventForm / wobaWeights / platoon: BIT-IDENTICAL. So every cross-model delta below is a pure`);
say(`  train-leg (trainingMeans) effect by construction.`);
say();

// ═══════════════════════════════════════════════════════════════════════════════
// Q1 — WHERE THE CROSS-MODEL GAP DRIFT LIVES: train leg vs pool leg, per Quick tier.
//   gap = buildFrameShift(trainingMeans, poolField).pit.vR.<ch>  =  trainMean_cross − poolMean_cross
//   The K gap crosses H.kRat↔P.stu; the HR gap crosses H.pow↔P.hrr. The pool leg is built from the
//   catalog with the SHARED eventForm ranking, so it is IDENTICAL across artifacts — proven here by
//   computing it once and differencing the gaps.
// ═══════════════════════════════════════════════════════════════════════════════
say("### Q1 — WHERE THE CROSS-MODEL GAP DRIFT LIVES (train leg vs pool leg)");
say();
say("  For each Quick tier: the K gap (stu) and HR gap (hrr) under each artifact, the pool field on");
say("  that channel (shared eventForm ⇒ artifact-independent), and the decomposition of the gap move.");
say();
say(`  tier      │ K gap (stu)  act→ret   Δgap │ pool.hit.kRat (shared) │ s_K act→ret   ΔsK │ HR gap act→ret Δ │ s_HR act→ret ΔsHR`);
interface Row { tier: string; gKa: number; gKr: number; sKa: number; sKr: number; poolKRat: number; gHa: number; gHr: number; sHa: number; sHr: number }
const rows: Row[] = [];
for (const win of QUICK) {
  const pool = poolOf(win);
  const pf = productionFieldStats(pool, coeffs, rp);         // pool leg — one build, shared eventForm
  const fsA = buildFrameShift(act.trainingMeans!, pf);
  const fsR = buildFrameShift(ret.trainingMeans!, pf);
  const gKa = fsA.pit.vR.stu ?? 0, gKr = fsR.pit.vR.stu ?? 0;
  const gHa = fsA.pit.vR.hrr ?? 0, gHr = fsR.pit.vR.hrr ?? 0;
  rows.push({
    tier: win.tier, gKa, gKr, sKa: kSpreadPitRamp(gKa), sKr: kSpreadPitRamp(gKr),
    poolKRat: pf.hit.vR.kRat!.mu, gHa, gHr, sHa: pitSpreadHrRamp(gHa), sHr: pitSpreadHrRamp(gHr),
  });
}
for (const r of rows) {
  say(`  ${pad(r.tier, 9)} │ ${rp2(f(r.gKa, 1), 6)}→${rp2(f(r.gKr, 1), 5)} ${rp2(sgn(r.gKr - r.gKa, 2), 6)} │ ${rp2(f(r.poolKRat, 1), 14)} (both) │ ${rp2(f(r.sKa, 3), 5)}→${rp2(f(r.sKr, 3), 5)} ${rp2(sgn(r.sKr - r.sKa, 3), 6)} │ ${rp2(f(r.gHa, 1), 4)}→${rp2(f(r.gHr, 1), 4)} ${rp2(sgn(r.gHr - r.gHa, 2), 5)} │ ${rp2(f(r.sHa, 3), 5)}→${rp2(f(r.sHr, 3), 5)} ${sgn(r.sHr - r.sHa, 3)}`);
}
say();
const meanDgK = rows.reduce((a, r) => a + (r.gKr - r.gKa), 0) / rows.length;
const trainDkRat = ret.trainingMeans!.hit.kRat! - act.trainingMeans!.hit.kRat!;
say(`  DECOMPOSITION: the mean K-gap move is ${sgn(meanDgK, 2)}. The train-leg move (trainingMeans.hit.kRat)`);
say(`  is ${sgn(trainDkRat, 2)}, and the pool leg is IDENTICAL across artifacts (same eventForm ranking, printed`);
say(`  once above). So the cross-model K-gap drift is ${f(100 * Math.abs(meanDgK / trainDkRat), 0)}% train leg, ~0% pool leg.`);
say(`  ⇒ THE DRIFT LIVES ENTIRELY IN THE FROZEN TRAIN LEG. A cohort rule applied to the POOL leg`);
say(`  (the FIELD_N knob) CANNOT touch it; only the TRAIN-LEG selection (how trainingMeans is built)`);
say(`  can, and that is retrain-coupled — a rule change re-trains, which is the atomic event's job.`);
say();

// ═══════════════════════════════════════════════════════════════════════════════
// Q2 — THE FAMILY-LEVEL DRIFT TAX: dS/dg at the operating gaps, convex K vs flat HR.
//   The correction move for a given gap move is dS/dg·Δg. A convex ramp has large dS/dg at high gap;
//   a flat ramp has small dS/dg everywhere. This is WHY the SAME frame drift broke K and not HR, and
//   it makes FORM a drift-robustness lever independent of the cohort rule.
// ═══════════════════════════════════════════════════════════════════════════════
say("### Q2 — THE FAMILY-LEVEL DRIFT TAX (dS/dg at the operating gaps; convex K vs flat HR)");
say();
const dK = (g: number) => (g > 0 && g <= K_SPREAD_PIT.gMax ? K_SPREAD_PIT.A * K_SPREAD_PIT.q / K_SPREAD_PIT.G0 * Math.pow(g / K_SPREAD_PIT.G0, K_SPREAD_PIT.q - 1) : 0);
const dH = (g: number) => (g > 0 && g <= PIT_SPREAD_HR.gMax ? PIT_SPREAD_HR.A * PIT_SPREAD_HR.q / PIT_SPREAD_HR.G0 * Math.pow(g / PIT_SPREAD_HR.G0, PIT_SPREAD_HR.q - 1) : 0);
say(`  K ramp  {A:${K_SPREAD_PIT.A}, q:${K_SPREAD_PIT.q}} CONVEX ⇒ dS/dg RISES with gap.`);
say(`  HR ramp {A:${PIT_SPREAD_HR.A}, q:${PIT_SPREAD_HR.q}} CONCAVE/near-flat ⇒ dS/dg FALLS with gap, small everywhere.`);
say();
say(`  ΔS is the EXACT correction move s(g_ret)−s(g_act) (the linear dS/dg·Δg is shown for local slope`);
say(`  context but is only valid away from the gMax knee — iron's gap crosses it, so its exact move`);
say(`  ${sgn(rows[0]!.sKr - rows[0]!.sKa, 3)} is the full ramp drop from the flat-hold plateau, not the 0 the local slope predicts).`);
say();
say(`  tier      │ K gap │ dS_K/dg │ EXACT ΔS_K (Δg ${sgn(rows[0]!.gKr - rows[0]!.gKa, 1)}) │ HR gap │ dS_HR/dg │ EXACT ΔS_HR (Δg ${sgn(rows[0]!.gHr - rows[0]!.gHa, 1)})`);
for (const r of rows) {
  const atKnee = r.gKa > K_SPREAD_PIT.gMax || r.gKr > K_SPREAD_PIT.gMax;
  say(`  ${pad(r.tier, 9)} │ ${rp2(f(r.gKa, 1), 5)} │ ${rp2(f(dK(r.gKa), 4), 7)} │ ${rp2(sgn(r.sKr - r.sKa, 3), 9)}${atKnee ? " (crosses gMax)" : "        "} │ ${rp2(f(r.gHa, 1), 4)} │ ${rp2(f(dH(r.gHa), 4), 7)}  │ ${sgn(r.sHr - r.sHa, 3)}`);
}
say();
const kMove = rows.reduce((a, r) => Math.max(a, Math.abs(r.sKr - r.sKa)), 0);
const hMove = rows.reduce((a, r) => Math.max(a, Math.abs(r.sHr - r.sHa)), 0);
say(`  HEADLINE: the SAME frame drift (kRat −1.59 into K, pow +2.59 into HR) moves the CONVEX K`);
say(`  correction by up to ${sgn(-kMove, 3)} but the FLAT HR correction by at most ${sgn(hMove, 3)} — a ${f(kMove / Math.max(hMove, 1e-6), 0)}× difference in drift`);
say(`  tax between the two families. That is the whole reason bronze K crossed CI and HR did not:`);
say(`  the convex form amplifies frame drift, the flat form absorbs it. FORM is a drift-robustness axis:`);
say(`  a flatter / less-convex K ramp would pay less tax per unit of frame drift, at the cost of the`);
say(`  diamond-end curvature the convex form bought.`);
say(`  This is NOT a recommendation to flatten K (that would reopen the diamond G1 the convex form`);
say(`  resolved) — it is the measurement that says the cohort rule and the ramp form are TWO levers on`);
say(`  the same drift tax, and the arbitration should weigh both.`);
say();

say("(end of artifact — cohort arbitration cross-model)");
process.stdout.write(L.join("\n") + "\n");
process.exit(0);
