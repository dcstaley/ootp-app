// CALIBRATION-SLOPE CORRECTION + COMPOSITE DECONVOLUTION.
//   run: node tools/obs-pred-slopes.ts            (production corrections ON — the LIVE path)
//        node tools/obs-pred-slopes.ts --no-corrections
//
// WHY THIS EXISTS — a METRIC defect, not a model defect.
// `src/eval/cwhit/scorecard.ts:345` computes `slope = cov(pred,obs)/var(obs)` and documents it (line
// 282) as "OLS slope of pred on obs". That is the WRONG DIRECTION for a CALIBRATION slope and it is
// ATTENUATED BY CONSTRUCTION:
//     obs = true + noise    ⇒    var(obs) = var(true) + var(noise)
//     E[cov(pred,obs)/var(obs)] = cov(pred,true) / (var(true)+var(noise))   <   its noiseless value.
// A PERFECT predictor cannot read 1.0 on that statistic against a noisy target. Every "we under-react
// to the rating signal" reading taken off it is therefore biased toward "under-spread" by an amount
// set entirely by how noisy the observed column is — which varies wildly by channel and by tier depth.
//
// The DOCTRINE calibration slope is the regression of OBSERVED on PREDICTED:
//     slope_obs~pred = cov(obs,pred)/var(pred) = cov(true,pred)/var(pred)
// The numerator is unattenuated (noise is independent of pred, so it drops out in expectation) and the
// denominator is noise-FREE (pred has no sampling noise). >1 ⇒ we genuinely under-spread; ≈1 ⇒ correctly
// scaled; <1 ⇒ we over-spread. This tool reports BOTH, side by side, with the ratio, so the size of the
// artifact is visible and the corrected reading is available in the same table.
//
// AND IT FILLS IN THE `n/a` COMPOSITE CELLS. The scorecard prints `n/a` for `dcv` on wOBA/wOBAA,
// commenting "a composite; no clean binomial form". There IS a clean form: a wOBA is a WEIGHTED SUM OF
// MULTINOMIAL EVENT PROPORTIONS, so
//     Var(wOBA_hat) = ( Σ_j w_j² p_j − (Σ_j w_j p_j)² ) / n
// which is the exact multinomial variance of a weighted sum and ALREADY CARRIES THE NEGATIVE
// COVARIANCES between event cells (that is what the −(Σ w_j p_j)² term is). Assuming the events
// independent would give Σ w_j² p_j(1−p_j)/n, which OVERSTATES the noise materially. That form now
// lives in src/eval/cwhit/scorecard.ts (`wobaNoiseCells`/`wobaNoiseVar`) and is IMPORTED here, not
// re-derived — one-copy applies to eval instruments too.
//
// ONE SCORING CORE — NO scoring math is written here. The multinomial cell probabilities are EXTRACTED
// FROM THE EXISTING RECONSTRUCTION FUNCTIONS rather than re-derived: `hitWobaFromRates` and
// `pitWobaFromChannels` are both exactly LINEAR in the wOBA weight bag, so evaluating each at a UNIT
// BASIS weight vector returns that event's proportion verbatim (see `wobaNoiseCells`). Zero duplicated algebra,
// and the p_j are by construction the same ones the judged composite was built from.
//
// DOCTRINE: cwhit's RAW OBSERVED events = ground truth. His PROJECTIONS are a benchmark opponent only
// and are NOT used anywhere in this file — every slope here is OURS vs OBSERVED.
// TWO AXES, always together: ORDERING (correlation, incl. disattenuated) AND SPACING (slope, spread).

import { readFileSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import {
  makeRawPolyModel, computeUnifiedFieldStats, applyWobaWeights, computeDerived,
  buildPoolTransform, buildFrameShift, poolPitMeansOwn, kSpreadPitRamp, pitSpreadHrRamp,
  type EventForm, type FieldStats, type RatingEnvelope, type WobaWeights, type TrainingMeans,
} from "../src/scoring-core/index.ts";
import { computeHitTail, PINNED_HIT_TAIL, type HitTail } from "../src/scoring-core/hit-tail.ts";
import { parseCatalogCsv } from "../src/data/catalog.ts";
import type { WobaWeights as WW } from "../src/eval/cwhit/audit.ts";
import {
  pearson, spearman, per9NoiseVar, babipNoiseVar, pctNoiseVar, per600NoiseVar, BF_PER_9,
  wobaNoiseCells, wobaNoiseVar, wobaNoiseVarIndep,
} from "../src/eval/cwhit/scorecard.ts";
import { IP_TO_BF } from "../src/eval/cwhit/parse.ts";
import {
  buildCwhitSample, wellSampled, isPit, n_, FIELD_N, MIN_IP, MIN_PA, QUICK,
  type KSpreadPit, type Rec, type SampleDeps,
} from "../src/eval/cwhit/sample.ts";

const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(0)}%` : "n/a");

// ── deployed model + neutral env — MIRRORS tools/cwhit-scorecard.ts EXACTLY ───
const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state = (await repo.load<{ activeModelId?: string; catalogSourceId?: string }>("state", "app")) ?? {};
type TM = { id: string; eventForm?: EventForm; wobaWeights?: WobaWeights; ratingEnvelope?: RatingEnvelope; trainingMeans?: TrainingMeans; platoon?: { pit: { hand: string; vsRHB: number; vsLHB: number }[]; hit: { hand: string; vsRHP: number; vsLHP: number }[] } };
const trained = (await repo.loadAll<TM>("trained-models")).find((x) => x.id === state.activeModelId);
if (!trained?.eventForm || !trained.wobaWeights || !trained.platoon) throw new Error("active model missing eventForm/wobaWeights/platoon");
const rp = makeRawPolyModel(trained.eventForm);
const W = trained.wobaWeights as WW;
const envelope = trained.ratingEnvelope;
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const bq = (await repo.loadAll<Tournament>("tournaments")).find((t) => t.id === "bronze-quick")!;   // neutral era/park
const coeffs = resolveCoeffs(model, eras.get(bq.eraId)!, parks.get(bq.parkId)!, bq.softcaps);
applyWobaWeights(coeffs, trained.wobaWeights);
const derived = computeDerived(coeffs);
const pitExp = new Map(trained.platoon.pit.map((p) => [p.hand, { wR: p.vsRHB, wL: p.vsLHB }]));
const hitExp = new Map(trained.platoon.hit.map((p) => [p.hand, { wR: p.vsRHP, wL: p.vsLHP }]));

const srcId = state.catalogSourceId ?? "cdmx";
const baseCards = parseCatalogCsv(readFileSync(`data/imports/${srcId}.csv`, "utf8")).cards.filter((c) => String(c["Variant"] ?? "").toUpperCase() !== "Y");
const ref: FieldStats = computeUnifiedFieldStats(baseCards, coeffs, rp, FIELD_N, true);

// PRODUCTION spread/tail corrections (BUILD-1/2/3) — default ON, exactly as the scorecard builds them.
const CORRECTIONS = !process.argv.includes("--no-corrections");
let ksMap: Map<string, KSpreadPit> | undefined;
let htMap: Map<string, HitTail> | undefined;
if (CORRECTIONS) {
  const TMeans = trained.trainingMeans;
  if (!TMeans) throw new Error("corrections ON needs the active model's trainingMeans — or run with --no-corrections");
  ksMap = new Map(); htMap = new Map();
  for (const { tier, cap } of QUICK) {
    const basePool = baseCards.filter((c) => n_(c["Card Value"]) <= cap);
    const poolField = computeUnifiedFieldStats(basePool, coeffs, rp, FIELD_N, true);
    const pt = buildPoolTransform(ref, poolField, envelope);
    const shift = buildFrameShift(TMeans, poolField);
    const pm = poolPitMeansOwn(basePool, coeffs, rp, pt, FIELD_N);
    ksMap.set(tier, { s: kSpreadPitRamp(shift.pit.vR.stu ?? 0), mean: pm.k, sHr: pitSpreadHrRamp(shift.pit.vR.hrr ?? 0), meanHr: pm.hr });
    htMap.set(tier, computeHitTail(basePool.filter((c) => !isPit(c)), coeffs, rp, pt, ref, poolField, PINNED_HIT_TAIL));
  }
}

const deps: SampleDeps = { baseCards, coeffs, derived, eventForm: trained.eventForm, model: rp, W, ref, envelope, pitExp, hitExp, kSpreadPit: ksMap, hitTail: htMap };
const { recs } = buildCwhitSample(deps);

// ═══ COMPOSITE NOISE ════════════════════════════════════════════════════════════════════════════
//
// The multinomial weighted-sum variance now lives in src/eval/cwhit/scorecard.ts beside its
// single-event siblings (per9NoiseVar / babipNoiseVar / pctNoiseVar / per600NoiseVar) and is
// imported here. It was ORIGINALLY written in this file; it was promoted because ONE-COPY applies
// to eval instruments too — this session is the proof of why. Do not re-derive it locally.
// These thin adapters exist only to turn a `Rec` into the shared function's plain-rate input
// (the shared module cannot import sample.ts, since sample.ts imports it).

const nOf = (r: Rec): number => (r.role === "pit" ? r.sample * IP_TO_BF : r.sample);
const cellsOf = (r: Rec, collapseHits: boolean) => wobaNoiseCells(
  r.role === "pit"
    ? { role: "pit", k9: r.obs.k9!, bb9: r.obs.bb9!, hr9: r.obs.hr9!, babip: r.obs.babip! }
    : { role: "hit", bbPct: r.obs.bbPct!, soPct: r.obs.soPct!, hr600: r.obs.hr600!, babip: r.obs.babip!, avg: r.raw.avg!, slg: r.raw.slg!, tripleXbh: r.raw.tripleXbh! },
  W, collapseHits);

const wobaNoiseVarOf = (r: Rec, collapseHits: boolean): number => wobaNoiseVar(cellsOf(r, collapseHits), nOf(r));
/** Independence-assuming contrast — printed once so the size of the covariance term is visible
 *  rather than asserted. NEVER used for a reported number. */
const wobaNoiseVarIndepOf = (r: Rec, collapseHits: boolean): number => wobaNoiseVarIndep(cellsOf(r, collapseHits), nOf(r));

/** Per-channel observed sampling variance. Single-event channels: the scorecard's own helpers, same
 *  BIP derivations. Composite: the multinomial form above (the cells the scorecard leaves `n/a`). */
function noiseOf(r: Rec, ch: string): number {
  if (r.role === "pit") {
    const bf = r.sample * IP_TO_BF;
    const bip = Math.max(bf - (r.obs.k9! + r.obs.bb9! + r.obs.hr9!) / BF_PER_9 * bf - 0.009 * bf, 1);
    if (ch === "babip") return babipNoiseVar(r.obs.babip!, bip);
    if (ch === "woba") return wobaNoiseVarOf(r, true);
    return per9NoiseVar(r.obs[ch]!, r.sample);
  }
  const bip = Math.max(r.sample * (1 - r.obs.bbPct! / 100 - 0.008 - r.obs.soPct! / 100 - r.obs.hr600! / 600), 1);
  if (ch === "babip") return babipNoiseVar(r.obs.babip!, bip);
  if (ch === "hr600") return per600NoiseVar(r.obs.hr600!, r.sample);
  if (ch === "woba") return wobaNoiseVarOf(r, false);
  return pctNoiseVar(r.obs[ch]!, r.sample);
}

const CH: Record<"pit" | "hit", { key: string; lbl: string; d: number }[]> = {
  pit: [{ key: "k9", lbl: "K9", d: 2 }, { key: "bb9", lbl: "BB9", d: 2 }, { key: "hr9", lbl: "HR9", d: 2 }, { key: "babip", lbl: "BABIP", d: 3 }, { key: "woba", lbl: "wOBAA", d: 3 }],
  hit: [{ key: "bbPct", lbl: "BB%", d: 2 }, { key: "soPct", lbl: "SO%(PA)", d: 2 }, { key: "hr600", lbl: "HR600", d: 2 }, { key: "babip", lbl: "BABIP", d: 3 }, { key: "woba", lbl: "wOBA", d: 3 }],
};

// ═══ THE TWO SLOPES + THE DECONVOLUTION ══════════════════════════════════════
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const varPop = (xs: number[]) => { const m = mean(xs); return mean(xs.map((x) => (x - m) ** 2)); };
const cov = (xs: number[], ys: number[]) => { const mx = mean(xs), my = mean(ys); return mean(xs.map((x, i) => (x - mx) * (ys[i]! - my))); };

interface Cell {
  n: number;
  slopePredObs: number;   // the CURRENT scorecard statistic — attenuated by construction
  slopeObsPred: number;   // the DOCTRINE calibration slope
  ratio: number;          // obs~pred ÷ pred~obs  ( = var(obs)/var(pred) ) — the size of the artifact
  corr: number;           // ORDERING, vs the noisy observation
  corrTrue: number;       // ORDERING, disattenuated to the TRUE value: corr / sqrt(1 − noiseShare)
  rho: number;            // rank ordering
  sdPred: number; sdObs: number; sdTrue: number;
  spreadRaw: number;      // SD(pred)/SD(obs)   — low-biased
  spreadDcv: number;      // SD(pred)/SD(TRUE)  — THE spacing axis
  noiseShare: number;     // mean sampling var ÷ observed var
}

function computeCell(pred: number[], obs: number[], nv: number[]): Cell {
  const vP = varPop(pred), vO = varPop(obs), c = cov(obs, pred);
  const nvBar = mean(nv);
  const noiseShare = vO > 0 ? nvBar / vO : NaN;
  const vTrue = Math.max(vO - nvBar, 0);
  const r = pearson(pred, obs);
  return {
    n: pred.length,
    slopePredObs: vO > 0 ? c / vO : NaN,
    slopeObsPred: vP > 0 ? c / vP : NaN,
    ratio: vP > 0 ? vO / vP : NaN,
    corr: r,
    corrTrue: noiseShare < 1 ? Math.min(r / Math.sqrt(1 - noiseShare), 1) : NaN,
    rho: spearman(pred, obs),
    sdPred: Math.sqrt(vP), sdObs: Math.sqrt(vO), sdTrue: Math.sqrt(vTrue),
    spreadRaw: vO > 0 ? Math.sqrt(vP / vO) : NaN,
    spreadDcv: vTrue > 0 ? Math.sqrt(vP / vTrue) : NaN,
    noiseShare,
  };
}

/** Deterministic mulberry32 — the bootstrap is reproducible run to run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const B = 2500;   // ≥2000 as specified
type CI = { lo: number; hi: number };
const ciOf = (xs: number[]): CI => {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length < 50) return { lo: NaN, hi: NaN };
  return { lo: v[Math.floor(0.025 * v.length)]!, hi: v[Math.min(Math.floor(0.975 * v.length), v.length - 1)]! };
};

/** CARD-RESAMPLED bootstrap. Cards are the unit: each card's observed line is one noisy draw, and the
 *  card set itself is the sample we generalize over — so resampling cards propagates BOTH the finite-N
 *  uncertainty and the composition of the judged top-100. The noise variances travel WITH their card. */
function bootstrap(pred: number[], obs: number[], nv: number[], seed: number) {
  const rnd = rng(seed), n = pred.length;
  const s = { slopeObsPred: [] as number[], slopePredObs: [] as number[], spreadDcv: [] as number[], corrTrue: [] as number[], noiseShare: [] as number[] };
  for (let b = 0; b < B; b++) {
    const ix = Array.from({ length: n }, () => Math.floor(rnd() * n));
    const c = computeCell(ix.map((i) => pred[i]!), ix.map((i) => obs[i]!), ix.map((i) => nv[i]!));
    s.slopeObsPred.push(c.slopeObsPred); s.slopePredObs.push(c.slopePredObs);
    s.spreadDcv.push(c.spreadDcv); s.corrTrue.push(c.corrTrue); s.noiseShare.push(c.noiseShare);
  }
  return { slopeObsPred: ciOf(s.slopeObsPred), slopePredObs: ciOf(s.slopePredObs), spreadDcv: ciOf(s.spreadDcv), corrTrue: ciOf(s.corrTrue), noiseShare: ciOf(s.noiseShare) };
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n╔══════════════════════════════════════════════════════════════════════════════════════════════════════╗`);
console.log(`║  CALIBRATION SLOPES DONE RIGHT (obs~pred) + COMPOSITE wOBA DECONVOLUTION                              ║`);
console.log(`╚══════════════════════════════════════════════════════════════════════════════════════════════════════╝`);
console.log(`model '${trained.id}' | catalog '${srcId}' | neutral env (bronze-quick era/park) | own-gap pool transform ON`);
console.log(`PRODUCTION CORRECTIONS: ${CORRECTIONS ? "ON (production default — the LIVE path)" : "OFF (--no-corrections)"}`);
console.log(`sample: the SHARED builder src/eval/cwhit/sample.ts (buildCwhitSample), well-sampled bar IP≥${MIN_IP} / PA≥${MIN_PA}, five Quick tiers.`);
console.log(`comparison is OURS vs OBSERVED throughout — cwhit's projections are not touched by this tool.`);
console.log(`\nWHAT THE TWO SLOPES MEAN`);
console.log(`  pred~obs  = cov(pred,obs)/var(obs)  — the CURRENT scorecard column (scorecard.ts:345). ATTENUATED: its`);
console.log(`              denominator carries the observation noise, so it reads low even for a PERFECT predictor.`);
console.log(`  obs~pred  = cov(obs,pred)/var(pred) — the DOCTRINE calibration slope. Numerator = cov(true,pred) in`);
console.log(`              expectation; denominator is noise-free. >1 ⇒ genuinely UNDER-spread. ≈1 ⇒ correctly scaled.`);
console.log(`  ratio     = obs~pred ÷ pred~obs = var(obs)/var(pred). How much of an "under-spread" reading was artifact.`);
console.log(`  ORDERING is reported alongside SPACING at every cell (two-axis doctrine): corr, disattenuated corr, rho.`);
console.log(`  identity: spreadDcv = corrTrue / slope_obs~pred  (spacing and ordering are not independent readings).`);
console.log(`  CIs: ${B}-rep CARD-RESAMPLED percentile bootstrap.`);

// ── the sanity check on the composite noise model ────────────────────────────
{
  console.log(`\n── COMPOSITE NOISE MODEL — multinomial vs (wrong) independence, mean per-card noise SD on the wOBA scale ──`);
  console.log(`   If the covariance term were immaterial these two would agree. They do not; the independence version`);
  console.log(`   OVERSTATES the noise, which would OVERSTATE the deconvolved spread ratio. Multinomial is used throughout.`);
  console.log(`role  tier       N     multinomial     independent    overstatement`);
  for (const role of ["pit", "hit"] as const) for (const { tier } of QUICK) {
    const rows = recs.filter((r) => r.tier === tier && r.role === role && wellSampled(r));
    if (rows.length < 5) continue;
    const coll = role === "pit";
    const a = Math.sqrt(mean(rows.map((r) => wobaNoiseVarOf(r, coll))));
    const b = Math.sqrt(mean(rows.map((r) => wobaNoiseVarIndepOf(r, coll))));
    console.log(`${role}   ${tier.padEnd(9)} ${String(rows.length).padStart(3)}      ${f(a, 5)}        ${f(b, 5)}        ×${f(b / a, 2)}`);
  }
  console.log(`   PITCHER cells are COLLAPSED (1B+XBH as one non-HR-hit cell): cwhit publishes only BABIP for pitchers and`);
  console.log(`   the reconstruction splits it with a FIXED 0.25 share, so 1B and XBH do not fluctuate independently there.`);
  console.log(`   HITTER cells are SPLIT (1B and XBH separate): his hitter table publishes AVG/SLG/tripleXBH, so the split`);
  console.log(`   is genuinely observed and genuinely random. AMBIGUITY FLAGGED, not resolved: the hitter split still treats`);
  console.log(`   AVG/SLG/tripleXBH as fixed when deriving p_1B/p_XBH, so the hitter composite noise is a mild UNDER-estimate;`);
  console.log(`   that biases the hitter deconvolved spread ratio DOWNWARD (i.e. conservative against "we are fine").`);
}

// ── the main table ───────────────────────────────────────────────────────────
interface Row { role: string; tier: string; ch: string; d: number; c: Cell; ci: ReturnType<typeof bootstrap> }
const out: Row[] = [];
let seed = 20260720;
for (const role of ["pit", "hit"] as const) {
  console.log(`\n\n╔═══ ${role === "pit" ? "PITCHERS" : "HITTERS"} — ours vs observed, every Quick tier ═══════════════════════════════════════════════╗`);
  console.log(`                        ┌──── SPACING: the two slopes ────┐  ┌── SPACING: spread ──┐  ┌─── ORDERING ───┐`);
  console.log(`tier      chan       N   pred~obs   obs~pred  [95% CI]   ratio   raw    dcv  [95% CI]   corr  corrTrue  rho   noise%`);
  for (const { tier } of QUICK) {
    const rows = recs.filter((r) => r.tier === tier && r.role === role && wellSampled(r));
    if (rows.length < 5) { if (rows.length) console.log(`${tier.padEnd(9)} (N=${rows.length} well-sampled — too few to report)`); continue; }
    for (const { key, lbl, d } of CH[role]) {
      const pred = rows.map((r) => r.ours[key]!), obs = rows.map((r) => r.obs[key]!), nv = rows.map((r) => noiseOf(r, key));
      if (!pred.every(Number.isFinite) || !obs.every(Number.isFinite) || !nv.every(Number.isFinite)) { console.log(`${tier.padEnd(9)} ${lbl.padEnd(9)} — non-finite value in pred/obs/noise; cell SKIPPED (not silently dropped)`); continue; }
      const c = computeCell(pred, obs, nv);
      const ci = bootstrap(pred, obs, nv, seed++);
      out.push({ role, tier, ch: lbl, d, c, ci });
      console.log(
        `${tier.padEnd(9)} ${lbl.padEnd(9)} ${String(c.n).padStart(3)}    ` +
        `${f(c.slopePredObs, 2).padStart(5)}      ${f(c.slopeObsPred, 2).padStart(5)}  [${f(ci.slopeObsPred.lo, 2)},${f(ci.slopeObsPred.hi, 2)}]  ` +
        `${f(c.ratio, 2).padStart(5)}   ${f(c.spreadRaw, 2)}   ${f(c.spreadDcv, 2)}  [${f(ci.spreadDcv.lo, 2)},${f(ci.spreadDcv.hi, 2)}]  ` +
        `${f(c.corr, 3)}   ${f(c.corrTrue, 3)}  ${f(c.rho, 2)}   ${pct(c.noiseShare).padStart(4)}`,
      );
    }
  }
}

// ── the composite, isolated (the cells the scorecard prints n/a for) ─────────
console.log(`\n\n╔═══ THE COMPOSITE — wOBA / wOBAA. THESE ARE THE CELLS THE SCORECARD PRINTS 'n/a' FOR. ═══════════════════╗`);
console.log(`role  tier       N    SD(pred)  SD(obs)  SD(TRUE)   spread raw   spread DCV [95% CI]    noise share [95% CI]   obs~pred [95% CI]`);
for (const role of ["pit", "hit"] as const) for (const { tier } of QUICK) {
  const r = out.find((x) => x.role === role && x.tier === tier && (x.ch === "wOBA" || x.ch === "wOBAA"));
  if (!r) continue;
  const { c, ci } = r;
  console.log(
    `${role}   ${tier.padEnd(9)} ${String(c.n).padStart(3)}    ${f(c.sdPred, 4)}    ${f(c.sdObs, 4)}   ${f(c.sdTrue, 4)}      ` +
    `${f(c.spreadRaw, 2).padStart(4)}         ${f(c.spreadDcv, 2)} [${f(ci.spreadDcv.lo, 2)},${f(ci.spreadDcv.hi, 2)}]        ` +
    `${pct(c.noiseShare).padStart(4)} [${pct(ci.noiseShare.lo)},${pct(ci.noiseShare.hi)}]      ${f(c.slopeObsPred, 2)} [${f(ci.slopeObsPred.lo, 2)},${f(ci.slopeObsPred.hi, 2)}]`,
  );
}
console.log(`\n  READ: spread DCV = SD(our predictions) ÷ SD(the TRUE card-to-card composite). 1.00 = we spread the cards`);
console.log(`  exactly as much as they truly differ. <1 = under-spread (too flat). >1 = over-spread. The CI decides.`);

// ── the verdict on the reported finding ──────────────────────────────────────
console.log(`\n\n╔═══ DOES "HITTERS ARE SEVERELY UNDER-SPREAD (slopes 0.25–0.50)" SURVIVE THE CORRECTED METRIC? ═══════════╗`);
console.log(`The 0.25–0.50 figures were read off the pred~obs column. Below, every hitter cell's attenuated reading is`);
console.log(`shown against its doctrine reading, and against the deconvolved spread ratio (the direct spacing measure).`);
console.log(`A cell is a REAL under-spread defect only if obs~pred is CI-clear ABOVE 1 and spread DCV is CI-clear BELOW 1.`);
console.log(`\ntier      chan       pred~obs   obs~pred [CI]        spread DCV [CI]       verdict`);
for (const r of out.filter((x) => x.role === "hit")) {
  const { c, ci } = r;
  const slopeHigh = Number.isFinite(ci.slopeObsPred.lo) && ci.slopeObsPred.lo > 1;
  const slopeLow = Number.isFinite(ci.slopeObsPred.hi) && ci.slopeObsPred.hi < 1;
  const sprLow = Number.isFinite(ci.spreadDcv.hi) && ci.spreadDcv.hi < 1;
  const sprHigh = Number.isFinite(ci.spreadDcv.lo) && ci.spreadDcv.lo > 1;
  const v = slopeHigh && sprLow ? "REAL UNDER-SPREAD (both axes CI-clear)"
    : slopeLow && sprHigh ? "REAL OVER-SPREAD (both axes CI-clear)"
      : slopeHigh || sprLow ? "PARTIAL — one axis CI-clear low, the other not; AMBIGUOUS, do not act on it alone"
        : slopeLow || sprHigh ? "PARTIAL — one axis CI-clear high; AMBIGUOUS"
          : "NO SPREAD DEFECT — CIs straddle 1.0 on both axes";
  console.log(`${r.tier.padEnd(9)} ${r.ch.padEnd(9)}   ${f(c.slopePredObs, 2).padStart(5)}      ${f(c.slopeObsPred, 2)} [${f(ci.slopeObsPred.lo, 2)},${f(ci.slopeObsPred.hi, 2)}]     ${f(c.spreadDcv, 2)} [${f(ci.spreadDcv.lo, 2)},${f(ci.spreadDcv.hi, 2)}]      ${v}`);
}
console.log(`\nAnd the same for PITCHERS, so the hitter read is never taken in isolation:`);
console.log(`tier      chan       pred~obs   obs~pred [CI]        spread DCV [CI]       verdict`);
for (const r of out.filter((x) => x.role === "pit")) {
  const { c, ci } = r;
  const slopeHigh = Number.isFinite(ci.slopeObsPred.lo) && ci.slopeObsPred.lo > 1;
  const sprLow = Number.isFinite(ci.spreadDcv.hi) && ci.spreadDcv.hi < 1;
  const slopeLow = Number.isFinite(ci.slopeObsPred.hi) && ci.slopeObsPred.hi < 1;
  const sprHigh = Number.isFinite(ci.spreadDcv.lo) && ci.spreadDcv.lo > 1;
  const v = slopeHigh && sprLow ? "REAL UNDER-SPREAD" : slopeLow && sprHigh ? "REAL OVER-SPREAD"
    : slopeHigh || sprLow || slopeLow || sprHigh ? "PARTIAL — AMBIGUOUS" : "NO SPREAD DEFECT";
  console.log(`${r.tier.padEnd(9)} ${r.ch.padEnd(9)}   ${f(c.slopePredObs, 2).padStart(5)}      ${f(c.slopeObsPred, 2)} [${f(ci.slopeObsPred.lo, 2)},${f(ci.slopeObsPred.hi, 2)}]     ${f(c.spreadDcv, 2)} [${f(ci.spreadDcv.lo, 2)},${f(ci.spreadDcv.hi, 2)}]      ${v}`);
}

console.log(`\nCAVEATS (flagged, not resolved):`);
console.log(`  · The deconvolution assumes the ONLY error in the observed column is multinomial sampling noise. Any`);
console.log(`    real card-to-card heterogeneity in opponent/park/usage inside cwhit's aggregate is counted as TRUE`);
console.log(`    variance, which makes spread DCV a LOWER bound on how well we spread the cards.`);
console.log(`  · The judged set is cwhit's top-100 BY USAGE, a RANGE-RESTRICTED slice of each tier's pool. Both slopes`);
console.log(`    are conditioned on that selection; neither generalizes to the full pool without a selection correction.`);
console.log(`  · The composite is a RECONSTRUCTION from published rate columns, not a box score. Its noise model inherits`);
console.log(`    that reconstruction's fixed HBP rate and (pitchers) fixed XBH share.`);
console.log(``);
process.exit(0);
