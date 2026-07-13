// PHASE-1 ACCEPTANCE (plan §11.19): does matchup + fitted s(gap) BEAT own-gap on the roster metrics
// (Spearman AND value-regret), per role, on the quicks ladder AND own-gap's home turf (EG/Bronze-t)?
// Plus the level RECONCILIATION (per dataset×role×channel: raw vs post-correction bias) — the artifact
// that proves levels decompose as gap-term + format-constant. Level knobs are OMITTED here: a uniform
// per-tournament×role shift is ranking-inert, so the scorecard gate is purely the s(gap) spread fix;
// the "knob" = the residual level bias shown in the reconciliation (read its gap-pattern).
//   run: node tools/phase1-accept.ts
import { readFileSync, existsSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import { applyWobaWeights, makeRawPolyModel, computeUnifiedFieldStats, buildPoolTransform, buildFrameShift, poolMeanK } from "../src/scoring-core/index.ts";
import { loadTournamentOutcomes, tournamentExposure, tournamentScorecard, evaluateTournamentLevels } from "../src/training/tournament-eval.ts";
import { cleanTournamentRows } from "../src/eval/tournament-clean.ts";
import { parseCatalogCsv } from "../src/data/catalog.ts";
import { rowEligible } from "../src/config/eligibility.ts";

// Fitted ramps (tools/fit-sgap.ts, §11.20).
const sHitFn = (g: number) => 1 + 0.76 * (1 - Math.exp(-g / 17.5));
const sPitFn = (g: number) => 1 + 1.03 * (1 - Math.exp(-g / 14.5));
const FIELD_N = 50, TH = 100;

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
const f3 = (n: number | undefined) => (n == null ? " n/a" : (n >= 0 ? " " : "") + n.toFixed(3));
const f1 = (n: number) => (n >= 0 ? "+" : "") + n.toFixed(1);

console.log(`Phase-1 acceptance — model ${trained.id}. sgap(matchup) vs own-gap; ≥${TH} PA/BF, ghost-cleaned.\n`);
console.log(`SCORECARD GATE (own vs sgap; sgap must WIN both Spearman ↑ and value-regret ↓, per role):`);

for (const [name, dir, TID] of [
  ["Open", "Tournament Data/Quicks - Open", "default-neutral"],
  ["Bronze-q", "Tournament Data/Quicks - Bronze", "bronze-quick"],
  ["Gold-q", "Tournament Data/Quicks - Gold", "gold-quick"],
  ["EG-clean", "Tournament Data/Early Gold", "early-gold"],
  ["Bronze-t", "Tournament Data/Return of the Bronze", "bronze-return"],
] as const) {
  if (!existsSync(dir)) continue;
  const t = (await repo.loadAll<Tournament>("tournaments")).find((x) => x.id === TID)!;
  const coeffs = resolveCoeffs(model, eras.get(t.eraId)!, parks.get(t.parkId)!, t.softcaps);
  if (trained.wobaWeights) applyWobaWeights(coeffs, trained.wobaWeights);
  const inV = (c: any) => { const v = Number(c["Card Value"]) || 0; return (t.card_value_min == null || v >= t.card_value_min) && (t.card_value_max == null || v <= t.card_value_max); };
  const basePool = cat.cards.filter((c: any) => isB(c) && inV(c) && rowEligible(c as any, t));
  const refField = computeUnifiedFieldStats(cat.cards.filter(isB), coeffs, rp, FIELD_N, true);
  const poolField = computeUnifiedFieldStats(basePool, coeffs, rp, FIELD_N, true);
  const fs = buildFrameShift(trained.trainingMeans, poolField);
  const kb = poolMeanK(basePool, coeffs, rp, fs, FIELD_N);
  const gapHit = fs.hit.vR.kRat ?? 0, gapPit = fs.pit.vR.stu ?? 0;
  const kSpread = { sHit: sHitFn(gapHit), sPit: sPitFn(gapPit), meanHit: kb.hit, meanPit: kb.pit };
  const own = { poolTransform: buildPoolTransform(refField, poolField, trained.ratingEnvelope ?? undefined) };
  const sgap = { frameShift: fs, kSpread };

  const obs = loadTournamentOutcomes(dir, { clean: (rows) => cleanTournamentRows(rows).cleaned });
  const exposure = tournamentExposure(obs);
  const scOwn = tournamentScorecard(obs, { coeffs, eventForm, ...own }, exposure, { minPA: TH, minBF: TH, topN: 20 });
  const scSg = tournamentScorecard(obs, { coeffs, eventForm, ...sgap }, exposure, { minPA: TH, minBF: TH, topN: 20 });
  console.log(`\n  ${name} (${t.eraId}, gaps hit ${gapHit.toFixed(0)}/pit ${gapPit.toFixed(0)}, s ${kSpread.sHit.toFixed(2)}/${kSpread.sPit.toFixed(2)})`);
  for (const role of ["hit", "pit"] as const) {
    const o = scOwn[role], s = scSg[role];
    if (!o || !s) { console.log(`    ${role.toUpperCase()}: <${TH} PA/BF`); continue; }
    const winSp = s.spearman > o.spearman, winVr = s.valueRegret < o.valueRegret;
    console.log(`    ${role.toUpperCase()} (N=${o.n})  Spearman own${f3(o.spearman)} → sgap${f3(s.spearman)} ${winSp ? "WIN" : "lose"}   value-regret own${f3(o.valueRegret)} → sgap${f3(s.valueRegret)} ${winVr ? "WIN" : "lose"}`);
  }
  // Level reconciliation: base (no transform) vs sgap, per channel.
  const lvBase = evaluateTournamentLevels(obs, { coeffs, eventForm }, exposure);
  const lvSg = evaluateTournamentLevels(obs, { coeffs, eventForm, ...sgap }, exposure);
  const recon = (role: "hit" | "pit") => lvBase[role].map((r, i) => `${r.event} ${f1(r.bias)}→${f1(lvSg[role][i]!.bias)}`).join("  ");
  console.log(`    reconcile HIT (raw→sgap):  ${recon("hit")}`);
  console.log(`    reconcile PIT (raw→sgap):  ${recon("pit")}`);
}
console.log(`\nGATE: sgap must WIN Spearman AND value-regret per role on the quicks ladder AND EG/Bronze-t.`);
console.log(`RECONCILE: post-sgap the residual level per channel = the per-tournament×role KNOB; if uBB is ~constant across gaps incl. Open, that constant is the format effect.`);
process.exit(0);
