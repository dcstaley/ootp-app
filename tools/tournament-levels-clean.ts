// Batch 2.5 re-validation: level tables on ghost-CLEANED EG + Bronze via the CORRECTED eval
// (real BIP recompute + honors the active transformMode). Prints per-event predicted-vs-actual
// level bias in BOTH the base frame (no transform) and frame-v2 (production / active mode) so the
// §11 numbers can be updated on clean data. era_bip_adj is at its resolved default (ON).
//
//   run: node tools/tournament-levels-clean.ts
import { existsSync, readFileSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import { applyWobaWeights, makeRawPolyModel, computeUnifiedFieldStats, buildFrameShift, poolMeanK } from "../src/scoring-core/index.ts";
import { loadTournamentOutcomes, tournamentExposure, evaluateTournamentLevels } from "../src/training/tournament-eval.ts";
import { cleanTournamentRows } from "../src/eval/tournament-clean.ts";
import { parseCatalogCsv } from "../src/data/catalog.ts";
import { rowEligible } from "../src/config/eligibility.ts";

const FIELD_N = 50, S_K = 1.75, G0_K = 17;
const kRamp = (gap: number) => 1 + (S_K - 1) * Math.min(Math.max(gap / G0_K, 0), 1);

const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state: any = (await repo.load<any>("state", "app")) ?? {};
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const trained = (await repo.loadAll<any>("trained-models")).find((x) => x.id === state.activeModelId);
const eventForm = trained.eventForm;
const rp = makeRawPolyModel(eventForm);
const cat = parseCatalogCsv(readFileSync("data/imports/cdmx.csv", "utf8"));
const isB = (c: any) => String(c["Variant"] ?? "").toUpperCase() !== "Y";
const fmt = (n: number) => (n >= 0 ? "+" : "") + n.toFixed(2);

console.log(`Level tables on CLEANED data — active model ${trained.id}, transformMode(state)=${state.transformMode}, era_bip_adj default (ON)\n`);

for (const [name, RAW, TID] of [["Early Gold", "Tournament Data/Early Gold", "early-gold"], ["Return of the Bronze", "Tournament Data/Return of the Bronze", "bronze-return"]] as const) {
  const TDIR = existsSync(`${RAW} - CLEANED`) ? `${RAW} - CLEANED` : RAW;
  const t = (await repo.loadAll<Tournament>("tournaments")).find((x) => x.id === TID)!;
  const coeffs = resolveCoeffs(model, eras.get(t.eraId)!, parks.get(t.parkId)!, t.softcaps);
  if (trained.wobaWeights) applyWobaWeights(coeffs, trained.wobaWeights);
  const inV = (c: any) => { const v = Number(c["Card Value"]) || 0; return (t.card_value_min == null || v >= t.card_value_min) && (t.card_value_max == null || v <= t.card_value_max); };
  const basePool = cat.cards.filter((c: any) => isB(c) && inV(c) && rowEligible(c as any, t));
  const poolField = computeUnifiedFieldStats(basePool, coeffs, rp, FIELD_N, true);
  const frameShift = buildFrameShift(trained.trainingMeans, poolField);
  const kb = poolMeanK(basePool, coeffs, rp, frameShift, FIELD_N);
  const kSpread = { sHit: kRamp(frameShift.hit.vR.kRat ?? 0), sPit: kRamp(frameShift.pit.vR.stu ?? 0), meanHit: kb.hit, meanPit: kb.pit };

  const obs = loadTournamentOutcomes(TDIR, { clean: (rows) => cleanTournamentRows(rows).cleaned });
  const exposure = tournamentExposure(obs);
  console.log(`\n======== ${name} (${t.eraId}) — ${TDIR.endsWith("CLEANED") ? "CLEANED" : "RAW"}, ${obs.length} obs ========`);
  for (const [fr, extra] of [["base   ", {}], ["frameV2", { frameShift, kSpread }]] as const) {
    const tbl = evaluateTournamentLevels(obs, { coeffs, eventForm, ...extra }, exposure);
    const line = (role: "hit" | "pit") => tbl[role].map((r) => `${r.event}:${fmt(r.bias)}`).join("  ");
    console.log(`  [${fr}] HIT  ${line("hit")}`);
    console.log(`  [${fr}] PIT  ${line("pit")}`);
  }
}
process.exit(0);
