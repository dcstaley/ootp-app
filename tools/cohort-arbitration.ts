// ITEM B, EMPIRICAL HALF — COHORT ARBITRATION.
//   run: node tools/cohort-arbitration.ts
//
// MEASUREMENT ONLY. Read-only: nothing is fitted, no constant, default or production behaviour is
// touched. Every quantity below is computed by CALLING the shared core (computeUnifiedFieldStats /
// buildPoolTransform / buildFrameShift / poolPitMeansOwn / calibrate / computeHitTail and the SHIPPED
// ramp functions kSpreadPitRamp + pitSpreadHrRamp at their SHIPPED constants). No scoring math here.
//
// ── THE PROBLEM BEING MEASURED ──────────────────────────────────────────────
// Every pool-level scaling quantity is computed over a TOP-N COHORT that computeUnifiedFieldStats
// selects BY THE MODEL'S OWN PREDICTED wOBA (it sorts on the same raw wOBA cardSideWobas returns).
// So the model picks the cohort that sets the transform that changes the model's predictions. The
// size of that cohort is FIELD_N = 50 (scoring-core/pool-stats.ts), cited as validated by
// tools/field-size.ts. Two things have never been measured:
//   §1 how much of each SHIPPED number is a consequence of choosing 50 rather than 25/100/200/full;
//   §2 how much the cohort MEMBERSHIP itself depends on the model doing the selecting.
// This is not hypothetical: a 2026-07-21 reading was retracted after the top-50 model-selected
// cohort was found to have SDs 24-45% larger than the full pool AND a different shape
// (fixtures/cwhit-battery-item5-heterogeneity-variantfix-2026-07-21.txt).
//
// ── LABELLING RULE (the one the retraction was about) ───────────────────────
// EVERY cohort statistic printed here states FULL-POOL or TOP-N. A "top-N" row at N = full IS the
// full pool (no selection survives), which is why the sweep carries that endpoint at all.
//
// VARIANT POLICY: production's CURRENT policy — the field/pool cohorts are selected from a
// VARIANT-FREE catalog. Arm C (variant-inclusive) is a separate ruled workstream and is not a
// variable here.

import { readFileSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import {
  makeRawPolyModel, computeUnifiedFieldStats, applyWobaWeights, computeDerived, calibrate,
  buildPoolTransform, buildFrameShift, poolPitMeansOwn, cardSideWobas, applyAffine, ratingStats,
  kSpreadPitRamp, pitSpreadHrRamp, K_SPREAD_PIT, PIT_SPREAD_HR,
  type EventForm, type FieldStats, type RatingEnvelope, type WobaWeights, type TrainingMeans,
  type PoolTransform, type RatingStats, type Coeffs, type Derived,
} from "../src/scoring-core/index.ts";
import { computeHitTail, PINNED_HIT_TAIL } from "../src/scoring-core/hit-tail.ts";
import { parseCatalogCsv } from "../src/data/catalog.ts";
import { buildEligiblePool } from "../src/config/eligibility.ts";
import { CWHIT_CORPUS } from "../src/eval/cwhit/corpus.ts";
import { QUICK, inValueWindow, isPit, FIELD_N, n_ } from "../src/eval/cwhit/sample.ts";
import { ANCHOR_N } from "../src/scoring-core/calibrate.ts";

const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const sgn = (x: number, d = 2) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}` : "n/a");
const P = (x: number, w: number, d = 2) => f(x, d).padStart(w);
const S = (x: number, w: number, d = 2) => sgn(x, d).padStart(w);

// ── deployed model + neutral env (bootstrap COPIED VERBATIM from tools/battery-gap-profiles.ts) ──
const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state = (await repo.load<{ activeModelId?: string; catalogSourceId?: string }>("state", "app")) ?? {};
type TM_ = { id: string; eventForm?: EventForm; wobaWeights?: WobaWeights; ratingEnvelope?: RatingEnvelope; trainingMeans?: TrainingMeans; platoon?: unknown };
const trained = (await repo.loadAll<TM_>("trained-models")).find((x) => x.id === state.activeModelId);
if (!trained?.eventForm || !trained.wobaWeights) throw new Error("active model missing eventForm/wobaWeights");
if (!trained.trainingMeans) throw new Error("active model has NO trainingMeans — the gap convention needs the artifact frame");
const TM = trained.trainingMeans;
const rp = makeRawPolyModel(trained.eventForm);
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const tournaments = await repo.loadAll<Tournament>("tournaments");
const bq = tournaments.find((t) => t.id === "bronze-quick")!;
const coeffsFor = (t: Tournament): Coeffs => {
  const c = resolveCoeffs(model, eras.get(t.eraId)!, parks.get(t.parkId)!, t.softcaps);
  applyWobaWeights(c, trained.wobaWeights!);
  return c;
};
const coeffs = coeffsFor(bq);            // the neutral Quick-ladder env
const derived = computeDerived(coeffs);
const srcId = state.catalogSourceId ?? "cdmx";
const baseCards = parseCatalogCsv(readFileSync(`data/imports/${srcId}.csv`, "utf8")).cards
  .filter((c) => String(c["Variant"] ?? "").toUpperCase() !== "Y");
const envelope = trained.ratingEnvelope;

// ── channels + their catalog columns (the ONE mapping used for every raw-rating read here) ──
const HIT_CH = ["eye", "pow", "kRat", "babip", "gap"] as const;
const PIT_CH = ["con", "stu", "pbabip", "hrr"] as const;
const HIT_COL: Record<string, string> = { eye: "Eye", pow: "Power", kRat: "Avoid K", babip: "BABIP", gap: "Gap" };
const PIT_COL: Record<string, string> = { con: "Control", stu: "Stuff", pbabip: "pBABIP", hrr: "pHR" };

// The N sweep. `full` = no selection survives (cohort == the whole pool) — the honest endpoint of
// "how much does the top-N choice matter", and the only row that is a FULL-POOL statistic.
const FULL = 1e9;
const N_GRID: { label: string; n: number }[] = [
  { label: "25", n: 25 }, { label: "50*", n: 50 }, { label: "100", n: 100 }, { label: "200", n: 200 }, { label: "full", n: FULL },
];
const BASE_I = 1; // index of the production N=50 row — every delta is against this

// Reference ("league") field = top-N of the FULL variant-free catalog. It moves with N too, because
// production builds the transform from ref@FIELD_N and pool@FIELD_N — so the counterfactual "what if
// FIELD_N were X" must move BOTH ends, or it would be a different question.
const refCache = new Map<string, FieldStats>();
const refAt = (n: number, cf: Coeffs, key: string): FieldStats => {
  const ck = `${key}|${n}`;
  let r = refCache.get(ck);
  if (!r) { r = computeUnifiedFieldStats(baseCards, cf, rp, n, true); refCache.set(ck, r); }
  return r;
};

interface Row {
  label: string; n: number; cohort: number;
  hitMu: Record<string, number>; hitSd: Record<string, number>;
  pitMu: Record<string, number>; pitSd: Record<string, number>;
  k: Record<string, number>;
  gStu: number; gHrr: number; gKRat: number; gPow: number;
  sK: number; sHr: number; kbar: number; hrbar: number;
  lwHr: number; lwBab: number; lwSo: number;
  hitScaleVR: number; hitScaleVL: number; pitchScale: number;
  anchVR: number; anchVL: number; anchPit: number;
}

/** One format's full N sweep. Everything is computed through the shared core at each N. */
function sweep(pool: any[], cf: Coeffs, dv: Derived, refKey: string): Row[] {
  const hitPool = pool.filter((c) => !isPit(c));
  return N_GRID.map(({ label, n }) => {
    const ref = refAt(n, cf, refKey);
    const pf = computeUnifiedFieldStats(pool, cf, rp, n, true);            // TOP-N cohort (n=full ⇒ FULL POOL)
    const pt = buildPoolTransform(ref, pf, envelope);
    const fs = buildFrameShift(TM, pf);
    const gStu = fs.pit.vR.stu ?? 0, gHrr = fs.pit.vR.hrr ?? 0;
    const gKRat = fs.hit.vR.kRat ?? 0, gPow = fs.hit.vR.pow ?? 0;
    const pm = poolPitMeansOwn(pool, cf, rp, pt, n);
    const ht = computeHitTail(hitPool, cf, rp, pt, ref, pf, PINNED_HIT_TAIL);
    const sK = kSpreadPitRamp(gStu), sHr = pitSpreadHrRamp(gHrr);
    // calibrate() sees the SHIPPED kSpread built at this N (production wires exactly this object).
    // NOTE its own anchor cohort is ANCHOR_N = 50 and is NOT a parameter — see the §1 note.
    const cal = calibrate(pool, {
      coeffs: cf, derived: dv, eventForm: trained!.eventForm, poolTransform: pt, hitTail: ht,
      kSpread: { sHit: 1, meanHit: 0, sPit: sK, meanPit: pm.k, sPitHr: sHr, meanPitHr: pm.hr },
    });
    const hitMu: Record<string, number> = {}, hitSd: Record<string, number> = {};
    const pitMu: Record<string, number> = {}, pitSd: Record<string, number> = {};
    const k: Record<string, number> = {};
    for (const c of HIT_CH) { hitMu[c] = pf.hit.vR[c]?.mu ?? NaN; hitSd[c] = pf.hit.vR[c]?.sd ?? NaN; k[`h.${c}`] = pt.hit.vR[c]?.k ?? NaN; }
    for (const c of PIT_CH) { pitMu[c] = pf.pit.vR[c]?.mu ?? NaN; pitSd[c] = pf.pit.vR[c]?.sd ?? NaN; k[`p.${c}`] = pt.pit.vR[c]?.k ?? NaN; }
    return {
      label, n, cohort: Math.min(n, pool.length), hitMu, hitSd, pitMu, pitSd, k,
      gStu, gHrr, gKRat, gPow, sK, sHr, kbar: pm.k, hrbar: pm.hr,
      lwHr: ht.hr.lw, lwBab: ht.bab.lw, lwSo: ht.so.lw,
      hitScaleVR: cal.hitScaleVR ?? 1, hitScaleVL: cal.hitScaleVL ?? 1, pitchScale: cal.pitchScale ?? 1,
      anchVR: cal.anchorMeanVR ?? 0, anchVL: cal.anchorMeanVL ?? 0, anchPit: cal.anchorMeanPitch ?? 0,
    };
  });
}

// ── the formats ─────────────────────────────────────────────────────────────
interface Fmt { name: string; pool: any[]; cf: Coeffs; dv: Derived; refKey: string; note: string }
const formats: Fmt[] = [];
for (const w of QUICK)
  formats.push({ name: w.tier, pool: baseCards.filter((c) => inValueWindow(c, w)), cf: coeffs, dv: derived, refKey: "neutral", note: `VAL<=${w.valueMax}, neutral env` });
// The four dailies the registry knows with a legacy fixture slug (bronzeheart / earlygold /
// diamondcapdaily / goldcapdaily). Each carries its OWN era/park, so it is resolved and scored under
// its own coeffs — scoring them under the neutral bag would be wrong, not merely imprecise.
const DAILIES = CWHIT_CORPUS.filter((x) => x.type === "Daily" && x.legacySlug && x.tournamentId);
for (const d of DAILIES) {
  const t = tournaments.find((x) => x.id === d.tournamentId);
  if (!t) { console.log(`(daily "${d.key}" has no tournament config ${d.tournamentId} — skipped)`); continue; }
  const cf = coeffsFor(t);
  formats.push({ name: d.key, pool: buildEligiblePool(baseCards as any, t) as any[], cf, dv: computeDerived(cf), refKey: t.id, note: `${t.name} (era ${t.eraId} / park ${t.parkId})` });
}

console.log(`
╔═══ ITEM B — COHORT ARBITRATION (empirical half): how much of the shipped number is the choice of 50? ═══╗`);
console.log(`model '${trained.id}' | catalog '${srcId}' | production FIELD_N = ${FIELD_N} | calibrate ANCHOR_N = ${ANCHOR_N}`);
console.log(`variant policy: PRODUCTION CURRENT — cohorts selected from a VARIANT-FREE catalog (${baseCards.length} cards). Arm C is not a variable here.`);
console.log(`shipped ramp constants (NOT refitted): K_SPREAD_PIT = {A ${K_SPREAD_PIT.A}, q ${K_SPREAD_PIT.q}, gMax ${K_SPREAD_PIT.gMax}} | PIT_SPREAD_HR = {A ${PIT_SPREAD_HR.A}, G ${PIT_SPREAD_HR.G}}`);
console.log(`N sweep = ${N_GRID.map((x) => x.label).join(", ")} ("full" ⇒ NO selection survives: the cohort IS the pool). Both ENDS move: ref (league) and pool fields are BOTH taken at N.`);
console.log(`EVERY cohort statistic below is a TOP-N statistic except the "full" row, which is the FULL POOL.`);

// ═══════════════════════════════════════════════════════════════════════════
// §1 — COHORT-SIZE SENSITIVITY
// ═══════════════════════════════════════════════════════════════════════════
console.log(`
════ §1 COHORT-SIZE SENSITIVITY ════
The N=50* row is production. Every Δ row is (that N) − (N=50).
ANCHOR_N is NOT swept: calibrate() takes no cohort-size parameter, so varying it would mean editing a
production constant. It is a DIFFERENT constant that happens to share the value 50; the anchor cohort
below is always 50, and only the FIELD cohort (which sets the transform + gaps calibrate consumes) moves.`);

const results: { fmt: Fmt; rows: Row[] }[] = [];
for (const fmt of formats) {
  const rows = sweep(fmt.pool, fmt.cf, fmt.dv, fmt.refKey);
  results.push({ fmt, rows });
  const b = rows[BASE_I]!;
  console.log(`
── ${fmt.name.toUpperCase()} — pool ${fmt.pool.length} cards (${fmt.note}) ──`);

  console.log(`  TOP-N FIELD MEANS (rating space; "full" row = FULL-POOL means)`);
  console.log(`  N     cohort │ HIT ${HIT_CH.map((c) => c.padStart(7)).join(" ")} │ PIT ${PIT_CH.map((c) => c.padStart(7)).join(" ")}`);
  for (const r of rows)
    console.log(`  ${r.label.padEnd(5)} ${String(r.cohort).padStart(6)} │     ${HIT_CH.map((c) => P(r.hitMu[c]!, 7)).join(" ")} │     ${PIT_CH.map((c) => P(r.pitMu[c]!, 7)).join(" ")}`);
  console.log(`  Δ(25−50)     │     ${HIT_CH.map((c) => S(rows[0]!.hitMu[c]! - b.hitMu[c]!, 7)).join(" ")} │     ${PIT_CH.map((c) => S(rows[0]!.pitMu[c]! - b.pitMu[c]!, 7)).join(" ")}`);
  console.log(`  Δ(full−50)   │     ${HIT_CH.map((c) => S(rows[4]!.hitMu[c]! - b.hitMu[c]!, 7)).join(" ")} │     ${PIT_CH.map((c) => S(rows[4]!.pitMu[c]! - b.pitMu[c]!, 7)).join(" ")}`);

  console.log(`  TOP-N FIELD SDs (a MODEL-SELECTED cohort's dispersion — NOT the pool's, except the "full" row)`);
  console.log(`  N            │ HIT ${HIT_CH.map((c) => c.padStart(7)).join(" ")} │ PIT ${PIT_CH.map((c) => c.padStart(7)).join(" ")}`);
  for (const r of rows)
    console.log(`  ${r.label.padEnd(12)} │     ${HIT_CH.map((c) => P(r.hitSd[c]!, 7)).join(" ")} │     ${PIT_CH.map((c) => P(r.pitSd[c]!, 7)).join(" ")}`);

  const KEYS = [...HIT_CH.map((c) => `h.${c}`), ...PIT_CH.map((c) => `p.${c}`)];
  console.log(`  POOL-TRANSFORM k (= refMean/poolMean per channel; the affine's lift scalar)`);
  console.log(`  N            │ ${KEYS.map((c) => c.padStart(8)).join(" ")}`);
  for (const r of rows) console.log(`  ${r.label.padEnd(12)} │ ${KEYS.map((c) => P(r.k[c]!, 8, 4)).join(" ")}`);
  console.log(`  Δ(full−50)   │ ${KEYS.map((c) => S(rows[4]!.k[c]! - b.k[c]!, 8, 4)).join(" ")}`);

  console.log(`  THE SHIPPED NUMBERS AT EACH N (gaps → the shipped ramps → the centering means → calibrate)`);
  console.log(`  N            │ gap.pit.stu    s_K  gap.pit.hrr   s_HR │     K̄_pool    HR̄_pool │ gap.hit.kRat gap.hit.pow │  lw.HR lw.BAB  lw.SO │  hitSclVR  hitSclVL pitchScl │  anchVR  anchVL anchPit`);
  for (const r of rows)
    console.log(`  ${r.label.padEnd(12)} │ ${P(r.gStu, 11)} ${P(r.sK, 6, 3)} ${P(r.gHrr, 12)} ${P(r.sHr, 6, 3)} │ ${P(r.kbar, 10, 3)} ${P(r.hrbar, 10, 3)} │ ${P(r.gKRat, 12)} ${P(r.gPow, 11)} │ ${P(r.lwHr, 6, 3)} ${P(r.lwBab, 6, 3)} ${P(r.lwSo, 6, 3)} │ ${P(r.hitScaleVR, 9, 4)} ${P(r.hitScaleVL, 9, 4)} ${P(r.pitchScale, 8, 4)} │ ${P(r.anchVR, 7, 4)} ${P(r.anchVL, 7, 4)} ${P(r.anchPit, 7, 4)}`);
  for (const i of [0, 2, 3, 4]) {
    const r = rows[i]!;
    console.log(`  Δ(${r.label}−50)${" ".repeat(Math.max(0, 6 - r.label.length))} │ ${S(r.gStu - b.gStu, 11)} ${S(r.sK - b.sK, 6, 3)} ${S(r.gHrr - b.gHrr, 12)} ${S(r.sHr - b.sHr, 6, 3)} │ ${S(r.kbar - b.kbar, 10, 3)} ${S(r.hrbar - b.hrbar, 10, 3)} │ ${S(r.gKRat - b.gKRat, 12)} ${S(r.gPow - b.gPow, 11)} │ ${S(r.lwHr - b.lwHr, 6, 3)} ${S(r.lwBab - b.lwBab, 6, 3)} ${S(r.lwSo - b.lwSo, 6, 3)} │ ${S(r.hitScaleVR - b.hitScaleVR, 9, 4)} ${S(r.hitScaleVL - b.hitScaleVL, 9, 4)} ${S(r.pitchScale - b.pitchScale, 8, 4)} │ ${S(r.anchVR - b.anchVR, 7, 4)} ${S(r.anchVL - b.anchVL, 7, 4)} ${S(r.anchPit - b.anchPit, 7, 4)}`);
  }
}

// ── the cross-format headline: relative sensitivity of each shipped quantity ──
console.log(`
── §1 HEADLINE — each shipped quantity's SPREAD over the N sweep, as % of its value at N=50 ──
(range = max−min over N ∈ {25,50,100,200,full}, divided by |value at 50|. "s_K−1" and "s_HR−1" are shown
 because 1 is the identity: a 3% move in s_K is a much larger move in the CORRECTION it applies.)`);
console.log(`format          │ gap.stu   s_K−1 │ gap.hrr  s_HR−1 │    K̄     HR̄ │ lw.HR  lw.SO │ hitSclVR pitchScl`);
const rel = (xs: number[], base: number) => {
  const lo = Math.min(...xs), hi = Math.max(...xs);
  return Math.abs(base) > 1e-12 ? (100 * (hi - lo)) / Math.abs(base) : NaN;
};
const headline = (rowsOf: (rs: Row[]) => Row[]) => {
  for (const { fmt, rows } of results) {
    const b = rows[BASE_I]!, rs = rowsOf(rows);
    const c = (pick: (r: Row) => number, base: number) => rel(rs.map(pick), base);
    console.log(`${fmt.name.padEnd(15)} │ ${P(c((r) => r.gStu, b.gStu), 7, 1)}% ${P(c((r) => r.sK - 1, b.sK - 1), 6, 1)}% │ ${P(c((r) => r.gHrr, b.gHrr), 7, 1)}% ${P(c((r) => r.sHr - 1, b.sHr - 1), 6, 1)}% │ ${P(c((r) => r.kbar, b.kbar), 5, 1)}% ${P(c((r) => r.hrbar, b.hrbar), 5, 1)}% │ ${P(c((r) => r.lwHr, b.lwHr), 5, 1)}% ${P(c((r) => r.lwSo, b.lwSo), 5, 1)}% │ ${P(c((r) => r.hitScaleVR, b.hitScaleVR), 8, 1)}% ${P(c((r) => r.pitchScale, b.pitchScale), 7, 1)}%`);
  }
};
headline((rs) => rs);

// The `full` endpoint is a DEGENERATE cohort (no selection at all) and dominates the ranges above.
// The decision actually on the table is 25 / 50 / 100 / 200 — a plausible field size — so the same
// spread is repeated over that restricted set. This second table is the one that answers "how much of
// the shipped number is a consequence of choosing 50 rather than another DEFENSIBLE size?".
console.log(`
── §1 HEADLINE (RESTRICTED) — same spread over N ∈ {25, 50, 100, 200} only (the "full" endpoint dropped) ──`);
console.log(`format          │ gap.stu   s_K−1 │ gap.hrr  s_HR−1 │    K̄     HR̄ │ lw.HR  lw.SO │ hitSclVR pitchScl`);
headline((rs) => rs.slice(0, 4));

// ═══════════════════════════════════════════════════════════════════════════
// §2 — THE FEEDBACK ITSELF (membership instability at N = 50)
// ═══════════════════════════════════════════════════════════════════════════
//
// Production selects the cohort BY the model's predicted wOBA, and the transform built from that
// cohort then CHANGES the model's predictions. Two counterfactual selection criteria at the SAME
// size (50), each answering a different question:
//   (a) MODEL-FREE ranking — the equal-weight sum of the role's own raw rating channels on the
//       deployment side (hit: Eye+Power+Avoid K+BABIP+Gap; pit: Control+Stuff+pBABIP+pHR summed over
//       BOTH sides, matching production's combined-wOBA pitcher convention). Defensible because it
//       ranks the SAME cards on the SAME inputs the model consumes, with no model, no curve and no
//       weighting — i.e. it removes exactly the model's contribution to the ranking and nothing else.
//       All OOTP ratings are higher-is-better, so the sum is a valid quality order without sign work.
//       (Card VAL is deliberately NOT used: it is a game-economy quantity and never enters modelling.)
//   (b) ONE ITERATION OF THE LOOP — predicted wOBA recomputed AFTER applying the pool transform built
//       from the production cohort. This is the DIRECT measure of the feedback: if one iteration
//       barely moves the answer, the loop is effectively converged.
// In BOTH cases the cohort MOMENTS are taken over the members' RAW ratings — the same convention
// production uses — so only the SELECTION differs.

type Cohorts = { hVR: any[]; hVL: any[]; pit: any[] };
interface Goodness { hitVR: number; hitVL: number; pit: number } // higher = better in all three

const byWoba = (cf: Coeffs) => (c: any): Goodness => {
  const w = cardSideWobas(c, cf, rp, true);
  return { hitVR: w.hitVR, hitVL: w.hitVL, pit: -(w.pitVR + w.pitVL) }; // pitcher: LOWER allowed wOBA is better
};
const byRating = (c: any): Goodness => ({
  hitVR: HIT_CH.reduce((s, k) => s + n_(c[`${HIT_COL[k]} vR`]), 0),
  hitVL: HIT_CH.reduce((s, k) => s + n_(c[`${HIT_COL[k]} vL`]), 0),
  pit: PIT_CH.reduce((s, k) => s + n_(c[`${PIT_COL[k]} vR`]) + n_(c[`${PIT_COL[k]} vL`]), 0),
});

/** Select the three production cohorts under an arbitrary goodness function (ties keep pool order). */
function cohortsBy(pool: any[], g: (c: any) => Goodness, topN: number): Cohorts {
  const scored = pool.map((c) => ({ c, g: g(c) }));
  const top = (key: keyof Goodness) => [...scored].sort((a, b) => b.g[key] - a.g[key]).slice(0, topN).map((x) => x.c);
  return { hVR: top("hitVR"), hVL: top("hitVL"), pit: top("pit") };
}

/** Field moments over a given MEMBERSHIP, always on RAW ratings, pooled exactly as
 *  computeUnifiedFieldStats pools them (hitters: each per-side cohort contributes its DEPLOYMENT-side
 *  values; pitchers: one combined cohort contributing BOTH sides). Verified identical to the core on
 *  the production criterion below — that assertion is what licenses using it for the alternatives. */
function fieldFromCohorts(co: Cohorts): FieldStats {
  const hit: Record<string, RatingStats> = {}, pit: Record<string, RatingStats> = {};
  for (const k of HIT_CH)
    hit[k] = ratingStats([...co.hVR.map((c) => n_(c[`${HIT_COL[k]} vR`])), ...co.hVL.map((c) => n_(c[`${HIT_COL[k]} vL`]))]);
  for (const k of PIT_CH)
    pit[k] = ratingStats(co.pit.flatMap((c) => [n_(c[`${PIT_COL[k]} vR`]), n_(c[`${PIT_COL[k]} vL`])]));
  return { hit: { vR: hit, vL: hit }, pit: { vR: pit, vL: pit } };
}

/** Transformed COPY of a card: the pool transform applied to its rating columns, everything else
 *  untouched. Feeding this to cardSideWobas is one iteration of the selection loop. */
function transformedCard(c: any, pt: PoolTransform): any {
  const t: any = { ...c };
  for (const k of HIT_CH) for (const s of ["vR", "vL"] as const) t[`${HIT_COL[k]} ${s}`] = applyAffine(n_(c[`${HIT_COL[k]} ${s}`]), pt.hit[s][k]);
  for (const k of PIT_CH) for (const s of ["vR", "vL"] as const) t[`${PIT_COL[k]} ${s}`] = applyAffine(n_(c[`${PIT_COL[k]} ${s}`]), pt.pit[s][k]);
  return t;
}

const overlap = (a: any[], b: any[]) => {
  const s = new Set(a.map((c) => String(c["Card ID"])));
  return b.filter((c) => s.has(String(c["Card ID"]))).length;
};

console.log(`
════ §2 THE FEEDBACK ITSELF — cohort MEMBERSHIP instability at N = 50 ════
overlap = how many of the 50 selected cards are the SAME as production's model-selected cohort.
gaps/ramps are recomputed from each alternative cohort's RAW-rating moments (only the SELECTION differs).`);

console.log(`
format          │ criterion        │ ovl.hVR ovl.hVL ovl.pit │ gap.pit.stu     Δ    s_K     Δ │ gap.pit.hrr     Δ   s_HR     Δ`);
let checkWorst = 0;
for (const { fmt } of results) {
  const g0 = byWoba(fmt.cf);
  const prod = cohortsBy(fmt.pool, g0, FIELD_N);

  // SELF-CHECK: the reconstruction must reproduce the core EXACTLY on the production criterion.
  const core = computeUnifiedFieldStats(fmt.pool, fmt.cf, rp, FIELD_N, true);
  const mine = fieldFromCohorts(prod);
  for (const k of HIT_CH) { checkWorst = Math.max(checkWorst, Math.abs(core.hit.vR[k]!.mu - mine.hit.vR[k]!.mu), Math.abs(core.hit.vR[k]!.sd - mine.hit.vR[k]!.sd)); }
  for (const k of PIT_CH) { checkWorst = Math.max(checkWorst, Math.abs(core.pit.vR[k]!.mu - mine.pit.vR[k]!.mu), Math.abs(core.pit.vR[k]!.sd - mine.pit.vR[k]!.sd)); }

  const ptProd = buildPoolTransform(refAt(FIELD_N, fmt.cf, fmt.refKey), core, envelope);
  const tCards = new Map(fmt.pool.map((c) => [c, transformedCard(c, ptProd)]));
  const gIter = (c: any): Goodness => g0(tCards.get(c)!);

  const b = buildFrameShift(TM, core);
  const bStu = b.pit.vR.stu ?? 0, bHrr = b.pit.vR.hrr ?? 0;
  const alts: [string, Cohorts][] = [
    ["(a) raw-rating rank", cohortsBy(fmt.pool, byRating, FIELD_N)],
    ["(b) 1 iteration", cohortsBy(fmt.pool, gIter, FIELD_N)],
  ];
  console.log(`${fmt.name.padEnd(15)} │ production       │      50      50      50 │ ${P(bStu, 11)}     — ${P(kSpreadPitRamp(bStu), 6, 3)}     — │ ${P(bHrr, 11)}     — ${P(pitSpreadHrRamp(bHrr), 6, 3)}     —`);
  for (const [name, co] of alts) {
    const fsA = buildFrameShift(TM, fieldFromCohorts(co));
    const aStu = fsA.pit.vR.stu ?? 0, aHrr = fsA.pit.vR.hrr ?? 0;
    console.log(`${"".padEnd(15)} │ ${name.padEnd(16)} │ ${String(overlap(prod.hVR, co.hVR)).padStart(7)} ${String(overlap(prod.hVL, co.hVL)).padStart(7)} ${String(overlap(prod.pit, co.pit)).padStart(7)} │ ${P(aStu, 11)} ${S(aStu - bStu, 5, 2)} ${P(kSpreadPitRamp(aStu), 6, 3)} ${S(kSpreadPitRamp(aStu) - kSpreadPitRamp(bStu), 5, 3)} │ ${P(aHrr, 11)} ${S(aHrr - bHrr, 5, 2)} ${P(pitSpreadHrRamp(aHrr), 6, 3)} ${S(pitSpreadHrRamp(aHrr) - pitSpreadHrRamp(bHrr), 5, 3)}`);
  }
}
console.log(`
SELF-CHECK (licenses §2's reconstruction): worst |Δ| between fieldFromCohorts(production membership)
and computeUnifiedFieldStats over every format × channel × {μ, σ} = ${checkWorst.toExponential(3)} (must be 0).`);

console.log(`
(end of cohort-arbitration run)`);
