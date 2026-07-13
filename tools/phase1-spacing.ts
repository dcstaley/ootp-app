// AXIS-2 SPACING with NOISE DECONVOLUTION (Fable method fix + Derek's inverse-variance rule).
// The observed actual-value spread is inflated by per-card sampling noise: σ²_obs = σ²_true + σ²_noise,
// σ²_noise = weighted-mean(SE²_card) with SE from the card's binomial event counts on the wOBA scale.
// Report spread-ratio = σ_pred / σ_TRUE (target ~1.0, but with a ceiling < 1 raw), pit/hit compression
// on σ_true, and per dataset: raw ratio, noise floor (ceiling σ_true/σ_obs), deconvolved ratio ± bootstrap
// CI. Aggregate across datasets by INVERSE-VARIANCE weighting (data-driven authority — no blacklist;
// high-PA EG/Bronze-t dominate today, quicks contribute weakly + rebalance as depth accrues).
//   run: node tools/phase1-spacing.ts
import { readFileSync, existsSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import { applyWobaWeights, makeRawPolyModel, computeUnifiedFieldStats, buildPoolTransform, buildFrameShift, poolMeanK } from "../src/scoring-core/index.ts";
import { loadTournamentOutcomes, tournamentExposure, tournamentCardValues, type TournamentObs, type CardValues } from "../src/training/tournament-eval.ts";
import { wobaWeightsFromCoeffs } from "../src/scoring-core/woba-weights.ts";
import { cleanTournamentRows } from "../src/eval/tournament-clean.ts";
import { parseCatalogCsv } from "../src/data/catalog.ts";
import { rowEligible } from "../src/config/eligibility.ts";

const sHitFn = (g: number) => 1 + 0.76 * (1 - Math.exp(-g / 17.5));
const sPitFn = (g: number) => 1 + 1.03 * (1 - Math.exp(-g / 14.5));
const FIELD_N = 50, TH = 100, BOOT = 400;

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
const f3 = (n: number) => (Number.isFinite(n) ? (n >= 0 ? " " : "") + n.toFixed(3) : "  n/a");

const wvar = (x: number[], w: number[]) => { const sw = w.reduce((a, b) => a + b, 0); const m = x.reduce((a, v, i) => a + w[i]! * v, 0) / sw; return x.reduce((a, v, i) => a + w[i]! * (v - m) ** 2, 0) / sw; };
const wmean = (x: number[], w: number[]) => { const sw = w.reduce((a, b) => a + b, 0); return x.reduce((a, v, i) => a + w[i]! * v, 0) / sw; };

// Binomial SE of a card's realized wOBA (assembled-value scale): per-PA wOBA is w_e w.p. p_e;
// Var_pa = Σ w_e² p_e − (Σ w_e p_e)²; SE² = Var_pa / denom. HBP is the fixed constant ⇒ no variance.
function seWoba(ev: { uBB: number; HmHR: number; HR: number; XBH?: number }, denom: number, w: ReturnType<typeof wobaWeightsFromCoeffs>): number {
  const xbh = ev.XBH ?? 0;
  const terms: [number, number][] = [[w.bb, ev.uBB / 600], [w.b1, (ev.HmHR - xbh) / 600], [w.xbh, xbh / 600], [w.hr, ev.HR / 600]];
  const E = terms.reduce((a, [wt, p]) => a + wt * p, 0);
  const E2 = terms.reduce((a, [wt, p]) => a + wt * wt * p, 0);
  return denom > 0 ? Math.sqrt(Math.max(E2 - E * E, 0) / denom) : 0;
}

// Deconvolved spread-ratio σ_pred/σ_true and ceiling σ_true/σ_obs, with a card-bootstrap CI.
function spacing(cv: CardValues, se: number[]) {
  const calc = (idx: number[]) => {
    const pred = idx.map((i) => cv.pred[i]!), real = idx.map((i) => cv.real[i]!), w = idx.map((i) => cv.w[i]!);
    const sPred = Math.sqrt(wvar(pred, w)), sObs2 = wvar(real, w);
    const noise2 = wmean(idx.map((i) => se[i]! ** 2), w);
    const sTrue = Math.sqrt(Math.max(sObs2 - noise2, 1e-9));
    return { ratio: sPred / sTrue, ceil: sTrue / Math.sqrt(sObs2), sPred, sTrue, sObs: Math.sqrt(sObs2), noise: Math.sqrt(noise2) };
  };
  const n = cv.pred.length;
  const point = calc([...Array(n).keys()]);
  const boots: number[] = [];
  for (let b = 0; b < BOOT; b++) { const idx = Array.from({ length: n }, () => Math.floor(Math.random() * n)); boots.push(calc(idx).ratio); }
  boots.sort((a, b) => a - b);
  const lo = boots[Math.floor(0.025 * BOOT)]!, hi = boots[Math.floor(0.975 * BOOT)]!;
  return { ...point, lo, hi, ciw: (hi - lo) / 2, n };
}

console.log(`Phase-1 AXIS-2 spacing (noise-deconvolved) — model ${trained.id}, ≥${TH} PA/BF, ${BOOT} boots.\n`);
const agg: Record<string, { r: number; w: number }[]> = { "own hit": [], "own pit": [], "sgap hit": [], "sgap pit": [] };
const compAgg: Record<string, { r: number; w: number }[]> = { own: [], sgap: [] };

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
  const ww = wobaWeightsFromCoeffs(coeffs);
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
  const seHit = obs.filter((o: TournamentObs) => o.pa >= TH).map((o) => seWoba(o.actual.hit, o.pa, ww));
  const sePit = obs.filter((o: TournamentObs) => o.bf >= TH).map((o) => seWoba(o.actual.pit, o.bf, ww));
  const cvOwn = tournamentCardValues(obs, { coeffs, eventForm, ...own }, exposure, { minPA: TH, minBF: TH });
  const cvSg = tournamentCardValues(obs, { coeffs, eventForm, ...sgap }, exposure, { minPA: TH, minBF: TH });

  console.log(`======== ${name} (${t.eraId}) ========`);
  for (const [mode, cv] of [["own", cvOwn], ["sgap", cvSg]] as const) {
    for (const [role, data, se] of [["hit", cv.hit, seHit], ["pit", cv.pit, sePit]] as const) {
      if (data.pred.length < 6) { console.log(`  ${mode} ${role}: <6 cards`); continue; }
      const s = spacing(data, se);
      console.log(`  ${mode} ${role.toUpperCase()} (N=${s.n}): raw ${f3(s.sPred / s.sObs)}  noiseFloor(ceil) ${f3(s.ceil)}  DECONV ${f3(s.ratio)} [${f3(s.lo)},${f3(s.hi)}]`);
      agg[`${mode} ${role}`]!.push({ r: s.ratio, w: 1 / (s.ciw ** 2 || 1e-6) });
    }
    // pit/hit compression on σ_true.
    const sh = spacing(cv.hit, seHit), sp = spacing(cv.pit, sePit);
    const comp = sp.ratio / sh.ratio;
    compAgg[mode]!.push({ r: comp, w: 1 / ((sp.ciw + sh.ciw) ** 2 || 1e-6) });
    console.log(`  ${mode} PIT/HIT compression (deconv): ${f3(comp)}  (<1 = pitcher upside understated → cap $ to hitters)`);
  }
  console.log();
}

const ivw = (xs: { r: number; w: number }[]) => { const sw = xs.reduce((a, x) => a + x.w, 0); return xs.reduce((a, x) => a + x.w * x.r, 0) / sw; };
console.log(`INVERSE-VARIANCE AGGREGATE (deconvolved spread-ratio, all datasets, CI-weighted):`);
for (const k of Object.keys(agg)) console.log(`  ${k.padEnd(9)}: ${f3(ivw(agg[k]!))}`);
console.log(`  PIT/HIT compression:  own ${f3(ivw(compAgg.own!))}   sgap ${f3(ivw(compAgg.sgap!))}   (SHIP bar: ≥~0.9, strictly > own)`);
process.exit(0);
