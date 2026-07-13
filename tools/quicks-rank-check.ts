// Re-check the RANKING claim: does the "cards are close" conclusion hold, or was it a PA-threshold
// selection artifact (≥300 PA selects the elite STAPLES = a range-restricted top band)? Run the
// scorecard across PA thresholds per tier (own-gap = active mode) → N, Spearman, Pearson, wOBA spread.
// If Spearman RISES as the threshold DROPS (fuller value range included), the cards are NOT close —
// we just can't rank the elite sub-band.
//   run: node tools/quicks-rank-check.ts
import { readFileSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import { applyWobaWeights, makeRawPolyModel, computeUnifiedFieldStats, buildPoolTransform } from "../src/scoring-core/index.ts";
import { loadTournamentOutcomes, tournamentExposure, tournamentScorecard } from "../src/training/tournament-eval.ts";
import { cleanTournamentRows } from "../src/eval/tournament-clean.ts";
import { parseCatalogCsv } from "../src/data/catalog.ts";
import { rowEligible } from "../src/config/eligibility.ts";

const FIELD_N = 50;
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
const f3 = (n: number | undefined) => (n == null ? "  n/a" : n.toFixed(3));

for (const [name, TDIR, TID] of [["Open", "Tournament Data/Quicks - Open", "default-neutral"], ["Bronze", "Tournament Data/Quicks - Bronze", "bronze-quick"], ["Gold", "Tournament Data/Quicks - Gold", "gold-quick"]] as const) {
  const t = (await repo.loadAll<Tournament>("tournaments")).find((x) => x.id === TID)!;
  const coeffs = resolveCoeffs(model, eras.get(t.eraId)!, parks.get(t.parkId)!, t.softcaps);
  if (trained.wobaWeights) applyWobaWeights(coeffs, trained.wobaWeights);
  const inV = (c: any) => { const v = Number(c["Card Value"]) || 0; return (t.card_value_min == null || v >= t.card_value_min) && (t.card_value_max == null || v <= t.card_value_max); };
  const basePool = cat.cards.filter((c: any) => isB(c) && inV(c) && rowEligible(c as any, t));
  const refField = computeUnifiedFieldStats(cat.cards.filter(isB), coeffs, rp, FIELD_N, true);
  const poolField = computeUnifiedFieldStats(basePool, coeffs, rp, FIELD_N, true);
  const own = { poolTransform: buildPoolTransform(refField, poolField, trained.ratingEnvelope ?? undefined) };
  const obs = loadTournamentOutcomes(TDIR, { clean: (rows) => cleanTournamentRows(rows).cleaned });
  const exposure = tournamentExposure(obs);

  console.log(`\n======== QUICKS ${name} (val≤${t.card_value_max ?? "∞"}), ${obs.length} cards — own-gap ========`);
  console.log(`  role  minPA   N   Spearman  Pearson  (lower threshold = fuller value range)`);
  for (const th of [100, 200, 350, 500] as const) {
    const sc = tournamentScorecard(obs, { coeffs, eventForm, ...own }, exposure, { minPA: th, minBF: th, topN: 20 });
    for (const role of ["hit", "pit"] as const) {
      const s = sc[role];
      console.log(`  ${role.toUpperCase()}   ${String(th).padStart(4)}  ${s ? String(s.n).padStart(3) : " — "}   ${s ? f3(s.spearman).padStart(7) : "  n/a "}  ${s ? f3(s.pearson).padStart(7) : "  n/a "}`);
    }
  }
}
process.exit(0);
