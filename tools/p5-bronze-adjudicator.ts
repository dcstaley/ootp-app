// P5 — BRONZE-QUICKS CEILING ADJUDICATOR (+ concordance, the range-restriction-robust instrument).
// Bronze-quicks = the SAME ≤69 pool as Bronze-t, neutral era, now powered (9 runnings / 41.8k PA). BUT a
// card reaches ≥500 BF only by being STAPLED across many Bo5 runnings ⇒ the qualifying set is elite-usage
// SELECTED ⇒ true-talent range restricted ⇒ σ_true→0 ⇒ the deconvolved SPREAD ratio explodes (the item-8
// warning + the top-decile pathology). So we report BOTH: (a) the deconvolved spread across a threshold
// SWEEP (to show WHERE it breaks), and (b) WEIGHTED CONCORDANCE — the fraction of realized-value-ordered
// pairs the model orders correctly (Somers-D / rank-AUC style), which needs NO σ_true and survives range
// restriction. Concordance answers "does the model DISCRIMINATE the elite?" even when spread can't be read.
//   Shipped pareto {HR,K,H}+aux + own-gap. In-frame pit ~0.74. Bronze-t (single 128-team) shown for contrast.
//   run: node tools/p5-bronze-adjudicator.ts
import { readFileSync, existsSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import { applyWobaWeights, makeRawPolyModel, computeUnifiedFieldStats, buildPoolTransform } from "../src/scoring-core/index.ts";
import { loadTournamentOutcomes, tournamentExposure, tournamentCardValues, type TournamentObs, type CardValues } from "../src/training/tournament-eval.ts";
import { wobaWeightsFromCoeffs } from "../src/scoring-core/woba-weights.ts";
import { loadWindow, type TrainObs } from "../src/training/loader.ts";
import { fitHitForm, fitPitForm, RAWPOLY_HIT, STUFFAUG_PIT, type PitForm } from "../src/training/forms.ts";
import { cleanTournamentRows } from "../src/eval/tournament-clean.ts";
import { parseCatalogCsv } from "../src/data/catalog.ts";
import { rowEligible } from "../src/config/eligibility.ts";

const R2 = { kind: "rawpoly", degree: 2 } as const, LOGc = { kind: "log" } as const;
const FIELD_N = 50;
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
const ef = { hit: fitHitForm(RAWPOLY_HIT, lgObs), pit: fitPitForm(PARETO, lgObs) };
const rp = makeRawPolyModel(ef);

const wvar = (x: number[], wt: number[]) => { const sw = wt.reduce((a, b) => a + b, 0); const m = x.reduce((a, v, i) => a + wt[i]! * v, 0) / sw; return x.reduce((a, v, i) => a + wt[i]! * (v - m) ** 2, 0) / sw; };
const wmean = (x: number[], wt: number[]) => { const sw = wt.reduce((a, b) => a + b, 0); return x.reduce((a, v, i) => a + wt[i]! * v, 0) / sw; };
const rawSpread = (cv: CardValues) => Math.sqrt(wvar(cv.pred, cv.w)) / Math.sqrt(Math.max(wvar(cv.real, cv.w), 1e-12));
const decSpread = (cv: CardValues, se: number[]) => Math.sqrt(wvar(cv.pred, cv.w)) / Math.sqrt(Math.max(wvar(cv.real, cv.w) - wmean(se.map((s) => s * s), cv.w), 1e-9));
// Weighted concordance: over pairs (i<j) with real_i≠real_j, weight = |Δreal|·min(w_i,w_j); fraction where
// the model orders them the SAME way as realized (higherBetter handles pit sign). Range-restriction-robust,
// no σ_true. Elite = restrict to the top-K by realized value.
function concordance(cv: CardValues, higherBetter: boolean, eliteK?: number) {
  let idx = cv.pred.map((_, i) => i);
  if (eliteK) { const val = (i: number) => (higherBetter ? cv.real[i]! : -cv.real[i]!); idx = [...idx].sort((a, b) => val(b) - val(a)).slice(0, eliteK); }
  let cw = 0, tw = 0;
  for (let a = 0; a < idx.length; a++) for (let b = a + 1; b < idx.length; b++) {
    const i = idx[a]!, j = idx[b]!; const dr = cv.real[i]! - cv.real[j]!; if (Math.abs(dr) < 1e-12) continue;
    const dp = cv.pred[i]! - cv.pred[j]!; const w = Math.abs(dr) * Math.min(cv.w[i]!, cv.w[j]!); tw += w;
    if (Math.sign(dp) === Math.sign(dr)) cw += w; // higherBetter irrelevant: same-sign in wOBA space both roles
  }
  return tw > 0 ? cw / tw : NaN;
}
const NB = 400;
function bootDec(cv: CardValues, se: number[]) { const pt = decSpread(cv, se), n = cv.pred.length, bs: number[] = []; for (let b = 0; b < NB; b++) { const idx = Array.from({ length: n }, () => Math.floor(Math.random() * n)); bs.push(decSpread({ pred: idx.map((i) => cv.pred[i]!), real: idx.map((i) => cv.real[i]!), w: idx.map((i) => cv.w[i]!) }, idx.map((i) => se[i]!))); } bs.sort((a, b) => a - b); return { lo: bs[Math.floor(0.025 * NB)]!, hi: bs[Math.floor(0.975 * NB)]! }; }
const f = (n: number) => (Number.isFinite(n) ? n.toFixed(3) : " n/a ");

console.log(`P5 — bronze-quicks ceiling adjudicator. SHIPPED pareto {HR,K,H}+aux + own-gap. In-frame pit ~0.74.`);
console.log(`SPREAD (raw + deconvolved [CI]) sweeps thresholds to show the range-restriction blow-up; CONCORDANCE is the`);
console.log(`robust elite-discrimination read (fraction of realized-ordered pairs the model orders right; 0.5 = chance).\n`);

for (const [name, dir, TID] of [
  ["Bronze-quicks", "Tournament Data/Quicks - Bronze", "bronze-quick"],
  ["Bronze-t (128-team, 3 run.)", "Tournament Data/Return of the Bronze", "bronze-return"],
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
  console.log(`==== ${name} (era ${t.eraId}) ====`);
  for (const TH of [100, 250, 500]) {
    const cv = tournamentCardValues(obs, { coeffs, eventForm: ef, ...own }, exposure, { minPA: TH, minBF: TH }).pit;
    if (cv.pred.length < 6) { console.log(`  PIT ≥${TH}: N=${cv.pred.length} thin`); continue; }
    const se = obs.filter((o: TournamentObs) => o.bf >= TH).map((o) => seR(o.actual.pit, o.bf));
    const ci = bootDec(cv, se);
    const conc = concordance(cv, false), eliteK = Math.max(6, Math.floor(cv.pred.length * 0.4)), concE = concordance(cv, false, eliteK);
    console.log(`  PIT ≥${TH} N=${String(cv.pred.length).padStart(3)}: raw ${f(rawSpread(cv))}  dec ${f(decSpread(cv, se))} [${f(ci.lo)},${f(ci.hi)}]  meanSE ${f(Math.sqrt(wmean(se.map((s) => s * s), cv.w)))}  | concordance all ${f(conc)}  elite-top${eliteK} ${f(concE)}`);
  }
}
console.log(`\nVERDICT: if the deconvolved SPREAD is unreadable on bronze-quicks (explodes/CI spans all) while CONCORDANCE is`);
console.log(`well above 0.5 (esp. elite), the model DISCRIMINATES the ≤69 elite correctly — the low Bronze-t point was a`);
console.log(`range-restriction/noise artifact, NOT a real under-separation. Low concordance ⇒ a real ≤69 defect → escalate P3.`);
process.exit(0);
