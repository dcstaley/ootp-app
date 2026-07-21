// ═══ CENTERPIECE #2 — THE RATING-LOCAL ERROR PROFILE e(r). THE FIT. ══════════
//
// Pre-registration: docs/CWHIT_CENTERPIECE2_PREREG_2026-07-21.md + AMENDMENT 1 (ruling (a)).
// Step 0 (already run) killed the literal-extrapolation reading and narrowed the admissible form to
// an error LOCALIZED AT LOW SUPPORT. This tool executes the registered test and nothing else.
//
// WHAT IS REGISTERED, restated here so a reader can check the code against it without leaving:
//   FORM      log m(r) = A · max(0, r0 − r)      one-sided hinge; m ≡ 1 above r0 BY CONSTRUCTION
//   r         effective stuff PER SIDE — applyAffine(Stuff v{R,L}, poolTransform.pit.v{R,L}.stu),
//             the exact argument the curve is evaluated at; the correction is applied per side and
//             then blended by the same exposure weights ourPit blends with
//   r0        CONSTRAINED ≤ the league training median. A knot above it is a global slope wearing a
//             hinge — kill condition A1.5(7), not a result.
//   A         FREE IN SIGN. The hypothesis predicts A < 0 (low-stuff cards' true K below prediction,
//             widening observed spread). A fitted A > 0 is a REFUTATION — A1.5(8).
//   OBJECTIVE per-CARD residuals, weighted by per-card noise (per9NoiseVar). NO tier aggregate
//             enters the objective: the function is never shown the numbers it must reproduce.
//   TARGETS   BF≥600  1.82 / 1.62 / 1.48 / 1.78 / 1.04
//             BF≥1000 1.83 / 1.64 / 1.47 / 1.63 / — (diamond N=19, THIN, no verdict)
//   P1        implied slope inside the measured bootstrap CI for ≥4 of 5 tiers @600, ≥3 of 4 @1000
//   P2        fitted with GOLD EXCLUDED, implied gold slope inside gold's CI at BOTH bars
//   P3        reproduce the DIFFERENTIAL: gold moves down between bars while the others hold
//   N1        m constant — can only produce one slope for every tier, so it must lose
//   N2        the same hinge on PREDICTED K instead of effective stuff. If N2 does as well, the
//             "rating-local" claim is NOT distinguished by the data and that is the finding.
//   ROBUST    the same hinge in TRAINING-SUPPORT PERCENTILE — reported, NEVER selected on fit.
//
// DUAL POLICY (Fable ruling (h)). Everything runs twice: on the CURRENT coordinate (production's
// variant-free ref+pool) and on ARM C's (ref and pool both variant-inclusive — the ruled destination
// policy, which moves effective stuff). Needs are RE-MEASURED under each policy, because a policy
// that moves the predicted line moves the slope it is measured against. A verdict that FLIPS between
// policies is a STOP-and-report, not a result to average.
//
// NOTHING IS WIRED. No constants leave this file. The verdict goes back to Fable.

import { readFileSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import {
  makeRawPolyModel, applyWobaWeights, computeDerived, computeUnifiedFieldStats, buildPoolTransform, applyAffine,
  FIELD_N, type EventForm, type FieldStats, type PoolTransform, type RatingEnvelope, type WobaWeights, type TrainingMeans,
} from "../src/scoring-core/index.ts";
import { parseCatalogCsv, type Card } from "../src/data/catalog.ts";
import {
  QUICK, inValueWindow, n_, handLetter, buildCwhitSample, wellSampled, MIN_BF,
  type SampleDeps, type ValueWindow,
} from "../src/eval/cwhit/sample.ts";
import { BF_PER_9 } from "../src/eval/cwhit/parse.ts";
import { opponentSet } from "../src/eval/cwhit/realized.ts";
import { mmse } from "../src/eval/cwhit/two-ledger.ts";
import { per9NoiseVar } from "../src/eval/cwhit/scorecard.ts";
import { loadWindow } from "../src/training/loader.ts";

const BARS = [600, 1000] as const;
const SEED = 20260716, B = 2000;
/** The measured needs, quoted for reporting only — they never enter the objective (amendment A1.3).
 *  Re-measured in-tool per policy; these are the committed BF≥600/1000 values for cross-check. */
const COMMITTED: Record<string, [number, number | null]> = {
  iron: [1.82, 1.83], bronze: [1.62, 1.64], silver: [1.48, 1.47], gold: [1.78, 1.63], diamond: [1.04, null],
};

const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state = (await repo.load<{ activeModelId?: string; catalogSourceId?: string }>("state", "app")) ?? {};
type TM_ = { id: string; eventForm?: EventForm; wobaWeights?: WobaWeights; ratingEnvelope?: RatingEnvelope; trainingMeans?: TrainingMeans;
  datasetRoot?: string; window?: number[]; minPA?: number;
  platoon?: { pit: { hand: string; vsRHB: number; vsLHB: number }[]; hit: { hand: string; vsRHP: number; vsLHP: number }[] } };
const trained = (await repo.loadAll<TM_>("trained-models")).find((x) => x.id === state.activeModelId);
if (!trained?.eventForm || !trained.wobaWeights || !trained.platoon || !trained.trainingMeans) throw new Error("active model missing eventForm/wobaWeights/platoon/trainingMeans");
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
const baseCards = parseCatalogCsv(readFileSync(`data/imports/${srcId}.csv`, "utf8")).cards
  .filter((c) => String(c["Variant"] ?? "").toUpperCase() !== "Y");
const pitExp = new Map(trained.platoon.pit.map((p) => [p.hand, { wR: p.vsRHB, wL: p.vsLHB }]));

// ── the league training support (step 0's decider, reused verbatim in construction) ──────────
const K = trained.eventForm.pit.k as { mu: number; sd: number; uMin?: number; uMax?: number };
const trRows = loadWindow(trained.datasetRoot ?? "League Files", trained.window?.length ? trained.window : undefined)
  .observations.filter((o) => o.pitch.BF >= (trained.minPA ?? 1000) && Number.isFinite(o.ratings.pitch.stu))
  .map((o) => ({ r: o.ratings.pitch.stu, w: Math.pow(o.pitch.BF, 0.75) }))
  .sort((a, b) => a.r - b.r);
const trW = trRows.reduce((a, x) => a + x.w, 0);
const trQ = (p: number) => { let acc = 0; for (const x of trRows) { acc += x.w; if (acc >= p * trW) return x.r; } return trRows[trRows.length - 1]!.r; };
/** share of league training weight at or below a rating — the ROBUSTNESS coordinate */
const trPct = (r: number) => trRows.reduce((a, x) => a + (x.r <= r ? x.w : 0), 0) / trW;
const R0_MAX = trQ(0.50);   // the registered constraint: knot at or below the training median

// ── the two policies ─────────────────────────────────────────────────────────
const ALL_WIN: ValueWindow = { tier: "all", valueMax: Number.POSITIVE_INFINITY };
const bothLevels = (cards: Card[], win: ValueWindow): Card[] =>
  [...opponentSet(cards, win, "pit"), ...opponentSet(cards, win, "hit")].map((o) => o.card);

type Policy = "current" | "armC";
const refOf = (p: Policy): FieldStats =>
  computeUnifiedFieldStats(p === "current" ? baseCards : bothLevels(baseCards, ALL_WIN), coeffs, rp, FIELD_N, true);
const poolOf = (p: Policy, win: ValueWindow): Card[] =>
  p === "current" ? baseCards.filter((c) => inValueWindow(c, win)) : bothLevels(baseCards, win);

// ── the per-side predicted line (the model, called; no scoring math written here) ─────────────
interface Row {
  tier: string; cid: string; bar: number;
  /** per side: effective stuff, uncorrected K/600, exposure weight */
  sides: { r: number; k: number; w: number; pct: number }[];
  predK9: number; obs: number; nv: number; sample: number;
}
const per9 = BF_PER_9 / 600;

function sidesOf(c: Card, pt: PoolTransform): { r: number; k: number; w: number; pct: number }[] {
  const { wR, wL } = pitExp.get(handLetter(n_(c["Throws"]))) ?? { wR: 0.5, wL: 0.5 };
  return (["R", "L"] as const).map((s) => {
    const t = pt.pit[s === "R" ? "vR" : "vL"];
    const r = applyAffine(n_(c[`Stuff v${s}`]), t?.stu);
    const e = rp.predictPitching({
      con: applyAffine(n_(c[`Control v${s}`]), t?.con), stu: r,
      pbabip: applyAffine(n_(c[`pBABIP v${s}`]), t?.pbabip), hrr: applyAffine(n_(c[`pHR v${s}`]), t?.hrr),
    }, coeffs);
    return { r, k: e.K, w: s === "R" ? wR : wL, pct: 100 * trPct(r) };
  });
}

/** Corrected per-9 K under a hinge on coordinate `x(side)`. A === 0 ⇒ exactly the uncorrected line. */
const corrK9 = (row: Row, A: number, r0: number, xOf: (s: Side, row: Row) => number): number =>
  row.sides.reduce((a, s) => a + s.w * s.k * Math.exp(A * Math.max(0, r0 - xOf(s, row))), 0) * per9;

type Side = { r: number; k: number; w: number; pct: number };
const X_STU = (s: Side) => s.r;                          // registered PRIMARY coordinate
const X_PCT = (s: Side) => s.pct;                        // ROBUSTNESS coordinate (precomputed)
const X_PRED = (_s: Side, row: Row) => row.predK9;       // NULL N2 coordinate

// ── plumbing ─────────────────────────────────────────────────────────────────
const rng = (seed: number) => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const pct = (xs: number[], q: number) => { const v = [...xs].sort((a, b) => a - b); return v.length ? v[Math.min(Math.max(Math.floor(q * v.length), 0), v.length - 1)]! : NaN; };
const slopeOf = (p: number[], o: number[]) => {
  const mp = p.reduce((a, b) => a + b, 0) / p.length, mo = o.reduce((a, b) => a + b, 0) / o.length;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < p.length; i++) { sxx += (p[i]! - mp) ** 2; sxy += (p[i]! - mp) * (o[i]! - mo); }
  return sxx > 0 ? sxy / sxx : NaN;
};
const f = (x: number, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");

// ── build every (policy, bar) row set ────────────────────────────────────────
const rowsBy = new Map<string, Row[]>();          // `${policy}|${bar}`
const pinMax = { d: 0, where: "" };

for (const policy of ["current", "armC"] as Policy[]) {
  const ref = refOf(policy);
  const ptBy = new Map<string, PoolTransform>();
  const cardBy = new Map<string, Map<string, Card>>();
  for (const win of QUICK) {
    ptBy.set(win.tier, buildPoolTransform(ref, computeUnifiedFieldStats(poolOf(policy, win), coeffs, rp, FIELD_N, true), trained.ratingEnvelope));
    cardBy.set(win.tier, new Map(opponentSet(baseCards, win, "pit").map((o) => [o.cid, o.card])));
  }
  for (const bar of BARS) {
    const deps: SampleDeps = {
      baseCards, coeffs, derived, eventForm: trained.eventForm, model: rp, W: trained.wobaWeights!, ref: refOf("current"),
      envelope: trained.ratingEnvelope,
      pitExp, hitExp: new Map(trained.platoon!.hit.map((p) => [p.hand, { wR: p.vsRHP, wL: p.vsLHP }])),
      minBf: bar,
    };
    // The BUILDER supplies the join, the observed line and the usage floor — always on production's
    // coordinate, so the SAMPLE is identical across policies and only the predicted line moves.
    const res = buildCwhitSample(deps);
    const out: Row[] = [];
    for (const rec of res.recs) {
      if (rec.role !== "pit" || !wellSampled(rec) || !Number.isFinite(rec.obs.k9)) continue;
      const c = cardBy.get(rec.tier)?.get(rec.cid); if (!c) continue;
      const sides = sidesOf(c, ptBy.get(rec.tier)!);
      const predK9 = sides.reduce((a, s) => a + s.w * s.k, 0) * per9;
      // INSTRUMENT CHECK: on the current policy this reconstruction must equal the builder's own
      // raw line. If it does not, the tool is measuring something other than the deployed curve.
      if (policy === "current") {
        const d = Math.abs(predK9 - rec.ours.k9!);
        if (d > pinMax.d) { pinMax.d = d; pinMax.where = `${rec.tier}/${rec.cid}`; }
      }
      out.push({ tier: rec.tier, cid: rec.cid, bar, sides, predK9, obs: rec.obs.k9!, nv: per9NoiseVar(rec.obs.k9!, rec.sample), sample: rec.sample });
    }
    rowsBy.set(`${policy}|${bar}`, out);
  }
}

console.log(`\n╔═══ CENTERPIECE #2 — THE FIT (pre-registered; amendment 1) ═══╗`);
console.log(`model '${trained.id}' | catalog '${srcId}' | seed ${SEED} | B ${B}`);
console.log(`league training support: N ${trRows.length} obs (BF>=${trained.minPA ?? 1000}, BF^0.75 weights)`);
console.log(`REGISTERED KNOT CONSTRAINT r0 <= training median = ${f(R0_MAX, 1)} (stuff rating)`);
console.log(`\nINSTRUMENT CHECK — tool-side per-side reconstruction vs the builder's own raw K9 line,`);
console.log(`current policy: max |diff| = ${pinMax.d.toExponential(2)}${pinMax.where ? `  (at ${pinMax.where})` : ""}`);
if (pinMax.d > 1e-9) { console.log(`  ✗ RECONSTRUCTION DOES NOT MATCH THE DEPLOYED LINE — STOP. Everything below would be measuring`); console.log(`    a different curve than the one the needs were measured on.`); process.exit(1); }
console.log(`  ✓ identical to the deployed raw line; the correction is applied to the real curve.`);

// ── measured needs per (policy, bar, tier), with the registered estimator ─────
interface Need { est: number; lo: number; hi: number; n: number }
const needBy = new Map<string, Need>();           // `${policy}|${bar}|${tier}`
for (const [key, rows] of rowsBy) {
  const rnd = rng(SEED);
  for (const win of QUICK) {
    const rs = rows.filter((r) => r.tier === win.tier);
    if (rs.length < 5) continue;
    const m = mmse(rs.map((r) => r.predK9), rs.map((r) => r.obs), rs.map((r) => r.nv));
    const boot: number[] = [];
    for (let b = 0; b < B; b++) {
      const s = rs.map(() => rs[Math.floor(rnd() * rs.length)]!);
      boot.push(slopeOf(s.map((r) => r.predK9), s.map((r) => r.obs)));
    }
    const fin = boot.filter(Number.isFinite);
    needBy.set(`${key}|${win.tier}`, { est: m.slope.est, lo: pct(fin, 0.025), hi: pct(fin, 0.975), n: rs.length });
  }
}

console.log(`\n── MEASURED NEEDS, re-measured per policy (the committed values are the cross-check) ──`);
console.log(`  policy   bar    ${QUICK.map((w) => w.tier.padStart(16)).join("")}`);
for (const policy of ["current", "armC"] as Policy[]) for (const bar of BARS) {
  const cells = QUICK.map((w) => { const nd = needBy.get(`${policy}|${bar}|${w.tier}`); return nd ? `${f(nd.est, 2)} (n=${nd.n})`.padStart(16) : "  — thin/absent".padStart(16); });
  console.log(`  ${policy.padEnd(8)} ${String(bar).padEnd(5)} ${cells.join("")}`);
}
console.log(`  committed @600 / @1000 : ${QUICK.map((w) => `${w.tier} ${COMMITTED[w.tier]![0]}/${COMMITTED[w.tier]![1] ?? "—"}`).join("  ")}`);

// ── the fit ──────────────────────────────────────────────────────────────────
interface Fit { A: number; r0: number; sse: number }
function fitHinge(rows: Row[], xOf: (s: Side, row: Row) => number, r0Grid: number[], aGrid: number[]): Fit {
  let best: Fit = { A: NaN, r0: NaN, sse: Infinity };
  for (const r0 of r0Grid) for (const A of aGrid) {
    let sse = 0;
    for (const row of rows) { const d = row.obs - corrK9(row, A, r0, xOf); sse += (d * d) / row.nv; }
    if (sse < best.sse) best = { A, r0, sse };
  }
  return best;
}
const linspace = (a: number, b: number, n: number) => Array.from({ length: n }, (_, i) => a + (b - a) * i / (n - 1));

/** Implied per-tier slope = slope of the CORRECTED prediction on the UNCORRECTED one (prereg §4) —
 *  the same quantity the ramp's `s` is, so it is directly comparable to a measured need. */
const impliedSlope = (rows: Row[], fit: Fit, xOf: (s: Side, row: Row) => number) =>
  slopeOf(rows.map((r) => r.predK9), rows.map((r) => corrK9(r, fit.A, fit.r0, xOf)));

const inCI = (v: number, nd: Need | undefined) => !!nd && v >= nd.lo && v <= nd.hi;

interface Variant { label: string; xOf: (s: Side, row: Row) => number; r0Grid: number[]; aGrid: number[] }
const rowsAll = (p: Policy, bar: number) => rowsBy.get(`${p}|${bar}`)!;
const stuLo = Math.min(...rowsAll("current", 600).flatMap((r) => r.sides.map((s) => s.r)));

for (const policy of ["current", "armC"] as Policy[]) {
  console.log(`\n\n════════ POLICY: ${policy === "current" ? "CURRENT COORDINATE (production, variant-free ref+pool)" : "ARM C COORDINATE (ref AND pool variant-inclusive — the ruled destination)"} ════════`);
  const fitRows = rowsAll(policy, 600);       // registered: fit at the primary bar, validate at both
  const VARIANTS: Variant[] = [
    { label: "PRIMARY  hinge on effective stuff", xOf: X_STU, r0Grid: linspace(stuLo, R0_MAX, 160), aGrid: linspace(-0.06, 0.06, 241) },
    { label: "ROBUST   hinge on training-support percentile", xOf: X_PCT, r0Grid: linspace(0.05, 50, 160), aGrid: linspace(-0.20, 0.20, 241) },
    { label: "NULL N2  hinge on PREDICTED K (not a rating)", xOf: X_PRED, r0Grid: linspace(2, 9, 160), aGrid: linspace(-0.60, 0.60, 241) },
  ];

  let primFit: Fit | null = null;
  for (const v of VARIANTS) {
    const fit = fitHinge(fitRows, v.xOf, v.r0Grid, v.aGrid);
    if (v.label.startsWith("PRIMARY")) primFit = fit;
    const pinnedLo = Math.abs(fit.r0 - v.r0Grid[0]!) < 1e-9, pinnedHi = Math.abs(fit.r0 - v.r0Grid[v.r0Grid.length - 1]!) < 1e-9;
    console.log(`\n── ${v.label} ──`);
    console.log(`   fitted  A = ${fit.A.toExponential(3)}   r0 = ${f(fit.r0, 2)}   weighted SSE ${f(fit.sse, 1)}`);
    console.log(`   sign: A ${fit.A < 0 ? "< 0 — AS PREDICTED (low-stuff true K below prediction)" : "> 0 — OPPOSITE to the prediction ⇒ REFUTATION per A1.5(8)"}`);
    if (pinnedLo || pinnedHi) console.log(`   ⚠ knot BOUNDARY-PINNED at the ${pinnedHi ? "UPPER" : "lower"} grid edge — standing rule: boundary-pinned optimum = family misfit`);
    if (v.xOf === X_STU && fit.r0 >= R0_MAX - 1e-9) console.log(`   ⚠ KILL CONDITION A1.5(7): knot at the training median ⇒ global slope wearing a hinge`);
    for (const bar of BARS) {
      const rows = rowsAll(policy, bar);
      const line = QUICK.map((w) => {
        const rs = rows.filter((r) => r.tier === w.tier);
        if (rs.length < 5) return "     thin";
        const imp = impliedSlope(rs, fit, v.xOf);
        const nd = needBy.get(`${policy}|${bar}|${w.tier}`);
        return `${f(imp, 2)}${inCI(imp, nd) ? "*" : " "}`.padStart(9);
      });
      const hits = QUICK.filter((w) => { const rs = rows.filter((r) => r.tier === w.tier); if (rs.length < 5) return false; return inCI(impliedSlope(rs, fit, v.xOf), needBy.get(`${policy}|${bar}|${w.tier}`)); }).length;
      console.log(`   implied @${String(bar).padEnd(4)} ${line.join("")}   (${hits} inside CI; * = inside)`);
    }
  }

  // ── P2: held-out gold ──────────────────────────────────────────────────────
  const heldRows = fitRows.filter((r) => r.tier !== "gold");
  const heldFit = fitHinge(heldRows, X_STU, linspace(stuLo, R0_MAX, 160), linspace(-0.06, 0.06, 241));
  console.log(`\n── P2 HELD-OUT GOLD (primary form, gold excluded from the fit entirely) ──`);
  console.log(`   fitted  A = ${heldFit.A.toExponential(3)}   r0 = ${f(heldFit.r0, 2)}`);
  for (const bar of BARS) {
    const gs = rowsAll(policy, bar).filter((r) => r.tier === "gold");
    const imp = impliedSlope(gs, heldFit, X_STU);
    const nd = needBy.get(`${policy}|${bar}|gold`);
    console.log(`   @${bar}: implied gold ${f(imp, 3)}   measured ${nd ? `${f(nd.est, 3)} [${f(nd.lo, 2)}, ${f(nd.hi, 2)}]` : "n/a"}   ${inCI(imp, nd) ? "INSIDE CI — P2 leg PASS" : "OUTSIDE CI — P2 leg FAIL"}`);
  }

  // ── P3: the differential (the PRIMARY fit, reused — not refitted) ──────────
  if (!primFit) throw new Error("primary fit missing");
  console.log(`\n── P3 THE DIFFERENTIAL (implied @1000 minus implied @600; measured beside it) ──`);
  console.log(`   tier      implied Δ    measured Δ`);
  for (const w of QUICK) {
    const a = rowsAll(policy, 600).filter((r) => r.tier === w.tier), b = rowsAll(policy, 1000).filter((r) => r.tier === w.tier);
    if (a.length < 5 || b.length < 5) { console.log(`   ${w.tier.padEnd(9)}      thin          thin`); continue; }
    const dImp = impliedSlope(b, primFit, X_STU) - impliedSlope(a, primFit, X_STU);
    const n6 = needBy.get(`${policy}|600|${w.tier}`), n10 = needBy.get(`${policy}|1000|${w.tier}`);
    console.log(`   ${w.tier.padEnd(9)}  ${f(dImp, 3).padStart(9)}     ${n6 && n10 ? f(n10.est - n6.est, 3).padStart(9) : "      n/a"}`);
  }

  // ── N1: the constant null ──────────────────────────────────────────────────
  let bestC = { c: NaN, sse: Infinity };
  for (const c of linspace(0.5, 1.5, 1001)) {
    let sse = 0;
    for (const row of fitRows) { const d = row.obs - row.predK9 * c; sse += (d * d) / row.nv; }
    if (sse < bestC.sse) bestC = { c, sse };
  }
  console.log(`\n── N1 CONSTANT NULL: c = ${f(bestC.c, 4)}, weighted SSE ${f(bestC.sse, 1)} (primary hinge SSE ${f(primFit.sse, 1)})`);
  console.log(`   a constant multiplies every prediction equally ⇒ implied slope = ${f(bestC.c, 3)} at EVERY tier, by construction.`);
}

console.log(`\n\n(end of centerpiece #2 fit — measurement only; nothing wired, no constants exported)`);
