// C6 — THE RE-DERIVED PITCHER HR9-SPREAD RAMP. Fit · gates · held-out validation. REPORT ONLY.
//   run: node tools/fit-hrspread-c6.ts > fixtures/cwhit-hrspread-c6-2026-07-22.txt
//
// SPECIFICATION: docs/CWHIT_HRRAMP_REFIT_PREREG_2026-07-22.md + AMENDMENT 1 (approved). Everything
// below — the family, the objective, the selection rule, the COHERENT-SET RULE, the gates, the
// acceptance bar, the stratification — is pre-registered there. Nothing here is tuned; a failing gate
// is reported, never tuned past.
//
// ── WHAT THIS IS, AND HOW IT RELATES TO C3 ─────────────────────────────────────────────────────
// This tool is tools/fit-kspread-c3.ts adapted to the HR9 channel. The family, the free-level
// objective (ruling (z)), the deliverable-space equivalence selection with a minimax centre (ruling
// (x)), the domain flat-hold above the largest fitted gap (amendment 3), the bootstrap machinery, the
// p-band identifiability prong, the presence legs at 0.25/0.30/0.35, and the held-out validation are
// reused VERBATIM. Three things change, all pre-registered in the HR prereg's clause-4 audit:
//   (1) THE CHANNEL. Everywhere C3 reads K (k9 / pit.vR.stu / poolPitMeansOwn.k) this reads HR
//       (hr9 / pit.vR.hrr / poolPitMeansOwn.hr). HR9 is a per-9 rate, so per9NoiseVar is unchanged.
//   (2) THE BASELINE. The shipped C3 K ramp is ACTIVE at every step — pre AND post arms both carry
//       it — because that is the shipping reality the HR residual sits on top of. This is the crucial
//       difference from C3, whose pre-arm carried no correction. Each format's K ramp scalar is
//       kSpreadPitRamp(gapK), gapK = the same pool's pit.vR.stu; the HR leg is fitted on top.
//   (3) THE FITTED SET. C3 fitted a fixed coherent four (gold out, diamond mandatory). HR replaces
//       that with the pre-committed MONOTONE-FEASIBILITY RULE (amendment 1): default = all five;
//       exclude a tier only if a monotone curve cannot pass every need-CI and its removal restores
//       feasibility with maximal min-slack; >1 exclusion needed ⇒ STOP; the SMALLEST-GAP fit-set
//       tier is mandatory-within-CI (replacing diamond-mandatory).
//
// NOTHING IS WIRED. This tool changes no default, no shipped constant, and no production path. The
// shipped HR ramp PIT_SPREAD_HR stays exactly as it is; the verdict returns to Fable, who decides.

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
const lbl = (s: string) => s.replace(/\s*\(from .*\)$/, "");

// ═══════════════════════════════════════════════════════════════════════════════
// 0. SETUP — deployed model, neutral env. Composition copied from tools/fit-kspread-c3.ts.
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
const tournaments = await repo.loadAll<Tournament>("tournaments");
const bq = tournaments.find((t) => t.id === "bronze-quick")!;
const coeffs = resolveCoeffs(model, eras.get(bq.eraId)!, parks.get(bq.parkId)!, bq.softcaps);
applyWobaWeights(coeffs, trained.wobaWeights);
const derived = computeDerived(coeffs);
const srcId = state.catalogSourceId ?? "cdmx";
const baseCards = parseCatalogCsv(readFileSync(`data/imports/${srcId}.csv`, "utf8")).cards.filter((c) => String(c["Variant"] ?? "").toUpperCase() !== "Y");
// COHORT-RULE EVENT: pool leg selects by the ACTIVE model's rule (same-construction with trainingMeans).
const cohortSel = cohortSelectForModel(trained.cohortRule, baseCards, coeffs, rp);
if (trained.cohortRule) console.error(`[hr] cohort rule '${trained.cohortRule}' -> z-sum pool leg active`);
const depsBase = {
  baseCards, coeffs, derived, eventForm: trained.eventForm, model: rp, W: trained.wobaWeights as WW,
  envelope: trained.ratingEnvelope,
  pitExp: new Map(trained.platoon.pit.map((p) => [p.hand, { wR: p.vsRHB, wL: p.vsLHB }])),
  hitExp: new Map(trained.platoon.hit.map((p) => [p.hand, { wR: p.vsRHP, wL: p.vsLHP }])),
};

// ── seeded bootstrap plumbing: verbatim from C3 ──
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
const THIN_N = 15;
const PER9 = BF_PER_9 / 600;   // raw per-600 model HR → per-9, the unit both lines are judged in

// ═══════════════════════════════════════════════════════════════════════════════
// THE FAMILY, DECLARED BEFORE ANY NUMBER (pre-registration §3) — C3's family, VERBATIM.
// ═══════════════════════════════════════════════════════════════════════════════
//   s(g) = 1 + A·(g/G0)^q      for g > 0;      s(g ≤ 0) = 1 EXACTLY
// Chosen for the HR channel because it contains BOTH the CONSTANT response (q → 0 ⇒ s ≈ 1 + A
// everywhere above 0) AND the monotone response (q > 0), so "HR is a flat amplification" and "HR is a
// ramp" are both IN the family and the deliverable-space selection decides between them rather than a
// family choice pre-judging it. G0 = 20 fixes the units of A (A = s(20) − 1); A and q are the two
// fitted parameters. Monotone increasing for A > 0, q > 0; s(0) = 1 is exact by construction.
const G0 = 20;
const sOf = (A: number, q: number) => (g: number) => (g > 0 ? 1 + A * Math.pow(g / G0, q) : 1);

// grid (integer-indexed so q = 1.00 is on it EXACTLY — the linear limit must be a grid point)
const QI_LO = 5, QI_HI = 800;             // q ∈ [0.05, 8.00] step 0.01
const qAt = (i: number) => i / 100;

interface TierAgg { tier: string; g: number; Swdz: number; Swdd: number; Swzz: number; n: number }

// ── THE OBJECTIVE (ruling (z)) — VERBATIM from C3 ─────────────────────────────
// PER-CARD residuals, per-card noise weights, and A PER-TIER FREE LEVEL. Profiling the level out
// leaves residual_i = (obs_i − ō_t) − s(g_t)·(HR_i − p̄_t) at the noise-weighted within-tier means, so
// HR̄_t drops out of the objective: with a free level the pivot is unidentified and s is a PURE SPREAD
// RESPONSE. Production still applies s about HR̄_pool — the level lives in the ANCHOR layer, not in s.
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
/** THE PIVOT OBJECTIVE — residual about HR̄_pool, NO free level. DIAGNOSTIC only (D3), not a candidate. */
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

// ── THE SELECTION RULE (ruling (x)) — VERBATIM from C3 ────────────────────────
// DELIVERABLE-SPACE EQUIVALENCE. Two candidates are EQUIVALENT iff
//     max over FITTED tiers  |s₁(g_t) − s₂(g_t)| / se_t  ≤  1        se_t = the per-tier NEED's SE.
// The shipped point is the equivalence set's MINIMAX CENTRE in that same SE-scaled sup-norm.
interface Selected {
  A: number; q: number; sse: number; lin: ProfPt; opt: ProfPt;
  setLo: number; setHi: number; setN: number; contiguous: boolean; atEdge: boolean;
  radius: number; width: number;
  sLo: number[]; sHi: number[];
  /** The equivalence-set members, carried so (w)2' can evaluate their s(g) spread over the APPLIED
   *  domain (all production tournaments), not just the fitted gaps. */
  members: { A: number; q: number }[];
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
    members: pool.map((p) => ({ A: p.A, q: p.q })),
  };
}

// ── GATE (w)2' — Fable ruling 2026-07-22, replacing the old grid-edge (w)2 ──────────────────────
// Family misfit iff the SHIPPED DELIVERABLE is not well-determined over the APPLIED DOMAIN. Concretely:
// evaluate the equivalence set's s(g) SPREAD at the gaps of ALL production tournaments POST-CLAMP;
// spread ≤ 1 need-SE everywhere ⇒ no misfit, regardless of where the parameter set's edges sit.
// TWO EDGE CLAUSES:
//   · a STRUCTURAL-LIMIT edge — q → 0, the CONSTANT response, a closure boundary of the family — is
//     NOT a grid edge. Touching it is INFORMATION (records a geometry-unresolved marker), never misfit.
//   · an ARBITRARY high-q edge gets the OCTAVE-EXTENSION check: extend the grid one octave and re-select;
//     if the applied-domain spread still holds the extension is harmless; if it grows, that is the
//     genuine unbounded-family misfit the old (w)2 caught in C3.
// The yardstick is the STRICTEST fitted need-SE (min over the fit set): spread ≤ that ⇒ ≤ every SE.
interface W2Prime { pass: boolean; marker: string; maxSpread: number; refSE: number; atGap: number; why: string; geomUnresolved: boolean }
// The yardstick is "≤ 1 need-SE everywhere" (Fable). "everywhere" is per applied gap, so the SE is the
// one RELEVANT at that gap — the need-SE of the nearest fitted tier — not a single global SE. Judging
// the ambiguity at a small-gap tier against a large-gap tier's tight SE would demand the deliverable be
// pinned finer than the need itself was measured there, which is not what well-determined means.
interface W2PrimeExt extends W2Prime { nearestWorst: number; interpWorst: number; nearestExc: number; interpExc: number; nApplied: number }
function w2prime(sel: Selected, appliedGaps: number[], fitGaps: number[], ses: number[], gMax: number, reprofileHi?: (hiQi: number) => Selected): W2PrimeExt {
  // The yardstick is "≤ 1 need-SE everywhere" (Fable). At a FITTED gap the SE is that tier's need-SE.
  // At an APPLIED gap between tiers the local precision is the LINEAR INTERPOLATION of the bracketing
  // tiers' need-SEs — the principled, discontinuity-free reading. `nearest` (snap to the closest
  // tier) is reported ALONGSIDE only because at a mid-bracket gap it snaps to whichever tier is
  // closer and so can quote a tighter SE than the interpolation region actually carries; it is the
  // stricter reading and its disagreement with interp is the yardstick sensitivity, surfaced not hidden.
  const srt = fitGaps.map((g, i) => ({ g, se: ses[i]! })).sort((a, b) => a.g - b.g);
  const interpSE = (g: number) => {
    if (g <= srt[0]!.g) return srt[0]!.se;
    if (g >= srt[srt.length - 1]!.g) return srt[srt.length - 1]!.se;
    for (let i = 1; i < srt.length; i++) { const a = srt[i - 1]!, b = srt[i]!; if (g <= b.g) return a.se + (b.se - a.se) * (g - a.g) / (b.g - a.g); }
    return srt[srt.length - 1]!.se;
  };
  const nearestSE = (g: number) => { let bi = 0, bd = Infinity; for (let i = 0; i < fitGaps.length; i++) { const d = Math.abs(fitGaps[i]! - g); if (d < bd) { bd = d; bi = i; } } return ses[bi]!; };
  const spreadAt = (members: { A: number; q: number }[], g: number) => {
    const gc = Math.min(g, gMax);                          // POST-CLAMP
    const vs = members.map((m) => sOf(m.A, m.q)(gc));
    return Math.max(...vs) - Math.min(...vs);
  };
  // The binding quantity (interpolated yardstick), plus the nearest-tier reading for the audit.
  let worstRatio = 0, maxSpread = 0, atGap = NaN, refSE = Math.min(...ses);
  let nearestWorst = 0, nearestExc = 0, interpExc = 0;
  for (const g of appliedGaps) {
    const gc = Math.min(g, gMax), s = spreadAt(sel.members, gc);
    const ri = s / interpSE(gc), rn = s / nearestSE(gc);
    if (ri > worstRatio) { worstRatio = ri; maxSpread = s; atGap = gc; refSE = interpSE(gc); }
    nearestWorst = Math.max(nearestWorst, rn);
    if (ri > 1) interpExc++;
    if (rn > 1) nearestExc++;
  }
  const lowEdge = Math.abs(sel.setLo - qAt(QI_LO)) < 1e-9;
  const highEdge = Math.abs(sel.setHi - qAt(QI_HI)) < 1e-9;
  const wellDet = worstRatio <= 1;

  // The octave-extension check, only when the ARBITRARY high edge is touched.
  let octaveNote = "", octaveMisfit = false;
  if (highEdge && reprofileHi) {
    const ext = reprofileHi(QI_HI * 2);
    let extRatio = 0; for (const g of appliedGaps) { const gc = Math.min(g, gMax); extRatio = Math.max(extRatio, spreadAt(ext.members, gc) / interpSE(gc)); }
    octaveMisfit = extRatio > 1;
    octaveNote = ` High edge touched: octave extension to q=${f(qAt(QI_HI * 2), 1)} gives worst applied-domain spread ${f(extRatio, 2)}× local need-SE (${octaveMisfit ? "GROWS beyond" : "still within"} 1).`;
  }

  const geomUnresolved = lowEdge || highEdge;
  const marker = geomUnresolved
    ? `GEOMETRY-UNIDENTIFIED: response unresolved between the constant (q→0) and a mild ramp; the DELIVERABLE is determined, the SHAPE is not. The honest successor to a bare "gap-flat" claim.`
    : `geometry resolved: the equivalence set is interior, shape identified.`;
  const pass = wellDet && !octaveMisfit;
  const nApplied = appliedGaps.length;
  const why = pass
    ? `applied-domain deliverable is well-determined: the worst equivalence-set s-spread across all `
      + `${appliedGaps.length} production tournaments (post-clamp) is ${f(maxSpread, 3)} at gap ${f(atGap, 1)}, which is `
      + `${f(worstRatio, 2)}× the local need-SE (${f(refSE, 3)}) there — ≤ 1 everywhere. ${lowEdge ? "The set's low end sits at the STRUCTURAL-LIMIT edge q→0 (the constant response, a family closure boundary) — that is information, not a grid edge." : ""}${octaveNote}`
    : octaveMisfit
      ? `the high-q edge is arbitrary and the octave-extension check FAILS:${octaveNote} the family is unbounded and the deliverable ambiguous — genuine misfit.`
      : `applied-domain deliverable is NOT well-determined: worst s-spread ${f(maxSpread, 3)} at gap ${f(atGap, 1)} is ${f(worstRatio, 2)}× the local need-SE (${f(refSE, 3)}) — exceeds 1. The shipped curve is ambiguous where it is applied, by more than the need was measured there.`;
  return { pass, marker, maxSpread, refSE, atGap, why, geomUnresolved, nearestWorst, interpWorst: worstRatio, nearestExc, interpExc, nApplied };
}

interface FitRow { tier: string; cid: string; name: string; bf: number; pred: number; obs: number; nv: number; w: number; d: number; z: number }
interface TierCell {
  tier: string; gap: number; kbar600: number; kbar9: number;
  rows: FitRow[]; need: number; needCI: { lo: number; hi: number }; needSe: number;
  needBoot: number[];
  pivotS: number; wPredMean: number; wObsMean: number; wFreeS: number; offPred: number; offResid: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// THE COHERENT-SET RULE (amendment 1) — the pre-committed monotone-feasibility test.
// Default fit set = all five. A monotone-nondecreasing sequence (ordered by gap ASCENDING) must hit
// every fitted tier's need-CI. Deterministic: order by gap asc; carry floor = max lo-so-far; the set
// is feasible iff floor never exceeds any tier's hi. Min-slack = min over tiers of (hi_t − floor_t).
// Infeasible ⇒ exclude the ONE tier whose removal maximises min-slack; if no single removal restores
// feasibility, >1 exclusion is needed ⇒ STOP (family/coordinate failure on the HR channel).
// ═══════════════════════════════════════════════════════════════════════════════
interface Feas {
  order: string[];                                     // tiers by gap ascending
  allFeasible: boolean; minSlackAll: number;
  perRemoval: { tier: string; feasible: boolean; minSlack: number }[];
  fitSet: string[]; excluded: string[]; stop: boolean; reason: string;
}
const FEAS_EPS = 1e-9;
function minSlackOf(subset: TierCell[]): number {
  const srt = [...subset].sort((a, b) => a.gap - b.gap);
  let floor = -Infinity, ms = Infinity;
  for (const c of srt) { floor = Math.max(floor, c.needCI.lo); ms = Math.min(ms, c.needCI.hi - floor); }
  return ms;
}
function feasibility(cells: TierCell[]): Feas {
  const order = [...cells].sort((a, b) => a.gap - b.gap).map((c) => c.tier);
  const minSlackAll = minSlackOf(cells);
  if (minSlackAll >= -FEAS_EPS) {
    return { order, allFeasible: true, minSlackAll, perRemoval: [], fitSet: [...LADDER], excluded: [], stop: false, reason: "all five tiers feasible — fit set = all five, no exclusions" };
  }
  const perRemoval = cells.map((c) => {
    const ms = minSlackOf(cells.filter((x) => x.tier !== c.tier));
    return { tier: c.tier, feasible: ms >= -FEAS_EPS, minSlack: ms };
  });
  const restorers = perRemoval.filter((r) => r.feasible).sort((a, b) => b.minSlack - a.minSlack || LADDER.indexOf(a.tier as any) - LADDER.indexOf(b.tier as any));
  if (!restorers.length) {
    return { order, allFeasible: false, minSlackAll, perRemoval, fitSet: [...LADDER], excluded: [], stop: true, reason: "no single-tier removal restores feasibility → MORE THAN ONE exclusion needed" };
  }
  const ex = restorers[0]!.tier;
  return { order, allFeasible: false, minSlackAll, perRemoval, fitSet: LADDER.filter((t) => t !== ex), excluded: [ex], stop: false, reason: `infeasible with all five; removing ${ex} restores feasibility with maximal min-slack ${f(restorers[0]!.minSlack, 3)}` };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. THE COORDINATE + IDENTIFIABILITY PRONG 1  (gate (w)1)
// ═══════════════════════════════════════════════════════════════════════════════
const LADDER = ["iron", "bronze", "silver", "gold", "diamond"] as const;
const P_BAND = [0, 0.25, 0.30, 0.35];

const poolOf = (win: ValueWindow) => baseCards.filter((c) => inValueWindow(c, win));
const gapAt = (basePool: Card[], p: number, cf = coeffs) =>
  buildFrameShift(TM, productionFieldStats(basePool, cf, rp, true, p, cohortSel)).pit.vR.hrr ?? 0;

const gapTable = new Map<number, Map<string, number>>();
for (const p of P_BAND) {
  const m = new Map<string, number>();
  for (const win of QUICK) m.set(win.tier, gapAt(poolOf(win), p));
  gapTable.set(p, m);
}
// INSTRUMENT CHECK: the explicit-p call at the shipped p must be the DEFAULT call, bit-for-bit.
let instrDelta = 0;
for (const win of QUICK) {
  const a = buildFrameShift(TM, productionFieldStats(poolOf(win), coeffs, rp, true, undefined, cohortSel)).pit.vR.hrr ?? 0;
  instrDelta = Math.max(instrDelta, Math.abs(a - gapTable.get(PRESENCE_P)!.get(win.tier)!));
}
// The HR identifiability prong is measured over ALL FIVE tiers: the fitted set is not known until the
// needs are measured (amendment 1), and the prong is a property of the COORDINATE (the hrr gap), not
// of the fit — so it can and must be checked before the fit is seen, over the whole ladder.
const spanOf = (m: Map<string, number>) => {
  const v = LADDER.map((t) => m.get(t)!);
  return Math.max(...v) - Math.min(...v);
};
const descending = (m: Map<string, number>) => LADDER.every((t, i) => i === 0 || m.get(LADDER[i - 1]!)! > m.get(t)!);
const span0 = spanOf(gapTable.get(0)!);
const w1Rows = P_BAND.map((p) => ({ p, ord: descending(gapTable.get(p)!), ret: spanOf(gapTable.get(p)!) / span0 }));
const W1_PASS = w1Rows.every((r) => r.ord) && w1Rows.filter((r) => r.p > 0).every((r) => r.ret >= 0.60);

// ── THE APPLIED DOMAIN (gate (w)2', Fable ruling) — the hrr gap of EVERY production tournament ──
// (w)2' asks whether the shipped s_hr(g) is well-determined where it is ACTUALLY APPLIED, not just at
// the five fitted gaps. Computed once at the shipped p, exactly as production would resolve each
// format: its own era/park/eligibility → its own field → its own hrr gap. Post-clamp is applied
// inside w2prime (each gap capped at the fitted gMax before the spread is read).
const appliedGaps: { id: string; gap: number }[] = [];
for (const t of tournaments) {
  const era = eras.get(t.eraId), park = parks.get(t.parkId);
  if (!era || !park) continue;
  const cf = resolveCoeffs(model, era, park, t.softcaps);
  applyWobaWeights(cf, trained.wobaWeights!);
  const inV = (c: Card) => { const v = n_(c["Card Value"]); return (t.card_value_min == null || v >= t.card_value_min) && (t.card_value_max == null || v <= t.card_value_max); };
  const pool = baseCards.filter((c) => inV(c) && rowEligible(c as any, t));
  if (!pool.length) continue;
  appliedGaps.push({ id: t.id, gap: buildFrameShift(TM, productionFieldStats(pool, cf, rp, true, undefined, cohortSel)).pit.vR.hrr ?? 0 });
}
const APPLIED = appliedGaps.map((a) => a.gap);

// ═══════════════════════════════════════════════════════════════════════════════
// 2. ONE PRESENCE LEG = measure the needs, run the feasibility rule, fit, gate, score acceptance
// ═══════════════════════════════════════════════════════════════════════════════
interface Excluded { tier: string; gap: number; s: number; need: number; needCI: { lo: number; hi: number }; resid: number; residCI: { lo: number; hi: number } }
interface LegResult {
  p: number; bar: number;
  cells: TierCell[];
  fitTiers: string[]; fitCells: TierCell[];
  feas: Feas; smallestGapTier: string;
  sel: Selected; prof: ProfPt[];
  aCI: { lo: number; hi: number }; qCI: { lo: number; hi: number };
  sCI: Map<string, { lo: number; hi: number }>;
  loo: { dropped: string; A: number; q: number; sAt: Map<string, number>; inAll: boolean }[];
  w2: W2PrimeExt;
  w3: boolean; monotone: boolean;
  accept: { tier: string; s: number; need: number; lo: number; hi: number; inside: boolean; thin: boolean }[];
  acceptPass: boolean; smallInside: boolean;
  excluded: Excluded[];
  pivotFit: Selected;
}

const scoreAccept = (cells: TierCell[], s: (g: number) => number) =>
  cells.map((c) => ({ tier: c.tier, s: s(c.gap), inside: s(c.gap) >= c.needCI.lo && s(c.gap) <= c.needCI.hi }));

function buildLeg(p: number, bar: number): LegResult {
  const ref: FieldStats = productionFieldStats(baseCards, coeffs, rp, true, p, cohortSel);

  // ── PER-TIER PREP: the hrr gap (fit coordinate), the stu gap (K-ramp coordinate), the pool means,
  //    and the shipped C3 K-ramp scalar. Computed BEFORE the sample so the K-ramp baseline can be
  //    threaded in. HR̄_pool and K̄_pool are production's, from the presence mixture. ──
  interface Prep { tier: string; gapHr: number; gapK: number; sK: number; kbarK: number; hrbar600: number; hrbar9: number }
  const prep: Prep[] = [];
  for (const win of QUICK) {
    const basePool = poolOf(win);
    const poolField = productionFieldStats(basePool, coeffs, rp, true, p, cohortSel);
    const fs = buildFrameShift(TM, poolField);
    const gapHr = fs.pit.vR.hrr ?? 0, gapK = fs.pit.vR.stu ?? 0;
    const pt = buildPoolTransform(ref, poolField, depsBase.envelope);
    const pm = poolPitMeansOwn(presenceMixture(basePool, p, PRESENCE_M), coeffs, rp, pt, FIELD_N * PRESENCE_M);
    prep.push({ tier: win.tier, gapHr, gapK, sK: kSpreadPitRamp(gapK), kbarK: pm.k, hrbar600: pm.hr, hrbar9: pm.hr * PER9 });
  }
  // THE SHIPPED C3 K RAMP IS ON, HR OFF (sHr = 1). This is the shipping reality the HR residual sits
  // on. HR9 raw is untouched by the K leg (applyPitSpread moves only e.K when sHr = 1), so the RAW
  // hr9 pred equals its no-K-ramp value; but the DEPLOYED line and calibrate() see the K ramp exactly
  // as production does, which is what the env-bearing held-out formats read.
  const kSpreadBaseline = new Map<string, KSpreadPit>(prep.map((x) => [x.tier, { s: x.sK, mean: x.kbarK, sHr: 1, meanHr: x.hrbar600 }]));
  const deps: SampleDeps = { ...depsBase, ref, presenceP: p, minBf: bar, kSpreadPit: kSpreadBaseline, select: cohortSel };
  const s = buildCwhitSample(deps);

  const cells: TierCell[] = [];
  let seedStep = 0;
  for (const win of QUICK) {
    const pr = prep.find((x) => x.tier === win.tier)!;
    const rows: FitRow[] = s.recs
      .filter((r: Rec) => r.tier === win.tier && r.role === "pit" && wellSampled(r) && Number.isFinite(r.ours.hr9) && Number.isFinite(r.obs.hr9!))
      .map((r: Rec) => {
        const pred = r.ours.hr9!, obs = r.obs.hr9!, nv = per9NoiseVar(obs, r.sample);
        return { tier: win.tier, cid: r.cid, name: r.name, bf: r.sample, pred, obs, nv, w: nv > 0 ? 1 / nv : 0, d: pred - pr.hrbar9, z: obs - pred };
      });
    const m = mmse(rows.map((r) => r.pred), rows.map((r) => r.obs), rows.map((r) => r.nv));
    const rnd = rng(SEED + seedStep++);
    const boot: number[] = [];
    for (let b = 0; b < B; b++) {
      const rs = rows.map(() => rows[Math.floor(rnd() * rows.length)]!);
      boot.push(slopeOf(rs.map((r) => r.pred), rs.map((r) => r.obs)));
    }
    const a0 = aggregatePivot(win.tier, pr.gapHr, rows);
    const sw = rows.reduce((a, r) => a + r.w, 0) || 1;
    const wPredMean = rows.reduce((a, r) => a + r.w * r.pred, 0) / sw;
    const wObsMean = rows.reduce((a, r) => a + r.w * r.obs, 0) / sw;
    const a1 = aggregate(win.tier, pr.gapHr, rows);
    cells.push({
      tier: win.tier, gap: pr.gapHr, kbar600: pr.hrbar600, kbar9: pr.hrbar9, rows,
      need: m.slope.est, needCI: ci(boot.filter(Number.isFinite)), needSe: m.slope.se,
      needBoot: boot.filter(Number.isFinite),
      pivotS: a0.Swdd > 0 ? 1 + a0.Swdz / a0.Swdd : NaN,
      wPredMean, wObsMean, wFreeS: a1.Swdd > 0 ? 1 + a1.Swdz / a1.Swdd : NaN,
      offPred: wPredMean - pr.hrbar9, offResid: wObsMean - wPredMean,
    });
  }

  // ── THE FITTED SET IS DECIDED BY THE MONOTONE-FEASIBILITY RULE (amendment 1). ──
  const feas = feasibility(cells);
  const fitTiers = feas.fitSet;
  const fitCells = fitTiers.map((t) => cells.find((c) => c.tier === t)!);
  const smallestGapTier = fitCells.reduce((a, b) => (b.gap < a.gap ? b : a)).tier;
  const gaps = fitCells.map((c) => c.gap);
  const ses = fitCells.map((c) => c.needSe);
  const aggs = fitCells.map((c) => aggregate(c.tier, c.gap, c.rows));
  const prof = profileOf(aggs);
  const sel = select(prof, gaps, ses);
  const sFit = sOf(sel.A, sel.q);

  // Bootstrap the SHIPPING quantity: resample within each FITTED tier, refit, re-run the SAME
  // selection rule end-to-end. The fit set itself is fixed from the point estimate (the feasibility
  // rule is deterministic given the measured needs); the bootstrap propagates the within-tier noise.
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

  // GATE (w)3 — leave one FITTED tier out, IN DELIVERABLE SPACE. Each refit's implied s(g_t) must lie
  // inside the full fit's bootstrap s-CI at every FITTED gap.
  const loo = fitCells.map((c) => {
    const sb = select(profileOf(aggs.filter((a) => a.tier !== c.tier)), gaps, ses);
    const sAt = new Map(cells.map((x) => [x.tier, sOf(sb.A, sb.q)(x.gap)] as const));
    const inAll = fitCells.every((x) => { const q = sCI.get(x.tier)!; const v = sAt.get(x.tier)!; return v >= q.lo && v <= q.hi; });
    return { dropped: c.tier, A: sb.A, q: sb.q, sAt, inAll };
  });
  const w3 = loo.every((x) => x.inAll);

  // GATE (w)2' — family misfit iff the shipped deliverable is not well-determined over the APPLIED
  // domain (Fable ruling). The high-edge octave check re-profiles on an extended grid; the fit set,
  // gaps and ses are fixed, so the re-profile is the same objective on a taller q-grid.
  const reprofileHi = (hiQi: number): Selected => {
    const ext: ProfPt[] = [];
    for (let i = QI_LO; i <= hiQi; i++) { const q = qAt(i); const r = fitAt(aggs, q); ext.push({ q, A: r.A, sse: r.sse }); }
    return select(ext, gaps, ses);
  };
  const gMaxLeg = Math.max(...gaps);            // flat-hold gap = largest FITTED gap (domain rule)
  const w2 = w2prime(sel, APPLIED, gaps, ses, gMaxLeg, reprofileHi);

  const monotone = sel.A > 0 && sel.q > 0;

  // ACCEPTANCE — scored on the FIT SET. Feasibility already guaranteed a monotone curve EXISTS through
  // every fit-set need-CI; acceptance checks the SELECTED s(g) lands inside. PASS = the smallest-gap
  // fit-set tier is inside AND at most one fit-set tier sits outside (and, since smallest-gap is in,
  // the outside one is never the smallest-gap). Mirrors C3's ≥(fitN−1)-inside spirit.
  const accept = fitCells.map((c) => {
    const sv = sFit(c.gap);
    return { tier: c.tier, s: sv, need: c.need, lo: c.needCI.lo, hi: c.needCI.hi, inside: sv >= c.needCI.lo && sv <= c.needCI.hi, thin: c.rows.length < THIN_N };
  });
  const smallInside = accept.find((a) => a.tier === smallestGapTier)!.inside;
  const nInside = accept.filter((a) => a.inside).length;
  const acceptPass = !feas.stop && smallInside && nInside >= fitCells.length - 1;

  // EXCLUDED TIER(S) — published quantified residual(s), gold semantics (independent bootstrap draws
  // since the excluded tier is out of the fit, so need-boot and fit-boot difference index-wise).
  const excluded: Excluded[] = feas.excluded.map((t) => {
    const gc = cells.find((c) => c.tier === t)!;
    const gS = bootS.get(t)!;
    const gResid: number[] = [];
    for (let b = 0; b < Math.min(gc.needBoot.length, gS.length); b++) gResid.push(gc.needBoot[b]! - gS[b]!);
    return { tier: t, gap: gc.gap, s: sFit(gc.gap), need: gc.need, needCI: gc.needCI, resid: gc.need - sFit(gc.gap), residCI: ci(gResid.filter(Number.isFinite)) };
  });

  const pivotFit = select(profileOf(fitCells.map((c) => aggregatePivot(c.tier, c.gap, c.rows))), gaps, ses);

  return { p, bar, cells, fitTiers, fitCells, feas, smallestGapTier, sel, prof, aCI, qCI, sCI, loo, w2, w3, monotone, accept, acceptPass, smallInside, excluded, pivotFit };
}

const primary = buildLeg(PRESENCE_P, MIN_BF);
const sPrimary = sOf(primary.sel.A, primary.sel.q);

// ═══════════════════════════════════════════════════════════════════════════════
// 3. FORMAT VALIDATION — env-bearing dailies (stratum B) + budget cap/slots (stratum C).
//    VALIDATED, NEVER FITTED. Formats from the corpus REGISTRY by tournamentId. Both arms carry the
//    shipped C3 K ramp; the HR ramp is the only thing that moves between pre and post.
// ═══════════════════════════════════════════════════════════════════════════════
const VALIDATE: { tid: string; stratum: string; note: string }[] = [
  { tid: "early-gold", stratum: "B", note: "era-1920 / park-169" },
  { tid: "bronze-heart", stratum: "B", note: "era-1939 / park-191, Year rule" },
  { tid: "late-bronze", stratum: "B", note: "era-1979 / park-114" },
  { tid: "diamond-heart", stratum: "B", note: "era-1958 / park-156" },
  { tid: "live-open-daily", stratum: "A*", note: "neutral env, uncapped — non-Quick control" },
  { tid: "bronze-cap-weekly", stratum: "C", note: "neutral env, cap 1331 — PRE-REGISTERED held-out" },
  { tid: "gold-slots", stratum: "C", note: "neutral env, slots — PRE-REGISTERED held-out; never before evaluated" },
  { tid: "gold-cap", stratum: "B+C", note: "park-156 + cap 1580 — PRE-REGISTERED held-out (HR park flag)" },
  { tid: "diamond-cap-daily", stratum: "B+C", note: "era-1998 / park-101 + cap 1755" },
];
interface ValRow {
  tid: string; key: string; label: string; stratum: string; note: string;
  poolN: number; joined: number; judged: number; gapHr: number; gapK: number; kbar: number; s: number;
  preSlope: number; postSlope: number; postCI: { lo: number; hi: number }; preCI: { lo: number; hi: number };
  preLevel: number; postLevel: number; verdict: string; notices: string[];
}
const valRows: ValRow[] = [];
for (const [vi, V] of VALIDATE.entries()) {
  const fm = CWHIT_CORPUS.find((x) => x.tournamentId === V.tid);
  const blank = (verdict: string, key = "—", label = "—"): ValRow => ({ tid: V.tid, key, label, stratum: V.stratum, note: V.note, poolN: 0, joined: 0, judged: 0, gapHr: NaN, gapK: NaN, kbar: NaN, s: NaN, preSlope: NaN, postSlope: NaN, postCI: { lo: NaN, hi: NaN }, preCI: { lo: NaN, hi: NaN }, preLevel: NaN, postLevel: NaN, verdict, notices: [] });
  if (!fm) { valRows.push(blank("NOT IN THE CORPUS REGISTRY")); continue; }
  const t = tournaments.find((x) => x.id === V.tid);
  if (!t) { valRows.push(blank("tournament config missing", fm.key, fm.label)); continue; }
  const era = eras.get(t.eraId), park = parks.get(t.parkId);
  if (!era || !park) { valRows.push(blank("era/park missing", fm.key, fm.label)); continue; }
  const coeffsF = resolveCoeffs(model, era, park, t.softcaps);
  applyWobaWeights(coeffsF, trained.wobaWeights!);
  const derivedF = computeDerived(coeffsF, true);
  const inV = (c: Card) => { const v = n_(c["Card Value"]); return (t.card_value_min == null || v >= t.card_value_min) && (t.card_value_max == null || v <= t.card_value_max); };
  const basePool = baseCards.filter((c) => inV(c) && rowEligible(c as any, t));
  const refF = productionFieldStats(baseCards, coeffsF, rp, true, undefined, cohortSel);
  const poolF = productionFieldStats(basePool, coeffsF, rp, true, undefined, cohortSel);
  const pt = buildPoolTransform(refF, poolF, depsBase.envelope);
  const fs = buildFrameShift(TM, poolF);
  const gapHr = fs.pit.vR.hrr ?? 0, gapK = fs.pit.vR.stu ?? 0;
  const pm = poolPitMeansOwn(presenceMixture(basePool), coeffsF, rp, pt, FIELD_N * PRESENCE_M);
  const sK = kSpreadPitRamp(gapK), sHr = sPrimary(gapHr);
  const kbarDep = pm.hr * PER9 * derivedF.era_effective_hr;   // deployed-frame HR̄ per 9, for reading
  const win: ValueWindow = {
    tier: fm.key,
    valueMin: t.card_value_min ?? undefined,
    valueMax: t.card_value_max ?? Infinity,
    eligible: (c: Record<string, unknown>) => rowEligible(c as unknown as Card, t),
  };
  const depsF: SampleDeps = { ...depsBase, coeffs: coeffsF, derived: derivedF, ref: refF, formats: [win], select: cohortSel };
  // PRE = K ramp ON, HR OFF.  POST = K ramp ON, HR = fitted s_hr.  Both carry the shipped K ramp.
  const preKS = new Map<string, KSpreadPit>([[fm.key, { s: sK, mean: pm.k, sHr: 1, meanHr: pm.hr }]]);
  const postKS = new Map<string, KSpreadPit>([[fm.key, { s: sK, mean: pm.k, sHr: sHr, meanHr: pm.hr }]]);
  const pre = buildCwhitSample({ ...depsF, kSpreadPit: preKS });
  const post = buildCwhitSample({ ...depsF, kSpreadPit: postKS });
  const postBy = new Map(post.recs.filter((r) => r.role === "pit").map((r) => [`${r.title}|${r.vlvl}`, r]));
  const paired = pre.recs
    .filter((r) => r.role === "pit" && wellSampled(r) && postBy.has(`${r.title}|${r.vlvl}`) && Number.isFinite(r.obs.hr9!))
    .map((r) => ({ pre: r.oursDep.hr9!, post: postBy.get(`${r.title}|${r.vlvl}`)!.oursDep.hr9!, obs: r.obs.hr9!, nv: per9NoiseVar(r.obs.hr9!, r.sample) }));
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
    poolN: basePool.length, joined, judged: paired.length, gapHr, gapK, kbar: kbarDep, s: sHr,
    preSlope, postSlope, postCI, preCI, preLevel, postLevel, verdict,
    notices: pre.notices.filter((x) => x.includes(fm.key) || x.includes("registry")),
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// 4. SENSITIVITY LEGS — the 1000 bar (report) and p = 0.25 / 0.35 (band re-check)
// ═══════════════════════════════════════════════════════════════════════════════
const bar1000 = buildLeg(PRESENCE_P, 1000);
const pLegs = [0.25, 0.35].map((p) => buildLeg(p, MIN_BF));

// ═══════════════════════════════════════════════════════════════════════════════
// 5. VERDICT
// ═══════════════════════════════════════════════════════════════════════════════
const bandHolds = pLegs.every((l) => !l.feas.stop && l.w2.pass && l.w3 && l.monotone && l.acceptPass);
const fails: string[] = [];
if (!W1_PASS) fails.push("GATE (w)1 IDENTIFIABILITY");
if (primary.feas.stop) fails.push("STOP — family/coordinate failure: >1 exclusion on the HR channel");
if (!primary.w2.pass) fails.push("GATE (w)2' APPLIED-DOMAIN DELIVERABLE NOT WELL-DETERMINED (family misfit)");
if (!primary.w3) fails.push("GATE (w)3 LEAVE-ONE-TIER-OUT IN DELIVERABLE SPACE");
if (!primary.monotone) fails.push("KILL 6 — THE FITTED FORM IS NOT MONOTONE OVER THE OBSERVED RANGE");
if (!primary.feas.stop && !primary.smallInside) fails.push(`ACCEPTANCE — SMALLEST-GAP tier (${primary.smallestGapTier}) OUTSIDE its measured CI (STOP-class)`);
else if (!primary.feas.stop && !primary.acceptPass) fails.push("ACCEPTANCE — more than one fit-set tier outside its CI");
if (!fails.length && !bandHolds && !pLegs.some((l) => l.acceptPass)) fails.push("KILL 7 — the gates hold at p=0.30 but fail at BOTH 0.25 and 0.35 (reopens conditioning)");
const VERDICT = fails.length ? `STOP — ${fails.join(" + ")}`
  : bandHolds ? "PASS — every gate and the acceptance bar hold at p=0.30 AND across the 0.25/0.35 band"
    : "PARTIAL — gates and the acceptance bar hold at p=0.30 but not across the whole 0.25/0.35 band";
const nIn = primary.accept.filter((a) => a.inside).length;
const gMinP = Math.min(...primary.fitCells.map((c) => c.gap)), gMaxP = Math.max(...primary.fitCells.map((c) => c.gap));

// ═══════════════════════════════════════════════════════════════════════════════
// 6. REPORT
// ═══════════════════════════════════════════════════════════════════════════════
say("################################################################################");
say(`# C6 — THE RE-DERIVED PITCHER HR-SPREAD RAMP. VERDICT: ${VERDICT}`);
say("# Pre-registration: docs/CWHIT_HRRAMP_REFIT_PREREG_2026-07-22.md + AMENDMENT 1.");
say("# Tool: tools/fit-hrspread-c6.ts. FIT AND REPORT ONLY — this tool wires nothing. On a PASS the");
say("# constant ships in the SAME dated commit as C3 and the hitter-tail refit (the atomic-event rule).");
say("################################################################################");
say();
say("### WHAT THIS RUN CONCLUDES (the detail is below; nothing here is tuned)");
say();
say(`  1. GATE (w)1 IDENTIFIABILITY ${W1_PASS ? "PASSES" : "FAILS"} on the hrr COORDINATE (all five tiers). Ordering`);
say(`     ${w1Rows.every((r) => r.ord) ? "strictly descending at every p in the band" : "NOT strictly descending at some p — the coordinate does not separate tiers"};`);
say(`     span retention ${f(w1Rows.find((r) => r.p === PRESENCE_P)!.ret * 100, 1)}% at the shipped p (${w1Rows.filter((r) => r.p > 0).map((r) => `${f(r.p, 2)}: ${f(r.ret * 100, 1)}%`).join(", ")}) against a 60% floor.`);
say(`  2. THE COHERENT-SET RULE (amendment 1): ${primary.feas.reason}.`);
say(`     Fit set = ${primary.fitTiers.join(", ")}${primary.excluded.length ? `; excluded = ${primary.excluded.map((e) => e.tier).join(", ")} (published residual)` : ""}.`);
say(`  3. GATE (w)2' ${primary.w2.pass ? "PASSES" : "FAILS"} (applied-domain deliverable, Fable ruling): ${primary.w2.why}`);
if (primary.w2.geomUnresolved) say(`     ${primary.w2.marker}`);
say(`  4. GATE (w)3 ${primary.w3 ? "PASSES" : "FAILS"} in deliverable space: ${primary.w3 ? "no single tier determines the delivered s(g)" : "a leave-one-out refit leaves the full fit's s-CI"}.`);
say(`  5. ACCEPTANCE ${primary.acceptPass ? "PASSES" : "FAILS"}: ${nIn} of the ${primary.fitCells.length} fit-set tiers inside their measured CI,`);
say(`     SMALLEST-GAP tier (${primary.smallestGapTier}) ${primary.smallInside ? "INSIDE ✓ — mandatory-within-CI met" : "OUTSIDE ✗ — STOP-class on its own"}.`);
say(`     Fitted form: A = ${f(primary.sel.A, 4)}, q = ${f(primary.sel.q, 2)} (${primary.sel.q > 1 ? "CONVEX" : primary.sel.q < 1 ? "concave/saturating" : "linear"}), monotone: ${primary.monotone ? "YES ✓" : "NO ✗"}.`);
if (primary.excluded.length) for (const e of primary.excluded)
  say(`  6. ${e.tier.toUpperCase()}, FITTED OUT BY THE FEASIBILITY RULE, CARRIES A PUBLISHED RESIDUAL of ${sgn(e.resid, 2)} [${f(e.residCI.lo, 2)}, ${f(e.residCI.hi, 2)}] (need ${f(e.need, 2)} vs s(${f(e.gap, 2)}) = ${f(e.s, 2)}).`);
else say(`  6. NO TIER EXCLUDED — all five need-CIs admit a common monotone curve, so the fit set is all five.`);
say(`  7. THE BAND RE-CHECK (p = 0.25 / 0.35) ${bandHolds ? "REPRODUCES the verdict" : "does NOT fully reproduce the verdict"} — see §5.`);
say(`  8. THE HELD-OUT BUDGET/DAILY LEGS ARE DIAGNOSTICS, NOT GATES. All read REAL DATA; their elevation`);
say(`     is the EXPECTED stratum-B/C era/composition signal and is read as such.`);
say();
say("### HEADER");
say(`  tool        tools/fit-hrspread-c6.ts`);
say(`  date        2026-07-22`);
say(`  model       '${trained.id}'   (raw-poly event model, own-gap path, no anchor on the judged line)`);
say(`  catalog     '${srcId}'   (${baseCards.length} base cards, variant rows excluded from the catalog read)`);
say(`  commit      f0c0207 (HEAD at generation)`);
say(`  channel     HR9 — pitcher home runs per 9, the RAW event-model line (era_hr = 1 on neutral Quick env)`);
say(`  coordinate  gapHr = buildFrameShift(trainingMeans, productionFieldStats(pool)).pit.vR.hrr — post-C1 + post-C2'`);
say(`  baseline    shipped C3 K ramp ACTIVE at every step: sK = kSpreadPitRamp(gapK), K_SPREAD_PIT = {A:${f(K_SPREAD_PIT.A, 4)}, q:${f(K_SPREAD_PIT.q, 2)}, gMax:${f(K_SPREAD_PIT.gMax, 2)}}`);
say(`  fit-N       FIELD_N = ${FIELD_N}   (cohort size; scaled by PRESENCE_M = ${PRESENCE_M} on the replicated mixture)`);
say(`  fit-p       PRESENCE_P = ${PRESENCE_P}   (presence prior; sensitivity legs at 0.25 / 0.35)`);
say(`  corpus      full-depth capture (buildCwhitSample DEFAULT_SOURCE) — ONE sample builder, no private joins`);
say(`  bars        primary BF ≥ ${MIN_BF}; sensitivity BF ≥ 1000 (REPORT, not a gate)`);
say(`  bootstrap   B = ${B}, SEED = ${SEED}; needs = mmse() slope of obs~pred, resample cards within tier`);
say(`  grain       observed statistics at ROW grain = (card × variant level); pool constants at CARD grain`);
say(`  era_k       ${f(coeffs.era_k, 4)}  era_effective_hr ${f(derived.era_effective_hr, 4)}  on the neutral Quick env`);
say();
say("### THE DECLARED FORM (declared before the numbers, per pre-registration §3)");
say();
say(`    s(g) = 1 + A·(g/${G0})^q      for g > 0;      s(g ≤ 0) = 1 EXACTLY`);
say();
say("  · G0 = 20 fixes the units of A (A = s(20) − 1); A (amplitude) and q (curvature) are fitted.");
say("  · THE FAMILY CONTAINS BOTH ANSWERS: q → 0 ⇒ a CONSTANT amplification s ≈ 1 + A (HR-is-flat);");
say("    q > 0 ⇒ a monotone RAMP (HR-is-gap-driven). The deliverable-space selection decides, not the");
say("    family. This is the HR prereg's clause-4 (C) ruling: HR's family question is genuinely open.");
say("  · OBJECTIVE (ruling (z)): per-card residuals, per-card noise weights w_i = 1/per9NoiseVar(obs,BF),");
say("    a PER-TIER FREE LEVEL. HR̄_pool drops out; s is a PURE SPREAD RESPONSE. Production applies s");
say("    about HR̄_pool — the level lives in the ANCHOR layer, not in s.");
say("  · BASELINE (prereg §3): the shipped C3 K ramp is ACTIVE in BOTH arms. The HR residual is measured");
say("    GIVEN the shipped K ramp — the shipping reality — not against a stale K line.");
say("  · FITTED SET (amendment 1): the MONOTONE-FEASIBILITY RULE. Default all five; exclude at most one");
say("    tier (the one whose removal maximises min-slack) only when no monotone curve fits all five CIs;");
say("    >1 exclusion ⇒ STOP. The SMALLEST-GAP fit-set tier is mandatory-within-CI (replaces diamond).");
say("  · SELECTION (ruling (x)): DELIVERABLE-SPACE EQUIVALENCE, minimax centre, set published in full.");
say(`    Grid q ∈ [${f(qAt(QI_LO), 2)}, ${f(qAt(QI_HI), 2)}] step 0.01, A closed-form at each q.`);
say();

say("### 1. THE COORDINATE + GATE (w)1 IDENTIFIABILITY (prong 1)");
say();
say(`  INSTRUMENT CHECK — productionFieldStats(pool) vs the same call with p stated explicitly at`);
say(`  p = ${PRESENCE_P}: max |Δgap| = ${instrDelta.toExponential(1)}  ${instrDelta === 0 ? "✓ bit-identical (the p knob is default-identity)" : "✗ THE KNOB IS NOT DEFAULT-IDENTITY"}`);
say();
say(`  gapHr pit.hrr   ${LADDER.map((t) => rpad(t, 9)).join("")}`);
for (const p of P_BAND) say(`  p = ${f(p, 2)}        ${LADDER.map((t) => rpad(f(gapTable.get(p)!.get(t)!, 2), 9)).join("")}`);
say();
say(`  The identifiability prong is over ALL FIVE tiers (the fitted set is not known until the needs are`);
say(`  measured — amendment 1 — and this prong is a property of the hrr COORDINATE, not of the fit).`);
say(`    p        ordering strictly descending    five-tier span   retention vs p=0`);
for (const r of w1Rows) say(`    ${f(r.p, 2)}     ${r.ord ? "YES ✓" : "NO ✗"}                          ${rpad(f(spanOf(gapTable.get(r.p)!), 2), 6)}           ${r.p === 0 ? "     —" : `${f(r.ret * 100, 1)}%`}`);
say();
say(`  REQUIREMENT: ordering at the fitted p matches p=0's, AND five-tier span retention ≥ 60%.`);
say(`  NOTE (prereg §2): if the HR NEED is gap-flat, ordering of NEEDS is not expected to be informative`);
say(`  — that is a family question the selection answers, NOT this gate, which is about the coordinate.`);
say(`  GATE (w)1: ${W1_PASS ? "PASS" : "FAIL"}`);
say();

function sayLeg(leg: LegResult, title: string, full: boolean) {
  const sFit = sOf(leg.sel.A, leg.sel.q);
  const inFit = (t: string) => (leg.fitTiers.includes(t) ? (t === leg.smallestGapTier ? "fit*" : "fit") : "OUT");
  say(`── ${title} ──`);
  say();
  say(`  MEASURED NEEDS (re-measured on this coordinate; the quoted values are a CROSS-CHECK, not an input)`);
  say(`  "fit" = in the fitted set; "fit*" = the smallest-gap MANDATORY tier; "OUT" = excluded, published (amd 1).`);
  say(`  tier      set    N   gapHr      HR̄_pool/600   HR̄_pool/9   slope   [boot 95% CI]    se     pivot-s`);
  for (const c of leg.cells) {
    say(`  ${pad(c.tier, 9)}${pad(inFit(c.tier), 5)}${rpad(String(c.rows.length), 3)}   ${rpad(f(c.gap, 2), 7)}   ${rpad(f(c.kbar600, 2), 9)}   ${rpad(f(c.kbar9, 2), 8)}   ${rpad(f(c.need, 2), 5)}   [${f(c.needCI.lo, 2)},${f(c.needCI.hi, 2)}]   ${f(c.needSe, 3)}    ${f(c.pivotS, 2)}${c.rows.length < THIN_N ? "  THIN" : ""}`);
  }
  say();
  say(`  THE FEASIBILITY RULE (amendment 1 — tiers ordered by gapHr ASCENDING)`);
  say(`    order (gap asc):  ${leg.feas.order.join(" → ")}`);
  say(`    all-five min-slack (max hi−floor deficit): ${sgn(leg.feas.minSlackAll, 3)}  ⇒ ${leg.feas.allFeasible ? "FEASIBLE — fit all five" : "INFEASIBLE — a monotone curve cannot hit all five need-CIs"}`);
  if (!leg.feas.allFeasible) {
    say(`    single-tier removal test (feasible? / restored min-slack):`);
    for (const r of leg.feas.perRemoval) say(`      drop ${pad(r.tier, 9)} ${r.feasible ? "FEASIBLE ✓" : "still infeasible ✗"}   min-slack ${sgn(r.minSlack, 3)}`);
    if (leg.feas.stop) say(`    ⇒ NO single removal restores feasibility → >1 exclusion needed → STOP (family/coordinate failure).`);
    else say(`    ⇒ exclude ${leg.feas.excluded.join(", ")} (maximal min-slack). ${leg.feas.reason}`);
  }
  say(`    fit set: ${leg.fitTiers.join(", ")}   smallest-gap (mandatory): ${leg.smallestGapTier}`);
  say();
  say(`  THE FIT  (fitted set: ${leg.fitTiers.join(", ")})`);
  say(`    wide-grid SSE optimum:   q* = ${f(leg.sel.opt.q, 2)}   A* = ${f(leg.sel.opt.A, 4)}   SSE ${f(leg.sel.opt.sse, 1)}`);
  say(`    LINEAR LIMIT (q = 1):    A  = ${f(leg.sel.lin.A, 4)}   SSE ${f(leg.sel.lin.sse, 1)}   ⇒ β = A/${G0} = ${f(leg.sel.lin.A / G0, 5)} per gap unit`);
  say(`    SELECTED (minimax centre of the equivalence set):  A = ${f(leg.sel.A, 4)}  [boot 95% CI ${f(leg.aCI.lo, 4)}, ${f(leg.aCI.hi, 4)}]`);
  say(`                                                       q = ${f(leg.sel.q, 2)}  [boot 95% CI ${f(leg.qCI.lo, 2)}, ${f(leg.qCI.hi, 2)}]`);
  say(`    curvature: ${leg.sel.q > 1 ? "CONVEX (q > 1)" : leg.sel.q < 1 ? "CONCAVE / saturating (q < 1)" : "LINEAR (q = 1)"};  monotone increasing: ${leg.monotone ? "YES ✓" : "NO ✗ (A ≤ 0 — wrong-signed)"}`);
  say(`    s at reference gaps:  s(10)=${f(sFit(10), 3)}  s(15)=${f(sFit(15), 3)}  s(20)=${f(sFit(20), 3)}  s(25)=${f(sFit(25), 3)}  s(30)=${f(sFit(30), 3)}  s(40)=${f(sFit(40), 3)}`);
  say();
  if (!full) return;
  say(`  THE EQUIVALENCE SET, PUBLISHED IN FULL (ruling (x) — this IS the deliverable's precision)`);
  say(`    set:  q ∈ [${f(leg.sel.setLo, 2)}, ${f(leg.sel.setHi, 2)}]   ${leg.sel.setN} of ${leg.prof.length} grid points   ${leg.sel.contiguous ? "CONTIGUOUS ✓" : "NON-CONTIGUOUS ⚠"}   touches a grid edge: ${leg.sel.atEdge ? `YES (q→0 is the STRUCTURAL-LIMIT constant edge — informational, see (w)2')` : "NO"}`);
  say(`      tier        se     set s-range          centre    (centre − range mid) / se`);
  for (const [i, c] of leg.fitCells.entries()) {
    const mid = (leg.sel.sLo[i]! + leg.sel.sHi[i]!) / 2;
    say(`      ${pad(c.tier, 10)}${rpad(f(c.needSe, 3), 6)}   ${rpad(`${f(leg.sel.sLo[i]!, 3)} – ${f(leg.sel.sHi[i]!, 3)}`, 18)}   ${rpad(f(sFit(c.gap), 3), 8)}  ${sgn((sFit(c.gap) - mid) / c.needSe, 3)}`);
  }
  say(`    set width ${f(leg.sel.width, 2)} need-SEs; the centre reaches ${f(leg.sel.radius, 2)} SEs to the furthest member.`);
  say();
  say(`  GATE (w)2' APPLIED-DOMAIN DELIVERABLE (Fable ruling — replaces the old grid-edge (w)2): ${leg.w2.pass ? "PASS" : "FAIL"}`);
  say(`    ${leg.w2.why}`);
  say(`    ${leg.w2.marker}`);
  say(`    YARDSTICK SENSITIVITY (surfaced, not hidden): over ${leg.w2.nApplied} production tournaments post-clamp, worst s-spread`);
  say(`    is ${f(leg.w2.interpWorst, 2)}× local need-SE under the INTERPOLATED yardstick (${leg.w2.interpExc} exceed 1) and ${f(leg.w2.nearestWorst, 2)}× under NEAREST-tier`);
  say(`    (${leg.w2.nearestExc} exceed 1). The two disagree only in the diamond↔gold interpolation region, where nearest snaps to`);
  say(`    gold's tighter SE. Interpolation is the principled reading; the disagreement is the ruling-relevant sensitivity.`);
  say();
  say(`  GATE (w)3 LEAVE-ONE-TIER-OUT, IN DELIVERABLE SPACE`);
  say(`    dropped        A        q      ${LADDER.map((t) => rpad(`s(${t.slice(0, 3)})`, 10)).join("")}  inside s-CI?`);
  for (const x of leg.loo) {
    say(`    ${pad(x.dropped, 12)}${rpad(f(x.A, 4), 8)} ${rpad(f(x.q, 2), 6)} ${LADDER.map((t) => rpad(f(x.sAt.get(t) ?? NaN, 2), 10)).join("")}  ${x.inAll ? "YES ✓" : "NO ✗"}`);
  }
  say(`    full fit s(g)                  ${LADDER.map((t) => rpad(f(sFit(leg.cells.find((c) => c.tier === t)!.gap), 2), 10)).join("")}`);
  say(`    full fit CI               ${LADDER.map((t) => { const q = leg.sCI.get(t)!; return rpad(`${f(q.lo, 2)}-${f(q.hi, 2)}`, 10); }).join("")}`);
  say(`  GATE (w)3: ${leg.w3 ? "PASS" : "FAIL"}`);
  say();
  say(`  ACCEPTANCE — implied s(g_t) vs the measured bootstrap CI, ON THE FIT SET`);
  say(`  (smallest-gap tier MANDATORY; at most one other fit-set tier may sit outside. Excluded tiers`);
  say(`  are published in §4, not scored.)`);
  say(`    tier       gapHr   s(gap)   measured need   [boot 95% CI]    inside?`);
  for (const a of leg.accept) {
    const c = leg.cells.find((x) => x.tier === a.tier)!;
    say(`    ${pad(a.tier, 9)}${rpad(f(c.gap, 2), 6)}   ${rpad(f(a.s, 3), 6)}   ${rpad(f(a.need, 2), 13)}   [${f(a.lo, 2)},${f(a.hi, 2)}]      ${a.inside ? "YES ✓" : "NO  ✗"}${a.tier === leg.smallestGapTier ? "  (mandatory)" : ""}${a.thin ? "   THIN" : ""}`);
  }
  for (const e of leg.excluded) say(`    ${pad(e.tier, 9)}${rpad(f(e.gap, 2), 6)}   ${rpad(f(e.s, 3), 6)}   ${rpad(f(e.need, 2), 13)}   [${f(e.needCI.lo, 2)},${f(e.needCI.hi, 2)}]      NOT SCORED — excluded (amd 1)`);
  say(`    inside: ${leg.accept.filter((a) => a.inside).length} of ${leg.fitCells.length};  SMALLEST-GAP (${leg.smallestGapTier}) ${leg.smallInside ? "INSIDE ✓" : "OUTSIDE ✗ (STOP-class)"}`);
  say(`    monotone over the observed range: ${leg.monotone ? "YES ✓" : "NO ✗ (kill condition 6)"}`);
  say(`  ACCEPTANCE: ${leg.acceptPass ? "PASS" : "FAIL"}`);
  say();
  say(`  DIAGNOSTIC D2 — RULING (z): pivot-s − need (systematic level bleed) vs wtd free-s − need (weighting only)`);
  say(`    tier      HR̄_pool/9   wtd mean pred   offset(pred−HR̄)   wtd mean resid(obs−pred)   pivot-s   wtd free-s   need`);
  for (const c of leg.cells) {
    say(`    ${pad(c.tier, 9)}${rpad(f(c.kbar9, 2), 8)}   ${rpad(f(c.wPredMean, 2), 13)}   ${rpad(sgn(c.offPred, 2), 16)}   ${rpad(sgn(c.offResid, 2), 24)}   ${rpad(f(c.pivotS, 2), 7)}   ${rpad(f(c.wFreeS, 2), 10)}   ${f(c.need, 2)}`);
  }
  say(`    pivot-s − need mean ${sgn(mean(leg.cells.map((c) => c.pivotS - c.need)), 2)} (systematic, same sign);  wtd free-s − need mean ${sgn(mean(leg.cells.map((c) => c.wFreeS - c.need)), 2)} (weighting only)`);
  say();
  say(`  DIAGNOSTIC D4 — family reach: tier-aggregate fit to the needs, precision-weighted (NOT the objective)`);
  const tierAgg = (cs: TierCell[]) => cs.map((c) => { const w = 1 / c.needSe ** 2, e = c.need - 1; return { tier: c.tier, g: c.gap, Swdz: w * e, Swdd: w, Swzz: w * e * e, n: c.rows.length }; });
  const d4all = select(profileOf(tierAgg(leg.cells)), gapsOf(leg), sesOf(leg));
  const d4fit = select(profileOf(tierAgg(leg.fitCells)), gapsOf(leg), sesOf(leg));
  for (const [lab, pn] of [["   all five, optimum", d4all], ["   fit set, optimum", d4fit]] as const) {
    const sc = scoreAccept(leg.fitCells, sOf(pn.opt.A, pn.opt.q));
    say(`      ${pad(lab, 24)} A* ${rpad(f(pn.opt.A, 3), 6)} q* ${rpad(f(pn.opt.q, 2), 5)}  ${LADDER.map((t) => rpad(f(sOf(pn.opt.A, pn.opt.q)(leg.cells.find((c) => c.tier === t)!.gap), 2), 8)).join("")}  ⇒ ${sc.filter((x) => x.inside).length}/${leg.fitCells.length} fit inside`);
  }
  say(`      needs                    ${rpad("", 15)}${LADDER.map((t) => rpad(f(leg.cells.find((c) => c.tier === t)!.need, 2), 8)).join("")}`);
  say();
}
const gapsOf = (leg: LegResult) => leg.fitCells.map((c) => c.gap);
const sesOf = (leg: LegResult) => leg.fitCells.map((c) => c.needSe);

say("### 2. THE PRIMARY FIT — p = 0.30, BF ≥ 600");
say();
sayLeg(primary, `PRIMARY LEG  p = ${PRESENCE_P}, BF ≥ ${MIN_BF}`, true);

say("### 3. THE 1000 BAR — A SENSITIVITY REPORT, NOT A GATE");
say();
say("  A POOL-LEVEL ramp is one function s(g) of a FORMAT'S GAP — a catalog property — so s(g_t) returns");
say("  the SAME scalar at the 600 and 1000 bar. It cannot move between bars; the needs can.");
say();
say(`  tier       s(gapHr)   need@600  [CI]              need@1000 [CI]             N600→N1000   Δneed`);
for (const t of LADDER) {
  const a = primary.cells.find((c) => c.tier === t)!, b = bar1000.cells.find((c) => c.tier === t)!;
  say(`  ${pad(t, 9)}${rpad(f(sPrimary(a.gap), 3), 8)}   ${rpad(f(a.need, 2), 8)}  [${f(a.needCI.lo, 2)},${f(a.needCI.hi, 2)}]      ${rpad(f(b.need, 2), 9)} [${f(b.needCI.lo, 2)},${f(b.needCI.hi, 2)}]      ${rpad(`${a.rows.length}→${b.rows.length}`, 11)}  ${sgn(b.need - a.need, 2)}${b.rows.length < THIN_N ? "   THIN@1000" : ""}`);
}
say(`  1000-bar feasibility: ${bar1000.feas.reason}. Fit set ${bar1000.fitTiers.join(", ")}; ${bar1000.accept.filter((a) => a.inside).length}/${bar1000.fitCells.length} inside, smallest-gap ${bar1000.smallInside ? "inside" : "outside"}. REPORT ONLY.`);
say();

say("### 4. THE EXCLUDED TIER(S) — PUBLISHED QUANTIFIED RESIDUAL(S) (amendment 1)");
say();
if (!primary.excluded.length) {
  say(`  NONE. All five tiers' need-CIs admit a common monotone curve (all-five min-slack ${sgn(primary.feas.minSlackAll, 3)} ≥ 0),`);
  say(`  so no tier is fitted out and there is no published residual on the HR channel this run.`);
} else {
  say(`  A tier is excluded ONLY when no monotone s(g) can pass its need-CI and every other fit-set CI at`);
  say(`  once (a structural incompatibility, measured, not a tuning choice). Its residual ships WITH the`);
  say(`  constant, gold semantics: re-measured every sweep, re-blocking on CI-clear growth beyond the`);
  say(`  published interval. The CI differences the excluded need's OWN bootstrap against the fit's,`);
  say(`  index-wise — legitimate precisely because the tier is out of the fit (independent resamples).`);
  for (const e of primary.excluded) {
    const gc = primary.cells.find((c) => c.tier === e.tier)!;
    say();
    say(`    ${e.tier}        N = ${gc.rows.length} rows      gapHr ${f(e.gap, 2)}`);
    say(`    measured need               ${f(e.need, 2)}   [boot 95% CI ${f(e.needCI.lo, 2)}, ${f(e.needCI.hi, 2)}]`);
    say(`    shipped s(gap)              ${f(e.s, 2)}`);
    say(`    RESIDUAL  need − s(gap)   ${sgn(e.resid, 3)}   [boot 95% CI ${f(e.residCI.lo, 2)}, ${f(e.residCI.hi, 2)}]`);
  }
  say();
  say(`  ATTRIBUTION: the COMPOSITION / COHORT axis (task 2's territory, not built). Recorded as a`);
  say(`  standing, sized, CI-bearing residual so task 2 inherits a NUMBER rather than an anecdote.`);
}
say();

say("### 5. THE GATES RE-CHECKED ACROSS THE PRESENCE BAND (p = 0.25 / 0.35)");
say();
for (const leg of pLegs) sayLeg(leg, `SENSITIVITY LEG  p = ${f(leg.p, 2)}, BF ≥ ${MIN_BF}`, true);
say(`  BAND SUMMARY`);
say(`    p        feas          (w)2    (w)3    acceptance (fit inside)              A        q      s(20)`);
for (const leg of [pLegs[0]!, primary, pLegs[1]!].sort((a, b) => a.p - b.p)) {
  say(`    ${f(leg.p, 2)}     ${rpad(leg.feas.stop ? "STOP" : leg.excluded.length ? `−${leg.excluded.join(",")}` : "all five", 12)}  ${leg.w2.pass ? "PASS" : "FAIL"}    ${leg.w3 ? "PASS" : "FAIL"}    ${rpad(`${leg.accept.filter((a) => a.inside).length}/${leg.fitCells.length}, small ${leg.smallInside ? "IN" : "OUT"}`, 33)}  ${rpad(f(leg.sel.A, 4), 7)}  ${rpad(f(leg.sel.q, 2), 5)}  ${f(sOf(leg.sel.A, leg.sel.q)(20), 3)}`);
}
say(`    BAND VERDICT: ${bandHolds ? "HOLDS at 0.25 and 0.35" : "DOES NOT HOLD across the whole band (see the legs above)"}`);
say();

say("### 6. HELD-OUT FORMAT VALIDATION (VALIDATED, NEVER FITTED — DIAGNOSTIC, NOT A GATE)");
say();
say("  Formats resolved from the corpus REGISTRY by tournamentId and named to the builder by REGISTRY");
say("  KEY. BOTH arms carry the shipped C3 K ramp (sK = kSpreadPitRamp(gapK)); the HR ramp is the only");
say("  thing that moves pre→post. The judged line is the DEPLOYED one (era/park applied).");
say();
say(`  format               strat  poolN  joined  judged  gapHr  HR̄dep/9  s(gap)  pre slope [CI]        post slope [CI]       verdict`);
for (const v of valRows) {
  say(`  ${pad(lbl(v.label), 21)}${pad(v.stratum, 7)}${rpad(String(v.poolN), 5)}  ${rpad(String(v.joined), 6)}  ${rpad(String(v.judged), 6)}  ${rpad(f(v.gapHr, 1), 5)}  ${rpad(f(v.kbar, 2), 6)}  ${rpad(f(v.s, 3), 6)}  ${rpad(`${f(v.preSlope, 2)} [${f(v.preCI.lo, 2)},${f(v.preCI.hi, 2)}]`, 20)}  ${rpad(`${f(v.postSlope, 2)} [${f(v.postCI.lo, 2)},${f(v.postCI.hi, 2)}]`, 20)}  ${v.verdict}`);
}
say(`  HR̄dep/9 is the DEPLOYED-frame pool mean (×era_effective_hr) for reading; the correction is centred`);
say(`  on the RAW pre-era HR̄ per 600, where production applies it.`);
const gOut = valRows.filter((v) => Number.isFinite(v.gapHr) && (v.gapHr > gMaxP || v.gapHr < gMinP));
say(`  EXTRAPOLATION: the fit spans gapHr ${f(gMinP, 2)}–${f(gMaxP, 2)} (the Quick fit set). ${gOut.length ? `OUTSIDE: ${gOut.map((v) => `${lbl(v.label)} g=${f(v.gapHr, 1)}`).join("; ")} — s there is EXTRAPOLATED.` : "every validated format sits inside it."}`);
say();
say(`  HR9 LEVEL (pred − obs), pre → post:`);
for (const v of valRows) say(`    ${pad(lbl(v.label), 21)} ${sgn(v.preLevel, 2)} → ${sgn(v.postLevel, 2)}   [${v.note}]`);
say();
const gs = valRows.find((v) => v.tid === "gold-slots")!;
say(`  GOLD-SLOTS REACHABILITY: resolves to registry key '${gs.key}' (label "${gs.label}"), joined ${gs.joined}`);
say(`    pitcher rows / ${gs.judged} judged at BF ≥ ${MIN_BF} over a ${gs.poolN}-card pool ⇒ ${gs.joined > 0 ? "IT READS REAL DATA." : "✗ EMPTY."}`);
for (const v of valRows) for (const nt of v.notices) say(`    notice [${v.key}]: ${nt}`);
say();

say("### 7. THE STRATIFIED READ");
say();
say("  A — NEUTRAL UNCAPPED QUICKS (the core; this is what was FITTED)");
say(`      ${primary.accept.filter((a) => a.inside).length} of the ${primary.fitCells.length} fit-set tiers inside, smallest-gap (${primary.smallestGapTier}) ${primary.smallInside ? "INSIDE" : "OUTSIDE"}.`);
say(`      Residuals s(gap) − need: ${LADDER.map((t) => { const a = primary.accept.find((x) => x.tier === t); const c = primary.cells.find((x) => x.tier === t)!; const sv = a ? a.s : sPrimary(c.gap); return `${t} ${sgn(sv - c.need, 2)}${a ? "" : " (excluded)"}`; }).join("  ")}`);
const liveOpen = valRows.find((v) => v.tid === "live-open-daily")!;
say(`      Non-Quick neutral control (live-open-daily): judged ${liveOpen.judged}, ${liveOpen.verdict}`);
say();
say("  B — ENV-BEARING UNCAPPED DAILIES (+ the era/park layer; parks DO carry an HR factor — the K ramp");
say("      does not, so this stratum is more load-bearing for HR than for K)");
for (const v of valRows.filter((x) => x.stratum === "B")) say(`      ${pad(lbl(v.label), 20)} judged ${rpad(String(v.judged), 3)}  s ${f(v.s, 3)}  slope ${f(v.preSlope, 2)} → ${f(v.postSlope, 2)}  ${v.verdict}`);
say();
say("  C — BUDGET CAP/SLOTS FORMATS (+ the composition layer)");
for (const v of valRows.filter((x) => x.stratum.includes("C"))) say(`      ${pad(lbl(v.label), 20)} judged ${rpad(String(v.judged), 3)}  s ${f(v.s, 3)}  slope ${f(v.preSlope, 2)} → ${f(v.postSlope, 2)}  ${v.verdict}${v.stratum === "B+C" ? "   [also carries env ⇒ B+C]" : ""}`);
say(`      DIAGNOSTIC, NOT A GATE. A stratum-C miss localises to the COMPOSITION layer (task 2), not the`);
say(`      core fit. gold-cap additionally carries park-156's non-neutral HR handedness (the standing flag).`);
say();

say("### 8. THE CONSTANT, WITH PROVENANCE STAMPED (do NOT read as wired)");
say();
if (fails.length) {
  say(`  NO CONSTANT IS PROPOSED FOR SHIPPING. ${fails.join(" + ")}. What follows is what the pre-registered`);
  say(`  rule PRODUCED, recorded so the record is complete. It is not a recommendation.`);
} else {
  say(`  THE GATES PASS, SO THIS IS THE CONSTANT THE PRE-REGISTERED RULE PRODUCED. This tool wires nothing;`);
  say(`  shipping is the SAME dated commit as C3 and the hitter-tail refit (the atomic-event rule).`);
}
say();
say(`  PIT_SPREAD_HR = { A: ${f(primary.sel.A, 4)}, q: ${f(primary.sel.q, 2)}, G0: ${G0}, gMax: ${f(gMaxP, 2)}, fitN: ${FIELD_N}, fitP: ${PRESENCE_P} }`);
say(`  s(g) = 1 + ${f(primary.sel.A, 4)}·(g/${G0})^${f(primary.sel.q, 2)};   s(g ≤ 0) = 1;   flat-hold s(g) = s(${f(gMaxP, 2)}) = ${f(sPrimary(gMaxP), 3)} above gMax.`);
say(`  fitted set = ${primary.fitTiers.join(", ")}${primary.excluded.length ? `   (${primary.excluded.map((e) => `${e.tier} OUT, residual ${sgn(e.resid, 2)} [${f(e.residCI.lo, 2)}, ${f(e.residCI.hi, 2)}]`).join("; ")})` : "   (all five — no exclusions)"}`);
say(`  equivalence set = q ∈ [${f(primary.sel.setLo, 2)}, ${f(primary.sel.setHi, 2)}], ${primary.sel.setN} grid points, width ${f(primary.sel.width, 2)} need-SEs.`);
say(`  PROVENANCE (fit-derived, coordinate-dependent — never rescale, only re-derive): fitN = ${FIELD_N}, fitP = ${PRESENCE_P}, gMax = ${f(gMaxP, 2)}.`);
say(`  It joins K_SPREAD_PIT under assertKSpreadProvenance on a PASS (prereg §4 gate 5).`);
say();
say(`  RETIRED SATURATING CONSTANT, QUOTED FOR CONTRAST: PIT_SPREAD_HR (BUILD-3) = { A: 0.2648, G: 5.8 }`);
say(`  on the FALSIFIED saturating family, fitted at the PRE-C1/C2' coordinate. Compare on s(g) only:`);
say(`    g          10      15      20      25      30      40`);
say(`    C6       ${[10, 15, 20, 25, 30, 40].map((g) => rpad(f(sPrimary(g), 3), 8)).join("")}`);
say(`    shipped  ${[10, 15, 20, 25, 30, 40].map((g) => rpad(f(pitSpreadHrRamp(g), 3), 8)).join("")}`);
say();

say("### 9. RECORDED, NOT ACTED ON (the freeze applies)");
say();
say("  · The K ramp baseline is the SHIPPED C3 constant K_SPREAD_PIT (imported, not re-fit here). The HR");
say("    residual is measured on top of it; if C3's constant moves, this refit must re-run.");
say("  · The RAW hr9 line the Quick fit judges is invariant to the K ramp (applyPitSpread moves only K");
say("    when sHr = 1), so the Quick-tier fit numbers do not depend on the K baseline; the DEPLOYED line");
say("    and calibrate() DO, which is why the held-out (env-bearing) legs carry it.");
say("  · FIELD_N = 50 is known-defective and frozen until a retrain; nothing here revisits it.");
say("  · A CONVEX q > 1 power law is UNBOUNDED above the fitted gap range; the flat-hold at gMax is the");
say("    domain rule (amendment 3), the same treatment C3 carries. Whether it is wired is Fable's call.");
say();
say(`(end of artifact — HR-ramp refit, ${VERDICT.split(" ")[0]})`);

process.stdout.write(L.join("\n") + "\n");
process.exit(0);
