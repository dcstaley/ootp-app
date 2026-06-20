// M3 / SX.1 — minimal local server. Owns the data folder + the scoring core and
// serves scored cards to the browser SPA (the browser never scores — it reads
// the one core's output). Built SPA is served from web/dist; /api/* is JSON.
//
// Dev note: until a trained model + tournament selection exist in-app, the
// "active config" is loaded from a captured coeff bag if one is present locally
// (real, trusted numbers), else the committed _synthetic placeholder.

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { parseCatalogCsv } from "../data/catalog.ts";
import { buildEligiblePool } from "../config/eligibility.ts";
import { scoreCard, calibrate, computeDerived, type Coeffs } from "../scoring-core/index.ts";
import type { Tournament } from "../config/tournament.ts";

const PORT = Number(process.env.PORT ?? 8787);
const WEB_DIST = "web/dist";

function loadActiveConfig(): { name: string; coeffs: Coeffs } {
  for (const c of ["real-parkera", "real-thr", "real-neutral"]) {
    const f = `fixtures/captures/${c}.json`;
    if (existsSync(f)) return { name: c, coeffs: JSON.parse(readFileSync(f, "utf8")).coeffs };
  }
  return { name: "_synthetic (dev placeholder)", coeffs: JSON.parse(readFileSync("fixtures/captures/_synthetic.json", "utf8")).coeffs };
}

// First-cut active tournament (matches the captured real-parkera eligibility).
const TOURNAMENT: Tournament = {
  id: "default", name: "Default (Card Value 60–89)",
  card_value_min: 60, card_value_max: 89, total_cap: 1858,
  roster_size: 26, hitters: 14, pitchers: 12, min_starters: 5, min_starter_stamina: 70, min_pitch_types: 3, dh: true,
  variants_allowed: true, max_variants_on_roster: 5,
  eraId: "", parkId: "", softcaps: {} as Tournament["softcaps"], eligibility: { mode: "ALL", rules: [] },
};

console.log("[server] loading catalog + scoring all cards…");
const catalog = parseCatalogCsv(readFileSync("docs/pt_card_list.csv", "utf8"));
const active = loadActiveConfig();
const derived = computeDerived(active.coeffs);
const pool = buildEligiblePool(catalog.cards, TOURNAMENT);
const calScales = calibrate(pool, { coeffs: active.coeffs, derived });
const config = { coeffs: active.coeffs, derived, calScales };

const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const round = (x: number) => Math.round(x * 1e4) / 1e4;
const eligibleKey = (c: Record<string, unknown>) => `${c["Card ID"]}|${String(c["Variant"] ?? "")}`;
const eligibleSet = new Set(pool.map(eligibleKey));

// Learnable positions (the actual position-eligibility, not the single Pos field).
const LEARN: [string, string][] = [
  ["LearnC", "C"], ["Learn1B", "1B"], ["Learn2B", "2B"], ["Learn3B", "3B"],
  ["LearnSS", "SS"], ["LearnLF", "LF"], ["LearnCF", "CF"], ["LearnRF", "RF"], ["LearnP", "P"],
];
// Raw defensive ratings (NOT per-position ratings).
const DEF_COLS = [
  "Infield Range", "Infield Error", "Infield Arm", "DP",
  "CatcherAbil", "CatcherFrame", "Catcher Arm",
  "OF Range", "OF Error", "OF Arm", "Speed",
];

const scored = catalog.cards.map((c) => {
  const s = scoreCard(c, config);
  const learn: Record<string, number> = {};
  for (const [col, pos] of LEARN) learn[pos] = n(c[col]) === 1 ? 1 : 0;
  const def: Record<string, number> = {};
  for (const k of DEF_COLS) def[k] = n(c[k]);
  return {
    id: String(s.cardId),
    variant: String(c["Variant"] ?? "").toUpperCase() === "Y" ? "Y" : "",
    title: s.title, first: String(c["FirstName"] ?? ""), last: String(c["LastName"] ?? ""),
    bats: s.bats, throws: s.throws, value: n(c["Card Value"]), owned: n(c["owned"]),
    learn, eligible: eligibleSet.has(eligibleKey(c)),
    hitVL: round(s.hit.woba_vL), hitVR: round(s.hit.woba_vR), hitOVR: round(s.hit.woba_ovr),
    basicHit: round(s.hit.basic_ovr),
    pitchVL: round(s.pitch.woba_vL), pitchVR: round(s.pitch.woba_vR), pitchOVR: round(s.pitch.woba_ovr),
    basicPitch: round(s.pitch.basic_ovr),
    def,
  };
});

const meta = {
  configName: active.name, tournament: TOURNAMENT.name,
  cardCount: scored.length, eligibleCount: pool.length,
};

const MIME: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".ico": "image/x-icon",
};

const server = createServer((req, res) => {
  const url = (req.url ?? "/").split("?")[0]!;
  if (url === "/api/cards") return json(res, scored);
  if (url === "/api/meta") return json(res, meta);

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
  console.log(`[server] http://localhost:${PORT}  (config: ${active.name}; ${scored.length} cards, ${pool.length} eligible)`);
});
