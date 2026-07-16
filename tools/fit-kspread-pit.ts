// PITCHER K-SPREAD SPACING CORRECTION — fit, held-out validation, weird-env battery, two-axis gate.
//   run: node tools/fit-kspread-pit.ts
//
// EVIDENCE BASE (docs/CWHIT_MMSE_BATTERY_2026-07-16.md): pitcher K9 calibration slope obs~pred =
// 1.73 [1.65,1.80] pooled, FLAT across quality bands (scalar-correct), monotone in the opponent-frame
// gap (iron 1.90 → gold 1.43). League in-frame K is already calibrated (insample-frame-check) ⇒ the
// amplification is a tournament-frame parameter by construction and s(gap→0)=1 is anchored by the
// league, not fit. Value stake: 4.6 mwOBA/card SD — the program's #1.
//
// WHAT THIS IS NOT: the refuted frame-v2 kSpread (that died as part of the additive-frame PACKAGE).
// This is a standalone multiplicative spread scalar on the CURRENT own-gap scoring path:
//     K_corr = K̄_pool + s(gap)·(K_pred − K̄_pool),   s(g) = 1 + A·(1 − e^(−g/G)),  s(0) = 1 hard
// applied to the raw model K PRE-BIP PRE-ERA (the placement verified correct in the old joint run;
// the surviving kSpread plumbing in score-card.ts/calibrate.ts is reused as-is). Monotone in K_pred
// ⇒ within-pool K ordering unchanged by construction (verified empirically anyway, §4).
//
// gap = the own-channel stu gap convention from the EXISTING frame machinery:
//     gap_pit = buildFrameShift(trainingMeans, poolField).pit.vR.stu
// (= trainingMeans.hit.kRat − poolField.hit.kRat.mu — the opposing-hitter K-avoid gap assigned to the
// pitcher K channel by the §10.2 crossing; the same number tools/tournament-kslope.ts and
// tools/fit-sgap.ts used). K̄_pool = poolMeanKOwn (top-50 field mean predicted K on OWN-GAP ratings —
// the own-gap sibling of production's poolMeanK centering convention).
//
// STEPS: (1) measure per-tier K9 calibration slopes on the cwhit Quick tiers (buildCwhitSample — the
// scorecard's exact path) and fit the ramp PRECISION-WEIGHTED (inverse-variance; iron/bronze dominate);
// (2) held-out: fit without bronze, predict bronze's slope; (3) weird-env battery on the three
// confirmed daily/cap formats (earlygolddaily/early-gold, bronzeheartdaily/bronze-heart,
// goldcapdaily/gold-cap — diamondcapdaily EXCLUDED, Derek: no config); (4) two-axis gate.
// Pre-registered gates — never tuned past a failure:
//   G1 post-fix per-tier K9 slope ≈ 1 within CI;   G2 composite wOBAA ordering corr MUST NOT DROP;
//   G3 level bias unchanged (scalar centered on K̄_pool; the top-100 sample sits off the pool mean,
//      so the algebraic expectation (s−1)·(K̄_sample−K̄_pool) is printed next to the measured move);
//   G4 spread ratios move toward the deconvolved-honest optimum (ratioDcv → optRatio).

import { readFileSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import {
  makeRawPolyModel, computeUnifiedFieldStats, applyWobaWeights, computeDerived, calibrate,
  buildPoolTransform, buildFrameShift, poolMeanKOwn,
  type EventForm, type FieldStats, type RatingEnvelope, type WobaWeights, type TrainingMeans,
} from "../src/scoring-core/index.ts";
import { parseCatalogCsv, type Card } from "../src/data/catalog.ts";
import { makeVariant } from "../src/data/variants.ts";
import { rowEligible } from "../src/config/eligibility.ts";
import { pitWobaFromChannels, type WobaWeights as WW } from "../src/eval/cwhit/audit.ts";
import { per9NoiseVar, babipNoiseVar, pearson, spearman, BF_PER_9 } from "../src/eval/cwhit/scorecard.ts";
import { mmse, meanEst, type Mmse, type Est } from "../src/eval/cwhit/two-ledger.ts";
import { parseCwhitPit } from "../src/eval/cwhit/parse.ts";
import { joinCwhit, type JoinCard, type JoinObs } from "../src/eval/cwhit/join.ts";
import {
  buildCwhitSample, wellSampled, ourPit, cardName, handLetter, isPit, n_,
  QUICK, MIN_IP, FIELD_N, OBS_DIR,
  type Rec, type SampleDeps, type KSpreadPit,
} from "../src/eval/cwhit/sample.ts";

const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const sgn = (x: number, d = 2) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}` : "n/a");
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

// ── deployed model + neutral env (IDENTICAL setup to tools/cwhit-mmse.ts) ──
const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state = (await repo.load<{ activeModelId?: string; catalogSourceId?: string }>("state", "app")) ?? {};
type TM_ = { id: string; eventForm?: EventForm; wobaWeights?: WobaWeights; ratingEnvelope?: RatingEnvelope; trainingMeans?: TrainingMeans; platoon?: { pit: { hand: string; vsRHB: number; vsLHB: number }[]; hit: { hand: string; vsRHP: number; vsLHP: number }[] } };
const trained = (await repo.loadAll<TM_>("trained-models")).find((x) => x.id === state.activeModelId);
if (!trained?.eventForm || !trained.wobaWeights || !trained.platoon) throw new Error("active model missing eventForm/wobaWeights/platoon");
if (!trained.trainingMeans) throw new Error("active model has NO trainingMeans — the gap convention needs the artifact frame (retrain post-f88912c)");
const TM = trained.trainingMeans;
const rp = makeRawPolyModel(trained.eventForm);
const W = trained.wobaWeights as WW;
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const tournaments = await repo.loadAll<Tournament>("tournaments");
const bq = tournaments.find((t) => t.id === "bronze-quick")!;
const coeffs = resolveCoeffs(model, eras.get(bq.eraId)!, parks.get(bq.parkId)!, bq.softcaps);
applyWobaWeights(coeffs, trained.wobaWeights);
const derived = computeDerived(coeffs);
const srcId = state.catalogSourceId ?? "cdmx";
const baseCards = parseCatalogCsv(readFileSync(`data/imports/${srcId}.csv`, "utf8")).cards.filter((c) => String(c["Variant"] ?? "").toUpperCase() !== "Y");
const ref: FieldStats = computeUnifiedFieldStats(baseCards, coeffs, rp, FIELD_N, true);
const deps: SampleDeps = {
  baseCards, coeffs, derived, eventForm: trained.eventForm, model: rp, W, ref, envelope: trained.ratingEnvelope,
  pitExp: new Map(trained.platoon.pit.map((p) => [p.hand, { wR: p.vsRHB, wL: p.vsLHB }])),
  hitExp: new Map(trained.platoon.hit.map((p) => [p.hand, { wR: p.vsRHP, wL: p.vsLHP }])),
};

// per-card observed K9 sampling variance (same noise model as tools/cwhit-mmse.ts; tools are
// entry-point scripts, so the composition is copied rather than imported from another tool).
const k9Noise = (k9: number, ip: number) => per9NoiseVar(k9, ip);

// ── bootstrap plumbing (seeded/deterministic, same generator as the battery) ──
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pct = (xs: number[], q: number) => { const v = [...xs].sort((a, b) => a - b); return v.length ? v[Math.min(Math.max(Math.floor(q * v.length), 0), v.length - 1)]! : NaN; };
const ci = (xs: number[]) => ({ lo: pct(xs, 0.025), hi: pct(xs, 0.975) });
function slopeOf(p: number[], o: number[]): number {
  const mp = mean(p), mo = mean(o);
  let sxx = 0, sxy = 0;
  for (let i = 0; i < p.length; i++) { sxx += (p[i]! - mp) ** 2; sxy += (p[i]! - mp) * (o[i]! - mo); }
  return sxx > 0 ? sxy / sxx : NaN;
}
const B = 2000, SEED = 20260716;

// ── the ramp + its weighted fit (closed-form A per G, grid-search G) ──────────
const sOf = (A: number, G: number) => (g: number) => (g > 0 ? 1 + A * (1 - Math.exp(-g / G)) : 1);
interface FitPt { g: number; m: number; w: number }
function fitRamp(pts: FitPt[], gLo = 0.5, gHi = 400, step = 0.5): { A: number; G: number; sse: number; profile: { G: number; A: number; sse: number }[] } {
  let best = { A: NaN, G: NaN, sse: Infinity };
  const profile: { G: number; A: number; sse: number }[] = [];
  for (let G = gLo; G <= gHi + 1e-9; G += step) {
    let num = 0, den = 0;
    for (const p of pts) { const u = 1 - Math.exp(-p.g / G); num += p.w * u * (p.m - 1); den += p.w * u * u; }
    const A = den > 0 ? num / den : 0;
    const sse = pts.reduce((a, p) => a + p.w * (1 + A * (1 - Math.exp(-p.g / G)) - p.m) ** 2, 0);
    profile.push({ G, A, sse });
    if (sse < best.sse) best = { A, G, sse };
  }
  return { ...best, profile };
}

// ═════════════════════════════════════════════════════════════════════════════
console.log(`\n╔════════════════════════════════════════════════════════════════════════════════════════╗`);
console.log(`║  PITCHER K-SPREAD SPACING CORRECTION — fit · held-out · weird-env battery · two-axis gate ║`);
console.log(`╚════════════════════════════════════════════════════════════════════════════════════════╝`);
console.log(`model '${trained.id}' | catalog '${srcId}' | eval frame = RAW event line, own-gap ON, no anchor`);
console.log(`gap convention: buildFrameShift(trainingMeans, poolField).pit.vR.stu (own-channel stu gap, §10.2 crossing)`);
console.log(`K̄_pool convention: poolMeanKOwn (top-${FIELD_N} field, OWN-GAP ratings, pre-era K/600)`);

// ═══ 0. PER-TIER MEASUREMENT (pre-fix) ═══════════════════════════════════════
const pre = buildCwhitSample(deps);
interface TierCell {
  tier: string; gap: number; kbar: number;
  rows: { pred: number; obs: number; nv: number; rec: Rec }[];
  m: Mmse;
}
const cells: TierCell[] = [];
for (const { tier, cap } of QUICK) {
  const basePool = deps.baseCards.filter((c) => n_(c["Card Value"]) <= cap);
  const poolField = computeUnifiedFieldStats(basePool, coeffs, rp, FIELD_N, true);
  const gap = buildFrameShift(TM, poolField).pit.vR.stu ?? 0;
  const pt = buildPoolTransform(ref, poolField, deps.envelope);
  const kbar = poolMeanKOwn(basePool, coeffs, rp, pt, FIELD_N).pit;
  const rows = pre.recs
    .filter((r) => r.tier === tier && r.role === "pit" && wellSampled(r) && Number.isFinite(r.ours.k9) && Number.isFinite(r.obs.k9))
    .map((r) => ({ pred: r.ours.k9!, obs: r.obs.k9!, nv: k9Noise(r.obs.k9!, r.sample), rec: r }));
  if (rows.length < 5) { console.log(`\n[${tier}] N=${rows.length} < 5 — excluded from the fit entirely (diamond pit is the known dead cell)`); continue; }
  cells.push({ tier, gap, kbar, rows, m: mmse(rows.map((r) => r.pred), rows.map((r) => r.obs), rows.map((r) => r.nv)) });
}

// per-tier bootstrap slopes (one pass; reused for the tier CIs AND the ramp-fit CIs)
const rnd = rng(SEED);
const bootTier: number[][] = cells.map(() => []);   // [cellIdx][rep]
for (let b = 0; b < B; b++) {
  cells.forEach((c, i) => {
    const rs = c.rows.map(() => c.rows[Math.floor(rnd() * c.rows.length)]!);
    const s = slopeOf(rs.map((r) => r.pred), rs.map((r) => r.obs));
    bootTier[i]!.push(s);
  });
}

console.log(`\n╔═══ 1. PER-TIER MEASUREMENT — K9 calibration slope (obs~pred), gap, K̄_pool ═══╗`);
console.log(`tier      N    gap(stu)   K̄_pool/600   slope   [boot 95% CI]   se(t)    corr   ratioRaw/Dcv  optRatio`);
for (let i = 0; i < cells.length; i++) {
  const c = cells[i]!, b = ci(bootTier[i]!.filter(Number.isFinite));
  console.log(`${c.tier.padEnd(8)} ${String(c.rows.length).padStart(3)}   ${f(c.gap, 1).padStart(7)}   ${f(c.kbar, 1).padStart(9)}    ${f(c.m.slope.est, 2).padStart(5)}   [${f(b.lo, 2)},${f(b.hi, 2)}]     ${f(c.m.slope.se, 3)}   ${f(c.m.corrRaw, 3)}   ${f(c.m.ratioRaw, 2)}/${f(c.m.ratioDeconv, 2)}      ${f(c.m.optimalRatio, 2)}`);
}

// ═══ 2. THE FIT — precision-weighted ramp, all tiers ═════════════════════════
// G IDENTIFIABILITY + THE SHIPPING PIN: with four tiers spanning g ≈ 19–28, the exponential's
// saturation scale is identified only as a LOWER bound (the profile flattens upward — in the
// g ≪ G regime the ramp degenerates to the linear s = 1 + (A/G)·g, and only A/G is pinned).
// The shipping candidate takes the MOST-SATURATING member of the 5% SSE-equivalence band
// (smallest G, A refit at it): every member fits the observed gaps equally, and the smallest-G
// member extrapolates the LEAST extra amplification at gaps beyond anything observed — the
// conservative end of the equivalence class, chosen by rule, not by eye.
// Ceiling-free: the profile falls monotonically toward the LINEAR LIMIT (G→∞ ⇒ s = 1 + β·g with
// β = Σw·g·(m−1)/Σw·g², the actually-identified quantity), so "within 5% of the optimum" is judged
// against THAT limit, not against whatever the grid ceiling happened to be.
function linLimit(pts: FitPt[]): { beta: number; sse: number } {
  let num = 0, den = 0;
  for (const p of pts) { num += p.w * p.g * (p.m - 1); den += p.w * p.g * p.g; }
  const beta = den > 0 ? num / den : 0;
  return { beta, sse: pts.reduce((a, p) => a + p.w * (1 + beta * p.g - p.m) ** 2, 0) };
}
function pinShip(fit: ReturnType<typeof fitRamp>, pts: FitPt[]): { A: number; G: number } {
  const lim = linLimit(pts);
  const band = fit.profile.filter((p) => p.sse <= lim.sse * 1.05);
  if (!band.length) return { A: fit.A, G: fit.G }; // exponential beats the linear limit outright
  const G = Math.min(...band.map((p) => p.G));
  return { A: band.find((p) => p.G === G)!.A, G };
}
const pts: FitPt[] = cells.map((c) => ({ g: c.gap, m: c.m.slope.est, w: 1 / c.m.slope.se ** 2 }));
const full = fitRamp(pts);
const lim = linLimit(pts);
const band = full.profile.filter((p) => p.sse <= lim.sse * 1.05);
const gLoB = band.length ? Math.min(...band.map((p) => p.G)) : NaN, gHiB = band.length ? Math.max(...band.map((p) => p.G)) : NaN;
const ship = pinShip(full, pts);
const sFull = sOf(ship.A, ship.G);

// bootstrap the fit (per-rep per-tier slopes, ORIGINAL precision weights — fixed design);
// each replicate applies the SAME pin rule, so the CIs are CIs of the shipping quantity.
const bootA: number[] = [], bootG: number[] = [], bootSAt: Record<string, number[]> = {};
const bootPredBronze: number[] = [];
const heldIdx = cells.map((c, i) => ({ c, i })).filter((x) => x.c.tier !== "bronze");
const bronzeCell = cells.find((c) => c.tier === "bronze");
for (let b = 0; b < B; b++) {
  const reps = cells.map((c, i) => ({ g: c.gap, m: bootTier[i]![b]!, w: pts[i]!.w }));
  if (reps.some((r) => !Number.isFinite(r.m))) continue;
  const pb = pinShip(fitRamp(reps, 0.5, 400, 2), reps);
  bootA.push(pb.A); bootG.push(pb.G);
  for (const c of cells) (bootSAt[c.tier] ??= []).push(sOf(pb.A, pb.G)(c.gap));
  if (bronzeCell) {
    const hReps = heldIdx.map(({ c, i }) => ({ g: c.gap, m: bootTier[i]![b]!, w: 1 / c.m.slope.se ** 2 }));
    const ph = pinShip(fitRamp(hReps, 0.5, 400, 2), hReps);
    bootPredBronze.push(sOf(ph.A, ph.G)(bronzeCell.gap));
  }
}
const aCI = ci(bootA), gCI = ci(bootG);

console.log(`\n╔═══ 2. FITTED RAMP (all tiers, precision-weighted; s(0)=1 hard — the league anchor) ═══╗`);
console.log(`  s(g) = 1 + A·(1 − e^(−g/G))`);
console.log(`  wide-grid optimum: A=${f(full.A, 3)} G=${f(full.G, 1)} (weighted SSE ${f(full.sse, 2)});  LINEAR LIMIT (G→∞): s = 1 + ${f(lim.beta, 4)}·g (SSE ${f(lim.sse, 2)})`);
console.log(`  G IDENTIFIABILITY: SSE within 5% of the linear limit over G ∈ [${f(gLoB, 1)}, ${f(gHiB, 1)}+] — ${!band.length || gHiB >= 399 ? "G is only LOWER-BOUNDED (profile flat upward; the tiers span g≈19–28, so only s at those gaps — effectively A/G ≈ β — is measured)" : "identified"}`);
console.log(`  SHIPPING PIN (most-saturating member within 5% of the linear limit — least extrapolation beyond observed gaps):`);
console.log(`  A = ${f(ship.A, 3)}  [boot 95% CI ${f(aCI.lo, 3)}, ${f(aCI.hi, 3)}]   (plateau s(∞) = ${f(1 + ship.A, 2)})`);
console.log(`  G = ${f(ship.G, 1)}  [boot 95% CI ${f(gCI.lo, 1)}, ${f(gCI.hi, 1)}]`);
console.log(`  s at the tier gaps vs the measured slopes (the fit's own residuals):`);
for (const c of cells) {
  const sci = ci(bootSAt[c.tier] ?? []);
  console.log(`    ${c.tier.padEnd(8)} g=${f(c.gap, 1).padStart(5)}  s(g)=${f(sFull(c.gap), 2)} [${f(sci.lo, 2)},${f(sci.hi, 2)}]   measured ${f(c.m.slope.est, 2)}   resid ${sgn(sFull(c.gap) - c.m.slope.est, 2)}`);
}

// ═══ 3. HELD-OUT VALIDATION — fit without bronze, predict bronze ═════════════
console.log(`\n╔═══ 3. HELD-OUT VALIDATION — fit WITHOUT bronze (the deepest tier), predict bronze's slope ═══╗`);
if (bronzeCell) {
  const hPts = heldIdx.map(({ c }) => ({ g: c.gap, m: c.m.slope.est, w: 1 / c.m.slope.se ** 2 }));
  const held = pinShip(fitRamp(hPts), hPts);
  const predB = sOf(held.A, held.G)(bronzeCell.gap);
  const pCI = ci(bootPredBronze);
  const bIdx = cells.indexOf(bronzeCell);
  const mCI = ci(bootTier[bIdx]!.filter(Number.isFinite));
  console.log(`  held-out fit (same pin rule): A=${f(held.A, 3)} G=${f(held.G, 1)}`);
  console.log(`  PREDICTED bronze slope s(g=${f(bronzeCell.gap, 1)}) = ${f(predB, 2)}  [${f(pCI.lo, 2)}, ${f(pCI.hi, 2)}]`);
  console.log(`  MEASURED  bronze slope            = ${f(bronzeCell.m.slope.est, 2)}  [${f(mCI.lo, 2)}, ${f(mCI.hi, 2)}]`);
  const overlap = pCI.lo <= mCI.hi && mCI.lo <= pCI.hi;
  console.log(`  VERDICT: ${overlap ? "PASS — the held-out prediction and the measurement are statistically one number" : "FAIL — the ramp fit on the other tiers does NOT predict bronze"}`);
} else console.log(`  bronze cell unavailable — held-out step skipped`);

// ═══ 4. TWO-AXIS GATE on the Quick tiers (refit-with-all = the shipping candidate) ═══
const ksMap = new Map<string, KSpreadPit>(cells.map((c) => [c.tier, { s: sFull(c.gap), mean: c.kbar }]));
const post = buildCwhitSample({ ...deps, kSpreadPit: ksMap });

// hitter identity: the correction is pitcher-ONLY — every hitter line must be bit-identical.
{
  const key = (r: Rec) => `${r.tier}|${r.title}|${r.vlvl}`;
  const preHit = new Map(pre.recs.filter((r) => r.role === "hit").map((r) => [key(r), r]));
  let maxD = 0, n = 0;
  for (const r of post.recs.filter((x) => x.role === "hit")) {
    const p0 = preHit.get(key(r)); if (!p0) continue;
    n++;
    for (const k of Object.keys(r.ours)) maxD = Math.max(maxD, Math.abs((r.ours[k] ?? 0) - (p0.ours[k] ?? 0)), Math.abs((r.oursDep[k] ?? 0) - (p0.oursDep[k] ?? 0)));
  }
  console.log(`\n  HITTER IDENTITY CHECK: ${n} hitter recs compared pre↔post, max |Δ| across all channels = ${maxD === 0 ? "0 (bit-identical ✓)" : `${maxD} ✗ THE CORRECTION LEAKED INTO THE HITTER PATH`}`);
  if (maxD !== 0) throw new Error("pitcher K-spread leaked into hitter lines");
}

interface GateRow {
  label: string; n: number; s: number;
  preSlope: Mmse; postSlope: Mmse; postCI: { lo: number; hi: number };
  preCorr: number; postCorr: number; dCorrCI: { lo: number; hi: number };
  preRho: number; postRho: number;
  preLevel: Est; postLevel: Est; expectedLevelMove: number;
  preRatio: number; postRatio: number; preRatioDcv: number; postRatioDcv: number; optRatio: number;
  k9OrderInversions: number;
}
function gateRows(preRows: { pred: number; obs: number; nv: number; rec: Rec }[], postByKey: Map<string, Rec>, s: number, kbar: number, eraK: number, label: string, seed: number): GateRow {
  const key = (r: Rec) => `${r.title}|${r.vlvl}`;
  const paired = preRows.map((r) => ({ ...r, post: postByKey.get(key(r.rec))! })).filter((r) => r.post);
  const preP = paired.map((r) => r.pred), obs = paired.map((r) => r.obs), nv = paired.map((r) => r.nv);
  const postP = paired.map((r) => r.post.ours.k9!);
  const preW = paired.map((r) => r.rec.ours.woba!), postW = paired.map((r) => r.post.ours.woba!), obsW = paired.map((r) => r.rec.obs.woba!);
  // k9 ordering identity (monotone by construction; verified anyway)
  const ordPre = paired.map((_, i) => i).sort((a, b) => preP[a]! - preP[b]!);
  const ordPost = paired.map((_, i) => i).sort((a, b) => postP[a]! - postP[b]!);
  let inv = 0; for (let i = 0; i < ordPre.length; i++) if (ordPre[i] !== ordPost[i]) inv++;
  // paired bootstrap for the post-slope CI and Δcorr CI
  const r2 = rng(seed);
  const postSlopes: number[] = [], dCorrs: number[] = [];
  for (let b = 0; b < B; b++) {
    const idx = paired.map(() => Math.floor(r2() * paired.length));
    postSlopes.push(slopeOf(idx.map((i) => postP[i]!), idx.map((i) => obs[i]!)));
    dCorrs.push(pearson(idx.map((i) => postW[i]!), idx.map((i) => obsW[i]!)) - pearson(idx.map((i) => preW[i]!), idx.map((i) => obsW[i]!)));
  }
  const preM = mmse(preP, obs, nv), postM = mmse(postP, obs, nv);
  return {
    label, n: paired.length, s,
    preSlope: preM, postSlope: postM, postCI: ci(postSlopes.filter(Number.isFinite)),
    preCorr: pearson(preW, obsW), postCorr: pearson(postW, obsW), dCorrCI: ci(dCorrs.filter(Number.isFinite)),
    preRho: spearman(preW, obsW), postRho: spearman(postW, obsW),
    preLevel: meanEst(paired.map((r) => r.pred - r.obs)), postLevel: meanEst(paired.map((r) => r.post.ours.k9! - r.obs)),
    expectedLevelMove: (s - 1) * (mean(preP) - kbar * eraK * (BF_PER_9 / 600)),
    preRatio: preM.ratioRaw, postRatio: postM.ratioRaw, preRatioDcv: preM.ratioDeconv, postRatioDcv: postM.ratioDeconv, optRatio: preM.optimalRatio,
    k9OrderInversions: inv,
  };
}
function printGate(g: GateRow) {
  const g1 = g.postCI.lo <= 1 && 1 <= g.postCI.hi;
  const g2 = g.postCorr >= g.preCorr || (g.dCorrCI.lo <= 0 && 0 <= g.dCorrCI.hi);
  console.log(`\n  ── ${g.label}  (N=${g.n}, s=${f(g.s, 2)}) ──`);
  console.log(`  G1 K9 slope:    pre ${f(g.preSlope.slope.est, 2)} → post ${f(g.postSlope.slope.est, 2)} [${f(g.postCI.lo, 2)},${f(g.postCI.hi, 2)}]   ${g1 ? "PASS (CI covers 1)" : "FAIL (CI excludes 1)"}`);
  console.log(`  G2 wOBAA corr:  pre ${f(g.preCorr, 4)} → post ${f(g.postCorr, 4)}  (Δ ${sgn(g.postCorr - g.preCorr, 4)} [${sgn(g.dCorrCI.lo, 4)},${sgn(g.dCorrCI.hi, 4)}])  rank ρ ${f(g.preRho, 4)} → ${f(g.postRho, 4)}   ${g2 ? "PASS (no drop / CI-compatible with 0)" : "FAIL (CI-clear ordering drop)"}`);
  console.log(`  G3 K9 level:    pre ${sgn(g.preLevel.est, 2)} [${sgn(g.preLevel.lo, 2)},${sgn(g.preLevel.hi, 2)}] → post ${sgn(g.postLevel.est, 2)} [${sgn(g.postLevel.lo, 2)},${sgn(g.postLevel.hi, 2)}]   (algebraic expectation of the move: ${sgn(g.expectedLevelMove, 2)} — the judged sample sits off K̄_pool)`);
  console.log(`  G4 spread:      ratioRaw ${f(g.preRatio, 2)} → ${f(g.postRatio, 2)}   ratioDcv ${f(g.preRatioDcv, 2)} → ${f(g.postRatioDcv, 2)}   (optimum = optRatio ${f(g.optRatio, 2)})`);
  console.log(`  K9 ordering:    ${g.k9OrderInversions === 0 ? "unchanged (0 rank moves ✓)" : `${g.k9OrderInversions} rank moves ✗`}`);
}

console.log(`\n╔═══ 4. TWO-AXIS GATE — Quick tiers, post-fix (shipping candidate = the all-tier fit) ═══╗`);
const postPitByTier = new Map<string, Map<string, Rec>>();
for (const r of post.recs) {
  if (r.role !== "pit") continue;
  (postPitByTier.get(r.tier) ?? postPitByTier.set(r.tier, new Map()).get(r.tier)!).set(`${r.title}|${r.vlvl}`, r);
}
const quickGates: GateRow[] = [];
let seedStep = 1;
for (const c of cells) {
  const g = gateRows(c.rows, postPitByTier.get(c.tier) ?? new Map(), sFull(c.gap), c.kbar, coeffs.era_k, `${c.tier} (quick)`, SEED + seedStep++);
  quickGates.push(g); printGate(g);
  // LOO influence read for a CI-clear G2 failure: at small N one card can own the verdict — say which.
  if (!(g.postCorr >= g.preCorr || (g.dCorrCI.lo <= 0 && 0 <= g.dCorrCI.hi))) {
    const key = (r: Rec) => `${r.title}|${r.vlvl}`;
    const paired = c.rows.map((r) => ({ r, post: postPitByTier.get(c.tier)!.get(key(r.rec))! })).filter((x) => x.post);
    const loo: { name: string; d: number }[] = [];
    for (let drop = 0; drop < paired.length; drop++) {
      const keep = paired.filter((_, i) => i !== drop);
      const d = pearson(keep.map((x) => x.post.ours.woba!), keep.map((x) => x.r.rec.obs.woba!))
        - pearson(keep.map((x) => x.r.rec.ours.woba!), keep.map((x) => x.r.rec.obs.woba!));
      loo.push({ name: paired[drop]!.r.rec.name, d });
    }
    loo.sort((a, b) => b.d - a.d);
    const flips = loo.filter((x) => x.d >= 0).length;
    console.log(`  LOO influence:  Δcorr leave-one-out range [${sgn(loo[loo.length - 1]!.d, 4)}, ${sgn(loo[0]!.d, 4)}]; ${flips}/${loo.length} single-card drops flip Δ to ≥0${flips ? ` (most influential: ${loo[0]!.name})` : ""}`);
  }
}
// pooled post slope + pooled G2 with tier fixed effects (the battery's headline frame)
{
  const dm = (rows: { p: number; o: number }[][]) => {
    const p: number[] = [], o: number[] = [];
    for (const rs of rows) { const mp = mean(rs.map((r) => r.p)), mo = mean(rs.map((r) => r.o)); for (const r of rs) { p.push(r.p - mp); o.push(r.o - mo); } }
    return { p, o };
  };
  const preRows = cells.map((c) => c.rows.map((r) => ({ p: r.pred, o: r.obs })));
  const postRows = cells.map((c) => c.rows.map((r) => { const pr = postPitByTier.get(c.tier)?.get(`${r.rec.title}|${r.rec.vlvl}`); return { p: pr?.ours.k9 ?? NaN, o: r.obs }; }).filter((x) => Number.isFinite(x.p)));
  const a = dm(preRows), b2 = dm(postRows);
  console.log(`\n  POOLED (tier fixed effects): K9 slope pre ${f(slopeOf(a.p, a.o), 2)} → post ${f(slopeOf(b2.p, b2.o), 2)}   (battery baseline was 1.73 [1.65,1.80])`);
  // pooled G2 — the aggregate ordering read (per-tier cells at N=15 are noise-fragile; the pooled
  // tier-de-meaned corr is the battery's own aggregation frame). Stratified paired bootstrap.
  const wRows = cells.map((c) => c.rows.map((r) => {
    const pr = postPitByTier.get(c.tier)!.get(`${r.rec.title}|${r.rec.vlvl}`)!;
    return { pre: r.rec.ours.woba!, post: pr.ours.woba!, obs: r.rec.obs.woba! };
  }));
  const dmW = (get: (r: { pre: number; post: number; obs: number }) => number, rows: typeof wRows) => {
    const p: number[] = [], o: number[] = [];
    for (const rs of rows) { const mp = mean(rs.map(get)), mo = mean(rs.map((r) => r.obs)); for (const r of rs) { p.push(get(r) - mp); o.push(r.obs - mo); } }
    return { p, o };
  };
  const cPre = (() => { const d = dmW((r) => r.pre, wRows); return pearson(d.p, d.o); })();
  const cPost = (() => { const d = dmW((r) => r.post, wRows); return pearson(d.p, d.o); })();
  const r4 = rng(SEED + 77);
  const dPool: number[] = [];
  for (let b = 0; b < B; b++) {
    const rs = wRows.map((rows) => rows.map(() => rows[Math.floor(r4() * rows.length)]!));
    const d1 = dmW((r) => r.pre, rs), d2 = dmW((r) => r.post, rs);
    dPool.push(pearson(d2.p, d2.o) - pearson(d1.p, d1.o));
  }
  const dpCI = ci(dPool.filter(Number.isFinite));
  const ok = cPost >= cPre || (dpCI.lo <= 0 && 0 <= dpCI.hi);
  console.log(`  POOLED G2 (tier-de-meaned wOBAA ordering): pre ${f(cPre, 4)} → post ${f(cPost, 4)}  (Δ ${sgn(cPost - cPre, 4)} [${sgn(dpCI.lo, 4)},${sgn(dpCI.hi, 4)}])   ${ok ? "PASS" : "FAIL"}`);
}

// ── ORACLE-s DIAGNOSTIC (characterization only — NEVER the shipping candidate) ──
// Re-run the sample with s pinned to each tier's own MEASURED slope (per-tier constants are
// mission-ILLEGAL to ship; this only separates "the ramp overshoots this tier" from "de-shrinking
// K inherently hurts this tier's composite ordering"). Read it only where G2 failed above.
{
  const ksOracle = new Map<string, KSpreadPit>(cells.map((c) => [c.tier, { s: c.m.slope.est, mean: c.kbar }]));
  const postO = buildCwhitSample({ ...deps, kSpreadPit: ksOracle });
  const oPitByTier = new Map<string, Map<string, Rec>>();
  for (const r of postO.recs) {
    if (r.role !== "pit") continue;
    (oPitByTier.get(r.tier) ?? oPitByTier.set(r.tier, new Map()).get(r.tier)!).set(`${r.title}|${r.vlvl}`, r);
  }
  console.log(`\n  ORACLE-s DIAGNOSTIC (s = each tier's measured slope; characterization only, per-tier constants are not shippable):`);
  let seedO = 40;
  for (const c of cells) {
    const g = gateRows(c.rows, oPitByTier.get(c.tier) ?? new Map(), c.m.slope.est, c.kbar, coeffs.era_k, `${c.tier}`, SEED + seedO++);
    console.log(`    ${c.tier.padEnd(8)} s=${f(g.s, 2)}: K9 slope → ${f(g.postSlope.slope.est, 2)} [${f(g.postCI.lo, 2)},${f(g.postCI.hi, 2)}]; wOBAA corr ${f(g.preCorr, 4)} → ${f(g.postCorr, 4)} (Δ ${sgn(g.postCorr - g.preCorr, 4)} [${sgn(g.dCorrCI.lo, 4)},${sgn(g.dCorrCI.hi, 4)}])`);
  }
}

// ═══ 5. WEIRD-ENV BATTERY — the three confirmed daily/cap formats ═════════════
console.log(`\n╔═══ 5. WEIRD-ENV BATTERY — daily/cap formats, DEPLOYED per-channel line (era/park applied) ═══╗`);
console.log(`  diamondcapdaily EXCLUDED (Derek 2026-07-16: no config for it; do not infer one).`);
console.log(`  Each format's gap + K̄_pool are computed from ITS OWN eligible pool (config value cap + eligibility rules)`);
console.log(`  — property-derived at scoring time, exactly as production would. Observed lines live in the format's env,`);
console.log(`  so the judged line is the DEPLOYED per-channel line (raw K ×era_k etc.), not the neutral raw line.`);

const DAILY = [
  { fmt: "earlygolddaily", tid: "early-gold", label: "Early Gold Daily — era-1920 / park-169, VAL≤89" },
  { fmt: "bronzeheartdaily", tid: "bronze-heart", label: "Bronze Heart Daily — era-1939 / park-191, VAL≤69, years 1930–89" },
  { fmt: "goldcapdaily", tid: "gold-cap", label: "Gold Cap Daily — era-2010 / park-156, VAL≤89, cap 1580" },
] as const;

for (const [di, D] of DAILY.entries()) {
  const t = tournaments.find((x) => x.id === D.tid);
  if (!t) { console.log(`\n  [${D.fmt}] tournament config '${D.tid}' NOT FOUND — skipped`); continue; }
  const era = eras.get(t.eraId), park = parks.get(t.parkId);
  if (!era || !park) { console.log(`\n  [${D.fmt}] era/park missing — skipped`); continue; }
  const coeffsF = resolveCoeffs(model, era, park, t.softcaps);
  applyWobaWeights(coeffsF, trained.wobaWeights!);
  const derivedF = computeDerived(coeffsF, true);
  const inV = (c: Card) => { const v = n_(c["Card Value"]); return (t.card_value_min == null || v >= t.card_value_min) && (t.card_value_max == null || v <= t.card_value_max); };
  const basePool = baseCards.filter((c) => inV(c) && rowEligible(c as any, t));
  const refF = computeUnifiedFieldStats(baseCards, coeffsF, rp, FIELD_N, true);
  const poolF = computeUnifiedFieldStats(basePool, coeffsF, rp, FIELD_N, true);
  const pt = buildPoolTransform(refF, poolF, deps.envelope);
  const gap = buildFrameShift(TM, poolF).pit.vR.stu ?? 0;
  const kbar = poolMeanKOwn(basePool, coeffsF, rp, pt, FIELD_N).pit;
  const s = sFull(gap);
  const ks: KSpreadPit = { s, mean: kbar };
  const depsF: SampleDeps = { ...deps, coeffs: coeffsF, derived: derivedF };
  const calPre = calibrate(basePool, { coeffs: coeffsF, derived: derivedF, eventForm: trained.eventForm!, poolTransform: pt });
  const calPost = calibrate(basePool, { coeffs: coeffsF, derived: derivedF, eventForm: trained.eventForm!, poolTransform: pt, kSpread: { sHit: 1, sPit: s, meanHit: 0, meanPit: kbar } });

  // our side: base + v5, pit only, format-eligible; fingerprint from the DEPLOYED line (env-matched).
  const cards: JoinCard[] = [];
  const byCid = new Map<string, { title: string; vlvl: number; pre: Record<string, number>; post: Record<string, number> }>();
  for (const bc of baseCards) {
    for (const [vlvl, c] of [[0, bc], [5, makeVariant(bc)]] as const) {
      if (!inV(c) || !rowEligible(c as any, t) || !isPit(c)) continue;
      const cid = `${bc["Card ID"]}|${vlvl}`;
      const pPre = ourPit(c, pt, depsF, calPre);
      const pPost = ourPit(c, pt, depsF, calPost, ks);
      cards.push({
        cid, name: cardName(c), val: n_(c["Card Value"]), vlvl, hand: handLetter(n_(c["Throws"])),
        primary: [Math.max(0, Math.min(1, (n_(c["Stamina"]) - 20) / 40)), pPre.dep.babip!],
        validate: [pPre.dep.k9!, pPre.dep.bb9!, pPre.dep.hr9!],
      });
      byCid.set(cid, { title: String(bc["//Card Title"]), vlvl, pre: pPre.dep, post: pPost.dep });
    }
  }
  const { rows: obsRows } = parseCwhitPit(readFileSync(`${OBS_DIR}/cwhit-${D.fmt}-pit.tsv`, "utf8"));
  const obs: JoinObs<typeof obsRows[0]>[] = obsRows.map((r) => ({ name: r.name, val: r.val, vlvl: r.vlvl, hand: r.hand, primary: [r.gsPer, r.babip], validate: [r.k9, r.bb9, r.hr9], sample: r.ip, row: r }));
  const j = joinCwhit(obs, cards);
  const paired = j.matched
    .filter((m) => m.obs.row.ip >= MIN_IP)
    .map((m) => {
      const our = byCid.get(m.card.cid)!, o = m.obs.row;
      return {
        pre: our.pre, post: our.post,
        obs: { k9: o.k9, bb9: o.bb9, hr9: o.hr9, babip: o.babip, woba: pitWobaFromChannels(o.k9, o.bb9, o.hr9, o.babip, W) },
        nv: k9Noise(o.k9, o.ip),
      };
    });
  console.log(`\n  ── ${D.label} ──`);
  console.log(`  pool ${basePool.length} cards | joined ${j.matched.length}/${obs.length} (unique ${j.stats.matchedUnique} + fp ${j.stats.matchedFingerprint}), well-sampled (IP≥${MIN_IP}) ${paired.length} | gap ${f(gap, 1)}  K̄_pool ${f(kbar, 1)}/600  s(gap) = ${f(s, 2)}  era_k ${f(coeffsF.era_k, 3)}`);
  if (paired.length < 8) { console.log(`  N too thin for a slope verdict — reporting nothing (never a number from noise)`); continue; }
  const preP = paired.map((r) => r.pre.k9!), postP = paired.map((r) => r.post.k9!), o9 = paired.map((r) => r.obs.k9), nv = paired.map((r) => r.nv);
  const preM = mmse(preP, o9, nv), postM = mmse(postP, o9, nv);
  const preW = paired.map((r) => pitWobaFromChannels(r.pre.k9!, r.pre.bb9!, r.pre.hr9!, r.pre.babip!, W));
  const postW = paired.map((r) => pitWobaFromChannels(r.post.k9!, r.post.bb9!, r.post.hr9!, r.post.babip!, W));
  const obsW = paired.map((r) => r.obs.woba);
  const r3 = rng(SEED + 100 + di);
  const preS: number[] = [], postS: number[] = [], dC: number[] = [];
  for (let b = 0; b < B; b++) {
    const idx = paired.map(() => Math.floor(r3() * paired.length));
    preS.push(slopeOf(idx.map((i) => preP[i]!), idx.map((i) => o9[i]!)));
    postS.push(slopeOf(idx.map((i) => postP[i]!), idx.map((i) => o9[i]!)));
    dC.push(pearson(idx.map((i) => postW[i]!), idx.map((i) => obsW[i]!)) - pearson(idx.map((i) => preW[i]!), idx.map((i) => obsW[i]!)));
  }
  const preCI = ci(preS.filter(Number.isFinite)), postCI = ci(postS.filter(Number.isFinite)), dCI = ci(dC.filter(Number.isFinite));
  const lvPre = meanEst(paired.map((r) => r.pre.k9! - r.obs.k9)), lvPost = meanEst(paired.map((r) => r.post.k9! - r.obs.k9));
  const g1 = postCI.lo <= 1 && 1 <= postCI.hi;
  const cPre = pearson(preW, obsW), cPost = pearson(postW, obsW);
  const g2 = cPost >= cPre || (dCI.lo <= 0 && 0 <= dCI.hi);
  console.log(`  K9 slope:   pre ${f(preM.slope.est, 2)} [${f(preCI.lo, 2)},${f(preCI.hi, 2)}]  →  post ${f(postM.slope.est, 2)} [${f(postCI.lo, 2)},${f(postCI.hi, 2)}]   ${g1 ? "PASS (post CI covers 1)" : postM.slope.est > preM.slope.est ? "worse-than-pre ✗" : "FAIL (CI excludes 1)"}`);
  console.log(`  wOBAA corr: pre ${f(cPre, 4)} → post ${f(cPost, 4)}  (Δ ${sgn(cPost - cPre, 4)} [${sgn(dCI.lo, 4)},${sgn(dCI.hi, 4)}])   ${g2 ? "PASS" : "FAIL"}   rank ρ ${f(spearman(preW, obsW), 4)} → ${f(spearman(postW, obsW), 4)}`);
  console.log(`  K9 level:   pre ${sgn(lvPre.est, 2)} [${sgn(lvPre.lo, 2)},${sgn(lvPre.hi, 2)}]  →  post ${sgn(lvPost.est, 2)} [${sgn(lvPost.lo, 2)},${sgn(lvPost.hi, 2)}]`);
  console.log(`  spread:     ratioRaw ${f(preM.ratioRaw, 2)} → ${f(postM.ratioRaw, 2)}   ratioDcv ${f(preM.ratioDeconv, 2)} → ${f(postM.ratioDeconv, 2)}   optRatio ${f(preM.optimalRatio, 2)}   corr(K9) ${f(preM.corrRaw, 3)}`);
}

// ═══ 6. SHIPPING CONSTANTS ════════════════════════════════════════════════════
console.log(`\n╔═══ 6. SHIPPING CANDIDATE (refit-with-all, pinned) — the constants production wiring would embed ═══╗`);
console.log(`  K_SPREAD_PIT = { A: ${f(ship.A, 4)}, G: ${f(ship.G, 1)} }`);
console.log(`  s(g) = 1 + ${f(ship.A, 4)}·(1 − e^(−g/${f(ship.G, 1)}));  s(g≤0) = 1 (league-anchored; never compress a stronger-than-training pool)`);
console.log(`  s at reference gaps: s(10)=${f(sFull(10), 2)}  s(20)=${f(sFull(20), 2)}  s(28)=${f(sFull(28), 2)}  s(35)=${f(sFull(35), 2)}  (observed tier gaps span ~19–28)`);
console.log(`  gap = buildFrameShift(trainingMeans, poolField).pit.vR.stu — computed from pool composition at scoring time; NO per-tournament constants.`);
console.log(`  K̄_pool = poolMeanKOwn(basePool, coeffs, model, poolTransform, ${FIELD_N}).pit — pre-era, own-gap frame.`);
console.log(``);
process.exit(0);
