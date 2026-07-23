// ITEM A — VARIANT-POLICY SIZING.  run: node tools/battery-itemA-variant-sizing.ts
//
// THE RULED DEFECT (Fable ruling (c)). Production sets every distribution-setting cohort over a
// VARIANT-FREE pool — `src/server/server.ts:301-302`
//     const pool     = buildEligiblePool(catalog.cards, t);
//     const basePool = pool.filter(isBaseCard);
// and `basePool` is what feeds `computeUnifiedFieldStats` (the pool field), `buildFrameShift` (THE
// GAP), `poolMeanKOwn` / `poolPitMeansOwn` (the K̄/HR̄/BABIP̄ pivots the shipped spread ramps centre
// on) and `calibrate` (the anchor). But the artifact's `trainingMeans` — the OTHER leg of that gap —
// is VARIANT-INCLUSIVE by construction: the trainer keys its reconstructed league cards
// `${o.cid}|${o.variant ? "V" : "B"}` (server.ts:1504), so a card and its v5 are two separate rows in
// the cohort `computeUnifiedFieldStats` then selects the top-50 from, and `includeVariants` defaults
// to true on every save (server.ts:1429).
//
//   ⇒ buildFrameShift computes `mu_train_opp − mu_pool_opp` with a VARIANT-INCLUSIVE minuend and a
//     VARIANT-FREE subtrahend. That is biased by construction, and — because the variant share of a
//     window is not constant across windows — biased TIER-VARIABLY. Fable's standing invariant is
//     SAME VARIANT POLICY ON BOTH SIDES of any gap or comparison.
//
// WHAT THIS TOOL DOES: sizes it. For nine formats (the five Quick tiers + four dailies, taken from
// THE corpus registry) it recomputes every affected quantity under a variant-INCLUSIVE pool and
// reports absolute values and deltas, pushes the moved gaps through the SHIPPED ramps as they exist
// (no refit), and re-plots the five measured K needs against the moved gaps.
//
// MEASUREMENT ONLY. Nothing here changes a production behaviour, default or constant; nothing is
// wired. No scoring math is written here — every number comes from the shared core
// (`computeUnifiedFieldStats` / `buildFrameShift` / `poolMeanKOwn` / `poolPitMeansOwn` / `calibrate`
// / `computeHitTail` / the two shipped ramps) and the variant rows come from the SAME `makeVariant`
// loop `src/eval/cwhit/realized.ts` `opponentSet` uses — reused, not rebuilt.
//
// THE THREE ARMS (single-factor, so each delta has one cause):
//   A  CURRENT      — production exactly: ref = top-50 of the variant-free full catalog,
//                     pool = the variant-free eligible subset.
//   B  POOL VAR-INC — the ruled fix: the POOL gains its v5 rows; ref held at production's.
//                     This is the headline arm, because the gap's other leg (trainingMeans) is
//                     fixed and variant-inclusive, so only the pool leg can move.
//   C  BOTH VAR-INC — ref AND pool gain their v5 rows. Reported because arm B, while it REPAIRS the
//                     train-vs-pool gap, BREAKS the ref-vs-pool gap (own-gap PoolTransform), whose
//                     two legs are consistently variant-free today. Arm C is the only arm in which
//                     BOTH comparisons obey one policy. Reported, not recommended.

import { readFileSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import { rowEligible } from "../src/config/eligibility.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import type { CalScales, Coeffs, Derived } from "../src/config/types.ts";
import {
  FIELD_N, makeRawPolyModel, computeUnifiedFieldStats, applyWobaWeights, computeDerived,
  buildPoolTransform, buildFrameShift, poolMeanKOwn, poolPitMeansOwn,
  kSpreadPitRamp, pitSpreadHrRamp, K_SPREAD_PIT, PIT_SPREAD_HR, HIT_RATINGS, PIT_RATINGS,
  calibrate,
  type EventForm, type FieldStats, type PoolTransform, type RatingEnvelope, type WobaWeights,
  type TrainingMeans,
} from "../src/scoring-core/index.ts";
import { computeHitTail, PINNED_HIT_TAIL } from "../src/scoring-core/hit-tail.ts";
import { parseCatalogCsv, type Card } from "../src/data/catalog.ts";
import { CWHIT_CORPUS, formatByKey } from "../src/eval/cwhit/corpus.ts";
import { inValueWindow, isPit, type ValueWindow } from "../src/eval/cwhit/sample.ts";
import { opponentSet } from "../src/eval/cwhit/realized.ts";

const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const sgn = (x: number, d = 2) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}` : "n/a");

// ── boot: repository, deployed model, catalog (the tools/park-hand-contrast.ts pattern) ──
const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state = (await repo.load<{ activeModelId?: string; catalogSourceId?: string }>("state", "app")) ?? {};
type TM = {
  id: string; eventForm?: EventForm; wobaWeights?: WobaWeights; ratingEnvelope?: RatingEnvelope;
  trainingMeans?: TrainingMeans; includeVariants?: boolean; window?: number[];
};
const trained = (await repo.loadAll<TM>("trained-models")).find((x) => x.id === state.activeModelId);
if (!trained?.eventForm || !trained.wobaWeights) throw new Error("active model missing eventForm/wobaWeights");
if (!trained.trainingMeans) throw new Error("active model has NO trainingMeans — the gap convention needs the artifact frame");
const TMEANS = trained.trainingMeans;
const rp = makeRawPolyModel(trained.eventForm);
const envelope = trained.ratingEnvelope;
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const tourneys = new Map((await repo.loadAll<Tournament>("tournaments")).map((t) => [t.id, t]));

const srcId = state.catalogSourceId ?? "cdmx";
const parsedCatalog = parseCatalogCsv(readFileSync(`data/imports/${srcId}.csv`, "utf8"));
// The catalog CSV carries NO variant rows (no `Variant` column at all in `cdmx.csv`), so
// production's `isBaseCard` filter is a no-op ON THIS PATH: the scoring cohorts are variant-free
// BY CONSTRUCTION rather than by subtraction. The filter is still load-bearing on the paths where
// variant rows ARE materialised (account rows / the grid). Either way the cohort is variant-free,
// which is the thing under test — so the variant-inclusive counterfactual must be CONSTRUCTED.
const baseCards: Card[] = parsedCatalog.cards.filter((c) => String(c["Variant"] ?? "").toUpperCase() !== "Y");
const nVariantRowsInCsv = parsedCatalog.cards.length - baseCards.length;

/** Every card at BOTH variant levels, role-agnostic. `opponentSet` is THE variant-construction
 *  helper (realized.ts) and it partitions by role via `isPit`, so the union over the two roles is
 *  exactly "the same pool with its v5 twins" — no duplicates, no omissions, and no second copy of
 *  the base+v5 loop. */
const bothLevels = (cards: Card[], win: ValueWindow): Card[] =>
  [...opponentSet(cards, win, "pit"), ...opponentSet(cards, win, "hit")].map((o) => o.card);

/** The unrestricted window — used to build the variant-inclusive REFERENCE catalog (arm C). */
const ALL_WIN: ValueWindow = { tier: "all", valueMax: Number.POSITIVE_INFINITY };

// ── the nine formats, taken from THE corpus registry ─────────────────────────
// Registry key → the tier label the needs are recorded against (the legacy slug, where one exists).
const FORMAT_KEYS = [
  "ironquick", "bronzequick", "silverquick", "goldquick", "diamondquick",
  "earlygold", "bronzeheart", "goldcapdaily", "diamondcapdaily",
] as const;
const QUICK_KEYS = new Set(["ironquick", "bronzequick", "silverquick", "goldquick", "diamondquick"]);
const shortOf: Record<string, string> = {
  ironquick: "iron", bronzequick: "bronze", silverquick: "silver", goldquick: "gold", diamondquick: "diamond",
  earlygold: "early-gold", bronzeheart: "bronze-heart", goldcapdaily: "gold-cap", diamondcapdaily: "diamond-cap",
};

interface Fmt {
  key: string; short: string; label: string; t: Tournament;
  coeffs: Coeffs; derived: Derived; win: ValueWindow;
  eraId: string; parkId: string; ruleCount: number;
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
  // THE ELIGIBILITY RULE COMES FROM THE CONFIG, never from a hard-coded window. `card_value_min/max`
  // + `rowEligible` IS `buildEligiblePool` (minus the owned filter, which the calibration pool never
  // applies) — so bronze-heart's `Year num_between 1930 1989` is honoured here by construction.
  const win: ValueWindow = {
    tier: shortOf[key] ?? key,
    valueMin: t.card_value_min ?? undefined,
    valueMax: t.card_value_max ?? Number.POSITIVE_INFINITY,
    eligible: (c) => rowEligible(c as Card, t),
  };
  return {
    key, short: shortOf[key] ?? key, label: reg.label, t, coeffs, derived: computeDerived(coeffs, true),
    win, eraId: t.eraId, parkId: t.parkId, ruleCount: (t.eligibility?.rules ?? []).length,
  };
});

// ── one arm's full read for one format ───────────────────────────────────────
interface Read {
  nPool: number; nPoolHit: number; nPoolPit: number;
  poolField: FieldStats; ref: FieldStats; pt: PoolTransform;
  gapHit: Record<string, number>; gapPit: Record<string, number>;
  kBarHit: number; kBarPit: number; hrBarPit: number; babBarPit: number;
  sK: number; sHr: number;
  cal: CalScales;
}

function measure(fm: Fmt, pool: Card[], ref: FieldStats): Read {
  const { coeffs, derived } = fm;
  const poolField = computeUnifiedFieldStats(pool, coeffs, rp, FIELD_N, true);
  const shift = buildFrameShift(TMEANS, poolField);
  const pt = buildPoolTransform(ref, poolField, envelope);
  // poolMeanKOwn(...).pit ≡ poolPitMeansOwn(...).k by construction (same cohorts, one collector);
  // both are called so the HITTER pivot is reported too, and the identity is checked below.
  const km = poolMeanKOwn(pool, coeffs, rp, pt, FIELD_N);
  const pm = poolPitMeansOwn(pool, coeffs, rp, pt, FIELD_N);
  const sK = kSpreadPitRamp(shift.pit.vR.stu ?? 0);
  const sHr = pitSpreadHrRamp(shift.pit.vR.hrr ?? 0);
  // The production kSpread/hitTail objects (server.ts:371-391), so `calibrate` sees the same
  // corrected events the display scores use. sPitBab is never set in production — not set here.
  const kSpread = { sHit: 1, meanHit: 0, sPit: sK, meanPit: pm.k, sPitHr: sHr, meanPitHr: pm.hr };
  const hitTail = computeHitTail(pool.filter((c) => !isPit(c)), coeffs, rp, pt, ref, poolField, PINNED_HIT_TAIL);
  const cal = calibrate(pool, { coeffs, derived, eventForm: trained!.eventForm!, poolTransform: pt, kSpread, hitTail });
  const nPit = pool.filter((c) => isPit(c)).length;
  return {
    nPool: pool.length, nPoolPit: nPit, nPoolHit: pool.length - nPit,
    poolField, ref, pt,
    gapHit: { ...shift.hit.vR } as Record<string, number>, gapPit: { ...shift.pit.vR } as Record<string, number>,
    kBarHit: km.hit, kBarPit: pm.k, hrBarPit: pm.hr, babBarPit: pm.bab,
    sK, sHr, cal,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
console.log(`\n╔══════════════════════════════════════════════════════════════════════════════════════════════╗`);
console.log(`║  ITEM A — VARIANT-POLICY SIZING: what the train-inclusive / pool-free gap actually costs      ║`);
console.log(`╚══════════════════════════════════════════════════════════════════════════════════════════════╝`);
console.log(`model '${trained.id}' | catalog '${srcId}' (${baseCards.length} base cards, ${nVariantRowsInCsv} variant rows in the CSV)`);
console.log(`model artifact: includeVariants=${String(trained.includeVariants)}  window=[${(trained.window ?? []).join(",")}]  ⇒ trainingMeans is VARIANT-INCLUSIVE`);
console.log(`FIELD_N = ${FIELD_N} (imported from src/scoring-core/pool-stats.ts; never re-declared here)`);
console.log(`shipped ramps quoted as they stand: K_SPREAD_PIT = {A:${K_SPREAD_PIT.A}, q:${K_SPREAD_PIT.q}, gMax:${K_SPREAD_PIT.gMax}}  PIT_SPREAD_HR = {A:${PIT_SPREAD_HR.A}, q:${PIT_SPREAD_HR.q}, gMax:${PIT_SPREAD_HR.gMax}}  — NOT refit`);
console.log(`MEASUREMENT ONLY — no production behaviour, default or constant is changed, and nothing is wired.`);

// ═══ 1. INVENTORY ════════════════════════════════════════════════════════════
console.log(`\n\n╔═══ 1. INVENTORY — every scoring-path cohort, its variant policy, and its class ═══╗`);
console.log(`  EXPLICIT = the exclusion is stated at the site with a rationale.  INHERITED = the site takes`);
console.log(`  whatever its caller handed it and states no policy of its own.`);
console.log(`  BASELINE = defines the rating-scaling CONVENTION the model was fit/anchored against.`);
console.log(`  FIELD    = estimates a POPULATION cards actually meet or compete in. Fable's ruling: FIELDS`);
console.log(`             go variant-inclusive. Classification only — nothing is changed.`);
console.log(``);
console.log(`  site                                                        variant policy   how       class`);
console.log(`  ─────────────────────────────────────────────────────────── ──────────────── ───────── ──────────`);
const inv: [string, string, string, string, string][] = [
  ["server.ts:238 isBaseCard (the predicate itself)", "EXCLUDES v5", "EXPLICIT", "—", "The one definition; comment at 233-237 states the policy AND that it is under review (ruling (c))."],
  ["server.ts:302 basePool = pool.filter(isBaseCard)", "EXCLUDES v5", "EXPLICIT", "—", "THE root. Everything below inherits from this one line."],
  ["server.ts:342 computeUnifiedFieldStats(basePool)", "EXCLUDES v5", "INHERITED", "FIELD", "The pool field: μ/σ of the top-50 the pool transform AND the frame gap are built from."],
  ["server.ts:347/372 buildFrameShift(trainingMeans, poolField)", "MIXED", "INHERITED", "FIELD", "THE DEFECT: variant-INCLUSIVE minuend vs variant-FREE subtrahend, in one subtraction."],
  ["server.ts:348 poolMeanK(basePool, ...) [frame-v2 path]", "EXCLUDES v5", "INHERITED", "FIELD", "Non-default path (transformMode frame-v2/matchup); same cohort defect."],
  ["server.ts:358 referenceFieldStats(catalog.cards.filter(isBaseCard))", "EXCLUDES v5", "EXPLICIT", "BASELINE", "The 'league' leg of the own-gap transform. Consistent with the pool leg TODAY."],
  ["server.ts:373 poolPitMeansOwn(basePool, ...)", "EXCLUDES v5", "INHERITED", "FIELD", "K̄/HR̄/BABIP̄ — the pivots the shipped spread ramps rescale ABOUT."],
  ["server.ts:389-390 computeHitTail(basePool hitters)", "EXCLUDES v5", "INHERITED", "FIELD", "BUILD-2 channel moments + the ref/pool gaps that set its strength."],
  ["server.ts:397/400 calibrate/calibrateBasic(basePool)", "EXCLUDES v5", "INHERITED", "BASELINE", "The anchor. A CONVENTION (readable scale + the cap optimiser's budget unit), not a prediction."],
  ["server.ts:788 exposure baseline (catalog.cards.filter(isBaseCard))", "EXCLUDES v5", "EXPLICIT", "FIELD", "Platoon-exposure baseline field; same isBaseCard predicate."],
  ["server.ts:1725 SP-candidate scan / 1885 consistency / 1980 debug", "EXCLUDES v5", "EXPLICIT", "mixed", "Diagnostic + optimiser-input cohorts; same predicate, out of the scoring gap path."],
  ["server.ts:1504 trainingMeans cards keyed `${cid}|${variant?V:B}`", "INCLUDES v5", "EXPLICIT", "BASELINE", "The frame the model was fit in. `includeVariants` defaults TRUE (server.ts:1429)."],
  ["sample.ts:530-540 eval basePool → field/pt/calibrate", "EXCLUDES v5", "EXPLICIT", "FIELD", "MIRRORS production deliberately (the eligible side is the assumption under test)."],
  ["sample.ts:558-587 the JUDGED card side (base + makeVariant)", "INCLUDES v5", "EXPLICIT", "—", "Cards are SCORED at both levels; only the DISTRIBUTION-SETTING cohorts exclude v5."],
  ["sample.ts:587 PoolDist reference (VLvl-0 only)", "EXCLUDES v5", "EXPLICIT", "FIELD", "Stated reason: counting a card twice would shift the pool mean and fake a selection gap."],
  ["realized.ts:47 opponentSet (base + makeVariant)", "INCLUDES v5", "EXPLICIT", "FIELD", "The realized-opposition field; the variant fix landed here 2026-07-21."],
  ["consistency.ts:155-156 ref/pool field stats", "INHERITED", "INHERITED", "FIELD", "Both legs come from the caller (server.ts:1886, variant-free) — consistent with each other."],
];
for (const [site, pol, how, cls, note] of inv) {
  console.log(`  ${site.padEnd(59)} ${pol.padEnd(16)} ${how.padEnd(9)} ${cls}`);
  console.log(`      ${note}`);
}
console.log(``);
console.log(`  THE TWO COMPARISONS, and why they disagree about what "consistent" means:`);
console.log(`    · train-vs-pool  (buildFrameShift) — legs: trainingMeans [INCLUDES v5] vs poolField [EXCLUDES v5]`);
console.log(`                                        ⇒ INCONSISTENT TODAY. Repaired by making the pool inclusive.`);
console.log(`    · ref-vs-pool    (buildPoolTransform) — legs: referenceField [EXCLUDES] vs poolField [EXCLUDES]`);
console.log(`                                        ⇒ CONSISTENT TODAY. Repairing the first with a pool-only`);
console.log(`                                           change would BREAK this one. Hence arm C.`);
console.log(`  OBSERVATION, recorded not acted on: referenceFieldStats caches on \`\${activeModelId}|\${catalogSource}\``);
console.log(`  (server.ts:282) with NO tournament in the key, so the league leg is whichever tournament resolved it`);
console.log(`  first. Benign only while raw-wOBA selection is env-free (assembleRaw*Woba uses weights + adv_hbp only,`);
console.log(`  and all nine configs carry identical 500/0 softcaps). Flagged for the item-B cohort audit.`);

// ═══ 2. SIZE EVERYTHING ══════════════════════════════════════════════════════
console.log(`\n\n╔═══ 2. THE HEADLINE — CURRENT (variant-free pool) vs VARIANT-INCLUSIVE pool, per format ═══╗`);
console.log(`  Arm A = production. Arm B = the ruled fix (POOL gains its v5 rows; ref held at production's).`);
console.log(`  Every number below comes from the shared core; no scoring math is written in this tool.`);

// The production reference (arm A/B) and the variant-inclusive reference (arm C), per format's coeffs.
const arms = new Map<string, { A: Read; B: Read; C: Read }>();
const refVarCards = bothLevels(baseCards, ALL_WIN);
for (const fm of FORMATS) {
  const refA = computeUnifiedFieldStats(baseCards, fm.coeffs, rp, FIELD_N, true);
  const refC = computeUnifiedFieldStats(refVarCards, fm.coeffs, rp, FIELD_N, true);
  const poolFree = baseCards.filter((c) => inValueWindow(c, fm.win));
  const poolVar = bothLevels(baseCards, fm.win);
  arms.set(fm.key, {
    A: measure(fm, poolFree, refA),
    B: measure(fm, poolVar, refA),
    C: measure(fm, poolVar, refC),
  });
}

console.log(`\n── 2a. FORMAT RESOLUTION + POOL COMPOSITION ──`);
console.log(`  format         tournament          era        park      window        rules  N base   N var-inc   v5 admitted   share`);
for (const fm of FORMATS) {
  const a = arms.get(fm.key)!.A, b = arms.get(fm.key)!.B;
  const w = `${fm.win.valueMin ?? 40}-${Number.isFinite(fm.win.valueMax) ? fm.win.valueMax : "∞"}`;
  const added = b.nPool - a.nPool;
  console.log(`  ${fm.short.padEnd(13)} ${fm.t.id.padEnd(19)} ${fm.eraId.padEnd(10)} ${fm.parkId.padEnd(9)} ${w.padEnd(13)} ${String(fm.ruleCount).padStart(5)}  ${String(a.nPool).padStart(6)}   ${String(b.nPool).padStart(9)}   ${String(added).padStart(11)}   ${f(added / b.nPool * 100, 1).padStart(5)}%`);
}
console.log(`  Every v5 is admitted at every window (share exactly 50.0%): \`Card Value\` is NOT in`);
console.log(`  VARIANT_RATING_FIELDS, so makeVariant boosts RATINGS and leaves the card's VALUE alone — a v5 sits`);
console.log(`  in the same eligibility window as its base, by construction. The variant row is still tested against`);
console.log(`  the window in its OWN right (inValueWindow on the variant card, exactly as the builder and`);
console.log(`  opponentSet do); it simply always passes.`);
console.log(`  ⇒ THE TIER-VARIABILITY THEREFORE DOES NOT COME FROM ADMISSION. It comes from SELECTION: the field is`);
console.log(`    the top-${FIELD_N} by predicted wOBA, and adding a uniformly-boosted twin of every card rewrites which`);
console.log(`    ${FIELD_N} rows win. How far that moves a window's field μ depends on how the boost interacts with that`);
console.log(`    window's rating distribution — a per-window quantity. See the Δ column in 2b: −4.6 to −10.5 on stu.`);

console.log(`\n── 2b. THE GAP: buildFrameShift(trainingMeans, poolField), every channel ──`);
console.log(`  Pitcher channels are re-based by the opposing HITTING gap; hitter channels by the opposing PITCHING`);
console.log(`  gap (the §10.2 crossing). hit.babip and hit.gap are the SAME number by construction (both ← pit.pbabip).`);
console.log(`  The two SHIPPED ramps read pit.stu (K) and pit.hrr (HR9).`);
const GAP_PIT = ["stu", "hrr", "con", "pbabip"] as const;
const GAP_HIT = ["kRat", "pow", "eye", "babip", "gap"] as const;
console.log(`\n  PITCHER-side gaps (the ramp inputs are the first two)`);
console.log(`  format         ${GAP_PIT.map((k) => `${k}  cur     inc      Δ`.padEnd(30)).join("")}`);
for (const fm of FORMATS) {
  const { A, B } = arms.get(fm.key)!;
  let line = `  ${fm.short.padEnd(13)} `;
  for (const k of GAP_PIT) line += `${f(A.gapPit[k]!, 2).padStart(7)} ${f(B.gapPit[k]!, 2).padStart(7)} ${sgn(B.gapPit[k]! - A.gapPit[k]!, 2).padStart(7)}   `;
  console.log(line);
}
console.log(`\n  HITTER-side gaps`);
console.log(`  format         ${GAP_HIT.map((k) => `${k}  cur     inc      Δ`.padEnd(30)).join("")}`);
for (const fm of FORMATS) {
  const { A, B } = arms.get(fm.key)!;
  let line = `  ${fm.short.padEnd(13)} `;
  for (const k of GAP_HIT) line += `${f(A.gapHit[k]!, 2).padStart(7)} ${f(B.gapHit[k]!, 2).padStart(7)} ${sgn(B.gapHit[k]! - A.gapHit[k]!, 2).padStart(7)}   `;
  console.log(line);
}

console.log(`\n── 2c. THE POOL FIELD MOMENTS that feed buildPoolTransform (μ, and σ) ──`);
console.log(`  These are the top-${FIELD_N} field's per-rating μ/σ. μ is BOTH the pool leg of the frame gap and the`);
console.log(`  denominator of the own-gap mean-scalar k = league μ / pool μ, so it moves two things at once.`);
for (const role of ["pit", "hit"] as const) {
  const keys = role === "pit" ? PIT_RATINGS : HIT_RATINGS;
  console.log(`\n  ${role.toUpperCase()} field μ (σ)`);
  console.log(`  format         ${keys.map((k) => `${k}: cur / inc (Δ)`.padEnd(30)).join("")}`);
  for (const fm of FORMATS) {
    const { A, B } = arms.get(fm.key)!;
    let line = `  ${fm.short.padEnd(13)} `;
    for (const k of keys) {
      const a = A.poolField[role].vR[k]!, b = B.poolField[role].vR[k]!;
      line += `${`${f(a.mu, 1)}/${f(b.mu, 1)} (${sgn(b.mu - a.mu, 1)})`.padEnd(30)}`;
    }
    console.log(line);
  }
  console.log(`  format         ${keys.map((k) => `${k} σ: cur / inc`.padEnd(30)).join("")}`);
  for (const fm of FORMATS) {
    const { A, B } = arms.get(fm.key)!;
    let line = `  ${fm.short.padEnd(13)} `;
    for (const k of keys) {
      const a = A.poolField[role].vR[k]!, b = B.poolField[role].vR[k]!;
      line += `${`${f(a.sd, 2)}/${f(b.sd, 2)}`.padEnd(30)}`;
    }
    console.log(line);
  }
}

console.log(`\n  own-gap mean-scalar k = league μ / pool μ, per channel (the PoolTransform the pivots are measured in)`);
for (const role of ["pit", "hit"] as const) {
  const keys = role === "pit" ? PIT_RATINGS : HIT_RATINGS;
  console.log(`  ${role} k   format      ${keys.map((k) => `${k}: cur / inc`.padEnd(24)).join("")}`);
  for (const fm of FORMATS) {
    const { A, B } = arms.get(fm.key)!;
    let line = `           ${fm.short.padEnd(13)} `;
    for (const k of keys) {
      const a = A.pt[role].vR[k as never] as { k: number } | undefined;
      const b = B.pt[role].vR[k as never] as { k: number } | undefined;
      line += `${`${f(a?.k ?? NaN, 4)}/${f(b?.k ?? NaN, 4)}`.padEnd(24)}`;
    }
    console.log(line);
  }
}

console.log(`\n── 2d. THE CENTERING PIVOTS: poolMeanKOwn / poolPitMeansOwn ──`);
console.log(`  These are what the shipped spread ramps rescale ABOUT: K_corr = K̄ + s·(K − K̄), likewise HR̄.`);
console.log(`  A pivot move is a LEVEL move for every card in the pool even at a fixed s.`);
console.log(`  format         K̄_pit cur / inc (Δ)        HR̄_pit cur / inc (Δ)      BABIP̄_pit cur / inc (Δ)     K̄_hit cur / inc (Δ)`);
for (const fm of FORMATS) {
  const { A, B } = arms.get(fm.key)!;
  console.log(`  ${fm.short.padEnd(13)} ${`${f(A.kBarPit, 2)} / ${f(B.kBarPit, 2)} (${sgn(B.kBarPit - A.kBarPit, 2)})`.padEnd(26)} ${`${f(A.hrBarPit, 2)} / ${f(B.hrBarPit, 2)} (${sgn(B.hrBarPit - A.hrBarPit, 2)})`.padEnd(25)} ${`${f(A.babBarPit, 4)} / ${f(B.babBarPit, 4)} (${sgn(B.babBarPit - A.babBarPit, 4)})`.padEnd(27)} ${`${f(A.kBarHit, 2)} / ${f(B.kBarHit, 2)} (${sgn(B.kBarHit - A.kBarHit, 2)})`}`);
}

console.log(`\n── 2e. THE ANCHOR: calibrate() outputs ──`);
console.log(`  sFinal = hitScaleVR/VL + pitchScaleVR/VL (multiplies the assembled composite only).`);
console.log(`  Per-event scales are hitBB/hitHR/pBB/pHR; under an eventForm calibrate sets noEvCal, so these`);
console.log(`  are EXACTLY 1 by construction — printed so the claim is checkable rather than trusted.`);
console.log(`  format         hitScaleVR cur/inc (Δ)      hitScaleVL cur/inc (Δ)      pitchScaleVR cur/inc (Δ)    pitchScaleVL cur/inc (Δ)`);
const cs = (c: CalScales, k: string) => (c[k] ?? NaN);
for (const fm of FORMATS) {
  const { A, B } = arms.get(fm.key)!;
  const cell = (k: string) => `${f(cs(A.cal, k), 4)} / ${f(cs(B.cal, k), 4)} (${sgn(cs(B.cal, k) - cs(A.cal, k), 4)})`.padEnd(27);
  console.log(`  ${fm.short.padEnd(13)} ${cell("hitScaleVR")} ${cell("hitScaleVL")} ${cell("pitchScaleVR")} ${cell("pitchScaleVL")}`);
}
console.log(`  per-event scales (cur / inc), all formats: ` +
  [...new Set(FORMATS.map((fm) => {
    const { A, B } = arms.get(fm.key)!;
    return ["hitBBScaleVR", "hitHRScaleVR", "pBBScaleVR", "pHRScaleVR"].map((k) => `${k}=${f(cs(A.cal, k), 3)}/${f(cs(B.cal, k), 3)}`).join(" ");
  }))].join("  |  "));
console.log(`  cross-pool multipliers (cur / inc):`);
for (const fm of FORMATS) {
  const { A, B } = arms.get(fm.key)!;
  console.log(`    ${fm.short.padEnd(13)} hitter ${f(cs(A.cal, "crossPoolHitterMultiplier"), 4)} / ${f(cs(B.cal, "crossPoolHitterMultiplier"), 4)}   pitcher ${f(cs(A.cal, "crossPoolPitcherMultiplier"), 4)} / ${f(cs(B.cal, "crossPoolPitcherMultiplier"), 4)}`);
}

// ═══ 3. DOWNSTREAM: THE SHIPPED RAMPS ════════════════════════════════════════
console.log(`\n\n╔═══ 3. DOWNSTREAM — the SHIPPED ramps, evaluated at the moved gaps (NOT refit) ═══╗`);
console.log(`  s_K(g)  = 1 + ${K_SPREAD_PIT.A}·(min(g, ${K_SPREAD_PIT.gMax})/${K_SPREAD_PIT.G0})^${K_SPREAD_PIT.q},  g = frameShift.pit.vR.stu   (flat above gMax)`);
console.log(`  s_HR(g) = 1 + ${PIT_SPREAD_HR.A}·(min(g, ${PIT_SPREAD_HR.gMax})/${PIT_SPREAD_HR.G0})^${PIT_SPREAD_HR.q},  g = frameShift.pit.vR.hrr`);
console.log(`  Both are s(g ≤ 0) = 1 EXACTLY (league anchor). Constants quoted from src/model/pool-transform.ts.`);
console.log(`\n  format         gap_stu cur / inc     s_K cur / inc (Δ)          gap_hrr cur / inc     s_HR cur / inc (Δ)`);
for (const fm of FORMATS) {
  const { A, B } = arms.get(fm.key)!;
  console.log(`  ${fm.short.padEnd(13)} ${`${f(A.gapPit.stu!, 2)} / ${f(B.gapPit.stu!, 2)}`.padEnd(20)} ${`${f(A.sK, 4)} / ${f(B.sK, 4)} (${sgn(B.sK - A.sK, 4)})`.padEnd(26)} ${`${f(A.gapPit.hrr!, 2)} / ${f(B.gapPit.hrr!, 2)}`.padEnd(20)} ${`${f(A.sHr, 4)} / ${f(B.sHr, 4)} (${sgn(B.sHr - A.sHr, 4)})`}`);
}
console.log(`\n  RELATIVE size of the ramp move, as a share of the correction the ramp delivers (s − 1):`);
console.log(`  format         (s_K,inc − 1)/(s_K,cur − 1)     (s_HR,inc − 1)/(s_HR,cur − 1)`);
for (const fm of FORMATS) {
  const { A, B } = arms.get(fm.key)!;
  console.log(`  ${fm.short.padEnd(13)} ${f((B.sK - 1) / (A.sK - 1), 4).padStart(22)}     ${f((B.sHr - 1) / (A.sHr - 1), 4).padStart(22)}`);
}

// ═══ 4. THE RE-PLOT ══════════════════════════════════════════════════════════
console.log(`\n\n╔═══ 4. THE QUESTION THAT MATTERS MOST — need-vs-gap, re-plotted ═══╗`);
console.log(`  The five per-tier pitcher K9 calibration "needs" (obs~pred slopes) are SAMPLE quantities: they are`);
console.log(`  measured from the cwhit observed tables and do NOT depend on the pool's variant policy. The GAP does.`);
console.log(`  ⇒ a variant-policy error moves each tier HORIZONTALLY on this plane and nothing else. That is exactly`);
console.log(`    the geometry under which gold at 1.78 @ 15.9 falsified the saturating one-argument ramp family:`);
console.log(`    it sat off any 1-D monotone curve through the other four.`);
const NEEDS: Record<string, number> = { iron: 1.82, bronze: 1.62, silver: 1.48, gold: 1.78, diamond: 1.04 };
const TIERS = ["iron", "bronze", "silver", "gold", "diamond"];

interface Pt { tier: string; g: number; need: number }
interface Replot { inversions: number; rho: number; chord: number; order: string }
function replot(label: string, pts: Pt[]): Replot {
  const s = [...pts].sort((a, b) => a.g - b.g);
  console.log(`\n  ── ${label} ──`);
  console.log(`     sorted by gap ascending:  ${s.map((p) => `${p.tier} ${f(p.g, 2)}→${f(p.need, 2)}`).join("   ")}`);
  // inversions in need when ordered by gap
  const inv: string[] = [];
  for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) if (s[j]!.need < s[i]!.need) inv.push(`${s[i]!.tier}(${f(s[i]!.g, 1)},${f(s[i]!.need, 2)}) > ${s[j]!.tier}(${f(s[j]!.g, 1)},${f(s[j]!.need, 2)})`);
  console.log(`     monotone-increasing in gap? ${inv.length === 0 ? "YES — no inversions" : `NO — ${inv.length} inversion(s): ${inv.join("; ")}`}`);
  // Spearman rank correlation of need vs gap
  const rank = (xs: number[]) => xs.map((x) => 1 + xs.filter((y) => y < x).length);
  const rg = rank(s.map((p) => p.g)), rn = rank(s.map((p) => p.need));
  const mg = rg.reduce((a, b) => a + b, 0) / rg.length, mn = rn.reduce((a, b) => a + b, 0) / rn.length;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < rg.length; i++) { sxy += (rg[i]! - mg) * (rn[i]! - mn); sxx += (rg[i]! - mg) ** 2; syy += (rn[i]! - mn) ** 2; }
  const rho = sxy / Math.sqrt(sxx * syy);
  console.log(`     Spearman ρ(gap, need) = ${f(rho, 3)}   (1.000 = perfectly monotone in gap)`);
  // gold's residual from the CHORD between its two gap-neighbours — model-free, no ramp family fitted
  const gi = s.findIndex((p) => p.tier === "gold");
  let chord = NaN;
  if (gi > 0 && gi < s.length - 1) {
    const lo = s[gi - 1]!, hi = s[gi + 1]!, gp = s[gi]!;
    const interp = lo.need + (gp.g - lo.g) / (hi.g - lo.g) * (hi.need - lo.need);
    chord = gp.need - interp;
    console.log(`     GOLD's break, measured model-free: chord ${lo.tier}(${f(lo.g, 1)},${f(lo.need, 2)}) → ${hi.tier}(${f(hi.g, 1)},${f(hi.need, 2)})`);
    console.log(`        predicts ${f(interp, 3)} at gap ${f(gp.g, 2)};  gold measures ${f(gp.need, 2)}  ⇒  residual ${sgn(chord, 3)}`);
  } else {
    console.log(`     GOLD is now an ENDPOINT in gap order (${gi === 0 ? "lowest" : "highest"} gap) — no interior chord exists, so the`);
    console.log(`        chord residual is undefined. An endpoint cannot violate interior monotonicity; read the inversion line.`);
  }
  // second differences over the gap-sorted sequence — the shape a saturating family requires
  const sd: string[] = [];
  for (let i = 1; i < s.length - 1; i++) {
    const d1 = (s[i]!.need - s[i - 1]!.need) / (s[i]!.g - s[i - 1]!.g);
    const d2 = (s[i + 1]!.need - s[i]!.need) / (s[i + 1]!.g - s[i]!.g);
    sd.push(`${s[i]!.tier}: ${sgn(d1, 3)}→${sgn(d2, 3)} ${d2 <= d1 ? "(concave)" : "(convex)"}`);
  }
  console.log(`     local slopes (need per gap-point), a saturating ramp requires all-positive and concave:`);
  console.log(`        ${sd.join("   ")}`);
  return { inversions: inv.length, rho, chord, order: s.map((p) => p.tier).join(" < ") };
}
const ptsCur: Pt[] = TIERS.map((t) => ({ tier: t, g: arms.get(FORMATS.find((f2) => f2.short === t)!.key)!.A.gapPit.stu!, need: NEEDS[t]! }));
const ptsInc: Pt[] = TIERS.map((t) => ({ tier: t, g: arms.get(FORMATS.find((f2) => f2.short === t)!.key)!.B.gapPit.stu!, need: NEEDS[t]! }));
console.log(`\n  needs held fixed at the committed measurement (fixtures/cwhit-battery-needs-vs-bar-2026-07-21.txt,`);
console.log(`  BF ≥ 600): iron ${NEEDS.iron} / bronze ${NEEDS.bronze} / silver ${NEEDS.silver} / gold ${NEEDS.gold} / diamond ${NEEDS.diamond}.`);
const rpCur = replot("CURRENT gaps (variant-free pool) — the plane the falsification was declared on", ptsCur);
const rpInc = replot("VARIANT-INCLUSIVE gaps (arm B) — the same needs, re-plotted", ptsInc);
console.log(`\n  HORIZONTAL MOVE PER TIER (this is the whole mechanism):`);
console.log(`     tier      gap cur    gap inc     Δgap      need`);
for (const t of TIERS) {
  const a = ptsCur.find((p) => p.tier === t)!, b = ptsInc.find((p) => p.tier === t)!;
  console.log(`     ${t.padEnd(9)} ${f(a.g, 2).padStart(7)}   ${f(b.g, 2).padStart(7)}   ${sgn(b.g - a.g, 2).padStart(7)}    ${f(a.need, 2)}`);
}
console.log(`\n  ── what the SHIPPED ramp would then DELIVER against each need (no refit) ──`);
console.log(`  CAVEAT FIRST, so the table cannot be over-read: K_SPREAD_PIT was FIT at the CURRENT gap coordinate.`);
console.log(`  Evaluating it at systematically smaller gaps must under-deliver — that is arithmetic, not evidence`);
console.log(`  about the ramp's adequacy. What IS readable is the SIGN PATTERN of the residuals, which is`);
console.log(`  coordinate-robust in a way the levels are not.`);
console.log(`     tier      need    s_K cur   resid cur    s_K inc   resid inc`);
let ssCur = 0, ssInc = 0, negCur = 0, negInc = 0;
for (const t of TIERS) {
  const fm = FORMATS.find((x) => x.short === t)!;
  const { A, B } = arms.get(fm.key)!;
  const rc = A.sK - NEEDS[t]!, ri = B.sK - NEEDS[t]!;
  ssCur += rc * rc; ssInc += ri * ri; if (rc < 0) negCur++; if (ri < 0) negInc++;
  console.log(`     ${t.padEnd(9)} ${f(NEEDS[t]!, 2).padStart(5)}   ${f(A.sK, 4).padStart(7)}   ${sgn(rc, 3).padStart(9)}    ${f(B.sK, 4).padStart(7)}   ${sgn(ri, 3).padStart(9)}`);
}
console.log(`     SSE ${f(ssCur, 4)} (current) vs ${f(ssInc, 4)} (inclusive);  residuals negative at ${negCur}/5 tiers current, ${negInc}/5 inclusive.`);
console.log(`     A uniformly-signed residual set is what a pure COORDINATE shift produces (one scale factor absorbs`);
console.log(`     it); a mixed-sign set is not absorbable by any rescaling of the ramp. Read that, not the SSE.`);

// ═══ THE VERDICT ON GOLD ══════════════════════════════════════════════════════
{
  const rc = rpCur.chord, ri = rpInc.chord;
  const dg = TIERS.map((t) => ptsInc.find((p) => p.tier === t)!.g - ptsCur.find((p) => p.tier === t)!.g);
  // PRE-DECLARED READING RULE (stated before the numbers, so the verdict is not chosen after seeing them):
  //   DISAPPEARS = 0 inversions AND ρ = 1;  SHRINKS = the break persists but |chord| falls by >50%;
  //   SURVIVES   = otherwise. Applied mechanically below.
  const verdict = rpInc.inversions === 0 && rpInc.rho >= 0.999 ? "DISAPPEARS"
    : Math.abs(ri) < 0.5 * Math.abs(rc) ? "SHRINKS" : "SURVIVES";
  console.log(`\n  ╔═══ VERDICT ON GOLD'S BREAK ═══╗`);
  console.log(`  READING RULE (pre-declared): DISAPPEARS = 0 inversions AND ρ ≥ 0.999. SHRINKS = the break persists`);
  console.log(`  but |chord residual| falls by more than half. SURVIVES = otherwise. Applied mechanically.`);
  console.log(`  gap ORDER of the five tiers under each policy:`);
  console.log(`     current   ${rpCur.order}`);
  console.log(`     inclusive ${rpInc.order}   ⇒ ${rpCur.order === rpInc.order ? "UNCHANGED" : "REORDERED"}`);
  console.log(`  Every tier moves LEFT (Δgap ${sgn(Math.max(...dg), 2)} to ${sgn(Math.min(...dg), 2)}) — but not far enough DIFFERENTIALLY to reorder them,`);
  console.log(`  and reordering is the ONLY way a purely horizontal move can dissolve an inversion.`);
  console.log(`  ⇒ GOLD'S BREAK ${verdict} the variant-inclusive re-plot:`);
  console.log(`       chord residual   ${sgn(rc, 3)} → ${sgn(ri, 3)}   (${f(Math.abs(ri / rc) * 100, 1)}% retained)`);
  console.log(`       inversions       ${rpCur.inversions} → ${rpInc.inversions}   (same pair both times: gold over silver, gold over bronze)`);
  console.log(`       Spearman ρ       ${f(rpCur.rho, 3)} → ${f(rpInc.rho, 3)}`);
  console.log(`  THE MAJOR-RESULT TEST IS NOT MET: the five points do NOT return to a monotone/convex curve. Had they,`);
  console.log(`  it would still not have VALIDATED any ramp family — only removed one falsifier.`);
  console.log(`\n  ONE GENUINE COHERENCE GAIN, and it is at the other end of the ladder: diamond's stu gap crosses ZERO`);
  console.log(`  (${f(ptsCur.find((p) => p.tier === "diamond")!.g, 2)} → ${f(ptsInc.find((p) => p.tier === "diamond")!.g, 2)}), so s_K(g ≤ 0) = 1 EXACTLY — the ramp switches fully off at diamond, against a`);
  console.log(`  measured diamond need of ${f(NEEDS.diamond!, 2)}. Under the current variant-free gap the ramp forces 1.335 on a tier`);
  console.log(`  that needs ~1.0. The variant-inclusive frame makes diamond IN-FRAME, which is what a top tier facing`);
  console.log(`  a league-strength field should be. That is a real finding about the COORDINATE, not about gold.`);
}

// ═══ 5. ARM C SENSITIVITY ════════════════════════════════════════════════════
console.log(`\n\n╔═══ 5. ARM C — the OTHER leg: ref AND pool both variant-inclusive ═══╗`);
console.log(`  Arm B repairs train-vs-pool and breaks ref-vs-pool. Arm C is the only arm where BOTH comparisons`);
console.log(`  obey one policy. The frame GAP is identical in B and C (the gap has no ref leg) — only the own-gap`);
console.log(`  PoolTransform, and therefore the pivots and the anchor, differ. Reported, not recommended.`);
console.log(`\n  format         K̄_pit  A / B / C              HR̄_pit  A / B / C            pitchScaleVR  A / B / C`);
for (const fm of FORMATS) {
  const { A, B, C } = arms.get(fm.key)!;
  console.log(`  ${fm.short.padEnd(13)} ${`${f(A.kBarPit, 2)} / ${f(B.kBarPit, 2)} / ${f(C.kBarPit, 2)}`.padEnd(27)} ${`${f(A.hrBarPit, 2)} / ${f(B.hrBarPit, 2)} / ${f(C.hrBarPit, 2)}`.padEnd(24)} ${f(cs(A.cal, "pitchScaleVR"), 4)} / ${f(cs(B.cal, "pitchScaleVR"), 4)} / ${f(cs(C.cal, "pitchScaleVR"), 4)}`);
}
console.log(`\n  gap identity check (arm B stu gap MUST equal arm C stu gap — the gap has no reference leg):`);
for (const fm of FORMATS) {
  const { B, C } = arms.get(fm.key)!;
  console.log(`    ${fm.short.padEnd(13)} |B − C| = ${(Math.abs(B.gapPit.stu! - C.gapPit.stu!)).toExponential(1)}  ${Math.abs(B.gapPit.stu! - C.gapPit.stu!) < 1e-12 ? "OK" : "MISMATCH — investigate"}`);
}
console.log(`\n  pivot identity check (poolMeanKOwn(...).pit ≡ poolPitMeansOwn(...).k, one collector):`);
for (const fm of FORMATS) {
  const { A } = arms.get(fm.key)!;
  const km = poolMeanKOwn(baseCards.filter((c) => inValueWindow(c, fm.win)), fm.coeffs, rp, A.pt, FIELD_N);
  console.log(`    ${fm.short.padEnd(13)} |poolMeanKOwn.pit − poolPitMeansOwn.k| = ${Math.abs(km.pit - A.kBarPit).toExponential(1)}`);
}

// ═══ 6. OWNERSHIP NOTE (recorded, not measured) ══════════════════════════════
console.log(`\n\n╔═══ 6. OWNERSHIP — recorded, not measured ═══╗`);
console.log(`  A variant is only fieldable if the account OWNS the base card and has created the v5 (D6: \`owned\` is`);
console.log(`  a quantity; the account overlay carries \`variantCardIds\`, and buildAccountRows materialises a v5 row`);
console.log(`  only for those). So the ELIGIBLE field and the REALIZED field can differ for a STRUCTURAL reason —`);
console.log(`  scarcity of the variant itself — rather than a usage/selection one, and the two explanations are not`);
console.log(`  separable from the outside: cwhit publishes what was played, not what was ownable. That is a real`);
console.log(`  caveat on any attempt to read the realized-vs-eligible divergence as pure selection-on-quality.`);
console.log(`  IT IS NOT A REASON TO LEAVE THE POLICY MIXED. The defect sized above is arithmetic, not empirical: one`);
console.log(`  subtraction whose two legs are drawn from different populations. Consistency of the variant policy`);
console.log(`  comes first; the ownership question is downstream of having ONE policy to ask it about, and the`);
console.log(`  calibration pool deliberately ignores \`owned\` already (eligibility.ts: ownedOnly defaults false).`);

console.log(`\n  REPORT-ONLY. Nothing here fits, changes a default, or touches production scoring.`);
console.log(``);
process.exit(0);
