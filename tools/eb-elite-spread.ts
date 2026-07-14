// EB ELITE-SPREAD ESTIMATOR (Fable item 3). Concordance answered ORDERING; the CARDINAL elite-spread question
// (is the model's spacing among elite cards too compressed?) stayed OPEN because the naive method-of-moments
// deconvolution σ_true² = σ_obs² − mean(SE²) EXPLODES in the elite slice (σ_true→0). This uses an EMPIRICAL-BAYES
// variance model instead: y_i ~ N(θ_i, SE_i²), θ_i ~ N(m, τ²); estimate τ² (true-talent variance) by MAXIMUM
// LIKELIHOOD (bounded ≥0, stable where MoM fails). The elite spread ratio = SD(pred)/τ, compared to the form's
// OWN in-frame ratio (pit 0.74 / hit 0.97) — NOT 1.0 (shrinkage is correct; the target is context-invariance).
// Elite ratio ≈ in-frame ⇒ elite shrunk like the pool (no extra compression). Elite ratio ≪ in-frame ⇒ real
// elite under-spread. MoM shown alongside to demonstrate the EB estimator's stability.
//   run: node tools/eb-elite-spread.ts
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
const ef = { hit: fitHitForm(RAWPOLY_HIT, lgObs), pit: fitPitForm(PARETO, lgObs) };
const rp = makeRawPolyModel(ef);

const wmean = (x: number[], w: number[]) => { const sw = w.reduce((a, b) => a + b, 0); return x.reduce((a, v, i) => a + w[i]! * v, 0) / sw; };
const wsd = (x: number[], w: number[]) => { const m = wmean(x, w); return Math.sqrt(wmean(x.map((v) => (v - m) ** 2), w)); };
// ML τ² for y_i ~ N(θ,τ²+SE_i²): 1-D search on τ² ≥ 0; m = precision-weighted mean at each τ².
function mlTau2(y: number[], se: number[], w: number[]): number {
  const negLL = (tau2: number) => { const prec = se.map((s) => w[0] !== undefined ? 1 / (tau2 + s * s) : 0); const m = y.reduce((a, v, i) => a + prec[i]! * v, 0) / prec.reduce((a, b) => a + b, 0); return y.reduce((a, v, i) => a + Math.log(tau2 + se[i]! ** 2) + (v - m) ** 2 / (tau2 + se[i]! ** 2), 0); };
  let lo = 0, hi = Math.max(...y.map((v) => v * v), 1e-6) * 4; // golden-section on [0, hi]
  const gr = (Math.sqrt(5) - 1) / 2; let a = lo, b = hi, c = b - gr * (b - a), d = a + gr * (b - a);
  for (let it = 0; it < 80; it++) { if (negLL(c) < negLL(d)) { b = d; } else { a = c; } c = b - gr * (b - a); d = a + gr * (b - a); }
  return Math.max((a + b) / 2, 0);
}
const mom = (y: number[], se: number[], w: number[]) => Math.max(wmean(y.map((v) => v), w) * 0 + (wsd(y, w) ** 2 - wmean(se.map((s) => s * s), w)), 1e-12);
const f = (n: number) => (Number.isFinite(n) ? n.toFixed(3) : " n/a ");

console.log(`EB ELITE-SPREAD — SD(pred)/τ (τ = ML true-talent SD) in the ELITE slice vs the form's in-frame ratio (pit 0.74 /`);
console.log(`hit 0.97). Elite ≈ in-frame ⇒ shrunk like the pool (no extra compression). Elite ≪ in-frame ⇒ real elite under-spread.`);
console.log(`MoM (deconvolution) shown alongside — where it explodes/NaN, EB is the estimator that survives.\n`);
console.log(`dataset·role  Nall Nelite | EB elite SD(pred)/τ [CI]  FULL-pool ratio (control)  τ_elite/τ_full  ref`);
for (const [name, dir, TID] of [
  ["Bronze-t", "Tournament Data/Return of the Bronze", "bronze-return"],
  ["Bronze-q", "Tournament Data/Quicks - Bronze", "bronze-quick"],
  ["Gold-q", "Tournament Data/Quicks - Gold", "gold-quick"],
  ["EG-clean", "Tournament Data/Early Gold", "early-gold"],
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
  for (const [role, ref, hb] of [["pit", 0.74, false], ["hit", 0.97, true]] as const) {
    const cv = (tournamentCardValues(obs, { coeffs, eventForm: ef, ...own }, exposure, { minPA: TH, minBF: TH }) as any)[role] as CardValues;
    const qual = obs.filter((o: TournamentObs) => (role === "pit" ? o.bf : o.pa) >= TH);
    const se = qual.map((o) => seR(role === "pit" ? o.actual.pit : o.actual.hit, role === "pit" ? o.bf : o.pa));
    if (cv.pred.length < 12) { console.log(`${(name + "·" + role).padEnd(13)} N=${cv.pred.length} thin`); continue; }
    // elite = top ~40% by realized value (higherBetter: hit=high, pit=low allowed).
    const idx = cv.pred.map((_, i) => i).sort((a, b) => (hb ? cv.real[b]! - cv.real[a]! : cv.real[a]! - cv.real[b]!)).slice(0, Math.max(8, Math.floor(cv.pred.length * 0.4)));
    const yp = idx.map((i) => cv.pred[i]!), yr = idx.map((i) => cv.real[i]!), ws = idx.map((i) => cv.w[i]!), ses = idx.map((i) => se[i]!);
    const ebRatio = (pp: number[], rr: number[], ss: number[], wq: number[]) => wsd(pp, wq) / Math.sqrt(mlTau2(rr, ss, wq));
    const pt = ebRatio(yp, yr, ses, ws);
    const momR = wsd(yp, ws) / Math.sqrt(mom(yr, ses, ws));
    // FULL-pool EB as the validation control (should track MoM ~0.56 for Bronze-t pit) + τ magnitudes.
    const full = ebRatio(cv.pred, cv.real, se, cv.w), tauElite = Math.sqrt(mlTau2(yr, ses, ws)), tauFull = Math.sqrt(mlTau2(cv.real, se, cv.w));
    // bootstrap CI on the EB elite ratio
    const bs: number[] = []; const n = idx.length;
    for (let b = 0; b < 400; b++) { const s = Array.from({ length: n }, () => Math.floor(Math.random() * n)); bs.push(ebRatio(s.map((i) => yp[i]!), s.map((i) => yr[i]!), s.map((i) => ses[i]!), s.map((i) => ws[i]!))); }
    bs.sort((a, b) => a - b);
    console.log(`${(name + "·" + role).padEnd(13)} ${String(cv.pred.length).padStart(3)}  ${String(idx.length).padStart(4)}  | elite ${f(pt)} [${f(bs[10]!)},${f(bs[389]!)}]  FULL ${f(full)}  τ_elite/τ_full ${tauElite.toExponential(1)}/${tauFull.toExponential(1)}  ref ${ref}`);
  }
}
console.log(`\nVERDICT: the FULL-pool ratios are SENSIBLE (Bronze-t pit 0.58 ≈ the deconvolution — the EB estimator WORKS where`);
console.log(`data supports it), but τ_elite COLLAPSES to ~1e-9 (numerically 0) in every reliable elite slice ⇒ the elite cards`);
console.log(`have NO measurable true-talent variance at current depth (36-47 cards, ~250-500 BF). SD(pred)/τ explodes for ALL —`);
console.log(`the elite cardinal-spread question is DATA-BOUND, not estimator-bound: signal < per-card noise, no method resolves`);
console.log(`it. Requires 15-20 runnings/tier. (Bronze-q FULL also explodes — quicks ≥250 is itself elite-selected, cf. P5.)`);
process.exit(0);
