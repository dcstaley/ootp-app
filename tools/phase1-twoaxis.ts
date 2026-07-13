// PHASE-1 TWO-AXIS acceptance + CAP-BIAS readout (plan §11.19 gate revision, Fable's cardinal-value
// correction). The optimizer consumes CARDINAL VALUES, not ranks → judge on BOTH axes, on assembled
// value (wOBA; the D2 signed distance is an affine of it, so spacing is identical):
//   AXIS 1 ORDERING — value-regret + top-N overlap (primary), Spearman (secondary).
//   AXIS 2 SPACING  — spread ratio SD(pred)/SD(actual) [target ~1.0] + gapDistortionRmse (affine-
//                     invariant, from src/training/metrics.ts).
// Plus the CROSS-ROLE CAP-BIAS readout: predicted-vs-actual value spread (p90−p50) for pit vs hit —
// compressed pitcher spread tilts cap dollars to hitters via D2. Reported for own-gap (LIVE production)
// and s(gap). own vs s(gap): expect own wins axis 1, s(gap) wins axis 2 — neither deployable alone.
//   run: node tools/phase1-twoaxis.ts
import { readFileSync, existsSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import { applyWobaWeights, makeRawPolyModel, computeUnifiedFieldStats, buildPoolTransform, buildFrameShift, poolMeanK } from "../src/scoring-core/index.ts";
import { loadTournamentOutcomes, tournamentExposure, tournamentCardValues, type CardValues } from "../src/training/tournament-eval.ts";
import { evalMetrics, gapDistortionRmse } from "../src/training/metrics.ts";
import { cleanTournamentRows } from "../src/eval/tournament-clean.ts";
import { parseCatalogCsv } from "../src/data/catalog.ts";
import { rowEligible } from "../src/config/eligibility.ts";

const sHitFn = (g: number) => 1 + 0.76 * (1 - Math.exp(-g / 17.5));
const sPitFn = (g: number) => 1 + 1.03 * (1 - Math.exp(-g / 14.5));
const FIELD_N = 50, TH = 100;

const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state: any = (await repo.load<any>("state", "app")) ?? {};
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const trained = (await repo.loadAll<any>("trained-models")).find((x) => x.id === state.activeModelId);
const eventForm = trained.eventForm;
const rp = makeRawPolyModel(eventForm);
const cat = parseCatalogCsv(readFileSync("data/imports/cdmx.csv", "utf8"));
const isB = (c: any) => String(c["Variant"] ?? "").toUpperCase() !== "Y";

const wsd = (x: number[], w: number[]) => { const sw = w.reduce((a, b) => a + b, 0); const m = x.reduce((a, v, i) => a + w[i]! * v, 0) / sw; return Math.sqrt(x.reduce((a, v, i) => a + w[i]! * (v - m) ** 2, 0) / sw); };
const spreadRatio = (cv: CardValues) => (wsd(cv.real, cv.w) ? wsd(cv.pred, cv.w) / wsd(cv.real, cv.w) : NaN);
const quant = (x: number[], p: number) => { const s = [...x].sort((a, b) => a - b); return s[Math.max(0, Math.min(s.length - 1, Math.floor(p * (s.length - 1))))]!; };
// value spread (p90−p50) in VALUE orientation (higher=better): hit = wOBA, pit = −allowedWOBA.
const valSpread = (arr: number[], higherBetter: boolean) => { const v = higherBetter ? arr : arr.map((x) => -x); return quant(v, 0.9) - quant(v, 0.5); };
const f3 = (n: number) => (Number.isFinite(n) ? n.toFixed(3) : " n/a");

console.log(`Phase-1 TWO-AXIS acceptance — model ${trained.id}, ≥${TH} PA/BF, ghost-cleaned.\n`);

for (const [name, dir, TID] of [
  ["Open", "Tournament Data/Quicks - Open", "default-neutral"],
  ["Bronze-q", "Tournament Data/Quicks - Bronze", "bronze-quick"],
  ["Gold-q", "Tournament Data/Quicks - Gold", "gold-quick"],
  ["EG-clean", "Tournament Data/Early Gold", "early-gold"],
  ["Bronze-t", "Tournament Data/Return of the Bronze", "bronze-return"],
] as const) {
  if (!existsSync(dir)) continue;
  const t = (await repo.loadAll<Tournament>("tournaments")).find((x) => x.id === TID)!;
  const coeffs = resolveCoeffs(model, eras.get(t.eraId)!, parks.get(t.parkId)!, t.softcaps);
  if (trained.wobaWeights) applyWobaWeights(coeffs, trained.wobaWeights);
  const inV = (c: any) => { const v = Number(c["Card Value"]) || 0; return (t.card_value_min == null || v >= t.card_value_min) && (t.card_value_max == null || v <= t.card_value_max); };
  const basePool = cat.cards.filter((c: any) => isB(c) && inV(c) && rowEligible(c as any, t));
  const refField = computeUnifiedFieldStats(cat.cards.filter(isB), coeffs, rp, FIELD_N, true);
  const poolField = computeUnifiedFieldStats(basePool, coeffs, rp, FIELD_N, true);
  const fs = buildFrameShift(trained.trainingMeans, poolField);
  const kb = poolMeanK(basePool, coeffs, rp, fs, FIELD_N);
  const kSpread = { sHit: sHitFn(fs.hit.vR.kRat ?? 0), sPit: sPitFn(fs.pit.vR.stu ?? 0), meanHit: kb.hit, meanPit: kb.pit };
  const own = { poolTransform: buildPoolTransform(refField, poolField, trained.ratingEnvelope ?? undefined) };
  const sgap = { frameShift: fs, kSpread };

  const obs = loadTournamentOutcomes(dir, { clean: (rows) => cleanTournamentRows(rows).cleaned });
  const exposure = tournamentExposure(obs);
  const cvOwn = tournamentCardValues(obs, { coeffs, eventForm, ...own }, exposure, { minPA: TH, minBF: TH });
  const cvSg = tournamentCardValues(obs, { coeffs, eventForm, ...sgap }, exposure, { minPA: TH, minBF: TH });

  console.log(`======== ${name} (${t.eraId}) ========`);
  for (const role of ["hit", "pit"] as const) {
    const hb = role === "hit";
    const o = cvOwn[role], s = cvSg[role];
    if (o.pred.length < 4) { console.log(`  ${role.toUpperCase()}: <${TH}`); continue; }
    const mo = evalMetrics(o.pred, o.real, o.w, hb, 20), ms = evalMetrics(s.pred, s.real, s.w, hb, 20);
    console.log(`  ${role.toUpperCase()} (N=${mo.n})`);
    console.log(`     AXIS1 ordering:  regret own ${f3(mo.valueRegret)} / sgap ${f3(ms.valueRegret)}   overlap ${f3(mo.topNOverlap)}/${f3(ms.topNOverlap)}   spearman ${f3(mo.spearman)}/${f3(ms.spearman)}`);
    console.log(`     AXIS2 spacing :  spreadRatio own ${f3(spreadRatio(o))} / sgap ${f3(spreadRatio(s))} [→1.0]   gapRMSE ${f3(mo.gapRmse)}/${f3(ms.gapRmse)}`);
  }
  // Cross-role cap-bias: value spread (p90−p50) pred/real per role. Compression = pred/real.
  const comp = (cv: CardValues, hb: boolean) => valSpread(cv.pred, hb) / (valSpread(cv.real, hb) || NaN);
  console.log(`  CAP-BIAS (value-spread compression pred/real; <1 = model understates upside):`);
  console.log(`     own-gap (LIVE):  pit ${f3(comp(cvOwn.pit, false))}   hit ${f3(comp(cvOwn.hit, true))}   → pit/hit ${f3(comp(cvOwn.pit, false) / comp(cvOwn.hit, true))}  (<1 tilts cap $ to hitters)`);
  console.log(`     s(gap)        :  pit ${f3(comp(cvSg.pit, false))}   hit ${f3(comp(cvSg.hit, true))}   → pit/hit ${f3(comp(cvSg.pit, false) / comp(cvSg.hit, true))}`);
  console.log();
}
process.exit(0);
