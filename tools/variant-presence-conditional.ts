// ═══ CONDITIONAL VARIANT PRESENCE — the quantity the pool-leg mixture needs ═══
//
// Fable amendment (from Derek), 2026-07-22: the presence prior `p` must be the CONDITIONAL
// PROPENSITY — v5 usage divided by ELIGIBLE-CLASS usage — not the raw variant share of all usage.
//
// WHY THE RAW SHARE IS THE WRONG QUANTITY. 44-51% of each window's catalog cannot have a variant at
// all (Live, LE, PTMS, Clubhouse, Mission Edition, PTCS, PTWC). Their play sits in the denominator of
// a raw share while being structurally incapable of contributing to the numerator, so the raw share
// understates the propensity wherever play concentrates in powerful ineligible cards. The pool-leg
// mixture weights ELIGIBLE cards only — eligible cards contribute v5 at weight p and base at 1-p —
// so the conditional quantity is the consistent one BY CONSTRUCTION, not by preference.
//
// THE DECOMPOSITION, which is exact because every v5 row belongs to an eligible card:
//
//     raw share  =  eligible usage share  x  conditional propensity
//     v5/total   =     eligible/total     x       v5/eligible
//
// The test it enables: is the 15-29% spread in raw shares mostly ELIGIBILITY-MIX variation, with the
// conditional propensity stable across formats? If so the prior is simpler and stronger than the raw
// spread suggested — one number rather than a per-format table.
//
// Both legs are conditioned the same way, so the league-vs-tournament asymmetry is finally stated
// like-for-like.
//
// MEASUREMENT ONLY. Nothing fitted, nothing wired. One sample builder, no private joins.

import { readFileSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import {
  makeRawPolyModel, productionFieldStats, applyWobaWeights, computeDerived, computeUnifiedFieldStats,
  FIELD_N, type EventForm, type FieldStats, type RatingEnvelope, type WobaWeights, type TrainingMeans,
} from "../src/scoring-core/index.ts";
import { parseCatalogCsv, cardId, type Card } from "../src/data/catalog.ts";
import { canHaveVariant, variantForbiddenClass } from "../src/data/variants.ts";
import { QUICK, buildCwhitSample, type SampleDeps } from "../src/eval/cwhit/sample.ts";
import { opponentSet } from "../src/eval/cwhit/realized.ts";
import { loadWindow } from "../src/training/loader.ts";

const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state = (await repo.load<{ activeModelId?: string; catalogSourceId?: string }>("state", "app")) ?? {};
type TM_ = { id: string; eventForm?: EventForm; wobaWeights?: WobaWeights; ratingEnvelope?: RatingEnvelope; trainingMeans?: TrainingMeans;
  datasetRoot?: string; window?: number[]; minPA?: number;
  platoon?: { pit: { hand: string; vsRHB: number; vsLHB: number }[]; hit: { hand: string; vsRHP: number; vsLHP: number }[] } };
const trained = (await repo.loadAll<TM_>("trained-models")).find((x) => x.id === state.activeModelId);
if (!trained?.eventForm || !trained.wobaWeights || !trained.platoon) throw new Error("active model missing eventForm/wobaWeights/platoon");
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
const byId = new Map(baseCards.map((c) => [cardId(c), c]));

console.log(`\n╔═══ CONDITIONAL VARIANT PRESENCE — both legs, like for like ═══╗`);
console.log(`model '${trained.id}' | catalog '${srcId}'`);
console.log(`eligibility = the landed predicate (7 disjoint classes + dev-override list)`);

// ── TOURNAMENT LEG ───────────────────────────────────────────────────────────
const ref: FieldStats = productionFieldStats(baseCards, coeffs, rp);
const deps: SampleDeps = {
  baseCards, coeffs, derived, eventForm: trained.eventForm, model: rp, W: trained.wobaWeights, ref,
  envelope: trained.ratingEnvelope,
  pitExp: new Map(trained.platoon.pit.map((p) => [p.hand, { wR: p.vsRHB, wL: p.vsLHB }])),
  hitExp: new Map(trained.platoon.hit.map((p) => [p.hand, { wR: p.vsRHP, wL: p.vsLHP }])),
};
const res = buildCwhitSample(deps);
// cid -> base card, via the builder's own enumeration (permissive on purpose; see variants.ts).
const cardOf = new Map<string, Card>();
for (const win of QUICK) for (const role of ["pit", "hit"] as const)
  for (const o of opponentSet(baseCards, win, role)) cardOf.set(o.cid, o.card);

console.log(`\n── TOURNAMENT LEG: raw share = eligible-usage share x CONDITIONAL propensity ──`);
console.log(`   usage = BF (pitchers) / PA (hitters); every observed row, no well-sampled floor —`);
console.log(`   presence is about who PLAYED, not about who played enough to judge a rate.`);
console.log(`\n  tier      role    total usage   elig share   v5 usage   RAW share   CONDITIONAL p   identity`);
const condRows: { tier: string; role: string; raw: number; elig: number; p: number }[] = [];
for (const win of QUICK) {
  for (const role of ["pit", "hit"] as const) {
    let tot = 0, elig = 0, v5 = 0;
    for (const r of res.recs) {
      if (r.tier !== win.tier || r.role !== role) continue;
      const base = cardOf.get(`${r.cid.split("|")[0]}|0`);
      tot += r.sample;
      // A card's class decides eligibility; the v5 row and its base share one Card ID.
      if (base && canHaveVariant(base)) elig += r.sample;
      if (r.vlvl === 5) v5 += r.sample;
    }
    const raw = tot > 0 ? v5 / tot : NaN, es = tot > 0 ? elig / tot : NaN, p = elig > 0 ? v5 / elig : NaN;
    condRows.push({ tier: win.tier, role, raw, elig: es, p });
    const ok = Math.abs(raw - es * p) < 1e-12 ? "exact" : `OFF ${(raw - es * p).toExponential(1)}`;
    console.log(`  ${win.tier.padEnd(9)} ${role}  ${tot.toFixed(0).padStart(11)}   ${(100 * es).toFixed(1).padStart(9)}%  ${v5.toFixed(0).padStart(9)}   ${(100 * raw).toFixed(1).padStart(8)}%   ${(100 * p).toFixed(1).padStart(12)}%   ${ok}`);
  }
}
const spread = (xs: number[]) => `${(100 * Math.min(...xs)).toFixed(1)}-${(100 * Math.max(...xs)).toFixed(1)}%`;
for (const role of ["pit", "hit"] as const) {
  const r = condRows.filter((x) => x.role === role);
  console.log(`\n  ${role}: RAW spread ${spread(r.map((x) => x.raw))}  vs  CONDITIONAL spread ${spread(r.map((x) => x.p))}   (eligible-usage share ${spread(r.map((x) => x.elig))})`);
}

// ── LEAGUE LEG, conditioned the same way ─────────────────────────────────────
console.log(`\n── LEAGUE LEG, SAME CONDITIONING (the like-for-like asymmetry statement) ──`);
const minPA = trained.minPA ?? 1000;
const L = loadWindow(trained.datasetRoot ?? "League Files", trained.window?.length ? trained.window : undefined);
let unmatched = 0;
for (const [label, sel, use] of [
  ["hitters", (o: any) => o.hit.PA >= minPA, (o: any) => o.hit.PA],
  ["pitchers", (o: any) => o.pitch.BF >= minPA, (o: any) => o.pitch.BF],
] as const) {
  let tot = 0, elig = 0, v5 = 0;
  for (const o of L.observations.filter(sel) as any[]) {
    const c = byId.get(String(o.cid));
    if (!c) { unmatched++; continue; }
    const u = use(o); tot += u;
    if (canHaveVariant(c)) elig += u;
    if (o.variant) v5 += u;
  }
  const raw = v5 / (tot || 1), es = elig / (tot || 1), p = v5 / (elig || 1);
  console.log(`  ${label.padEnd(9)} usage ${tot.toFixed(0).padStart(8)}  elig share ${(100 * es).toFixed(1).padStart(5)}%  RAW ${(100 * raw).toFixed(1).padStart(5)}%  CONDITIONAL p ${(100 * p).toFixed(1).padStart(5)}%`);
}
if (unmatched) console.log(`  (${unmatched} league observations had no catalog match and were skipped — reported, not silently dropped)`);

console.log(`\n── WHAT PLAYS IN THE INELIGIBLE CLASSES (why the conditioning matters) ──`);
for (const win of QUICK) {
  const byClass = new Map<string, number>();
  let tot = 0;
  for (const r of res.recs) {
    if (r.tier !== win.tier) continue;
    const base = cardOf.get(`${r.cid.split("|")[0]}|0`); if (!base) continue;
    tot += r.sample;
    const k = variantForbiddenClass(base) ?? "(eligible)";
    byClass.set(k, (byClass.get(k) ?? 0) + r.sample);
  }
  const parts = [...byClass].filter(([k]) => k !== "(eligible)").sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${(100 * v / tot).toFixed(1)}%`);
  console.log(`  ${win.tier.padEnd(9)} ineligible-class usage: ${parts.join("  ") || "none"}`);
}

console.log(`\n(end of conditional variant presence — measurement only)`);
