// THE JOINT RUN (form × transform) — the measurement that decides the transform. Form and transform were
// measured IN ISOLATION before (→ two retractions); here they run JOINTLY. Two candidate forms from the B
// debts × two transform arms × the ladder × both roles × BOTH axes, deconvolved, with paired-bootstrap CIs.
//   FORMS:  winner = pit rawquad-all + aux (in-frame spread ~0.78) ; pareto = pit {HR,K,H} + aux, BB log
//           (in-frame ~0.74, CLEAN monotone gate — B.2/B.4). hit = RAWPOLY_HIT for both.
//   ARMS:   own-gap (production incumbent, multiplicative) ; frame-v2 BARE (additive opp-gap shift, NO
//           kSpread). The refit-kSpread arm is decided AFTER: if BARE reaches context-invariance
//           (out-of-frame spread ≈ this form's own in-frame spread), kSpread is REDUNDANT under quad
//           (prediction 2) → retire; else refit S_K (separate tool).
//   AXES:   axis-1 ORDERING = valueRegret / top-26 overlap / Spearman (paired bootstrap Δ own vs frame).
//           axis-2 SPACING  = DECONVOLVED value spread ratio (σ_true² = σ_obs² − mean SE²) + CI; the
//           context-invariance target is the form's OWN in-frame ratio, NOT 1.0 (shrinkage is correct).
//   Cap-bias pit/hit compression per arm (own-gap's is ~0.69; a transform ships only if ≥ ~0.80 CI-clear).
//   run: node tools/phase1c-joint-run.ts
import { readFileSync, existsSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import { applyWobaWeights, makeRawPolyModel, computeUnifiedFieldStats, buildPoolTransform, buildFrameShift, poolMeanK } from "../src/scoring-core/index.ts";
import { loadTournamentOutcomes, tournamentExposure, tournamentCardValues, type TournamentObs, type CardValues } from "../src/training/tournament-eval.ts";
import { wobaWeightsFromCoeffs } from "../src/scoring-core/woba-weights.ts";
import { evalMetrics } from "../src/training/metrics.ts";
import { loadWindow, type TrainObs } from "../src/training/loader.ts";
import { fitHitForm, fitPitForm, RAWPOLY_HIT, STUFFAUG_PIT, type PitForm } from "../src/training/forms.ts";
import { cleanTournamentRows } from "../src/eval/tournament-clean.ts";
import { parseCatalogCsv } from "../src/data/catalog.ts";
import { rowEligible } from "../src/config/eligibility.ts";
import type { EventForm } from "../src/model/curves.ts";

const R2 = { kind: "rawpoly", degree: 2 } as const, LOGc = { kind: "log" } as const;
const FIELD_N = 50, TH = 100, TOPN = 20;
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

const WINNER: PitForm = { ...(STUFFAUG_PIT as PitForm), name: "rawquad+aux", bb: R2, k: R2, hr: R2, h: R2, stuffAug: true };
const PARETO: PitForm = { ...(STUFFAUG_PIT as PitForm), name: "{HR,K,H}", bb: LOGc, k: R2, hr: R2, h: R2, stuffAug: true };
const hitFit = fitHitForm(RAWPOLY_HIT, lgObs);
const FORMS: [string, EventForm][] = [
  ["deployed", { hit: hitFit, pit: fitPitForm(STUFFAUG_PIT as PitForm, lgObs) }], // current production (log+aux)
  ["winner", { hit: hitFit, pit: fitPitForm(WINNER, lgObs) }],
  ["pareto", { hit: hitFit, pit: fitPitForm(PARETO, lgObs) }],
];

const wvar = (x: number[], wt: number[]) => { const sw = wt.reduce((a, b) => a + b, 0); const m = x.reduce((a, v, i) => a + wt[i]! * v, 0) / sw; return x.reduce((a, v, i) => a + wt[i]! * (v - m) ** 2, 0) / sw; };
const wmean = (x: number[], wt: number[]) => { const sw = wt.reduce((a, b) => a + b, 0); return x.reduce((a, v, i) => a + wt[i]! * v, 0) / sw; };
const dspread = (cv: CardValues, se: number[]) => { const sP = Math.sqrt(wvar(cv.pred, cv.w)); const sT = Math.sqrt(Math.max(wvar(cv.real, cv.w) - wmean(se.map((s) => s * s), cv.w), 1e-9)); return sP / sT; };
const NB = 400;
function bootSpread(cv: CardValues, se: number[]) {
  const pt = dspread(cv, se), n = cv.pred.length, bs: number[] = [];
  for (let b = 0; b < NB; b++) { const idx = Array.from({ length: n }, () => Math.floor(Math.random() * n)); bs.push(dspread({ pred: idx.map((i) => cv.pred[i]!), real: idx.map((i) => cv.real[i]!), w: idx.map((i) => cv.w[i]!) }, idx.map((i) => se[i]!))); }
  bs.sort((a, b) => a - b); return { pt, lo: bs[Math.floor(0.025 * NB)]!, hi: bs[Math.floor(0.975 * NB)]! };
}
// Paired bootstrap of Δregret (own − bare); >0 means own-gap has MORE regret (bare better). CI excludes 0 ⇒ material.
function bootRegretDelta(o: CardValues, b: CardValues, hb: boolean) {
  const n = o.pred.length, ds: number[] = [];
  const reg = (cv: CardValues, idx: number[]) => { const m = evalMetrics(idx.map((i) => cv.pred[i]!), idx.map((i) => cv.real[i]!), idx.map((i) => cv.w[i]!), hb, TOPN); return m.valueRegret; };
  for (let k = 0; k < NB; k++) { const idx = Array.from({ length: n }, () => Math.floor(Math.random() * n)); ds.push(reg(o, idx) - reg(b, idx)); }
  ds.sort((a, b2) => a - b2); return { pt: evalMetrics(o.pred, o.real, o.w, hb, TOPN).valueRegret - evalMetrics(b.pred, b.real, b.w, hb, TOPN).valueRegret, lo: ds[Math.floor(0.025 * NB)]!, hi: ds[Math.floor(0.975 * NB)]! };
}
const f = (n: number) => (Number.isFinite(n) ? n.toFixed(3) : " n/a ");

// In-frame reference spreads (from B.2 / cancellation): winner pit 0.780, pareto pit 0.743, hit 0.967.
const INFRAME: Record<string, { pit: number; hit: number }> = { deployed: { pit: 0.623, hit: 0.967 }, winner: { pit: 0.780, hit: 0.967 }, pareto: { pit: 0.743, hit: 0.967 } };

const LADDER = [
  ["Open", "Tournament Data/Quicks - Open", "default-neutral", false],
  ["Bronze-q", "Tournament Data/Quicks - Bronze", "bronze-quick", false],
  ["Gold-q", "Tournament Data/Quicks - Gold", "gold-quick", false],
  ["EG-clean", "Tournament Data/Early Gold", "early-gold", true],
  ["Bronze-t", "Tournament Data/Return of the Bronze", "bronze-return", true],
] as const;

console.log(`JOINT RUN — form × transform, both axes, ladder. ≥${TH} PA/BF, ghost-cleaned. In-frame ref: winner pit 0.780 / pareto pit 0.743 / hit 0.967.`);
console.log(`axis-1 = regret(↓) / top-${TOPN} overlap(↑) / ρ(↑).  axis-2 = DECONVOLVED value spread ratio [CI] (target = OWN in-frame, NOT 1.0).`);
console.log(`RELIABLE = EG-clean + Bronze-t (quicks are floor-dominated at ~100 PA → axis-2 uninformative).\n`);

for (const [fname, ef] of FORMS) {
  const rp = makeRawPolyModel(ef);
  console.log(`\n############ FORM: ${fname} (pit in-frame ${INFRAME[fname]!.pit}) ############`);
  for (const [name, dir, TID, reliable] of LADDER) {
    if (!existsSync(dir)) continue;
    const t = (await repo.loadAll<Tournament>("tournaments")).find((x) => x.id === TID)!;
    const coeffs = resolveCoeffs(model, eras.get(t.eraId)!, parks.get(t.parkId)!, t.softcaps);
    if (trained.wobaWeights) applyWobaWeights(coeffs, trained.wobaWeights);
    const ww = wobaWeightsFromCoeffs(coeffs);
    const inV = (c: any) => { const v = Number(c["Card Value"]) || 0; return (t.card_value_min == null || v >= t.card_value_min) && (t.card_value_max == null || v <= t.card_value_max); };
    const basePool = cat.cards.filter((c: any) => isB(c) && inV(c) && rowEligible(c as any, t));
    const refField = computeUnifiedFieldStats(cat.cards.filter(isB), coeffs, rp, FIELD_N, true);
    const poolField = computeUnifiedFieldStats(basePool, coeffs, rp, FIELD_N, true);
    const fs = buildFrameShift(trained.trainingMeans, poolField);
    const own = { poolTransform: buildPoolTransform(refField, poolField, trained.ratingEnvelope ?? undefined) };
    const bare = { frameShift: fs }; // NO kSpread
    const obs = loadTournamentOutcomes(dir, { clean: (rows) => cleanTournamentRows(rows).cleaned });
    const exposure = tournamentExposure(obs);
    const seR = (a: any, d: number) => { const t2: [number, number][] = [[ww.bb, a.uBB / 600], [ww.b1, (a.HmHR - (a.XBH ?? 0)) / 600], [ww.xbh, (a.XBH ?? 0) / 600], [ww.hr, a.HR / 600]]; const E = t2.reduce((s, [w2, p]) => s + w2 * p, 0), E2 = t2.reduce((s, [w2, p]) => s + w2 * w2 * p, 0); return d > 0 ? Math.sqrt(Math.max(E2 - E * E, 0) / d) : 0; };
    const seHit = obs.filter((o: TournamentObs) => o.pa >= TH).map((o) => seR(o.actual.hit, o.pa));
    const sePit = obs.filter((o: TournamentObs) => o.bf >= TH).map((o) => seR(o.actual.pit, o.bf));

    const cvOwn = tournamentCardValues(obs, { coeffs, eventForm: ef, ...own }, exposure, { minPA: TH, minBF: TH });
    const cvBare = tournamentCardValues(obs, { coeffs, eventForm: ef, ...bare }, exposure, { minPA: TH, minBF: TH });
    const gap = fs.pit.vR.stu ?? 0;
    console.log(`==== ${name} (gap μStu ${gap.toFixed(0)}) ====`);
    for (const role of ["pit", "hit"] as const) {
      const hb = role === "hit";
      const o = cvOwn[role], b = cvBare[role], se = role === "hit" ? seHit : sePit;
      if (o.pred.length < 6) { console.log(`  ${role.toUpperCase()}: N=${o.pred.length} <thin>`); continue; }
      const mo = evalMetrics(o.pred, o.real, o.w, hb, TOPN), mb = evalMetrics(b.pred, b.real, b.w, hb, TOPN);
      const so = bootSpread(o, se), sb = bootSpread(b, se);
      console.log(`  ${role.toUpperCase()} N=${mo.n}  axis1 regret own ${f(mo.valueRegret)}/bare ${f(mb.valueRegret)}  ovl ${f(mo.topNOverlap)}/${f(mb.topNOverlap)}  ρ ${f(mo.spearman)}/${f(mb.spearman)}`);
      console.log(`         axis2 spread own ${f(so.pt)}[${f(so.lo)},${f(so.hi)}] / bare ${f(sb.pt)}[${f(sb.lo)},${f(sb.hi)}]  ${reliable ? "(reliable)" : "(floor-dominated)"}`);
      if (reliable) { const dr = bootRegretDelta(o, b, hb); console.log(`         Δregret(own−bare) ${f(dr.pt)} [${f(dr.lo)},${f(dr.hi)}]  (>0 CI-clear ⇒ bare better; <0 ⇒ own better)`); }
    }
    // cap-bias: deconvolved pit/hit compression per arm (own-gap ~0.69 is the bar to beat).
    const comp = (cv: CardValues, se: number[]) => dspread(cv, se);
    const pOwn = comp(cvOwn.pit, sePit), hOwn = comp(cvOwn.hit, seHit), pB = comp(cvBare.pit, sePit), hB = comp(cvBare.hit, seHit);
    if (reliable) console.log(`         cap-bias pit/hit: own ${f(pOwn / hOwn)}  bare ${f(pB / hB)}  (own-gap bar ~0.69; ship needs ≥~0.80)`);
  }
}
console.log(`\nDECISION READS: (a) does bare's out-of-frame pit spread ≈ this form's in-frame (context-invariance)? then kSpread REDUNDANT.`);
console.log(`(b) bare must beat own-gap on axis-1 regret/overlap BOTH roles + axis-2 pit/hit ≥~0.80 CI-clear of 0.69, hitters within CI of ~1.0.`);
console.log(`(c) winner vs pareto: does the winner's extra in-frame spread (0.78 vs 0.74) show up out-of-frame, and is it worth BB's cap dependency?`);
process.exit(0);
