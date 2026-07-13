// Predictive SCORECARD per tournament — how well the active model PREDICTS + RANKS each card
// (discrimination), not just its average calibration (level bias). Per tournament × role × mode:
// Pearson r, Spearman ρ (the roster metric), RMSE, spread ratio (SD_pred/SD_actual — exposes the K
// under-separation), value-regret + top-N overlap (roster-honest), and level bias. On ghost-cleaned
// data (in-memory), predicted vs realized RAW wOBA (same event weights → directly comparable).
//
// Modes are assembled GENERICALLY (add/remove a mode = edit the `modes` list) so this survives the
// planned own-gap/frame-v2 → matchup sunset (plan §11.15).
//
//   run: node tools/tournament-scorecard.ts
import { readFileSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import { applyWobaWeights, makeRawPolyModel, computeUnifiedFieldStats, buildPoolTransform, buildFrameShift, poolMeanK } from "../src/scoring-core/index.ts";
import { loadTournamentOutcomes, tournamentExposure, tournamentScorecard, type TournamentEvalConfig, type RoleScore } from "../src/training/tournament-eval.ts";
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

const f3 = (n: number) => (n >= 0 ? " " : "") + n.toFixed(3);
console.log(`Predictive scorecard — active model ${trained.id}, transformMode(state)=${state.transformMode}\n`);

for (const [name, TDIR, TID] of [["Early Gold", "Tournament Data/Early Gold", "early-gold"], ["Return of the Bronze", "Tournament Data/Return of the Bronze", "bronze-return"]] as const) {
  const t = (await repo.loadAll<Tournament>("tournaments")).find((x) => x.id === TID)!;
  const coeffs = resolveCoeffs(model, eras.get(t.eraId)!, parks.get(t.parkId)!, t.softcaps);
  if (trained.wobaWeights) applyWobaWeights(coeffs, trained.wobaWeights);
  const inV = (c: any) => { const v = Number(c["Card Value"]) || 0; return (t.card_value_min == null || v >= t.card_value_min) && (t.card_value_max == null || v <= t.card_value_max); };
  const basePool = cat.cards.filter((c: any) => isB(c) && inV(c) && rowEligible(c as any, t));
  const refField = computeUnifiedFieldStats(cat.cards.filter(isB), coeffs, rp, FIELD_N, true);
  const poolField = computeUnifiedFieldStats(basePool, coeffs, rp, FIELD_N, true);
  const frameShift = buildFrameShift(trained.trainingMeans, poolField);
  const kb = poolMeanK(basePool, coeffs, rp, frameShift, FIELD_N);
  const kSpread = { sHit: kRamp(frameShift.hit.vR.kRat ?? 0), sPit: kRamp(frameShift.pit.vR.stu ?? 0), meanHit: kb.hit, meanPit: kb.pit };

  // GENERIC mode list — the panel/backend will drive this off available modes; here it's explicit.
  const modes: { mode: string; extra: Partial<TournamentEvalConfig> }[] = [
    { mode: "base", extra: {} },
    { mode: "own-gap", extra: { poolTransform: buildPoolTransform(refField, poolField, trained.ratingEnvelope ?? undefined) } },
    { mode: "frame-v2", extra: { frameShift, kSpread } },
  ];

  const obs = loadTournamentOutcomes(TDIR, { clean: (rows) => cleanTournamentRows(rows).cleaned });
  const exposure = tournamentExposure(obs);
  console.log(`======== ${name} (${t.eraId}), ${obs.length} obs ========`);
  for (const role of ["hit", "pit"] as const) {
    const scores = modes.map((m) => ({ mode: m.mode, s: tournamentScorecard(obs, { coeffs, eventForm, ...m.extra }, exposure)[role] }));
    const n = scores.find((x) => x.s)?.s?.n ?? 0, topN = scores.find((x) => x.s)?.s?.topN ?? 0;
    console.log(`\n  ${role === "hit" ? "HITTERS" : "PITCHERS"} (N=${n}, top-${topN})`);
    console.log(`    metric          ${modes.map((m) => m.mode.padStart(9)).join("")}`);
    const row = (label: string, get: (s: RoleScore) => number) =>
      console.log(`    ${label.padEnd(15)} ${scores.map((x) => (x.s ? f3(get(x.s)) : "    n/a ").padStart(9)).join("")}`);
    row("Pearson r", (s) => s.pearson);
    row("Spearman rho", (s) => s.spearman);
    row("RMSE (wOBA)", (s) => s.rmse);
    row("spread ratio", (s) => s.spreadRatio);
    row("value-regret", (s) => s.valueRegret);
    row("topN overlap", (s) => s.topNOverlap);
    row("level bias", (s) => s.levelBias);
  }
  console.log();
}
process.exit(0);
