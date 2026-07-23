// C6 — THE RE-DERIVED HITTER-TAIL CORRECTION (HR600 / BABIP / SO%). Fit · gates · band re-check.
//   run: node tools/hit-tail-c6.ts > fixtures/cwhit-hittail-c6-2026-07-22.txt
//
// SPECIFICATION: docs/CWHIT_HITTAIL_REFIT_PREREG_2026-07-22.md + AMENDMENT 1 (approved). Everything
// below — the three channels, the estimand, the selection rule, the COHERENT-SET RULE, the gates, the
// acceptance bar — is pre-registered there. Nothing here is tuned; a failing gate is reported, never
// tuned past. This tool wires NOTHING: it changes no src/ file, no default, no shipped constant.
//
// ── WHAT THIS IS, AND HOW IT RELATES TO THE BAKE-OFF ────────────────────────────────────────────
// This tool is tools/hit-tail-bakeoff.ts re-fitted on the CURRENT (post-C1/C2') coordinate, with the
// selection machinery of tools/fit-hrspread-c6.ts (deliverable-space equivalence + minimax centre,
// the monotone-feasibility coherent set, (w)2'/(w)3, band re-check). The correction math is the
// PRODUCTION copy src/scoring-core/hit-tail.ts (correctChannel/hitTailW) — imported, never
// re-implemented. Three channels, each a family × gap-shape with a strength λ gap-conditioned by
// g = k − 1 (the own-gap mean-scalar), fit ONCE (universal), never per-tournament.
//
// ── THE CLAUSE-4 AUDIT, IN CODE (prereg §1) ──────────────────────────────────────────────────────
//   A. THE ESTIMAND was ALREADY CORRECT. The bake-off's slope loss calls `demean`, which de-means
//      pred AND obs PER TIER before the slope — that IS ruling (z)'s free-slope-with-per-tier-level.
//      A single tier's OLS slope (slopeOf) already centres on that tier's means. Prereg §1.A was
//      over-cautious; the level/spread conflation it feared is not present because the per-tier
//      free level is baked into the demeaning. THE FIX THAT MATTERS IS THE INSTRUMENT (B).
//   B. THE INSTRUMENT (the real stale-coordinate defect). The bake-off built fields with
//      computeUnifiedFieldStats(pool, …, FIELD_N, true) — variant-free, unscaled FIELD_N, the
//      phantom pre-C2' coordinate. THIS TOOL builds every field with productionFieldStats (the
//      presence mixture at FIELD_N·PRESENCE_M) at BOTH sites (the neutral `ref` and the per-tier
//      pool `fs`), so g = k−1 and every pool moment (p50/p75/sd) sit on production's coordinate.
//   C. THE FAMILY is re-selected by the bake-off on THIS coordinate (do NOT inherit PINNED_HIT_TAIL).
//   D. SELECTION is deliverable-space equivalence per channel (ruling (x)), minimax-centre λ, set
//      published — replacing the pure argmin-λ.
//   E. FORMAT REACH resolves held-out/applied formats from the corpus REGISTRY by tournamentId.
//
// cwhit RAW OBSERVED events = ground truth; his projections are never used here. HITTERS ONLY —
// pitcher lines are bit-identical by construction (the correction never touches them); the final C6
// checks pitcher bit-identity, not this tool.

import { readFileSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import {
  makeRawPolyModel, productionFieldStats, applyWobaWeights, computeDerived,
  type EventForm, type RatingEnvelope, type WobaWeights, type FieldStats,
} from "../src/scoring-core/index.ts";
import { parseCatalogCsv, type Card } from "../src/data/catalog.ts";
import { makeVariant, PRESENCE_P } from "../src/data/variants.ts";
import { HIT_BIP_ADJ } from "../src/model/curves.ts";
import { rowEligible } from "../src/config/eligibility.ts";
import { CWHIT_CORPUS } from "../src/eval/cwhit/corpus.ts";
import type { WobaWeights as WW } from "../src/eval/cwhit/audit.ts";
import { HBP_PER_PA } from "../src/eval/cwhit/scorecard.ts";
import {
  buildCwhitSample, wellSampled, handLetter, isPit, cardName, n_, FIELD_N, MIN_PA, QUICK, inValueWindow,
  type Rec, type SampleDeps, type Exposure, type ValueWindow, type PoolDist,
} from "../src/eval/cwhit/sample.ts";
import {
  correctChannel, hitTailW, HIT_TAIL_SAT_G0,
  type HitTailFamily, type HitTailShape, type HitTailChanStat,
} from "../src/scoring-core/hit-tail.ts";

// ── output buffer: the VERDICT banner must be line 1 and is only known at the end ──────────────────
const L: string[] = [];
const say = (s = "") => L.push(s);
const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const sgn = (x: number, d = 2) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}` : "n/a");
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const sd = (xs: number[]) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };
const pad = (s: string, n: number) => s.padEnd(n);
const rpad = (s: string, n: number) => s.padStart(n);

// bootstrap sizes: the need CIs that drive every GATE are the full B=2000; the λ-re-selection CIs
// (reported precision + (w)3's deliverable band) use B=300 (each replicate is a 2×121-point grid).
const B_NEED = 2000, B_ACC = 2000, B_SEL = 300, SEED = 20260716;
const THIN_N = 15;

// ═══════════════════════════════════════════════════════════════════════════════
// 0. SETUP — deployed model, neutral Quick env. Composition copied from tools/hit-tail-bakeoff.ts.
// ═══════════════════════════════════════════════════════════════════════════════
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
const EVENT_FORM: EventForm = trained.eventForm;
const rp = makeRawPolyModel(EVENT_FORM);
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

// INSTRUMENT CHANGE (audit B): the neutral reference field is now productionFieldStats (presence
// mixture), NOT computeUnifiedFieldStats(FIELD_N). p is threaded so the band re-check cannot fork it.
const makeDeps = (ef: EventForm, p: number): SampleDeps => {
  const m = makeRawPolyModel(ef);
  return {
    baseCards, coeffs, derived, eventForm: ef, model: m, W,
    ref: productionFieldStats(baseCards, coeffs, m, true, p), envelope, pitExp, hitExp, presenceP: p,
  };
};

// ── shared machinery (rating axes, wOBA reassembly, slopes, bands, bootstrap) — from the bake-off ──
const blendHit = (c: Card, base: string): number => {
  const { wR, wL } = hitExp.get(handLetter(n_(c["Bats"]))) ?? { wR: 0.5, wL: 0.5 };
  return wR * n_(c[`${base} vR`]) + wL * n_(c[`${base} vL`]);
};
const byTitle = new Map<string, Card>(baseCards.map((c) => [String(c["//Card Title"]), c]));
const cardFor = (title: string, vlvl: number): Card | null => {
  const b = byTitle.get(title);
  return b ? (vlvl === 5 ? makeVariant(b) : b) : null;
};
/** Hitter composite from channels + per-card non-HR XBH share — the EXACT inversion of sample.ts. */
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
/** Fixed-share attribution assembly — archetype DRIVER decomposition (channel-attributable deltas). */
function attribWoba(bbPct: number, soPct: number, hr600: number, babip: number): number {
  const bb = bbPct / 100, k = soPct / 100, hr = hr600 / 600;
  const bip = Math.max(1 - bb - HBP_PER_PA - k - hr, 0);
  const nHH = babip * bip, xbh = 0.30 * nHH, oneB = nHH - xbh;
  return W.bb * bb + W.hbp * HBP_PER_PA + W.b1 * oneB + W.xbh * xbh + W.hr * hr;
}

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
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pct = (xs: number[], q: number) => { const v = [...xs].sort((a, b) => a - b); return v.length ? v[Math.min(Math.max(Math.floor(q * v.length), 0), v.length - 1)]! : NaN; };
interface CI { lo: number; hi: number }
const ci = (xs: number[]): CI => (xs.length < 50 ? { lo: NaN, hi: NaN } : { lo: pct(xs, 0.025), hi: pct(xs, 0.975) });
/** Band-wise top/rest slopes by predicted quartile — the bake-off's slope-loss band term. */
function bands(p: number[], o: number[]): { top: number; rest: number } {
  const idx = p.map((_, i) => i).sort((a, b) => p[a]! - p[b]!);
  const n = idx.length;
  const q4 = idx.slice(Math.floor((3 * n) / 4)), q13 = idx.slice(0, Math.floor((3 * n) / 4));
  return { top: slopeOf(q4.map((i) => p[i]!), q4.map((i) => o[i]!)), rest: slopeOf(q13.map((i) => p[i]!), q13.map((i) => o[i]!)) };
}

// ── the evaluation row: one judged hitter card ────────────────────────────────────────────────────
interface ERow {
  tier: string; key: string; pow: number;
  bb: number; so: number; hr: number; bab: number; share: number;
  obsBb: number; obsSo: number; obsHr: number; obsBab: number; obsW: number;
  predW: number; ratings: Record<string, number>;
}
function rowsFromRecs(recs: Rec[]): ERow[] {
  const out: ERow[] = [];
  for (const r of recs) {
    if (r.role !== "hit" || !wellSampled(r)) continue;
    const c = cardFor(r.title, r.vlvl); if (!c) continue;
    out.push({
      tier: r.tier, key: `${r.tier}|${r.title}|${r.vlvl}`, pow: blendHit(c, "Power"),
      bb: r.ours.bbPct!, so: r.ours.soPct!, hr: r.ours.hr600!, bab: r.ours.babip!, share: hitXbhShare(r.ours),
      obsBb: r.obs.bbPct!, obsSo: r.obs.soPct!, obsHr: r.obs.hr600!, obsBab: r.obs.babip!, obsW: r.obs.woba!,
      predW: r.ours.woba!,
      ratings: { pow: blendHit(c, "Power"), eye: blendHit(c, "Eye"), babip: blendHit(c, "BABIP"), kRat: blendHit(c, "Avoid K") },
    });
  }
  return out;
}

// ── per-tier context: pool moments (production coordinate) + own-gap strength g = k − 1 per channel ─
type ChStat = HitTailChanStat;
type Chan = "hr" | "bab" | "so";
const CHANS: Chan[] = ["hr", "bab", "so"];
const CHLAB: Record<Chan, string> = { hr: "HR600", bab: "BABIP", so: "SO%" };
const CHGAP: Record<Chan, "pow" | "babip" | "kRat"> = { hr: "pow", bab: "babip", so: "kRat" };
interface TierCtx { gPow: number; gBab: number; gK: number; hr: ChStat; bab: ChStat; so: ChStat }
function chStat(xs: number[]): ChStat {
  const m = mean(xs), s = sd(xs) || 1;
  return { m, s, p50: pct(xs, 0.50), p75: pct(xs, 0.75), zLo: Math.min(...xs.map((x) => (x - m) / s)) };
}
const gapOfChan = (c: TierCtx, ch: Chan): number => (ch === "hr" ? c.gPow : ch === "bab" ? c.gBab : c.gK);
const statOfChan = (c: TierCtx, ch: Chan): ChStat => (ch === "hr" ? c.hr : ch === "bab" ? c.bab : c.so);
// INSTRUMENT CHANGE (audit B): the per-tier pool field is productionFieldStats(basePool), NOT
// computeUnifiedFieldStats(FIELD_N). g = ref.μ / poolField.μ − 1 on production's coordinate.
function buildCtx(d: SampleDeps, pools: PoolDist[], p: number): Map<string, TierCtx> {
  const out = new Map<string, TierCtx>();
  for (const win of QUICK) {
    const { tier } = win;
    const pd = pools.find((x) => x.tier === tier && x.role === "hit");
    if (!pd) continue;
    const basePool = d.baseCards.filter((c) => inValueWindow(c, win));
    const fs = productionFieldStats(basePool, d.coeffs, d.model, true, p);
    const g = (k: string) => Math.max((d.ref.hit.vR[k]!.mu / Math.max(fs.hit.vR[k]!.mu, 1e-9)) - 1, 0);
    out.set(tier, {
      gPow: g("pow"), gBab: g("babip"), gK: g("kRat"),
      hr: chStat(pd.byChannel.hr600!), bab: chStat(pd.byChannel.babip!), so: chStat(pd.byChannel.soPct!),
    });
  }
  return out;
}

// ── the correction (PRODUCTION copy), applied per channel with per-channel clamps (applyHitTail) ───
const wOf = hitTailW;
function corrCh(ch: Chan, x: number, st: ChStat, lw: number, fam: HitTailFamily): number {
  const v = correctChannel(x, st, lw, fam);
  return ch === "bab" ? Math.min(Math.max(v, 0), 0.6) : Math.max(v, 0);
}
// ── the composite correction (all three channels) for the elite-power paired gate — mirrors applyA ─
type ChCfg = { fam: HitTailFamily; shape: HitTailShape; lam: number };
type ACfg = { hr: ChCfg; bab: ChCfg; so: ChCfg };
function applyA(rows: ERow[], ctx: Map<string, TierCtx>, cfg: ACfg): ERow[] {
  return rows.map((r) => {
    const c = ctx.get(r.tier);
    if (!c) return r;
    const hr = Math.max(correctChannel(r.hr, c.hr, cfg.hr.lam * wOf(c.gPow, cfg.hr.shape), cfg.hr.fam), 0);
    const bab = Math.min(Math.max(correctChannel(r.bab, c.bab, cfg.bab.lam * wOf(c.gBab, cfg.bab.shape), cfg.bab.fam), 0), 0.6);
    const so = Math.max(correctChannel(r.so, c.so, cfg.so.lam * wOf(c.gK, cfg.so.shape), cfg.so.fam), 0);
    return { ...r, hr, bab, so, predW: hitWobaFromCh(r.bb, so, hr, bab, r.share) };
  });
}

// ── elite-power archetype: level-free mwOBA mis-valuation + within-tier card bootstrap ─────────────
interface Q3 { p75: number }
function quantile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
}
const poolQ = new Map<string, Q3>();
for (const win of QUICK) {
  const xs = baseCards.filter((c) => inValueWindow(c, win) && !isPit(c)).map((c) => blendHit(c, "Power")).filter(Number.isFinite).sort((a, b) => a - b);
  poolQ.set(win.tier, { p75: quantile(xs, 0.75) });
}
const isElitePower = (r: ERow): boolean => r.pow >= (poolQ.get(r.tier)?.p75 ?? Infinity);
interface ArchOut { n: number; est: number; lo: number; hi: number; sig: boolean; drvHr: number; drvBab: number }
/** Elite-power mis-valuation (mwOBA, + = over-valued) with per-channel drivers, tier-centered. */
function eliteArch(rows: ERow[]): ArchOut {
  const by = new Map<string, ERow[]>();
  for (const r of rows) (by.get(r.tier) ?? by.set(r.tier, []).get(r.tier)!).push(r);
  const drv = new Map(rows.map((r) => {
    const base = attribWoba(r.obsBb, r.obsSo, r.obsHr, r.obsBab);
    return [r.key, { hr: attribWoba(r.obsBb, r.obsSo, r.hr, r.obsBab) - base, bab: attribWoba(r.obsBb, r.obsSo, r.obsHr, r.bab) - base }];
  }));
  const point = (groups: Map<string, ERow[]>, get: (r: ERow) => number): { n: number; mean: number } => {
    const acc: number[] = [];
    for (const g of groups.values()) {
      const c = mean(g.map(get));
      for (const r of g) if (isElitePower(r)) acc.push(1000 * (get(r) - c));
    }
    return { n: acc.length, mean: mean(acc) };
  };
  const total = (r: ERow) => r.predW - r.obsW;
  const pt = point(by, total);
  const drvHr = point(by, (r) => drv.get(r.key)!.hr).mean, drvBab = point(by, (r) => drv.get(r.key)!.bab).mean;
  const rnd = rng(SEED + 4242);
  const boots: number[] = [];
  for (let b = 0; b < 1000; b++) {
    const rs = new Map<string, ERow[]>();
    for (const [t, g] of by) rs.set(t, g.map(() => g[Math.floor(rnd() * g.length)]!));
    const v = point(rs, total);
    if (v.n >= 2 && Number.isFinite(v.mean)) boots.push(v.mean);
  }
  const lo = pct(boots, 0.025), hi = pct(boots, 0.975);
  return { n: pt.n, est: pt.mean, lo, hi, sig: Number.isFinite(lo) && lo * hi > 0, drvHr, drvBab };
}

// ═══════════════════════════════════════════════════════════════════════════════
// THE FAMILY BAKE-OFF (bake-off slope loss) — re-selected on THIS coordinate, per channel.
// loss = 2·(pooled−1)² + (top-band−1)² + (rest-band−1)² on tier-DEMEANED pooled corrected rows.
// The per-tier demeaning IS the free-level estimand (audit A: ruling (z) already satisfied).
// ═══════════════════════════════════════════════════════════════════════════════
const FAMILIES: HitTailFamily[] = ["hinge", "hinge50", "quad", "pivot", "step"];
const SHAPES: HitTailShape[] = ["lin", "sat"];
const LAM_MAX = 6, LAM_STEP = 0.05;
const lamGrid: number[] = [];
for (let lam = 0; lam <= LAM_MAX + 1e-9; lam += LAM_STEP) lamGrid.push(Number(lam.toFixed(2)));

interface NeedCell {
  ch: Chan; tier: string; gap: number; st: ChStat;
  rows: { pred: number; obs: number }[];
  need: number; needCI: CI; needSe: number; needBoot: number[]; n: number;
}
/** Achieved POST-correction calibration slope for one tier at strength λ·w(gap). */
function achSlope(cell: NeedCell, fam: HitTailFamily, shape: HitTailShape, lam: number): number {
  const lw = lam * wOf(cell.gap, shape);
  const cp = cell.rows.map((r) => corrCh(cell.ch, r.pred, cell.st, lw, fam));
  return slopeOf(cp, cell.rows.map((r) => r.obs));
}
/** The bake-off slope loss over the fit set: pool tier-demeaned corrected rows, 2·pooled + top + rest. */
function pooledLoss(cells: NeedCell[], fam: HitTailFamily, shape: HitTailShape, lam: number): number {
  const P: number[] = [], O: number[] = [];
  for (const cell of cells) {
    const lw = lam * wOf(cell.gap, shape);
    const cp = cell.rows.map((r) => corrCh(cell.ch, r.pred, cell.st, lw, fam));
    const ob = cell.rows.map((r) => r.obs);
    const mp = mean(cp), mo = mean(ob);
    for (let i = 0; i < cp.length; i++) { P.push(cp[i]! - mp); O.push(ob[i]! - mo); }
  }
  const s = slopeOf(P, O), bd = bands(P, O);
  return 2 * (s - 1) ** 2 + (Number.isFinite(bd.top) ? (bd.top - 1) ** 2 : 0) + (Number.isFinite(bd.rest) ? (bd.rest - 1) ** 2 : 0);
}
function fitArgmin(cells: NeedCell[], fam: HitTailFamily, shape: HitTailShape): { lam: number; loss: number } {
  let best = 0, bestLoss = Infinity;
  for (const lam of lamGrid) { const loss = pooledLoss(cells, fam, shape, lam); if (loss < bestLoss - 1e-12) { bestLoss = loss; best = lam; } }
  return { lam: best, loss: bestLoss };
}

// ═══════════════════════════════════════════════════════════════════════════════
// THE COHERENT-SET RULE (amendment 1) — the pre-committed monotone-feasibility test, per channel.
// Default fit set = all five. A monotone-nondecreasing sequence (ordered by gap ASCENDING) must hit
// every fitted tier's need-CI. floor = max lo-so-far; feasible iff floor never exceeds any hi.
// Infeasible ⇒ exclude the ONE tier whose removal maximises min-slack; >1 exclusion ⇒ STOP.
// ═══════════════════════════════════════════════════════════════════════════════
const LADDER = QUICK.map((q) => q.tier);
const FEAS_EPS = 1e-9;
interface Feas { order: string[]; allFeasible: boolean; minSlackAll: number; perRemoval: { tier: string; feasible: boolean; minSlack: number }[]; fitSet: string[]; excluded: string[]; stop: boolean; reason: string }
function minSlackOf(subset: NeedCell[]): number {
  const srt = [...subset].sort((a, b) => a.gap - b.gap);
  let floor = -Infinity, ms = Infinity;
  for (const c of srt) { floor = Math.max(floor, c.needCI.lo); ms = Math.min(ms, c.needCI.hi - floor); }
  return ms;
}
function feasibility(cells: NeedCell[]): Feas {
  const order = [...cells].sort((a, b) => a.gap - b.gap).map((c) => c.tier);
  const tiers = cells.map((c) => c.tier);
  const minSlackAll = minSlackOf(cells);
  if (minSlackAll >= -FEAS_EPS) return { order, allFeasible: true, minSlackAll, perRemoval: [], fitSet: tiers, excluded: [], stop: false, reason: "all five tiers feasible — fit set = all five, no exclusions" };
  const perRemoval = cells.map((c) => { const ms = minSlackOf(cells.filter((x) => x.tier !== c.tier)); return { tier: c.tier, feasible: ms >= -FEAS_EPS, minSlack: ms }; });
  const restorers = perRemoval.filter((r) => r.feasible).sort((a, b) => b.minSlack - a.minSlack || LADDER.indexOf(a.tier) - LADDER.indexOf(b.tier));
  if (!restorers.length) return { order, allFeasible: false, minSlackAll, perRemoval, fitSet: tiers, excluded: [], stop: true, reason: "no single-tier removal restores feasibility → MORE THAN ONE exclusion needed → STOP" };
  const ex = restorers[0]!.tier;
  return { order, allFeasible: false, minSlackAll, perRemoval, fitSet: tiers.filter((t) => t !== ex), excluded: [ex], stop: false, reason: `infeasible with all five; removing ${ex} restores feasibility with maximal min-slack ${f(restorers[0]!.minSlack, 3)}` };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SELECTION (ruling (x)) — DELIVERABLE-SPACE EQUIVALENCE in ACHIEVED-SLOPE space, per channel.
// Two λ are EQUIVALENT iff at every FITTED tier |achSlope(λ) − achSlope(λ*)| / needSE ≤ 1, where λ*
// is the bake-off argmin. Ship the set's MINIMAX CENTRE (Chebyshev centre in that SE-scaled sup-norm).
// ═══════════════════════════════════════════════════════════════════════════════
interface Sel { lam: number; lamLo: number; lamHi: number; members: number[]; setN: number; sLo: number[]; sHi: number[]; radius: number; width: number; atZeroEdge: boolean; atTopEdge: boolean }
function selectLambda(cells: NeedCell[], fam: HitTailFamily, shape: HitTailShape, argmin: number): Sel {
  const ses = cells.map((c) => c.needSe);
  const at = (lam: number) => cells.map((c) => achSlope(c, fam, shape, lam));
  const sOpt = at(argmin);
  const set = lamGrid.filter((lam) => { const v = at(lam); return cells.every((_, i) => Math.abs(v[i]! - sOpt[i]!) / (ses[i]! || 1e-9) <= 1); });
  const pool = set.length ? set : [argmin];
  const sLo = cells.map((_, i) => Math.min(...pool.map((lam) => at(lam)[i]!)));
  const sHi = cells.map((_, i) => Math.max(...pool.map((lam) => at(lam)[i]!)));
  let best = pool[0]!, radius = Infinity;
  for (const lam of pool) { const v = at(lam); const r = Math.max(...cells.map((_, i) => Math.max(sHi[i]! - v[i]!, v[i]! - sLo[i]!) / (ses[i]! || 1e-9))); if (r < radius) { radius = r; best = lam; } }
  const lamLo = Math.min(...pool), lamHi = Math.max(...pool);
  return {
    lam: best, lamLo, lamHi, members: pool, setN: pool.length, sLo, sHi, radius,
    width: Math.max(...cells.map((_, i) => (sHi[i]! - sLo[i]!) / (ses[i]! || 1e-9))),
    atZeroEdge: lamLo <= 1e-9, atTopEdge: lamHi >= LAM_MAX - 1e-9,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// GATE (w)2' — Fable ruling. Family misfit iff the SHIPPED correction is not well-determined over the
// APPLIED DOMAIN. The deliverable at an applied gap g is the achieved CALIBRATION SLOPE the correction
// produces at strength λ·w(g). This is the "simpler faithful reduction" the prereg's (w)2' clause
// grants: rather than a single-card local amplification (which is a tail derivative, off the need-SE
// scale), D(λ, g) is the SAME pooled achieved-calibration-slope quantity the selection uses —
// evaluated on the fit-set rows with EVERY tier driven at the COMMON applied strength λ·w(min(g,gMax)),
// tier-demeaned then pooled. It is therefore in the channel's calibration-slope units by construction,
// directly comparable to the per-tier need-SE. Across the λ-equivalence set, spread(g) = max−min D;
// require spread ≤ 1 need-SE everywhere on the INTERPOLATED-SE yardstick (linear interp of bracketing
// fitted tiers' need-SEs). STRUCTURAL-LIMIT clause: λ→0 (the no-correction closure) is NOT a grid edge
// — touching it is INFORMATION (a GEOMETRY-UNIDENTIFIED marker), never misfit. INVARIANT: the
// achieved-slope deliverable across the λ-set is within 1 interpolated need-SE at every applied gap.
// ═══════════════════════════════════════════════════════════════════════════════
interface W2Res { pass: boolean; worstRatio: number; maxSpread: number; atGap: number; refSE: number; nExc: number; nApplied: number; geomUnresolved: boolean; marker: string; why: string }
function w2prime(sel: Sel, ch: Chan, fam: HitTailFamily, shape: HitTailShape, fitCells: NeedCell[], appliedGaps: number[], ses: number[], gMax: number): W2Res {
  const fitGaps = fitCells.map((c) => c.gap);
  const srt = fitGaps.map((g, i) => ({ g, se: ses[i]! })).sort((a, b) => a.g - b.g);
  const interpSE = (g: number) => {
    if (g <= srt[0]!.g) return srt[0]!.se;
    if (g >= srt[srt.length - 1]!.g) return srt[srt.length - 1]!.se;
    for (let i = 1; i < srt.length; i++) { const a = srt[i - 1]!, b = srt[i]!; if (g <= b.g) return a.se + (b.se - a.se) * (g - a.g) / (b.g - a.g); }
    return srt[srt.length - 1]!.se;
  };
  // The achieved calibration slope over the fit set when EVERY tier is driven at the common applied
  // strength λ·w(gc) (each tier corrected against its OWN pool moments, then tier-demeaned + pooled).
  const D = (lam: number, gc: number) => {
    const lw = lam * wOf(gc, shape);
    const P: number[] = [], O: number[] = [];
    for (const cell of fitCells) {
      const cp = cell.rows.map((r) => corrCh(ch, r.pred, cell.st, lw, fam));
      const ob = cell.rows.map((r) => r.obs);
      const mp = mean(cp), mo = mean(ob);
      for (let i = 0; i < cp.length; i++) { P.push(cp[i]! - mp); O.push(ob[i]! - mo); }
    }
    return slopeOf(P, O);
  };
  let worstRatio = 0, maxSpread = 0, atGap = NaN, refSE = Math.min(...ses), nExc = 0;
  for (const g of appliedGaps) {
    const gc = Math.min(g, gMax);
    const vs = sel.members.map((lam) => D(lam, gc));
    const spread = Math.max(...vs) - Math.min(...vs);
    const se = interpSE(gc), r = spread / (se || 1e-9);
    if (r > worstRatio) { worstRatio = r; maxSpread = spread; atGap = gc; refSE = se; }
    if (r > 1) nExc++;
  }
  const geomUnresolved = sel.atZeroEdge;
  const pass = worstRatio <= 1;
  const marker = geomUnresolved
    ? `GEOMETRY-UNIDENTIFIED: the λ-set reaches λ→0 (the no-correction closure, a structural limit — NOT a grid edge). The DELIVERABLE is determined; whether any correction is warranted is not. Informational, per the (w)2' structural-limit clause.`
    : `geometry resolved: the equivalence set is interior (λ bounded away from 0).`;
  const why = pass
    ? `applied-domain deliverable is well-determined: worst λ-set D-spread over ${appliedGaps.length} production tournaments (post-clamp at gMax=${f(gMax, 3)}) is ${f(maxSpread, 4)} at gap ${f(atGap, 3)}, ${f(worstRatio, 2)}× the local (interpolated) need-SE (${f(refSE, 3)}) — ≤ 1 everywhere.`
    : `applied-domain deliverable NOT well-determined: worst D-spread ${f(maxSpread, 4)} at gap ${f(atGap, 3)} is ${f(worstRatio, 2)}× the local need-SE (${f(refSE, 3)}) — exceeds 1 at ${nExc} of ${appliedGaps.length} applied gaps.`;
  return { pass, worstRatio, maxSpread, atGap, refSE, nExc, nApplied: appliedGaps.length, geomUnresolved, marker, why };
}

// ═══════════════════════════════════════════════════════════════════════════════
// APPLIED DOMAIN — the own-gap g of EVERY production tournament, per channel, as production resolves
// each format (own era/park/eligibility → own field → own g = ref.μ/pool.μ − 1). Computed once.
// ═══════════════════════════════════════════════════════════════════════════════
interface AppliedGap { id: string; gPow: number; gBab: number; gK: number }
const APPLIED: AppliedGap[] = [];
for (const t of tournaments) {
  const era = eras.get(t.eraId), park = parks.get(t.parkId);
  if (!era || !park) continue;
  const cf = resolveCoeffs(model, era, park, t.softcaps);
  applyWobaWeights(cf, trained.wobaWeights!);
  const inV = (c: Card) => { const v = n_(c["Card Value"]); return (t.card_value_min == null || v >= t.card_value_min) && (t.card_value_max == null || v <= t.card_value_max); };
  const pool = baseCards.filter((c) => inV(c) && rowEligible(c as any, t) && !isPit(c));
  if (!pool.length) continue;
  const refF = productionFieldStats(baseCards, cf, rp);
  const poolF = productionFieldStats(pool, cf, rp);
  const g = (k: string) => Math.max((refF.hit.vR[k]!.mu / Math.max(poolF.hit.vR[k]!.mu, 1e-9)) - 1, 0);
  APPLIED.push({ id: t.id, gPow: g("pow"), gBab: g("babip"), gK: g("kRat") });
}
const appliedFor = (ch: Chan): number[] => APPLIED.map((a) => (ch === "hr" ? a.gPow : ch === "bab" ? a.gBab : a.gK));

// ═══════════════════════════════════════════════════════════════════════════════
// ONE CHANNEL, ONE LEG — measure needs, feasibility, family bake-off, select λ, gate, accept.
// ═══════════════════════════════════════════════════════════════════════════════
interface ChanResult {
  ch: Chan; fam: HitTailFamily; shape: HitTailShape; argmin: number; famLoss: number;
  cells: NeedCell[]; fitTiers: string[]; fitCells: NeedCell[]; feas: Feas; smallestGapTier: string; stop: boolean;
  sel: Sel; lamCI: CI; sCI: Map<string, CI>;
  accept: { tier: string; gap: number; need: number; needCI: CI; ach: number; achCI: CI; inside: boolean; thin: boolean }[];
  smallInside: boolean; acceptPass: boolean; nInside: number;
  loo: { dropped: string; lam: number; inAll: boolean }[]; w3: boolean;
  w2: W2Res;
  excluded: { tier: string; gap: number; need: number; needCI: CI; ach: number; resid: number; residCI: CI }[];
  famTable: { fam: HitTailFamily; shape: HitTailShape; lam: number; loss: number }[];
}
function fitChannel(ch: Chan, rows: ERow[], ctx: Map<string, TierCtx>, seedBase: number): ChanResult {
  // ── measure the per-tier PRE-correction need (calibration slope) with a within-tier bootstrap ──
  const cells: NeedCell[] = [];
  let seedStep = 0;
  for (const win of QUICK) {
    const c = ctx.get(win.tier); if (!c) continue;
    const rs = rows.filter((r) => r.tier === win.tier).map((r) => ({ pred: ch === "hr" ? r.hr : ch === "bab" ? r.bab : r.so, obs: ch === "hr" ? r.obsHr : ch === "bab" ? r.obsBab : r.obsSo }));
    const need = slopeOf(rs.map((r) => r.pred), rs.map((r) => r.obs));
    const rnd = rng(seedBase + seedStep++);
    const boot: number[] = [];
    for (let b = 0; b < B_NEED; b++) { const rr = rs.map(() => rs[Math.floor(rnd() * rs.length)]!); boot.push(slopeOf(rr.map((r) => r.pred), rr.map((r) => r.obs))); }
    const bf = boot.filter(Number.isFinite);
    cells.push({ ch, tier: win.tier, gap: gapOfChan(c, ch), st: statOfChan(c, ch), rows: rs, need, needCI: ci(bf), needSe: sd(bf), needBoot: bf, n: rs.length });
  }
  // ── the coherent set (amendment 1) ──
  const feas = feasibility(cells);
  const fitTiers = feas.fitSet;
  const fitCells = fitTiers.map((t) => cells.find((c) => c.tier === t)!);
  const smallestGapTier = fitCells.reduce((a, b) => (b.gap < a.gap ? b : a)).tier;
  // ── family bake-off on the fit set (do NOT inherit PINNED_HIT_TAIL) ──
  const famTable: { fam: HitTailFamily; shape: HitTailShape; lam: number; loss: number }[] = [];
  for (const fam of FAMILIES) for (const shape of SHAPES) { const { lam, loss } = fitArgmin(fitCells, fam, shape); famTable.push({ fam, shape, lam, loss }); }
  const win = [...famTable].sort((a, b) => a.loss - b.loss)[0]!;
  const fam = win.fam, shape = win.shape, argmin = win.lam;
  // ── selection: deliverable-space equivalence, minimax centre ──
  const sel = selectLambda(fitCells, fam, shape, argmin);
  // ── selection/deliverable bootstrap (B_SEL): re-fit argmin + re-select end-to-end per replicate ──
  const rb = rng(seedBase + 700);
  const lamBoot: number[] = [], sBoot = new Map<string, number[]>(cells.map((c) => [c.tier, []]));
  for (let b = 0; b < B_SEL; b++) {
    const rsCells = fitCells.map((c) => ({ ...c, rows: c.rows.map(() => c.rows[Math.floor(rb() * c.rows.length)]!) }));
    const am = fitArgmin(rsCells, fam, shape).lam;
    const sb = selectLambda(rsCells, fam, shape, am);
    lamBoot.push(sb.lam);
    for (const c of cells) sBoot.get(c.tier)!.push(achSlope(c, fam, shape, sb.lam));
  }
  const lamCI = ci(lamBoot.filter(Number.isFinite));
  const sCI = new Map([...sBoot].map(([t, xs]) => [t, ci(xs.filter(Number.isFinite))] as const));
  // ── (w)3 leave-one-fitted-tier-out, in deliverable (achieved-slope) space ──
  const loo = fitCells.map((c) => {
    const rest = fitCells.filter((x) => x.tier !== c.tier);
    const am = fitArgmin(rest, fam, shape).lam;
    const sb = selectLambda(rest, fam, shape, am);
    const inAll = fitCells.every((x) => { const q = sCI.get(x.tier)!; const v = achSlope(x, fam, shape, sb.lam); return v >= q.lo && v <= q.hi; });
    return { dropped: c.tier, lam: sb.lam, inAll };
  });
  const w3 = loo.every((x) => x.inAll);
  // ── (w)2' applied domain ──
  const gMax = Math.max(...fitCells.map((c) => c.gap));
  const w2 = w2prime(sel, ch, fam, shape, fitCells, appliedFor(ch), fitCells.map((c) => c.needSe), gMax);
  // ── acceptance: post-correction slope at the selected λ covers 1 (within its own bootstrap CI) ──
  let accSeed = seedBase + 1500;
  const accept = fitCells.map((c) => {
    const ach = achSlope(c, fam, shape, sel.lam);
    const rnd = rng(accSeed++);
    const boot: number[] = [];
    for (let b = 0; b < B_ACC; b++) { const rr = { ...c, rows: c.rows.map(() => c.rows[Math.floor(rnd() * c.rows.length)]!) }; boot.push(achSlope(rr, fam, shape, sel.lam)); }
    const achCI = ci(boot.filter(Number.isFinite));
    return { tier: c.tier, gap: c.gap, need: c.need, needCI: c.needCI, ach, achCI, inside: achCI.lo <= 1 && achCI.hi >= 1, thin: c.n < THIN_N };
  });
  const smallInside = accept.find((a) => a.tier === smallestGapTier)!.inside;
  const nInside = accept.filter((a) => a.inside).length;
  const acceptPass = !feas.stop && smallInside && nInside >= fitCells.length - 1;
  // ── excluded tiers: published residual (gold semantics) ──
  const excluded = feas.excluded.map((t) => {
    const gc = cells.find((c) => c.tier === t)!;
    const ach = achSlope(gc, fam, shape, sel.lam);
    const gS = sBoot.get(t)!, gResid: number[] = [];
    for (let b = 0; b < Math.min(gc.needBoot.length, gS.length); b++) gResid.push(gc.needBoot[b]! - gS[b]!);
    return { tier: t, gap: gc.gap, need: gc.need, needCI: gc.needCI, ach, resid: gc.need - ach, residCI: ci(gResid.filter(Number.isFinite)) };
  });
  return { ch, fam, shape, argmin, famLoss: win.loss, cells, fitTiers, fitCells, feas, smallestGapTier, stop: feas.stop, sel, lamCI, sCI, accept, smallInside, acceptPass, nInside, loo, w3, w2, excluded, famTable };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ONE LEG (one presence p): build sample, fit all three channels, run the paired elite-power gate.
// ═══════════════════════════════════════════════════════════════════════════════
interface Leg { p: number; rows: number; chans: Record<Chan, ChanResult>; elite: ArchOut; ctx: Map<string, TierCtx> }
function buildLeg(p: number): Leg {
  const deps = makeDeps(EVENT_FORM, p);
  const sample = buildCwhitSample(deps);
  const rows = rowsFromRecs(sample.recs);
  const ctx = buildCtx(deps, sample.pools, p);
  const chans = {} as Record<Chan, ChanResult>;
  let si = 0;
  for (const ch of CHANS) chans[ch] = fitChannel(ch, rows, ctx, SEED + 10000 * ++si);
  const cfg: ACfg = {
    hr: { fam: chans.hr.fam, shape: chans.hr.shape, lam: chans.hr.sel.lam },
    bab: { fam: chans.bab.fam, shape: chans.bab.shape, lam: chans.bab.sel.lam },
    so: { fam: chans.so.fam, shape: chans.so.shape, lam: chans.so.sel.lam },
  };
  const elite = eliteArch(applyA(rows, ctx, cfg));
  return { p, rows: rows.length, chans, elite, ctx };
}

// ── GATE (w)1 IDENTIFIABILITY: per channel, the g coordinate must be strictly monotone across the
//    five tiers and retain ≥ 60% span at the shipped p vs p=0. A property of the COORDINATE. ────────
interface W1Row { ch: Chan; p: number; mono: boolean; span: number; ret: number }
const P_BAND = [0, 0.25, 0.30, 0.35];
function gapCoord(ch: Chan, p: number): Map<string, number> {
  const ref = productionFieldStats(baseCards, coeffs, rp, true, p);
  const k = CHGAP[ch];
  const m = new Map<string, number>();
  for (const win of QUICK) {
    const pool = baseCards.filter((c) => inValueWindow(c, win));
    const fs = productionFieldStats(pool, coeffs, rp, true, p);
    m.set(win.tier, Math.max((ref.hit.vR[k]!.mu / Math.max(fs.hit.vR[k]!.mu, 1e-9)) - 1, 0));
  }
  return m;
}
const strictMono = (v: number[]) => v.every((x, i) => i === 0 || x > v[i - 1]!) || v.every((x, i) => i === 0 || x < v[i - 1]!);
const spanMap = (m: Map<string, number>) => { const v = LADDER.map((t) => m.get(t)!); return Math.max(...v) - Math.min(...v); };
const w1Rows: W1Row[] = [];
for (const ch of CHANS) {
  const span0 = spanMap(gapCoord(ch, 0));
  for (const p of P_BAND) { const gm = gapCoord(ch, p); w1Rows.push({ ch, p, mono: strictMono(LADDER.map((t) => gm.get(t)!)), span: spanMap(gm), ret: spanMap(gm) / (span0 || 1e-9) }); }
}
const W1_PASS = CHANS.every((ch) => { const rs = w1Rows.filter((r) => r.ch === ch); return rs.every((r) => r.mono) && rs.filter((r) => r.p > 0).every((r) => r.ret >= 0.60); });

// ═══════════════════════════════════════════════════════════════════════════════
// RUN — primary p = 0.30, band re-check at 0.25 / 0.35.
// ═══════════════════════════════════════════════════════════════════════════════
const primary = buildLeg(PRESENCE_P);
const bandLegs = [0.25, 0.35].map(buildLeg);

const chanOK = (c: ChanResult) => !c.stop && c.acceptPass && c.w2.pass && c.w3;
const legOK = (leg: Leg) => CHANS.every((ch) => chanOK(leg.chans[ch])) && !leg.elite.sig;
const bandHolds = bandLegs.every(legOK);

const fails: string[] = [];
if (!W1_PASS) fails.push("GATE (w)1 IDENTIFIABILITY");
for (const ch of CHANS) {
  const c = primary.chans[ch];
  if (c.stop) fails.push(`STOP ${CHLAB[ch]}: >1 exclusion (family/coordinate failure)`);
  else {
    if (!c.smallInside) fails.push(`ACCEPTANCE ${CHLAB[ch]}: smallest-gap tier (${c.smallestGapTier}) OUTSIDE its CI (STOP-class)`);
    else if (!c.acceptPass) fails.push(`ACCEPTANCE ${CHLAB[ch]}: >1 fit-set tier outside CI`);
    if (!c.w2.pass) fails.push(`GATE (w)2' ${CHLAB[ch]} (family misfit)`);
    if (!c.w3) fails.push(`GATE (w)3 ${CHLAB[ch]}`);
  }
}
if (primary.elite.sig) fails.push("PAIRED HR+BABIP ELITE-POWER (residual CI excludes 0)");
const VERDICT = fails.length
  ? `STOP — ${fails.join(" + ")}`
  : bandHolds ? "PASS — every gate and the acceptance bar hold at p=0.30 AND across the 0.25/0.35 band"
    : "PARTIAL — gates and the acceptance bar hold at p=0.30 but not across the whole 0.25/0.35 band";

// ═══════════════════════════════════════════════════════════════════════════════
// REPORT
// ═══════════════════════════════════════════════════════════════════════════════
say("################################################################################");
say(`# C6 — THE RE-DERIVED HITTER-TAIL CORRECTION (HR600 / BABIP / SO%). VERDICT: ${VERDICT}`);
say("# Pre-registration: docs/CWHIT_HITTAIL_REFIT_PREREG_2026-07-22.md + AMENDMENT 1.");
say("# Tool: tools/hit-tail-c6.ts. FIT AND REPORT ONLY — this tool wires nothing. On a PASS the");
say("# constants ship in the SAME dated commit as C3 and the HR-ramp refit (the atomic-event rule).");
say("################################################################################");
say();
say("### THE CLAUSE-4 AUDIT, RESOLVED IN CODE (nothing here is tuned)");
say("  A. ESTIMAND — ALREADY CORRECT. The bake-off slope loss de-means pred AND obs PER TIER before");
say("     the slope (a single tier's OLS slope centres on that tier's means), which IS ruling (z)'s");
say("     free-slope-with-per-tier-level. Prereg §1.A was over-cautious; the fix that MATTERS is the");
say("     instrument (B). No estimand change was needed or made.");
say("  B. INSTRUMENT — the real defect. Every field is now productionFieldStats (presence mixture at");
say(`     FIELD_N·PRESENCE_M) at BOTH sites (neutral ref + per-tier pool), so g = k−1 and every pool`);
say("     moment (p50/p75/sd) sit on production's post-C1/C2' coordinate, not the phantom FIELD_N fork.");
say("  C. FAMILY — re-selected by the bake-off on THIS coordinate (PINNED_HIT_TAIL NOT inherited).");
say("  D. SELECTION — deliverable-space equivalence per channel, minimax-centre λ, sets published.");
say("  E. FORMAT REACH — applied/held-out formats resolved from the corpus REGISTRY by tournamentId.");
say();
say("### HEADER");
say(`  tool        tools/hit-tail-c6.ts`);
say(`  date        2026-07-22`);
say(`  model       '${trained.id}'   (raw-poly event model, own-gap path, no anchor on the judged line)`);
say(`  catalog     '${srcId}'   (${baseCards.length} base cards, variant rows excluded from the catalog read)`);
say(`  channels    HR600 / BABIP / SO% — RAW hitter event line, own-gap ON, no anchor (hitters only)`);
say(`  coordinate  g = k−1 = ref.μ / poolField.μ − 1, both via productionFieldStats (audit B)`);
say(`  fit-N       FIELD_N = ${FIELD_N}  (scaled by PRESENCE_M on the replicated presence mixture)`);
say(`  fit-p       PRESENCE_P = ${PRESENCE_P}   (band re-check at 0.25 / 0.35)`);
say(`  families    ${FAMILIES.join(", ")}  ×  shapes ${SHAPES.join(", ")}  (w_sat G0 = ${HIT_TAIL_SAT_G0})`);
say(`  bootstrap   needs B = ${B_NEED}; acceptance B = ${B_ACC}; λ-selection/deliverable B = ${B_SEL}; SEED ${SEED}`);
say(`  applied     ${APPLIED.length} production tournaments (own era/park/eligibility → own g), post-clamp at gMax`);
say();

say("### GATE (w)1 — IDENTIFIABILITY OF THE g COORDINATE (per channel; property of the coordinate)");
say(`  requirement: g strictly monotone across the five tiers at every p, AND ≥ 60% span retention vs p=0.`);
for (const ch of CHANS) {
  say(`  ${CHLAB[ch]}  (g = ${CHGAP[ch]} gap)`);
  say(`    p        ${LADDER.map((t) => rpad(t, 9)).join("")}   mono   span    ret`);
  for (const p of P_BAND) {
    const gm = gapCoord(ch, p), r = w1Rows.find((x) => x.ch === ch && x.p === p)!;
    say(`    ${f(p, 2)}     ${LADDER.map((t) => rpad(f(gm.get(t)!, 3), 9)).join("")}   ${r.mono ? "YES" : "NO "}   ${rpad(f(r.span, 2), 5)}   ${p === 0 ? "  —" : `${f(r.ret * 100, 0)}%`}`);
  }
}
say(`  GATE (w)1: ${W1_PASS ? "PASS" : "FAIL"}`);
say();

function sayChannel(c: ChanResult, full: boolean) {
  const sFit = (cell: NeedCell) => achSlope(cell, c.fam, c.shape, c.sel.lam);
  say(`── ${CHLAB[c.ch]} ──`);
  say(`  FAMILY BAKE-OFF on the fit set (min slope loss wins; PINNED_HIT_TAIL NOT inherited)`);
  say(`    family×shape     λ*      loss`);
  for (const t of [...c.famTable].sort((a, b) => a.loss - b.loss)) say(`    ${pad(`${t.fam}-${t.shape}`, 15)} ${rpad(f(t.lam), 5)}   ${f(t.loss, 4)}${t.fam === c.fam && t.shape === c.shape ? "   ← chosen" : ""}`);
  say(`  CHOSEN: ${c.fam}-${c.shape}   argmin λ = ${f(c.argmin)}`);
  say();
  say(`  PER-TIER NEED (pre-correction calibration slope; free-level per-tier OLS) + coherent set`);
  say(`  tier      set   N    g        need   [boot 95% CI]        se`);
  const inFit = (t: string) => (c.fitTiers.includes(t) ? (t === c.smallestGapTier ? "fit*" : "fit ") : "OUT ");
  for (const cell of c.cells) say(`  ${pad(cell.tier, 9)}${pad(inFit(cell.tier), 6)}${rpad(String(cell.n), 3)}   ${rpad(f(cell.gap, 3), 6)}   ${rpad(f(cell.need, 2), 5)}   [${f(cell.needCI.lo, 2)},${f(cell.needCI.hi, 2)}]   ${f(cell.needSe, 3)}${cell.n < THIN_N ? "  THIN" : ""}`);
  say(`    feasibility (gap asc: ${c.feas.order.join(" → ")}): all-five min-slack ${sgn(c.feas.minSlackAll, 3)} ⇒ ${c.feas.allFeasible ? "FEASIBLE" : "INFEASIBLE"}`);
  if (!c.feas.allFeasible) for (const r of c.feas.perRemoval) say(`      drop ${pad(r.tier, 9)} ${r.feasible ? "FEASIBLE ✓" : "still infeasible ✗"}   min-slack ${sgn(r.minSlack, 3)}`);
  say(`    ⇒ ${c.feas.reason}`);
  say(`    fit set: ${c.fitTiers.join(", ")}   smallest-gap (mandatory): ${c.smallestGapTier}${c.stop ? "   *** STOP ***" : ""}`);
  say();
  say(`  SELECTION — deliverable-space equivalence (achieved-slope space), minimax centre`);
  say(`    λ-equivalence set = [${f(c.sel.lamLo)}, ${f(c.sel.lamHi)}]  (${c.sel.setN} grid pts)   MINIMAX-CENTRE λ = ${f(c.sel.lam)}  [boot 95% CI ${f(c.lamCI.lo)}, ${f(c.lamCI.hi)}]`);
  say(`    set width ${f(c.sel.width, 2)} need-SEs; centre reaches ${f(c.sel.radius, 2)} SEs to the furthest member.`);
  say(`    touches λ→0 (structural-limit closure): ${c.sel.atZeroEdge ? "YES (informational — see (w)2')" : "no"};  touches grid top (λ=${LAM_MAX}): ${c.sel.atTopEdge ? "YES" : "no"}`);
  if (full) {
    say(`    fitted tier   se     set achieved-slope range     centre`);
    for (const [i, cell] of c.fitCells.entries()) say(`    ${pad(cell.tier, 11)}${rpad(f(cell.needSe, 3), 5)}   ${rpad(`${f(c.sel.sLo[i]!, 3)} – ${f(c.sel.sHi[i]!, 3)}`, 20)}   ${f(sFit(cell), 3)}`);
  }
  say();
  say(`  GATE (w)2' APPLIED-DOMAIN DELIVERABLE: ${c.w2.pass ? "PASS" : "FAIL"}`);
  say(`    ${c.w2.why}`);
  say(`    ${c.w2.marker}`);
  say(`    worst spread ratio ${f(c.w2.worstRatio, 2)}× local need-SE (${c.w2.nExc} of ${c.w2.nApplied} applied gaps exceed 1).`);
  say();
  say(`  GATE (w)3 LEAVE-ONE-FITTED-TIER-OUT (deliverable/achieved-slope space): ${c.w3 ? "PASS" : "FAIL"}`);
  for (const x of c.loo) say(`    drop ${pad(x.dropped, 9)} → λ ${rpad(f(x.lam), 5)}   inside full-fit s-CI at every fitted gap: ${x.inAll ? "YES ✓" : "NO ✗"}`);
  say();
  say(`  ACCEPTANCE — post-correction slope at λ=${f(c.sel.lam)} covers 1 (its own bootstrap CI), on the fit set`);
  say(`    tier       g        need (pre)   achieved (post)   [boot 95% CI]     covers 1?`);
  for (const a of c.accept) say(`    ${pad(a.tier, 9)}${rpad(f(a.gap, 3), 6)}   ${rpad(f(a.need, 2), 10)}   ${rpad(f(a.ach, 2), 15)}   [${f(a.achCI.lo, 2)},${f(a.achCI.hi, 2)}]     ${a.inside ? "YES ✓" : "NO  ✗"}${a.tier === c.smallestGapTier ? "  (mandatory)" : ""}${a.thin ? "   THIN" : ""}`);
  for (const e of c.excluded) say(`    ${pad(e.tier, 9)}${rpad(f(e.gap, 3), 6)}   ${rpad(f(e.need, 2), 10)}   ${rpad(f(e.ach, 2), 15)}   [excluded — amd 1]   NOT SCORED`);
  say(`    inside: ${c.nInside} of ${c.fitCells.length};  SMALLEST-GAP (${c.smallestGapTier}) ${c.smallInside ? "INSIDE ✓" : "OUTSIDE ✗ (STOP-class)"}`);
  say(`  ACCEPTANCE: ${c.acceptPass ? "PASS" : "FAIL"}`);
  if (c.excluded.length) { say(); for (const e of c.excluded) say(`  EXCLUDED ${e.tier.toUpperCase()} — PUBLISHED RESIDUAL: need ${f(e.need, 2)} [${f(e.needCI.lo, 2)},${f(e.needCI.hi, 2)}] vs achieved ${f(e.ach, 2)} ⇒ resid ${sgn(e.resid, 3)} [${f(e.residCI.lo, 2)}, ${f(e.residCI.hi, 2)}] (gold semantics).`); }
  say();
}

say("### 2. THE PRIMARY LEG — p = 0.30");
say(`  judged hitters: ${primary.rows} well-sampled (PA ≥ ${MIN_PA}) across ${QUICK.length} Quick tiers`);
say();
for (const ch of CHANS) sayChannel(primary.chans[ch], true);

say("### 3. THE PAIRED HR+BABIP ELITE-POWER GATE (BUILD-2's decisive acceptance)");
say(`  Both corrections applied together (+ SO); elite-power = POW ≥ pool p75. The cancellation must`);
say(`  stay RESOLVED, not moved: the joint residual CI must cover 0.`);
say(`  elite-power mis-valuation (level-free mwOBA, + = over-valued): ${sgn(primary.elite.est, 2)}${primary.elite.sig ? "*" : " "} [${sgn(primary.elite.lo, 2)}, ${sgn(primary.elite.hi, 2)}]  n=${primary.elite.n}`);
say(`    drivers: HR ${sgn(primary.elite.drvHr, 1)}  BABIP ${sgn(primary.elite.drvBab, 1)} (mwOBA)`);
say(`  GATE: ${primary.elite.sig ? "FAIL — residual CI excludes 0 (cancellation moved, not resolved)" : "PASS — residual CI covers 0"}`);
say();

say("### 4. THE BAND RE-CHECK — p = 0.25 / 0.35 (do the gates and acceptance reproduce?)");
say(`  p       channel   fam-shape       λ (set)              feas         accept    (w)2'  (w)3   elite`);
for (const leg of [bandLegs[0]!, primary, bandLegs[1]!].sort((a, b) => a.p - b.p)) {
  for (const ch of CHANS) {
    const c = leg.chans[ch];
    const fe = c.stop ? "STOP" : c.excluded.length ? `−${c.excluded.map((e) => e.tier).join(",")}` : "all five";
    say(`  ${f(leg.p, 2)}    ${pad(CHLAB[ch], 8)}  ${pad(`${c.fam}-${c.shape}`, 14)}  ${pad(`${f(c.sel.lam)} [${f(c.sel.lamLo)},${f(c.sel.lamHi)}]`, 18)}  ${pad(fe, 11)}  ${pad(c.acceptPass ? `${c.nInside}/${c.fitCells.length} ✓` : `${c.nInside}/${c.fitCells.length} ✗`, 8)}  ${c.w2.pass ? "PASS" : "FAIL"}  ${c.w3 ? "PASS" : "FAIL"}${ch === "hr" ? `   ${leg.elite.sig ? "SIG✗" : "0 ✓"}` : ""}`);
  }
}
say(`  BAND VERDICT: ${bandHolds ? "HOLDS at 0.25 and 0.35" : "DOES NOT HOLD across the whole band"}`);
say();

say("### 5. THE PROPOSED CONSTANTS, WITH PROVENANCE (do NOT read as wired)");
say();
if (fails.length) {
  say(`  NO CONSTANTS ARE PROPOSED FOR SHIPPING. ${fails.join(" + ")}.`);
  say(`  What follows is what the pre-registered rule PRODUCED, recorded so the record is complete.`);
} else {
  say(`  THE GATES PASS — these are the constants the pre-registered rule produced. This tool wires`);
  say(`  nothing; shipping is the SAME dated commit as C3 and the HR-ramp refit (the atomic-event rule).`);
}
say();
const pc = primary.chans;
say(`  PINNED_HIT_TAIL_C6 = {`);
say(`    hr:  { fam: "${pc.hr.fam}", shape: "${pc.hr.shape}", lam: ${f(pc.hr.sel.lam)} },   // set [${f(pc.hr.sel.lamLo)}, ${f(pc.hr.sel.lamHi)}], fit ${pc.hr.fitTiers.join("/")}`);
say(`    bab: { fam: "${pc.bab.fam}", shape: "${pc.bab.shape}", lam: ${f(pc.bab.sel.lam)} },   // set [${f(pc.bab.sel.lamLo)}, ${f(pc.bab.sel.lamHi)}], fit ${pc.bab.fitTiers.join("/")}`);
say(`    so:  { fam: "${pc.so.fam}", shape: "${pc.so.shape}", lam: ${f(pc.so.sel.lam)} },   // set [${f(pc.so.sel.lamLo)}, ${f(pc.so.sel.lamHi)}], fit ${pc.so.fitTiers.join("/")}`);
say(`  };`);
say(`  PROVENANCE (fit-derived, coordinate-dependent — never rescale, only re-derive): fitN = ${FIELD_N}, fitP = ${PRESENCE_P}.`);
for (const ch of CHANS) { const e = pc[ch].excluded; if (e.length) say(`  ${CHLAB[ch]} excluded ${e.map((x) => `${x.tier} (residual ${sgn(x.resid, 2)} [${f(x.residCI.lo, 2)}, ${f(x.residCI.hi, 2)}])`).join("; ")}.`); }
say();
say("### 6. RECORDED, NOT ACTED ON (the freeze applies)");
say("  · PITCHER BIT-IDENTITY is not checked here — the hitter tail never touches pitcher lines; the");
say("    final C6 sweep asserts it (max |Δ| = 0 across all pitcher rows) before anything is announced.");
say("  · BB% is a watch-only channel, out of scope; wOBA is a downstream summary, never a fit target.");
say("  · FIELD_N = 50 is known-defective and frozen until a retrain; nothing here revisits it.");
say(`  · Any STOP is REPORTED, not tuned past: ${fails.length ? fails.join(" + ") : "none — gates and acceptance hold"}.`);
say();
say(`(end of artifact — hitter-tail refit, ${VERDICT.split(" ")[0]})`);

process.stdout.write(L.join("\n") + "\n");
process.exit(0);
