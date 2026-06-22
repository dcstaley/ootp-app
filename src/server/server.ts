// M3 / SX.1 — local server. Owns the data folder + the scoring core and serves
// scored cards to the browser SPA (the browser never scores — it reads the one
// core's output). Built SPA is served from web/dist; /api/* is JSON.
//
// Tournament-aware (D4): the file-based tournaments DB (data/) is the single
// config source. Selecting a tournament resolves its Coeffs from the shared
// Model + its Era/Park (libraries, by id) + its softcaps (resolveCoeffs), then
// calibrates over its eligible pool and re-scores — no "load into coefficients"
// step. Per-tournament scored results are computed lazily and cached.

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { parseCatalogCsv } from "../data/catalog.ts";
import { buildEligiblePool, rowEligible } from "../config/eligibility.ts";
import { makeVariant } from "../data/variants.ts";
import { scoreCard, calibrate, calibrateBasic, computeDerived } from "../scoring-core/index.ts";
import type { Tournament, Era, Park } from "../config/tournament.ts";
import { Repository } from "../persistence/repository.ts";
import { seedDefaults } from "../config/seed.ts";
import { resolveCoeffs, type Model } from "../config/coeff-resolve.ts";

const PORT = Number(process.env.PORT ?? 8787);
const WEB_DIST = "web/dist";
const DATA_ROOT = process.env.DATA_ROOT ?? "data";

// ── Load catalog + the file-based config DB (seed from captures on first run) ──
console.log("[server] loading catalog + tournaments database…");
const catalog = parseCatalogCsv(readFileSync("docs/pt_card_list.csv", "utf8"));
const repo = new Repository(DATA_ROOT);
const seed = await seedDefaults(repo);
console.log(`[server] tournaments DB: ${seed.seeded ? "seeded" : "loaded"} — ${seed.tournaments} tournaments, ${seed.eras} eras, ${seed.parks} parks; model: ${seed.modelName}`);

const model = (await repo.loadAll<Model>("models"))[0];
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const tournaments = await repo.loadAll<Tournament>("tournaments");
const tournamentById = new Map(tournaments.map((t) => [t.id, t]));
const DEFAULT_ID = tournamentById.has("default-neutral") ? "default-neutral" : tournaments[0]?.id ?? "";

if (!model || tournaments.length === 0) {
  console.error("[server] No model/tournaments available. Ensure a capture exists in fixtures/captures/.");
  process.exit(1);
}

// ── Column maps (display) ─────────────────────────────────────────────────────
const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const round = (x: number) => Math.round(x * 1e4) / 1e4;

// The 8 real "can learn position" columns (raw 0/1). There is no LearnP.
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

type ScoredRow = ReturnType<typeof toRow>;
type ScoreCtx = {
  config: Parameters<typeof scoreCard>[1];
  basicConfig: Parameters<typeof scoreCard>[1];
  isEligible: (c: Record<string, unknown>) => boolean;
};

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
    bats: w.bats, throws: w.throws, value: n(c["Card Value"]), owned: n(c["owned"]),
    stamina: n(c["Stamina"]), pitches: pitchCount(c),
    learn, eligible: ctx.isEligible(c),
    hitVL: round(w.hit.woba_vL), hitVR: round(w.hit.woba_vR), hitOVR: round(w.hit.woba_ovr),
    basicHit: round(b.hit.basic_ovr), basicHitVL: round(b.hit.basic_vL), basicHitVR: round(b.hit.basic_vR),
    pitchVL: round(w.pitch.woba_vL), pitchVR: round(w.pitch.woba_vR), pitchOVR: round(w.pitch.woba_ovr),
    basicPitch: round(b.pitch.basic_ovr), basicPitchVL: round(b.pitch.basic_vL), basicPitchVR: round(b.pitch.basic_vR),
    def,
  };
}

// Demo variant rows (one hitter, one pitcher) so variant inclusion is visible.
const byValueDesc = (a: Record<string, unknown>, b: Record<string, unknown>) => n(b["Card Value"]) - n(a["Card Value"]);
const demoHitter = catalog.cards.filter((c) => LEARN.some(([col]) => n(c[col]) === 1)).sort(byValueDesc)[0];
const demoPitcher = catalog.cards.filter((c) => n(c["Pos Rating P"]) > 0).sort(byValueDesc)[0];

// ── Per-tournament scoring (resolve → calibrate → score), cached ──────────────
interface Scored { rows: ScoredRow[]; meta: { configName: string; tournament: string; cardCount: number; eligibleCount: number } }
const cache = new Map<string, Scored>();

function scoreTournament(t: Tournament): Scored {
  const era = eras.get(t.eraId);
  const park = parks.get(t.parkId);
  if (!era || !park) throw new Error(`Tournament ${t.id}: missing era '${t.eraId}' or park '${t.parkId}'`);

  const coeffs = resolveCoeffs(model!, era, park, t.softcaps);
  const derived = computeDerived(coeffs);
  const pool = buildEligiblePool(catalog.cards, t);
  const config = { coeffs, derived, calScales: calibrate(pool, { coeffs, derived }) };
  // Independent basic-metric anchoring so wOBA and basic are both accurate.
  const basicConfig = { coeffs, derived, calScales: calibrateBasic(pool, { coeffs, derived }) };

  const inValueRange = (c: Record<string, unknown>) => {
    const v = n(c["Card Value"]); const lo = t.card_value_min, hi = t.card_value_max;
    return (lo == null || v >= lo) && (hi == null || v <= hi);
  };
  const isEligible = (c: Record<string, unknown>) => inValueRange(c) && rowEligible(c as any, t);
  const ctx: ScoreCtx = { config, basicConfig, isEligible };

  const rows = catalog.cards.map((c) => toRow(c, ctx));
  if (demoHitter) rows.push(toRow(makeVariant(demoHitter), ctx));
  if (demoPitcher) rows.push(toRow(makeVariant(demoPitcher), ctx));

  return {
    rows,
    meta: { configName: model!.name, tournament: t.name, cardCount: rows.length, eligibleCount: pool.length },
  };
}

function scored(id: string): Scored {
  const t = tournamentById.get(id) ?? tournamentById.get(DEFAULT_ID)!;
  let s = cache.get(t.id);
  if (!s) { s = scoreTournament(t); cache.set(t.id, s); }
  return s;
}

// Precompute the default so first paint is instant.
scored(DEFAULT_ID);

// ── HTTP ──────────────────────────────────────────────────────────────────────
const MIME: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".ico": "image/x-icon",
};

const tournamentList = tournaments.map((t) => ({ id: t.id, name: t.name }));

const server = createServer((req, res) => {
  const u = new URL(req.url ?? "/", "http://localhost");
  const url = u.pathname;
  const tid = u.searchParams.get("tournament") || DEFAULT_ID;

  if (url === "/api/tournaments") return json(res, { tournaments: tournamentList, defaultId: DEFAULT_ID });
  if (url === "/api/cards") return json(res, scored(tid).rows);
  if (url === "/api/meta") return json(res, scored(tid).meta);

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

function json(res: import("node:http").ServerResponse, data: unknown) {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}

server.listen(PORT, () => {
  console.log(`[server] http://localhost:${PORT}  (${tournaments.length} tournaments; default: ${tournamentById.get(DEFAULT_ID)?.name})`);
});
