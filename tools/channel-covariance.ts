// CHANNEL COVARIANCE DECOMPOSITION — is the composite spread gap a COVARIANCE deficit?
//   run: node tools/channel-covariance.ts            (production corrections ON — the live path)
//       node tools/channel-covariance.ts --no-corrections
//
// THE HYPOTHESIS UNDER TEST. Per-channel predicted spreads sit at ~0.9–1.0× observed after noise
// deconvolution, yet the COMPOSITE (wOBA / wOBAA) sits near ~0.6×. For a weighted sum,
//     Var(Σ wᵢpᵢ) = Σ wᵢ² Var(pᵢ)  +  2 Σ_{i<j} wᵢwⱼ Cov(pᵢ,pⱼ)
// so right marginals + a too-small total is the arithmetic signature of the MODEL GENERATING
// CHANNELS TOO INDEPENDENTLY relative to real talent correlations. This tool measures the two terms
// separately, predicted vs noise-corrected observed, and states how much of the gap each carries.
// It can equally FALSIFY the hypothesis: if the marginals are also short, the story is different.
//
// NO SCORING MATH LIVES HERE. The judged sample, the predicted lines and the composites all come
// from the shared builder (src/eval/cwhit/sample.ts) and the shared wOBA reconstructions
// (src/eval/cwhit/audit.ts). This file only RE-EXPRESSES the composite each of those already
// produced as its additive parts, and PROVES the parts sum to the whole per card (§1).
//
// GROUND TRUTH = cwhit's RAW OBSERVED events. His PROJECTIONS are never touched by this tool.

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
import { HIT_BIP_ADJ } from "../src/model/curves.ts";
import { IP_TO_BF } from "../src/eval/cwhit/parse.ts";
import {
  pitWobaFromChannels, hitWobaFromRates, PER9_TO_PER600, type WobaWeights as WW,
} from "../src/eval/cwhit/audit.ts";
import {
  buildCwhitSample, wellSampled, isPit, n_, FIELD_N, MIN_IP, MIN_PA, QUICK,
  type KSpreadPit, type Rec, type SampleDeps,
} from "../src/eval/cwhit/sample.ts";

const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const sgn = (x: number, d = 2) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}` : "n/a");
const e3 = (x: number) => (Number.isFinite(x) ? x.toExponential(2) : "n/a");

// ── deployed model + neutral env (identical boot to tools/cwhit-scorecard.ts) ────────────────────
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
const bq = (await repo.loadAll<Tournament>("tournaments")).find((t) => t.id === "bronze-quick")!;
const coeffs = resolveCoeffs(model, eras.get(bq.eraId)!, parks.get(bq.parkId)!, bq.softcaps);
applyWobaWeights(coeffs, trained.wobaWeights);
const derived = computeDerived(coeffs);
const pitExp = new Map(trained.platoon.pit.map((p) => [p.hand, { wR: p.vsRHB, wL: p.vsLHB }]));
const hitExp = new Map(trained.platoon.hit.map((p) => [p.hand, { wR: p.vsRHP, wL: p.vsLHP }]));

const srcId = state.catalogSourceId ?? "cdmx";
const baseCards = parseCatalogCsv(readFileSync(`data/imports/${srcId}.csv`, "utf8")).cards.filter((c) => String(c["Variant"] ?? "").toUpperCase() !== "Y");
const ref: FieldStats = computeUnifiedFieldStats(baseCards, coeffs, rp, FIELD_N, true);

// ── PRODUCTION spread/tail corrections (BUILD-1/2/3), per Quick tier — ON by default ─────────────
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
const { recs, notices } = buildCwhitSample(deps);

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// §1. THE CHANNEL BASIS — the decomposition the composite is ACTUALLY built from.
//
// Both composites are, exactly, a weighted sum of per-trial event PROPORTIONS:
//     hitter  wOBA  = w_bb·p_bb + w_hbp·p_hbp + w_1b·p_1b + w_xbh·p_xbh + w_hr·p_hr     (per PA)
//     pitcher wOBAA = the same five terms                                               (per BF)
// (pitcher counts are per-600-BF and divided by 600, i.e. the same proportions.)
//
// SO/K IS NOT A wOBA CHANNEL. It carries NO weight in either composite; it enters only through the
// BIP denominator (more K ⇒ fewer BIP ⇒ fewer 1B/XBH). The work order named SO as a hitter channel;
// the hard constraint "the parts must provably sum to the whole" overrides it, so SO is NOT a basis
// vector here. Its effect is fully absorbed into the 1B/XBH contributions. FLAGGED, not resolved.
//
// HBP is a FIXED constant on every card (model allotment 6/600 predicted; 0.008/PA observed for
// hitters). It has exactly zero variance and zero covariance, so it is carried in the reconstruction
// (§1 check) and then dropped from the covariance analysis. The predicted-vs-observed hitter HBP
// constant differs (0.0100 vs 0.0080) — a LEVEL-only discrepancy, invisible to every number below.
// ═════════════════════════════════════════════════════════════════════════════════════════════════

const CH = ["bb", "b1", "xbh", "hr"] as const;
type Ch = typeof CH[number];
const CH_LBL: Record<Ch, string> = { bb: "BB", b1: "1B", xbh: "XBH", hr: "HR" };
const NC = CH.length;

/** Per-trial event proportions + the fixed HBP leg. `p` are proportions of PA (hit) / BF (pit). */
interface Props { p: Record<Ch, number>; hbp: number }

const wOf = (c: Ch): number => (c === "bb" ? W.bb : c === "b1" ? W.b1 : c === "xbh" ? W.xbh : W.hr);
/** The weighted contribution vector, in wOBA units. Σ(vector) + w_hbp·hbp === the composite. */
const contrib = (s: Props): number[] => CH.map((c) => wOf(c) * s.p[c]);
const total = (s: Props): number => contrib(s).reduce((a, b) => a + b, 0) + W.hbp * s.hbp;

const PIT_XBH_SHARE = 0.25;   // the model's fixed pitcher XBH share (raw-poly.ts / audit.ts)
const PIT_HBP_P = 6 / 600;
const HIT_HBP_P_PRED = 6 / 600;
const HIT_HBP_P_OBS = 0.008;  // hitWobaFromRates' hbpRate

/** Pitcher props — the internals of `pitWobaFromChannels`, re-expressed. Used for BOTH sides
 *  (predicted and observed pitcher composites are both produced by that one function). */
function pitProps(k9: number, bb9: number, hr9: number, babip: number): Props {
  const BB = bb9 * PER9_TO_PER600, K = k9 * PER9_TO_PER600, HR = hr9 * PER9_TO_PER600;
  const BIP = Math.max(600 - BB - K - HR - 6, 1);
  const nHH = babip * BIP, XBH = PIT_XBH_SHARE * nHH, oneB = nHH - XBH;
  return { p: { bb: BB / 600, b1: oneB / 600, xbh: XBH / 600, hr: HR / 600 }, hbp: PIT_HBP_P };
}

/** Observed hitter props — the internals of `hitWobaFromRates`, re-expressed (same clamps). */
function hitObsProps(r: Record<string, number>, soPctPerPa: number): Props {
  const bb = r["bbPct"]! / 100, k = soPctPerPa / 100, hr = r["hr600"]! / 600;
  const bip = Math.max(1 - bb - HIT_HBP_P_OBS - k - hr, 0);
  const hNonHR = r["babip"]! * bip, H = hNonHR + hr;
  const basesPerHit = r["avg"]! > 0 ? r["slg"]! / r["avg"]! : 1;
  const nonHRbases = basesPerHit * H - 4 * hr;
  const r3 = r["tripleXbh"]! / 100;
  const xbh = Math.max((nonHRbases - hNonHR) / (1 + r3), 0);
  const oneB = Math.max(hNonHR - xbh, 0);
  return { p: { bb, b1: oneB, xbh, hr }, hbp: HIT_HBP_P_OBS };
}

/** PREDICTED hitter props. The shared builder publishes only 4 rate channels + the composite, so the
 *  1B/XBH split is not directly exposed. It is IDENTIFIED EXACTLY from the composite identity:
 *      wOBA·600 − w_bb·BB − w_hbp·6 − w_hr·HR = w_1b·(nHH − GAP) + w_xbh·GAP
 *  one linear equation, one unknown (w_xbh ≠ w_1b) ⇒ a unique GAP. This is algebra on numbers the
 *  scoring core already produced, not a second assembly. Because it is solved FROM the composite it
 *  reconstructs by construction, so §1's residual check is vacuous for this one cell — the real
 *  check here is the FALSIFIABLE range test 0 ≤ GAP ≤ nHH, reported separately. FLAGGED. */
function hitPredProps(o: Record<string, number>, woba: number): { s: Props; inRange: boolean } {
  const BB = o["bbPct"]! * 6, SO = o["soPct"]! * 6, HR = o["hr600"]!;
  const BIP = Math.max(600 - BB - SO - HR - HIT_BIP_ADJ, 1);
  const nHH = o["babip"]! * BIP;
  const R = woba * 600 - W.bb * BB - W.hbp * 6 - W.hr * HR;
  const GAP = (R - W.b1 * nHH) / (W.xbh - W.b1);
  const oneB = nHH - GAP;
  return { s: { p: { bb: BB / 600, b1: oneB / 600, xbh: GAP / 600, hr: HR / 600 }, hbp: HIT_HBP_P_PRED }, inRange: GAP >= -1e-9 && GAP <= nHH + 1e-9 };
}

/** One card, fully decomposed. */
interface Cell { pred: Props; obs: Props; n: number; predWoba: number; obsWoba: number; recon: { pred: number; obs: number }; inRange: boolean }

function decompose(r: Rec): Cell {
  if (r.role === "pit") {
    const pred = pitProps(r.ours["k9"]!, r.ours["bb9"]!, r.ours["hr9"]!, r.ours["babip"]!);
    const obs = pitProps(r.obs["k9"]!, r.obs["bb9"]!, r.obs["hr9"]!, r.obs["babip"]!);
    // Reconstruction is checked against the SHARED composite functions, not against stored numbers.
    const pw = pitWobaFromChannels(r.ours["k9"]!, r.ours["bb9"]!, r.ours["hr9"]!, r.ours["babip"]!, W);
    const ow = pitWobaFromChannels(r.obs["k9"]!, r.obs["bb9"]!, r.obs["hr9"]!, r.obs["babip"]!, W);
    return { pred, obs, n: r.sample * IP_TO_BF, predWoba: pw, obsWoba: ow, recon: { pred: total(pred) - pw, obs: total(obs) - ow }, inRange: true };
  }
  const { s: pred, inRange } = hitPredProps(r.ours, r.ours["woba"]!);
  const obs = hitObsProps(r.raw, r.raw["soPctPerPa"]!);
  const ow = hitWobaFromRates(
    { bbPct: r.raw["bbPct"]!, soPct: r.raw["soPctPerPa"]!, hr600: r.raw["hr600"]!, babip: r.raw["babip"]!, avg: r.raw["avg"]!, slg: r.raw["slg"]!, tripleXbh: r.raw["tripleXbh"]! }, W,
  );
  return { pred, obs, n: r.sample, predWoba: r.ours["woba"]!, obsWoba: ow, recon: { pred: total(pred) - r.ours["woba"]!, obs: total(obs) - ow }, inRange };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// §2. COVARIANCE MACHINERY
// ═════════════════════════════════════════════════════════════════════════════════════════════════

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

/** Sample covariance matrix (n−1) of a set of contribution vectors. */
function cov(vs: number[][]): number[][] {
  const n = vs.length;
  const m = CH.map((_, i) => mean(vs.map((v) => v[i]!)));
  const C = CH.map(() => CH.map(() => 0));
  for (const v of vs) for (let i = 0; i < NC; i++) for (let j = 0; j < NC; j++) C[i]![j]! += (v[i]! - m[i]!) * (v[j]! - m[j]!);
  const d = Math.max(n - 1, 1);
  for (let i = 0; i < NC; i++) for (let j = 0; j < NC; j++) C[i]![j]! /= d;
  return C;
}

/** MULTINOMIAL sampling-noise covariance of ONE card's observed contribution vector.
 *  Event counts over n trials are multinomial ⇒ Cov(p̂ᵢ,p̂ⱼ) = (δᵢⱼpᵢ − pᵢpⱼ)/n, so for the weighted
 *  contributions cᵢ = wᵢp̂ᵢ:  Nᵢⱼ = wᵢwⱼ(δᵢⱼpᵢ − pᵢpⱼ)/n.
 *  The OFF-DIAGONALS ARE NEGATIVE and material — assuming independent channels would UNDER-subtract
 *  and leave the observed covariance term spuriously low, biasing this test toward the hypothesis.
 *  The diagonal reduces to wᵢ²pᵢ(1−pᵢ)/n, i.e. exactly the binomial forms already used by
 *  src/eval/cwhit/scorecard.ts (per9NoiseVar / pctNoiseVar / per600NoiseVar) after unit conversion. */
function noiseCov(s: Props, n: number): number[][] {
  const N = CH.map(() => CH.map(() => 0));
  if (!(n > 0)) return N;
  for (let i = 0; i < NC; i++) for (let j = 0; j < NC; j++) {
    const pi = s.p[CH[i]!]!, pj = s.p[CH[j]!]!;
    N[i]![j]! = wOf(CH[i]!) * wOf(CH[j]!) * ((i === j ? pi : 0) - pi * pj) / n;
  }
  return N;
}

const sub = (A: number[][], B: number[][]) => A.map((row, i) => row.map((x, j) => x - B[i]![j]!));
const meanMat = (Ms: number[][][]) => CH.map((_, i) => CH.map((__, j) => mean(Ms.map((M) => M[i]![j]!))));

interface Decomp { marg: number; cov2: number; total: number }
function split(C: number[][]): Decomp {
  let marg = 0, cv = 0;
  for (let i = 0; i < NC; i++) { marg += C[i]![i]!; for (let j = i + 1; j < NC; j++) cv += C[i]![j]!; }
  return { marg, cov2: 2 * cv, total: marg + 2 * cv };
}
function corrOf(C: number[][]): number[][] {
  return CH.map((_, i) => CH.map((__, j) => {
    const d = Math.sqrt(C[i]![i]! * C[j]![j]!);
    return d > 0 ? C[i]![j]! / d : NaN;
  }));
}

/** Everything the headline needs, from one set of cards. */
function analyse(cells: Cell[]) {
  const P = cells.map((c) => contrib(c.pred)), O = cells.map((c) => contrib(c.obs));
  const Cp = cov(P), Co = cov(O);
  const Nbar = meanMat(cells.map((c) => noiseCov(c.obs, c.n)));
  const Cd = sub(Co, Nbar);
  const dp = split(Cp), dor = split(Co), dd = split(Cd);
  return { Cp, Co, Nbar, Cd, dp, dor, dd };
}

// ── bootstrap (card-resampled, deterministic) ────────────────────────────────────────────────────
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const ciOf = (xs: number[]): [number, number] => {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length < 20) return [NaN, NaN];
  return [v[Math.floor(0.025 * v.length)]!, v[Math.min(Math.floor(0.975 * v.length), v.length - 1)]!];
};

const B = 2000;
/** Card-resampled bootstrap over every headline quantity. */
function boot(cells: Cell[], seed: number) {
  const rnd = rng(seed), n = cells.length;
  const acc: Record<string, number[]> = { dMarg: [], dCov: [], gap: [], shareCov: [], ratio: [], ratioIfCov: [], ratioIfMarg: [], predCovShare: [], obsCovShare: [] };
  const pairAcc = CH.flatMap((_, i) => CH.map((__, j) => (i < j ? [] as number[] : null))).filter((x): x is number[] => x !== null);
  for (let b = 0; b < B; b++) {
    const rs: Cell[] = [];
    for (let k = 0; k < n; k++) rs.push(cells[Math.floor(rnd() * n)]!);
    const a = analyse(rs);
    const dMarg = a.dd.marg - a.dp.marg, dCov = a.dd.cov2 - a.dp.cov2, gap = a.dd.total - a.dp.total;
    acc["dMarg"]!.push(dMarg); acc["dCov"]!.push(dCov); acc["gap"]!.push(gap);
    acc["shareCov"]!.push(gap !== 0 ? dCov / gap : NaN);
    acc["ratio"]!.push(Math.sqrt(Math.max(a.dp.total, 0) / Math.max(a.dd.total, 1e-12)));
    acc["ratioIfCov"]!.push(Math.sqrt(Math.max(a.dp.marg + a.dd.cov2, 0) / Math.max(a.dd.total, 1e-12)));
    acc["ratioIfMarg"]!.push(Math.sqrt(Math.max(a.dd.marg + a.dp.cov2, 0) / Math.max(a.dd.total, 1e-12)));
    acc["predCovShare"]!.push(a.dp.cov2 / a.dp.total);
    acc["obsCovShare"]!.push(a.dd.cov2 / a.dd.total);
    let t = 0;
    for (let i = 0; i < NC; i++) for (let j = i + 1; j < NC; j++) pairAcc[t++]!.push(2 * (a.Cd[i]![j]! - a.Cp[i]![j]!));
  }
  return { acc, pairAcc };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
console.log(`\n╔══════════════════════════════════════════════════════════════════════════════════════════════╗`);
console.log(`║  CHANNEL COVARIANCE DECOMPOSITION — is the composite spread gap a COVARIANCE deficit?         ║`);
console.log(`╚══════════════════════════════════════════════════════════════════════════════════════════════╝`);
console.log(`model '${trained.id}' | catalog '${srcId}' | neutral env (bronze-quick era/park) | own-gap pool transform ON`);
console.log(`PRODUCTION CORRECTIONS: ${CORRECTIONS ? "ON (production default: BUILD-1 pit K-spread + BUILD-3 pit HR9 spread + BUILD-2 hitter tail; pit BABIP HELD)" : "OFF (--no-corrections)"}`);
console.log(`well-sampled bar: IP≥${MIN_IP} (pit) / PA≥${MIN_PA} (hit).  Bootstrap: ${B} card-resampled reps, percentile CIs.`);
console.log(`CHANNEL BASIS (weighted contributions, wOBA units): ${CH.map((c) => CH_LBL[c]).join(", ")} + a CONSTANT HBP leg (zero variance, dropped from covariance).`);
console.log(`  wOBA weights: bb=${f(W.bb, 4)} hbp=${f(W.hbp, 4)} 1B=${f(W.b1, 4)} XBH=${f(W.xbh, 4)} HR=${f(W.hr, 4)}`);
console.log(`  ⚠ SO/K IS NOT A wOBA CHANNEL — it carries no weight in either composite and enters only via the BIP denominator.`);
console.log(`    The work order named SO as a hitter channel; the "parts must sum to the whole" constraint overrides that. FLAGGED, not resolved.`);
console.log(`  ⚠ PITCHER 1B and XBH ARE DEGENERATE. cwhit's pitcher table has NO 1B/2B/3B split, so BOTH the predicted and the observed`);
console.log(`    pitcher composites split non-HR hits with the SAME FIXED 0.25 XBH share (audit.ts#pitWobaFromChannels). 1B and XBH are`);
console.log(`    therefore exactly collinear on both sides: corr ≡ +1.000 and the 1B×XBH pair deficit is an ARTIFACT, not a finding.`);
console.log(`    The pitcher basis is effectively 3-dimensional {BB, hits, HR}. This is a DATA limit, not a modelling choice. FLAGGED.`);
for (const s of notices) console.log(`  · ${s}`);

const cellsBy = new Map<string, Cell[]>();
const recsBy = new Map<string, Rec[]>();
for (const { tier } of QUICK) for (const role of ["pit", "hit"] as const) {
  const rows = recs.filter((r) => r.tier === tier && r.role === role && wellSampled(r));
  if (!rows.length) continue;
  recsBy.set(`${tier}|${role}`, rows);
  cellsBy.set(`${tier}|${role}`, rows.map(decompose));
}

// ── §1. RECONSTRUCTION CHECK ─────────────────────────────────────────────────────────────────────
console.log(`\n\n╔═══ §1. RECONSTRUCTION CHECK — do the weighted channels SUM to the composite, per card? ═══════╗`);
console.log(`Residual = Σ(weighted channels) + w_hbp·HBP − composite, where the composite is recomputed by the SHARED`);
console.log(`functions (pitWobaFromChannels / hitWobaFromRates / the builder's own hitter wOBA). Tolerance 1e-9.`);
console.log(`\ncell                 N    max|resid| PRED   max|resid| OBS   GAP-in-range (pred hit)`);
let reconFail = false;
for (const [k, cells] of cellsBy) {
  const mp = Math.max(...cells.map((c) => Math.abs(c.recon.pred)));
  const mo = Math.max(...cells.map((c) => Math.abs(c.recon.obs)));
  const bad = cells.filter((c) => !c.inRange).length;
  if (mp > 1e-9 || mo > 1e-9) reconFail = true;
  console.log(`${k.padEnd(18)} ${String(cells.length).padStart(3)}    ${e3(mp).padStart(13)}   ${e3(mo).padStart(13)}   ${bad === 0 ? "all in range" : `${bad} OUT OF RANGE`}`);
}
if (reconFail) {
  console.log(`\n  ✗ RECONSTRUCTION FAILED — the decomposition does not sum to the composite. STOPPING: nothing downstream is valid.`);
  process.exit(1);
}
console.log(`\n  ✓ every cell reconstructs to <1e-9. The parts provably sum to the whole.`);
console.log(`  CAVEAT (stated, not resolved): the PREDICTED HITTER 1B/XBH split is IDENTIFIED FROM the composite identity`);
console.log(`  (the builder publishes 4 rate channels + wOBA, not the GAP count), so its residual is vacuous by construction.`);
console.log(`  The falsifiable check for that cell is the GAP-in-range column above. Every other cell's residual is a real check.`);

// ── §2. VARIANCE DECOMPOSITION ───────────────────────────────────────────────────────────────────
console.log(`\n\n╔═══ §2. VARIANCE DECOMPOSITION — Σvar vs 2Σcov, PREDICTED vs NOISE-CORRECTED OBSERVED ═════════╗`);
console.log(`Var(composite) = Σᵢ Var(cᵢ) + 2Σ_{i<j} Cov(cᵢ,cⱼ).  All figures ×1e4 (wOBA² units).`);
console.log(`OBS* = observed covariance MINUS the mean per-card MULTINOMIAL sampling-noise matrix (negative off-diagonals included).`);
console.log(`RAW-ratio = SD_pred/SD_obs BEFORE noise correction — this is the ~0.6-style number the hypothesis starts from.`);
console.log(`PSD = does the noise-corrected matrix stay a valid covariance matrix? "!" = it does NOT (a |corr|>1 or a`);
console.log(`      non-positive variance appeared), i.e. the multinomial noise model OVER-subtracts in that cell. Read those rows with care.`);
console.log(`\n                     ┌──────────── PREDICTED ────────────┐ ┌────── OBSERVED (raw) ─────┐ ┌──────── OBSERVED* (noise-corrected) ────────┐`);
console.log(`cell            N     Σvar     2Σcov    total  cov%      total    noise  RAW-ratio    total    Σvar     2Σcov    cov%   SD    SD_pred/SD_obs*  PSD`);

interface Head { key: string; tier: string; role: string; n: number; a: ReturnType<typeof analyse>; bs: ReturnType<typeof boot> }
const heads: Head[] = [];
let seed = 20260720;
for (const [key, cells] of cellsBy) {
  const a = analyse(cells);
  const [tier, role] = key.split("|") as [string, string];
  const bs = boot(cells, seed++);
  heads.push({ key, tier, role, n: cells.length, a, bs });
  const noiseTot = split(a.Nbar).total;
  const sdo = Math.sqrt(Math.max(a.dd.total, 0));
  const rawRatio = Math.sqrt(Math.max(a.dp.total, 0) / Math.max(a.dor.total, 1e-12));
  const R = corrOf(a.Cd);
  const psdBad = a.Cd.some((row, i) => row[i]! <= 0) || R.some((row, i) => row.some((x, j) => i !== j && Number.isFinite(x) && Math.abs(x) > 1));
  console.log(
    `${key.padEnd(14)} ${String(cells.length).padStart(3)}  ${f(a.dp.marg * 1e4, 2).padStart(7)}  ${sgn(a.dp.cov2 * 1e4, 2).padStart(7)}  ${f(a.dp.total * 1e4, 2).padStart(7)}  ${f((a.dp.cov2 / a.dp.total) * 100, 0).padStart(4)}%   ` +
    `${f(a.dor.total * 1e4, 2).padStart(7)}  ${f(noiseTot * 1e4, 2).padStart(7)}   ${f(rawRatio, 3).padStart(6)}   ` +
    `${f(a.dd.total * 1e4, 2).padStart(7)}  ${f(a.dd.marg * 1e4, 2).padStart(7)}  ${sgn(a.dd.cov2 * 1e4, 2).padStart(7)}  ${f((a.dd.cov2 / a.dd.total) * 100, 0).padStart(4)}%  ${f(sdo, 4)}  ${f(Math.sqrt(Math.max(a.dp.total, 0) / Math.max(a.dd.total, 1e-12)), 3).padStart(5)}   ${psdBad ? "!" : "ok"}`,
  );
}
console.log(`\n  THIN CELLS: any N<20 is a thin cell — read no trend off it. diamond pit is structurally DEAD (N≈1); diamond hit is ~N≈17.`);

// ── §3. THE KEY NUMBER ───────────────────────────────────────────────────────────────────────────
console.log(`\n\n╔═══ §3. THE KEY NUMBER — how much of the composite spread gap is COVARIANCE, how much MARGINAL? ═══╗`);
console.log(`GAP = Var_obs* − Var_pred  =  ΔΣvar  +  Δ2Σcov   (adds up EXACTLY by construction).`);
console.log(`ratio      = SD_pred / SD_obs* (the composite spread ratio to be explained).`);
console.log(`if-cov     = the ratio if predicted kept ITS OWN marginals but took OBSERVED*'s covariance term.`);
console.log(`if-marg    = the ratio if predicted kept ITS OWN covariance but took OBSERVED*'s marginals.`);
console.log(`Whichever counterfactual moves the ratio to ~1.0 is the term that carries the gap.`);
for (const h of heads) {
  const { a, bs } = h;
  const dM = a.dd.marg - a.dp.marg, dC = a.dd.cov2 - a.dp.cov2, gap = a.dd.total - a.dp.total;
  // CIs on the two variance TERMS are reported in the same ×1e4 units as the point estimates.
  const ci4 = (k: string) => { const [lo, hi] = ciOf(bs.acc[k]!); return `[${sgn(lo * 1e4, 2)}, ${sgn(hi * 1e4, 2)}]`; };
  const cir = (k: string) => { const [lo, hi] = ciOf(bs.acc[k]!); return `[${f(lo, 3)}, ${f(hi, 3)}]`; };
  const thin = h.n < 20 ? `   ⚠ THIN CELL (N=${h.n}) — no trend may be read off this row` : "";
  console.log(`\n─── ${h.key.toUpperCase()}  N=${h.n}${thin} ───`);
  console.log(`  GAP  ${sgn(gap * 1e4, 2)}e-4   =   ΔΣvar ${sgn(dM * 1e4, 2)}e-4  ${ci4("dMarg")}   +   Δ2Σcov ${sgn(dC * 1e4, 2)}e-4  ${ci4("dCov")}`);
  // SHARE-OF-GAP is a ratio whose DENOMINATOR is the gap itself. When the gap is near zero the share
  // is numerically meaningless (it explodes and its CI spans ±thousands of percent) — and a near-zero
  // gap is itself the headline, so the shares are SUPPRESSED rather than printed as noise.
  const stable = Math.abs(gap) > 0.10 * Math.abs(a.dd.total);
  if (stable) console.log(`  share of GAP:   marginal ${f((dM / gap) * 100, 0)}%    covariance ${f((dC / gap) * 100, 0)}%   (cov share 95% CI ${cir("shareCov")})`);
  else console.log(`  share of GAP:   SUPPRESSED — |GAP| is <10% of Var_obs*, i.e. THERE IS NO MATERIAL COMPOSITE GAP IN THIS CELL to apportion.`);
  console.log(`  cov as share of total variance:  predicted ${f((a.dp.cov2 / a.dp.total) * 100, 0)}% ${cir("predCovShare")}   observed* ${f((a.dd.cov2 / a.dd.total) * 100, 0)}% ${cir("obsCovShare")}`);
  console.log(`  ratio ${f(Math.sqrt(Math.max(a.dp.total, 0) / Math.max(a.dd.total, 1e-12)), 3)} ${cir("ratio")}   →   if-cov ${f(Math.sqrt(Math.max(a.dp.marg + a.dd.cov2, 0) / Math.max(a.dd.total, 1e-12)), 3)} ${cir("ratioIfCov")}   |   if-marg ${f(Math.sqrt(Math.max(a.dd.marg + a.dp.cov2, 0) / Math.max(a.dd.total, 1e-12)), 3)} ${cir("ratioIfMarg")}`);
  const marginalRatio = Math.sqrt(Math.max(a.dp.marg, 0) / Math.max(a.dd.marg, 1e-12));
  const covRatio = a.dd.cov2 !== 0 ? a.dp.cov2 / a.dd.cov2 : NaN;
  console.log(`  MARGINAL-ONLY spread ratio √(Σvar_pred / Σvar_obs*) = ${f(marginalRatio, 3)};  COVARIANCE-TERM ratio 2Σcov_pred / 2Σcov_obs* = ${f(covRatio, 3)}`);
  console.log(`    ⇒ ${marginalRatio > 0.85 && marginalRatio < 1.18 ? "marginals ≈ right" : marginalRatio <= 0.85 ? "marginals SHORT" : "marginals OVER"}; ${!stable ? "and the composite total already matches ⇒ NOTHING for a covariance deficit to explain in this cell." : Math.abs(dC) > Math.abs(dM) ? "the covariance term carries the larger part of the (real) gap." : "the MARGINAL term carries the larger part of the (real) gap."}`);
}

// ── §4. CORRELATION MATRICES ─────────────────────────────────────────────────────────────────────
console.log(`\n\n╔═══ §4. CHANNEL CORRELATION MATRICES — predicted vs observed vs observed* ═════════════════════╗`);
console.log(`⚠ OBSERVED* correlations can exceed |1|. That is NOT a bug: subtracting the noise matrix does not preserve`);
console.log(`  positive-semi-definiteness, and it blows up wherever a channel's TRUE variance is near zero after subtraction`);
console.log(`  — which is exactly the degenerate pitcher 1B/XBH pair. Treat any |corr|>1 as "this cell's noise model`);
console.log(`  over-subtracts here", not as a measured correlation. FLAGGED, not patched.`);
for (const h of heads) {
  console.log(`\n─── ${h.key.toUpperCase()}  N=${h.n}${h.n < 20 ? "  ⚠ THIN" : ""} ───`);
  const show = (lbl: string, C: number[][]) => {
    console.log(`  ${lbl}`);
    console.log(`        ` + CH.map((c) => CH_LBL[c].padStart(8)).join(""));
    for (let i = 0; i < NC; i++) console.log(`  ${CH_LBL[CH[i]!].padEnd(6)}` + CH.map((_, j) => sgn(corrOf(C)[i]![j]!, 3).padStart(8)).join(""));
  };
  show("PREDICTED", h.a.Cp);
  show("OBSERVED (raw)", h.a.Co);
  show("OBSERVED* (noise-corrected)", h.a.Cd);
}

// ── §5. WORST CHANNEL PAIRS ──────────────────────────────────────────────────────────────────────
console.log(`\n\n╔═══ §5. WORST CHANNEL PAIRS — where is the predicted covariance most deficient? ═══════════════╗`);
console.log(`deficit = 2·(Cov_obs*(i,j) − Cov_pred(i,j)), i.e. that pair's own contribution to Δ2Σcov (×1e4).`);
console.log(`POSITIVE ⇒ reality couples the pair MORE than the model does (the model generates them too independently).`);
for (const h of heads) {
  const pairs: { lbl: string; def: number; lo: number; hi: number; rp: number; ro: number; shareOfGap: number }[] = [];
  const gap = h.a.dd.total - h.a.dp.total;
  const cp = corrOf(h.a.Cp), co = corrOf(h.a.Cd);
  let t = 0;
  for (let i = 0; i < NC; i++) for (let j = i + 1; j < NC; j++) {
    const [lo, hi] = ciOf(h.bs.pairAcc[t]!); t++;
    const def = 2 * (h.a.Cd[i]![j]! - h.a.Cp[i]![j]!);
    pairs.push({ lbl: `${CH_LBL[CH[i]!]}×${CH_LBL[CH[j]!]}`, def, lo, hi, rp: cp[i]![j]!, ro: co[i]![j]!, shareOfGap: def / gap });
  }
  pairs.sort((a, b) => b.def - a.def);
  console.log(`\n─── ${h.key.toUpperCase()}  N=${h.n}${h.n < 20 ? "  ⚠ THIN" : ""} ───`);
  console.log(`  pair        deficit×1e4   [95% CI]              corr pred   corr obs*   share of composite GAP`);
  for (const p of pairs) {
    const sig = Number.isFinite(p.lo) && p.lo * p.hi > 0 ? "*" : " ";
    console.log(`  ${p.lbl.padEnd(10)} ${sgn(p.def * 1e4, 3).padStart(9)}${sig}   [${sgn(p.lo * 1e4, 2)}, ${sgn(p.hi * 1e4, 2)}]`.padEnd(52) + `${sgn(p.rp, 3).padStart(8)}   ${sgn(p.ro, 3).padStart(8)}      ${f(p.shareOfGap * 100, 0).padStart(5)}%`);
  }
  console.log(`  (* = 95% bootstrap CI excludes 0.)`);
}
console.log(`\nREAD: a positive, CI-clear deficit on a pair means the model under-couples those two channels relative to real cards.`);
console.log(`      That is the actionable output — it names WHICH channels are being generated too independently.\n`);
process.exit(0);
