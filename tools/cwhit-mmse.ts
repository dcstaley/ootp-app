// THE MMSE / SPACING-CALIBRATION BATTERY — is the per-channel compression a DEFECT, and if so is it
// FLAT (a universal per-channel calibration scalar could fix it) or TAIL-CONCENTRATED (curve-shape
// work at the top of the rating; a scalar is the wrong instrument)?
//   run: node tools/cwhit-mmse.ts
//
// This is the decisive instrument behind Derek's Ruling 2 (events + type bias). It rebuilds the
// spacing battery a prior session started (salt doctrine: every number here is RECOMPUTED, nothing
// inherited). It fits nothing, changes no scoring, writes nothing.
//
// THE FOUR QUESTIONS, in order:
//   1. IS THE UNDER-REACTION REAL? An optimally-shrunk (MMSE) predictor satisfies
//      SD(pred)/SD(true) ≈ corr(pred,true) — equivalently slope(obs~pred) = 1, and the slope is
//      NOISE-IMMUNE (observed sampling noise lands in the residual, never the estimand). Per
//      channel × role × tier (pooled with tier fixed effects where depth is thin): corr, raw ratio,
//      deconvolved ratio, slope with a CARD-BOOTSTRAP CI, verdict.
//   2. FLAT OR TAIL-CONCENTRATED? Band-wise calibration slopes by predicted-value quartile
//      (oriented worst→elite per channel) + the top-quartile-vs-rest slope split, bootstrap CI on
//      the difference. FLAT ⇒ scalar; TAIL ⇒ curve-shape. This fork gates the fix.
//   3. CWHIT REFERENCE COLUMN — the same metrics for HIS projections vs observed. Semi-in-sample
//      (window overlap printed), so DIRECTIONAL ONLY — but if his ratios sit ≈1 where ours sit
//      0.5–0.7, the "irreducible variance / form is maxed" story weakens.
//   4. VALUE-WEIGHTED RANKING — de-shrink each channel to its calibration slope (level-preserving),
//      push the change through the composite wOBA, and rank channels by the mwOBA spacing stake.
//      A compressed channel that barely moves value doesn't merit a retrain cycle.
//
// DOCTRINE: cwhit RAW OBSERVED events = ground truth. His PROJECTIONS = competitor benchmark, weight
// ZERO as truth, never a fitting target. Eval frame = RAW event-model line, own-gap applied, no
// anchor (Derek: the anchor is a convention, not a prediction). Neutral Quick env only.

import { readFileSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import {
  makeRawPolyModel, computeUnifiedFieldStats, applyWobaWeights, computeDerived,
  type EventForm, type FieldStats, type RatingEnvelope, type WobaWeights,
} from "../src/scoring-core/index.ts";
import { parseCatalogCsv } from "../src/data/catalog.ts";
import { HIT_BIP_ADJ } from "../src/model/curves.ts";
import { pitWobaFromChannels, type WobaWeights as WW } from "../src/eval/cwhit/audit.ts";
import { per9NoiseVar, babipNoiseVar, pctNoiseVar, per600NoiseVar, BF_PER_9 } from "../src/eval/cwhit/scorecard.ts";
import { mmse, type Mmse } from "../src/eval/cwhit/two-ledger.ts";
import {
  buildCwhitSample, wellSampled, QUICK, MIN_IP, MIN_PA,
  type Rec, type SampleDeps,
} from "../src/eval/cwhit/sample.ts";

const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const sgn = (x: number, d = 2) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}` : "n/a");

// ── deployed model + neutral env (IDENTICAL setup to tools/cwhit-scorecard.ts) ──
const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state = (await repo.load<{ activeModelId?: string; catalogSourceId?: string }>("state", "app")) ?? {};
type TM = { id: string; eventForm?: EventForm; wobaWeights?: WobaWeights; ratingEnvelope?: RatingEnvelope; platoon?: { pit: { hand: string; vsRHB: number; vsLHB: number }[]; hit: { hand: string; vsRHP: number; vsLHP: number }[] } };
const trained = (await repo.loadAll<TM>("trained-models")).find((x) => x.id === state.activeModelId);
if (!trained?.eventForm || !trained.wobaWeights || !trained.platoon) throw new Error("active model missing eventForm/wobaWeights/platoon");
const rp = makeRawPolyModel(trained.eventForm);
const W = trained.wobaWeights as WW;
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const bq = (await repo.loadAll<Tournament>("tournaments")).find((t) => t.id === "bronze-quick")!;
const coeffs = resolveCoeffs(model, eras.get(bq.eraId)!, parks.get(bq.parkId)!, bq.softcaps);
applyWobaWeights(coeffs, trained.wobaWeights);
const derived = computeDerived(coeffs);
const srcId = state.catalogSourceId ?? "cdmx";
const baseCards = parseCatalogCsv(readFileSync(`data/imports/${srcId}.csv`, "utf8")).cards.filter((c) => String(c["Variant"] ?? "").toUpperCase() !== "Y");
const ref: FieldStats = computeUnifiedFieldStats(baseCards, coeffs, rp, 50, true);
const deps: SampleDeps = {
  baseCards, coeffs, derived, eventForm: trained.eventForm, model: rp, W, ref, envelope: trained.ratingEnvelope,
  pitExp: new Map(trained.platoon.pit.map((p) => [p.hand, { wR: p.vsRHB, wL: p.vsLHB }])),
  hitExp: new Map(trained.platoon.hit.map((p) => [p.hand, { wR: p.vsRHP, wL: p.vsLHP }])),
};
const { recs, windows } = buildCwhitSample(deps);

// ── channels ─────────────────────────────────────────────────────────────────
// `dir` = the ELITE direction (which end of the predicted range is "good"), used ONLY to orient the
// quartile bands so "Q4 = elite" reads the same for every channel. Slopes are direction-invariant.
const CH: Record<"pit" | "hit", { key: string; lbl: string; d: number; dir: 1 | -1 }[]> = {
  pit: [
    { key: "k9", lbl: "K9", d: 2, dir: 1 }, { key: "bb9", lbl: "BB9", d: 2, dir: -1 },
    { key: "hr9", lbl: "HR9", d: 2, dir: -1 }, { key: "babip", lbl: "BABIP", d: 3, dir: -1 },
    { key: "woba", lbl: "wOBAA", d: 3, dir: -1 },
  ],
  hit: [
    { key: "bbPct", lbl: "BB%", d: 2, dir: 1 }, { key: "soPct", lbl: "SO%(PA)", d: 2, dir: -1 },
    { key: "hr600", lbl: "HR600", d: 2, dir: 1 }, { key: "babip", lbl: "BABIP", d: 3, dir: 1 },
    { key: "woba", lbl: "wOBA", d: 3, dir: 1 },
  ],
};

// Per-card observed sampling variance — the SAME noise model as tools/cwhit-scorecard.ts (copied:
// tools are entry-point scripts with top-level effects, so a tool cannot import another tool).
function noiseOf(r: Rec, ch: string): number {
  if (r.role === "pit") {
    const bf = r.sample * 4.3;
    const bip = Math.max(bf - (r.obs.k9! + r.obs.bb9! + r.obs.hr9!) / BF_PER_9 * bf - 0.009 * bf, 1);
    if (ch === "babip") return babipNoiseVar(r.obs.babip!, bip);
    if (ch === "woba") return NaN;   // composite; no clean binomial form ⇒ deconv fields read n/a
    return per9NoiseVar(r.obs[ch]!, r.sample);
  }
  const bip = Math.max(r.sample * (1 - r.obs.bbPct! / 100 - 0.008 - r.obs.soPct! / 100 - r.obs.hr600! / 600), 1);
  if (ch === "babip") return babipNoiseVar(r.obs.babip!, bip);
  if (ch === "hr600") return per600NoiseVar(r.obs.hr600!, r.sample);
  if (ch === "woba") return NaN;
  return pctNoiseVar(r.obs[ch]!, r.sample);
}

// ── cell assembly ────────────────────────────────────────────────────────────
interface Row { tier: string; pred: number; obs: number; nv: number }
const MIN_TIER_N = 10;    // a per-tier cell below this reports only into the pool
const MIN_POOL_N = 5;     // a tier below this is dropped even from the pool (diamond pit N=1)

function collect(role: "pit" | "hit", key: string, who: "ours" | "proj"): Map<string, Row[]> {
  const by = new Map<string, Row[]>();
  for (const r of recs) {
    if (r.role !== role || !wellSampled(r)) continue;
    const p = who === "ours" ? r.ours[key] : r.proj?.[key];
    const o = r.obs[key];
    if (!Number.isFinite(p) || !Number.isFinite(o)) continue;
    (by.get(r.tier) ?? by.set(r.tier, []).get(r.tier)!).push({ tier: r.tier, pred: p!, obs: o!, nv: noiseOf(r, key) });
  }
  for (const [t, rows] of by) if (rows.length < MIN_POOL_N) by.delete(t);
  return by;
}

/** Pool tiers with TIER FIXED EFFECTS: de-mean pred and obs within tier, so the pooled slope is the
 *  within-tier calibration slope and cross-tier level differences (frame effects) cannot leak in. */
function demeanPool(by: Map<string, Row[]>): { p: number[]; o: number[]; nv: number[] } {
  const p: number[] = [], o: number[] = [], nv: number[] = [];
  for (const rows of by.values()) {
    const mp = rows.reduce((a, r) => a + r.pred, 0) / rows.length;
    const mo = rows.reduce((a, r) => a + r.obs, 0) / rows.length;
    for (const r of rows) { p.push(r.pred - mp); o.push(r.obs - mo); nv.push(r.nv); }
  }
  return { p, o, nv };
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
/** OLS slope of obs on pred — THE calibration slope. Noise-immune (see two-ledger.ts module header). */
function slopeOf(p: number[], o: number[]): number {
  const mp = mean(p), mo = mean(o);
  let sxx = 0, sxy = 0;
  for (let i = 0; i < p.length; i++) { sxx += (p[i]! - mp) ** 2; sxy += (p[i]! - mp) * (o[i]! - mo); }
  return sxx > 0 ? sxy / sxx : NaN;
}

/** Band-wise slopes by predicted quartile, oriented so Q4 = the ELITE end of the channel, plus the
 *  top-vs-rest split (slope in Q4 minus slope over Q1–Q3). */
function bands(p: number[], o: number[], dir: 1 | -1): { q: number[]; ns: number[]; top: number; rest: number; delta: number } {
  const idx = p.map((_, i) => i).sort((a, b) => dir * (p[a]! - p[b]!));   // worst → elite
  const n = idx.length, q: number[] = [], ns: number[] = [];
  for (let b = 0; b < 4; b++) {
    const cut = idx.slice(Math.floor((b * n) / 4), Math.floor(((b + 1) * n) / 4));
    q.push(slopeOf(cut.map((i) => p[i]!), cut.map((i) => o[i]!)));
    ns.push(cut.length);
  }
  const q4 = idx.slice(Math.floor((3 * n) / 4)), q13 = idx.slice(0, Math.floor((3 * n) / 4));
  const top = slopeOf(q4.map((i) => p[i]!), q4.map((i) => o[i]!));
  const rest = slopeOf(q13.map((i) => p[i]!), q13.map((i) => o[i]!));
  return { q, ns, top, rest, delta: top - rest };
}

// ── card bootstrap (resample WITHIN tier, re-de-mean per replicate, seeded/deterministic) ──
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
interface BootCI { lo: number; hi: number }
const pct = (xs: number[], q: number) => { const v = [...xs].sort((a, b) => a - b); return v[Math.min(Math.max(Math.floor(q * v.length), 0), v.length - 1)]!; };

/** Bootstrap the pooled slope AND the top-vs-rest band split in one pass. Quartile re-assignment and
 *  tier re-de-meaning happen INSIDE each replicate, so the CIs carry that uncertainty too. */
function boot(by: Map<string, Row[]>, dir: 1 | -1, B = 2000, seed = 20260716): { slope: BootCI; delta: BootCI; top: BootCI } {
  const rnd = rng(seed);
  const slopes: number[] = [], deltas: number[] = [], tops: number[] = [];
  for (let b = 0; b < B; b++) {
    const rby = new Map<string, Row[]>();
    for (const [t, rows] of by) rby.set(t, rows.map(() => rows[Math.floor(rnd() * rows.length)]!));
    const { p, o } = demeanPool(rby);
    const s = slopeOf(p, o);
    if (Number.isFinite(s)) slopes.push(s);
    const bd = bands(p, o, dir);
    if (Number.isFinite(bd.delta)) deltas.push(bd.delta);
    if (Number.isFinite(bd.top)) tops.push(bd.top);
  }
  const ci = (xs: number[]): BootCI => (xs.length < 100 ? { lo: NaN, hi: NaN } : { lo: pct(xs, 0.025), hi: pct(xs, 0.975) });
  return { slope: ci(slopes), delta: ci(deltas), top: ci(tops) };
}

function verdictOf(slope: number, ci: BootCI): string {
  if (!Number.isFinite(slope) || !Number.isFinite(ci.lo)) return "n/a";
  if (ci.lo > 1) return "OVER-SHRUNK";
  if (ci.hi < 1) return "OVER-SPREAD";
  return "MMSE-OK";
}

interface CellOut { tier: string; n: number; m: Mmse; bci: BootCI; verdict: string }
/** Per-tier cells run on raw values; pooled cells arrive pre-de-meaned. Either way mmse's
 *  slope/corr/ratio are translation-invariant. */
function runCell(rows: Row[]): { m: Mmse } {
  const p = rows.map((r) => r.pred), o = rows.map((r) => r.obs), nv = rows.map((r) => r.nv);
  const useNv = nv.every((x) => Number.isFinite(x)) ? nv : undefined;
  return { m: mmse(p, o, useNv) };
}

// ═════════════════════════════════════════════════════════════════════════════
console.log(`\n╔══════════════════════════════════════════════════════════════════════════════════════════════╗`);
console.log(`║  MMSE / SPACING-CALIBRATION BATTERY — is the compression a defect, and is it FLAT or TAIL?    ║`);
console.log(`╚══════════════════════════════════════════════════════════════════════════════════════════════╝`);
console.log(`model '${trained.id}' | catalog '${srcId}' | RAW event line, own-gap ON, no anchor (the like-for-like eval frame)`);
console.log(`well-sampled bar: IP≥${MIN_IP} (pit) / PA≥${MIN_PA} (hit). Per-tier cells need N≥${MIN_TIER_N}; POOLED = all tiers with N≥${MIN_POOL_N}, de-meaned within tier (tier fixed effects) so frame-level differences cannot leak into the slope.`);
console.log(`\nHOW TO READ: slope = OLS of obs on pred (noise-immune — sampling noise lands in the residual, so it needs NO deconvolution). slope 1.0 = calibrated = consistent with honest MMSE shrinkage.`);
console.log(`slope > 1 (CI-clear) = OVER-SHRUNK: we under-react by that factor. The SD-space view says the same thing: an MMSE-optimal predictor has ratio = corr, i.e. shrinkIdx = ratioDcv/corrDcv = 1.`);
console.log(`CIs on the slope are a 2000-rep card bootstrap (resample cards within tier, re-de-mean, re-band per replicate). mmse()'s analytic t-CI is computed for every cell too; the max endpoint disagreement vs the bootstrap is printed after §1 as a cross-check.`);

// ═══ 1. THE PER-CELL TABLE ═══════════════════════════════════════════════════
const pooledOut: { role: "pit" | "hit"; key: string; lbl: string; d: number; dir: 1 | -1; by: Map<string, Row[]>; m: Mmse; bci: BootCI; verdict: string; cells: CellOut[] }[] = [];
// t-CI vs bootstrap-CI cross-check, accumulated over every cell. The number that matters is whether
// any VERDICT depends on the CI method; the max endpoint gap contextualises where they differ.
let ciMaxGap = 0, ciCells = 0, ciMaxAt = "";
const ciFlips: string[] = [];
const ciCheck = (label: string, m: Mmse, bci: BootCI) => {
  if (!Number.isFinite(m.slope.lo) || !Number.isFinite(bci.lo)) return;
  ciCells++;
  const gap = Math.max(Math.abs(m.slope.lo - bci.lo), Math.abs(m.slope.hi - bci.hi));
  if (gap > ciMaxGap) { ciMaxGap = gap; ciMaxAt = label; }
  const bv = verdictOf(m.slope.est, bci), tv = verdictOf(m.slope.est, { lo: m.slope.lo, hi: m.slope.hi });
  if (bv !== tv) ciFlips.push(`${label} (boot ${bv} / t ${tv})`);
};
for (const role of ["pit", "hit"] as const) {
  console.log(`\n\n╔═══ 1. IS THE UNDER-REACTION REAL? — ${role === "pit" ? "PITCHERS" : "HITTERS"} (ours vs observed) ═══╗`);
  console.log(`channel   tier       N   corr(raw/dcv)   SD(pred)  SD(obs)  ratio(raw/dcv)  optRatio  shrinkIdx   slope  [boot 95% CI]   noise%   verdict`);
  for (const { key, lbl, d, dir } of CH[role]) {
    const by = collect(role, key, "ours");
    const cells: CellOut[] = [];
    for (const { tier } of QUICK) {
      const rows = by.get(tier);
      if (!rows || rows.length < MIN_TIER_N) continue;
      const { m } = runCell(rows);
      const bci = boot(new Map([[tier, rows]]), dir).slope;
      ciCheck(`${role} ${lbl} ${tier}`, m, bci);
      const verdict = verdictOf(m.slope.est, bci);
      cells.push({ tier, n: rows.length, m, bci, verdict });
    }
    const { p, o, nv } = demeanPool(by);
    const useNv = nv.every((x) => Number.isFinite(x)) ? nv : undefined;
    const mP = mmse(p, o, useNv);
    const bP = boot(by, dir);
    ciCheck(`${role} ${lbl} POOLED`, mP, bP.slope);
    const vP = verdictOf(mP.slope.est, bP.slope);
    pooledOut.push({ role, key, lbl, d, dir, by, m: mP, bci: bP.slope, verdict: vP, cells });
    const line = (tier: string, n: number, m: Mmse, bci: BootCI, verdict: string) =>
      console.log(
        `${lbl.padEnd(9)} ${tier.padEnd(8)} ${String(n).padStart(4)}   ${f(m.corrRaw, 3)}/${f(m.corrDeconv, 3)}     ` +
        `${f(m.sdPred, d + 1).padStart(7)}  ${f(m.sdObs, d + 1).padStart(7)}   ${f(m.ratioRaw, 2)}/${f(m.ratioDeconv, 2)}       ` +
        `${f(m.optimalRatio, 2).padStart(5)}     ${f(m.shrinkIndex, 2).padStart(5)}    ${f(m.slope.est, 2).padStart(5)}  [${f(bci.lo, 2)},${f(bci.hi, 2)}]    ` +
        `${(Number.isFinite(m.noiseShare) ? `${f(m.noiseShare * 100, 0)}%` : "n/a").padStart(4)}   ${verdict}`,
      );
    for (const c of cells) line(c.tier, c.n, c.m, c.bci, c.verdict);
    line("POOLED", p.length, mP, bP.slope, vP + (vP === "OVER-SHRUNK" ? ` — we under-react ${f(mP.slope.est, 2)}×` : ""));
    console.log(``);
  }
  console.log(`  (optRatio = corr_dcv = what an OPTIMALLY-shrunk predictor's SD ratio SHOULD be; shrinkIdx = ratioDcv/optRatio, 1 = optimal, <1 = over-shrunk. Composites' dcv columns read n/a — the slope needs no noise model and is the verdict either way.)`);
}
console.log(`\n  CI CROSS-CHECK: analytic t-CI (mmse) vs card-bootstrap CI over ${ciCells} cells — verdict agrees on ${ciCells - ciFlips.length}/${ciCells}; max endpoint gap ${f(ciMaxGap, 3)} slope units (at ${ciMaxAt}).`);
if (ciFlips.length) {
  console.log(`  ⚠ verdict depends on the CI method in ${ciFlips.length} cell(s) — treat these as BORDERLINE, not CI-clear:`);
  for (const s of ciFlips) console.log(`      ${s}`);
}

// ═══ 2. FLAT OR TAIL-CONCENTRATED? ═══════════════════════════════════════════
console.log(`\n\n╔═══ 2. FLAT OR TAIL-CONCENTRATED? — band-wise calibration slopes on the POOLED sample ═══╗`);
console.log(`Bands = quartiles of PREDICTED value (tier-de-meaned), oriented so Q4 = the ELITE end of the channel. Within-band slopes are noisy (restricted x-range) — the decision statistic is Δ(top−rest) with its bootstrap CI.`);
console.log(`FLAT (Δ CI covers 0, pooled slope >1) ⇒ ONE per-channel calibration scalar could fix it. TAIL (Δ CI-clear >0 at the elite end) ⇒ curve-shape problem at the top; a scalar is the WRONG instrument.`);
console.log(`\nrole  channel    pooled-slope   Q1(worst)   Q2      Q3      Q4(elite)   top-vs-rest Δ  [boot 95% CI]   fork`);
for (const P of pooledOut) {
  const { p, o } = demeanPool(P.by);
  const bd = bands(p, o, P.dir);
  const b = boot(P.by, P.dir);
  const under = P.verdict === "OVER-SHRUNK";
  const fork = !under
    ? (P.verdict === "MMSE-OK" ? "calibrated — no fix needed" : P.verdict)
    : !Number.isFinite(b.delta.lo) ? "under-reacting; bands unresolvable"
      : b.delta.lo > 0 ? "TAIL — elite end under-reacts EXTRA; scalar wrong instrument"
        : b.delta.hi < 0 ? "INVERSE-TAIL — elite end closer to calibrated; scalar overshoots the top"
          : "FLAT — uniform under-reaction; a per-channel scalar is the right instrument";
  console.log(
    `${P.role}   ${P.lbl.padEnd(9)}  ${f(P.m.slope.est, 2).padStart(5)} [${f(P.bci.lo, 2)},${f(P.bci.hi, 2)}]  ` +
    bd.q.map((x) => f(x, 2).padStart(6)).join("  ") +
    `      ${sgn(bd.delta, 2).padStart(6)}  [${sgn(b.delta.lo, 2)},${sgn(b.delta.hi, 2)}]   ${fork}`,
  );
}
console.log(`\n  (Q-band slopes are POINT estimates — read the fork off the Δ CI only. Δ>0 = the elite quartile's slope EXCEEDS the rest = the top is even more under-reacted.)`);

// ═══ 3. CWHIT REFERENCE COLUMN ═══════════════════════════════════════════════
console.log(`\n\n╔═══ 3. CWHIT REFERENCE — his projections vs observed, same metrics (DIRECTIONAL ONLY) ═══╗`);
console.log(`His model is SEMI-IN-SAMPLE vs the judging window (overlap per tier below) ⇒ his slope/ratio are an UPPER BOUND on what an honest model achieves. The read: if his ratios ≈1 where ours are 0.5–0.7, the "irreducible variance / form is maxed" story weakens.`);
for (const w of windows) console.log(`  overlap ${w.tier} ${w.role}: ${f(w.w.overlapPctOfObs, 0)}% of judging window in his training set`);
for (const role of ["pit", "hit"] as const) {
  console.log(`\n─── ${role === "pit" ? "PITCHERS" : "HITTERS"} — OURS vs CWHIT side by side (pooled, tier-de-meaned; per-tier where N≥${MIN_TIER_N}) ───`);
  console.log(`channel   tier       N(ours/his)   corr ours/his   ratioDcv ours/his   slope ours [CI]      slope his [CI]`);
  for (const { key, lbl, dir } of CH[role]) {
    const oursBy = collect(role, key, "ours");
    const hisBy = collect(role, key, "proj");
    const show = (tier: string, ob: Map<string, Row[]>, hb: Map<string, Row[]>) => {
      const od = demeanPool(ob), hd = demeanPool(hb);
      if (!od.p.length || !hd.p.length) return;
      const om = mmse(od.p, od.o, od.nv.every(Number.isFinite) ? od.nv : undefined);
      const hm = mmse(hd.p, hd.o, hd.nv.every(Number.isFinite) ? hd.nv : undefined);
      const obci = boot(ob, dir).slope, hbci = boot(hb, dir, 2000, 20260717).slope;
      console.log(
        `${lbl.padEnd(9)} ${tier.padEnd(8)} ${`${od.p.length}/${hd.p.length}`.padStart(9)}     ${f(om.corrRaw, 2)} / ${f(hm.corrRaw, 2)}     ` +
        `${f(om.ratioDeconv, 2).padStart(5)} / ${f(hm.ratioDeconv, 2).padEnd(5)}      ` +
        `${f(om.slope.est, 2).padStart(5)} [${f(obci.lo, 2)},${f(obci.hi, 2)}]   ${f(hm.slope.est, 2).padStart(5)} [${f(hbci.lo, 2)},${f(hbci.hi, 2)}]`,
      );
    };
    for (const { tier } of QUICK) {
      const or = oursBy.get(tier), hr = hisBy.get(tier);
      if (!or || !hr || or.length < MIN_TIER_N || hr.length < MIN_TIER_N) continue;
      show(tier, new Map([[tier, or]]), new Map([[tier, hr]]));
    }
    // Pooled reference restricted to rows where BOTH predictors exist would differ from §1's pool;
    // print his pool over his own joined rows and label the Ns so the bases are explicit.
    show("POOLED", oursBy, hisBy);
  }
}

// ═══ 4. VALUE-WEIGHTED RANKING ═══════════════════════════════════════════════
// De-shrink each channel to its pooled calibration slope (per tier, level-preserving: the tier mean is
// untouched), push the change through the composite wOBA, and measure the per-card mwOBA displacement.
// SD(Δ) = how much per-card VALUE spacing the channel's miscalibration is worth — the retrain-priority
// metric. wOBA reconstruction mirrors sample.ts's raw line: pitchers via pitWobaFromChannels (same
// 0.25 xbh share), hitters via the per-card XBH share INFERRED from our own predicted woba (exact
// inversion of the raw assembly — no fixed share anywhere on the hitter side).
console.log(`\n\n╔═══ 4. VALUE-WEIGHTED RANKING — mwOBA spacing stake per channel (what fixing it is WORTH) ═══╗`);

function hitWobaFromCh(bbPct: number, soPct: number, hr600: number, babip: number, xbhShare: number): number {
  const BB = bbPct * 6, SO = soPct * 6, HR = hr600;
  const BIP = Math.max(600 - BB - SO - HR - HIT_BIP_ADJ, 1);
  const H = babip * BIP, GAP = xbhShare * H, oneB = H - GAP;
  return (W.bb * BB + W.hbp * 6 + W.b1 * oneB + W.xbh * GAP + W.hr * HR) / 600;
}
/** Invert sample.ts's raw hitter assembly to recover the card's own predicted non-HR XBH share. */
function hitXbhShare(r: Rec): number {
  const BB = r.ours.bbPct! * 6, SO = r.ours.soPct! * 6, HR = r.ours.hr600!;
  const BIP = Math.max(600 - BB - SO - HR - HIT_BIP_ADJ, 1);
  const H = r.ours.babip! * BIP;
  if (!(H > 0)) return 0.30;
  const GAP = (600 * r.ours.woba! - W.bb * BB - W.hbp * 6 - W.hr * HR - W.b1 * H) / (W.xbh - W.b1);
  return Math.min(Math.max(GAP / H, 0), 1);
}
function wobaOf(r: Rec, over: Record<string, number>): number {
  const g = (k: string) => over[k] ?? r.ours[k]!;
  return r.role === "pit"
    ? pitWobaFromChannels(g("k9"), g("bb9"), g("hr9"), g("babip"), W)
    : hitWobaFromCh(g("bbPct"), g("soPct"), g("hr600"), g("babip"), hitXbhShare(r));
}

interface Stake { role: string; lbl: string; slope: number; verdict: string; sdCh: number; d: number; sdMw: number; meanAbsMw: number }
const stakes: Stake[] = [];
for (const P of pooledOut) {
  if (P.key === "woba") continue;   // the composite IS value; it doesn't rank against its own parts
  const rowsByTier = new Map<string, Rec[]>();
  for (const r of recs) {
    if (r.role !== P.role || !wellSampled(r) || !Number.isFinite(r.ours[P.key]) || !Number.isFinite(r.obs[P.key])) continue;
    if (!P.by.has(r.tier)) continue;
    (rowsByTier.get(r.tier) ?? rowsByTier.set(r.tier, []).get(r.tier)!).push(r);
  }
  const dmw: number[] = [], chDev: number[] = [];
  for (const rows of rowsByTier.values()) {
    const m = mean(rows.map((r) => r.ours[P.key]!));
    for (const r of rows) {
      const x = r.ours[P.key]!;
      const xs = m + P.m.slope.est * (x - m);
      dmw.push((wobaOf(r, { [P.key]: xs }) - wobaOf(r, {})) * 1000);
      chDev.push(xs - x);
    }
  }
  const sdMw = Math.sqrt(mean(dmw.map((x) => (x - mean(dmw)) ** 2)));
  stakes.push({
    role: P.role, lbl: P.lbl, slope: P.m.slope.est, verdict: P.verdict,
    sdCh: Math.sqrt(mean(chDev.map((x) => (x - mean(chDev)) ** 2))), d: P.d,
    sdMw, meanAbsMw: mean(dmw.map(Math.abs)),
  });
}
stakes.sort((a, b) => b.sdMw - a.sdMw);
console.log(`De-shrink = pred → tierMean + slope×(pred − tierMean), i.e. the level-preserving correction the pooled calibration slope implies; Δ = the resulting composite-wOBA move per card.`);
console.log(`\nrank  role  channel    slope   verdict        SD of channel correction   SD(Δ value) mwOBA   mean|Δ| mwOBA`);
stakes.forEach((s, i) =>
  console.log(`  ${String(i + 1).padEnd(3)} ${s.role}   ${s.lbl.padEnd(9)} ${f(s.slope, 2).padStart(5)}   ${s.verdict.padEnd(12)}   ${f(s.sdCh, s.d + 1).padStart(10)} (channel units)   ${f(s.sdMw, 1).padStart(8)}          ${f(s.meanAbsMw, 1).padStart(8)}`),
);
console.log(`\n  READ: SD(Δ value) = the per-card value spacing at stake in that channel's miscalibration. A channel with a wild slope but a tiny stake does not merit a retrain cycle.`);
console.log(`  (Channels whose verdict is MMSE-OK are listed with their point-slope stake for completeness — treat their stake as ~0 pending evidence.)`);
console.log(``);
process.exit(0);
