// PROPERTY BATTERY — NEEDS-vs-DEPTH ROBUSTNESS. Are the per-tier K "needs" a pool property, or an
// artifact of the usage floor they are measured over?
//   run: node tools/battery-needs-vs-bar.ts
//
// THE QUESTION. The five per-tier pitcher K9 calibration slopes the whole ramp debate rests on —
// iron 1.82 / bronze 1.62 / silver 1.48 / gold 1.78 / diamond 1.04 — are measured over cards that
// CLEAR A USAGE FLOOR (BF >= MIN_BF = 600). Usage is outcome-correlated: a card gets innings because
// somebody kept running it out, and that decision sees the outcomes. So part of a "need" could be
// SELECTION-ON-OUTCOME rather than a property of the tier's pool. This tool measures how much the
// needs move when the floor is raised.
//
// THE MEASUREMENT is the fit tool's section "1. PER-TIER MEASUREMENT" (tools/fit-kspread-pit.ts),
// re-run at three floors. Construction copied verbatim from there — same deps, same model, same
// neutral env, same wellSampled(r) + finite-k9 filter, same mmse() slope of obs~pred, same seeded
// bootstrap (B=2000, SEED=20260716, same rng/pct/ci helpers) — so the BF>=600 column reproduces the
// committed numbers rather than approximating them.
//
// THE FLOOR IS A BUILDER OPTION. `SampleDeps.minBf` sets the run's effective bar; `Rec.wellSampled`
// is decided at read time against it and `wellSampled(r)` honours it automatically. NO private join,
// no re-parse, no hand filter on `r.sample` — the sample is rebuilt once per floor through the ONE
// builder, which is what keeps this comparable to everything else measured on that path.
//
// WHAT THIS IS NOT: a fit. Nothing here fits a ramp, changes a default, or touches production
// scoring. It is a robustness read on an input to a decision, reported and nothing else.
//
// READING RULE, PRE-REGISTERED. Raising the floor CHANGES THE SAMPLE — the higher-floor cell is a
// nested subset of the lower-floor one — so any drift confounds selection with reduced N. The
// bootstrap CIs are how the reader separates them. A cell whose N falls below ~15 CANNOT carry a
// verdict: it is marked THIN and reported as insufficient data, never as "noise" and never as a
// drift claim. Diamond (N=36 at BF>=600) is expected to thin out first.

import { readFileSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import {
  makeRawPolyModel, productionFieldStats, computeUnifiedFieldStats, applyWobaWeights, computeDerived,
  buildPoolTransform, buildFrameShift, poolMeanKOwn,
  type EventForm, type FieldStats, type RatingEnvelope, type WobaWeights, type TrainingMeans,
} from "../src/scoring-core/index.ts";
import { parseCatalogCsv } from "../src/data/catalog.ts";
import type { WobaWeights as WW } from "../src/eval/cwhit/audit.ts";
import { per9NoiseVar } from "../src/eval/cwhit/scorecard.ts";
import { mmse, type Mmse } from "../src/eval/cwhit/two-ledger.ts";
import {
  buildCwhitSample, wellSampled, QUICK, inValueWindow, MIN_BF, FIELD_N,
  type Rec, type SampleDeps,
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
const ref: FieldStats = productionFieldStats(baseCards, coeffs, rp);
const deps: SampleDeps = {
  baseCards, coeffs, derived, eventForm: trained.eventForm, model: rp, W, ref, envelope: trained.ratingEnvelope,
  pitExp: new Map(trained.platoon.pit.map((p) => [p.hand, { wR: p.vsRHB, wL: p.vsLHB }])),
  hitExp: new Map(trained.platoon.hit.map((p) => [p.hand, { wR: p.vsRHP, wL: p.vsLHP }])),
};

// per-card observed K9 sampling variance (same noise model as the fit tool; tools are entry-point
// scripts, so the composition is copied rather than imported from another tool).
const k9Noise = (k9: number, bf: number) => per9NoiseVar(k9, bf);

// ── bootstrap plumbing (seeded/deterministic, the fit tool's generator + helpers verbatim) ──
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

/** N below which a cell reports no verdict. Pre-registered, not chosen after seeing the table. */
const THIN_N = 15;
/** Below this a slope is not even computed — the fit tool's own exclusion bar. */
const DEAD_N = 5;
const BARS = [600, 1000, 2000];

// ═════════════════════════════════════════════════════════════════════════════
console.log(`\n╔══════════════════════════════════════════════════════════════════════════════════════════╗`);
console.log(`║  BATTERY — NEEDS vs USAGE FLOOR: per-tier pitcher K9 calibration slope at BF ≥ 600/1000/2000 ║`);
console.log(`╚══════════════════════════════════════════════════════════════════════════════════════════╝`);
console.log(`model '${trained.id}' | catalog '${srcId}' | eval frame = RAW event line, own-gap ON, no anchor`);
console.log(`slope = mmse(pred, obs, noiseVar).slope on role=="pit", wellSampled(r), finite ours.k9/obs.k9`);
console.log(`floor = SampleDeps.minBf (the builder option); module default MIN_BF = ${MIN_BF}. No private join, no hand filter.`);
console.log(`bootstrap: B=${B}, SEED=${SEED}, resample-cards-with-replacement within cell (the fit tool's own CI).`);
console.log(`THIN rule: N < ${THIN_N} ⇒ no verdict, "insufficient data"; N < ${DEAD_N} ⇒ no slope at all.`);

interface Cell {
  bar: number; tier: string; n: number; m: Mmse | null;
  ci: { lo: number; hi: number }; corr: number;
  ratioRaw: number; ratioDcv: number; optRatio: number;
  rows: { pred: number; obs: number; nv: number }[];
  medBf: number;
}
const cells: Cell[] = [];
const gapOf = new Map<string, number>(), kbarOf = new Map<string, number>();

// pool-side constants are floor-INDEPENDENT (they are catalog properties, not sample properties) —
// computed once and printed once, so the table below carries only what the floor can move.
for (const win of QUICK) {
  const basePool = deps.baseCards.filter((c) => inValueWindow(c, win));
  const poolField = productionFieldStats(basePool, coeffs, rp);
  gapOf.set(win.tier, buildFrameShift(TM, poolField).pit.vR.stu ?? 0);
  const pt = buildPoolTransform(ref, poolField, deps.envelope);
  kbarOf.set(win.tier, poolMeanKOwn(basePool, coeffs, rp, pt, FIELD_N).pit);
}

for (const bar of BARS) {
  // ONE rebuild per floor through the ONE builder. wellSampled(r) then honours `bar` automatically.
  const s = buildCwhitSample({ ...deps, minBf: bar });
  let seedStep = 0;
  for (const win of QUICK) {
    const tier = win.tier;
    const rows = s.recs
      .filter((r: Rec) => r.tier === tier && r.role === "pit" && wellSampled(r) && Number.isFinite(r.ours.k9) && Number.isFinite(r.obs.k9!))
      .map((r: Rec) => ({ pred: r.ours.k9!, obs: r.obs.k9!, nv: k9Noise(r.obs.k9!, r.sample), bf: r.sample }));
    const bfs = rows.map((r) => r.bf).sort((a, b) => a - b);
    const medBf = bfs.length ? bfs[Math.floor(bfs.length / 2)]! : NaN;
    if (rows.length < DEAD_N) {
      cells.push({ bar, tier, n: rows.length, m: null, ci: { lo: NaN, hi: NaN }, corr: NaN, ratioRaw: NaN, ratioDcv: NaN, optRatio: NaN, rows, medBf });
      continue;
    }
    const m = mmse(rows.map((r) => r.pred), rows.map((r) => r.obs), rows.map((r) => r.nv));
    const rnd = rng(SEED + seedStep++);
    const boot: number[] = [];
    for (let b = 0; b < B; b++) {
      const rs = rows.map(() => rows[Math.floor(rnd() * rows.length)]!);
      boot.push(slopeOf(rs.map((r) => r.pred), rs.map((r) => r.obs)));
    }
    cells.push({
      bar, tier, n: rows.length, m, ci: ci(boot.filter(Number.isFinite)), corr: m.corrRaw,
      ratioRaw: m.ratioRaw, ratioDcv: m.ratioDeconv, optRatio: m.optimalRatio, rows, medBf,
    });
  }
}
const cellAt = (bar: number, tier: string) => cells.find((c) => c.bar === bar && c.tier === tier)!;
const flag = (c: Cell) => (c.n < DEAD_N ? " DEAD" : c.n < THIN_N ? " THIN" : "");

// ═══ 1. PER-TIER MEASUREMENT AT EACH FLOOR ══════════════════════════════════
console.log(`\n╔═══ 1. PER-TIER K9 CALIBRATION SLOPE (obs~pred) BY USAGE FLOOR ═══╗`);
for (const bar of BARS) {
  console.log(`\n  ── BF ≥ ${bar} ──`);
  console.log(`  tier       N   medBF   gap(stu)  K̄_pool/600   slope   [boot 95% CI]   se(t)    corr   ratioRaw/Dcv  optRatio`);
  for (const win of QUICK) {
    const c = cellAt(bar, win.tier);
    if (!c.m) { console.log(`  ${c.tier.padEnd(8)} ${String(c.n).padStart(3)}   ${f(c.medBf, 0).padStart(5)}   ${f(gapOf.get(c.tier)!, 1).padStart(6)}   ${f(kbarOf.get(c.tier)!, 1).padStart(9)}      — N < ${DEAD_N}: no slope computed (insufficient data)`); continue; }
    console.log(`  ${c.tier.padEnd(8)} ${String(c.n).padStart(3)}   ${f(c.medBf, 0).padStart(5)}   ${f(gapOf.get(c.tier)!, 1).padStart(6)}   ${f(kbarOf.get(c.tier)!, 1).padStart(9)}    ${f(c.m.slope.est, 2).padStart(5)}   [${f(c.ci.lo, 2)},${f(c.ci.hi, 2)}]     ${f(c.m.slope.se, 3)}   ${f(c.corr, 3)}   ${f(c.ratioRaw, 2)}/${f(c.ratioDcv, 2)}      ${f(c.optRatio, 2)}${flag(c)}`);
  }
}

// ═══ 2. STABILITY TABLE ══════════════════════════════════════════════════════
console.log(`\n╔═══ 2. STABILITY — slope at each floor + signed drift ═══╗`);
console.log(`  Higher floors are NESTED SUBSETS of the 600 cell, so a drift confounds selection-on-outcome`);
console.log(`  with reduced N. Read the CIs, not the point moves. THIN cells (N < ${THIN_N}) carry NO verdict.`);
console.log(`\n  tier      N600 slope600            N1000 slope1000          N2000 slope2000         Δ(1000−600)  Δ(2000−600)  CI overlap 600↔2000`);
for (const win of QUICK) {
  const a = cellAt(600, win.tier), b = cellAt(1000, win.tier), c = cellAt(2000, win.tier);
  const sl = (x: Cell) => (x.m ? `${f(x.m.slope.est, 2)} [${f(x.ci.lo, 2)},${f(x.ci.hi, 2)}]` : `— (N<${DEAD_N})`);
  const d = (x: Cell) => (x.m && a.m ? (x.n < THIN_N ? `${sgn(x.m.slope.est - a.m.slope.est, 2)}*` : sgn(x.m.slope.est - a.m.slope.est, 2)) : "n/a");
  const ov = a.m && c.m ? (c.n < THIN_N ? "THIN — no verdict" : (a.ci.lo <= c.ci.hi && c.ci.lo <= a.ci.hi ? "YES — one number" : "NO — CI-clear move")) : "insufficient data";
  console.log(`  ${win.tier.padEnd(8)} ${String(a.n).padStart(4)} ${sl(a).padEnd(20)} ${String(b.n).padStart(5)} ${sl(b).padEnd(20)}  ${String(c.n).padStart(5)} ${sl(c).padEnd(20)}  ${d(b).padStart(8)}     ${d(c).padStart(8)}     ${ov}`);
}
console.log(`  * = the drift is computed against a THIN cell (N < ${THIN_N}); it is insufficient data, not a drift claim.`);

// tier ORDERING at each floor — the ramp debate is about the ordering/spacing, not the level alone.
console.log(`\n  tier ordering by slope (non-THIN cells only), lowest → highest:`);
for (const bar of BARS) {
  const ok = QUICK.map((w) => cellAt(bar, w.tier)).filter((c) => c.m && c.n >= THIN_N);
  const dropped = QUICK.map((w) => cellAt(bar, w.tier)).filter((c) => !(c.m && c.n >= THIN_N)).map((c) => c.tier);
  console.log(`    BF≥${String(bar).padEnd(4)}  ${ok.slice().sort((x, y) => x.m!.slope.est - y.m!.slope.est).map((c) => `${c.tier} ${f(c.m!.slope.est, 2)}`).join("  <  ")}${dropped.length ? `   [excluded as THIN: ${dropped.join(", ")}]` : ""}`);
}

// ═══ 3. POOLED WITH TIER FIXED EFFECTS ═══════════════════════════════════════
// The fit tool's own aggregation frame ("POOLED (tier fixed effects)"): de-mean pred and obs WITHIN
// tier, then one slope over the stacked residuals — the level differences between tiers are absorbed,
// so this reads the common within-tier spacing deficit. Stratified paired bootstrap for the CI.
console.log(`\n╔═══ 3. POOLED (tier fixed effects) — within-tier de-meaned K9 slope, per floor ═══╗`);
console.log(`  floor   tiers used                              N     slope   [boot 95% CI]`);
for (const bar of BARS) {
  const used = QUICK.map((w) => cellAt(bar, w.tier)).filter((c) => c.m && c.n >= DEAD_N);
  const dm = (rows: { pred: number; obs: number }[][]) => {
    const p: number[] = [], o: number[] = [];
    for (const rs of rows) { const mp = mean(rs.map((r) => r.pred)), mo = mean(rs.map((r) => r.obs)); for (const r of rs) { p.push(r.pred - mp); o.push(r.obs - mo); } }
    return { p, o };
  };
  const d0 = dm(used.map((c) => c.rows));
  const r4 = rng(SEED + 77);
  const boot: number[] = [];
  for (let b = 0; b < B; b++) {
    const rs = used.map((c) => c.rows.map(() => c.rows[Math.floor(r4() * c.rows.length)]!));
    const d = dm(rs);
    boot.push(slopeOf(d.p, d.o));
  }
  const bc = ci(boot.filter(Number.isFinite));
  console.log(`  ${String(bar).padStart(5)}   ${used.map((c) => c.tier).join(",").padEnd(38)} ${String(d0.p.length).padStart(4)}    ${f(slopeOf(d0.p, d0.o), 2)}   [${f(bc.lo, 2)},${f(bc.hi, 2)}]`);
}

// ═══ 4. WHAT THE FLOOR DID TO THE SAMPLE ═════════════════════════════════════
// Selection is only interpretable next to what was removed, so the retention and the level move are
// printed rather than left implicit. `mean obs K9` is the outcome the floor selects ON (indirectly,
// through usage), so a floor that RAISES it is visibly selecting on outcome.
console.log(`\n╔═══ 4. WHAT THE FLOOR REMOVED — retention + observed-level move ═══╗`);
console.log(`  tier      N600→N1000→N2000    keep@1000  keep@2000   mean obs K9: 600 / 1000 / 2000    SD obs K9: 600 / 1000 / 2000`);
for (const win of QUICK) {
  const a = cellAt(600, win.tier), b = cellAt(1000, win.tier), c = cellAt(2000, win.tier);
  const mo = (x: Cell) => (x.n ? mean(x.rows.map((r) => r.obs)) : NaN);
  const sd = (x: Cell) => { if (x.n < 2) return NaN; const m0 = mo(x); return Math.sqrt(mean(x.rows.map((r) => (r.obs - m0) ** 2))); };
  console.log(`  ${win.tier.padEnd(8)} ${`${a.n}→${b.n}→${c.n}`.padEnd(18)}  ${f(a.n ? b.n / a.n : NaN, 2).padStart(7)}    ${f(a.n ? c.n / a.n : NaN, 2).padStart(7)}     ${f(mo(a), 2)} / ${f(mo(b), 2)} / ${f(mo(c), 2)}             ${f(sd(a), 2)} / ${f(sd(b), 2)} / ${f(sd(c), 2)}`);
}

console.log(`\n  REPORT-ONLY. Nothing here fits a ramp, changes a default, or touches production scoring.`);
console.log(``);
process.exit(0);
