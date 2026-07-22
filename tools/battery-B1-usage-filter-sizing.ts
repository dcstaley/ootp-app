// ITEM B1 — USAGE-FILTER SIZING.  run: node tools/battery-B1-usage-filter-sizing.ts
//
// THE RULED DEFECT (item-B static audit; do not re-derive it here — this tool SIZES it).
// `buildFrameShift(trainingMeans, poolField)` (src/scoring-core/pool-stats.ts:130) computes
// `mu_train_opp − mu_pool_opp`, and its two legs are drawn from populations that disagree on THREE
// axes. Item A sized the VARIANT axis; the item-B empirical run sized the COHORT-SIZE axis. This is
// the USAGE-FILTER axis:
//
//   · TRAIN leg — `trainingMeans` is the TOP-50 field of the training league, but only over league
//     cards that clear a USAGE FLOOR: `src/server/server.ts:1517-1518` filters
//     `maxPA >= minPA` (hitters) / `maxBF >= minPA` (pitchers), with `minPA` defaulting to 1000
//     (server.ts:1432; the artifact records its own `minPA`). Clearing a 1000-PA/BF floor in a real
//     league is a STRENGTH SELECTION — weak cards do not accumulate playing time, so the surviving
//     population is better than the league it was drawn from before the top-50 cut is even applied.
//   · POOL leg — `buildEligiblePool` (src/config/eligibility.ts:87-97) has NO usage concept at all.
//     It is a card-value window plus the format's eligibility rules, over the whole catalog.
//
//   ⇒ the gap subtracts a mean over "every eligible card" from a mean over "cards good enough to play
//     1000+ PA/BF in the league". The pull is PREDICTED ONE-DIRECTIONAL: the floor can only remove
//     the weak end of the training population, so it can only raise (or leave) the training mean, and
//     therefore only inflate (or leave) the gap.
//
// THAT PREDICTION IS REFUTED BY THE RUN, and the refutation is the finding — kept here so nobody
// reads the paragraph above as the result. The floor is applied BEFORE the top-FIELD_N cut, so the
// train leg is not a population mean at all: top-N-of-a-subset can never beat top-N-of-the-superset
// on the metric it is selected by, and the floor therefore makes the training field WEAKER, not
// stronger. Measured direction is one-directional in FIELD STRENGTH and opposite to the prediction
// (§1d); per-CHANNEL it is not one-signed at all. See fixtures/cwhit-B1-usage-filter-sizing-2026-07-21.txt.
//
// WHAT THIS TOOL DOES: recomputes `trainingMeans` at usage floors {0, 250, 500, 1000 (production),
// 2000} using the SAME construction production uses (server.ts:1490-1529 — `loadWindow` +
// `computeUnifiedFieldStats` under the era-2010 / neutral-park coeffs the trainer pins), then pushes
// each recomputed frame through `buildFrameShift` against the nine formats' production pool fields
// and through the two SHIPPED ramps as they stand.
//
// MEASUREMENT ONLY. Nothing here changes a production behaviour, default or constant; nothing is
// fitted; nothing is wired. No scoring math is written here — every number comes from the shared core
// (`loadWindow` / `computeUnifiedFieldStats` / `buildFrameShift` / `kSpreadPitRamp` /
// `pitSpreadHrRamp`), and FIELD_N is imported from `src/scoring-core/pool-stats.ts`.
//
// THE FROZEN-ARTIFACT CONSTRAINT, carried through every table below: the deployed artifact's
// `trainingMeans` was computed AT THE PRODUCTION FLOOR and is baked into the model file. A floor
// change is therefore a RETRAIN-COUPLED decision, not a config knob — the counterfactual frames
// printed here do not exist anywhere a running server could reach.

import { existsSync, readFileSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import { rowEligible } from "../src/config/eligibility.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import type { Coeffs } from "../src/config/types.ts";
import {
  FIELD_N, makeRawPolyModel, computeUnifiedFieldStats, applyWobaWeights,
  buildFrameShift, cardSideWobas,
  kSpreadPitRamp, pitSpreadHrRamp, K_SPREAD_PIT, PIT_SPREAD_HR, HIT_RATINGS, PIT_RATINGS,
  type EventForm, type FieldStats, type RatingEnvelope, type WobaWeights, type TrainingMeans,
} from "../src/scoring-core/index.ts";
import { loadWindow } from "../src/training/loader.ts";
import { HITTER, PITCHER } from "../src/training/bakeoff.ts";
import { parseCatalogCsv, type Card } from "../src/data/catalog.ts";
import { CWHIT_CORPUS, formatByKey } from "../src/eval/cwhit/corpus.ts";
import { inValueWindow, isPit, type ValueWindow } from "../src/eval/cwhit/sample.ts";

const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const sgn = (x: number, d = 2) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}` : "n/a");

// ── boot (the tools/battery-itemA-variant-sizing.ts pattern) ─────────────────
const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state = (await repo.load<{ activeModelId?: string; catalogSourceId?: string }>("state", "app")) ?? {};
type TM = {
  id: string; eventForm?: EventForm; wobaWeights?: WobaWeights; ratingEnvelope?: RatingEnvelope;
  trainingMeans?: TrainingMeans; includeVariants?: boolean; window?: number[]; minPA?: number;
  datasetRoot?: string; trainedAt?: string;
};
const trained = (await repo.loadAll<TM>("trained-models")).find((x) => x.id === state.activeModelId);
if (!trained?.eventForm || !trained.wobaWeights) throw new Error("active model missing eventForm/wobaWeights");
if (!trained.trainingMeans) throw new Error("active model has NO trainingMeans — the frozen frame is the thing under test");
const SHIPPED_MEANS = trained.trainingMeans;
const rp = makeRawPolyModel(trained.eventForm);
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const tournaments = await repo.loadAll<Tournament>("tournaments");
const tourneys = new Map(tournaments.map((t) => [t.id, t]));

// The training root, resolved EXACTLY as server.ts:59 does; cross-checked against the artifact's
// own datasetRoot so a moved dataset is caught loudly rather than silently re-measured.
const TRAINING_DIR = [process.env.TRAINING_DIR, "League Files", "Model 2037 and 2038"]
  .find((d): d is string => !!d && existsSync(d));
if (!TRAINING_DIR) throw new Error("no training dir found");

const srcId = state.catalogSourceId ?? "cdmx";
const parsedCatalog = parseCatalogCsv(readFileSync(`data/imports/${srcId}.csv`, "utf8"));
const baseCards: Card[] = parsedCatalog.cards.filter((c) => String(c["Variant"] ?? "").toUpperCase() !== "Y");

// ── the training-side construction, lifted from server.ts:1490-1529 ──────────
// The trainer pins era-2010 + a neutral park literal and takes softcaps from `tournaments[0]`.
// CARRIED, NOT "IMPROVED" — the whole point is to reproduce production's own frame construction.
const WINDOW = trained.window ?? [];
const INCLUDE_VARIANTS = trained.includeVariants !== false;
const PROD_FLOOR = trained.minPA ?? 1000;
const loaded = loadWindow(TRAINING_DIR, WINDOW);
const tmEra2010 = eras.get("era-2010");
const tmTourney = tournaments[0];
if (!tmEra2010 || !tmTourney) throw new Error("config DB not seeded (era-2010 / tournaments missing)");
const tmCoeffs: Coeffs = resolveCoeffs(model, tmEra2010,
  { id: "neutral", name: "neutral", avg_l: 1, avg_r: 1, hr_l: 1, hr_r: 1, gap: 1 }, tmTourney.softcaps);
applyWobaWeights(tmCoeffs, loaded.wobaWeights);

// Reconstruct training-league cards in the CSV-column shape computeUnifiedFieldStats reads —
// the SAME loop as server.ts:1506-1515, including the `${cid}|${variant?V:B}` key.
const obs = loaded.observations.filter((o) => INCLUDE_VARIANTS || !o.variant);
const tmCards = new Map<string, Record<string, unknown>>();
for (const o of obs) {
  const key = `${o.cid}|${o.variant ? "V" : "B"}`;
  let c = tmCards.get(key);
  if (!c) { c = { maxPA: 0, maxBF: 0, Bats: o.bats, Throws: o.throws, Speed: o.ratings.hit.speed, Stealing: o.ratings.hit.steal, Baserunning: o.ratings.hit.run }; tmCards.set(key, c); }
  const s = o.side;
  c[`Eye v${s}`] = o.ratings.hit.eye; c[`Power v${s}`] = o.ratings.hit.pow; c[`Avoid K v${s}`] = o.ratings.hit.kRat; c[`BABIP v${s}`] = o.ratings.hit.babip; c[`Gap v${s}`] = o.ratings.hit.gap;
  c[`Control v${s}`] = o.ratings.pitch.con; c[`Stuff v${s}`] = o.ratings.pitch.stu; c[`pBABIP v${s}`] = o.ratings.pitch.pbabip; c[`pHR v${s}`] = o.ratings.pitch.hrr;
  c.maxPA = Math.max(c.maxPA as number, o.hit.PA); c.maxBF = Math.max(c.maxBF as number, o.pitch.BF);
}
const tmAll = [...tmCards.values()].filter((c) => c["Eye vR"] != null && c["Eye vL"] != null && c["Control vR"] != null && c["Control vL"] != null);

const FLOORS = [0, 250, 500, 1000, 2000];

// Column names the reconstructed league cards carry, per channel — used ONLY by the membership
// probe's mean re-computation (a plain arithmetic mean of ratings; no scoring math).
const HIT_COL: Record<string, string> = { eye: "Eye", pow: "Power", kRat: "Avoid K", babip: "BABIP", gap: "Gap" };
const PIT_COL: Record<string, string> = { con: "Control", stu: "Stuff", pbabip: "pBABIP", hrr: "pHR" };
const nOf = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

/** MEMBERSHIP PROBE — which cards computeUnifiedFieldStats' top-N cut actually selects. It ranks on
 *  `cardSideWobas` (the core's OWN selection basis, sspFree=true) with the same comparator and the
 *  same input order, so ties resolve identically. Its per-channel means are cross-checked against
 *  computeUnifiedFieldStats below; a mismatch would mean the probe is not seeing the same cohort. */
function membership(cards: Record<string, unknown>[], topN: number) {
  const recs = cards.map((c) => ({ c, w: cardSideWobas(c, tmCoeffs, rp, true) }));
  const pit = [...recs].sort((a, b) => (a.w.pitVR + a.w.pitVL) - (b.w.pitVR + b.w.pitVL)).slice(0, topN);
  const hVR = [...recs].sort((a, b) => b.w.hitVR - a.w.hitVR).slice(0, topN);
  const hVL = [...recs].sort((a, b) => b.w.hitVL - a.w.hitVL).slice(0, topN);
  return { pit, hVR, hVL };
}

interface FloorRead {
  floor: number;
  nCardsHit: number; nCardsPit: number;            // FULL-POOL: cards clearing the floor
  nObsHit: number; nObsPit: number;                // FULL-POOL: (cid,variant,side) obs clearing it
  means: TrainingMeans;                            // TOP-N (FIELD_N) field means
  hitCohortIsAll: boolean; pitCohortIsAll: boolean; // cohort smaller than FIELD_N ⇒ "top-N" = all
  zeroUsageInHitTop: number; zeroUsageInPitTop: number; // selected members with no role usage at all
  minPAInHitTop: number; minBFInPitTop: number;
  probeMaxDelta: number;                           // membership-probe self-check
  fieldWobaHit: number; fieldWobaPit: number;      // TOP-N field mean predicted wOBA (the SELECTION metric)
  hitTopIds: Set<Record<string, unknown>>; pitTopIds: Set<Record<string, unknown>>;
}

function readFloor(floor: number): FloorRead {
  const hitCards = tmAll.filter((c) => (c.maxPA as number) >= floor);
  const pitCards = tmAll.filter((c) => (c.maxBF as number) >= floor);
  const fieldHit = computeUnifiedFieldStats(hitCards, tmCoeffs, rp, FIELD_N, true);
  const fieldPit = computeUnifiedFieldStats(pitCards, tmCoeffs, rp, FIELD_N, true);
  const means: TrainingMeans = {
    hit: { eye: fieldHit.hit.vR.eye!.mu, pow: fieldHit.hit.vR.pow!.mu, kRat: fieldHit.hit.vR.kRat!.mu, babip: fieldHit.hit.vR.babip!.mu, gap: fieldHit.hit.vR.gap!.mu },
    pit: { con: fieldPit.pit.vR.con!.mu, stu: fieldPit.pit.vR.stu!.mu, pbabip: fieldPit.pit.vR.pbabip!.mu, hrr: fieldPit.pit.vR.hrr!.mu },
  };
  // membership + self-check
  const mh = membership(hitCards, FIELD_N), mp = membership(pitCards, FIELD_N);
  let probeMaxDelta = 0;
  for (const k of HIT_RATINGS) {
    const mu = mean([...mh.hVR.map((x) => nOf(x.c[`${HIT_COL[k]} vR`])), ...mh.hVL.map((x) => nOf(x.c[`${HIT_COL[k]} vL`]))]);
    probeMaxDelta = Math.max(probeMaxDelta, Math.abs(mu - fieldHit.hit.vR[k]!.mu));
  }
  for (const k of PIT_RATINGS) {
    const mu = mean(mp.pit.flatMap((x) => [nOf(x.c[`${PIT_COL[k]} vR`]), nOf(x.c[`${PIT_COL[k]} vL`])]));
    probeMaxDelta = Math.max(probeMaxDelta, Math.abs(mu - fieldPit.pit.vR[k]!.mu));
  }
  const hitTopCards = [...new Set([...mh.hVR, ...mh.hVL].map((x) => x.c))];
  const pitTopCards = mp.pit.map((x) => x.c);
  return {
    floor,
    nCardsHit: hitCards.length, nCardsPit: pitCards.length,
    nObsHit: obs.filter((o) => HITTER.qualifies(o, floor)).length,
    nObsPit: obs.filter((o) => PITCHER.qualifies(o, floor)).length,
    means,
    hitCohortIsAll: hitCards.length <= FIELD_N, pitCohortIsAll: pitCards.length <= FIELD_N,
    zeroUsageInHitTop: hitTopCards.filter((c) => (c.maxPA as number) <= 0).length,
    zeroUsageInPitTop: pitTopCards.filter((c) => (c.maxBF as number) <= 0).length,
    minPAInHitTop: Math.min(...hitTopCards.map((c) => c.maxPA as number)),
    minBFInPitTop: Math.min(...pitTopCards.map((c) => c.maxBF as number)),
    probeMaxDelta,
    // The SELECTION metric of the chosen field: mean raw predicted wOBA of the per-side hitter
    // cohorts (higher = stronger) and of the combined-allowed pitcher cohort (lower = stronger).
    fieldWobaHit: mean([...mh.hVR.map((x) => x.w.hitVR), ...mh.hVL.map((x) => x.w.hitVL)]),
    fieldWobaPit: mean(mp.pit.flatMap((x) => [x.w.pitVR, x.w.pitVL])),
    hitTopIds: new Set(hitTopCards), pitTopIds: new Set(pitTopCards),
  };
}

// ── the nine formats, from THE corpus registry ───────────────────────────────
const FORMAT_KEYS = [
  "ironquick", "bronzequick", "silverquick", "goldquick", "diamondquick",
  "earlygold", "bronzeheart", "goldcapdaily", "diamondcapdaily",
] as const;
const shortOf: Record<string, string> = {
  ironquick: "iron", bronzequick: "bronze", silverquick: "silver", goldquick: "gold", diamondquick: "diamond",
  earlygold: "early-gold", bronzeheart: "bronze-heart", goldcapdaily: "gold-cap", diamondcapdaily: "diamond-cap",
};
interface Fmt {
  key: string; short: string; label: string; t: Tournament; coeffs: Coeffs; win: ValueWindow;
  eraId: string; parkId: string; ruleCount: number;
  poolField: FieldStats; nPool: number; nPoolPit: number;
}
const FORMATS: Fmt[] = FORMAT_KEYS.map((key) => {
  const reg = formatByKey(key);
  if (!reg?.tournamentId) throw new Error(`corpus registry has no tournamentId for '${key}'`);
  const t = tourneys.get(reg.tournamentId);
  if (!t) throw new Error(`tournament '${reg.tournamentId}' not found`);
  const era = eras.get(t.eraId), park = parks.get(t.parkId);
  if (!era || !park) throw new Error(`tournament '${t.id}': missing era '${t.eraId}' or park '${t.parkId}'`);
  const coeffs = resolveCoeffs(model, era, park, t.softcaps);
  applyWobaWeights(coeffs, trained!.wobaWeights!);
  // THE ELIGIBILITY RULE COMES FROM THE CONFIG (card_value_min/max + rowEligible = buildEligiblePool
  // minus the owned filter the calibration pool never applies), so bronze-heart's Year 1930-1989
  // rule is honoured by construction, not re-implemented.
  const win: ValueWindow = {
    tier: shortOf[key] ?? key,
    valueMin: t.card_value_min ?? undefined,
    valueMax: t.card_value_max ?? Number.POSITIVE_INFINITY,
    eligible: (c) => rowEligible(c as Card, t),
  };
  const pool = baseCards.filter((c) => inValueWindow(c, win));
  return {
    key, short: shortOf[key] ?? key, label: reg.label, t, coeffs, win,
    eraId: t.eraId, parkId: t.parkId, ruleCount: (t.eligibility?.rules ?? []).length,
    poolField: computeUnifiedFieldStats(pool, coeffs, rp, FIELD_N, true),
    nPool: pool.length, nPoolPit: pool.filter((c) => isPit(c)).length,
  };
});

// ═════════════════════════════════════════════════════════════════════════════
console.log(`\n╔══════════════════════════════════════════════════════════════════════════════════════════════╗`);
console.log(`║  ITEM B1 — USAGE-FILTER SIZING: what the 1000-PA/BF training floor costs the frame gap        ║`);
console.log(`╚══════════════════════════════════════════════════════════════════════════════════════════════╝`);
console.log(`model '${trained.id}' (trainedAt ${trained.trainedAt ?? "?"}) | catalog '${srcId}' (${baseCards.length} base cards)`);
console.log(`artifact: window=[${WINDOW.join(",")}]  minPA=${PROD_FLOOR}  includeVariants=${String(INCLUDE_VARIANTS)}  datasetRoot='${trained.datasetRoot ?? "?"}'`);
console.log(`training dir resolved here: '${TRAINING_DIR}'  ${trained.datasetRoot && trained.datasetRoot !== TRAINING_DIR ? "⚠ DIFFERS FROM THE ARTIFACT'S datasetRoot" : "(matches the artifact)"}`);
console.log(`FIELD_N = ${FIELD_N} (imported from src/scoring-core/pool-stats.ts; never re-declared here)`);
console.log(`training coeffs pinned as the trainer pins them: era-2010 + NEUTRAL park literal + softcaps from tournaments[0] ('${tmTourney.id}')`);
console.log(`shipped ramps quoted as they stand: K_SPREAD_PIT = {A:${K_SPREAD_PIT.A}, q:${K_SPREAD_PIT.q}, gMax:${K_SPREAD_PIT.gMax}}  PIT_SPREAD_HR = {A:${PIT_SPREAD_HR.A}, G:${PIT_SPREAD_HR.G}}  — NOT refit`);
console.log(`MEASUREMENT ONLY — no production behaviour, default or constant is changed; nothing is fitted; nothing is wired.`);

// ═══ 0. THE SEAM, stated once ════════════════════════════════════════════════
console.log(`\n\n╔═══ 0. THE SEAM — what each leg of \`mu_train_opp − mu_pool_opp\` is a mean OVER ═══╗`);
console.log(`  leg     population                                                    usage concept   cohort cut`);
console.log(`  ─────── ───────────────────────────────────────────────────────────── ─────────────── ──────────────`);
console.log(`  TRAIN   league cards, window [${WINDOW.join(",")}], reconstructed from the training      maxPA/maxBF ≥   TOP-${FIELD_N} by model`);
console.log(`          CSVs (server.ts:1506-1515), variant-INCLUSIVE                  minPA (=${String(PROD_FLOOR).padEnd(6)}) wOBA`);
console.log(`  POOL    catalog cards passing card_value_min/max + rowEligible         NONE            TOP-${FIELD_N} by model`);
console.log(`          (eligibility.ts:87-97), variant-FREE                                           wOBA`);
console.log(``);
console.log(`  Both legs take a TOP-${FIELD_N} cut, so the cohort SIZE matches (that is the §11.13 matched-legs fix).`);
console.log(`  What does NOT match is the POPULATION the top-${FIELD_N} is selected FROM: the train leg pre-filters that`);
console.log(`  population by realized playing time, the pool leg does not. Every N below is labelled FULL-POOL`);
console.log(`  (the population) or TOP-N (the ${FIELD_N}-card field cut from it).`);
console.log(``);
console.log(`  ONE-DIRECTIONALITY, stated as a PREDICTION before the numbers: a usage floor can only DELETE`);
console.log(`  members of the training population, never add them, and the deleted members are the ones that`);
console.log(`  could not earn playing time. If playing time correlates with model-predicted quality at all, a`);
console.log(`  higher floor can only raise (or leave) each channel's top-${FIELD_N} mean ⇒ only inflate (or leave) the`);
console.log(`  gap. A NEGATIVE mean-vs-floor slope on any channel would falsify that. Checked in §1c.`);

// ═══ 1. THE SIZING ═══════════════════════════════════════════════════════════
console.log(`\n\n╔═══ 1. THE SIZING — trainingMeans recomputed at each usage floor ═══╗`);
const reads = new Map<number, FloorRead>();
for (const fl of FLOORS) reads.set(fl, readFloor(fl));
const prod = reads.get(PROD_FLOOR)!;

console.log(`\n── 1a. COHORT SURVIVAL (FULL-POOL counts — the population the TOP-${FIELD_N} is cut from) ──`);
console.log(`  The train leg is TWO populations where the pool leg is one: the hitter field is cut from cards`);
console.log(`  clearing the floor on maxPA, the pitcher field from cards clearing it on maxBF. They are different`);
console.log(`  card sets and they shrink at different rates. Card-level counts are of the ${tmAll.length} reconstructed`);
console.log(`  league cards (both sides present); obs-level counts are of the ${obs.length} (cid,variant,side) observations,`);
console.log(`  via HITTER.qualifies / PITCHER.qualifies — the same predicates the fit uses.`);
console.log(``);
console.log(`  floor    cards maxPA≥f   cards maxBF≥f   obs PA≥f   obs BF≥f   hit field    pit field`);
for (const fl of FLOORS) {
  const r = reads.get(fl)!;
  const tag = fl === PROD_FLOOR ? " ← PRODUCTION" : "";
  console.log(`  ${String(fl).padStart(5)}${fl === PROD_FLOOR ? "*" : " "}  ${String(r.nCardsHit).padStart(12)}   ${String(r.nCardsPit).padStart(13)}   ${String(r.nObsHit).padStart(8)}   ${String(r.nObsPit).padStart(8)}   ${(r.hitCohortIsAll ? `ALL ${r.nCardsHit}` : `top ${FIELD_N}`).padEnd(11)}  ${(r.pitCohortIsAll ? `ALL ${r.nCardsPit}` : `top ${FIELD_N}`).padEnd(10)}${tag}`);
}
console.log(`  A "hit field / pit field" reading of ALL n means the surviving population is at or below FIELD_N, so`);
console.log(`  the top-${FIELD_N} cut is vacuous there and the "field mean" is just the cohort mean — a different estimator.`);

console.log(`\n── 1b. THE TRAINING MEANS (TOP-${FIELD_N} field μ, per channel) ──`);
console.log(`  Reference row = the SHIPPED artifact's frozen trainingMeans, printed so the reproduction is checkable`);
console.log(`  rather than trusted: the floor-${PROD_FLOOR} row must reproduce it (Δ column vs shipped).`);
for (const role of ["pit", "hit"] as const) {
  const keys = role === "pit" ? PIT_RATINGS : HIT_RATINGS;
  console.log(`\n  ${role.toUpperCase()} training μ`);
  console.log(`  floor      ${keys.map((k) => k.padStart(9)).join("  ")}`);
  console.log(`  shipped    ${keys.map((k) => f((SHIPPED_MEANS[role] as Record<string, number>)[k]!, 2).padStart(9)).join("  ")}   ← FROZEN in the model file`);
  for (const fl of FLOORS) {
    const r = reads.get(fl)!;
    const m = r.means[role] as Record<string, number>;
    console.log(`  ${(String(fl) + (fl === PROD_FLOOR ? "*" : "")).padEnd(10)} ${keys.map((k) => f(m[k]!, 2).padStart(9)).join("  ")}`);
  }
  console.log(`  Δ vs floor-${PROD_FLOOR} (production)`);
  for (const fl of FLOORS) {
    const r = reads.get(fl)!;
    const m = r.means[role] as Record<string, number>, p = prod.means[role] as Record<string, number>;
    console.log(`  ${(String(fl) + (fl === PROD_FLOOR ? "*" : "")).padEnd(10)} ${keys.map((k) => sgn(m[k]! - p[k]!, 2).padStart(9)).join("  ")}`);
  }
  console.log(`  reproduction check vs the shipped artifact (floor ${PROD_FLOOR}): ` +
    keys.map((k) => `${k} ${sgn((prod.means[role] as Record<string, number>)[k]! - (SHIPPED_MEANS[role] as Record<string, number>)[k]!, 4)}`).join("  "));
}

console.log(`\n── 1c. EVALUABILITY + DIRECTION CHECK ──`);
console.log(`  A floor is only reportable if its cohort is a real top-${FIELD_N} field and its members are cards that`);
console.log(`  actually played. Degeneracy probes below; membership comes from a probe that ranks on the core's own`);
console.log(`  cardSideWobas and is cross-checked against computeUnifiedFieldStats (max |Δμ| must be ~0).`);
console.log(``);
console.log(`  floor   probe |Δμ|max   zero-PA cards in hit top-${FIELD_N}   zero-BF in pit top-${FIELD_N}   min maxPA in hit top   min maxBF in pit top`);
for (const fl of FLOORS) {
  const r = reads.get(fl)!;
  console.log(`  ${(String(fl) + (fl === PROD_FLOOR ? "*" : "")).padEnd(7)} ${r.probeMaxDelta.toExponential(1).padStart(13)}   ${String(r.zeroUsageInHitTop).padStart(24)}   ${String(r.zeroUsageInPitTop).padStart(21)}   ${f(r.minPAInHitTop, 0).padStart(20)}   ${f(r.minBFInPitTop, 0).padStart(20)}`);
}
console.log(``);
console.log(`  DIRECTION: per channel, is the mean monotone NON-DECREASING in the floor over the evaluable floors?`);
for (const role of ["pit", "hit"] as const) {
  const keys = role === "pit" ? PIT_RATINGS : HIT_RATINGS;
  for (const k of keys) {
    const seq = FLOORS.map((fl) => (reads.get(fl)!.means[role] as Record<string, number>)[k]!);
    const drops: string[] = [];
    for (let i = 1; i < seq.length; i++) if (seq[i]! < seq[i - 1]! - 1e-9) drops.push(`${FLOORS[i - 1]}→${FLOORS[i]} ${sgn(seq[i]! - seq[i - 1]!, 2)}`);
    console.log(`    ${role}.${k.padEnd(7)} ${seq.map((x) => f(x, 1).padStart(7)).join(" →")}    ${drops.length === 0 ? "MONOTONE ↑" : `NON-MONOTONE at ${drops.join(", ")}`}`);
  }
}

console.log(`\n── 1d. THE MECHANISM — why the direction comes out the way it does ──`);
console.log(`  The prediction in §0 reasons about a POPULATION mean: a usage floor keeps the strong and drops the`);
console.log(`  weak, so the surviving mean rises. That reasoning is correct for a FULL-POOL mean. The train leg is`);
console.log(`  NOT a full-pool mean — it is the TOP-${FIELD_N} field cut from the surviving population, and the floor is`);
console.log(`  applied BEFORE that cut. Top-${FIELD_N}-of-a-subset can never beat top-${FIELD_N}-of-the-superset in the selection`);
console.log(`  metric, so on the metric the field is SELECTED BY, the floor can only make the field WEAKER.`);
console.log(`  It removes CANDIDATES from a competition the strong were already winning.`);
console.log(``);
console.log(`  (a) the SELECTION metric of the chosen field, by floor`);
console.log(`      floor    hitter field mean wOBA (higher = stronger)   pitcher field mean allowed wOBA (LOWER = stronger)`);
for (const fl of FLOORS) {
  const r = reads.get(fl)!;
  console.log(`      ${(String(fl) + (fl === PROD_FLOOR ? "*" : "")).padEnd(7)}  ${f(r.fieldWobaHit, 5).padStart(40)}   ${f(r.fieldWobaPit, 5).padStart(48)}`);
}
{
  const hs = FLOORS.map((fl) => reads.get(fl)!.fieldWobaHit);
  const ps = FLOORS.map((fl) => reads.get(fl)!.fieldWobaPit);
  const hMono = hs.every((v, i) => i === 0 || v <= hs[i - 1]! + 1e-12);
  const pMono = ps.every((v, i) => i === 0 || v >= ps[i - 1]! - 1e-12);
  console.log(`      hitter field weakens monotonically as the floor rises?  ${hMono ? "YES" : "NO"}`);
  console.log(`      pitcher field weakens monotonically as the floor rises? ${pMono ? "YES" : "NO"}`);
  console.log(`      ⇒ the ONE-DIRECTIONALITY is real, but it runs on the SELECTION metric and in the OPPOSITE`);
  console.log(`        direction to the §0 prediction. Per-CHANNEL means are NOT individually monotone (see §1c):`);
  console.log(`        the composite ranking trades channels against each other, so a weaker field can still be`);
  console.log(`        higher on one rating. The channel a ramp reads is therefore not guaranteed the sign the`);
  console.log(`        composite has — which is why the ramp table in §3 is non-monotone in the floor.`);
}
console.log(``);
console.log(`  (b) HOW MANY of the best-${FIELD_N} the floor DELETES — members of the f=0 field that each floor removes`);
console.log(`      from the candidate set entirely (they are league cards, they simply did not play that much).`);
console.log(`      NOTE the hitter field is the UNION of the vR and vL top-${FIELD_N} cohorts (computeUnifiedFieldStats pools`);
console.log(`      each cohort's deployment side), so its distinct-card count exceeds ${FIELD_N}; the pitcher field is one`);
console.log(`      combined-wOBA top-${FIELD_N}, so its count is exactly ${FIELD_N}.`);
{
  const z = reads.get(0)!;
  console.log(`      floor    hit field members with maxPA < floor      pit field members with maxBF < floor`);
  for (const fl of FLOORS) {
    const dh = [...z.hitTopIds].filter((c) => (c.maxPA as number) < fl).length;
    const dp = [...z.pitTopIds].filter((c) => (c.maxBF as number) < fl).length;
    console.log(`      ${(String(fl) + (fl === PROD_FLOOR ? "*" : "")).padEnd(7)}  ${`${dh} of ${z.hitTopIds.size}`.padStart(36)}   ${`${dp} of ${z.pitTopIds.size}`.padStart(34)}`);
  }
  console.log(`      Retained membership at each floor vs the f=0 field (the same set, intersected):`);
  for (const fl of FLOORS) {
    const r = reads.get(fl)!;
    const kh = [...r.hitTopIds].filter((c) => z.hitTopIds.has(c)).length;
    const kp = [...r.pitTopIds].filter((c) => z.pitTopIds.has(c)).length;
    console.log(`      ${(String(fl) + (fl === PROD_FLOOR ? "*" : "")).padEnd(7)}  hit ${kh}/${r.hitTopIds.size} shared with the f=0 field   pit ${kp}/${r.pitTopIds.size} shared`);
  }
}

// ═══ 2. THE GAP CONSEQUENCE ══════════════════════════════════════════════════
console.log(`\n\n╔═══ 2. THE GAP CONSEQUENCE — buildFrameShift(trainingMeans@floor, poolField) per format ═══╗`);
console.log(`  The POOL leg is held at PRODUCTION exactly (variant-free eligible pool, TOP-${FIELD_N} field, each format`);
console.log(`  under its OWN resolved coeffs). Only the TRAIN leg moves, so every Δ below has one cause: the floor.`);
console.log(`  Channel crossing (§10.2): pit.stu ← train.hit.kRat − pool.hit.kRat;  hit.kRat ← train.pit.stu − pool.pit.stu.`);
console.log(`  The two SHIPPED ramps read pit.vR.stu (K) and pit.vR.hrr (HR9).`);

const shifts = new Map<string, Map<number, ReturnType<typeof buildFrameShift>>>();
for (const fm of FORMATS) {
  const m = new Map<number, ReturnType<typeof buildFrameShift>>();
  for (const fl of FLOORS) m.set(fl, buildFrameShift(reads.get(fl)!.means, fm.poolField));
  shifts.set(fm.key, m);
}

console.log(`\n── 2a. FORMAT RESOLUTION (pool leg — FULL-POOL counts; the field is TOP-${FIELD_N} of these) ──`);
console.log(`  format         tournament          era        park      window        rules   N pool   of which pit`);
for (const fm of FORMATS) {
  const w = `${fm.win.valueMin ?? 40}-${Number.isFinite(fm.win.valueMax) ? fm.win.valueMax : "∞"}`;
  console.log(`  ${fm.short.padEnd(13)} ${fm.t.id.padEnd(19)} ${fm.eraId.padEnd(10)} ${fm.parkId.padEnd(9)} ${w.padEnd(13)} ${String(fm.ruleCount).padStart(5)}   ${String(fm.nPool).padStart(6)}   ${String(fm.nPoolPit).padStart(12)}`);
}

console.log(`\n── 2b. THE HEADLINE CHANNEL: gap pit.vR.stu (the K-ramp input) ──`);
console.log(`  format         ${FLOORS.map((fl) => `f=${fl}${fl === PROD_FLOOR ? "*" : ""}`.padStart(9)).join("  ")}      │  ${FLOORS.filter((x) => x !== PROD_FLOOR).map((fl) => `Δ vs ${fl}`.padStart(9)).join("  ")}`);
for (const fm of FORMATS) {
  const m = shifts.get(fm.key)!;
  const v = FLOORS.map((fl) => m.get(fl)!.pit.vR.stu ?? 0);
  const p = m.get(PROD_FLOOR)!.pit.vR.stu ?? 0;
  console.log(`  ${fm.short.padEnd(13)} ${v.map((x) => f(x, 2).padStart(9)).join("  ")}      │  ${FLOORS.filter((x) => x !== PROD_FLOOR).map((fl) => sgn((m.get(fl)!.pit.vR.stu ?? 0) - p, 2).padStart(9)).join("  ")}`);
}
console.log(`  (Δ is stated as floor-f MINUS production, i.e. what moving OFF the production floor would do.)`);

console.log(`\n── 2c. THE HITTER COUNTERPART: gap hit.vR.kRat (the crossing partner of pit.vR.stu) ──`);
console.log(`  format         ${FLOORS.map((fl) => `f=${fl}${fl === PROD_FLOOR ? "*" : ""}`.padStart(9)).join("  ")}      │  ${FLOORS.filter((x) => x !== PROD_FLOOR).map((fl) => `Δ vs ${fl}`.padStart(9)).join("  ")}`);
for (const fm of FORMATS) {
  const m = shifts.get(fm.key)!;
  const v = FLOORS.map((fl) => m.get(fl)!.hit.vR.kRat ?? 0);
  const p = m.get(PROD_FLOOR)!.hit.vR.kRat ?? 0;
  console.log(`  ${fm.short.padEnd(13)} ${v.map((x) => f(x, 2).padStart(9)).join("  ")}      │  ${FLOORS.filter((x) => x !== PROD_FLOOR).map((fl) => sgn((m.get(fl)!.hit.vR.kRat ?? 0) - p, 2).padStart(9)).join("  ")}`);
}

console.log(`\n── 2d. EVERY CHANNEL, production floor vs each other floor (Δgap) ──`);
console.log(`  A gap Δ is the SAME for every format on a given channel+floor (the pool leg is held, so the move is`);
console.log(`  purely the training-mean move) — printed once per channel, with the per-format production level for scale.`);
const GAP_PIT = ["stu", "hrr", "con", "pbabip"] as const;
const GAP_HIT = ["kRat", "pow", "eye", "babip", "gap"] as const;
for (const [role, keys] of [["pit", GAP_PIT], ["hit", GAP_HIT]] as const) {
  console.log(`\n  ${role.toUpperCase()} channels — Δgap vs production, by floor (identical across all nine formats)`);
  console.log(`  channel     ${FLOORS.filter((x) => x !== PROD_FLOOR).map((fl) => `f=${fl}`.padStart(10)).join("  ")}      │  production gap range across the nine formats`);
  for (const k of keys) {
    const per = FLOORS.filter((x) => x !== PROD_FLOOR).map((fl) => {
      const ds = FORMATS.map((fm) => {
        const a = (shifts.get(fm.key)!.get(fl)![role].vR as Record<string, number | undefined>)[k] ?? 0;
        const b = (shifts.get(fm.key)!.get(PROD_FLOOR)![role].vR as Record<string, number | undefined>)[k] ?? 0;
        return a - b;
      });
      const lo = Math.min(...ds), hi = Math.max(...ds);
      return Math.abs(hi - lo) < 1e-6 ? sgn(lo, 2).padStart(10) : `${sgn(lo, 2)}..${sgn(hi, 2)}`.padStart(10);
    });
    const lvls = FORMATS.map((fm) => (shifts.get(fm.key)!.get(PROD_FLOOR)![role].vR as Record<string, number | undefined>)[k] ?? 0);
    console.log(`  ${k.padEnd(11)} ${per.join("  ")}      │  ${f(Math.min(...lvls), 2)} .. ${f(Math.max(...lvls), 2)}`);
  }
}

// ═══ 3. THE RAMP CONSEQUENCE ═════════════════════════════════════════════════
console.log(`\n\n╔═══ 3. THE RAMP CONSEQUENCE — the SHIPPED ramps evaluated at each floor's gap (NOT refit) ═══╗`);
console.log(`  s_K(g)  = 1 + ${K_SPREAD_PIT.A}·(min(g, ${K_SPREAD_PIT.gMax})/${K_SPREAD_PIT.G0})^${K_SPREAD_PIT.q},  g = frameShift.pit.vR.stu   (flat above gMax)`);
console.log(`  s_HR(g) = 1 + ${PIT_SPREAD_HR.A}·(1 − e^(−g/${PIT_SPREAD_HR.G})),  g = frameShift.pit.vR.hrr`);
console.log(`  Both are s(g ≤ 0) = 1 EXACTLY (league anchor). Constants quoted from src/model/pool-transform.ts.`);
console.log(`  CAVEAT, stated first: K_SPREAD_PIT and PIT_SPREAD_HR were FIT at the PRODUCTION-floor gap coordinate.`);
console.log(`  Evaluating them at another floor's gaps is not evidence about the ramps' adequacy — it measures how`);
console.log(`  much of the correction they currently deliver is a function of the floor choice, which is the question.`);
console.log(`\n  s_K by floor`);
console.log(`  format         ${FLOORS.map((fl) => `f=${fl}${fl === PROD_FLOOR ? "*" : ""}`.padStart(9)).join("  ")}   │  (s−1) as a share of the production (s−1)`);
for (const fm of FORMATS) {
  const m = shifts.get(fm.key)!;
  const s = FLOORS.map((fl) => kSpreadPitRamp(m.get(fl)!.pit.vR.stu ?? 0));
  const sp = kSpreadPitRamp(m.get(PROD_FLOOR)!.pit.vR.stu ?? 0);
  console.log(`  ${fm.short.padEnd(13)} ${s.map((x) => f(x, 4).padStart(9)).join("  ")}   │  ${FLOORS.map((fl, i) => `${f((s[i]! - 1) / (sp - 1) * 100, 0)}%`.padStart(6)).join(" ")}`);
}
console.log(`\n  s_HR by floor`);
console.log(`  format         ${FLOORS.map((fl) => `f=${fl}${fl === PROD_FLOOR ? "*" : ""}`.padStart(9)).join("  ")}   │  (s−1) as a share of the production (s−1)`);
for (const fm of FORMATS) {
  const m = shifts.get(fm.key)!;
  const s = FLOORS.map((fl) => pitSpreadHrRamp(m.get(fl)!.pit.vR.hrr ?? 0));
  const sp = pitSpreadHrRamp(m.get(PROD_FLOOR)!.pit.vR.hrr ?? 0);
  console.log(`  ${fm.short.padEnd(13)} ${s.map((x) => f(x, 4).padStart(9)).join("  ")}   │  ${FLOORS.map((fl, i) => `${f((s[i]! - 1) / (sp - 1) * 100, 0)}%`.padStart(6)).join(" ")}`);
}
console.log(`\n  ATTRIBUTABLE SHARE — how much of the correction each ramp ships today is the floor's doing:`);
console.log(`      floor share = (s_prod − s_0) / (s_prod − 1)`);
console.log(`  POSITIVE would mean the floor CREATES correction the no-floor frame would not ask for. NEGATIVE`);
console.log(`  means the floor SUPPRESSES correction the no-floor frame WOULD ask for — the ramp under-delivers`);
console.log(`  relative to its own no-floor coordinate. Read the sign first; it is the whole finding.`);
console.log(`  format         s_K prod   s_K f=0    floor share of the K correction   s_HR prod  s_HR f=0   floor share of the HR correction`);
for (const fm of FORMATS) {
  const m = shifts.get(fm.key)!;
  const kP = kSpreadPitRamp(m.get(PROD_FLOOR)!.pit.vR.stu ?? 0), k0 = kSpreadPitRamp(m.get(0)!.pit.vR.stu ?? 0);
  const hP = pitSpreadHrRamp(m.get(PROD_FLOOR)!.pit.vR.hrr ?? 0), h0 = pitSpreadHrRamp(m.get(0)!.pit.vR.hrr ?? 0);
  console.log(`  ${fm.short.padEnd(13)} ${f(kP, 4).padStart(8)}   ${f(k0, 4).padStart(8)}   ${`${sgn((kP - k0) / (kP - 1) * 100, 1)}%`.padStart(32)}   ${f(hP, 4).padStart(9)}  ${f(h0, 4).padStart(9)}   ${`${sgn((hP - h0) / (hP - 1) * 100, 1)}%`.padStart(32)}`);
}
console.log(`  Envelope across all FIVE floors (the full span the floor choice can move the shipped correction):`);
for (const fm of FORMATS) {
  const m = shifts.get(fm.key)!;
  const kP = kSpreadPitRamp(m.get(PROD_FLOOR)!.pit.vR.stu ?? 0);
  const ks = FLOORS.map((fl) => kSpreadPitRamp(m.get(fl)!.pit.vR.stu ?? 0));
  const hP = pitSpreadHrRamp(m.get(PROD_FLOOR)!.pit.vR.hrr ?? 0);
  const hs = FLOORS.map((fl) => pitSpreadHrRamp(m.get(fl)!.pit.vR.hrr ?? 0));
  const kShare = ks.map((s) => (kP - s) / (kP - 1) * 100), hShare = hs.map((s) => (hP - s) / (hP - 1) * 100);
  console.log(`    ${fm.short.padEnd(13)} s_K ∈ [${f(Math.min(...ks), 4)}, ${f(Math.max(...ks), 4)}] ⇒ floor share ∈ [${sgn(Math.min(...kShare), 1)}%, ${sgn(Math.max(...kShare), 1)}%]   s_HR ∈ [${f(Math.min(...hs), 4)}, ${f(Math.max(...hs), 4)}] ⇒ [${sgn(Math.min(...hShare), 1)}%, ${sgn(Math.max(...hShare), 1)}%]`);
}

// ═══ 4. CROSS-AXIS RANKING ═══════════════════════════════════════════════════
console.log(`\n\n╔═══ 4. RANKING THE THREE MISMATCHES on ONE ruler: Δ(gap pit.vR.stu) ═══╗`);
console.log(`  All three axes move the SAME number — the pit.vR.stu gap that feeds the K ramp — so they are directly`);
console.log(`  comparable in gap points and in ramp-correction share. The other two are quoted from their committed`);
console.log(`  artifacts, not recomputed here.`);
console.log(``);
console.log(`    axis                 source                                             Δ gap pit.vR.stu       direction`);
console.log(`    ──────────────────── ────────────────────────────────────────────────── ────────────────────── ─────────────`);
console.log(`    VARIANT   (item A)   fixtures/cwhit-itemA-variant-sizing-2026-07-21.txt  −4.6 .. −10.5          one-directional (−)`);
{
  const spans = FORMATS.map((fm) => {
    const m = shifts.get(fm.key)!;
    const p = m.get(PROD_FLOOR)!.pit.vR.stu ?? 0;
    const others = FLOORS.filter((x) => x !== PROD_FLOOR).map((fl) => (m.get(fl)!.pit.vR.stu ?? 0) - p);
    return { lo: Math.min(...others), hi: Math.max(...others), zero: (m.get(0)!.pit.vR.stu ?? 0) - p };
  });
  const lo = Math.min(...spans.map((s) => s.lo)), hi = Math.max(...spans.map((s) => s.hi));
  const z0lo = Math.min(...spans.map((s) => s.zero)), z0hi = Math.max(...spans.map((s) => s.zero));
  console.log(`    COHORT-N  (item B)   fixtures/cwhit-itemB-cohort-arbitration-2026-07-21  spans 57–117% of the   both (± by N)`);
  console.log(`                         .txt (N ∈ {25..200}, production N=${FIELD_N})                N=${FIELD_N} value`);
  console.log(`    USAGE-FLOOR (B1)     THIS TOOL, floors {${FLOORS.join(",")}}                 ${`${sgn(lo, 2)} .. ${sgn(hi, 2)}`.padEnd(22)} ${lo * hi > 0 ? "one-directional" : "BOTH SIGNS"}`);
  console.log(`                         of which the f=0 (no-floor) arm alone:                ${`${sgn(z0lo, 2)} .. ${sgn(z0hi, 2)}`.padEnd(22)}`);
  console.log(``);
  console.log(`  Same ruler, expressed as ramp-correction share so the axes are comparable to the item-B figure:`);
  const kShares = FORMATS.flatMap((fm) => {
    const m = shifts.get(fm.key)!;
    const sp = kSpreadPitRamp(m.get(PROD_FLOOR)!.pit.vR.stu ?? 0);
    return FLOORS.map((fl) => (kSpreadPitRamp(m.get(fl)!.pit.vR.stu ?? 0) - 1) / (sp - 1) * 100);
  });
  const dev = (lo: number, hi: number) => Math.max(Math.abs(lo - 100), Math.abs(hi - 100));
  console.log(`    axis                  s_K − 1 as % of its production value      max deviation from 100%`);
  console.log(`    USAGE-FLOOR (B1)      ${`${f(Math.min(...kShares), 0)}–${f(Math.max(...kShares), 0)}% (9 formats × 5 floors)`.padEnd(40)} ${f(dev(Math.min(...kShares), Math.max(...kShares)), 0)}%`);
  console.log(`    COHORT-N   (item B)   ${`53–110% (N ∈ {25..200})`.padEnd(40)} ${f(dev(53, 110), 0)}%   [quoted]`);
  console.log(`    VARIANT    (item A)   ${`0–82% (variant-inclusive pool, arm B)`.padEnd(40)} ${f(dev(0, 82), 0)}%   [quoted, §3 of that artifact]`);
  console.log(`    ⇒ ORDER, largest mismatch first: VARIANT ≫ COHORT-N ≳ USAGE-FLOOR. The variant axis can erase`);
  console.log(`      the K correction entirely at diamond (0%); the other two move it by at most ~half.`);
}
console.log(``);
console.log(`  REPORT-ONLY. Nothing here fits, changes a default, or touches production scoring. The deployed`);
console.log(`  artifact's trainingMeans is FROZEN at the production floor: every counterfactual frame above is`);
console.log(`  reachable only by RETRAINING, not by any config knob a running server exposes.`);
console.log(``);
console.log(`  corpus registry: ${CWHIT_CORPUS.length} formats captured; ${FORMATS.length} measured here (the five Quick tiers + four dailies).`);
console.log(``);
process.exit(0);
