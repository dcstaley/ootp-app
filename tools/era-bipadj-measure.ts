// era_bip_adj keep/revert measurement (roadmap Batch 2.6). era_bip_adj scales the fixed BIP_ADJ
// constant per era (dead-ball 1920 → ~2.4) so the BIP recompute subtracts the right non-BIP-out
// level. The audit: it was justified under STALE unit-elasticity comments, delivers ~half its
// counted correction against the fitted log-BIP curve, and pushes the pitcher hit chain −0.3..−1.9%
// — with NO post-ship measurement. This measures the hit + pitcher-hit level bias on ghost-CLEANED
// Early Gold (era-1920) with era_bip_adj ON (resolved ≈2.4) vs OFF (=1). KEEP only if ON reduces the
// hitter non-HR-hit residual without worsening the pitcher chain; else revert the default to 1.
//
//   run: node tools/era-bipadj-measure.ts
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
import { readFileSync } from "node:fs";
import type { Coeffs } from "../src/config/types.ts";

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

// One source of truth: the RAW dir, ghost-cleaned in-memory by the clean DI below.
const TDIR = "Tournament Data/Early Gold";
const t = (await repo.loadAll<Tournament>("tournaments")).find((x) => x.id === "early-gold")!;
const coeffsOn = resolveCoeffs(model, eras.get(t.eraId)!, parks.get(t.parkId)!, t.softcaps);
if (trained.wobaWeights) applyWobaWeights(coeffsOn, trained.wobaWeights);
const coeffsOff: Coeffs = { ...coeffsOn, era_bip_adj: 1 }; // computeDerived reads era_bip_adj ?? 1

console.log(`era_bip_adj measurement — ${TDIR} (era ${t.eraId}, tournament ${t.id})`);
console.log(`  era_bip_adj resolved = ${coeffsOn.era_bip_adj?.toFixed(3)} (ON) vs 1.000 (OFF)`);
console.log(`  eventForm: ${!!eventForm}  active model: ${trained.id}\n`);

// Auto-clean on ingest (ledger) — same path the server uses.
const obs = loadTournamentOutcomes(TDIR, { clean: (rows) => cleanTournamentRows(rows).cleaned });
const exposure = tournamentExposure(obs);

// Build the PRODUCTION frame-v2 transform (active transformMode) for EG from the catalog pool +
// artifact trainingMeans, exactly as scoreTournament does. era_bip_adj doesn't enter the frame
// (rating-space field stats + raw K), so ONE frame serves both on/off.
const rp = makeRawPolyModel(eventForm);
const cat = parseCatalogCsv(readFileSync("data/imports/cdmx.csv", "utf8"));
const isB = (c: any) => String(c["Variant"] ?? "").toUpperCase() !== "Y";
const inV = (c: any) => { const v = Number(c["Card Value"]) || 0; return (t.card_value_min == null || v >= t.card_value_min) && (t.card_value_max == null || v <= t.card_value_max); };
const basePool = cat.cards.filter((c: any) => isB(c) && inV(c) && rowEligible(c as any, t));
const poolField = computeUnifiedFieldStats(basePool, coeffsOn, rp, FIELD_N, true);
const frameShift = buildFrameShift(trained.trainingMeans, poolField);
const kb = poolMeanK(basePool, coeffsOn, rp, frameShift, FIELD_N);
const kSpread = { sHit: kRamp(frameShift.hit.vR.kRat ?? 0), sPit: kRamp(frameShift.pit.vR.stu ?? 0), meanHit: kb.hit, meanPit: kb.pit };

const fmt = (n: number) => (n >= 0 ? "+" : "") + n.toFixed(2);
const run = (frame: "base" | "frame-v2") => {
  const extra = frame === "frame-v2" ? { frameShift, kSpread } : {};
  const on = evaluateTournamentLevels(obs, { coeffs: coeffsOn, eventForm, ...extra }, exposure);
  const off = evaluateTournamentLevels(obs, { coeffs: coeffsOff, eventForm, ...extra }, exposure);
  console.log(`\n######## FRAME: ${frame}${frame === "frame-v2" ? " (production / active transformMode)" : " (no transform — opponent-frame bias uncorrected)"} ########`);
  for (const role of ["hit", "pit"] as const) {
    console.log(`  ${role.toUpperCase()}   event    ON:pred  actual  ON:bias   OFF:pred OFF:bias   Δ|bias|(ON−OFF)`);
    for (let i = 0; i < on[role].length; i++) {
      const o = on[role][i]!, f = off[role][i]!;
      const d = Math.abs(o.bias) - Math.abs(f.bias); // negative ⇒ ON reduces |bias|
      console.log(`        ${o.event.padEnd(6)}  ${o.pred.toFixed(1).padStart(7)} ${o.actual.toFixed(1).padStart(7)} ${fmt(o.bias).padStart(8)}   ${f.pred.toFixed(1).padStart(7)} ${fmt(f.bias).padStart(8)}   ${fmt(d).padStart(8)}  ${d < -0.05 ? "ON better" : d > 0.05 ? "OFF better" : "~tie"}`);
    }
  }
};
run("frame-v2");
run("base");
console.log(`\nDECISION RULE: KEEP if the HITTER H-HR |bias| shrinks under ON without the PITCHER H-HR |bias| growing materially (read the frame-v2 block — the production frame).`);
process.exit(0);
