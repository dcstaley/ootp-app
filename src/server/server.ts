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
import { scoreCard, calibrate, calibrateBasic, computeDerived, valueFor, TARGET_WOBA } from "../scoring-core/index.ts";
import { generateFullRoster, type HitterCandidate, type PitcherCandidate, type RosterOptimizeOptions } from "../optimizer/index.ts";
import type { Tournament, Era, Park } from "../config/tournament.ts";
import { Repository } from "../persistence/repository.ts";
import { seedDefaults } from "../config/seed.ts";
import { seedAccounts, slug } from "../data/account-seed.ts";
import { resolveCoeffs, type Model } from "../config/coeff-resolve.ts";

const PORT = Number(process.env.PORT ?? 8787);
const WEB_DIST = "web/dist";
const DATA_ROOT = process.env.DATA_ROOT ?? "data";

interface AppState { activeAccountId: string | null; catalogSourceId: string | null; activeTournamentId: string | null; accountOrder?: string[] }

// ── Boot: config DB + accounts + catalog ──────────────────────────────────────
console.log("[server] loading catalog + tournaments database…");
const repo = new Repository(DATA_ROOT);

const seedCfg = await seedDefaults(repo);
console.log(`[server] tournaments DB: ${seedCfg.seeded ? "seeded" : "loaded"} — ${seedCfg.tournaments} tournaments, ${seedCfg.eras} eras, ${seedCfg.parks} parks; model: ${seedCfg.modelName}`);
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
// variant (it dominates). Two-way handling is a follow-up: a card with Pos Rating
// P > 0 goes to the pitcher pool only (avoids double-rostering one card).
function rosterCandidates(t: Tournament, accountId: string | null, ownedOnly: boolean): { hitters: HitterCandidate[]; pitchers: PitcherCandidate[]; ownedByDisp: Record<string, number> } {
  const { s } = scoredFor(t.id);
  const ctx = s.ctx;
  const acc = accountId ? accounts.get(accountId) : null;
  const owned = acc?.owned ?? {};
  const variantIds = new Set(acc?.variantCardIds ?? []);
  const hitters: HitterCandidate[] = [];
  const pitchers: PitcherCandidate[] = [];
  const ownedByDisp: Record<string, number> = {};

  for (const c0 of catalog.cards) {
    const id = cardId(c0);
    const qty = owned[id] ?? 0;
    if ((ownedOnly && qty <= 0) || !ctx.isEligible(c0)) continue;
    const useVariant = variantIds.has(id) && t.variants_allowed;
    const c = useVariant ? makeVariant(c0) : c0;
    const sc = scoreCard(c, ctx.config);
    const cost = n(c0["Card Value"]);
    const dispId = useVariant ? `${id}#V` : id;
    ownedByDisp[dispId] = qty;
    if (n(c0["Pos Rating P"]) > 0) {
      pitchers.push({
        id: dispId, title: String(sc.title), throws: sc.throws,
        valueVR: valueFor(sc.pitch.woba_vR, "pitcher"), valueVL: valueFor(sc.pitch.woba_vL, "pitcher"),
        stamina: n(c0["Stamina"]), pitchTypes: pitchCount(c0), cost,
      });
    } else {
      const positions = [...LEARN.filter(([col]) => n(c0[col]) === 1).map(([, p]) => p), "DH"];
      hitters.push({
        id: dispId, title: String(sc.title), bats: sc.bats,
        valueVR: valueFor(sc.hit.woba_vR, "hitter"), valueVL: valueFor(sc.hit.woba_vL, "hitter"),
        positions, cost,
      });
    }
  }
  return { hitters, pitchers, ownedByDisp };
}

function rosterOptions(t: Tournament): RosterOptimizeOptions {
  const mode = t.total_cap && t.total_cap > 0 ? "cap" : "none";
  return {
    nHitters: t.hitters, nPitchers: t.pitchers, dh: t.dh,
    minStarters: t.min_starters, minStarterStamina: t.min_starter_stamina, minPitchTypes: t.min_pitch_types,
    platoonVR: 0.62, platoonVL: 0.38, // league default; tournament platoon setting is a later field
    mode, totalCap: t.total_cap ?? undefined, rosterSize: t.roster_size,
  };
}

async function generateRosterFor(tid: string, aid: string | null, ownedOnly: boolean) {
  const t = tournamentById.get(tid) ?? tournamentById.get(DEFAULT_TOURNAMENT_ID)!;
  const { hitters, pitchers, ownedByDisp } = rosterCandidates(t, aid, ownedOnly);
  const opts = rosterOptions(t);
  const r = await generateFullRoster(hitters, pitchers, opts);

  const hById = new Map(hitters.map((c) => [c.id, c]));
  const pById = new Map(pitchers.map((c) => [c.id, c]));
  const hCard = (id: string) => { const c = hById.get(id); return { id, title: c?.title ?? id, cost: c?.cost ?? 0 }; };
  const pCard = (id: string) => { const c = pById.get(id); return { id, title: c?.title ?? id, cost: c?.cost ?? 0, stamina: c?.stamina ?? 0, pitchTypes: c?.pitchTypes ?? 0 }; };
  const starterIds = new Set([...r.lineupVR, ...r.lineupVL].map((x) => x.id));
  const bench = r.hitters.filter((id) => !starterIds.has(id)).map(hCard);

  // Per-card roster ROLE (drives the colour coding on the grid + roster page),
  // keyed by base Card ID. Hitters: both/vL/vR/bench by lineup membership;
  // pitchers: starter (in rotation) / reliever (bullpen). Matches old-app colours.
  const strip = (id: string) => id.replace(/#V$/, "");
  const vrIds = new Set(r.lineupVR.map((x) => x.id));
  const vlIds = new Set(r.lineupVL.map((x) => x.id));
  const rotIds = new Set(r.rotation.map((x) => x.id));
  const roles: Record<string, string> = {};
  for (const id of r.hitters) roles[strip(id)] = vrIds.has(id) && vlIds.has(id) ? "both" : vlIds.has(id) ? "vL" : vrIds.has(id) ? "vR" : "bench";
  for (const id of r.pitchers) roles[strip(id)] = rotIds.has(id) ? "starter" : "reliever";

  // Roster LIST detail (the 26-card tables). wOBA reconstructed from valueFor
  // (hitter = value + baseline; pitcher allowed = baseline − value), matching the grid.
  const BATS: Record<number, string> = { 1: "R", 2: "L", 3: "S" };
  const THROWS: Record<number, string> = { 1: "R", 2: "L" };
  const roleRank: Record<string, number> = { both: 0, vL: 1, vR: 1, bench: 2, starter: 0, reliever: 1 };
  const rosterHitters = r.hitters.map((id) => {
    const c = hById.get(id)!; const role = roles[strip(id)] ?? "bench";
    return { id: strip(id), title: c.title, bats: BATS[c.bats] ?? "", role,
      wobaVL: round(c.valueVL + TARGET_WOBA), wobaVR: round(c.valueVR + TARGET_WOBA), cost: c.cost, owned: ownedByDisp[id] ?? 0 };
  }).sort((a, b) => roleRank[a.role]! - roleRank[b.role]! || Math.max(b.wobaVL, b.wobaVR) - Math.max(a.wobaVL, a.wobaVR));
  const rosterPitchers = r.pitchers.map((id) => {
    const c = pById.get(id)!; const role = roles[strip(id)] ?? "reliever";
    const combined = opts.platoonVR * c.valueVR + opts.platoonVL * c.valueVL;
    return { id: strip(id), title: c.title, throws: THROWS[c.throws] ?? "", role,
      woba: round(TARGET_WOBA - combined), stamina: c.stamina, pitchTypes: c.pitchTypes, cost: c.cost, owned: ownedByDisp[id] ?? 0 };
  }).sort((a, b) => roleRank[a.role]! - roleRank[b.role]! || a.woba - b.woba);

  return {
    roles, rosterHitters, rosterPitchers, ownedOnly,
    status: r.status, mode: opts.mode, cap: opts.totalCap ?? null, cost: r.cost ?? null,
    objective: r.objective, balance: r.balance ?? null,
    poolHitters: hitters.length, poolPitchers: pitchers.length,
    lineupVR: r.lineupVR.map((x) => ({ ...x, cost: hById.get(x.id)?.cost ?? 0 })),
    lineupVL: r.lineupVL.map((x) => ({ ...x, cost: hById.get(x.id)?.cost ?? 0 })),
    rotation: r.rotation.map((x) => ({ ...x, ...pCard(x.id) })),
    bullpen: r.bullpen.map(pCard),
    bench,
    memberIds: [...r.hitters, ...r.pitchers].map((id) => id.replace(/#V$/, "")),
  };
}

// Precompute the default tournament so first paint is instant.
scoredFor(DEFAULT_TOURNAMENT_ID);

// ── HTTP ──────────────────────────────────────────────────────────────────────
const MIME: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".ico": "image/x-icon",
};
const tournamentList = tournaments.map((t) => ({ id: t.id, name: t.name }));

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
    return json(res, { tournaments: tournamentList, defaultId: state.activeTournamentId || DEFAULT_TOURNAMENT_ID });
  if (method === "GET" && url === "/api/accounts") return json(res, accountSummary());
  if (method === "GET" && url === "/api/cards") return json(res, buildCards(tid, aid));
  if (method === "GET" && url === "/api/meta") return json(res, buildMeta(tid, aid));
  if (method === "GET" && url === "/api/roster") return json(res, await generateRosterFor(tid, aid, u.searchParams.get("ownedOnly") !== "false"));

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
