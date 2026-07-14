// P1 — winner-vs-pareto two-axis CONFIRMING check, FULL paired metric set (Fable correction 2: never a single
// metric — spacing is co-equal with order). winner = pit rawquad-ALL+aux (0.78 in-frame, BB non-monotone);
// pareto = {HR,K,H}+aux (0.74, BB log, clean gate). own-gap, reliable ladder + in-frame. Reports, PAIRED:
// gapDistortionRmse (spacing distortion, affine-invariant), deconvolved value spread, ΔtopN-overlap, Δregret —
// with bootstrap CIs on Δregret and Δspread. Expected: pareto within CI of winner on every axis ⇒ the
// tie-out-of-frame decision (ship pareto for the clean gate) holds.
//   run: node tools/p1-winner-vs-pareto.ts
import { readFileSync, existsSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import { applyWobaWeights, makeRawPolyModel, computeUnifiedFieldStats, buildPoolTransform } from "../src/scoring-core/index.ts";
import { loadTournamentOutcomes, tournamentExposure, tournamentCardValues, type TournamentObs, type CardValues } from "../src/training/tournament-eval.ts";
import { wobaWeightsFromCoeffs } from "../src/scoring-core/woba-weights.ts";
import { evalMetrics, gapDistortionRmse } from "../src/training/metrics.ts";
import { loadWindow, type TrainObs } from "../src/training/loader.ts";
import { fitHitForm, fitPitForm, RAWPOLY_HIT, STUFFAUG_PIT, type PitForm } from "../src/training/forms.ts";
import { cleanTournamentRows } from "../src/eval/tournament-clean.ts";
import { parseCatalogCsv } from "../src/data/catalog.ts";
import { rowEligible } from "../src/config/eligibility.ts";

const R2 = { kind: "rawpoly", degree: 2 } as const, LOGc = { kind: "log" } as const;
const FIELD_N = 50, TH = 250, TOPN = 20, NB = 400;
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
const hitFit = fitHitForm(RAWPOLY_HIT, lgObs);
const WINNER: PitForm = { ...(STUFFAUG_PIT as PitForm), name: "winner", bb: R2, k: R2, hr: R2, h: R2, stuffAug: true };
const PARETO: PitForm = { ...(STUFFAUG_PIT as PitForm), name: "pareto", bb: LOGc, k: R2, hr: R2, h: R2, stuffAug: true };
const efW = { hit: hitFit, pit: fitPitForm(WINNER, lgObs) }, efP = { hit: hitFit, pit: fitPitForm(PARETO, lgObs) };
const rp = makeRawPolyModel(efP); // pareto rp for the field/transform (form-robust)

const wvar = (x: number[], wt: number[]) => { const sw = wt.reduce((a, b) => a + b, 0); const m = x.reduce((a, v, i) => a + wt[i]! * v, 0) / sw; return x.reduce((a, v, i) => a + wt[i]! * (v - m) ** 2, 0) / sw; };
const wmean = (x: number[], wt: number[]) => { const sw = wt.reduce((a, b) => a + b, 0); return x.reduce((a, v, i) => a + wt[i]! * v, 0) / sw; };
const dspread = (cv: CardValues, se: number[]) => Math.sqrt(wvar(cv.pred, cv.w)) / Math.sqrt(Math.max(wvar(cv.real, cv.w) - wmean(se.map((s) => s * s), cv.w), 1e-9));
const f = (n: number) => (Number.isFinite(n) ? (n >= 0 ? " " : "") + n.toFixed(4) : "  n/a");

console.log(`P1 — winner vs pareto, FULL paired metric set (own-gap, pit). gapRMSE=spacing distortion (↓), dec-spread (target`);
console.log(`= in-frame: winner 0.78 / pareto 0.74), overlap/regret=order. Paired-bootstrap Δ(winner−pareto) CIs.\n`);
for (const [name, dir, TID] of [
  ["EG-clean", "Tournament Data/Early Gold", "early-gold"],
  ["Bronze-t", "Tournament Data/Return of the Bronze", "bronze-return"],
  ["Bronze-q", "Tournament Data/Quicks - Bronze", "bronze-quick"],
  ["Gold-q", "Tournament Data/Quicks - Gold", "gold-quick"],
] as const) {
  if (!existsSync(dir)) continue;
  const t = (await repo.loadAll<Tournament>("tournaments")).find((x) => x.id === TID)!;
  const coeffs = resolveCoeffs(model, eras.get(t.eraId)!, parks.get(t.parkId)!, t.softcaps);
  if (trained.wobaWeights) applyWobaWeights(coeffs, trained.wobaWeights);
  const ww = wobaWeightsFromCoeffs(coeffs);
  const inV = (c: any) => { const v = Number(c["Card Value"]) || 0; return (t.card_value_min == null || v >= t.card_value_min) && (t.card_value_max == null || v <= t.card_value_max); };
  const basePool = cat.cards.filter((c: any) => isB(c) && inV(c) && rowEligible(c as any, t));
  const refField = computeUnifiedFieldStats(cat.cards.filter(isB), coeffs, rp, FIELD_N, true);
  const poolField = computeUnifiedFieldStats(basePool, coeffs, rp, FIELD_N, true);
  const own = { poolTransform: buildPoolTransform(refField, poolField, trained.ratingEnvelope ?? undefined) };
  const obs = loadTournamentOutcomes(dir, { clean: (rows) => cleanTournamentRows(rows).cleaned });
  const exposure = tournamentExposure(obs);
  const seR = (a: any, d: number) => { const t2: [number, number][] = [[ww.bb, a.uBB / 600], [ww.b1, (a.HmHR - (a.XBH ?? 0)) / 600], [ww.xbh, (a.XBH ?? 0) / 600], [ww.hr, a.HR / 600]]; const E = t2.reduce((s, [w2, p]) => s + w2 * p, 0), E2 = t2.reduce((s, [w2, p]) => s + w2 * w2 * p, 0); return d > 0 ? Math.sqrt(Math.max(E2 - E * E, 0) / d) : 0; };
  const sePit = obs.filter((o: TournamentObs) => o.bf >= TH).map((o) => seR(o.actual.pit, o.bf));
  const w = tournamentCardValues(obs, { coeffs, eventForm: efW, ...own }, exposure, { minPA: TH, minBF: TH }).pit;
  const p = tournamentCardValues(obs, { coeffs, eventForm: efP, ...own }, exposure, { minPA: TH, minBF: TH }).pit;
  if (w.pred.length < 6) { console.log(`${name}: thin`); continue; }
  const mW = evalMetrics(w.pred, w.real, w.w, false, TOPN), mP = evalMetrics(p.pred, p.real, p.w, false, TOPN);
  const gapW = gapDistortionRmse(w.pred, w.real, w.w), gapP = gapDistortionRmse(p.pred, p.real, p.w);
  // paired Δregret + Δspread bootstrap
  const dR: number[] = [], dS: number[] = [];
  for (let b = 0; b < NB; b++) { const idx = Array.from({ length: w.pred.length }, () => Math.floor(Math.random() * w.pred.length));
    const sub = (cv: CardValues) => ({ pred: idx.map((i) => cv.pred[i]!), real: idx.map((i) => cv.real[i]!), w: idx.map((i) => cv.w[i]!) });
    const se2 = idx.map((i) => sePit[i]!);
    dR.push(evalMetrics(sub(w).pred, sub(w).real, sub(w).w, false, TOPN).valueRegret - evalMetrics(sub(p).pred, sub(p).real, sub(p).w, false, TOPN).valueRegret);
    dS.push(dspread(sub(w), se2) - dspread(sub(p), se2));
  }
  dR.sort((a, b) => a - b); dS.sort((a, b) => a - b);
  console.log(`==== ${name} N=${mW.n} ====`);
  console.log(`  spacing: gapRMSE win ${f(gapW)} / par ${f(gapP)}   dec-spread win ${f(dspread(w, sePit))} / par ${f(dspread(p, sePit))}`);
  console.log(`  order:   regret win ${f(mW.valueRegret)} / par ${f(mP.valueRegret)}   overlap win ${f(mW.topNOverlap)} / par ${f(mP.topNOverlap)}   ρ ${f(mW.spearman)}/${f(mP.spearman)}`);
  console.log(`  paired Δ(win−par): regret ${f(dR[Math.floor(0.5 * NB)]!)} [${f(dR[Math.floor(0.025 * NB)]!)},${f(dR[Math.floor(0.975 * NB)]!)}]   spread ${f(dS[Math.floor(0.5 * NB)]!)} [${f(dS[Math.floor(0.025 * NB)]!)},${f(dS[Math.floor(0.975 * NB)]!)}]`);
}
console.log(`\nRead: every paired Δ CI spanning 0 ⇒ winner and pareto are indistinguishable out-of-frame on BOTH axes ⇒ the`);
console.log(`clean-gate tie-breaker stands (ship pareto). Any CI-clear winner advantage ⇒ reweigh vs BB's cap dependency.`);
process.exit(0);
