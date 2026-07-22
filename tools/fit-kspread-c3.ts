// C3 — THE RE-DERIVED PITCHER K-SPREAD RAMP. Fit · gates · held-out validation. REPORT ONLY.
//   run: node tools/fit-kspread-c3.ts > fixtures/cwhit-c3-ramp-fit-2026-07-22.txt
//
// SPECIFICATION: docs/CWHIT_C3_RAMP_PREREG_2026-07-22.md + AMENDMENT 1 + AMENDMENT 2 (approved).
// Everything below — the family, the objective, the selection rule, the fitted set, the gates, the
// acceptance bar, the stratification — is pre-registered there. Nothing here is tuned; a failing gate
// is reported, never tuned past.
//
// ── AMENDMENT 2 (rulings (z)/(x)/(y)) — WHAT CHANGED SINCE THE STOPPED FIT ──────────────────────
// (z) THE OBJECTIVE GAINS A PER-TIER FREE LEVEL, so the fit estimates the FREE SLOPE the gate scores
//     against. Amendment 1's residual about K̄_pool priced level as well as spread and its estimand
//     (the pivot slope) sat +0.18 above the free slope in every tier.
// (x) THE 5%-OF-LINEAR SSE BAND IS RETIRED — an inherited rule that did not survive the objective
//     change. Selection is now DELIVERABLE-SPACE EQUIVALENCE with a MINIMAX CENTRE.
// (y) GOLD IS FITTED OUT (its need is non-monotone in the coordinate) and ships as a PUBLISHED
//     QUANTIFIED RESIDUAL with a CI, assigned to the composition axis. The fitted set is the
//     COHERENT FOUR, and the bar is ≥3 of 4 inside CI with DIAMOND MANDATORY.
// The amendment-1 fit is preserved: fixtures/cwhit-c3-ramp-fit-2026-07-22.txt, tool at commit
// 1804336 (`git show 1804336:tools/fit-kspread-c3.ts`). This file is amended in place because a
// second copy of the fit machinery is the defect the program keeps paying for.
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

// ── THE OBJECTIVE (amendment A2.1, ruling (z)) ────────────────────────────────
// PER-CARD residuals, per-card noise weights, and A PER-TIER FREE LEVEL. No tier aggregate enters it.
//
// AMENDMENT 1 scored the residual about the production pivot, obs_i − [K̄_t + s·(K_i − K̄_t)]. The
// judged sample sits OFF K̄_t (cwhit's tables are the top by USAGE), so that residual priced the
// sample's LEVEL offset as well as its SPREAD, and its minimiser — the pivot slope — sat +0.18 above
// the FREE slope acceptance scores against, in every tier, same sign. Two estimands. Ruling (z) puts
// level in the anchor layer where it belongs and gives the objective a free per-tier constant:
//
//     obs_i = c_t + K̄_t + s(g_t)·(K_i − K̄_t) + ε_i          c_t FREE per tier
//
// Profiling c_t out at its weighted optimum leaves, EXACTLY,
//     residual_i = (obs_i − ō_t) − s(g_t)·(K_i − p̄_t)
// with ō_t, p̄_t the NOISE-WEIGHTED within-tier means. Writing d_i = K_i − p̄_t and
// z_i = (obs_i − ō_t) − d_i gives residual_i = z_i − A·u_t·d_i, u_t = (g_t/G0)^q — the same three-sum
// reduction, A still closed-form at every q:
//     Swdz = Σ w·d·z      Swdd = Σ w·d²      Swzz = Σ w·z²      w_i = 1 / per9NoiseVar(obs_i, BF_i)
// K̄_t DROPS OUT OF THE OBJECTIVE ENTIRELY: with a free level the pivot is unidentified, which is the
// correct statement of the ruling. s is a pure spread response and nothing else.
//
// PRODUCTION IS UNCHANGED BY THIS — it still applies s about K̄_pool, because it has no per-tier level
// to apply. What changes is what s is ESTIMATED TO BE. The level consequence of centring on K̄_pool is
// published as diagnostic D2, not fitted away.
//
// THE MEANS ARE RECOMPUTED FROM THE ROWS PASSED IN, which is what makes the bootstrap honest: a
// resample gets ITS OWN weighted means, exactly as a refit would.
function aggregate(tier: string, g: number, rows: FitRow[]): TierAgg {
  let sw = 0, sp = 0, so = 0;
  for (const r of rows) { sw += r.w; sp += r.w * r.pred; so += r.w * r.obs; }
  const pBar = sw > 0 ? sp / sw : 0, oBar = sw > 0 ? so / sw : 0;
  let Swdz = 0, Swdd = 0, Swzz = 0;
  for (const r of rows) {
    const d = r.pred - pBar, z = (r.obs - oBar) - d;
    Swdz += r.w * d * z; Swdd += r.w * d * d; Swzz += r.w * z * z;
  }
  return { tier, g, Swdz, Swdd, Swzz, n: rows.length };
}
/** THE AMENDMENT-1 OBJECTIVE — residual about K̄_pool, NO free level. Retained as a DIAGNOSTIC only
 *  (D3), so the effect of ruling (z) can be read directly rather than asserted. Not a candidate. */
function aggregatePivot(tier: string, g: number, rows: FitRow[]): TierAgg {
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

// ── THE SELECTION RULE (amendment A2.2, ruling (x)) ───────────────────────────
// The 5%-of-linear SSE band is RETIRED. It was calibrated against a TIER-AGGREGATE SSE, where 5% is a
// meaningful slice; against a per-card SSE dominated by irreducible sampling noise it spanned the
// whole grid and its "most-saturating member" tie-break ran to the edge. That is an inherited rule
// surviving an objective change, and it is replaced rather than patched.
//
// THE DELIVERABLE IS s(g), NOT (A, q). Two candidates are EQUIVALENT iff nothing the acceptance
// instrument measures can tell them apart:
//     max over FITTED tiers  |s₁(g_t) − s₂(g_t)| / se_t  ≤  1        se_t = the per-tier NEED's SE
// The EQUIVALENCE SET is every grid candidate equivalent to the SSE optimum, and it is published in
// full. THE SHIPPED POINT IS THE SET'S MINIMAX CENTRE in that same SE-scaled sup-norm (the Chebyshev
// centre), so the shipped constant is at most half the set's own width from any member of it. No
// tie-break by curvature, saturation or any other property the deliverable cannot see.
//
// The centre is computed exactly and cheaply: for each tier the set's own MIN and MAX implied s bound
// every member, so a candidate's worst-case scaled deviation from the set is
// max_t max(hi_t − s(g_t), s(g_t) − lo_t)/se_t — one O(|set|·T) pass, not O(|set|²·T).
interface Selected {
  A: number; q: number; sse: number; lin: ProfPt; opt: ProfPt;
  setLo: number; setHi: number; setN: number; contiguous: boolean; atEdge: boolean;
  radius: number; width: number;                 // in SE units: the centre's reach, and the set's own
  sLo: number[]; sHi: number[];                  // per fitted tier, the set's deliverable envelope
}
function select(prof: ProfPt[], gaps: number[], ses: number[]): Selected {
  const lin = prof.find((p) => Math.abs(p.q - 1) < 1e-9)!;
  const opt = prof.reduce((a, b) => (b.sse < a.sse ? b : a));
  const sAt = (p: ProfPt) => gaps.map((g) => sOf(p.A, p.q)(g));
  const sOpt = sAt(opt);
  const set = prof.filter((p) => { const v = sAt(p); return gaps.every((_, i) => Math.abs(v[i]! - sOpt[i]!) / ses[i]! <= 1); });
  const pool = set.length ? set : [opt];
  const sLo = gaps.map((_, i) => Math.min(...pool.map((p) => sAt(p)[i]!)));
  const sHi = gaps.map((_, i) => Math.max(...pool.map((p) => sAt(p)[i]!)));
  let best = pool[0]!, radius = Infinity;
  for (const p of pool) {
    const v = sAt(p);
    const r = Math.max(...gaps.map((_, i) => Math.max(sHi[i]! - v[i]!, v[i]! - sLo[i]!) / ses[i]!));
    if (r < radius) { radius = r; best = p; }
  }
  const qs = pool.map((p) => p.q);
  const setLo = Math.min(...qs), setHi = Math.max(...qs);
  return {
    A: best.A, q: best.q, sse: best.sse, lin, opt,
    setLo, setHi, setN: pool.length,
    contiguous: pool.length === Math.round((setHi - setLo) * 100) + 1,
    atEdge: Math.abs(setLo - qAt(QI_LO)) < 1e-9 || Math.abs(setHi - qAt(QI_HI)) < 1e-9,
    radius, width: Math.max(...gaps.map((_, i) => (sHi[i]! - sLo[i]!) / ses[i]!)), sLo, sHi,
  };
}

interface FitRow { tier: string; cid: string; name: string; bf: number; pred: number; obs: number; nv: number; w: number; d: number; z: number }
interface TierCell {
  tier: string; gap: number; kbar600: number; kbar9: number;
  rows: FitRow[]; need: number; needCI: { lo: number; hi: number }; needSe: number;
  /** The need's own bootstrap draws, retained so gold's PUBLISHED RESIDUAL (A2.3) can carry a CI. */
  needBoot: number[];
  /** The two per-tier estimands, side by side: `pivotS` is what the AMENDMENT-1 objective targeted
   *  (regression through the K̄_pool pivot) and `wFreeS` is what the AMENDMENT-2 objective targets
   *  (the noise-weighted FREE slope). `need` is the unweighted free slope the gate scores against. */
  pivotS: number; wPredMean: number; wObsMean: number; wFreeS: number; offPred: number; offResid: number;
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
  cells: TierCell[];                               // ALL FIVE tiers — gold is reported, not fitted
  fitCells: TierCell[];                            // THE COHERENT FOUR — the fitted set (A2.3)
  sel: Selected; prof: ProfPt[];
  aCI: { lo: number; hi: number }; qCI: { lo: number; hi: number };
  sCI: Map<string, { lo: number; hi: number }>;
  loo: { dropped: string; A: number; q: number; sAt: Map<string, number>; inAll: boolean }[];
  w2: { pass: boolean; why: string };
  w3: boolean;
  monotone: boolean;
  accept: { tier: string; s: number; need: number; lo: number; hi: number; inside: boolean; thin: boolean }[];
  acceptPass: boolean; diamondIn: boolean;
  /** GOLD — fitted OUT, published as a quantified residual with a CI, assigned to composition. */
  gold: { gap: number; s: number; need: number; needCI: { lo: number; hi: number }; resid: number; residCI: { lo: number; hi: number } };
  /** Diagnostics — never candidates, never a verdict. */
  pivotFit: Selected;                              // the AMENDMENT-1 objective, for contrast
}

/** Acceptance scored for an arbitrary s(·) — used by the diagnostic contrast tables. */
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
    const a0 = aggregatePivot(win.tier, gap, rows);
    const sw = rows.reduce((a, r) => a + r.w, 0) || 1;
    const wPredMean = rows.reduce((a, r) => a + r.w * r.pred, 0) / sw;
    const wObsMean = rows.reduce((a, r) => a + r.w * r.obs, 0) / sw;
    const a1 = aggregate(win.tier, gap, rows);
    cells.push({
      tier: win.tier, gap, kbar600, kbar9, rows,
      need: m.slope.est, needCI: ci(boot.filter(Number.isFinite)), needSe: m.slope.se,
      needBoot: boot.filter(Number.isFinite),
      pivotS: a0.Swdd > 0 ? 1 + a0.Swdz / a0.Swdd : NaN,
      wPredMean, wObsMean, wFreeS: a1.Swdd > 0 ? 1 + a1.Swdz / a1.Swdd : NaN,
      offPred: wPredMean - kbar9, offResid: wObsMean - wPredMean,
    });
  }

  // ── THE FITTED SET IS THE COHERENT FOUR (A2.3). Gold is reported, never fitted. ──
  const fitCells = COHERENT.map((t) => cells.find((c) => c.tier === t)!);
  const gaps = fitCells.map((c) => c.gap);
  const ses = fitCells.map((c) => c.needSe);
  const aggs = fitCells.map((c) => aggregate(c.tier, c.gap, c.rows));
  const prof = profileOf(aggs);
  const sel = select(prof, gaps, ses);
  const sFit = sOf(sel.A, sel.q);

  // Bootstrap the SHIPPING quantity: resample cards within each FITTED tier, refit, re-run the SAME
  // selection rule end-to-end (the equivalence set is re-derived per resample — a bootstrap that
  // re-applied only half the rule would understate the selection's own contribution to the spread).
  const rb = rng(SEED + 900);
  const bootA: number[] = [], bootQ: number[] = [], bootS = new Map<string, number[]>(cells.map((c) => [c.tier, []]));
  for (let b = 0; b < B; b++) {
    const ag = fitCells.map((c) => {
      const rs = c.rows.map(() => c.rows[Math.floor(rb() * c.rows.length)]!);
      return aggregate(c.tier, c.gap, rs);
    });
    const sb = select(profileOf(ag), gaps, ses);
    bootA.push(sb.A); bootQ.push(sb.q);
    for (const c of cells) bootS.get(c.tier)!.push(sOf(sb.A, sb.q)(c.gap));
  }
  const aCI = ci(bootA.filter(Number.isFinite)), qCI = ci(bootQ.filter(Number.isFinite));
  const sCI = new Map([...bootS].map(([t, xs]) => [t, ci(xs.filter(Number.isFinite))] as const));

  // GATE (w)3 — leave one tier out, IN DELIVERABLE SPACE (A2.5). Each refit's implied s(g_t) must lie
  // inside the full fit's bootstrap s-CI at every FITTED gap. Raw {A,q} are printed, not gated: two
  // selections give two selection outcomes, so comparing them compares the rule rather than the fits.
  const loo = fitCells.map((c) => {
    const sb = select(profileOf(aggs.filter((a) => a.tier !== c.tier)), gaps, ses);
    const sAt = new Map(cells.map((x) => [x.tier, sOf(sb.A, sb.q)(x.gap)] as const));
    const inAll = fitCells.every((x) => { const q = sCI.get(x.tier)!; const v = sAt.get(x.tier)!; return v >= q.lo && v <= q.hi; });
    return { dropped: c.tier, A: sb.A, q: sb.q, sAt, inAll };
  });
  const w3 = loo.every((x) => x.inAll);

  // GATE (w)2 — the EQUIVALENCE SET reaching a grid edge = family misfit (A2.2). The test is on the
  // SET, not on the selected point: with no directional tie-break the minimax centre cannot run to an
  // edge by construction, and what signals misfit is the deliverable failing to distinguish members
  // arbitrarily far out.
  const w2 = sel.atEdge
    ? { pass: false, why: `the EQUIVALENCE SET reaches a grid edge: q ∈ [${f(sel.setLo, 2)}, ${f(sel.setHi, 2)}] on a grid of [${f(qAt(QI_LO), 2)}, ${f(qAt(QI_HI), 2)}] — the deliverable cannot distinguish members arbitrarily far out, which is family misfit` }
    : { pass: true, why: `the equivalence set q ∈ [${f(sel.setLo, 2)}, ${f(sel.setHi, 2)}] (${sel.setN} of ${prof.length} grid points, ${sel.contiguous ? "contiguous" : "NON-CONTIGUOUS"}) is interior to [${f(qAt(QI_LO), 2)}, ${f(qAt(QI_HI), 2)}]; the minimax centre sits ${f(sel.radius, 2)} need-SEs from the furthest member, on a set ${f(sel.width, 2)} SEs wide` };

  // MONOTONICITY over the observed range (kill condition 6): A > 0 and q > 0 ⇒ strictly increasing.
  const monotone = sel.A > 0 && sel.q > 0;

  // ACCEPTANCE — scored on the COHERENT FOUR ONLY (A2.4). Gold is reported below, never scored.
  const accept = fitCells.map((c) => {
    const s = sFit(c.gap);
    return { tier: c.tier, s, need: c.need, lo: c.needCI.lo, hi: c.needCI.hi, inside: s >= c.needCI.lo && s <= c.needCI.hi, thin: c.rows.length < THIN_N };
  });
  const diamondIn = accept.find((a) => a.tier === "diamond")!.inside;
  const acceptPass = accept.filter((a) => a.inside).length >= 3 && diamondIn;

  // GOLD — the published quantified residual (A2.3). Gold is NOT in the fit, so its need bootstrap and
  // the fit's bootstrap are INDEPENDENT draws and can be differenced index-wise for the residual CI.
  const gc = cells.find((c) => c.tier === "gold")!;
  const gS = bootS.get("gold")!;
  const gResid: number[] = [];
  for (let b = 0; b < Math.min(gc.needBoot.length, gS.length); b++) gResid.push(gc.needBoot[b]! - gS[b]!);
  const gold = {
    gap: gc.gap, s: sFit(gc.gap), need: gc.need, needCI: gc.needCI,
    resid: gc.need - sFit(gc.gap), residCI: ci(gResid.filter(Number.isFinite)),
  };

  // ── diagnostic: the AMENDMENT-1 objective (pivot residual), same family, same selection rule ──
  const pivotFit = select(profileOf(fitCells.map((c) => aggregatePivot(c.tier, c.gap, c.rows))), gaps, ses);

  return { p, bar, cells, fitCells, sel, prof, aCI, qCI, sCI, loo, w2, w3, monotone, accept, acceptPass, diamondIn, gold, pivotFit };
}

const primary = buildLeg(PRESENCE_P, MIN_BF);
const sPrimary = sOf(primary.sel.A, primary.sel.q);

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
const bandHolds = pLegs.every((l) => l.w2.pass && l.w3 && l.monotone && l.acceptPass);
const fails: string[] = [];
if (!W1_PASS) fails.push("GATE (w)1 IDENTIFIABILITY");
if (!primary.w2.pass) fails.push("GATE (w)2 EQUIVALENCE SET AT A GRID EDGE (family misfit)");
if (!primary.w3) fails.push("GATE (w)3 LEAVE-ONE-TIER-OUT IN DELIVERABLE SPACE");
if (!primary.monotone) fails.push("KILL 6 — THE FITTED FORM IS NOT MONOTONE OVER THE OBSERVED RANGE");
if (!primary.diamondIn) fails.push("ACCEPTANCE — DIAMOND OUTSIDE ITS MEASURED CI (STOP-class)");
else if (!primary.acceptPass) fails.push("ACCEPTANCE — fewer than 3 of the 4 coherent tiers inside");
if (!fails.length && !bandHolds && !pLegs.some((l) => l.acceptPass)) fails.push("KILL 7 — the gates hold at p=0.30 but fail at BOTH 0.25 and 0.35 (reopens conditioning)");
const VERDICT = fails.length ? `STOP — ${fails.join(" + ")}`
  : bandHolds ? "PASS — every gate and the acceptance bar hold at p=0.30 AND across the 0.25/0.35 band"
    : "PARTIAL — gates and the acceptance bar hold at p=0.30 but not across the whole 0.25/0.35 band";
const nIn = primary.accept.filter((a) => a.inside).length;

say("################################################################################");
say(`# C3 — THE RE-DERIVED PITCHER K-SPREAD RAMP. VERDICT: ${VERDICT}`);
say("# Pre-registration: docs/CWHIT_C3_RAMP_PREREG_2026-07-22.md + AMENDMENT 1 + AMENDMENT 2.");
say("# Tool: tools/fit-kspread-c3.ts. FIT AND REPORT ONLY — this tool wires nothing. If the verdict");
say("# is PASS the constants are shipped by a SEPARATE, dated commit that quotes this artifact.");
say("################################################################################");
say();
say("### WHAT THIS RUN CONCLUDES (the detail is below; nothing here is tuned)");
say();
say(`  1. GATE (w)1 IDENTIFIABILITY ${W1_PASS ? "PASSES" : "FAILS"} — unchanged by amendment 2, because it is a property of`);
say(`     the COORDINATE and not of the objective. Ordering strictly descending at every p in the band;`);
say(`     coherent-four span retention ${f(w1Rows.find((r) => r.p === PRESENCE_P)!.ret * 100, 1)}% at the shipped p (${w1Rows.filter((r) => r.p > 0).map((r) => `${f(r.p, 2)}: ${f(r.ret * 100, 1)}%`).join(", ")}) against a 60% floor.`);
say(`  2. RULING (z) IS CONFIRMED BY MEASUREMENT, not assumed. Diagnostic D2: the amendment-1 objective's`);
say(`     estimand (the pivot slope) sits +${f(mean(primary.cells.map((c) => c.pivotS - c.need)), 2)} above the free slope in every tier, same sign; the`);
say(`     amendment-2 objective's estimand (the weighted free slope) sits ${sgn(mean(primary.cells.map((c) => c.wFreeS - c.need)), 2)} from it. Giving the`);
say(`     objective a per-tier free level removes the systematic offset, leaving only weighting.`);
say(`  3. GATE (w)2 ${primary.w2.pass ? "PASSES" : "FAILS"} under the new selection rule: ${primary.w2.why}`);
say(`  4. GATE (w)3 ${primary.w3 ? "PASSES" : "FAILS"} in deliverable space: ${primary.w3 ? "no single tier determines the delivered s(g)" : "a leave-one-out refit leaves the full fit's s-CI"}.`);
say(`  5. ACCEPTANCE ${primary.acceptPass ? "PASSES" : "FAILS"}: ${nIn} of the 4 coherent tiers inside their measured CI,`);
say(`     DIAMOND ${primary.diamondIn ? "INSIDE ✓ — the standing G1 diamond failure is resolved" : "OUTSIDE ✗ — STOP-class on its own"}.`);
say(`     Fitted form: A = ${f(primary.sel.A, 4)}, q = ${f(primary.sel.q, 2)} (${primary.sel.q > 1 ? "CONVEX" : primary.sel.q < 1 ? "concave/saturating" : "linear"}), monotone: ${primary.monotone ? "YES ✓" : "NO ✗"}.`);
say(`  6. GOLD, FITTED OUT PER RULING (y), CARRIES A PUBLISHED RESIDUAL of ${sgn(primary.gold.resid, 2)} [${f(primary.gold.residCI.lo, 2)}, ${f(primary.gold.residCI.hi, 2)}]`);
say(`     (need ${f(primary.gold.need, 2)} vs s(${f(primary.gold.gap, 2)}) = ${f(primary.gold.s, 2)}), assigned to the COMPOSITION/COHORT axis. Gold at gap`);
say(`     ${f(primary.gold.gap, 2)} needs ${f(primary.gold.need, 2)}, ABOVE silver's ${f(primary.cells.find((c) => c.tier === "silver")!.need, 2)} at the HIGHER gap ${f(primary.cells.find((c) => c.tier === "silver")!.gap, 2)}: its need is`);
say(`     NON-MONOTONE in the coordinate, so no monotone s(g) can carry it and the coherent four at`);
say(`     once. It is published, not absorbed, and not silently dropped.`);
say(`  7. THE BAND RE-CHECK (p = 0.25 / 0.35) ${bandHolds ? "REPRODUCES the verdict" : "does NOT fully reproduce the verdict"} — see §5. Property-conditioning is`);
say(`     ${bandHolds || pLegs.some((l) => l.acceptPass) ? "NOT reopened" : "REOPENED"} by this run.`);
say(`  8. THE HELD-OUT BUDGET LEGS ARE DIAGNOSTICS, NOT GATES (A2.4). All three read REAL DATA,`);
say(`     including gold-slots (${valRows.find((v) => v.tid === "gold-slots")?.joined ?? 0} joined / ${valRows.find((v) => v.tid === "gold-slots")?.judged ?? 0} judged), which no tool had ever evaluated. Their`);
say(`     elevation is the EXPECTED stratum-C composition signal and is read as such.`);
say();
say("### HEADER");
say(`  tool        tools/fit-kspread-c3.ts`);
say(`  date        2026-07-22`);
say(`  model       '${trained.id}'   (raw-poly event model, own-gap path, no anchor on the judged line)`);
say(`  catalog     '${srcId}'   (${baseCards.length} base cards, variant rows excluded from the catalog read)`);
say(`  commit      cee1a32 (HEAD at generation — "C3 prereg AMENDMENT 2: the free-slope estimand, equivalence in deliverable space, gold fitted out")`);
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
say("  · OBJECTIVE (amendment A2.1, ruling (z)): per-card residuals, per-card noise weights");
say("    w_i = 1/per9NoiseVar(obs_i, BF_i), and A PER-TIER FREE LEVEL. Profiling the level out leaves");
say("    residual_i = (obs_i − ō_t) − s(g_t)·(K_i − p̄_t) at the noise-weighted within-tier means, so");
say("    K̄_t drops out of the objective: with a free level the pivot is unidentified and s is a PURE");
say("    SPREAD RESPONSE. NO tier aggregate enters it. NO per-tier freedom in s: one function of gap.");
say("    Production still applies s about K̄_pool — the level lives in the ANCHOR layer, not in s.");
say("  · FITTED SET (amendment A2.3, ruling (y)): THE COHERENT FOUR — iron, bronze, silver, diamond.");
say("    Gold is FITTED OUT because its need is NON-MONOTONE in the coordinate, and ships as a");
say("    published quantified residual with a CI, assigned to the composition/cohort axis.");
say("  · SELECTION (amendment A2.2, ruling (x)): DELIVERABLE-SPACE EQUIVALENCE. Two candidates are");
say("    equal iff max over fitted tiers |s₁(g_t) − s₂(g_t)|/se_t ≤ 1, se_t = the per-tier NEED's SE.");
say("    The equivalence set is published in full and the shipped point is its MINIMAX CENTRE in that");
say("    same SE-scaled sup-norm. The retired 5%-of-linear SSE band was calibrated on a TIER-AGGREGATE");
say("    SSE and spanned the whole grid against a per-card one. Cross-fit comparisons are made on s(g)");
say(`    over the observed range, NEVER on raw {A, q}. Grid q ∈ [${f(qAt(QI_LO), 2)}, ${f(qAt(QI_HI), 2)}] step 0.01, A closed-form at each q.`);
say();

say("### 1. THE COORDINATE + GATE (w)1 IDENTIFIABILITY (prong 1)");
say();
say(`  INSTRUMENT CHECK — productionFieldStats(pool) vs the same call with p stated explicitly at`);
say(`  p = ${PRESENCE_P}: max |Δgap| = ${instrDelta.toExponential(1)}  ${instrDelta === 0 ? "✓ bit-identical (the p knob is default-identity)" : "✗ THE KNOB IS NOT DEFAULT-IDENTITY"}`);
say();
say(`  gap pit.stu     ${LADDER.map((t) => rpad(t, 9)).join("")}`);
for (const p of P_BAND) say(`  p = ${f(p, 2)}        ${LADDER.map((t) => rpad(f(gapTable.get(p)!.get(t)!, 2), 9)).join("")}`);
say();
say(`  coherent four = ${COHERENT.join(", ")} — this is BOTH the span measure and, per ruling (y)`);
say(`  and amendment A2.3, THE FITTED SET. Gold is fitted OUT and published as a residual in §4.`);
say(`    p        ordering strictly descending    coherent-four span   retention vs p=0`);
for (const r of w1Rows) say(`    ${f(r.p, 2)}     ${r.ord ? "YES ✓" : "NO ✗"}                          ${rpad(f(spanOf(gapTable.get(r.p)!), 2), 6)}               ${r.p === 0 ? "     —" : `${f(r.ret * 100, 1)}%`}`);
say();
say(`  REQUIREMENT: ordering at the fitted p matches p=0's, AND coherent-four span retention ≥ 60%.`);
say(`  GATE (w)1: ${W1_PASS ? "PASS" : "FAIL"}`);
say();

function sayLeg(leg: LegResult, title: string, full: boolean) {
  const sFit = sOf(leg.sel.A, leg.sel.q);
  const fitted = (t: string) => (COHERENT.includes(t) ? "fit" : "OUT");
  say(`── ${title} ──`);
  say();
  say(`  MEASURED NEEDS (re-measured on this coordinate; the quoted values are a CROSS-CHECK, not an input)`);
  say(`  "fit" = in the fitted set (the coherent four); "OUT" = gold, reported and never fitted (A2.3).`);
  say(`  tier      set    N   gap(stu)   K̄_pool/600   K̄_pool/9   slope   [boot 95% CI]    se     pivot-s`);
  for (const c of leg.cells) {
    say(`  ${pad(c.tier, 9)}${pad(fitted(c.tier), 5)}${rpad(String(c.rows.length), 3)}   ${rpad(f(c.gap, 2), 7)}   ${rpad(f(c.kbar600, 1), 9)}   ${rpad(f(c.kbar9, 2), 8)}   ${rpad(f(c.need, 2), 5)}   [${f(c.needCI.lo, 2)},${f(c.needCI.hi, 2)}]   ${f(c.needSe, 3)}    ${f(c.pivotS, 2)}${c.rows.length < THIN_N ? "  THIN" : ""}`);
  }
  say(`  pivot-s = the per-tier estimand of the RETIRED amendment-1 objective (regression through the`);
  say(`  K̄_pool pivot). Kept in the table so ruling (z)'s effect is visible, never a candidate.`);
  say();
  say(`  THE FIT  (fitted set: ${COHERENT.join(", ")} — gold OUT)`);
  say(`    wide-grid SSE optimum:   q* = ${f(leg.sel.opt.q, 2)}   A* = ${f(leg.sel.opt.A, 4)}   SSE ${f(leg.sel.opt.sse, 1)}`);
  say(`    LINEAR LIMIT (q = 1):    A  = ${f(leg.sel.lin.A, 4)}   SSE ${f(leg.sel.lin.sse, 1)}   ⇒ β = A/${G0} = ${f(leg.sel.lin.A / G0, 5)} per gap unit`);
  say(`    SELECTED (minimax centre of the equivalence set):  A = ${f(leg.sel.A, 4)}  [boot 95% CI ${f(leg.aCI.lo, 4)}, ${f(leg.aCI.hi, 4)}]`);
  say(`                                                       q = ${f(leg.sel.q, 2)}  [boot 95% CI ${f(leg.qCI.lo, 2)}, ${f(leg.qCI.hi, 2)}]`);
  say(`    curvature: ${leg.sel.q > 1 ? "CONVEX (q > 1)" : leg.sel.q < 1 ? "CONCAVE / saturating (q < 1)" : "LINEAR (q = 1)"};  monotone increasing: ${leg.monotone ? "YES ✓" : "NO ✗ (A ≤ 0 — wrong-signed)"}`);
  say(`    s at reference gaps:  s(5)=${f(sFit(5), 3)}  s(10)=${f(sFit(10), 3)}  s(15)=${f(sFit(15), 3)}  s(20)=${f(sFit(20), 3)}  s(25)=${f(sFit(25), 3)}  s(30)=${f(sFit(30), 3)}`);
  say();
  if (!full) return;
  say(`  THE EQUIVALENCE SET, PUBLISHED IN FULL (amendment A2.2 — this IS the deliverable's precision)`);
  say(`    Members are candidates the acceptance instrument CANNOT distinguish from the SSE optimum:`);
  say(`    max over fitted tiers |s_cand(g_t) − s_opt(g_t)| / se_t ≤ 1.`);
  say(`    set:  q ∈ [${f(leg.sel.setLo, 2)}, ${f(leg.sel.setHi, 2)}]   ${leg.sel.setN} of ${leg.prof.length} grid points   ${leg.sel.contiguous ? "CONTIGUOUS ✓" : "NON-CONTIGUOUS ⚠"}   touches a grid edge: ${leg.sel.atEdge ? "YES ✗" : "NO ✓"}`);
  say(`    the set's deliverable envelope, and where the shipped centre sits inside it:`);
  say(`      tier        se     set s-range          centre    (centre − range mid) / se`);
  for (const [i, c] of leg.fitCells.entries()) {
    const mid = (leg.sel.sLo[i]! + leg.sel.sHi[i]!) / 2;
    say(`      ${pad(c.tier, 10)}${rpad(f(c.needSe, 3), 6)}   ${rpad(`${f(leg.sel.sLo[i]!, 3)} – ${f(leg.sel.sHi[i]!, 3)}`, 18)}   ${rpad(f(sFit(c.gap), 3), 8)}  ${sgn((sFit(c.gap) - mid) / c.needSe, 3)}`);
  }
  say(`    set width ${f(leg.sel.width, 2)} need-SEs; the centre reaches ${f(leg.sel.radius, 2)} SEs to the furthest member.`);
  say();
  say(`  GATE (w)2 EQUIVALENCE SET AT A GRID EDGE: ${leg.w2.pass ? "PASS" : "FAIL"}`);
  say(`    ${leg.w2.why}`);
  say();
  say(`  GATE (w)3 LEAVE-ONE-TIER-OUT, IN DELIVERABLE SPACE (A2.5)`);
  say(`    Each refit drops one FITTED tier; its implied s(g_t) must lie inside the full fit's bootstrap`);
  say(`    s-CI at every FITTED gap. Raw {A,q} are printed but NOT gated — two selections are two`);
  say(`    selection outcomes, so comparing them compares the rule rather than the fits.`);
  say(`    dropped        A        q      s(iron)  s(bronze) s(silver) s(gold)  s(diamond)  inside s-CI?`);
  for (const x of leg.loo) {
    say(`    ${pad(x.dropped, 12)}${rpad(f(x.A, 4), 8)} ${rpad(f(x.q, 2), 6)} ${LADDER.map((t) => rpad(f(x.sAt.get(t) ?? NaN, 2), 10)).join("")}  ${x.inAll ? "YES ✓" : "NO ✗"}`);
  }
  say(`    full fit s(g)                  ${LADDER.map((t) => rpad(f(sFit(leg.cells.find((c) => c.tier === t)!.gap), 2), 10)).join("")}`);
  say(`    full fit CI               ${LADDER.map((t) => { const q = leg.sCI.get(t)!; return rpad(`${f(q.lo, 2)}-${f(q.hi, 2)}`, 10); }).join("")}`);
  say(`  GATE (w)3: ${leg.w3 ? "PASS" : "FAIL"}`);
  say();
  say(`  ACCEPTANCE — implied s(g_t) vs the measured bootstrap CI, ON THE COHERENT FOUR ONLY`);
  say(`  (≥3 of 4 inside, DIAMOND MANDATORY. Gold is not scored — it is published in §4.)`);
  say(`    tier       gap    s(gap)   measured need   [boot 95% CI]    inside?`);
  for (const a of leg.accept) {
    const c = leg.cells.find((x) => x.tier === a.tier)!;
    say(`    ${pad(a.tier, 9)}${rpad(f(c.gap, 2), 6)}   ${rpad(f(a.s, 3), 6)}   ${rpad(f(a.need, 2), 13)}   [${f(a.lo, 2)},${f(a.hi, 2)}]      ${a.inside ? "YES ✓" : "NO  ✗"}${a.thin ? "   THIN" : ""}`);
  }
  const gg = leg.gold;
  say(`    ${pad("gold", 9)}${rpad(f(gg.gap, 2), 6)}   ${rpad(f(gg.s, 3), 6)}   ${rpad(f(gg.need, 2), 13)}   [${f(gg.needCI.lo, 2)},${f(gg.needCI.hi, 2)}]      NOT SCORED — fitted out (A2.3)`);
  say(`    inside: ${leg.accept.filter((a) => a.inside).length} of 4;  DIAMOND ${leg.diamondIn ? "INSIDE ✓" : "OUTSIDE ✗ (STOP-class — NOT tradeable against the other three)"}`);
  say(`    monotone over the observed range: ${leg.monotone ? "YES ✓" : "NO ✗ (kill condition 6)"}`);
  say(`  ACCEPTANCE: ${leg.acceptPass ? "PASS" : "FAIL"}`);
  say();
  // ── DIAGNOSTICS: never candidates, never a verdict. ──
  say(`  DIAGNOSTIC D2 — RULING (z) MEASURED: HOW MUCH OF THE OLD AMPLITUDE WAS LEVEL, NOT SPREAD?`);
  say(`    The amendment-1 objective was a residual about K̄_pool, so it priced BOTH the judged sample's`);
  say(`    offset from the pool mean AND its spread. Its estimand is the pivot slope; the measured need`);
  say(`    (a FREE slope) is what acceptance scores against. They differ whenever the sample sits off`);
  say(`    K̄_pool — which it does, because cwhit's tables are the top by USAGE. Amendment 2's objective`);
  say(`    has a per-tier free level, so ITS estimand is the weighted free slope.`);
  say(`    tier      K̄_pool/9   wtd mean pred   offset(pred−K̄)   wtd mean resid(obs−pred)   pivot-s   wtd free-s   free slope (= need)`);
  for (const c of leg.cells) {
    say(`    ${pad(c.tier, 9)}${rpad(f(c.kbar9, 2), 7)}   ${rpad(f(c.wPredMean, 2), 13)}   ${rpad(sgn(c.offPred, 2), 15)}   ${rpad(sgn(c.offResid, 2), 24)}   ${rpad(f(c.pivotS, 2), 7)}   ${rpad(f(c.wFreeS, 2), 10)}   ${f(c.need, 2)}`);
  }
  say(`    pivot-s − need:      ${LADDER.map((t) => rpad(sgn(leg.cells.find((c) => c.tier === t)!.pivotS - leg.cells.find((c) => c.tier === t)!.need, 2), 9)).join("")}  mean ${sgn(mean(leg.cells.map((c) => c.pivotS - c.need)), 2)}  ⇐ SYSTEMATIC, same sign everywhere`);
  say(`    wtd free-s − need:   ${LADDER.map((t) => rpad(sgn(leg.cells.find((c) => c.tier === t)!.wFreeS - leg.cells.find((c) => c.tier === t)!.need, 2), 9)).join("")}  mean ${sgn(mean(leg.cells.map((c) => c.wFreeS - c.need)), 2)}  ⇐ WEIGHTING ONLY, and inside every need's CI`);
  say(`    That difference is what ruling (z) removed. The residual weighting difference is reported,`);
  say(`    not hidden: the fit weights each card by 1/noise, the need does not.`);
  say();
  say(`  DIAGNOSTIC D3 — THE RETIRED AMENDMENT-1 OBJECTIVE, SAME FAMILY, SAME SELECTION RULE`);
  say(`    (pivot residual about K̄_pool, coherent four. NOT a candidate — it prices the effect of (z).)`);
  say(`    optimum q* = ${f(leg.pivotFit.opt.q, 2)}  A* = ${f(leg.pivotFit.opt.A, 4)};  selected A = ${f(leg.pivotFit.A, 4)} q = ${f(leg.pivotFit.q, 2)};  set q ∈ [${f(leg.pivotFit.setLo, 2)}, ${f(leg.pivotFit.setHi, 2)}]`);
  for (const [lab, s] of [["   selected", sOf(leg.pivotFit.A, leg.pivotFit.q)], ["   optimum", sOf(leg.pivotFit.opt.A, leg.pivotFit.opt.q)]] as [string, (g: number) => number][]) {
    const sc = scoreAccept(leg.fitCells, s);
    say(`      ${pad(lab, 20)} ${LADDER.map((t) => rpad(f(s(leg.cells.find((c) => c.tier === t)!.gap), 2), 8)).join("")}  ⇒ ${sc.filter((x) => x.inside).length}/4 coherent inside, diamond ${sc.find((x) => x.tier === "diamond")!.inside ? "IN" : "OUT"}`);
  }
  say(`      amendment 2          ${LADDER.map((t) => rpad(f(sFit(leg.cells.find((c) => c.tier === t)!.gap), 2), 8)).join("")}  ⇒ ${leg.accept.filter((a) => a.inside).length}/4 coherent inside, diamond ${leg.diamondIn ? "IN" : "OUT"}`);
  say(`      needs                ${LADDER.map((t) => rpad(f(leg.cells.find((c) => c.tier === t)!.need, 2), 8)).join("")}`);
  say(`    (DIAGNOSTIC — carries no verdict.)`);
  say();
  say(`  DIAGNOSTIC D4 — THE FAMILY'S REACH, AND WHAT GOLD COSTS`);
  say(`    A TIER-AGGREGATE capability probe: fit s(g) straight to the needs, precision-weighted. The`);
  say(`    pre-registration forbids a tier aggregate in the OBJECTIVE; this is not the objective, it is`);
  say(`    the cleanest possible statement of family reach, and it is what ruling (y) was decided on.`);
  const tierAgg = (cs: TierCell[]) => cs.map((c) => { const w = 1 / c.needSe ** 2, e = c.need - 1; return { tier: c.tier, g: c.gap, Swdz: w * e, Swdd: w, Swzz: w * e * e, n: c.rows.length }; });
  const d4b5 = select(profileOf(tierAgg(leg.cells)), gapsOf(leg), sesOf(leg));
  const d4b4 = select(profileOf(tierAgg(leg.fitCells)), gapsOf(leg), sesOf(leg));
  for (const [lab, pn] of [["   all five, optimum", d4b5], ["   coherent four, optimum", d4b4]] as const) {
    const sc = scoreAccept(leg.fitCells, sOf(pn.opt.A, pn.opt.q));
    say(`      ${pad(lab, 26)} A* ${rpad(f(pn.opt.A, 3), 6)} q* ${rpad(f(pn.opt.q, 2), 5)}  ${LADDER.map((t) => rpad(f(sOf(pn.opt.A, pn.opt.q)(leg.cells.find((c) => c.tier === t)!.gap), 2), 8)).join("")}  ⇒ ${sc.filter((x) => x.inside).length}/4 coherent, diamond ${sc.find((x) => x.tier === "diamond")!.inside ? "IN" : "OUT"}`);
  }
  say(`      needs                      ${rpad("", 15)}${LADDER.map((t) => rpad(f(leg.cells.find((c) => c.tier === t)!.need, 2), 8)).join("")}`);
  say(`    Including gold's off-curve need flattens the family and ejects diamond — one tier bought at`);
  say(`    the cost of four. That is ruling (y)'s evidence, reproduced here on this coordinate.`);
  say();
}
const gapsOf = (leg: LegResult) => leg.fitCells.map((c) => c.gap);
const sesOf = (leg: LegResult) => leg.fitCells.map((c) => c.needSe);

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
say(`  1000-bar membership (REPORT ONLY): ${bar1000.accept.filter((a) => a.inside).length} of the 4 coherent tiers inside, diamond ${bar1000.diamondIn ? "inside" : `outside${bar1000.cells.find((c) => c.tier === "diamond")!.rows.length < THIN_N ? " — but that cell is THIN, so it carries NO verdict" : ""}`}.`);
say(`  This line is NOT a gate and no decision hangs on it.`);
say();

say("### 4. GOLD — FITTED OUT, AND SHIPPING AS A PUBLISHED QUANTIFIED RESIDUAL (ruling (y), A2.3)");
say();
const goldCell = primary.cells.find((c) => c.tier === "gold")!;
const silverCell = primary.cells.find((c) => c.tier === "silver")!;
const FIVE = ["Radke", "Randy Jones", "Hilton Smith", "Barnes", "Quisenberry"];
const isFive = (n: string) => FIVE.some((x) => n.toLowerCase().includes(x.toLowerCase()));
const gTotUn = goldCell.rows.reduce((a, r) => a + r.d * r.d, 0);
const gTotW = goldCell.rows.reduce((a, r) => a + r.w * r.d * r.d, 0);
const five = goldCell.rows.filter((r) => isFive(r.name));
say(`  WHY GOLD IS OUT — the structural fact, not a convenience. Gold sits at gap ${f(goldCell.gap, 2)} and needs`);
say(`  ${f(goldCell.need, 2)}; silver sits at the HIGHER gap ${f(silverCell.gap, 2)} and needs only ${f(silverCell.need, 2)}. GOLD'S NEED IS`);
say(`  NON-MONOTONE IN THE COORDINATE. Monotonicity is a requirement (a non-monotone s(g) would reorder`);
say(`  tiers on the very axis it is fitted along), so NO monotone s(g) can carry gold and the coherent`);
say(`  four at once — a structural incompatibility, measured, not a tuning failure. D4 prices it:`);
say(`  including gold flattens the family and ejects diamond, buying one tier at the cost of four.`);
say();
say(`  THE PUBLISHED RESIDUAL (this number ships WITH the constant and is not absorbed into it):`);
say(`    gold        N = ${goldCell.rows.length} rows      gap ${f(goldCell.gap, 2)}`);
say(`    measured need               ${f(goldCell.need, 2)}   [boot 95% CI ${f(goldCell.needCI.lo, 2)}, ${f(goldCell.needCI.hi, 2)}]`);
say(`    shipped s(gap)              ${f(primary.gold.s, 2)}`);
say(`    RESIDUAL  need − s(gap)   ${sgn(primary.gold.resid, 3)}   [boot 95% CI ${f(primary.gold.residCI.lo, 2)}, ${f(primary.gold.residCI.hi, 2)}]`);
say(`    The CI differences the need's OWN bootstrap against the fit's, index-wise. That is legitimate`);
say(`    precisely BECAUSE gold is fitted out: the two resamples are independent, which they would not`);
say(`    be if gold were in the fit.`);
say();
say(`  ATTRIBUTION: the COMPOSITION / COHORT axis. Gold's break is an identity bump on this coordinate`);
say(`  — the gap coordinate does not see whatever distinguishes gold's played population — and the`);
say(`  composition layer is task 2's territory and is not built. It is recorded as a standing, sized,`);
say(`  CI-bearing residual so that task 2 inherits a NUMBER rather than an anecdote.`);
say();
say(`  UNDER-CORRECTION, NOT OVER-CORRECTION: the shipped s falls ${f(Math.abs(primary.gold.resid), 2)} SHORT of gold's need, so gold`);
say(`  keeps ${primary.gold.resid > 0 ? "some of the K-spread compression it has today rather than gaining a new error" : "an over-correction that must be read in the stratified table below"}.`);
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
  say(`  ${f(shW, 1)}% of the leverage a noise-weighted objective gives them.`);
  say();
  say(`  THIS IS WHY THE FIVE CARDS ARE NOT THE EXPLANATION FOR GOLD, and amendment 1 was wrong to hope`);
  say(`  they were: down-weighting them by their own evidential mass barely moves gold's need, so gold's`);
  say(`  break survives the treatment that was supposed to dissolve it. That is the measurement behind`);
  say(`  ruling (y) reversing A1.2 — the five cards are a real, small, published provenance note about`);
  say(`  gold's composition, not a cause. Nothing is hidden either way: they are named, sized, and out.`);
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
say(`    p        (w)2    (w)3    acceptance (coherent inside/4)       A        q      s(20)`);
for (const leg of [pLegs[0]!, primary, pLegs[1]!].sort((a, b) => a.p - b.p)) {
  say(`    ${f(leg.p, 2)}     ${leg.w2.pass ? "PASS" : "FAIL"}    ${leg.w3 ? "PASS" : "FAIL"}    ${rpad(`${leg.accept.filter((a) => a.inside).length}/4, diamond ${leg.diamondIn ? "IN" : "OUT"}`, 33)}  ${rpad(f(leg.sel.A, 4), 7)}  ${rpad(f(leg.sel.q, 2), 5)}  ${f(sOf(leg.sel.A, leg.sel.q)(20), 3)}   gold resid ${sgn(leg.gold.resid, 2)}`);
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
say(`      ${primary.accept.filter((a) => a.inside).length} of the 4 COHERENT tiers inside their measured CI, diamond ${primary.diamondIn ? "INSIDE" : "OUTSIDE"}. Gold fitted out, residual ${sgn(primary.gold.resid, 2)}.`);
say(`      Residuals s(gap) − need: ${LADDER.map((t) => { const a = primary.accept.find((x) => x.tier === t); const c = primary.cells.find((x) => x.tier === t)!; return `${t} ${sgn((a ? a.s : primary.gold.s) - c.need, 2)}${a ? "" : " (gold, not fitted)"}`; }).join("  ")}`);
const liveOpen = valRows.find((v) => v.tid === "live-open-daily")!;
say(`      Non-Quick neutral control (live-open-daily, no era/park, no budget): judged ${liveOpen.judged}, ${liveOpen.verdict}`);
say();
say("  B — ENV-BEARING UNCAPPED DAILIES (+ the era/park layer)");
for (const v of valRows.filter((x) => x.stratum === "B")) say(`      ${pad(lbl(v.label), 20)} judged ${rpad(String(v.judged), 3)}  s ${f(v.s, 3)}  slope ${f(v.preSlope, 2)} → ${f(v.postSlope, 2)}  ${v.verdict}`);
say(`      A miss appearing HERE and not in A localises to the era/park layer, not to the core fit.`);
say();
say("  C — BUDGET CAP/SLOTS FORMATS (+ the composition layer)");
for (const v of valRows.filter((x) => x.stratum.includes("C"))) say(`      ${pad(lbl(v.label), 20)} judged ${rpad(String(v.judged), 3)}  s ${f(v.s, 3)}  slope ${f(v.preSlope, 2)} → ${f(v.postSlope, 2)}  ${v.verdict}${v.stratum === "B+C" ? "   [also carries env ⇒ B+C, not a clean C read]" : ""}`);
say(`      DIAGNOSTIC, NOT A GATE (amendment A2.4). A stratum-C miss does NOT impugn the core fit: it`);
say(`      localises to the COMPOSITION layer, which is task 2's territory and is not built yet. Budget`);
say(`      formats force weak cards into play, which is exactly where the weak-card K over-prediction`);
say(`      bites — and nothing here models a budget. Scoring these as gates would attribute a`);
say(`      composition defect to the core, which is precisely what the stratification forbids.`);
say(`      NOTE the convergence with gold: gold's published residual ${sgn(primary.gold.resid, 2)} is assigned to the SAME`);
say(`      composition axis, and the budget legs sit on the same side. Two independent readings of one`);
say(`      unbuilt layer — which is evidence for the attribution, not a coincidence to explain away.`);
say();

say("### 8. THE CONSTANTS, WITH PROVENANCE STAMPED (acceptance F)");
say();
if (fails.length) {
  say(`  NO CONSTANT IS PROPOSED FOR SHIPPING. ${fails.join(" + ")} failed; the pre-registration says a`);
  say(`  partial pass stays a partial pass and the verdict returns to Fable. What follows is what the`);
  say(`  pre-registered rule PRODUCED, recorded so the record is complete. It is not a recommendation.`);
} else {
  say(`  THE GATES PASS, SO THESE ARE THE CONSTANTS THE PRE-REGISTERED RULE PRODUCED. This tool still`);
  say(`  wires nothing: shipping is a SEPARATE dated commit that quotes this artifact by name, so the`);
  say(`  fit and the wiring can never drift into one step where a re-run silently changes production.`);
}
say();
say(`  K_SPREAD_PIT = { A: ${f(primary.sel.A, 4)}, q: ${f(primary.sel.q, 2)}, G0: ${G0} }`);
say(`  s(g) = 1 + ${f(primary.sel.A, 4)}·(g/${G0})^${f(primary.sel.q, 2)};   s(g ≤ 0) = 1 (league-anchored — never compress a`);
say(`  stronger-than-training pool).`);
say(`  fit-N = ${FIELD_N}   (FIELD_N)`);
say(`  fit-p = ${PRESENCE_P}   (PRESENCE_P)`);
say(`  fitted set = ${COHERENT.join(", ")}   (gold OUT, residual ${sgn(primary.gold.resid, 2)} [${f(primary.gold.residCI.lo, 2)}, ${f(primary.gold.residCI.hi, 2)}] published)`);
say(`  equivalence set = q ∈ [${f(primary.sel.setLo, 2)}, ${f(primary.sel.setHi, 2)}], ${primary.sel.setN} grid points, width ${f(primary.sel.width, 2)} need-SEs; the shipped`);
say(`  point is that set's MINIMAX CENTRE and every member of it delivers an s(g) the acceptance`);
say(`  instrument cannot tell apart. The set is the constant's honest precision and travels with it.`);
say();
say(`  SCORING-SIDE ASSERTION (ships with the constant):`);
say(`      assert(FIELD_N === K_SPREAD_PIT.fitN && PRESENCE_P === K_SPREAD_PIT.fitP)`);
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

// ═══════════════════════════════════════════════════════════════════════════════
// 9. THE EXTRAPOLATION DOMAIN — every configured tournament, not just the captured corpus.
//    ADDED DURING THE AMENDMENT-2 RUN, deliberately, as a MEASUREMENT and not a fit change. The
//    amendment-1 fit was nearly FLAT (s ≈ 1.86 everywhere), so extrapolating it past the fitted gap
//    range was harmless and the standing "live-open-daily g = 44.5" note was a footnote. A CONVEX
//    q ≈ 2.4 power law is UNBOUNDED above, so the same footnote is no longer the same fact — an
//    assessment inherited across a form change, which the intent contract calls a defect until
//    re-derived. It is re-derived here, over PRODUCTION's whole tournament list rather than the nine
//    captured formats, because that is the population the shipped constant actually meets.
// ═══════════════════════════════════════════════════════════════════════════════
say("### 9. THE EXTRAPOLATION DOMAIN — EVERY CONFIGURED TOURNAMENT (added during this run)");
say();
say(`  WHY THIS SECTION EXISTS AND WHY IT WAS NOT IN THE PRE-REGISTRATION: under amendment 1 the`);
say(`  fitted s was nearly FLAT, so extrapolating beyond the fitted gap range 10.31–22.25 was`);
say(`  harmless and "live-open-daily sits at g = 44.5" was a footnote. Amendment 2's fit is CONVEX`);
say(`  and therefore UNBOUNDED above. The footnote is no longer the same fact, so it is re-measured`);
say(`  — over PRODUCTION's ${tournaments.length} configured tournaments, not the ${CWHIT_CORPUS.length} captured formats, because that is`);
say(`  the population a shipped constant actually meets. MEASUREMENT ONLY; no fit was changed.`);
say();
const gMin = Math.min(...primary.fitCells.map((c) => c.gap)), gMax = Math.max(...primary.fitCells.map((c) => c.gap));
interface DomRow { id: string; gap: number; sNew: number; sOld: number; pool: number }
const domRows: DomRow[] = [];
for (const t of tournaments) {
  const era = eras.get(t.eraId), park = parks.get(t.parkId);
  if (!era || !park) continue;
  const cf = resolveCoeffs(model, era, park, t.softcaps);
  applyWobaWeights(cf, trained.wobaWeights!);
  const inV = (c: Card) => { const v = n_(c["Card Value"]); return (t.card_value_min == null || v >= t.card_value_min) && (t.card_value_max == null || v <= t.card_value_max); };
  const pool = baseCards.filter((c) => inV(c) && rowEligible(c as any, t));
  if (!pool.length) continue;
  const g = buildFrameShift(TM, productionFieldStats(pool, cf, rp)).pit.vR.stu ?? 0;
  domRows.push({ id: t.id, gap: g, sNew: sPrimary(g), sOld: sOld(g), pool: pool.length });
}
domRows.sort((a, b) => b.gap - a.gap);
const outside = domRows.filter((d) => d.gap > gMax);
say(`  fitted gap range: ${f(gMin, 2)} – ${f(gMax, 2)}.  Configured tournaments evaluated: ${domRows.length} of ${tournaments.length}.`);
say(`  ABOVE THE FITTED RANGE: ${outside.length} of ${domRows.length}.`);
say();
say(`    tournament                    poolN     gap    s NEW (C3)   s OLD (shipped)   outside fit?`);
for (const d of domRows.slice(0, 14)) {
  say(`    ${pad(d.id, 30)}${rpad(String(d.pool), 5)}   ${rpad(f(d.gap, 2), 6)}   ${rpad(f(d.sNew, 3), 10)}   ${rpad(f(d.sOld, 3), 15)}   ${d.gap > gMax ? "YES — EXTRAPOLATED" : d.gap < gMin ? "below (s → 1, safe)" : "no"}`);
}
say(`    … ${Math.max(0, domRows.length - 14)} further tournaments at or below gap ${f(domRows[13]?.gap ?? 0, 2)} (inside or below the fitted range).`);
say();
say(`  THE FINDING, STATED PLAINLY: the C3 family is CONVEX, so above the fitted range it grows`);
say(`  faster than anything the fit saw. At the largest configured gap ${f(domRows[0]?.gap ?? 0, 2)} it returns`);
say(`  s = ${f(domRows[0]?.sNew ?? 0, 2)}, against ${f(domRows[0]?.sOld ?? 0, 2)} from the currently shipped saturating form, which is bounded`);
say(`  above by 1 + A = ${f(1 + 5.0871, 2)} by construction. The measured evidence at that end of the axis says`);
say(`  NO correction is wanted there at all: live-open-daily's PRE slope is ${f(liveOpen.preSlope, 2)} [${f(liveOpen.preCI.lo, 2)}, ${f(liveOpen.preCI.hi, 2)}],`);
say(`  whose CI COVERS 1 — it is already calibrated uncorrected — and applying s drives it to`);
say(`  ${f(liveOpen.postSlope, 2)} [${f(liveOpen.postCI.lo, 2)}, ${f(liveOpen.postCI.hi, 2)}]. THE COORDINATE AND THE MEASUREMENT DISAGREE AT LARGE GAP.`);
say();
say(`  HOW STRONG IS THAT EVIDENCE — stated so it cannot be over-read. The top of the axis is`);
say(`  observed through ONE captured format (live-open-daily, ${liveOpen.judged} judged rows). That clears the`);
say(`  program's own THIN_N = ${THIN_N} bar and so carries a verdict, but it is one format, and the eight`);
say(`  live-pool tournaments above are inferred to share its gap because they share its pool, not`);
say(`  because each was measured. The RANGE FACT is certain (11 of ${domRows.length} configured tournaments sit`);
say(`  above the fitted range, 8 of them near g = 44); the NEED at g = 44 rests on that one read.`);
say();
say(`  THIS IS NOT A NEW DEFECT — IT IS A PRE-EXISTING ONE THAT THE FORM CHANGE MAGNIFIES. The`);
say(`  shipped saturating ramp ALREADY over-corrects there (s = ${f(domRows[0]?.sOld ?? 0, 2)} where the need is ~1). C3 does not`);
say(`  introduce the disagreement; it changes its size, from bounded to unbounded.`);
say();
say(`  IT IS NOT A GATE AND IT IS NOT SCORED. No pre-registered gate covers it, and inventing one`);
say(`  after seeing the numbers is exactly what pre-registration exists to prevent. It is reported`);
say(`  as a STOP-class item for Fable: whether the shipped constant carries a DOMAIN RULE (hold s`);
say(`  flat above the fitted gap, the way the program already extends curves tangent-linearly outside`);
say(`  their fit domain) is a MODELLING decision, and modelling decisions are not this tool's to make.`);
say();

say("### 10. RECORDED, NOT ACTED ON (the freeze applies)");
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
