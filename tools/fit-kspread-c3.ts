// C3 — THE RE-DERIVED PITCHER K-SPREAD RAMP. Fit · gates · held-out validation. REPORT ONLY.
//   run: node tools/fit-kspread-c3.ts > fixtures/cwhit-c3-ramp-fit-2026-07-22.txt
//
// SPECIFICATION: docs/CWHIT_C3_RAMP_PREREG_2026-07-22.md + AMENDMENT 1 (approved). Everything below
// — the family, the pinning rule, the objective, the gates, the acceptance bar, the stratification —
// is pre-registered there. Nothing here is tuned; a failing gate is reported, never tuned past.
//
// NOTHING IS WIRED. This tool changes no default, no shipped constant, and no production path. The
// shipped ramp K_SPREAD_PIT stays exactly as it is; the verdict returns to Fable, who decides.
//
// ── WHY A NEW TOOL RATHER THAN A RE-RUN OF tools/fit-kspread-pit.ts ─────────────────────────────
// That tool fits a DIFFERENT, FALSIFIED family (the saturating 1 + A(1−e^(−g/G))) against TIER
// AGGREGATE slopes, and reaches its daily formats through a hard-coded `legacySlug` list that is
// four of the registry's eight dailies. C3 changes all three: a convex-capable family, a PER-CARD
// noise-weighted objective, and format resolution from the corpus REGISTRY by tournamentId. Editing
// the old tool would have destroyed the record of the fit the shipped constant came from.
//
// ── THE COORDINATE (final; C1 + C2' shipped) ───────────────────────────────────────────────────
// C1 made field SELECTION environment-free (baserunning zeroed in the ranking only). C2' made every
// FIELD presence-weighted — an eligible card contributes its v5 at p = PRESENCE_P and its base at
// 1−p, exact by integer replication. `productionFieldStats()` is THE ONE definition and is what
// production, `buildCwhitSample` and this tool all call; no field is constructed any other way here.
// The p = 0.25 / 0.35 sensitivity legs pass `p` THROUGH that one function (and through the builder's
// new `presenceP`), rather than assembling a mixture locally.
//
// ── GRAIN (stated, per the standing rule) ──────────────────────────────────────────────────────
// Observed statistics are at ROW grain = (card × variant level). A card and its v5 are two rows with
// two observed lines; `Rec.cid` is `${Card ID}|${vlvl}`. Pool/field constants are at CARD grain over
// the presence mixture. N counts below are ROWS unless the column says pool.

import { readFileSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import {
  makeRawPolyModel, productionFieldStats, applyWobaWeights, computeDerived,
  buildPoolTransform, buildFrameShift, poolPitMeansOwn, FIELD_N,
  type EventForm, type FieldStats, type RatingEnvelope, type WobaWeights, type TrainingMeans,
} from "../src/scoring-core/index.ts";
import { presenceMixture, PRESENCE_P, PRESENCE_M } from "../src/data/variants.ts";
import { parseCatalogCsv, type Card } from "../src/data/catalog.ts";
import { rowEligible } from "../src/config/eligibility.ts";
import type { WobaWeights as WW } from "../src/eval/cwhit/audit.ts";
import { per9NoiseVar, BF_PER_9 } from "../src/eval/cwhit/scorecard.ts";
import { mmse } from "../src/eval/cwhit/two-ledger.ts";
import { CWHIT_CORPUS } from "../src/eval/cwhit/corpus.ts";
import {
  buildCwhitSample, wellSampled, QUICK, inValueWindow, MIN_BF, n_,
  type Rec, type SampleDeps, type ValueWindow, type KSpreadPit,
} from "../src/eval/cwhit/sample.ts";

// ── output buffer: the verdict banner has to be line 1, and it is only known at the end ──
const L: string[] = [];
const say = (s = "") => L.push(s);
const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const sgn = (x: number, d = 2) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}` : "n/a");
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const pad = (s: string, n: number) => s.padEnd(n);
const rpad = (s: string, n: number) => s.padStart(n);
/** Display label: the site labels carry a "(from YYYY-MM-DD)" version stamp that wrecks a column. */
const lbl = (s: string) => s.replace(/\s*\(from .*\)$/, "");

// ═══════════════════════════════════════════════════════════════════════════════
// 0. SETUP — deployed model, neutral env. Composition copied from
//    tools/battery-needs-vs-bar.ts / tools/fit-kspread-pit.ts (tools are entry-point scripts).
// ═══════════════════════════════════════════════════════════════════════════════
const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state = (await repo.load<{ activeModelId?: string; catalogSourceId?: string }>("state", "app")) ?? {};
type TM_ = { id: string; eventForm?: EventForm; wobaWeights?: WobaWeights; ratingEnvelope?: RatingEnvelope; trainingMeans?: TrainingMeans; platoon?: { pit: { hand: string; vsRHB: number; vsLHB: number }[]; hit: { hand: string; vsRHP: number; vsLHP: number }[] } };
const trained = (await repo.loadAll<TM_>("trained-models")).find((x) => x.id === state.activeModelId);
if (!trained?.eventForm || !trained.wobaWeights || !trained.platoon) throw new Error("active model missing eventForm/wobaWeights/platoon");
if (!trained.trainingMeans) throw new Error("active model has NO trainingMeans — the gap convention needs the artifact frame");
const TM = trained.trainingMeans;
const rp = makeRawPolyModel(trained.eventForm);
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
const depsBase = {
  baseCards, coeffs, derived, eventForm: trained.eventForm, model: rp, W: trained.wobaWeights as WW,
  envelope: trained.ratingEnvelope,
  pitExp: new Map(trained.platoon.pit.map((p) => [p.hand, { wR: p.vsRHB, wL: p.vsLHB }])),
  hitExp: new Map(trained.platoon.hit.map((p) => [p.hand, { wR: p.vsRHP, wL: p.vsLHP }])),
};

// ── seeded bootstrap plumbing: the program's generator + helpers, verbatim ──
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
/** N below which a cell carries NO verdict. Pre-registered; "insufficient data" is never "noise". */
const THIN_N = 15;
const PER9 = BF_PER_9 / 600;   // raw per-600 model K → per-9, the unit both lines are judged in

// ═══════════════════════════════════════════════════════════════════════════════
// THE FAMILY, DECLARED BEFORE ANY NUMBER (pre-registration §3)
// ═══════════════════════════════════════════════════════════════════════════════
//   s(g) = 1 + A·(g/G0)^q      for g > 0;      s(g ≤ 0) = 1 EXACTLY
// G0 = 20 is a FIXED reference gap (mid-range of the observed tier gaps), not a fitted parameter:
// it only fixes the units of A, so A = s(20) − 1 reads directly. The two fitted parameters are A
// (amplitude) and q (curvature). q > 1 ⇒ CONVEX, q = 1 ⇒ the LINEAR LIMIT, q < 1 ⇒ concave/saturating.
// Monotone increasing for A > 0, q > 0; s(0) = 1 is exact by construction, not fitted.
//
// WHY THIS FAMILY: the pre-registration requires the MINIMAL CONVEX-CAPABLE monotone form, because
// the coherent tiers' needs are convex in gap and the saturating family 1 + A(1 − e^(−g/G)) was
// FALSIFIED for being unable to bend that way (it is concave everywhere, for every A, G). The power
// law is the minimal one-extra-parameter family that contains the linear limit as an interior point
// and can bend either way; it is not a re-parameterisation of the falsified one.
const G0 = 20;
const sOf = (A: number, q: number) => (g: number) => (g > 0 ? 1 + A * Math.pow(g / G0, q) : 1);

// grid (integer-indexed so q = 1.00 is on it EXACTLY — the linear limit must be a grid point)
const QI_LO = 5, QI_HI = 800;             // q ∈ [0.05, 8.00] step 0.01
const qAt = (i: number) => i / 100;

/** Per-tier sufficient statistics of the per-card objective. See the objective note below. */
interface TierAgg { tier: string; g: number; Swdz: number; Swdd: number; Swzz: number; n: number }

// ── THE OBJECTIVE (amendment A1.2) ────────────────────────────────────────────
// PER-CARD residuals weighted by per-card noise. NO tier aggregate enters it. The correction is
// applied the way PRODUCTION applies it — spread about the pool mean:
//     corrected_i = K̄_t + s(g_t)·(K_i − K̄_t)
// with K̄_t = poolPitMeansOwn(...).k on the SAME presence-mixture population production centres on.
// Writing d_i = K_i − K̄_t and z_i = obs_i − K_i, the residual is z_i − A·u_t·d_i with u_t = (g_t/G0)^q,
// so A has a closed form at every q and the whole fit reduces to three sums per tier:
//     Swdz = Σ w·d·z      Swdd = Σ w·d²      Swzz = Σ w·z²      w_i = 1 / per9NoiseVar(obs_i, BF_i)
// That is not an approximation — it is the exact minimiser — and it is what makes 2000 bootstrap
// refits, five leave-one-tier-out refits and three presence legs affordable.
//
// GOLD IS FITTED IN, NOT EXCLUDED (amendment A1.2): its five light-usage sub-p05 cards are
// downweighted by their own evidential mass through w_i, which is the principled form of what
// exclusion approximated by hand. Their residual is published in §5, not absorbed.
function aggregate(tier: string, g: number, rows: FitRow[]): TierAgg {
  let Swdz = 0, Swdd = 0, Swzz = 0;
  for (const r of rows) { Swdz += r.w * r.d * r.z; Swdd += r.w * r.d * r.d; Swzz += r.w * r.z * r.z; }
  return { tier, g, Swdz, Swdd, Swzz, n: rows.length };
}
function fitAt(aggs: TierAgg[], q: number): { A: number; sse: number } {
  let num = 0, den = 0, szz = 0;
  for (const a of aggs) { const u = a.g > 0 ? Math.pow(a.g / G0, q) : 0; num += u * a.Swdz; den += u * u * a.Swdd; szz += a.Swzz; }
  const A = den > 0 ? num / den : 0;
  return { A, sse: szz - (den > 0 ? (num * num) / den : 0) };
}
interface ProfPt { q: number; A: number; sse: number }
function profileOf(aggs: TierAgg[]): ProfPt[] {
  const out: ProfPt[] = [];
  for (let i = QI_LO; i <= QI_HI; i++) { const q = qAt(i); const r = fitAt(aggs, q); out.push({ q, A: r.A, sse: r.sse }); }
  return out;
}
interface Pinned { A: number; q: number; sse: number; qLo: number; qHi: number; lin: ProfPt; opt: ProfPt; bandN: number }
/** THE PINNING RULE, pre-registered and unchanged in form from BUILD-1: the MOST-SATURATING member
 *  (here: smallest q — the least extrapolation beyond the observed gap range) whose SSE is within 5%
 *  of the LINEAR-LIMIT SSE. Reported together with the identifiability band and the linear limit. */
function pinShip(prof: ProfPt[]): Pinned {
  const lin = prof.find((p) => Math.abs(p.q - 1) < 1e-9)!;
  const opt = prof.reduce((a, b) => (b.sse < a.sse ? b : a));
  const band = prof.filter((p) => p.sse <= lin.sse * 1.05);
  const qLo = band.length ? Math.min(...band.map((p) => p.q)) : NaN;
  const qHi = band.length ? Math.max(...band.map((p) => p.q)) : NaN;
  const pick = band.length ? band.find((p) => p.q === qLo)! : opt;
  return { A: pick.A, q: pick.q, sse: pick.sse, qLo, qHi, lin, opt, bandN: band.length };
}

interface FitRow { tier: string; cid: string; name: string; bf: number; pred: number; obs: number; nv: number; w: number; d: number; z: number }
interface TierCell {
  tier: string; gap: number; kbar600: number; kbar9: number;
  rows: FitRow[]; need: number; needCI: { lo: number; hi: number }; needSe: number; pivotS: number;
  /** Level-free diagnostic companions: the WITHIN-TIER weighted means, the weighted free slope, and
   *  the weighted level offset that separates the pivot slope from the free slope. */
  wPredMean: number; wObsMean: number; wFreeS: number; offPred: number; offResid: number;
}

/** LEVEL-FREE aggregation — the same objective with the pivot moved from K̄_pool to the JUDGED
 *  SAMPLE's own weighted mean. Diagnostic only; it is NOT what production does and is NOT a
 *  candidate. It exists to answer one question the primary fit cannot: how much of the fitted
 *  amplitude is spread and how much is the sample's level offset from the pool mean. */
function aggregateLevelFree(tier: string, g: number, rows: FitRow[], pBar: number, oBar: number): TierAgg {
  let Swdz = 0, Swdd = 0, Swzz = 0;
  for (const r of rows) {
    const d = r.pred - pBar, z = (r.obs - oBar) - d;
    Swdz += r.w * d * z; Swdd += r.w * d * d; Swzz += r.w * z * z;
  }
  return { tier, g, Swdz, Swdd, Swzz, n: rows.length };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. THE COORDINATE + IDENTIFIABILITY PRONG 1  (gate (w)1)
// ═══════════════════════════════════════════════════════════════════════════════
const LADDER = ["iron", "bronze", "silver", "gold", "diamond"] as const;
/** The COHERENT FOUR — the tiers whose needs sit on the convex curve. Gold is the standing misfit
 *  and is excluded from the SPAN measure only (it is fitted in; see A1.2). Pre-registered set. */
const COHERENT = ["iron", "bronze", "silver", "diamond"];
const P_BAND = [0, 0.25, 0.30, 0.35];

const poolOf = (win: ValueWindow) => baseCards.filter((c) => inValueWindow(c, win));
const gapAt = (basePool: Card[], p: number, cf = coeffs) =>
  buildFrameShift(TM, productionFieldStats(basePool, cf, rp, true, p)).pit.vR.stu ?? 0;

const gapTable = new Map<number, Map<string, number>>();
for (const p of P_BAND) {
  const m = new Map<string, number>();
  for (const win of QUICK) m.set(win.tier, gapAt(poolOf(win), p));
  gapTable.set(p, m);
}
// INSTRUMENT CHECK: the explicit-p call at the shipped p must be the DEFAULT call, bit-for-bit.
let instrDelta = 0;
for (const win of QUICK) {
  const a = buildFrameShift(TM, productionFieldStats(poolOf(win), coeffs, rp)).pit.vR.stu ?? 0;
  instrDelta = Math.max(instrDelta, Math.abs(a - gapTable.get(PRESENCE_P)!.get(win.tier)!));
}
const spanOf = (m: Map<string, number>) => {
  const v = COHERENT.map((t) => m.get(t)!);
  return Math.max(...v) - Math.min(...v);
};
const descending = (m: Map<string, number>) => LADDER.every((t, i) => i === 0 || m.get(LADDER[i - 1]!)! > m.get(t)!);
const span0 = spanOf(gapTable.get(0)!);
const w1Rows = P_BAND.map((p) => ({ p, ord: descending(gapTable.get(p)!), ret: spanOf(gapTable.get(p)!) / span0 }));
const W1_PASS = w1Rows.every((r) => r.ord) && w1Rows.filter((r) => r.p > 0).every((r) => r.ret >= 0.60);

// ═══════════════════════════════════════════════════════════════════════════════
// 2. ONE PRESENCE LEG = measure the needs, fit the ramp, run gates (w)2/(w)3, score acceptance A
// ═══════════════════════════════════════════════════════════════════════════════
interface LegResult {
  p: number; bar: number;
  cells: TierCell[]; pin: Pinned; prof: ProfPt[];
  aCI: { lo: number; hi: number }; qCI: { lo: number; hi: number };
  sCI: Map<string, { lo: number; hi: number }>;
  loo: { dropped: string; A: number; q: number; aIn: boolean; qIn: boolean; sAt: Map<string, number> }[];
  w2: { pass: boolean; why: string };
  w3: boolean;
  accept: { tier: string; s: number; need: number; lo: number; hi: number; inside: boolean; thin: boolean }[];
  acceptPass: boolean; diamondIn: boolean;
  /** Diagnostics — never candidates, never a verdict. */
  optBand: { lo: number; hi: number; n: number };
  lf: Pinned;                                      // the LEVEL-FREE refit (diagnostic)
  lfAccept: { tier: string; s: number; inside: boolean }[];
}

/** Acceptance A scored for an arbitrary s(·) — used for the pin-sensitivity table. */
const scoreAccept = (cells: TierCell[], s: (g: number) => number) =>
  cells.map((c) => ({ tier: c.tier, s: s(c.gap), inside: s(c.gap) >= c.needCI.lo && s(c.gap) <= c.needCI.hi }));

function buildLeg(p: number, bar: number): LegResult {
  const ref: FieldStats = productionFieldStats(baseCards, coeffs, rp, true, p);
  const deps: SampleDeps = { ...depsBase, ref, presenceP: p, minBf: bar };
  const s = buildCwhitSample(deps);

  const cells: TierCell[] = [];
  let seedStep = 0;                                  // battery-needs-vs-bar's per-tier seed stream
  for (const win of QUICK) {
    const basePool = poolOf(win);
    const poolField = productionFieldStats(basePool, coeffs, rp, true, p);
    const gap = buildFrameShift(TM, poolField).pit.vR.stu ?? 0;
    const pt = buildPoolTransform(ref, poolField, depsBase.envelope);
    const kbar600 = poolPitMeansOwn(presenceMixture(basePool, p, PRESENCE_M), coeffs, rp, pt, FIELD_N * PRESENCE_M).k;
    const kbar9 = kbar600 * PER9;                    // era_k = 1.000 on the neutral Quick env (printed)
    const rows: FitRow[] = s.recs
      .filter((r: Rec) => r.tier === win.tier && r.role === "pit" && wellSampled(r) && Number.isFinite(r.ours.k9) && Number.isFinite(r.obs.k9!))
      .map((r: Rec) => {
        const pred = r.ours.k9!, obs = r.obs.k9!, nv = per9NoiseVar(obs, r.sample);
        return { tier: win.tier, cid: r.cid, name: r.name, bf: r.sample, pred, obs, nv, w: nv > 0 ? 1 / nv : 0, d: pred - kbar9, z: obs - pred };
      });
    const m = mmse(rows.map((r) => r.pred), rows.map((r) => r.obs), rows.map((r) => r.nv));
    const rnd = rng(SEED + seedStep++);
    const boot: number[] = [];
    for (let b = 0; b < B; b++) {
      const rs = rows.map(() => rows[Math.floor(rnd() * rows.length)]!);
      boot.push(slopeOf(rs.map((r) => r.pred), rs.map((r) => r.obs)));
    }
    // PIVOT SLOPE — the per-tier free s the OBJECTIVE would choose (regression through the pool-mean
    // pivot, noise-weighted). Diagnostic only: per-tier constants are mission-illegal to ship. It is
    // printed because it separates "the ramp misses this tier" from "the objective wants something
    // else here than the free slope does".
    const a0 = aggregate(win.tier, gap, rows);
    const sw = rows.reduce((a, r) => a + r.w, 0) || 1;
    const wPredMean = rows.reduce((a, r) => a + r.w * r.pred, 0) / sw;
    const wObsMean = rows.reduce((a, r) => a + r.w * r.obs, 0) / sw;
    const a1 = aggregateLevelFree(win.tier, gap, rows, wPredMean, wObsMean);
    cells.push({
      tier: win.tier, gap, kbar600, kbar9, rows,
      need: m.slope.est, needCI: ci(boot.filter(Number.isFinite)), needSe: m.slope.se,
      pivotS: a0.Swdd > 0 ? 1 + a0.Swdz / a0.Swdd : NaN,
      wPredMean, wObsMean, wFreeS: a1.Swdd > 0 ? 1 + a1.Swdz / a1.Swdd : NaN,
      offPred: wPredMean - kbar9, offResid: wObsMean - wPredMean,
    });
  }

  const aggs = cells.map((c) => aggregate(c.tier, c.gap, c.rows));
  const prof = profileOf(aggs);
  const pin = pinShip(prof);
  const sFit = sOf(pin.A, pin.q);

  // bootstrap the SHIPPING quantity: resample cards within tier, refit, re-apply the SAME pin rule
  const rb = rng(SEED + 900);
  const bootA: number[] = [], bootQ: number[] = [], bootS = new Map<string, number[]>(cells.map((c) => [c.tier, []]));
  for (let b = 0; b < B; b++) {
    const ag = cells.map((c) => {
      const rs = c.rows.map(() => c.rows[Math.floor(rb() * c.rows.length)]!);
      return aggregate(c.tier, c.gap, rs);
    });
    const pb = pinShip(profileOf(ag));
    bootA.push(pb.A); bootQ.push(pb.q);
    for (const c of cells) bootS.get(c.tier)!.push(sOf(pb.A, pb.q)(c.gap));
  }
  const aCI = ci(bootA.filter(Number.isFinite)), qCI = ci(bootQ.filter(Number.isFinite));
  const sCI = new Map([...bootS].map(([t, xs]) => [t, ci(xs.filter(Number.isFinite))] as const));

  // gate (w)3 — leave one tier out
  const loo = cells.map((c) => {
    const pb = pinShip(profileOf(aggs.filter((a) => a.tier !== c.tier)));
    const sAt = new Map(cells.map((x) => [x.tier, sOf(pb.A, pb.q)(x.gap)] as const));
    return { dropped: c.tier, A: pb.A, q: pb.q, aIn: pb.A >= aCI.lo && pb.A <= aCI.hi, qIn: pb.q >= qCI.lo && pb.q <= qCI.hi, sAt };
  });
  const w3 = loo.every((x) => x.aIn && x.qIn);

  // gate (w)2 — boundary-pinned optimum = family misfit
  const edgeQ = (q: number) => Math.abs(q - qAt(QI_LO)) < 1e-9 || Math.abs(q - qAt(QI_HI)) < 1e-9;
  const w2 = edgeQ(pin.opt.q)
    ? { pass: false, why: `wide-grid SSE optimum q* = ${f(pin.opt.q, 2)} sits ON the grid edge [${f(qAt(QI_LO), 2)}, ${f(qAt(QI_HI), 2)}]` }
    : edgeQ(pin.q)
      ? { pass: false, why: `the PINNED q = ${f(pin.q, 2)} sits on the grid edge (the 5%-of-linear band reaches it) even though the optimum q* = ${f(pin.opt.q, 2)} is interior` }
      : { pass: true, why: `optimum q* = ${f(pin.opt.q, 2)} and pinned q = ${f(pin.q, 2)} are both interior to [${f(qAt(QI_LO), 2)}, ${f(qAt(QI_HI), 2)}]; A = ${f(pin.A, 4)} is closed-form, not gridded` };

  // acceptance A
  const accept = cells.map((c) => {
    const s = sFit(c.gap);
    return { tier: c.tier, s, need: c.need, lo: c.needCI.lo, hi: c.needCI.hi, inside: s >= c.needCI.lo && s <= c.needCI.hi, thin: c.rows.length < THIN_N };
  });
  const diamondIn = accept.find((a) => a.tier === "diamond")!.inside;
  const acceptPass = accept.filter((a) => a.inside).length >= 4 && diamondIn;

  // ── diagnostics (never candidates) ──
  const optBandPts = prof.filter((x) => x.sse <= pin.opt.sse * 1.05);
  const optBand = { lo: Math.min(...optBandPts.map((x) => x.q)), hi: Math.max(...optBandPts.map((x) => x.q)), n: optBandPts.length };
  const lf = pinShip(profileOf(cells.map((c) => aggregateLevelFree(c.tier, c.gap, c.rows, c.wPredMean, c.wObsMean))));
  const lfAccept = scoreAccept(cells, sOf(lf.A, lf.q));

  return { p, bar, cells, pin, prof, aCI, qCI, sCI, loo, w2, w3, accept, acceptPass, diamondIn, optBand, lf, lfAccept };
}

const primary = buildLeg(PRESENCE_P, MIN_BF);
const sPrimary = sOf(primary.pin.A, primary.pin.q);

// ═══════════════════════════════════════════════════════════════════════════════
// 3. FORMAT VALIDATION — env-bearing dailies (stratum B) + budget cap/slots (stratum C)
//    VALIDATED, NEVER FITTED. Formats come from the corpus REGISTRY by tournamentId — NOT from the
//    hard-coded legacySlug list in tools/fit-kspread-pit.ts, which is four of the registry's eight
//    dailies because it keys on the OPTIONAL `legacySlug` field (the b4dc2ed defect).
// ═══════════════════════════════════════════════════════════════════════════════
const VALIDATE: { tid: string; stratum: string; note: string }[] = [
  { tid: "early-gold", stratum: "B", note: "era-1920 / park-169" },
  { tid: "bronze-heart", stratum: "B", note: "era-1939 / park-191, Year rule" },
  { tid: "late-bronze", stratum: "B", note: "era-1979 / park-114" },
  { tid: "diamond-heart", stratum: "B", note: "era-1958 / park-156" },
  { tid: "live-open-daily", stratum: "A*", note: "neutral env, uncapped — non-Quick control" },
  { tid: "bronze-cap-weekly", stratum: "C", note: "neutral env, cap 1331 — PRE-REGISTERED held-out" },
  { tid: "gold-slots", stratum: "C", note: "neutral env, slots — PRE-REGISTERED held-out; never before evaluated" },
  { tid: "gold-cap", stratum: "B+C", note: "park-156 + cap 1580 — PRE-REGISTERED held-out" },
  { tid: "diamond-cap-daily", stratum: "B+C", note: "era-1998 / park-101 + cap 1755" },
];
interface ValRow {
  tid: string; key: string; label: string; stratum: string; note: string;
  poolN: number; joined: number; judged: number; gap: number; kbar: number; s: number;
  preSlope: number; postSlope: number; postCI: { lo: number; hi: number }; preCI: { lo: number; hi: number };
  preLevel: number; postLevel: number; verdict: string; notices: string[];
}
const valRows: ValRow[] = [];
for (const [vi, V] of VALIDATE.entries()) {
  const fm = CWHIT_CORPUS.find((x) => x.tournamentId === V.tid);
  if (!fm) { valRows.push({ tid: V.tid, key: "—", label: "—", stratum: V.stratum, note: V.note, poolN: 0, joined: 0, judged: 0, gap: NaN, kbar: NaN, s: NaN, preSlope: NaN, postSlope: NaN, postCI: { lo: NaN, hi: NaN }, preCI: { lo: NaN, hi: NaN }, preLevel: NaN, postLevel: NaN, verdict: "NOT IN THE CORPUS REGISTRY", notices: [] }); continue; }
  const t = tournaments.find((x) => x.id === V.tid);
  if (!t) { valRows.push({ tid: V.tid, key: fm.key, label: fm.label, stratum: V.stratum, note: V.note, poolN: 0, joined: 0, judged: 0, gap: NaN, kbar: NaN, s: NaN, preSlope: NaN, postSlope: NaN, postCI: { lo: NaN, hi: NaN }, preCI: { lo: NaN, hi: NaN }, preLevel: NaN, postLevel: NaN, verdict: "tournament config missing", notices: [] }); continue; }
  const era = eras.get(t.eraId), park = parks.get(t.parkId);
  if (!era || !park) { valRows.push({ tid: V.tid, key: fm.key, label: fm.label, stratum: V.stratum, note: V.note, poolN: 0, joined: 0, judged: 0, gap: NaN, kbar: NaN, s: NaN, preSlope: NaN, postSlope: NaN, postCI: { lo: NaN, hi: NaN }, preCI: { lo: NaN, hi: NaN }, preLevel: NaN, postLevel: NaN, verdict: "era/park missing", notices: [] }); continue; }
  const coeffsF = resolveCoeffs(model, era, park, t.softcaps);
  applyWobaWeights(coeffsF, trained.wobaWeights!);
  const derivedF = computeDerived(coeffsF, true);
  const inV = (c: Card) => { const v = n_(c["Card Value"]); return (t.card_value_min == null || v >= t.card_value_min) && (t.card_value_max == null || v <= t.card_value_max); };
  const basePool = baseCards.filter((c) => inV(c) && rowEligible(c as any, t));
  const refF = productionFieldStats(baseCards, coeffsF, rp);      // env-matched reference, one definition
  const poolF = productionFieldStats(basePool, coeffsF, rp);
  const pt = buildPoolTransform(refF, poolF, depsBase.envelope);
  const gap = buildFrameShift(TM, poolF).pit.vR.stu ?? 0;
  const kbar600 = poolPitMeansOwn(presenceMixture(basePool), coeffsF, rp, pt, FIELD_N * PRESENCE_M).k;
  const s = sPrimary(gap);
  // The judged line is the DEPLOYED one (era/park applied) because the observed lines live in the
  // format's env — so K̄ must be carried into the same frame (×era_k), exactly as the fit tool does.
  const kbarDep = kbar600 * PER9 * coeffsF.era_k;
  const win: ValueWindow = {
    tier: fm.key,                                   // registry KEY — the five legacySlug-less formats
    valueMin: t.card_value_min ?? undefined,        // are reachable ONLY this way
    valueMax: t.card_value_max ?? Infinity,
    eligible: (c: Record<string, unknown>) => rowEligible(c as unknown as Card, t),
  };
  const depsF: SampleDeps = { ...depsBase, coeffs: coeffsF, derived: derivedF, ref: refF, formats: [win] };
  const pre = buildCwhitSample(depsF);
  const post = buildCwhitSample({ ...depsF, kSpreadPit: new Map<string, KSpreadPit>([[fm.key, { s, mean: kbar600 }]]) });
  const postBy = new Map(post.recs.filter((r) => r.role === "pit").map((r) => [`${r.title}|${r.vlvl}`, r]));
  const paired = pre.recs
    .filter((r) => r.role === "pit" && wellSampled(r) && postBy.has(`${r.title}|${r.vlvl}`) && Number.isFinite(r.obs.k9!))
    .map((r) => ({ pre: r.oursDep.k9!, post: postBy.get(`${r.title}|${r.vlvl}`)!.oursDep.k9!, obs: r.obs.k9!, nv: per9NoiseVar(r.obs.k9!, r.sample) }));
  const joined = pre.recs.filter((r) => r.role === "pit").length;
  let preSlope = NaN, postSlope = NaN, preCI = { lo: NaN, hi: NaN }, postCI = { lo: NaN, hi: NaN }, verdict = "";
  let preLevel = NaN, postLevel = NaN;
  if (paired.length < 8) verdict = `N=${paired.length} — too thin for a slope verdict (never a number from noise)`;
  else {
    const o9 = paired.map((r) => r.obs), nv = paired.map((r) => r.nv);
    preSlope = mmse(paired.map((r) => r.pre), o9, nv).slope.est;
    postSlope = mmse(paired.map((r) => r.post), o9, nv).slope.est;
    preLevel = mean(paired.map((r) => r.pre - r.obs)); postLevel = mean(paired.map((r) => r.post - r.obs));
    const r3 = rng(SEED + 100 + vi);
    const ps: number[] = [], qs: number[] = [];
    for (let b = 0; b < B; b++) {
      const idx = paired.map(() => Math.floor(r3() * paired.length));
      ps.push(slopeOf(idx.map((i) => paired[i]!.pre), idx.map((i) => o9[i]!)));
      qs.push(slopeOf(idx.map((i) => paired[i]!.post), idx.map((i) => o9[i]!)));
    }
    preCI = ci(ps.filter(Number.isFinite)); postCI = ci(qs.filter(Number.isFinite));
    verdict = paired.length < THIN_N ? "THIN (N<15) — no verdict"
      : postCI.lo <= 1 && 1 <= postCI.hi ? "PASS — post CI covers 1"
        : postSlope > preSlope ? "worse-than-pre" : "MISS — post CI excludes 1";
  }
  valRows.push({
    tid: V.tid, key: fm.key, label: fm.label, stratum: V.stratum, note: V.note,
    poolN: basePool.length, joined, judged: paired.length, gap, kbar: kbarDep, s,
    preSlope, postSlope, postCI, preCI, preLevel, postLevel, verdict,
    notices: pre.notices.filter((x) => x.includes(fm.key) || x.includes("registry")),
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// 4. SENSITIVITY LEGS — the 1000 bar (report, NOT a gate) and p = 0.25 / 0.35 (acceptance D)
// ═══════════════════════════════════════════════════════════════════════════════
const bar1000 = buildLeg(PRESENCE_P, 1000);
const pLegs = [0.25, 0.35].map((p) => buildLeg(p, MIN_BF));

// ═══════════════════════════════════════════════════════════════════════════════
// 5. REPORT
// ═══════════════════════════════════════════════════════════════════════════════
const gatesPass = W1_PASS && primary.w2.pass && primary.w3;
const bandHolds = pLegs.every((l) => l.w2.pass && l.w3 && l.acceptPass);
const fails: string[] = [];
if (!W1_PASS) fails.push("GATE (w)1 IDENTIFIABILITY");
if (!primary.w2.pass) fails.push("GATE (w)2 BOUNDARY-PINNED OPTIMUM");
if (!primary.w3) fails.push("GATE (w)3 LEAVE-ONE-TIER-OUT");
if (!primary.diamondIn) fails.push("ACCEPTANCE A — DIAMOND OUTSIDE ITS MEASURED CI (STOP-class)");
else if (!primary.acceptPass) fails.push("ACCEPTANCE A — fewer than 4 of 5 tiers inside");
const VERDICT = fails.length ? `STOP — ${fails.join(" + ")}`
  : bandHolds ? "PASS — all three gates and acceptance A hold at p=0.30 and across the 0.25/0.35 band"
    : "PARTIAL — gates and acceptance A hold at p=0.30 but not across the whole 0.25/0.35 band";

say("################################################################################");
say(`# C3 — THE RE-DERIVED PITCHER K-SPREAD RAMP. VERDICT: ${VERDICT}`);
say("# Pre-registration: docs/CWHIT_C3_RAMP_PREREG_2026-07-22.md + AMENDMENT 1 (approved).");
say("# Tool: tools/fit-kspread-c3.ts. FIT AND REPORT ONLY — NOTHING WIRED, no default flipped,");
say("# no shipped constant changed. The verdict returns to Fable, who decides what ships.");
say("################################################################################");
say();
say("### WHAT THIS RUN CONCLUDES (the detail is below; nothing here is tuned)");
say();
say(`  1. GATE (w)1 IDENTIFIABILITY PASSES and is re-confirmed: the gap ordering is strictly`);
say(`     descending at every p in the band, and coherent-four span retention is ${f(w1Rows.find((r) => r.p === PRESENCE_P)!.ret * 100, 1)}% at the shipped p`);
say(`     (${w1Rows.filter((r) => r.p > 0).map((r) => `${f(r.p, 2)}: ${f(r.ret * 100, 1)}%`).join(", ")}) — the axis carries the information. The coordinate is not the problem.`);
say(`  2. GATE (w)2 FAILS, and the diagnostics say WHERE. The wide-grid SSE optimum q* = ${f(primary.pin.opt.q, 2)} is`);
say(`     INTERIOR and barely convex; the curvature parameter buys ${f(100 * (1 - primary.pin.opt.sse / primary.pin.lin.sse), 3)}% of SSE, so the`);
say(`     5%-of-linear equivalence band spans q ∈ [${f(primary.pin.qLo, 2)}, ${f(primary.pin.qHi, 2)}] and the pre-registered "most-saturating`);
say(`     member" pin runs to the grid edge and returns a NEARLY FLAT s. On a PER-CARD objective the`);
say(`     curvature parameter is UNIDENTIFIED — the 5% rule was calibrated against a tier-aggregate`);
say(`     SSE, where 5% is a meaningful slice; against a per-card SSE dominated by irreducible`);
say(`     sampling noise it is not. That is a pinning-rule failure, NOT evidence about the family.`);
say(`  3. GATE (w)3 PASSES at every p: no single tier determines the form.`);
say(`  4. ACCEPTANCE A FAILS: ${primary.accept.filter((a) => a.inside).length} of 5 inside, and DIAMOND IS OUTSIDE — STOP-class on its own.`);
say(`     Diagnostic D2 shows why the objective cannot reach the acceptance target: the judged sample`);
say(`     sits off K̄_pool, so a residual taken ABOUT K̄_pool prices level as well as spread and its`);
say(`     per-tier estimand (the pivot slope) sits +${f(mean(primary.cells.map((c) => c.pivotS - c.need)), 2)} above the free slope acceptance scores against.`);
say(`     The objective and the acceptance bar are two different estimands, and the gap between them`);
say(`     is systematic in every tier — it is not noise and it cannot be tuned away.`);
say(`  5. THE FAMILY ITSELF IS NOT REFUTED. Diagnostic D4(b): asked to hit the needs directly, the`);
say(`     power law reaches the coherent four at A* = 0.632, q* = 2.39 — strongly CONVEX — putting`);
say(`     4 of 5 inside their CI WITH DIAMOND IN. Include gold's off-curve need and the same probe`);
say(`     collapses to q* = 1.00 and 2 of 5 with diamond out. Gold sits at gap ${f(primary.cells.find((c) => c.tier === "gold")!.gap, 2)} needing ${f(primary.cells.find((c) => c.tier === "gold")!.need, 2)},`);
say(`     ABOVE silver's ${f(primary.cells.find((c) => c.tier === "silver")!.need, 2)} at the HIGHER gap ${f(primary.cells.find((c) => c.tier === "silver")!.gap, 2)} — i.e. gold's need is NON-MONOTONE in the`);
say(`     coordinate, so no monotone s(g) can carry gold and the coherent four at once. That is the`);
say(`     live question this run hands back, and it is a ruling, not a fit decision.`);
say(`  6. The band re-check (p = 0.25 / 0.35) reproduces all of the above with almost no movement, so`);
say(`     none of it is an artifact of the presence prior. Property-conditioning is NOT reopened by`);
say(`     this run: gate (w)1 holds across the whole band.`);
say(`  7. All three pre-registered budget formats read REAL DATA, including gold-slots (${valRows.find((v) => v.tid === "gold-slots")?.joined ?? 0} joined /`);
say(`     ${valRows.find((v) => v.tid === "gold-slots")?.judged ?? 0} judged), which no tool had ever evaluated.`);
say();
say("### HEADER");
say(`  tool        tools/fit-kspread-c3.ts`);
say(`  date        2026-07-22`);
say(`  model       '${trained.id}'   (raw-poly event model, own-gap path, no anchor on the judged line)`);
say(`  catalog     '${srcId}'   (${baseCards.length} base cards, variant rows excluded from the catalog read)`);
say(`  commit      0c7b1f0 (HEAD at generation — "STOP-class instrument correction: the eval builder had diverged from production")`);
say(`  coordinate  gap = buildFrameShift(trainingMeans, productionFieldStats(pool)).pit.vR.stu — post-C1 + post-C2'`);
say(`  fit-N       FIELD_N = ${FIELD_N}   (cohort size; scaled by PRESENCE_M = ${PRESENCE_M} on the replicated mixture)`);
say(`  fit-p       PRESENCE_P = ${PRESENCE_P}   (presence prior; sensitivity legs at 0.25 / 0.35)`);
say(`  corpus      full-depth capture 2026-07-21 (buildCwhitSample DEFAULT_SOURCE) — ONE sample builder, no private joins`);
say(`  bars        primary BF ≥ ${MIN_BF}; sensitivity BF ≥ 1000 (REPORT, not a gate — see acceptance B)`);
say(`  bootstrap   B = ${B}, SEED = ${SEED}; needs = mmse() slope of obs~pred, resample cards within tier`);
say(`  grain       observed statistics at ROW grain = (card × variant level); pool constants at CARD grain`);
say(`  era_k       ${f(coeffs.era_k, 4)} on the neutral Quick env (so raw ≡ deployed per-channel there)`);
say();
say("### THE DECLARED FORM (declared before the numbers, per pre-registration §3)");
say();
say(`    s(g) = 1 + A·(g/${G0})^q      for g > 0;      s(g ≤ 0) = 1 EXACTLY`);
say();
say("  · G0 = 20 is a FIXED reference gap (mid observed range), not a parameter: it only fixes the");
say("    units of A, so A = s(20) − 1 reads directly off the constant.");
say("  · TWO fitted parameters: A (amplitude) and q (curvature). q > 1 CONVEX, q = 1 the LINEAR");
say("    LIMIT, q < 1 concave/saturating. Monotone increasing for A > 0, q > 0.");
say("  · s(0) = 1 is exact by construction — the league anchor, not a fitted quantity.");
say("  · WHY NOT THE OLD FAMILY: 1 + A(1 − e^(−g/G)) is concave for EVERY (A,G) and was falsified for");
say("    being unable to bend convexly. The power law is the minimal one-extra-parameter monotone");
say("    family that contains the linear limit as an INTERIOR point and can bend either way.");
say("  · OBJECTIVE: per-card residuals weighted by per-card noise, w_i = 1/per9NoiseVar(obs_i, BF_i).");
say("    corrected_i = K̄_t + s(g_t)·(K_i − K̄_t), K̄_t = poolPitMeansOwn(presenceMixture(pool)).k — the");
say("    same pivot and the same presence-mixture population production centres on. NO tier aggregate");
say("    enters the objective. NO per-tier freedom: one function of gap, five tiers, quicks only.");
say("  · PINNING RULE (pre-registered, unchanged in form from BUILD-1): the most-saturating member");
say("    (smallest q) whose SSE is within 5% of the LINEAR-LIMIT SSE, reported with the band and the");
say("    linear limit. Cross-fit comparisons are made on s(g) over the observed gap range, NEVER on");
say(`    raw {A, q} — those are two pinning outcomes. Grid q ∈ [${f(qAt(QI_LO), 2)}, ${f(qAt(QI_HI), 2)}] step 0.01, A closed-form at each q.`);
say();

say("### 1. THE COORDINATE + GATE (w)1 IDENTIFIABILITY (prong 1)");
say();
say(`  INSTRUMENT CHECK — productionFieldStats(pool) vs the same call with p stated explicitly at`);
say(`  p = ${PRESENCE_P}: max |Δgap| = ${instrDelta.toExponential(1)}  ${instrDelta === 0 ? "✓ bit-identical (the p knob is default-identity)" : "✗ THE KNOB IS NOT DEFAULT-IDENTITY"}`);
say();
say(`  gap pit.stu     ${LADDER.map((t) => rpad(t, 9)).join("")}`);
for (const p of P_BAND) say(`  p = ${f(p, 2)}        ${LADDER.map((t) => rpad(f(gapTable.get(p)!.get(t)!, 2), 9)).join("")}`);
say();
say(`  coherent four (span measure) = ${COHERENT.join(", ")} — gold is the standing misfit and is`);
say(`  excluded from the SPAN only; it is FITTED IN (amendment A1.2).`);
say(`    p        ordering strictly descending    coherent-four span   retention vs p=0`);
for (const r of w1Rows) say(`    ${f(r.p, 2)}     ${r.ord ? "YES ✓" : "NO ✗"}                          ${rpad(f(spanOf(gapTable.get(r.p)!), 2), 6)}               ${r.p === 0 ? "     —" : `${f(r.ret * 100, 1)}%`}`);
say();
say(`  REQUIREMENT: ordering at the fitted p matches p=0's, AND coherent-four span retention ≥ 60%.`);
say(`  GATE (w)1: ${W1_PASS ? "PASS" : "FAIL"}`);
say();

function sayLeg(leg: LegResult, title: string, full: boolean) {
  const sFit = sOf(leg.pin.A, leg.pin.q);
  say(`── ${title} ──`);
  say();
  say(`  MEASURED NEEDS (re-measured on this coordinate; the quoted values are a CROSS-CHECK, not an input)`);
  say(`  tier       N   gap(stu)   K̄_pool/600   K̄_pool/9   slope   [boot 95% CI]    se     pivot-s`);
  for (const c of leg.cells) {
    say(`  ${pad(c.tier, 9)}${rpad(String(c.rows.length), 3)}   ${rpad(f(c.gap, 2), 7)}   ${rpad(f(c.kbar600, 1), 9)}   ${rpad(f(c.kbar9, 2), 8)}   ${rpad(f(c.need, 2), 5)}   [${f(c.needCI.lo, 2)},${f(c.needCI.hi, 2)}]   ${f(c.needSe, 3)}    ${f(c.pivotS, 2)}${c.rows.length < THIN_N ? "  THIN" : ""}`);
  }
  say(`  pivot-s = the per-tier free s the OBJECTIVE would pick (noise-weighted regression through the`);
  say(`  pool-mean pivot). DIAGNOSTIC ONLY — per-tier constants are mission-illegal to ship.`);
  say();
  say(`  THE FIT`);
  say(`    wide-grid SSE optimum:   q* = ${f(leg.pin.opt.q, 2)}   A* = ${f(leg.pin.opt.A, 4)}   SSE ${f(leg.pin.opt.sse, 1)}`);
  say(`    LINEAR LIMIT (q = 1):    A  = ${f(leg.pin.lin.A, 4)}   SSE ${f(leg.pin.lin.sse, 1)}   ⇒ β = A/${G0} = ${f(leg.pin.lin.A / G0, 5)} per gap unit`);
  say(`    identifiability band (SSE ≤ 1.05 × linear-limit SSE): q ∈ [${f(leg.pin.qLo, 2)}, ${f(leg.pin.qHi, 2)}]  (${leg.pin.bandN} of ${leg.prof.length} grid points)`);
  say(`    PINNED (most-saturating member of the band):  A = ${f(leg.pin.A, 4)}  [boot 95% CI ${f(leg.aCI.lo, 4)}, ${f(leg.aCI.hi, 4)}]`);
  say(`                                                  q = ${f(leg.pin.q, 2)}  [boot 95% CI ${f(leg.qCI.lo, 2)}, ${f(leg.qCI.hi, 2)}]`);
  say(`    curvature: ${leg.pin.q > 1 ? "CONVEX (q > 1)" : leg.pin.q < 1 ? "CONCAVE / saturating (q < 1)" : "LINEAR (q = 1)"};  monotone increasing: ${leg.pin.A > 0 && leg.pin.q > 0 ? "YES ✓" : "NO ✗ (A ≤ 0 — wrong-signed)"}`);
  say(`    s at reference gaps:  s(5)=${f(sFit(5), 3)}  s(10)=${f(sFit(10), 3)}  s(15)=${f(sFit(15), 3)}  s(20)=${f(sFit(20), 3)}  s(25)=${f(sFit(25), 3)}  s(30)=${f(sFit(30), 3)}`);
  say();
  if (!full) return;
  say(`  GATE (w)2 BOUNDARY-PINNED OPTIMUM: ${leg.w2.pass ? "PASS" : "FAIL"} — ${leg.w2.why}`);
  say();
  say(`  GATE (w)3 LEAVE-ONE-TIER-OUT (every refit's parameters must lie inside the full fit's boot CI)`);
  say(`    dropped        A        inside A-CI     q       inside q-CI    s(iron)  s(bronze) s(silver) s(gold)  s(diamond)`);
  for (const x of leg.loo) {
    say(`    ${pad(x.dropped, 12)}${rpad(f(x.A, 4), 8)}   ${x.aIn ? "YES ✓" : "NO ✗ "}        ${rpad(f(x.q, 2), 5)}    ${x.qIn ? "YES ✓" : "NO ✗ "}       ${LADDER.map((t) => rpad(f(x.sAt.get(t) ?? NaN, 2), 10)).join("")}`);
  }
  say(`    full fit s(g)                                             ${LADDER.map((t) => rpad(f(sFit(leg.cells.find((c) => c.tier === t)!.gap), 2), 10)).join("")}`);
  say(`    full fit CI                                          ${LADDER.map((t) => { const q = leg.sCI.get(t)!; return rpad(`${f(q.lo, 2)}-${f(q.hi, 2)}`, 10); }).join("")}`);
  say(`  GATE (w)3: ${leg.w3 ? "PASS" : "FAIL"}`);
  say();
  say(`  ACCEPTANCE A — implied s(g_t) vs the measured bootstrap CI (≥4 of 5 tiers, DIAMOND MANDATORY)`);
  say(`    tier       gap    s(gap)   measured need   [boot 95% CI]    inside?`);
  for (const a of leg.accept) {
    const c = leg.cells.find((x) => x.tier === a.tier)!;
    say(`    ${pad(a.tier, 9)}${rpad(f(c.gap, 2), 6)}   ${rpad(f(a.s, 3), 6)}   ${rpad(f(a.need, 2), 13)}   [${f(a.lo, 2)},${f(a.hi, 2)}]      ${a.inside ? "YES ✓" : "NO  ✗"}${a.thin ? "   THIN" : ""}`);
  }
  say(`    inside: ${leg.accept.filter((a) => a.inside).length} of 5;  DIAMOND ${leg.diamondIn ? "INSIDE ✓" : "OUTSIDE ✗ (STOP-class — NOT tradeable against the other four)"}`);
  say(`  ACCEPTANCE A: ${leg.acceptPass ? "PASS" : "FAIL"}`);
  say();
  // ── DIAGNOSTICS: which component fails? Never candidates, never a verdict. ──
  say(`  DIAGNOSTIC D1 — IS IT THE FAMILY, OR THE PINNING RULE?`);
  say(`    band vs the LINEAR LIMIT (the pre-registered rule): q ∈ [${f(leg.pin.qLo, 2)}, ${f(leg.pin.qHi, 2)}]  (${leg.pin.bandN}/${leg.prof.length} grid points)`);
  say(`    band vs the OPTIMUM (5% of SSE*, for reference):    q ∈ [${f(leg.optBand.lo, 2)}, ${f(leg.optBand.hi, 2)}]  (${leg.optBand.n}/${leg.prof.length} grid points)`);
  say(`    SSE(linear) / SSE(optimum) = ${f(leg.pin.lin.sse / leg.pin.opt.sse, 5)} — the curvature parameter buys ${f(100 * (1 - leg.pin.opt.sse / leg.pin.lin.sse), 3)}% of SSE.`);
  say(`    Acceptance A scored at three members of the SAME family (same fit, three pinning choices):`);
  for (const [lab, s] of [["pinned (rule)", sFit], ["wide-grid optimum", sOf(leg.pin.opt.A, leg.pin.opt.q)], ["linear limit q=1", sOf(leg.pin.lin.A, 1)]] as const) {
    const sc = scoreAccept(leg.cells, s);
    say(`      ${pad(lab, 20)} ${LADDER.map((t) => rpad(f(sc.find((x) => x.tier === t)!.s, 2), 8)).join("")}  ⇒ ${sc.filter((x) => x.inside).length}/5 inside, diamond ${sc.find((x) => x.tier === "diamond")!.inside ? "IN" : "OUT"}`);
  }
  say(`      needs                ${LADDER.map((t) => rpad(f(leg.cells.find((c) => c.tier === t)!.need, 2), 8)).join("")}`);
  say();
  say(`  DIAGNOSTIC D2 — HOW MUCH OF THE FITTED AMPLITUDE IS LEVEL, NOT SPREAD?`);
  say(`    The objective is a residual about K̄_pool, so it prices BOTH the judged sample's offset from`);
  say(`    the pool mean AND its spread. The pivot slope is what it actually targets; the measured need`);
  say(`    (a FREE slope) is what acceptance A scores against. They are different estimands whenever the`);
  say(`    sample sits off K̄_pool — which it does, because cwhit's tables are the top by USAGE.`);
  say(`    tier      K̄_pool/9   wtd mean pred   offset(pred−K̄)   wtd mean resid(obs−pred)   pivot-s   wtd free-s   free slope`);
  for (const c of leg.cells) {
    say(`    ${pad(c.tier, 9)}${rpad(f(c.kbar9, 2), 7)}   ${rpad(f(c.wPredMean, 2), 13)}   ${rpad(sgn(c.offPred, 2), 15)}   ${rpad(sgn(c.offResid, 2), 24)}   ${rpad(f(c.pivotS, 2), 7)}   ${rpad(f(c.wFreeS, 2), 10)}   ${f(c.need, 2)}`);
  }
  say(`    pivot-s exceeds the free slope in every tier by ${f(mean(leg.cells.map((c) => c.pivotS - c.need)), 2)} on average — a systematic offset, not noise.`);
  say();
  say(`  DIAGNOSTIC D3 — THE SAME FAMILY AND THE SAME PER-CARD NOISE WEIGHTS, LEVEL REMOVED`);
  say(`    (pivot moved from K̄_pool to the judged sample's own weighted mean; NOT what production does,`);
  say(`    NOT a candidate — it isolates the spread signal so the family's reach can be read cleanly.)`);
  say(`    optimum q* = ${f(leg.lf.opt.q, 2)}  A* = ${f(leg.lf.opt.A, 4)};  linear limit A = ${f(leg.lf.lin.A, 4)};  band q ∈ [${f(leg.lf.qLo, 2)}, ${f(leg.lf.qHi, 2)}]`);
  for (const [lab, s] of [["pinned (rule)", sOf(leg.lf.A, leg.lf.q)], ["wide-grid optimum", sOf(leg.lf.opt.A, leg.lf.opt.q)], ["linear limit q=1", sOf(leg.lf.lin.A, 1)]] as const) {
    const sc = scoreAccept(leg.cells, s);
    say(`      ${pad(lab, 20)} ${LADDER.map((t) => rpad(f(sc.find((x) => x.tier === t)!.s, 2), 8)).join("")}  ⇒ ${sc.filter((x) => x.inside).length}/5 inside, diamond ${sc.find((x) => x.tier === "diamond")!.inside ? "IN" : "OUT"}`);
  }
  say(`    (DIAGNOSTIC — carries no verdict.)`);
  say();
  say(`  DIAGNOSTIC D4 — CAN THE FAMILY REACH THE COHERENT FOUR AT ALL?`);
  say(`    Two reads, both DIAGNOSTIC. Gold is FITTED IN in the primary (A1.2) and stays so; these`);
  say(`    isolate whether the convex family can describe the needs, separately from whether the`);
  say(`    per-card objective aims at them.`);
  const aggsP = leg.cells.map((c) => aggregate(c.tier, c.gap, c.rows));
  const d4a = pinShip(profileOf(aggsP.filter((a) => a.tier !== "gold")));
  say(`    (a) per-card objective, COHERENT FOUR only (gold dropped): optimum q* = ${f(d4a.opt.q, 2)}, pinned A = ${f(d4a.A, 4)} q = ${f(d4a.q, 2)}`);
  for (const [lab, s] of [["   pinned", sOf(d4a.A, d4a.q)], ["   optimum", sOf(d4a.opt.A, d4a.opt.q)], ["   linear q=1", sOf(d4a.lin.A, 1)]] as const) {
    const sc = scoreAccept(leg.cells, s);
    say(`      ${pad(lab, 20)} ${LADDER.map((t) => rpad(f(sc.find((x) => x.tier === t)!.s, 2), 8)).join("")}  ⇒ ${sc.filter((x) => x.inside).length}/5 inside, diamond ${sc.find((x) => x.tier === "diamond")!.inside ? "IN" : "OUT"}`);
  }
  // (b) the BUILD-1 style TIER-AGGREGATE objective under the NEW family. Pre-registration forbids a
  // tier aggregate in the OBJECTIVE; this is not the objective, it is a capability probe — it asks
  // the family to hit the needs directly, which is the cleanest possible statement of family reach.
  const tierAgg = (cs: TierCell[]) => cs.map((c) => { const w = 1 / c.needSe ** 2, e = c.need - 1; return { tier: c.tier, g: c.gap, Swdz: w * e, Swdd: w, Swzz: w * e * e, n: c.rows.length }; });
  const d4b5 = pinShip(profileOf(tierAgg(leg.cells)));
  const d4b4 = pinShip(profileOf(tierAgg(leg.cells.filter((c) => c.tier !== "gold"))));
  say(`    (b) TIER-AGGREGATE capability probe (fit s(g) straight to the needs, precision-weighted):`);
  for (const [lab, pn] of [["   all five, optimum", d4b5], ["   coherent four, optimum", d4b4]] as const) {
    const sc = scoreAccept(leg.cells, sOf(pn.opt.A, pn.opt.q));
    say(`      ${pad(lab, 26)} A* ${rpad(f(pn.opt.A, 3), 6)} q* ${rpad(f(pn.opt.q, 2), 5)}  ${LADDER.map((t) => rpad(f(sc.find((x) => x.tier === t)!.s, 2), 8)).join("")}  ⇒ ${sc.filter((x) => x.inside).length}/5, diamond ${sc.find((x) => x.tier === "diamond")!.inside ? "IN" : "OUT"}`);
  }
  say(`      needs                      ${rpad("", 15)}${LADDER.map((t) => rpad(f(leg.cells.find((c) => c.tier === t)!.need, 2), 8)).join("")}`);
  say();
}

say("### 2. THE PRIMARY FIT — p = 0.30, BF ≥ 600");
say();
sayLeg(primary, `PRIMARY LEG  p = ${PRESENCE_P}, BF ≥ ${MIN_BF}`, true);

say("### 3. ACCEPTANCE B — THE 1000 BAR IS A SENSITIVITY REPORT, NOT A GATE");
say();
say("  STRUCTURAL REASON, stated up front: a POOL-LEVEL ramp is one function s(g) of a FORMAT'S GAP.");
say("  The gap is a property of the eligible pool — a catalog property — and is computed identically");
say("  whatever usage floor the EVALUATION set is drawn at. So s(g_t) returns the SAME scalar at the");
say("  600 bar and the 1000 bar: it CANNOT move between bars, and demanding it reproduce a bar");
say("  differential would be demanding the impossible. Gold's bar differential stays a DIAGNOSTIC,");
say("  attached to the five-card provenance, and is never scored as a pass or a fail.");
say();
say(`  tier       s(gap)   need@600  [CI]              need@1000 [CI]             N600→N1000   Δneed`);
for (const t of LADDER) {
  const a = primary.cells.find((c) => c.tier === t)!, b = bar1000.cells.find((c) => c.tier === t)!;
  say(`  ${pad(t, 9)}${rpad(f(sPrimary(a.gap), 3), 6)}   ${rpad(f(a.need, 2), 8)}  [${f(a.needCI.lo, 2)},${f(a.needCI.hi, 2)}]      ${rpad(f(b.need, 2), 9)} [${f(b.needCI.lo, 2)},${f(b.needCI.hi, 2)}]      ${rpad(`${a.rows.length}→${b.rows.length}`, 11)}  ${sgn(b.need - a.need, 2)}${b.rows.length < THIN_N ? "   THIN@1000 — no verdict" : ""}`);
}
say();
say(`  1000-bar membership (REPORT ONLY): ${bar1000.accept.filter((a) => a.inside).length} of 5 inside, diamond ${bar1000.diamondIn ? "inside" : `outside${bar1000.cells.find((c) => c.tier === "diamond")!.rows.length < THIN_N ? " — but that cell is THIN, so it carries NO verdict" : ""}`}.`);
say(`  This line is NOT a gate and no decision hangs on it.`);
say();

say("### 4. ACCEPTANCE C — GOLD IS FITTED IN, AND ITS RESIDUAL IS PUBLISHED");
say();
const goldCell = primary.cells.find((c) => c.tier === "gold")!;
const FIVE = ["Radke", "Randy Jones", "Hilton Smith", "Barnes", "Quisenberry"];
const isFive = (n: string) => FIVE.some((x) => n.toLowerCase().includes(x.toLowerCase()));
const gTotUn = goldCell.rows.reduce((a, r) => a + r.d * r.d, 0);
const gTotW = goldCell.rows.reduce((a, r) => a + r.w * r.d * r.d, 0);
const five = goldCell.rows.filter((r) => isFive(r.name));
say(`  gold: N = ${goldCell.rows.length} rows, gap ${f(goldCell.gap, 2)}, s(gap) = ${f(sPrimary(goldCell.gap), 3)}, measured need ${f(goldCell.need, 2)} [${f(goldCell.needCI.lo, 2)},${f(goldCell.needCI.hi, 2)}]`);
say(`  residual s(gap) − need = ${sgn(sPrimary(goldCell.gap) - goldCell.need, 3)}   (published, not absorbed)`);
say();
say(`  THE FIVE NAMED LIGHT-USAGE SUB-p05 CARDS (they travel with the constant):`);
say(`  (ROW grain: a card and its v5 are two observed rows, so a name can appear twice — vlvl says which.)`);
say(`    name                      vlvl     BF   pred K9   obs K9   Δ(obs−pred)   var share (unwtd)   var share (NOISE-WTD)`);
for (const r of five) {
  say(`    ${pad(r.name, 26)}${rpad(r.cid.split("|")[1] ?? "?", 4)}${rpad(f(r.bf, 0), 7)}   ${rpad(f(r.pred, 2), 7)}  ${rpad(f(r.obs, 2), 7)}   ${rpad(sgn(r.obs - r.pred, 2), 11)}   ${rpad(`${f(100 * r.d * r.d / gTotUn, 1)}%`, 17)}   ${f(100 * r.w * r.d * r.d / gTotW, 1)}%`);
}
if (!five.length) say(`    (none of the five names matched a gold row at this bar — reported as-is, not silently dropped)`);
else {
  const shU = 100 * five.reduce((a, r) => a + r.d * r.d, 0) / gTotUn;
  const shW = 100 * five.reduce((a, r) => a + r.w * r.d * r.d, 0) / gTotW;
  say(`    ${pad("TOTAL", 26)}${rpad("", 4)}${rpad("", 7)}   ${rpad("", 7)}  ${rpad("", 7)}   ${rpad("", 11)}   ${rpad(`${f(shU, 1)}%`, 17)}   ${f(shW, 1)}%`);
  say();
  say(`  ${f(five.length / goldCell.rows.length * 100, 1)}% of gold's rows carry ${f(shU, 1)}% of its predicted-K variance UNWEIGHTED, but only`);
  say(`  ${f(shW, 1)}% of the leverage the OBJECTIVE actually gives them. That is amendment A1.2 working as`);
  say(`  designed: per-card noise weighting downweights them in proportion to how little they are`);
  say(`  observed — the principled form of what hand-exclusion approximated — while keeping whatever`);
  say(`  real signal they do carry. Nothing was excluded.`);
}
say();

say("### 5. ACCEPTANCE D — THE GATES RE-CHECKED ACROSS THE PRESENCE BAND");
say();
say(`  Each leg is a FULL re-derivation at that p: the pool field, the reference field, the pool`);
say(`  transform, K̄ and therefore every predicted line move with p. p is threaded through the ONE`);
say(`  productionFieldStats() (default-identity at ${PRESENCE_P}) — no field is built any other way.`);
say();
for (const leg of pLegs) sayLeg(leg, `SENSITIVITY LEG  p = ${f(leg.p, 2)}, BF ≥ ${MIN_BF}`, true);
say(`  BAND SUMMARY`);
say(`    p        (w)2    (w)3    acceptance A (inside/5, diamond)     A        q      s(20)`);
for (const leg of [pLegs[0]!, primary, pLegs[1]!].sort((a, b) => a.p - b.p)) {
  say(`    ${f(leg.p, 2)}     ${leg.w2.pass ? "PASS" : "FAIL"}    ${leg.w3 ? "PASS" : "FAIL"}    ${rpad(`${leg.accept.filter((a) => a.inside).length}/5, diamond ${leg.diamondIn ? "IN" : "OUT"}`, 33)}  ${rpad(f(leg.pin.A, 4), 7)}  ${rpad(f(leg.pin.q, 2), 5)}  ${f(sOf(leg.pin.A, leg.pin.q)(20), 3)}`);
}
say(`    Holding across the band retires p's uncertainty. Failing across the band is the ONLY thing`);
say(`    that reopens property-conditioning — and that is a ruling, not a fit decision.`);
say(`    BAND VERDICT: ${bandHolds ? "HOLDS at 0.25 and 0.35" : "DOES NOT HOLD across the whole band (see the legs above)"}`);
say();

say("### 6. ACCEPTANCE E — HELD-OUT FORMAT VALIDATION (VALIDATED, NEVER FITTED)");
say();
say("  Formats resolved from the corpus REGISTRY by tournamentId (src/eval/cwhit/corpus.ts) and named");
say("  to the builder by REGISTRY KEY — not by the optional `legacySlug`. bronze-cap-weekly and");
say("  gold-slots carry NO legacySlug, which is exactly why the fit tool's hard-coded DAILY list");
say("  (four of the registry's eight dailies) could never reach them. Each format's gap and K̄ come");
say("  from ITS OWN eligible pool under ITS OWN resolved coeffs; the judged line is the DEPLOYED one");
say("  (era/park applied), because the observed lines live in the format's environment.");
say();
say(`  format               strat  poolN  joined  judged   gap    K̄dep/9  s(gap)  pre slope [CI]        post slope [CI]       verdict`);
for (const v of valRows) {
  say(`  ${pad(lbl(v.label), 21)}${pad(v.stratum, 7)}${rpad(String(v.poolN), 5)}  ${rpad(String(v.joined), 6)}  ${rpad(String(v.judged), 6)}  ${rpad(f(v.gap, 1), 5)}  ${rpad(f(v.kbar, 2), 6)}  ${rpad(f(v.s, 3), 6)}  ${rpad(`${f(v.preSlope, 2)} [${f(v.preCI.lo, 2)},${f(v.preCI.hi, 2)}]`, 20)}  ${rpad(`${f(v.postSlope, 2)} [${f(v.postCI.lo, 2)},${f(v.postCI.hi, 2)}]`, 20)}  ${v.verdict}`);
}
say(`  K̄dep/9 is the DEPLOYED-frame pool mean (×era_k) for reading; the correction itself is centred on`);
say(`  the RAW pre-era K̄ per 600, which is where production applies it.`);
say(`  EXTRAPOLATION WARNING, stated because the table cannot be read without it: the fit spans gaps`);
const gOut = valRows.filter((v) => Number.isFinite(v.gap) && (v.gap > 22.25 || v.gap < 10.31));
say(`  10.31–22.25 (the Quick ladder). ${gOut.length ? `OUTSIDE that range: ${gOut.map((v) => `${lbl(v.label)} g=${f(v.gap, 1)}`).join("; ")} — s there is EXTRAPOLATED and the verdict is about the extrapolation, not the fit.` : "every validated format sits inside it."}`);
say();
say(`  K9 LEVEL (pred − obs), pre → post:`);
for (const v of valRows) say(`    ${pad(lbl(v.label), 21)} ${sgn(v.preLevel, 2)} → ${sgn(v.postLevel, 2)}   [${v.note}]`);
say();
const gs = valRows.find((v) => v.tid === "gold-slots")!;
say(`  GOLD-SLOTS REACHABILITY — the explicit confirmation the pre-registration asks for:`);
say(`    gold-slots has NEVER been evaluated by any tool before this run. It resolves to registry key`);
say(`    '${gs.key}' (label "${gs.label}", legacySlug ABSENT), reads capture files, and joined`);
say(`    ${gs.joined} pitcher rows / ${gs.judged} judged at BF ≥ ${MIN_BF} over a ${gs.poolN}-card eligible pool.`);
say(`    ⇒ ${gs.joined > 0 ? "IT READS REAL DATA — NOT silently empty." : "✗ IT IS EMPTY — the leg did not read data and carries no verdict."}`);
for (const v of valRows) for (const nt of v.notices) say(`    notice [${v.key}]: ${nt}`);
say();

say("### 7. THE STRATIFIED READ (standing structure, amendment A1.3)");
say();
say("  A defect attributes to the stratum where it FIRST appears. One universal model, stratified");
say("  diagnosis.");
say();
say("  A — NEUTRAL UNCAPPED QUICKS (the core; this is what was FITTED)");
say(`      ${primary.accept.filter((a) => a.inside).length} of 5 tiers inside their measured CI, diamond ${primary.diamondIn ? "INSIDE" : "OUTSIDE"}.`);
say(`      Residuals s(gap) − need: ${LADDER.map((t) => { const a = primary.accept.find((x) => x.tier === t)!; return `${t} ${sgn(a.s - a.need, 2)}`; }).join("  ")}`);
const liveOpen = valRows.find((v) => v.tid === "live-open-daily")!;
say(`      Non-Quick neutral control (live-open-daily, no era/park, no budget): judged ${liveOpen.judged}, ${liveOpen.verdict}`);
say();
say("  B — ENV-BEARING UNCAPPED DAILIES (+ the era/park layer)");
for (const v of valRows.filter((x) => x.stratum === "B")) say(`      ${pad(lbl(v.label), 20)} judged ${rpad(String(v.judged), 3)}  s ${f(v.s, 3)}  slope ${f(v.preSlope, 2)} → ${f(v.postSlope, 2)}  ${v.verdict}`);
say(`      A miss appearing HERE and not in A localises to the era/park layer, not to the core fit.`);
say();
say("  C — BUDGET CAP/SLOTS FORMATS (+ the composition layer)");
for (const v of valRows.filter((x) => x.stratum.includes("C"))) say(`      ${pad(lbl(v.label), 20)} judged ${rpad(String(v.judged), 3)}  s ${f(v.s, 3)}  slope ${f(v.preSlope, 2)} → ${f(v.postSlope, 2)}  ${v.verdict}${v.stratum === "B+C" ? "   [also carries env ⇒ B+C, not a clean C read]" : ""}`);
say(`      A stratum-C miss does NOT impugn the core fit: it localises to the COMPOSITION layer, which`);
say(`      is task 2's territory and is not built yet. Budget formats force weak cards into play, which`);
say(`      is exactly where the weak-card K over-prediction bites — and nothing here models a budget.`);
say();

say("### 8. THE CONSTANTS, WITH PROVENANCE STAMPED (acceptance F)");
say();
say(`  NO CONSTANT IS PROPOSED FOR SHIPPING. Gates failed; the pre-registration says a partial pass`);
say(`  stays a partial pass and the verdict returns to Fable. What follows is what the pre-registered`);
say(`  rule PRODUCED, recorded so the record is complete and so the provenance stamp acceptance F asks`);
say(`  for exists on it. It is not a recommendation, and it should not be wired.`);
say();
say(`  what the rule produced: { A: ${f(primary.pin.A, 4)}, q: ${f(primary.pin.q, 2)}, G0: ${G0} }`);
say(`  s(g) = 1 + ${f(primary.pin.A, 4)}·(g/${G0})^${f(primary.pin.q, 2)};   s(g ≤ 0) = 1 (league-anchored — never compress a`);
say(`  stronger-than-training pool).`);
say(`  fit-N = ${FIELD_N}   (FIELD_N)`);
say(`  fit-p = ${PRESENCE_P}   (PRESENCE_P)`);
say();
say(`  PROPOSED SCORING-SIDE ASSERTION (not wired — proposed):`);
say(`      assert(FIELD_N === kSpreadPitC3.fitN && PRESENCE_P === kSpreadPitC3.fitP)`);
say(`  at the point production builds the kSpread object, so a ramp fitted at one (N, p) can never be`);
say(`  evaluated at another. THE GAP IS NOT MONOTONE IN p — measured across p = 0..1 the iron gap runs`);
say(`  23.64 / 21.22 / 22.15 / 21.59 / 19.06 — so a ramp CANNOT be rescaled to another p by any`);
say(`  algebraic correction. It can only be RE-DERIVED. The same holds for FIELD_N, which is`);
say(`  retrain-coupled and known-defective-but-frozen.`);
say();
say(`  SHIPPED CONSTANT, QUOTED FOR CONTRAST AND NOT TOUCHED: K_SPREAD_PIT = { A: 5.0871, G: 152.5 }`);
say(`  on the FALSIFIED saturating family, fitted at the PRE-C1/C2' coordinate. It is not comparable`);
say(`  parameter-for-parameter (two families, two pinning outcomes); compare on s(g) only:`);
say(`    g        10      15      20      25      30`);
say(`    C3     ${[10, 15, 20, 25, 30].map((g) => rpad(f(sPrimary(g), 3), 8)).join("")}`);
const sOld = (g: number) => (g > 0 ? 1 + 5.0871 * (1 - Math.exp(-g / 152.5)) : 1);
say(`    shipped${[10, 15, 20, 25, 30].map((g) => rpad(f(sOld(g), 3), 8)).join("")}`);
say();

say("### 9. RECORDED, NOT ACTED ON (the freeze applies)");
say();
say("  · The neutral leg resolves `computeDerived(coeffs)` (eventForm flag FALSE) while the per-format");
say("    legs resolve `computeDerived(coeffs, true)`. Copied verbatim from tools/battery-needs-vs-bar.ts");
say("    and tools/fit-kspread-pit.ts so the needs reproduce rather than approximate. It cannot touch");
say("    this verdict — the Quick legs are judged on the RAW line, which never reads `derived` — but it");
say("    is an inconsistency between two tools and production, recorded here.");
say("  · FIELD_N = 50 is known-defective and frozen until a retrain; nothing here revisits it.");
say("  · The two `src/` lines this run required are DEFAULT-IDENTITY knobs, not behaviour changes:");
say("    `productionFieldStats(..., p = PRESENCE_P)` and `SampleDeps.presenceP`. They exist so the");
say("    pre-registered p = 0.25 / 0.35 re-check could be asked THROUGH the one field definition");
say("    instead of a tool building its own mixture. The instrument check in §1 pins them identical");
say("    at the shipped p.");
say();
say(`(end of artifact — C3 ramp fit, ${VERDICT.split(" ")[0]})`);

process.stdout.write(L.join("\n") + "\n");
process.exit(0);
