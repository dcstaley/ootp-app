// PIT-BABIP COMMON SCALAR — POOLED ESTIMATE OF THE ONE SURVIVING CANDIDATE
//   run: node tools/babip-common-scalar.ts > fixtures/babip-common-scalar-2026-07-26.txt
//
// MEASUREMENT ONLY, AND IT IS A PRE-REGISTRATION INPUT FOR A POST-PULL FIT. This tool fits nothing
// into production, wires nothing, sets no default, pins no constant and commits nothing. All fits on
// cwhit data remain BLOCKED until the wide re-pull (FORMAT_FACTS, Derek's action). What is produced
// here is an ESTIMATE WITH AN INTERVAL that a post-pull fit would be pre-registered against.
//
// THE ESTABLISHED POSITION THIS RUN STANDS ON (not re-derived, not re-litigated):
//   pit-BABIP tier heterogeneity DOES NOT EXIST — fixtures/babip-coordinate-2026-07-26.txt, commit
//   cdffeef. All tier need-CIs intersect at [1.05, 1.41]; I2 = 0%; Q = 2.96 on 4 df; a zero-parameter
//   constant 1.24 +- 0.09 passes through every tier. That run carried a POSITIVE CONTROL — the same
//   instrument on the K channel gives I2 = 92% with an EMPTY intersection — so the null is real and
//   not a power failure. The old "bronze 1.48 vs silver/gold ~1.0" was a point-estimate over-read;
//   BUILD-3's own four published intervals admit a flat scalar in [1.17, 1.30].
//   ⇒ POOLING IS LICENSED. Estimating the ONE flat common scalar, with an interval, is this run's job.
//
// WHAT THIS RUN ADDS, AND ONLY THIS:
//   (1) the pooled scalar and its bootstrap CI, on the FREE-SLOPE estimand (the C3/C6 convention);
//   (2) the per-format inputs feeding it, with THIN/UNREL flags;
//   (3) the heterogeneity statistics RE-CONFIRMED on this estimand, not assumed from the prior run;
//   (4) a BF >= 1000 sensitivity arm beside the BF >= 600 primary;
//   (5) the MEASURED cluster-inflation factor for THIS statistic (never assumed — this corpus has
//       produced 3.1x / 1.07x / 1.02-1.22x / 0.99-1.05x / 1.017x on different statistics);
//   (6) the PRE-REGISTRATION INPUT: what a post-pull fit would fit, under what bar, in what FORM.
//
// STRATA — from docs/FORMAT_FACTS.md, which is authoritative and is NOT re-derived from configs here
// (the coordinate run's config-derived stratification put the two cap dailies at B+C and
// live-open-daily at A; FORMAT_FACTS assigns by the doctrine in SYSTEM_MAP section 6 instead):
//   A = the five neutral quicks · B = earlygold, bronzeheart, latebronze, diamondheart
//   C = goldcapdaily, diamondcapdaily, bronzecapweekly, goldslotsdaily, live-open-daily
// live-open-daily is DECOUPLED (FORMAT_FACTS) and NEVER enters a pooled baseline — separate row only.
//
// COUPLING — SYSTEM_MAP section 1. BIP = 600 - BB - K - HR - BIP_ADJ and hits recompute from BIP, so a
// BABIP quantity measured against a stale K/HR baseline measures something else. EVERY number below is
// conditioned on THE SHIPPED LINE: C3 K ramp ON {A 0.6668, q 2.40, gMax 22.25} + C6 HR ramp ON
// {A 0.1135, q 0.54, gMax 44.56}, sPitBab NEVER SET (production's held state). Stated in the header
// from the constants themselves, so the condition cannot drift away from the report.

import { readFileSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import {
  makeRawPolyModel, productionFieldStats, cohortSelectForModel, applyWobaWeights, computeDerived,
  buildPoolTransform, buildFrameShift, poolPitMeansOwn, FIELD_N,
  kSpreadPitRamp, K_SPREAD_PIT, pitSpreadHrRamp, PIT_SPREAD_HR,
  type EventForm, type FieldStats, type RatingEnvelope, type WobaWeights, type TrainingMeans,
} from "../src/scoring-core/index.ts";
import { presenceMixture, PRESENCE_P, PRESENCE_M } from "../src/data/variants.ts";
import { parseCatalogCsv, type Card } from "../src/data/catalog.ts";
import { rowEligible } from "../src/config/eligibility.ts";
import type { WobaWeights as WW } from "../src/eval/cwhit/audit.ts";
import { babipNoiseVar, BF_PER_9 } from "../src/eval/cwhit/scorecard.ts";
import { mmse } from "../src/eval/cwhit/two-ledger.ts";
import { CWHIT_CORPUS } from "../src/eval/cwhit/corpus.ts";
import {
  buildCwhitSample, inValueWindow, MIN_BF, isPit,
  type Rec, type SampleDeps, type ValueWindow, type KSpreadPit,
} from "../src/eval/cwhit/sample.ts";

const L: string[] = [];
const say = (s = "") => L.push(s);
const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const sd = (xs: number[]) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };
const pad = (s: string, n: number) => s.padEnd(n);
const rpad = (s: string, n: number) => s.padStart(n);

// ═══════════════════════════════════════════════════════════════════════════════
// 0. SETUP — identical construction to tools/babip-coordinate.ts (same corpus, same artifact)
// ═══════════════════════════════════════════════════════════════════════════════
const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state = (await repo.load<{ activeModelId?: string; catalogSourceId?: string }>("state", "app")) ?? {};
type TM_ = { id: string; eventForm?: EventForm; wobaWeights?: WobaWeights; ratingEnvelope?: RatingEnvelope; trainingMeans?: TrainingMeans; cohortRule?: string; platoon?: { pit: { hand: string; vsRHB: number; vsLHB: number }[]; hit: { hand: string; vsRHP: number; vsLHP: number }[] } };
const trained = (await repo.loadAll<TM_>("trained-models")).find((x) => x.id === state.activeModelId);
if (!trained?.eventForm || !trained.wobaWeights || !trained.platoon) throw new Error("active model missing eventForm/wobaWeights/platoon");
if (!trained.trainingMeans) throw new Error("active model has NO trainingMeans — the gap convention needs the artifact frame");
const TM = trained.trainingMeans;
const rp = makeRawPolyModel(trained.eventForm);
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const tournaments = new Map((await repo.loadAll<Tournament>("tournaments")).map((t) => [t.id, t]));
const srcId = state.catalogSourceId ?? "cdmx";
const baseCards = parseCatalogCsv(readFileSync(`data/imports/${srcId}.csv`, "utf8")).cards.filter((c) => String(c["Variant"] ?? "").toUpperCase() !== "Y");
const bq = tournaments.get("bronze-quick")!;
const neutralCoeffs = resolveCoeffs(model, eras.get(bq.eraId)!, parks.get(bq.parkId)!, bq.softcaps);
applyWobaWeights(neutralCoeffs, trained.wobaWeights);
const cohortSel = cohortSelectForModel(trained.cohortRule, baseCards, neutralCoeffs, rp);
const depsBase = {
  baseCards, eventForm: trained.eventForm, model: rp, W: trained.wobaWeights as WW,
  envelope: trained.ratingEnvelope,
  pitExp: new Map(trained.platoon.pit.map((p) => [p.hand, { wR: p.vsRHB, wL: p.vsLHB }])),
  hitExp: new Map(trained.platoon.hit.map((p) => [p.hand, { wR: p.vsRHP, wL: p.vsLHP }])),
};

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pct = (xs: number[], q: number) => { const v = [...xs].sort((a, b) => a - b); return v.length ? v[Math.min(Math.max(Math.floor(q * v.length), 0), v.length - 1)]! : NaN; };
const ci = (xs: number[]) => ({ lo: pct(xs, 0.025), hi: pct(xs, 0.975) });

// ── THE TWO FREE-LEVEL SLOPES ────────────────────────────────────────────────────
// BOTH are "free-slope" in the sense ruling (z) established: a FREE LEVEL, so the pivot is
// unidentified and s is a PURE SPREAD response. They differ ONLY in weighting, and the C3/C6 record
// puts that difference at +0.03 (inside every need's own CI). Both are reported; the primary is named.
//   freeSlopeW  = the C3/C6 FIT OBJECTIVE: per-card noise weights, free level.  <- PRIMARY
//   slopeU      = the C3/C6 GATE need: unweighted OLS obs~pred with a free intercept (mmse().slope),
//                 and the estimand the babip-coordinate run's `need` column carries, so the
//                 heterogeneity re-confirmation below is directly comparable with its numbers.
function freeSlopeW(pred: number[], obs: number[], w: number[]): number {
  let sw = 0, sp = 0, so = 0;
  for (let i = 0; i < pred.length; i++) { sw += w[i]!; sp += w[i]! * pred[i]!; so += w[i]! * obs[i]!; }
  const pb = sw > 0 ? sp / sw : 0, ob = sw > 0 ? so / sw : 0;
  let num = 0, den = 0;
  for (let i = 0; i < pred.length; i++) { const d = pred[i]! - pb; num += w[i]! * d * (obs[i]! - ob); den += w[i]! * d * d; }
  return den > 0 ? num / den : NaN;
}
function slopeU(pred: number[], obs: number[]): number {
  const mp = mean(pred), mo = mean(obs);
  let sxx = 0, sxy = 0;
  for (let i = 0; i < pred.length; i++) { sxx += (pred[i]! - mp) ** 2; sxy += (pred[i]! - mp) * (obs[i]! - mo); }
  return sxx > 0 ? sxy / sxx : NaN;
}

const B = 2000, SEED = 20260726, THIN_N = 15;
const BAR_PRIMARY = MIN_BF, BAR_SENS = 1000;

// ── STRATA, FROM FORMAT_FACTS (authoritative), not re-derived ────────────────────
const STRATUM: Record<string, "A" | "B" | "C"> = {
  ironquick: "A", bronzequick: "A", silverquick: "A", goldquick: "A", diamondquick: "A",
  earlygold: "B", bronzeheart: "B", latebronze: "B", diamondheart: "B",
  goldcapdaily: "C", diamondcapdaily: "C", bronzecapweekly: "C", goldslotsdaily: "C", liveopendaily: "C",
};
const DECOUPLED = "liveopendaily";  // FORMAT_FACTS: never a member of a pooled baseline.

// ═══════════════════════════════════════════════════════════════════════════════
// 1. PER-FORMAT MEASUREMENT
// ═══════════════════════════════════════════════════════════════════════════════
interface Cell {
  key: string; stratum: "A" | "B" | "C"; bar: number;
  nRows: number; nCards: number; rowsPerCard: number;
  needW: number; ciW: { lo: number; hi: number }; seW: number; rowSeW: number; inflW: number; bootW: number[];
  needU: number; ciU: { lo: number; hi: number }; seU: number; rowSeU: number; inflU: number; bootU: number[];
  corr: number; noiseShare: number; noiseShareHi: number; thin: boolean; unrel: boolean;
  /** Kish effective sample size of the PRECISION WEIGHTS, (sum w)^2 / sum w^2, as a share of rows.
   *  The weighted estimand's SE is only as trustworthy as the number of rows actually carrying it;
   *  a low share means a handful of high-BF rows are the estimate. Reported, never used as a filter. */
  kishFrac: number;
}

interface FmtCtx {
  key: string; tid: string; label: string; stratum: "A" | "B" | "C";
  deps: Omit<SampleDeps, "kSpreadPit">; sK: number; sHr: number; pmK: number; pmHr: number;
  gapBab: number; gapK: number; gapHr: number; poolNPit: number;
}

const ctxs: FmtCtx[] = [];
for (const reg of CWHIT_CORPUS) {
  if (!reg.tournamentId) throw new Error(`registry entry '${reg.key}' has no tournamentId`);
  const t = tournaments.get(reg.tournamentId);
  if (!t) throw new Error(`tournament '${reg.tournamentId}' not found`);
  const era = eras.get(t.eraId), park = parks.get(t.parkId);
  if (!era || !park) throw new Error(`tournament '${t.id}' missing era/park`);
  const stratum = STRATUM[reg.key];
  if (!stratum) throw new Error(`format '${reg.key}' has no FORMAT_FACTS stratum in this tool's table`);
  const coeffs = resolveCoeffs(model, era, park, t.softcaps);
  applyWobaWeights(coeffs, trained.wobaWeights!);
  const derived = computeDerived(coeffs, true);
  const win: ValueWindow = {
    tier: reg.key, valueMin: t.card_value_min ?? undefined,
    valueMax: t.card_value_max ?? Number.POSITIVE_INFINITY,
    eligible: (c) => rowEligible(c as Card, t),
  };
  const basePool = baseCards.filter((c) => inValueWindow(c, win));
  const ref: FieldStats = productionFieldStats(baseCards, coeffs, rp, true, undefined, cohortSel);
  const poolField = productionFieldStats(basePool, coeffs, rp, true, undefined, cohortSel);
  const pt = buildPoolTransform(ref, poolField, depsBase.envelope);
  const shift = buildFrameShift(TM, poolField);
  const pm = poolPitMeansOwn(presenceMixture(basePool), coeffs, rp, pt, FIELD_N * PRESENCE_M);
  ctxs.push({
    key: reg.key, tid: t.id, label: reg.label, stratum,
    deps: { ...depsBase, coeffs, derived, ref, formats: [win], select: cohortSel },
    sK: kSpreadPitRamp(shift.pit.vR.stu ?? 0), sHr: pitSpreadHrRamp(shift.pit.vR.hrr ?? 0),
    pmK: pm.k, pmHr: pm.hr,
    gapBab: shift.pit.vR.pbabip ?? 0, gapK: shift.pit.vR.stu ?? 0, gapHr: shift.pit.vR.hrr ?? 0,
    poolNPit: basePool.filter((c) => isPit(c)).length,
  });
}

/** All judged pitcher BABIP rows for one format on the SHIPPED line, at ROW grain, with card ids. */
function rowsFor(fm: FmtCtx): { card: string; pred: number; obs: number; nv: number; w: number; bf: number }[] {
  const ks = new Map<string, KSpreadPit>([[fm.key, { s: fm.sK, mean: fm.pmK, sHr: fm.sHr, meanHr: fm.pmHr }]]);
  // Read at the LOWEST bar; the bar is applied here by filtering `sample`, so both arms are built from
  // one read and cannot diverge on anything but the floor.
  const s = buildCwhitSample({ ...fm.deps, kSpreadPit: ks, minBf: 1 });
  return s.recs
    .filter((r: Rec) => r.role === "pit" && Number.isFinite(r.ours.babip!) && Number.isFinite(r.obs.babip!))
    .map((r) => {
      const bf = r.sample;
      const bip = Math.max(bf - (r.obs.k9! + r.obs.bb9! + r.obs.hr9!) / BF_PER_9 * bf - 0.009 * bf, 1);
      const nv = babipNoiseVar(r.obs.babip!, bip);
      return { card: r.cid.split("|")[0] ?? r.cid, pred: r.ours.babip!, obs: r.obs.babip!, nv, w: nv > 0 ? 1 / nv : 0, bf };
    });
}

function cellFor(fm: FmtCtx, all: ReturnType<typeof rowsFor>, bar: number, seed: number): Cell {
  const rows = all.filter((r) => r.bf >= bar);
  const byCard = new Map<string, typeof rows>();
  for (const r of rows) { const a = byCard.get(r.card); if (a) a.push(r); else byCard.set(r.card, [r]); }
  const ids = [...byCard.keys()];
  const base: Cell = {
    key: fm.key, stratum: fm.stratum, bar, nRows: rows.length, nCards: ids.length,
    rowsPerCard: ids.length ? rows.length / ids.length : NaN,
    needW: NaN, ciW: { lo: NaN, hi: NaN }, seW: NaN, rowSeW: NaN, inflW: NaN, bootW: [],
    needU: NaN, ciU: { lo: NaN, hi: NaN }, seU: NaN, rowSeU: NaN, inflU: NaN, bootU: [],
    corr: NaN, noiseShare: NaN, noiseShareHi: NaN, thin: rows.length < THIN_N, unrel: false,
    kishFrac: rows.length ? (rows.reduce((a, r) => a + r.w, 0) ** 2) / (rows.reduce((a, r) => a + r.w * r.w, 0) * rows.length) : NaN,
  };
  if (rows.length < 3) return base;
  const m = mmse(rows.map((r) => r.pred), rows.map((r) => r.obs), rows.map((r) => r.nv));
  // CLUSTER BY CARD — a card contributes a base row and a v5 row, so rows are not independent.
  // The inflation factor is MEASURED for THIS statistic (cluster SE / row SE), never assumed.
  const rc = rng(seed), rr = rng(seed + 1);
  const bcW: number[] = [], bcU: number[] = [], brW: number[] = [], brU: number[] = [], nsB: number[] = [];
  for (let b = 0; b < B; b++) {
    const draw: typeof rows = [];
    for (let i = 0; i < ids.length; i++) draw.push(...byCard.get(ids[Math.floor(rc() * ids.length)]!)!);
    const dp = draw.map((r) => r.pred), dobs = draw.map((r) => r.obs), dw = draw.map((r) => r.w);
    bcW.push(freeSlopeW(dp, dobs, dw));
    bcU.push(slopeU(dp, dobs));
    const so = sd(dobs);
    nsB.push(so > 0 ? mean(draw.map((r) => r.nv)) / so ** 2 : NaN);
    const d2 = rows.map(() => rows[Math.floor(rr() * rows.length)]!);
    const rp2 = d2.map((r) => r.pred), ro2 = d2.map((r) => r.obs), rw2 = d2.map((r) => r.w);
    brW.push(freeSlopeW(rp2, ro2, rw2));
    brU.push(slopeU(rp2, ro2));
  }
  const fW = bcW.filter(Number.isFinite), fU = bcU.filter(Number.isFinite);
  const gW = brW.filter(Number.isFinite), gU = brU.filter(Number.isFinite);
  const seW = sd(fW), seU = sd(fU), rowSeW = sd(gW), rowSeU = sd(gU);
  const nsHi = pct(nsB.filter(Number.isFinite), 0.975);
  return {
    ...base,
    needW: freeSlopeW(rows.map((r) => r.pred), rows.map((r) => r.obs), rows.map((r) => r.w)),
    ciW: ci(fW), seW, rowSeW, inflW: rowSeW > 0 ? seW / rowSeW : NaN, bootW: fW,
    needU: m.slope.est, ciU: ci(fU), seU, rowSeU, inflU: rowSeU > 0 ? seU / rowSeU : NaN, bootU: fU,
    corr: m.corrRaw, noiseShare: m.noiseShare, noiseShareHi: nsHi,
    unrel: Number.isFinite(nsHi) && nsHi >= 1,
  };
}

const allRows = new Map<string, ReturnType<typeof rowsFor>>();
for (const fm of ctxs) allRows.set(fm.key, rowsFor(fm));
const cells600 = new Map<string, Cell>();
const cells1000 = new Map<string, Cell>();
for (const [i, fm] of ctxs.entries()) {
  const a = allRows.get(fm.key)!;
  cells600.set(fm.key, cellFor(fm, a, BAR_PRIMARY, SEED + i * 401));
  cells1000.set(fm.key, cellFor(fm, a, BAR_SENS, SEED + 90000 + i * 401));
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2. POOLING + HETEROGENEITY (re-confirmation, not assumption)
// ═══════════════════════════════════════════════════════════════════════════════
function erfc(x: number): number {
  const z = Math.abs(x), t = 1 / (1 + z / 2);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806
    + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}
function chiSqP(q: number, df: number): number {
  if (!(df > 0) || !Number.isFinite(q)) return NaN;
  const z = (Math.pow(q / df, 1 / 3) - (1 - 2 / (9 * df))) / Math.sqrt(2 / (9 * df));
  return 0.5 * erfc(z / Math.SQRT2);
}
interface Pooled {
  name: string; k: number; members: string[]; dropped: string[];
  pooled: number; se: number; bootLo: number; bootHi: number;
  Q: number; df: number; I2: number; pQ: number;
  interLo: number; interHi: number; constantOk: boolean;
}
/** Inverse-variance pooling on the CLUSTERED SEs. The pooled BOOTSTRAP CI combines each format's
 *  replicate b at FIXED point-estimate weights: formats are independent samples, so replicate b of
 *  each is a valid joint draw, and holding the weights fixed keeps the bootstrap on the SAME
 *  estimator rather than on a weight-reselecting one. The analytic +-1.96*se is printed beside it. */
function poolOf(name: string, cs: Cell[], est: (c: Cell) => number, se: (c: Cell) => number,
                lo: (c: Cell) => number, hi: (c: Cell) => number, boot: (c: Cell) => number[]): Pooled {
  const ok = cs.filter((c) => c.nRows >= THIN_N && Number.isFinite(est(c)) && se(c) > 0);
  const dropped = cs.filter((c) => !ok.includes(c)).map((c) => `${c.key}(N=${c.nRows})`);
  const w = ok.map((c) => 1 / se(c) ** 2);
  const sw = w.reduce((a, b) => a + b, 0);
  const pooled = ok.reduce((a, c, i) => a + w[i]! * est(c), 0) / (sw || 1);
  const Q = ok.reduce((a, c, i) => a + w[i]! * (est(c) - pooled) ** 2, 0);
  const df = Math.max(ok.length - 1, 0);
  const reps: number[] = [];
  const nB = Math.min(...ok.map((c) => boot(c).length));
  for (let b = 0; b < nB; b++) {
    let s = 0;
    for (let i = 0; i < ok.length; i++) s += w[i]! * boot(ok[i]!)[b]!;
    reps.push(s / sw);
  }
  const bci = reps.length ? ci(reps) : { lo: NaN, hi: NaN };
  return {
    name, k: ok.length, members: ok.map((c) => c.key), dropped,
    pooled, se: sw > 0 ? Math.sqrt(1 / sw) : NaN, bootLo: bci.lo, bootHi: bci.hi,
    Q, df, I2: df > 0 && Q > 0 ? Math.max(0, (Q - df) / Q) : 0, pQ: chiSqP(Q, df),
    interLo: ok.length ? Math.max(...ok.map(lo)) : NaN,
    interHi: ok.length ? Math.min(...ok.map(hi)) : NaN,
    constantOk: ok.length ? Math.max(...ok.map(lo)) <= Math.min(...ok.map(hi)) : false,
  };
}
const W = { est: (c: Cell) => c.needW, se: (c: Cell) => c.seW, lo: (c: Cell) => c.ciW.lo, hi: (c: Cell) => c.ciW.hi, boot: (c: Cell) => c.bootW };
const U = { est: (c: Cell) => c.needU, se: (c: Cell) => c.seU, lo: (c: Cell) => c.ciU.lo, hi: (c: Cell) => c.ciU.hi, boot: (c: Cell) => c.bootU };
const poolIt = (name: string, cs: Cell[], k: typeof W) => poolOf(name, cs, k.est, k.se, k.lo, k.hi, k.boot);

const setOf = (m: Map<string, Cell>, strata: ("A" | "B" | "C")[]) =>
  ctxs.filter((c) => strata.includes(c.stratum) && c.key !== DECOUPLED).map((c) => m.get(c.key)!);
const liveOf = (m: Map<string, Cell>) => [m.get(DECOUPLED)!];

const SETS: { name: string; strata: ("A" | "B" | "C")[] }[] = [
  { name: "A alone (five neutral quicks)", strata: ["A"] },
  { name: "A + B (quicks + env dailies)", strata: ["A", "B"] },
  { name: "ALL (A + B + C, live EXCLUDED)", strata: ["A", "B", "C"] },
];
const pooled600W = SETS.map((s) => poolIt(s.name, setOf(cells600, s.strata), W));
const pooled600U = SETS.map((s) => poolIt(s.name, setOf(cells600, s.strata), U));
const pooled1000W = SETS.map((s) => poolIt(s.name, setOf(cells1000, s.strata), W));
const pooled1000U = SETS.map((s) => poolIt(s.name, setOf(cells1000, s.strata), U));
const live600W = poolIt("live-open-daily (DECOUPLED — separate row, never pooled)", liveOf(cells600), W);
const live600U = poolIt("live-open-daily (DECOUPLED — separate row, never pooled)", liveOf(cells600), U);
const live1000W = poolIt("live-open-daily (DECOUPLED — separate row, never pooled)", liveOf(cells1000), W);

const HEAD = pooled600W[0]!;      // the headline: stratum A, primary bar, primary estimand
const ALLW = pooled600W[2]!;

/** LEAVE-ONE-FORMAT-OUT on the heterogeneity read. A Q/I2/intersection verdict carried by ONE cell is
 *  a property of that cell, not of the channel — and this corpus's thinnest cells are exactly the ones
 *  most able to carry one. Computed, not assumed, for every set that gets a verdict. */
function looOf(cs: Cell[], k: typeof W): { drop: string; n: number; pooled: number; Q: number; I2: number; lo: number; hi: number; ok: boolean }[] {
  const ok = cs.filter((c) => c.nRows >= THIN_N && Number.isFinite(k.est(c)) && k.se(c) > 0);
  return ok.map((d) => {
    const keep = ok.filter((c) => c !== d);
    const p = poolOf("loo", keep, k.est, k.se, k.lo, k.hi, k.boot);
    return { drop: d.key, n: d.nRows, pooled: p.pooled, Q: p.Q, I2: p.I2, lo: p.interLo, hi: p.interHi, ok: p.constantOk };
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3. REPORT
// ═══════════════════════════════════════════════════════════════════════════════
say("################################################################################");
say("# PIT-BABIP COMMON SCALAR — the pooled estimate of the ONE surviving candidate");
say("# tools/babip-common-scalar.ts · 2026-07-26 · MEASUREMENT ONLY.");
say("# NOTHING IS FITTED, WIRED, DEFAULTED OR COMMITTED. This is a PRE-REGISTRATION INPUT for a");
say("# POST-PULL fit; all fits on cwhit data remain blocked until the wide re-pull.");
say("################################################################################");
say();
say("## THE ANSWER");
say();
say(`  ONE FLAT COMMON PIT-BABIP SPREAD SCALAR, stratum A (the five neutral quicks), BF >= ${BAR_PRIMARY},`);
say(`  FREE-SLOPE estimand (precision-weighted free level = the C3/C6 FIT objective):`);
say();
say(`      s_babip = ${f(HEAD.pooled, 3)}   bootstrap 95% CI [${f(HEAD.bootLo, 3)}, ${f(HEAD.bootHi, 3)}]   (analytic +-1.96se: [${f(HEAD.pooled - 1.96 * HEAD.se, 3)}, ${f(HEAD.pooled + 1.96 * HEAD.se, 3)}], se ${f(HEAD.se, 3)})`);
say();
say(`  On the GATE estimand (unweighted OLS obs~pred, free intercept — the babip-coordinate run's`);
say(`  \`need\` column, so directly comparable with its 1.238 [1.05, 1.41]):`);
say(`      s_babip = ${f(pooled600U[0]!.pooled, 3)}   bootstrap 95% CI [${f(pooled600U[0]!.bootLo, 3)}, ${f(pooled600U[0]!.bootHi, 3)}]`);
say();
say("  DO THE STRATA MOVE IT? (primary estimand, primary bar)");
for (const p of pooled600W) {
  say(`      ${pad(p.name, 34)} k=${p.k}  s = ${f(p.pooled, 3)}  [${f(p.bootLo, 3)}, ${f(p.bootHi, 3)}]  se ${f(p.se, 3)}`);
}
{
  const spread = Math.max(...pooled600W.map((p) => p.pooled)) - Math.min(...pooled600W.map((p) => p.pooled));
  const widest = Math.max(...pooled600W.map((p) => p.se));
  say(`      ⇒ total movement across the three sets = ${f(spread, 3)}, against a smallest-set SE of ${f(widest, 3)}`);
  say(`        (${spread <= widest ? "INSIDE one SE of the narrowest-stratum estimate — environment and budget do NOT move the scalar" : "EXCEEDS one SE — environment or budget IS moving the scalar; read the per-stratum table before pooling"})`);
}
say();
say(`  DECOUPLED, REPORTED SEPARATELY, NEVER POOLED (FORMAT_FACTS): live-open-daily`);
say(`      s = ${f(live600W.pooled, 3)}  [${f(live600W.bootLo, 3)}, ${f(live600W.bootHi, 3)}]  on ${cells600.get(DECOUPLED)!.nRows} rows / ${cells600.get(DECOUPLED)!.nCards} cards`);
say(`      gate estimand ${f(live600U.pooled, 3)} [${f(live600U.bootLo, 3)}, ${f(live600U.bootHi, 3)}]. This is a MEASUREMENT POINT, not a baseline member.`);
say();
say("  HETEROGENEITY — RE-CONFIRMATION ATTEMPTED, AND IT IS ESTIMAND-DEPENDENT. READ THIS BEFORE");
say("  USING THE NUMBER ABOVE.");
say();
say("    GATE estimand (what the established position was measured on) — REPRODUCES EXACTLY:");
for (const p of pooled600U) {
  say(`      ${pad(p.name, 34)} Q = ${rpad(f(p.Q, 2), 5)} / ${p.df} df · I2 = ${rpad(f(100 * p.I2, 0) + "%", 4)} · p = ${f(p.pQ, 3)} · intersection [${f(p.interLo, 2)}, ${f(p.interHi, 2)}] ${p.constantOk ? "NON-EMPTY" : "EMPTY"}`);
}
say(`      Stratum A reads Q = ${f(pooled600U[0]!.Q, 2)} / 4 df, I2 = ${f(100 * pooled600U[0]!.I2, 0)}%, intersection [${f(pooled600U[0]!.interLo, 2)}, ${f(pooled600U[0]!.interHi, 2)}] — the coordinate run's`);
say("      2.96 / 0% / [1.05, 1.41] to the digit. The instrument is the same instrument. THE ESTABLISHED");
say("      POSITION IS NOT DISTURBED ON ITS OWN ESTIMAND.");
say();
say("    PRIMARY (FIT) estimand — DOES NOT REPRODUCE THE NULL:");
for (const p of pooled600W) {
  say(`      ${pad(p.name, 34)} Q = ${rpad(f(p.Q, 2), 5)} / ${p.df} df · I2 = ${rpad(f(100 * p.I2, 0) + "%", 4)} · p = ${f(p.pQ, 3)} · intersection [${f(p.interLo, 2)}, ${f(p.interHi, 2)}] ${p.constantOk ? "NON-EMPTY" : "EMPTY"}`);
}
say(`      Stratum A reads I2 = ${f(100 * pooled600W[0]!.I2, 0)}% at p = ${f(pooled600W[0]!.pQ, 3)}. The intersection is still non-empty, but only`);
say(`      just — [${f(pooled600W[0]!.interLo, 2)}, ${f(pooled600W[0]!.interHi, 2)}] is ${f(pooled600W[0]!.interHi - pooled600W[0]!.interLo, 2)} wide — and at BF >= ${BAR_SENS} it goes EMPTY (§3).`);
say();
say("    WHY THE TWO DISAGREE, mechanically: the point estimates are not the issue, the PRECISION is.");
say("    The weighted estimator's SEs are roughly HALF the unweighted ones on the same rows, so the same");
say("    dispersion of point estimates crosses from 'inside the noise' to 'outside it'. Q is a");
say("    signal-to-noise statistic; halving the noise while holding the signal quadruples Q.");
say();
say("    WHAT THIS DOES AND DOES NOT LICENCE:");
say("      · It does NOT overturn the established null, which is a statement about the gate estimand and");
say("        reproduces exactly. It is not re-litigated here and this run produces no coordinate evidence.");
say("      · It DOES mean the pooling licence is conditional on the estimand, and the estimand a fit");
say("        would MINIMISE is the one that fails. Filed in the PRE-REGISTRATION section as a required");
say("        pre-fit check, not as a finding about the channel.");
say("      · The pooled POINT ESTIMATE is robust to all of this: 1.22–1.28 across every set, both bars");
say("        and both estimands. What is fragile is the claim that one number is ENOUGH.");
say();

say("## 0. HEADER — WHAT THIS IS CONDITIONED ON");
say(`  model        '${trained.id}' (raw-poly, own-gap path)   cohortRule '${trained.cohortRule ?? "model-woba"}'`);
say(`  catalog      '${srcId}' — ${baseCards.length} base cards`);
say(`  corpus       buildCwhitSample DEFAULT_SOURCE (fixtures/cwhit-capture-2026-07-21), ${ctxs.length} formats by tournamentId`);
say(`  K/HR CONFIG  THE SHIPPED LINE, and this is load-bearing (SYSTEM_MAP §1):`);
say(`                 C3 K ramp ON  {A ${K_SPREAD_PIT.A}, q ${K_SPREAD_PIT.q}, G0 ${K_SPREAD_PIT.G0}, gMax ${K_SPREAD_PIT.gMax}}`);
say(`                 C6 HR ramp ON {A ${PIT_SPREAD_HR.A}, q ${PIT_SPREAD_HR.q}, G0 ${PIT_SPREAD_HR.G0}, gMax ${PIT_SPREAD_HR.gMax}}`);
say(`                 sPitBab NEVER SET — production's held state, so this measures the RESIDUAL need.`);
say(`               BIP = 600 − BB − K − HR − BIP_ADJ and hits recompute from BIP, so K and HR are`);
say(`               applied PRE-BIP and MOVE predicted BABIP. A scalar measured against a different`);
say(`               K/HR baseline is a DIFFERENT QUANTITY. If either ramp is re-fitted, this number is`);
say(`               STALE and must be re-measured — it cannot be rescaled.`);
say(`  estimand     PRIMARY = free-level slope with per-card noise weights (tools/fit-kspread-c3.ts /`);
say(`               tools/fit-hrspread-c6.ts objective, ruling (z): a free level leaves the pivot`);
say(`               unidentified so s is a PURE SPREAD response; level belongs to the anchor layer).`);
say(`               SECONDARY = unweighted OLS obs~pred with a free intercept = mmse().slope, the`);
say(`               estimand the C3/C6 GATES score and the babip-coordinate run published.`);
say(`  bars         PRIMARY BF >= ${BAR_PRIMARY} (= MIN_BF, symmetric with PA >= 500) · SENSITIVITY BF >= ${BAR_SENS}`);
say(`  grain        OBSERVED STATISTIC AT ROW GRAIN — a row is (card × variant level); a card can`);
say(`               contribute a base row and a v5 row. Pool constants (K̄/HR̄/BAB̄, gaps) are CARD grain.`);
say(`               INFERENCE IS CLUSTERED AT CARD GRAIN, and the inflation factor is MEASURED per cell`);
say(`               below (this corpus has produced 3.1x / 1.07x / 1.02-1.22x / 0.99-1.05x / 1.017x on`);
say(`               different statistics — it is never assumed).`);
say(`  uncertainty  B = ${B} bootstrap, SEED = ${SEED}. Cluster bootstrap = resample CARDS with`);
say(`               replacement, take all their rows. Row bootstrap is run in parallel ONLY to measure`);
say(`               the inflation, never to make a CI.`);
say(`  presence     PRESENCE_P ${PRESENCE_P}, PRESENCE_M ${PRESENCE_M}, FIELD_N ${FIELD_N}`);
say(`  flags        THIN = N < ${THIN_N} judged rows ⇒ EXCLUDED from every pool (no verdict from a thin cell).`);
say(`               UNREL = bootstrap 97.5th pct of the noise share >= 100%. The SLOPE is noise-immune`);
say(`               so an UNREL cell still carries a slope, but its spread statistics do not.`);
say();

say("## 1. THE PER-FORMAT INPUTS — BF >= 600 (PRIMARY)");
say();
say("  format            str   rows  cards  r/c  kish   free-s   [ 95% CI ]      se   rowSE   infl    gate-s   [ 95% CI ]      se   infl   corr  nsHi  flags");
const fmtRow = (c: Cell) => {
  const flags = [c.thin ? "THIN" : "", c.unrel ? "UNREL" : ""].filter(Boolean).join(",") || "—";
  return `  ${pad(c.key, 17)} ${pad(c.stratum, 4)} ${rpad(String(c.nRows), 5)} ${rpad(String(c.nCards), 6)} ${rpad(f(c.rowsPerCard, 2), 5)} ${rpad(f(c.kishFrac, 2), 5)}  ${rpad(f(c.needW, 3), 6)} [${f(c.ciW.lo, 2)}, ${f(c.ciW.hi, 2)}] ${rpad(f(c.seW, 3), 7)} ${rpad(f(c.rowSeW, 3), 6)} ${rpad(f(c.inflW, 3), 6)}  ${rpad(f(c.needU, 3), 6)} [${f(c.ciU.lo, 2)}, ${f(c.ciU.hi, 2)}] ${rpad(f(c.seU, 3), 7)} ${rpad(f(c.inflU, 3), 5)} ${rpad(f(c.corr, 2), 6)} ${rpad(f(c.noiseShareHi, 2), 5)}  ${flags}`;
};
for (const s of ["A", "B", "C"] as const) {
  const lbl = s === "A" ? "-- STRATUM A: the five neutral quicks (core) --"
    : s === "B" ? "-- STRATUM B: env-bearing uncapped dailies --"
      : "-- STRATUM C: budget / restricted / decoupled --";
  say(`  ${lbl}`);
  for (const fm of ctxs.filter((c) => c.stratum === s)) {
    say(fmtRow(cells600.get(fm.key)!) + (fm.key === DECOUPLED ? "   <- DECOUPLED, never pooled" : ""));
  }
}
say();
say("  'free-s' = precision-weighted free-level slope (PRIMARY). 'gate-s' = unweighted OLS free-intercept");
say("  slope (the C3/C6 gate need). 'infl' = MEASURED cluster-SE / row-SE for THAT statistic. 'r/c' = rows");
say("  per card. 'kish' = Kish effective-N of the precision weights as a SHARE of rows — how much of the");
say("  cell the weighted estimate actually rests on. 'nsHi' = bootstrap 97.5th pct noise share.");
say();
say("  PROVENANCE CHECK — this instrument reproduces the established run cell for cell. Both columns match");
say("  fixtures/babip-coordinate-2026-07-26.txt §3 exactly (its `need` = gate-s, its `free-s` = free-s):");
say("  iron 1.245/1.110 · bronze 1.325/1.503 · silver 1.377/1.409 · gold 1.009/1.020 · diamond 0.911/0.787.");
say("  So the divergence reported in THE ANSWER is between two estimands, not between two instruments.");
{
  const use600 = ctxs.map((c) => cells600.get(c.key)!).filter((c) => c.nRows >= THIN_N);
  const iW = use600.map((c) => c.inflW).filter(Number.isFinite);
  const iU = use600.map((c) => c.inflU).filter(Number.isFinite);
  say();
  say(`  CLUSTER INFLATION FOR THIS STATISTIC, MEASURED (never assumed):`);
  say(`    free-s   mean ${f(mean(iW), 3)}x  range ${f(Math.min(...iW), 2)}–${f(Math.max(...iW), 2)}x over ${iW.length} non-thin cells`);
  say(`    gate-s   mean ${f(mean(iU), 3)}x  range ${f(Math.min(...iU), 2)}–${f(Math.max(...iU), 2)}x`);
  const rc = use600.map((c) => c.rowsPerCard);
  say(`    WHY it is near 1: rows per card is ${f(Math.min(...rc), 2)}–${f(Math.max(...rc), 2)} (mean ${f(mean(rc), 2)}) once the BF floor`);
  say(`    is applied — most judged cards contribute ONE row, so there is little cluster structure LEFT to`);
  say(`    inflate. That is a measured property of THIS corpus at THIS bar, not a licence to skip clustering:`);
  say(`    every CI below is still the CLUSTERED one.`);
}
say();

say("## 2. THE POOLED SCALAR BY STRATUM SET — BF >= 600 (PRIMARY)");
say();
say("  Pooling is licensed by the established position (fixtures/babip-coordinate-2026-07-26.txt, cdffeef:");
say("  I2 = 0%, Q = 2.96/4 df, intersection [1.05, 1.41], with a K-channel positive control at I2 = 92% and");
say("  an EMPTY intersection). The Q/I2/intersection columns below are a RE-CONFIRMATION on this run's own");
say("  estimands and bars, NOT an assumption carried over — and the re-confirmation SUCCEEDS on the gate");
say("  estimand and FAILS to reproduce on the primary one. Both are printed. See THE ANSWER for the read.");
say();
const poolTable = (rows: Pooled[], live: Pooled, label: string) => {
  say(`  ${label}`);
  say("    set                                  k   pooled   [boot 95% CI]      se       Q  df    I2      pQ  CI-intersection");
  for (const p of rows) {
    say(`    ${pad(p.name, 34)} ${rpad(String(p.k), 2)}   ${rpad(f(p.pooled, 3), 6)}   [${f(p.bootLo, 3)}, ${f(p.bootHi, 3)}] ${rpad(f(p.se, 3), 7)} ${rpad(f(p.Q, 2), 7)} ${rpad(String(p.df), 3)} ${rpad(f(100 * p.I2, 0) + "%", 5)} ${rpad(f(p.pQ, 3), 7)}  [${f(p.interLo, 2)}, ${f(p.interHi, 2)}] ${p.constantOk ? "NON-EMPTY" : "EMPTY"}`);
    if (p.dropped.length) say(`      dropped as THIN (N < ${THIN_N}): ${p.dropped.join(", ")}`);
  }
  say(`    ${pad("live-open-daily [DECOUPLED, separate]", 34)} ${rpad(String(live.k), 2)}   ${rpad(f(live.pooled, 3), 6)}   [${f(live.bootLo, 3)}, ${f(live.bootHi, 3)}] ${rpad(f(live.se, 3), 7)}       —   —     —       —  single format`);
};
poolTable(pooled600W, live600W, "PRIMARY ESTIMAND — precision-weighted free-level slope (the C3/C6 fit objective)");
say();
poolTable(pooled600U, live600U, "GATE ESTIMAND — unweighted OLS free-intercept slope (what the C3/C6 gates score)");
say();
say("  LEAVE-ONE-FORMAT-OUT ON THE HETEROGENEITY READ (primary estimand, BF >= 600). A verdict carried by");
say("  ONE cell is a property of that cell — and this corpus's thinnest cells are the ones most able to");
say("  carry one (FORMAT_FACTS flags diamond as historically thin, ~N=36 at this bar).");
say("    drop from stratum A     N   pooled       Q    I2   intersection");
{
  const loo = looOf(setOf(cells600, ["A"]), W);
  for (const r of loo) {
    say(`      ${pad(r.drop, 20)} ${rpad(String(r.n), 4)}   ${f(r.pooled, 3)}  ${rpad(f(r.Q, 2), 6)} ${rpad(f(100 * r.I2, 0) + "%", 5)} [${f(r.lo, 2)}, ${f(r.hi, 2)}] ${r.ok ? "NON-EMPTY" : "EMPTY"}`);
  }
  const i2lo = Math.min(...loo.map((r) => r.I2)), i2hi = Math.max(...loo.map((r) => r.I2));
  say(`    READ, AND IT CUTS AGAINST THE COMFORTABLE ANSWER: I2 stays ${f(100 * i2lo, 0)}–${f(100 * i2hi, 0)}% whichever format is`);
  say("    dropped. The primary-estimand dispersion at BF >= 600 is NOT carried by one cell — it is a");
  say("    property of the set. (Contrast the BF >= 1000 empty intersection in §3, which IS one cell.)");
  say(`    The pooled point estimate meanwhile moves only ${f(Math.min(...loo.map((r) => r.pooled)), 2)}–${f(Math.max(...loo.map((r) => r.pooled)), 2)}, so the SCALAR is LOO-robust even where`);
  say("    the adequacy of a single scalar is not.");
}
say();
say("  READING THE STRATA. If the pooled scalar moves materially from A to A+B to ALL, the movement is");
say("  ENVIRONMENT (B) or BUDGET/DEPLOYMENT (C), not the BABIP channel, and it must not be absorbed into");
say("  a channel constant. Movement measured above; the A-alone estimate is the one a core-layer constant");
say("  would be pre-registered against, with A+B and ALL as coherence checks.");
say();

say("## 3. SENSITIVITY ARM — BF >= 1000");
say();
say("  format            str   rows  cards  r/c  kish   free-s   [ 95% CI ]      se   rowSE   infl    gate-s   [ 95% CI ]      se   infl   corr  nsHi  flags");
for (const s of ["A", "B", "C"] as const) {
  for (const fm of ctxs.filter((c) => c.stratum === s)) say(fmtRow(cells1000.get(fm.key)!) + (fm.key === DECOUPLED ? "   <- DECOUPLED" : ""));
}
say();
poolTable(pooled1000W, live1000W, "PRIMARY ESTIMAND at BF >= 1000");
say();
say();
say("  THE BF >= 1000 INTERSECTION IS EMPTY ON THE PRIMARY ESTIMAND — AND IT IS ONE CELL. Leave-one-out:");
say("    drop from stratum A     N   pooled       Q    I2   intersection");
for (const r of looOf(setOf(cells1000, ["A"]), W)) {
  say(`      ${pad(r.drop, 20)} ${rpad(String(r.n), 4)}   ${f(r.pooled, 3)}  ${rpad(f(r.Q, 2), 6)} ${rpad(f(100 * r.I2, 0) + "%", 5)} [${f(r.lo, 2)}, ${f(r.hi, 2)}] ${r.ok ? "NON-EMPTY" : "EMPTY"}`);
}
say("    Diamond at this bar is N=19 / 16 cards with corr 0.23 and a noise-share upper of ~5 — it is the");
say("    cell FORMAT_FACTS warns about, sitting just over the THIN line rather than under it. Read the");
say("    empty intersection as 'the tightest bar puts the thinnest cell in charge', which is a DEPTH");
say("    statement about the corpus. It is NOT evidence of tier heterogeneity and is not offered as any.");
say();
{
  const dW = pooled1000W.map((p, i) => p.pooled - pooled600W[i]!.pooled);
  say("  BAR MOVEMENT (BF>=1000 minus BF>=600), primary estimand:");
  for (const [i, s] of SETS.entries()) say(`    ${pad(s.name, 34)} ${dW[i]! >= 0 ? "+" : ""}${f(dW[i]!, 3)}   (BF>=600 se ${f(pooled600W[i]!.se, 3)}, BF>=1000 se ${f(pooled1000W[i]!.se, 3)})`);
  say(`  A tighter bar buys precision only if it does not cost more rows than it removes noise; here it`);
  say(`  moves the point estimate by ${f(Math.max(...dW.map(Math.abs)), 3)} at most while WIDENING the SE, which is the expected`);
  say(`  direction and is why BF >= ${BAR_PRIMARY} is the primary bar rather than a compromise.`);
}
say();

say("## 4. WHAT WOULD FALSIFY THE FLAT SCALAR (stated so the null is not unfalsifiable)");
say();
say("  A flat scalar dies when the per-format CI intersection goes EMPTY on an estimand and bar where the");
say("  cell driving it is NOT the thinnest one — i.e. when leave-one-out cannot restore it. On the gate");
say("  estimand it survives comfortably at both bars. On the primary estimand it survives at BF >= 600");
say("  with almost no slack and fails at BF >= 1000 on a single N=19 cell that LOO restores.");
say();
say("  BUT DO NOT TAKE THE LOO RESCUE AS AN ALL-CLEAR. The BF >= 1000 INTERSECTION is one cell; the");
say("  BF >= 600 primary-estimand I2 is NOT (§2 LOO: 68–73% whichever format is dropped). Those are two");
say("  different statistics and only the first is a thin-cell artefact. What survives depth-scepticism is");
say("  'the intersection has not been shown empty', not 'the formats agree'.");
say();
say("  SO THE HONEST STATE IS: NOT FALSIFIED, AND NO LONGER COMFORTABLE. Both readings are one depth");
say(`  increment from being decidable — stratum A primary-estimand SEs run ${f(Math.min(...setOf(cells600, ["A"]).map((c) => c.seW)), 2)}–${f(Math.max(...setOf(cells600, ["A"]).map((c) => c.seW)), 2)}, and the`);
say("  question is settled by roughly a halving of them, i.e. ~4x the judged rows per format. That is the");
say("  SAME depth requirement the coordinate run named in its §11(c), reached from a different direction,");
say("  and it is exactly why this estimate is an INPUT to a post-pull fit rather than a fit.");
say();
say("  ONE MISREADING TO KILL BEFORE IT STARTS. bronzequick reads 1.503 on the primary estimand, which");
say("  is close to BUILD-3's famous 1.48. THAT IS A COINCIDENCE OF TWO DIFFERENT ESTIMANDS, NOT A");
say("  REPRODUCTION. BUILD-3's published per-tier BABIP slopes are mmse().slope — the UNWEIGHTED");
say("  free-intercept slope (tools/fit-pitspread-hrbab.ts, `mBab.slope.est`), i.e. this run's GATE");
say(`  column, where bronze reads ${f(cells600.get("bronzequick")!.needU, 3)}. The coordinate run's finding that 1.48 is not recoverable`);
say("  on any configuration reachable today stands, and nothing here revives it.");
say();

say("## PRE-REGISTRATION INPUT");
say();
say("  Filed BEFORE the wide re-pull, so the post-pull run is a test and not a search. Nothing here is");
say("  fitted, wired, defaulted or committed by this tool.");
say();
say("  (1) WHAT WOULD BE FIT — exactly one number.");
say("      A SINGLE, FORMAT-INDEPENDENT pitcher-BABIP spread scalar. ZERO coordinate parameters: no gap");
say("      response, no tier index, no pool property, no card type. The heterogeneity that would have");
say("      justified a coordinate is refuted ON THE GATE ESTIMAND (I2 = 0%, non-empty CI intersection,");
say("      positive control alive on K at I2 = 92%), so a coordinate search is NOT re-opened by this fit");
say("      and a fitted coordinate would be rejected on identification grounds regardless of its SSE —");
say("      the coordinate corpus is tier-collinear (coordinate run §6) and no amount of depth fixes that.");
say();
say("  (1a) THE PRE-FIT CHECK THIS RUN ADDS, AND IT IS BLOCKING.");
say("      Before the single scalar is fit, RE-RUN THE HETEROGENEITY READ ON THE ESTIMAND BEING");
say("      MINIMISED, at the post-pull depth. Today the two estimands disagree:");
say(`        gate    stratum A  I2 ${f(100 * pooled600U[0]!.I2, 0)}%  intersection [${f(pooled600U[0]!.interLo, 2)}, ${f(pooled600U[0]!.interHi, 2)}]  — comfortable`);
say(`        primary stratum A  I2 ${f(100 * pooled600W[0]!.I2, 0)}%  intersection [${f(pooled600W[0]!.interLo, 2)}, ${f(pooled600W[0]!.interHi, 2)}]  — ${f(pooled600W[0]!.interHi - pooled600W[0]!.interLo, 2)} wide, and EMPTY at BF >= 1000`);
say("      DECIDED NOW, so it cannot be decided by whichever answer is convenient later:");
say("        · post-pull PRIMARY-estimand intersection NON-EMPTY with LOO-stable I2 below ~50%");
say("          ⇒ the single scalar is adequate; fit it. (Today stratum A reads LOO-stable 68–73%, so this");
say("            branch is NOT the one currently indicated — it is stated first only because it is the");
say("            branch the established position predicts.)");
say("        · post-pull PRIMARY-estimand intersection EMPTY and NOT restored by leave-one-out");
say("          ⇒ THE SINGLE SCALAR IS INADEQUATE. Do not fit it and do not widen its interval to cover");
say("            the spread. STOP, and re-file: the channel goes back to HELD with a NEW reason (real");
say("            dispersion at depth), which is a different reason from today's (nothing measurable).");
say("        · the two estimands still disagree at depth ⇒ that is an INSTRUMENT finding, and SYSTEM_MAP");
say("          §7's shared-instrument rule applies: resolve the estimand before reading either as a");
say("          statement about the channel. The named suspect is the weighting itself — precision weights");
say("          concentrate the estimate on the highest-BF rows, and high BF is high USAGE, which the");
say("          survivorship fact makes a non-random slice of each format. The Kish column in §1 is the");
say("          measurement of that concentration and is there to be used, not admired.");
say();
say("  (2) THE FORM IT MUST TAKE — and the hMul constraint DECIDES this, it is not a style choice.");
say("      src/model/pool-transform.ts applyPitSpread leg 3 is the only place a pitcher-BABIP spread");
say("      correction exists. It:");
say("        · measures bab0 = nHH / BIP0 on the ORIGINAL BIP");
say("          (BIP0 = 600 − BB − K − HR − BIP_ADJ, i.e. AFTER the K and HR legs have already moved BIP);");
say("        · applies bab2 = clamp(BAB̄_pool + s·(bab0 − BAB̄_pool), 0, 0.6)  — a RATE-space pivot about");
say("          the pool mean from poolPitMeansOwn(...).bab;");
say("        · rides the RATE MULTIPLIER: e.hMul *= bab2/bab0. THIS IS THE BINDING CONSTRAINT.");
say("          pitchingComponents re-derives nHH from the rating, so a COUNT-only change is DISCARDED by");
say("          the BIP recompute (the RawHitting.hMul lesson). A hit-RATE correction that does not ride");
say("          hMul is not a correction at all — it is a no-op with a plausible-looking fit behind it.");
say("        · then rescales nHH/XBH mix-preserving on the NEW BIP.");
say("      ⇒ THE FITTED OBJECT IS A RATE-SPACE SPREAD MULTIPLIER ABOUT BAB̄_pool, applied PRE-BIP and");
say("        PRE-ERA. It is NOT a level shift (the anchor owns level, SYSTEM_MAP §2), NOT a count");
say("        correction, and NOT a per-hand or per-role quantity.");
say();
say("      THE FUNCTIONAL WRAPPER: the C3 family at its constant limit, NOT a bare number.");
say("          s(g) = 1 + A·(g/G0)^q,  G0 = 20,  q -> 0  ⇒  s(g) = 1 + A for every g > 0, s(g<=0) = 1 EXACTLY.");
say("      Two reasons this wrapper and not a literal constant: (a) s(g<=0) = 1 is the one principled part");
say("      of the gap machinery (SYSTEM_MAP §3) — in-frame the model is calibrated by construction, so a");
say("      correction must vanish there, and a bare constant would amplify an in-frame pool; (b) the C6 HR");
say("      ramp already set the precedent that this family CONTAINS the constant (q -> 0) and the ramp");
say("      (q > 0), so declaring the constant inside it does not pre-judge the geometry — the");
say("      deliverable-space selection is free to reject it. A post-pull fit that lands at low q with the");
say("      equivalence set touching the low-q edge is the STRUCTURAL-LIMIT constant closure, exactly as");
say("      C6 recorded it, and is the PREDICTED outcome here.");
say();
say("  (3) THE BAR AND THE GRAIN.");
say(`      BF >= ${BAR_PRIMARY} primary (= MIN_BF, symmetric with the hitter PA >= 500 bar; the old MIN_IP=1000`);
say(`      convention was BF >= 4300 and is retired). BF >= ${BAR_SENS} reported as a sensitivity arm, never as`);
say("      the decision bar. Observed statistic at ROW grain = (card × variant level). Inference CLUSTERED");
say("      at CARD grain, with the inflation factor RE-MEASURED on the post-pull corpus — the deeper corpus");
say("      will have MORE rows per card, so today's near-1 inflation must not be assumed forward.");
say("      Cells with N < 15 judged rows are THIN and carry no verdict.");
say();
say("  (4) THE POINT ESTIMATE AND INTERVAL THIS RUN FILES.");
say(`      Stratum A, BF >= ${BAR_PRIMARY}, free-slope:  s = ${f(HEAD.pooled, 3)}  [${f(HEAD.bootLo, 3)}, ${f(HEAD.bootHi, 3)}]`);
say(`      All formats (live excluded):          s = ${f(ALLW.pooled, 3)}  [${f(ALLW.bootLo, 3)}, ${f(ALLW.bootHi, 3)}]`);
say("      A post-pull estimate landing INSIDE this interval is a replication. Landing OUTSIDE it is a");
say("      finding that must be explained before anything ships — most likely by the K/HR baseline having");
say("      moved, which is checkable and must be checked FIRST (SYSTEM_MAP §7: shared-instrument rule).");
say();
say("  (5) WHAT WOULD BLOCK THE FIT, decided now.");
say("      · Either shipped pitcher ramp (C3 K or C6 HR) being re-fitted between this filing and the");
say("        post-pull run ⇒ this interval is STALE and must be re-measured, not rescaled: K and HR are");
say("        PRE-BIP so they move predicted BABIP, and the coordinate run showed the ramps' own");
say("        contribution to the BABIP need is real (up to 0.061 per tier).");
say("      · A retrain moving the cohort rule or the training means ⇒ same class, same remedy.");
say("      · The post-pull per-format CI intersection going EMPTY ⇒ the flat-scalar candidate is dead and");
say("        the coordinate question re-opens — pre-registered against the K channel FIRST, where");
say("        heterogeneity demonstrably exists, per the coordinate run's carry-forward.");
say("      · live-open-daily must NEVER be pooled in, at any depth. It is the decoupled measurement point");
say("        (FORMAT_FACTS) and its inclusion would import the composition-layer residual into a");
say("        core-layer constant.");
say();
say("  (6) WHAT THIS RUN DOES NOT CLAIM.");
say("      It does not claim the scalar is >1 with the channel's residual thereby closed; it does not");
say("      claim a mechanism; it does not re-open the coordinate search; it does not touch the six");
say("      published residuals; and it creates no seventh. It reports one number, its interval, and the");
say("      conditions under which that number means anything.");

console.log(L.join("\n"));
