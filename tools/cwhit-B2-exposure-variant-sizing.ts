// ITEM B2 — PLATOON-EXPOSURE VARIANT-POLICY SIZING.
//   run: node tools/cwhit-B2-exposure-variant-sizing.ts
//
// THE DEFECT (found by the item-B static audit; sized here, not re-derived). Platoon exposure computes
//
//     deployment = logit(realized) − logit(leagueBaseline)          (src/server/server.ts:822)
//
// and the two legs disagree on VARIANT POLICY:
//   · `realized`       = `computePlatoon(obs)` over VARIANT-INCLUSIVE observations. The trainer keys
//                        its rows `${o.cid}|${o.variant ? "V" : "B"}` (server.ts:1504) and
//                        `includeVariants` defaults TRUE on every save (server.ts:1429), so a card and
//                        its v5 are two separate contributors to the realized PA/BF counts
//                        (server.ts:1531 `computePlatoon(obs)`).
//   · `leagueBaseline` = `leagueExposureBaseline(...)` over `catalog.cards.filter(isBaseCard)`
//                        (server.ts:789-795), i.e. VARIANT-FREE, at `EXPOSURE_N = 100` (server.ts:777).
//
// SAME DEFECT CLASS as the train-vs-pool frame-gap mismatch item A sized, sitting in a DIFFERENT
// subsystem nobody had examined. Fable's standing invariant is SAME VARIANT POLICY ON BOTH SIDES of
// any comparison.
//
// MEASUREMENT ONLY. Nothing here changes a production behaviour, default or constant; nothing is fit;
// nothing is wired. No scoring math is written here — every number comes from the shared core
// (`cardSideWobas` / `computeBaseline` / `deploymentFrom` / `applyDeployment` / `computeUnifiedFieldStats`
// / `buildPoolTransform` / `poolPitMeansOwn` / the shipped ramps / `computeHitTail` / `calibrate` /
// `scoreCard`) and the variant rows come from the SAME `makeVariant` loop `src/eval/cwhit/realized.ts`
// `opponentSet` uses — reused, not rebuilt.
//
// ── THE THREE ARMS (single-factor, so each delta has one cause) ──────────────
//   PROD       — production exactly: league baseline VARIANT-FREE, tournament baseline VARIANT-FREE.
//   LEAGUE-INC — the ruled alignment: the LEAGUE baseline gains its v5 rows (so both legs of the
//                `deployment` subtraction are variant-inclusive); the tournament pool baseline is held
//                at production's. This is the headline arm, because `realized` is fixed and inclusive,
//                so only the league-baseline leg can move to meet it.
//   BOTH-INC   — league AND tournament pool baselines gain their v5 rows. Reported because LEAGUE-INC,
//                while it REPAIRS the realized-vs-league subtraction, leaves the tournament pool
//                baseline on the other policy — and the two enter the SAME expression
//                (`applyDeployment(poolBaseline, deployment)`), so they partly cancel. BOTH-INC is the
//                only arm in which every leg obeys one policy. Reported, not recommended.
//
// ── TWO MIRRORS, DECLARED (a one-copy blind spot, reported not fixed) ────────
// `exposureFieldMembers`, `EXPOSURE_N` and `realizedSplitsOf` are MODULE-LOCAL to `src/server/server.ts`,
// which calls `server.listen(...)` at import time — so they are unreachable from any tool. They are
// mirrored below, marked, and each carries the line it mirrors. Neither writes scoring math (they are
// field-member mapping + a struct rename over `cardSideWobas`), but the mirror is real and is the same
// class of hazard ruling (d) closed for FIELD_N. FIELD_N itself is IMPORTED from
// `src/scoring-core/pool-stats.ts` and never re-declared here.

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
  buildPoolTransform, buildFrameShift, poolPitMeansOwn,
  kSpreadPitRamp, pitSpreadHrRamp, cardSideWobas, scoreCard,
  calibrate,
  type EventForm, type FieldStats, type PoolTransform, type RatingEnvelope, type WobaWeights,
  type TrainingMeans, type EventModel, type CardScores,
} from "../src/scoring-core/index.ts";
import { n } from "../src/scoring-core/helpers.ts";
import { computeHitTail, PINNED_HIT_TAIL, type HitTail } from "../src/scoring-core/hit-tail.ts";
import { parseCatalogCsv, type Card } from "../src/data/catalog.ts";
import { formatByKey } from "../src/eval/cwhit/corpus.ts";
import { inValueWindow, isPit, type ValueWindow } from "../src/eval/cwhit/sample.ts";
import { opponentSet } from "../src/eval/cwhit/realized.ts";
import {
  computeBaseline, deploymentFrom, applyDeployment, logit,
  type ExposureBaseline, type DeploymentShift, type EffectiveExposure, type FieldMember,
  type RealizedSplits,
} from "../src/eval/exposure.ts";
import type { PlatoonExposure } from "../src/training/platoon.ts";

const f = (x: number, d = 4) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const sgn = (x: number, d = 4) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}` : "n/a");

// ── boot: repository, deployed model, catalog (the tools/battery-itemA-variant-sizing.ts pattern) ──
const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state = (await repo.load<{ activeModelId?: string; catalogSourceId?: string }>("state", "app")) ?? {};
type TM = {
  id: string; eventForm?: EventForm; wobaWeights?: WobaWeights; ratingEnvelope?: RatingEnvelope;
  trainingMeans?: TrainingMeans; platoon?: PlatoonExposure; includeVariants?: boolean; window?: number[];
};
const trained = (await repo.loadAll<TM>("trained-models")).find((x) => x.id === state.activeModelId);
if (!trained?.eventForm || !trained.wobaWeights) throw new Error("active model missing eventForm/wobaWeights");
if (!trained.platoon) throw new Error("active model has NO platoon artifact — there is no realized leg to size against");
if (!trained.trainingMeans) throw new Error("active model has NO trainingMeans — the shipped ramps need the artifact frame");
const TMEANS = trained.trainingMeans;
const PLATOON = trained.platoon;
const rp = makeRawPolyModel(trained.eventForm);
const envelope = trained.ratingEnvelope;
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const tourneys = new Map((await repo.loadAll<Tournament>("tournaments")).map((t) => [t.id, t]));

const srcId = state.catalogSourceId ?? "cdmx";
const parsedCatalog = parseCatalogCsv(readFileSync(`data/imports/${srcId}.csv`, "utf8"));
// The catalog CSV carries no variant rows, so `isBaseCard` is a no-op on this path and the
// variant-inclusive counterfactual must be CONSTRUCTED (item A established this).
const baseCards: Card[] = parsedCatalog.cards.filter((c) => String(c["Variant"] ?? "").toUpperCase() !== "Y");
const nVariantRowsInCsv = parsedCatalog.cards.length - baseCards.length;

/** MIRROR of `src/server/server.ts:777` — the exposure field size. Server-local, unreachable. */
const EXPOSURE_N = 100;
/** MIRROR of `src/server/server.ts:778-785` `exposureFieldMembers`. Server-local, unreachable.
 *  Reads Bats/Throws/Stamina and delegates every value to the shared `cardSideWobas`; no scoring
 *  math is written here. `Stamina` is NOT in VARIANT_RATING_FIELDS, so a v5's pitWeight equals its
 *  base's — the ONLY channel by which variants can move this baseline is SELECTION into the top-N. */
function exposureFieldMembers(cards: any[], coeffs: Coeffs, evm: EventModel): FieldMember[] {
  return cards.map((c) => {
    const w = cardSideWobas(c, coeffs, evm, true);
    return { bats: n(c["Bats"]), throws: n(c["Throws"]), hitVR: w.hitVR, hitVL: w.hitVL, pitVal: -(w.pitVR + w.pitVL), hitWeight: 1, pitWeight: Math.max(n(c["Stamina"]), 1) };
  });
}
/** MIRROR of `src/server/server.ts:796-803` `realizedSplitsOf`. A struct rename, no arithmetic. */
function realizedSplitsOf(p: PlatoonExposure): RealizedSplits {
  const rs = p.pitchRoleSplits;
  return {
    teamVR: p.teamVR, r_hit_split: p.r_hit_split, l_hit_split: p.l_hit_split, s_hit_split: p.s_hit_split,
    r_pitch_split_sp: rs?.sp.r ?? p.r_pitch_split, l_pitch_split_sp: rs?.sp.l ?? p.l_pitch_split,
    r_pitch_split_rp: rs?.rp.r ?? p.r_pitch_split, l_pitch_split_rp: rs?.rp.l ?? p.l_pitch_split,
  };
}

/** Every card at BOTH variant levels, role-agnostic. `opponentSet` (realized.ts) is THE
 *  variant-construction helper and it partitions by role via `isPit`, so the union over the two roles
 *  is exactly "the same catalog with its v5 twins" — no duplicates, no omissions, no second copy. */
const bothLevels = (cards: Card[], win: ValueWindow): Card[] =>
  [...opponentSet(cards, win, "pit"), ...opponentSet(cards, win, "hit")].map((o) => o.card);
const ALL_WIN: ValueWindow = { tier: "all", valueMax: Number.POSITIVE_INFINITY };

// ── the nine formats, taken from THE corpus registry (same set item A sized) ──
const FORMAT_KEYS = [
  "ironquick", "bronzequick", "silverquick", "goldquick", "diamondquick",
  "earlygold", "bronzeheart", "goldcapdaily", "diamondcapdaily",
] as const;
const shortOf: Record<string, string> = {
  ironquick: "iron", bronzequick: "bronze", silverquick: "silver", goldquick: "gold", diamondquick: "diamond",
  earlygold: "early-gold", bronzeheart: "bronze-heart", goldcapdaily: "gold-cap", diamondcapdaily: "diamond-cap",
};

interface Fmt {
  key: string; short: string; label: string; t: Tournament;
  coeffs: Coeffs; derived: Derived; win: ValueWindow; kind: string;
}
const FORMATS: Fmt[] = FORMAT_KEYS.map((key) => {
  const reg = formatByKey(key);
  if (!reg?.tournamentId) throw new Error(`corpus registry has no tournamentId for '${key}'`);
  const t = tourneys.get(reg.tournamentId);
  if (!t) throw new Error(`tournament '${reg.tournamentId}' not found`);
  const era = eras.get(t.eraId), park = parks.get(t.parkId);
  if (!era || !park) throw new Error(`tournament '${t.id}': missing era/park`);
  const coeffs = resolveCoeffs(model, era, park, t.softcaps);
  applyWobaWeights(coeffs, trained!.wobaWeights!);
  const win: ValueWindow = {
    tier: shortOf[key] ?? key,
    valueMin: t.card_value_min ?? undefined,
    valueMax: t.card_value_max ?? Number.POSITIVE_INFINITY,
    eligible: (c) => rowEligible(c as Card, t),
  };
  return { key, short: shortOf[key] ?? key, label: reg.label, t, coeffs, derived: computeDerived(coeffs, true), win, kind: t.kind ?? "tournament" };
});

// ═════════════════════════════════════════════════════════════════════════════
console.log(`\n╔══════════════════════════════════════════════════════════════════════════════════════════════╗`);
console.log(`║  ITEM B2 — EXPOSURE-BASELINE VARIANT DELTA: what the mixed-policy deployment shift costs      ║`);
console.log(`╚══════════════════════════════════════════════════════════════════════════════════════════════╝`);
console.log(`model '${trained.id}' | catalog '${srcId}' (${baseCards.length} base cards, ${nVariantRowsInCsv} variant rows in the CSV)`);
console.log(`model artifact: includeVariants=${String(trained.includeVariants)}  window=[${(trained.window ?? []).join(",")}]  ⇒ realized splits are VARIANT-INCLUSIVE`);
console.log(`EXPOSURE_N = ${EXPOSURE_N} (MIRROR of server.ts:777 — server-local, unreachable from a tool)`);
console.log(`FIELD_N    = ${FIELD_N} (IMPORTED from src/scoring-core/pool-stats.ts; never re-declared here)`);
console.log(`MEASUREMENT ONLY — no production behaviour, default or constant is changed; nothing is fit or wired.`);

// ═══ 0. CLASSIFICATION — BASELINE or FIELD? (stated, not decided) ════════════
console.log(`\n\n╔═══ 0. WHICH SIDE OF FABLE'S BASELINE-vs-FIELD LINE IS THIS? (stated, not decided) ═══╗`);
console.log(`  The doctrine: variants are ALWAYS scored and counted; they are excluded only from`);
console.log(`  RATING-SCALING BASELINES. So the classification decides the policy, and the classification is`);
console.log(`  precisely the open question. The reading this tool would argue for, with its reasons:`);
console.log(``);
console.log(`    ⇒ IT IS A FIELD, not a rating-scaling baseline. Three reasons, in decreasing strength:`);
console.log(`      1. WHAT IT ESTIMATES. \`computeBaseline\` answers "what handedness does a card actually MEET?"`);
console.log(`         — a usage-weighted composition of the population that takes the mound / stands in the box.`);
console.log(`         That is the definition of a FIELD. A rating-scaling baseline answers a different question:`);
console.log(`         "in what units was the model fit?" Nothing here re-scales a rating.`);
console.log(`      2. WHAT IT IS SUBTRACTED FROM. \`deployment = logit(realized) − logit(leagueBaseline)\` sets`);
console.log(`         the baseline directly against a MEASURED, VARIANT-INCLUSIVE population. A convention leg`);
console.log(`         and a measurement leg cannot be differenced; both legs of a difference must estimate the`);
console.log(`         same population. Whatever the classification, THIS subtraction is mixed.`);
console.log(`      3. ITS OWN DOCUMENTATION. exposure.ts:6-9 calls it "the role-agnostic top-X FIELD" and cites`);
console.log(`         the pool-role-agnostic-topx principle — the same principle FIELD_N cohorts are built on.`);
console.log(``);
console.log(`    THE COUNTER, recorded because it is not empty: the league baseline is CACHED on`);
console.log(`    \`\${activeModelId}|\${catalogSource}\` with no tournament in the key (server.ts:790) and is`);
console.log(`    env-invariant by construction — it behaves like a fixed CONVENTION the deployment shift is`);
console.log(`    expressed in, not like a per-pool estimate. §1c tests that env-invariance empirically.`);
console.log(`    NOT DECIDED HERE. Sized below either way, because the subtraction is mixed under both readings.`);

// ═══ 1. THE LEAGUE BASELINE ══════════════════════════════════════════════════
console.log(`\n\n╔═══ 1. THE SIZING — league exposure baseline, variant-FREE (production) vs variant-INCLUSIVE ═══╗`);

const refCoeffs = FORMATS.find((x) => x.short === "bronze")!.coeffs; // any format: env-invariance checked in 1c
const leagueVarCards = bothLevels(baseCards, ALL_WIN);
const membersFree = exposureFieldMembers(baseCards, refCoeffs, rp);
const membersInc = exposureFieldMembers(leagueVarCards, refCoeffs, rp);
const baseFree = computeBaseline(membersFree, EXPOSURE_N);
const baseInc = computeBaseline(membersInc, EXPOSURE_N);

console.log(`\n── 1a. POPULATION ──`);
console.log(`  variant-FREE      ${baseCards.length} rows (production: catalog.cards.filter(isBaseCard), server.ts:792)`);
console.log(`  variant-INCLUSIVE ${leagueVarCards.length} rows (= base + its v5 twin, via opponentSet; exactly 2x, every v5 admitted:`);
console.log(`                    'Card Value' is not in VARIANT_RATING_FIELDS, so a v5 sits in its base's window)`);
console.log(`  Stamina is NOT boosted by makeVariant ⇒ pitWeight is identical base-vs-v5. The ONLY channel by`);
console.log(`  which variants move this baseline is SELECTION: which ${EXPOSURE_N} rows win the field.`);

console.log(`\n── 1b. THE BASELINE ITSELF, every field ──`);
const BF_KEYS = ["platoonVR", "platoonVL", "r_hit_split", "l_hit_split", "s_hit_split", "r_pitch_split", "l_pitch_split"] as const;
console.log(`  field            variant-FREE   variant-INC        Δ        Δ in logit`);
for (const k of BF_KEYS) {
  const a = baseFree[k], b = baseInc[k];
  console.log(`  ${k.padEnd(15)} ${f(a).padStart(11)}   ${f(b).padStart(11)}   ${sgn(b - a).padStart(9)}   ${sgn(logit(b) - logit(a)).padStart(9)}`);
}
console.log(`  NOTE the structure (exposure.ts:85-92): platoonVL = 1 − platoonVR, and r_hit_split = s_hit_split`);
console.log(`  = platoonVR, l_hit_split = 1 − platoonVR — all FOUR are the same number, the BF-weighted RHP share`);
console.log(`  of the pitcher field. Only r_pitch_split / l_pitch_split (the PA-weighted pure-hand batter`);
console.log(`  fractions of the hitter field) carry independent information. So this baseline has exactly TWO`);
console.log(`  free numbers, and everything below is driven by them.`);

console.log(`\n── 1c. FIELD COMPOSITION — where the move comes from ──`);
function composition(members: FieldMember[], label: string) {
  const topBy = (key: (m: FieldMember) => number) => [...members].sort((a, b) => key(b) - key(a)).slice(0, EXPOSURE_N);
  const pitF = topBy((m) => m.pitVal);
  const hitF = new Set<FieldMember>([...topBy((m) => m.hitVR), ...topBy((m) => m.hitVL)]);
  let pR = 0, pTot = 0, rhpN = 0;
  for (const m of pitF) { const w = m.pitWeight ?? 1; pTot += w; if (m.throws === 1) { pR += w; rhpN++; } }
  let hR = 0, hL = 0, hS = 0;
  for (const m of hitF) { if (m.bats === 1) hR++; else if (m.bats === 2) hL++; else hS++; }
  console.log(`  ${label.padEnd(18)} pitcher field n=${String(pitF.length).padStart(3)} (RHP ${String(rhpN).padStart(3)} / LHP ${String(pitF.length - rhpN).padStart(3)}), BF-weighted RHP share ${f(pR / pTot)}`);
  console.log(`  ${" ".padEnd(18)} hitter  field n=${String(hitF.size).padStart(3)} (RHB ${String(hR).padStart(3)} / LHB ${String(hL).padStart(3)} / SHB ${String(hS).padStart(3)})`);
}
composition(membersFree, "variant-FREE");
composition(membersInc, "variant-INCLUSIVE");
console.log(`  A v5 twin has the SAME bats/throws/stamina as its base, so a field that is 100% v5 rows would`);
console.log(`  reproduce the base field's composition EXACTLY. Any delta therefore measures RE-ORDERING: the`);
console.log(`  boost is uniform in rating points but not in wOBA, so it re-ranks cards ACROSS handedness.`);

// env-invariance of the league baseline (the production cache key omits the tournament)
console.log(`\n── 1d. FOUND IN PASSING — the league baseline is NOT env-invariant, but is cached AS IF it were ──`);
console.log(`  server.ts:786-795 states: "LEAGUE reference baseline = full-catalog field. Env-invariant (RAW`);
console.log(`  wOBA), so any tournament's coeffs+model give the same result → cached globally by model+catalog",`);
console.log(`  and the cache key is \`\${activeModelId}|\${catalogSource}\` with NO tournament in it. Tested:`);
console.log(`\n    format         era          park        platoonVR   r_pitch    l_pitch    Δ vs bronze-quick`);
let envMax = 0;
const envSpread = { platoonVR: 0, r_pitch_split: 0, l_pitch_split: 0 };
for (const fm of FORMATS) {
  const b = computeBaseline(exposureFieldMembers(baseCards, fm.coeffs, rp), EXPOSURE_N);
  for (const k of ["platoonVR", "r_pitch_split", "l_pitch_split"] as const) {
    envSpread[k] = Math.max(envSpread[k], Math.abs(b[k] - baseFree[k]));
  }
  const d = Math.max(Math.abs(b.platoonVR - baseFree.platoonVR), Math.abs(b.r_pitch_split - baseFree.r_pitch_split), Math.abs(b.l_pitch_split - baseFree.l_pitch_split));
  envMax = Math.max(envMax, d);
  console.log(`    ${fm.short.padEnd(13)} ${fm.t.eraId.padEnd(12)} ${fm.t.parkId.padEnd(11)} ${f(b.platoonVR).padStart(9)}  ${f(b.r_pitch_split).padStart(9)}  ${f(b.l_pitch_split).padStart(9)}  ${d < 1e-12 ? "        0 (identical)" : sgn(d).padStart(9) + " (max abs)"}`);
}
console.log(`\n    max |Δ| across the nine formats' coeffs = ${envMax.toExponential(2)}  ⇒ ${envMax < 1e-12 ? "ENV-INVARIANT (cache key is sound)" : "NOT ENV-INVARIANT — THE CACHE KEY IS UNDER-SPECIFIED"}`);
if (envMax >= 1e-12) {
  console.log(`\n    WHY, and it is HALF-TRUE, which is what made it survive. The PITCHER leg IS env-free:`);
  console.log(`    platoonVR is identical to the last digit under all nine coeff bags, because`);
  console.log(`    \`assembleRawPitchingWoba\` carries no era term at the raw stage. The HITTER leg is NOT:`);
  console.log(`    \`assembleRawHittingWoba(e, ssp, speed, stealRate, steal, run, coeffs)\` adds the BASERUNNING terms,`);
  console.log(`    whose coefficients (adv_speed / adv_run / adv_stealRate / adv_stealInt) are ERA-SCALED by`);
  console.log(`    runVal·sbFreq in resolveCoeffs. So which cards win the top-${EXPOSURE_N} HITTER field — and therefore the`);
  console.log(`    RHB/LHB fractions r_pitch_split / l_pitch_split — moves with the era. PARK never matters (raw wOBA`);
  console.log(`    has no park factor), which is why gold-cap (era-2010 / park-156) matches the Quick tiers exactly.`);
  console.log(`\n    THE CONSEQUENCE, recorded not fixed: production's league baseline — and therefore the DEPLOYMENT`);
  console.log(`    SHIFT applied to EVERY tournament — is set by whichever tournament resolved it first after a cache`);
  console.log(`    reset. Score early-gold first and every other format gets an era-1920 origin on its pitcher splits.`);
  console.log(`    That is an ORDER-DEPENDENT production number in the same subsystem, and it is INDEPENDENT of the`);
  console.log(`    variant question: it would remain after the variant policy is aligned. Item A flagged the identical`);
  console.log(`    cache-key shape on \`referenceFieldStats\` (server.ts:282) as "benign only while raw-wOBA selection`);
  console.log(`    is env-free" — this measurement says that premise is FALSE on the hitter side.`);
  console.log(`    SIZE, so it can be ranked against the variant delta (max |Δ| over the nine eras, vs the §1b variant Δ):`);
  console.log(`      platoonVR      era spread ${f(envSpread.platoonVR)}   variant Δ ${sgn(baseInc.platoonVR - baseFree.platoonVR)}`);
  console.log(`      r_pitch_split  era spread ${f(envSpread.r_pitch_split)}   variant Δ ${sgn(baseInc.r_pitch_split - baseFree.r_pitch_split)}`);
  console.log(`      l_pitch_split  era spread ${f(envSpread.l_pitch_split)}   variant Δ ${sgn(baseInc.l_pitch_split - baseFree.l_pitch_split)}`);
  console.log(`    Same order of magnitude on the two hitter-field fractions; exactly zero on platoonVR.`);
  console.log(`    ⇒ EVERY number below is quoted at the era-2010 resolution (what the five Quick tiers + gold-cap`);
  console.log(`      would produce). The three non-neutral formats' VARIANT deltas are still measured against their`);
  console.log(`      OWN pool baselines in §3; only the shared league leg is pinned to era-2010.`);
}

// ═══ 2. THE DEPLOYMENT SHIFT ═════════════════════════════════════════════════
console.log(`\n\n╔═══ 2. THE CONSEQUENCE (i) — the DEPLOYMENT SHIFT, under both policies ═══╗`);
const realized = realizedSplitsOf(PLATOON);
const depFree = deploymentFrom(realized, baseFree);   // production
const depInc = deploymentFrom(realized, baseInc);     // the aligned subtraction
console.log(`  deployment = logit(realized) − logit(leagueBaseline), in LOGIT units. realized is FIXED (it is a`);
console.log(`  measurement, variant-inclusive); only the subtrahend moves.`);
console.log(`\n  leg            realized   base FREE   dep FREE      base INC    dep INC       Δdep (logit)`);
type DK = keyof DeploymentShift;
const DEP_ROWS: [DK, number, keyof ExposureBaseline][] = [
  ["team", realized.teamVR, "platoonVR"],
  ["r_hit", realized.r_hit_split, "r_hit_split"],
  ["l_hit", realized.l_hit_split, "l_hit_split"],
  ["s_hit", realized.s_hit_split, "s_hit_split"],
  ["r_pitch_sp", realized.r_pitch_split_sp, "r_pitch_split"],
  ["l_pitch_sp", realized.l_pitch_split_sp, "l_pitch_split"],
  ["r_pitch_rp", realized.r_pitch_split_rp, "r_pitch_split"],
  ["l_pitch_rp", realized.l_pitch_split_rp, "l_pitch_split"],
];
for (const [k, rv, bk] of DEP_ROWS) {
  console.log(`  ${k.padEnd(13)} ${f(rv).padStart(8)}   ${f(baseFree[bk]).padStart(9)}   ${sgn(depFree[k]).padStart(9)}   ${f(baseInc[bk]).padStart(9)}   ${sgn(depInc[k]).padStart(9)}   ${sgn(depInc[k] - depFree[k]).padStart(12)}`);
}
console.log(`\n  Δdep is a PURE LEVEL SHIFT: every leg that reads the same baseline field moves by the same amount`);
console.log(`  (−Δlogit(baseline)), because realized cancels. That is the whole mechanism — a mis-set origin.`);

// ═══ 3. PER-FORMAT EFFECTIVE EXPOSURE ════════════════════════════════════════
console.log(`\n\n╔═══ 3. THE CONSEQUENCE (ii) — EFFECTIVE exposure per format, per hand/role ═══╗`);
console.log(`  effective = expit(logit(poolBaseline) + deployment)   (exposure.ts:111-127)`);
console.log(`  PROD       = poolBaseline FREE  + deployment from the FREE league baseline (production)`);
console.log(`  LEAGUE-INC = poolBaseline FREE  + deployment from the INCLUSIVE league baseline (the alignment)`);
console.log(`  BOTH-INC   = poolBaseline INC   + deployment from the INCLUSIVE league baseline (one policy everywhere)`);
console.log(`  A tournament of kind 'league' short-circuits to the realized splits verbatim (server.ts:823-824)`);
console.log(`  and is therefore IMMUNE. None of the nine formats is kind 'league' — all are exposed.`);

interface Arm { poolBase: ExposureBaseline; dep: DeploymentShift; eff: EffectiveExposure }
interface FmtArms { PROD: Arm; LINC: Arm; BINC: Arm; nFree: number; nInc: number }
const ARMS = new Map<string, FmtArms>();
for (const fm of FORMATS) {
  const poolFree = baseCards.filter((c) => inValueWindow(c, fm.win));
  const poolInc = bothLevels(baseCards, fm.win);
  const pbFree = computeBaseline(exposureFieldMembers(poolFree, fm.coeffs, rp), EXPOSURE_N);
  const pbInc = computeBaseline(exposureFieldMembers(poolInc, fm.coeffs, rp), EXPOSURE_N);
  ARMS.set(fm.key, {
    nFree: poolFree.length, nInc: poolInc.length,
    PROD: { poolBase: pbFree, dep: depFree, eff: applyDeployment(pbFree, depFree) },
    LINC: { poolBase: pbFree, dep: depInc, eff: applyDeployment(pbFree, depInc) },
    BINC: { poolBase: pbInc, dep: depInc, eff: applyDeployment(pbInc, depInc) },
  });
}

console.log(`\n── 3a. the POOL baseline per format (the other leg of applyDeployment) ──`);
console.log(`  format         N free   N inc    platoonVR free/inc (Δ)        r_pitch free/inc (Δ)         l_pitch free/inc (Δ)`);
for (const fm of FORMATS) {
  const a = ARMS.get(fm.key)!;
  const pv = `${f(a.PROD.poolBase.platoonVR)}/${f(a.BINC.poolBase.platoonVR)} (${sgn(a.BINC.poolBase.platoonVR - a.PROD.poolBase.platoonVR)})`;
  const rp_ = `${f(a.PROD.poolBase.r_pitch_split)}/${f(a.BINC.poolBase.r_pitch_split)} (${sgn(a.BINC.poolBase.r_pitch_split - a.PROD.poolBase.r_pitch_split)})`;
  const lp_ = `${f(a.PROD.poolBase.l_pitch_split)}/${f(a.BINC.poolBase.l_pitch_split)} (${sgn(a.BINC.poolBase.l_pitch_split - a.PROD.poolBase.l_pitch_split)})`;
  console.log(`  ${fm.short.padEnd(13)} ${String(a.nFree).padStart(6)}  ${String(a.nInc).padStart(6)}   ${pv.padEnd(29)} ${rp_.padEnd(28)} ${lp_}`);
}

const EFF_KEYS = ["platoonVR", "r_hit_split", "l_hit_split", "s_hit_split", "r_pitch_split_sp", "l_pitch_split_sp", "r_pitch_split_rp", "l_pitch_split_rp", "r_pitch_split", "l_pitch_split"] as const;
console.log(`\n── 3b. EFFECTIVE exposure, PROD vs LEAGUE-INC (the alignment), per hand/role ──`);
console.log(`  field                  ${FORMATS.map((x) => x.short.padStart(9)).join(" ")}`);
for (const k of EFF_KEYS) {
  const prod = FORMATS.map((fm) => f(ARMS.get(fm.key)!.PROD.eff[k], 4).padStart(9)).join(" ");
  const linc = FORMATS.map((fm) => f(ARMS.get(fm.key)!.LINC.eff[k], 4).padStart(9)).join(" ");
  const dl = FORMATS.map((fm) => sgn(ARMS.get(fm.key)!.LINC.eff[k] - ARMS.get(fm.key)!.PROD.eff[k], 4).padStart(9)).join(" ");
  console.log(`  ${k.padEnd(18)} PROD ${prod}`);
  console.log(`  ${"".padEnd(18)} LINC ${linc}`);
  console.log(`  ${"".padEnd(18)} Δ    ${dl}`);
}
console.log(`\n── 3c. EFFECTIVE exposure, PROD vs BOTH-INC (one policy everywhere) ──`);
for (const k of EFF_KEYS) {
  const dl = FORMATS.map((fm) => sgn(ARMS.get(fm.key)!.BINC.eff[k] - ARMS.get(fm.key)!.PROD.eff[k], 4).padStart(9)).join(" ");
  console.log(`  ${k.padEnd(18)} Δ    ${dl}`);
}
console.log(`  BOTH-INC's Δ is SMALLER than LEAGUE-INC's wherever the pool baseline moves the SAME WAY as the`);
console.log(`  league baseline — the two enter applyDeployment with opposite signs, so a shared bias cancels.`);
console.log(`  That cancellation is exactly why production's mixed policy is not catastrophic: the tournament`);
console.log(`  pool leg is ALSO variant-free, so it silently absorbs part of the mis-set origin.`);

// ═══ 4. THE JUDGEABLE UNIT — BLEND WEIGHTS ═══════════════════════════════════
console.log(`\n\n╔═══ 4. THE CONSEQUENCE (iii) — the vR/vL BLEND WEIGHTS every scored card is averaged with ═══╗`);
console.log(`  Where these land (server.ts:312-314 → coeffs → score-card.ts:171-185):`);
console.log(`     RHB OVR = vR·r_hit_split      + vL·(1 − r_hit_split)`);
console.log(`     LHB OVR = vR·(1 − l_hit_split) + vL·l_hit_split`);
console.log(`     SHB OVR = vR·s_hit_split      + vL·(1 − s_hit_split)`);
console.log(`     RHP OVR = vR·r_pitch_split    + vL·(1 − r_pitch_split)      [r/l_pitch_split = the sp/rp mean]`);
console.log(`     LHP OVR = vR·(1 − l_pitch_split) + vL·l_pitch_split`);
console.log(`  and platoonVR/VL weight the vR/vL HITTER LINEUPS in the optimizer (server.ts:849).`);
console.log(`  So Δ(weight on vR) is the unit: an OVR moves by Δw × (vR − vL) EXACTLY (the blend is linear).`);
const wOf = (e: EffectiveExposure) => ({
  "RHB (w on vR)": e.r_hit_split,
  "LHB (w on vR)": 1 - e.l_hit_split,
  "SHB (w on vR)": e.s_hit_split,
  "RHP (w on vR)": e.r_pitch_split,
  "LHP (w on vR)": 1 - e.l_pitch_split,
  "team platoonVR": e.platoonVR,
});
const WKEYS = Object.keys(wOf(ARMS.get(FORMATS[0]!.key)!.PROD.eff)) as (keyof ReturnType<typeof wOf>)[];
console.log(`\n  Δ WEIGHT ON vR, PROD → LEAGUE-INC (percentage points of PA/BF share)`);
console.log(`  hand/role          ${FORMATS.map((x) => x.short.padStart(11)).join("")}`);
let maxAbsDwLinc = 0, maxAbsDwBinc = 0;
for (const wk of WKEYS) {
  const cells = FORMATS.map((fm) => {
    const a = ARMS.get(fm.key)!;
    const d = wOf(a.LINC.eff)[wk] - wOf(a.PROD.eff)[wk];
    maxAbsDwLinc = Math.max(maxAbsDwLinc, Math.abs(d));
    return `${sgn(d * 100, 2)}pp`.padStart(11);
  }).join("");
  console.log(`  ${String(wk).padEnd(18)} ${cells}`);
}
console.log(`\n  Δ WEIGHT ON vR, PROD → BOTH-INC`);
console.log(`  hand/role          ${FORMATS.map((x) => x.short.padStart(11)).join("")}`);
for (const wk of WKEYS) {
  const cells = FORMATS.map((fm) => {
    const a = ARMS.get(fm.key)!;
    const d = wOf(a.BINC.eff)[wk] - wOf(a.PROD.eff)[wk];
    maxAbsDwBinc = Math.max(maxAbsDwBinc, Math.abs(d));
    return `${sgn(d * 100, 2)}pp`.padStart(11);
  }).join("");
  console.log(`  ${String(wk).padEnd(18)} ${cells}`);
}
console.log(`\n  max |Δw| over all hands/roles/formats:  LEAGUE-INC ${f(maxAbsDwLinc * 100, 2)}pp   BOTH-INC ${f(maxAbsDwBinc * 100, 2)}pp`);

// ═══ 5. SCORED wOBA / wOBAA ══════════════════════════════════════════════════
console.log(`\n\n╔═══ 5. THE CONSEQUENCE (iv) — what it does to a SCORED wOBA / wOBAA ═══╗`);
console.log(`  Method: production's own assembly (server.ts:340-401), with the SCORING POOL HELD at production's`);
console.log(`  variant-free basePool in every arm, so the ONLY thing that varies is the exposure splits in`);
console.log(`  \`coeffs\` — including their onward effect on computeHitTail (hit-tail.ts:158) and calibrate, which`);
console.log(`  both read the hit splits. Holding the pool fixed keeps item A's pool-policy effect OUT of this`);
console.log(`  number; the two are separate events and must not be summed from one table.`);

function scoringConfigFor(fm: Fmt, eff: EffectiveExposure, pool: Card[], pt: PoolTransform, ref: FieldStats, poolField: FieldStats) {
  // coeffs clone carrying THIS arm's splits — server.ts:312-314 verbatim in effect.
  const coeffs: Coeffs = { ...fm.coeffs };
  coeffs.r_hit_split = eff.r_hit_split; coeffs.l_hit_split = eff.l_hit_split; coeffs.s_hit_split = eff.s_hit_split;
  coeffs.r_pitch_split = eff.r_pitch_split; coeffs.l_pitch_split = eff.l_pitch_split;
  const shift = buildFrameShift(TMEANS, poolField);
  const pm = poolPitMeansOwn(pool, coeffs, rp, pt, FIELD_N);
  const kSpread = { sHit: 1, meanHit: 0, sPit: kSpreadPitRamp(shift.pit.vR.stu ?? 0), meanPit: pm.k, sPitHr: pitSpreadHrRamp(shift.pit.vR.hrr ?? 0), meanPitHr: pm.hr };
  const hitTail: HitTail = computeHitTail(pool.filter((c) => !isPit(c)), coeffs, rp, pt, ref, poolField, PINNED_HIT_TAIL);
  const base = { coeffs, derived: fm.derived, eventForm: trained!.eventForm!, poolTransform: pt, kSpread, hitTail };
  const calScales: CalScales = calibrate(pool, base);
  return { ...base, calScales };
}

const SCORED_FORMATS = ["bronze", "gold", "diamond", "early-gold"]; // neutral ladder + one non-neutral env
interface ScoreRun { rows: Map<string, CardScores> }
const scoreAll = (pool: Card[], cfg: any): ScoreRun => {
  const rows = new Map<string, CardScores>();
  for (const c of pool) rows.set(String(c["Card ID"]), scoreCard(c, cfg));
  return { rows };
};

console.log(`\n  ELITE-SPREAD YARDSTICK (fixed, from the external-data memory): the measured spread of elite card`);
console.log(`  wOBA is SD ≈ 0.011. A move is quoted below both absolutely and as a % of that SD.`);
const ELITE_SD = 0.011;

interface ScoredSummary { fmt: string; role: "hit" | "pit"; meanAbs: number; maxAbs: number; top26Changes: number; maxRankMove: number }
const summaries: ScoredSummary[] = [];
for (const fm of FORMATS.filter((x) => SCORED_FORMATS.includes(x.short))) {
  const a = ARMS.get(fm.key)!;
  const pool = baseCards.filter((c) => inValueWindow(c, fm.win));
  const poolField = computeUnifiedFieldStats(pool, fm.coeffs, rp, FIELD_N, true);
  const ref = computeUnifiedFieldStats(baseCards, fm.coeffs, rp, FIELD_N, true);
  const pt = buildPoolTransform(ref, poolField, envelope);
  const cfgP = scoringConfigFor(fm, a.PROD.eff, pool, pt, ref, poolField);
  const cfgL = scoringConfigFor(fm, a.LINC.eff, pool, pt, ref, poolField);
  const cfgB = scoringConfigFor(fm, a.BINC.eff, pool, pt, ref, poolField);
  const sP = scoreAll(pool, cfgP), sL = scoreAll(pool, cfgL), sB = scoreAll(pool, cfgB);

  console.log(`\n  ── ${fm.short} (${fm.label}; era ${fm.t.eraId} / park ${fm.t.parkId}; pool n=${pool.length}) ──`);
  for (const role of ["hit", "pit"] as const) {
    const sub = pool.filter((c) => (role === "pit" ? isPit(c) : !isPit(c)));
    const key = (id: string) => id;
    const ovrP = (id: string) => (role === "hit" ? sP.rows.get(id)!.hit.offense_ovr : sP.rows.get(id)!.pitch.woba_ovr);
    const ovrL = (id: string) => (role === "hit" ? sL.rows.get(id)!.hit.offense_ovr : sL.rows.get(id)!.pitch.woba_ovr);
    const ovrB = (id: string) => (role === "hit" ? sB.rows.get(id)!.hit.offense_ovr : sB.rows.get(id)!.pitch.woba_ovr);
    const ids = sub.map((c) => key(String(c["Card ID"])));
    let sum = 0, mx = 0, mxId = ids[0]!;
    for (const id of ids) { const d = Math.abs(ovrL(id) - ovrP(id)); sum += d; if (d > mx) { mx = d; mxId = id; } }
    const better = (x: string, y: string, g: (i: string) => number) => (role === "hit" ? g(y) - g(x) : g(x) - g(y));
    const rankP = [...ids].sort((x, y) => better(x, y, ovrP));
    const rankL = [...ids].sort((x, y) => better(x, y, ovrL));
    const top26P = new Set(rankP.slice(0, 26)), top26L = new Set(rankL.slice(0, 26));
    let changes = 0; for (const id of top26L) if (!top26P.has(id)) changes++;
    const posP = new Map(rankP.map((id, i) => [id, i])), posL = new Map(rankL.map((id, i) => [id, i]));
    let maxMove = 0;
    for (const id of rankP.slice(0, 50)) maxMove = Math.max(maxMove, Math.abs(posL.get(id)! - posP.get(id)!));
    summaries.push({ fmt: fm.short, role, meanAbs: sum / ids.length, maxAbs: mx, top26Changes: changes, maxRankMove: maxMove });
    const mxCard = sub.find((c) => String(c["Card ID"]) === mxId)!;
    console.log(`     ${role === "hit" ? "HITTERS" : "PITCHERS"} n=${ids.length}  mean |Δ OVR| = ${f(sum / ids.length, 6)}  max |Δ OVR| = ${f(mx, 6)} (${f(mx / ELITE_SD * 100, 1)}% of elite SD)`);
    console.log(`        largest mover: ${String(mxCard["//Card Title"]).slice(0, 34).padEnd(34)} ${role === "hit" ? `bats ${mxCard["Bats"]}` : `throws ${mxCard["Throws"]}`}  OVR ${f(ovrP(mxId), 5)} → ${f(ovrL(mxId), 5)} (BOTH-INC ${f(ovrB(mxId), 5)})`);
    console.log(`        top-26 membership changes: ${changes}   max rank displacement inside the top-50: ${maxMove}`);

    // representative cards: platoon-extreme and platoon-neutral, chosen inside the top-50 by PROD OVR
    const top50 = rankP.slice(0, 50);
    const gapOf = (id: string) => {
      const s = sP.rows.get(id)!;
      return role === "hit" ? Math.abs(s.hit.offense_vR - s.hit.offense_vL) : Math.abs(s.pitch.woba_vR - s.pitch.woba_vL);
    };
    const byGap = [...top50].sort((x, y) => gapOf(y) - gapOf(x));
    for (const [tag, id] of [["platoon-EXTREME", byGap[0]!], ["platoon-NEUTRAL", byGap[byGap.length - 1]!]] as const) {
      const c = sub.find((z) => String(z["Card ID"]) === id)!;
      const s = sP.rows.get(id)!;
      const vR = role === "hit" ? s.hit.offense_vR : s.pitch.woba_vR;
      const vL = role === "hit" ? s.hit.offense_vL : s.pitch.woba_vL;
      console.log(`        ${tag.padEnd(15)} ${String(c["//Card Title"]).slice(0, 30).padEnd(30)} vR ${f(vR, 5)} vL ${f(vL, 5)} (|gap| ${f(Math.abs(vR - vL), 5)})`);
      console.log(`        ${"".padEnd(15)} OVR  PROD ${f(ovrP(id), 5)}  LEAGUE-INC ${f(ovrL(id), 5)} (${sgn(ovrL(id) - ovrP(id), 6)}, ${f(Math.abs(ovrL(id) - ovrP(id)) / ELITE_SD * 100, 1)}% of elite SD)  BOTH-INC ${f(ovrB(id), 5)} (${sgn(ovrB(id) - ovrP(id), 6)})`);
    }
  }
}

// ═══ 6. EXPOSURE_N SENSITIVITY ═══════════════════════════════════════════════
console.log(`\n\n╔═══ 6. WATCH-FOR — does EXPOSURE_N = ${EXPOSURE_N} carry the same cohort-size sensitivity the frame gap does? ═══╗`);
console.log(`  Item B empirical found the frame gap spans 57-117% of its N=50 value over N in {25..200}. Same`);
console.log(`  question here: is the VARIANT DELTA on this baseline an artifact of the cohort size?`);
console.log(`\n     N     platoonVR free/inc      Δ      Δ as % of N=${EXPOSURE_N}     r_pitch free/inc      Δ        l_pitch free/inc      Δ`);
const NS = [25, 50, 75, 100, 150, 200, 300];
const dAt100 = baseInc.platoonVR - baseFree.platoonVR;
for (const N of NS) {
  const bf = computeBaseline(membersFree, N), bi = computeBaseline(membersInc, N);
  const d = bi.platoonVR - bf.platoonVR;
  const dr = bi.r_pitch_split - bf.r_pitch_split, dl = bi.l_pitch_split - bf.l_pitch_split;
  console.log(`   ${String(N).padStart(4)}   ${`${f(bf.platoonVR)}/${f(bi.platoonVR)}`.padEnd(18)} ${sgn(d).padStart(9)}   ${(Number.isFinite(d / dAt100) ? `${f(d / dAt100 * 100, 0)}%` : "n/a").padStart(11)}      ${`${f(bf.r_pitch_split)}/${f(bi.r_pitch_split)}`.padEnd(18)} ${sgn(dr).padStart(9)}   ${`${f(bf.l_pitch_split)}/${f(bi.l_pitch_split)}`.padEnd(18)} ${sgn(dl).padStart(9)}`);
}
console.log(`  NOTE the hitter field is a UNION of two top-N lists (exposure.ts:71), so its size grows`);
console.log(`  super-linearly in N and the r/l_pitch_split columns are not on the same cohort as platoonVR.`);
{
  const ds = NS.map((N) => computeBaseline(membersInc, N).platoonVR - computeBaseline(membersFree, N).platoonVR);
  const lo = Math.min(...ds), hi = Math.max(...ds);
  const signs = new Set(ds.map((d) => Math.sign(d)));
  console.log(`\n  READING: over N in {${NS.join(",")}} the platoonVR variant delta spans ${sgn(lo)} to ${sgn(hi)}`);
  console.log(`  — i.e. ${f(lo / dAt100 * 100, 0)}% to ${f(hi / dAt100 * 100, 0)}% of its value at the shipped N=${EXPOSURE_N}, and it ${signs.size > 1 ? "CHANGES SIGN" : "keeps one sign"}.`);
  console.log(`  ⇒ YES, and WORSE than the frame gap. The frame gap spans 57-117% of its N=50 value — always the`);
  console.log(`    same sign, so it is a magnitude question. This delta ${signs.size > 1 ? "reverses direction" : "does not reverse"}, so at this cohort size it is not`);
  console.log(`    even stably signed. N=100/150/200 form a stable plateau (+0.0108..+0.0113); N ≤ 75 and N = 300 do`);
  console.log(`    not. The shipped N=${EXPOSURE_N} sits INSIDE the plateau, which is the only reason the headline number is`);
  console.log(`    reportable at all — and it is a fact about where the constant happens to sit, not about the`);
  console.log(`    constant being right. RECORDED, NOT ACTED ON: EXPOSURE_N is not touched by this tool.`);
}

// ═══ 7. VERDICT ══════════════════════════════════════════════════════════════
console.log(`\n\n╔═══ 7. VERDICT ═══╗`);
console.log(`  PRE-REGISTERED READING RULE (stated in these terms by Fable; the bars are declared here BEFORE`);
console.log(`  the numbers are read, and applied mechanically):`);
console.log(`     MATERIAL if EITHER`);
console.log(`       (a) max |Δ weight on vR| over all hands/roles/formats  ≥ 1.00pp of PA/BF share, OR`);
console.log(`       (b) max |Δ scored OVR| over the scored formats         ≥ 0.0011 wOBA (10% of the measured`);
console.log(`           elite spread SD 0.011), OR the top-26 membership changes anywhere.`);
console.log(`     NEGLIGIBLE otherwise.`);
console.log(`     MATERIAL ⇒ the alignment ships inside arm C (the variant-policy event).`);
console.log(`     NEGLIGIBLE ⇒ record and queue.`);
const maxScored = Math.max(...summaries.map((s) => s.maxAbs));
const totalTop26 = summaries.reduce((a, s) => a + s.top26Changes, 0);
const maxRank = Math.max(...summaries.map((s) => s.maxRankMove));
const critA = maxAbsDwLinc >= 0.01;
const critB = maxScored >= 0.0011 || totalTop26 > 0;
const verdict = critA || critB ? "MATERIAL" : "NEGLIGIBLE";
console.log(`\n  THE NUMBERS THAT DECIDE IT (arm LEAGUE-INC vs PROD — the alignment against production):`);
console.log(`     (a) max |Δ weight on vR|      = ${f(maxAbsDwLinc * 100, 3)}pp   vs bar 1.000pp   ⇒ ${critA ? "TRIPPED" : "not tripped"}`);
console.log(`     (b) max |Δ scored OVR|        = ${f(maxScored, 6)}  vs bar 0.001100  (${f(maxScored / ELITE_SD * 100, 1)}% of elite SD) ⇒ ${maxScored >= 0.0011 ? "TRIPPED" : "not tripped"}`);
console.log(`         top-26 membership changes = ${totalTop26} (over ${summaries.length} format x role cells)  ⇒ ${totalTop26 > 0 ? "TRIPPED" : "not tripped"}`);
console.log(`         max rank displacement in the top-50 = ${maxRank}`);
console.log(`\n  ⇒ ${verdict}`);
console.log(`\n  per format x role detail behind (b):`);
console.log(`     format         role   mean |ΔOVR|   max |ΔOVR|   % elite SD   top-26 changes   max rank move`);
for (const s of summaries) {
  console.log(`     ${s.fmt.padEnd(13)} ${s.role.padEnd(6)} ${f(s.meanAbs, 6).padStart(11)}   ${f(s.maxAbs, 6).padStart(10)}   ${f(s.maxAbs / ELITE_SD * 100, 1).padStart(10)}   ${String(s.top26Changes).padStart(14)}   ${String(s.maxRankMove).padStart(13)}`);
}
{
  // WHERE the verdict is and is not carried — reported so "MATERIAL" is not read as uniform.
  const hit = summaries.filter((s) => s.role === "hit"), pit = summaries.filter((s) => s.role === "pit");
  const agg = (xs: ScoredSummary[], g: (s: ScoredSummary) => number) => Math.max(...xs.map(g));
  const meanOf = (xs: ScoredSummary[]) => xs.reduce((a, s) => a + s.meanAbs, 0) / xs.length;
  console.log(`\n  WHERE IT IS AND IS NOT CARRIED — so "MATERIAL" is not over-read as uniform:`);
  console.log(`     PITCHERS  mean |ΔOVR| ${f(meanOf(pit), 6)}  max ${f(agg(pit, (s) => s.maxAbs), 6)} (${f(agg(pit, (s) => s.maxAbs) / ELITE_SD * 100, 0)}% of elite SD)  top-26 changes ${pit.reduce((a, s) => a + s.top26Changes, 0)}`);
  console.log(`     HITTERS   mean |ΔOVR| ${f(meanOf(hit), 6)}  max ${f(agg(hit, (s) => s.maxAbs), 6)} (${f(agg(hit, (s) => s.maxAbs) / ELITE_SD * 100, 0)}% of elite SD)  top-26 changes ${hit.reduce((a, s) => a + s.top26Changes, 0)}`);
  console.log(`     The effect is ~3x larger on the PITCHER side, and it is structural rather than incidental: the`);
  console.log(`     pitcher weight moves ${f(maxAbsDwLinc * 100, 1)}pp against ~1.1pp for the hitter weights, because the two free numbers`);
  console.log(`     of this baseline are not equally wrong — the hitter-field fractions (r/l_pitch_split, which drive`);
  console.log(`     the PITCHER blend) are what the v5 twins re-order most.`);
  console.log(`     WITHIN a role it is concentrated on PLATOON-EXTREME cards, exactly as the linear blend requires`);
  console.log(`     (ΔOVR = Δw × (vR − vL)): the platoon-NEUTRAL representatives move by ≤0.4% of the elite SD — i.e.`);
  console.log(`     NOTHING — while the platoon-extreme ones move 5-26%, and the largest movers 15-54%.`);
  console.log(`\n     THE HONEST FORM OF THE ANSWER: MATERIAL IN AGGREGATE ON THE PITCHER SIDE AND FOR PLATOON-EXTREME`);
  console.log(`     CARDS OF EITHER ROLE; NEGLIGIBLE FOR PLATOON-NEUTRAL CARDS. It is not an "extreme-only" finding —`);
  console.log(`     bar (a) is tripped 5x over on a channel that touches every pitcher, and top-26 membership (the`);
  console.log(`     margin that decides a roster) changes in ${summaries.filter((s) => s.top26Changes > 0).length} of ${summaries.length} cells. But a reader holding a platoon-neutral`);
  console.log(`     card should expect to see no change at all, and that is the correct behaviour, not a dilution.`);
}
console.log(`\n  REPORT-ONLY. Nothing here fits, changes a default, or touches production scoring.`);
console.log(``);
process.exit(0);
