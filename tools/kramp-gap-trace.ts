// K-RAMP GAP TRACE — one tier, end-to-end, old artifact vs new (Fable ruling 3, 2026-07-21).
//   run: node tools/kramp-gap-trace.ts [tier]      (default bronze)
//
// THE QUESTION. A2 found s(K) fell 9–11% at every tier after the [2041,2042] -> [2042,2043]
// retrain. The standing premise is that the league frame STRENGTHENS every window, so gaps vs a
// fixed tournament pool should GROW and s(K) should RISE. Something moved opposite the premise.
// Fable's candidate: the ramp's gap lives in PREDICTED-EVENT space, where a new window's flatter
// curves shrink it even as rating-space frame distance grows.
//
// WHAT THIS TRACES, in the order production computes it:
//   trainingMeans (artifact)  ->  poolField = computeUnifiedFieldStats(pool, coeffs, model, FIELD_N)
//   ->  g = buildFrameShift(trainingMeans, poolField).pit.vR.stu  ->  s = kSpreadPitRamp(g)
// Nothing is re-derived here; every step calls the production function.
//
// READ src/scoring-core/pool-stats.ts:129 FIRST. The gap named `pit.vR.stu` is NOT the pitcher's
// Stuff gap — it is `gap(train.hit.kRat, pool.hit.kRat)`, the OPPOSING HITTER's Avoid-K rating
// gap ("pitching channels re-based by the opposing hitting gap"). So the coordinate is RATING
// space, not event space. Both sides of the subtraction are top-FIELD_N cohort means, and the
// cohort is selected BY THE MODEL's own predicted wOBA — so a new artifact reshuffles BOTH sides.

import { readFileSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import {
  makeRawPolyModel, productionFieldStats, computeUnifiedFieldStats, applyWobaWeights, computeDerived,
  buildPoolTransform, buildFrameShift, poolPitMeansOwn,
  type EventForm, type FieldStats, type RatingEnvelope, type WobaWeights, type TrainingMeans,
} from "../src/scoring-core/index.ts";
import { kSpreadPitRamp, K_SPREAD_PIT } from "../src/model/pool-transform.ts";
import { parseCatalogCsv } from "../src/data/catalog.ts";
import { QUICK, inValueWindow, FIELD_N, isPit } from "../src/eval/cwhit/sample.ts";

const TIER = process.argv[2] ?? "bronze";
const win = QUICK.find((q) => q.tier === TIER);
if (!win) throw new Error(`unknown tier '${TIER}' — one of ${QUICK.map((q) => q.tier).join(", ")}`);

const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state = (await repo.load<{ activeAccountId?: string; catalogSourceId?: string }>("state", "app")) ?? {};
type TM = { id: string; window?: number[]; eventForm?: EventForm; wobaWeights?: WobaWeights; ratingEnvelope?: RatingEnvelope; trainingMeans?: TrainingMeans };
const arts = (await repo.loadAll<TM>("trained-models")).filter((m) => m.eventForm && m.trainingMeans);
arts.sort((a, b) => (a.window?.[0] ?? 0) - (b.window?.[0] ?? 0));
if (arts.length < 2) throw new Error("need two trained artifacts on disk to compare");

const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const bq = (await repo.loadAll<Tournament>("tournaments")).find((t) => t.id === "bronze-quick")!;

const srcId = state.catalogSourceId ?? "cdmx";
const baseCards = parseCatalogCsv(readFileSync(`data/imports/${srcId}.csv`, "utf8")).cards
  .filter((c) => String(c["Variant"] ?? "").toUpperCase() !== "Y");
const pool = baseCards.filter((c) => inValueWindow(c, win));

const f = (x: number, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const sgn = (x: number, d = 3) => `${x >= 0 ? "+" : ""}${x.toFixed(d)}`;

console.log(`\nK-RAMP GAP TRACE — tier '${TIER}' (eligibility window ${win.valueMin ?? "*"}..${win.valueMax}), catalog '${srcId}'`);
console.log(`pool size ${pool.length} cards (hitters ${pool.filter((c) => !isPit(c)).length}) | FIELD_N=${FIELD_N} | ramp A=${K_SPREAD_PIT.A} G=${K_SPREAD_PIT.G}`);
console.log(`\nCOORDINATE (pool-stats.ts:129): g = train.hit.kRat − pool.hit.kRat  ⇒ RATING space, opposing-hitter Avoid-K.\n`);

type Row = { id: string; win: string; trainKRat: number; poolKRat: number; g: number; s: number; poolK: number };
const rows: Row[] = [];

for (const a of arts) {
  const rp = makeRawPolyModel(a.eventForm!);
  const coeffs = resolveCoeffs(model, eras.get(bq.eraId)!, parks.get(bq.parkId)!, bq.softcaps);
  applyWobaWeights(coeffs, a.wobaWeights!);
  const ref: FieldStats = productionFieldStats(baseCards, coeffs, rp);
  const poolField = computeUnifiedFieldStats(pool, coeffs, rp, FIELD_N, true);
  const pt = buildPoolTransform(ref, poolField, a.ratingEnvelope);
  const shift = buildFrameShift(a.trainingMeans!, poolField);
  const g = shift.pit.vR.stu ?? 0;
  rows.push({
    id: a.id, win: JSON.stringify(a.window),
    trainKRat: a.trainingMeans!.hit.kRat ?? NaN,
    poolKRat: poolField.hit.vR.kRat?.mu ?? NaN,
    g, s: kSpreadPitRamp(g),
    poolK: poolPitMeansOwn(pool, coeffs, rp, pt, FIELD_N).k,
  });
}

const [o, n] = rows as [Row, Row];
const line = (lbl: string, a: number, b: number, d = 3) =>
  console.log(`  ${lbl.padEnd(34)} ${f(a, d).padStart(9)}  ${f(b, d).padStart(9)}   ${sgn(b - a, d).padStart(9)}`);

console.log(`  ${"".padEnd(34)} ${o.id.padStart(9)}  ${n.id.padStart(9)}   ${"DELTA".padStart(9)}`);
console.log(`  ${"".padEnd(34)} ${o.win.padStart(9)}  ${n.win.padStart(9)}`);
console.log(`  ${"-".repeat(70)}`);
line("train.hit.kRat  (league frame)", o.trainKRat, n.trainKRat, 2);
line("pool.hit.kRat   (tournament pool)", o.poolKRat, n.poolKRat, 2);
line("g = train − pool  (THE RAMP INPUT)", o.g, n.g, 2);
line("s(K) = 1+A(1−e^(−g/G))", o.s, n.s);
line("K̄_pool (centering mean, events)", o.poolK, n.poolK, 2);

console.log(`\n  WHICH SIDE MOVED, and does it match the premise?`);
const dTrain = n.trainKRat - o.trainKRat, dPool = n.poolKRat - o.poolKRat;
console.log(`    league frame  ${sgn(dTrain, 2)}   ${dTrain >= 0 ? "STRONGER (matches premise)" : "WEAKER on this channel (OPPOSITE the premise)"}`);
console.log(`    pool side     ${sgn(dPool, 2)}   (same catalog; moves only because the top-${FIELD_N} cohort is selected BY THE MODEL)`);
console.log(`    net gap       ${sgn(n.g - o.g, 2)}  ⇒  s(K) ${sgn(n.s - o.s)}`);
console.log(`\n  The ramp is monotone increasing in g, so s(K) falls IF AND ONLY IF g falls.`);
console.log(`  g is a RATING-space difference, so event-space curve flattening cannot move it directly —`);
console.log(`  it can only enter through the model-dependent top-${FIELD_N} COHORT SELECTION on the pool side.\n`);
