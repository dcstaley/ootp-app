// GOLD CATALOG CHECK — is gold's model-selected pitcher TOP unusually stuff-poor / secondary-heavy?
//   run: node tools/battery-gold-catalog-stu.ts
//
// THE HYPOTHESIS UNDER TEST (Derek, recorded, pre-registered): the current best gold pitchers are
// LOW-STUFF with heavy secondary ratings. Usage tracks quality normally in every tier, but the
// QUALITY–STUFF CORRELATION FLIPS SIGN inside gold's pool — so gold's realized set samples the stuff
// axis unusually WITHOUT any tier-identity term. If true, the mechanism is a catalog property and is
// therefore visible EX ANTE, from ratings alone, with no usage and no observed data.
//
// WHY THE CONDITIONAL TOP AND NOT POOL MOMENTS. Full-pool moments are blind to this by construction:
// the claim is about WHICH cards the model ranks first, not about the pool's marginal distribution.
// The mirror-image error is also live — on 2026-07-21 a top-50 MODEL-SELECTED cohort's dispersion was
// quoted as if it were the pool's, and had to be retracted (see tools/battery-gap-profiles.ts §top-N
// dispersion). So EVERY number below is labelled with which view it belongs to: FULL POOL or TOP-K.
//
// PREDICTED VALUE = the DEPLOYED field-selection basis, not a proxy: `cardSideWobas` from
// src/scoring-core/pool-stats.ts, sspFree=true — literally the quantity `computeUnifiedFieldStats`
// sorts on to pick the top-N field (raw predicted allowed wOBA, no transform, no calibration, env-free).
// Sign-flipped to D2's pitcher convention so higher = better:  value = −(pitVR + pitVL)/2.
// No scoring math is defined in this file; it only consumes the core.
//
// CAVEATS THAT TRAVEL WITH EVERY NUMBER:
//  · The five pools are NESTED by card value (iron ⊂ bronze ⊂ silver ⊂ gold ⊂ diamond). Cross-tier
//    contrasts are NOT independent samples; gold's pool literally contains silver's.
//  · RATING SPACE / CATALOG ONLY. This says nothing about what actually gets played — no usage, no
//    observed lines, no cwhit tables are read anywhere in this tool.
//
// DESCRIPTIVE. Nothing is fitted, nothing is changed, no default moves.

import { readFileSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import {
  makeRawPolyModel, applyWobaWeights, computeDerived, cardSideWobas,
  type EventForm, type RatingEnvelope, type WobaWeights, type TrainingMeans,
} from "../src/scoring-core/index.ts";
import { parseCatalogCsv, type Card } from "../src/data/catalog.ts";
import { pearson } from "../src/eval/cwhit/scorecard.ts";
import { QUICK, inValueWindow, isPit, n_ } from "../src/eval/cwhit/sample.ts";

// ── deployed model + neutral env (deps + coeffs construction copied from tools/battery-gap-profiles.ts) ──
const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state = (await repo.load<{ activeModelId?: string; catalogSourceId?: string }>("state", "app")) ?? {};
type TM_ = { id: string; eventForm?: EventForm; wobaWeights?: WobaWeights; ratingEnvelope?: RatingEnvelope; trainingMeans?: TrainingMeans };
const trained = (await repo.loadAll<TM_>("trained-models")).find((x) => x.id === state.activeModelId);
if (!trained?.eventForm || !trained.wobaWeights) throw new Error("active model missing eventForm/wobaWeights");
const rp = makeRawPolyModel(trained.eventForm);
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const tournaments = await repo.loadAll<Tournament>("tournaments");
const bq = tournaments.find((t) => t.id === "bronze-quick")!;
const coeffs = resolveCoeffs(model, eras.get(bq.eraId)!, parks.get(bq.parkId)!, bq.softcaps);
applyWobaWeights(coeffs, trained.wobaWeights);
computeDerived(coeffs); // same coeff finalisation the other battery tools run
const srcId = state.catalogSourceId ?? "cdmx";
const baseCards = parseCatalogCsv(readFileSync(`data/imports/${srcId}.csv`, "utf8")).cards
  .filter((c) => String(c["Variant"] ?? "").toUpperCase() !== "Y");

// ── helpers (presentation only) ──────────────────────────────────────────────
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const sd = (xs: number[]) => {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
};
const F = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d).padStart(6) : "   n/a");
const S = (x: number, d = 2) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}`.padStart(6) : "   n/a");

/** The four pitcher rating channels, vR side, as the task names them. */
const CH = [
  { key: "stu", col: "Stuff vR" },
  { key: "con", col: "Control vR" },
  { key: "hrr", col: "pHR vR" },
  { key: "bab", col: "pBABIP vR" },
] as const;

interface P { v: number; r: Record<string, number> }

/** PREDICTED VALUE — deployed selection basis, D2 pitcher sign (higher = better). */
const predValue = (c: Card): number => {
  const w = cardSideWobas(c, coeffs, rp, true);
  return -(w.pitVR + w.pitVL) / 2;
};

console.log(`
╔═══ GOLD CATALOG CHECK — pitcher stuff axis in the MODEL-SELECTED TOP (rating space, ex ante) ═══╗`);
console.log(`model '${trained.id}' | catalog '${srcId}' | base cards only (no v5 variants), pitchers only`);
console.log(`predicted value = −(raw predicted allowed wOBA vR + vL)/2 via cardSideWobas(sspFree=true) —`);
console.log(`  the EXACT quantity computeUnifiedFieldStats sorts on to select the top-N field. Higher = better.`);
console.log(`ratings are the vR side, RAW catalog values (no pool transform, no frame shift, no calibration).`);
console.log(`NOTE the pools are NESTED (iron ⊂ bronze ⊂ silver ⊂ gold ⊂ diamond) — tier rows are NOT independent.`);
console.log(`NOTE rating space / catalog only. NO usage, NO observed data, NO cwhit tables are read here.`);

interface Row {
  tier: string; n: number;
  poolMu: Record<string, number>; poolSd: Record<string, number>;
  topMu: Record<number, Record<string, number>>; topSd: Record<number, Record<string, number>>;
  corrPool: Record<string, number>; corrTop100: Record<string, number>;
  n100: number;
}
const rows: Row[] = [];

for (const win of QUICK) {
  const pool: P[] = baseCards
    .filter((c) => inValueWindow(c, win) && isPit(c))
    .map((c) => {
      const r: Record<string, number> = {};
      for (const ch of CH) r[ch.key] = n_(c[ch.col]);
      return { v: predValue(c), r };
    });
  const sorted = [...pool].sort((a, b) => b.v - a.v); // best predicted value first

  const poolMu: Record<string, number> = {}, poolSd: Record<string, number> = {};
  const corrPool: Record<string, number> = {}, corrTop100: Record<string, number> = {};
  const topMu: Record<number, Record<string, number>> = {}, topSd: Record<number, Record<string, number>> = {};
  const top100 = sorted.slice(0, 100);

  for (const ch of CH) {
    const xs = pool.map((p) => p.r[ch.key]!);
    poolMu[ch.key] = mean(xs); poolSd[ch.key] = sd(xs);
    corrPool[ch.key] = pearson(pool.map((p) => p.v), xs);
    corrTop100[ch.key] = pearson(top100.map((p) => p.v), top100.map((p) => p.r[ch.key]!));
  }
  for (const K of [25, 50, 100]) {
    const t = sorted.slice(0, K);
    topMu[K] = {}; topSd[K] = {};
    for (const ch of CH) { topMu[K]![ch.key] = mean(t.map((p) => p.r[ch.key]!)); topSd[K]![ch.key] = sd(t.map((p) => p.r[ch.key]!)); }
  }
  rows.push({ tier: win.tier, n: pool.length, poolMu, poolSd, topMu, topSd, corrPool, corrTop100, n100: top100.length });
}

// ── §1 COMPOSITION: full pool vs the conditional top ─────────────────────────
console.log(`
── §1 COMPOSITION — mean (SD) of the vR pitcher ratings ──`);
console.log(`   VIEW LABELS: "FULL POOL" = every eligible pitcher card in the value window.`);
console.log(`                "TOP K"     = the K best by PREDICTED VALUE — a MODEL-SELECTED cohort, not the pool.`);
for (const r of rows) {
  console.log(`
${r.tier}  (pitchers in pool: ${r.n})`);
  console.log(`   view        │ ${CH.map((c) => `${c.col}`.padStart(15)).join(" ")}`);
  const line = (label: string, mu: Record<string, number>, s: Record<string, number>) =>
    console.log(`   ${label.padEnd(11)} │ ${CH.map((c) => `${F(mu[c.key]!, 1)} (${F(s[c.key]!, 1).trim()})`.padStart(15)).join(" ")}`);
  line("FULL POOL", r.poolMu, r.poolSd);
  for (const K of [25, 50, 100]) line(`TOP ${K}`, r.topMu[K]!, r.topSd[K]!);
}

// ── §2 THE HEADLINE: corr(predicted value, Stuff vR) ─────────────────────────
console.log(`
── §2 HEADLINE — correlation between PREDICTED VALUE and Stuff vR ──`);
console.log(`   The hypothesis predicts: POSITIVE at other tiers, near-zero-or-NEGATIVE at gold.`);
console.log(`   Two views. FULL POOL = over every eligible pitcher. TOP-100 = WITHIN the model-selected top 100.`);
console.log(`tier      │ poolN │  corr(value, stu) FULL POOL │  corr(value, stu) WITHIN TOP-100 (n)`);
for (const r of rows)
  console.log(`${r.tier.padEnd(9)} │ ${String(r.n).padStart(5)} │ ${S(r.corrPool["stu"]!, 3).padStart(27)} │ ${S(r.corrTop100["stu"]!, 3).padStart(20)} (${r.n100})`);

// ── §3 the other three channels, same two views ──────────────────────────────
console.log(`
── §3 THE OTHER CHANNELS — same two views, so "secondary-heavy" is checkable, not asserted ──`);
console.log(`   (pHR / pBABIP are ratings where HIGHER = better suppression, so a positive corr is the normal sign)`);
console.log(`
   corr(predicted value, rating) — FULL POOL view`);
console.log(`   tier      │ ${CH.map((c) => c.col.padStart(12)).join(" ")}`);
for (const r of rows)
  console.log(`   ${r.tier.padEnd(9)} │ ${CH.map((c) => S(r.corrPool[c.key]!, 3).padStart(12)).join(" ")}`);
console.log(`
   corr(predicted value, rating) — WITHIN TOP-100 view (model-selected cohort)`);
console.log(`   tier      │ ${CH.map((c) => c.col.padStart(12)).join(" ")}`);
for (const r of rows)
  console.log(`   ${r.tier.padEnd(9)} │ ${CH.map((c) => S(r.corrTop100[c.key]!, 3).padStart(12)).join(" ")}`);

// ── §4 the compact top-25 stuff profile ──────────────────────────────────────
console.log(`
── §4 TOP-25 PROFILE — (mean rating of the TOP 25 by predicted value − FULL-POOL mean) / FULL-POOL SD ──`);
console.log(`   Units are POOL SDs. Positive = the model's top 25 is ABOVE the pool on that channel.`);
console.log(`   tier      │ ${CH.map((c) => c.col.padStart(12)).join(" ")}`);
for (const r of rows)
  console.log(`   ${r.tier.padEnd(9)} │ ${CH.map((c) => S((r.topMu[25]![c.key]! - r.poolMu[c.key]!) / r.poolSd[c.key]!, 2).padStart(12)).join(" ")}`);
console.log(`
   one-line stuff read: ${rows.map((r) => `${r.tier} ${((r.topMu[25]!["stu"]! - r.poolMu["stu"]!) / r.poolSd["stu"]!).toFixed(2)}sd`).join(" | ")}`);

console.log(`
(end of gold catalog check)`);
