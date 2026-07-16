// THE HITTER HR+BABIP PAIRED TAIL BAKE-OFF — design comparison for BUILD-2 (plan §15 sequencing).
//   run: node tools/hit-tail-bakeoff.ts
//
// THE DEFECT (three independent views agree — MMSE battery, archetype ledger, rating-quartile grid):
//   · HR600 bias by POW quartile is NON-MONOTONE (Q1 −0.68*, Q2 +1.92*, Q3 +1.73*, Q4 −2.10*): we
//     over-predict MID power and under-predict ELITE power, CI-clear at every tier. Elite-quartile
//     calibration slope 2.44 vs pooled 1.17 (TAIL). The hitter HR quad bends down too early where
//     tournament pools land.
//   · BABIP is TAIL too: pooled slope 1.39 [1.24,1.56], elite band 1.94.
//   · THE CANCELLATION CONSTRAINT (binding): on elite-power cards the HR under-credit (−3.6 mwOBA)
//     is offset by BABIP+SO over-credit (+3.8) — net ≈0 today. Fixing either alone UN-CANCELS and
//     flips elite power to mis-valued. HR and BABIP must land TOGETHER; the archetype ledger re-run
//     is the acceptance check (with per-archetype CHANNEL DRIVERS printed so a "net ≈0 by a new
//     cancellation" cannot masquerade as a resolution).
//   · League IN-FRAME hitter calibration is GOOD (insample-frame-check: HR bias +0.03 flat) — the
//     defect is OUT-OF-FRAME ⇒ corrections must be league-neutral (identity at gap→0) OR form
//     changes that OOT-validate on league. Properties-not-identity rule: parameters derive from pool
//     composition/config only, fit ONCE (universal), never per-tournament.
//   · A flat linear scalar is PROVABLY wrong for HR (it pushes Q2/Q3 the wrong way — the MMSE fork);
//     it is nonetheless in the sweep as the `pivot` family so that claim is retested, not inherited.
//   · hit SO% is INVERSE-TAIL (elite end already calibrated) — deliberately NOT touched here.
//   · The two-ledger HR sign quarantine (§15.6) blocked HR LEVEL fits while hit/pit disagreed on
//     sign; the synthesis resolved the flip as spread-compression-seen-through-selection. This work
//     is the commissioned resolution path: tail SHAPE, not a level constant (Ruling-1 scope: the
//     anchor absorbs uniform-within-role levels; the quartile shape is what is live).
//
// CANDIDATES:
//   A. GAP-CONDITIONED EVENT-SPACE CORRECTION, per channel (HR600, BABIP — plus SO% as an OPTIONAL
//      third leg, because the elite-power cancellation has a +1.2 mwOBA SO component that un-cancels
//      when HR+BABIP are fixed alone; the work order's "address SO only if the design naturally fixes
//      it" hook). Applied to the model's predicted rate AFTER the own-gap transform. Five families ×
//      two gap-conditioning shapes, strength λ fit ONCE across tiers (grid on the calibration-slope
//      loss, held-out-tier OOT):
//        hinge:   x' = x + λ·w(g)·max(x − pool_p75, 0)          one-sided stretch above the pool p75
//        hinge50: same, pivot at the pool MEDIAN (stretches mid + tail)
//        quad:    x' = x + λ·w(g)·sd·(z²−1), z=(x−pool_m)/sd    convexity restore (down mid, up both
//                 ends — the Q2/Q3 hump fix); monotone-clamped by the pool's LEFT z-edge (the only
//                 side where the derivative 1+2·λw·z can go negative)
//        pivot:   x' = pool_m + (1+λ·w(g))·(x − pool_m)         level-preserving two-sided stretch
//                 (the kSpread class — the "provably wrong for HR" claim gets its retest here)
//        step:    x' = x + λ·w(g)·sd·tanh(z)                    MID-band stretch, flat at both ends —
//                 the INVERSE-TAIL instrument (SO%'s shape: ends calibrated, mid under-reacts);
//                 monotone for any λ·w ≥ 0
//      w(g) = g (linear in gap) or 1−e^(−g/0.10) (saturating ≈ tier-flat), where g = k−1 from the
//      OWN-GAP pool transform's mean-scalar for the driving rating (POW / BABIP / AvoidK) — a pure
//      pool-composition property. League frame ⇒ k=1 ⇒ g=0 ⇒ IDENTITY, exactly.
//   B. FORM CHANGE: refit the hitter HR curve (and/or the H BABIP curve) on LEAGUE data with a
//      family whose top doesn't bend early (linear / cubic; H→rawquad), judged on whether the
//      out-of-frame tail shrinks WITHOUT hurting league OOT (the M6-era rejection predates
//      calibration-slope metrics — retested here with slope first-class).
//   C. MIX: the best per-channel A families combined (HR and BABIP need not share a family).
//
// JUDGING (two-axis + program standards): per-tier POW-quartile tables (the hr-reconcile cut) must
// FLATTEN; elite-band calibration slopes → ~1; league in-frame unchanged (identity for A; OOT both
// year-directions for B); composite ordering not degraded (paired bootstrap); ARCHETYPE RE-RUN as
// acceptance (cancellation RESOLVED, not moved); card-bootstrap CIs; held-out tier; weird-env check
// on the three confirmed daily/cap formats (earlygolddaily=early-gold era-1920/park-169,
// bronzeheartdaily=bronze-heart era-1939/park-191, goldcapdaily=gold-cap era-2010/park-156).
// diamondcapdaily EXCLUDED — no config.
//
// MEASUREMENT + DESIGN ONLY: fits nothing into the scoring path, changes no scoring, writes nothing.
// cwhit RAW OBSERVED events = ground truth; his projections are never used here.

import { readFileSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import {
  makeRawPolyModel, computeUnifiedFieldStats, applyWobaWeights, computeDerived, buildPoolTransform, calibrate,
  type EventForm, type RatingEnvelope, type WobaWeights,
} from "../src/scoring-core/index.ts";
import { parseCatalogCsv, type Card } from "../src/data/catalog.ts";
import { makeVariant } from "../src/data/variants.ts";
import { HIT_BIP_ADJ, rate, hRate, type FittedHit } from "../src/model/curves.ts";
import { loadWindow, type TrainObs } from "../src/training/loader.ts";
import { HITTER } from "../src/training/bakeoff.ts";
import { fitHitForm, RAWPOLY_HIT, type HitForm } from "../src/training/forms.ts";
import { parseCwhitHit } from "../src/eval/cwhit/parse.ts";
import { joinCwhit, type JoinCard, type JoinObs } from "../src/eval/cwhit/join.ts";
import type { WobaWeights as WW } from "../src/eval/cwhit/audit.ts";
import { HBP_PER_PA } from "../src/eval/cwhit/scorecard.ts";
import { mmse, meanEst } from "../src/eval/cwhit/two-ledger.ts";
import {
  buildCwhitSample, ourHit, wellSampled, handLetter, isPit, cardName, n_, FIELD_N, MIN_PA, QUICK,
  type Rec, type SampleDeps, type Exposure,
} from "../src/eval/cwhit/sample.ts";

const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const sgn = (x: number, d = 2) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}` : "n/a");
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const sd = (xs: number[]) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };

// ── deployed model + neutral env (IDENTICAL setup to tools/cwhit-mmse.ts) ─────────────────────────
const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state = (await repo.load<{ activeModelId?: string; catalogSourceId?: string }>("state", "app")) ?? {};
type TM = {
  id: string; window?: number[]; minPA?: number; includeVariants?: boolean;
  eventForm?: EventForm; wobaWeights?: WobaWeights; ratingEnvelope?: RatingEnvelope;
  platoon?: { pit: { hand: string; vsRHB: number; vsLHB: number }[]; hit: { hand: string; vsRHP: number; vsLHP: number }[] };
};
const trained = (await repo.loadAll<TM>("trained-models")).find((x) => x.id === state.activeModelId);
if (!trained?.eventForm || !trained.wobaWeights || !trained.platoon) throw new Error("active model missing eventForm/wobaWeights/platoon");
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
const pitExp: Exposure = new Map(trained.platoon.pit.map((p) => [p.hand, { wR: p.vsRHB, wL: p.vsLHB }]));
const hitExp: Exposure = new Map(trained.platoon.hit.map((p) => [p.hand, { wR: p.vsRHP, wL: p.vsLHP }]));
const envelope = trained.ratingEnvelope;

const makeDeps = (ef: EventForm): SampleDeps => {
  const m = makeRawPolyModel(ef);
  return {
    baseCards, coeffs, derived, eventForm: ef, model: m, W,
    ref: computeUnifiedFieldStats(baseCards, coeffs, m, FIELD_N, true), envelope, pitExp, hitExp,
  };
};
const deps0 = makeDeps(trained.eventForm);

// ── shared machinery (rating axes, wOBA reassembly, slopes, bands, bootstrap) ─────────────────────

/** Exposure-blended hitter rating (the same blend the predicted line uses) — hr-reconcile convention. */
const blendHit = (c: Card, base: string): number => {
  const { wR, wL } = hitExp.get(handLetter(n_(c["Bats"]))) ?? { wR: 0.5, wL: 0.5 };
  return wR * n_(c[`${base} vR`]) + wL * n_(c[`${base} vL`]);
};
const byTitle = new Map<string, Card>(baseCards.map((c) => [String(c["//Card Title"]), c]));
const cardFor = (title: string, vlvl: number): Card | null => {
  const b = byTitle.get(title);
  return b ? (vlvl === 5 ? makeVariant(b) : b) : null;
};

/** Hitter composite from channels + a per-card non-HR XBH share (mmse §4 convention — the EXACT
 *  inversion of sample.ts's raw assembly, so baseline reassembly == ours.woba to machine precision). */
function hitWobaFromCh(bbPct: number, soPct: number, hr600: number, babip: number, xbhShare: number): number {
  const BB = bbPct * 6, SO = soPct * 6, HR = hr600;
  const BIP = Math.max(600 - BB - SO - HR - HIT_BIP_ADJ, 1);
  const H = babip * BIP, GAP = xbhShare * H, oneB = H - GAP;
  return (W.bb * BB + W.hbp * 6 + W.b1 * oneB + W.xbh * GAP + W.hr * HR) / 600;
}
function hitXbhShare(ours: Record<string, number>): number {
  const BB = ours.bbPct! * 6, SO = ours.soPct! * 6, HR = ours.hr600!;
  const BIP = Math.max(600 - BB - SO - HR - HIT_BIP_ADJ, 1);
  const H = ours.babip! * BIP;
  if (!(H > 0)) return 0.30;
  const GAP = (600 * ours.woba! - W.bb * BB - W.hbp * 6 - W.hr * HR - W.b1 * H) / (W.xbh - W.b1);
  return Math.min(Math.max(GAP / H, 0), 1);
}
/** Fixed-share attribution assembly (archetype DRIVER decomposition only — cwhit-archetypes.ts
 *  convention: both sides go through the identical assembly, so deltas are channel-attributable). */
function attribWoba(bbPct: number, soPct: number, hr600: number, babip: number): number {
  const bb = bbPct / 100, k = soPct / 100, hr = hr600 / 600;
  const bip = Math.max(1 - bb - HBP_PER_PA - k - hr, 0);
  const nHH = babip * bip, xbh = 0.30 * nHH, oneB = nHH - xbh;
  return W.bb * bb + W.hbp * HBP_PER_PA + W.b1 * oneB + W.xbh * xbh + W.hr * hr;
}

/** OLS slope of obs on pred — THE calibration slope (noise-immune; two-ledger.ts header). */
function slopeOf(p: number[], o: number[]): number {
  const mp = mean(p), mo = mean(o);
  let sxx = 0, sxy = 0;
  for (let i = 0; i < p.length; i++) { sxx += (p[i]! - mp) ** 2; sxy += (p[i]! - mp) * (o[i]! - mo); }
  return sxx > 0 ? sxy / sxx : NaN;
}
const pearson = (p: number[], o: number[]): number => {
  const mp = mean(p), mo = mean(o);
  let cv = 0, vp = 0, vo = 0;
  for (let i = 0; i < p.length; i++) { cv += (p[i]! - mp) * (o[i]! - mo); vp += (p[i]! - mp) ** 2; vo += (o[i]! - mo) ** 2; }
  return vp > 0 && vo > 0 ? cv / Math.sqrt(vp * vo) : NaN;
};

interface PO { tier: string; pred: number; obs: number }
/** Tier fixed effects: de-mean pred and obs within tier (cwhit-mmse convention). */
function demean(rows: PO[]): { p: number[]; o: number[] } {
  const by = new Map<string, PO[]>();
  for (const r of rows) (by.get(r.tier) ?? by.set(r.tier, []).get(r.tier)!).push(r);
  const p: number[] = [], o: number[] = [];
  for (const g of by.values()) {
    const mp = mean(g.map((r) => r.pred)), mo = mean(g.map((r) => r.obs));
    for (const r of g) { p.push(r.pred - mp); o.push(r.obs - mo); }
  }
  return { p, o };
}
/** Band-wise slopes by predicted quartile (Q4 = elite = high end; hit HR/BABIP are dir=+1). */
function bands(p: number[], o: number[]): { q: number[]; top: number; rest: number; delta: number } {
  const idx = p.map((_, i) => i).sort((a, b) => p[a]! - p[b]!);
  const n = idx.length, q: number[] = [];
  for (let b = 0; b < 4; b++) {
    const cut = idx.slice(Math.floor((b * n) / 4), Math.floor(((b + 1) * n) / 4));
    q.push(slopeOf(cut.map((i) => p[i]!), cut.map((i) => o[i]!)));
  }
  const q4 = idx.slice(Math.floor((3 * n) / 4)), q13 = idx.slice(0, Math.floor((3 * n) / 4));
  const top = slopeOf(q4.map((i) => p[i]!), q4.map((i) => o[i]!));
  const rest = slopeOf(q13.map((i) => p[i]!), q13.map((i) => o[i]!));
  return { q, top, rest, delta: top - rest };
}
/** Deterministic RNG (mulberry32) — house bootstrap generator. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pct = (xs: number[], q: number) => { const v = [...xs].sort((a, b) => a - b); return v.length ? v[Math.min(Math.max(Math.floor(q * v.length), 0), v.length - 1)]! : NaN; };
interface CI { lo: number; hi: number }
/** Card bootstrap (within-tier resample, re-de-mean per replicate) of pooled slope + top-vs-rest Δ. */
function bootSlope(rows: PO[], B = 1000, seed = 20260716): { slope: CI; delta: CI; top: CI } {
  const by = new Map<string, PO[]>();
  for (const r of rows) (by.get(r.tier) ?? by.set(r.tier, []).get(r.tier)!).push(r);
  const rnd = rng(seed);
  const slopes: number[] = [], deltas: number[] = [], tops: number[] = [];
  for (let b = 0; b < B; b++) {
    const rs: PO[] = [];
    for (const g of by.values()) for (let i = 0; i < g.length; i++) rs.push(g[Math.floor(rnd() * g.length)]!);
    const { p, o } = demean(rs);
    const s = slopeOf(p, o);
    if (Number.isFinite(s)) slopes.push(s);
    const bd = bands(p, o);
    if (Number.isFinite(bd.delta)) deltas.push(bd.delta);
    if (Number.isFinite(bd.top)) tops.push(bd.top);
  }
  const ci = (xs: number[]): CI => (xs.length < 100 ? { lo: NaN, hi: NaN } : { lo: pct(xs, 0.025), hi: pct(xs, 0.975) });
  return { slope: ci(slopes), delta: ci(deltas), top: ci(tops) };
}

// ── the evaluation row: one judged hitter card under one candidate ────────────────────────────────
interface ERow {
  tier: string; key: string; pow: number; w: number;
  bb: number; so: number; hr: number; bab: number; share: number;   // predicted channels
  obsBb: number; obsSo: number; obsHr: number; obsBab: number; obsW: number;
  predW: number;                                                     // predicted composite (reassembled)
  ratings: Record<string, number>;                                   // blended archetype axes
}
function rowsFromRecs(recs: Rec[]): ERow[] {
  const out: ERow[] = [];
  for (const r of recs) {
    if (r.role !== "hit" || !wellSampled(r)) continue;
    const c = cardFor(r.title, r.vlvl); if (!c) continue;
    out.push({
      tier: r.tier, key: `${r.tier}|${r.title}|${r.vlvl}`, pow: blendHit(c, "Power"), w: r.sample,
      bb: r.ours.bbPct!, so: r.ours.soPct!, hr: r.ours.hr600!, bab: r.ours.babip!, share: hitXbhShare(r.ours),
      obsBb: r.obs.bbPct!, obsSo: r.obs.soPct!, obsHr: r.obs.hr600!, obsBab: r.obs.babip!, obsW: r.obs.woba!,
      predW: r.ours.woba!,
      ratings: { pow: blendHit(c, "Power"), eye: blendHit(c, "Eye"), babip: blendHit(c, "BABIP"), kRat: blendHit(c, "Avoid K") },
    });
  }
  return out;
}

// ── per-tier context for candidate A: pool moments + own-gap strength g = k − 1 ───────────────────
interface ChStat { m: number; s: number; p75: number; zLo: number }
interface TierCtx { gPow: number; gBab: number; hr: ChStat; bab: ChStat }
function chStat(xs: number[]): ChStat {
  const m = mean(xs), s = sd(xs) || 1;
  return { m, s, p75: pct(xs, 0.75), zLo: Math.min(...xs.map((x) => (x - m) / s)) };
}
function buildCtx(d: SampleDeps, pools: { tier: string; role: string; byChannel: Record<string, number[]> }[]): Map<string, TierCtx> {
  const out = new Map<string, TierCtx>();
  for (const { tier, cap } of QUICK) {
    const pd = pools.find((p) => p.tier === tier && p.role === "hit");
    if (!pd) continue;
    const basePool = d.baseCards.filter((c) => n_(c["Card Value"]) <= cap);
    const fs = computeUnifiedFieldStats(basePool, d.coeffs, d.model, FIELD_N, true);
    const g = (k: string) => Math.max((d.ref.hit.vR[k]!.mu / Math.max(fs.hit.vR[k]!.mu, 1e-9)) - 1, 0);
    out.set(tier, { gPow: g("pow"), gBab: g("babip"), hr: chStat(pd.byChannel.hr600!), bab: chStat(pd.byChannel.babip!) });
  }
  return out;
}

// ── candidate A: the correction — ONE definition, applied per channel ─────────────────────────────
type Family = "hinge" | "quad" | "pivot";
type WShape = "lin" | "sat";
const SAT_G0 = 0.10;
const wOf = (g: number, shape: WShape) => (shape === "lin" ? Math.max(g, 0) : 1 - Math.exp(-Math.max(g, 0) / SAT_G0));
/** Apply one correction family to a predicted channel value. `lw` = λ·w(g) (the tier's strength).
 *  hinge: slope 1+lw above the pool p75 — monotone for lw > −1.
 *  quad: convexity restore x + lw·s·(z²−1); the derivative 1+2·lw·z can only go negative on the
 *        pool's LEFT tail, so lw is clamped by |zLo| (the left edge), keeping ordering intact.
 *  pivot: pool-mean-preserving linear stretch (the kSpread class) — monotone for lw > −1. */
function correctCh(x: number, st: ChStat, lw: number, fam: Family): number {
  if (!(lw > 0)) return x;
  if (fam === "hinge") return x + lw * Math.max(x - st.p75, 0);
  if (fam === "pivot") return st.m + (1 + lw) * (x - st.m);
  const lwEff = Math.min(lw, 0.45 / Math.max(-st.zLo, 1e-9));
  const z = (x - st.m) / st.s;
  return x + lwEff * st.s * (z * z - 1);
}
interface ChCfg { fam: Family; shape: WShape; lam: number }
interface ACfg { hr: ChCfg; bab: ChCfg }
const OFF: ChCfg = { fam: "hinge", shape: "lin", lam: 0 };
/** Corrected copy of the rows under an A-configuration (composite reassembled through the ONE assembly). */
function applyA(rows: ERow[], ctx: Map<string, TierCtx>, cfg: ACfg): ERow[] {
  return rows.map((r) => {
    const c = ctx.get(r.tier);
    if (!c) return r;
    const hr = Math.max(correctCh(r.hr, c.hr, cfg.hr.lam * wOf(c.gPow, cfg.hr.shape), cfg.hr.fam), 0);
    const bab = Math.min(Math.max(correctCh(r.bab, c.bab, cfg.bab.lam * wOf(c.gBab, cfg.bab.shape), cfg.bab.fam), 0), 0.6);
    return { ...r, hr, bab, predW: hitWobaFromCh(r.bb, r.so, hr, bab, r.share) };
  });
}

// ── λ grid fit: minimize calibration-slope loss on the fitting tiers ──────────────────────────────
const chanPO = (rows: ERow[], ch: "hr" | "bab"): PO[] =>
  rows.map((r) => ({ tier: r.tier, pred: ch === "hr" ? r.hr : r.bab, obs: ch === "hr" ? r.obsHr : r.obsBab }));
function slopeLoss(rows: PO[]): number {
  const { p, o } = demean(rows);
  const s = slopeOf(p, o), bd = bands(p, o);
  return (s - 1) ** 2 + (Number.isFinite(bd.top) ? (bd.top - 1) ** 2 : 0) + (Number.isFinite(bd.rest) ? (bd.rest - 1) ** 2 : 0);
}
function fitLambda(rows: ERow[], ctx: Map<string, TierCtx>, fam: Family, shape: WShape, ch: "hr" | "bab", tiers?: Set<string>): { lam: number; loss: number } {
  const use = tiers ? rows.filter((r) => tiers.has(r.tier)) : rows;
  let best = 0, bestLoss = Infinity;
  for (let lam = 0; lam <= 6.0001; lam += 0.05) {
    const cc: ChCfg = { fam, shape, lam };
    const cfg: ACfg = ch === "hr" ? { hr: cc, bab: OFF } : { hr: OFF, bab: cc };
    const loss = slopeLoss(chanPO(applyA(use, ctx, cfg), ch));
    if (loss < bestLoss - 1e-12) { bestLoss = loss; best = lam; }
  }
  return { lam: best, loss: bestLoss };
}

// ── archetypes (cwhit-archetypes.ts definitions, hitter subset) + channel drivers ─────────────────
interface Q3 { p25: number; p50: number; p75: number }
function quantile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
}
const poolQ = new Map<string, Record<string, Q3>>();
for (const { tier, cap } of QUICK) {
  const pool = baseCards.filter((c) => n_(c["Card Value"]) <= cap && !isPit(c));
  const q: Record<string, Q3> = {};
  for (const [a, base] of [["pow", "Power"], ["eye", "Eye"], ["babip", "BABIP"], ["kRat", "Avoid K"]] as const) {
    const xs = pool.map((c) => blendHit(c, base)).filter(Number.isFinite).sort((x, y) => x - y);
    q[a] = { p25: quantile(xs, 0.25), p50: quantile(xs, 0.50), p75: quantile(xs, 0.75) };
  }
  poolQ.set(tier, q);
}
const ARCH: { id: string; label: string; test: (r: Record<string, number>, q: Record<string, Q3>) => boolean }[] = [
  { id: "elite-power", label: "Elite power (POW ≥ pool p75)", test: (r, q) => r.pow! >= q.pow!.p75 },
  { id: "walk-machine", label: "Walk machine (EYE ≥ p75)", test: (r, q) => r.eye! >= q.eye!.p75 },
  { id: "contact", label: "Contact (BABIP ≥ p75)", test: (r, q) => r.babip! >= q.babip!.p75 },
  { id: "whiff-slugger", label: "Whiff slugger (POW ≥ p75 & AvoidK ≤ p25)", test: (r, q) => r.pow! >= q.pow!.p75 && r.kRat! <= q.kRat!.p25 },
];
const membOf = (r: ERow): string[] => {
  const q = poolQ.get(r.tier)!;
  return ARCH.filter((a) => a.test(r.ratings, q)).map((a) => a.id);
};
interface ArchRow { n: number; est: number; lo: number; hi: number; sig: boolean; drvHr: number; drvBab: number }
/** Level-free archetype mis-valuation (mwOBA, + = over-valued) with a within-tier card bootstrap,
 *  plus the HR/BABIP channel-driver contributions (one-at-a-time substitution, tier-centered). */
function archTable(rows: ERow[]): Map<string, ArchRow> {
  const by = new Map<string, ERow[]>();
  for (const r of rows) (by.get(r.tier) ?? by.set(r.tier, []).get(r.tier)!).push(r);
  const memb = new Map(rows.map((r) => [r.key, membOf(r)]));
  const drv = new Map(rows.map((r) => {
    const base = attribWoba(r.obsBb, r.obsSo, r.obsHr, r.obsBab);
    return [r.key, {
      hr: attribWoba(r.obsBb, r.obsSo, r.hr, r.obsBab) - base,
      bab: attribWoba(r.obsBb, r.obsSo, r.obsHr, r.bab) - base,
    }];
  }));
  const point = (groups: Map<string, ERow[]>, get: (r: ERow) => number): Map<string, { n: number; mean: number }> => {
    const acc = new Map<string, number[]>();
    for (const g of groups.values()) {
      const c = mean(g.map(get));
      for (const r of g) for (const a of memb.get(r.key)!) (acc.get(a) ?? acc.set(a, []).get(a)!).push(1000 * (get(r) - c));
    }
    return new Map([...acc].map(([a, vs]) => [a, { n: vs.length, mean: mean(vs) }]));
  };
  const total = (r: ERow) => r.predW - r.obsW;
  const pt = point(by, total);
  const ptHr = point(by, (r) => drv.get(r.key)!.hr);
  const ptBab = point(by, (r) => drv.get(r.key)!.bab);
  const rnd = rng(20260716);
  const boots = new Map<string, number[]>(ARCH.map((a) => [a.id, []]));
  for (let b = 0; b < 1000; b++) {
    const rs = new Map<string, ERow[]>();
    for (const [t, g] of by) rs.set(t, g.map(() => g[Math.floor(rnd() * g.length)]!));
    const p = point(rs, total);
    for (const a of ARCH) { const v = p.get(a.id); if (v && v.n >= 2 && Number.isFinite(v.mean)) boots.get(a.id)!.push(v.mean); }
  }
  const out = new Map<string, ArchRow>();
  for (const a of ARCH) {
    const p = pt.get(a.id) ?? { n: 0, mean: NaN };
    const bs = boots.get(a.id)!;
    const lo = pct(bs, 0.025), hi = pct(bs, 0.975);
    out.set(a.id, {
      n: p.n, est: p.mean, lo, hi, sig: Number.isFinite(lo) && lo * hi > 0,
      drvHr: ptHr.get(a.id)?.mean ?? NaN, drvBab: ptBab.get(a.id)?.mean ?? NaN,
    });
  }
  return out;
}

// ── POW-quartile bias grid (the hr-reconcile cut) ─────────────────────────────────────────────────
const powCuts = new Map<string, [number, number, number]>();
for (const { tier, cap } of QUICK) {
  const xs = baseCards.filter((c) => n_(c["Card Value"]) <= cap && !isPit(c)).map((c) => blendHit(c, "Power")).filter(Number.isFinite).sort((a, b) => a - b);
  const at = (p: number) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))]!;
  powCuts.set(tier, [at(0.25), at(0.5), at(0.75)]);
}
const bucketOf = (x: number, c: [number, number, number]) => (x < c[0] ? 0 : x < c[1] ? 1 : x < c[2] ? 2 : 3);
const monoOf = (bs: number[]) => bs.length < 3 || bs.every((v, i) => i === 0 || v <= bs[i - 1]!) || bs.every((v, i) => i === 0 || v >= bs[i - 1]!);
function powGrid(rows: ERow[], ch: "hr" | "bab", label: string, d = 2, perTier = true) {
  console.log(`  ${label}: bias = pred − obs by POOL POW quartile (± card t 95% half-width (n))`);
  const pooledCells: number[][] = [[], [], [], []];
  for (const { tier } of QUICK) {
    const rs = rows.filter((r) => r.tier === tier);
    if (rs.length < 8) continue;
    const cuts = powCuts.get(tier)!;
    const cells: string[] = []; const biases: number[] = [];
    for (let b = 0; b < 4; b++) {
      const cell = rs.filter((r) => bucketOf(r.pow, cuts) === b).map((r) => (ch === "hr" ? r.hr - r.obsHr : r.bab - r.obsBab));
      if (!cell.length) { cells.push("—".padEnd(18)); continue; }
      pooledCells[b]!.push(...cell);
      const e = meanEst(cell);
      biases.push(e.est);
      cells.push(`${sgn(e.est, d)}${e.sig ? "*" : " "}±${f(Number.isFinite(e.se) ? (e.hi - e.lo) / 2 : NaN, d)}(${cell.length})`.padEnd(18));
    }
    if (perTier) console.log(`    ${tier.padEnd(8)} ${cells.join("")}${monoOf(biases) ? "" : "  NON-MONO"}`);
  }
  const all = pooledCells.map((cell) => (cell.length ? meanEst(cell) : null));
  console.log(`    ${"ALL".padEnd(8)} ${all.map((e) => (e ? `${sgn(e.est, d)}${e.sig ? "*" : " "}±${f((e.hi - e.lo) / 2, d)}(${e.n})` : "—").padEnd(18)).join("")}${monoOf(all.filter((e): e is NonNullable<typeof e> => !!e).map((e) => e.est)) ? "" : "  NON-MONO"}`);
}

// ── ordering (composite Pearson) + paired Δ bootstrap vs a baseline row-set ───────────────────────
function ordering(rows: ERow[]): number {
  const { p, o } = demean(rows.map((r) => ({ tier: r.tier, pred: r.predW, obs: r.obsW })));
  return pearson(p, o);
}
function orderingDelta(cand: ERow[], base: ERow[], B = 1000): { d: number; lo: number; hi: number } {
  const bBy = new Map(base.map((r) => [r.key, r]));
  const pairs = cand.filter((r) => bBy.has(r.key)).map((r) => ({ c: r, b: bBy.get(r.key)! }));
  const by = new Map<string, { c: ERow; b: ERow }[]>();
  for (const p of pairs) (by.get(p.c.tier) ?? by.set(p.c.tier, []).get(p.c.tier)!).push(p);
  const corrOf = (ps: { c: ERow; b: ERow }[], side: "c" | "b") => {
    const rows = ps.map((p) => ({ tier: p.c.tier, pred: p[side].predW, obs: p[side].obsW }));
    const { p: x, o } = demean(rows);
    return pearson(x, o);
  };
  const all = [...by.values()].flat();
  const d = corrOf(all, "c") - corrOf(all, "b");
  const rnd = rng(20260717);
  const ds: number[] = [];
  for (let b = 0; b < B; b++) {
    const rs: { c: ERow; b: ERow }[] = [];
    for (const g of by.values()) for (let i = 0; i < g.length; i++) rs.push(g[Math.floor(rnd() * g.length)]!);
    ds.push(corrOf(rs, "c") - corrOf(rs, "b"));
  }
  return { d, lo: pct(ds, 0.025), hi: pct(ds, 0.975) };
}

// ── one candidate's full summary ──────────────────────────────────────────────────────────────────
interface Summary {
  name: string;
  hrSlope: number; hrCI: CI; hrTop: number; hrTopCI: CI; hrDelta: number; hrDeltaCI: CI;
  babSlope: number; babCI: CI; babTop: number; babTopCI: CI; babDelta: number; babDeltaCI: CI;
  corr: number; dCorr: { d: number; lo: number; hi: number };
  arch: Map<string, ArchRow>;
}
function summarize(name: string, rows: ERow[], base: ERow[]): Summary {
  const hrPO = chanPO(rows, "hr"), babPO = chanPO(rows, "bab");
  const { p: hp, o: ho } = demean(hrPO); const { p: bp, o: bo } = demean(babPO);
  const hb = bands(hp, ho), bb = bands(bp, bo);
  const hBoot = bootSlope(hrPO), bBoot = bootSlope(babPO);
  return {
    name,
    hrSlope: slopeOf(hp, ho), hrCI: hBoot.slope, hrTop: hb.top, hrTopCI: hBoot.top, hrDelta: hb.delta, hrDeltaCI: hBoot.delta,
    babSlope: slopeOf(bp, bo), babCI: bBoot.slope, babTop: bb.top, babTopCI: bBoot.top, babDelta: bb.delta, babDeltaCI: bBoot.delta,
    corr: ordering(rows), dCorr: orderingDelta(rows, base),
    arch: archTable(rows),
  };
}
function printSummary(s: Summary) {
  console.log(`\n── ${s.name} ──`);
  console.log(`  HR600  pooled slope ${f(s.hrSlope)} [${f(s.hrCI.lo)},${f(s.hrCI.hi)}]   top-band ${f(s.hrTop)} [${f(s.hrTopCI.lo)},${f(s.hrTopCI.hi)}]   Δ(top−rest) ${sgn(s.hrDelta)} [${sgn(s.hrDeltaCI.lo)},${sgn(s.hrDeltaCI.hi)}]`);
  console.log(`  BABIP  pooled slope ${f(s.babSlope)} [${f(s.babCI.lo)},${f(s.babCI.hi)}]   top-band ${f(s.babTop)} [${f(s.babTopCI.lo)},${f(s.babTopCI.hi)}]   Δ(top−rest) ${sgn(s.babDelta)} [${sgn(s.babDeltaCI.lo)},${sgn(s.babDeltaCI.hi)}]`);
  console.log(`  ordering: pooled wOBA corr ${f(s.corr, 3)}   Δcorr vs baseline ${sgn(s.dCorr.d, 3)} [${sgn(s.dCorr.lo, 3)},${sgn(s.dCorr.hi, 3)}] ${s.dCorr.hi < 0 ? "*** ORDERING DEGRADED (CI-clear) ***" : "(not degraded)"}`);
  const a = (id: string) => { const v = s.arch.get(id)!; return `${sgn(v.est, 2)}${v.sig ? "*" : " "} [${sgn(v.lo, 2)},${sgn(v.hi, 2)}] (hr ${sgn(v.drvHr, 1)} bab ${sgn(v.drvBab, 1)}) n${v.n}`; };
  console.log(`  archetypes (level-free mwOBA, + = over-valued; drivers in mwOBA):`);
  console.log(`    elite-power   ${a("elite-power")}`);
  console.log(`    contact       ${a("contact")}`);
  console.log(`    whiff-slugger ${a("whiff-slugger")}`);
  console.log(`    walk-machine  ${a("walk-machine")}`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
console.log(`\n╔══════════════════════════════════════════════════════════════════════════════════════════════╗`);
console.log(`║  HITTER HR+BABIP PAIRED TAIL BAKE-OFF — gap-conditioned tail vs league form change vs mix     ║`);
console.log(`╚══════════════════════════════════════════════════════════════════════════════════════════════╝`);
console.log(`model '${trained.id}' | catalog '${srcId}' | RAW event line, own-gap ON, no anchor | hitters only (BUILD-1 owns pitchers)`);

const base = buildCwhitSample(deps0);
const rows0 = rowsFromRecs(base.recs);
const ctx0 = buildCtx(deps0, base.pools);

// reassembly self-check: the composite machinery must reproduce ours.woba exactly on the baseline.
{
  let maxDiff = 0;
  for (const r of rows0) maxDiff = Math.max(maxDiff, Math.abs(hitWobaFromCh(r.bb, r.so, r.hr, r.bab, r.share) - r.predW));
  console.log(`reassembly self-check: max |reassembled − ours.woba| = ${maxDiff.toExponential(2)} ⇒ ${maxDiff < 1e-9 ? "EXACT" : "*** DRIFT — composite verdicts unsafe ***"}`);
}
console.log(`judged hitters: ${rows0.length} well-sampled (PA≥${MIN_PA}) across ${new Set(rows0.map((r) => r.tier)).size} tiers`);
console.log(`\nown-gap strengths g = k−1 (pool-composition property; the A-candidates' conditioning variable):`);
console.log(`tier      g(POW)   g(BABIP)   w_sat(gPOW)  [w_sat = 1−e^(−g/${SAT_G0}) — the tier-flat shape]`);
for (const { tier } of QUICK) {
  const c = ctx0.get(tier);
  if (c) console.log(`${tier.padEnd(9)} ${f(c.gPow, 3).padStart(6)}   ${f(c.gBab, 3).padStart(6)}     ${f(wOf(c.gPow, "sat"), 3)}`);
}

// ═══ 1. CANDIDATE A — per-channel family × gap-shape sweep (λ fit once on all 5 Quick tiers) ═══════
console.log(`\n\n╔═══ 1. CANDIDATE A — family × gap-shape sweep per channel (grid λ on the slope loss) ═══╗`);
console.log(`loss = (pooled−1)² + (top-band−1)² + (rest-band−1)² on tier-demeaned pooled rows; slope targets only —`);
console.log(`archetypes/ordering are ACCEPTANCE axes (§3), never fit targets.`);
console.log(`\nchannel  family×shape    λ*      slope→   top→    rest→   loss`);
interface Combo { ch: "hr" | "bab"; fam: Family; shape: WShape; lam: number; loss: number }
const combos: Combo[] = [];
for (const ch of ["hr", "bab"] as const) {
  for (const fam of ["hinge", "quad", "pivot"] as Family[]) {
    for (const shape of ["lin", "sat"] as WShape[]) {
      const { lam, loss } = fitLambda(rows0, ctx0, fam, shape, ch);
      const cc: ChCfg = { fam, shape, lam };
      const rows = applyA(rows0, ctx0, ch === "hr" ? { hr: cc, bab: OFF } : { hr: OFF, bab: cc });
      const { p, o } = demean(chanPO(rows, ch));
      const bd = bands(p, o);
      combos.push({ ch, fam, shape, lam, loss });
      console.log(`${ch.padEnd(8)} ${`${fam}-${shape}`.padEnd(15)} ${f(lam).padStart(5)}   ${f(slopeOf(p, o)).padStart(6)}   ${f(bd.top).padStart(6)}  ${f(bd.rest).padStart(6)}  ${f(loss, 4)}`);
    }
  }
}
const bestBy = (ch: "hr" | "bab", n: number) => combos.filter((c) => c.ch === ch).sort((a, b) => a.loss - b.loss).slice(0, n);
const hrTop2 = bestBy("hr", 2), babTop2 = bestBy("bab", 2);
console.log(`\nper-channel finalists: HR → ${hrTop2.map((c) => `${c.fam}-${c.shape}`).join(", ")} | BABIP → ${babTop2.map((c) => `${c.fam}-${c.shape}`).join(", ")}`);

// ═══ 2. CANDIDATE B — league-refit HR/H form changes ═══════════════════════════════════════════════
console.log(`\n\n╔═══ 2. CANDIDATE B — form change, refit on LEAGUE data (window ${trained.window?.join("+")}) ═══╗`);
const minPA = Math.max(0, Number(trained.minPA ?? 1000) || 1000);
const includeVariants = trained.includeVariants ?? true;
const win: number[] = Array.isArray(trained.window) && trained.window.length ? trained.window : [2041, 2042];
const lgAll = loadWindow("League Files", win).observations.filter((o: TrainObs) => includeVariants || !o.variant);
const hitQual = lgAll.filter((o) => HITTER.qualifies(o, minPA));
console.log(`league hitters: ${hitQual.length} qualifying (PA≥${minPA}) in window ${win.join("+")}`);

// B0 sanity: refitting the DEPLOYED form through this pipeline must reproduce the artifact's curve.
{
  const refit = fitHitForm(RAWPOLY_HIT, hitQual);
  const dep = trained.eventForm.hit.hr;
  const maxB = Math.max(...refit.hr.beta.map((b, i) => Math.abs(b - (dep.beta[i] ?? NaN))));
  console.log(`B0 refit sanity: max |refit hr β − deployed hr β| = ${f(maxB, 6)} ${maxB < 1e-6 ? "(EXACT — the refit pipeline is the server's)" : "(*** differs — B comparisons are vs the REFIT baseline, stated here ***)"}`);
}

const LIN = { kind: "rawpoly", degree: 1 } as const;
const CUB = { kind: "rawpoly", degree: 3 } as const;
const Q2 = { kind: "rawpoly", degree: 2 } as const;
const bForms: { key: string; form: HitForm }[] = [
  { key: "B-hrlin", form: { ...RAWPOLY_HIT, name: "hrlin", hr: LIN } },
  { key: "B-hrcub", form: { ...RAWPOLY_HIT, name: "hrcub", hr: CUB } },
  { key: "B-h2", form: { ...RAWPOLY_HIT, name: "h2", h: Q2 } },
  { key: "B-hrcub-h2", form: { ...RAWPOLY_HIT, name: "hrcub-h2", hr: CUB, h: Q2 } },
];

// League OOT (both year-directions): per-channel calibration slope + composite corr — slope FIRST-CLASS.
function leagueChannels(m: FittedHit, o: TrainObs) {
  const r = o.ratings.hit;
  const bb = rate(m.bb, r.eye), so = rate(m.k, r.kRat), hr = rate(m.hr, r.pow);
  const bip = Math.max(600 - bb - so - hr - HIT_BIP_ADJ, 1);
  const h = hRate(m.h, r.babip, bip);
  const share = Math.min(Math.max(rate(m.xbh, r.gap), 0), 1);
  const xbh = share * h, oneB = h - xbh;
  return { hr, bab: h / bip, woba: (W.bb * bb + W.hbp * 6 + W.b1 * oneB + W.xbh * xbh + W.hr * hr) / 600 };
}
function leagueObs(o: TrainObs) {
  const s = 600 / Math.max(o.hit.PA, 1);
  const uBB = Math.max(o.hit.BB - o.hit.IBB, 0) * s, K = o.hit.K * s, HR = o.hit.HR * s;
  const H = (o.hit.H - o.hit.HR) * s, XBH = (o.hit.b2 + o.hit.b3) * s;
  const bip = Math.max(600 - uBB - K - HR - HIT_BIP_ADJ, 1);
  return { hr: HR, bab: H / bip, woba: (W.bb * uBB + W.hbp * 6 + W.b1 * (H - XBH) + W.xbh * XBH + W.hr * HR) / 600 };
}
console.log(`\nLEAGUE OOT (fit one year → test the other; slope(obs~pred) per channel, composite Pearson):`);
console.log(`form         dir        HRslope   BABslope   wOBAslope   wOBAcorr   HR-bias by POW qtile on test (pred−obs per 600)`);
const oowDirs: { fit: number[]; test: number[] }[] = win.length >= 2 ? [{ fit: [win[0]!], test: [win[1]!] }, { fit: [win[1]!], test: [win[0]!] }] : [];
for (const { key, form } of [{ key: "B0-quad(dep)", form: RAWPOLY_HIT }, ...bForms]) {
  for (const dir of oowDirs) {
    const fitObs = loadWindow("League Files", dir.fit).observations.filter((o: TrainObs) => includeVariants || !o.variant).filter((o) => HITTER.qualifies(o, minPA));
    const testObs = loadWindow("League Files", dir.test).observations.filter((o: TrainObs) => includeVariants || !o.variant).filter((o) => HITTER.qualifies(o, minPA));
    const m = fitHitForm(form, fitObs);
    const pred = testObs.map((o) => leagueChannels(m, o));
    const obs = testObs.map(leagueObs);
    const hrS = slopeOf(pred.map((p) => p.hr), obs.map((p) => p.hr));
    const babS = slopeOf(pred.map((p) => p.bab), obs.map((p) => p.bab));
    const wS = slopeOf(pred.map((p) => p.woba), obs.map((p) => p.woba));
    const wC = pearson(pred.map((p) => p.woba), obs.map((p) => p.woba));
    // in-frame POW-quartile HR bias on the test year (the insample-frame-check cut).
    const pows = testObs.map((o) => o.ratings.hit.pow);
    const sorted = [...pows].sort((a, b) => a - b);
    const cuts: [number, number, number] = [quantile(sorted, 0.25), quantile(sorted, 0.5), quantile(sorted, 0.75)];
    const qb: string[] = [];
    for (let b = 0; b < 4; b++) {
      const cell = testObs.map((_, i) => i).filter((i) => bucketOf(pows[i]!, cuts) === b).map((i) => pred[i]!.hr - obs[i]!.hr);
      qb.push(cell.length ? sgn(mean(cell), 2) : "—");
    }
    console.log(`${key.padEnd(12)} ${dir.fit.join("")}→${dir.test.join("")}   ${f(hrS, 3).padStart(6)}    ${f(babS, 3).padStart(6)}     ${f(wS, 3).padStart(6)}      ${f(wC, 3)}      [${qb.join(", ")}]`);
  }
}

// cwhit rebuild per B form (full pipeline: new model → new field stats → new pool transforms → new join).
console.log(`\ncwhit OUT-OF-FRAME rebuild per B form (full pipeline, both-years fit):`);
const bRows = new Map<string, ERow[]>();
for (const { key, form } of bForms) {
  const fitted = fitHitForm(form, hitQual);
  const ef2: EventForm = { hit: fitted, pit: trained.eventForm.pit };
  const deps2 = makeDeps(ef2);
  const sample2 = buildCwhitSample(deps2);
  const rows2 = rowsFromRecs(sample2.recs);
  bRows.set(key, rows2);
  const { p: hp, o: ho } = demean(chanPO(rows2, "hr"));
  const { p: bp, o: bo } = demean(chanPO(rows2, "bab"));
  const hb = bands(hp, ho), bb2 = bands(bp, bo);
  console.log(`${key.padEnd(12)} N=${rows2.length}   HRslope ${f(slopeOf(hp, ho))} top ${f(hb.top)}   BABslope ${f(slopeOf(bp, bo))} top ${f(bb2.top)}   wOBAcorr ${f(ordering(rows2), 3)}`);
}

// ═══ 3. FULL EVAL — baseline, per-channel A mixes, B forms (CIs, archetype acceptance) ═════════════
console.log(`\n\n╔═══ 3. FULL EVAL — baseline, A mixes (HR-family × BABIP-family), B forms ═══╗`);
printSummary(summarize("BASELINE (deployed)", rows0, rows0));
const summaries: { key: string; s: Summary; rows: ERow[]; cfg?: ACfg }[] = [];
const mixes: { key: string; cfg: ACfg }[] = [];
for (const h of hrTop2) for (const b of babTop2) {
  mixes.push({
    key: `A[hr:${h.fam}-${h.shape} + bab:${b.fam}-${b.shape}]`,
    cfg: { hr: { fam: h.fam, shape: h.shape, lam: h.lam }, bab: { fam: b.fam, shape: b.shape, lam: b.lam } },
  });
}
// the original both-hinge spec is kept in the lineup for the record even when not a per-channel finalist.
if (!mixes.some((m) => m.cfg.hr.fam === "hinge" && m.cfg.bab.fam === "hinge")) {
  const h = combos.find((c) => c.ch === "hr" && c.fam === "hinge" && c.shape === "lin")!;
  const b = combos.find((c) => c.ch === "bab" && c.fam === "hinge" && c.shape === "lin")!;
  mixes.push({ key: "A[both-hinge-lin]", cfg: { hr: { fam: "hinge", shape: "lin", lam: h.lam }, bab: { fam: "hinge", shape: "lin", lam: b.lam } } });
}
for (const m of mixes) {
  const rows = applyA(rows0, ctx0, m.cfg);
  const s = summarize(`${m.key}  (λHR ${f(m.cfg.hr.lam)}, λBAB ${f(m.cfg.bab.lam)})`, rows, rows0);
  summaries.push({ key: m.key, s, rows, cfg: m.cfg });
  printSummary(s);
}
for (const { key } of bForms) {
  const rows = bRows.get(key)!;
  const s = summarize(key, rows, rows0);
  summaries.push({ key, s, rows });
  printSummary(s);
}

// ═══ 4. WINNER SELECTION + POW-QUARTILE GRIDS (the hr-reconcile acceptance cut) ════════════════════
console.log(`\n\n╔═══ 4. WINNER + POW-QUARTILE GRIDS — does the non-monotone hump flatten? ═══╗`);
// gate score: slope gates (CI covers 1), tail gates (Δ CI covers 0), ordering not degraded,
// elite-power CI covers 0, contact improves vs baseline. Rank by gates passed, then slope distance.
const s0 = summarize("baseline", rows0, rows0);
function gates(s: Summary): { passed: number; total: number; notes: string[] } {
  const notes: string[] = [];
  const chk = (ok: boolean, label: string) => { if (!ok) notes.push(label); return ok ? 1 : 0; };
  let n = 0;
  n += chk(s.hrCI.lo <= 1 && s.hrCI.hi >= 1, "HR slope CI excludes 1");
  n += chk(s.babCI.lo <= 1 && s.babCI.hi >= 1, "BABIP slope CI excludes 1");
  n += chk(s.hrDeltaCI.lo <= 0 && s.hrDeltaCI.hi >= 0, "HR tail Δ CI excludes 0");
  n += chk(s.babDeltaCI.lo <= 0 && s.babDeltaCI.hi >= 0, "BABIP tail Δ CI excludes 0");
  n += chk(s.dCorr.hi >= 0, "ordering degraded CI-clear");
  const ep = s.arch.get("elite-power")!, ct = s.arch.get("contact")!, ct0 = s0.arch.get("contact")!;
  n += chk(!ep.sig, "elite-power mis-valued CI-clear");
  n += chk(Math.abs(ct.est) < Math.abs(ct0.est) || !ct.sig, "contact did not improve");
  return { passed: n, total: 7, notes };
}
console.log(`\ngate scoreboard (7 gates: HR/BAB slope CIs cover 1, HR/BAB tail Δ CIs cover 0, ordering intact,`);
console.log(`elite-power CI covers 0, contact improves):`);
for (const { key, s } of summaries) {
  const g = gates(s);
  console.log(`  ${key.padEnd(38)} ${g.passed}/${g.total}${g.notes.length ? `   FAILS: ${g.notes.join("; ")}` : "   ALL GATES PASS"}`);
}
const ranked = [...summaries].sort((a, b) => {
  const ga = gates(a.s), gb = gates(b.s);
  if (gb.passed !== ga.passed) return gb.passed - ga.passed;
  const da = Math.abs(a.s.hrSlope - 1) + Math.abs(a.s.babSlope - 1) + Math.abs(a.s.hrTop - 1) + Math.abs(a.s.babTop - 1);
  const db = Math.abs(b.s.hrSlope - 1) + Math.abs(b.s.babSlope - 1) + Math.abs(b.s.hrTop - 1) + Math.abs(b.s.babTop - 1);
  return da - db;
});
const winner = ranked[0]!;
console.log(`\nWINNER (most gates, then slope distance): ${winner.key}`);
console.log(`\nBASELINE:`);
powGrid(rows0, "hr", "HR600");
powGrid(rows0, "bab", "BABIP", 3);
console.log(`\n${winner.key}:`);
powGrid(winner.rows, "hr", "HR600");
powGrid(winner.rows, "bab", "BABIP", 3);
const runnerUp = ranked[1];
if (runnerUp) {
  console.log(`\nrunner-up ${runnerUp.key} (pooled row only):`);
  powGrid(runnerUp.rows, "hr", "HR600", 2, false);
  powGrid(runnerUp.rows, "bab", "BABIP", 3, false);
}

// ═══ 5. HELD-OUT TIER — the winning A mix generalizes across tiers? ════════════════════════════════
if (winner.cfg) {
  console.log(`\n\n╔═══ 5. HELD-OUT-TIER OOT — ${winner.key}: λ refit on 4 tiers, judged on the 5th ═══╗`);
  console.log(`tier(out)   λHR    λBAB    HR slope base→held   HRtop base→held    BAB slope base→held   BABtop base→held`);
  for (const { tier } of QUICK) {
    const others = new Set(QUICK.map((q) => q.tier).filter((t) => t !== tier));
    const lamHr = fitLambda(rows0, ctx0, winner.cfg.hr.fam, winner.cfg.hr.shape, "hr", others).lam;
    const lamBab = fitLambda(rows0, ctx0, winner.cfg.bab.fam, winner.cfg.bab.shape, "bab", others).lam;
    const held0 = rows0.filter((r) => r.tier === tier);
    if (held0.length < 10) { console.log(`${tier.padEnd(11)} (N=${held0.length} — too thin to judge)`); continue; }
    const held = applyA(held0, ctx0, { hr: { ...winner.cfg.hr, lam: lamHr }, bab: { ...winner.cfg.bab, lam: lamBab } });
    const sl = (rs: ERow[], ch: "hr" | "bab") => mmse(rs.map((r) => (ch === "hr" ? r.hr : r.bab)), rs.map((r) => (ch === "hr" ? r.obsHr : r.obsBab))).slope.est;
    const tp = (rs: ERow[], ch: "hr" | "bab") => bands(rs.map((r) => (ch === "hr" ? r.hr : r.bab)), rs.map((r) => (ch === "hr" ? r.obsHr : r.obsBab))).top;
    console.log(`${tier.padEnd(11)} ${f(lamHr).padStart(4)}   ${f(lamBab).padStart(4)}     ${f(sl(held0, "hr"))} → ${f(sl(held, "hr"))}         ${f(tp(held0, "hr"))} → ${f(tp(held, "hr"))}        ${f(sl(held0, "bab"))} → ${f(sl(held, "bab"))}         ${f(tp(held0, "bab"))} → ${f(tp(held, "bab"))}`);
  }
}

// ═══ 6. LEAGUE IDENTITY (A) ═══════════════════════════════════════════════════════════════════════
console.log(`\n\n╔═══ 6. LEAGUE IDENTITY — candidate A at gap→0 ═══╗`);
{
  const fsFull = computeUnifiedFieldStats(baseCards, coeffs, rp, FIELD_N, true);
  const kPow = deps0.ref.hit.vR.pow!.mu / fsFull.hit.vR.pow!.mu;
  const kBab = deps0.ref.hit.vR.babip!.mu / fsFull.hit.vR.babip!.mu;
  console.log(`full-catalog pool vs reference: k(POW) = ${f(kPow, 6)}, k(BABIP) = ${f(kBab, 6)} ⇒ g = ${f(Math.max(kPow - 1, 0), 6)}/${f(Math.max(kBab - 1, 0), 6)}`);
  console.log(`w(0) = 0 for both shapes ⇒ the correction is EXACTLY the identity in the league frame — no league`);
  console.log(`refit, no league OOT risk, by construction. (The scoring-path wiring must keep this property: the`);
  console.log(`strength derives from the SAME pool-transform k the own-gap lift uses; league/unrestricted ⇒ k≤1 ⇒ off.)`);
}

// ═══ 7. WEIRD-ENV CHECK — the three confirmed daily/cap formats ═══════════════════════════════════
console.log(`\n\n╔═══ 7. WEIRD-ENV CHECK — earlygolddaily / bronzeheartdaily / goldcapdaily (directional) ═══╗`);
console.log(`Per-format: DEPLOYED env-adjusted line (era/park applied via the scoring core), observed = cwhit daily`);
console.log(`fixture. A-correction applied on the RAW line and carried into the env line by the card's own env`);
console.log(`multiplier (stated approximation). Verdict: does the GLOBAL λ (fit on Quicks only) move the tail the`);
console.log(`RIGHT way in a non-neutral env, and does nothing blow up. One-format-deep — directional, never a fit.`);
const wCfg: ACfg | null = winner.cfg ?? null;
interface DRow { pow: number; hr: number; obsHr: number; bab: number; obsBab: number; rawHr: number; rawBab: number; pa: number }
const FMTS = [
  { key: "earlygolddaily", tid: "early-gold" },
  { key: "bronzeheartdaily", tid: "bronze-heart" },
  { key: "goldcapdaily", tid: "gold-cap" },
];
for (const { key, tid } of FMTS) {
  const t = tournaments.find((x) => x.id === tid);
  if (!t) { console.log(`\n  ${key}: tournament config '${tid}' not found — skipped`); continue; }
  const cap = t.card_value_max ?? Infinity;
  const cf = resolveCoeffs(model, eras.get(t.eraId)!, parks.get(t.parkId)!, t.softcaps);
  applyWobaWeights(cf, trained.wobaWeights);
  const dv = computeDerived(cf);
  const refF = computeUnifiedFieldStats(baseCards, cf, rp, FIELD_N, true);
  const depsF: SampleDeps = { baseCards, coeffs: cf, derived: dv, eventForm: trained.eventForm, model: rp, W, ref: refF, envelope, pitExp, hitExp };
  const basePool = baseCards.filter((c) => n_(c["Card Value"]) <= cap);
  const fsF = computeUnifiedFieldStats(basePool, cf, rp, FIELD_N, true);
  const pt = buildPoolTransform(refF, fsF, envelope);
  const cal = calibrate(basePool, { coeffs: cf, derived: dv, eventForm: trained.eventForm, poolTransform: pt });
  const gPow = Math.max(refF.hit.vR.pow!.mu / Math.max(fsF.hit.vR.pow!.mu, 1e-9) - 1, 0);
  const gBab = Math.max(refF.hit.vR.babip!.mu / Math.max(fsF.hit.vR.babip!.mu, 1e-9) - 1, 0);
  // pool predicted-channel moments (RAW line) + join candidates, mirroring sample.ts's hit branch.
  const cards: JoinCard[] = [];
  const lineBy = new Map<string, { raw: Record<string, number>; dep: Record<string, number>; pow: number }>();
  const poolHr: number[] = [], poolBab: number[] = [];
  for (const bc of baseCards) {
    for (const [vlvl, c] of [[0, bc], [5, makeVariant(bc)]] as const) {
      if (n_(c["Card Value"]) > cap || isPit(c)) continue;
      const p = ourHit(c, pt, depsF, cal);
      const cid = `${bc["Card ID"]}|${vlvl}`;
      cards.push({ cid, name: cardName(c), val: n_(c["Card Value"]), vlvl, hand: handLetter(n_(c["Bats"])), primary: [p.dep.babip!], validate: [p.dep.bbPct!, p.dep.soPct!, p.dep.hr600!] });
      lineBy.set(cid, { raw: p.raw, dep: p.dep, pow: blendHit(c, "Power") });
      if (vlvl === 0) { poolHr.push(p.raw.hr600!); poolBab.push(p.raw.babip!); }
    }
  }
  const stHr = chStat(poolHr), stBab = chStat(poolBab);
  const { rows: obsRows } = parseCwhitHit(readFileSync(`fixtures/cwhit/cwhit-${key}-hit.tsv`, "utf8"));
  const obs: JoinObs<typeof obsRows[0]>[] = obsRows.map((r) => ({ name: r.name, val: r.val, vlvl: r.vlvl, hand: r.hand, primary: [r.babip], validate: [r.bbPct, r.soPct, r.hr600], sample: r.pa, row: r }));
  const j = joinCwhit(obs, cards);
  const powXs = basePool.filter((c) => !isPit(c)).map((c) => blendHit(c, "Power")).filter(Number.isFinite).sort((a, b) => a - b);
  const at = (p: number) => powXs[Math.min(powXs.length - 1, Math.floor(p * powXs.length))]!;
  const cuts: [number, number, number] = [at(0.25), at(0.5), at(0.75)];
  const drows: DRow[] = [];
  for (const m of j.matched) {
    if (m.obs.sample < MIN_PA) continue;
    const L = lineBy.get(m.card.cid)!;
    drows.push({ pow: L.pow, hr: L.dep.hr600!, rawHr: L.raw.hr600!, bab: L.dep.babip!, rawBab: L.raw.babip!, obsHr: m.obs.row.hr600, obsBab: m.obs.row.babip, pa: m.obs.sample });
  }
  console.log(`\n─── ${key} (era ${t.eraId} / park ${t.parkId}${t.total_cap ? ` / cap ${t.total_cap}` : ""}) — N=${drows.length} joined well-sampled; g(POW)=${f(gPow, 3)} g(BABIP)=${f(gBab, 3)} ───`);
  if (drows.length < 12 || !wCfg) { console.log(`  ${wCfg ? "too thin — no read" : "winner is not an A mix — §7 applies to A only"}`); continue; }
  const applyD = (r: DRow) => {
    const eHr = r.rawHr > 1e-9 ? r.hr / r.rawHr : 1, eBab = r.rawBab > 1e-9 ? r.bab / r.rawBab : 1;
    const hr2 = Math.max(correctCh(r.rawHr, stHr, wCfg.hr.lam * wOf(gPow, wCfg.hr.shape), wCfg.hr.fam), 0);
    const bab2 = Math.min(Math.max(correctCh(r.rawBab, stBab, wCfg.bab.lam * wOf(gBab, wCfg.bab.shape), wCfg.bab.fam), 0), 0.6);
    return { hr: r.hr + (hr2 - r.rawHr) * eHr, bab: r.bab + (bab2 - r.rawBab) * eBab };
  };
  const gridD = (label: string, hrOf: (r: DRow) => number, babOf: (r: DRow) => number) => {
    const cellsH: string[] = [], cellsB: string[] = [];
    for (let b = 0; b < 4; b++) {
      const cell = drows.filter((r) => bucketOf(r.pow, cuts) === b);
      if (!cell.length) { cellsH.push("—".padEnd(15)); cellsB.push("—".padEnd(15)); continue; }
      const eh = meanEst(cell.map((r) => hrOf(r) - r.obsHr));
      const eb = meanEst(cell.map((r) => babOf(r) - r.obsBab));
      cellsH.push(`${sgn(eh.est, 2)}${eh.sig ? "*" : " "}(${cell.length})`.padEnd(15));
      cellsB.push(`${sgn(eb.est, 3)}${eb.sig ? "*" : " "}(${cell.length})`.padEnd(15));
    }
    const sh = slopeOf(drows.map(hrOf), drows.map((r) => r.obsHr));
    const sb = slopeOf(drows.map(babOf), drows.map((r) => r.obsBab));
    console.log(`  ${label.padEnd(24)} HR: ${cellsH.join("")} slope ${f(sh)}   BABIP: ${cellsB.join("")} slope ${f(sb)}`);
  };
  gridD("baseline (deployed env)", (r) => r.hr, (r) => r.bab);
  gridD("winner (global λ)", (r) => applyD(r).hr, (r) => applyD(r).bab);
}

// ═══ 8. FINAL COMPARISON ═══════════════════════════════════════════════════════════════════════════
console.log(`\n\n╔═══ 8. FINAL COMPARISON — all candidates on the acceptance axes ═══╗`);
console.log(`candidate                                HRslope[CI]         HRtopΔ[CI]            BABslope[CI]        ordΔcorr[CI]             elite-pwr   contact`);
const rowOf = (k: string, s: Summary) => {
  const ep = s.arch.get("elite-power")!, ct = s.arch.get("contact")!;
  return `${k.padEnd(40)} ${f(s.hrSlope)} [${f(s.hrCI.lo)},${f(s.hrCI.hi)}]   ${sgn(s.hrDelta)} [${sgn(s.hrDeltaCI.lo)},${sgn(s.hrDeltaCI.hi)}]   ${f(s.babSlope)} [${f(s.babCI.lo)},${f(s.babCI.hi)}]   ${sgn(s.dCorr.d, 3)} [${sgn(s.dCorr.lo, 3)},${sgn(s.dCorr.hi, 3)}]   ${sgn(ep.est, 1)}${ep.sig ? "*" : " "}       ${sgn(ct.est, 1)}${ct.sig ? "*" : " "}`;
};
console.log(rowOf("baseline", s0));
for (const { key, s } of summaries) console.log(rowOf(key, s));
console.log(`\nGATES: HR/BAB pooled slope CI covers 1 · top-band Δ CI covers 0 · Δcorr CI covers 0 (ordering intact) ·`);
console.log(`elite-power CI covers 0 with drivers each near 0 (cancellation RESOLVED, not moved) · contact shrinks`);
console.log(`vs baseline −1.84* · held-out tier holds (§5) · league identity (§6, A) or league OOT clean (§2, B) ·`);
console.log(`weird-env directionally right (§7).`);
process.exit(0);
