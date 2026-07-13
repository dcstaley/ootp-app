// GATING CHECK for Fable's Phase-1 Change 1: is the matchup coordinate x (the frame-SHIFTED K-rating)
// of each weak pool INSIDE league x-support? If yes, a tail(x)≡0-in-support can't fire there, yet the
// pools demand s≈1.7–2.1 at those same x ⇒ x is not a sufficient statistic ⇒ use s(gap), not tail(x).
// Per role: league own kRat/stu range (≈in-frame reference) vs each pool's SHIFTED range (own + Δ_frame).
//   run: node tools/matchup-xoverlap.ts
import { readFileSync, existsSync } from "node:fs";
import Papa from "papaparse";
import { readdirSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import { applyWobaWeights, makeRawPolyModel, computeUnifiedFieldStats, buildFrameShift } from "../src/scoring-core/index.ts";
import { parseCatalogCsv } from "../src/data/catalog.ts";
import { rowEligible } from "../src/config/eligibility.ts";
import { loadTournamentOutcomes } from "../src/training/tournament-eval.ts";
import { cleanTournamentRows } from "../src/eval/tournament-clean.ts";
import { loadWindow, type TrainObs } from "../src/training/loader.ts";
import { HITTER, PITCHER } from "../src/training/bakeoff.ts";

const FIELD_N = 50;
const num = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state: any = (await repo.load<any>("state", "app")) ?? {};
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const trained = (await repo.loadAll<any>("trained-models")).find((x) => x.id === state.activeModelId);
const rp = makeRawPolyModel(trained.eventForm);
const cat = parseCatalogCsv(readFileSync("data/imports/cdmx.csv", "utf8"));
const isB = (c: any) => String(c["Variant"] ?? "").toUpperCase() !== "Y";

// League (training) own-rating support — the reference frame is where these are calibrated.
const TRAIN = ["League Files", "Model 2037 and 2038"].find((d) => existsSync(d))!;
const win: number[] = Array.isArray(trained.window) && trained.window.length ? trained.window : [];
const tobs = loadWindow(TRAIN, win.length ? win : undefined).observations.filter((o: TrainObs) => (trained.includeVariants ?? true) || !o.variant);
const minPA = Math.max(0, Number(trained.minPA ?? 1000) || 1000);
const lgKRat = tobs.filter((o) => HITTER.qualifies(o, minPA)).map((o) => o.ratings.hit.kRat);
const lgStu = tobs.filter((o) => PITCHER.qualifies(o, minPA)).map((o) => o.ratings.pitch.stu);
const rng = (xs: number[]) => `[${Math.min(...xs).toFixed(0)}, ${Math.max(...xs).toFixed(0)}]`;
const q = (xs: number[], p: number) => { const s = [...xs].filter((x) => Number.isFinite(x)).sort((a, b) => a - b); return s.length ? s[Math.max(0, Math.floor(p * (s.length - 1)))]! : NaN; };
const iqr = (xs: number[]) => (xs.length ? `[${q(xs, 0.1).toFixed(0)}, ${q(xs, 0.9).toFixed(0)}]` : "(none)");

console.log(`LEAGUE own-rating support (≈in-frame, model ${trained.id}):`);
console.log(`  HIT kRat  full ${rng(lgKRat)}  p10–p90 ${iqr(lgKRat)}   (N=${lgKRat.length})`);
console.log(`  PIT stu   full ${rng(lgStu)}  p10–p90 ${iqr(lgStu)}   (N=${lgStu.length})`);
console.log(`\nPool SHIFTED K-rating range (own + Δ_frame) — should land INSIDE league support if the frame re-bases correctly.`);
console.log(`If a pool's shifted range ⊂ league range but it needs s≫1 (§11.17/18), x is NOT sufficient → s(gap), not tail(x).\n`);

// Own-rating ranges of the cards that PLAYED — aggregated across runnings (ghost-cleaned), ≥100 PA/BF,
// so thin per-running lines accumulate exactly as loadTournamentOutcomes / the scorecard see them.
function poolRatings(dir: string): { kRat: number[]; stu: number[] } {
  const obs = loadTournamentOutcomes(dir, { clean: (rows) => cleanTournamentRows(rows).cleaned });
  return {
    kRat: obs.filter((o) => o.pa >= 100).map((o) => o.ratings.hit.vR.kRat),
    stu: obs.filter((o) => o.bf >= 100).map((o) => o.ratings.pit.vR.stu),
  };
}

for (const [name, dir, TID, sHit, sPit] of [
  ["Open-q", "Tournament Data/Quicks - Open", "default-neutral", 0.99, 1.28],
  ["Gold-q", "Tournament Data/Quicks - Gold", "gold-quick", 1.72, 2.06],
  ["Bronze-q", "Tournament Data/Quicks - Bronze", "bronze-quick", 1.71, 1.64],
  ["EG", "Tournament Data/Early Gold", "early-gold", 1.88, NaN],
  ["Bronze-t", "Tournament Data/Return of the Bronze", "bronze-return", 1.76, 1.86],
] as const) {
  if (!existsSync(dir)) continue;
  const t = (await repo.loadAll<Tournament>("tournaments")).find((x) => x.id === TID)!;
  const coeffs = resolveCoeffs(model, eras.get(t.eraId)!, parks.get(t.parkId)!, t.softcaps);
  if (trained.wobaWeights) applyWobaWeights(coeffs, trained.wobaWeights);
  const inV = (c: any) => { const v = Number(c["Card Value"]) || 0; return (t.card_value_min == null || v >= t.card_value_min) && (t.card_value_max == null || v <= t.card_value_max); };
  const basePool = cat.cards.filter((c: any) => isB(c) && inV(c) && rowEligible(c as any, t));
  const poolField = computeUnifiedFieldStats(basePool, coeffs, rp, FIELD_N, true);
  const fs = buildFrameShift(trained.trainingMeans, poolField);
  const dHit = fs.hit.vR.kRat ?? 0, dPit = fs.pit.vR.stu ?? 0;
  const pr = poolRatings(dir);
  const shifted = (xs: number[], d: number) => xs.map((x) => x + d);
  console.log(`${name} (${t.eraId}, val≤${t.card_value_max ?? "∞"}):`);
  console.log(`  HIT kRat: own ${iqr(pr.kRat)}  Δ${dHit >= 0 ? "+" : ""}${dHit.toFixed(0)} → shifted ${iqr(shifted(pr.kRat, dHit))}   [league ${iqr(lgKRat)}]   s*hit≈${sHit}`);
  console.log(`  PIT stu:  own ${iqr(pr.stu)}  Δ${dPit >= 0 ? "+" : ""}${dPit.toFixed(0)} → shifted ${iqr(shifted(pr.stu, dPit))}   [league ${iqr(lgStu)}]   s*pit≈${Number.isNaN(sPit) ? "n/a" : sPit}`);
}
process.exit(0);
