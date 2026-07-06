// THROWAWAY diagnostic — handedness composition of the top-N-by-rating FIELD
// (NOT the raw catalog, NOT role-gated). Reuses the app's boot loaders + the ONE
// scoring core. Ranks every eligible base card by RAW predicted wOBA per role×side
// (the same selection computeUnifiedFieldStats uses), takes the FIELD_N field, and
// reports its Bats/Throws mix vs a tournament's trained/config platoon values.
//
//   run: node tools/field-split.ts [tournamentId]   (default: oaxaca-league)

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { parseCatalogCsv, cardId } from "../src/data/catalog.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import { makeRawPolyModel, applyWobaWeights } from "../src/scoring-core/index.ts";
import { assembleRawHittingWoba, assembleRawPitchingWoba } from "../src/scoring-core/woba.ts";
import { n, sameSidePenaltyHitting, sameSidePenaltyPitching } from "../src/scoring-core/helpers.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";

const DATA_ROOT = "data";
const FIELD_N = 50;
const TID = process.argv[2] ?? "oaxaca-league";

const repo = new Repository(DATA_ROOT);
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state: any = (await repo.load<any>("state", "app")) ?? {};
const accounts = await repo.loadAll<any>("accounts");
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const tournaments = await repo.loadAll<Tournament>("tournaments");
const t = tournaments.find((x) => x.id === TID)!;
if (!t) { console.error(`tournament '${TID}' not found`); process.exit(1); }

// Active trained model → eventForm + wОBA weights (as the server threads them).
const trained = state.activeModelId
  ? (await repo.loadAll<any>("trained-models")).find((x) => x.id === state.activeModelId)
  : undefined;
const eventForm = trained?.eventForm;
if (!eventForm) { console.error("no active trained model / eventForm — field ranking would be log-linear, aborting"); process.exit(1); }

// Catalog = latest upload (replicate server loadCatalog).
const tryIds = [process.env.CATALOG, state.catalogSourceId, ...accounts.map((a) => a.id)].filter(Boolean) as string[];
let catalogFile = "docs/pt_card_list.csv", src = "(docs sample)";
for (const id of tryIds) { const f = join(DATA_ROOT, "imports", `${id}.csv`); if (existsSync(f)) { catalogFile = f; src = id; break; } }
const catalog = parseCatalogCsv(readFileSync(catalogFile, "utf8"));

// Coeffs exactly as scoreTournament: resolve over the tournament's era/park, then
// overlay the active model's wОBA weights. (era/park don't affect RAW wОBA ranking,
// but we build faithfully anyway.)
const era = eras.get(t.eraId)!, park = parks.get(t.parkId)!;
const coeffs = resolveCoeffs(model, era, park, t.softcaps);
if (trained?.wobaWeights) applyWobaWeights(coeffs, trained.wobaWeights);
const rp = makeRawPolyModel(eventForm);

const isBase = (c: any) => String(c["Variant"] ?? "").toUpperCase() !== "Y";
// Oaxaca eligibility = ALL, so the eligible pool is the whole base catalog. (For a
// value-gated tournament this would need the eligibility filter; noted.)
const pool = catalog.cards.filter(isBase);

interface Rec { bats: number; thr: number; hVR: number; hVL: number; pVR: number; pVL: number }
const recs: Rec[] = pool.map((c: any) => {
  const bats = n(c["Bats"]), thr = n(c["Throws"]);
  const speed = n(c["Speed"]), steal = n(c["Stealing"]), run = n(c["Baserunning"]);
  const hit = (side: "vR" | "vL") => {
    const e = rp.predictHitting({ eye: n(c[`Eye ${side}`]), pow: n(c[`Power ${side}`]), kRat: n(c[`Avoid K ${side}`]), babip: n(c[`BABIP ${side}`]), gap: n(c[`Gap ${side}`]), speed, steal, run }, coeffs);
    return assembleRawHittingWoba(e, sameSidePenaltyHitting(bats, side, coeffs.ssp_adv_hitting), speed, steal, run, coeffs);
  };
  const pit = (side: "vR" | "vL") => {
    const e = rp.predictPitching({ con: n(c[`Control ${side}`]), stu: n(c[`Stuff ${side}`]), pbabip: n(c[`pBABIP ${side}`]), hrr: n(c[`pHR ${side}`]) }, coeffs);
    return assembleRawPitchingWoba(e, sameSidePenaltyPitching(thr, side, coeffs.ssp_basic_pitching), coeffs);
  };
  return { bats, thr, hVR: hit("vR"), hVL: hit("vL"), pVR: pit("vR"), pVL: pit("vL") };
});

const pct = (a: number, b: number) => (a + b > 0 ? a / (a + b) : 0);
const throwsMix = (rs: Rec[]) => { const R = rs.filter((r) => r.thr === 1).length, L = rs.filter((r) => r.thr === 2).length; return { R, L, RHP: pct(R, L) }; };
const batsMix = (rs: Rec[]) => { const R = rs.filter((r) => r.bats === 1).length, L = rs.filter((r) => r.bats === 2).length, S = rs.filter((r) => r.bats === 3).length; const tot = R + L + S; return { R, L, S, tot, fR: R / tot, fL: L / tot, fS: S / tot }; };

for (const N of [FIELD_N, 100]) {
  // Pitcher field: top-N by combined allowed wОBA (lower = better).
  const pitField = [...recs].sort((a, b) => (a.pVR + a.pVL) - (b.pVR + b.pVL)).slice(0, N);
  // Hitter field: UNION of top-N by hVR and top-N by hVL (matches the pool build).
  const byVR = [...recs].sort((a, b) => b.hVR - a.hVR).slice(0, N);
  const byVL = [...recs].sort((a, b) => b.hVL - a.hVL).slice(0, N);
  const hitField = [...new Set([...byVR, ...byVL])];

  const tm = throwsMix(pitField), bm = batsMix(hitField);
  console.log(`\n===== FIELD N=${N}  (tournament: ${t.name}, catalog: ${src}, pool=${recs.length} base cards) =====`);
  console.log(`PITCHER field (${pitField.length}): RHP=${tm.R} LHP=${tm.L}  → %RHP = ${tm.RHP.toFixed(3)}`);
  console.log(`   compare trained teamVR (hitters' PA-share vs RHP) = ${t.platoonVR ?? "?"}`);
  console.log(`HITTER field (${bm.tot}): RHB=${bm.R} LHB=${bm.L} SW=${bm.S}  → R=${bm.fR.toFixed(3)} L=${bm.fL.toFixed(3)} S=${bm.fS.toFixed(3)}`);
  const pl = (t as any).platoon;
  if (pl) console.log(`   trained pitch splits: r_pitch_split_sp=${pl.r_pitch_split_sp} l_pitch_split_sp=${pl.l_pitch_split_sp}  hit: r=${pl.r_hit_split} l=${pl.l_hit_split} s=${pl.s_hit_split}`);
}
process.exit(0);
