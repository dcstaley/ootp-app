// BUILD-3 — PITCHER HR9 + BABIP SPREAD SCALARS: fit, held-out validation, weird-env battery, gates.
//   run: node tools/fit-pitspread-hrbab.ts
//
// EVIDENCE BASE (docs/CWHIT_MMSE_BATTERY_2026-07-16.md — recomputed here under salt, never
// inherited): pit HR9 calibration slope 1.24* [1.14,1.34] and pit BABIP 1.24* [1.11,1.40] pooled,
// FLAT-ish quartile bands ⇒ the scalar is the right instrument (the MMSE fork), combined value
// stake ~3.1 mwOBA/card. Independently corroborated: quicks pitcher HR obs/pred 0.84–0.91 and the
// C-grid HRR-quartile slope 1.22–1.29. pit BB9 is 0.99 — BB IS NOT TOUCHED.
//
// WHAT THIS IS: the BUILD-1 K-spread instrument generalized per channel, on the SAME seam —
//     HR_corr  = HR̄_pool  + s_hr(g_hr)·(HR_pred − HR̄_pool)          (raw pre-era HR/600)
//     BAB_corr = BAB̄_pool + s_bab(g_bab)·(BAB_pred − BAB̄_pool)      (raw BABIP; rides e.hMul)
//     s_ch(g) = 1 + A_ch·(1 − e^(−g/G_ch)),  s(0) = 1 hard (league-anchored: in-frame HR/BABIP
//     are calibrated per insample-frame-check) — separate A per channel; G expected only
//     LOWER-BOUNDED exactly like the K ramp (tiers span a narrow gap range).
// Gap conventions (per-channel own-gap crossings, the §10.2 frame machinery):
//     g_hr  = buildFrameShift(trainingMeans, poolField).pit.vR.hrr     (opposing-hitter POW gap)
//     g_bab = buildFrameShift(trainingMeans, poolField).pit.vR.pbabip  (opposing-hitter BABIP gap)
// Pool means: poolPitMeansOwn (top-50 field, OWN-GAP ratings, pre-era — the K̄ convention).
// BASELINE = the SHIPPED scoring path: the BUILD-1 K-spread ramp ACTIVE at every step (pre and
// post both carry it), so the fit measures the residual defect of production, not of a stale line.
// Application = applyPitSpread (src/model/pool-transform.ts) — the ONE copy production would wire.
//
// STEPS: (1) per-tier HR9/BABIP calibration slopes on the cwhit Quick tiers (buildCwhitSample —
// the scorecard's exact path), ramps fit precision-weighted with the BUILD-1 pin rule;
// (2) held-out: fit without bronze, predict bronze, per channel; (3) two-axis gate;
// (4) weird-env battery on the three confirmed daily/cap formats (+ the HR/BABIP era-residual
// check — FLAGGED factor-conditioned per plan §15.7 if present, never fit here).
// Pre-registered gates — never tuned past a failure:
//   G1 post-fix per-tier HR9 AND BABIP slopes ≈ 1 within CI;  G2 composite wOBAA ordering corr
//   MUST NOT DROP (CI-clear);  G3 levels ~unchanged (centered scalars; algebraic expectation
//   printed);  G4 spread ratios → the deconvolved optimum;  plus hitter bit-identity and
//   K9 bit-identity (the K leg is carried unchanged from BUILD-1).

import { readFileSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import {
  makeRawPolyModel, computeUnifiedFieldStats, applyWobaWeights, computeDerived, calibrate,
  buildPoolTransform, buildFrameShift, poolMeanKOwn, poolPitMeansOwn, kSpreadPitRamp,
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

// ── deployed model + neutral env (IDENTICAL setup to tools/fit-kspread-pit.ts) ──
const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state = (await repo.load<{ activeModelId?: string; catalogSourceId?: string }>("state", "app")) ?? {};
type TM_ = { id: string; eventForm?: EventForm; wobaWeights?: WobaWeights; ratingEnvelope?: RatingEnvelope; trainingMeans?: TrainingMeans; platoon?: { pit: { hand: string; vsRHB: number; vsLHB: number }[]; hit: { hand: string; vsRHP: number; vsLHP: number }[] } };
const trained = (await repo.loadAll<TM_>("trained-models")).find((x) => x.id === state.activeModelId);
if (!trained?.eventForm || !trained.wobaWeights || !trained.platoon) throw new Error("active model missing eventForm/wobaWeights/platoon");
if (!trained.trainingMeans) throw new Error("active model has NO trainingMeans — the gap convention needs the artifact frame");
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

// per-card observed sampling variances (the mmse-tool noise model, copied — tools can't import tools)
const hrNoise = (hr9: number, ip: number) => per9NoiseVar(hr9, ip);
const babNoise = (o: { k9: number; bb9: number; hr9: number; babip: number }, ip: number) => {
  const bf = ip * 4.3;
  const bip = Math.max(bf - (o.k9 + o.bb9 + o.hr9) / BF_PER_9 * bf - 0.009 * bf, 1);
  return babipNoiseVar(o.babip, bip);
};

// ── bootstrap plumbing (seeded/deterministic — the battery's generator) ──
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
const B = 2000, SEED = 20260717;

// ── ramp + weighted fit (closed-form A per G, grid G) + the BUILD-1 pin rule ──
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
function linLimit(pts: FitPt[]): { beta: number; sse: number } {
  let num = 0, den = 0;
  for (const p of pts) { num += p.w * p.g * (p.m - 1); den += p.w * p.g * p.g; }
  const beta = den > 0 ? num / den : 0;
  return { beta, sse: pts.reduce((a, p) => a + p.w * (1 + beta * p.g - p.m) ** 2, 0) };
}
// THE BUILD-3 PIN RULE (differs from BUILD-1's, because the GEOMETRY differs — documented here,
// chosen by rule not by eye): the measured tier slopes for BOTH channels are NOT monotone in gap
// (unlike K's 1.90→1.43), so the data identify only the average out-of-frame amplification over
// the observed gap range; G is unidentified BELOW the range (no near-frame pools exist in the
// sample) and only weakly bounded above. BUILD-1's "most-saturating within 5% of the linear
// limit" rule, applied to a flat profile, degenerates to G ≈ 0 — a step at the league anchor
// that would hand a nearly-in-frame pool (g = 2) the full amplification, exactly the unsupported
// extrapolation the pin rules exist to prevent. The BUILD-3 pin keeps the same conservatism
// principle aimed at where THIS geometry's unobserved region is:
//     G = g_min / 3  (95% saturation AT the lowest observed tier gap),  A = closed-form at that G
// ⇒ the ramp matches every measured point (flat regime), rises continuously from the exact
// league anchor, and never amplifies MORE below the first measured point than is measured there.
function pinShip(pts: FitPt[]): { A: number; G: number } {
  const G = Math.min(...pts.map((p) => p.g)) / 3;
  let num = 0, den = 0;
  for (const p of pts) { const u = 1 - Math.exp(-p.g / G); num += p.w * u * (p.m - 1); den += p.w * u * u; }
  return { A: den > 0 ? num / den : 0, G };
}

// ═════════════════════════════════════════════════════════════════════════════
console.log(`\n╔══════════════════════════════════════════════════════════════════════════════════════════════╗`);
console.log(`║  BUILD-3: PITCHER HR9 + BABIP SPREAD SCALARS — fit · held-out · two-axis gate · weird-env      ║`);
console.log(`╚══════════════════════════════════════════════════════════════════════════════════════════════╝`);
console.log(`model '${trained.id}' | catalog '${srcId}' | eval frame = RAW event line, own-gap ON, no anchor`);
console.log(`BASELINE INCLUDES the shipped BUILD-1 K-spread ramp (production reality; pre AND post carry it).`);
console.log(`gaps: pit.vR.hrr (HR) and pit.vR.pbabip (BABIP) from buildFrameShift(trainingMeans, poolField)`);
console.log(`means: poolPitMeansOwn (top-${FIELD_N} field, OWN-GAP ratings, pre-era) | application: applyPitSpread (one copy)`);

// ═══ 1. PER-TIER MEASUREMENT (pre-fix = K-ramp-only production line) ═════════
interface TierCell {
  tier: string; gapStu: number; gapHr: number; gapBab: number;
  kbar: number; hrbar: number; babbar: number;
  rows: { predHr: number; obsHr: number; nvHr: number; predBab: number; obsBab: number; nvBab: number; rec: Rec }[];
  mHr: Mmse; mBab: Mmse;
}
const ksBase = new Map<string, KSpreadPit>();
const tierGeom = new Map<string, { gapStu: number; gapHr: number; gapBab: number; kbar: number; hrbar: number; babbar: number }>();
for (const { tier, cap } of QUICK) {
  const basePool = deps.baseCards.filter((c) => n_(c["Card Value"]) <= cap);
  const poolField = computeUnifiedFieldStats(basePool, coeffs, rp, FIELD_N, true);
  const shift = buildFrameShift(TM, poolField);
  const pt = buildPoolTransform(ref, poolField, deps.envelope);
  const kbar = poolMeanKOwn(basePool, coeffs, rp, pt, FIELD_N).pit;
  const pm = poolPitMeansOwn(basePool, coeffs, rp, pt, FIELD_N);
  tierGeom.set(tier, { gapStu: shift.pit.vR.stu ?? 0, gapHr: shift.pit.vR.hrr ?? 0, gapBab: shift.pit.vR.pbabip ?? 0, kbar, hrbar: pm.hr, babbar: pm.bab });
  ksBase.set(tier, { s: kSpreadPitRamp(shift.pit.vR.stu ?? 0), mean: kbar });
}
const pre = buildCwhitSample({ ...deps, kSpreadPit: ksBase });
const cells: TierCell[] = [];
for (const { tier } of QUICK) {
  const g = tierGeom.get(tier)!;
  const rows = pre.recs
    .filter((r) => r.tier === tier && r.role === "pit" && wellSampled(r)
      && Number.isFinite(r.ours.hr9) && Number.isFinite(r.obs.hr9)
      && Number.isFinite(r.ours.babip) && Number.isFinite(r.obs.babip)
      && Number.isFinite(r.ours.k9) && Number.isFinite(r.ours.woba) && Number.isFinite(r.obs.woba))
    .map((r) => ({
      predHr: r.ours.hr9!, obsHr: r.obs.hr9!, nvHr: hrNoise(r.obs.hr9!, r.sample),
      predBab: r.ours.babip!, obsBab: r.obs.babip!, nvBab: babNoise(r.obs as { k9: number; bb9: number; hr9: number; babip: number }, r.sample),
      rec: r,
    }));
  if (rows.length < 5) { console.log(`\n[${tier}] N=${rows.length} < 5 — excluded from the fit entirely (diamond pit is the known dead cell)`); continue; }
  cells.push({
    tier, gapStu: g.gapStu, gapHr: g.gapHr, gapBab: g.gapBab, kbar: g.kbar, hrbar: g.hrbar, babbar: g.babbar, rows,
    mHr: mmse(rows.map((r) => r.predHr), rows.map((r) => r.obsHr), rows.map((r) => r.nvHr)),
    mBab: mmse(rows.map((r) => r.predBab), rows.map((r) => r.obsBab), rows.map((r) => r.nvBab)),
  });
}

// per-tier bootstrap slopes, both channels, one pass (reused for tier CIs + ramp-fit CIs)
const rnd = rng(SEED);
const bootHr: number[][] = cells.map(() => []);
const bootBab: number[][] = cells.map(() => []);
for (let b = 0; b < B; b++) {
  cells.forEach((c, i) => {
    const rs = c.rows.map(() => c.rows[Math.floor(rnd() * c.rows.length)]!);
    bootHr[i]!.push(slopeOf(rs.map((r) => r.predHr), rs.map((r) => r.obsHr)));
    bootBab[i]!.push(slopeOf(rs.map((r) => r.predBab), rs.map((r) => r.obsBab)));
  });
}

console.log(`\n╔═══ 1. PER-TIER MEASUREMENT — calibration slopes (obs~pred) on the K-ramp production line ═══╗`);
console.log(`tier      N    g_hr    g_bab   HR̄/600  BAB̄     HR9 slope [boot CI]  corr  rDcv/opt | BABIP slope [boot CI]  corr  rDcv/opt`);
for (let i = 0; i < cells.length; i++) {
  const c = cells[i]!, bh = ci(bootHr[i]!.filter(Number.isFinite)), bb = ci(bootBab[i]!.filter(Number.isFinite));
  console.log(`${c.tier.padEnd(8)} ${String(c.rows.length).padStart(3)}  ${f(c.gapHr, 1).padStart(6)}  ${f(c.gapBab, 1).padStart(6)}  ${f(c.hrbar, 1).padStart(6)}  ${f(c.babbar, 3)}   ${f(c.mHr.slope.est, 2).padStart(5)} [${f(bh.lo, 2)},${f(bh.hi, 2)}]   ${f(c.mHr.corrRaw, 3)}  ${f(c.mHr.ratioDeconv, 2)}/${f(c.mHr.optimalRatio, 2)} |  ${f(c.mBab.slope.est, 2).padStart(5)} [${f(bb.lo, 2)},${f(bb.hi, 2)}]   ${f(c.mBab.corrRaw, 3)}  ${f(c.mBab.ratioDeconv, 2)}/${f(c.mBab.optimalRatio, 2)}`);
}
// pooled recompute (tier fixed effects) — the salt check against the MMSE battery's 1.24/1.24
{
  const dm = (get: (r: TierCell["rows"][0]) => { p: number; o: number }) => {
    const p: number[] = [], o: number[] = [];
    for (const c of cells) { const vs = c.rows.map(get); const mp = mean(vs.map((v) => v.p)), mo = mean(vs.map((v) => v.o)); for (const v of vs) { p.push(v.p - mp); o.push(v.o - mo); } }
    return slopeOf(p, o);
  };
  console.log(`POOLED (tier fixed effects): HR9 ${f(dm((r) => ({ p: r.predHr, o: r.obsHr })), 2)} (battery said 1.24 [1.14,1.34])   BABIP ${f(dm((r) => ({ p: r.predBab, o: r.obsBab })), 2)} (battery said 1.24 [1.11,1.40])`);
}

// ═══ 2. THE FITS — per channel, precision-weighted, BUILD-1 pin rule ══════════
interface ChanFit { name: "hr" | "bab"; pts: FitPt[]; ship: { A: number; G: number }; sFn: (g: number) => number; lim: { beta: number; sse: number }; full: ReturnType<typeof fitRamp>; gBand: { lo: number; hi: number }; aCI: { lo: number; hi: number }; gCI: { lo: number; hi: number }; bootSAt: Record<string, number[]>; bootPredBronze: number[] }
function fitChannel(name: "hr" | "bab"): ChanFit {
  const gapOf = (c: TierCell) => (name === "hr" ? c.gapHr : c.gapBab);
  const slopes = name === "hr" ? bootHr : bootBab;
  const pts: FitPt[] = cells.map((c) => ({ g: gapOf(c), m: (name === "hr" ? c.mHr : c.mBab).slope.est, w: 1 / (name === "hr" ? c.mHr : c.mBab).slope.se ** 2 }));
  const full = fitRamp(pts);
  const lim = linLimit(pts);
  const band = full.profile.filter((p) => p.sse <= Math.min(full.sse, lim.sse) * 1.05);
  const ship = pinShip(pts);
  const bootA: number[] = [], bootG: number[] = [], bootSAt: Record<string, number[]> = {}, bootPredBronze: number[] = [];
  const heldIdx = cells.map((c, i) => ({ c, i })).filter((x) => x.c.tier !== "bronze");
  const bronzeCell = cells.find((c) => c.tier === "bronze");
  for (let b = 0; b < B; b++) {
    const reps = cells.map((c, i) => ({ g: gapOf(c), m: slopes[i]![b]!, w: pts[i]!.w }));
    if (reps.some((r) => !Number.isFinite(r.m))) continue;
    const pb = pinShip(reps); // same rule per replicate ⇒ CIs are CIs of the shipping quantity
    bootA.push(pb.A); bootG.push(pb.G);
    for (const c of cells) (bootSAt[c.tier] ??= []).push(sOf(pb.A, pb.G)(gapOf(c)));
    if (bronzeCell) {
      const hReps = heldIdx.map(({ c, i }) => ({ g: gapOf(c), m: slopes[i]![b]!, w: pts[i]!.w }));
      const ph = pinShip(hReps);
      bootPredBronze.push(sOf(ph.A, ph.G)(gapOf(bronzeCell)));
    }
  }
  return {
    name, pts, ship, sFn: sOf(ship.A, ship.G), lim, full,
    gBand: { lo: band.length ? Math.min(...band.map((p) => p.G)) : NaN, hi: band.length ? Math.max(...band.map((p) => p.G)) : NaN },
    aCI: ci(bootA), gCI: ci(bootG), bootSAt, bootPredBronze,
  };
}
const fits = { hr: fitChannel("hr"), bab: fitChannel("bab") };

console.log(`\n╔═══ 2. FITTED RAMPS (per channel; s(0)=1 hard — the league anchor) ═══╗`);
for (const fc of [fits.hr, fits.bab]) {
  const lbl = fc.name === "hr" ? "HR9 " : "BABIP";
  console.log(`  ── ${lbl}: s(g) = 1 + A·(1 − e^(−g/G)) ──`);
  console.log(`  wide-grid optimum A=${f(fc.full.A, 3)} G=${f(fc.full.G, 1)} (SSE ${f(fc.full.sse, 2)});  LINEAR LIMIT: s = 1 + ${f(fc.lim.beta, 4)}·g (SSE ${f(fc.lim.sse, 2)})`);
  console.log(`  G equivalence band (≤ 1.05× best SSE): [${f(fc.gBand.lo, 1)}, ${f(fc.gBand.hi, 1)}${fc.gBand.hi >= 399 ? "+" : ""}] — ${fc.full.sse < fc.lim.sse * 0.75 ? "saturating DECISIVELY beats linear ⇒ slopes are gap-FLAT over the observed range (NOT the K geometry)" : "profile ~flat in G (weak identification)"}`);
  console.log(`  SHIPPING PIN (BUILD-3 rule: G = g_min/3, 95% saturation at the lowest observed gap; A closed-form):`);
  console.log(`    A = ${f(fc.ship.A, 4)} [boot ${f(fc.aCI.lo, 3)}, ${f(fc.aCI.hi, 3)}]   G = ${f(fc.ship.G, 1)} (by rule)   plateau s(∞) = ${f(1 + fc.ship.A, 2)}`);
  for (const c of cells) {
    const g = fc.name === "hr" ? c.gapHr : c.gapBab;
    const m = (fc.name === "hr" ? c.mHr : c.mBab).slope.est;
    const sci = ci(fc.bootSAt[c.tier] ?? []);
    console.log(`    ${c.tier.padEnd(8)} g=${f(g, 1).padStart(5)}  s(g)=${f(fc.sFn(g), 2)} [${f(sci.lo, 2)},${f(sci.hi, 2)}]   measured ${f(m, 2)}   resid ${sgn(fc.sFn(g) - m, 2)}`);
  }
}

// ═══ 3. HELD-OUT VALIDATION — fit without bronze, predict bronze, per channel ══
console.log(`\n╔═══ 3. HELD-OUT VALIDATION — fit WITHOUT bronze, predict bronze ═══╗`);
const bronzeCell = cells.find((c) => c.tier === "bronze");
let heldOutPass = true;
if (bronzeCell) {
  for (const fc of [fits.hr, fits.bab]) {
    const gapOf = (c: TierCell) => (fc.name === "hr" ? c.gapHr : c.gapBab);
    const hPts = cells.filter((c) => c.tier !== "bronze").map((c) => ({ g: gapOf(c), m: (fc.name === "hr" ? c.mHr : c.mBab).slope.est, w: 1 / (fc.name === "hr" ? c.mHr : c.mBab).slope.se ** 2 }));
    const held = pinShip(hPts);
    const predB = sOf(held.A, held.G)(gapOf(bronzeCell));
    const pCI = ci(fc.bootPredBronze);
    const bIdx = cells.indexOf(bronzeCell);
    const mCI = ci((fc.name === "hr" ? bootHr : bootBab)[bIdx]!.filter(Number.isFinite));
    const overlap = pCI.lo <= mCI.hi && mCI.lo <= pCI.hi;
    heldOutPass &&= overlap;
    console.log(`  ${fc.name === "hr" ? "HR9  " : "BABIP"}: predicted bronze ${f(predB, 2)} [${f(pCI.lo, 2)},${f(pCI.hi, 2)}]  vs measured ${f(bronzeCell === undefined ? NaN : (fc.name === "hr" ? bronzeCell.mHr : bronzeCell.mBab).slope.est, 2)} [${f(mCI.lo, 2)},${f(mCI.hi, 2)}]   ${overlap ? "PASS" : "FAIL"}`);
  }
} else console.log(`  bronze cell unavailable — held-out step skipped`);

// ═══ 4. TWO-AXIS GATE — post = K ramp + fitted HR/BAB scalars ═════════════════
const ksPost = new Map<string, KSpreadPit>();
for (const c of cells) {
  const base = ksBase.get(c.tier)!;
  ksPost.set(c.tier, { ...base, sHr: fits.hr.sFn(c.gapHr), meanHr: c.hrbar, sBab: fits.bab.sFn(c.gapBab), meanBab: c.babbar });
}
const post = buildCwhitSample({ ...deps, kSpreadPit: ksPost });

// hitter bit-identity + K9 bit-identity (the HR/BAB legs must not leak anywhere else)
{
  const key = (r: Rec) => `${r.tier}|${r.title}|${r.vlvl}`;
  const preHit = new Map(pre.recs.filter((r) => r.role === "hit").map((r) => [key(r), r]));
  let maxD = 0, nH = 0;
  for (const r of post.recs.filter((x) => x.role === "hit")) {
    const p0 = preHit.get(key(r)); if (!p0) continue;
    nH++;
    for (const k of Object.keys(r.ours)) maxD = Math.max(maxD, Math.abs((r.ours[k] ?? 0) - (p0.ours[k] ?? 0)), Math.abs((r.oursDep[k] ?? 0) - (p0.oursDep[k] ?? 0)));
  }
  console.log(`\n  HITTER IDENTITY: ${nH} hitter recs pre↔post, max |Δ| = ${maxD === 0 ? "0 (bit-identical ✓)" : `${maxD} ✗ LEAKED`}`);
  if (maxD !== 0) throw new Error("pitcher HR/BAB spread leaked into hitter lines");
  // K9 identity — checked STRUCTURALLY per card (join-free: the rec-level pairing is confounded
  // by fingerprint reassignment, since the corrected babip sits in the join's primary fingerprint).
  const idCal = {
    hitBBScaleVR: 1, hitBBScaleVL: 1, hitHRScaleVR: 1, hitHRScaleVL: 1, hitScaleVR: 1, hitScaleVL: 1,
    pBBScaleVR: 1, pBBScaleVL: 1, pHRScaleVR: 1, pHRScaleVL: 1, pitchScaleVR: 1, pitchScaleVL: 1,
    ssp_adv_hitting: 1, ssp_basic_pitching: 1,
  } as Parameters<typeof ourPit>[3];
  {
    const c0 = cells.find((c) => c.tier === "bronze") ?? cells[0]!;
    const cap = QUICK.find((q) => q.tier === c0.tier)!.cap;
    const basePool = deps.baseCards.filter((c) => n_(c["Card Value"]) <= cap);
    const pt = buildPoolTransform(ref, computeUnifiedFieldStats(basePool, coeffs, rp, FIELD_N, true), deps.envelope);
    const pits = basePool.filter((c) => isPit(c)).slice(0, 60);
    let maxK = 0;
    for (const c of pits) {
      const a = ourPit(c, pt, deps, idCal, ksBase.get(c0.tier)!);
      const b = ourPit(c, pt, deps, idCal, ksPost.get(c0.tier)!);
      maxK = Math.max(maxK, Math.abs(a.raw.k9! - b.raw.k9!));
    }
    console.log(`  K9 IDENTITY:     ${pits.length} ${c0.tier} pool cards, same card ± HR/BAB legs: max |Δ k9| = ${maxK === 0 ? "0 (bit-identical ✓ — the K leg is untouched by construction)" : `${maxK} ✗ THE HR/BAB LEGS MOVED K`}`);
    if (maxK !== 0) throw new Error("HR/BAB spread moved the K channel");
  }
}

interface Gate2 {
  label: string; n: number; sHr: number; sBab: number;
  hrPre: Mmse; hrPost: Mmse; hrCI: { lo: number; hi: number };
  babPre: Mmse; babPost: Mmse; babCI: { lo: number; hi: number };
  preCorr: number; postCorr: number; dCorrCI: { lo: number; hi: number };
  preRho: number; postRho: number;
  hrLvPre: Est; hrLvPost: Est; hrLvExp: number; babLvPre: Est; babLvPost: Est; babLvExp: number;
}
function gateTier(c: TierCell, postBy: Map<string, Rec>, sHr: number, sBab: number, eraHr: number, label: string, seed: number): Gate2 {
  const key = (r: Rec) => `${r.title}|${r.vlvl}`;
  const paired = c.rows.map((r) => ({ ...r, post: postBy.get(key(r.rec))! })).filter((r) => r.post);
  const oHr = paired.map((r) => r.obsHr), oBab = paired.map((r) => r.obsBab);
  const preHrP = paired.map((r) => r.predHr), postHrP = paired.map((r) => r.post.ours.hr9!);
  const preBabP = paired.map((r) => r.predBab), postBabP = paired.map((r) => r.post.ours.babip!);
  const preW = paired.map((r) => r.rec.ours.woba!), postW = paired.map((r) => r.post.ours.woba!), obsW = paired.map((r) => r.rec.obs.woba!);
  const r2 = rng(seed);
  const hrS: number[] = [], babS: number[] = [], dC: number[] = [];
  for (let b = 0; b < B; b++) {
    const idx = paired.map(() => Math.floor(r2() * paired.length));
    hrS.push(slopeOf(idx.map((i) => postHrP[i]!), idx.map((i) => oHr[i]!)));
    babS.push(slopeOf(idx.map((i) => postBabP[i]!), idx.map((i) => oBab[i]!)));
    dC.push(pearson(idx.map((i) => postW[i]!), idx.map((i) => obsW[i]!)) - pearson(idx.map((i) => preW[i]!), idx.map((i) => obsW[i]!)));
  }
  return {
    label, n: paired.length, sHr, sBab,
    hrPre: mmse(preHrP, oHr, paired.map((r) => r.nvHr)), hrPost: mmse(postHrP, oHr, paired.map((r) => r.nvHr)), hrCI: ci(hrS.filter(Number.isFinite)),
    babPre: mmse(preBabP, oBab, paired.map((r) => r.nvBab)), babPost: mmse(postBabP, oBab, paired.map((r) => r.nvBab)), babCI: ci(babS.filter(Number.isFinite)),
    preCorr: pearson(preW, obsW), postCorr: pearson(postW, obsW), dCorrCI: ci(dC.filter(Number.isFinite)),
    preRho: spearman(preW, obsW), postRho: spearman(postW, obsW),
    hrLvPre: meanEst(paired.map((r) => r.predHr - r.obsHr)), hrLvPost: meanEst(paired.map((r) => r.post.ours.hr9! - r.obsHr)),
    hrLvExp: (sHr - 1) * (mean(preHrP) - c.hrbar * eraHr * (BF_PER_9 / 600)),
    babLvPre: meanEst(paired.map((r) => r.predBab - r.obsBab)), babLvPost: meanEst(paired.map((r) => r.post.ours.babip! - r.obsBab)),
    babLvExp: (sBab - 1) * (mean(preBabP) - c.babbar),
  };
}
function printGate2(g: Gate2): { g1hr: boolean; g1bab: boolean; g2: boolean } {
  const g1hr = g.hrCI.lo <= 1 && 1 <= g.hrCI.hi;
  const g1bab = g.babCI.lo <= 1 && 1 <= g.babCI.hi;
  const g2 = g.postCorr >= g.preCorr || (g.dCorrCI.lo <= 0 && 0 <= g.dCorrCI.hi);
  console.log(`\n  ── ${g.label}  (N=${g.n}, s_hr=${f(g.sHr, 2)}, s_bab=${f(g.sBab, 2)}) ──`);
  console.log(`  G1 HR9 slope:   pre ${f(g.hrPre.slope.est, 2)} → post ${f(g.hrPost.slope.est, 2)} [${f(g.hrCI.lo, 2)},${f(g.hrCI.hi, 2)}]   ${g1hr ? "PASS" : "FAIL (CI excludes 1)"}`);
  console.log(`  G1 BABIP slope: pre ${f(g.babPre.slope.est, 2)} → post ${f(g.babPost.slope.est, 2)} [${f(g.babCI.lo, 2)},${f(g.babCI.hi, 2)}]   ${g1bab ? "PASS" : "FAIL (CI excludes 1)"}`);
  console.log(`  G2 wOBAA corr:  pre ${f(g.preCorr, 4)} → post ${f(g.postCorr, 4)}  (Δ ${sgn(g.postCorr - g.preCorr, 4)} [${sgn(g.dCorrCI.lo, 4)},${sgn(g.dCorrCI.hi, 4)}])  ρ ${f(g.preRho, 4)} → ${f(g.postRho, 4)}   ${g2 ? "PASS" : "FAIL (CI-clear drop)"}`);
  console.log(`  G3 HR9 level:   ${sgn(g.hrLvPre.est, 2)} → ${sgn(g.hrLvPost.est, 2)} [${sgn(g.hrLvPost.lo, 2)},${sgn(g.hrLvPost.hi, 2)}]  (algebraic exp ${sgn(g.hrLvExp, 2)});  BABIP level: ${sgn(g.babLvPre.est, 3)} → ${sgn(g.babLvPost.est, 3)} [${sgn(g.babLvPost.lo, 3)},${sgn(g.babLvPost.hi, 3)}]  (exp ${sgn(g.babLvExp, 3)})`);
  console.log(`  G4 spread:      HR9 ratioDcv ${f(g.hrPre.ratioDeconv, 2)} → ${f(g.hrPost.ratioDeconv, 2)} (opt ${f(g.hrPre.optimalRatio, 2)});  BABIP ${f(g.babPre.ratioDeconv, 2)} → ${f(g.babPost.ratioDeconv, 2)} (opt ${f(g.babPre.optimalRatio, 2)})`);
  return { g1hr, g1bab, g2 };
}

console.log(`\n╔═══ 4. TWO-AXIS GATE — Quick tiers, post-fix (shipping candidate = all-tier fits) ═══╗`);
const postPitByTier = new Map<string, Map<string, Rec>>();
for (const r of post.recs) {
  if (r.role !== "pit") continue;
  (postPitByTier.get(r.tier) ?? postPitByTier.set(r.tier, new Map()).get(r.tier)!).set(`${r.title}|${r.vlvl}`, r);
}
const gateResults: { tier: string; g1hr: boolean; g1bab: boolean; g2: boolean; g: Gate2 }[] = [];
let seedStep = 1;
for (const c of cells) {
  const g = gateTier(c, postPitByTier.get(c.tier) ?? new Map(), fits.hr.sFn(c.gapHr), fits.bab.sFn(c.gapBab), derived.era_effective_hr, `${c.tier} (quick)`, SEED + seedStep++);
  const v = printGate2(g);
  gateResults.push({ tier: c.tier, ...v, g });
  if (!v.g2) {
    // LOO influence read for a CI-clear G2 failure (characterization, never tuning)
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
    console.log(`  LOO influence:  Δcorr LOO range [${sgn(loo[loo.length - 1]!.d, 4)}, ${sgn(loo[0]!.d, 4)}]; ${flips}/${loo.length} single drops flip Δ ≥ 0${flips ? ` (most influential: ${loo[0]!.name})` : ""}`);
  }
}
// pooled reads (tier fixed effects)
{
  const dm = (get: (r: { pre: number; post: number; obs: number }) => number, rows: { pre: number; post: number; obs: number }[][]) => {
    const p: number[] = [], o: number[] = [];
    for (const rs of rows) { const mp = mean(rs.map(get)), mo = mean(rs.map((r) => r.obs)); for (const r of rs) { p.push(get(r) - mp); o.push(r.obs - mo); } }
    return { p, o };
  };
  const mk = (predKey: "hr9" | "babip", preKey: "predHr" | "predBab", obsKey: "obsHr" | "obsBab") => cells.map((c) => c.rows.map((r) => {
    const pr = postPitByTier.get(c.tier)!.get(`${r.rec.title}|${r.rec.vlvl}`)!;
    return { pre: r[preKey], post: pr.ours[predKey]!, obs: r[obsKey] };
  }));
  const hrRows = mk("hr9", "predHr", "obsHr"), babRows = mk("babip", "predBab", "obsBab");
  const preHr = dm((r) => r.pre, hrRows), postHr = dm((r) => r.post, hrRows);
  const preBab = dm((r) => r.pre, babRows), postBab = dm((r) => r.post, babRows);
  console.log(`\n  POOLED (tier fixed effects): HR9 slope ${f(slopeOf(preHr.p, preHr.o), 2)} → ${f(slopeOf(postHr.p, postHr.o), 2)};  BABIP ${f(slopeOf(preBab.p, preBab.o), 2)} → ${f(slopeOf(postBab.p, postBab.o), 2)}`);
  const wRows = cells.map((c) => c.rows.map((r) => {
    const pr = postPitByTier.get(c.tier)!.get(`${r.rec.title}|${r.rec.vlvl}`)!;
    return { pre: r.rec.ours.woba!, post: pr.ours.woba!, obs: r.rec.obs.woba! };
  }));
  const c1 = (() => { const d = dm((r) => r.pre, wRows); return pearson(d.p, d.o); })();
  const c2 = (() => { const d = dm((r) => r.post, wRows); return pearson(d.p, d.o); })();
  const r4 = rng(SEED + 77);
  const dPool: number[] = [];
  for (let b = 0; b < B; b++) {
    const rs = wRows.map((rows) => rows.map(() => rows[Math.floor(r4() * rows.length)]!));
    const d1 = dm((r) => r.pre, rs), d2 = dm((r) => r.post, rs);
    dPool.push(pearson(d2.p, d2.o) - pearson(d1.p, d1.o));
  }
  const dpCI = ci(dPool.filter(Number.isFinite));
  const ok = c2 >= c1 || (dpCI.lo <= 0 && 0 <= dpCI.hi);
  console.log(`  POOLED G2 (tier-de-meaned wOBAA ordering): pre ${f(c1, 4)} → post ${f(c2, 4)}  (Δ ${sgn(c2 - c1, 4)} [${sgn(dpCI.lo, 4)},${sgn(dpCI.hi, 4)}])   ${ok ? "PASS" : "FAIL"}`);
}

// ═══ 4b. HR-ONLY CANDIDATE — gated in its own right ═══════════════════════════
// If the BABIP leg fails its per-tier gate (bronze is the risk cell), the shipping candidate
// becomes HR-only — which must then be certified on ITS OWN composite numbers (G2 was measured
// with both legs above; the HR channel itself is bab-invariant but wOBAA is not).
console.log(`\n╔═══ 4b. HR-ONLY CANDIDATE (s_bab pinned 1) — its own gate record ═══╗`);
{
  const ksHrOnly = new Map<string, KSpreadPit>();
  for (const c of cells) {
    const base = ksBase.get(c.tier)!;
    ksHrOnly.set(c.tier, { ...base, sHr: fits.hr.sFn(c.gapHr), meanHr: c.hrbar });
  }
  const postH = buildCwhitSample({ ...deps, kSpreadPit: ksHrOnly });
  const byTier = new Map<string, Map<string, Rec>>();
  for (const r of postH.recs) {
    if (r.role !== "pit") continue;
    (byTier.get(r.tier) ?? byTier.set(r.tier, new Map()).get(r.tier)!).set(`${r.title}|${r.vlvl}`, r);
  }
  let seedH = 60;
  for (const c of cells) {
    const g = gateTier(c, byTier.get(c.tier) ?? new Map(), fits.hr.sFn(c.gapHr), 1, derived.era_effective_hr, `${c.tier} (quick, HR-only)`, SEED + seedH++);
    const g1hr = g.hrCI.lo <= 1 && 1 <= g.hrCI.hi;
    const g2 = g.postCorr >= g.preCorr || (g.dCorrCI.lo <= 0 && 0 <= g.dCorrCI.hi);
    console.log(`  ${c.tier.padEnd(8)} G1 HR9 ${f(g.hrPre.slope.est, 2)} → ${f(g.hrPost.slope.est, 2)} [${f(g.hrCI.lo, 2)},${f(g.hrCI.hi, 2)}] ${g1hr ? "PASS" : "FAIL"};  BABIP untouched ${f(g.babPre.slope.est, 2)} → ${f(g.babPost.slope.est, 2)};  G2 wOBAA ${f(g.preCorr, 4)} → ${f(g.postCorr, 4)} (Δ ${sgn(g.postCorr - g.preCorr, 4)} [${sgn(g.dCorrCI.lo, 4)},${sgn(g.dCorrCI.hi, 4)}]) ${g2 ? "PASS" : "FAIL"}`);
  }
  // pooled G2 for the HR-only candidate
  const dm = (get: (r: { pre: number; post: number; obs: number }) => number, rows: { pre: number; post: number; obs: number }[][]) => {
    const p: number[] = [], o: number[] = [];
    for (const rs of rows) { const mp = mean(rs.map(get)), mo = mean(rs.map((r) => r.obs)); for (const r of rs) { p.push(get(r) - mp); o.push(r.obs - mo); } }
    return { p, o };
  };
  const wRows = cells.map((c) => c.rows.map((r) => {
    const pr = byTier.get(c.tier)!.get(`${r.rec.title}|${r.rec.vlvl}`)!;
    return { pre: r.rec.ours.woba!, post: pr.ours.woba!, obs: r.rec.obs.woba! };
  }));
  const c1 = (() => { const d = dm((r) => r.pre, wRows); return pearson(d.p, d.o); })();
  const c2 = (() => { const d = dm((r) => r.post, wRows); return pearson(d.p, d.o); })();
  const r5 = rng(SEED + 88);
  const dPool: number[] = [];
  for (let b = 0; b < B; b++) {
    const rs = wRows.map((rows) => rows.map(() => rows[Math.floor(r5() * rows.length)]!));
    const d1 = dm((r) => r.pre, rs), d2 = dm((r) => r.post, rs);
    dPool.push(pearson(d2.p, d2.o) - pearson(d1.p, d1.o));
  }
  const dpCI = ci(dPool.filter(Number.isFinite));
  const hrRows2 = cells.map((c) => c.rows.map((r) => {
    const pr = byTier.get(c.tier)!.get(`${r.rec.title}|${r.rec.vlvl}`)!;
    return { pre: r.predHr, post: pr.ours.hr9!, obs: r.obsHr };
  }));
  const preHr2 = dm((r) => r.pre, hrRows2), postHr2 = dm((r) => r.post, hrRows2);
  console.log(`  POOLED: HR9 slope ${f(slopeOf(preHr2.p, preHr2.o), 2)} → ${f(slopeOf(postHr2.p, postHr2.o), 2)};  G2 wOBAA ${f(c1, 4)} → ${f(c2, 4)} (Δ ${sgn(c2 - c1, 4)} [${sgn(dpCI.lo, 4)},${sgn(dpCI.hi, 4)}])   ${c2 >= c1 || (dpCI.lo <= 0 && 0 <= dpCI.hi) ? "PASS" : "FAIL"}`);
}

// ═══ 5. WEIRD-ENV BATTERY + the HR/BABIP ERA-RESIDUAL CHECK ═══════════════════
console.log(`\n╔═══ 5. WEIRD-ENV BATTERY — dailies, DEPLOYED per-channel line (era/park applied) ═══╗`);
console.log(`  diamondcapdaily EXCLUDED (Derek: no config). Gap + means from each format's OWN eligible pool,`);
console.log(`  exactly as production would. BOTH pre and post carry the shipped K ramp. ERA-RESIDUAL CHECK:`);
console.log(`  the K precedent stalled at extreme eras (era_k over-compresses predicted spread); if HR/BABIP`);
console.log(`  show the same, it is FLAGGED as a factor-conditioned follow-up (a function of era_hr/era_h`);
console.log(`  FACTOR VALUES per plan §15.7) — never fit here, never a named-era exception.`);

const DAILY = [
  { fmt: "earlygolddaily", tid: "early-gold", label: "Early Gold Daily — era-1920/park-169" },
  { fmt: "bronzeheartdaily", tid: "bronze-heart", label: "Bronze Heart Daily — era-1939/park-191" },
  { fmt: "goldcapdaily", tid: "gold-cap", label: "Gold Cap Daily — era-2010/park-156, cap 1580" },
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
  const shift = buildFrameShift(TM, poolF);
  const kbar = poolMeanKOwn(basePool, coeffsF, rp, pt, FIELD_N).pit;
  const pm = poolPitMeansOwn(basePool, coeffsF, rp, pt, FIELD_N);
  const ksPre: KSpreadPit = { s: kSpreadPitRamp(shift.pit.vR.stu ?? 0), mean: kbar };
  const ksFull: KSpreadPit = { ...ksPre, sHr: fits.hr.sFn(shift.pit.vR.hrr ?? 0), meanHr: pm.hr, sBab: fits.bab.sFn(shift.pit.vR.pbabip ?? 0), meanBab: pm.bab };
  const ksHrO: KSpreadPit = { ...ksPre, sHr: ksFull.sHr, meanHr: pm.hr };
  const depsF: SampleDeps = { ...deps, coeffs: coeffsF, derived: derivedF };
  const cal = calibrate(basePool, { coeffs: coeffsF, derived: derivedF, eventForm: trained.eventForm!, poolTransform: pt, kSpread: { sHit: 1, sPit: ksPre.s, meanHit: 0, meanPit: kbar } });

  const cards: JoinCard[] = [];
  const byCid = new Map<string, { pre: Record<string, number>; post: Record<string, number>; postH: Record<string, number> }>();
  for (const bc of baseCards) {
    for (const [vlvl, c] of [[0, bc], [5, makeVariant(bc)]] as const) {
      if (!inV(c) || !rowEligible(c as any, t) || !isPit(c)) continue;
      const cid = `${bc["Card ID"]}|${vlvl}`;
      const pPre = ourPit(c, pt, depsF, cal, ksPre);
      const pPost = ourPit(c, pt, depsF, cal, ksFull);
      const pPostH = ourPit(c, pt, depsF, cal, ksHrO);
      cards.push({
        cid, name: cardName(c), val: n_(c["Card Value"]), vlvl, hand: handLetter(n_(c["Throws"])),
        primary: [Math.max(0, Math.min(1, (n_(c["Stamina"]) - 20) / 40)), pPre.dep.babip!],
        validate: [pPre.dep.k9!, pPre.dep.bb9!, pPre.dep.hr9!],
      });
      byCid.set(cid, { pre: pPre.dep, post: pPost.dep, postH: pPostH.dep });
    }
  }
  const { rows: obsRows } = parseCwhitPit(readFileSync(`${OBS_DIR}/cwhit-${D.fmt}-pit.tsv`, "utf8"));
  const obs: JoinObs<typeof obsRows[0]>[] = obsRows.map((r) => ({ name: r.name, val: r.val, vlvl: r.vlvl, hand: r.hand, primary: [r.gsPer, r.babip], validate: [r.k9, r.bb9, r.hr9], sample: r.ip, row: r }));
  const j = joinCwhit(obs, cards);
  const paired = j.matched
    .filter((m) => m.obs.row.ip >= MIN_IP)
    .map((m) => {
      const our = byCid.get(m.card.cid)!, o = m.obs.row;
      return { pre: our.pre, post: our.post, postH: our.postH, obs: { k9: o.k9, bb9: o.bb9, hr9: o.hr9, babip: o.babip, woba: pitWobaFromChannels(o.k9, o.bb9, o.hr9, o.babip, W) }, ip: o.ip };
    });
  console.log(`\n  ── ${D.label} ──`);
  console.log(`  pool ${basePool.length} | joined ${j.matched.length}/${obs.length}, well-sampled ${paired.length} | g_hr ${f(shift.pit.vR.hrr ?? 0, 1)} s_hr ${f(ksFull.sHr!, 2)}  g_bab ${f(shift.pit.vR.pbabip ?? 0, 1)} s_bab ${f(ksFull.sBab!, 2)} | era_hr(eff) ${f(derivedF.era_effective_hr, 3)}  era_h ${f(derivedF.era_h, 3)}`);
  if (paired.length < 8) { console.log(`  N too thin for a slope verdict — reporting nothing (never a number from noise)`); continue; }
  const r3 = rng(SEED + 100 + di);
  const chan = (get: (r: typeof paired[0]) => { p0: number; p1: number; o: number; nv: number }, lbl: string, d: number) => {
    const rows = paired.map(get);
    const preS: number[] = [], postS: number[] = [];
    for (let b = 0; b < B; b++) {
      const idx = rows.map(() => Math.floor(r3() * rows.length));
      preS.push(slopeOf(idx.map((i) => rows[i]!.p0), idx.map((i) => rows[i]!.o)));
      postS.push(slopeOf(idx.map((i) => rows[i]!.p1), idx.map((i) => rows[i]!.o)));
    }
    const preM = mmse(rows.map((r) => r.p0), rows.map((r) => r.o), rows.map((r) => r.nv));
    const postM = mmse(rows.map((r) => r.p1), rows.map((r) => r.o), rows.map((r) => r.nv));
    const preCI = ci(preS.filter(Number.isFinite)), postCI = ci(postS.filter(Number.isFinite));
    const g1 = postCI.lo <= 1 && 1 <= postCI.hi;
    console.log(`  ${lbl}: slope pre ${f(preM.slope.est, d)} [${f(preCI.lo, d)},${f(preCI.hi, d)}] → post ${f(postM.slope.est, d)} [${f(postCI.lo, d)},${f(postCI.hi, d)}]   ${g1 ? "PASS (CI covers 1)" : postM.slope.est > 1 ? "RESIDUAL >1 (under-corrected here)" : "OVERSHOOT <1"}   ratioDcv ${f(preM.ratioDeconv, 2)} → ${f(postM.ratioDeconv, 2)}`);
    return { pre: preM.slope.est, post: postM.slope.est, g1 };
  };
  const hrRes = chan((r) => ({ p0: r.pre.hr9!, p1: r.post.hr9!, o: r.obs.hr9, nv: hrNoise(r.obs.hr9, r.ip) }), "HR9  ", 2);
  const babRes = chan((r) => ({ p0: r.pre.babip!, p1: r.post.babip!, o: r.obs.babip, nv: babNoise(r.obs, r.ip) }), "BABIP", 2);
  const preW = paired.map((r) => pitWobaFromChannels(r.pre.k9!, r.pre.bb9!, r.pre.hr9!, r.pre.babip!, W));
  const postW = paired.map((r) => pitWobaFromChannels(r.post.k9!, r.post.bb9!, r.post.hr9!, r.post.babip!, W));
  const obsW = paired.map((r) => r.obs.woba);
  const dC: number[] = [];
  for (let b = 0; b < B; b++) {
    const idx = paired.map(() => Math.floor(r3() * paired.length));
    dC.push(pearson(idx.map((i) => postW[i]!), idx.map((i) => obsW[i]!)) - pearson(idx.map((i) => preW[i]!), idx.map((i) => obsW[i]!)));
  }
  const dCI = ci(dC.filter(Number.isFinite));
  const cPre = pearson(preW, obsW), cPost = pearson(postW, obsW);
  console.log(`  wOBAA corr: pre ${f(cPre, 4)} → post(full) ${f(cPost, 4)}  (Δ ${sgn(cPost - cPre, 4)} [${sgn(dCI.lo, 4)},${sgn(dCI.hi, 4)}])   ${cPost >= cPre || (dCI.lo <= 0 && 0 <= dCI.hi) ? "PASS" : "FAIL"}`);
  const postWH = paired.map((r) => pitWobaFromChannels(r.postH.k9!, r.postH.bb9!, r.postH.hr9!, r.postH.babip!, W));
  const dCH: number[] = [];
  for (let b = 0; b < B; b++) {
    const idx = paired.map(() => Math.floor(r3() * paired.length));
    dCH.push(pearson(idx.map((i) => postWH[i]!), idx.map((i) => obsW[i]!)) - pearson(idx.map((i) => preW[i]!), idx.map((i) => obsW[i]!)));
  }
  const dCHci = ci(dCH.filter(Number.isFinite));
  const cPostH = pearson(postWH, obsW);
  console.log(`  wOBAA corr: pre ${f(cPre, 4)} → post(HR-only) ${f(cPostH, 4)}  (Δ ${sgn(cPostH - cPre, 4)} [${sgn(dCHci.lo, 4)},${sgn(dCHci.hi, 4)}])   ${cPostH >= cPre || (dCHci.lo <= 0 && 0 <= dCHci.hi) ? "PASS" : "FAIL"}`);
  void hrRes; void babRes;
}

// ═══ 6. SHIPPING CONSTANTS (pending gate verdict) ═════════════════════════════
console.log(`\n╔═══ 6. SHIPPING CANDIDATE — the constants production wiring would embed ═══╗`);
console.log(`  HR_SPREAD_PIT  = { A: ${f(fits.hr.ship.A, 4)}, G: ${f(fits.hr.ship.G, 1)} }   s at tier g_hr: ${cells.map((c) => `${c.tier} ${f(fits.hr.sFn(c.gapHr), 2)}`).join(", ")}`);
console.log(`  BAB_SPREAD_PIT = { A: ${f(fits.bab.ship.A, 4)}, G: ${f(fits.bab.ship.G, 1)} }   s at tier g_bab: ${cells.map((c) => `${c.tier} ${f(fits.bab.sFn(c.gapBab), 2)}`).join(", ")}`);
console.log(`  gaps = buildFrameShift(trainingMeans, poolField).pit.vR.{hrr, pbabip}; means = poolPitMeansOwn(...).{hr, bab}.`);
console.log(`  Application = applyPitSpread on the own-gap branch (K leg unchanged); BABIP rides e.hMul; NO per-tournament constants.`);
console.log(``);
process.exit(0);
