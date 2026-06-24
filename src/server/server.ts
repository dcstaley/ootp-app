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
import { scoreCard, calibrate, calibrateBasic, computeDerived, valueFor, TARGET_WOBA, TARGET_BASIC } from "../scoring-core/index.ts";
import { generateFullRoster, type HitterCandidate, type PitcherCandidate, type RosterOptimizeOptions } from "../optimizer/index.ts";
import type { Tournament, Era, Park } from "../config/tournament.ts";
import { Repository } from "../persistence/repository.ts";
import { seedDefaults, seedEras } from "../config/seed.ts";
import { seedAccounts, slug } from "../data/account-seed.ts";
import { resolveCoeffs, type Model } from "../config/coeff-resolve.ts";
import { loadTrainingDir, loadWindow, availableYears, type LoadedTraining, type TrainObs } from "../training/loader.ts";
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

interface AppState { activeAccountId: string | null; catalogSourceId: string | null; activeTournamentId: string | null; accountOrder?: string[] }

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

function scoreTournament(t: Tournament): Scored {
  const era = eras.get(t.eraId);
  const park = parks.get(t.parkId);
  if (!era || !park) throw new Error(`Tournament ${t.id}: missing era '${t.eraId}' or park '${t.parkId}'`);

  const coeffs = resolveCoeffs(model!, era, park, t.softcaps);
  const derived = computeDerived(coeffs);
  const pool = buildEligiblePool(catalog.cards, t);
  const config = { coeffs, derived, calScales: calibrate(pool, { coeffs, derived }) };
  const basicConfig = { coeffs, derived, calScales: calibrateBasic(pool, { coeffs, derived }) };

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
): { hitters: HitterCandidate[]; pitchers: PitcherCandidate[]; twoWayIds: string[]; entries: Entry[]; ownedByDisp: Record<string, number>; defByDisp: Record<string, Def>; lastByDisp: Record<string, string> } {
  const { s } = scoredFor(t.id);
  const ctx = s.ctx;
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
    entries.push({
      dispId,
      hitVR: hitVal(sc, "vR"), hitVL: hitVal(sc, "vL"),
      pitVR, pitVL, pitOVR: platoonVR * pitVR + platoonVL * pitVL,
      positions, stamina: n(c0["Stamina"]), pitchTypes: pitchCount(c0),
      bats: sc.bats, throws: sc.throws, title: String(sc.title), cost,
      role: roleOverrides[id] ?? "auto",
    });
    ownedByDisp[dispId] = qty;
    defByDisp[dispId] = defOf(c);
    lastByDisp[dispId] = String(c0["LastName"] ?? "");
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
  // Starter-eligible positions (lineup) + backup-eligible (coverage), per the
  // tournament's per-position min defensive ratings. A starter automatically backs
  // up too; DH has no defensive min.
  const qualifiedPositions = (dispId: string, raw: string[]): { starter: string[]; cover: string[] } => {
    const def = defByDisp[dispId]!;
    const field = raw.filter((p) => p !== "DH");
    const canStart = (p: string) => meetsPositionMins(def, p, posMins[p]?.starter);
    return {
      starter: ["DH", ...field.filter(canStart)],
      cover: field.filter((p) => canStart(p) || meetsPositionMins(def, p, posMins[p]?.backup)),
    };
  };

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
      hitters.push({ id: e.dispId, title: e.title, bats: e.bats, valueVR: e.hitVR, valueVL: e.hitVL, positions: q.starter, coverPositions: q.cover, cost: e.cost });
    }
    if (useP) pitchers.push({ id: e.dispId, title: e.title, throws: e.throws, valueVR: e.pitVR, valueVL: e.pitVL, stamina: e.stamina, pitchTypes: e.pitchTypes, cost: e.cost });
    const isTwoWay = useH && useP && (e.role === "twoway" || (e.role === "auto" && twHit.has(e.dispId) && twPit.has(e.dispId)));
    if (isTwoWay) twoWayIds.push(e.dispId);
  }
  return { hitters, pitchers, twoWayIds, entries, ownedByDisp, defByDisp, lastByDisp };
}

// Effective budget mode: explicit field, else derived (slots > cap > none).
function budgetMode(t: Tournament): "none" | "cap" | "slots" {
  if (t.budget_mode) return t.budget_mode;
  if (t.slot_counts && Object.keys(t.slot_counts).length) return "slots";
  if (t.total_cap && t.total_cap > 0) return "cap";
  return "none";
}

function rosterOptions(t: Tournament): RosterOptimizeOptions {
  return {
    nHitters: t.hitters, nPitchers: t.pitchers, dh: t.dh,
    minStarters: t.min_starters, minStarterStamina: t.min_starter_stamina, minPitchTypes: t.min_pitch_types,
    platoonVR: t.platoonVR ?? 0.62, platoonVL: t.platoonVL ?? 0.38, // tournament platoon split (league default)
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
  const { hitters, pitchers, twoWayIds, entries, ownedByDisp, defByDisp, lastByDisp } = rosterCandidates(t, aid, ownedOnly, new Set(excluded), roleOverrides, forceInclude, opts0.platoonVR, opts0.platoonVL, metric);
  const opts = { ...opts0, lockedIds: locked, twoWayIds, lineupLocks };
  const r = await generateFullRoster(hitters, pitchers, opts);
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
  const rosterHitters = r.hitters.map((id) => {
    const c = hById.get(id)!; const role = hitRole(id);
    return { id: strip(id), title: c.title, last: lastByDisp[id] ?? "", bats: BATS[c.bats] ?? "", role, twoWay: twoWaySet.has(strip(id)), positions: c.positions, def: defByDisp[id],
      wobaVL: hScore(c.valueVL), wobaVR: hScore(c.valueVR), cost: c.cost, owned: ownedByDisp[id] ?? 0 };
  }).sort((a, b) => roleRank[a.role]! - roleRank[b.role]! || Math.max(b.wobaVL, b.wobaVR) - Math.max(a.wobaVL, a.wobaVR));
  const rosterPitchers = r.pitchers.map((id) => {
    const c = pById.get(id)!; const role = pitRole(id);
    const combined = opts.platoonVR * c.valueVR + opts.platoonVL * c.valueVL;
    return { id: strip(id), title: c.title, last: lastByDisp[id] ?? "", throws: THROWS[c.throws] ?? "", role, twoWay: twoWaySet.has(strip(id)),
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
    positions: e.positions, def: defByDisp[e.dispId]!, cost: e.cost, owned: ownedByDisp[e.dispId] ?? 0,
    hitVL: hScore(e.hitVL), hitVR: hScore(e.hitVR),
    pitOVR: pScore(e.pitOVR), pitVL: pScore(e.pitVL), pitVR: pScore(e.pitVR),
    stamina: e.stamina, pitchTypes: e.pitchTypes,
  }));
  const nextBest = { available };

  return {
    roles, rosterHitters, rosterPitchers, ownedOnly, metric, twoWayIds: [...twoWaySet], nextBest,
    cardValueMin: t.card_value_min ?? 40, cardValueMax: t.card_value_max ?? null,
    nHitters: t.hitters, nPitchers: t.pitchers,
    minStarterStamina: t.min_starter_stamina, minPitchTypes: t.min_pitch_types,
    status: r.status, mode: opts.mode, cap: opts.totalCap ?? null, cost: r.cost ?? null,
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

// ── Training data (M6 / SP-9) ──────────────────────────────────────────────────
// Lazy-loaded + cached: the real per-(league, side, year) outcome CSVs grouped
// into observations. Ingestion only — no model is trained here yet.
let trainingCache: LoadedTraining | null = null;
let trainingErr: string | null = null;
const windowCache = new Map<string, TrainObs[]>(); // observations per year-window
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
function windowObs(years: number[]): TrainObs[] {
  const key = years.join(",");
  let o = windowCache.get(key);
  if (!o) { o = loadWindow(TRAINING_DIR, years).observations; windowCache.set(key, o); }
  return o;
}

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
  diag: { hitPearson: number | null; pitPearson: number | null; rowsHit: number; rowsPit: number };
  trainedAt: string; notes?: string;
}
type TrainedModelSummary = Omit<TrainedModel, "coefficients">;
const modelSummary = (m: TrainedModel): TrainedModelSummary => { const { coefficients, ...rest } = m; return rest; };
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
  const existing = await repo.loadAll<TrainedModel>("trained-models");
  let id = slug(name) || "model"; while (existing.some((m) => m.id === id)) id += "-2";
  const model: TrainedModel = {
    id, name, datasetRoot: TRAINING_DIR, window, minPA, includeVariants,
    coefficients: { woba_hitting: f.woba_hitting.coefficients, woba_pitching: f.woba_pitching.coefficients, basic_hitting: f.basic_hitting.coefficients, basic_pitching: f.basic_pitching.coefficients },
    diag: { hitPearson: f.wobaDiagHit?.pearson ?? null, pitPearson: f.wobaDiagPit?.pearson ?? null, rowsHit: f.woba_hitting.rowCount, rowsPit: f.woba_pitching.rowCount },
    trainedAt: new Date().toISOString(), notes: body.notes ? String(body.notes) : undefined,
  };
  await repo.save("trained-models", id, model);
  return modelSummary(model);
}

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
const parkList = () => [...parks.values()].map((p) => ({ id: p.id, name: p.name }));

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
  if (method === "GET" && url === "/api/libraries") return json(res, { eras: eraList(), parks: parkList(), columns: [...catalog.columns].sort((a, b) => a.localeCompare(b)) });
  if (method === "GET" && url === "/api/parks") return json(res, { parks: [...parks.values()] });
  if (method === "GET" && url === "/api/eras") return json(res, { eras: [...eras.values()] });
  if (method === "GET" && url === "/api/accounts") return json(res, accountSummary());
  if (method === "GET" && url === "/api/training/summary") {
    const t = getTraining(u.searchParams.get("reload") === "true");
    if (!t) return json(res, { available: false, dir: TRAINING_DIR, error: trainingErr }, 200);
    return json(res, { available: true, ...t.summary });
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
  if (method === "GET" && url === "/api/training/models") return json(res, { models: await listModels() });
  if (method === "POST" && url === "/api/training/models/save") {
    const body = JSON.parse((await readBody(req)) || "{}");
    try { const model = await saveTrainedModel(body); return json(res, { ok: true, model, models: await listModels() }); }
    catch (e) { return json(res, { ok: false, error: String(e) }, 400); }
  }
  if (method === "POST" && url === "/api/training/models/delete") {
    const id = u.searchParams.get("id") || "";
    if (!id) return json(res, { ok: false, error: "id required" }, 400);
    await repo.delete("trained-models", id);
    return json(res, { ok: true, models: await listModels() });
  }
  if (method === "GET" && url === "/api/cards") return json(res, buildCards(tid, aid));
  if (method === "GET" && url === "/api/meta") return json(res, buildMeta(tid, aid));
  if (method === "GET" && url === "/api/roster") {
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
    return json(res, await generateRosterFor(tid, aid, u.searchParams.get("ownedOnly") !== "false", list("locked"), list("excluded"), roleOverrides, metric, lineupLocks));
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
