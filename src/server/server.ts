// M3 / SX.1 — local server. Owns the data folder + the scoring core and serves
// scored cards to the browser SPA (the browser never scores). Built SPA is served
// from web/dist; /api/* is JSON.
//
// Two config axes, both single-sourced:
//  • Tournament (D4): the file-based tournaments DB drives scoring — selecting one
//    resolves its Coeffs (shared Model + Era/Park libraries + softcaps) and
//    re-calibrates/re-scores. Scoring depends ONLY on the tournament + catalog.
//  • Account (D6): accounts share the catalog and differ only in `owned` + variants.
//    The active account stamps `owned` onto the (tournament-)scored rows and adds
//    its variant rows — no re-scoring needed when only the account changes.
//
// The catalog itself is sourced from the latest uploaded pt_card_list CSV (never a
// frozen file), so new card releases flow in on upload.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { parseCatalogCsv, cardId, type Catalog } from "../data/catalog.ts";
import { buildEligiblePool, rowEligible } from "../config/eligibility.ts";
import { makeVariant } from "../data/variants.ts";
import { overlayFromCatalog, parseVariantExport, type AccountOverlay } from "../data/account.ts";
import { parseBallparks } from "../data/ballparks.ts";
import { scoreCard, calibrate, calibrateBasic, computeDerived, valueFor, TARGET_WOBA, TARGET_BASIC, makeRawPolyModel, computeFieldStats, buildPoolTransform, applyWobaWeights, applyAffine, type EventForm, type FieldStats, type PoolTransform, type Coeffs, type EventModel, type WobaWeights, type RatingEnvelope } from "../scoring-core/index.ts";
import { fitHitForm, fitPitForm, RAWPOLY_HIT, STUFFAUG_PIT } from "../training/forms.ts";
import { pitchingComponents, hittingComponents } from "../scoring-core/woba.ts"; // debug/card event trace only
import { cp, getParkFactor } from "../scoring-core/helpers.ts";                   // park factors, for the trace
import { generateFullRoster, bestLineupValue, cumulativeSlotLimits, blendPitch, type MatchHitter, type HitterCandidate, type PitcherCandidate, type RosterOptimizeOptions, type PitchSplit, type PitchRole } from "../optimizer/index.ts";
import type { Tournament, Era, Park } from "../config/tournament.ts";
import { Repository } from "../persistence/repository.ts";
import { seedDefaults, seedEras } from "../config/seed.ts";
import { seedAccounts, slug } from "../data/account-seed.ts";
import { resolveCoeffs, type Model } from "../config/coeff-resolve.ts";
import { loadTrainingDir, loadWindow, availableYears, type LoadedTraining, type TrainObs } from "../training/loader.ts";
import { computePlatoon, type PlatoonExposure } from "../training/platoon.ts";
import { trainWobaHitting, trainWobaPitching, trainBasicHitting, trainBasicPitching, type WobaHittingFit, type WobaPitchingFit, type BasicFit, type BasicHittingCoeffs, type BasicPitchingCoeffs, type WobaHittingCoeffs, type WobaPitchingCoeffs } from "../training/fit.ts";
import { buildScoreboard, defaultWindow, type Scoreboard } from "../training/evaluate.ts";
import { HITTER, PITCHER, predictHitWoba, predictPitWoba, actualHitWoba, actualPitWoba } from "../training/bakeoff.ts";
import { evalMetrics, type EvalMetrics } from "../training/metrics.ts";
import { analyzeResiduals, type ResidualAnalysis } from "../training/residuals.ts";

const PORT = Number(process.env.PORT ?? 8787);
const WEB_DIST = "web/dist";
const DATA_ROOT = process.env.DATA_ROOT ?? "data";
// Live training data (local, gitignored). Falls back to the committed frozen
// 37-38 fixture so a fresh clone still has something to load.
const TRAINING_DIR = [process.env.TRAINING_DIR, "League Files", "Model 2037 and 2038"]
  .find((d): d is string => !!d && existsSync(d)) ?? "League Files";

interface AppState { activeAccountId: string | null; catalogSourceId: string | null; activeTournamentId: string | null; accountOrder?: string[]; activeModelId?: string | null }

// ── Boot: config DB + accounts + catalog ──────────────────────────────────────
console.log("[server] loading catalog + tournaments database…");
const repo = new Repository(DATA_ROOT);

const seedCfg = await seedDefaults(repo);
console.log(`[server] tournaments DB: ${seedCfg.seeded ? "seeded" : "loaded"} — ${seedCfg.tournaments} tournaments, ${seedCfg.eras} eras, ${seedCfg.parks} parks; model: ${seedCfg.modelName}`);
const seedEra = await seedEras(repo);
console.log(`[server] era library: ${seedEra.synced} BBRef per-year eras synced (${seedEra.total} total)`);
const seedAcc = await seedAccounts(repo);
console.log(`[server] accounts: ${seedAcc.seeded ? "seeded" : "loaded"} — [${seedAcc.accountIds.join(", ")}]; catalog source: ${seedAcc.catalogSourceId ?? "(committed docs sample)"}`);

const model = (await repo.loadAll<Model>("models"))[0];
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const tournaments = await repo.loadAll<Tournament>("tournaments");
const tournamentById = new Map(tournaments.map((t) => [t.id, t]));
const DEFAULT_TOURNAMENT_ID = tournamentById.has("default-neutral") ? "default-neutral" : tournaments[0]?.id ?? "";

if (!model || tournaments.length === 0) {
  console.error("[server] No model/tournaments available. Ensure a capture exists in fixtures/captures/.");
  process.exit(1);
}

let accounts = new Map((await repo.loadAll<AccountOverlay>("accounts")).map((a) => [a.id, a]));
let state: AppState = (await repo.load<AppState>("state", "app")) ?? { activeAccountId: null, catalogSourceId: null, activeTournamentId: null };
const saveState = () => repo.save("state", "app", state);

// Shared catalog = the current source import (latest upload); fallback to the
// committed docs sample on a fresh clone.
function loadCatalog(): { catalog: Catalog; source: string } {
  const tryIds = [state.catalogSourceId, ...accounts.keys()].filter(Boolean) as string[];
  for (const id of tryIds) {
    const f = join(DATA_ROOT, "imports", `${id}.csv`);
    if (existsSync(f)) return { catalog: parseCatalogCsv(readFileSync(f, "utf8")), source: id };
  }
  return { catalog: parseCatalogCsv(readFileSync("docs/pt_card_list.csv", "utf8")), source: "(committed docs sample)" };
}
let { catalog, source: catalogSource } = loadCatalog();
let catalogById = new Map(catalog.cards.map((c) => [cardId(c), c]));

if (state.activeAccountId == null && accounts.size) { state.activeAccountId = [...accounts.keys()][0]!; await saveState(); }

// ── Column maps (display) ─────────────────────────────────────────────────────
const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const round = (x: number) => Math.round(x * 1e4) / 1e4;

const LEARN: [string, string][] = [
  ["LearnC", "C"], ["Learn1B", "1B"], ["Learn2B", "2B"], ["Learn3B", "3B"],
  ["LearnSS", "SS"], ["LearnLF", "LF"], ["LearnCF", "CF"], ["LearnRF", "RF"],
];
const DEF_COLS = [
  "Infield Range", "Infield Error", "Infield Arm", "DP",
  "CatcherAbil", "CatcherFrame", "Catcher Arm",
  "OF Range", "OF Error", "OF Arm",
];
const PITCH_TYPES = [
  "Fastball", "Slider", "Curveball", "Changeup", "Cutter", "Sinker",
  "Splitter", "Forkball", "Screwball", "Circlechange", "Knucklecurve", "Knuckleball",
];
const pitchCount = (c: Record<string, unknown>) => PITCH_TYPES.filter((p) => n(c[p]) > 0).length;

type ScoreCtx = {
  config: Parameters<typeof scoreCard>[1];
  basicConfig: Parameters<typeof scoreCard>[1];
  isEligible: (c: Record<string, unknown>) => boolean;
};

// owned is account-scoped, stamped at serve time — base rows carry 0.
function toRow(c: Record<string, unknown>, ctx: ScoreCtx) {
  const w = scoreCard(c, ctx.config);          // wOBA-anchored
  const b = scoreCard(c, ctx.basicConfig);     // basic-anchored
  const learn: Record<string, number> = {};
  for (const [col, pos] of LEARN) learn[pos] = n(c[col]);
  const def: Record<string, number> = {};
  for (const k of DEF_COLS) def[k] = n(c[k]);
  return {
    id: String(w.cardId),
    variant: String(c["Variant"] ?? "").toUpperCase() === "Y" ? "Y" : "",
    title: w.title, first: String(c["FirstName"] ?? ""), last: String(c["LastName"] ?? ""),
    bats: w.bats, throws: w.throws, value: n(c["Card Value"]), owned: 0,
    stamina: n(c["Stamina"]), pitches: pitchCount(c),
    learn, eligible: ctx.isEligible(c),
    hitVL: round(w.hit.woba_vL), hitVR: round(w.hit.woba_vR), hitOVR: round(w.hit.woba_ovr),
    basicHit: round(b.hit.basic_ovr), basicHitVL: round(b.hit.basic_vL), basicHitVR: round(b.hit.basic_vR),
    pitchVL: round(w.pitch.woba_vL), pitchVR: round(w.pitch.woba_vR), pitchOVR: round(w.pitch.woba_ovr),
    basicPitch: round(b.pitch.basic_ovr), basicPitchVL: round(b.pitch.basic_vL), basicPitchVR: round(b.pitch.basic_vR),
    def,
  };
}
type ScoredRow = ReturnType<typeof toRow>;

// ── Per-tournament scoring (resolve → calibrate → score), cached ──────────────
interface Scored { rows: ScoredRow[]; ctx: ScoreCtx; eligibleCount: number }
let cache = new Map<string, Scored>();

// Baseline solve cache for stage-2 refine: the last full owned-roster solve per
// generation-input key. Refine reuses the objective + roster membership instead of
// re-solving the expensive (~5s slots) baseline (it's already computed at generation).
// Includes the baseline lineups + staff so refine can measure per-side lineup value
// deltas (hitters) and staff-value deltas (pitchers) against them — all in value units.
type BaselineSnap = { objective: number; hitterIds: string[]; pitcherIds: string[]; lineupVR: string[]; lineupVL: string[]; rotation: string[]; bullpen: string[] };
const baselineCache = new Map<string, BaselineSnap>();
const baselineKey = (tid: string, aid: string | null, metric: string, excluded: string[], locked: string[]) =>
  `${tid}|${aid ?? ""}|${metric}|${[...excluded].sort().join(",")}|${[...locked].sort().join(",")}`;
function setBaseline(key: string, snap: BaselineSnap) {
  baselineCache.set(key, snap);
  if (baselineCache.size > 16) baselineCache.delete(baselineCache.keys().next().value!); // bound (single-user)
}

// Active D3 #2 (raw-poly) form: when set, every tournament is scored + calibrated
// with it (one core). null ⇒ the log-linear fallback (the parity baseline, kept while
// #2 is being verified). Refreshed at boot + on activate/delete; changing it clears
// the per-tournament scoring cache so scores recompute.
let activeEventForm: EventForm | null = null;
let activePlatoon: PlatoonExposure | null = null; // active model's measured platoon exposure → new-tournament defaults
let activeWobaWeights: WobaWeights | null = null; // active model's wRAA-derived wOBA weights → folded into coeffs
let activeEnvelope: RatingEnvelope | null = null; // active model's per-rating training maxima → pool-transform saturation ceilings

// Pool-strength rating transform (#2 only). NON-VARIANT cards set every average/distribution
// (the field-size diagnostic was no-variants too); variants are scored but never enter the
// stats. FIELD_N = the validated realistic-field size (tools/field-size.ts).
const FIELD_N = 50;
const isBaseCard = (c: Record<string, unknown>) => String(c["Variant"] ?? "").toUpperCase() !== "Y";
// Reference field = top-50 of the FULL (non-variant) catalog by predicted wOBA — the
// unrestricted "league," dynamic (recomputed when the active model OR catalog changes),
// tournament-independent (raw wOBA is era/park-free). Cached.
let refFieldCache: { key: string; stats: FieldStats } | null = null;
function referenceFieldStats(baseCatalog: any[], coeffs: Coeffs, model: EventModel): FieldStats {
  const key = `${state.activeModelId ?? ""}|${catalogSource}`;
  if (refFieldCache?.key === key) return refFieldCache.stats;
  const stats = computeFieldStats(baseCatalog, coeffs, model, FIELD_N);
  refFieldCache = { key, stats };
  return stats;
}

function scoreTournament(t: Tournament): Scored {
  const era = eras.get(t.eraId);
  const park = parks.get(t.parkId);
  if (!era || !park) throw new Error(`Tournament ${t.id}: missing era '${t.eraId}' or park '${t.parkId}'`);

  const coeffs = resolveCoeffs(model!, era, park, t.softcaps);
  // Platoon OVR splits (scope B): a tournament's own splits (seeded from the active model on
  // create) override the coeff defaults; existing tournaments without `platoon` are untouched.
  if (t.platoon) {
    coeffs.r_hit_split = t.platoon.r_hit_split; coeffs.l_hit_split = t.platoon.l_hit_split; coeffs.s_hit_split = t.platoon.s_hit_split;
    coeffs.r_pitch_split = t.platoon.r_pitch_split; coeffs.l_pitch_split = t.platoon.l_pitch_split;
  }
  // wOBA event weights: the active model's wRAA-derived weights override the historical
  // constants (absent ⇒ woba.ts uses the defaults, bit-identical). Model-scoped, not
  // tournament-scoped — the run environment is the model's, not the tournament's.
  if (activeWobaWeights) applyWobaWeights(coeffs, activeWobaWeights);
  const eventForm = activeEventForm ?? undefined;
  const derived = computeDerived(coeffs, !!eventForm); // #2 ⇒ tHR removed (era_effective_hr = era_hr)
  const pool = buildEligiblePool(catalog.cards, t);
  // Pool transform (#2 only): reference = top-50 of the full NON-VARIANT catalog, pool =
  // top-50 of the eligible NON-VARIANT subset → lift pool toward reference (saturating
  // mean-scalar, capped at the active model's training envelope). Variants are still scored
  // (toRow runs on the whole catalog) — they just don't set the distribution. undefined ⇒
  // no transform (unrestricted pool ⇒ k≈1 ⇒ identity; no #2 model ⇒ log-linear baseline).
  const basePool = pool.filter(isBaseCard);
  let poolTransform: PoolTransform | undefined;
  if (eventForm) {
    const evModel = makeRawPolyModel(eventForm);
    const ref = referenceFieldStats(catalog.cards.filter(isBaseCard), coeffs, evModel);
    poolTransform = buildPoolTransform(ref, computeFieldStats(basePool, coeffs, evModel, FIELD_N), activeEnvelope ?? undefined);
  }
  // wOBA config uses the active #2 form + pool transform. The anchor is computed on
  // NON-VARIANT cards too (same "variants set no averages" principle). Basic metric is
  // rating-direct but still gets the pool transform (it re-bases ratings, which basic reads).
  const config = { coeffs, derived, eventForm, poolTransform, calScales: calibrate(basePool, { coeffs, derived, eventForm, poolTransform }) };
  // eventForm threaded in so the basic path's (discarded) wOBA uses #2, not the log-linear
  // fallback — basic_* is rating-direct and unchanged; this keeps log-linear out of production.
  const basicConfig = { coeffs, derived, eventForm, poolTransform, calScales: calibrateBasic(basePool, { coeffs, derived, eventForm, poolTransform }) };

  const inValueRange = (c: Record<string, unknown>) => {
    const v = n(c["Card Value"]); const lo = t.card_value_min, hi = t.card_value_max;
    return (lo == null || v >= lo) && (hi == null || v <= hi);
  };
  const isEligible = (c: Record<string, unknown>) => inValueRange(c) && rowEligible(c as any, t);
  const ctx: ScoreCtx = { config, basicConfig, isEligible };

  return { rows: catalog.cards.map((c) => toRow(c, ctx)), ctx, eligibleCount: pool.length };
}

function scoredFor(id: string): { t: Tournament; s: Scored } {
  const t = tournamentById.get(id) ?? tournamentById.get(DEFAULT_TOURNAMENT_ID)!;
  let s = cache.get(t.id);
  if (!s) { s = scoreTournament(t); cache.set(t.id, s); }
  return { t, s };
}

// Assemble the response for a (tournament, account): stamp owned + add this
// account's variant rows. Scoring is reused from the tournament cache.
function buildCards(tournamentId: string, accountId: string | null): ScoredRow[] {
  const { s } = scoredFor(tournamentId);
  const acc = accountId ? accounts.get(accountId) : null;
  const owned = acc?.owned ?? {};
  const rows = s.rows.map((r) => ({ ...r, owned: owned[r.id] ?? 0 }));
  for (const vid of acc?.variantCardIds ?? []) {
    const base = catalogById.get(vid);
    if (base) rows.push({ ...toRow(makeVariant(base), s.ctx), owned: owned[vid] ?? 0 });
  }
  return rows;
}

function buildMeta(tournamentId: string, accountId: string | null) {
  const { t, s } = scoredFor(tournamentId);
  const acc = accountId ? accounts.get(accountId) : null;
  const ownedCount = acc ? Object.values(acc.owned).filter((q) => q > 0).length : 0;
  return {
    configName: model!.name, tournament: t.name,
    account: acc?.name ?? "(none)", accountId: acc?.id ?? null,
    catalogSource: catalogSource,
    cardCount: catalog.cards.length + (acc?.variantCardIds.length ?? 0),
    eligibleCount: s.eligibleCount, ownedCount,
  };
}

// Display order: explicit state.accountOrder first (user preference / default),
// then any remaining accounts alphabetically.
function orderedAccounts(): AccountOverlay[] {
  const order = state.accountOrder ?? [];
  const rank = (id: string) => { const i = order.indexOf(id); return i < 0 ? order.length + 1 : i; };
  return [...accounts.values()].sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name));
}

const accountSummary = () => ({
  accounts: orderedAccounts().map((a) => ({
    id: a.id, name: a.name,
    ownedCount: Object.values(a.owned).filter((q) => q > 0).length,
    totalQty: Object.values(a.owned).reduce((s, q) => s + (q > 0 ? q : 0), 0),
    variantCount: a.variantCardIds.length,
  })),
  activeId: state.activeAccountId, catalogSource,
});

// Recompute the shared catalog (after an upload changed the source) + drop caches.
function refreshCatalog() {
  ({ catalog, source: catalogSource } = loadCatalog());
  catalogById = new Map(catalog.cards.map((c) => [cardId(c), c]));
  cache = new Map();
}

// ── Roster generation (M4 Phase D) ────────────────────────────────────────────
// Owned-scoped candidates (D6: you can only roster cards you own), scored for the
// active tournament. A card you own AND have a v5 variant of is scored as the
// variant (it dominates).
//
// EVERY card has both a hit score and a pitch score (position is irrelevant) — so
// every eligible card is a candidate for BOTH pools. The pools are then SLICED by
// rule: non-cap = Top-X (hitters: union of top-X by vL and by vR; pitchers: top-X
// by OVR), cap/slots = top-1500 each. A card landing in BOTH the top-X hitter and
// top-X pitcher sets is a TWO-WAY player (this Top-X overlap cutoff is used even in
// cap/slots mode, where the pools themselves are 1500). The per-card role override
// forces a card into Hit-only / Pitch-only / two-way regardless of ranking.
const HARD_POOL_CAP = 1500;
// Stage-2 refine reduced re-solve pool: baseline roster ∪ candidate ∪ top-N-by-value
// ∪ N-cheapest. Validated exact vs a 10× pool (rebalances only touch cards near the
// roster) while cutting each re-solve ~5s→~0.1s.
const REFINE_POOL_TOPVALUE = 60;
const REFINE_POOL_CHEAPEST = 30;
type RoleOverride = "hitter" | "pitcher" | "twoway";

const defOf = (c: Record<string, unknown>) => ({
  ifR: n(c["Infield Range"]), ifE: n(c["Infield Error"]), ifA: n(c["Infield Arm"]), dp: n(c["DP"]),
  cAb: n(c["CatcherAbil"]), cFr: n(c["CatcherFrame"]), cAr: n(c["Catcher Arm"]),
  ofR: n(c["OF Range"]), ofE: n(c["OF Error"]), ofA: n(c["OF Arm"]),
});
type Def = ReturnType<typeof defOf>;

// Per-position defensive ratings (rating id → Def field) for the per-position min
// constraints. IF positions share one rating set, OF another, C another.
type RatingSpec = { key: string; field: keyof Def };
const IF_RATINGS: RatingSpec[] = [{ key: "range", field: "ifR" }, { key: "error", field: "ifE" }, { key: "arm", field: "ifA" }, { key: "dp", field: "dp" }];
const OF_RATINGS: RatingSpec[] = [{ key: "range", field: "ofR" }, { key: "error", field: "ofE" }, { key: "arm", field: "ofA" }];
const C_RATINGS: RatingSpec[] = [{ key: "ability", field: "cAb" }, { key: "frame", field: "cFr" }, { key: "arm", field: "cAr" }];
const POSITION_RATINGS: Record<string, RatingSpec[]> = {
  C: C_RATINGS, "1B": IF_RATINGS, "2B": IF_RATINGS, "3B": IF_RATINGS, SS: IF_RATINGS, LF: OF_RATINGS, CF: OF_RATINGS, RF: OF_RATINGS,
};
/** Does a card's defense meet every min for a position tier? (no mins → yes) */
const meetsPositionMins = (def: Def, pos: string, mins?: Record<string, number>): boolean => {
  if (!mins) return true;
  for (const spec of POSITION_RATINGS[pos] ?? []) {
    const m = mins[spec.key];
    if (m != null && (def[spec.field] ?? 0) < m) return false;
  }
  return true;
};

// ── Position pool stats (Tournament-page metrics + rank-requirement enforcement) ──
// Over the eligible Top-X hitter pool, for each field position gather the players who can
// play it and summarise each defensive rating's distribution (sorted high→low; higher is
// better). One source of truth, consumed by the /api/position-metrics display AND by the
// optimizer's rank requirements (a "top-K" requirement → effective min = the K-th highest
// value in the pool). `sortedDesc` is kept for that lookup; the endpoint strips it.
export interface RatingDist { n: number; mean: number; max: number; p90: number; p95: number; top5: number; top10: number; sortedDesc: number[] }
const pctFromTop = (sortedDesc: number[], p: number): number => {
  if (!sortedDesc.length) return 0;
  return sortedDesc[Math.min(sortedDesc.length - 1, Math.floor((1 - p) * sortedDesc.length))]!;
};
const ratingDist = (sortedDesc: number[]): RatingDist => ({
  n: sortedDesc.length,
  mean: sortedDesc.length ? sortedDesc.reduce((s, x) => s + x, 0) / sortedDesc.length : 0,
  max: sortedDesc[0] ?? 0,
  p90: pctFromTop(sortedDesc, 0.9), p95: pctFromTop(sortedDesc, 0.95),
  top5: sortedDesc[Math.min(4, sortedDesc.length - 1)] ?? 0,
  top10: sortedDesc[Math.min(9, sortedDesc.length - 1)] ?? 0,
  sortedDesc,
});
function positionPoolStats(t: Tournament, s: Scored): Record<string, Record<string, RatingDist>> {
  const ctx = s.ctx;
  const xH = t.topHitters && t.topHitters > 0 ? t.topHitters : 100;
  // Score every eligible NON-VARIANT card; keep its defense, playable positions, and hit
  // value. Variants are excluded from the pool distribution (mean/max/top5/top10 and the
  // rank-requirement thresholds derived from it) — same "variants set no baseline" rule as
  // the rating-scaling reference field.
  const cands: { def: Def; positions: string[]; vL: number; vR: number }[] = [];
  for (const c0 of catalog.cards) {
    if (!isBaseCard(c0) || !ctx.isEligible(c0)) continue;
    const sc = scoreCard(c0, ctx.config);
    cands.push({
      def: defOf(c0),
      positions: LEARN.filter(([col]) => n(c0[col]) === 1).map(([, p]) => p),
      vL: valueFor(sc.hit.woba_vL, "hitter"), vR: valueFor(sc.hit.woba_vR, "hitter"),
    });
  }
  // Pool = union of top-X by vL and by vR (matches the generation two-way cutoff).
  const pool = new Set([
    ...[...cands].sort((a, b) => b.vL - a.vL).slice(0, xH),
    ...[...cands].sort((a, b) => b.vR - a.vR).slice(0, xH),
  ]);
  const out: Record<string, Record<string, RatingDist>> = {};
  for (const [pos, specs] of Object.entries(POSITION_RATINGS)) {
    const members = [...pool].filter((c) => c.positions.includes(pos));
    const perRating: Record<string, RatingDist> = {};
    for (const spec of specs) perRating[spec.key] = ratingDist(members.map((c) => c.def[spec.field] ?? 0).sort((a, b) => b - a));
    out[pos] = perRating;
  }
  return out;
}
// True if a positionRanks config has any rank requirement set.
const hasAnyRank = (pr?: Record<string, { starter?: Record<string, number>; backup?: Record<string, number> }>): boolean =>
  !!pr && Object.values(pr).some((p) => Object.keys(p.starter ?? {}).length > 0 || Object.keys(p.backup ?? {}).length > 0);

// A fully-scored candidate (both sides) before any pool slicing. The Next Best
// Available pool reads these directly (unsliced); the optimizer reads the sliced
// subsets built below.
interface Entry {
  dispId: string;
  hitVR: number; hitVL: number; pitVR: number; pitVL: number; pitOVR: number;
  positions: string[]; stamina: number; pitchTypes: number;
  bats: number; throws: number; title: string; cost: number;
  role: RoleOverride | "auto";
}

type Metric = "woba" | "basic";

function rosterCandidates(
  t: Tournament, accountId: string | null, ownedOnly: boolean,
  excluded: Set<string>, roleOverrides: Record<string, RoleOverride>, locked: Set<string>,
  platoonVR: number, platoonVL: number, metric: Metric,
): { hitters: HitterCandidate[]; pitchers: PitcherCandidate[]; twoWayIds: string[]; entries: Entry[]; ownedByDisp: Record<string, number>; defByDisp: Record<string, Def>; lastByDisp: Record<string, string>; firstByDisp: Record<string, string>; starterPosByDisp: Record<string, string[]> } {
  const { s } = scoredFor(t.id);
  const ctx = s.ctx;
  const ps = resolvePitchSplit(t); // (hand,role) pitcher batter-hand exposure (see resolvePitchSplit)
  // Signed-distance value (D2) in the active metric. basic: score − 100 for BOTH
  // roles (basic-hit and basic-pitch are both higher-is-better). woba: hitter
  // woba − baseline, pitcher baseline − allowedWoba.
  const cfg = metric === "basic" ? ctx.basicConfig : ctx.config;
  const hitVal = (sc: ReturnType<typeof scoreCard>, side: "vR" | "vL") =>
    metric === "basic" ? (side === "vR" ? sc.hit.basic_vR : sc.hit.basic_vL) - TARGET_BASIC : valueFor(side === "vR" ? sc.hit.woba_vR : sc.hit.woba_vL, "hitter");
  const pitVal = (sc: ReturnType<typeof scoreCard>, side: "vR" | "vL") =>
    metric === "basic" ? (side === "vR" ? sc.pitch.basic_vR : sc.pitch.basic_vL) - TARGET_BASIC : valueFor(side === "vR" ? sc.pitch.woba_vR : sc.pitch.woba_vL, "pitcher");
  const acc = accountId ? accounts.get(accountId) : null;
  const owned = acc?.owned ?? {};
  const variantIds = new Set(acc?.variantCardIds ?? []);

  const entries: Entry[] = [];
  const ownedByDisp: Record<string, number> = {};
  const defByDisp: Record<string, Def> = {};
  const lastByDisp: Record<string, string> = {};
  const firstByDisp: Record<string, string> = {};

  for (const c0 of catalog.cards) {
    const id = cardId(c0);
    const qty = owned[id] ?? 0;
    // entries = ALL eligible (owned + unowned), so the Next Best pool can show
    // unowned cards independently of the generation owned-only flag. Owned-scoping
    // is applied below to the OPTIMIZER pool only (rankable).
    if (excluded.has(id) || !ctx.isEligible(c0)) continue;
    const useVariant = variantIds.has(id) && t.variants_allowed;
    const c = useVariant ? makeVariant(c0) : c0;
    const sc = scoreCard(c, cfg);
    const cost = n(c0["Card Value"]);
    const dispId = useVariant ? `${id}#V` : id;
    const positions = [...LEARN.filter(([col]) => n(c0[col]) === 1).map(([, p]) => p), "DH"];
    const pitVR = pitVal(sc, "vR");
    const pitVL = pitVal(sc, "vL");
    // Single representative OVR (next-best ranking + upgrade input): role unknown
    // pre-solve, so guess from starter-qualification (stamina + pitch types).
    const pRole: PitchRole = n(c0["Stamina"]) >= t.min_starter_stamina && pitchCount(c0) >= t.min_pitch_types ? "sp" : "rp";
    entries.push({
      dispId,
      hitVR: hitVal(sc, "vR"), hitVL: hitVal(sc, "vL"),
      pitVR, pitVL, pitOVR: blendPitch(pitVR, pitVL, sc.throws, pRole, ps, platoonVR, platoonVL),
      positions, stamina: n(c0["Stamina"]), pitchTypes: pitchCount(c0),
      bats: sc.bats, throws: sc.throws, title: String(sc.title), cost,
      role: roleOverrides[id] ?? "auto",
    });
    ownedByDisp[dispId] = qty;
    defByDisp[dispId] = defOf(c);
    lastByDisp[dispId] = String(c0["LastName"] ?? "");
    firstByDisp[dispId] = String(c0["FirstName"] ?? "");
  }

  // Pool slicing + two-way overlap (see header). N = top-X (non-budgeted) / 1500 (cap/slots).
  const budgeted = budgetMode(t) !== "none";
  const xH = t.topHitters && t.topHitters > 0 ? t.topHitters : 100;
  const xP = t.topPitchers && t.topPitchers > 0 ? t.topPitchers : 100;
  const poolH = budgeted ? HARD_POOL_CAP : xH;
  const poolP = budgeted ? HARD_POOL_CAP : xP;

  // Optimizer pool is owned-scoped (you can only roster owned cards) when ownedOnly;
  // ranking + slicing happen over this set so Top-X = top owned.
  const rankable = ownedOnly ? entries.filter((e) => (ownedByDisp[e.dispId] ?? 0) > 0) : entries;
  const byVL = [...rankable].sort((a, b) => b.hitVL - a.hitVL);
  const byVR = [...rankable].sort((a, b) => b.hitVR - a.hitVR);
  const byPit = [...rankable].sort((a, b) => b.pitOVR - a.pitOVR);
  const unionTopHit = (k: number) => new Set([...byVL.slice(0, k), ...byVR.slice(0, k)].map((e) => e.dispId));
  const topPit = (k: number) => new Set(byPit.slice(0, k).map((e) => e.dispId));

  const hitterPool = unionTopHit(poolH);
  const pitcherPool = topPit(poolP);
  const twHit = unionTopHit(xH);  // top-X cutoff for two-way (tighter than the pool)
  const twPit = topPit(xP);

  const hitters: HitterCandidate[] = [];
  const pitchers: PitcherCandidate[] = [];
  const twoWayIds: string[] = [];
  const posMins = t.positionMins ?? {};
  // Effective per-position mins = absolute mins MERGED with rank requirements
  // (positionRanks). A "top-K" rank requirement becomes an effective min equal to the
  // K-th highest value of that rating in the eligible Top-X pool, so a card qualifies
  // only if it would place within the top K. Computed once over the same pool stats the
  // Tournament page displays. Skip the pool-stats pass entirely when no ranks are set.
  const posRanks = t.positionRanks ?? {};
  const rankStats = hasAnyRank(posRanks) ? positionPoolStats(t, s) : null;
  const effMins = (pos: string, tier: "starter" | "backup"): Record<string, number> | undefined => {
    const abs = posMins[pos]?.[tier];
    const rnk = rankStats ? posRanks[pos]?.[tier] : undefined;
    if (!abs && !rnk) return undefined;
    const merged: Record<string, number> = { ...(abs ?? {}) };
    for (const [key, K] of Object.entries(rnk ?? {})) {
      const sorted = rankStats![pos]?.[key]?.sortedDesc ?? [];
      const thr = sorted.length ? sorted[Math.min(K, sorted.length) - 1]! : 0;
      merged[key] = Math.max(merged[key] ?? -Infinity, thr);
    }
    return merged;
  };
  // Precompute the merged mins per position/tier (constant across all cards).
  const effStarter: Record<string, Record<string, number> | undefined> = {};
  const effBackup: Record<string, Record<string, number> | undefined> = {};
  for (const pos of Object.keys(POSITION_RATINGS)) { effStarter[pos] = effMins(pos, "starter"); effBackup[pos] = effMins(pos, "backup"); }
  // Starter-eligible positions (lineup) + backup-eligible (coverage), per the merged
  // per-position mins. A starter automatically backs up too; DH has no defensive min.
  const qualifiedPositions = (dispId: string, raw: string[]): { starter: string[]; cover: string[] } => {
    const def = defByDisp[dispId]!;
    const field = raw.filter((p) => p !== "DH");
    const canStart = (p: string) => meetsPositionMins(def, p, effStarter[p]);
    return {
      starter: ["DH", ...field.filter(canStart)],
      cover: field.filter((p) => canStart(p) || meetsPositionMins(def, p, effBackup[p])),
    };
  };
  // Starter-eligible positions for EVERY eligible card (owned + unowned) — the Biggest
  // Upgrades estimate needs unowned candidates' lineup eligibility, which the owned-scoped
  // optimizer pool doesn't carry.
  const starterPosByDisp: Record<string, string[]> = {};
  for (const e of entries) starterPosByDisp[e.dispId] = qualifiedPositions(e.dispId, e.positions).starter;

  // Force-include locked / role-overridden cards even if they fell outside the Top-X
  // slice or are unowned — so a manually-added/locked card actually binds on solve.
  const strip0 = (id: string) => id.replace(/#V$/, "");
  const rankableSet = new Set(rankable.map((e) => e.dispId));
  const forcedBase = new Set<string>([...locked, ...Object.keys(roleOverrides)]);
  const poolEntries = forcedBase.size
    ? [...rankable, ...entries.filter((e) => !rankableSet.has(e.dispId) && forcedBase.has(strip0(e.dispId)))]
    : rankable;

  for (const e of poolEntries) {
    const forcedIn = !rankableSet.has(e.dispId); // a force-included card (below cut / unowned)
    // Forced Hit/Pitch wins over ranking; forced/auto 2way needs both pools. A
    // force-included card with no explicit role defaults to a hitter candidate.
    const useH = e.role === "hitter" || e.role === "twoway" || (e.role === "auto" && (forcedIn || hitterPool.has(e.dispId)));
    const useP = e.role === "pitcher" || e.role === "twoway" || (e.role === "auto" && pitcherPool.has(e.dispId));
    if (useH) {
      const q = qualifiedPositions(e.dispId, e.positions);
      hitters.push({ id: e.dispId, title: e.title, bats: e.bats, valueVR: e.hitVR, valueVL: e.hitVL, positions: q.starter, coverPositions: q.cover, playPositions: e.positions, cost: e.cost });
    }
    if (useP) pitchers.push({ id: e.dispId, title: e.title, throws: e.throws, valueVR: e.pitVR, valueVL: e.pitVL, stamina: e.stamina, pitchTypes: e.pitchTypes, cost: e.cost });
    const isTwoWay = useH && useP && (e.role === "twoway" || (e.role === "auto" && twHit.has(e.dispId) && twPit.has(e.dispId)));
    if (isTwoWay) twoWayIds.push(e.dispId);
  }
  return { hitters, pitchers, twoWayIds, entries, ownedByDisp, defByDisp, lastByDisp, firstByDisp, starterPosByDisp };
}

// Effective budget mode: explicit field, else derived (slots > cap > none).
function budgetMode(t: Tournament): "none" | "cap" | "slots" {
  if (t.budget_mode) return t.budget_mode;
  if (t.slot_counts && Object.keys(t.slot_counts).length) return "slots";
  if (t.total_cap && t.total_cap > 0) return "cap";
  return "none";
}

// Resolve the (hand, role) pitcher batter-hand split for the optimizer. Each field
// falls back independently: tournament's own role field → active model's measured
// role split → tournament role-blind pitch_split (Step A: handedness-correct, role-
// flat). If none of those exist for any field ⇒ undefined, and the optimizer keeps
// the legacy team-split collapse. So existing tournaments (role-blind platoon only)
// get the handedness fix immediately and role differentiation from the active model
// without rewriting stored config; tournaments with no platoon at all are unchanged.
function resolvePitchSplit(t: Tournament): PitchSplit | undefined {
  const p = t.platoon;
  const model = activePlatoon?.pitchRoleSplits;
  const r = (role: PitchRole) => (role === "sp" ? p?.r_pitch_split_sp : p?.r_pitch_split_rp) ?? model?.[role]?.r ?? p?.r_pitch_split;
  const l = (role: PitchRole) => (role === "sp" ? p?.l_pitch_split_sp : p?.l_pitch_split_rp) ?? model?.[role]?.l ?? p?.l_pitch_split;
  const spR = r("sp"), spL = l("sp"), rpR = r("rp"), rpL = l("rp");
  if (spR == null || spL == null || rpR == null || rpL == null) return undefined;
  return { sp: { r: spR, l: spL }, rp: { r: rpR, l: rpL } };
}

function rosterOptions(t: Tournament): RosterOptimizeOptions {
  return {
    nHitters: t.hitters, nPitchers: t.pitchers, dh: t.dh,
    minStarters: t.min_starters, minStarterStamina: t.min_starter_stamina, minPitchTypes: t.min_pitch_types,
    platoonVR: t.platoonVR ?? 0.62, platoonVL: t.platoonVL ?? 0.38, // team exposure: weights the vR/vL HITTER lineups
    pitchSplit: resolvePitchSplit(t),                               // (hand,role) PITCHER batter-hand exposure
    minPlayersPerPosition: t.minPlayersPerPosition ?? 2,            // coverage depth / backups
    mode: budgetMode(t), totalCap: t.total_cap ?? undefined, slotCounts: t.slot_counts,
    rosterSize: t.roster_size,
  };
}

type LineupLock = { id: string; pos: string; side: "L" | "R" };
async function generateRosterFor(tid: string, aid: string | null, ownedOnly: boolean, locked: string[], excluded: string[], roleOverrides: Record<string, RoleOverride>, metric: Metric, lineupLocks: LineupLock[]) {
  const t = tournamentById.get(tid) ?? tournamentById.get(DEFAULT_TOURNAMENT_ID)!;
  const opts0 = rosterOptions(t);
  // A position-locked card must survive pool slicing — force-include it like a
  // roster lock. (The yh=1 lock then forces it rostered, so it need not also be
  // in lockedIds.)
  const forceInclude = new Set([...locked, ...lineupLocks.map((l) => l.id)]);
  const { hitters, pitchers, twoWayIds, entries, ownedByDisp, defByDisp, lastByDisp, firstByDisp, starterPosByDisp } = rosterCandidates(t, aid, ownedOnly, new Set(excluded), roleOverrides, forceInclude, opts0.platoonVR, opts0.platoonVL, metric);
  const opts = { ...opts0, lockedIds: locked, twoWayIds, lineupLocks };
  const r = await generateFullRoster(hitters, pitchers, opts);
  // Stash the baseline (owned solve) so stage-2 refine can reuse it instead of
  // re-solving the expensive budgeted baseline.
  if (ownedOnly && r.status === "Optimal") setBaseline(baselineKey(tid, aid, metric, excluded, locked), {
    objective: r.objective, hitterIds: r.hitters, pitcherIds: r.pitchers,
    lineupVR: r.lineupVR.map((x) => x.id), lineupVL: r.lineupVL.map((x) => x.id),
    rotation: r.rotation.map((x) => x.id), bullpen: r.bullpen,
  });
  // Reconstruct the DISPLAY score from the signed-distance value, per metric.
  // hitter: value + baseline (both metrics). pitcher: woba → baseline − value
  // (allowed wOBA); basic → value + baseline (quality, higher = better).
  const BASE = metric === "basic" ? TARGET_BASIC : TARGET_WOBA;
  const hScore = (v: number) => round(v + BASE);
  const pScore = (v: number) => round(metric === "basic" ? v + BASE : BASE - v);

  const hById = new Map(hitters.map((c) => [c.id, c]));
  const pById = new Map(pitchers.map((c) => [c.id, c]));
  const hCard = (id: string) => { const c = hById.get(id); return { id, title: c?.title ?? id, cost: c?.cost ?? 0 }; };
  const pCard = (id: string) => { const c = pById.get(id); return { id, title: c?.title ?? id, cost: c?.cost ?? 0, stamina: c?.stamina ?? 0, pitchTypes: c?.pitchTypes ?? 0 }; };
  const starterIds = new Set([...r.lineupVR, ...r.lineupVL].map((x) => x.id));
  const bench = r.hitters.filter((id) => !starterIds.has(id)).map(hCard);

  // Per-card roster ROLE (drives the colour coding on the grid + roster page),
  // keyed by base Card ID. Hitters: both/vL/vR/bench by lineup membership;
  // pitchers: starter (in rotation) / reliever (bullpen). Two-way cards get the
  // dedicated "twoway" colour on the grid (the per-table role still shows their
  // lineup / rotation slot). Matches old-app colours.
  const strip = (id: string) => id.replace(/#V$/, "");
  const vrIds = new Set(r.lineupVR.map((x) => x.id));
  const vlIds = new Set(r.lineupVL.map((x) => x.id));
  const rotIds = new Set(r.rotation.map((x) => x.id));
  const twoWaySet = new Set((r.twoWay ?? []).map(strip));
  const hitRole = (id: string) => vrIds.has(id) && vlIds.has(id) ? "both" : vlIds.has(id) ? "vL" : vrIds.has(id) ? "vR" : "bench";
  const pitRole = (id: string) => rotIds.has(id) ? "starter" : "reliever";
  const roles: Record<string, string> = {};
  for (const id of r.hitters) roles[strip(id)] = hitRole(id);
  for (const id of r.pitchers) if (!roles[strip(id)]) roles[strip(id)] = pitRole(id);
  for (const id of twoWaySet) roles[id] = "twoway";

  // Roster LIST detail (the 26-card tables). wOBA reconstructed from valueFor
  // (hitter = value + baseline; pitcher allowed = baseline − value), matching the grid.
  const BATS: Record<number, string> = { 1: "R", 2: "L", 3: "S" };
  const THROWS: Record<number, string> = { 1: "R", 2: "L" };
  const roleRank: Record<string, number> = { both: 0, vL: 1, vR: 1, bench: 2, starter: 0, reliever: 1 };
  // Raw Learn positions (all a card CAN play) per dispId — POS shows these; the
  // starter-eligible subset (c.positions) drives the def-requirement colour-coding.
  const rawPosByDisp = new Map(entries.map((e) => [e.dispId, e.positions]));
  const rosterHitters = r.hitters.map((id) => {
    const c = hById.get(id)!; const role = hitRole(id);
    return { id: strip(id), title: c.title, last: lastByDisp[id] ?? "", first: firstByDisp[id] ?? "", bats: BATS[c.bats] ?? "", role, twoWay: twoWaySet.has(strip(id)), positions: c.positions, coverPositions: c.coverPositions ?? c.positions, allPositions: rawPosByDisp.get(id) ?? c.positions, def: defByDisp[id],
      wobaVL: hScore(c.valueVL), wobaVR: hScore(c.valueVR), cost: c.cost, owned: ownedByDisp[id] ?? 0 };
  }).sort((a, b) => roleRank[a.role]! - roleRank[b.role]! || Math.max(b.wobaVL, b.wobaVR) - Math.max(a.wobaVL, a.wobaVR));
  const rosterPitchers = r.pitchers.map((id) => {
    const c = pById.get(id)!; const role = pitRole(id);
    const combined = blendPitch(c.valueVR, c.valueVL, c.throws, role === "starter" ? "sp" : "rp", opts.pitchSplit, opts.platoonVR, opts.platoonVL);
    return { id: strip(id), title: c.title, last: lastByDisp[id] ?? "", first: firstByDisp[id] ?? "", throws: THROWS[c.throws] ?? "", role, twoWay: twoWaySet.has(strip(id)),
      woba: pScore(combined), stamina: c.stamina, pitchTypes: c.pitchTypes, cost: c.cost, owned: ownedByDisp[id] ?? 0 };
  }).sort((a, b) => roleRank[a.role]! - roleRank[b.role]! || a.woba - b.woba);

  // ── Next Best Available pool (M5) ──────────────────────────────────────────
  // The top AVAILABLE cards (eligible + owned-scoped, NOT on the current roster),
  // for manual roster editing. Returned UNSLICED (the whole owned/eligible pool,
  // not just the optimizer's Top-X) so the user can pull in any owned card. The
  // client tabs/sorts this by need (Hit vL/vR, Pitch, SP, defence; value filter
  // later) and +Add fills an open roster slot. Bounded to the top of each pool.
  const rosteredDisp = new Set([...r.hitters, ...r.pitchers]);
  // The FULL available pool: every eligible card not on the roster, as one unified
  // row carrying both hit + pitch values. The client sorts/filters per tab (owned,
  // value, position) and renders only the top slice — so a value filter down to the
  // tournament's card-value min still reaches the cheapest cards (cap-roster need).
  const available = entries.filter((e) => !rosteredDisp.has(e.dispId)).map((e) => ({
    id: strip(e.dispId), title: e.title, last: lastByDisp[e.dispId] ?? "",
    bats: BATS[e.bats] ?? "", throws: THROWS[e.throws] ?? "",
    positions: e.positions, startPositions: starterPosByDisp[e.dispId] ?? [], def: defByDisp[e.dispId]!, cost: e.cost, owned: ownedByDisp[e.dispId] ?? 0,
    hitVL: hScore(e.hitVL), hitVR: hScore(e.hitVR),
    pitOVR: pScore(e.pitOVR), pitVL: pScore(e.pitVL), pitVR: pScore(e.pitVR),
    stamina: e.stamina, pitchTypes: e.pitchTypes,
  }));
  const nextBest = { available };

  // ── Biggest Upgrades (M5b) ──────────────────────────────────────────────────
  // Non-owned acquisition targets that would improve THIS roster. Hitters: the
  // lineup-assignment delta of adding the card and making the best forced roster cut —
  // a max-weight matching per side handles position cascades (2B→SS→…) and respects
  // def/rank eligibility (a card is only assignable to positions it qualifies to start).
  // Pitchers: marginal vs the weakest rotation (SP) / bullpen (RP) arm. Only computed for
  // the regime where "best owned roster, what to acquire" is well-defined: non-cap/
  // non-slots + owned-only. Coverage-depth (backups) is intentionally out of scope here.
  type HU = { id: string; title: string; last: string; bats: string; positions: string[]; allPositions: string[]; cost: number; deltaVR: number; deltaVL: number; total: number; twoWay: boolean };
  type PU = { id: string; title: string; last: string; throws: string; stamina: number; pitchTypes: number; cost: number; total: number; twoWay: boolean };
  let biggestUpgrades: { hitters: HU[]; sp: PU[]; rp: PU[] } | null = null;
  if (ownedOnly) {
    const wVR = opts.platoonVR, wVL = opts.platoonVL, dh = opts.dh, EPS = 1e-6;
    // Budget feasibility for cap/slots: acquiring X means a one-for-one swap (drop a card of the
    // same role), and the swap must keep the roster within the cap (total ≤ cap) or within the
    // cumulative slot-tier limits. In non-cap mode every swap is feasible.
    const hCost = (id: string) => hById.get(id)?.cost ?? 0;
    const pCost = (id: string) => pById.get(id)?.cost ?? 0;
    const allCosts = [...r.hitters.map(hCost), ...r.pitchers.map(pCost)];
    const rosterCost = allCosts.reduce((a, b) => a + b, 0);
    const cap = t.total_cap ?? Infinity;
    const tierLimits = opts.mode === "slots" ? cumulativeSlotLimits(t.slot_counts ?? {}, opts.rosterSize ?? (t.hitters + t.pitchers)).map((l) => ({ ...l, n: allCosts.filter((c) => c >= l.threshold).length })) : [];
    const feasibleSwap = (costOut: number, costIn: number): boolean => {
      if (opts.mode === "cap") return rosterCost - costOut + costIn <= cap + EPS;
      if (opts.mode === "slots") return tierLimits.every((l) => l.n - (costOut >= l.threshold ? 1 : 0) + (costIn >= l.threshold ? 1 : 0) <= l.limit);
      return true;
    };
    const curH: { id: string; positions: string[]; valueVR: number; valueVL: number; cost: number }[] = r.hitters.map((id) => { const c = hById.get(id)!; return { id, positions: c.positions, valueVR: c.valueVR, valueVL: c.valueVL, cost: c.cost }; });
    const baseR = bestLineupValue(curH, "R", dh), baseL = bestLineupValue(curH, "L", dh);
    const jointBase = wVR * baseR + wVL * baseL;
    // Weakest current starter per side. A hitter's lineup value is position-independent,
    // so the assignment marginal telescopes to (candidate − benched starter); a card can
    // only improve a side if its value beats that side's weakest starter. Safe O(1) gate.
    const minStartR = Math.min(...r.lineupVR.map((x) => hById.get(x.id)?.valueVR ?? Infinity));
    const minStartL = Math.min(...r.lineupVL.map((x) => hById.get(x.id)?.valueVL ?? Infinity));
    const hitUp: HU[] = [];
    for (const e of entries) {
      if (rosteredDisp.has(e.dispId) || (ownedByDisp[e.dispId] ?? 0) > 0) continue;
      const pos = starterPosByDisp[e.dispId] ?? ["DH"];
      if (!pos.some((p) => p !== "DH") && e.pitchTypes > 0) continue; // pure pitcher → not a hitter upgrade
      if (e.hitVR <= minStartR + EPS && e.hitVL <= minStartL + EPS) continue; // can't beat any starter
      const X = { id: e.dispId, positions: pos, valueVR: e.hitVR, valueVL: e.hitVL, cost: e.cost };
      const withX = [...curH, X];
      // Joint marginal: add X, then drop the one hitter that costs least across both lineups —
      // restricted to BUDGET-FEASIBLE swaps in cap/slots. Dropping X itself = "don't acquire"
      // (the baseline), always allowed, so the marginal is floored at 0.
      let bestJv = -Infinity, bestNR = baseR, bestNL = baseL;
      for (let d = 0; d < withX.length; d++) {
        if (withX[d]!.id !== X.id && !feasibleSwap(withX[d]!.cost, X.cost)) continue;
        const sub = withX.filter((_, i) => i !== d);
        const nr = bestLineupValue(sub, "R", dh), nl = bestLineupValue(sub, "L", dh);
        const jv = wVR * nr + wVL * nl;
        if (jv > bestJv) { bestJv = jv; bestNR = nr; bestNL = nl; }
      }
      const total = bestJv - jointBase;
      if (total <= EPS) continue;
      hitUp.push({ id: strip(e.dispId), title: e.title, last: lastByDisp[e.dispId] ?? "", bats: BATS[e.bats] ?? "", positions: pos.filter((p) => p !== "DH"), allPositions: (rawPosByDisp.get(e.dispId) ?? pos).filter((p) => p !== "DH"), cost: e.cost, deltaVR: round(bestNR - baseR), deltaVL: round(bestNL - baseL), total: round(total), twoWay: false });
    }
    // Pitchers: weighted STAFF re-sort. The staff objective mirrors the optimizer's
    // (Σ bullpenW·value over all rostered + Σ slotW_k·value over the rotation), so adding a
    // candidate, dropping the genuinely-worst arm, and re-sorting captures the full cascade —
    // a new SP bumps the old worst starter down into the bullpen (where it still contributes
    // at the bullpen weight), which bumps the worst reliever off the staff. The marginal is the
    // weighted staff-value delta; the bucket (SP/RP) is where the candidate lands after the sort.
    // Upgrade staff weighting: a rotation arm counts full (it throws ~4× a reliever's innings),
    // a bullpen arm at 0.25 of a starter. Flat — no per-slot or per-reliever differentiation.
    const ROT_W = 1, BULL_W = 0.25;
    const minSP = opts.minStarters, nPit = opts.nPitchers;
    type Arm = { id: string; value: number; qualified: boolean };
    const staff = (arms: Arm[]): { val: number; rot: Set<string>; bull: Set<string> } => {
      const rot = arms.filter((a) => a.qualified).sort((a, b) => b.value - a.value).slice(0, minSP);
      const rotSet = new Set(rot.map((a) => a.id));
      const bull = arms.filter((a) => !rotSet.has(a.id)).sort((a, b) => b.value - a.value).slice(0, Math.max(0, nPit - minSP));
      let val = 0;
      rot.forEach((a) => { val += ROT_W * a.value; });
      bull.forEach((a) => { val += BULL_W * a.value; });
      return { val, rot: rotSet, bull: new Set(bull.map((a) => a.id)) };
    };
    const armOf = (id: string, value: number, stamina: number, pitchTypes: number): Arm => ({ id, value, qualified: stamina >= opts.minStarterStamina && pitchTypes >= opts.minPitchTypes });
    const curStaff = r.pitchers.map((id) => { const c = pById.get(id)!; return armOf(id, blendPitch(c.valueVR, c.valueVL, c.throws, rotIds.has(id) ? "sp" : "rp", opts.pitchSplit, wVR, wVL), c.stamina, c.pitchTypes); });
    const baseVal = staff(curStaff).val;
    const spUp: PU[] = [], rpUp: PU[] = [];
    for (const e of entries) {
      if (rosteredDisp.has(e.dispId) || (ownedByDisp[e.dispId] ?? 0) > 0 || e.pitchTypes === 0) continue;
      const X = armOf(e.dispId, e.pitOVR, e.stamina, e.pitchTypes);
      // Best BUDGET-FEASIBLE swap: drop one current pitcher (cap/slots-feasible), add X, re-sort.
      // In non-cap every swap is feasible, so the max naturally drops the worst arm.
      let best = -Infinity, landRot = false, landBull = false;
      for (const d of curStaff) {
        if (!feasibleSwap(pCost(d.id), e.cost)) continue;
        const sv = staff([...curStaff.filter((a) => a.id !== d.id), X]);
        if (sv.rot.size < minSP) continue; // swap can't field a full rotation
        if (sv.val > best) { best = sv.val; landRot = sv.rot.has(X.id); landBull = sv.bull.has(X.id); }
      }
      const total = best - baseVal;
      if (best === -Infinity || total <= EPS) continue;
      const mk = (): PU => ({ id: strip(e.dispId), title: e.title, last: lastByDisp[e.dispId] ?? "", throws: THROWS[e.throws] ?? "", stamina: e.stamina, pitchTypes: e.pitchTypes, cost: e.cost, total: round(total), twoWay: false });
      if (landRot) spUp.push(mk());        // lands in the rotation → SP
      else if (landBull) rpUp.push(mk());  // lands in the bullpen → RP
    }
    // Two-way: a card in BOTH a hitter and a pitcher list → keep it in the higher-marginal
    // bucket, tag it, drop it from the other (mark the loser's total for removal).
    const pitById = new Map<string, PU>([...spUp, ...rpUp].map((p): [string, PU] => [p.id, p]));
    for (const h of hitUp) {
      const p = pitById.get(h.id);
      if (!p) continue;
      if (h.total >= p.total) { h.twoWay = true; p.total = -Infinity; } else { p.twoWay = true; h.total = -Infinity; }
    }
    const top = <T extends { total: number }>(xs: T[], n: number) => xs.filter((x) => x.total > -Infinity).sort((a, b) => b.total - a.total).slice(0, n);
    // Return a BUFFER (more than displayed) so the client can dismiss a card and promote the
    // next-best instantly, only refilling from /api/upgrades when the buffer runs low.
    biggestUpgrades = { hitters: top(hitUp, 15), sp: top(spUp, 8), rp: top(rpUp, 8) };
  }

  // Slot-tier usage (slots mode): per cumulative tier, how many DISTINCT rostered cards
  // are at/above the threshold vs the limit — drives the right-rail budget readout.
  const memberCost = new Map<string, number>();
  for (const id of r.hitters) memberCost.set(strip(id), hById.get(id)?.cost ?? 0);
  for (const id of r.pitchers) if (!memberCost.has(strip(id))) memberCost.set(strip(id), pById.get(id)?.cost ?? 0);
  const rosterCosts = [...memberCost.values()];
  const slotUsage = opts.mode === "slots"
    ? cumulativeSlotLimits(t.slot_counts ?? {}, opts.rosterSize ?? (t.hitters + t.pitchers))
        .map((l) => ({ threshold: l.threshold, limit: l.limit, used: rosterCosts.filter((c) => c >= l.threshold).length }))
    : null;

  return {
    roles, rosterHitters, rosterPitchers, ownedOnly, metric, twoWayIds: [...twoWaySet], nextBest, biggestUpgrades,
    cardValueMin: t.card_value_min ?? 40, cardValueMax: t.card_value_max ?? null,
    nHitters: t.hitters, nPitchers: t.pitchers,
    minStarterStamina: t.min_starter_stamina, minPitchTypes: t.min_pitch_types,
    status: r.status, mode: opts.mode, cap: opts.totalCap ?? null, cost: r.cost ?? null, slotUsage,
    objective: r.objective, balance: r.balance ?? null,
    poolHitters: hitters.length, poolPitchers: pitchers.length,
    rosterSize: new Set([...r.hitters, ...r.pitchers].map(strip)).size,
    lineupVR: r.lineupVR.map((x) => ({ ...x, cost: hById.get(x.id)?.cost ?? 0 })),
    lineupVL: r.lineupVL.map((x) => ({ ...x, cost: hById.get(x.id)?.cost ?? 0 })),
    rotation: r.rotation.map((x) => ({ ...x, ...pCard(x.id) })),
    bullpen: r.bullpen.map(pCard),
    bench,
    memberIds: [...new Set([...r.hitters, ...r.pitchers].map((id) => id.replace(/#V$/, "")))],
  };
}

// ── Stage-2 exact upgrade refinement (hybrid; the ONE upgrade-value path) ────
// Stage 1 (the single-swap matching) is used only to pick WHICH cards to evaluate
// (a shortlist — we can't re-solve all ~1000s of unowned cards); its numbers are
// never shown. Every displayed number is stage-2 exact: lock the candidate onto the
// roster, re-solve the real MILP (which rebalances the whole roster under the budget),
// and measure the value gain against the baseline. No new scoring math — reuses
// generateFullRoster + the same pool/opts (one scoring core).
//
// The value is measured in interpretable wOBA-value units, all from the SAME re-solve
// so they cohere: hitters report per-side lineup gains (dVR full, dVL discounted by the
// tournament's relative LHP exposure) and total = dVR + dVL (a SUM that visibly adds up
// from the shown sides); pitchers report the weighted staff-value delta.
//
// Perf: the budgeted baseline pool is HARD_POOL_CAP (~1500) → a full re-solve is
// slow (~5s slots). But a locked-candidate re-solve only needs the baseline roster
// + the candidate + a rebalancing buffer, so we run each re-solve over a REDUCED
// pool: baseline roster ∪ candidate ∪ top-value ∪ cheapest (cheap cards preserve
// cap-reclaim headroom) — validated exact vs the full pool.
type RefineOne = { id: string; kind: "hitter" | "pitcher"; stage2: number; dVR?: number; dVL?: number; ms: number; status: string };

// Keep the forced set (roster + candidate), then top-value + cheapest of the rest.
function reduceCandPool<T extends { id: string; cost: number; valueVR: number; valueVL: number }>(
  pool: T[], keep: Set<string>, topByValue: number, cheapest: number,
): T[] {
  const forced = pool.filter((c) => keep.has(c.id));
  const rest = pool.filter((c) => !keep.has(c.id));
  const byVal = [...rest].sort((a, b) => Math.max(b.valueVR, b.valueVL) - Math.max(a.valueVR, a.valueVL)).slice(0, topByValue);
  const inByVal = new Set(byVal.map((c) => c.id));
  const byCheap = rest.filter((c) => !inByVal.has(c.id)).sort((a, b) => a.cost - b.cost).slice(0, cheapest);
  return [...forced, ...byVal, ...byCheap];
}

async function refineUpgrades(
  tid: string, aid: string | null, excluded: string[], roleOverrides: Record<string, RoleOverride>,
  metric: Metric, locked: string[], hitterIds: string[], pitcherIds: string[],
  poolTopValue: number, poolCheapest: number, onResult?: (r: RefineOne) => void | Promise<void>,
): Promise<{ mode: string; baselineObj: number; baselineMs: number; results: RefineOne[] }> {
  const t = tournamentById.get(tid) ?? tournamentById.get(DEFAULT_TOURNAMENT_ID)!;
  const opts0 = rosterOptions(t);
  const strip = (id: string) => id.replace(/#V$/, "");
  const allCand = new Set([...hitterIds, ...pitcherIds]);
  const forceInclude = new Set<string>([...allCand, ...locked]);
  // Force-included candidates default to the HITTER pool; pin each to its bucket so
  // pitcher candidates actually land in `pitchers` (else they'd be silently skipped).
  const roles: Record<string, RoleOverride> = { ...roleOverrides };
  for (const id of hitterIds) roles[id] = "hitter";
  for (const id of pitcherIds) roles[id] = "pitcher";
  const { hitters, pitchers, twoWayIds, ownedByDisp } = rosterCandidates(
    t, aid, true, new Set(excluded), roles, forceInclude, opts0.platoonVR, opts0.platoonVL, metric);
  const opts = { ...opts0, twoWayIds, lockedIds: locked };
  const isUnownedCand = (id: string) => allCand.has(strip(id)) && (ownedByDisp[id] ?? 0) <= 0;
  // Owned-only baseline pool: drop the force-included UNOWNED candidates so the
  // baseline is the best OWNED roster (the true reference the delta measures against).
  const ownedH = hitters.filter((h) => !isUnownedCand(h.id));
  const ownedP = pitchers.filter((p) => !isUnownedCand(p.id));

  // Reuse the baseline from generation when available (skips the ~5s budgeted solve);
  // else solve it here. The reduced re-solve pool always contains the baseline roster,
  // so its unlocked optimum equals the full-pool baseline objective — the delta is valid.
  const snap = baselineCache.get(baselineKey(tid, aid, metric, excluded, locked));
  let baselineObj: number, baselineMs = 0, rosterH: Set<string>, rosterP: Set<string>;
  let baseLineupVR: string[], baseLineupVL: string[], baseRotation: string[], baseBullpen: string[];
  if (snap) {
    baselineObj = snap.objective; rosterH = new Set(snap.hitterIds); rosterP = new Set(snap.pitcherIds);
    baseLineupVR = snap.lineupVR; baseLineupVL = snap.lineupVL; baseRotation = snap.rotation; baseBullpen = snap.bullpen;
  } else {
    const tB = performance.now();
    const base = await generateFullRoster(ownedH, ownedP, opts);
    baselineMs = performance.now() - tB;
    baselineObj = base.objective; rosterH = new Set(base.hitters); rosterP = new Set(base.pitchers);
    baseLineupVR = base.lineupVR.map((x) => x.id); baseLineupVL = base.lineupVL.map((x) => x.id);
    baseRotation = base.rotation.map((x) => x.id); baseBullpen = base.bullpen;
  }
  const hById = new Map(hitters.map((c) => [strip(c.id), c]));
  const pById = new Map(pitchers.map((c) => [strip(c.id), c]));
  const wVR = opts.platoonVR, wVL = opts.platoonVL;
  // Upgrade OVR discounts the vL gain by the tournament's LHP exposure RELATIVE to RHP
  // (vR counts full; you face LHP less often). Dynamic from the split — balanced 50/50
  // ⇒ ×1 (no discount), 58/42 ⇒ ×0.72. Not a locked constant.
  const vlMult = wVR > 0 ? wVL / wVR : 1;
  // Per-side lineup value (hitters) + weighted staff value (pitchers), in value units.
  const lineupVal = (ids: string[], side: "VR" | "VL") => ids.reduce((s, id) => s + (side === "VR" ? (hById.get(strip(id))?.valueVR ?? 0) : (hById.get(strip(id))?.valueVL ?? 0)), 0);
  const pVal = (id: string, role: PitchRole) => { const p = pById.get(strip(id)); return p ? blendPitch(p.valueVR, p.valueVL, p.throws, role, opts.pitchSplit, wVR, wVL) : 0; };
  // Rotation arms count full; bullpen arms at 0.25 (a reliever throws ~¼ a starter's
  // innings) — the same staff weighting the single-swap upgrade used.
  const ROT_W = 1, BULL_W = 0.25;
  const staffVal = (rot: string[], pen: string[]) => ROT_W * rot.reduce((s, id) => s + pVal(id, "sp"), 0) + BULL_W * pen.reduce((s, id) => s + pVal(id, "rp"), 0);
  const baseVR = lineupVal(baseLineupVR, "VR"), baseVL = lineupVal(baseLineupVL, "VL"), baseStaff = staffVal(baseRotation, baseBullpen);
  const redP0 = reduceCandPool(ownedP, rosterP, poolTopValue, poolCheapest); // pitcher side, fixed across hitter re-solves
  const redH0 = reduceCandPool(ownedH, rosterH, poolTopValue, poolCheapest); // hitter side, fixed across pitcher re-solves

  const results: RefineOne[] = [];
  const solveWith = async (hp: HitterCandidate[], pp: PitcherCandidate[], lockId: string) => {
    const t1 = performance.now();
    const r = await generateFullRoster(hp, pp, { ...opts, lockedIds: [...locked, lockId] });
    return { r, ms: performance.now() - t1 };
  };
  const emit = async (one: RefineOne) => { results.push(one); if (onResult) await onResult(one); };
  for (const cid of hitterIds) {
    const cand = hById.get(cid); if (!cand) continue;
    const hp = reduceCandPool([...ownedH, cand], new Set([...rosterH, cand.id]), poolTopValue, poolCheapest);
    const { r, ms } = await solveWith(hp, redP0, strip(cand.id));
    const ok = r.status === "Optimal";
    const dVR = ok ? lineupVal(r.lineupVR.map((x) => x.id), "VR") - baseVR : 0;
    const dVLw = (ok ? lineupVal(r.lineupVL.map((x) => x.id), "VL") - baseVL : 0) * vlMult;
    // OVR is a SUM of the two per-side lineup gains (NOT a platoon-weighted average):
    // vR counts full, vL is discounted by relative LHP exposure, and they add — so a
    // vR-only +13 is worth +13 and a both-sides card adds the (discounted) vL on top.
    // Round each side to display precision first so vR + vL == OVR exactly on screen.
    // (This display metric only — every other use, incl. the optimizer objective, still
    // platoon-weights via valueFor/blendPitch.)
    const vrI = Math.round(dVR * 1000), vlI = Math.round(dVLw * 1000);
    await emit({ id: cid, kind: "hitter", dVR: vrI / 1000, dVL: vlI / 1000, stage2: (vrI + vlI) / 1000, ms: Math.round(ms), status: r.status });
  }
  for (const cid of pitcherIds) {
    const cand = pById.get(cid); if (!cand) continue;
    const pp = reduceCandPool([...ownedP, cand], new Set([...rosterP, cand.id]), poolTopValue, poolCheapest);
    const { r, ms } = await solveWith(redH0, pp, strip(cand.id));
    const ok = r.status === "Optimal";
    const dStaff = ok ? staffVal(r.rotation.map((x) => x.id), r.bullpen) - baseStaff : 0;
    await emit({ id: cid, kind: "pitcher", stage2: round(dStaff), ms: Math.round(ms), status: r.status });
  }
  return { mode: opts.mode, baselineObj: round(baselineObj), baselineMs: Math.round(baselineMs), results };
}

// ── Training data (M6 / SP-9) ──────────────────────────────────────────────────
// Lazy-loaded + cached: the real per-(league, side, year) outcome CSVs grouped
// into observations. Ingestion only — no model is trained here yet.
let trainingCache: LoadedTraining | null = null;
let trainingErr: string | null = null;
const windowCache = new Map<string, LoadedTraining>(); // loaded training per year-window
function clearTrainingCaches() { trainingCache = null; trainingErr = null; windowCache.clear(); fitCache = {}; sbCache = new Map(); residCache.clear(); }
function getTraining(reload = false): LoadedTraining | null {
  if (reload) clearTrainingCaches();
  if (trainingCache) return trainingCache;
  try {
    if (!existsSync(TRAINING_DIR)) { trainingErr = `training dir not found: ${TRAINING_DIR}`; return null; }
    trainingCache = loadTrainingDir(TRAINING_DIR);
    trainingErr = null;
  } catch (e) { trainingErr = String(e); trainingCache = null; }
  return trainingCache;
}
function trainingYears(): number[] { try { return existsSync(TRAINING_DIR) ? availableYears(TRAINING_DIR) : []; } catch { return []; } }
// Parse a ?years=2038,2039 list to a valid window; empty/invalid ⇒ default recent 2yr.
function parseYears(param: string | null): number[] {
  const avail = trainingYears();
  const want = (param ?? "").split(",").map((s) => Number(s.trim())).filter((y) => avail.includes(y));
  return want.length ? [...new Set(want)].sort((a, b) => a - b) : defaultWindow(avail);
}
function windowLoaded(years: number[]): LoadedTraining {
  const key = years.join(",");
  let o = windowCache.get(key);
  if (!o) { o = loadWindow(TRAINING_DIR, years); windowCache.set(key, o); }
  return o;
}
function windowObs(years: number[]): TrainObs[] { return windowLoaded(years).observations; }

interface FitBag {
  key?: string; window?: number[];
  woba_hitting?: WobaHittingFit; woba_pitching?: WobaPitchingFit;
  basic_hitting?: BasicFit<BasicHittingCoeffs>; basic_pitching?: BasicFit<BasicPitchingCoeffs>;
  wobaDiagHit?: EvalMetrics; wobaDiagPit?: EvalMetrics; // assembled-wOBA fidelity (in-sample)
}
let fitCache: FitBag = {};
let sbCache = new Map<string, Scoreboard>(); // bake-off scoreboards, keyed by (window,minN,k)
// Fit all four models over the SELECTED YEAR WINDOW (default: recent 2yr, limiting
// cross-year drift) at the given PA/BF threshold. Also computes each wOBA model's
// assembled-wOBA fidelity (events → wOBA → vs actual), since wOBA is the bottom line.
function getFit(window: number[], threshold: number, includeVariants: boolean, reload = false): { available: boolean; error?: string } & FitBag {
  if (reload) clearTrainingCaches();
  if (!existsSync(TRAINING_DIR)) return { available: false, error: `training dir not found: ${TRAINING_DIR}` };
  const key = `${window.join(",")}|${threshold}|${includeVariants}`;
  if (fitCache.key !== key) {
    try {
      const obs = windowObs(window).filter((o) => includeVariants || !o.variant);
      const wh = trainWobaHitting(obs, threshold), wp = trainWobaPitching(obs, threshold);
      const hq = obs.filter((o) => HITTER.qualifies(o, threshold)), pq = obs.filter((o) => PITCHER.qualifies(o, threshold));
      fitCache = {
        key, window,
        woba_hitting: wh, woba_pitching: wp,
        basic_hitting: trainBasicHitting(obs, threshold), basic_pitching: trainBasicPitching(obs, threshold),
        wobaDiagHit: evalMetrics(hq.map((o) => predictHitWoba(wh.coefficients, o)), hq.map(actualHitWoba), hq.map(HITTER.weight), true),
        wobaDiagPit: evalMetrics(pq.map((o) => predictPitWoba(wp.coefficients, o)), pq.map(actualPitWoba), pq.map(PITCHER.weight), false),
      };
    } catch (e) { return { available: false, error: String(e) }; }
  }
  return { available: true, ...fitCache };
}
// Bake-off scoreboard (in-sample + 5-fold CV + forward/backward OOT), cached by (window,minN,k).
function getScoreboard(window: number[], minN: number, k: number, includeVariants: boolean, reload = false): { available: boolean; error?: string; scoreboard?: Scoreboard } {
  if (reload) sbCache = new Map();
  if (!existsSync(TRAINING_DIR)) return { available: false, error: `training dir not found: ${TRAINING_DIR}` };
  const key = `${window.join(",")}|${minN}|${k}|${includeVariants}`;
  let sb = sbCache.get(key);
  if (!sb) { try { sb = buildScoreboard(TRAINING_DIR, { window, minN, k, includeVariants }); sbCache.set(key, sb); } catch (e) { return { available: false, error: String(e) }; } }
  return { available: true, scoreboard: sb };
}
// Per-card residual analysis (over/under leaderboards + archetypes + grid) for the
// wOBA model of a role, on a window. Cached by (role,window,minN).
const residCache = new Map<string, ResidualAnalysis>();
function getResiduals(role: "hitter" | "pitcher", window: number[], minN: number, includeVariants: boolean, weighted: boolean, reload = false): { available: boolean; error?: string; residuals?: ResidualAnalysis } {
  if (reload) residCache.clear();
  if (!existsSync(TRAINING_DIR)) return { available: false, error: `training dir not found: ${TRAINING_DIR}` };
  const key = `${role}|${window.join(",")}|${minN}|${includeVariants}|${weighted}`;
  let r = residCache.get(key);
  if (!r) { try { r = { ...analyzeResiduals(windowObs(window), role, minN, { includeVariants, weighted }), window }; residCache.set(key, r); } catch (e) { return { available: false, error: String(e) }; } }
  return { available: true, residuals: r };
}

// ── Saved trained models (M6 / S6.5) ──────────────────────────────────────────
// A named, persisted snapshot of the four fitted coefficient sets + the config they
// were trained on (dataset + window + min + variants). Lets us keep MULTIPLE
// parallel models (e.g. a league model and, later, a tournament model). Scoring-core
// integration (a model becoming the active scoring model) is a separate later step.
interface TrainedModel {
  id: string; name: string; datasetRoot: string; window: number[]; minPA: number; includeVariants: boolean;
  coefficients: { woba_hitting: WobaHittingCoeffs; woba_pitching: WobaPitchingCoeffs; basic_hitting: BasicHittingCoeffs; basic_pitching: BasicPitchingCoeffs };
  // D3 #2 (raw-poly) fitted form — the DEPLOYED event math, frozen here so scoring is
  // reproducible even as the (gitignored, weekly-changing) training data moves. Optional
  // for backward compat with pre-#2 artifacts (those can't be activated for scoring).
  eventForm?: EventForm;
  platoon?: PlatoonExposure; // measured platoon exposure (OVR splits + team VR/VL) — seeds new-tournament defaults
  wobaWeights?: WobaWeights; // wRAA-derived wOBA event weights for this model's leagues (optional; absent ⇒ defaults)
  ratingEnvelope?: RatingEnvelope; // per-rating training maxima → pool-transform saturation ceilings (optional)
  diag: { hitPearson: number | null; pitPearson: number | null; rowsHit: number; rowsPit: number };
  trainedAt: string; notes?: string;
}
// Summary drops the heavy payloads (coefficients + the raw eventForm betas); `hasEventForm`
// tells the UI whether the model is #2-capable (activatable for scoring).
type TrainedModelSummary = Omit<TrainedModel, "coefficients" | "eventForm"> & { hasEventForm: boolean };
const modelSummary = (m: TrainedModel): TrainedModelSummary => { const { coefficients, eventForm, ...rest } = m; return { ...rest, hasEventForm: !!eventForm }; };
const listModels = async (): Promise<TrainedModelSummary[]> =>
  (await repo.loadAll<TrainedModel>("trained-models")).sort((a, b) => b.trainedAt.localeCompare(a.trainedAt)).map(modelSummary);

async function saveTrainedModel(body: { name?: string; window?: number[]; minPA?: number; includeVariants?: boolean; notes?: string }): Promise<TrainedModelSummary> {
  const name = String(body.name ?? "").trim();
  if (!name) throw new Error("name required");
  const window = Array.isArray(body.window) && body.window.length ? body.window.map(Number) : defaultWindow(trainingYears());
  const minPA = Math.max(0, Number(body.minPA ?? 1000) || 1000);
  const includeVariants = body.includeVariants !== false;
  const f = getFit(window, minPA, includeVariants);
  if (!f.available || !f.woba_hitting || !f.woba_pitching || !f.basic_hitting || !f.basic_pitching) throw new Error(f.error ?? "fit unavailable");
  // Freeze the deployed D3 #2 form, fit on the SAME qualifying obs as the log-linear fit
  // (one fit path — reuse the bake-off's fitHitForm/fitPitForm). DEPLOYED FORMS (bake-off,
  // CV/OOT-validated): HITTING = raw-poly (quadratic POW/GAP captures real accelerating
  // power structure); PITCHING = LOG curve + a linear Stuff term on BB & HR (STUFFAUG_PIT)
  // — high Stuff suppresses walks/homers beyond Control/HRR, an outcome-measured channel the
  // K route alone misses; it fixes the low-Stuff over-rating and beats plain LOG forward &
  // backward OOT. (The raw-poly HR curve earned nothing OOS, so pitching stays log-curve.)
  const obs = windowObs(window).filter((o) => includeVariants || !o.variant);
  const hitQual = obs.filter((o) => HITTER.qualifies(o, minPA)), pitQual = obs.filter((o) => PITCHER.qualifies(o, minPA));
  const eventForm: EventForm = { hit: fitHitForm(RAWPOLY_HIT, hitQual), pit: fitPitForm(STUFFAUG_PIT, pitQual) };
  // Per-rating training MAX over the fitting obs (pooled across sides) — the saturation
  // ceilings the pool transform won't lift past. Recomputed per model, so it tracks retrains.
  const maxOf = (rows: TrainObs[], get: (o: TrainObs) => number) => rows.reduce((m, o) => Math.max(m, get(o)), 0);
  const ratingEnvelope: RatingEnvelope = {
    hit: { eye: maxOf(hitQual, (o) => o.ratings.hit.eye), pow: maxOf(hitQual, (o) => o.ratings.hit.pow), kRat: maxOf(hitQual, (o) => o.ratings.hit.kRat), babip: maxOf(hitQual, (o) => o.ratings.hit.babip), gap: maxOf(hitQual, (o) => o.ratings.hit.gap) },
    pit: { con: maxOf(pitQual, (o) => o.ratings.pitch.con), stu: maxOf(pitQual, (o) => o.ratings.pitch.stu), pbabip: maxOf(pitQual, (o) => o.ratings.pitch.pbabip), hrr: maxOf(pitQual, (o) => o.ratings.pitch.hrr) },
  };
  // Realized RHP/LHP exposure over ALL window obs (OVR/team splits from aggregated
  // obs) + role-conditional pitch splits (row grain, from the loader before CID
  // aggregation — computePlatoon can't see role from the aggregated obs).
  const loaded = windowLoaded(window);
  const platoon = { ...computePlatoon(obs), pitchRoleSplits: loaded.pitchRoleSplits };
  const wobaWeights = loaded.wobaWeights; // wRAA-derived weights for the model's leagues
  const existing = await repo.loadAll<TrainedModel>("trained-models");
  let id = slug(name) || "model"; while (existing.some((m) => m.id === id)) id += "-2";
  const model: TrainedModel = {
    id, name, datasetRoot: TRAINING_DIR, window, minPA, includeVariants,
    coefficients: { woba_hitting: f.woba_hitting.coefficients, woba_pitching: f.woba_pitching.coefficients, basic_hitting: f.basic_hitting.coefficients, basic_pitching: f.basic_pitching.coefficients },
    eventForm,
    platoon,
    wobaWeights,
    ratingEnvelope,
    diag: { hitPearson: f.wobaDiagHit?.pearson ?? null, pitPearson: f.wobaDiagPit?.pearson ?? null, rowsHit: f.woba_hitting.rowCount, rowsPit: f.woba_pitching.rowCount },
    trainedAt: new Date().toISOString(), notes: body.notes ? String(body.notes) : undefined,
  };
  await repo.save("trained-models", id, model);
  return modelSummary(model);
}

// Load the active trained model's frozen #2 form into memory (or null for the
// log-linear fallback). Clears the scoring cache so the next request re-scores.
// A stale/incompatible pointer (deleted model, or a pre-#2 artifact) self-heals to null.
async function refreshActiveModel(): Promise<void> {
  const id = state.activeModelId ?? null;
  const m = id ? (await repo.loadAll<TrainedModel>("trained-models")).find((x) => x.id === id) : undefined;
  activeEventForm = m?.eventForm ?? null;
  activePlatoon = m?.platoon ?? null;
  activeWobaWeights = m?.wobaWeights ?? null;
  activeEnvelope = m?.ratingEnvelope ?? null;
  if (id && !m?.eventForm) { state.activeModelId = null; await saveState(); }
  cache = new Map();
}
await refreshActiveModel();

// Precompute the default tournament so first paint is instant.
scoredFor(DEFAULT_TOURNAMENT_ID);

// ── HTTP ──────────────────────────────────────────────────────────────────────
const MIME: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".ico": "image/x-icon",
};
// Dynamic so create/edit/delete are reflected without a restart.
const tournamentListNow = () => [...tournamentById.values()].map((t) => ({ id: t.id, name: t.name }));
const eraList = () => [...eras.values()].map((e) => ({ id: e.id, name: e.name }));
const parkList = () => [...parks.values()].map((p) => ({ id: p.id, name: p.name })).sort((a, b) => a.name.localeCompare(b.name));

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => resolve(d)); });

function json(res: ServerResponse, data: unknown, code = 200) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}

const server = createServer(async (req, res) => {
  const u = new URL(req.url ?? "/", "http://localhost");
  const url = u.pathname;
  const method = req.method ?? "GET";
  const tid = u.searchParams.get("tournament") || state.activeTournamentId || DEFAULT_TOURNAMENT_ID;
  const aid = u.searchParams.get("account") || state.activeAccountId;

  // ── GET API ──
  if (method === "GET" && url === "/api/tournaments")
    return json(res, { tournaments: tournamentListNow(), defaultId: state.activeTournamentId || DEFAULT_TOURNAMENT_ID });
  if (method === "GET" && url === "/api/tournament") { // full object for the editor
    const t = tournamentById.get(u.searchParams.get("id") || "");
    return t ? json(res, t) : json(res, { error: "unknown tournament" }, 404);
  }
  if (method === "GET" && url === "/api/libraries") return json(res, { eras: eraList(), parks: parkList(), columns: [...catalog.columns].sort((a, b) => a.localeCompare(b)), platoonDefaults: activePlatoon });
  if (method === "GET" && url === "/api/parks") return json(res, { parks: [...parks.values()] });
  if (method === "GET" && url === "/api/eras") return json(res, { eras: [...eras.values()] });
  if (method === "GET" && url === "/api/accounts") return json(res, accountSummary());
  if (method === "GET" && url === "/api/training/summary") {
    const t = getTraining(u.searchParams.get("reload") === "true");
    if (!t) return json(res, { available: false, dir: TRAINING_DIR, error: trainingErr }, 200);
    return json(res, { available: true, ...t.summary });
  }
  // Diagnostic: how the pool-strength transform (rating re-basing) moves a tournament's
  // ratings. Returns the per-rating affines (effective = a + b·raw, clamped ≥0) and the
  // cards whose ratings move most (radical-rating cards distort hardest). `q` filters by title.
  if (method === "GET" && url === "/api/debug/scaling") {
    const tid = u.searchParams.get("t") || DEFAULT_TOURNAMENT_ID;
    const q = (u.searchParams.get("q") || "").toLowerCase();
    const { t, s } = scoredFor(tid);
    const pt = s.ctx.config.poolTransform;
    if (!pt) return json(res, { tournament: t.name, active: false, note: "pool transform inactive (no #2 model active, or eligible pool ≈ full catalog → identity)" });
    const summarize = (blk: Record<string, Record<string, { k: number; c: number; tau: number }>>) =>
      Object.fromEntries(Object.entries(blk).map(([side, m]) => [side, Object.fromEntries(Object.entries(m).map(([key, v]) => [key, { k: +v.k.toFixed(3), c: +v.c.toFixed(1) }]))]));
    const eff = applyAffine; // raw → effective via the real transform (no duplicated math)
    const PMAP: [string, string][] = [["con", "Control"], ["stu", "Stuff"], ["pbabip", "pBABIP"], ["hrr", "pHR"]];
    const rows: { title: string; vR: Record<string, string>; vL: Record<string, string>; maxDelta: number }[] = [];
    for (const c of catalog.cards) {
      const title = String(c["//Card Title"] ?? "");
      if (q && !title.toLowerCase().includes(q)) continue;
      if (n(c["Stamina"]) < 20) continue; // real pitchers only (position players have stamina ~1)
      const out = { title, vR: {} as Record<string, string>, vL: {} as Record<string, string>, maxDelta: 0 };
      for (const side of ["vR", "vL"] as const) for (const [r, col] of PMAP) {
        const raw = n(c[`${col} ${side}`]); const e = eff(raw, (pt.pit as any)[side]?.[r]);
        out[side][r] = `${raw}→${Math.round(e)}`; out.maxDelta = Math.max(out.maxDelta, Math.abs(e - raw));
      }
      out.maxDelta = +out.maxDelta.toFixed(1);
      rows.push(out);
    }
    rows.sort((a, b) => b.maxDelta - a.maxDelta);
    return json(res, { tournament: t.name, active: true, pit: summarize(pt.pit as any), hit: summarize(pt.hit as any), cards: q ? rows : rows.slice(0, 15) });
  }
  // SP-OVR rank: among QUALIFIED starters (stamina ≥ minStam, ≥ minPitch pitch types),
  // rank cards matching `q` by pitcher OVR (woba_ovr, lower allowed = better), pre vs post
  // transform. This is the field that actually competes for rotation slots.
  if (method === "GET" && url === "/api/debug/sprank") {
    const tid = u.searchParams.get("t") || DEFAULT_TOURNAMENT_ID;
    const q = (u.searchParams.get("q") || "").toLowerCase();
    const minStam = Number(u.searchParams.get("stam") ?? 55) || 55;
    const minPitch = Number(u.searchParams.get("pitch") ?? 3) || 3;
    const { t, s } = scoredFor(tid);
    const preCfg = { ...s.ctx.config, poolTransform: undefined };
    const sps = catalog.cards.filter((c) => isBaseCard(c) && s.ctx.isEligible(c) && n(c["Stamina"]) >= minStam && pitchCount(c) >= minPitch);
    const recs = sps.map((c) => ({ title: String(c["//Card Title"] ?? ""), val: n(c["Card Value"]),
      pre: scoreCard(c, preCfg).pitch.woba_ovr, post: scoreCard(c, s.ctx.config).pitch.woba_ovr }));
    const rank = (phase: "pre" | "post") => { const o = [...recs].sort((a, b) => a[phase] - b[phase]); const m = new Map<typeof recs[0], number>(); o.forEach((r, k) => m.set(r, k + 1)); return m; };
    const rp = rank("pre"), ro = rank("post");
    const out = recs.filter((r) => !q || r.title.toLowerCase().includes(q))
      .map((r) => ({ title: r.title, value: r.val, ovrPre: +r.pre.toFixed(4), ovrPost: +r.post.toFixed(4), rank: `${rp.get(r)}→${ro.get(r)}` }));
    return json(res, { tournament: t.name, qualifiedSPs: recs.length, minStam, minPitch, cards: out });
  }
  // RANK change from the transform: for cards matching `q`, their pre- vs post-transform
  // rank within the eligible field (pitchers ranked among pitchers, hitters among hitters).
  // Isolates the RELATIVE effect of scaling (everyone scales; this shows who moves).
  if (method === "GET" && url === "/api/debug/rank") {
    const tid = u.searchParams.get("t") || DEFAULT_TOURNAMENT_ID;
    const q = (u.searchParams.get("q") || "").toLowerCase();
    const { t, s } = scoredFor(tid);
    const preCfg = { ...s.ctx.config, poolTransform: undefined };
    const elig = catalog.cards.filter((c) => s.ctx.isEligible(c));
    const recs = elig.map((c) => {
      const pre = scoreCard(c, preCfg), post = scoreCard(c, s.ctx.config);
      return { title: String(c["//Card Title"] ?? ""), stam: n(c["Stamina"]),
        pre: { pVR: pre.pitch.woba_vR, pVL: pre.pitch.woba_vL, hVR: pre.hit.woba_vR, hVL: pre.hit.woba_vL },
        post: { pVR: post.pitch.woba_vR, pVL: post.pitch.woba_vL, hVR: post.hit.woba_vR, hVL: post.hit.woba_vL } };
    });
    const pit = recs.filter((r) => r.stam >= 20), hit = recs.filter((r) => r.stam < 20);
    // rank map within a pool: title → rank (1 = best); pitchers asc (low allowed), hitters desc
    const rankMap = (pool: typeof recs, phase: "pre" | "post", m: string, asc: boolean) => {
      const o = pool.map((r) => r).sort((a, b) => asc ? (a as any)[phase][m] - (b as any)[phase][m] : (b as any)[phase][m] - (a as any)[phase][m]);
      const map = new Map<typeof recs[0], number>(); o.forEach((r, k) => map.set(r, k + 1)); return map;
    };
    const R = {
      pVR: { pre: rankMap(pit, "pre", "pVR", true), post: rankMap(pit, "post", "pVR", true) },
      pVL: { pre: rankMap(pit, "pre", "pVL", true), post: rankMap(pit, "post", "pVL", true) },
      hVR: { pre: rankMap(hit, "pre", "hVR", false), post: rankMap(hit, "post", "hVR", false) },
      hVL: { pre: rankMap(hit, "pre", "hVL", false), post: rankMap(hit, "post", "hVL", false) },
    };
    const out: any[] = [];
    for (const r of recs) {
      if (!q || !r.title.toLowerCase().includes(q)) continue;
      const isPit = r.stam >= 20;
      const mk = (k: "pVR" | "pVL" | "hVR" | "hVL") => `${R[k].pre.get(r)}→${R[k].post.get(r)}`;
      out.push({ title: r.title, role: isPit ? "pitcher" : "hitter", poolSize: isPit ? pit.length : hit.length,
        ranks: isPit ? { vR: mk("pVR"), vL: mk("pVL") } : { vR: mk("hVR"), vL: mk("hVL") } });
    }
    return json(res, { tournament: t.name, pitchers: pit.length, hitters: hit.length, cards: out });
  }
  // Focused per-card view: for cards matching `q`, show vR+vL raw ratings → pool-transformed
  // (effective) ratings, plus the per-side score with and without the transform. Both roles.
  if (method === "GET" && url === "/api/debug/card") {
    const tid = u.searchParams.get("t") || DEFAULT_TOURNAMENT_ID;
    const q = (u.searchParams.get("q") || "").toLowerCase();
    const { t, s } = scoredFor(tid);
    const pt = s.ctx.config.poolTransform;
    const preCfg = { ...s.ctx.config, poolTransform: undefined };
    const eff = applyAffine; // raw → effective via the real transform (no duplicated math)
    const PIT: [string, string][] = [["con", "Control"], ["stu", "Stuff"], ["pbabip", "pBABIP"], ["hrr", "pHR"]];
    const HIT: [string, string][] = [["babip", "BABIP"], ["pow", "Power"], ["eye", "Eye"], ["kRat", "Avoid K"], ["gap", "Gap"]];
    const cfg = s.ctx.config; const co = cfg.coeffs, dv = cfg.derived, cs = cfg.calScales, ef = cfg.eventForm;
    const evModel = ef ? makeRawPolyModel(ef) : null;
    const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
    // Full pitcher event trace (per side): effective ratings → base events (model) →
    // era/park-adjusted final events → wOBA. Reuses the real predictPitching +
    // pitchingComponents (one core), so it matches wobaPost exactly.
    const pitTrace = (c: Record<string, unknown>, side: "vR" | "vL") => {
      if (!evModel) return "(no event model)";
      const tp = pt?.pit[side];
      const eR = { con: eff(n(c[`Control ${side}`]), tp?.con), stu: eff(n(c[`Stuff ${side}`]), tp?.stu), pbabip: eff(n(c[`pBABIP ${side}`]), tp?.pbabip), hrr: eff(n(c[`pHR ${side}`]), tp?.hrr) };
      const e = evModel.predictPitching(eR, co) as any;
      const vR = side === "vR";
      const sBB = vR ? (cs?.pBBScaleVR ?? 1) : (cs?.pBBScaleVL ?? 1);
      const sHR = vR ? (cs?.pHRScaleVR ?? 1) : (cs?.pHRScaleVL ?? 1);
      const sFinal = vR ? (cs?.pitchScaleVR ?? 1) : (cs?.pitchScaleVL ?? 1);
      const k = pitchingComponents(e, sBB, sHR, side, co, dv, ef);
      const K_fin = e.K * co.era_k;
      const BIP_fin = Math.max(600 - k.BB_fin - (co.adv_hbp ?? 6) - K_fin - k.HR_fin, 1);
      return {
        effRatings: { con: r4(eR.con), stu: r4(eR.stu), pbabip: r4(eR.pbabip), hrr: r4(eR.hrr) },
        baseEvents_per600: { BB: r4(e.BB), K: r4(e.K), HR: r4(e.HR) },
        envFactors: { era_bb: co.era_bb, era_k: co.era_k, era_h: r4(dv.era_h), era_effective_hr: r4(dv.era_effective_hr), era_gap: co.era_gap, park_hr: r4(cp(vR ? co.park_hr_r : co.park_hr_l)), park_avg: r4(cp(vR ? co.park_avg_r : co.park_avg_l)), park_gap: r4(cp(co.park_gap)) },
        calScales: { pBBScale: r4(sBB), pHRScale: r4(sHR), pitchScale: r4(sFinal) },
        finalEvents_per600: { BB: r4(k.BB_fin), K: r4(K_fin), HR: r4(k.HR_fin), single: r4(k.oneB_fin), XBH: r4(k.XBH_fin), BIP: r4(BIP_fin) },
      };
    };
    // Hitter event trace (per side), mirroring the pitcher one: effective ratings →
    // base events (predictHitting) → era/park-adjusted finals (hittingComponents).
    const hitTrace = (c: Record<string, unknown>, side: "vR" | "vL") => {
      if (!evModel) return "(no event model)";
      const bats = n(c["Bats"]); const th = pt?.hit[side];
      const eR = { eye: eff(n(c[`Eye ${side}`]), th?.eye), pow: eff(n(c[`Power ${side}`]), th?.pow), kRat: eff(n(c[`Avoid K ${side}`]), th?.kRat), babip: eff(n(c[`BABIP ${side}`]), th?.babip), gap: eff(n(c[`Gap ${side}`]), th?.gap), speed: 0, steal: 0, run: 0 };
      const e = evModel.predictHitting(eR, co) as any;
      const vR = side === "vR";
      const sBB = vR ? (cs?.hitBBScaleVR ?? 1) : (cs?.hitBBScaleVL ?? 1);
      const sHR = vR ? (cs?.hitHRScaleVR ?? 1) : (cs?.hitHRScaleVL ?? 1);
      const sFinal = vR ? (cs?.hitScaleVR ?? 1) : (cs?.hitScaleVL ?? 1);
      const k = hittingComponents(e, sBB, sHR, bats, side, co, dv, ef);
      const SO_fin = e.SO * co.era_k;
      const BIP_fin = Math.max(600 - k.BB_fin - (co.adv_hbp ?? 6) - (co.adv_sh ?? 0) - SO_fin - k.HR_fin, 1);
      return {
        effRatings: { eye: r4(eR.eye), pow: r4(eR.pow), kRat: r4(eR.kRat), babip: r4(eR.babip), gap: r4(eR.gap) },
        baseEvents_per600: { BB: r4(e.BB), SO: r4(e.SO), HR: r4(e.HR) },
        envFactors: { era_bb: co.era_bb, era_k: co.era_k, era_h: r4(dv.era_h), era_effective_hr: r4(dv.era_effective_hr), era_gap: co.era_gap, park_hr: r4(getParkFactor(bats, vR, co.park_hr_r, co.park_hr_l)), park_avg: r4(getParkFactor(bats, vR, co.park_avg_r, co.park_avg_l)), park_gap: r4(cp(co.park_gap)) },
        calScales: { hitBBScale: r4(sBB), hitHRScale: r4(sHR), hitScale: r4(sFinal) },
        finalEvents_per600: { BB: r4(k.BB_fin), SO: r4(SO_fin), HR: r4(k.HR_fin), single: r4(k.oneB_fin), XBH: r4(k.GAP_fin), BIP: r4(BIP_fin) },
      };
    };
    const out: any[] = [];
    for (const c of catalog.cards) {
      const title = String(c["//Card Title"] ?? "");
      if (!q || !title.toLowerCase().includes(q)) continue;
      const pre = scoreCard(c, preCfg), post = scoreCard(c, s.ctx.config);
      const ratesFor = (defs: [string, string][], block: any) => Object.fromEntries(["vR", "vL"].map((side) =>
        [side, Object.fromEntries(defs.map(([r, col]) => { const raw = n(c[`${col} ${side}`]); return [r, `${raw}→${Math.round(eff(raw, block?.[side]?.[r]))}`]; }))]));
      out.push({
        title, cardValue: n(c["Card Value"]), throws: n(c["Throws"]), eligible: s.ctx.isEligible(c),
        pit: { ratings: pt ? ratesFor(PIT, pt.pit) : "(no transform)", wobaPre: { vR: +pre.pitch.woba_vR.toFixed(4), vL: +pre.pitch.woba_vL.toFixed(4) }, wobaPost: { vR: +post.pitch.woba_vR.toFixed(4), vL: +post.pitch.woba_vL.toFixed(4) }, trace: { vR: pitTrace(c, "vR"), vL: pitTrace(c, "vL") } },
        hit: { ratings: pt ? ratesFor(HIT, pt.hit) : "(no transform)", wobaPre: { vR: +pre.hit.woba_vR.toFixed(4), vL: +pre.hit.woba_vL.toFixed(4) }, wobaPost: { vR: +post.hit.woba_vR.toFixed(4), vL: +post.hit.woba_vL.toFixed(4) }, trace: { vR: hitTrace(c, "vR"), vL: hitTrace(c, "vL") } },
      });
    }
    return json(res, { tournament: t.name, era: t.eraId, park: t.parkId, transformActive: !!pt, matches: out.length, cards: out });
  }
  // The realistic field, PRE-transform: rank the eligible pool by raw (untransformed)
  // per-side score and return the top-N for pit vR/vL + hit vR/vL. No role/stamina filter —
  // the ranking self-selects. This is the population the transform's field stats are built on.
  if (method === "GET" && url === "/api/debug/pool") {
    const tid = u.searchParams.get("t") || DEFAULT_TOURNAMENT_ID;
    const topN = Math.min(300, Math.max(10, Number(u.searchParams.get("n") ?? 100) || 100));
    const { t, s } = scoredFor(tid);
    const preCfg = { ...s.ctx.config, poolTransform: undefined }; // strip the rating transform
    const elig = catalog.cards.filter((c) => s.ctx.isEligible(c));
    const scored = elig.map((c) => {
      const sc = scoreCard(c, preCfg);
      const pr = (col: string, side: string) => n(c[`${col} ${side}`]);
      return {
        title: String(c["//Card Title"] ?? ""),
        pitVR: sc.pitch.woba_vR, pitVL: sc.pitch.woba_vL, hitVR: sc.hit.woba_vR, hitVL: sc.hit.woba_vL,
        pit: { vR: { con: pr("Control", "vR"), stu: pr("Stuff", "vR"), pbabip: pr("pBABIP", "vR"), hrr: pr("pHR", "vR") },
               vL: { con: pr("Control", "vL"), stu: pr("Stuff", "vL"), pbabip: pr("pBABIP", "vL"), hrr: pr("pHR", "vL") } },
        hit: { vR: { babip: pr("BABIP", "vR"), pow: pr("Power", "vR"), eye: pr("Eye", "vR"), k: pr("Avoid K", "vR"), gap: pr("Gap", "vR") },
               vL: { babip: pr("BABIP", "vL"), pow: pr("Power", "vL"), eye: pr("Eye", "vL"), k: pr("Avoid K", "vL"), gap: pr("Gap", "vL") } },
      };
    });
    const top = (key: "pitVR" | "pitVL" | "hitVR" | "hitVL", asc: boolean) =>
      [...scored].sort((a, b) => asc ? a[key] - b[key] : b[key] - a[key]).slice(0, topN);
    return json(res, {
      tournament: t.name, n: topN, eligible: elig.length,
      pitVR: top("pitVR", true), pitVL: top("pitVL", true), hitVR: top("hitVR", false), hitVL: top("hitVL", false),
    });
  }
  if (method === "GET" && url === "/api/training/fit") {
    const minPA = Math.max(0, Number(u.searchParams.get("minPA") ?? 1000) || 1000);
    const includeVariants = u.searchParams.get("variants") !== "base";
    return json(res, getFit(parseYears(u.searchParams.get("years")), minPA, includeVariants, u.searchParams.get("reload") === "true"));
  }
  if (method === "GET" && url === "/api/training/scoreboard") {
    const minN = Math.max(0, Number(u.searchParams.get("minN") ?? 1000) || 1000);
    const k = Math.min(20, Math.max(2, Number(u.searchParams.get("k") ?? 5) || 5));
    const includeVariants = u.searchParams.get("variants") !== "base";
    return json(res, getScoreboard(parseYears(u.searchParams.get("years")), minN, k, includeVariants, u.searchParams.get("reload") === "true"));
  }
  if (method === "GET" && url === "/api/training/residuals") {
    const role = u.searchParams.get("role") === "pitcher" ? "pitcher" : "hitter";
    const minN = Math.max(0, Number(u.searchParams.get("minN") ?? 1000) || 1000);
    const includeVariants = u.searchParams.get("variants") !== "base";
    const weighted = u.searchParams.get("weighted") !== "false";
    return json(res, getResiduals(role, parseYears(u.searchParams.get("years")), minN, includeVariants, weighted, u.searchParams.get("reload") === "true"));
  }
  if (method === "GET" && url === "/api/training/models") return json(res, { models: await listModels(), activeId: state.activeModelId ?? null });
  // The DEPLOYED #2 event model's fitted curves (for the Model-Training coefficient panel —
  // so it shows what actually scores, not the retired log-linear baseline). null ⇒ no model active.
  if (method === "GET" && url === "/api/training/active-eventform") return json(res, { eventForm: activeEventForm });
  if (method === "POST" && url === "/api/training/models/save") {
    const body = JSON.parse((await readBody(req)) || "{}");
    try { const model = await saveTrainedModel(body); return json(res, { ok: true, model, models: await listModels(), activeId: state.activeModelId ?? null }); }
    catch (e) { return json(res, { ok: false, error: String(e) }, 400); }
  }
  // Activate a saved #2 model for scoring (empty id ⇒ deactivate → log-linear fallback).
  if (method === "POST" && url === "/api/training/models/activate") {
    const id = u.searchParams.get("id") || "";
    if (id) {
      const m = (await repo.loadAll<TrainedModel>("trained-models")).find((x) => x.id === id);
      if (!m) return json(res, { ok: false, error: "unknown model" }, 404);
      if (!m.eventForm) return json(res, { ok: false, error: "model has no #2 form (retrain to activate)" }, 400);
    }
    state.activeModelId = id || null;
    await saveState();
    await refreshActiveModel(); // refresh in-memory form + clear the scoring cache
    return json(res, { ok: true, activeId: state.activeModelId ?? null, models: await listModels() });
  }
  if (method === "POST" && url === "/api/training/models/delete") {
    const id = u.searchParams.get("id") || "";
    if (!id) return json(res, { ok: false, error: "id required" }, 400);
    await repo.delete("trained-models", id);
    if (state.activeModelId === id) { state.activeModelId = null; await saveState(); await refreshActiveModel(); }
    return json(res, { ok: true, models: await listModels(), activeId: state.activeModelId ?? null });
  }
  if (method === "GET" && url === "/api/cards") return json(res, buildCards(tid, aid));
  if (method === "GET" && url === "/api/meta") return json(res, buildMeta(tid, aid));
  if (method === "GET" && (url === "/api/roster" || url === "/api/upgrades")) {
    const list = (k: string) => (u.searchParams.get(k) || "").split(",").filter(Boolean);
    // roles=ID:hitter,ID:pitcher,ID:twoway — per-card pool override (base Card ID).
    const roleOverrides: Record<string, RoleOverride> = {};
    for (const pair of list("roles")) {
      const [id, role] = pair.split(":");
      if (id && (role === "hitter" || role === "pitcher" || role === "twoway")) roleOverrides[id] = role;
    }
    const metric: Metric = u.searchParams.get("metric") === "basic" ? "basic" : "woba";
    // lineupLocks=ID:pos:side — pin a hitter to a position in one platoon (side L|R).
    const lineupLocks: LineupLock[] = [];
    for (const trip of list("lineupLocks")) {
      const [id, pos, side] = trip.split(":");
      if (id && pos && (side === "L" || side === "R")) lineupLocks.push({ id, pos, side });
    }
    const result = await generateRosterFor(tid, aid, u.searchParams.get("ownedOnly") !== "false", list("locked"), list("excluded"), roleOverrides, metric, lineupLocks);
    // /api/upgrades returns ONLY the Biggest Upgrades (small payload) — used to refill the
    // client's upgrade buffer after a dismiss without re-sending the full roster + Next Best.
    return json(res, url === "/api/upgrades" ? { biggestUpgrades: result.biggestUpgrades ?? null } : result);
  }

  // ── Stage-2 exact upgrade refinement (hybrid) — NDJSON stream ──
  // Re-ranks the Biggest Upgrades shortlist with EXACT whole-roster marginals (lock
  // each candidate, re-solve, diff objective vs the baseline). Streams one JSON line
  // per candidate as it completes so the client autoloads exact numbers in place.
  // Reuses the baseline cached by the preceding /api/roster call. Candidate ids come
  // from the client (h/sp/rp = the current shortlist); the client maps id→bucket.
  if (method === "GET" && url === "/api/upgrades/refine") {
    const list = (k: string) => (u.searchParams.get(k) || "").split(",").filter(Boolean);
    const metric: Metric = u.searchParams.get("metric") === "basic" ? "basic" : "woba";
    const hIds = list("h"), spIds = list("sp"), rpIds = list("rp");
    res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
    const write = (o: unknown) => res.write(JSON.stringify(o) + "\n");
    try {
      const ref = await refineUpgrades(
        tid, aid, list("excluded"), {}, metric, list("locked"),
        hIds, [...spIds, ...rpIds], REFINE_POOL_TOPVALUE, REFINE_POOL_CHEAPEST,
        (one) => { write({ type: "result", id: one.id, stage2: one.stage2, dVR: one.dVR, dVL: one.dVL, status: one.status }); },
      );
      write({ type: "done", mode: ref.mode, count: ref.results.length, baselineMs: ref.baselineMs });
    } catch (e) {
      write({ type: "error", error: String(e) });
    }
    res.end();
    return;
  }

  // ── Parks library import (raw pt_ballparks.txt) ──
  if (method === "POST" && url === "/api/parks/import") {
    const text = await readBody(req);
    if (!text.trim()) return json(res, { error: "empty file" }, 400);
    let parsed: Park[];
    try { parsed = parseBallparks(text); } catch (e) { return json(res, { error: `parse failed: ${e}` }, 400); }
    if (!parsed.length) return json(res, { error: "no parks parsed — is this a pt_ballparks.txt export?" }, 400);
    for (const p of parsed) { await repo.save("parks", p.id, p); parks.set(p.id, p); }
    cache.clear(); // park factors feed scoring → drop cached scores
    return json(res, { imported: parsed.length, parks: [...parks.values()] });
  }

  // ── Tournaments CRUD (D4 — the single config source is now editable) ──
  if (method === "POST" && url === "/api/tournaments/save") {
    // Body = a full Tournament. Create (new id from name) or update in place.
    const body = JSON.parse((await readBody(req)) || "{}") as Tournament;
    const name = String(body.name ?? "").trim();
    if (!name) return json(res, { error: "name required" }, 400);
    const existing = body.id ? tournamentById.get(body.id) : null;
    let id = body.id || slug(name);
    if (!existing) { while (tournamentById.has(id)) id += "-2"; } // avoid id collision on create
    // Preserve softcaps/eligibility from the existing record unless the body carries them
    // (the Phase-1 editor doesn't touch those, so don't let it blow them away).
    const base = existing ?? tournamentById.get(DEFAULT_TOURNAMENT_ID)!;
    const t: Tournament = {
      ...base, ...body, id, name,
      softcaps: body.softcaps ?? base.softcaps,
      eligibility: body.eligibility ?? base.eligibility,
    };
    // New tournaments inherit the ACTIVE model's measured platoon exposure as their default
    // (existing tournaments keep their stored values — seed only on create).
    if (!existing && activePlatoon) {
      if (body.platoon === undefined) {
        const rs = activePlatoon.pitchRoleSplits;
        t.platoon = {
          r_hit_split: activePlatoon.r_hit_split, l_hit_split: activePlatoon.l_hit_split, s_hit_split: activePlatoon.s_hit_split,
          r_pitch_split: activePlatoon.r_pitch_split, l_pitch_split: activePlatoon.l_pitch_split,
          ...(rs ? { r_pitch_split_sp: rs.sp.r, l_pitch_split_sp: rs.sp.l, r_pitch_split_rp: rs.rp.r, l_pitch_split_rp: rs.rp.l } : {}),
        };
      }
      if (body.platoonVR === undefined) t.platoonVR = activePlatoon.teamVR;
      if (body.platoonVL === undefined) t.platoonVL = activePlatoon.teamVL;
    }
    await repo.save("tournaments", id, t);
    tournamentById.set(id, t);
    cache.delete(id); // era/park/softcaps/value-range affect scoring → re-score on next read
    return json(res, { id, tournaments: tournamentListNow() });
  }
  if (method === "POST" && url === "/api/tournaments/duplicate") {
    const src = tournamentById.get(u.searchParams.get("id") || "");
    if (!src) return json(res, { error: "unknown tournament" }, 400);
    let id = slug(`${src.name} copy`); while (tournamentById.has(id)) id += "-2";
    const t: Tournament = { ...src, id, name: `${src.name} (copy)` };
    await repo.save("tournaments", id, t);
    tournamentById.set(id, t);
    return json(res, { id, tournaments: tournamentListNow() });
  }
  if (method === "POST" && url === "/api/tournaments/delete") {
    const id = u.searchParams.get("id") || "";
    if (!tournamentById.has(id)) return json(res, { error: "unknown tournament" }, 400);
    if (tournamentById.size <= 1) return json(res, { error: "can't delete the last tournament" }, 400);
    if (id === DEFAULT_TOURNAMENT_ID) return json(res, { error: "can't delete the built-in default tournament" }, 400);
    await repo.delete("tournaments", id);
    tournamentById.delete(id);
    cache.delete(id);
    if (state.activeTournamentId === id) { state.activeTournamentId = DEFAULT_TOURNAMENT_ID; await saveState(); }
    return json(res, { tournaments: tournamentListNow(), defaultId: state.activeTournamentId || DEFAULT_TOURNAMENT_ID });
  }
  // Position-constraint pool metrics for the editor. Body = a (possibly unsaved) draft,
  // merged over its stored record (or the default) so it scores before save. Returns the
  // per-position per-rating distribution over the eligible Top-X pool (sortedDesc stripped).
  if (method === "POST" && url === "/api/position-metrics") {
    const body = JSON.parse((await readBody(req)) || "{}") as Tournament;
    const base = (body.id ? tournamentById.get(body.id) : null) ?? tournamentById.get(DEFAULT_TOURNAMENT_ID)!;
    const t: Tournament = { ...base, ...body, softcaps: body.softcaps ?? base.softcaps, eligibility: body.eligibility ?? base.eligibility };
    const stats = positionPoolStats(t, scoreTournament(t));
    const metrics: Record<string, Record<string, { n: number; mean: number; max: number; p90: number; p95: number; top5: number; top10: number }>> = {};
    for (const [pos, perRating] of Object.entries(stats)) {
      metrics[pos] = {};
      for (const [key, d] of Object.entries(perRating)) metrics[pos][key] = { n: d.n, mean: d.mean, max: d.max, p90: d.p90, p95: d.p95, top5: d.top5, top10: d.top10 };
    }
    return json(res, { topX: t.topHitters && t.topHitters > 0 ? t.topHitters : 100, metrics });
  }

  // ── POST API ──
  if (method === "POST" && url === "/api/state") {
    const body = JSON.parse((await readBody(req)) || "{}");
    if ("activeAccountId" in body) state.activeAccountId = body.activeAccountId;
    if ("activeTournamentId" in body) state.activeTournamentId = body.activeTournamentId;
    if ("accountOrder" in body && Array.isArray(body.accountOrder)) state.accountOrder = body.accountOrder.map(String);
    await saveState();
    return json(res, state);
  }
  if (method === "POST" && url === "/api/accounts/rename") {
    const { id, name } = JSON.parse((await readBody(req)) || "{}");
    const acc = id && accounts.get(id);
    if (!acc || !String(name ?? "").trim()) return json(res, { error: "id + name required" }, 400);
    acc.name = String(name).trim();
    await repo.save("accounts", acc.id, acc);
    return json(res, accountSummary());
  }
  if (method === "POST" && url === "/api/accounts/import") {
    // Raw CSV body. ?id= to update an existing account; else ?name= creates one.
    const text = await readBody(req);
    if (!text.trim()) return json(res, { error: "empty CSV body" }, 400);
    let id = u.searchParams.get("id") || "";
    const name = (u.searchParams.get("name") || "").trim();
    const existing = id ? accounts.get(id) : null;
    if (!existing) { id = slug(name || id || "account"); }
    const finalName = existing?.name ?? name ?? id;
    const imported = parseCatalogCsv(text);
    if (!imported.cards.length) return json(res, { error: "no cards parsed from CSV" }, 400);
    await repo.saveImport(id, text);
    const overlay = overlayFromCatalog(imported, id, finalName);
    if (existing) overlay.variantCardIds = existing.variantCardIds; // preserve variants
    await repo.save("accounts", id, overlay);
    accounts.set(id, overlay);
    // This upload is the freshest full card list → make it the shared catalog.
    state.catalogSourceId = id;
    if (state.activeAccountId == null) state.activeAccountId = id;
    await saveState();
    refreshCatalog();
    return json(res, accountSummary());
  }

  if (method === "POST" && url === "/api/accounts/variants/toggle") {
    const { id, cardId: cid, on } = JSON.parse((await readBody(req)) || "{}");
    const acc = id && accounts.get(id);
    const key = String(cid ?? "");
    if (!acc || !key) return json(res, { error: "id + cardId required" }, 400);
    const set = new Set(acc.variantCardIds);
    if (on) { if (catalogById.has(key)) set.add(key); } else set.delete(key);
    acc.variantCardIds = [...set];
    await repo.save("accounts", acc.id, acc);
    return json(res, accountSummary());
  }
  if (method === "POST" && url === "/api/accounts/variants/import") {
    // Raw CSV body (game variant export). REPLACES the account's variant list
    // (S2.4b): we keep only the Card IDs, ignore in-game level/ratings (v5 is
    // recomputed), and match against the catalog.
    const text = await readBody(req);
    const id = u.searchParams.get("id") || state.activeAccountId;
    const acc = id ? accounts.get(id) : null;
    if (!acc) return json(res, { error: "unknown account" }, 400);
    const { ids, column } = parseVariantExport(text);
    if (!column) return json(res, { error: "no CID / Card ID column found in CSV" }, 400);
    const matched = ids.filter((i) => catalogById.has(i));
    acc.variantCardIds = matched;
    await repo.save("accounts", acc.id, acc);
    return json(res, { ...accountSummary(), imported: ids.length, matched: matched.length, unmatched: ids.length - matched.length, column });
  }

  // ── Static SPA ──
  const rel = url === "/" ? "/index.html" : url;
  const filePath = join(WEB_DIST, rel);
  if (existsSync(filePath) && !filePath.endsWith("/")) {
    res.setHeader("Content-Type", MIME[extname(filePath)] ?? "application/octet-stream");
    res.end(readFileSync(filePath));
    return;
  }
  const index = join(WEB_DIST, "index.html");
  if (existsSync(index)) { res.setHeader("Content-Type", "text/html"); res.end(readFileSync(index)); return; }
  res.statusCode = 404;
  res.end("SPA not built. Run `npm run build:web` (or use `npm run dev:web` for live dev).");
});

server.listen(PORT, () => {
  console.log(`[server] http://localhost:${PORT}  (${tournaments.length} tournaments; ${accounts.size} accounts; catalog: ${catalogSource}, ${catalog.cards.length} cards)`);
});
