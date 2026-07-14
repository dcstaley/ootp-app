// DIAGNOSTIC (Derek's question): does the model OVER-VALUE high-CON pitchers at low tiers who get scaled up?
// The claim: high-Control pitchers were over-rated (the Stuff-residual / overscoring-stuff-residual ticket:
// walk/HR suppression really comes from STUFF, mis-attributed to Control), and own-gap scaling CON up at low
// tiers amplifies it (BB is a LOG channel with NO monotone cap → high-CON extrapolates down the walk curve).
// TEST: in low-tier pools (bronze-quicks, EG) under the SHIPPED pareto + own-gap, bin pitchers by CON and report
//   (a) uBB bias = pred − actual walks/600 (NEGATIVE = model predicts FEWER walks than reality = over-credits control),
//   (b) VALUE bias = affine-aligned residual, oriented so POSITIVE = model OVER-values the pitcher,
//   (c) the mean own-gap CON scale-up applied to that bin (the "scaled up" dimension).
// If the HIGH-CON bin shows negative uBB bias / positive value bias that GROWS with the scale-up, the claim holds.
//   run: node tools/con-overvalue-check.ts
import { readFileSync, existsSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import { applyWobaWeights, makeRawPolyModel, computeUnifiedFieldStats, buildPoolTransform, computeDerived } from "../src/scoring-core/index.ts";
import { pitchingComponents } from "../src/scoring-core/woba.ts";
import { wobaWeightsFromCoeffs } from "../src/scoring-core/woba-weights.ts";
import { applyAffine } from "../src/model/pool-transform.ts";
import { loadTournamentOutcomes, tournamentExposure, tournamentCardValues, type TournamentObs } from "../src/training/tournament-eval.ts";
import { loadWindow, type TrainObs } from "../src/training/loader.ts";
import { fitHitForm, fitPitForm, RAWPOLY_HIT, STUFFAUG_PIT, type PitForm } from "../src/training/forms.ts";
import { cleanTournamentRows } from "../src/eval/tournament-clean.ts";
import { parseCatalogCsv } from "../src/data/catalog.ts";
import { rowEligible } from "../src/config/eligibility.ts";
import type { EventForm } from "../src/model/curves.ts";

const R2 = { kind: "rawpoly", degree: 2 } as const, LOGc = { kind: "log" } as const;
const FIELD_N = 50, TH = 250;
const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state: any = (await repo.load<any>("state", "app")) ?? {};
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const trained = (await repo.loadAll<any>("trained-models")).find((x) => x.id === state.activeModelId);
const win: number[] = Array.isArray(trained.window) && trained.window.length ? trained.window : [2041, 2042];
const lgObs = loadWindow("League Files", win).observations.filter((o: TrainObs) => (trained.includeVariants ?? true) || !o.variant);
const cat = parseCatalogCsv(readFileSync("data/imports/cdmx.csv", "utf8"));
const isB = (c: any) => String(c["Variant"] ?? "").toUpperCase() !== "Y";
const PARETO: PitForm = { ...(STUFFAUG_PIT as PitForm), name: "{HR,K,H}", bb: LOGc, k: R2, hr: R2, h: R2, stuffAug: true };
const ef: EventForm = { hit: fitHitForm(RAWPOLY_HIT, lgObs), pit: fitPitForm(PARETO, lgObs) };
const rp = makeRawPolyModel(ef);
const per600 = (x: number, d: number) => (d > 0 ? (x * 600) / d : 0);
const wmean = (x: number[], w: number[]) => { const sw = w.reduce((a, b) => a + b, 0); return sw ? x.reduce((a, v, i) => a + w[i]! * v, 0) / sw : 0; };
const f = (n: number) => (Number.isFinite(n) ? (n >= 0 ? "+" : "") + n.toFixed(2) : " n/a");

console.log(`CON-OVERVALUE CHECK — shipped pareto + own-gap, low-tier pools. uBB bias<0 = predicts FEWER walks than actual`);
console.log(`(over-credits control); VALUE bias>0 = model OVER-values the pitcher; scaleΔ = mean own-gap CON lift (raw→lifted).\n`);
for (const [name, dir, TID] of [
  ["Bronze-quicks", "Tournament Data/Quicks - Bronze", "bronze-quick"],
  ["EG-clean", "Tournament Data/Early Gold", "early-gold"],
  ["Bronze-t", "Tournament Data/Return of the Bronze", "bronze-return"],
] as const) {
  if (!existsSync(dir)) continue;
  const t = (await repo.loadAll<Tournament>("tournaments")).find((x) => x.id === TID)!;
  const coeffs = resolveCoeffs(model, eras.get(t.eraId)!, parks.get(t.parkId)!, t.softcaps);
  if (trained.wobaWeights) applyWobaWeights(coeffs, trained.wobaWeights);
  const derived = computeDerived(coeffs, true);
  const ww = wobaWeightsFromCoeffs(coeffs);
  const inV = (c: any) => { const v = Number(c["Card Value"]) || 0; return (t.card_value_min == null || v >= t.card_value_min) && (t.card_value_max == null || v <= t.card_value_max); };
  const basePool = cat.cards.filter((c: any) => isB(c) && inV(c) && rowEligible(c as any, t));
  const refField = computeUnifiedFieldStats(cat.cards.filter(isB), coeffs, rp, FIELD_N, true);
  const poolField = computeUnifiedFieldStats(basePool, coeffs, rp, FIELD_N, true);
  const pt = buildPoolTransform(refField, poolField, trained.ratingEnvelope ?? undefined);
  const obs = loadTournamentOutcomes(dir, { clean: (rows) => cleanTournamentRows(rows).cleaned });
  const exposure = tournamentExposure(obs);
  const cv = tournamentCardValues(obs, { coeffs, eventForm: ef, poolTransform: pt }, exposure, { minPA: TH, minBF: TH }).pit;
  const qual = obs.filter((o: TournamentObs) => o.bf >= TH);
  // affine-align value residual (POSITIVE = over-value: since pit value = allowedWOBA, model over-values a
  // pitcher when it predicts a LOWER allowedWOBA than actual, i.e. real − pred > 0 flipped → use pred-under-actual).
  const mp = wmean(cv.pred, cv.w), mr = wmean(cv.real, cv.w); let cova = 0, vp = 0;
  for (let i = 0; i < cv.pred.length; i++) { const dp = cv.pred[i]! - mp; cova += cv.w[i]! * dp * (cv.real[i]! - mr); vp += cv.w[i]! * dp * dp; }
  const beta = vp > 1e-15 ? cova / vp : 0, alpha = mr - beta * mp;
  // per-card: CON (vR), predicted uBB (own-gap), actual uBB, value over-rate = (actual allowedWOBA) − (aligned pred)
  //   over-value ⇒ model's predicted allowedWOBA is BELOW actual ⇒ actual − predAligned > 0.
  const rows = qual.map((o, i) => {
    const conRaw = o.ratings.pit.vR.con;
    const conLift = applyAffine(conRaw, pt.pit.vR.con);
    // predicted uBB under own-gap: re-run the pit BB component with lifted con
    const rat = { con: conLift, stu: applyAffine(o.ratings.pit.vR.stu, pt.pit.vR.stu), pbabip: applyAffine(o.ratings.pit.vR.pbabip, pt.pit.vR.pbabip), hrr: applyAffine(o.ratings.pit.vR.hrr, pt.pit.vR.hrr) };
    const e = rp.predictPitching(rat, coeffs); const k = pitchingComponents(e, 1, 1, "vR", coeffs, derived, ef);
    const predBB = k.BB_fin, actBB = per600(o.actual.pit.uBB * o.bf / 600, o.bf); // actual uBB/600 already
    return { con: conRaw, scale: conLift - conRaw, uBBbias: predBB - o.actual.pit.uBB, overVal: cv.real[i]! - (alpha + beta * cv.pred[i]!), w: cv.w[i]! };
  });
  const sorted = [...rows].sort((a, b) => a.con - b.con); const n = sorted.length, th = Math.floor(n / 3);
  const bins: [string, typeof rows][] = [["LOW con", sorted.slice(0, th)], ["MID con", sorted.slice(th, 2 * th)], ["HIGH con", sorted.slice(2 * th)]];
  console.log(`==== ${name} (N=${n}) ====`);
  for (const [bn, arr] of bins) {
    const w = arr.map((r) => r.w);
    console.log(`  ${bn.padEnd(8)} con[${arr[0]!.con.toFixed(0)}-${arr[arr.length - 1]!.con.toFixed(0)}]  scaleΔ +${wmean(arr.map((r) => r.scale), w).toFixed(0)}  uBB bias ${f(wmean(arr.map((r) => r.uBBbias), w))}  VALUE over-rate ${(wmean(arr.map((r) => r.overVal), w) * 1000).toFixed(2)} mwOBA`);
  }
}
console.log(`\nRead: if HIGH-con shows the most-NEGATIVE uBB bias (predicts fewest walks vs actual) and the most-POSITIVE value`);
console.log(`over-rate, AND that tracks the scaleΔ lift, the claim holds — high-CON pitchers scaled up at low tiers are over-valued.`);
process.exit(0);
