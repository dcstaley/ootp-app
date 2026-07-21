// ═══ PROPERTY BATTERY — ITEM 4: REALIZED vs ELIGIBLE OPPOSITION ══════════════
//
// THE QUESTION. Every pool-level correction in this program treats a format's opposition as its
// ELIGIBLE POOL — production's `basePool`, uniformly. How far is that from the field actually faced?
//
// TWO CHANGES FROM THE FIRST RUN (fixtures/cwhit-battery-item4-realized-vs-eligible-2026-07-21.txt,
// which was produced ad-hoc and left no tool behind):
//
//  1. VARIANTS ARE IN. That run joined observed rows on Name+VAL+Hand and kept only observed
//     `VLvl == 0`, discarding every v5 row — 15-29% of realized usage per cell, and discarding it
//     non-randomly since a v5 is a strictly better card than its base. Usage now comes from
//     `src/eval/cwhit/realized.ts`, i.e. off the builder's fingerprint join, keyed by `Rec.cid`.
//     The OLD convention is recomputed alongside so the size of that error is readable here.
//
//  2. BOTH SIDES. The first run measured only the hitter field (the opposition pitchers face).
//     Pools are complete environments and functional quantities are two-sided, so the pitcher field
//     (the opposition hitters face) is measured on the same footing.
//
// THE ELIGIBLE SIDE IS DELIBERATELY NON-VARIANT. It is the assumption under test and has to be
// quoted exactly as production computes it: `basePool` sets the distribution, variants are scored but
// do not set it. Only the realized side gains variants, because there their absence is a measurement
// error rather than a modelling convention.
//
// DESCRIPTIVE. Nothing here is fitted, proposed, or shipped. Realized usage is not ex-ante computable,
// so this measures the size of an assumption's error — it is not a candidate coordinate.

import { readFileSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import {
  makeRawPolyModel, applyWobaWeights, computeDerived, computeUnifiedFieldStats,
  type EventForm, type FieldStats, type RatingEnvelope, type WobaWeights,
} from "../src/scoring-core/index.ts";
import { parseCatalogCsv, type Card } from "../src/data/catalog.ts";
import { QUICK, inValueWindow, isPit, n_, buildCwhitSample, FIELD_N, type SampleDeps } from "../src/eval/cwhit/sample.ts";
import { opponentSet, realizedUsage, coverage, weightsFor, cellKey, type Opponent } from "../src/eval/cwhit/realized.ts";

const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state = (await repo.load<{ activeModelId?: string; catalogSourceId?: string }>("state", "app")) ?? {};
type TM_ = { id: string; eventForm?: EventForm; wobaWeights?: WobaWeights; ratingEnvelope?: RatingEnvelope;
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

const ref: FieldStats = computeUnifiedFieldStats(baseCards, coeffs, rp, FIELD_N, true);
const deps: SampleDeps = {
  baseCards, coeffs, derived, eventForm: trained.eventForm, model: rp, W: trained.wobaWeights, ref,
  envelope: trained.ratingEnvelope,
  pitExp: new Map(trained.platoon.pit.map((p) => [p.hand, { wR: p.vsRHB, wL: p.vsLHB }])),
  hitExp: new Map(trained.platoon.hit.map((p) => [p.hand, { wR: p.vsRHP, wL: p.vsLHP }])),
};
const res = buildCwhitSample(deps);
const usage = realizedUsage(res);
const oppSets = new Map<string, Opponent[]>();
for (const win of QUICK) for (const role of ["pit", "hit"] as const)
  oppSets.set(cellKey(win.tier, role), opponentSet(baseCards, win, role));

// Rating channels, per role. vR only — the same side the frame-shift gap is read on.
const CH = {
  hit: { Eye: "Eye vR", Power: "Power vR", AvoidK: "Avoid K vR", BABIP: "BABIP vR", Gap: "Gap vR" },
  pit: { Control: "Control vR", Stuff: "Stuff vR", pHR: "pHR vR", pBABIP: "pBABIP vR" },
} as const;

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const sd = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(xs.length - 1, 1));
};
const wmean = (xs: number[], w: number[]) => {
  let s = 0, sw = 0;
  for (let i = 0; i < xs.length; i++) { s += w[i]! * xs[i]!; sw += w[i]!; }
  return sw > 0 ? s / sw : NaN;
};
/** Gini of the nonzero usage weights — how concentrated the realized field is. */
const gini = (w: number[]) => {
  const x = w.filter((v) => v > 0).sort((a, b) => a - b);
  const n = x.length, tot = x.reduce((a, b) => a + b, 0);
  if (!n || tot <= 0) return NaN;
  let acc = 0; for (let i = 0; i < n; i++) acc += (i + 1) * x[i]!;
  return (2 * acc) / (n * tot) - (n + 1) / n;
};
const topShare = (w: number[], frac: number) => {
  const x = w.filter((v) => v > 0).sort((a, b) => b - a);
  const tot = x.reduce((a, b) => a + b, 0);
  if (!x.length || tot <= 0) return NaN;
  const k = Math.max(1, Math.ceil(frac * x.length));
  return x.slice(0, k).reduce((a, b) => a + b, 0) / tot;
};

console.log(`\n╔═══ BATTERY ITEM 4 — REALIZED vs ELIGIBLE OPPOSITION (variant-corrected) ═══╗`);
console.log(`model '${trained.id}' | catalog '${srcId}' | corpus ${res.source.kind === "capture" ? res.source.dir : "legacy"}`);
for (const n of res.notices) console.log(`  [builder] ${n}`);

console.log(`\n── COVERAGE — how much of the "eligible opposition" ever plays ──`);
console.log(`   base = VLvl 0, v5 = variant. The eligible column counts BASE cards (production's basePool);`);
console.log(`   variants are not part of the eligible pool but ARE part of the realized field.`);
console.log(`\n  tier      role   eligible   played base   played v5   usage base    usage v5   v5 share   base cover`);
for (const c of coverage(usage, oppSets))
  console.log(`  ${c.tier.padEnd(9)} ${c.role}    ${String(c.nBase).padStart(6)}   ${String(c.playedBase).padStart(9)}   ${String(c.playedVar).padStart(9)}  ${c.usageBase.toFixed(0).padStart(10)}  ${c.usageVar.toFixed(0).padStart(10)}    ${(100 * c.varShare).toFixed(1).padStart(6)}%      ${(100 * c.playedBase / c.nBase).toFixed(1).padStart(5)}%`);

interface Row { tier: string; role: "pit" | "hit"; ch: string; dNew: number; dOld: number; eligMean: number; eligSd: number; realMean: number }
const rows: Row[] = [];
const conc: { tier: string; role: "pit" | "hit"; n: number; tot: number; g: number; t10: number; t25: number; t50: number }[] = [];

for (const win of QUICK) {
  const pool = baseCards.filter((c) => inValueWindow(c, win));
  for (const role of ["pit", "hit"] as const) {
    const key = cellKey(win.tier, role);
    const opps = oppSets.get(key)!;
    const u = usage.get(key);
    const w = weightsFor(opps, u);
    // The OLD convention, recomputed here: v5 entries forced to weight 0. This is what the first run
    // measured — kept so the correction's size is visible rather than asserted.
    const wOld = opps.map((o, i) => (o.vlvl === 0 ? w[i]! : 0));
    // ELIGIBLE reference = the BASE pool of this role, uniform. Production's assumption, verbatim.
    const eligCards: Card[] = pool.filter((c) => (role === "pit" ? isPit(c) : !isPit(c)));
    for (const [label, col] of Object.entries(CH[role])) {
      const elig = eligCards.map((c) => n_(c[col]));
      const s = sd(elig), m = mean(elig);
      const xs = opps.map((o) => n_(o.card[col]));
      const realMean = wmean(xs, w);
      rows.push({ tier: win.tier, role, ch: label, eligMean: m, eligSd: s, realMean,
        dNew: (realMean - m) / s, dOld: (wmean(xs, wOld) - m) / s });
    }
    conc.push({ tier: win.tier, role, n: w.filter((x) => x > 0).length, tot: w.reduce((a, b) => a + b, 0),
      g: gini(w), t10: topShare(w, 0.10), t25: topShare(w, 0.25), t50: topShare(w, 0.50) });
  }
}

const f3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3).padStart(8) : "     n/a");
for (const role of ["hit", "pit"] as const) {
  console.log(`\n── DIVERGENCE in eligible-pool SD units: (realized usage-weighted mean) − (eligible uniform mean) ──`);
  console.log(`   ${role === "hit" ? "THE HITTER FIELD — the opposition PITCHERS face" : "THE PITCHER FIELD — the opposition HITTERS face"}`);
  console.log(`\n  channel      iron   bronze   silver     GOLD  diamond   │  same, VLvl-0-only (the old, wrong convention)`);
  for (const ch of Object.keys(CH[role])) {
    const r = QUICK.map((w) => rows.find((x) => x.tier === w.tier && x.role === role && x.ch === ch)!);
    console.log(`  ${ch.padEnd(9)} ${r.map((x) => f3(x.dNew)).join(" ")}   │ ${r.map((x) => f3(x.dOld)).join(" ")}`);
  }
}

console.log(`\n── USAGE CONCENTRATION of the realized field (nonzero weights, variants included) ──`);
console.log(`\n  tier      role      N   total usage    Gini    top10%    top25%    top50%`);
for (const c of conc)
  console.log(`  ${c.tier.padEnd(9)} ${c.role}  ${String(c.n).padStart(5)}   ${c.tot.toFixed(0).padStart(11)}   ${c.g.toFixed(3)}    ${(100 * c.t10).toFixed(1).padStart(5)}%    ${(100 * c.t25).toFixed(1).padStart(5)}%    ${(100 * c.t50).toFixed(1).padStart(5)}%`);

console.log(`\n   SIGN is expected on every channel that measures quality: cards that get played are better`);
console.log(`   than the average eligible card. The MAGNITUDE and the ORDERING ACROSS TIERS are the finding.`);
console.log(`\n(end of battery item 4 — realized vs eligible opposition, variant-corrected)`);
